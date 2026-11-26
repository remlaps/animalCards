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
function slugify(str) {
    return String(str == null ? '' : str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('collections-form');
    const accountInput = document.getElementById('account-input');
    const timeFilter = document.getElementById('time-filter');
    const loading = document.getElementById('loading');
    const content = document.getElementById('collections-content');
    const loadingStatus = document.getElementById('loading-status');
    const loadingProgress = document.getElementById('loading-progress');
    const loadingError = document.getElementById('loading-error');
    const loadingSpinner = document.querySelector('#loading .spinner');
    const streakSection = document.getElementById('streak-section');
    const rarityContainer = document.getElementById('rarity-collections');
    const classContainer = document.getElementById('class-collections');
    const deckContainer = document.getElementById('deck-collection');

    renderDifficultyDashboard();

    let lastAccount = '';
    let collOwnedMap = {};

    function onCollectionDownload(btn) {
        const label = btn.getAttribute('data-coll-label');
        const owned = collOwnedMap[label] || [];
        if (!owned.length) return;
        const baseName = 'animalCards-' + lastAccount + '-' + slugify(label);
        const orig = btn.textContent;
        btn.disabled = true;
        CardExport.downloadEarnedCards(owned, baseName, function (done, total) {
            btn.textContent = 'Preparing ' + done + '/' + total + '...';
        }).catch(function (err) {
            console.error('animalCards export failed:', err);
            if (typeof alert === 'function') alert('Export failed: ' + ((err && err.message) || err));
        }).then(function () {
            btn.disabled = false;
            btn.textContent = orig;
        });
    }

    [rarityContainer, classContainer, deckContainer].forEach(function (container) {
        container.addEventListener('click', function (e) {
            const btn = e.target && e.target.closest ? e.target.closest('[data-coll-download]') : null;
            if (!btn) return;
            onCollectionDownload(btn);
        });
    });

    // --- Build the "current deck" from cards-config.json ---
    function buildDeck(cards) {
        const deck = new Map();
        const byRarity = new Map();
        const byClass = new Map();
        const rarities = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
        rarities.forEach(r => byRarity.set(r, []));
        const classes = Object.keys(api.classWeightsObj).sort((a, b) => a.localeCompare(b));
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
        lastAccount = account;

        loading.style.display = 'flex';
        content.style.display = 'none';

        // Reset the loader out of any previous error/run so a retry shows
        // fresh progress instead of instantly re-displaying the old failure.
        loadingError.style.display = 'none';
        loadingSpinner.style.display = '';
        loadingStatus.style.display = '';
        loadingProgress.style.display = '';
        loadingStatus.textContent = 'Scanning blockchain for earned cards...';
        loadingProgress.textContent = '';

        try {
            if (api.cardsConfig.length === 0) await api.loadConfig();

            const accounts = await api.getAccounts([account]);
            const createdMs = accounts && accounts[0] ? new Date(accounts[0].created + 'Z').getTime() : 0;
            const timeConstraint = parseInt(timeFilter.value, 10);
            const searchLengthDays = (ms) => ms ? Math.max(1, Math.round(ms / 86400000)) : Infinity;
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

            // Group burns by block + asset (all accounts, for top-burner detection)
            // and record the searched account's own burns (each now yields a card).
            const blocksData = {};
            const transfers = [];
            for (const item of history) {
                const op = item.op;
                if (op[0] !== 'transfer' || op[1].to !== 'null') continue;
                const from = op[1].from;
                const [valStr, asset] = op[1].amount.split(' ');
                const val = parseFloat(valStr);
                if (asset !== 'STEEM' && asset !== 'SBD') continue;

                if (from === account) {
                    transfers.push({ amount: val, unit: asset, block: item.block, trx_id: item.trx_id, timestamp: item.timestamp });
                }

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
                } else if (val === slot.maxBurn && !slot.winners.some(w => w.trx_id === item.trx_id)) {
                    slot.winners.push({ account: from, trx_id: item.trx_id, timestamp: item.timestamp });
                }
            }

            // The account's own burns, grouped by block (one card per burn).
            const transfersByBlock = {};
            for (const t of transfers) {
                (transfersByBlock[t.block] = transfersByBlock[t.block] || []).push(t);
            }
            const awardBlocks = Object.keys(transfersByBlock).map(Number).sort((a, b) => b - a);
            let processed = 0;
            loadingStatus.textContent = 'Resolving your burn cards...';
            loadingProgress.textContent = 'Checked 0 of ' + awardBlocks.length.toLocaleString() + ' burn blocks';

            const wonCards = [];

            async function processBlock(blockNum) {
                const bData = blocksData[blockNum];
                const myBurns = transfersByBlock[blockNum] || [];
                const found = [];

                // Authoritative block timestamp fetched only when this account was a
                // block+asset's sole top burner; otherwise the +3s fallback is used.
                const iWon = myBurns.some(t => {
                    const w = bData[t.unit].winners;
                    return w.length === 1 && w[0].trx_id === t.trx_id;
                });
                let blockTimestamp = null;
                if (iWon) {
                    try {
                        const block = await api.getBlock(blockNum);
                        if (block && block.timestamp) blockTimestamp = block.timestamp;
                    } catch (e) {}
                }

                const fallbackTimestamp = (slotTs) =>
                    new Date(new Date(slotTs + 'Z').getTime() + 3000).toISOString().slice(0, 19);

                for (const t of myBurns) {
                    const slot = bData[t.unit];
                    // Full card only for the block+asset's unique top burner; every
                    // other burn gets the same resolution downgraded one rarity tier.
                    const isWin = slot.winners.length === 1 && slot.winners[0].trx_id === t.trx_id;
                    const serial = blockNum + '.' + (t.unit === 'STEEM' ? 0 : 1);
                    const resolved = await api.resolveCardForBlock(serial, t.trx_id, { winningBurnAmount: t.amount, tie: !isWin });
                    found.push({
                        account, status: resolved.status, className: resolved.className,
                        rarity: resolved.rarity, card: resolved.card, block: blockNum,
                        trx_id: t.trx_id, serial, won: isWin,
                        timestamp: blockTimestamp || fallbackTimestamp(t.timestamp)
                    });
                }
                return found;
            }
            const tickingProcessBlock = async (blockNum) => {
                const result = await processBlock(blockNum);
                processed++;
                loadingProgress.textContent = 'Checked ' + processed.toLocaleString() + ' of ' + awardBlocks.length.toLocaleString() + ' burn blocks';
                return result;
            };

            const perBlockCards = await mapWithConcurrency(awardBlocks, 4, tickingProcessBlock);
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

            // Which card_ids the account holds at least one Male / Female copy of.
            // (Sex comes from the owning serial's block parity: odd block -> Male, even block -> Female.)
            const ownedMaleIds = new Set();
            const ownedFemaleIds = new Set();
            for (const [cardId, serials] of ownedSerials) {
                for (const serial of serials) {
                    const sex = (typeof sexFromSerial === 'function') ? sexFromSerial(serial) : null;
                    if (sex === 'Male') ownedMaleIds.add(cardId);
                    else if (sex === 'Female') ownedFemaleIds.add(cardId);
                }
            }

            // Total individual cards owned (with duplicates) vs. distinct cards.
            const totalCards = Array.from(ownedSerials.values()).reduce((sum, serials) => sum + serials.length, 0);
            const uniqueCards = ownedCardIds.size;

            // Per-card earned info (owner + serials) for the collections download.
            const earnedByCardId = new Map();
            for (const m of wonCards) {
                if (m.status === 'released' && m.card) {
                    if (!earnedByCardId.has(m.card.card_id)) {
                        earnedByCardId.set(m.card.card_id, { card: m.card, account: m.account, serials: [], timestamp: m.timestamp, trx_id: m.trx_id });
                    }
                    earnedByCardId.get(m.card.card_id).serials.push(m.serial);
                }
            }

            // --- Streak calculation (unique top-burner wins only) ---
            const winDays = new Set();
            for (const m of wonCards) {
                if (!m.won) continue;
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
            const streakDays = searchLengthDays(timeConstraint);
            const streakSuffix = (streakResult.streak >= streakDays && streakDays < Infinity) ? '+' : '';
// --- Render streak ---
            streakSection.innerHTML =
                '<div class="coll-streak-number" style="color:' +
                (streakResult.streak >= 10 ? '#22c55e' : streakResult.streak >= 5 ? '#eab308' : streakResult.streak >= 1 ? '#3b82f6' : '#94a3b8') +
                ';">' + streakResult.streak + streakSuffix + '</div>' +
                '<div class="coll-streak-label">BurnMaxxer Title Streak' +
                (streakResult.streak === 1 ? ' (1 day)' : streakResult.streak > 0 ? ' (' + streakResult.streak + streakSuffix + ' days)' : '') +
                '</div>' +
                (streakResult.streak > 0
                    ? '<div class="coll-streak-days">Last win: ' + formatGMT(streakResult.days[streakResult.days.length - 1]) +
                    ' | Consecutive since ' + formatGMT(streakResult.days[0]) + '</div>'
                    : '<div class="coll-streak-days">No consecutive daily wins found \u2014 check back after a win</div>');

            // Show the account's total card count alongside the unique card count.
            streakSection.innerHTML += '<div class="coll-streak-days" style="margin-top:0.5rem;">Cards collected: <strong>' +
                totalCards + ' total</strong> &middot; <strong>' + uniqueCards + ' unique</strong></div>';

            // --- Render collection cards ---
            function renderCollectionCard(label, totalCards, ownedIds, allCardsInSet, fillClass) {
                const owned = allCardsInSet.filter(c => ownedIds.has(c.card_id));
                collOwnedMap[label] = owned.map(function (c) { return earnedByCardId.get(c.card_id); }).filter(Boolean);
                const pct = totalCards > 0 ? Math.round(owned.length / totalCards * 100) : 0;

                // Total physical cards owned in this set (counting duplicate copies).
                const ownedTotal = owned.reduce((sum, c) => sum + (ownedSerials.get(c.card_id) || []).length, 0);

                // Sex breakdown: only species with distinct sexes count toward the
                // Male/Female targets (unsexed/sex-changing species never get a label).
                const sexed = allCardsInSet.filter(c => cardIsSexed(c));
                const maleOwned = sexed.filter(c => ownedMaleIds.has(c.card_id));
                const femaleOwned = sexed.filter(c => ownedFemaleIds.has(c.card_id));
                const malePct = sexed.length > 0 ? Math.round(maleOwned.length / sexed.length * 100) : 0;
                const femalePct = sexed.length > 0 ? Math.round(femaleOwned.length / sexed.length * 100) : 0;

                // Sex-status table: one row per card, owned first, then missing.
                // Any = owned at all; Male/Female = that sex held (?), missing (?), or n/a (-).
                const cell = (held, applicable) => applicable
                    ? (held ? '<span class="sex-yes">✓</span>' : '<span class="sex-no">✗</span>')
                    : '<span class="sex-na">—</span>';
                const rowHtml = (c) => {
                    const isOwned = ownedIds.has(c.card_id);
                    const sexable = cardIsSexed(c);
                    return '<tr class="' + (isOwned ? '' : 'sex-row-missing') + '">' +
                        '<td class="sex-species">' + c.species + '</td>' +
                        '<td>' + cell(isOwned, true) + '</td>' +
                        '<td>' + cell(ownedMaleIds.has(c.card_id), sexable) + '</td>' +
                        '<td>' + cell(ownedFemaleIds.has(c.card_id), sexable) + '</td>' +
                    '</tr>';
                };
                const missing = allCardsInSet.filter(c => !ownedIds.has(c.card_id));
                const ordered = owned.concat(missing);
                const tableHtml = ordered.length > 0
                    ? '<table class="coll-sex-table"><thead><tr>' +
                        '<th>Species</th><th title="Any copy owned">Any</th>' +
                        '<th title="A male copy is owned">♂ Male</th><th title="A female copy is owned">♀ Female</th>' +
                      '</tr></thead><tbody>' + ordered.map(rowHtml).join('') + '</tbody></table>'
                    : '<span style="color:var(--text-secondary);font-style:italic;">No cards in this collection</span>';

                const toggleHtml = '<details class="coll-details">' +
                    '<summary>Show cards ▼</summary>' +
                    tableHtml + '</details>';

                // Male/Female mini progress bars (only when the set has sexed cards).
                const sexBars = sexed.length > 0
                    ? '<div class="coll-card-sub" style="margin-top:0.6rem;">♂ Males: ' + maleOwned.length + ' / ' + sexed.length + ' (' + malePct + '%)</div>' +
                      '<div class="coll-progress-bar-bg"><div class="coll-progress-bar-fill" style="width:' + malePct + '%;background:#3b82f6;"></div></div>' +
                      '<div class="coll-card-sub" style="margin-top:0.6rem;">♀ Females: ' + femaleOwned.length + ' / ' + sexed.length + ' (' + femalePct + '%)</div>' +
                      '<div class="coll-progress-bar-bg"><div class="coll-progress-bar-fill" style="width:' + femalePct + '%;background:#ec4899;"></div></div>'
                    : '';

                return '<div class="coll-card">' +
                    '<div class="coll-card-header"><span>' + label + '</span>' +
                    '<span style="display:inline-flex;align-items:center;gap:0.6rem;">' +
                    '<span style="font-size:0.9rem;">' + owned.length + ' / ' + totalCards + '</span>' +
                    '<span style="font-size:0.9rem;color:var(--text-secondary);">' + ownedTotal + ' total</span>' +
                    (owned.length > 0 ? '<button type="button" class="card-download-btn" data-coll-download data-coll-label="' + label + '">Download (' + owned.length + ')</button>' : '') +
                    '</span></div>' +
                    '<div class="coll-card-sub">' + pct + '% complete</div>' +
                    '<div class="coll-progress-bar-bg"><div class="coll-progress-bar-fill ' + fillClass + '" style="width:' + pct + '%;"></div></div>' +
                    sexBars +
                    toggleHtml + '</div>';
            }

            collOwnedMap = {};

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

            const classOrder = Object.keys(api.classWeightsObj).sort((a, b) => a.localeCompare(b));
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
            // Show the failure without wiping the loader markup, so a retry can
            // reset cleanly and show progress again (references stay valid).
            loadingSpinner.style.display = 'none';
            loadingStatus.style.display = 'none';
            loadingProgress.style.display = 'none';
            loadingError.style.display = 'block';
            loadingError.textContent = 'Error: ' + error.message;
        }
    }); // end submit
}); // end DOMContentLoaded