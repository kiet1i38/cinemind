// Owner-scoped client fallback stores for interaction state.

import { appConfig } from "../config/appConfig";
import { createJsonStore } from "./browserStore";

const interactionConfig = appConfig.interaction;
const ownerStoreBase = createJsonStore(interactionConfig.ownerStorageKey, "anonymous");
const sessionStoreBase = createJsonStore(interactionConfig.sessionStorageKey, null);
const sessionTokenStoreBase = createJsonStore(`${interactionConfig.sessionStorageKey}:token`, null);
const signalStoreBase = createJsonStore(appConfig.signals.storageKey, {});
const favoriteStoreBase = createJsonStore(interactionConfig.favoritesStorageKey, []);
const watchlistStoreBase = createJsonStore(interactionConfig.watchlistStorageKey, []);
const outboxStoreBase = createJsonStore(interactionConfig.outboxStorageKey, () => ({
  signals: {},
  preferences: { favorites: {}, watchlist: {} }
}));

export function getInteractionOwner() {
  const owner = ownerStoreBase.read();
  return typeof owner === "string" && owner.trim() ? owner : "anonymous";
}

export function setInteractionOwner(userId) {
  const nextOwner = userId ? String(userId) : "anonymous";
  const previousOwner = getInteractionOwner();
  ownerStoreBase.write(nextOwner);
  return { previousOwner, nextOwner, changed: previousOwner !== nextOwner };
}

function scopedValue(store, fallback) {
  const raw = store.read();
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners) {
    const owner = getInteractionOwner();
    return Object.prototype.hasOwnProperty.call(raw.owners, owner) ? raw.owners[owner] : fallback;
  }
  if (raw !== null && raw !== undefined) {
    writeScopedValue(store, raw);
    return raw;
  }
  return fallback;
}

function writeScopedValue(store, value) {
  const raw = store.read();
  const owners = raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners
    ? { ...raw.owners }
    : {};
  owners[getInteractionOwner()] = value;
  store.write({ version: 2, owners });
}

function removeScopedValue(store) {
  const raw = store.read();
  if (!(raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners)) {
    store.remove();
    return;
  }
  const owners = { ...raw.owners };
  delete owners[getInteractionOwner()];
  store.write({ version: 2, owners });
}

export function readOwnerScopedSignalState() {
  return scopedValue(signalStoreBase, {});
}

export function writeOwnerScopedSignalState(value) {
  writeScopedValue(signalStoreBase, value && typeof value === "object" ? value : {});
}

export function removeOwnerScopedSignalState() {
  removeScopedValue(signalStoreBase);
}

export const interactionSessionStore = {
  read() {
    const value = scopedValue(sessionStoreBase, null);
    return typeof value === "string" && value.trim() ? value : null;
  },
  readToken() {
    const value = scopedValue(sessionTokenStoreBase, null);
    return typeof value === "string" && value.trim() ? value : null;
  },
  write(value, token = null) {
    writeScopedValue(sessionStoreBase, value ? String(value) : null);
    writeScopedValue(sessionTokenStoreBase, token ? String(token) : null);
  }
};

