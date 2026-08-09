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
    // Step 1: pick a class by weighted percentage (35/30/15/12/5/3).
    // Step 2: within the class, pick a species slot. Only if a species card
    //         for that slot exists in config is the actual card issued.
    //         Otherwise fall back to a generic class card, or to "none" if
    //         the class has no card at all yet.
    async resolveCardForBlock(serialNumber, blockHash) {
        const hashInt = await this.hashForSerial(serialNumber, blockHash);

        // Class allocation over 0..99 (weights must sum to 100).
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

        // Position within the class (0..classWeight-1); the species slot.
        const local = offset - classStart;

        const classCards = this.cardsConfig.filter(c => c.class === className);
        const generic = classCards.find(c => c.is_generic);
        const released = classCards
            .filter(c => !c.is_generic)
            .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

        // A species is released only if its slot index is below the number of
        // released species in this class (species are unlocked in slot order).
        if (local < released.length) {
            return { status: 'released', className, card: released[local] };
        }
        if (generic) {
            return { status: 'generic', className, card: generic };
        }
        return { status: 'none', className, card: null };
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
