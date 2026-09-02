import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Resolver } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const configPath = resolve(frontendDir, "config/cinemind.config.json");
const projectConfig = JSON.parse(await readFile(configPath, "utf8"));
const { catalog: catalogConfig } = projectConfig;
const posterConfig = catalogConfig.posterPreparation;
const generatedPosterConfig = projectConfig.poster.generatedFallback;
const sourcePath = resolve(frontendDir, catalogConfig.sourcePath);
const outputPath = resolve(frontendDir, catalogConfig.outputPath);
const cachePath = resolve(frontendDir, posterConfig.cachePath);
const generatedPosterDir = resolve(frontendDir, generatedPosterConfig.directory);
const movieType = catalogConfig.types.find((option) => option.key === "movie")?.value;

async function readEnvFile(path) {
  try {
    const text = await readFile(path, "utf8");
    return Object.fromEntries(text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.startsWith("export ") ? line.slice(7).trim() : line)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) return ["", ""];
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/u, "$2");
        return [key, value];
      })
      .filter(([key]) => key));
  } catch {
    return {};
  }
}

const environment = {
  ...(await readEnvFile(resolve(frontendDir, ".env"))),
  ...(await readEnvFile(resolve(frontendDir, ".env.local"))),
  ...process.env
};
const tmdbConfig = posterConfig.tmdb;
const tvmazeConfig = posterConfig.tvmaze;
const tmdbReadAccessToken = String(environment.TMDB_READ_ACCESS_TOKEN ?? "").trim();
const tmdbApiKey = String(environment.TMDB_API_KEY ?? "").trim();
const hasTmdbCredentials = Boolean(tmdbReadAccessToken || tmdbApiKey);
const tmdbResolver = new Resolver();
tmdbResolver.setServers(["1.1.1.1"]);
const tmdbHttpsAgent = new Agent({
  keepAlive: true,
  maxSockets: Math.max(8, Number(tmdbConfig.batchSize || 8) * 2),
  maxFreeSockets: Math.max(4, Number(tmdbConfig.batchSize || 8))
});
let tmdbAddressCache = { expiresAt: 0, addresses: [] };

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift().map((header) => header.trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, (values[index] ?? "").trim()])));
}

function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();
}

function normalizeWords(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost
      );
      diagonal = above;
    }
  }

  return previous[right.length];
}

