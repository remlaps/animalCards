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

    // Default slot counts and per-slot weights
    const DEFAULT_RARITY_SLOT_COUNTS = { Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 };
    const RARITY_WEIGHT = { Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 };
    const VALID_RARITIES = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];

    // Highest → lowest rarity ranking used by the RABD cascade (see below).
    const CASCADE_ORDER = ['Mythic', 'Legendary', 'Epic', 'Rare', 'Common'];

    // ---------------------------------------------------------------------------
    // Slot layout selection — picks the active rarity-slot counts for a given block.
    // slotLayouts is an array of { block, Common, Rare, Epic, Legendary, Mythic }
    // sorted by block ascending.  The entry with the highest block ≤ blockNum wins.
    // When slotLayouts is absent/empty, DEFAULT_RARITY_SLOT_COUNTS is used.
    // ---------------------------------------------------------------------------
    function getSlotLayoutForBlock(slotLayouts, blockNum) {
        if (!Array.isArray(slotLayouts) || slotLayouts.length === 0) {
            return DEFAULT_RARITY_SLOT_COUNTS;
        }
        // Must be sorted ascending by block
        var best = null;
        for (var i = 0; i < slotLayouts.length; i++) {
            var entry = slotLayouts[i];
            if (entry.block != null && entry.block <= blockNum) {
                best = entry;
            } else {
                break; // entries are sorted, so no later entry will match either
            }
        }
        if (!best) return DEFAULT_RARITY_SLOT_COUNTS;
        // Build a RARITY_SLOT_COUNTS-shaped object from the entry
        var out = {};
        for (var r = 0; r < VALID_RARITIES.length; r++) {
            var rarity = VALID_RARITIES[r];
            if (typeof best[rarity] === 'number' && best[rarity] >= 1) {
                out[rarity] = best[rarity];
            } else {
                out[rarity] = DEFAULT_RARITY_SLOT_COUNTS[rarity];
            }
        }
        return out;
    }

    // Given the originally-resolved rarity + global slotPick + optional RABD
    // constraints, return the effective (rarity, slot) a burner actually receives,
    // or null when the burn clears no rarity's minimum at all.
    //   - no constraints / no difficulty / no finite burn → keep original rarity.
    //   - constraints.downgrade = true → drop one rarity tier (e.g. Rare → Common)
    //     after the normal cascade, for non-winning awards.
    //   - cascaded slot = slotPick % bandWidth — deterministic; equals the
    //     original slotInRarity for the original rarity, and a valid in-band slot
    //     for any lower rarity.
    function cascadeRarity(selectedRarity, slotPick, constraints, slotCounts) {
        slotCounts = slotCounts || DEFAULT_RARITY_SLOT_COUNTS;
        const minBurns = (constraints && constraints.rarity_min_burn) || null;
        const burn = constraints && constraints.winning_burn_amount;
        const downgrade = constraints && constraints.downgrade;

        const keep = (r) => ({
            rarity: r,
            slot: slotPick % slotCounts[r],
            cascaded: false,
            note: null
        });

        // Drop one rarity tier (used for non-winning awards). Returns null when
        // already at Common or the input is null.
        const downgradeOne = (result) => {
            if (!result) return null;
            const idx = CASCADE_ORDER.indexOf(result.rarity);
            if (idx === -1 || idx + 1 >= CASCADE_ORDER.length) return null;
            const down = CASCADE_ORDER[idx + 1];
            return {
                rarity: down,
                slot: slotPick % slotCounts[down],
                cascaded: true,
                note: `Downgraded: ${result.rarity} → ${down}`
            };
        };

        // No difficulty at all → resolution is exactly as it was before RABD.
        if (!minBurns) return downgrade ? downgradeOne(keep(selectedRarity)) : keep(selectedRarity);
        // Unknown/absent burn amount → can't discriminate; be conservative and
        // keep the original rarity (same as having no difficulty applied).
        if (!Number.isFinite(burn)) return downgrade ? downgradeOne(keep(selectedRarity)) : keep(selectedRarity);

        let from = CASCADE_ORDER.indexOf(selectedRarity);
        if (from === -1) from = CASCADE_ORDER.length - 1; // Generic/'none' → start at Common
        const startHigh = CASCADE_ORDER[from];

        // Fast path: the burn already clears the resolved rarity's minimum.
        if (burn >= (minBurns[startHigh] || 0)) {
            const result = keep(startHigh);
            return downgrade ? downgradeOne(result) : result;
        }

        // Walk down the cascade until the burn clears a rarity's minimum.
        for (let i = from + 1; i < CASCADE_ORDER.length; i++) {
            const r = CASCADE_ORDER[i];
            if (burn >= (minBurns[r] || 0)) {
                const result = {
                    rarity: r,
                    slot: slotPick % slotCounts[r],
                    cascaded: true,
                    note: `Cascaded ${startHigh} → ${r} (burn ${burn} < ${startHigh} min ${minBurns[startHigh]})`
                };
                return downgrade ? downgradeOne(result) : result;
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
    // constraints (optional): { rarity_min_burn: {Common: n, ...}, winning_burn_amount: x, downgrade: bool }
    //   - rarity_min_burn  enables RABD (rarity-adjusted burn difficulty)
    //   - winning_burn_amount is the burn to gate on; when below the resolved
    //     rarity's minimum the award cascades to the next lower rarity the burn
    //     qualifies for, or (if below every minimum) becomes a permanent generic.
    //   - downgrade: true  drops one rarity tier after the cascade (non-winning awards).
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

        // Step 0 — Select the active slot layout for this block (block 0 layout
        // covers all past blocks; later layouts apply only to blocks ≥ their block).
        const blockNum = parseInt(String(serialNumber), 10);
        const slotCounts = getSlotLayoutForBlock(config.slot_layouts, blockNum);

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
        // Slot counts come from the block's active slot_layouts entry (slotCounts,
        // chosen in Step 0) — e.g. 8/3/2/2/1 at block 0, 12/5/4/4/3 for 2026Q4.
        // Each slot is then weighted by its rarity multiplier
        // (Common 16, Rare 8, Epic 4, Legendary 2, Mythic 1), so
        // totalWeight = Σ (slotCounts[r] * RARITY_WEIGHT[r]) — 165 for the block-0
        // layout, 259 for the 2026Q4 layout. Both totals are derived from config;
        // nothing below is hard-coded to a particular generation.
        const rarityOrder = Object.keys(slotCounts);
        const rarityRanges = {};
        const slotWeights = []; // one entry (the rarity multiplier) per slot
        let totalSlots = 0;
        let totalWeight = 0;
        for (let ri = 0; ri < rarityOrder.length; ri++) {
            const r = rarityOrder[ri];
            const count = slotCounts[r];
            rarityRanges[r] = { start: totalSlots, end: totalSlots + count };
            for (let i = 0; i < count; i++) {
                slotWeights.push(RARITY_WEIGHT[r]);
            }
            totalSlots += count;
            totalWeight += count * RARITY_WEIGHT[r];
        }
        // Weighted pick over every slot in the active layout (slotWeights.length).
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
        const eff = cascadeRarity(selectedRarity, slotPick, constraints, slotCounts);
        const effRarity = eff ? eff.rarity : null;
        const effSlot = eff ? eff.slot : null;
        const genericReason = eff ? 'unreleased' : 'below_minimum';

        // No species released for this class at all yet.
        if (classCards.length === 0) {
            return { status: 'none', className, rarity: effRarity, slot: effSlot, slotPick, card: null, generic_reason: genericReason, cascade: eff ? eff.note : null };
        }

        // Step 3 — Resolve the card for the effective slot at the winning block.

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

    // ---------------------------------------------------------------------------
    // Award derivation — the game's award *policy*, kept in the engine so every
    // front-end (and the CLI) computes identical awards from the same burn history.
    //
    //   burns: [{ account, block, asset, amount, trxId }] — every burn to `null` in
    //     scope (asset is an opaque string key, e.g. "STEEM"/"SBD").
    //   opts.mode: 'all_burns' (default) | 'winners_only'
    //     - 'all_burns'    : every burn earns a card; only the block+asset's *unique*
    //                        top burner gets the full card, everyone else is downgraded.
    //     - 'winners_only' : only the top burner(s) earn a card; a tie downgrades them.
    //   opts.assetSuffix: map asset -> serial suffix (default { STEEM: '0', SBD: '1' }).
    //
    // A "winner" is the unique largest burn for its block+asset; an exact top tie
    // makes every tied burner a (downgraded) winner.
    function findBurnWinners(burns) {
        const winners = {};
        for (const b of burns) {
            const key = `${b.block}|${b.asset}`;
            const w = winners[key] || (winners[key] = { max: -Infinity, winnerTrxIds: [] });
            if (b.amount > w.max) { w.max = b.amount; w.winnerTrxIds = [b.trxId]; }
            else if (b.amount === w.max && w.winnerTrxIds.indexOf(b.trxId) === -1) w.winnerTrxIds.push(b.trxId);
        }
        return winners;
    }

    // Derive the awards for a list of burns (the *policy* layer). Returns awards
    // aligned to the input order:
    //   [{ account, block, asset, amount, trxId, serial, isWin, downgrade }]
    //   isWin     — the unique top burner of its block+asset (gets the full card).
    //   downgrade — hand to resolveCardForBlock() to drop one rarity tier.
    // `winners` is the output of findBurnWinners(); pass it when you already have
    // it (awards only a subset without re-scanning) or omit it to compute it here.
    function deriveBurnAwards(burns, opts, winners) {
        opts = opts || {};
        const mode = opts.mode === 'winners_only' ? 'winners_only' : 'all_burns';
        const assetSuffix = opts.assetSuffix || { STEEM: '0', SBD: '1' };
        if (!winners) winners = findBurnWinners(burns);

        const awards = [];
        for (const b of burns) {
            const w = winners[`${b.block}|${b.asset}`];
            if (!w) continue;
            const isWin = w.winnerTrxIds.length === 1 && w.winnerTrxIds[0] === b.trxId;
            const tiedTop = w.winnerTrxIds.length > 1 && w.winnerTrxIds.indexOf(b.trxId) !== -1;
            let downgrade;
            if (mode === 'winners_only') {
                if (!isWin && !tiedTop) continue; // non-winners get nothing
                downgrade = tiedTop;              // ties are downgraded
            } else {
                downgrade = !isWin;               // everyone but the sole winner
            }
            const suffix = assetSuffix[b.asset] != null ? assetSuffix[b.asset] : '';
            awards.push({
                account: b.account,
                block: b.block,
                asset: b.asset,
                amount: b.amount,
                trxId: b.trxId,
                serial: `${b.block}.${suffix}`,
                isWin: isWin,
                downgrade: downgrade
            });
        }
        return awards;
    }

    return { hashForSerial, resolveCardForBlock, findBurnWinners, deriveBurnAwards, getSlotLayoutForBlock, DEFAULT_RARITY_SLOT_COUNTS, RARITY_WEIGHT };
}));

