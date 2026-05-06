# YouTube Custom Queue

YouTube's built-in queue is clunky and disappears between sessions. This userscript replaces it with a **persistent, cross-tab queue manager**.

Add videos from thumbnail hover buttons, drag to reorder, auto-advance through your queue, control playback from any tab, use media keys, and enjoy optional auto theater mode.

---

## Quick Start

[![Install](https://img.shields.io/badge/Install-YouTube%20Custom%20Queue-green?style=for-the-badge)](https://raw.githubusercontent.com/Alpacinator/Youtube-Custom-Queue/main/Youtube-custom-queue.user.js)

---

## Features

- **Floating control bar** – Always-visible Add, Play, and Queue buttons
- **Drag-to-reorder queue panel** – Drag items by the ☰ handle; right-click to jump to "Play Next"
- **Improved thumbnail hover buttons** – Left-click to add/remove • Right-click to "Play Next"
- **Auto-advance** – Automatically plays the next video when the current one ends; skips unavailable videos gracefully
- **Shuffle & Clear** – Shuffle remaining items or clear the queue from the panel header
- **Keyboard shortcuts** (optional) – Alt+Q toggles add/remove, Alt+N skips, Alt+P goes back
- **Cross-tab control** – Pause, resume, skip, and previous from any YouTube tab
- **History navigation** – Go back to previously played videos with the Prev button (history capacity: 50)
- **Media key support** – Next / Previous track keys work reliably
- **Auto theater mode** – Switches to theater mode on narrow browser windows
- **Persistent storage** – Your queue survives refreshes and browser restarts via `localStorage`
- **Hide native YouTube buttons** (optional) – Cleans up default Watch Later / Add to Queue buttons
- **Enqueue from phone** (optional) – Videos shared from your Android device go straight into the queue

---

## What's New in v2.0.0 (Major Release)

This is a **significant overhaul** of the internals and UX. While the core queue functionality remains, nearly every subsystem has been refined or hardened:

**New user-facing features:**
- **Unavailable video detection** – Age-restricted, deleted, private, or geo-blocked videos are now detected and automatically skipped instead of stalling the queue
- **Keyboard shortcuts** (optional) – Alt+Q to add/remove current video, Alt+N to skip, Alt+P to go previous (disabled by default; ignored while typing in inputs)
- **Queue actions** – Shuffle remaining items (left-click) and Clear the queue (right-click, with confirmation); Shuffle respects the now-playing item
- **Improved dragging** – Drag by the ☰ handle instead of the entire row, so **titles are now selectable and copyable** without triggering a drag
- **Right-click handle** – Right-click the ☰ handle to move an item to "Play Next" position (consistent with thumbnail button right-click behavior)
- **Better drop indicator** – See exactly where a dragged item will land with a 2px line above or below the target (replaces ambiguous highlight)

**Performance & reliability improvements:**
- **Thumbnail button styling** – Now uses a single shared CSS stylesheet instead of ~25 inline styles per button; much faster on pages with hundreds of thumbnails
- **Faster queue sync** – Uses a cached Set for O(1) membership checks instead of O(n) array search on every hover
- **Event-driven end detection** – Adds `timeupdate` listener so end detection doesn't rely solely on polling
- **Cross-tab safety** – Storage mutations now re-read from `localStorage` immediately before writing, narrowing the two-tab write race to a single event-loop tick
- **Better error handling** – Error messages now stay visible (fixed z-index), phone server URLs are validated with live red-border feedback
- **Collision-safe IDs** – Now uses `crypto.randomUUID()` with a fallback; eliminates the tiny collision risk from timestamp-based IDs
- **Optimized hot paths** – `Page.isWatchPage()` is memoized by URL to avoid re-parsing on every control update

**Developer-friendly improvements:**
- **Comprehensive inline documentation** – Nearly every non-trivial function and module now has a "why" comment explaining its intent
- **Unified Storage API** – New `Storage.mutate(fn)` helper eliminates the repetitive load/mutate/save/invalidate pattern used throughout
- **Public debugging API** – `window.ytQueueManager.setDebug(true)`, `getState()`, and `.version` for inspection and scripting
- **Debug logging** (gated) – Verbose `[YT-Queue]` logging can be enabled from the console without modifying code

---

## Requirements

This is a **userscript**. You need a userscript manager installed first.

| Browser              | Recommended Extension                  |
|----------------------|----------------------------------------|
| Firefox              | Tampermonkey or Greasemonkey           |
| Chrome / Edge / Brave| Tampermonkey                           |
| Safari               | Userscripts                            |

**Tampermonkey** is recommended for best compatibility.

### Install the Script

Click the button above, or install manually:

1. Open Tampermonkey → **Create a new script**
2. Delete the placeholder code
3. Paste the full content of [`Youtube-custom-queue.user.js`](https://raw.githubusercontent.com/Alpacinator/Youtube-Custom-Queue/main/Youtube-custom-queue.user.js)
4. Save (Ctrl/Cmd + S)
5. Go to [youtube.com](https://www.youtube.com) — the control bar will appear in the bottom-left

---

## Usage

### Adding videos to the queue
- **Hover** over any video thumbnail → click the **+** button in the top-left corner
- **Right-click** the + button → insert as **next** to play
- On a watch page → use the **＋ Add to Queue** button in the floating control bar (right-click for "next")

### Playing the queue
1. Click **▶ Play Queue** in the control bar
2. The queue will automatically advance when each video ends
3. Unavailable videos are skipped automatically

### Controls

| Button              | Action                              |
|---------------------|-------------------------------------|
| **▶ Play Queue**    | Start playing the queue             |
| **■ Stop Queue**    | Stop queue playback                 |
| **≡ Queue (n)**     | Open / close the queue panel        |
| **⏸ / ▶**           | Pause / Resume (works across tabs)  |
| **⏮ Prev**          | Go back to the previous video       |
| **⏭ Skip**          | Skip to the next video              |

### Queue Panel
- Click **≡ Queue** to open the panel
- **Drag** items by the ☰ handle to reorder (currently playing video stays at the top)
- **Right-click** the ☰ handle to jump an item to "Play Next"
- Click **✕** to remove an item
- **Shuffle** – Randomize the remaining queue (won't shuffle the now-playing item)
- **Clear** – Remove all queued items (with confirmation; now-playing item is preserved)
- Click the **"Queue"** title at the top to open **Settings**

### Keyboard Shortcuts (Optional)
When enabled in settings:

| Shortcut | Action                                    |
|----------|-------------------------------------------|
| **Alt+Q** | Toggle add/remove current video (watch pages only) |
| **Alt+N** | Skip to next (when queue is playing)      |
| **Alt+P** | Go to previous (when queue is playing)    |

Shortcuts are ignored while you're typing in inputs, search boxes, or comment fields.

---

## Settings

Open Settings by clicking the **Queue** heading in the open queue panel.

| Setting                            | Description |
|------------------------------------|-----------|
| Cross-tab controls                 | Show pause, skip & previous buttons when another tab is playing |
| Auto theater mode                  | Automatically switch to theater mode on narrow windows |
| Block right-click menu             | Suppress context menu so right-click on thumbnail buttons always does "Play Next" |
| Aggressive MediaSession refresh    | Periodically re-register media key handlers (fixes keys stopping after player reloads) |
| Refresh interval (seconds)         | How often to refresh media handlers (default: 5) |
| Hide YouTube's thumbnail buttons   | Hide native Watch Later / Add to Queue buttons |
| Keyboard shortcuts                 | Enable Alt+Q, Alt+N, Alt+P shortcuts (ignored while typing) |
| Enqueue videos shared from phone   | Automatically add videos sent from your phone via local server (URL is validated) |

---

## Debugging

Enable verbose logging from the console:

```javascript
window.ytQueueManager.setDebug(true);
// Logs are prefixed with [YT-Queue]

// Disable again with:
window.ytQueueManager.setDebug(false);

// Or toggle via localStorage and reload:
// localStorage.setItem('ytqm_debug', '1'); location.reload();
```

Inspect the current queue state:

```javascript
window.ytQueueManager.getState()
// Returns: { queue, history, paused, playing, playerActive, thisTabIsOwner, anyTabPlaying }
```

---

## Changelog

### v2.0.0 (Latest) — Major Release
- **Unavailable video detection & auto-skip** – Detects `.ytp-error` overlay (age-restricted, deleted, private, geo-blocked videos) and automatically advances instead of stalling
- **Keyboard shortcuts** (optional) – Alt+Q add/remove, Alt+N skip, Alt+P previous (ignored while typing; disabled by default)
- **Queue management buttons** – Shuffle (randomize remaining items) and Clear (remove all with confirmation) in the "Up Next" section
- **Drag-by-handle pattern** – Queue items now feature a ☰ drag handle; titles are now selectable as text
- **Right-click handle to play next** – Right-click the ☰ handle to move an item to the "next" slot
- **Before/after drop indicators** – Visual 2px line shows exactly where a dragged item will be placed
- **Thumbnail button stylesheet** – All buttons now style via a single `<style>` block instead of inline assignments; ~25 properties × hundreds of buttons is now 0 per-button overhead
- **O(1) queue sync** – Uses a cached `Set` for membership checks; `syncAllButtons()` no longer does O(thumbnails × queueLen) work on large pages
- **Cross-tab write race protection** – `Storage.mutate(fn)` re-reads from `localStorage` immediately before each write, narrowing the two-tab race to the event-loop tick
- **Event-driven end detection** – Adds `timeupdate` listener for immediate end detection; polling fallback remains as a safety net
- **Error pill z-index fix** – Storage unavailable errors now stay visible above YouTube's UI
- **Phone URL validation** – Validates http/https URLs with live red-border feedback in the settings modal
- **Memoized hot paths** – `Page.isWatchPage()` caches by URL; `_uid()` now uses `crypto.randomUUID()` for collision-safety
- **Debug logging gate** – `log()` calls are gated behind a debug flag; enable with `window.ytQueueManager.setDebug(true)` or `localStorage.setItem('ytqm_debug', '1')`
- **Expanded public API** – Added `setDebug()`, `getState()`, and `.version` to `window.ytQueueManager`
- **History capacity** – Raised from 10 → 50 items
- **Developer documentation** – Nearly every module and function now includes inline "why" comments explaining intent and design decisions
- **Fixed duplicate IDs** – Panel and settings close buttons now have distinct IDs (`ytqm-panel-close` / `ytqm-settings-close`) sharing a `.ytqm-close-btn` class

**Bug fixes:**
- Removed dead `_pendingSeekToStart` code branch that was never set to `true`
- `Navigator.goTo` now validates `expectedId` and bails early if null (prevents endpoint mutations with null videoId)
- `_clickPlayButton` no longer relies on deprecated `keyCode` property
- Unused `Storage._invalidate()` calls removed from `QueueIO.importFromClipboard` and `PhonePoller`

### v1.4.1
- Stability improvements for thumbnail button rendering
- Better handling of YouTube's inline hover player
- Phone poller optimizations

### v1.4.0
- Major stability improvement: Thumbnail buttons no longer disappear on hover
- Added `AbortController` for clean video listener management
- Improved SPA navigation fallback
- Simplified Import / Export UI
- Collision-resistant UID generation

### v1.3.0
- Initial public release with core queue functionality, cross-tab support, media keys, auto theater mode, and settings

---

## License

[MIT](./LICENSE) — Feel free to use, modify, and share.
