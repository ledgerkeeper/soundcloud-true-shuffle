const statusEl = document.getElementById("status");
const statePillEl = document.getElementById("state-pill");
const stopBtn = document.getElementById("stop-shuffle");
const contextActionsEl = document.getElementById("context-actions");
const contextCaptionEl = document.getElementById("context-caption");
const nowPlayingCaptionEl = document.getElementById("now-playing-caption");
const queueCurrentEl = document.getElementById("queue-current");
const queueCurrentEmptyEl = document.getElementById("queue-current-empty");
const queueCaptionEl = document.getElementById("queue-caption");
const queueListEl = document.getElementById("queue-list");
const queueEmptyEl = document.getElementById("queue-empty");

let currentPageUrl = null;

function showStatus(message, tone = "info") {
  statusEl.textContent = message;
  statusEl.className = `status status--${tone}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
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
  let requesterTabId = null;
  try {
    const tab = await getActiveTab();
    if (Number.isFinite(tab?.id)) requesterTabId = tab.id;
  } catch {}

  const result = await sendRuntimeMessage({ type: "GET_STATUS", requesterTabId });
  return result.ok ? (result.response || null) : null;
}

async function requestQueue() {
  let requesterTabId = null;
  try {
    const tab = await getActiveTab();
    if (Number.isFinite(tab?.id)) requesterTabId = tab.id;
  } catch {}

  const result = await sendRuntimeMessage({
    type: "GET_QUEUE",
    requesterTabId,
    maxItems: 50,
  });
  return result.ok ? (result.response || null) : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setUiFromStatus(status) {
  const isShuffling = status?.isShuffling === true;
  const isActiveTab = status?.isActiveTab !== false;
  if (stopBtn) stopBtn.disabled = !isShuffling;

  if (!isShuffling) {
    statePillEl.dataset.active = "false";
    statePillEl.textContent = "Idle";
    return;
  }

  const count = Number.isFinite(status?.count) ? status.count : null;
  const current = Number.isFinite(status?.currentIndex) ? status.currentIndex + 1 : null;
  statePillEl.dataset.active = "true";
  if (!isActiveTab) {
    statePillEl.textContent = "Other tab";
  } else if (count && current) {
    statePillEl.textContent = `${current}/${count}`;
  } else {
    statePillEl.textContent = "Active";
  }
}

function getQueueItemMarkup(entry) {
  const artworkStyle = entry.artworkUrl
    ? ` style="background-image:url('${entry.artworkUrl.replaceAll("'", "%27")}')"`
    : "";

  return `
    <button class="queue-item" type="button" data-index="${entry.index}">
      <div class="queue-item__index">#${entry.index + 1}</div>
      <div class="queue-item__art"${artworkStyle}></div>
      <div>
        <div class="queue-item__title">${escapeHtml(entry.title || "Untitled track")}</div>
        <div class="queue-item__artist">${escapeHtml(entry.artist || entry.url || "")}</div>
      </div>
    </button>
  `;
}

function getCurrentMarkup(entry) {
  const artworkStyle = entry?.artworkUrl
    ? ` style="background-image:url('${entry.artworkUrl.replaceAll("'", "%27")}')"`
    : "";

  return `
    <div class="queue-item queue-item--current" data-current="true">
      <div class="queue-item__art"${artworkStyle}></div>
      <div>
        <div class="queue-item__badge">Now Playing</div>
        <div class="queue-item__title">${escapeHtml(entry?.title || "Untitled track")}</div>
        <div class="queue-item__artist">${escapeHtml(entry?.artist || entry?.url || "")}</div>
      </div>
    </div>
  `;
}

