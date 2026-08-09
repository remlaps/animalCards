document.addEventListener('DOMContentLoaded', async () => {
    const timeFilter = document.getElementById('time-filter');
    const loading = document.getElementById('loading');
    const content = document.getElementById('leaderboard-content');
    const tbody = document.getElementById('leaderboard-body');
    const cardsGrid = document.getElementById('recent-cards-grid');

    async function loadLeaderboard() {
        loading.style.display = 'flex';
        content.style.display = 'none';
        tbody.innerHTML = '';
        cardsGrid.innerHTML = '';

        const timeConstraint = parseInt(timeFilter.value, 10);

        try {
            // Ensure config is loaded
            if (api.cardsConfig.length === 0) {
                await api.loadConfig();
            }

            const history = await api.getAccountHistory('null', timeConstraint);

            const burners = {};
            const burnSTEEM = {};
            const burnSBD = {};
            const blocksData = {};

            // Group history by block
            for (const item of history) {
                const op = item.op;
                if (op[0] === 'transfer' && op[1].to === 'null') {
                    const from = op[1].from;
                    const amountStr = op[1].amount;
                    const [amountValStr, asset] = amountStr.split(' ');
                    const val = parseFloat(amountValStr);

                    if (!burners[from]) burners[from] = 0;
                    burners[from] += val; // Total across all assets (used for ranking)
                    if (asset === 'STEEM') burnSTEEM[from] = (burnSTEEM[from] || 0) + val;
                    else if (asset === 'SBD') burnSBD[from] = (burnSBD[from] || 0) + val;

                    if (!blocksData[item.block]) {
                        blocksData[item.block] = {
                            STEEM: { maxBurn: 0, winner: null },
                            SBD: { maxBurn: 0, winner: null },
                            trx_id: item.trx_id
                        };
                    }

                    if (val > blocksData[item.block][asset].maxBurn) {
                        blocksData[item.block][asset].maxBurn = val;
                        blocksData[item.block][asset].winner = from;
                        // Use the trx_id of the winning transaction for the deterministic hash
                        blocksData[item.block][asset].trx_id = item.trx_id;
                    }
                }
            }

            // Determine cards for each block.
            // winsByAccount -> every card win per account (all serials in the timeframe).
            const winsByAccount = {};
            const blockNums = Object.keys(blocksData).sort((a, b) => b - a); // Newest blocks first

            for (const blockNum of blockNums) {
                const bData = blocksData[blockNum];

                const winners = [
                    { asset: 'STEEM', winner: bData.STEEM.winner, trx_id: bData.STEEM.trx_id, serial: `${blockNum}.0` },
                    { asset: 'SBD', winner: bData.SBD.winner, trx_id: bData.SBD.trx_id, serial: `${blockNum}.1` }
                ];

                for (const w of winners) {
                    if (!w.winner) continue;
                    const resolved = await api.resolveCardForBlock(w.serial, w.trx_id);
                    const mint = {
                        account: w.winner,
                        status: resolved.status,
                        className: resolved.className,
                        card: resolved.card,
                        block: blockNum,
                        trx_id: w.trx_id,
                        serial: w.serial,
                        asset: w.asset
                    };
                    if (!winsByAccount[mint.account]) winsByAccount[mint.account] = [];
                    winsByAccount[mint.account].push(mint);
                }
            }
// Sort top burners
            const sortedBurners = Object.entries(burners)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10); // Top 10

            // Summarize each top account's wins into unique card types, each with its serials
            const uniqueCardsByAccount = {};
            for (const [account] of sortedBurners) {
                const bySpecies = new Map();
                for (const m of (winsByAccount[account] || [])) {
                    if (m.status === 'none') continue; // no actual card issued
                    const key = `${m.card.class}|${m.card.species}`;
                    if (!bySpecies.has(key)) bySpecies.set(key, { card: m.card, serials: [] });
                    bySpecies.get(key).serials.push(m.serial);
                }
                uniqueCardsByAccount[account] = Array.from(bySpecies.values());
            }

            // Render table
            if (sortedBurners.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No burns found in this timeframe.</td></tr>';
            } else {
                sortedBurners.forEach(([account], index) => {
                    const uniqueCards = uniqueCardsByAccount[account] || [];
                    const cardHtml = uniqueCards.length === 0
                        ? '<span style="color: var(--text-secondary)">No card won in timeframe</span>'
                        : uniqueCards.map(u => `
                            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
                                <img src="${u.card.image_url}" alt="${u.card.species}" style="width: 28px; height: 28px; border-radius: 4px; object-fit: cover; flex-shrink: 0;">
                                <span style="font-weight: 600;">${u.card.species}</span>
                            </div>`).join('');

                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td class="rank-cell">#${index + 1}</td>
                        <td style="font-weight: 600;">@${account}</td>
                        <td>${(burnSTEEM[account] || 0).toFixed(3)}</td>
                        <td>${(burnSBD[account] || 0).toFixed(3)}</td>
                        <td>${cardHtml}</td>
                    `;
                    tbody.appendChild(row);
                });
            }

            // Render per-account card details (all unique cards + serials) for the top 10
            if (sortedBurners.length === 0) {
                cardsGrid.innerHTML = '<p class="status-message">No card winners in this timeframe.</p>';
            } else {
                cardsGrid.innerHTML = sortedBurners.map(([account]) => {
                    const uniqueCards = uniqueCardsByAccount[account] || [];
                    const cardsHtml = uniqueCards.length === 0
                        ? '<p class="status-message" style="grid-column: 1/-1;">No card won in this timeframe.</p>'
                        : uniqueCards.map(u => `
                            <div class="tribute-card">
                                <div class="card-image-container">
                                    <img src="${u.card.image_url}" alt="${u.card.species}" class="card-image">
                                </div>
                                <div class="card-content">
                                    <div class="card-class">${u.card.class} • ${u.card.rarity}</div>
                                    <h3 class="card-species">${u.card.species}</h3>
                                    <div class="card-meta">
                                        <span style="font-size:0.75rem;">Serial(s): ${u.serials.join(', ')}</span>
                                    </div>
                                </div>
                            </div>`).join('');

                    return `
                        <div class="winner-section" style="margin-bottom: 2.5rem;">
                            <h4 style="font-family: 'Outfit'; font-size: 1.25rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.75rem;">
                                @${account}
                                <span style="color: var(--text-secondary); font-size: 0.9rem;">
                                    ${(burnSTEEM[account] || 0).toFixed(3)} STEEM • ${(burnSBD[account] || 0).toFixed(3)} SBD
                                </span>
                            </h4>
                            <div class="cards-grid">${cardsHtml}</div>
                        </div>`;
                }).join('');
            }

            loading.style.display = 'none';
            content.style.display = 'block';

        } catch (error) {
            console.error(error);
            loading.innerHTML = `<p class="status-message" style="color: #ef4444;">Error loading leaderboard data: ${error.message}</p>`;
        }
    }

    timeFilter.addEventListener('change', loadLeaderboard);
    loadLeaderboard();
});