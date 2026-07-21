// ==UserScript==
// @name         Simple Immersive Translate (BYOK)
// @namespace    https://github.com/local/simple-immersive-translate
// @version      0.1.3
// @description  Paragraph-by-paragraph bilingual page translation using your own OpenAI-compatible API key.
// @author       you
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @connect      generativelanguage.googleapis.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    // Don't mount UI / run translation logic inside iframes (ads, embeds, etc).
    if (window.top !== window.self) return;

    /* ------------------------------------------------------------------ */
    /* Settings                                                            */
    /* ------------------------------------------------------------------ */

    const STORAGE_KEY = "imt_simple_settings_v1";
    const BALL_POS_KEY = "imt_simple_ball_top_v1";

    const DEFAULT_SETTINGS = {
        apiUrl: "https://api.openai.com/v1/chat/completions",
        apiKey: "",
        model: "gpt-4o-mini",
        targetLang: "English",
        temperature: 0.3,
        displayMode: "bilingual", // 'bilingual' | 'replace'
        maxParagraphsPerRequest: 8,
        maxCharsPerRequest: 1800,
        minParagraphChars: 16,
        concurrency: 4,
        blacklist: [],
        systemPromptTemplate:
            "You are a professional {{lang}} native translator. Follow these rules strictly:\n" +
            "1. Output only the translated text, with no explanations, notes, or added quotation marks.\n" +
            "2. Preserve the exact number of paragraphs as the input. If the input contains multiple " +
            'paragraphs separated by "%%", your output must use "%%" as the separator between the same ' +
            "number of translated paragraphs, in the same order.\n" +
            "3. Keep proper nouns, code, and things that should not be translated as-is.\n" +
            "4. Never merge, split, or omit paragraphs.",
        userPromptTemplate: "Translate the following text into {{lang}}.\n\n{{text}}",
    };

    // Separator the model is instructed to preserve between batched paragraphs.
    const BATCH_SEPARATOR = "\n\n%%\n\n";
    const BATCH_SPLIT_RE = /\n*%%\n*/;

    function loadSettings() {
        const stored = GM_getValue(STORAGE_KEY, null);
        return Object.assign({}, DEFAULT_SETTINGS, stored || {});
    }

    function saveSettings(settings) {
        GM_setValue(STORAGE_KEY, settings);
    }

    let settings = loadSettings();

    function fillTemplate(tpl, vars) {
        return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ""));
    }

    /* ------------------------------------------------------------------ */
    /* Translation backend (OpenAI-compatible chat completions)           */
    /* ------------------------------------------------------------------ */

    function requestChatCompletion({ apiUrl, apiKey, model, temperature, messages }) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: apiUrl,
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                data: JSON.stringify({ model, temperature, messages }),
                timeout: 30000,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`HTTP ${res.status}: ${res.responseText.slice(0, 300)}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(res.responseText);
                        const content = json.choices?.[0]?.message?.content;
                        if (typeof content !== "string") throw new Error("Malformed response: no message content");
                        resolve(content);
                    } catch (err) {
                        reject(err);
                    }
                },
                onerror: () => reject(new Error("Network error contacting translation API")),
                ontimeout: () => reject(new Error("Translation API request timed out")),
            });
        });
    }

    // Translates a batch of paragraph texts in one request. Returns an array of
    // translated strings aligned 1:1 with `texts`, or throws if the model didn't
    // return a matching number of segments.
    async function translateBatch(texts) {
        const lang = settings.targetLang;
        const joined = texts.join(BATCH_SEPARATOR);
        const messages = [
            { role: "system", content: fillTemplate(settings.systemPromptTemplate, { lang }) },
            { role: "user", content: fillTemplate(settings.userPromptTemplate, { lang, text: joined }) },
        ];
        const content = await requestChatCompletion({
            apiUrl: settings.apiUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            temperature: settings.temperature,
            messages,
        });
        const parts = content.split(BATCH_SPLIT_RE).map((s) => s.trim());
        if (parts.length === texts.length) return parts;
        if (texts.length === 1) return [content.trim()];

        // Model didn't respect the separator contract for this batch — fall back
        // to translating each paragraph individually so the batch doesn't fail outright.
        const results = [];
        for (const t of texts) results.push((await translateBatch([t]))[0]);
        return results;
    }

    /* ------------------------------------------------------------------ */
    /* Concurrency-limited job queue                                       */
    /* ------------------------------------------------------------------ */

    function createQueue(concurrency) {
        const jobs = [];
        let active = 0;

        function runNext() {
            if (active >= concurrency || jobs.length === 0) return;
            const job = jobs.shift();
            active++;
            job().finally(() => {
                active--;
                runNext();
            });
        }

        return {
            push(job) {
                jobs.push(job);
                runNext();
            },
        };
    }

    /* ------------------------------------------------------------------ */
    /* Paragraph detection & viewport-triggered batching                  */
    /* ------------------------------------------------------------------ */

    // div/section included so text wrapped in a plain container (no <p> inside,
    // e.g. many sites' article deck/summary) still gets picked up — the "no
    // nested BLOCK_SELECTOR match" check below keeps this from also grabbing
    // outer wrapper divs that merely contain real paragraphs.
    const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, td, figcaption, div, section";
    const SKIP_ANCESTOR_SELECTOR =
        "script, style, noscript, textarea, input, select, button, code, pre, svg, " +
        "audio, video, picture, iframe, canvas, object, embed, form, " +
        '[contenteditable="true"], [aria-hidden="true"], [hidden], ' +
        ".visually-hidden, .sr-only, .visuallyhidden, " +
        ".imt-simple-ui-root, .imt-simple-translation";
    const HAS_LETTERS_RE = /[^\s0-9!-/:-@[-`{-~]/;

    const state = {
        active: false,
        idCounter: 1,
        total: 0,
        translated: 0,
        failed: 0,
        processedEls: new Set(), // elements that have been queued (avoid double-processing)
    };

    let intersectionObserver = null;
    let mutationObserver = null;
    let queue = null;
    const pendingEls = [];
    let flushTimer = null;

    function isEligible(el) {
        if (state.processedEls.has(el)) return false;
        if (el.closest(SKIP_ANCESTOR_SELECTOR)) return false;
        if (el.querySelector(BLOCK_SELECTOR)) return false; // avoid double-counting containers
        // Don't glob unrelated UI controls (audio players, buttons, hidden a11y
        // text) into the same "paragraph" just because they share a wrapper div.
        if (el.querySelector(SKIP_ANCESTOR_SELECTOR)) return false;
        if (el.offsetParent === null) return false; // hidden (display:none or a hidden ancestor)
        const text = el.textContent.trim();
        if (text.length < settings.minParagraphChars) return false;
        if (!HAS_LETTERS_RE.test(text)) return false;
        return true;
    }

    function scanForParagraphs(root) {
        const found = [];
        root.querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
            if (isEligible(el)) found.push(el);
        });
        return found;
    }

    function observeNewParagraphs(root) {
        const found = scanForParagraphs(root);
        for (const el of found) {
            state.processedEls.add(el);
            state.total++;
            intersectionObserver.observe(el);
        }
        updatePopupStatus();
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(flushPending, 120);
    }

    function flushPending() {
        flushTimer = null;
        while (pendingEls.length > 0) {
            const batchEls = [];
            let charCount = 0;
            while (pendingEls.length > 0 && batchEls.length < settings.maxParagraphsPerRequest && (batchEls.length === 0 || charCount < settings.maxCharsPerRequest)) {
                const el = pendingEls[0];
                const text = el.textContent.trim();
                if (batchEls.length > 0 && charCount + text.length > settings.maxCharsPerRequest) break;
                pendingEls.shift();
                batchEls.push(el);
                charCount += text.length;
            }
            enqueueBatch(batchEls);
        }
    }

    const PENDING_CLASS = "imt-simple-pending";

    function enqueueBatch(els) {
        if (els.length === 0) return;
        els.forEach((el) => el.classList.add(PENDING_CLASS));
        queue.push(async () => {
            const texts = els.map((el) => el.textContent.trim());
            try {
                const translations = await translateBatch(texts);
                // Clear pending state before cloning for the translation node below —
                // cloneNode copies classList too, so the clone would inherit the pulse.
                els.forEach((el) => el.classList.remove(PENDING_CLASS));
                els.forEach((el, i) => renderTranslation(el, translations[i] ?? ""));
                state.translated += els.length;
            } catch (err) {
                console.error("[SimpleImmersiveTranslate] batch failed:", err);
                state.failed += els.length;
            } finally {
                els.forEach((el) => el.classList.remove(PENDING_CLASS));
            }
            updatePopupStatus();
        });
    }

    function renderTranslation(el, translatedText) {
        if (!translatedText) return;
        if (el.dataset.imtDone) return;
        el.dataset.imtDone = "1";

        if (settings.displayMode === "replace") {
            el.dataset.imtOriginalText = el.textContent;
            const original = el.cloneNode(true);
            el.textContent = translatedText;
            el.dataset.imtHasOriginal = "1";
            el._imtOriginalNode = original;
            return;
        }

        // Divider + muted text color, same combo the original extension's default
        // "dividingLine" + "grey" themes use to set translations apart from the original.
        const highlightCss = "border-top:1px dashed #94a3b8; padding-top:0.3em; margin-top:0.3em; color:#2f4f4f; font-size:0.92em;";

        // td can't get a cloned sibling <td> (that would add a spurious table column),
        // so append an inline block inside the cell instead.
        if (el.tagName === "TD") {
            const inner = document.createElement("div");
            inner.className = "imt-simple-translation";
            inner.style.cssText = highlightCss;
            inner.textContent = translatedText;
            el.appendChild(inner);
            return;
        }

        // Clone the paragraph itself (same tag + classes + inline style) so the
        // translation inherits the page's own typography instead of looking bolted-on.
        const clone = el.cloneNode(false);
        clone.removeAttribute("id");
        delete clone.dataset.imtId;
        delete clone.dataset.imtDone;
        clone.classList.add("imt-simple-translation");
        clone.style.cssText += highlightCss;
        clone.textContent = translatedText;
        el.insertAdjacentElement("afterend", clone);
    }

    function injectPendingStyle() {
        if (document.getElementById("imt-simple-pending-style")) return;
        const style = document.createElement("style");
        style.id = "imt-simple-pending-style";
        // Injected into the page (not shadow DOM) since it targets original
        // paragraph elements while their translation request is in flight.
        style.textContent = `
      @keyframes imtSimplePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .${PENDING_CLASS} { animation: imtSimplePulse 1.4s ease-in-out infinite; }
    `;
        document.head.appendChild(style);
    }

    function startTranslation() {
        if (state.active) return;
        injectPendingStyle();
        state.active = true;
        state.total = 0;
        state.translated = 0;
        state.failed = 0;
        state.processedEls = new Set();

        queue = createQueue(settings.concurrency);

        intersectionObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    intersectionObserver.unobserve(entry.target);
                    pendingEls.push(entry.target);
                }
                if (pendingEls.length > 0) scheduleFlush();
            },
            { rootMargin: "200px 0px" },
        );

        observeNewParagraphs(document.body);

        mutationObserver = new MutationObserver(() => {
            clearTimeout(mutationObserver._t);
            mutationObserver._t = setTimeout(() => observeNewParagraphs(document.body), 500);
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true });

        updatePopupStatus();
    }

    function stopTranslation() {
        state.active = false;
        if (intersectionObserver) intersectionObserver.disconnect();
        if (mutationObserver) mutationObserver.disconnect();
        intersectionObserver = null;
        mutationObserver = null;
        pendingEls.length = 0;
        clearTimeout(flushTimer);
        flushTimer = null;

        document.querySelectorAll(".imt-simple-translation").forEach((n) => n.remove());
        document.querySelectorAll('[data-imt-has-original="1"]').forEach((el) => {
            if (el._imtOriginalNode) {
                el.textContent = el.dataset.imtOriginalText || "";
                delete el._imtOriginalNode;
            }
        });
        document.querySelectorAll("[data-imt-done]").forEach((el) => {
            delete el.dataset.imtDone;
            delete el.dataset.imtHasOriginal;
            delete el.dataset.imtOriginalText;
        });

        updatePopupStatus();
    }

    function toggleTranslation() {
        if (state.active) stopTranslation();
        else startTranslation();
        updateBallActiveStyle();
    }

    /* ------------------------------------------------------------------ */
    /* Floating hover button + popup (Shadow DOM)                         */
    /* ------------------------------------------------------------------ */

    const QUICK_LANGS = ["English", "French", "German"];

    let ballHost, ballShadow, ballBtn, popupEl, statusEl;
    let dragState = null;

    function injectSharedStyle(shadow) {
        const style = document.createElement("style");
        style.textContent = `
      * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
      button { cursor: pointer; }
    `;
        shadow.appendChild(style);
    }

    function buildFloatBall() {
        ballHost = document.createElement("div");
        ballHost.className = "imt-simple-ui-root";
        // Sits flush against the right edge, mostly off-screen; only a thin sliver
        // of the button peeks out until hover/focus/touch pulls it fully into view.
        ballHost.style.cssText = "position:fixed; right:0; z-index:2147483000;";
        ballHost.style.top = String(GM_getValue(BALL_POS_KEY, Math.round(window.innerHeight * 0.45))) + "px";
        document.documentElement.appendChild(ballHost);

        ballShadow = ballHost.attachShadow({ mode: "open" });
        injectSharedStyle(ballShadow);

        const wrap = document.createElement("div");
        wrap.style.cssText = "transform:translateX(60%); transition:transform 0.18s ease;";

        const style = document.createElement("style");
        style.textContent = `
      div:hover, div:focus-within, div:active { transform: translateX(0) !important; }
    `;
        ballShadow.appendChild(style);

        ballBtn = document.createElement("button");
        ballBtn.textContent = "译";
        ballBtn.title = "Simple Immersive Translate";
        ballBtn.style.cssText = `
      width:32px; height:32px; border-radius:50%; border:none;
      background:#64748b; color:#fff; font-size:12px; font-weight:600;
      box-shadow:0 1px 4px rgba(0,0,0,0.25); user-select:none; touch-action:none;
      opacity:0.85;
    `;
        wrap.appendChild(ballBtn);
        ballShadow.appendChild(wrap);

        ballBtn.addEventListener("pointerdown", onDragStart);
        ballBtn.addEventListener("click", (e) => {
            if (dragState && dragState.moved) return; // suppress click after drag
            togglePopup();
        });
    }

    function onDragStart(e) {
        dragState = { startY: e.clientY, startTop: ballHost.offsetTop, moved: false };
        ballBtn.setPointerCapture(e.pointerId);
        ballBtn.addEventListener("pointermove", onDragMove);
        ballBtn.addEventListener("pointerup", onDragEnd, { once: true });
    }

    function onDragMove(e) {
        if (!dragState) return;
        const dy = e.clientY - dragState.startY;
        if (Math.abs(dy) > 4) dragState.moved = true;
        const newTop = Math.min(Math.max(8, dragState.startTop + dy), window.innerHeight - 40);
        ballHost.style.top = newTop + "px";
    }

    function onDragEnd() {
        ballBtn.removeEventListener("pointermove", onDragMove);
        if (dragState) GM_setValue(BALL_POS_KEY, ballHost.offsetTop);
        dragState = null;
    }

    function updateBallActiveStyle() {
        if (!ballBtn) return;
        ballBtn.style.background = state.active ? "#0d9488" : "#64748b";
    }

    function updatePopupStatus() {
        if (!statusEl) return;
        if (!state.active) {
            statusEl.textContent = "Idle";
        } else {
            statusEl.textContent = `Translated ${state.translated}/${state.total}` + (state.failed ? ` (${state.failed} failed)` : "");
        }
    }

    function togglePopup() {
        if (popupEl) {
            closePopup();
            return;
        }
        openPopup();
    }

    function openPopup() {
        popupEl = document.createElement("div");
        popupEl.style.cssText = `
      position:absolute; right:40px; top:0; width:min(240px, calc(100vw - 72px));
      background:#fff; color:#111; border-radius:10px; padding:12px;
      box-shadow:0 4px 20px rgba(0,0,0,0.2); font-size:13px; line-height:1.4;
    `;

        const toggleBtn = document.createElement("button");
        styleFullWidthBtn(toggleBtn, state.active ? "Show original" : "Translate page");
        toggleBtn.addEventListener("click", () => {
            toggleTranslation();
            toggleBtn.textContent = state.active ? "Show original" : "Translate page";
        });
        popupEl.appendChild(toggleBtn);

        const langLabel = document.createElement("div");
        langLabel.textContent = "Target language";
        langLabel.style.cssText = "margin:10px 0 4px; font-weight:600;";
        popupEl.appendChild(langLabel);

        const langRow = document.createElement("div");
        langRow.style.cssText = "display:flex; flex-wrap:wrap; gap:4px;";
        for (const lang of QUICK_LANGS) {
            const chip = document.createElement("button");
            chip.textContent = lang;
            chip.style.cssText = `
        padding:3px 8px; border-radius:12px; border:1px solid ${lang === settings.targetLang ? "#2563eb" : "#ddd"};
        background:${lang === settings.targetLang ? "#eff6ff" : "#f9fafb"}; font-size:12px;
      `;
            chip.addEventListener("click", () => {
                settings.targetLang = lang;
                saveSettings(settings);
                closePopup();
                openPopup();
            });
            langRow.appendChild(chip);
        }
        popupEl.appendChild(langRow);

        statusEl = document.createElement("div");
        statusEl.style.cssText = "margin-top:10px; color:#666;";
        popupEl.appendChild(statusEl);
        updatePopupStatus();

        const settingsBtn = document.createElement("button");
        styleFullWidthBtn(settingsBtn, "Advanced settings");
        settingsBtn.style.marginTop = "10px";
        settingsBtn.addEventListener("click", () => {
            closePopup();
            openSettingsModal();
        });
        popupEl.appendChild(settingsBtn);

        const blacklistBtn = document.createElement("button");
        styleFullWidthBtn(blacklistBtn, `Don't show on ${location.hostname}`);
        blacklistBtn.style.marginTop = "6px";
        blacklistBtn.style.color = "#b91c1c";
        blacklistBtn.addEventListener("click", () => {
            if (!settings.blacklist.includes(location.hostname)) {
                settings.blacklist = settings.blacklist.concat(location.hostname);
                saveSettings(settings);
            }
            closePopup();
            ballHost.remove();
        });
        popupEl.appendChild(blacklistBtn);

        ballShadow.appendChild(popupEl);
        setTimeout(() => document.addEventListener("click", onOutsideClick, { capture: true }), 0);
    }

    function styleFullWidthBtn(btn, label) {
        btn.textContent = label;
        btn.style.cssText = `
      width:100%; padding:6px 8px; border-radius:6px; border:1px solid #ddd;
      background:#f9fafb; font-size:13px;
    `;
    }

    function onOutsideClick(e) {
        if (!ballHost.contains(e.target)) closePopup();
    }

    function closePopup() {
        if (popupEl) popupEl.remove();
        popupEl = null;
        statusEl = null;
        document.removeEventListener("click", onOutsideClick, { capture: true });
    }

    /* ------------------------------------------------------------------ */
    /* Advanced settings modal                                             */
    /* ------------------------------------------------------------------ */

    function openSettingsModal() {
        const overlayHost = document.createElement("div");
        overlayHost.className = "imt-simple-ui-root";
        overlayHost.style.cssText = "position:fixed; inset:0; z-index:2147483001;";
        document.documentElement.appendChild(overlayHost);
        const shadow = overlayHost.attachShadow({ mode: "open" });
        injectSharedStyle(shadow);

        const backdrop = document.createElement("div");
        backdrop.style.cssText = "position:absolute; inset:0; background:rgba(0,0,0,0.4);";
        shadow.appendChild(backdrop);

        const card = document.createElement("div");
        card.style.cssText = `
      position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
      width:min(420px, calc(100vw - 24px)); max-height:85vh; overflow:auto;
      background:#fff; color:#111; border-radius:12px; padding:16px;
      box-shadow:0 10px 40px rgba(0,0,0,0.3); font-size:13px;
    `;
        backdrop.appendChild(card); // clicking backdrop closes (handled below), card stops propagation

        const title = document.createElement("h2");
        title.textContent = "Simple Immersive Translate — Settings";
        title.style.cssText = "margin:0 0 14px; font-size:16px;";
        card.appendChild(title);

        const draft = Object.assign({}, settings);
        const fields = [];

        function addField(labelText, key, type, opts) {
            const wrap = document.createElement("label");
            wrap.style.cssText = "display:block; margin-bottom:10px;";
            const lbl = document.createElement("div");
            lbl.textContent = labelText;
            lbl.style.cssText = "margin-bottom:3px; font-weight:600; color:#333;";
            wrap.appendChild(lbl);

            let input;
            if (type === "textarea" || type === "list") {
                input = document.createElement("textarea");
                input.rows = opts?.rows || 4;
                input.value = type === "list" ? draft[key].join("\n") : draft[key];
            } else if (type === "select") {
                input = document.createElement("select");
                for (const opt of opts.options) {
                    const o = document.createElement("option");
                    o.value = opt.value;
                    o.textContent = opt.label;
                    if (draft[key] === opt.value) o.selected = true;
                    input.appendChild(o);
                }
            } else {
                input = document.createElement("input");
                input.type = type;
                input.value = draft[key];
                if (opts?.step) input.step = opts.step;
            }
            input.style.cssText = "width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:6px; font-size:13px;";
            wrap.appendChild(input);
            card.appendChild(wrap);
            fields.push({ key, input, type });
        }

        addField("API base URL (OpenAI-compatible /chat/completions)", "apiUrl", "text");
        addField("API key (stored locally via GM_setValue, never sent anywhere but the URL above)", "apiKey", "password");
        addField("Model", "model", "text");
        addField("Default target language", "targetLang", "text");
        addField("Temperature", "temperature", "number", { step: "0.1" });
        addField("Display mode", "displayMode", "select", {
            options: [
                { value: "bilingual", label: "Bilingual (show original + translation)" },
                { value: "replace", label: "Replace original text" },
            ],
        });
        addField("Max paragraphs per request", "maxParagraphsPerRequest", "number");
        addField("Max characters per request", "maxCharsPerRequest", "number");
        addField("Minimum paragraph length (chars, shorter is skipped)", "minParagraphChars", "number");
        addField("Concurrent requests", "concurrency", "number");
        addField("System prompt template ({{lang}})", "systemPromptTemplate", "textarea", { rows: 6 });
        addField("User prompt template ({{lang}}, {{text}})", "userPromptTemplate", "textarea", { rows: 3 });
        addField("Blacklisted sites (one hostname per line)", "blacklist", "list", { rows: 3 });

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex; gap:8px; margin-top:16px;";

        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Save";
        saveBtn.style.cssText = "flex:1; padding:8px; border-radius:6px; border:none; background:#2563eb; color:#fff; font-weight:600;";
        saveBtn.addEventListener("click", () => {
            for (const f of fields) {
                let v = f.input.value;
                if (f.type === "number") v = Number(v);
                else if (f.type === "list")
                    v = v
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean);
                draft[f.key] = v;
            }
            settings = Object.assign({}, DEFAULT_SETTINGS, draft);
            saveSettings(settings);
            overlayHost.remove();
        });

        const resetBtn = document.createElement("button");
        resetBtn.textContent = "Reset to defaults";
        resetBtn.style.cssText = "padding:8px 12px; border-radius:6px; border:1px solid #ccc; background:#fff;";
        resetBtn.addEventListener("click", () => {
            settings = Object.assign({}, DEFAULT_SETTINGS);
            saveSettings(settings);
            overlayHost.remove();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        cancelBtn.style.cssText = "padding:8px 12px; border-radius:6px; border:1px solid #ccc; background:#fff;";
        cancelBtn.addEventListener("click", () => overlayHost.remove());

        btnRow.appendChild(saveBtn);
        btnRow.appendChild(resetBtn);
        btnRow.appendChild(cancelBtn);
        card.appendChild(btnRow);

        card.addEventListener("click", (e) => e.stopPropagation());
        backdrop.addEventListener("click", () => overlayHost.remove());
    }

    /* ------------------------------------------------------------------ */
    /* Bootstrap                                                           */
    /* ------------------------------------------------------------------ */

    function init() {
        if (!settings.blacklist.includes(location.hostname)) buildFloatBall();
        GM_registerMenuCommand("Toggle page translation", toggleTranslation);
        // Kept available even on blacklisted sites, since it's the only way to un-blacklist one.
        GM_registerMenuCommand("Advanced settings", openSettingsModal);
    }

    if (document.body) init();
    else document.addEventListener("DOMContentLoaded", init, { once: true });
})();
