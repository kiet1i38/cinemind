// Owner-scoped client fallback stores for interaction state.

import { appConfig } from "../config/appConfig";
import { createJsonStore, getBrowserSessionStorage, getBrowserStorage } from "./browserStore";

const interactionConfig = appConfig.interaction;
const ownerStoreBase = createJsonStore(interactionConfig.ownerStorageKey, "anonymous");
const sessionStoreBase = createJsonStore(interactionConfig.sessionStorageKey, null);
const sessionTokenStoreBase = createJsonStore(`${interactionConfig.sessionStorageKey}:token`, null);
// Keep the session proof and its id in one JSON value. A pair written through
// one storage operation can never be observed after only the id has changed.
const sessionPairStoreBase = createJsonStore(`${interactionConfig.sessionStorageKey}:pair`, null);
// These values describe one top-level browser tab. Keeping them in
// sessionStorage gives each tab its own sequence namespace, so allocating a
// sequence never depends on a cross-tab read/modify/write race in localStorage.
const deviceStoreBase = createJsonStore(
  interactionConfig.deviceStorageKey || "cinemind-interaction-device-id",
  null,
  getBrowserSessionStorage,
);
const sequenceStoreBase = createJsonStore(
  interactionConfig.sequenceStorageKey || "cinemind-interaction-event-sequence",
  0,
  getBrowserSessionStorage,
);
const deviceForkParentStore = createJsonStore(
  `${interactionConfig.deviceStorageKey || "cinemind-interaction-device-id"}:fork-parent`,
  null,
  getBrowserSessionStorage,
);
const signalStoreBase = createJsonStore(appConfig.signals.storageKey, {});
const signalEntryPrefix = `${appConfig.signals.storageKey}:entry:`;
const ownerTransferStoreBase = createJsonStore(
  `${interactionConfig.ownerStorageKey}:pending-transfer`,
  null,
);
// Keep a second recovery copy in the current browsing context. This is a
// reload-surviving fallback when localStorage is full, while the auth page is
// still blocking navigation until the transfer can be completed.
const ownerTransferSessionStoreBase = createJsonStore(
  `${interactionConfig.ownerStorageKey}:pending-transfer`,
  null,
  getBrowserSessionStorage,
);
const ownerPromotionStoreBase = createJsonStore(
  `${interactionConfig.ownerStorageKey}:promotion-in-progress`,
  null,
);
const outboxStoreBase = createJsonStore(interactionConfig.outboxStorageKey, () => ({ signals: {}, searches: {} }));
const legacyFavoriteStore = createJsonStore("cinemind-favorites", null);
const legacyWatchlistStore = createJsonStore("cinemind-watchlist", null);
const outboxEntryPrefix = `${interactionConfig.outboxStorageKey}:entry:`;
const outboxMigrationPrefix = `${interactionConfig.outboxStorageKey}:migration:`;
const OUTBOX_TYPES = new Set(["signals", "searches"]);
let lastPendingWritePersisted = true;
// Incremented whenever the interaction owner/session boundary changes. Any
// async operation that captured an older generation must stop before it can
// read or write the current owner's namespace.
let interactionRevision = 0;
const memoryOutboxEntries = new Map();
const memoryOutboxTombstones = new Set();
const memorySignalEntries = new Set();
const reportedPendingLosses = new Set();
let pendingInteractionLossCount = 0;
let deviceStorageContext = null;
const UNREADABLE_OPENER_STREAM = "__unreadable_opener_stream__";
const DEVICE_STREAM_LEASE_MS = 15000;
const DEVICE_STREAM_HEARTBEAT_MS = 5000;
const OWNER_PROMOTION_TTL_MS = 120000;
const deviceStreamClaimId = createMutationId();
let activeDeviceStreamClaimKey = null;
let deviceStreamHeartbeat = null;
let deviceStreamLifecycleBound = false;

// Remove obsolete preference data as soon as the new bundle loads.
legacyFavoriteStore.remove();
legacyWatchlistStore.remove();

export function getInteractionOwner() {
  const owner = ownerStoreBase.read();
  return typeof owner === "string" && owner.trim() ? owner : "anonymous";
}

export function getInteractionRevision() {
  return interactionRevision;
}

function ownerScopedValue(store, owner, fallback) {
  const raw = store.read();
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners) {
    return Object.prototype.hasOwnProperty.call(raw.owners, owner) ? raw.owners[owner] : fallback;
  }
  return raw === null || raw === undefined ? fallback : raw;
}

function writeScopedValueForOwner(store, owner, value) {
  const raw = store.read();
  const owners = raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners ? { ...raw.owners } : {};
  owners[owner] = value;
  return store.write({ version: 2, owners });
}

function removeScopedValueForOwner(store, owner) {
  const raw = store.read();
  if (!(raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners)) {
    store.remove();
    return;
  }
  const owners = { ...raw.owners };
  delete owners[owner];
  if (Object.keys(owners).length) store.write({ version: 2, owners });
  else store.remove();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value || "").trim());
}

function readOpenerDeviceId() {
  try {
    if (typeof window === "undefined" || !window.opener || window.opener === window) return null;
    const openerStorage = window.opener.sessionStorage;
    if (!openerStorage || typeof openerStorage.getItem !== "function") return null;
    const raw = openerStorage.getItem(interactionConfig.deviceStorageKey || "cinemind-interaction-device-id");
    const value = raw === null ? null : JSON.parse(raw);
    return isUuid(value) ? String(value).toLowerCase() : null;
  } catch {
    // Cross-origin or closed opener access is intentionally fail-closed. The
    // durable marker below still prevents a reload from rotating repeatedly.
    return null;
  }
}

function deviceStreamClaimKey(deviceId) {
  return `${interactionConfig.deviceStorageKey || "cinemind-interaction-device-id"}:active:${encodeURIComponent(String(deviceId))}`;
}

function readStorageJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function isReloadNavigation() {
  try {
    const entries = typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
      ? performance.getEntriesByType("navigation")
      : [];
    return entries[0]?.type === "reload";
  } catch {
    return false;
  }
}

function releaseDeviceStreamClaim(key = activeDeviceStreamClaimKey) {
  if (!key) return;
  const storage = usableBrowserStorage();
  if (storage) {
    try {
      const current = readStorageJson(storage, key);
      if (current?.claimId === deviceStreamClaimId) storage.removeItem(key);
    } catch {
      // A failed release expires naturally after the lease timeout.
    }
  }
  if (key === activeDeviceStreamClaimKey) activeDeviceStreamClaimKey = null;
}

function bindDeviceStreamLifecycle() {
  if (deviceStreamLifecycleBound
    || typeof window === "undefined"
    || typeof window.addEventListener !== "function") return;
  deviceStreamLifecycleBound = true;
  window.addEventListener("pagehide", (event) => {
    // A bfcache page is still a live browsing context and must retain its
    // lease until it is restored or genuinely discarded.
    if (!event?.persisted) releaseDeviceStreamClaim();
  });
  window.addEventListener("pageshow", (event) => {
    if (event?.persisted && activeDeviceStreamClaimKey) claimDeviceStream(getInteractionDeviceId());
  });
}

function startDeviceStreamHeartbeat() {
  if (deviceStreamHeartbeat
    || typeof document === "undefined"
    || typeof window === "undefined"
    || typeof window.setInterval !== "function") return;
  deviceStreamHeartbeat = window.setInterval(() => {
    const key = activeDeviceStreamClaimKey;
    const storage = usableBrowserStorage();
    if (!key || !storage) return;
    try {
      const current = readStorageJson(storage, key);
      if (current?.claimId !== deviceStreamClaimId) return;
      storage.setItem(key, JSON.stringify({ claimId: deviceStreamClaimId, touchedAt: Date.now() }));
    } catch {
      // The next allocation can retry the lease; sessionStorage remains the
      // source of the stream id and sequence.
    }
  }, DEVICE_STREAM_HEARTBEAT_MS);
}

function claimDeviceStream(deviceId) {
  if (!isUuid(deviceId)) return true;
  const storage = usableBrowserStorage();
  if (!storage) return true;
  const key = deviceStreamClaimKey(deviceId);
  const existing = readStorageJson(storage, key);
  const existingClaimId = String(existing?.claimId || "");
  const touchedAt = Number(existing?.touchedAt);
  const leaseLive = existingClaimId
    && Number.isFinite(touchedAt)
    && Date.now() - touchedAt < DEVICE_STREAM_LEASE_MS;
  if (existingClaimId && existingClaimId !== deviceStreamClaimId && leaseLive && !isReloadNavigation()) {
    return false;
  }

  if (activeDeviceStreamClaimKey && activeDeviceStreamClaimKey !== key) {
    releaseDeviceStreamClaim(activeDeviceStreamClaimKey);
  }
  try {
    storage.setItem(key, JSON.stringify({ claimId: deviceStreamClaimId, touchedAt: Date.now() }));
    const claimed = readStorageJson(storage, key);
    if (claimed?.claimId !== deviceStreamClaimId) return false;
  } catch {
    return true;
  }
  activeDeviceStreamClaimKey = key;
  bindDeviceStreamLifecycle();
  startDeviceStreamHeartbeat();
  return true;
}

