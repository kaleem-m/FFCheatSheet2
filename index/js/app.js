/* =========================================================
   Draft Board — Application Logic
   - State + persistence (localStorage)
   - Tabs (Overall/QB/RB/WR/TE/K/DST) derived from master order
   - Drag & drop via SortableJS (native speed, Y-axis restricted)
   - Tier breaks, favorites, picked toggle
   - CSV / PDF export, reset with confirmation
   ========================================================= */

(() => {
  'use strict';

  // ---------- Constants ----------
  const STORAGE_KEY = 'draftboard.v1';
  const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'];

  // ---------- Team Logos ----------
  // Logos are looked up purely by a player's `team` abbreviation, so every
  // team's logo can be swapped in later just by dropping a file here. To add a
  // real logo: save it as `assets/logos/<TEAM>.<ext>` (lowercase team code,
  // e.g. assets/logos/sf.svg) and either keep the default `.svg` extension or
  // override the path/extension below.
  //
  //   - LOGO_DIR + "<team>" + LOGO_EXT  is the resolved URL for each team.
  //   - Add a team to LOGO_EXT_OVERRIDES if a specific team uses a different
  //     file type (e.g. { SF: '.png' }).
  //   - Until a real file exists the row falls back to LOGO_PLACEHOLDER
  //     automatically (handled by the <img> onerror in renderPlayer).
  const LOGO_DIR = 'assets/logos/';
  const LOGO_EXT = '.svg';
  const LOGO_EXT_OVERRIDES = {}; // e.g. { SF: '.png' }
  const LOGO_PLACEHOLDER = LOGO_DIR + '_placeholder.svg';

  // Some data sources use an alternate abbreviation for the same franchise
  // than the logo filename on disk (e.g. data says "JAC" but the file is
  // jax.svg). Map those aliases to their on-disk code so the right logo loads
  // instead of silently falling back to the placeholder. Keyed by the UPPERCASE
  // team code from the data.
  const LOGO_ALIASES = {
    JAC: 'jax',   // Jacksonville: data uses JAC, logo file is jax.svg
    JAG: 'jax',
    WSH: 'was',   // Washington alt code
    LVR: 'lv',    // Las Vegas alt code
    // "FA" / free agents have no franchise logo — falls through to placeholder.
  };

  // Teams whose logo file failed to load once. Remembered for the session so
  // we never re-request a missing file on subsequent renders (without this,
  // every render fires one failed network request per row — a big drag on
  // mobile, especially while typing in the search box).
  const missingLogos = new Set();

  // Resolve a team abbreviation to its logo URL. Centralised so logos can be
  // re-pointed (CDN, sprite, etc.) from a single place.
  function teamLogoUrl(team) {
    if (!team || missingLogos.has(team)) return LOGO_PLACEHOLDER;
    const upper = String(team).toUpperCase();
    const code = LOGO_ALIASES[upper] || upper.toLowerCase();
    const ext = LOGO_EXT_OVERRIDES[team] || LOGO_EXT;
    return LOGO_DIR + code + ext;
  }

  // ---------- Sleeper live data ----------
  // Loaded asynchronously after boot via SleeperData.init().
  // Re-render is triggered whenever the status changes.
  // Access per player: SleeperData.getPlayer(localPlayerId)

  // ---------- State ----------
  // NOTE: `order` is now a master list of PLAYERS ONLY (keys like "p:p1").
  // This keeps player rankings dynamically linked across all tabs.
  //
  // Tiers are INDEPENDENT per tab. Each tier belongs to exactly one tab
  // (state.tiers[id].tab) and is positioned by an "anchor": the id of the
  // player it should appear *above* within that tab. A null anchor means the
  // tier sits at the very bottom of its tab. Because tiers anchor to players
  // (and players are scoped per tab via getVisibleOrder), moving a tier in one
  // tab never affects any other tab.
  const state = {
    players: {},
    order: [],            // ["p:p1", "p:p2", ...]  players only, master order
    favorites: new Set(),
    picked: new Set(),
    myTeam: new Set(),    // players drafted by the user ("Picked By Me").
                         // Mutually exclusive with `picked`: a player is off
                         // the board via either, but `myTeam` members also
                         // appear in the "My Team" roster drawer.
    tiers: {},            // { tierId: { id, label, tab, anchor } }
    activeTab: 'ALL',
    meta: {},             // { playerId: { ecr: Number } }  (ECR reference rankings)
  };

  // Transient UI filters (not persisted)
  const filters = {
    search: '',
    watchlist: false,
    hidePicked: false,
  };

  let defaultPlayers = [];
  let sortable = null;
  let _sleeperStatusEl = null; // filled in by bindEvents

  // ---------- DOM ----------
  const $list = document.getElementById('rankings-list');
  const $tabs = document.querySelectorAll('.tab');
  const $tabIndicator = document.querySelector('.tab-indicator');
  const $empty = document.getElementById('empty-state');
  const $metaCount = document.getElementById('meta-count');
  const $metaPicked = document.getElementById('meta-picked');
  const $metaFav = document.getElementById('meta-fav');
  const $menuBtn = document.getElementById('menu-btn');
  const $menuDropdown = document.getElementById('menu-dropdown');
  const $addTierBtn = document.getElementById('add-tier-btn');
  const $search = document.getElementById('search-input');
  const $searchClear = document.getElementById('search-clear');
  const $filterWatchlist = document.getElementById('filter-watchlist');
  const $filterHidePicked = document.getElementById('filter-hide-picked');
  const $modal = document.getElementById('modal');
  const $modalConfirm = document.getElementById('modal-confirm');
  const $toast = document.getElementById('toast');
  const $restoreInput = document.getElementById('restore-input');

  // ---------- My Team drawer ----------
  const $myTeamBtn = document.getElementById('my-team-btn');
  const $myTeamBadge = document.getElementById('my-team-badge');
  const $teamDrawer = document.getElementById('team-drawer');
  const $teamBody = document.getElementById('team-body');
  const $teamEmpty = document.getElementById('team-empty');
  const $teamSummary = document.getElementById('team-summary');
  const $metaMyTeam = document.getElementById('meta-myteam');
  const $metaMyTeamDot = document.querySelector('.my-team-dot');

  // ---------- Persistence ----------
  // The exact persisted snapshot shape. Shared by save() and the backup export
  // so a backup file always matches what the app reads back on load.
  function serializeState() {
    return {
      order: state.order,
      favorites: [...state.favorites],
      picked: [...state.picked],
      myTeam: [...state.myTeam],
      tiers: state.tiers,
      activeTab: state.activeTab,
    };
  }

  // Core write — synchronous, always safe to call directly.
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
      _saveTimer = 0;   // cancel any pending debounced write (it's now redundant)
      return true;
    } catch (e) {
      console.warn('Failed to save state', e);
      return false;
    }
  }

  // Debounced save — coalesces rapid-fire calls (tier renames on every blur,
  // drag-ends, favorites, picked toggles) into a single localStorage write.
  // 500 ms is long enough to absorb a burst of interactions (e.g. renaming
  // several tiers back-to-back) yet short enough that data is safely on disk
  // well before any realistic "accidental close" scenario. A `beforeunload`
  // handler flushes any pending write synchronously so no data is ever lost
  // when the tab is closed or refreshed while the timer is still running.
  let _saveTimer = 0;
  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(save, 500);
  }

  // Immediately write any pending debounced save to localStorage. Call this
  // before operations that read from localStorage (backup download) or that
  // must guarantee the write happens before the call returns (manual Save Now).
  function flushSave() {
    if (_saveTimer) {
      clearTimeout(_saveTimer);
      _saveTimer = 0;
      save();
    }
  }

  // Safety net: if a debounced write is pending when the user closes or
  // refreshes the tab, flush it synchronously. localStorage.setItem is
  // synchronous and completes well within the browser's beforeunload budget
  // (typically 100–300 ms for short payloads like ours), so there is
  // essentially zero risk of data loss from this approach.
  window.addEventListener('beforeunload', flushSave);

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // Apply a persisted snapshot (the shape produced by save()) onto the live
  // `state`, using the SAME migration-friendly logic the app has always used on
  // boot. Factored out of init() so Restore can reuse the exact same code path
  // — a restored backup behaves identically to a normal reload. `defaultPlayers`
  // / `state.players` must already be populated before calling this.
  function applySavedState(saved) {
    if (saved && Array.isArray(saved.order) && saved.order.length) {
      // Migration-friendly load: the old format stored tiers inline in `order`.
      // We now keep `order` as players-only and tiers as independent objects.
      const legacyTierAnchors = {}; // tierId -> anchor playerId (next player after tier)
      let pendingTierIds = [];

      const playerOrder = [];
      saved.order.forEach(key => {
        if (key.startsWith('p:')) {
          if (state.players[key.slice(2)]) {
            const pid = key.slice(2);
            playerOrder.push('p:' + pid);
            // Any tiers seen just before this player anchor to it.
            pendingTierIds.forEach(tid => { legacyTierAnchors[tid] = pid; });
            pendingTierIds = [];
          }
        } else if (key.startsWith('t:')) {
          pendingTierIds.push(key.slice(2));
        }
      });
      // Tiers trailing at the end (no following player) anchor to null (bottom).
      pendingTierIds.forEach(tid => { legacyTierAnchors[tid] = null; });

      state.order = playerOrder;
      // Merge any players added to players.json since this save was written.
      // (Set lookup keeps this O(n) instead of O(n²) with Array.includes.)
      const known = new Set(state.order);
      defaultPlayers.forEach(p => {
        const key = 'p:' + p.id;
        if (!known.has(key)) { state.order.push(key); known.add(key); }
      });

      state.favorites = new Set(saved.favorites || []);
      state.picked = new Set(saved.picked || []);
      state.myTeam = new Set(saved.myTeam || []);
      state.activeTab = saved.activeTab || 'ALL';

      // Normalize tiers to the new shape { id, label, tab, anchor }.
      state.tiers = {};
      const savedTiers = saved.tiers || {};
      Object.keys(savedTiers).forEach(tid => {
        const t = savedTiers[tid] || {};
        state.tiers[tid] = {
          id: tid,
          label: t.label || 'Tier',
          // New saves include tab/anchor. Old saves are migrated: they lived in
          // the master (Overall) order, so default them to the ALL tab.
          tab: t.tab || 'ALL',
          anchor: ('anchor' in t) ? t.anchor : (legacyTierAnchors[tid] ?? null),
        };
      });
    } else {
      state.order = defaultPlayers.map(p => 'p:' + p.id);
      state.favorites = new Set();
      state.picked = new Set();
      state.myTeam = new Set();
      state.tiers = {};
      state.activeTab = 'ALL';
    }
  }

  // ---------- Init ----------
  async function init() {
    // Fetch both data files in parallel (was sequential) for a faster boot.
    // rankings-meta.json holds the ECR reference values for the
    // "vs. ECR" column — missing players just show "–".
    const [playersRes, metaRes] = await Promise.allSettled([
      fetch('data/players.json').then(r => r.json()),
      fetch('data/rankings-meta.json').then(r => r.json()),
    ]);
    if (playersRes.status === 'fulfilled') {
      defaultPlayers = playersRes.value;
    } else {
      console.error('Failed to load players.json', playersRes.reason);
      defaultPlayers = [];
    }
    if (metaRes.status === 'fulfilled') {
      state.meta = metaRes.value;
    } else {
      console.warn('Failed to load rankings-meta.json', metaRes.reason);
      state.meta = {};
    }
    // ECR data changed — invalidate the comparisons memo.
    bumpMetaVersion();

    // Build players lookup
    defaultPlayers.forEach(p => { state.players[p.id] = p; });

    const saved = load();
    applySavedState(saved);

    bindEvents();
    setActiveTab(state.activeTab, false);
    render();
    updateMyTeamBadge();
    initSortable(); // created ONCE — render() only toggles enabled/disabled

    // Sleeper live data — load from cache first (instant), then re-fetch if
    // stale. Fires a re-render whenever new data arrives so injury badges and
    // depth-chart chips appear without a full page reload.
    if (typeof SleeperData !== 'undefined') {
      SleeperData.on(sleeperStatusChanged);
      SleeperData.init().catch(() => {});
    }
  }

  // Called whenever the Sleeper fetch status changes (cached → ok | error).
  // Invalidates the row prototype so badges built on stale data get rebuilt,
  // then triggers a full render so every visible row reflects the new data.
  function sleeperStatusChanged(status) {
    updateSleeperStatusUI(status);
    if (status === 'ok' || status === 'cached') {
      // Sleeper data changed — any cached player rows are now stale.
      // We must clear and rebuild them so injury/DC badges are correct.
      clearRowCache();
      render();
    }
  }

  function updateSleeperStatusUI(status) {
    // Update the menu item label to reflect freshness.
    const el = document.getElementById('sleeper-status-item');
    if (!el) return;
    const lu = SleeperData.getLastUpdated();
    const timeStr = lu ? _fmtAge(lu) : null;
    if (status === 'loading') {
      el.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Updating player data…';
    } else if (status === 'ok') {
      el.innerHTML = `<i class="fa-solid fa-circle-check"></i> Player data updated${timeStr ? ' · ' + timeStr + ' ago' : ''}`;
    } else if (status === 'cached') {
      el.innerHTML = `<i class="fa-solid fa-database"></i> Player data${timeStr ? ' · ' + timeStr + ' ago' : ''}`;
    } else if (status === 'error') {
      el.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Player data unavailable';
    }
  }

  function _fmtAge(date) {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  // ---------- Helpers ----------
  function uid(prefix = 'id') {
    return prefix + '_' + Math.random().toString(36).slice(2, 9);
  }

  // A player is "off the board" if they're picked OR drafted by the user.
  // Both states make them unavailable; only `myTeam` feeds the roster drawer.
  function isOffBoard(playerId) {
    return state.picked.has(playerId) || state.myTeam.has(playerId);
  }

  // Players visible in the current tab, in master order (players only).
  function getVisiblePlayerKeys() {
    const pos = state.activeTab;
    if (pos === 'ALL') return state.order.slice();
    return state.order.filter(key => {
      const p = state.players[key.slice(2)];
      return p && p.position === pos;
    });
  }

  // Full visible order = players for this tab, with this tab's tiers woven in
  // at their anchor positions. Tiers are independent per tab.
  // `playerKeys` may be passed in to avoid recomputing getVisiblePlayerKeys()
  // (which filters the whole master order) when the caller already has it.
  function getVisibleOrder(playerKeys = getVisiblePlayerKeys()) {

    // Tiers belonging to the active tab, grouped by their anchor player.
    const tiersByAnchor = new Map(); // anchorPlayerId | '__end__' -> [tierKey,...]
    Object.values(state.tiers).forEach(t => {
      if (t.tab !== state.activeTab) return;
      const bucket = (t.anchor == null) ? '__end__' : t.anchor;
      if (!tiersByAnchor.has(bucket)) tiersByAnchor.set(bucket, []);
      tiersByAnchor.get(bucket).push('t:' + t.id);
    });

    const result = [];
    const placedAnchors = new Set();
    playerKeys.forEach(pk => {
      const pid = pk.slice(2);
      if (tiersByAnchor.has(pid)) {
        tiersByAnchor.get(pid).forEach(tk => result.push(tk));
        placedAnchors.add(pid);
      }
      result.push(pk);
    });

    // Tiers anchored to the end, or whose anchor player is no longer in this
    // tab (orphaned), fall to the bottom of the list.
    tiersByAnchor.forEach((tierKeys, anchor) => {
      if (anchor === '__end__' || !placedAnchors.has(anchor)) {
        tierKeys.forEach(tk => result.push(tk));
      }
    });

    return result;
  }

  // ---------- ECR comparison ----------
  // The "vs. ECR" column answers: "how does MY ranking of this player compare
  // to the Expert Consensus Ranking?" within the CURRENT tab.
  //
  // We build a reference rank for each visible player by sorting the same set
  // of players by their ECR value, then compare positions:
  //   diff = referenceRank - myRank
  //   diff > 0  => I have the player HIGHER than the reference  (good value)  => "+N"
  //   diff < 0  => I have the player LOWER than the reference                 => "-N"
  //   diff == 0 => same                                                       => "0"
  //
  // Doing it per-tab keeps it meaningful: on the RB tab we compare RB-rank to
  // RB-rank, on Overall we compare overall-rank to overall-rank.

  function getMetaValue(playerId, field) {
    const m = state.meta[playerId];
    if (!m) return null;
    const v = m[field];
    return (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  }

  // --- Memoisation for computeComparisons() -------------------------------
  // computeComparisons() sorts the visible players by ECR on every call. It was
  // being invoked on *every* render — including filter keystrokes and tab
  // switches — and again on every drag-end via updateRankNumbers(), re-sorting
  // the whole list each time even though nothing relevant had changed.
  //
  // The result depends on EXACTLY two things:
  //   1. the input `visiblePlayerKeys` sequence (which encodes both the active
  //      tab's player set AND the user's current order), and
  //   2. the ECR reference data in `state.meta`.
  // It is completely independent of the search/watchlist/hide-picked filters
  // (those never change the input array — it is always the full, unfiltered
  // tab order), so filtering should never trigger a re-sort.
  //
  // We therefore cache by a signature of the input keys plus a `metaVersion`
  // that is bumped whenever `state.meta` is (re)assigned (load / restore /
  // reset). A cache hit returns the previously computed Map untouched, making
  // every filter keystroke essentially free.
  //
  // The cache is a tiny 2-slot LRU rather than a single slot: the hot path
  // (render + drag-end for the ACTIVE tab) and the occasional overall-list
  // call from exportCSV() use different inputs, so two slots keep them from
  // evicting each other and re-sorting on the next keystroke.
  let _metaVersion = 0;
  function bumpMetaVersion() { _metaVersion++; }
  const _comparisonsCache = [];          // [{ key, value }], most-recent first
  const _COMPARISONS_CACHE_MAX = 2;

  // Returns a Map: playerKey -> { ecr: diff|null } for the players currently
  // visible in the active tab (in the user's order). Memoised — see above.
  function computeComparisons(visiblePlayerKeys) {
    // Signature: meta version + the exact ordered key sequence. '\n' can't
    // appear in a player key ("p:<id>"), so it's a safe, collision-free join.
    const cacheKey = _metaVersion + '|' + visiblePlayerKeys.join('\n');
    const hitIdx = _comparisonsCache.findIndex(e => e.key === cacheKey);
    if (hitIdx !== -1) {
      const hit = _comparisonsCache[hitIdx];
      // Promote to most-recently-used.
      if (hitIdx !== 0) {
        _comparisonsCache.splice(hitIdx, 1);
        _comparisonsCache.unshift(hit);
      }
      return hit.value;
    }

    const result = new Map();

    // Players in this tab that actually have an ECR value.
    const withValue = visiblePlayerKeys.filter(
      k => getMetaValue(k.slice(2), 'ecr') !== null
    );

    // Reference rank = position after sorting this subset by ECR
    // (ascending: lower ECR = better = rank 1).
    const refSorted = withValue.slice().sort((a, b) => {
      return getMetaValue(a.slice(2), 'ecr') - getMetaValue(b.slice(2), 'ecr');
    });
    const refRank = new Map();
    refSorted.forEach((k, i) => refRank.set(k, i + 1));

    // My rank = position within this tab in the user's current order, but
    // only counting players that have an ECR value (so the two scales
    // line up 1:1 even if some players are missing ECR).
    let myRank = 0;
    visiblePlayerKeys.forEach(k => {
      const hasVal = getMetaValue(k.slice(2), 'ecr') !== null;
      if (!hasVal) return;
      myRank++;
      const diff = refRank.get(k) - myRank; // ref - mine
      if (!result.has(k)) result.set(k, { ecr: null });
      result.get(k).ecr = diff;
    });

    // Store as most-recently-used, evicting the oldest beyond the cap.
    _comparisonsCache.unshift({ key: cacheKey, value: result });
    if (_comparisonsCache.length > _COMPARISONS_CACHE_MAX) {
      _comparisonsCache.length = _COMPARISONS_CACHE_MAX;
    }
    return result;
  }

  function showToast(message, ms = 1800) {
    $toast.textContent = message;
    $toast.hidden = false;
    requestAnimationFrame(() => $toast.classList.add('show'));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      $toast.classList.remove('show');
      setTimeout(() => { $toast.hidden = true; }, 250);
    }, ms);
  }

  // ---------- Render ----------
  function filtersActive() {
    return !!(filters.search || filters.watchlist || filters.hidePicked);
  }

  // Decides whether a player passes the active filters.
  function playerPassesFilters(p) {
    if (filters.watchlist && !state.favorites.has(p.id)) return false;
    // "Hide Picked" hides ALL off-board players — both picked and My Team.
    if (filters.hidePicked && isOffBoard(p.id)) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const hay = `${p.name} ${p.team} ${p.position}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  // Keyed DOM cache: data-key -> live <li> node currently owned by the list.
  // This is the heart of the incremental renderer. Rows persist across renders
  // (keystrokes, tab switches, filter toggles, tier add/remove) instead of being
  // destroyed and rebuilt, so render() only ever creates the handful of rows
  // that are genuinely new, removes the ones that genuinely left, and re-orders
  // the rest by cheap moves. Cleared wholesale only when the dataset identity
  // changes out from under us (reset / restore) via clearRowCache().
  const rowCache = new Map();

  function clearRowCache() {
    rowCache.clear();
  }

  function render() {
    // Compute the tab's player keys ONCE and reuse them everywhere below.
    // Previously getVisiblePlayerKeys() (an O(n) filter over the whole master
    // order) ran 3× per render: inside getVisibleOrder(), again for the
    // comparisons, and a third time inside updateMeta().
    const visiblePlayerKeys = getVisiblePlayerKeys();
    const visible = getVisibleOrder(visiblePlayerKeys);

    // Rank numbers always reflect the true (unfiltered) ranking in this tab,
    // so rank #3 stays #3 even when filtering hides players above it.
    const rankMap = new Map();
    let r = 0;
    visible.forEach(key => {
      if (key.startsWith('p:')) {
        r++;
        rankMap.set(key, r);
      }
    });

    // Real-time vs. ECR deltas for this tab's player set, in the user's
    // current order. Recomputed every render (incl. after each drag).
    const comparisons = computeComparisons(visiblePlayerKeys);

    const active = filtersActive();
    let shownCount = 0;

    // ---- Build the desired ordered list of (key, node) pairs ----
    // We resolve each key to its DOM node — reusing the cached node when one
    // exists for that key (and just updating its mutable parts), otherwise
    // creating it once. Filtered-out players and (while filtering) tiers are
    // simply skipped, exactly as before. We never call replaceChildren(): the
    // actual DOM is then reconciled to match `desired` below.
    const desired = [];          // [{ key, node }] in final display order
    const desiredKeys = new Set();

    visible.forEach(key => {
      if (key.startsWith('t:')) {
        // Hide tiers while filtering — they're position markers, not players.
        if (active) return;
        const tier = state.tiers[key.slice(2)];
        if (!tier) return;
        let node = rowCache.get(key);
        if (node) {
          updateTierRow(node, tier);
        } else {
          node = createTierRow(tier, key);
          rowCache.set(key, node);
        }
        desired.push(node);
        desiredKeys.add(key);
      } else {
        const player = state.players[key.slice(2)];
        if (!player) return;
        if (active && !playerPassesFilters(player)) return;
        shownCount++;
        let node = rowCache.get(key);
        if (node) {
          updatePlayerRow(node, player, rankMap.get(key), comparisons.get(key));
        } else {
          node = createPlayerRow(player, key);
          updatePlayerRow(node, player, rankMap.get(key), comparisons.get(key));
          rowCache.set(key, node);
        }
        desired.push(node);
        desiredKeys.add(key);
      }
    });

    reconcileList(desired, desiredKeys);

    // Empty state messaging
    if (shownCount === 0) {
      $empty.hidden = false;
      const msg = $empty.querySelector('p');
      if (msg) {
        msg.textContent = active
          ? 'No players match your filters.'
          : 'No players in this view.';
      }
    } else {
      $empty.hidden = true;
    }

    updateMeta(visiblePlayerKeys);
    // While filters are active the list is partial, so reordering is disabled
    // to avoid corrupting the true ranking order.
    setSortableEnabled(!active);
  }

  // Reconcile the <ul>'s actual children to match `desired` (the ordered list
  // of nodes render() wants on screen), touching the DOM as little as possible:
  //
  //   1. Remove any current child whose key is no longer wanted, and evict it
  //      from the cache so a future render rebuilds it fresh.
  //   2. Walk `desired` in order, inserting each node at the current position
  //      only if it isn't already there. Reused nodes that are already in the
  //      right spot are left completely untouched (no insert, no reflow churn).
  //
  // This replaces the old `$list.replaceChildren(frag)`, which detached and
  // reinserted EVERY row on every render. Now a search keystroke that hides 350
  // of 371 rows only removes those 350 nodes (the 21 survivors stay put), a tab
  // switch reuses any rows shared between tabs, and a no-op render (e.g. a
  // toggle that doesn't change the visible set) performs zero DOM mutations.
  function reconcileList(desired, desiredKeys) {
    // --- 1. Remove children that should no longer be present. ---
    // Iterate over a static snapshot since we mutate $list.children as we go.
    const current = Array.from($list.children);
    for (const node of current) {
      const key = node.dataset.key;
      if (!key || !desiredKeys.has(key)) {
        node.remove();
        if (key) rowCache.delete(key);
      }
    }

    // --- 2. Place desired nodes in order with minimal moves. ---
    // `ref` tracks the node we expect at the current slot. When the desired
    // node already sits there we just advance; otherwise we insert it before
    // `ref` (a move if it already lived elsewhere, an insert if it's new).
    let ref = $list.firstChild;
    for (let i = 0; i < desired.length; i++) {
      const node = desired[i];
      if (node === ref) {
        // Already in the right place — advance to the next slot.
        ref = ref.nextSibling;
      } else {
        // Insert (or move) the node into this slot, just before `ref`.
        $list.insertBefore(node, ref);
        // `ref` is unchanged: the next desired node is still compared against
        // the same following node.
      }
    }
  }

  // ---------- Player row template (built once, cloned per row) ----------
  // The old renderPlayer set li.innerHTML on EVERY row, which forces the
  // browser's HTML parser to re-parse the same ~20-node structure 371× on each
  // full render() (and render() runs on every keystroke / filter / tab switch).
  // Parsing HTML strings into DOM is the slowest way to build nodes.
  //
  // Instead we parse the static skeleton ONCE into a prototype <li>, cache
  // references to the handful of nodes that actually change, and per row just
  // cloneNode(true) the prototype and poke the dynamic bits via direct DOM
  // properties (textContent / className / src). cloneNode is dramatically
  // faster than re-parsing, and textContent removes the need for escapeHtml on
  // these fields (the browser never interprets it as markup).
  let _playerRowProto = null;
  function getPlayerRowProto() {
    if (_playerRowProto) return _playerRowProto;
    const li = document.createElement('li');
    li.className = 'player-row';
    li.dataset.type = 'player';
    li.innerHTML = `
      <div class="drag-handle" aria-label="Drag to reorder" title="Drag to reorder">
        <i class="fa-solid fa-grip-vertical"></i>
      </div>
      <div class="rank"></div>
      <div class="team-logo">
        <img alt="" loading="lazy" decoding="async" />
      </div>
      <div class="player-info">
        <div class="player-name"></div>
        <div class="player-meta">
          <span class="pos-chip" hidden></span>
          <span class="player-team"></span>
          <span class="player-bye" hidden></span>
          <span class="dc-badge" hidden></span>
        </div>
        <div class="sleeper-badges" hidden></div>
      </div>
      <div class="player-compare" aria-label="Ranking vs. ECR">
        <div class="compare-cell" data-field="ecr">
          <span class="compare-label">vs. ECR</span>
          <span class="compare-value"></span>
        </div>
      </div>
      <div class="player-actions">
        <button class="icon-btn star" data-action="favorite" aria-label="Favorite" title="Favorite">
          <i class="fa-regular fa-star"></i>
        </button>
        <button class="icon-btn mine-btn" data-action="mine" aria-label="Draft to my team" title="Draft to my team">
          <i class="fa-solid fa-user-check"></i>
        </button>
        <button class="icon-btn pick" data-action="pick" aria-label="Mark picked" title="Mark picked">
          <i class="fa-solid fa-circle-check"></i>
        </button>
      </div>
    `;
    _playerRowProto = li;
    return li;
  }

  // Create a brand-new player row node (clone the prototype + wire up the
  // parts that never change again for this node: identity + the team logo,
  // which is keyed to the player and so is constant for the row's lifetime).
  // The mutable bits (rank, state classes, vs. ECR, action buttons) are filled
  // in by updatePlayerRow so the create and reuse paths stay in perfect sync.
  function createPlayerRow(p, key) {
    // Clone the cached skeleton (fast) instead of re-parsing an HTML string.
    const li = getPlayerRowProto().cloneNode(true);
    li.dataset.key = key;
    li.dataset.playerId = p.id;

    // Team logo. textContent-equivalents: attributes are set, never parsed.
    // The logo, name, team and bye are intrinsic to the player, so for a given
    // key they never change and are set once here (not on every reconcile).
    const img = li.querySelector('.team-logo img');
    img.src = teamLogoUrl(p.team);
    img.alt = p.team + ' logo';
    img.dataset.team = p.team;
    li.querySelector('.team-logo').title = p.team;

    li.querySelector('.player-name').textContent = p.name;
    li.querySelector('.player-team').textContent = p.team;

    const byeEl = li.querySelector('.player-bye');
    if (p.bye == null || p.bye === '') {
      byeEl.remove(); // omit entirely so the "BYE " ::before prefix never shows
    } else {
      byeEl.hidden = false;
      byeEl.textContent = p.bye;
    }

    return li;
  }

  // Update the MUTABLE parts of an existing player row in place. This is the
  // single source of truth used both when a row is first created and when a
  // cached row is reused across renders — so a reused node ends up byte-for-byte
  // identical to a freshly built one (no full teardown needed).
  function updatePlayerRow(li, p, rank, cmp) {
    // Resolve each state-set membership ONCE — previously .has() ran 2–3× per
    // player for picked/mine/favorite, which adds up across a 350+ row list.
    const isPicked = state.picked.has(p.id);
    const isMine = state.myTeam.has(p.id);
    const isFav = state.favorites.has(p.id);

    // Off-board styling applies to both picked and My Team members; `.mine`
    // additionally tints the row so your own picks stand out from the rest
    // of the off-board grey.
    li.classList.toggle('picked', isPicked);
    li.classList.toggle('mine', isMine);
    li.classList.toggle('favorited', isFav);

    // Rank number.
    li.querySelector('.rank').textContent = rank;

    // Position chip — only shown on the Overall tab. Toggle correctly so a
    // reused row that crosses between Overall and a position tab updates.
    const posChip = li.querySelector('.pos-chip');
    if (state.activeTab === 'ALL') {
      posChip.hidden = false;
      // Reset to base class + this player's position modifier.
      posChip.className = 'pos-chip ' + p.position;
      posChip.textContent = p.position;
    } else if (!posChip.hidden) {
      posChip.hidden = true;
    }

    // vs. ECR compare cell.
    applyDeltaCell(li.querySelector('.compare-cell[data-field="ecr"]'), cmp ? cmp.ecr : null);

    // Sleeper live data — depth chart badge + injury badge.
    applySleeperBadges(li, p.id);

    // Action buttons — favorite.
    const favBtn = li.querySelector('[data-action="favorite"]');
    favBtn.classList.toggle('active', isFav);
    favBtn.firstElementChild.className = `fa-${isFav ? 'solid' : 'regular'} fa-star`;

    // Action buttons — my team.
    li.querySelector('[data-action="mine"]').classList.toggle('active', isMine);

    // Action buttons — picked.
    const pickBtn = li.querySelector('[data-action="pick"]');
    pickBtn.classList.toggle('active', isPicked);
    const pickIcon = pickBtn.firstElementChild;
    pickIcon.className = `fa-solid fa-${isPicked ? 'check' : 'circle-check'}`;
    pickIcon.style.opacity = isPicked ? '' : '0.55';

    return li;
  }

  // ---------- Sleeper badge helpers ----------

  // Depth-chart label: 'STARTER' for dc=1, 'BACKUP' for dc=2, 'QB3' etc. for
  // deeper entries. Returns null when no dc data is available.
  function dcLabel(dc) {
    if (dc == null) return null;
    if (dc === 1) return 'STARTER';
    if (dc === 2) return 'BACKUP';
    return `DEPTH ${dc}`;
  }

  // Injury status → severity class for colour coding.
  function injClass(status) {
    if (!status) return '';
    const s = status.toLowerCase();
    if (s === 'out' || s === 'ir' || s === 'injured reserve') return 'inj-out';
    if (s === 'dnr') return 'inj-dnr';
    return 'inj-q';  // Questionable (most common)
  }

  // Update depth-chart chip and injury badge on an existing row node.
  // Called on every updatePlayerRow so any newly-fetched Sleeper data appears
  // instantly without a full row rebuild.
  function applySleeperBadges(li, playerId) {
    const sd = (typeof SleeperData !== 'undefined')
      ? SleeperData.getPlayer(playerId)
      : {};

    // --- Depth-chart chip (inline in player-meta) ---
    const dcEl = li.querySelector('.dc-badge');
    if (dcEl) {
      const label = dcLabel(sd.dc);
      if (label) {
        dcEl.textContent = label;
        dcEl.hidden = false;
        dcEl.className = 'dc-badge dc-' + (sd.dc === 1 ? 'starter' : sd.dc === 2 ? 'backup' : 'depth');
      } else {
        dcEl.hidden = true;
      }
    }

    // --- Injury / status banner ---
    const badgesEl = li.querySelector('.sleeper-badges');
    if (!badgesEl) return;

    const injStatus = sd.inj || sd.status;  // status catches IR/PUP when no explicit injury_status
    if (!injStatus) {
      badgesEl.hidden = true;
      badgesEl.textContent = '';
      return;
    }

    // Build badge text: status + optional body part
    let badgeText = injStatus;
    if (sd.inj_part) badgeText += ': ' + sd.inj_part;
    if (sd.inj_note) badgeText += ' (' + sd.inj_note + ')';

    badgesEl.hidden = false;
    badgesEl.innerHTML =
      `<span class="inj-badge ${injClass(injStatus)}">`+
      `<i class="fa-solid fa-circle-exclamation"></i> `+
      escapeHtml(badgeText)+
      `</span>`;
  }

  // Maps a vs. ECR `diff` (referenceRank - myRank) to its display class + text:
  // positive (I'm higher on the player) => green "+N", negative => red "-N",
  // zero => neutral "0", and missing data => a muted "–". Shared by the initial
  // render (applyDeltaCell) and the post-drag in-place repaint so the two can
  // never drift apart.
  function deltaDisplay(diff) {
    if (diff == null) return { cls: 'delta-neutral', text: '–' };
    if (diff > 0) return { cls: 'delta-up', text: '+' + diff };
    if (diff < 0) return { cls: 'delta-down', text: String(diff) };
    return { cls: 'delta-even', text: '0' };
  }

  // Updates an existing .compare-cell element in place (class + value) for the
  // given diff. Replaces the old string-building renderDeltaCell — the cell now
  // lives in the cloned row prototype, so we only ever mutate it.
  function applyDeltaCell(cell, diff) {
    if (!cell) return;
    const { cls, text } = deltaDisplay(diff);
    cell.classList.remove('delta-up', 'delta-down', 'delta-even', 'delta-neutral');
    cell.classList.add(cls);
    const valEl = cell.querySelector('.compare-value');
    if (valEl) valEl.textContent = text;
  }

  // Tier rows use the same clone-a-prototype strategy as player rows so a full
  // render() never re-parses their (identical) static markup.
  let _tierRowProto = null;
  function getTierRowProto() {
    if (_tierRowProto) return _tierRowProto;
    const li = document.createElement('li');
    li.className = 'tier-row';
    li.dataset.type = 'tier';
    li.innerHTML = `
      <div class="drag-handle" aria-label="Drag tier" title="Drag tier">
        <i class="fa-solid fa-grip-vertical"></i>
      </div>
      <input class="tier-label" aria-label="Tier label" />
      <button class="icon-btn" data-action="remove-tier" aria-label="Remove tier" title="Remove tier">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    _tierRowProto = li;
    return li;
  }

  function createTierRow(tier, key) {
    const li = getTierRowProto().cloneNode(true);
    li.dataset.key = key;
    li.dataset.tierId = tier.id;
    updateTierRow(li, tier);
    return li;
  }

  // Update a tier row's mutable content (just its label) in place. Skips the
  // write while the input is focused so reconciling the list never clobbers
  // what the user is actively typing into the tier name.
  function updateTierRow(li, tier) {
    const input = li.querySelector('.tier-label');
    // .value is a property assignment — never parsed as markup, so no escaping
    // needed (and the label round-trips exactly, including characters like &).
    if (input && document.activeElement !== input && input.value !== tier.label) {
      input.value = tier.label;
    }
    return li;
  }

  // NOTE: the BYE chip is now built directly on the cloned row prototypes
  // (createPlayerRow / renderTeamRow) — players with no bye have their
  // .player-bye span removed so the CSS "BYE " ::before prefix never shows. The
  // old byeMarkup() string helper is therefore no longer needed.

  // escapeHtml is still used for the few remaining innerHTML interpolations that
  // run a bounded number of times per render (e.g. the My Team position-group
  // headers — at most one per position), not per row.
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[s]));
  }

  function updateMeta(visiblePlayerKeys = getVisiblePlayerKeys()) {
    const totalPlayers = Object.keys(state.players).length;
    const totalInTab = visiblePlayerKeys.length;

    if (filtersActive()) {
      const shown = visiblePlayerKeys.filter(k => {
        const p = state.players[k.slice(2)];
        return p && playerPassesFilters(p);
      }).length;
      const noun = state.activeTab === 'ALL' ? 'players' : `${state.activeTab}s`;
      $metaCount.textContent = `${shown} of ${state.activeTab === 'ALL' ? totalPlayers : totalInTab} ${noun}`;
    } else {
      $metaCount.textContent = state.activeTab === 'ALL'
        ? `${totalPlayers} players`
        : `${totalInTab} ${state.activeTab}s`;
    }
    $metaPicked.textContent = `${state.picked.size} picked`;
    $metaFav.textContent = `${state.favorites.size} favorites`;

    // My Team count only appears in the meta line when non-zero, to avoid
    // cluttering the toolbar during draft prep.
    const mine = state.myTeam.size;
    if ($metaMyTeam) {
      $metaMyTeam.hidden = mine === 0;
      if (mine > 0) $metaMyTeam.textContent = `${mine} my team`;
    }
    if ($metaMyTeamDot) $metaMyTeamDot.hidden = mine === 0;
  }

  // ---------- Sortable ----------
