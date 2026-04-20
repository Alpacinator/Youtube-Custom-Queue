# YouTube Custom Queue

YouTube's built-in queue is clunky and disappears between sessions. This userscript replaces it with a **persistent, cross-tab queue manager**.

Add videos from thumbnail hover buttons, drag to reorder, auto-advance through your queue, control playback from any tab, use media keys, and enjoy optional auto theater mode.

---

## Quick Start

[![Install](https://img.shields.io/badge/Install-YouTube%20Custom%20Queue-green?style=for-the-badge)](https://raw.githubusercontent.com/Alpacinator/Youtube-Custom-Queue/main/Youtube-custom-queue.user.js)

---

## Features

- **Floating control bar** – Always-visible Add, Play, and Queue buttons
- **Drag-to-reorder** queue panel
- **Improved thumbnail hover buttons** – Left-click to add/remove • Right-click to "Play Next"
- **Auto-advance** – Automatically plays the next video when the current one ends
- **Cross-tab control** – Pause, resume, skip, and previous from any YouTube tab
- **History navigation** – Go back to previously played videos with the Prev button
- **Media key support** – Next / Previous track keys work reliably
- **Auto theater mode** – Switches to theater mode on narrow browser windows
- **Persistent storage** – Your queue survives refreshes and browser restarts via `localStorage`
- **Hide native YouTube buttons** (optional) – Cleans up default Watch Later / Add to Queue buttons

### Recent Improvements (v1.4.0)
- Thumbnail buttons are now much more stable (no longer disappear on hover)
- Better reliability when navigating between videos in the queue
- Smarter phone integration (only polls from the active playback tab)
- Simplified Import / Export in settings

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
- **Drag** items to reorder (currently playing video stays locked at the top)
- Click **✕** to remove an item
- Click the **"Queue"** title at the top to open **Settings**

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
| Enqueue videos shared from phone   | Automatically add videos sent from your phone via local server |

---

## Changelog

### v1.4.0 (Latest)
- **Major stability improvement**: Thumbnail + buttons no longer disappear when hovering over videos (full support for YouTube’s inline hover player)
- Added `AbortController` for clean video event listener management
- Improved SPA navigation fallback when no anchor link is available
- Phone poller is now smarter (only polls from the active playback tab)
- Simplified Import / Export (now always appends; cleaner UI)
- Added collision-resistant UID generation
- Various bug fixes and reliability improvements

### v1.3.0
- Initial public release with core queue functionality, cross-tab support, media keys, auto theater mode, and settings.

---

## License

[MIT](./LICENSE) — Feel free to use, modify, and share.
