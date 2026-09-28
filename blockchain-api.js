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
            const res = await fetch('cards-config.json?v=' + Date.now());
            const config = await res.json();
                        this.cardsConfig = config.cards || [];
            this.classOrder = Object.keys(config.class_weights || {}).sort((a, b) => a.localeCompare(b));
            this.classWeights = this.classOrder.map(c => config.class_weights[c]);
            this.classWeightsObj = config.class_weights || {};
            this.beneficiaries = config.beneficiaries || {};
            this.rawConfig = config; // full config (used for rarity_difficulty / RABD)
        } catch (e) {
            console.error("Failed to load cards config", e);
        }
    }

    // The Steem node intermittently returns transient errors: HTTP 429/5xx,
    // empty/non-JSON bodies, and application-level RPC errors such as
    // "Upstream temporarily unavailable". Long searches issue many RPC calls,
    // so a brief upstream outage previously aborted the whole run after only
    // ~2.4s of retries. Use exponential backoff with jitter and a larger
    // budget so a short outage is ridden out instead of failing the search.
    async callSteem(method, params, retries = 6) {
        const payload = {
            jsonrpc: "2.0",
            method: method,
            params: params,
            id: 1
        };
        const RETRY_BASE_MS = 600;   // first retry delay
        const RETRY_MAX_MS = 8000;   // per-attempt delay cap
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetch(STEEM_API_URL, {
                    method: 'POST',
                    body: JSON.stringify(payload),
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!response.ok) {
                    // 429/5xx are transient; let the retry loop handle them.
                    throw new Error(`HTTP ${response.status}`);
                }
                let data;
                try {
                    data = await response.json();
                } catch (e) {
                    // Empty or non-JSON body (e.g. a proxy/rate-limit page) — retry.
                    throw new Error(`Invalid JSON response for ${method}`);
                }
                if (data.error) throw new Error(data.error.message);
                return data.result;
            } catch (e) {
                lastErr = e;
                if (attempt === retries) break;
                // Exponential backoff with +/-25% jitter so concurrent retries
                // don't line up and re-hammer the node at the same moment.
                const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
                const delay = Math.round(base * (0.75 + Math.random() * 0.5));
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastErr;
    }

    // Deterministic hashing and resolution now live in the shared
    // `card-resolver` module (single source of truth). card-resolver.js is
    // loaded before this file and exposes the global `CardResolver`.
    async hashForSerial(serialNumber, blockHash) {
        return CardResolver.hashForSerial(serialNumber, blockHash);
    }

    async resolveCardForBlock(serialNumber, blockHash, opts) {
        opts = opts || {};
        let constraints = null;
        // RABD: if rarity_difficulty is configured, pass the effective per-rarity
        // minimum burns + this block's winning burn amount so the resolver can
        // cascade a below-threshold award down to a qualifying rarity.
        // The serial number suffix (".0" = STEEM, ".1" = SBD) selects which
        // asset's minimums apply.
        if (this.rawConfig && this.rawConfig.rarity_difficulty) {
            const blockNum = parseInt(String(serialNumber).split('.')[0], 10);
            const parts = String(serialNumber).split('.');
            const isSbd = parts.length > 1 && parts[1] === '1';
            const minBurns = isSbd
                ? (this.getEffectiveMinBurnsSBD(blockNum) || {})
                : (this.getEffectiveMinBurns(blockNum) || {});
            constraints = {
                rarity_min_burn: minBurns,
                winning_burn_amount: opts.winningBurnAmount
            };
        }
        // Always apply the tie flag if present (works with or without RABD).
        if (opts.tie) {
            if (!constraints) constraints = {};
            constraints.tie = true;
        }
        return CardResolver.resolveCardForBlock(serialNumber, blockHash, {
            cards: this.cardsConfig,
            class_weights: this.classWeightsObj,
            slot_layouts: this.rawConfig ? this.rawConfig.slot_layouts : null
        }, constraints);
    }

    // Effective per-rarity minimum burns for a block (RABD). Delegates to the
    // shared difficulty.js module. Returns the standard shape even when
    // rarity_difficulty is absent/disabled (all zeroes → nothing is gated).
    getEffectiveMinBurns(blockNum) {
        if (!this.rawConfig) return null;
        return CardDifficulty.effectiveMinBurns(blockNum, this.rawConfig);
    }

    // Same but for SBD asset minimums.
    getEffectiveMinBurnsSBD(blockNum) {
        if (!this.rawConfig) return null;
        return CardDifficulty.effectiveMinBurnsSBD(blockNum, this.rawConfig);
    }

    // Current chain head block via dynamic global properties.
    async getCurrentBlock() {
        const props = await this.callSteem('condenser_api.get_dynamic_global_properties', []);
        return parseInt(props.head_block_number, 10);
    }

    // Everything a difficulty-dashboard UI needs for one block: per-rarity
    // effective minimum burns and the block at which a floor-adjustment
    // schedule milestone kicks in. Returns null when rarity_difficulty is absent.
    getDifficultyDashboard(blockNum) {
        const rd = this.rawConfig && this.rawConfig.rarity_difficulty;
        if (!rd) return null;
        const conf = CardDifficulty.normalize(this.rawConfig);
        // Earliest future schedule milestone that actually changes floors for
        // either asset (STEEM or SBD). Checks both base_min_burns and
        // base_min_burns_sbd, so a milestone that only touches SBD is found.
        let nextFloorBlock = null;
        const currentSteem = this.getEffectiveMinBurns(blockNum) || {};
        const currentSbd = this.getEffectiveMinBurnsSBD(blockNum) || {};
        for (const m of conf.schedule) {
            if (m.block <= blockNum) continue;
            if (!m.base_min_burns_steem && !m.base_min_burns_sbd) continue;
            const afterSteem = CardDifficulty.effectiveMinBurns(m.block, this.rawConfig);
            const afterSbd = CardDifficulty.effectiveMinBurnsSBD(m.block, this.rawConfig);
            const changed = Object.keys(currentSteem).some(
                r => (afterSteem[r] || 0) !== (currentSteem[r] || 0)
                  || (afterSbd[r] || 0) !== (currentSbd[r] || 0)
            );
            if (changed) { nextFloorBlock = m.block; break; }
        }
        return {
            enabled: rd.enabled_block != null,
            enabledBlock: rd.enabled_block,
            currentBlock: blockNum,
            minBurnsSteem: currentSteem,
            minBurnsSbd: currentSbd,
            nextFloorBlock: nextFloorBlock,
            blocksRemaining: nextFloorBlock != null ? Math.max(0, nextFloorBlock - blockNum) : null
        };
    }

    // Fetch block data to verify winners in a specific block
    async getBlock(blockNum) {
        return await this.callSteem('condenser_api.get_block', [blockNum]);
    }

    // Fetch account metadata (e.g. creation time) for a list of account names.
    // Returns an array of account objects; each has a `created` ISO timestamp.
    async getAccounts(names) {
        return await this.callSteem('condenser_api.get_accounts', [names]);
    }

    // Fetch account history with time constraints.
    // Paginates back from the present (newest first).
    //   timeConstraintMs - optional window: stop when an op is older than this
    //                      many milliseconds before now.
    //   earliestTimeMs   - optional absolute lower bound (ms epoch): stop when an
    //                      op is older than this timestamp. Used to bound the scan
    //                      by an account's creation time, so we never paginate
    //                      further back than the account could have existed.
    async getAccountHistory(account, timeConstraintMs, earliestTimeMs, onProgress) {
        let history = [];
        let start = -1;
        let limit = 100;
        let keepFetching = true;
        const now = Date.now();
        let frontierTs = null; // raw timestamp of the oldest history op scanned so far

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

                if (earliestTimeMs && txTime < earliestTimeMs) {
                    keepFetching = false;
                    break;
                }

                history.push(tx);
                frontierTs = tx.timestamp;
            }

            // Report live progress (e.g. number of history operations scanned so far)
            if (onProgress) onProgress(history.length, frontierTs);
            
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

// --- Card image loading ----------------------------------------------------
// Shared by search.js and leaderboard.js. Every card image is loaded through
// this one path and the URL is always taken from `cards-config.json`, so no
// image source (postimg, an IPFS gateway, any CDN) is ever hard-coded.
//
// Design goals (from the "slow images" review):
//   1. Never give up while the image is still reachable. Transient failures
//      (network blips, 5xx, empty bodies, hotlink/rate limits) are retried
//      indefinitely with exponential backoff. We only stop on a definitive
//      404/410, or when the <img> leaves the DOM.
//   2. Always show activity. Each card shows a spinner plus live download
//      progress ("Loading… 42%") or a retry counter, so it never looks stuck.
//   3. Optional local store. When the "store images locally" toggle is on
//      (the default), images are kept in IndexedDB and served from there
//      first, so repeat visits need no network at all.
//
// Loading stays lazy (a single IntersectionObserver assigns work only as a
// card approaches the viewport) so we never fire hundreds of simultaneous
// requests. For each visible image we try, in order:
//   a. IndexedDB, when the local store is enabled and the image is cached;
//   b. fetch() with a ReadableStream, which gives byte-level progress and lets
//      us store the blob — this needs the host to allow CORS (postimg and the
//      common IPFS gateways do);
//   c. a plain <img src> fallback for hosts that send no CORS headers (the
//      image still displays; only the progress bar / local store are skipped).
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// The shared image loader, exposed as window.CardImages so page scripts can
// render the store toggle and (re)drive loading.
window.CardImages = (function () {
    var PREF_KEY = 'animalCards.storeImages';
    var DB_NAME = 'animalCards-image-cache';
    var DB_VERSION = 1;
    var STORE_NAME = 'images';
    var RETRY_BASE_MS = 1500;   // first retry delay
    var RETRY_MAX_MS = 30000;   // exponential-backoff cap
    var dbPromise = null;

    // ---- Local store (IndexedDB), keyed by image URL ------------------------
    function dbSupported() {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    }
    function openDb() {
        if (!dbSupported()) return Promise.reject(new Error('IndexedDB unavailable'));
        return new Promise(function (resolve, reject) {
            var req;
            try { req = indexedDB.open(DB_NAME, DB_VERSION); }
            catch (e) { reject(e); return; }
            req.onupgradeneeded = function (e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                }
            };
            req.onsuccess = function (e) { resolve(e.target.result); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    }
    function getDb() {
        if (!dbPromise) dbPromise = openDb();
        return dbPromise;
    }
    function getImage(url) {
        return getDb().then(function (db) {
            return new Promise(function (resolve) {
                var tx = db.transaction(STORE_NAME, 'readonly');
                var req = tx.objectStore(STORE_NAME).get(url);
                req.onsuccess = function () { resolve(req.result ? req.result.blob : null); };
                req.onerror = function () { resolve(null); };
            });
        }).catch(function () { return null; });
    }
    function putImage(url, blob) {
        return getDb().then(function (db) {
            return new Promise(function (resolve) {
                var tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put({ url: url, blob: blob, storedAt: Date.now() });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { resolve(false); };
                tx.onabort = function () { resolve(false); };
            });
        }).catch(function () { return false; });
    }

    // ---- Preference (default: on) -------------------------------------------
    function isEnabled() {
        try {
            var raw = localStorage.getItem(PREF_KEY);
            return raw === null ? true : raw === '1';
        } catch (e) { return true; }
    }
    function setEnabled(on) {
        try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    }
    // Wire up any checkbox carrying data-store-images-toggle.
    function initControls(root) {
        (root || document).querySelectorAll('[data-store-images-toggle]').forEach(function (box) {
            box.checked = isEnabled();
            if (box.dataset.bound === '1') return;
            box.dataset.bound = '1';
            box.addEventListener('change', function () { setEnabled(box.checked); });
        });
    }
    // Keep open tabs in sync: the `storage` event fires only in *other* tabs
    // when localStorage changes, so toggling the checkbox in one tab updates
    // the checkboxes here too, without a reload.
    window.addEventListener('storage', function (e) {
        if (e.key === PREF_KEY) initControls();
    });

    // ---- DOM state helpers --------------------------------------------------
    // All of these tolerate images that have no .card-image-container (the
    // leaderboard thumbnail chips), where the state lives on the <img> alone.
    function containerOf(img) {
        return img.closest ? img.closest('.card-image-container') : null;
    }
    function setStatusText(img, text) {
        var c = containerOf(img);
        var el = c && c.querySelector('.card-image-status-text');
        if (el) el.textContent = text;
    }
    function setProgress(img, pct) {
        var c = containerOf(img);
        var bar = c && c.querySelector('.card-image-progress-bar');
        if (!bar) return;
        bar.style.width = (typeof pct === 'number' && isFinite(pct))
            ? Math.max(3, Math.min(100, pct)) + '%'
            : '0%';
    }
    function markLoading(img, on) {
        var c = containerOf(img);
        if (c) c.classList.toggle('card-image-loading', on);
        img.classList.toggle('card-image-loading', on);
    }
    function markLoaded(img) {
        markLoading(img, false);
        img.classList.remove('card-image-error');
        var c = containerOf(img);
        if (c) c.classList.remove('card-image-error');
        img.classList.add('loaded');
        img.dataset.state = 'loaded';
    }
    function markError(img) {
        markLoading(img, false);
        img.classList.remove('loaded');
        img.classList.add('card-image-error');
        var c = containerOf(img);
        if (c) {
            c.classList.add('card-image-error');
            setStatusText(img, 'Image unavailable');
        }
        img.dataset.state = 'error';
    }
    function isAlive(img) {
        return !!(img && document.body && document.body.contains(img));
    }
    function formatBytes(n) {
        if (!n) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return Math.round(n / 1024) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    // ---- The loader ---------------------------------------------------------
    // Load `img` from its data-src: local store first (when enabled), then the
    // network. Retries forever on transient failures and reports progress.
    function load(img) {
        if (!img || img.dataset.ciLoading === '1' || img.dataset.state === 'loaded') return;
        var url = img.getAttribute('data-src');
        if (!url) return;
        img.dataset.ciLoading = '1';
        img.removeAttribute('data-src');   // __cardImgInit must not re-queue it
        markLoading(img, true);
        setStatusText(img, 'Loading…');
        setProgress(img, 0);

        var attempt = 0;
        var objectUrl = null;

        function showBlob(blob) {
            if (!isAlive(img)) return;
            if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (e) {} }
            objectUrl = URL.createObjectURL(blob);
            img.onload = function () { markLoaded(img); };
            img.onerror = function () { retryLater(); };   // odd blob; re-fetch
            img.src = objectUrl;
        }
        function showNetworkUrl() {
            // Fallback for hosts without CORS headers: the browser can still
            // display the image even though fetch() could not read the bytes.
            if (!isAlive(img)) return;
            img.onload = function () { markLoaded(img); };
            img.onerror = function () { retryLater(); };
            img.src = url;
        }
        function finish(blob) {
            if (!blob || !blob.size) { retryLater(); return; }
            showBlob(blob);
            if (isEnabled()) putImage(url, blob);
        }
        function retryLater() {
            if (!isAlive(img)) return;
            attempt++;
            var delay = Math.min(RETRY_BASE_MS * Math.pow(2, Math.min(attempt, 8)), RETRY_MAX_MS);
            markLoading(img, true);
            setStatusText(img, 'Still loading… retrying (' + attempt + ')');
            setTimeout(function () { if (isAlive(img)) networkAttempt(); }, delay);
        }
        function networkAttempt() {
            if (!isAlive(img)) return;
            markLoading(img, true);
            fetchWithProgress().then(function (result) {
                // 'fallback' means fetch could not read the bytes (no CORS):
                // let the browser load the image directly instead.
                if (result === 'fallback') showNetworkUrl();
            }).catch(function () { retryLater(); });
        }
        function fetchWithProgress() {
            if (typeof fetch !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) {
                return Promise.resolve('fallback');
            }
            return fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
                .then(function (res) {
                    if (!res.ok) {
                        // 404/410 are definitive: stop, the image is gone.
                        if (res.status === 404 || res.status === 410) { markError(img); return 'done'; }
                        // 403/429/5xx are usually hotlink or rate limits: retry.
                        var e1 = new Error('HTTP ' + res.status); e1.retry = true; throw e1;
                    }
                    var ct = (res.headers.get('content-type') || '').toLowerCase();
                    if (ct && ct.indexOf('image/') !== 0 && ct.indexOf('application/octet-stream') !== 0) {
                        var e2 = new Error('Not an image: ' + ct); e2.retry = true; throw e2;
                    }
                    var total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
                    if (!res.body || typeof res.body.getReader !== 'function') {
                        return res.blob().then(function (b) { finish(b); return 'done'; });
                    }
                    var reader = res.body.getReader();
                    var chunks = [];
                    var received = 0;
                    function pump() {
                        return reader.read().then(function (chunk) {
                            if (chunk.done) {
                                finish(new Blob(chunks, { type: ct || 'image/png' }));
                                return 'done';
                            }
                            chunks.push(chunk.value);
                            received += chunk.value.length || 0;
                            if (total) {
                                var pct = received / total * 100;
                                setStatusText(img, 'Loading… ' + Math.round(pct) + '%');
                                setProgress(img, pct);
                            } else {
                                setStatusText(img, 'Loading… ' + formatBytes(received));
                                setProgress(img, null);
                            }
                            return pump();
                        });
                    }
                    return pump();
                })
                .catch(function (err) {
                    if (err && err.retry) throw err;   // -> retryLater()
                    return 'fallback';                 // no CORS / offline -> native <img>
                });
        }

        // Kick off: local store first when enabled, otherwise straight to network.
        if (isEnabled()) {
            getImage(url).then(function (blob) {
                if (blob && blob.size > 0) showBlob(blob);
                else networkAttempt();
            }).catch(function () { networkAttempt(); });
        } else {
            networkAttempt();
        }
    }

    // ---- Public API ---------------------------------------------------------
    return {
        load: load,
        isEnabled: isEnabled,
        setEnabled: setEnabled,
        initControls: initControls,
        getImage: getImage,
        putImage: putImage
    };
})();

// Reflect the saved preference in any on-page checkbox once the DOM is ready.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.CardImages.initControls(); });
} else {
    window.CardImages.initControls();
}

// Lazily start loading every not-yet-requested image under `root`. A single
// IntersectionObserver assigns work only as an image approaches the viewport
// (300px prefetch margin), so we never fire hundreds of requests at once.
window.__cardImgIO = null;
window.__cardImgLazyLoad = function (img) {
    if (!img || !img.getAttribute('data-src')) return;
    if (!('IntersectionObserver' in window)) {
        // No observer support: load it right away so nothing stays blank.
        window.CardImages.load(img);
        return;
    }
    if (!window.__cardImgIO) {
        window.__cardImgIO = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                window.__cardImgIO.unobserve(entry.target);
                window.CardImages.load(entry.target);
            });
        }, { rootMargin: '300px 0px' });
    }
    window.__cardImgIO.observe(img);
};

