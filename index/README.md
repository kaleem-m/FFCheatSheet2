# Draft Board — Fantasy Football Cheatsheet

A premium, fast, drag-and-drop fantasy football cheatsheet for draft prep and live drafts. Built as a static web app — no backend required.

## ✨ Completed Features

- **7 Tabs** — Overall, QB, RB, WR, TE, K, DST
- **Linked Rankings** — Overall is the master order; position tabs derive their order automatically and any reorder in any tab is reflected everywhere.
- **Buttery Drag-and-Drop** — Powered by SortableJS with `forceFallback` for identical touch + desktop behavior, auto-scroll, ghost/drag indicators, and smooth easing.
- **Player Row** — drag handle, rank #, **team logo**, name, team, position chip (Overall only), BYE week, **vs. ECR / vs. ADP** deltas, favorite ★, picked toggle.
- **Team Logos** — every player row shows its team logo (before the name). All 32 team codes have a logo file (a mix of full SVG logos and team-colored lettermark badges), so no row ever falls back to the placeholder or fires a 404. Logos are resolved purely from the player's `team` code via a single helper, so higher-fidelity logos can be dropped in later with zero code changes (see *Team Logos* below).
- **vs. ECR & vs. ADP (real-time)** — two columns showing how *your* ranking compares to the reference Expert Consensus Ranking (ECR) and Average Draft Position (ADP). They recompute live as you drag-and-drop. **+N (green)** = you rank the player higher than the reference; **−N (red)** = lower; **0** = same. Comparison is per-tab (RB-rank vs. RB-rank on the RB tab, overall vs. overall on Overall).
- **Picked Toggle** — instantly grays out + strikethrough; still visible and reversible.
- **Picked By Me / My Team** — a third player state for live drafts. Marking a player "Picked By Me" takes them off the board (like *Picked*) **and** adds them to the **My Team** roster drawer, so you can track your own draft. `Picked` and `Picked By Me` are mutually exclusive: drafting a player to your team clears any plain *Picked* status, and vice-versa. Your picks are tinted azure (distinct from the grey *Picked* and gold *Favorites*) and marked with a left accent stripe.
- **My Team Drawer** — a responsive side panel (header **My Team** button, with a live count badge) listing your drafted roster, **grouped by position** and ordered by overall rank (draft order). Supports any league/roster size — no position caps, and unknown positions (e.g. `FLEX`) are appended automatically. Updates instantly as players are added/removed; each roster row has a remove (×) button. On mobile it's a full-screen sheet with the page scroll locked behind it.
- **Favorites** — gold star, subtle row glow, persistent.
- **Tier Breaks** — add, drag, rename inline, remove. Persist across sessions. **Tiers are independent per tab** — a tier created on the RB tab lives only on the RB tab and never appears in or moves the Overall (or any other) view. Only the player rankings are dynamically linked.
- **Search & Filters** — live search bar (name / team / position) plus two toggles: **Watchlist** (show only favorited players) and **Hide Picked** (instantly drop greyed-out/picked players). Toggling off restores the full list. While filtering, reordering is disabled so the underlying ranking can't be corrupted.
- **Persistence** — `localStorage` saves rankings order, favorites, picked, tiers, and active tab. (Search/filter toggles are transient and reset on reload.)
- **Backup / Restore / Save Now** — in the menu (⋮): **Save Now** force-writes the current state to `localStorage` (auto-save already runs on every change; this is for reassurance). **Backup (Download JSON)** exports your full state to a timestamped, self-contained JSON file that can be moved to another device. **Restore from Backup** uploads a previously exported file and rebuilds the app state exactly as it was — through the same load path used on a normal reload, with a confirmation step and graceful rejection of invalid files. (Accepts both the backup envelope and a raw `localStorage` snapshot.)
- **Reset** — confirmation modal restores defaults & clears customizations.
- **Export** — CSV (priority) and PDF, both include custom order, tiers, favorites, and picked status.
- **Premium Dark Theme** — Inter + JetBrains Mono, accent-orange highlights, blurred sticky header, animated tab indicator.
- **Mobile-first responsive** — large touch targets (40px icon buttons, 72px row height on mobile), safe-area insets, no tap-highlight.
- **Toasts + Confirmation Modal** for clean feedback.
- **Accessibility** — semantic `<nav>`, `<main>`, ARIA roles on tabs/menu/modal, keyboard-dismissable modal.

## 📁 Project Structure

```
index.html             # App shell (header, tabs, list, modal, toast)
css/style.css          # Premium dark theme + responsive layout
js/app.js              # State, persistence, render, sortable, export
data/players.json      # Editable sample player data
data/rankings-meta.json# Editable ECR / ADP reference values (drives vs. columns)
assets/logos/          # Team logos (drop <team>.svg here) + _placeholder.svg
```

## 🖼️ Team Logos

Logos are looked up by a player's `team` abbreviation in `js/app.js` via `teamLogoUrl(team)`:

