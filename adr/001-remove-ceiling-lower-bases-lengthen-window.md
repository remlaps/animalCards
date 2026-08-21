# ADR-001: Remove ceiling multiplier, lower burn floors, and lengthen difficulty window

**Status:** Accepted
**Date:** 2026-08-21

---

## Context

The `rarity_difficulty` (RABD) system controls the minimum burn amount a block
winner must post to receive a species card of each rarity. It combines:

- **Per-rarity `base_min_burn`** — the absolute floor (never-below threshold).
- **Schedule multipliers** — deterministic block milestones that scale the floor
  upward deliberately over time (append-only after activation).
- **Demand multipliers** — an opt-in feedback loop that compounds the floor
  window-over-window when actual award counts exceed the per-window target,
  self-correcting when mints stall (`actual = 0` collapses the multiplier to `1`).
- **`ceiling_multiplier`** — a hard cap on the *combined* output of schedule and
  demand: `effective = max(base, min(base × ceiling, base × sched × demand))`.

The initial config was a set of placeholder values:

| Knob | Placeholder | Intended for |
|---|---|---|
| `base_min_burn` | 0.001 / 0.1 / 1.0 / 10.0 / 100.0 | Wide economic separation (100,000× spread) |
| `ceiling_multiplier` | 100 | Bounded worst-case cost |
| `window_blocks` | 2016 | ~1.7h per window |
| `target_per_window` | 3028 / 757 / 189 / 47 / 12 | ~43,000 cards/day |

Three problems emerged during review:

1. **`ceiling_multiplier` blocks future growth.** The formula applies the same
   cap to *both* the schedule multiplier (the deliberate growth lever) and the
   demand multiplier (the automatic stabilizer). A future schedule milestone of
   `multiplier: 200` would be silently truncated to the ceiling value, making
   the hard cap an invisible ceiling on deliberate tuning.

2. **`base_min_burn` values were unrealistic.** At ~$0.08–$0.10/STEEM the
   Mythic floor of 100 STEEM (~$8–10) was a speculative guess, not grounded in
   actual burn behaviour. Lower floors reduce the financial barrier for common
   cards while keeping a geometric progression.

3. **A 1.7h window produces poor signal and violent oscillation.** With ~25–50
   blocks per window and target counts in the low dozens for higher rarities,
   the `actual/target` ratio is dominated by small-number statistics. A single
   mint in a window where `target = 12` produces `actual/target = 0.083`, and
   zero mints freeze the multiplier. The multiplier "whipsaws" between
   nearby-integer samplings, not trends.

---

## Decision

We make four coordinated changes:

### 1. Remove `ceiling_multiplier` entirely

