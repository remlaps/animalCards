# ADR 0005 — Exchange via offer → accept (no buying or selling)

**Status:** Proposed
**Date:** 2026-11-25

## Context
The goal is to let players **exchange** cards (trading), explicitly **without** buying/selling.
Steem has no atomic swap primitive; each `custom_json` is a single signed op.

## Decision (proposed)
Model trades as **offer → accept**:
1. Party A posts an **offer** (`id: "ac_trade"`, payload `{v:1, type:"offer", give:[tokenIds], want:{...}}`).
2. Party B posts an **accept** that references A's offer (op id / trx id) and supplies the
   matching card(s) (`type:"accept", ref:<offerId>, give:[tokenIds]`).
3. The authoritative outcome is produced by **reducing the op log** (ordered by block, then
   trx id); the protocol defines which offers are still open, which are cancelled, and when a
   swap is final.

## Consequences
- No value transfer — only swaps; "no buying/selling" is enforced by the op schema (no amounts).
- Because there is no atomicity, the **reducer's ordering rules are the source of truth**;
  clients must be able to replay deterministically.
- Needs dedupe/replay protection and a way to prevent the same token being offered twice.

## Open questions
- Accept semantics: fixed counterparties vs. open offers anyone can fill? Partial/counter offers?
- What are valid trades — 1-for-1 only, or N-for-M / any-count (e.g. many Commons for a Mythic)?
- Cancellation and expiry rules.
- Where is the reducer run — a reference indexer, a public API, or each client locally?
- Do trades require the tokens to have been claimed first (see ADR 0004)?
