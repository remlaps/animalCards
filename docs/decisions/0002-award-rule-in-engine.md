# ADR 0002 — The award rule is protocol logic and lives in the engine

**Status:** Accepted — implemented 2026-11-25, moved into the engine 2026-11-26
**Date:** 2026-11-25 · last revised 2026-11-26

## Context
Until 2026-11-25 only the block+asset's top burner received a card, and the rule was
implemented separately in each page script (`search.js`, `collections.js`, `leaderboard.js`),
each computing "unique top burner" and passing a `tie` flag to the resolver. On 2026-11-25 the
rule changed to "every burn earns a card; only the unique top burner gets the full card".

The CLI (`resolve-card.js`) was not updated, so the site and the CLI produced **different
awards** for the same block — exactly the drift this ADR exists to prevent.

## Decision
Treat "who receives which card" as **protocol**. `card-resolver.js` now exposes two pure
functions:

- `findBurnWinners(burns)` → `{ "<block>|<asset>": { max, winnerTrxIds[] } }`.
- `deriveBurnAwards(burns, { mode, assetSuffix }, winners?)` → awards
  `[{ account, block, asset, amount, trxId, serial, isWin, downgrade }]`.

The policy is a **game-level knob** in `cards-config.json`:

```jsonc
"award_mode": "all_burns"   // or "winners_only"
```

- `all_burns`    — every burn earns a card; the unique top burner gets the **full** card,
                   everyone else is **downgraded** one rarity tier.
- `winners_only` — only the top burner(s) earn a card; an exact top tie downgrades them.

The resolver's constraint flag was renamed **`tie` → `downgrade`** (it is a downgrade, not
necessarily a literal tie). All three pages and `resolve-card.js` now call `deriveBurnAwards`,
so they cannot drift.

## Consequences
- One implementation of "who earns what"; external front-ends reuse it for free.
- `resolveCardForBlock(serial, seed, config, { rarity_min_burn, winning_burn_amount, downgrade })`
  remains the pure per-card resolution primitive; `deriveBurnAwards` decides *who* is resolved.
- The award policy is configurable per game via `award_mode`.
- The CLI now lists downgraded non-winner awards too, matching the site.

## Open questions
- Per-block `award_mode` overrides (change policy at a block height)? Not needed yet.
- Should `deriveBurnAwards` own RABD constraint assembly, or keep that in the caller? Today the
  caller assembles `rarity_min_burn` from `difficulty.js`.

