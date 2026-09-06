// Client-side fallback stores for anonymous interaction state.

import { appConfig } from "../config/appConfig";
import { createJsonStore } from "./browserStore";

const interactionConfig = appConfig.interaction;
const signalStoreBase = createJsonStore(appConfig.signals.storageKey, {});
const sessionStoreBase = createJsonStore(interactionConfig.sessionStorageKey, null);
const ownerStoreBase = createJsonStore(interactionConfig.ownerStorageKey, "anonymous");
const favoriteStoreBase = createJsonStore(interactionConfig.favoritesStorageKey, []);
const watchlistStoreBase = createJsonStore(interactionConfig.watchlistStorageKey, []);
const outboxStoreBase = createJsonStore(interactionConfig.outboxStorageKey, () => ({
  signals: {},
  preferences: { favorites: {}, watchlist: {} }
}));

function createMutationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readIdList(store) {
  const value = store.read();
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export const interactionSessionStore = {
  read() {
    const value = sessionStoreBase.read();
    return typeof value === "string" && value.trim() ? value : null;
  },
  write(value) {
    sessionStoreBase.write(value ? String(value) : null);
  }
};

export const favoriteStore = {
  read() {
    return readIdList(favoriteStoreBase);
  },
  write(value) {
    favoriteStoreBase.write([...new Set((value || []).map(String))]);
  }
};

export const watchlistStore = {
  read() {
    return readIdList(watchlistStoreBase);
  },
  write(value) {
    watchlistStoreBase.write([...new Set((value || []).map(String))]);
  }
};

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

function normalizeOutbox(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const preferences = source.preferences && typeof source.preferences === "object" ? source.preferences : {};
  return {
    signals: source.signals && typeof source.signals === "object" ? source.signals : {},
    preferences: {
      favorites: preferences.favorites && typeof preferences.favorites === "object" ? preferences.favorites : {},
      watchlist: preferences.watchlist && typeof preferences.watchlist === "object" ? preferences.watchlist : {}
    }
  };
}

export function readPendingInteractions() {
  return normalizeOutbox(outboxStoreBase.read());
}

function writePendingInteractions(value) {
  outboxStoreBase.write(normalizeOutbox(value));
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
  const ratings = { ...(localState.ratings || {}) };
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
    const ids = new Set([
      ...(localIds || []).map(String),
      ...(remoteItems || []).map((item) => String(item.show_id))
    ]);
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

export function clearInteractionState({ preserveSession = false } = {}) {
  if (!preserveSession) interactionSessionStore.write(null);
  signalStoreBase.remove();
  favoriteStoreBase.remove();
  watchlistStoreBase.remove();
  outboxStoreBase.remove();
  ownerStoreBase.write("anonymous");
}
