import { catalogConfig } from "../config/appConfig";

function releaseYearOf(record) {
  return Number.isFinite(record?.releaseYear) ? record.releaseYear : 0;
}

function dateAddedOf(record) {
  const timestamp = Date.parse(record?.dateAdded || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareByRecency(left, right) {
  return releaseYearOf(right) - releaseYearOf(left)
    || dateAddedOf(right) - dateAddedOf(left)
    || left.title.localeCompare(right.title);
}

function compareForDiscovery(left, right) {
  return Number(Boolean(right.posterUrl)) - Number(Boolean(left.posterUrl))
    || compareByRecency(left, right);
}

export function getDiscoverableTitles(catalog, limit = catalogConfig.displayLimits.rail) {
  return [...catalog].sort(compareForDiscovery).slice(0, limit);
}

export function getRecentTitles(catalog, limit = catalogConfig.displayLimits.rail) {
  return [...catalog].sort(compareByRecency).slice(0, limit);
}

export function getTitlesByType(catalog, type, limit = catalogConfig.displayLimits.rail) {
  return catalog.filter((record) => record.type === type).sort(compareByRecency).slice(0, limit);
}

export function getRelatedTitles(source, catalog, limit = catalogConfig.displayLimits.related) {
  if (!source) return [];
  const sourceGenres = new Set(source.listedIn || []);

  return catalog
    .filter((record) => record.id !== source.id)
    .map((record) => ({
      record,
      overlap: (record.listedIn || []).filter((genre) => sourceGenres.has(genre)).length,
      yearDistance: Math.abs(releaseYearOf(record) - releaseYearOf(source))
    }))
    .sort((left, right) => right.overlap - left.overlap
      || left.yearDistance - right.yearDistance
      || compareByRecency(left.record, right.record))
    .slice(0, limit)
    .map(({ record }) => record);
}