function ensureUniqueDeviceStream() {
  const storage = getBrowserSessionStorage();
  if (!storage || storage === deviceStorageContext) return;
  deviceStorageContext = storage;
  let currentDevice = deviceStoreBase.read();
  let forked = false;
  if (isUuid(currentDevice) && !claimDeviceStream(currentDevice)) {
    // The lease conflict path can return before the opener branch below. Keep
    // the original stream id so a reloaded clone can prove which stream it
    // forked from instead of rotating again on every reload.
    const forkParent = String(currentDevice).toLowerCase();
    deviceStoreBase.write(createMutationId());
    sequenceStoreBase.write(0);
    currentDevice = deviceStoreBase.read();
    deviceForkParentStore.write(forkParent);
    forked = true;
  }
  let opener = null;
  try {
    opener = typeof window !== "undefined" ? window.opener : null;
  } catch {
    opener = null;
  }
  if (forked) {
    if (isUuid(currentDevice)) claimDeviceStream(currentDevice);
    return;
  }
  if (!opener) return;
  const openerDevice = readOpenerDeviceId();
  const previousForkParent = deviceForkParentStore.read();
  const alreadyForkedFromOpener = isUuid(currentDevice)
    && (openerDevice
      ? String(previousForkParent || "").toLowerCase() === openerDevice
      : previousForkParent === UNREADABLE_OPENER_STREAM);
  if (forked || alreadyForkedFromOpener) {
    if (isUuid(currentDevice)) claimDeviceStream(currentDevice);
    return;
  }

  // A new browsing context opened with an opener starts with a cloned
  // sessionStorage. Fork the stream before any new mutation is allocated so
  // the clone cannot reuse the opener's device/sequence pair. Persist the
  // opener stream that caused the fork: it survives reload, while a duplicate
  // of this tab sees a different opener stream and forks exactly once again.
  deviceStoreBase.write(createMutationId());
  sequenceStoreBase.write(0);
  deviceForkParentStore.write(openerDevice || UNREADABLE_OPENER_STREAM);
  claimDeviceStream(deviceStoreBase.read());
}

// Run the fork check during document boot as well as before allocation. This
// makes the stream unique before startup hydration can observe the cloned tab.
ensureUniqueDeviceStream();

function isValidSessionToken(value) {
  return typeof value === "string" && value.trim().length >= 20 && value.trim().length <= 256;
}

function isValidSessionPair(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && isUuid(value.sessionId)
    && isValidSessionToken(value.sessionToken)
  );
}

function normalizeOwnerPromotion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceSessionId = String(value.sourceSessionId || "").trim();
  const promotionId = String(value.promotionId || "").trim();
  const startedAt = normalizeTimestamp(value.startedAt, null);
  const expiresAt = normalizeTimestamp(value.expiresAt, null);
  if (!isUuid(sourceSessionId) || !isUuid(promotionId) || !startedAt || !expiresAt) return null;
  const startedAtMs = Date.parse(startedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= now || now - startedAtMs > OWNER_PROMOTION_TTL_MS
    || startedAtMs - now > OWNER_PROMOTION_TTL_MS) return null;
  return {
    version: 1,
    sourceOwner: "anonymous",
    sourceSessionId: sourceSessionId.toLowerCase(),
    promotionId: promotionId.toLowerCase(),
    startedAt,
    expiresAt
  };
}

function readPendingAuthenticatedInteractionPromotion() {
  const raw = ownerPromotionStoreBase.read();
  const normalized = normalizeOwnerPromotion(raw);
  if (!normalized) {
    if (raw !== null && raw !== undefined) ownerPromotionStoreBase.remove();
    return null;
  }
  return normalized;
}

export function beginAuthenticatedInteractionPromotion() {
  const source = ownerSessionData("anonymous");
  const sourcePair = isValidSessionPair(source.pair) ? source.pair : null;
  if (!sourcePair) return null;

  const existing = readPendingAuthenticatedInteractionPromotion();
  if (existing) {
    return existing.sourceSessionId === String(sourcePair.sessionId).toLowerCase()
      ? existing.promotionId
      : false;
  }

  const storage = usableBrowserStorage();
  if (!storage) return false;
  const now = Date.now();
  const value = {
    version: 1,
    sourceOwner: "anonymous",
    sourceSessionId: String(sourcePair.sessionId).toLowerCase(),
    promotionId: createMutationId(),
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OWNER_PROMOTION_TTL_MS).toISOString()
  };
  const persisted = ownerPromotionStoreBase.write(value);
  if (!persisted) {
    // Do not let browserStore's in-memory fallback act as a cross-tab lock.
    // A promotion marker is useful only when another tab can observe it after
    // a reload, so an unwritable localStorage must fail closed.
    ownerPromotionStoreBase.remove();
    return false;
  }
  const confirmed = readPendingAuthenticatedInteractionPromotion();
  return confirmed && confirmed.promotionId === value.promotionId
    && confirmed.sourceSessionId === value.sourceSessionId
    ? confirmed.promotionId
    : false;
}

export function clearPendingAuthenticatedInteractionPromotion(expectedPromotionId = null) {
  const current = readPendingAuthenticatedInteractionPromotion();
  if (!current) return true;
  if (expectedPromotionId && current.promotionId !== String(expectedPromotionId).toLowerCase()) return false;
  return ownerPromotionStoreBase.remove();
}

function normalizeOwnerTransfer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceOwner = String(value.sourceOwner || "").trim();
  const targetOwner = String(value.targetOwner || "").trim();
  const acceptedAnonymousSessionId = String(value.acceptedAnonymousSessionId || "").trim();
  if (sourceOwner !== "anonymous" || !targetOwner || targetOwner === "anonymous" || !isUuid(acceptedAnonymousSessionId)) return null;
  return {
    version: 1,
    sourceOwner,
    targetOwner,
    acceptedAnonymousSessionId: acceptedAnonymousSessionId.toLowerCase(),
    createdAt: normalizeTimestamp(value.createdAt, new Date().toISOString())
  };
}

function readPendingOwnerTransfer() {
  const persistentValue = ownerTransferStoreBase.read();
  const sessionValue = ownerTransferSessionStoreBase.read();
  const persistent = normalizeOwnerTransfer(persistentValue);
  const session = normalizeOwnerTransfer(sessionValue);
  if (!persistent && persistentValue !== null && persistentValue !== undefined) ownerTransferStoreBase.remove();
  if (!session && sessionValue !== null && sessionValue !== undefined) ownerTransferSessionStoreBase.remove();
  if (!persistent) return session;
  if (!session) return persistent;
  const persistentCreatedAt = Date.parse(persistent.createdAt) || 0;
  const sessionCreatedAt = Date.parse(session.createdAt) || 0;
  return sessionCreatedAt > persistentCreatedAt ? session : persistent;
}

function writePendingOwnerTransfer(sourceOwner, targetOwner, acceptedAnonymousSessionId) {
  const persistentStorage = usableBrowserStorage();
  const sessionStorage = usableBrowserSessionStorage();
  const previous = readPendingOwnerTransfer();
  const previousCreatedAt = Date.parse(previous?.createdAt || "") || 0;
  const createdAt = new Date(Math.max(Date.now(), previousCreatedAt + 1)).toISOString();
  const value = {
    version: 1,
    sourceOwner,
    targetOwner,
    acceptedAnonymousSessionId: String(acceptedAnonymousSessionId).toLowerCase(),
    createdAt
  };
  // sessionStorage is a best-effort same-tab backup only. A transfer is
  // considered durable only after localStorage contains the exact journal;
  // otherwise a closed tab can leave an authenticated cookie with no way to
  // recover the anonymous source safely.
  let durable = false;
  const journalKey = `${interactionConfig.ownerStorageKey}:pending-transfer`;
  if (persistentStorage) {
    const persistent = ownerTransferStoreBase.write(value);
    durable = Boolean(
      persistent
      && JSON.stringify(readStorageJson(persistentStorage, journalKey)) === JSON.stringify(value)
    );
  } else {
    ownerTransferStoreBase.write(value);
  }
  if (sessionStorage) ownerTransferSessionStoreBase.write(value);
  return durable;
}

function clearPendingOwnerTransfer() {
  const persistent = ownerTransferStoreBase.remove();
  // sessionStorage is only a same-tab convenience copy. It must not make a
  // transfer appear durable when localStorage removal failed or was never
  // available.
  ownerTransferSessionStoreBase.remove();
  return Boolean(persistent && usableBrowserStorage());
}

function clearLegacySessionValues(owner) {
  removeScopedValueForOwner(sessionStoreBase, owner);
  removeScopedValueForOwner(sessionTokenStoreBase, owner);
}

