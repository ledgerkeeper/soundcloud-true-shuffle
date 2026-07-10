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
  click() {}
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
      shuffleRuntime,
      state,
    };
  ${source.slice(closing)}`;
}

function createContentHarness({ repeatEnabled = false } = {}) {
  const messages = [];
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

  const playButton = new FakeElement("button");
  playButton.setAttribute("aria-label", "Pause");

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
    querySelectorAll() { return []; },
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
    setTimeout,
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    dispatchEvent() {},
  };

  const context = vm.createContext({
    URL,
    chrome,
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class {},
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