function titleSimilarity(left, right) {
  const normalizedLeft = normalizeTitle(left);
  const normalizedRight = normalizeTitle(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const editScore = 1 - levenshtein(normalizedLeft, normalizedRight) / Math.max(normalizedLeft.length, normalizedRight.length);
  const leftWords = new Set(normalizeWords(left));
  const rightWords = new Set(normalizeWords(right));
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = new Set([...leftWords, ...rightWords]).size;
  const tokenScore = union ? intersection / union : 0;
  return Math.max(editScore, tokenScore);
}

function candidateTypeScore(candidateType, rowType) {
  const type = String(candidateType ?? "").toLocaleLowerCase();
  if (!type) return 0.35;

  if (rowType === movieType) {
    if (type === "feature" || type === "movie" || type === "documentary" || type === "short" || type === "video") return 1;
    if (type.includes("tv movie") || type.includes("tv special")) return 0.8;
    return type.includes("tv") ? 0.1 : 0.55;
  }

  return type.includes("tv") ? 1 : 0.1;
}

function candidateYearScore(candidateYear, releaseYear) {
  const year = toNumber(candidateYear);
  if (!year || !releaseYear) return 0.35;

  const difference = Math.abs(year - releaseYear);
  if (difference === 0) return 1;
  if (difference <= posterConfig.yearTolerance) return 0.8;
  if (difference <= posterConfig.yearTolerance + 2) return 0.4;
  return 0;
}

function tmdbCandidateTitle(candidate) {
  return candidate?.title || candidate?.name || "";
}

function tmdbCandidateYear(candidate, rowType) {
  const candidateIsMovie = candidate?.media_type ? candidate.media_type === "movie" : rowType === movieType;
  const date = candidateIsMovie ? candidate?.release_date : candidate?.first_air_date;
  return toNumber(String(date ?? "").slice(0, 4));
}

function tmdbSearchVariants(title) {
  const variants = [title];
  const withoutParenthetical = title.replace(/\s*[\(\[].*?[\)\]]/gu, " ").replace(/\s+/g, " ").trim();
  if (withoutParenthetical && withoutParenthetical !== title) variants.push(withoutParenthetical);
  const punctuationNormalized = title.replace(/[|:]+/gu, " ").replace(/\s+/g, " ").trim();
  if (punctuationNormalized && !variants.includes(punctuationNormalized)) variants.push(punctuationNormalized);
  return variants;
}

function chooseTmdbCandidate(row, candidates, { allowTypeMismatch = false, allowTranslated = false, queryTitle = row.title, requirePoster = true } = {}) {
  const expectedMediaType = row.type === movieType ? "movie" : "tv";
  const compatibleCandidates = candidates.filter((candidate) => !candidate?.media_type || candidate.media_type === expectedMediaType);
  const candidatePool = compatibleCandidates.length ? compatibleCandidates : allowTypeMismatch
    ? candidates.filter((candidate) => candidate?.media_type === "movie" || candidate?.media_type === "tv")
    : [];
  const releaseYear = toNumber(row.releaseYear ?? row.release_year);
  const scoredCandidates = candidatePool
    .filter((candidate) => !requirePoster || candidate?.poster_path)
    .map((candidate, index) => {
      const titleScore = titleSimilarity(queryTitle, tmdbCandidateTitle(candidate));
      const yearScore = candidateYearScore(tmdbCandidateYear(candidate, row.type), releaseYear);
      return {
        candidate,
        index,
        titleScore,
        yearScore,
        score: titleScore * 6 + yearScore * 3 + Math.max(0, 1 - index / Math.max(candidatePool.length, 1)) * 0.2
      };
    })
    .sort((left, right) => right.score - left.score);

  const best = scoredCandidates[0];
  if (!best) return null;

  const exactTitle = best.titleScore === 1;
  const exactTopHit = exactTitle && best.index === 0;
  const strongTitle = best.titleScore >= posterConfig.fuzzyMatchThreshold;
  const reliableYear = best.yearScore >= 0.8;
  const onlyRelevantSearchHit = best.index === 0 && best.titleScore >= posterConfig.fuzzyMatchThreshold && best.yearScore >= 0.4;
  const translatedTopYearHit = allowTranslated && best.index === 0 && reliableYear;
  if (!((exactTitle && (reliableYear || exactTopHit || !releaseYear)) || (strongTitle && reliableYear) || onlyRelevantSearchHit || translatedTopYearHit)) return null;

  const posterPath = String(best.candidate.poster_path ?? "").replace(/^\/+/, "");
  return {
    posterUrl: posterPath ? `${tmdbConfig.imageBaseUrl.replace(/\/+$/u, "")}/${posterPath}` : null,
    posterProvider: "TMDB",
    tmdbId: best.candidate.id || null,
    tmdbMediaType: best.candidate.media_type || expectedMediaType,
    matchTitle: tmdbCandidateTitle(best.candidate) || null,
    matchYear: tmdbCandidateYear(best.candidate, row.type),
    matchScore: Number(best.score.toFixed(4)),
    matchMethod: exactTitle ? (reliableYear ? "exact" : "exact-title") : translatedTopYearHit ? "translated-year" : onlyRelevantSearchHit ? "top-year-type" : "fuzzy"
  };
}

async function fetchTmdbImageFallback(row, candidateMatch) {
  if (!candidateMatch?.tmdbId || candidateMatch.posterUrl || !hasTmdbCredentials) return null;

  const mediaType = candidateMatch.tmdbMediaType || (row.type === movieType ? "movie" : "tv");
  const endpoint = `${tmdbConfig.apiBaseUrl.replace(/\/+$/u, "")}/${mediaType}/${candidateMatch.tmdbId}/images?include_image_language=${encodeURIComponent("en,null")}`;
  const payload = await fetchTmdbJson(endpoint, {
    Accept: "application/json",
    ...(tmdbReadAccessToken ? { Authorization: `Bearer ${tmdbReadAccessToken}` } : {})
  }, posterConfig.requestTimeoutMs);
  const posters = Array.isArray(payload?.posters) ? payload.posters : [];
  const poster = posters.find((item) => item?.file_path);
  if (!poster) return null;

  const posterPath = String(poster.file_path).replace(/^\/+/, "");
  return {
    ...candidateMatch,
    posterUrl: `${tmdbConfig.imageBaseUrl.replace(/\/+$/u, "")}/${posterPath}`,
    matchMethod: `${candidateMatch.matchMethod}-images`
  };
}

async function resolveTmdbCandidate(row, candidates, options = {}) {
  const directMatch = chooseTmdbCandidate(row, candidates, { ...options, requirePoster: true });
  if (directMatch) return directMatch;

  const candidateMatch = chooseTmdbCandidate(row, candidates, { ...options, requirePoster: false });
  return fetchTmdbImageFallback(row, candidateMatch);
}

function chooseCandidate(row, candidates) {
  const releaseYear = toNumber(row.releaseYear ?? row.release_year);
  const scoredCandidates = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      titleScore: titleSimilarity(row.title, candidate.l),
      yearScore: candidateYearScore(candidate.y, releaseYear),
      typeScore: candidateTypeScore(candidate.q, row.type)
    }))
    .filter(({ candidate }) => candidate?.i?.imageUrl)
    .map((item) => ({
      ...item,
      score: item.titleScore * 6 + item.yearScore * 3 + item.typeScore * 2 + Math.max(0, 1 - item.index / Math.max(candidates.length, 1)) * 0.2
    }))
    .sort((left, right) => right.score - left.score);

  const best = scoredCandidates[0];
  if (!best) return null;

  const exactTitle = best.titleScore === 1;
  const exactTopHit = exactTitle && best.index === 0;
  const strongTitle = best.titleScore >= posterConfig.fuzzyMatchThreshold;
  const reliableYear = best.yearScore >= 0.8;
  const reliableType = best.typeScore >= 0.8;
  const onlyRelevantSearchHit = best.index === 0 && reliableYear && reliableType;

  if ((exactTitle && reliableType && (reliableYear || exactTopHit || !row.releaseYear))
    || (strongTitle && reliableYear && reliableType)
    || onlyRelevantSearchHit) {
    return {
      posterUrl: best.candidate.i.imageUrl,
      imdbId: best.candidate.id || null,
      matchTitle: best.candidate.l || null,
      matchYear: toNumber(best.candidate.y),
      matchType: best.candidate.q || null,
      matchScore: Number(best.score.toFixed(4)),
      matchMethod: exactTitle ? (reliableYear ? "exact" : "exact-title") : onlyRelevantSearchHit ? "top-year-type" : "fuzzy"
    };
  }

  return null;
}

