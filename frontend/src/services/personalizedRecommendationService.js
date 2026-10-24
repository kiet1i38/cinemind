import { appConfig, resolveApiBaseUrl } from "../config/appConfig";
import { fetchWithTimeout } from "./fetchWithTimeout";

const SUPPORTED_ALGORITHMS = new Set(["popularity", "content", "hybrid"]);
const SUPPORTED_LIMITS = new Set([5, 10]);

function toCatalogRecord(item, catalogById) {
  const title = item?.title || {};
  const id = String(title.show_id || "");
  const localRecord = catalogById.get(id) || {};
  const genres = Array.isArray(title.genres) ? title.genres : [];

  return {
    ...localRecord,
    id,
    title: title.title || localRecord.title || "",
    type: title.content_type || localRecord.type || "Movie",
    description: title.description ?? localRecord.description ?? "",
    releaseYear: title.release_year ?? localRecord.releaseYear ?? null,
    runtimeMinutes: title.movie_duration_min ?? localRecord.runtimeMinutes ?? null,
    seasons: title.season_count ?? localRecord.seasons ?? null,
    rating: title.content_rating ?? localRecord.rating ?? null,
    listedIn: genres.length ? genres.join(", ") : localRecord.listedIn || "",
    cast: Array.isArray(title.cast) ? title.cast : localRecord.cast || [],
    countries: Array.isArray(title.countries) ? title.countries : localRecord.countries || [],
    directors: Array.isArray(title.directors) ? title.directors : localRecord.directors || [],
    posterUrl: title.poster_url || localRecord.posterUrl || null,
    posterFallbackUrl: localRecord.posterFallbackUrl || null,
    posterKind: title.poster_status === "public" ? "public" : localRecord.posterKind || "fallback",
    recommendationScore: item?.score ?? null,
    recommendationComponentScores: item?.component_scores || {},
    recommendationReasons: Array.isArray(item?.reasons) ? item.reasons : []
  };
}

export async function getPersonalizedRecommendations({
  algorithm = "hybrid",
  limit = 10,
  catalog = [],
  signal
} = {}) {
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) throw new TypeError("Unsupported recommendation algorithm");
  if (!SUPPORTED_LIMITS.has(Number(limit))) throw new TypeError("Unsupported recommendation limit");

  const query = new URLSearchParams({ algorithm, limit: String(limit) });
  const response = await fetchWithTimeout(
    resolveApiBaseUrl(`/api/recommendations?${query.toString()}`),
    { credentials: "include", cache: "no-store", signal },
    appConfig.runtime?.requestTimeoutMs
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("Recommendations could not be loaded");
    error.status = response.status;
    error.code = payload?.detail?.code || payload?.code;
    throw error;
  }

  const catalogById = new Map(catalog.map((record) => [String(record.id), record]));
  return {
    ...payload,
    items: Array.isArray(payload?.items)
      ? payload.items.map((item) => toCatalogRecord(item, catalogById))
      : []
  };
}
