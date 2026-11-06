(async function () {
    'use strict';

    const el = {
        toggle:             document.getElementById('toggle-switch'),
        toggleDelete:       document.getElementById('toggle-delete'),
        deleteSwitchLabel:  document.getElementById('delete-switch-label'),
        deleteIcon:         document.getElementById('delete-icon'),
        toggleLogs:         document.getElementById('toggle-logs'),
        logsCard:           document.getElementById('logs-card'),
        logsBody:           document.getElementById('logs-body'),
        logsIcon:           document.getElementById('logs-icon'),
        brandLogo:          document.getElementById('brand-logo'),
        copyJsonIcon:       document.getElementById('copy-json-icon'),
        logs:               document.getElementById('logs'),
        logsCount:          document.getElementById('logs-count'),
        copyLogs:           document.getElementById('copyLogsBtn'),
        copyLogsText:       document.getElementById('copyLogsText'),
        clearLogs:          document.getElementById('clearLogsBtn'),
        clearLogsText:      document.getElementById('clearLogsText'),
        copyAlertsJson:     document.getElementById('copyAlertsJsonBtn'),
        copyAlertsJsonText: document.getElementById('copyAlertsJsonText'),
        footerLink:         document.querySelector('.footer-link')
    };

    if (el.footerLink) {
        el.footerLink.addEventListener('click', (e) => {
            e.preventDefault();
            try {
                chrome.tabs.create({ url: 'https://github.com/mehrazino/kibana-extention' });
            } catch (_) {}
        });
    }

    let prefersReducedMotion = false;
    try {
        prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {}

    try {
        if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('interpolate-size', 'allow-keywords')) {
            document.documentElement.classList.add('supports-interpolate-size');
        }
    } catch {}

    document.body.style.opacity = '0';
    const revealTimer = setTimeout(() => { document.body.style.opacity = '1'; }, 300);
    function revealNow() {
        clearTimeout(revealTimer);
        document.body.style.opacity = '1';
    }

    const POLL_INTERVAL       = 200;
    const MAX_UI_LOGS         = 2000;
    const RENDER_BATCH        = 100;
    const PANEL_ANIM_FALLBACK = 260;
    const HEIGHT_ANIM_MS      = 220;

    let currentState          = null;
    let pendingToggle         = false;
    let pendingToggleDelete   = false;
    let pollInterval          = null;
    let currentTabId          = null;
    let sendMsg               = null;
    let pollInFlight          = false;
    let jsonCopyWorking       = false;

    let isPanelAnimating             = false;
    let pendingRenderWhileAnimating  = false;
    let panelAnimTimer               = null;

    let logCache = [];
    const renderedIds = new Set();
    const cachedIds   = new Set();

    function updateLogsCount(count) {
        if (!el.logsCount) return;
        const c = String(count || 0);
        if (el.logsCount.textContent !== c) el.logsCount.textContent = c;
        el.logsCount.classList.toggle('has-items', count > 0);
    }

    function updateBrandIcon(isActive) {
        if (el.brandLogo) el.brandLogo.classList.toggle('is-active', !!isActive);
    }

    function updateDeleteIcon(isActive) {
        if (el.deleteIcon) el.deleteIcon.classList.toggle('is-active', !!isActive);
    }

    function updateLogsIcon(isActive) {
        if (el.logsIcon) el.logsIcon.classList.toggle('is-active', !!isActive);
    }

    function updateJsonCopyReady(isReady) {
        const ready = !!isReady;
        if (el.copyJsonIcon) el.copyJsonIcon.classList.toggle('is-active', ready);
        if (el.copyAlertsJson) el.copyAlertsJson.classList.toggle('btn-yellow', ready);
    }

    function setMainToggleAvailable(available) {
        if (!el.toggle) return;
        el.toggle.disabled = !available;
        const wrapper = el.toggle.closest('.switch');
        if (wrapper) wrapper.classList.toggle('disabled', !available);
        if (el.brandLogo) el.brandLogo.classList.toggle('disabled', !available);
    }

    function scrollLogsToBottom() {
        if (!el.logs) return;
        requestAnimationFrame(() => {
            el.logs.scrollTop = el.logs.scrollHeight;
        });
    }

    function finishPanelAnimation() {
        if (!isPanelAnimating) return;
        isPanelAnimating = false;

        if (panelAnimTimer) {
            clearTimeout(panelAnimTimer);
            panelAnimTimer = null;
        }
        if (el.logsCard) el.logsCard.classList.remove('animating');

        const isOpen = !!(el.logsCard && el.logsCard.classList.contains('open'));

        if (pendingRenderWhileAnimating) {
            pendingRenderWhileAnimating = false;
            if (isOpen) renderLogEntries(true);
        }

        if (isOpen) scrollLogsToBottom();
    }

    function applyLogsOpen(open, animate = true) {
        if (!el.logsCard) return;

        if (el.toggleLogs) el.toggleLogs.checked = open;
        updateLogsIcon(open);

        const wasOpen = el.logsCard.classList.contains('open');
        if (wasOpen === open) return;

        if (open) renderLogEntries(true);

        if (!animate || prefersReducedMotion) {
            if (el.logsBody) el.logsBody.style.transition = 'none';
            el.logsCard.classList.toggle('open', open);
            if (el.logsBody) {
                void el.logsBody.offsetHeight;
                el.logsBody.style.transition = '';
            }
            if (open) scrollLogsToBottom();
            return;
        }

        if (panelAnimTimer) {
            clearTimeout(panelAnimTimer);
            panelAnimTimer = null;
        }

        isPanelAnimating = true;
        el.logsCard.classList.add('animating');
        el.logsCard.classList.toggle('open', open);

        panelAnimTimer = setTimeout(finishPanelAnimation, PANEL_ANIM_FALLBACK);
    }

    if (el.logsBody) {
        el.logsBody.addEventListener('transitionend', (e) => {
            if (e.propertyName === 'grid-template-rows' || e.propertyName === 'height') {
                finishPanelAnimation();
            }
        });
    }

    function showButtonState(btn, textSpan, label, state, defaultLabel) {
        if (!btn || !textSpan) return;
        if (btn._stateTimer) clearTimeout(btn._stateTimer);

        textSpan.textContent = label;
        btn.classList.toggle('btn-success', state === 'success');
        btn.classList.toggle('btn-danger',  state === 'danger');

        btn._stateTimer = setTimeout(() => {
            btn.classList.remove('btn-success');
            btn.classList.remove('btn-danger');
            textSpan.textContent = defaultLabel;
            btn._stateTimer = null;
        }, 1500);
    }

    function animateLogsContainerHeight(mutate) {
        const node = el.logs;
        if (!node) { mutate(); return; }

        if (prefersReducedMotion || isPanelAnimating) {
            mutate();
            return;
        }

        if (node._hTimer) {
            clearTimeout(node._hTimer);
            node._hTimer = null;
            node.style.transition = '';
            node.style.overflow   = '';
            node.style.height     = '';
            node.style.willChange = '';
        }

        const startH = node.offsetHeight;
        mutate();
        const endH = node.offsetHeight;

        if (Math.abs(startH - endH) < 4) return;

        node.style.transition = 'none';
        node.style.overflow   = 'hidden';
        node.style.height     = startH + 'px';
        node.style.willChange = 'height';
        void node.offsetHeight;

        node.style.transition = `height ${HEIGHT_ANIM_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
        node.style.height     = endH + 'px';

        node._hTimer = setTimeout(() => {
            node.style.transition = '';
            node.style.overflow   = '';
            node.style.height     = '';
            node.style.willChange = '';
            node._hTimer = null;
        }, HEIGHT_ANIM_MS + 30);
    }

    function makeLogNode(entry) {
        let lvlClass = '';
        if (entry.lvl === 'error')        lvlClass = 'lvl-error';
        else if (entry.lvl === 'warn')    lvlClass = 'lvl-warn';
        else if (entry.lvl === 'success') lvlClass = 'lvl-success';

        const row = document.createElement('div');
        row.className = 'log-entry ' + lvlClass;
        row.dataset.logId = entry.id;

        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = '[' + entry.t + ']';

        const msg = document.createElement('span');
        msg.className = 'log-msg';
        msg.textContent = entry.msg;

        row.appendChild(time);
        row.appendChild(msg);
        return row;
    }

    function clearRenderedLogs() {
        if (!el.logs) return;
        el.logs.innerHTML = '';
        renderedIds.clear();
    }

    function renderLogEntries(force = false) {
        const node = el.logs;
        if (!node) return;

        if (isPanelAnimating && !force) {
            pendingRenderWhileAnimating = true;
            return;
        }

        if (node._hTimer) {
            clearTimeout(node._hTimer);
            node._hTimer = null;
            node.style.transition = '';
            node.style.overflow   = '';
            node.style.height     = '';
            node.style.willChange = '';
        }

        if (logCache.length === 0) {
            clearRenderedLogs();
            node.classList.add('is-empty');
            const empty = document.createElement('div');
            empty.className = 'log-entry logs-empty';
            empty.textContent = 'No activity yet';
            node.appendChild(empty);
            return;
        }

        node.classList.remove('is-empty');
        const emptyEl = node.querySelector('.logs-empty');
        if (emptyEl) emptyEl.remove();

        const wasAtBottom =
            (node.scrollHeight - node.scrollTop - node.clientHeight) < 24;
        const prevScrollTop = node.scrollTop;

        const newEntries = [];
        for (const entry of logCache) {
            if (!renderedIds.has(entry.id)) newEntries.push(entry);
        }

        if (newEntries.length === 0) {
            if (node.children.length > logCache.length) {
                const toRemove = [];
                for (const child of node.children) {
                    const id = child.dataset.logId;
                    if (id && !cachedIds.has(id)) toRemove.push(child);
                }
                for (const child of toRemove) {
                    renderedIds.delete(child.dataset.logId);
                    child.remove();
                }
            }
            return;
        }

        let idx = 0;
        function appendBatch() {
            const fragment = document.createDocumentFragment();
            const end = Math.min(idx + RENDER_BATCH, newEntries.length);
            for (; idx < end; idx++) {
                const entry = newEntries[idx];
                fragment.appendChild(makeLogNode(entry));
                renderedIds.add(entry.id);
            }
            node.appendChild(fragment);

            if (idx < newEntries.length) {
                requestAnimationFrame(appendBatch);
                return;
            }

            while (node.children.length > MAX_UI_LOGS) {
                const first = node.firstChild;
                if (first && first.dataset.logId) {
                    renderedIds.delete(first.dataset.logId);
                }
                if (first) first.remove();
            }

            if (wasAtBottom) {
                node.scrollTop = node.scrollHeight;
            } else {
                node.scrollTop = prevScrollTop;
            }
        }

        appendBatch();
    }

    function mergeLogs(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return false;
        let added = false;

        for (const entry of entries) {
            if (!entry || !entry.id) continue;
            if (cachedIds.has(entry.id)) continue;
            cachedIds.add(entry.id);
            logCache.push(entry);
            added = true;
        }

        if (!added) return false;

        logCache.sort((a, b) => (a.seq || 0) - (b.seq || 0));

        if (logCache.length > MAX_UI_LOGS) {
            const removed = logCache.splice(0, logCache.length - MAX_UI_LOGS);
            for (const entry of removed) cachedIds.delete(entry.id);
        }

        return true;
    }

    function render(state) {
        if (!state) {
            setMainToggleAvailable(false);
            updateBrandIcon(false);
            updateDeleteIcon(false);
            updateJsonCopyReady(false);
            return;
        }

        setMainToggleAvailable(true);
        currentState = state;

        if (!pendingToggle) {
            if (el.toggle.checked !== state.enabled) el.toggle.checked = state.enabled;
            updateBrandIcon(state.enabled);
        }

        if (!pendingToggleDelete) {
            if (el.toggleDelete.checked !== state.deleteMode) {
                el.toggleDelete.checked = state.deleteMode;
            }
            updateDeleteIcon(state.deleteMode);
        }

        updateJsonCopyReady((state.alertsCaptured || 0) > 0);

        if (Array.isArray(state.lastEvents)) {
            const changed = mergeLogs(state.lastEvents);
            const domEmpty = el.logs && el.logs.children.length === 0;
            if (changed || domEmpty) {
                updateLogsCount(logCache.length);
                renderLogEntries();
            }
        }
    }

    try {
        const res = await new Promise((resolve) => {
            try {
                chrome.storage.local.get(
                    ['bulkNoteEnabled', 'bulkNoteDeleteMode', 'bulkNoteLogsOpen'],
                    (r) => resolve(r || {})
                );
            } catch { resolve({}); }
        });

        el.toggleLogs.addEventListener('change', () => {
            const open = el.toggleLogs.checked;
            applyLogsOpen(open);
            try { chrome.storage.local.set({ bulkNoteLogsOpen: open }); } catch {}
        });

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab || !tab.id) {
            applyLogsOpen(!!res.bulkNoteLogsOpen, false);
            render(null);
            revealNow();
            return;
        }

        currentTabId = tab.id;

        sendMsg = async function (msg) {
            try { return await chrome.tabs.sendMessage(tab.id, msg); }
            catch { return null; }
        };

        render(await sendMsg({ type: 'GET_STATE', sinceSeq: 0 }));

        applyLogsOpen(!!res.bulkNoteLogsOpen, false);

        el.toggle.checked = !!res.bulkNoteEnabled;
        el.toggleDelete.checked = !!res.bulkNoteDeleteMode;
        updateBrandIcon(!!res.bulkNoteEnabled);
        updateDeleteIcon(!!res.bulkNoteDeleteMode);

        revealNow();

        el.toggle.addEventListener('change', async () => {
            const wanted = el.toggle.checked;
            pendingToggle = true;
            updateBrandIcon(wanted);

            let resp = null;
            try { resp = await sendMsg({ type: 'TOGGLE' }); } catch {}

            pendingToggle = false;

            if (resp && typeof resp.enabled === 'boolean') {
                if (currentState) currentState.enabled = resp.enabled;
                el.toggle.checked = resp.enabled;
                updateBrandIcon(resp.enabled);
            } else {
                el.toggle.checked = !wanted;
                updateBrandIcon(!wanted);
            }
        });

        el.toggleDelete.addEventListener('change', async () => {
            const wanted = el.toggleDelete.checked;
            pendingToggleDelete = true;
            updateDeleteIcon(wanted);

            let resp = null;
            try { resp = await sendMsg({ type: 'TOGGLE_DELETE' }); } catch {}

            pendingToggleDelete = false;

            if (resp && typeof resp.deleteMode === 'boolean') {
                if (currentState) currentState.deleteMode = resp.deleteMode;
                el.toggleDelete.checked = resp.deleteMode;
                updateDeleteIcon(resp.deleteMode);
            } else {
                el.toggleDelete.checked = !wanted;
                updateDeleteIcon(!wanted);
            }
        });

        el.copyLogs.addEventListener('click', async () => {
            if (logCache.length === 0) {
                showButtonState(el.copyLogs, el.copyLogsText, 'Empty', null, 'Copy');
                return;
            }

            const logsText = logCache.map(e => `[${e.t}] ${e.msg}`).join('\n');

            let ok = false;
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: (textToCopy) => {
                        const ta = document.createElement('textarea');
                        ta.value = textToCopy;
                        ta.style.position = 'fixed';
                        ta.style.top = '-9999px';
                        ta.style.left = '-9999px';
                        ta.style.opacity = '0.01';
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        ta.setSelectionRange(0, ta.value.length);
                        let copied = false;
                        try { copied = document.execCommand('copy'); } catch {}
                        document.body.removeChild(ta);
                        return copied;
                    },
                    args: [logsText]
                });
                ok = !!(results && results[0] && results[0].result === true);
            } catch (err) {
                console.error('Copy failed:', err);
            }

            if (ok) {
                showButtonState(el.copyLogs, el.copyLogsText, 'Copied', 'success', 'Copy');
            } else {
                showButtonState(el.copyLogs, el.copyLogsText, 'Failed', 'danger', 'Copy');
            }
        });

        el.clearLogs.addEventListener('click', async () => {
            if (logCache.length === 0 && (!currentState || currentState.logSeq === 0)) {
                showButtonState(el.clearLogs, el.clearLogsText, 'Empty', null, 'Clear');
                return;
            }

            let ok = false;
            try {
                const resp = await sendMsg({ type: 'CLEAR_LOGS' });
                ok = !!(resp && resp.ok);
            } catch {}

            if (ok) {
                animateLogsContainerHeight(() => {
                    logCache = [];
                    cachedIds.clear();
                    updateLogsCount(0);
                    renderLogEntries(true);

                    if (currentState) {
                        currentState.lastEvents = [];
                        currentState.logSeq = 0;
                    }
                });

                showButtonState(el.clearLogs, el.clearLogsText, 'Cleared', 'success', 'Clear');
            } else {
                showButtonState(el.clearLogs, el.clearLogsText, 'Failed', 'danger', 'Clear');
            }
        });

        async function doCopyAlertsJson() {
            if (jsonCopyWorking) return;
            jsonCopyWorking = true;

            if (el.copyAlertsJson._stateTimer) {
                clearTimeout(el.copyAlertsJson._stateTimer);
                el.copyAlertsJson._stateTimer = null;
            }

            el.copyAlertsJsonText.textContent = '...';

            let resp = null;
            try { resp = await sendMsg({ type: 'COPY_SELECTED_JSON' }); } catch {}

            jsonCopyWorking = false;

            if (!resp || !resp.ok || !resp.json) {
                const err = resp && resp.error ? resp.error : 'failed';
                if (err === 'no-selection') {
                    showButtonState(el.copyAlertsJson, el.copyAlertsJsonText, 'None', 'danger', 'Copy');
                } else if (err === 'busy') {
                    showButtonState(el.copyAlertsJson, el.copyAlertsJsonText, 'Busy', 'danger', 'Copy');
                } else if (err === 'timeout') {
                    showButtonState(el.copyAlertsJson, el.copyAlertsJsonText, 'T/O', 'danger', 'Copy');
                } else {
                    showButtonState(el.copyAlertsJson, el.copyAlertsJsonText, 'Fail', 'danger', 'Copy');
                }
                return;
            }

            let ok = false;
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: (textToCopy) => {
                        const ta = document.createElement('textarea');
                        ta.value = textToCopy;
                        ta.style.position = 'fixed';
                        ta.style.top = '-9999px';
                        ta.style.left = '-9999px';
                        ta.style.opacity = '0.01';
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        ta.setSelectionRange(0, ta.value.length);
                        let copied = false;
                        try { copied = document.execCommand('copy'); } catch {}
                        document.body.removeChild(ta);
                        return copied;
                    },
                    args: [resp.json]
                });
                ok = !!(results && results[0] && results[0].result === true);
            } catch (err) {
                console.error('Copy JSON failed:', err);
            }

            if (ok) {
                showButtonState(el.copyAlertsJson, el.copyAlertsJsonText, 'Copied', 'success', 'Copy');
            } else {
                showButtonState(el.copyAlertsJson, el.copyAlertsJsonText, 'Fail', 'danger', 'Copy');
            }
        }

        el.copyAlertsJson.addEventListener('click', doCopyAlertsJson);

        function bindIconActivation(iconEl, action) {
            if (!iconEl) return;
            iconEl.addEventListener('click', action);
            iconEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    action();
                }
            });
        }

        bindIconActivation(el.brandLogo, () => {
            if (el.toggle && !el.toggle.disabled) el.toggle.click();
        });

        bindIconActivation(el.deleteIcon, () => {
            if (el.toggleDelete) el.toggleDelete.click();
        });

        bindIconActivation(el.logsIcon, () => {
            if (el.toggleLogs) el.toggleLogs.click();
        });

        bindIconActivation(el.copyJsonIcon, () => {
            if (jsonCopyWorking) return;
            doCopyAlertsJson();
        });

        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (tabId !== currentTabId || changeInfo.status !== 'complete') return;
            clearRenderedLogs();
            logCache = [];
            cachedIds.clear();
            updateLogsCount(0);
            sendMsg({ type: 'GET_STATE', sinceSeq: 0 }).then(render);
        });

        pollInterval = setInterval(async () => {
            if (!sendMsg || pollInFlight) return;
            pollInFlight = true;
            try {
                const lastSeq = logCache.length > 0 ? logCache[logCache.length - 1].seq : 0;
                const s = await sendMsg({ type: 'GET_STATE', sinceSeq: lastSeq });
                render(s);
            } catch {} finally {
                pollInFlight = false;
            }
        }, POLL_INTERVAL);

        const stopPolling = () => {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInFlight = false;
            }
            if (panelAnimTimer) {
                clearTimeout(panelAnimTimer);
                panelAnimTimer = null;
            }
            if (el.logs && el.logs._hTimer) {
                clearTimeout(el.logs._hTimer);
                el.logs._hTimer = null;
            }
        };
        window.addEventListener('unload', stopPolling);
        window.addEventListener('pagehide', stopPolling);
    } catch (e) {
        revealNow();
    }
})();
