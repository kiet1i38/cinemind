import { appConfig, catalogConfig, isMovie, yearFilterOptions } from "../config/appConfig";
import { translate } from "./i18n";

export { loadCatalog, localCatalogProvider } from "../services/catalogService";

function normalizeSearchTerm(value) {
  return String(value || "").trim().toLowerCase();
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function getGenres(catalog) {
  return [...new Set(catalog.flatMap((record) => record.listedIn || []))].sort((left, right) => left.localeCompare(right));
}

export function matchesYear(record, year) {
  if (year === catalogConfig.allValue) return true;
  const filter = yearFilterOptions.find((option) => option.value === year);
  const releaseYear = numericValue(record?.releaseYear);
  if (!filter || releaseYear === null) return false;
  return (filter.min === undefined || releaseYear >= filter.min)
    && (filter.maxExclusive === undefined || releaseYear < filter.maxExclusive);
}

export function filterCatalog(catalog, { query = "", type = catalogConfig.allValue, genre = catalogConfig.allValue, year = catalogConfig.allValue } = {}) {
  const normalizedQuery = normalizeSearchTerm(query);
  return catalog.filter((record) => {
    const searchable = [record.title, record.director, ...(record.cast || []), ...(record.listedIn || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const queryMatches = !normalizedQuery || searchable.includes(normalizedQuery);
    const typeMatches = type === catalogConfig.allValue || record.type === type;
    const genreMatches = genre === catalogConfig.allValue || (record.listedIn || []).includes(genre);
    return queryMatches && typeMatches && genreMatches && matchesYear(record, year);
  });
}

export function getRuntimeLabel(record, language) {
  if (!record) return "";
  if (isMovie(record)) {
    const runtime = numericValue(record.runtimeMinutes);
    return runtime === null ? translate(language, "notListed") : `${runtime} ${translate(language, "minutes")}`;
  }

  const seasons = numericValue(record.seasons);
  return seasons === null
    ? translate(language, "seasonsNotListed")
    : `${seasons} ${translate(language, "seasons")}`;
}

export function getTypeLabel(record, language) {
  const option = catalogConfig.types.find((item) => item.value === record?.type);
  return option ? translate(language, option.labelKey) : record?.type || translate(language, "noData");
}

export function getRuntimeHelper(record, language) {
  if (isMovie(record)) {
    const runtime = numericValue(record.runtimeMinutes);
    return translate(language, "movieRuntimeHelper", {
      runtime: runtime === null ? translate(language, "notListed") : runtime,
      unit: translate(language, "minutes")
    });
  }

  return translate(language, "watchDurationHelperTv", {
    episodeMinutes: catalogConfig.tvEpisodeRuntimeMinutes
  });
}

export function getTitleRoutePrefix() {
  return `#${appConfig.routes.titlePrefix}`;
}

export function getRouteTitleId() {
  const prefix = getTitleRoutePrefix();
  if (!window.location.hash.startsWith(prefix)) return null;
  const encodedId = window.location.hash.slice(prefix.length);
  return encodedId ? decodeURIComponent(encodedId) : null;
}

export function openTitleRoute(id) {
  window.location.hash = `${getTitleRoutePrefix().slice(1)}${encodeURIComponent(id)}`;
}

export function closeTitleRoute() {
  if (window.location.hash) window.history.pushState({}, "", window.location.pathname + window.location.search);
}
