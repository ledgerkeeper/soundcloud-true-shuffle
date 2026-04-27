(() => {
// SoundCloud True Shuffle background service worker
// Orchestrates auth token discovery, client_id capture, deep fetch, and queue playback.

const APP_VERSION_HINT = "172000";
const LOG_PREFIX = "[SC True Shuffle][bg]";
const STATE_STORAGE_KEY = "sc_shuffle_state_v2";
const PLAYABLE_URL_RESOLVE_CONCURRENCY = 4;
const HARD_NAVIGATION_COOLDOWN_MS = 2500;
const USE_CONTENT_NAVIGATION_PRIMARY = true;
const MAX_POPUP_QUEUE_ITEMS = 50;

type ShuffleMode = "likes" | "tracks" | "reposts" | "all";
type NavigationMode = "content" | "hard";

type QueueEntry = {
  index: number | null;
  url: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
};

type StatusSnapshot = {
  isShuffling: boolean;
  isActiveTab: boolean;
  count: number;
  currentIndex: number;
  activeTabId: number | null;
  currentEntry: QueueEntry | null;
};

type RuntimeRequest = {
  type?: string;
  action?: string;
  mode?: ShuffleMode;
  url?: string;
  permalink?: string;
  tabId?: number | null;
  requesterTabId?: number | null;
  maxItems?: number;
  index?: number;
};

type ApiError = Error & {
  status?: number;
  endpoint?: string;
};

type NavigationOptions = {
  navigationMode?: NavigationMode;
};

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function storageGet<T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) {
  return new Promise<T>((resolve) => {
    try {
      chrome.storage.local.get(keys, (items) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn(LOG_PREFIX, "storage.get failed:", err.message || err);
          resolve({} as T);
          return;
        }
        resolve((items || {}) as T);
      });
    } catch (e) {
      console.warn(LOG_PREFIX, "storage.get threw:", e?.message || e);
      resolve({} as T);
    }
  });
}

function storageSet(items) {
  return new Promise<void>((resolve) => {
    try {
      chrome.storage.local.set(items, () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(LOG_PREFIX, "storage.set failed:", err.message || err);
        resolve();
      });
    } catch (e) {
      console.warn(LOG_PREFIX, "storage.set threw:", e?.message || e);
      resolve();
    }
  });
}

function cookiesGet(details) {
  return new Promise<chrome.cookies.Cookie | null>((resolve) => {
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
    } catch (e) {
      console.warn(LOG_PREFIX, "cookies.get threw:", e?.message || e);
      resolve(null);
    }
  });
}

function tabsSendMessage<T = { ok?: boolean; error?: string }>(tabId: number, message: RuntimeRequest) {
  return new Promise<T>((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message || String(err) } as T);
          return;
        }
        resolve((resp || { ok: true }) as T);
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) } as T);
    }
  });
}

function ensurePlayingAfterNavigation(tabId, url) {
  let attemptsLeft = 24;
  const tick = async () => {
    if (attemptsLeft <= 0) return;
    attemptsLeft -= 1;
    const resp = await tabsSendMessage(tabId, { action: "ENSURE_PLAYING", url });
    if (resp?.ok === true) return;
    if (attemptsLeft <= 0) return;
    setTimeout(tick, 600);
  };
  setTimeout(tick, 1200);
}

async function hydratePlaybackState(force = false) {
  if (!force && stateHydrated) return;
  if (stateHydrating) return stateHydrating;

  stateHydrating = (async () => {
    const stored = await storageGet<{ [STATE_STORAGE_KEY]?: {
      queueUrls?: unknown[];
      queueEntries?: unknown[];
      currentIndex?: number;
      activeTabId?: number;
    } }>(STATE_STORAGE_KEY);
    const state = stored?.[STATE_STORAGE_KEY];
    if (state && Array.isArray(state.queueUrls)) {
      const hydratedEntries = Array.isArray(state.queueEntries)
        ? state.queueEntries
            .map((entry, index) => sanitizeQueueEntry(entry, index))
            .filter(Boolean)
        : state.queueUrls
            .map((url, index) => deriveQueueEntryFromUrl(url, index))
            .filter(Boolean);
      setPlaybackQueueEntries(hydratedEntries, Number.isFinite(state.currentIndex) ? state.currentIndex : 0);
      activeTabId = Number.isFinite(state.activeTabId) ? state.activeTabId : activeTabId;
      log("Hydrated state", { count: playbackQueueUrls.length, index: currentIndex, tabId: activeTabId });
    }
    stateHydrated = true;
  })().finally(() => {
    stateHydrating = null;
  });

  return stateHydrating;
}

