// Native-context helper; runs in MAIN world to poke SoundCloud's player/router
(function () {
  const log = (...args: unknown[]) => console.log("[SC True Shuffle][inject]", ...args);

  function urlsRoughlyMatch(a: string, b: string) {
    try {
      const ua = new URL(a, window.location.origin);
      const ub = new URL(b, window.location.origin);
      return ua.hostname === ub.hostname && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
    } catch {
      return false;
    }
  }

  function clickRouterLink(permalink: string) {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find((anchor) =>
      urlsRoughlyMatch(anchor.href, permalink)
    );

    if (!link) return false;

    try {
      link.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        view: window,
      }));
      log("router link click navigation", permalink);
      return true;
    } catch (e) {
      log("router link click failed", e);
      return false;
    }
  }

  function triggerMouseClick(element: HTMLElement | null, label: string) {
    if (!element) return false;
    try {
      element.focus?.();
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          view: window,
        }));
      }
      log("mouse click sequence", label || "unknown");
      return true;
    } catch (e) {
      log("mouse click sequence failed", label || "unknown", e);
      return false;
    }
  }

  function getFooterPlayButton(): HTMLElement | null {
    const selectors = [
      'button[aria-label][class*="playControl"]',
      'button.playControl[aria-label]',
      'button[aria-label^="Play"]',
      'button[aria-label^="Pause"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector<HTMLElement>(sel);
      if (btn) return btn;
    }
    return null;
  }

  function isPlayStartButton(element: Element | null) {
    if (!element) return false;
    const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`.toLowerCase();
    const className = String(element.className || "").toLowerCase();
    if (label.includes("pause")) return false;
    if (className.includes("sc-button-pause")) return false;
    if (label.includes("play")) return true;
    if (className.includes("sc-button-play")) return true;
    return false;
  }

  function getTargetedPagePlayButton(permalink: string | null): HTMLElement | null {
    if (!permalink) return null;
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter((anchor) => urlsRoughlyMatch(anchor.href, permalink))
      .slice(0, 12);

    for (const link of links) {
      const container =
        link.closest(".listenEngagement, .fullHero, .soundActions, .trackItem, li, article, section, div") ||
        link.parentElement;
      if (!container) continue;

      const playBtn = container.querySelector<HTMLElement>(
        "a.playButton, a[class*='playButton'], a[class*='sc-button-play'], a[role='button'][title^='Play'], a[role='button'][aria-label^='Play'], button.playButton, button[class*='playButton'], button[class*='sc-button-play'], button[aria-label^='Play'], button[title^='Play']"
      );
      if (playBtn && !playBtn.closest(".playControls") && isPlayStartButton(playBtn)) return playBtn;
    }

    const primarySelectors = [
      ".soundTitle__playButton a.playButton",
      '.soundTitle__playButton a[class*="playButton"]',
      '.soundTitle__playButton a[class*="sc-button-play"]',
      '.soundTitle__playButton a[role="button"][aria-label^="Play"]',
      '.soundTitle__playButton a[role="button"][title^="Play"]',
      ".soundTitle__playButton button.playButton",
      '.soundTitle__playButton button[class*="playButton"]',
      '.soundTitle__playButton button[class*="sc-button-play"]',
      ".fullHero a.playButton",
      '.fullHero a[class*="playButton"]',
      '.fullHero a[class*="sc-button-play"]',
      '.fullHero a[role="button"][aria-label^="Play"]',
      '.fullHero a[role="button"][title^="Play"]',
      ".fullHero button.playButton",
      '.fullHero button[class*="playButton"]',
      '.fullHero button[class*="sc-button-play"]',
      '.fullHero button[aria-label^="Play"]',
      '.fullHero button[title^="Play"]',
      ".listenEngagement a.playButton",
      '.listenEngagement a[class*="playButton"]',
      '.listenEngagement a[class*="sc-button-play"]',
      '.listenEngagement a[role="button"][aria-label^="Play"]',
      '.listenEngagement a[role="button"][title^="Play"]',
      ".listenEngagement button.playButton",
      '.listenEngagement button[class*="playButton"]',
      '.listenEngagement button[class*="sc-button-play"]',
      '.listenEngagement button[aria-label^="Play"]',
      '.listenEngagement button[title^="Play"]',
      ".soundActions a.playButton",
      '.soundActions a[class*="playButton"]',
      '.soundActions a[class*="sc-button-play"]',
      '.soundActions a[role="button"][aria-label^="Play"]',
      '.soundActions a[role="button"][title^="Play"]',
      ".soundActions button.playButton",
      '.soundActions button[class*="playButton"]',
      '.soundActions button[class*="sc-button-play"]',
      '.soundActions button[aria-label^="Play"]',
      '.soundActions button[title^="Play"]',
    ];

    for (const sel of primarySelectors) {
      const btn = document.querySelector<HTMLElement>(sel);
      if (btn && !btn.closest(".playControls") && isPlayStartButton(btn)) return btn;
    }

    return null;
  }

  function clickFooterPlayCurrent() {
    const btn = getFooterPlayButton();
    const label = `${btn?.getAttribute("aria-label") || ""} ${btn?.getAttribute("title") || ""}`.toLowerCase();
    if (!btn || !label.includes("play current")) return false;
    return triggerMouseClick(btn, "footer-play-current");
  }

  function clickTargetedPagePlay(permalink: string | null) {
    const btn = getTargetedPagePlayButton(permalink);
    if (!btn) return false;
    return triggerMouseClick(btn, "targeted-page-play");
  }

  function navigateTo(permalink: string) {
    if (!permalink) return;
    try {
      if (clickRouterLink(permalink)) return;

      if (window.history && typeof window.history.pushState === "function") {
        window.history.pushState({}, "", permalink);
        window.dispatchEvent(new PopStateEvent("popstate"));
        window.dispatchEvent(new Event("pushstate"));
        window.dispatchEvent(new Event("locationchange"));
        log("pushState navigation", permalink);
      } else {
        window.location.href = permalink;
      }
    } catch (e) {
      log("navigation failed, fallback reload", e);
      window.location.href = permalink;
    }
  }

  window.addEventListener("SC_SHUFFLE_NAVIGATE", (e) => {
    const permalink = (e as CustomEvent<string>).detail;
    navigateTo(permalink);
  });

  window.addEventListener("SC_SHUFFLE_PLAY_CURRENT", () => {
    clickFooterPlayCurrent();
  });

  window.addEventListener("SC_SHUFFLE_PAGE_PLAY", (e) => {
    clickTargetedPagePlay((e as CustomEvent<string | null>).detail || null);
  });

  (window as any).SCShuffleNative = {
    navigateTo,
    findPlayer() {
      // Placeholder: hook into internal player once signatures are verified
      return true;
    },
    playTrack(trackUrnOrUrl: string) {
      navigateTo(trackUrnOrUrl);
    },
    clickFooterPlayCurrent,
    clickTargetedPagePlay,
  };

  log("Native injector loaded");
})();
