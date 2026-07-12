import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const STATE_STORAGE_KEY = "sc_shuffle_state_v2";
const POSITION_STORAGE_KEY = "sc_shuffle_position_v1";

function createTrack(id, title = `Track ${id}`) {
  return {
    id,
    title,
    permalink_url: `https://soundcloud.com/test/track-${id}`,
    user: { username: "Tester" },
    artwork_url: `https://i1.sndcdn.com/artworks-${id}-large.jpg`,
  };
}

function createHarness({
  storage = {},
  fetchImpl,
  storageSetError = false,
  delayFirstQueueWrite = false,
  delayFirstPositionWrite = false,
  tabMessageImpl,
  backgroundSetTimeout = setTimeout,
} = {}) {
  const storageState = structuredClone(storage);
  const storageWrites = [];
  const sentTabMessages = [];
  const updatedTabs = [];
  let runtimeListener;
  let webRequestListener;
  let releaseDelayedQueueWrite = null;
  let releaseDelayedPositionWrite = null;
  let queueWriteStartedResolve;
  const queueWriteStarted = new Promise((resolve) => {
    queueWriteStartedResolve = resolve;
  });
  let queueWriteDelayed = false;
  let positionWriteStartedResolve;
  const positionWriteStarted = new Promise((resolve) => {
    positionWriteStartedResolve = resolve;
  });
  let positionWriteDelayed = false;

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
    },
    storage: {
      local: {
        get(keys, callback) {
          if (typeof keys === "string") {
            callback(Object.hasOwn(storageState, keys) ? { [keys]: storageState[keys] } : {});
            return;
          }
          callback(structuredClone(storageState));
        },
        set(items, callback) {
          storageWrites.push(structuredClone(items));
          const applyWrite = () => {
            if (
              storageSetError === "all" ||
              (storageSetError === true && Object.hasOwn(items, STATE_STORAGE_KEY))
            ) {
              chrome.runtime.lastError = { message: "simulated storage failure" };
              callback?.();
              chrome.runtime.lastError = null;
              return;
            }
            Object.assign(storageState, structuredClone(items));
            callback?.();
          };
          if (
            delayFirstQueueWrite &&
            !queueWriteDelayed &&
            Object.hasOwn(items, STATE_STORAGE_KEY)
          ) {
            queueWriteDelayed = true;
            releaseDelayedQueueWrite = applyWrite;
            queueWriteStartedResolve();
            return;
          }
          if (
            delayFirstPositionWrite &&
            !positionWriteDelayed &&
            Object.hasOwn(items, POSITION_STORAGE_KEY) &&
            !Object.hasOwn(items, STATE_STORAGE_KEY)
          ) {
            positionWriteDelayed = true;
            releaseDelayedPositionWrite = applyWrite;
            positionWriteStartedResolve();
            return;
          }
          applyWrite();
        },
      },
    },
    cookies: {
      get(_details, callback) {
        callback(null);
      },
    },
    tabs: {
      sendMessage(tabId, message, callback) {
        sentTabMessages.push({ tabId, message: structuredClone(message) });
        callback?.(tabMessageImpl ? tabMessageImpl(message, tabId) : { ok: true });
      },
      update(tabId, properties, callback) {
        updatedTabs.push({ tabId, properties: structuredClone(properties) });
        callback?.({ id: tabId, ...properties });
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener(listener) {
          webRequestListener = listener;
        },
      },
    },
  };

  const quietConsole = {
    log() {},
    warn() {},
    error() {},
  };

  vm.runInNewContext(backgroundSource, {
    AbortController,
    DOMException,
    URL,
    chrome,
    console: quietConsole,
    fetch: fetchImpl || (async () => {
      throw new Error("Unexpected fetch");
    }),
    setTimeout: backgroundSetTimeout,
    clearTimeout,
  }, { filename: "src/background.js" });

  assert.equal(typeof runtimeListener, "function", "background listener was registered");
  assert.equal(typeof webRequestListener, "function", "client-id listener was registered");

  async function send(message, tabId = 7) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No response for ${message.type}`)), 1500);
      const response = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      const keepChannelOpen = runtimeListener(message, { tab: { id: tabId } }, response);
      if (keepChannelOpen !== true) {
        clearTimeout(timeout);
        reject(new Error(`Message channel was not kept open for ${message.type}`));
      }
    });
  }

  return {
    send,
    sentTabMessages,
    storageState,
    storageWrites,
    updatedTabs,
    webRequestListener,
    queueWriteStarted,
    positionWriteStarted,
    releaseDelayedQueueWrite() {
      assert.equal(typeof releaseDelayedQueueWrite, "function", "a queue write is waiting");
      const release = releaseDelayedQueueWrite;
      releaseDelayedQueueWrite = null;
      release();
    },
    releaseDelayedPositionWrite() {
      assert.equal(typeof releaseDelayedPositionWrite, "function", "a position write is waiting");
      const release = releaseDelayedPositionWrite;
      releaseDelayedPositionWrite = null;
      release();
    },
  };
}

test("hydrates the legacy queueUrls storage shape", async () => {
  const harness = createHarness({
    storage: {
      [STATE_STORAGE_KEY]: {
        queueUrls: [
          "https://soundcloud.com/test/first-track",
          "https://soundcloud.com/test/second-track",
        ],
        currentIndex: 1,
        activeTabId: 7,
      },
    },
  });

  const queue = await harness.send({ type: "GET_QUEUE", requesterTabId: 7 });

  assert.equal(queue.ok, true);
  assert.equal(queue.count, 2);
  assert.equal(queue.currentIndex, 1);
  assert.equal(queue.currentEntry.url, "https://soundcloud.com/test/second-track");
  assert.equal(queue.currentEntry.title, "second track");
  assert.deepEqual(queue.upNextEntries, []);
});

test("only the controller tab can advance a hydrated queue", async () => {
  const harness = createHarness({
    storage: {
      [STATE_STORAGE_KEY]: {
        queueUrls: [
          "https://soundcloud.com/test/first-track",
          "https://soundcloud.com/test/second-track",
        ],
        currentIndex: 0,
        activeTabId: 7,
      },
    },
  });

  await harness.send({ type: "TRACK_FINISHED" }, 8);
  let status = await harness.send({ type: "GET_STATUS", requesterTabId: 7 });
  assert.equal(status.currentIndex, 0);

  await harness.send({ type: "TRACK_FINISHED" }, 7);
  status = await harness.send({ type: "GET_STATUS", requesterTabId: 7 });
  assert.equal(status.currentIndex, 1);
  assert.equal(Object.hasOwn(harness.storageState[STATE_STORAGE_KEY], "queueUrls"), false);
  assert.equal(harness.storageState[STATE_STORAGE_KEY].queueEntries.length, 2);
  assert.equal(harness.storageState[POSITION_STORAGE_KEY].currentIndex, 1);
  assert.deepEqual(Object.keys(harness.storageWrites.at(-1)), [POSITION_STORAGE_KEY]);
  assert.ok(
    harness.sentTabMessages.some(({ tabId, message }) =>
      tabId === 7 &&
      message.action === "NAVIGATE_AND_PLAY" &&
      message.url.endsWith("/second-track")
    ),
  );
});

test("collects paginated likes, removes duplicates, and starts playback", async () => {
  const requests = [];
  const track1 = createTrack(1, "One");
  const track2 = createTrack(2, "Two");
  const fetchImpl = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/resolve?")) {
      return { ok: true, status: 200, json: async () => ({ id: 42 }) };
    }
    if (url.includes("/users/42/track_likes")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          collection: [{ track: track1 }, { track: track1 }],
          next_href: "https://api-v2.soundcloud.com/test-next-page",
        }),
      };
    }
    if (url.includes("/test-next-page")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ collection: [{ track: track2 }], next_href: null }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const harness = createHarness({ storage: { client_id: "captured-client-id" }, fetchImpl });

  const result = await harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 2);
  assert.ok(requests.some((url) => url.includes("/test-next-page")));

  const queue = await harness.send({ type: "GET_QUEUE", requesterTabId: 7 });
  assert.equal(queue.count, 2);
  assert.deepEqual(
    [queue.currentEntry, ...queue.upNextEntries].map((entry) => entry.title).sort(),
    ["One", "Two"],
  );
  assert.ok(harness.sentTabMessages.some(({ message }) => message.action === "NAVIGATE_AND_PLAY"));
});

test("stopping shuffle aborts a superseded API request", async () => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    if (!url.includes("/resolve?")) throw new Error(`Unexpected fetch: ${url}`);
    requestStarted();
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        reject(options.signal.reason || new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };
  const harness = createHarness({ storage: { client_id: "captured-client-id" }, fetchImpl });

  const pendingShuffle = harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });
  await started;

  const stopped = await harness.send({ type: "STOP_SHUFFLE" }, 7);
  const superseded = await pendingShuffle;

  assert.equal(stopped.ok, true);
  assert.equal(superseded.success, false);
  assert.equal(superseded.superseded, true);
});

test("a failed durable queue write does not navigate or report shuffle success", async () => {
  const track = createTrack(11, "Durable");
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("/resolve?")) {
      return { ok: true, status: 200, json: async () => ({ id: 42 }) };
    }
    if (url.includes("/users/42/track_likes")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ collection: [{ track }], next_href: null }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const harness = createHarness({
    storage: { client_id: "captured-client-id" },
    fetchImpl,
    storageSetError: true,
  });

  const result = await harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /persist playback state/i);
  assert.equal(
    harness.sentTabMessages.some(({ message }) => message.action === "NAVIGATE_AND_PLAY"),
    false,
  );
  const queue = await harness.send({ type: "GET_QUEUE", requesterTabId: 7 });
  assert.equal(queue.count, 0);
});

test("failed stop and position writes leave the active in-memory queue unchanged", async () => {
  const queueEntries = [
    { index: 0, url: "https://soundcloud.com/test/first", title: "First", artist: "", artworkUrl: null },
    { index: 1, url: "https://soundcloud.com/test/second", title: "Second", artist: "", artworkUrl: null },
  ];
  const storage = {
    [STATE_STORAGE_KEY]: { queueEntries, currentIndex: 0, activeTabId: 7 },
  };

  const stopHarness = createHarness({ storage, storageSetError: "all" });
  const stopped = await stopHarness.send({ type: "STOP_SHUFFLE" }, 7);
  assert.equal(stopped.ok, false);
  let queue = await stopHarness.send({ type: "GET_QUEUE", requesterTabId: 7 });
  assert.equal(queue.count, 2);
  assert.equal(queue.currentIndex, 0);

  const positionHarness = createHarness({ storage, storageSetError: "all" });
  const selected = await positionHarness.send({ type: "PLAY_QUEUE_INDEX", tabId: 7, index: 1 }, 7);
  assert.equal(selected.ok, false);
  queue = await positionHarness.send({ type: "GET_QUEUE", requesterTabId: 7 });
  assert.equal(queue.currentIndex, 0);
  assert.equal(
    positionHarness.sentTabMessages.some(({ message }) => message.action === "NAVIGATE_AND_PLAY"),
    false,
  );
});

test("stopping promptly cancels a shuffle waiting for client-id capture", async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not start without client-id");
    },
  });

  const startedAt = Date.now();
  const pendingShuffle = harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });
  const stopResult = await harness.send({ type: "STOP_SHUFFLE" }, 7);
  const superseded = await pendingShuffle;

  assert.equal(stopResult.ok, true);
  assert.equal(superseded.superseded, true);
  assert.equal(fetchCalls, 0);
  assert.ok(Date.now() - startedAt < 500, "abort should not wait for the seven-second client-id timeout");
});

test("stop wins when a superseded shuffle is already persisting", async () => {
  const track = createTrack(12, "Racy");
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("/resolve?")) {
      return { ok: true, status: 200, json: async () => ({ id: 42 }) };
    }
    if (url.includes("/users/42/track_likes")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ collection: [{ track }], next_href: null }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const harness = createHarness({
    storage: { client_id: "captured-client-id" },
    fetchImpl,
    delayFirstQueueWrite: true,
  });

  const pendingShuffle = harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });
  await harness.queueWriteStarted;
  const pendingStop = harness.send({ type: "STOP_SHUFFLE" }, 7);
  harness.releaseDelayedQueueWrite();

  const [superseded, stopped] = await Promise.all([pendingShuffle, pendingStop]);
  assert.equal(superseded.superseded, true);
  assert.equal(stopped.ok, true);
  assert.equal(
    harness.sentTabMessages.some(({ message }) => message.action === "NAVIGATE_AND_PLAY"),
    false,
  );
  const queue = await harness.send({ type: "GET_QUEUE", requesterTabId: 7 });
  assert.equal(queue.count, 0);
  assert.deepEqual(harness.storageState[STATE_STORAGE_KEY].queueEntries, []);
});

test("an aborted position write rolls back when the superseding shuffle fails", async () => {
  let resolveCalls = 0;
  const unplayableTrack = {
    ...createTrack(14, "Unplayable"),
    permalink_url: "https://example.com/not-a-soundcloud-track",
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("/resolve?")) {
      resolveCalls += 1;
      if (resolveCalls > 1) throw new Error("superseding shuffle failed");
      return { ok: true, status: 200, json: async () => ({ id: 42 }) };
    }
    if (url.includes("/users/42/track_likes")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ collection: [{ track: unplayableTrack }], next_href: null }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const harness = createHarness({
    storage: { client_id: "captured-client-id" },
    fetchImpl,
    delayFirstPositionWrite: true,
  });

  const firstShuffle = harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });
  await harness.positionWriteStarted;

  const failedReplacement = harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });
  const replacementResult = await failedReplacement;
  harness.releaseDelayedPositionWrite();
  const superseded = await firstShuffle;

  assert.equal(replacementResult.success, false);
  assert.match(replacementResult.error, /superseding shuffle failed/);
  assert.equal(superseded.superseded, true);
  const queue = await harness.send({ type: "GET_QUEUE", requesterTabId: 7 });
  assert.equal(queue.count, 1);
  assert.equal(queue.currentIndex, 0);
  assert.equal(harness.storageState[POSITION_STORAGE_KEY].currentIndex, 0);
  assert.equal(
    harness.sentTabMessages.some(({ message }) => message.action === "NAVIGATE_AND_PLAY"),
    false,
  );
});

test("content navigation failure never reloads the SoundCloud tab", async () => {
  const track = createTrack(13, "Fallback");
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("/resolve?")) {
      return { ok: true, status: 200, json: async () => ({ id: 42 }) };
    }
    if (url.includes("/users/42/track_likes")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ collection: [{ track }], next_href: null }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const harness = createHarness({
    storage: { client_id: "captured-client-id" },
    fetchImpl,
    tabMessageImpl(message) {
      return message.action === "NAVIGATE_AND_PLAY"
        ? { ok: false, error: "content script unavailable" }
        : { ok: true };
    },
    backgroundSetTimeout(fn, delay) {
      return delay >= 1000 ? 1 : setTimeout(fn, delay);
    },
  });

  const result = await harness.send({
    type: "START_SHUFFLE_CONTEXT",
    mode: "likes",
    url: "https://soundcloud.com/test/likes",
    tabId: 7,
  });

  assert.equal(result.success, true);
  assert.ok(harness.sentTabMessages.some(({ message }) => message.action === "NAVIGATE_AND_PLAY"));
  assert.deepEqual(harness.updatedTabs, []);
});

test("skip, previous, and direct queue selection keep their navigation semantics", async () => {
  const harness = createHarness({
    storage: {
      [STATE_STORAGE_KEY]: {
        queueUrls: [
          "https://soundcloud.com/test/first",
          "https://soundcloud.com/test/second",
          "https://soundcloud.com/test/third",
        ],
        currentIndex: 0,
        activeTabId: 7,
      },
    },
  });

  await harness.send({ type: "SKIP_NEXT" }, 7);
  let status = await harness.send({ type: "GET_STATUS", requesterTabId: 7 });
  assert.equal(status.currentIndex, 1);

  await harness.send({ type: "SKIP_PREV" }, 7);
  status = await harness.send({ type: "GET_STATUS", requesterTabId: 7 });
  assert.equal(status.currentIndex, 0);

  const selected = await harness.send({ type: "PLAY_QUEUE_INDEX", tabId: 7, index: 2 }, 7);
  assert.equal(selected.ok, true);
  assert.equal(selected.currentIndex, 2);
  assert.deepEqual(
    harness.sentTabMessages
      .filter(({ message }) => message.action === "NAVIGATE_AND_PLAY")
      .map(({ message }) => message.url),
    [
      "https://soundcloud.com/test/second",
      "https://soundcloud.com/test/first",
      "https://soundcloud.com/test/third",
    ],
  );
});