async function persistPlaybackState() {
  const state = {
    queueUrls: playbackQueueUrls,
    queueEntries: playbackQueue,
    currentIndex,
    activeTabId,
    savedAt: Date.now(),
  };
  await storageSet({ [STATE_STORAGE_KEY]: state });
}

let playbackQueue: QueueEntry[] = [];
let playbackQueueUrls: string[] = [];
let currentIndex = 0;
let cachedClientId: string | null = null;
let clientIdCheckedAt = 0;
let activeTabId: number | null = null;
let lastAdvanceAt = 0;
let lastHardNavigationAt = 0;
let stateHydrated = false;
let stateHydrating: Promise<void> | null = null;
let queueGeneration = 0;
const CLIENT_ID_TTL_MS = 30 * 60 * 1000;
const CLIENT_ID_WAIT_MS = 7000;
const FALLBACK_CLIENT_ID = ""; // Optional fallback
const pendingClientIdResolvers: Array<{ resolve: (id: string) => void; reject: (error: Error) => void }> = [];
const playableUrlCache = new Map<string, string>();

function beginQueueGeneration() {
  queueGeneration += 1;
  return queueGeneration;
}

function isCurrentQueueGeneration(generation: number) {
  return generation === queueGeneration;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tabsUpdate(tabId: number, updateProperties: chrome.tabs.UpdateProperties) {
  return new Promise<{ ok: boolean; tab?: chrome.tabs.Tab | null; error?: string }>((resolve) => {
    try {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message || String(err) });
          return;
        }
        resolve({ ok: true, tab: tab || null });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

function resolveTargetTabId(...candidates: Array<number | null | undefined>) {
  for (const candidate of candidates) {
    if (Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function isFromActiveTab(senderTabId: number | null | undefined) {
  if (!Number.isFinite(activeTabId)) return true;
  if (!Number.isFinite(senderTabId)) return true;
  return senderTabId === activeTabId;
}

function sanitizeQueueEntry(entry: any, fallbackIndex: number | null = null): QueueEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const url = typeof entry.url === "string" && entry.url.startsWith("http") ? entry.url : null;
  if (!url) return null;
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

function deriveQueueEntryFromUrl(url: unknown, index: number | null = null): QueueEntry | null {
  if (typeof url !== "string" || !url.startsWith("http")) return null;
  let title = url;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    title = decodeURIComponent(parts[parts.length - 1] || url).replace(/[-_]+/g, " ");
  } catch {}
  return {
    index,
    url,
    title,
    artist: "",
    artworkUrl: null,
  };
}

function queueEntryFromTrack(track: any, index: number | null = null): QueueEntry | null {
  const url = normalizeTrackUrl(track);
  if (!url) return null;
  return sanitizeQueueEntry({
    index,
    url,
    title: track?.title || "Untitled track",
    artist: track?.user?.username || track?.publisher_metadata?.artist || "",
    artworkUrl: track?.artwork_url || track?.user?.avatar_url || null,
  }, index);
}

function setPlaybackQueueEntries(entries: QueueEntry[], startingIndex = 0) {
  playbackQueue = entries
    .map((entry, index) => sanitizeQueueEntry({ ...entry, index }, index))
    .filter(Boolean);
  playbackQueueUrls = playbackQueue.map((entry) => entry.url);
  currentIndex = Math.max(0, Math.min(startingIndex, Math.max(playbackQueueUrls.length - 1, 0)));
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
async function getAuthToken(): Promise<string | null> {
  const cookie = await cookiesGet({
    url: "https://soundcloud.com",
    name: "oauth_token",
  });
  return cookie ? cookie.value : null;
}

// Resolve client_id by passively intercepting outbound API calls or cached storage
async function getClientId(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedClientId && now - clientIdCheckedAt < CLIENT_ID_TTL_MS) {
    return cachedClientId;
  }

  if (!cachedClientId) {
    const stored = await storageGet<{ client_id?: string }>("client_id");
    if (stored?.client_id) {
      cachedClientId = stored.client_id;
      clientIdCheckedAt = now;
      return cachedClientId;
    }
  }

  return new Promise((resolve, reject) => {
    pendingClientIdResolvers.push({ resolve, reject });
    setTimeout(() => {
      const cid = cachedClientId || FALLBACK_CLIENT_ID;
      if (cid) {
        cachedClientId = cid;
        clientIdCheckedAt = Date.now();
        storageSet({ client_id: cid }).finally(() => resolve(cid));
      } else {
        reject(new Error("Unable to resolve client_id (no network capture). Try playing a track first."));
      }
    }, CLIENT_ID_WAIT_MS);
  });
}

function rememberClientId(id) {
  if (!id) return;
  cachedClientId = id;
  clientIdCheckedAt = Date.now();
  storageSet({ client_id: id });
  log("Captured client_id");
  while (pendingClientIdResolvers.length) {
    const { resolve } = pendingClientIdResolvers.shift();
    resolve(id);
  }
}

// Passive capture of client_id from SC API traffic
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const url = new URL(details.url);
      const cid = url.searchParams.get("client_id");
      if (cid) rememberClientId(cid);
    } catch (e) {
      console.warn("onBeforeRequest parse failed", e?.message);
    }
  },
  { urls: ["*://api-v2.soundcloud.com/*"] },
  []
);

// Hydrate caches on startup
(async () => {
  const stored = await storageGet<{ client_id?: string }>("client_id");
  if (stored?.client_id) {
    cachedClientId = stored.client_id;
    clientIdCheckedAt = Date.now();
  }
})();

(async () => {
  await hydratePlaybackState(true);
})();

// Fetch likes or playlist tracks (handles pagination via next_href)
async function fetchAllTracks(endpoint, token, clientId, accumulated = []) {
  const url = new URL(endpoint);
  if (!url.searchParams.has("client_id")) url.searchParams.set("client_id", clientId);
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "200");
  if (!url.searchParams.has("linked_partitioning")) url.searchParams.set("linked_partitioning", "1");
  if (!url.searchParams.has("app_version") && APP_VERSION_HINT) {
    url.searchParams.set("app_version", APP_VERSION_HINT);
  }

  const headers = token ? { Authorization: `OAuth ${token}` } : {};
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
      const err: ApiError = new Error(`API error ${response.status}`);
    err.status = response.status;
    err.endpoint = url.toString();
    throw err;
  }

  const data = await response.json();
  // Handle different response structures (playlists have .tracks, collections have .collection)
  const tracks = (data.collection || data.tracks || []).map((item) => item.track || item);
  const next = data.next_href;
  const nextAccumulated = accumulated.concat(tracks);

  if (next) {
    return fetchAllTracks(next, token, clientId, nextAccumulated);
  }
  return nextAccumulated;
}

