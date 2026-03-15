# Dead Link Scanner — Design Spec
**Date:** 2026-03-15
**Project:** Bookmark Cleaner Chrome Extension

---

## Overview

Add a Dead Link Scanner to the Bookmark Cleaner extension. When triggered, it scans every http/https bookmark in the user's entire collection, identifies broken links (4xx, 5xx, timeout, network error), and presents only the broken ones in a dedicated panel for review and cleanup.

---

## Goals

- Surface dead bookmarks across the entire collection in one pass
- Show only broken links — no noise from working ones
- Let users delete, edit, or open each broken link individually, plus bulk-delete selected
- Provide live progress feedback during the scan
- Integrate cleanly into the existing extension UI without breaking current workflows

---

## Non-Goals

- Persisting scan results across extension sessions
- Scheduling or automatic background scans
- Checking non-http/https URLs (chrome://, file://, etc.)
- Detecting redirects as "broken" (3xx responses are treated as working)

---

## Architecture

Four files change; no new files are created.

### `manifest.json`
Add `host_permissions: ["<all_urls>"]` to allow the service worker to make cross-origin HEAD/GET requests. No additional permissions beyond what already exists (`"bookmarks"`, `"tabs"`) are needed. The tab ID handshake (described below) uses the existing `"tabs"` permission.

### `background.js`

New message handler for three message types:

- **`START_SCAN`** — begins the scan; payload includes `{tabId}` so the SW knows which tab to send progress to
- **`CANCEL_SCAN`** — sets a cancellation flag and aborts all in-flight requests

**Tab ID handshake:** The page obtains its own tab ID by calling `chrome.tabs.getCurrent()` on init and includes it in every `START_SCAN` message. The SW stores this `tabId` and uses `chrome.tabs.sendMessage(tabId, payload)` for all progress and completion messages back to the page.

**Scan algorithm:**

1. Call `chrome.bookmarks.getTree()` to get the full tree
2. Walk the tree recursively, collecting all nodes where `node.url` starts with `http://` or `https://`, building a `{id, title, url, folderPath}` object for each. `folderPath` is the slash-joined chain of ancestor folder titles (e.g. `"Design / CSS"`).
3. Process in batches of 5 concurrent requests:
   - Each request uses its own `AbortController` with an 8-second timeout via `setTimeout`
   - The `setTimeout` handle is always cleared in a `finally` block to prevent unhandled `AbortError` after batch settlement
   - On cancel (`CANCEL_SCAN`), call `abort()` on all currently active `AbortController` instances immediately; the next batch will not start
4. For each URL:
   - Send a HEAD request
   - If the server responds 405 (Method Not Allowed), retry with GET using a fresh `AbortController` and a new 8-second timeout
   - Classify the result:
     - `2xx` or `3xx` → skip (working, not reported)
     - `4xx` or `5xx` → `statusType: "http-error"`, `statusLabel: "<code>"` (e.g. `"404"`, `"503"`)
     - Network failure (fetch throws, not timeout) → `statusType: "network-error"`, `statusLabel: "Error"`
     - Timeout (AbortController fires) → `statusType: "timeout"`, `statusLabel: "Timeout"`
5. After each batch completes, send `SCAN_PROGRESS {checked, total, brokenCount}` via `chrome.tabs.sendMessage(tabId, ...)`
6. On completion or cancellation, send `SCAN_COMPLETE {broken: BrokenEntry[], cancelled: boolean}` via `chrome.tabs.sendMessage(tabId, ...)`

```ts
// BrokenEntry shape
{
  id: string;          // chrome bookmark ID
  title: string;
  url: string;
  folderPath: string;  // e.g. "Design / CSS"
  statusLabel: string; // e.g. "404", "503", "Timeout", "Error"
  statusType: "http-error" | "timeout" | "network-error";
}
```

### `app.js`

New `ScanView` module appended inline to `app.js`, sharing the same script scope and therefore having direct access to `Modal`, `toast`, `chrome`, and other existing helpers.

**Initialization:** On `DOMContentLoaded`, `ScanView.init()` is called. It:
- Calls `chrome.tabs.getCurrent(tab => { if (!tab) { /* disable scan, show error */ return; } scanTabId = tab.id; })` — the null guard is required; if `tab` is falsy the scan button must be disabled and a visible error shown (this extension's pages are always opened via `chrome.tabs.create` so the tab object will be present in normal use, but the guard prevents a silent failure mode where every `chrome.tabs.sendMessage(undefined, ...)` call in the SW fails silently)
- Injects a "Dead Links" tab button into `#main-header` dynamically (inserted before the `.header-actions` div)
- Appends `#scan-panel` to `#main` as a sibling of `#bookmark-list` and `#empty-state`
- Registers `chrome.runtime.onMessage.addListener` for `SCAN_PROGRESS` and `SCAN_COMPLETE`. The SW message handler does NOT return `true` for `START_SCAN`/`CANCEL_SCAN` — no async response from SW to page is needed

**Tab toggle:** Clicking the "Dead Links" button hides the normal bookmark content area (`#bookmark-list`, `#empty-state`, `#action-bar`) and shows the scan panel `#scan-panel`. Clicking back to the normal view hides `#scan-panel`, shows `#bookmark-list` and `#empty-state`, then calls `updateActionBar()` (not unconditional show) to restore `#action-bar` correctly based on current `checkedIds.size`. The sidebar is always visible and unaffected.

**Three panel states (managed via CSS class on `#scan-panel`):**

1. **Idle** — centered "Scan All Bookmarks" amber button with subtitle "Scans all {N} bookmarks in your collection" (N from `countUrls(fullTree)` — this counts all nodes with a `.url` property, including non-http URLs; it is an acceptable approximation for the subtitle and does not need to be exact)
2. **Scanning** — animated progress bar (amber), `{checked} of {total} checked`, `{brokenCount} broken so far`, Cancel ghost button. A watchdog timer is **reset** on every incoming `SCAN_PROGRESS` message (not set once at scan start — resetting is required to avoid false triggers on large collections): if the timer fires (15 seconds with no `SCAN_PROGRESS`) while still in scanning state, transition to error state and show toast: `"Scan interrupted — please try again"` (handles MV3 service worker eviction)
3. **Results** — full broken links list (see below)

**Results list:** Sorted by `folderPath` then `title`. Each row:
- Checkbox (same pattern as `.bm-row`)
- Title, URL (truncated), folder path below URL
- Status badge: CSS class `badge-http-error` / `badge-timeout` / `badge-network-error` keyed off `statusType`
- Action buttons: ↗ Open, Edit, Delete

**Open:** `chrome.tabs.create({ url: bm.url })` — same as existing pattern.

**Edit:** Opens `Modal.editBookmark(bm.title, bm.url)`. On save, calls `chrome.bookmarks.update(bm.id, {title, url})`. Then updates the row in-place: set the title element's `textContent` and the URL element's `textContent` to the new values, and update the row's local `bm` reference. Must NOT call `reload()` — doing so would destroy the scan results panel.

**Delete:** `chrome.bookmarks.remove(bm.id)` → animate row out (same `animateRemoveRow` helper) → remove from DOM after animation → decrement broken count in results header → update `#stat-total` as described below.

**Deletions from scan view must NOT call `reload()`** — doing so would wipe the scan results panel and corrupt `currentBookmarks`. Instead, after any delete from the scan panel:
- Remove the row from the DOM
- Decrement the local broken count displayed in the results header
- Update the sidebar bookmark total by calling `chrome.bookmarks.getTree()` and passing the result through `countUrls()`, then updating `#stat-total` directly — without touching `currentBookmarks`, `renderSidebar()`, or `renderBookmarks()`

**Bulk actions:**
- Checkboxes per row with "Select All (N)" link
- "Delete Selected" → `Modal.confirm(...)` → batch `chrome.bookmarks.remove` for each → remove rows from DOM, update counts as above

### `index.html`
No changes. The "Dead Links" tab button and `#scan-panel` are injected dynamically by `ScanView.init()`.

### `style.css`
New CSS classes for the scan panel:

- `#scan-panel` — flex column, fills the `#main` content area; hidden by default
- `.scan-idle`, `.scan-scanning`, `.scan-results` — the three state containers (only one visible at a time)
- `.progress-bar-bg` / `.progress-bar-fill` — amber (`var(--amber)`) progress bar, matches existing accent
- `.result-row` — mirrors `.bm-row` in structure and hover behavior
- `.status-badge` — base pill badge style
- `.badge-http-error` — red (`var(--red)` / `var(--red-dim)`)
- `.badge-timeout` — orange (`#f76b15` / `rgba(247,107,21,0.12)`)
- `.badge-network-error` — blue (`#3b82f6` / `rgba(59,130,246,0.12)`)
- `.scan-bulk-bar` — pinned bottom bar matching `#action-bar` pattern
- `.tab-btn` — the Dead Links tab button; `.tab-btn.active-tab` variant uses red accent to signal "issues found" mode

---

## Message Protocol

| Direction | API | Message type | Payload |
|---|---|---|---|
| Page → SW | `chrome.runtime.sendMessage` | `START_SCAN` | `{tabId: number}` |
| Page → SW | `chrome.runtime.sendMessage` | `CANCEL_SCAN` | `{}` |
| SW → Page | `chrome.tabs.sendMessage(tabId, ...)` | `SCAN_PROGRESS` | `{checked, total, brokenCount}` |
| SW → Page | `chrome.tabs.sendMessage(tabId, ...)` | `SCAN_COMPLETE` | `{broken: BrokenEntry[], cancelled: boolean}` |

The page listens with `chrome.runtime.onMessage.addListener`. The service worker sends to the specific tab using `chrome.tabs.sendMessage` with the `tabId` received in `START_SCAN`.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| User closes extension page mid-scan | Scan runs to completion in SW (all AbortControllers fire naturally); final `sendMessage` fails silently since the tab is gone |
| User clicks Cancel | Page sends `CANCEL_SCAN`; SW calls `abort()` on all in-flight AbortControllers immediately; does not start next batch; fires `SCAN_COMPLETE` with `cancelled: true` |
| Extension page reopened after scan | Shows idle state; no cached results; user must re-scan |
| All bookmarks are working | Results state shows "No broken links found — your bookmarks are clean." with green accent |
| Network fully offline | All URLs classified as `network-error`; user sees full list of "Error" rows |
| SW evicted mid-scan (MV3 lifecycle) | Page watchdog fires after 15s of no `SCAN_PROGRESS`; panel transitions to error state; toast: "Scan interrupted — please try again" |
| `chrome.tabs.sendMessage` fails (tab closed between batches) | Error swallowed; scan continues and completes in background; no user impact |

---

## Permissions Change

`manifest.json` requires one new entry:

```json
"host_permissions": ["<all_urls>"]
```

No new `"permissions"` entries are needed. The `"tabs"` permission already present covers `chrome.tabs.sendMessage` and `chrome.tabs.getCurrent`.

Chrome will not show an additional install-time permission prompt for `host_permissions` in MV3 (it appears in the extension details page, not as a warning popup).

---

## Implementation Order

1. Add `host_permissions` to `manifest.json`
2. Add scan logic to `background.js` (message handler, tab ID storage, batch fetcher with AbortController cleanup, progress/complete reporting via `chrome.tabs.sendMessage`)
3. Add `ScanView` module to `app.js` (tab ID acquisition, tab button injection, three panel states, watchdog timer, message listener, per-row actions, bulk actions, stat updates without `reload()`)
4. Add CSS to `style.css`
5. Manual test: add known-dead URLs to bookmarks; verify progress updates, results render, delete, edit, bulk delete, cancel mid-scan, SW eviction toast