function readIdList(store) {
  const value = scopedValue(store, []);
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export const favoriteStore = {
  read() {
    return readIdList(favoriteStoreBase);
  },
  write(value) {
    writeScopedValue(favoriteStoreBase, [...new Set((value || []).map(String))]);
  }
};

export const watchlistStore = {
  read() {
    return readIdList(watchlistStoreBase);
  },
  write(value) {
    writeScopedValue(watchlistStoreBase, [...new Set((value || []).map(String))]);
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

function normalizeOutbox(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const preferences = source.preferences && typeof source.preferences === "object" ? source.preferences : {};
  return {
    signals: source.signals && typeof source.signals === "object" ? source.signals : {},
    searches: source.searches && typeof source.searches === "object" ? source.searches : {},
    preferences: {
      favorites: preferences.favorites && typeof preferences.favorites === "object" ? preferences.favorites : {},
      watchlist: preferences.watchlist && typeof preferences.watchlist === "object" ? preferences.watchlist : {}
    }
  };
}

export function readPendingInteractions() {
  return normalizeOutbox(scopedValue(outboxStoreBase, {
    signals: {},
    searches: {},
    preferences: { favorites: {}, watchlist: {} }
  }));
}

function writePendingInteractions(value) {
  writeScopedValue(outboxStoreBase, normalizeOutbox(value));
}

export function queuePendingSignal(showId, { rating, watchMinutes }, mutationId = createMutationId()) {
  const outbox = readPendingInteractions();
  const key = String(showId);
  outbox.signals[key] = {
    rating: Number(rating),
    watchMinutes: Number(watchMinutes),
    queuedAt: new Date().toISOString(),
    mutationId
  };
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

export function queuePendingSearch(
  { query, resultCount, filters },
  mutationId = createMutationId()
) {
  const outbox = readPendingInteractions();
  const key = String(mutationId);
  outbox.searches[key] = {
    query: String(query ?? ""),
    resultCount: Number(resultCount),
    filters: filters && typeof filters === "object" && !Array.isArray(filters) ? { ...filters } : {},
    queuedAt: new Date().toISOString(),
    mutationId
  };
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

export function queuePendingPreference(kind, showId, active, mutationId = createMutationId()) {
  const outbox = readPendingInteractions();
  const key = String(showId);
  if (!outbox.preferences[kind]) outbox.preferences[kind] = {};
  outbox.preferences[kind][key] = {
    active: Boolean(active),
    queuedAt: new Date().toISOString(),
    mutationId
  };
  writePendingInteractions(outbox);
  return mutationId;
}

export function acknowledgePendingPreference(kind, showId, mutationId) {
  const outbox = readPendingInteractions();
  const key = String(showId);
  if (outbox.preferences[kind]?.[key]?.mutationId !== mutationId) return;
  delete outbox.preferences[kind][key];
  writePendingInteractions(outbox);
}

export function mergeInteractionState(remoteState, localState = {}) {
  const pending = readPendingInteractions();
  const hasRemoteState = Boolean(remoteState && typeof remoteState === "object");
  const ratings = hasRemoteState ? {} : { ...(localState.ratings || {}) };
  for (const item of remoteState?.ratings || []) {
    ratings[String(item.show_id)] = {
      rating: Number(item.rating),
      watchMinutes: item.watch_minutes === null ? 0 : Number(item.watch_minutes),
      savedAt: item.rated_at
    };
  }
  for (const [showId, signal] of Object.entries(pending.signals)) {
    ratings[showId] = {
      rating: signal.rating,
      watchMinutes: signal.watchMinutes,
      savedAt: signal.queuedAt
    };
  }

  const mergeIds = (localIds, remoteItems, pendingPreferences) => {
    const sourceIds = hasRemoteState && Array.isArray(remoteItems)
      ? remoteItems.map((item) => String(item.show_id))
      : (localIds || []).map(String);
    const ids = new Set(sourceIds);
    for (const [showId, preference] of Object.entries(pendingPreferences || {})) {
      if (preference.active) ids.add(showId);
      else ids.delete(showId);
    }
    return [...ids];
  };

  return {
    ratings,
    favorites: mergeIds(localState.favorites, remoteState?.favorites, pending.preferences.favorites),
    watchlist_items: mergeIds(localState.watchlist, remoteState?.watchlist_items, pending.preferences.watchlist)
  };
}

export function clearInteractionState({ preserveSession = false, clearPending = true, resetOwner = true } = {}) {
  if (!preserveSession) interactionSessionStore.write(null);
  removeOwnerScopedSignalState();
  removeScopedValue(favoriteStoreBase);
  removeScopedValue(watchlistStoreBase);
  if (clearPending) removeScopedValue(outboxStoreBase);
  if (resetOwner) ownerStoreBase.write("anonymous");
}
