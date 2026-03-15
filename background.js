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

  // Capture locally so concurrent scans can't cross-contaminate cancellation state
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
    chrome.bookmarks.getTree(([root]) => runScan(collectUrls(root), msg.tabId));
  }
  if (msg.type === 'CANCEL_SCAN' && activeScan) {
    // activeScan is the module-level ref — correctly targets the current scan
    activeScan.cancelled = true;
    activeScan.controllers.forEach(c => c.abort());
  }
  // No return true — no async response from SW to page needed
});