export function getInteractionDeviceId() {
  ensureUniqueDeviceStream();
  const current = deviceStoreBase.read();
  if (isUuid(current)) {
    if (claimDeviceStream(current)) return String(current).toLowerCase();
    deviceForkParentStore.write(String(current).toLowerCase());
    const forkedDevice = createMutationId();
    deviceStoreBase.write(forkedDevice);
    sequenceStoreBase.write(0);
    claimDeviceStream(forkedDevice);
    return forkedDevice;
  }
  const deviceId = createMutationId();
  deviceStoreBase.write(deviceId);
  claimDeviceStream(deviceId);
  return deviceId;
}

export function nextInteractionEventSequence() {
  ensureUniqueDeviceStream();
  const current = Number(sequenceStoreBase.read());
  const safeCurrent = Number.isSafeInteger(current) && current >= 0 ? current : 0;
  const next = safeCurrent >= Number.MAX_SAFE_INTEGER ? 1 : safeCurrent + 1;
  sequenceStoreBase.write(next);
  return next;
}

function normalizeOutbox(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const signals = source.signals && typeof source.signals === "object" && !Array.isArray(source.signals) ? source.signals : {};
  const searches = source.searches && typeof source.searches === "object" && !Array.isArray(source.searches) ? source.searches : {};
  const now = Date.now();
  const ttlMs = Number.isFinite(interactionConfig.pendingMutationTtlMs) && interactionConfig.pendingMutationTtlMs > 0
    ? interactionConfig.pendingMutationTtlMs
    : 86400000;
  const maxItems = Number.isInteger(interactionConfig.pendingMutationMaxItems) && interactionConfig.pendingMutationMaxItems > 0
    ? interactionConfig.pendingMutationMaxItems
    : 100;
  const retainedSignals = retainNewestEntries(
    Object.entries(signals)
      .map(([key, entry]) => normalizePendingSignal(key, entry, now, ttlMs))
      .filter(Boolean),
    maxItems
  );
  const retainedSearches = retainNewestEntries(
    Object.entries(searches)
      .map(([key, entry]) => normalizePendingSearch(key, entry, now, ttlMs))
      .filter(Boolean),
    maxItems
  );
  return {
    signals: Object.fromEntries(retainedSignals),
    searches: Object.fromEntries(retainedSearches)
  };
}

function normalizePendingSignal(key, entry, now, ttlMs) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  // Migrate the pre-event-log shape, where signals were keyed by show id,
  // exactly once when the normalized outbox is persisted.
  const mutationId = isUuid(entry.mutationId)
    ? String(entry.mutationId).toLowerCase()
    : (isUuid(key) ? String(key).toLowerCase() : createMutationId());
  const showId = String(entry.showId || (isUuid(key) ? "" : key)).trim();
  const rating = Number(entry.rating);
  const watchMinutes = Number(entry.watchMinutes);
  const firstQueuedAt = retainedTimestamp(entry.firstQueuedAt || entry.queuedAt, now, ttlMs);
  if (!mutationId || !showId || showId.length > 32 || !isValidRating(rating) || !Number.isInteger(watchMinutes) || watchMinutes < 0 || watchMinutes > interactionConfig.maxWatchMinutes || !firstQueuedAt) return null;
  const lastAttemptAt = normalizeTimestamp(entry.lastAttemptAt || entry.queuedAt, firstQueuedAt);
  return [mutationId, {
    showId,
    rating,
    watchMinutes,
    firstQueuedAt,
    lastAttemptAt,
    queuedAt: firstQueuedAt,
    mutationId,
    clientDeviceId: isUuid(entry.clientDeviceId) ? String(entry.clientDeviceId).toLowerCase() : null,
    clientEventSequence: Number.isSafeInteger(Number(entry.clientEventSequence)) && Number(entry.clientEventSequence) > 0
      ? Number(entry.clientEventSequence)
      : null
  }];
}

function normalizePendingSearch(key, entry, now, ttlMs) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const mutationId = isUuid(entry.mutationId) ? String(entry.mutationId).toLowerCase() : (isUuid(key) ? String(key).toLowerCase() : null);
  if (!mutationId) return null;
  const firstQueuedAt = retainedTimestamp(entry.firstQueuedAt || entry.queuedAt, now, ttlMs);
  if (!firstQueuedAt) return null;
  const lastAttemptAt = normalizeTimestamp(entry.lastAttemptAt || entry.queuedAt, firstQueuedAt);
  const query = String(entry.query ?? "").trim().slice(0, 200);
  if (!query) return null;
  return [mutationId, {
    query,
    resultCount: Math.max(0, Number(entry.resultCount) || 0),
    filters: entry.filters && typeof entry.filters === "object" && !Array.isArray(entry.filters) ? { ...entry.filters } : {},
    firstQueuedAt,
    lastAttemptAt,
    queuedAt: firstQueuedAt,
    mutationId,
    clientDeviceId: isUuid(entry.clientDeviceId) ? String(entry.clientDeviceId).toLowerCase() : null,
    clientEventSequence: Number.isSafeInteger(Number(entry.clientEventSequence)) && Number(entry.clientEventSequence) > 0
      ? Number(entry.clientEventSequence)
      : null
  }];
}

function comparePendingEntries([leftId, left], [rightId, right]) {
  if (left.clientDeviceId && left.clientDeviceId === right.clientDeviceId
    && left.clientEventSequence && right.clientEventSequence) {
    return left.clientEventSequence - right.clientEventSequence
      || String(leftId).localeCompare(String(rightId));
  }
  const timestampDifference = Date.parse(left.firstQueuedAt || left.queuedAt) - Date.parse(right.firstQueuedAt || right.queuedAt);
  return timestampDifference || String(leftId).localeCompare(String(rightId));
}

function retainNewestEntries(entries, maxItems) {
  // Keep the newest mutations when the bounded queue is full, then restore
  // chronological order so replay remains oldest-first.
  return entries
    .sort((left, right) => comparePendingEntries(right, left))
    .slice(0, maxItems)
    .sort(comparePendingEntries);
}

function normalizeTimestamp(value, fallback) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function retainedTimestamp(value, now, ttlMs) {
  const parsed = Date.parse(value || "");
  if (Number.isFinite(parsed) && now - parsed > ttlMs) return null;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(now).toISOString();
}

function usableBrowserStorage() {
  const storage = getBrowserStorage();
  if (!storage) return null;
  try {
    void storage.length;
    return storage;
  } catch {
    return null;
  }
}

function usableBrowserSessionStorage() {
  const storage = getBrowserSessionStorage();
  if (!storage) return null;
  try {
    void storage.length;
    return storage;
  } catch {
    return null;
  }
}

function encodedOwner(owner) {
  return encodeURIComponent(String(owner || "anonymous"));
}

function signalOwnerPrefix(owner) {
  return `${signalEntryPrefix}${encodedOwner(owner)}:`;
}

function signalEntryKey(owner, showId) {
  return `${signalOwnerPrefix(owner)}${encodeURIComponent(String(showId))}`;
}

function signalEntryKeys(owner) {
  const normalizedOwner = String(owner || "anonymous");
  const prefix = signalOwnerPrefix(normalizedOwner);
  const keys = [];
  for (const key of memorySignalEntries) {
    if (key.startsWith(prefix)) keys.push(key);
  }
  const storage = usableBrowserStorage();
  if (!storage) return keys;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && !keys.includes(key)) keys.push(key);
    }
  } catch {
    // Keep memory-backed entries visible when storage enumeration is blocked.
  }
  return keys;
}

function decodeSignalEntryShowId(owner, key) {
  const suffix = key.slice(signalOwnerPrefix(owner).length);
  if (!suffix) return null;
  try {
    const showId = decodeURIComponent(suffix).trim();
    return showId || null;
  } catch {
    return null;
  }
}

function signalValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function isDeletedSignal(value) {
  return Boolean(signalValue(value)?.deleted === true);
}

function readSignalEntry(owner, showId) {
  return signalValue(createJsonStore(signalEntryKey(owner, showId), null).read());
}

function readSignalSnapshotForOwner(owner) {
  const normalizedOwner = String(owner || "anonymous");
  const legacy = signalValue(ownerScopedValue(signalStoreBase, normalizedOwner, {}));
  const snapshot = {};
  for (const [showId, value] of Object.entries(legacy || {})) {
    const normalizedShowId = String(showId || "").trim();
    const normalizedValue = signalValue(value);
    if (normalizedShowId && normalizedValue && !isDeletedSignal(normalizedValue)) {
      snapshot[normalizedShowId] = normalizedValue;
    }
  }
  for (const key of signalEntryKeys(normalizedOwner)) {
    const showId = decodeSignalEntryShowId(normalizedOwner, key);
    if (!showId) continue;
    const value = signalValue(createJsonStore(key, null).read());
    if (!value) continue;
    if (isDeletedSignal(value)) {
      // A per-title tombstone must also hide an older legacy aggregate value.
      // The tombstone remains durable so a stale tab cannot resurrect it.
      delete snapshot[showId];
      continue;
    }
    const current = signalValue(snapshot[showId]);
    if (!current || compareSignalRecency(value, current) >= 0) snapshot[showId] = value;
  }
  return snapshot;
}

