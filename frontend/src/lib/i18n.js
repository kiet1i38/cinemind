import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { appConfig } from "../config/appConfig";

export const copy = { en, vi };

export function syncDocumentLanguage(language) {
  if (typeof document !== "undefined" && copy[language]) {
    document.documentElement.lang = language;
  }
}

export function translate(language, key, variables = {}) {
  const value = copy[language]?.[key] ?? copy.en[key] ?? key;
  const defaultVariables = {
    brand: appConfig.brand.name,
    catalogName: appConfig.data.catalogName,
    catalogProvider: appConfig.data.catalogProvider,
    posterProvider: appConfig.data.posterProvider,
    posterProviderLabel: appConfig.data.posterProviderLabels?.[language] ?? appConfig.data.posterProvider,
    posterAttributionLabel: appConfig.data.posterAttributionLabels?.[language] ?? appConfig.data.posterAttribution,
    posterAttribution: appConfig.data.posterAttribution
  };
  return String(value).replace(/\{(\w+)\}/g, (_, variable) => String({ ...defaultVariables, ...variables }[variable] ?? ""));
}
