import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(import.meta.url), "..");
const frontendDir = resolve(scriptDir, "..");
const sourceRoot = resolve(frontendDir, "src");
const interactionServicePath = resolve(sourceRoot, "services/interactionService.js");
const nginxConfigPath = resolve(frontendDir, "nginx.conf");

const rules = [
  { file: "App.jsx", pattern: /preferredOrder|fallbackCatalog|cinemind-(?:language|ratings)|slice\(0,\s*(?:12|60)\)/u, message: "App must consume configuration and services instead of owning catalog constants." },
  { file: "components/FilterBar.jsx", pattern: /value=["'](?:Movie|TV Show|2020s|2010s|before2010|all)["']/u, message: "Filter options must come from catalog configuration." },
  { file: "components/RatingModal.jsx", pattern: /(?:min|max|step)=["'](?:0|10|0\.5|1)["']/u, message: "Signal constraints must come from signal configuration." },
  { file: "components/PosterImage.jsx", pattern: /poster-tone-[a-d]|(?:FILM|SERIES)|type === ["']Movie["']/u, message: "Poster fallback labels and tones must come from configuration or localization." },
  { file: "scripts/prepare-catalog.mjs", pattern: /preferredTitles|posterAliases|runtimeMinutes\s*=\s*45/u, message: "Catalog preparation must be data-driven and use shared configuration." }
];

const violations = [];
for (const rule of rules) {
  const path = rule.file.startsWith("scripts/") ? resolve(frontendDir, rule.file) : resolve(sourceRoot, rule.file);
  const content = await readFile(path, "utf8");
  if (rule.pattern.test(content)) violations.push(`${rule.file}: ${rule.message}`);
}

const englishCopy = JSON.parse(await readFile(resolve(sourceRoot, "locales/en.json"), "utf8"));
if (!Object.keys(englishCopy).length) violations.push("locales: the English copy must not be empty.");

const interactionService = await readFile(interactionServicePath, "utf8");
if (!/changePreference\(path,\s*"(?:POST|DELETE)",\s*record,\s*\{\s*\.\.\.metadata,\s*mutationId\s*\}\)/su.test(interactionService)) {
  violations.push("services/interactionService.js: preference retries must reuse the queued mutationId.");
}

const nginxConfig = await readFile(nginxConfigPath, "utf8");
if (/\$proxy_add_x_forwarded_for/u.test(nginxConfig) || !/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/u.test(nginxConfig)) {
  violations.push("nginx.conf: the trusted proxy must overwrite X-Forwarded-For with the direct client address.");
}

try {
  await access(resolve(sourceRoot, "data/fallbackCatalog.js"));
  violations.push("src/data/fallbackCatalog.js: fake fallback catalog records should not be bundled.");
} catch {
  // Expected: the catalog fallback is represented by data-driven poster fallback UI only.
}

if (violations.length) {
  console.error("Architecture checks failed:");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log("Architecture checks passed: catalog, signal, poster, and English copy constants are centralized.");
}