function mergeSignalSnapshots(base, incoming) {
  const merged = signalValue(base) ? { ...base } : {};
  const source = signalValue(incoming) ? incoming : {};
  for (const [showId, value] of Object.entries(source)) {
    const normalizedShowId = String(showId || "").trim();
    const normalizedValue = signalValue(value);
    if (!normalizedShowId || !normalizedValue || isDeletedSignal(normalizedValue)) continue;
    const current = signalValue(merged[normalizedShowId]);
    if (!current || compareSignalRecency(normalizedValue, current) >= 0) {
      merged[normalizedShowId] = normalizedValue;
    }
  }
  return merged;
}

function compareSignalStorageRecency(left, right) {
  const leftValue = signalValue(left) || {};
  const rightValue = signalValue(right) || {};
  const leftTimestamp = signalTimestamp(leftValue, "serverSavedAt") ?? signalTimestamp(leftValue, "savedAt");
  const rightTimestamp = signalTimestamp(rightValue, "serverSavedAt") ?? signalTimestamp(rightValue, "savedAt");
  if (leftTimestamp === null && rightTimestamp !== null) return -1;
  if (leftTimestamp !== null && rightTimestamp === null) return 1;
  return (leftTimestamp ?? 0) - (rightTimestamp ?? 0);
}

function persistSignalEntry(owner, showId, value, storage) {
  const key = signalEntryKey(owner, showId);
  const wrote = createJsonStore(key, null).write(value);
  if (wrote && storage) memorySignalEntries.delete(key);
  else memorySignalEntries.add(key);
  return Boolean(wrote && storage);
}

function deleteSignalSnapshotForOwner(owner, showId, { authoritative = false, deletedAt = null } = {}) {
  const normalizedOwner = String(owner || "anonymous");
  const normalizedShowId = String(showId || "").trim();
  if (!normalizedShowId) return false;
  const savedAt = deletedAt || new Date().toISOString();
  const tombstone = {
    version: 1,
    deleted: true,
    savedAt,
    serverSavedAt: authoritative ? savedAt : null,
    authoritative: Boolean(authoritative)
  };
  return persistSignalEntry(normalizedOwner, normalizedShowId, tombstone, usableBrowserStorage());
}

function writeSignalSnapshotForOwner(owner, value, { force = false } = {}) {
  const normalizedOwner = String(owner || "anonymous");
  const source = signalValue(value) ? value : {};
  const storage = usableBrowserStorage();
  let persisted = Boolean(storage);
  for (const [showId, signal] of Object.entries(source)) {
    const normalizedShowId = String(showId || "").trim();
    const normalizedSignal = signalValue(signal);
    if (!normalizedShowId || !normalizedSignal) continue;
    const key = signalEntryKey(normalizedOwner, normalizedShowId);
    const current = readSignalEntry(normalizedOwner, normalizedShowId);
    if (!force && current && isDeletedSignal(current)) {
      const isAuthoritative = normalizedSignal.authoritative === true;
      if (!isAuthoritative && compareSignalStorageRecency(normalizedSignal, current) <= 0) continue;
    } else if (!force && current && compareSignalRecency(normalizedSignal, current) < 0) {
      continue;
    }
    persisted = persistSignalEntry(normalizedOwner, normalizedShowId, normalizedSignal, storage) && persisted;
  }
  return persisted;
}

function replaceSignalSnapshotForOwner(owner, value) {
  const normalizedOwner = String(owner || "anonymous");
  const source = signalValue(value) ? value : {};
  const incoming = {};
  for (const [showId, signal] of Object.entries(source)) {
    const normalizedShowId = String(showId || "").trim();
    const normalizedSignal = signalValue(signal);
    if (!normalizedShowId || !normalizedSignal || isDeletedSignal(normalizedSignal)) continue;
    incoming[normalizedShowId] = { ...normalizedSignal, authoritative: true };
  }

  const legacy = signalValue(ownerScopedValue(signalStoreBase, normalizedOwner, {})) || {};
  const knownShowIds = new Set(
    Object.keys(legacy).map((showId) => String(showId || "").trim()).filter(Boolean),
  );
  for (const key of signalEntryKeys(normalizedOwner)) {
    const showId = decodeSignalEntryShowId(normalizedOwner, key);
    if (showId) knownShowIds.add(showId);
  }
  const pendingShowIds = new Set(
    Object.values(readOutboxForOwner(normalizedOwner).signals || {})
      .map((entry) => String(entry?.showId || "").trim())
      .filter(Boolean),
  );
  let persisted = Boolean(usableBrowserStorage());
  for (const showId of knownShowIds) {
    if (Object.prototype.hasOwnProperty.call(incoming, showId) || pendingShowIds.has(showId)) continue;
    persisted = deleteSignalSnapshotForOwner(normalizedOwner, showId, { authoritative: true }) && persisted;
  }
  // This function is called after the server response has been merged with
  // any still-pending local entries. For entries with no pending mutation, the
  // server snapshot is authoritative even when a stale local sequence is
  // higher, so bypass the local recency guard here.
  persisted = writeSignalSnapshotForOwner(normalizedOwner, incoming, { force: true }) && persisted;
  // The aggregate key is legacy-only now. Remove it after materializing its
  // authoritative per-title replacement; per-title tombstones cover a failed
  // cleanup and prevent old deleted titles from being read again.
  if (persisted) removeScopedValueForOwner(signalStoreBase, normalizedOwner);
  return persisted;
}

function removeSignalSnapshotForOwner(owner) {
  const normalizedOwner = String(owner || "anonymous");
  const storage = usableBrowserStorage();
  let removed = Boolean(storage);
  for (const key of signalEntryKeys(normalizedOwner)) {
    const didRemove = createJsonStore(key, null).remove();
    if (!didRemove || !storage) removed = false;
    memorySignalEntries.delete(key);
  }
  removeScopedValueForOwner(signalStoreBase, normalizedOwner);
  return removed;
}

function signalTimestamp(value, field) {
  const parsed = Date.parse(value?.[field] || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function compareSignalRecency(left, right) {
  const leftValue = signalValue(left) || {};
  const rightValue = signalValue(right) || {};
  const leftDevice = leftValue.clientDeviceId ? String(leftValue.clientDeviceId).toLowerCase() : "";
  const rightDevice = rightValue.clientDeviceId ? String(rightValue.clientDeviceId).toLowerCase() : "";
  const leftSequence = Number(leftValue.clientEventSequence);
  const rightSequence = Number(rightValue.clientEventSequence);
  if (leftDevice && leftDevice === rightDevice
    && Number.isSafeInteger(leftSequence) && leftSequence > 0
    && Number.isSafeInteger(rightSequence) && rightSequence > 0) {
    return leftSequence - rightSequence
      || compareSignalTimestamps(leftValue, rightValue);
  }

  const leftServer = signalTimestamp(leftValue, "serverSavedAt");
  const rightServer = signalTimestamp(rightValue, "serverSavedAt");
  if (leftServer !== null || rightServer !== null) {
    if (leftServer === null) return -1;
    if (rightServer === null) return 1;
    return leftServer - rightServer || compareSignalTimestamps(leftValue, rightValue);
  }
  return compareSignalTimestamps(leftValue, rightValue);
}

function compareSignalTimestamps(left, right) {
  const leftSaved = signalTimestamp(left, "savedAt");
  const rightSaved = signalTimestamp(right, "savedAt");
  if (leftSaved === null && rightSaved !== null) return -1;
  if (leftSaved !== null && rightSaved === null) return 1;
  return (leftSaved ?? 0) - (rightSaved ?? 0);
}

function outboxOwnerPrefix(owner) {
  return `${outboxEntryPrefix}${encodedOwner(owner)}:`;
}

function outboxEntryKey(owner, type, mutationId) {
  return `${outboxOwnerPrefix(owner)}${type}:${encodeURIComponent(String(mutationId).toLowerCase())}`;
}

function memoryOutboxKey(owner, type, mutationId) {
  return outboxEntryKey(owner, type, mutationId);
}

function notePendingLoss(owner, type, mutationId) {
  const key = memoryOutboxKey(owner, type, mutationId);
  if (reportedPendingLosses.has(key)) return;
  reportedPendingLosses.add(key);
  pendingInteractionLossCount += 1;
}

function outboxMigrationKey(owner) {
  return `${outboxMigrationPrefix}${encodedOwner(owner)}`;
}

function parseStorageJson(storage, key) {
  try {
    const value = storage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
}

function outboxEntryKeys(owner) {
  const storage = usableBrowserStorage();
  const prefix = outboxOwnerPrefix(owner);
  const keys = [];
  for (const key of memoryOutboxEntries.keys()) {
    if (key.startsWith(prefix)) keys.push(key);
  }
  if (!storage) return keys;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && !keys.includes(key)) keys.push(key);
    }
  } catch {
    // `storage.key()` may be blocked even when memory fallback entries are
    // available. Never hide those entries from the current-page sync path.
    return keys;
  }
  return keys;
}

