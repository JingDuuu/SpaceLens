'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const api = window.spaceLens;
  const PAGE = 100;
  const state = { snapshot: null, history: [], scanning: false, currentId: 0, selected: null, node: null, items: [], ancestors: [], total: 0, filteredBytes: 0, offset: 0, tab: 'map', mode: 'map', rects: [], drives: [], apps: null, usageBusy: false, appPage: 0, largeItems: [], largePage: 0, largeTotal: 0, changes: [], changesPage: 0, request: 0, hoverId: null, navigation: 0, selection: 0, largeRequest: 0, stateRequest: 0, scanPath: '', failedPath: '', operation: 'scan', context: null };
  const palette = { folder: '#294b61', video: '#514065', image: '#674d41', audio: '#2f5758', archive: '#635935', application: '#354c6c', software: '#354c6c', document: '#3c505e', code: '#3c5847', other: '#3c424e' };
  const labels = { folder: '文件夹', video: '视频', image: '图片', audio: '音频', archive: '压缩包', application: '程序', software: '程序', document: '文档', code: '代码', other: '其他' };
  const sources = { RunningProcess: '当前可见进程', UserAssist: 'Windows 程序启动记录', 'UserAssist/Shortcut': 'Windows 快捷方式启动记录', Unavailable: '没有可用记录', unknown: '没有可用记录' };
  let toastTimer;
  let searchTimer;
  let progressTimer;
  let latestProgress;
  let progressAt = 0;
  let activityTimer;
  let activitySequence = 0;
  const activities = new Map();
  const previewCache = new Map();
  let folderPreview = null;
  const phaseNames = { preparing: '准备', scanning: '读取文件', saving: '保存快照', indexing: '建立索引', organizing: '整理地图', ready: '完成' };
  const number = value => Number(value || 0).toLocaleString('zh-CN');
  const directory = node => node && (node.kind === 'directory' || node.kind === 'dir' || node.kind === 'folder');
  const dateTime = value => {
    const date = new Date(value);
    return !value || !Number.isFinite(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const daysSince = value => value && Number.isFinite(Date.parse(value)) ? Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000)) : null;
  const ageText = days => days === null ? '没有可靠记录' : days === 0 ? '今天有启动记录' : `${number(days)} 天前有启动记录`;
  const bytesParts = value => {
    const n = Math.max(0, Number(value) || 0);
    if (n < 1000) return [number(n), 'B'];
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const power = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
    const v = n / 1000 ** power;
    return [v.toLocaleString('zh-CN', { maximumFractionDigits: v >= 100 ? 1 : 2 }), units[power]];
  };
  const bytes = value => bytesParts(value).join(' ');
  const duration = value => {
    const seconds = Math.max(0, Number(value || 0) / 1000);
    if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
  };
  function element(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.append(use);
    return svg;
  }
  function setBigBytes(target, value) {
    const [n, unit] = bytesParts(value);
    $(target).replaceChildren(document.createTextNode(n), element('small', '', unit));
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
  }
  function beginActivity(message, target) {
    clearTimeout(activityTimer);
    const token = ++activitySequence;
    activities.set(token, { message, target });
    if (target) { target.classList.add('busy'); target.setAttribute('aria-busy', 'true'); }
    $('activity-status').hidden = false;
    $('activity-status').classList.add('busy');
    $('activity-message').textContent = message;
    return token;
  }
  function endActivity(token, message) {
    const entry = activities.get(token);
    activities.delete(token);
    if (entry?.target && ![...activities.values()].some(item => item.target === entry.target)) {
      entry.target.classList.remove('busy'); entry.target.removeAttribute('aria-busy');
    }
    const pending = [...activities.values()].at(-1);
    $('activity-status').classList.toggle('busy', Boolean(pending));
    if (pending) $('activity-message').textContent = pending.message;
    else {
      $('activity-message').textContent = message || '已就绪';
      activityTimer = setTimeout(() => { if (!activities.size) $('activity-status').hidden = true; }, 2500);
    }
  }
  async function withActivity(message, action, target, success) {
    const token = beginActivity(message, target);
    try { const result = await action(); endActivity(token, typeof success === 'function' ? success(result) : success); return result; }
    catch (error) { endActivity(token, '操作未完成，请查看上方提示'); throw error; }
  }
  function feedback(target) {
    if (!target || document.body.classList.contains('keyboard-input') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    target.getAnimations().forEach(animation => animation.cancel());
    target.animate([{ opacity: .76, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 140, easing: 'cubic-bezier(.23,1,.32,1)' });
  }
  function notice(message, error = false) {
    $('notice-message').textContent = message;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = false;
  }
  const safe = action => async event => {
    try { await action(event); }
    catch (error) { notice(error?.message || '操作没有完成，请重试。', true); }
  };
  async function invoke(method, args) {
    if (!api) throw new Error('请通过 SpaceLens.exe 启动软件，以连接本机扫描引擎。');
    return api.invoke(method, args);
  }
  function filters() {
    return { search: $('search-input').value.trim(), category: $('category-select').value, olderDays: Number($('older-select').value) };
  }
  function loading(container, message = '正在读取，请稍候…') {
    const block = element('div', 'loading-lines');
    block.setAttribute('role', 'status');
    block.setAttribute('aria-label', message);
    block.append(element('span', 'loading-label', message));
    for (let i = 0; i < 3; i++) block.append(element('i'));
    container.replaceChildren(block);
  }
  function empty(container, text) { container.replaceChildren(element('div', 'inline-empty', text)); }

  function setScanning(scanning) {
    state.scanning = scanning;
    $('progress-section').hidden = !scanning;
    $('scan-button').hidden = scanning;
    document.body.classList.toggle('is-scanning', scanning);
    $('cancel-button').hidden = !scanning;
    if (!scanning) state.stopRequested = false;
    $('cancel-button').disabled = Boolean(state.stopRequested) || state.stage === 'saving';
    $('cancel-button').textContent = state.stopRequested ? '正在停止…' : state.stage === 'saving' ? '正在保存…' : state.operation !== 'scan' || ['indexing', 'organizing'].includes(state.stage) ? '停止整理' : '停止扫描';
    for (const id of ['drive-select', 'path-input', 'choose-folder', 'history-select', 'empty-choose']) $(id).disabled = scanning;
    if (!scanning) { clearInterval(progressTimer); progressTimer = null; }
    renderSnapshotContext();
  }
  function renderSnapshotContext() {
    const meta = state.snapshot;
    const previous = Boolean(meta && (state.scanning && state.operation !== 'compare' || state.failedPath));
    $('snapshot-context').hidden = !meta;
    $('snapshot-context').classList.toggle('previous', previous);
    $('snapshot-context').textContent = !meta ? '' : previous
      ? `下方保留的是上一次结果：${meta.rootPath} · ${dateTime(meta.startedAt)}${state.failedPath ? `；${state.failedPath} 本次扫描未完成` : '；当前处理完成后更新'}`
      : `当前显示：${meta.rootPath} · ${dateTime(meta.startedAt)}${state.scanning && state.operation === 'compare' ? '；正在计算与历史快照的差异' : ''}`;
  }
  function renderProgress(p) {
    if (!p) return;
    const stage = p.stage || 'scanning';
    const operation = p.operation || state.operation;
    state.operation = operation;
    state.stage = stage;
    $('cancel-button').hidden = !state.scanning || stage === 'ready';
    $('cancel-button').disabled = Boolean(state.stopRequested) || stage === 'saving';
    $('cancel-button').textContent = state.stopRequested ? '正在停止…' : stage === 'saving' ? '正在保存…' : operation !== 'scan' || ['indexing', 'organizing'].includes(stage) ? '停止整理' : '停止扫描';
    const phases = operation === 'scan' ? ['preparing', 'scanning', 'saving', 'indexing', 'organizing', 'ready'] : ['preparing', 'indexing', 'organizing', 'ready'];
    const active = Math.max(0, phases.indexOf(stage));
    $('phase-steps').replaceChildren(...phases.map((key, index) => {
      const step = element('li', `phase-step${index === active ? ' active' : index < active ? ' done' : ''}`, `${index < active ? '✓' : index + 1} ${phaseNames[key]}`);
      step.dataset.stage = key;
      if (index === active) step.setAttribute('aria-current', 'step');
      return step;
    }));
    const phaseTitle = { preparing: operation === 'scan' ? '正在准备扫描' : operation === 'compare' ? '正在读取对比快照' : operation === 'recover' ? '正在恢复未完成的快照' : '正在打开历史快照', scanning: '正在读取文件和文件夹', saving: '正在保存扫描结果', indexing: operation === 'compare' ? '正在建立对比快照索引' : '正在建立文件索引', organizing: operation === 'compare' ? '正在计算空间变化' : '正在整理空间地图', ready: operation === 'compare' ? '空间对比已就绪' : '空间地图已就绪' };
    $('progress-title').textContent = phaseTitle[stage] || p.message || '正在处理';
    $('progress-count').textContent = `${number(p.files)} 个文件 · ${number(p.dirs)} 个文件夹`;
    $('progress-bytes').textContent = bytes(p.bytes);
    $('progress-time').textContent = duration(p.elapsedMs);
    $('progress-path').textContent = p.currentPath || p.path || '';
    $('progress-path').title = p.currentPath || p.path || '';
    $('progress-rate').textContent = stage === 'scanning' && p.elapsedMs > 0 ? `平均 ${number(Math.round(p.files / (p.elapsedMs / 1000)))} 文件/秒` : '';
    // Directory enumeration has no known total. A byte ratio only describes its current phase.
    const ratio = stage === 'scanning' ? null : typeof p.phaseProgress === 'number' ? p.phaseProgress : p.totalBytes > 0 && Number.isFinite(p.processedBytes) ? p.processedBytes / p.totalBytes : stage === 'ready' ? 1 : null;
    const determinate = ratio !== null && Number.isFinite(ratio);
    const percent = determinate ? Math.max(0, Math.min(100, ratio * 100)) : 0;
    $('progress-track').classList.toggle('indeterminate', !determinate);
    $('progress-fill').style.transform = determinate ? `scaleX(${percent / 100})` : '';
    $('progress-track').setAttribute('aria-label', `${phaseNames[stage] || '处理'}阶段进度`);
    for (const attribute of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow']) $('progress-track').removeAttribute(attribute);
    if (determinate) {
      $('progress-track').setAttribute('aria-valuemin', '0'); $('progress-track').setAttribute('aria-valuemax', '100'); $('progress-track').setAttribute('aria-valuenow', String(Math.round(percent)));
    }
    const detail = determinate ? `本阶段 ${Math.floor(percent)}%${p.totalBytes ? ` · ${bytes(p.processedBytes)} / ${bytes(p.totalBytes)}` : ''}` : stage === 'scanning' ? '正在发现文件，总数尚未知；暂不估算百分比或剩余时间' : p.message || '正在处理，完成后自动进入下一阶段';
    $('progress-detail').textContent = detail;
    $('progress-track').setAttribute('aria-valuetext', detail);
    $('progress-note').textContent = stage === 'scanning' ? '可继续查看上一次结果。停止扫描后会保存已经读取的部分。' : stage === 'saving' ? '正在写入扫描结果，保存完成后自动继续。' : stage === 'indexing' || stage === 'organizing' ? '可停止整理，原始结果会保留；之后从历史记录中继续打开。' : operation === 'scan' ? '正在检查路径并启动本机扫描引擎。' : '正在读取本机快照，页面仍可操作。';
    $('footer-status').textContent = `${phaseTitle[stage] || '正在处理'} · ${number(p.files)} 个文件`;
  }
  async function onProgress(event) {
    try {
      if (event.type === 'progress') {
        state.operation = event.operation || state.operation;
        if (!state.scanning) setScanning(true);
        latestProgress = event;
        progressAt = Date.now();
        renderProgress(event);
        if (!progressTimer) progressTimer = setInterval(() => {
          if (state.scanning && latestProgress) $('progress-time').textContent = duration((latestProgress.elapsedMs || 0) + Date.now() - progressAt);
        }, 1000);
      } else if (event.type === 'operation-complete') {
        setScanning(false);
        renderSnapshotContext();
        $('footer-status').textContent = event.operation === 'compare' ? '空间对比已完成' : '处理已完成';
      } else if (event.type === 'complete') {
        const operation = event.operation || state.operation;
        state.failedPath = '';
        setScanning(false);
        state.currentId = 0;
        state.offset = 0;
        state.selected = null;
        $('search-input').value = '';
        await refreshState(true);
        toast(operation === 'load' ? '历史快照已打开。' : operation === 'recover' ? '快照恢复完成。' : state.snapshot?.status === 'cancelled' ? '已停止扫描，已读取的结果已保存。' : '扫描完成，空间地图已就绪。');
      } else if (event.type === 'error') {
        const stopped = (event.message || '').includes('已停止整理');
        state.failedPath = state.operation === 'scan' ? state.scanPath || event.path || $('path-input').value : '';
        setScanning(false);
        notice(`${event.message || '处理未完成，请重试。'}${state.snapshot ? ` 下方仍显示上一次 ${state.snapshot.rootPath} 的结果。` : ''}`, !stopped);
        $('footer-status').textContent = stopped ? '已停止整理，原始结果已保留' : state.operation === 'scan' ? '本次扫描未完成' : '快照读取未完成';
        // The raw result may still be recoverable after indexing failed or was stopped.
        void invoke('history').then(history => { state.history = history || []; renderHistory(); }).catch(() => {});
      }
    } catch (error) { notice(error.message, true); }
  }
  async function startScan(event) {
    event?.preventDefault();
    const path = $('path-input').value.trim();
    if (!path) { $('path-input').focus(); return; }
    if (state.scanning) return;
    $('notice').hidden = true;
    state.operation = 'scan'; state.stage = 'preparing'; state.stopRequested = false; state.scanPath = path; state.failedPath = '';
    setScanning(true);
    latestProgress = { stage: 'preparing', operation: 'scan', files: 0, dirs: 0, bytes: 0, elapsedMs: 0, currentPath: path };
    progressAt = Date.now();
    renderProgress(latestProgress);
    try { await invoke('scan', { path }); }
    catch (error) { state.failedPath = path; setScanning(false); throw error; }
  }
  async function chooseFolder(start = false) {
    const path = await withActivity('正在打开文件夹选择器…', () => invoke('chooseFolder'), $(start ? 'empty-choose' : 'choose-folder'), result => result ? '已选择文件夹' : '已取消选择');
    if (path) {
      $('path-input').value = path;
      $('drive-select').value = '';
      updateCapacity();
      if (start) await startScan();
    }
  }
  async function loadDrives() {
    try {
      const result = await invoke('drives');
      state.drives = Array.isArray(result) ? result : [result];
      const options = [new Option('选择硬盘', '')];
      for (const drive of state.drives) options.push(new Option(`${drive.path}${drive.label ? `  ${drive.label}` : ''}`, drive.path));
      $('drive-select').replaceChildren(...options);
    } catch (error) {
      $('drive-select').replaceChildren(new Option('输入路径或选择文件夹', ''));
      notice(`未能读取硬盘列表：${error.message}。仍可选择文件夹扫描。`);
    }
  }
  function updateCapacity() {
    const drive = state.drives.find(item => item.path === $('drive-select').value);
    $('drive-capacity').hidden = !drive;
    if (!drive) return;
    const used = Math.max(0, drive.total - drive.free);
    $('capacity-fill').style.width = `${drive.total ? Math.min(100, used / drive.total * 100) : 0}%`;
    $('capacity-text').textContent = `${bytes(drive.free)} 可用 / ${bytes(drive.total)} 总容量`;
  }
  function historyLabel(meta) { return `${dateTime(meta.startedAt)} · ${meta.rootPath}${meta.needsIndex ? ' · 待整理 · 可恢复' : meta.recovered ? ' · 已恢复' : ''}`; }
  function renderHistory() {
    $('history-select').replaceChildren(...(state.history.length ? state.history.map(meta => new Option(historyLabel(meta), meta.id)) : [new Option('暂无扫描记录', '')]));
    if (state.snapshot) $('history-select').value = state.snapshot.id;
    $('history-select').disabled = state.scanning || !state.history.length;
    const previousValue = $('compare-select').value;
    const root = (state.snapshot?.rootPath || '').replace(/[\\/]+$/, '').toLowerCase();
    const matches = state.history.filter(meta => meta.id !== state.snapshot?.id && meta.rootPath.replace(/[\\/]+$/, '').toLowerCase() === root);
    $('compare-select').replaceChildren(...(matches.length ? matches.map(meta => new Option(`${dateTime(meta.startedAt)} · ${bytes(meta.summary?.bytes)}${meta.status !== 'complete' && meta.status !== 'completed' ? ' · 部分结果' : ''}`, meta.id)) : [new Option('需要同一路径的历史扫描', '')]));
    if (matches.some(meta => meta.id === previousValue)) $('compare-select').value = previousValue;
    $('compare-button').disabled = !matches.length;
  }
  function renderSummary() {
    const meta = state.snapshot;
    $('snapshot-summary').hidden = !meta;
    $('export-button').disabled = !meta;
    $('empty-start').hidden = Boolean(meta) || state.tab === 'apps';
    $('explorer-content').hidden = !meta && state.tab !== 'apps';
    renderSnapshotContext();
    if (!meta) return;
    const s = meta.summary || {};
    setBigBytes('summary-bytes', s.bytes);
    $('summary-files').textContent = number(s.files);
    $('summary-dirs').textContent = number(s.dirs);
    $('summary-time').textContent = duration(s.elapsedMs);
    $('summary-date').textContent = dateTime(meta.finishedAt || meta.startedAt);
    const partial = meta.status === 'partial' || meta.status === 'cancelled';
    $('snapshot-status').textContent = meta.status === 'cancelled' ? '已停止 · 部分结果' : partial ? '扫描完成 · 部分结果' : '扫描完成';
    $('snapshot-status').classList.toggle('partial', partial);
    const errors = Number(s.errors || 0), skipped = Number(s.skipped || 0);
    $('scan-issues').hidden = !errors && !skipped && !partial;
    $('scan-issues').textContent = `${number(errors)} 项读取问题 · ${number(skipped)} 项跳过`;
    if ((partial || errors) && !state.failedPath && !$('notice').classList.contains('error')) notice(meta.status === 'cancelled' ? '这份快照是停止扫描时保留下来的部分结果，大小可能小于实际值。' : '部分项目未能读取，已显示的大小可能小于实际值。点击摘要中的“读取问题”查看原因。');
    if (!state.scanning) $('footer-status').textContent = `当前快照 · ${meta.rootPath}`;
  }
  async function refreshState(reset = false) {
    const request = ++state.stateRequest;
    const result = await invoke('state');
    if (request !== state.stateRequest) return;
    const changed = result.snapshot?.id !== state.snapshot?.id;
    state.snapshot = result.snapshot || null;
    state.history = result.history || [];
    state.operation = result.progress?.operation || (result.loading ? 'load' : state.operation);
    setScanning(Boolean(result.scanning || result.loading));
    if ((result.scanning || result.loading) && result.progress) await onProgress({ ...result.progress, type: 'progress' });
    if (changed || reset) { closeContext(); state.navigation++; state.selection++; state.request++; state.currentId = 0; state.offset = 0; state.selected = null; }
    renderSummary();
    renderHistory();
    if (state.snapshot) {
      if (!$('path-input').value || changed && !state.scanning && !state.failedPath) $('path-input').value = state.snapshot.rootPath;
      await loadChildren();
      if (state.tab === 'large') await loadLarge();
      if (state.tab === 'changes') { state.changes = []; renderChanges(); }
    } else renderDetail(null);
  }
  function renderBreadcrumbs() {
    const pieces = [];
    for (const [index, node] of state.ancestors.entries()) {
      if (index) pieces.push(element('span', '', '›'));
      const b = element('button', '', index === 0 ? (state.snapshot?.rootPath || node.name) : node.name);
      b.title = node.path || node.name;
      b.addEventListener('click', safe(() => navigate(node.id)));
      if (index === state.ancestors.length - 1) b.setAttribute('aria-current', 'location');
      pieces.push(b);
    }
    $('breadcrumbs').replaceChildren(...pieces);
    $('breadcrumbs').scrollLeft = $('breadcrumbs').scrollWidth;
    $('up-button').disabled = state.currentId === 0;
  }
  async function loadChildren() {
    if (!state.snapshot) return;
    const request = ++state.request;
    const snapshotId = state.snapshot.id;
    const activity = beginActivity('正在读取当前文件夹…', $('explorer-content'));
    let response;
    try { response = await invoke('children', { id: state.currentId, ...filters(), limit: PAGE, offset: state.offset }); }
    catch (error) { endActivity(activity, '文件夹读取失败'); throw error; }
    if (request !== state.request || snapshotId !== state.snapshot?.id) { endActivity(activity); return; }
    state.node = response.node;
    state.ancestors = response.ancestors || [];
    state.items = response.items || [];
    state.total = response.total || 0;
    state.filteredBytes = response.filteredBytes ?? state.items.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
    renderBreadcrumbs();
    $('folder-name').textContent = state.node.name || state.snapshot.rootPath;
    $('folder-name').title = state.node.path;
    $('folder-count').textContent = `${number(state.total)} 个项目 · ${bytes(state.filteredBytes)}`;
    $('filter-explainer').hidden = !Number($('older-select').value);
    if (!state.selected || !state.items.some(item => item.id === state.selected.id) && state.selected.id !== state.currentId) state.selected = state.node;
    else state.selected = state.items.find(item => item.id === state.selected.id) || state.node;
    renderDetail(state.selected);
    renderFileRows($('file-list'), state.items, state.filteredBytes);
    renderMapPagination();
    requestAnimationFrame(drawMap);
    endActivity(activity, `已显示 ${number(state.total)} 个项目`);
  }
  async function navigate(id) {
    if (!state.snapshot) return;
    closeContext();
    const request = ++state.navigation;
    const snapshotId = state.snapshot.id;
    const activity = beginActivity('正在进入文件夹…', $('explorer-content'));
    let node;
    try { node = await invoke('node', { id }); }
    catch (error) { endActivity(activity, '无法进入文件夹'); throw error; }
    if (request !== state.navigation || snapshotId !== state.snapshot?.id) { endActivity(activity); return; }
    if (!directory(node)) { selectNode(node); endActivity(activity, '已选中文件'); return; }
    state.currentId = Number(id);
    state.offset = 0;
    state.selected = null;
    state.selection++;
    $('search-input').value = '';
    $('category-select').value = 'all';
    $('older-select').value = '0';
    if (state.tab !== 'map') switchTab('map', false);
    try { await loadChildren(); if (request === state.navigation) feedback($('panel-map')); }
    finally { endActivity(activity, `已进入 ${node.name || node.path}`); }
  }
  function selectNode(node) {
    if (!node) return;
    state.selection++;
    state.selected = node;
    renderDetail(node);
    for (const row of document.querySelectorAll('.file-row[data-node-id]')) {
      const selected = row.dataset.nodeId === String(node.id);
      row.classList.toggle('selected', selected);
      row.querySelector('.row-select')?.setAttribute('aria-pressed', String(selected));
    }
    drawMap();
    feedback($('detail-content'));
    previewFolder(node);
    if (state.apps && !state.usageBusy) {
      const selection = state.selection, snapshotId = state.snapshot?.id;
      // Usage records may have arrived after these map tiles. Refresh only this
      // selection; never reset navigation or reselect an old asynchronous result.
      void invoke('node', { id: node.id }).then(fresh => {
        if (state.selection !== selection || state.snapshot?.id !== snapshotId || state.selected?.id !== node.id) return;
        state.selected = fresh;
        const index = state.items.findIndex(item => item.id === fresh.id);
        if (index >= 0) state.items[index] = fresh;
        renderDetail(fresh);
      }).catch(() => {});
    }
  }
  function renderDetail(node) {
    $('detail-empty').hidden = Boolean(node);
    $('detail-content').hidden = !node;
    $('selection-type').textContent = node ? labels[node.category] || (directory(node) ? '文件夹' : '文件') : '—';
    $('enter-folder').disabled = !directory(node) || node?.id === state.currentId;
    $('enter-folder').title = directory(node) && node.id !== state.currentId ? `进入 ${node.name}` : '请先选中一个子文件夹';
    if (!node) return;
    $('detail-name').textContent = node.name || node.path;
    $('detail-path').textContent = node.path;
    $('detail-path').title = node.path;
    setBigBytes('detail-bytes', node.bytes);
    const total = Number(state.node?.bytes || 0);
    $('detail-share').textContent = node.id === state.currentId ? '当前文件夹的累计文件大小' : total > 0 ? `占当前文件夹 ${Math.min(100, Number(node.bytes || 0) / total * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` : '文件逻辑大小';
    $('enter-selected').hidden = !directory(node) || node.id === state.currentId;
    $('open-hint').textContent = directory(node) ? '打开这个文件夹，在熟悉的位置整理文件。' : '打开所在文件夹，并选中这个文件。';
    $('detail-counts').hidden = !directory(node);
    $('detail-contents').textContent = `${number(node.files)} 个文件 · ${number(node.dirs)} 个文件夹`;
    $('detail-modified-label').textContent = directory(node) ? '内容最近修改' : '最后修改';
    $('detail-modified').textContent = dateTime(directory(node) ? node.latestModified || node.modified : node.modified);
    $('detail-modified').title = directory(node) ? `包括当前文件夹及已读取内容。目录自身的修改时间：${dateTime(node.modified)}` : '';
    $('detail-accessed').textContent = dateTime(node.accessed);
    const e = node.evidence || {};
    const observed = Boolean(e.lastRun);
    $('evidence-confidence').textContent = observed ? '有记录' : '未知';
    $('evidence-confidence').classList.toggle('reliable', observed);
    $('evidence-title').textContent = observed ? ageText(e.daysSince ?? daysSince(e.lastRun)) : state.usageBusy ? '正在读取使用线索…' : '没有可靠的使用记录';
    $('evidence-note').textContent = e.note || '没有记录不代表没使用。修改时间、访问时间都不能作为软件上次使用的结论。';
    $('evidence-source').textContent = sources[e.source] || e.source || '没有可用记录';
    $('evidence-date-row').hidden = !observed;
    $('evidence-date').textContent = dateTime(e.lastRun);
    $('detail-warning').hidden = !node.warning;
    $('detail-warning').textContent = node.warning || '';
  }
  async function openNode(id, target) {
    await withActivity('正在请求资源管理器打开位置…', () => invoke('open', { id }), target || $('open-selected'), '已发送打开请求');
    toast('已请求在资源管理器中打开。');
  }
  async function copyNode(id, target) {
    await withActivity('正在复制完整路径…', () => invoke('copy', { id }), target || $('copy-path'), '完整路径已复制');
    toast('完整路径已复制。');
  }
  function closeContext(restore = false) {
    const previous = state.context;
    state.context = null;
    $('context-menu').hidden = true;
    if (restore && previous?.trigger?.isConnected) previous.trigger.focus();
  }
  function showContext(node, x, y, trigger) {
    if (!node || node.aggregate || !state.snapshot) return;
    selectNode(node);
    state.context = { node, snapshotId: state.snapshot.id, trigger };
    $('map-tooltip').hidden = true;
    $('context-title').textContent = node.name || node.path;
    $('context-title').title = node.path;
    $('context-enter').disabled = !directory(node) || node.id === state.currentId;
    $('context-enter').hidden = !directory(node);
    const menu = $('context-menu');
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.style.transformOrigin = x > window.innerWidth - menu.offsetWidth - 8 ? 'top right' : 'top left';
    $('context-open').focus({ preventScroll: true });
  }
  function contextFromKeyboard(event, node, trigger) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false;
    event.preventDefault();
    const box = trigger.getBoundingClientRect();
    const rect = trigger === $('treemap') ? state.rects.find(item => item.node.id === node?.id) : null;
    showContext(node, rect ? box.left + rect.x + Math.min(30, rect.w / 2) : box.left + 28, rect ? box.top + rect.y + Math.min(30, rect.h / 2) : box.top + Math.min(36, box.height), trigger);
    return true;
  }
  async function contextAction(action) {
    const context = state.context;
    if (!context || context.snapshotId !== state.snapshot?.id) { closeContext(); return; }
    const { node } = context;
    closeContext(true);
    if (action === 'open') await openNode(node.id, context.trigger);
    if (action === 'enter' && directory(node)) await navigate(node.id);
    if (action === 'copy') await copyNode(node.id, context.trigger);
  }
  function renderFileRows(container, items, total) {
    if (!items.length) { empty(container, '没有符合筛选的文件。试试清除搜索或修改筛选条件。'); return; }
    const fragment = document.createDocumentFragment();
    for (const node of items) {
      const row = element('div', 'file-row');
      row.dataset.nodeId = node.id;
      row.classList.toggle('selected', state.selected?.id === node.id);
      const select = element('button', 'row-select');
      select.setAttribute('aria-pressed', String(state.selected?.id === node.id));
      select.setAttribute('aria-haspopup', 'menu');
      select.setAttribute('aria-label', `查看${node.name}的详情，大小 ${bytes(node.bytes)}`);
      const main = element('span', 'row-main');
      const name = element('span', 'row-name', node.name);
      name.title = node.path;
      const lastModified = directory(node) ? node.latestModified || node.modified : node.modified;
      main.append(name, element('span', 'row-sub', state.tab === 'large' ? node.path : `${directory(node) ? `${number(node.files)} 个文件` : labels[node.category] || '文件'} · ${lastModified ? `${dateTime(lastModified)} ${directory(node) ? '内容修改' : '修改'}` : '修改时间未知'}`));
      const size = element('span', 'row-size', bytes(node.bytes));
      const meter = element('span', 'row-meter');
      const fill = element('i');
      fill.style.width = `${total > 0 ? Math.max(0, Math.min(100, node.bytes / total * 100)) : 0}%`;
      fill.style.backgroundColor = palette[node.category] || palette.other;
      meter.append(fill);
      size.append(meter);
      select.append(icon(directory(node) ? 'folder' : 'file'), main, size);
      select.addEventListener('click', () => selectNode(node));
      select.addEventListener('dblclick', safe(() => directory(node) ? navigate(node.id) : openNode(node.id)));
      select.addEventListener('keydown', safe(async event => {
        if (contextFromKeyboard(event, node, select)) return;
        if (event.key === 'Enter' && directory(node)) { event.preventDefault(); await navigate(node.id); }
      }));
      row.addEventListener('contextmenu', event => { event.preventDefault(); showContext(node, event.clientX, event.clientY, select); });
      const open = element('button', 'icon-button');
      open.append(icon('open'));
      open.title = `在资源管理器中打开 ${node.name}`;
      open.setAttribute('aria-label', open.title);
      open.addEventListener('click', safe(() => openNode(node.id, open)));
      row.append(select);
      if (directory(node)) {
        const enter = element('button', 'button compact row-enter', '进入');
        enter.setAttribute('aria-label', `进入文件夹 ${node.name}`);
        enter.addEventListener('click', safe(() => navigate(node.id)));
        row.append(enter);
      }
      row.append(open);
      fragment.append(row);
    }
    container.replaceChildren(fragment);
  }
  function renderMapPagination() {
    const end = Math.min(state.total, state.offset + state.items.length);
    const zero = state.items.filter(node => !node.bytes).length;
    const caption = state.total ? `第 ${number(state.offset + 1)}–${number(end)} 项，共 ${number(state.total)} 项` : '0 个项目';
    $('page-caption').textContent = caption + (zero ? ` · 本页 ${zero} 项为 0 B，可在列表中查看` : '') + (state.total > PAGE && state.mode === 'map' ? ' · 灰色块汇总本页以外的空间' : '');
    $('page-prev').disabled = state.offset === 0;
    $('page-next').disabled = end >= state.total;
    $('page-prev').hidden = $('page-next').hidden = state.total <= PAGE;
  }
  function setMode(mode) {
    state.mode = mode;
    for (const key of ['map', 'list']) {
      $(`mode-${key}`).classList.toggle('active', mode === key);
      $(`mode-${key}`).setAttribute('aria-pressed', String(mode === key));
    }
    $('treemap-wrap').hidden = mode !== 'map';
    $('map-help').hidden = mode !== 'map';
    $('file-list').hidden = mode !== 'list';
    renderMapPagination();
    if (mode === 'map') requestAnimationFrame(drawMap);
  }

  function squarify(items, width, height) {
    const result = [];
    const sum = items.reduce((s, item) => s + item.weight, 0);
    if (!sum || !width || !height) return result;
    const list = items.map(item => ({ ...item, area: item.weight / sum * width * height }));
    let box = { x: 0, y: 0, w: width, h: height };
    let row = [];
    function worst(values, side) {
      if (!values.length || side <= 0) return Infinity;
      const areas = values.map(item => item.area), s = areas.reduce((a, b) => a + b, 0);
      return Math.max(side * side * Math.max(...areas) / (s * s), s * s / (side * side * Math.min(...areas)));
    }
    function layout() {
      if (!row.length) return;
      const s = row.reduce((total, item) => total + item.area, 0);
      if (box.w >= box.h) {
        const w = s / box.h;
        let y = box.y;
        for (const item of row) { const h = item.area / w; result.push({ node: item.node, x: box.x, y, w, h }); y += h; }
        box = { x: box.x + w, y: box.y, w: Math.max(0, box.w - w), h: box.h };
      } else {
        const h = s / box.w;
        let x = box.x;
        for (const item of row) { const w = item.area / h; result.push({ node: item.node, x, y: box.y, w, h }); x += w; }
        box = { x: box.x, y: box.y + h, w: box.w, h: Math.max(0, box.h - h) };
      }
      row = [];
    }
    for (const item of list) {
      const side = Math.min(box.w, box.h);
      if (row.length && worst([...row, item], side) > worst(row, side)) layout();
      row.push(item);
    }
    layout();
    return result;
  }
  function clippedText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let low = 0, high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) low = mid; else high = mid - 1;
    }
    return text.slice(0, low) + '…';
  }
  function previewFolder(node) {
    if (!directory(node) || node.id === state.currentId || !state.items.some(item => item.id === node.id)) { folderPreview = null; return; }
    const key = `${state.snapshot?.id}:${node.id}`;
    if (folderPreview?.key === key) return;
    folderPreview = {key, id:node.id, loading:true};
    drawMap();
    const request = previewCache.has(key) ? Promise.resolve(previewCache.get(key)) : invoke('children',{id:node.id,limit:80});
    void request.then(result => {
      if (folderPreview?.key !== key || state.selected?.id !== node.id || !key.startsWith(state.snapshot?.id + ':')) return;
      previewCache.set(key,result);if(previewCache.size>24)previewCache.delete(previewCache.keys().next().value);
      folderPreview = {key,id:node.id,result,at:performance.now()};drawMap();
    }).catch(error => { if(folderPreview?.key===key){folderPreview={key,id:node.id,error:error.message};drawMap();} });
  }
  function paintFolderPreview(ctx, rect) {
    const preview=folderPreview;
    const canvas=$('treemap');canvas.dataset.previewId='';canvas.dataset.previewCount='0';
    if(!preview||preview.id!==rect.node.id||!preview.key.startsWith(state.snapshot?.id+':'))return;
    const x=rect.x+10,y=rect.y+86,w=rect.w-20,h=rect.h-126;
    if(w<100||h<35)return;
    ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
    ctx.fillStyle='rgba(8,18,25,.68)';ctx.fillRect(x,y,w,h);
    if(!preview.result){ctx.fillStyle='#cce5e9';ctx.font='13px "Segoe UI","Microsoft YaHei UI"';ctx.textBaseline='top';ctx.fillText(clippedText(ctx,preview.error?'预览读取失败，双击进入重试':'正在透视文件夹…',w-16),x+8,y+10);ctx.restore();return;}
    const data=preview.result;const items=data.items.filter(n=>n.bytes>0).map(node=>({node,weight:node.bytes}));
    const remainder=Math.max(0,data.filteredBytes-items.reduce((s,i)=>s+i.weight,0));
    if(remainder)items.push({node:{name:'其余项目',category:'other',bytes:remainder},weight:remainder});
    const animation=matchMedia('(prefers-reduced-motion: reduce)').matches||document.body.classList.contains('keyboard-input')?1:Math.min(1,(performance.now()-preview.at)/160);
    ctx.globalAlpha=.48+.4*animation;
    const tiles=squarify(items,w,h);
    for(const tile of tiles){
      const tx=x+tile.x+2,ty=y+tile.y+2,tw=Math.max(0,tile.w-4),th=Math.max(0,tile.h-4);
      ctx.fillStyle=palette[tile.node.category]||palette.other;ctx.fillRect(tx,ty,tw,th);
      ctx.strokeStyle='rgba(151,238,224,.65)';ctx.lineWidth=1;ctx.strokeRect(tx+.5,ty+.5,Math.max(0,tw-1),Math.max(0,th-1));
      if(tw>48&&th>26){ctx.save();ctx.beginPath();ctx.rect(tx+5,ty+4,Math.max(0,tw-10),Math.max(0,th-8));ctx.clip();ctx.globalAlpha=1;ctx.fillStyle='#ecffff';ctx.font='600 12px "Segoe UI","Microsoft YaHei UI"';ctx.textBaseline='top';ctx.fillText(clippedText(ctx,tile.node.name,tw-12),tx+6,ty+6);if(th>48){ctx.font='13px "Segoe UI"';ctx.fillText(clippedText(ctx,bytes(tile.node.bytes),tw-12),tx+6,ty+26);}ctx.restore();}
    }
    if(!tiles.length){ctx.globalAlpha=1;ctx.fillStyle='#cce5e9';ctx.font='13px "Segoe UI"';ctx.fillText('空文件夹或仅有零字节文件',x+8,y+18);}
    ctx.restore();
    canvas.dataset.previewId=String(preview.id);canvas.dataset.previewCount=String(data.total);
    if(animation<1)requestAnimationFrame(drawMap);
  }
  function drawMap() {
    if (state.mode !== 'map' || state.tab !== 'map' || !state.snapshot || $('treemap-wrap').hidden) return;
    const canvas = $('treemap');
    canvas.dataset.previewId='';canvas.dataset.previewCount='0';
    const box = canvas.getBoundingClientRect();
    const w = box.width, h = box.height;
    if (w < 1 || h < 1) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, w, h);
    const items = state.items.filter(node => Number(node.bytes) > 0).map(node => ({ node, weight: Number(node.bytes) }));
    const pageBytes = items.reduce((sum, item) => sum + item.weight, 0);
    const remainder = Math.max(0, state.filteredBytes - pageBytes);
    if (remainder > 0) items.push({ node: { id: '__rest', name: '本页以外的项目', bytes: remainder, category: 'other', aggregate: true }, weight: remainder });
    items.sort((a, b) => b.weight - a.weight);
    state.rects = squarify(items, w, h);
    $('map-empty').hidden = state.rects.length > 0;
    $('map-empty').textContent = state.total ? '这些项目的大小都是 0 B。切换到“列表”即可选择并打开。' : '这里没有符合筛选的项目。清除筛选，或返回上一级。';
    for (const rect of state.rects) {
      const node = rect.node;
      const x = rect.x + 2, y = rect.y + 2, rw = Math.max(0, rect.w - 4), rh = Math.max(0, rect.h - 4);
      if (rw < .5 || rh < .5) continue;
      ctx.fillStyle = node.aggregate ? '#303943' : palette[node.category] || palette.other;
      ctx.beginPath();
      ctx.roundRect(x, y, rw, rh, Math.min(5, rw / 4, rh / 4));
      ctx.fill();
      if (state.hoverId === node.id) {
        ctx.strokeStyle = '#a6ccd7';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (rw < 35 || rh < 22) continue;
      ctx.save();
      ctx.beginPath(); ctx.rect(x + 4, y + 4, rw - 8, rh - 8); ctx.clip();
      const pad = rw >= 110 ? 13 : 7;
      const large = rw >= 160 && rh >= 115;
      const normal = rw >= 100 && rh >= 65;
      ctx.fillStyle = node.aggregate ? '#b5c4cf' : '#edf5fa';
      ctx.textBaseline = 'top';
      ctx.font = `${large ? 600 : 500} ${large ? 16 : 12}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(clippedText(ctx, node.name, rw - pad * 2), x + pad, y + (normal ? 13 : 7));
      if (normal) {
        ctx.font = `${large ? 500 : 400} ${large ? 29 : 18}px "Segoe UI", sans-serif`;
        ctx.fillText(clippedText(ctx, bytes(node.bytes), rw - pad * 2), x + pad, y + (large ? 43 : 35));
      }
      if (large && rh > 135) {
        ctx.fillStyle = '#b4c9d8';
        ctx.font = '12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        const caption = node.aggregate ? '翻页查看具体项目' : directory(node) ? `${number(node.files)} 个文件 · 双击进入` : labels[node.category] || '文件';
        ctx.fillText(clippedText(ctx, caption, rw - pad * 2), x + pad, y + rh - 25);
      }
      ctx.restore();
    }
    // Paint selection last so tiny neighboring tiles can never cover its outline.
    const selectedRect = state.rects.find(rect => rect.node.id === state.selected?.id);
    if (selectedRect) {
      paintFolderPreview(ctx,selectedRect);
      const x = selectedRect.x + 3.5, y = selectedRect.y + 3.5;
      const width = Math.max(1, selectedRect.w - 7), height = Math.max(1, selectedRect.h - 7);
      ctx.save();
      ctx.strokeStyle = '#60eadb'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(x, y, width, height, Math.min(5, width / 4, height / 4)); ctx.stroke();
      if (width > 86 && height > 52) {
        const bx = x + width - 75, by = y + height - 31;
        ctx.fillStyle = '#60eadb';
        ctx.beginPath(); ctx.roundRect(bx, by, 67, 23, 4); ctx.fill();
        ctx.fillStyle = '#102c30'; ctx.font = '600 12px "Segoe UI", "Microsoft YaHei UI", sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillText(folderPreview?.id===selectedRect.node.id?'✓ 透视中':'✓ 已选中', bx + 8, by + 12);
      }
      ctx.restore();
    }
    canvas.dataset.selectedId = state.selected?.id ?? '';
    canvas.setAttribute('aria-label', `空间地图：当前显示 ${state.items.length} 个项目${state.selected ? `。已选中 ${state.selected.name}，${bytes(state.selected.bytes)}` : ''}。方向键选择，Enter 进入文件夹。可切换列表逐项浏览。`);
  }
  function hitTest(event) {
    const bounds = $('treemap').getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    return state.rects.find(rect => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h);
  }
  async function loadLarge() {
    if (!state.snapshot) return;
    const request = ++state.largeRequest;
    const snapshotId = state.snapshot.id;
    loading($('large-list'), '正在按大小排列全部文件…');
    const result = await withActivity('正在读取最大的文件…', () => invoke('top', { ...filters(), limit: 1000 }), $('large-list'), '大文件列表已更新');
    if (request !== state.largeRequest || snapshotId !== state.snapshot?.id) return;
    state.largeItems = result.items || [];
    state.largeTotal = result.total || 0;
    state.largePage = 0;
    renderLarge();
  }
  function renderLarge() {
    const items = state.largeItems.slice(state.largePage * PAGE, (state.largePage + 1) * PAGE);
    $('large-caption').textContent = `覆盖本次扫描的全部文件夹，按大小排列${state.largeTotal > 1000 ? '，仅展示最大的 1,000 个匹配文件' : ''}。`;
    renderFileRows($('large-list'), items, state.largeItems[0]?.bytes || 0);
    pagination('large', state.largePage, state.largeItems.length);
  }
  function pagination(prefix, page, count) {
    $(`${prefix}-page-caption`).textContent = count ? `第 ${number(page * PAGE + 1)}–${number(Math.min(count, (page + 1) * PAGE))} 项，共 ${number(count)} 项` : '0 个项目';
    $(`${prefix}-prev`).disabled = page === 0;
    $(`${prefix}-next`).disabled = (page + 1) * PAGE >= count;
    $(`${prefix}-prev`).hidden = $(`${prefix}-next`).hidden = count <= PAGE;
  }
  async function refreshUsage(refresh = false) {
    if (state.usageBusy) return;
    state.usageBusy = true;
    const activity = beginActivity('正在读取 Windows 软件启动线索…', $('refresh-usage'));
    let activityResult = '软件使用线索已更新';
    $('refresh-usage').disabled = true;
    $('refresh-usage').textContent = '正在读取…';
    if (!state.apps) loading($('apps-list'));
    if (state.selected) renderDetail(state.selected);
    try {
      const data = await invoke('usage', refresh ? { refresh: true } : undefined);
      state.apps = Array.isArray(data.apps) ? data.apps : [];
      state.appPage = 0;
      $('usage-warnings').hidden = !data.warnings?.length;
      $('usage-warnings').textContent = (data.warnings || []).join(' ');
      renderApps();
      if (state.snapshot && state.selected) {
        const selectedId = state.selected?.id;
        const snapshotId = state.snapshot.id;
        const selection = state.selection;
        const navigation = state.navigation;
        try {
          const node = await invoke('node', { id: selectedId });
          if (state.snapshot?.id === snapshotId && state.selection === selection && state.navigation === navigation && state.selected?.id === selectedId) {
            state.selected = node; renderDetail(node);
          }
        } catch { /* A new snapshot may replace this optional detail lookup. */ }
      }
    } catch (error) {
      activityResult = '软件使用线索读取未完成，空间扫描仍可使用';
      $('usage-warnings').textContent = `暂时无法读取使用线索：${error.message}。没有记录不能判断未使用。`;
      $('usage-warnings').hidden = false;
      if (!state.apps) empty($('apps-list'), '没有读取到软件使用线索。空间扫描仍可正常使用。');
    } finally {
      state.usageBusy = false;
      endActivity(activity, activityResult);
      $('refresh-usage').disabled = false;
      $('refresh-usage').textContent = '重新读取';
      if (state.selected) renderDetail(state.selected);
    }
  }
  function renderApps() {
    if (!state.apps) return;
    const search = $('app-search').value.trim().toLocaleLowerCase();
    const age = $('app-age').value;
    const filtered = state.apps.filter(app => {
      if (search && !app.name.toLocaleLowerCase().includes(search)) return false;
      const days = daysSince(app.lastRun);
      return age === 'all' || age === 'unknown' && days === null || Number(age) > 0 && days !== null && days >= Number(age);
    }).sort((a, b) => {
      const ad = daysSince(a.lastRun), bd = daysSince(b.lastRun);
      return (bd === null ? -1 : bd) - (ad === null ? -1 : ad) || a.name.localeCompare(b.name, 'zh-CN');
    });
    if (state.appPage * PAGE >= filtered.length) state.appPage = 0;
    const fragment = document.createDocumentFragment();
    for (const app of filtered.slice(state.appPage * PAGE, (state.appPage + 1) * PAGE)) {
      const row = element('div', 'app-row');
      const main = element('div');
      const title = element('div', 'app-name', app.name);
      const source = element('div', 'app-source', app.lastRun ? sources[app.source] || app.source : '无记录不代表未使用');
      source.title = app.note || '';
      main.append(title, source);
      const age = element('div', `app-last-run${app.lastRun ? '' : ' unknown'}`, app.lastRun ? daysSince(app.lastRun) === 0 ? '今天' : `${number(daysSince(app.lastRun))} 天前` : '使用时间未知');
      if (app.lastRun) age.append(element('small', '', dateTime(app.lastRun)));
      const open = element('button', 'icon-button');
      open.append(icon('open'));
      const path = app.installLocation || app.executable;
      open.disabled = !path;
      open.title = path ? `在资源管理器中打开 ${path}` : '系统未提供可靠的安装路径';
      open.setAttribute('aria-label', path ? `在资源管理器中打开 ${app.name}` : `${app.name} 没有可靠的安装路径`);
      open.addEventListener('click', safe(async () => { await withActivity('正在请求资源管理器打开软件位置…', () => invoke('openPath', { path }), open, '已发送打开请求'); toast('已请求在资源管理器中打开。'); }));
      row.append(main, age, open);
      fragment.append(row);
    }
    if (filtered.length) $('apps-list').replaceChildren(fragment);
    else empty($('apps-list'), state.apps.length ? '没有符合条件的软件。可以清除搜索，或查看“没有可靠记录”。' : '没有可用的软件记录。Windows 可能未保留记录，空间扫描仍可正常使用。');
    pagination('apps', state.appPage, filtered.length);
  }
  async function compareSnapshots() {
    const id = $('compare-select').value;
    if (!id) return;
    const snapshotId = state.snapshot?.id;
    $('compare-button').disabled = true;
    loading($('changes-list'));
    try {
      const result = await withActivity('正在对比两次扫描的大小变化…', () => invoke('compare', { id }), $('compare-button'), '空间对比已完成');
      if (snapshotId !== state.snapshot?.id || id !== $('compare-select').value) return;
      state.changes = result.items || [];
      state.changesPage = 0;
      const partial = ['partial', 'cancelled'].includes(result.before?.status) || ['partial', 'cancelled'].includes(result.after?.status);
      $('compare-note').textContent = `${dateTime(result.before?.startedAt)} → ${dateTime(result.after?.startedAt)}。${result.note || '比较根目录下一层的累计大小。'}${partial ? ' 此次对比包含部分扫描，差值不代表实际增减。' : ''}`;
      renderChanges();
    } finally { $('compare-button').disabled = false; }
  }
  function renderChanges() {
    if (!state.changes.length) {
      empty($('changes-list'), '选择一份同路径的历史快照，查看各文件夹的变化。');
      $('changes-pagination').hidden = true;
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of state.changes.slice(state.changesPage * PAGE, (state.changesPage + 1) * PAGE)) {
      const row = element('div', 'change-row');
      const main = element('div');
      const name = element('div', 'change-name', item.name || item.path.split(/[\\/]/).pop());
      name.title = item.path;
      main.append(name, element('div', 'change-sizes', `${bytes(item.before)} → ${bytes(item.after)}`));
      const delta = element('div', `change-delta ${item.delta > 0 ? 'growth' : item.delta < 0 ? 'shrink' : ''}`, `${item.delta > 0 ? '+' : item.delta < 0 ? '−' : ''}${bytes(Math.abs(item.delta))}`);
      const open = element('button', 'icon-button');
      open.append(icon('open'));
      open.disabled = item.id === null || item.id === undefined;
      open.title = open.disabled ? '当前快照中已没有这个项目' : '在资源管理器中打开';
      open.setAttribute('aria-label', `${open.title} ${item.name || item.path}`);
      open.addEventListener('click', safe(() => openNode(item.id, open)));
      row.append(main, delta, open);
      fragment.append(row);
    }
    $('changes-list').replaceChildren(fragment);
    $('changes-pagination').hidden = false;
    pagination('changes', state.changesPage, state.changes.length);
  }
  async function switchTab(tab, load = true) {
    closeContext();
    state.tab = tab;
    for (const key of ['map', 'large', 'apps', 'changes']) {
      $(`tab-${key}`).classList.toggle('active', tab === key);
      $(`tab-${key}`).setAttribute('aria-selected', String(tab === key));
      $(`tab-${key}`).tabIndex = tab === key ? 0 : -1;
      $(`panel-${key}`).hidden = key !== tab;
    }
    $('filter-bar').hidden = tab === 'apps' || tab === 'changes';
    $('filter-explainer').hidden = tab === 'apps' || tab === 'changes' || !Number($('older-select').value);
    document.querySelector('.location-bar').hidden = tab === 'apps' || !state.snapshot;
    $('search-input').placeholder = tab === 'large' ? '搜索全部文件名称' : '搜索当前层的名称';
    renderSummary();
    feedback($(`panel-${tab}`));
    if (!load) return;
    if (tab === 'map' && state.snapshot) await loadChildren();
    if (tab === 'large' && state.snapshot) await loadLarge();
    if (tab === 'apps') { if (!state.apps && !state.usageBusy) await refreshUsage(); else renderApps(); }
    if (tab === 'changes') renderChanges();
  }
  async function showIssues() {
    const result = await withActivity('正在读取跳过项目和错误详情…', () => invoke('errors'), $('scan-issues'), '读取问题详情已就绪');
    const s = result.summary || {};
    $('issues-summary').textContent = `${number(s.errors)} 项读取问题，${number(s.skipped)} 项跳过。${state.snapshot?.status === 'cancelled' ? '扫描已停止，部分文件夹尚未读取。' : ''}${result.items?.length > 200 ? '此处展示前 200 条详情。' : ''}`;
    const rows = (result.items || []).slice(0, 200).map(item => {
      const row = element('div', 'issue-row');
      if (typeof item === 'string') row.textContent = item;
      else row.append(element('strong', '', item.path || item.name || '未知路径'), element('span', '', item.message || item.reason || item.error || JSON.stringify(item)));
      return row;
    });
    if (rows.length) $('issues-list').replaceChildren(...rows);
    else empty($('issues-list'), '没有单独记录的错误详情。跳过的联接、链接与未完成项目不会重复扫描。');
    $('issues-dialog').showModal();
  }

  $('scan-form').addEventListener('submit', safe(startScan));
  $('choose-folder').addEventListener('click', safe(() => chooseFolder(false)));
  $('empty-choose').addEventListener('click', safe(() => chooseFolder(true)));
  $('drive-select').addEventListener('change', () => { if ($('drive-select').value) $('path-input').value = $('drive-select').value; updateCapacity(); });
  $('path-input').addEventListener('input', () => { if ($('path-input').value !== $('drive-select').value) { $('drive-select').value = ''; updateCapacity(); } });
  $('cancel-button').addEventListener('click', safe(async () => {
    state.stopRequested = true;
    $('cancel-button').disabled = true;
    $('cancel-button').textContent = '正在停止…';
    $('progress-title').textContent = state.stage === 'scanning' ? '正在停止，随后保存已读取的结果' : '正在停止整理，原始结果将保留';
    try { await withActivity('已请求停止，正在等待当前处理结束…', () => invoke('cancel'), $('cancel-button'), '停止请求已发送'); }
    catch (error) { state.stopRequested = false; if (latestProgress) renderProgress(latestProgress); throw error; }
  }));
  $('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
  $('home-link').addEventListener('click', safe(async event => { event.preventDefault(); if (state.snapshot) await navigate(0); }));
  $('up-button').addEventListener('click', safe(async () => { if (state.node?.parent !== null && state.node?.parent !== undefined) await navigate(state.node.parent); }));
  $('open-current').addEventListener('click', safe(() => openNode(state.currentId, $('open-current'))));
  $('open-selected').addEventListener('click', safe(() => state.selected && openNode(state.selected.id)));
  $('enter-selected').addEventListener('click', safe(() => state.selected && navigate(state.selected.id)));
  $('enter-folder').addEventListener('click', safe(() => state.selected && directory(state.selected) && navigate(state.selected.id)));
  $('copy-path').addEventListener('click', safe(() => state.selected && copyNode(state.selected.id)));
  $('export-button').addEventListener('click', safe(async () => { const result = await withActivity('正在选择导出位置并写入快照…', () => invoke('export'), $('export-button'), result => result?.path ? '快照已导出' : '已取消导出'); if (result?.path) toast(`快照已导出：${result.path}`); }));
  $('history-select').addEventListener('change', safe(async () => {
    const id = $('history-select').value;
    if (!id || id === state.snapshot?.id) return;
    state.operation = 'load'; state.stage = 'preparing'; state.stopRequested = false; state.failedPath = '';
    closeContext(); setScanning(true);
    renderProgress({ stage: 'preparing', operation: 'load', message: '正在读取历史快照' });
    try {
      await withActivity('正在打开历史快照…', () => invoke('load', { id }), $('history-select'), '历史快照已打开');
      $('notice').hidden = true; await refreshState(true); toast('已打开历史快照。文件内容可能已发生变化。');
    }
    catch (error) {
      setScanning(false); $('history-select').value = state.snapshot?.id || '';
      if (error.message?.includes('已停止整理')) notice('已停止整理；原始结果已保留，可从历史记录重新打开。', false);
      else throw error;
    }
  }));
  $('scan-issues').addEventListener('click', safe(showIssues));
  const filterChanged = async () => {
    closeContext();
    state.offset = 0;
    $('filter-explainer').hidden = !Number($('older-select').value);
    if (state.tab === 'large') await loadLarge(); else await loadChildren();
  };
  let filterActivity;
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (filterActivity) endActivity(filterActivity);
    filterActivity = beginActivity('正在筛选名称…', $('search-input'));
    const token = filterActivity;
    searchTimer = setTimeout(async () => {
      try { await filterChanged(); endActivity(token, '名称筛选已更新'); }
      catch (error) { endActivity(token, '名称筛选未完成'); notice(error.message, true); }
      finally { if (filterActivity === token) filterActivity = null; }
    }, 180);
  });
  $('category-select').addEventListener('change', safe(filterChanged));
  $('older-select').addEventListener('change', safe(filterChanged));
  for (const key of ['map', 'large', 'apps', 'changes']) $(`tab-${key}`).addEventListener('click', safe(() => switchTab(key)));
  document.querySelector('.view-tabs').addEventListener('keydown', safe(async event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const keys = ['map', 'large', 'apps', 'changes'];
    let index = keys.indexOf(state.tab);
    index = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
    await switchTab(keys[index]);
    $(`tab-${keys[index]}`).focus();
  }));
  $('mode-map').addEventListener('click', () => setMode('map'));
  $('mode-list').addEventListener('click', () => setMode('list'));
  $('page-prev').addEventListener('click', safe(async () => { state.offset = Math.max(0, state.offset - PAGE); await loadChildren(); }));
  $('page-next').addEventListener('click', safe(async () => { state.offset += PAGE; await loadChildren(); }));
  for (const [prefix, pageKey, render] of [['large', 'largePage', renderLarge], ['apps', 'appPage', renderApps], ['changes', 'changesPage', renderChanges]]) {
    $(`${prefix}-prev`).addEventListener('click', () => { state[pageKey] = Math.max(0, state[pageKey] - 1); render(); });
    $(`${prefix}-next`).addEventListener('click', () => { state[pageKey]++; render(); });
  }
  $('refresh-usage').addEventListener('click', safe(() => refreshUsage(true)));
  $('app-search').addEventListener('input', () => { state.appPage = 0; renderApps(); });
  $('app-age').addEventListener('change', () => { state.appPage = 0; renderApps(); });
  $('compare-button').addEventListener('click', safe(compareSnapshots));
  $('treemap').addEventListener('click', event => { const rect = hitTest(event); if (rect && !rect.node.aggregate) selectNode(rect.node); });
  $('treemap').addEventListener('dblclick', safe(async event => { const rect = hitTest(event); if (rect && !rect.node.aggregate) { if (directory(rect.node)) await navigate(rect.node.id); else await openNode(rect.node.id, $('treemap')); } }));
  $('treemap').addEventListener('contextmenu', event => { event.preventDefault(); const rect = hitTest(event); if (rect && !rect.node.aggregate) showContext(rect.node, event.clientX, event.clientY, $('treemap')); else closeContext(); });
  $('treemap').addEventListener('mousemove', event => {
    if (state.context) return;
    const rect = hitTest(event);
    const node = rect?.node;
    if (state.hoverId !== (node?.id ?? null)) { state.hoverId = node?.id ?? null; drawMap(); }
    $('treemap').style.cursor = node && !node.aggregate ? 'pointer' : 'default';
    const tooltip = $('map-tooltip');
    tooltip.hidden = !node;
    if (!node) return;
    tooltip.replaceChildren(element('strong', '', node.name), document.createTextNode(`${bytes(node.bytes)}${node.aggregate ? ' · 翻页查看' : directory(node) ? ' · 双击进入' : ''}`));
    const box = $('treemap').getBoundingClientRect();
    tooltip.style.left = `${Math.max(6, Math.min(box.width - tooltip.offsetWidth - 8, event.clientX - box.left + 14))}px`;
    tooltip.style.top = `${Math.max(6, Math.min(box.height - tooltip.offsetHeight - 8, event.clientY - box.top + 14))}px`;
  });
  $('treemap').addEventListener('mouseleave', () => { state.hoverId = null; $('map-tooltip').hidden = true; drawMap(); });
  $('treemap').addEventListener('keydown', safe(async event => {
    if (contextFromKeyboard(event, state.selected, $('treemap'))) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const nodes = state.rects.filter(rect => !rect.node.aggregate).map(rect => rect.node);
      if (!nodes.length) return;
      const current = nodes.findIndex(node => node.id === state.selected?.id);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : Math.max(0, Math.min(nodes.length - 1, current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)));
      selectNode(nodes[index]);
    } else if (event.key === 'Enter' && state.selected) {
      event.preventDefault();
      if (directory(state.selected)) await navigate(state.selected.id); else await openNode(state.selected.id);
    } else if (event.key === 'Backspace' && state.currentId !== 0) {
      event.preventDefault(); await navigate(state.node.parent);
    }
  }));
  for (const action of ['open', 'enter', 'copy']) $(`context-${action}`).addEventListener('click', safe(() => contextAction(action)));
  $('context-menu').addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeContext(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...$('context-menu').querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled && !item.hidden);
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  });
  document.addEventListener('pointerdown', event => {
    document.body.classList.remove('keyboard-input');
    if (state.context && !$('context-menu').contains(event.target)) closeContext();
  }, true);
  document.addEventListener('keydown', safe(async event => {
    document.body.classList.add('keyboard-input');
    if (event.key === 'Escape' && state.context) { event.preventDefault(); closeContext(true); return; }
    if (event.altKey && event.key === 'ArrowUp' && state.snapshot && state.node?.parent !== null && state.node?.parent !== undefined && !$('issues-dialog').open) { event.preventDefault(); await navigate(state.node.parent); }
  }), true);
  document.addEventListener('scroll', () => closeContext(), true);
  window.addEventListener('blur', () => closeContext());
  new ResizeObserver(() => requestAnimationFrame(drawMap)).observe($('treemap-wrap'));
  window.addEventListener('resize', () => { closeContext(); requestAnimationFrame(drawMap); });

  async function boot() {
    // Category keys match the native scanner; no guessed file-type filtering.
    const software = $('category-select').querySelector('option[value="software"]');
    if (software) software.value = 'application';
    const codeOption = new Option('代码', 'code');
    $('category-select').insertBefore(codeOption, $('category-select').lastElementChild);
    const codeLegend = element('span');
    const dot = element('i'); dot.style.background = palette.code;
    codeLegend.append(dot, document.createTextNode('代码'));
    document.querySelector('.category-legend').insertBefore(codeLegend, document.querySelector('.category-legend').lastElementChild);
    for (const tab of ['large', 'apps', 'changes']) $(`tab-${tab}`).tabIndex = -1;
    if (!api) {
      $('connection-state').textContent = '未连接扫描引擎';
      notice('请通过 SpaceLens.exe 启动软件。直接打开网页无法读取硬盘。', true);
      $('drive-select').replaceChildren(new Option('请使用桌面程序', ''));
      return;
    }
    api.onProgress(onProgress);
    const activity = beginActivity('正在连接扫描引擎，读取硬盘和历史记录…');
    const results = await Promise.allSettled([loadDrives(), refreshState()]);
    endActivity(activity, '本机扫描引擎已连接');
    for (const result of results) if (result.status === 'rejected') notice(result.reason?.message || '初始化没有完成，请重新打开软件。', true);
    void refreshUsage();
  }
  let booted=false;window.addEventListener('spacelens-space',()=>{if(!booted){booted=true;void invoke('initializeSpace').then(boot).catch(e=>{booted=false;notice(e.message,true);});}});
})();
