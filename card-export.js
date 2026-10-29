/**
 * card-export.js
 *
 * Shared "Download as PNG" engine for animalCards.
 *
 * Cards are plain DOM elements (a wildlife photo + CSS chrome), so exporting one
 * to a blog-ready image means snapshotting the element with html-to-image
 * (vendored in vendor/html-to-image.js). This module exposes:
 *
 *   - renderDeckCard(card)      build a catalogue card element from a raw
 *                               cards-config.json entry (deck/gallery view).
 *   - downloadButton(card, opts) HTML string for a per-card "PNG" button.
 *   - downloadNode(node, file)  capture a single card element to a PNG download.
 *   - downloadAll(nodes, base)  capture many cards and download them as a ZIP.
 *
 * Everything is additive and runs entirely client-side; it never touches the
 * card data or the deterministic resolution logic.
 */
(function (root) {
    'use strict';

    // Filename-safe slug: lowercase, non-alphanumerics collapse to a dash.
    function slug(s) {
        return String(s == null ? '' : s)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function deckFilename(card) {
        return ['animalcard', card.class, card.species]
            .map(slug).filter(Boolean).join('-') + '.png';
    }

    function earnedFilename(card) {
        return ['animalcard', card.account, card.cls || card.class, card.species, card.serial]
            .map(slug).filter(Boolean).join('-') + '.png';
    }

    var DOWNLOAD_SVG =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
        '<polyline points="7 10 12 15 17 10"></polyline>' +
        '<line x1="12" y1="15" x2="12" y2="3"></line></svg>';

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // HTML for a compact "Download PNG" button. opts may override the filename
    // (opts.filename) or the earned-card context (opts.account/serial/cls).
    function downloadButton(card, opts) {
        opts = opts || {};
        var filename = opts.filename;
        if (!filename) {
            if (opts.kind === 'earned') {
                filename = earnedFilename({
                    account: opts.account != null ? opts.account : card.account,
                    cls: opts.cls != null ? opts.cls : (card.cls || card.class),
                    species: card.species,
                    serial: opts.serial != null ? opts.serial : card.serial
                });
            } else {
                filename = deckFilename(card);
            }
        }
        return '<button type="button" class="card-download-btn card-export-ctl" data-export ' +
            'data-filename="' + escapeHtml(filename) + '" title="Download as PNG">' +
            DOWNLOAD_SVG + '<span>PNG</span></button>';
    }
    // Make sure every card image in `node` has finished loading before capture.
    // The shared lazy loader (window.CardImages / __cardImgLazyLoad) sets img.src
    // and marks it `.loaded`; here we only wait for that to complete.
    function ensureImagesLoaded(node) {
        var imgs = Array.prototype.slice.call(node.querySelectorAll('img.card-image, img[data-src]'));
        var jobs = imgs.map(function (img) {
            if (img.getAttribute('data-src')) {
                // Force a direct load (the lazy loader only *observes* off-screen
                // images, which would leave below-the-fold cards blank on export).
                if (window.CardImages && window.CardImages.load) window.CardImages.load(img);
                else if (window.__cardImgLazyLoad) window.__cardImgLazyLoad(img);
            }
            return waitForImage(img);
        });
        return Promise.all(jobs);
    }

    // Wait until img is fully loaded (or has definitively failed), then bake it
    // into a data URL. Polls rather than using a fixed timeout so the shared
    // loader's own retry loop (exponential backoff up to 30s per attempt) gets
    // every chance to finish: a slow/hotlinked photo is never captured early.
    // The only give-up is a definitive failure (HTTP 404/410, which sets
    // dataset.state to 'error'); there is intentionally no time cap.
    function waitForImage(img) {
        return new Promise(function (resolve) {
            var finalize = function () {
                if (window.console) {
                    var s = img.currentSrc || img.src || img.getAttribute('src') || '';
                    if (img.dataset.state === 'error') console.warn('[animalCards-export] image failed (404/410):', String(s).slice(0, 60));
                    else console.log('[animalCards-export] image loaded:', String(s).slice(0, 60));
                }
                dataURLify(img).then(resolve, resolve);
            };
            var isLoaded = function () {
                return img.dataset.state === 'loaded' || (img.complete && img.naturalWidth > 0);
            };
            var isFailed = function () { return img.dataset.state === 'error'; };
            var tick = function () {
                if (isLoaded() || isFailed()) { finalize(); return; }
                setTimeout(tick, 200);
            };
            tick();
        });
    }

    // Draw a loaded image to a canvas and swap its src for an inline data URL so
    // html-to-image doesn't have to re-fetch the source (a blob:/remote URL that
    // can be slow, blocked, or revoked). Resolves regardless of outcome; on a
    // tainted canvas it leaves the original src in place.
    function dataURLify(img) {
        return new Promise(function (resolve) {
            var src = img.currentSrc || img.src || img.getAttribute('src') || '';
            if (!src || src.indexOf('data:') === 0) { resolve(); return; }
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) { resolve(); return; }
            var draw = function () {
                try {
                    var MAX = 1200;
                    var scale = Math.min(1, MAX / Math.max(w, h));
                    var canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(w * scale));
                    canvas.height = Math.max(1, Math.round(h * scale));
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    img.src = canvas.toDataURL('image/png');
                    img.classList.add('loaded');
                    img.style.transition = 'none';
                    img.style.opacity = '1';
                    resolve();
                } catch (e) {
                    resolve();
                }
            };
            // Make sure the frame is fully decoded before drawing, so a still-
            // decoding image is never painted partially. If the bytes cannot be
            // decoded at all (corrupt/truncated), flag it and drop the source so
            // the export falls back to the placeholder instead of a broken image.
            var onUndecodable = function () {
                img.dataset.state = 'error';
                try { img.removeAttribute('src'); } catch (e) {}
                resolve();
            };
            if (typeof img.decode === 'function') img.decode().then(draw, onUndecodable);
            else draw();
        });
    }

    // Rarity → border colour + glow (kept in sync with style.css). Used to make
    // the exported PNG match the on-screen card regardless of how html-to-image
    // resolves styles.
    var RARITY_STYLE = {
        Common:    { color: '#64748b', glow: '' },
        Rare:      { color: '#3b82f6', glow: 'rgba(59, 130, 246, 0.45)' },
        Epic:      { color: '#8b5cf6', glow: 'rgba(139, 92, 246, 0.50)' },
        Legendary: { color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.55)' },
        Mythic:    { color: '#ef4444', glow: 'rgba(239, 68, 68, 0.60)' },
        Generic:   { color: '#475569', glow: '' }
    };
    var EXPORT_BORDER_PX = 3;
    var EXPORT_GLOW = '0 0 16px ';
    var EXPORT_PAD_PX = 28;   // padding around the card so the glow isn't clipped
    // Canonical export geometry. Fixing the width means text always wraps at the
    // same point (the live card's width depends on the viewport / grid), and the
    // fixed photo-box height keeps the box at the same aspect as the live card —
    // so wide/flat photos (sideways fish) letterbox instead of being cropped. The
    // minimum card height, together with the reserved line heights in style.css,
    // makes every exported PNG the same size even when a field wraps to 2 lines.
    var EXPORT_CARD_WIDTH = 480;
    var EXPORT_IMAGE_ASPECT = 1.15;  // photo box width ÷ height (matches the live card)
    var EXPORT_IMAGE_HEIGHT = Math.round((EXPORT_CARD_WIDTH - 2 * EXPORT_BORDER_PX) / EXPORT_IMAGE_ASPECT);
    var EXPORT_CARD_HEIGHT = 700;    // canonical minimum card height (px)

    // Snapshot `node` to a PNG data URL. Captures an offscreen clone so the live
    // card is never mutated or reflowed. The clone gets an explicit border + glow
    // and a padded wrapper, producing a self-contained PNG with the rarity frame.
    function captureNode(node) {
        if (!window.htmlToImage) {
            return Promise.reject(new Error('html-to-image is not loaded'));
        }

        var rarity = node.getAttribute('data-rarity') || '';
        var rs = RARITY_STYLE[rarity] || { color: 'rgba(255, 255, 255, 0.12)', glow: '' };

        var clone = node.cloneNode(true);
        clone.classList.add('export-clone');
        clone.style.boxSizing = 'border-box';
        // Canonical size. The width is fixed (the live card's width depends on the
        // viewport / grid), and `minHeight` — rather than a hard height — keeps
        // cards uniform while still letting the occasional extra-long card grow
        // instead of clipping its text.
        clone.style.width = EXPORT_CARD_WIDTH + 'px';
        clone.style.minHeight = EXPORT_CARD_HEIGHT + 'px';
        // Keep the photo box at the live card's aspect ratio at the new width, so
        // the crop/letterbox decision matches what's on screen.
        var imageBox = clone.querySelector('.card-image-container');
        if (imageBox) imageBox.style.height = EXPORT_IMAGE_HEIGHT + 'px';
        clone.style.background = 'linear-gradient(160deg, #1e293b 0%, #0f172a 100%)';
        clone.style.backdropFilter = 'none';
        clone.style.webkitBackdropFilter = 'none';
        clone.style.transform = 'none';
        clone.style.border = EXPORT_BORDER_PX + 'px solid ' + rs.color;
        clone.style.boxShadow = rs.glow ? (EXPORT_GLOW + rs.glow) : 'none';
        Array.prototype.slice.call(clone.querySelectorAll('.card-image')).forEach(function (img) {
            img.style.transform = 'none';
            img.style.transition = 'none';
            img.style.opacity = '1';
            // Re-decide the fit against the canonical export width: a wide/flat
            // photo (sideways fish) letterboxes so its head and tail aren't cropped
            // by the fixed-height image box.
            var box = img.closest ? img.closest('.card-image-container') : null;
            if (box && img.naturalWidth && img.naturalHeight) {
                var boxW = box.clientWidth || EXPORT_CARD_WIDTH;
                var boxH = box.clientHeight || 250;
                img.style.objectFit =
                    (img.naturalWidth / img.naturalHeight) > (boxW / boxH) ? 'contain' : 'cover';
            }
            // Drop images that never loaded (slow/failed) so html-to-image does not
            // try to embed an empty source and produce a corrupt PNG.
            var src = img.getAttribute('src') || img.currentSrc || '';
            if ((!src || img.dataset.state === 'error') && img.parentNode) {
                img.parentNode.removeChild(img);
                if (window.console) console.warn('[animalCards-export] dropped unusable image');
            } else if (window.console) {
                console.log('[animalCards-export] image src:', String(src).slice(0, 60));
            }
        });
        // The loading spinner / progress overlay should never appear in the export.
        Array.prototype.slice.call(clone.querySelectorAll('.card-image-status, .card-image-progress')).forEach(function (el) {
            if (el.parentNode) el.parentNode.removeChild(el);
        });

        // Padded wrapper: gives the glow room so it isn't clipped by the SVG bounds.
        var wrap = document.createElement('div');
        wrap.style.position = 'fixed';
        wrap.style.left = '-100000px';
        wrap.style.top = '0';
        wrap.style.padding = EXPORT_PAD_PX + 'px';
        wrap.appendChild(clone);
        document.body.appendChild(wrap);

        function cleanup() {
            if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        }

        return window.htmlToImage.toPng(wrap, {
            pixelRatio: Math.max(window.devicePixelRatio || 1, 2),
            cacheBust: false,
            backgroundColor: '#0f172a',
            // The wrapper is parked off-screen to avoid flashing in the page, but
            // html-to-image copies that offset into the image — so reset the
            // position on the captured copy to render the card in-view.
            style: { position: 'static', left: '0px', top: '0px' },
            filter: function (n) {
                // Never draw the download control itself into the exported image.
                return !(n && n.classList && n.classList.contains('card-export-ctl'));
            }
        }).then(function (dataUrl) {
            cleanup();
            return dataUrl;
        }).catch(function (err) {
            cleanup();
            throw err;
        });
    }
    function downloadDataUrl(dataUrl, filename) {
        var a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    function downloadNode(node, filename) {
        return ensureImagesLoaded(node)
            .then(function () { return captureNode(node); })
            .then(function (dataUrl) { downloadDataUrl(dataUrl, filename); });
    }

    // Capture every card in `nodes` and download them as a single ZIP.
    function downloadAll(nodes, baseName, onProgress) {
        if (!window.JSZip) {
            return Promise.reject(new Error('JSZip is not loaded'));
        }
        var list = Array.prototype.slice.call(nodes);
        var zip = new window.JSZip();
        var chain = Promise.resolve();
        list.forEach(function (node, i) {
            chain = chain.then(function () {
                if (onProgress) onProgress(i + 1, list.length);
                var filename = node.getAttribute('data-export-filename') ||
                    (baseName + '-' + (i + 1) + '.png');
                return ensureImagesLoaded(node)
                    .then(function () { return captureNode(node); })
                    .then(function (dataUrl) {
                        zip.file(filename, dataUrl.split(',')[1] || '', { base64: true });
                    });
            });
        });
        return chain
            .then(function () { return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }); })
            .then(function (blob) { downloadBlob(blob, baseName + '.zip'); });
    }
    // Build an earned card (photo + owner + serial/quantity) from a resolved entry:
    // { card, account, serials, timestamp, trx_id }. Mirrors the portfolio search cards.
    function renderEarnedCard(entry) {
        var card = entry.card || {};
        var account = entry.account || '';
        var serials = entry.serials || [];
        var count = serials.length;

        var el = document.createElement('div');
        el.className = 'tribute-card';
        el.setAttribute('data-rarity', card.rarity || '');
        el.setAttribute('data-export-filename',
            ['animalcard', account, card.class, card.species].map(slug).filter(Boolean).join('-') + '.png');

        var species = escapeHtml(card.species || 'Card');
        var initial = (String(card.species || '?').charAt(0) || '?').toUpperCase();
        var imgTag = card.image_url
            ? '<img data-src="' + escapeHtml(card.image_url) + '" alt="' + species +
              '" class="card-image" decoding="async" referrerpolicy="no-referrer">'
            : '';
        var badge = count > 1 ? '<span class="card-count-badge">&times;' + count + '</span>' : '';
        var classLine = escapeHtml(card.class || '') + (card.rarity ? ' • ' + escapeHtml(card.rarity) : '');
        var attribution = 'Winner: @' + escapeHtml(account) + ' • Generation: ' + escapeHtml(card.generation || '-') + ' • Photo by ' + escapeHtml(card.photo_credit || '-');
        var metaLeft = count > 1
            ? '<span style="font-size:0.75rem;">Quantity: <strong style="color:var(--text-primary);">' + count + '</strong></span>'
            : '<span style="font-size:0.75rem;">Serial: <strong style="color:var(--text-primary);">' + escapeHtml(serials[0] || '') + '</strong></span>';

        el.innerHTML =
            '<div class="card-image-container">' +
                '<span class="card-image-fallback" aria-hidden="true">' + initial + '</span>' +
                '<div class="card-image-status">' +
                    '<span class="card-image-spinner" aria-hidden="true"></span>' +
                    '<span class="card-image-status-text">Loading...</span>' +
                '</div>' +
                '<div class="card-image-progress" aria-hidden="true"><div class="card-image-progress-bar"></div></div>' +
                imgTag + badge +
            '</div>' +
            '<div class="card-content">' +
                '<div class="card-class">' + classLine + '</div>' +
                '<h3 class="card-species">' + species + '</h3>' +
                (card.is_generic ? '<p style="color: var(--text-secondary); font-size: 0.8rem; font-style: italic; margin-top: 0.25rem;">Generic placeholder</p>' : '') +
                '<p class="card-attribution">' + attribution + '</p>' +
                '<div class="card-meta">' +
                    metaLeft +
                    '<span class="verify-badge">Verified</span>' +
                '</div>' +
            '</div>';
        return el;
    }

    // Render earned-card entries into a fixed-width offscreen container (so their
    // images load and lay out correctly), then download them as a single ZIP.
    function downloadEarnedCards(entries, baseName, onProgress) {
        if (!entries || !entries.length) return Promise.resolve();
        var container = document.createElement('div');
        container.style.position = 'fixed';
        container.style.left = '-100000px';
        container.style.top = '0';
        container.style.width = '300px';
        entries.forEach(function (entry) { container.appendChild(renderEarnedCard(entry)); });
        document.body.appendChild(container);

        function cleanup() {
            if (container.parentNode) container.parentNode.removeChild(container);
        }

        return downloadAll(container.querySelectorAll('.tribute-card'), baseName, onProgress)
            .then(function () { cleanup(); })
            .catch(function (err) { cleanup(); throw err; });
    }

    // Build a catalogue card element (deck/gallery) from a raw cards-config entry.
    function renderDeckCard(card) {
        var el = document.createElement('div');
        el.className = 'tribute-card deck-card';
        el.setAttribute('data-export-filename', deckFilename(card));
        el.setAttribute('data-rarity', card.rarity || '');

        var species = escapeHtml(card.species || 'Card');
        var initial = (String(card.species || '?').charAt(0) || '?').toUpperCase();
        var imgTag = card.image_url
            ? '<img data-src="' + escapeHtml(card.image_url) + '" alt="' + species +
              '" class="card-image" decoding="async" referrerpolicy="no-referrer">'
            : '';
        var classLine = escapeHtml(card.class || '') +
            (card.rarity ? ' • ' + escapeHtml(card.rarity) : '');
        var attribution = card.is_generic
            ? 'Generic placeholder'
            : 'Generation: ' + escapeHtml(card.generation || '—') +
              ' • Photo by ' + escapeHtml(card.photo_credit || '—');

        el.innerHTML =
            '<div class="card-image-container">' +
                '<span class="card-image-fallback" aria-hidden="true">' + initial + '</span>' +
                '<div class="card-image-status">' +
                    '<span class="card-image-spinner" aria-hidden="true"></span>' +
                    '<span class="card-image-status-text">Loading…</span>' +
                '</div>' +
                '<div class="card-image-progress" aria-hidden="true"><div class="card-image-progress-bar"></div></div>' +
                imgTag +
            '</div>' +
            '<div class="card-content">' +
                '<div class="card-class">' + classLine + '</div>' +
                '<h3 class="card-species">' + species + '</h3>' +
                '<p class="card-attribution">' + attribution + '</p>' +
                '<div class="card-meta">' +
                    '<span style="font-size:0.75rem;color:var(--text-secondary);">Card #' +
                        escapeHtml(card.card_id) + '</span>' +
                    downloadButton(card, { kind: 'deck' }) +
                '</div>' +
            '</div>';
        return el;
    }

    // One delegated click handler drives every "Download PNG" button on the page.
    function initDelegation() {
        document.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('[data-export]') : null;
            if (!btn) return;
            var card = btn.closest('.tribute-card');
            if (!card) return;
            var filename = btn.getAttribute('data-filename') ||
                card.getAttribute('data-export-filename') || 'animalcard.png';
            e.preventDefault();
            if (btn.disabled) return;
            btn.disabled = true;
            downloadNode(card, filename)
                .catch(function (err) {
                    console.error('animalCards export failed:', err);
                    if (typeof alert === 'function') {
                        alert('Export failed: ' + ((err && err.message) || err));
                    }
                })
                .then(function () { btn.disabled = false; });
        });
    }

    root.CardExport = {
        slug: slug,
        deckFilename: deckFilename,
        earnedFilename: earnedFilename,
        downloadButton: downloadButton,
        renderDeckCard: renderDeckCard,
        renderEarnedCard: renderEarnedCard,
        downloadNode: downloadNode,
        downloadAll: downloadAll,
        downloadEarnedCards: downloadEarnedCards,
        ensureImagesLoaded: ensureImagesLoaded,
        captureNode: captureNode,
        init: initDelegation
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDelegation);
    } else {
        initDelegation();
    }
})(window);



