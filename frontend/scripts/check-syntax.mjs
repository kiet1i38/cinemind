import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = resolve(fileURLToPath(import.meta.url), "..");
const sourceDir = join(scriptsDir, "..", "src");
const forbiddenVisibleCharacters = /[—–]/u;

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await visit(path));
    else if ([".js", ".jsx", ".css"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const files = await visit(sourceDir);
const violations = [];
for (const path of files) {
  const content = await readFile(path, "utf8");
  if (forbiddenVisibleCharacters.test(content)) violations.push(path);
}

if (violations.length) {
  console.error("Found forbidden dash characters in:");
  violations.forEach((path) => console.error(path));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} frontend source files. No em dash or en dash characters found.`);
}
