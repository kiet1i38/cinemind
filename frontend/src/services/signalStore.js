import { appConfig } from "../config/appConfig";
import { createJsonStore } from "./browserStore";

const languageStoreBase = createJsonStore(appConfig.languages.storageKey, appConfig.languages.default);
const signalStoreBase = createJsonStore(appConfig.signals.storageKey, {});

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
    const value = signalStoreBase.read();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  },
  write(value) {
    signalStoreBase.write(value);
  }
};