async function tryFetchAll(endpoints, token, clientId) {
  let lastError = null;
  for (const endpoint of endpoints) {
    if (!endpoint) continue;
    try {
      const items = await fetchAllTracks(endpoint, token, clientId);
      return { items, endpoint };
    } catch (e) {
      lastError = e;
      if (e?.status === 404) continue;
      if (e?.status === 401 || e?.status === 403) continue;
    }
  }
  throw lastError || new Error("All endpoints failed");
}

async function fetchJson(url, token) {
  const headers = token ? { Authorization: `OAuth ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err: ApiError = new Error(`API error ${res.status}`);
    err.status = res.status;
    err.endpoint = url;
    throw err;
  }
  return res.json();
}

function extractPlaylistId(input) {
  if (!input) return null;
  if (typeof input === "number") return input;
  if (typeof input === "string") {
    const match = input.match(/\/playlists\/(\d+)/);
    if (match?.[1]) return Number(match[1]);
    return null;
  }
  if (typeof input === "object") {
    if (input.id) return Number(input.id);
    const uri = input.uri;
    if (typeof uri === "string") return extractPlaylistId(uri);
  }
  return null;
}

async function fetchPlaylistDetails(playlistIdOrUri, token, clientId) {
  if (!playlistIdOrUri) return null;
  const maybeId = extractPlaylistId(playlistIdOrUri);
  const url = new URL(
    typeof playlistIdOrUri === "string" && playlistIdOrUri.startsWith("http")
      ? playlistIdOrUri
      : `https://api-v2.soundcloud.com/playlists/${maybeId || playlistIdOrUri}`
  );
  if (!url.searchParams.has("client_id")) url.searchParams.set("client_id", clientId);
  if (APP_VERSION_HINT && !url.searchParams.has("app_version")) url.searchParams.set("app_version", APP_VERSION_HINT);
  if (!url.searchParams.has("representation")) url.searchParams.set("representation", "full");
  return fetchJson(url.toString(), token);
}

async function fetchPlaylistTracksOffset(endpoint, token, clientId, expectedCount) {
  const seen = new Set();
  let offset = 0;
  const limit = 200;
  const results = [];

  while (true) {
    const url = new URL(endpoint);
    if (!url.searchParams.has("client_id")) url.searchParams.set("client_id", clientId);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("linked_partitioning", "1");
    if (APP_VERSION_HINT && !url.searchParams.has("app_version")) url.searchParams.set("app_version", APP_VERSION_HINT);

    const data = await fetchJson(url.toString(), token);
    const page = (data?.collection || data?.tracks || []).map((item) => item.track || item);
    if (!page.length) break;

    let added = 0;
    for (const item of page) {
      const key =
        item?.id ? `id:${item.id}` :
        item?.permalink_url ? `url:${item.permalink_url}` :
        item?.uri ? `uri:${item.uri}` :
        null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
      added += 1;
    }

    if (added === 0) break;
    offset += page.length;
    if (expectedCount && results.length >= expectedCount) break;
    if (page.length < limit) break;
  }

  return results;
}

