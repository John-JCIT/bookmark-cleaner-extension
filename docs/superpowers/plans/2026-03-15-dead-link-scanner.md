# Dead Link Scanner Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Dead Link Scanner panel to the Bookmark Cleaner Chrome extension that finds broken bookmarks (4xx, 5xx, timeout, network error) across the entire collection and lets users delete, edit, or open each result.

**Architecture:** The MV3 service worker handles all network I/O — collecting bookmark URLs, running HEAD/GET probes in batches of 5 with AbortController timeouts, and reporting progress back to the extension page via `chrome.tabs.sendMessage`. The extension page hosts a `ScanView` IIFE module (appended inline to `app.js`) that renders three states (idle / scanning / results) and handles all UI interactions without ever calling `reload()`.

**Tech Stack:** Vanilla JS (ES2020), Chrome Extension MV3, `chrome.bookmarks` API, `chrome.tabs` API, Fetch API + AbortController. No build tools, no dependencies.

**Spec:** `docs/superpowers/specs/2026-03-15-dead-link-scanner-design.md`

---

## File Map

| File | Change | Responsibility |
|---|---|---|
| `manifest.json` | Modify | Add `host_permissions: ["<all_urls>"]` |
| `background.js` | Modify | URL collection, batch probing, progress messaging |
| `style.css` | Modify | All scan panel CSS |
| `app.js` | Modify | `ScanView` IIFE module — tab button, three states, results, bulk actions |

---

## Chunk 1: Scan Engine (manifest + background.js)

### Task 1: Add host_permissions to manifest.json

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Add the permission**

Open `manifest.json`. The current content is:
```json
{
  "manifest_version": 3,
  "name": "Bookmark Cleaner",
  "version": "1.0",
  "description": "Clean up your Chrome bookmarks with a proper UI",
  "permissions": ["bookmarks", "tabs"],
  "action": {
    "default_title": "Bookmark Cleaner"
  },
  "background": {
    "service_worker": "background.js"
  },
  "web_accessible_resources": [{
    "resources": ["index.html", "style.css", "app.js"],
    "matches": ["<all_urls>"]
  }]
}
```

Replace with:
```json
{
  "manifest_version": 3,
  "name": "Bookmark Cleaner",
  "version": "1.0",
  "description": "Clean up your Chrome bookmarks with a proper UI",
  "permissions": ["bookmarks", "tabs"],
  "host_permissions": ["<all_urls>"],
  "action": {
    "default_title": "Bookmark Cleaner"
  },
  "background": {
    "service_worker": "background.js"
  },
  "web_accessible_resources": [{
    "resources": ["index.html", "style.css", "app.js"],
    "matches": ["<all_urls>"]
  }]
}
```

- [ ] **Step 2: Verify**

Load the extension in Chrome (`chrome://extensions` → Load unpacked). Confirm it loads without errors. The extension details page should now list host access for all URLs.

- [ ] **Step 3: Commit**

```bash
cd /Users/johnchisari/bookmark_cleaner_extension
git add manifest.json
git commit -m "feat: add host_permissions for dead link scanner"
```

---

### Task 2: Add scan engine to background.js

**Files:**
- Modify: `background.js`

The current `background.js` has one listener. Replace the entire file with the expanded version below.

- [ ] **Step 1: Write background.js**

Replace the entire contents of `background.js` with:

```js
'use strict';

// ── Open extension on icon click ────────────────────────────────────────────
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

// ── Dead Link Scanner ────────────────────────────────────────────────────────

// Collect all http/https bookmark URLs from the bookmark tree.
// Returns [{id, title, url, folderPath}] where folderPath is e.g. "Design / CSS".
function collectUrls(node, pathParts = []) {
  const entries = [];
  const folderPath = node.title ? [...pathParts, node.title] : pathParts;
  for (const child of (node.children || [])) {
    if (child.url && /^https?:\/\//i.test(child.url)) {
      entries.push({
        id: child.id,
        title: child.title || '(no title)',
        url: child.url,
        folderPath: folderPath.join(' / ')
      });
    }
    if (child.children) {
      entries.push(...collectUrls(child, folderPath));
    }
  }
  return entries;
}

// Probe a single URL. Returns a BrokenEntry object if broken, null if ok.
// scan.controllers is a Set used to track active AbortControllers for cancellation.
async function probeUrl(entry, scan) {
  const attempt = async (method) => {
    const ctrl = new AbortController();
    scan.controllers.add(ctrl);
    const tid = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(entry.url, {
        method,
        signal: ctrl.signal,
        redirect: 'follow'
      });
      // Treat anything below 400 as working (redirects are followed transparently)
      if (res.status < 400) return null;
      return { ...entry, statusType: 'http-error', statusLabel: String(res.status) };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { ...entry, statusType: 'timeout', statusLabel: 'Timeout' };
      }
      return { ...entry, statusType: 'network-error', statusLabel: 'Error' };
    } finally {
      clearTimeout(tid);
      scan.controllers.delete(ctrl);
    }
  };

  const result = await attempt('HEAD');
  // If HEAD is rejected (405), retry with GET using a fresh controller
  if (result?.statusType === 'http-error' && result.statusLabel === '405') {
    return attempt('GET');
  }
  return result;
}

// Active scan state — null when no scan is running.
let activeScan = null;

// Run the full scan: collect URLs, probe in batches of 5, report progress.
async function runScan(entries, tabId) {
  const CONCURRENCY = 5;
  const broken = [];
  const total = entries.length;

  // Cancel any in-flight scan before starting a new one
  if (activeScan) {
    activeScan.cancelled = true;
    activeScan.controllers.forEach(c => c.abort());
  }

  // Capture the scan object locally so concurrent scans can't cross-contaminate
  const scan = { cancelled: false, controllers: new Set() };
  activeScan = scan;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    if (scan.cancelled) break;

    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(e => probeUrl(e, scan)));
    for (const r of results) { if (r) broken.push(r); }

    const checked = Math.min(i + CONCURRENCY, total);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCAN_PROGRESS',
        checked,
        total,
        brokenCount: broken.length
      });
    } catch (_) {
      // Tab was closed — continue scanning but stop messaging
    }
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCAN_COMPLETE',
      broken,
      total,
      cancelled: scan.cancelled
    });
  } catch (_) {}

  // Only clear activeScan if this scan is still the active one
  if (activeScan === scan) activeScan = null;
}

// Message handler: START_SCAN and CANCEL_SCAN
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_SCAN') {
    chrome.bookmarks.getTree(([root]) => {
      const entries = collectUrls(root);
      runScan(entries, msg.tabId);
    });
  }
  if (msg.type === 'CANCEL_SCAN' && activeScan) {
    // Use activeScan directly here (module-level) — this correctly targets the current scan
    activeScan.cancelled = true;
    activeScan.controllers.forEach(c => c.abort());
  }
  // No return true — no async response from SW to page needed
});
```

- [ ] **Step 2: Reload the extension and verify no errors**

Go to `chrome://extensions`, click the reload icon on Bookmark Cleaner. Confirm no service worker errors appear. Click "Service Worker" link → confirm no console errors on startup.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "feat: add dead link scan engine to service worker"
```

---

## Chunk 2: UI (style.css + ScanView in app.js)

### Task 3: Add scan panel CSS to style.css

**Files:**
- Modify: `style.css`

- [ ] **Step 1: Append CSS to style.css**

Append the following block to the very end of `style.css`:

```css
/* ── Dead Links tab button ───────────────────────────────────────────────── */
.tab-btn {
  font-family: var(--mono); font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.08em; padding: 5px 12px; border-radius: 4px;
  cursor: pointer; border: 1px solid var(--border); background: transparent;
  color: var(--text-muted); transition: all 0.15s; white-space: nowrap;
}
.tab-btn:hover { color: var(--text-dim); border-color: var(--border-light); }
.tab-btn.active-tab {
  color: var(--red); background: var(--red-dim);
  border-color: rgba(229,72,77,0.3);
}

/* ── Scan panel shell ────────────────────────────────────────────────────── */
#scan-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* ── Idle + scanning states (centered content) ───────────────────────────── */
.scan-idle,
.scan-scanning {
  flex: 1; display: flex; align-items: center; justify-content: center;
}

.scan-center {
  display: flex; flex-direction: column; align-items: center;
  gap: 16px; padding: 40px; text-align: center;
}

.scan-title { font-size: 15px; font-weight: 600; color: var(--text); }
.scan-sub   { font-family: var(--mono); font-size: 11px; color: var(--text-muted); }

/* ── Progress bar ────────────────────────────────────────────────────────── */
.progress-wrap { width: 320px; }

