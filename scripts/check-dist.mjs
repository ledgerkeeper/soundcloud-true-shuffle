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

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const rootManifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (manifest.version !== packageJson.version || rootManifest.version !== packageJson.version) {
  throw new Error(
    `Version mismatch: package=${packageJson.version}, root manifest=${rootManifest.version}, dist manifest=${manifest.version}`
  );
}

const contentMismatches = [];
for (const file of requiredFiles) {
  const [rootContent, distContent] = await Promise.all([
    readFile(file),
    readFile(join("dist", file)),
  ]);
  if (!rootContent.equals(distContent)) contentMismatches.push(file);
}
if (contentMismatches.length) {
  throw new Error(`Root/dist content mismatch: ${contentMismatches.join(", ")}`);
}

console.log(
  `root/dist ok: ${requiredFiles.length} identical required files, ` +
  `${manifestReferences.length} manifest references, version ${packageJson.version}`
);
