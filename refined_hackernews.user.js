// ==UserScript==
// @name         Refined Hacker News - Essential Features
// @namespace    https://github.com/plibither8/refined-hacker-news
// @version      1.1
// @description  Essential Hacker News enhancements: reply without leaving page, keyboard navigation, easy favorites, and hover info
// @author       Mihir Chaturvedi (converted to userscript)
// @match        https://news.ycombinator.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    // ============================================================================
    // CSS STYLES
    // ============================================================================

    GM_addStyle(`
        /* Base styles */
        .__rhn__no-display {
            display: none;
        }

        .__rhn__select-disabled {
            pointer-events: none;
            cursor: not-allowed;
        }

        /* Keyboard navigation focus */
        .__rhn__focussed-item {
            outline: 2px solid tomato;
            box-sizing: unset;
            margin: -2px;
        }

        .__rhn__focussed-item.morelink {
            margin: 0;
        }

        /* Reply form styling */
        .__rhn__injected-form {
            margin-top: 10px;
        }

        /* Hover info popup */
        .__rhn__hover-info {
            position: absolute;
            background: #f6f6ef;
            z-index: 2;
            border: 1px solid #000;
            padding: 3px;
            max-width: 500px;
            max-height: 400px;
            overflow-y: auto;
        }

        .__rhn__hover-info td {
            font-size: 10px !important;
            vertical-align: top;
        }

        .__rhn__hover-info td:nth-child(2) {
            word-break: break-word;
        }

        .__rhn__hover-info td a {
            color: #000 !important;
            text-decoration: none !important;
        }

        a.hnuser:hover ~ .__rhn__hover-info,
        .__rhn__hover-info:hover {
            display: block;
        }

        /* Loader */
        .__rhn__loader {
            font-size: 10px;
            color: #888;
        }

        /* Clickable comment indents */
        .__rhn__clickable-indent {
            cursor: pointer;
        }

        .__rhn__clickable-indent:hover {
            box-shadow: inset -1px 0 #888;
        }

        /* Highlight new/unread comments */
        .__rhn__new-comment-indent {
            box-shadow: inset -3px 0 #f6b391;
        }

        .__rhn__new-comment-indent:hover {
            box-shadow: inset -3px 0 #ff6000;
        }

        /* Collapse root comment link */
        .__rhn__collapse-root-comment {
            margin-left: 5px;
        }
    `);

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    function getUrlParams(param, url) {
        const params = new URLSearchParams((url || window.location.search).replace("?", "&"));
        return param ? params.get(param) : params;
    }

    function isClickModified(event) {
        return Boolean(event.button) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    }

    function elementInScrollView(el) {
        const rect = el.getBoundingClientRect();
        const elemTop = rect.top;
        const elemBottom = rect.bottom;
        return elemTop >= 0 && elemBottom <= window.innerHeight;
    }

    function getAllComments() {
        return [...document.querySelectorAll("tr.comtr")];
    }

    function getCommentIndentation(element) {
        const indentImg = element.querySelector(".ind img");
        return indentImg ? indentImg.width / 40 : 0;
    }

    function elementPosition(el) {
        const bodyRect = document.body.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        const top = rect.top - bodyRect.top;
        return { x: rect.left, y: top };
    }

    function createSiblingLoader(element, customStyle = "") {
        const loader = document.createElement("span");
        loader.textContent = "Loading...";
        loader.style.cssText = `font-size: 10px; color: #888; ${customStyle}`;
        loader.classList.add("__rhn__loader");
        element.parentElement.insertBefore(loader, element.nextSibling);
        return loader;
    }

    async function getPageDom(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: function (response) {
                    const tempEl = document.createElement("div");
                    tempEl.innerHTML = response.responseText;
                    resolve(tempEl);
                },
                onerror: function (error) {
                    console.error("RHN: Network error:", error);
                    resolve(null);
                },
            });
        });
    }

    // ============================================================================
    // API FUNCTIONS
    // ============================================================================

    const BASE_URL = "https://hacker-news.firebaseio.com/v0";

    function getUserInfo(username) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `${BASE_URL}/user/${username}.json`,
                onload: function (response) {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        console.error("Error parsing user info:", e);
                        resolve(null);
                    }
                },
                onerror: function (error) {
                    console.error("Error fetching user info:", error);
                    resolve(null);
                },
            });
        });
    }

    function getItemInfo(id) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `${BASE_URL}/item/${id}.json`,
                onload: function (response) {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        console.error("Error parsing item info:", e);
                        resolve(null);
                    }
                },
                onerror: function (error) {
                    console.error("Error fetching item info:", error);
                    resolve(null);
                },
            });
        });
    }

    async function getAuthString(id) {
        const page = await getPageDom(`https://news.ycombinator.com/item?id=${id}`);
        if (!page) return false;

        const row = page.querySelector("table.fatitem td.subtext") || page.querySelector("table.fatitem span.comhead");
        const target = row.querySelector('a[href^="hide"]') || row.querySelector('a[href^="fave"]');
        return getUrlParams("auth", target.href);
    }

    // ============================================================================
    // FEATURE 1: REPLY WITHOUT LEAVING PAGE
    // ============================================================================

    function initReplyWithoutLeavingPage() {
        const path = window.location.pathname;
        const searchParams = new URLSearchParams(window.location.search);

        if (path === "/item" && !searchParams.get("p")) {
            const replyForm = document.querySelector("table.fatitem form");
            if (!replyForm) return false;
        }

        const comments = getAllComments();
        for (const comment of comments) {
            comment.dataset.rhnFormInjected = "0";

            const buttons = [];
            ["reply", "edit", "delete-confirm"].forEach((action) => {
                const link = comment.querySelector(`a[href^="${action}"]`);
                if (link) buttons.push(link);
            });

            const replyDiv = comment.querySelector("div.reply");
            const ACTIVE_DATA = {
                form: undefined,
                button: undefined,
            };

            for (const button of buttons) {
                button.dataset.rhnActionName = button.innerText;

                button.addEventListener("click", async (event) => {
                    if (isClickModified(event)) return;
                    event.preventDefault();

                    const selection = window
                        .getSelection()
                        .toString()
                        .trim()
                        .split("\n")
                        .filter((str) => str.length > 0)
                        .map((str) => "> " + str)
                        .join("\n\n");

                    if (ACTIVE_DATA.form) {
                        ACTIVE_DATA.form = undefined;
                        replyDiv.querySelector("form").remove();

                        if (ACTIVE_DATA.button) {
                            ACTIVE_DATA.button.innerText = ACTIVE_DATA.button.dataset.rhnActionName;
                        }

                        if (ACTIVE_DATA.button !== button) {
                            button.click();
                        } else {
                            ACTIVE_DATA.button = undefined;
                        }
                    } else {
                        const loader = createSiblingLoader(button, "height:9px;margin-left:5px;");
                        const page = await getPageDom(button.href);
                        loader.remove();

                        if (!page) return;

                        const form = page.querySelector("form");
                        form.classList.add("__rhn__injected-form");

                        ACTIVE_DATA.form = form;
                        ACTIVE_DATA.button = button;

                        button.innerText = "hide " + button.dataset.rhnActionName;
                        replyDiv.append(form);

                        const textarea = form.querySelector("textarea");
                        if (textarea) {
                            if (selection.length > 0) {
                                textarea.value += `${textarea.value.length > 0 ? "\n\n" : ""}${selection}\n\n`;
                            }
                            textarea.focus();
                        }
                    }
                });
            }
        }

        return true;
    }

    // ============================================================================
    // FEATURE 2: MORE ACCESSIBLE FAVORITES
    // ============================================================================

    async function initMoreAccessibleFavorite() {
        const path = window.location.pathname;
        const loaderCustomStyle = "height: 9px; margin-left: 5px;";

        // Get current user (simple check for logged in state)
        const userLink = document.querySelector("a#me");
        if (!userLink) return false; // Not logged in

        const username = userLink.innerText;

        // Default fave buttons
        const faveButtonsList = document.querySelectorAll('a[href^="fave"]');
        for (const faveButton of faveButtonsList) {
            const auth = getUrlParams("auth", faveButton.href);
            const id = getUrlParams("id", faveButton.href);

            let unfave = faveButton.innerText === "un-favorite";
            let ongoingFavorite = false;

            faveButton.addEventListener("click", async (event) => {
                if (isClickModified(event)) return;
                event.preventDefault();

                if (ongoingFavorite) return;
                ongoingFavorite = true;

                const loader = createSiblingLoader(faveButton, loaderCustomStyle);

                GM_xmlhttpRequest({
                    method: "GET",
                    url: faveButton.href,
                    onload: function () {
                        loader.remove();
                        unfave = !unfave;
                        faveButton.innerHTML = unfave ? "un-favorite" : "favorite";
                        faveButton.href = `fave?id=${id}&auth=${auth}${unfave ? "&un=t" : ""}`;
                        ongoingFavorite = false;
                    },
                    onerror: function () {
                        loader.remove();
                        ongoingFavorite = false;
                    },
                });
            });
        }

        // Add favorite buttons to comments
        if (path === "/item") {
            const comments = getAllComments();
            for (const comment of comments) {
                const separatorPipe = document.createTextNode("| ");
                const faveButton = document.createElement("a");
                faveButton.innerText = "favorite";
                faveButton.classList.add("__rhn__fave-button");
                faveButton.href = "javascript:void(0)";

                const headSpan = comment.querySelector("span.comhead");
                const navsSpan = comment.querySelector("span.navs");

                if (headSpan && navsSpan) {
                    headSpan.insertBefore(separatorPipe, navsSpan);
                    headSpan.insertBefore(faveButton, navsSpan);

                    let ongoingFavorite = false;

                    faveButton.addEventListener("click", async () => {
                        if (ongoingFavorite) return;
                        ongoingFavorite = true;

                        const loader = createSiblingLoader(faveButton, loaderCustomStyle);
                        const auth = await getAuthString(comment.id);
                        const url = `https://news.ycombinator.com/fave?id=${comment.id}&auth=${auth}`;

                        GM_xmlhttpRequest({
                            method: "GET",
                            url: url,
                            onload: function () {
                                loader.remove();
                                faveButton.innerHTML = "favorited";
                                ongoingFavorite = false;
                            },
                            onerror: function () {
                                loader.remove();
                                ongoingFavorite = false;
                            },
                        });
                    });
                }
            }
        }

        // Add favorite buttons to stories
        const isStoryPage = ["/", "/news", "/newest", "/front", "/ask", "/show", "/jobs"].some((p) => path === p || path.startsWith(p + "?"));

        if (isStoryPage) {
            const items = document.querySelectorAll("td.subtext span.subline");
            for (const item of items) {
                const lastAnchorButton = item.lastElementChild;
                const separatorPipe = document.createTextNode(" | ");
                const faveButton = document.createElement("a");
                faveButton.innerText = "favorite";
                faveButton.classList.add("__rhn__fave-button");

                item.insertBefore(faveButton, lastAnchorButton);
                item.insertBefore(separatorPipe, lastAnchorButton);

                const authStringElement = item.querySelector('a[href^="flag"]') || item.querySelector('a[href^="hide"]');

                if (authStringElement) {
                    const authStringUrl = authStringElement.href.replace("?", "&");
                    const auth = getUrlParams("auth", authStringUrl);
                    const id = getUrlParams("id", authStringUrl);

                    faveButton.href = `fave?id=${id}&auth=${auth}`;
                    let ongoingFavorite = false;

                    faveButton.addEventListener("click", async (event) => {
                        event.preventDefault();
                        if (ongoingFavorite) return;
                        ongoingFavorite = true;

                        const loader = createSiblingLoader(faveButton, loaderCustomStyle);

                        GM_xmlhttpRequest({
                            method: "GET",
                            url: faveButton.href,
                            onload: function () {
                                loader.remove();
                                faveButton.innerHTML = "favorited";
                                ongoingFavorite = false;
                            },
                            onerror: function () {
                                loader.remove();
                                ongoingFavorite = false;
                            },
                        });
                    });
                }
            }
        }

        return true;
    }

    // ============================================================================
    // FEATURE 3: KEYBOARD NAVIGATION
    // ============================================================================

    function initKeyboardNavigation() {
        const path = window.location.pathname;
        const focusClass = "__rhn__focussed-item";
        const isCommentList = path === "/item" || path.includes("/item?");

        const itemData = {
            items: [],
            index: 0,
            activeItem: undefined,
            commentList: isCommentList,
        };

        function activateItem(itemData) {
            itemData.activeItem = itemData.items[itemData.index];
            itemData.activeItem.classList.add(focusClass);
        }

        function setActiveItemFromElement(element) {
            itemData.items = getItemList();
            const targetIndex = itemData.items.findIndex((item) => item === element || item.contains(element));
            if (targetIndex === -1) return;

            if (itemData.activeItem) {
                itemData.activeItem.classList.remove(focusClass);
            }

            itemData.index = targetIndex;
            activateItem(itemData);

            if (!elementInScrollView(itemData.activeItem)) {
                itemData.activeItem.scrollIntoView({ block: "nearest" });
            }
        }

        function getItemList() {
            const itemList = isCommentList
                ? [...document.querySelectorAll("tr.comtr:not(.noshow) td.default")]
                : [...document.querySelectorAll("table.itemlist tr.athing:not(.__rhn__no-display)")];

            const moreLink = document.querySelector("a.morelink");
            if (moreLink) itemList.push(moreLink);

            return itemList;
        }

        function getCommentIndentation(element) {
            const parent = element.parentElement;
            const indentImg = parent.querySelector(".ind img");
            return indentImg ? indentImg.width / 40 : 0;
        }

        function getNextCommentWithSameIndent(itemData, direction) {
            let { items, index, activeItem } = itemData;

            if (activeItem.matches("a.morelink")) {
                return index;
            }

            const activeItemIndentation = getCommentIndentation(activeItem);

            let nextItemIndent;
            do {
                if (index === (direction === 1 ? items.length - 1 : 0)) {
                    return index;
                }

                index += direction;

                // If index is of 'More' link, then make it undefined
                nextItemIndent = index === items.length - 1 ? undefined : getCommentIndentation(items[index]);
            } while (nextItemIndent && nextItemIndent > activeItemIndentation);

            return index;
        }

        const keyHandlers = {
            // Move down (J key)
            down: function (itemData, event) {
                if (itemData.index === itemData.items.length - 1) {
                    activateItem(itemData);
                    return;
                }

                itemData.items[itemData.index].classList.remove(focusClass);

                if (itemData.activeItem) {
                    if (event.shiftKey) {
                        if (itemData.commentList) {
                            itemData.index = getNextCommentWithSameIndent(itemData, 1);
                        } else {
                            itemData.index = itemData.items.length - 1;
                        }
                    } else {
                        itemData.index++;
                    }
                }

                activateItem(itemData);

                if (!elementInScrollView(itemData.activeItem)) {
                    itemData.activeItem.scrollIntoView(true);
                }
            },

            // Move up (K key)
            up: function (itemData, event) {
                if (itemData.index === 0) {
                    document.body.scrollTop = 0;
                    return;
                }

                itemData.items[itemData.index].classList.remove(focusClass);

                if (itemData.activeItem) {
                    if (event.shiftKey) {
                        if (itemData.commentList) {
                            itemData.index = getNextCommentWithSameIndent(itemData, -1);
                        } else {
                            itemData.index = 0;
                        }
                    } else {
                        itemData.index--;
                    }
                }

                activateItem(itemData);

                if (!elementInScrollView(itemData.activeItem)) {
                    itemData.activeItem.scrollIntoView(true);
                }
            },

            // Escape
            escape: function (itemData) {
                document.activeElement.blur();

                if (itemData.activeItem) {
                    itemData.activeItem.classList.remove(focusClass);
                    itemData.activeItem = undefined;
                }
            },
        };

        if (itemData.commentList) {
            document.addEventListener("click", (event) => {
                if (isClickModified(event)) return;

                const row = event.target.closest("tr.comtr");
                if (!row) return;

                const targetCell = row.querySelector("td.default");
                if (!targetCell) return;

                setActiveItemFromElement(targetCell);
            });
        }

        window.addEventListener("keydown", (event) => {
            if (["TEXTAREA", "INPUT"].includes(document.activeElement.tagName)) {
                return;
            }

            if (document.activeElement.tagName === "A") {
                document.activeElement.blur();
            }

            itemData.items = getItemList();
            const combo = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;

            switch (event.keyCode) {
                case 74: // J: Go down
                    if (combo && !event.shiftKey) return;
                    keyHandlers.down(itemData, event);
                    return;

                case 75: // K: Go up
                    if (combo && !event.shiftKey) return;
                    keyHandlers.up(itemData, event);
                    return;

                case 27: // Escape
                    if (combo) return;
                    keyHandlers.escape(itemData);
                    return;

                case 13: // Enter
                    if (!itemData.activeItem) return;

                    if (itemData.activeItem.matches("a.morelink")) {
                        if (event.ctrlKey || event.metaKey) {
                            window.open(itemData.activeItem.href, "_blank");
                        } else {
                            itemData.activeItem.click();
                        }
                    } else if (isCommentList) {
                        // Toggle comment
                        const toggleBtn = itemData.activeItem.querySelector("a.togg");
                        if (toggleBtn) toggleBtn.click();
                        itemData.items = getItemList();
                    } else {
                        // Open story
                        const story = itemData.activeItem.querySelector("span.titleline a");
                        if (story) {
                            if (event.ctrlKey || event.metaKey) {
                                window.open(story.href, "_blank");
                            } else {
                                story.click();
                            }
                        }
                    }
                    return;

                case 82: // R: Reply (comments only)
                    if (combo || !isCommentList || !itemData.activeItem) return;
                    const replyBtn = itemData.activeItem.querySelector('a[href^="reply"]');
                    if (replyBtn) replyBtn.click();
                    return;

                case 70: // F: Favorite
                    if (combo || !itemData.activeItem) return;
                    const faveBtn = itemData.activeItem.querySelector('a[href^="fave"]') || itemData.activeItem.querySelector(".__rhn__fave-button");
                    if (faveBtn) faveBtn.click();
                    return;

                case 85: // U: Upvote
                    if (combo || !itemData.activeItem) return;
                    const upvoteBtn = isCommentList
                        ? itemData.activeItem.previousSibling?.querySelector('div.votearrow[title="upvote"]')
                        : itemData.activeItem.querySelector("td.votelinks:not(.nosee) div.votearrow");
                    if (upvoteBtn) upvoteBtn.click();
                    return;

                case 67: // C: Comments (stories only)
                    if (combo && !(event.ctrlKey || event.metaKey)) return;
                    if (isCommentList || !itemData.activeItem) return;
                    const next = itemData.activeItem.nextElementSibling;
                    const commentsLink = next?.querySelector('a[href^="item"]');
                    if (commentsLink) {
                        if (event.ctrlKey || event.metaKey) {
                            window.open(commentsLink.href, "_blank");
                        } else {
                            commentsLink.click();
                        }
                    }
                    return;
            }
        });

        return true;
    }

    // ============================================================================
    // FEATURE 5: COLLAPSE ROOT COMMENT
    // ============================================================================

    function initCollapseRootComment() {
        const comments = getAllComments();
        let currentRootComment;

        for (const comment of comments) {
            const indentLevel = getCommentIndentation(comment);

            if (indentLevel === 0) {
                currentRootComment = comment;
                continue;
            }

            const instCurrentRootComment = currentRootComment;
            const toggle = document.createElement("a");

            toggle.innerText = "[collapse root]";
            toggle.href = "javascript:void(0)";
            toggle.classList.add("__rhn__collapse-root-comment");
            toggle.addEventListener("click", () => {
                instCurrentRootComment.querySelector("a.togg").click();
                const { x, y } = elementPosition(instCurrentRootComment);
                window.scrollTo(x, y);
            });

            comment.querySelector("span.comhead").append(toggle);
        }

        return true;
    }

    // ============================================================================
    // FEATURE 6: CLICK COMMENT INDENT TO TOGGLE
    // ============================================================================

    function initClickCommentIndentToToggle() {
        const comments = getAllComments();
        for (const comment of comments) {
            const indentCell = comment.querySelector("td.ind");
            const toggleBtn = comment.querySelector("a.togg");

            if (indentCell && toggleBtn) {
                indentCell.classList.add("__rhn__clickable-indent");
                indentCell.addEventListener("click", () => {
                    toggleBtn.click();
                });
            }
        }

        return true;
    }

    // ============================================================================
    // FEATURE 7: HIGHLIGHT UNREAD COMMENTS
    // ============================================================================

    function initHighlightUnreadComments() {
        // Get current page item ID
        const urlParams = new URLSearchParams(window.location.search);
        const itemId = urlParams.get("id");
        if (!itemId) return false;

        // Check if item is old enough that replies are disabled
        const replyForm = document.querySelector("table.fatitem form");
        if (!replyForm) return false;

        // Get stored read comments data
        const storageKey = "rhn_readComments";
        let readCommentsList = {};
        try {
            const stored = localStorage.getItem(storageKey);
            readCommentsList = stored ? JSON.parse(stored) : {};
        } catch (e) {
            console.error("Error parsing stored comments:", e);
            readCommentsList = {};
        }

        // Clean up expired entries (older than 3 days)
        const currentMilliseconds = new Date().getTime();
        for (const [id, itemObj] of Object.entries(readCommentsList)) {
            if (itemObj.expiry < currentMilliseconds) {
                delete readCommentsList[id];
            }
        }

        // Get all current comment IDs
        const currentComments = [];
        getAllComments().forEach((comment) => {
            if (comment.id) {
                currentComments.push(comment.id);
            }
        });

        // Get previously read comments for this item
        const itemData = readCommentsList[itemId] || {};
        const readComments = itemData.comments || [];

        // Find new comments (not in previously read list)
        if (readComments.length > 0) {
            const newComments = currentComments.filter((id) => !readComments.includes(id));

            // Highlight new comments
            for (const commentId of newComments) {
                const commentElement = document.getElementById(commentId);
                if (commentElement) {
                    const indentCell = commentElement.querySelector("td.ind");
                    if (indentCell) {
                        indentCell.classList.add("__rhn__new-comment-indent");
                    }
                }
            }
        }

        // Update stored data with all current comments
        readCommentsList[itemId] = {
            expiry: itemData.expiry || new Date().getTime() + 259200000, // 3 days
            comments: [...new Set([...currentComments, ...readComments])], // Remove duplicates
        };

        // Save back to localStorage
        try {
            localStorage.setItem(storageKey, JSON.stringify(readCommentsList));
        } catch (e) {
            console.error("Error saving read comments:", e);
        }

        return true;
    }

    // ============================================================================
    // FEATURE 8: SHOW USER/ITEM INFO ON HOVER
    // ============================================================================

    function initShowUserInfoOnHover() {
        const allUsers = document.querySelectorAll("a.hnuser");
        if (allUsers.length === 0) return false;

        for (const user of allUsers) {
            user.addEventListener("mouseover", async () => {
                let userDiv = user.parentElement.querySelector(".__rhn__hover-info");

                if (!userDiv) {
                    userDiv = document.createElement("div");
                    userDiv.classList.add("__rhn__hover-info", "__rhn__no-display");
                    userDiv.style.left = user.getBoundingClientRect().left + "px";
                    userDiv.innerHTML = `<span style="font-size: 10px; color: #888;">Loading...</span>`;

                    user.parentElement.append(userDiv);
                    user.dataset.rhnInfoLoaded = "0";
                }

                userDiv.classList.remove("__rhn__no-display");
                userDiv.style.left = user.getBoundingClientRect().left + "px";

                if (user.dataset.rhnInfoLoaded === "0") {
                    user.dataset.rhnInfoLoaded = "1";
                    const userInfo = await getUserInfo(user.innerText.split(" ")[0]);

                    if (userInfo) {
                        const userDate = new Date(userInfo.created * 1000);
                        const renderedDate = `${monthNames[userDate.getMonth()]} ${userDate.getDate()}, ${userDate.getFullYear()}`;

                        const table = `
                            <table>
                                <tbody>
                                    <tr><td>user:</td><td>${userInfo.id}</td></tr>
                                    <tr><td>created:</td><td>${renderedDate}</td></tr>
                                    <tr><td>karma:</td><td>${userInfo.karma}</td></tr>
                                    ${userInfo.about ? "<tr><td>about:</td><td>" + userInfo.about + "</td></tr>" : ""}
                                </tbody>
                            </table>
                        `;

                        userDiv.innerHTML = table;
                    }
                }
            });

            user.addEventListener("mouseout", () => {
                const userDiv = user.parentElement.querySelector(".__rhn__hover-info");
                if (userDiv) {
                    userDiv.classList.add("__rhn__no-display");
                }
            });
        }

        return true;
    }

    function initShowItemInfoOnHover() {
        const links = document.querySelectorAll('span.commtext a[href*="news.ycombinator.com/item?id="]');

        for (const link of links) {
            const itemDiv = document.createElement("div");
            itemDiv.classList.add("__rhn__hover-info", "__rhn__no-display");
            itemDiv.style.left = link.getBoundingClientRect().left + "px";
            itemDiv.innerHTML = `<span style="font-size: 10px; color: #888;">Loading...</span>`;

            link.parentElement.insertBefore(itemDiv, link.nextSibling);
            link.dataset.rhnInfoLoaded = "0";

            link.addEventListener("mouseover", async () => {
                itemDiv.classList.remove("__rhn__no-display");
                itemDiv.style.left = link.getBoundingClientRect().left + "px";

                if (link.dataset.rhnInfoLoaded === "0") {
                    link.dataset.rhnInfoLoaded = "1";
                    const id = getUrlParams("id", link.href);
                    const itemInfo = await getItemInfo(id);

                    if (itemInfo) {
                        const itemDate = new Date(itemInfo.time * 1000);
                        const renderedDate = `${monthNames[itemDate.getMonth()]} ${itemDate.getDate()}, ${itemDate.getFullYear()}`;

                        let table = "";

                        switch (itemInfo.type) {
                            case "comment":
                                table = `
                                    <table>
                                        <tbody>
                                            <tr><td>by:</td><td>${itemInfo.by}</td></tr>
                                            <tr><td>date:</td><td>${renderedDate}</td></tr>
                                            <tr><td>text:</td><td>${itemInfo.text}</td></tr>
                                        </tbody>
                                    </table>
                                `;
                                break;

                            case "story":
                                const text = itemInfo.text ? `<tr><td>text:</td><td>${itemInfo.text}</td></tr>` : "";
                                const url = itemInfo.url ? `<tr><td>url:</td><td>${itemInfo.url}</td></tr>` : "";
                                const comments = itemInfo.kids ? `<tr><td>comments:</td><td>${itemInfo.kids.length}</td></tr>` : "";

                                table = `
                                    <table>
                                        <tbody>
                                            <tr><td>title:</td><td>${itemInfo.title}</td></tr>
                                            ${url}
                                            <tr><td>by:</td><td>${itemInfo.by}</td></tr>
                                            <tr><td>date:</td><td>${renderedDate}</td></tr>
                                            <tr><td>score:</td><td>${itemInfo.score}</td></tr>
                                            ${comments}
                                            ${text}
                                        </tbody>
                                    </table>
                                `;
                                break;
                        }

                        itemDiv.innerHTML = table;
                    }
                }
            });

            link.addEventListener("mouseout", () => {
                itemDiv.classList.add("__rhn__no-display");
            });
        }

        return true;
    }

    // ============================================================================
    // MAIN INITIALIZATION
    // ============================================================================

    function init() {
        console.log("Refined Hacker News userscript loaded");

        // Initialize features based on page type
        const path = window.location.pathname;

        // Feature 1: Reply without leaving page (comment pages only, requires login)
        if ((path === "/item" || path.includes("/item?")) && document.querySelector("a#me")) {
            try {
                initReplyWithoutLeavingPage();
                console.log("✓ Reply without leaving page initialized");
            } catch (e) {
                console.error("Failed to initialize reply feature:", e);
            }
        }

        // Feature 2: More accessible favorites (requires login)
        if (document.querySelector("a#me")) {
            try {
                initMoreAccessibleFavorite();
                console.log("✓ Accessible favorites initialized");
            } catch (e) {
                console.error("Failed to initialize favorites feature:", e);
            }
        }

        // Feature 3: Keyboard navigation (all pages)
        try {
            initKeyboardNavigation();
            console.log("✓ Keyboard navigation initialized");
        } catch (e) {
            console.error("Failed to initialize keyboard navigation:", e);
        }

        // Feature 4: Collapse root comment (comment pages)
        if (path === "/item" || path.includes("/item?")) {
            try {
                initCollapseRootComment();
                console.log("✓ Collapse root comment initialized");
            } catch (e) {
                console.error("Failed to initialize collapse root comment:", e);
            }
        }

        // Feature 5: Click comment indent to toggle (comment pages)
        if (path === "/item" || path.includes("/item?")) {
            try {
                initClickCommentIndentToToggle();
                console.log("✓ Click comment indent to toggle initialized");
            } catch (e) {
                console.error("Failed to initialize click indent toggle:", e);
            }
        }

        // Feature 6: Highlight unread comments (comment pages)
        if (path === "/item" || path.includes("/item?")) {
            try {
                initHighlightUnreadComments();
                console.log("✓ Highlight unread comments initialized");
            } catch (e) {
                console.error("Failed to initialize highlight unread comments:", e);
            }
        }

        // Feature 7: Show user info on hover (all pages)
        try {
            initShowUserInfoOnHover();
            console.log("✓ User info on hover initialized");
        } catch (e) {
            console.error("Failed to initialize user info hover:", e);
        }

        // Feature 8: Show item info on hover (comment pages)
        if (path === "/item" || path.includes("/item?")) {
            try {
                initShowItemInfoOnHover();
                console.log("✓ Item info on hover initialized");
            } catch (e) {
                console.error("Failed to initialize item info hover:", e);
            }
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
