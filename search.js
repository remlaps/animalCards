document.addEventListener('DOMContentLoaded', async () => {
    const searchForm = document.getElementById('search-form');
    const accountInput = document.getElementById('account-input');
    const timeFilter = document.getElementById('time-filter');
    const loading = document.getElementById('loading');
    const content = document.getElementById('search-content');
    const header = document.getElementById('portfolio-header');
    const stats = document.getElementById('portfolio-stats');
    const grid = document.getElementById('portfolio-grid');

    // Default to the user's input if coming from another page with a query param? Optional.

    searchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const account = accountInput.value.trim().toLowerCase();
        if (!account) return;

        const timeConstraint = parseInt(timeFilter.value, 10);
        
        loading.style.display = 'flex';
        content.style.display = 'none';
        grid.innerHTML = '';

        try {
            if (api.cardsConfig.length === 0) {
                await api.loadConfig();
            }

            const history = await api.getAccountHistory(account, timeConstraint);
            
            const wonCards = [];
            let totalBurned = 0;

            const blocksToCheck = {};

            for (const item of history) {
                const op = item.op;
                // Look for transfers made by this account to null
                if (op[0] === 'transfer' && op[1].from === account && op[1].to === 'null') {
                    const amountStr = op[1].amount;
                    const [amountValStr, asset] = amountStr.split(' ');
                    const val = parseFloat(amountValStr);

                    if (!blocksToCheck[item.block]) {
                        blocksToCheck[item.block] = { STEEM: 0, SBD: 0, trx_ids: { STEEM: item.trx_id, SBD: item.trx_id }, timestamp: item.timestamp };
                    }
                    blocksToCheck[item.block][asset] += val;
                    blocksToCheck[item.block].trx_ids[asset] = item.trx_id; // Just keep the latest trx_id seen
                }
            }

            // Verify each block against all other users in that block
            const blockNums = Object.keys(blocksToCheck).sort((a, b) => b - a); // Newest blocks first
            
            for (const blockNum of blockNums) {
                const userBurn = blocksToCheck[blockNum];
                totalBurned += userBurn.STEEM + userBurn.SBD;

                const blockData = await api.getBlock(blockNum);
                const blockBurners = { STEEM: {}, SBD: {} };

                if (blockData && blockData.transactions) {
                    for (const tx of blockData.transactions) {
                        for (const op of tx.operations) {
                            if (op[0] === 'transfer' && op[1].to === 'null') {
                                const from = op[1].from;
                                const [valStr, asset] = op[1].amount.split(' ');
                                const val = parseFloat(valStr);
                                if (!blockBurners[asset][from]) blockBurners[asset][from] = 0;
                                blockBurners[asset][from] += val;
                            }
                        }
                    }
                }

                // Verify STEEM Winner
                if (userBurn.STEEM > 0) {
                    let maxSTEEM = 0;
                    let steemWinner = null;
                    for (const [burner, amount] of Object.entries(blockBurners.STEEM)) {
                        if (amount > maxSTEEM) { maxSTEEM = amount; steemWinner = burner; }
                    }
                    if (steemWinner === account) {
                        const serial = `${blockNum}.0`;
                        const resolved = await api.resolveCardForBlock(serial, userBurn.trx_ids.STEEM);
                        wonCards.push({
                            status: resolved.status,
                            className: resolved.className,
                            card: resolved.card,
                            block: blockNum,
                            trx_id: userBurn.trx_ids.STEEM,
                            serial: serial,
                            timestamp: userBurn.timestamp
                        });
                    }
                }

                // Verify SBD Winner
                if (userBurn.SBD > 0) {
                    let maxSBD = 0;
                    let sbdWinner = null;
                    for (const [burner, amount] of Object.entries(blockBurners.SBD)) {
                        if (amount > maxSBD) { maxSBD = amount; sbdWinner = burner; }
                    }
                    if (sbdWinner === account) {
                        const serial = `${blockNum}.1`;
                        const resolved = await api.resolveCardForBlock(serial, userBurn.trx_ids.SBD);
                        wonCards.push({
                            status: resolved.status,
                            className: resolved.className,
                            card: resolved.card,
                            block: blockNum,
                            trx_id: userBurn.trx_ids.SBD,
                            serial: serial,
                            timestamp: userBurn.timestamp
                        });
                    }
                }
            }

            header.textContent = `Portfolio for @${account}`;
            const cardsCollected = wonCards.filter(m => m.status !== 'none').length;
            stats.innerHTML = `Total tokens burned in timeframe: <strong>${totalBurned.toFixed(3)}</strong> | Cards Collected: <strong>${cardsCollected}</strong>`;

            if (wonCards.length === 0) {
                grid.innerHTML = '<p class="status-message" style="grid-column: 1/-1;">No cards found for this account in the selected timeframe.</p>';
            } else {
                // Reverse so newest are first
                wonCards.forEach(mint => {
                    const cardEl = document.createElement('div');
                    cardEl.className = 'tribute-card';
                    if (mint.status === 'none') {
                        cardEl.innerHTML = `
                            <div class="card-image-container pending-card-image">
                                <span class="pending-icon">✦</span>
                            </div>
                            <div class="card-content">
                                <div class="card-class">${mint.className} • Awaiting Release</div>
                                <h3 class="card-species pending-card-species">Card Not Released Yet</h3>
                                <div class="card-meta">
                                    <span style="font-size:0.75rem;">Serial: <strong style="color:var(--text-primary);">${mint.serial}</strong></span>
                                    <span class="verify-badge" title="Hash: ${mint.trx_id}">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                                        Verified
                                    </span>
                                </div>
                            </div>
                        `;
                    } else {
                        cardEl.innerHTML = `
                            <div class="card-image-container">
                                <img src="${mint.card.image_url}" alt="${mint.card.species}" class="card-image">
                            </div>
                            <div class="card-content">
                                <div class="card-class">${mint.card.class} • ${mint.card.rarity}</div>
                                <h3 class="card-species">${mint.card.species}</h3>
                                ${mint.card.is_generic ? '<p style="color: var(--text-secondary); font-size: 0.8rem; font-style: italic; margin-top: 0.25rem;">A specific species will be released in the future.</p>' : ''}
                                <p class="card-attribution">Generation: ${mint.card.generation} • Photo by ${mint.card.photo_credit}</p>
                                <div class="card-meta">
                                    <span style="font-size:0.75rem;">Serial: <strong style="color:var(--text-primary);">${mint.serial}</strong></span>
                                    <span class="verify-badge" title="Hash: ${mint.trx_id}">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                                        Verified
                                    </span>
                                </div>
                            </div>
                        `;
                    }
                    grid.appendChild(cardEl);
                });
            }

            loading.style.display = 'none';
            content.style.display = 'block';

        } catch (error) {
            console.error(error);
            loading.innerHTML = `<p class="status-message" style="color: #ef4444;">Error searching account: ${error.message}</p>`;
        }
    });
});
