import { appConfig } from "../config/appConfig";
import { createJsonStore } from "./browserStore";
import {
  readOwnerScopedSignalState,
  writeOwnerScopedSignalState
} from "./interactionStore";

const languageStoreBase = createJsonStore(appConfig.languages.storageKey, appConfig.languages.default);

export const languageStore = {
  read() {
    const value = languageStoreBase.read();
    return appConfig.languages.options.some((option) => option.value === value) ? value : appConfig.languages.default;
  },
  write(value) {
    languageStoreBase.write(value);
  }
};

export const signalStore = {
  read() {
    const value = readOwnerScopedSignalState();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  },
  write(value) {
    writeOwnerScopedSignalState(value);
  }
};
