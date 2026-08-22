# RABD — Minimum-Burn Gating — Implementation Status

## Done

- [x] `difficulty.js` — shared (UMD) module for per-rarity minimum burns:
  - base minimums, tiered-floor schedule (`base_min_burns`), effective min calc
- [x] `card-resolver.js` — cascade resolution + `generic_reason` (`unreleased` | `below_minimum`)
- [x] `blockchain-api.js` — stores raw config, exposes `getEffectiveMinBurns()`, threads constraints
- [x] `leaderboard.js` / `search.js` — pass `winningBurnAmount`
- [x] `resolve-card.js` (CLI) — applies minimum burns; displays min/cascade/generic
- [x] `validate-cards.js` — validates `rarity_difficulty` (base min, schedule `base_min_burns`)
- [x] `cards-config.json` — `rarity_difficulty` block (disabled: `enabled_block: null`)
- [x] HTML — `difficulty.js` loaded before `blockchain-api.js` on all pages
- [x] `README.md` — minimum-burn gating section, config schema, rules-of-thumb
- [x] Language sanitized — no price/afford/cost framing (burn-threshold terms only)

## Immutability contract

Once `enabled_block` passes, everything in `rarity_difficulty` is locked (retroactive):
- ❌ change `rarities.*.base_min_burn_steem` or `base_min_burn_sbd`
- ❌ edit/remove/reorder a `schedule` entry whose `block` has passed
- ✅ APPEND new schedule milestones with future blocks (`base_min_burns`)
  — this is the ONLY safe tuning knob after activation

## Activation

1. Find current (or near-future) Steem block number.
2. Set `enabled_block` to that block in `cards-config.json`.
3. All `base_min_burn` values are already 0.001 → zero behavioral change, framework is live.
4. Optionally append a schedule milestone with per-rarity `base_min_burns` to raise
   the tiered spread (e.g. Rare 0.002 / Epic 0.004 / Legendary 0.008 / Mythic 0.016).

## Remaining / Future

- [ ] **Frontend `generic_reason`** — card tiles still show the old
      "species will be released in the future" copy. Render
      `unreleased` vs `below_minimum` differently in `leaderboard.js`/`search.js`.
- [ ] **Deploy to GitHub Pages** — merge to master when ready.

## Config knobs (all in `cards-config.json` → `rarity_difficulty`)

| Knob | What |
|------|------|
| `enabled_block` | Block where gating begins; `null` = off |
| `rarities.{r}.base_min_burn_steem` | Floor burn per rarity, STEEM (immutable after activation) |
| `rarities.{r}.base_min_burn_sbd` | Floor burn per rarity, SBD (immutable after activation) |
| `schedule[].base_min_burns.{r}` | Per-rarity tiered-floor override (append-only after activation) |