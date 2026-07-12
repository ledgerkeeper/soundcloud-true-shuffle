# SoundCloud True Shuffle Architecture

## Overview

SoundCloud True Shuffle keeps its own playback queue and uses SoundCloud's native player UI as the playback surface.

The extension does not build a custom audio player. Instead, it:

- fetches complete track collections from SoundCloud internal APIs,
- stores a shuffled queue in the background service worker,
- advances playback by driving the active SoundCloud tab,
- injects lightweight controls into the page and popup.

## Runtime Components

### Background Service Worker

`src/background.ts` is the source of truth and compiles to `dist/src/background.js`.

It is responsible for:

- collecting `client_id` from SoundCloud API traffic,
- reading `oauth_token` from cookies when private contexts require it,
- fetching tracks, playlists, and playlist collections,
- building and persisting the full shuffled queue,
- tracking the active queue index,
- deciding which track should play next,
- exposing queue data to the popup.

Queue state is persisted to `chrome.storage.local` so it survives MV3 worker unloads. The current storage reader remains compatible with the legacy `queueUrls` shape, while new writes persist queue entries only. Queue contents are written when they change; routine track advances update a small position record instead of rewriting the full collection. Playback-state writes are serialized, and a queue is not installed in memory or navigated until its durable write succeeds.

### Content Script

`src/content.ts` compiles to `dist/src/content.js` and runs in SoundCloud tabs.

It is responsible for:

- injecting page UI,
- rendering footer shuffle controls,
- detecting track end and skip events,
- synchronizing page state with the background queue,
- helping SoundCloud load and start the expected track after navigation.

Only the active controller tab is allowed to drive queue progression.

### Injected Main-World Bridge

`src/inject.ts` compiles to `dist/src/inject.js` and runs in the page context.

It is used for:

- SPA-style route changes,
- resolving track models through SoundCloud's already-loaded model layer,
- starting the resolved track through SoundCloud's own `PlayManager`,
- main-world native-control clicks only as a compatibility fallback.

This layer exists because some SoundCloud interactions are more reliable from the page context than from the isolated extension world.

### Popup UI

`src/popup/*` is the operator view.

It provides:

- page-aware shuffle actions,
- current queue status,
- `Now Playing`,
- `Up Next` with a display cap,
- direct selection of a future queue item,
- stop control.

The popup only limits what it renders. It does not truncate the real queue.

## Queue Model

The background keeps one authoritative `playbackQueue` representation. Playback reads each URL from its queue entry instead of maintaining a second synchronized URL array.

Each queue entry stores:

- `url`
- `title`
- `artist`
- `artworkUrl`
- `index`

The queue is fully built in the background and remains full-length. The popup only displays the currently playing item plus up to 50 future items.

Past tracks are not shown in the popup queue view.

## Playback Flow

### Queue Creation

When a shuffle command starts:

1. the background resolves the current SoundCloud context,
2. it fetches the full track set,
3. duplicates are removed,
4. queue entries are normalized to playable URLs,
5. the queue is shuffled,
6. the full queue is stored in memory and persisted.

Each queue build owns an `AbortController`. Starting another shuffle or stopping the current one aborts superseded API work, including client-ID waiting, URL resolution, and navigation fallback waits. The generation-number guard and serialized durable commit remain as defenses against stale writes and navigation.

### Track Advancement

When the queue advances:

1. the background selects the current queue entry,
2. it resolves the playable URL if needed,
3. it asks the content script to perform SPA navigation,
4. the main-world bridge resolves the target SoundCloud model and hands it to the native player manager,
5. if SPA confirmation fails, the current document remains loaded instead of triggering a captcha-prone hard refresh.

### End Detection

Track end is inferred from multiple signals in the content script:

- `audio.ended`,
- timeline progress,
- near-end heuristics,
- footer/player state changes.

The code includes guard rails to avoid duplicate advances when track-end detection, SPA route updates, and manual skip actions overlap.

SoundCloud produces frequent DOM mutations. Mutation-triggered maintenance is coalesced to one pass per animation frame, while the existing one-second safety poll remains in place for background tabs and missed DOM signals.

## Active Tab Ownership

Only one SoundCloud tab acts as the controller for queue progression.

This prevents:

- multiple tabs reporting the same track end,
- popup state drifting across tabs,
- queue jumps caused by non-controller tabs.

The popup and content scripts receive `isActiveTab` in status snapshots so they can render state correctly and avoid acting on the wrong tab.

## Popup Data Contract

The popup relies on background message handlers for:

- current playback status,
- full queue counts,
- current queue item,
- future queue preview,
- play-by-index requests.

The popup does not compute queue state on its own.

## Known Tradeoffs

- SoundCloud is a moving SPA, so DOM selectors can break.
- The native playback bridge feature-detects internal player/model exports, but SoundCloud can still change those private module contracts.
- Large collections can still be expensive to fetch even though popup rendering is capped.
- Playback uses SPA navigation plus the native in-page player; a failed transition is logged without reloading the SoundCloud tab.

## Current Design Direction

The project aims to balance three goals:

- keep SoundCloud's native player experience,
- preserve a full extension-owned queue,
- minimize full-page reloads when possible.

That means the queue stays in the extension, while the user-facing playback stays inside SoundCloud.
