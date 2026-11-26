# animalCards — Protocol Specification

**Status:** Draft / skeleton for discussion — **not yet a normative spec**
**Created:** 2026-11-25
**Home:** `docs/PROTOCOL.md`

This is the organizing home for the **protocol** — the deterministic rules that any
third-party front-end can implement to reproduce animalCards exactly. It is intentionally a
skeleton: sections marked **OPEN** are undecided, and each significant decision has an ADR
under `docs/decisions/`.

> The existing `docs/REARCHITECTURE.md` (draft, on the `rearchitecture-plan` branch) sketched
> the three-layer split. This document supersedes it as the *protocol* spec and links to the
> decisions made since (notably the 2026-11-25 award-rule change).

---

## 0. Layering

| Layer | Concern | Lives in (today) | Rule |
| --- | --- | --- | --- |
| **Protocol (engine)** | *How a card is assigned.* Pure, deterministic, game-agnostic. | `card-resolver.js`, `difficulty.js` | Inputs → outputs. No DOM, no network, no files. |
| **Game (definition)** | *What cards exist and their knobs.* | `cards-config.json`, `validate-cards.js`, tests | Data + validation; the canonical game definition. |
| **Presentation** | *How cards look and are played.* | `search.js`, `leaderboard.js`, `collections.js`, `*.html`, `style.css` | Any front-end may implement this against the protocol. |

The protocol is, in one sentence: **a pure function of chain history + config → (card, owner)**.

---

## 1. Distribution protocol *(implemented today; being formalized)*

### 1.1 Inputs
- `serialNumber` — `"<block>.<suffix>"`, where suffix `0` = STEEM and `1` = SBD (the asset).
- `seed` — a deterministic chain value: the winning transaction id (`trx_id`) or block hash.
- `config` — `{ cards, class_weights, slot_layouts, rarity_difficulty, … }`.
- *(award context)* — the burner's own burn amount and whether the burn was the block+asset's
  unique top burn.

### 1.2 Determinism & invariants
- Selection is `SHA-256("${serial}:${seed}")` reduced to integers for class → weighted slot →
  rarity → card (see `card-resolver.js` for the exact arithmetic).
- **Immutable once released** (from `README.md`): `card_id`, `class`, `rarity`, `slot`, and
  generation windows must never change or be deleted; `slot_layouts` and `rarity_difficulty`
  schedules are append-only with future block numbers.
- Any independent implementation MUST produce byte-identical results for a given
  `(serial, seed, config)`.

### 1.3 Award rule *(added 2026-11-25)*
Every burn (a `transfer` to `null`) earns a card:
- the block+asset's **unique top burner** receives the **full** card;
- **every other burn** — tied top burners *and* all lower burns — receives the **same
  resolution downgraded exactly one rarity tier** (the former tie rule; a Common downgrade
  yields the permanent generic);
- a non-winner is gated by **its own** burn amount against the rarity minimums **before** the
  one-tier downgrade.

> This rule is currently embedded in the page scripts. The protocol intends it to live in the
> engine so all clients behave identically. See `docs/decisions/0002-award-rule-in-engine.md`.

### 1.4 Versioning
- **OPEN.** A protocol version tag, with the rule that *past blocks resolve under the rules in
  force at their block*. Must be defined before external implementers build against this.

---

## 2. Card-instance identity — **OPEN**
> See `docs/decisions/0003-card-identity.md`.

What is the canonical, stable ID of a single card *instance*? Proposed: a deterministic
token id derived from `(serial, seed)` (optionally salted with a card-definition version).
This ID is the anchor for ownership, claims, and trades.

---

## 3. Ownership & claiming — **OPEN**
> See `docs/decisions/0004-ownership-and-claim.md`.

Ownership is already *derivable* from chain history (whoever burned). A **claim** is proposed
as a `custom_json` that turns implicit, derivable ownership into an explicit, registered,
transferable token. Open question: is a claim *required* before transfer, or is it UI sugar?

---

## 4. Trading / exchange — **OPEN**
> See `docs/decisions/0005-transfer-protocol.md`.

No buying or selling — only **exchange**. On Steem there is no atomic swap, so the proposed
model is **offer → accept**: one party posts an offer, the counterparty posts an accept that
references the offer's op id. The authoritative result is produced by reducing the op log.

---

## 5. On-chain data model — **OPEN**

### 5.1 `custom_json` envelope (proposed)
- `id`: short, namespaced, collision-aware (Steem limit ≈ 32 chars), e.g. `ac_claim`, `ac_trade`.
- `json`: versioned payload, e.g. `{"v":1, ...}`.
- `required_posting_auths`: the acting account (posting key — no monetary value moves here).

### 5.2 Log + derived index (proposed)
- **Per-card history = a hash-linked log** (each op references the previous op for that card —
  a linked list that gives provenance and tamper-evidence).
- **Current state = a derived index** produced by reducing the log (ordered by block, then
  trx id). Do **not** store the current collection on chain — compute it.

---

## 6. References
- `docs/decisions/0001-layer-split.md` … `0005-transfer-protocol.md`
- `README.md` — "CRITICAL — Determinism Warning"
- `card-resolver.js`, `difficulty.js` — the current engine
- `docs/REARCHITECTURE.md` — earlier 3-repo draft (on `rearchitecture-plan`)
