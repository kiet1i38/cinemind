// Owner-scoped client fallback stores for interaction state.

import { appConfig } from "../config/appConfig";
import { createJsonStore } from "./browserStore";

const interactionConfig = appConfig.interaction;
const ownerStoreBase = createJsonStore(interactionConfig.ownerStorageKey, "anonymous");
const sessionStoreBase = createJsonStore(interactionConfig.sessionStorageKey, null);
const sessionTokenStoreBase = createJsonStore(`${interactionConfig.sessionStorageKey}:token`, null);
const signalStoreBase = createJsonStore(appConfig.signals.storageKey, {});
const outboxStoreBase = createJsonStore(interactionConfig.outboxStorageKey, () => ({ signals: {}, searches: {} }));
const legacyFavoriteStore = createJsonStore("cinemind-favorites", null);
const legacyWatchlistStore = createJsonStore("cinemind-watchlist", null);

// Remove obsolete preference data as soon as the new bundle loads.
legacyFavoriteStore.remove();
legacyWatchlistStore.remove();

export function getInteractionOwner() {
  const owner = ownerStoreBase.read();
  return typeof owner === "string" && owner.trim() ? owner : "anonymous";
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
  store.write({ version: 2, owners });
}

function writeScopedValue(store, value) {
  writeScopedValueForOwner(store, getInteractionOwner(), value);
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

function normalizeOutbox(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    signals: source.signals && typeof source.signals === "object" && !Array.isArray(source.signals) ? source.signals : {},
    searches: source.searches && typeof source.searches === "object" && !Array.isArray(source.searches) ? source.searches : {}
  };
}

export function setInteractionOwner(userId) {
  const nextOwner = userId ? String(userId) : "anonymous";
  const previousOwner = getInteractionOwner();
  if (previousOwner === nextOwner) return { previousOwner, nextOwner, changed: false };

  if (previousOwner === "anonymous" && nextOwner !== "anonymous") {
    const anonymousSession = ownerScopedValue(sessionStoreBase, previousOwner, null);
    const anonymousToken = ownerScopedValue(sessionTokenStoreBase, previousOwner, null);
    const accountSession = ownerScopedValue(sessionStoreBase, nextOwner, null);
    const accountToken = ownerScopedValue(sessionTokenStoreBase, nextOwner, null);
    // Login/registration attaches the anonymous session server-side. Prefer
    // its proof even if an older account namespace already exists.
    if (isUuid(anonymousSession) || !isUuid(accountSession)) {
      writeScopedValueForOwner(sessionStoreBase, nextOwner, isUuid(anonymousSession) ? String(anonymousSession).toLowerCase() : accountSession);
    }
    if (typeof anonymousToken === "string" && anonymousToken.trim().length >= 20 && anonymousToken.trim().length <= 256) {
      writeScopedValueForOwner(sessionTokenStoreBase, nextOwner, anonymousToken.trim());
    } else if (accountToken !== null && accountToken !== undefined) {
      writeScopedValueForOwner(sessionTokenStoreBase, nextOwner, accountToken);
    }
    const anonymousSignals = ownerScopedValue(signalStoreBase, previousOwner, {});
    const accountSignals = ownerScopedValue(signalStoreBase, nextOwner, {});
    writeScopedValueForOwner(signalStoreBase, nextOwner, {
      ...(accountSignals && typeof accountSignals === "object" && !Array.isArray(accountSignals) ? accountSignals : {}),
      ...(anonymousSignals && typeof anonymousSignals === "object" && !Array.isArray(anonymousSignals) ? anonymousSignals : {})
    });
    const anonymousOutbox = normalizeOutbox(ownerScopedValue(outboxStoreBase, previousOwner, {}));
    const accountOutbox = normalizeOutbox(ownerScopedValue(outboxStoreBase, nextOwner, {}));
    writeScopedValueForOwner(outboxStoreBase, nextOwner, {
      signals: { ...accountOutbox.signals, ...anonymousOutbox.signals },
      searches: { ...accountOutbox.searches, ...anonymousOutbox.searches }
    });
    // The anonymous namespace is now attached server-side. Remove its local
    // copy so a later logout or another account cannot inherit private data.
    removeScopedValueForOwner(sessionStoreBase, previousOwner);
    removeScopedValueForOwner(sessionTokenStoreBase, previousOwner);
    removeScopedValueForOwner(signalStoreBase, previousOwner);
    removeScopedValueForOwner(outboxStoreBase, previousOwner);
  }

  ownerStoreBase.write(nextOwner);
  return { previousOwner, nextOwner, changed: true };
}

