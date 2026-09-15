import { appConfig, catalogConfig, resolveApiBaseUrl } from "../config/appConfig";
import { fetchWithTimeout } from "./fetchWithTimeout";

export class CatalogVersionMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogVersionMismatchError";
    this.code = "CATALOG_VERSION_MISMATCH";
  }
}

export class CatalogValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogValidationError";
    this.code = "CATALOG_INVALID";
  }
}

const CONTENT_TYPES = new Set(catalogConfig.types.map((option) => option.value));
const POSTER_KINDS = new Set(["public", "generated"]);
const OPTIONAL_TEXT_FIELDS = ["description", "dateAdded", "rating", "posterProvider"];
const LIST_FIELDS = ["cast", "country", "listedIn"];
const MAX_SHOW_ID_LENGTH = 32;
const catalogSourceTextByRecords = new WeakMap();

export const localCatalogProvider = {
  async getAll(signal) {
    const response = await fetchWithTimeout(
      catalogConfig.sourceUrl,
      { signal },
      appConfig.runtime?.requestTimeoutMs
    );
    if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`);
    const sourceText = await response.text();
    const records = JSON.parse(sourceText);
    if (records && typeof records === "object") catalogSourceTextByRecords.set(records, sourceText);
    return records;
  }
};

export function validateCatalogRecords(records) {
  if (!Array.isArray(records)) {
    throw new CatalogValidationError("Catalog response is not an array");
  }
  if (!records.length) {
    throw new CatalogValidationError("Catalog is empty");
  }

  const ids = new Set();
  records.forEach((record, index) => {
    validateCatalogRecord(record, index);
    if (ids.has(record.id)) {
      throw new CatalogValidationError(`Catalog contains duplicate id at record ${index}`);
    }
    ids.add(record.id);
  });
  return records;
}

export function validateCatalogRecord(record, index = 0) {
  const prefix = `Catalog record ${index}`;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new CatalogValidationError(`${prefix} must be an object`);
  }
  requireText(record.id, "id", prefix, MAX_SHOW_ID_LENGTH);
  requireText(record.title, "title", prefix);
  requireText(record.type, "type", prefix);
  if (!CONTENT_TYPES.has(record.type)) {
    throw new CatalogValidationError(`${prefix}.type is unsupported`);
  }
  requireText(record.director, "director", prefix, null, true);
  OPTIONAL_TEXT_FIELDS.forEach((field) => optionalText(record[field], field, prefix));
  LIST_FIELDS.forEach((field) => listOfText(record[field], field, prefix));
  optionalSafeInteger(record.releaseYear, "releaseYear", prefix, 1888, 2100);
  optionalPositiveInteger(record.runtimeMinutes, "runtimeMinutes", prefix);
  optionalPositiveInteger(record.seasons, "seasons", prefix);

  requireText(record.posterKind, "posterKind", prefix);
  if (!POSTER_KINDS.has(record.posterKind)) {
    throw new CatalogValidationError(`${prefix}.posterKind is unsupported`);
  }
  const posterUrl = requireText(record.posterUrl, "posterUrl", prefix);
  const fallbackUrl = requireText(record.posterFallbackUrl, "posterFallbackUrl", prefix);
  if (!isSafePosterSource(posterUrl, record.posterKind) || !isSafePosterSource(fallbackUrl, "generated")) {
    throw new CatalogValidationError(`${prefix} contains an unsafe poster source`);
  }
  return record;
}

export async function loadCatalog(signal, provider = localCatalogProvider) {
  const records = validateCatalogRecords(await provider.getAll(signal));
  if (provider === localCatalogProvider) {
    await verifyCatalogVersion(records, signal, catalogSourceTextByRecords.get(records) || null);
  }
  return records;
}

async function verifyCatalogVersion(records, signal, sourceText) {
  const [manifest, summary] = await Promise.all([
    readCatalogManifest(signal),
    readCatalogSummary(signal)
  ]);

  const staticTotal = records.length;
  if (summary && Number.isInteger(summary.total) && summary.total !== staticTotal) {
    throw new CatalogVersionMismatchError(
      `Catalog version mismatch: frontend has ${staticTotal} titles but the API has ${summary.total}`
    );
  }
  if (manifest && Number.isInteger(manifest.total) && manifest.total !== staticTotal) {
    throw new CatalogVersionMismatchError(
      `Catalog manifest mismatch: manifest has ${manifest.total} titles but the file has ${staticTotal}`
    );
  }
  const staticChecksum = String(manifest?.sha256 || "").trim().toLowerCase();
  if (manifest && staticChecksum) {
    if (typeof sourceText !== "string") {
      throw new CatalogVersionMismatchError("Catalog source bytes are unavailable for checksum verification");
    }
    const actualChecksum = await sha256Text(sourceText, signal);
    if (actualChecksum && actualChecksum !== staticChecksum) {
      throw new CatalogVersionMismatchError("Catalog checksum mismatch between the file and manifest");
    }
  }
  const apiChecksum = String(summary?.source_checksum_sha256 || "").trim().toLowerCase();
  if (staticChecksum && apiChecksum && staticChecksum !== apiChecksum) {
    throw new CatalogVersionMismatchError("Catalog checksum mismatch between the frontend and API");
  }
}

async function sha256Text(sourceText, signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("The operation was aborted", "AbortError");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder === "undefined") {
    // Older HTTP webviews may not expose Web Crypto. The manifest/API count
    // and API checksum comparison still run; do not make the whole catalog
    // unusable solely because local byte hashing is unavailable.
    return null;
  }
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(sourceText));
    if (signal?.aborted) throw signal.reason || new DOMException("The operation was aborted", "AbortError");
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof CatalogVersionMismatchError) throw error;
    throw new CatalogVersionMismatchError("Catalog checksum verification failed");
  }
}

async function readCatalogManifest(signal) {
  try {
    const response = await fetchWithTimeout(
      catalogConfig.manifestUrl,
      { signal },
      appConfig.runtime?.requestTimeoutMs
    );
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || !Number.isInteger(payload.total) || !/^[a-f0-9]{64}$/iu.test(String(payload.sha256 || ""))) return null;
    return payload;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function readCatalogSummary(signal) {
  try {
    const apiBaseUrl = resolveApiBaseUrl(catalogConfig.versionCheckApiBaseUrl);
    const response = await fetchWithTimeout(
      `${apiBaseUrl.replace(/\/+$/u, "")}/summary`,
      { signal },
      appConfig.runtime?.requestTimeoutMs
    );
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && Number.isInteger(payload.total) ? payload : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    // Catalog browsing remains available when the optional version endpoint is
    // temporarily unavailable; the next load will verify it again.
    return null;
  }
}

function requireText(value, field, prefix, maxLength = null, allowBlank = false) {
  if (typeof value !== "string" || (!allowBlank && !value.trim()) || (maxLength && value.length > maxLength)) {
    throw new CatalogValidationError(`${prefix}.${field} is invalid`);
  }
  return value;
}

function optionalText(value, field, prefix) {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new CatalogValidationError(`${prefix}.${field} is invalid`);
  }
}

function listOfText(value, field, prefix) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new CatalogValidationError(`${prefix}.${field} is invalid`);
  }
}

function optionalSafeInteger(value, field, prefix, min, max) {
  if (value === null || value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CatalogValidationError(`${prefix}.${field} is invalid`);
  }
}

function optionalPositiveInteger(value, field, prefix) {
  if (value === null || value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CatalogValidationError(`${prefix}.${field} is invalid`);
  }
}

function isSafePosterSource(value, kind) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (kind === "public") return /^https?:\/\//iu.test(value);
  return /^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.(?:svg|png|jpg|jpeg|webp)$/iu.test(value);
}
