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

            // 1) Fetch all transfers from this account to null AND resolve their block
            //    numbers. Preferred: SteemWorld SDS (returns only this account's
            //    burns — fast). If any SDS step fails in this browser, fall back to
            //    scanning the null-account history, which returns exact blocks and
            //    transaction ids in one pass (reliable, but slower).
            loadingStatus.textContent = 'Fetching burn transfers...';
            loadingProgress.textContent = '';
            let transfers = [];
            let sdsStep = '';
            try {
                // --- SDS: transfers ---
                sdsStep = 'fetching transfers';
                const sdsTransfers = [];
                {
                    const LIMIT = 1000;
                    let offset = 0;
                    while (true) {
                        const res = await api.getTransfersByTypeFromTo('transfer', account, 'null', 'time', 'DESC', LIMIT, offset);
                        const rows = (res && res.rows) || [];
                        if (rows.length === 0) break;
                        let reachedOldest = false;
                        for (const r of rows) {
                            const timeMs = r[0] * 1000;
                            if (timeMs < earliestTimeMs) { reachedOldest = true; break; }
                            sdsTransfers.push({ time: r[0], from: r[1], to: r[2], amount: r[3], unit: r[4], memo: r[5] });
                        }
                        if (reachedOldest || rows.length < LIMIT) break;
                        offset += LIMIT;
                    }
                }

                // --- SDS: resolve block numbers ---
                // Firing one getBlockInfoByTime per transfer floods SteemWorld's chain_api
                // (503s). Instead, estimate each block from the previous one (blocks are 3s
                // apart) and only re-query SDS when the time gap grows large enough that
                // missed-block drift could matter. The content-based verification below
                // corrects any small residual error.
                sdsStep = 'resolving block numbers';
                loadingStatus.textContent = 'Resolving block numbers...';
                const REANCHOR_SECONDS = 600; // re-query SDS if >10min since last anchor
                const resolvedBlocks = [];
                let anchorTime = null;
                let anchorBlock = null;
                let resolvedCount = 0;
                // sdsTransfers are ordered by time DESC (newest first).
                for (const t of sdsTransfers) {
                    let candidateBlock;
                    if (anchorBlock === null || (anchorTime - t.time) > REANCHOR_SECONDS) {
                        // Exact lookup + the consistent +1 offset (transaction is in the
                        // block whose timestamp is 3s after the transfer time).
                        candidateBlock = await api.getBlockNumByTime(t.time) + 1;
                        anchorTime = t.time;
                        anchorBlock = candidateBlock;
                    } else {
                        const delta = Math.round((anchorTime - t.time) / 3);
                        candidateBlock = anchorBlock - delta;
                    }
                    resolvedBlocks.push({ ...t, candidateBlock });
                    resolvedCount++;
                    if (resolvedCount % 25 === 0 || resolvedCount === sdsTransfers.length) {
                        loadingProgress.textContent = `Resolving block ${resolvedCount.toLocaleString()} of ${sdsTransfers.length.toLocaleString()}`;
                    }
                }
                transfers = resolvedBlocks;
            } catch (err) {
                console.warn(`SteemWorld SDS failed at step "${sdsStep}":`, err);
                loadingStatus.textContent = 'SDS unavailable; scanning null history...';
                loadingProgress.textContent += ` (SDS ${sdsStep} failed: ${err.message})`;
                const history = await api.getAccountHistory('null', timeConstraint, earliestTimeMs);
                for (const item of history) {
                    const op = item.op;
                    if (op[0] === 'transfer' && op[1].from === account && op[1].to === 'null') {
                        const [valStr, asset] = op[1].amount.split(' ');
                        transfers.push({
                            time: new Date(item.timestamp + 'Z').getTime() / 1000,
                            from: op[1].from,
                            to: op[1].to,
                            amount: parseFloat(valStr),
                            unit: asset,
                            memo: op[1].memo,
                            candidateBlock: item.block // history already knows the block
                        });
                    }
                }
            }

            // Transfers that resolve to the same block
            const transfersByBlock = {};
            for (const t of transfers) {
                (transfersByBlock[t.candidateBlock] = transfersByBlock[t.candidateBlock] || []).push(t);
            }

            // 3) Fetch each unique block once (parallel). Capture per-asset burners,
            //    the account's transaction id (to seed the card hash), and the block
            //    timestamp so we can correct SteemWorld's off-by-one.
            const blockCache = {};
            const getBlockInfo = async (blockNum) => {
                if (blockCache[blockNum]) return blockCache[blockNum];
                const blockData = await api.getBlock(blockNum);
                const burners = { STEEM: {}, SBD: {} };
                const accountTrxIds = { STEEM: null, SBD: null };
                const ts = blockData && blockData.timestamp ? blockData.timestamp : null;
                if (blockData && blockData.transactions) {
                    for (const tx of blockData.transactions) {
                        for (const op of tx.operations) {
                            if (op[0] === 'transfer' && op[1].to === 'null') {
                                const from = op[1].from;
                                const [valStr, asset] = op[1].amount.split(' ');
                                const val = parseFloat(valStr);
                                if (!burners[asset][from]) burners[asset][from] = 0;
                                burners[asset][from] += val;
                                if (from === account && (tx.transaction_id || tx.trx_id)) {
                                    accountTrxIds[asset] = tx.transaction_id || tx.trx_id;
                                }
                            }
                        }
                    }
                }
                blockCache[blockNum] = {
                    time: ts ? new Date(ts + "Z").getTime() / 1000 : null,
                    ts,
                    burners,
                    accountTrxIds
                };
                return blockCache[blockNum];
            };

            const uniqueBlocks = Object.keys(transfersByBlock).map(Number);

            // This block-fetching phase is where BurnMaxxers are identified: each block
            // is fetched (via callSteem/getBlock) to read who burned to null. Set the
            // status here and track progress as blocks are fetched.
            loadingStatus.textContent = 'Identifying BurnMaxxers...';
            let fetchedBlocks = 0;
            const totalBlocksToFetch = uniqueBlocks.length;
            loadingProgress.textContent = `Fetched 0 of ${totalBlocksToFetch.toLocaleString()} blocks`;
            const tickGetBlockInfo = async (blockNum) => {
                const info = await getBlockInfo(blockNum);
                fetchedBlocks++;
                loadingProgress.textContent = `Fetched ${fetchedBlocks.toLocaleString()} of ${totalBlocksToFetch.toLocaleString()} blocks`;
                return info;
            };
            await mapWithConcurrency(uniqueBlocks, BLOCK_CONCURRENCY, tickGetBlockInfo);

            // Build the set of neighbor blocks to fetch for the content-based verification.
            // The estimate can only be at or slightly before the real block (blocks are
            // never produced faster than 3s), so the drift is always forward — we only
            // need +1 (and +2 as a safety buffer for rare missed blocks).
            const neighborSet = new Set();
            for (const b of uniqueBlocks) {
                neighborSet.add(b + 1);
                neighborSet.add(b + 2);
            }

            // Fetch those neighbor blocks so the content-based verification below can
            // reassign a transfer when the block estimate is off by a block or two.
            loadingStatus.textContent = 'Verifying block assignments...';
            const neighborList = [...neighborSet];
            let fetchedNeighborCount = 0;
            loadingProgress.textContent = `Verified 0 of ${neighborList.length.toLocaleString()} neighbor blocks`;
            const tickNeighbor = async (blockNum) => {
                const info = await getBlockInfo(blockNum);
                fetchedNeighborCount++;
                loadingProgress.textContent = `Verified ${fetchedNeighborCount.toLocaleString()} of ${neighborList.length.toLocaleString()} neighbor blocks`;
                return info;
            };
            await mapWithConcurrency(neighborList, BLOCK_CONCURRENCY, tickNeighbor);

            // Verify each transfer is actually present in its candidate block. If the block
            // attribution is ever off (e.g. a different steemworld offset), check the
            // neighboring blocks and reassign to whichever actually contains the burn.
            // Matching is by (amount, unit) for this account.
            const accountBurnsByBlock = {};
            for (const t of transfers) {
                const belongsTo = (blockNum) => {
                    const info = blockCache[blockNum];
                    if (!info) return false;
                    const burners = info.burners[t.unit] || {};
                    return burners[account] >= t.amount;
                };

                let actualBlock = t.candidateBlock;
                if (!belongsTo(actualBlock)) {
                    // Drift is always forward; only the next couple of blocks can hold it.
                    for (let d = 1; d <= 2; d++) {
                        const bn = t.candidateBlock + d;
                        if (belongsTo(bn)) { actualBlock = bn; break; }
                    }
                }

                if (!accountBurnsByBlock[actualBlock]) accountBurnsByBlock[actualBlock] = { STEEM: 0, SBD: 0, timestamp: (blockCache[actualBlock] && blockCache[actualBlock].ts) || null };
                accountBurnsByBlock[actualBlock][t.unit] += t.amount;
            }

            // 4) Determine winners per block (parallel).
            const blockNums = Object.keys(accountBurnsByBlock).sort((a, b) => b - a); // Newest first
            const totalSteem = Object.values(accountBurnsByBlock).reduce((s, b) => s + b.STEEM, 0);
            const totalSbd = Object.values(accountBurnsByBlock).reduce((s, b) => s + b.SBD, 0);
            const burnTransactionCount = transfers.length;

            let processed = 0;
            loadingStatus.textContent = 'Identifying BurnMaxxers...';
            loadingProgress.textContent = `Checked 0 of ${blockNums.length.toLocaleString()} BurnMaxxer operations`;

            async function processBlock(blockNumStr) {
                const blockNum = Number(blockNumStr);
                const userBurn = accountBurnsByBlock[blockNum];
                const info = await getBlockInfo(blockNum);
                const found = [];

                for (const asset of ['STEEM', 'SBD']) {
                    if (userBurn[asset] > 0) {
                        let max = 0;
                        let winner = null;
                        const burners = (info && info.burners[asset]) || {};
                        for (const [burner, amount] of Object.entries(burners)) {
                            if (amount > max) { max = amount; winner = burner; }
                        }
                        if (winner === account) {
                            const serial = `${blockNum}.${asset === 'STEEM' ? 0 : 1}`;
                            const trxId = (info && info.accountTrxIds[asset]) || '';
                            const resolved = await api.resolveCardForBlock(serial, trxId);
                            found.push({
                                account: account,
                                status: resolved.status,
                                className: resolved.className,
                                rarity: resolved.rarity,
                                card: resolved.card,
                                block: blockNum,
                                trx_id: trxId,
                                serial: serial,
                                timestamp: userBurn.timestamp
                            });
                        }
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

            const toolbar = document.getElementById('search-toolbar');
            const viewToggle = document.getElementById('view-toggle');
            const filterSpecies = document.getElementById('filter-species');
            const filterClass = document.getElementById('filter-class');
            const filterRarity = document.getElementById('filter-rarity');
            const sortBy = document.getElementById('sort-by');
            const sortDirBtn = document.getElementById('sort-dir');
            const state = { view: 'all', species: '', cls: '', rarity: '', sortKey: 'species', sortDir: 'asc' };

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

            const sortCards = (arr) => [...arr].sort((a, b) => {
                let val;
                if (state.sortKey === 'rarity') {
                    val = (rarityRankAll[a.rarity] ?? -1) - (rarityRankAll[b.rarity] ?? -1);
                } else if (state.sortKey === 'class') {
                    val = (classRank[a.cls] ?? 999) - (classRank[b.cls] ?? 999) || String(a.cls).localeCompare(String(b.cls));
                } else {
                    val = String(a.species ?? '').localeCompare(String(b.species ?? ''));
                }
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
                const filtered = sortCards(getFilteredCards());
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
                    groups.forEach(g => grid.appendChild(renderCardEl(g.item, g.serials.length, g.serials)));
                } else {
                    // All cards, each with its own serial number (newest first).
                    filtered.forEach(c => grid.appendChild(renderCardEl(c, 1, [c.serial])));
                }
            };

            viewToggle.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-view]');
                if (!btn) return;
                state.view = btn.dataset.view;
                viewToggle.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b === btn));
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
            renderSummary();

            if (wonCards.length === 0) {
                summaryContainer.innerHTML = '';
                grid.innerHTML = '<p class="status-message" style="grid-column: 1/-1;">No cards found for this account in the selected timeframe.</p>';
            } else {
                toolbar.style.display = 'block';
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
