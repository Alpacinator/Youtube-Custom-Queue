# Changelog

All notable changes to the YouTube Queue Manager userscript. Version numbers correspond to the `@version` metadata in `yt-q.user.js`.

## 2.5.0 (vs 2.4.3)

### New Features

- **Selector health check (diagnostic, always on)**
  The script depends on YouTube's internal element names and class hooks, which YouTube renames without notice. When that happens a feature stops working silently with no signal pointing at which selector died. The new SelectorHealth module probes the critical selectors shortly after each navigation settles and logs one console warning per broken selector, naming the selector and the feature it powers. It is purely diagnostic: it never throws, never mutates the page, and never changes behaviour. Warnings are throttled to once per selector per session. A new public API entry, window.ytQueueManager.checkSelectors(), probes everything on demand (ignoring the throttle) and prints a console.table of which selectors currently resolve.

## 2.4.3 (vs 2.4.2)

### Bug Fixes

- **Early queue advance (was: next video starts 2 seconds before current ends)**
  _scheduleEndPoll used `remaining <= VIDEO_END_THRESHOLD_S` (2 s) as a fallback trigger alongside `video.ended`. Because the poll fires on a 1-second interval, it could fire when ~2 seconds of the video remained, satisfying the threshold and calling advance() while the video was still visibly playing. The same threshold was removed from the timeupdate handler in 2.3.2 for the same reason. The poll now advances only when `video.ended` is true. The property is set by the browser even on paths that drop the ended event, so the safety-net goal is preserved with a worst-case lag of one poll tick (~1 s) instead of a 2-second early fire.

- **Hide interruptions banner toggle had no effect**
  The feature targeted `ytd-mealbar-promo-renderer` and `yt-mealbar-promo-renderer-view-model` with an injected CSS rule. The "Experiencing interruptions?" notification is actually a `tp-yt-paper-toast` element added dynamically to `ytd-popup-container`, so the CSS rule never matched anything. Additionally, the toast's text content is populated asynchronously after the element is inserted, making a purely CSS approach unreliable even with the right selector. The hider now uses a MutationObserver that watches for `tp-yt-paper-toast` nodes, waits up to 400 ms for the text to populate, then removes the element if it contains "Experiencing interruptions?". The mealbar CSS is retained as a fallback for the promotional variant of the same message.

- **VERSION constant out of sync with @version**
  `const VERSION` was still '2.4.0' while @version read '2.4.2'. Both now read '2.4.3'.

## 2.4.0 (vs 2.3.2)

### New Features

- **Settings reorganisation with category headers**
  The settings modal is now divided into four labelled sections: Appearance, YouTube, Phone, and Playback. Items are reordered so related controls sit together. Cross-tab controls, Auto theater mode, and Always restart from beginning are now grouped under Playback.

- **Frosted glass queue panel (settings toggle, default ON)**
  A new Appearance toggle applies backdrop-filter blur and a semi-transparent background to the queue panel, giving it a frosted glass look. Toggling it off restores the solid dark background.

- **Phone Server URL shown only when Enqueue from phone is on**
  The Phone server URL input now lives directly below the Enqueue from phone toggle and is hidden whenever that toggle is off. It reappears immediately when the toggle is turned on, keeping the settings list uncluttered.

### UI Changes

- **Panel header: title text removed, cog icon enlarged and whitened**
  The word Queue has been removed from the panel header title area. The settings cog is the sole interactive element there. The icon is enlarged from 13 px to 20 px and rendered in solid white for better visibility against the panel background.

## 2.3.2 (vs 2.3.1)

### Bug Fixes

- **Navigation starts before the video has ended**
  The timeupdate handler triggered advance() whenever the remaining time fell at or below VIDEO_END_THRESHOLD_S (2 seconds), causing the queue to visibly navigate away while the video was still playing. The ended event and _scheduleEndPoll together already handle genuine end-of-video detection reliably; the early-fire threshold in timeupdate was the only path that produced this symptom. The threshold check is removed from the timeupdate handler so it now only advances on video.ended === true. _scheduleEndPoll retains the threshold as a safety net for YouTube paths that drop the ended event near the end of a video.