// Created ONCE and reused for the app's lifetime. Previously it was destroyed
// and rebuilt on every render (every keystroke, filter toggle, tab switch and
// tier drag) which caused noticeable churn, especially on phones. Filtered
// views simply toggle the `disabled` option instead.
function initSortable() {
  if (sortable || typeof Sortable === 'undefined') return;

  sortable = Sortable.create($list, {
    handle: '.drag-handle',
    direction: 'vertical',             // skip per-move axis detection — list is always vertical
    animation: 150,                    // 150ms is the sweet spot for the OTHER items sliding out of the way
    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',

    // --- Mobile Optimization ---
    forceFallback: true,               // Ignores native HTML5 drag API, forcing custom DOM element
    fallbackClass: 'sortable-drag',    // Applies your drag class to the cloned fallback element
    fallbackOnBody: true,              // Appends clone to body so it isn't clipped by scrollable containers
    // No `delay` — the drag is handle-only (and the handle has
    // touch-action:none), so touching the handle is already an explicit
    // intent to drag. Removing the 50ms touch delay makes pickup feel
    // instant on phones. A tiny tolerance still filters out stray taps.
    fallbackTolerance: 3,
    touchStartThreshold: 3,
    // ----------------------------

    scroll: true,
    scrollSensitivity: 80,
    scrollSpeed: 20,                   // Bumped slightly for faster mobile edge-scrolling
    bubbleScroll: true,
    onStart() {
      // Perf mode: CSS uses this to pause hover transitions and the
      // expensive header backdrop blur while a drag is in flight.
      document.body.classList.add('is-dragging');
    },
    onEnd(evt) {
      document.body.classList.remove('is-dragging');
      handleDragEnd(evt);
    },
  });
}

