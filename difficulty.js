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
 *   1. SCHEDULE (deterministic, enforced)
 *      A monotonic list of block milestones. Each may carry a global `multiplier`,
 *      per-rarity `multipliers { rarity: n }`, per-rarity `targets { rarity: n }`,
 *      and per-rarity `base_min_burns { rarity: n }` (tiered floor override).
 *      For a rarity the most recent milestone that defines it wins; per-rarity beats
 *      the global multiplier; missing per-rarity target falls back to the immutable
 *      root `rarities[rarity].target_per_window`; missing per-rarity
 *      `base_min_burns[rarity]` falls back to root `rarities[rarity].base_min_burn`.
 *      Example:
 *        { "block": 300000000, "base_min_burns": { "Mythic": 0.016 },
 *          "multipliers": { "Mythic": 4.0 }, "targets": { "Mythic": 10 } }
 *      → Mythic floor is 0.016 (tiered pricing), scaled 4x by difficulty,
 *        targeting 10 cards/window from that block on.
 *
 *   2. DEMAND (deterministic from chain history, OPT-IN)
 *      Each rarity has its own `target_per_window` (desired cards per window).
 *      When the caller supplies historical award counts via a `countsProvider`,
 *      the multiplier compounds window-over-window like Bitcoin mining
 *      difficulty (anchored at 1.0 for the first window):
 *        mult[w] = max(1, mult[w-1] * actual[w-1] / target)
 *      - actual > target  → difficulty rises (rarity over-supplied).
 *      - actual < target  → difficulty drifts back toward base.
 *      - counts unknown for a window (provider returns null) → keep prior value.
 *
 * Invariants (never violated):
 *   - The effective minimum NEVER drops below `base_min_burn`.
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
            window_blocks: Number(rd.window_blocks) || 0,
            schedule: [],
            rarities: {}
        };
        var sched = Array.isArray(rd.schedule) ? rd.schedule : [];
        out.schedule = sched
            .map(function (m) {
                var mk = null, tg = null, fb = null;
                if (m.multipliers && typeof m.multipliers === 'object') {
                    mk = {};
                    VALID_RARITIES.forEach(function (r) {
                        if (m.multipliers[r] != null) mk[r] = Number(m.multipliers[r]);
                    });
                }
                if (m.targets && typeof m.targets === 'object') {
                    tg = {};
                    VALID_RARITIES.forEach(function (r) {
                        if (m.targets[r] != null) tg[r] = Number(m.targets[r]);
                    });
                }
                if (m.base_min_burns && typeof m.base_min_burns === 'object') {
                    fb = {};
                    VALID_RARITIES.forEach(function (r) {
                        if (m.base_min_burns[r] != null) fb[r] = Number(m.base_min_burns[r]);
                    });
                }
                return {
                    block: Number(m.block),
                    multiplier: m.multiplier == null ? null : Number(m.multiplier),
                    multipliers: mk,
                    targets: tg,
                    base_min_burns: fb
                };
            })
            .filter(function (m) {
                return Number.isFinite(m.block) &&
                    (m.multiplier != null || m.multipliers || m.targets || m.base_min_burns);
            })
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

    // Largest schedule milestone in effect at a block. Multiplier milestones act
    // on demand-window granularity: a milestone's multiplier applies only from
    // the NEXT window boundary at or after its block (`ceil(block / window) *
    // window`), so the current (not-yet-complete) window keeps the previous
    // multiplier — "first adjustment shows base min; only multiply after a full
    // interval". With `window_blocks` = 0 milestones apply immediately.
    function scheduleMultiplier(conf, blockNum, rarity) {
        var win = conf.window_blocks || 0;
        var lastGlobal = 1;
        var lastPer = null;
        for (var i = 0; i < conf.schedule.length; i++) {
            var m = conf.schedule[i];
            var effBlock = m.block;
            if (win > 0) effBlock = Math.ceil(m.block / win) * win;
            if (blockNum < effBlock) break; // sorted ascending; not yet in effect
            if (m.multiplier != null && m.multiplier >= 1) lastGlobal = m.multiplier;
            if (m.multipliers && m.multipliers[rarity] != null && m.multipliers[rarity] >= 1) {
                lastPer = m.multipliers[rarity];
            }
        }
        return lastPer != null ? lastPer : lastGlobal;
    }

    // Effective target for a rarity at a block: the last schedule milestone's
    // `targets[rarity]` if defined, else the immutable root
    // `rarities[rarity].target_per_window`, else 0 (no target known yet).
    function effectiveTarget(conf, rarity, blockNum) {
        var rootT = conf.rarities[rarity] && conf.rarities[rarity].target_per_window;
        var lastPer = null;
        for (var i = 0; i < conf.schedule.length; i++) {
            var m = conf.schedule[i];
            if (blockNum < m.block) break;
            if (m.targets && m.targets[rarity] != null) {
                lastPer = m.targets[rarity];
            }
        }
        return lastPer != null ? lastPer : (rootT || 0);
    }

    // Per-rarity tiered floor at a block: the most recent schedule milestone's
    // `base_min_burns[rarity]` if defined, else the root
    // `rarities[rarity].base_min_burn`. This is the tiered-pricing knob —
    // independent of the difficulty multipliers, so tiers survive a
    // difficulty reset to 1.0.
    function scheduleFloor(conf, rarity, blockNum) {
        var rootT = conf.rarities[rarity] ? conf.rarities[rarity].base_min_burn : 0;
        var lastPer = null;
        for (var i = 0; i < conf.schedule.length; i++) {
            var m = conf.schedule[i];
            if (blockNum < m.block) break;
            if (m.base_min_burns && m.base_min_burns[rarity] != null) {
                lastPer = m.base_min_burns[rarity];
            }
        }
        return lastPer != null ? lastPer : (rootT || 0);
    }

    // Demand multiplier for a rarity at blockNum, compounded from window 0 up to
    // the window containing blockNum. countsProvider(windowIndex) returns an
    // object { Common: n, ... } of ACTUAL species awards in that window, or null
    // when unknown (keep prior multiplier). Each previous window uses the target
    // in effect at the START of that window (deterministic). Floor is 1 (no
    // discount below base burn), ceiling is unbounded — the window size itself
    // damps oscillation.
    function demandMultiplier(conf, rarity, blockNum, countsProvider) {
        var win = conf.window_blocks;
        if (!win) return 1;
        var mult = 1;
        var maxWindow = Math.floor(blockNum / win);
        for (var w = 1; w <= maxWindow; w++) {
            var counts = countsProvider ? (countsProvider(w - 1) || null) : null;
            if (!counts || counts[rarity] == null) continue;
            var target = effectiveTarget(conf, rarity, (w - 1) * win);
            if (!target) continue; // no target in effect for that window yet
            var actual = Number(counts[rarity]);
            mult = Math.max(1, mult * (actual / target));
        }
        return mult;
    }

    // Effective minimum burn for one rarity at blockNum. `conf` must already be
    // normalized. Returns 0 when disabled or base is 0 (resolver ignores it).
    function minBurnFor(conf, rarity, blockNum, countsProvider) {
        // Tiered floor: most-recent schedule `base_min_burns[rarity]` wins,
        // else fall back to root `rarities[rarity].base_min_burn`.
        var base = scheduleFloor(conf, rarity, blockNum);
        if (!base || base <= 0) return 0;
        if (conf.enabled_block == null || blockNum < conf.enabled_block) return 0;
        var eff = base
            * scheduleMultiplier(conf, blockNum, rarity)
            * demandMultiplier(conf, rarity, blockNum, countsProvider);
        return Math.max(base, eff);
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
        scheduleFloor: scheduleFloor,
        effectiveTarget: effectiveTarget,
        demandMultiplier: demandMultiplier,
        effectiveMinBurn: effectiveMinBurn,
        effectiveMinBurns: effectiveMinBurns
    };
}));