async function playQueueIndex(index) {
  const activeTab = await getActiveTab().catch(() => null);
  const tabId = Number.isFinite(activeTab?.id) ? activeTab.id : null;
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

function renderQueue(queueState) {
  const currentEntry = queueState?.currentEntry || null;
  const upNextEntries = Array.isArray(queueState?.upNextEntries) ? queueState.upNextEntries : [];
  const remainingCount = Number.isFinite(queueState?.remainingCount) ? queueState.remainingCount : upNextEntries.length;

  if (currentEntry) {
    queueCurrentEmptyEl.style.display = "none";
    queueCurrentEl.innerHTML = getCurrentMarkup(currentEntry);
    nowPlayingCaptionEl.textContent = currentEntry.artist || currentEntry.url || "Active track";
  } else {
    queueCurrentEl.innerHTML = "";
    queueCurrentEmptyEl.style.display = "block";
    nowPlayingCaptionEl.textContent = "No active track";
  }

  if (!upNextEntries.length) {
    queueListEl.innerHTML = "";
    queueEmptyEl.style.display = "block";
    queueCaptionEl.textContent = currentEntry ? "No upcoming tracks" : "No queue yet";
    return;
  }

  queueEmptyEl.style.display = "none";
  queueCaptionEl.textContent = `${remainingCount} ahead · showing next ${upNextEntries.length}`;
  queueListEl.innerHTML = upNextEntries.map(getQueueItemMarkup).join("");

  queueListEl.querySelectorAll(".queue-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await playQueueIndex(Number(btn.dataset.index));
    });
  });
}

function resolveContextActions(url) {
  if (!url) return [];

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  if (!parsed.hostname.includes("soundcloud.com")) return [];

  const path = parsed.pathname.toLowerCase();
  const parts = path.split("/").filter(Boolean);
  const actions = [];

  actions.push({
    label: "Shuffle Likes",
    meta: "Your liked tracks",
    run: async (tabId) => sendRuntimeMessage({ type: "START_SHUFFLE_LIKES", tabId }),
  });

  if (/\/likes\/?$/.test(path)) {
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
  } else if (/\/reposts\/?$/.test(path)) {
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
  } else if (/\/tracks\/?$/.test(path)) {
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
  } else if (path.includes("/sets/") && !/\/sets\/?$/.test(path)) {
    actions.unshift({
      label: "This Playlist",
      meta: "Shuffle current playlist",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_PLAYLIST",
        url,
        tabId,
      }),
    });
  } else if (/\/sets\/?$/.test(path)) {
    actions.unshift({
      label: "All Playlists",
      meta: "Shuffle tracks from all playlists",
      run: async (tabId) => sendRuntimeMessage({
        type: "START_SHUFFLE_PLAYLISTS",
        url,
        tabId,
      }),
    });
  } else if (parts.length === 1) {
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

function renderContextActions(url) {
  const actions = resolveContextActions(url);
  contextActionsEl.innerHTML = "";

  if (!actions.length) {
    contextCaptionEl.textContent = "Open a SoundCloud profile, likes page, or playlist to unlock page-aware actions.";
    const placeholder = document.createElement("button");
    placeholder.className = "action-btn";
    placeholder.disabled = true;
    placeholder.innerHTML = `
      <span class="action-btn__title">No SoundCloud Context</span>
      <span class="action-btn__meta">Keep a SoundCloud tab active</span>
    `;
    contextActionsEl.appendChild(placeholder);
    return;
  }

  contextCaptionEl.textContent = "Actions adapt to the active SoundCloud tab.";
  actions.forEach((action, index) => {
    const btn = document.createElement("button");
    btn.className = `action-btn${index === 0 ? " action-btn--accent" : ""}`;
    btn.type = "button";
    btn.innerHTML = `
      <span class="action-btn__title">${escapeHtml(action.label)}</span>
      <span class="action-btn__meta">${escapeHtml(action.meta)}</span>
    `;
    btn.addEventListener("click", async () => {
      showStatus(`Starting ${action.label.toLowerCase()}...`, "info");
      const activeTab = await getActiveTab().catch(() => null);
      const tabId = Number.isFinite(activeTab?.id) ? activeTab.id : null;
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
