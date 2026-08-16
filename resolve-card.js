/**
 * resolve-card.js
 *
 * Command-line tool to verify block/card assignments in the animalCards BurnMax
 * distribution. Given a block number (and an optional winning burn transaction
 * id + asset), it reports the connected slot, species, and rarity.
 *
 * Usage:
 *   node resolve-card.js <blockNumber> [--trx-id <txid>] [--asset STEEM|SBD] [--json]
 *
 * - <blockNumber> (required) — the chain block to verify.
 * - --trx-id <txid>          — the winning burn transaction id (the "blockHash"
 *                               used in the deterministic hash). When provided,
 *                               resolution is done locally with no network.
 * - --asset STEEM|SBD        — which asset to resolve (defaults to STEEM when
 *                               --trx-id is given; with auto-fetch both are shown
 *                               unless this flag narrows it).
 * - --json                   — machine-readable JSON output.
 *
 * Without --trx-id the tool auto-fetches that block's burn winners from the
 * Steem chain (`condenser_api.get_account_history` for `null`) and resolves the
 * card for each winning asset, mirroring leaderboard.js tie rules.
 *
 * The resolution itself lives in the shared `card-resolver.js` module — the same
 * single source of truth used by the browser (`blockchain-api.js`).
 */
const fs = require('fs');
const path = require('path');
const CardResolver = require('./card-resolver.js');

const STEEM_API_URL = 'https://api.steemit.com';
const ASSETS = ['STEEM', 'SBD'];
const MAX_HISTORY_PAGES = 5000; // safety cap for auto-fetch pagination

function parseArgs(argv) {
    const args = { blockNum: null, trxId: null, asset: null, json: false };
    const positionals = [];
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') { args.json = true; continue; }
        if (a === '--trx-id') { args.trxId = argv[++i]; continue; }
        if (a === '--asset') {
            const v = String(argv[++i] || '').toUpperCase();
            if (v !== 'STEEM' && v !== 'SBD') {
                throw new Error(`--asset must be STEEM or SBD (got "${v}").`);
            }
            args.asset = v;
            continue;
        }
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
        positionals.push(a);
    }
    if (positionals.length !== 1) throw new Error('Exactly one block number is required.');
    args.blockNum = Number(positionals[0]);
    if (!Number.isInteger(args.blockNum) || args.blockNum < 0) {
        throw new Error(`Invalid block number: "${positionals[0]}"`);
    }
    return args;
}

