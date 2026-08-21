const STEEM_API_URL = 'https://api.steemit.com';

class BlockchainAPI {
    constructor() {
        this.cardsConfig = [];
        this.classWeights = [];
        this.classOrder = [];
        this.loadConfig();
    }

    async loadConfig() {
        try {
            const res = await fetch('cards-config.json?v=' + Date.now());
            const config = await res.json();
                        this.cardsConfig = config.cards || [];
            this.classOrder = Object.keys(config.class_weights || {});
            this.classWeights = this.classOrder.map(c => config.class_weights[c]);
            this.classWeightsObj = config.class_weights || {};
            this.beneficiaries = config.beneficiaries || {};
            this.rawConfig = config; // full config (used for rarity_difficulty / RABD)
        } catch (e) {
            console.error("Failed to load cards config", e);
        }
    }

    async callSteem(method, params, retries = 3) {
        const payload = {
            jsonrpc: "2.0",
            method: method,
            params: params,
            id: 1
        };
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetch(STEEM_API_URL, {
                    method: 'POST',
                    body: JSON.stringify(payload),
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!response.ok) {
                    // 429/5xx are transient; let the retry loop handle them.
                    throw new Error(`HTTP ${response.status}`);
                }
                let data;
                try {
                    data = await response.json();
                } catch (e) {
                    // Empty or non-JSON body (e.g. a proxy/rate-limit page) — retry.
                    throw new Error(`Invalid JSON response for ${method}`);
                }
                if (data.error) throw new Error(data.error.message);
                return data.result;
            } catch (e) {
                lastErr = e;
                if (attempt === retries) break;
                // AbortController is not available in some very old runtimes; guard it.
                await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            }
        }
        throw lastErr;
    }

    // Deterministic hashing and resolution now live in the shared
    // `card-resolver` module (single source of truth). card-resolver.js is
    // loaded before this file and exposes the global `CardResolver`.
    async hashForSerial(serialNumber, blockHash) {
        return CardResolver.hashForSerial(serialNumber, blockHash);
    }

    async resolveCardForBlock(serialNumber, blockHash, opts) {
        opts = opts || {};
        let constraints = null;
        // RABD: if rarity_difficulty is configured, pass the effective per-rarity
        // minimum burns + this block's winning burn amount so the resolver can
        // cascade a below-threshold award down to a qualifying rarity.
        if (this.rawConfig && this.rawConfig.rarity_difficulty) {
            const blockNum = parseInt(String(serialNumber).split('.')[0], 10);
            constraints = {
                rarity_min_burn: this.getEffectiveMinBurns(blockNum, opts.countsProvider) || {},
                winning_burn_amount: opts.winningBurnAmount
            };
        }
        return CardResolver.resolveCardForBlock(serialNumber, blockHash, {
            cards: this.cardsConfig,
            class_weights: this.classWeightsObj
        }, constraints);
    }

    // Effective per-rarity minimum burns for a block (RABD). Delegates to the
    // shared difficulty.js module. Returns the standard shape even when
    // rarity_difficulty is absent/disabled (all zeroes → nothing is gated).
    getEffectiveMinBurns(blockNum, countsProvider) {
        if (!this.rawConfig) return null;
        return CardDifficulty.effectiveMinBurns(blockNum, this.rawConfig, countsProvider);
    }
    getEffectiveMinBurns(blockNum, countsProvider) {
        if (!this.rawConfig) return null;
        return CardDifficulty.effectiveMinBurns(blockNum, this.rawConfig, countsProvider);
    }

    // Current chain head block via dynamic global properties.
    async getCurrentBlock() {
        const props = await this.callSteem('condenser_api.get_dynamic_global_properties', []);
        return parseInt(props.head_block_number, 10);
    }

    // Everything a difficulty-dashboard UI needs for one block: per-rarity
    // effective minimum burns and the block at which difficulty next actually
    // changes. "Next adjustment" is the earliest of (a) the next schedule
    // milestone that alters effective minimums, and (b) the next demand-window
    // boundary — the latter only when a >1 difficulty multiplier is currently
    // in force (with a flat 1.0 difficulty the window boundary changes nothing,
    // and with countsProvider unwired no demand multiplier is computed anyway).
    // Returns null when rarity_difficulty is absent from the config.
    getDifficultyDashboard(blockNum) {
        const rd = this.rawConfig && this.rawConfig.rarity_difficulty;
        if (!rd) return null;
        const conf = CardDifficulty.normalize(this.rawConfig);
        const enabled = rd.enabled_block != null;
        const minBurns = this.getEffectiveMinBurns(blockNum) || {};
        const windowBlocks = Number(rd.window_blocks) || 0;
        const nextWindow = windowBlocks > 0
            ? Math.ceil(blockNum / windowBlocks) * windowBlocks
            : null;

        const rarities = CardDifficulty.VALID_RARITIES
            || ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];

        // Any rarity currently scaled by a difficulty multiplier > 1?
        const multiplierActive = enabled && rarities.some(r =>
            (CardDifficulty.scheduleMultiplier(conf, blockNum, r) || 1) > 1
        );

        // The earliest future block at which the effective minimums actually
        // change. Multiplier milestones apply at their window boundary
        // (`ceil(block/window)*window`) — so even a milestone whose raw block is
        // already past counts if its anchored boundary is still ahead.
        // base_min_burns floors apply at the milestone block itself. Window
        // boundaries also matter once a >1 multiplier is already in force
        // (that is when demand re-adjusts).
        let nextAdjustmentBlock = null;
        if (enabled) {
            const candidates = [];
            if (multiplierActive && nextWindow != null) candidates.push(nextWindow);

            const win = windowBlocks;
            for (const m of conf.schedule) {
                let pts = [];
                if (m.multiplier != null || m.multipliers) {
                    const b = win > 0 ? Math.ceil(m.block / win) * win : m.block;
                    if (b > blockNum) pts.push(b);
                }
                if (m.base_min_burns && m.block > blockNum) pts.push(m.block); // floors immediate
                if (m.targets && !(m.multiplier != null || m.multipliers) && m.block > blockNum) pts.push(m.block);
                for (const b of new Set(pts)) {
                    const before = CardDifficulty.effectiveMinBurns(Math.max(blockNum, b - 1), this.rawConfig);
                    const after = CardDifficulty.effectiveMinBurns(b, this.rawConfig);
                    const changed = rarities.some(r2 => (after[r2] || 0) !== (before[r2] || 0));
                    if (changed) { candidates.push(b); break; }
                }
            }
            if (candidates.length) nextAdjustmentBlock = Math.min(...candidates);
        }

        return {
            enabled: enabled,
            enabledBlock: rd.enabled_block,
            currentBlock: blockNum,
            minBurns: minBurns,
            windowBlocks: windowBlocks,
            multiplierActive: multiplierActive,
            nextWindowBlock: nextWindow,
            nextAdjustmentBlock: nextAdjustmentBlock,
            blocksRemaining: nextAdjustmentBlock != null
                ? Math.max(0, nextAdjustmentBlock - blockNum)
                : null
        };
    }

    // Fetch block data to verify winners in a specific block
    async getBlock(blockNum) {
        return await this.callSteem('condenser_api.get_block', [blockNum]);
    }

    // Fetch account metadata (e.g. creation time) for a list of account names.
    // Returns an array of account objects; each has a `created` ISO timestamp.
    async getAccounts(names) {
        return await this.callSteem('condenser_api.get_accounts', [names]);
    }

    // Fetch account history with time constraints.
    // Paginates back from the present (newest first).
    //   timeConstraintMs - optional window: stop when an op is older than this
    //                      many milliseconds before now.
    //   earliestTimeMs   - optional absolute lower bound (ms epoch): stop when an
    //                      op is older than this timestamp. Used to bound the scan
    //                      by an account's creation time, so we never paginate
    //                      further back than the account could have existed.
    async getAccountHistory(account, timeConstraintMs, earliestTimeMs, onProgress) {
        let history = [];
        let start = -1;
        let limit = 100;
        let keepFetching = true;
        const now = Date.now();
        let frontierTs = null; // raw timestamp of the oldest history op scanned so far

        while (keepFetching) {
            const result = await this.callSteem('condenser_api.get_account_history', [account, start, limit]);
            if (!result || result.length === 0) break;

            for (let i = result.length - 1; i >= 0; i--) {
                const [seq, tx] = result[i];
                const txTime = new Date(tx.timestamp + "Z").getTime();

                if (timeConstraintMs && (now - txTime) > timeConstraintMs) {
                    keepFetching = false;
                    break;
                }

                if (earliestTimeMs && txTime < earliestTimeMs) {
                    keepFetching = false;
                    break;
                }

                history.push(tx);
                frontierTs = tx.timestamp;
            }

            // Report live progress (e.g. number of history operations scanned so far)
            if (onProgress) onProgress(history.length, frontierTs);
            
            // if we need to paginate further backwards
            if (keepFetching && result.length > 0) {
                const firstSeq = result[0][0];
                if (firstSeq === 0) break; // Reached beginning of history
                start = firstSeq - 1;
                // Avoid asking for a limit greater than the start index
                if (start < limit) limit = start;
            }
        }
        return history;
    }
}

