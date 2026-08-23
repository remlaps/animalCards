/**
 * validate-cards.js
 *
 * Development-time sanity check for cards-config.json. Run with Node:
 *
 *   node validate-cards.js
 *
 * It verifies:
 *   1. class_weights sum to 100.
 *   2. card_id values are unique.
 *   3. rarity values are one of the supported set.
 *   4. `slot` is within its rarity's fixed band (Common 0-15, Rare 0-7,
 *      Epic 0-3, Legendary 0-1, Mythic 0).
 *   5. generation windows: no two cards of the same class+rarity+slot have
 *      overlapping windows, and any sequence of generations in a slot is
 *      contiguous (no generic gaps).
 *
 * Overlaps between generation windows are ERRORS; gaps between them are
 * WARNINGS. Structural problems (bad rarity,
 * out-of-range slot, duplicate card_id, weights != 100) are ERRORS and cause a
 * non-zero exit code.
 */
const fs = require('fs');
const path = require('path');

const CONFIG = process.argv[2] || path.join(__dirname, 'cards-config.json');
const RARITY_SLOT_COUNTS = { Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 };
const VALID_RARITIES = new Set(['Generic', ...Object.keys(RARITY_SLOT_COUNTS)]);
const MONOTONIC_ORDER = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];

const errors = [];
const warnings = [];

function cardLabel(c) {
    return c.class + " > " + c.rarity + " > slot " + c.slot + " > " + c.species + " (#" + c.card_id + ")";
}

// Check that rarity minimum burns are non-decreasing (Common <= Rare <= ... <= Mythic).
// values: object keyed by rarity, label: description for error messages.
function checkMonotonic(values, label) {
    MONOTONIC_ORDER.forEach(function(r) {
        if (values[r] == null) values[r] = NaN;
    });
    for (var i = 0; i < MONOTONIC_ORDER.length - 1; i++) {
        var r1 = MONOTONIC_ORDER[i];
        var r2 = MONOTONIC_ORDER[i + 1];
        var v1 = Number(values[r1]);
        var v2 = Number(values[r2]);
        if (!isNaN(v1) && !isNaN(v2) && v1 > v2) {
            errors.push(label + ': ' + r1 + ' (' + v1 + ') > ' + r2 + ' (' + v2 + '). ' +
                'Minimum burns must be non-decreasing from Common to Mythic.');
    }
}
}

// Effective inclusive window; null means unbounded. Block numbers are integers.
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const cards = cfg.cards || [];

// 1. class_weights sum to 100
const weights = cfg.class_weights || {};
const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
if (weightSum !== 100) {
    errors.push(`class_weights sum to ${weightSum}, expected 100.`);
}

// 2. unique card_id
const seenIds = new Map();
for (const c of cards) {
    if (seenIds.has(c.card_id)) {
        errors.push(`Duplicate card_id ${c.card_id} (${c.species} vs ${seenIds.get(c.card_id)}).`);
    }
    seenIds.set(c.card_id, c.species);
}

// 3. valid rarity + 4. in-band slot
for (const c of cards) {
    if (!VALID_RARITIES.has(c.rarity)) {
        errors.push(`Card #${c.card_id} has unknown rarity "${c.rarity}".`);
        continue;
    }
    if (c.rarity === 'Generic') continue; // generic placeholders have no slot band
    const band = RARITY_SLOT_COUNTS[c.rarity];
    if (!Number.isInteger(c.slot) || c.slot < 0 || c.slot >= band) {
        errors.push(
            `Card #${c.card_id} (${c.species}) has slot ${c.slot}, but ${c.rarity} only allows 0..${band - 1}.`
        );
    }
    if (c.start_block != null && !Number.isInteger(c.start_block)) {
        errors.push(`Card #${c.card_id} start_block must be an integer or null.`);
    }
    if (c.end_block != null && !Number.isInteger(c.end_block)) {
        errors.push(`Card #${c.card_id} end_block must be an integer or null.`);
    }
    if (c.end_block != null && c.start_block != null && c.end_block < c.start_block) {
        errors.push(`Card #${c.card_id} has end_block ${c.end_block} < start_block ${c.start_block}.`);
    }
    if (!Object.keys(weights).includes(c.class)) {
        errors.push(`Card #${c.card_id} (${c.species}) class "${c.class}" is not a key in class_weights.`);
    }
}

