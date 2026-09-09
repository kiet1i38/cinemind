import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const frontendDir = resolve(scriptDir, "..");
const config = JSON.parse(await readFile(resolve(frontendDir, "config/cinemind.config.json"), "utf8"));
const catalogPath = resolve(frontendDir, config.catalog.outputPath);
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));

if (!Array.isArray(catalog) || catalog.length === 0) {
  throw new Error("Catalog must be a non-empty array");
}

const ids = new Set();
const fallbackPaths = new Set();
const errors = [];
for (const [index, record] of catalog.entries()) {
  const label = `record ${index + 1}`;
  if (!record || typeof record !== "object") {
    errors.push(`${label} is not an object`);
    continue;
  }
  if (!record.id || ids.has(record.id)) errors.push(`${label} has a missing or duplicate id`);
  ids.add(record.id);
  if (!record.title || !record.type) errors.push(`${label} is missing title/type`);
  if (record.releaseYear !== null && !Number.isSafeInteger(record.releaseYear)) {
    errors.push(`${label} has a non-integer releaseYear`);
  }
  if (!record.posterUrl || !record.posterFallbackUrl) errors.push(`${label} is missing poster URLs`);

  const fallbackPath = String(record.posterFallbackUrl || "");
  if (fallbackPaths.has(fallbackPath)) errors.push(`${label} reuses poster fallback ${fallbackPath}`);
  fallbackPaths.add(fallbackPath);
  if (fallbackPath.startsWith("data/")) {
    try {
      await stat(resolve(frontendDir, "public", fallbackPath));
    } catch {
      errors.push(`${label} references missing fallback file ${fallbackPath}`);
    }
  }
}

if (errors.length) {
  throw new Error(`Catalog validation failed:\n${errors.slice(0, 20).join("\n")}`);
}

console.log(`Catalog OK: ${catalog.length} records, ${fallbackPaths.size} unique fallback assets`);