const api = new BlockchainAPI();

// Render the RABD difficulty dashboard into `#difficulty-dashboard` (if present).
// Shared by leaderboard.html and search.html. The element is a left sidebar
// panel: title · per-rarity minimums · current block · next adjustment (only
// when it actually matters). Silently hides itself if the config has no
// rarity_difficulty block or the element is missing.
async function renderDifficultyDashboard() {
    const el = document.getElementById('difficulty-dashboard');
    if (!el) return;
    const show = () => { el.classList.add('show'); el.style.display = ''; };
    const hide = () => { el.classList.remove('show'); el.style.display = 'none'; };
    try {
        if (!api.rawConfig) await api.loadConfig();
        const currentBlock = await api.getCurrentBlock();
        const info = api.getDifficultyDashboard(currentBlock);
        if (!info) { hide(); return; }

        // "3d 2h" / "5h 10m" / "~12m" / "~8y 3d" from a block count (Steem ~3s/block)
        const fmtDuration = blocks => {
            const s = blocks * 3;
            const y = Math.floor(s / 31536000);
            const d = Math.floor((s % 31536000) / 86400);
            const h = Math.floor((s % 86400) / 3600);
            const m = Math.floor((s % 3600) / 60);
            if (y > 0) return `~${y}y ${d}d`;
            if (d > 0) return `~${d}d ${h}h`;
            if (h > 0) return `~${h}h ${m}m`;
            return `~${m}m`;
        };
        const fmt = v => Number(v).toFixed(3).replace(/\.?0+$/, '') || '0';

        const rarities = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];

        // Header: title left, current block right
        const head = `
            <div class="dash-head">
                <span class="dash-title">Burn Difficulty</span>
                <span class="dash-block">⛓ <b>#${currentBlock.toLocaleString()}</b></span>
            </div>`;

        // Body: slim vertical table (name-left / value-right, aligned as a grid)
        let body;
        if (!info.enabled) {
            body = `<p class="dash-note">not yet activated</p>`;
        } else {
            body = `<div class="dash-table">` + rarities.map(r =>
                `<i class="dash-dot" data-r="${r.toLowerCase()}"></i>` +
                `<span class="dash-name">${r}</span>` +
                `<span class="dash-val">${fmt(info.minBurns[r] || 0)}</span>`
            ).join('') + `</div>`;
        }

        // Footer: next adjustment — only when one is actually scheduled
        const foot = info.nextAdjustmentBlock != null
            ? `<div class="dash-foot">Next adjustment
                    <b>#${info.nextAdjustmentBlock.toLocaleString()}</b>
                    <span class="dash-in">· ${fmtDuration(info.blocksRemaining)}</span></div>`
            : '';

        el.innerHTML = head + body + foot;
        show();
    } catch (e) {
        console.error('Difficulty dashboard failed:', e);
        hide();
    }
}
