// Helper: format a UTC ISO timestamp as GMT string
function formatGMT(timestamp) {
    const d = new Date(timestamp + 'Z');
    if (isNaN(d.getTime())) return '';
    const parts = Intl.DateTimeFormat('en-GB', {
        timeZone: 'GMT', hour12: false,
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(d);
    const get = (t) => (parts.find(x => x.type === t) || {}).value || '';
    return get('day') + ' ' + get('month') + ' ' + get('year') + ' ' + get('hour') + ':' + get('minute') + ':' + get('second') + ' GMT';
}

// Run an async fn over items with at most `concurrency` tasks in flight.
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
    const form = document.getElementById('collections-form');
    const accountInput = document.getElementById('account-input');
    const timeFilter = document.getElementById('time-filter');
    const loading = document.getElementById('loading');
    const content = document.getElementById('collections-content');
    const loadingStatus = document.getElementById('loading-status');
    const loadingProgress = document.getElementById('loading-progress');
    const streakSection = document.getElementById('streak-section');
    const rarityContainer = document.getElementById('rarity-collections');
    const classContainer = document.getElementById('class-collections');
    const deckContainer = document.getElementById('deck-collection');

    renderDifficultyDashboard();

    // --- Build the "current deck" from cards-config.json ---
    function buildDeck(cards) {
        const deck = new Map();
        const byRarity = new Map();
        const byClass = new Map();
        const rarities = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
        rarities.forEach(r => byRarity.set(r, []));
        const classes = Object.keys(api.classWeightsObj);
        classes.forEach(c => byClass.set(c, []));

        for (const card of cards) {
            if (card.is_generic) continue;
            if (!card.rarity || !card.class) continue;
            const key = card.class + '|' + card.rarity + '|' + card.slot;
            const existing = deck.get(key);
            if (!existing || (card.generation || '').localeCompare(existing.generation || '') > 0) {
                deck.set(key, card);
            }
        }

        for (const card of deck.values()) {
            if (byRarity.has(card.rarity)) byRarity.get(card.rarity).push(card);
            if (byClass.has(card.class)) byClass.get(card.class).push(card);
        }

        return { deck, byRarity, byClass };
    }
form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const account = accountInput.value.trim().toLowerCase();
        if (!account) return;

        loading.style.display = 'flex';
        content.style.display = 'none';

        try {
            if (api.cardsConfig.length === 0) await api.loadConfig();

            const accounts = await api.getAccounts([account]);
            const createdMs = accounts && accounts[0] ? new Date(accounts[0].created + 'Z').getTime() : 0;
            const timeConstraint = parseInt(timeFilter.value, 10);
            let earliestTimeMs = timeConstraint ? Date.now() - timeConstraint : 0;
            if (createdMs > earliestTimeMs) earliestTimeMs = createdMs;

            loadingStatus.textContent = 'Fetching burn history...';
            loadingProgress.textContent = '';
            let lastMonthShown = null;
            const history = await api.getAccountHistory('null', timeConstraint, earliestTimeMs, (count, ts) => {
                if (!ts) { loadingProgress.textContent = 'Scanned ' + count.toLocaleString() + ' history ops'; return; }
                const monthKey = ts.slice(0, 7);
                if (monthKey !== lastMonthShown) {
                    lastMonthShown = monthKey;
                    loadingProgress.textContent = 'Scanned ' + count.toLocaleString() + ' history ops \u2014 back to ' + formatGMT(ts);
                }
            });

            // Group burns by block + asset
            const blocksData = {};
            for (const item of history) {
                const op = item.op;
                if (op[0] !== 'transfer' || op[1].to !== 'null') continue;
                const from = op[1].from;
                const [valStr, asset] = op[1].amount.split(' ');
                const val = parseFloat(valStr);
                if (asset !== 'STEEM' && asset !== 'SBD') continue;

                if (!blocksData[item.block]) {
                    blocksData[item.block] = {
                        STEEM: { maxBurn: 0, winners: [], timestamp: item.timestamp },
                        SBD: { maxBurn: 0, winners: [], timestamp: item.timestamp }
                    };
                }
                const slot = blocksData[item.block][asset];
                if (val > slot.maxBurn) {
                    slot.maxBurn = val;
                    slot.winners = [{ account: from, trx_id: item.trx_id, timestamp: item.timestamp }];
                } else if (val === slot.maxBurn) {
                    slot.winners.push({ account: from, trx_id: item.trx_id, timestamp: item.timestamp });
                }
            }

            const blockNums = Object.keys(blocksData).sort((a, b) => b - a);
            let processed = 0;
            loadingStatus.textContent = 'Identifying BurnMaxxers...';
            loadingProgress.textContent = 'Checked 0 of ' + blockNums.length.toLocaleString() + ' BurnMaxxer operations';

            const wonCards = [];

            async function processBlock(blockNumStr) {
                const blockNum = Number(blockNumStr);
                const bData = blocksData[blockNum];
                const found = [];
                const accountWon = bData.STEEM.winners.some(we => we.account === account) ||
                    bData.SBD.winners.some(we => we.account === account);

                let blockTimestamp = null;
                if (accountWon) {
                    try {
                        const block = await api.getBlock(blockNum);
                        if (block && block.timestamp) blockTimestamp = block.timestamp;
                    } catch (e) {}
                }

                const fallbackTimestamp = (slotTs) =>
                    new Date(new Date(slotTs + 'Z').getTime() + 3000).toISOString().slice(0, 19);

                for (const asset of ['STEEM', 'SBD']) {
                    const slot = bData[asset];
                    const winEntry = slot.winners.find(we => we.account === account);
                    if (winEntry) {
                        const isTie = slot.winners.length > 1;
                        const serial = blockNum + '.' + (asset === 'STEEM' ? 0 : 1);
                        const resolved = await api.resolveCardForBlock(serial, winEntry.trx_id, { winningBurnAmount: slot.maxBurn, tie: isTie });
                        found.push({
                            account, status: resolved.status, className: resolved.className,
                            rarity: resolved.rarity, card: resolved.card, block: blockNum,
                            trx_id: winEntry.trx_id, serial,
                            timestamp: blockTimestamp || fallbackTimestamp(slot.timestamp)
                        });
                    }
                }
                return found;
            }
const tickingProcessBlock = async (blockNum) => {
                const result = await processBlock(blockNum);
                processed++;
                loadingProgress.textContent = 'Checked ' + processed.toLocaleString() + ' of ' + blockNums.length.toLocaleString() + ' BurnMaxxer operations';
                return result;
            };

            const perBlockCards = await mapWithConcurrency(blockNums, 4, tickingProcessBlock);
            for (const cards of perBlockCards) {
                for (const c of cards) wonCards.push(c);
            }

            // --- Build deck and compute collections ---
            const { deck, byRarity, byClass } = buildDeck(api.cardsConfig);

            const ownedCardIds = new Set();
            const ownedSerials = new Map();
            for (const m of wonCards) {
                if (m.status === 'released' && m.card) {
                    ownedCardIds.add(m.card.card_id);
                    if (!ownedSerials.has(m.card.card_id)) ownedSerials.set(m.card.card_id, []);
                    ownedSerials.get(m.card.card_id).push(m.serial);
                }
            }

            // --- Streak calculation ---
            const winDays = new Set();
            for (const m of wonCards) {
                const d = new Date(m.timestamp + 'Z');
                if (!isNaN(d.getTime())) {
                    winDays.add(d.toISOString().slice(0, 10));
                }
            }

            function computeStreak(daySet) {
                const now = new Date();
                const today = now.toISOString().slice(0, 10);
                const yesterday = new Date(now);
                yesterday.setUTCDate(yesterday.getUTCDate() - 1);
                const yesterdayStr = yesterday.toISOString().slice(0, 10);

                let startDay;
                if (daySet.has(today)) {
                    startDay = today;
                } else if (daySet.has(yesterdayStr)) {
                    startDay = yesterdayStr;
                } else {
                    return { streak: 0, days: [], startDay: null };
                }

                const days = [startDay];
                let cursor = new Date(startDay + 'T00:00:00Z');
                while (true) {
                    cursor.setUTCDate(cursor.getUTCDate() - 1);
                    const prev = cursor.toISOString().slice(0, 10);
                    if (daySet.has(prev)) {
                        days.push(prev);
                    } else {
                        break;
                    }
                }

                return { streak: days.length, days: days.sort(), startDay: startDay };
            }

            const streakResult = computeStreak(winDays);
// --- Render streak ---
            streakSection.innerHTML =
                '<div class="coll-streak-number" style="color:' +
                (streakResult.streak >= 10 ? '#22c55e' : streakResult.streak >= 5 ? '#eab308' : streakResult.streak >= 1 ? '#3b82f6' : '#94a3b8') +
                ';">' + streakResult.streak + '</div>' +
                '<div class="coll-streak-label">BurnMaxxer Title Streak' +
                (streakResult.streak === 1 ? ' (1 day)' : streakResult.streak > 0 ? ' (' + streakResult.streak + ' days)' : '') +
                '</div>' +
                (streakResult.streak > 0
                    ? '<div class="coll-streak-days">Last win: ' + formatGMT(streakResult.days[streakResult.days.length - 1]) +
                    ' | Consecutive since ' + formatGMT(streakResult.days[0]) + '</div>'
                    : '<div class="coll-streak-days">No consecutive daily wins found \u2014 check back after a win</div>');

            // --- Render collection cards ---
            function renderCollectionCard(label, totalCards, ownedIds, allCardsInSet, fillClass) {
                const owned = allCardsInSet.filter(c => ownedIds.has(c.card_id));
                const missing = allCardsInSet.filter(c => !ownedIds.has(c.card_id));
                const pct = totalCards > 0 ? Math.round(owned.length / totalCards * 100) : 0;

                const ownedHtml = owned.length > 0
                    ? '<ul class="coll-card-list" style="list-style:none;padding:0;margin:0;">' +
                    owned.map(c => '<li class="coll-owned">\u2713 ' + c.species + '</li>').join('') + '</ul>'
                    : '<span style="color:var(--text-secondary);font-style:italic;">None owned</span>';

                const missingHtml = missing.length > 0
                    ? '<hr class="coll-separator"><div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:0.25rem;">Missing:</div>' +
                    '<ul class="coll-card-list" style="list-style:none;padding:0;margin:0;">' +
                    missing.map(c => '<li class="coll-missing">\u2717 ' + c.species + '</li>').join('') + '</ul>'
                    : '';

                const toggleHtml = '<details class="coll-details">' +
                    '<summary>Show cards \u25bc</summary>' +
                    ownedHtml + missingHtml + '</details>';

                return '<div class="coll-card">' +
                    '<div class="coll-card-header"><span>' + label + '</span>' +
                    '<span style="font-size:0.9rem;">' + owned.length + ' / ' + totalCards + '</span></div>' +
                    '<div class="coll-card-sub">' + pct + '% complete</div>' +
                    '<div class="coll-progress-bar-bg"><div class="coll-progress-bar-fill ' + fillClass + '" style="width:' + pct + '%;"></div></div>' +
                    toggleHtml + '</div>';
            }

            // --- Entire Deck collection ---
            const allDeckCards = [];
            for (const card of deck.values()) allDeckCards.push(card);
            deckContainer.innerHTML = renderCollectionCard('All Cards', allDeckCards.length, ownedCardIds, allDeckCards, 'fill-Deck');

            const rarities = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
            rarityContainer.innerHTML = '';
            for (const r of rarities) {
                const cardsInRarity = byRarity.get(r) || [];
                if (cardsInRarity.length === 0) continue;
                rarityContainer.innerHTML += renderCollectionCard(r, cardsInRarity.length, ownedCardIds, cardsInRarity, 'fill-' + r);
            }

            const classOrder = Object.keys(api.classWeightsObj);
            classContainer.innerHTML = '';
            for (const cls of classOrder) {
                const cardsInClass = byClass.get(cls) || [];
                if (cardsInClass.length === 0) continue;
                const fillKey = 'fill-' + cls.replace(/[^a-zA-Z]/g, '');
                classContainer.innerHTML += renderCollectionCard(cls, cardsInClass.length, ownedCardIds, cardsInClass, fillKey);
            }

            if (rarityContainer.children.length === 0 && classContainer.children.length === 0) {
                rarityContainer.innerHTML = '<div class="coll-empty">No cards found in the current deck for this account.</div>';
            }

            loading.style.display = 'none';
            content.style.display = 'block';

        } catch (error) {
            console.error(error);
            loading.innerHTML = '<p class="status-message" style="color: #ef4444;">Error: ' + error.message + '</p>';
        }
    }); // end submit
}); // end DOMContentLoaded