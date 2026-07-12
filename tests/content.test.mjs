import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const compiledContent = await readFile(new URL("../src/content.js", import.meta.url), "utf8");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.parentElement = null;
    this.style = {};
    this.textContent = "";
    this.classList = {
      add: (...names) => {
        this.className = [this.className, ...names].filter(Boolean).join(" ");
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child) {
    return this.appendChild(child);
  }

  addEventListener() {}
  removeEventListener() {}
  click() { this.clickCount = (this.clickCount || 0) + 1; }
  getBoundingClientRect() {
    return this.hiddenForLayout
      ? { width: 0, height: 0 }
      : { width: 40, height: 40 };
  }
  remove() {}
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

function instrumentContent(source) {
  const closing = source.lastIndexOf("})();");
  assert.notEqual(closing, -1, "content IIFE closing marker exists");
  return `${source.slice(0, closing)}
    globalThis.__contentTestHooks = {
      evaluateEnd,
      onAudioEnded,
      scheduleObserverMaintenance,
      ensurePlayingOnce,
      getModernTrackPageButton,
      getPageTransportButton,
      normalizeTrackText,
      requestExpectedPagePlay,
      suppressUnexpectedPlaybackWhileAdvancing,
      shuffleRuntime,
      state,
    };
  ${source.slice(closing)}`;
}

function createContentHarness({ repeatEnabled = false, modernPlayer = null } = {}) {
  const messages = [];
  const nativeEvents = [];
  const animationFrames = [];
  let observerCallback = null;
  const elementsById = new Map();
  const location = {
    href: "https://soundcloud.com/test/track",
    origin: "https://soundcloud.com",
    pathname: "/test/track",
  };

  const audio = new FakeElement("audio");
  audio.currentTime = 0;
  audio.duration = 100;
  audio.currentSrc = "stream://track";
  audio.src = "stream://track";
  audio.ended = false;
  audio.paused = false;
  audio.pause = () => { audio.paused = true; };
  audio.play = () => {
    audio.paused = false;
    return Promise.resolve();
  };

  const playButton = new FakeElement("button");
  playButton.setAttribute("aria-label", "Pause");

  const modernPlayButton = modernPlayer ? new FakeElement("button") : null;
  const modernHeading = modernPlayer ? new FakeElement("h1") : null;
  const modernRoot = modernPlayer ? new FakeElement("div") : null;
  const secondaryModernPlayButton = modernPlayer?.secondaryLabel ? new FakeElement("button") : null;
  const secondaryModernHeading = modernPlayer?.secondaryLabel ? new FakeElement("h2") : null;
  const secondaryModernRoot = modernPlayer?.secondaryLabel ? new FakeElement("div") : null;
  if (modernPlayButton && modernHeading && modernRoot) {
    modernPlayButton.setAttribute("aria-label", modernPlayer.label);
    modernHeading.setAttribute("title", modernPlayer.title);
    modernHeading.textContent = modernPlayer.title;
    modernPlayButton.hiddenForLayout = modernPlayer.hidden === true;
    modernRoot.appendChild(modernPlayButton);
    modernRoot.appendChild(modernHeading);
    modernRoot.querySelector = (selector) =>
      selector.includes('button[aria-label="Play"]') ? modernPlayButton : null;
  }
  if (secondaryModernPlayButton && secondaryModernHeading && secondaryModernRoot) {
    secondaryModernPlayButton.setAttribute("aria-label", modernPlayer.secondaryLabel);
    secondaryModernHeading.setAttribute("title", modernPlayer.title);
    secondaryModernHeading.textContent = modernPlayer.title;
    secondaryModernRoot.appendChild(secondaryModernPlayButton);
    secondaryModernRoot.appendChild(secondaryModernHeading);
    secondaryModernRoot.querySelector = (selector) =>
      selector.includes('button[aria-label="Play"]') ? secondaryModernPlayButton : null;
  }

  const repeatButton = repeatEnabled ? new FakeElement("button") : null;
  if (repeatButton) {
    repeatButton.setAttribute("aria-label", "Repeat one");
    repeatButton.className = "repeatControl sc-button-selected repeatControl--one";
  }

  const head = new FakeElement("head");
  const body = new FakeElement("body");
  const registerAppend = (parent) => {
    const originalAppend = parent.appendChild.bind(parent);
    parent.appendChild = (child) => {
      if (child.id) elementsById.set(child.id, child);
      return originalAppend(child);
    };
  };
  registerAppend(head);
  registerAppend(body);

  const document = {
    body,
    head,
    documentElement: new FakeElement("html"),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => elementsById.get(id) || null,
    addEventListener() {},
    querySelector(selector) {
      if (selector === "audio") return audio;
      if (selector.includes("repeatControl") || selector.includes('aria-label*="Repeat"')) return repeatButton;
      if (selector.includes("playControl") || selector.includes('aria-label^="Play"')) return playButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("h1[title]") && modernHeading) {
        return [modernHeading, secondaryModernHeading].filter(Boolean);
      }
      return [];
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe() {}
  }

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        callback?.({ isShuffling: false, isActiveTab: true });
      },
    },
  };

  const window = {
    location,
    navigator: { mediaSession: { metadata: null } },
    setTimeout,
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    dispatchEvent(event) {
      nativeEvents.push(event);
      return true;
    },
  };

  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const context = vm.createContext({
    URL,
    chrome,
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: FakeCustomEvent,
    Element: FakeElement,
    Event: class {},
    MouseEvent: class {},
    MutationObserver: FakeMutationObserver,
    clearTimeout,
    document,
    history: { pushState() {} },
    location,
    setInterval: () => 1,
    setTimeout,
    structuredClone,
    window,
  });
  vm.runInContext(instrumentContent(compiledContent), context, { filename: "src/content.js" });

  return {
    animationFrames,
    audio,
    hooks: context.__contentTestHooks,
    messages,
    nativeEvents,
    modernPlayButton,
    secondaryModernPlayButton,
    observerCallback: () => observerCallback?.([], null),
  };
}

