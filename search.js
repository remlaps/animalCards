// Number of concurrent block-verification requests. Kept modest so we parallelize
// without overloading the Steem API node.
const BLOCK_CONCURRENCY = 4;

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
// Format a UTC ISO timestamp as a human-readable GMT string (always shown in GMT).
function formatGMT(timestamp) {
    const d = new Date(timestamp + 'Z');
    if (isNaN(d.getTime())) return '';
    const parts = Intl.DateTimeFormat('en-GB', {
        timeZone: 'GMT', hour12: false,
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(d);
    const get = (t) => (parts.find(x => x.type === t) || {}).value || '';
    return `${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')}:${get('second')} GMT`;
}

// Run an async fn over items with at most `concurrency` tasks in flight at once.
async function mapWithConcurrency(items, concurrency, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    const n = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}

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
    const loadingStatus = document.getElementById('loading-status');
    const loadingProgress = document.getElementById('loading-progress');

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

            // Fetch the account's creation time so we never scan further back than
            // the account could have existed. Older of the two bounds wins.
            const accounts = await api.getAccounts([account]);
            const createdMs = accounts && accounts[0] ? new Date(accounts[0].created + "Z").getTime() : 0;

            let earliestTimeMs = timeConstraint ? Date.now() - timeConstraint : 0;
            if (createdMs > earliestTimeMs) earliestTimeMs = createdMs;

            // 1) Fetch the null-account history once. Each history item natively carries its
            //    block number and transaction id, so we skip SDS block estimation and
            //    per-block verification entirely — the same approach the leaderboard
            //    uses. This is much faster for long time ranges.
            loadingStatus.textContent = 'Fetching burn history...';
            loadingProgress.textContent = '';
            let lastMonthShown = null;
            const history = await api.getAccountHistory('null', timeConstraint, earliestTimeMs, (count, ts) => {
                if (!ts) {
                    // No timestamp yet (e.g. nothing scanned so far) — just show the count.
                    loadingProgress.textContent = `Scanned ${count.toLocaleString()} history ops`;
                    return;
                }
                // Redisplay only once per calendar month the scan frontier crosses.
                const monthKey = ts.slice(0, 7); // "YYYY-MM" from the raw timestamp
                if (monthKey !== lastMonthShown) {
                    lastMonthShown = monthKey;
                    loadingProgress.textContent = `Scanned ${count.toLocaleString()} history ops — back to ${formatGMT(ts)}`;
                }
            });

            // Track the searched account's transfers (for stats) and the per-block,
            // per-asset max burner (for winner determination). An exact tie for the
            // max burn means no one wins that block+asset.
            const transfers = [];
            const blocksData = {};
            for (const item of history) {
                const op = item.op;
                if (op[0] !== 'transfer' || op[1].to !== 'null') continue;
                const from = op[1].from;
                const [valStr, asset] = op[1].amount.split(' ');
                const val = parseFloat(valStr);
                if (asset !== 'STEEM' && asset !== 'SBD') continue;

                // Record the searched account's own burns for the stats line.
                if (from === account) {
                    transfers.push({
                        from,
                        to: op[1].to,
                        amount: val,
                        unit: asset,
                        memo: op[1].memo,
                        block: item.block,
                        trx_id: item.trx_id,
                        timestamp: item.timestamp
                    });
                }

                if (!blocksData[item.block]) {
                    blocksData[item.block] = {
                        STEEM: { maxBurn: 0, winner: null, trx_id: null, timestamp: item.timestamp },
                        SBD: { maxBurn: 0, winner: null, trx_id: null, timestamp: item.timestamp }
                    };
                }
                const slot = blocksData[item.block][asset];
                if (val > slot.maxBurn) {
                    slot.maxBurn = val;
                    slot.winner = from;
                    slot.trx_id = item.trx_id;
                    slot.timestamp = item.timestamp;
                } else if (val === slot.maxBurn) {
                    // Exact tie for the top burn -> no one wins this block+asset.
                    slot.winner = null;
                    slot.trx_id = null;
                }
            }

            // 3) Compute the account's totals and the newest-first block list from the
            //    data already gathered. No per-block fetch or verification needed —
            //    the null history already gave us exact block numbers and trx ids.
            const totalSteem = transfers.reduce((s, t) => s + (t.unit === 'STEEM' ? t.amount : 0), 0);
            const totalSbd = transfers.reduce((s, t) => s + (t.unit === 'SBD' ? t.amount : 0), 0);
            const burnTransactionCount = transfers.length;
            const blockNums = Object.keys(blocksData).sort((a, b) => b - a); // Newest first

            let processed = 0;
            loadingStatus.textContent = 'Identifying BurnMaxxers...';
            loadingProgress.textContent = `Checked 0 of ${blockNums.length.toLocaleString()} BurnMaxxer operations`;

            async function processBlock(blockNumStr) {
                const blockNum = Number(blockNumStr);
                const bData = blocksData[blockNum];
                const found = [];

                for (const asset of ['STEEM', 'SBD']) {
                    const slot = bData[asset];
                    // Only the single max burner wins; a tie leaves winner null (no card).
                    if (slot.winner === account) {
                        const serial = `${blockNum}.${asset === 'STEEM' ? 0 : 1}`;
                        const trxId = slot.trx_id || '';
                        const resolved = await api.resolveCardForBlock(serial, trxId, { winningBurnAmount: slot.maxBurn });
                        found.push({
                            account: account,
                            status: resolved.status,
                            className: resolved.className,
                            rarity: resolved.rarity,
                            card: resolved.card,
                            block: blockNum,
                            trx_id: trxId,
                            serial: serial,
                            timestamp: slot.timestamp
                        });
                    }
                }

                return found;
            }

            // Update the progress counter as each block finishes processing.
            const tickingProcessBlock = async (blockNum) => {
                const result = await processBlock(blockNum);
                processed++;
                loadingProgress.textContent = `Checked ${processed.toLocaleString()} of ${blockNums.length.toLocaleString()} BurnMaxxer operations`;
                return result;
            };

            const perBlockCards = await mapWithConcurrency(blockNums, BLOCK_CONCURRENCY, tickingProcessBlock);
            const wonCards = perBlockCards.flat();

            header.textContent = `Portfolio for @${account}`;
            const cardsCollected = wonCards.filter(m => m.status !== 'none').length;
            stats.innerHTML = `Burned: <strong>${totalSteem.toFixed(3)} STEEM</strong>, <strong>${totalSbd.toFixed(3)} SBD</strong> in <strong>${burnTransactionCount}</strong> transaction${burnTransactionCount === 1 ? '' : 's'} | Cards Collected: <strong>${cardsCollected}</strong>`;

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

// --- Grid view: toggle (all/unique), filters, and sort ---
            const classRank = {};
            api.classOrder.forEach((cls, i) => { classRank[cls] = i; });
            const rarityRankAll = { Generic: -1, Common: 0, Rare: 1, Epic: 2, Legendary: 3, Mythic: 4 };

            // Normalize each won card into a renderable item.
            const normalizeCard = (m) => {
                if (m.status === 'none') {
                    return { isPlaceholder: true, species: `${m.className} — placeholder`, cls: m.className, rarity: m.rarity || '', image_url: null, is_generic: false, generation: '', photo_credit: '', account: m.account, serial: m.serial, timestamp: m.timestamp, trx_id: m.trx_id };
                }
                const rarity = m.status === 'generic' ? (m.rarity || m.card.rarity) : m.card.rarity;
                return { isPlaceholder: false, species: m.card.species, cls: m.card.class, rarity, image_url: m.card.image_url, is_generic: m.card.is_generic, generation: m.card.generation, photo_credit: m.card.photo_credit, account: m.account, serial: m.serial, timestamp: m.timestamp, trx_id: m.trx_id };
            };
            const displayCards = wonCards.map(normalizeCard);

            const searchFilters = document.getElementById('search-filters');
            const viewToggle = document.getElementById('view-toggle');
            const filterSpecies = document.getElementById('filter-species');
            const filterClass = document.getElementById('filter-class');
            const filterRarity = document.getElementById('filter-rarity');
            const sortBy = document.getElementById('sort-by');
            const sortDirBtn = document.getElementById('sort-dir');
            const clearFiltersBtn = document.getElementById('clear-filters');
            const serialSortOption = document.getElementById('sort-option-serial');
            const state = { view: 'all', species: '', cls: '', rarity: '', sortKey: 'serial', sortDir: 'desc' };

            // Populate filter dropdowns from the cards actually present.
            const fillSelect = (select, values) => {
                const allLabel = select.getAttribute('data-all-label') || 'All';
                select.innerHTML = `<option value="">${allLabel}</option>`;
                [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b))).forEach(v => {
                    const o = document.createElement('option');
                    o.value = v; o.textContent = v; select.appendChild(o);
                });
            };
            fillSelect(filterSpecies, displayCards.map(c => c.species));
            fillSelect(filterClass, displayCards.map(c => c.cls));
            fillSelect(filterRarity, displayCards.map(c => c.rarity));

            const getFilteredCards = () => displayCards.filter(c =>
                (!state.species || c.species === state.species) &&
                (!state.cls || c.cls === state.cls) &&
                (!state.rarity || c.rarity === state.rarity));

            // Parse a card's serial ("BLOCK.SUFFIX") into sortable numeric parts.
            const serialParts = (serial) => {
                const s = String(serial ?? '');
                const dot = s.indexOf('.');
                const block = dot >= 0 ? parseInt(s.slice(0, dot), 10) : parseInt(s, 10);
                const suffix = dot >= 0 ? parseInt(s.slice(dot + 1), 10) : 0;
                return { block: isNaN(block) ? 0 : block, suffix: isNaN(suffix) ? 0 : suffix };
            };

            // Compare two cards by the current sort key. Used for both the all-cards
            // view and (via item attributes) the unique view. Count is a group-level
            // value, so it is handled separately in renderGrid.
            const compareItems = (a, b) => {
                let val;
                if (state.sortKey === 'serial') {
                    const pa = serialParts(a.serial);
                    const pb = serialParts(b.serial);
                    val = (pa.block - pb.block) || (pa.suffix - pb.suffix);
                } else if (state.sortKey === 'rarity') {
                    val = (rarityRankAll[a.rarity] ?? -1) - (rarityRankAll[b.rarity] ?? -1);
                } else if (state.sortKey === 'class') {
                    val = (classRank[a.cls] ?? 999) - (classRank[b.cls] ?? 999) || String(a.cls).localeCompare(String(b.cls));
                } else {
                    val = String(a.species ?? '').localeCompare(String(b.species ?? ''));
                }
                return val;
            };
            const sortCards = (arr) => [...arr].sort((a, b) => {
                const val = compareItems(a, b);
                return state.sortDir === 'asc' ? val : -val;
            });