function writeOutboxEntry(owner, type, mutationId, value) {
  const storage = usableBrowserStorage();
  if (!storage) {
    const outbox = normalizeOutbox(ownerScopedValue(outboxStoreBase, owner, {}));
    outbox[type][mutationId] = value;
    lastPendingWritePersisted = writeScopedValueForOwner(outboxStoreBase, owner, outbox);
    return lastPendingWritePersisted;
  }
  const key = memoryOutboxKey(owner, type, mutationId);
  memoryOutboxTombstones.delete(key);
  reportedPendingLosses.delete(key);
  lastPendingWritePersisted = createJsonStore(key, null).write(value);
  if (lastPendingWritePersisted) memoryOutboxEntries.delete(key);
  else memoryOutboxEntries.set(key, value);
  return lastPendingWritePersisted;
}

function removeOutboxEntry(owner, type, mutationId) {
  const storage = usableBrowserStorage();
  if (!storage) {
    const outbox = normalizeOutbox(ownerScopedValue(outboxStoreBase, owner, {}));
    delete outbox[type][mutationId];
    lastPendingWritePersisted = writeScopedValueForOwner(outboxStoreBase, owner, outbox);
    return lastPendingWritePersisted;
  }
  const key = outboxEntryKey(owner, type, mutationId);
  const removed = createJsonStore(key, null).remove();
  memoryOutboxEntries.delete(key);
  if (!removed) memoryOutboxTombstones.add(key);
  else memoryOutboxTombstones.delete(key);
  try {
    lastPendingWritePersisted = storage.getItem(key) === null;
  } catch {
    lastPendingWritePersisted = false;
  }
  return lastPendingWritePersisted;
}

function removeOutboxEntryIfUnchanged(owner, type, mutationId, expectedValue) {
  const storage = usableBrowserStorage();
  if (!storage) return removeOutboxEntry(owner, type, mutationId);
  const key = outboxEntryKey(owner, type, mutationId);
  if (memoryOutboxTombstones.has(key)) return false;
  const memoryValue = memoryOutboxEntries.get(key);
  if (memoryValue !== undefined && JSON.stringify(memoryValue) !== JSON.stringify(expectedValue)) return false;
  const currentValue = memoryValue !== undefined ? memoryValue : parseStorageJson(storage, key);
  if (JSON.stringify(currentValue) !== JSON.stringify(expectedValue)) return false;
  const removed = createJsonStore(key, null).remove();
  memoryOutboxEntries.delete(key);
  if (!removed) memoryOutboxTombstones.add(key);
  try {
    lastPendingWritePersisted = storage.getItem(key) === null;
  } catch {
    lastPendingWritePersisted = false;
  }
  return lastPendingWritePersisted;
}

function writeOutboxEntriesForOwner(owner, value) {
  const normalized = normalizeOutbox(value);
  let persisted = true;
  for (const type of OUTBOX_TYPES) {
    for (const [mutationId, entry] of Object.entries(normalized[type])) {
      persisted = writeOutboxEntry(owner, type, mutationId, entry) && persisted;
    }
  }
  lastPendingWritePersisted = persisted;
  return normalized;
}

function pruneOutboxType(owner, type) {
  const storage = usableBrowserStorage();
  if (!storage) return true;
  const now = Date.now();
  const ttlMs = Number.isFinite(interactionConfig.pendingMutationTtlMs) && interactionConfig.pendingMutationTtlMs > 0
    ? interactionConfig.pendingMutationTtlMs
    : 86400000;
  const maxItems = Number.isInteger(interactionConfig.pendingMutationMaxItems) && interactionConfig.pendingMutationMaxItems > 0
    ? interactionConfig.pendingMutationMaxItems
    : 100;
  const entries = [];
  const snapshots = new Map();
  for (const key of outboxEntryKeys(owner)) {
    const suffix = key.slice(outboxOwnerPrefix(owner).length);
    const separator = suffix.indexOf(":");
    if (separator <= 0 || suffix.slice(0, separator) !== type) continue;
    let mutationId;
    try {
      mutationId = decodeURIComponent(suffix.slice(separator + 1));
    } catch {
      continue;
    }
    const value = memoryOutboxEntries.has(key)
      ? memoryOutboxEntries.get(key)
      : parseStorageJson(storage, key);
    if (memoryOutboxTombstones.has(key)) continue;
    if (value === null) continue;
    snapshots.set(mutationId, value);
    const normalized = type === "signals"
      ? normalizePendingSignal(mutationId, value, now, ttlMs)
      : normalizePendingSearch(mutationId, value, now, ttlMs);
    if (normalized) entries.push(normalized);
  }
  const retained = new Set(retainNewestEntries(entries, maxItems).map(([mutationId]) => mutationId));
  let persisted = true;
  for (const [mutationId, value] of snapshots) {
    if (retained.has(mutationId)) continue;
    notePendingLoss(owner, type, mutationId);
    persisted = removeOutboxEntryIfUnchanged(owner, type, mutationId, value) && persisted;
  }
  return persisted;
}

function clearOutboxForOwner(owner) {
  const storage = usableBrowserStorage();
  if (!storage) {
    const keys = new Set(outboxEntryKeys(owner));
    const prefix = outboxOwnerPrefix(owner);
    for (const key of memoryOutboxTombstones) {
      if (key.startsWith(prefix)) keys.add(key);
    }
    for (const key of keys) {
      createJsonStore(key, null).remove();
      memoryOutboxEntries.delete(key);
      memoryOutboxTombstones.delete(key);
    }
    writeScopedValueForOwner(outboxStoreBase, owner, { signals: {}, searches: {} });
    return;
  }
  for (const key of outboxEntryKeys(owner)) {
    const removed = createJsonStore(key, null).remove();
    memoryOutboxEntries.delete(key);
    if (!removed) memoryOutboxTombstones.add(key);
  }
  // The aggregate key is legacy-only, but clear its owner namespace as well
  // so a later storage fallback cannot resurrect pre-migration data.
  removeScopedValueForOwner(outboxStoreBase, owner);
}

function readOutboxForOwner(owner) {
  const normalizedOwner = String(owner || "anonymous");
  const storage = usableBrowserStorage();
  if (!storage) {
    const source = ownerScopedValue(outboxStoreBase, normalizedOwner, {});
    const normalized = normalizeOutbox(source);
    for (const type of OUTBOX_TYPES) {
      for (const mutationId of Object.keys(source?.[type] || {})) {
        if (!Object.prototype.hasOwnProperty.call(normalized[type], mutationId)) {
          notePendingLoss(normalizedOwner, type, mutationId);
        }
      }
    }
    return normalized;
  }

  const raw = { signals: {}, searches: {} };
  for (const key of outboxEntryKeys(normalizedOwner)) {
    const suffix = key.slice(outboxOwnerPrefix(normalizedOwner).length);
    const separator = suffix.indexOf(":");
    if (separator <= 0) continue;
    const type = suffix.slice(0, separator);
    if (!OUTBOX_TYPES.has(type)) continue;
    let mutationId;
    try {
      mutationId = decodeURIComponent(suffix.slice(separator + 1));
    } catch {
      continue;
    }
    const memoryValue = memoryOutboxEntries.get(key);
    if (memoryValue !== undefined) {
      const value = createJsonStore(key, null).read();
      if (!memoryOutboxTombstones.has(key) && value !== null) raw[type][mutationId] = value;
      // Keep the in-memory copy authoritative until a later queue write or
      // acknowledgement removes it. A persistent stale value may still be
      // readable while quota writes are failing.
      continue;
    }
    if (memoryOutboxTombstones.has(key)) {
      try {
        storage.removeItem(key);
        memoryOutboxTombstones.delete(key);
      } catch {
        // Ignore a stale persistent value for this page lifetime.
      }
      continue;
    }
    const value = parseStorageJson(storage, key);
    if (value !== null) raw[type][mutationId] = value;
  }

  const migrationKey = outboxMigrationKey(normalizedOwner);
  if (parseStorageJson(storage, migrationKey) === null) {
    // Merge any partially migrated per-entry data with the legacy aggregate
    // before marking migration complete. This keeps a quota failure or a
    // second tab from making the remaining legacy entries unreachable.
    const legacy = normalizeOutbox(ownerScopedValue(outboxStoreBase, normalizedOwner, {}));
    const combined = normalizeOutbox({
      signals: { ...legacy.signals, ...raw.signals },
      searches: { ...legacy.searches, ...raw.searches }
    });
    const hasLegacyOrEntries = Object.keys(combined.signals).length > 0 || Object.keys(combined.searches).length > 0;
    writeOutboxEntriesForOwner(normalizedOwner, combined);
    if (lastPendingWritePersisted) {
      for (const type of OUTBOX_TYPES) {
        for (const mutationId of Object.keys(raw[type])) {
          if (!Object.prototype.hasOwnProperty.call(combined[type], mutationId)) {
            notePendingLoss(normalizedOwner, type, mutationId);
            removeOutboxEntry(normalizedOwner, type, mutationId);
          }
        }
      }
      const markerPersisted = createJsonStore(migrationKey, null).write({ version: 1, migratedAt: new Date().toISOString() });
      if (markerPersisted) removeScopedValueForOwner(outboxStoreBase, normalizedOwner);
    }
    if (hasLegacyOrEntries || (!Object.keys(raw.signals).length && !Object.keys(raw.searches).length)) return combined;
  }

  // A normal read must stay side-effect free. Rewriting a stale snapshot here
  // could resurrect an entry that another tab acknowledged between its read
  // and this loop. Queue writes and migration are per-entry operations; a
  // queue write performs bounded cleanup separately.
  // Once the migration marker exists, the aggregate is no longer a source of
  // truth. If cleanup previously failed, discard that stale copy instead of
  // merging it back and resurrecting an entry another tab acknowledged.
  if (Object.keys(ownerScopedValue(outboxStoreBase, normalizedOwner, {})).length) {
    removeScopedValueForOwner(outboxStoreBase, normalizedOwner);
  }
  // Expired or over-limit entries can be discovered during a read (for
  // example after a browser stayed offline for several days). Remove them
  // now and retain a one-shot notice for the UI instead of silently losing
  // the event at the next interaction.
  pruneOutboxType(normalizedOwner, "signals");
  pruneOutboxType(normalizedOwner, "searches");
  return normalizeOutbox(raw);
}

