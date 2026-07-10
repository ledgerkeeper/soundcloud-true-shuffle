import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const generatedFiles = [
  "src/background.js",
  "src/content.js",
  "src/inject.js",
  "src/popup/popup.js",
];
const outputDir = await mkdtemp(join(tmpdir(), "soundcloud-true-shuffle-"));

try {
  await execFileAsync(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--project",
    "tsconfig.json",
    "--outDir",
    outputDir,
  ], { cwd: process.cwd() });

  const mismatches = [];
  for (const file of generatedFiles) {
    const [expected, committed] = await Promise.all([
      readFile(join(outputDir, file)),
      readFile(file),
    ]);
    if (!expected.equals(committed)) mismatches.push(file);
  }

  if (mismatches.length) {
    throw new Error(`Generated JavaScript is stale: ${mismatches.join(", ")}. Run pnpm run build.`);
  }

  console.log(`generated ok: ${generatedFiles.length} JavaScript files match TypeScript output`);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

