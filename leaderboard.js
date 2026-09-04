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
                            STEEM: { maxBurn: 0, winners: [] },
                            SBD: { maxBurn: 0, winners: [] },
                            timestamp: item.timestamp
                        };
                    }

                    if (val > blocksData[item.block][asset].maxBurn) {
                        blocksData[item.block][asset].maxBurn = val;
                        blocksData[item.block][asset].winners = [{ account: from, trx_id: item.trx_id }];
                    } else if (val === blocksData[item.block][asset].maxBurn) {
                        // Exact tie for the top burn → both (all) tied accounts
                        // win a downgraded card.
                        blocksData[item.block][asset].winners.push({ account: from, trx_id: item.trx_id });
                    }
                }
            }

            // Determine cards for each block.
            // winsByAccount -> every card win per account (all serials in the timeframe).
            const winsByAccount = {};
            const blockNums = Object.keys(blocksData).sort((a, b) => b - a); // Newest blocks first

            for (const blockNum of blockNums) {
                const bData = blocksData[blockNum];

                const assets = [
                    { asset: 'STEEM', serial: `${blockNum}.0`, data: bData.STEEM },
                    { asset: 'SBD', serial: `${blockNum}.1`, data: bData.SBD }
                ];

                for (const a of assets) {
                    const isTie = a.data.winners.length > 1;
                    for (const w of a.data.winners) {
                        const resolved = await api.resolveCardForBlock(a.serial, w.trx_id, { winningBurnAmount: a.data.maxBurn, tie: isTie });
                        const mint = {
                            account: w.account,
                            status: resolved.status,
                            className: resolved.className,
                            rarity: resolved.rarity,
                            card: resolved.card,
                            block: blockNum,
                            trx_id: w.trx_id,
                            serial: a.serial,
                            asset: a.asset
                        };
                        if (!winsByAccount[mint.account]) winsByAccount[mint.account] = [];
                        winsByAccount[mint.account].push(mint);
                    }
                }
            }
