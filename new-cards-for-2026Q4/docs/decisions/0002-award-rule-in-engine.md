# ADR 0002 — The award rule is protocol logic and must live in the engine

**Status:** Proposed
**Date:** 2026-11-25

## Context
Until 2026-11-25 only the block+asset's top burner received a card. The rule was implemented
in the page scripts (`search.js`, `collections.js`, `leaderboard.js`), each independently
computing "unique top burner" and passing `tie: true` to the resolver for downgrades.

The rule changed on 2026-11-25: **every burn earns a card**; only the unique top burner gets
the full card, everyone else is downgraded one rarity tier (gated by their own burn amount).

Because this is deterministic award logic, three independent copies will drift.

## Decision (proposed)
Treat "who receives which card" as **protocol**, and move the award determination into the
engine so every client computes identical awards from chain history. Page scripts should only
*render* what the engine returns.

## Consequences
- One implementation to test; external front-ends get correct awards for free.
- Requires a small input contract: per burn → `{ serial, seed, ownBurn, isUniqueTopBurner }`.
- The engine gains a "award from a list of burns" entry point (or the caller reduces burns to
  per-burn award inputs and calls the existing resolver).

## Open questions
- Does the engine resolve *all* burns, or does the caller pass minimal award context?
- How is the "unique top burner" determination itself specified and tested?
