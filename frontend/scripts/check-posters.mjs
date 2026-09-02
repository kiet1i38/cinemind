import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(import.meta.url), "..");
const frontendDir = resolve(scriptDir, "..");
const config = JSON.parse(await readFile(resolve(frontendDir, "config/cinemind.config.json"), "utf8"));
const catalog = JSON.parse(await readFile(resolve(frontendDir, config.catalog.outputPath), "utf8"));
const fallbackConfig = config.poster.generatedFallback;
const localFallbackPrefix = fallbackConfig.publicPath.endsWith("/") ? fallbackConfig.publicPath : `${fallbackConfig.publicPath}/`;

function localFallbackPath(record) {
  const fileName = `${String(record.id).replace(/[^a-z0-9_-]/gi, "_")}.svg`;
  return resolve(frontendDir, fallbackConfig.directory, fileName);
}

async function checkLocalFallback(record) {
  try {
    await access(localFallbackPath(record));
    return true;
  } catch {
    return false;
  }
}

async function checkRemotePoster(url) {
  let lastError = "unknown error";
  for (let attempt = 0; attempt < config.catalog.posterPreparation.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.catalog.posterPreparation.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": "CineMind poster verification" },
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") || "";
      if (response.ok && (contentType.startsWith("image/") || !contentType)) return { ok: true };
      lastError = `${response.status} ${contentType}`.trim();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt + 1 < config.catalog.posterPreparation.maxAttempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, config.catalog.posterPreparation.retryDelayMs * (attempt + 1)));
    }
  }
  return { ok: false, error: lastError };
}

if (!Array.isArray(catalog) || !catalog.length) {
  console.error("Poster check failed: catalog is empty or invalid.");
  process.exit(1);
}

const missingPosterUrls = catalog.filter((record) => !record?.posterUrl);
const fallbackResults = await Promise.all(catalog.map(async (record) => ({ id: record.id, ok: await checkLocalFallback(record) })));
const missingFallbackFiles = fallbackResults.filter((result) => !result.ok).map((result) => result.id);
const publicRecords = catalog.filter((record) => record.posterKind === "public" && record.posterUrl && !record.posterUrl.startsWith(localFallbackPrefix));
const failedPublicUrls = [];
const validationBatchSize = Math.max(1, config.catalog.posterPreparation.validationBatchSize || config.catalog.posterPreparation.batchSize);

for (let index = 0; index < publicRecords.length; index += validationBatchSize) {
  const batch = publicRecords.slice(index, index + validationBatchSize);
  const results = await Promise.all(batch.map(async (record) => ({ id: record.id, result: await checkRemotePoster(record.posterUrl) })));
  results.forEach(({ id, result }) => {
    if (!result.ok) failedPublicUrls.push({ id, error: result.error });
  });
  const completed = Math.min(index + batch.length, publicRecords.length);
  if (completed === publicRecords.length || completed % (validationBatchSize * 10) === 0) {
    console.log(`Verified public poster links: ${completed}/${publicRecords.length}`);
  }
}

const report = {
  records: catalog.length,
  recordsWithPosterUrl: catalog.filter((record) => Boolean(record?.posterUrl)).length,
  publicPosterRecords: publicRecords.length,
  generatedFallbackRecords: catalog.filter((record) => record.posterKind === "generated").length,
  missingPosterUrls: missingPosterUrls.map((record) => record.id),
  fallbackFiles: catalog.length - missingFallbackFiles.length,
  missingFallbackFiles,
  failedPublicUrls,
  allRecordsHaveLocalFallback: missingFallbackFiles.length === 0,
  allRecordsHaveRenderablePoster: missingPosterUrls.length === 0 && missingFallbackFiles.length === 0
};
console.log(JSON.stringify(report, null, 2));
if (!report.allRecordsHaveRenderablePoster) process.exitCode = 1;
