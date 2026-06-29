/* =========================================================
   Sleeper API — Fetch, slim, and cache player data
   Architecture: client-side fetch on load, cache in localStorage.
   Each user fetches from their own browser / IP.

   Data fetched per player (keyed by our local player ID via sleeper-map.json):
     inj      — injury_status   : 'Questionable' | 'Out' | 'IR' | 'DNR' | …
     inj_part — injury_body_part: 'Knee - ACL' | 'Shoulder' | …
     inj_note — injury_notes    : 'Surgery' | 'Soreness' | …
     dc       — depth_chart_order: 1 (starter) | 2 (backup) | 3 | …
     status   — non-Active statuses only: 'Injured Reserve' | 'PUP' | …

   localStorage keys:
     sleeper.v1.data     — { p1: {…}, p2: {…}, … }
     sleeper.v1.ts       — ISO timestamp of last successful fetch
   ========================================================= */

const SleeperData = (() => {
  'use strict';

  const SLEEPER_API   = 'https://api.sleeper.app/v1/players/nfl';
  const MAP_PATH      = 'data/sleeper-map.json';
  const CACHE_KEY     = 'sleeper.v1.data';
  const TS_KEY        = 'sleeper.v1.ts';
  // Re-fetch after 6 hours — Sleeper's /players endpoint is only updated
  // once a day so this is more than fresh enough while keeping traffic minimal.
  const CACHE_TTL_MS  = 6 * 60 * 60 * 1000;

  // --- Internal state ---
  let _data = {};            // { localPlayerId: { inj?, inj_part?, dc?, status? } }
  let _lastUpdated = null;   // Date object or null
  let _status = 'idle';      // 'idle' | 'loading' | 'ok' | 'error' | 'cached'
  let _listeners = [];       // (status) => void

  // --- Observers ---
  function on(fn) { _listeners.push(fn); }
  function off(fn) { _listeners = _listeners.filter(l => l !== fn); }
  function _emit(status) {
    _status = status;
    _listeners.forEach(fn => { try { fn(status); } catch (e) { /**/ } });
  }

  // --- localStorage helpers ---
  function _readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const ts  = localStorage.getItem(TS_KEY);
      if (!raw || !ts) return null;
      return { data: JSON.parse(raw), ts: new Date(ts) };
    } catch (e) {
      return null;
    }
  }

  function _writeCache(data) {
    try {
      const now = new Date();
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(TS_KEY, now.toISOString());
      _lastUpdated = now;
      return true;
    } catch (e) {
      console.warn('[Sleeper] Failed to write cache:', e);
      return false;
    }
  }

  function _clearCache() {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(TS_KEY);
  }

  // --- Data extraction ---
  // Strips the enormous Sleeper player blob down to only the fields we display,
  // and only keeps players in our local player list (via sleeper-map.json).
  // Non-Active statuses (IR, PUP, etc.) are kept; plain "Active" is dropped
  // to save space. Depth chart order is included for all players; injury fields
  // are only included when actually present.
  function _slimify(allPlayers, sleeperMap) {
    const slim = {};
    for (const [localId, sleeperId] of Object.entries(sleeperMap)) {
      const p = allPlayers[String(sleeperId)];
      if (!p) continue;

      const entry = {};

      // Injury status (Questionable, Out, DNR …)
      const inj = p.injury_status;
      if (inj && inj !== 'Na') entry.inj = inj;

      // Body part (Knee - ACL, Shoulder, Ankle …)
      const part = p.injury_body_part;
      if (part && part !== 'Na') entry.inj_part = part;

      // Supplemental notes (Surgery, Soreness …)
      const note = p.injury_notes;
      if (note && note !== 'Na') entry.inj_note = note;

      // Depth chart position (1 = starter, 2 = backup …)
      if (p.depth_chart_order != null) entry.dc = p.depth_chart_order;

      // Player roster status — only when non-Active
      const status = p.status;
      if (status && status !== 'Active' && status !== 'Na') entry.status = status;

      if (Object.keys(entry).length > 0) slim[localId] = entry;
    }
    return slim;
  }

  // --- Public API ---

  // Returns the cached data object (may be empty {} before load completes).
  function getData() { return _data; }

  // Returns { inj?, inj_part?, inj_note?, dc?, status? } for a local player id,
  // or an empty object if no data is available.
  function getPlayer(localId) { return _data[localId] || {}; }

  // Returns the Date of the last successful fetch, or null.
  function getLastUpdated() { return _lastUpdated; }

  // Returns the current fetch status string.
  function getStatus() { return _status; }

  // Force an immediate re-fetch from Sleeper, bypassing the cache TTL.
  // Returns a promise that resolves when done (or rejects on error).
  async function refresh() {
    return _fetchAndStore();
  }

  // Main initialisation — call once on app boot.
  // Checks the cache first; fetches fresh data if stale or missing.
  // Always resolves (never throws) — callers can proceed even with no data.
  async function init() {
    // 1. Try cache first.
    const cached = _readCache();
    if (cached) {
      _lastUpdated = cached.ts;
      const age = Date.now() - cached.ts.getTime();
      if (age < CACHE_TTL_MS) {
        // Cache is fresh — use it immediately without a network request.
        _data = cached.data;
        _emit('cached');
        return;
      }
      // Cache is stale — surface it so the UI can paint while we re-fetch.
      _data = cached.data;
      _emit('cached');
    }

    // 2. Fetch fresh data in the background (stale cache already served above).
    try {
      await _fetchAndStore();
    } catch (e) {
      // Non-fatal: already emitted 'error' inside _fetchAndStore.
    }
  }

  async function _fetchAndStore() {
    _emit('loading');
    try {
      // Fetch both resources in parallel.
      const [playersRes, mapRes] = await Promise.all([
        fetch(SLEEPER_API).then(r => {
          if (!r.ok) throw new Error(`Sleeper API ${r.status}`);
          return r.json();
        }),
        fetch(MAP_PATH).then(r => {
          if (!r.ok) throw new Error(`sleeper-map.json ${r.status}`);
          return r.json();
        }),
      ]);

      const slim = _slimify(playersRes, mapRes);
      _writeCache(slim);
      _data = slim;
      _emit('ok');
    } catch (e) {
      console.warn('[Sleeper] Fetch failed:', e);
      _emit('error');
      throw e;
    }
  }

  return { init, getData, getPlayer, getLastUpdated, getStatus, refresh, on, off };
})();
