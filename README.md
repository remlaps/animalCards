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
| `validate-cards.js` | Config sanity checker — run `node validate-cards.js` before changing cards |
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

3. **Picks the card** that fills the chosen slot at the winning block. Each card
   declares the rarity slot it occupies (`slot`) and the block window during which it
   is awarded (`start_block`/`end_block`, both inclusive; omit for "always active").
   If no card is active for that slot at the winning block, the class's generic card
   wins. An empty slot keeps its rarity's weight, so unfilled generations keep feeding
   the generic card until a card is added.

Because `slot` is the **stable identity** (not `card_id`), a species can be "replaced"
by a new generation that reuses the same `slot` for a later block window — the old card
is **never deleted**, so owners who won it keep it forever.

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
      "card_id": 7,          // unique, never changed after release
      "species": "Turkey Vulture",
      "class": "Bird",
      "rarity": "Common",    // Common | Rare | Epic | Legendary | Mythic | Generic
      "slot": 0,             // 0-based index within this rarity's slot band (0..15 Common)
      "start_block": null,   // inclusive; null = active from the beginning
      "end_block": null,     // inclusive; null = active forever
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
| `card_id` | ✅ | Unique integer. Never change or reuse it after a card is released. |
| `species` | ✅ | Display name. |
| `class` | ✅ | Must match one of the keys in `class_weights`. |
| `rarity` | ✅ | One of `Common`, `Rare`, `Epic`, `Legendary`, `Mythic`, or `Generic`. |
| `slot` | ✅ (non-generic) | 0-based index within the rarity's slot band (Common 0–15, Rare 0–7, Epic 0–3, Legendary 0–1, Mythic 0). The **stable identity** a card occupies. |
| `start_block` | ⬜ | First awardable block (inclusive). Omit/null = active from the beginning. |
| `end_block` | ⬜ | Last awardable block (inclusive). Omit/null = active forever. |
| `image_url` | ✅ | Card image. |
| `generation` | ✅ | Release batch label (e.g. `gen-1`, `gen-2`). |
| `photo_credit` | ✅ | Photographer credit. |
| `is_generic` | only on generic cards | `true` for the per-class placeholder card. |

### How the slot-to-card mapping works

A card's **`slot`** is its stable identity — the 0-based position within its rarity's
fixed slot band (Common 0–15, Rare 0–7, Epic 0–3, Legendary 0–1, Mythic 0). At a given
block, the slot resolves to the card whose `[start_block, end_block]` window contains
that block. Current Bird **Common** cards:

| Common slot | Card | Window |
|-------------|------|--------|
| 0 | Turkey Vulture | forever |
| 1 | American Robin | forever |
| 2 | Red-tailed Hawk | forever |
| 3 | Gray Catbird | forever |
| 4 | Northern Cardinal | forever |
| 5 | Blue Jay | forever |
| 6 | White-breasted Nuthatch | forever |
| 7–15 | *(empty → generic card)* | — |

Every slot — filled or empty — carries the same per-slot weight **within its rarity**
(e.g. all 16 Common slots are weight 16). Changing one card's window never touches
other slots, so unrelated past winners are undisturbed.

### Adding a new species (fills an empty slot)

Give it the next unused `card_id` and a `slot` that is currently empty in its rarity.
It only *fills a previously empty slot*, leaving every existing card's `slot` and
window untouched.

### Replacing a species (new generation, same slot)

**Never delete the old card.** Add a successor with the **same `rarity` + `slot`**, a
new `card_id`, and a **contiguous** window that starts right after the old one ends:

```jsonc
{ "card_id": 8,  "species": "American Robin", "slot": 1, "start_block": null, "end_block": 26672700 },
{ "card_id": 20, "species": "Say's Phoebe",   "slot": 1, "start_block": 26672701 }
```

Blocks ≤ 26,672,700 → Robin (owners keep it forever); blocks ≥ 26,672,701 → Say's
Phoebe. Run `node validate-cards.js` to catch overlapping or gapped windows for a slot.

### Editing a card's display fields

You may freely change `species`, `image_url`, `generation`, `photo_credit` — these do
**not** affect determinism. Do **not** change a released card's `card_id`, `class`,
`rarity`, or `slot` (that remaps what past winning blocks resolve to), and do **not**
narrow an existing window.

### Generic cards

Each class should have exactly **one** generic placeholder card
(`is_generic: true`, `rarity: "Generic"`). It is returned whenever a selected slot has
no card active at the winning block. The rarity shown for it on the site is the slot's
rarity.

---

## ⚠️ CRITICAL — Determinism Warning

The deterministic mapping is driven by each card's **`slot` + block window**, not by
`card_id` ordering. The following change the card awarded for a past block and are
**permanently forbidden** once a card is released:

- ❌ Change a released card's `card_id`, `class`, `rarity`, or `slot`.
- ❌ Reuse a released card's `card_id` for a different card.
- ❌ Delete a card entirely — it removes what past winners hold.
- ❌ Narrow a card's window so a block it already resolved to moves to another card.

**Safe ways to evolve the catalogue:**

- Add a new species into a currently-empty `slot` of its rarity, with the next unused
  `card_id`.
- Replace a species with a new generation: keep the old card intact, add a successor
  with the same `rarity` + `slot` and a contiguous window that starts after the old
  one's `end_block`. Run `node validate-cards.js` to confirm the windows are clean.

---

## Validating the config

Run `node validate-cards.js` from the repo root after *any* change to
`cards-config.json`. It checks that `class_weights` sum to 100, `card_id`s are unique,
rarities are valid, `slot`s are inside their rarity band, and no two cards share a
`class + rarity + slot` with overlapping or non-contiguous generation windows. It exits
non-zero on structural errors, making it easy to drop into CI.

## Rules of thumb

- `class_weights` must always sum to **100**.
- Give every new card a **fresh, monotonically increasing `card_id`**.
- Keep exactly **one generic placeholder per class**.
- Each non-generic card needs a `slot` inside its rarity's band and an unambiguous
  block window.
- **Never delete a card** and never remap a released card's `class`/`rarity`/`slot`/
  `card_id`.
- **Run `node validate-cards.js` after every change** to `cards-config.json`.
- Rarity values are case-sensitive: `Common`, `Rare`, `Epic`, `Legendary`, `Mythic`, `Generic`.
- A rarity can never exceed its fixed slot band (16 Common, 8 Rare, 4 Epic, 2 Legendary,
  1 Mythic) **per generation**. Later generations may re-fill the same slots.