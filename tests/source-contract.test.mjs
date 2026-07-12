import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const background = await readFile(new URL("../src/background.ts", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.ts", import.meta.url), "utf8");
const inject = await readFile(new URL("../src/inject.ts", import.meta.url), "utf8");
const popup = await readFile(new URL("../src/popup/popup.ts", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const tsconfig = JSON.parse(await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"));

function reservedSlugs(source) {
  const match = source.match(/const RESERVED_TOP_SLUGS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "reserved slug list is present");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

test("popup and content scripts agree on reserved SoundCloud routes", () => {
  assert.deepEqual(reservedSlugs(popup), reservedSlugs(content));
  assert.ok(popup.includes('hostname !== "soundcloud.com" && !hostname.endsWith(".soundcloud.com")'));
});

test("critical playback fallbacks and end signals remain present", () => {
  for (const required of [
    'audio.addEventListener("ended"',
    "progress >= 0.97",
    "audioDuration - audioTime <= 0.35",
    "remainingSec !== null && remainingSec <= 0.22",
    'evaluateEnd("observer")',
    'evaluateEnd("poller")',
    'sendToBackground({ type: "TRACK_FINISHED" })',
  ]) {
    assert.ok(content.includes(required), `missing protected content behavior: ${required}`);
  }

  for (const required of [
    "tryPlayViaContentNavigation",
    "Navigate through native page DOM",
    "shouldIgnoreTrackFinished",
  ]) {
    assert.ok(background.includes(required), `missing protected background behavior: ${required}`);
  }

  assert.equal(background.includes("chrome.tabs.update"), false, "background never reloads the SoundCloud tab");
  assert.equal(inject.includes("window.location.href ="), false, "main-world navigation never hard reloads");
  assert.ok(content.includes("getModernTrackPageButton"));
  assert.ok(inject.includes("getModernTrackPageButton"));
  assert.ok(inject.includes("playThroughSoundCloudManager"));
  assert.ok(inject.includes("manager.playSource"));
  assert.ok(inject.includes("SoundModel.resolve"));
});

test("mutation bursts are coalesced without removing the safety poll", () => {
  assert.ok(content.includes("function scheduleObserverMaintenance()"));
  assert.ok(content.includes("window.requestAnimationFrame"));
  assert.ok(content.includes("if (observerMaintenanceFrame) return"));
  assert.ok(content.includes("}, 1000);"), "one-second safety poll remains present");
});

test("manifest and compiler retain the hardened boundaries", () => {
  assert.deepEqual(manifest.permissions, ["storage", "cookies", "webRequest"]);
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noImplicitAny, true);
  assert.equal(tsconfig.compilerOptions.noUnusedLocals, true);
  assert.equal(tsconfig.compilerOptions.noUnusedParameters, true);
});
