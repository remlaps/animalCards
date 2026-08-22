#!/usr/bin/env node
/**
 * test-cards.js
 *
 * Comprehensive regression test suite for animalCards.
 *
 * Run:   node test-cards.js
 *        node test-cards.js --update-snapshots   (regenerate baseline snapshots)
 *
 * Tests:
 *   1) Structural integrity         — re-runs validate-cards.js checks
 *   2) Historical resolution        — replays known (serial,blockHash) → expected card
 *   3) Card identity immutability   — fingerprints of every card must match the snapshot
 *   4) Generation window rules      — no overlaps, no gaps in (class, rarity, slot)
 *   5) Generic card rules           — exactly one per class, correct is_generic flag
 *   6) RABD difficulty computation  — tests difficulty.js at known blocks
 *   7) Determinism consistency      — same input → same output every time
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Paths
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'cards-config.json');
const SNAPSHOT_PATH = path.join(ROOT, 'test-snapshots.json');
const VALIDATE_SCRIPT = path.join(ROOT, 'validate-cards.js');

// Helpers
const PASS = '\u2713';
const FAIL = '\u2716';
const WARN = '\u26A0';

let passed = 0;
let failed = 0;
let warns = 0;

function test(group, name, fn) {
    try {
        fn();
        passed++;
        console.log('  ' + PASS + ' [' + group + '] ' + name);
    } catch (err) {
        failed++;
        console.log('  ' + FAIL + ' [' + group + '] ' + name + ': ' + (err.message || String(err)));
    }
}

function warn(group, name, msg) {
    warns++;
    console.log('  ' + WARN + ' [' + group + '] ' + name + ': ' + msg);
}

// Deep diff: returns array of difference strings; empty = identical
function deepEqualDiff(a, b, label) {
    var diffs = [];
    (function walk(a, b, p) {
        if (a === b) return;
        if (a == null || b == null) { diffs.push(p + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b)); return; }
        if (typeof a !== typeof b) { diffs.push(p + ': type ' + typeof a + ' != ' + typeof b); return; }
        if (Array.isArray(a)) {
            if (!Array.isArray(b)) { diffs.push(p + ': array != non-array'); return; }
            for (var i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], p + '[' + i + ']');
            return;
        }
        if (typeof a === 'object') {
            var allKeys = {};
            for (var k in a) allKeys[k] = true;
            for (var k in b) allKeys[k] = true;
            for (var k in allKeys) walk(a[k], b[k], p + '.' + k);
            return;
        }
        diffs.push(p + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
    })(a, b, label);
    return diffs;
}

function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }

function loadSnapshots() { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')); }

var RARITY_SLOT_COUNTS = { Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 };
// ---------------------------------------------------------------------------
// 1) Structural integrity
// ---------------------------------------------------------------------------
function testStructuralIntegrity() {
    console.log('\n-- Structural integrity ------------------------------------');
    var result = spawnSync('node', [VALIDATE_SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    test('1-validate', 'validate-cards.js exit code', function () {
        if (result.status !== 0) throw new Error('Failed with status ' + result.status + '\n' + result.stderr + result.stdout);
    });
    test('1-validate', 'validate-cards.js reports no errors', function () {
        if (result.stdout.includes('ERRORS')) throw new Error('Validation errors found:\n' + result.stdout);
    });
    var wc = (result.stdout.match(/\u26A0/g) || []).length;
    if (wc > 0) warn('1-validate', 'validate-cards.js reported ' + wc + ' warning(s)', 'Review warnings');
}
// ---------------------------------------------------------------------------
// 2) Historical resolution snapshots (async)
// ---------------------------------------------------------------------------
async function runSnapshotTests(cfg, snapshot) {
    console.log('\n-- Historical resolution snapshots ------------------------');
    const CardResolver = require('./card-resolver.js');
    var localPassed = 0, localFailed = 0;
    for (const tc of snapshot.snapshot_cases) {
        try {
            const r = await CardResolver.resolveCardForBlock(tc.serialNumber, tc.blockHash, cfg);
            var actual = { status: r.status, className: r.className, rarity: r.rarity, slot: r.slot, slotPick: r.slotPick, species: r.card ? r.card.species : null, card_id: r.card ? r.card.card_id : null, generic_reason: r.generic_reason || null };
            var diffs = deepEqualDiff(tc.expected, actual, '');
            if (diffs.length === 0) {
                localPassed++;
                console.log('  ' + PASS + ' [2-snapshot] ' + tc.serialNumber + ' -> ' + (tc.expected.species || '(generic)'));
            } else {
                localFailed++;
                console.log('  ' + FAIL + ' [2-snapshot] ' + tc.serialNumber + ':');
                diffs.forEach(function (d) { console.log('       ' + d); });
                console.log('       expected: ' + JSON.stringify(tc.expected));
                console.log('       actual:   ' + JSON.stringify(actual));
            }
        } catch (err) {
            localFailed++;
            console.log('  ' + FAIL + ' [2-snapshot] ' + tc.serialNumber + ': ' + (err.message || String(err)));
        }
    }
    passed += localPassed;
    failed += localFailed;
}

// ---------------------------------------------------------------------------
// 3) Card identity immutability
// ---------------------------------------------------------------------------
function testCardIdentity(cfg, snapshot) {
    console.log('\n-- Card identity immutability -----------------------------');
    var cards = cfg.cards || [];
    var fps = snapshot.card_fingerprints || {};
    for (const card of cards) {
        var cid = String(card.card_id);
        var old = fps[cid];
        if (!old) {
            warn('3-identity', 'card_id ' + cid + ' (' + card.species + ') is new (not in snapshot)', 'Verify intentional addition');
            continue;
        }
        test('3-identity', 'card_id ' + cid + ': species unchanged', function () {
            if (card.species !== old.species) throw new Error('"' + old.species + '" -> "' + card.species + '"');
        });
        test('3-identity', 'card_id ' + cid + ': class unchanged', function () {
            if (card.class !== old.class) throw new Error('"' + old.class + '" -> "' + card.class + '"');
        });
        test('3-identity', 'card_id ' + cid + ': rarity unchanged', function () {
            if (card.rarity !== old.rarity) throw new Error('"' + old.rarity + '" -> "' + card.rarity + '"');
        });
        test('3-identity', 'card_id ' + cid + ': is_generic unchanged', function () {
            if (Boolean(card.is_generic) !== old.is_generic) throw new Error('is_generic ' + old.is_generic + ' -> ' + Boolean(card.is_generic));
        });
        if (!card.is_generic && !old.is_generic) {
            test('3-identity', 'card_id ' + cid + ': slot unchanged', function () {
                if (card.slot !== old.slot) throw new Error('slot ' + old.slot + ' -> ' + card.slot);
            });
            test('3-identity', 'card_id ' + cid + ': start_block not narrowed', function () {
                var oldS = old.start_block == null ? -Infinity : old.start_block;
                var newS = card.start_block == null ? -Infinity : card.start_block;
                if (newS < oldS) throw new Error('start_block ' + old.start_block + ' -> ' + card.start_block + ' (went backwards!)');
            });
            test('3-identity', 'card_id ' + cid + ': end_block not narrowed', function () {
                var oldE = old.end_block == null ? Infinity : old.end_block;
                var newE = card.end_block == null ? Infinity : card.end_block;
                if (newE < oldE) throw new Error('end_block ' + old.end_block + ' -> ' + card.end_block + ' (window shrunk!)');
            });
        }
    }
    var currentIds = new Set(cards.map(function (c) { return String(c.card_id); }));
    for (var cid in fps) {
        if (!fps.hasOwnProperty(cid)) continue;
        test('3-identity', 'card_id ' + cid + ' still exists', function () {
            if (!currentIds.has(cid)) throw new Error('Card #' + cid + ' (' + fps[cid].species + ') is missing!');
        });
    }
}
// ---------------------------------------------------------------------------
// 4) Generation window rules
// ---------------------------------------------------------------------------
function testGenerationWindows(cfg) {
    console.log('\n-- Generation window rules ---------------------------------');
    var cards = cfg.cards || [];
    var bySlot = {};
    for (const c of cards) {
        if (c.rarity === 'Generic') continue;
        var key = c.class + '|' + c.rarity + '|' + c.slot;
        if (!bySlot[key]) bySlot[key] = [];
        bySlot[key].push(c);
    }
    for (var key in bySlot) {
        if (!bySlot.hasOwnProperty(key)) continue;
        var group = bySlot[key];
        if (group.length < 2) continue;
        group.sort(function (a, b) {
            var aS = a.start_block == null ? -Infinity : a.start_block;
            var bS = b.start_block == null ? -Infinity : b.start_block;
            return aS - bS;
        });
        for (var i = 0; i < group.length; i++) {
            for (var j = i + 1; j < group.length; j++) {
                (function (a, b) {
                    test('4-windows', 'No overlap: ' + key + ' (' + a.species + ' #' + a.card_id + ' vs ' + b.species + ' #' + b.card_id + ')', function () {
                        var bStart = b.start_block == null ? -Infinity : b.start_block;
                        var aEnd = a.end_block == null ? Infinity : a.end_block;
                        if (bStart <= aEnd) throw new Error('Overlap: "' + a.species + '" ends at ' + aEnd + ' but "' + b.species + '" starts at ' + bStart);
                    });
                })(group[i], group[j]);
            }
        }
        for (var i = 0; i + 1 < group.length; i++) {
            (function (a, b) {
                test('4-windows', 'No gap: ' + key + ' (' + a.species + ' -> ' + b.species + ')', function () {
                    var aEnd = a.end_block == null ? Infinity : a.end_block;
                    var bStart = b.start_block == null ? -Infinity : b.start_block;
                    if (Number.isFinite(aEnd) && Number.isFinite(bStart) && bStart > aEnd + 1) {
                        throw new Error('Gap from ' + (aEnd + 1) + ' to ' + (bStart - 1));
                    }
                });
            })(group[i], group[i + 1]);
        }
    }
}

// ---------------------------------------------------------------------------
// 5) Generic card rules
// ---------------------------------------------------------------------------
function testGenericCards(cfg) {
    console.log('\n-- Generic card rules -------------------------------------');
    var cards = cfg.cards || [];
    var generics = cards.filter(function (c) { return c.is_generic; });
    var byClass = {};
    for (const g of generics) {
        if (!byClass[g.class]) byClass[g.class] = [];
        byClass[g.class].push(g);
    }
    var classesWithSpecies = new Set(cards.filter(function (c) { return !c.is_generic; }).map(function (c) { return c.class; }));
    for (const cls of classesWithSpecies) {
        test('5-generics', 'Class "' + cls + '" has exactly one generic', function () {
            var list = byClass[cls] || [];
            if (list.length === 0) throw new Error('No generic for class "' + cls + '"');
            if (list.length > 1) throw new Error('Multiple generics for class "' + cls + '": ' + list.map(function (c) { return '#' + c.card_id; }).join(', '));
        });
    }
    for (const g of generics) {
        test('5-generics', 'Generic #' + g.card_id + ' rarity="Generic"', function () {
            if (g.rarity !== 'Generic') throw new Error('Got "' + g.rarity + '"');
        });
        test('5-generics', 'Generic #' + g.card_id + ' is_generic=true', function () {
            if (!g.is_generic) throw new Error('is_generic not true');
        });
        test('5-generics', 'Generic #' + g.card_id + ' has no slot', function () {
            if (g.slot != null) throw new Error('slot=' + g.slot);
        });
    }
}
// ---------------------------------------------------------------------------
// 6) RABD difficulty computation
// ---------------------------------------------------------------------------
function testRABD(cfg) {
    console.log('\n-- RABD difficulty computation -----------------------------');
    const CardDifficulty = require('./difficulty.js');
    var rd = cfg.rarity_difficulty || {};
    var eb = rd.enabled_block;
    if (eb != null && eb > 0) {
        var burns = CardDifficulty.effectiveMinBurns(eb - 1, cfg);
        for (var r in burns) {
            if (!burns.hasOwnProperty(r)) continue;
            (function (rar, v) {
                test('6-rabd', 'Min burn for ' + rar + ' before enabled_block is 0', function () {
                    if (v !== 0) throw new Error('Expected 0, got ' + v);
                });
            })(r, burns[r]);
        }
        var atBurns = CardDifficulty.effectiveMinBurns(eb, cfg);
        for (var r in atBurns) {
            if (!atBurns.hasOwnProperty(r)) continue;
            (function (rar, v) {
                test('6-rabd', 'Min burn for ' + rar + ' at enabled_block matches config', function () {
                    var exp = (rd.rarities && rd.rarities[rar] && rd.rarities[rar].base_min_burn_steem) || 0;
                    if (v !== exp) throw new Error('Expected ' + exp + ', got ' + v);
                });
            })(r, atBurns[r]);
        }
    }
    test('6-rabd', 'normalize() runs', function () {
        var n = CardDifficulty.normalize(cfg);
        if (!n || typeof n !== 'object') throw new Error('Invalid');
    });
    test('6-rabd', 'schedule sorted', function () {
        var s = CardDifficulty.normalize(cfg).schedule;
        for (var i = 1; i < s.length; i++) {
            if (s[i].block < s[i - 1].block) throw new Error('Unsorted at ' + i);
        }
    });
}
// ---------------------------------------------------------------------------
// 7) Determinism consistency
// ---------------------------------------------------------------------------
async function testDeterminism(cfg) {
    console.log('\n-- Determinism consistency --------------------------------');
    const CardResolver = require('./card-resolver.js');
    var cases = [
        { sn: '777777.0', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { sn: '1234567.1', hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        { sn: '8888888.0', hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }
    ];
    for (const tc of cases) {
        try {
            var r1 = await CardResolver.resolveCardForBlock(tc.sn, tc.hash, cfg);
            var r2 = await CardResolver.resolveCardForBlock(tc.sn, tc.hash, cfg);
            var diffs = deepEqualDiff(r1, r2, '');
            if (diffs.length === 0) {
                passed++;
                console.log('  ' + PASS + ' [7-determinism] ' + tc.sn + ' resolves identically twice');
            } else {
                failed++;
                console.log('  ' + FAIL + ' [7-determinism] ' + tc.sn + ' differs!');
                diffs.forEach(function (d) { console.log('       ' + d); });
            }
        } catch (err) {
            failed++;
            console.log('  ' + FAIL + ' [7-determinism] ' + tc.sn + ': ' + (err.message || String(err)));
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot update
// ---------------------------------------------------------------------------
async function updateSnapshots(cfg, snapshot) {
    console.log('Updating snapshots from current config...');
    const CardResolver = require('./card-resolver.js');
    for (const tc of snapshot.snapshot_cases) {
        const r = await CardResolver.resolveCardForBlock(tc.serialNumber, tc.blockHash, cfg);
        tc.expected = { status: r.status, className: r.className, rarity: r.rarity, slot: r.slot, slotPick: r.slotPick, species: r.card ? r.card.species : null, card_id: r.card ? r.card.card_id : null, generic_reason: r.generic_reason || null };
    }
    var fps = {};
    for (const card of cfg.cards) {
        var fp = { species: card.species, class: card.class, rarity: card.rarity, generation: card.generation, is_generic: Boolean(card.is_generic) };
        if (card.slot !== undefined) fp.slot = card.slot;
        fp.start_block = card.start_block != null ? card.start_block : null;
        fp.end_block = card.end_block != null ? card.end_block : null;
        fps[String(card.card_id)] = fp;
    }
    snapshot.card_fingerprints = fps;
    snapshot.generated_at = new Date().toISOString();
    snapshot.card_count = cfg.cards.length;
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
    console.log('Updated: ' + snapshot.snapshot_cases.length + ' cases, ' + Object.keys(fps).length + ' fingerprints');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
    var updateMode = process.argv.includes('--update-snapshots');
    var cfg = loadConfig();
    var snapshot = loadSnapshots();
    console.log('animalCards Test Suite');
    console.log('Cards: ' + (cfg.cards || []).length + ', Snapshot cases: ' + snapshot.snapshot_cases.length);
    if (updateMode) { await updateSnapshots(cfg, snapshot); return; }
    testStructuralIntegrity();
    testCardIdentity(cfg, snapshot);
    testGenerationWindows(cfg);
    testGenericCards(cfg);
    testRABD(cfg);
    await runSnapshotTests(cfg, snapshot);
    await testDeterminism(cfg);
    console.log('\n-----------------------------------------------------------------');
    console.log('Results: ' + passed + ' passed, ' + failed + ' failed, ' + warns + ' warnings');
    if (failed > 0) { console.log('\nSOME TESTS FAILED'); process.exit(1); }
    if (warns > 0) console.log('\nPassed with warnings');
    else console.log('\nAll tests passed.');
}

main().catch(function (err) { console.error('Fatal: ' + (err.message || String(err))); process.exit(1); });