async function callSteem(method, params) {
    const payload = { jsonrpc: '2.0', method, params, id: 1 };
    const res = await fetch(STEEM_API_URL, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Steam API`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.result;
}
function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'cards-config.json'), 'utf8'));
}

function serialFor(blockNum, asset) {
    return `${blockNum}.${asset === 'SBD' ? 1 : 0}`;
}

// 0-based slot band (e.g. "0-7") for a rarity, from the shared config constant.
function slotRangeFor(rarity) {
    const count = CardResolver.RARITY_SLOT_COUNTS[rarity];
    return count == null ? '-' : `0-${count - 1}`;
}

// Auto-fetch the winning burn for a block, per asset.
// Mirrors leaderboard.js: the single largest transfer to `null` in that block
// wins; an exact tie for the top amount yields no winner. Paginates the `null`
// account history newest-first and stops once it passes the target block.
async function fetchNullWinners(blockNum) {
    const winners = {
        STEEM: { max: -Infinity, winner: null, trx_id: null },
        SBD: { max: -Infinity, winner: null, trx_id: null }
    };
    let start = -1;
    let limit = 100; // condenser_api caps get_account_history limit at 100
    let gonePast = false;
    let pages = 0;

    while (!gonePast && pages < MAX_HISTORY_PAGES) {
        pages++;
        const result = await callSteem('condenser_api.get_account_history', ['null', start, limit]);
        if (!Array.isArray(result) || result.length === 0) break;

        // get_account_history returns the page in ascending seq (oldest-first).
        // Walk it newest→oldest so we stop as soon as we've gone past the block.
        for (let i = result.length - 1; i >= 0; i--) {
            const item = result[i][1];
            if (typeof item.block === 'number' && item.block < blockNum) {
                gonePast = true;
                break;
            }
            if (item.block !== blockNum) continue;

            const op = item.op;
            if (!op || op[0] !== 'transfer') continue;
            const params = op[1];
            if (!params || params.to !== 'null' || typeof params.amount !== 'string') continue;

            const parts = params.amount.split(' ');
            if (parts.length !== 2 || !winners[parts[1]]) continue;
            const asset = parts[1];
            const val = parseFloat(parts[0]);
            if (val > winners[asset].max) {
                winners[asset] = { max: val, winner: params.from, trx_id: item.trx_id };
            } else if (val === winners[asset].max) {
                // Exact tie for the top burn → no one wins this block+asset.
                winners[asset] = { max: val, winner: null, trx_id: null };
            }
        }

        if (gonePast) break;
        const firstSeq = result[0][0];
        if (firstSeq === 0) break; // reached the beginning of null history
        start = firstSeq - 1;
        if (start < limit) limit = start;
        if (limit <= 0) break;
    }

    if (pages >= MAX_HISTORY_PAGES) {
        console.warn('(history pagination hit its safety cap — the block may be very old)');
    }
    return winners;
}

function renderHuman(outputs, blockNum) {
    const lines = [`Block ${blockNum}`];
    for (const o of outputs) {
        lines.push('');
        lines.push(`${o.asset}:`);
        lines.push(`  serial   : ${o.serial}`);
        if (o.trx_id) lines.push(`  trx_id   : ${o.trx_id}`);
        if (o.winner) lines.push(`  winner   : ${o.winner}`);
        lines.push(`  status   : ${o.status}`);
        if (o.className) lines.push(`  class    : ${o.className}`);
        lines.push(`  rarity   : ${o.rarity}`);
        lines.push(`  slot (rarity ${o.slotRange}) : ${o.slot}`);
        lines.push(`  slot (global 0-30) : ${o.slotPick ?? '-'}`);
        lines.push(`  species  : ${o.species === null || o.species === undefined ? '(none — card not released yet)' : o.species}`);
        if (o.card_id != null) lines.push(`  card_id  : ${o.card_id}`);
        if (o.note) lines.push(`  note     : ${o.note}`);
    }
    return lines.join('\n');
}

function buildOutput(asset, serial, trxId, winner, resolved, note) {
    const base = { asset, serial, status: note ? 'none' : resolved.status };
    if (resolved) {
        base.className = resolved.className;
        base.rarity = resolved.rarity;
        base.slot = resolved.slot;
        base.slotPick = resolved.slotPick;
        base.slotRange = slotRangeFor(resolved.rarity);
        base.species = resolved.card ? resolved.card.species : null;
        base.card_id = resolved.card ? resolved.card.card_id : null;
    } else {
        base.rarity = '-';
        base.slot = '-';
        base.slotPick = '-';
        base.slotRange = '-';
        base.species = '-';
    }
    if (trxId) base.trx_id = trxId;
    if (winner) base.winner = winner;
    if (note) base.note = note;
    return base;
}

async function main() {
    const args = parseArgs(process.argv);
    const config = loadConfig();
    const outputs = [];

    if (args.trxId) {
        // Manual mode — resolve locally, no network.
        const asset = args.asset || 'STEEM';
        const serial = serialFor(args.blockNum, asset);
        const resolved = await CardResolver.resolveCardForBlock(serial, args.trxId, config);
        outputs.push(buildOutput(asset, serial, args.trxId, null, resolved));
    } else {
        // Auto mode — fetch that block's burn winners from the chain.
        const winners = await fetchNullWinners(args.blockNum);
        const assets = args.asset ? [args.asset] : ASSETS;
        for (const asset of assets) {
            const w = winners[asset];
            if (!w.trx_id) {
                const note = Number.isFinite(w.max) ? 'tie for top burn → no unique winner' : 'no burn to null in this block';
                outputs.push(buildOutput(asset, serialFor(args.blockNum, asset), null, null, null, note));
                continue;
            }
            const serial = serialFor(args.blockNum, asset);
            const resolved = await CardResolver.resolveCardForBlock(serial, w.trx_id, config);
            outputs.push(buildOutput(asset, serial, w.trx_id, w.winner, resolved));
        }
    }

    console.log(args.json ? JSON.stringify(outputs, null, 2) : renderHuman(outputs, args.blockNum));
}

main().catch(err => {
    console.error(`Error: ${err && err.message ? err.message : err}`);
    process.exit(1);
});

