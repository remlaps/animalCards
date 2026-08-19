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

    // Highest → lowest rarity ranking used by the RABD cascade (see below).
    const CASCADE_ORDER = ['Mythic', 'Legendary', 'Epic', 'Rare', 'Common'];

    // Given the originally-resolved rarity + global slotPick + optional RABD
    // constraints, return the effective (rarity, slot) the winner actually
    // receives, or null when the burn clears no rarity's minimum at all.
    //   - no constraints / no difficulty / no finite burn → keep original rarity.
    //   - cascaded slot = slotPick % bandWidth — deterministic; equals the
    //     original slotInRarity for the original rarity, and a valid in-band slot
    //     for any lower rarity.
    function cascadeRarity(selectedRarity, slotPick, constraints) {
        const minBurns = (constraints && constraints.rarity_min_burn) || null;
        const burn = constraints && constraints.winning_burn_amount;

        const keep = (r) => ({
            rarity: r,
            slot: slotPick % RARITY_SLOT_COUNTS[r],
            cascaded: false,
            note: null
        });

        // No difficulty at all → resolution is exactly as it was before RABD.
        if (!minBurns) return keep(selectedRarity);
        // Unknown/absent burn amount → can't discriminate; be conservative and
        // keep the original rarity (same as having no difficulty applied).
        if (!Number.isFinite(burn)) return keep(selectedRarity);

        let from = CASCADE_ORDER.indexOf(selectedRarity);
        if (from === -1) from = CASCADE_ORDER.length - 1; // Generic/'none' → start at Common
        const startHigh = CASCADE_ORDER[from];

        // Fast path: the burn already clears the resolved rarity's minimum.
        if (burn >= (minBurns[startHigh] || 0)) return keep(startHigh);

        // Walk down the cascade until the burn clears a rarity's minimum.
        for (let i = from + 1; i < CASCADE_ORDER.length; i++) {
            const r = CASCADE_ORDER[i];
            if (burn >= (minBurns[r] || 0)) {
                return {
                    rarity: r,
                    slot: slotPick % RARITY_SLOT_COUNTS[r],
                    cascaded: true,
                    note: `Cascaded ${startHigh} → ${r} (burn ${burn} < ${startHigh} min ${minBurns[startHigh]})`
                };
            }
        }

        // Burn clears nothing — not even Common. Permanent generic below_minimum.
        return null;
    }

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
    // constraints (optional): { rarity_min_burn: {Common: n, ...}, winning_burn_amount: x }
    //   - rarity_min_burn  enables RABD (rarity-adjusted burn difficulty)
    //   - winning_burn_amount is the winning burn; when below the resolved
    //     rarity's minimum the winner cascades to the next lower rarity they can
    //     afford, or (if below every minimum) receives a permanent generic.
    // Returns { status, className, rarity, slot, slotPick, card, cascade, generic_reason }:
    //   status          'released' | 'generic' | 'none'
    //   className       the picked animal class
    //   rarity          the effective rarity issued (after any cascade)
    //   slot            the within-rarity slot index (0-based) — stable identity
    //   slotPick        the global slot index across all rarities (0-based)
    //   card            the resolved card object, or null for 'none'
    //   cascade         human-readable note if the rarity cascaded down (else null)
    //   generic_reason  for status 'generic'/'none': 'unreleased' (a species will
    //                   fill the slot later) or 'below_minimum' (burn cleared no
    //                   rarity threshold — no species card is on the horizon)
    async function resolveCardForBlock(serialNumber, blockHash, config, constraints) {
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

        // Step 2.5 — RABD cascade (optional). When a rarity minimum burn is
        // configured for the resolved rarity and the winning burn is below it,
        // drop to the next lower rarity whose threshold the burn clears. If the
        // burn clears no threshold at all, cascadeRarity returns null and the
        // winner receives a permanent generic (generic_reason 'below_minimum').
        const eff = cascadeRarity(selectedRarity, slotPick, constraints);
        const effRarity = eff ? eff.rarity : null;
        const effSlot = eff ? eff.slot : null;
        const genericReason = eff ? 'unreleased' : 'below_minimum';

        // No species released for this class at all yet.
        if (classCards.length === 0) {
            return { status: 'none', className, rarity: effRarity, slot: effSlot, slotPick, card: null, generic_reason: genericReason, cascade: eff ? eff.note : null };
        }

        // Step 3 — Resolve the card for the effective slot at the winning block.
        const blockNum = parseInt(String(serialNumber), 10);

        const active = classCards.find(c =>
            !c.is_generic &&
            c.rarity === effRarity &&
            c.slot === effSlot &&
            (c.start_block == null || blockNum >= c.start_block) &&
            (c.end_block == null || blockNum <= c.end_block)
        );

        if (active) {
            return { status: 'released', className, rarity: effRarity, slot: effSlot, slotPick, card: active, cascade: eff ? eff.note : null };
        }

        // No released card active at this block for the effective slot; generic wins.
        if (generic) {
            return {
                status: 'generic',
                className,
                rarity: effRarity,
                slot: effSlot,
                slotPick,
                card: generic,
                generic_reason: genericReason,
                cascade: eff ? eff.note : null,
                note: eff ? eff.note : 'Burn below all rarity minimums'
            };
        }
        return { status: 'none', className, rarity: effRarity, slot: effSlot, slotPick, card: null, generic_reason: genericReason, cascade: eff ? eff.note : null };
    }

    return { hashForSerial, resolveCardForBlock, RARITY_SLOT_COUNTS, RARITY_WEIGHT };
}));

