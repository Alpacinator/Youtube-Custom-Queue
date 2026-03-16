# YouTube Custom Queue

YouTube's built-in queue is clunky and disappears between sessions. This userscript replaces it with a persistent, fully-featured queue manager. Add videos from thumbnail hover buttons without leaving the page, drag to reorder, and pick up exactly where you left off. Control playback from any tab, navigate history with your media keys, and tweak behaviour through a built-in settings menu including auto theater mode for narrow windows.

# Quick start

Click the button below, your userscript manager will open and prompt you to confirm:

[![Install](https://img.shields.io/badge/Install-YouTube%20Custom%20Queue-green?style=for-the-badge)](https://raw.githubusercontent.com/Alpacinator/Youtube-Custom-Queue/main/Youtube-custom-queue.user.js)

---

## Features

- **Floating control bar**, Add to Queue, Play Queue, and Queue panel buttons always within reach
- **Drag-to-reorder panel**, Visual queue list you can rearrange on the fly
- **Thumbnail hover buttons**, Left-click to add/remove, right-click to insert as next
- **Auto-advance**, Automatically plays the next video when the current one ends
- **Cross-tab control**, Pause, resume, skip, and go back to previous from any YouTube tab
- **History navigation**, Step back to previously played videos with the Prev button
- **Media key support**, Next/previous track keys on your keyboard or headset work out of the box
- **Auto theater mode**, Switches to theater mode when the window is narrower than 60% of your screen width
- **Persistent storage**, Your queue survives page refreshes via `localStorage`
- **Hide native YouTube buttons**, Optionally suppress YouTube's own Watch Later / Add to Queue thumbnail buttons

---

## Requirements

This is a **userscript**, a small piece of JavaScript that runs in your browser on top of existing websites. To use it, you need a userscript manager extension installed first.

### Step 1: Install a userscript manager

Pick one for your browser:

| Browser | Recommended extension |
|---|---|
| Firefox | [Greasemonkey](https://www.greasespot.net/) or [Tampermonkey](https://www.tampermonkey.net/) |
| Chrome / Edge / Brave | [Tampermonkey](https://www.tampermonkey.net/) |
| Safari | [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) |

> Tampermonkey is recommended across the board, it is the most actively maintained and has the widest compatibility.

### Step 2: Install the script

Click the button below, your userscript manager will open and prompt you to confirm:

[![Install](https://img.shields.io/badge/Install-YouTube%20Custom%20Queue-green?style=for-the-badge)](https://raw.githubusercontent.com/Alpacinator/Youtube-Custom-Queue/main/Youtube-custom-queue.user.js)

Or install manually:
1. Click the Tampermonkey icon → **Create a new script**
2. Delete any placeholder code
3. Copy the contents of [`Youtube-custom-queue.user.js`](./Youtube-custom-queue.user.js) and paste it in
4. Press **Ctrl+S** (Cmd+S on Mac) to save
5. Navigate to [youtube.com](https://www.youtube.com), the control bar will appear in the bottom-left corner

---

## Usage

### Adding videos to the queue

- **From any page**, hover over a video thumbnail and click the **+** button that appears in the top-left corner of the thumbnail
- **Right-click** the thumbnail button to insert the video as the **next** to play
- **From a watch page**, use the **＋ Add to Queue** button in the bottom-left control bar; right-click it to insert as next

### Playing the queue

1. Open any YouTube video
2. Click **▶ Play Queue** in the control bar
3. The queue will auto-advance through each video in order

### Controls

| Button | Action |
|---|---|
| **▶ Play Queue** | Start playing from the top of the queue |
| **■ Stop Queue** | Stop queue playback |
| **≡ Queue** | Open/close the queue panel |
| **⏸ Pause / ▶ Resume** | Pause or resume from any tab |
| **⏮ Prev** | Go back to the previous video |
| **⏭ Skip** | Skip to the next video |

### Queue panel

- Click **≡ Queue** to open the panel
- **Drag** items to reorder them (the currently playing item is locked in place)
- Click **✕** next to an item to remove it
- Click the **Queue** heading at the top of the panel to open Settings

---

## Settings

Open the settings panel by clicking the **Queue** heading at the top of the open queue panel.

| Setting | Description |
|---|---|
| Cross-tab controls | Show pause, skip & previous buttons when another tab is playing |
| Auto theater mode | Switch to theater mode on narrow windows automatically |
| Block right-click menu | Suppress the browser context menu so right-clicking thumbnail buttons always triggers "play next" |
| Aggressive MediaSession refresh | Periodically re-register media key handlers (fixes keys going silent after YouTube reinitialises its player) |
| Refresh interval (seconds) | How often to re-register when aggressive refresh is on (default: 5 s) |
| Hide YouTube's thumbnail buttons | Suppress YouTube's native Watch Later / Add to Queue hover buttons |

---

## License

[MIT](./LICENSE), use it, modify it, share it, do whatever you like.
