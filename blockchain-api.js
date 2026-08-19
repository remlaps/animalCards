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
            const res = await fetch('cards-config.json');
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