function ownerSessionData(owner) {
  const pair = ownerScopedValue(sessionPairStoreBase, owner, null);
  const session = ownerScopedValue(sessionStoreBase, owner, null);
  const token = ownerScopedValue(sessionTokenStoreBase, owner, null);
  return {
    pair,
    session,
    token,
    sessionId: isValidSessionPair(pair) ? pair.sessionId : session
  };
}

function transferOwnerData(sourceOwner, targetOwner, expectedSourceSessionId = null) {
  const storageAvailable = Boolean(usableBrowserStorage());
  const source = ownerSessionData(sourceOwner);
  const target = ownerSessionData(targetOwner);
  if (expectedSourceSessionId && source.sessionId
    && String(expectedSourceSessionId).toLowerCase() !== String(source.sessionId).toLowerCase()) {
    return false;
  }
  const sourcePairIsValid = isValidSessionPair(source.pair);
  const targetPairIsValid = isValidSessionPair(target.pair);
  let pairPersisted = false;
  if (sourcePairIsValid) {
    pairPersisted = writeScopedValueForOwner(sessionPairStoreBase, targetOwner, source.pair);
  } else if (targetPairIsValid) {
    pairPersisted = writeScopedValueForOwner(sessionPairStoreBase, targetOwner, target.pair);
  } else {
    const mergedSession = isUuid(source.sessionId) ? String(source.sessionId).toLowerCase() : target.session;
    const mergedToken = isValidSessionToken(source.token) ? source.token.trim() : target.token;
    pairPersisted = writeScopedValueForOwner(
      sessionPairStoreBase,
      targetOwner,
      isUuid(mergedSession) && isValidSessionToken(mergedToken)
        ? { sessionId: String(mergedSession).toLowerCase(), sessionToken: mergedToken.trim() }
        : null
    );
  }
  // Remove legacy copies after the atomic pair has been promoted. They
  // remain readable only as a migration fallback for older deployments.
  if (pairPersisted) clearLegacySessionValues(targetOwner);

  const sourceSignals = readSignalSnapshotForOwner(sourceOwner);
  const targetSignals = readSignalSnapshotForOwner(targetOwner);
  const signalsPersisted = writeSignalSnapshotForOwner(
    targetOwner,
    mergeSignalSnapshots(targetSignals, sourceSignals),
  );
  const sourceOutbox = readOutboxForOwner(sourceOwner);
  const targetOutbox = readOutboxForOwner(targetOwner);
  writeOutboxEntriesForOwner(targetOwner, {
    signals: { ...targetOutbox.signals, ...sourceOutbox.signals },
    searches: { ...targetOutbox.searches, ...sourceOutbox.searches }
  });
  const outboxPersisted = lastPendingWritePersisted;
  return Boolean(storageAvailable && pairPersisted && signalsPersisted && outboxPersisted);
}

function clearOwnerData(owner) {
  removeScopedValueForOwner(sessionStoreBase, owner);
  removeScopedValueForOwner(sessionTokenStoreBase, owner);
  removeScopedValueForOwner(sessionPairStoreBase, owner);
  removeSignalSnapshotForOwner(owner);
  clearOutboxForOwner(owner);
}

export function setInteractionOwner(userId, { acceptedAnonymousSessionId = null } = {}) {
  const nextOwner = userId ? String(userId) : "anonymous";
  const previousOwner = getInteractionOwner();
  const anonymous = ownerSessionData("anonymous");
  const anonymousSessionId = anonymous.sessionId;
  let pendingTransfer = readPendingOwnerTransfer();
  const normalizedAcceptedSessionId = isUuid(acceptedAnonymousSessionId)
    ? String(acceptedAnonymousSessionId).toLowerCase()
    : null;
  const acceptedSessionMatchesSource = Boolean(
    normalizedAcceptedSessionId
    && isUuid(anonymousSessionId)
    && normalizedAcceptedSessionId === String(anonymousSessionId).toLowerCase()
  );
  const pendingPromotion = readPendingAuthenticatedInteractionPromotion();
  const promotionProtectsSource = Boolean(
    previousOwner === "anonymous"
    && nextOwner !== "anonymous"
    && pendingPromotion
    && isUuid(anonymousSessionId)
    && pendingPromotion.sourceSessionId === String(anonymousSessionId).toLowerCase()
  );
  if (promotionProtectsSource && !acceptedSessionMatchesSource) {
    // Another tab can observe the new auth cookie before the login tab has
    // received the accepted anonymous session id. Keep the owner boundary on
    // anonymous until the login tab writes the transfer journal and completes
    // the copy; this prevents /me from clearing the shared source namespace.
    return {
      previousOwner,
      nextOwner,
      changed: false,
      persisted: true,
      promotionPending: true,
      pendingOwnerTransfer: Boolean(readPendingOwnerTransfer()),
      revision: interactionRevision
    };
  }

  // A later login can confirm a newly rotated anonymous session. Replace an
  // older journal for the same account before retrying transfer; otherwise a
  // failed S1 journal would keep requiring S1 after the browser is already on
  // S2 and recovery could never make progress.
  const journalNeedsSupersede = Boolean(
    pendingTransfer
    && pendingTransfer.sourceOwner === "anonymous"
    && pendingTransfer.targetOwner === nextOwner
    && acceptedSessionMatchesSource
    && pendingTransfer.acceptedAnonymousSessionId !== normalizedAcceptedSessionId
  );
  if (journalNeedsSupersede) {
    const superseded = writePendingOwnerTransfer(
      "anonymous",
      nextOwner,
      normalizedAcceptedSessionId,
    );
    if (!superseded) {
      return {
        previousOwner,
        nextOwner,
        changed: false,
        persisted: false,
        promotionPending: true,
        pendingOwnerTransfer: true,
        revision: interactionRevision
      };
    }
    pendingTransfer = readPendingOwnerTransfer();
  }

  const transferForNextOwner = Boolean(
    pendingTransfer
    && pendingTransfer.sourceOwner === "anonymous"
    && pendingTransfer.targetOwner === nextOwner
  );

  // /me runs after a reload without the original login response. A durable
  // journal must therefore be replayed even when the owner already matches.
  if (previousOwner === nextOwner) {
    if (!transferForNextOwner && acceptedSessionMatchesSource) {
      const journalPersisted = writePendingOwnerTransfer(
        "anonymous",
        nextOwner,
        normalizedAcceptedSessionId,
      );
      if (!journalPersisted) {
        return {
          previousOwner,
          nextOwner,
          changed: false,
          persisted: false,
          promotionPending: true,
          pendingOwnerTransfer: true,
          revision: interactionRevision
        };
      }
      pendingTransfer = readPendingOwnerTransfer();
    }
    if (!pendingTransfer || pendingTransfer.targetOwner !== nextOwner) {
      return { previousOwner, nextOwner, changed: false, revision: interactionRevision };
    }
    const transferPersisted = transferOwnerData(
      "anonymous",
      nextOwner,
      pendingTransfer.acceptedAnonymousSessionId,
    );
    const journalCleared = transferPersisted && clearPendingOwnerTransfer();
    if (transferPersisted && journalCleared) clearOwnerData("anonymous");
    return {
      previousOwner,
      nextOwner,
      changed: false,
      persisted: true,
      transferPersisted,
      promotionPending: !transferPersisted || !journalCleared,
      pendingOwnerTransfer: !transferPersisted || !journalCleared,
      revision: interactionRevision
    };
  }

  const requestedCanMerge = previousOwner === "anonymous"
    && nextOwner !== "anonymous"
    && acceptedSessionMatchesSource;
  const conflictingTransfer = Boolean(
    pendingTransfer
    && pendingTransfer.sourceOwner === "anonymous"
    && pendingTransfer.targetOwner !== nextOwner
  );
  const shouldTransfer = transferForNextOwner || (requestedCanMerge && !conflictingTransfer);
  if (requestedCanMerge && !transferForNextOwner && !conflictingTransfer) {
    // Journal the recovery intent before changing the owner namespace. If
    // this write cannot be durable, leave the anonymous owner in place so a
    // reload cannot strand the source data without a recovery record.
    const journalPersisted = writePendingOwnerTransfer(
      "anonymous",
      nextOwner,
      acceptedAnonymousSessionId,
    );
    if (!journalPersisted) {
      return {
        previousOwner,
        nextOwner,
        changed: false,
        persisted: false,
        promotionPending: true,
        pendingOwnerTransfer: true,
        revision: interactionRevision
      };
    }
  }

  // Persist the namespace boundary before moving or deleting any data. If
  // storage is full/restricted, browserStore keeps this value in memory and
  // reports the durable-write failure; do not copy or clear source data.
  const ownerPersisted = ownerStoreBase.write(nextOwner);
  if (getInteractionOwner() !== nextOwner) {
    return {
      previousOwner,
      nextOwner,
      changed: false,
      persisted: false,
      pendingOwnerTransfer: shouldTransfer || Boolean(readPendingOwnerTransfer()),
      revision: interactionRevision
    };
  }
  if (!ownerPersisted) {
    return {
      previousOwner,
      nextOwner,
      changed: true,
      persisted: false,
      pendingOwnerTransfer: shouldTransfer || Boolean(readPendingOwnerTransfer()),
      revision: interactionRevision
    };
  }

  let transferPersisted = true;
  if (shouldTransfer) {
    transferPersisted = transferOwnerData(
      "anonymous",
      nextOwner,
      pendingTransfer?.acceptedAnonymousSessionId || acceptedAnonymousSessionId,
    );
    if (transferPersisted) clearPendingOwnerTransfer();
  }

  // Anonymous data is copied only when the server explicitly confirms the
  // exact session id. Otherwise discard it instead of offering it to a
  // different account after a cross-tab logout or a failed attach. A pending
  // journal protects its source namespace until the copy succeeds.
  if (shouldTransfer) {
    if (transferPersisted) clearOwnerData("anonymous");
  } else if (!readPendingOwnerTransfer()) {
    clearOwnerData("anonymous");
  }

  interactionRevision += 1;
  return {
    previousOwner,
    nextOwner,
    changed: true,
    persisted: ownerPersisted,
    transferPersisted,
    pendingOwnerTransfer: Boolean(readPendingOwnerTransfer()),
    revision: interactionRevision
  };
}

