# Kibana Bulk Note Browser Extention

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

## ✨ Overview

During triage, analysts often need to tag, annotate, or close several related alerts with the exact same note. Kibana's native UI only lets you add a note to one alert at a time. For a batch of twenty alerts, that is twenty flyouts, twenty text boxes, twenty saves.

**Kibana Bulk Note** solves this by hooking into Kibana's internal APIs. Once you add a note to a single alert in a multi-selected view, the extension automatically replicates that note to every other selected alert in parallel. The same pattern applies to note deletion and alert assignment.

## 📸 Screenshot

<p align="center">
  <img src="Screenshot 2026-11-11 032442.png" alt="Kibana Bulk Note popup with activity logs" width="360" />
</p>

## 🚀 Features

- **Bulk Note Fan-out** — Select multiple alerts, open one, add a note. The extension intercepts the save request and mirrors the note to every other selected alert.
- **Duplicate Note Cleanup** — Delete a specific note from one alert. The extension finds the exact same text on all other selected alerts and deletes it from each.
- **Auto-assign to Me** — Optional. After a successful note fan-out, assign every alert in the batch to the current user. Existing assignees are preserved; the current user is added alongside them.
- **Copy Alerts JSON** — Fetch the full JSON payload of every currently selected alert and copy it to the clipboard in one click.
- **Live Progress HUD** — A small floating overlay at the top of the page shows real-time counts for every running operation: notes copied, notes deleted, alerts assigned. Colors match the popup icons (blue for copy, red for delete, purple for assign).
- **Activity Logs** — A collapsible log panel inside the popup shows every action the extension takes: API calls, probe results, per-alert outcomes, and errors. Logs show clock time in the popup view and export with full calendar dates when copied to the clipboard.
- **Cross-Browser** — Works on Chromium-based browsers (Chrome, Edge, Brave) and Gecko-based browsers (Firefox, LibreWolf).

## ⚙️ How It Works

The extension runs code in two isolated JavaScript worlds. This is deliberate: the page's own JavaScript cannot touch extension internals, and the extension cannot break the page.

1. **Isolated World (`content.js`)** — Owns extension state, storage, and communication with the popup. Cannot see the page's `window.fetch`.
2. **Main World (`page-script.js` and `hud.js`)** — Runs in the page's own JavaScript context. Can intercept `window.fetch`, read Kibana's network responses, and inject DOM. Cannot access `chrome.*` APIs.

The two worlds communicate only through `window.postMessage`, with explicit source tags (`BulkNote-MAIN` / `BulkNote-ISOLATED`) to prevent message loops.

### 🔍 The Fetch Interception Workflow

1. When you add a note, Kibana sends a `PATCH` request to its internal notes API.
2. The extension intercepts this request, extracts the source alert ID, and reads the note text.
3. To determine the IDs of all other selected alerts reliably across Kibana versions, the extension triggers Kibana's own bulk action menu. This forces Kibana to generate the exact list of targeted document IDs in the network payload, which the extension then intercepts and discards before the real request goes out.
4. Finally, it issues concurrent `PATCH` requests for every target alert, in parallel up to a safe concurrency limit.

### 📊 The Progress HUD

`hud.js` renders an overlay inside an open Shadow DOM, so Kibana's stylesheet cannot leak into it and vice versa. Every running operation gets its own row with an icon, label, count, percentage, and a pulsing animation. Rows transition to a green checkmark on success or a red cross on failure, then auto-dismiss after a few seconds.

The overlay pauses its own dismiss timer while you hover over it, and clicking any completed row dismisses it immediately. For delete operations, the success row also shows a clickable **refresh** link that reloads the page so Kibana re-fetches the updated alert data.

## 📋 Requirements

- **Chromium-based browsers:** version 105 or newer.
  - 105 is the first release that supports the `:has()` CSS selector used internally for menu suppression.
  - Tested on Chrome, Edge, and Brave.
- **Gecko-based browsers:** version 128 or newer.
  - 128 is the first release that supports `world: "MAIN"` in Manifest V3 content scripts, which is required for the fetch interception to work.
  - Tested on Firefox and LibreWolf.
- **Kibana:** 8.19.5 is the tested baseline. Newer 8.x releases are likely compatible; 9.x is untested.

The extension does not require any additional permissions beyond what the manifest declares, and it does not send any data outside the Kibana server you are already logged into.

## 📦 Installation

This extension is **not yet on any store** (Chrome Web Store, Edge Add-ons, or Mozilla Add-ons). Until that changes, you install it manually by pointing your browser at the folder you downloaded. Both Chromium and Firefox have a "load from folder" mode for exactly this purpose.

You only need to do this **once**. After that, the extension stays installed until you remove it.

### Step 1 — Download the code

You need the actual files on your computer, not just the GitHub page. Choose one of these:

