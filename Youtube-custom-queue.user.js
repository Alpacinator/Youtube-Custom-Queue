// ==UserScript==
// @name YouTube Queue Manager
// @namespace https://github.com/Alpacinator/Youtube-Custom-Queue/
// @version 1.2.0
// @description A persistent, cross-tab YouTube queue manager with drag-to-reorder, auto-advance, and optional auto theater mode.
// @match *://*.youtube.com/*
// @grant none
// @run-at document-start
// ==/UserScript==

/**
 * YouTube Queue Manager
 *
 * A persistent, cross-tab queue manager injected into YouTube via a userscript.
 *
 * Architecture overview:
 * ─────────────────────────────────────────────────────────────────────────────
 *  Storage        Persists queue, history, and pause state to localStorage.
 *                 An in-memory cache is invalidated whenever another tab writes.
 *
 *  PlayingTab     Claims "ownership" of playback via a heartbeat in localStorage
 *                 so that other tabs know not to also start playing.
 *
 *  Navigator      Uses YouTube's internal yt-navigate event to perform SPA
 *                 navigation without triggering a full page reload.
 *
 *  Player         Owns the end-to-end playback lifecycle: attaches to the
 *                 <video> element, drives the end-poll timer, integrates with
 *                 the MediaSession API, and advances/stops the queue.
 *
 *  ThumbnailInjector
 *                 Injects a circular "+"/"-" button onto every video thumbnail.
 *                 Uses a MutationObserver so freshly rendered thumbnails are
 *                 covered automatically.
 *
 *  UI             Builds the button bar, sliding queue panel, and settings modal
 *                 inside a Shadow DOM so YouTube styles cannot bleed in.
 *
 *  TheaterMode    Optionally toggles YouTube's theater mode based on window width.
 *
 *  ContextMenuBlocker / NativeButtonHider
 *                 Optional quality-of-life suppressors toggled from settings.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Cross-tab communication is achieved entirely through localStorage events;
 * no BroadcastChannel or service worker is required.
 */

