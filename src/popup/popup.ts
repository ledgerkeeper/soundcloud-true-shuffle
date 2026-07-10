(() => {
type QueueEntry = {
  index: number;
  url: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
};

type QueueState = {
  currentEntry?: QueueEntry | null;
  upNextEntries?: QueueEntry[];
  remainingCount?: number;
  isShuffling?: boolean;
  isActiveTab?: boolean;
  count?: number;
  currentIndex?: number;
};

type RuntimeResult<T = RuntimeResponse> = {
  ok: boolean;
  response: T | null;
  error?: string;
};

type ContextAction = {
  label: string;
  meta: string;
  run: (tabId: number | null) => Promise<RuntimeResult>;
};

const statusEl = document.getElementById("status") as HTMLElement;
const statePillEl = document.getElementById("state-pill") as HTMLElement;
const stopBtn = document.getElementById("stop-shuffle") as HTMLButtonElement | null;
const contextActionsEl = document.getElementById("context-actions") as HTMLElement;
const contextCaptionEl = document.getElementById("context-caption") as HTMLElement;
const nowPlayingCaptionEl = document.getElementById("now-playing-caption") as HTMLElement;
const queueCurrentEl = document.getElementById("queue-current") as HTMLElement;
const queueCaptionEl = document.getElementById("queue-caption") as HTMLElement;
const queueListEl = document.getElementById("queue-list") as HTMLElement;
const queueEmptyEl = document.getElementById("queue-empty") as HTMLElement;

let currentPageUrl: string | null = null;

function showStatus(message: string, tone = "info") {
  statusEl.textContent = message;
  statusEl.className = `status status--${tone}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendRuntimeMessage<T = RuntimeResponse>(message: RuntimeRequest) {
  return new Promise<RuntimeResult<T>>((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message || String(err), response: null });
        return;
      }
      resolve({ ok: true, response: resp || null });
    });
  });
}

async function requestStatus() {
  let requesterTabId: number | null = null;
  try {
    const tab = await getActiveTab();
    if (typeof tab?.id === "number" && Number.isFinite(tab.id)) requesterTabId = tab.id;
  } catch {}

  const result = await sendRuntimeMessage<QueueState>({ type: "GET_STATUS", requesterTabId });
  return result.ok ? (result.response || null) : null;
}

async function requestQueue() {
  let requesterTabId: number | null = null;
  try {
    const tab = await getActiveTab();
    if (typeof tab?.id === "number" && Number.isFinite(tab.id)) requesterTabId = tab.id;
  } catch {}

  const result = await sendRuntimeMessage<QueueState>({
    type: "GET_QUEUE",
    requesterTabId,
    maxItems: 50,
  });
  return result.ok ? (result.response || null) : null;
}

function setUiFromStatus(status: QueueState | null) {
  const isShuffling = status?.isShuffling === true;
  const isActiveTab = status?.isActiveTab !== false;
  if (stopBtn) stopBtn.disabled = !isShuffling;

  if (!isShuffling) {
    statePillEl.dataset.active = "false";
    statePillEl.textContent = "Idle";
    return;
  }

  const count = typeof status?.count === "number" && Number.isFinite(status.count) ? status.count : null;
  const current = typeof status?.currentIndex === "number" && Number.isFinite(status.currentIndex)
    ? status.currentIndex + 1
    : null;
  statePillEl.dataset.active = "true";
  if (!isActiveTab) {
    statePillEl.textContent = "Other tab";
  } else if (count && current) {
    statePillEl.textContent = `${current}/${count}`;
  } else {
    statePillEl.textContent = "Active";
  }
}

function getSafeArtworkUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function setArtwork(el: HTMLElement, artworkUrl: unknown) {
  const safeUrl = getSafeArtworkUrl(artworkUrl);
  if (safeUrl) {
    el.style.backgroundImage = `url("${safeUrl.replaceAll('"', "%22")}")`;
  } else {
    el.style.removeProperty("background-image");
  }
}

function makeQueueText(entry: QueueEntry) {
  const textWrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "queue-item__title";
  title.textContent = entry.title || "Untitled track";
  const artist = document.createElement("div");
  artist.className = "queue-item__artist";
  artist.textContent = entry.artist || entry.url || "";
  textWrap.append(title, artist);
  return textWrap;
}

function createQueueItem(entry: QueueEntry) {
  const btn = document.createElement("button");
  btn.className = "queue-item";
  btn.type = "button";
  btn.dataset.index = String(entry.index);

  const indexEl = document.createElement("div");
  indexEl.className = "queue-item__index";
  indexEl.textContent = `#${entry.index + 1}`;

  const art = document.createElement("div");
  art.className = "queue-item__art";
  setArtwork(art, entry.artworkUrl);

  btn.append(indexEl, art, makeQueueText(entry));
  btn.addEventListener("click", async () => {
    await playQueueIndex(entry.index);
  });
  return btn;
}

function createCurrentItem(entry: QueueEntry) {
  const item = document.createElement("div");
  item.className = "queue-item queue-item--current";
  item.dataset.current = "true";

  const art = document.createElement("div");
  art.className = "queue-item__art";
  setArtwork(art, entry.artworkUrl);

  const textWrap = document.createElement("div");
  const badge = document.createElement("div");
  badge.className = "queue-item__badge";
  badge.textContent = "Now Playing";
  textWrap.append(badge, makeQueueText(entry));

  item.append(art, textWrap);
  return item;
}

async function playQueueIndex(index: number) {
  const activeTab = await getActiveTab().catch(() => null);
  const tabId = typeof activeTab?.id === "number" && Number.isFinite(activeTab.id) ? activeTab.id : null;
  showStatus("Switching track...", "info");
  const result = await sendRuntimeMessage({
    type: "PLAY_QUEUE_INDEX",
    index,
    tabId,
  });
  if (!result.ok || result.response?.ok === false) {
    showStatus(result.error || result.response?.error || "Failed to play queue item", "error");
    return;
  }
  showStatus("Track selected", "ok");
  await refreshPopup();
}

function renderQueue(queueState: QueueState | null) {
  const currentEntry = queueState?.currentEntry || null;
  const upNextEntries = Array.isArray(queueState?.upNextEntries) ? queueState.upNextEntries : [];
  const remainingCount = typeof queueState?.remainingCount === "number" && Number.isFinite(queueState.remainingCount)
    ? queueState.remainingCount
    : upNextEntries.length;

  if (currentEntry) {
    queueCurrentEl.replaceChildren(createCurrentItem(currentEntry));
    nowPlayingCaptionEl.textContent = currentEntry.artist || currentEntry.url || "Active track";
  } else {
    queueCurrentEl.replaceChildren();
    nowPlayingCaptionEl.textContent = "No active track";
  }

  if (!upNextEntries.length) {
    queueListEl.replaceChildren();
    queueEmptyEl.style.display = "block";
    queueEmptyEl.textContent = currentEntry
      ? "No upcoming tracks."
      : "Start a shuffle to see the next tracks here.";
    queueCaptionEl.textContent = currentEntry ? "No upcoming tracks" : "No queue yet";
    return;
  }

  queueEmptyEl.style.display = "none";
  queueCaptionEl.textContent = `${remainingCount} ahead · showing next ${upNextEntries.length}`;
  queueListEl.replaceChildren(...upNextEntries.map(createQueueItem));
}

// Top-level paths that are SoundCloud app pages, not user profiles.
// Must stay in sync with the list in content.ts.
const RESERVED_TOP_SLUGS = new Set([
  "you", "feed", "discover", "stream", "home", "search", "upload", "messages",
  "notifications", "settings", "people", "charts", "mobile", "pro", "premium",
  "pages", "tags", "popular", "stations", "jobs", "imprint", "terms-of-use",
  "logout", "signin", "signout", "connect", "activity", "for-artists",
  "artist-plans", "library", "apps", "help", "legal", "community-guidelines",
]);

function isLikelyUsername(slug: string) {
  return !!slug && !RESERVED_TOP_SLUGS.has(slug);
}

function resolveContextActions(url: string | null): ContextAction[] {
  if (!url) return [];

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "soundcloud.com" && !hostname.endsWith(".soundcloud.com")) return [];

  const path = parsed.pathname.toLowerCase();
  const parts = path.split("/").filter(Boolean);
  const first = parts[0] || "";
  const isYouSection = first === "you";
  const ownerLike = isYouSection || isLikelyUsername(first);
  const actions: ContextAction[] = [];

  actions.push({
    label: "Shuffle Likes",
    meta: "Your liked tracks",
    run: async (tabId) => sendRuntimeMessage({ type: "START_SHUFFLE_LIKES", tabId }),
  });

  if (ownerLike && parts.length === 2 && parts[1] === "likes") {
    actions.unshift({
      label: "This Likes Page",
      meta: "Shuffle current likes page",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_CONTEXT",
        mode: "likes",
        url,
        tabId,
      }),
    });
  } else if (ownerLike && parts.length === 2 && parts[1] === "reposts") {
    actions.unshift({
      label: "This Reposts Page",
      meta: "Shuffle reposts from this profile",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_CONTEXT",
        mode: "reposts",
        url,
        tabId,
      }),
    });
  } else if (ownerLike && parts.length === 2 && parts[1] === "tracks") {
    actions.unshift({
      label: "This Tracks Page",
      meta: "Shuffle tracks from this profile",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_CONTEXT",
        mode: "tracks",
        url,
        tabId,
      }),
    });
  } else if (!isYouSection && isLikelyUsername(first) && parts.length >= 3 && parts[1] === "sets") {
    actions.unshift({
      label: "This Playlist",
      meta: "Shuffle current playlist",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_PLAYLIST",
        url,
        tabId,
      }),
    });
  } else if (ownerLike && parts.length === 2 && parts[1] === "sets") {
    actions.unshift({
      label: "All Playlists",
      meta: "Shuffle tracks from all playlists",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_PLAYLISTS",
        url,
        tabId,
      }),
    });
  } else if (!isYouSection && isLikelyUsername(first) && parts.length === 1) {
    actions.unshift({
      label: "Profile Mix",
      meta: "Tracks + reposts from this profile",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_CONTEXT",
        mode: "all",
        url,
        tabId,
      }),
    });
  }

  return actions
    .filter((action, index, list) => list.findIndex((item) => item.label === action.label) === index)
    .slice(0, 4);
}

