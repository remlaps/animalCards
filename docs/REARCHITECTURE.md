# BurnMax Rearchitecture Plan

> **Branch:** `rearchitecture-plan`
> **Date:** 2026-09-02
> **Status:** Draft — not yet implemented

---

## Overview

This document describes the planned rearchitecture of the `animalCards` project into
**three separate GitHub repos**, with zero change to how GitHub Pages serves the site.

### Current Architecture (Monolith)

```
animalCards (single repo)
├── card-resolver.js       ← deterministic card-assignment algorithm
├── difficulty.js           ← RABD (rarity-adjusted burn difficulty)
├── cards-config.json       ← the entire card catalogue (40+ cards)
├── blockchain-api.js       ← Steem RPC + config loading + difficulty dashboard
├── leaderboard.js          ← display layer (leaderboard page)
├── search.js               ← display layer (portfolio search page)
├── deck.html               ← display layer (card deck grid)
├── validate-cards.js       ← config sanity checker
├── resolve-card.js         ← CLI verification tool
├── test-cards.js           ← test suite
├── vaas.js / vaas.css      ← 3rd-party widget (already from its own repo)
└── *.html / style.css      ← pages, shared styling
```

### Target Architecture (3 Repos)

```
┌──────────────────────────┐
│     burnmax-engine       │  ← Generic algorithm, no game-specific data
│  card-resolver.js        │
│  difficulty.js           │
│  (generic validation)    │
└────────┬─────────────────┘
         │ depended by
┌────────▼─────────────────┐
│    animalcards-game      │  ← Game definition (config + CLI + tests)
│  cards-config.json       │
│  resolve-card.js         │
│  validate-cards.js       │
│  test-cards.js           │
│  test-snapshots.json     │
└────────┬─────────────────┘
│ consumed by
┌────────▼─────────────────┐
│    animalcards-web       │  ← Display layer (this repo, renamed)
│  blockchain-api.js       │
│  leaderboard.js          │
│  search.js               │
│  deck.html               │
│  *.html / style.css      │
│  vaas.js / vaas.css      │
└──────────────────────────┘
```

---

## Phase 1 — Extract `burnmax-engine`

### New repo: `remlaps/burnmax-engine`

**Files moved verbatim from `animalCards`:**

| File | Destination | Notes |
|---|---|---|
| `card-resolver.js` | `burnmax-engine/card-resolver.js` | Already UMD — no changes needed |
| `difficulty.js` | `burnmax-engine/difficulty.js` | Already UMD — no changes needed |

**New files in `burnmax-engine`:**

| File | Purpose |
|---|---|
| `index.js` | Thin re-export for Node consumers: `module.exports = { CardResolver, CardDifficulty }` |
| `package.json` | Metadata only (name, version, main). No dependencies. Not published to npm — lives on GitHub. |
| `test/test-engine.js` | Generic tests extracted from `test-cards.js` (determinism, slot layout, RABD arithmetic, hash consistency). |
| `README.md` | API reference + formal config schema documentation. |

### Changes in `animalCards` (soon `animalcards-web`):

**A. Add git submodule:**
```
git submodule add https://github.com/remlaps/burnmax-engine lib/burnmax-engine
```

GitHub Pages serves submodule files exactly like any other committed file.
The submodule pointer is committed into the repo — `gh-pages` doesn't need to clone
it recursively because `master` already pins the commit.

**B. Update all `.html` files** — change 2 `<script src>` paths:

| File | Before | After |
|---|---|---|
| `index.html` | `<script src="card-resolver.js">` | `<script src="lib/burnmax-engine/card-resolver.js">` |
| | `<script src="difficulty.js">` | `<script src="lib/burnmax-engine/difficulty.js">` |
| `leaderboard.html` | same | same |
| `search.html` | same | same |
| `deck.html` | same | same |

**C. Update 2 Node scripts** — change 2 `require()` paths:

| File | Before | After |
|---|---|---|
| `resolve-card.js` | `require('./card-resolver.js')` | `require('./lib/burnmax-engine/card-resolver.js')` |
| `test-cards.js` | `require('./card-resolver.js')` | `require('./lib/burnmax-engine/card-resolver.js')` |

**D. Changes to `blockchain-api.js`?** — **None.**
---

## Phase 2 — Extract `animalcards-game`

### New repo: `remlaps/animalcards-game`

**Files moved from `animalCards`:**

