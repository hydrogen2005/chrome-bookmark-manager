import { checkLink, collectLinks } from './checker.js';

const $ = id => document.getElementById(id);
const state = { root: null, nodes: new Map(), folder: null, collapsed: new Set(), selected: new Set(), results: new Map(), run: null, busy: false };
let refreshTimer;
let toastTimer;
let loadVersion = 0;
function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
async function safely(action) {
  try { await action(); } catch (error) { notify(`操作未完成：${error.message}`); }
}
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function readonly(node) {
  for (let current = node; current; current = state.nodes.get(current.parentId)) {
    if (current.unmodifiable) return true;
  }
  return false;
}
function protectedFolder(node) { return !node || !node.parentId || node.parentId === state.root.id || !!node.folderType || readonly(node); }
function writableTarget(node) { return node && !node.url && node.id !== state.root.id && !readonly(node); }
function path(node) {
  const parts = [];
  for (let current = node; current && current.parentId; current = state.nodes.get(current.parentId)) parts.unshift(current.title || '未命名目录');
  return parts.join(' / ');
}
function resultFor(node) {
  const result = state.results.get(node.id);
  return result?.url === node.url ? result : { kind: 'unchecked', label: '未检测', detail: '' };
}
function scopeLinks() { return collectLinks(state.nodes.get(state.folder), $('recursive').checked); }
function visibleLinks() {
  const query = $('search').value.trim().toLowerCase();
  return scopeLinks().filter(node => (!query || `${node.title} ${node.url}`.toLowerCase().includes(query)) && ($('filter').value === 'all' || resultFor(node).kind === $('filter').value));
}
async function loadTree() {
  const version = ++loadVersion;
  const [root] = await chrome.bookmarks.getTree();
  if (version !== loadVersion) return;
  state.root = root;
  state.nodes.clear();
  function index(node) { state.nodes.set(node.id, node); node.children?.forEach(index); }
  index(root);
  if (!state.nodes.has(state.folder)) state.folder = root.children?.find(node => !node.url)?.id || root.id;
  for (const id of state.selected) if (!state.nodes.has(id)) state.selected.delete(id);
  for (const [id, result] of state.results) if (state.nodes.get(id)?.url !== result.url) state.results.delete(id);
  render();
}
function renderTree() {
  const fragment = document.createDocumentFragment();
  function append(node, depth) {
    if (node.url) return;
    const row = el('div', `tree-row${node.id === state.folder ? ' active' : ''}`);
    row.style.paddingLeft = `${depth * 15 + 5}px`;
    const folders = (node.children || []).filter(child => !child.url);
    const toggle = el('button', 'toggle', folders.length ? (state.collapsed.has(node.id) ? '▸' : '▾') : '·');
    toggle.disabled = !folders.length;
    toggle.setAttribute('aria-label', `展开或收起 ${node.title}`);
    toggle.setAttribute('aria-expanded', String(!state.collapsed.has(node.id)));
    toggle.onclick = () => { state.collapsed.has(node.id) ? state.collapsed.delete(node.id) : state.collapsed.add(node.id); renderTree(); };
    const button = el('button', 'folder-link', `▱  ${node.title || '全部收藏夹'}`);
    button.title = path(node) || '全部收藏夹';
    if (node.id === state.folder) button.setAttribute('aria-current', 'true');
    button.onclick = () => { state.folder = node.id; state.selected.clear(); render(); };
    row.append(toggle, button);
    if (writableTarget(node)) {
      row.ondragover = event => {
        if (state.busy || !event.dataTransfer.types.includes('application/x-bookmark-ids')) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target');
      };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = event => {
        event.preventDefault(); row.classList.remove('drop-target');
        safely(async () => {
          const ids = JSON.parse(event.dataTransfer.getData('application/x-bookmark-ids'));
          if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) return;
          await moveBookmarks(ids, node.id);
        });
      };
    }
    fragment.append(row);
    if (!state.collapsed.has(node.id)) folders.forEach(child => append(child, depth + 1));
  }
  append(state.root, 0);
  $('tree').replaceChildren(fragment);
}
function updateSelection() {
  const visible = visibleLinks().filter(node => !readonly(node));
  const selected = visible.filter(node => state.selected.has(node.id)).length;
  $('selectAll').checked = visible.length > 0 && selected === visible.length;
  $('selectAll').indeterminate = selected > 0 && selected < visible.length;
  $('selectedCount').textContent = `已选 ${state.selected.size} 项`;
  $('deleteSelected').disabled = state.busy || !state.selected.size;
  $('moveSelected').disabled = state.busy || !state.selected.size;
  $('selectBroken').disabled = state.busy || !visible.some(node => resultFor(node).kind === 'broken');
}
function renderList() {
  const links = visibleLinks();
  const visibleIds = new Set(links.map(node => node.id));
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id);
  $('count').textContent = `${links.length} / ${scopeLinks().length} 个书签`;
  const fragment = document.createDocumentFragment();
  for (const node of links) {
    const row = el('div', 'bookmark-row');
    row.draggable = !readonly(node) && !state.busy;
    row.ondragstart = event => {
      const ids = state.selected.has(node.id) ? [...state.selected] : [node.id];
      event.dataTransfer.setData('application/x-bookmark-ids', JSON.stringify(ids));
      event.dataTransfer.effectAllowed = 'move';
    };
    const main = el('div', 'bookmark-main');
    const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(node.id);
    checkbox.disabled = readonly(node) || state.busy;
    checkbox.setAttribute('aria-label', `选择 ${node.title || node.url}`);
    checkbox.onchange = () => { checkbox.checked ? state.selected.add(node.id) : state.selected.delete(node.id); updateSelection(); };
    const text = el('div', 'bookmark-text');
    const title = el('a', 'bookmark-title', node.title || '未命名书签');
    title.title = node.title || node.url;
    // Never execute bookmarklets or other active schemes in the extension origin.
    if (/^(https?|ftp|file):\/\//i.test(node.url)) { title.href = node.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
    else { title.title = '此类型链接请从 Chrome 收藏夹打开'; }
    const url = el('div', 'bookmark-url', node.url); url.title = node.url;
    text.append(title, url, el('div', 'bookmark-path', path(state.nodes.get(node.parentId))));
    main.append(checkbox, el('span', 'drag-handle', '⠿'), text);
    const result = resultFor(node);
    const status = el('div');
    status.append(el('span', `badge ${result.kind}`, result.label), el('div', 'status-detail', result.detail));
    const remove = el('button', 'danger', '删除');
    remove.disabled = readonly(node) || state.busy;
    remove.onclick = () => safely(() => deleteBookmarks([node.id]));
    row.append(main, status, remove); fragment.append(row);
  }
  if (!links.length) fragment.append(el('div', 'empty', '这里还没有符合条件的书签。\n选择其他目录，或调整搜索与筛选条件。'));
  $('bookmarks').replaceChildren(fragment);
  updateSelection();
}
function render() {
  const folder = state.nodes.get(state.folder);
  $('folderTitle').textContent = folder.title || '全部收藏夹';
  $('breadcrumb').textContent = path(folder) || '我的收藏夹';
  $('newFolder').disabled = state.busy || !writableTarget(folder);
  $('renameFolder').disabled = state.busy || protectedFolder(folder);
  $('deleteFolder').disabled = state.busy || protectedFolder(folder);
  $('scan').disabled = !!state.run || state.busy || !scopeLinks().length;
  $('stop').hidden = !state.run;
  renderTree(); renderList();
}
function ask({ title, text, name, targets, destructive = false }) {
  return new Promise(resolve => {
    $('dialogTitle').textContent = title;
    $('dialogText').textContent = text;
    $('nameLabel').hidden = name === undefined;
    $('folderName').required = name !== undefined;
    $('folderName').value = name || '';
    $('targetLabel').hidden = !targets;
    $('targetFolder').replaceChildren();
    if (targets) for (const folder of targets) {
      const option = el('option', '', path(folder)); option.value = folder.id; $('targetFolder').append(option);
    }
    $('confirmDialog').className = destructive ? 'danger' : 'primary';
    let answer = null;
    $('dialogForm').onsubmit = event => {
      event.preventDefault();
      if (name !== undefined && !$('folderName').value.trim()) { $('folderName').focus(); return; }
      answer = targets ? $('targetFolder').value : name !== undefined ? $('folderName').value.trim() : true;
      $('dialog').close();
    };
    $('cancelDialog').onclick = () => $('dialog').close();
    $('dialog').onclose = () => resolve(answer);
    $('dialog').showModal();
    if (name !== undefined) $('folderName').focus(); else $('cancelDialog').focus();
  });
}
async function mutate(action) {
  if (state.busy) return;
  state.busy = true; render();
  try { await action(); } finally { state.busy = false; await loadTree(); }
}
async function moveBookmarks(ids, parentId) {
  if (state.busy) return;
  const [target] = await chrome.bookmarks.get(parentId);
  if (!writableTarget(target)) throw new Error('该目录不可写入');
  await mutate(async () => {
    let moved = 0; let failed = 0;
    for (const id of new Set(ids)) {
      try {
        const [node] = await chrome.bookmarks.get(id);
        if (!node.url || readonly(node) || node.parentId === parentId) continue;
        await chrome.bookmarks.move(id, { parentId }); moved++;
      } catch { failed++; }
    }
    state.selected.clear();
    notify(`已移动 ${moved} 个书签${failed ? `，${failed} 项未能移动，请刷新确认` : ''}`);
  });
}
async function deleteBookmarks(ids) {
  if (state.busy) return;
  const snapshot = ids.map(id => state.nodes.get(id)).filter(node => node?.url && !readonly(node));
  if (!snapshot.length) return;
  if (!await ask({ title: `删除 ${snapshot.length} 个书签？`, text: `${snapshot.slice(0, 4).map(node => node.title || node.url).join('\n')}${snapshot.length > 4 ? '\n…' : ''}\n将从 Chrome 收藏夹中永久删除，请确认所选内容。`, destructive: true })) return;
  await mutate(async () => {
    let removed = 0; let failed = 0;
    for (const original of snapshot) {
      try {
        const [current] = await chrome.bookmarks.get(original.id);
        if (current.url !== original.url || readonly(current)) { failed++; continue; }
        await chrome.bookmarks.remove(original.id); state.results.delete(original.id); removed++;
      } catch { failed++; }
    }
    state.selected.clear();
    notify(`已删除 ${removed} 个书签${failed ? `，${failed} 项已变化或无法删除` : ''}`);
  });
}
async function scan() {
  if (state.run) return;
  const links = scopeLinks().map(node => ({ id: node.id, url: node.url }));
  const folderName = state.nodes.get(state.folder).title || '全部收藏夹';
  const controller = new AbortController();
  const run = { controller, completed: 0, total: links.length };
  state.run = run;
  links.forEach(node => state.results.delete(node.id));
  $('progress').max = Math.max(1, links.length); $('progress').value = 0;
  const update = () => { $('scanStatus').textContent = `正在检测「${folderName}」：${run.completed} / ${run.total}`; $('progress').value = run.completed; };
  update(); render();
  let index = 0;
  async function worker() {
    while (!controller.signal.aborted && index < links.length) {
      const node = links[index++];
      const result = await checkLink(node.url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (state.nodes.get(node.id)?.url === node.url) state.results.set(node.id, { ...result, url: node.url });
      run.completed++; update(); renderList();
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(5, links.length) }, worker)); }
  finally {
    state.run = null;
    $('scanStatus').textContent = `${controller.signal.aborted ? '已停止' : '检测完成'}「${folderName}」：${run.completed} / ${run.total}`;
    render();
  }
}
$('refresh').onclick = () => safely(loadTree);
$('search').oninput = renderList;
$('filter').onchange = renderList;
$('recursive').onchange = () => { state.selected.clear(); render(); };
$('selectAll').onchange = () => { visibleLinks().filter(node => !readonly(node)).forEach(node => $('selectAll').checked ? state.selected.add(node.id) : state.selected.delete(node.id)); renderList(); };
$('selectBroken').onclick = () => { state.selected.clear(); visibleLinks().filter(node => !readonly(node) && resultFor(node).kind === 'broken').forEach(node => state.selected.add(node.id)); renderList(); };
$('deleteSelected').onclick = () => safely(() => deleteBookmarks([...state.selected]));
$('moveSelected').onclick = () => safely(async () => {
  const ids = [...state.selected];
  const target = await ask({ title: `移动 ${ids.length} 个书签`, text: '选择要归入的目录。', targets: [...state.nodes.values()].filter(writableTarget) });
  if (target) await moveBookmarks(ids, target);
});
$('newFolder').onclick = () => safely(async () => {
  const parentId = state.folder;
  const name = await ask({ title: '新建目录', text: `位置：${path(state.nodes.get(parentId))}`, name: '' });
  if (!name) return;
  await mutate(async () => { const created = await chrome.bookmarks.create({ parentId, title: name }); state.collapsed.delete(parentId); state.folder = created.id; notify('目录已创建'); });
});
$('renameFolder').onclick = () => safely(async () => {
  const folder = state.nodes.get(state.folder);
  if (protectedFolder(folder)) return;
  const name = await ask({ title: '重命名目录', text: '输入新的目录名称。', name: folder.title });
  if (name) await mutate(async () => { await chrome.bookmarks.update(folder.id, { title: name }); notify('目录名称已更新'); });
});
$('deleteFolder').onclick = () => safely(async () => {
  const folder = state.nodes.get(state.folder);
  if (protectedFolder(folder)) return;
  const [snapshot] = await chrome.bookmarks.getSubTree(folder.id);
  const fingerprint = node => JSON.stringify([node.id, node.title, node.url, (node.children || []).map(fingerprint)]);
  if (!await ask({ title: `删除目录「${folder.title}」？`, text: `该目录及其所有子目录、${collectLinks(snapshot, true).length} 个书签将被永久删除。`, destructive: true })) return;
  await mutate(async () => {
    const [current] = await chrome.bookmarks.getSubTree(folder.id);
    if (fingerprint(current) !== fingerprint(snapshot)) throw new Error('目录内容已变化，请重新确认后删除');
    await chrome.bookmarks.removeTree(folder.id); state.folder = folder.parentId; state.selected.clear(); notify('目录已删除');
  });
});
$('scan').onclick = () => safely(scan);
$('stop').onclick = () => state.run?.controller.abort();
for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[event].addListener(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => safely(loadTree), 150); });
}
safely(loadTree);