function renderContextActions(url: string | null) {
  const actions = resolveContextActions(url);
  contextActionsEl.replaceChildren();

  if (!actions.length) {
    contextCaptionEl.textContent = "Open a SoundCloud profile, likes page, or playlist to unlock page-aware actions.";
    const placeholder = document.createElement("button");
    placeholder.className = "action-btn";
    placeholder.disabled = true;
    const title = document.createElement("span");
    title.className = "action-btn__title";
    title.textContent = "No SoundCloud Context";
    const meta = document.createElement("span");
    meta.className = "action-btn__meta";
    meta.textContent = "Keep a SoundCloud tab active";
    placeholder.append(title, meta);
    contextActionsEl.appendChild(placeholder);
    return;
  }

  contextCaptionEl.textContent = "Actions adapt to the active SoundCloud tab.";
  actions.forEach((action, index) => {
    const btn = document.createElement("button");
    btn.className = `action-btn${index === 0 ? " action-btn--accent" : ""}`;
    btn.type = "button";
    const title = document.createElement("span");
    title.className = "action-btn__title";
    title.textContent = action.label;
    const meta = document.createElement("span");
    meta.className = "action-btn__meta";
    meta.textContent = action.meta;
    btn.append(title, meta);
    btn.addEventListener("click", async () => {
      showStatus(`Starting ${action.label.toLowerCase()}...`, "info");
      const activeTab = await getActiveTab().catch(() => null);
      const tabId = typeof activeTab?.id === "number" && Number.isFinite(activeTab.id) ? activeTab.id : null;
      const result = await action.run(tabId);
      if (!result.ok) {
        showStatus(result.error || "Background service worker not available", "error");
        return;
      }
      const resp = result.response || {};
      if (resp.success) {
        const count = Number.isFinite(resp.count) ? `${resp.count} tracks` : "shuffle started";
        showStatus(`${action.label}: ${count}`, "ok");
        await refreshPopup();
        return;
      }
      showStatus(resp.error || `Failed to start ${action.label.toLowerCase()}`, "error");
    });
    contextActionsEl.appendChild(btn);
  });
}

async function refreshPopup() {
  const [status, queueState, activeTab] = await Promise.all([
    requestStatus(),
    requestQueue(),
    getActiveTab().catch(() => null),
  ]);

  setUiFromStatus(status || queueState);
  currentPageUrl = activeTab?.url || null;
  renderContextActions(currentPageUrl);
  renderQueue(queueState);

  if (status?.isShuffling) {
    showStatus("Queue active", "ok");
  } else {
    showStatus("Ready", "info");
  }
}

stopBtn?.addEventListener("click", async () => {
  showStatus("Stopping shuffle...", "info");
  const result = await sendRuntimeMessage({ type: "STOP_SHUFFLE" });
  if (!result.ok || result.response?.ok === false) {
    showStatus(result.error || result.response?.error || "Failed to stop shuffle", "error");
    return;
  }
  showStatus("Shuffle stopped", "ok");
  await refreshPopup();
});

refreshPopup().catch((e) => {
  showStatus(e?.message || "Failed to load popup state", "error");
});

setInterval(() => {
  refreshPopup().catch(() => {});
}, 2500);
})();
