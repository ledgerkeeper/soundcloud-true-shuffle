"use strict";
(() => {
    // SoundCloud True Shuffle background service worker
    // Orchestrates auth token discovery, client_id capture, deep fetch, and queue playback.
    const APP_VERSION_HINT = "172000";
    const LOG_PREFIX = "[SC True Shuffle][bg]";
    const STATE_STORAGE_KEY = "sc_shuffle_state_v2";
    const POSITION_STORAGE_KEY = "sc_shuffle_position_v1";
    const PLAYABLE_URL_RESOLVE_CONCURRENCY = 4;
    const MAX_POPUP_QUEUE_ITEMS = 50;
    function errorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
    function toApiError(error) {
        return error instanceof Error ? error : null;
    }
    function describeApiError(error) {
        const apiError = toApiError(error);
        if (!apiError)
            return errorMessage(error);
        return apiError.endpoint ? `${apiError.message} (${apiError.endpoint})` : apiError.message;
    }
    function createAuthHeaders(token) {
        return token ? { Authorization: `OAuth ${token}` } : {};
    }
    function isQueueEntry(entry) {
        return entry !== null;
    }
    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }
    function storageGet(keys) {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get(keys, (items) => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        console.warn(LOG_PREFIX, "storage.get failed:", err.message || err);
                        resolve({});
                        return;
                    }
                    resolve((items || {}));
                });
            }
            catch (e) {
                console.warn(LOG_PREFIX, "storage.get threw:", errorMessage(e));
                resolve({});
            }
        });
    }
    function storageSet(items) {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.set(items, () => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        console.warn(LOG_PREFIX, "storage.set failed:", err.message || err);
                        resolve(false);
                        return;
                    }
                    resolve(true);
                });
            }
            catch (e) {
                console.warn(LOG_PREFIX, "storage.set threw:", errorMessage(e));
                resolve(false);
            }
        });
    }
    function cookiesGet(details) {
        return new Promise((resolve) => {
            try {
                chrome.cookies.get(details, (cookie) => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        console.warn(LOG_PREFIX, "cookies.get failed:", err.message || err);
                        resolve(null);
                        return;
                    }
                    resolve(cookie || null);
                });
            }
            catch (e) {
                console.warn(LOG_PREFIX, "cookies.get threw:", errorMessage(e));
                resolve(null);
            }
        });
    }
    function tabsSendMessage(tabId, message) {
        return new Promise((resolve) => {
            try {
                chrome.tabs.sendMessage(tabId, message, (resp) => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        resolve({ ok: false, error: err.message || String(err) });
                        return;
                    }
                    resolve((resp || { ok: true }));
                });
            }
            catch (e) {
                resolve({ ok: false, error: errorMessage(e) });
            }
        });
    }
    async function hydratePlaybackState(force = false) {
        if (!force && stateHydrated)
            return;
        if (stateHydrating)
            return stateHydrating;
        stateHydrating = (async () => {
            const stored = await storageGet([STATE_STORAGE_KEY, POSITION_STORAGE_KEY]);
            const state = stored?.[STATE_STORAGE_KEY];
            const position = stored?.[POSITION_STORAGE_KEY];
            if (state && (Array.isArray(state.queueEntries) || Array.isArray(state.queueUrls))) {
                const storedEntries = Array.isArray(state.queueEntries) ? state.queueEntries : [];
                const storedUrls = Array.isArray(state.queueUrls) ? state.queueUrls : [];
                const hasPreferredEntries = storedEntries.length > 0 || storedUrls.length === 0;
                const hydratedEntries = hasPreferredEntries
                    ? storedEntries
                        .map((entry, index) => sanitizeQueueEntry(entry, index))
                        .filter(isQueueEntry)
                    : storedUrls
                        .map((url, index) => deriveQueueEntryFromUrl(url, index))
                        .filter(isQueueEntry);
                const storedIndex = typeof position?.currentIndex === "number" && Number.isFinite(position.currentIndex)
                    ? position.currentIndex
                    : typeof state.currentIndex === "number" && Number.isFinite(state.currentIndex)
                        ? state.currentIndex
                        : 0;
                setPlaybackQueueEntries(hydratedEntries, storedIndex);
                if (typeof position?.activeTabId === "number" && Number.isFinite(position.activeTabId)) {
                    activeTabId = position.activeTabId;
                }
                else if (typeof state.activeTabId === "number" && Number.isFinite(state.activeTabId)) {
                    activeTabId = state.activeTabId;
                }
                log("Hydrated state", { count: playbackQueue.length, index: currentIndex, tabId: activeTabId });
                if (!hasPreferredEntries && storedUrls.length > 0) {
                    try {
                        await persistPlaybackState(true);
                    }
                    catch (error) {
                        console.warn(LOG_PREFIX, "Legacy queue migration could not be persisted:", errorMessage(error));
                    }
                }
            }
            stateHydrated = true;
        })().finally(() => {
            stateHydrating = null;
        });
        return stateHydrating;
    }
    let playbackQueue = [];
    let currentIndex = 0;
    let cachedClientId = null;
    let clientIdCheckedAt = 0;
    let activeTabId = null;
    let lastAdvanceAt = 0;
    let stateHydrated = false;
    let stateHydrating = null;
    let queueGeneration = 0;
    let queueAbortController = null;
    let playbackWriteChain = Promise.resolve();
    const CLIENT_ID_TTL_MS = 30 * 60 * 1000;
    const CLIENT_ID_WAIT_MS = 7000;
    const FALLBACK_CLIENT_ID = ""; // Optional fallback
    const pendingClientIdResolvers = [];
    const playableUrlCache = new Map();
    function beginQueueGeneration() {
        queueGeneration += 1;
        queueAbortController?.abort();
        queueAbortController = new AbortController();
        return queueGeneration;
    }
    function isCurrentQueueGeneration(generation) {
        return generation === queueGeneration;
    }
    function getQueueGenerationSignal(generation) {
        if (!isCurrentQueueGeneration(generation) || !queueAbortController) {
            throw new DOMException("Shuffle request was superseded", "AbortError");
        }
        return queueAbortController.signal;
    }
    function throwIfAborted(signal) {
        if (!signal?.aborted)
            return;
        if (signal.reason instanceof Error)
            throw signal.reason;
        throw new DOMException("Shuffle request was superseded", "AbortError");
    }
    function fallbackUnlessAborted(_error, signal, fallback) {
        throwIfAborted(signal);
        return fallback;
    }
    function runSerializedPlaybackWrite(operation) {
        const result = playbackWriteChain.then(operation, operation);
        playbackWriteChain = result.then(() => undefined, () => undefined);
        return result;
    }
    function createPlaybackStorageItems(entries, index, tabId, includeQueue) {
        const savedAt = Date.now();
        const position = { currentIndex: index, activeTabId: tabId, savedAt };
        if (!includeQueue)
            return { [POSITION_STORAGE_KEY]: position };
        return {
            [STATE_STORAGE_KEY]: {
                queueEntries: entries,
                currentIndex: index,
                activeTabId: tabId,
                savedAt,
            },
            [POSITION_STORAGE_KEY]: position,
        };
    }
    async function writePlaybackSnapshot(entries, index, tabId, includeQueue) {
        const stored = await storageSet(createPlaybackStorageItems(entries, index, tabId, includeQueue));
        if (!stored)
            throw new Error("Unable to persist playback state");
    }
    async function persistPlaybackState(queueChanged = false) {
        const entries = playbackQueue.map((entry) => ({ ...entry }));
        const index = currentIndex;
        const tabId = activeTabId;
        return runSerializedPlaybackWrite(() => writePlaybackSnapshot(entries, index, tabId, queueChanged));
    }
    function resolveTargetTabId(...candidates) {
        for (const candidate of candidates) {
            if (typeof candidate === "number" && Number.isFinite(candidate))
                return candidate;
        }
        return null;
    }
    function isFromActiveTab(senderTabId) {
        if (typeof activeTabId !== "number" || !Number.isFinite(activeTabId))
            return true;
        if (typeof senderTabId !== "number" || !Number.isFinite(senderTabId))
            return true;
        return senderTabId === activeTabId;
    }
    function sanitizeQueueEntry(entry, fallbackIndex = null) {
        if (!entry || typeof entry !== "object")
            return null;
        const url = typeof entry.url === "string" && entry.url.startsWith("http") ? entry.url : null;
        if (!url)
            return null;
        return {
            index: Number.isFinite(entry.index) ? entry.index : fallbackIndex,
            url,
            title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : "Untitled track",
            artist: typeof entry.artist === "string" ? entry.artist.trim() : "",
            artworkUrl: typeof entry.artworkUrl === "string" && entry.artworkUrl.startsWith("http")
                ? entry.artworkUrl
                : null,
        };
    }
    function deriveQueueEntryFromUrl(url, index = null) {
        if (typeof url !== "string" || !url.startsWith("http"))
            return null;
        let title = url;
        try {
            const parsed = new URL(url);
            const parts = parsed.pathname.split("/").filter(Boolean);
            title = decodeURIComponent(parts[parts.length - 1] || url).replace(/[-_]+/g, " ");
        }
        catch { }
        return {
            index,
            url,
            title,
            artist: "",
            artworkUrl: null,
        };
    }
    function queueEntryFromTrack(track, index = null) {
        const url = normalizeTrackUrl(track);
        if (!url)
            return null;
        return sanitizeQueueEntry({
            index,
            url,
            title: track?.title || "Untitled track",
            artist: track?.user?.username || track?.publisher_metadata?.artist || "",
            artworkUrl: track?.artwork_url || track?.user?.avatar_url || null,
        }, index);
    }
    function normalizePlaybackQueueEntries(entries) {
        return entries
            .map((entry, index) => sanitizeQueueEntry({ ...entry, index }, index))
            .filter(isQueueEntry);
    }
    function setPlaybackQueueEntries(entries, startingIndex = 0) {
        playbackQueue = normalizePlaybackQueueEntries(entries);
        currentIndex = Math.max(0, Math.min(startingIndex, playbackQueue.length));
    }
    async function commitPlaybackQueue(entries, startingIndex, tabId, generation) {
        const nextQueue = normalizePlaybackQueueEntries(entries);
        const nextIndex = Math.max(0, Math.min(startingIndex, nextQueue.length));
        await runSerializedPlaybackWrite(async () => {
            if (!isCurrentQueueGeneration(generation)) {
                throw new DOMException("Shuffle request was superseded", "AbortError");
            }
            await writePlaybackSnapshot(nextQueue, nextIndex, tabId, true);
            if (!isCurrentQueueGeneration(generation)) {
                // The storage write cannot be cancelled once Chrome has accepted it.
                // Restore the still-active in-memory queue; the newer generation's own
                // serialized commit (for example STOP) will run after this repair.
                await writePlaybackSnapshot(playbackQueue, currentIndex, activeTabId, true);
                throw new DOMException("Shuffle request was superseded", "AbortError");
            }
            playbackQueue = nextQueue;
            currentIndex = nextIndex;
            activeTabId = tabId;
        });
    }
    async function commitPlaybackPosition(nextIndex, signal) {
        const expectedQueue = playbackQueue;
        const previousIndex = currentIndex;
        const expectedTabId = activeTabId;
        const boundedIndex = Math.max(0, Math.min(nextIndex, expectedQueue.length));
        await runSerializedPlaybackWrite(async () => {
            throwIfAborted(signal);
            if (playbackQueue !== expectedQueue) {
                throw new DOMException("Playback queue changed", "AbortError");
            }
            await writePlaybackSnapshot(expectedQueue, boundedIndex, expectedTabId, false);
            if (signal?.aborted || playbackQueue !== expectedQueue) {
                await writePlaybackSnapshot(expectedQueue, previousIndex, expectedTabId, false);
                throwIfAborted(signal);
                throw new DOMException("Playback queue changed", "AbortError");
            }
            currentIndex = boundedIndex;
        });
    }
    async function commitPlayableQueueUrl(index, url, signal) {
        const expectedQueue = playbackQueue;
        const nextQueue = expectedQueue.map((entry, entryIndex) => entryIndex === index ? { ...entry, url } : { ...entry });
        await runSerializedPlaybackWrite(async () => {
            throwIfAborted(signal);
            if (playbackQueue !== expectedQueue) {
                throw new DOMException("Playback queue changed", "AbortError");
            }
            await writePlaybackSnapshot(nextQueue, currentIndex, activeTabId, true);
            if (signal?.aborted || playbackQueue !== expectedQueue) {
                await writePlaybackSnapshot(expectedQueue, currentIndex, activeTabId, true);
                throwIfAborted(signal);
                throw new DOMException("Playback queue changed", "AbortError");
            }
            playbackQueue = nextQueue;
        });
    }
    function getQueueEntriesForPopup(maxItems = MAX_POPUP_QUEUE_ITEMS) {
        const startIndex = Math.max(currentIndex + 1, 0);
        return playbackQueue
            .slice(startIndex, startIndex + maxItems)
            .map((entry) => ({
            index: entry.index,
            url: entry.url,
            title: entry.title,
            artist: entry.artist,
            artworkUrl: entry.artworkUrl,
        }));
    }
    // Try to reuse OAuth token from existing SC session
    async function getAuthToken(signal) {
        throwIfAborted(signal);
        const cookie = await cookiesGet({
            url: "https://soundcloud.com",
            name: "oauth_token",
        });
        throwIfAborted(signal);
        return cookie ? cookie.value : null;
    }
    // Resolve client_id by passively intercepting outbound API calls or cached storage
    async function getClientId(forceRefresh = false, signal) {
        throwIfAborted(signal);
        const now = Date.now();
        if (!forceRefresh && cachedClientId && now - clientIdCheckedAt < CLIENT_ID_TTL_MS) {
            return cachedClientId;
        }
        if (!cachedClientId) {
            const stored = await storageGet("client_id");
            throwIfAborted(signal);
            if (stored?.client_id) {
                cachedClientId = stored.client_id;
                clientIdCheckedAt = now;
                return cachedClientId;
            }
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let timerId = 0;
            const cleanup = () => {
                if (timerId)
                    clearTimeout(timerId);
                signal?.removeEventListener("abort", onAbort);
                const index = pendingClientIdResolvers.indexOf(pending);
                if (index >= 0)
                    pendingClientIdResolvers.splice(index, 1);
            };
            const finishResolve = (id) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve(id);
            };
            const finishReject = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(error);
            };
            const onAbort = () => {
                const reason = signal?.reason;
                finishReject(reason instanceof Error ? reason : new DOMException("Shuffle request was superseded", "AbortError"));
            };
            const pending = {
                resolve: finishResolve,
                reject: finishReject,
            };
            pendingClientIdResolvers.push(pending);
            signal?.addEventListener("abort", onAbort, { once: true });
            timerId = setTimeout(() => {
                const cid = cachedClientId || FALLBACK_CLIENT_ID;
                if (cid) {
                    cachedClientId = cid;
                    clientIdCheckedAt = Date.now();
                    storageSet({ client_id: cid }).finally(() => finishResolve(cid));
                }
                else {
                    finishReject(new Error("Unable to resolve client_id (no network capture). Try playing a track first."));
                }
            }, CLIENT_ID_WAIT_MS);
            if (signal?.aborted)
                onAbort();
        });
    }
    function rememberClientId(id) {
        if (!id)
            return;
        cachedClientId = id;
        clientIdCheckedAt = Date.now();
        storageSet({ client_id: id });
        log("Captured client_id");
        for (const pending of [...pendingClientIdResolvers]) {
            pending.resolve(id);
        }
    }
    // Passive capture of client_id from SC API traffic
    chrome.webRequest.onBeforeRequest.addListener((details) => {
        try {
            const url = new URL(details.url);
            const cid = url.searchParams.get("client_id");
            if (cid)
                rememberClientId(cid);
        }
        catch (e) {
            console.warn("onBeforeRequest parse failed", errorMessage(e));
        }
    }, { urls: ["*://api-v2.soundcloud.com/*"] }, []);
    // Hydrate caches on startup
    (async () => {
        const stored = await storageGet("client_id");
        if (stored?.client_id) {
            cachedClientId = stored.client_id;
            clientIdCheckedAt = Date.now();
        }
    })();
    (async () => {
        await hydratePlaybackState(true);
    })();
    // Fetch likes or playlist tracks (handles pagination via next_href)
    async function fetchAllTracks(endpoint, token, clientId, signal) {
        const accumulated = [];
        let nextEndpoint = endpoint;
        const headers = createAuthHeaders(token);
        while (nextEndpoint) {
            throwIfAborted(signal);
            const url = new URL(nextEndpoint);
            if (!url.searchParams.has("client_id"))
                url.searchParams.set("client_id", clientId);
            if (!url.searchParams.has("limit"))
                url.searchParams.set("limit", "200");
            if (!url.searchParams.has("linked_partitioning"))
                url.searchParams.set("linked_partitioning", "1");
            if (!url.searchParams.has("app_version") && APP_VERSION_HINT) {
                url.searchParams.set("app_version", APP_VERSION_HINT);
            }
            const response = await fetch(url.toString(), { headers, signal });
            if (!response.ok) {
                const err = new Error(`API error ${response.status}`);
                err.status = response.status;
                err.endpoint = url.toString();
                throw err;
            }
            const data = await response.json();
            // Handle different response structures (playlists have .tracks, collections have .collection)
            const tracks = (data.collection || data.tracks || []).map((item) => item.track || item);
            accumulated.push(...tracks);
            nextEndpoint = data.next_href || null;
        }
        return accumulated;
    }
    async function tryFetchAll(endpoints, token, clientId, signal) {
        let lastError = null;
        for (const endpoint of endpoints) {
            if (!endpoint)
                continue;
            try {
                const items = await fetchAllTracks(endpoint, token, clientId, signal);
                return { items, endpoint };
            }
            catch (e) {
                throwIfAborted(signal);
                lastError = e;
                const apiError = toApiError(e);
                if (apiError?.status === 404)
                    continue;
                if (apiError?.status === 401 || apiError?.status === 403)
                    continue;
            }
        }
        throw lastError || new Error("All endpoints failed");
    }
    async function fetchJson(url, token, signal) {
        const headers = createAuthHeaders(token);
        const res = await fetch(url, { headers, signal });
        if (!res.ok) {
            const err = new Error(`API error ${res.status}`);
            err.status = res.status;
            err.endpoint = url;
            throw err;
        }
        return res.json();
    }
    function extractPlaylistId(input) {
        if (!input)
            return null;
        if (typeof input === "number")
            return input;
        if (typeof input === "string") {
            const match = input.match(/\/playlists\/(\d+)/);
            if (match?.[1])
                return Number(match[1]);
            return null;
        }
        if (typeof input === "object") {
            if (input.id)
                return Number(input.id);
            const uri = input.uri;
            if (typeof uri === "string")
                return extractPlaylistId(uri);
        }
        return null;
    }
    async function fetchPlaylistDetails(playlistIdOrUri, token, clientId, signal) {
        if (!playlistIdOrUri)
            return null;
        const maybeId = extractPlaylistId(playlistIdOrUri);
        const url = new URL(typeof playlistIdOrUri === "string" && playlistIdOrUri.startsWith("http")
            ? playlistIdOrUri
            : `https://api-v2.soundcloud.com/playlists/${maybeId || playlistIdOrUri}`);
        if (!url.searchParams.has("client_id"))
            url.searchParams.set("client_id", clientId);
        if (APP_VERSION_HINT && !url.searchParams.has("app_version"))
            url.searchParams.set("app_version", APP_VERSION_HINT);
        if (!url.searchParams.has("representation"))
            url.searchParams.set("representation", "full");
        return fetchJson(url.toString(), token, signal);
    }
    async function fetchPlaylistTracksOffset(endpoint, token, clientId, expectedCount, signal) {
        const seen = new Set();
        let offset = 0;
        const limit = 200;
        const results = [];
        while (true) {
            throwIfAborted(signal);
            const url = new URL(endpoint);
            if (!url.searchParams.has("client_id"))
                url.searchParams.set("client_id", clientId);
            url.searchParams.set("limit", String(limit));
            url.searchParams.set("offset", String(offset));
            url.searchParams.set("linked_partitioning", "1");
            if (APP_VERSION_HINT && !url.searchParams.has("app_version"))
                url.searchParams.set("app_version", APP_VERSION_HINT);
            const data = await fetchJson(url.toString(), token, signal);
            const page = (data?.collection || data?.tracks || []).map((item) => item.track || item);
            if (!page.length)
                break;
            let added = 0;
            for (const item of page) {
                const key = item?.id ? `id:${item.id}` :
                    item?.permalink_url ? `url:${item.permalink_url}` :
                        item?.uri ? `uri:${item.uri}` :
                            null;
                if (!key || seen.has(key))
                    continue;
                seen.add(key);
                results.push(item);
                added += 1;
            }
            if (added === 0)
                break;
            offset += page.length;
            if (expectedCount && results.length >= expectedCount)
                break;
            if (page.length < limit)
                break;
        }
        return results;
    }
    async function fetchPlaylistTracks(playlistData, token, clientId, triedDetails = false, signal) {
        const trackCount = Number.isFinite(playlistData?.track_count) ? playlistData.track_count : null;
        const embedded = Array.isArray(playlistData?.tracks) ? playlistData.tracks : null;
        const tracksUri = playlistData?.tracks_uri;
        let playlistId = playlistData?.id;
        const playlistUri = playlistData?.uri;
        if (!playlistId && typeof playlistUri === "string") {
            playlistId = extractPlaylistId(playlistUri);
        }
        const candidates = [
            tracksUri,
            playlistId ? `https://api-v2.soundcloud.com/playlists/${playlistId}/tracks` : null,
            playlistUri ? `${playlistUri.replace(/\/$/, "")}/tracks` : null,
        ];
        try {
            const { items, endpoint } = await tryFetchAll(candidates, token, clientId, signal);
            if (trackCount && items.length < trackCount) {
                const offsetItems = await fetchPlaylistTracksOffset(endpoint, token, clientId, trackCount, signal);
                if (offsetItems.length) {
                    log("Playlist tracks fetched (offset)", { endpoint, count: offsetItems.length });
                    return offsetItems;
                }
            }
            log("Playlist tracks fetched", { endpoint, count: items.length, trackCount });
            return items;
        }
        catch (e) {
            throwIfAborted(signal);
            if (!triedDetails && (playlistId || playlistUri)) {
                try {
                    const details = await fetchPlaylistDetails(playlistId || playlistUri, token, clientId, signal);
                    if (details)
                        return fetchPlaylistTracks(details, token, clientId, true, signal);
                }
                catch (detailErr) {
                    throwIfAborted(signal);
                    console.warn(LOG_PREFIX, "Playlist detail fetch failed:", errorMessage(detailErr));
                }
            }
            if (embedded && embedded.length > 5 && (trackCount === null || embedded.length >= trackCount)) {
                log("Playlist using embedded tracks", { count: embedded.length });
                return embedded;
            }
            throw e;
        }
    }
    async function resolveMe(token, signal) {
        if (!token)
            throw new Error("Login required for /you (no oauth_token cookie)");
        const res = await fetch("https://api-v2.soundcloud.com/me", {
            headers: {
                Authorization: `OAuth ${token}`,
                "Content-Type": "application/json",
            },
            signal,
        });
        if (!res.ok)
            throw new Error(`Failed to resolve /me (${res.status})`);
        return res.json();
    }
    async function resolveResource(url, clientId, token, signal) {
        const resolveUrl = new URL("https://api-v2.soundcloud.com/resolve");
        resolveUrl.searchParams.set("url", url);
        resolveUrl.searchParams.set("client_id", clientId);
        if (APP_VERSION_HINT)
            resolveUrl.searchParams.set("app_version", APP_VERSION_HINT);
        const headers = createAuthHeaders(token);
        const res = await fetch(resolveUrl.toString(), { headers, signal });
        if (!res.ok)
            throw new Error(`Resolve failed ${res.status} for ${url}`);
        return res.json();
    }
    async function resolveUserIdFromUrl(inputUrl, clientId, token, signal) {
        if (!inputUrl)
            throw new Error("Missing url");
        const cleanUrl = String(inputUrl).split("?")[0];
        if (cleanUrl.includes("/you/") || cleanUrl.endsWith("/you")) {
            const me = await resolveMe(token, signal);
            if (!me?.id)
                throw new Error("Unable to resolve /me");
            return me.id;
        }
        const profileUrl = cleanUrl.replace(/\/(likes|reposts|tracks|recommended|sets)\/?$/, "");
        const resolved = await resolveResource(profileUrl, clientId, token, signal);
        const userId = resolved?.id || resolved?.user_id || resolved?.creator?.id;
        if (!userId)
            throw new Error("Unable to resolve user id from url");
        return userId;
    }
    function shuffleArray(array) {
        const copy = array.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }
    function dedupeTracks(tracks) {
        const seen = new Set();
        const unique = [];
        for (const track of tracks || []) {
            const key = track?.id ? `id:${track.id}` :
                track?.permalink_url ? `url:${track.permalink_url}` :
                    track?.uri ? `uri:${track.uri}` :
                        null;
            if (!key || seen.has(key))
                continue;
            seen.add(key);
            unique.push(track);
        }
        return unique;
    }
    function normalizeTrackUrl(track) {
        const permalinkUrl = track?.permalink_url;
        if (typeof permalinkUrl === "string" && permalinkUrl.startsWith("http"))
            return permalinkUrl;
        const permalink = track?.permalink;
        if (typeof permalink === "string" && permalink) {
            if (permalink.startsWith("http"))
                return permalink;
            if (permalink.includes("/"))
                return `https://soundcloud.com/${permalink.replace(/^\//, "")}`;
            const userPermalink = track?.user?.permalink;
            if (userPermalink)
                return `https://soundcloud.com/${userPermalink}/${permalink}`;
        }
        const uri = track?.uri;
        if (typeof uri === "string" && uri.startsWith("http"))
            return uri;
        const id = track?.id;
        if (Number.isFinite(id))
            return `https://api-v2.soundcloud.com/tracks/${id}`;
        const urn = track?.urn || track?.uri;
        if (typeof urn === "string") {
            const match = urn.match(/soundcloud:tracks:(\d+)/);
            if (match?.[1])
                return `https://api-v2.soundcloud.com/tracks/${match[1]}`;
        }
        return null;
    }
    async function mapWithConcurrency(items, limit, fn, signal) {
        const results = new Array(items.length);
        let nextIndex = 0;
        async function worker() {
            while (true) {
                throwIfAborted(signal);
                const index = nextIndex++;
                if (index >= items.length)
                    return;
                results[index] = await fn(items[index], index);
            }
        }
        const workerCount = Math.max(1, Math.min(limit, items.length));
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return results;
    }
    function extractPlaylistApiUrl(item) {
        const candidate = item?.playlist || item?.set || item;
        const uri = candidate?.uri;
        if (typeof uri === "string" && uri.includes("api-v2.soundcloud.com/")) {
            if (uri.includes("/playlists/"))
                return uri;
            if (uri.includes("/sets/"))
                return uri.replace("/sets/", "/playlists/");
        }
        const id = candidate?.id;
        if (id)
            return `https://api-v2.soundcloud.com/playlists/${id}`;
        return null;
    }
    async function toPlayableSoundCloudUrl(url, signal) {
        if (!url)
            return null;
        if (playableUrlCache.has(url))
            return playableUrlCache.get(url) || null;
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            return null;
        }
        const hostname = (parsed.hostname || "").toLowerCase();
        // Resolve api-v2 track URLs to a public permalink URL before navigation.
        if (hostname === "api-v2.soundcloud.com" && parsed.pathname.startsWith("/tracks/")) {
            try {
                const parts = parsed.pathname.split("/").filter(Boolean);
                const trackId = parts[1];
                if (!trackId || !/^\d+$/.test(trackId))
                    return null;
                const clientId = await getClientId(false, signal)
                    .catch((error) => fallbackUnlessAborted(error, signal, null));
                const token = await getAuthToken(signal)
                    .catch((error) => fallbackUnlessAborted(error, signal, null));
                const apiUrl = new URL(`https://api-v2.soundcloud.com/tracks/${trackId}`);
                if (clientId && !apiUrl.searchParams.has("client_id"))
                    apiUrl.searchParams.set("client_id", clientId);
                if (APP_VERSION_HINT && !apiUrl.searchParams.has("app_version"))
                    apiUrl.searchParams.set("app_version", APP_VERSION_HINT);
                const headers = createAuthHeaders(token);
                const res = await fetch(apiUrl.toString(), { headers, signal });
                if (!res.ok)
                    return null;
                const data = await res.json();
                const permalinkUrl = data?.permalink_url;
                if (typeof permalinkUrl === "string" && permalinkUrl.startsWith("http")) {
                    playableUrlCache.set(url, permalinkUrl);
                    return permalinkUrl;
                }
                return null;
            }
            catch (e) {
                throwIfAborted(signal);
                console.warn(LOG_PREFIX, "Failed to resolve API track URL", errorMessage(e));
                return null;
            }
        }
        // Allow normal SoundCloud pages (soundcloud.com + non-API subdomains like m.soundcloud.com/on.soundcloud.com).
        if (hostname === "soundcloud.com" || (hostname.endsWith(".soundcloud.com") && hostname !== "api-v2.soundcloud.com")) {
            playableUrlCache.set(url, url);
            return url;
        }
        return null;
    }
    async function preResolvePlayableQueueEntries(entries, signal) {
        const uniqueUrls = Array.from(new Set(entries.map((entry) => entry?.url).filter(Boolean)));
        if (!uniqueUrls.length)
            return [];
        const resolvedUnique = await mapWithConcurrency(uniqueUrls, PLAYABLE_URL_RESOLVE_CONCURRENCY, async (url) => (await toPlayableSoundCloudUrl(url, signal)) || url, signal);
        const resolvedMap = new Map();
        uniqueUrls.forEach((url, index) => {
            resolvedMap.set(url, resolvedUnique[index] || url);
        });
        const seenResolved = new Set();
        const resolvedEntries = [];
        for (const entry of entries) {
            const safeEntry = sanitizeQueueEntry(entry);
            if (!safeEntry)
                continue;
            const resolvedUrl = resolvedMap.get(safeEntry.url) || safeEntry.url;
            if (!resolvedUrl || seenResolved.has(resolvedUrl))
                continue;
            seenResolved.add(resolvedUrl);
            resolvedEntries.push({
                ...safeEntry,
                url: resolvedUrl,
            });
        }
        return resolvedEntries;
    }
    async function tryPlayViaContentNavigation(tabId, entry, signal) {
        throwIfAborted(signal);
        const resp = await tabsSendMessage(tabId, {
            action: "NAVIGATE_AND_PLAY",
            url: entry.url,
            title: entry.title,
        });
        throwIfAborted(signal);
        if (resp?.ok === true)
            return true;
        log("Native DOM navigation was not confirmed; keeping the current document loaded", {
            tabId,
            url: entry.url,
            error: resp?.error || resp || null,
        });
        return false;
    }
    async function playNextInQueue(tabId, signal) {
        throwIfAborted(signal);
        const targetTabId = tabId || activeTabId;
        if (!targetTabId || !playbackQueue.length || currentIndex >= playbackQueue.length)
            return;
        const url = playbackQueue[currentIndex]?.url;
        if (!url) {
            console.warn("Missing URL at index, skipping", currentIndex);
            await commitPlaybackPosition(currentIndex + 1, signal);
            await playNextInQueue(targetTabId, signal);
            return;
        }
        const playableUrl = await toPlayableSoundCloudUrl(url, signal);
        throwIfAborted(signal);
        if (!playableUrl) {
            console.warn("Unplayable URL, skipping", url);
            await commitPlaybackPosition(currentIndex + 1, signal);
            await playNextInQueue(targetTabId, signal);
            return;
        }
        if (playableUrl !== url) {
            await commitPlayableQueueUrl(currentIndex, playableUrl, signal);
        }
        throwIfAborted(signal);
        log("Navigate through native page DOM", { tabId: targetTabId, index: currentIndex, url: playableUrl });
        const entry = playbackQueue[currentIndex];
        if (entry)
            await tryPlayViaContentNavigation(targetTabId, entry, signal);
    }
    function shouldIgnoreTrackFinished() {
        const now = Date.now();
        if (now - lastAdvanceAt < 1500)
            return true;
        return false;
    }
    function markAdvanced() {
        lastAdvanceAt = Date.now();
    }
    function getStatusSnapshot(options = {}) {
        const isShuffling = playbackQueue.length > 0 && currentIndex < playbackQueue.length;
        const requesterTabId = Number.isFinite(options?.requesterTabId) ? options.requesterTabId : null;
        const isActiveTab = requesterTabId === null ||
            !Number.isFinite(activeTabId) ||
            requesterTabId === activeTabId;
        return {
            isShuffling,
            isActiveTab,
            count: playbackQueue.length,
            currentIndex,
            activeTabId,
            currentEntry: playbackQueue[currentIndex] || null,
        };
    }
    async function notifyActiveTabState(signal) {
        throwIfAborted(signal);
        const tabId = activeTabId;
        if (typeof tabId !== "number" || !Number.isFinite(tabId))
            return;
        await tabsSendMessage(tabId, {
            action: "SC_SHUFFLE_STATE",
            ...getStatusSnapshot({ requesterTabId: tabId }),
        });
        throwIfAborted(signal);
    }
    async function stopShuffle() {
        const generation = beginQueueGeneration();
        await hydratePlaybackState();
        await commitPlaybackQueue([], 0, activeTabId, generation);
        await notifyActiveTabState();
    }
    async function playQueueIndex(tabId, index) {
        if (!playbackQueue.length)
            return { ok: false, error: "Queue is empty" };
        if (!Number.isFinite(index) || index < 0 || index >= playbackQueue.length) {
            return { ok: false, error: "Invalid queue index" };
        }
        await commitPlaybackPosition(index);
        markAdvanced();
        await notifyActiveTabState();
        await playNextInQueue(tabId);
        return { ok: true, ...getStatusSnapshot({ requesterTabId: tabId }) };
    }
    // ---- CORE LOGIC HANDLERS ----
    async function handleShuffleContext(request, sender, sendResponse) {
        const generation = beginQueueGeneration();
        const signal = getQueueGenerationSignal(generation);
        try {
            await hydratePlaybackState();
            throwIfAborted(signal);
            const targetTabId = resolveTargetTabId(request.tabId, sender?.tab?.id, activeTabId);
            const token = await getAuthToken(signal);
            const clientId = await getClientId(false, signal);
            if (!request.url || !request.mode)
                throw new Error("Missing url or mode");
            const userId = await resolveUserIdFromUrl(request.url, clientId, token, signal);
            let flattened = [];
            if (request.mode === "likes") {
                const endpoint = `https://api-v2.soundcloud.com/users/${userId}/track_likes`;
                const rawItems = await fetchAllTracks(endpoint, token, clientId, signal);
                flattened = rawItems.map((item) => item?.track || item);
            }
            else if (request.mode === "tracks") {
                const endpoint = `https://api-v2.soundcloud.com/users/${userId}/tracks`;
                const rawItems = await fetchAllTracks(endpoint, token, clientId, signal);
                flattened = rawItems.map((item) => item?.track || item);
            }
            else if (request.mode === "reposts") {
                const { items, endpoint } = await tryFetchAll([
                    `https://api-v2.soundcloud.com/users/${userId}/track_reposts`,
                    `https://api-v2.soundcloud.com/users/${userId}/reposts`,
                    `https://api-v2.soundcloud.com/stream/users/${userId}/reposts`,
                ], token, clientId, signal);
                log("Reposts fetched", { endpoint, count: items.length });
                flattened = items.map((item) => item?.track || item);
            }
            else if (request.mode === "all") {
                const tracksEndpoint = `https://api-v2.soundcloud.com/users/${userId}/tracks`;
                const tracksPromise = fetchAllTracks(tracksEndpoint, token, clientId, signal);
                const repostsPromise = tryFetchAll([
                    `https://api-v2.soundcloud.com/users/${userId}/track_reposts`,
                    `https://api-v2.soundcloud.com/users/${userId}/reposts`,
                    `https://api-v2.soundcloud.com/stream/users/${userId}/reposts`,
                ], token, clientId, signal).then((r) => r.items).catch((error) => fallbackUnlessAborted(error, signal, []));
                const [tracksRaw, repostsRaw] = await Promise.all([tracksPromise, repostsPromise]);
                flattened = tracksRaw.concat(repostsRaw).map((item) => item?.track || item);
            }
            else {
                throw new Error("Unknown mode");
            }
            flattened = flattened.filter((t) => t && (t.id || t.permalink_url || t.permalink || t.uri));
            const unique = dedupeTracks(flattened);
            const queueEntries = unique
                .map((track, index) => queueEntryFromTrack(track, index))
                .filter(isQueueEntry);
            const resolvedEntries = await preResolvePlayableQueueEntries(queueEntries, signal);
            const shuffledEntries = shuffleArray(resolvedEntries);
            if (!shuffledEntries.length)
                throw new Error("No playable track URLs found for context");
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            await commitPlaybackQueue(shuffledEntries, 0, targetTabId, generation);
            markAdvanced();
            await notifyActiveTabState(signal);
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            log("Shuffle started", { mode: request.mode, count: playbackQueue.length, tabId: activeTabId });
            await playNextInQueue(targetTabId, signal);
            throwIfAborted(signal);
            sendResponse({ success: true, count: playbackQueue.length, mode: request.mode });
        }
        catch (error) {
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            console.error("Shuffle context failed", error);
            const detail = describeApiError(error);
            sendResponse({ success: false, error: detail || "Shuffle context failed" });
        }
    }
    async function handleShufflePlaylist(request, sender, sendResponse) {
        const generation = beginQueueGeneration();
        const signal = getQueueGenerationSignal(generation);
        try {
            await hydratePlaybackState();
            throwIfAborted(signal);
            const targetTabId = resolveTargetTabId(request.tabId, sender?.tab?.id, activeTabId);
            const token = await getAuthToken(signal);
            const clientId = await getClientId(false, signal);
            if (!request.url)
                throw new Error("No playlist URL provided");
            // Resolve playlist by URL to get id + next_href if paginated
            const playlistData = await resolveResource(request.url, clientId, token, signal);
            const playlistDetails = (await fetchPlaylistDetails(playlistData?.id || playlistData?.uri, token, clientId, signal)
                .catch((error) => fallbackUnlessAborted(error, signal, null))) || playlistData;
            const tracks = await fetchPlaylistTracks(playlistDetails, token, clientId, false, signal);
            const unique = dedupeTracks(tracks);
            const queueEntries = unique
                .map((track, index) => queueEntryFromTrack(track, index))
                .filter(isQueueEntry);
            const resolvedEntries = await preResolvePlayableQueueEntries(queueEntries, signal);
            const shuffledEntries = shuffleArray(resolvedEntries);
            if (!shuffledEntries.length)
                throw new Error("No playable track URLs found in playlist");
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            await commitPlaybackQueue(shuffledEntries, 0, targetTabId, generation);
            markAdvanced();
            await notifyActiveTabState(signal);
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            log("Shuffle started", { mode: "playlist", count: playbackQueue.length, tabId: activeTabId });
            await playNextInQueue(targetTabId, signal);
            throwIfAborted(signal);
            sendResponse({ success: true, count: playbackQueue.length, mode: "playlist", title: playlistData.title });
        }
        catch (error) {
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            console.error("Shuffle playlist failed", error);
            const detail = describeApiError(error);
            sendResponse({ success: false, error: detail || "Shuffle playlist failed" });
        }
    }
    async function handleShufflePlaylists(request, sender, sendResponse) {
        const generation = beginQueueGeneration();
        const signal = getQueueGenerationSignal(generation);
        try {
            await hydratePlaybackState();
            throwIfAborted(signal);
            const targetTabId = resolveTargetTabId(request.tabId, sender?.tab?.id, activeTabId);
            const token = await getAuthToken(signal);
            const clientId = await getClientId(false, signal);
            if (!request.url)
                throw new Error("Missing url");
            const userId = await resolveUserIdFromUrl(request.url, clientId, token, signal);
            const { items: playlists, endpoint: playlistsEndpoint } = await tryFetchAll([
                `https://api-v2.soundcloud.com/users/${userId}/playlists_without_albums`,
                `https://api-v2.soundcloud.com/users/${userId}/playlists`,
                `https://api-v2.soundcloud.com/users/${userId}/sets`,
            ], token, clientId, signal);
            log("Playlists fetched", { endpoint: playlistsEndpoint, count: playlists.length });
            // The /you/sets library page also lists playlists the user liked, so
            // include those when shuffling from there. Failures are non-fatal.
            const cleanUrl = String(request.url).split("?")[0];
            if (cleanUrl.includes("/you/") || cleanUrl.endsWith("/you")) {
                const likedPlaylists = await fetchAllTracks(`https://api-v2.soundcloud.com/users/${userId}/playlist_likes`, token, clientId, signal).catch((error) => fallbackUnlessAborted(error, signal, []));
                if (likedPlaylists.length) {
                    log("Liked playlists merged", { count: likedPlaylists.length });
                    playlists.push(...likedPlaylists.map((item) => item?.playlist || item));
                }
            }
            const playlistUris = playlists
                .map(extractPlaylistApiUrl)
                .filter((u) => typeof u === "string" && u.includes("api-v2.soundcloud.com/playlists/"));
            if (!playlistUris.length) {
                const sample = playlists
                    .slice(0, 3)
                    .map((p) => Object.keys(p || {}).slice(0, 12))
                    .map((keys) => keys.join(","))
                    .join(" | ");
                throw new Error(`No playlists found for user (sample keys: ${sample || "n/a"})`);
            }
            const trackEntryMap = new Map();
            await mapWithConcurrency(playlistUris, 3, async (uri) => {
                try {
                    const details = (await fetchPlaylistDetails(uri, token, clientId, signal)
                        .catch((error) => fallbackUnlessAborted(error, signal, null))) || { uri };
                    const tracks = await fetchPlaylistTracks(details, token, clientId, false, signal);
                    const flattened = tracks
                        .map((item) => item?.track || item)
                        .filter((track) => track && (track.id || track.permalink_url || track.permalink || track.uri));
                    const unique = dedupeTracks(flattened);
                    for (const track of unique) {
                        const entry = queueEntryFromTrack(track);
                        if (entry?.url && !trackEntryMap.has(entry.url))
                            trackEntryMap.set(entry.url, entry);
                    }
                }
                catch (e) {
                    throwIfAborted(signal);
                    console.warn(LOG_PREFIX, "Playlist skipped (failed to fetch tracks):", errorMessage(e));
                }
            }, signal);
            const queueEntries = Array.from(trackEntryMap.values())
                .map((entry, index) => sanitizeQueueEntry({ ...entry, index }, index))
                .filter(isQueueEntry);
            const resolvedEntries = await preResolvePlayableQueueEntries(queueEntries, signal);
            const shuffledEntries = shuffleArray(resolvedEntries);
            if (!shuffledEntries.length)
                throw new Error("No playable tracks found across playlists");
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            await commitPlaybackQueue(shuffledEntries, 0, targetTabId, generation);
            markAdvanced();
            await notifyActiveTabState(signal);
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            log("Shuffle started", { mode: "playlists", playlists: playlistUris.length, count: playbackQueue.length, tabId: activeTabId });
            await playNextInQueue(targetTabId, signal);
            throwIfAborted(signal);
            sendResponse({ success: true, count: playbackQueue.length, playlists: playlistUris.length, mode: "playlists" });
        }
        catch (error) {
            if (!isCurrentQueueGeneration(generation)) {
                sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
                return;
            }
            console.error("Shuffle playlists failed", error);
            const detail = describeApiError(error);
            sendResponse({ success: false, error: detail || "Shuffle playlists failed" });
        }
    }
    // ---- MESSAGE ROUTING ----
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
        if (req?.type === "GET_STATUS") {
            (async () => {
                await hydratePlaybackState();
                const requesterTabId = resolveTargetTabId(req?.requesterTabId, sender?.tab?.id);
                sendResponse(getStatusSnapshot({ requesterTabId }));
            })().catch((e) => {
                sendResponse({ isShuffling: false, count: 0, currentIndex: 0, error: e?.message || String(e) });
            });
            return true;
        }
        if (req?.type === "GET_QUEUE") {
            (async () => {
                await hydratePlaybackState();
                const requesterTabId = resolveTargetTabId(req?.requesterTabId, sender?.tab?.id);
                const maxItems = typeof req?.maxItems === "number" && Number.isFinite(req.maxItems)
                    ? Math.max(1, Math.min(MAX_POPUP_QUEUE_ITEMS, Math.floor(req.maxItems)))
                    : MAX_POPUP_QUEUE_ITEMS;
                sendResponse({
                    ok: true,
                    ...getStatusSnapshot({ requesterTabId }),
                    currentEntry: playbackQueue[currentIndex] || null,
                    remainingCount: Math.max(playbackQueue.length - currentIndex - 1, 0),
                    upNextEntries: getQueueEntriesForPopup(maxItems),
                });
            })().catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
            return true;
        }
        if (req?.type === "STOP_SHUFFLE") {
            (async () => {
                await stopShuffle();
                sendResponse({ ok: true, ...getStatusSnapshot() });
            })().catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
            return true;
        }
        if (req?.type === "PLAY_QUEUE_INDEX") {
            (async () => {
                await hydratePlaybackState();
                const senderTabId = resolveTargetTabId(req?.tabId, sender?.tab?.id, activeTabId);
                if (senderTabId === null) {
                    sendResponse({ ok: false, error: "No active SoundCloud tab found" });
                    return;
                }
                if (activeTabId === null)
                    activeTabId = senderTabId;
                const result = await playQueueIndex(senderTabId, Number(req?.index));
                sendResponse(result);
            })().catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
            return true;
        }
        // New Context Handler (handles Likes, Reposts, Tracks for ANY user)
        if (req?.type === "START_SHUFFLE_CONTEXT") {
            handleShuffleContext(req, sender, sendResponse);
            return true;
        }
        // Legacy/Popup Handler for "My Likes" (mapped to context)
        if (req?.type === "START_SHUFFLE_LIKES") {
            // Simulate context request for logged in user
            handleShuffleContext({
                type: "START_SHUFFLE_CONTEXT",
                mode: 'likes',
                url: 'https://soundcloud.com/you/likes',
                tabId: req.tabId,
            }, sender, sendResponse);
            return true;
        }
        if (req?.type === "START_SHUFFLE_PLAYLIST") {
            handleShufflePlaylist(req, sender, sendResponse);
            return true;
        }
        if (req?.type === "START_SHUFFLE_PLAYLISTS") {
            handleShufflePlaylists(req, sender, sendResponse);
            return true;
        }
        if (req?.type === "TRACK_FINISHED") {
            (async () => {
                await hydratePlaybackState();
                const senderTabId = sender?.tab?.id;
                if (!isFromActiveTab(senderTabId)) {
                    log("Ignore TRACK_FINISHED from non-controller tab", {
                        senderTabId,
                        activeTabId,
                    });
                    return;
                }
                if (shouldIgnoreTrackFinished()) {
                    log("Ignore TRACK_FINISHED (recent advance)");
                    return;
                }
                if (!playbackQueue.length) {
                    log("TRACK_FINISHED with empty queue (state lost?)");
                    return;
                }
                await commitPlaybackPosition(currentIndex + 1);
                markAdvanced();
                await notifyActiveTabState();
                if (currentIndex < playbackQueue.length) {
                    const tabId = resolveTargetTabId(senderTabId, activeTabId);
                    await playNextInQueue(tabId);
                }
            })()
                .then(() => sendResponse({ ok: true }))
                .catch((e) => {
                console.error("TRACK_FINISHED handler failed", e);
                sendResponse({ ok: false, error: e?.message || String(e) });
            });
            return true;
        }
        if (req?.type === "SKIP_NEXT") {
            (async () => {
                await hydratePlaybackState();
                const senderTabId = sender?.tab?.id;
                if (!isFromActiveTab(senderTabId)) {
                    log("Ignore SKIP_NEXT from non-controller tab", {
                        senderTabId,
                        activeTabId,
                    });
                    return;
                }
                if (playbackQueue.length) {
                    await commitPlaybackPosition(Math.min(currentIndex + 1, playbackQueue.length - 1));
                    markAdvanced();
                    await notifyActiveTabState();
                    await playNextInQueue(resolveTargetTabId(senderTabId, activeTabId));
                }
            })()
                .then(() => sendResponse({ ok: true }))
                .catch((e) => {
                console.error("SKIP_NEXT handler failed", e);
                sendResponse({ ok: false, error: e?.message || String(e) });
            });
            return true;
        }
        if (req?.type === "SKIP_PREV") {
            (async () => {
                await hydratePlaybackState();
                const senderTabId = sender?.tab?.id;
                if (!isFromActiveTab(senderTabId)) {
                    log("Ignore SKIP_PREV from non-controller tab", {
                        senderTabId,
                        activeTabId,
                    });
                    return;
                }
                if (playbackQueue.length) {
                    await commitPlaybackPosition(Math.max(currentIndex - 1, 0));
                    markAdvanced();
                    await notifyActiveTabState();
                    await playNextInQueue(resolveTargetTabId(senderTabId, activeTabId));
                }
            })()
                .then(() => sendResponse({ ok: true }))
                .catch((e) => {
                console.error("SKIP_PREV handler failed", e);
                sendResponse({ ok: false, error: e?.message || String(e) });
            });
            return true;
        }
        return false;
    });
})();