export function promoteAuthenticatedInteraction(userId, acceptedAnonymousSessionId) {
  return setInteractionOwner(userId, { acceptedAnonymousSessionId });
}

export { readPendingOwnerTransfer };

export function readOwnerScopedSignalState(ownerId = getInteractionOwner()) {
  const owner = String(ownerId || "anonymous");
  return mergePendingSignalState(readSignalSnapshotForOwner(owner), owner);
}

export function writeOwnerScopedSignalState(value) {
  return writeSignalSnapshotForOwner(getInteractionOwner(), value && typeof value === "object" ? value : {});
}

export function replaceOwnerScopedSignalState(value) {
  return replaceSignalSnapshotForOwner(getInteractionOwner(), value && typeof value === "object" ? value : {});
}

export function deleteOwnerScopedSignal(showId, options = {}) {
  return deleteSignalSnapshotForOwner(getInteractionOwner(), showId, options);
}

export function restoreOwnerScopedSignal(showId, value) {
  const normalizedShowId = String(showId || "").trim();
  const normalizedSignal = signalValue(value);
  if (!normalizedShowId || !normalizedSignal || isDeletedSignal(normalizedSignal)) return false;
  return writeSignalSnapshotForOwner(
    getInteractionOwner(),
    { [normalizedShowId]: normalizedSignal },
    { force: true },
  );
}

export function signalWithServerReceipt(signal, result) {
  const base = signalValue(signal) ? { ...signal } : {};
  const ratingRow = signalValue(result?.rating) || {};
  const ratingValue = Number(ratingRow.rating ?? ratingRow.rating_value ?? base.rating);
  if (Number.isFinite(ratingValue)) base.rating = ratingValue;
  const watchMinutes = Number(base.watchMinutes);
  if (Number.isInteger(watchMinutes) && watchMinutes >= 0) base.watchMinutes = watchMinutes;
  const serverSavedAt = ratingRow.rated_at || result?.rated_at || null;
  if (serverSavedAt) {
    base.savedAt = serverSavedAt;
    base.serverSavedAt = serverSavedAt;
  } else if (!base.savedAt) {
    const fallbackSavedAt = ratingRow.client_occurred_at
      || result?.client_occurred_at
      || base.firstQueuedAt
      || base.queuedAt
      || null;
    if (fallbackSavedAt) base.savedAt = fallbackSavedAt;
  }
  if (isUuid(ratingRow.client_device_id)) base.clientDeviceId = String(ratingRow.client_device_id).toLowerCase();
  if (Number.isSafeInteger(Number(ratingRow.client_event_sequence)) && Number(ratingRow.client_event_sequence) > 0) {
    base.clientEventSequence = Number(ratingRow.client_event_sequence);
  }
  return base;
}

export function cacheSignalReceipt(showId, signal, result, ownerId = getInteractionOwner()) {
  const normalizedShowId = String(showId || "").trim();
  if (!normalizedShowId) return null;
  const receipt = signalWithServerReceipt(signal, result);
  writeSignalSnapshotForOwner(String(ownerId || "anonymous"), { [normalizedShowId]: receipt });
  return receipt;
}

export function removeOwnerScopedSignalState() {
  removeSignalSnapshotForOwner(getInteractionOwner());
}

export const interactionSessionStore = {
  read(ownerId = getInteractionOwner()) {
    const owner = String(ownerId || "anonymous");
    const pair = ownerScopedValue(sessionPairStoreBase, owner, null);
    if (pair !== null && pair !== undefined) {
      if (isValidSessionPair(pair)) return pair.sessionId;
      clearLegacySessionValues(owner);
      writeScopedValueForOwner(sessionPairStoreBase, owner, null);
      return null;
    }

    // Migrate sessions created by older bundles. If either legacy value is
    // incomplete or invalid, clear both instead of sending a bad proof.
    const value = ownerScopedValue(sessionStoreBase, owner, null);
    const token = ownerScopedValue(sessionTokenStoreBase, owner, null);
    if (!isUuid(value) || !isValidSessionToken(token)) {
      if ((value !== null && value !== undefined) || (token !== null && token !== undefined)) {
        clearLegacySessionValues(owner);
      }
      return null;
    }
    const migratedPair = { sessionId: String(value).toLowerCase(), sessionToken: token.trim() };
    const migrated = writeScopedValueForOwner(sessionPairStoreBase, owner, migratedPair);
    if (migrated) clearLegacySessionValues(owner);
    return migratedPair.sessionId;
  },
  readToken(ownerId = getInteractionOwner()) {
    const owner = String(ownerId || "anonymous");
    const pair = ownerScopedValue(sessionPairStoreBase, owner, null);
    if (isValidSessionPair(pair)) return pair.sessionToken;
    const sessionId = interactionSessionStore.read(owner);
    const migratedPair = ownerScopedValue(sessionPairStoreBase, owner, null);
    return sessionId && isValidSessionPair(migratedPair) ? migratedPair.sessionToken : null;
  },
  write(value, token = null, ownerId = getInteractionOwner()) {
    const owner = String(ownerId || "anonymous");
    const pair = isUuid(value) && isValidSessionToken(token)
      ? { sessionId: String(value).toLowerCase(), sessionToken: token.trim() }
      : null;
    const persisted = writeScopedValueForOwner(sessionPairStoreBase, owner, pair);
    if (persisted) clearLegacySessionValues(owner);
  }
};

export function createMutationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const hex = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function readPendingInteractions(ownerId = getInteractionOwner()) {
  return readOutboxForOwner(String(ownerId || "anonymous"));
}

export function readPendingInteractionsForOwner(ownerId) {
  return readOutboxForOwner(String(ownerId || "anonymous"));
}

export function hasPendingInteractions(ownerId = getInteractionOwner()) {
  const pending = readOutboxForOwner(String(ownerId || "anonymous"));
  return Object.keys(pending.signals).length > 0 || Object.keys(pending.searches).length > 0;
}

export function pendingInteractionsPersisted() {
  return lastPendingWritePersisted;
}

export function consumePendingInteractionLossNotice() {
  const count = pendingInteractionLossCount;
  pendingInteractionLossCount = 0;
  return count;
}

