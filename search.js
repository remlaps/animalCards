document.addEventListener('DOMContentLoaded', async () => {
    const searchForm = document.getElementById('search-form');
    const accountInput = document.getElementById('account-input');
    const timeFilter = document.getElementById('time-filter');
    const loading = document.getElementById('loading');
    const content = document.getElementById('search-content');
    const header = document.getElementById('portfolio-header');
    const stats = document.getElementById('portfolio-stats');
    const summaryContainer = document.getElementById('portfolio-summary');
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
                            account: account,
                            status: resolved.status,
                            className: resolved.className,
                            rarity: resolved.rarity,
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
                            account: account,
                            status: resolved.status,
                            className: resolved.className,
                            rarity: resolved.rarity,
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

            // Build summary breakout by species & rarity (includes placeholders & generic cards).
            // Generic cards are broken out by their individual slot rarity, so a
            // "Generic Bird" that won Common, Rare, and Mythic slots shows as 3 rows.
            const rarityRank = { Common: 0, Rare: 1, Epic: 2, Legendary: 3, Mythic: 4 };
            const summaryMap = new Map();
            for (const m of wonCards) {
                let label, cls, rarity;
                if (m.status === 'none') {
                    // Placeholder — no card released yet for this class/rarity slot.
                    label = `${m.className} — placeholder`;
                    cls = m.className;
                    rarity = m.rarity;
                } else {
                    label = m.card.species;
                    cls = m.card.class;
                    rarity = m.status === 'generic' ? m.rarity : m.card.rarity;
                }
                const key = `${cls}|${label}|${rarity}`;
                if (!summaryMap.has(key)) {
                    summaryMap.set(key, { label, cls, rarity, count: 0 });
                }
                summaryMap.get(key).count++;
            }
            const summaryRows = Array.from(summaryMap.values());
            const totalCards = summaryRows.reduce((sum, r) => sum + r.count, 0);

            // Sortable column configuration.
            const summaryColumns = [
                { key: 'label', label: 'Species', type: 'string' },
                { key: 'cls', label: 'Class', type: 'string' },
                { key: 'rarity', label: 'Rarity', type: 'rarity' },
                { key: 'count', label: 'Count', type: 'number' }
            ];
            let summarySortKey = 'rarity';
            let summarySortDir = 'desc';

            const compareSummary = (a, b, key, dir) => {
                const col = summaryColumns.find(c => c.key === key);
                let val;
                if (col.type === 'rarity') {
                    val = (rarityRank[a[key]] ?? -1) - (rarityRank[b[key]] ?? -1);
                } else if (col.type === 'number') {
                    val = a[key] - b[key];
                } else {
                    val = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
                }
                return dir === 'asc' ? val : -val;
            };

            const renderSummary = () => {
                const sorted = [...summaryRows].sort((a, b) => {
                    const v = compareSummary(a, b, summarySortKey, summarySortDir);
                    if (v !== 0) return v;
                    // Stable tie-break: rarity desc, then count desc.
                    return (rarityRank[b.rarity] ?? -1) - (rarityRank[a.rarity] ?? -1) || b.count - a.count;
                });
                const arrow = summarySortDir === 'asc' ? ' ▲' : ' ▼';
                summaryContainer.innerHTML = `
                <h4 style="font-family: 'Outfit'; font-size: 1.1rem; margin-bottom: 0.75rem;">Collected Cards Summary</h4>
                <div style="overflow-x: auto;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
                        <thead>
                            <tr style="text-align: left; border-bottom: 2px solid var(--text-secondary, #888);">
                                ${summaryColumns.map(col => `
                                    <th data-sort="${col.key}" style="padding: 0.5rem 0.75rem; cursor: pointer; user-select: none; ${col.key === 'count' ? 'text-align: right;' : ''}">
                                        ${col.label}${summarySortKey === col.key ? arrow : ''}
                                    </th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${sorted.map(r => `
                                <tr style="border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.15));">
                                    <td style="padding: 0.5rem 0.75rem; font-weight: 600;">${r.label}</td>
                                    <td style="padding: 0.5rem 0.75rem;">${r.cls}</td>
                                    <td style="padding: 0.5rem 0.75rem;">${r.rarity || ''}</td>
                                    <td style="padding: 0.5rem 0.75rem; text-align: right;">${r.count}</td>
                                </tr>`).join('')}
                            <tr style="border-top: 2px solid var(--text-secondary, #888); font-weight: 700;">
                                <td style="padding: 0.5rem 0.75rem;" colspan="3">Total</td>
                                <td style="padding: 0.5rem 0.75rem; text-align: right;">${totalCards}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>`;
                summaryContainer.querySelectorAll('th[data-sort]').forEach(th => {
                    th.addEventListener('click', () => {
                        const key = th.dataset.sort;
                        if (summarySortKey === key) {
                            summarySortDir = summarySortDir === 'asc' ? 'desc' : 'asc';
                        } else {
                            summarySortKey = key;
                            summarySortDir = (key === 'rarity' || key === 'count') ? 'desc' : 'asc';
                        }
                        renderSummary();
                    });
                });
            };

            renderSummary();

            if (wonCards.length === 0) {
                summaryContainer.innerHTML = '';
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
                                <div class="card-class">${mint.className} • ${mint.rarity || ''} • Awaiting Release</div>
                                <h3 class="card-species pending-card-species">Card Not Released Yet</h3>
                                <p class="card-attribution">Winner: @${mint.account}</p>
                                <div class="card-meta">
                                    <span style="font-size:0.75rem;">Serial: <strong style="color:var(--text-primary);">${mint.serial}</strong></span>
                                    <span style="font-size:0.75rem;">${new Date(mint.timestamp + 'Z').toLocaleString()}</span>
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
                                <div class="card-class">${mint.card.class} • ${mint.status === 'generic' ? (mint.rarity || mint.card.rarity) : mint.card.rarity}</div>
                                <h3 class="card-species">${mint.card.species}</h3>
                                ${mint.card.is_generic ? '<p style="color: var(--text-secondary); font-size: 0.8rem; font-style: italic; margin-top: 0.25rem;">A specific species will be released in the future.</p>' : ''}
                                <p class="card-attribution">Winner: @${mint.account} • Generation: ${mint.card.generation} • Photo by ${mint.card.photo_credit}</p>
                                <div class="card-meta">
                                    <span style="font-size:0.75rem;">Serial: <strong style="color:var(--text-primary);">${mint.serial}</strong></span>
                                    <span style="font-size:0.75rem;">${new Date(mint.timestamp + 'Z').toLocaleString()}</span>
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