(function() {
	'use strict';

	// ─────────────────────────────────────────────
	// CONFIG
	// ─────────────────────────────────────────────

	/** localStorage key that stores the serialised queue / history / paused state. */
	const STORAGE_KEY = 'yt_queue_manager_v1';

	/** localStorage key that holds the TAB_ID of whichever tab currently owns playback. */
	const PLAYING_KEY = 'yt_queue_playing_tab';

	/** localStorage key updated every HEARTBEAT_INTERVAL_MS by the playing tab so
	 *  other tabs can detect whether it is still alive. */
	const HEARTBEAT_KEY = 'yt_queue_heartbeat';

	/** localStorage key written by any tab that wants the playing tab to skip the
	 *  current video. Written then immediately removed; other tabs react in the
	 *  storage event handler. */
	const SKIP_KEY = 'yt_queue_skip_signal';

	/** localStorage key that persists user settings (toggles, intervals). */
	const SETTINGS_KEY = 'yt_queue_settings_v1';

	/** How often (ms) the playing tab refreshes its heartbeat timestamp. */
	const HEARTBEAT_INTERVAL_MS = 3000;

	/** If no heartbeat has been written within this window (ms), the playing tab
	 *  is considered dead and its lock is ignored by other tabs. */
	const HEARTBEAT_TTL_MS = 10000;

	/** How many seconds from the end of a video the queue treats it as "ended"
	 *  and advances to the next item. Avoids waiting for the exact last frame. */
	const VIDEO_END_THRESHOLD_S = 2;

	/** Maximum number of entries kept in the playback history (used by Prev). */
	const HISTORY_MAX = 10;

	/** Maximum time (ms) to wait for the correct <video> element to appear after
	 *  a navigation before giving up and stopping the queue. */
	const NAV_TIMEOUT_MS = 15000;

	/** Poll interval (ms) used when waiting for the <video> element to become
	 *  ready after navigation. */
	const ATTACH_POLL_INTERVAL_MS = 500;

	/** Unused in current logic — originally tracked max retries for play-forcing. */
	const ENSURE_PLAYING_ATTEMPTS = 24;

	/** Delay (ms) between retries when trying to force playback to start. */
	const ENSURE_PLAYING_DELAY_MS = 250;

	/** Extra delay (ms) before re-registering MediaSession handlers after video
	 *  attachment, giving YouTube time to reinitialise its own handlers first. */
	const MEDIASESSION_DELAYED_MS = 1000;

	/** How long (ms) after the cursor leaves a thumbnail card before its overlay
	 *  button fades out. */
	const THUMBNAIL_HIDE_DELAY_MS = 1000;

	/** How often (ms) the ThumbnailInjector prunes stale card entries that are
	 *  no longer in the DOM. */
	const THUMBNAIL_PRUNE_MS = 30000;

	/** Debounce delay (ms) for the theater-mode resize listener. */
	const THEATER_RESIZE_DEBOUNCE_MS = 800;

	/** Debounce delay (ms) for the theater-mode window-focus listener. */
	const THEATER_FOCUS_DEBOUNCE_MS = 300;

	/** Window width fraction below which theater mode is automatically activated
	 *  (i.e. window is narrower than 60% of the screen). */
	const THEATER_MIN_WIDTH_RATIO = 0.6;

	/** Delay (ms) to wait after a URL change fires before treating it as settled
	 *  (prevents double-handling during popstate + yt-navigate-finish races). */
	const URL_CHANGE_SETTLE_MS = 500;

	/** How long (ms) the thumbnail button shows its flash state (checkmark/minus/skip)
	 *  before resetting. */
	const BTN_FLASH_DURATION_MS = 2000;

	/** How long (ms) the main "Add to Queue" button shows its temporary label
	 *  before returning to normal. */
	const BTN_TEMP_TEXT_DURATION_MS = 1800;

	/** How long (ms) the status pill at the bottom-left is visible before fading. */
	const STATUS_DEFAULT_DURATION_MS = 3500;

	// ── Thumbnail overlay button colours ─────────────────────────────────
	// Each button state uses one of three colours. Adjust the RGB values or
	// the opacity (0 = fully transparent, 1 = fully opaque) to taste.
	const THUMB_BTN_GREEN_RGB = '0,210,100'; // idle (add) + added flash
	const THUMB_BTN_RED_RGB = '220,50,50'; // dupe (remove) + removed flash
	const THUMB_BTN_BLUE_RGB = '30,144,255'; // next (play-next) flash
	const THUMB_BTN_OPACITY = 0.45; // shared opacity for all three

	/** Default values for every user-configurable setting. Merged with whatever
	 *  is persisted in localStorage so new keys always have a fallback. */
	const SETTINGS_DEFAULTS = {
		remoteControls: true, // Show cross-tab pause/skip/prev buttons
		theaterMode: false, // Auto theater mode based on window width
		blockContextMenu: true, // Suppress right-click menu site-wide
		mediaSessionRefresh: true, // Periodically re-register media-key handlers
		mediaSessionRefreshInterval: 5, // Seconds between re-registrations
		hideNativeButtons: true, // Hide YouTube's own hover buttons on thumbnails
		restartFromBeginning: false, // Seek to 0:00 on every queue navigation
	};

	/**
	 * Centralised CSS selectors used throughout the script.
	 * Keeping them here makes it easy to update when YouTube changes its DOM.
	 */
	const SEL = {
		/** Selectors for video card containers on listing pages (home, search, sidebar). */
		CARD: [
			'.yt-lockup-view-model',
			'ytd-rich-item-renderer',
			'ytd-compact-video-renderer',
			'ytd-video-renderer',
		].join(', '),

		/** The main YouTube HTML5 player wrapper element. */
		PLAYER: '#movie_player, .html5-video-player',

		/** Anchor tags used in the end-of-video suggestion wall. */
		VIDEOWALL_ANCHOR: 'a.ytp-suggestion-set[href*="/watch?v="]',

		/** Theater-mode toggle button (two selector variants for robustness). */
		THEATER_BTN_DATA: 'button[data-tooltip-target-id="ytp-size-button"]',
		THEATER_BTN_CLASS: '.ytp-size-button',

		/** Play overlays shown when a video is cued but not yet started. */
		PLAY_OVERLAY: '.ytp-large-play-button, .ytp-cued-thumbnail-overlay',

		/** Play/pause button in the player toolbar. */
		PLAY_TOOLBAR: '.ytp-play-button',

		/** Video title <h1> on the watch page (multiple selectors for layout variants). */
		WATCH_TITLE: [
			'ytd-watch-metadata h1 yt-formatted-string',
			'h1.ytd-watch-metadata yt-formatted-string',
			'ytd-video-primary-info-renderer h1 yt-formatted-string',
			'h1.title yt-formatted-string',
			'h1.title',
		].join(', '),

		/** Channel name element on the watch page. */
		CHANNEL_NAME: '#channel-name yt-formatted-string#text, ytd-channel-name yt-formatted-string',

		/** Top-level watch-page container; has a "theater" attribute in theater mode. */
		WATCH_FLEXY: 'ytd-watch-flexy',

		/** Root elements the ThumbnailInjector's MutationObserver attaches to. */
		THUMB_OBSERVER_ROOTS: 'ytd-app, #content, #primary, #secondary',
	};

	// ─────────────────────────────────────────────
	// LOGGING
	// ─────────────────────────────────────────────

	const LOG_PREFIX = '[YT-Queue]';

	function log(...args) {
		console.log(LOG_PREFIX, ...args);
	}

	function warn(...args) {
		console.warn(LOG_PREFIX, ...args);
	}

	// ─────────────────────────────────────────────
	// TAB ID
	// ─────────────────────────────────────────────

	/**
	 * A random identifier for this browser tab, persisted in sessionStorage so it
	 * survives page refreshes within the same tab but is discarded when the tab
	 * is closed. Used to distinguish "am I the playing tab?" from other tabs.
	 */
	const TAB_ID = (() => {
		let id = sessionStorage.getItem('ytqm_tab_id');
		if (!id) {
			id = Math.random().toString(36).slice(2);
			sessionStorage.setItem('ytqm_tab_id', id);
		}
		return id;
	})();

	// ─────────────────────────────────────────────
	// SETTINGS MODULE
	// ─────────────────────────────────────────────

	/**
	 * Thin wrapper around localStorage for user preferences.
	 * Always merges stored values with SETTINGS_DEFAULTS so missing keys
	 * are transparently backfilled on read.
	 */
	const Settings = {
		_defaults() {
			return {
				...SETTINGS_DEFAULTS
			};
		},

		/** Returns the full settings object, merging stored values with defaults. */
		get() {
			try {
				const raw = localStorage.getItem(SETTINGS_KEY);
				return Object.assign(this._defaults(), raw ? JSON.parse(raw) : {});
			} catch {
				return this._defaults();
			}
		},

		/** Persists a single setting key-value pair. */
		set(key, value) {
			const s = this.get();
			s[key] = value;
			try {
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
			} catch {}
		},
	};

	// ─────────────────────────────────────────────
	// STORAGE MODULE
	// ─────────────────────────────────────────────

	/**
	 * Manages persistent state (queue, history, paused flag) in localStorage.
	 *
	 * An in-memory cache (_cache) avoids redundant JSON parse/stringify on every
	 * access. The cache is invalidated by _invalidate() whenever the storage event
	 * fires, signalling that another tab has written new data.
	 *
	 * Schema stored under STORAGE_KEY:
	 * {
	 *   queue:   Array<{ url, title, channel, id }>  — upcoming videos
	 *   history: Array<{ url, title, channel, id }>  — recently played (capped at HISTORY_MAX)
	 *   paused:  boolean                             — cross-tab pause flag
	 * }
	 */
	const Storage = {
		_cache: null,

		_defaults() {
			return {
				queue: [],
				history: [],
				paused: false
			};
		},

		/** Drops the in-memory cache so the next .load() re-reads from localStorage. */
		_invalidate() {
			this._cache = null;
		},

		/**
		 * Returns the full state object, reading from localStorage only when the
		 * cache is cold. Guarantees all keys exist even if storage is stale/corrupt.
		 */
		load() {
			if (this._cache) return this._cache;
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (!raw) {
					this._cache = this._defaults();
					return this._cache;
				}
				const p = JSON.parse(raw);
				if (p.paused === undefined) p.paused = false;
				if (!Array.isArray(p.history)) p.history = [];
				delete p.playing; // Remove legacy key from older versions
				this._cache = p;
				return this._cache;
			} catch (e) {
				warn('Storage.load failed:', e);
				this._cache = this._defaults();
				return this._cache;
			}
		},

		/** Writes the state object to localStorage and updates the cache. */
		save(state) {
			try {
				this._cache = state;
				localStorage.setItem(STORAGE_KEY, JSON.stringify({
					queue: state.queue,
					history: state.history,
					paused: state.paused,
				}));
			} catch (e) {
				warn('Storage.save failed:', e);
			}
		},

		// ── Convenience getters (return copies to prevent accidental mutation) ──

		get queue() {
			return [...this.load().queue];
		},
		get history() {
			return [...this.load().history];
		},
		get paused() {
			return this.load().paused;
		},

		setPaused(val) {
			const s = this.load();
			s.paused = val;
			this.save(s);
		},

		/**
		 * Appends a video to the history ring-buffer, evicting the oldest
		 * entry when the buffer exceeds HISTORY_MAX.
		 */
		pushHistory(video) {
			const s = this.load();
			s.history.push({
				...video,
				id: Date.now()
			});
			if (s.history.length > HISTORY_MAX) s.history.shift();
			this.save(s);
			log('History push:', video.title, '— depth:', s.history.length);
		},

		/** Removes and returns the most recently played video, or null if empty. */
		popHistory() {
			const s = this.load();
			const prev = s.history.pop();
			this.save(s);
			return prev || null;
		},

		/**
		 * Appends a video to the end of the queue.
		 * Returns false (without writing) if the URL is already present.
		 */
		addVideo(url, title, channel = '') {
			const s = this.load();
			if (s.queue.find(v => v.url === url)) {
				log('Already in queue:', url);
				return false;
			}
			s.queue.push({
				url,
				title,
				channel,
				id: Date.now()
			});
			this.save(s);
			log('Added to queue:', title);
			return true;
		},

		/** Removes a queue entry by its numeric id. */
		removeVideo(id) {
			const s = this.load();
			s.queue = s.queue.filter(v => v.id !== id);
			this.save(s);
		},

		/** Removes a queue entry by URL (used by the thumbnail button). */
		removeVideoByUrl(url) {
			const s = this.load();
			s.queue = s.queue.filter(v => v.url !== url);
			this.save(s);
		},

		/**
		 * Removes and returns the first queue entry ("consume" for playback).
		 * Returns undefined when the queue is empty.
		 */
		shiftQueue() {
			const s = this.load();
			const next = s.queue.shift();
			this.save(s);
			return next;
		},

		/** Returns the first queue entry without removing it. */
		peekFirst() {
			return this.load().queue[0] || null;
		},

		/**
		 * Inserts (or moves) a video to a specific queue position.
		 * If the URL is already in the queue it is first removed from its current
		 * position so there are never duplicates.
		 *
		 * @param {string} url
		 * @param {string} title
		 * @param {string} channel
		 * @param {number} insertAt  - 0 = front, 1 = second (after currently playing), etc.
		 */
		insertNext(url, title, channel = '', insertAt = 0) {
			const s = this.load();
			s.queue = s.queue.filter(v => v.url !== url);
			s.queue.splice(insertAt, 0, {
				url,
				title,
				channel,
				id: Date.now()
			});
			this.save(s);
			log('Inserted as next:', title, 'at index', insertAt);
		},

		/**
		 * Moves a queue item from index `from` to index `to`.
		 * When the queue is playing, index 0 (currently playing) is locked and
		 * cannot be the source or destination.
		 *
		 * @param {number}  from
		 * @param {number}  to
		 * @param {boolean} isPlaying  - when true, clamps both indices to >= 1
		 */
		reorder(from, to, isPlaying = false) {
			const min = isPlaying ? 1 : 0;
			from = Math.max(from, min);
			to = Math.max(to, min);
			if (from === to) return;
			const s = this.load();
			const [item] = s.queue.splice(from, 1);
			s.queue.splice(to, 0, item);
			this.save(s);
		},
	};

	// ─────────────────────────────────────────────
	// CROSS-TAB STORAGE EVENT LISTENER
	// ─────────────────────────────────────────────

	/**
	 * Listens for localStorage changes written by other tabs and reacts accordingly:
	 *  - STORAGE_KEY change              → invalidate cache, refresh UI, sync thumbnails
	 *  - PLAYING_KEY / HEARTBEAT_KEY     → refresh the remote-pause button visibility
	 *  - SKIP_KEY change (non-null value) → if this tab is playing, execute the skip
	 */
	window.addEventListener('storage', e => {
		if (e.key === STORAGE_KEY) {
			Storage._invalidate();
			UI.updateControls();
			if (UI.panelOpen) UI.refreshPanel();
			Player._onPauseStorageChange();
			// Keep thumbnail overlay states in sync across tabs when the queue changes.
			ThumbnailInjector.syncAllButtons();
		}
		if (e.key === PLAYING_KEY || e.key === HEARTBEAT_KEY) UI.updateRemotePauseBtn();
		if (e.key === SKIP_KEY && e.newValue !== null) Player._onRemoteSkip();
	});

	// ─────────────────────────────────────────────
	// PLAYING TAB
	// ─────────────────────────────────────────────

	/**
	 * Manages the "playing tab" lock in localStorage.
	 *
	 * Only one tab should drive playback at a time. When a tab starts the queue it
	 * calls claim(), which writes its TAB_ID to PLAYING_KEY and starts a repeating
	 * heartbeat. Other tabs can call anyPlaying() to check whether a live owner
	 * exists before deciding whether to show remote-control buttons.
	 *
	 * The lock is released automatically via the beforeunload handler below.
	 */
	const PlayingTab = {
		_heartbeatTimer: null,

		/** Acquires the playing-tab lock and starts the heartbeat. */
		claim() {
			localStorage.setItem(PLAYING_KEY, TAB_ID);
			this._beat();
			this._heartbeatTimer = setInterval(() => this._beat(), HEARTBEAT_INTERVAL_MS);
		},

		/** Releases the lock and stops the heartbeat. No-op if this tab is not the owner. */
		release() {
			if (!this.isOwner()) return;
			clearInterval(this._heartbeatTimer);
			this._heartbeatTimer = null;
			localStorage.removeItem(PLAYING_KEY);
			localStorage.removeItem(HEARTBEAT_KEY);
		},

		/** Returns true if this tab currently holds the playing-tab lock. */
		isOwner() {
			return localStorage.getItem(PLAYING_KEY) === TAB_ID;
		},

		/**
		 * Returns true if any tab (including this one) is currently playing.
		 * A foreign tab is considered alive only if its heartbeat is fresh.
		 */
		anyPlaying() {
			if (this.isOwner()) return true;
			if (!localStorage.getItem(PLAYING_KEY)) return false;
			const ts = parseInt(localStorage.getItem(HEARTBEAT_KEY) || '0', 10);
			return (Date.now() - ts) < HEARTBEAT_TTL_MS;
		},

		/** Writes the current timestamp to act as a liveness signal. */
		_beat() {
			localStorage.setItem(HEARTBEAT_KEY, Date.now().toString());
		},
	};

	// Release the playing-tab lock when this tab is closed or navigated away from.
	window.addEventListener('beforeunload', () => PlayingTab.release());

	// ─────────────────────────────────────────────
	// PAGE TYPE
	// ─────────────────────────────────────────────

	/** Utility helpers for determining the current YouTube page type. */
	const Page = {
		/** Returns true when the current URL is a watch page (has a `v=` param). */
		isWatchPage() {
			return !!new URLSearchParams(location.search).get('v');
		},
	};

	// ─────────────────────────────────────────────
	// NAVIGATOR
	// ─────────────────────────────────────────────

	/**
	 * Performs YouTube SPA navigation without a full page reload.
	 *
	 * YouTube uses a custom `yt-navigate` event to handle link clicks internally.
	 * We hijack this by:
	 *   1. Finding any anchor to a video that is NOT in the queue (to avoid
	 *      accidentally clicking something the user intended to navigate to).
	 *   2. Intercepting the resulting `yt-navigate` event and mutating its
	 *      endpoint to point at our target video ID instead.
	 *   3. Clicking the hijacked anchor to dispatch the event.
	 *
	 * A second `yt-navigate` event fired by the original anchor (if any) is
	 * blocked to prevent a double-navigation race.
	 */
	const Navigator = {
		goTo(url) {
			const parsed = new URL(url, location.origin);
			const path = parsed.pathname + parsed.search;
			const expectedId = parsed.searchParams.get('v');
			log('Navigating to:', path);

			// Build the set of video IDs already in the queue so we can avoid
			// hijacking an anchor that points to one of them.
			const queueUrls = new Set(Storage.queue.map(v => {
				try {
					return new URL(v.url, location.origin).searchParams.get('v');
				} catch {
					return null;
				}
			}).filter(Boolean));

			// Find the first watch-page anchor whose target video is NOT in the queue.
			const anchor = [...document.querySelectorAll('a[href*="/watch?v="]')].find(a => {
				try {
					const vid = new URL(a.href, location.origin).searchParams.get('v');
					return vid && !queueUrls.has(vid);
				} catch {
					return false;
				}
			});

			if (!anchor) {
				log('No anchor found to hijack');
				return;
			}

			let mutated = false;

			const handler = e => {
				if (!e.detail?.endpoint) return;
				const vid = e.detail.endpoint?.watchEndpoint?.videoId;

				if (!mutated) {
					// First yt-navigate event: rewrite its endpoint to our target.
					log('Mutating yt-navigate endpoint from', vid, 'to', expectedId);
					const ep = e.detail.endpoint;
					if (ep.watchEndpoint) ep.watchEndpoint.videoId = expectedId;
					if (ep.commandMetadata?.webCommandMetadata) {
						ep.commandMetadata.webCommandMetadata.url = path;
					}
					ep.clickTrackingParams = '';
					mutated = true;
				} else {
					// Second yt-navigate event: the original anchor is re-firing; block it.
					log('Blocking duplicate yt-navigate for', vid);
					e.stopImmediatePropagation();
					e.preventDefault();
				}
			};

			// Capture-phase listener so we intercept before YouTube's own handler.
			// Automatically removed after 2 s to avoid leaking across navigations.
			window.addEventListener('yt-navigate', handler, {
				capture: true
			});
			setTimeout(() => window.removeEventListener('yt-navigate', handler, {
				capture: true
			}), 2000);

			anchor.click();
		},
	};

	// ─────────────────────────────────────────────
	// PLAYER MODULE
	// ─────────────────────────────────────────────

	/**
	 * Manages the full playback lifecycle for the queue.
	 *
	 * State flags:
	 *   _playing          — true while the queue is running (not necessarily while
	 *                       the video itself is un-paused).
	 *   _userPaused       — true after the user manually pauses; prevents the script
	 *                       from trying to force-resume after a remote pause/resume cycle.
	 *   _navigatingToPrev — guard to prevent multiple simultaneous "go to previous" navigations.
	 *   _attachedVideoId  — the video ID that _onVideoReady has already been called for;
	 *                       prevents double-attachment if yt-navigate-finish fires again.
	 *
	 * Playback lifecycle:
	 *   start() → Navigator.goTo() (or direct attach if already on target page)
	 *           → _waitForVideoAndPlay() polls until <video> is ready
	 *           → _onVideoReady() attaches listeners + starts end-poll timer
	 *           → _scheduleEndPoll() fires advance() near video end
	 *           → advance() → Navigator.goTo() next, or stop()
	 */
	const Player = {
		_playing: false,
		_userPaused: false,
		_navigatingToPrev: false,
		_endPollTimer: null,
		_attachedVideoId: null,
		_ensurePlayingTimer: null,
		_mediaSessionRefreshTimer: null,
		_pendingSeekToStart: false,

		/**
		 * Starts the queue from the first item.
		 * Claims the playing-tab lock, then navigates to the first video (or
		 * attaches directly if already on the correct page).
		 */
		start() {
			this._playing = true;
			PlayingTab.claim();
			Storage.setPaused(false);

			const first = Storage.peekFirst();
			if (!first) {
				this.stop();
				return;
			}
			UI.updateControls();

			const currentId = new URLSearchParams(location.search).get('v');
			let expectedId;
			try {
				expectedId = new URL(first.url, location.origin).searchParams.get('v');
			} catch {
				this.stop();
				return;
			}

			if (currentId === expectedId) {
				// Already on the right page; skip navigation and attach directly.
				log('Already on the correct page — attaching directly');
				this._waitForVideoAndPlay();
			} else {
				Navigator.goTo(first.url);
			}
		},

		/** Stops the queue, releases all resources, and resets all state flags. */
		stop() {
			log('Stopping queue');
			if (this._ensurePlayingTimer) {
				clearTimeout(this._ensurePlayingTimer);
				this._ensurePlayingTimer = null;
			}
			this._playing = false;
			this._userPaused = false;
			this._attachedVideoId = null;
			this._navigatingToPrev = false;
			PlayingTab.release();
			Storage.setPaused(false);
			this._clearEndPoll();
			this._unregisterMediaSession();
			UI.updateControls();
			UI.showStatus('Queue stopped');
		},

		/** Broadcasts a cross-tab pause signal (does not touch the local <video>). */
		remotePause() {
			Storage.setPaused(true);
			UI.updateRemotePauseBtn();
		},

		/** Broadcasts a cross-tab resume signal. */
		remoteResume() {
			Storage.setPaused(false);
			UI.updateRemotePauseBtn();
		},

		/**
		 * Skips the current video.
		 * If this tab owns playback, skips directly; otherwise writes a signal to
		 * localStorage for the playing tab to act on.
		 */
		remoteSkip() {
			if (this._playing) {
				this.skip();
				return;
			}
			localStorage.setItem(SKIP_KEY, Date.now().toString());
		},

		/** Called by the storage event handler when another tab has written SKIP_KEY. */
		_onRemoteSkip() {
			if (!this._playing) return;
			log('Remote skip received');
			localStorage.removeItem(SKIP_KEY);
			this.skip();
		},

		/**
		 * Reacts to a change in Storage.paused (written by any tab).
		 * Pauses or resumes the local <video> element to match the shared state,
		 * but only when this tab is the playing tab.
		 */
		_onPauseStorageChange() {
			if (!this._playing) return;
			const video = document.querySelector('video');
			if (!video) return;
			const shouldPause = Storage.paused;
			const trulyPlaying = !video.paused && !video.ended && video.readyState >= 3;
			if (shouldPause && trulyPlaying) {
				video.pause();
				UI.showStatus('Paused by another tab');
			} else if (!shouldPause && video.paused && !video.ended && !this._userPaused) {
				video.play().catch(() => this._clickPlayButton());
				UI.showStatus('Resumed by another tab');
			}
		},

		/**
		 * Schedules a recurring check that fires advance() when the video is about
		 * to end (within VIDEO_END_THRESHOLD_S seconds of the end, or when
		 * video.ended is true).
		 *
		 * Adaptive scheduling: when more than 30 s remain, the next check is
		 * deferred until ~28 s before the end, reducing unnecessary timer work.
		 */
		_scheduleEndPoll(video) {
			this._clearEndPoll();
			if (!this._playing || !video) return;

			const check = () => {
				if (!this._playing) return;
				// Don't advance while paused cross-tab; retry in 1 s.
				if (Storage.paused) {
					this._endPollTimer = setTimeout(check, 1000);
					return;
				}

				const remaining = video.duration - video.currentTime;
				const ended = video.ended || (!isNaN(remaining) && remaining <= VIDEO_END_THRESHOLD_S);

				if (ended) {
					log('Video ended — advancing queue');
					this._userPaused = false;
					Storage.setPaused(false);
					this.advance();
				} else if (!isNaN(remaining) && remaining > 30) {
					// Far from the end; sleep until 28 s before the end.
					this._endPollTimer = setTimeout(check, (remaining - 28) * 1000);
				} else {
					// Close to the end; poll every second.
					this._endPollTimer = setTimeout(check, 1000);
				}
			};

			const remaining = video.duration - video.currentTime;
			const delay = (!isNaN(remaining) && remaining > 30) ? (remaining - 28) * 1000 : 1000;
			this._endPollTimer = setTimeout(check, delay);
		},

		/** Cancels any pending end-poll timer. */
		_clearEndPoll() {
			if (this._endPollTimer) {
				clearTimeout(this._endPollTimer);
				this._endPollTimer = null;
			}
		},

		/**
		 * Waits until the correct <video> element is ready for the first queue item,
		 * then calls _onVideoReady().
		 *
		 * Readiness is defined as:
		 *   - The URL contains the expected video ID.
		 *   - A <video> element exists with readyState >= 1 (or currentTime > 0).
		 *   - The YouTube player API (if available) also reports the correct video ID.
		 *
		 * Falls back to stopping the queue if NAV_TIMEOUT_MS elapses without success.
		 */
		_waitForVideoAndPlay() {
			if (!this._playing) return;
			const first = Storage.peekFirst();
			if (!first) {
				this.stop();
				return;
			}
			let expectedId;
			try {
				expectedId = new URL(first.url, location.origin).searchParams.get('v');
			} catch {
				this.stop();
				return;
			}

			const tryAttach = () => {
				if (!this._playing) return false;
				if (new URLSearchParams(location.search).get('v') !== expectedId) return false;
				const video = document.querySelector('video');
				if (!video) return false;
				const playerEl = document.querySelector('#movie_player');
				if (playerEl && typeof playerEl.getVideoData === 'function') {
					const data = playerEl.getVideoData();
					// If the player reports a different video ID, it hasn't loaded ours yet.
					if (data?.video_id && data.video_id !== expectedId) return false;
				}
				return video.readyState >= 1 || video.currentTime > 0;
			};

			// Fast path: video is already ready (e.g. already on the page).
			if (tryAttach()) {
				this._onVideoReady(document.querySelector('video'), first);
				return;
			}

			// Slow path: poll until ready or timeout.
			let resolved = false;
			const pollTimer = setInterval(() => {
				if (!tryAttach()) return;
				clearInterval(pollTimer);
				clearTimeout(fallbackTimer);
				if (resolved) return;
				resolved = true;
				const video = document.querySelector('video');
				if (video) this._onVideoReady(video, first);
				else {
					warn('No <video> after resolve — stopping');
					this.stop();
				}
			}, ATTACH_POLL_INTERVAL_MS);

			const fallbackTimer = setTimeout(() => {
				clearInterval(pollTimer);
				if (resolved) return;
				resolved = true;
				warn('Timed out waiting for <video> — stopping queue');
				this.stop();
			}, NAV_TIMEOUT_MS);
		},

		/**
		 * Called once the target <video> element is confirmed ready.
		 * Attaches event listeners, starts the end-poll, registers MediaSession,
		 * and begins playback.
		 *
		 * Guards against re-entrancy with _attachedVideoId so that rapid
		 * yt-navigate-finish events don't cause duplicate attachments.
		 *
		 * @param {HTMLVideoElement} video
		 * @param {{ title: string, channel: string, url: string }} queueItem
		 */
		_onVideoReady(video, queueItem) {
			const videoId = new URLSearchParams(location.search).get('v');
			if (videoId && videoId === this._attachedVideoId) {
				log('_onVideoReady: already attached for', videoId, '— skipping');
				return;
			}
			this._attachedVideoId = videoId;
			video._ytqmAttachedAt = Date.now(); // Timestamp used to suppress early spurious pause events.

			this._attachVideoListeners(video);
			this._scheduleEndPoll(video);
			this._registerMediaSession();
			this._updateMediaSessionMetadata(queueItem);

			// Honour cross-tab or user pause state before trying to play.
			if (this._userPaused || Storage.paused) return;
			this._startPlayback(video);
		},

		/**
		 * Begins playback, optionally seeking to 0:00 first.
		 *
		 * If restartFromBeginning is enabled the video is paused, a seek to 0 is
		 * issued, and play() is called from the 'seeked' event to ensure the seek
		 * completes before playback starts.
		 *
		 * @param {HTMLVideoElement} video
		 */
		_startPlayback(video) {
			const restartFromBeginning = Settings.get().restartFromBeginning;

			const play = () => {
				video.play().catch(() => this._clickPlayButton());
			};

			const seekThenPlay = () => {
				video.currentTime = 0;
				video.addEventListener('seeked', play, {
					once: true
				});
			};

			// Defer the actual play call until the video has enough data.
			const whenReady = (fn) => {
				if (video.readyState >= 3) fn();
				else video.addEventListener('canplay', fn, {
					once: true
				});
			};

			video.pause();
			whenReady(restartFromBeginning ? seekThenPlay : play);
		},

		/**
		 * Attaches one-time and persistent event listeners to the <video> element.
		 *
		 * The _ytqmListening guard ensures listeners are only attached once per
		 * video element (YouTube may reuse the same element across navigations).
		 *
		 * Listeners attached:
		 *  pause        → sets _userPaused (ignoring early spurious pauses)
		 *  play         → clears _userPaused, re-schedules end-poll if needed
		 *  ended        → status message (advance is driven by the end-poll)
		 *  waiting      → buffering status message
		 *  durationchange → re-schedules end-poll with accurate duration
		 *  canplay (once) → honours a pending seek-to-start request
		 *
		 * @param {HTMLVideoElement} video
		 */
		_attachVideoListeners(video) {
			if (video._ytqmListening) return;
			video._ytqmListening = true;

			video.addEventListener('pause', () => {
				if (!this._playing || video.ended || Storage.paused) return;
				// Suppress the synthetic pause that often fires right after we call
				// video.pause() inside _startPlayback, which happens within 3 s of attach.
				if (Date.now() - (video._ytqmAttachedAt || 0) < 3000) {
					log('Ignoring early pause event');
					return;
				}
				this._userPaused = true;
				log('Video paused by user');
				UI.showStatus('Paused', 99999);
			});

			video.addEventListener('play', () => {
				this._userPaused = false;
				log('Video playing');
				UI.showStatus('Playing', 2000);
				// The end-poll may have been cleared if the video was paused; restart it.
				if (this._playing && !this._endPollTimer) this._scheduleEndPoll(video);
			});

			video.addEventListener('ended', () => UI.showStatus('Advancing queue…'));
			video.addEventListener('waiting', () => UI.showStatus('Buffering…', 5000));

			video.addEventListener('durationchange', () => {
				// Re-calculate the end-poll delay now that we have an accurate duration.
				if (this._playing && !isNaN(video.duration)) this._scheduleEndPoll(video);
			});

			// Handles the case where we need to restart from the beginning but the
			// video wasn't buffered enough to seek immediately in _startPlayback.
			video.addEventListener('canplay', () => {
				if (!this._pendingSeekToStart) return;
				this._pendingSeekToStart = false;
				video.currentTime = 0;
				video.addEventListener('seeked', () => {
					if (!this._userPaused && !Storage.paused) {
						video.play().catch(() => this._clickPlayButton());
					}
				}, {
					once: true
				});
			}, {
				once: true
			});
		},

		/**
		 * Shifts the current item off the queue, pushes it into history, and
		 * navigates to the next video (or stops if the queue is now empty).
		 */
		advance() {
			const current = Storage.shiftQueue();
			if (current) Storage.pushHistory(current);
			const next = Storage.peekFirst();
			this._attachedVideoId = null;
			this._navigatingToPrev = false;
			UI.refreshPanel();
			if (next) Navigator.goTo(next.url);
			else this.stop();
		},

		/** Advances the queue if currently playing; no-op otherwise. */
		skip() {
			if (this._playing) this.advance();
		},

		/**
		 * Navigates to the previously played video by popping the history stack
		 * and re-inserting it at the front of the queue.
		 *
		 * A _navigatingToPrev guard prevents multiple simultaneous navigations if
		 * the button is clicked rapidly.
		 */
		previous() {
			if (!this._playing) return;
			if (this._navigatingToPrev) {
				log('previous(): navigation already in flight — ignoring');
				return;
			}

			const prev = Storage.popHistory();
			if (!prev) {
				UI.showStatus('No previous track', 2000);
				log('previous(): history is empty');
				this._registerMediaSession(); // Refresh handlers so media keys remain responsive.
				return;
			}
			log('Going to previous:', prev.title);
			const s = Storage.load();
			s.queue.unshift({
				...prev,
				id: Date.now()
			});
			Storage.save(s);
			this._attachedVideoId = null;
			this._navigatingToPrev = true;
			UI.refreshPanel();
			Navigator.goTo(prev.url);
		},

		/**
		 * Registers (or re-registers) the MediaSession nexttrack and previoustrack
		 * action handlers so hardware media keys and OS media overlays work.
		 *
		 * YouTube's player often overwrites these handlers after initialising; the
		 * "aggressive refresh" setting periodically re-registers to combat this.
		 */
		_registerMediaSession() {
			if (!('mediaSession' in navigator)) {
				warn('MediaSession API not available');
				return;
			}

			const register = (label = 'MediaSession handlers registered') => {
				navigator.mediaSession.setActionHandler('nexttrack', () => {
					log('MediaSession: nexttrack');
					UI.showStatus('Skipping…', 2000);
					this.skip();
				});
				navigator.mediaSession.setActionHandler('previoustrack', () => {
					log('MediaSession: previoustrack');
					UI.showStatus('Going to previous…', 2000);
					this.previous();
				});
				log(label);
			};

			const s = Settings.get();
			register();

			// Always do one delayed re-registration unless the interval-based refresh
			// is active (which will cover the same window).
			if (!s.mediaSessionRefresh) {
				setTimeout(() => register('MediaSession handlers re-registered (delayed)'), MEDIASESSION_DELAYED_MS);
			}

			this._stopMediaSessionRefresh();

			if (s.mediaSessionRefresh) {
				const intervalMs = Math.max(1, Number(s.mediaSessionRefreshInterval) || 5) * 1000;
				this._mediaSessionRefreshTimer = setInterval(
					() => register('MediaSession handlers re-registered (interval)'),
					intervalMs
				);
				log('MediaSession periodic refresh started, interval:', intervalMs, 'ms');
			}
		},

		/** Stops the periodic MediaSession refresh timer if running. */
		_stopMediaSessionRefresh() {
			if (this._mediaSessionRefreshTimer) {
				clearInterval(this._mediaSessionRefreshTimer);
				this._mediaSessionRefreshTimer = null;
			}
		},

		/** Removes all MediaSession handlers and stops the refresh timer. */
		_unregisterMediaSession() {
			if (!('mediaSession' in navigator)) return;
			this._stopMediaSessionRefresh();
			try {
				navigator.mediaSession.setActionHandler('nexttrack', null);
			} catch {}
			try {
				navigator.mediaSession.setActionHandler('previoustrack', null);
			} catch {}
			log('MediaSession handlers removed');
		},

		/**
		 * Updates the MediaSession metadata (title, artist, album) so OS overlays
		 * and lock-screen controls display the correct queue item information.
		 *
		 * @param {{ title: string, channel: string }} queueItem
		 */
		_updateMediaSessionMetadata(queueItem) {
			if (!('mediaSession' in navigator)) return;
			try {
				navigator.mediaSession.metadata = new MediaMetadata({
					title: queueItem.title || 'YouTube Queue',
					artist: queueItem.channel || 'YouTube',
					album: 'YouTube Queue Manager',
				});
			} catch (e) {
				warn('MediaSession metadata error:', e);
			}
		},

		/**
		 * Attempts to start playback through several fallback strategies:
		 *  1. Click the large overlay play button (shown on cued videos).
		 *  2. Click the toolbar play button (if not already playing).
		 *  3. Dispatch a synthetic 'k' keydown on the player element (YouTube's
		 *     play/pause keyboard shortcut).
		 */
		_clickPlayButton() {
			const overlay = document.querySelector(SEL.PLAY_OVERLAY);
			if (overlay) {
				overlay.click();
				return;
			}
			const toolbar = document.querySelector(SEL.PLAY_TOOLBAR);
			if (toolbar) {
				if ((toolbar.getAttribute('aria-label') || '').toLowerCase().includes('pause')) return;
				toolbar.click();
				return;
			}
			const player = document.querySelector(SEL.PLAYER);
			if (player) player.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'k',
				keyCode: 75,
				bubbles: true
			}));
		},
	};

	// ─────────────────────────────────────────────
	// THUMBNAIL INJECTOR
	// ─────────────────────────────────────────────

	/**
	 * Injects a circular action button onto every video thumbnail across all
	 * YouTube listing pages (home, search, sidebar, end-of-video wall).
	 *
	 * Button states (stored on btn._ytqmState):
	 *  idle    — green "+"; video is not in queue
	 *  added   — green checkmark flash after left-clicking to add
	 *  dupe    — red "x"; video is already in queue (left-click removes)
	 *  removed — red "-" flash after left-clicking to remove
	 *  next    — blue skip icon flash after right-clicking to insert as next
	 *
	 * Left-click  → toggle add/remove from queue
	 * Right-click → insert as "play next" (second position when playing)
	 *
	 * The _cards Map stores per-card state including the hide timer that fades
	 * the button when the cursor leaves the card.
	 */
	const ThumbnailInjector = {
		_observer: null,
		_pruneTimer: null,
		// Map<cardElement, { btn, tooltip, hideTimer, videoUrl }>
		_cards: new Map(),

		/** Starts the injector: injects into existing cards, begins observing new ones. */
		start() {
			this._injectAll();
			// Retry after short delays for cards that were in the DOM but not yet
			// fully rendered when the script first ran.
			setTimeout(() => this._injectAll(), 800);
			setTimeout(() => this._injectAll(), 2000);
			this._observe();
			this._startHoverTracking();
			// Periodically prune the _cards map of entries whose DOM nodes are gone.
			this._pruneTimer = setInterval(() => {
				this._cards.forEach((entry, card) => {
					if (!document.contains(card)) {
						clearTimeout(entry.hideTimer);
						this._cards.delete(card);
					}
				});
			}, THUMBNAIL_PRUNE_MS);
		},

		/** Disconnects the observer and cleans up all card state. */
		stop() {
			if (this._observer) {
				this._observer.disconnect();
				this._observer = null;
			}
			if (this._pruneTimer) {
				clearInterval(this._pruneTimer);
				this._pruneTimer = null;
			}
			this._cards.forEach(({
				hideTimer
			}) => clearTimeout(hideTimer));
			this._cards.clear();
		},

		/**
		 * Re-evaluates every tracked button against the current queue state.
		 *
		 * Called after any queue mutation so buttons reflect reality without
		 * requiring the user to move the mouse over a card.
		 */
		syncAllButtons() {
			const queue = Storage.queue;
			this._cards.forEach((entry) => {
				const inQueue = queue.some(v => v.url === entry.videoUrl);
				const currentState = entry.btn._ytqmState;
				if (inQueue && currentState !== 'dupe') {
					this._applyState(entry, 'dupe');
				} else if (!inQueue && currentState === 'dupe') {
					// Video was removed; revert to idle (hidden) state.
					this._applyState(entry, 'idle');
				}
			});
		},

		/**
		 * Delegates card hover tracking to the document level via event delegation.
		 * This avoids attaching per-card listeners and handles dynamically added cards.
		 *
		 * mouseenter → show the button
		 * mouseleave → schedule fade-out via hideTimer (cancelled if re-entered)
		 */
		_startHoverTracking() {
			document.addEventListener('mouseenter', e => {
				const card = e.target.closest?.(SEL.CARD) || e.target.closest?.('.ytp-suggestion-set');
				if (!card) return;
				const entry = this._cards.get(card);
				if (!entry) return;
				clearTimeout(entry.hideTimer);
				entry.hideTimer = null;
				entry.btn.style.opacity = '1';
				entry.btn.style.transform = 'translateY(0)';
			}, true);

			document.addEventListener('mouseleave', e => {
				const card = e.target.closest?.(SEL.CARD) || e.target.closest?.('.ytp-suggestion-set');
				if (!card) return;
				// Ignore if the cursor moved to a child element of the same card.
				const rel = e.relatedTarget;
				if (rel?.closest?.(SEL.CARD) === card || rel?.closest?.('.ytp-suggestion-set') === card) return;
				const entry = this._cards.get(card);
				if (!entry || entry.hideTimer) return;
				entry.hideTimer = setTimeout(() => {
					entry.btn.style.opacity = '0';
					entry.btn.style.transform = 'translateY(-4px)';
					entry.tooltip.style.opacity = '0';
					entry.hideTimer = null;
				}, THUMBNAIL_HIDE_DELAY_MS);
			}, true);
		},

		/** Sets up a MutationObserver on the main content area to catch newly
		 *  rendered thumbnail anchors and inject buttons into them immediately. */
		_observe() {
			this._observer = new MutationObserver(mutations => {
				for (const m of mutations) {
					m.addedNodes.forEach(node => {
						if (node.nodeType !== Node.ELEMENT_NODE) return;
						this._tryInjectAnchor(node);
						node.querySelectorAll('a[href*="/watch?v="]').forEach(a => this._tryInjectAnchor(a));
						node.querySelectorAll(SEL.VIDEOWALL_ANCHOR).forEach(a => this._tryInjectVideowall(a));
					});
				}
			});
			// Attach to the first matching root; fall back to <body> if none found.
			const roots = [...document.querySelectorAll(SEL.THUMB_OBSERVER_ROOTS)];
			const target = roots.length ? roots[0] : document.body;
			this._observer.observe(target, {
				childList: true,
				subtree: true
			});
		},

		/**
		 * Injects a button into a standard (non-videowall) anchor if it contains
		 * an image and doesn't already have a button.
		 */
		_tryInjectAnchor(node) {
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			if (
				node.matches('a[href*="/watch?v="]') &&
				node.querySelector('img') &&
				!node.querySelector('.ytqm-thumb-add-btn')
			) {
				this._injectButton(node, false);
			}
		},

		/** Injects a button into a videowall (end-of-video suggestions) anchor. */
		_tryInjectVideowall(anchor) {
			if (!anchor.querySelector('.ytqm-thumb-add-btn')) this._injectButton(anchor, true);
		},

		/** Scans the entire document and injects buttons into all matching anchors. */
		_injectAll() {
			document.querySelectorAll('a[href*="/watch?v="]').forEach(anchor => {
				if (!anchor.querySelector('img')) return;
				if (anchor.querySelector('.ytqm-thumb-add-btn')) return;
				this._injectButton(anchor, false);
			});
			document.querySelectorAll(SEL.VIDEOWALL_ANCHOR).forEach(anchor => {
				if (anchor.querySelector('.ytqm-thumb-add-btn')) return;
				this._injectButton(anchor, true);
			});
		},

		/**
		 * Extracts the video title and channel name from a card element.
		 *
		 * For standard cards, multiple selector candidates are tried in priority
		 * order until a non-empty string is found.
		 * For videowall anchors, dedicated child elements are queried first, with
		 * the aria-label as a fallback (with the duration suffix stripped).
		 *
		 * @param  {Element} anchor
		 * @param  {Element} card
		 * @param  {boolean} isVideowall
		 * @returns {{ title: string, channel: string }}
		 */
		_extractVideoMeta(anchor, card, isVideowall) {
			let title = '',
				channel = '';
			if (isVideowall) {
				title = anchor.querySelector('.ytp-modern-videowall-still-info-title')?.textContent?.trim() || '';
				channel = anchor.querySelector('.ytp-modern-videowall-still-info-author')?.textContent?.trim() || '';
				if (!title) {
					// Fall back to aria-label, stripping trailing duration text like "3 minutes, 41 seconds".
					const aria = anchor.getAttribute('aria-label') || '';
					title = aria.replace(/\s+\d[\d:, ]*(seconds?|minutes?|hours?)[^)]*$/i, '').trim();
				}
			} else {
				const candidates = [
					() => card.querySelector('h3[title]')?.getAttribute('title'),
					() => card.querySelector('a[aria-label]')?.getAttribute('aria-label')
					?.replace(/\s+\d[\d:, ]*(seconds?|minutes?|hours?)[^)]*$/i, '').trim(),
					() => card.querySelector('[class*="title"] span, h3 a span')?.textContent?.trim(),
					() => card.querySelector('#video-title')?.textContent?.trim(),
					() => anchor.querySelector('img')?.alt?.trim(),
				];
				for (const fn of candidates) {
					try {
						const t = fn();
						if (t?.length > 0) {
							title = t;
							break;
						}
					} catch {}
				}
				channel = card.querySelector('[class*="channel-name"] a, [href*="/@"]')?.textContent?.trim() || '';
			}
			return {
				title: title || 'Untitled video',
				channel
			};
		},

		/**
		 * Applies a named visual state to a button+tooltip pair.
		 * Extracted from _injectButton so syncAllButtons() can reuse it.
		 *
		 * States: 'idle' | 'added' | 'dupe' | 'removed' | 'next'
		 *
		 * @param {{ btn: HTMLElement, tooltip: HTMLElement }} entry
		 * @param {string}      state
		 * @param {number|null} resetAfterMs  - if set, auto-reverts to 'idle' after this many ms
		 */
		_applyState(entry, state, resetAfterMs = null) {
			const {
				btn,
				tooltip
			} = entry;
			btn._ytqmState = state;
			clearTimeout(btn._ytqmResetTimer);
			btn._ytqmResetTimer = null;

			// Helper that updates only the text node (first child) of the button,
			// leaving the tooltip element untouched.
			const setText = t => {
				if (btn.childNodes[0]?.nodeType === Node.TEXT_NODE) btn.childNodes[0].nodeValue = t;
			};

			switch (state) {
				case 'idle':
					btn.style.background = `rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '0';
					btn.style.transform = 'translateY(-4px)';
					setText('\u002b'); // "+"
					tooltip.textContent = 'Add to Queue';
					break;
				case 'added':
					btn.style.background = `rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '1';
					btn.style.transform = 'translateY(0)';
					setText('\u2713'); // checkmark
					tooltip.textContent = 'Added!';
					break;
				case 'dupe':
					btn.style.background = `rgba(${THUMB_BTN_RED_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '0';
					btn.style.transform = 'translateY(-4px)';
					setText('\u2715'); // "x"
					tooltip.textContent = 'In queue — click to remove';
					break;
				case 'removed':
					btn.style.background = `rgba(${THUMB_BTN_RED_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '1';
					btn.style.transform = 'translateY(0)';
					setText('\u2212'); // minus
					tooltip.textContent = 'Removed from queue';
					break;
				case 'next':
					btn.style.background = `rgba(${THUMB_BTN_BLUE_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '1';
					btn.style.transform = 'translateY(0)';
					setText('\u23ed'); // skip-to-next icon
					tooltip.textContent = 'Playing next!';
					break;
			}
			if (resetAfterMs !== null) {
				btn._ytqmResetTimer = setTimeout(() => this._applyState(entry, 'idle'), resetAfterMs);
			}
		},

		/**
		 * Creates and appends the circular overlay button to a thumbnail anchor.
		 *
		 * @param {Element} anchor      - the <a> tag wrapping the thumbnail
		 * @param {boolean} isVideowall - true when injecting into end-of-video suggestions
		 */
		_injectButton(anchor, isVideowall = false) {
			let videoId, videoUrl;
			try {
				const parsed = new URL(anchor.getAttribute('href') || '', location.origin);
				videoId = parsed.searchParams.get('v');
				if (!videoId) return;
				videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
			} catch {
				return;
			}

			// Make the anchor a positioning context for the absolutely-placed button.
			anchor.style.position = 'relative';
			const card = isVideowall ? anchor : (anchor.closest(SEL.CARD) || anchor);

			// ── Build button element ────────────────────────────────────────────
			const btn = document.createElement('button');
			btn.className = 'ytqm-thumb-add-btn';
			btn._ytqmState = 'idle';
			Object.assign(btn.style, {
				position: 'absolute',
				top: '8px',
				left: '8px',
				zIndex: '9999',
				width: '36px',
				height: '36px',
				borderRadius: '50%',
				border: '1.5px solid rgba(255,255,255,0.8)',
				background: `rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY})`,
				backdropFilter: 'blur(4px)',
				color: '#fff',
				fontSize: '18px',
				lineHeight: '1',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '0',
				fontFamily: "'Segoe UI', Arial, system-ui, sans-serif",
				boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
				pointerEvents: 'all',
				opacity: '0',
				transform: 'translateY(-4px)',
				transition: 'opacity 0.25s ease, transform 0.25s ease, background 0.2s ease',
			});
			btn.textContent = '\u002b'; // "+"

			// ── Build tooltip ────────────────────────────────────────────────────
			const tooltip = document.createElement('div');
			Object.assign(tooltip.style, {
				position: 'absolute',
				bottom: '36px',
				left: '50%',
				transform: 'translateX(-50%)',
				background: 'rgba(0,0,0,0.88)',
				color: '#fff',
				fontSize: '11px',
				fontFamily: "'Segoe UI', Arial, system-ui, sans-serif",
				fontWeight: '600',
				padding: '4px 9px',
				borderRadius: '6px',
				whiteSpace: 'nowrap',
				pointerEvents: 'none',
				opacity: '0',
				transition: 'opacity 0.15s ease',
				zIndex: '10000',
				border: '1px solid rgba(255,255,255,0.15)',
			});
			tooltip.textContent = 'Add to Queue';
			btn.appendChild(tooltip);
			btn.addEventListener('mouseenter', () => {
				tooltip.style.opacity = '1';
			});
			btn.addEventListener('mouseleave', () => {
				tooltip.style.opacity = '0';
			});

			// The entry is created before click handlers so _applyState can be
			// called inside them without a forward reference issue.
			const entry = {
				btn,
				tooltip,
				hideTimer: null,
				videoUrl
			};

			// ── Set initial state based on current queue ────────────────────────
			if (Storage.queue.some(v => v.url === videoUrl)) {
				this._applyState(entry, 'dupe');
			}

			// ── Left-click: toggle add/remove ───────────────────────────────────
			btn.addEventListener('click', e => {
				e.preventDefault();
				e.stopPropagation();

				if (btn._ytqmState === 'dupe') {
					Storage.removeVideoByUrl(videoUrl);
					UI.updateControls();
					if (UI.panelOpen) UI.refreshPanel();
					this._applyState(entry, 'removed', BTN_TEMP_TEXT_DURATION_MS);
					// After the flash completes, re-sync in case the video was
					// re-added by another mechanism during the timeout.
					setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
					return;
				}

				const {
					title,
					channel
				} = this._extractVideoMeta(anchor, card, isVideowall);
				const added = Storage.addVideo(videoUrl, title, channel);
				if (added) {
					this._applyState(entry, 'added', BTN_TEMP_TEXT_DURATION_MS);
					setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
				} else {
					// addVideo returned false: already in queue (race with another tab).
					this._applyState(entry, 'dupe');
				}
				UI.updateControls();
				if (UI.panelOpen) UI.refreshPanel();
			});

			// ── Right-click: insert as "play next" ──────────────────────────────
			btn.addEventListener('contextmenu', e => {
				e.preventDefault();
				e.stopPropagation();

				const {
					title,
					channel
				} = this._extractVideoMeta(anchor, card, isVideowall);
				// When playing, index 0 is the currently playing video so "next" is index 1.
				const insertAt = Player._playing && Storage.queue.length > 0 ? 1 : 0;
				Storage.insertNext(videoUrl, title, channel, insertAt);
				this._applyState(entry, 'next', BTN_TEMP_TEXT_DURATION_MS);
				setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
				UI.updateControls();
				if (UI.panelOpen) UI.refreshPanel();
			});

			anchor.appendChild(btn);
			this._cards.set(card, entry);
		},
	};

	// ─────────────────────────────────────────────
	// UI MODULE
	// ─────────────────────────────────────────────

	/**
	 * Builds and manages the entire injected UI:
	 *  - A fixed button bar (bottom-left) with: Queue | Play Queue | Add to Queue
	 *  - A sliding queue panel listing all queued videos with drag-to-reorder
	 *  - A settings modal accessible from the panel header
	 *  - A status pill for transient notifications
	 *
	 * Everything lives inside a Shadow DOM (#ytqm-host) so YouTube's own
	 * stylesheets cannot interfere with the injected elements.
	 */
	const UI = {
		host: null,
		shadow: null,
		root: null,
		addBtn: null,
		playBtn: null,
		remotePauseBtn: null,
		skipBtn: null,
		prevBtn: null,
		queueToggleBtn: null,
		panel: null,
		list: null,
		settingsOverlay: null,
		panelOpen: false,
		_dragSrcIndex: null, // Index of the item currently being dragged in the queue panel
		addBtnFlash: null,
		addBtnLabel: null,
		_addBtnFlashTimer: null,

		/** Creates the Shadow DOM host and all child UI elements, then mounts to document.body. */
		init() {
			// Remove any stale instance (e.g. after a partial re-injection).
			document.getElementById('ytqm-host')?.remove();

			this.host = document.createElement('div');
			this.host.id = 'ytqm-host';
			// Zero-size fixed host; actual UI is positioned fixed inside the shadow root.
			Object.assign(this.host.style, {
				position: 'fixed',
				bottom: '0',
				left: '0',
				zIndex: '100',
				pointerEvents: 'none',
				width: '0',
				height: '0',
			});

			this.shadow = this.host.attachShadow({
				mode: 'open'
			});
			const style = document.createElement('style');
			style.textContent = this._css();
			this.shadow.appendChild(style);

			this.root = document.createElement('div');
			this.root.id = 'ytqm-root';
			this.shadow.appendChild(this.root);

			this._buildPanel();
			this._buildButtons();
			document.body.appendChild(this.host);

			// Close the panel when clicking outside the host element.
			document.addEventListener('mousedown', e => {
				if (!this.panelOpen) return;
				if (!e.composedPath().some(el => el === this.host)) this.togglePanel(false);
			});

			// Hide UI while browser is in fullscreen — YouTube's fullscreen layer lives
			// outside the normal stacking context so z-index cannot place our UI behind it.
			const onFullscreenChange = () => {
				const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
				this.host.style.visibility = isFullscreen ? 'hidden' : 'visible';
			};
			document.addEventListener('fullscreenchange', onFullscreenChange);
			document.addEventListener('webkitfullscreenchange', onFullscreenChange);

			this.updateControls();
		},

		// ── CSS helpers ─────────────────────────────────────────────────────────
		// CSS is split into focused helpers for maintainability.

		_cssReset() {
			return `* { box-sizing: border-box; margin: 0; padding: 0; }`;
		},

		_cssButtonBar() {
			return `
        #ytqm-root {
          position: fixed; bottom: 24px; left: 20px;
          display: flex; flex-direction: row; align-items: center; gap: 8px;
          pointer-events: all;
        }
        .ytqm-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 9px 15px; border-radius: 999px;
          border: 1.5px solid rgba(255,255,255,0.75);
          cursor: pointer; font-size: 13px; font-weight: 600;
          font-family: 'Segoe UI', Arial, system-ui, sans-serif;
          letter-spacing: 0.02em;
          transition: transform 0.12s ease, opacity 0.12s ease, background 0.2s ease;
          user-select: none; white-space: nowrap;
          box-shadow: 0 4px 18px rgba(0,0,0,0.55); outline: none; line-height: 1;
        }
        .ytqm-btn:hover  { transform: scale(1.04); }
        .ytqm-btn:active { transform: scale(1); }
        #ytqm-add-btn, #ytqm-queue-toggle, #ytqm-play-btn { background: rgba(20,20,20,0.85); color: #fff; }
        #ytqm-add-btn { position: relative; }
        #ytqm-play-btn.is-playing { background: #c0392b; }
        #ytqm-root .ytqm-btn { flex: 1; }
      `;
		},

		_cssAddBtnFlash() {
			return `
        #ytqm-add-btn-flash {
          position: absolute; inset: -2px; border-radius: 999px;
          display: flex; align-items: center; justify-content: center;
          font-size: 13px; font-weight: 600; white-space: nowrap; color: #fff;
          pointer-events: none; opacity: 0;
          transition: opacity 0.25s ease;
          z-index: 1;
        }
        #ytqm-add-btn-flash.visible { opacity: 1; pointer-events: all; }
      `;
		},

		_cssQueuePanel() {
			return `
        #ytqm-panel {
          position: fixed; bottom: 68px; left: 20px;
          width: 330px; max-height: 420px;
          background: #111; border: 1.5px solid rgba(255,255,255,0.18);
          border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.75);
          display: none; flex-direction: column; overflow: hidden;
          color: #fff; font-family: 'Segoe UI', Arial, system-ui, sans-serif;
          pointer-events: all;
        }
        #ytqm-panel.open { display: flex; }

        #ytqm-panel-header {
          padding: 14px 16px 10px; font-size: 13px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase;
          color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.08);
          display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
        }
        .header-controls { display: flex; align-items: center; gap: 6px; }

        #ytqm-panel-title {
          cursor: pointer;
          transition: color 0.2s ease, text-shadow 0.2s ease;
          border-radius: 4px; padding: 1px 3px; margin: -1px -3px;
        }
        #ytqm-panel-title:hover {
          color: #fff;
          text-shadow: 0 0 8px rgba(255,255,255,0.9), 0 0 20px rgba(255,255,255,0.4);
        }
      `;
		},

		_cssPanelControls() {
			return `
        #ytqm-skip-btn, #ytqm-prev-btn, #ytqm-remote-pause-btn {
          background: none; border: 1px solid rgba(255,255,255,0.25);
          border-radius: 999px; color: rgba(255,255,255,0.7);
          padding: 3px 10px; font-size: 11px; cursor: pointer;
          font-family: inherit; transition: all 0.15s;
        }
        #ytqm-skip-btn:hover, #ytqm-prev-btn:hover, #ytqm-remote-pause-btn:hover {
          background: rgba(255,255,255,0.1); color: #fff;
        }
        #ytqm-remote-pause-btn.is-paused {
          background: rgba(39,174,96,0.2); border-color: rgba(39,174,96,0.7); color: #2ecc71;
        }
        #ytqm-remote-pause-btn.is-paused:hover { background: rgba(39,174,96,0.3); }

        #ytqm-close-btn {
          background: #fff; border: 1.5px solid #fff; border-radius: 50%;
          color: #000; cursor: pointer; font-size: 13px;
          width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
          padding: 0; font-family: inherit; flex-shrink: 0; transition: all 0.15s;
        }
        #ytqm-close-btn:hover { color: #fff; background: #e74c3c; border-color: #fff; }
      `;
		},

		_cssQueueList() {
			return `
        #ytqm-list { overflow-y: auto; flex: 1; padding: 8px 0; }
        #ytqm-list::-webkit-scrollbar       { width: 5px; }
        #ytqm-list::-webkit-scrollbar-track { background: transparent; }
        #ytqm-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 99px; }

        .ytqm-item {
          display: flex; align-items: center; gap: 6px;
          padding: 9px 14px; cursor: grab; transition: background 0.12s;
          border-radius: 8px; margin: 2px 6px;
        }
        .ytqm-item:hover     { background: rgba(255,255,255,0.07); }
        .ytqm-item.drag-over { background: rgba(255,255,255,0.14); outline: 1px dashed rgba(255,255,255,0.3); }
        .ytqm-item.dragging  { opacity: 0.35; }
        .ytqm-item.is-locked { cursor: default; }

        .ytqm-item-index { font-size: 12.5px; color: rgba(255,255,255,0.3); flex-shrink: 0; }
        .ytqm-item-title {
          flex: 1; font-size: 12.5px; color: rgba(255,255,255,0.85);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ytqm-item-title.is-current { color: #fff; font-weight: 700; }
        .ytqm-item-remove {
          background: none; border: none; color: rgba(255,255,255,0.25);
          cursor: pointer; font-size: 15px; padding: 0 2px; flex-shrink: 0;
          font-family: inherit; transition: color 0.12s;
        }
        .ytqm-item-remove:hover { color: #e74c3c; }
        #ytqm-empty { padding: 28px 16px; text-align: center; color: rgba(255,255,255,0.3); font-size: 13px; }
      `;
		},

		_cssSettingsOverlay() {
			return `
        #ytqm-settings-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.55); backdrop-filter: blur(3px);
          z-index: 10; display: none; align-items: center; justify-content: center;
          pointer-events: all;
        }
        #ytqm-settings-overlay.open { display: flex; }

        #ytqm-settings-modal {
          background: #111; border: 1.5px solid rgba(255,255,255,0.18);
          border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.75);
          width: 340px; color: #fff;
          font-family: 'Segoe UI', Arial, system-ui, sans-serif; overflow: hidden;
        }
        #ytqm-settings-header {
          padding: 14px 16px 10px; font-size: 13px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase;
          color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.08);
          display: flex; align-items: center; justify-content: space-between;
        }
        #ytqm-settings-body { padding: 10px 0 6px; }

        .ytqm-setting-row {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 10px 16px; border-radius: 8px; margin: 2px 6px;
          transition: background 0.12s; cursor: default;
        }
        .ytqm-setting-row:hover { background: rgba(255,255,255,0.05); }
        .ytqm-setting-label { font-size: 12.5px; color: rgba(255,255,255,0.8); line-height: 1.4; flex: 1; }
        .ytqm-setting-label small {
          display: block; font-size: 11px; color: rgba(255,255,255,0.35);
          margin-top: 2px; font-weight: 400;
        }
        .ytqm-setting-label .ytqm-beta-badge {
          display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
          background: rgba(230,126,34,0.25); color: rgba(230,126,34,0.9);
          border: 1px solid rgba(230,126,34,0.4); border-radius: 4px;
          padding: 1px 5px; margin-left: 5px; vertical-align: middle;
          text-transform: uppercase;
        }
      `;
		},

		_cssToggleSwitch() {
			return `
        .ytqm-toggle { position: relative; flex-shrink: 0; width: 36px; height: 20px; cursor: pointer; }
        .ytqm-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
        .ytqm-toggle-track {
          position: absolute; inset: 0; background: rgba(255,255,255,0.15);
          border-radius: 999px; border: 1px solid rgba(255,255,255,0.2);
          transition: background 0.2s, border-color 0.2s;
        }
        .ytqm-toggle input:checked + .ytqm-toggle-track {
          background: rgba(39,174,96,0.85); border-color: rgba(39,174,96,0.6);
        }
        .ytqm-toggle-thumb {
          position: absolute; top: 3px; left: 3px;
          width: 14px; height: 14px; background: #fff; border-radius: 50%;
          box-shadow: 0 1px 4px rgba(0,0,0,0.4); transition: transform 0.2s; pointer-events: none;
        }
        .ytqm-toggle input:checked ~ .ytqm-toggle-thumb { transform: translateX(16px); }
      `;
		},

		_cssStatusPill() {
			return `
        #ytqm-status            { bottom: 68px !important; transition: bottom 0.2s ease, opacity 0.3s; }
        #ytqm-status.panel-open { bottom: 500px !important; }
      `;
		},

		/** Concatenates all CSS helper strings into the single Shadow DOM <style> block. */
		_css() {
			return [
				this._cssReset(),
				this._cssButtonBar(),
				this._cssAddBtnFlash(),
				this._cssQueuePanel(),
				this._cssPanelControls(),
				this._cssQueueList(),
				this._cssSettingsOverlay(),
				this._cssToggleSwitch(),
				this._cssStatusPill(),
			].join('\n');
		},

		/** Builds the fixed button bar: Queue | Play Queue | Add to Queue */
		_buildButtons() {
			this.addBtn = this._makeBtn('ytqm-add-btn', '', () => this._onAddClick());
			this.queueToggleBtn = this._makeBtn('ytqm-queue-toggle', '\u2261 Queue', () => this.togglePanel());
			this.playBtn = this._makeBtn('ytqm-play-btn', '\u25b6 Play Queue', () => this._onPlayClick());
			this.addBtn.addEventListener('contextmenu', e => this._onAddContextMenu(e));

			// The label span sits inside addBtn so the flash overlay can cover it.
			this.addBtnLabel = document.createElement('span');
			this.addBtnLabel.textContent = '\uff0b Add to Queue';
			this.addBtn.appendChild(this.addBtnLabel);

			// Overlay div that fades in with the "Added!" / "Removed!" feedback.
			this.addBtnFlash = document.createElement('div');
			this.addBtnFlash.id = 'ytqm-add-btn-flash';
			this.addBtn.appendChild(this.addBtnFlash);

			this.root.appendChild(this.queueToggleBtn);
			this.root.appendChild(this.playBtn);
			this.root.appendChild(this.addBtn);
		},

		/**
		 * Factory for a generic pill button inside the Shadow DOM.
		 *
		 * @param {string}   id      - element ID
		 * @param {string}   label   - initial text content
		 * @param {Function} onClick - click handler
		 * @returns {HTMLButtonElement}
		 */
		_makeBtn(id, label, onClick) {
			const btn = document.createElement('button');
			btn.className = 'ytqm-btn';
			btn.id = id;
			btn.textContent = label;
			btn.addEventListener('click', e => {
				e.stopPropagation();
				onClick();
			});
			return btn;
		},

		/** Builds the sliding queue panel and appends it to the Shadow DOM. */
		_buildPanel() {
			this.panel = document.createElement('div');
			this.panel.id = 'ytqm-panel';

			const header = document.createElement('div');
			header.id = 'ytqm-panel-header';

			// Clicking the "Queue" title text opens the settings modal.
			const title = document.createElement('span');
			title.id = 'ytqm-panel-title';
			title.textContent = 'Queue';
			title.title = 'Open settings';
			title.addEventListener('click', e => {
				e.stopPropagation();
				this.openSettings();
			});

			const controls = document.createElement('div');
			controls.className = 'header-controls';

			// Remote pause/resume button — only visible when a tab is playing.
			this.remotePauseBtn = document.createElement('button');
			this.remotePauseBtn.id = 'ytqm-remote-pause-btn';
			this.remotePauseBtn.textContent = '\u23f8 Pause';
			this.remotePauseBtn.style.display = 'none';
			this.remotePauseBtn.addEventListener('click', () => this._onRemotePauseClick());

			const prevBtn = document.createElement('button');
			prevBtn.id = 'ytqm-prev-btn';
			prevBtn.textContent = '\u23ee Prev';
			prevBtn.addEventListener('click', () => Player.previous());
			this.prevBtn = prevBtn;

			const skipBtn = document.createElement('button');
			skipBtn.id = 'ytqm-skip-btn';
			skipBtn.textContent = '\u23ed Skip';
			skipBtn.addEventListener('click', () => Player.remoteSkip());
			this.skipBtn = skipBtn;

			const closeBtn = document.createElement('button');
			closeBtn.id = 'ytqm-close-btn';
			closeBtn.textContent = '\u2716';
			closeBtn.addEventListener('click', () => this.togglePanel(false));

			controls.append(prevBtn, this.remotePauseBtn, skipBtn, closeBtn);
			header.append(title, controls);

			this.list = document.createElement('div');
			this.list.id = 'ytqm-list';

			this.panel.append(header, this.list);
			this.shadow.appendChild(this.panel);
			this._buildSettingsModal();
		},

		/**
		 * Builds the settings modal overlay and appends it to the Shadow DOM.
		 *
		 * Each setting definition in `defs` produces either a toggle switch
		 * (boolean settings) or a number input (interval settings).
		 *
		 * Settings are re-read from Storage each time openSettings() is called
		 * so the UI always reflects the persisted values.
		 */
		_buildSettingsModal() {
			this.settingsOverlay = document.createElement('div');
			this.settingsOverlay.id = 'ytqm-settings-overlay';
			// Close when clicking the dark backdrop (but not the modal card itself).
			this.settingsOverlay.addEventListener('mousedown', e => {
				if (e.target === this.settingsOverlay) this.closeSettings();
			});

			const modal = document.createElement('div');
			modal.id = 'ytqm-settings-modal';

			const header = document.createElement('div');
			header.id = 'ytqm-settings-header';
			const headerTitle = document.createElement('span');
			headerTitle.textContent = 'YT-Q Settings';
			const headerClose = document.createElement('button');
			headerClose.id = 'ytqm-close-btn';
			headerClose.textContent = '\u2716';
			headerClose.addEventListener('click', () => this.closeSettings());
			header.append(headerTitle, headerClose);

			const body = document.createElement('div');
			body.id = 'ytqm-settings-body';

			/** Setting definitions — each object produces one row in the modal. */
			const defs = [{
					key: 'remoteControls',
					label: 'Cross-tab controls',
					sub: 'Show pause, skip & previous buttons in the queue panel when another tab is playing.',
				},
				{
					key: 'theaterMode',
					label: 'Auto theater mode',
					sub: 'Switch to theater mode when the browser window is narrower than 60 % of your screen width, and back when it widens. Useful when sharing the screen with another app.',
				},
				{
					key: 'restartFromBeginning',
					label: 'Always restart from beginning',
					sub: 'Seek to 0:00 whenever the queue navigates to a video, including ones that may have partial watch progress saved by YouTube.',
				},
				{
					key: 'blockContextMenu',
					label: 'Block right-click menu',
					sub: 'Suppress the browser context menu site-wide so right-clicking a thumbnail button always triggers "play next" without the menu appearing.',
				},
				{
					key: 'mediaSessionRefresh',
					label: 'Aggressive MediaSession refresh',
					sub: 'Periodically re-register next/previous track handlers. Fixes media keys going silent after YouTube reinitialises its player.',
				},
				{
					key: 'mediaSessionRefreshInterval',
					label: 'Refresh interval (seconds)',
					sub: 'How often to re-register when aggressive refresh is on. Default: 5 s. Lower = more responsive, slightly more CPU.',
					type: 'number',
				},
				{
					key: 'hideNativeButtons',
					label: 'Hide YouTube\'s thumbnail buttons',
					sub: 'Suppress the native Watch Later and Add to Queue buttons that appear on hover, so only the queue manager button is shown.',
				},
			];

			defs.forEach(def => {
				const row = document.createElement('label');
				row.className = 'ytqm-setting-row';

				const labelWrap = document.createElement('span');
				labelWrap.className = 'ytqm-setting-label';
				labelWrap.textContent = def.label;

				if (def.beta) {
					const badge = document.createElement('span');
					badge.className = 'ytqm-beta-badge';
					badge.textContent = 'beta';
					labelWrap.appendChild(badge);
				}

				if (def.sub) {
					const small = document.createElement('small');
					small.textContent = def.sub;
					labelWrap.appendChild(small);
				}

				let control;
				if (def.type === 'number') {
					control = document.createElement('input');
					control.type = 'number';
					control.min = '1';
					control.max = '60';
					control.step = '1';
					control.value = Settings.get()[def.key];
					control._ytqmSettingKey = def.key;
					Object.assign(control.style, {
						width: '52px',
						background: 'rgba(255,255,255,0.08)',
						border: '1px solid rgba(255,255,255,0.2)',
						borderRadius: '6px',
						color: '#fff',
						padding: '4px 7px',
						fontSize: '12px',
						fontFamily: 'inherit',
						textAlign: 'center',
					});
					control.addEventListener('change', () => {
						const v = Math.max(1, Math.min(60, parseInt(control.value, 10) || 5));
						control.value = v;
						Settings.set(def.key, v);
						log(`Setting changed: ${def.key} =`, v);
						// Restart MediaSession refresh with the new interval if currently playing.
						if (Player._playing) Player._registerMediaSession();
					});
				} else {
					// Toggle switch: <span.ytqm-toggle> wrapping a hidden checkbox + visible track + thumb.
					const toggle = document.createElement('span');
					toggle.className = 'ytqm-toggle';

					const input = document.createElement('input');
					input.type = 'checkbox';
					input.checked = Settings.get()[def.key];
					input._ytqmSettingKey = def.key;

					input.addEventListener('change', () => {
						Settings.set(def.key, input.checked);
						log(`Setting changed: ${def.key} =`, input.checked);
						UI.updateControls();
						UI.updateRemotePauseBtn();
						if (def.key === 'theaterMode') TheaterMode.init();
						if (def.key === 'mediaSessionRefresh' && Player._playing) Player._registerMediaSession();
						if (def.key === 'hideNativeButtons') NativeButtonHider.apply();
					});

					const track = document.createElement('span');
					track.className = 'ytqm-toggle-track';
					const thumb = document.createElement('span');
					thumb.className = 'ytqm-toggle-thumb';
					toggle.append(input, track, thumb);
					control = toggle;
				}

				row.append(labelWrap, control);
				body.appendChild(row);
			});

			modal.append(header, body);
			this.settingsOverlay.appendChild(modal);
			this.shadow.appendChild(this.settingsOverlay);
		},

		/** Opens the settings modal, refreshing all control values from storage first. */
		openSettings() {
			this.settingsOverlay.querySelectorAll('input[type="checkbox"]').forEach(input => {
				input.checked = Settings.get()[input._ytqmSettingKey];
			});
			this.settingsOverlay.querySelectorAll('input[type="number"]').forEach(input => {
				input.value = Settings.get()[input._ytqmSettingKey];
			});
			this.settingsOverlay.classList.add('open');
		},

		closeSettings() {
			this.settingsOverlay.classList.remove('open');
		},

		/**
		 * Reads the current watch page's video ID, title, and channel from the DOM.
		 * Returns null when not on a watch page.
		 *
		 * @returns {{ url: string, title: string, channel: string } | null}
		 */
		_currentVideoMeta() {
			const videoId = new URLSearchParams(location.search).get('v');
			if (!videoId) return null;
			const url = `https://www.youtube.com/watch?v=${videoId}`;
			const titleEl = document.querySelector(SEL.WATCH_TITLE);
			const title = titleEl?.textContent?.trim() ||
				document.title.replace(/\s*[-|]\s*YouTube\s*$/i, '').trim() ||
				'Untitled video';
			const channel = document.querySelector(SEL.CHANNEL_NAME)?.getAttribute('title')?.trim() || '';
			return {
				url,
				title,
				channel
			};
		},

		/**
		 * Shows a brief animated feedback label over the "Add to Queue" button.
		 *
		 * @param {string} label  - text to display (e.g. "Added to Queue")
		 * @param {string} bg     - background colour string for the flash overlay
		 */
		_flashAddBtn(label, bg) {
			clearTimeout(this._addBtnFlashTimer);
			this.addBtnFlash.textContent = label;
			this.addBtnFlash.style.background = bg;
			this.addBtnFlash.classList.add('visible');
			this._addBtnFlashTimer = setTimeout(() => {
				this.addBtnFlash.classList.remove('visible');
				this._addBtnFlashTimer = null;
			}, BTN_FLASH_DURATION_MS);
		},

		/** Handles left-click on the "Add to Queue" button: toggles the current video in/out. */
		_onAddClick() {
			try {
				const meta = this._currentVideoMeta();
				if (!meta) {
					this.addBtnLabel.textContent = 'Not a video page';
					setTimeout(() => this.updateControls(), BTN_TEMP_TEXT_DURATION_MS);
					return;
				}
				const alreadyQueued = !!Storage.queue.find(v => v.url === meta.url);
				if (alreadyQueued) {
					Storage.removeVideoByUrl(meta.url);
					this._flashAddBtn('\u2212 Removed from Queue', 'rgba(192,57,43,0.92)');
				} else {
					Storage.addVideo(meta.url, meta.title, meta.channel);
					this._flashAddBtn('\u2713 Added to Queue', 'rgba(39,174,96,0.92)');
				}
				this.refreshPanel();
				this.updateControls();
			} catch (e) {
				warn('_onAddClick error:', e);
				this.flashBtn(this.addBtn, 'Error');
			}
		},

		/** Handles right-click on the "Add to Queue" button: inserts current video as "play next". */
		_onAddContextMenu(e) {
			e.preventDefault();
			e.stopPropagation();
			try {
				const meta = this._currentVideoMeta();
				if (!meta) return;
				const insertAt = Player._playing && Storage.queue.length > 0 ? 1 : 0;
				Storage.insertNext(meta.url, meta.title, meta.channel, insertAt);
				this._flashAddBtn('\u2713 Added as Next', 'rgba(41,128,185,0.92)');
				this.refreshPanel();
				this.updateControls();
			} catch (e) {
				warn('_onAddContextMenu error:', e);
			}
		},

		/** Handles click on "Play Queue" / "Stop Queue". */
		_onPlayClick() {
			if (Player._playing) {
				Player.stop();
			} else {
				if (Storage.queue.length === 0) {
					this.flashBtn(this.playBtn, 'Queue is empty');
					return;
				}
				this.togglePanel(false);
				Player.start();
			}
			this.updateControls();
		},

		/** Handles click on the remote pause/resume button in the panel header. */
		_onRemotePauseClick() {
			if (Storage.paused) Player.remoteResume();
			else Player.remotePause();
		},

		/**
		 * Temporarily replaces a button's text content with feedback text, then restores it.
		 *
		 * @param {HTMLButtonElement} btn
		 * @param {string}            tempText
		 */
		flashBtn(btn, tempText) {
			const original = btn.textContent;
			btn.textContent = tempText;
			setTimeout(() => {
				btn.textContent = original;
			}, BTN_TEMP_TEXT_DURATION_MS);
		},

		/**
		 * Displays a transient notification pill above the button bar.
		 *
		 * The pill is created lazily on first call and reused thereafter.
		 * Each call resets the auto-hide timer.
		 *
		 * @param {string} msg
		 * @param {number} [durationMs] - how long to show before fading out
		 */
		showStatus(msg, durationMs = STATUS_DEFAULT_DURATION_MS) {
			if (!this.shadow) return;
			let pill = this.shadow.getElementById('ytqm-status');
			if (!pill) {
				pill = document.createElement('div');
				pill.id = 'ytqm-status';
				Object.assign(pill.style, {
					position: 'fixed',
					left: '20px',
					background: 'rgba(0,0,0,0.82)',
					color: '#fff',
					fontSize: '12px',
					fontFamily: "'Segoe UI', system-ui, sans-serif",
					fontWeight: '600',
					padding: '6px 14px',
					borderRadius: '999px',
					border: '1px solid rgba(255,255,255,0.2)',
					pointerEvents: 'none',
					opacity: '0',
					zIndex: '1',
				});
				this.shadow.appendChild(pill);
			}
			pill.classList.toggle('panel-open', this.panelOpen);
			pill.textContent = msg;
			pill.style.opacity = '1';
			clearTimeout(pill._hideTimer);
			pill._hideTimer = setTimeout(() => {
				pill.style.opacity = '0';
			}, durationMs);
		},

		/**
		 * Syncs all button bar controls to reflect the current application state.
		 * Should be called after any queue mutation or playback state change.
		 */
		updateControls() {
			if (!this.addBtn) return;

			const isWatch = Page.isWatchPage();
			const playing = Player._playing;
			const count = Storage.queue.length;

			this.queueToggleBtn.textContent = count > 0 ? `\u2261 Queue (${count})` : '\u2261 Queue';

			// Show/update the "Add to Queue" button only on watch pages.
			const currentUrl = isWatch ?
				`https://www.youtube.com/watch?v=${new URLSearchParams(location.search).get('v')}` :
				null;
			const alreadyQueued = !!currentUrl && !!Storage.queue.find(v => v.url === currentUrl);
			this.addBtn.style.display = isWatch ? 'inline-flex' : 'none';
			if (isWatch) {
				this.addBtnLabel.textContent = alreadyQueued ? '\u2212 Remove from Queue' : '\uff0b Add to Queue';
			}

			this.playBtn.style.display = 'inline-flex';
			this.playBtn.textContent = playing ?
				'\u25a0 Stop Queue' :
				(count > 0 ? `\u25b6 Play Queue (${count})` : '\u25b6 Play Queue');
			playing ? this.playBtn.classList.add('is-playing') : this.playBtn.classList.remove('is-playing');

			this.updateRemotePauseBtn();
		},

		/**
		 * Updates the cross-tab control buttons (pause, skip, prev) visibility and
		 * labels based on current playing/paused state and the remoteControls setting.
		 */
		updateRemotePauseBtn() {
			if (!this.remotePauseBtn) return;

			const anyPlaying = Player._playing || PlayingTab.anyPlaying();
			const remoteControls = Settings.get().remoteControls;

			if (anyPlaying && remoteControls) {
				const isPaused = Storage.paused;
				const hasHistory = Storage.history.length > 0;
				const hasNext = Storage.queue.length > 1;

				this.remotePauseBtn.style.display = 'inline-block';
				this.remotePauseBtn.textContent = isPaused ? '\u25b6 Resume' : '\u23f8 Pause';
				isPaused ?
					this.remotePauseBtn.classList.add('is-paused') :
					this.remotePauseBtn.classList.remove('is-paused');
				// Only show prev/skip when there is actually somewhere to go.
				if (this.prevBtn) this.prevBtn.style.display = hasHistory ? '' : 'none';
				if (this.skipBtn) this.skipBtn.style.display = hasNext ? '' : 'none';
			} else {
				this.remotePauseBtn.style.display = 'none';
				if (this.prevBtn) this.prevBtn.style.display = 'none';
				if (this.skipBtn) this.skipBtn.style.display = 'none';
			}
		},

		/**
		 * Opens or closes the queue panel.
		 *
		 * @param {boolean} [force] - if provided, explicitly sets the open state;
		 *                            otherwise toggles the current state.
		 */
		togglePanel(force) {
			this.panelOpen = force !== undefined ? force : !this.panelOpen;
			if (this.panelOpen) {
				this.refreshPanel();
				this.panel.classList.add('open');
			} else {
				this.panel.classList.remove('open');
			}
			const pill = this.shadow?.getElementById('ytqm-status');
			if (pill) pill.classList.toggle('panel-open', this.panelOpen);
		},

		/**
		 * Rebuilds the queue list DOM from the current Storage.queue state.
		 *
		 * Each item is rendered with:
		 *  - A numeric index label (replaced with a play icon for the currently playing item)
		 *  - The video title (truncated with ellipsis)
		 *  - A remove button
		 *  - Drag-and-drop listeners (disabled for the locked first item when playing)
		 *
		 * Index 0 is "locked" when the queue is playing to prevent accidentally
		 * reordering the currently playing video out of position.
		 */
		refreshPanel() {
			if (!this.list) return;
			const queue = Storage.queue;
			this.list.innerHTML = '';

			if (queue.length === 0) {
				const empty = document.createElement('div');
				empty.id = 'ytqm-empty';
				empty.textContent = 'Queue is empty. Add videos to get started.';
				this.list.appendChild(empty);
				this.updateControls();
				return;
			}

			const currentId = new URLSearchParams(location.search).get('v');

			queue.forEach((video, index) => {
				const isLocked = Player._playing && index === 0;

				const item = document.createElement('div');
				item.className = 'ytqm-item' + (isLocked ? ' is-locked' : '');
				item.draggable = !isLocked;
				item.dataset.index = index;

				const idxLabel = document.createElement('span');
				idxLabel.className = 'ytqm-item-index';
				idxLabel.textContent = index + 1;

				const titleEl = document.createElement('span');
				titleEl.className = 'ytqm-item-title';
				titleEl.textContent = video.title;
				titleEl.title = video.title;

				// Highlight the currently playing item with bold text and a play indicator.
				try {
					const vid = new URL(video.url, location.origin).searchParams.get('v');
					if (currentId && vid === currentId && Player._playing) {
						titleEl.classList.add('is-current');
						idxLabel.textContent = '\u25b6'; // Replace "1" with a play icon
					}
				} catch {}

				const removeBtn = document.createElement('button');
				removeBtn.className = 'ytqm-item-remove';
				removeBtn.textContent = '\u2715';
				removeBtn.addEventListener('click', e => {
					e.stopPropagation();
					Storage.removeVideo(video.id);
					this.refreshPanel();
					this.updateControls();
				});

				item.append(idxLabel, titleEl, removeBtn);

				// Drag-and-drop: the locked first item (currently playing) is neither
				// draggable nor a valid drop target.
				if (!isLocked) {
					item.addEventListener('dragstart', e => {
						this._dragSrcIndex = index;
						item.classList.add('dragging');
						e.dataTransfer.effectAllowed = 'move';
					});
					item.addEventListener('dragend', () => {
						item.classList.remove('dragging');
						this.shadow.querySelectorAll('.ytqm-item').forEach(el => el.classList.remove('drag-over'));
					});
				}
				item.addEventListener('dragover', e => {
					if (isLocked) return;
					e.preventDefault();
					e.dataTransfer.dropEffect = 'move';
					this.shadow.querySelectorAll('.ytqm-item').forEach(el => el.classList.remove('drag-over'));
					item.classList.add('drag-over');
				});
				item.addEventListener('drop', e => {
					if (isLocked) return;
					e.preventDefault();
					const toIndex = parseInt(item.dataset.index, 10);
					if (this._dragSrcIndex !== null && this._dragSrcIndex !== toIndex) {
						Storage.reorder(this._dragSrcIndex, toIndex, Player._playing);
						this._dragSrcIndex = null;
						this.refreshPanel();
					}
				});

				this.list.appendChild(item);
			});

			this.updateControls();
		},
	};

	// ─────────────────────────────────────────────
	// CONTEXT MENU BLOCKER
	// ─────────────────────────────────────────────

	/**
	 * Optionally suppresses the browser's native context menu across all of YouTube.
	 *
	 * This is needed because right-clicking a thumbnail overlay button should always
	 * trigger "insert as next" without the OS/browser context menu appearing on top.
	 * The setting can be disabled for users who rely on the context menu elsewhere.
	 */
	const ContextMenuBlocker = {
		_initialised: false,

		init() {
			if (this._initialised) return;
			this._initialised = true;
			document.addEventListener('contextmenu', e => {
				if (!Settings.get().blockContextMenu) return;
				e.preventDefault();
			}, true);
			log('ContextMenuBlocker initialised');
		},
	};

	// ─────────────────────────────────────────────
	// NATIVE BUTTON HIDER
	//
	// A single <style> tag is all that's needed — these elements are in the
	// regular DOM (not a shadow root), so a document.head stylesheet reaches
	// them and keeps hiding newly-rendered ones automatically.
	// Legacy ytd-* selectors are kept as fallbacks for older YouTube layouts.
	// ─────────────────────────────────────────────

	/**
	 * Optionally hides YouTube's native thumbnail hover buttons (Watch Later,
	 * Add to Queue) by injecting a global <style> into document.head.
	 *
	 * Using a stylesheet rather than DOM removal means the hiding persists
	 * automatically as YouTube renders new thumbnails via its SPA router.
	 */
	const NativeButtonHider = {
		_styleEl: null,

		_CSS: [
			'yt-thumbnail-hover-overlay-toggle-actions-view-model',
			'ytd-thumbnail-overlay-toggle-button-renderer',
			'ytd-thumbnail-overlay-buttons-renderer',
		].map(s => `${s}{display:none!important}`).join(''),

		/** Adds or removes the hiding stylesheet based on the current setting. */
		apply() {
			const shouldHide = Settings.get().hideNativeButtons;
			if (shouldHide && !this._styleEl) {
				this._styleEl = document.createElement('style');
				this._styleEl.id = 'ytqm-hide-native-btns';
				this._styleEl.textContent = this._CSS;
				document.head.appendChild(this._styleEl);
				log('NativeButtonHider: hidden');
			} else if (!shouldHide && this._styleEl) {
				this._styleEl.remove();
				this._styleEl = null;
				log('NativeButtonHider: restored');
			}
		},
	};

	// ─────────────────────────────────────────────
	// URL CHANGE DETECTION
	// ─────────────────────────────────────────────

	/** Tracks the last seen href so URL-change handlers are not fired redundantly. */
	let lastUrl = location.href;

	/** Called when the URL has definitively changed; notifies relevant modules. */
	function notifyUrlChange(newHref) {
		lastUrl = newHref;
		onUrlChange();
	}

	/** Handles any URL change event regardless of whether the actual href changed. */
	function onUrlChange() {
		log('URL changed to', location.href);
		UI.updateControls();
		if (UI.panelOpen) UI.refreshPanel();
		if (Page.isWatchPage()) TheaterMode.init();
		ThumbnailInjector.syncAllButtons();
	}

	// popstate fires on browser back/forward navigation; allow a brief settle before reacting
	// to avoid a race with yt-navigate-finish which may fire immediately after.
	window.addEventListener('popstate', () => {
		setTimeout(() => {
			if (location.href !== lastUrl) notifyUrlChange(location.href);
		}, URL_CHANGE_SETTLE_MS);
	});

	/**
	 * yt-navigate-finish is YouTube's SPA equivalent of DOMContentLoaded.
	 * It fires after every in-app navigation (link clicks, back/forward via YouTube's
	 * own history, etc.) and is the most reliable signal that the new page DOM is ready.
	 */
	window.addEventListener('yt-navigate-finish', () => {
		if (location.href !== lastUrl) notifyUrlChange(location.href);
		else onUrlChange();

		// If the queue is playing, re-attach to the (possibly new) <video> element.
		// _waitForVideoAndPlay guards against unrelated navigations by verifying
		// that the URL matches the expected video ID before attaching.
		if (Player._playing) {
			log('yt-navigate-finish: attaching to video');
			setTimeout(() => Player._waitForVideoAndPlay(), 300);
		}
	});

	// ─────────────────────────────────────────────
	// THEATER MODE MODULE
	// ─────────────────────────────────────────────

	/**
	 * Optionally toggles YouTube's theater mode based on window width.
	 *
	 * When enabled, theater mode is activated when the window is narrower than
	 * THEATER_MIN_WIDTH_RATIO (60%) of the screen width — useful when the browser
	 * is side-by-side with another app. Theater mode is deactivated when the window
	 * widens back past the threshold.
	 *
	 * Checks are debounced to avoid rapid toggling during resize operations.
	 * Only fires when the window has focus or becomes visible, as YouTube's theater
	 * button may not respond when the tab is in the background.
	 */
	const TheaterMode = {
		_initialised: false,
		_debounceTimer: null,

		/**
		 * Locates the theater-mode toggle button using multiple selector strategies
		 * to handle YouTube's occasional DOM restructuring.
		 *
		 * @returns {HTMLElement|undefined}
		 */
		_findTheaterButton() {
			return (
				document.querySelector(SEL.THEATER_BTN_DATA) ||
				document.querySelector(SEL.THEATER_BTN_CLASS) || [...document.querySelectorAll('button[title]')]
				.find(b => b.title.endsWith('(t)') && b.closest('.ytp-right-controls'))
			);
		},

		/** Returns true if the watch page is currently in theater mode. */
		_isTheaterMode() {
			return document.querySelector(SEL.WATCH_FLEXY)?.hasAttribute('theater') ?? false;
		},

		/**
		 * Injects a <style> that forces subtitle text to white.
		 * YouTube's theater mode can render captions with poor contrast in some themes;
		 * this is a minimal targeted fix that avoids overriding YouTube's own styling.
		 */
		_injectCaptionStyle() {
			if (document.getElementById('ytrs-caption-style')) return;
			const style = document.createElement('style');
			style.id = 'ytrs-caption-style';
			style.textContent = '.ytp-caption-segment { color: white !important; }';
			document.head.appendChild(style);
		},

		/**
		 * Evaluates whether theater mode should be toggled and does so if needed.
		 * No-op when the setting is disabled, the window lacks focus, or we're not
		 * on a watch page.
		 */
		check() {
			if (!Settings.get().theaterMode) return;
			if (!document.hasFocus()) return;
			if (!Page.isWatchPage()) return;
			if (document.fullscreenElement || document.webkitFullscreenElement) return; // ← ADD THIS

			const isNarrow = window.innerWidth < window.screen.width * THEATER_MIN_WIDTH_RATIO;
			const inTheater = this._isTheaterMode();

			if (isNarrow && !inTheater) {
				this._findTheaterButton()?.click();
				return;
			}
			if (!isNarrow && inTheater) {
				this._findTheaterButton()?.click();
			}
		},

		_debounce(fn, delay) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = setTimeout(fn, delay);
		},

		/**
		 * Initialises the theater mode module.
		 * If already initialised, simply re-runs check() to sync with current state.
		 * Otherwise attaches resize / focus / visibilitychange listeners and runs
		 * an initial check.
		 */
		init() {
			this._injectCaptionStyle();
			if (this._initialised) {
				this.check();
				return;
			}
			this._initialised = true;

			window.addEventListener('resize',
				() => this._debounce(() => this.check(), THEATER_RESIZE_DEBOUNCE_MS));
			window.addEventListener('focus',
				() => this._debounce(() => this.check(), THEATER_FOCUS_DEBOUNCE_MS));
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') this.check();
			});

			this.check();
			log('TheaterMode initialised');
		},
	};

	// ─────────────────────────────────────────────
	// BOOT
	// ─────────────────────────────────────────────

	/**
	 * Entry point.
	 *
	 * Defers until document.body exists (the script runs at document-start),
	 * then:
	 *  1. Verifies that localStorage is accessible (read + write + read-back check).
	 *  2. Initialises all modules in dependency order.
	 *
	 * If localStorage is unavailable (private browsing on some browsers, restrictive
	 * cookie settings, or sandboxed iframes), a visible error pill is shown and
	 * the script exits early rather than silently failing.
	 */
	function tryInit() {
		if (!document.body) {
			setTimeout(tryInit, 100);
			return;
		}
		log('Initialising…');

		// Verify localStorage is both writable and readable. Some environments
		// provide a non-throwing but non-functional implementation, so a simple
		// write + read-back check is more reliable than try/catch alone.
		try {
			localStorage.setItem('ytqm_test', '1');
			if (localStorage.getItem('ytqm_test') !== '1') throw new Error('read-back mismatch');
			localStorage.removeItem('ytqm_test');
			log('localStorage OK');
		} catch (e) {
			warn('localStorage not available:', e);
			const err = document.createElement('div');
			Object.assign(err.style, {
				position: 'fixed',
				bottom: '24px',
				left: '20px',
				zIndex: '1',
				background: '#c0392b',
				color: '#fff',
				padding: '8px 14px',
				borderRadius: '999px',
				fontFamily: 'sans-serif',
				fontSize: '13px',
				boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
			});
			err.textContent = 'YT Queue: storage unavailable';
			document.body.appendChild(err);
			return;
		}

		UI.init();
		ThumbnailInjector.start();
		ContextMenuBlocker.init();
		NativeButtonHider.apply();
		if (Page.isWatchPage()) TheaterMode.init();
		log('Ready. Queue has', Storage.queue.length, 'items.');
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryInit);
	else tryInit();
})();
