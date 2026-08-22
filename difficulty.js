/**
 * difficulty.js
 *
 * Rarity-Gated Minimum Burns — single source of truth for computing the per-rarity
 * minimum burn required to receive a *species* card at a given block.
 *
 * Each rarity has separate STEEM and SBD floor values (base_min_burn_steem,
 * base_min_burn_sbd). The schedule array can override these at future block
 * milestones via per-rarity `base_min_burns_steem { rarity: n }` and
 * `base_min_burns_sbd { rarity: n }`.
 *
 * Invariants (never violated):
 *   - The effective minimum NEVER drops below its configured floor.
 *   - Before `enabled_block` the effective minimum is 0 for EVERY rarity, so
 *     the gating is off and no card that was issued before the switch is ever
 *     retroactively changed.
 *
 * Browsers load this as a plain <script> (global CardDifficulty); Node uses
 * require('./difficulty.js').
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CardDifficulty = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var VALID_RARITIES = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];

    function normalize(config) {
        var rd = (config && config.rarity_difficulty) || {};
        var out = {
            enabled_block: rd.enabled_block == null ? null : Number(rd.enabled_block),
            schedule: [],
            rarities: {}
        };
        var sched = Array.isArray(rd.schedule) ? rd.schedule : [];
        out.schedule = sched
            .map(function (m) {
                var fb = null, fbSbd = null;
                if (m.base_min_burns_steem && typeof m.base_min_burns_steem === 'object') {
                    fb = {};
                    VALID_RARITIES.forEach(function (r) {
                        if (m.base_min_burns_steem[r] != null) fb[r] = Number(m.base_min_burns_steem[r]);
                    });
                }
                if (m.base_min_burns_sbd && typeof m.base_min_burns_sbd === 'object') {
                    fbSbd = {};
                    VALID_RARITIES.forEach(function (r) {
                        if (m.base_min_burns_sbd[r] != null) fbSbd[r] = Number(m.base_min_burns_sbd[r]);
                    });
                }
                return { block: Number(m.block), base_min_burns_steem: fb, base_min_burns_sbd: fbSbd };
            })
            .filter(function (m) { return Number.isFinite(m.block) && (m.base_min_burns_steem || m.base_min_burns_sbd); })
            .sort(function (a, b) { return a.block - b.block; });
        var rar = rd.rarities || {};
        VALID_RARITIES.forEach(function (r) {
            var s = rar[r] || {};
            out.rarities[r] = {
                base_min_burn_steem: Number(s.base_min_burn_steem) || 0,
                base_min_burn_sbd: Number(s.base_min_burn_sbd) || 0
            };
        });
        return out;
    }

    function scheduleFloorSteem(conf, rarity, blockNum) {
        var rootT = conf.rarities[rarity] ? conf.rarities[rarity].base_min_burn_steem : 0;
        var lastPer = null;
        for (var i = 0; i < conf.schedule.length; i++) {
            var m = conf.schedule[i];
            if (blockNum < m.block) break;
            if (m.base_min_burns_steem && m.base_min_burns_steem[rarity] != null) lastPer = m.base_min_burns_steem[rarity];
        }
        return lastPer != null ? lastPer : (rootT || 0);
    }

    function scheduleFloorSBD(conf, rarity, blockNum) {
        var rootT = conf.rarities[rarity] ? conf.rarities[rarity].base_min_burn_sbd : 0;
        var lastPer = null;
        for (var i = 0; i < conf.schedule.length; i++) {
            var m = conf.schedule[i];
            if (blockNum < m.block) break;
            if (m.base_min_burns_sbd && m.base_min_burns_sbd[rarity] != null) lastPer = m.base_min_burns_sbd[rarity];
        }
        return lastPer != null ? lastPer : (rootT || 0);
    }

    function minBurnFor(conf, rarity, blockNum) {
        var base = scheduleFloorSteem(conf, rarity, blockNum);
        if (!base || base <= 0) return 0;
        if (conf.enabled_block == null || blockNum < conf.enabled_block) return 0;
        return base;
    }

    function minBurnForSBD(conf, rarity, blockNum) {
        var base = scheduleFloorSBD(conf, rarity, blockNum);
        if (!base || base <= 0) return 0;
        if (conf.enabled_block == null || blockNum < conf.enabled_block) return 0;
        return base;
    }

    function effectiveMinBurn(blockNum, rarity, config) {
        return minBurnFor(normalize(config), rarity, blockNum);
    }

    function effectiveMinBurns(blockNum, config) {
        var conf = normalize(config);
        var out = {};
        VALID_RARITIES.forEach(function (r) { out[r] = minBurnFor(conf, r, blockNum); });
        return out;
    }

    function effectiveMinBurnSBD(blockNum, rarity, config) {
        return minBurnForSBD(normalize(config), rarity, blockNum);
    }

    function effectiveMinBurnsSBD(blockNum, config) {
        var conf = normalize(config);
        var out = {};
        VALID_RARITIES.forEach(function (r) { out[r] = minBurnForSBD(conf, r, blockNum); });
        return out;
    }

    return {
        VALID_RARITIES: VALID_RARITIES,
        normalize: normalize,
        scheduleFloorSteem: scheduleFloorSteem,
        scheduleFloorSBD: scheduleFloorSBD,
        effectiveMinBurn: effectiveMinBurn,
        effectiveMinBurns: effectiveMinBurns,
        effectiveMinBurnSBD: effectiveMinBurnSBD,
        effectiveMinBurnsSBD: effectiveMinBurnsSBD
    };
}));