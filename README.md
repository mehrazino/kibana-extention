# Kibana Bulk Note

<div align="center">
  <img src="elastic-kibana-color.png" width="100" alt="Kibana Bulk Note Logo" />
</div>

<p align="center">
    <a href="https://github.com/mehrazino/kibana-extention/blob/master/LICENSE" alt="License">
        <img src="https://shieldcn.dev/badge/License-GPL--3.0-7c3aed.svg?variant=branded&logo=gnu&logoColor=white" /></a>
    <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript" alt="JavaScript">
        <img src="https://shieldcn.dev/badge/JavaScript-FF8C00.svg?logo=javascript&logoColor=white&variant=branded" /></a>
    <a href="https://developer.mozilla.org/en-US/docs/Web/HTML" alt="HTML5">
        <img src="https://shieldcn.dev/badge/HTML5-E34F26.svg?logo=html5&logoColor=white&variant=branded" /></a>
    <a href="https://developer.mozilla.org/en-US/docs/Web/CSS" alt="CSS3">
        <img src="https://shieldcn.dev/badge/CSS3-1572B6.svg?logo=ri:FaCss3Alt&logoColor=white&variant=branded" /></a>
    <a href="https://www.google.com/chrome/" alt="Chromium Supported">
        <img src="https://shieldcn.dev/badge/Chromium-Supported-34A853.svg?variant=branded&logo=googlechrome&logoColor=white" /></a>
    <a href="https://www.mozilla.org/firefox/" alt="Firefox Supported">
        <img src="https://shieldcn.dev/badge/Firefox-Supported-ea580c.svg?variant=branded&logo=firefox&logoColor=white" /></a>
</p>

---

A lightweight, cross-browser extension built for security analysts working with Kibana. It removes the repetitive work of applying the same note to dozens of alerts by intercepting Kibana's own network requests and fanning the action out to every selected alert. It also handles duplicate note cleanup, alert export, and optional self-assignment, all from a small popup.

> **Disclaimer:** This extension is not affiliated with, endorsed by, or supported by Elastic. It relies on Kibana's internal APIs and DOM structure, which are undocumented and may change between releases.

## Overview

During triage, analysts often need to tag, annotate, or close several related alerts with the exact same note. Kibana's native UI only lets you add a note to one alert at a time. For a batch of twenty alerts, that is twenty flyouts, twenty text boxes, twenty saves.

**Kibana Bulk Note** solves this by hooking into Kibana's internal APIs. Once you add a note to a single alert in a multi-selected view, the extension automatically replicates that note to every other selected alert in parallel. The same pattern applies to note deletion and alert assignment.

## Screenshot

<p align="center">
  <img src="Screenshot 2026-11-11 032442.png" alt="Kibana Bulk Note popup with activity logs" width="360" />
</p>

## Features

- **Bulk Note Fan-out** — Select multiple alerts, open one, add a note. The extension intercepts the save request and mirrors the note to every other selected alert.
- **Duplicate Note Cleanup** — Delete a specific note from one alert. The extension finds the exact same text on all other selected alerts and deletes it from each.
- **Auto-assign to Me** — Optional. After a successful note fan-out, assign every alert in the batch to the current user. Existing assignees are preserved; the current user is added alongside them.
- **Copy Alerts JSON** — Fetch the full JSON payload of every currently selected alert and copy it to the clipboard in one click.
- **Live Progress HUD** — A small floating overlay at the top of the page shows real-time counts for every running operation: notes copied, notes deleted, alerts assigned. Colors match the popup icons (blue for copy, red for delete, purple for assign).
- **Activity Logs** — A collapsible log panel inside the popup shows every action the extension takes: API calls, probe results, per-alert outcomes, and errors. Logs show clock time in the popup view and export with full calendar dates when copied to the clipboard.
- **Cross-Browser** — Works on Chromium-based browsers (Chrome, Edge, Brave) and Gecko-based browsers (Firefox, LibreWolf).

## How It Works

The extension runs code in two isolated JavaScript worlds. This is deliberate: the page's own JavaScript cannot touch extension internals, and the extension cannot break the page.

1. **Isolated World (`content.js`)** — Owns extension state, storage, and communication with the popup. Cannot see the page's `window.fetch`.
2. **Main World (`page-script.js` and `hud.js`)** — Runs in the page's own JavaScript context. Can intercept `window.fetch`, read Kibana's network responses, and inject DOM. Cannot access `chrome.*` APIs.

The two worlds communicate only through `window.postMessage`, with explicit source tags (`BulkNote-MAIN` / `BulkNote-ISOLATED`) to prevent message loops.

### The Fetch Interception Workflow

1. When you add a note, Kibana sends a `PATCH` request to its internal notes API.
2. The extension intercepts this request, extracts the source alert ID, and reads the note text.
3. To determine the IDs of all other selected alerts reliably across Kibana versions, the extension triggers Kibana's own bulk action menu. This forces Kibana to generate the exact list of targeted document IDs in the network payload, which the extension then intercepts and discards before the real request goes out.
4. Finally, it issues concurrent `PATCH` requests for every target alert, in parallel up to a safe concurrency limit.

### The Progress HUD

`hud.js` renders an overlay inside an open Shadow DOM, so Kibana's stylesheet cannot leak into it and vice versa. Every running operation gets its own row with an icon, label, count, percentage, and a pulsing animation. Rows transition to a green checkmark on success or a red cross on failure, then auto-dismiss after a few seconds.

