// ==UserScript==
// @name YouTube Queue Manager
// @namespace https://github.com/Alpacinator/Youtube-Custom-Queue/
// @version 2.0.0
// @description A persistent, cross-tab YouTube queue manager with drag-to-reorder, auto-advance, and optional auto theater mode.
// @match *://*.youtube.com/*
// @grant none
// @run-at document-start
// ==/UserScript==

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CHANGELOG — 2.0.0
 * ─────────────────────────────────────────────────────────────────────────────
 *  Bug fixes:
 *    • Removed dead `_pendingSeekToStart` branch in Player (never set true).
 *    • Renamed duplicated `id="ytqm-close-btn"` (panel/settings now distinct).
 *    • Unavailable / age-restricted / deleted videos now SKIP rather than
 *      stalling for the full NAV_TIMEOUT_MS and stopping the entire queue.
 *    • Navigator.goTo now bails early when `expectedId` is null instead of
 *      mutating endpoints with a null videoId.
 *    • _clickPlayButton no longer relies on deprecated `keyCode`.
 *    • Cross-tab write race narrowed: every Storage mutation re-reads the
 *      latest state from localStorage immediately before mutating, so two
 *      tabs adding videos in quick succession no longer silently overwrite
 *      each other (residual race exists only within a single event-loop tick).
 *    • _uid() now uses crypto.randomUUID() when available (no collisions).
 *    • Error pill on storage failure now uses a sane z-index so it isn't
 *      hidden behind YouTube's own UI.
 *    • Phone server URL is validated; invalid input shows a red border.
 *
 *  Performance:
 *    • Thumbnail buttons now style themselves via shared classes in a single
 *      <style> tag instead of ~25 inline-style assignments per button.
 *    • syncAllButtons() consults a cached Set of queued URLs, so hover state
 *      sync is O(thumbnails) instead of O(thumbnails * queueLen).
 *    • Player end detection adds a `timeupdate` listener so we don't depend
 *      solely on the 1-second polling fallback.
 *    • All log()/warn() calls are gated behind a debug flag; quiet by default.
 *    • Page.isWatchPage() memoises by URL.
 *
 *  UX:
 *    • Optional keyboard shortcuts: Alt+Q to add/remove current video,
 *      Alt+N to skip, Alt+P to go to previous (skipped when typing in inputs).
 *    • "Clear queue" and "Shuffle remaining" buttons in the queue panel.
 *    • Drag handle (☰) on each queue item; whole-item drag is gone, so
 *      titles can now be selected/copied without triggering a drag.
 *    • Drop indicator shows whether the dragged item lands ABOVE or BELOW
 *      the hover target, instead of a single ambiguous highlight.
 *    • History capacity raised from 10 → 50.
 *
 *  Internal:
 *    • New helper `getVideoId(url)` replaces ~10 ad-hoc URL-parse blocks.
 *    • Storage now exposes a `mutate(fn)` helper; addVideo/removeVideo/etc.
 *      use it, eliminating the load/mutate/save/_invalidate boilerplate.
 *    • Storage._invalidate() is no longer needed externally — kept for the
 *      cross-tab `storage` event listener only.
 * ─────────────────────────────────────────────────────────────────────────────
 *
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

	const STORAGE_KEY = 'yt_queue_manager_v1';
	const PLAYING_KEY = 'yt_queue_playing_tab';
	const HEARTBEAT_KEY = 'yt_queue_heartbeat';
	const SKIP_KEY = 'yt_queue_skip_signal';
	const SETTINGS_KEY = 'yt_queue_settings_v1';
	const DEBUG_KEY = 'ytqm_debug'; // localStorage flag — set to '1' to enable verbose logging
	const HEARTBEAT_INTERVAL_MS = 3000;
	const HEARTBEAT_TTL_MS = 10000;
	const VIDEO_END_THRESHOLD_S = 2;
	const HISTORY_MAX = 50; // bumped from 10 — the JSON cost is trivial and 10 is too small in practice
	const NAV_TIMEOUT_MS = 30000;
	const ATTACH_POLL_INTERVAL_MS = 500;
	const UNAVAILABLE_CHECK_DELAY_MS = 1500; // grace period before treating a missing <video> as "video unavailable"
	const ENSURE_PLAYING_ATTEMPTS = 24;
	const ENSURE_PLAYING_DELAY_MS = 250;
	const MEDIASESSION_DELAYED_MS = 1000;
	const THUMBNAIL_HIDE_DELAY_MS = 1000;
	const THUMBNAIL_PRUNE_MS = 30000;
	const THEATER_RESIZE_DEBOUNCE_MS = 800;
	const THEATER_FOCUS_DEBOUNCE_MS = 300;
	const THEATER_MIN_WIDTH_RATIO = 0.6;
	const URL_CHANGE_SETTLE_MS = 500;
	const BTN_FLASH_DURATION_MS = 2000;
	const BTN_TEMP_TEXT_DURATION_MS = 1800;
	const STATUS_DEFAULT_DURATION_MS = 3500;
	const PHONE_POLL_INTERVAL_MS = 3000;

	// Thumbnail button colours — referenced from a single <style> sheet now,
	// not inline. Kept here as the source of truth so they stay in sync if
	// you want to tweak them at runtime.
	const THUMB_BTN_GREEN_RGB = '0,210,100';
	const THUMB_BTN_RED_RGB = '220,50,50';
	const THUMB_BTN_BLUE_RGB = '30,144,255';
	const THUMB_BTN_OPACITY = 0.8;

	const SETTINGS_DEFAULTS = {
		remoteControls: true,
		theaterMode: false,
		blockContextMenu: true,
		mediaSessionRefresh: true,
		mediaSessionRefreshInterval: 5,
		hideNativeButtons: true,
		restartFromBeginning: false,
		enqueueFromPhone: false,
		phoneServerUrl: 'http://localhost/poll',
		keyboardShortcuts: true, // Alt+Q / Alt+N / Alt+P (see KeyboardShortcuts module)
	};

	const SEL = {
		CARD: [
			'yt-lockup-view-model', // element tag (new YouTube layout)
			'.yt-lockup-view-model', // class fallback (older layout)
			'ytd-rich-item-renderer',
			'ytd-compact-video-renderer',
			'ytd-video-renderer',
		].join(', '),
		PLAYER: '#movie_player, .html5-video-player',
		VIDEOWALL_ANCHOR: 'a.ytp-suggestion-set[href*="/watch?v="]',
		THEATER_BTN_DATA: 'button[data-tooltip-target-id="ytp-size-button"]',
		THEATER_BTN_CLASS: '.ytp-size-button',
		PLAY_OVERLAY: '.ytp-large-play-button, .ytp-cued-thumbnail-overlay',
		PLAY_TOOLBAR: '.ytp-play-button',
		WATCH_TITLE: [
			'ytd-watch-metadata h1 yt-formatted-string',
			'h1.ytd-watch-metadata yt-formatted-string',
			'ytd-video-primary-info-renderer h1 yt-formatted-string',
			'h1.title yt-formatted-string',
			'h1.title',
		].join(', '),
		CHANNEL_NAME: '#channel-name yt-formatted-string#text, ytd-channel-name yt-formatted-string',
		WATCH_FLEXY: 'ytd-watch-flexy',
		THUMB_OBSERVER_ROOTS: 'ytd-app, #content, #primary, #secondary',
		VIDEO_PREVIEW: 'ytd-video-preview',
	};

	const LOG_PREFIX = '[YT-Queue]';

	// Verbose logging is opt-in. Enable from the console with:
	//   localStorage.setItem('ytqm_debug', '1'); location.reload();
	// We cache the flag at boot to avoid hitting localStorage on every log call;
	// flip it at runtime via window.ytQueueManager.setDebug(true|false).
	let DEBUG = localStorage.getItem(DEBUG_KEY) === '1';

	function log(...args) {
		if (DEBUG) console.log(LOG_PREFIX, ...args);
	}

	// Warnings always print — they signal real problems devs need to see.
	function warn(...args) {
		console.warn(LOG_PREFIX, ...args);
	}

	/**
	 * Collision-safe ID. Prefers crypto.randomUUID when available (always true
	 * in any modern browser running this script). Falls back to a high-entropy
	 * timestamp-mixed value for the rare environment that lacks the API.
	 */
	function _uid() {
		return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}

	/**
	 * Extract the YouTube video ID from any URL (absolute, relative, or watch
	 * URL). Returns null on parse failure or when no `v=` param is present.
	 * Centralised here so a future YouTube URL change only needs one fix.
	 */
	function getVideoId(url) {
		try {
			return new URL(url, location.origin).searchParams.get('v');
		} catch {
			return null;
		}
	}

	/** Build a canonical watch URL from a video ID. */
	function watchUrl(videoId) {
		return `https://www.youtube.com/watch?v=${videoId}`;
	}

	const TAB_ID = (() => {
		let id = sessionStorage.getItem('ytqm_tab_id');
		if (!id) {
			id = Math.random().toString(36).slice(2);
			sessionStorage.setItem('ytqm_tab_id', id);
		}
		return id;
	})();

	// ── Settings ──────────────────────────────────────────────────────────────

	const Settings = {
		_defaults() {
			return {
				...SETTINGS_DEFAULTS
			};
		},
		get() {
			try {
				const raw = localStorage.getItem(SETTINGS_KEY);
				return Object.assign(this._defaults(), raw ? JSON.parse(raw) : {});
			} catch {
				return this._defaults();
			}
		},
		set(key, value) {
			const s = this.get();
			s[key] = value;
			try {
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
			} catch {}
		},
	};

	// ── Storage ───────────────────────────────────────────────────────────────
	//
	// Persistent state lives in localStorage under STORAGE_KEY. An in-memory
	// cache short-circuits redundant reads; it is invalidated by the cross-tab
	// `storage` event listener whenever another tab writes the same key.
	//
	// IMPORTANT: every mutating method goes through `mutate(fn)`, which forces
	// a fresh re-read from localStorage immediately before applying the edit.
	// This narrows the cross-tab write race to the single event-loop tick
	// between read and write — without it, two tabs could simultaneously load
	// the same snapshot, each add a video, and the second tab's save would
	// silently overwrite the first tab's addition.

	const Storage = {
		_cache: null,
		_queueUrlSet: null, // O(1) membership probe used by ThumbnailInjector.syncAllButtons
		_defaults() {
			return {
				queue: [],
				history: [],
				paused: false,
				playing: false
			};
		},
		_invalidate() {
			this._cache = null;
			this._queueUrlSet = null;
		},
		_rebuildSet(state) {
			this._queueUrlSet = new Set(state.queue.map(v => v.url));
		},
		load() {
			if (this._cache) return this._cache;
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (!raw) {
					this._cache = this._defaults();
					this._rebuildSet(this._cache);
					return this._cache;
				}
				const p = JSON.parse(raw);
				if (p.paused === undefined) p.paused = false;
				if (p.playing === undefined) p.playing = false;
				if (!Array.isArray(p.history)) p.history = [];
				this._cache = p;
				this._rebuildSet(this._cache);
				return this._cache;
			} catch (e) {
				warn('Storage.load failed:', e);
				this._cache = this._defaults();
				this._rebuildSet(this._cache);
				return this._cache;
			}
		},
		save(state) {
			try {
				this._cache = state;
				this._rebuildSet(state);
				localStorage.setItem(STORAGE_KEY, JSON.stringify({
					queue: state.queue,
					history: state.history,
					paused: state.paused,
					playing: state.playing ?? false
				}));
			} catch (e) {
				warn('Storage.save failed:', e);
			}
		},
		/**
		 * Run a mutating function against the latest persisted state and save.
		 *
		 * The `_invalidate()` before `load()` is the key cross-tab safety
		 * measure: even if our in-memory cache is stale because another tab
		 * wrote between our last read and now, this re-pulls the freshest
		 * snapshot from localStorage before applying the caller's mutation.
		 *
		 * @param {(state: object) => void} fn  Mutates `state` in place.
		 */
		mutate(fn) {
			this._invalidate();
			const s = this.load();
			fn(s);
			this.save(s);
		},
		/** Quick membership probe — does NOT clone, do not mutate the result. */
		isQueued(url) {
			this.load(); // ensure _queueUrlSet is built
			return this._queueUrlSet.has(url);
		},
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
			this.mutate(s => { s.paused = val; });
		},
		setPlaying(val) {
			this.mutate(s => { s.playing = val; });
		},
		pushHistory(video) {
			this.mutate(s => {
				s.history.push({ ...video, id: _uid() });
				if (s.history.length > HISTORY_MAX) s.history.shift();
			});
			log('History push:', video.title);
		},
		popHistory() {
			let prev = null;
			this.mutate(s => { prev = s.history.pop() || null; });
			return prev;
		},
		addVideo(url, title, channel = '') {
			let added = false;
			this.mutate(s => {
				if (s.queue.find(v => v.url === url)) return;
				s.queue.push({ url, title, channel, id: _uid() });
				added = true;
			});
			if (added) log('Added to queue:', title);
			else log('Already in queue:', url);
			return added;
		},
		removeVideo(id) {
			this.mutate(s => { s.queue = s.queue.filter(v => v.id !== id); });
		},
		removeVideoByUrl(url) {
			this.mutate(s => { s.queue = s.queue.filter(v => v.url !== url); });
		},
		shiftQueue() {
			let next = null;
			this.mutate(s => { next = s.queue.shift(); });
			return next;
		},
		peekFirst() {
			return this.load().queue[0] || null;
		},
		insertNext(url, title, channel = '', insertAt = 0) {
			this.mutate(s => {
				const existingIdx = s.queue.findIndex(v => v.url === url);
				// If the video is already in the queue before the insertion point,
				// removing it shifts everything down by one to compensate.
				if (existingIdx !== -1 && existingIdx < insertAt) insertAt--;
				s.queue = s.queue.filter(v => v.url !== url);
				s.queue.splice(insertAt, 0, { url, title, channel, id: _uid() });
			});
			log('Inserted as next:', title, 'at index', insertAt);
		},
		/**
		 * Move a queue item from index `from` to `to`. No clamping: callers
		 * pass actual queue indices directly. The "now playing" item (index
		 * 0 when playing) is visually separated in the UI so it never appears
		 * in the draggable list — no need to guard it here.
		 */
		reorder(from, to) {
			if (from === to) return;
			this.mutate(s => {
				const [item] = s.queue.splice(from, 1);
				s.queue.splice(to, 0, item);
			});
		},
		/** Replace the full queue (used by Clear / Shuffle actions). */
		setQueue(newQueue) {
			this.mutate(s => { s.queue = newQueue; });
		},
	};

	// ── Cross-tab storage listener ─────────────────────────────────────────────

	window.addEventListener('storage', e => {
		if (e.key === STORAGE_KEY) {
			Storage._invalidate();
			UI.updateControls();
			if (UI.panelOpen) UI.refreshPanel();
			Player._onPauseStorageChange();
			ThumbnailInjector.syncAllButtons();
		}
		if (e.key === PLAYING_KEY || e.key === HEARTBEAT_KEY) UI.updateRemotePauseBtn();
		if (e.key === SKIP_KEY && e.newValue !== null) Player._onRemoteSkip();
	});

	// ── PlayingTab ────────────────────────────────────────────────────────────

	const PlayingTab = {
		_heartbeatTimer: null,
		claim() {
			localStorage.setItem(PLAYING_KEY, TAB_ID);
			this._beat();
			this._heartbeatTimer = setInterval(() => this._beat(), HEARTBEAT_INTERVAL_MS);
		},
		release() {
			if (!this.isOwner()) return;
			clearInterval(this._heartbeatTimer);
			this._heartbeatTimer = null;
			localStorage.removeItem(PLAYING_KEY);
			localStorage.removeItem(HEARTBEAT_KEY);
		},
		isOwner() {
			return localStorage.getItem(PLAYING_KEY) === TAB_ID;
		},
		anyPlaying() {
			if (this.isOwner()) return true;
			if (!localStorage.getItem(PLAYING_KEY)) return false;
			const ts = parseInt(localStorage.getItem(HEARTBEAT_KEY) || '0', 10);
			return (Date.now() - ts) < HEARTBEAT_TTL_MS;
		},
		_beat() {
			localStorage.setItem(HEARTBEAT_KEY, Date.now().toString());
		},
	};

	window.addEventListener('beforeunload', () => PlayingTab.release());

	const Page = {
		// Memoise by full URL — `isWatchPage()` is called from many hot paths
		// (updateControls, ThumbnailInjector, etc.) and reparsing the search
		// string each time is wasteful given the URL only changes on SPA nav.
		_cachedHref: null,
		_cachedResult: false,
		isWatchPage() {
			if (location.href === this._cachedHref) return this._cachedResult;
			this._cachedHref = location.href;
			this._cachedResult = !!getVideoId(location.href);
			return this._cachedResult;
		},
	};

	// ── Navigator ─────────────────────────────────────────────────────────────

	const Navigator = {
		goTo(url) {
			const parsed = new URL(url, location.origin);
			const navPath = parsed.pathname + parsed.search;
			const expectedId = parsed.searchParams.get('v');

			// Hard guard: if the target URL has no `v=` param there is nothing
			// to navigate to. Without this, the endpoint mutation below would
			// happily set `videoId = null` and break the SPA navigation.
			if (!expectedId) {
				warn('Navigator.goTo: no video ID in', url);
				return;
			}

			log('Navigating to:', navPath);

			// Always use YouTube's internal SPA navigation by hijacking any watch anchor
			// on the page and mutating its yt-navigate endpoint to point at the target.
			// This works from any page (homepage, search, watch, etc.) and preserves
			// autoplay — location.href would cause a full reload and break autoplay.
			const queueIds = new Set(
				Storage.queue.map(v => getVideoId(v.url)).filter(Boolean)
			);

			const anchor = [...document.querySelectorAll('a[href*="/watch?v="]')].find(a => {
				const vid = getVideoId(a.href);
				return vid && vid !== expectedId && !queueIds.has(vid);
			});

			if (!anchor) {
				warn('No hijackable anchor found on this page — cannot navigate to', expectedId);
				UI.showStatus('No video link found on page to navigate with', 4000);
				return;
			}

			let mutated = false;
			const handler = e => {
				if (!e.detail?.endpoint) return;
				const ep = e.detail.endpoint;
				if (!mutated) {
					log('Mutating yt-navigate endpoint to', expectedId);
					if (ep.watchEndpoint) {
						ep.watchEndpoint.videoId = expectedId;
					} else {
						Object.keys(ep).forEach(k => {
							if (k.endsWith('Endpoint') || k.endsWith('endpoint')) delete ep[k];
						});
						ep.watchEndpoint = {
							videoId: expectedId
						};
					}
					if (ep.commandMetadata?.webCommandMetadata) ep.commandMetadata.webCommandMetadata.url = navPath;
					ep.clickTrackingParams = '';
					mutated = true;
				} else {
					log('Blocking duplicate yt-navigate for', ep.watchEndpoint?.videoId);
					e.stopImmediatePropagation();
					e.preventDefault();
				}
			};

			window.addEventListener('yt-navigate', handler, {
				capture: true
			});
			setTimeout(() => window.removeEventListener('yt-navigate', handler, {
				capture: true
			}), 2000);
			anchor.click();
		},
	};

	// ── Player ────────────────────────────────────────────────────────────────

	const Player = {
		_playing: false,
		_userPaused: false,
		_navigatingToPrev: false,
		_endPollTimer: null,
		_attachedVideoId: null,
		_ensurePlayingTimer: null,
		_mediaSessionRefreshTimer: null,
		_navStartTime: null,
		_listenerAbort: null,           // AbortController for the current video's event listeners
		_unavailableTimer: null,        // Triggers an "unavailable, skip" check after grace period
		_advancingFromUnavailable: false,

		start() {
			this._playing = true;
			PlayingTab.claim();
			Storage.setPaused(false);
			Storage.setPlaying(true);
			const first = Storage.peekFirst();
			if (!first) {
				this.stop();
				return;
			}
			UI.updateControls();
			const currentId = getVideoId(location.href);
			const expectedId = getVideoId(first.url);
			if (!expectedId) {
				warn('Player.start: queue head has invalid URL', first.url);
				this.stop();
				return;
			}
			if (currentId === expectedId) {
				log('Already on the correct page — attaching directly');
				this._waitForVideoAndPlay();
			} else {
				Navigator.goTo(first.url);
			}
		},

		stop() {
			log('Stopping queue');
			if (this._ensurePlayingTimer) {
				clearTimeout(this._ensurePlayingTimer);
				this._ensurePlayingTimer = null;
			}
			if (this._unavailableTimer) {
				clearTimeout(this._unavailableTimer);
				this._unavailableTimer = null;
			}
			this._playing = false;
			this._userPaused = false;
			this._attachedVideoId = null;
			this._navigatingToPrev = false;
			this._navStartTime = null;
			this._advancingFromUnavailable = false;
			PlayingTab.release();
			Storage.setPaused(false);
			Storage.setPlaying(false);
			this._clearEndPoll();
			this._detachVideoListeners();
			this._unregisterMediaSession();
			UI.updateControls();
			UI.showStatus('Queue stopped');
		},

		remotePause() {
			Storage.setPaused(true);
			UI.updateRemotePauseBtn();
		},
		remoteResume() {
			Storage.setPaused(false);
			UI.updateRemotePauseBtn();
		},

		remoteSkip() {
			if (this._playing) {
				this.skip();
				return;
			}
			localStorage.setItem(SKIP_KEY, Date.now().toString());
		},

		_onRemoteSkip() {
			if (!this._playing) return;
			log('Remote skip received');
			localStorage.removeItem(SKIP_KEY);
			this.skip();
		},

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

		_scheduleEndPoll(video) {
			this._clearEndPoll();
			if (!this._playing || !video) return;
			const check = () => {
				if (!this._playing) return;
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
					this._endPollTimer = setTimeout(check, (remaining - 28) * 1000);
				} else {
					this._endPollTimer = setTimeout(check, 1000);
				}
			};
			const remaining = video.duration - video.currentTime;
			const delay = (!isNaN(remaining) && remaining > 30) ? (remaining - 28) * 1000 : 1000;
			this._endPollTimer = setTimeout(check, delay);
		},

		_clearEndPoll() {
			if (this._endPollTimer) {
				clearTimeout(this._endPollTimer);
				this._endPollTimer = null;
			}
		},

		_waitForVideoAndPlay() {
			if (!this._playing) return;
			this._navStartTime = Date.now();
			const first = Storage.peekFirst();
			if (!first) {
				this.stop();
				return;
			}
			const expectedId = getVideoId(first.url);
			if (!expectedId) {
				this.stop();
				return;
			}

			// Helper: returns true when the player has visibly errored. YouTube
			// renders `.ytp-error` for "Video unavailable", "Members only", deleted
			// uploads, and similar terminal states. We require offsetParent to
			// rule out leftover hidden error nodes from a previous load.
			const isPlayerErrored = () => {
				const err = document.querySelector('.ytp-error');
				return !!(err && err.offsetParent !== null);
			};

			const tryAttach = () => {
				if (!this._playing) return false;
				if (getVideoId(location.href) !== expectedId) return false;
				if (isPlayerErrored()) {
					this._advancingFromUnavailable = true;
					return true;
				}
				const video = document.querySelector('video');
				if (!video) return false;
				const playerEl = document.querySelector('#movie_player');
				if (playerEl && typeof playerEl.getVideoData === 'function') {
					const data = playerEl.getVideoData();
					if (data?.video_id && data.video_id !== expectedId) return false;
				}
				return video.readyState >= 2 || video.currentTime > 0;
			};

			// Common branch: when we either found a working video or a definite
			// error, decide whether to play, skip, or stop.
			const onResolve = () => {
				if (this._advancingFromUnavailable) {
					this._advancingFromUnavailable = false;
					warn('Video unavailable — skipping to next in queue');
					UI.showStatus('Video unavailable — skipping…', 3000);
					this._skipUnplayable();
					return;
				}
				const video = document.querySelector('video');
				if (video) this._onVideoReady(video, first);
				else {
					warn('No <video> after resolve — skipping to next');
					this._skipUnplayable();
				}
			};

			if (tryAttach()) {
				onResolve();
				return;
			}

			let resolved = false;
			const pollTimer = setInterval(() => {
				if (!tryAttach()) return;
				clearInterval(pollTimer);
				clearTimeout(fallbackTimer);
				if (resolved) return;
				resolved = true;
				onResolve();
			}, ATTACH_POLL_INTERVAL_MS);

			// Even if `.ytp-error` never renders (some "unavailable" paths just
			// silently skip the <video> element), give YouTube a brief grace
			// period and then advance rather than stalling for the full
			// NAV_TIMEOUT_MS. Only triggers when we DO have a next video to fall
			// through to — otherwise let the long fallback run.
			const earlyUnavailableTimer = setTimeout(() => {
				if (resolved) return;
				if (getVideoId(location.href) !== expectedId) return;
				if (document.querySelector('video')) return; // <video> exists, just not ready yet
				if (Storage.queue.length <= 1) return;       // nothing to fall through to
				resolved = true;
				clearInterval(pollTimer);
				clearTimeout(fallbackTimer);
				warn('No <video> element after grace period — assuming unavailable');
				UI.showStatus('Video unavailable — skipping…', 3000);
				this._skipUnplayable();
			}, UNAVAILABLE_CHECK_DELAY_MS);

			const fallbackTimer = setTimeout(() => {
				clearInterval(pollTimer);
				clearTimeout(earlyUnavailableTimer);
				if (resolved) return;
				resolved = true;
				warn('Timed out waiting for <video> after', NAV_TIMEOUT_MS, 'ms');
				// Try to keep going — only stop if there's truly nothing left.
				if (Storage.queue.length > 1) {
					UI.showStatus('Video failed to load — skipping…', 3000);
					this._skipUnplayable();
				} else {
					this.stop();
				}
			}, NAV_TIMEOUT_MS);
		},

		/**
		 * Advance past a video that failed to load. Like advance() but does NOT
		 * push the failed video into history (the user never actually watched it).
		 * Rate-limited via setTimeout so we don't tight-loop through a string of
		 * dead videos in a single tick.
		 */
		_skipUnplayable() {
			Storage.shiftQueue(); // drop the failed entry without writing history
			this._attachedVideoId = null;
			this._detachVideoListeners();
			UI.refreshPanel();
			const next = Storage.peekFirst();
			if (next) {
				setTimeout(() => Navigator.goTo(next.url), 200);
			} else {
				this.stop();
			}
		},

		_onVideoReady(video, queueItem) {
			const videoId = new URLSearchParams(location.search).get('v');
			if (videoId && videoId === this._attachedVideoId) {
				log('_onVideoReady: already attached for', videoId, '— skipping');
				return;
			}
			this._attachedVideoId = videoId;
			this._navigatingToPrev = false; // unlock repeated previous presses
			video._ytqmAttachedAt = Date.now();
			this._attachVideoListeners(video);
			this._scheduleEndPoll(video);
			this._registerMediaSession();
			this._updateMediaSessionMetadata(queueItem);
			if (this._userPaused || Storage.paused) return;
			this._startPlayback(video);
		},

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
			const whenReady = (fn) => {
				if (video.readyState >= 3) fn();
				else video.addEventListener('canplay', fn, {
					once: true
				});
			};
			// Do NOT pause here — calling video.pause() while YouTube is still
			// initialising its player causes YouTube to show an error screen.
			whenReady(restartFromBeginning ? seekThenPlay : play);
		},

		_detachVideoListeners() {
			if (this._listenerAbort) {
				this._listenerAbort.abort();
				this._listenerAbort = null;
				log('Video listeners detached');
			}
		},

		_attachVideoListeners(video) {
			// Tear down any listeners from a previous video before attaching new ones.
			// YouTube reuses the same <video> element across SPA navigations, so without
			// this the old handlers would keep firing on the new video.
			this._detachVideoListeners();
			this._listenerAbort = new AbortController();
			const {
				signal
			} = this._listenerAbort;

			video.addEventListener('pause', () => {
				if (!this._playing || video.ended || Storage.paused) return;
				if (Date.now() - (video._ytqmAttachedAt || 0) < 3000) {
					log('Ignoring early pause event');
					return;
				}
				this._userPaused = true;
				log('Video paused by user');
				UI.showStatus('Paused', 99999);
			}, {
				signal
			});

			video.addEventListener('play', () => {
				this._userPaused = false;
				if (this._navStartTime) {
					const elapsed = ((Date.now() - this._navStartTime) / 1000).toFixed(2);
					log(`Video playing (${elapsed}s since navigation)`);
					this._navStartTime = null;
				} else {
					log('Video playing');
				}
				UI.showStatus('Playing', 2000);
				if (this._playing && !this._endPollTimer) this._scheduleEndPoll(video);
			}, {
				signal
			});

			video.addEventListener('ended', () => UI.showStatus('Advancing queue…'), {
				signal
			});
			video.addEventListener('waiting', () => UI.showStatus('Buffering…', 5000), {
				signal
			});
			video.addEventListener('durationchange', () => {
				if (this._playing && !isNaN(video.duration)) this._scheduleEndPoll(video);
			}, {
				signal
			});

			// Event-driven end detection. The 1-second polling fallback in
			// _scheduleEndPoll is still our safety net (some YouTube paths drop
			// `timeupdate` events near the end of a video), but reacting on the
			// event itself eliminates the up-to-1-second jitter the poll alone
			// produces. We only check when we are within 5 seconds of the end
			// to keep the work cheap on long videos.
			video.addEventListener('timeupdate', () => {
				if (!this._playing || Storage.paused) return;
				if (isNaN(video.duration)) return;
				const remaining = video.duration - video.currentTime;
				if (remaining > 5) return;
				if (video.ended || remaining <= VIDEO_END_THRESHOLD_S) {
					log('timeupdate: end threshold reached — advancing');
					this._userPaused = false;
					Storage.setPaused(false);
					this.advance();
				}
			}, {
				signal
			});
		},

		advance() {
			const current = Storage.shiftQueue();
			if (current) Storage.pushHistory(current);
			const next = Storage.peekFirst();
			this._attachedVideoId = null;
			this._navigatingToPrev = false;
			this._detachVideoListeners();
			UI.refreshPanel();
			if (next) Navigator.goTo(next.url);
			else this.stop();
		},

		skip() {
			if (this._playing) this.advance();
		},

		/**
		 * Hard-reloads the current page (or navigates to `url` if provided) while
		 * keeping the queue alive.  On boot the refresh-recovery path in tryInit()
		 * sees playing=true and calls Player.start(), so playback resumes exactly
		 * as if the queue had just advanced to this video naturally.
		 *
		 * If `url` points to a YouTube video that is NOT already at the front of
		 * the queue, it is spliced in at position 0 so it becomes the next thing
		 * that plays after the reload.
		 *
		 * @param {string} [url] - Optional YouTube watch URL or video ID to navigate
		 *   to instead of reloading the current page.  Pass undefined / omit to
		 *   simply reload the page the user is already on.
		 */
		reloadAndResume(url) {
			// Resolve a bare video ID ("dQw4w9WgXcQ") to a full watch URL.
			let targetUrl = url;
			if (targetUrl && !targetUrl.includes('/')) {
				targetUrl = watchUrl(targetUrl);
			}

			const targetId = targetUrl ? getVideoId(targetUrl) : null;
			if (targetUrl && !targetId) warn('reloadAndResume: could not parse URL', targetUrl);

			// Ensure the target video is at queue[0] so boot-recovery plays it.
			if (targetId) {
				Storage.mutate(s => {
					const existingIdx = s.queue.findIndex(v => getVideoId(v.url) === targetId);
					if (existingIdx > 0) {
						// Already in queue but not at the front — move it to position 0.
						const [item] = s.queue.splice(existingIdx, 1);
						s.queue.unshift(item);
					} else if (existingIdx === -1) {
						// Not in queue at all — insert it at position 0.
						s.queue.unshift({
							url: watchUrl(targetId),
							title: targetId,
							channel: '',
							id: _uid()
						});
					}
					// existingIdx === 0 means it is already at the front — nothing to do.
				});
			}

			// Stamp playing=true so tryInit() knows to resume after the reload.
			Storage.setPlaying(true);

			log('reloadAndResume: hard reloading', targetUrl || location.href);

			if (targetId) {
				location.href = watchUrl(targetId);
			} else {
				location.reload();
			}
		},

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
				this._registerMediaSession();
				return;
			}
			log('Going to previous:', prev.title);
			Storage.mutate(s => {
				s.queue.unshift({ ...prev, id: _uid() });
			});
			this._attachedVideoId = null;
			this._navigatingToPrev = true;
			UI.refreshPanel();
			Navigator.goTo(prev.url);
		},

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
			if (!s.mediaSessionRefresh) setTimeout(() => register('MediaSession handlers re-registered (delayed)'), MEDIASESSION_DELAYED_MS);
			this._stopMediaSessionRefresh();
			if (s.mediaSessionRefresh) {
				const intervalMs = Math.max(1, Number(s.mediaSessionRefreshInterval) || 5) * 1000;
				this._mediaSessionRefreshTimer = setInterval(() => register('MediaSession handlers re-registered (interval)'), intervalMs);
				log('MediaSession periodic refresh started, interval:', intervalMs, 'ms');
			}
		},

		_stopMediaSessionRefresh() {
			if (this._mediaSessionRefreshTimer) {
				clearInterval(this._mediaSessionRefreshTimer);
				this._mediaSessionRefreshTimer = null;
			}
		},

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
			// Last resort: synthesise a "k" keypress on the player. We drop the
			// deprecated `keyCode`/`which` properties — modern browsers route on
			// `key` and `code`, and YouTube's own keyboard handler reads `key`.
			const player = document.querySelector(SEL.PLAYER);
			if (player) player.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'k',
				code: 'KeyK',
				bubbles: true,
				cancelable: true
			}));
		},
	};

	// ── QueueIO ───────────────────────────────────────────────────────────────

	const QueueIO = {
		async exportToClipboard() {
			const state = Storage.load();
			const payload = {
				_ytqm: true,
				exportedAt: new Date().toISOString(),
				queue: state.queue.map(({
					url,
					title,
					channel
				}) => ({
					url,
					title,
					channel
				})),
			};
			const json = JSON.stringify(payload, null, 2);
			try {
				await navigator.clipboard.writeText(json);
				log('Exported', payload.queue.length, 'items to clipboard');
				return {
					ok: true,
					count: payload.queue.length
				};
			} catch (e) {
				warn('Clipboard write failed:', e);
				return {
					ok: false,
					count: 0
				};
			}
		},

		async importFromClipboard() {
			let text;
			try {
				text = await navigator.clipboard.readText();
			} catch (e) {
				warn('Clipboard read failed:', e);
				return {
					ok: false,
					added: 0,
					error: 'Clipboard read failed — check browser permissions.'
				};
			}

			let parsed;
			try {
				parsed = JSON.parse(text.trim());
			} catch {
				return {
					ok: false,
					added: 0,
					error: 'Invalid JSON — could not parse clipboard contents.'
				};
			}

			const items = Array.isArray(parsed) ?
				parsed :
				(parsed?._ytqm && Array.isArray(parsed.queue)) ? parsed.queue : null;

			if (!items) return {
				ok: false,
				added: 0,
				error: 'Unrecognised format. Expected a YT Queue export or a plain array of {url, title} objects.'
			};

			const valid = items.filter(item => typeof item?.url === 'string' && getVideoId(item.url));

			if (valid.length === 0) return {
				ok: false,
				added: 0,
				error: 'No valid YouTube watch URLs found in the import data.'
			};

			let added = 0;
			Storage.mutate(s => {
				const existing = new Set(s.queue.map(v => v.url));
				const newItems = valid
					.filter(v => !existing.has(v.url))
					.map(({ url, title, channel }) => ({
						url,
						title: title || 'Untitled video',
						channel: channel || '',
						id: _uid(),
					}));
				s.queue = [...s.queue, ...newItems];
				added = newItems.length;
			});

			log('Imported', added, 'items');
			UI.updateControls();
			if (UI.panelOpen) UI.refreshPanel();
			ThumbnailInjector.syncAllButtons();
			return {
				ok: true,
				added
			};
		},
	};

	// ── PhonePoller ───────────────────────────────────────────────────────────
	// Polls the local server for videos shared from the phone and enqueues them.

	const PhonePoller = {
		_timer: null,

		start() {
			if (this._timer) return;
			log('PhonePoller: started');
			this._timer = setInterval(() => this._poll(), PHONE_POLL_INTERVAL_MS);
		},

		stop() {
			if (!this._timer) return;
			clearInterval(this._timer);
			this._timer = null;
			log('PhonePoller: stopped');
		},

		async _poll() {
			const s = Settings.get();
			if (!s.enqueueFromPhone) return;

			// Only poll from the tab that owns playback, or if no tab is playing at all.
			// This prevents multiple open YouTube tabs from each making poll requests and
			// potentially racing on queue insertions.
			if (!PlayingTab.isOwner() && PlayingTab.anyPlaying()) return;

			const serverUrl = (s.phoneServerUrl || 'http://localhost/poll').replace(/\/$/, '');
			const pollUrl = serverUrl.endsWith('/poll') ? serverUrl : `${serverUrl}/poll`;

			let data;
			try {
				const res = await fetch(pollUrl, {
					signal: AbortSignal.timeout(2500)
				});
				if (!res.ok) return;
				data = await res.json();
			} catch {
				// Server offline or unreachable — silently ignore
				return;
			}

			// Handle Spotify track (existing behaviour)
			if (data.track) {
				log('PhonePoller: received Spotify track', data.track);
				// Dispatch to whatever Spotify handler is wired up externally
				window.dispatchEvent(new CustomEvent('ytqm-spotify-track', {
					detail: {
						uri: data.track
					}
				}));
			}

			// Handle YouTube queue URL (new behaviour)
			if (data.youtube_url) {
				log('PhonePoller: received queue URL', data.youtube_url);
				const videoId = getVideoId(data.youtube_url);
				if (!videoId) {
					warn('PhonePoller: no video ID in URL', data.youtube_url);
					return;
				}
				const url = watchUrl(videoId);
				const title = (data.title && data.title.trim()) ? data.title.trim() : 'Shared from phone';
				const added = Storage.addVideo(url, title, '');
				if (added) {
					UI.updateControls();
					if (UI.panelOpen) UI.refreshPanel();
					ThumbnailInjector.syncAllButtons();
					UI.showStatus('📱 Video added from phone', 4000);
					log('PhonePoller: enqueued', url);
				} else {
					log('PhonePoller: video already in queue, skipping');
				}
			}
		},
	};

	// ── ThumbnailInjector ─────────────────────────────────────────────────────

	const ThumbnailInjector = {
		_observer: null,
		_pruneTimer: null,
		_cards: new Map(),
		_styleEl: null, // shared <style> element for thumbnail buttons + tooltips

		// ── Public ──────────────────────────────────────────────────────────────

		start() {
			this._injectStyles();
			this._injectAll();
			setTimeout(() => this._injectAll(), 800);
			setTimeout(() => this._injectAll(), 2000);
			this._observe();
			this._startHoverTracking();
			this._pruneTimer = setInterval(() => {
				this._cards.forEach((entry, card) => {
					if (!document.contains(card)) {
						clearTimeout(entry.hideTimer);
						entry.tooltip.remove();
						this._cards.delete(card);
					}
				});
			}, THUMBNAIL_PRUNE_MS);
		},

		/**
		 * Inject one shared stylesheet for every thumbnail button on the page.
		 * Previously each button received ~25 inline-style assignments via
		 * Object.assign(btn.style, {...}); on infinite-scroll pages that adds
		 * up. Style classes are also far easier for devs to tweak than
		 * scattered Object.assign blocks.
		 */
		_injectStyles() {
			if (this._styleEl) return;
			const css = `
				.ytqm-thumb-add-btn {
					position: absolute;
					top: 8px;
					left: 8px;
					z-index: 9999;
					width: 36px;
					height: 36px;
					border-radius: 50%;
					border: 1.5px solid rgba(255,255,255,0.8);
					backdrop-filter: blur(4px);
					color: #fff;
					cursor: pointer;
					display: flex;
					align-items: center;
					justify-content: center;
					padding: 0;
					box-shadow: 0 2px 8px rgba(0,0,0,0.5);
					pointer-events: all;
					opacity: 0;
					transform: translateY(-4px);
					transition: opacity 0.25s ease, transform 0.25s ease, background 0.2s ease;
					background: rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY});
				}
				/* "visible" is added on hover; "active" is added when the state's
				   semantics demand it stays visible (e.g. just-added confirmation). */
				.ytqm-thumb-add-btn.ytqm-visible,
				.ytqm-thumb-add-btn.ytqm-active {
					opacity: 1;
					transform: translateY(0);
				}
				.ytqm-thumb-add-btn.ytqm-state-added,
				.ytqm-thumb-add-btn.ytqm-state-idle {
					background: rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY});
				}
				.ytqm-thumb-add-btn.ytqm-state-dupe,
				.ytqm-thumb-add-btn.ytqm-state-removed {
					background: rgba(${THUMB_BTN_RED_RGB},${THUMB_BTN_OPACITY});
				}
				.ytqm-thumb-add-btn.ytqm-state-next {
					background: rgba(${THUMB_BTN_BLUE_RGB},${THUMB_BTN_OPACITY});
				}
				.ytqm-thumb-add-btn > span {
					display: block;
					user-select: none;
					pointer-events: none;
					width: 18px;
					height: 18px;
					flex-shrink: 0;
				}
				.ytqm-thumb-tooltip {
					position: fixed;
					top: 0;
					left: 0;
					background: rgba(0,0,0,0.88);
					color: #fff;
					font-size: 11px;
					font-family: 'Segoe UI', Arial, system-ui, sans-serif;
					font-weight: 600;
					padding: 4px 9px;
					border-radius: 6px;
					white-space: nowrap;
					pointer-events: none;
					opacity: 0;
					transition: opacity 0.15s ease;
					z-index: 2147483647;
					border: 1px solid rgba(255,255,255,0.15);
				}
			`;
			this._styleEl = document.createElement('style');
			this._styleEl.id = 'ytqm-thumb-styles';
			this._styleEl.textContent = css;
			(document.head || document.documentElement).appendChild(this._styleEl);
		},

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
				hideTimer,
				tooltip
			}) => {
				clearTimeout(hideTimer);
				tooltip.remove();
			});
			this._cards.clear();
		},

		syncAllButtons() {
			// Fast path via Storage.isQueued (Set-backed) — avoids cloning the
			// queue array AND avoids O(thumbnails * queueLen) for big pages.
			this._cards.forEach((entry) => {
				const inQueue = Storage.isQueued(entry.videoUrl);
				const currentState = entry.btn._ytqmState;
				if (inQueue && currentState !== 'dupe') this._applyState(entry, 'dupe');
				else if (!inQueue && currentState === 'dupe') this._applyState(entry, 'idle');
			});
		},

		// ── Injection entry points (one per thumbnail variety) ──────────────────

		// Standard grid/list/compact thumbnails. Skips anchors inside
		// ytd-video-preview — those are owned by _injectVideoPreview so the button
		// ends up on the outer wrapper, above the inline player in the z-order.
		_injectStandard(anchor) {
			if (anchor.nodeType !== Node.ELEMENT_NODE) return;
			if (anchor.closest('ytd-video-preview')) return;
			if (!anchor.matches('a[href*="/watch?v="]')) return;
			if (!this._hasThumbnailContent(anchor)) return;
			if (anchor.dataset.ytqmInjected) return;
			const container = anchor.closest('ytd-thumbnail') ?? anchor.parentElement ?? anchor;
			anchor.dataset.ytqmInjected = '1';
			const card = anchor.closest(SEL.CARD) ?? anchor;
			this._injectButton(anchor, container, card);
		},

		// Inline hover-player wrapper. ytd-video-preview is a singleton element
		// that YouTube reuses for every thumbnail the pointer enters — the anchor's
		// href is updated in place each time. The button is mounted on the outer
		// vpNode so it survives YouTube swapping ytd-thumbnail for ytd-player.
		_injectVideoPreview(vpNode) {
			if (vpNode.dataset.ytqmVpInjected) return;
			const anchor = vpNode.querySelector('a[href*="/watch?v="]');
			if (!anchor) return;
			vpNode.dataset.ytqmVpInjected = '1';

			const outerCard = vpNode.closest(SEL.CARD);
			if (outerCard?.querySelector('.ytqm-thumb-add-btn')) return;

			this._injectButton(anchor, vpNode, vpNode);
		},

		// End-of-video suggestion wall tiles. Anchor serves as both container
		// and card; meta is extracted from videowall-specific selectors.
		_injectVideowall(anchor) {
			if (anchor.querySelector('.ytqm-thumb-add-btn')) return;
			this._injectButton(anchor, anchor, anchor, /* isVideowall */ true);
		},

		// ── Initial sweep + MutationObserver ────────────────────────────────────

		// Sweeps the current DOM. ytd-video-preview nodes are processed first so
		// _ytqmVpInjected is set before the anchor sweep, preventing the inner
		// anchor from also being picked up by _injectStandard.
		_injectAll() {
			document.querySelectorAll('ytd-video-preview').forEach(vp => this._injectVideoPreview(vp));
			document.querySelectorAll('a[href*="/watch?v="]').forEach(a => this._injectStandard(a));
			document.querySelectorAll(SEL.VIDEOWALL_ANCHOR).forEach(a => this._injectVideowall(a));
		},

		_observe() {
			this._observer = new MutationObserver(mutations => {
				for (const m of mutations) m.addedNodes.forEach(node => this._handleMutationNode(node));
			});
			const roots = [...document.querySelectorAll(SEL.THUMB_OBSERVER_ROOTS)];
			const target = roots.length ? roots[0] : document.body;
			this._observer.observe(target, {
				childList: true,
				subtree: true
			});
		},

		_handleMutationNode(node) {
			if (node.nodeType !== Node.ELEMENT_NODE) return;

			// ytd-video-preview first — same ordering reason as _injectAll.
			if (node.matches('ytd-video-preview')) this._injectVideoPreview(node);
			node.querySelectorAll('ytd-video-preview').forEach(vp => this._injectVideoPreview(vp));

			// Standard anchors and videowall tiles.
			this._injectStandard(node);
			node.querySelectorAll('a[href*="/watch?v="]').forEach(a => this._injectStandard(a));
			node.querySelectorAll(SEL.VIDEOWALL_ANCHOR).forEach(a => this._injectVideowall(a));

			// YouTube sometimes adds the <img> (or yt-thumbnail-view-model) in a
			// second mutation after the parent <a> was skipped because
			// _hasThumbnailContent returned false at insertion time. When that image
			// node arrives, walk up and retry the ancestor anchor.
			this._retryFromImg(node);
			node.querySelectorAll('img, yt-thumbnail-view-model, yt-image').forEach(img => this._retryFromImg(img));
		},

		// Walks up from a newly-added image element to retry its ancestor anchor.
		// Anchors inside ytd-video-preview are exempt — the vp handler owns them.
		_retryFromImg(el) {
			if (el.closest('ytd-video-preview')) return;
			const anchor = el.closest('a[href*="/watch?v="]');
			if (anchor && !anchor.dataset.ytqmInjected) this._injectStandard(anchor);
		},

		// ── Shared injection core ────────────────────────────────────────────────

		// Resolves the video URL, builds the button + tooltip, wires up all event
		// handlers, and mounts everything onto the resolved container/card.
		//
		// @param {HTMLAnchorElement} anchor     The <a href="/watch?v=…"> element.
		// @param {HTMLElement}       container  Positioning parent for the button.
		// @param {HTMLElement}       card       Map key used by syncAllButtons / hover tracking.
		// @param {boolean}           isVideowall  Use videowall meta extraction when true.
		_injectButton(anchor, container, card, isVideowall = false) {
			// Hard guard: never place two buttons in the same container regardless
			// of which injection path fired or what order mutations arrived in.
			if (container.children && [...container.children].some(el => el.classList.contains('ytqm-thumb-add-btn'))) return;

			const videoId = getVideoId(anchor.getAttribute('href') || '');
			if (!videoId) return;
			const videoUrl = watchUrl(videoId);

			// Only set position if it is currently static — YouTube sets its own
			// non-static position on elements like ytd-video-preview (fixed/absolute)
			// and overriding that would break the overlay/hover-trigger mechanism.
			if (window.getComputedStyle(container).position === 'static') {
				container.style.position = 'relative';
			}

			// All visual styling lives in the stylesheet from `_injectStyles`.
			// The two state classes here are the initial state (idle); _applyState
			// swaps them as the button transitions between idle/added/dupe/etc.
			const btn = document.createElement('button');
			btn.className = 'ytqm-thumb-add-btn ytqm-state-idle';
			btn._ytqmState = 'idle';

			const btnLabel = document.createElement('span');
			btnLabel.innerHTML = `<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px;display:block"><path d="M9 2V16M2 9H16" stroke="white" stroke-width="2.2" stroke-linecap="round"/></svg>`;
			btn.appendChild(btnLabel);

			// Tooltip is appended to <body> so it is never clipped by an
			// overflow:hidden ancestor (ytd-thumbnail, ytd-video-preview, etc.
			// all clip their contents). Position is recomputed on each hover.
			const tooltip = document.createElement('div');
			tooltip.className = 'ytqm-thumb-tooltip';
			tooltip.textContent = 'Add to Queue';
			document.body.appendChild(tooltip);

			btn.addEventListener('mouseenter', () => {
				const r = btn.getBoundingClientRect();
				tooltip.style.left = (r.left + r.width / 2) + 'px';
				tooltip.style.top = (r.top - 8) + 'px';
				tooltip.style.transform = 'translate(-50%, -100%)';
				tooltip.style.opacity = '1';
			});
			btn.addEventListener('mouseleave', () => {
				tooltip.style.opacity = '0';
			});

			const entry = {
				btn,
				tooltip,
				hideTimer: null,
				videoUrl
			};

			// ytd-video-preview reuses the same anchor element across hover targets —
			// always re-derive the URL from the live href so the button queues the
			// video currently shown, not the one active when the button was injected.
			const liveVideoUrl = () => {
				const id = getVideoId(anchor.getAttribute('href') || '');
				if (id) {
					const url = watchUrl(id);
					entry.videoUrl = url; // keep entry in sync for syncAllButtons
					return url;
				}
				return entry.videoUrl; // fall back to last known URL
			};

			if (Storage.isQueued(videoUrl)) this._applyState(entry, 'dupe');

			btn.addEventListener('click', e => {
				e.preventDefault();
				e.stopPropagation();
				const currentUrl = liveVideoUrl();
				if (btn._ytqmState === 'dupe') {
					Storage.removeVideoByUrl(currentUrl);
					UI.updateControls();
					if (UI.panelOpen) UI.refreshPanel();
					this._applyState(entry, 'removed', BTN_TEMP_TEXT_DURATION_MS);
					setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
					return;
				}
				const {
					title,
					channel
				} = isVideowall
					?
					this._extractVideowallMeta(anchor) :
					this._extractVideoMeta(anchor, card);
				const added = Storage.addVideo(currentUrl, title, channel);
				if (added) {
					this._applyState(entry, 'added', BTN_TEMP_TEXT_DURATION_MS);
					setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
				} else {
					this._applyState(entry, 'dupe');
				}
				UI.updateControls();
				if (UI.panelOpen) UI.refreshPanel();
			});

			btn.addEventListener('contextmenu', e => {
				e.preventDefault();
				e.stopPropagation();
				const currentUrl = liveVideoUrl();
				const {
					title,
					channel
				} = isVideowall
					?
					this._extractVideowallMeta(anchor) :
					this._extractVideoMeta(anchor, card);
				const insertAt = Storage.load().playing && Storage.queue.length > 0 ? 1 : 0;
				Storage.insertNext(currentUrl, title, channel, insertAt);
				this._applyState(entry, 'next', BTN_TEMP_TEXT_DURATION_MS);
				setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
				UI.updateControls();
				if (UI.panelOpen) UI.refreshPanel();
			});

			container.appendChild(btn);
			this._cards.set(card, entry);
		},

		// ── Helpers ──────────────────────────────────────────────────────────────

		// Returns true when the anchor contains any recognisable thumbnail content.
		// YouTube's new yt-lockup-view-model layout adds the <img> in a second DOM
		// mutation, so we also accept yt-thumbnail-view-model / yt-image as stand-ins
		// so that the injection isn't missed while the image is still loading.
		_hasThumbnailContent(anchor) {
			return !!(
				anchor.querySelector('img') ||
				anchor.querySelector('yt-thumbnail-view-model, yt-image, ytd-thumbnail')
			);
		},

		// Extracts title + channel from standard grid/list/compact card layouts.
		_extractVideoMeta(anchor, card) {
			let title = '',
				channel = '';
			const candidates = [
				() => card.querySelector('h3[title]')?.getAttribute('title'),
				() => card.querySelector('a[aria-label]')?.getAttribute('aria-label')?.replace(/\s+\d[\d:, ]*(seconds?|minutes?|hours?)[^)]*$/i, '').trim(),
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
			return {
				title: title || 'Untitled video',
				channel
			};
		},

		// Extracts title + channel from end-of-video suggestion wall tiles.
		_extractVideowallMeta(anchor) {
			let title = anchor.querySelector('.ytp-modern-videowall-still-info-title')?.textContent?.trim() || '';
			const channel = anchor.querySelector('.ytp-modern-videowall-still-info-author')?.textContent?.trim() || '';
			if (!title) {
				const aria = anchor.getAttribute('aria-label') || '';
				title = aria.replace(/\s+\d[\d:, ]*(seconds?|minutes?|hours?)[^)]*$/i, '').trim();
			}
			return {
				title: title || 'Untitled video',
				channel
			};
		},

		/**
		 * Drive the visual state of a thumbnail button.
		 *
		 * State table (kept as data so it's easy to add a new state):
		 *   - the `active` flag controls whether the button stays visible
		 *     even when the cursor isn't on the card. We want recently-acted
		 *     states (added/removed/next) to stay visible; resting states
		 *     (idle/dupe) hide on mouse leave.
		 *   - `tooltip` is what appears on hover.
		 *   - `svg` is the icon path (raw SVG inner content).
		 *
		 * Class strategy: we set exactly one `ytqm-state-*` class for colour,
		 * plus optional `ytqm-active` for the visible-without-hover case.
		 * Hover visibility is handled by `ytqm-visible` toggled in hover handlers.
		 */
		_applyState(entry, state, resetAfterMs = null) {
			const STATE_TABLE = {
				idle:    { active: false, tooltip: 'Add to Queue',
				           svg: '<path d="M9 2V16M2 9H16" stroke="white" stroke-width="2.2" stroke-linecap="round"/>' },
				added:   { active: true,  tooltip: 'Added!',
				           svg: '<path d="M3 9.5L7.5 14L15 5" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' },
				dupe:    { active: false, tooltip: 'In queue — click to remove',
				           svg: '<path d="M4 4L14 14M14 4L4 14" stroke="white" stroke-width="2.2" stroke-linecap="round"/>' },
				removed: { active: true,  tooltip: 'Removed from queue',
				           svg: '<path d="M3 9H15" stroke="white" stroke-width="2.2" stroke-linecap="round"/>' },
				next:    { active: true,  tooltip: 'Playing next!',
				           svg: '<path d="M2 4.5L8.5 9L2 13.5V4.5Z" fill="white"/><path d="M9 4.5L15.5 9L9 13.5V4.5Z" fill="white"/><line x1="16.5" y1="4" x2="16.5" y2="14" stroke="white" stroke-width="2" stroke-linecap="round"/>' },
			};
			const cfg = STATE_TABLE[state];
			if (!cfg) return;

			const { btn, tooltip } = entry;
			btn._ytqmState = state;
			clearTimeout(btn._ytqmResetTimer);
			btn._ytqmResetTimer = null;

			// Reset state classes, then apply the new one.
			btn.classList.remove('ytqm-state-idle', 'ytqm-state-added', 'ytqm-state-dupe', 'ytqm-state-removed', 'ytqm-state-next');
			btn.classList.add(`ytqm-state-${state}`);
			btn.classList.toggle('ytqm-active', cfg.active);

			const iconEl = btn.querySelector('span');
			if (iconEl) {
				iconEl.innerHTML = `<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px;display:block">${cfg.svg}</svg>`;
			}
			tooltip.textContent = cfg.tooltip;

			if (resetAfterMs !== null) btn._ytqmResetTimer = setTimeout(() => this._applyState(entry, 'idle'), resetAfterMs);
		},

		_startHoverTracking() {
			// We use capture-phase listeners on `document` so we can delegate
			// hover state to thumbnail buttons that are spread across the page
			// without attaching a listener to every card individually.
			// `mouseenter`/`mouseleave` don't bubble but DO fire during capture
			// because the dispatch path passes through document on the way to
			// the target.
			document.addEventListener('mouseenter', e => {
				const card = e.target.closest?.(SEL.CARD) ||
					e.target.closest?.(SEL.VIDEO_PREVIEW) ||
					e.target.closest?.('.ytp-suggestion-set');
				if (!card) return;
				const entry = this._cards.get(card);
				if (!entry) return;
				clearTimeout(entry.hideTimer);
				entry.hideTimer = null;
				entry.btn.classList.add('ytqm-visible');
			}, true);

			document.addEventListener('mouseleave', e => {
				const card = e.target.closest?.(SEL.CARD) ||
					e.target.closest?.(SEL.VIDEO_PREVIEW) ||
					e.target.closest?.('.ytp-suggestion-set');
				if (!card) return;
				const rel = e.relatedTarget;
				// Don't hide if the cursor moved to a child of the same card.
				if (
					rel?.closest?.(SEL.CARD) === card ||
					rel?.closest?.(SEL.VIDEO_PREVIEW) === card ||
					rel?.closest?.('.ytp-suggestion-set') === card
				) return;
				const entry = this._cards.get(card);
				if (!entry || entry.hideTimer) return;
				entry.hideTimer = setTimeout(() => {
					entry.btn.classList.remove('ytqm-visible');
					entry.tooltip.style.opacity = '0';
					entry.hideTimer = null;
				}, THUMBNAIL_HIDE_DELAY_MS);
			}, true);
		},
	};

	// ── UI ────────────────────────────────────────────────────────────────────

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
		nowPlayingSection: null,
		upNextLabel: null,
		settingsOverlay: null,
		panelOpen: false,
		_dragSrcIndex: null,
		addBtnFlash: null,
		addBtnLabel: null,
		_addBtnFlashTimer: null,

		init() {
			document.getElementById('ytqm-host')?.remove();
			this.host = document.createElement('div');
			this.host.id = 'ytqm-host';
			Object.assign(this.host.style, {
				position: 'fixed',
				bottom: '0',
				left: '0',
				zIndex: '9999',
				pointerEvents: 'none',
				width: '0',
				height: '0'
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

			document.addEventListener('mousedown', e => {
				if (!this.panelOpen) return;
				if (!e.composedPath().some(el => el === this.host)) this.togglePanel(false);
			});

			const onFullscreenChange = () => {
				const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
				this.host.style.visibility = isFullscreen ? 'hidden' : 'visible';
			};
			document.addEventListener('fullscreenchange', onFullscreenChange);
			document.addEventListener('webkitfullscreenchange', onFullscreenChange);
			this.updateControls();
		},

		_cssReset() {
			return `* { box-sizing: border-box; margin: 0; padding: 0; }`;
		},

		_cssButtonBar() {
			return `
        #ytqm-root { position: fixed; bottom: 24px; left: 20px; display: flex; flex-direction: row; align-items: center; gap: 8px; pointer-events: all; }
        .ytqm-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 15px; border-radius: 999px; border: 1.5px solid rgba(255,255,255,0.75); cursor: pointer; font-size: 13px; font-weight: 600; font-family: 'Segoe UI', Arial, system-ui, sans-serif; letter-spacing: 0.02em; transition: transform 0.12s ease, opacity 0.12s ease, background 0.2s ease; user-select: none; white-space: nowrap; box-shadow: 0 4px 18px rgba(0,0,0,0.55); outline: none; line-height: 1; }
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
        #ytqm-add-btn-flash { position: absolute; inset: -2px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; white-space: nowrap; color: #fff; pointer-events: none; opacity: 0; transition: opacity 0.25s ease; z-index: 1; }
        #ytqm-add-btn-flash.visible { opacity: 1; pointer-events: all; }
      `;
		},

		_cssQueuePanel() {
			return `
        #ytqm-panel { position: fixed; bottom: 68px; left: 20px; width: 330px; max-height: 480px; background: #111; border: 1.5px solid rgba(255,255,255,0.18); border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.75); display: none; flex-direction: column; overflow: hidden; color: #fff; font-family: 'Segoe UI', Arial, system-ui, sans-serif; pointer-events: all; }
        #ytqm-panel.open { display: flex; }
        #ytqm-panel-header { padding: 14px 16px 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .header-controls { display: flex; align-items: center; gap: 6px; }
        #ytqm-panel-title { cursor: pointer; transition: color 0.2s ease, text-shadow 0.2s ease; border-radius: 4px; padding: 1px 3px; margin: -1px -3px; display: inline-flex; align-items: center; gap: 6px; }
        #ytqm-panel-title:hover { color: #fff; text-shadow: 0 0 8px rgba(255,255,255,0.9), 0 0 20px rgba(255,255,255,0.4); }
        #ytqm-cog-icon { width: 13px; height: 13px; color: rgba(255,255,255,0.3); flex-shrink: 0; transition: color 0.2s ease, transform 0.35s ease; }
        #ytqm-panel-title:hover #ytqm-cog-icon { color: rgba(255,255,255,0.75); transform: rotate(60deg); }

        /* ── Now Playing ── */
        #ytqm-now-playing { flex-shrink: 0; padding: 10px 14px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); }
        #ytqm-now-playing-label { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.35); margin-bottom: 7px; }
        #ytqm-now-playing-title { font-size: 12.5px; font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 8px; }

        /* Animated equaliser bars */
        .np-bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; flex-shrink: 0; }
        .np-bars span { display: block; width: 3px; border-radius: 2px; background: rgba(39,174,96,0.9); animation: ytqm-bar 0.9s ease-in-out infinite alternate; }
        .np-bars span:nth-child(1) { height: 5px;  animation-delay: 0s; }
        .np-bars span:nth-child(2) { height: 11px; animation-delay: 0.18s; }
        .np-bars span:nth-child(3) { height: 7px;  animation-delay: 0.36s; }
        .np-bars span:nth-child(4) { height: 13px; animation-delay: 0.09s; }
        @keyframes ytqm-bar { from { opacity: 0.45; transform: scaleY(0.35); } to { opacity: 1; transform: scaleY(1); } }

        /* ── Up Next label + queue actions (Shuffle / Clear) ── */
        #ytqm-up-next-label { flex-shrink: 0; padding: 9px 14px 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.25); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .ytqm-queue-actions { display: inline-flex; gap: 4px; margin-left: auto; }
        .ytqm-mini-btn { background: none; border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; color: rgba(255,255,255,0.5); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; padding: 3px 7px; transition: background 0.15s, color 0.15s, border-color 0.15s; }
        .ytqm-mini-btn:hover { background: rgba(255,255,255,0.08); color: #fff; border-color: rgba(255,255,255,0.4); }
        #ytqm-clear-btn:hover { background: rgba(231,76,60,0.18); color: #ff6b5e; border-color: rgba(231,76,60,0.5); }
      `;
		},

		_cssPanelControls() {
			return `
        #ytqm-skip-btn, #ytqm-prev-btn, #ytqm-remote-pause-btn { background: none; border: 1px solid rgba(255,255,255,0.25); border-radius: 999px; color: rgba(255,255,255,0.7); padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit; transition: all 0.15s; }
        #ytqm-skip-btn:hover, #ytqm-prev-btn:hover, #ytqm-remote-pause-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        #ytqm-remote-pause-btn.is-paused { background: rgba(39,174,96,0.2); border-color: rgba(39,174,96,0.7); color: #2ecc71; }
        #ytqm-remote-pause-btn.is-paused:hover { background: rgba(39,174,96,0.3); }
        /* Shared close-button style. Both the queue panel and settings modal
           use this class — see ytqm-panel-close / ytqm-settings-close IDs.
           Previously both shared the same ID, which is invalid HTML in a
           single shadow root (id is a singleton scope). */
        .ytqm-close-btn { background: #fff; border: 1.5px solid #fff; border-radius: 50%; color: #000; cursor: pointer; font-size: 13px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; padding: 0; font-family: inherit; flex-shrink: 0; transition: all 0.15s; }
        .ytqm-close-btn:hover { color: #fff; background: #e74c3c; border-color: #fff; }
      `;
		},

		_cssQueueList() {
			return `
        #ytqm-list { overflow-y: auto; flex: 1; padding: 4px 0 8px; }
        #ytqm-list::-webkit-scrollbar { width: 5px; }
        #ytqm-list::-webkit-scrollbar-track { background: transparent; }
        #ytqm-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 99px; }
        /* Items are NOT draggable on the row level — only via the handle.
           See refreshPanel() for the handle-driven \`draggable\` toggle. */
        .ytqm-item { display: flex; align-items: center; gap: 6px; padding: 9px 14px; transition: background 0.12s; border-radius: 8px; margin: 2px 6px; position: relative; }
        .ytqm-item:hover     { background: rgba(255,255,255,0.07); }
        .ytqm-item.dragging  { opacity: 0.35; }
        /* Drop indicator: 2px line above OR below the hovered item, telling
           the user exactly where the drop will land — replaces the old single
           ambiguous "drag-over" highlight that covered the whole row. */
        .ytqm-item.drop-above::before,
        .ytqm-item.drop-below::after {
            content: '';
            position: absolute;
            left: 6px; right: 6px;
            height: 2px;
            background: rgba(46,204,113,0.9);
            border-radius: 2px;
            pointer-events: none;
        }
        .ytqm-item.drop-above::before { top: -1px; }
        .ytqm-item.drop-below::after  { bottom: -1px; }
        .ytqm-item-handle { color: rgba(255,255,255,0.25); cursor: grab; flex-shrink: 0; font-size: 12px; padding: 0 2px; user-select: none; }
        .ytqm-item-handle:hover  { color: rgba(255,255,255,0.7); }
        .ytqm-item-handle:active { cursor: grabbing; }
        .ytqm-item-index { font-size: 12.5px; color: rgba(255,255,255,0.3); flex-shrink: 0; }
        /* user-select:text means the user can highlight & copy the title even
           though the surrounding row participates in HTML5 drag-and-drop. */
        .ytqm-item-title { flex: 1; font-size: 12.5px; color: rgba(255,255,255,0.85); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: text; cursor: text; }
        .ytqm-item-remove { background: none; border: none; color: rgba(255,255,255,0.25); cursor: pointer; font-size: 15px; padding: 0 2px; flex-shrink: 0; font-family: inherit; transition: color 0.12s; }
        .ytqm-item-remove:hover { color: #e74c3c; }
        #ytqm-empty { padding: 28px 16px; text-align: center; color: rgba(255,255,255,0.3); font-size: 13px; }
      `;
		},

		_cssSettingsOverlay() {
			return `
        #ytqm-settings-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(3px); z-index: 10; display: none; align-items: center; justify-content: center; pointer-events: all; }
        #ytqm-settings-overlay.open { display: flex; }
        #ytqm-settings-modal { background: #111; border: 1.5px solid rgba(255,255,255,0.18); border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.75); width: 340px; color: #fff; font-family: 'Segoe UI', Arial, system-ui, sans-serif; overflow: hidden; }
        #ytqm-settings-header { padding: 14px 16px 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; }
        #ytqm-settings-body { padding: 10px 0 6px; overflow-y: auto; max-height: 70vh; }
        .ytqm-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-radius: 8px; margin: 2px 6px; transition: background 0.12s; cursor: default; }
        .ytqm-setting-row:hover { background: rgba(255,255,255,0.05); }
        .ytqm-setting-label { font-size: 12.5px; color: rgba(255,255,255,0.8); line-height: 1.4; flex: 1; }
        .ytqm-setting-label small { display: block; font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 2px; font-weight: 400; }
        .ytqm-setting-label .ytqm-beta-badge { display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 0.06em; background: rgba(230,126,34,0.25); color: rgba(230,126,34,0.9); border: 1px solid rgba(230,126,34,0.4); border-radius: 4px; padding: 1px 5px; margin-left: 5px; vertical-align: middle; text-transform: uppercase; }

        /* ── Phone server URL row ── */
        .ytqm-setting-row.url-row { flex-direction: column; align-items: stretch; gap: 6px; }
        .ytqm-setting-row.url-row .ytqm-setting-label { margin-bottom: 0; }
        #ytqm-phone-url-input { width: 100%; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: #fff; padding: 6px 9px; font-size: 12px; font-family: inherit; }
        #ytqm-phone-url-input:focus { outline: none; border-color: rgba(255,255,255,0.45); }

        /* ── Import / Export section ── */
        #ytqm-io-section { border-top: 1px solid rgba(255,255,255,0.08); margin: 8px 0 0; padding: 12px 16px 14px; }
        #ytqm-io-title { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.3); margin-bottom: 10px; }
        .ytqm-io-row { display: flex; gap: 8px; margin-bottom: 0; align-items: center; }
        .ytqm-io-btn { flex: 1; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; color: rgba(255,255,255,0.8); font-size: 12px; font-weight: 600; font-family: inherit; padding: 7px 10px; cursor: pointer; transition: background 0.15s, color 0.15s; white-space: nowrap; text-align: center; }
        .ytqm-io-btn:hover { background: rgba(255,255,255,0.13); color: #fff; }
        .ytqm-io-btn.accent { background: rgba(39,174,96,0.15); border-color: rgba(39,174,96,0.35); color: rgba(39,174,96,0.9); }
        .ytqm-io-btn.accent:hover { background: rgba(39,174,96,0.25); color: #2ecc71; }
        #ytqm-io-status { font-size: 11px; color: rgba(255,255,255,0.35); min-height: 16px; transition: color 0.2s; margin-top: 8px; text-align: center; }
        #ytqm-io-status.ok  { color: rgba(46,204,113,0.85); }
        #ytqm-io-status.err { color: rgba(231,76,60,0.9); }
      `;
		},

		_cssToggleSwitch() {
			return `
        .ytqm-toggle { position: relative; flex-shrink: 0; width: 36px; height: 20px; cursor: pointer; }
        .ytqm-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
        .ytqm-toggle-track { position: absolute; inset: 0; background: rgba(255,255,255,0.15); border-radius: 999px; border: 1px solid rgba(255,255,255,0.2); transition: background 0.2s, border-color 0.2s; }
        .ytqm-toggle input:checked + .ytqm-toggle-track { background: rgba(204,0,0,0.85); border-color: rgba(204,0,0,0.6); }
        .ytqm-toggle-thumb { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; background: #fff; border-radius: 50%; box-shadow: 0 1px 4px rgba(0,0,0,0.4); transition: transform 0.2s; pointer-events: none; }
        .ytqm-toggle input:checked ~ .ytqm-toggle-thumb { transform: translateX(16px); }
      `;
		},

		_cssStatusPill() {
			return `
        #ytqm-status { bottom: 68px !important; transition: bottom 0.2s ease, opacity 0.3s; }
      `;
		},

		_css() {
			return [
				this._cssReset(), this._cssButtonBar(), this._cssAddBtnFlash(),
				this._cssQueuePanel(), this._cssPanelControls(), this._cssQueueList(),
				this._cssSettingsOverlay(), this._cssToggleSwitch(), this._cssStatusPill(),
			].join('\n');
		},

		_buildButtons() {
			this.addBtn = this._makeBtn('ytqm-add-btn', '', () => this._onAddClick());
			this.queueToggleBtn = this._makeBtn('ytqm-queue-toggle', '\u2261 Queue', () => this.togglePanel());
			this.playBtn = this._makeBtn('ytqm-play-btn', '\u25b6 Play Queue', () => this._onPlayClick());
			this.addBtn.addEventListener('contextmenu', e => this._onAddContextMenu(e));
			this.addBtnLabel = document.createElement('span');
			this.addBtnLabel.textContent = '\uff0b Add to Queue';
			this.addBtn.appendChild(this.addBtnLabel);
			this.addBtnFlash = document.createElement('div');
			this.addBtnFlash.id = 'ytqm-add-btn-flash';
			this.addBtn.appendChild(this.addBtnFlash);
			this.root.appendChild(this.queueToggleBtn);
			this.root.appendChild(this.playBtn);
			this.root.appendChild(this.addBtn);
		},

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

		_buildPanel() {
			this.panel = document.createElement('div');
			this.panel.id = 'ytqm-panel';

			// Header
			const header = document.createElement('div');
			header.id = 'ytqm-panel-header';
			const title = document.createElement('span');
			title.id = 'ytqm-panel-title';
			title.title = 'Open settings';
			title.addEventListener('click', e => {
				e.stopPropagation();
				this.openSettings();
			});

			const titleText = document.createElement('span');
			titleText.textContent = 'Queue';

			const cogIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			cogIcon.setAttribute('id', 'ytqm-cog-icon');
			cogIcon.setAttribute('viewBox', '0 0 20 20');
			cogIcon.setAttribute('fill', 'currentColor');
			cogIcon.setAttribute('aria-hidden', 'true');
			cogIcon.innerHTML = `<path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>`;

			title.append(titleText, cogIcon);
			const controls = document.createElement('div');
			controls.className = 'header-controls';
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
			closeBtn.id = 'ytqm-panel-close';
			closeBtn.className = 'ytqm-close-btn';
			closeBtn.textContent = '\u2716';
			closeBtn.addEventListener('click', () => this.togglePanel(false));
			controls.append(prevBtn, this.remotePauseBtn, skipBtn, closeBtn);
			header.append(title, controls);

			// Now Playing section
			this.nowPlayingSection = document.createElement('div');
			this.nowPlayingSection.id = 'ytqm-now-playing';
			this.nowPlayingSection.style.display = 'none';
			const npLabel = document.createElement('div');
			npLabel.id = 'ytqm-now-playing-label';
			npLabel.textContent = 'Now Playing';
			const npTitle = document.createElement('div');
			npTitle.id = 'ytqm-now-playing-title';
			const bars = document.createElement('span');
			bars.className = 'np-bars';
			bars.innerHTML = '<span></span><span></span><span></span><span></span>';
			const npText = document.createElement('span');
			npText.id = 'ytqm-now-playing-text';
			npTitle.append(bars, npText);
			this.nowPlayingSection.append(npLabel, npTitle);

			// Up Next label + queue actions (Shuffle / Clear).
			// We house the actions here rather than in the panel header so they
			// are contextually attached to the queue list and don't crowd the
			// playback transport controls (prev/skip/pause/close).
			this.upNextLabel = document.createElement('div');
			this.upNextLabel.id = 'ytqm-up-next-label';
			this.upNextLabel.style.display = 'none';

			const upNextText = document.createElement('span');
			upNextText.textContent = 'Up Next';

			const queueActions = document.createElement('span');
			queueActions.className = 'ytqm-queue-actions';

			this.shuffleBtn = document.createElement('button');
			this.shuffleBtn.id = 'ytqm-shuffle-btn';
			this.shuffleBtn.className = 'ytqm-mini-btn';
			this.shuffleBtn.title = 'Shuffle remaining items';
			this.shuffleBtn.textContent = 'Shuffle';
			this.shuffleBtn.addEventListener('click', () => this._onShuffleClick());

			this.clearBtn = document.createElement('button');
			this.clearBtn.id = 'ytqm-clear-btn';
			this.clearBtn.className = 'ytqm-mini-btn';
			this.clearBtn.title = 'Clear all queued items';
			this.clearBtn.textContent = 'Clear';
			this.clearBtn.addEventListener('click', () => this._onClearClick());

			queueActions.append(this.shuffleBtn, this.clearBtn);
			this.upNextLabel.append(upNextText, queueActions);

			this.list = document.createElement('div');
			this.list.id = 'ytqm-list';

			this.panel.append(header, this.nowPlayingSection, this.upNextLabel, this.list);
			this.shadow.appendChild(this.panel);
			this._buildSettingsModal();
		},

		_buildSettingsModal() {
			this.settingsOverlay = document.createElement('div');
			this.settingsOverlay.id = 'ytqm-settings-overlay';
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
			headerClose.id = 'ytqm-settings-close';
			headerClose.className = 'ytqm-close-btn';
			headerClose.textContent = '\u2716';
			headerClose.addEventListener('click', () => this.closeSettings());
			header.append(headerTitle, headerClose);
			const body = document.createElement('div');
			body.id = 'ytqm-settings-body';

			const defs = [{
					key: 'remoteControls',
					label: 'Cross-tab controls',
					sub: 'Show pause, skip & previous buttons in the queue panel when another tab is playing.'
				},
				{
					key: 'theaterMode',
					label: 'Auto theater mode',
					sub: 'Switch to theater mode when the browser window is narrower than 60 % of your screen width, and back when it widens. Useful when sharing the screen with another app.'
				},
				{
					key: 'restartFromBeginning',
					label: 'Always restart from beginning',
					sub: 'Seek to 0:00 whenever the queue navigates to a video, including ones that may have partial watch progress saved by YouTube.'
				},
				{
					key: 'blockContextMenu',
					label: 'Block right-click menu',
					sub: 'Suppress the browser context menu site-wide so right-clicking a thumbnail button always triggers "play next" without the menu appearing.'
				},
				{
					key: 'mediaSessionRefresh',
					label: 'Aggressive MediaSession refresh',
					sub: 'Periodically re-register next/previous track handlers. Fixes media keys going silent after YouTube reinitialises its player.'
				},
				{
					key: 'mediaSessionRefreshInterval',
					label: 'Refresh interval (seconds)',
					sub: 'How often to re-register when aggressive refresh is on. Default: 5 s. Lower = more responsive, slightly more CPU.',
					type: 'number'
				},
				{
					key: 'hideNativeButtons',
					label: 'Hide YouTube\'s thumbnail buttons',
					sub: 'Suppress the native Watch Later and Add to Queue buttons that appear on hover, so only the queue manager button is shown.'
				},
				{
					key: 'enqueueFromPhone',
					label: 'Enqueue videos shared from phone',
					sub: 'Videos shared from your Android device via the local server go straight into the queue instead of opening a new tab.'
				},
				{
					key: 'keyboardShortcuts',
					label: 'Keyboard shortcuts',
					sub: 'Alt+Q toggles add/remove for the current video, Alt+N skips, Alt+P goes to previous. Ignored while typing in inputs.'
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
						textAlign: 'center'
					});
					control.addEventListener('change', () => {
						const v = Math.max(1, Math.min(60, parseInt(control.value, 10) || 5));
						control.value = v;
						Settings.set(def.key, v);
						log(`Setting changed: ${def.key} =`, v);
						if (Player._playing) Player._registerMediaSession();
					});
				} else {
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
						if (def.key === 'enqueueFromPhone') {
							input.checked ? PhonePoller.start() : PhonePoller.stop();
						}
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

			// ── Phone server URL row ──────────────────────────────────────────
			const urlRow = document.createElement('label');
			urlRow.className = 'ytqm-setting-row url-row';
			const urlLabel = document.createElement('span');
			urlLabel.className = 'ytqm-setting-label';
			urlLabel.textContent = 'Phone server URL';
			const urlSmall = document.createElement('small');
			urlSmall.textContent = `Address of the /poll endpoint on your local server. Default: ${SETTINGS_DEFAULTS.phoneServerUrl}`;
			urlLabel.appendChild(urlSmall);
			const urlInput = document.createElement('input');
			urlInput.id = 'ytqm-phone-url-input';
			urlInput.type = 'text';
			urlInput.placeholder = SETTINGS_DEFAULTS.phoneServerUrl;
			urlInput.value = Settings.get().phoneServerUrl || SETTINGS_DEFAULTS.phoneServerUrl;

			// Validate that the entered string parses as a URL with an http(s)
			// protocol. We restrict to http/https to keep the fetch surface
			// predictable — javascript:, file:, etc. would be unsafe and have
			// no useful semantics for the phone-poll endpoint.
			const isValidUrl = (val) => {
				try {
					const u = new URL(val);
					return u.protocol === 'http:' || u.protocol === 'https:';
				} catch {
					return false;
				}
			};
			const reflectValidity = () => {
				const v = urlInput.value.trim();
				const ok = !v || isValidUrl(v); // empty is treated as "use default"
				urlInput.style.borderColor = ok ? '' : 'rgba(231,76,60,0.85)';
				urlInput.title = ok ? '' : 'Must be an http:// or https:// URL';
			};
			urlInput.addEventListener('input', reflectValidity);
			urlInput.addEventListener('change', () => {
				const v = urlInput.value.trim();
				if (v && !isValidUrl(v)) {
					// Reject the change — keep the previous setting and flag the input.
					reflectValidity();
					warn('Rejected invalid phoneServerUrl:', v);
					return;
				}
				Settings.set('phoneServerUrl', v || SETTINGS_DEFAULTS.phoneServerUrl);
				log('Setting changed: phoneServerUrl =', Settings.get().phoneServerUrl);
				reflectValidity();
			});
			reflectValidity();
			urlRow.append(urlLabel, urlInput);
			body.appendChild(urlRow);

			// ── Import / Export section ────────────────────────────────────────
			const ioSection = document.createElement('div');
			ioSection.id = 'ytqm-io-section';

			const ioTitle = document.createElement('div');
			ioTitle.id = 'ytqm-io-title';
			ioTitle.textContent = 'Queue Import / Export';

			const ioStatus = document.createElement('div');
			ioStatus.id = 'ytqm-io-status';
			let ioStatusTimer = null;
			const setIoStatus = (msg, type = '', durationMs = 4000) => {
				ioStatus.textContent = msg;
				ioStatus.className = type;
				clearTimeout(ioStatusTimer);
				if (msg) ioStatusTimer = setTimeout(() => {
					ioStatus.textContent = '';
					ioStatus.className = '';
				}, durationMs);
			};

			const ioRow = document.createElement('div');
			ioRow.className = 'ytqm-io-row';

			const exportBtn = document.createElement('button');
			exportBtn.className = 'ytqm-io-btn accent';
			exportBtn.textContent = '⬆ Copy Queue';
			exportBtn.title = 'Copy the current queue to the clipboard as JSON';
			exportBtn.addEventListener('click', async () => {
				const {
					ok,
					count
				} = await QueueIO.exportToClipboard();
				if (ok) setIoStatus(`✓ Copied ${count} item${count !== 1 ? 's' : ''} to clipboard`, 'ok');
				else setIoStatus('✗ Clipboard write failed — check browser permissions', 'err');
			});

			const importBtn = document.createElement('button');
			importBtn.className = 'ytqm-io-btn';
			importBtn.textContent = '⬇ Paste & Append';
			importBtn.title = 'Read JSON from the clipboard and append new items to the queue';
			importBtn.addEventListener('click', async () => {
				const {
					ok,
					added,
					error
				} = await QueueIO.importFromClipboard();
				if (ok) setIoStatus(`✓ Appended ${added} item${added !== 1 ? 's' : ''} to queue`, 'ok');
				else setIoStatus(`✗ ${error}`, 'err');
			});

			ioRow.append(exportBtn, importBtn);
			ioSection.append(ioTitle, ioRow, ioStatus);
			body.appendChild(ioSection);

			modal.append(header, body);
			this.settingsOverlay.appendChild(modal);
			this.shadow.appendChild(this.settingsOverlay);
		},

		openSettings() {
			this.settingsOverlay.querySelectorAll('input[type="checkbox"]').forEach(input => {
				input.checked = Settings.get()[input._ytqmSettingKey];
			});
			this.settingsOverlay.querySelectorAll('input[type="number"]').forEach(input => {
				input.value = Settings.get()[input._ytqmSettingKey];
			});
			const urlInput = this.settingsOverlay.querySelector('#ytqm-phone-url-input');
			if (urlInput) urlInput.value = Settings.get().phoneServerUrl || SETTINGS_DEFAULTS.phoneServerUrl;
			this.settingsOverlay.classList.add('open');
		},

		closeSettings() {
			this.settingsOverlay.classList.remove('open');
		},

		_currentVideoMeta() {
			const videoId = new URLSearchParams(location.search).get('v');
			if (!videoId) return null;
			const url = `https://www.youtube.com/watch?v=${videoId}`;
			const titleEl = document.querySelector(SEL.WATCH_TITLE);
			const title = titleEl?.textContent?.trim() || document.title.replace(/\s*[-|]\s*YouTube\s*$/i, '').trim() || 'Untitled video';
			const channel = document.querySelector(SEL.CHANNEL_NAME)?.getAttribute('title')?.trim() || '';
			return {
				url,
				title,
				channel
			};
		},

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

		_onRemotePauseClick() {
			if (Storage.paused) Player.remoteResume();
			else Player.remotePause();
		},

		/**
		 * Shuffle "remaining" items only — when the queue is playing, queue[0]
		 * is the now-playing video and is left in place. Fisher-Yates over the
		 * tail. We rebuild via Storage.setQueue which goes through mutate, so
		 * the cross-tab race protections still apply.
		 */
		_onShuffleClick() {
			const queue = Storage.queue;
			const playing = Player._playing && queue.length > 0;
			const head = playing ? queue.slice(0, 1) : [];
			const tail = playing ? queue.slice(1) : queue.slice();
			if (tail.length < 2) {
				this.showStatus('Nothing to shuffle', 2000);
				return;
			}
			// Fisher-Yates in place
			for (let i = tail.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[tail[i], tail[j]] = [tail[j], tail[i]];
			}
			Storage.setQueue([...head, ...tail]);
			this.refreshPanel();
			this.updateControls();
			ThumbnailInjector.syncAllButtons();
			this.showStatus(`Shuffled ${tail.length} items`, 2000);
		},

		/**
		 * Clear the queue. If the queue is playing, the now-playing video is
		 * preserved (clearing it would yank the rug out from under playback).
		 * The user can stop the queue first if they want a true wipe.
		 */
		_onClearClick() {
			const queue = Storage.queue;
			if (queue.length === 0) {
				this.showStatus('Queue is already empty', 2000);
				return;
			}
			const playing = Player._playing && queue.length > 0;
			const removed = playing ? queue.length - 1 : queue.length;
			if (removed === 0) {
				this.showStatus('Nothing to clear', 2000);
				return;
			}
			// Lightweight confirm — using window.confirm because the panel UI
			// doesn't have a custom modal and a destructive action deserves
			// a deliberate "yes". `window.confirm` works fine in a userscript.
			if (!window.confirm(`Remove ${removed} item${removed === 1 ? '' : 's'} from the queue?`)) return;
			Storage.setQueue(playing ? queue.slice(0, 1) : []);
			this.refreshPanel();
			this.updateControls();
			ThumbnailInjector.syncAllButtons();
			this.showStatus(`Cleared ${removed} item${removed === 1 ? '' : 's'}`, 2000);
		},

		flashBtn(btn, tempText) {
			const original = btn.textContent;
			btn.textContent = tempText;
			setTimeout(() => {
				btn.textContent = original;
			}, BTN_TEMP_TEXT_DURATION_MS);
		},

		showStatus(msg, durationMs = STATUS_DEFAULT_DURATION_MS) {
			if (!this.shadow) return;
			let pill = this.shadow.getElementById('ytqm-status');
			if (!pill) {
				pill = document.createElement('div');
				pill.id = 'ytqm-status';
				Object.assign(pill.style, {
					position: 'fixed',
					left: '20px',
					bottom: '68px',
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
					transition: 'bottom 0.2s ease, opacity 0.3s'
				});
				this.shadow.appendChild(pill);
			}
			this._updateStatusPillPosition();
			pill.textContent = msg;
			pill.style.opacity = '1';
			clearTimeout(pill._hideTimer);
			pill._hideTimer = setTimeout(() => {
				pill.style.opacity = '0';
			}, durationMs);
		},

		updateControls() {
			if (!this.addBtn) return;
			const isWatch = Page.isWatchPage();
			const playing = Player._playing;
			const count = Storage.queue.length;
			this.queueToggleBtn.textContent = count > 0 ? `\u2261 Queue (${count})` : '\u2261 Queue';
			const currentUrl = isWatch ? `https://www.youtube.com/watch?v=${new URLSearchParams(location.search).get('v')}` : null;
			const alreadyQueued = !!currentUrl && !!Storage.queue.find(v => v.url === currentUrl);
			this.addBtn.style.display = isWatch ? 'inline-flex' : 'none';
			if (isWatch) this.addBtnLabel.textContent = alreadyQueued ? '\u2212 Remove from Queue' : '\uff0b Add to Queue';
			this.playBtn.style.display = 'inline-flex';
			this.playBtn.textContent = playing ? '\u25a0 Stop Queue' : (count > 0 ? `\u25b6 Play Queue (${count})` : '\u25b6 Play Queue');
			playing ? this.playBtn.classList.add('is-playing') : this.playBtn.classList.remove('is-playing');
			this.updateRemotePauseBtn();
		},

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
				isPaused ? this.remotePauseBtn.classList.add('is-paused') : this.remotePauseBtn.classList.remove('is-paused');
				if (this.prevBtn) this.prevBtn.style.display = hasHistory ? '' : 'none';
				if (this.skipBtn) this.skipBtn.style.display = hasNext ? '' : 'none';
			} else {
				this.remotePauseBtn.style.display = 'none';
				if (this.prevBtn) this.prevBtn.style.display = 'none';
				if (this.skipBtn) this.skipBtn.style.display = 'none';
			}
		},

		togglePanel(force) {
			this.panelOpen = force !== undefined ? force : !this.panelOpen;
			if (this.panelOpen) {
				this.refreshPanel();
				this.panel.classList.add('open');
			} else {
				this.panel.classList.remove('open');
			}
			this._updateStatusPillPosition();
		},

		_updateStatusPillPosition() {
			const pill = this.shadow?.getElementById('ytqm-status');
			if (!pill) return;
			if (this.panelOpen && this.panel) {
				// Position the pill just above the open panel with a small gap.
				const panelHeight = this.panel.getBoundingClientRect().height || 0;
				pill.style.bottom = (panelHeight + 76) + 'px';
			} else {
				pill.style.bottom = '68px';
			}
		},

		refreshPanel() {
			if (!this.list) return;
			const queue = Storage.queue;
			const playing = Player._playing;
			this.list.innerHTML = '';

			if (playing && queue.length > 0) {
				this.nowPlayingSection.style.display = 'block';
				this.upNextLabel.style.display = queue.length > 1 ? 'block' : 'none';
				const npText = this.shadow.getElementById('ytqm-now-playing-text');
				if (npText) npText.textContent = queue[0].title;
			} else {
				this.nowPlayingSection.style.display = 'none';
				this.upNextLabel.style.display = 'none';
			}

			const listStart = playing && queue.length > 0 ? 1 : 0;
			const listItems = queue.slice(listStart);

			if (listItems.length === 0 && !playing) {
				const empty = document.createElement('div');
				empty.id = 'ytqm-empty';
				empty.textContent = 'Queue is empty. Add videos to get started.';
				this.list.appendChild(empty);
				this.updateControls();
				return;
			}

			listItems.forEach((video, displayIdx) => {
				const queueIdx = displayIdx + listStart;

				const item = document.createElement('div');
				item.className = 'ytqm-item';
				// IMPORTANT: item.draggable starts FALSE. We flip it to true on
				// mousedown of the drag handle, then back to false on dragend or
				// mouseup. This is the standard pattern for "drag by handle"
				// using the native HTML5 DnD API — without it, the entire row
				// would be draggable and the user couldn't select the title text.
				item.draggable = false;
				item.dataset.queueIndex = queueIdx;

				// Drag handle (☰).
				//   • mousedown enables draggable on the parent (drag-by-handle pattern).
				//   • right-click moves this item to the "next" slot — right after the
				//     now-playing item when the queue is playing, or to the very front
				//     when it's not. This matches the right-click-as-Play-Next behaviour
				//     the thumbnail buttons already use, so the gesture is consistent
				//     across the script. We rely on Storage.insertNext, which dedupes
				//     and adjusts the insert index for the source-removal shift.
				const handle = document.createElement('span');
				handle.className = 'ytqm-item-handle';
				handle.title = 'Drag to reorder · right-click to play next';
				handle.textContent = '\u2630'; // ☰
				handle.addEventListener('mousedown', () => { item.draggable = true; });
				handle.addEventListener('contextmenu', e => {
					e.preventDefault();
					e.stopPropagation();
					// "Next" = index 1 when something is playing, 0 otherwise.
					// Bail if the item is already there — no-op avoids a needless
					// storage write and a panel re-render flicker.
					const targetIdx = playing ? 1 : 0;
					if (queueIdx === targetIdx) {
						this.showStatus('Already playing next', 1500);
						return;
					}
					Storage.insertNext(video.url, video.title, video.channel || '', targetIdx);
					this.refreshPanel();
					this.updateControls();
					this.showStatus('Moved to play next', 1500);
				});

				const idxLabel = document.createElement('span');
				idxLabel.className = 'ytqm-item-index';
				idxLabel.textContent = playing ? displayIdx + 1 : queueIdx + 1;

				const titleEl = document.createElement('span');
				titleEl.className = 'ytqm-item-title';
				titleEl.textContent = video.title;
				titleEl.title = video.title;

				const removeBtn = document.createElement('button');
				removeBtn.className = 'ytqm-item-remove';
				removeBtn.textContent = '\u2715';
				removeBtn.addEventListener('click', e => {
					e.stopPropagation();
					Storage.removeVideo(video.id);
					this.refreshPanel();
					this.updateControls();
				});

				item.append(handle, idxLabel, titleEl, removeBtn);

				// Helper for dragover/drop: "above" means "drop before this item",
				// "below" means "drop after". We compute by mouse Y vs item midline.
				const dropPosition = e => {
					const rect = item.getBoundingClientRect();
					return (e.clientY - rect.top) < rect.height / 2 ? 'above' : 'below';
				};

				const clearDropIndicators = () => {
					this.shadow.querySelectorAll('.ytqm-item').forEach(el =>
						el.classList.remove('drop-above', 'drop-below'));
				};

				item.addEventListener('dragstart', e => {
					this._dragSrcIndex = queueIdx;
					item.classList.add('dragging');
					e.dataTransfer.effectAllowed = 'move';
				});
				item.addEventListener('dragend', () => {
					item.classList.remove('dragging');
					item.draggable = false;
					clearDropIndicators();
				});
				// Safety: if mouseup fires without ever starting a drag, reset.
				item.addEventListener('mouseup', () => { item.draggable = false; });
				item.addEventListener('dragover', e => {
					e.preventDefault();
					e.dataTransfer.dropEffect = 'move';
					clearDropIndicators();
					item.classList.add(dropPosition(e) === 'above' ? 'drop-above' : 'drop-below');
				});
				item.addEventListener('drop', e => {
					e.preventDefault();
					clearDropIndicators();
					if (this._dragSrcIndex === null) return;
					const from = this._dragSrcIndex;
					this._dragSrcIndex = null;
					let to = parseInt(item.dataset.queueIndex, 10);
					if (dropPosition(e) === 'below') to++;
					// Account for the implicit shift that happens when we remove
					// the source item from before the target index.
					if (from < to) to--;
					if (from === to) return;
					Storage.reorder(from, to);
					this.refreshPanel();
				});

				this.list.appendChild(item);
			});

			this.updateControls();
		},
	};

	// ── Context Menu Blocker ──────────────────────────────────────────────────

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

	// ── Native Button Hider ───────────────────────────────────────────────────

	const NativeButtonHider = {
		_styleEl: null,
		_CSS: [
			'yt-thumbnail-hover-overlay-toggle-actions-view-model',
			'ytd-thumbnail-overlay-toggle-button-renderer',
			'ytd-thumbnail-overlay-buttons-renderer',
		].map(s => `${s}{display:none!important}`).join(''),
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

	// ── URL Change Detection ──────────────────────────────────────────────────

	let lastUrl = location.href;

	function notifyUrlChange(newHref) {
		lastUrl = newHref;
		onUrlChange();
	}

	function onUrlChange() {
		log('URL changed to', location.href);
		UI.updateControls();
		if (UI.panelOpen) UI.refreshPanel();
		if (Page.isWatchPage()) TheaterMode.init();
		ThumbnailInjector.syncAllButtons();
	}

	window.addEventListener('popstate', () => {
		setTimeout(() => {
			if (location.href !== lastUrl) notifyUrlChange(location.href);
		}, URL_CHANGE_SETTLE_MS);
	});
	window.addEventListener('yt-navigate-finish', () => {
		if (location.href !== lastUrl) notifyUrlChange(location.href);
		else onUrlChange();
		if (Player._playing && Page.isWatchPage()) {
			log('yt-navigate-finish: attaching to video');
			setTimeout(() => Player._waitForVideoAndPlay(), 300);
		}
	});

	// ── Theater Mode ──────────────────────────────────────────────────────────

	const TheaterMode = {
		_initialised: false,
		_debounceTimer: null,
		_findTheaterButton() {
			return document.querySelector(SEL.THEATER_BTN_DATA) || document.querySelector(SEL.THEATER_BTN_CLASS) || [...document.querySelectorAll('button[title]')].find(b => b.title.endsWith('(t)') && b.closest('.ytp-right-controls'));
		},
		_isTheaterMode() {
			return document.querySelector(SEL.WATCH_FLEXY)?.hasAttribute('theater') ?? false;
		},
		_injectCaptionStyle() {
			if (document.getElementById('ytrs-caption-style')) return;
			const style = document.createElement('style');
			style.id = 'ytrs-caption-style';
			style.textContent = '.ytp-caption-segment { color: white !important; }';
			document.head.appendChild(style);
		},
		check() {
			if (!Settings.get().theaterMode) return;
			if (!document.hasFocus()) return;
			if (!Page.isWatchPage()) return;
			if (document.fullscreenElement || document.webkitFullscreenElement) return;
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
		init() {
			this._injectCaptionStyle();
			if (this._initialised) {
				this.check();
				return;
			}
			this._initialised = true;
			window.addEventListener('resize', () => this._debounce(() => this.check(), THEATER_RESIZE_DEBOUNCE_MS));
			window.addEventListener('focus', () => this._debounce(() => this.check(), THEATER_FOCUS_DEBOUNCE_MS));
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') this.check();
			});
			this.check();
			log('TheaterMode initialised');
		},
	};

	// ── Keyboard Shortcuts ────────────────────────────────────────────────────
	//
	// Three optional shortcuts the user can disable from settings. We chose
	// Alt-prefixed bindings deliberately:
	//   • Bare `n` and `p` already mean "next/previous video" inside YouTube's
	//     own player. We must not stomp on that.
	//   • Ctrl+Shift+P is owned by Firefox dev tools, Ctrl+Shift+N opens an
	//     incognito window in Chrome. Avoid those too.
	//   • Alt-combos are largely unused by YouTube and the major browsers
	//     (Alt by itself opens menus on some platforms, but Alt+letter is
	//     fine when the page has focus and not the chrome).
	//
	// Bindings (Alt-prefixed):
	//   Alt+Q  — toggle add/remove current video to queue (watch pages only)
	//   Alt+N  — skip to next item in queue (queue must be playing)
	//   Alt+P  — go to previous item via history (queue must be playing)
	//
	// The handler bails out when the user is typing in an input/textarea/
	// contenteditable element, so it never eats characters in the search box,
	// comment box, etc.

	const KeyboardShortcuts = {
		_initialised: false,
		init() {
			if (this._initialised) return;
			this._initialised = true;
			document.addEventListener('keydown', e => this._onKeyDown(e), true);
			log('KeyboardShortcuts initialised');
		},
		_onKeyDown(e) {
			if (!Settings.get().keyboardShortcuts) return;

			// Require Alt only — reject other modifier combinations so we
			// don't fire when the user is doing browser-level shortcuts like
			// Ctrl+Alt+Q (some accessibility tools use those).
			if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

			// Don't intercept while typing in any editable surface. Includes
			// YouTube's search box, comment composer, and any inputs in the
			// settings modal.
			const t = e.target;
			if (t.matches?.('input, textarea, select, [contenteditable="true"]')) return;
			if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;

			// e.code is layout-independent; e.key respects the user's keymap.
			// We use e.code so a Dvorak / AZERTY user gets the same physical-
			// key shortcut they'd expect from a Western app. Adjust if you'd
			// rather match the *typed letter* instead.
			switch (e.code) {
				case 'KeyQ':
					if (Page.isWatchPage()) {
						e.preventDefault();
						UI._onAddClick();
					}
					break;
				case 'KeyN':
					if (Player._playing) {
						e.preventDefault();
						Player.skip();
						UI.showStatus('Skipping…', 1500);
					}
					break;
				case 'KeyP':
					if (Player._playing) {
						e.preventDefault();
						Player.previous();
					}
					break;
			}
		},
	};

	// ── Boot ──────────────────────────────────────────────────────────────────

	function tryInit() {
		if (!document.body) {
			setTimeout(tryInit, 100);
			return;
		}
		log('Initialising…');
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
				zIndex: '2147483647', // sit above YouTube's chrome — was '1' which got buried
				background: '#c0392b',
				color: '#fff',
				padding: '8px 14px',
				borderRadius: '999px',
				fontFamily: 'sans-serif',
				fontSize: '13px',
				boxShadow: '0 4px 18px rgba(0,0,0,0.5)'
			});
			err.textContent = 'YT Queue: storage unavailable';
			document.body.appendChild(err);
			return;
		}
		UI.init();
		ThumbnailInjector.start();
		ContextMenuBlocker.init();
		NativeButtonHider.apply();
		KeyboardShortcuts.init();
		if (Page.isWatchPage()) TheaterMode.init();
		if (Settings.get().enqueueFromPhone) PhonePoller.start();

		// Recover playback state after a page refresh. If the playing flag was
		// persisted but Player._playing is false (it's always false on boot),
		// a refresh happened mid-queue — resume from where we left off.
		const _bootState = Storage.load();
		if (_bootState.playing && _bootState.queue.length > 0) {
			log('Resuming queue after page refresh — queue has', _bootState.queue.length, 'items.');
			Player.start();
		}

		log('Ready. Queue has', Storage.queue.length, 'items.');
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryInit);
	else tryInit();

	// ── Public API ────────────────────────────────────────────────────────────
	// Exposed on window so you can call these from the browser console or from
	// other userscripts / bookmarklets without digging into the closure.
	//
	//   window.ytQueueManager.reloadAndResume()
	//     Hard-reloads the current page; queue resumes automatically on boot.
	//
	//   window.ytQueueManager.reloadAndResume('https://www.youtube.com/watch?v=XYZ')
	//   window.ytQueueManager.reloadAndResume('XYZ')
	//     Navigates to the given video (full URL or bare video ID) with a hard
	//     load, splicing it to the front of the queue if needed, then resumes.
	//
	//   window.ytQueueManager.setDebug(true|false)
	//     Toggle verbose [YT-Queue] logging at runtime. The choice is persisted
	//     to localStorage under DEBUG_KEY so it survives page reloads.
	//
	//   window.ytQueueManager.getState()
	//     Snapshot of the current queue/history/flags, useful for inspection
	//     or debugging — returns a plain object, not a live reference.
	//
	//   window.ytQueueManager.version
	//     The userscript @version string, surfaced for sanity-checking which
	//     build is actually running on a page.
	//
	window.ytQueueManager = {
		version: '1.5.0',
		reloadAndResume: (url) => Player.reloadAndResume(url),
		setDebug: (on) => {
			DEBUG = !!on;
			if (DEBUG) localStorage.setItem(DEBUG_KEY, '1');
			else localStorage.removeItem(DEBUG_KEY);
			console.log(LOG_PREFIX, 'Debug logging', DEBUG ? 'ENABLED' : 'disabled');
		},
		getState: () => {
			const s = Storage.load();
			return {
				queue: [...s.queue],
				history: [...s.history],
				paused: s.paused,
				playing: s.playing,
				playerActive: Player._playing,
				thisTabIsOwner: PlayingTab.isOwner(),
				anyTabPlaying: PlayingTab.anyPlaying(),
			};
		},
	};
})();