## 2.3.1 (vs 2.3.0)

### Bug Fixes

- **Double-advance guard**
  advance() had no reentrancy guard. The three end-detection paths (timeupdate, the ended event, the end-poll timer) plus the manual skip controls could each call advance() in separate tasks while _playing stayed true and the next video had not yet attached, shifting two entries off the queue and skipping a video the user never saw. A new _advancing flag is set in advance() and cleared once the next video attaches (_onVideoReady), on stop(), on start(), and on the unplayable-skip path. Fast skip presses now advance one item at a time instead of racing.

- **Queue array validation on load**
  Storage.load() validated history was an array but not queue. A parseable but corrupt state with a missing queue threw inside _rebuildSet and dropped the user back to defaults, losing history too. queue is now coerced to [] like history.

### Misc

- **Extracted two stray magic numbers (remote-stop pause delay, unplayable**

- **skip delay) into named constants. Routed two watch-URL builders through**

- **the existing getVideoId/watchUrl helpers. Bounded the overlay reparent**

- **MutationObserver with a disconnect timeout. Removed decorative emoji**

- **from user-facing strings.**

## 2.3.0 (vs 2.2.0)

### Cross-Tab Controls

- **The Prev / Pause / Skip buttons inside the queue panel already existed**

- **as of 2.2.0 and worked correctly. What was missing was any indication**

- **on the button bar itself that another tab was playing, making it unclear**

- **whether the queue was active at all when you switched tabs.**

- **Play button - remote state**
  The main Play Queue button now has three visual states: • ▶ Play Queue (n) - nothing playing anywhere, default dark. • ■ Stop Queue - this tab is playing, red (unchanged). • ■ Stop Queue (other tab) - another tab owns playback, blue. The blue state appears as soon as the playing tab's heartbeat is detected and disappears within one HEARTBEAT_TTL_MS window (10 s) after the other tab stops. updateControls() now also fires on heartbeat/PLAYING_KEY storage events so the transition is prompt.

- **Remote stop signal**
  Clicking the blue "Stop Queue (other tab)" button writes a timestamp to yt_queue_stop_signal in localStorage (same pattern as the existing skip signal). The playing tab's storage listener picks it up, pauses the video first, waits 300 ms for the browser to render the paused frame, then calls Player.stop(). Pausing first gives the user on the playing tab a visible cue that something happened before the queue UI tears down. If the video is already paused or ended, stop() is called immediately with no delay.

## 2.2.0 (vs 2.1.8)

### New Features

- **Hide Shorts (settings toggle, default ON)**
  Injects a single CSS rule that hides Shorts from every surface: search results (ytd-video-renderer), home/subscriptions grid cards (ytd-rich-item-renderer), compact list cards, grid shelf rows (grid-shelf-view-model), dedicated Shorts shelves (ytd-reel-shelf-renderer), the section wrappers around those shelves, and both the mini-guide and full sidebar Shorts navigation entries. Toggle off in settings to restore them instantly.

- **oEmbed title fetch on phone share**
  When a video URL shared from the phone arrives without a title (e.g. a bare-URL share), the title is now fetched from YouTube's public oEmbed endpoint (youtube.com/oembed?url=…&format=json) before the entry is added to the queue. Works on www.youtube.com (same-origin, no CORS issue). Falls back silently to "Shared from phone" on any error (timeout, 401 for private/age-gated videos, network failure).

