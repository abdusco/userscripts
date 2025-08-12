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
// @icon         https://www.google.com/s2/favicons?sz=64&domain=nytimes.com
// @updateURL    https://raw.githubusercontent.com/abdusco/userscripts/master/anti_paywall.user.js
// @downloadURL  https://raw.githubusercontent.com/abdusco/userscripts/master/anti_paywall.user.js
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    function removeAnnoyances() {
        for (const selector of ['[name="StickyBottomBanner"]', '[id="sign-in-gate"]', 'gu-island:has([for="choicecard-epic-Contribution-Monthly"])']) {
            document.querySelectorAll(selector).forEach(($el) => $el.remove());
        }
    }

    function redirect() {
        if (['[data-testid="gateway-content"]', "#regwall-login", '[data-area="paywall"]', "#paywall"].some((sel) => document.querySelector(sel))) {
            const pageUrl = encodeURIComponent(window.location.href);
            window.location.href = `https://archive.ph/latest/${pageUrl}`;
            return true;
        }
        return false;
    }

    // Try immediately, in case it's already there
    if (redirect()) return;

    // Set up mutation observer to watch for added nodes
    const observer = new MutationObserver((mutations, obs) => {
        removeAnnoyances();
        if (redirect()) {
            obs.disconnect();
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