| File | Destination | Notes |
|---|---|---|
| `cards-config.json` | `animalcards-game/cards-config.json` | The full card catalogue |
| `resolve-card.js` | `animalcards-game/resolve-card.js` | CLI that depends on engine + config + Steem RPC |
| `validate-cards.js` | `animalcards-game/validate-cards.js` | Game-specific config sanity checks |
| `test-cards.js` | `animalcards-game/test-cards.js` | Game-specific tests (snapshot resolution, card identity fingerprints, generation windows) |
| `test-snapshots.json` | `animalcards-game/test-snapshots.json` | Historical resolution baselines |

**New files in `animalcards-game`:**

| File | Purpose |
|---|---|
| `index.js` | Thin wrapper: imports engine + config, exports `resolveCard(serial, blockHash, opts?)` pre-configured for animalCards. |
| `package.json` | Metadata plus `"dependencies": { "burnmax-engine": "^1.0.0" }` — for local Node use only. |
| `README.md` | Card catalogue editing guide, immutability rules, how to add/retire cards. |

**The wrapper API:**
```js
const { resolveCard, getConfig, getDifficulty } = require('animalcards-game');
const result = await resolveCard('123456.0', blockHash, { tie: false });
// → { status, className, rarity, slot, card: { species, image_url, ... } }
```

### Changes in `animalcards-web`:

**A. Add git submodule:**
```
git submodule add https://github.com/remlaps/animalcards-game lib/animalcards-game
```

**B. Remove local copies of:**
- `cards-config.json` — now loaded from `lib/animalcards-game/cards-config.json`
- `resolve-card.js` — now lives in the game repo
- `validate-cards.js` — now lives in the game repo
- `test-cards.js` — now lives in the game repo
- `test-snapshots.json` — now lives in the game repo

---

## Phase 3 — Refactor `animalcards-web` (Display Layer)

The repo `remlaps/animalCards` stays as `remlaps/animalcards-web` (name change optional).
It becomes a pure display layer.

**What stays:**
- `index.html` — landing page
- `leaderboard.html` / `leaderboard.js` — leaderboard display
- `search.html` / `search.js` — portfolio search display
- `deck.html` — card deck grid display
- `style.css` — shared styling
- `vaas.js` / `vaas.css` — VAAS widget (already from its own repo)
- `blockchain-api.js` — refactored to focus on Steem RPC only

**What `blockchain-api.js` becomes:**
- Strip out config loading (now from `animalcards-game`)
- Strip out card resolution (now from `burnmax-engine` via `animalcards-game`)
- Strip out difficulty dashboard rendering (move it to a separate module in the game repo)
- Keep only: Steem RPC calls, burn-winner extraction, block fetching

**No build step — still pure HTML/CSS/JS for GitHub Pages.**
All dependencies arrive via git submodules and are served as static files.

---

## Phase 4 (Optional) — Generic Steem RPC Client

Extract `blockchain-api.js`'s Steem RPC wrapper into a separate repo:
- `callSteem(method, params)`
- `getAccountHistory('null', timeConstraint)`
- `getCurrentBlock()`
- Returns raw data — no card logic, no config

Useful for both `animalcards-web` and `resolve-card.js` CLI.
Low priority; can happen at any time after Phase 3.

---

## Phase 5 (Optional) — Prove Genericity

Build a second game using only `burnmax-engine`:
---

## File Status Matrix

### animalCards (current) — final home after all phases

| Current File | Phase 1 | Phase 2 | Phase 3 | Final Home |
|---|---|---|---|---|
| `card-resolver.js` | 🟢 Move | — | — | `burnmax-engine` |
| `difficulty.js` | 🟢 Move | — | — | `burnmax-engine` |
| `cards-config.json` | — | 🟢 Move | — | `animalcards-game` |
| `resolve-card.js` | ⚡ Update require path | 🟢 Move | — | `animalcards-game` |
| `validate-cards.js` | — | 🟢 Move | — | `animalcards-game` |
| `test-cards.js` | ⚡ Update require path | 🟢 Move | — | `animalcards-game` |
| `test-snapshots.json` | — | 🟢 Move | — | `animalcards-game` |
| `blockchain-api.js` | — | 🔄 Refactor | 🔄 Refactor | `animalcards-web` |
| `leaderboard.js` | — | — | — | `animalcards-web` |
| `search.js` | — | — | — | `animalcards-web` |
| `deck.html` | — | — | — | `animalcards-web` |
| `index.html` | ⚡ Update script src | — | — | `animalcards-web` |
| `leaderboard.html` | ⚡ Update script src | — | — | `animalcards-web` |
| `search.html` | ⚡ Update script src | — | — | `animalcards-web` |
| `style.css` | — | — | — | `animalcards-web` |
| `vaas.js` / `vaas.css` | — | — | — | `animalcards-web` |

