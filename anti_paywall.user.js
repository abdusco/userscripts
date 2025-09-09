// ==UserScript==
// @name         anti paywall
// @namespace    http://tampermonkey.net/
// @version      0.7
// @description  try to take over the world!
// @author       https://github.com/abdusco
// @match        *://*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=nytimes.com
// @updateURL    https://github.com/abdusco/userscripts/raw/refs/heads/master/anti_paywall.user.js
// @downloadURL  https://github.com/abdusco/userscripts/raw/refs/heads/master/anti_paywall.user.js
// @grant        none
// ==/UserScript==

(async function () {
    "use strict";

    /** @type {Record<string, { paywallSelectors?: string[], removeSelectors?: string[], paywallText?: string[] }>} */
    const paywalls = {
        "www.nytimes.com": {
            paywallSelectors: ['[data-testid="gateway-content"]'],
        },
        "www.theguardian.com": {
            removeSelectors: [
                'aside:has([name="StickyBottomBanner"])',
                '#liveblog-body > article:has([data-testid="contributions-liveblog-epic"])',
                'gu-island:has([for="choicecard-epic-Contribution-Monthly"])',
            ],
        },
        "www.economist.com": {
            paywallSelectors: ['[data-test-id="regwall"]'],
            paywallText: ["Continue with a free trial"],
        },
        "www.spiegel.de": {
            paywallSelectors: ["[data-has-paid-access-hidden]"],
        },
        "www.zeit.de": {
            paywallSelectors: ['[id="paywall"]'],
        },
        "www.wired.com": {
            paywallText: ["read your last free article."],
        },
        "www.bloomberg.com": {
            paywallSelectors: ['[id="fortress-container-root"]'],
            paywallText: ["Subscribe now for uninterrupted access."],
        },
        "www.reuters.com": {
            paywallSelectors: ['[data-testid="paywall"]'],
            paywallText: ["Subscribe to Reuters to continue reading."],
        },
        "www.washingtonpost.com": {
            paywallText: ["Ways to read this article"],
        },
    };

    let redirecting = false;
    let cancelled = false;
    function applyConfig(config) {
        if (cancelled) {
            console.log("Operation cancelled by user.");
            return;
        }

        config.removeSelectors?.forEach((sel) => {
            document.querySelectorAll(sel).forEach(($el) => $el.remove());
        });

        const hasPaywallElements = config.paywallSelectors?.some((sel) => document.querySelector(sel));
        const pageText = document.body.innerText.toLowerCase();
        const hasPaywallText = config.paywallText?.some((text) => pageText.includes(text.toLowerCase()));

        if (hasPaywallElements || hasPaywallText) {
            if (redirecting) {
                console.log("Already redirecting to archive, skipping.");
                return;
            }
            if (!confirm("Paywall detected. Do you want to redirect to the Internet Archive version?")) {
                cancelled = true;
                return;
            }
            const pageUrl = encodeURIComponent(window.location.href);
            window.location.href = `https://archive.is/latest/${pageUrl}`;
            redirecting = true;
        }
    }

    const config = paywalls[window.location.hostname];
    if (!config) {
        console.log("No paywall configuration found for this site.");
        return;
    }

    // Apply immediately on page load
    applyConfig(config);

    // Promise-based interval function
    const runInterval = async () => {
        return new Promise((resolve) => {
            let intervalCount = 0;
            const maxIntervalChecks = 4; // 4 checks at 0.5s = 2s total

            const intervalId = setInterval(() => {
                intervalCount++;
                console.log(`Interval check ${intervalCount}/${maxIntervalChecks}`);

                applyConfig(config);

                // After 2s (4 checks), clear interval and resolve the promise
                if (intervalCount >= maxIntervalChecks) {
                    clearInterval(intervalId);
                    resolve();
                }
            }, 500);
        });
    };

    await runInterval();
    console.log("Switching to mutation observer mode");

    // Set up mutation observer for continued monitoring
    const observer = new MutationObserver(() => {
        applyConfig(config);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
