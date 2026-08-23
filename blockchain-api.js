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
        // The serial number suffix (".0" = STEEM, ".1" = SBD) selects which
        // asset's minimums apply.
        if (this.rawConfig && this.rawConfig.rarity_difficulty) {
            const blockNum = parseInt(String(serialNumber).split('.')[0], 10);
            const parts = String(serialNumber).split('.');
            const isSbd = parts.length > 1 && parts[1] === '1';
            const minBurns = isSbd
                ? (this.getEffectiveMinBurnsSBD(blockNum) || {})
                : (this.getEffectiveMinBurns(blockNum) || {});
            constraints = {
                rarity_min_burn: minBurns,
                winning_burn_amount: opts.winningBurnAmount
            };
        }
        // Always apply the tie flag if present (works with or without RABD).
        if (opts.tie) {
            if (!constraints) constraints = {};
            constraints.tie = true;
        }
        return CardResolver.resolveCardForBlock(serialNumber, blockHash, {
            cards: this.cardsConfig,
            class_weights: this.classWeightsObj,
            slot_layouts: this.rawConfig ? this.rawConfig.slot_layouts : null
        }, constraints);
    }

    // Effective per-rarity minimum burns for a block (RABD). Delegates to the
    // shared difficulty.js module. Returns the standard shape even when
    // rarity_difficulty is absent/disabled (all zeroes → nothing is gated).
    getEffectiveMinBurns(blockNum) {
        if (!this.rawConfig) return null;
        return CardDifficulty.effectiveMinBurns(blockNum, this.rawConfig);
    }

    // Same but for SBD asset minimums.
    getEffectiveMinBurnsSBD(blockNum) {
        if (!this.rawConfig) return null;
        return CardDifficulty.effectiveMinBurnsSBD(blockNum, this.rawConfig);
    }

    // Current chain head block via dynamic global properties.
    async getCurrentBlock() {
        const props = await this.callSteem('condenser_api.get_dynamic_global_properties', []);
        return parseInt(props.head_block_number, 10);
    }

    // Everything a difficulty-dashboard UI needs for one block: per-rarity
    // effective minimum burns and the block at which a floor-adjustment
    // schedule milestone kicks in. Returns null when rarity_difficulty is absent.
    getDifficultyDashboard(blockNum) {
        const rd = this.rawConfig && this.rawConfig.rarity_difficulty;
        if (!rd) return null;
        const conf = CardDifficulty.normalize(this.rawConfig);
        // Earliest future schedule milestone that actually changes floors for
        // either asset (STEEM or SBD). Checks both base_min_burns and
        // base_min_burns_sbd, so a milestone that only touches SBD is found.
        let nextFloorBlock = null;
        const currentSteem = this.getEffectiveMinBurns(blockNum) || {};
        const currentSbd = this.getEffectiveMinBurnsSBD(blockNum) || {};
        for (const m of conf.schedule) {
            if (m.block <= blockNum) continue;
            if (!m.base_min_burns_steem && !m.base_min_burns_sbd) continue;
            const afterSteem = CardDifficulty.effectiveMinBurns(m.block, this.rawConfig);
            const afterSbd = CardDifficulty.effectiveMinBurnsSBD(m.block, this.rawConfig);
            const changed = Object.keys(currentSteem).some(
                r => (afterSteem[r] || 0) !== (currentSteem[r] || 0)
                  || (afterSbd[r] || 0) !== (currentSbd[r] || 0)
            );
            if (changed) { nextFloorBlock = m.block; break; }
        }
        return {
            enabled: rd.enabled_block != null,
            enabledBlock: rd.enabled_block,
            currentBlock: blockNum,
            minBurnsSteem: currentSteem,
            minBurnsSbd: currentSbd,
            nextFloorBlock: nextFloorBlock,
            blocksRemaining: nextFloorBlock != null ? Math.max(0, nextFloorBlock - blockNum) : null
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

        const rarities = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
        const fmt = v => Number(v).toFixed(3).replace(/\.?0+$/, '') || '0';
        const fmtDuration = blocks => {
            const s = blocks * 3;
            const d = Math.floor(s / 86400);
            const h = Math.floor((s % 86400) / 3600);
            const m = Math.floor((s % 3600) / 60);
            if (d > 0) return `~${d}d ${h}h`;
            if (h > 0) return `~${h}h ${m}m`;
            return `~${m}m`;
        };
        const fmtRange = (s, sb) => `${fmt(s)} / ${fmt(sb)}`;

        const head = `<div class="dash-head">
                <span class="dash-title">Burn Minimums</span>
            </div>`;

        let body;
        if (!info.enabled) {
            body = `<p class="dash-note">not yet activated</p>`;
        } else {
            body = `<div class="dash-table">` +
                `<span class="dash-colhead" style="grid-column: 2 / -1; text-align: right;">STEEM / SBD</span>` +
                rarities.map(r =>
                `<i class="dash-dot" data-r="${r.toLowerCase()}"></i>` +
                `<span class="dash-name">${r}</span>` +
                `<span class="dash-val">${fmtRange(info.minBurnsSteem[r], info.minBurnsSbd[r])}</span>`
            ).join('') + `</div>`;
        }

        const foot = info.nextFloorBlock != null
            ? `<div class="dash-foot">Next floor adjustment
                    <b>#${info.nextFloorBlock.toLocaleString()}</b>
                    <span class="dash-in">· ${fmtDuration(info.blocksRemaining)}</span></div>`
            : '';

        el.innerHTML = head + body + foot;
        show();
    } catch (e) {
        console.error('Difficulty dashboard failed:', e);
        hide();
    }
}
