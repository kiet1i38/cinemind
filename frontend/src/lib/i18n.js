import en from "../locales/en.json";
import { appConfig, appLanguage } from "../config/appConfig";

export const copy = { en };

export function syncDocumentLanguage() {
  if (typeof document !== "undefined") {
    document.documentElement.lang = appLanguage;
  }
}

export function translate(_language, key, variables = {}) {
  const value = copy.en[key] ?? key;
  const defaultVariables = {
    brand: appConfig.brand.name,
    catalogName: appConfig.data.catalogName,
    catalogProvider: appConfig.data.catalogProvider,
    posterProvider: appConfig.data.posterProvider,
    posterProviderLabel: appConfig.data.posterProviderLabels?.[appLanguage] ?? appConfig.data.posterProvider,
    posterAttributionLabel: appConfig.data.posterAttributionLabels?.[appLanguage] ?? appConfig.data.posterAttribution,
    posterAttribution: appConfig.data.posterAttribution
  };
  return String(value).replace(/\{(\w+)\}/g, (_, variable) => String({ ...defaultVariables, ...variables }[variable] ?? ""));
}
