/**
 * header.js
 *
 * Recede the sticky header when scrolling down on mobile (≤640px),
 * and reappear when scrolling up or at the top of the page.
 * Uses requestAnimationFrame throttling for zero jank.
 */
(function() {
    'use strict';

    var HEADER_SELECTOR = '.glass-header';
    var RECEDE_CLASS = 'receded';
    var SCROLL_THRESHOLD = 10; // px of scroll before toggling
    var BREAKPOINT = 640; // match the CSS mobile breakpoint

    var header = document.querySelector(HEADER_SELECTOR);
    if (!header) return;

    var lastScrollY = window.scrollY;
    var ticking = false;
    var receded = false;

    function isMobile() {
        return window.innerWidth <= BREAKPOINT;
    }

    function handleScroll() {
        var currentY = window.scrollY;

        // Always show header at the top of the page
        if (currentY <= 0) {
            if (receded) {
                header.classList.remove(RECEDE_CLASS);
                receded = false;
            }
            lastScrollY = currentY;
            ticking = false;
            return;
        }

        var delta = currentY - lastScrollY;

        // Scrolling down — recede header
        if (delta > SCROLL_THRESHOLD && !receded) {
            if (isMobile()) {
                header.classList.add(RECEDE_CLASS);
                receded = true;
            }
        }
        // Scrolling up — bring header back
        else if (delta < -SCROLL_THRESHOLD && receded) {
            header.classList.remove(RECEDE_CLASS);
            receded = false;
        }

        lastScrollY = currentY;
        ticking = false;
    }

    function onScroll() {
        if (!ticking) {
            window.requestAnimationFrame(handleScroll);
            ticking = true;
        }
    }

    // Debounce resize checks so we don't thrash layout
    var resizeTimer;
    function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
            // If we're now above mobile breakpoint, ensure header is visible
            if (!isMobile() && receded) {
                header.classList.remove(RECEDE_CLASS);
                receded = false;
            }
        }, 200);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
})();