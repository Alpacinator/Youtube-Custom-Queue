// ==UserScript==
// @name YouTube Queue Manager
// @namespace https://github.com/Alpacinator/Youtube-Custom-Queue/
// @version 1.4.0
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

	const STORAGE_KEY = 'yt_queue_manager_v1';
	const PLAYING_KEY = 'yt_queue_playing_tab';
	const HEARTBEAT_KEY = 'yt_queue_heartbeat';
	const SKIP_KEY = 'yt_queue_skip_signal';
	const SETTINGS_KEY = 'yt_queue_settings_v1';
	const HEARTBEAT_INTERVAL_MS = 3000;
	const HEARTBEAT_TTL_MS = 10000;
	const VIDEO_END_THRESHOLD_S = 2;
	const HISTORY_MAX = 10;
	const NAV_TIMEOUT_MS = 30000;
	const ATTACH_POLL_INTERVAL_MS = 500;
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

	const THUMB_BTN_GREEN_RGB = '0,210,100';
	const THUMB_BTN_RED_RGB = '220,50,50';
	const THUMB_BTN_BLUE_RGB = '30,144,255';
	const THUMB_BTN_OPACITY = 0.45;

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
	};

	const SEL = {
		CARD: [
			'yt-lockup-view-model',        // element tag (new YouTube layout)
			'.yt-lockup-view-model',       // class fallback (older layout)
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
	function log(...args) { console.log(LOG_PREFIX, ...args); }
	function warn(...args) { console.warn(LOG_PREFIX, ...args); }

	/** Collision-safe ID: millisecond timestamp * 1000 + random 0-999 integer. */
	function _uid() { return Date.now() * 1000 + (Math.random() * 1000 | 0); }

	const TAB_ID = (() => {
		let id = sessionStorage.getItem('ytqm_tab_id');
		if (!id) { id = Math.random().toString(36).slice(2); sessionStorage.setItem('ytqm_tab_id', id); }
		return id;
	})();

	// ── Settings ──────────────────────────────────────────────────────────────

	const Settings = {
		_defaults() { return { ...SETTINGS_DEFAULTS }; },
		get() {
			try {
				const raw = localStorage.getItem(SETTINGS_KEY);
				return Object.assign(this._defaults(), raw ? JSON.parse(raw) : {});
			} catch { return this._defaults(); }
		},
		set(key, value) {
			const s = this.get(); s[key] = value;
			try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
		},
	};

	// ── Storage ───────────────────────────────────────────────────────────────

	const Storage = {
		_cache: null,
		_defaults() { return { queue: [], history: [], paused: false }; },
		_invalidate() { this._cache = null; },
		load() {
			if (this._cache) return this._cache;
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (!raw) { this._cache = this._defaults(); return this._cache; }
				const p = JSON.parse(raw);
				if (p.paused === undefined) p.paused = false;
				if (!Array.isArray(p.history)) p.history = [];
				delete p.playing;
				this._cache = p;
				return this._cache;
			} catch (e) {
				warn('Storage.load failed:', e);
				this._cache = this._defaults();
				return this._cache;
			}
		},
		save(state) {
			try {
				this._cache = state;
				localStorage.setItem(STORAGE_KEY, JSON.stringify({ queue: state.queue, history: state.history, paused: state.paused }));
			} catch (e) { warn('Storage.save failed:', e); }
		},
		get queue() { return [...this.load().queue]; },
		get history() { return [...this.load().history]; },
		get paused() { return this.load().paused; },
		setPaused(val) { const s = this.load(); s.paused = val; this.save(s); },
		pushHistory(video) {
			const s = this.load();
			s.history.push({ ...video, id: _uid() });
			if (s.history.length > HISTORY_MAX) s.history.shift();
			this.save(s);
			log('History push:', video.title, '— depth:', s.history.length);
		},
		popHistory() {
			const s = this.load();
			const prev = s.history.pop();
			this.save(s);
			return prev || null;
		},
		addVideo(url, title, channel = '') {
			const s = this.load();
			if (s.queue.find(v => v.url === url)) { log('Already in queue:', url); return false; }
			s.queue.push({ url, title, channel, id: _uid() });
			this.save(s);
			log('Added to queue:', title);
			return true;
		},
		removeVideo(id) {
			const s = this.load();
			s.queue = s.queue.filter(v => v.id !== id);
			this.save(s);
		},
		removeVideoByUrl(url) {
			const s = this.load();
			s.queue = s.queue.filter(v => v.url !== url);
			this.save(s);
		},
		shiftQueue() {
			const s = this.load();
			const next = s.queue.shift();
			this.save(s);
			return next;
		},
		peekFirst() { return this.load().queue[0] || null; },
		insertNext(url, title, channel = '', insertAt = 0) {
			const s = this.load();
			s.queue = s.queue.filter(v => v.url !== url);
			s.queue.splice(insertAt, 0, { url, title, channel, id: _uid() });
			this.save(s);
			log('Inserted as next:', title, 'at index', insertAt);
		},
		/**
		 * Moves a queue item from index `from` to index `to`.
		 * No clamping: callers pass actual queue indices directly.
		 * The "now playing" item (index 0 when playing) is visually separated
		 * in the UI so it never appears in the draggable list — no need to guard it here.
		 */
		reorder(from, to) {
			if (from === to) return;
			const s = this.load();
			const [item] = s.queue.splice(from, 1);
			s.queue.splice(to, 0, item);
			this.save(s);
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
		isOwner() { return localStorage.getItem(PLAYING_KEY) === TAB_ID; },
		anyPlaying() {
			if (this.isOwner()) return true;
			if (!localStorage.getItem(PLAYING_KEY)) return false;
			const ts = parseInt(localStorage.getItem(HEARTBEAT_KEY) || '0', 10);
			return (Date.now() - ts) < HEARTBEAT_TTL_MS;
		},
		_beat() { localStorage.setItem(HEARTBEAT_KEY, Date.now().toString()); },
	};

	window.addEventListener('beforeunload', () => PlayingTab.release());

	const Page = {
		isWatchPage() { return !!new URLSearchParams(location.search).get('v'); },
	};

	// ── Navigator ─────────────────────────────────────────────────────────────

	const Navigator = {
		goTo(url) {
			const parsed = new URL(url, location.origin);
			const navPath = parsed.pathname + parsed.search;
			const expectedId = parsed.searchParams.get('v');
			log('Navigating to:', navPath);

			const queueUrls = new Set(Storage.queue.map(v => {
				try { return new URL(v.url, location.origin).searchParams.get('v'); } catch { return null; }
			}).filter(Boolean));

			const anchor = [...document.querySelectorAll('a[href*="/watch?v="]')].find(a => {
				try {
					const vid = new URL(a.href, location.origin).searchParams.get('v');
					return vid && !queueUrls.has(vid);
				} catch { return false; }
			});

			if (!anchor) {
				// No anchor to hijack — use pushState + synthetic yt-navigate-finish so
				// the script stays alive and Player._waitForVideoAndPlay() fires normally.
				log('No anchor found — using pushState SPA navigation');
				history.pushState({}, '', navPath);
				window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
				return;
			}

			let mutated = false;
			const handler = e => {
				if (!e.detail?.endpoint) return;
				const ep = e.detail.endpoint;
				if (!mutated) {
					log('Mutating yt-navigate endpoint to', expectedId);
					// Handle both watch-page shape (watchEndpoint) and non-watch-page shape
					// (reelWatchEndpoint, browseEndpoint, etc. — normalise to watchEndpoint).
					if (ep.watchEndpoint) {
						ep.watchEndpoint.videoId = expectedId;
					} else {
						Object.keys(ep).forEach(k => { if (k.endsWith('Endpoint') || k.endsWith('endpoint')) delete ep[k]; });
						ep.watchEndpoint = { videoId: expectedId };
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

			window.addEventListener('yt-navigate', handler, { capture: true });
			setTimeout(() => window.removeEventListener('yt-navigate', handler, { capture: true }), 2000);
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
		_pendingSeekToStart: false,
		_navStartTime: null,
		_listenerAbort: null,   // AbortController for the current video's event listeners

		start() {
			this._playing = true;
			PlayingTab.claim();
			Storage.setPaused(false);
			const first = Storage.peekFirst();
			if (!first) { this.stop(); return; }
			UI.updateControls();
			const currentId = new URLSearchParams(location.search).get('v');
			let expectedId;
			try { expectedId = new URL(first.url, location.origin).searchParams.get('v'); }
			catch { this.stop(); return; }
			if (currentId === expectedId) {
				log('Already on the correct page — attaching directly');
				this._waitForVideoAndPlay();
			} else {
				Navigator.goTo(first.url);
			}
		},

		stop() {
			log('Stopping queue');
			if (this._ensurePlayingTimer) { clearTimeout(this._ensurePlayingTimer); this._ensurePlayingTimer = null; }
			this._playing = false;
			this._userPaused = false;
			this._attachedVideoId = null;
			this._navigatingToPrev = false;
			this._navStartTime = null;
			PlayingTab.release();
			Storage.setPaused(false);
			this._clearEndPoll();
			this._detachVideoListeners();
			this._unregisterMediaSession();
			UI.updateControls();
			UI.showStatus('Queue stopped');
		},

		remotePause() { Storage.setPaused(true); UI.updateRemotePauseBtn(); },
		remoteResume() { Storage.setPaused(false); UI.updateRemotePauseBtn(); },

		remoteSkip() {
			if (this._playing) { this.skip(); return; }
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
				if (Storage.paused) { this._endPollTimer = setTimeout(check, 1000); return; }
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
			if (this._endPollTimer) { clearTimeout(this._endPollTimer); this._endPollTimer = null; }
		},

		_waitForVideoAndPlay() {
			if (!this._playing) return;
			this._navStartTime = Date.now();
			const first = Storage.peekFirst();
			if (!first) { this.stop(); return; }
			let expectedId;
			try { expectedId = new URL(first.url, location.origin).searchParams.get('v'); }
			catch { this.stop(); return; }

			const tryAttach = () => {
				if (!this._playing) return false;
				if (new URLSearchParams(location.search).get('v') !== expectedId) return false;
				const video = document.querySelector('video');
				if (!video) return false;
				const playerEl = document.querySelector('#movie_player');
				if (playerEl && typeof playerEl.getVideoData === 'function') {
					const data = playerEl.getVideoData();
					if (data?.video_id && data.video_id !== expectedId) return false;
				}
				return video.readyState >= 1 || video.currentTime > 0;
			};

			if (tryAttach()) { this._onVideoReady(document.querySelector('video'), first); return; }

			let resolved = false;
			const pollTimer = setInterval(() => {
				if (!tryAttach()) return;
				clearInterval(pollTimer);
				clearTimeout(fallbackTimer);
				if (resolved) return;
				resolved = true;
				const video = document.querySelector('video');
				if (video) this._onVideoReady(video, first);
				else { warn('No <video> after resolve — stopping'); this.stop(); }
			}, ATTACH_POLL_INTERVAL_MS);

			const fallbackTimer = setTimeout(() => {
				clearInterval(pollTimer);
				if (resolved) return;
				resolved = true;
				warn('Timed out waiting for <video> — stopping queue');
				this.stop();
			}, NAV_TIMEOUT_MS);
		},

		_onVideoReady(video, queueItem) {
			const videoId = new URLSearchParams(location.search).get('v');
			if (videoId && videoId === this._attachedVideoId) {
				log('_onVideoReady: already attached for', videoId, '— skipping');
				return;
			}
			this._attachedVideoId = videoId;
			this._navigatingToPrev = false;   // unlock repeated previous presses
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
			const play = () => { video.play().catch(() => this._clickPlayButton()); };
			const seekThenPlay = () => {
				video.currentTime = 0;
				video.addEventListener('seeked', play, { once: true });
			};
			const whenReady = (fn) => {
				if (video.readyState >= 3) fn();
				else video.addEventListener('canplay', fn, { once: true });
			};
			video.pause();
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
			const { signal } = this._listenerAbort;

			video.addEventListener('pause', () => {
				if (!this._playing || video.ended || Storage.paused) return;
				if (Date.now() - (video._ytqmAttachedAt || 0) < 3000) { log('Ignoring early pause event'); return; }
				this._userPaused = true;
				log('Video paused by user');
				UI.showStatus('Paused', 99999);
			}, { signal });

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
			}, { signal });

			video.addEventListener('ended', () => UI.showStatus('Advancing queue…'), { signal });
			video.addEventListener('waiting', () => UI.showStatus('Buffering…', 5000), { signal });
			video.addEventListener('durationchange', () => {
				if (this._playing && !isNaN(video.duration)) this._scheduleEndPoll(video);
			}, { signal });

			video.addEventListener('canplay', () => {
				if (!this._pendingSeekToStart) return;
				this._pendingSeekToStart = false;
				video.currentTime = 0;
				video.addEventListener('seeked', () => {
					if (!this._userPaused && !Storage.paused) video.play().catch(() => this._clickPlayButton());
				}, { once: true });
			}, { once: true, signal });
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

		skip() { if (this._playing) this.advance(); },

		previous() {
			if (!this._playing) return;
			if (this._navigatingToPrev) { log('previous(): navigation already in flight — ignoring'); return; }
			const prev = Storage.popHistory();
			if (!prev) {
				UI.showStatus('No previous track', 2000);
				log('previous(): history is empty');
				this._registerMediaSession();
				return;
			}
			log('Going to previous:', prev.title);
			const s = Storage.load();
			s.queue.unshift({ ...prev, id: _uid() });
			Storage.save(s);
			this._attachedVideoId = null;
			this._navigatingToPrev = true;
			UI.refreshPanel();
			Navigator.goTo(prev.url);
		},

		_registerMediaSession() {
			if (!('mediaSession' in navigator)) { warn('MediaSession API not available'); return; }
			const register = (label = 'MediaSession handlers registered') => {
				navigator.mediaSession.setActionHandler('nexttrack', () => { log('MediaSession: nexttrack'); UI.showStatus('Skipping…', 2000); this.skip(); });
				navigator.mediaSession.setActionHandler('previoustrack', () => { log('MediaSession: previoustrack'); UI.showStatus('Going to previous…', 2000); this.previous(); });
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
			if (this._mediaSessionRefreshTimer) { clearInterval(this._mediaSessionRefreshTimer); this._mediaSessionRefreshTimer = null; }
		},

		_unregisterMediaSession() {
			if (!('mediaSession' in navigator)) return;
			this._stopMediaSessionRefresh();
			try { navigator.mediaSession.setActionHandler('nexttrack', null); } catch {}
			try { navigator.mediaSession.setActionHandler('previoustrack', null); } catch {}
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
			} catch (e) { warn('MediaSession metadata error:', e); }
		},

		_clickPlayButton() {
			const overlay = document.querySelector(SEL.PLAY_OVERLAY);
			if (overlay) { overlay.click(); return; }
			const toolbar = document.querySelector(SEL.PLAY_TOOLBAR);
			if (toolbar) {
				if ((toolbar.getAttribute('aria-label') || '').toLowerCase().includes('pause')) return;
				toolbar.click();
				return;
			}
			const player = document.querySelector(SEL.PLAYER);
			if (player) player.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', keyCode: 75, bubbles: true }));
		},
	};

	// ── QueueIO ───────────────────────────────────────────────────────────────

	const QueueIO = {
		async exportToClipboard() {
			const state = Storage.load();
			const payload = {
				_ytqm: true,
				exportedAt: new Date().toISOString(),
				queue: state.queue.map(({ url, title, channel }) => ({ url, title, channel })),
			};
			const json = JSON.stringify(payload, null, 2);
			try {
				await navigator.clipboard.writeText(json);
				log('Exported', payload.queue.length, 'items to clipboard');
				return { ok: true, count: payload.queue.length };
			} catch (e) {
				warn('Clipboard write failed:', e);
				return { ok: false, count: 0 };
			}
		},

		async importFromClipboard() {
			let text;
			try {
				text = await navigator.clipboard.readText();
			} catch (e) {
				warn('Clipboard read failed:', e);
				return { ok: false, added: 0, error: 'Clipboard read failed — check browser permissions.' };
			}

			let parsed;
			try { parsed = JSON.parse(text.trim()); }
			catch { return { ok: false, added: 0, error: 'Invalid JSON — could not parse clipboard contents.' }; }

			const items = Array.isArray(parsed)
				? parsed
				: (parsed?._ytqm && Array.isArray(parsed.queue)) ? parsed.queue : null;

			if (!items) return { ok: false, added: 0, error: 'Unrecognised format. Expected a YT Queue export or a plain array of {url, title} objects.' };

			const valid = items.filter(item => {
				if (typeof item?.url !== 'string') return false;
				try { const u = new URL(item.url); return u.searchParams.has('v'); }
				catch { return false; }
			});

			if (valid.length === 0) return { ok: false, added: 0, error: 'No valid YouTube watch URLs found in the import data.' };

			const s = Storage.load();
			const existing = new Set(s.queue.map(v => v.url));
			const newItems = valid
				.filter(v => !existing.has(v.url))
				.map(({ url, title, channel }) => ({
					url, title: title || 'Untitled video', channel: channel || '', id: _uid(),
				}));
			s.queue = [...s.queue, ...newItems];

			Storage.save(s);
			Storage._invalidate();
			log('Imported', newItems.length, 'items');
			UI.updateControls();
			if (UI.panelOpen) UI.refreshPanel();
			ThumbnailInjector.syncAllButtons();
			return { ok: true, added: newItems.length };
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
				const res = await fetch(pollUrl, { signal: AbortSignal.timeout(2500) });
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
				window.dispatchEvent(new CustomEvent('ytqm-spotify-track', { detail: { uri: data.track } }));
			}

			// Handle YouTube queue URL (new behaviour)
			if (data.youtube_url) {
				log('PhonePoller: received queue URL', data.youtube_url);
				try {
					const parsed = new URL(data.youtube_url);
					const videoId = parsed.searchParams.get('v');
					if (!videoId) { warn('PhonePoller: no video ID in URL', data.youtube_url); return; }
					const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
					const title = (data.title && data.title.trim()) ? data.title.trim() : 'Shared from phone';
					const added = Storage.addVideo(watchUrl, title, '');
					if (added) {
						Storage._invalidate();
						UI.updateControls();
						if (UI.panelOpen) UI.refreshPanel();
						ThumbnailInjector.syncAllButtons();
						UI.showStatus('📱 Video added from phone', 4000);
						log('PhonePoller: enqueued', watchUrl);
					} else {
						log('PhonePoller: video already in queue, skipping');
					}
				} catch (e) {
					warn('PhonePoller: failed to parse queue_url:', e);
				}
			}
		},
	};

	// ── ThumbnailInjector ─────────────────────────────────────────────────────

	const ThumbnailInjector = {
		_observer: null,
		_pruneTimer: null,
		_cards: new Map(),

		start() {
			this._injectAll();
			setTimeout(() => this._injectAll(), 800);
			setTimeout(() => this._injectAll(), 2000);
			this._observe();
			this._startHoverTracking();
			this._pruneTimer = setInterval(() => {
				this._cards.forEach((entry, card) => {
					if (!document.contains(card)) { clearTimeout(entry.hideTimer); this._cards.delete(card); }
				});
			}, THUMBNAIL_PRUNE_MS);
		},

		stop() {
			if (this._observer) { this._observer.disconnect(); this._observer = null; }
			if (this._pruneTimer) { clearInterval(this._pruneTimer); this._pruneTimer = null; }
			this._cards.forEach(({ hideTimer }) => clearTimeout(hideTimer));
			this._cards.clear();
		},

		syncAllButtons() {
			const queue = Storage.queue;
			this._cards.forEach((entry) => {
				const inQueue = queue.some(v => v.url === entry.videoUrl);
				const currentState = entry.btn._ytqmState;
				if (inQueue && currentState !== 'dupe') this._applyState(entry, 'dupe');
				else if (!inQueue && currentState === 'dupe') this._applyState(entry, 'idle');
			});
		},

		_startHoverTracking() {
			document.addEventListener('mouseenter', e => {
				const card = e.target.closest?.(SEL.CARD)
					|| e.target.closest?.(SEL.VIDEO_PREVIEW)
					|| e.target.closest?.('.ytp-suggestion-set');
				if (!card) return;
				const entry = this._cards.get(card);
				if (!entry) return;
				clearTimeout(entry.hideTimer);
				entry.hideTimer = null;
				entry.btn.style.opacity = '1';
				entry.btn.style.transform = 'translateY(0)';
			}, true);

			document.addEventListener('mouseleave', e => {
				const card = e.target.closest?.(SEL.CARD)
					|| e.target.closest?.(SEL.VIDEO_PREVIEW)
					|| e.target.closest?.('.ytp-suggestion-set');
				if (!card) return;
				const rel = e.relatedTarget;
				if (
					rel?.closest?.(SEL.CARD) === card ||
					rel?.closest?.(SEL.VIDEO_PREVIEW) === card ||
					rel?.closest?.('.ytp-suggestion-set') === card
				) return;
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

		_observe() {
			this._observer = new MutationObserver(mutations => {
				for (const m of mutations) {
					m.addedNodes.forEach(node => {
						if (node.nodeType !== Node.ELEMENT_NODE) return;

						// Handle ytd-video-preview containers (inline thumbnail player).
						// The button must live on the outer ytd-video-preview wrapper so it
						// survives YouTube swapping out ytd-thumbnail for ytd-player on hover.
						if (node.matches?.('ytd-video-preview')) this._tryInjectVideoPreview(node);
						node.querySelectorAll('ytd-video-preview').forEach(vp => this._tryInjectVideoPreview(vp));

						this._tryInjectAnchor(node);
						node.querySelectorAll('a[href*="/watch?v="]').forEach(a => this._tryInjectAnchor(a));
						node.querySelectorAll(SEL.VIDEOWALL_ANCHOR).forEach(a => this._tryInjectVideowall(a));
					});
				}
			});
			const roots = [...document.querySelectorAll(SEL.THUMB_OBSERVER_ROOTS)];
			const target = roots.length ? roots[0] : document.body;
			this._observer.observe(target, { childList: true, subtree: true });
		},

		// Inject into ytd-video-preview wrappers. These wrap the inline hover-player
		// that YouTube renders when you mouse over a card. The ytd-thumbnail inside
		// gets replaced by ytd-player during hover, so any button injected there
		// disappears. Anchoring to the outer ytd-video-preview avoids the swap.
		_tryInjectVideoPreview(vpNode) {
			if (vpNode.dataset.ytqmVpInjected) return;
			const anchor = vpNode.querySelector('a[href*="/watch?v="]');
			if (!anchor) return;
			vpNode.dataset.ytqmVpInjected = '1';
			// Signal to _injectButton to use this node as the positioning container
			// rather than walking up to ytd-thumbnail (which will be swapped out).
			anchor._ytqmVpContainer = vpNode;
			this._injectButton(anchor, false);
		},

		_tryInjectAnchor(node) {
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			if (
				node.matches('a[href*="/watch?v="]') &&
				node.querySelector('img') &&
				!node.dataset.ytqmInjected          // ← data-attr check instead of DOM query
			) {
				this._injectButton(node, false);
			}
		},

		_tryInjectVideowall(anchor) {
			if (!anchor.querySelector('.ytqm-thumb-add-btn')) this._injectButton(anchor, true);
		},

		_injectAll() {
			// Handle any ytd-video-preview already in the DOM (e.g. on initial load).
			document.querySelectorAll('ytd-video-preview').forEach(vp => {
				if (!vp.dataset.ytqmVpInjected) this._tryInjectVideoPreview(vp);
			});

			document.querySelectorAll('a[href*="/watch?v="]').forEach(anchor => {
				if (!anchor.querySelector('img')) return;
				if (anchor.dataset.ytqmInjected) return;   // ← data-attr check instead of DOM query
				this._injectButton(anchor, false);
			});
			document.querySelectorAll(SEL.VIDEOWALL_ANCHOR).forEach(anchor => {
				if (anchor.querySelector('.ytqm-thumb-add-btn')) return;
				this._injectButton(anchor, true);
			});
		},

		_extractVideoMeta(anchor, card, isVideowall) {
			let title = '', channel = '';
			if (isVideowall) {
				title = anchor.querySelector('.ytp-modern-videowall-still-info-title')?.textContent?.trim() || '';
				channel = anchor.querySelector('.ytp-modern-videowall-still-info-author')?.textContent?.trim() || '';
				if (!title) {
					const aria = anchor.getAttribute('aria-label') || '';
					title = aria.replace(/\s+\d[\d:, ]*(seconds?|minutes?|hours?)[^)]*$/i, '').trim();
				}
			} else {
				const candidates = [
					() => card.querySelector('h3[title]')?.getAttribute('title'),
					() => card.querySelector('a[aria-label]')?.getAttribute('aria-label')?.replace(/\s+\d[\d:, ]*(seconds?|minutes?|hours?)[^)]*$/i, '').trim(),
					() => card.querySelector('[class*="title"] span, h3 a span')?.textContent?.trim(),
					() => card.querySelector('#video-title')?.textContent?.trim(),
					() => anchor.querySelector('img')?.alt?.trim(),
				];
				for (const fn of candidates) {
					try { const t = fn(); if (t?.length > 0) { title = t; break; } } catch {}
				}
				channel = card.querySelector('[class*="channel-name"] a, [href*="/@"]')?.textContent?.trim() || '';
			}
			return { title: title || 'Untitled video', channel };
		},

		_applyState(entry, state, resetAfterMs = null) {
			const { btn, tooltip } = entry;
			btn._ytqmState = state;
			clearTimeout(btn._ytqmResetTimer);
			btn._ytqmResetTimer = null;
			const setText = t => { if (btn.childNodes[0]?.nodeType === Node.TEXT_NODE) btn.childNodes[0].nodeValue = t; };
			switch (state) {
				case 'idle':
					btn.style.background = `rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '0'; btn.style.transform = 'translateY(-4px)';
					setText('\u002b'); tooltip.textContent = 'Add to Queue'; break;
				case 'added':
					btn.style.background = `rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '1'; btn.style.transform = 'translateY(0)';
					setText('\u2713'); tooltip.textContent = 'Added!'; break;
				case 'dupe':
					btn.style.background = `rgba(${THUMB_BTN_RED_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '0'; btn.style.transform = 'translateY(-4px)';
					setText('\u2715'); tooltip.textContent = 'In queue — click to remove'; break;
				case 'removed':
					btn.style.background = `rgba(${THUMB_BTN_RED_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '1'; btn.style.transform = 'translateY(0)';
					setText('\u2212'); tooltip.textContent = 'Removed from queue'; break;
				case 'next':
					btn.style.background = `rgba(${THUMB_BTN_BLUE_RGB},${THUMB_BTN_OPACITY})`;
					btn.style.opacity = '1'; btn.style.transform = 'translateY(0)';
					setText('\u23ed'); tooltip.textContent = 'Playing next!'; break;
			}
			if (resetAfterMs !== null) btn._ytqmResetTimer = setTimeout(() => this._applyState(entry, 'idle'), resetAfterMs);
		},

		_injectButton(anchor, isVideowall = false) {
			let videoId, videoUrl;
			try {
				const parsed = new URL(anchor.getAttribute('href') || '', location.origin);
				videoId = parsed.searchParams.get('v');
				if (!videoId) return;
				videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
			} catch { return; }

			// Priority order for the positioning container:
			//   1. _ytqmVpContainer — set by _tryInjectVideoPreview for inline hover-players.
			//      ytd-video-preview survives the ytd-thumbnail → ytd-player DOM swap on hover.
			//   2. ytd-thumbnail — safe wrapper for normal grid/list thumbnails.
			//   3. parentElement / anchor itself — last-resort fallbacks.
			const container = isVideowall
				? anchor
				: (anchor._ytqmVpContainer ?? anchor.closest('ytd-thumbnail') ?? anchor.parentElement ?? anchor);

			container.style.position = 'relative';

			// Mark the anchor with a data attribute so subsequent injection passes
			// can skip it without querying into a container the button no longer
			// lives in (since the button is now a child of `container`, not `anchor`).
			if (!isVideowall) anchor.dataset.ytqmInjected = '1';

			const card = isVideowall
				? anchor
				: (anchor._ytqmVpContainer ?? anchor.closest(SEL.CARD) ?? anchor);

			const btn = document.createElement('button');
			btn.className = 'ytqm-thumb-add-btn';
			btn._ytqmState = 'idle';
			Object.assign(btn.style, {
				position: 'absolute', top: '8px', left: '8px', zIndex: '9999',
				width: '36px', height: '36px', borderRadius: '50%',
				border: '1.5px solid rgba(255,255,255,0.8)',
				background: `rgba(${THUMB_BTN_GREEN_RGB},${THUMB_BTN_OPACITY})`,
				backdropFilter: 'blur(4px)', color: '#fff', fontSize: '18px',
				lineHeight: '1', cursor: 'pointer', display: 'flex',
				alignItems: 'center', justifyContent: 'center', padding: '0',
				fontFamily: "'Segoe UI', Arial, system-ui, sans-serif",
				boxShadow: '0 2px 8px rgba(0,0,0,0.5)', pointerEvents: 'all',
				opacity: '0', transform: 'translateY(-4px)',
				transition: 'opacity 0.25s ease, transform 0.25s ease, background 0.2s ease',
			});
			btn.textContent = '\u002b';

			const tooltip = document.createElement('div');
			Object.assign(tooltip.style, {
				position: 'absolute', bottom: '36px', left: '50%', transform: 'translateX(-50%)',
				background: 'rgba(0,0,0,0.88)', color: '#fff', fontSize: '11px',
				fontFamily: "'Segoe UI', Arial, system-ui, sans-serif", fontWeight: '600',
				padding: '4px 9px', borderRadius: '6px', whiteSpace: 'nowrap',
				pointerEvents: 'none', opacity: '0', transition: 'opacity 0.15s ease',
				zIndex: '10000', border: '1px solid rgba(255,255,255,0.15)',
			});
			tooltip.textContent = 'Add to Queue';
			btn.appendChild(tooltip);
			btn.addEventListener('mouseenter', () => { tooltip.style.opacity = '1'; });
			btn.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });

			const entry = { btn, tooltip, hideTimer: null, videoUrl };

			if (Storage.queue.some(v => v.url === videoUrl)) this._applyState(entry, 'dupe');

			btn.addEventListener('click', e => {
				e.preventDefault(); e.stopPropagation();
				if (btn._ytqmState === 'dupe') {
					Storage.removeVideoByUrl(videoUrl);
					UI.updateControls();
					if (UI.panelOpen) UI.refreshPanel();
					this._applyState(entry, 'removed', BTN_TEMP_TEXT_DURATION_MS);
					setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
					return;
				}
				const { title, channel } = this._extractVideoMeta(anchor, card, isVideowall);
				const added = Storage.addVideo(videoUrl, title, channel);
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
				e.preventDefault(); e.stopPropagation();
				const { title, channel } = this._extractVideoMeta(anchor, card, isVideowall);
				const insertAt = Player._playing && Storage.queue.length > 0 ? 1 : 0;
				Storage.insertNext(videoUrl, title, channel, insertAt);
				this._applyState(entry, 'next', BTN_TEMP_TEXT_DURATION_MS);
				setTimeout(() => this.syncAllButtons(), BTN_TEMP_TEXT_DURATION_MS + 50);
				UI.updateControls();
				if (UI.panelOpen) UI.refreshPanel();
			});

			container.appendChild(btn);
			this._cards.set(card, entry);
		},
	};

	// ── UI ────────────────────────────────────────────────────────────────────

	const UI = {
		host: null, shadow: null, root: null,
		addBtn: null, playBtn: null, remotePauseBtn: null,
		skipBtn: null, prevBtn: null, queueToggleBtn: null,
		panel: null, list: null, nowPlayingSection: null, upNextLabel: null,
		settingsOverlay: null, panelOpen: false,
		_dragSrcIndex: null,
		addBtnFlash: null, addBtnLabel: null, _addBtnFlashTimer: null,

		init() {
			document.getElementById('ytqm-host')?.remove();
			this.host = document.createElement('div');
			this.host.id = 'ytqm-host';
			Object.assign(this.host.style, { position: 'fixed', bottom: '0', left: '0', zIndex: '100', pointerEvents: 'none', width: '0', height: '0' });
			this.shadow = this.host.attachShadow({ mode: 'open' });
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

		_cssReset() { return `* { box-sizing: border-box; margin: 0; padding: 0; }`; },

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
        #ytqm-panel-title { cursor: pointer; transition: color 0.2s ease, text-shadow 0.2s ease; border-radius: 4px; padding: 1px 3px; margin: -1px -3px; }
        #ytqm-panel-title:hover { color: #fff; text-shadow: 0 0 8px rgba(255,255,255,0.9), 0 0 20px rgba(255,255,255,0.4); }

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

        /* ── Up Next label ── */
        #ytqm-up-next-label { flex-shrink: 0; padding: 9px 14px 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.25); }
      `;
		},

		_cssPanelControls() {
			return `
        #ytqm-skip-btn, #ytqm-prev-btn, #ytqm-remote-pause-btn { background: none; border: 1px solid rgba(255,255,255,0.25); border-radius: 999px; color: rgba(255,255,255,0.7); padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit; transition: all 0.15s; }
        #ytqm-skip-btn:hover, #ytqm-prev-btn:hover, #ytqm-remote-pause-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        #ytqm-remote-pause-btn.is-paused { background: rgba(39,174,96,0.2); border-color: rgba(39,174,96,0.7); color: #2ecc71; }
        #ytqm-remote-pause-btn.is-paused:hover { background: rgba(39,174,96,0.3); }
        #ytqm-close-btn { background: #fff; border: 1.5px solid #fff; border-radius: 50%; color: #000; cursor: pointer; font-size: 13px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; padding: 0; font-family: inherit; flex-shrink: 0; transition: all 0.15s; }
        #ytqm-close-btn:hover { color: #fff; background: #e74c3c; border-color: #fff; }
      `;
		},

		_cssQueueList() {
			return `
        #ytqm-list { overflow-y: auto; flex: 1; padding: 4px 0 8px; }
        #ytqm-list::-webkit-scrollbar { width: 5px; }
        #ytqm-list::-webkit-scrollbar-track { background: transparent; }
        #ytqm-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 99px; }
        .ytqm-item { display: flex; align-items: center; gap: 6px; padding: 9px 14px; cursor: grab; transition: background 0.12s; border-radius: 8px; margin: 2px 6px; }
        .ytqm-item:hover     { background: rgba(255,255,255,0.07); }
        .ytqm-item.drag-over { background: rgba(255,255,255,0.14); outline: 1px dashed rgba(255,255,255,0.3); }
        .ytqm-item.dragging  { opacity: 0.35; }
        .ytqm-item-index { font-size: 12.5px; color: rgba(255,255,255,0.3); flex-shrink: 0; }
        .ytqm-item-title { flex: 1; font-size: 12.5px; color: rgba(255,255,255,0.85); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
        .ytqm-toggle input:checked + .ytqm-toggle-track { background: rgba(39,174,96,0.85); border-color: rgba(39,174,96,0.6); }
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
			btn.className = 'ytqm-btn'; btn.id = id; btn.textContent = label;
			btn.addEventListener('click', e => { e.stopPropagation(); onClick(); });
			return btn;
		},

		_buildPanel() {
			this.panel = document.createElement('div');
			this.panel.id = 'ytqm-panel';

			// Header
			const header = document.createElement('div');
			header.id = 'ytqm-panel-header';
			const title = document.createElement('span');
			title.id = 'ytqm-panel-title'; title.textContent = 'Queue'; title.title = 'Open settings';
			title.addEventListener('click', e => { e.stopPropagation(); this.openSettings(); });
			const controls = document.createElement('div');
			controls.className = 'header-controls';
			this.remotePauseBtn = document.createElement('button');
			this.remotePauseBtn.id = 'ytqm-remote-pause-btn';
			this.remotePauseBtn.textContent = '\u23f8 Pause';
			this.remotePauseBtn.style.display = 'none';
			this.remotePauseBtn.addEventListener('click', () => this._onRemotePauseClick());
			const prevBtn = document.createElement('button');
			prevBtn.id = 'ytqm-prev-btn'; prevBtn.textContent = '\u23ee Prev';
			prevBtn.addEventListener('click', () => Player.previous());
			this.prevBtn = prevBtn;
			const skipBtn = document.createElement('button');
			skipBtn.id = 'ytqm-skip-btn'; skipBtn.textContent = '\u23ed Skip';
			skipBtn.addEventListener('click', () => Player.remoteSkip());
			this.skipBtn = skipBtn;
			const closeBtn = document.createElement('button');
			closeBtn.id = 'ytqm-close-btn'; closeBtn.textContent = '\u2716';
			closeBtn.addEventListener('click', () => this.togglePanel(false));
			controls.append(prevBtn, this.remotePauseBtn, skipBtn, closeBtn);
			header.append(title, controls);

			// Now Playing section
			this.nowPlayingSection = document.createElement('div');
			this.nowPlayingSection.id = 'ytqm-now-playing';
			this.nowPlayingSection.style.display = 'none';
			const npLabel = document.createElement('div');
			npLabel.id = 'ytqm-now-playing-label'; npLabel.textContent = 'Now Playing';
			const npTitle = document.createElement('div');
			npTitle.id = 'ytqm-now-playing-title';
			const bars = document.createElement('span');
			bars.className = 'np-bars';
			bars.innerHTML = '<span></span><span></span><span></span><span></span>';
			const npText = document.createElement('span');
			npText.id = 'ytqm-now-playing-text';
			npTitle.append(bars, npText);
			this.nowPlayingSection.append(npLabel, npTitle);

			// Up Next label
			this.upNextLabel = document.createElement('div');
			this.upNextLabel.id = 'ytqm-up-next-label';
			this.upNextLabel.textContent = 'Up Next';
			this.upNextLabel.style.display = 'none';

			this.list = document.createElement('div');
			this.list.id = 'ytqm-list';

			this.panel.append(header, this.nowPlayingSection, this.upNextLabel, this.list);
			this.shadow.appendChild(this.panel);
			this._buildSettingsModal();
		},

		_buildSettingsModal() {
			this.settingsOverlay = document.createElement('div');
			this.settingsOverlay.id = 'ytqm-settings-overlay';
			this.settingsOverlay.addEventListener('mousedown', e => { if (e.target === this.settingsOverlay) this.closeSettings(); });
			const modal = document.createElement('div');
			modal.id = 'ytqm-settings-modal';
			const header = document.createElement('div');
			header.id = 'ytqm-settings-header';
			const headerTitle = document.createElement('span');
			headerTitle.textContent = 'YT-Q Settings';
			const headerClose = document.createElement('button');
			headerClose.id = 'ytqm-close-btn'; headerClose.textContent = '\u2716';
			headerClose.addEventListener('click', () => this.closeSettings());
			header.append(headerTitle, headerClose);
			const body = document.createElement('div');
			body.id = 'ytqm-settings-body';

			const defs = [
				{ key: 'remoteControls', label: 'Cross-tab controls', sub: 'Show pause, skip & previous buttons in the queue panel when another tab is playing.' },
				{ key: 'theaterMode', label: 'Auto theater mode', sub: 'Switch to theater mode when the browser window is narrower than 60 % of your screen width, and back when it widens. Useful when sharing the screen with another app.' },
				{ key: 'restartFromBeginning', label: 'Always restart from beginning', sub: 'Seek to 0:00 whenever the queue navigates to a video, including ones that may have partial watch progress saved by YouTube.' },
				{ key: 'blockContextMenu', label: 'Block right-click menu', sub: 'Suppress the browser context menu site-wide so right-clicking a thumbnail button always triggers "play next" without the menu appearing.' },
				{ key: 'mediaSessionRefresh', label: 'Aggressive MediaSession refresh', sub: 'Periodically re-register next/previous track handlers. Fixes media keys going silent after YouTube reinitialises its player.' },
				{ key: 'mediaSessionRefreshInterval', label: 'Refresh interval (seconds)', sub: 'How often to re-register when aggressive refresh is on. Default: 5 s. Lower = more responsive, slightly more CPU.', type: 'number' },
				{ key: 'hideNativeButtons', label: 'Hide YouTube\'s thumbnail buttons', sub: 'Suppress the native Watch Later and Add to Queue buttons that appear on hover, so only the queue manager button is shown.' },
				{ key: 'enqueueFromPhone', label: 'Enqueue videos shared from phone', sub: 'Videos shared from your Android device via the local server go straight into the queue instead of opening a new tab.' },
			];

			defs.forEach(def => {
				const row = document.createElement('label');
				row.className = 'ytqm-setting-row';
				const labelWrap = document.createElement('span');
				labelWrap.className = 'ytqm-setting-label';
				labelWrap.textContent = def.label;
				if (def.beta) { const badge = document.createElement('span'); badge.className = 'ytqm-beta-badge'; badge.textContent = 'beta'; labelWrap.appendChild(badge); }
				if (def.sub) { const small = document.createElement('small'); small.textContent = def.sub; labelWrap.appendChild(small); }
				let control;
				if (def.type === 'number') {
					control = document.createElement('input');
					control.type = 'number'; control.min = '1'; control.max = '60'; control.step = '1';
					control.value = Settings.get()[def.key]; control._ytqmSettingKey = def.key;
					Object.assign(control.style, { width: '52px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '6px', color: '#fff', padding: '4px 7px', fontSize: '12px', fontFamily: 'inherit', textAlign: 'center' });
					control.addEventListener('change', () => {
						const v = Math.max(1, Math.min(60, parseInt(control.value, 10) || 5));
						control.value = v; Settings.set(def.key, v); log(`Setting changed: ${def.key} =`, v);
						if (Player._playing) Player._registerMediaSession();
					});
				} else {
					const toggle = document.createElement('span');
					toggle.className = 'ytqm-toggle';
					const input = document.createElement('input');
					input.type = 'checkbox'; input.checked = Settings.get()[def.key]; input._ytqmSettingKey = def.key;
					input.addEventListener('change', () => {
						Settings.set(def.key, input.checked); log(`Setting changed: ${def.key} =`, input.checked);
						UI.updateControls(); UI.updateRemotePauseBtn();
						if (def.key === 'theaterMode') TheaterMode.init();
						if (def.key === 'mediaSessionRefresh' && Player._playing) Player._registerMediaSession();
						if (def.key === 'hideNativeButtons') NativeButtonHider.apply();
						if (def.key === 'enqueueFromPhone') {
							input.checked ? PhonePoller.start() : PhonePoller.stop();
						}
					});
					const track = document.createElement('span'); track.className = 'ytqm-toggle-track';
					const thumb = document.createElement('span'); thumb.className = 'ytqm-toggle-thumb';
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
			urlInput.addEventListener('change', () => {
				Settings.set('phoneServerUrl', urlInput.value.trim() || SETTINGS_DEFAULTS.phoneServerUrl);
				log('Setting changed: phoneServerUrl =', Settings.get().phoneServerUrl);
			});
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
				if (msg) ioStatusTimer = setTimeout(() => { ioStatus.textContent = ''; ioStatus.className = ''; }, durationMs);
			};

			const ioRow = document.createElement('div');
			ioRow.className = 'ytqm-io-row';

			const exportBtn = document.createElement('button');
			exportBtn.className = 'ytqm-io-btn accent';
			exportBtn.textContent = '⬆ Copy Queue';
			exportBtn.title = 'Copy the current queue to the clipboard as JSON';
			exportBtn.addEventListener('click', async () => {
				const { ok, count } = await QueueIO.exportToClipboard();
				if (ok) setIoStatus(`✓ Copied ${count} item${count !== 1 ? 's' : ''} to clipboard`, 'ok');
				else setIoStatus('✗ Clipboard write failed — check browser permissions', 'err');
			});

			const importBtn = document.createElement('button');
			importBtn.className = 'ytqm-io-btn';
			importBtn.textContent = '⬇ Paste & Append';
			importBtn.title = 'Read JSON from the clipboard and append new items to the queue';
			importBtn.addEventListener('click', async () => {
				const { ok, added, error } = await QueueIO.importFromClipboard();
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
			this.settingsOverlay.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = Settings.get()[input._ytqmSettingKey]; });
			this.settingsOverlay.querySelectorAll('input[type="number"]').forEach(input => { input.value = Settings.get()[input._ytqmSettingKey]; });
			const urlInput = this.settingsOverlay.querySelector('#ytqm-phone-url-input');
			if (urlInput) urlInput.value = Settings.get().phoneServerUrl || SETTINGS_DEFAULTS.phoneServerUrl;
			this.settingsOverlay.classList.add('open');
		},

		closeSettings() { this.settingsOverlay.classList.remove('open'); },

		_currentVideoMeta() {
			const videoId = new URLSearchParams(location.search).get('v');
			if (!videoId) return null;
			const url = `https://www.youtube.com/watch?v=${videoId}`;
			const titleEl = document.querySelector(SEL.WATCH_TITLE);
			const title = titleEl?.textContent?.trim() || document.title.replace(/\s*[-|]\s*YouTube\s*$/i, '').trim() || 'Untitled video';
			const channel = document.querySelector(SEL.CHANNEL_NAME)?.getAttribute('title')?.trim() || '';
			return { url, title, channel };
		},

		_flashAddBtn(label, bg) {
			clearTimeout(this._addBtnFlashTimer);
			this.addBtnFlash.textContent = label;
			this.addBtnFlash.style.background = bg;
			this.addBtnFlash.classList.add('visible');
			this._addBtnFlashTimer = setTimeout(() => { this.addBtnFlash.classList.remove('visible'); this._addBtnFlashTimer = null; }, BTN_FLASH_DURATION_MS);
		},

		_onAddClick() {
			try {
				const meta = this._currentVideoMeta();
				if (!meta) { this.addBtnLabel.textContent = 'Not a video page'; setTimeout(() => this.updateControls(), BTN_TEMP_TEXT_DURATION_MS); return; }
				const alreadyQueued = !!Storage.queue.find(v => v.url === meta.url);
				if (alreadyQueued) { Storage.removeVideoByUrl(meta.url); this._flashAddBtn('\u2212 Removed from Queue', 'rgba(192,57,43,0.92)'); }
				else { Storage.addVideo(meta.url, meta.title, meta.channel); this._flashAddBtn('\u2713 Added to Queue', 'rgba(39,174,96,0.92)'); }
				this.refreshPanel(); this.updateControls();
			} catch (e) { warn('_onAddClick error:', e); this.flashBtn(this.addBtn, 'Error'); }
		},

		_onAddContextMenu(e) {
			e.preventDefault(); e.stopPropagation();
			try {
				const meta = this._currentVideoMeta(); if (!meta) return;
				const insertAt = Player._playing && Storage.queue.length > 0 ? 1 : 0;
				Storage.insertNext(meta.url, meta.title, meta.channel, insertAt);
				this._flashAddBtn('\u2713 Added as Next', 'rgba(41,128,185,0.92)');
				this.refreshPanel(); this.updateControls();
			} catch (e) { warn('_onAddContextMenu error:', e); }
		},

		_onPlayClick() {
			if (Player._playing) { Player.stop(); }
			else {
				if (Storage.queue.length === 0) { this.flashBtn(this.playBtn, 'Queue is empty'); return; }
				this.togglePanel(false); Player.start();
			}
			this.updateControls();
		},

		_onRemotePauseClick() {
			if (Storage.paused) Player.remoteResume(); else Player.remotePause();
		},

		flashBtn(btn, tempText) {
			const original = btn.textContent; btn.textContent = tempText;
			setTimeout(() => { btn.textContent = original; }, BTN_TEMP_TEXT_DURATION_MS);
		},

		showStatus(msg, durationMs = STATUS_DEFAULT_DURATION_MS) {
			if (!this.shadow) return;
			let pill = this.shadow.getElementById('ytqm-status');
			if (!pill) {
				pill = document.createElement('div'); pill.id = 'ytqm-status';
				Object.assign(pill.style, { position: 'fixed', left: '20px', bottom: '68px', background: 'rgba(0,0,0,0.82)', color: '#fff', fontSize: '12px', fontFamily: "'Segoe UI', system-ui, sans-serif", fontWeight: '600', padding: '6px 14px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.2)', pointerEvents: 'none', opacity: '0', zIndex: '1', transition: 'bottom 0.2s ease, opacity 0.3s' });
				this.shadow.appendChild(pill);
			}
			this._updateStatusPillPosition();
			pill.textContent = msg; pill.style.opacity = '1';
			clearTimeout(pill._hideTimer);
			pill._hideTimer = setTimeout(() => { pill.style.opacity = '0'; }, durationMs);
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
			if (this.panelOpen) { this.refreshPanel(); this.panel.classList.add('open'); }
			else { this.panel.classList.remove('open'); }
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
				item.draggable = true;
				item.dataset.queueIndex = queueIdx;

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

				item.append(idxLabel, titleEl, removeBtn);

				item.addEventListener('dragstart', e => {
					this._dragSrcIndex = queueIdx;
					item.classList.add('dragging');
					e.dataTransfer.effectAllowed = 'move';
				});
				item.addEventListener('dragend', () => {
					item.classList.remove('dragging');
					this.shadow.querySelectorAll('.ytqm-item').forEach(el => el.classList.remove('drag-over'));
				});
				item.addEventListener('dragover', e => {
					e.preventDefault();
					e.dataTransfer.dropEffect = 'move';
					this.shadow.querySelectorAll('.ytqm-item').forEach(el => el.classList.remove('drag-over'));
					item.classList.add('drag-over');
				});
				item.addEventListener('drop', e => {
					e.preventDefault();
					const toIdx = parseInt(item.dataset.queueIndex, 10);
					if (this._dragSrcIndex !== null && this._dragSrcIndex !== toIdx) {
						Storage.reorder(this._dragSrcIndex, toIdx);
						this._dragSrcIndex = null;
						this.refreshPanel();
					}
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
			document.addEventListener('contextmenu', e => { if (!Settings.get().blockContextMenu) return; e.preventDefault(); }, true);
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
				this._styleEl = document.createElement('style'); this._styleEl.id = 'ytqm-hide-native-btns'; this._styleEl.textContent = this._CSS; document.head.appendChild(this._styleEl); log('NativeButtonHider: hidden');
			} else if (!shouldHide && this._styleEl) { this._styleEl.remove(); this._styleEl = null; log('NativeButtonHider: restored'); }
		},
	};

	// ── URL Change Detection ──────────────────────────────────────────────────

	let lastUrl = location.href;
	function notifyUrlChange(newHref) { lastUrl = newHref; onUrlChange(); }
	function onUrlChange() {
		log('URL changed to', location.href);
		UI.updateControls();
		if (UI.panelOpen) UI.refreshPanel();
		if (Page.isWatchPage()) TheaterMode.init();
		ThumbnailInjector.syncAllButtons();
	}

	window.addEventListener('popstate', () => { setTimeout(() => { if (location.href !== lastUrl) notifyUrlChange(location.href); }, URL_CHANGE_SETTLE_MS); });
	window.addEventListener('yt-navigate-finish', () => {
		if (location.href !== lastUrl) notifyUrlChange(location.href); else onUrlChange();
		if (Player._playing) { log('yt-navigate-finish: attaching to video'); setTimeout(() => Player._waitForVideoAndPlay(), 300); }
	});

	// ── Theater Mode ──────────────────────────────────────────────────────────

	const TheaterMode = {
		_initialised: false, _debounceTimer: null,
		_findTheaterButton() {
			return document.querySelector(SEL.THEATER_BTN_DATA) || document.querySelector(SEL.THEATER_BTN_CLASS) || [...document.querySelectorAll('button[title]')].find(b => b.title.endsWith('(t)') && b.closest('.ytp-right-controls'));
		},
		_isTheaterMode() { return document.querySelector(SEL.WATCH_FLEXY)?.hasAttribute('theater') ?? false; },
		_injectCaptionStyle() {
			if (document.getElementById('ytrs-caption-style')) return;
			const style = document.createElement('style'); style.id = 'ytrs-caption-style'; style.textContent = '.ytp-caption-segment { color: white !important; }'; document.head.appendChild(style);
		},
		check() {
			if (!Settings.get().theaterMode) return;
			if (!document.hasFocus()) return;
			if (!Page.isWatchPage()) return;
			if (document.fullscreenElement || document.webkitFullscreenElement) return;
			const isNarrow = window.innerWidth < window.screen.width * THEATER_MIN_WIDTH_RATIO;
			const inTheater = this._isTheaterMode();
			if (isNarrow && !inTheater) { this._findTheaterButton()?.click(); return; }
			if (!isNarrow && inTheater) { this._findTheaterButton()?.click(); }
		},
		_debounce(fn, delay) { clearTimeout(this._debounceTimer); this._debounceTimer = setTimeout(fn, delay); },
		init() {
			this._injectCaptionStyle();
			if (this._initialised) { this.check(); return; }
			this._initialised = true;
			window.addEventListener('resize', () => this._debounce(() => this.check(), THEATER_RESIZE_DEBOUNCE_MS));
			window.addEventListener('focus', () => this._debounce(() => this.check(), THEATER_FOCUS_DEBOUNCE_MS));
			document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(); });
			this.check();
			log('TheaterMode initialised');
		},
	};

	// ── Boot ──────────────────────────────────────────────────────────────────

	function tryInit() {
		if (!document.body) { setTimeout(tryInit, 100); return; }
		log('Initialising…');
		try {
			localStorage.setItem('ytqm_test', '1');
			if (localStorage.getItem('ytqm_test') !== '1') throw new Error('read-back mismatch');
			localStorage.removeItem('ytqm_test');
			log('localStorage OK');
		} catch (e) {
			warn('localStorage not available:', e);
			const err = document.createElement('div');
			Object.assign(err.style, { position: 'fixed', bottom: '24px', left: '20px', zIndex: '1', background: '#c0392b', color: '#fff', padding: '8px 14px', borderRadius: '999px', fontFamily: 'sans-serif', fontSize: '13px', boxShadow: '0 4px 18px rgba(0,0,0,0.5)' });
			err.textContent = 'YT Queue: storage unavailable';
			document.body.appendChild(err);
			return;
		}
		UI.init();
		ThumbnailInjector.start();
		ContextMenuBlocker.init();
		NativeButtonHider.apply();
		if (Page.isWatchPage()) TheaterMode.init();
		if (Settings.get().enqueueFromPhone) PhonePoller.start();
		log('Ready. Queue has', Storage.queue.length, 'items.');
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryInit);
	else tryInit();
})();
