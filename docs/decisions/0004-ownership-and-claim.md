# ADR 0004 — Ownership is derived from chain history; "claim" is explicit registration

**Status:** Proposed
**Date:** 2026-11-25

## Context
Ownership is already *implicitly* derivable: whoever made the winning burn "owns" the card.
Nothing is stored on chain about ownership today. Players may want to "save" their cards and,
eventually, trade them without buying/selling.

## Decision (proposed)
- **Derive** ownership permissionlessly from chain history (the burn + the award rule).
- Define a **claim** as a `custom_json` op (e.g. `id: "ac_claim"`) broadcast by an account that
  registers the `tokenId`(s) to that account, converting implicit ownership into an explicit,
  **transferable** token.

## Consequences
- Anyone can compute the baseline owner set with no cooperation (good for verifiability and
  for front-ends that don't want to depend on a registrar).
- Claims create the first *authoritative, transferable* state; trades operate on claimed tokens.
- Need anti-abuse rules: only the derived owner may claim; a token can be claimed once.

## Open questions
- **Is claiming required to trade**, or optional (trades allowed straight from derived ownership)?
- Can a claim be revoked/re-derived if the award rule changes? (Tie to protocol versioning, ADR 0001/0002.)
- Batch claims: one op per token, or one op listing many `tokenId`s?
- What happens to unclaimed cards — do they stay claimable forever, expire, or remain purely derivable?