function setSortableEnabled(enabled) {
  if (sortable) sortable.option('disabled', !enabled);
}

function handleDragEnd(evt) {
  if (evt.oldIndex === evt.newIndex) return;

  const visible = getVisibleOrder();
  const movedKey = visible[evt.oldIndex];
  if (!movedKey) return;

  // Compute the new full visible layout after the drop.
  const reordered = visible.slice();
  reordered.splice(evt.oldIndex, 1);
  reordered.splice(evt.newIndex, 0, movedKey);

  if (movedKey.startsWith('t:')) {
    // --- Moving a TIER: only re-anchor it within THIS tab. ---
    // Tiers are independent per tab, so the master player order is untouched
    // and no other tab is affected. A tier move never changes player ranks or
    // the vs. ECR deltas (those depend only on player order), and Sortable has
    // already physically dropped the tier node where the user released it — so
    // there is nothing to recompute and NO reason to rebuild the 350+ player
    // rows. We only persist the new anchor and (cheaply) reconcile tier-node
    // positions to the canonical layout. Previously this branch called the
    // full render(), throwing away and recreating every row node.
    const tierId = movedKey.slice(2);
    const idx = reordered.indexOf(movedKey);
    // Anchor = the first player AFTER the tier in the new layout.
    let anchor = null;
    for (let i = idx + 1; i < reordered.length; i++) {
      if (reordered[i].startsWith('p:')) { anchor = reordered[i].slice(2); break; }
    }
    if (state.tiers[tierId]) state.tiers[tierId].anchor = anchor;

    scheduleSave();
    // Snap tier rows to the canonical layout WITHOUT rebuilding players. This
    // is a no-op in the common case (Sortable already placed the node right),
    // and it keeps the DOM identical to what a full render() would produce —
    // e.g. for the existing rule that same-anchor tiers fall back to a stable
    // order — so the next natural render can never make the list "jump".
    reconcileTierNodes();
    return;
  }

  // --- Moving a PLAYER: reorder the master player list (stays linked). ---
  const newPlayerKeys = reordered.filter(k => k.startsWith('p:'));

  if (state.activeTab === 'ALL') {
    state.order = newPlayerKeys;
  } else {
    // Splice the reordered subset of this position back into the master order,
    // preserving every other position's relative order.
    const visiblePlayerSet = new Set(getVisiblePlayerKeys());
    const queue = newPlayerKeys.slice();
    state.order = state.order.map(key => {
      if (visiblePlayerSet.has(key)) return queue.shift();
      return key;
    });
  }

  // Re-anchor any tier whose anchor player just moved out from under it, so
  // tiers visually stay where the user left them in this tab.
  reanchorTiersFromLayout(reordered);

  scheduleSave();
  updateMeta();
  updateRankNumbers();
}

