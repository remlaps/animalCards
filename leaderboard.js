// Build the "please support the photographer" tooltip text from the beneficiaries
// map (loaded from cards-config.json into api.beneficiaries).
function beneficiaryTip(api, rarity) {
    const beneficiaries = (api && api.beneficiaries) || {};
    const pct = beneficiaries[rarity] || 1;
    const parts = [];
    for (const [name, percent] of Object.entries(beneficiaries)) {
        parts.push(`${percent}% for ${name.toLowerCase()} species`);
    }
    const list = parts.join(', ');
    return `If you blog about this card, please consider setting a beneficiary for the photographer: ${list}. (This card: ${rarity || 'Unknown'} — ${pct}%)`;
}

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

        // Clear any previous mobile card rows
        const existingMobileRows = document.querySelectorAll('.leaderboard-card-row');
        existingMobileRows.forEach(r => r.remove());

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
                        rarity: resolved.rarity,
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
// Weighted card total per account: each card won contributes its rarity's
            // weight (1 for Common, 2 for Rare, 4 for Epic, ... from cards-config.json).
            // Generic and not-yet-released ('none') cards also count, using their slot rarity.
            const weightedTotalByAccount = {};
            for (const [acct, mints] of Object.entries(winsByAccount)) {
                let total = 0;
                for (const m of mints) {
                    total += api.beneficiaries[m.rarity] || 1;
                }
                weightedTotalByAccount[acct] = total;
            }

            // Sort by weighted total (descending), tie-break by burn amount.
            const sortedBurners = Object.entries(burners)
                .sort((a, b) => {
                    const aW = weightedTotalByAccount[a[0]] || 0;
                    const bW = weightedTotalByAccount[b[0]] || 0;
                    return (bW - aW) || (b[1] - a[1]);
                })
                .slice(0, 10); // Top 10

            // Summarize each top account's wins into unique card types, each with its serials
            const uniqueCardsByAccount = {};
            const pendingClassesByAccount = {}; // account -> classes won but no card released yet
            // Rarity scarcity order: fewer slots = scarcer. Used so generic cards
            // (grouped by class+species) display their most scarce rarity label.
            const rarityRank = { Common: 0, Rare: 1, Epic: 2, Legendary: 3, Mythic: 4 };
            for (const [account] of sortedBurners) {
                const bySpecies = new Map();
                const pendingClasses = new Map();
                for (const m of (winsByAccount[account] || [])) {
                    if (m.status === 'none') {
                        // No card issued for this class yet; record which class + rarity it would've been.
                        const pkey = `${m.className}|${m.rarity}`;
                        if (!pendingClasses.has(pkey)) pendingClasses.set(pkey, { className: m.className, rarity: m.rarity });
                        continue;
                    }
                    const key = `${m.card.class}|${m.card.species}`;
                    if (!bySpecies.has(key)) {
                        bySpecies.set(key, { card: m.card, rarity: m.status === 'generic' ? m.rarity : m.card.rarity, serials: [] });
                    } else if (m.status === 'generic') {
                        // Generic cards of the same class+species group together; keep the
                        // most scarce rarity seen across all wins.
                        const existing = bySpecies.get(key);
                        if ((rarityRank[m.rarity] ?? -1) > (rarityRank[existing.rarity] ?? -1)) {
                            existing.rarity = m.rarity;
                        }
                    }
                    bySpecies.get(key).serials.push(m.serial);
                }
                uniqueCardsByAccount[account] = Array.from(bySpecies.values());
                pendingClassesByAccount[account] = Array.from(pendingClasses.values());
            }

            // Render table
            if (sortedBurners.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No BurnMaxxer titles won in this timeframe.</td></tr>';
                const mobileEmpty = document.createElement('div');
                mobileEmpty.className = 'leaderboard-card-row';
                mobileEmpty.innerHTML = '<p class="status-message" style="margin:0;">No BurnMaxxer titles won in this timeframe.</p>';
                const tableContainer = document.querySelector('.leaderboard-table-container');
                if (tableContainer && tableContainer.parentNode) {
                    tableContainer.parentNode.insertBefore(mobileEmpty, tableContainer.nextSibling);
                }
            } else {
                sortedBurners.forEach(([account], index) => {
                    const uniqueCards = uniqueCardsByAccount[account] || [];
                    const pendingClasses = pendingClassesByAccount[account] || [];
                    const titlesWon = (winsByAccount[account] || []).length;

                    // Cards actually issued (released species or generic class card).
                    const issuedHtml = uniqueCards.map(u => `
                        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
                            <img src="${u.card.image_url}" alt="${u.card.species}" style="width: 28px; height: 28px; border-radius: 4px; object-fit: cover; flex-shrink: 0;">
                            <span style="font-weight: 600;">${u.card.species}</span>
                            ${u.card.is_generic ? `<span class="rarity-badge" style="font-size:0.7rem; color:var(--text-secondary); border:1px solid var(--border-color,rgba(128,128,128,0.3)); border-radius:4px; padding:1px 5px;">${u.rarity || u.card.rarity}</span>` : ''}
                        </div>`).join('');

                    // Classes won but no card released yet -> show what kind it would've been (class + rarity).
                    const pendingHtml = pendingClasses.map(c => `
                        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
                            <span style="font-weight: 600;">${c.className}</span>
                            <span class="rarity-badge" style="font-size:0.7rem; color:var(--text-secondary); border:1px solid var(--border-color,rgba(128,128,128,0.3)); border-radius:4px; padding:1px 5px;">${c.rarity || ''}</span>
                            <span style="color: var(--text-secondary); font-size: 0.75rem;">(no card released yet)</span>
                        </div>`).join('');

                    const cardHtml = (issuedHtml || pendingHtml)
                        ? issuedHtml + pendingHtml
                        : '<span style="color: var(--text-secondary)">No card won in timeframe</span>';

                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td class="rank-cell">#${index + 1}</td>
                        <td style="font-weight: 600;">@${account}</td>
                        <td style="font-weight: 600;">${titlesWon}</td>
                        <td style="font-weight: 600;">${weightedTotalByAccount[account] || 0}</td>
                        <td>${(burnSTEEM[account] || 0).toFixed(3)}</td>
                        <td>${(burnSBD[account] || 0).toFixed(3)}</td>
                        <td>${cardHtml}</td>
                    `;
                    tbody.appendChild(row);

                    // Mobile card row (hidden on desktop, shown on mobile via CSS)
                    const mobileCardChips = (uniqueCards.length > 0 || pendingClasses.length > 0)
                        ? [...uniqueCards.map(u => `
                            <span class="leaderboard-card-chip">
                                <img src="${u.card.image_url}" alt="${u.card.species}">
                                ${u.card.species}${u.card.is_generic ? ` (${u.rarity})` : ''}
                            </span>`),
                            ...pendingClasses.map(c => `
                            <span class="leaderboard-card-chip pending">${c.className}${c.rarity ? ` (${c.rarity} pending)` : ' (pending)'}</span>`)].join('')
                        : '<span style="color: var(--text-secondary); font-size: 0.85rem;">No card won in timeframe</span>';

                    const mobileRow = document.createElement('div');
                    mobileRow.className = 'leaderboard-card-row';
                    mobileRow.innerHTML = `
                        <div class="leaderboard-card-rank">#${index + 1}</div>
                        <div class="leaderboard-card-account">@${account}</div>
                        <div class="leaderboard-card-fields">
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Titles Won</div>
                                <div class="leaderboard-card-field-value">${titlesWon}</div>
                            </div>
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Weighted</div>
                                <div class="leaderboard-card-field-value">${weightedTotalByAccount[account] || 0}</div>
                            </div>
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Total STEEM</div>
                                <div class="leaderboard-card-field-value">${(burnSTEEM[account] || 0).toFixed(3)}</div>
                            </div>
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Total SBD</div>
                                <div class="leaderboard-card-field-value">${(burnSBD[account] || 0).toFixed(3)}</div>
                            </div>
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Cards Won</div>
                                <div class="leaderboard-card-field-value">${uniqueCards.length + pendingClasses.length}</div>
                            </div>
                        </div>
                        <div class="leaderboard-cards-preview">
                            <div class="leaderboard-cards-preview-label">Cards Won</div>
                            <div class="leaderboard-cards-list">${mobileCardChips}</div>
                        </div>
                    `;
                    // Insert after the table container
                    const tableContainer = document.querySelector('.leaderboard-table-container');
                    if (tableContainer && tableContainer.parentNode) {
                        tableContainer.parentNode.insertBefore(mobileRow, tableContainer.nextSibling);
                    }
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
                                    <div class="card-class">${u.card.class} • ${u.rarity || u.card.rarity}</div>
                                    <h3 class="card-species">${u.card.species}</h3>
                                    ${u.card.is_generic ? '<p style="color: var(--text-secondary); font-size: 0.8rem; font-style: italic; margin-top: 0.25rem;">A specific species will be released in the future.</p>' : ''}
                                    <p class="card-attribution" title="${beneficiaryTip(api, u.rarity || u.card.rarity)}">Winner: @${account} • Generation: ${u.card.generation} • Photo by ${u.card.photo_credit}</p>
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