// 5. window overlap / contiguity per (class, rarity, slot)
const bySlot = new Map();
for (const c of cards) {
    if (c.rarity === 'Generic') continue;
    const key = `${c.class}|${c.rarity}|${c.slot}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(c);
}

for (const [key, group] of bySlot) {
    if (group.length < 2) continue;
    // sort by effective start; unbounded (null) start sorts first.
    const sorted = [...group].sort((a, b) => effStart(a) - effStart(b));
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i], b = sorted[j];
            // overlap if b starts before/at a's end.
            if (effStart(b) <= effEnd(a)) {
                errors.push(
                    `Overlapping generation windows for ${key}: ${cardLabel(a)} [${fmt(a)}] and ${cardLabel(b)} [${fmt(b)}].`
                );
            }
        }
    }
    // contiguity between consecutive generations (no generic gaps)
    for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i], b = sorted[i + 1];
        const aEnd = effEnd(a), bStart = effStart(b);
        if (Number.isFinite(aEnd) && Number.isFinite(bStart) && bStart > aEnd + 1) {
            warnings.push(
                `Gap in generation windows for ${key}: ${cardLabel(a)} ends at ${aEnd} but ${cardLabel(b)} starts at ${bStart}. Blocks ${aEnd + 1}..${bStart - 1} fall back to generic.`
            );
        }
    }
}

function effStart(c) { return c.start_block == null ? -Infinity : c.start_block; }
function effEnd(c) { return c.end_block == null ? Infinity : c.end_block; }
function fmt(c) {
    const s = c.start_block == null ? '∞' : c.start_block;
    const e = c.end_block == null ? '∞' : c.end_block;
    return `${s}..${e}`;
}

// 6. rarity_difficulty (RABD) validation
const rd = cfg.rarity_difficulty || null;
if (rd) {
    if (rd.enabled_block != null && !Number.isInteger(rd.enabled_block)) {
        errors.push('rarity_difficulty.enabled_block must be an integer or null.');
    }
    if (rd.schedule != null) {
        if (!Array.isArray(rd.schedule)) {
            errors.push('rarity_difficulty.schedule must be an array.');
        } else {
            let prev = -Infinity;
            rd.schedule.forEach((m, i) => {
                if (typeof m !== 'object' || m === null || !Number.isInteger(m.block) || m.block < 0) {
                    errors.push(`rarity_difficulty.schedule[${i}] must be an object with an integer block >= 0.`);
                } else {
                    if (m.block < prev) {
                        warnings.push(`rarity_difficulty.schedule is not sorted ascending at index ${i}.`);
                    }
                    prev = m.block;
                }
                // per-rarity base_min_burns_steem (tiered floor override, STEEM)
                if (m.base_min_burns_steem != null) {
                    if (typeof m.base_min_burns_steem !== 'object' || Array.isArray(m.base_min_burns_steem)) {
                        errors.push(`rarity_difficulty.schedule[${i}].base_min_burns_steem must be an object keyed by rarity.`);
                    } else {
                        for (const [r, v] of Object.entries(m.base_min_burns_steem)) {
                            if (!VALID_RARITIES.has(r) || r === 'Generic') {
                                errors.push(`rarity_difficulty.schedule[${i}].base_min_burns_steem has unknown rarity "${r}".`);
                            } else if (typeof v !== 'number' || v < 0) {
                                errors.push(`rarity_difficulty.schedule[${i}].base_min_burns_steem["${r}"] must be a number >= 0.`);
                            }
                        }
                    }
                }
                // per-rarity base_min_burns_sbd (tiered floor override, SBD)
                if (m.base_min_burns_sbd != null) {
                    if (typeof m.base_min_burns_sbd !== 'object' || Array.isArray(m.base_min_burns_sbd)) {
                        errors.push(`rarity_difficulty.schedule[${i}].base_min_burns_sbd must be an object keyed by rarity.`);
                    } else {
                        for (const [r, v] of Object.entries(m.base_min_burns_sbd)) {
                            if (!VALID_RARITIES.has(r) || r === 'Generic') {
                                errors.push(`rarity_difficulty.schedule[${i}].base_min_burns_sbd has unknown rarity "${r}".`);
                            } else if (typeof v !== 'number' || v < 0) {
                                errors.push(`rarity_difficulty.schedule[${i}].base_min_burns_sbd["${r}"] must be a number >= 0.`);
                            }
                        }
                    }
                }
                // Build effective minimums for this milestone (fall back to root)
                var effSteem = {}, effSbd = {};
                for (var ri = 0; ri < MONOTONIC_ORDER.length; ri++) {
                    var rr = MONOTONIC_ORDER[ri];
                    var rootR = (rd.rarities||{})[rr] || {};
                    effSteem[rr] = (m.base_min_burns_steem && m.base_min_burns_steem[rr] != null)
                        ? m.base_min_burns_steem[rr] : rootR.base_min_burn_steem;
                    effSbd[rr] = (m.base_min_burns_sbd && m.base_min_burns_sbd[rr] != null)
                        ? m.base_min_burns_sbd[rr] : rootR.base_min_burn_sbd;
                }
                checkMonotonic(effSteem, 'rarity_difficulty.schedule[' + i + '] effective base_min_burns_steem');
                checkMonotonic(effSbd, 'rarity_difficulty.schedule[' + i + '] effective base_min_burns_sbd');
            });
        }
    }
    const rar = rd.rarities || {};
    for (const [r, s] of Object.entries(rar)) {
        if (!VALID_RARITIES.has(r) || r === 'Generic') {
            errors.push(`rarity_difficulty.rarities has unknown rarity "${r}".`);
            continue;
        }
        if (typeof s.base_min_burn_steem !== 'number' || s.base_min_burn_steem < 0) {
            errors.push(`rarity_difficulty.rarities["${r}"].base_min_burn_steem must be a number >= 0.`);
        }
        if (s.base_min_burn_sbd != null && (typeof s.base_min_burn_sbd !== 'number' || s.base_min_burn_sbd < 0)) {
            errors.push(`rarity_difficulty.rarities["${r}"].base_min_burn_sbd must be a number >= 0 or omitted.`);
        }
    }
    
    // Monotonicity check for root rarity values
    var monoS = {}, monoSbd = {};
    for (var ri = 0; ri < MONOTONIC_ORDER.length; ri++) {
        var rr = MONOTONIC_ORDER[ri];
        var rs = rar[rr] || {};
        monoS[rr] = rs.base_min_burn_steem;
        monoSbd[rr] = rs.base_min_burn_sbd;
    }
    checkMonotonic(monoS, 'rarity_difficulty.rarities base_min_burn_steem');
    checkMonotonic(monoSbd, 'rarity_difficulty.rarities base_min_burn_sbd');
// Immutability: once enabled_block passes, every rarity_difficulty field at or
    // before that block is locked (changing it retroactively alters past lookups).
    // Only appending schedule milestones with block > enabled_block is safe.
    if (rd.enabled_block != null && rd.enabled_block >= 0) {
        const futureEntries = (rd.schedule || []).filter(s => s && s.block != null && s.block > rd.enabled_block);
        warnings.push(
            `rarity_difficulty is active from block ${rd.enabled_block}. After activation, ` +
            'base_min_burn_steem / base_min_burn_sbd / schedule milestones retroactively affect past ' +
            `resolutions, so only APPEND schedule milestones with block > ${rd.enabled_block}. ` +
            `Future milestones currently defined: ${futureEntries.length}.`
        );
    }
}

// 7. slot_layouts validation
const slotLayouts = cfg.slot_layouts || [];
if (!Array.isArray(slotLayouts)) {
    errors.push('slot_layouts must be an array.');
} else if (slotLayouts.length > 0) {
    let prevBlock = -Infinity;
    slotLayouts.forEach((layout, i) => {
        if (typeof layout !== 'object' || layout === null) {
            errors.push(`slot_layouts[${i}] must be an object.`);
            return;
        }
        if (layout.block != null && !Number.isInteger(layout.block)) {
            errors.push(`slot_layouts[${i}].block must be an integer.`);
        }
        if (i === 0 && (layout.block == null || layout.block !== 0)) {
            errors.push(`slot_layouts[0] must have block === 0 (earliest layout at genesis).`);
        }
        if (i > 0 && layout.block != null && layout.block <= prevBlock) {
            errors.push(`slot_layouts[${i}] block ${layout.block} is not > previous block ${prevBlock}.`);
        }
        if (layout.block != null) prevBlock = layout.block;
        // Validate each rarity slot count
        ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'].forEach(function(r) {
            if (layout[r] != null) {
                if (!Number.isInteger(layout[r]) || layout[r] < 1) {
                    errors.push(`slot_layouts[${i}].${r} must be a positive integer, got ${layout[r]}.`);
                }
            } else {
                errors.push(`slot_layouts[${i}].${r} is missing.`);
            }
        });
    });
    // Warn about immutability: once a layout's block has passed, the entry is locked.
    // Only appending new layouts with future blocks is safe.
    warnings.push(
        `slot_layouts defined with ${slotLayouts.length} entry(s). After block 0, each ` +
        'slot_layouts entry is immutable — past blocks depend on it. Only APPEND new entries with future block numbers.'
    );
}

console.log('validate-cards.js');
console.log(`cards: ${cards.length}`);
if (warnings.length) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach((w) => console.log('  ⚠ ' + w));
} else {
    console.log('\nWarnings: none');
}
if (errors.length) {
    console.log(`\nERRORS (${errors.length}):`);
    errors.forEach((e) => console.log('  ✖ ' + e));
    console.log('\nResult: FAIL');
    process.exit(1);
}
console.log('\nResult: OK');