The field is deleted from `cards-config.json`, the `normalize()` function in
`difficulty.js`, and the two runtime clamps (`demandMultiplier`'s
`Math.min(ceil, …)` and `minBurnFor`'s `Math.min(base × ceiling, …)`).

**Rationale:** The window length (see #3) now serves as the oscillation damper.
With a 7-day window there are far fewer compounding steps per real time, so the
demand multiplier climbs slowly enough that a hard cap is unnecessary for safety.
The zero-reset property (`actual = 0` → `mult = 1`) provides the ultimate bound:
any hype spike that pushes the minimum too high starves the next window, which
collapses the multiplier back to `1`. The cap was redundant and actively harmful.

### 2. Lower `base_min_burn` to a geometric 16× series

| Rarity | Old base | New base | Multiple of Common |
|---|---|---|---|
| Common  | 0.001    | 0.001    | 1× |
| Rare    | 0.1      | 0.002    | 2× |
| Epic    | 1.0      | 0.004    | 4× |
| Legendary | 10.0   | 0.008    | 8× |
| Mythic  | 100.0    | 0.016    | 16× |

### 3. Lengthen `window_blocks` to 201600 (~7 days)

Steem block time is 3 seconds: `201600 × 3 = 604,800 seconds = 7.0 days`.

**Rationale:** A 7-day window provides several benefits:

- **Statistical stability.** Each window aggregates enough mints that the
  `actual/target` ratio reflects genuine demand, not sampling noise.
- **Slower compounding.** The multiplier only updates once a week (vs ~86× per
  week at 1.7h), so exponential growth is tamed by clock time.
- **Human-scale rhythm.** Weekly windows align with natural social cycles; a
  hype event that lasts a few days cannot multiply the minimum more than once.

The window replaces `ceiling_multiplier` as the primary oscillation damper.

### 4. Rescale `target_per_window` to target 50% block-award coverage

Sum of targets = 100,800 per 7-day window, which is exactly 50% of 201,600
blocks.

| Rarity | Old target (1.7h) | New target (7-day) | % of window |
|---|---|---|---|
| Common    | 3,028 | 60,800 | 60.3% |
| Rare      | 757   | 27,000 | 26.8% |
| Epic      | 189   | 9,000  | 8.9% |
| Legendary | 47    | 3,000  | 3.0% |
| Mythic    | 12    | 1,000  | 1.0% |

**Rationale:** Setting total expected mints to 50% of blocks leaves room for
growth while ensuring the demand loop has a meaningful target to measure against.
The imbalance between target percentages and slot-band percentages (Mythic: 1.0%
target vs 3.2% of slots) is intentional: higher-rarity mints above their
slot-allocation push the multiplier up, making them harder to obtain — the demand
feedback driving the desired outcome.

---

## Alternatives considered

### A. Keep ceiling at a higher value (e.g. 1000× or 10,000×)
Rejected. Any fixed ceiling is an invisible wall on schedule multipliers. The
problem is structural, not a matter of choosing the right number.

### B. Cap demand only, free the schedule (two-tier ceiling)
Rejected. The 7-day window already dampens demand sufficiently; a demand-only
cap adds a second knob with no clear benefit. Simpler to remove the ceiling
entirely.

### C. Keep 1.7h window and add a per-window hard cap instead
Rejected. The real problem with short windows is that 0/1/2 mints produce wildly
swinging multipliers that do not reflect meaningful demand trends. A per-window
cap would mask this without curing it. Lengthening the window addresses the root
cause.

---

## Consequences

### Positive
- **Unbounded growth.** Schedule milestones can raise multipliers to any value
  — no hidden cap.
- **Realistic economics.** Common burns start at 0.001 STEEM; even aggressive
  demand pushes Mythic to ~16 STEEM, not 10,000.
- **Stable demand signal.** 7-day aggregates smooth out noise.
- **Cleaner config.** One fewer knob to explain and maintain.

### Negative / Risks
- **No hard upper bound.** In theory a multi-week hype wave could push the
  multiplier far beyond 100×. In practice the zero-reset prevents this: any
  window with zero mints collapses the multiplier to 1. The worst realistic case
  is a few consecutive oversupply windows, yielding at most thousands of times
  rather than millions.
- **Slow response.** The demand loop takes two full windows to react: "window W
  oversupplies" → "window W+1 uses W's counts to set multiplier" → "window W+2
  winners face the new minimum". For a game with weekly card releases this is
  acceptable; for high-frequency use it would feel sluggish.

---

## Files changed

| File | Changes |
|---|---|
| `cards-config.json` | Removed `ceiling_multiplier`; updated `window_blocks`, `base_min_burn`, `target_per_window`, and schedule target |
| `difficulty.js` | Removed ceiling from `normalize()` config shape, from `demandMultiplier()` clamp, from `minBurnFor()` cap, and from doc comments |
| `validate-cards.js` | Removed `ceiling_multiplier` validation; tightened `window_blocks` check to `> 0` |
| `README.md` | Removed ceiling from config example, formula, and immutability table; updated description text |
| `TODO-RABD.md` | Removed ceiling from immutability contract and config knobs table; updated window and target descriptions |
| `adr/001-remove-ceiling-lower-bases-lengthen-window.md` | This document |