- **Navigator documentation**
  Extensive block comment added to the Navigator module explaining why anchor-hijacking was chosen over the obvious alternatives (YouTube's internal API, dispatching yt-navigate directly, history.pushState), and exactly why each of those alternatives doesn't work reliably.

### Bug Fixes

- **Zombie _waitForVideo timers (was: queue advances after manual stop)**
  _waitForVideo scheduled three timers (poll interval, 30s fallback, early-unavailable check) that lived only in closure scope. Player.stop() had no reference to them and couldn't cancel them. 30 seconds after a manual stop, the fallback timer would fire, call _skipUnplayable(), and advance the queue - visibly navigating to the "next" video even though the queue was stopped. Fixed by stashing all three handles on this._waitForVideoHandles and clearing them in stop(). Every callback also re-checks this._playing before acting.

- **Zombie end-poll timer (was: next video silently skipped without playing)**
  advance() and _skipUnplayable() detached event listeners but never cleared the end-poll setTimeout. The old video's ended flag stayed true on the reused <video> element, so if the 1-second poll fired before the new video's _attachVideoListeners had a chance to call _clearEndPoll, the orphan timer called advance() again - pushing the next entry into history and navigating past it without it ever playing. Fixed by calling _clearEndPoll() in both advance() and _skipUnplayable().

- **Queue not stopping on navigate-away**
  Navigating off a watch page while the queue was playing (clicking the YouTube logo, going to subscriptions, etc.) left Player._playing = true with no video to attach to. The queue never stopped on its own; the stop button was the only exit. Fixed in onUrlChange(): if _playing is true and the new URL is not a watch page, Player.stop() is called.

- **Boot-recovery false positives (was: new tab stole playback from another)**
  Boot recovery checks Storage.playing and resumes if true. Storage.playing is a shared localStorage flag set by any tab that starts the queue and cleared only by stop(). A new tab opening while another tab was playing would see playing=true, call Player.start(), steal ownership, and forcibly navigate itself to the queue head. Fixed by also requiring the boot URL to match the queue head's video ID - the unambiguous "user refreshed mid-queue on the watch page" signal.

- **Thumbnail buttons missing on search results**
  Buttons were injected onto ytd-video-renderer (the SEL.CARD match for search results), which is a Polymer custom element. Polymer's shady-DOM rendering swallows children appended from outside the component, giving them a 0×0 getBoundingClientRect and making them invisible. Fixed by changing the container argument in _injectStandard from card to anchor: _injectButton(anchor, anchor, card). The thumbnail anchor is a plain <a> tag that is reliable across all layouts. card is still passed as the third argument so hover tracking and the _cards map are unchanged.

- **Overlay button blocked by stacking context on search results**
  The body-level overlay button was added to solve the z-index issue where YouTube's singleton inline-preview (ytd-video-preview / vpNode) covered the card-mounted button. But on search pages, certain ancestor elements create a sealed stacking context that traps position:fixed elements in the body context rather than the viewport - so vpNode still won. Fixed by reparenting the overlay button into #video-preview (vpNode's grandparent), putting it in vpNode's own stacking context where a high z-index reliably wins. A MutationObserver handles the case where #video-preview doesn't exist yet at boot. Positioning uses a probe (set left:0/top:0, read actual rect, subtract) to handle transformed containing blocks where position:fixed is relative to the ancestor rather than the viewport.

- **Overlay and card button rendering simultaneously (visible doubling)**
  Both the per-card button and the overlay button were visible at the same position on most layouts, causing subtle doubling from box-shadow rendering differences. Fixed by toggling html.ytqm-overlay-active when the overlay is shown, which suppresses all per-card buttons via CSS. The per-card buttons still exist as state holders and forwarding targets.

- **Button flash-and-disappear on vpNode activation (especially first-column)**
  When YouTube's inline preview activated, the button would briefly flash then disappear. Root cause: mouseleave fired on the card when vpNode appeared on top; the relatedTarget was inside vpNode but vpNode's href wasn't loaded yet (async), so the URL-match fallback in findEntry returned null; the hide timer fired and hid the overlay. For first- column / edge cards, vpNode is sometimes offset from the card (to avoid overflowing off-screen left), creating a brief cursor gap that could also trigger the hide timer before the cursor reached vpNode. Fixed with two additions to the hover handlers: mouseleave: explicitly check rel.closest(SEL.VIDEO_PREVIEW) and return early regardless of URL-match state. mouseenter: if target is inside vpNode and _currentHoverCard has a pending hide timer, cancel it - handles the cursor-gap scenario.
