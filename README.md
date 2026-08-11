# Animal Cards — BurnMax Card Distribution

A blockchain-based leaderboard and portfolio search for wildlife cards earned through
BurnMaxxing. Winners are derived deterministically from block hashes and their
rewards are resolved to a card defined in `cards-config.json`.

## Project Files

| File | Purpose |
|------|---------|
| `index.html` | Landing page |
| `search.html` / `search.js` | Look up an account's earned cards |
| `leaderboard.html` / `leaderboard.js` | Top burners and the cards they won |
| `blockchain-api.js` | STEEM API wrapper + the deterministic card-resolution algorithm |
| `cards-config.json` | **The card catalogue — the only file you edit to add/change cards** |
| `style.css` | Shared styling |

## How Cards Are Distributed (the short version)

For every winning block+asset a `serial` (e.g. `1234.0` for STEEM, `1234.1` for SBD)
is hashed with the block hash to produce a deterministic integer. The algorithm then:

1. **Picks a class** from `class_weights` (must sum to 100).
2. **Picks a rarity slot from a fixed pool** shared by every class. The slot counts
   are hard-coded and never change:
   | Rarity | Slots |
   |--------|-------|
   | Common | 16 |
   | Rare | 8 |
   | Epic | 4 |
   | Legendary | 2 |
   | Mythic | 1 |
   | **Total** | **31** |

   Each slot is then **weighted by its rarity's multiplier** (`Common` 16,
   `Rare` 8, `Epic` 4, `Legendary` 2, `Mythic` 1). A Common slot is chosen 16×
   as often as a Mythic slot and 2× as often as a Rare slot. Total weight =
   16·16 + 8·8 + 4·4 + 2·2 + 1·1 = **341**. This is the **second dimension of
   scarcity**: more species exist at lower rarities (the slot counts), *and*
   lower-rarity slots are more likely to be chosen (the weighting).

3. **Picks a card** within that rarity by sorting the class's released cards of that
   rarity by `card_id` and using the slot index. If the slot index is beyond the
   number of released cards, the class generic card wins. An empty slot still keeps
   its rarity's weight, so unreleased species keep feeding the generic card until
   you add them.

Rarity is shown on the site as derived from the slot position.

---

## Maintaining `cards-config.json`

### Config structure

```jsonc
{
  "class_weights": {
    "Bird": 34,
    "Mammal": 34,
    "Fish": 16,
    "Reptile & Amphibian": 16
    // MUST sum to 100
  },
  "beneficiaries": {
    // Suggested photographer beneficiary % by rarity (used for the tooltip on photo credits)
    "Common": 1,
    "Rare": 2,
    "Epic": 4,
    "Legendary": 8,
    "Mythic": 16
  },
  "cards": [
    {
      "card_id": 7,          // unique, sequential, NEVER REUSE or CHANGE
      "species": "Turkey Vulture",
      "class": "Bird",
      "rarity": "Common",    // Common | Rare | Epic | Legendary | Mythic | Generic
      "image_url": "https://...png",
      "is_generic": true,    // only for the per-class generic placeholder cards
      "generation": "unstable-test",
      "photo_credit": "remlaps"
    }
  ]
}
```

The optional `beneficiaries` object maps each rarity to a suggested photographer
beneficiary percentage. It is used to build the tooltip shown on card photo credits
(saying e.g. "1% for common species, …"). To change the suggested percentages, edit
this one map — no code changes needed.

### Card fields

| Field | Required | Notes |
|-------|----------|-------|
| `card_id` | ✅ | Unique integer. **See the determinism warning below.** |
| `species` | ✅ | Display name. |
| `class` | ✅ | Must match one of the keys in `class_weights`. |
| `rarity` | ✅ | One of `Common`, `Rare`, `Epic`, `Legendary`, `Mythic`, or `Generic`. |
| `image_url` | ✅ | Card image. |
| `generation` | ✅ | Release batch label. |
| `photo_credit` | ✅ | Photographer credit. |
| `is_generic` | only on generic cards | `true` for the per-class placeholder card. |

### How the slot-to-card mapping works

Within a class, cards of a given rarity are sorted by `card_id` and assigned to that
rarity's slots **in order**. Example for the **Common** rarity (16 slots) with
Bird cards `card_id` 7, 8, 11:

| Common slot | Card |
|-------------|------|
| 0 | card_id 7 |
| 1 | card_id 8 |
| 2 | card_id 11 |
| 3–15 | *(empty → generic card)* |

Every slot — filled or empty — carries the same per-slot weight **within its
rarity** (e.g. all 16 Common slots are weight 16). Adding a new Common species
that fills a currently-empty Common slot does **not** change any other slot's
weight or mapping, so past winners are undisturbed.

### Adding a card

**Always give the new card the next unused `card_id`** (the current maximum + 1).
This appends it to the tail of its rarity's slot list, which only *fills a previously
empty slot*. Every existing block resolution is left unchanged.

Example: add a new Common Bird →
`card_id: 14`. It takes Common slot 4 (previously generic). Slots 0–3 are untouched.

### Removing a card

Remove the card's entire object. Cards with a higher `card_id` in the same rarity
will shift down one slot, which **changes** the resolution for the blocks that hit
those slots. This is expected and unavoidable — be deliberate.

### Editing a card's display fields

You may freely change `species`, `class` (to another class), `image_url`, `generation`,
`photo_credit` — these do **not** affect determinism as long as `card_id` is preserved.

### Generic cards

Each class should have exactly **one** generic placeholder card
(`is_generic: true`, `rarity: "Generic"`). It is returned whenever a rarity slot is
empty (no released card of that rarity yet). The rarity shown for it on the site is
the slot's rarity.

---

## ⚠️ CRITICAL — Determinism Warning

**Do NOT change, renumber, or reuse `card_id` values.**

The mapping from a slot to a specific card is based on sorting cards by `card_id`.
If you change an existing card's `card_id`, every card after it in the sort order
can shift to a different slot, which **changes the card awarded for past blocks**.
This breaks the guarantee that past winners never change.

In particular, **never** do any of these:

- ❌ Renumber a card (e.g. change `card_id` 7 → 1000).
- ❌ Reuse a deleted card's `card_id` for a new card.
- ❌ Insert a new card with a `card_id` lower than the current maximum.
- ❌ Change a card's `card_id` to reorder it within its rarity.

**The only safe way to add a card is to append it with the next unused `card_id`.**
If you need to reorder which card wins which slot, add the new card with a fresh
`card_id` and remove the old one, and accept that removals shift resolutions.

---

## Rules of thumb

- `class_weights` must always sum to **100**.
- Give every new card a **fresh, monotonically increasing `card_id`**.
- Keep exactly **one generic placeholder per class**.
- Rarity values are case-sensitive: `Common`, `Rare`, `Epic`, `Legendary`, `Mythic`, `Generic`.
- Up to 31 released cards per class (16 Common + 8 Rare + 4 Epic + 2 Legendary + 1 Mythic).
  More than 16 Common cards, for example, will push later Common cards beyond the
  Common slot range and they will never be awarded.