function toList(value) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function toNumber(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}

function dateValue(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(value, maxChars) {
  const words = String(value ?? "").split(/\s+/u).filter(Boolean);
  const lines = [];
  let line = "";

  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [String(value ?? "")];
}

function stableHash(value) {
  return String(value ?? "").split("").reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 7);
}

function generatedPosterFileName(id) {
  return `${String(id).replace(/[^a-z0-9_-]/gi, "_")}.svg`;
}

function generatedPosterUrl(id) {
  return `${generatedPosterConfig.publicPath}/${generatedPosterFileName(id)}`;
}

function generatedPosterSvg(row) {
  const palettes = generatedPosterConfig.palette;
  const palette = palettes[stableHash(row.show_id) % palettes.length];
  const gradientId = `poster-gradient-${String(row.show_id).replace(/[^a-z0-9_-]/gi, "_")}`;
  const titleLines = wrapText(row.title, generatedPosterConfig.titleMaxChars).slice(0, generatedPosterConfig.titleMaxLines);
  const titleWasTruncated = wrapText(row.title, generatedPosterConfig.titleMaxChars).length > titleLines.length;
  if (titleWasTruncated && titleLines.length) titleLines[titleLines.length - 1] = `${titleLines[titleLines.length - 1].slice(0, Math.max(generatedPosterConfig.titleMaxChars - 1, 1))}…`;
  const titleMarkup = titleLines.map((line, index) => `<text x="54" y="${520 + index * 62}" fill="${palette.foreground}" font-size="42" font-weight="700">${xmlEscape(line)}</text>`).join("");
  const genres = row.listed_in ? row.listed_in.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 2).join(" / ") : "";
  const year = row.release_year || "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${generatedPosterConfig.width}" height="${generatedPosterConfig.height}" viewBox="0 0 ${generatedPosterConfig.width} ${generatedPosterConfig.height}" role="img" aria-label="${xmlEscape(row.title)}">
  <defs>
    <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.background}" />
      <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0.48" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#${gradientId})" />
  <circle cx="520" cy="178" r="180" fill="${palette.accent}" opacity="0.14" />
  <circle cx="92" cy="770" r="220" fill="${palette.foreground}" opacity="0.05" />
  <path d="M54 112H546" stroke="${palette.foreground}" opacity="0.28" />
  <text x="54" y="78" fill="${palette.foreground}" font-family="Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="3">${xmlEscape(projectConfig.brand.name)}</text>
  <text x="54" y="160" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="16" letter-spacing="2">${xmlEscape(row.type || "")}</text>
  <text x="54" y="194" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="16">${xmlEscape(year)}</text>
  ${titleMarkup}
  <rect x="54" y="790" width="86" height="5" rx="2.5" fill="${palette.accent}" />
  <text x="54" y="842" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="14">${xmlEscape(genres)}</text>
  <text x="546" y="842" text-anchor="end" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="14">${xmlEscape(row.show_id)}</text>
