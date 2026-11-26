# ADR 0003 — Canonical card-instance identity

**Status:** Proposed
**Date:** 2026-11-25

## Context
To claim, track, and trade individual cards, we need a **stable, unique ID for a card
instance** (not the species/card definition). Today a card instance is identified implicitly by
`(serialNumber, trx_id)` — the same inputs that deterministically resolve to a card.

## Decision (proposed)
Define an instance id derived deterministically from the resolution inputs, e.g.:

    tokenId = SHA-256(`${serialNumber}:${seed}`)      // optionally salt with a card-def version

Properties:
- Stable and verifiable by anyone from chain history alone.
- Distinct per burn (each `trx_id` differs), so duplicates of the same species are distinct.
- Independent of the *card definition*, so a later generation rename does not change the id.

Note the link to rarity: a non-winner's token is the same `tokenId` but resolves to a
downgraded card (ADR 0002). Decide whether the downgrade is part of the token's identity or a
presentation attribute.

## Consequences
- Ownership, claims, and trades all reference `tokenId`.
- Two system-of-record layers: the derived card (from the engine) and the registered owner
  (from claims/trades) — keyed by `tokenId`.

## Open questions
- Hash of `(serial, seed)`, or a shorter/encoded id? Human-readable vs. opaque?
- Include the burn amount / award context in the identity, or keep identity purely positional?
- How are "generic" (below-minimum / unreleased) awards represented as tokens, if at all?