.progress-bar-bg {
  height: 3px; background: var(--surface-3); border-radius: 2px;
  overflow: hidden; margin-bottom: 8px;
}
.progress-bar-fill {
  height: 100%; background: var(--amber); border-radius: 2px;
  width: 0%; transition: width 0.3s ease;
}

.progress-label {
  display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 10px; color: var(--text-muted);
}

/* ── Results state ───────────────────────────────────────────────────────── */
.scan-results { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

.results-header {
  padding: 10px 20px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  background: var(--surface-2);
}
.results-summary {
  font-family: var(--mono); font-size: 10px; color: var(--text-muted); flex: 1;
}
.results-summary .count { color: var(--red); font-weight: 600; }

.rescan-btn {
  font-family: var(--mono); font-size: 10px; color: var(--text-dim);
  background: transparent; border: 1px solid var(--border); border-radius: 4px;
  padding: 4px 10px; cursor: pointer; transition: all 0.12s;
}
.rescan-btn:hover { color: var(--text); border-color: var(--border-light); }

.results-list { flex: 1; overflow-y: auto; }
.results-list::-webkit-scrollbar { width: 4px; }
.results-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

/* ── Result rows ─────────────────────────────────────────────────────────── */
.result-row {
  display: flex; align-items: center; gap: 12px; padding: 8px 20px;
  border-bottom: 1px solid rgba(42,44,53,0.4);
  transition: background 0.1s;
}
.result-row:hover   { background: rgba(255,255,255,0.025); }
.result-row.checked { background: var(--red-dim); }

.result-cb { width: 14px; height: 14px; accent-color: var(--red); cursor: pointer; flex-shrink: 0; }

.result-info  { flex: 1; min-width: 0; }
.result-name  { font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 1px; }
.result-url   { font-family: var(--mono); font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.result-folder { font-family: var(--mono); font-size: 9px; color: var(--text-muted); opacity: 0.6; margin-top: 1px; }

/* ── Status badges ───────────────────────────────────────────────────────── */
.status-badge {
  font-family: var(--mono); font-size: 9px; font-weight: 600;
  letter-spacing: 0.05em; padding: 2px 7px; border-radius: 3px;
  flex-shrink: 0; white-space: nowrap;
}
.badge-http-error    { color: var(--red);  background: var(--red-dim); }
.badge-timeout       { color: #f76b15;     background: rgba(247,107,21,0.12); }
.badge-network-error { color: #3b82f6;     background: rgba(59,130,246,0.12); }

/* ── Row action buttons ──────────────────────────────────────────────────── */
.result-actions {
  display: flex; gap: 4px; opacity: 0; transition: opacity 0.12s; flex-shrink: 0;
}
.result-row:hover .result-actions { opacity: 1; }

.result-action {
  font-family: var(--mono); font-size: 10px; color: var(--text-muted);
  background: transparent; border: 1px solid var(--border); border-radius: 3px;
  padding: 3px 8px; cursor: pointer; transition: all 0.12s; white-space: nowrap;
}
.result-action.open:hover { color: var(--amber); border-color: var(--amber); background: var(--amber-dim); }
.result-action.edit:hover { color: var(--text); border-color: var(--border-light); background: var(--surface-3); }
.result-action.del:hover  { color: var(--red);  border-color: var(--red); background: var(--red-dim); }

/* ── Bulk action bar ─────────────────────────────────────────────────────── */
.scan-bulk-bar {
  padding: 10px 20px; background: rgba(17,18,20,0.97);
  backdrop-filter: blur(16px); border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0; z-index: 10;
}
.bulk-label { font-family: var(--mono); font-size: 11px; color: var(--red); font-weight: 500; }
.select-all-link {
  font-family: var(--mono); font-size: 10px; color: var(--text-muted);
  cursor: pointer; transition: color 0.12s;
}
.select-all-link:hover { color: var(--text); }
```

- [ ] **Step 2: Reload extension and verify**

Reload the extension in Chrome. Open the extension. Visually confirm nothing broke (no CSS errors in devtools console).

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "feat: add scan panel CSS"
```

---

### Task 4: Add ScanView module to app.js

**Files:**
- Modify: `app.js`

ScanView is appended as an IIFE to the end of `app.js`. It shares scope with all existing helpers: `el`, `appendChildren`, `clearEl`, `Modal`, `toast`, `animateRemoveRow`, `countUrls`, `fullTree`, `updateActionBar`.

- [ ] **Step 1: Append ScanView module to app.js**

Append the following block to the very end of `app.js`:

```js
// ── ScanView ────────────────────────────────────────────────────────────────
const ScanView = (() => {
  'use strict';

  let scanTabId   = null;   // chrome tab ID of this extension page
  let scanning    = false;  // true while a scan is in progress
  let watchdog    = null;   // setTimeout handle
  let brokenList  = [];     // results from last SCAN_COMPLETE
  let scanTotal   = 0;      // total bookmarks checked in last scan
  let checkedScanIds = new Set();

  // Track whether the Dead Links panel is currently shown
  let inScanView  = false;

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    chrome.tabs.getCurrent(tab => {
      if (!tab) {
        console.error('ScanView: could not resolve tab ID — scan disabled');
        return;
      }
      scanTabId = tab.id;
      injectUI(); // onMessage listener is registered inside injectUI — not here
    });
  }

  // ── DOM injection ──────────────────────────────────────────────────────────

  function injectUI() {
    // ① Tab button — injected into #main-header, before .header-actions
    const mainHeader = document.getElementById('main-header');
    const headerActions = mainHeader.querySelector('.header-actions');
    const tabBtn = el('button', { cls: 'tab-btn', text: '⚠ Dead Links', onclick: toggleView });
    mainHeader.insertBefore(tabBtn, headerActions);

    // ② Scan panel — appended to #main as sibling of #bookmark-list / #empty-state
    const main = document.getElementById('main');

    // Idle state
    const idleSub = el('div', { cls: 'scan-sub', id: 'scan-idle-sub',
      text: 'Scans all bookmarks in your collection' });
    const startBtn = el('button', { cls: 'btn-confirm-info',
      text: 'Scan All Bookmarks', onclick: startScan });
    const idleEl = el('div', { cls: 'scan-idle', id: 'scan-idle' },
      el('div', { cls: 'scan-center' },
        el('div', { cls: 'scan-title', text: 'Check for dead links' }),
        idleSub,
        startBtn
      )
    );

    // Scanning state
    const progressFill  = el('div', { cls: 'progress-bar-fill', id: 'progress-fill' });
    const progressText  = el('span', { id: 'progress-text',   text: '0 of 0 checked' });
    const progressBroken= el('span', { id: 'progress-broken', text: '0 broken so far' });
    const cancelBtn = el('button', { cls: 'btn-ghost', text: 'Cancel', onclick: cancelScan });
    const scanningEl = el('div', { cls: 'scan-scanning hidden', id: 'scan-scanning' },
      el('div', { cls: 'scan-center' },
        el('div', { cls: 'scan-title', text: 'Scanning all bookmarks\u2026' }),
        el('div', { cls: 'scan-sub',   text: 'Checking for broken links across your entire collection' }),
        el('div', { cls: 'progress-wrap' },
          el('div', { cls: 'progress-bar-bg' }, progressFill),
          el('div', { cls: 'progress-label' }, progressText, progressBroken)
        ),
        cancelBtn
      )
    );

    // Results state
    const resultsHeader = el('div', { cls: 'results-header', id: 'results-header' });
    const resultsList   = el('div', { cls: 'results-list',   id: 'results-list' });
    const bulkLabel     = el('span', { cls: 'bulk-label', id: 'bulk-label', text: '0 selected' });
    const selectAllLink = el('span', { cls: 'select-all-link', id: 'select-all-link',
      text: 'Select All (0)', onclick: toggleSelectAll });
    const bulkDeleteBtn = el('button', { cls: 'btn-danger', text: 'Delete Selected',
      onclick: bulkDelete });
    const bulkBar = el('div', { cls: 'scan-bulk-bar hidden', id: 'scan-bulk-bar' },
      bulkLabel,
      el('div', { style: 'display:flex;gap:8px;align-items:center' },
        selectAllLink, bulkDeleteBtn)
    );
    const resultsEl = el('div', { cls: 'scan-results hidden', id: 'scan-results' },
      resultsHeader, resultsList, bulkBar
    );

    // Assemble panel
    const panel = el('div', { id: 'scan-panel', cls: 'hidden' },
      idleEl, scanningEl, resultsEl
    );
    main.appendChild(panel);

    // Register message listener exactly once here
    chrome.runtime.onMessage.addListener(onMessage);
  }

  // ── View toggle ────────────────────────────────────────────────────────────

  function toggleView() {
    inScanView = !inScanView;
    const panel      = document.getElementById('scan-panel');
    const list       = document.getElementById('bookmark-list');
    const empty      = document.getElementById('empty-state');
    const actionBar  = document.getElementById('action-bar');
    const tabBtn     = document.querySelector('.tab-btn');

    if (inScanView) {
      list.classList.add('hidden');
      empty.classList.add('hidden');
      actionBar.classList.add('hidden');
      panel.classList.remove('hidden');
      tabBtn.classList.add('active-tab');
      // Update idle subtitle with live count
      document.getElementById('scan-idle-sub').textContent =
        `Scans all ${countUrls(fullTree)} bookmarks in your collection`;
      // If scan finished while user was away, show idle (not stale scanning state)
      if (!scanning) setState('idle');
    } else {
      panel.classList.add('hidden');
      tabBtn.classList.remove('active-tab');
      // Restore main view: let the existing state drive visibility
      // selectedFolderId determines whether list or empty-state shows
      if (selectedFolderId) {
        const node = findNode(fullTree, selectedFolderId);
        if (node) { renderBookmarks(node); } else { clearMain(); }
      } else {
        clearMain();
      }
      updateActionBar(); // restore #action-bar based on checkedIds — don't unconditionally show
    }
  }

  // ── Panel state ────────────────────────────────────────────────────────────

  function setState(state) {
    document.getElementById('scan-idle').classList.toggle('hidden',     state !== 'idle');
    document.getElementById('scan-scanning').classList.toggle('hidden', state !== 'scanning');
    document.getElementById('scan-results').classList.toggle('hidden',  state !== 'results');
  }

  // ── Scan lifecycle ─────────────────────────────────────────────────────────

  function startScan() {
    if (!scanTabId) { toast('Cannot start scan: tab ID unavailable', 'error'); return; }
    checkedScanIds.clear();
    setState('scanning');
    scanning = true;
    resetWatchdog();
    chrome.runtime.sendMessage({ type: 'START_SCAN', tabId: scanTabId });
  }

  function cancelScan() {
    chrome.runtime.sendMessage({ type: 'CANCEL_SCAN' });
    clearWatchdog();
    scanning = false;
    setState('idle'); // return panel to idle — SCAN_COMPLETE may still arrive but will be ignored
  }

  // Watchdog: reset on every SCAN_PROGRESS — fires 15s after the last one
  function resetWatchdog() {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (scanning) {
        scanning = false;
        if (inScanView) {
          setState('idle');
          toast('Scan interrupted \u2014 please try again', 'error');
        }
      }
    }, 15000);
  }

  function clearWatchdog() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  // ── Message handling ───────────────────────────────────────────────────────

  function onMessage(msg) {
    if (msg.type === 'SCAN_PROGRESS' && inScanView) {
      resetWatchdog();
      const { checked, total, brokenCount } = msg;
      const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('progress-text').textContent   = `${checked} of ${total} checked`;
      document.getElementById('progress-broken').textContent = `${brokenCount} broken so far`;
    }
    if (msg.type === 'SCAN_COMPLETE') {
      clearWatchdog();
      scanning   = false;
      brokenList = msg.broken || [];
      scanTotal  = msg.total  || 0;
      if (inScanView) renderResults();
    }
  }

  // ── Results rendering ──────────────────────────────────────────────────────

  function renderResults() {
    setState('results');
    checkedScanIds.clear();
    updateBulkBar();

    const header = document.getElementById('results-header');
    clearEl(header);

    if (brokenList.length === 0) {
      header.appendChild(el('span', {
        style: 'font-family:var(--mono);font-size:11px;color:var(--green)',
        text: '\u2713 No broken links found \u2014 your bookmarks are clean.'
      }));
      clearEl(document.getElementById('results-list'));
      document.getElementById('scan-bulk-bar').classList.add('hidden');
      return;
    }

    // Results header: summary + rescan button
    const summary = document.createElement('div');
    summary.className = 'results-summary';
    summary.appendChild(document.createTextNode('Found '));
    summary.appendChild(el('span', { cls: 'count',
      text: `${brokenList.length} broken link${brokenList.length !== 1 ? 's' : ''}` }));
    summary.appendChild(document.createTextNode(` out of ${scanTotal} checked`));

    const rescanBtn = el('button', { cls: 'rescan-btn', text: 'Re-scan',
      onclick: () => setState('idle') });
    appendChildren(header, summary, rescanBtn);

    // Sorted list
    const list = document.getElementById('results-list');
    clearEl(list);
    const sorted = [...brokenList].sort((a, b) =>
      (a.folderPath + '\0' + a.title).localeCompare(b.folderPath + '\0' + b.title)
    );
    for (const bm of sorted) list.appendChild(buildResultRow(bm));

    document.getElementById('select-all-link').textContent =
      `Select All (${brokenList.length})`;
  }

  function buildResultRow(bm) {
    const row = el('div', { cls: 'result-row' });
    row.dataset.id = bm.id;

    // Checkbox
    const cb = el('input', { type: 'checkbox', cls: 'result-cb' });
    cb.checked = checkedScanIds.has(bm.id);
    cb.addEventListener('click', e => {
      e.stopPropagation();
      toggleScanCheck(bm.id, cb.checked, row);
    });

    // Info block
    const nameEl   = el('div', { cls: 'result-name',   text: bm.title });
    const urlEl    = el('div', { cls: 'result-url',    text: bm.url });
    const folderEl = el('div', { cls: 'result-folder',
      text: bm.folderPath ? '\uD83D\uDCC1 ' + bm.folderPath : '' });
    const info = el('div', { cls: 'result-info' }, nameEl, urlEl, folderEl);

    // Status badge
    const badge = el('span', { cls: `status-badge badge-${bm.statusType}`,
      text: bm.statusLabel });

    // Open button
    const openBtn = el('button', { cls: 'result-action open', text: '\u2197',
      title: 'Open in new tab',
      onclick: e => { e.stopPropagation(); chrome.tabs.create({ url: bm.url }); }
    });

    // Edit button — updates in-place, no reload()
    const editBtn = el('button', { cls: 'result-action edit', text: 'Edit',
      onclick: async e => {
        e.stopPropagation();
        const result = await Modal.editBookmark('Edit bookmark', bm.title, bm.url);
        if (!result) return;
        await chrome.bookmarks.update(bm.id, { title: result.title, url: result.url });
        bm.title = result.title;
        bm.url   = result.url;
        nameEl.textContent = result.title;
        urlEl.textContent  = result.url;
        toast('Bookmark updated', 'success');
      }
    });

    // Delete button — removes row, decrements counts, no reload()
    const delBtn = el('button', { cls: 'result-action del', text: 'Delete',
      onclick: async e => {
        e.stopPropagation();
        await chrome.bookmarks.remove(bm.id);
        checkedScanIds.delete(bm.id);
        brokenList = brokenList.filter(b => b.id !== bm.id);
        animateRemoveRow(row);
        setTimeout(async () => {
          row.remove();
          updateResultsCount();
          await updateSidebarTotal();
        }, 300);
        toast('Deleted', 'success');
      }
    });

    const actions = el('div', { cls: 'result-actions' }, openBtn, editBtn, delBtn);
    appendChildren(row, cb, info, badge, actions);
    return row;
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggleScanCheck(id, checked, row) {
    if (checked) checkedScanIds.add(id); else checkedScanIds.delete(id);
    row.classList.toggle('checked', checked);
    updateBulkBar();
  }

  function toggleSelectAll() {
    const allRows = [...document.querySelectorAll('.result-row')];
    const allOn   = allRows.every(r => checkedScanIds.has(r.dataset.id));
    allRows.forEach(row => {
      const cb = row.querySelector('.result-cb');
      if (allOn) {
        checkedScanIds.delete(row.dataset.id);
        cb.checked = false; row.classList.remove('checked');
      } else {
        checkedScanIds.add(row.dataset.id);
        cb.checked = true;  row.classList.add('checked');
      }
    });
    updateBulkBar();
  }

  function updateBulkBar() {
    const n   = checkedScanIds.size;
    const bar = document.getElementById('scan-bulk-bar');
    if (bar) bar.classList.toggle('hidden', n === 0);
    const lbl = document.getElementById('bulk-label');
    if (lbl) lbl.textContent = `${n} selected`;
  }

  // ── Bulk delete ────────────────────────────────────────────────────────────

  async function bulkDelete() {
    if (checkedScanIds.size === 0) return;
    const ids = [...checkedScanIds];
    const ok = await Modal.confirm(
      'Delete bookmarks',
      `Delete ${ids.length} bookmark${ids.length !== 1 ? 's' : ''}? This cannot be undone.`,
      'danger'
    );
    if (!ok) return;

    let deleted = 0;
    for (const id of ids) {
      try {
        await chrome.bookmarks.remove(id);
        const row = document.querySelector(`.result-row[data-id="${id}"]`);
        if (row) { animateRemoveRow(row); setTimeout(() => row.remove(), 300); }
        brokenList = brokenList.filter(b => b.id !== id);
        deleted++;
      } catch (err) { console.error(err); }
    }
    checkedScanIds.clear();
    updateBulkBar();
    updateResultsCount();
    await updateSidebarTotal();
    toast(`Deleted ${deleted} bookmark${deleted !== 1 ? 's' : ''}`, 'success');
  }

  // ── Stat helpers ───────────────────────────────────────────────────────────

  // Update the broken count in the results header without calling reload()
  function updateResultsCount() {
    const countEl = document.querySelector('#results-header .count');
    if (!countEl) return;
    const n = brokenList.length;
    countEl.textContent = `${n} broken link${n !== 1 ? 's' : ''}`;
  }

  // Update #stat-total in the sidebar without triggering renderSidebar or renderBookmarks
  async function updateSidebarTotal() {
    const tree = await chrome.bookmarks.getTree();
    const totalEl = document.getElementById('stat-total');
    if (totalEl) totalEl.textContent = countUrls(tree[0]) || '\u2014';
  }

  return { init };
})();
```

- [ ] **Step 2: Call ScanView.init() in the DOMContentLoaded handler**

Find this block in `app.js` (around line 34–41):

```js
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof chrome === 'undefined' || !chrome.bookmarks) {
    showFatalError('chrome.bookmarks API not available. Load this as a Chrome extension.');
    return;
  }
  await reload();
  bindListeners();
});
```

Replace it with:

```js
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof chrome === 'undefined' || !chrome.bookmarks) {
    showFatalError('chrome.bookmarks API not available. Load this as a Chrome extension.');
    return;
  }
  await reload();
  bindListeners();
  ScanView.init();
});
```

- [ ] **Step 3: Reload extension and verify basic rendering**

Reload extension in `chrome://extensions`. Open the extension. Confirm:
- "⚠ Dead Links" tab button appears in the header
- Clicking it shows the "Check for dead links" idle panel
- Clicking it again returns to the normal bookmark view
- The `#action-bar` is correctly restored on return (uses `updateActionBar()`)

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: add ScanView module with idle/scanning/results states"
```

---

### Task 5: End-to-end manual test

- [ ] **Step 1: Add a dead bookmark for testing**

Manually add a bookmark to Chrome with URL `https://httpstat.us/404` (or any known-dead URL). Add one more with `https://example.com` (should be alive).

- [ ] **Step 2: Run a scan and verify progress**

Open the extension. Click "⚠ Dead Links". Click "Scan All Bookmarks". Confirm:
- Progress bar animates
- Counter updates: "N of M checked"
- "N broken so far" increments when dead URLs are found

- [ ] **Step 3: Verify results**

After the scan completes, confirm:
- Only broken bookmarks appear (not `example.com`)
- `httpstat.us/404` appears with a red `404` badge
- The results header shows the correct count

- [ ] **Step 4: Verify per-row actions**

On the broken result row:
- Click ↗ Open — confirm a new tab opens to that URL
- Click Edit — confirm the modal opens pre-filled; change the title; save; confirm the row title updates in-place without losing scan results
- Click Delete — confirm the row disappears and the count in the header decrements

- [ ] **Step 5: Verify bulk delete**

Check two rows. Confirm bulk bar appears with "2 selected". Click "Delete Selected". Confirm the modal, confirm both rows are removed and stat updates.

- [ ] **Step 6: Verify cancel**

Start a new scan on a large bookmark set. Click Cancel during scanning. Confirm the scan stops and the UI remains in idle state.

- [ ] **Step 7: Verify SW eviction protection**

(Optional, hard to trigger manually) If you can simulate SW eviction, confirm that after 15 seconds of no progress messages, the UI transitions to idle state and shows the "Scan interrupted" toast.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat: dead link scanner — complete implementation"
```
