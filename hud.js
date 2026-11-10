(function () {
    'use strict';

    if (window.__bulkNoteHud) return;

    const HUD_ID = 'bulk-note-hud';
    const HIDE_DELAY_MS = 3000;
    const HIDE_DELAY_DELETE_MS = 8000;
    const UPDATE_THROTTLE_MS = 80;
    const FONT_STACK = '"Intel One Mono", ui-monospace, "SF Mono", Consolas, monospace';

    const FONT_BASE = (() => {
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                return chrome.runtime.getURL('intel-one-mono-woff2/');
            }
        } catch (_) {}
        return '';
    })();

    const ICONS = {
        copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm4-1a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm2 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/><path fill-rule="evenodd" d="M2 1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v4.414L8.414 11H14a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H2Zm3 12v-3H2V2h12v8H8l-3 3Z" clip-rule="evenodd"/></svg>',
        delete: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 6H6v6h1V6Zm2.997 0h-1v6h1V6Z"/><path fill-rule="evenodd" d="M5 2v1H2v1h1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4h1V3h-3V2a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1Zm5 0H6v1h4V2ZM4 14V4h8v10H4Z" clip-rule="evenodd"/></svg>',
        assign: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 3a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm1 5a4 4 0 0 0-4 4v3h1v-3a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v3h1v-3a4 4 0 0 0-4-4H7Z"/></svg>',
        check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M15.354 4.354 6.5 13.207 1.646 8.354l.708-.708L6.5 11.793l8.146-8.147.708.708Z" clip-rule="evenodd"/></svg>',
        failed: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M7.293 8 2.646 3.354l.708-.708L8 7.293l4.646-4.647.708.708L8.707 8l4.647 4.646-.707.708L8 8.707l-4.646 4.647-.708-.707L7.293 8Z" clip-rule="evenodd"/></svg>'
    };

    const TITLES = {
        copy: 'Copying notes',
        delete: 'Deleting notes',
        assign: 'Assigning alerts'
    };

    const operations = new Map();
    const renderTimers = new Map();
    const hideTimers = new Map();
    let hudHost = null;
    let hudRoot = null;
    let hudEl = null;
    let isMounted = false;
    let isHudHovered = false;

    const STYLE = `
        @font-face {
            font-family: 'Intel One Mono';
            src: url('${FONT_BASE}IntelOneMono-Regular.woff2') format('woff2');
            font-weight: 400;
            font-style: normal;
            font-display: swap;
        }
        @font-face {
            font-family: 'Intel One Mono';
            src: url('${FONT_BASE}IntelOneMono-Medium.woff2') format('woff2');
            font-weight: 500;
            font-style: normal;
            font-display: swap;
        }
        @font-face {
            font-family: 'Intel One Mono';
            src: url('${FONT_BASE}IntelOneMono-Bold.woff2') format('woff2');
            font-weight: 700;
            font-style: normal;
            font-display: swap;
        }

        :host { all: initial; }
        .hud {
            display: flex;
            flex-direction: column;
            gap: 7px;
            min-width: 280px;
            max-width: 400px;
            padding: 10px;
            background: #1a1d24;
            border: 1px solid rgba(255,255,255,0.09);
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.7);
            font-family: ${FONT_STACK};
            font-size: 12px;
            line-height: 1.5;
            color: #eef1f6;
            pointer-events: auto;
            opacity: 0;
            visibility: hidden;
            transform: translateY(-8px) scale(0.98);
            transition: opacity 0.22s ease,
                        transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
                        visibility 0s linear 0.22s;
        }
        .hud.show {
            opacity: 1;
            visibility: visible;
            transform: translateY(0) scale(1);
            transition: opacity 0.22s ease,
                        transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
                        visibility 0s;
        }

        .op {
            display: grid;
            grid-template-columns: 26px 1fr auto;
            align-items: center;
            gap: 12px;
            padding: 8px 12px;
            background: #121419;
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 6px;
            position: relative;
            overflow: hidden;
            transition: border-color 0.2s ease;
        }
        .op.complete {
            cursor: pointer;
        }
        .op.complete:hover {
            border-color: rgba(255,255,255,0.10);
        }
        .op::before {
            content: '';
            position: absolute;
            inset: 0 auto 0 0;
            width: var(--progress, 0%);
            background: rgba(74,158,255,0.08);
            transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
            z-index: 0;
        }
        .op[data-type="delete"]::before { background: rgba(255,92,92,0.08); }
        .op[data-type="assign"]::before { background: rgba(167,139,250,0.08); }
        .op.complete::before { background: rgba(62,207,142,0.10); }
        .op.failed::before { background: rgba(255,92,92,0.12); }

        .icon {
            position: relative;
            z-index: 1;
            width: 26px;
            height: 26px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 5px;
            background: rgba(74,158,255,0.10);
            color: #4a9eff;
            border: 1px solid rgba(74,158,255,0.22);
            transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease;
        }
        .op[data-type="delete"] .icon {
            background: rgba(255,92,92,0.10);
            color: #ff5c5c;
            border-color: rgba(255,92,92,0.22);
        }
        .op[data-type="assign"] .icon {
            background: rgba(167,139,250,0.10);
            color: #a78bfa;
            border-color: rgba(167,139,250,0.22);
        }
        .op.complete .icon {
            background: rgba(62,207,142,0.10);
            color: #3ecf8e;
            border-color: rgba(62,207,142,0.28);
        }
        .op.failed .icon {
            background: rgba(255,92,92,0.14);
            color: #ff5c5c;
            border-color: rgba(255,92,92,0.35);
        }
        .icon svg {
            width: 16px;
            height: 16px;
            display: block;
            fill: currentColor;
        }

        .label {
            position: relative;
            z-index: 1;
            color: #8b93a3;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: color 0.2s ease;
        }
        .op.complete .label { color: #3ecf8e; }
        .op.failed .label { color: #ff5c5c; }

        .progress {
            position: relative;
            z-index: 1;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            font-size: 11.5px;
            white-space: nowrap;
        }
        .count {
            color: #eef1f6;
            transition: color 0.2s ease;
        }
        .op.complete .count {
            color: #3ecf8e;
            font-weight: 700;
            font-size: 12px;
            letter-spacing: 0.03em;
        }
        .op.failed .count {
            color: #ff5c5c;
            font-weight: 700;
            font-size: 12px;
        }

        .pct {
            color: #8b93a3;
            font-weight: 500;
            min-width: 32px;
            text-align: right;
        }

        .dots {
            display: inline-flex;
            gap: 3px;
            align-items: center;
        }
        .dot {
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: currentColor;
            opacity: 0.35;
            animation: dotPulse 1.2s ease-in-out infinite;
        }
        .dot:nth-child(1) { animation-delay: 0s; }
        .dot:nth-child(2) { animation-delay: 0.2s; }
        .dot:nth-child(3) { animation-delay: 0.4s; }
        .op.complete .dots,
        .op.failed .dots { display: none; }

        .hint {
            grid-column: 1 / -1;
            display: none;
            margin-top: 6px;
            padding: 8px 6px 4px;
            border-top: 1px solid rgba(255,255,255,0.05);
            font-size: 10.5px;
            color: #8b93a3;
            text-align: center;
            font-weight: 500;
            letter-spacing: 0.01em;
            line-height: 1.4;
            transition: color 0.2s ease;
            user-select: none;
            -webkit-user-select: none;
        }
        .op.complete .hint.visible {
            display: block;
            cursor: pointer;
            animation: hintFadeIn 0.3s ease 0.1s both;
        }
        .op.complete .hint.visible:hover {
            color: #eef1f6;
        }
        .hint .refresh-word {
            color: #60a5fa;
            font-weight: 600;
            transition: color 0.2s ease;
        }
        .op.complete .hint.visible:hover .refresh-word {
            color: #93c5fd;
        }

        @keyframes dotPulse {
            0%, 100% { opacity: 0.25; transform: scale(0.85); }
            50%      { opacity: 1;    transform: scale(1); }
        }
        @keyframes hintFadeIn {
            from { opacity: 0; transform: translateY(-4px); }
            to   { opacity: 1; transform: translateY(0); }
        }

        @media (prefers-reduced-motion: reduce) {
            .hud, .op::before, .dot, .op.complete .hint.visible {
                transition: none;
                animation: none;
            }
        }
    `;

    function ensureHud() {
        if (isMounted && hudHost && hudHost.isConnected) return;

        hudHost = document.createElement('div');
        hudHost.id = HUD_ID;
        hudHost.style.cssText = [
            'position: fixed',
            'top: 96px',
            'left: 50%',
            'transform: translateX(-50%)',
            'z-index: 2147483647',
            'pointer-events: none',
            'contain: layout style'
        ].join(';');

        hudRoot = hudHost.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = STYLE;

        hudEl = document.createElement('div');
        hudEl.className = 'hud';

        hudRoot.appendChild(style);
        hudRoot.appendChild(hudEl);

        hudEl.addEventListener('mouseenter', () => {
            isHudHovered = true;
            for (const [id, entry] of hideTimers) {
                if (entry.timerId !== null) pauseHide(id);
            }
        });

        hudEl.addEventListener('mouseleave', () => {
            isHudHovered = false;
            for (const [id, entry] of hideTimers) {
                if (entry.timerId === null) resumeHide(id);
            }
        });

        hudEl.addEventListener('click', (e) => {
            const row = e.target.closest('.op');
            if (!row) return;
            const opId = row.dataset.opId;
            if (!opId) return;
            const op = operations.get(opId);
            if (!op || op.status === 'in-progress') return;
            dismissHide(opId);
        });

        document.documentElement.appendChild(hudHost);
        isMounted = true;
    }

    function buildRow(op) {
        const row = document.createElement('div');
        row.className = 'op';
        row.dataset.opId = op.id;
        row.dataset.type = op.type;

        const icon = document.createElement('div');
        icon.className = 'icon';
        icon.innerHTML = ICONS[op.type] || ICONS.copy;

        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = TITLES[op.type] || op.type;

        const progress = document.createElement('div');
        progress.className = 'progress';

        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = '0/0';

        const pct = document.createElement('span');
        pct.className = 'pct';
        pct.textContent = '0%';

        const dots = document.createElement('span');
        dots.className = 'dots';
        for (let i = 0; i < 3; i++) {
            const d = document.createElement('span');
            d.className = 'dot';
            dots.appendChild(d);
        }

        progress.appendChild(count);
        progress.appendChild(pct);
        progress.appendChild(dots);

        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.innerHTML = 'Please <span class="refresh-word">refresh</span> the page to see the changes';
        hint.addEventListener('click', (e) => {
            e.stopPropagation();
            try { window.location.reload(); } catch (_) {}
        });

        row.appendChild(icon);
        row.appendChild(label);
        row.appendChild(progress);
        row.appendChild(hint);
        return row;
    }

    function scheduleHide(opId, delay) {
        const startedAt = Date.now();
        const timerId = setTimeout(() => {
            hideTimers.delete(opId);
            operations.delete(opId);
            render();
        }, delay);
        hideTimers.set(opId, { timerId, delay, startedAt, remaining: null });
    }

    function pauseHide(opId) {
        const entry = hideTimers.get(opId);
        if (!entry || entry.timerId === null) return;
        clearTimeout(entry.timerId);
        const elapsed = entry.startedAt !== null ? Date.now() - entry.startedAt : 0;
        entry.remaining = Math.max(0, entry.delay - elapsed);
        entry.timerId = null;
    }

    function resumeHide(opId) {
        const entry = hideTimers.get(opId);
        if (!entry || entry.timerId !== null) return;
        const remaining = entry.remaining !== null ? entry.remaining : entry.delay;
        entry.startedAt = Date.now();
        entry.timerId = setTimeout(() => {
            hideTimers.delete(opId);
            operations.delete(opId);
            render();
        }, remaining);
    }

    function dismissHide(opId) {
        const entry = hideTimers.get(opId);
        if (entry && entry.timerId) clearTimeout(entry.timerId);
        hideTimers.delete(opId);
        operations.delete(opId);
        render();
    }

    function render() {
        if (!hudEl) return;

        const ops = Array.from(operations.values());

        if (ops.length === 0) {
            hudEl.classList.remove('show');
            setTimeout(() => {
                if (operations.size === 0 && hudEl) hudEl.innerHTML = '';
            }, 260);
            return;
        }

        hudEl.classList.add('show');

        const existing = new Map();
        for (const child of hudEl.children) {
            if (child.dataset.opId) existing.set(child.dataset.opId, child);
        }

        const seen = new Set();
        for (const op of ops) {
            seen.add(op.id);
            let row = existing.get(op.id);
            if (!row) {
                row = buildRow(op);
                hudEl.appendChild(row);
            }

            const total = op.total || 0;
            const done = op.completed + op.failed;
            const pctVal = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

            row.style.setProperty('--progress', pctVal + '%');
            row.classList.toggle('complete', op.status === 'complete');
            row.classList.toggle('failed', op.status === 'failed');

            const iconEl = row.querySelector('.icon');
            const countEl = row.querySelector('.count');
            const pctEl = row.querySelector('.pct');
            const dotsEl = row.querySelector('.dots');
            const hintEl = row.querySelector('.hint');

            hintEl.classList.remove('visible');

            if (op.status === 'in-progress') {
                iconEl.innerHTML = ICONS[op.type] || ICONS.copy;
                countEl.textContent = `${done}/${total}`;
                pctEl.textContent = pctVal + '%';
                pctEl.style.display = '';
                dotsEl.style.display = '';
            } else if (op.status === 'complete') {
                iconEl.innerHTML = ICONS.check;
                countEl.textContent = 'Done!';
                pctEl.style.display = 'none';
                dotsEl.style.display = 'none';
                if (op.type === 'delete') {
                    hintEl.classList.add('visible');
                }
            } else {
                iconEl.innerHTML = ICONS.failed;
                countEl.textContent = `${op.failed} failed`;
                pctEl.style.display = 'none';
                dotsEl.style.display = 'none';
            }
        }

        for (const [id, node] of existing) {
            if (!seen.has(id)) node.remove();
        }
    }

    function scheduleRender(opId) {
        if (renderTimers.has(opId)) return;
        const t = setTimeout(() => {
            renderTimers.delete(opId);
            render();
        }, UPDATE_THROTTLE_MS);
        renderTimers.set(opId, t);
    }

    function start(type, total) {
        ensureHud();
        const id = type + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        operations.set(id, {
            id,
            type,
            total,
            completed: 0,
            failed: 0,
            status: 'in-progress',
            startedAt: Date.now()
        });
        render();
        return id;
    }

    function update(id, patch) {
        const op = operations.get(id);
        if (!op) return;
        if (patch && typeof patch.completed === 'number') op.completed = patch.completed;
        if (patch && typeof patch.failed === 'number')    op.failed = patch.failed;
        scheduleRender(id);
    }

    function complete(id, status) {
        const op = operations.get(id);
        if (!op) return;
        op.status = status === 'failed' ? 'failed' : 'complete';
        if (renderTimers.has(id)) {
            clearTimeout(renderTimers.get(id));
            renderTimers.delete(id);
        }
        render();

        const delay = (op.type === 'delete' && op.status === 'complete')
            ? HIDE_DELAY_DELETE_MS
            : HIDE_DELAY_MS;

        if (isHudHovered) {
            hideTimers.set(id, { timerId: null, delay, startedAt: null, remaining: delay });
        } else {
            scheduleHide(id, delay);
        }
    }

    window.__bulkNoteHud = { start, update, complete, version: '1.0.0' };
})();