</svg>`;
}

function normalizeRow(row, posterEntry = null) {
  const isMovie = row.type === movieType;
  const rawDuration = row.duration || "";
  const durationNumber = toNumber(rawDuration);
  const publicPosterUrl = posterEntry?.posterUrl || null;

  return {
    id: row.show_id,
    type: row.type,
    title: row.title,
    director: row.director,
    cast: toList(row.cast).slice(0, catalogConfig.normalization.castLimit),
    country: toList(row.country).slice(0, catalogConfig.normalization.countryLimit),
    dateAdded: row.date_added,
    releaseYear: toNumber(row.release_year),
    rating: row.rating || null,
    seasons: isMovie ? null : durationNumber,
    runtimeMinutes: isMovie ? durationNumber : catalogConfig.tvEpisodeRuntimeMinutes,
    listedIn: toList(row.listed_in),
    description: row.description,
    posterUrl: publicPosterUrl || generatedPosterUrl(row.show_id),
    posterFallbackUrl: generatedPosterUrl(row.show_id),
    posterKind: publicPosterUrl ? "public" : "generated",
    posterProvider: posterEntry?.posterProvider || (publicPosterUrl ? posterConfig.provider : "Generated local fallback")
  };
}

async function fetchCandidates(queryTitle) {
  const endpoint = posterConfig.imdb.endpoint.replace("{title}", encodeURIComponent(queryTitle));
  const { maxAttempts, retryDelayMs, requestTimeoutMs } = posterConfig;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        headers: { "User-Agent": "CineMind student UI prototype" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Poster request failed with ${response.status}`);

      const payload = await response.json();
      return Array.isArray(payload.d) ? payload.d : [];
    } catch {
      if (attempt + 1 < maxAttempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }

  return [];
}

async function resolveTmdbAddresses() {
  if (tmdbAddressCache.expiresAt > Date.now() && tmdbAddressCache.addresses.length) return tmdbAddressCache.addresses;
  try {
    const addresses = await tmdbResolver.resolve4(new URL(tmdbConfig.apiBaseUrl).hostname);
    tmdbAddressCache = { addresses, expiresAt: Date.now() + 5 * 60 * 1000 };
    return addresses;
  } catch {
    return [];
  }
}

function requestJsonOverHttps(endpoint, headers, requestTimeoutMs, address = null) {
  const url = new URL(endpoint);
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: address || url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: address ? { ...headers, Host: url.hostname } : headers,
      servername: address ? url.hostname : undefined,
      agent: tmdbHttpsAgent,
      timeout: requestTimeoutMs
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolvePromise({ statusCode: response.statusCode || 0, headers: response.headers, body }));
    });
    request.on("timeout", () => request.destroy(new Error("TMDB request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function fetchTmdbJson(endpoint, headers, requestTimeoutMs) {
  const addresses = await resolveTmdbAddresses();
  const targets = addresses.length ? addresses : [null];
  for (const address of targets) {
    try {
      const response = await requestJsonOverHttps(endpoint, headers, requestTimeoutMs, address);
      if (response.statusCode >= 200 && response.statusCode < 300) return JSON.parse(response.body);
      if (response.statusCode === 429) {
        const retryAfterSeconds = Number(response.headers?.["retry-after"]);
        const retryDelay = Number.isFinite(retryAfterSeconds) ? Math.min(Math.max(retryAfterSeconds * 1000, 1000), 10000) : 2000;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelay));
      }
    } catch {
      // Try the next resolved address without exposing credentials or response data.
    }
  }
  return null;
}

