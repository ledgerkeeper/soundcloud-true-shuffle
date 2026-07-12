import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const compiledInject = await readFile(new URL("../src/inject.js", import.meta.url), "utf8");

test("main-world bridge clicks the new MUI track-page Play button", () => {
  const dispatched = [];
  const createButton = (visible, marker) => ({
    className: "MuiButton-root",
    closest() { return null; },
    getBoundingClientRect() {
      return visible ? { width: 40, height: 40 } : { width: 0, height: 0 };
    },
    dispatchEvent(event) {
      dispatched.push(event.type);
      return true;
    },
    click() { dispatched.push(`${marker}-click`); },
    focus() {},
    getAttribute(name) {
      return name === "aria-label" ? "Play" : null;
    },
  });
  const hiddenButton = createButton(false, "hidden");
  const button = createButton(true, "visible");
  Object.defineProperty(button, "__reactFiber$test", {
    value: {
      memoizedProps: {
        onClick(event) {
          assert.equal(event.currentTarget, button);
          dispatched.push("react-click");
        },
      },
    },
  });
  const createRoot = (candidate) => ({
    parentElement: null,
    querySelector(selector) {
      return selector.includes('button[aria-label="Play"]') ? candidate : null;
    },
  });
  const hiddenRoot = createRoot(hiddenButton);
  const root = createRoot(button);
  const hiddenSection = { querySelector: () => hiddenButton };
  const section = { querySelector: () => button };
  const hiddenHeading = {
    parentElement: hiddenRoot,
    closest: () => hiddenSection,
  };
  const heading = {
    parentElement: root,
    closest: () => section,
  };
  const location = {
    href: "https://soundcloud.com/yuiseven/metall",
    origin: "https://soundcloud.com",
  };
  const window = {
    history: { pushState() {} },
    location,
    addEventListener() {},
    dispatchEvent() {},
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("h1[title]")) return [hiddenHeading, heading];
      if (selector.includes('button[aria-label="Play"]')) return [hiddenButton, button];
      return [];
    },
    querySelector() { return null; },
  };

  class FakeMouseEvent {
    constructor(type) { this.type = type; }
  }

  vm.runInNewContext(compiledInject, {
    URL,
    CustomEvent: class {},
    Event: class {},
    MouseEvent: FakeMouseEvent,
    PopStateEvent: class {},
    console: { log() {} },
    document,
    window,
  }, { filename: "src/inject.js" });

  assert.equal(
    window.SCShuffleNative.clickTargetedPagePlay("https://soundcloud.com/yuiseven/metall"),
    true,
  );
  assert.deepEqual(dispatched, ["react-click"]);
});

test("main-world bridge resolves the target and starts it through SoundCloud PlayManager", async () => {
  const targetUrl = "https://soundcloud.com/vbil/16a";
  const calls = [];
  const resultEvents = [];
  const listeners = new Map();
  let currentSound = null;
  let playing = false;
  let playingChecks = 0;

  const track = {
    get(key) {
      if (key === "urn") return "soundcloud:tracks:1908281384";
      if (key === "permalink_url") return targetUrl;
      if (key === "kind") return "track";
      return null;
    },
  };

  const manager = {
    getCurrentSound() { return currentSound; },
    isPlaying() {
      playingChecks += 1;
      return playing;
    },
    playCurrent(options) {
      calls.push({ method: "playCurrent", options });
      playing = true;
    },
    playSource(source, sound, context, options) {
      calls.push({ method: "playSource", source, sound, context, options });
      currentSound = sound;
      playing = true;
    },
  };

  function SoundModel() {}
  SoundModel.prototype.resource_type = "sound";
  SoundModel.resolve = (userPermalink, soundPermalink, secretToken) => {
    calls.push({ method: "resolve", userPermalink, soundPermalink, secretToken });
    const deferred = {
      done(callback) {
        callback(track);
        return deferred;
      },
      fail() { return deferred; },
    };
    return deferred;
  };

  const layoutModule = {
    getCurrentLayoutInfo() { return { page: "track" }; },
  };
  const modules = { 20: manager, 27: SoundModel, 271: layoutModule };
  const fakeRequire = (moduleId) => modules[moduleId];
  fakeRequire.c = Object.fromEntries(
    Object.entries(modules).map(([moduleId, exports]) => [moduleId, { exports }]),
  );
  fakeRequire.m = {};

  const webpackJsonp = [];
  webpackJsonp.push = (payload) => {
    const moduleId = payload[2][0][0];
    payload[1][moduleId]({}, {}, fakeRequire);
    return 1;
  };

  const location = {
    href: targetUrl,
    origin: "https://soundcloud.com",
  };
  const window = {
    webpackJsonp,
    history: { pushState() {} },
    location,
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) {
      resultEvents.push(event);
      listeners.get(event.type)?.(event);
      return true;
    },
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
  };
  const document = {
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  vm.runInNewContext(compiledInject, {
    URL,
    CustomEvent: FakeEvent,
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    PopStateEvent: FakeEvent,
    console: { log() {} },
    document,
    setTimeout,
    clearTimeout,
    window,
  }, { filename: "src/inject.js" });

  assert.equal(await window.SCShuffleNative.playThroughSoundCloudManager(targetUrl), true);
  assert.deepEqual(calls[0], {
    method: "resolve",
    userPermalink: "vbil",
    soundPermalink: "16a",
    secretToken: undefined,
  });
  assert.equal(calls[1].method, "playSource");
  assert.equal(calls[1].source, track);
  assert.equal(calls[1].sound, track);
  assert.equal(calls[1].context.restoreUrl, targetUrl);
  assert.equal(Object.keys(calls[1].context.sourceInfo).length, 0);
  assert.equal(calls[1].context.layoutInfo.page, "track");
  assert.equal(calls[1].options.userInitiated, true);
  assert.equal(calls[1].options.seek, 0);
  assert.ok(playingChecks >= 4, "playback must remain active before the bridge reports success");

  window.dispatchEvent(new FakeEvent("SC_SHUFFLE_PAGE_PLAY", {
    detail: { url: targetUrl },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 2, "already-playing target is not restarted");
  assert.equal(resultEvents.at(-1).type, "SC_SHUFFLE_PAGE_PLAY_RESULT");
  assert.equal(resultEvents.at(-1).detail.method, "soundcloud-play-manager");
});
