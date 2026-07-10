type ShuffleMode = "likes" | "tracks" | "reposts" | "all";

type RuntimeQueueEntry = {
  index: number | null;
  url: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
};

type BackgroundRuntimeRequest = (
  | { type: "GET_STATUS"; requesterTabId?: number | null }
  | { type: "GET_QUEUE"; requesterTabId?: number | null; maxItems?: number }
  | { type: "STOP_SHUFFLE" }
  | { type: "PLAY_QUEUE_INDEX"; tabId?: number | null; index: number }
  | { type: "START_SHUFFLE_CONTEXT"; mode: ShuffleMode; url: string; tabId?: number | null }
  | { type: "START_SHUFFLE_LIKES"; tabId?: number | null }
  | { type: "START_SHUFFLE_PLAYLIST"; url: string; tabId?: number | null }
  | { type: "START_SHUFFLE_PLAYLISTS"; url: string; tabId?: number | null }
  | { type: "TRACK_FINISHED" }
  | { type: "NAVIGATE_REQUEST"; permalink: string }
  | { type: "SKIP_NEXT" }
  | { type: "SKIP_PREV" }
) & { action?: never };

type ContentRuntimeRequest = (
  | { action: "GET_CURRENT_CONTEXT" }
  | {
      action: "SC_SHUFFLE_STATE";
      isShuffling: boolean;
      isActiveTab: boolean;
      count: number;
      currentIndex: number;
      activeTabId: number | null;
      currentEntry: RuntimeQueueEntry | null;
    }
  | { action: "NAVIGATE_AND_PLAY"; url: string }
  | { action: "ENSURE_PLAYING"; url: string }
) & { type?: never };

type RuntimeRequest = BackgroundRuntimeRequest | ContentRuntimeRequest;
type StartShuffleContextRequest = Extract<BackgroundRuntimeRequest, { type: "START_SHUFFLE_CONTEXT" }>;
type StartShufflePlaylistRequest = Extract<BackgroundRuntimeRequest, { type: "START_SHUFFLE_PLAYLIST" }>;
type StartShufflePlaylistsRequest = Extract<BackgroundRuntimeRequest, { type: "START_SHUFFLE_PLAYLISTS" }>;
type ShuffleStateMessage = Extract<ContentRuntimeRequest, { action: "SC_SHUFFLE_STATE" }>;

type RuntimeResponse = {
  ok?: boolean;
  success?: boolean;
  superseded?: boolean;
  error?: string;
  count?: number;
  mode?: string;
  title?: string;
  isShuffling?: boolean;
  isActiveTab?: boolean;
  currentIndex?: number;
  activeTabId?: number | null;
  currentEntry?: RuntimeQueueEntry | null;
  upNextEntries?: RuntimeQueueEntry[];
  remainingCount?: number;
  playlists?: number;
};
