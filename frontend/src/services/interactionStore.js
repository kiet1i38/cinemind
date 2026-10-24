// Owner-scoped client fallback stores for interaction state.

import { appConfig } from "../config/appConfig";
import { createJsonStore, getBrowserSessionStorage, getBrowserStorage } from "./browserStore";

const interactionConfig = appConfig.interaction;
const ownerStoreBase = createJsonStore(interactionConfig.ownerStorageKey, "anonymous");
const sessionStoreBase = createJsonStore(interactionConfig.sessionStorageKey, null);
const sessionTokenStoreBase = createJsonStore(`${interactionConfig.sessionStorageKey}:token`, null);
// Keep the session proof and its id in one JSON value. New bundles store one
// record per owner so two tabs cannot lose each other's namespace through a
// shared aggregate read-modify-write. The aggregate key remains a read-only
// migration fallback for values written by older bundles.
const sessionPairStoreBase = createJsonStore(`${interactionConfig.sessionStorageKey}:pair`, null);
const sessionPairEntryPrefix = `${interactionConfig.sessionStorageKey}:pair:owner:`;
const SESSION_PAIR_ENTRY_VERSION = 1;
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
const ownerTransferBridgeStoreBase = createJsonStore(
  `${interactionConfig.ownerStorageKey}:recent-transfer`,
  null,
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
const outboxTombstonePrefix = `${interactionConfig.outboxStorageKey}:tombstone:`;
const signalClearMarkerPrefix = `${appConfig.signals.storageKey}:clear:`;
const OUTBOX_TYPES = new Set(["signals", "searches"]);
let lastPendingWritePersisted = true;
// Incremented whenever the interaction owner/session boundary changes. Any
// async operation that captured an older generation must stop before it can
// read or write the current owner's namespace.
let interactionRevision = 0;
const memoryOutboxEntries = new Map();
// When a per-entry write falls back to memory, remember the persistent value
// that was present at the failed write. A later read must not blindly replay
// that memory copy over a durable write made by another tab in the meantime.
const memoryOutboxEntryBaselines = new Map();
const memoryOutboxTombstones = new Set();
const memoryOutboxTombstoneValues = new Map();
const memoryOutboxTombstoneCreatedAt = new Map();
const memorySignalEntries = new Set();
const reportedPendingLosses = new Set();
let pendingInteractionLossCount = 0;
let deviceStorageContext = null;
const UNREADABLE_OPENER_STREAM = "__unreadable_opener_stream__";
const DEVICE_STREAM_LEASE_MS = 15000;
const DEVICE_STREAM_HEARTBEAT_MS = 5000;
const OWNER_PROMOTION_TTL_MS = 120000;
const OWNER_TRANSFER_BRIDGE_TTL_MS = 120000;
const PROMOTION_LOCK_NAME = "cinemind-auth-promotion";
const PROMOTION_LOCK_DB_NAME = "cinemind-coordination";
const PROMOTION_LOCK_STORE_NAME = "locks";
const PROMOTION_LOCK_DB_VERSION = 1;
const PROMOTION_LOCK_TTL_MS = 5000;
const PROMOTION_LOCK_WAIT_MS = 4000;
const PROMOTION_LOCK_RETRY_MS = 25;
const INTERACTION_SESSION_LOCK_NAME = "cinemind-interaction-session";
const deviceStreamClaimId = createMutationId();
// A promotion belongs to one JavaScript browsing context. Reusing a shared
// marker for two tabs lets one tab clear the other tab's recovery state.
const promotionClaimId = createMutationId();
let promotionLockDatabasePromise = null;
let activeDeviceStreamClaimKey = null;
let deviceStreamHeartbeat = null;
let deviceStreamLifecycleBound = false;
// When browser storage is unavailable, a fresh browsing context cannot prove
// that a cloned sessionStorage stream belongs to it. Keep the stream selected
// by this JS context stable after it has been forked/created, so fail-closed
// detection does not rotate the id again on every later call.
let memoryOnlyDeviceStreamId = null;

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

function isBrowserRuntime() {
  return typeof window !== "undefined" && typeof window.navigator !== "undefined";
}

function currentBrowserNavigator() {
  if (typeof window !== "undefined" && window.navigator) return window.navigator;
  if (typeof navigator !== "undefined") return navigator;
  return null;
}

function openPromotionLockDatabase() {
  if (promotionLockDatabasePromise) return promotionLockDatabasePromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  promotionLockDatabasePromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(PROMOTION_LOCK_DB_NAME, PROMOTION_LOCK_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROMOTION_LOCK_STORE_NAME)) {
        database.createObjectStore(PROMOTION_LOCK_STORE_NAME, { keyPath: "name" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return promotionLockDatabasePromise;
}

function tryAcquireCoordinationLock(database, lockName, ownerId) {
  return new Promise((resolve) => {
    let acquired = false;
    let transaction;
    try {
      transaction = database.transaction(PROMOTION_LOCK_STORE_NAME, "readwrite");
      const store = transaction.objectStore(PROMOTION_LOCK_STORE_NAME);
       const read = store.get(lockName);
      read.onsuccess = () => {
        const current = read.result;
        const leaseLive = current
          && current.ownerId !== ownerId
          && Number(current.expiresAt) > Date.now();
        if (leaseLive) {
          transaction.abort();
          return;
        }
        store.put({
           name: lockName,
          ownerId,
          expiresAt: Date.now() + PROMOTION_LOCK_TTL_MS
        });
        acquired = true;
      };
      read.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(acquired);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function releaseCoordinationLock(database, lockName, ownerId) {
  return new Promise((resolve) => {
    let transaction;
    try {
      transaction = database.transaction(PROMOTION_LOCK_STORE_NAME, "readwrite");
      const store = transaction.objectStore(PROMOTION_LOCK_STORE_NAME);
       const read = store.get(lockName);
       read.onsuccess = () => {
         if (read.result?.ownerId === ownerId) store.delete(lockName);
      };
      read.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function acquireIndexedDbCoordinationLock(lockName) {
  const database = await openPromotionLockDatabase();
  if (!database) return null;
  const ownerId = createMutationId();
  const deadline = Date.now() + PROMOTION_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
     if (await tryAcquireCoordinationLock(database, lockName, ownerId)) return { database, ownerId };
    await new Promise((resolve) => setTimeout(resolve, PROMOTION_LOCK_RETRY_MS));
  }
  return null;
}

async function withCoordinationLock(lockName, work) {
  // Node-based service tests do not have independent browsing contexts. Keep
  // their synchronous storage harness usable while real browsers use an
  // inter-context lock before touching shared coordination state.
  if (!isBrowserRuntime()) {
    return { supported: true, value: await work() };
  }

  const browserNavigator = currentBrowserNavigator();
  if (typeof browserNavigator?.locks?.request === "function") {
    return {
      supported: true,
      value: await browserNavigator.locks.request(lockName, () => work())
    };
  }

  const lease = await acquireIndexedDbCoordinationLock(lockName);
  if (!lease) return { supported: false, value: null };
  try {
    return { supported: true, value: await work() };
  } finally {
    await releaseCoordinationLock(lease.database, lockName, lease.ownerId);
  }
}

async function withPromotionLock(work) {
  return withCoordinationLock(PROMOTION_LOCK_NAME, work);
}

export function withInteractionSessionCreationLock(work) {
  return withCoordinationLock(INTERACTION_SESSION_LOCK_NAME, work);
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
      const currentRaw = storage.getItem(key);
      const current = currentRaw === null ? null : JSON.parse(currentRaw);
      if (current?.claimId === deviceStreamClaimId
        && storage.getItem(key) === currentRaw) {
        // Do not let a newer tab claim get removed after this tab's first read.
        // The lease can safely expire when the compare fails or storage is
        // unavailable; losing another tab's live claim cannot be recovered.
        storage.removeItem(key);
      }
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
  const normalizedDeviceId = String(deviceId).toLowerCase();
  const storage = usableBrowserStorage();
  // Without a durable claim store, a duplicated browsing context cannot be
  // distinguished from the current tab unless the navigation is a reload.
  // Reusing the cloned stream would allow both contexts to emit the same
  // device/sequence pair, so fail closed for a fresh navigation.
  if (!storage) {
    if (!isBrowserRuntime()) return true;
    if (memoryOnlyDeviceStreamId === normalizedDeviceId || isReloadNavigation()) {
      memoryOnlyDeviceStreamId = normalizedDeviceId;
      return true;
    }
    return false;
  }
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
    if (claimed?.claimId !== deviceStreamClaimId) {
      // Some storage wrappers silently ignore writes instead of throwing. Treat
      // that exactly like an unavailable claim store so a memory-only stream is
      // stable for this page, while a fresh cloned navigation still fails
      // closed and forks to avoid duplicate device/sequence pairs.
      if (!isBrowserRuntime()) return true;
      if (memoryOnlyDeviceStreamId === normalizedDeviceId || isReloadNavigation()) {
        memoryOnlyDeviceStreamId = normalizedDeviceId;
        return true;
      }
      return false;
    }
  } catch {
    if (!isBrowserRuntime()) return true;
    if (memoryOnlyDeviceStreamId === normalizedDeviceId || isReloadNavigation()) {
      memoryOnlyDeviceStreamId = normalizedDeviceId;
      return true;
    }
    return false;
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
  memoryOnlyDeviceStreamId = null;
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
    if (isUuid(currentDevice)) memoryOnlyDeviceStreamId = String(currentDevice).toLowerCase();
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
  const forkedDevice = deviceStoreBase.read();
  if (isUuid(forkedDevice)) memoryOnlyDeviceStreamId = String(forkedDevice).toLowerCase();
  claimDeviceStream(forkedDevice);
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
  const claimId = isUuid(value.claimId) ? String(value.claimId).toLowerCase() : null;
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
    claimId,
    startedAt,
    expiresAt
  };
}

export function readPendingAuthenticatedInteractionPromotion() {
  const raw = ownerPromotionStoreBase.read();
  const normalized = normalizeOwnerPromotion(raw);
  if (!normalized) {
    if (raw !== null && raw !== undefined) ownerPromotionStoreBase.remove();
    return null;
  }
  return normalized;
}

export async function beginAuthenticatedInteractionPromotion() {
  const source = ownerSessionData("anonymous");
  const sourcePair = isValidSessionPair(source.pair) ? source.pair : null;
  if (!sourcePair) return null;

  const lockResult = await withPromotionLock(async () => {
    const existing = readPendingAuthenticatedInteractionPromotion();
    if (existing) {
      return existing.sourceSessionId === String(sourcePair.sessionId).toLowerCase()
        && existing.claimId === promotionClaimId
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
      claimId: promotionClaimId,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + OWNER_PROMOTION_TTL_MS).toISOString()
    };
    const persisted = ownerPromotionStoreBase.write(value);
    if (!persisted) {
      // Do not let browserStore's in-memory fallback act as a cross-tab lock.
      // A promotion marker is useful only when another tab can observe it
      // after a reload, so an unwritable localStorage must fail closed.
      ownerPromotionStoreBase.remove();
      return false;
    }
    const confirmed = readPendingAuthenticatedInteractionPromotion();
    return confirmed && confirmed.promotionId === value.promotionId
      && confirmed.sourceSessionId === value.sourceSessionId
      ? confirmed.promotionId
      : false;
  });
  return lockResult.supported ? lockResult.value : false;
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

function isSameOwnerTransfer(left, right) {
  return Boolean(
    left
    && right
    && left.sourceOwner === right.sourceOwner
    && left.targetOwner === right.targetOwner
    && left.acceptedAnonymousSessionId === right.acceptedAnonymousSessionId
    && left.createdAt === right.createdAt
  );
}

function normalizeOwnerTransferBridge(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const targetOwner = String(value.targetOwner || "").trim();
  const acceptedAnonymousSessionId = String(value.acceptedAnonymousSessionId || "").trim();
  const completedAt = normalizeTimestamp(value.completedAt, null);
  const expiresAt = normalizeTimestamp(value.expiresAt, null);
  if (!targetOwner || targetOwner === "anonymous"
    || !isUuid(acceptedAnonymousSessionId) || !completedAt || !expiresAt) return null;
  const completedAtMs = Date.parse(completedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= now || now - completedAtMs > OWNER_TRANSFER_BRIDGE_TTL_MS
    || completedAtMs - now > OWNER_TRANSFER_BRIDGE_TTL_MS) return null;
  return {
    version: 1,
    sourceOwner: "anonymous",
    targetOwner,
    acceptedAnonymousSessionId: acceptedAnonymousSessionId.toLowerCase(),
    completedAt,
    expiresAt
  };
}

function readOwnerTransferBridge() {
  const raw = ownerTransferBridgeStoreBase.read();
  const normalized = normalizeOwnerTransferBridge(raw);
  if (!normalized && raw !== null && raw !== undefined) ownerTransferBridgeStoreBase.remove();
  return normalized;
}

function writeOwnerTransferBridge(targetOwner, acceptedAnonymousSessionId) {
  const storage = usableBrowserStorage();
  if (!storage || !isUuid(acceptedAnonymousSessionId)) return false;
  const now = Date.now();
  const value = {
    version: 1,
    sourceOwner: "anonymous",
    targetOwner: String(targetOwner || "").trim(),
    acceptedAnonymousSessionId: String(acceptedAnonymousSessionId).toLowerCase(),
    completedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OWNER_TRANSFER_BRIDGE_TTL_MS).toISOString()
  };
  const persisted = ownerTransferBridgeStoreBase.write(value);
  if (!persisted) return false;
  const confirmed = readOwnerTransferBridge();
  return Boolean(
    confirmed
    && confirmed.targetOwner === value.targetOwner
    && confirmed.acceptedAnonymousSessionId === value.acceptedAnonymousSessionId
  );
}

function clearOwnerTransferBridge() {
  ownerTransferBridgeStoreBase.remove();
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
  const pending = readPendingOwnerTransfer();
  const persistentStorage = usableBrowserStorage();
  const journalKey = `${interactionConfig.ownerStorageKey}:pending-transfer`;
  let persistentJournal = null;
  let persistentJournalReadable = false;
  if (persistentStorage) {
    try {
      const raw = persistentStorage.getItem(journalKey);
      persistentJournalReadable = true;
      persistentJournal = raw === null ? null : normalizeOwnerTransfer(JSON.parse(raw));
    } catch {
      // Treat an unreadable durable journal as non-durable. The recovery copy
      // must survive until this tab can prove the matching journal is gone.
    }
  }

  const journalMatchesPending = Boolean(
    persistentJournalReadable
    && isSameOwnerTransfer(persistentJournal, pending)
  );
  if (!journalMatchesPending) {
    // The pending record may exist only in the same-tab backup because the
    // original localStorage write failed, or a newer tab may own the durable
    // record. Never clear the backup based on removeItem(absent-key).
    if (pending) {
      // When storage is unavailable there is no durable record to protect;
      // clear the browser-store memory-only marker before retaining the
      // recovery value in memory. Otherwise a later storage recovery could
      // mistake this cleanup residue for a live durable journal.
      if (!persistentStorage) ownerTransferStoreBase.remove();
      ownerTransferStoreBase.write(pending);
      ownerTransferSessionStoreBase.write(pending);
    }
    return false;
  }

  const persistentRemoved = ownerTransferStoreBase.remove();
  let journalGone = false;
  try {
    journalGone = persistentStorage.getItem(journalKey) === null;
  } catch {
    journalGone = false;
  }
  const durable = Boolean(persistentRemoved && journalGone);
  // sessionStorage is only a same-tab convenience copy. It must not make a
  // transfer appear durable when localStorage removal failed or was never
  // available. Preserve it until the durable journal removal succeeds; when
  // localStorage is temporarily unavailable, deleting the session copy here
  // would strand the only newer recovery record in this tab.
  if (!durable) {
    // browserStore hides a failed removal behind a page-lifetime tombstone.
    // Restore the journal best-effort so the failed cleanup cannot make the
    // still-present durable value look absent to this tab.
    let currentJournal = null;
    try {
      const raw = persistentStorage?.getItem(journalKey);
      currentJournal = raw === null || raw === undefined
        ? null
        : normalizeOwnerTransfer(JSON.parse(raw));
    } catch {
      currentJournal = null;
    }
    if (pending && (!currentJournal || isSameOwnerTransfer(currentJournal, pending))) {
      ownerTransferStoreBase.write(pending);
    }
    if (pending) ownerTransferSessionStoreBase.write(pending);
    return false;
  }
  ownerTransferSessionStoreBase.remove();
  if (durable && pending && ownerNamespaceHasRecoverableData(pending.sourceOwner)) {
    // A stale tab can finish an anonymous write immediately after the source
    // snapshot was cleaned and the journal was removed. Recreate the durable
    // journal so the next auth/owner boundary retries the transfer instead of
    // treating that late write as anonymous data that may be discarded.
    writePendingOwnerTransfer(
      pending.sourceOwner,
      pending.targetOwner,
      pending.acceptedAnonymousSessionId,
    );
    return false;
  }
  return durable;
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
    memoryOnlyDeviceStreamId = String(forkedDevice).toLowerCase();
    claimDeviceStream(forkedDevice);
    return forkedDevice;
  }
  const deviceId = createMutationId();
  deviceStoreBase.write(deviceId);
  memoryOnlyDeviceStreamId = String(deviceId).toLowerCase();
  claimDeviceStream(deviceId);
  return deviceId;
}

export function nextInteractionEventSequence() {
  ensureUniqueDeviceStream();
  const current = Number(sequenceStoreBase.read());
  const safeCurrent = Number.isSafeInteger(current) && current >= 0 ? current : 0;
  const next = safeCurrent >= Number.MAX_SAFE_INTEGER ? 1 : safeCurrent + 1;
  // A sequence is only useful when it survives a reload of this browsing
  // context. Never send a value that exists only in browserStore memory: a
  // quota/security failure followed by a reload would reuse an older value
  // for the same device stream and let the server select stale event state.
  return sequenceStoreBase.write(next) ? next : null;
}

function pendingEventMetadata(existingEntry = null) {
  // A mutation keeps its original event metadata for its whole retry life.
  // In particular, do not add a newly allocated sequence to an entry that was
  // first queued while sessionStorage was unavailable.
  if (existingEntry) {
    const existingDeviceId = isUuid(existingEntry.clientDeviceId)
      ? String(existingEntry.clientDeviceId).toLowerCase()
      : null;
    const existingSequence = Number.isSafeInteger(Number(existingEntry.clientEventSequence))
      && Number(existingEntry.clientEventSequence) > 0
      ? Number(existingEntry.clientEventSequence)
      : null;
    return existingDeviceId && existingSequence
      ? { clientDeviceId: existingDeviceId, clientEventSequence: existingSequence }
      : { clientDeviceId: null, clientEventSequence: null };
  }

  const clientEventSequence = nextInteractionEventSequence();
  if (!Number.isSafeInteger(clientEventSequence) || clientEventSequence <= 0) {
    return { clientDeviceId: null, clientEventSequence: null };
  }
  const clientDeviceId = getInteractionDeviceId();
  return isUuid(clientDeviceId)
    ? { clientDeviceId: String(clientDeviceId).toLowerCase(), clientEventSequence }
    : { clientDeviceId: null, clientEventSequence: null };
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
  const ratingIsUnset = entry.rating === null
    || entry.rating === undefined
    || (typeof entry.rating === "string" && !entry.rating.trim())
    || Number(entry.rating) === 0;
  const rating = ratingIsUnset ? null : Number(entry.rating);
  const watchMinutes = Number(entry.watchMinutes);
  const firstQueuedAt = retainedTimestamp(entry.firstQueuedAt || entry.queuedAt, now, ttlMs);
  if (!mutationId || !showId || showId.length > 32 || (rating !== null && !isValidRating(rating)) || !Number.isInteger(watchMinutes) || watchMinutes < 0 || watchMinutes > interactionConfig.maxWatchMinutes || !firstQueuedAt) return null;
  const lastAttemptAt = normalizeTimestamp(entry.lastAttemptAt || entry.queuedAt, firstQueuedAt);
  return [mutationId, {
    showId,
    rating,
    watchMinutes,
    firstQueuedAt,
    lastAttemptAt,
    queuedAt: firstQueuedAt,
    mutationId,
    outboxWriteNonce: typeof entry.outboxWriteNonce === "string" ? entry.outboxWriteNonce : null,
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
    outboxWriteNonce: typeof entry.outboxWriteNonce === "string" ? entry.outboxWriteNonce : null,
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

function sessionPairEntryKey(owner) {
  return `${sessionPairEntryPrefix}${encodedOwner(owner)}`;
}

function readSessionPairForOwner(owner) {
  const entry = createJsonStore(sessionPairEntryKey(owner), undefined).read();
  if (entry !== undefined) {
    if (entry && typeof entry === "object" && entry.version === SESSION_PAIR_ENTRY_VERSION) {
      if (entry.deleted === true) return null;
      if (Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
    }
    return entry;
  }

  // Older bundles stored all owners in one aggregate. Read it only when the
  // owner-specific record has not been created yet; never rewrite the
  // aggregate from a current-tab snapshot.
  const legacyPair = ownerScopedValue(sessionPairStoreBase, owner, undefined);
  return legacyPair === undefined ? null : legacyPair;
}

function writeSessionPairForOwner(owner, pair) {
  const record = pair === null || pair === undefined
    ? { version: SESSION_PAIR_ENTRY_VERSION, deleted: true }
    : { version: SESSION_PAIR_ENTRY_VERSION, value: pair };
  return createJsonStore(sessionPairEntryKey(owner), undefined).write(record);
}

function signalOwnerPrefix(owner) {
  return `${signalEntryPrefix}${encodedOwner(owner)}:`;
}

function signalEntryKey(owner, showId) {
  return `${signalOwnerPrefix(owner)}${encodeURIComponent(String(showId))}`;
}

function signalClearMarkerKey(owner, showId) {
  return `${signalClearMarkerPrefix}${encodedOwner(owner)}:${encodeURIComponent(String(showId))}`;
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

function signalValueFingerprint(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function readSignalClearMarker(owner, showId) {
  const marker = signalValue(createJsonStore(signalClearMarkerKey(owner, showId), null).read());
  if (!marker || marker.version !== 1 || typeof marker.expectedFingerprint !== "string") return null;
  return marker;
}

function writeSignalClearMarker(owner, showId, value) {
  const expectedFingerprint = signalValueFingerprint(value);
  if (!expectedFingerprint) return false;
  return createJsonStore(signalClearMarkerKey(owner, showId), null).write({
    version: 1,
    expectedFingerprint,
    clearedAt: new Date().toISOString()
  });
}

function clearSignalClearMarker(owner, showId) {
  return createJsonStore(signalClearMarkerKey(owner, showId), null).remove();
}

function readRawSignalEntry(owner, showId) {
  return signalValue(createJsonStore(signalEntryKey(owner, showId), null).read());
}

function readSignalEntry(owner, showId) {
  const value = readRawSignalEntry(owner, showId);
  if (!value) {
    clearSignalClearMarker(owner, showId);
    return null;
  }
  const marker = readSignalClearMarker(owner, showId);
  if (!marker) return value;
  if (signalValueFingerprint(value) === marker.expectedFingerprint) return null;
  // A newer write replaced the value observed by the clear operation. It is
  // now authoritative for this browser context; remove only the stale marker.
  clearSignalClearMarker(owner, showId);
  return value;
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
    const value = readSignalEntry(normalizedOwner, showId);
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
  if (wrote && storage) {
    memorySignalEntries.delete(key);
    // A new value supersedes any logical clear marker left by logout/reset.
    // This is safe even if another tab created the marker just before this
    // write: the value itself is newer than the marker's expected fingerprint.
    clearSignalClearMarker(owner, showId);
  } else {
    memorySignalEntries.add(key);
  }
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

function shouldPreserveNewerServerSignal(current, incoming, snapshotAt = null) {
  const currentValue = signalValue(current);
  if (!currentValue) return false;
  const currentServerAt = signalTimestamp(currentValue, "serverSavedAt");
  if (currentServerAt === null) return false;

  const incomingServerAt = signalTimestamp(incoming, "serverSavedAt");
  if (incomingServerAt !== null) return currentServerAt > incomingServerAt;

  const snapshotTimestamp = Date.parse(snapshotAt || "");
  return Number.isFinite(snapshotTimestamp) && currentServerAt > snapshotTimestamp;
}

function replaceSignalSnapshotForOwner(owner, value, { snapshotAt = null } = {}) {
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
    const current = readSignalEntry(normalizedOwner, showId);
    if (shouldPreserveNewerServerSignal(current, null, snapshotAt)) continue;
    persisted = deleteSignalSnapshotForOwner(normalizedOwner, showId, { authoritative: true }) && persisted;
  }
  // A state response can be older than a committed write from another tab.
  // Compare server receipts before applying it; client sequence numbers are
  // not a safe cross-tab ordering primitive.
  const safeIncoming = {};
  for (const [showId, signal] of Object.entries(incoming)) {
    const current = readSignalEntry(normalizedOwner, showId);
    if (!shouldPreserveNewerServerSignal(current, signal, snapshotAt)) {
      safeIncoming[showId] = signal;
    }
  }
  persisted = writeSignalSnapshotForOwner(normalizedOwner, safeIncoming, { force: true }) && persisted;
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
    const showId = decodeSignalEntryShowId(normalizedOwner, key);
    if (!showId) continue;
    const current = readRawSignalEntry(normalizedOwner, showId);
    if (!current) continue;
    // Do not physically delete the value after enumerating it. Another tab
    // can write a newer receipt between that read and removeItem(), and an
    // unconditional delete would erase the newer tab's local state. A
    // fingerprinted marker hides exactly the value observed by this clear;
    // a concurrent replacement remains visible and clears the marker on its
    // next read/write.
    const markerPersisted = writeSignalClearMarker(normalizedOwner, showId, current);
    if (!markerPersisted || !storage) removed = false;
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

function outboxTombstoneKey(owner, type, mutationId) {
  return `${outboxTombstonePrefix}${encodedOwner(owner)}:${type}:${encodeURIComponent(String(mutationId).toLowerCase())}`;
}

function memoryOutboxKey(owner, type, mutationId) {
  return outboxEntryKey(owner, type, mutationId);
}

function outboxValueFingerprint(value) {
  try {
    return stableSerialize(value);
  } catch {
    return null;
  }
}

function stableSerialize(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(",")}}`;
}

function readOutboxTombstone(storage, owner, type, mutationId) {
  try {
    const raw = storage.getItem(outboxTombstoneKey(owner, type, mutationId));
    if (raw === null) return null;
    return parseOutboxTombstone(raw);
  } catch {
    return null;
  }
}

function parseOutboxTombstone(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 && typeof parsed.fingerprint === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeOutboxTombstone(storage, owner, type, mutationId, expectedValue) {
  const fingerprint = outboxValueFingerprint(expectedValue);
  if (!fingerprint) return false;
  try {
    storage.setItem(
      outboxTombstoneKey(owner, type, mutationId),
      JSON.stringify({ version: 1, fingerprint, createdAt: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

function removeOutboxEntryStorageIfUnchanged(storage, owner, type, mutationId, expectedValue) {
  const key = outboxEntryKey(owner, type, mutationId);
  const expectedFingerprint = outboxValueFingerprint(expectedValue);
  if (!expectedFingerprint) return false;
  const currentValue = parseStorageJson(storage, key);
  if (currentValue === null) return true;
  if (outboxValueFingerprint(currentValue) !== expectedFingerprint) return false;
  try {
    // localStorage operations are synchronous within this browser task. The
    // post-delete read also makes a failed remove observable to the caller;
    // a newer value is intentionally treated as a successful supersession.
    storage.removeItem(key);
    const remaining = parseStorageJson(storage, key);
    return remaining === null || outboxValueFingerprint(remaining) !== expectedFingerprint;
  } catch {
    return false;
  }
}

function outboxTombstoneEntries(storage, owner, type) {
  const prefix = `${outboxTombstonePrefix}${encodedOwner(owner)}:${type}:`;
  const entries = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      let mutationId;
      try {
        mutationId = decodeURIComponent(key.slice(prefix.length));
      } catch {
        continue;
      }
      const raw = storage.getItem(key);
      const marker = raw === null ? null : parseOutboxTombstone(raw);
      if (!marker) continue;
      entries.push({ key, marker, mutationId, raw });
    }
  } catch {
    return entries;
  }
  return entries;
}

function removeOutboxTombstoneIfUnchanged(storage, entry) {
  if (!entry?.key || typeof entry.raw !== "string") return false;
  try {
    if (storage.getItem(entry.key) !== entry.raw) return false;
    storage.removeItem(entry.key);
    return storage.getItem(entry.key) !== entry.raw;
  } catch {
    return false;
  }
}

function outboxTombstoneMaxItems() {
  return Number.isInteger(interactionConfig.pendingMutationMaxItems)
    && interactionConfig.pendingMutationMaxItems > 0
    ? interactionConfig.pendingMutationMaxItems
    : 100;
}

function pruneOutboxTombstones(owner, type, { clearAll = false } = {}) {
  const memoryPrefix = `${outboxOwnerPrefix(owner)}${type}:`;
  const memoryKeys = [...memoryOutboxTombstones]
    .filter((key) => key.startsWith(memoryPrefix));
  const memoryRetained = new Set(
    (clearAll
      ? []
      : memoryKeys
        .sort((left, right) => (memoryOutboxTombstoneCreatedAt.get(right) || 0)
          - (memoryOutboxTombstoneCreatedAt.get(left) || 0))
        .slice(0, outboxTombstoneMaxItems()))
  );
  for (const key of memoryKeys) {
    if (memoryRetained.has(key)) continue;
    memoryOutboxTombstones.delete(key);
    memoryOutboxTombstoneValues.delete(key);
    memoryOutboxTombstoneCreatedAt.delete(key);
  }

  const storage = usableBrowserStorage();
  if (!storage) return true;
  const candidates = [];
  let persisted = true;

  for (const entry of outboxTombstoneEntries(storage, owner, type)) {
    const currentValue = parseStorageJson(storage, outboxEntryKey(owner, type, entry.mutationId));
    if (currentValue !== null) {
      const currentFingerprint = outboxValueFingerprint(currentValue);
      if (currentFingerprint === entry.marker.fingerprint) {
        // A failed prior compaction left the acknowledged raw value behind.
        // Remove it only while its fingerprint still matches the marker.
        if (!removeOutboxEntryStorageIfUnchanged(storage, owner, type, entry.mutationId, currentValue)) {
          persisted = false;
          continue;
        }
      } else {
        // A newer write superseded this marker. It is safe to remove the old
        // marker because the newer raw value is already visible to readers.
        persisted = removeOutboxTombstoneIfUnchanged(storage, entry) && persisted;
        continue;
      }
    }
    candidates.push(entry);
  }

  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.marker.createdAt || "");
    const rightTime = Date.parse(right.marker.createdAt || "");
    return (Number.isFinite(rightTime) ? rightTime : 0)
      - (Number.isFinite(leftTime) ? leftTime : 0);
  });
  const retained = new Set(
    (clearAll ? [] : candidates.slice(0, outboxTombstoneMaxItems()))
      .map((entry) => entry.key),
  );
  for (const entry of candidates) {
    if (retained.has(entry.key)) continue;
    persisted = removeOutboxTombstoneIfUnchanged(storage, entry) && persisted;
  }
  return persisted;
}

function isOutboxEntrySuppressed(storage, owner, type, mutationId, value) {
  if (value === null || value === undefined) return false;
  const key = outboxEntryKey(owner, type, mutationId);
  const fingerprint = outboxValueFingerprint(value);
  const memoryFingerprint = memoryOutboxTombstoneValues.get(key);
  const persistentTombstone = readOutboxTombstone(storage, owner, type, mutationId);
  const expectedFingerprint = persistentTombstone?.fingerprint || memoryFingerprint;
  if (!expectedFingerprint) return false;
  if (fingerprint === expectedFingerprint || JSON.stringify(value) === expectedFingerprint) return true;
  try {
    // Accept tombstones written by bundles that used insertion-order JSON.
    // New writes use stableSerialize so property-order differences cannot
    // turn an unchanged entry into a false newer write.
    if (stableSerialize(JSON.parse(expectedFingerprint)) === fingerprint) return true;
  } catch {
    // Invalid historical markers remain non-authoritative.
  }

  // A newer writer won the race. Its value must stay visible and the stale
  // suppression marker is harmless because readers compare its fingerprint.
  // Do not physically clear the marker here: a concurrent acknowledgement
  // may have replaced it with a marker for the newer value between the read
  // and this cleanup attempt.
  memoryOutboxTombstones.delete(key);
  memoryOutboxTombstoneValues.delete(key);
  memoryOutboxTombstoneCreatedAt.delete(key);
  return false;
}

function hasOutboxTombstone(storage, owner, type, mutationId) {
  const key = outboxEntryKey(owner, type, mutationId);
  return memoryOutboxTombstones.has(key) || Boolean(readOutboxTombstone(storage, owner, type, mutationId));
}

function filterLegacyOutboxByTombstones(owner, value, storage) {
  const filtered = { signals: {}, searches: {} };
  for (const type of OUTBOX_TYPES) {
    for (const [mutationId, entry] of Object.entries(value?.[type] || {})) {
      // A legacy aggregate has no write nonce, so it cannot prove that it was
      // written after a per-entry acknowledgement. Once a tombstone exists,
      // treat the aggregate copy as stale; a newer bundle can still supersede
      // it through the per-entry path and its fresh nonce.
      if (hasOutboxTombstone(storage, owner, type, mutationId)) continue;
      filtered[type][mutationId] = entry;
    }
  }
  return filtered;
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

function memoryOutboxEntriesForOwner(owner) {
  const prefix = outboxOwnerPrefix(owner);
  const entries = { signals: {}, searches: {} };
  for (const [key, value] of memoryOutboxEntries) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
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
    entries[type][mutationId] = value;
  }
  return entries;
}

function writeOutboxEntry(owner, type, mutationId, value, { preserveWriteNonce = false } = {}) {
  const storage = usableBrowserStorage();
  if (!storage) {
    const outbox = normalizeOutbox(ownerScopedValue(outboxStoreBase, owner, {}));
    outbox[type][mutationId] = value;
    // browserStore keeps the aggregate in memory when localStorage is not
    // available, but that copy disappears on reload. Surface the durability
    // boundary to the caller so the UI can say session-only instead of
    // claiming the interaction was saved locally.
    writeScopedValueForOwner(outboxStoreBase, owner, outbox);
    lastPendingWritePersisted = false;
    return false;
  }
  const key = memoryOutboxKey(owner, type, mutationId);
  const persistentBeforeWrite = parseStorageJson(storage, key);
  memoryOutboxTombstones.delete(key);
  memoryOutboxTombstoneValues.delete(key);
  memoryOutboxTombstoneCreatedAt.delete(key);
  reportedPendingLosses.delete(key);
  const persistedValue = value && typeof value === "object" && !Array.isArray(value)
    ? {
      ...value,
      // Migration/retry reads already carry the current write nonce. Keep it
      // stable when persistence is temporarily unavailable; a fresh queue
      // write omits the field and receives a new nonce below.
      outboxWriteNonce: preserveWriteNonce && typeof value.outboxWriteNonce === "string"
        ? value.outboxWriteNonce
        : createMutationId()
    }
    : value;
  lastPendingWritePersisted = createJsonStore(key, null).write(persistedValue);
  if (lastPendingWritePersisted) {
    // Publish the replacement before any later reader compares a stale
    // tombstone. The marker is fingerprinted, so a newer value remains visible
    // without a racy physical delete of another tab's marker.
    memoryOutboxEntries.delete(key);
    memoryOutboxEntryBaselines.delete(key);
  } else {
    if (!memoryOutboxEntryBaselines.has(key)) {
      memoryOutboxEntryBaselines.set(
        key,
        persistentBeforeWrite === null ? null : outboxValueFingerprint(persistentBeforeWrite),
      );
    }
    memoryOutboxEntries.set(key, persistedValue);
  }
  return lastPendingWritePersisted;
}

function removeOutboxEntry(owner, type, mutationId) {
  const storage = usableBrowserStorage();
  if (!storage) {
    const outbox = normalizeOutbox(ownerScopedValue(outboxStoreBase, owner, {}));
    delete outbox[type][mutationId];
    writeScopedValueForOwner(outboxStoreBase, owner, outbox);
    lastPendingWritePersisted = false;
    return false;
  }
  const key = outboxEntryKey(owner, type, mutationId);
  const currentValue = memoryOutboxEntries.has(key)
    ? memoryOutboxEntries.get(key)
    : parseStorageJson(storage, key);
  if (currentValue === null || currentValue === undefined) {
    lastPendingWritePersisted = true;
    return true;
  }
  const tombstonePersisted = writeOutboxTombstone(storage, owner, type, mutationId, currentValue);
  memoryOutboxEntries.delete(key);
  memoryOutboxEntryBaselines.delete(key);
  memoryOutboxTombstones.add(key);
  memoryOutboxTombstoneValues.set(key, outboxValueFingerprint(currentValue));
  memoryOutboxTombstoneCreatedAt.set(key, Date.now());
  if (tombstonePersisted) {
    removeOutboxEntryStorageIfUnchanged(storage, owner, type, mutationId, currentValue);
  }
  pruneOutboxTombstones(owner, type);
  // The marker is the durable acknowledgement. Physical compaction is best
  // effort; a newer value may legitimately remain at the same key.
  lastPendingWritePersisted = tombstonePersisted;
  return lastPendingWritePersisted;
}

function removeOutboxEntryIfUnchanged(owner, type, mutationId, expectedValue) {
  const storage = usableBrowserStorage();
  if (!storage) {
    const currentValue = readOutboxForOwner(owner)[type]?.[mutationId];
    if (outboxValueFingerprint(currentValue) !== outboxValueFingerprint(expectedValue)) return false;
    return removeOutboxEntry(owner, type, mutationId);
  }
  const key = outboxEntryKey(owner, type, mutationId);
  const memoryValue = memoryOutboxEntries.get(key);
  if (memoryValue !== undefined && outboxValueFingerprint(memoryValue) !== outboxValueFingerprint(expectedValue)) return false;
  const currentValue = memoryValue !== undefined ? memoryValue : parseStorageJson(storage, key);
  if (outboxValueFingerprint(currentValue) !== outboxValueFingerprint(expectedValue)) return false;
  const tombstonePersisted = writeOutboxTombstone(storage, owner, type, mutationId, expectedValue);
  memoryOutboxEntries.delete(key);
  memoryOutboxEntryBaselines.delete(key);
  memoryOutboxTombstones.add(key);
  memoryOutboxTombstoneValues.set(key, outboxValueFingerprint(expectedValue));
  memoryOutboxTombstoneCreatedAt.set(key, Date.now());
  if (tombstonePersisted) {
    removeOutboxEntryStorageIfUnchanged(storage, owner, type, mutationId, expectedValue);
  }
  pruneOutboxTombstones(owner, type);
  // The marker is the durable acknowledgement. Physical compaction is best
  // effort; a newer value may legitimately remain at the same key.
  lastPendingWritePersisted = tombstonePersisted;
  return lastPendingWritePersisted;
}

function writeOutboxEntriesForOwner(owner, value, options = {}) {
  const normalized = normalizeOutbox(value);
  let persisted = true;
  for (const type of OUTBOX_TYPES) {
    for (const [mutationId, entry] of Object.entries(normalized[type])) {
      persisted = writeOutboxEntry(owner, type, mutationId, entry, options) && persisted;
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
    if (value === null) continue;
    if (isOutboxEntrySuppressed(storage, owner, type, mutationId, value)) continue;
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
  return pruneOutboxTombstones(owner, type) && persisted;
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
      memoryOutboxEntryBaselines.delete(key);
      memoryOutboxTombstones.delete(key);
      memoryOutboxTombstoneValues.delete(key);
      memoryOutboxTombstoneCreatedAt.delete(key);
    }
    writeScopedValueForOwner(outboxStoreBase, owner, { signals: {}, searches: {} });
    return;
  }
  let persisted = true;
  for (const key of outboxEntryKeys(owner)) {
    const suffix = key.slice(outboxOwnerPrefix(owner).length);
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
    const value = memoryOutboxEntries.has(key)
      ? memoryOutboxEntries.get(key)
      : parseStorageJson(storage, key);
    if (value === null || value === undefined) continue;
    if (isOutboxEntrySuppressed(storage, owner, type, mutationId, value)) {
      // The acknowledgement marker may exist only in this tab when the
      // tombstone write previously hit quota. A clear must still remove the
      // matching raw value; otherwise dropping the memory marker below would
      // resurrect the acknowledged event after reload.
      persisted = removeOutboxEntryStorageIfUnchanged(storage, owner, type, mutationId, value) && persisted;
      continue;
    }
    persisted = removeOutboxEntryIfUnchanged(owner, type, mutationId, value) && persisted;
  }
  for (const type of OUTBOX_TYPES) {
    persisted = pruneOutboxTombstones(owner, type, { clearAll: true }) && persisted;
  }
  // The aggregate key is legacy-only, but clear its owner namespace as well
  // so a later storage fallback cannot resurrect pre-migration data.
  removeScopedValueForOwner(outboxStoreBase, owner);
  lastPendingWritePersisted = persisted;
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
      // Do not let browserStore's quota fallback blindly re-publish a stale
      // memory value. Compare the durable value directly first; another tab
      // may have acknowledged or replaced this mutation while this tab was
      // unable to write.
      const persistentValue = parseStorageJson(storage, key);
      const persistentFingerprint = persistentValue === null
        ? null
        : outboxValueFingerprint(persistentValue);
      const memoryFingerprint = outboxValueFingerprint(memoryValue);
      const baselineKnown = memoryOutboxEntryBaselines.has(key);
      const baselineFingerprint = memoryOutboxEntryBaselines.get(key);
      const persistentChanged = baselineKnown && persistentFingerprint !== baselineFingerprint;
      const untrackedConflict = !baselineKnown
        && persistentValue !== null
        && persistentFingerprint !== memoryFingerprint;

      if (persistentChanged || untrackedConflict) {
        memoryOutboxEntries.delete(key);
        memoryOutboxEntryBaselines.delete(key);
        if (persistentValue === null) createJsonStore(key, null).remove();
        else createJsonStore(key, null).write(persistentValue);
        if (!memoryOutboxTombstones.has(key)
          && persistentValue !== null
          && !isOutboxEntrySuppressed(storage, normalizedOwner, type, mutationId, persistentValue)) {
          raw[type][mutationId] = persistentValue;
        }
        continue;
      }

      // The durable read above can itself be the interleaving point. Re-read
      // once before exposing the fallback so a tab that committed immediately
      // after the first read wins without requiring a write from this tab.
      const latestPersistentValue = parseStorageJson(storage, key);
      if (latestPersistentValue !== null
        && outboxValueFingerprint(latestPersistentValue) !== memoryFingerprint) {
        memoryOutboxEntries.delete(key);
        memoryOutboxEntryBaselines.delete(key);
        if (!memoryOutboxTombstones.has(key)
          && !isOutboxEntrySuppressed(storage, normalizedOwner, type, mutationId, latestPersistentValue)) {
          raw[type][mutationId] = latestPersistentValue;
        }
        continue;
      }

      if (!memoryOutboxTombstones.has(key)
        && !isOutboxEntrySuppressed(storage, normalizedOwner, type, mutationId, memoryValue)) {
        raw[type][mutationId] = memoryValue;
      }
      // Do not publish the memory fallback from a read. localStorage has no
      // compare-and-swap primitive, so another tab could commit a newer value
      // between the durable read above and a setItem() here. If the durable
      // value already equals the fallback, it is safe to drop the redundant
      // in-memory copy without writing anything.
      if (persistentValue !== null && persistentFingerprint === memoryFingerprint) {
        memoryOutboxEntries.delete(key);
        memoryOutboxEntryBaselines.delete(key);
      }
      // Keep the in-memory copy authoritative while the retry is still
      // blocked; a durable conflict above is the only case that supersedes
      // it without a new queue write.
      continue;
    }
    if (memoryOutboxTombstones.has(key)) {
      const value = parseStorageJson(storage, key);
      if (value !== null && !isOutboxEntrySuppressed(storage, normalizedOwner, type, mutationId, value)) {
        raw[type][mutationId] = value;
      }
      continue;
    }
    const value = parseStorageJson(storage, key);
    if (value !== null && !isOutboxEntrySuppressed(storage, normalizedOwner, type, mutationId, value)) {
      raw[type][mutationId] = value;
    }
  }

  const migrationKey = outboxMigrationKey(normalizedOwner);
  if (parseStorageJson(storage, migrationKey) === null) {
    // Merge any partially migrated per-entry data with the legacy aggregate
    // before marking migration complete. This keeps a quota failure or a
    // second tab from making the remaining legacy entries unreachable.
    const legacy = filterLegacyOutboxByTombstones(
      normalizedOwner,
      normalizeOutbox(ownerScopedValue(outboxStoreBase, normalizedOwner, {})),
      storage,
    );
    const combined = normalizeOutbox({
      signals: { ...legacy.signals, ...raw.signals },
      searches: { ...legacy.searches, ...raw.searches }
    });
    const hasLegacyOrEntries = Object.keys(combined.signals).length > 0 || Object.keys(combined.searches).length > 0;
    writeOutboxEntriesForOwner(normalizedOwner, combined, { preserveWriteNonce: true });
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
  const pair = readSessionPairForOwner(owner);
  const session = ownerScopedValue(sessionStoreBase, owner, null);
  const token = ownerScopedValue(sessionTokenStoreBase, owner, null);
  return {
    pair,
    session,
    token,
    sessionId: isValidSessionPair(pair) ? pair.sessionId : session
  };
}

function ownerNamespaceHasRecoverableData(owner) {
  const session = ownerSessionData(owner);
  if (isValidSessionPair(session.pair) || isUuid(session.sessionId) || isValidSessionToken(session.token)) return true;

  if (Object.keys(readSignalSnapshotForOwner(owner)).length > 0) return true;

  const outbox = readOutboxForOwner(owner);
  return [...OUTBOX_TYPES].some((type) => Object.keys(outbox[type] || {}).length > 0);
}

function resolvePendingWriteOwner(owner, sourceSessionId = null) {
  const normalizedOwner = String(owner || "anonymous");
  if (normalizedOwner !== "anonymous") return normalizedOwner;

  const activeOwner = getInteractionOwner();
  if (activeOwner === "anonymous") return normalizedOwner;

  const pending = readPendingOwnerTransfer();
  const bridge = readOwnerTransferBridge();
  const transferTarget = pending?.targetOwner || bridge?.targetOwner;
  const acceptedSessionId = pending?.acceptedAnonymousSessionId || bridge?.acceptedAnonymousSessionId;
  const normalizedSourceSessionId = isUuid(sourceSessionId)
    ? String(sourceSessionId).toLowerCase()
    : null;
  // A stale tab may still hold an anonymous interaction context after the
  // shared owner boundary moved to the account. Re-home only when the durable
  // transfer record names this exact account and the captured session is the
  // exact session accepted by the server; never move a different anonymous
  // session into an account that happens to log in later.
  return transferTarget === activeOwner
    && normalizedSourceSessionId
    && acceptedSessionId === normalizedSourceSessionId
    ? activeOwner
    : normalizedOwner;
}

function rawStorageValue(storage, key) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function clearOwnerScopedAggregateIfUnchanged(key, owner, expectedRaw) {
  const storage = usableBrowserStorage();
  if (!storage) return false;
  const expected = expectedRaw === null || expectedRaw === undefined ? null : expectedRaw;
  const currentRaw = rawStorageValue(storage, key);
  if (currentRaw !== expected) return false;
  // A missing key is still a value that must remain missing. Re-read it before
  // declaring the source clean so a legacy tab cannot publish an aggregate
  // between the snapshot read and this compare. The next promotion retry can
  // then copy that late write instead of losing it behind a cleared journal.
  if (rawStorageValue(storage, key) !== expected) return false;
  if (expected === null) return true;

  let current;
  try {
    current = JSON.parse(currentRaw);
  } catch {
    return false;
  }
  if (!current || typeof current !== "object" || Array.isArray(current) || !current.owners) return false;
  if (!Object.prototype.hasOwnProperty.call(current.owners, owner)) return true;

  const owners = { ...current.owners };
  delete owners[owner];
  const replacement = Object.keys(owners).length
    ? JSON.stringify({ version: 2, owners })
    : null;
  // localStorage has no CAS primitive. Re-read immediately before the
  // replacement so a newer owner write is never removed from this aggregate.
  if (rawStorageValue(storage, key) !== expectedRaw) return false;
  try {
    if (replacement === null) storage.removeItem(key);
    else storage.setItem(key, replacement);
  } catch {
    return false;
  }
  return rawStorageValue(storage, key) === replacement;
}

function clearSessionPairEntryIfUnchanged(owner, expectedRaw) {
  if (expectedRaw === null || expectedRaw === undefined) return true;
  const storage = usableBrowserStorage();
  if (!storage) return false;
  const key = sessionPairEntryKey(owner);
  const currentRaw = rawStorageValue(storage, key);
  if (currentRaw === null) return true;
  if (currentRaw !== expectedRaw) return false;
  let current;
  try {
    current = JSON.parse(currentRaw);
  } catch {
    return false;
  }
  if (current?.deleted === true) return true;
  const replacement = JSON.stringify({ version: SESSION_PAIR_ENTRY_VERSION, deleted: true });
  if (rawStorageValue(storage, key) !== expectedRaw) return false;
  try {
    storage.setItem(key, replacement);
  } catch {
    return false;
  }
  return rawStorageValue(storage, key) === replacement;
}

function clearSignalEntryIfUnchanged(owner, showId, expectedRaw) {
  if (expectedRaw === null || expectedRaw === undefined) return true;
  const storage = usableBrowserStorage();
  if (!storage) return false;
  const key = signalEntryKey(owner, showId);
  const currentRaw = rawStorageValue(storage, key);
  if (currentRaw === null) return true;
  if (currentRaw !== expectedRaw) return false;
  const current = parseStorageJson(storage, key);
  if (!current) return true;
  // A marker hides exactly the copied value. If another tab replaces the
  // entry, readSignalEntry() will keep that newer value visible.
  if (!writeSignalClearMarker(owner, showId, current)) return false;
  return rawStorageValue(storage, key) === expectedRaw;
}

function pendingEntryIntentFingerprint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = { ...value };
  // Retry bookkeeping is allowed to change while a promotion is in flight;
  // the mutation id and user intent remain immutable for this cleanup.
  delete intent.lastAttemptAt;
  delete intent.outboxWriteNonce;
  return outboxValueFingerprint(intent);
}

function clearOutboxEntryFromTransferSnapshot(owner, type, mutationId, snapshot) {
  const storage = usableBrowserStorage();
  if (!storage) return false;
  const key = outboxEntryKey(owner, type, mutationId);
  const currentRaw = rawStorageValue(storage, key);
  const memoryValue = memoryOutboxEntries.get(key);
  if (currentRaw === null) {
    if (memoryValue === undefined) return true;
    if (pendingEntryIntentFingerprint(memoryValue) !== pendingEntryIntentFingerprint(snapshot?.value)) {
      return false;
    }
    memoryOutboxEntries.delete(key);
    memoryOutboxEntryBaselines.delete(key);
    return true;
  }
  const expectedValue = snapshot?.value;
  const currentValue = parseStorageJson(storage, key);
  if (!currentValue || !expectedValue) return false;
  if (pendingEntryIntentFingerprint(currentValue) !== pendingEntryIntentFingerprint(expectedValue)) {
    return false;
  }
  // removeOutboxEntryIfUnchanged writes a durable tombstone and performs its
  // own compare-before-physical-delete. Passing the current value lets a
  // retry-only timestamp update be cleaned without losing a new mutation.
  return removeOutboxEntryIfUnchanged(owner, type, mutationId, currentValue);
}

function captureOwnerTransferSnapshot(owner) {
  const storage = usableBrowserStorage();
  const source = ownerSessionData(owner);
  const sourceSignals = readSignalSnapshotForOwner(owner);
  const sourceOutbox = readOutboxForOwner(owner);
  const snapshot = {
    source,
    sourceSignals,
    sourceOutbox,
    sessionRaw: null,
    sessionTokenRaw: null,
    sessionPairRaw: null,
    sessionPairAggregateRaw: null,
    signalAggregateRaw: null,
    outboxAggregateRaw: null,
    signalEntries: {},
    outboxEntries: { signals: {}, searches: {} },
  };
  if (!storage) return snapshot;

  snapshot.sessionRaw = rawStorageValue(storage, interactionConfig.sessionStorageKey);
  snapshot.sessionTokenRaw = rawStorageValue(storage, `${interactionConfig.sessionStorageKey}:token`);
  snapshot.sessionPairRaw = rawStorageValue(storage, sessionPairEntryKey(owner));
  snapshot.sessionPairAggregateRaw = rawStorageValue(storage, `${interactionConfig.sessionStorageKey}:pair`);
  snapshot.signalAggregateRaw = rawStorageValue(storage, appConfig.signals.storageKey);
  snapshot.outboxAggregateRaw = rawStorageValue(storage, interactionConfig.outboxStorageKey);

  for (const key of signalEntryKeys(owner)) {
    const showId = decodeSignalEntryShowId(owner, key);
    if (!showId) continue;
    const raw = rawStorageValue(storage, key);
    if (raw !== null) snapshot.signalEntries[showId] = { raw, value: parseStorageJson(storage, key) };
  }
  for (const key of outboxEntryKeys(owner)) {
    const suffix = key.slice(outboxOwnerPrefix(owner).length);
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
    const raw = rawStorageValue(storage, key);
    const memoryValue = memoryOutboxEntries.get(key);
    if (raw !== null || memoryValue !== undefined) snapshot.outboxEntries[type][mutationId] = {
      raw,
      value: raw === null ? memoryValue : parseStorageJson(storage, key),
    };
  }
  return snapshot;
}

function clearOwnerTransferSnapshot(owner, snapshot) {
  const storage = usableBrowserStorage();
  if (!storage) return false;
  let cleaned = true;
  const source = snapshot.source;

  if (source.pair && snapshot.sessionPairRaw) {
    cleaned = clearSessionPairEntryIfUnchanged(owner, snapshot.sessionPairRaw) && cleaned;
  }
  cleaned = clearOwnerScopedAggregateIfUnchanged(
    `${interactionConfig.sessionStorageKey}:pair`,
    owner,
    snapshot.sessionPairAggregateRaw,
  ) && cleaned;
  cleaned = clearOwnerScopedAggregateIfUnchanged(
    interactionConfig.sessionStorageKey,
    owner,
    snapshot.sessionRaw,
  ) && cleaned;
  cleaned = clearOwnerScopedAggregateIfUnchanged(
    `${interactionConfig.sessionStorageKey}:token`,
    owner,
    snapshot.sessionTokenRaw,
  ) && cleaned;

  for (const [showId, entry] of Object.entries(snapshot.signalEntries)) {
    cleaned = clearSignalEntryIfUnchanged(owner, showId, entry.raw) && cleaned;
  }
  cleaned = clearOwnerScopedAggregateIfUnchanged(
    appConfig.signals.storageKey,
    owner,
    snapshot.signalAggregateRaw,
  ) && cleaned;

  for (const type of OUTBOX_TYPES) {
    for (const [mutationId, entry] of Object.entries(snapshot.outboxEntries[type])) {
      cleaned = clearOutboxEntryFromTransferSnapshot(owner, type, mutationId, entry) && cleaned;
    }
  }
  cleaned = clearOwnerScopedAggregateIfUnchanged(
    interactionConfig.outboxStorageKey,
    owner,
    snapshot.outboxAggregateRaw,
  ) && cleaned;

  // Any key not present in the snapshot was written after the copy began.
  // Keep it in the source namespace and leave the journal for a later retry.
  for (const key of signalEntryKeys(owner)) {
    const showId = decodeSignalEntryShowId(owner, key);
    if (showId && !Object.prototype.hasOwnProperty.call(snapshot.signalEntries, showId)) cleaned = false;
  }
  for (const key of outboxEntryKeys(owner)) {
    const suffix = key.slice(outboxOwnerPrefix(owner).length);
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
    const value = parseStorageJson(storage, key);
    if (value !== null && !isOutboxEntrySuppressed(storage, owner, type, mutationId, value)) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.outboxEntries[type], mutationId)) cleaned = false;
    }
  }
  return cleaned;
}

function transferOwnerData(sourceOwner, targetOwner, expectedSourceSessionId = null) {
  const storageAvailable = Boolean(usableBrowserStorage());
  const sourceSnapshot = captureOwnerTransferSnapshot(sourceOwner);
  const source = sourceSnapshot.source;
  const target = ownerSessionData(targetOwner);
  if (expectedSourceSessionId && source.sessionId
    && String(expectedSourceSessionId).toLowerCase() !== String(source.sessionId).toLowerCase()) {
    return false;
  }
  const sourcePairIsValid = isValidSessionPair(source.pair);
  const targetPairIsValid = isValidSessionPair(target.pair);
  let pairPersisted = false;
  if (sourcePairIsValid) {
    pairPersisted = writeSessionPairForOwner(targetOwner, source.pair);
  } else if (targetPairIsValid) {
    pairPersisted = writeSessionPairForOwner(targetOwner, target.pair);
  } else {
    const mergedSession = isUuid(source.sessionId) ? String(source.sessionId).toLowerCase() : target.session;
    const mergedToken = isValidSessionToken(source.token) ? source.token.trim() : target.token;
    pairPersisted = writeSessionPairForOwner(
      targetOwner,
      isUuid(mergedSession) && isValidSessionToken(mergedToken)
        ? { sessionId: String(mergedSession).toLowerCase(), sessionToken: mergedToken.trim() }
        : null,
    );
  }
  // Remove legacy copies after the atomic pair has been promoted. They
  // remain readable only as a migration fallback for older deployments.
  if (pairPersisted) clearLegacySessionValues(targetOwner);

  const sourceSignals = sourceSnapshot.sourceSignals;
  const targetSignals = readSignalSnapshotForOwner(targetOwner);
  const signalsPersisted = writeSignalSnapshotForOwner(
    targetOwner,
    mergeSignalSnapshots(targetSignals, sourceSignals),
  );
  const sourceOutbox = sourceSnapshot.sourceOutbox;
  const targetOutbox = readOutboxForOwner(targetOwner);
  // A previous failed promotion can leave target entries in this tab's
  // memory-only fallback. Retry those entries as well, but do not rewrite
  // every durable target entry from the stale snapshot.
  const targetMemoryOutbox = memoryOutboxEntriesForOwner(targetOwner);
  const entriesToWrite = {
    signals: { ...targetMemoryOutbox.signals },
    searches: { ...targetMemoryOutbox.searches }
  };
  for (const type of OUTBOX_TYPES) {
    for (const [mutationId, sourceEntry] of Object.entries(sourceOutbox[type])) {
      const targetEntry = targetOutbox[type][mutationId];
      if (!targetEntry || comparePendingEntries([mutationId, sourceEntry], [mutationId, targetEntry]) > 0) {
        entriesToWrite[type][mutationId] = sourceEntry;
      }
    }
  }
  const hasOutboxEntriesToWrite = [...OUTBOX_TYPES]
    .some((type) => Object.keys(entriesToWrite[type]).length > 0);
  const outboxPersisted = hasOutboxEntriesToWrite
    ? Boolean(writeOutboxEntriesForOwner(targetOwner, entriesToWrite) && lastPendingWritePersisted)
    : true;
  lastPendingWritePersisted = outboxPersisted;
  const sourceClean = storageAvailable && pairPersisted && signalsPersisted && outboxPersisted
    ? clearOwnerTransferSnapshot(sourceOwner, sourceSnapshot)
    : false;
  return Boolean(storageAvailable && pairPersisted && signalsPersisted && outboxPersisted && sourceClean);
}

function finalizeOwnerTransfer(targetOwner, acceptedAnonymousSessionId) {
  // Keep a short-lived durable bridge after the source snapshot is copied.
  // A stale tab can still enqueue with owner=anonymous after the pending
  // journal is gone; the bridge lets that write be re-homed only to the exact
  // account that completed this promotion.
  if (!writeOwnerTransferBridge(targetOwner, acceptedAnonymousSessionId)) return false;
  return clearPendingOwnerTransfer();
}

function clearOwnerData(owner) {
  removeScopedValueForOwner(sessionStoreBase, owner);
  removeScopedValueForOwner(sessionTokenStoreBase, owner);
  writeSessionPairForOwner(owner, null);
  removeSignalSnapshotForOwner(owner);
  clearOutboxForOwner(owner);
}

function discardPendingPromotionForOwner(nextOwner, previousOwner, promotion) {
  const ownerPersisted = ownerStoreBase.write(nextOwner);
  if (getInteractionOwner() !== nextOwner) {
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
  if (!ownerPersisted) {
    return {
      previousOwner,
      nextOwner,
      changed: true,
      persisted: false,
      promotionPending: true,
      pendingOwnerTransfer: true,
      revision: interactionRevision
    };
  }

  // The server authenticated the account but did not accept the anonymous
  // session proof. Do not merge that unverified namespace into the account;
  // remove it before the next account can observe it.
  clearOwnerData("anonymous");
  clearPendingOwnerTransfer();
  clearOwnerTransferBridge();
  clearPendingAuthenticatedInteractionPromotion(promotion?.promotionId || null);
  const markerCleared = readPendingAuthenticatedInteractionPromotion() === null;
  interactionRevision += 1;
  return {
    previousOwner,
    nextOwner,
    changed: true,
    persisted: true,
    transferPersisted: false,
    promotionPending: !markerCleared,
    pendingOwnerTransfer: false,
    discardedAnonymousPromotion: true,
    revision: interactionRevision
  };
}

export function setInteractionOwner(
  userId,
  { acceptedAnonymousSessionId = null, discardUnconfirmedPromotion: discardUnconfirmed = false } = {},
) {
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
    if (discardUnconfirmed) {
      return discardPendingPromotionForOwner(nextOwner, previousOwner, pendingPromotion);
    }
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
    const journalCleared = transferPersisted && finalizeOwnerTransfer(
      nextOwner,
      pendingTransfer.acceptedAnonymousSessionId,
    );
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
    if (transferPersisted) {
      finalizeOwnerTransfer(
        nextOwner,
        pendingTransfer?.acceptedAnonymousSessionId || acceptedAnonymousSessionId,
      );
    }
  }

  // Anonymous data is copied only when the server explicitly confirms the
  // exact session id. Otherwise discard it instead of offering it to a
  // different account after a cross-tab logout or a failed attach. A pending
  // journal protects its source namespace until the copy succeeds.
  if (shouldTransfer) {
    // transferOwnerData already clears only the exact source snapshot. Do not
    // call clearOwnerData here: a second tab may have queued a newer mutation
    // after the snapshot was copied.
  } else if (!readPendingOwnerTransfer()) {
    if (previousOwner === "anonymous" && nextOwner !== "anonymous") clearOwnerTransferBridge();
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

export function promoteAuthenticatedInteraction(
  userId,
  acceptedAnonymousSessionId,
  options = {},
) {
  return setInteractionOwner(userId, { acceptedAnonymousSessionId, ...options });
}

export { readPendingOwnerTransfer };

export function readOwnerScopedSignalState(ownerId = getInteractionOwner()) {
  const owner = String(ownerId || "anonymous");
  return mergePendingSignalState(readSignalSnapshotForOwner(owner), owner);
}

export function writeOwnerScopedSignalState(value) {
  return writeSignalSnapshotForOwner(getInteractionOwner(), value && typeof value === "object" ? value : {});
}

export function replaceOwnerScopedSignalState(value, options = {}) {
  return replaceSignalSnapshotForOwner(
    getInteractionOwner(),
    value && typeof value === "object" ? value : {},
    options,
  );
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
  const rawRating = ratingRow.rating ?? ratingRow.rating_value ?? base.rating;
  if (rawRating === null || rawRating === undefined || (typeof rawRating === "string" && !rawRating.trim())) return null;
  const ratingValue = Number(rawRating);
  if (!isValidRating(ratingValue)) return null;
  base.rating = ratingValue;
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
  if (!receipt) return null;
  writeSignalSnapshotForOwner(String(ownerId || "anonymous"), { [normalizedShowId]: receipt });
  return receipt;
}

export function removeOwnerScopedSignalState() {
  removeSignalSnapshotForOwner(getInteractionOwner());
}

export const interactionSessionStore = {
  read(ownerId = getInteractionOwner()) {
    const owner = String(ownerId || "anonymous");
    const pair = readSessionPairForOwner(owner);
    if (pair !== null && pair !== undefined) {
      if (isValidSessionPair(pair)) return pair.sessionId;
      clearLegacySessionValues(owner);
      writeSessionPairForOwner(owner, null);
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
    const migrated = writeSessionPairForOwner(owner, migratedPair);
    if (migrated) clearLegacySessionValues(owner);
    return migratedPair.sessionId;
  },
  readToken(ownerId = getInteractionOwner()) {
    const owner = String(ownerId || "anonymous");
    const pair = readSessionPairForOwner(owner);
    if (isValidSessionPair(pair)) return pair.sessionToken;
    const sessionId = interactionSessionStore.read(owner);
    const migratedPair = readSessionPairForOwner(owner);
    return sessionId && isValidSessionPair(migratedPair) ? migratedPair.sessionToken : null;
  },
  write(value, token = null, ownerId = getInteractionOwner()) {
    const owner = String(ownerId || "anonymous");
    const pair = isUuid(value) && isValidSessionToken(token)
      ? { sessionId: String(value).toLowerCase(), sessionToken: token.trim() }
      : null;
    const persisted = writeSessionPairForOwner(owner, pair);
    if (persisted) clearLegacySessionValues(owner);
  }
};

export function clearInteractionSessionIfUnchanged(expectedSessionId, ownerId = getInteractionOwner()) {
  const owner = String(ownerId || "anonymous");
  const expected = String(expectedSessionId || "").trim().toLowerCase();
  if (!isUuid(expected)) return false;
  const storage = usableBrowserStorage();
  if (!storage) return false;

  const key = sessionPairEntryKey(owner);
  const currentRaw = rawStorageValue(storage, key);
  if (currentRaw === null) {
    // Older bundles stored owner namespaces in one aggregate key. Keep that
    // migration path recoverable, but only clear an explicitly owned entry;
    // an unscoped legacy pair is ambiguous and must fail closed.
    const aggregateKey = `${interactionConfig.sessionStorageKey}:pair`;
    const aggregateRaw = rawStorageValue(storage, aggregateKey);
    if (aggregateRaw === null) return false;
    const aggregate = parseStorageJson(storage, aggregateKey);
    const legacyPair = aggregate && typeof aggregate === "object" && !Array.isArray(aggregate)
      && aggregate.owners && Object.prototype.hasOwnProperty.call(aggregate.owners, owner)
      ? aggregate.owners[owner]
      : null;
    if (!isValidSessionPair(legacyPair)
      || String(legacyPair.sessionId).toLowerCase() !== expected
      || rawStorageValue(storage, aggregateKey) !== aggregateRaw) {
      return false;
    }
    const cleared = clearOwnerScopedAggregateIfUnchanged(aggregateKey, owner, aggregateRaw);
    if (cleared) clearLegacySessionValues(owner);
    return cleared;
  }
  const current = parseStorageJson(storage, key);
  const pair = current?.version === SESSION_PAIR_ENTRY_VERSION && !current.deleted
    ? current.value
    : current;
  if (!isValidSessionPair(pair)
    || String(pair.sessionId).toLowerCase() !== expected
    || rawStorageValue(storage, key) !== currentRaw) {
    return false;
  }

  const cleared = clearSessionPairEntryIfUnchanged(owner, currentRaw);
  if (cleared) clearLegacySessionValues(owner);
  return cleared;
}

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

export function queuePendingSignal(showId, { rating, watchMinutes }, mutationId = createMutationId(), requestedFirstQueuedAt = null, ownerId = getInteractionOwner(), sourceSessionId = null) {
  const normalizedShowId = String(showId || "").trim();
  const ratingIsUnset = rating === null
    || rating === undefined
    || (typeof rating === "string" && !rating.trim());
  const normalizedRating = ratingIsUnset ? null : Number(rating);
  const normalizedWatchMinutes = Number(watchMinutes);
  if (!normalizedShowId || normalizedShowId.length > 32 || !isUuid(mutationId) || (normalizedRating !== null && !isValidRating(normalizedRating)) || !Number.isInteger(normalizedWatchMinutes) || normalizedWatchMinutes < 0 || normalizedWatchMinutes > interactionConfig.maxWatchMinutes) {
    throw new Error("Invalid signal payload");
  }
  const normalizedMutationId = String(mutationId).toLowerCase();
  const owner = resolvePendingWriteOwner(ownerId, sourceSessionId);
  const existing = readOutboxForOwner(owner).signals[normalizedMutationId];
  const firstQueuedAt = existing?.firstQueuedAt
    || existing?.queuedAt
    || normalizeTimestamp(requestedFirstQueuedAt, new Date().toISOString());
  const { clientDeviceId, clientEventSequence } = pendingEventMetadata(existing);
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

export function acknowledgePendingSignal(showId, mutationId, ownerId = getInteractionOwner(), expectedEntry = null) {
  const normalizedMutationId = String(mutationId || "").toLowerCase();
  const owner = String(ownerId || "anonymous");
  const signal = readOutboxForOwner(owner).signals[normalizedMutationId];
  if (!signal || signal.mutationId !== normalizedMutationId || (showId && signal.showId !== String(showId))) return;
  if (expectedEntry) removeOutboxEntryIfUnchanged(owner, "signals", normalizedMutationId, expectedEntry);
  else removeOutboxEntry(owner, "signals", normalizedMutationId);
}

export function queuePendingSearch({ query, resultCount, filters }, mutationId = createMutationId(), requestedFirstQueuedAt = null, ownerId = getInteractionOwner(), sourceSessionId = null) {
  const normalizedQuery = String(query ?? "").trim().slice(0, 200);
  if (!normalizedQuery || !isUuid(mutationId)) throw new Error("Invalid search payload");
  const normalizedMutationId = String(mutationId).toLowerCase();
  const owner = resolvePendingWriteOwner(ownerId, sourceSessionId);
  const existing = readOutboxForOwner(owner).searches[normalizedMutationId];
  const firstQueuedAt = existing?.firstQueuedAt
    || existing?.queuedAt
    || normalizeTimestamp(requestedFirstQueuedAt, new Date().toISOString());
  const { clientDeviceId, clientEventSequence } = pendingEventMetadata(existing);
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

export function acknowledgePendingSearch(mutationId, ownerId = getInteractionOwner(), expectedEntry = null) {
  const key = String(mutationId || "").toLowerCase();
  const owner = String(ownerId || "anonymous");
  const search = readOutboxForOwner(owner).searches[key];
  if (!search || search.mutationId !== key) return;
  if (expectedEntry) removeOutboxEntryIfUnchanged(owner, "searches", key, expectedEntry);
  else removeOutboxEntry(owner, "searches", key);
}

export function mergeInteractionState(remoteState, localState = {}) {
  const pending = readPendingInteractions();
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
  // The server is authoritative for acknowledged state, except when this
  // response is a stale snapshot. A receipt newer than the snapshot watermark
  // may have been committed by another tab after this request began.
  const localRatings = localState?.ratings && typeof localState.ratings === "object"
    ? localState.ratings
    : {};
  const snapshotAt = Date.parse(remoteState?.snapshot_at || "");
  for (const [showId, localSignal] of Object.entries(localRatings)) {
    const localServerAt = signalTimestamp(localSignal, "serverSavedAt");
    if (localServerAt === null) continue;
    const remoteSignal = ratings[showId];
    const remoteServerAt = signalTimestamp(remoteSignal, "serverSavedAt");
    const newerThanRemote = remoteServerAt === null || localServerAt > remoteServerAt;
    const newerThanSnapshot = Number.isFinite(snapshotAt) && localServerAt > snapshotAt;
    if (newerThanRemote && newerThanSnapshot) ratings[showId] = localSignal;
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
      writeSessionPairForOwner(owner, null);
    }
    removeSignalSnapshotForOwner(owner);
    if (clearPending) clearOutboxForOwner(owner);
  }
  legacyFavoriteStore.remove();
  legacyWatchlistStore.remove();
  if (resetOwner && owner !== "anonymous" && !preserveTransferSource) {
    removeScopedValueForOwner(sessionStoreBase, "anonymous");
    removeScopedValueForOwner(sessionTokenStoreBase, "anonymous");
    writeSessionPairForOwner("anonymous", null);
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