The overlay pauses its own dismiss timer while you hover over it, and clicking any completed row dismisses it immediately. For delete operations, the success row also shows a clickable **refresh** link that reloads the page so Kibana re-fetches the updated alert data.

## Requirements

- **Chromium-based browsers:** version 105 or newer.
  - 105 is the first release that supports the `:has()` CSS selector used internally for menu suppression.
  - Tested on Chrome, Edge, and Brave.
- **Gecko-based browsers:** version 128 or newer.
  - 128 is the first release that supports `world: "MAIN"` in Manifest V3 content scripts, which is required for the fetch interception to work.
  - Tested on Firefox and LibreWolf.
- **Kibana:** 8.19.5 is the tested baseline. Newer 8.x releases are likely compatible; 9.x is untested.

The extension does not require any additional permissions beyond what the manifest declares, and it does not send any data outside the Kibana server you are already logged into.

## Installation

This extension is self-hosted and must be loaded manually.

### Chromium-based browsers (Chrome, Edge, Brave)

1. Download or clone this repository.
2. Open `chrome://extensions/` in your browser.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.

### Gecko-based browsers (Firefox, LibreWolf, Tor)

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select `manifest.json` from the project folder.

> Temporary add-ons are removed when Firefox closes. Permanent installation requires signing through Mozilla Add-ons.

## Usage

### Bulk Note

1. Open Kibana → **Security** → **Alerts**.
2. Open the extension popup and toggle **Bulk Note** on.
3. Select multiple alerts using the checkboxes on the left of the DataGrid.
4. Open the flyout for **one** of the selected alerts.
5. Add your note and save it.
6. Watch the HUD at the top of the page as the note propagates. Full details appear in **Activity Logs** inside the popup.

### Delete Duplicate Notes

1. Toggle **Delete Duplicate Notes** on in the popup.
2. With multiple alerts selected, open the flyout of the alert containing the note you want to remove.
3. Click the delete icon next to the note.
4. The extension finds and deletes the same note on every other selected alert.
5. Click the **refresh** link in the HUD to reload the page and see the change.

### Auto-assign to Me

Auto-assign is nested under the Bulk Note card in the popup.

1. Toggle **Bulk Note** on, then toggle **Auto-assign to me** in the panel that appears below it.
2. Perform a Bulk Note as usual.
3. After the note has been copied to every target, the extension assigns all of them, plus the source alert, to the current user.
4. Existing assignees are preserved — the current user is added, not replaced.

The user ID is cached for five minutes to avoid hitting Kibana's `/internal/security/me` endpoint on every operation. If the cache is stale or missing, it is refreshed automatically.

### Copy Alerts JSON

1. Select the alerts you want to export.
2. Open the popup and click **Copy** next to *Copy Alerts JSON*.
3. The JSON payload of all selected alerts is now in your clipboard.

## Project Structure

```text
kibana-bulk-note-extension/
│
├── intel-one-mono-woff2/              # Intel One Mono webfont files
│   ├── IntelOneMono-Regular.woff2
│   ├── IntelOneMono-Medium.woff2
│   ├── IntelOneMono-Bold.woff2
│   └── ... (Light, Italic, BoldItalic variants)
│
├── background.js                      # Service worker — updates toolbar icon state
│
├── content.js                         # Isolated world — state, storage, popup bridge
├── page-script.js                     # Main world — fetch interception, API logic
├── hud.js                             # Main world — Shadow DOM progress overlay
│
├── popup.html                         # Popup markup
├── popup.css                          # Popup styles
├── popup.js                           # Popup logic, log rendering, toggle wiring
│
├── manifest.json                      # MV3 manifest
│
├── elastic-kibana-color.png           # Active extension icon
├── elastic-kibana-gray.png            # Inactive extension icon
│
├── README.md                          # This file
├── LICENSE                            # GPL-3.0 license text
└── Screenshot 2026-11-11 032442.png   # Popup preview
```

## Configuration

The extension targets Kibana 8.19.5 by default. It attempts to auto-detect the Kibana version from the page's DOM on load. If detection fails, it falls back to `8.19.5`. You can also override the version manually:

1. Open DevTools on any Kibana page.
2. Run: `chrome.storage.local.set({ bulkNoteKbnVersion: '8.20.0' })`.
3. Reload the Kibana tab.

The overridden version is used in the `kbn-version` header of every request the extension sends to Kibana's internal APIs.

## Roadmap

- Currently verified on 8.19.5. Testing on older 8.x and newer 9.x releases is pending.
- Publish on Chrome Web Store and Mozilla Add-ons for easier installation.

## Contributing

Contributions and bug reports are welcome. If you have a feature idea, open an issue first so we can discuss the approach before a large PR.

- [Open an issue](https://github.com/mehrazino/kibana-extention/issues)
- [Submit a pull request](https://github.com/mehrazino/kibana-extention/pulls)

When reporting a bug, please include:

- Kibana version (visible in the Activity Logs on load, e.g. `[init] State: ENABLED (v8.19.5)`).
- Browser and version.
- The relevant lines from **Activity Logs** inside the popup (copy them with the **Copy** button in the log panel).

## License

This project is licensed under the **GPL-3.0 License**. See the [LICENSE](https://github.com/mehrazino/kibana-extention/blob/master/LICENSE) file for the full text.
