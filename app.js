'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let fullTree = null;
let selectedFolderId = null;
let checkedIds = new Set();
let expandedIds = new Set();
let currentBookmarks = [];
let searchQuery = '';
let ctxTarget = null;
let dragBookmarkId = null;

// ── DOM helpers ────────────────────────────────────────────────────────────
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) Object.entries(props).forEach(([k, v]) => {
    if (k === 'cls') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.flat().forEach(c => c && node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return node;
}

function clearEl(node) { node.textContent = ''; }

function appendChildren(parent, ...children) {
  children.flat().forEach(c => c && parent.appendChild(c));
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof chrome === 'undefined' || !chrome.bookmarks) {
    showFatalError('chrome.bookmarks API not available. Load this as a Chrome extension.');
    return;
  }
  await reload();
  bindListeners();
});

function bindListeners() {
  document.getElementById('btn-new-folder').addEventListener('click', () => cmdNewFolder(null));
  document.getElementById('btn-select-all').addEventListener('click', selectAll);
  document.getElementById('btn-add-bookmark').addEventListener('click', cmdAddBookmark);
  document.getElementById('btn-deselect').addEventListener('click', deselectAll);
  document.getElementById('btn-delete').addEventListener('click', cmdDeleteSelected);
  document.getElementById('btn-move-selected').addEventListener('click', cmdMoveSelected);
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase().trim();
    applyFilter();
  });
  document.getElementById('ctx-menu').addEventListener('click', e => {
    const item = e.target.closest('.ctx-item');
    if (item && !item.classList.contains('hidden')) handleCtxAction(item.dataset.action);
  });
  document.addEventListener('click', e => { if (!e.target.closest('#ctx-menu')) hideCtxMenu(); });
  document.addEventListener('contextmenu', e => { if (!e.target.closest('#ctx-menu')) hideCtxMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideCtxMenu(); Modal.close(); } });
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) Modal.close();
  });
}

// ── Data ───────────────────────────────────────────────────────────────────
async function reload() {
  const tree = await chrome.bookmarks.getTree();
  fullTree = tree[0];
  renderSidebar();
  updateGlobalStats();
  if (selectedFolderId) {
    const node = findNode(fullTree, selectedFolderId);
    if (node) renderBookmarks(node); else clearMain();
  } else {
    clearMain();
  }
}

// ── Tree helpers ───────────────────────────────────────────────────────────
function findNode(node, id) {
  if (node.id === id) return node;
  for (const c of (node.children || [])) { const f = findNode(c, id); if (f) return f; }
  return null;
}

function findParent(root, targetId) {
  for (const c of (root.children || [])) {
    if (c.id === targetId) return root;
    const f = findParent(c, targetId);
    if (f) return f;
  }
  return null;
}

function countUrls(node) {
  if (node.url) return 1;
  return (node.children || []).reduce((n, c) => n + countUrls(c), 0);
}

function isAncestor(possibleAncId, nodeId) {
  const anc = findNode(fullTree, possibleAncId);
  return anc ? !!findNode(anc, nodeId) : false;
}

function getBreadcrumbPath(targetId) {
  function search(node, path) {
    const p = [...path, { id: node.id, title: node.title }];
    if (node.id === targetId) return p;
    for (const c of (node.children || [])) { const r = search(c, p); if (r) return r; }
    return null;
  }
  for (const c of (fullTree.children || [])) { const r = search(c, []); if (r) return r; }
  return [];
}

