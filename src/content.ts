(() => {
// Content-script bridge: injects native controller, UI hooks, and reliably detects track end

const LOG_PREFIX = "[SC True Shuffle Listener]";
let showToastTimer = 0;
let ensurePlayingLastKickAt = 0;
let timelineEndSeekWatcherBound = false;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

const shuffleRuntime = {
  isShuffling: false,
  isActiveTab: true,
  lastStatusAt: 0,
};

function updateRuntimeFromStatus(status) {
  if (status && typeof status.isShuffling === "boolean") {
    const isActiveTab = status.isActiveTab !== false;
    shuffleRuntime.isActiveTab = isActiveTab;
    shuffleRuntime.isShuffling = status.isShuffling && isActiveTab;
  }
  shuffleRuntime.lastStatusAt = Date.now();

  if (!shuffleRuntime.isShuffling) {
    removeFooterButtons();
    unbindAudioEndListener();
    state.manualSeekNearEndAt = 0;
    state.repeatSkipLoggedAt = 0;
    state.lastRepeatMode = "off";
    state.pendingAdvanceUntil = 0;
    state.pendingAdvanceUrl = null;
    state.pendingExpectedUrl = null;
    state.lastAdvanceKickAt = 0;
  }
}

function refreshStatus() {
  safeSendMessage({ type: "GET_STATUS" }, (resp) => {
    const err = chrome.runtime.lastError;
    if (err) return;
    updateRuntimeFromStatus(resp);
  });
}

function safeSendMessage(message, callback) {
  try {
    chrome.runtime.sendMessage(message, callback);
    return true;
  } catch (e) {
    log("chrome.runtime.sendMessage threw:", e?.message || e);
    showToast("Extension reloaded. Refresh the tab.", true);
    return false;
  }
}

function sendToBackground(message) {
  safeSendMessage(message, () => {
    const err = chrome.runtime.lastError;
    if (err) log("sendMessage failed:", err.message || err);
  });
}

function showToast(text, isError = false) {
  ensureGlassStyles();
  let toast = document.getElementById("sc-shuffle-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "sc-shuffle-toast";
    toast.style.position = "fixed";
    toast.style.left = "16px";
    toast.style.bottom = "92px";
    toast.style.zIndex = "2147483647";
    toast.style.maxWidth = "320px";
    toast.style.padding = "10px 12px";
    toast.style.borderRadius = "14px";
    toast.style.fontSize = "12px";
    toast.style.fontWeight = "700";
    toast.style.pointerEvents = "none";
    toast.style.backdropFilter = "blur(14px)";
    (toast.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = "blur(14px)";
    toast.style.background = "rgba(255, 255, 255, 0.65)";
    toast.style.border = "1px solid rgba(255, 85, 0, 0.28)";
    toast.style.boxShadow = "0 10px 30px rgba(0,0,0,0.14)";
    toast.style.color = "#ff5500";
    document.body.appendChild(toast);
  }

  toast.textContent = text;
  toast.style.borderColor = isError ? "rgba(255, 80, 80, 0.35)" : "rgba(255, 85, 0, 0.28)";
  toast.style.color = isError ? "rgb(200, 40, 40)" : "#ff5500";
  toast.style.display = "block";

  clearTimeout(showToastTimer);
  showToastTimer = window.setTimeout(() => {
    const el = document.getElementById("sc-shuffle-toast");
    if (el) el.style.display = "none";
  }, 4500);
}

function sendToBackgroundWithResult(message, actionLabel) {
  showToast(actionLabel || "Working...");
  safeSendMessage(message, (resp) => {
    const err = chrome.runtime.lastError;
    if (err) {
      log("sendMessage failed:", err.message || err);
      showToast(err.message || "Background not available", true);
      return;
    }
    if (resp?.success) {
      const count = typeof resp.count === "number" ? resp.count : null;
      showToast(count !== null ? `Shuffling ${count} tracks` : "Shuffle started");
      return;
    }
    if (resp?.ok) {
      showToast("OK");
      return;
    }
    if (resp?.error) {
      showToast(resp.error, true);
      return;
    }
    showToast("No response", true);
  });
}

function ensureGlassStyles() {
  if (document.getElementById("sc-shuffle-glass-style")) return;
  const style = document.createElement("style");
  style.id = "sc-shuffle-glass-style";
  style.textContent = `
    .sc-shuffle-glass {
      border-radius: 14px !important;
      background: rgba(255, 255, 255, 0.55) !important;
      border: 1px solid rgba(255, 85, 0, 0.28) !important;
      color: #ff5500 !important;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      transition: background 120ms ease, transform 120ms ease !important;
    }
    .sc-shuffle-glass:hover {
      background: rgba(255, 255, 255, 0.66) !important;
    }
    .sc-shuffle-glass:active {
      transform: translateY(1px) !important;
    }
    .sc-shuffle-glass-icon {
      border-radius: 10px !important;
      background: rgba(255, 255, 255, 0.14) !important;
      border: 1px solid rgba(255, 255, 255, 0.22) !important;
      color: rgba(255, 255, 255, 0.92) !important;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
    }
    .sc-shuffle-glass-icon:hover {
      background: rgba(255, 255, 255, 0.18) !important;
    }
    .sc-shuffle-glass-icon:active {
      transform: translateY(1px) !important;
    }
    .sc-shuffle-skip {
      width: 36px !important;
      height: 36px !important;
      min-width: 36px !important;
      padding: 0 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      line-height: 0 !important;
    }
    .sc-shuffle-skip svg {
      width: 16px !important;
      height: 16px !important;
      display: block !important;
    }
    #sc-shuffle-footer-group {
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      margin-left: 12px !important;
      padding-left: 12px !important;
      border-left: 1px solid rgba(18, 18, 18, 0.12) !important;
      line-height: 1 !important;
    }
    .sc-shuffle-footer-btn {
      width: 36px !important;
      height: 36px !important;
      min-width: 36px !important;
      border-radius: 999px !important;
      border: 1px solid rgba(18, 18, 18, 0.12) !important;
      background: rgba(255, 255, 255, 0.7) !important;
      color: #ff5500 !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08) !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
      transition: transform 120ms ease, background 120ms ease, border-color 120ms ease !important;
    }
    .sc-shuffle-footer-btn:hover {
      background: rgba(255, 255, 255, 0.92) !important;
      border-color: rgba(255, 85, 0, 0.26) !important;
    }
    .sc-shuffle-footer-btn:active {
      transform: translateY(1px) !important;
    }
    .sc-shuffle-footer-btn.sc-shuffle-footer-btn--stop {
      color: #121212 !important;
      background: rgba(255, 85, 0, 0.14) !important;
    }
    #sc-shuffle-fallback-actions {
      position: fixed !important;
      top: 60px !important;
      right: 24px !important;
      z-index: 2147483000 !important;
      display: flex !important;
      gap: 8px !important;
      align-items: center !important;
      margin: 0 !important;
      padding: 0 !important;
      pointer-events: none !important;
    }
    #sc-shuffle-fallback-actions .sc-shuffle-glass {
      pointer-events: auto !important;
      margin-left: 0 !important;
      height: 36px !important;
      padding: 0 16px !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      display: inline-flex !important;
      align-items: center !important;
      cursor: pointer !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// Inject the native controller into the page (main world)
(function injectNative() {
  ensureGlassStyles();
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/inject.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();

function urlsRoughlyMatch(a, b) {
  try {
    const ua = new URL(a, location.origin);
    const ub = new URL(b, location.origin);
    return ua.hostname === ub.hostname && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function waitForTrackToLoad(targetUrl, timeoutMs = 12000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const href = getCurrentTrackHref();
      if (href && urlsRoughlyMatch(href, targetUrl)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function waitForExpectedPageReady(targetUrl, timeoutMs = 1800) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const pageMatches = urlsRoughlyMatch(location.href, targetUrl);
      const pageControl = getPagePlayButton(targetUrl);
      const footerTrackHref = getCurrentTrackHref();
      const playerOnExpected = !!footerTrackHref && urlsRoughlyMatch(footerTrackHref, targetUrl);
      if (pageMatches && (pageControl || playerOnExpected)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function isValidPagePlayButton(btn) {
  if (!btn) return false;
  if (btn.closest(".playControls")) return false;
  if (btn.closest(".relatedSounds, .trackList, .soundList, [class*='queue'], [class*='related'], aside")) return false;
  const rect = btn.getBoundingClientRect?.();
  if (rect && rect.width === 0 && rect.height === 0) return false;
  return true;
}

function isPlayStartButton(btn) {
  if (!btn) return false;
  const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`.toLowerCase();
  const className = String(btn.className || "").toLowerCase();
  if (label.includes("pause")) return false;
  if (className.includes("sc-button-pause")) return false;
  if (label.includes("play")) return true;
  if (className.includes("sc-button-play")) return true;
  return false;
}

function dispatchNativeClick(action, detail = null) {
  try {
    window.dispatchEvent(new CustomEvent(action, { detail }));
    return true;
  } catch {
    return false;
  }
}

function requestExpectedPagePlay(expectedUrl, source) {
  state.lastAdvanceKickAt = Date.now();
  const pageBtn = getPagePlayButton(expectedUrl);
  const nativeRequested = dispatchNativeClick("SC_SHUFFLE_PAGE_PLAY", expectedUrl);
  if (!nativeRequested && pageBtn) (pageBtn as HTMLElement).click();
  log(`${source}: requested page play for expected track`, {
    expectedUrl,
    footerTrackHref: getCurrentTrackHref(),
    hasPageButton: !!pageBtn,
    nativeRequested,
  });
  return nativeRequested || !!pageBtn;
}

async function navigateAndPlay(url) {
  state.pendingAdvanceUntil = Math.max(state.pendingAdvanceUntil || 0, Date.now() + 6000);
  state.pendingExpectedUrl = url;
  const currentAudio = getAudioEl();
  const currentFooterTrackHref = getCurrentTrackHref();
  if (
    currentAudio &&
    currentAudio.paused === false &&
    currentFooterTrackHref &&
    !urlsRoughlyMatch(currentFooterTrackHref, url)
  ) {
    try {
      currentAudio.pause();
      log("NAVIGATE_AND_PLAY: paused previous audio before route change", {
        from: currentFooterTrackHref,
        to: url,
      });
    } catch {}
  }

  window.dispatchEvent(new CustomEvent("SC_SHUFFLE_NAVIGATE", { detail: url }));
  const pageReady = await waitForExpectedPageReady(url, 1800);
  if (!pageReady) {
    log("NAVIGATE_AND_PLAY: expected page did not become ready", { url });
    return false;
  }

  const footerTrackHrefAfterNavigation = getCurrentTrackHref();
  const footerBtn = getPlayButton();
  const footerPlayLabel = (
    footerBtn?.getAttribute("aria-label") ||
    footerBtn?.getAttribute("title") ||
    ""
  ).toLowerCase();
  const playerOnExpected =
    !!footerTrackHrefAfterNavigation &&
    urlsRoughlyMatch(footerTrackHrefAfterNavigation, url);

  if (playerOnExpected && footerBtn && footerPlayLabel.includes("play current")) {
    state.lastAdvanceKickAt = Date.now();
    const nativeClicked = dispatchNativeClick("SC_SHUFFLE_PLAY_CURRENT");
    if (!nativeClicked) (footerBtn as HTMLElement).click();
    log("NAVIGATE_AND_PLAY: clicked footer 'Play current' for expected track", { url });
  } else {
    requestExpectedPagePlay(url, "NAVIGATE_AND_PLAY");
  }

  ensurePlayingWithRetry(url, { attempts: 14, intervalMs: 450 })
    .then((isPlaying) => {
      if (!isPlaying) {
        log("NAVIGATE_AND_PLAY: deferred ensure did not confirm playback", { url });
      }
    })
    .catch((e) => {
      log("NAVIGATE_AND_PLAY: deferred ensure failed", e?.message || e);
    });

  return true;
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req?.action === "GET_CURRENT_CONTEXT") {
    sendResponse({ url: window.location.href });
  }

  if (req?.action === "SC_SHUFFLE_STATE") {
    updateRuntimeFromStatus(req);
    sendResponse?.({ ok: true });
  }

  if (req?.action === "NAVIGATE_AND_PLAY" && typeof req.url === "string") {
    navigateAndPlay(req.url)
      .then((ok) => sendResponse({ ok }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }

  if (req?.action === "ENSURE_PLAYING") {
    ensurePlayingWithRetry(req?.url, { attempts: 14, intervalMs: 450 })
      .then((ok) => sendResponse({ ok }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
});

function ensurePlayingOnce(expectedUrl) {
  const now = Date.now();
    const audio = getAudioEl();
  const audioPaused = audio ? audio.paused === true : null;

  const footerTrackHref = getCurrentTrackHref();
  const footerBtn = getPlayButton();
  const pageMatches = expectedUrl ? urlsRoughlyMatch(location.href, expectedUrl) : false;
  const playerOnExpected =
    !!expectedUrl &&
    !!footerTrackHref &&
    urlsRoughlyMatch(footerTrackHref, expectedUrl);

  // Success criteria: expected track is actually loaded in the footer player and not paused.
  if (expectedUrl) {
    if (playerOnExpected) {
      const footerPlaying = isPlaying(footerBtn) === true;
      if ((audio && audio.paused === false) || footerPlaying) return true;
    }
  } else {
    if (audio && audio.paused === false) return true;
  }

  const canKick = now - ensurePlayingLastKickAt > 1200;
  const footerPlayLabel = (
    footerBtn?.getAttribute("aria-label") ||
    footerBtn?.getAttribute("title") ||
    ""
  ).toLowerCase();

  // If we're on the target page but the player is still on the previous track,
  // click the page's own Play button to load the current track into the player.
  if (expectedUrl && pageMatches && !playerOnExpected && canKick) {
    requestExpectedPagePlay(expectedUrl, "ENSURE_PLAYING");
    return false;
  }

  // If the player is on the expected track but paused, unpause via footer control.
  if ((playerOnExpected || !expectedUrl) && (audioPaused === true || audioPaused === null) && canKick) {
    const playingByAria = isPlaying(footerBtn);
    const shouldClick =
      (audioPaused === true) ||
      (audioPaused === null && (playingByAria === false || playingByAria === null));

    if (footerBtn && shouldClick) {
      log("ENSURE_PLAYING: unpause via footer play", { expectedUrl, footerTrackHref });
      ensurePlayingLastKickAt = now;
      (footerBtn as HTMLElement).click();
      return false;
    }

    if (audio && audio.paused === true) {
      log("ENSURE_PLAYING: try audio.play()", { expectedUrl, footerTrackHref });
      ensurePlayingLastKickAt = now;
      audio.play?.().catch?.(() => {});
      return false;
    }
  }

  return false;
}

function ensurePlayingWithRetry(expectedUrl, options: { attempts?: number; intervalMs?: number } = {}) {
  const attempts = Number.isFinite(options?.attempts) ? Math.max(1, options.attempts) : 20;
  const intervalMs = Number.isFinite(options?.intervalMs) ? Math.max(50, options.intervalMs) : 500;

  return new Promise((resolve) => {
    let attemptsLeft = attempts;
    const tick = () => {
      if (ensurePlayingOnce(expectedUrl)) {
        resolve(true);
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft <= 0) {
        resolve(false);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function getPagePlayButton(expectedUrl = null) {
  const targetUrl = expectedUrl || location.href;

  if (expectedUrl) {
    const matchingLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter((link) => urlsRoughlyMatch(link.href, targetUrl))
      .slice(0, 12);

    for (const link of matchingLinks) {
      const container =
        link.closest(".listenEngagement, .fullHero, .soundActions, .trackItem, li, article, section, div") ||
        link.parentElement;
      if (!container) continue;

      const playBtn = container.querySelector(
        "a.playButton, a[class*='playButton'], a[class*='sc-button-play'], a[role='button'][title^='Play'], a[role='button'][aria-label^='Play'], button.playButton, button[class*='playButton'], button[class*='sc-button-play'], button[aria-label^='Play'], button[title^='Play']"
      );
      if (isValidPagePlayButton(playBtn) && isPlayStartButton(playBtn)) return playBtn;
    }

    const primarySelectors = [
      ".soundTitle__playButton a.playButton",
      ".soundTitle__playButton a[class*='playButton']",
      ".soundTitle__playButton a[class*='sc-button-play']",
      ".soundTitle__playButton button.playButton",
      ".soundTitle__playButton button[class*='playButton']",
      ".soundTitle__playButton button[class*='sc-button-play']",
      ".fullHero a.playButton",
      '.fullHero a[class*="playButton"]',
      '.fullHero a[class*="sc-button-play"]',
      '.fullHero a[role="button"][aria-label^="Play"]',
      '.fullHero a[role="button"][title^="Play"]',
      ".listenEngagement button.playButton",
      '.listenEngagement button[class*="playButton"]',
      '.listenEngagement button[class*="sc-button-play"]',
      '.listenEngagement button[aria-label^="Play"]',
      '.listenEngagement button[title^="Play"]',
      ".listenEngagement a.playButton",
      '.listenEngagement a[class*="playButton"]',
      '.listenEngagement a[class*="sc-button-play"]',
      '.listenEngagement a[role="button"][aria-label^="Play"]',
      '.listenEngagement a[role="button"][title^="Play"]',
      ".fullHero button.playButton",
      '.fullHero button[class*="playButton"]',
      '.fullHero button[class*="sc-button-play"]',
      '.fullHero button[aria-label^="Play"]',
      '.fullHero button[title^="Play"]',
      ".soundActions button.playButton",
      '.soundActions button[class*="playButton"]',
      '.soundActions button[class*="sc-button-play"]',
      '.soundActions button[aria-label^="Play"]',
      '.soundActions button[title^="Play"]',
      ".soundActions a.playButton",
      '.soundActions a[class*="playButton"]',
      '.soundActions a[class*="sc-button-play"]',
      '.soundActions a[role="button"][aria-label^="Play"]',
      '.soundActions a[role="button"][title^="Play"]',
    ];

    for (const sel of primarySelectors) {
      const btn = document.querySelector(sel);
      if (!isValidPagePlayButton(btn) || !isPlayStartButton(btn)) continue;
      return btn;
    }

    return null;
  }

  const selectors = [
    ".soundTitle__playButton a.playButton",
    '.soundTitle__playButton a[class*="playButton"]',
    '.soundTitle__playButton a[class*="sc-button-play"]',
    '.soundTitle__playButton a[role="button"][aria-label^="Play"]',
    '.soundTitle__playButton a[role="button"][title^="Play"]',
    ".soundTitle__playButton button.playButton",
    '.soundTitle__playButton button[class*="playButton"]',
    '.soundTitle__playButton button[class*="sc-button-play"]',
    ".listenEngagement button.playButton",
    '.listenEngagement button[class*="playButton"]',
    '.listenEngagement button[class*="sc-button-play"]',
    '.listenEngagement button[aria-label^="Play"]',
    '.listenEngagement button[title^="Play"]',
    ".listenEngagement a.playButton",
    '.listenEngagement a[class*="playButton"]',
    '.listenEngagement a[class*="sc-button-play"]',
    '.listenEngagement a[role="button"][aria-label^="Play"]',
    '.listenEngagement a[role="button"][title^="Play"]',
    ".fullHero button.playButton",
    '.fullHero button[class*="playButton"]',
    '.fullHero button[class*="sc-button-play"]',
    '.fullHero button[aria-label^="Play"]',
    '.fullHero button[title^="Play"]',
    ".fullHero a.playButton",
    '.fullHero a[class*="playButton"]',
    '.fullHero a[class*="sc-button-play"]',
    '.fullHero a[role="button"][aria-label^="Play"]',
    '.fullHero a[role="button"][title^="Play"]',
    ".soundActions button.playButton",
    '.soundActions button[class*="playButton"]',
    '.soundActions button[class*="sc-button-play"]',
    '.soundActions button[aria-label^="Play"]',
    '.soundActions button[title^="Play"]',
    ".soundActions a.playButton",
    '.soundActions a[class*="playButton"]',
    '.soundActions a[class*="sc-button-play"]',
    '.soundActions a[role="button"][aria-label^="Play"]',
    '.soundActions a[role="button"][title^="Play"]',
  ];

  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (!isValidPagePlayButton(btn) || !isPlayStartButton(btn)) continue;
    return btn;
  }
  return null;
}

// Note: We intentionally do not relay SC_SHUFFLE_NAVIGATE back to background.
// Background drives navigation; relaying can create loops and resume the wrong track.

const state = {
  lastUrl: location.href,
  lastTrackHref: null,
  lastAudioSrc: null,
  endedReported: false,
  lastProgress: 0,
  lastProgressAt: 0,
  nearEndSince: null,
  manualSeekNearEndAt: 0,
  repeatSkipLoggedAt: 0,
  lastRepeatMode: "off",
  pendingAdvanceUntil: 0,
  pendingAdvanceUrl: null,
  pendingExpectedUrl: null,
  lastAdvanceSuppressionAt: 0,
  lastAdvanceKickAt: 0,
  boundAudioEl: null,
  boundAudioOnEnded: null,
};

// -------- Track-end detection --------

function reportTrackFinished(reason, extra = null) {
  if (!shuffleRuntime.isShuffling) return;
  if (state.endedReported) return;

  const repeatState = getNativeRepeatState();
  const shouldHoldShuffleAdvance =
    repeatState.mode === "one" ||
    repeatState.mode === "on";

  if (shouldHoldShuffleAdvance) {
    const now = Date.now();
    if (now - state.repeatSkipLoggedAt > 1500 || state.lastRepeatMode !== repeatState.mode) {
      log("Suppress TRACK_FINISHED because native repeat is enabled", {
        reason,
        repeatMode: repeatState.mode,
      });
      state.repeatSkipLoggedAt = now;
      state.lastRepeatMode = repeatState.mode;
    }
    return;
  }

  state.lastRepeatMode = repeatState.mode;
  state.endedReported = true;
  state.pendingAdvanceUntil = Date.now() + 6000;
  state.pendingAdvanceUrl = location.href;
  state.pendingExpectedUrl = null;
  if (extra) {
    log(`Track end reported via ${reason}`, extra);
  } else {
    log(`Track end reported via ${reason}`);
  }
  sendToBackground({ type: "TRACK_FINISHED" });
}

function suppressUnexpectedPlaybackWhileAdvancing() {
  if (!shuffleRuntime.isShuffling) return;
  if (!state.pendingAdvanceUntil) return;

  const now = Date.now();
  if (now > state.pendingAdvanceUntil) {
    state.pendingAdvanceUntil = 0;
    state.pendingAdvanceUrl = null;
    state.pendingExpectedUrl = null;
    return;
  }

  const footerTrackHref = getCurrentTrackHref();
  if (
    state.pendingExpectedUrl &&
    footerTrackHref &&
    urlsRoughlyMatch(footerTrackHref, state.pendingExpectedUrl)
  ) {
    state.pendingAdvanceUntil = 0;
    state.pendingAdvanceUrl = null;
    state.pendingExpectedUrl = null;
    return;
  }

  if (
    state.pendingExpectedUrl &&
    urlsRoughlyMatch(location.href, state.pendingExpectedUrl) &&
    now - state.lastAdvanceKickAt > 450
  ) {
    requestExpectedPagePlay(state.pendingExpectedUrl, "ADVANCE_SUPPRESSION");
  }

  if (now - state.lastAdvanceSuppressionAt < 250) return;

  const footerBtn = getPlayButton();
  const playingByAria = isPlaying(footerBtn);
  if (footerBtn && playingByAria === true) {
    state.lastAdvanceSuppressionAt = now;
    (footerBtn as HTMLElement).click();
    log("Suppressed native playback while waiting for shuffle advance", {
      url: location.href,
      via: "footer-pause",
    });
    return;
  }

  const audio = getAudioEl();
  if (!audio || audio.paused === true) return;

  state.lastAdvanceSuppressionAt = now;
  try {
    audio.pause();
    log("Suppressed native playback while waiting for shuffle advance", {
      url: location.href,
      via: "audio.pause",
    });
  } catch {}
}

function parseTimeToSeconds(text) {
  if (!text) return null;
  const parts = String(text).trim().split(":").map((p) => p.trim());
  if (!parts.length || parts.some((p) => p === "" || Number.isNaN(Number(p)))) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

function getCurrentTrackHref() {
  const link =
    document.querySelector<HTMLAnchorElement>("a.playbackSoundBadge__titleLink") ||
    document.querySelector<HTMLAnchorElement>('a[href*="soundcloud.com"][class*="playbackSoundBadge__titleLink"]');
  return link?.href || null;
}

function getAudioEl() {
  return document.querySelector("audio");
}

function getPlayButton() {
  return (
    document.querySelector('button[aria-label][class*="playControl"]') ||
    document.querySelector('button.playControl[aria-label]') ||
    document.querySelector('button[aria-label^="Play"], button[aria-label^="Pause"]')
  );
}

function getRepeatButton() {
  const selectors = [
    ".playControls button.repeatControl",
    '.playControls button[class*="repeatControl"]',
    '.playControls button[aria-label*="Repeat"]',
    '.playControls button[aria-label*="repeat"]',
    '.playControls button[title*="Repeat"]',
    '.playControls button[title*="repeat"]',
  ];

  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn) return btn;
  }

  const fallback = Array.from(document.querySelectorAll(".playControls button")).find((btn) => {
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    const title = (btn.getAttribute("title") || "").toLowerCase();
    const cls = (btn.className || "").toLowerCase();
    return aria.includes("repeat") || title.includes("repeat") || cls.includes("repeat");
  });

  return fallback || null;
}

function getNativeRepeatState() {
  const btn = getRepeatButton();
  if (!btn) return { enabled: false, mode: "off", reason: "missing-button" };

  const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`.toLowerCase();
  const className = String(btn.className || "").toLowerCase();
  const pressedAttr = btn.getAttribute("aria-pressed");
  const isPressed = pressedAttr === "true";

  const isExplicitOffByText =
    label.includes("enable repeat") ||
    label.includes("turn on repeat") ||
    label.includes("repeat off");

  const isExplicitOnByText =
    label.includes("disable repeat") ||
    label.includes("turn off repeat") ||
    label.includes("repeat on") ||
    label.includes("repeat all") ||
    label.includes("repeat one") ||
    label.includes("repeat track");

  const isRepeatAllByText = label.includes("repeat all");
  const isRepeatOneByText = label.includes("repeat one") || label.includes("repeat track");

  const activeByClass =
    className.includes("sc-button-selected") ||
    className.includes("m-active") ||
    className.includes("is-active") ||
    className.includes("repeatcontrol--active") ||
    className.includes("repeatcontrol--one") ||
    className.includes("m-one");

  const isRepeatAllByClass =
    className.includes("repeatcontrol--all") ||
    className.includes("m-all");
  const isRepeatOneByClass =
    className.includes("repeatcontrol--one") ||
    className.includes("m-one");

  const enabled = isExplicitOffByText ? false : (isExplicitOnByText || isPressed || activeByClass);
  const mode = !enabled
    ? "off"
    : (isRepeatOneByText || isRepeatOneByClass)
      ? "one"
      : (isRepeatAllByText || isRepeatAllByClass)
        ? "all"
        : "on";

  return { enabled, mode, reason: "button-detected" };
}

function readProgress() {
  const audio = getAudioEl();
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0 && Number.isFinite(audio.currentTime)) {
    return audio.currentTime / audio.duration;
  }

  const elapsedText =
    document.querySelector(".playbackTimeline__timePassed")?.textContent ||
    document.querySelector('[class*="playbackTimeline__timePassed"]')?.textContent ||
    null;
  const durationText =
    document.querySelector(".playbackTimeline__duration")?.textContent ||
    document.querySelector('[class*="playbackTimeline__duration"]')?.textContent ||
    null;
  const elapsedSec = parseTimeToSeconds(elapsedText);
  const durationSec = parseTimeToSeconds(durationText);
  if (elapsedSec !== null && durationSec !== null && durationSec > 0) {
    return elapsedSec / durationSec;
  }

  const progressEl =
    document.querySelector('[role="progressbar"].playbackTimeline__progressBar') ||
    document.querySelector('.playbackTimeline__progressBar') ||
    document.querySelector('[role="progressbar"]');

  let ratio = null;
  if (progressEl) {
    const nowAttr = progressEl.getAttribute("aria-valuenow");
    const maxAttr = progressEl.getAttribute("aria-valuemax");
    const now = nowAttr ? parseFloat(nowAttr) : NaN;
    const max = maxAttr ? parseFloat(maxAttr) : NaN;
    if (!Number.isNaN(now) && !Number.isNaN(max) && max > 0) {
      ratio = now / max;
    } else if ((progressEl as HTMLElement).style?.width?.includes("%")) {
      const pct = parseFloat((progressEl as HTMLElement).style.width.replace("%", ""));
      ratio = pct / 100;
    }
  }
  return ratio;
}

function isPlaying(btn) {
  if (!btn) return null;
  const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
  if (aria.includes("pause")) return true;
  if (aria.includes("play")) return false;
  return null;
}

function isTimelineEventTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    ".playbackTimeline, [class*='playbackTimeline'], [role='progressbar']"
  );
}

function scheduleManualSeekEndCheck(source) {
  if (!shuffleRuntime.isShuffling) return;

  state.manualSeekNearEndAt = Date.now();
  let attemptsLeft = 8;

  const tick = () => {
    if (!shuffleRuntime.isShuffling) return;
    if (state.endedReported) return;

    const progress = readProgress();
    const audio = getAudioEl();
    const audioTime = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : null;
    const audioDuration = audio && Number.isFinite(audio.duration) ? audio.duration : null;
    const remainingSec =
      audioTime !== null &&
      audioDuration !== null &&
      audioDuration > 0
        ? audioDuration - audioTime
        : null;

    const isHardEnd =
      (progress !== null && progress >= 0.9985) ||
      (remainingSec !== null && remainingSec <= 0.18);

    if (isHardEnd) {
      reportTrackFinished(`manual-seek:${source}`, { progress, remainingSec });
      return;
    }

    attemptsLeft -= 1;
    if (attemptsLeft <= 0) return;
    setTimeout(tick, 120);
  };

  setTimeout(tick, 40);
}

function evaluateEnd(source) {
  if (!shuffleRuntime.isShuffling) return;
  const now = Date.now();
  const prevProgressSnapshot = state.lastProgress;
  const prevProgressAtSnapshot = state.lastProgressAt;
  const prevEndedReportedSnapshot = state.endedReported;

  const currentUrl = location.href;
  const currentTrackHref = getCurrentTrackHref();
  const audio = getAudioEl();
  const currentAudioSrc = audio?.currentSrc || audio?.src || null;
  const audioTime = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : null;
  const audioDuration = audio && Number.isFinite(audio.duration) ? audio.duration : null;

  const audioSrcChangedLooksLikeNewTrack =
    currentAudioSrc &&
    currentAudioSrc !== state.lastAudioSrc &&
    (audioTime === null || audioTime < 5);

  const trackChanged =
    currentUrl !== state.lastUrl ||
    (currentTrackHref && currentTrackHref !== state.lastTrackHref) ||
    audioSrcChangedLooksLikeNewTrack;

  if (trackChanged) {
    const likelyNaturalAdvance =
      !prevEndedReportedSnapshot &&
      prevProgressSnapshot >= 0.9 &&
      prevProgressAtSnapshot > 0 &&
      now - prevProgressAtSnapshot < 15000;

    const likelyManualSeekAdvance =
      !prevEndedReportedSnapshot &&
      state.manualSeekNearEndAt > 0 &&
      now - state.manualSeekNearEndAt < 4500;

    if (likelyNaturalAdvance || likelyManualSeekAdvance) {
      log("Track changed after near-end; enforcing shuffle advance");
      reportTrackFinished("track-changed-after-near-end");
    }

    const expectedAdvanceReached =
      !!state.pendingExpectedUrl &&
      (currentTrackHref && urlsRoughlyMatch(currentTrackHref, state.pendingExpectedUrl));

    const unexpectedTrackWhilePending =
      !!state.pendingExpectedUrl &&
      !expectedAdvanceReached;

    state.lastUrl = currentUrl;
    state.lastTrackHref = currentTrackHref;
    state.lastAudioSrc = currentAudioSrc;
    state.lastProgress = 0;
    state.lastProgressAt = 0;
    state.nearEndSince = null;
    state.manualSeekNearEndAt = 0;

    if (unexpectedTrackWhilePending) {
      state.pendingAdvanceUntil = Math.max(state.pendingAdvanceUntil, Date.now() + 3000);
      log("Unexpected track loaded while waiting for shuffle advance", {
        currentUrl,
        currentTrackHref,
        pendingExpectedUrl: state.pendingExpectedUrl,
      });
    } else {
      state.endedReported = false;
      state.pendingAdvanceUntil = 0;
      state.pendingAdvanceUrl = null;
      state.pendingExpectedUrl = null;
      log("Track change detected, reset end flags");
    }
  }

  const btn = getPlayButton();
  const playing = isPlaying(btn);
  const progress = readProgress();
  const audioEnded = !!audio && audio.ended === true;

  const prevProgress = state.lastProgress;
  const prevProgressAt = state.lastProgressAt;
  if (progress !== null) {
    state.lastProgress = progress;
    state.lastProgressAt = now;
  }

  const endedByAudioTime =
    audioTime !== null &&
    audioDuration !== null &&
    audioDuration > 0 &&
    audioTime > 1 &&
    audioDuration - audioTime <= 0.35 &&
    playing !== true;

  const nearEnd = progress !== null && progress >= 0.97;
  if (nearEnd && state.nearEndSince === null) state.nearEndSince = Date.now();
  if (!nearEnd) state.nearEndSince = null;

  const endedByAria = playing === false && nearEnd;
  const endedByStall =
    state.nearEndSince !== null &&
    Date.now() - state.nearEndSince > 4000 &&
    playing !== true;

  const endedByProgressReset =
    progress !== null &&
    prevProgress >= 0.9 &&
    progress <= 0.05 &&
    playing !== true;

  const endedByNoProgressUpdates =
    playing === false &&
    prevProgress >= 0.9 &&
    prevProgressAt > 0 &&
    now - prevProgressAt > 8000;

  const remainingSec =
    audioTime !== null &&
    audioDuration !== null &&
    audioDuration > 0 &&
    audioTime > 1
      ? (audioDuration - audioTime)
      : null;

  const endedPreemptivelyByNearEnd =
    !state.endedReported &&
    playing === true &&
    (
      (remainingSec !== null && remainingSec <= 0.22) ||
      (progress !== null &&
        progress >= 0.997 &&
        state.nearEndSince !== null &&
        Date.now() - state.nearEndSince > 700)
    );

  if (endedPreemptivelyByNearEnd) {
    reportTrackFinished(`preemptive:${source}`, { progress, remainingSec });
    return;
  }

  if (
    (audioEnded || endedByAudioTime || endedByAria || endedByStall || endedByProgressReset || endedByNoProgressUpdates) &&
    !state.endedReported
  ) {
    reportTrackFinished(`detector:${source}`, { progress, playing });
  }
}

function unbindAudioEndListener() {
  const audio = state.boundAudioEl;
  const handler = state.boundAudioOnEnded;
  if (!audio || !handler) return;
  try {
    audio.removeEventListener("ended", handler, true);
  } catch {}
  state.boundAudioEl = null;
  state.boundAudioOnEnded = null;
}

function bindAudioEndListener() {
  if (!shuffleRuntime.isShuffling) return;
  const audio = getAudioEl();
  if (!audio || audio === state.boundAudioEl) return;

  unbindAudioEndListener();
  state.boundAudioEl = audio;
  state.boundAudioOnEnded = onAudioEnded;
  audio.addEventListener("ended", state.boundAudioOnEnded, true);
  log("Bound audio ended listener");
}

function onAudioEnded() {
  if (!shuffleRuntime.isShuffling) return;
  reportTrackFinished("audio.ended");
}

function bindTimelineEndSeekWatcher() {
  if (timelineEndSeekWatcherBound) return;
  timelineEndSeekWatcherBound = true;

  const onSeekInteraction = (event) => {
    if (!shuffleRuntime.isShuffling) return;
    if (!isTimelineEventTarget(event.target)) return;
    scheduleManualSeekEndCheck(event.type);
  };

  document.addEventListener("pointerup", onSeekInteraction, true);
  document.addEventListener("mouseup", onSeekInteraction, true);
  document.addEventListener("touchend", onSeekInteraction, true);
}

const observer = new MutationObserver(() => {
  if (shuffleRuntime.isShuffling) {
    suppressUnexpectedPlaybackWhileAdvancing();
    bindAudioEndListener();
    evaluateEnd("observer");
  }
  ensureFooterButtons();
  ensureHeroButtons();
});

function startObservers() {
  const target = document.body; // Observe entire body for SPA changes
  observer.observe(target, { childList: true, subtree: true, attributes: true });
}

startObservers();
bindTimelineEndSeekWatcher();
setInterval(() => {
  ensureGlassStyles();
  if (shuffleRuntime.isShuffling) {
    suppressUnexpectedPlaybackWhileAdvancing();
    bindAudioEndListener();
    evaluateEnd("poller");
  }
  ensureFooterButtons();
  ensureHeroButtons();
}, 1000);

refreshStatus();
setInterval(() => {
  refreshStatus();
}, 3000);

// -------- UI Injection: footer controls --------

function createIconButton(id, label, title, onClick) {
  const btn = document.createElement("button");
  btn.id = id;
  btn.className = "sc-button-icon sc-button-medium sc-shuffle-glass-icon sc-shuffle-skip sc-shuffle-footer-btn";
  btn.type = "button";
  btn.innerHTML = label;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

function removeFooterButtons() {
  document.getElementById("sc-shuffle-footer-group")?.remove?.();
  document.getElementById("sc-shuffle-prev")?.remove?.();
  document.getElementById("sc-shuffle-next")?.remove?.();
  document.getElementById("sc-shuffle-stop")?.remove?.();
}

function ensureFooterButtons() {
  if (!shuffleRuntime.isShuffling) {
    removeFooterButtons();
    return;
  }

  // We look for specific native buttons to place ours adjacent to them
  const prevNative = document.querySelector(".skipControl__previous");
  const nextNative = document.querySelector(".skipControl__next");
  const controlsHost = nextNative?.parentNode || prevNative?.parentNode;
  if (!controlsHost || document.getElementById("sc-shuffle-footer-group")) return;

  const group = document.createElement("div");
  group.id = "sc-shuffle-footer-group";

  const prevBtn = createIconButton(
    "sc-shuffle-prev",
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 3h1v10H4V3zm8 0v10L6 8l6-5z"/></svg>',
    "Shuffle Prev",
    () => sendToBackground({ type: "SKIP_PREV" })
  );
  const stopBtn = createIconButton(
    "sc-shuffle-stop",
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 4h8v8H4z"/></svg>',
    "Stop Shuffle",
    () => {
      sendToBackgroundWithResult({ type: "STOP_SHUFFLE" }, "Stopping shuffle...");
      updateRuntimeFromStatus({ isShuffling: false });
      refreshStatus();
    }
  );
  stopBtn.classList.add("sc-shuffle-footer-btn--stop");
  const nextBtn = createIconButton(
    "sc-shuffle-next",
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11 3h1v10h-1V3zM4 3v10l6-5-6-5z"/></svg>',
    "Shuffle Next",
    () => sendToBackground({ type: "SKIP_NEXT" })
  );

  group.appendChild(prevBtn);
  group.appendChild(stopBtn);
  group.appendChild(nextBtn);

  if (nextNative?.nextSibling) {
    controlsHost.insertBefore(group, nextNative.nextSibling);
  } else {
    controlsHost.appendChild(group);
  }
}

// -------- UI Injection: hero buttons on likes/playlist pages --------

function createHeroButton(id, text, onClick) {
  const btn = document.createElement("button");
  btn.id = id;
  btn.className = "sc-button sc-button-medium sc-shuffle-glass";
  btn.type = "button";
  btn.textContent = text;
  btn.style.marginLeft = "10px"; // Spacing
  btn.addEventListener("click", onClick);
  return btn;
}

// Top-level paths that are SoundCloud app pages, not user profiles.
// Injecting shuffle buttons there broke the header on /feed, /people, /you/*, etc.
const RESERVED_TOP_SLUGS = new Set([
  "you", "feed", "discover", "stream", "home", "search", "upload", "messages",
  "notifications", "settings", "people", "charts", "mobile", "pro", "premium",
  "pages", "tags", "popular", "stations", "jobs", "imprint", "terms-of-use",
  "logout", "signin", "signout", "connect", "activity", "for-artists",
  "artist-plans", "library", "apps", "help", "legal", "community-guidelines",
]);

function isLikelyUsername(slug) {
  return !!slug && !RESERVED_TOP_SLUGS.has(slug);
}

const HERO_BUTTON_IDS = [
  "sc-shuffle-likes-hero",
  "sc-shuffle-all-hero",
  "sc-shuffle-reposts-hero",
  "sc-shuffle-tracks-hero",
  "sc-shuffle-playlists-hero",
  "sc-shuffle-playlist-hero",
];

function removeStaleHeroButtons(keepIds = []) {
  const keep = new Set(keepIds);
  for (const id of HERO_BUTTON_IDS) {
    if (!keep.has(id)) document.getElementById(id)?.remove?.();
  }

  const fallback = document.getElementById("sc-shuffle-fallback-actions");
  if (fallback && !fallback.querySelector(`#${HERO_BUTTON_IDS.join(", #")}`)) {
    fallback.remove();
  }
}

function getHeroActionsContainer() {
  return (
    document.querySelector(".fullHero__actions") ||
    document.querySelector(".listenEngagement__actions") ||
    document.querySelector(".soundActions__actions") ||
    document.querySelector(".audibleEditForm__buttons") ||
    document.querySelector(".profileHeaderInfo__actions") ||
    document.querySelector(".userInfoBar__buttons") ||
    document.querySelector(".userInfoBar__actions") ||
    null
  );
}

function getShareButton() {
  const btn =
    document.querySelector("button.sc-button-share") ||
    document.querySelector('button[aria-label="Share"]') ||
    document.querySelector('button[title="Share"]') ||
    null;
  if (!btn) return null;
  // Only anchor to a page-level share button (profile/playlist header).
  // Share buttons inside track rows would place our button mid-list.
  if (btn.closest("li, .sound, .soundList__item, .searchList__item, .trackItem, .playControls")) {
    return null;
  }
  return btn;
}

function ensureFallbackActionsContainer() {
  let el = document.getElementById("sc-shuffle-fallback-actions");
  if (el) return el;
  el = document.createElement("div");
  el.id = "sc-shuffle-fallback-actions";
  // Fixed overlay: must never participate in page layout, otherwise it
  // pushes SoundCloud's header down (seen on /you/likes, /you/sets, /feed).
  document.body.appendChild(el);
  return el;
}

function ensureHeroButtons() {
  const path = (location.pathname || "").toLowerCase();
  const parts = path.split("/").filter(Boolean);
  const first = parts[0] || "";

  // "/you/..." is the logged-in library; background resolves it via /me.
  const isYouSection = first === "you";
  const ownerLike = isYouSection || isLikelyUsername(first);

  const isPlaylistsTab = ownerLike && parts.length === 2 && parts[1] === "sets";
  const isPlaylist = !isYouSection && isLikelyUsername(first) && parts.length >= 3 && parts[1] === "sets";
  const isLikes = ownerLike && parts.length === 2 && parts[1] === "likes";
  const isReposts = ownerLike && parts.length === 2 && parts[1] === "reposts";
  const isTracksTab = ownerLike && parts.length === 2 && parts[1] === "tracks";
  const isProfileRoot = !isYouSection && isLikelyUsername(first) && parts.length === 1;

  const shouldShowAny =
    isLikes || isProfileRoot || isReposts || isTracksTab || isPlaylistsTab || isPlaylist;

  const activeButtonIds = [
    isLikes ? "sc-shuffle-likes-hero" : null,
    isProfileRoot ? "sc-shuffle-all-hero" : null,
    isReposts ? "sc-shuffle-reposts-hero" : null,
    isTracksTab ? "sc-shuffle-tracks-hero" : null,
    isPlaylistsTab ? "sc-shuffle-playlists-hero" : null,
    isPlaylist ? "sc-shuffle-playlist-hero" : null,
  ].filter(Boolean);

  removeStaleHeroButtons(activeButtonIds);

  if (!shouldShowAny) return;

  // Prefer native action bars; fall back to a sticky container if SC layout changes
  const shareBtn = isLikes ? getShareButton() : null;
  const container =
    (shareBtn?.parentElement ? shareBtn.parentElement : null) ||
    getHeroActionsContainer() ||
    ensureFallbackActionsContainer();

  if (isLikes && !document.getElementById("sc-shuffle-likes-hero")) {
    const btn = createHeroButton("sc-shuffle-likes-hero", "Shuffle Likes", () => {
      sendToBackgroundWithResult({
        type: "START_SHUFFLE_CONTEXT",
        mode: "likes",
        url: window.location.href,
        tabId: null,
      }, "Starting likes shuffle...");
    });
    if (shareBtn?.parentElement) {
      shareBtn.parentElement.insertBefore(btn, shareBtn);
    } else {
      container.appendChild(btn);
    }
  }

  if (isProfileRoot && !document.getElementById("sc-shuffle-all-hero")) {
    const btn = createHeroButton("sc-shuffle-all-hero", "Shuffle All", () => {
      sendToBackgroundWithResult({
        type: "START_SHUFFLE_CONTEXT",
        mode: "all",
        url: window.location.href,
        tabId: null,
      }, "Starting all shuffle...");
    });
    container.appendChild(btn);
  }

  if (isReposts && !document.getElementById("sc-shuffle-reposts-hero")) {
    const btn = createHeroButton("sc-shuffle-reposts-hero", "Shuffle Reposts", () => {
      sendToBackgroundWithResult({
        type: "START_SHUFFLE_CONTEXT",
        mode: "reposts",
        url: window.location.href,
        tabId: null,
      }, "Starting reposts shuffle...");
    });
    container.appendChild(btn);
  }

  if (isTracksTab && !document.getElementById("sc-shuffle-tracks-hero")) {
    const btn = createHeroButton("sc-shuffle-tracks-hero", "Shuffle Tracks", () => {
      sendToBackgroundWithResult({
        type: "START_SHUFFLE_CONTEXT",
        mode: "tracks",
        url: window.location.href,
        tabId: null,
      }, "Starting tracks shuffle...");
    });
    container.appendChild(btn);
  }

  if (isPlaylistsTab && !document.getElementById("sc-shuffle-playlists-hero")) {
    const btn = createHeroButton("sc-shuffle-playlists-hero", "Shuffle Playlists", () => {
      sendToBackgroundWithResult({
        type: "START_SHUFFLE_PLAYLISTS",
        tabId: null,
        url: window.location.href,
      }, "Collecting playlists...");
    });
    container.appendChild(btn);
  }

  if (isPlaylist && !document.getElementById("sc-shuffle-playlist-hero")) {
    const btn = createHeroButton("sc-shuffle-playlist-hero", "Shuffle Playlist", () => {
      sendToBackgroundWithResult({
        type: "START_SHUFFLE_PLAYLIST",
        tabId: null,
        url: window.location.href,
      }, "Starting playlist shuffle...");
    });
    container.appendChild(btn);
  }
}
})();