// Start loading every not-yet-requested image under `root`. Safe to call
// repeatedly: already-loaded / already-queued images are no-ops.
window.__cardImgInit = function (root) {
    (root || document).querySelectorAll('img[data-src]').forEach(window.__cardImgLazyLoad);
};

// Build a card image: a species-initial fallback, a live status overlay with a
// spinner and progress bar, and the <img> itself. Only the URL is ever taken
// from the card, so any host works. opts.badge is optional extra HTML.
function cardImageTag(card, opts) {
    opts = opts || {};
    var src = (card && card.image_url) || '';
    var alt = (card && card.species) || 'Card';
    var initial = (alt.charAt(0) || '?').toUpperCase();
    var imgTag = src
        ? '<img data-src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" class="card-image" ' +
          'decoding="async" referrerpolicy="no-referrer">'
        : '';
    return '<div class="card-image-container">' +
        '<span class="card-image-fallback" aria-hidden="true">' + escapeHtml(initial) + '</span>' +
        '<div class="card-image-status">' +
            '<span class="card-image-spinner" aria-hidden="true"></span>' +
            '<span class="card-image-status-text">Loading…</span>' +
        '</div>' +
        '<div class="card-image-progress" aria-hidden="true"><div class="card-image-progress-bar"></div></div>' +
        imgTag +
        (opts.badge || '') +
        '</div>';
}