```js
const LOGO_DIR = 'assets/logos/';
const LOGO_EXT = '.svg';                 // default file extension
const LOGO_EXT_OVERRIDES = {};           // e.g. { SF: '.png' } per-team override
```

Every team referenced in `players.json` ships with a logo file named after the
**lowercase team code** (e.g. `assets/logos/sf.svg`, `assets/logos/dal.svg`,
`assets/logos/kc.svg`). Some are full logos and some are team-colored
lettermark badges — to upgrade any of them, just overwrite the file; no code
changes needed. If a file is ever missing, the row automatically falls back to
`assets/logos/_placeholder.svg`. To re-point logos to a CDN/sprite, edit only
the `teamLogoUrl` helper.

## 📊 ECR / ADP (`data/rankings-meta.json`)

Reference rankings that power the **vs. ECR** and **vs. ADP** columns:

```json
{
  "p1": { "ecr": 1, "adp": 1.5 },
  "p2": { "ecr": 3, "adp": 1 }
}
```

- Keyed by the same player `id` used in `players.json`.
- `ecr` = Expert Consensus Ranking, `adp` = Average Draft Position (decimals OK).
- The current values are **sample / randomized** — replace them with real data.
- A player missing from this file simply shows `–` in its vs. columns.
- The delta = `referenceRank − yourRank` within the active tab, so a player you
  rank higher than the reference shows `+N`.

## 🧩 Data Model

`data/players.json` — array of:
```json
{ "id": "p1", "name": "Christian McCaffrey", "team": "SF", "position": "RB", "bye": 9 }
```
Add/edit players here freely — the app re-loads from this file and merges new IDs into existing saved orders gracefully.

## 💾 Storage

All user customizations persist in `localStorage` under the key `draftboard.v1`:
```js
{
  order: ["p:p1","p:p2", ...],            // master PLAYER order only (dynamically linked across tabs)
  favorites: ["p1","p5"],
  picked: ["p3"],                          // off-board (drafted by others)
  myTeam: ["p1","p9"],                     // off-board AND on your roster ("Picked By Me")
  tiers: {                                 // tiers are INDEPENDENT per tab
    "t_abc": { id, label, tab: "RB", anchor: "p7" }  // shown above player p7 on the RB tab only
  },
  activeTab: "ALL"
}
```

**Tier model:** Each tier belongs to exactly one `tab` and is positioned by an `anchor` — the id of the player it should sit *above* within that tab (`anchor: null` = bottom of the tab). Players stay in a single shared master `order` (so reordering one RB above another updates everywhere), while tiers are scoped to their tab and never affect other views. Old saves that stored tiers inline in `order` are migrated automatically to the Overall tab on first load.

## 🖱️ Functional Entry Points (UI)

| Action | Where |
|---|---|
| Switch view | Tabs: Overall / QB / RB / WR / TE / K / DST |
| Search | Type in the search bar (matches name, team, position) |
| Watchlist filter | "Watchlist" toggle — shows favorites only |
| Hide picked filter | "Hide Picked" toggle — removes greyed-out players |
| Reorder | Drag the left handle (disabled while a filter/search is active) |
| Favorite | Star icon on each row |
| Mark picked | Check icon on each row |
| Draft to my team | User-check icon on each row (adds to My Team drawer) |
| View roster | "My Team" button in the header (badge shows count) |
| Remove from team | × icon on a roster row in the My Team drawer |
| Add tier | "Add Tier" button (adds to the current tab only) |
| Rename tier | Click the tier label and type |
| Remove tier | × icon on tier row |
| Save Now | Menu (⋮) → Save Now (force-saves to localStorage) |
| Backup | Menu (⋮) → Backup (downloads full state as JSON) |
| Restore | Menu (⋮) → Restore from Backup (uploads a JSON file; confirms first) |
| Export CSV | Menu (⋮) → Export CSV |
| Export PDF | Menu (⋮) → Export PDF |
| Reset | Menu (⋮) → Reset Rankings (confirms first) |

## 🛠️ Tech

- HTML / CSS / vanilla JS (no build step)
- [SortableJS](https://github.com/SortableJS/Sortable) for drag-and-drop
- [jsPDF](https://github.com/parallax/jsPDF) for PDF export
- Font Awesome 6 + Google Fonts (Inter, JetBrains Mono) via CDN

## 🚧 Not Yet Implemented / Recommended Next Steps

- **Custom league scoring profiles** (PPR / Standard / Half-PPR variants).
- **ECR / ADP import from CSV** (values are currently editable in `data/rankings-meta.json`).
- **Multi-list / multiple draft profiles** (full-state export/import is now available via Backup/Restore; per-profile lists are still a future step).
- **Undo last action** (snapshot stack).
- **PWA install + offline** (service worker + manifest).
- **TypeScript migration** (current implementation is plain JS for zero build complexity; structure is modular enough to port).

## 🚀 Deploy

Use the **Publish tab** to deploy and get a live URL.
