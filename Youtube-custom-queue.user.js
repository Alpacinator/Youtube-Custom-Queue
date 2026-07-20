// ==UserScript==
// @name YouTube Queue Manager
// @namespace https://github.com/Alpacinator/Youtube-Custom-Queue/
// @version 2.6.1
// @description A persistent, cross-tab YouTube queue manager with drag-to-reorder, auto-advance, and optional auto theater mode.
// @match *://*.youtube.com/*
// @grant none
// @run-at document-start
// ==/UserScript==

// Changelog moved to CHANGELOG.md (kept out of the script to reduce its
// size). See that file for the full per-version history.

/**
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
 *  Navigator      Single navigation entry point. Hijacks an SPA-wired anchor
 *                 (a.yt-simple-endpoint, preferring the mini-guide "Home"
 *                 entry), points it at the target via both href rewriting
 *                 and a yt-navigate endpoint mutation, then fakes a click.
 *                 Used by every navigation site in the script.
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

	// Single source of truth for the runtime version. Mirrors the @version
	// metadata at the top of this file; both must be bumped together. The
	// public API exposes this as window.ytQueueManager.version, and the boot
	// banner prints it so users can verify which build is actually running.
	const VERSION = '2.6.1';

	const STORAGE_KEY = 'yt_queue_manager_v1';
	const PLAYING_KEY = 'yt_queue_playing_tab';
	const HEARTBEAT_KEY = 'yt_queue_heartbeat';
	const SKIP_KEY = 'yt_queue_skip_signal';
	const STOP_KEY = 'yt_queue_stop_signal';
	const PREV_KEY = 'yt_queue_prev_signal';
	const SETTINGS_KEY = 'yt_queue_settings_v1';
	const DEBUG_KEY = 'ytqm_debug'; // localStorage flag, set to '1' to enable verbose logging
	const HEARTBEAT_INTERVAL_MS = 3000;
	const HEARTBEAT_TTL_MS = 10000;
	const VIDEO_END_THRESHOLD_S = 2;
	const RESTART_FROM_BEGINNING_SKIP_THRESHOLD_S = 3; // if already within this many seconds of 0, don't bother seeking
	const HISTORY_MAX = 50; // bumped from 10, the JSON cost is trivial and 10 is too small in practice
	const NAV_TIMEOUT_MS = 30000;
	const NAV_HREF_RESTORE_MS = 2000; // how long after click() before we restore the hijacked anchor's original href
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
	const REMOTE_STOP_PAUSE_DELAY_MS = 300; // let the paused frame render before teardown
	const SKIP_UNPLAYABLE_DELAY_MS = 200;   // rate-limit advancing through dead videos
	const OVERLAY_REPARENT_WATCH_MS = 15000; // stop watching for #video-preview after this long
	const PANEL_AUTOCLOSE_DELAY_MS = 3000; // panel auto-closes this long after the cursor leaves it

	// Thumbnail button colours, referenced from a single <style> sheet now,
	// not inline. Kept here as the source of truth so they stay in sync if
	// you want to tweak them at runtime.
	const THUMB_BTN_GREEN_RGB = '0,210,100';
	const THUMB_BTN_RED_RGB = '220,50,50';
	const THUMB_BTN_BLUE_RGB = '30,144,255';
	const THUMB_BTN_OPACITY = 0.8;

	const SETTINGS_DEFAULTS = {
		remoteControls: true,
		miniControls: true,
		theaterMode: false,
		blockContextMenu: true,
		mediaSessionRefresh: true,
		mediaSessionRefreshInterval: 5,
		hideNativeButtons: true,
		restartFromBeginning: false,
		enqueueFromPhone: false,
		phoneServerUrl: 'http://localhost/poll',
		keyboardShortcuts: true, // Alt+Q / Alt+N / Alt+P (see KeyboardShortcuts module)
		hideShorts: true,        // hide Shorts cards, shelves, and nav entries
		panelBlur: true,         // blur and fade the queue panel background
		hideInterruptionsBanner: true, // hide the "Experiencing interruptions?" bar
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

	const LOG_PREFIX = '[YT-Q]';

	// Verbose logging is opt-in. Enable from the console with:
	// localStorage.setItem('ytqm_debug', true|false); location.reload();
	// We cache the flag at boot to avoid hitting localStorage on every log call;
	// flip it at runtime via window.ytQueueManager.setDebug(true|false).
	let DEBUG = localStorage.getItem(DEBUG_KEY) === '1';

	function log(...args) {
		if (DEBUG) console.log(LOG_PREFIX, ...args);
	}

	// Warnings always print, they signal real problems devs need to see.
	function warn(...args) {
		console.warn(LOG_PREFIX, ...args);
	}

	// ── Firefox Xray-wrapper shims ────────────────────────────────────────────
	//
	// On Firefox, userscripts run in a separate JavaScript compartment from the
	// page (the "Xray vision" model). DOM elements you read from the page are
	// returned as XrayWrappers; assigning a userscript-compartment object as a
	// property on one of those (e.g. `anchor.data = {...}`) throws:
	//
	//   "Not allowed to define cross-origin object as property on
	//    [Object] or [Array] XrayWrapper"
	//
	// To write through an Xray wrapper we need two things:
	//   1. The object we're assigning has to live in the PAGE compartment.
	//      `cloneInto(obj, window)` performs a structured clone of `obj` into
	//      that compartment.
	//   2. We have to write through the wrapper's `wrappedJSObject` view,
	//      which is the unwrapped page-side reference to the same element.
	//
	// On Chromium there is no compartment split, both `cloneInto` and
	// `wrappedJSObject` are absent, so we provide pass-through shims. The
	// same call site (`pageCompatSet(anchor, 'data', payload)`) then works
	// identically on both browsers.

	const _cloneInto = (typeof cloneInto === 'function')
		? (obj) => cloneInto(obj, window, { cloneFunctions: false })
		: (obj) => obj; // Chromium: no compartment split, pass through

	/**
	 * Set a property on a DOM element in a way that works on both Firefox
	 * (XrayWrapper-aware) and Chromium (plain assignment).
	 *
	 * @param {Element} el     The DOM element (may be an XrayWrapper on FF).
	 * @param {string}  prop   Property name to set.
	 * @param {*}       value  Value to assign, will be cloneInto'd on FF.
	 */
	function pageCompatSet(el, prop, value) {
		const target = el.wrappedJSObject || el;
		target[prop] = _cloneInto(value);
	}

	/**
	 * Read a property from a DOM element in a way that pierces Firefox's
	 * Xray wrapper. Returns the page-compartment value (not a wrapper),
	 * which is what we want when stashing the original `.data` for restore.
	 */
	function pageCompatGet(el, prop) {
		const target = el.wrappedJSObject || el;
		return target[prop];
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
	 * URL). Handles both long-form watch URLs (?v=ID) and youtu.be short links
	 * (/ID). Returns null on parse failure or when no video ID is present.
	 * Centralised here so a future YouTube URL change only needs one fix.
	 */
	function getVideoId(url) {
		try {
			const u = new URL(url, location.origin);
			// youtu.be/VIDEO_ID short links - ID is in the pathname, not a query param
			if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
			return u.searchParams.get('v');
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
	// between read and write, without it, two tabs could simultaneously load
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
				// Coerce both arrays defensively. _rebuildSet maps over queue, so a
				// parseable-but-corrupt state missing queue would otherwise throw here,
				// get caught below, and wipe the user back to defaults (losing history
				// too). Guarding queue the same way history is guarded keeps whatever
				// salvageable state survived the corruption.
				if (!Array.isArray(p.queue)) p.queue = [];
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
		/** Quick membership probe, does NOT clone, do not mutate the result. */
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
		 * in the draggable list, no need to guard it here.
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
		if (e.key === PLAYING_KEY || e.key === HEARTBEAT_KEY) {
			UI.updateControls();
			UI.updateRemotePauseBtn();
		}
		if (e.key === SKIP_KEY && e.newValue !== null) Player._onRemoteSkip();
		if (e.key === STOP_KEY && e.newValue !== null) Player._onRemoteStop();
		if (e.key === PREV_KEY && e.newValue !== null) Player._onRemotePrev();
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
		// Memoise by full URL, `isWatchPage()` is called from many hot paths
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
	//
	// Single navigation entry point for the entire script. Every place that
	// wants to change which video the user is on calls Navigator.goTo(url).
	//
	// ── Why anchor-hijacking and not YouTube's internal API? ──────────────────
	//
	// The obvious alternative - calling YouTube's own router directly - was
	// investigated and ruled out for the following reasons:
	//
	// 1. THERE IS NO STABLE INTERNAL NAVIGATION FUNCTION.
	//
	//    YouTube's SPA is built on Polymer/LitElement. Its "router" is not a
	//    centrally exported `navigate(url)` function; it is an emergent behaviour
	//    of Polymer components reacting to `yt-navigate` DOM events and then
	//    updating each other through property bindings. The closest call-sites
	//    that look useful - things hanging off `window.yt`, module references
	//    buried in the `yt.config_` object, internal app-component references
	//    reachable via `document.querySelector('ytd-app')._getYtAppManager()` -
	//    are all implementation details that change silently with every YouTube
	//    A/B experiment rollout. Scripts relying on them break every few weeks.
	//
	// 2. DISPATCHING `yt-navigate` OURSELVES DOES NOT WORK RELIABLY.
	//
	//    `yt-navigate` looks like the right hook - it IS the event YouTube's
	//    internal Polymer handlers listen to. But:
	//    a) YouTube ignores or misroutes `yt-navigate` events that were not
	//       initiated by a trusted user action (a real click). The event's
	//       `isTrusted` property, the absence of a click ancestor in the event
	//       path, and various internal "is this a replay of a prior navigation"
	//       guards all gate whether the handlers fully run.
	//    b) The endpoint payload format expected by `yt-navigate.detail.endpoint`
	//       is undocumented, deeply nested, and varies by page type. Getting it
	//       wrong silently falls back to loading the home page or doing nothing.
	//    c) Even when it technically works, dispatching the event directly
	//       skips the throttling and deduplication logic YouTube runs before
	//       dispatching from a real click, which causes doubled navigations and
	//       broken history entries when navigating rapidly.
	//
	// 3. `history.pushState` ONLY CHANGES THE URL; IT DOES NOT LOAD ANYTHING.
	//
	//    YouTube intercepts pushState calls but only for its own internal
	//    navigations - ones it initiates itself. A userscript calling
	//    `history.pushState('/watch?v=X', ...)` updates the address bar and
	//    may trigger a `popstate`, but YouTube's watch-page components do not
	//    re-initialise in response. The user sees a URL change and nothing else.
	//
	// 4. ANCHOR-CLICKING IS THE PATH YOUTUBE TESTS AND MAINTAINS.
	//
	//    Every navigation a real user ever performs goes through a
	//    `yt-simple-endpoint` anchor click. YouTube has to keep that path
	//    working for their own UI; it is the most exercised and most stable
	//    code path in the entire frontend. By using it ourselves we inherit
	//    all of that stability. When YouTube's navigation code changes, it
	//    changes in a way that still makes their own links work - and ours.
	//
	// ── Why mutating `.data` and not just rewriting `href`? ───────────────────
	//
	//    `yt-simple-endpoint` anchors carry their navigation target as an
	//    endpoint object on the element's `.data` property, not in `href`.
	//    YouTube's Polymer click handler reads `this.data` synchronously on
	//    click and routes entirely from that; `href` is only a fallback for
	//    non-JavaScript / non-SPA environments. If you only rewrite `href` and
	//    leave `.data` pointing at the original video, the router follows `.data`
	//    and navigates to the original video anyway. Mutating `.data` IS the
	//    navigation-targeting mechanism, there is no `yt-navigate` event to
	//    intercept before that read happens.
	//
	// ── What happens if `.data` mutation fails? ────────────────────────────────
	//
	//    Three defence layers remain active:
	//      • The rewritten `href` causes a real (non-SPA) page load to the
	//        right URL, which is slower but correct.
	//      • The capture-phase `yt-navigate` listener (step 4 below) mutates
	//        the endpoint if YouTube does dispatch that event, catching code
	//        paths that ignore `.data` and build the endpoint from somewhere
	//        else.
	//      • A warn() is logged so the failure is visible without debug mode.
	//
	// ── Strategy summary ──────────────────────────────────────────────────────
	//
	// Hijack a YouTube SPA-wired anchor (an `a.yt-simple-endpoint`),
	// repoint it at our target video, and fake a click. Three layers of hijack
	// fire from one click; each is a defence in depth for a different YouTube
	// click-handling code path:
	//
	//   1. Save the anchor's original href.
	//   2. Rewrite href to the target watch URL, covers the case where the
	//      click triggers a real (non-SPA) navigation.
	//   3. PRIMARY: overwrite the anchor's `.data` property with a fresh
	//      watchEndpoint pointing at our target videoId. `yt-simple-endpoint`
	//      anchors carry their navigation target as an endpoint object on
	//      `.data`; YouTube's Polymer click handler reads that property
	//      synchronously when the user clicks and routes off it. Mutating
	//      `.data` IS the navigation-targeting mechanism, there is no
	//      `yt-navigate` event to intercept earlier than this read.
	//   4. FALLBACK: a one-shot, capture-phase `yt-navigate` listener that
	//      mutates the endpoint object in `e.detail.endpoint` if YouTube DOES
	//      end up dispatching that event (some code paths do). If the .data
	//      assignment from step 3 didn't take for some reason, this catches
	//      it on the way out.
	//   5. anchor.click().
	//   6. After NAV_HREF_RESTORE_MS, restore the anchor's original href and
	//      `.data`, and remove the yt-navigate handler. If the click did
	//      trigger a hard nav, the page is gone by then and the cleanup is a
	//      no-op.
	//
	// Anchor selection (preference order, see _findAnchor):
	//   1. The "Home" entry in the mini-guide (`<a id="endpoint" href="/">`
	//      with class `yt-simple-endpoint`). Always present, always SPA-wired,
	//      and its href is the stable, harmless "/", so the brief window
	//      between hijack and href-restore can't accidentally point a real
	//      click at something weird.
	//   2. Any other guide-entry anchor (mini-guide or full guide).
	//   3. Any `a.yt-simple-endpoint` with an href.
	//   4. Last resort: any `<a>` at all.
	//
	// Why not "the first <a> on the page": that anchor is almost always a
	// video-card lockup, which is `rel="nofollow"`, NOT carrying the
	// `yt-simple-endpoint` class, and NOT wired into YouTube's SPA router.
	// It has no `.data` property to mutate and no `yt-navigate` to intercept,
	// clicking it is essentially a no-op. Targeting `yt-simple-endpoint`
	// gives us the actual SPA-router-wired path.

	const Navigator = {
		/**
		 * Tiered list of anchor selectors. Each tier has a human-readable label
		 * (used in logs to explain *why* a particular anchor was picked) and a
		 * CSS selector. The first tier that returns a match wins.
		 *
		 * Kept as data rather than nested `||` so logs can show which tier
		 * matched without re-running the queries.
		 */
		_ANCHOR_TIERS: [
			// The mini-guide Home entry, first choice. The full attribute match
			// here is intentionally specific so we don't grab some other random
			// `id="endpoint"` that ended up SPA-routing somewhere unexpected.
			['mini-guide Home',           'a.yt-simple-endpoint#endpoint[href="/"]'],
			// Any guide entry, mini or full. Both reliably SPA-route.
			['mini-guide entry',          'ytd-mini-guide-entry-renderer a.yt-simple-endpoint[href]'],
			['full guide entry',          'ytd-guide-entry-renderer a.yt-simple-endpoint[href]'],
			// Any other SPA-wired anchor. Excludes plain video-card lockups
			// (those don't carry the yt-simple-endpoint class).
			['any yt-simple-endpoint',    'a.yt-simple-endpoint[href]'],
			// Absolute last resort, better than throwing, but unlikely to
			// SPA-navigate. The href fallback may still rescue this case.
			['fallback: any anchor',      'a[href]'],
		],

		/**
		 * Find a YouTube SPA-routed anchor to hijack. See the block comment
		 * above and `_ANCHOR_TIERS` for the preference order and reasoning.
		 *
		 * Returns `{ anchor, reason, selector }` for the first matching tier,
		 * or null if NOTHING on the page matches, which would be very
		 * unusual on a rendered YouTube page.
		 */
		_findAnchor() {
			for (const [reason, selector] of this._ANCHOR_TIERS) {
				const anchor = document.querySelector(selector);
				if (anchor) return { anchor, reason, selector };
			}
			return null;
		},

		/**
		 * Compact, log-friendly description of an anchor: tag, id, classes,
		 * href, and any human-readable hints (aria-label, title). Returned as
		 * a plain object so devtools renders it as an expandable tree rather
		 * than a wall of string.
		 */
		_describeAnchor(anchor) {
			const cls = anchor.className || '';
			return {
				tag: anchor.tagName,
				id: anchor.id || null,
				classes: cls ? cls.split(/\s+/).filter(Boolean).slice(0, 6) : null,
				href: anchor.getAttribute('href'),
				ariaLabel: anchor.getAttribute('aria-label'),
				title: anchor.getAttribute('title'),
			};
		},

		/**
		 * Compact, log-friendly summary of a YouTube endpoint object. Endpoint
		 * payloads are large and tracking-blob-heavy; this picks out only the
		 * fields useful for understanding *what* the endpoint navigates to.
		 */
		_summarizeEndpoint(ep) {
			if (ep == null) return ep;
			if (typeof ep !== 'object') return ep;
			const types = Object.keys(ep).filter(k => k.endsWith('Endpoint') || k.endsWith('endpoint'));
			const out = { _types: types };
			if (ep.watchEndpoint?.videoId) out.videoId = ep.watchEndpoint.videoId;
			if (ep.watchEndpoint?.playlistId) out.playlistId = ep.watchEndpoint.playlistId;
			if (ep.browseEndpoint?.browseId) out.browseId = ep.browseEndpoint.browseId;
			if (ep.urlEndpoint?.url) out.urlEndpoint = ep.urlEndpoint.url;
			if (ep.commandMetadata?.webCommandMetadata?.url) out.metadataUrl = ep.commandMetadata.webCommandMetadata.url;
			if (ep.commandMetadata?.webCommandMetadata?.webPageType) out.webPageType = ep.commandMetadata.webCommandMetadata.webPageType;
			return out;
		},

		goTo(url) {
			const parsed = new URL(url, location.origin);
			const navPath = parsed.pathname + parsed.search;
			const expectedId = parsed.searchParams.get('v');

			log('goTo() called, target =', url, '(navPath:', navPath, ', expectedId:', expectedId + ')');

			// Hard guard: if the target URL has no `v=` param there is nothing
			// to navigate to. Without this, the endpoint mutation below would
			// happily set `videoId = null` and break the SPA navigation.
			if (!expectedId) {
				warn('Navigator.goTo: no video ID in', url);
				return;
			}

			const found = this._findAnchor();
			if (!found) {
				// Should be effectively impossible on any rendered YouTube page,
				// but if there really is no anchor at all there is nothing to
				// hijack, the "anchor click only" contract has no escape hatch.
				warn('Navigator.goTo: no SPA anchor (or any <a>) found, cannot navigate to', expectedId);
				UI.showStatus('No link found on page to navigate with', 4000);
				return;
			}

			const { anchor, reason, selector } = found;

			// Loud warning if we landed on the last-resort tier, those anchors
			// are NOT SPA-wired so navigation will likely fail. Promote this
			// to warn() (always prints) instead of log() (debug-only) so the
			// user sees it without needing to enable debug mode first.
			if (reason.startsWith('fallback')) {
				warn('Navigator.goTo: had to fall back to a non-SPA anchor, navigation may fail or hard-reload');
			}

			log('Picked anchor:', { reason, selector, anchor: this._describeAnchor(anchor) });
			log('Anchor before hijack: .data =', this._summarizeEndpoint(pageCompatGet(anchor, 'data')));

			// The watch-endpoint payload we want YouTube's SPA router to follow.
			// `webPageType` is what tells the router to render the watch page chrome
			// rather than treating us as a browse/search/etc. The `rootVe` value is
			// YouTube's visual-element ID for watch pages, it doesn't matter much
			// for navigation but matches what real watch endpoints carry, so it
			// keeps the payload "well-formed" by YouTube's standards.
			const newEndpoint = {
				commandMetadata: {
					webCommandMetadata: {
						url: navPath,
						webPageType: 'WEB_PAGE_TYPE_WATCH',
						rootVe: 3832,
					},
				},
				watchEndpoint: { videoId: expectedId },
			};

			log('Installing new .data:', this._summarizeEndpoint(newEndpoint));

			// (1) Save the anchor's original href and (2) rewrite to the target.
			// This is the safety net for non-SPA / hard-nav fallbacks.
			const originalHref = anchor.getAttribute('href');
			anchor.setAttribute('href', navPath);
			log('href hijacked:', originalHref, '→', navPath);

			// (3) PRIMARY hijack: overwrite the anchor's `.data` property.
			//
			// `yt-simple-endpoint` anchors carry their navigation target as an
			// endpoint object on the element's `.data` property. YouTube's Polymer
			// click handler reads `this.data` directly when the user clicks and
			// routes off that, it does NOT dispatch a `yt-navigate` event we can
			// intercept synchronously before the routing decision is made.
			//
			// In other words: mutating `.data` IS the navigation-targeting
			// mechanism. Setting it before the click is the canonical way to
			// "redirect" a yt-simple-endpoint click.
			//
			// On Firefox we have to go through pageCompatSet, which uses
			// `wrappedJSObject` + `cloneInto` to cross the Xray boundary. On
			// Chromium it's a plain assignment. The same call works in both.
			//
			// The `__ytqm_…` shadow vars stash the originals so cleanup can put
			// them back; we use unique names to avoid stomping anything else.
			const hadData = 'data' in anchor;
			anchor.__ytqm_origData = pageCompatGet(anchor, 'data');
			anchor.__ytqm_hadData = hadData;
			let dataSetOk = false;
			try {
				pageCompatSet(anchor, 'data', newEndpoint);
				dataSetOk = true;
			} catch (e) {
				warn('Navigator.goTo: could not set anchor.data -', e);
			}
			if (dataSetOk) {
				// Read it back so we can confirm the assignment actually stuck -
				// useful when something silently coerces or rejects the write.
				log('.data hijack OK, readback:', this._summarizeEndpoint(pageCompatGet(anchor, 'data')));
			}

			// (4) Fallback hijack: yt-navigate listener.
			//
			// On some YouTube code paths a `yt-navigate` event IS dispatched with
			// the endpoint in `e.detail.endpoint`, and mutating that object before
			// it propagates further can also redirect navigation. We keep this as
			// belt-and-suspenders in case the .data assignment above doesn't take
			// (e.g., on an older YouTube layout where the property is read-only,
			// or where some other element handles the click).
			let mutated = false;
			const handler = e => {
				if (!e.detail?.endpoint) return;
				const ep = e.detail.endpoint;
				if (!mutated) {
					log('yt-navigate fired, incoming endpoint:', this._summarizeEndpoint(ep));
					if (ep.watchEndpoint) {
						ep.watchEndpoint.videoId = expectedId;
					} else {
						Object.keys(ep).forEach(k => {
							if (k.endsWith('Endpoint') || k.endsWith('endpoint')) delete ep[k];
						});
						ep.watchEndpoint = { videoId: expectedId };
					}
					if (ep.commandMetadata?.webCommandMetadata) ep.commandMetadata.webCommandMetadata.url = navPath;
					ep.clickTrackingParams = '';
					mutated = true;
					log('yt-navigate endpoint mutated to:', this._summarizeEndpoint(ep));
				} else {
					log('Blocking duplicate yt-navigate for', ep.watchEndpoint?.videoId);
					e.stopImmediatePropagation();
					e.preventDefault();
				}
			};
			window.addEventListener('yt-navigate', handler, { capture: true });

			// (5) Cleanup: restore .data and href, remove the listener.
			// If the click triggered a hard nav, this document is already gone
			// by the time the timer fires, the closure is harmlessly torn
			// down with the page.
			setTimeout(() => {
				log('Cleanup timer fired, restoring anchor href and .data');
				window.removeEventListener('yt-navigate', handler, { capture: true });
				if (originalHref !== null) anchor.setAttribute('href', originalHref);
				else anchor.removeAttribute('href');
				try {
					if (anchor.__ytqm_hadData) pageCompatSet(anchor, 'data', anchor.__ytqm_origData);
				} catch {}
				delete anchor.__ytqm_origData;
				delete anchor.__ytqm_hadData;
				if (!mutated) {
					// We never observed a yt-navigate event. That's normal when
					// the .data hijack alone was enough to redirect the click,
					// but if navigation also failed it's a useful clue.
					log('Cleanup: no yt-navigate event was observed during this navigation');
				}
			}, NAV_HREF_RESTORE_MS);

			// (6) Fake the click.
			log('Dispatching click() on hijacked anchor');
			anchor.click();
		},
	};

	// ── Player ────────────────────────────────────────────────────────────────

	const Player = {
		_playing: false,
		_userPaused: false,
		_navigatingToPrev: false,
		_advancing: false,              // true between advance() and the next video attaching
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
			this._advancing = false; // fresh session, clear any stale guards
			this._navigatingToPrev = false;
			PlayingTab.claim();
			Storage.setPaused(false);
			Storage.setPlaying(true);
			const first = Storage.peekFirst();
			if (!first) {
				log('start(), queue is empty, stopping immediately');
				this.stop();
				return;
			}
			log('start(), queue head:', first.title, '(', getVideoId(first.url), '), total queue length:', Storage.queue.length);
			UI.updateControls();
			if (UI.panelOpen) UI.refreshPanel();
			const currentId = getVideoId(location.href);
			const expectedId = getVideoId(first.url);
			if (!expectedId) {
				warn('Player.start: queue head has invalid URL', first.url);
				this.stop();
				return;
			}
			if (currentId === expectedId) {
				log('Already on the correct page, attaching directly');
				this._waitForVideoAndPlay();
			} else {
				Navigator.goTo(first.url);
				// Same reasoning as advance()/previous(): don't rely solely on
				// yt-navigate-finish to arm the attach poll/timeout.
				this._waitForVideoAndPlay();
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
			// Cancel any pending _waitForVideo timers. Without this, a
			// fallbackTimer that was scheduled before stop() would still fire
			// NAV_TIMEOUT_MS later and call _skipUnplayable, which advances the
			// queue and calls Navigator.goTo on the next entry, even though
			// _playing is now false. The result is the queue spontaneously
			// "resuming" with the next video roughly 30s after the user
			// stopped it.
			if (this._waitForVideoHandles) {
				clearInterval(this._waitForVideoHandles.pollTimer);
				clearTimeout(this._waitForVideoHandles.earlyUnavailableTimer);
				clearTimeout(this._waitForVideoHandles.fallbackTimer);
				this._waitForVideoHandles.pollTimer = null;
				this._waitForVideoHandles.earlyUnavailableTimer = null;
				this._waitForVideoHandles.fallbackTimer = null;
			}
			this._playing = false;
			this._userPaused = false;
			this._advancing = false;
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
			if (UI.panelOpen) UI.refreshPanel();
			UI.showStatus('Queue stopped');
		},

		remotePause() {
			log('remotePause()');
			Storage.setPaused(true);
			UI.updateRemotePauseBtn();
		},
		remoteResume() {
			log('remoteResume()');
			Storage.setPaused(false);
			UI.updateRemotePauseBtn();
		},

		remoteSkip() {
			log('remoteSkip(), playing locally?', this._playing);
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

		remotePrev() {
			log('remotePrev(), playing locally?', this._playing);
			if (this._playing) {
				this.previous();
				return;
			}
			localStorage.setItem(PREV_KEY, Date.now().toString());
		},

		_onRemotePrev() {
			if (!this._playing) return;
			log('Remote prev received');
			localStorage.removeItem(PREV_KEY);
			this.previous();
		},

		_onRemoteStop() {
			if (!this._playing) return;
			log('Remote stop received, pausing before stop');
			localStorage.removeItem(STOP_KEY);
			// Pause the video visibly first so the user on this tab sees
			// playback halt before the UI tears down. The 300ms gives the
			// browser one frame to render the paused state before stop()
			// removes the player listeners and clears the queue controls.
			const video = document.querySelector('video');
			if (video && !video.paused && !video.ended) {
				video.pause();
				setTimeout(() => this.stop(), REMOTE_STOP_PAUSE_DELAY_MS);
			} else {
				this.stop();
			}
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

		/**
		 * True while YouTube is playing an ad. Ads run through the SAME <video>
		 * element as the content, so the element fires `ended` when the ad
		 * finishes and `duration` reports the ad's length while it runs. Without
		 * this check, every pre-roll and mid-roll advanced the queue.
		 * YouTube marks the player element with `ad-showing` / `ad-interrupting`
		 * for the whole ad break; the overlay probe is a fallback for layouts
		 * that drop the classes.
		 */
		_isAdPlaying() {
			const p = document.querySelector(SEL.PLAYER);
			if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) return true;
			return !!document.querySelector('.video-ads .ytp-ad-player-overlay, .ytp-ad-module .ytp-ad-player-overlay-layout');
		},

		/**
		 * True when the player is actually showing the queue head. Guards against
		 * end signals arriving from a stale/reused element after the URL has
		 * already moved on.
		 */
		_isCurrentQueueVideo() {
			const head = Storage.peekFirst();
			const expected = head ? getVideoId(head.url) : null;
			if (!expected) return true;
			if (getVideoId(location.href) !== expected) return false;
			const p = document.querySelector('#movie_player');
			const id = (typeof p?.getVideoData === 'function') ? p.getVideoData()?.video_id : null;
			return !id || id === expected;
		},

		/** Single gate for every "the video ended, advance" code path. */
		_shouldAdvanceOnEnd() {
			if (this._isAdPlaying()) {
				log('End signal received during an ad, ignoring');
				return false;
			}
			if (!this._isCurrentQueueVideo()) {
				log('End signal for a video that is not the queue head, ignoring');
				return false;
			}
			return true;
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
				// Only advance on video.ended. The remaining <= VIDEO_END_THRESHOLD_S
				// early-fire check was removed here for the same reason it was removed
				// from the timeupdate handler in 2.3.2: it caused the queue to advance
				// while the video still had up to 2 seconds left. video.ended is set by
				// the browser even on paths that drop the ended event, so the safety-net
				// goal is preserved with a worst-case lag of one poll tick (~1 s).
				if (video.ended) {
					if (!this._shouldAdvanceOnEnd()) {
						this._endPollTimer = setTimeout(check, 1000);
						return;
					}
					log('End poll: video.ended, advancing queue');
					this._userPaused = false;
					Storage.setPaused(false);
					this.advance();
				} else {
					const remaining = video.duration - video.currentTime;
					if (!isNaN(remaining) && remaining > 30) {
						this._endPollTimer = setTimeout(check, (remaining - 28) * 1000);
					} else {
						this._endPollTimer = setTimeout(check, 1000);
					}
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
					warn('Video unavailable, skipping to next in queue');
					UI.showStatus('Video unavailable, skipping…', 3000);
					this._skipUnplayable();
					return;
				}
				const video = document.querySelector('video');
				if (video) this._onVideoReady(video, first);
				else {
					warn('No <video> after resolve, skipping to next');
					this._skipUnplayable();
				}
			};

			if (tryAttach()) {
				onResolve();
				return;
			}

			let resolved = false;
			// Stash these on the instance so Player.stop() can cancel them.
			// Before this, a navigation that started, then was stopped by the
			// user (manual stop, or stop from a different control path) left
			// the poll + fallback + early-unavailable timers running. NAV_TIMEOUT_MS
			// later, _skipUnplayable would fire and forcibly advance the queue
			// even though the queue was no longer "playing", giving the user
			// the impression the queue had restarted itself.
			this._waitForVideoHandles = this._waitForVideoHandles || {};
			const handles = this._waitForVideoHandles;
			const clearAll = () => {
				clearInterval(handles.pollTimer);
				clearTimeout(handles.earlyUnavailableTimer);
				clearTimeout(handles.fallbackTimer);
				handles.pollTimer = handles.earlyUnavailableTimer = handles.fallbackTimer = null;
			};
			// Make sure we don't leak handles from a prior _waitForVideo call
			// that overlapped with this one (rapid navigations).
			clearAll();

			handles.pollTimer = setInterval(() => {
				if (!this._playing) { clearAll(); return; }
				if (!tryAttach()) return;
				clearAll();
				if (resolved) return;
				resolved = true;
				onResolve();
			}, ATTACH_POLL_INTERVAL_MS);

			// Even if `.ytp-error` never renders (some "unavailable" paths just
			// silently skip the <video> element), give YouTube a brief grace
			// period and then advance rather than stalling for the full
			// NAV_TIMEOUT_MS. Only triggers when we DO have a next video to fall
			// through to, otherwise let the long fallback run.
			handles.earlyUnavailableTimer = setTimeout(() => {
				if (resolved) return;
				if (!this._playing) { clearAll(); return; }
				if (getVideoId(location.href) !== expectedId) return;
				if (document.querySelector('video')) return; // <video> exists, just not ready yet
				if (Storage.queue.length <= 1) return;       // nothing to fall through to
				resolved = true;
				clearAll();
				warn('No <video> element after grace period, assuming unavailable');
				UI.showStatus('Video unavailable, skipping…', 3000);
				this._skipUnplayable();
			}, UNAVAILABLE_CHECK_DELAY_MS);

			handles.fallbackTimer = setTimeout(() => {
				clearAll();
				if (resolved) return;
				// Queue might have been stopped while we were waiting, don't
				// resurrect it by skipping to the "next" video. See clearAll()
				// rationale at top of this block.
				if (!this._playing) return;
				resolved = true;
				warn('Timed out waiting for <video> after', NAV_TIMEOUT_MS, 'ms');
				// Try to keep going, only stop if there's truly nothing left.
				if (Storage.queue.length > 1) {
					UI.showStatus('Video failed to load, skipping…', 3000);
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
		 *
		 * Aborts if _playing went false between the failed-to-load detection
		 * and this call (e.g. user pressed stop, or another control path
		 * cleared the queue). Belt-and-braces, the _waitForVideo timers also
		 * check _playing before getting here.
		 */
		_skipUnplayable() {
			if (!this._playing) return;
			// This resolves a navigation attempt (forward OR backward - an
			// unavailable "previous" video falls through here too), so clear
			// both in-flight flags. Leaving either one stuck true would keep
			// _navInFlight() true forever and silently block every future
			// skip/previous press.
			this._advancing = false;
			this._navigatingToPrev = false;
			Storage.shiftQueue(); // drop the failed entry without writing history
			this._attachedVideoId = null;
			this._detachVideoListeners();
			this._clearEndPoll(); // same rationale as advance(), see comment there
			UI.refreshPanel();
			const next = Storage.peekFirst();
			if (next) {
				setTimeout(() => {
					// Re-check, the delay is a window during which the
					// user could stop the queue. Without this guard, a manual
					// stop during the gap would still see a Navigator.goTo
					// fire and visibly land on the "next" video.
					if (!this._playing) return;
					Navigator.goTo(next.url);
				}, SKIP_UNPLAYABLE_DELAY_MS);
			} else {
				this.stop();
			}
		},

		_onVideoReady(video, queueItem) {
			// The new video has attached, so any in-flight advance has fully landed.
			// Clearing the guard here re-enables the next advance()/skip; it brackets
			// the race window opened in advance().
			this._advancing = false;
			const videoId = new URLSearchParams(location.search).get('v');
			if (videoId && videoId === this._attachedVideoId) {
				log('_onVideoReady: already attached for', videoId, ', skipping');
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
			const whenReady = (fn) => {
				if (video.readyState >= 3) fn();
				else video.addEventListener('canplay', fn, {
					once: true
				});
			};

			if (!restartFromBeginning) {
				// Default behaviour: lean entirely on YouTube for the start
				// position. We only call play() so the queue auto-advances; we
				// deliberately never touch currentTime / seekTo here, so a video
				// you've watched before resumes at YouTube's saved timestamp,
				// exactly as it would without this script.
				// Do NOT pause here, calling video.pause() while YouTube is still
				// initialising its player causes YouTube to show an error screen.
				whenReady(play);
				return;
			}

			// Restart-from-beginning is fragile to do via video.currentTime = 0:
			// YouTube resumes previously-watched videos at the saved timestamp by
			// issuing its OWN seek during player init, and that seek frequently
			// lands AFTER ours, clobbering it so the video plays from the middle.
			// Writing the bare <video>.currentTime is also unreliable because
			// YouTube drives playback through its MSE player, not the element.
			//
			// Fix: seek through the player API (#movie_player.seekTo) which is the
			// player's own source of truth, and reassert it a few times over the
			// first ~1.2s to win the race against YouTube's resume seek. We stop
			// reasserting as soon as playback is at/near the start, or after the
			// attempt budget is spent, so we never fight a deliberate user seek
			// made after playback has settled.
			const player = document.querySelector('#movie_player');
			const canApi = player && typeof player.seekTo === 'function';

			const seekToStart = () => {
				if (canApi) player.seekTo(0, true);
				else video.currentTime = 0; // last-resort fallback
			};

			const readTime = () => (canApi && typeof player.getCurrentTime === 'function')
				? player.getCurrentTime()
				: video.currentTime;

			// If the video is already within the first few seconds, there's
			// nothing meaningful to restart. Skip the seek/reassert dance
			// entirely and just let it play, rather than fighting YouTube's
			// own init seek for a video that's already effectively at the
			// start.
			const startT = readTime();
			if (!isNaN(startT) && startT <= RESTART_FROM_BEGINNING_SKIP_THRESHOLD_S) {
				log('Restart-from-beginning: already at', startT, 's (<=', RESTART_FROM_BEGINNING_SKIP_THRESHOLD_S, 's), leaving position as-is');
				whenReady(play);
				return;
			}

			whenReady(() => {
				seekToStart();
				play();

				let attempts = 0;
				const MAX_ATTEMPTS = 6;      // ~1.2s at 200ms spacing
				const REASSERT_MS = 200;
				const JUMP_TOLERANCE_S = 1.0; // slack for timer jitter and decode lag

				let lastT = readTime();
				let lastWall = Date.now();

				// Only undo DISCONTINUOUS forward jumps. Normal playback advances
				// currentTime at ~1x wall clock, so a delta meaningfully larger than
				// the elapsed real time is YouTube's resume seek and gets pulled back.
				// The previous version compared currentTime against a fixed 1.5s
				// threshold, which meant a single late tick during ordinary playback
				// from 0 looked identical to a resume seek and bounced the video back
				// to the start about a second in.
				const reassert = () => {
					if (!this._playing || video.ended) return;
					if (++attempts > MAX_ATTEMPTS) return;
					const t = readTime();
					const wall = Date.now();
					const elapsed = (wall - lastWall) / 1000;
					if (!isNaN(t) && (t - lastT) > elapsed + JUMP_TOLERANCE_S) {
						log('Resume-seek detected (', lastT, '->', t, '), pulling back to 0');
						seekToStart();
						lastT = 0;
					} else {
						lastT = t;
					}
					lastWall = wall;
					setTimeout(reassert, REASSERT_MS);
				};
				setTimeout(reassert, REASSERT_MS);
			});
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
				// Ad breaks pause the content video. Recording that as a manual
				// pause left _userPaused stuck true and stalled the queue.
				if (this._isAdPlaying()) {
					log('Pause during ad, ignoring');
					return;
				}
				if (Date.now() - (video._ytqmAttachedAt || 0) < 3000) {
					log('Ignoring early pause event');
					return;
				}
				// Skipping/scrubbing (arrow keys, seek bar, YouTube's own
				// shortcuts) right to the end of a video often stops playback
				// a fraction of a second short of the true duration, so
				// video.ended never flips to true even though there is
				// nothing left to watch. Left uncaught, that pause gets
				// misread as a manual pause below and the queue stalls.
				// Treat "paused within VIDEO_END_THRESHOLD_S of the end" as
				// end-of-video so the queue still advances.
				if (!isNaN(video.duration)
					&& (video.duration - video.currentTime) <= VIDEO_END_THRESHOLD_S
					&& this._shouldAdvanceOnEnd()) {
					log('Paused near end of video (skip/seek), treating as ended, advancing queue');
					this._userPaused = false;
					Storage.setPaused(false);
					UI.showStatus('Advancing queue...');
					this.advance();
					return;
				}
				this._userPaused = true;
				log('Video paused by user');
				UI.showStatus('Paused', 99999);
				// Sync the shared paused flag and our own button so a pause made
				// via YouTube's own controls (spacebar, click-to-pause, etc.)
				// is reflected the same way a pause via our controls would be.
				// Storage.setPaused is a no-op past its own dedupe if remotePause()
				// already set this, and writes here don't loop back through
				// _onPauseStorageChange since same-tab storage writes don't fire
				// the 'storage' event.
				if (!Storage.paused) Storage.setPaused(true);
				UI.updateRemotePauseBtn();
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
				// Mirror the pause-side sync: playback resumed via YouTube's own
				// controls should clear the shared paused flag and update our
				// button too, not just a resume triggered from our controls.
				if (Storage.paused) Storage.setPaused(false);
				UI.updateRemotePauseBtn();
			}, {
				signal
			});

			video.addEventListener('ended', () => {
				if (!this._playing) return;
				if (!this._shouldAdvanceOnEnd()) return;
				log('ended event: advancing queue');
				this._userPaused = false;
				Storage.setPaused(false);
				UI.showStatus('Advancing queue…');
				this.advance();
			}, {
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
			//
			// NOTE: we only advance when video.ended is true here. We deliberately
			// do NOT use the VIDEO_END_THRESHOLD_S early-fire check in this handler;
			// that caused the queue to visibly navigate away while the video still
			// had up to 2 seconds remaining. _scheduleEndPoll retains the threshold
			// as a fallback for YouTube paths that swallow the ended event entirely.
			video.addEventListener('timeupdate', () => {
				if (!this._playing || Storage.paused) return;
				if (isNaN(video.duration)) return;
				// During an ad, video.duration is the AD's duration, so the
				// remaining-time shortcut below measures the wrong clip entirely.
				if (this._isAdPlaying()) return;
				const remaining = video.duration - video.currentTime;
				if (remaining > 5) return;
				if (video.ended) {
					if (!this._shouldAdvanceOnEnd()) return;
					log('timeupdate: video.ended, advancing');
					this._userPaused = false;
					Storage.setPaused(false);
					this.advance();
				}
			}, {
				signal
			});
		},

		// True while ANY queue navigation (forward via advance()/skip, or
		// backward via previous()) is in flight. Both directions share this
		// check - previously advance() only looked at _advancing and
		// previous() only looked at _navigatingToPrev, so a skip could
		// interrupt an in-flight previous() (and vice versa) by kicking off
		// a second Navigator.goTo before the first one's navigation had
		// resolved. YouTube's SPA nav can only really have one navigation
		// in flight at a time; overlapping ones raced, and whichever one
		// lost meant nothing ever called _onVideoReady/_skipUnplayable for
		// it - leaving its guard flag stuck true forever and silently
		// swallowing every later skip/previous press ("navigation already
		// in flight, ignoring duplicate call", forever). Rapid alternating
		// previous/next/previous/next was the easiest way to hit this,
		// since each direction only ever checked its own flag.
		_navInFlight() {
			return this._advancing || this._navigatingToPrev;
		},

		advance() {
			// Reentrancy guard. The three end-detection paths (timeupdate, the ended
			// event, and the end-poll timer) plus the manual skip controls can each
			// call advance() in separate tasks. Because _playing stays true and the
			// next video's listeners don't attach until navigation settles, two calls
			// in that window would each shiftQueue and skip a video the user never saw.
			// Also bails if a previous() is still in flight, see _navInFlight().
			// The guard is released in _onVideoReady (next video attached), in
			// _skipUnplayable (failed-load path), and in stop(). Fast skip presses
			// therefore advance one item at a time.
			if (this._navInFlight()) {
				log('advance(): navigation already in flight, ignoring duplicate call');
				return;
			}
			this._advancing = true;
			const current = Storage.shiftQueue();
			if (current) Storage.pushHistory(current);
			const next = Storage.peekFirst();
			log('advance(), leaving:', current?.title || '(none)', '→ next:', next?.title || '(end of queue)');
			this._attachedVideoId = null;
			this._navigatingToPrev = false;
			this._detachVideoListeners();
			// Also kill any pending end-poll timer from the video we're leaving.
			// _detachVideoListeners only kills event-listener-driven handlers;
			// _scheduleEndPoll uses setTimeout and is invisible to the
			// AbortController. Without this, the OLD video's endpoll can fire
			// between this call and the new video's _attachVideoListeners
			// (which would normally clear it via _scheduleEndPoll → _clearEndPoll),
			// and `video.ended` is still true on the reused <video> element, so
			// the orphan timer calls advance() AGAIN - silently skipping the
			// next entry in the queue without it ever being played.
			this._clearEndPoll();
			UI.refreshPanel();
			if (next) {
				Navigator.goTo(next.url);
				// Don't rely solely on the global yt-navigate-finish listener to
				// eventually call _waitForVideoAndPlay() for us. That event is
				// NOT guaranteed to fire for every navigation path (see the
				// Navigator module's comments on how unreliable YouTube's own
				// nav events are) - and when it doesn't fire, nothing else ever
				// arms _waitForVideoAndPlay()'s poll/timeout logic for this
				// advance, so _advancing stays true forever and every later
				// skip/previous silently no-ops. Calling it directly here
				// guarantees a timeout-bounded resolution regardless of
				// whether the browser-level event ever arrives. It's safe to
				// call even if yt-navigate-finish ALSO fires later:
				// _waitForVideoAndPlay() clears/re-arms its own timers each
				// call, and once _onVideoReady has already resolved this
				// navigation it's a harmless no-op (attach-poll would find
				// the same already-attached video and return early).
				this._waitForVideoAndPlay();
			} else {
				this.stop();
			}
		},

		skip() {
			log('skip(), playing?', this._playing);
			if (this._playing) this.advance();
		},

		/**
		 * Re-navigate to the front of the queue (or to `url` if provided),
		 * keeping the queue alive.
		 *
		 * Behavioural change in 2.1.0: this now SPA-navigates via Navigator.goTo
		 * just like every other call site in the script, instead of doing a
		 * hard reload via location.href / location.reload(). The boot-recovery
		 * path in tryInit() still fires after a manual page refresh, so the
		 * queue still survives an explicit Ctrl+R, we just no longer trigger
		 * one ourselves. The "reload" in the name is now a misnomer kept for
		 * API stability.
		 *
		 * If `url` points to a YouTube video that is NOT already at the front
		 * of the queue, it is spliced in at position 0 so it becomes the next
		 * thing that plays.
		 *
		 * @param {string} [url] - Optional YouTube watch URL or bare video ID.
		 *   Pass undefined / omit to re-navigate to whatever is currently at
		 *   the front of the queue.
		 */
		reloadAndResume(url) {
			// Resolve a bare video ID ("dQw4w9WgXcQ") to a full watch URL.
			let targetUrl = url;
			if (targetUrl && !targetUrl.includes('/')) {
				targetUrl = watchUrl(targetUrl);
			}

			const targetId = targetUrl ? getVideoId(targetUrl) : null;
			if (targetUrl && !targetId) warn('reloadAndResume: could not parse URL', targetUrl);

			// Ensure the target video is at queue[0] so playback lands on it.
			if (targetId) {
				Storage.mutate(s => {
					const existingIdx = s.queue.findIndex(v => getVideoId(v.url) === targetId);
					if (existingIdx > 0) {
						// Already in queue but not at the front, move it to position 0.
						const [item] = s.queue.splice(existingIdx, 1);
						s.queue.unshift(item);
					} else if (existingIdx === -1) {
						// Not in queue at all, insert it at position 0.
						s.queue.unshift({
							url: watchUrl(targetId),
							title: targetId,
							channel: '',
							id: _uid()
						});
					}
					// existingIdx === 0 means it is already at the front, nothing to do.
				});
			}

			// Stamp playing=true so a manual refresh of the page would be
			// recovered by tryInit(). We don't trigger one ourselves anymore.
			Storage.setPlaying(true);

			// Decide where to navigate. If a target was given, go there.
			// Otherwise, navigate to the head of the queue.
			let dest = targetId ? watchUrl(targetId) : null;
			if (!dest) {
				const head = Storage.peekFirst();
				if (!head) {
					warn('reloadAndResume: queue is empty and no URL given, nothing to do');
					return;
				}
				dest = head.url;
			}

			// Already on the destination? Just (re)attach the player without
			// triggering a navigation. This is the case where the old code
			// would have done a hard reload, we deliberately do NOT anymore.
			if (getVideoId(location.href) === getVideoId(dest)) {
				log('reloadAndResume: already on', dest, '- attaching without navigation');
				if (!this._playing) this.start();
				else this._waitForVideoAndPlay();
				return;
			}

			log('reloadAndResume: SPA navigating to', dest);

			// Same anchor-hijack path as every other navigation in the script.
			Navigator.goTo(dest);

			// Make sure the player attaches once the SPA navigation lands.
			// yt-navigate-finish is NOT guaranteed to fire for every
			// navigation path, so don't rely on it alone (same reasoning as
			// advance()/previous()/start()). start() covers this when we
			// weren't already playing; otherwise arm it directly here.
			if (!this._playing) this.start();
			else this._waitForVideoAndPlay();
		},

		previous() {
			if (!this._playing) return;
			if (this._navInFlight()) {
				log('previous(): navigation already in flight, ignoring');
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
			// Same reasoning as in advance(): don't wait on yt-navigate-finish
			// alone to arm the attach poll/timeout. Without this, a "previous"
			// navigation that the event never fires for leaves
			// _navigatingToPrev stuck true forever.
			this._waitForVideoAndPlay();
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
			// deprecated `keyCode`/`which` properties, modern browsers route on
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
					error: 'Clipboard read failed, check browser permissions.'
				};
			}

			let parsed;
			try {
				parsed = JSON.parse(text.trim());
			} catch {
				return {
					ok: false,
					added: 0,
					error: 'Invalid JSON, could not parse clipboard contents.'
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

		exportToFile() {
			const state = Storage.load();
			const payload = {
				_ytqm: true,
				exportedAt: new Date().toISOString(),
				queue: state.queue.map(({ url, title, channel }) => ({ url, title, channel })),
			};
			try {
				const json = JSON.stringify(payload, null, 2);
				const blob = new Blob([json], { type: 'application/json' });
				const blobUrl = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = blobUrl;
				a.download = `yt-queue-${new Date().toISOString().slice(0, 10)}.json`;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(blobUrl);
				log('Exported', payload.queue.length, 'items to file');
				return { ok: true, count: payload.queue.length };
			} catch (e) {
				warn('exportToFile failed:', e);
				return { ok: false, count: 0 };
			}
		},
	};

	// ── PhonePoller ───────────────────────────────────────────────────────────
	// Polls the local server for videos shared from the phone and enqueues them.

	/**
	 * Fetch a video title via YouTube's public oEmbed endpoint.
	 *
	 * Used as a fallback when the share payload from the phone arrives without
	 * a title (e.g. a bare-URL share). Returns the title string on success,
	 * null on any failure (network, non-2xx, parse, timeout).
	 *
	 * Why oEmbed and not something heavier:
	 *   - No API key, no quota, no auth.
	 *   - Tiny JSON response (~200 bytes).
	 *   - Official endpoint, less fragile than scraping a watch page for
	 *     <title> / og:title.
	 *
	 * Same-origin caveat:
	 *   YouTube's oEmbed endpoint does NOT send Access-Control-Allow-Origin,
	 *   so a cross-origin fetch from the page is blocked. We rely on the
	 *   userscript running INSIDE www.youtube.com (same scheme + host + port
	 *   as oembed), which makes this a same-origin request that bypasses CORS
	 *   entirely. That holds for desktop YouTube. From m.youtube.com or
	 *   music.youtube.com the request is cross-origin and will fail, the
	 *   caller falls back to the default placeholder title in that case.
	 *   Keeping @grant none also keeps us in page context, which the rest
	 *   of the script (Firefox Xray shims, .data anchor mutation) depends on,
	 *   so swapping in GM.xmlHttpRequest is not an option.
	 *
	 *   Unlisted, age-gated, and private videos return 401 from oEmbed. Same
	 *   fallback path applies.
	 */
	async function fetchYouTubeTitle(url) {
		try {
			const oembed = 'https://www.youtube.com/oembed?url=' +
				encodeURIComponent(url) + '&format=json';
			const res = await fetch(oembed, { signal: AbortSignal.timeout(3000) });
			if (!res.ok) return null;
			const data = await res.json();
			return (data && typeof data.title === 'string' && data.title.trim()) || null;
		} catch {
			return null;
		}
	}

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
				// Server offline or unreachable, silently ignore
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
				// Title resolution order:
				//   1. The title from the phone share payload (preferred,
				//      it's the one the user actually sees on the source page).
				//   2. YouTube's oEmbed endpoint, when (1) is missing.
				//   3. A literal placeholder, when both fail (offline, CORS
				//      block on m.youtube.com, private/age-gated video, etc).
				let title = (data.youtube_title && data.youtube_title.trim()) ? data.youtube_title.trim() : '';
				if (!title) {
					log('PhonePoller: no title in payload, fetching via oEmbed');
					title = await fetchYouTubeTitle(url);
					if (title) log('PhonePoller: oEmbed title:', title);
					else log('PhonePoller: oEmbed fetch failed or returned nothing');
				}
				if (!title) title = 'Shared from phone';
				const added = Storage.addVideo(url, title, '');
				if (added) {
					UI.updateControls();
					if (UI.panelOpen) UI.refreshPanel();
					ThumbnailInjector.syncAllButtons();
					UI.showStatus('Video added from phone', 4000);
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
			this._createOverlay();
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
					z-index: 20000000;
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
					z-index: 200000;
					border: 1px solid rgba(255,255,255,0.15);
				}
				/* Singleton body-level overlay button. Sits ON TOP of whichever
				   card's button is currently hovered, escaping every YouTube
				   stacking context (because it's at the body level, not inside
				   any ytd-* element). Forwards clicks to the underlying card
				   button so all queue/state logic stays with the existing
				   per-card buttons - this overlay is just a click-target proxy
				   that's always reachable. Width/height match the card buttons
				   exactly so they overlap pixel-for-pixel. */
				.ytqm-thumb-overlay-btn {
					position: fixed !important;
					/* top/left set dynamically per hover */
					/* z-index is one above the body tooltip's 2147483647 would
					   normally clash, so we lower the overlay tooltip in JS by
					   appending it AFTER the overlay button in the body, which
					   wins same-z-index tie. Actual z-index here is max int. */
					z-index: 200000 !important;
					pointer-events: auto;
				}
				/* When the overlay is showing, hide the per-card button under
				   it. Without this, both buttons render at (approximately) the
				   same spot - and subtle differences in box-shadow rendering,
				   anti-aliasing, or sub-pixel positioning make the doubling
				   visible. The overlay IS the UI now; the card button still
				   exists as the canonical state holder and click target, but
				   never needs to be visible while the overlay can stand in. */
				html.ytqm-overlay-active .ytqm-thumb-add-btn:not(.ytqm-thumb-overlay-btn) {
					opacity: 0 !important;
				}
				html.ytqm-ui-hover .ytqm-thumb-add-btn,
				html.ytqm-ui-hover .ytqm-thumb-overlay-btn {
					opacity: 0 !important;
					pointer-events: none !important;
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
			// Fast path via Storage.isQueued (Set-backed), avoids cloning the
			// queue array AND avoids O(thumbnails * queueLen) for big pages.
			this._cards.forEach((entry) => {
				const inQueue = Storage.isQueued(entry.videoUrl);
				const currentState = entry.btn._ytqmState;
				if (inQueue && currentState !== 'dupe') this._applyState(entry, 'dupe');
				else if (!inQueue && currentState === 'dupe') this._applyState(entry, 'idle');
			});
		},

		// ── Injection entry points (one per thumbnail variety) ──────────────────

		// Standard grid/list/compact thumbnails. The button is mounted on the
		// card-level container (yt-lockup-view-model, ytd-rich-item-renderer,
		// etc.) rather than on ytd-thumbnail. This is what eliminates the 2.1.7
		// duplicate-button bug, when YouTube's singleton ytd-video-preview
		// overlays the thumbnail on hover, the button stays on the card and
		// renders ON TOP of vpNode via z-index, instead of needing a second
		// button mounted on vpNode that travels with it across cards.
		//
		// Anchors that have no card ancestor (player UI: ytp-title-link, the
		// autonav up-next link, share-panel links, etc.) are skipped, the
		// closest(SEL.CARD) miss is the signal that we're not looking at a
		// real card.
		_injectStandard(anchor) {
			if (anchor.nodeType !== Node.ELEMENT_NODE) return;
			if (!anchor.matches('a[href*="/watch?v="]')) return;
			if (!this._hasThumbnailContent(anchor)) return;
			if (anchor.dataset.ytqmInjected) return;
			const card = anchor.closest(SEL.CARD);
			if (!card) return; // anchor lives in player chrome, not a card, skip
			anchor.dataset.ytqmInjected = '1';
			// Multiple anchors per card are common (image link + title link both
			// pointing at /watch?v=…). The first to arrive injects the button,
			// subsequent ones short-circuit here. _injectButton has its own
			// deep-search guard as a belt-and-braces backup.
			if (card.querySelector('.ytqm-thumb-add-btn')) return;
			// Mount the button on the thumbnail ANCHOR, not on card (the outer
			// Polymer element). Both are correct for visual placement since the
			// anchor IS the thumbnail container, but the anchor is a plain <a>
			// tag whereas the outer card (ytd-video-renderer, yt-lockup-view-model
			// etc.) is a Polymer custom element whose shady-DOM rendering can
			// swallow appended children - making them disappear from layout and
			// return a 0×0 getBoundingClientRect, which in turn breaks the
			// overlay positioning. The anchor is reliable across all layouts.
			// card is still passed as the _cards map key and hover-tracking
			// key so the rest of the system (overlay, syncAllButtons, hover
			// handlers) is unchanged.
			this._injectButton(anchor, anchor, card);
		},

		// End-of-video suggestion wall tiles. Anchor serves as both container
		// and card; meta is extracted from videowall-specific selectors.
		_injectVideowall(anchor) {
			if (anchor.querySelector('.ytqm-thumb-add-btn')) return;
			this._injectButton(anchor, anchor, anchor, /* isVideowall */ true);
		},

		// ── Initial sweep + MutationObserver ────────────────────────────────────

		_injectAll() {
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
		_retryFromImg(el) {
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
			// Deep search rather than direct-children-only, the button can sit
			// nested arbitrarily deep when container is the card.
			if (container.querySelector('.ytqm-thumb-add-btn')) return;

			const videoId = getVideoId(anchor.getAttribute('href') || '');
			if (!videoId) return;
			const videoUrl = watchUrl(videoId);

			// Only set position if it is currently static, YouTube sets its own
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

			// ytd-video-preview reuses the same anchor element across hover targets -
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

		// ── Body-level overlay button ────────────────────────────────────────────
		//
		// Some YouTube layouts (notably search results) wrap each card in a
		// stacking context that ranks below the inline-preview overlay
		// (ytd-video-preview). Once a per-card button is trapped inside such
		// a context, no z-index value can lift it above vpNode - z-index only
		// orders elements WITHIN the same stacking context. The fix is to put
		// a button at the body level (escaping every ytd-* context) and have
		// it sit on top of whichever card-button the user is hovering.
		//
		// This overlay does NOT have its own state machine, click logic, or
		// metadata extraction. It is a pure proxy: clicks/contextmenus are
		// forwarded to the underlying card-button, which already has all that
		// machinery. State is mirrored from the card-button each time the
		// overlay is shown, and re-mirrored from _applyState whenever the
		// hovered card's state changes.
		_createOverlay() {
			if (this._overlayBtn) return;

			const btn = document.createElement('button');
			btn.className = 'ytqm-thumb-add-btn ytqm-thumb-overlay-btn ytqm-state-idle';
			btn._ytqmState = 'idle';
			const span = document.createElement('span');
			span.innerHTML = `<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px;display:block"><path d="M9 2V16M2 9H16" stroke="white" stroke-width="2.2" stroke-linecap="round"/></svg>`;
			btn.appendChild(span);

			const tooltip = document.createElement('div');
			tooltip.className = 'ytqm-thumb-tooltip';
			tooltip.textContent = 'Add to Queue';

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

			// Forward clicks to the currently-hovered card's button. We use
			// .click() rather than dispatchEvent so the synthetic event flows
			// through the same path as a user click (and the card-button's
			// preventDefault/stopPropagation work as expected). If for some
			// reason the card button is gone (DOM was rebuilt mid-hover), we
			// just no-op rather than throwing.
			btn.addEventListener('click', e => {
				e.preventDefault();
				e.stopPropagation();
				const card = this._currentHoverCard;
				if (!card) return;
				const entry = this._cards.get(card);
				if (!entry?.btn) return;
				entry.btn.click();
			});

			btn.addEventListener('contextmenu', e => {
				e.preventDefault();
				e.stopPropagation();
				const card = this._currentHoverCard;
				if (!card) return;
				const entry = this._cards.get(card);
				if (!entry?.btn) return;
				// dispatchEvent because HTMLElement has no .contextmenu().
				// bubbles+cancelable matches a real user contextmenu event.
				entry.btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
			});

			document.body.appendChild(btn);
			document.body.appendChild(tooltip);
			this._overlayBtn = btn;
			this._overlayTooltip = tooltip;
			this._currentHoverCard = null;

			// Move overlay into vpNode's stacking context. document.body is the
			// initial mount target so the button exists in the DOM immediately,
			// but on layouts like search results some ancestor of vpNode has a
			// containing-block-establishing property (transform, will-change,
			// filter, contain, etc.) which traps body-level fixed-positioned
			// elements in body's stacking context, not the viewport's - and
			// vpNode then renders above us because it's in the trapping
			// ancestor's context. By reparenting into vpNode's grandparent
			// (#video-preview, which is a sibling of the loader that wraps
			// vpNode itself), we land in vpNode's own stacking context and a
			// high z-index reliably wins.
			//
			// #video-preview may not exist yet at script start. We try a few
			// fallbacks in decreasing order of confidence and re-try on the
			// next mutation if all of them miss.
			const reparent = () => {
				const target = document.getElementById('video-preview')
					|| document.querySelector('ytd-app')
					|| document.body;
				if (target !== this._overlayBtn.parentElement) {
					target.appendChild(this._overlayBtn);
					target.appendChild(this._overlayTooltip);
					this._overlayHost = target;
				}
			};
			reparent();
			// Watch for #video-preview being inserted later. We only need this
			// to fire ONCE per page navigation: once #video-preview exists,
			// reparent picks it up and we disconnect.
			if (this._overlayHost?.id !== 'video-preview') {
				const mo = new MutationObserver(() => {
					if (document.getElementById('video-preview')) {
						reparent();
						mo.disconnect();
					}
				});
				mo.observe(document.body, { childList: true, subtree: true });
				// Also disconnect after a timeout so this can't watch the whole body
				// subtree forever on pages where #video-preview never appears.
				setTimeout(() => mo.disconnect(), OVERLAY_REPARENT_WATCH_MS);
			}

			// Hide on scroll. The fixed-positioned overlay would otherwise
			// stay in place while the underlying card scrolls away, leaving
			// it floating over unrelated content. Scrolling usually also
			// triggers mouseleave naturally, but not always (e.g. wheel scroll
			// without cursor movement), so handle it explicitly.
			window.addEventListener('scroll', () => this._hideOverlay(), true);
			window.addEventListener('resize', () => this._hideOverlay());
		},

		_showOverlayOver(card, entry) {
			if (!this._overlayBtn) return;
			this._currentHoverCard = card;
			const cardBtn = entry.btn;
			// Use the card-button's actual viewport rect. It's the canonical
			// position we want to overlay. The card-button is normally hidden
			// (opacity 0) when its card isn't hovered, but it still has a
			// non-zero bounding rect because opacity doesn't affect layout.
			const r = cardBtn.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				// Probe-based offset. position:fixed positions relative to the
				// viewport WHEN there's no transformed ancestor, but relative
				// to the nearest containing-block-establishing ancestor when
				// there IS one. Since we've reparented the overlay into vpNode's
				// stacking context to fix the z-index issue, its containing
				// block may now be that ancestor rather than the viewport. By
				// setting 0,0 and reading back the actual viewport position,
				// we measure the containing-block offset, then subtract.
				this._overlayBtn.style.left = '0px';
				this._overlayBtn.style.top = '0px';
				const probe = this._overlayBtn.getBoundingClientRect();
				this._overlayBtn.style.left = (r.left - probe.left) + 'px';
				this._overlayBtn.style.top = (r.top - probe.top) + 'px';
				this._overlayBtn.style.width = r.width + 'px';
				this._overlayBtn.style.height = r.height + 'px';
			} else {
				// Fallback: position at the card's top-left + 8px padding to
				// match the card-button's normal absolute offset. Used when
				// the card-button has 0×0 rect for any reason (display:none
				// on an ancestor, etc).
				const cr = card.getBoundingClientRect();
				this._overlayBtn.style.left = '0px';
				this._overlayBtn.style.top = '0px';
				const probe = this._overlayBtn.getBoundingClientRect();
				this._overlayBtn.style.left = (cr.left + 8 - probe.left) + 'px';
				this._overlayBtn.style.top = (cr.top + 8 - probe.top) + 'px';
				this._overlayBtn.style.width = '';
				this._overlayBtn.style.height = '';
			}
			this._mirrorOverlayFrom(cardBtn, entry.tooltip);

			// Suppress the overlay if it would land on top of the button bar.
			// The bar sits at z-index 9999 but the overlay is 200000. The panel
			// and settings overlay are handled separately via ytqm-ui-hover.
			const btnRect = r.width > 0 && r.height > 0 ? r : card.getBoundingClientRect();
			const pad = 8;
			const barHost = document.getElementById('ytqm-host');
			if (barHost) {
				const barRect = barHost.getBoundingClientRect();
				if (btnRect.left   < barRect.right  + pad &&
				    btnRect.right  > barRect.left   - pad &&
				    btnRect.top    < barRect.bottom + pad &&
				    btnRect.bottom > barRect.top    - pad) return;
			}

			this._overlayBtn.classList.add('ytqm-visible');
			// Mark the overlay as active globally so the per-card button
			// underneath this overlay (and any other card buttons that happen
			// to also be in a visible state, like a just-added ytqm-active
			// flash) get hidden via the html.ytqm-overlay-active CSS rule.
			// See _injectStyles for the full rationale.
			document.documentElement.classList.add('ytqm-overlay-active');
		},

		_hideOverlay() {
			if (!this._overlayBtn) return;
			this._currentHoverCard = null;
			this._overlayBtn.classList.remove('ytqm-visible');
			if (this._overlayTooltip) this._overlayTooltip.style.opacity = '0';
			document.documentElement.classList.remove('ytqm-overlay-active');
		},

		// Copy the card-button's visual state onto the overlay. Called from
		// _showOverlayOver and from _applyState when the hovered card's
		// state changes (so e.g. "Added!" feedback is visible on the overlay).
		_mirrorOverlayFrom(cardBtn, cardTooltip) {
			if (!this._overlayBtn) return;
			const state = cardBtn._ytqmState || 'idle';
			this._overlayBtn._ytqmState = state;
			this._overlayBtn.classList.remove('ytqm-state-idle', 'ytqm-state-added', 'ytqm-state-dupe', 'ytqm-state-removed', 'ytqm-state-next');
			this._overlayBtn.classList.add(`ytqm-state-${state}`);
			this._overlayBtn.classList.toggle('ytqm-active', cardBtn.classList.contains('ytqm-active'));
			const cardSpan = cardBtn.querySelector('span');
			const overlaySpan = this._overlayBtn.querySelector('span');
			if (cardSpan && overlaySpan) overlaySpan.innerHTML = cardSpan.innerHTML;
			if (cardTooltip && this._overlayTooltip) {
				this._overlayTooltip.textContent = cardTooltip.textContent;
			}
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
				dupe:    { active: false, tooltip: 'In queue, click to remove',
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

			// If this entry's card is the one currently being hovered, also
			// update the overlay button so the user sees immediate feedback
			// (e.g. "Added!" on click). Reverse-lookup is via the singleton
			// _currentHoverCard so we don't have to thread the card down here.
			if (this._currentHoverCard && this._cards.get(this._currentHoverCard) === entry) {
				this._mirrorOverlayFrom(btn, entry.tooltip);
			}
		},

		_startHoverTracking() {
			// We use capture-phase listeners on `document` so we can delegate
			// hover state to thumbnail buttons that are spread across the page
			// without attaching a listener to every card individually.
			// `mouseenter`/`mouseleave` don't bubble but DO fire during capture
			// because the dispatch path passes through document on the way to
			// the target.
			//
			// Resolution order:
			//   1. closest(CARD) - direct hit, the cursor is on a card.
			//   2. closest(VIDEO_PREVIEW) → URL match - vpNode is the singleton
			//      inline-player overlay, NOT a DOM descendant of the card it
			//      visually covers, so closest(CARD) misses. Match by the URL
			//      vpNode's anchor currently points at instead, that's the
			//      video the user is hovering on.
			//   3. closest('.ytp-suggestion-set') - end-of-video wall tile.
			const findEntry = (target) => {
				const card = target.closest?.(SEL.CARD);
				if (card) {
					const e = this._cards.get(card);
					if (e) return { card, entry: e };
				}
				const vp = target.closest?.(SEL.VIDEO_PREVIEW);
				if (vp) {
					const a = vp.querySelector('a[href*="/watch?v="]');
					const id = a && getVideoId(a.getAttribute('href') || '');
					if (id) {
						const url = watchUrl(id);
						for (const [c, e] of this._cards) {
							if (e.videoUrl === url) return { card: c, entry: e };
						}
					}
				}
				const sugg = target.closest?.('.ytp-suggestion-set');
				if (sugg) {
					const e = this._cards.get(sugg);
					if (e) return { card: sugg, entry: e };
				}
				return null;
			};

			document.addEventListener('mouseenter', e => {
				// If cursor enters vpNode while a hide timer is pending for the
				// currently tracked card, cancel it immediately. vpNode only
				// appears because the user is hovering a card, so entering it
				// never means "left the card". This handles the gap scenario:
				// on edge/first-column cards vpNode can be offset slightly so
				// the cursor briefly isn't over the card OR vpNode, starting
				// the hide timer before the cursor reaches vpNode.
				if (e.target.closest?.(SEL.VIDEO_PREVIEW) && this._currentHoverCard) {
					const entry = this._cards.get(this._currentHoverCard);
					if (entry?.hideTimer) {
						clearTimeout(entry.hideTimer);
						entry.hideTimer = null;
					}
					// Don't fall through - the URL match in findEntry might
					// fail if vpNode's href isn't loaded yet, which would
					// cause _showOverlayOver to not run. The overlay is
					// already showing from the card hover, so just leaving it
					// alone is the right call here.
					return;
				}
				const hit = findEntry(e.target);
				if (!hit) return;
				clearTimeout(hit.entry.hideTimer);
				hit.entry.hideTimer = null;
				hit.entry.btn.classList.add('ytqm-visible');
				// Also position+show the body-level overlay button on top
				// of the card-button, so we have a click target that
				// escapes any stacking context vpNode might cover us with.
				this._showOverlayOver(hit.card, hit.entry);
			}, true);

			document.addEventListener('mouseleave', e => {
				const hit = findEntry(e.target);
				if (!hit) return;
				const rel = e.relatedTarget;
				if (rel) {
					// Treat the overlay button (and its tooltip) as part of
					// the current card, otherwise moving the cursor onto the
					// overlay would fire mouseleave on the card and start the
					// hide timer.
					if (rel === this._overlayBtn || rel === this._overlayTooltip ||
						rel.closest?.('.ytqm-thumb-overlay-btn')) return;
					// If cursor moved directly onto vpNode, never hide. vpNode
					// only appears when the user is hovering a card, so it is
					// always "same card" semantically. We check this explicitly
					// before the URL-match fallback because vpNode's href is
					// often not yet loaded when this event fires (it loads
					// asynchronously after hover), which makes findEntry return
					// null for vpNode and causes a spurious hide - visible as
					// the button flashing briefly then disappearing.
					if (rel.closest?.(SEL.VIDEO_PREVIEW)) return;
					const relHit = findEntry(rel);
					if (relHit && relHit.card === hit.card) return;
				}
				if (hit.entry.hideTimer) return;
				hit.entry.hideTimer = setTimeout(() => {
					hit.entry.btn.classList.remove('ytqm-visible');
					hit.entry.tooltip.style.opacity = '0';
					hit.entry.hideTimer = null;
					// Only hide the overlay if it's still showing for THIS
					// card. Hovering a different card in the meantime would
					// have already updated _currentHoverCard.
					if (this._currentHoverCard === hit.card) this._hideOverlay();
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
		miniControls: null,
		miniPrevBtn: null,
		miniPlayPauseBtn: null,
		miniNextBtn: null,
		panel: null,
		list: null,
		nowPlayingSection: null,
		upNextLabel: null,
		settingsOverlay: null,
		panelOpen: false,
		_panelLeaveTimer: null,
		_dragSrcIndex: null,
		addBtnFlash: null,
		addBtnLabel: null,
		_addBtnFlashTimer: null,
		_dockObserver: null,
		_dockRetryTimer: null,

		_applyPanelBlur() {
			if (!this.panel) return;
			this.panel.classList.toggle('ytqm-panel-blur', !!Settings.get().panelBlur);
		},

		// ── Docked-menu placement ────────────────────────────────────────────
		//
		// The button bar (#ytqm-root, living inside the shadow host) normally
		// floats over the bottom-left corner via `position: fixed` on the host
		// element itself. When the "Full-width docked menu" setting is on, we
		// instead reparent the host into YouTube's own #full-bleed-container
		// (a watch-page-only element that wraps the player) and switch it to a
		// static, full-width strip.
		//
		// #full-bleed-container doesn't exist on non-watch pages, and on watch
		// pages it can be torn down and rebuilt across SPA navigations - and,
		// it turns out, well after the initial page load too. YouTube keeps
		// reflowing the area around the player as ads, related videos, and
		// comments settle in, and that can rebuild the wrapper around #player
		// (or wipe/replace its children outright), silently detaching or
		// stranding our host node even though it was correctly docked a
		// moment earlier. So this isn't a one-shot reparent: alongside the
		// re-evaluation on settings toggle / init / onUrlChange, we keep a
		// standing MutationObserver for as long as docked mode is active that
		// re-verifies placement on every relevant mutation and re-docks if
		// something knocked it loose.
		_applyDockMode() {
			if (!this.host) return;
			clearTimeout(this._dockRetryTimer);
			if (this._dockObserver) {
				this._dockObserver.disconnect();
				this._dockObserver = null;
			}

			if (!Settings.get().dockedControls) {
				this._undock();
				return;
			}

			const target = document.getElementById('player');
			if (target) this._dockInto(target);
			else this._undock(); // Container isn't present yet, float until it shows up.

			// Standing watch: re-checked on every mutation for as long as
			// docked mode stays on, not just until the first successful dock.
			this._dockObserver = new MutationObserver(() => {
				if (!Settings.get().dockedControls) {
					this._dockObserver?.disconnect();
					this._dockObserver = null;
					return;
				}
				const t = document.getElementById('player');
				if (!t) {
					this._undock();
					return;
				}
				// Re-dock only if placement actually broke (detached entirely,
				// or no longer the element immediately after #player) - _dockInto
				// itself is idempotent, but skipping the call when nothing's
				// wrong avoids needless style/DOM churn on every unrelated
				// mutation elsewhere on the page.
				const stillDocked = this.host.isConnected
					&& this.host.previousElementSibling === t
					&& this.host.parentElement === t.parentElement;
				if (!stillDocked) this._dockInto(t);
			});
			this._dockObserver.observe(document.body, { childList: true, subtree: true });
		},

		_dockInto(target) {
			// Insert the host immediately after #player (between player and #below),
			// not inside the player container itself.
			const shouldInsert = this.host.previousElementSibling !== target
				|| this.host.parentElement !== target.parentElement;
			if (shouldInsert) target.insertAdjacentElement('afterend', this.host);
			Object.assign(this.host.style, {
				position: 'relative',
				bottom: 'auto',
				left: 'auto',
				width: '100%',
				height: 'auto',
				zIndex: '1',
				pointerEvents: 'all',
			});
			this.root?.classList.add('ytqm-docked');
			log('UI: docked button bar after #player');
		},

		_undock() {
			if (this.host.parentElement !== document.body) document.body.appendChild(this.host);
			Object.assign(this.host.style, {
				position: 'fixed',
				bottom: '0',
				left: '0',
				width: '0',
				height: '0',
				zIndex: '9999',
				pointerEvents: 'none',
			});
			this.root?.classList.remove('ytqm-docked');
		},

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
			this._applyPanelBlur();
			this._buildButtons();
			document.body.appendChild(this.host);
			this._applyDockMode();

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
        #ytqm-root { position: fixed; bottom: 24px; left: 20px; display: flex; flex-direction: row; align-items: center; gap: 8px; pointer-events: all; z-index: 2; }
        #ytqm-root.ytqm-docked {
            position: static;
            bottom: auto;
            left: auto;
            width: 100%;
            justify-content: center;
            flex-wrap: wrap;
            padding: 10px 16px;
            background: rgba(20,20,20,0.92);
            border-top: 1px solid rgba(255,255,255,0.12);
            box-shadow: none;
        }
        .ytqm-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 15px; border-radius: 999px; border: 1.5px solid rgba(255,255,255,0.75); cursor: pointer; font-size: 13px; font-weight: 600; font-family: 'Segoe UI', Arial, system-ui, sans-serif; letter-spacing: 0.02em; transition: transform 0.12s ease, opacity 0.12s ease, background 0.2s ease; user-select: none; white-space: nowrap; box-shadow: 0 4px 18px rgba(0,0,0,0.55); outline: none; line-height: 1; }
        .ytqm-btn:hover  { transform: scale(1.04); }
        .ytqm-btn:active { transform: scale(1); }
        #ytqm-add-btn, #ytqm-queue-toggle, #ytqm-play-btn { background: rgba(20,20,20,0.85); color: #fff; }
        #ytqm-add-btn { position: relative; }
        #ytqm-play-btn.is-playing { background: #c0392b; }
        #ytqm-play-btn.is-remote  { background: #1a6fa8; border-color: rgba(100,180,255,0.7); }
        #ytqm-mini-controls { display: none; align-items: center; gap: 4px; background: rgba(20,20,20,0.9); border: 1.5px solid rgba(255,255,255,0.9); border-radius: 999px; padding: 4px; box-shadow: 0 4px 18px rgba(0,0,0,0.55); }
        #ytqm-mini-controls.visible { display: inline-flex; }
        .ytqm-mini-btn { background: none; border: none; color: #fff; cursor: pointer; font-size: 15px; line-height: 1; width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; font-family: inherit; transition: background 0.15s, transform 0.12s ease; }
        .ytqm-mini-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.06); }
        .ytqm-mini-btn:active { transform: scale(1); }
        .ytqm-mini-btn:disabled { opacity: 0.35; cursor: default; }
        .ytqm-mini-btn:disabled:hover { background: none; transform: none; }
        #ytqm-mini-playpause-btn.is-paused { color: #2ecc71; }

        /* ── Docked mode ──────────────────────────────────────────────
           The pill/shadow/thick-border treatment above is built for
           floating over arbitrary video content, where it needs to
           stand on its own. Docked mode already sits on its own flat,
           bordered strip under the player, so that same treatment reads
           as too heavy/loud. Flatten it into a plain toolbar look that
           belongs to the strip instead of fighting it. */
        #ytqm-root.ytqm-docked .ytqm-btn {
            flex: 0 0 150px;
            justify-content: center;
            padding: 7px 14px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.16);
            box-shadow: none;
            font-weight: 500;
            letter-spacing: 0.01em;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        #ytqm-root.ytqm-docked .ytqm-btn:hover { transform: none; background: rgba(255,255,255,0.1); }
        #ytqm-root.ytqm-docked .ytqm-btn:active { background: rgba(255,255,255,0.14); }
        #ytqm-root.ytqm-docked #ytqm-add-btn,
        #ytqm-root.ytqm-docked #ytqm-queue-toggle,
        #ytqm-root.ytqm-docked #ytqm-play-btn { background: rgba(255,255,255,0.05); }
        #ytqm-root.ytqm-docked #ytqm-play-btn.is-playing { background: rgba(192,57,43,0.9); border-color: rgba(192,57,43,0.9); }
        #ytqm-root.ytqm-docked #ytqm-play-btn.is-remote  { background: rgba(26,111,168,0.9); border-color: rgba(100,180,255,0.5); }
        #ytqm-root.ytqm-docked #ytqm-add-btn-flash { border-radius: 8px; }
        #ytqm-root.ytqm-docked #ytqm-mini-controls {
            background: rgba(255,255,255,0.05);
            border: none;
            box-shadow: none;
            border-radius: 8px;
        }
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
        #ytqm-panel { position: fixed; bottom: 68px; left: 20px; width: 330px; max-height: 480px; background: #111; border: 1.5px solid rgba(255,255,255,0.18); border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.75); display: flex; flex-direction: column; overflow: hidden; color: #fff; font-family: 'Segoe UI', Arial, system-ui, sans-serif; pointer-events: none; transform: translateY(calc(100% + 40px)); opacity: 0; transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.22s ease; z-index: 1; }
        #ytqm-panel.open { pointer-events: all; transform: translateY(0); opacity: 1; }
        #ytqm-panel.ytqm-panel-blur { background: rgba(15,15,15,0.55); backdrop-filter: blur(20px) saturate(150%); -webkit-backdrop-filter: blur(20px) saturate(150%); }
        #ytqm-panel-header { padding: 14px 16px 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .header-controls { display: flex; align-items: center; gap: 6px; }
        #ytqm-panel-title { cursor: pointer; transition: color 0.2s ease, text-shadow 0.2s ease; border-radius: 4px; padding: 1px 3px; margin: -1px -3px; display: inline-flex; align-items: center; gap: 6px; }
        #ytqm-panel-title:hover { color: #fff; text-shadow: 0 0 8px rgba(255,255,255,0.9), 0 0 20px rgba(255,255,255,0.4); }
        #ytqm-cog-icon { width: 20px; height: 20px; color: #fff; flex-shrink: 0; transition: transform 0.35s ease; }
        #ytqm-panel-title:hover #ytqm-cog-icon { transform: rotate(60deg); }

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
        #ytqm-up-next-label { flex-shrink: 0; padding: 9px 14px 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.25); display: flex; align-items: center; gap: 8px; }
        .ytqm-up-next-text { flex-shrink: 0; white-space: nowrap; }
        .ytqm-queue-actions { display: flex; gap: 10px; margin-left: auto; margin-right: 0px; flex-shrink: 0; }
        .ytqm-mini-btn { background: none; border: 1px solid rgba(255,255,255,0.25); border-radius: 999px; color: rgba(255,255,255,0.7); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; padding: 3px 10px; transition: all 0.15s; }
        .ytqm-mini-btn:hover { background: rgba(255,255,255,0.1); color: #fff; border-color: rgba(255,255,255,0.45); }
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
           use this class, see ytqm-panel-close / ytqm-settings-close IDs.
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
        /* Items are NOT draggable on the row level, only via the handle.
           See refreshPanel() for the handle-driven \`draggable\` toggle. */
        .ytqm-item { display: flex; align-items: center; gap: 6px; padding: 9px 14px; transition: background 0.12s; border-radius: 8px; margin: 2px 6px; position: relative; }
        .ytqm-item:hover     { background: rgba(255,255,255,0.07); }
        .ytqm-item.dragging  { opacity: 0.35; }
        /* Drop indicator: 2px line above OR below the hovered item, telling
           the user exactly where the drop will land, replaces the old single
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
        #ytqm-settings-modal { background: #111; border: 1.5px solid rgba(255,255,255,0.18); border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.75); width: min(780px, 96vw); max-height: 85vh; color: #fff; font-family: 'Segoe UI', Arial, system-ui, sans-serif; overflow: hidden; display: flex; flex-direction: column; }
        #ytqm-settings-content { display: flex; flex: 1; min-height: 0; overflow: hidden; }
        #ytqm-settings-header { padding: 14px 16px 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; }

        /* ── Tab sidebar ── */
        #ytqm-settings-sidebar { width: 130px; flex-shrink: 0; border-right: 1px solid rgba(255,255,255,0.08); padding: 8px 0; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }
        .ytqm-tab-btn { background: none; border: none; border-right: 2px solid transparent; color: rgba(255,255,255,0.4); font-family: inherit; font-size: 12px; font-weight: 600; letter-spacing: 0.03em; text-align: left; padding: 10px 14px; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s; width: 100%; }
        .ytqm-tab-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
        .ytqm-tab-btn.active { background: rgba(255,255,255,0.09); color: #fff; border-right-color: rgba(255,255,255,0.7); }

        /* ── Tab panels ── */
        #ytqm-settings-body { flex: 1; overflow-y: auto; min-height: 0; padding: 4px 0 8px; }
        .ytqm-tab-panel { display: none; }
        .ytqm-tab-panel.active { display: block; }

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
        #ytqm-io-section { width: 180px; flex-shrink: 0; border-left: 1px solid rgba(255,255,255,0.08); padding: 14px 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
        #ytqm-io-title { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.3); margin-bottom: 10px; }
        .ytqm-io-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 0; }
        .ytqm-io-btn { width: 100%; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; color: rgba(255,255,255,0.8); font-size: 12px; font-weight: 600; font-family: inherit; padding: 7px 10px; cursor: pointer; transition: background 0.15s, color 0.15s; white-space: nowrap; text-align: center; }
        .ytqm-io-btn:hover { background: rgba(255,255,255,0.13); color: #fff; }
        .ytqm-io-btn.accent { background: rgba(39,174,96,0.15); border-color: rgba(39,174,96,0.35); color: rgba(39,174,96,0.9); }
        .ytqm-io-btn.accent:hover { background: rgba(39,174,96,0.25); color: #2ecc71; }
        #ytqm-io-status { font-size: 11px; color: rgba(255,255,255,0.35); min-height: 16px; transition: color 0.2s; margin-top: 8px; text-align: center; }
        #ytqm-io-status.ok  { color: rgba(46,204,113,0.85); }
        #ytqm-io-status.err { color: rgba(231,76,60,0.9); }
        @media (max-width: 600px) {
            #ytqm-settings-modal { width: 95vw; max-height: 90vh; }
            #ytqm-settings-content { flex-direction: column; overflow-y: auto; }
            #ytqm-settings-sidebar { width: auto; flex-direction: row; border-right: none; border-bottom: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; overflow-x: auto; }
            .ytqm-tab-btn { border-right: none; border-bottom: 2px solid transparent; padding: 8px 12px; white-space: nowrap; }
            .ytqm-tab-btn.active { border-bottom-color: rgba(255,255,255,0.7); border-right-color: transparent; }
            #ytqm-io-section { width: auto; border-left: none; border-top: 1px solid rgba(255,255,255,0.08); }
        }
      `;
		},

		_cssToggleSwitch() {
			return `
        .ytqm-toggle { position: relative; flex-shrink: 0; width: 36px; height: 20px; cursor: pointer; }
        .ytqm-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
        .ytqm-toggle-track { position: absolute; inset: 0; background: rgba(255,255,255,0.15); border-radius: 999px; border: 1px solid rgba(255,255,255,0.75); transition: background 0.2s, border-color 0.2s; }
        .ytqm-toggle input:checked + .ytqm-toggle-track { background: rgba(204,0,0,0.85); border-color: rgba(255,255,255,0.75); }
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
			this._buildMiniControls();
			this.root.appendChild(this.miniControls);
		},

		// Small previous/pause/next cluster that sits to the right of the
		// add/remove-from-queue button. Unlike the panel header's remote
		// controls (which only exist while the panel is open), this stays
		// visible at all times so playback can be driven from any tab
		// without opening the panel. Hidden entirely when nothing is
		// playing anywhere, or when the "Floating mini controls" setting
		// is off (see updateRemotePauseBtn, which owns visibility).
		_buildMiniControls() {
			this.miniControls = document.createElement('div');
			this.miniControls.id = 'ytqm-mini-controls';

			this.miniPrevBtn = document.createElement('button');
			this.miniPrevBtn.id = 'ytqm-mini-prev-btn';
			this.miniPrevBtn.className = 'ytqm-mini-btn';
			this.miniPrevBtn.title = 'Previous';
			this.miniPrevBtn.textContent = '\u23ee';
			this.miniPrevBtn.addEventListener('click', e => {
				e.stopPropagation();
				Player.remotePrev();
			});

			this.miniPlayPauseBtn = document.createElement('button');
			this.miniPlayPauseBtn.id = 'ytqm-mini-playpause-btn';
			this.miniPlayPauseBtn.className = 'ytqm-mini-btn';
			this.miniPlayPauseBtn.title = 'Pause';
			this.miniPlayPauseBtn.textContent = '\u23f8';
			this.miniPlayPauseBtn.addEventListener('click', e => {
				e.stopPropagation();
				this._onRemotePauseClick();
			});

			this.miniNextBtn = document.createElement('button');
			this.miniNextBtn.id = 'ytqm-mini-next-btn';
			this.miniNextBtn.className = 'ytqm-mini-btn';
			this.miniNextBtn.title = 'Next';
			this.miniNextBtn.textContent = '\u23ed';
			this.miniNextBtn.addEventListener('click', e => {
				e.stopPropagation();
				Player.remoteSkip();
			});

			this.miniControls.append(this.miniPrevBtn, this.miniPlayPauseBtn, this.miniNextBtn);
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

			const cogIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			cogIcon.setAttribute('id', 'ytqm-cog-icon');
			cogIcon.setAttribute('viewBox', '0 0 20 20');
			cogIcon.setAttribute('fill', 'currentColor');
			cogIcon.setAttribute('aria-hidden', 'true');
			cogIcon.innerHTML = `<path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>`;

			title.append(cogIcon);
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
			prevBtn.addEventListener('click', () => Player.remotePrev());
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
			upNextText.className = 'ytqm-up-next-text';
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

			// Hide all thumbnail buttons (overlay + per-card) while the cursor is
			// over the queue panel. Simpler and more reliable than geometry checks
			// on every hover: a single CSS class on <html> suppresses everything.
			this.panel.addEventListener('mouseenter', () => {
				document.documentElement.classList.add('ytqm-ui-hover');
			});
			this.panel.addEventListener('mouseleave', () => {
				document.documentElement.classList.remove('ytqm-ui-hover');
			});

			// Auto-close: once the cursor leaves the panel, give it
			// PANEL_AUTOCLOSE_DELAY_MS to come back before the panel closes
			// itself. Re-entering the panel before the timer fires cancels it.
			this.panel.addEventListener('mouseenter', () => {
				clearTimeout(this._panelLeaveTimer);
				this._panelLeaveTimer = null;
			});
			this.panel.addEventListener('mouseleave', () => {
				clearTimeout(this._panelLeaveTimer);
				this._panelLeaveTimer = setTimeout(() => {
					if (this.panelOpen) this.togglePanel(false);
				}, PANEL_AUTOCLOSE_DELAY_MS);
			});

			this._buildSettingsModal();
		},

		_buildSettingsModal() {
			this.settingsOverlay = document.createElement('div');
			this.settingsOverlay.id = 'ytqm-settings-overlay';
			this.settingsOverlay.addEventListener('mousedown', e => {
				if (e.target === this.settingsOverlay) this.closeSettings();
			});
			this.settingsOverlay.addEventListener('mouseenter', () => {
				document.documentElement.classList.add('ytqm-ui-hover');
			});
			this.settingsOverlay.addEventListener('mouseleave', () => {
				document.documentElement.classList.remove('ytqm-ui-hover');
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

			// Build a sidebar + tab-panel layout from the defs array.
			// Each { type: 'header' } entry becomes a tab button; its following
			// entries are rendered into the corresponding panel.
			const sidebar = document.createElement('div');
			sidebar.id = 'ytqm-settings-sidebar';

			const defs = [
				{ type: 'header', label: 'Appearance' },
				{
					key: 'panelBlur',
					label: 'Frosted glass panel',
					sub: 'Blur and fade the queue panel background for a frosted glass look.'
				},
				{
					key: 'dockedControls',
					label: 'Full-width docked menu',
					sub: 'Dock the button bar as a full-width strip under the video player instead of floating in the corner. Falls back to floating on non-watch pages.'
				},
				{
					key: 'keyboardShortcuts',
					label: 'Keyboard shortcuts',
					sub: 'Alt+Q toggles add/remove for the current video, Alt+N skips, Alt+P goes to previous. Ignored while typing in inputs.'
				},
				{
					key: 'blockContextMenu',
					label: 'Block right-click menu',
					sub: 'Suppress the browser context menu site-wide so right-clicking a thumbnail button always triggers \u201cplay next\u201d without the menu appearing.'
				},
				{ type: 'header', label: 'YouTube' },
				{
					key: 'hideNativeButtons',
					label: 'Hide YouTube\'s thumbnail buttons',
					sub: 'Suppress the native Watch Later and Add to Queue buttons that appear on hover, so only the queue manager button is shown.'
				},
				{
					key: 'hideShorts',
					label: 'Hide Shorts',
					sub: 'Hide YouTube Shorts from search results, home feed, subscriptions, shelves, and the Shorts button in the side navigation.'
				},
				{
					key: 'hideInterruptionsBanner',
					label: 'Hide interruptions banner',
					sub: 'Hide the "Experiencing interruptions?" notification bar that appears below the video.'
				},
				{ type: 'header', label: 'Phone' },
				{
					key: 'enqueueFromPhone',
					label: 'Enqueue videos shared from phone',
					sub: 'Videos shared from your Android device via the local server go straight into the queue instead of opening a new tab.'
				},
				{ type: 'phoneUrl' },
				{ type: 'header', label: 'Playback' },
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
					key: 'remoteControls',
					label: 'Cross-tab controls',
					sub: 'Show pause, skip & previous buttons in the queue panel when another tab is playing.'
				},
				{
					key: 'miniControls',
					label: 'Floating mini controls',
					sub: 'Show a small previous / pause / next cluster next to the queue button, so playback can be controlled from any tab without opening the panel.'
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
			];

			// Group defs into tabs: each { type: 'header' } starts a new tab.
			const tabGroups = [];
			let currentGroup = null;
			defs.forEach(def => {
				if (def.type === 'header') {
					currentGroup = { label: def.label, items: [] };
					tabGroups.push(currentGroup);
				} else if (currentGroup) {
					currentGroup.items.push(def);
				}
			});

			let phoneUrlRow = null;
			const tabPanels = [];
			const tabBtns = [];

			const activateTab = (index) => {
				tabBtns.forEach((b, i) => b.classList.toggle('active', i === index));
				tabPanels.forEach((p, i) => p.classList.toggle('active', i === index));
			};

			tabGroups.forEach((group, groupIdx) => {
				// Tab button in sidebar
				const tabBtn = document.createElement('button');
				tabBtn.className = 'ytqm-tab-btn' + (groupIdx === 0 ? ' active' : '');
				tabBtn.textContent = group.label;
				tabBtn.addEventListener('click', () => activateTab(groupIdx));
				sidebar.appendChild(tabBtn);
				tabBtns.push(tabBtn);

				// Tab content panel
				const panel = document.createElement('div');
				panel.className = 'ytqm-tab-panel' + (groupIdx === 0 ? ' active' : '');
				body.appendChild(panel);
				tabPanels.push(panel);

				group.items.forEach(def => {
					if (def.type === 'phoneUrl') {
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
						const isValidUrl = (val) => {
							try { const u = new URL(val); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
						};
						const reflectValidity = () => {
							const v = urlInput.value.trim();
							const ok = !v || isValidUrl(v);
							urlInput.style.borderColor = ok ? '' : 'rgba(231,76,60,0.85)';
							urlInput.title = ok ? '' : 'Must be an http:// or https:// URL';
						};
						urlInput.addEventListener('input', reflectValidity);
						urlInput.addEventListener('change', () => {
							const v = urlInput.value.trim();
							if (v && !isValidUrl(v)) { reflectValidity(); warn('Rejected invalid phoneServerUrl:', v); return; }
							Settings.set('phoneServerUrl', v || SETTINGS_DEFAULTS.phoneServerUrl);
							log('Setting changed: phoneServerUrl =', Settings.get().phoneServerUrl);
							reflectValidity();
						});
						reflectValidity();
						urlRow.append(urlLabel, urlInput);
						phoneUrlRow = urlRow;
						urlRow.style.display = Settings.get().enqueueFromPhone ? '' : 'none';
						panel.appendChild(urlRow);
						return;
					}

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
							if (def.key === 'hideShorts') ShortsHider.apply();
							if (def.key === 'hideInterruptionsBanner') InterruptionsBannerHider.apply();
							if (def.key === 'panelBlur') UI._applyPanelBlur();
							if (def.key === 'dockedControls') UI._applyDockMode();
							if (def.key === 'enqueueFromPhone') {
								input.checked ? PhonePoller.start() : PhonePoller.stop();
								if (phoneUrlRow) phoneUrlRow.style.display = input.checked ? '' : 'none';
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
					panel.appendChild(row);
				});
			});

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
			exportBtn.textContent = 'Copy Queue';
			exportBtn.title = 'Copy the current queue to the clipboard as JSON';
			exportBtn.addEventListener('click', async () => {
				const {
					ok,
					count
				} = await QueueIO.exportToClipboard();
				if (ok) setIoStatus(`Copied ${count} item${count !== 1 ? 's' : ''} to clipboard`, 'ok');
				else setIoStatus('Clipboard write failed, check browser permissions', 'err');
			});

			const importBtn = document.createElement('button');
			importBtn.className = 'ytqm-io-btn';
			importBtn.textContent = 'Paste & Append';
			importBtn.title = 'Read JSON from the clipboard and append new items to the queue';
			importBtn.addEventListener('click', async () => {
				const {
					ok,
					added,
					error
				} = await QueueIO.importFromClipboard();
				if (ok) setIoStatus(`Appended ${added} item${added !== 1 ? 's' : ''} to queue`, 'ok');
				else setIoStatus(error, 'err');
			});

			const downloadBtn = document.createElement('button');
			downloadBtn.className = 'ytqm-io-btn';
			downloadBtn.textContent = 'Save to File';
			downloadBtn.title = 'Download the current queue as a JSON file';
			downloadBtn.addEventListener('click', () => {
				const { ok, count } = QueueIO.exportToFile();
				if (ok) setIoStatus(`Saved ${count} item${count !== 1 ? 's' : ''} to file`, 'ok');
				else setIoStatus('File save failed', 'err');
			});

			ioRow.append(exportBtn, importBtn, downloadBtn);
			ioSection.append(ioTitle, ioRow, ioStatus);
			const content = document.createElement('div');
			content.id = 'ytqm-settings-content';
			content.append(sidebar, body, ioSection);
			modal.append(header, content);
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
			const phoneUrlEl = this.settingsOverlay.querySelector('.ytqm-setting-row.url-row');
			if (phoneUrlEl) phoneUrlEl.style.display = Settings.get().enqueueFromPhone ? '' : 'none';
			this.settingsOverlay.classList.add('open');
		},

		closeSettings() {
			this.settingsOverlay.classList.remove('open');
			document.documentElement.classList.remove('ytqm-ui-hover');
		},

		_currentVideoMeta() {
			const videoId = getVideoId(location.href);
			if (!videoId) return null;
			const url = watchUrl(videoId);
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
			} else if (PlayingTab.anyPlaying()) {
				// Another tab owns the queue. Signal it to stop rather than
				// trying to start a new queue here. The playing tab receives
				// the localStorage event and calls Player.stop() on itself.
				localStorage.setItem(STOP_KEY, Date.now().toString());
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
			if (Storage.paused) {
				Player.remoteResume();
				// If this tab owns playback, act on the local video directly.
				// The storage event does NOT fire in the same tab that wrote it,
				// so _onPauseStorageChange() would never run here.
				if (Player._playing) {
					// An explicit click on our resume button is a deliberate
					// user request to play, even if the video was most recently
					// paused via YouTube's own controls (which sets _userPaused
					// to stop cross-tab remote-pause syncing from fighting a
					// manual pause). Clear it here so this button reliably
					// resumes playback regardless of how it was paused.
					Player._userPaused = false;
					const video = document.querySelector('video');
					if (video && video.paused && !video.ended) {
						video.play().catch(() => Player._clickPlayButton());
					}
				}
			} else {
				Player.remotePause();
				// Same reason: pause the local video directly when this tab is playing.
				if (Player._playing) {
					const video = document.querySelector('video');
					if (video && !video.paused && !video.ended) {
						video.pause();
					}
				}
			}
		},

		/**
		 * Shuffle "remaining" items only, when the queue is playing, queue[0]
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
			// Lightweight confirm, using window.confirm because the panel UI
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
			const remoteOnly = !playing && PlayingTab.anyPlaying();
			const count = Storage.queue.length;
			this.queueToggleBtn.textContent = count > 0 ? `\u2261 Queue (${count})` : '\u2261 Queue';
			const currentUrl = isWatch ? watchUrl(getVideoId(location.href)) : null;
			const alreadyQueued = !!currentUrl && !!Storage.queue.find(v => v.url === currentUrl);
			this.addBtn.style.display = isWatch ? 'inline-flex' : 'none';
			if (isWatch) this.addBtnLabel.textContent = alreadyQueued ? '\u2212 Remove from Queue' : '\uff0b Add to Queue';
			this.playBtn.style.display = 'inline-flex';
			if (playing) {
				// This tab owns playback.
				this.playBtn.textContent = '\u25a0 Stop Queue';
				this.playBtn.classList.add('is-playing');
				this.playBtn.classList.remove('is-remote');
				this.playBtn.title = 'Stop the queue in this tab';
			} else if (remoteOnly) {
				// Another tab is playing. Blue to distinguish from the local red
				// "stop" state, label makes it explicit which tab the action affects.
				this.playBtn.textContent = '\u25a0 Stop Queue (other tab)';
				this.playBtn.classList.remove('is-playing');
				this.playBtn.classList.add('is-remote');
				this.playBtn.title = 'Signal the playing tab to stop the queue';
			} else {
				// Nothing playing anywhere.
				this.playBtn.textContent = count > 0 ? `\u25b6 Play Queue (${count})` : '\u25b6 Play Queue';
				this.playBtn.classList.remove('is-playing', 'is-remote');
				this.playBtn.title = '';
			}
			this.updateRemotePauseBtn();
		},

		updateRemotePauseBtn() {
			if (!this.remotePauseBtn) return;
			const anyPlaying = Player._playing || PlayingTab.anyPlaying();
			const remoteControls = Settings.get().remoteControls;
			const isPaused = Storage.paused;
			const hasHistory = Storage.history.length > 0;
			const hasNext = Storage.queue.length > 1;
			if (anyPlaying && remoteControls) {
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
			this._updateMiniControls(anyPlaying, isPaused, hasHistory, hasNext);
		},

		// Mirrors the panel header's remote controls (above), but for the
		// always-visible cluster next to the queue button. Kept as its own
		// method, gated by its own "miniControls" setting, so the two can be
		// toggled independently.
		_updateMiniControls(anyPlaying, isPaused, hasHistory, hasNext) {
			if (!this.miniControls) return;
			const enabled = Settings.get().miniControls;
			this.miniControls.classList.toggle('visible', !!(anyPlaying && enabled));
			if (!anyPlaying || !enabled) return;
			this.miniPlayPauseBtn.textContent = isPaused ? '\u25b6' : '\u23f8';
			this.miniPlayPauseBtn.title = isPaused ? 'Resume' : 'Pause';
			this.miniPlayPauseBtn.classList.toggle('is-paused', isPaused);
			this.miniPrevBtn.disabled = !hasHistory;
			this.miniNextBtn.disabled = !hasNext;
		},

		togglePanel(force) {
			clearTimeout(this._panelLeaveTimer);
			this._panelLeaveTimer = null;
			this.panelOpen = force !== undefined ? force : !this.panelOpen;
			if (this.panelOpen) {
				this.refreshPanel();
				this.panel.classList.add('open');
			} else {
				this.panel.classList.remove('open');
				document.documentElement.classList.remove('ytqm-ui-hover');
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
				this.upNextLabel.style.display = queue.length > 1 ? 'flex' : 'none';
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
				// using the native HTML5 DnD API, without it, the entire row
				// would be draggable and the user couldn't select the title text.
				item.draggable = false;
				item.dataset.queueIndex = queueIdx;

				// Drag handle (☰).
				//   • mousedown enables draggable on the parent (drag-by-handle pattern).
				//   • right-click moves this item to the "next" slot, right after the
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
					// Bail if the item is already there, no-op avoids a needless
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

	const ShortsHider = {
		_styleEl: null,
		// Selectors cover every surface where Shorts appear:
		//   - Mini-guide nav button (the collapsed sidebar icon)
		//   - Full sidebar guide entry
		//   - Search results (ytd-video-renderer with /shorts/ anchor)
		//   - Home / subscriptions grid cards (ytd-rich-item-renderer)
		//   - Shorts shelves and their section wrappers on the home feed
		//   - Compact list cards (ytd-compact-video-renderer)
		//   - Any yt-lockup-view-model (new layout catch-all) linking to /shorts/
		//
		// Identification: Shorts always link to /shorts/… rather than
		// /watch?v=…, so a[href^="/shorts"] is the reliable discriminator.
		// ytd-reel-shelf-renderer is the dedicated shelf YouTube injects for
		// Shorts sections and doesn't need an href check.
		_CSS: [
			// Navigation
			`ytd-mini-guide-entry-renderer:has(a[href^="/shorts"]){display:none!important}`,
			`ytd-guide-entry-renderer:has(a[href^="/shorts"]){display:none!important}`,
			// Cards
			`ytd-video-renderer:has(a[href^="/shorts"]){display:none!important}`,
			`ytd-rich-item-renderer:has(a[href^="/shorts"]){display:none!important}`,
			`ytd-compact-video-renderer:has(a[href^="/shorts"]){display:none!important}`,
			`yt-lockup-view-model:has(a[href^="/shorts"]){display:none!important}`,
			// Shelves and shelf wrappers
			`ytd-reel-shelf-renderer{display:none!important}`,
			`ytd-rich-section-renderer:has(ytd-reel-shelf-renderer){display:none!important}`,
			// Search-page Shorts grid shelf (grid-shelf-view-model with ytm-shorts-lockup items)
			`grid-shelf-view-model:has(a[href^="/shorts"]){display:none!important}`,
		].join(''),
		apply() {
			const shouldHide = Settings.get().hideShorts;
			if (shouldHide && !this._styleEl) {
				this._styleEl = document.createElement('style');
				this._styleEl.id = 'ytqm-hide-shorts';
				this._styleEl.textContent = this._CSS;
				document.head.appendChild(this._styleEl);
				log('ShortsHider: hidden');
			} else if (!shouldHide && this._styleEl) {
				this._styleEl.remove();
				this._styleEl = null;
				log('ShortsHider: restored');
			}
		},
	};

	const InterruptionsBannerHider = {
		_styleEl: null,
		_observer: null,
		// CSS fallback for the promotional mealbar variant of the message
		// ("Experiencing interruptions? Try YouTube TV" etc.).
		_CSS: [
			'ytd-mealbar-promo-renderer{display:none!important}',
			'yt-mealbar-promo-renderer-view-model{display:none!important}',
		].join(''),
		// The common "Experiencing interruptions?" notification is a
		// tp-yt-paper-toast added dynamically to ytd-popup-container. Its #text
		// element is populated asynchronously after insertion, so we check once
		// immediately then retry after a short delay to catch the async render.
		_handleToast(toast) {
			const tryRemove = () => {
				const textEl = toast.querySelector('#text');
				if (textEl && textEl.textContent.includes('Experiencing interruptions')) {
					toast.remove();
					log('InterruptionsBannerHider: removed interruptions toast');
					return true;
				}
				return false;
			};
			if (!tryRemove()) setTimeout(tryRemove, 400);
		},
		apply() {
			const shouldHide = Settings.get().hideInterruptionsBanner;
			if (shouldHide) {
				if (!this._styleEl) {
					this._styleEl = document.createElement('style');
					this._styleEl.id = 'ytqm-hide-interruptions';
					this._styleEl.textContent = this._CSS;
					document.head.appendChild(this._styleEl);
				}
				if (!this._observer) {
					this._observer = new MutationObserver(mutations => {
						if (!Settings.get().hideInterruptionsBanner) return;
						for (const m of mutations) {
							for (const node of m.addedNodes) {
								if (node.nodeType !== 1) continue;
								if (node.matches?.('tp-yt-paper-toast')) {
									this._handleToast(node);
								} else {
									node.querySelectorAll?.('tp-yt-paper-toast')
										.forEach(n => this._handleToast(n));
								}
							}
						}
					});
					this._observer.observe(document.body, { childList: true, subtree: true });
					log('InterruptionsBannerHider: observer active');
				}
			} else {
				if (this._styleEl) { this._styleEl.remove(); this._styleEl = null; }
				if (this._observer) { this._observer.disconnect(); this._observer = null; }
				log('InterruptionsBannerHider: disabled');
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
		// If the user navigated away from a watch page while the queue was
		// playing (clicked the YouTube logo, opened the subscriptions feed,
		// went to a channel, etc.), treat that as an implicit "I'm done with
		// the queue" and stop. Without this, _playing stays true with no
		// <video> to attach to, the stop button is the only way out, and any
		// subsequent yt-navigate-finish will try to re-attach which is
		// surprising. Queue advancement is safe because every advance goes
		// directly /watch?v=X → /watch?v=Y, never via an intermediate
		// non-watch URL (verified from the navigation logs).
		if (Player._playing && !Page.isWatchPage()) {
			log('Navigated off watch page while queue was playing, stopping');
			Player.stop();
		}
		UI.updateControls();
		if (UI.panelOpen) UI.refreshPanel();
		if (Page.isWatchPage()) TheaterMode.init();
		ThumbnailInjector.syncAllButtons();
		SelectorHealth.scheduleCheck();
		UI._applyDockMode();
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
	//   Alt+Q , toggle add/remove current video to queue (watch pages only)
	//   Alt+N , skip to next item in queue (queue must be playing)
	//   Alt+P , go to previous item via history (queue must be playing)
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

			// Require Alt only, reject other modifier combinations so we
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

	// ── Selector Health Check ─────────────────────────────────────────────────
	//
	// This script depends on YouTube's internal element names and class hooks,
	// which YouTube renames without notice (see the SEL object and the Navigator
	// block comment). When that happens a feature stops working *silently* - the
	// queue just quietly fails to advance, the title scrape returns empty, the
	// theater toggle does nothing - and there's no signal pointing at which
	// selector died.
	//
	// SelectorHealth turns that silent failure into a named console warning. It
	// probes the critical selectors a short while after navigation settles and,
	// for any that resolve to nothing on a page where they *should* match, logs
	// one warning identifying the selector and the feature it powers. It is
	// purely diagnostic: it never throws, never mutates the page, and never
	// changes behaviour. The warnings are throttled to once per selector key per
	// session so a persistently-broken selector doesn't spam the console on
	// every navigation.
	//
	// Run it on demand from the console with:
	//   window.ytQueueManager.checkSelectors()
	// which ignores the once-per-session throttle and re-reports everything.

	const SelectorHealth = {
		_warned: new Set(),

		// Each probe names the SEL entry (or literal selector), the feature it
		// backs, and where it should resolve. `where` controls when a miss is
		// meaningful:
		//   'watch'  - only expected on a watch page (player, title, etc.)
		//   'any'    - expected on essentially every YouTube page (the cards
		//              grid, the thumbnail observer roots)
		// `optional: true` marks selectors that legitimately may be absent (e.g.
		// the inline-preview node only exists once the user hovers a thumbnail);
		// those are checked only by the on-demand console call, never auto-run.
		_probes: [
			{ key: 'PLAYER',        sel: SEL.PLAYER,        feature: 'Player attach / playback control', where: 'watch' },
			{ key: 'WATCH_TITLE',   sel: SEL.WATCH_TITLE,   feature: 'Watch-page title scrape (queue add)', where: 'watch' },
			{ key: 'WATCH_FLEXY',   sel: SEL.WATCH_FLEXY,   feature: 'Theater-mode state detection',        where: 'watch' },
			{ key: 'CARD',          sel: SEL.CARD,          feature: 'Thumbnail "+" button injection',      where: 'any' },
			{ key: 'THUMB_ROOTS',   sel: SEL.THUMB_OBSERVER_ROOTS, feature: 'Thumbnail MutationObserver roots', where: 'any' },
			{ key: 'POPUP_TOAST',   sel: 'ytd-popup-container', feature: 'Interruptions-banner observer root', where: 'any' },
			{ key: 'THEATER_BTN',   sel: `${SEL.THEATER_BTN_DATA}, ${SEL.THEATER_BTN_CLASS}`, feature: 'Theater-mode toggle button', where: 'watch', optional: true },
			{ key: 'VIDEO_PREVIEW', sel: SEL.VIDEO_PREVIEW, feature: 'Overlay button reparent target',       where: 'any', optional: true },
		],

		// Probe everything once. `force` (the console entry point) bypasses both
		// the per-session throttle and the optional/relevance gating, so you get
		// a full snapshot regardless of page or prior warnings.
		check(force = false) {
			const onWatch = Page.isWatchPage();
			const results = [];
			for (const p of this._probes) {
				const relevant = p.where === 'any' || (p.where === 'watch' && onWatch);
				const found = !!document.querySelector(p.sel);
				results.push({ ...p, found, relevant });

				if (force) continue; // console path reports via the return value below

				if (p.optional) continue;        // optional selectors aren't auto-warned
				if (!relevant) continue;          // wrong page type, a miss is expected
				if (found) { this._warned.delete(p.key); continue; } // recovered, allow future warnings
				if (this._warned.has(p.key)) continue;               // already warned this session

				this._warned.add(p.key);
				warn(`Selector health: "${p.sel}" (${p.key}) matched nothing on a page where it is expected. ` +
					`Feature likely broken: ${p.feature}. YouTube may have renamed this element.`);
			}

			if (force) {
				// Pretty console table for manual inspection. Returns the raw
				// rows too so it's usable programmatically.
				const rows = results.map(r => ({
					key: r.key,
					feature: r.feature,
					where: r.where + (r.optional ? ' (optional)' : ''),
					relevantNow: r.relevant,
					found: r.found,
				}));
				try { console.table(rows); } catch { /* console.table absent in some engines */ }
				return rows;
			}
			return results;
		},

		// Auto-run hook: fired from onUrlChange after a settle delay so YouTube
		// has rendered the new page before we probe it.
		scheduleCheck() {
			clearTimeout(this._timer);
			this._timer = setTimeout(() => this.check(false), URL_CHANGE_SETTLE_MS + 800);
		},
	};

	// ── Boot ──────────────────────────────────────────────────────────────────

	function tryInit() {
		if (!document.body) {
			setTimeout(tryInit, 100);
			return;
		}
		// Always-on banner, prints regardless of DEBUG. Confirms the script
		// loaded, shows the version (so you can verify a Tampermonkey reload
		// actually picked up your edits), and reminds you how to flip the
		// debug flag if you want the verbose logs.
		console.info(LOG_PREFIX, `v${VERSION} loaded. Verbose logging is ${DEBUG ? 'ON' : 'OFF'}, localStorage.setItem('ytqm_debug', true|false).`);
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
				zIndex: '200000', // sit above YouTube's chrome, was '1' which got buried
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
		ShortsHider.apply();
		InterruptionsBannerHider.apply();
		KeyboardShortcuts.init();
		if (Page.isWatchPage()) TheaterMode.init();
		if (Settings.get().enqueueFromPhone) PhonePoller.start();
		SelectorHealth.scheduleCheck();

		// Recover playback state after a page refresh.
		//
		// Conditions for auto-resume:
		//   - Storage.playing flag is set (some tab was playing)
		//   - There's something to resume to
		//   - The boot URL matches the queue head video ID
		//
		// The last condition is what disambiguates "user refreshed mid-queue
		// on the queue-head watch page" (the case we want to handle) from
		// false positives that previously triggered an unwanted auto-jump:
		//   1. Opening a new tab while another tab is playing the queue:
		//      Storage.playing is true, but this new tab is on the homepage,
		//      not the queue head. Without the URL check the new tab would
		//      steal playback ownership and forcibly navigate itself to the
		//      queue head.
		//   2. Browser crash / forced kill of the playing tab: beforeunload
		//      didn't fire, so Storage.playing stays true indefinitely. Any
		//      later tab open would trigger an unwanted resume. With the URL
		//      check, the flag is just inert until the user does something
		//      that overwrites it (Play or Stop).
		//   3. User manually navigated to a different watch page while the
		//      queue was playing, then refreshed: the URL is no longer the
		//      queue head, so we don't fight the user's nav choice.
		//
		// We deliberately do NOT clear Storage.playing in the don't-resume
		// case. Another tab may legitimately be playing right now, and
		// clearing the flag would break its own future refresh-recovery.
		// The flag is self-healing, the next Player.start or Player.stop
		// from any tab will overwrite it.
		const _bootState = Storage.load();
		if (_bootState.playing && _bootState.queue.length > 0) {
			const currentId = getVideoId(location.href);
			const queueHeadId = getVideoId(_bootState.queue[0].url);
			if (currentId && currentId === queueHeadId) {
				log('Resuming queue after page refresh, queue has', _bootState.queue.length, 'items.');
				Player.start();
			} else {
				log('Persisted playing flag but boot URL does not match queue head, not auto-resuming. ' +
					'(boot URL id:', currentId, ', queue head id:', queueHeadId, ')');
			}
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
	//     SPA-navigates to the front of the queue and ensures playback resumes.
	//     Note: as of 2.1.0 this no longer triggers a hard page reload, the
	//     name is kept for API compatibility but it now uses Navigator.goTo
	//     like every other navigation in the script.
	//
	//   window.ytQueueManager.reloadAndResume('https://www.youtube.com/watch?v=XYZ')
	//   window.ytQueueManager.reloadAndResume('XYZ')
	//     Splices the given video to the front of the queue (if not already
	//     there) and SPA-navigates to it.
	//
	//   window.ytQueueManager.setDebug(true|false)
	//     Toggle verbose [YT-Q] logging at runtime. The choice is persisted
	//     to localStorage under DEBUG_KEY so it survives page reloads.
	//
	//   window.ytQueueManager.getState()
	//     Snapshot of the current queue/history/flags, useful for inspection
	//     or debugging, returns a plain object, not a live reference.
	//
	//   window.ytQueueManager.version
	//     The userscript @version string, surfaced for sanity-checking which
	//     build is actually running on a page.
	//
	//   window.ytQueueManager.checkSelectors()
	//     Probe every YouTube selector the script depends on and print a table
	//     of which ones currently resolve. Use this when a feature stops working
	//     to see at a glance which element YouTube has renamed. Returns the rows
	//     as an array as well. Ignores the once-per-session warning throttle.
	//
	window.ytQueueManager = {
		version: VERSION,
		reloadAndResume: (url) => Player.reloadAndResume(url),
		checkSelectors: () => SelectorHealth.check(true),
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