// Weighted card total per account: each card won contributes its rarity's
            // weight (1 for Common, 2 for Rare, 4 for Epic, ... from cards-config.json).
            // Generic and not-yet-released ('none') cards also count, using their slot rarity.
            
            // Compute streaks per account from block timestamps.
            var winDaysByAccount = {};
            for (var acct in winsByAccount) {
                var days = new Set();
                var mints = winsByAccount[acct];
                for (var i = 0; i < mints.length; i++) {
                    var m = mints[i];
                    var bData = blocksData[m.block];
                    var ts = bData ? bData.timestamp : null;
                    if (ts) {
                        var d = new Date(ts + "Z");
                        if (!isNaN(d.getTime())) days.add(d.toISOString().slice(0, 10));
                    }
                }
                winDaysByAccount[acct] = days;
            }
            function searchLengthDays(ms) { return ms ? Math.max(1, Math.round(ms / 86400000)) : Infinity; }
            function computeStreak(daySet) {
                var now = new Date();
                var today = now.toISOString().slice(0, 10);
                var yesterday = new Date(now);
                yesterday.setUTCDate(yesterday.getUTCDate() - 1);
                var yesterdayStr = yesterday.toISOString().slice(0, 10);
                var startDay;
                if (daySet.has(today)) { startDay = today; }
                else if (daySet.has(yesterdayStr)) { startDay = yesterdayStr; }
                else { return { streak: 0, days: [], startDay: null }; }
                var days = [startDay];
                var cursor = new Date(startDay + "T00:00:00Z");
                while (true) {
                    cursor.setUTCDate(cursor.getUTCDate() - 1);
                    var prev = cursor.toISOString().slice(0, 10);
                    if (daySet.has(prev)) { days.push(prev); } else { break; }
                }
                return { streak: days.length, days: days.sort(), startDay: startDay };
            }
            var streakEntries = [];
            for (var acct in winDaysByAccount) {
                var result = computeStreak(winDaysByAccount[acct]);
                if (result.streak > 0) { streakEntries.push({ account: acct, streak: result.streak, days: result.days }); }
            }
            streakEntries.sort(function(a, b) { return b.streak - a.streak || a.account.localeCompare(b.account); });
            var topStreaks = streakEntries.slice(0, 10);
            var streakDays = searchLengthDays(timeConstraint);

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

            // Summarize each top account's wins into unique card types, each with its serials.
            // Cards are grouped by class + rarity + species, so a generic card won at
            // different slot rarities appears as separate entries, each with a quantity.
            const uniqueCardsByAccount = {};
            const pendingClassesByAccount = {}; // account -> classes won but no card released yet
            for (const [account] of sortedBurners) {
                const byCard = new Map();
                const pendingClasses = new Map();
                for (const m of (winsByAccount[account] || [])) {
                    if (m.status === 'none') {
                        // No card issued for this class yet; record which class + rarity it would've been.
                        const pkey = `${m.className}|${m.rarity}`;
                        if (!pendingClasses.has(pkey)) pendingClasses.set(pkey, { className: m.className, rarity: m.rarity });
                        continue;
                    }
                    const rarity = m.status === 'generic' ? m.rarity : m.card.rarity;
                    const key = `${m.card.class}|${rarity}|${m.card.species}`;
                    if (!byCard.has(key)) {
                        byCard.set(key, { card: m.card, rarity, serials: [] });
                    }
                    byCard.get(key).serials.push(m.serial);
                }
                uniqueCardsByAccount[account] = Array.from(byCard.values());
                pendingClassesByAccount[account] = Array.from(pendingClasses.values());
            }

            // Build a flat row-data array for the sortable table.
            const rowData = sortedBurners.map(([account]) => ({
                account,
                titles: (winsByAccount[account] || []).length,
                weighted: weightedTotalByAccount[account] || 0,
                steem: (burnSTEEM[account] || 0),
                sbd: (burnSBD[account] || 0),
                cardsArr: uniqueCardsByAccount[account] || [],
                pendingArr: pendingClassesByAccount[account] || []
            }));

            // Sort state
            let sortKey = 'weighted';
            let sortDir = 'desc';

            const compareRows = (a, b) => {
                let val;
                if (sortKey === 'account') {
                    val = a.account.localeCompare(b.account);
                } else if (sortKey === 'cards') {
                    val = a.cardsArr.length - b.cardsArr.length;
                } else {
                    val = (a[sortKey] || 0) - (b[sortKey] || 0);
                }
                return sortDir === 'asc' ? val : -val;
            };

            const renderTable = () => {
                const sorted = [...rowData].sort(compareRows);

                // Update header arrows
                document.querySelectorAll('.leaderboard-table th.sortable').forEach(th => {
                    th.classList.remove('sort-active');
                    const txt = th.textContent.replace(/ [▲▼]$/, '');
                    th.textContent = txt;
                });
                const activeHeader = document.querySelector(`.leaderboard-table th[data-sort="${sortKey}"]`);
                if (activeHeader) {
                    activeHeader.classList.add('sort-active');
                    activeHeader.textContent += sortDir === 'asc' ? ' ▲' : ' ▼';
                }

                if (sorted.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No BurnMaxxer titles won in this timeframe.</td></tr>';
                    document.querySelectorAll('.leaderboard-card-row').forEach(r => r.remove());
                    const mobileEmpty = document.createElement('div');
                    mobileEmpty.className = 'leaderboard-card-row';
                    mobileEmpty.innerHTML = '<p class="status-message" style="margin:0;">No BurnMaxxer titles won in this timeframe.</p>';
                    const tc = document.querySelector('.leaderboard-table-container');
                    if (tc && tc.parentNode) {
                        tc.parentNode.insertBefore(mobileEmpty, tc.nextSibling);
                    }
                    return;
                }

                tbody.innerHTML = '';
                document.querySelectorAll('.leaderboard-card-row').forEach(r => r.remove());
                sorted.forEach((row, index) => {
                    const account = row.account;
                    const uniqueCards = row.cardsArr;
                    const pendingClasses = row.pendingArr;

                    const issuedHtml = uniqueCards.map(u => `
                        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
                            <img src="${u.card.image_url}" alt="${u.card.species}" style="width: 28px; height: 28px; border-radius: 4px; object-fit: cover; flex-shrink: 0;">
                            <span style="font-weight: 600;">${u.card.species}</span>
                            ${u.card.is_generic ? `<span class="rarity-badge" style="font-size:0.7rem; color:var(--text-secondary); border:1px solid var(--border-color,rgba(128,128,128,0.3)); border-radius:4px; padding:1px 5px;">${u.rarity || u.card.rarity}</span>` : ''}
                        </div>`).join('');

                    const pendingHtml = pendingClasses.map(c => `
                        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
                            <span style="font-weight: 600;">${c.className}</span>
                            <span class="rarity-badge" style="font-size:0.7rem; color:var(--text-secondary); border:1px solid var(--border-color,rgba(128,128,128,0.3)); border-radius:4px; padding:1px 5px;">${c.rarity || ''}</span>
                            <span style="color: var(--text-secondary); font-size: 0.75rem;">(no card released yet)</span>
                        </div>`).join('');

                    const cardHtml = (issuedHtml || pendingHtml)
                        ? issuedHtml + pendingHtml
                        : '<span style="color: var(--text-secondary)">No card won in timeframe</span>';

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="rank-cell">#${index + 1}</td>
                        <td style="font-weight: 600;">@${account}</td>
                        <td style="font-weight: 600;">${row.titles}</td>
                        <td style="font-weight: 600;">${row.weighted}</td>
                        <td>${row.steem.toFixed(3)}</td>
                        <td>${row.sbd.toFixed(3)}</td>
                        <td>${cardHtml}</td>
                    `;
                    tbody.appendChild(tr);

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
                                <div class="leaderboard-card-field-value">${row.titles}</div>
                            </div>
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Weighted</div>
                                <div class="leaderboard-card-field-value">${row.weighted}</div>
                            </div>
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Total STEEM</div>
                                <div class="leaderboard-card-field-value">${row.steem.toFixed(3)}</div>
                            </div>
                            <div class="leaderboard-card-field">
                                <div class="leaderboard-card-field-label">Total SBD</div>
                                <div class="leaderboard-card-field-value">${row.sbd.toFixed(3)}</div>
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
                    const tc = document.querySelector('.leaderboard-table-container');
                    if (tc && tc.parentNode) {
                        tc.parentNode.insertBefore(mobileRow, tc.nextSibling);
                    }
                });
            };

            // Initial render
            renderTable();

            // Attach click handlers to sortable headers
            document.querySelectorAll('.leaderboard-table th.sortable').forEach(th => {
                th.addEventListener('click', () => {
                    const key = th.dataset.sort;
                    if (sortKey === key) {
                        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        sortKey = key;
                        sortDir = key === 'account' ? 'asc' : 'desc';
                    }
                    renderTable();
                });
            });

            // Render per-account card details (all unique cards + serials) for the top 10
            if (sortedBurners.length === 0) {
                cardsGrid.innerHTML = '<p class="status-message">No card winners in this timeframe.</p>';
            } else {
                cardsGrid.innerHTML = sortedBurners.map(([account]) => {
                    const uniqueCards = uniqueCardsByAccount[account] || [];
                    const cardsHtml = uniqueCards.length === 0
                        ? '<p class="status-message" style="grid-column: 1/-1;">No card won in this timeframe.</p>'
                        : uniqueCards.map(u => {
                            const qty = u.serials.length;
                            const countBadge = qty > 1 ? `<span class="card-count-badge">×${qty}</span>` : '';
                            const serialOrQty = qty > 1
                                ? `<span style="font-size:0.75rem;">Quantity: <strong style="color:var(--text-primary);">${qty}</strong></span>`
                                : `<span style="font-size:0.75rem;">Serial: <strong style="color:var(--text-primary);">${u.serials[0]}</strong></span>`;
                            return `
                            <div class="tribute-card">
                                <div class="card-image-container">
                                    <img src="${u.card.image_url}" alt="${u.card.species}" class="card-image">
                                    ${countBadge}
                                </div>
                                <div class="card-content">
                                    <div class="card-class">${u.card.class} • ${u.rarity || u.card.rarity}</div>
                                    <h3 class="card-species">${u.card.species}</h3>
                                    ${u.card.is_generic ? '<p style="color: var(--text-secondary); font-size: 0.8rem; font-style: italic; margin-top: 0.25rem;">A specific species will be released in the future.</p>' : ''}
                                    <p class="card-attribution" title="${beneficiaryTip(api, u.rarity || u.card.rarity)}">Winner: @${account} • Generation: ${u.card.generation} • Photo by ${u.card.photo_credit}</p>
                                    <div class="card-meta">
                                        ${serialOrQty}
                                    </div>
                                </div>
                            </div>`;
                        }).join('');

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

            ﻿

﻿


// Render streaks grid
var streaksGrid = document.getElementById('streaks-grid');
if (streaksGrid) {
  if (topStreaks.length === 0) {
    streaksGrid.innerHTML = '<p class="status-message" style="grid-column: 1/-1;">No streaks found in this timeframe.</p>';
  } else {
    streaksGrid.innerHTML = topStreaks.map(function(e) {
      var display = e.streak >= streakDays ? e.streak + '+' : String(e.streak);
      var color = e.streak >= 10 ? '#22c55e' : e.streak >= 5 ? '#eab308' : '#3b82f6';
      return '<div style="background:var(--glass-bg);backdrop-filter:blur(12px);border:1px solid var(--glass-border);border-radius:12px;padding:0.75rem 1rem;text-align:center;box-shadow:var(--glass-shadow);">' +
        '<div style="font-family:Outfit,sans-serif;font-size:1.75rem;font-weight:800;line-height:1;color:' + color + ';">' + display + '</div>' +
        '<div style="font-size:0.82rem;color:var(--text-secondary);margin-top:0.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">@' + e.account + '</div>' +
        '</div>';
    }).join('');
  }
}

loading.style.display = 'none';
            content.style.display = 'block';

        } catch (error) {
            console.error(error);
            loading.innerHTML = `<p class="status-message" style="color: #ef4444;">Error loading leaderboard data: ${error.message}</p>`;
        }
    }

    timeFilter.addEventListener('change', loadLeaderboard);
    renderDifficultyDashboard();
    loadLeaderboard();
});