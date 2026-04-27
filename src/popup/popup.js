(() => {
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
            if (Number.isFinite(tab?.id))
                requesterTabId = tab.id;
        }
        catch { }
        const result = await sendRuntimeMessage({ type: "GET_STATUS", requesterTabId });
        return result.ok ? (result.response || null) : null;
    }
    async function requestQueue() {
        let requesterTabId = null;
        try {
            const tab = await getActiveTab();
            if (Number.isFinite(tab?.id))
                requesterTabId = tab.id;
        }
        catch { }
        const result = await sendRuntimeMessage({
            type: "GET_QUEUE",
            requesterTabId,
            maxItems: 50,
        });
        return result.ok ? (result.response || null) : null;
    }
    function setUiFromStatus(status) {
        const isShuffling = status?.isShuffling === true;
        const isActiveTab = status?.isActiveTab !== false;
        if (stopBtn)
            stopBtn.disabled = !isShuffling;
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
        }
        else if (count && current) {
            statePillEl.textContent = `${current}/${count}`;
        }
        else {
            statePillEl.textContent = "Active";
        }
    }
    function getSafeArtworkUrl(value) {
        if (typeof value !== "string")
            return null;
        try {
            const url = new URL(value);
            return url.protocol === "https:" ? url.toString() : null;
        }
        catch {
            return null;
        }
    }
    function setArtwork(el, artworkUrl) {
        const safeUrl = getSafeArtworkUrl(artworkUrl);
        if (safeUrl) {
            el.style.backgroundImage = `url("${safeUrl.replaceAll('"', "%22")}")`;
        }
        else {
            el.style.removeProperty("background-image");
        }
    }
    function makeQueueText(entry) {
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
    function createQueueItem(entry) {
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
    function createCurrentItem(entry) {
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
            queueCurrentEl.replaceChildren(createCurrentItem(currentEntry));
            nowPlayingCaptionEl.textContent = currentEntry.artist || currentEntry.url || "Active track";
        }
        else {
            queueCurrentEl.replaceChildren();
            queueCurrentEmptyEl.style.display = "block";
            nowPlayingCaptionEl.textContent = "No active track";
        }
        if (!upNextEntries.length) {
            queueListEl.replaceChildren();
            queueEmptyEl.style.display = "block";
            queueCaptionEl.textContent = currentEntry ? "No upcoming tracks" : "No queue yet";
            return;
        }
        queueEmptyEl.style.display = "none";
        queueCaptionEl.textContent = `${remainingCount} ahead · showing next ${upNextEntries.length}`;
        queueListEl.replaceChildren(...upNextEntries.map(createQueueItem));
    }
    function resolveContextActions(url) {
        if (!url)
            return [];
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            return [];
        }
        if (!parsed.hostname.includes("soundcloud.com"))
            return [];
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
        }
        else if (/\/reposts\/?$/.test(path)) {
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
        }
        else if (/\/tracks\/?$/.test(path)) {
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
        }
        else if (path.includes("/sets/") && !/\/sets\/?$/.test(path)) {
            actions.unshift({
                label: "This Playlist",
                meta: "Shuffle current playlist",
                run: async (tabId) => sendRuntimeMessage({
                    type: "START_SHUFFLE_PLAYLIST",
                    url,
                    tabId,
                }),
            });
        }
        else if (/\/sets\/?$/.test(path)) {
            actions.unshift({
                label: "All Playlists",
                meta: "Shuffle tracks from all playlists",
                run: async (tabId) => sendRuntimeMessage({
                    type: "START_SHUFFLE_PLAYLISTS",
                    url,
                    tabId,
                }),
            });
        }
        else if (parts.length === 1) {
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
        }
        else {
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
        refreshPopup().catch(() => { });
    }, 2500);
})();
