// ==UserScript==
// @name         anti paywall
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  try to take over the world!
// @author       https://github.com/abdusco
// @match        https://www.nytimes.com/*
// @match        https://www.economist.com/*
// @match        https://www.spiegel.de/*
// @match        https://www.zeit.de/*
// @match        https://www.theguardian.com/*
// @match        https://www.wired.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=nytimes.com
// @updateURL    https://raw.githubusercontent.com/abdusco/userscripts/master/anti_paywall.js
// @downloadURL  https://raw.githubusercontent.com/abdusco/userscripts/master/anti_paywall.js
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const paywalls = {
        "www.nytimes.com": {
            paywallSelectors: ['[data-testid="gateway-content"]'],
        },
        "www.economist.com": {
            removeSelectors: ['[name="StickyBottomBanner"]'],
        },
        "www.economist.com": {
            paywallSelectors: ['[data-test-id="regwall"]'],
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
    };

    function applyConfig(config) {
        config.removeSelectors?.forEach((sel) => {
            document.querySelectorAll(sel).forEach(($el) => $el.remove());
        });

        const hasPaywallElements = config.paywallSelectors?.some((sel) => document.querySelector(sel));
        const hasPaywallText = config.paywallText?.some((text) => document.body.innerText.toLowerCase().includes(text.toLowerCase()));

        if (hasPaywallElements || hasPaywallText) {
            if (!confirm("Paywall detected. Do you want to redirect to the Internet Archive version?")) {
                return;
            }
            const pageUrl = encodeURIComponent(window.location.href);
            window.location.href = `https://archive.ph/latest/${pageUrl}`;
        }
    }

    // Set up mutation observer to watch for added nodes
    const observer = new MutationObserver((mutations, obs) => {
        const config = paywalls[window.location.hostname];
        if (!config) {
            // detach observer if no config found
            obs.disconnect();
            console.log("No paywall configuration found for this site.");
            return;
        }

        applyConfig(config);
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