async function fetchPlaylistTracks(playlistData, token, clientId, triedDetails = false) {
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
    const { items, endpoint } = await tryFetchAll(candidates, token, clientId);
    if (trackCount && items.length < trackCount) {
      const offsetItems = await fetchPlaylistTracksOffset(endpoint, token, clientId, trackCount);
      if (offsetItems.length) {
        log("Playlist tracks fetched (offset)", { endpoint, count: offsetItems.length });
        return offsetItems;
      }
    }
    log("Playlist tracks fetched", { endpoint, count: items.length, trackCount });
    return items;
  } catch (e) {
    if (!triedDetails && (playlistId || playlistUri)) {
      try {
        const details = await fetchPlaylistDetails(playlistId || playlistUri, token, clientId);
        if (details) return fetchPlaylistTracks(details, token, clientId, true);
      } catch (detailErr) {
        console.warn(LOG_PREFIX, "Playlist detail fetch failed:", detailErr?.message || detailErr);
      }
    }

    if (embedded && embedded.length > 5 && (trackCount === null || embedded.length >= trackCount)) {
      log("Playlist using embedded tracks", { count: embedded.length });
      return embedded;
    }
    throw e;
  }
}

async function resolveMe(token, clientId) {
  if (!token) throw new Error("Login required for /you (no oauth_token cookie)");
  const res = await fetch("https://api-v2.soundcloud.com/me", {
    headers: {
      Authorization: `OAuth ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Failed to resolve /me (${res.status})`);
  return res.json();
}

async function resolveResource(url, clientId, token) {
  const resolveUrl = new URL("https://api-v2.soundcloud.com/resolve");
  resolveUrl.searchParams.set("url", url);
  resolveUrl.searchParams.set("client_id", clientId);
  if (APP_VERSION_HINT) resolveUrl.searchParams.set("app_version", APP_VERSION_HINT);

  const headers = token ? { Authorization: `OAuth ${token}` } : {};
  const res = await fetch(resolveUrl.toString(), { headers });
  if (!res.ok) throw new Error(`Resolve failed ${res.status} for ${url}`);
  return res.json();
}

async function resolveUserIdFromUrl(inputUrl, clientId, token) {
  if (!inputUrl) throw new Error("Missing url");
  const cleanUrl = String(inputUrl).split("?")[0];

  if (cleanUrl.includes("/you/") || cleanUrl.endsWith("/you")) {
    const me = await resolveMe(token, clientId);
    if (!me?.id) throw new Error("Unable to resolve /me");
    return me.id;
  }

  const profileUrl = cleanUrl.replace(/\/(likes|reposts|tracks|recommended|sets)\/?$/, "");
  const resolved = await resolveResource(profileUrl, clientId, token);
  const userId = resolved?.id || resolved?.user_id || resolved?.creator?.id;
  if (!userId) throw new Error("Unable to resolve user id from url");
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
    const key =
      track?.id ? `id:${track.id}` :
      track?.permalink_url ? `url:${track.permalink_url}` :
      track?.uri ? `uri:${track.uri}` :
      null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(track);
  }
  return unique;
}

function normalizeTrackUrl(track) {
  const permalinkUrl = track?.permalink_url;
  if (typeof permalinkUrl === "string" && permalinkUrl.startsWith("http")) return permalinkUrl;

  const permalink = track?.permalink;
  if (typeof permalink === "string" && permalink) {
    if (permalink.startsWith("http")) return permalink;
    if (permalink.includes("/")) return `https://soundcloud.com/${permalink.replace(/^\//, "")}`;
    const userPermalink = track?.user?.permalink;
    if (userPermalink) return `https://soundcloud.com/${userPermalink}/${permalink}`;
  }

  const uri = track?.uri;
  if (typeof uri === "string" && uri.startsWith("http")) return uri;

  const id = track?.id;
  if (Number.isFinite(id)) return `https://api-v2.soundcloud.com/tracks/${id}`;

  const urn = track?.urn || track?.uri;
  if (typeof urn === "string") {
    const match = urn.match(/soundcloud:tracks:(\d+)/);
    if (match?.[1]) return `https://api-v2.soundcloud.com/tracks/${match[1]}`;
  }

  return null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
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
    if (uri.includes("/playlists/")) return uri;
    if (uri.includes("/sets/")) return uri.replace("/sets/", "/playlists/");
  }
  const id = candidate?.id;
  if (id) return `https://api-v2.soundcloud.com/playlists/${id}`;
  return null;
}

