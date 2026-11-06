const COLOR_ICON = 'elastic-kibana-color.png';
const GRAY_ICON  = 'elastic-kibana-gray.png';

const ICON_SIZES = [16, 32, 48, 128];

function buildIconPath(file) {
    const path = {};
    for (const size of ICON_SIZES) path[size] = file;
    return path;
}

async function applyIcon(showColored) {
    const path = showColored ? buildIconPath(COLOR_ICON) : buildIconPath(GRAY_ICON);
    try {
        await chrome.action.setIcon({ path });
    } catch (err) {
        console.warn('BulkNote: failed to update icon', err);
    }
}

function shouldBeColored(state) {
    if (!state) return false;
    return !!(state.pageDetected && (state.enabled || state.deleteMode));
}

async function refreshForTab(tabId) {
    try {
        const state = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATE', sinceSeq: 0 });
        applyIcon(shouldBeColored(state));
    } catch {
        applyIcon(false);
    }
}

function refreshActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) refreshForTab(tabs[0].id);
        else applyIcon(false);
    });
}

chrome.runtime.onInstalled.addListener(refreshActiveTab);
chrome.runtime.onStartup.addListener(refreshActiveTab);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'UPDATE_ICON') {
        applyIcon(shouldBeColored(msg));
        sendResponse({ ok: true });
    }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    refreshForTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab && tab.active) {
        refreshForTab(tabId);
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.bulkNoteEnabled || changes.bulkNoteDeleteMode) {
        refreshActiveTab();
    }
});

refreshActiveTab();