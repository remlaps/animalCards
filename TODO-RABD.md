# RABD — Implementation Status & Remaining Work

Branch: `rarity-difficulty-scarcity` (master untouched)

## Done

- [x] `difficulty.js` — shared (UMD) RABD math module:
  - base minimums, schedule multipliers, demand multipliers, effective min calc
  - **per-rarity schedule**: each milestone may carry global `multiplier`,
    per-rarity `multipliers {rarity:n}`, and per-rarity `targets {rarity:n}`
  - `effectiveTarget()` — per-rarity target from schedule w/ root fallback
- [x] `card-resolver.js` — cascade resolution + `generic_reason` (`unreleased` | `below_minimum`)
- [x] `blockchain-api.js` — stores raw config, exposes `getEffectiveMinBurns()`, threads constraints
- [x] `leaderboard.js` / `search.js` — pass `winningBurnAmount`
- [x] `resolve-card.js` (CLI) — applies RABD; displays min/cascade/generic
- [x] `validate-cards.js` — validates `rarity_difficulty` (base, target, schedule
  incl. per-rarity multipliers/targets) + immutability warning when active
- [x] `cards-config.json` — `rarity_difficulty` block (disabled: `enabled_block: null`),
  schedule demo incl. per-rarity `multipliers`/`targets`
- [x] HTML — `difficulty.js` loaded before `blockchain-api.js` on all pages
- [x] `README.md` — RABD section, config schema, rules-of-thumb,
      RABD immutability rules in the determinism section
- [x] Language sanitized — no price/afford/cost framing (burn-threshold terms only)

## Immutability contract

Once `enabled_block` passes, everything in `rarity_difficulty` is locked (retroactive):
- ❌ change `rarities.*.base_min_burn`, `target_per_window`, `ceiling_multiplier`, `window_blocks`
- ❌ edit/remove/reorder a `schedule` entry whose `block` has passed
- ✅ APPEND new schedule milestones with future blocks (`multipliers` / `targets`)
  — this is the ONLY safe tuning knob after activation

## Activation (safe no-op first deploy)

1. Find current (or near-future) Steem block number.
2. Set `enabled_block` to that block in `cards-config.json`.
3. Optionally keep all `base_min_burn` at 0.001 and schedule at 1.0 →
   zero behavioral change, framework is live.
4. Raise values / append milestones incrementally — no further `enabled_block` flip needed.

## Remaining / Future

- [ ] **Wire `countsProvider`** — feed per-window award counts to
      `getEffectiveMinBurns()` so the demand multiplier actually adjusts.
  - `leaderboard.js`: already scans burn history; could tally per-rarity counts as it resolves.
  - `resolve-card.js` (CLI): per-window aggregates from `fetchNullWinners` for diagnostics.
  - `search.js`: per-account — probably skip.
- [ ] **Tune `target_per_window`** — once demand mode is wired, these matter.
      Current defaults (per ~1.7h window): C: 3028, R: 757, E: 189, L: 47, M: 12.
- [ ] **Adjust `schedule` milestones** — placeholder values (100M/200M/300M).
      Replace with real block targets and per-rarity numbers.
- [ ] **Frontend `generic_reason`** — card tiles still show the old
      "species will be released in the future" copy. Render
      `unreleased` vs `below_minimum` differently in `leaderboard.js`/`search.js`.
- [ ] **Deploy to GitHub Pages** — merge to master when ready.

## Config knobs (all in `cards-config.json` → `rarity_difficulty`)

| Knob | What |
|------|------|
| `enabled_block` | Block where RABD begins; `null` = off |
| `rarities.{r}.base_min_burn` | Floor burn per rarity (immutable after activation) |
| `rarities.{r}.target_per_window` | Root demand target (immutable after activation) |
| `schedule[].multiplier` | Global multiplier milestone (append-only after activation) |
| `schedule[].multipliers.{r}` | Per-rarity multiplier milestone |
| `schedule[].targets.{r}` | Per-rarity target milestone |
| `ceiling_multiplier` | Hard cap: effective never exceeds base × this (immutable) |
| `window_blocks` | Demand-adjustment epoch size, 2016 = ~1.7h (immutable) |