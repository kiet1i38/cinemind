import rawConfig from "../../config/cinemind.config.json";

export const appConfig = rawConfig;
export const runtimeConfig = appConfig.runtime;
export const catalogConfig = appConfig.catalog;
export const signalConfig = {
  ...appConfig.signals,
  watchMinutes: {
    ...appConfig.signals.watchMinutes,
    max: appConfig.interaction.maxWatchMinutes
  }
};
export const authConfig = appConfig.auth;
export const catalogTypes = Object.freeze(Object.fromEntries(catalogConfig.types.map((option) => [option.key, option.value])));
export const navigationTargets = Object.freeze(Object.fromEntries(appConfig.navigation.map((item) => [item.target, item.target])));
export const languageOptions = appConfig.languages.options;
export const typeFilterOptions = catalogConfig.types;

export function resolveApiBaseUrl(baseUrl) {
  if (typeof window === "undefined" || !runtimeConfig?.frontendPathPrefix || !runtimeConfig?.apiPathPrefix) return baseUrl;
  const currentPath = window.location.pathname || "/";
  if (!currentPath.startsWith(runtimeConfig.frontendPathPrefix)) return baseUrl;
  return `${runtimeConfig.apiPathPrefix}${baseUrl}`;
}
export const yearFilterOptions = catalogConfig.yearBuckets;

export function isMovie(record) {
  return record?.type === catalogTypes.movie;
}
