import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const babel = require("@babel/core");
const presetEnv = require("@babel/preset-env");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const sourceDir = resolve(frontendDir, "src");
const originalJsLoader = require.extensions[".js"];

require.extensions[".js"] = (module, filename) => {
  if (!filename.startsWith(sourceDir)) {
    originalJsLoader(module, filename);
    return;
  }
  const source = readFileSync(filename, "utf8");
  const transformed = babel.transformSync(source, {
    filename,
    presets: [[presetEnv, { targets: { node: "current" }, modules: "commonjs" }]]
  });
  module._compile(transformed.code, filename);
};

const { loadCatalog, CatalogVersionMismatchError } = require(resolve(sourceDir, "services/catalogService.js"));

const record = {
  id: "integrity-1",
  type: "Movie",
  title: "Integrity Test",
  director: "",
  cast: [],
  country: [],
  listedIn: ["Drama"],
  description: null,
  dateAdded: null,
  rating: null,
  posterProvider: null,
  releaseYear: 2020,
  runtimeMinutes: 90,
  seasons: null,
  posterKind: "generated",
  posterUrl: "data/posters/integrity-1.svg",
  posterFallbackUrl: "data/posters/integrity-1.svg"
};

function response(body, contentType = "application/json") {
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return name.toLowerCase() === "content-type" ? contentType : null; } },
    async text() { return body; },
    async json() { return JSON.parse(body); }
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function installCatalogFetch(sourceText, checksum) {
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/catalog.json")) return response(sourceText);
    if (value.endsWith("catalog-manifest.json")) return response(JSON.stringify({ version: 1, total: 1, sha256: checksum }));
    if (value.endsWith("/api/catalog/summary")) return response(JSON.stringify({ total: 1, source_checksum_sha256: checksum }));
    throw new Error(`Unexpected catalog request: ${value}`);
  };
}

test("catalog validation hashes the exact downloaded source", { concurrency: false }, async () => {
  const sourceText = JSON.stringify([record]);
  const checksum = sha256(sourceText);
  installCatalogFetch(sourceText, checksum);
  const loaded = await loadCatalog();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, record.id);
});

test("catalog validation rejects changed content with the same row count", { concurrency: false }, async () => {
  const originalText = JSON.stringify([record]);
  const checksum = sha256(originalText);
  const changedText = JSON.stringify([{ ...record, title: "Changed Content" }]);
  installCatalogFetch(changedText, checksum);
  await assert.rejects(
    () => loadCatalog(),
    (error) => error instanceof CatalogVersionMismatchError
      && error.code === "CATALOG_VERSION_MISMATCH"
  );
});