async function toPlayableSoundCloudUrl(url) {
  if (!url) return null;
  if (playableUrlCache.has(url)) return playableUrlCache.get(url);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const hostname = (parsed.hostname || "").toLowerCase();

  // Resolve api-v2 track URLs to a public permalink URL before navigation.
  if (hostname === "api-v2.soundcloud.com" && parsed.pathname.startsWith("/tracks/")) {
    try {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const trackId = parts[1];
      if (!trackId || !/^\d+$/.test(trackId)) return null;

      const clientId = await getClientId().catch(() => null);
      const token = await getAuthToken().catch(() => null);
      const apiUrl = new URL(`https://api-v2.soundcloud.com/tracks/${trackId}`);
      if (clientId && !apiUrl.searchParams.has("client_id")) apiUrl.searchParams.set("client_id", clientId);
      if (APP_VERSION_HINT && !apiUrl.searchParams.has("app_version")) apiUrl.searchParams.set("app_version", APP_VERSION_HINT);
      const headers = token ? { Authorization: `OAuth ${token}` } : {};
      const res = await fetch(apiUrl.toString(), { headers });
      if (!res.ok) return null;
      const data = await res.json();
      const permalinkUrl = data?.permalink_url;
      if (typeof permalinkUrl === "string" && permalinkUrl.startsWith("http")) {
        playableUrlCache.set(url, permalinkUrl);
        return permalinkUrl;
      }
      return null;
    } catch (e) {
      console.warn(LOG_PREFIX, "Failed to resolve API track URL", e?.message || e);
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

async function preResolvePlayableQueueUrls(urls) {
  const uniqueUrls = Array.from(new Set(urls.filter(Boolean)));
  if (!uniqueUrls.length) return [];

  const resolvedUnique = await mapWithConcurrency(
    uniqueUrls,
    PLAYABLE_URL_RESOLVE_CONCURRENCY,
    async (url) => (await toPlayableSoundCloudUrl(url)) || url
  );

  const resolvedMap = new Map();
  uniqueUrls.forEach((url, index) => {
    resolvedMap.set(url, resolvedUnique[index] || url);
  });

  return Array.from(new Set(urls.map((url) => resolvedMap.get(url) || url)));
}

async function preResolvePlayableQueueEntries(entries) {
  const uniqueUrls = Array.from(new Set(entries.map((entry) => entry?.url).filter(Boolean)));
  if (!uniqueUrls.length) return [];

  const resolvedUnique = await mapWithConcurrency(
    uniqueUrls,
    PLAYABLE_URL_RESOLVE_CONCURRENCY,
    async (url) => (await toPlayableSoundCloudUrl(url)) || url
  );

  const resolvedMap = new Map();
  uniqueUrls.forEach((url, index) => {
    resolvedMap.set(url, resolvedUnique[index] || url);
  });

  const seenResolved = new Set();
  const resolvedEntries = [];
  for (const entry of entries) {
    const safeEntry = sanitizeQueueEntry(entry);
    if (!safeEntry) continue;
    const resolvedUrl = resolvedMap.get(safeEntry.url) || safeEntry.url;
    if (!resolvedUrl || seenResolved.has(resolvedUrl)) continue;
    seenResolved.add(resolvedUrl);
    resolvedEntries.push({
      ...safeEntry,
      url: resolvedUrl,
    });
  }

  return resolvedEntries;
}

async function tryPlayViaContentNavigation(tabId, url) {
  const resp = await tabsSendMessage(tabId, { action: "NAVIGATE_AND_PLAY", url });
  if (resp?.ok === true) return true;
  log("Content navigation failed, fallback required", {
    tabId,
    url,
    error: resp?.error || resp || null,
  });
  return false;
}

async function fallbackToHardNavigation(tabId, url) {
  const remainingCooldown = HARD_NAVIGATION_COOLDOWN_MS - (Date.now() - lastHardNavigationAt);
  if (remainingCooldown > 0) {
    await sleep(remainingCooldown);
  }

  lastHardNavigationAt = Date.now();
  log("Navigate fallback (tabs.update)", { tabId, url });
  const nav = await tabsUpdate(tabId, { url });
  if (!nav.ok) {
    console.warn(LOG_PREFIX, "tabs.update fallback failed", nav.error);
    return false;
  }

  ensurePlayingAfterNavigation(tabId, url);
  return true;
}

async function playNextInQueue(tabId: number | null, options: NavigationOptions = {}) {
  const navigationMode = options?.navigationMode === "hard" ? "hard" : "content";
  const targetTabId = tabId || activeTabId;
  if (!targetTabId || !playbackQueueUrls.length || currentIndex >= playbackQueueUrls.length) return;
  const url = playbackQueueUrls[currentIndex];
  if (!url) {
    console.warn("Missing URL at index, skipping", currentIndex);
    currentIndex += 1;
    persistPlaybackState();
    await playNextInQueue(targetTabId, options);
    return;
  }

  const playableUrl = await toPlayableSoundCloudUrl(url);
  if (!playableUrl) {
    console.warn("Unplayable URL, skipping", url);
    currentIndex += 1;
    await persistPlaybackState();
    await playNextInQueue(targetTabId, options);
    return;
  }

  if (playableUrl !== url) {
    playbackQueueUrls[currentIndex] = playableUrl;
    if (playbackQueue[currentIndex]) playbackQueue[currentIndex].url = playableUrl;
    await persistPlaybackState();
  }

  if (USE_CONTENT_NAVIGATION_PRIMARY && navigationMode === "content") {
    log("Navigate (content primary)", { tabId: targetTabId, index: currentIndex, url: playableUrl });
    const playedViaContent = await tryPlayViaContentNavigation(targetTabId, playableUrl);
    if (playedViaContent) return;
  }

  await fallbackToHardNavigation(targetTabId, playableUrl);
}

function shouldIgnoreTrackFinished() {
  const now = Date.now();
  if (now - lastAdvanceAt < 1500) return true;
  return false;
}

function markAdvanced() {
  lastAdvanceAt = Date.now();
}

function getStatusSnapshot(options: { requesterTabId?: number | null } = {}): StatusSnapshot {
  const isShuffling = playbackQueueUrls.length > 0 && currentIndex < playbackQueueUrls.length;
  const requesterTabId = Number.isFinite(options?.requesterTabId) ? options.requesterTabId : null;
  const isActiveTab =
    requesterTabId === null ||
    !Number.isFinite(activeTabId) ||
    requesterTabId === activeTabId;
  return {
    isShuffling,
    isActiveTab,
    count: playbackQueueUrls.length,
    currentIndex,
    activeTabId,
    currentEntry: playbackQueue[currentIndex] || null,
  };
}

async function notifyActiveTabState() {
  const tabId = activeTabId;
  if (!Number.isFinite(tabId)) return;
  await tabsSendMessage(tabId, {
    action: "SC_SHUFFLE_STATE",
    ...getStatusSnapshot({ requesterTabId: tabId }),
  });
}

async function stopShuffle() {
  beginQueueGeneration();
  setPlaybackQueueEntries([], 0);
  await persistPlaybackState();
  await notifyActiveTabState();
}

async function playQueueIndex(tabId: number, index: number, navigationMode: NavigationMode = "content") {
  if (!playbackQueueUrls.length) return { ok: false, error: "Queue is empty" };
  if (!Number.isFinite(index) || index < 0 || index >= playbackQueueUrls.length) {
    return { ok: false, error: "Invalid queue index" };
  }
  currentIndex = index;
  markAdvanced();
  await persistPlaybackState();
  await notifyActiveTabState();
  await playNextInQueue(tabId, { navigationMode });
  return { ok: true, ...getStatusSnapshot({ requesterTabId: tabId }) };
}

// ---- CORE LOGIC HANDLERS ----

async function handleShuffleContext(request: RuntimeRequest, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) {
  const generation = beginQueueGeneration();
  try {
    activeTabId = request.tabId || sender?.tab?.id || activeTabId;
    const token = await getAuthToken();
    const clientId = await getClientId();
    if (!request.url || !request.mode) throw new Error("Missing url or mode");

    const userId = await resolveUserIdFromUrl(request.url, clientId, token);

    let flattened = [];

    if (request.mode === "likes") {
      const endpoint = `https://api-v2.soundcloud.com/users/${userId}/track_likes`;
      const rawItems = await fetchAllTracks(endpoint, token, clientId);
      flattened = rawItems.map((item) => item?.track || item);
    } else if (request.mode === "tracks") {
      const endpoint = `https://api-v2.soundcloud.com/users/${userId}/tracks`;
      const rawItems = await fetchAllTracks(endpoint, token, clientId);
      flattened = rawItems.map((item) => item?.track || item);
    } else if (request.mode === "reposts") {
      const { items, endpoint } = await tryFetchAll(
        [
          `https://api-v2.soundcloud.com/users/${userId}/track_reposts`,
          `https://api-v2.soundcloud.com/users/${userId}/reposts`,
          `https://api-v2.soundcloud.com/stream/users/${userId}/reposts`,
        ],
        token,
        clientId
      );
      log("Reposts fetched", { endpoint, count: items.length });
      flattened = items.map((item) => item?.track || item);
    } else if (request.mode === "all") {
      const tracksEndpoint = `https://api-v2.soundcloud.com/users/${userId}/tracks`;
      const tracksPromise = fetchAllTracks(tracksEndpoint, token, clientId);
      const repostsPromise = tryFetchAll(
        [
          `https://api-v2.soundcloud.com/users/${userId}/track_reposts`,
          `https://api-v2.soundcloud.com/users/${userId}/reposts`,
          `https://api-v2.soundcloud.com/stream/users/${userId}/reposts`,
        ],
        token,
        clientId
      ).then((r) => r.items).catch(() => []);
      const [tracksRaw, repostsRaw] = await Promise.all([tracksPromise, repostsPromise]);
      flattened = tracksRaw.concat(repostsRaw).map((item) => item?.track || item);
    } else {
      throw new Error("Unknown mode");
    }

    flattened = flattened.filter((t) => t && (t.id || t.permalink_url || t.permalink || t.uri));

    const unique = dedupeTracks(flattened);
    const queueEntries = unique
      .map((track, index) => queueEntryFromTrack(track, index))
      .filter(Boolean);
    const resolvedEntries = await preResolvePlayableQueueEntries(queueEntries);
    const shuffledEntries = shuffleArray(resolvedEntries);
    if (!shuffledEntries.length) throw new Error("No playable track URLs found for context");
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    setPlaybackQueueEntries(shuffledEntries, 0);
    markAdvanced();
    await persistPlaybackState();
    await notifyActiveTabState();
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    log("Shuffle started", { mode: request.mode, count: playbackQueueUrls.length, tabId: activeTabId });
    await playNextInQueue(activeTabId, { navigationMode: "content" });
    sendResponse({ success: true, count: playbackQueueUrls.length, mode: request.mode });
  } catch (error) {
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    console.error("Shuffle context failed", error);
    const detail = error?.endpoint ? `${error.message} (${error.endpoint})` : error?.message;
    sendResponse({ success: false, error: detail || "Shuffle context failed" });
  }
}

async function handleShufflePlaylist(request: RuntimeRequest, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) {
  const generation = beginQueueGeneration();
  try {
    activeTabId = request.tabId || sender?.tab?.id || activeTabId;
    const token = await getAuthToken();
    const clientId = await getClientId();
    if (!request.url) throw new Error("No playlist URL provided");

    // Resolve playlist by URL to get id + next_href if paginated
    const playlistData = await resolveResource(request.url, clientId, token);
    const playlistDetails = (await fetchPlaylistDetails(playlistData?.id || playlistData?.uri, token, clientId).catch(() => null)) || playlistData;
    const tracks = await fetchPlaylistTracks(playlistDetails, token, clientId);

    const unique = dedupeTracks(tracks);
    const queueEntries = unique
      .map((track, index) => queueEntryFromTrack(track, index))
      .filter(Boolean);
    const resolvedEntries = await preResolvePlayableQueueEntries(queueEntries);
    const shuffledEntries = shuffleArray(resolvedEntries);
    if (!shuffledEntries.length) throw new Error("No playable track URLs found in playlist");
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    setPlaybackQueueEntries(shuffledEntries, 0);
    markAdvanced();
    await persistPlaybackState();
    await notifyActiveTabState();
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    log("Shuffle started", { mode: "playlist", count: playbackQueueUrls.length, tabId: activeTabId });
    await playNextInQueue(activeTabId, { navigationMode: "content" });
    sendResponse({ success: true, count: playbackQueueUrls.length, mode: "playlist", title: playlistData.title });
  } catch (error) {
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    console.error("Shuffle playlist failed", error);
    const detail = error?.endpoint ? `${error.message} (${error.endpoint})` : error?.message;
    sendResponse({ success: false, error: detail || "Shuffle playlist failed" });
  }
}

async function handleShufflePlaylists(request: RuntimeRequest, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) {
  const generation = beginQueueGeneration();
  try {
    activeTabId = request.tabId || sender?.tab?.id || activeTabId;
    const token = await getAuthToken();
    const clientId = await getClientId();
    if (!request.url) throw new Error("Missing url");

    const userId = await resolveUserIdFromUrl(request.url, clientId, token);

    const { items: playlists, endpoint: playlistsEndpoint } = await tryFetchAll(
      [
        `https://api-v2.soundcloud.com/users/${userId}/playlists_without_albums`,
        `https://api-v2.soundcloud.com/users/${userId}/playlists`,
        `https://api-v2.soundcloud.com/users/${userId}/sets`,
      ],
      token,
      clientId
    );
    log("Playlists fetched", { endpoint: playlistsEndpoint, count: playlists.length });

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
        const details = (await fetchPlaylistDetails(uri, token, clientId).catch(() => null)) || { uri };
        const tracks = await fetchPlaylistTracks(details, token, clientId);
        const flattened = tracks.map((item) => item?.track || item).filter((t) => t && (t.id || t.permalink_url || t.permalink || t.uri));
        const unique = dedupeTracks(flattened);
        for (const track of unique) {
          const entry = queueEntryFromTrack(track);
          if (entry?.url && !trackEntryMap.has(entry.url)) trackEntryMap.set(entry.url, entry);
        }
      } catch (e) {
        console.warn(LOG_PREFIX, "Playlist skipped (failed to fetch tracks):", e?.message || e);
      }
    });

    const queueEntries = Array.from(trackEntryMap.values())
      .map((entry, index) => sanitizeQueueEntry({ ...entry, index }, index))
      .filter(Boolean);
    const resolvedEntries = await preResolvePlayableQueueEntries(queueEntries);
    const shuffledEntries = shuffleArray(resolvedEntries);
    if (!shuffledEntries.length) throw new Error("No playable tracks found across playlists");
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }

    setPlaybackQueueEntries(shuffledEntries, 0);
    markAdvanced();
    await persistPlaybackState();
    await notifyActiveTabState();
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    log("Shuffle started", { mode: "playlists", playlists: playlistUris.length, count: playbackQueueUrls.length, tabId: activeTabId });
    await playNextInQueue(activeTabId, { navigationMode: "content" });
    sendResponse({ success: true, count: playbackQueueUrls.length, playlists: playlistUris.length, mode: "playlists" });
  } catch (error) {
    if (!isCurrentQueueGeneration(generation)) {
      sendResponse({ success: false, superseded: true, error: "Shuffle request was superseded" });
      return;
    }
    console.error("Shuffle playlists failed", error);
    const detail = error?.endpoint ? `${error.message} (${error.endpoint})` : error?.message;
    sendResponse({ success: false, error: detail || "Shuffle playlists failed" });
  }
}

