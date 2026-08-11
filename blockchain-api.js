const STEEM_API_URL = 'https://api.steemit.com';
const SDS_API_URL = 'https://sds.steemworld.org';

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
            this.beneficiaries = config.beneficiaries || {};
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

    // Compute the deterministic SHA-256 hash integer for a serial + block hash
    async hashForSerial(serialNumber, blockHash) {
        const encoder = new TextEncoder();
        const data = encoder.encode(`${serialNumber}:${blockHash}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return BigInt("0x" + hashArray.map(b => b.toString(16).padStart(2, '0')).join(''));
    }

        // Resolve the card a BurnMax winner receives, deterministically.
    // Step 1: pick an animal class by weighted percentage (class_weights).
    // Step 2: pick a rarity slot from a fixed pool. The slot counts are
    //         hard-coded so they never change when cards are added or
    //         removed — Common gets the most slots, Mythic the fewest.
    //         Inserting a new card with the next card_id only extends
    //         the slot-to-card mapping at the tail, leaving every earlier
    //         block resolution intact.
    // Step 3: the slot index within the rarity range maps directly to a
    //         released card (sorted by card_id). If the slot exceeds the
    //         number of released cards, the class generic card wins.
    async resolveCardForBlock(serialNumber, blockHash) {
        const hashInt = await this.hashForSerial(serialNumber, blockHash);

        // Step 1 — Class allocation over 0..99 (weights must sum to 100).
        const offset = Number(hashInt % 100n);
        let className = null;
        let classStart = 0;
        for (let i = 0; i < this.classOrder.length; i++) {
            const weight = this.classWeights[i];
            if (offset < classStart + weight) {
                className = this.classOrder[i];
                break;
            }
            classStart += weight;
        }
        if (!className) {
            // Safety fallback (weights don't sum to 100): last class.
            className = this.classOrder[this.classOrder.length - 1];
            classStart = 100 - (this.classWeights[this.classWeights.length - 1] || 0);
        }

        const classCards = this.cardsConfig.filter(c => c.class === className);
        const generic = classCards.find(c => c.is_generic);

        // Step 2 — Fixed slot-based rarity selection per class, weighted.
        // Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1 (slot counts).
        // EACH slot is then weighted by its rarity multiplier (16/8/4/2/1), so a
        // Common slot is 16x more likely than a Mythic slot and 2x more likely
        // than a Rare slot. This gives the "two dimensions of scarcity":
        //   (1) more species exist at lower rarities (the slot counts above),
        //   (2) lower-rarity slots are more likely to be chosen (the weight).
        // Total weight = 16*16 + 8*8 + 4*4 + 2*2 + 1*1 = 341. It only depends
        // on the hash and the fixed slot counts/weights, so we compute it
        // before the classCards check so that every return path (including
        // classes with no cards at all) can report the rarity.
        const raritySlotCounts = {
            Common: 16,
            Rare: 8,
            Epic: 4,
            Legendary: 2,
            Mythic: 1
        };
        const rarityWeight = {
            Common: 16,
            Rare: 8,
            Epic: 4,
            Legendary: 2,
            Mythic: 1
        };

        const rarityOrder = Object.keys(raritySlotCounts);
        const rarityRanges = {};
        const slotWeights = [];   // one entry (the rarity multiplier) per slot
        let totalSlots = 0;
        let totalWeight = 0;
        for (const r of rarityOrder) {
            const count = raritySlotCounts[r];
            rarityRanges[r] = { start: totalSlots, end: totalSlots + count };
            for (let i = 0; i < count; i++) {
                slotWeights.push(rarityWeight[r]);
            }
            totalSlots += count;
            totalWeight += count * rarityWeight[r];
        }

        // Weighted pick over the 31 slots: each slot contributes rarityWeight
        // to the cumulative range. pickWeight is uniform over [0, totalWeight),
        // so higher-weight (lower-rarity) slots are chosen more often.
        const pickWeight = Number(hashInt % BigInt(totalWeight));
        let slotPick = null;
        let acc = 0;
        for (let i = 0; i < slotWeights.length; i++) {
            acc += slotWeights[i];
            if (pickWeight < acc) {
                slotPick = i;
                break;
            }
        }
        // Safety fallback (only reachable if totalWeight mismatches the loop).
        if (slotPick === null) slotPick = totalSlots - 1;

        const selectedRarity = rarityOrder.find(
            r => slotPick >= rarityRanges[r].start && slotPick < rarityRanges[r].end
        );

        // No species released for this class at all yet.
        if (classCards.length === 0) {
            return { status: 'none', className, rarity: selectedRarity, card: null };
        }

        // Step 3 — Map the slot to a specific released card of the selected
        // rarity. Cards are sorted by card_id so that appending a new card
        // (with the next card_id) only extends the mapping at the tail.
        const released = classCards
            .filter(c => !c.is_generic && c.rarity === selectedRarity)
            .sort((a, b) => a.card_id - b.card_id);

        const slotInRarity = slotPick - rarityRanges[selectedRarity].start;

        if (released.length === 0) {
            // No released cards yet for this class; generic wins.
            if (generic) {
                return { status: 'generic', className, rarity: selectedRarity, card: generic };
            }
            return { status: 'none', className, rarity: selectedRarity, card: null };
        }

        if (slotInRarity < released.length) {
            const selected = released[slotInRarity];
            return {
                status: selected.is_generic ? 'generic' : 'released',
                className,
                rarity: selectedRarity,
                card: selected
            };
        }

        // Slot is beyond the number of released cards; generic wins.
        if (generic) {
            return { status: 'generic', className, rarity: selectedRarity, card: generic };
        }
        return { status: 'none', className, rarity: selectedRarity, card: null };
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

    // Fetch with a timeout so a hung request rejects instead of spinning forever.
    async fetchWithTimeout(url, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } finally {
            clearTimeout(timer);
        }
    }

    // SteemWorld SDS: fetch transfers of `type` from `from` to `to`.
    // Returns { cols, rows } where each row is [time, from, to, amount, unit, memo].
    // Rows are ordered by time (DESC by default). Paginate with limit (<=1000) & offset.
    async getTransfersByTypeFromTo(type, from, to, orderBy, orderDir, limit, offset) {
        const oBy = orderBy || 'time';
        const oDir = orderDir || 'DESC';
        const lim = limit || 1000;
        const off = offset || 0;
        const url = `${SDS_API_URL}/transfers_api/getTransfersByTypeFromTo/${type}/${from}/${to}/${oBy}/${oDir}/${lim}/${off}`;
        const res = await this.fetchWithTimeout(url, 15000);
        const data = await res.json();
        if (data.code !== 0) throw new Error(data.msg || 'SteemWorld SDS transfers error');
        return data.result;
    }

    // SteemWorld SDS: get the nearest block number for a given timestamp (seconds).
    // Retries transient failures (the endpoint rate-limits when hammered), then throws
    // so the caller can fall back to the null-account history.
    async getBlockNumByTime(timestamp, retries = 3) {
        const url = `${SDS_API_URL}/chain_api/getBlockInfoByTime/${timestamp}`;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await this.fetchWithTimeout(url, 10000);
                const data = await res.json();
                if (data.code !== 0) throw new Error(data.msg || 'SteemWorld SDS block-by-time error');
                return data.result.block_num;
            } catch (e) {
                if (attempt === retries) throw e;
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
        }
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
            }

            // Report live progress (e.g. number of history operations scanned so far)
            if (onProgress) onProgress(history.length);
            
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