// Thumbnail variant for the leaderboard chips / inline card lists. Same loader,
// but no overlay: the element itself pulses until the image arrives.
// opts.imgStyle lets a caller keep its own inline sizing.
function cardThumbTag(card, opts) {
    opts = opts || {};
    var src = (card && card.image_url) || '';
    if (!src) return '';
    var alt = (card && card.species) || 'Card';
    return '<img data-src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" class="card-thumb-img"' +
        (opts.imgStyle ? ' style="' + opts.imgStyle + '"' : '') +
        ' decoding="async" referrerpolicy="no-referrer">';
}
// Render the RABD difficulty dashboard into `#difficulty-dashboard` (if present).
// Shared by leaderboard.html and search.html. The element is a left sidebar
// panel: title · per-rarity minimums · current block · next adjustment (only
// when it actually matters). Silently hides itself if the config has no
// rarity_difficulty block or the element is missing.
async function renderDifficultyDashboard() {
    const el = document.getElementById('difficulty-dashboard');
    if (!el) return;
    const show = () => { el.classList.add('show'); el.style.display = ''; };
    const hide = () => { el.classList.remove('show'); el.style.display = 'none'; };
    try {
        if (!api.rawConfig) await api.loadConfig();
        const currentBlock = await api.getCurrentBlock();
        const info = api.getDifficultyDashboard(currentBlock);
        if (!info) { hide(); return; }

        const rarities = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
        const fmt = v => Number(v).toFixed(3).replace(/\.?0+$/, '') || '0';
        const fmtDuration = blocks => {
            const s = blocks * 3;
            const d = Math.floor(s / 86400);
            const h = Math.floor((s % 86400) / 3600);
            const m = Math.floor((s % 3600) / 60);
            if (d > 0) return `~${d}d ${h}h`;
            if (h > 0) return `~${h}h ${m}m`;
            return `~${m}m`;
        };
        const fmtRange = (s, sb) => `${fmt(s)} / ${fmt(sb)}`;

        const head = `<div class="dash-head">
                <span class="dash-title">Burn Minimums</span>
            </div>`;

        let body;
        if (!info.enabled) {
            body = `<p class="dash-note">not yet activated</p>`;
        } else {
            body = `<div class="dash-table">` +
                `<span class="dash-colhead" style="grid-column: 2 / -1; text-align: right;">STEEM / SBD</span>` +
                rarities.map(r =>
                `<i class="dash-dot" data-r="${r.toLowerCase()}"></i>` +
                `<span class="dash-name">${r}</span>` +
                `<span class="dash-val">${fmtRange(info.minBurnsSteem[r], info.minBurnsSbd[r])}</span>`
            ).join('') + `</div>`;
        }

        const foot = info.nextFloorBlock != null
            ? `<div class="dash-foot">Next floor adjustment
                    <b>#${info.nextFloorBlock.toLocaleString()}</b>
                    <span class="dash-in">· ${fmtDuration(info.blocksRemaining)}</span></div>`
            : '';

        el.innerHTML = head + body + foot;
        show();
    } catch (e) {
        console.error('Difficulty dashboard failed:', e);
        hide();
    }
}
