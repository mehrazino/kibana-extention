(function () {
    'use strict';

    const LOG_CAP = 2000;
    const MAX_MSG_LEN = 500;
    const LOG_STORAGE_KEY = 'bulkNoteLogs';
    const LOG_SEQ_STORAGE_KEY = 'bulkNoteLogSeq';

    const SAVE_DEBOUNCE_MS = 200;
    const MIN_SAVE_INTERVAL_MS = 750;
    const CLEAR_WAIT_MAX_MS = 2000;
    const JSON_COPY_TIMEOUT_MS = 20000;

    const TAG_EMOJI = {
        init: '⚙️',
        main: '🚀',
        state: '🔧',
        version: '🏷️',
        selection: '👆',
        collect: '🔍',
        'bulk-probe': '🎯',
        'bulk-intercept': '🪄',
        'api-query': '🌐',
        dom: '🌳',
        copy: '📝',
        delete: '🗑️',
        ui: '🔄',
        interceptor: '🛡️',
        note: '📄',
        'json-copy': '📋'
    };

    const LEADING_EMOJI_RE =
        /^(?:[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2B00}-\u{2BFF}]|[\u{1F1E6}-\u{1F1FF}])[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]*\s*/u;

    function resolveEmoji(level, message) {
        if (level === 'error') return '❌';
        if (level === 'warn') return '⚠️';
        if (level === 'success') return '✅';
        const m = String(message || '');
        const match = m.match(/^\[([a-z-]+)\]/i);
        if (match && TAG_EMOJI[match[1].toLowerCase()]) {
            return TAG_EMOJI[match[1].toLowerCase()];
        }
        return 'ℹ️';
    }

    function formatMessage(level, message) {
        const raw = String(message == null ? '' : message).slice(0, MAX_MSG_LEN);
        const cleaned = raw.replace(LEADING_EMOJI_RE, '');
        return `${resolveEmoji(level, cleaned)} ${cleaned}`;
    }

    const state = {
        enabled: false,
        deleteMode: false,
        pageDetected: /\/app\/security(\/|$)/.test(location.pathname),
        mainLoaded: false,
        fetchPatched: false,
        alertsCaptured: 0,
        lastEvents: [],
        logSeq: 0,
        kbnVersion: '8.19.5'
    };

    let manualVersion = null;
    let logSeqCounter = 0;
    let selectionLogTimeout = null;
    let ready = false;
    let jsonCopyResolve = null;

    let lastPersistedSeq = -1;
    let lastPersistedTopId = null;
    let saveTimer = null;
    let saving = false;
    let savePending = false;

    function formatClock(d) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    }

    function scheduleSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            persistNow();
        }, SAVE_DEBOUNCE_MS);
    }

    function persistNow() {
        if (saving) {
            savePending = true;
            return;
        }

        const topId = state.lastEvents.length > 0 ? state.lastEvents[0].id : null;
        const topSeq = state.lastEvents.length > 0 ? state.lastEvents[0].seq : -1;

        if (topSeq === lastPersistedSeq && topId === lastPersistedTopId) {
            return;
        }

        saving = true;
        const payload = {
            [LOG_STORAGE_KEY]: state.lastEvents,
            [LOG_SEQ_STORAGE_KEY]: logSeqCounter
        };

        try {
            chrome.storage.local.set(payload, () => {
                saving = false;
                const err = chrome.runtime.lastError;

                if (err) {
                    if (state.lastEvents.length > 200) {
                        state.lastEvents.length = Math.floor(state.lastEvents.length / 2);
                    }
                    lastPersistedSeq = -1;
                    lastPersistedTopId = null;
                    setTimeout(persistNow, 500);
                } else {
                    lastPersistedSeq = topSeq;
                    lastPersistedTopId = topId;
                }

                if (savePending) {
                    savePending = false;
                    setTimeout(persistNow, MIN_SAVE_INTERVAL_MS);
                }
            });
        } catch (e) {
            saving = false;
        }
    }

    function flushLogs() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        persistNow();
    }

    function addEvent(msg, level, meta) {
        meta = meta || {};
        const d = meta.ts ? new Date(meta.ts) : new Date();
        logSeqCounter++;

        const entry = {
            id: `${d.getTime()}-${logSeqCounter}`,
            seq: logSeqCounter,
            t: formatClock(d),
            ts: d.toISOString(),
            lvl: level || 'info',
            source: meta.source || 'ISOLATED',
            msg: formatMessage(level || 'info', msg)
        };

        state.lastEvents.unshift(entry);
        if (state.lastEvents.length > LOG_CAP) {
            state.lastEvents.length = LOG_CAP;
        }
        state.logSeq = logSeqCounter;
        scheduleSave();
    }

    function notifyBackground() {
        try {
            if (chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    type: 'UPDATE_ICON',
                    enabled: state.enabled,
                    deleteMode: state.deleteMode,
                    pageDetected: state.pageDetected
                });
            }
        } catch (_err) {}
    }

    function detectKibanaVersion() {
        try {
            const m = document.body && document.body.className &&
                      document.body.className.match(/kbnVersion-([\d-]+)/);
            if (m && m[1]) return m[1].replace(/-/g, '.');
        } catch (_) {}
        return '8.19.5';
    }

    function getEffectiveVersion() {
        return manualVersion || detectKibanaVersion();
    }

    function broadcastVersion() {
        state.kbnVersion = getEffectiveVersion();
        window.postMessage({
            source: 'BulkNote-ISOLATED',
            type: 'SET_VERSION',
            data: { kbnVersion: state.kbnVersion }
        }, '*');
    }

    function broadcastState() {
        broadcastVersion();
        window.postMessage({ source: 'BulkNote-ISOLATED', type: 'SET_ENABLED', data: state.enabled }, '*');
        window.postMessage({ source: 'BulkNote-ISOLATED', type: 'SET_DELETE_MODE', data: state.deleteMode }, '*');
    }

    function extractCount(text) {
        if (!text) return null;
        const m1 = text.match(/Selected\s+(\d+)\s+alerts?/i);
        if (m1) return parseInt(m1[1], 10);
        const m2 = text.match(/(\d+)\s+alerts?/i);
        if (m2) return parseInt(m2[1], 10);
        return null;
    }

    function getSelectedAlertsCountFromUI() {
        const selectors = [
            '[data-test-subj="selectedShowBulkActionsButton"]',
            '[data-test-subj="bulk-actions-button-container"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const c = extractCount(el.textContent);
                if (c !== null && c > 0) return c;
            }
        }
        let count = 0;
        document.querySelectorAll('div[role="row"][data-grid-row-index]').forEach(row => {
            const isChecked =
                row.querySelector('input[data-test-subj="bulk-actions-row-cell"]:checked') ||
                row.querySelector('.euiCheckbox__square-selected');
            if (isChecked) count++;
        });
        return count;
    }

    function updateSelectionState() {
        const count = getSelectedAlertsCountFromUI();
        state.alertsCaptured = count;
        if (count > 0) {
            addEvent(`[selection] ${count} pre-selected alert(s)`, 'info');
            return;
        }
        setTimeout(() => {
            const retryCount = getSelectedAlertsCountFromUI();
            if (retryCount > 0) {
                state.alertsCaptured = retryCount;
                addEvent(`[selection] ${retryCount} pre-selected alert(s)`, 'info');
            } else {
                addEvent('[selection] No pre-selected alerts', 'info');
            }
        }, 300);
    }

    window.addEventListener('message', (ev) => {
        if (ev.source !== window) return;
        if (!ev.data || ev.data.source !== 'BulkNote-MAIN') return;

        const { type, data } = ev.data;

        if (type === 'JSON_COPY_RESULT') {
            if (jsonCopyResolve) {
                const fn = jsonCopyResolve;
                jsonCopyResolve = null;
                fn(data);
            }
            return;
        }

        switch (type) {
            case 'MAIN_LOADED':
                if (!state.mainLoaded && ready) {
                    addEvent('[main] MAIN script loaded', 'info', {
                        source: 'MAIN', ts: data && data.ts
                    });
                }
                state.mainLoaded = true;
                if (ready) broadcastState();
                break;

            case 'FETCH_PATCHED':
                if (!state.fetchPatched && ready) {
                    addEvent('[main] fetch patched', 'info', {
                        source: 'MAIN', ts: data && data.ts
                    });
                }
                state.fetchPatched = true;
                break;

            case 'ALERTS_CAPTURED':
                if (data && typeof data.count === 'number') {
                    state.alertsCaptured = data.count;
                }
                break;

            case 'LOG':
                if (data) {
                    addEvent(
                        data.message,
                        data.level,
                        { source: data.source || 'MAIN', ts: data.ts }
                    );
                }
                break;
        }
    });

    function pingMain() {
        window.postMessage({ source: 'BulkNote-ISOLATED', type: 'PING_MAIN' }, '*');
    }

    if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
            if (!msg || !msg.type) return;

            if (msg.type === 'GET_STATE') {
                const liveCount = getSelectedAlertsCountFromUI();
                state.alertsCaptured = liveCount;

                const sinceSeq = typeof msg.sinceSeq === 'number' ? msg.sinceSeq : 0;
                const events = sinceSeq > 0
                    ? state.lastEvents.filter(e => (e.seq || 0) > sinceSeq)
                    : state.lastEvents.slice(0);

                sendResponse({
                    enabled: state.enabled,
                    deleteMode: state.deleteMode,
                    pageDetected: state.pageDetected,
                    mainLoaded: state.mainLoaded,
                    fetchPatched: state.fetchPatched,
                    alertsCaptured: liveCount,
                    lastEvents: events,
                    logSeq: state.logSeq,
                    kbnVersion: state.kbnVersion
                });
                return;
            }

            if (msg.type === 'TOGGLE') {
                state.enabled = !state.enabled;

                try { chrome.storage.local.set({ bulkNoteEnabled: state.enabled }); } catch (_) {}

                window.postMessage({ source: 'BulkNote-ISOLATED', type: 'SET_ENABLED', data: state.enabled }, '*');
                addEvent(`[state] Feature ${state.enabled ? 'ENABLED' : 'DISABLED'}`, 'info');

                if (state.enabled) {
                    setTimeout(updateSelectionState, 50);
                }

                notifyBackground();
                sendResponse({ enabled: state.enabled, deleteMode: state.deleteMode });
                return;
            }

            if (msg.type === 'TOGGLE_DELETE') {
                state.deleteMode = !state.deleteMode;
                try { chrome.storage.local.set({ bulkNoteDeleteMode: state.deleteMode }); } catch (_) {}
                window.postMessage({ source: 'BulkNote-ISOLATED', type: 'SET_DELETE_MODE', data: state.deleteMode }, '*');
                addEvent(`[state] Delete Mode ${state.deleteMode ? 'ENABLED' : 'DISABLED'}`, 'info');
                notifyBackground();
                sendResponse({ deleteMode: state.deleteMode });
                return;
            }

            if (msg.type === 'TRIGGER_REFRESH') {
                window.postMessage({ source: 'BulkNote-ISOLATED', type: 'TRIGGER_REFRESH' }, '*');
                sendResponse({ ok: true });
                return;
            }

            if (msg.type === 'CLEAR_LOGS') {
                const doClear = () => {
                    state.lastEvents = [];
                    state.logSeq = 0;
                    logSeqCounter = 0;
                    lastPersistedSeq = -1;
                    lastPersistedTopId = null;
                    savePending = false;
                    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
                    try {
                        chrome.storage.local.set({
                            [LOG_STORAGE_KEY]: [],
                            [LOG_SEQ_STORAGE_KEY]: 0
                        });
                    } catch (_) {}
                    sendResponse({ ok: true });
                };

                if (saving) {
                    const start = Date.now();
                    const waitForSave = () => {
                        if (saving && Date.now() - start < CLEAR_WAIT_MAX_MS) {
                            setTimeout(waitForSave, 50);
                        } else {
                            doClear();
                        }
                    };
                    waitForSave();
                } else {
                    doClear();
                }
                return true;
            }

            if (msg.type === 'COPY_SELECTED_JSON') {
                if (jsonCopyResolve) {
                    sendResponse({ ok: false, error: 'busy' });
                    return;
                }

                const requestId = Date.now() + '-' + Math.random();
                let responded = false;
                let timer = null;

                const respond = (data) => {
                    if (responded) return;
                    responded = true;
                    jsonCopyResolve = null;
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    try { sendResponse(data); } catch (_) {}
                };

                jsonCopyResolve = respond;

                timer = setTimeout(() => {
                    respond({ ok: false, error: 'timeout' });
                }, JSON_COPY_TIMEOUT_MS);

                window.postMessage({
                    source: 'BulkNote-ISOLATED',
                    type: 'REQUEST_JSON_COPY',
                    data: { requestId }
                }, '*');

                return true;
            }
        });
    }

    document.addEventListener('change', (e) => {
        const target = e.target;
        if (target && target.type === 'checkbox' &&
            (target.getAttribute('data-test-subj') === 'bulk-actions-row-cell' ||
             target.id === 'selection-toggle')) {

            if (selectionLogTimeout) clearTimeout(selectionLogTimeout);
            selectionLogTimeout = setTimeout(() => {
                const count = getSelectedAlertsCountFromUI();
                state.alertsCaptured = count;
                if (state.enabled) {
                    addEvent(`[selection] ${count} alert(s) selected`, 'info');
                }
            }, 300);
        }
    });

    window.addEventListener('pagehide', flushLogs);
    window.addEventListener('beforeunload', flushLogs);

    function initialize() {
        try {
            chrome.storage.local.get([
                'bulkNoteEnabled',
                'bulkNoteDeleteMode',
                'bulkNoteKbnVersion',
                LOG_STORAGE_KEY,
                LOG_SEQ_STORAGE_KEY
            ], (res) => {
                res = res || {};

                if (Array.isArray(res[LOG_STORAGE_KEY])) {
                    state.lastEvents = res[LOG_STORAGE_KEY].slice(0, LOG_CAP);
                }

                let maxSeq = 0;
                for (const e of state.lastEvents) {
                    if (e && typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
                }
                const storedSeq = typeof res[LOG_SEQ_STORAGE_KEY] === 'number'
                    ? res[LOG_SEQ_STORAGE_KEY] : 0;
                logSeqCounter = Math.max(maxSeq, storedSeq);
                state.logSeq = logSeqCounter;

                if (state.lastEvents.length > 0) {
                    const top = state.lastEvents[0];
                    if (typeof top.seq === 'number') {
                        lastPersistedSeq = top.seq;
                        lastPersistedTopId = top.id || null;
                    }
                }

                const priorCount = state.lastEvents.length;

                state.enabled = !!res.bulkNoteEnabled;
                state.deleteMode = !!res.bulkNoteDeleteMode;
                manualVersion = res.bulkNoteKbnVersion ? String(res.bulkNoteKbnVersion) : null;
                state.kbnVersion = getEffectiveVersion();

                ready = true;

                addEvent('[init] Content script loaded', 'info');
                addEvent(
                    `[init] Session started${priorCount > 0 ? ` (+${priorCount} prior)` : ''}`,
                    'info'
                );
                addEvent(`[init] State: ${state.enabled ? 'ENABLED' : 'DISABLED'} (v${state.kbnVersion})`, 'info');
                addEvent(`[init] Page: ${state.pageDetected ? 'detected' : 'not detected'}`, 'info');

                if (state.mainLoaded) {
                    addEvent('[main] MAIN script loaded', 'info', { source: 'MAIN' });
                }
                if (state.fetchPatched) {
                    addEvent('[main] fetch patched', 'info', { source: 'MAIN' });
                }

                broadcastState();
                notifyBackground();
                setTimeout(pingMain, 0);
            });

            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                if (changes.bulkNoteKbnVersion) {
                    manualVersion = changes.bulkNoteKbnVersion.newValue
                        ? String(changes.bulkNoteKbnVersion.newValue) : null;
                    broadcastVersion();
                    if (ready) {
                        addEvent(`[version] Override: ${state.kbnVersion}`, 'info');
                    }
                }
            });
        } catch (e) {
            ready = true;
            addEvent(`[init] Storage unavailable: ${e.message}`, 'warn');
        }
    }

    initialize();
})();