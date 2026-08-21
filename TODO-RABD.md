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
- ❌ change `rarities.*.base_min_burn`, `target_per_window`, `window_blocks`
- ❌ edit/remove/reorder a `schedule` entry whose `block` has passed
- ✅ APPEND new schedule milestones with future blocks (`multipliers` / `targets`)
  — this is the ONLY safe tuning knob after activation

## Activation (safe no-op first deploy)

1. Find current (or near-future) Steem block number.
2. Set `enabled_block` to that block in `cards-config.json`.
3. Root `base_min_burn` is already 0.001 for every rarity and `schedule`
   multiplier starts at 1.0 → zero behavioral change, framework is live.
4. Append a schedule milestone with per-rarity `base_min_burns` to establish
   the tiered spread (Rare 0.002 / Epic 0.004 / Legendary 0.008 / Mythic 0.016).
5. Adjust difficulty independently via later milestones' `multiplier` /
   `multipliers` — tiers survive a reset to 1.0 because the floor comes from
   `base_min_burns`, not the multiplier.

## Remaining / Future

- [ ] **Wire `countsProvider`** — feed per-window award counts to
      `getEffectiveMinBurns()` so the demand multiplier actually adjusts.
  - `leaderboard.js`: already scans burn history; could tally per-rarity counts as it resolves.
  - `resolve-card.js` (CLI): per-window aggregates from `fetchNullWinners` for diagnostics.
  - `search.js`: per-account — probably skip.
- [ ] **Tune `target_per_window`** — once demand mode is wired, these matter.
      Current defaults (per 7-day window): C: 60800, R: 27000, E: 9000, L: 3000, M: 1000.
      Sum = 100800 = 50% of 201600 blocks/window.
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
| `schedule[].base_min_burns.{r}` | Per-rarity tiered-floor override (append-only after activation) |
| `window_blocks` | Demand-adjustment epoch size, 201600 = ~7 days (immutable) |