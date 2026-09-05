// Client-side fallback stores for anonymous interaction state.

import { appConfig } from "../config/appConfig";
import { createJsonStore } from "./browserStore";

const interactionConfig = appConfig.interaction;
const sessionStoreBase = createJsonStore(interactionConfig.sessionStorageKey, null);
const favoriteStoreBase = createJsonStore(interactionConfig.favoritesStorageKey, []);
const watchlistStoreBase = createJsonStore(interactionConfig.watchlistStorageKey, []);

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