// Reposition ONLY the tier <li> nodes so they match the canonical layout
// produced by getVisibleOrder(), without touching (or rebuilding) any player
// row. Used after a tier drag instead of a full render(): player rows keep
// their existing DOM nodes (and scroll position), and we move at most a couple
// of lightweight tier nodes. The end result is byte-for-byte the same DOM the
// old full render() produced, so behaviour is unchanged — just far cheaper.
function reconcileTierNodes() {
  const order = getVisibleOrder(); // canonical players+tiers layout for this tab

  // Map every player key already in the DOM to its node, so we can insert a
  // tier "before" its anchor player without re-querying repeatedly.
  const playerNodeByKey = new Map();
  const tierNodeById = new Map();
  for (const node of $list.children) {
    if (node.dataset.type === 'player') playerNodeByKey.set(node.dataset.key, node);
    else if (node.dataset.type === 'tier') tierNodeById.set(node.dataset.tierId, node);
  }

  // Walk the canonical order; whenever we hit a tier, ensure its node sits
  // immediately before the next player node (or at the end if none follows).
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (!key.startsWith('t:')) continue;
    const tierNode = tierNodeById.get(key.slice(2));
    if (!tierNode) continue;

    // Find the reference node = first player AFTER this tier in canonical order.
    let refNode = null;
    for (let j = i + 1; j < order.length; j++) {
      if (order[j].startsWith('p:')) { refNode = playerNodeByKey.get(order[j]) || null; break; }
    }
    // Place the tier immediately before its reference player (or at the end if
    // none follows). Because we walk in canonical order, consecutive same-anchor
    // tiers each land just before the anchor and so stack in the right order.
    // insertBefore is a cheap move (and a no-op when already positioned); with
    // only a handful of tiers there's no need to micro-optimise it away.
    if (tierNode.nextSibling !== refNode) {
      $list.insertBefore(tierNode, refNode); // refNode === null => appends to end
    }
  }
}