export function readOwnerScopedSignalState() {
  const value = ownerScopedValue(signalStoreBase, getInteractionOwner(), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function writeOwnerScopedSignalState(value) {
  writeScopedValue(signalStoreBase, value && typeof value === "object" ? value : {});
}

export function removeOwnerScopedSignalState() {
  removeScopedValue(signalStoreBase);
}

export const interactionSessionStore = {
  read() {
    const value = ownerScopedValue(sessionStoreBase, getInteractionOwner(), null);
    if (!isUuid(value)) {
      if (value !== null && value !== undefined) writeScopedValue(sessionStoreBase, null);
      return null;
    }
    return String(value).toLowerCase();
  },
  readToken() {
    const value = ownerScopedValue(sessionTokenStoreBase, getInteractionOwner(), null);
    if (typeof value !== "string" || value.trim().length < 20 || value.trim().length > 256) {
      if (value !== null && value !== undefined) writeScopedValue(sessionTokenStoreBase, null);
      return null;
    }
    return value.trim();
  },
  write(value, token = null) {
    writeScopedValue(sessionStoreBase, isUuid(value) ? String(value).toLowerCase() : null);
    writeScopedValue(sessionTokenStoreBase, typeof token === "string" && token.trim().length >= 20 && token.trim().length <= 256 ? token.trim() : null);
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

export function readPendingInteractions() {
  const raw = ownerScopedValue(outboxStoreBase, getInteractionOwner(), { signals: {}, searches: {} });
  const normalized = normalizeOutbox(raw);
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) writePendingInteractions(normalized);
  return normalized;
}

function writePendingInteractions(value) {
  writeScopedValue(outboxStoreBase, normalizeOutbox(value));
}

export function queuePendingSignal(showId, { rating, watchMinutes }, mutationId = createMutationId()) {
  const normalizedRating = Number(rating);
  const normalizedWatchMinutes = Number(watchMinutes);
  if (!isValidRating(normalizedRating) || !Number.isInteger(normalizedWatchMinutes) || normalizedWatchMinutes < 0 || normalizedWatchMinutes > interactionConfig.maxWatchMinutes) {
    throw new Error("Invalid signal payload");
  }
  const outbox = readPendingInteractions();
  outbox.signals[String(showId)] = { rating: normalizedRating, watchMinutes: normalizedWatchMinutes, queuedAt: new Date().toISOString(), mutationId };
  writePendingInteractions(outbox);
  return mutationId;
}

export function acknowledgePendingSignal(showId, mutationId) {
  const outbox = readPendingInteractions();
  const key = String(showId);
  if (outbox.signals[key]?.mutationId !== mutationId) return;
  delete outbox.signals[key];
  writePendingInteractions(outbox);
}

export function queuePendingSearch({ query, resultCount, filters }, mutationId = createMutationId()) {
  const outbox = readPendingInteractions();
  outbox.searches[String(mutationId)] = { query: String(query ?? "").trim().slice(0, 200), resultCount: Math.max(0, Number(resultCount) || 0), filters: filters && typeof filters === "object" && !Array.isArray(filters) ? { ...filters } : {}, queuedAt: new Date().toISOString(), mutationId };
  writePendingInteractions(outbox);
  return mutationId;
}

export function acknowledgePendingSearch(mutationId) {
  const outbox = readPendingInteractions();
  const key = String(mutationId);
  if (!outbox.searches[key] || outbox.searches[key].mutationId !== mutationId) return;
  delete outbox.searches[key];
  writePendingInteractions(outbox);
}

export function mergeInteractionState(remoteState, localState = {}) {
  const pending = readPendingInteractions();
  const ratings = { ...(localState.ratings || {}) };
  for (const item of Array.isArray(remoteState?.ratings) ? remoteState.ratings : []) {
    const remoteRating = Number(item?.rating);
    const remoteWatchMinutes = item?.watch_minutes === null ? 0 : Number(item?.watch_minutes);
    if (!item || typeof item !== "object" || !item.show_id || !isValidRating(remoteRating) || !Number.isInteger(remoteWatchMinutes) || remoteWatchMinutes < 0 || remoteWatchMinutes > interactionConfig.maxWatchMinutes) continue;
    ratings[String(item.show_id)] = { rating: remoteRating, watchMinutes: remoteWatchMinutes, savedAt: item.rated_at };
  }
  for (const [showId, signal] of Object.entries(pending.signals)) {
    if (!signal || !isValidRating(Number(signal.rating)) || !Number.isInteger(Number(signal.watchMinutes)) || Number(signal.watchMinutes) < 0 || Number(signal.watchMinutes) > interactionConfig.maxWatchMinutes) continue;
    ratings[showId] = { rating: Number(signal.rating), watchMinutes: Number(signal.watchMinutes), savedAt: signal.queuedAt };
  }
  return { ratings };
}

function isValidRating(value) {
  return Number.isFinite(value) && value >= 0 && value <= 10 && Math.abs(value * 2 - Math.round(value * 2)) < Number.EPSILON * 100;
}

export function clearInteractionState({ preserveSession = false, clearPending = true, resetOwner = true } = {}) {
  if (!preserveSession) interactionSessionStore.write(null);
  removeOwnerScopedSignalState();
  if (clearPending) removeScopedValue(outboxStoreBase);
  legacyFavoriteStore.remove();
  legacyWatchlistStore.remove();
  if (resetOwner) ownerStoreBase.write("anonymous");
}