test("audio end reports once and keeps the duplicate-advance guard", () => {
  const harness = createContentHarness();
  harness.hooks.shuffleRuntime.isShuffling = true;

  harness.hooks.onAudioEnded();
  harness.hooks.onAudioEnded();

  assert.deepEqual(
    harness.messages.filter((message) => message.type === "TRACK_FINISHED"),
    [{ type: "TRACK_FINISHED" }],
  );
  assert.equal(harness.hooks.state.endedReported, true);
});

test("native repeat-one still suppresses shuffle advancement", () => {
  const harness = createContentHarness({ repeatEnabled: true });
  harness.hooks.shuffleRuntime.isShuffling = true;

  harness.hooks.onAudioEnded();

  assert.equal(
    harness.messages.some((message) => message.type === "TRACK_FINISHED"),
    false,
  );
  assert.equal(harness.hooks.state.endedReported, false);
});

test("the near-end detector executes its preemptive threshold only once", () => {
  const harness = createContentHarness();
  harness.hooks.shuffleRuntime.isShuffling = true;
  harness.audio.currentTime = 99.8;

  harness.hooks.evaluateEnd("test");
  harness.hooks.evaluateEnd("test");

  assert.deepEqual(
    harness.messages.filter((message) => message.type === "TRACK_FINISHED"),
    [{ type: "TRACK_FINISHED" }],
  );
});

test("mutation bursts execute at most one maintenance frame at a time", () => {
  const harness = createContentHarness();

  harness.observerCallback();
  harness.observerCallback();
  harness.observerCallback();
  assert.equal(harness.animationFrames.length, 1);

  harness.animationFrames[0]();
  harness.observerCallback();
  assert.equal(harness.animationFrames.length, 2);
});

test("the new MUI track-page Pause button confirms native playback", () => {
  const harness = createContentHarness({
    modernPlayer: { label: "Pause", title: "металл" },
  });
  harness.audio.paused = true;

  assert.equal(
    harness.hooks.getModernTrackPageButton("металл"),
    harness.modernPlayButton,
  );
  assert.equal(
    harness.hooks.getPageTransportButton("https://soundcloud.com/test/track", "металл"),
    harness.modernPlayButton,
  );
  assert.equal(
    harness.hooks.ensurePlayingOnce("https://soundcloud.com/test/track", "металл"),
    true,
  );

  harness.hooks.shuffleRuntime.isShuffling = true;
  harness.hooks.state.pendingAdvanceUntil = Date.now() + 6000;
  harness.hooks.state.pendingExpectedUrl = "https://soundcloud.com/test/track";
  harness.hooks.state.pendingExpectedTitle = "металл";
  harness.hooks.suppressUnexpectedPlaybackWhileAdvancing();
  assert.equal(harness.hooks.state.pendingAdvanceUntil, 0);
});

test("modern player delegates playback to the main-world bridge and ignores bidi controls", () => {
  const harness = createContentHarness({
    modernPlayer: { label: "Play", title: "yuiseven\u202e" },
  });
  harness.audio.paused = true;

  assert.equal(harness.hooks.normalizeTrackText("yuiseven\u202e"), "yuiseven");
  assert.equal(
    harness.hooks.getModernTrackPageButton("yuiseven"),
    harness.modernPlayButton,
  );
  assert.equal(
    harness.hooks.requestExpectedPagePlay(
      "https://soundcloud.com/test/track",
      "test",
      "yuiseven",
    ),
    true,
  );
  assert.equal(harness.modernPlayButton.clickCount, undefined);
  assert.equal(harness.audio.paused, true);
  assert.equal(harness.nativeEvents.at(-1).type, "SC_SHUFFLE_PAGE_PLAY");
  assert.equal(harness.nativeEvents.at(-1).detail.url, "https://soundcloud.com/test/track");
  assert.equal(harness.nativeEvents.at(-1).detail.title, "yuiseven");
});

test("modern player picks the visible responsive Track header copy", () => {
  const harness = createContentHarness({
    modernPlayer: {
      label: "Play",
      secondaryLabel: "Play",
      title: "love @me",
      hidden: true,
    },
  });

  assert.equal(
    harness.hooks.getModernTrackPageButton("love @me"),
    harness.secondaryModernPlayButton,
  );
});