🟢 = Move verbatim   |   ⚡ = Update references   |   🔄 = Refactor

---

## Repository Structure (Final State)

### `remlaps/burnmax-engine`
```
├── card-resolver.js
├── difficulty.js
├── index.js
├── package.json
├── README.md
└── test/
    ├── test-engine.js
    └── test-vectors.json (generic)
```

### `remlaps/animalcards-game`
```
├── index.js
├── cards-config.json
├── resolve-card.js
├── validate-cards.js
├── test-cards.js
├── test-snapshots.json
├── package.json
├── README.md
└── lib/                      (submodule)
    └── burnmax-engine/
```

### `remlaps/animalcards-web`
```
├── index.html
├── leaderboard.html
├── leaderboard.js
├── search.html
├── search.js
├── deck.html
├── blockchain-api.js
├── style.css
├── vaas.js
├── vaas.css
├── docs/
│   └── REARCHITECTURE.md     (this file)
└── lib/                      (submodules)
    ├── burnmax-engine/
    │   ├── card-resolver.js
    │   └── difficulty.js
    └── animalcards-game/
        ├── cards-config.json
        ├── resolve-card.js
        └── ...
```

---

## Notes for the Implementer

1. **Phase 1 first, always.** It's the safest — two files move verbatim, everything keeps working.
2. **Do Phase 1 and deploy to production** before starting Phase 2. Let it bake.
3. **Submodules pin to specific commits.** After updating a dependency repo, run
   `git submodule update --remote` in the web repo and commit the new pointer.
4. **No npm, no CDN.** All dependencies arrive via git submodules. This is the
   constraint — don't relax it.
5. **UMD is the contract.** Both engine and game packages must export UMD bundles
   that work with `<script>` tags. This guarantees GitHub Pages compatibility.
1. Write a new config (e.g., `spacecards-config.json`)
2. Create `spacecards-game` repo — one thin wrapper file
3. Card resolution works identically — zero engine code duplication

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Module format** | UMD (Universal Module Definition) | One source of truth works in both Node (require) and browser (<script>). Already the format used. |
| **File loading on GitHub Pages** | Git submodules | No CDN, no npm, no build step. Submodule files are served like any static file. GitHub Pages handles them natively. |
| **Engine reads files?** | No — engine receives a config object as parameter | Keeps the engine purely algorithmic, testable, and game-agnostic. |
| **Web repo has package.json?** | Optional — only if a bundler is added later | Not needed for GitHub Pages. Local Node scripts work via submodule paths. |
| **Web repo has a build step?** | No | Must remain "commit JS/HTML → Pages serves it" to match the current workflow. |
**C. Update `blockchain-api.js`:**
- `loadConfig()` fetches from `lib/animalcards-game/cards-config.json` instead of local
- Card resolution calls the game package's exported wrapper

**D. Add `sync-deps.sh`:**
```bash
#!/bin/bash
# Convenience script for testing with local copies.
# Currently, all dependencies are loaded via git submodules at lib/
echo "Run from animalcards-web root: ./sync-deps.sh"
echo "All dependencies are served via git submodules — no sync needed."
```
It calls `CardResolver.hashForSerial()` and `CardDifficulty.effectiveMinBurns()` as globals.
The UMD modules still attach those globals to `window`. The code works exactly as before.

### What remains in `animalCards` after Phase 1:

Everything except `card-resolver.js` and `difficulty.js`. The config, the CLI tool,
the test suite, all HTML/CSS/JS display code — all unchanged.

### Verification after Phase 1:

```bash
# Node scripts still resolve correctly
node resolve-card.js 12345
node validate-cards.js
node test-cards.js

# Open any HTML page in browser — difficulty dashboard renders,
# leaderboard loads, search works. No console errors.
```
### Why 3 Repos, Not 2

| Layer | Concern | Why separate |
|---|---|---|
| **Engine** | How card assignment works | Reusable across **any** BurnMax-based game (animalCards, SpaceCards, etc.). Pure algorithm — no domain knowledge. |
| **Game** | What cards exist | Evolves independently (adding/retiring cards). **Is** the canonical game definition. Front-ends consume it; they don't duplicate it. |
| **Web** | How cards look | Styling, responsive layout, DOM rendering. Multiple front-ends could exist for the same game (web, Discord bot, mobile app). |

The config (`cards-config.json`) is a versioned artifact with its own immutability rules
(never delete cards, never change `card_id`/`rarity`/`slot` of released cards). It has its own
validation script and test snapshot. That's the hallmark of an independent module — it
belongs in its own repo.