// ---- MESSAGE ROUTING ----

chrome.runtime.onMessage.addListener((req: RuntimeRequest, sender, sendResponse) => {
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
      const maxItems = Number.isFinite(req?.maxItems)
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
      if (!Number.isFinite(senderTabId)) {
        sendResponse({ ok: false, error: "No active SoundCloud tab found" });
        return;
      }
      if (!Number.isFinite(activeTabId)) activeTabId = senderTabId;
      const result = await playQueueIndex(senderTabId, Number(req?.index), "content");
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
        ...req,
        mode: 'likes',
        url: 'https://soundcloud.com/you/likes' 
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
      if (!playbackQueueUrls.length) {
        log("TRACK_FINISHED with empty queue (state lost?)");
        return;
      }
      markAdvanced();
      currentIndex += 1;
      await persistPlaybackState();
      await notifyActiveTabState();
      if (currentIndex < playbackQueueUrls.length) {
        const tabId = resolveTargetTabId(senderTabId, activeTabId);
        await playNextInQueue(tabId, { navigationMode: "content" });
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error("TRACK_FINISHED handler failed", e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      });
    return true;
  }

  if (req?.type === "NAVIGATE_REQUEST" && req.permalink) {
    const senderTabId = sender?.tab?.id;
    if (!isFromActiveTab(senderTabId)) return false;
    const tabId = resolveTargetTabId(senderTabId, activeTabId);
    if (tabId) {
      chrome.tabs.update(tabId, { url: req.permalink });
    }
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
      if (playbackQueueUrls.length) {
        markAdvanced();
        currentIndex = Math.min(currentIndex + 1, playbackQueueUrls.length - 1);
        await persistPlaybackState();
        await notifyActiveTabState();
        await playNextInQueue(resolveTargetTabId(senderTabId, activeTabId), { navigationMode: "content" });
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
      if (playbackQueueUrls.length) {
        markAdvanced();
        currentIndex = Math.max(currentIndex - 1, 0);
        await persistPlaybackState();
        await notifyActiveTabState();
        await playNextInQueue(resolveTargetTabId(senderTabId, activeTabId), { navigationMode: "content" });
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error("SKIP_PREV handler failed", e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      });
    return true;
  }
});
})();
