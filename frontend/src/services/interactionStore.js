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
const signalStoreBase = createJsonStore(appConfig.signals.storageKey, {});
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
const reportedPendingLosses = new Set();
let pendingInteractionLossCount = 0;

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

function writeScopedValue(store, value) {
  return writeScopedValueForOwner(store, getInteractionOwner(), value);
}

function removeScopedValue(store) {
  removeScopedValueForOwner(store, getInteractionOwner());
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

function clearLegacySessionValues(owner) {
  removeScopedValueForOwner(sessionStoreBase, owner);
  removeScopedValueForOwner(sessionTokenStoreBase, owner);
}

export function getInteractionDeviceId() {
  const current = deviceStoreBase.read();
  if (isUuid(current)) return String(current).toLowerCase();
  const deviceId = createMutationId();
  deviceStoreBase.write(deviceId);
  return deviceId;
}

export function nextInteractionEventSequence() {
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

function encodedOwner(owner) {
  return encodeURIComponent(String(owner || "anonymous"));
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

export function setInteractionOwner(userId, { acceptedAnonymousSessionId = null } = {}) {
  const nextOwner = userId ? String(userId) : "anonymous";
  const previousOwner = getInteractionOwner();
  if (previousOwner === nextOwner) return { previousOwner, nextOwner, changed: false, revision: interactionRevision };

  // Persist the namespace boundary before moving or deleting any data. If
  // storage is full/restricted, browserStore keeps this value in memory and
  // reports the durable-write failure; never continue a transition while the
  // owner still resolves to the old persistent namespace.
  const ownerPersisted = ownerStoreBase.write(nextOwner);
  if (getInteractionOwner() !== nextOwner) {
    return {
      previousOwner,
      nextOwner,
      changed: false,
      persisted: false,
      revision: interactionRevision
    };
  }

  if (previousOwner === "anonymous" && nextOwner !== "anonymous") {
    const anonymousSession = ownerScopedValue(sessionStoreBase, previousOwner, null);
    const anonymousToken = ownerScopedValue(sessionTokenStoreBase, previousOwner, null);
    const anonymousPair = ownerScopedValue(sessionPairStoreBase, previousOwner, null);
    const accountSession = ownerScopedValue(sessionStoreBase, nextOwner, null);
    const accountToken = ownerScopedValue(sessionTokenStoreBase, nextOwner, null);
    const accountPair = ownerScopedValue(sessionPairStoreBase, nextOwner, null);
    const anonymousSessionId = isValidSessionPair(anonymousPair) ? anonymousPair.sessionId : anonymousSession;
    const canMergeAnonymousSession = isUuid(acceptedAnonymousSessionId)
      && isUuid(anonymousSessionId)
      && String(acceptedAnonymousSessionId).toLowerCase() === String(anonymousSessionId).toLowerCase();
    let anonymousTransferPersisted = false;
    if (canMergeAnonymousSession) {
      const anonymousPairIsValid = isValidSessionPair(anonymousPair);
      const accountPairIsValid = isValidSessionPair(accountPair);
      let pairPersisted = false;
      if (anonymousPairIsValid) {
        pairPersisted = writeScopedValueForOwner(sessionPairStoreBase, nextOwner, anonymousPair);
      } else if (accountPairIsValid) {
        pairPersisted = writeScopedValueForOwner(sessionPairStoreBase, nextOwner, accountPair);
      } else {
        const mergedSession = isUuid(anonymousSessionId) ? String(anonymousSessionId).toLowerCase() : accountSession;
        const mergedToken = isValidSessionToken(anonymousToken) ? anonymousToken.trim() : accountToken;
        pairPersisted = writeScopedValueForOwner(
          sessionPairStoreBase,
          nextOwner,
          isUuid(mergedSession) && isValidSessionToken(mergedToken)
            ? { sessionId: String(mergedSession).toLowerCase(), sessionToken: mergedToken.trim() }
            : null
        );
      }
      // Remove legacy copies after the atomic pair has been promoted. They
      // remain readable only as a migration fallback for older deployments.
      if (pairPersisted) clearLegacySessionValues(nextOwner);
      const anonymousSignals = ownerScopedValue(signalStoreBase, previousOwner, {});
      const accountSignals = ownerScopedValue(signalStoreBase, nextOwner, {});
      const signalsPersisted = writeScopedValueForOwner(signalStoreBase, nextOwner, {
        ...(accountSignals && typeof accountSignals === "object" && !Array.isArray(accountSignals) ? accountSignals : {}),
        ...(anonymousSignals && typeof anonymousSignals === "object" && !Array.isArray(anonymousSignals) ? anonymousSignals : {})
      });
      const anonymousOutbox = readOutboxForOwner(previousOwner);
      const accountOutbox = readOutboxForOwner(nextOwner);
      writeOutboxEntriesForOwner(nextOwner, {
        signals: { ...accountOutbox.signals, ...anonymousOutbox.signals },
        searches: { ...accountOutbox.searches, ...anonymousOutbox.searches }
      });
      anonymousTransferPersisted = Boolean(
        ownerPersisted
        && pairPersisted
        && signalsPersisted
        && lastPendingWritePersisted
      );
    }
    // Anonymous data is copied only when the server explicitly confirms the
    // exact session id. Otherwise discard it instead of offering it to a
    // different account after a cross-tab logout or a failed attach. When the
    // copy was requested, retain the source namespace until every durable
    // destination write succeeds; memory-only copies disappear on reload.
    if (!canMergeAnonymousSession || anonymousTransferPersisted) {
      removeScopedValueForOwner(sessionStoreBase, previousOwner);
      removeScopedValueForOwner(sessionTokenStoreBase, previousOwner);
      removeScopedValueForOwner(sessionPairStoreBase, previousOwner);
      removeScopedValueForOwner(signalStoreBase, previousOwner);
      clearOutboxForOwner(previousOwner);
    }
  }

  interactionRevision += 1;
  return { previousOwner, nextOwner, changed: true, persisted: ownerPersisted, revision: interactionRevision };
}

export function promoteAuthenticatedInteraction(userId, acceptedAnonymousSessionId) {
  return setInteractionOwner(userId, { acceptedAnonymousSessionId });
}

export function readOwnerScopedSignalState(ownerId = getInteractionOwner()) {
  const owner = String(ownerId || "anonymous");
  const value = ownerScopedValue(signalStoreBase, owner, {});
  return mergePendingSignalState(value, owner);
}

export function writeOwnerScopedSignalState(value) {
  writeScopedValue(signalStoreBase, value && typeof value === "object" ? value : {});
}

export function removeOwnerScopedSignalState() {
  removeScopedValue(signalStoreBase);
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

export function clearInteractionState({ preserveSession = false, clearPending = true, resetOwner = true, ownerId = null } = {}) {
  const owner = ownerId ? String(ownerId) : getInteractionOwner();
  const currentOwner = getInteractionOwner();
  if (!preserveSession) {
    removeScopedValueForOwner(sessionStoreBase, owner);
    removeScopedValueForOwner(sessionTokenStoreBase, owner);
    removeScopedValueForOwner(sessionPairStoreBase, owner);
  }
  removeScopedValueForOwner(signalStoreBase, owner);
  if (clearPending) clearOutboxForOwner(owner);
  legacyFavoriteStore.remove();
  legacyWatchlistStore.remove();
  if (resetOwner && owner !== "anonymous") {
    removeScopedValueForOwner(sessionStoreBase, "anonymous");
    removeScopedValueForOwner(sessionTokenStoreBase, "anonymous");
    removeScopedValueForOwner(sessionPairStoreBase, "anonymous");
    removeScopedValueForOwner(signalStoreBase, "anonymous");
    if (clearPending) clearOutboxForOwner("anonymous");
  }
  if (resetOwner) {
    ownerStoreBase.write("anonymous");
    interactionRevision += 1;
  } else if (owner === currentOwner) {
    interactionRevision += 1;
  }
}
