/**
 * difficulty.js
 *
 * Rarity-Adjusted Burn Difficulty (RABD) — single source of truth for computing
 * the per-rarity minimum burn required to receive a *species* card at a given
 * block. This is the module that combines:
 *
 *   (6) Rarity-gated minimum burns  — each rarity has a `base_min_burn`.
 *   (7) Burn difficulty adjustment  — the effective minimum scales up when a
 *                                     rarity is in high demand, down when it
 *                                     cools, via an optional demand multiplier.
 *
 * Two multipliers stack on top of each rarity's `base_min_burn`:
 *
 *   1. SCHEDULE (deterministic, enforced by default)
 *      A monotonic list of block milestones, each carrying a `multiplier`.
 *        effective = base * scheduleMultiplier(block)
 *      This is a hard-coded difficulty schedule — zero network I/O, fully
 *      verifiable, ideal for the browser. Example:
 *        { "block": 300000000, "multiplier": 4.0 }  → 4x base from that block on.
 *
 *   2. DEMAND (deterministic from chain history, OPT-IN)
 *      Each rarity has its own `target_per_window` (desired cards per window).
 *      When the caller supplies historical award counts via a `countsProvider`,
 *      the multiplier compounds window-over-window like Bitcoin mining
 *      difficulty (anchored at 1.0 for the first window):
 *        mult[w] = clamp(mult[w-1] * actual[w-1] / target, 1, ceiling)
 *      - actual > target  → difficulty rises (rarity too cheap).
 *      - actual < target  → difficulty drifts back toward base.
 *      - counts unknown for a window (provider returns null) → keep prior value.
 *
 * Invariants (never violated):
 *   - The effective minimum NEVER drops below `base_min_burn`.
 *   - The effective minimum NEVER exceeds `base_min_burn * ceiling_multiplier`.
 *   - Before `enabled_block` the effective minimum is 0 for EVERY rarity, so
 *     difficulty is off and no card that was issued before the switch is ever
 *     retroactively changed. ("Don't take away cards already issued.")
 *
 * The resolvers compare a block winner's burn amount against the effective
 * minimum of the *resolved rarity slot* and fall back to the generic card (or
 * 'none') when the burn is too small — exactly like empty/`none` slots today.
 *
 * Browsers load this as a plain <script> (global `CardDifficulty`); Node uses
 * `require('./difficulty.js')`. Rarity key names match card-resolver.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        // Browser — expose a global
        root.CardDifficulty = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var VALID_RARITIES = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];

    // Coerce + validate the rarity_difficulty config into a clean internal shape.
    function normalize(config) {
        var rd = (config && config.rarity_difficulty) || {};
        var out = {
            enabled_block: rd.enabled_block == null ? null : Number(rd.enabled_block),
            ceiling_multiplier: Number(rd.ceiling_multiplier) || 1,
            window_blocks: Number(rd.window_blocks) || 0,
            schedule: [],
            rarities: {}
        };
        var sched = Array.isArray(rd.schedule) ? rd.schedule : [];
        out.schedule = sched
            .map(function (m) { return { block: Number(m.block), multiplier: Number(m.multiplier) }; })
            .filter(function (m) { return Number.isFinite(m.block) && Number.isFinite(m.multiplier); })
            .sort(function (a, b) { return a.block - b.block; });
        var rar = rd.rarities || {};
        VALID_RARITIES.forEach(function (r) {
            var s = rar[r] || {};
            out.rarities[r] = {
                base_min_burn: Number(s.base_min_burn) || 0,
                target_per_window: Number(s.target_per_window) || 0
            };
        });
        return out;
    }

    // Largest schedule milestone at or below blockNum (>= 1). Deterministic.
    function scheduleMultiplier(conf, blockNum) {
        var mult = 1;
        for (var i = 0; i < conf.schedule.length; i++) {
            if (blockNum >= conf.schedule[i].block && conf.schedule[i].multiplier >= 1) {
                mult = conf.schedule[i].multiplier;
            }
        }
        return mult;
    }

    // Demand multiplier for a rarity at blockNum, compounded from window 0 up to
    // the window containing blockNum. countsProvider(windowIndex) returns an
    // object { Common: n, ... } of ACTUAL species awards in that window, or null
    // when unknown (keep prior multiplier). Clamps to [1, ceiling].
    function demandMultiplier(conf, rarity, blockNum, countsProvider) {
        var target = conf.rarities[rarity] && conf.rarities[rarity].target_per_window;
        var win = conf.window_blocks;
        if (!target || !win) return 1;
        var mult = 1;
        var ceil = conf.ceiling_multiplier;
        var maxWindow = Math.floor(blockNum / win);
        for (var w = 1; w <= maxWindow; w++) {
            var counts = countsProvider ? (countsProvider(w - 1) || null) : null;
            if (!counts || counts[rarity] == null) continue;
            var actual = Number(counts[rarity]);
            mult = Math.max(1, Math.min(ceil, mult * (actual / target)));
        }
        return mult;
    }

    // Effective minimum burn for one rarity at blockNum. `conf` must already be
    // normalized. Returns 0 when disabled or base is 0 (resolver ignores it).
    function minBurnFor(conf, rarity, blockNum, countsProvider) {
        var s = conf.rarities[rarity];
        if (!s) return 0;
        var base = s.base_min_burn || 0;
        if (base <= 0) return 0;
        if (conf.enabled_block == null || blockNum < conf.enabled_block) return 0;
        var eff = base
            * scheduleMultiplier(conf, blockNum)
            * demandMultiplier(conf, rarity, blockNum, countsProvider);
        return Math.max(base, Math.min(base * conf.ceiling_multiplier, eff));
    }

    // Effective minimum burn for one rarity (auto-normalizes config).
    function effectiveMinBurn(blockNum, rarity, config, countsProvider) {
        return minBurnFor(normalize(config), rarity, blockNum, countsProvider);
    }

    // Effective minimums for ALL rarities at blockNum (auto-normalizes config).
    function effectiveMinBurns(blockNum, config, countsProvider) {
        var conf = normalize(config);
        var out = {};
        VALID_RARITIES.forEach(function (r) {
            out[r] = minBurnFor(conf, r, blockNum, countsProvider);
        });
        return out;
    }

    return {
        VALID_RARITIES: VALID_RARITIES,
        normalize: normalize,
        scheduleMultiplier: scheduleMultiplier,
        demandMultiplier: demandMultiplier,
        effectiveMinBurn: effectiveMinBurn,
        effectiveMinBurns: effectiveMinBurns
    };
}));