- **If you use Git:** open a terminal and run `git clone https://github.com/mehrazino/kibana-extention.git`. This creates a folder called `kibana-extention` in your current directory.
- **If you don't use Git:** go to the repository page, click the green **Code** button, then **Download ZIP**. Extract the ZIP somewhere easy to find (for example, your Desktop). You should end up with a folder containing `manifest.json` and the other files at the top level, not nested inside another folder.

> **Quick check before continuing:** open the folder and confirm that `manifest.json` is directly inside it. If you see another folder with the same name inside, go one level deeper — the browser needs the folder that directly contains `manifest.json`.

### Step 2a — Load into Chrome, Edge, or Brave

1. In the address bar, type `chrome://extensions/` (or `edge://extensions/` for Edge) and press Enter.
2. In the top-right corner, turn on the **Developer mode** toggle. Three new buttons appear: **Load unpacked**, **Pack extension**, **Update**.
3. Click **Load unpacked**. A file picker opens.
4. Navigate to and select the **folder** you downloaded (the one containing `manifest.json`), then click **Select Folder** (or **Open** on macOS).
5. The extension now appears in the list with the Kibana logo. If you see a red error banner instead, hover over it to read the message, then check the folder structure from Step 1.
6. To keep it always visible, click the puzzle-piece icon in the toolbar and pin **Kibana Bulk Note**.

### Step 2b — Load into Firefox or LibreWolf

Firefox calls this "temporary loading", which is why the extension is removed when you restart Firefox. To reinstall after each restart, repeat steps 2-4 below.

1. In the address bar, type `about:debugging#/runtime/this-firefox` and press Enter.
2. Click the **This Firefox** tab on the left.
3. Click **Load Temporary Add-on...**. A file picker opens.
4. Navigate into the folder you downloaded and select the **`manifest.json` file** (not the folder — Firefox asks for the file directly this time).
5. The extension appears in the list with a version number and an **Inspect** button.

> **Why temporary?** Firefox requires every add-on to be signed by Mozilla before it can be installed permanently. Since this extension isn't published on Mozilla Add-ons yet, it can only be loaded as a temporary add-on for now.

### Step 3 — Confirm it loaded

Regardless of browser, you should see the Kibana icon (colored or gray, both are fine) appear in the toolbar or the extensions list. Click it, and the popup should slide open showing the toggles and the footer `Kibana Note Extension v1.0.4`.

If the popup opens but everything looks grayed out with switches you cannot click, that is **normal**. The extension only activates on Kibana pages — open a tab with `/app/security/alerts` in the URL, then reopen the popup and the controls will be enabled.

## 🛠️ Usage

All features are controlled from the extension popup. The popup is the small panel that opens when you click the Kibana icon in your toolbar.

### Before you start — a note on pages

Every feature only works while you are on the Kibana **Security → Alerts** page. If the popup shows grayed-out controls, you are on a different page. Navigate to Security → Alerts first, then reopen the popup.

Also, every feature works on **selected alerts**. Kibana shows a checkbox on the far left of each row in the alerts table. Tick the rows you want to act on before opening the popup.

**If Kibana was already open in a tab when you installed the extension, refresh that tab once** (press `F5` or `Ctrl+R`). The extension injects its scripts into the page at load time, so a tab that was opened before installation will not have them until it is reloaded. You only need to do this once per tab, after installation. Any tab you open *after* installation will load the extension automatically.

### 1. Bulk Note — apply one note to many alerts

Use this when you want to write a note once and have it appear on every selected alert.

1. Open Kibana and go to **Security** → **Alerts**.
2. Tick the checkbox on each alert you want to include. The count of selected alerts appears in a small toolbar above the table (for example, "Selected 5 alerts").
3. Click the extension icon in your toolbar. The popup opens.
4. Make sure the **Bulk Note** toggle (topmost switch) is turned **on**.
5. Close the popup by clicking anywhere outside it.
6. Open the flyout for **any one** of the selected alerts by clicking on its expand icon (the small arrow icon on the left side of the row). The flyout slides in from the right.
7. Scroll to the notes section, type your note, and click **Save** as you normally would.
8. As soon as you save, a small overlay appears at the top-center of the screen. It starts at `0/N` and climbs to `N/N` as the note is copied to every other selected alert. When it turns green with a checkmark, it's done.
9. For the exact per-alert breakdown, reopen the popup and switch on **Show Activity Logs**. Each line tells you which alert succeeded or failed.

### 2. Delete Duplicate Notes — remove the same note from many alerts

Use this when you accidentally applied a wrong note to a batch and want to remove it everywhere at once.

