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
        } catch (e) {
            console.error("Failed to load cards config", e);
        }
    }

    async callSteem(method, params) {
        const payload = {
            jsonrpc: "2.0",
            method: method,
            params: params,
            id: 1
        };
        const response = await fetch(STEEM_API_URL, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        return data.result;
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

        // Step 2 — Fixed slot-based rarity selection per class.
        // Common: 16, Rare: 8, Epic: 4, Legendary: 2, Mythic: 1
        // This only depends on the hash and the fixed slot counts, so we
        // compute it before the classCards check so that every return path
        // (including classes with no cards at all) can report the rarity.
        const raritySlotCounts = {
            Common: 16,
            Rare: 8,
            Epic: 4,
            Legendary: 2,
            Mythic: 1
        };

        const rarityOrder = Object.keys(raritySlotCounts);
        let totalSlots = 0;
        const rarityRanges = {};
        for (const r of rarityOrder) {
            const count = raritySlotCounts[r];
            rarityRanges[r] = { start: totalSlots, end: totalSlots + count };
            totalSlots += count;
        }

        const slotPick = Number(hashInt % BigInt(totalSlots));
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

    // Fetch account history with time constraints
    async getAccountHistory(account, timeConstraintMs) {
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

                history.push(tx);
            }
            
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