function extractGrouped(node) {
  const sections = [];
  function walk(n, isRoot) {
    const books = (n.children || []).filter(c => c.url);
    const subs  = (n.children || []).filter(c => !c.url);
    if (books.length) sections.push({ title: isRoot ? null : n.title, id: n.id, bookmarks: books });
    for (const s of subs) walk(s, false);
  }
  walk(node, true);
  return sections;
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function renderSidebar() {
  const container = document.getElementById('folder-tree');
  clearEl(container);
  for (const child of (fullTree.children || [])) container.appendChild(buildTreeNode(child, 0));
}

function buildTreeNode(node, depth) {
  if (node.url) return document.createDocumentFragment();
  const subs     = (node.children || []).filter(c => !c.url);
  const isOpen   = expandedIds.has(node.id);
  const isActive = node.id === selectedFolderId;
  const isRoot   = ['1','2','3'].includes(node.id);

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row' + (isActive ? ' active' : '');
  row.dataset.id = node.id;

  const indent = el('span', { style: `display:inline-block;flex-shrink:0;width:${depth * 14 + 10}px` });
  const arrow  = el('span', { cls: 'tree-arrow' + (subs.length ? (isOpen ? ' open' : '') : ' leaf'), text: '\u25B6' });
  const name   = el('span', { cls: 'tree-name', text: node.title || '(unnamed)' });
  const count  = el('span', { cls: 'tree-count', text: countUrls(node) || '' });

  appendChildren(row, indent, arrow, name, count);

  const children = el('div', { cls: 'tree-children' + (isOpen ? ' open' : '') });
  for (const s of subs) children.appendChild(buildTreeNode(s, depth + 1));

  row.addEventListener('click', e => {
    if (e.target.classList.contains('tree-edit-input')) return;
    if (subs.length) { if (expandedIds.has(node.id)) expandedIds.delete(node.id); else expandedIds.add(node.id); }
    selectFolder(node.id);
  });

  row.addEventListener('dblclick', e => { e.preventDefault(); if (!isRoot) startInlineRename(row, name, node); });

  row.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    ctxTarget = { type: 'folder', id: node.id, isRoot };
    showCtxMenu(e.clientX, e.clientY, 'folder', isRoot);
  });

  row.addEventListener('dragover', e => { if (dragBookmarkId) { e.preventDefault(); row.classList.add('drag-over'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', async e => {
    e.preventDefault(); row.classList.remove('drag-over');
    if (dragBookmarkId) {
      await chrome.bookmarks.move(dragBookmarkId, { parentId: node.id });
      dragBookmarkId = null;
      await reload();
      toast('Moved to ' + node.title, 'success');
    }
  });

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return wrapper;
}

function startInlineRename(_row, nameEl, node) {
  const input = el('input', { cls: 'tree-edit-input', value: node.title });
  nameEl.replaceWith(input);
  input.focus(); input.select();
  const save = async () => {
    const val = input.value.trim();
    if (val && val !== node.title) { await chrome.bookmarks.update(node.id, { title: val }); toast('Renamed to ' + val, 'success'); }
    input.replaceWith(nameEl);
    await reload();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') input.replaceWith(nameEl); });
}

function selectFolder(id) {
  selectedFolderId = id; checkedIds.clear(); searchQuery = '';
  document.getElementById('search-input').value = '';
  renderSidebar();
  const node = findNode(fullTree, id);
  if (node) renderBookmarks(node);
  updateActionBar();
}

// ── Main panel ────────────────────────────────────────────────────────────
function renderBookmarks(folderNode) {
  const list  = document.getElementById('bookmark-list');
  const empty = document.getElementById('empty-state');
  clearEl(list);

  const sections = extractGrouped(folderNode);
  currentBookmarks = sections.flatMap(s => s.bookmarks);
  updateBreadcrumb(folderNode);
  updateGlobalStats();

  if (currentBookmarks.length === 0) {
    list.classList.add('hidden'); empty.classList.remove('hidden');
    empty.querySelector('.empty-title').textContent = 'Empty folder';
    empty.querySelector('.empty-sub').textContent = 'Right-click the folder or use + Bookmark';
    return;
  }

  list.classList.remove('hidden'); empty.classList.add('hidden');

  for (const sec of sections) {
    if (sec.title !== null) {
      const d = el('div', { cls: 'bm-section' });
      appendChildren(d,
        el('span', { cls: 'bm-section-label', text: sec.title }),
        el('div',  { cls: 'bm-section-line' }),
        el('span', { cls: 'bm-section-count', text: String(sec.bookmarks.length) })
      );
      list.appendChild(d);
    }
    for (const bm of sec.bookmarks) list.appendChild(buildBmRow(bm));
  }
  applyFilter();
}

function buildBmRow(bm) {
  const row = el('div', { cls: 'bm-row' + (checkedIds.has(bm.id) ? ' checked' : '') });
  row.dataset.id    = bm.id;
  row.dataset.title = (bm.title || '').toLowerCase();
  row.dataset.url   = (bm.url   || '').toLowerCase();
  row.draggable = true;

  const handle = el('div', { cls: 'drag-handle' });
  handle.appendChild(el('span'));

  const cb = el('input', { type: 'checkbox', cls: 'bm-checkbox' });
  cb.checked = checkedIds.has(bm.id);
  cb.addEventListener('click', e => { e.stopPropagation(); toggleCheck(bm.id, cb.checked); });

  const nameEl = el('div', { cls: 'bm-name', text: bm.title || '(no title)' });
  const urlEl  = el('div', { cls: 'bm-url',  text: bm.url   || '' });
  const info   = el('div', { cls: 'bm-info' });
  appendChildren(info, nameEl, urlEl);

  const openLink = el('a', { cls: 'bm-open', text: '\u2197', title: 'Open in new tab', target: '_blank', rel: 'noopener noreferrer' });
  if (/^https?:\/\//.test(bm.url)) openLink.href = bm.url;
  openLink.addEventListener('click', e => e.stopPropagation());

  const actions = el('div', { cls: 'bm-row-actions' });
  actions.appendChild(openLink);

  appendChildren(row, handle, cb, info, actions);

  row.addEventListener('click', e => {
    if (e.target.tagName === 'A' || e.target.tagName === 'INPUT') return;
    if (e.target.closest('.bm-name-input')) return;
    cb.checked = !cb.checked; toggleCheck(bm.id, cb.checked);
  });

  nameEl.addEventListener('dblclick', e => { e.stopPropagation(); startBmInlineRename(nameEl, bm); });

  row.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    ctxTarget = { type: 'bookmark', id: bm.id, bm };
    showCtxMenu(e.clientX, e.clientY, 'bookmark', false);
  });

  row.addEventListener('dragstart', e => { dragBookmarkId = bm.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend', () => { dragBookmarkId = null; row.classList.remove('dragging'); });

  return row;
}

function startBmInlineRename(nameEl, bm) {
  const input = el('input', { cls: 'bm-name-input' });
  input.value = bm.title || '';
  nameEl.replaceWith(input); input.focus(); input.select();
  const save = async () => {
    const val = input.value.trim();
    if (val && val !== bm.title) { await chrome.bookmarks.update(bm.id, { title: val }); toast('Renamed to ' + val, 'success'); }
    input.replaceWith(nameEl); await reload();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') input.replaceWith(nameEl); });
}

// ── Selection ──────────────────────────────────────────────────────────────
function toggleCheck(id, checked) {
  if (checked) checkedIds.add(id); else checkedIds.delete(id);
  const row = document.querySelector('.bm-row[data-id="' + id + '"]');
  if (row) row.classList.toggle('checked', checked);
  updateActionBar(); updateGlobalStats();
}

function selectAll() {
  const visible = [...document.querySelectorAll('.bm-row:not(.hidden-filter)')];
  const allOn = visible.every(r => checkedIds.has(r.dataset.id));
  visible.forEach(r => {
    const cb = r.querySelector('.bm-checkbox');
    if (allOn) { checkedIds.delete(r.dataset.id); cb.checked = false; r.classList.remove('checked'); }
    else       { checkedIds.add(r.dataset.id);    cb.checked = true;  r.classList.add('checked'); }
  });
  updateActionBar(); updateGlobalStats();
}

function deselectAll() {
  document.querySelectorAll('.bm-row').forEach(r => {
    checkedIds.delete(r.dataset.id); r.querySelector('.bm-checkbox').checked = false; r.classList.remove('checked');
  });
  checkedIds.clear(); updateActionBar(); updateGlobalStats();
}

// ── Commands ───────────────────────────────────────────────────────────────
async function cmdNewFolder(parentId) {
  const pid = parentId || selectedFolderId || '1';
  const parentNode = findNode(fullTree, pid);
  const parentName = parentNode ? parentNode.title : 'Bookmarks bar';
  const name = await Modal.prompt('New folder', 'Folder name', '', 'Inside: ' + parentName);
  if (!name) return;
  const created = await chrome.bookmarks.create({ parentId: pid, title: name });
  expandedIds.add(pid);
  toast('Created ' + name, 'success');
  await reload();
  selectFolder(created.id);
}

async function cmdAddBookmark() {
  if (!selectedFolderId) { toast('Select a folder first', 'error'); return; }
  const result = await Modal.editBookmark('Add bookmark', '', '');
  if (!result) return;
  await chrome.bookmarks.create({ parentId: selectedFolderId, title: result.title, url: result.url });
  toast('Added ' + result.title, 'success');
  await reload();
}

async function cmdRenameFolder(id) {
  const node = findNode(fullTree, id);
  if (!node) return;
  const name = await Modal.prompt('Rename folder', 'Folder name', node.title);
  if (!name || name === node.title) return;
  await chrome.bookmarks.update(id, { title: name });
  toast('Renamed to ' + name, 'success');
  await reload();
}

async function cmdRenameBookmark(id) {
  const node = findNode(fullTree, id);
  if (!node) return;
  const result = await Modal.editBookmark('Edit bookmark', node.title, node.url);
  if (!result) return;
  await chrome.bookmarks.update(id, { title: result.title, url: result.url });
  toast('Bookmark updated', 'success');
  await reload();
}

async function cmdDeleteFolder(id) {
  const node = findNode(fullTree, id);
  if (!node) return;
  const count = countUrls(node);
  const countText = count > 0 ? count + ' bookmark' + (count !== 1 ? 's' : '') + ' will be permanently deleted.' : 'This folder is empty.';
  const ok = await Modal.confirm('Delete folder', 'Delete "' + node.title + '"? ' + countText, 'danger');
  if (!ok) return;
  await chrome.bookmarks.removeTree(id);
  if (selectedFolderId === id) { selectedFolderId = null; clearMain(); }
  toast('Deleted ' + node.title, 'success');
  await reload();
}

async function cmdDeleteBookmark(id) {
  await chrome.bookmarks.remove(id);
  checkedIds.delete(id);
  const row = document.querySelector('.bm-row[data-id="' + id + '"]');
  if (row) animateRemoveRow(row);
  setTimeout(() => reload(), 280);
  toast('Deleted', 'success');
}

async function cmdDeleteSelected() {
  if (checkedIds.size === 0) return;
  const ids = [...checkedIds];
  const ok = await Modal.confirm('Delete bookmarks', 'Delete ' + ids.length + ' bookmark' + (ids.length !== 1 ? 's' : '') + '? This cannot be undone.', 'danger');
  if (!ok) return;
  const btn = document.getElementById('btn-delete');
  btn.disabled = true;
  let deleted = 0;
  for (const id of ids) {
    try {
      await chrome.bookmarks.remove(id);
      deleted++;
      const row = document.querySelector('.bm-row[data-id="' + id + '"]');
      if (row) animateRemoveRow(row);
    } catch (e) { console.error(e); }
  }
  checkedIds.clear();
  setTimeout(async () => { await reload(); btn.disabled = false; toast('Deleted ' + deleted + ' bookmark' + (deleted !== 1 ? 's' : ''), 'success'); }, 300);
}

async function cmdMoveItem(id, isFolder) {
  const node = findNode(fullTree, id);
  if (!node) return;
  const destId = await Modal.pickFolder('Move "' + node.title + '" to...', isFolder ? id : null);
  if (!destId) return;
  await chrome.bookmarks.move(id, { parentId: destId });
  const dest = findNode(fullTree, destId);
  toast('Moved to ' + (dest ? dest.title : 'folder'), 'success');
  await reload();
}

async function cmdMoveSelected() {
  if (checkedIds.size === 0) return;
  const destId = await Modal.pickFolder('Move ' + checkedIds.size + ' bookmarks to...', null);
  if (!destId) return;
  for (const id of [...checkedIds]) { try { await chrome.bookmarks.move(id, { parentId: destId }); } catch (e) {} }
  checkedIds.clear();
  const dest = findNode(fullTree, destId);
  toast('Moved to ' + (dest ? dest.title : 'folder'), 'success');
  await reload();
}

async function cmdAddBookmarkInFolder(folderId) {
  const result = await Modal.editBookmark('Add bookmark', '', '');
  if (!result) return;
  await chrome.bookmarks.create({ parentId: folderId, title: result.title, url: result.url });
  toast('Added ' + result.title, 'success');
  selectFolder(folderId);
  await reload();
}

// ── Context menu ───────────────────────────────────────────────────────────
function showCtxMenu(x, y, type, isRoot) {
  const menu = document.getElementById('ctx-menu');
  const allItems = menu.querySelectorAll('.ctx-item, .ctx-sep');
  allItems.forEach(e => e.classList.remove('hidden'));

  const hide = (...actions) => actions.forEach(a => menu.querySelector('[data-action="' + a + '"]')?.classList.add('hidden'));

  if (type === 'folder') {
    hide('open-tab', 'edit', 'delete');
    if (isRoot) hide('rename', 'delete-folder', 'move');
  } else {
    hide('rename', 'new-subfolder', 'add-bookmark-here', 'delete-folder');
  }

  // Remove orphan separators
  let lastVisible = null;
  [...menu.children].forEach(node => {
    const isSep = node.classList.contains('ctx-sep');
    const isHidden = node.classList.contains('hidden');
    if (isSep && (!lastVisible || lastVisible.classList.contains('ctx-sep'))) { node.classList.add('hidden'); }
    if (!isHidden) lastVisible = node;
  });

  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.remove('hidden');

  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
  });
}

function hideCtxMenu() { document.getElementById('ctx-menu').classList.add('hidden'); }

function handleCtxAction(action) {
  hideCtxMenu();
  if (!ctxTarget) return;
  const { type, id, bm } = ctxTarget;
  if (type === 'folder') {
    if (action === 'rename')             cmdRenameFolder(id);
    if (action === 'new-subfolder')      cmdNewFolder(id);
    if (action === 'add-bookmark-here')  cmdAddBookmarkInFolder(id);
    if (action === 'move')               cmdMoveItem(id, true);
    if (action === 'delete-folder')      cmdDeleteFolder(id);
  }
  if (type === 'bookmark') {
    if (action === 'open-tab' && bm && /^https?:\/\//.test(bm.url)) chrome.tabs.create({ url: bm.url });
    if (action === 'edit')   cmdRenameBookmark(id);
    if (action === 'move')   cmdMoveItem(id, false);
    if (action === 'delete') cmdDeleteBookmark(id);
  }
}

// ── Modal ──────────────────────────────────────────────────────────────────
const Modal = (() => {
  let resolveFn = null;

  function openModal(type) {
    document.getElementById('modal').className = type || '';
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  function close(value) {
    document.getElementById('modal-overlay').classList.add('hidden');
    clearEl(document.getElementById('modal-body'));
    clearEl(document.getElementById('modal-footer'));
    if (resolveFn) { resolveFn(value !== undefined ? value : null); resolveFn = null; }
  }

  function makeFooter(onCancel, confirmText, confirmCls, onConfirm) {
    const footer = document.getElementById('modal-footer');
    clearEl(footer);
    const cancelBtn = el('button', { cls: 'btn-ghost', text: 'Cancel', onclick: onCancel });
    const confirmBtn = el('button', { cls: confirmCls, text: confirmText, onclick: onConfirm });
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    return confirmBtn;
  }

  function confirm(title, message, type) {
    return new Promise(resolve => {
      resolveFn = resolve;
      document.getElementById('modal-title').textContent = title;
      const body = document.getElementById('modal-body');
      clearEl(body);
      body.appendChild(el('p', { cls: 'modal-message', text: message }));
      makeFooter(() => close(false), type === 'danger' ? 'Delete' : 'Confirm', type === 'danger' ? 'btn-danger' : 'btn-confirm-info', () => close(true));
      openModal(type || 'info');
    });
  }

  function prompt(title, label, defaultVal, subtitle) {
    return new Promise(resolve => {
      resolveFn = resolve;
      document.getElementById('modal-title').textContent = title;
      const body = document.getElementById('modal-body');
      clearEl(body);
      if (subtitle) body.appendChild(el('p', { cls: 'modal-message', text: subtitle, style: 'margin-bottom:12px' }));
      const input = el('input', { cls: 'modal-input', placeholder: label });
      input.value = defaultVal || '';
      const field = el('div', { cls: 'modal-field' });
      appendChildren(field, el('label', { cls: 'modal-input-label', text: label }), input);
      body.appendChild(field);

      const go = () => { const v = input.value.trim(); if (v) close(v); else input.focus(); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      makeFooter(() => close(null), 'Save', 'btn-confirm-info', go);
      openModal('info');
      setTimeout(() => { input.focus(); input.select(); }, 50);
    });
  }

  function editBookmark(title, defaultTitle, defaultUrl) {
    return new Promise(resolve => {
      resolveFn = resolve;
      document.getElementById('modal-title').textContent = title;
      const body = document.getElementById('modal-body');
      clearEl(body);

      const titleInput = el('input', { cls: 'modal-input', placeholder: 'Bookmark name' });
      titleInput.value = defaultTitle;
      const urlInput = el('input', { cls: 'modal-input', placeholder: 'https://', type: 'url' });
      urlInput.value = defaultUrl;

      const f1 = el('div', { cls: 'modal-field' }); appendChildren(f1, el('label', { cls: 'modal-input-label', text: 'Name' }), titleInput);
      const f2 = el('div', { cls: 'modal-field' }); appendChildren(f2, el('label', { cls: 'modal-input-label', text: 'URL' }), urlInput);
      appendChildren(body, f1, f2);

      const go = () => {
        const t = titleInput.value.trim(), u = urlInput.value.trim();
        if (t && u) close({ title: t, url: u }); else (t ? urlInput : titleInput).focus();
      };
      [titleInput, urlInput].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
      makeFooter(() => close(null), 'Save', 'btn-confirm-info', go);
      openModal('info');
      setTimeout(() => { titleInput.focus(); titleInput.select(); }, 50);
    });
  }

  function pickFolder(title, excludeId) {
    return new Promise(resolve => {
      resolveFn = resolve;
      document.getElementById('modal-title').textContent = title;
      const body = document.getElementById('modal-body');
      clearEl(body);
      let pickedId = null;

      const tree = el('div', { cls: 'picker-tree' });

      function buildPickerNode(node, depth) {
        if (node.url) return null;
        if (excludeId && (node.id === excludeId || isAncestor(excludeId, node.id))) return null;
        const subs = (node.children || []).filter(c => !c.url);
        const isExpanded = expandedIds.has(node.id) || depth < 1;
        const isRootNode = node.id === fullTree.id;
        const wrapper = el('div', { cls: 'picker-node' });
        const row = el('div', { cls: 'picker-row' + (isRootNode ? ' disabled' : ''), style: 'padding-left:' + (depth * 14 + 10) + 'px' });
        const arrow = el('span', { cls: 'picker-arrow' + (subs.length ? (isExpanded ? ' open' : '') : ' leaf'), text: '\u25B6' });
        row.appendChild(arrow);
        row.appendChild(document.createTextNode(node.title || '(unnamed)'));

        const childrenEl = el('div', { cls: 'picker-children' + (isExpanded ? ' open' : '') });
        for (const s of subs) { const n = buildPickerNode(s, depth + 1); if (n) childrenEl.appendChild(n); }

        if (!isRootNode) {
          row.addEventListener('click', () => {
            tree.querySelectorAll('.picker-row.selected').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
            pickedId = node.id;
            saveBtn.disabled = false;
            if (subs.length) { const open = childrenEl.classList.toggle('open'); arrow.classList.toggle('open', open); }
          });
        }
        wrapper.appendChild(row); wrapper.appendChild(childrenEl);
        return wrapper;
      }

      for (const c of (fullTree.children || [])) { const n = buildPickerNode(c, 0); if (n) tree.appendChild(n); }
      body.appendChild(tree);

      const saveBtn = makeFooter(() => close(null), 'Move here', 'btn-confirm-info', () => { if (pickedId) close(pickedId); });
      saveBtn.disabled = true;
      openModal('info');
    });
  }

  return { confirm, prompt, editBookmark, pickFolder, close: () => close(null) };
})();

// ── Filter ─────────────────────────────────────────────────────────────────
function applyFilter() {
  document.querySelectorAll('.bm-row').forEach(row => {
    if (!searchQuery) { row.classList.remove('hidden-filter'); return; }
    row.classList.toggle('hidden-filter', !row.dataset.title.includes(searchQuery) && !row.dataset.url.includes(searchQuery));
  });
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function updateBreadcrumb(folderNode) {
  const bc = document.getElementById('breadcrumb');
  clearEl(bc);
  const path = getBreadcrumbPath(folderNode.id);
  path.forEach((seg, i) => {
    if (i > 0) bc.appendChild(el('span', { cls: 'bc-sep', text: '/' }));
    bc.appendChild(el('span', { cls: i === path.length - 1 ? 'bc-current' : '', text: seg.title }));
  });
}

function updateActionBar() {
  const n = checkedIds.size;
  document.getElementById('action-bar').classList.toggle('hidden', n === 0);
  document.getElementById('action-label').textContent = n + ' bookmark' + (n !== 1 ? 's' : '') + ' selected';
}

function updateGlobalStats() {
  document.getElementById('stat-total').textContent    = currentBookmarks.length || '—';
  document.getElementById('stat-selected').textContent = checkedIds.size;
}

function clearMain() {
  const list = document.getElementById('bookmark-list');
  clearEl(list); list.classList.add('hidden');
  const empty = document.getElementById('empty-state');
  empty.classList.remove('hidden');
  empty.querySelector('.empty-title').textContent = 'Nothing here';
  empty.querySelector('.empty-sub').textContent   = 'Select a folder from the sidebar';
  clearEl(document.getElementById('breadcrumb'));
  currentBookmarks = [];
  updateGlobalStats();
}

function animateRemoveRow(row) {
  row.style.cssText += ';transition:opacity 0.2s,max-height 0.25s,padding 0.25s;overflow:hidden;max-height:' + row.offsetHeight + 'px';
  row.style.opacity = '0';
  setTimeout(() => { row.style.maxHeight = '0'; row.style.padding = '0'; }, 30);
}

let toastTimer = null;
function toast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = type || ''; t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function showFatalError(msg) {
  clearEl(document.body);
  document.body.appendChild(el('div', { style: 'padding:40px;font-family:monospace;color:#e5484d;font-size:14px;', text: msg }));
}