export function queuePendingSignal(showId, { rating, watchMinutes }, mutationId = createMutationId(), requestedFirstQueuedAt = null, ownerId = getInteractionOwner()) {
  const normalizedShowId = String(showId || "").trim();
  const normalizedRating = Number(rating);
  const normalizedWatchMinutes = Number(watchMinutes);
  if (!normalizedShowId || normalizedShowId.length > 32 || !isUuid(mutationId) || !isValidRating(normalizedRating) || !Number.isInteger(normalizedWatchMinutes) || normalizedWatchMinutes < 0 || normalizedWatchMinutes > interactionConfig.maxWatchMinutes) {
    throw new Error("Invalid signal payload");
  }
  const normalizedMutationId = String(mutationId).toLowerCase();
  const owner = String(ownerId || "anonymous");
  const existing = readOutboxForOwner(owner).signals[normalizedMutationId];
  const firstQueuedAt = existing?.firstQueuedAt
    || existing?.queuedAt
    || normalizeTimestamp(requestedFirstQueuedAt, new Date().toISOString());
  const clientDeviceId = existing?.clientDeviceId || getInteractionDeviceId();
  const clientEventSequence = existing?.clientEventSequence || nextInteractionEventSequence();
  const writePersisted = writeOutboxEntry(owner, "signals", normalizedMutationId, {
    showId: normalizedShowId,
    rating: normalizedRating,
    watchMinutes: normalizedWatchMinutes,
    firstQueuedAt,
    lastAttemptAt: new Date().toISOString(),
    queuedAt: firstQueuedAt,
    mutationId: normalizedMutationId,
    clientDeviceId,
    clientEventSequence
  });
  lastPendingWritePersisted = writePersisted && pruneOutboxType(owner, "signals");
  return normalizedMutationId;
}

export function acknowledgePendingSignal(showId, mutationId, ownerId = getInteractionOwner()) {
  const normalizedMutationId = String(mutationId || "").toLowerCase();
  const owner = String(ownerId || "anonymous");
  const signal = readOutboxForOwner(owner).signals[normalizedMutationId];
  if (!signal || signal.mutationId !== normalizedMutationId || (showId && signal.showId !== String(showId))) return;
  removeOutboxEntry(owner, "signals", normalizedMutationId);
}

export function queuePendingSearch({ query, resultCount, filters }, mutationId = createMutationId(), requestedFirstQueuedAt = null, ownerId = getInteractionOwner()) {
  const normalizedQuery = String(query ?? "").trim().slice(0, 200);
  if (!normalizedQuery || !isUuid(mutationId)) throw new Error("Invalid search payload");
  const normalizedMutationId = String(mutationId).toLowerCase();
  const owner = String(ownerId || "anonymous");
  const existing = readOutboxForOwner(owner).searches[normalizedMutationId];
  const firstQueuedAt = existing?.firstQueuedAt
    || existing?.queuedAt
    || normalizeTimestamp(requestedFirstQueuedAt, new Date().toISOString());
  const clientDeviceId = existing?.clientDeviceId || getInteractionDeviceId();
  const clientEventSequence = existing?.clientEventSequence || nextInteractionEventSequence();
  const writePersisted = writeOutboxEntry(owner, "searches", normalizedMutationId, {
    query: normalizedQuery,
    resultCount: Math.max(0, Number(resultCount) || 0),
    filters: filters && typeof filters === "object" && !Array.isArray(filters) ? { ...filters } : {},
    firstQueuedAt,
    lastAttemptAt: new Date().toISOString(),
    queuedAt: firstQueuedAt,
    mutationId: normalizedMutationId,
    clientDeviceId,
    clientEventSequence
  });
  lastPendingWritePersisted = writePersisted && pruneOutboxType(owner, "searches");
  return normalizedMutationId;
}

export function acknowledgePendingSearch(mutationId, ownerId = getInteractionOwner()) {
  const key = String(mutationId || "").toLowerCase();
  const owner = String(ownerId || "anonymous");
  const search = readOutboxForOwner(owner).searches[key];
  if (!search || search.mutationId !== key) return;
  removeOutboxEntry(owner, "searches", key);
}

export function mergeInteractionState(remoteState, localState = {}) {
  const pending = readPendingInteractions();
  // The server is authoritative for acknowledged state. Local data is only
  // allowed to override it while the corresponding mutation is still pending.
  void localState;
  const ratings = {};
  for (const item of Array.isArray(remoteState?.ratings) ? remoteState.ratings : []) {
    const remoteRating = Number(item?.rating);
    const remoteWatchMinutes = item?.watch_minutes === null ? 0 : Number(item?.watch_minutes);
    if (!item || typeof item !== "object" || !item.show_id || !isValidRating(remoteRating) || !Number.isInteger(remoteWatchMinutes) || remoteWatchMinutes < 0 || remoteWatchMinutes > interactionConfig.maxWatchMinutes) continue;
    ratings[String(item.show_id)] = {
      rating: remoteRating,
      watchMinutes: remoteWatchMinutes,
      savedAt: item.event_at || item.client_occurred_at || item.rated_at,
      serverSavedAt: item.rated_at,
      clientDeviceId: isUuid(item.client_device_id) ? String(item.client_device_id).toLowerCase() : null,
      clientEventSequence: Number.isSafeInteger(Number(item.client_event_sequence))
        && Number(item.client_event_sequence) > 0
        ? Number(item.client_event_sequence)
        : null
    };
  }
  Object.assign(ratings, pendingSignalRatings(pending));
  return { ratings };
}

function comparePendingRecency(left, right) {
  const leftDevice = left?.clientDeviceId ? String(left.clientDeviceId).toLowerCase() : "";
  const rightDevice = right?.clientDeviceId ? String(right.clientDeviceId).toLowerCase() : "";
  const leftSequence = Number(left?.clientEventSequence);
  const rightSequence = Number(right?.clientEventSequence);
  if (leftDevice && leftDevice === rightDevice
    && Number.isSafeInteger(leftSequence) && leftSequence > 0
    && Number.isSafeInteger(rightSequence) && rightSequence > 0) {
    return leftSequence - rightSequence
      || Date.parse(left?.firstQueuedAt || left?.queuedAt || "") - Date.parse(right?.firstQueuedAt || right?.queuedAt || "")
      || String(left?.mutationId || "").localeCompare(String(right?.mutationId || ""));
  }
  return Date.parse(left?.firstQueuedAt || left?.queuedAt || "") - Date.parse(right?.firstQueuedAt || right?.queuedAt || "")
    || String(left?.mutationId || "").localeCompare(String(right?.mutationId || ""));
}

function isValidRating(value) {
  return Number.isFinite(value) && value >= 0.5 && value <= 10 && Math.abs(value * 2 - Math.round(value * 2)) < Number.EPSILON * 100;
}

function mergePendingSignalState(value, owner) {
  const base = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  return { ...base, ...pendingSignalRatings(readOutboxForOwner(owner)) };
}

function pendingSignalRatings(pending) {
  const latestPendingByShow = new Map();
  for (const signal of Object.values(pending?.signals || {})) {
    if (!signal || !signal.showId || !isValidRating(Number(signal.rating)) || !Number.isInteger(Number(signal.watchMinutes)) || Number(signal.watchMinutes) < 0 || Number(signal.watchMinutes) > interactionConfig.maxWatchMinutes) continue;
    const current = latestPendingByShow.get(signal.showId);
    if (!current || comparePendingRecency(signal, current) > 0) latestPendingByShow.set(signal.showId, signal);
  }
  return Object.fromEntries([...latestPendingByShow.entries()].map(([showId, signal]) => [showId, {
    rating: Number(signal.rating),
    watchMinutes: Number(signal.watchMinutes),
    savedAt: signal.firstQueuedAt || signal.queuedAt,
    clientDeviceId: signal.clientDeviceId || null,
    clientEventSequence: signal.clientEventSequence || null
  }]));
}

export function clearInteractionState({
  preserveSession = false,
  clearPending = true,
  resetOwner = true,
  ownerId = null,
  preservePendingOwnerTransfer = false
} = {}) {
  const owner = ownerId ? String(ownerId) : getInteractionOwner();
  const currentOwner = getInteractionOwner();
  const pendingTransfer = readPendingOwnerTransfer();
  const preserveTransferSource = Boolean(
    preservePendingOwnerTransfer
    && pendingTransfer
    && pendingTransfer.sourceOwner === "anonymous"
  );
  const preserveCurrentNamespace = preserveTransferSource && pendingTransfer.sourceOwner === owner;
  if (!preserveCurrentNamespace) {
    if (!preserveSession) {
      removeScopedValueForOwner(sessionStoreBase, owner);
      removeScopedValueForOwner(sessionTokenStoreBase, owner);
      removeScopedValueForOwner(sessionPairStoreBase, owner);
    }
    removeSignalSnapshotForOwner(owner);
    if (clearPending) clearOutboxForOwner(owner);
  }
  legacyFavoriteStore.remove();
  legacyWatchlistStore.remove();
  if (resetOwner && owner !== "anonymous" && !preserveTransferSource) {
    removeScopedValueForOwner(sessionStoreBase, "anonymous");
    removeScopedValueForOwner(sessionTokenStoreBase, "anonymous");
    removeScopedValueForOwner(sessionPairStoreBase, "anonymous");
    removeSignalSnapshotForOwner("anonymous");
    if (clearPending) clearOutboxForOwner("anonymous");
  }
  if (!preservePendingOwnerTransfer && pendingTransfer
    && (pendingTransfer.sourceOwner === owner || (resetOwner && owner !== "anonymous"))) {
    clearPendingOwnerTransfer();
  }
  if (resetOwner) {
    ownerStoreBase.write("anonymous");
    interactionRevision += 1;
  } else if (owner === currentOwner) {
    interactionRevision += 1;
  }
}