// After a player reorder, recompute each visible tier's anchor from the
// on-screen layout so tiers don't "jump" relative to surrounding players.
function reanchorTiersFromLayout(layout) {
  for (let i = 0; i < layout.length; i++) {
    const key = layout[i];
    if (!key.startsWith('t:')) continue;
    const tierId = key.slice(2);
    if (!state.tiers[tierId] || state.tiers[tierId].tab !== state.activeTab) continue;
    let anchor = null;
    for (let j = i + 1; j < layout.length; j++) {
      if (layout[j].startsWith('p:')) { anchor = layout[j].slice(2); break; }
    }
    state.tiers[tierId].anchor = anchor;
  }
}

// After a drag, repaint each visible row's rank number AND its vs. ECR cell in
// a single DOM pass (no full re-render). Previously this walked the row list
// twice — once for ranks, once for compare cells — over the same nodes.
function updateRankNumbers() {
  const comparisons = computeComparisons(getVisiblePlayerKeys());
  let rankNum = 0;
  $list.querySelectorAll('[data-type="player"]').forEach(row => {
    rankNum++;
    const rankEl = row.querySelector('.rank');
    if (rankEl) rankEl.textContent = rankNum;

    const cell = row.querySelector('.compare-cell[data-field="ecr"]');
    if (!cell) return;
    const cmp = comparisons.get('p:' + row.dataset.playerId);
    applyDeltaCell(cell, cmp ? cmp.ecr : null);
  });
}

  // ---------- Actions ----------
  function toggleFavorite(playerId) {
    if (state.favorites.has(playerId)) state.favorites.delete(playerId);
    else state.favorites.add(playerId);
    scheduleSave();

    // If the Watchlist filter is on, un-favoriting must remove the row.
    if (filters.watchlist) { render(); return; }

    const row = $list.querySelector(`[data-player-id="${playerId}"]`);
    if (row) {
      const isFav = state.favorites.has(playerId);
      row.classList.toggle('favorited', isFav);
      const btn = row.querySelector('[data-action="favorite"]');
      if (btn) {
        btn.classList.toggle('active', isFav);
        const icon = btn.querySelector('i');
        if (icon) icon.className = `fa-${isFav ? 'solid' : 'regular'} fa-star`;
      }
    }
    updateMeta();
  }

  // Re-sync a single row's off-board classes + action buttons to the current
  // state, without a full re-render. Used by togglePicked / toggleMine so the
  // row updates instantly while the rest of the list (and scroll) stays put.
  function syncRowState(playerId) {
    const row = $list.querySelector(`[data-player-id="${playerId}"]`);
    if (!row) return;
    const isPicked = state.picked.has(playerId);
    const isMine = state.myTeam.has(playerId);

    row.classList.toggle('picked', isPicked);
    row.classList.toggle('mine', isMine);

    const pickBtn = row.querySelector('[data-action="pick"]');
    if (pickBtn) {
      pickBtn.classList.toggle('active', isPicked);
      const pickIcon = pickBtn.querySelector('i');
      pickIcon.className = `fa-solid fa-${isPicked ? 'check' : 'circle-check'}`;
      pickIcon.style.opacity = isPicked ? '' : '0.55';
    }
    const mineBtn = row.querySelector('[data-action="mine"]');
    if (mineBtn) mineBtn.classList.toggle('active', isMine);
  }

  function togglePicked(playerId) {
    // Marking as "picked" means another manager drafted them — they can't
    // also be on YOUR team, so clear My Team membership for this player.
    if (state.picked.has(playerId)) {
      state.picked.delete(playerId);
    } else {
      state.picked.add(playerId);
      state.myTeam.delete(playerId);
    }
    scheduleSave();

    // If Hide Picked is on, marking a player off-board must remove the row
    // (covers both picked and My Team members).
    if (filters.hidePicked && isOffBoard(playerId)) { render(); updateMyTeamBadge(); return; }

    syncRowState(playerId);
    updateMeta();
    updateMyTeamBadge();
    if (isTeamDrawerOpen()) renderTeam();
  }

  function toggleMine(playerId) {
    // "Picked By Me" drafts the player onto your roster. They're off the
    // board for everyone, so clear any plain "picked" status first.
    if (state.myTeam.has(playerId)) {
      state.myTeam.delete(playerId);
    } else {
      state.myTeam.add(playerId);
      state.picked.delete(playerId);
    }
    scheduleSave();

    if (filters.hidePicked && isOffBoard(playerId)) { render(); updateMyTeamBadge(); return; }

    syncRowState(playerId);
    updateMeta();
    updateMyTeamBadge();
    if (isTeamDrawerOpen()) renderTeam();

    const added = state.myTeam.has(playerId);
    showToast(added
      ? 'Added to My Team'
      : 'Removed from My Team', 1200);
  }

  // ---------- Filters ----------
  function setSearch(value) {
    filters.search = value.trim();
    if ($searchClear) $searchClear.hidden = !filters.search;
    render();
  }

  function setWatchlist(on) {
    filters.watchlist = on;
    if ($filterWatchlist) $filterWatchlist.checked = on;
    render();
  }

  function setHidePicked(on) {
    filters.hidePicked = on;
    if ($filterHidePicked) $filterHidePicked.checked = on;
    render();
  }

  function addTier(atTop = true) {
    if (filtersActive()) {
      showToast('Clear filters to add a tier');
      return;
    }
    const id = uid('t');
    // Number tiers within the current tab only.
    const tabTierCount = Object.values(state.tiers)
      .filter(t => t.tab === state.activeTab).length;

    // New tier is added at the top of the current tab: anchor to the first
    // visible player in this tab (null = empty tab => bottom/standalone).
    const firstPlayerKey = getVisiblePlayerKeys()[0];
    const anchor = firstPlayerKey ? firstPlayerKey.slice(2) : null;

    state.tiers[id] = {
      id,
      label: `Tier ${tabTierCount + 1}`,
      tab: state.activeTab,
      anchor,
    };

    scheduleSave();
    render();
    requestAnimationFrame(() => {
      const el = $list.querySelector(`[data-tier-id="${id}"] .tier-label`);
      if (el) { el.focus(); el.select(); }
    });
  }

  function removeTier(tierId) {
    delete state.tiers[tierId];
    scheduleSave();
    render();
  }

  function renameTier(tierId, label) {
    if (state.tiers[tierId]) {
      state.tiers[tierId].label = label;
      scheduleSave();
    }
  }

  function resetAll() {
    state.order = defaultPlayers.map(p => 'p:' + p.id);
    state.favorites = new Set();
    state.picked = new Set();
    state.myTeam = new Set();
    state.tiers = {};
    // Tiers are rebuilt with fresh ids, so any cached tier rows are now stale.
    // Drop the whole keyed cache and let render() rebuild from clean state.
    clearRowCache();
    // Clear transient filters too (set state directly — setWatchlist /
    // setHidePicked each trigger a render, which would re-render 3× here).
    filters.watchlist = false;
    filters.hidePicked = false;
    filters.search = '';
    if ($filterWatchlist) $filterWatchlist.checked = false;
    if ($filterHidePicked) $filterHidePicked.checked = false;
    if ($search) $search.value = '';
    if ($searchClear) $searchClear.hidden = true;
    save(); // flush immediately — destructive reset must be persisted at once
    render();
    updateMyTeamBadge();
    if (isTeamDrawerOpen()) renderTeam();
    showToast('Rankings reset to default');
  }

  // ---------- Tabs ----------
  function setActiveTab(tab, doRender = true) {
    state.activeTab = tab;
    $tabs.forEach(t => {
      const active = t.dataset.tab === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active);
    });
    updateTabIndicator();
    scheduleSave();
    if (doRender) render();
  }

  function updateTabIndicator() {
    const activeTab = document.querySelector('.tab.active');
    if (!activeTab || !$tabIndicator) return;
    const rect = activeTab.getBoundingClientRect();
    const parentRect = activeTab.parentElement.getBoundingClientRect();
    const left = rect.left - parentRect.left + activeTab.parentElement.scrollLeft;
    $tabIndicator.style.width = rect.width + 'px';
    $tabIndicator.style.transform = `translateX(${left}px)`;
  }

  // ---------- My Team drawer ----------
  // The roster view. Lists every "Picked By Me" player, grouped by position,
  // in draft order. Supports any league/roster size — no position caps. The
  // drawer re-renders instantly whenever a player is added or removed.

  function isTeamDrawerOpen() {
    return $teamDrawer && !$teamDrawer.hidden;
  }

  function openTeamDrawer() {
    if (!$teamDrawer) return;
    $teamDrawer.hidden = false;
    $teamDrawer.setAttribute('aria-hidden', 'false');
    $myTeamBtn.setAttribute('aria-expanded', 'true');
    renderTeam();
    // Animate the panel in on the next frame so the transition runs.
    requestAnimationFrame(() => $teamDrawer.classList.add('open'));
    document.body.classList.add('team-open'); // lock background scroll on mobile
  }

  function closeTeamDrawer() {
    if (!$teamDrawer) return;
    $teamDrawer.classList.remove('open');
    $myTeamBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('team-open');
    // Hide after the slide-out transition completes.
    const done = () => {
      $teamDrawer.hidden = true;
      $teamDrawer.setAttribute('aria-hidden', 'true');
      $teamDrawer.removeEventListener('transitionend', done);
    };
    $teamDrawer.addEventListener('transitionend', done);
    // Safety: ensure it hides even if transitionend doesn't fire.
    setTimeout(done, 350);
  }

  // Update the header badge + its visibility. Called wherever My Team changes.
  function updateMyTeamBadge() {
    const count = state.myTeam.size;
    $myTeamBadge.textContent = count;
    $myTeamBadge.hidden = count === 0;
  }

  // Render the roster into the drawer. Players are grouped by position in
  // a stable display order (QB, RB, WR, TE, K, DST, then anything else),
  // within each group in overall draft order.
  function renderTeam() {
    if (!$teamBody) return;

    // Resolve drafted players + their overall rank (master order position),
    // which doubles as draft order.
    const drafted = [];
    state.order.forEach((key, i) => {
      const pid = key.slice(2);
      if (state.myTeam.has(pid) && state.players[pid]) {
        drafted.push({ player: state.players[pid], overallRank: i + 1 });
      }
    });

    $teamSummary.textContent = drafted.length === 1
      ? '1 player'
      : `${drafted.length} players`;

    if (drafted.length === 0) {
      $teamBody.replaceChildren();
      $teamEmpty.hidden = false;
      return;
    }
    $teamEmpty.hidden = true;

    // Group by position, using a stable, sensible display order. Any position
    // not in POSITIONS (e.g. a custom "FLEX") is appended after the known ones
    // in first-seen order — so the view adapts to any league's positions.
    const positionOrder = POSITIONS.filter(p => p !== 'ALL');
    const groupOrder = [...positionOrder];
    const groups = new Map();
    drafted.forEach(({ player, overallRank }) => {
      const pos = player.position || '?';
      if (!groups.has(pos)) {
        groups.set(pos, []);
        if (!groupOrder.includes(pos)) groupOrder.push(pos);
      }
      groups.get(pos).push({ player, overallRank });
    });

    const frag = document.createDocumentFragment();
    groupOrder.forEach(pos => {
      const members = groups.get(pos);
      if (!members || members.length === 0) return;

      const section = document.createElement('section');
      section.className = 'team-group';

      const header = document.createElement('div');
      header.className = 'team-group-head';
      header.innerHTML = `
        <span class="team-group-pos pos-chip ${escapeHtml(pos)}">${escapeHtml(pos)}</span>
        <span class="team-group-label">${escapeHtml(positionLabel(pos))}</span>
        <span class="team-group-count">${members.length}</span>
      `;
      section.appendChild(header);

      members.forEach(({ player, overallRank }) => {
        section.appendChild(renderTeamRow(player, overallRank));
      });

      frag.appendChild(section);
    });

    $teamBody.replaceChildren(frag);
  }

  // Roster row prototype (cloned per drafted player) — same rationale as the
  // player/tier prototypes.
  let _teamRowProto = null;
  function getTeamRowProto() {
    if (_teamRowProto) return _teamRowProto;
    const li = document.createElement('div');
    li.className = 'team-row';
    li.innerHTML = `
      <div class="team-row-rank"></div>
      <div class="team-row-logo">
        <img alt="" loading="lazy" decoding="async" />
      </div>
      <div class="team-row-info">
        <div class="team-row-name"></div>
        <div class="team-row-meta">
          <span class="player-team"></span>
          <span class="player-bye" hidden></span>
        </div>
      </div>
      <button class="icon-btn team-row-remove" data-action="remove-from-team"
              aria-label="Remove from My Team" title="Remove from My Team">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    _teamRowProto = li;
    return li;
  }

  function renderTeamRow(p, overallRank) {
    const li = getTeamRowProto().cloneNode(true);
    li.dataset.playerId = p.id;

    li.querySelector('.team-row-rank').textContent = overallRank;

    const img = li.querySelector('.team-row-logo img');
    img.src = teamLogoUrl(p.team);
    img.alt = p.team + ' logo';
    img.dataset.team = p.team;

    li.querySelector('.team-row-name').textContent = p.name;
    li.querySelector('.team-row-meta .player-team').textContent = p.team;

    const byeEl = li.querySelector('.player-bye');
    if (p.bye == null || p.bye === '') {
      byeEl.remove();
    } else {
      byeEl.hidden = false;
      byeEl.textContent = p.bye;
    }
    return li;
  }

  // Human-readable label for a position group header (e.g. QB -> "Quarterback").
  const POSITION_LABELS = {
    QB: 'Quarterback', RB: 'Running Back', WR: 'Wide Receiver',
    TE: 'Tight End', K: 'Kicker', DST: 'Defense / ST',
  };
  function positionLabel(pos) {
    return POSITION_LABELS[pos] || pos;
  }

  // ---------- Export ----------
  // Build the woven (players + tiers) layout for a given tab, used by exports.
  function buildExportLayout(tab) {
    const prevTab = state.activeTab;
    state.activeTab = tab;
    const layout = getVisibleOrder();
    state.activeTab = prevTab;
    return layout;
  }

  function exportCSV() {
    const rows = [['Rank', 'Position', 'Player', 'Team', 'Bye', 'Tier',
      'ECR', 'vs. ECR', 'Favorite', 'Picked', 'My Team']];

    // Overall vs. ECR deltas (computed against the full list).
    const overallKeys = state.order.slice();
    const overallCmp = computeComparisons(overallKeys);
    const fmtDelta = d => (d == null ? '' : (d > 0 ? '+' + d : String(d)));

    let rank = 0;
    let currentTier = '';
    buildExportLayout('ALL').forEach(key => {
      if (key.startsWith('t:')) {
        currentTier = state.tiers[key.slice(2)]?.label || '';
      } else {
        rank++;
        const p = state.players[key.slice(2)];
        if (!p) return;
        const cmp = overallCmp.get(key) || {};
        rows.push([
          rank, p.position, p.name, p.team, p.bye, currentTier,
          getMetaValue(p.id, 'ecr') ?? '', fmtDelta(cmp.ecr),
          state.favorites.has(p.id) ? 'Yes' : '',
          state.picked.has(p.id) ? 'Yes' : '',
          state.myTeam.has(p.id) ? 'Yes' : '',
        ]);
      }
    });
    const csv = rows.map(r => r.map(cell => {
      const s = String(cell ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');

    downloadBlob(csv, 'draft-rankings.csv', 'text/csv;charset=utf-8;');
    showToast('CSV exported');
  }

  function exportPDF() {
    if (!window.jspdf) {
      showToast('PDF library not loaded');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    let y = margin;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Draft Board — Fantasy Rankings', margin, y);
    y += 22;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(`Generated ${new Date().toLocaleString()}`, margin, y);
    y += 20;
    doc.setTextColor(0);

    let rank = 0;
    buildExportLayout('ALL').forEach(key => {
      if (y > 740) { doc.addPage(); y = margin; }

      if (key.startsWith('t:')) {
        const t = state.tiers[key.slice(2)];
        if (!t) return;
        y += 6;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(255, 91, 60);
        doc.text(t.label.toUpperCase(), margin, y);
        doc.setDrawColor(255, 91, 60);
        doc.line(margin, y + 3, pageWidth - margin, y + 3);
        doc.setTextColor(0);
        y += 16;
      } else {
        rank++;
        const p = state.players[key.slice(2)];
        if (!p) return;
        const fav = state.favorites.has(p.id) ? ' ★' : '';
        const picked = state.picked.has(p.id) ? ' [PICKED]' : '';
        const mine = state.myTeam.has(p.id) ? ' [MY TEAM]' : '';
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        const byeStr = (p.bye == null || p.bye === '') ? '' : ` · BYE ${p.bye}`;
        const line = `${String(rank).padStart(3, ' ')}.  ${p.name}${fav}  —  ${p.position} · ${p.team}${byeStr}${picked}${mine}`;
        doc.text(line, margin, y);
        y += 16;
      }
    });

    doc.save('draft-rankings.pdf');
    showToast('PDF exported');
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Backup / Restore / Manual Save ----------
  // These give the user explicit control over the same localStorage snapshot
  // the app auto-saves on every change. They don't alter how the app works —
  // they read/write the exact persisted shape (serializeState) and re-apply it
  // through the same load path (applySavedState), so behaviour is identical to
  // a normal reload.

  const BACKUP_FORMAT = 'draftboard-backup';
  const BACKUP_VERSION = 1;

  // Manual Save — force-write the current state to localStorage. Auto-save
  // already runs on every change; this button is for user reassurance.
  function manualSave() {
    flushSave(); // cancel any pending debounced write first
    const ok = save();
    showToast(ok ? 'Saved to this device' : 'Save failed — storage unavailable');
  }

  // Backup — download a self-contained JSON file of the full current state.
  // The file wraps the persisted snapshot in a small envelope (format/version/
  // timestamp + app storage key) so it can be validated on restore and
  // transferred to another device.
  function backupData() {
    // Flush any pending debounced write first so the backup file always
    // reflects the absolute latest in-memory state.
    flushSave();
    const payload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      app: 'Draft Board — Fantasy Football Cheatsheet',
      storageKey: STORAGE_KEY,
      exportedAt: new Date().toISOString(),
      // The complete user data — every customization the app stores.
      data: serializeState(),
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(
      JSON.stringify(payload, null, 2),
      `draftboard-backup-${stamp}.json`,
      'application/json;charset=utf-8;'
    );
    showToast('Backup downloaded');
  }

  // Open the hidden file picker. The actual restore runs on its change event.
  function promptRestore() {
    if (!$restoreInput) { showToast('Restore unavailable'); return; }
    $restoreInput.value = ''; // allow re-picking the same file twice in a row
    $restoreInput.click();
  }

  // Pull the persisted snapshot object out of a parsed backup file. Accepts:
  //   1. The wrapped envelope produced by backupData()  -> .data
  //   2. A raw snapshot ({ order: [...] , ... }) — e.g. a hand-copied
  //      localStorage value — for maximum portability.
  // Returns the snapshot object, or null if it doesn't look valid.
  function extractSnapshot(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.format === BACKUP_FORMAT && parsed.data && typeof parsed.data === 'object') {
      return parsed.data;
    }
    // Fallback: treat the object itself as a raw snapshot if it carries the
    // signature `order` array.
    if (Array.isArray(parsed.order)) return parsed;
    return null;
  }

  // Handle a chosen restore file: read → parse → validate → confirm → apply.
  function handleRestoreFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let snapshot = null;
      try {
        snapshot = extractSnapshot(JSON.parse(String(reader.result)));
      } catch (e) {
        snapshot = null;
      }
      if (!snapshot || !Array.isArray(snapshot.order)) {
        showToast('Invalid backup file');
        return;
      }
      // Confirm before overwriting — restore replaces current rankings.
      openModal({
        title: 'Restore from backup?',
        body: 'This will replace your current rankings, tiers, favorites, picked, and My Team with the contents of the backup file.',
        confirmText: 'Restore',
        onConfirm: () => applyRestore(snapshot),
      });
    };
    reader.onerror = () => showToast('Could not read file');
    reader.readAsText(file);
  }

  // Apply a validated snapshot: persist it, then re-hydrate through the normal
  // load path so the restored state behaves exactly like a fresh reload.
  function applyRestore(snapshot) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('Failed to persist restored state', e);
    }
    applySavedState(snapshot);
    // The restored snapshot is a different dataset (new tier ids, possibly a
    // different player set), so any cached row nodes are stale — start fresh.
    clearRowCache();
    // Reset transient UI filters so the restored board is shown in full.
    filters.search = '';
    filters.watchlist = false;
    filters.hidePicked = false;
    if ($filterWatchlist) $filterWatchlist.checked = false;
    if ($filterHidePicked) $filterHidePicked.checked = false;
    if ($search) $search.value = '';
    if ($searchClear) $searchClear.hidden = true;

    setActiveTab(state.activeTab, false);
    render();
    updateMyTeamBadge();
    if (isTeamDrawerOpen()) renderTeam();
    showToast('Backup restored');
  }

  // ---------- Modal ----------
  let pendingConfirm = null;
  function openModal({ title, body, confirmText, onConfirm }) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent = body;
    $modalConfirm.textContent = confirmText;
    pendingConfirm = onConfirm;
    $modal.hidden = false;
  }
  function closeModal() {
    $modal.hidden = true;
    pendingConfirm = null;
  }

  // ---------- Events ----------
  function bindEvents() {
    $tabs.forEach(t => t.addEventListener('click', () => setActiveTab(t.dataset.tab)));

    // Coalesce resize bursts into one frame-aligned indicator update.
    let resizeRaf = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(updateTabIndicator);
    }, { passive: true });
    // Re-measure once webfonts finish loading (tab text width can shift as the
    // fallback font is swapped for Inter). The Font Loading API fires exactly
    // when fonts are ready; `load` is a belt-and-braces fallback for browsers
    // without it (and covers any other late layout shifts).
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(updateTabIndicator);
    }
    window.addEventListener('load', updateTabIndicator, { once: true });

    // Delegated logo fallback (error events don't bubble, so use capture).
    // Marks the team as missing so future renders skip the failed request.
    $list.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      if (img.dataset.team) missingLogos.add(img.dataset.team);
      if (!img.src.endsWith('_placeholder.svg')) img.src = LOGO_PLACEHOLDER;
    }, true);

    $list.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;
      const row = actionBtn.closest('[data-key]');
      const action = actionBtn.dataset.action;

      if (action === 'favorite') {
        toggleFavorite(row.dataset.playerId);
      } else if (action === 'pick') {
        togglePicked(row.dataset.playerId);
      } else if (action === 'mine') {
        toggleMine(row.dataset.playerId);
      } else if (action === 'remove-tier') {
        removeTier(row.dataset.tierId);
      }
    });

    $list.addEventListener('change', (e) => {
      if (e.target.classList.contains('tier-label')) {
        const row = e.target.closest('[data-tier-id]');
        renameTier(row.dataset.tierId, e.target.value.trim() || 'Tier');
      }
    });
    $list.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('tier-label') && e.key === 'Enter') {
        e.target.blur();
      }
    });

    $addTierBtn.addEventListener('click', () => addTier(true));

    // ---- Restore: hidden file picker change ----
    if ($restoreInput) {
      $restoreInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        handleRestoreFile(file);
      });
    }

    // ---- My Team drawer ----
    $myTeamBtn.addEventListener('click', () => {
      if (isTeamDrawerOpen()) closeTeamDrawer();
      else openTeamDrawer();
    });
    // Close on backdrop / explicit close buttons.
    if ($teamDrawer) {
      $teamDrawer.addEventListener('click', (e) => {
        if (e.target.closest('[data-team-close]')) closeTeamDrawer();
      });
    }
    // Remove a player from My Team via the drawer's × button. Delegated so it
    // works for any roster size without rebinding.
    if ($teamBody) {
      $teamBody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-from-team"]');
        if (!btn) return;
        const row = btn.closest('[data-player-id]');
        if (row) toggleMine(row.dataset.playerId);
      });
      // Logo fallback for team-row logos (error events don't bubble → capture).
      $teamBody.addEventListener('error', (e) => {
        const img = e.target;
        if (!img || img.tagName !== 'IMG') return;
        if (img.dataset.team) missingLogos.add(img.dataset.team);
        if (!img.src.endsWith('_placeholder.svg')) img.src = LOGO_PLACEHOLDER;
      }, true);
    }
    // Esc closes the drawer (only when no modal is open — modal takes priority).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isTeamDrawerOpen() && $modal.hidden) closeTeamDrawer();
    });

    // ---- Search + filter controls ----
    // Debounce: re-rendering the full list on every keystroke is wasteful
    // (and was the main cause of typing lag on phones). 120ms keeps it
    // feeling live while collapsing rapid keystrokes into one render.
    let searchTimer = 0;
    if ($search) {
      $search.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        const value = e.target.value;
        searchTimer = setTimeout(() => setSearch(value), 120);
      });
      $search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          clearTimeout(searchTimer);
          $search.value = '';
          setSearch('');
        }
      });
    }
    if ($searchClear) {
      $searchClear.addEventListener('click', () => {
        clearTimeout(searchTimer);
        $search.value = '';
        setSearch('');
        $search.focus();
      });
    }
    if ($filterWatchlist) {
      $filterWatchlist.addEventListener('change', (e) => setWatchlist(e.target.checked));
    }
    if ($filterHidePicked) {
      $filterHidePicked.addEventListener('change', (e) => setHidePicked(e.target.checked));
    }

    $menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !$menuDropdown.hidden;
      $menuDropdown.hidden = isOpen;
      $menuBtn.setAttribute('aria-expanded', !isOpen);
    });
    document.addEventListener('click', (e) => {
      if (!$menuDropdown.hidden && !$menuDropdown.contains(e.target) && e.target !== $menuBtn) {
        $menuDropdown.hidden = true;
        $menuBtn.setAttribute('aria-expanded', 'false');
      }
    });

    $menuDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      const action = item.dataset.action;
      $menuDropdown.hidden = true;
      $menuBtn.setAttribute('aria-expanded', 'false');

      if (action === 'manual-save') manualSave();
      else if (action === 'backup') backupData();
      else if (action === 'restore') promptRestore();
      else if (action === 'export-csv') exportCSV();
      else if (action === 'export-pdf') exportPDF();
      else if (action === 'refresh-sleeper') {
        if (typeof SleeperData !== 'undefined') {
          updateSleeperStatusUI('loading');
          SleeperData.refresh().catch(() => {});
        }
      }
      else if (action === 'reset') {
        openModal({
          title: 'Reset rankings?',
          body: 'This will restore the default rankings and clear all tiers, favorites, and picked status. This cannot be undone.',
          confirmText: 'Reset',
          onConfirm: resetAll,
        });
      }
    });

    $modal.addEventListener('click', (e) => {
      if (e.target.matches('[data-close]')) closeModal();
    });
    $modalConfirm.addEventListener('click', () => {
      if (pendingConfirm) pendingConfirm();
      closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$modal.hidden) closeModal();
    });
  }

  // ---------- Boot ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();