async function fetchTmdbCandidates(row, queryTitle, includeYear = true, searchKind = "typed") {
  if (!hasTmdbCredentials) return [];

  const isMovie = row.type === movieType;
  const releaseYear = toNumber(row.releaseYear ?? row.release_year);
  const params = new URLSearchParams({
    query: queryTitle,
    include_adult: String(Boolean(tmdbConfig.includeAdult)),
    language: tmdbConfig.language,
    page: "1"
  });
  if (tmdbConfig.region) params.set("region", tmdbConfig.region);
  if (searchKind !== "multi" && releaseYear && includeYear) params.set(isMovie ? "year" : "first_air_date_year", String(releaseYear));
  if (!tmdbReadAccessToken) params.set("api_key", tmdbApiKey);

  const endpoint = `${tmdbConfig.apiBaseUrl.replace(/\/+$/u, "")}/search/${searchKind === "multi" ? "multi" : isMovie ? "movie" : "tv"}?${params.toString()}`;
  const { maxAttempts, retryDelayMs, requestTimeoutMs } = posterConfig;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const payload = await fetchTmdbJson(endpoint, {
        Accept: "application/json",
        ...(tmdbReadAccessToken ? { Authorization: `Bearer ${tmdbReadAccessToken}` } : {})
      }, requestTimeoutMs);
      if (payload && Array.isArray(payload.results)) return payload.results;
    } catch {
      // Retry below after the same bounded backoff used for an empty response.
    }
    if (attempt + 1 < maxAttempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs * (attempt + 1)));
  }

  return [];
}

async function lookupTmdbPoster(row) {
  const title = row.title.replace(/\s+/g, " ").trim();
  const releaseYear = toNumber(row.releaseYear ?? row.release_year);
  const queries = releaseYear ? [{ query: title, includeYear: true }, { query: title, includeYear: false }] : [{ query: title, includeYear: false }];

  for (const { query, includeYear } of queries) {
    const match = await resolveTmdbCandidate(row, await fetchTmdbCandidates(row, query, includeYear, "typed"), { queryTitle: query });
    if (match) return { ...match, query };
  }

  const variants = tmdbSearchVariants(title);
  for (const query of variants) {
    const candidates = await fetchTmdbCandidates(row, query, false, "multi");
    const match = await resolveTmdbCandidate(row, candidates, { allowTranslated: true, queryTitle: query });
    if (match) return { ...match, query, matchMethod: `multi-${match.matchMethod}` };
    const crossTypeMatch = await resolveTmdbCandidate(row, candidates, { allowTypeMismatch: true, queryTitle: query });
    if (crossTypeMatch) return { ...crossTypeMatch, query, matchMethod: `multi-cross-type-${crossTypeMatch.matchMethod}` };
  }

  return null;
}