const verifyBadge = (c) => `<span class="verify-badge" title="Hash: ${c.trx_id}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                        Verified
                    </span>`;

            const renderCardEl = (c, count, serials) => {
                const cardEl = document.createElement('div');
                cardEl.className = 'tribute-card';
                const showCount = count > 1;
                const serialSpan = showCount
                    ? `<span style="font-size:0.75rem;">Serials: ${serials.join(', ')}</span>`
                    : `<span style="font-size:0.75rem;">Serial: <strong style="color:var(--text-primary);">${c.serial}</strong></span>`;
                const timeSpan = `<span style="font-size:0.75rem;">${formatGMT(c.timestamp)}</span>`;
                const countSpan = showCount ? `<span style="font-size:0.75rem;">Quantity: <strong style="color:var(--text-primary);">${count}</strong></span>` : '';
                if (c.isPlaceholder) {
                    cardEl.innerHTML = `
                            <div class="card-image-container pending-card-image">
                                <span class="pending-icon">✦</span>
                            </div>
                            <div class="card-content">
                                <div class="card-class">${c.cls} • ${c.rarity || ''} • Awaiting Release</div>
                                <h3 class="card-species pending-card-species">Card Not Released Yet</h3>
                                <p class="card-attribution">Winner: @${c.account}</p>
                                <div class="card-meta">
                                    ${countSpan}
                                    ${showCount ? '' : serialSpan}
                                    ${showCount ? '' : timeSpan}
                                    ${verifyBadge(c)}
                                </div>
                            </div>`;
                } else {
                    cardEl.innerHTML = `
                            <div class="card-image-container">
                                <img src="${c.image_url}" alt="${c.species}" class="card-image">
                                ${showCount ? `<span class="card-count-badge">×${count}</span>` : ''}
                            </div>
                            <div class="card-content">
                                <div class="card-class">${c.cls} • ${c.rarity}</div>
                                <h3 class="card-species">${c.species}</h3>
                                ${c.is_generic ? '<p style="color: var(--text-secondary); font-size: 0.8rem; font-style: italic; margin-top: 0.25rem;">A specific species will be released in the future.</p>' : ''}
                                <p class="card-attribution" title="${beneficiaryTip(api, c.rarity)}">Winner: @${c.account} • Generation: ${c.generation} • Photo by ${c.photo_credit}</p>
                                <div class="card-meta">
                                    ${countSpan}
                                    ${showCount ? '' : serialSpan}
                                    ${showCount ? '' : timeSpan}
                                    ${verifyBadge(c)}
                                </div>
                            </div>`;
                }
                return cardEl;
            };

            const renderGrid = () => {
                const filtered = getFilteredCards();
                grid.innerHTML = '';
                if (filtered.length === 0) {
                    grid.innerHTML = '<p class="status-message" style="grid-column: 1/-1;">No cards match the current filters.</p>';
                    return;
                }
                if (state.view === 'unique') {
                    // Collapse duplicate (class, species, rarity) into one card with a count.
                    const groups = new Map();
                    for (const c of filtered) {
                        const key = `${c.cls}|${c.species}|${c.rarity}`;
                        if (!groups.has(key)) groups.set(key, { item: c, serials: [] });
                        groups.get(key).serials.push(c.serial);
                    }
                    const groupList = Array.from(groups.values());
                    if (state.sortKey === 'count') {
                        // Sort by the number of copies (count) of each unique card.
                        const dir = state.sortDir === 'asc' ? 1 : -1;
                        groupList.sort((a, b) => dir * (a.serials.length - b.serials.length));
                    } else {
                        groupList.sort((a, b) => {
                            const val = compareItems(a.item, b.item);
                            return state.sortDir === 'asc' ? val : -val;
                        });
                    }
                    groupList.forEach(g => grid.appendChild(renderCardEl(g.item, g.serials.length, g.serials)));
                } else {
                    // All cards, each with its own serial number (newest first).
                    sortCards(filtered).forEach(c => grid.appendChild(renderCardEl(c, 1, [c.serial])));
                }
            };

            viewToggle.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-view]');
                if (!btn) return;
                state.view = btn.dataset.view;
                viewToggle.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b === btn));

                if (state.view === 'unique') {
                    // Serial sort only applies to the all-cards view; switch to count
                    // (the natural default for quantity view) and hide the serial option.
                    if (state.sortKey === 'serial') {
                        state.sortKey = 'count';
                        state.sortDir = 'desc';
                        sortBy.value = 'count';
                        sortDirBtn.innerHTML = 'Sort ▼';
                    }
                    serialSortOption.hidden = true;
                } else {
                    serialSortOption.hidden = false;
                }
                renderGrid();
            });
            filterSpecies.addEventListener('change', () => { state.species = filterSpecies.value; renderGrid(); });
            filterClass.addEventListener('change', () => { state.cls = filterClass.value; renderGrid(); });
            filterRarity.addEventListener('change', () => { state.rarity = filterRarity.value; renderGrid(); });
            sortBy.addEventListener('change', () => { state.sortKey = sortBy.value; renderGrid(); });
            sortDirBtn.addEventListener('click', () => {
                state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                sortDirBtn.innerHTML = state.sortDir === 'asc' ? 'Sort ▲' : 'Sort ▼';
                renderGrid();
            });
            clearFiltersBtn.addEventListener('click', () => {
                state.species = '';
                state.cls = '';
                state.rarity = '';
                filterSpecies.value = '';
                filterClass.value = '';
                filterRarity.value = '';
                renderGrid();
            });
            renderSummary();

            if (wonCards.length === 0) {
                summaryContainer.innerHTML = '';
                grid.innerHTML = '<p class="status-message" style="grid-column: 1/-1;">No cards found for this account in the selected timeframe.</p>';
            } else {
                viewToggle.style.display = 'flex';
                searchFilters.style.display = 'flex';
                renderGrid();
            }

            loading.style.display = 'none';
            content.style.display = 'block';

        } catch (error) {
            console.error(error);
            loading.innerHTML = `<p class="status-message" style="color: #ef4444;">Error searching account: ${error.message}</p>`;
        }
    });
});
