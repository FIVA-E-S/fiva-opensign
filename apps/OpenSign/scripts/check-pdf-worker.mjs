import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run after `vite build`. Check the shipped output, not only a source string:
// the worker must be a separately emitted same-origin asset matching PDF.js.
const root = fileURLToPath(new URL("../", import.meta.url));
const assets = path.join(root, "build/assets");
const workerNames = fs.readdirSync(assets).filter(
  (name) => /^pdf\.worker\.min-[\w-]+\.mjs$/.test(name)
);
assert.equal(workerNames.length, 1, "The build must emit exactly one PDF.js worker");
const worker = fs.readFileSync(path.join(assets, workerNames[0]), "utf8");
const pdfjs = JSON.parse(
  fs.readFileSync(path.join(root, "node_modules/pdfjs-dist/package.json"), "utf8")
);
assert.ok(worker.includes(pdfjs.version), "Worker must match the installed PDF.js version");
const bundles = fs.readdirSync(assets)
  .filter((name) => name.endsWith(".js"))
  .map((name) => fs.readFileSync(path.join(assets, name), "utf8"));
assert.ok(
  bundles.some((bundle) => bundle.includes(workerNames[0])),
  "The application must reference the emitted worker asset"
);
assert.ok(
  !bundles.some((bundle) => /(?:unpkg\.com|cdn\.jsdelivr\.net)\/pdfjs-dist/.test(bundle)),
  "A CDN-hosted PDF.js worker must not remain in the application"
);
console.log(`PASS: bundled PDF worker ${workerNames[0]} matches PDF.js ${pdfjs.version}`);