async function fetchTvmazeCandidates(queryTitle) {
  const endpoint = tvmazeConfig.endpoint.replace("{title}", encodeURIComponent(queryTitle));
  const { maxAttempts, retryDelayMs, requestTimeoutMs } = posterConfig;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json", "User-Agent": "CineMind student UI prototype" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`TVmaze request failed with ${response.status}`);
      const payload = await response.json();
      return Array.isArray(payload) ? payload : [];
    } catch {
      if (attempt + 1 < maxAttempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  return [];
}

function chooseTvmazeCandidate(row, candidates, queryTitle) {
  const releaseYear = toNumber(row.releaseYear ?? row.release_year);
  const scoredCandidates = candidates
    .filter((candidate) => candidate?.show?.image?.[tvmazeConfig.imageKey] || candidate?.show?.image?.original)
    .map((candidate, index) => {
      const titleScore = titleSimilarity(queryTitle, candidate.show.name);
      const yearScore = candidateYearScore(String(candidate.show.premiered ?? "").slice(0, 4), releaseYear);
      return {
        candidate,
        index,
        titleScore,
        yearScore,
        score: titleScore * 6 + yearScore * 3 + Math.max(0, 1 - index / Math.max(candidates.length, 1)) * 0.2
      };
    })
    .sort((left, right) => right.score - left.score);

  const best = scoredCandidates[0];
  if (!best) return null;
  const exactTitle = best.titleScore === 1;
  const exactTopHit = exactTitle && best.index === 0;
  const strongTitle = best.titleScore >= posterConfig.fuzzyMatchThreshold;
  const reliableYear = best.yearScore >= 0.8;
  const onlyRelevantSearchHit = best.index === 0 && best.titleScore >= posterConfig.fuzzyMatchThreshold && best.yearScore >= 0.4;
  if (!((exactTitle && (reliableYear || exactTopHit || !releaseYear)) || (strongTitle && reliableYear) || onlyRelevantSearchHit)) return null;

  const imageUrl = best.candidate.show.image[tvmazeConfig.imageKey] || best.candidate.show.image.original;
  return {
    posterUrl: imageUrl.replace(/^http:/u, "https:"),
    posterProvider: "TVmaze",
    tvmazeId: best.candidate.show.id || null,
    matchTitle: best.candidate.show.name || null,
    matchYear: toNumber(String(best.candidate.show.premiered ?? "").slice(0, 4)),
    matchScore: Number(best.score.toFixed(4)),
    matchMethod: exactTitle ? (reliableYear ? "exact" : "exact-title") : onlyRelevantSearchHit ? "top-year" : "fuzzy"
  };
}

async function lookupTvmazePoster(row) {
  if (row.type === movieType) return null;
  const title = row.title.replace(/\s+/g, " ").trim();
  for (const query of tmdbSearchVariants(title)) {
    const match = chooseTvmazeCandidate(row, await fetchTvmazeCandidates(query), query);
    if (match) return { ...match, query };
  }
  return null;
}

async function lookupPoster(row) {
  const title = row.title.replace(/\s+/g, " ").trim();
  const releaseYear = toNumber(row.releaseYear ?? row.release_year);
  const queries = releaseYear ? [`${title} ${releaseYear}`, title] : [title];

  if (hasTmdbCredentials) {
    const tmdbMatch = await lookupTmdbPoster(row);
    if (tmdbMatch) return tmdbMatch;
  }

  for (const queryTitle of queries) {
    const match = chooseCandidate(row, await fetchCandidates(queryTitle));
    if (match) return { ...match, posterProvider: "IMDb", query: queryTitle };
  }

  const tvmazeMatch = await lookupTvmazePoster(row);
  if (tvmazeMatch) return tvmazeMatch;

  return {
    posterUrl: null,
    posterProvider: hasTmdbCredentials ? "TMDB" : "IMDb",
    matchMethod: "not-found",
    query: queries[0]
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function loadPosterCache() {
  const cache = new Map();
  const savedCache = await readJson(cachePath);
  const savedEntries = savedCache?.entries && typeof savedCache.entries === "object" ? savedCache.entries : {};
  Object.entries(savedEntries).forEach(([id, entry]) => {
    const isObject = entry && typeof entry === "object";
    const hasPosterField = isObject && Object.prototype.hasOwnProperty.call(entry, "posterUrl");
    if (hasPosterField) cache.set(id, entry);
  });

  const previousCatalog = await readJson(outputPath);
  if (!hasTmdbCredentials && Array.isArray(previousCatalog)) {
    previousCatalog.forEach((record) => {
      if (record?.id && record.posterUrl && record.posterKind !== "generated" && !cache.has(record.id)) {
        cache.set(record.id, {
          posterUrl: record.posterUrl,
          posterProvider: "previous-catalog",
          matchMethod: "previous-catalog"
        });
      }
    });
  }

  return cache;
}

async function writePosterCache(cache) {
  const entries = Object.fromEntries(cache);
  await writeFile(cachePath, JSON.stringify({
    provider: posterConfig.provider,
    cacheVersion: posterConfig.cacheVersion,
    generatedAt: new Date().toISOString(),
    entries
  }), "utf8");
}

const csv = await readFile(sourcePath, "utf8");
const rows = parseCsv(csv);
const eligibleRows = rows
  .filter((row) => row.title && row.release_year)
  .sort((left, right) => Number(right.release_year) - Number(left.release_year)
    || dateValue(right.date_added) - dateValue(left.date_added)
    || left.title.localeCompare(right.title));
const candidateLimit = Number.isInteger(posterConfig.candidateLimit) && posterConfig.candidateLimit > 0
  ? posterConfig.candidateLimit
  : eligibleRows.length;
const runtimeCandidateLimit = Number.parseInt(environment.CINEMIND_POSTER_LIMIT ?? "", 10);
const selectedRows = eligibleRows.slice(0, Number.isInteger(runtimeCandidateLimit) && runtimeCandidateLimit > 0
  ? Math.min(runtimeCandidateLimit, candidateLimit)
  : candidateLimit);

const posterMap = await loadPosterCache();
const retryUnresolved = /^(1|true|yes)$/iu.test(String(environment.CINEMIND_RETRY_UNRESOLVED ?? ""));
const pendingRows = selectedRows.filter((row) => {
  const cached = posterMap.get(row.show_id);
  if (!cached) return true;
  return hasTmdbCredentials && (retryUnresolved
    ? cached.posterProvider === "TMDB" && !cached.posterUrl
    : cached.posterProvider !== "TMDB");
});
const { batchSize, batchDelayMs, cacheWriteIntervalBatches, progressLogIntervalBatches } = posterConfig;
const runtimeTmdbBatchSize = Number.parseInt(environment.CINEMIND_TMDB_BATCH_SIZE ?? "", 10);
const effectiveBatchSize = hasTmdbCredentials
  ? Math.max(1, Math.min(batchSize, Number.isInteger(runtimeTmdbBatchSize) && runtimeTmdbBatchSize > 0 ? runtimeTmdbBatchSize : posterConfig.tmdb.batchSize))
  : batchSize;
const effectiveBatchDelayMs = hasTmdbCredentials ? posterConfig.tmdb.batchDelayMs : batchDelayMs;
console.log(`Poster provider mode: ${hasTmdbCredentials ? "TMDB API with IMDb and TVmaze fallback" : "IMDb public endpoint with TVmaze fallback (TMDB credentials not found)"}`);
if (retryUnresolved) console.log("Retrying cached records without a public poster URL");
console.log(`Poster enrichment target: ${selectedRows.length} records (${posterMap.size} cached, ${pendingRows.length} pending)`);

for (let index = 0; index < pendingRows.length; index += effectiveBatchSize) {
  const batch = pendingRows.slice(index, index + effectiveBatchSize);
  const results = await Promise.all(batch.map(async (row) => [row.show_id, await lookupPoster(row)]));
  results.forEach(([id, poster]) => posterMap.set(id, poster));
  const completed = Math.min(index + batch.length, pendingRows.length);
  const batchNumber = Math.ceil(completed / effectiveBatchSize);
  if (batchNumber % progressLogIntervalBatches === 0 || completed === pendingRows.length) {
    const resolved = [...posterMap.values()].filter((entry) => entry?.posterUrl).length;
    console.log(`Resolved public posters: ${completed}/${pendingRows.length}; total with URLs: ${resolved}/${selectedRows.length}`);
  }
  if (batchNumber % cacheWriteIntervalBatches === 0 || completed === pendingRows.length) await writePosterCache(posterMap);
  if (completed < pendingRows.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, effectiveBatchDelayMs));
}

if (!pendingRows.length) await writePosterCache(posterMap);
const catalog = rows.map((row) => normalizeRow(row, posterMap.get(row.show_id) || null));
await mkdir(generatedPosterDir, { recursive: true });
for (let index = 0; index < rows.length; index += 128) {
  const batch = rows.slice(index, index + 128);
  await Promise.all(batch.map((row) => writeFile(resolve(generatedPosterDir, generatedPosterFileName(row.show_id)), generatedPosterSvg(row), "utf8")));
}
await writeFile(outputPath, JSON.stringify(catalog), "utf8");
console.log(`Prepared ${catalog.length} catalog records at ${outputPath}`);
console.log(`Attached ${catalog.filter((record) => record.posterKind === "public").length} public poster URLs to the catalog`);
console.log(`Generated ${catalog.filter((record) => record.posterKind === "generated").length} data-driven local poster fallbacks`);
