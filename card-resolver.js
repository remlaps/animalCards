/**
 * card-resolver.js
 *
 * Single source of truth for the deterministic BurnMax card-resolution
 * algorithm. Originally embedded in `blockchain-api.js`; extracted here so the
 * browser code and the `resolve-card.js` CLI share one implementation (nothing
 * to keep in sync / no drift).
 *
 * This is a UMD module: it loads as a plain <script> in the browser (attaching
 * the global `CardResolver`) and via `require('./card-resolver')` in Node.
 *
 * Only the SHA-256 primitive differs between environments:
 *   - browser:  crypto.subtle.digest('SHA-256', ...)
 *   - Node:     require('crypto').createHash('sha256').update(...)
 * Both digest the UTF-8 bytes of `${serial}:${blockHash}` and produce identical
 * digests, so results match exactly.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node / CommonJS
        module.exports = factory(require('crypto'));
    } else {
        // Browser — expose a global
        root.CardResolver = factory(null);
    }
}(typeof self !== 'undefined' ? self : this, function (nodeCrypto) {

    // Fixed slot counts and per-slot weights — must never change after release.
    const RARITY_SLOT_COUNTS = { Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 };
    const RARITY_WEIGHT = { Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 };

    // Compute the deterministic SHA-256 hash integer for a serial + block hash.
    async function hashForSerial(serialNumber, blockHash) {
        const data = `${serialNumber}:${blockHash}`;
        const digest = nodeCrypto
            ? Buffer.from(nodeCrypto.createHash('sha256').update(data).digest())
            : new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)));
        const hex = Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('');
        return BigInt('0x' + hex);
    }

    // Resolve the card a BurnMax winner receives, deterministically.
    // config: { cards: [...], class_weights: { className: weight, ... } }
    // Returns { status, className, rarity, slot, slotPick, card }:
    //   status     'released' | 'generic' | 'none'
    //   className  the picked animal class
    //   rarity     the picked slot's rarity
    //   slot       the within-rarity slot index (0-based) — the stable identity
    //   slotPick   the global slot index across all rarities (0-based)
    //   card       the resolved card object, or null for 'none'
    async function resolveCardForBlock(serialNumber, blockHash, config) {
        config = config || {};
        const cards = config.cards || [];
        const classWeightsObj = config.class_weights || {};
        const classOrder = Object.keys(classWeightsObj);
        const hashInt = await hashForSerial(serialNumber, blockHash);

        // Step 1 — Class allocation over 0..99 (weights must sum to 100).
        const offset = Number(hashInt % 100n);
        let className = null;
        let classStart = 0;
        for (let i = 0; i < classOrder.length; i++) {
            const weight = classWeightsObj[classOrder[i]];
            if (offset < classStart + weight) {
                className = classOrder[i];
                break;
            }
            classStart += weight;
        }
        if (!className) {
            // Safety fallback (weights don't sum to 100): last class.
            className = classOrder[classOrder.length - 1];
            classStart = 100 - (classWeightsObj[classOrder[classOrder.length - 1]] || 0);
        }

        const classCards = cards.filter(c => c.class === className);
        const generic = classCards.find(c => c.is_generic);

        // Step 2 — Fixed slot-based rarity selection per class, weighted.
        // Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 (slot counts).
        // Each slot is then weighted by its rarity multiplier (16/8/4/2/1).
        // Total weight = 16*16 + 8*8 + 4*4 + 2*2 + 1*1 = 341.
        const rarityOrder = Object.keys(RARITY_SLOT_COUNTS);
        const rarityRanges = {};
        const slotWeights = []; // one entry (the rarity multiplier) per slot
        let totalSlots = 0;
        let totalWeight = 0;
        for (const r of rarityOrder) {
            const count = RARITY_SLOT_COUNTS[r];
            rarityRanges[r] = { start: totalSlots, end: totalSlots + count };
            for (let i = 0; i < count; i++) {
                slotWeights.push(RARITY_WEIGHT[r]);
            }
            totalSlots += count;
            totalWeight += count * RARITY_WEIGHT[r];
        }
        // Weighted pick over the 31 slots.
        const pickWeight = Number(hashInt % BigInt(totalWeight));
        let slotPick = null;
        let acc = 0;
        for (let i = 0; i < slotWeights.length; i++) {
            acc += slotWeights[i];
            if (pickWeight < acc) {
                slotPick = i;
                break;
            }
        }
        // Safety fallback (only reachable if totalWeight mismatches the loop).
        if (slotPick === null) slotPick = totalSlots - 1;

        const selectedRarity = rarityOrder.find(
            r => slotPick >= rarityRanges[r].start && slotPick < rarityRanges[r].end
        );
        const slotInRarity = slotPick - rarityRanges[selectedRarity].start;

        // No species released for this class at all yet.
        if (classCards.length === 0) {
            return { status: 'none', className, rarity: selectedRarity, slot: slotInRarity, slotPick, card: null };
        }

        // Step 3 — Resolve the card for the slot at the winning block.
        const blockNum = parseInt(String(serialNumber), 10);

        const active = classCards.find(c =>
            !c.is_generic &&
            c.rarity === selectedRarity &&
            c.slot === slotInRarity &&
            (c.start_block == null || blockNum >= c.start_block) &&
            (c.end_block == null || blockNum <= c.end_block)
        );

        if (active) {
            return { status: 'released', className, rarity: selectedRarity, slot: slotInRarity, slotPick, card: active };
        }

        // No released card active at this block for the slot; generic wins.
        if (generic) {
            return { status: 'generic', className, rarity: selectedRarity, slot: slotInRarity, slotPick, card: generic };
        }
        return { status: 'none', className, rarity: selectedRarity, slot: slotInRarity, slotPick, card: null };
    }

    return { hashForSerial, resolveCardForBlock, RARITY_SLOT_COUNTS, RARITY_WEIGHT };
}));

