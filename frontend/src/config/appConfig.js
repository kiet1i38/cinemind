import rawConfig from "../../config/cinemind.config.json";

export const appConfig = rawConfig;
export const catalogConfig = appConfig.catalog;
export const signalConfig = appConfig.signals;
export const catalogTypes = Object.freeze(Object.fromEntries(catalogConfig.types.map((option) => [option.key, option.value])));
export const navigationTargets = Object.freeze(Object.fromEntries(appConfig.navigation.map((item) => [item.target, item.target])));
export const languageOptions = appConfig.languages.options;
export const typeFilterOptions = catalogConfig.types;
export const yearFilterOptions = catalogConfig.yearBuckets;

export function isMovie(record) {
  return record?.type === catalogTypes.movie;
}
