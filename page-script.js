(function () {
    'use strict';

    const CONFIG = {
        KBN_VERSION: '8.19.5',
        KBN_BUILD_NUMBER: '13',
        ELASTIC_API_VERSION: '2023-10-31',
        DELAY_BETWEEN_REQUESTS_MS: 5,
        REFRESH_DELAY_MS: 200,
        VERIFY_DELAY_MS: 50,
        COPY_CONCURRENCY: 20,
        DELETE_CONCURRENCY: 10,
        LOG_PER_ALERT_LIMIT: 20,
        API_BATCH_SIZE: 500,
        API_MAX_BATCHES: 40,
        BULK_PROBE_TIMEOUT_MS: 1500,
        MENU_ACTION_WAIT_MS: 1000,
        MENU_ACTION_POLL_MS: 15,
        ASSIGN_CHUNK_SIZE: 100
    };

    const USER_ID_TTL_MS = 5 * 60 * 1000;

    let enabled = false;
    let deleteMode = false;
    let autoAssignEnabled = false;
    let cachedUserId = null;
    let cachedUserIdAt = 0;

    let pendingBulkProbe = null;
    let pendingDelete = null;
    let currentSourceAlertId = null;
    let jsonCopyInProgress = false;

    let isolatedReady = false;
    const pendingLogs = [];
    const MAX_PENDING_LOGS = 500;

    const originalFetch = window.fetch.bind(window);

    let patchChain = Promise.resolve();
    let deleteChain = Promise.resolve();

    let toastSuppressionCount = 0;
    let toastObserver = null;
    let suppressionStyleEl = null;

    function ensureSuppressionStyle() {
        if (suppressionStyleEl && suppressionStyleEl.isConnected) return;
        suppressionStyleEl = document.createElement('style');
        suppressionStyleEl.id = 'bulk-note-suppression';
        suppressionStyleEl.textContent = [
            '.euiToast[data-bulk-probe-suppressed="true"] { display: none !important; }',
            'html[data-bulk-probe-active="true"] .euiPopover:has(.euiContextMenu),',
            'html[data-bulk-probe-active="true"] .euiPopover__panel:has(.euiContextMenu),',
            'html[data-bulk-probe-active="true"] .euiContextMenu,',
            'html[data-bulk-probe-active="true"] .euiContextMenuPanel,',
            'html[data-bulk-probe-active="true"] .euiPopover__arrowWrapper {',
            '  visibility: hidden !important;',
            '  pointer-events: none !important;',
            '  transition: none !important;',
            '  animation: none !important;',
            '}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(suppressionStyleEl);
    }

    function startToastSuppression() {
        toastSuppressionCount++;
        ensureSuppressionStyle();
        if (toastSuppressionCount === 1) {
            document.documentElement.setAttribute('data-bulk-probe-active', 'true');
        }
        if (toastObserver) return;

        const attach = () => {
            if (toastSuppressionCount <= 0) return;
            const container = document.querySelector('[data-test-subj="globalToastList"]');
            if (!container) {
                setTimeout(attach, 100);
                return;
            }

            toastObserver = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (!node.classList || !node.classList.contains('euiToast')) continue;
                        const titleEl = node.querySelector('[data-test-subj="euiToastHeader__title"]');
                        const titleText = titleEl ? (titleEl.textContent || '').toLowerCase() : '';
                        if (titleText.includes('opened') ||
                            titleText.includes('closed') ||
                            titleText.includes('acknowledged')) {
                            node.setAttribute('data-bulk-probe-suppressed', 'true');
                        }
                    }
                }
            });
            toastObserver.observe(container, { childList: true });
        };
        attach();
    }

    function releaseToastSuppression(delayMs) {
        const d = typeof delayMs === 'number' ? delayMs : 2000;
        setTimeout(() => {
            toastSuppressionCount = Math.max(0, toastSuppressionCount - 1);
            if (toastSuppressionCount === 0) {
                document.documentElement.removeAttribute('data-bulk-probe-active');
                if (toastObserver) {
                    toastObserver.disconnect();
                    toastObserver = null;
                }
            }
        }, d);
    }

    function hudStart(type, total) {
        try { return window.__bulkNoteHud ? window.__bulkNoteHud.start(type, total) : null; }
        catch (_) { return null; }
    }

    function hudUpdate(id, patch) {
        if (!id) return;
        try { if (window.__bulkNoteHud) window.__bulkNoteHud.update(id, patch); } catch (_) {}
    }

    function hudComplete(id, status) {
        if (!id) return;
        try { if (window.__bulkNoteHud) window.__bulkNoteHud.complete(id, status); } catch (_) {}
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function runWithConcurrency(items, limit, worker) {
        if (!items.length) return [];
        const results = new Array(items.length);
        let cursor = 0;
        async function runner() {
            while (true) {
                const i = cursor++;
                if (i >= items.length) return;
                results[i] = await worker(items[i], i);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
        return results;
    }

    function send(type, data) {
        window.postMessage({ source: 'BulkNote-MAIN', type, data: data || {} }, '*');
    }

    function logEvent(level, message, data) {
        const p = {
            level: level || 'info',
            message: String(message ?? ''),
            ts: new Date().toISOString(),
            source: 'MAIN',
            data: data || null
        };
        if (!isolatedReady) {
            pendingLogs.push(p);
            if (pendingLogs.length > MAX_PENDING_LOGS) pendingLogs.shift();
            return;
        }
        send('LOG', p);
    }

    function flushPendingLogs() {
        while (pendingLogs.length > 0) send('LOG', pendingLogs.shift());
    }

    function normalizeText(str) {
        if (!str) return '';
        return String(str)
            .normalize('NFC')
            .replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFE00-\uFE0F\uFEFF]/g, '')
            .replace(/\s*\(\s*(?:external\s*,?\s*)?opens in (?:a\s+)?new (?:tab|window)(?:\s+or\s+(?:tab|window))?\s*\)/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function truncate(str, n) {
        const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n) + '…' : s;
    }

    function safeSlice(id, n) {
        return (typeof id === 'string' ? id : String(id || '')).slice(0, n);
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
        return 0;
    }

    function extractEventIdFromRow(rowEl) {
        if (!rowEl) return null;
        const btn = rowEl.querySelector('button[data-test-subj="expand-event"]');
        if (btn) {
            const d = btn.getAttribute('data-event-id') || btn.getAttribute('data-document-id') || btn.getAttribute('data-id');
            if (d && /^[a-f0-9-]{16,}$/i.test(d)) return d;
            const aria = btn.getAttribute('aria-label') || '';
            const m = aria.match(/([a-f0-9]{40,64})/i);
            if (m) return m[1];
        }
        const any = rowEl.querySelector('[data-document-id]');
        if (any) {
            const id = any.getAttribute('data-document-id');
            if (id && /^[a-f0-9-]{16,}$/i.test(id)) return id;
        }
        return null;
    }

    async function waitForElement(selectors, timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return el;
            }
            await sleep(CONFIG.MENU_ACTION_POLL_MS);
        }
        return null;
    }

    function extractDocumentIdsFromUrl(url) {
        try {
            const u = new URL(url, location.origin);
            const ids = u.searchParams.getAll('documentIds');
            return ids.length > 0 ? ids : null;
        } catch (_) {
            return null;
        }
    }

    async function probeBulkSignalIds() {
        return new Promise((resolve) => {
            startToastSuppression();

            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                pendingBulkProbe = null;
                releaseToastSuppression(2000);
                logEvent('warn', '[bulk-probe] Timeout waiting for signal_ids');
                resolve(null);
            }, CONFIG.BULK_PROBE_TIMEOUT_MS);

            pendingBulkProbe = {
                resolve: (ids) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    pendingBulkProbe = null;
                    releaseToastSuppression(2000);
                    resolve(ids);
                }
            };

            const opener = document.querySelector('[data-test-subj="selectedShowBulkActionsButton"]') ||
                           document.querySelector('[data-test-subj="bulk-actions-button-container"] button');

            if (!opener) {
                logEvent('warn', '[bulk-probe] No bulk actions menu opener found');
                pendingBulkProbe = null;
                clearTimeout(timer);
                settled = true;
                releaseToastSuppression(500);
                resolve(null);
                return;
            }

            logEvent('info', '[bulk-probe] Opening menu');

            try {
                opener.click();
            } catch (e) {
                logEvent('error', `[bulk-probe] Failed to open menu: ${e.message}`);
                pendingBulkProbe = null;
                clearTimeout(timer);
                settled = true;
                releaseToastSuppression(500);
                resolve(null);
                return;
            }

            (async () => {
                try {
                    const actionItem = await waitForElement([
                        '[data-test-subj="open-alert-status"]',
                        '[data-test-subj="acknowledged-alert-status"]',
                        '[data-test-subj="close-alert-status"]'
                    ], CONFIG.MENU_ACTION_WAIT_MS);

                    if (settled) return;

                    if (!actionItem) {
                        logEvent('warn', '[bulk-probe] No actionable item found');
                        pendingBulkProbe = null;
                        clearTimeout(timer);
                        settled = true;
                        releaseToastSuppression(500);
                        resolve(null);
                        return;
                    }

                    logEvent('info', `[bulk-probe] Triggering "${actionItem.getAttribute('data-test-subj')}"`);
                    actionItem.click();
                } catch (e) {
                    logEvent('error', `[bulk-probe] ${e.message}`);
                    if (!settled) {
                        settled = true;
                        pendingBulkProbe = null;
                        clearTimeout(timer);
                        releaseToastSuppression(500);
                        resolve(null);
                    }
                }
            })();
        });
    }

    function extractTimeRange() {
        try {
            const url = new URL(location.href);
            const tr = url.searchParams.get('timerange');
            if (!tr) return null;
            const fm = tr.match(/from:'([^']+)'/);
            const tm = tr.match(/to:'([^']+)'/);
            if (fm && tm) return { from: fm[1], to: tm[1] };
        } catch (_) {}
        return null;
    }

    async function fetchAllAlertIdsFromQuery() {
        try {
            const tr = extractTimeRange();
            const boolQuery = { must: [{ term: { 'kibana.alert.workflow_status': 'open' } }], filter: [] };
            if (tr) boolQuery.filter.push({ range: { '@timestamp': { gte: tr.from, lte: tr.to } } });

            const allIds = [];
            let searchAfter = null;
            let batch = 0;

            while (batch < CONFIG.API_MAX_BATCHES) {
                batch++;
                const q = {
                    query: { bool: boolQuery },
                    size: CONFIG.API_BATCH_SIZE,
                    _source: false,
                    track_total_hits: true,
                    sort: [{ '@timestamp': { order: 'desc' } }]
                };
                if (searchAfter) q.search_after = searchAfter;

                const res = await originalFetch('/api/detection_engine/signals/search', {
                    method: 'POST',
                    headers: buildHeaders(),
                    body: JSON.stringify(q)
                });
                if (!res.ok) {
                    logEvent('warn', `[api-query] Batch ${batch} HTTP ${res.status}`);
                    break;
                }

                const json = await res.json();
                let hits = [];
                if (json.rawResponse?.hits?.hits) hits = json.rawResponse.hits.hits;
                else if (json.hits?.hits) hits = json.hits.hits;
                if (!Array.isArray(hits) || hits.length === 0) break;

                allIds.push(...hits.map(h => h._id || h.id).filter(Boolean));
                if (hits.length < CONFIG.API_BATCH_SIZE) break;
                const last = hits[hits.length - 1];
                if (last?.sort) searchAfter = last.sort;
                else break;
            }

            return allIds.length > 0 ? allIds : null;
        } catch (e) {
            logEvent('warn', `[api-query] ${e.message}`);
            return null;
        }
    }

    function collectIdsFromDom() {
        const ids = new Set();
        document.querySelectorAll('div[role="row"][data-grid-row-index]').forEach(row => {
            const cb = row.querySelector('input[type="checkbox"]');
            const isChecked =
                row.querySelector('input[data-test-subj="bulk-actions-row-cell"]:checked') ||
                row.getAttribute('aria-selected') === 'true' ||
                (cb && cb.checked);
            if (isChecked) {
                const id = extractEventIdFromRow(row);
                if (id) ids.add(id);
            }
        });
        return Array.from(ids);
    }

    async function collectAllSelectedTargets(sourceEventId) {
        const uiCount = getSelectedAlertsCountFromUI();
        const expected = Math.max(0, uiCount - 1);
        logEvent('info', `[collect] UI selected: ${uiCount}, expected: ${expected}`);

        if (expected <= 0) {
            return { ids: [], uiCount, method: 'no-selection' };
        }

        const probedIds = await probeBulkSignalIds();
        if (probedIds && probedIds.length > 0) {
            const filtered = probedIds.filter(id => id !== sourceEventId);
            if (filtered.length >= expected) {
                logEvent('success', `[bulk-probe] ${probedIds.length} signal_ids (${filtered.length} targets)`);
                return { ids: filtered, uiCount, method: 'bulk-probe' };
            }
            logEvent('warn', `[bulk-probe] ${filtered.length}/${expected} - partial`);
        }

        const apiIds = await fetchAllAlertIdsFromQuery();
        if (apiIds && apiIds.length > 0) {
            if (apiIds.length === uiCount) {
                const filtered = apiIds.filter(id => id !== sourceEventId);
                logEvent('success', `[api-query] ${apiIds.length} IDs (Select All confirmed)`);
                return { ids: filtered, uiCount, method: 'api-query' };
            }
            logEvent('info', `[api-query] ${apiIds.length} != UI ${uiCount} - not Select All`);
        }

        const domIds = collectIdsFromDom();
        if (domIds.length >= expected) {
            logEvent('success', `[dom] ${domIds.length} IDs`);
            return { ids: domIds.filter(id => id !== sourceEventId), uiCount, method: 'dom' };
        }
        logEvent('warn', `[dom] ${domIds.length}/${expected} - insufficient`);
        logEvent('warn', '[collect] All strategies exhausted');
        return { ids: domIds.filter(id => id !== sourceEventId), uiCount, method: 'partial' };
    }

    window.fetch = async function (...args) {
        try {
            const [input, init] = args;
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

            if (method === 'POST' && url.includes('/api/detection_engine/signals/status')) {
                if (!pendingBulkProbe) {
                    return originalFetch(...args);
                }

                let bodyText = null;
                if (init && typeof init.body === 'string') bodyText = init.body;
                else if (input instanceof Request) bodyText = await input.clone().text();

                let bodyJson = null;
                if (bodyText) { try { bodyJson = JSON.parse(bodyText); } catch (_) {} }

                const signalIds = bodyJson?.signal_ids || bodyJson?.alert_ids;
                let updatedCount = 0;

                if (Array.isArray(signalIds) && signalIds.length > 0) {
                    updatedCount = signalIds.length;
                    logEvent('info', `[bulk-intercept] Captured ${signalIds.length} signal_ids`);
                    pendingBulkProbe.resolve(signalIds);
                } else {
                    logEvent('warn', '[bulk-intercept] No signal_ids in probe request');
                }

                logEvent('info', '[bulk-intercept] Aborting probe request');
                return new Response(JSON.stringify({
                    took: 1,
                    timed_out: false,
                    total: updatedCount,
                    updated: updatedCount,
                    version: CONFIG.KBN_VERSION,
                    failures: [],
                    _probe: true
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            if (method === 'DELETE' && url.includes('/api/note')) {
                let bodyText = null;
                if (init && typeof init.body === 'string') bodyText = init.body;
                else if (input instanceof Request) bodyText = await input.clone().text();
                let bodyJson = null;
                if (bodyText) { try { bodyJson = JSON.parse(bodyText); } catch (_) {} }

                const res = await originalFetch(...args);

                if (deleteMode && bodyJson && bodyJson.noteIds) {
                    if (pendingDelete && pendingDelete.text) {
                        const text = pendingDelete.text;
                        const srcId = currentSourceAlertId;
                        logEvent('info', `[delete] Queued fan-out ("${truncate(text, 100)}")`);
                        deleteChain = deleteChain
                            .then(() => doDeleteFanOut(text, srcId))
                            .catch(e => logEvent('error', `[delete] ${e.message}`));
                    }
                    pendingDelete = null;
                    currentSourceAlertId = null;
                }
                return res;
            }

            if (method === 'GET' && url.includes('/api/note')) {
                const ids = extractDocumentIdsFromUrl(url);
                if (ids && ids.length > 0) {
                    const uc = getSelectedAlertsCountFromUI();
                    if (ids.length === uc && uc > 0) {
                        send('ALERTS_CAPTURED', { count: ids.length });
                    }
                }
                return originalFetch(...args);
            }

            if (method === 'PATCH' && url.includes('/api/note')) {
                let bodyText = null;
                if (init && typeof init.body === 'string') bodyText = init.body;
                else if (input instanceof Request) bodyText = await input.clone().text();
                let bodyJson = null;
                if (bodyText) { try { bodyJson = JSON.parse(bodyText); } catch (_) {} }

                if (bodyJson && bodyJson.note && bodyJson.note.note && bodyJson.note.eventId) {
                    if (enabled) {
                        const sid = bodyJson.note.eventId;
                        const txt = bodyJson.note.note;
                        logEvent('info', `[copy] PATCH for ${safeSlice(sid, 8)} | "${truncate(txt, 100)}"`);
                        const patch = { sourceEventId: sid, noteText: txt, timestamp: Date.now() };
                        patchChain = patchChain
                            .then(() => doProcessPatch(patch))
                            .catch(e => logEvent('error', `[copy] ${e.message}`));
                    }
                    return originalFetch(...args);
                }
            }

            return originalFetch(...args);
        } catch (err) {
            logEvent('error', `[interceptor] ${err.message}`);
            return originalFetch(...args);
        }
    };

    async function doProcessPatch(patch) {
        if (!enabled) {
            logEvent('info', '[copy] Skipped (disabled)');
            return;
        }

        const { sourceEventId, noteText } = patch;
        const { ids, uiCount, method } = await collectAllSelectedTargets(sourceEventId);

        if (ids.length === 0) {
            logEvent('warn', `[copy] No targets (method=${method}, UI=${uiCount})`);
            send('COPY_DONE', { ok: 0, fail: 0 });
            return;
        }

        if (uiCount > 1 && ids.length < uiCount - 1) {
            logEvent('warn', `[copy] Partial: ${ids.length}/${uiCount - 1} via ${method}`);
        }

        logEvent('info', `[copy] Sending to ${ids.length} alert(s) [${method}]`);
        await executePatchFanOut(ids, sourceEventId, noteText);
    }

    async function executePatchFanOut(targets, sourceEventId, noteText) {
        const actual = sourceEventId ? targets.filter(t => t !== sourceEventId) : targets;
        const verbose = actual.length <= CONFIG.LOG_PER_ALERT_LIMIT;
        let ok = 0;
        let fail = 0;
        const successfulIds = [];

        const hudId = hudStart('copy', actual.length);

        await runWithConcurrency(actual, CONFIG.COPY_CONCURRENCY, async (id) => {
            try {
                const r = await originalFetch('/api/note', {
                    method: 'PATCH',
                    headers: buildHeaders(),
                    body: JSON.stringify({ note: { timelineId: '', eventId: id, note: noteText } })
                });
                if (r.ok) {
                    ok++;
                    successfulIds.push(id);
                    if (verbose) logEvent('info', `[copy] ${safeSlice(id, 8)} OK`);
                } else {
                    fail++;
                    logEvent('error', `[copy] ${safeSlice(id, 8)} HTTP ${r.status}`);
                }
            } catch (e) {
                fail++;
                logEvent('error', `[copy] ${safeSlice(id, 8)} ${e.message}`);
            }
            hudUpdate(hudId, { completed: ok, failed: fail });
            await sleep(CONFIG.DELAY_BETWEEN_REQUESTS_MS);
        });

        let lvl = 'success';
        if (fail > 0 && ok > 0) lvl = 'warn';
        else if (fail > 0 && ok === 0) lvl = 'error';
        logEvent(lvl, `[copy] Done: ${ok} OK, ${fail} failed`);

        hudComplete(hudId, fail > 0 && ok === 0 ? 'failed' : 'complete');

        if (autoAssignEnabled) {
            const idsToAssign = [...successfulIds];
            if (sourceEventId) idsToAssign.push(sourceEventId);
            if (idsToAssign.length > 0) {
                await performAutoAssign(idsToAssign);
            }
        }

        send('COPY_DONE', { ok, fail });
        setTimeout(refreshTable, CONFIG.REFRESH_DELAY_MS);
    }

    async function getCurrentUserId() {
        try {
            const meRes = await originalFetch('/internal/security/me', { headers: buildHeaders() });
            if (meRes.ok) {
                const me = await meRes.json();
                if (me.profile_uid) {
                    return me.profile_uid;
                }
                if (me.username) {
                    logEvent('info', `[assign] /me returned no profile_uid, falling back to users/_find for "${me.username}"`);
                    const foundUid = await lookupUserIdByUsername(me.username);
                    if (foundUid) return foundUid;
                }
            } else {
                logEvent('warn', `[assign] /internal/security/me HTTP ${meRes.status}`);
            }
        } catch (e) {
            logEvent('warn', `[assign] /me failed: ${e.message}`);
        }
        return null;
    }

    async function getUserIdWithTTL() {
        if (cachedUserId && (Date.now() - cachedUserIdAt < USER_ID_TTL_MS)) {
            return cachedUserId;
        }
        const fresh = await getCurrentUserId();
        if (fresh) {
            cachedUserId = fresh;
            cachedUserIdAt = Date.now();
            logEvent('info', `[assign] Resolved user: ${fresh}`);
            return fresh;
        }
        cachedUserId = null;
        cachedUserIdAt = 0;
        return null;
    }

    async function lookupUserIdByUsername(username) {
        try {
            const headers = buildHeaders();
            headers['elastic-api-version'] = '1';
            const url = `/internal/detection_engine/users/_find?searchTerm=${encodeURIComponent(username)}`;
            const res = await originalFetch(url, { headers });
            if (!res.ok) {
                logEvent('warn', `[assign] users/_find HTTP ${res.status}`);
                return null;
            }
            const data = await res.json();
            const users = data.users || [];
            for (const user of users) {
                if (user.name === username && user.uid) {
                    return user.uid;
                }
            }
            if (users.length > 0 && users[0].uid) {
                return users[0].uid;
            }
        } catch (e) {
            logEvent('warn', `[assign] users/_find failed: ${e.message}`);
        }
        return null;
    }

    async function performAutoAssign(ids) {
        try {
            const uid = await getUserIdWithTTL();
            if (!uid) {
                throw new Error('Could not resolve current user profile_uid');
            }

            logEvent('info', `[assign] Assigning ${ids.length} alert(s) to ${uid}`);

            const hudId = hudStart('assign', ids.length);
            let totalAssigned = 0;
            let assignFails = 0;

            for (let i = 0; i < ids.length; i += CONFIG.ASSIGN_CHUNK_SIZE) {
                const chunk = ids.slice(i, i + CONFIG.ASSIGN_CHUNK_SIZE);
                const res = await originalFetch('/api/detection_engine/signals/assignees', {
                    method: 'POST',
                    headers: buildHeaders(),
                    body: JSON.stringify({
                        assignees: { add: [uid], remove: [] },
                        ids: chunk
                    })
                });

                if (res.ok) {
                    totalAssigned += chunk.length;
                } else {
                    assignFails += chunk.length;
                    const errText = await res.text().catch(() => '');
                    logEvent('error', `[assign] HTTP ${res.status} for chunk of ${chunk.length}${errText ? ' — ' + errText.slice(0, 200) : ''}`);
                }
                hudUpdate(hudId, { completed: totalAssigned, failed: assignFails });
            }

            if (totalAssigned > 0) {
                logEvent('success', `[assign] Successfully assigned ${totalAssigned} alert(s) to you`);
            }
            if (assignFails > 0) {
                logEvent('warn', `[assign] Failed to assign ${assignFails} alert(s)`);
            }

            hudComplete(hudId, totalAssigned === 0 ? 'failed' : 'complete');
        } catch (e) {
            logEvent('error', `[assign] Failed: ${e.message}`);
            cachedUserId = null;
            cachedUserIdAt = 0;
        }
    }

    async function fetchNotes(id) {
        try {
            const r = await originalFetch(`/api/note?documentIds=${id}`, { headers: buildHeaders() });
            const j = await r.json();
            const l = j.notes || j.data || j.response || [];
            return Array.isArray(l) ? l : [];
        } catch (_) {
            return null;
        }
    }

    async function doDeleteFanOut(text, srcId) {
        if (!deleteMode) {
            logEvent('info', '[delete] Skipped (disabled)');
            return;
        }

        const { ids, uiCount, method } = await collectAllSelectedTargets(srcId);
        if (ids.length === 0) {
            logEvent('warn', `[delete] No targets (method=${method})`);
            return;
        }

        if (uiCount > 1 && ids.length < uiCount - 1) {
            logEvent('warn', `[delete] Partial: ${ids.length}/${uiCount - 1} via ${method}`);
        }

        logEvent('info', `[delete] Sending to ${ids.length} alert(s) [${method}]`);
        const tgt = normalizeText(text);
        const verbose = ids.length <= CONFIG.LOG_PER_ALERT_LIMIT;
        let ok = 0;
        let fail = 0;
        let nm = 0;

        const hudId = hudStart('delete', ids.length);

        await runWithConcurrency(ids, CONFIG.DELETE_CONCURRENCY, async (id) => {
            try {
                const notes = await fetchNotes(id);
                if (notes === null) {
                    fail++;
                    logEvent('error', `[delete] ${safeSlice(id, 8)} fetch failed`);
                    hudUpdate(hudId, { completed: ok + nm, failed: fail });
                    return;
                }

                let found = null;
                for (const n of notes) {
                    if (normalizeText(n.note) === tgt) {
                        found = n;
                        break;
                    }
                }

                if (!found || !found.noteId) {
                    nm++;
                    if (verbose) logEvent('info', `[delete] ${safeSlice(id, 8)} no match`);
                    hudUpdate(hudId, { completed: ok + nm, failed: fail });
                    return;
                }

                const d = await originalFetch('/api/note', {
                    method: 'DELETE',
                    headers: buildHeaders(),
                    body: JSON.stringify({ noteIds: [found.noteId] })
                });

                if (!d.ok) {
                    fail++;
                    logEvent('error', `[delete] ${safeSlice(id, 8)} HTTP ${d.status}`);
                    hudUpdate(hudId, { completed: ok + nm, failed: fail });
                    return;
                }

                await sleep(CONFIG.VERIFY_DELAY_MS);
                const v = await fetchNotes(id);
                if (v === null) {
                    fail++;
                    logEvent('warn', `[delete] ${safeSlice(id, 8)} verify failed`);
                } else if (v.some(n => n.noteId === found.noteId)) {
                    fail++;
                    logEvent('error', `[delete] ${safeSlice(id, 8)} verify: still present`);
                } else {
                    ok++;
                    if (verbose) logEvent('info', `[delete] ${safeSlice(id, 8)} OK`);
                }
            } catch (e) {
                fail++;
                logEvent('error', `[delete] ${safeSlice(id, 8)} ${e.message}`);
            }
            hudUpdate(hudId, { completed: ok + nm, failed: fail });
            await sleep(CONFIG.DELAY_BETWEEN_REQUESTS_MS);
        });

        let lvl = 'success';
        if (fail > 0 && ok > 0) lvl = 'warn';
        else if (fail > 0 && ok === 0) lvl = 'error';
        logEvent(lvl, `[delete] Done: ${ok} OK, ${fail} failed, ${nm} no-match`);

        hudComplete(hudId, fail > 0 && ok === 0 ? 'failed' : 'complete');

        setTimeout(refreshTable, CONFIG.REFRESH_DELAY_MS);
    }

    async function getSelectedAlertIds() {
        const uiCount = getSelectedAlertsCountFromUI();
        if (uiCount <= 0) return { ids: [], method: 'none' };

        const domIds = collectIdsFromDom();
        if (domIds.length >= uiCount) {
            logEvent('info', `[json-copy] DOM resolved ${domIds.length} ID(s)`);
            return { ids: domIds, method: 'dom' };
        }

        const probedIds = await probeBulkSignalIds();
        if (probedIds && probedIds.length >= uiCount) {
            logEvent('info', `[json-copy] Probe resolved ${probedIds.length} ID(s)`);
            return { ids: probedIds, method: 'bulk-probe' };
        }

        const apiIds = await fetchAllAlertIdsFromQuery();
        if (apiIds && apiIds.length === uiCount) {
            logEvent('info', `[json-copy] API resolved ${apiIds.length} ID(s)`);
            return { ids: apiIds, method: 'api-query' };
        }

        const fallback = domIds.length > 0 ? domIds : (probedIds || []);
        if (fallback.length > 0) {
            return { ids: fallback, method: 'partial' };
        }

        return { ids: [], method: 'failed' };
    }

    async function fetchAlertsJsonByIds(ids) {
        if (!ids || ids.length === 0) return null;

        const results = [];

        for (let i = 0; i < ids.length; i += CONFIG.API_BATCH_SIZE) {
            const batch = ids.slice(i, i + CONFIG.API_BATCH_SIZE);

            const q = {
                query: { ids: { values: batch } },
                size: batch.length,
                _source: true
            };

            const res = await originalFetch('/api/detection_engine/signals/search', {
                method: 'POST',
                headers: buildHeaders(),
                body: JSON.stringify(q)
            });

            if (!res.ok) {
                logEvent('warn', `[json-copy] Batch HTTP ${res.status}`);
                continue;
            }

            const json = await res.json();
            let hits = [];
            if (json.rawResponse?.hits?.hits) hits = json.rawResponse.hits.hits;
            else if (json.hits?.hits) hits = json.hits.hits;

            if (Array.isArray(hits)) results.push(...hits);
        }

        return results;
    }

    async function handleJsonCopyRequest(requestId) {
        if (jsonCopyInProgress) {
            send('JSON_COPY_RESULT', { requestId, ok: false, error: 'busy' });
            return;
        }

        jsonCopyInProgress = true;

        try {
            logEvent('info', '[json-copy] Starting');

            const { ids, method } = await getSelectedAlertIds();

            if (ids.length === 0) {
                logEvent('warn', `[json-copy] No alerts resolved (method=${method})`);
                send('JSON_COPY_RESULT', { requestId, ok: false, error: 'no-selection' });
                return;
            }

            logEvent('info', `[json-copy] Fetching JSON for ${ids.length} alert(s) [${method}]`);

            const hits = await fetchAlertsJsonByIds(ids);

            if (!hits || hits.length === 0) {
                logEvent('warn', '[json-copy] No JSON data returned');
                send('JSON_COPY_RESULT', { requestId, ok: false, error: 'no-data' });
                return;
            }

            const jsonText = JSON.stringify(hits, null, 2);
            logEvent('success', `[json-copy] Ready: ${hits.length} alert JSON(s)`);
            send('JSON_COPY_RESULT', { requestId, ok: true, json: jsonText, count: hits.length });
        } catch (e) {
            logEvent('error', `[json-copy] ${e.message}`);
            send('JSON_COPY_RESULT', { requestId, ok: false, error: e.message });
        } finally {
            jsonCopyInProgress = false;
        }
    }

    function buildHeaders() {
        return {
            'Content-Type': 'application/json',
            'kbn-version': CONFIG.KBN_VERSION,
            'kbn-build-number': CONFIG.KBN_BUILD_NUMBER,
            'elastic-api-version': CONFIG.ELASTIC_API_VERSION,
            'kbn-xsrf': 'true',
            'x-elastic-internal-origin': 'Kibana',
            'x-kbn-context': JSON.stringify({
                type: 'application',
                name: 'securitySolutionUI',
                url: '/app/security/alerts',
                page: '/alerts'
            })
        };
    }

    function refreshTable() {
        const b = document.querySelector('button[data-test-subj="querySubmitButton"]');
        if (b) {
            b.click();
            logEvent('info', '[ui] Refreshed');
        }
    }

    window.addEventListener('message', (ev) => {
        if (ev.source !== window || !ev.data || ev.data.source !== 'BulkNote-ISOLATED') return;
        const { type, data } = ev.data;

        if (type === 'PING_MAIN') {
            if (!isolatedReady) {
                isolatedReady = true;
                flushPendingLogs();
            }
            send('MAIN_LOADED', {});
            send('FETCH_PATCHED', {});
            return;
        }

        if (type === 'SET_ENABLED') {
            const newState = !!data;
            if (enabled !== newState) {
                enabled = newState;
                if (!enabled) {
                    if (pendingBulkProbe) logEvent('info', '[state] Cancelled probe');
                    pendingBulkProbe = null;
                }
            }
        } else if (type === 'SET_DELETE_MODE') {
            deleteMode = !!data;
        } else if (type === 'SET_AUTO_ASSIGN') {
            autoAssignEnabled = !!data;
        } else if (type === 'SET_VERSION') {
            if (data && data.kbnVersion) CONFIG.KBN_VERSION = data.kbnVersion;
        } else if (type === 'TRIGGER_REFRESH') {
            refreshTable();
        } else if (type === 'REQUEST_JSON_COPY') {
            handleJsonCopyRequest(data && data.requestId);
        }
    });

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-test-subj^="securitySolutionNotesDeleteNotesButton-"]');
        if (!btn) return;

        const c = btn.closest('.euiCommentEvent');
        if (!c) return;

        const t = c.querySelector('.euiMarkdownFormat');
        if (!t) return;

        const text = (typeof t.innerText === 'string' ? t.innerText : t.textContent).trim();

        pendingDelete = { text };
        try {
            const u = new URL(window.location.href);
            const f = u.searchParams.get('flyout');
            if (f) {
                const m = f.match(/([a-f0-9]{64})/i) || f.match(/([a-f0-9]{40})/i);
                if (m) currentSourceAlertId = m[1];
            }
        } catch (_) {}
        logEvent('info', `[delete] Captured: "${truncate(pendingDelete.text, 100)}"`);
    });

    send('MAIN_LOADED', {});
    send('FETCH_PATCHED', {});
})();
