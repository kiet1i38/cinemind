import {
  deleteOwnerScopedSignal,
  replaceOwnerScopedSignalState,
  readOwnerScopedSignalState,
  restoreOwnerScopedSignal,
  writeOwnerScopedSignalState
} from "./interactionStore";

export const signalStore = {
  read() {
    const value = readOwnerScopedSignalState();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  },
  write(value) {
    writeOwnerScopedSignalState(value);
  },
  replace(value) {
    replaceOwnerScopedSignalState(value);
  },
  delete(showId, options = {}) {
    deleteOwnerScopedSignal(showId, options);
  },
  restore(showId, value) {
    restoreOwnerScopedSignal(showId, value);
  }
};
