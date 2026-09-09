import { createJsonStore } from "./browserStore";
import {
  readOwnerScopedSignalState,
  writeOwnerScopedSignalState
} from "./interactionStore";

export const signalStore = {
  read() {
    const value = readOwnerScopedSignalState();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  },
  write(value) {
    writeOwnerScopedSignalState(value);
  }
};
