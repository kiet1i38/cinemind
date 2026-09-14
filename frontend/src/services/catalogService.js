import { catalogConfig, resolveApiBaseUrl } from "../config/appConfig";

export class CatalogVersionMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogVersionMismatchError";
    this.code = "CATALOG_VERSION_MISMATCH";
  }
}

export const localCatalogProvider = {
  async getAll(signal) {
    const response = await fetch(catalogConfig.sourceUrl, { signal });
    if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`);
    return response.json();
  }
};

export async function loadCatalog(signal, provider = localCatalogProvider) {
  const records = await provider.getAll(signal);
  if (!Array.isArray(records)) throw new Error("Catalog response is not an array");

  const validRecords = records.filter((record) => record?.id && record?.title);
  if (!validRecords.length) throw new Error("Catalog is empty");
  if (provider === localCatalogProvider) await verifyCatalogVersion(validRecords, signal);
  return validRecords;
}

async function verifyCatalogVersion(records, signal) {
  const [manifest, summary] = await Promise.all([
    readCatalogManifest(signal),
    readCatalogSummary(signal)
  ]);
  if (!summary) return;

  const staticTotal = records.length;
  if (Number.isInteger(summary.total) && summary.total !== staticTotal) {
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
  const apiChecksum = String(summary.source_checksum_sha256 || "").trim().toLowerCase();
  if (staticChecksum && apiChecksum && staticChecksum !== apiChecksum) {
    throw new CatalogVersionMismatchError("Catalog checksum mismatch between the frontend and API");
  }
}

async function readCatalogManifest(signal) {
  try {
    const response = await fetch(catalogConfig.manifestUrl, { signal });
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
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/u, "")}/summary`, { signal });
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