1. Toggle **Delete Duplicate Notes** on in the popup (the second switch).
2. With multiple alerts still selected, open the flyout of **one** of the alerts that has the note you want to remove.
3. In the notes section of that flyout, click the trash icon next to the note.
4. The extension reads the note text, finds the exact same text on every other selected alert, and deletes each one.
5. A red progress overlay appears at the top of the screen, showing how many were deleted.
6. When it finishes, a green row appears with a **refresh** link. Click it to reload the page so Kibana re-fetches the updated alerts. Without a refresh, the deleted notes may still appear in the flyouts until Kibana's next data refresh.

> Note: the delete only removes notes that are **character-for-character identical** to the note you deleted from the source alert. Small differences in whitespace are normalized, but a genuinely different note is left alone.

### 3. Auto-assign to Me — assign the whole batch to yourself

Use this when you want to claim ownership of every alert you just noted, so they show up under your name in the assignees column.

Auto-assign lives in a panel that is hidden until Bulk Note is on.

1. Toggle **Bulk Note** on. A panel slides open below it.
2. Inside that panel, toggle **Auto-assign to me** on.
3. Perform a Bulk Note exactly as described in section 1 above.
4. After the note has been copied to every target, the extension automatically sends an assignee request for all of them **plus** the source alert. A purple progress row appears below the blue one, showing how many alerts were assigned.
5. Both overlays turn green when they finish.

Things to know:

- **Existing assignees are preserved.** If an alert was already assigned to someone else, the current user is added alongside them, not replacing them.
- **The user ID is cached for five minutes.** This avoids hitting Kibana's identity endpoint on every operation. If you log out and log back in as a different user, wait five minutes (or restart the browser) before using auto-assign again.

### 4. Copy Alerts JSON — export the selected alerts

Use this when you want to paste the raw alert data into another tool, a ticket, or a chat.

1. Tick the alerts you want to export.
2. Open the popup and click **Copy** next to *Copy Alerts JSON*.
3. The button briefly says **Copied** to confirm.
4. Paste anywhere with `Ctrl+V` (or `Cmd+V` on macOS). The clipboard now contains the full JSON for every selected alert, indented for readability.

If you see **None** on the button, you had no alerts selected. If you see **Fail**, something went wrong — check the Activity Logs for details.

### 5. Reading Activity Logs

Every action the extension takes is recorded in the log panel. This is the first place to look when something seems off.

1. Toggle **Show Activity Logs** on (the bottommost switch). A panel slides open showing the most recent entries.
2. Each line has a timestamp in brackets, an icon indicating the category (gear for init, arrow for main script, magic wand for API calls, pencil for copy, trash for delete, person for assign), and a short message.
3. Green lines mean success, yellow means warning, red means error.
4. Click **Copy** to copy the entire log to your clipboard — useful when reporting a bug. The exported version includes the full calendar date on each line, not just the clock time.
5. Click **Clear** to empty the log and start fresh.

## 📂 Project Structure

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

## 🔧 Configuration

The extension targets Kibana 8.19.5 by default. It attempts to auto-detect the Kibana version from the page's DOM on load. If detection fails, it falls back to `8.19.5`. You can also override the version manually:

1. Open DevTools on any Kibana page.
2. Run: `chrome.storage.local.set({ bulkNoteKbnVersion: '8.20.0' })`.
3. Reload the Kibana tab.

The overridden version is used in the `kbn-version` header of every request the extension sends to Kibana's internal APIs.

## 🗺️ Roadmap

- Currently verified on 8.19.5. Testing on older 8.x and newer 9.x releases is pending.
- Publish on Chrome Web Store and Mozilla Add-ons for easier installation.

## 🤝 Contributing

Contributions and bug reports are welcome. If you have a feature idea, open an issue first so we can discuss the approach before a large PR.

- [Open an issue](https://github.com/mehrazino/kibana-extention/issues)
- [Submit a pull request](https://github.com/mehrazino/kibana-extention/pulls)

When reporting a bug, please include:

- Kibana version (visible in the Activity Logs on load, e.g. `[init] State: ENABLED (v8.19.5)`).
- Browser and version.
- The relevant lines from **Activity Logs** inside the popup (copy them with the **Copy** button in the log panel).

## 💬 A Note From a Colleague

One thing worth keeping in mind before you rely on this daily: the extension trusts your selection completely. If a batch of seemingly identical alerts actually contains one that only *looks* the same — a rule that re-fired, a different host behind the same rule name — the note lands on it too. Skim the selection once more before saving, and keep Delete Duplicate Notes nearby for the cases where it slips through.

And if you notice the same alert firing again and again in a short window, that's usually a sign the rule itself needs tuning, not something to clean up after the fact. Rule suppression or noise reduction in Kibana handles that pattern at the source — filter it out where it's generated, and there's much less to fan out or clean up later.

That's all. Happy triaging.

## 📄 License

This project is licensed under the **GPL-3.0 License**. See the [LICENSE](https://github.com/mehrazino/kibana-extention/blob/master/LICENSE) file for the full text.
