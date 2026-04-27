import { cp, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);

await mkdir(dist, { recursive: true });

await Promise.all([
  cp(new URL("manifest.json", root), new URL("manifest.json", dist)),
  cp(new URL("icons", root), new URL("icons", dist), { recursive: true }),
  cp(new URL("src/popup/popup.html", root), new URL("src/popup/popup.html", dist)),
  cp(new URL("src/popup/style.css", root), new URL("src/popup/style.css", dist)),
]);

// Keep root loading working too. Chrome/Edge users often click "Load unpacked"
// on the repository root, whose manifest intentionally points at src/*.js.
await Promise.all([
  cp(new URL("dist/src/background.js", root), new URL("src/background.js", root)),
  cp(new URL("dist/src/content.js", root), new URL("src/content.js", root)),
  cp(new URL("dist/src/inject.js", root), new URL("src/inject.js", root)),
  cp(new URL("dist/src/popup/popup.js", root), new URL("src/popup/popup.js", root)),
]);
