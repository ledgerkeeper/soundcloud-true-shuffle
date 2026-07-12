// Native-context helper; runs in MAIN world to poke SoundCloud's player/router
(function () {
  const log = (...args: unknown[]) => console.log("[SC True Shuffle][inject]", ...args);

  type WebpackRequire = ((moduleId: string | number) => unknown) & {
    c?: Record<string, { exports?: unknown }>;
    m?: Record<string, unknown>;
  };

  type SoundCloudModel = {
    get?: (key: string) => unknown;
  };

  type SoundCloudPlayerManager = {
    getCurrentSound: () => SoundCloudModel | null | undefined;
    isPlaying: () => boolean;
    playCurrent: (options?: Record<string, unknown>) => unknown;
    playSource: (
      source: SoundCloudModel,
      sound: SoundCloudModel,
      context: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => unknown;
  };

  type SoundCloudModelConstructor = ((...args: unknown[]) => unknown) & {
    prototype?: { resource_type?: string };
    resolve: (
      userPermalink: string,
      soundPermalink: string,
      secretToken?: string
    ) => {
      done?: (callback: (model: SoundCloudModel) => void) => unknown;
      fail?: (callback: (error: unknown) => void) => unknown;
      then?: (
        resolve: (model: SoundCloudModel) => void,
        reject: (error: unknown) => void
      ) => unknown;
    };
  };

  type WebpackRuntime = {
    require: WebpackRequire;
    legacy: boolean;
  };

  let cachedWebpackRuntime: WebpackRuntime | null = null;
  let nativePlayInFlight: { permalink: string; promise: Promise<boolean> } | null = null;

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

  function invokeReactClick(element: HTMLElement) {
    const propsKey = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactProps$"));
    const elementRecord = element as unknown as Record<string, unknown>;
    const directProps = propsKey ? elementRecord[propsKey] as {
      onClick?: (event: unknown) => unknown;
    } | null | undefined : null;

    let onClick = directProps?.onClick;
    if (typeof onClick !== "function") {
      const fiberKey = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
      let fiber = fiberKey ? elementRecord[fiberKey] as {
        memoizedProps?: { onClick?: (event: unknown) => unknown };
        pendingProps?: { onClick?: (event: unknown) => unknown };
        return?: unknown;
      } | null | undefined : null;

      for (let depth = 0; fiber && depth < 8; depth += 1) {
        const candidate = fiber.memoizedProps?.onClick || fiber.pendingProps?.onClick;
        if (typeof candidate === "function") {
          onClick = candidate;
          break;
        }
        fiber = fiber.return as typeof fiber;
      }
    }
    if (typeof onClick !== "function") return false;

    const nativeEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      view: window,
    });
    let propagationStopped = false;
    const event = {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      currentTarget: element,
      defaultPrevented: false,
      detail: 1,
      isDefaultPrevented() {
        return this.defaultPrevented;
      },
      isPropagationStopped() {
        return propagationStopped;
      },
      nativeEvent,
      persist() {},
      preventDefault() {
        this.defaultPrevented = true;
        nativeEvent.preventDefault();
      },
      stopPropagation() {
        propagationStopped = true;
        nativeEvent.stopPropagation();
      },
      target: element,
      timeStamp: Date.now(),
      type: "click",
    };

    onClick(event);
    log("invoked React onClick", element.getAttribute("aria-label") || "unknown");
    return true;
  }

  function triggerMouseClick(element: HTMLElement | null, label: string) {
    if (!element) return false;
    try {
      element.focus?.();
      if (invokeReactClick(element)) return true;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          view: window,
        }));
      }
      element.click();
      log("mouse click sequence", label || "unknown");
      return true;
    } catch (e) {
      log("mouse click sequence failed", label || "unknown", e);
      return false;
    }
  }

  function captureSoundCloudWebpackRuntime(): WebpackRuntime | null {
    if (cachedWebpackRuntime) return cachedWebpackRuntime;

    const pageWindow = window as unknown as Record<string, unknown>;
    const legacyChunks = pageWindow.webpackJsonp;
    if (Array.isArray(legacyChunks)) {
      const capture: { value: WebpackRequire | null } = { value: null };
      const moduleId = `sc_shuffle_capture_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const moduleFactories = {
        [moduleId]: (_module: unknown, _exports: unknown, webpackRequire: WebpackRequire) => {
          capture.value = webpackRequire;
        },
      };

      try {
        legacyChunks.push([[], moduleFactories, [[moduleId]]]);
        const captured = capture.value;
        if (captured) {
          try {
            delete captured.m?.[moduleId];
            delete captured.c?.[moduleId];
          } catch {}
          cachedWebpackRuntime = { require: captured, legacy: true };
          return cachedWebpackRuntime;
        }
      } catch (error) {
        log("legacy webpack capture failed", error);
      }
    }

    for (const key of Object.keys(pageWindow)) {
      if (!key.startsWith("webpackChunk")) continue;
      const chunks = pageWindow[key];
      if (!Array.isArray(chunks)) continue;

      const capture: { value: WebpackRequire | null } = { value: null };
      try {
        chunks.push([
          [`sc_shuffle_capture_${Date.now()}_${Math.random().toString(36).slice(2)}`],
          {},
          (webpackRequire: WebpackRequire) => {
            capture.value = webpackRequire;
          },
        ]);
        const captured = capture.value;
        if (captured) {
          cachedWebpackRuntime = { require: captured, legacy: false };
          return cachedWebpackRuntime;
        }
      } catch (error) {
        log(`webpack capture failed for ${key}`, error);
      }
    }

    return null;
  }

  function exportCandidates(value: unknown) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return [value];
    const defaultExport = (value as { default?: unknown }).default;
    return defaultExport && defaultExport !== value ? [value, defaultExport] : [value];
  }

  function findWebpackExport<T>(
    runtime: WebpackRuntime,
    legacyModuleIds: Array<string | number>,
    predicate: (value: unknown) => value is T
  ): T | null {
    if (runtime.legacy) {
      for (const moduleId of legacyModuleIds) {
        try {
          for (const candidate of exportCandidates(runtime.require(moduleId))) {
            if (predicate(candidate)) return candidate;
          }
        } catch {}
      }
    }

    for (const moduleRecord of Object.values(runtime.require.c || {})) {
      for (const candidate of exportCandidates(moduleRecord?.exports)) {
        if (predicate(candidate)) return candidate;
      }
    }
    return null;
  }

  function isSoundCloudPlayerManager(value: unknown): value is SoundCloudPlayerManager {
    const candidate = value as Partial<SoundCloudPlayerManager> | null;
    return !!candidate &&
      typeof candidate.playSource === "function" &&
      typeof candidate.playCurrent === "function" &&
      typeof candidate.getCurrentSound === "function" &&
      typeof candidate.isPlaying === "function";
  }

  function isSoundCloudModelConstructor(value: unknown): value is SoundCloudModelConstructor {
    if (typeof value !== "function") return false;
    const candidate = value as SoundCloudModelConstructor;
    return typeof candidate.resolve === "function" &&
      candidate.prototype?.resource_type === "sound";
  }

  function getModelString(model: SoundCloudModel | null | undefined, key: string) {
    const value = model?.get?.(key);
    return typeof value === "string" ? value : null;
  }

  function currentSoundMatches(
    manager: SoundCloudPlayerManager,
    targetModel: SoundCloudModel | null,
    permalink: string
  ) {
    const current = manager.getCurrentSound();
    if (!current) return false;
    if (targetModel && current === targetModel) return true;

    const currentUrn = getModelString(current, "urn");
    const targetUrn = getModelString(targetModel, "urn");
    if (currentUrn && targetUrn && currentUrn === targetUrn) return true;

    const currentPermalink = getModelString(current, "permalink_url");
    return !!currentPermalink && urlsRoughlyMatch(currentPermalink, permalink);
  }

  function waitForNativePlayback(
    manager: SoundCloudPlayerManager,
    targetModel: SoundCloudModel | null,
    permalink: string,
    timeoutMs = 5000,
    stableMs = 400
  ) {
    const startedAt = Date.now();
    let playingSince = 0;
    return new Promise<boolean>((resolve) => {
      const tick = () => {
        let matches = false;
        let playing = false;
        try {
          matches = currentSoundMatches(manager, targetModel, permalink);
          playing = manager.isPlaying() === true;
        } catch {}

        if (matches && playing) {
          if (!playingSince) playingSince = Date.now();
          if (Date.now() - playingSince >= stableMs) {
            resolve(true);
            return;
          }
        } else {
          playingSince = 0;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  }

  function resolveSoundCloudTrack(
    SoundModel: SoundCloudModelConstructor,
    permalink: string,
    timeoutMs = 8000
  ) {
    let parsed: URL;
    try {
      parsed = new URL(permalink, window.location.origin);
    } catch {
      return Promise.resolve<SoundCloudModel | null>(null);
    }

    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (parts.length < 2 || parts[1] === "sets") {
      return Promise.resolve<SoundCloudModel | null>(null);
    }

    const secretToken = parsed.searchParams.get("secret_token") ||
      (parts[2]?.startsWith("s-") ? parts[2] : undefined);

    return new Promise<SoundCloudModel | null>((resolve) => {
      let settled = false;
      const finish = (model: SoundCloudModel | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(model);
      };
      const timeout = window.setTimeout(() => finish(null), timeoutMs);

      try {
        const deferred = SoundModel.resolve(parts[0], parts[1], secretToken);
        if (typeof deferred?.done === "function") {
          deferred.done((model) => finish(model || null));
          deferred.fail?.(() => finish(null));
          return;
        }
        if (typeof deferred?.then === "function") {
          deferred.then((model) => finish(model || null), () => finish(null));
          return;
        }
      } catch (error) {
        log("SoundCloud track resolve failed", error);
      }
      finish(null);
    });
  }

  function getNativePlaybackParts() {
    const runtime = captureSoundCloudWebpackRuntime();
    if (!runtime) return null;

    const manager = findWebpackExport(runtime, [20], isSoundCloudPlayerManager);
    const SoundModel = findWebpackExport(runtime, [27], isSoundCloudModelConstructor);
    if (!manager || !SoundModel) return null;

    const layoutModule = findWebpackExport(
      runtime,
      [271],
      (value): value is { getCurrentLayoutInfo: () => unknown } =>
        !!value && typeof (value as { getCurrentLayoutInfo?: unknown }).getCurrentLayoutInfo === "function"
    );
    return { manager, SoundModel, layoutModule };
  }

  async function playThroughSoundCloudManager(permalink: string) {
    if (!permalink) return false;
    if (nativePlayInFlight && urlsRoughlyMatch(nativePlayInFlight.permalink, permalink)) {
      return nativePlayInFlight.promise;
    }

    const operation = (async () => {
      const parts = getNativePlaybackParts();
      if (!parts) return false;

      const { manager, SoundModel, layoutModule } = parts;
      if (currentSoundMatches(manager, null, permalink)) {
        if (manager.isPlaying() === true) return true;
        try {
          manager.playCurrent({ userInitiated: true });
          return await waitForNativePlayback(manager, null, permalink);
        } catch (error) {
          log("native playCurrent failed", error);
          return false;
        }
      }

      const track = await resolveSoundCloudTrack(SoundModel, permalink);
      if (!track) return false;

      try {
        const layoutInfo = layoutModule?.getCurrentLayoutInfo();
        manager.playSource(
          track,
          track,
          {
            restoreUrl: permalink,
            sourceInfo: {},
            ...(layoutInfo === undefined ? {} : { layoutInfo }),
          },
          { userInitiated: true, seek: 0 }
        );
        const playing = await waitForNativePlayback(manager, track, permalink);
        log(playing ? "native PlayManager started track" : "native PlayManager did not confirm playback", permalink);
        return playing;
      } catch (error) {
        log("native playSource failed", error);
        return false;
      }
    })();

    nativePlayInFlight = { permalink, promise: operation };
    try {
      return await operation;
    } finally {
      if (nativePlayInFlight?.promise === operation) nativePlayInFlight = null;
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

  function isVisiblyRendered(element: HTMLElement | null) {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.();
    if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
    const style = window.getComputedStyle?.(element);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  }

  function getModernTrackPageButton(): HTMLElement | null {
    const buttonSelector =
      'button[aria-label="Play"], button[aria-label="Pause"], button[aria-label^="Play "], button[aria-label^="Pause "]';
    const headings = Array.from(document.querySelectorAll<HTMLElement>(
      'main section[aria-label="Track header"] h1[title], main section[aria-label="Track header"] h2[title], h1[title], h2[title], h1, h2'
    ));
    const candidates: HTMLElement[] = [];
    for (const heading of headings) {
      const trackHeader = heading.closest('section[aria-label="Track header"]');
      const headerButton = trackHeader?.querySelector<HTMLElement>(buttonSelector);
      if (headerButton && !candidates.includes(headerButton)) candidates.push(headerButton);

      let container: Element | null = heading.parentElement;
      for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
        const button = container.querySelector<HTMLElement>(buttonSelector);
        if (button && !candidates.includes(button)) candidates.push(button);
      }
    }

    const visibleCandidate = candidates.find(isVisiblyRendered);
    if (visibleCandidate) return visibleCandidate;
    if (candidates.length) return candidates[0];

    const directCandidates = Array.from(document.querySelectorAll<HTMLElement>(buttonSelector)).filter((button) =>
      !button.closest("nav, [role='navigation'], .playControls, aside")
    );
    return directCandidates.find(isVisiblyRendered) || directCandidates[0] || null;
  }

  function getTargetedPagePlayButton(permalink: string | null): HTMLElement | null {
    if (!permalink) return null;
    if (urlsRoughlyMatch(window.location.href, permalink)) {
      const modernButton = getModernTrackPageButton();
      if (isPlayStartButton(modernButton)) return modernButton;
    }
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
    if (!permalink) return false;
    try {
      if (clickRouterLink(permalink)) return true;

      if (window.history && typeof window.history.pushState === "function") {
        window.history.pushState({}, "", permalink);
        window.dispatchEvent(new PopStateEvent("popstate"));
        window.dispatchEvent(new Event("pushstate"));
        window.dispatchEvent(new Event("locationchange"));
        log("pushState navigation", permalink);
        return true;
      }
      log("native navigation unavailable; hard reload intentionally skipped", permalink);
      return false;
    } catch (e) {
      log("navigation failed; hard reload intentionally skipped", e);
      return false;
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
    const detail = (e as CustomEvent<string | { url?: string } | null>).detail;
    const permalink = typeof detail === "string" ? detail : detail?.url || null;
    if (!permalink) return;

    void playThroughSoundCloudManager(permalink).then((nativeStarted) => {
      const domClicked = nativeStarted ? false : clickTargetedPagePlay(permalink);
      window.dispatchEvent(new CustomEvent("SC_SHUFFLE_PAGE_PLAY_RESULT", {
        detail: {
          url: permalink,
          ok: nativeStarted || domClicked,
          method: nativeStarted ? "soundcloud-play-manager" : domClicked ? "dom-fallback" : "none",
        },
      }));
    });
  });

  (window as any).SCShuffleNative = {
    navigateTo,
    findPlayer() {
      return getNativePlaybackParts()?.manager || null;
    },
    playTrack(trackUrnOrUrl: string) {
      return playThroughSoundCloudManager(trackUrnOrUrl);
    },
    playThroughSoundCloudManager,
    clickFooterPlayCurrent,
    clickTargetedPagePlay,
  };

  log("Native injector loaded");
})();
