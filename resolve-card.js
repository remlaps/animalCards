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
 * Without --trx-id the tool auto-fetches that block's burns from the Steem chain
 * (`condenser_api.get_account_history` for `null`) and derives each award via the
 * shared engine (card-resolver.js), driven by the config's `award_mode`.
 *
 * The resolution itself lives in the shared `card-resolver.js` module — the same
 * single source of truth used by the browser (`blockchain-api.js`).
 */
const fs = require('fs');
const path = require('path');
const CardResolver = require('./card-resolver.js');
const CardDifficulty = require('./difficulty.js');

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

// 0-based slot band (e.g. "0-7") for a rarity, from the active slot_layouts config.
function slotRangeFor(rarity, slotCounts) {
    const count = (slotCounts && slotCounts[rarity]) || CardResolver.DEFAULT_RARITY_SLOT_COUNTS[rarity];
    return count == null ? '-' : `0-${count - 1}`;
}

// Fetch every transfer to `null` in the given block (all burners, any amount).
// The award policy (who earns a card, who is downgraded) is then applied by the
// shared engine (card-resolver.js). Paginates the `null` account history
// newest-first and stops once it passes the target block.
async function fetchBlockBurns(blockNum) {
    const burns = [];
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
            if (parts.length !== 2 || ASSETS.indexOf(parts[1]) === -1) continue;
            burns.push({ account: params.from, block: blockNum, asset: parts[1], amount: parseFloat(parts[0]), trxId: item.trx_id });
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
    return burns;
}

function renderHuman(outputs, blockNum, totalSlots) {
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
        lines.push(`  slot (global 0-${totalSlots - 1}) : ${o.slotPick ?? '-'}`);
        lines.push(`  species  : ${o.species === null || o.species === undefined ? '(none — card not released yet)' : o.species}`);
        if (o.card_id != null) lines.push(`  card_id  : ${o.card_id}`);
        if (o.rarity_min_burn != null && o.rarity_min_burn > 0) lines.push(`  min burn : ${o.rarity_min_burn} (RABD)`);
        if (o.cascade) lines.push(`  cascade  : ${o.cascade}`);
        if (o.generic_reason) lines.push(`  generic  : ${o.generic_reason}`);
        if (o.note) lines.push(`  note     : ${o.note}`);
    }
    return lines.join('\n');
}

function buildOutput(asset, serial, trxId, winner, resolved, note, minBurns, slotCounts) {
    const base = { asset, serial, status: note ? 'none' : resolved.status };
    if (resolved) {
        base.className = resolved.className;
        base.rarity = resolved.rarity;
        base.slot = resolved.slot;
        base.slotPick = resolved.slotPick;
        base.slotRange = slotRangeFor(resolved.rarity, slotCounts);
        base.species = resolved.card ? resolved.card.species : null;
        base.card_id = resolved.card ? resolved.card.card_id : null;
        if (minBurns && minBurns[resolved.rarity] > 0) base.rarity_min_burn = minBurns[resolved.rarity];
        if (resolved.cascade) base.cascade = resolved.cascade;
        if (resolved.generic_reason) base.generic_reason = resolved.generic_reason;
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
    const slotCounts = CardResolver.getSlotLayoutForBlock(config.slot_layouts, args.blockNum);
    const totalSlots = slotCounts ? Object.keys(slotCounts).reduce((s, r) => s + slotCounts[r], 0) : 16;

    if (args.trxId) {
        // Manual mode — resolve locally, no network.
        const asset = args.asset || 'STEEM';
        const serial = serialFor(args.blockNum, asset);
        const resolved = await CardResolver.resolveCardForBlock(serial, args.trxId, config);
        outputs.push(buildOutput(asset, serial, args.trxId, null, resolved, null, null, slotCounts));
    } else {
        // Auto mode — fetch that block's burns and derive awards via the engine
        // (policy driven by the config's award_mode).
        const burns = await fetchBlockBurns(args.blockNum);
        const mode = config.award_mode || 'all_burns';
        const assets = args.asset ? [args.asset] : ASSETS;
        // Effective per-rarity minimum burns for this block (RABD). All zeroes
        // when rarity_difficulty is absent or disabled → nothing is gated.
        const effBurns = CardDifficulty.effectiveMinBurns(args.blockNum, config);
        const awards = CardResolver.deriveBurnAwards(burns, { mode });
        for (const asset of assets) {
            const assetAwards = awards.filter(a => a.asset === asset);
            if (assetAwards.length === 0) {
                outputs.push(buildOutput(asset, serialFor(args.blockNum, asset), null, null, null, 'no burn to null in this block', null, slotCounts));
                continue;
            }
            for (const a of assetAwards) {
                const constraints = { rarity_min_burn: effBurns, winning_burn_amount: a.amount, downgrade: a.downgrade };
                const resolved = await CardResolver.resolveCardForBlock(a.serial, a.trxId, config, constraints);
                outputs.push(buildOutput(asset, a.serial, a.trxId, a.account, resolved, null, effBurns, slotCounts));
            }
        }
    }

    console.log(args.json ? JSON.stringify(outputs, null, 2) : renderHuman(outputs, args.blockNum, totalSlots));
}

main().catch(err => {
    console.error(`Error: ${err && err.message ? err.message : err}`);
    process.exit(1);
});

