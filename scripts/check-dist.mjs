import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const requiredFiles = [
  "manifest.json",
  "src/background.js",
  "src/content.js",
  "src/inject.js",
  "src/popup/popup.html",
  "src/popup/popup.js",
  "src/popup/style.css",
  "icons/icon-16.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

await Promise.all(requiredFiles.map((file) => access(join("dist", file))));
await Promise.all(requiredFiles.map((file) => access(file)));

const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
const background = manifest?.background?.service_worker;
const contentScript = manifest?.content_scripts?.[0]?.js?.[0];
const popup = manifest?.action?.default_popup;
const injected = manifest?.web_accessible_resources?.[0]?.resources?.[0];

const manifestReferences = [background, contentScript, popup, injected].filter(Boolean);
await Promise.all(manifestReferences.map((file) => access(join("dist", file))));
await Promise.all(manifestReferences.map((file) => access(file)));

console.log(`root/dist ok: ${requiredFiles.length} required files and ${manifestReferences.length} manifest references found`);
