import { icon } from './icons.js';
import { connectPlayer } from './reader.js';
import { batchBar, emptyContent, isSmartCircle, itemCard, learningStates, safe, sidebarContent, spotlight, starButton, workspaceContent, isVideo } from './library.js';
import { aiPanel, cardsPanel, clock, cueList, learningStateSwitch, noteList, readerContent, readingContent, relatedPanel } from './reader-view.js';
import { reviewContent } from './review-view.js';
import { askContent, readerAiPanel } from './ask-view.js';
import { buildSandboxDoc, demoCanvasWidget, demoQuizWidget } from './widget-view.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const main = $('#main');
const editor = $('#editor');
const sidebar = $('.sidebar');
const readStored = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const writeStored = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const state = {
  circles: [], counts: { all: 0, starred: 0, recent: 0, inbox: 0, learning: 0, mastered: 0, undistilled: 0, unindexed: 0, review_due: 0, review_total: 0, ai_configured: false, semantic_search: false },
  pending: new Map(), items: [], visibleIds: [],
  query: '', view: 'all', filter: 'all', stateFilter: '', sort: 'new', layout: 'grid',
  batchMode: false, selectedIds: new Set(),
  theme: readStored('lc-theme', 'light') === 'dark' ? 'dark' : 'light',
  relaxed: readStored('lc-relaxed', '0') === '1',
  review: { active: false, scope: 'due', circle: '', cards: [], stats: { due: 0, total: 0, reviewed_today: 0 }, revealed: false, sessionDone: 0 },
  ask: { active: false, mode: 'chat', webSearch: false, historyOpen: false, threads: [], threadId: null, messages: [], followUps: [], quizAnswers: {}, canvas: null, scopeType: 'all', scopeId: '', scopeTitle: '', draft: '', loading: false },
  readerAi: { open: readStored('lc-reader-ai-open', '0') === '1', itemId: null, mode: 'chat', webSearch: false, historyOpen: false, threads: [], threadId: null, messages: [], followUps: [], quizAnswers: {}, draft: '', loading: false, version: 0 },
  item: null, related: [], pdfView: 'text', cueFilter: '', pendingAnchor: null, version: 0,
};
let stream;
let player;
let refreshTimer;
let searchTimer;
let toastTimer;
let progressFrame;

function applyTheme() {
  if (state.theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}
applyTheme();
async function api(path, options = {}) {
  if (options.body && !(options.body instanceof FormData)) {
    options = { ...options, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) };
  }
  let response;
  try {
    response = await fetch(`/api${path}`, options);
  } catch {
    throw new Error('无法连接本地学习中心服务，请确认后端服务已启动');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? '请求失败，请重试'), { status: response.status });
  }
  if (response.status !== 204) return response.json();
}

function notice(message) {
  const node = $('#notice');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
}

function modal(title, content, onSubmit, label = '保存', { wide = false, compact = false, hideCancel = false } = {}) {
  editor.classList.toggle('wide', wide);
  editor.classList.toggle('compact-modal', compact);
  editor.innerHTML = `<header class="dialog-head"><h2 id="dialog-title">${safe(title)}</h2><button class="icon-btn" type="button" data-cancel aria-label="关闭">${icon.close}</button></header>
    <form class="dialog-form">${content}<p class="form-error" role="alert" hidden></p>
    <footer class="dialog-actions">${hideCancel ? '' : '<button class="btn" type="button" data-cancel>取消</button>'}<button class="btn primary" type="submit">${safe(label)}</button></footer></form>`;
  for (const button of editor.querySelectorAll('[data-cancel]')) button.onclick = () => editor.close();
  const form = $('form', editor);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $('button[type=submit]', form);
    const errorNode = $('.form-error', form);
    errorNode.hidden = true;
    button.disabled = true;
    try {
      await onSubmit(new FormData(form));
      if (editor.contains(form)) editor.close();
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } finally { button.disabled = false; }
  };
  if (!editor.open) editor.showModal();
  $('input:not([type=checkbox]), textarea', form)?.focus();
}

function circlesForm(selected = []) {
  return `<fieldset><legend>保存到圈子</legend><div class="circle-options">${state.circles.map(({ id, name }) =>
    `<label><input type="checkbox" name="circle" value="${id}" ${selected.includes(id) ? 'checked' : ''}>${safe(name)}</label>`).join('')}</div></fieldset>`;
}

function circleDialog(circle, afterSave) {
  const editing = Boolean(circle?.id);
  const rules = circle?.smart_rules ?? {};
  const existingCategories = [...new Set(state.circles.map((c) => c.category).filter(Boolean))];
  const selectedTypes = new Set(rules.types ?? []);
  const typeChoices = [
    ['article', '文章'], ['video', '视频'], ['pdf', 'PDF'], ['markdown', '笔记'], ['image', '图片'],
  ];
  const hasRules = isSmartCircle(circle);
  const catChips = existingCategories.length
    ? `<div class="cat-chips">${existingCategories.map((cat) => `<button type="button" class="cat-chip" data-pick-cat="${safe(cat)}">${safe(cat)}</button>`).join('')}</div>`
    : '';
  modal(editing ? '编辑圈子' : '创建圈子', `
    <label class="field">圈子名称<input name="name" placeholder="例如 AI、产品设计" maxlength="60" value="${safe(circle?.name)}" required></label>
    <label class="field">所属分类（可选，用于在侧边栏分组管理）<input name="category" list="circle-cat-list" placeholder="例如：技术研发、产品设计、效率工具" maxlength="40" value="${safe(circle?.category)}"><datalist id="circle-cat-list">${existingCategories.map((cat) => `<option value="${safe(cat)}"></option>`).join('')}</datalist>${catChips}</label>
    <label class="field">简介<textarea name="description" placeholder="这个圈子收集什么？" maxlength="500">${safe(circle?.description)}</textarea></label>
    <details class="smart-rules-box" ${hasRules ? 'open' : ''}>
      <summary>${icon.sparkle}智能分类规则（可选 · 新资料自动归入此圈子）</summary>
      <div class="smart-rules-fields">
        <label class="field">关键词匹配（逗号分隔）<input name="keywords" placeholder="例如：LLM, Transformer, Agent" value="${safe((rules.keywords ?? []).join(', '))}"></label>
        <label class="field">来源域名匹配（逗号分隔）<input name="domains" placeholder="例如：arxiv.org, github.com, bilibili.com" value="${safe((rules.domains ?? []).join(', '))}"></label>
        <fieldset><legend>自动收纳资料类型</legend><div class="circle-options">${typeChoices.map(([key, label]) => {
          const checked = key === 'video' ? (selectedTypes.has('video') || selectedTypes.has('local_video')) : selectedTypes.has(key);
          return `<label><input type="checkbox" name="rule_type" value="${key}" ${checked ? 'checked' : ''}>${label}</label>`;
        }).join('')}</div></fieldset>
        <label class="inline-check"><input type="checkbox" name="auto_ai" ${rules.auto_ai ? 'checked' : ''}><span>允许 AI 提炼的推荐圈子与标签自动归入此圈子</span></label>
        <label class="inline-check"><input type="checkbox" name="apply_now" checked><span>保存后立即对已有资料执行一次规则匹配</span></label>
      </div>
    </details>`, async (form) => {
    const rawTypes = form.getAll('rule_type');
    const ruleTypes = rawTypes.flatMap((t) => t === 'video' ? ['video', 'local_video'] : [t]);
    const smart_rules = {
      keywords: String(form.get('keywords') ?? ''),
      domains: String(form.get('domains') ?? ''),
      types: ruleTypes,
      auto_ai: form.get('auto_ai') === 'on',
    };
    const body = {
      name: form.get('name'),
      category: form.get('category'),
      description: form.get('description'),
      smart_rules,
    };
    const saved = await api(editing ? `/circles/${circle.id}` : '/circles', { method: editing ? 'PATCH' : 'POST', body });
    let matchedCount = 0;
    if (form.get('apply_now') === 'on' && isSmartCircle(saved)) {
      const applied = await api(`/circles/${saved.id}/apply-rules`, { method: 'POST' }).catch(() => ({ added: 0 }));
      matchedCount = applied.added ?? 0;
    }
    await loadCircles();
    if (!editing) navigate(`/?circle=${saved.id}`);
    else {
      workspace();
      await refreshList();
    }
    if (matchedCount > 0) notice(`圈子已保存，并自动归入 ${matchedCount} 份已有资料`);
    else notice(editing ? '圈子已更新' : '圈子已创建');
    if (afterSave) afterSave(saved);
  }, editing ? '保存修改' : '创建圈子');
}

async function openSmartClassifyDialog() {
  const { suggestions } = await api('/circles/smart-classify', { method: 'POST', body: { dry_run: true } });
  if (!suggestions.length) {
    modal('智能分类整理', `<div class="smart-empty"><p>当前没有发现新的待归类建议。</p><p class="muted small">你可以为任意圈子配置关键词、域名、类型或「AI 自动归类」规则，或先对资料完成 AI 提炼与语义索引后再运行整理。</p>
      <div class="actions"><button type="button" class="btn primary" id="create-smart-circle-btn">${icon.sparkle}创建智能圈子</button></div></div>`, () => {}, '完成');
    $('#create-smart-circle-btn').onclick = () => circleDialog({ smart_rules: { auto_ai: true } });
    return;
  }
  const rows = suggestions.map((s, index) => `<label class="suggest-row">
    <input type="checkbox" name="pick" value="${index}" checked>
    <div class="suggest-body">
      <strong class="od-clamp-2">${safe(s.item_title)}</strong>
      <div class="suggest-meta">
        <span>${s.create_circle_name ? `新建并加入「${safe(s.circle_name)}」` : `加入「${safe(s.circle_name)}」`}</span>
        <span class="pill-soft ${s.source === 'semantic' ? 'due' : ''}">${safe(s.reason)}</span>
      </div>
    </div>
  </label>`).join('');
  modal(`智能分类建议（发现 ${suggestions.length} 条）`, `<p class="muted small">系统结合圈子规则、AI 推荐及向量语义自动生成以下归类建议，勾选后一键应用：</p><div class="suggest-list">${rows}</div>`, async (form) => {
    const picks = form.getAll('pick').map((idx) => suggestions[Number(idx)]).filter(Boolean);
    if (!picks.length) throw new Error('请至少勾选一条建议');
    const result = await api('/circles/smart-classify', { method: 'POST', body: { dry_run: false, assignments: picks } });
    await refresh();
    const extra = result.created_circles?.length ? `，新建 ${result.created_circles.length} 个圈子` : '';
    notice(`已完成智能分类：归入 ${result.applied} 条资料${extra}`);
  }, '应用所选分类', { wide: true });
}

function addDialog(kind, dropped, defaults, prefillUrl = '') {
  if (!state.circles.length) {
    circleDialog(null, (circle) => addDialog(kind, dropped, [circle.id], prefillUrl));
    return;
  }
  const selected = defaults ?? [circleId() || state.circles[0].id];
  if (kind === 'note') {
    const fields = `<label class="field">笔记标题<input name="title" maxlength="500" placeholder="例如：Transformer 读书笔记" required></label>
      <label class="field">正文（支持 Markdown）<textarea name="markdown" class="md-editor" maxlength="500000" placeholder="# 核心想法&#10;&#10;在这里记录你的思考、摘录或代码示例…" required></textarea></label>`;
    modal('新建 Markdown 笔记', fields + circlesForm(selected), async (form) => {
      const ids = form.getAll('circle');
      if (!ids.length) throw new Error('请至少选择一个圈子');
      const title = String(form.get('title') ?? '').trim();
      const markdown = String(form.get('markdown') ?? '').trim();
      if (!title || !markdown) throw new Error('请填写标题和正文');
      const temp = Symbol('pending note');
      if (['recent', 'starred'].includes(state.view)) navigate('/');
      state.pending.set(temp, { id: temp, title, type: 'markdown', ingest_state: 'queued', learning_state: 'inbox', circle_ids: ids, created_at: new Date() });
      renderCards();
      try {
        await api('/items/note', { method: 'POST', body: { title, markdown, circle_ids: ids } });
        notice('笔记已创建，后台正在处理');
      } finally {
        state.pending.delete(temp);
        refresh().catch((error) => notice(error.message));
      }
    }, '保存笔记', { wide: true });
    return;
  }
  const isLink = kind === 'url';
  const input = isLink ? `<label class="field">资料链接<input name="url" type="url" placeholder="https://" value="${safe(prefillUrl)}" required></label>` :
    `<div class="upload-target">${icon.upload}<strong>${dropped ? safe(dropped.name) : '选择一份学习资料'}</strong>
      ${dropped ? '' : '<input name="file" type="file" aria-label="选择资料文件" accept=".pdf,.md,.markdown,.mp4,.mov,.webm,.jpg,.jpeg,.png,.gif,.webp,.avif" required>'}
      <small>PDF、Markdown、视频和图片 · 单个文件最大 512 MB</small></div>`;
  modal(isLink ? '添加到你的知识库' : '把资料带进来', input + circlesForm(selected), async (form) => {
    const ids = form.getAll('circle');
    if (!ids.length) throw new Error('请至少选择一个圈子');
    const file = dropped ?? form.get('file');
    const url = isLink ? new URL(form.get('url')) : null;
    if (url && !['http:', 'https:'].includes(url.protocol)) throw new Error('请输入 HTTP 或 HTTPS 链接');
    const temp = Symbol('pending item');
    const ext = file?.name.split('.').at(-1).toLowerCase();
    const fileType = { pdf: 'pdf', md: 'markdown', markdown: 'markdown', mp4: 'local_video', webm: 'local_video', mov: 'local_video' };
    const type = isLink ? 'article' : fileType[ext] ?? 'image';
    const pending = { id: temp, title: url?.hostname ?? file.name, type, source_url: url?.href, ingest_state: 'queued', circle_ids: ids, created_at: new Date() };
    if (['recent', 'starred'].includes(state.view)) navigate('/');
    state.pending.set(temp, pending);
    renderCards();
    try {
      let body = { url: url?.href, circle_ids: ids };
      if (!isLink) {
        body = new FormData();
        body.append('file', file);
        body.append('circle_ids', JSON.stringify(ids));
      }
      await api(`/items/${kind}`, { method: 'POST', body });
      notice('已提交，后台正在处理');
    } finally {
      state.pending.delete(temp);
      refresh().catch((error) => notice(error.message));
    }
  }, isLink ? '保存资料' : '添加文件');
}

async function loadCircles() {
  const [circles, counts] = await Promise.all([api('/circles'), api('/items/counts')]);
  state.circles = circles;
  state.counts = counts;
  renderSidebar();
  const stateSelect = $('#state-filter');
  if (stateSelect) {
    stateSelect.options[1].textContent = `待读 ${counts.inbox ?? 0}`;
    stateSelect.options[2].textContent = `学习中 ${counts.learning ?? 0}`;
    stateSelect.options[3].textContent = `已掌握 ${counts.mastered ?? 0}`;
  }
}

function renderSidebar() { sidebar.innerHTML = sidebarContent(state); }

function circleId() {
  return state.circles.find(({ id }) => id === state.view)?.id ?? '';
}

function workspace() {
  state.items = [];
  main.innerHTML = workspaceContent(state);
  $('#sort').value = state.sort;
  $('#state-filter').value = state.stateFilter;
  renderViewControls();
  $('#search').oninput = (event) => {
    state.query = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshList().catch((error) => notice(error.message)), 180);
  };
  $('#state-filter').onchange = (event) => {
    state.stateFilter = event.target.value;
    refreshList().catch((error) => notice(error.message));
  };
  $('#sort').onchange = (event) => {
    state.sort = event.target.value;
    renderCards();
  };
}

function renderViewControls() {
  for (const key of ['filter', 'layout']) {
    for (const button of main.querySelectorAll(`[data-${key}]`)) {
      const active = button.dataset[key] === state[key];
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active);
    }
  }
}

function renderCards() {
  const grid = $('#resources');
  if (!grid) return;
  const pending = [...state.pending.values()].filter((item) => (!circleId() || item.circle_ids.includes(circleId()))
    && (!state.stateFilter || state.stateFilter === 'inbox')
    && (!state.query || item.title.includes(state.query)));
  const base = [...pending, ...state.items].filter((item) => {
    if (state.view === 'recent') return item.visited_at;
    if (state.view === 'starred') return item.starred;
    return true;
  });
  const visible = base.filter((item) => state.filter === 'all' || (state.filter === 'video' ? isVideo(item) : item.type === state.filter));
  if (!(state.query && state.sort === 'new')) {
    visible.sort((a, b) => {
      if (state.sort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
      if (state.sort === 'old') return new Date(a.created_at) - new Date(b.created_at);
      if (state.view === 'recent') return new Date(b.visited_at) - new Date(a.visited_at);
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }
  state.visibleIds = visible.filter((item) => !state.pending.has(item.id)).map((item) => item.id);
  for (const id of [...state.selectedIds]) if (!state.visibleIds.includes(id)) state.selectedIds.delete(id);
  const focusStar = document.activeElement?.dataset.star;
  grid.classList.toggle('list-mode', state.layout === 'list');
  grid.removeAttribute('aria-busy');
  grid.innerHTML = visible.length
    ? visible.map((item) => itemCard(item, state.circles, state.pending.has(item.id), { active: state.batchMode, selected: state.selectedIds.has(item.id) })).join('')
    : emptyContent(state);
  const bar = $('#batch-bar');
  if (bar) bar.innerHTML = batchBar(state, state.visibleIds.length);
  const toggleBtn = $('[data-batch-toggle]', main);
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', state.batchMode);
    toggleBtn.setAttribute('aria-pressed', state.batchMode);
    toggleBtn.querySelector('span').textContent = state.batchMode ? '完成' : '批量';
  }
  if (focusStar) ($(`[data-star="${focusStar}"]`, grid) ?? $('[data-add="url"]', main))?.focus({ preventScroll: true });
  $('#base-count').textContent = base.length;
  const hasSemantic = visible.some((item) => item.match_type === 'semantic' || item.match_type === 'hybrid');
  $('#result-count').textContent = `${visible.length} 份资料${state.query ? (hasSemantic ? ' · 混合搜索结果' : ' · 搜索结果') : ''}`;
  const banner = $('#spotlight');
  const markup = spotlight(state, state.items);
  if (banner.dataset.markup !== markup) {
    banner.dataset.markup = markup;
    banner.innerHTML = markup;
  }
}

async function refreshList() {
  const grid = $('#resources');
  if (!grid || state.item) return;
  const version = ++state.version;
  const params = new URLSearchParams({ circle: circleId(), q: state.query });
  if (state.stateFilter) params.set('state', state.stateFilter);
  const items = await api(`/items?${params}`);
  if (state.version !== version || grid !== $('#resources')) return;
  state.items = items;
  renderCards();
}

function setReaderTab(tab) {
  const grid = $('.reading-grid[data-tab]', main);
  if (!grid) return;
  grid.dataset.tab = tab;
  for (const button of main.querySelectorAll('[data-reader-tab]')) {
    const active = button.dataset.readerTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
  }
}

function jump(id) {
  if (state.reader?.type === 'pdf' && state.pdfView === 'file') {
    state.pdfView = 'text';
    const prose = $('#prose-body');
    if (prose) prose.innerHTML = readingContent(state.reader, 'text', state.relaxed);
  }
  const node = document.getElementById(id);
  if (!node) return;
  setReaderTab('source');
  if (node.hasAttribute('data-seek')) player?.seek(Number(node.dataset.seek));
  $('.source-focus')?.classList.remove('source-focus');
  node.classList.add('source-focus');
  node.tabIndex = -1;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
}

function libraryPath() {
  if (state.view === 'review') return '/review';
  if (state.view === 'ask') return '/ask';
  return circleId() ? `/?circle=${state.view}` : state.view === 'all' ? '/' : `/?view=${state.view}`;
}

function syncPlaybackPosition(seconds) {
  const timer = $('#note-time');
  if (timer) timer.textContent = `当前 ${clock(seconds)}`;
  const cues = $('#cues');
  if (!cues) return;
  let active = null;
  for (const node of cues.querySelectorAll('.cue[data-start]')) {
    const start = Number(node.dataset.start);
    const end = Number(node.dataset.end);
    if (seconds >= start && seconds <= Math.max(end, start + 1)) active = node;
    else if (seconds >= start && (!active || start > Number(active.dataset.start))) active = node;
  }
  const previous = $('.cue.active', cues);
  if (previous !== active) {
    previous?.classList.remove('active');
    active?.classList.add('active');
  }
}

function renderReader(item) {
  player?.destroy();
  player = undefined;
  state.pdfView = item.type === 'pdf' && item.has_file && !item.raw_markdown ? 'file' : 'text';
  state.cueFilter = '';
  const activeTab = $('.reading-grid[data-tab]', main)?.dataset.tab;
  main.innerHTML = readerContent(item, state, libraryPath());
  if (activeTab) setReaderTab(activeTab);
  if (item.ingest_state !== 'ready') return;
  const container = $('#player');
  if (container) {
    player = connectPlayer(item, container, notice, syncPlaybackPosition);
    $('video', container)?.addEventListener('error', () => notice('浏览器无法播放此格式，可打开原文件查看。'));
  }
  const cueFilter = $('#cue-filter');
  if (cueFilter) {
    cueFilter.oninput = (event) => {
      state.cueFilter = event.target.value;
      const cues = $('#cues');
      if (cues && state.reader) cues.innerHTML = cueList(state.reader, state.cueFilter);
    };
  }
  const note = $('#note-form');
  note.onsubmit = async (event) => {
    event.preventDefault();
    const field = $('textarea', note);
    const button = $('button', note);
    const timed = isVideo(item) && item.metadata_json.platform !== 'bilibili';
    button.disabled = true;
    try {
      const body = { text: field.value, ...(timed ? { seconds: player.position() } : {}) };
      await api(`/items/${item.id}/notes`, { method: 'POST', body });
      field.value = '';
      await refreshReader();
      notice('笔记已保存');
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; }
  };
  if (state.pendingAnchor) {
    const anchor = state.pendingAnchor;
    state.pendingAnchor = null;
    requestAnimationFrame(() => jump(anchor));
  }
  if (state.readerAi.open) {
    bindReaderAiForm();
    if (state.readerAi.itemId !== item.id) loadReaderAi(item.id).catch((error) => notice(error.message));
  }
}

function resetReaderAi(threadId = null, itemId = state.item) {
  const previous = state.readerAi;
  state.readerAi = { ...previous, version: previous.version + 1,
    threads: previous.itemId === itemId ? previous.threads : [],
    itemId,
    threadId,
    messages: [],
    followUps: [],
    quizAnswers: {},
    historyOpen: false,
    draft: '',
    loading: false,
  };
}

function bindReaderAiForm() {
  const dock = $('#reader-ai-dock');
  if (!dock) return;
  const scrollBox = $('.dock-scroll', dock);
  if (scrollBox && (state.readerAi.messages.length || state.readerAi.loading)) scrollBox.scrollTop = scrollBox.scrollHeight;
  const form = $('#reader-ai-form', dock);
  const input = $('#reader-ai-input', dock);
  if (!form || !input) return;
  const autoSize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, Math.max(40, input.scrollHeight))}px`;
  };
  input.value = state.readerAi.draft;
  autoSize();
  input.oninput = () => { state.readerAi.draft = input.value; autoSize(); };
  input.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const textValue = input.value;
    input.value = '';
    autoSize();
    sendReaderAiQuestion(textValue);
  };
}

function renderReaderAi() {
  if (!state.reader) return;
  const shell = $('#reader-shell');
  const dock = $('#reader-ai-dock');
  if (!shell || !dock) return;
  const open = Boolean(state.readerAi.open);
  const focused = document.activeElement;
  const selection = focused?.id === 'reader-ai-input' ? [focused.selectionStart, focused.selectionEnd] : null;
  shell.classList.toggle('ai-open', open);
  const toggleBtn = $('[data-toggle-reader-ai]', shell);
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', open);
    toggleBtn.setAttribute('aria-pressed', open);
  }
  const existingBackdrop = $('.reader-ai-backdrop', shell);
  if (open && !existingBackdrop) {
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'reader-ai-backdrop';
    backdrop.setAttribute('data-toggle-reader-ai', '');
    backdrop.setAttribute('aria-label', '关闭 AI 伴读侧栏');
    shell.insertBefore(backdrop, dock);
  } else if (!open && existingBackdrop) {
    existingBackdrop.remove();
  }
  dock.hidden = !open;
  if (!open) {
    dock.innerHTML = '';
    return;
  }
  dock.innerHTML = readerAiPanel(state.reader, state);
  bindReaderAiForm();
  const input = $('#reader-ai-input', dock);
  if (selection && input && !input.disabled) {
    input.focus({ preventScroll: true });
    input.setSelectionRange(...selection);
  }
}

async function loadReaderAi(itemId, { threadId = undefined } = {}) {
  if (!itemId || state.item !== itemId || !state.readerAi.open) return;
  const switchingItem = state.readerAi.itemId !== itemId;
  if (switchingItem || (threadId !== undefined && threadId !== state.readerAi.threadId)) {
    resetReaderAi(threadId ?? null, itemId);
    renderReaderAi();
  }
  if (state.readerAi.loading) return;
  const version = ++state.readerAi.version;
  const current = () => version === state.readerAi.version && state.item === itemId && state.readerAi.open;
  const threads = await api(`/ai/threads?scope_type=item&scope_id=${itemId}`);
  if (!current()) return;
  state.readerAi.threads = threads;
  const nextThreadId = threadId !== undefined
    ? threadId
    : (state.readerAi.threadId && threads.some((t) => t.id === state.readerAi.threadId))
      ? state.readerAi.threadId
      : (switchingItem ? (threads[0]?.id ?? null) : state.readerAi.threadId);
  state.readerAi.threadId = nextThreadId;
  if (nextThreadId) {
    const detail = await api(`/ai/threads/${nextThreadId}`).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (!current()) return;
    if (detail) {
      state.readerAi.messages = detail.messages;
    } else {
      state.readerAi.threadId = null;
      state.readerAi.messages = [];
    }
  } else {
    state.readerAi.messages = [];
  }
  renderReaderAi();
}

async function sendReaderAiQuestion(question) {
  const item = state.reader;
  const panel = state.readerAi;
  const clean = question.trim();
  if (!item || !clean || panel.loading) return;
  const itemId = item.id;
  panel.version++;
  panel.itemId = itemId;
  panel.draft = '';
  panel.loading = true;
  panel.followUps = [];
  panel.historyOpen = false;
  const optimistic = { id: `tmp-${Date.now()}`, role: 'user', content: clean, citations_json: [] };
  panel.messages = [...panel.messages, optimistic];
  renderReaderAi();
  try {
    const payload = {
      question: clean,
      mode: panel.mode || 'chat',
      web_search: Boolean(panel.webSearch),
      ...(panel.threadId ? { thread_id: panel.threadId } : { scope_type: 'item', scope_id: itemId }),
    };
    const res = await api('/ai/ask', { method: 'POST', body: payload });
    if (state.readerAi !== panel || state.item !== itemId) return;
    if (res.web_warning) notice(`联网检索暂不可用（${res.web_warning}），已基于本篇资料作答`);
    panel.threadId = res.thread.id;
    panel.messages = [...panel.messages.filter((m) => m.id !== optimistic.id), res.user_message, res.assistant_message];
    panel.followUps = res.follow_ups ?? [];
    panel.threads = await api(`/ai/threads?scope_type=item&scope_id=${itemId}`).catch(() => panel.threads);
  } catch (error) {
    if (state.readerAi !== panel || state.item !== itemId) return;
    panel.draft = clean;
    panel.messages = [
      ...panel.messages,
      { id: `err-${Date.now()}`, role: 'assistant', content: `**请求失败**：${error.message}`, citations_json: [], model_used: '错误提示' },
    ];
    notice(error.message);
  } finally {
    panel.loading = false;
    if (panel === state.readerAi && state.item === itemId && panel.open) renderReaderAi();
  }
}

async function refreshReader() {
  const id = state.item;
  if (!id) return;
  const version = ++state.version;
  const [item, related] = await Promise.all([
    api(`/items/${id}`),
    api(`/items/${id}/related`).catch(() => []),
  ]);
  if (version !== state.version || id !== state.item) return;
  const previous = state.reader;
  const previousRelated = state.related;
  state.reader = item;
  state.related = related;
  if (previous?.id !== id || previous.ingest_state !== item.ingest_state) {
    renderReader(item);
    if (previous?.id !== id && !state.pendingAnchor) $('#reader-heading')?.focus({ preventScroll: true });
  } else {
    if (previous.title !== item.title) {
      const heading = $('#reader-heading');
      if (heading) heading.textContent = item.title;
    }
    if (previous.raw_markdown !== item.raw_markdown && !isVideo(item)) {
      const prose = $('#prose-body');
      if (prose) prose.innerHTML = readingContent(item, state.pdfView, state.relaxed);
    }
    if (previous.learning_state !== item.learning_state) {
      const switcher = $('#learning-state-switch');
      if (switcher) switcher.innerHTML = learningStateSwitch(item.learning_state);
    }
    const circlesChanged = JSON.stringify(previous.circle_ids) !== JSON.stringify(item.circle_ids);
    if (circlesChanged) {
      const tagRow = $('#item-circles');
      if (tagRow) tagRow.innerHTML = state.circles.filter(({ id: cid }) => item.circle_ids.includes(cid)).map(({ name }) => `<span>${safe(name)}</span>`).join('');
    }
    if (previous.starred !== item.starred) {
      const star = $('[data-star]', main);
      const focused = document.activeElement === star;
      star.outerHTML = starButton(item);
      if (focused) $('[data-star]', main)?.focus({ preventScroll: true });
    }
    const aiReady = Boolean(state.counts.ai_configured);
    const cardsChanged = JSON.stringify(previous.cards) !== JSON.stringify(item.cards);
    if (circlesChanged || cardsChanged || previous.ai_state !== item.ai_state || previous.ai_error !== item.ai_error ||
        JSON.stringify(previous.distillation) !== JSON.stringify(item.distillation)) {
      const panel = $('#ai-panel');
      if (panel) panel.innerHTML = aiPanel(item, state.circles, aiReady);
    }
    if (cardsChanged || JSON.stringify(previous.notes) !== JSON.stringify(item.notes) || previous.ai_state !== item.ai_state) {
      const cardsBox = $('#cards-panel');
      if (cardsBox) cardsBox.innerHTML = cardsPanel(item, aiReady);
    }
    if (JSON.stringify(previous.notes) !== JSON.stringify(item.notes) || JSON.stringify(previous.anchors) !== JSON.stringify(item.anchors)) {
      const cues = $('#cues');
      const notes = $('#notes');
      if (cues) cues.innerHTML = cueList(item, state.cueFilter);
      if (notes) notes.innerHTML = noteList(item);
    }
    if (JSON.stringify(previousRelated) !== JSON.stringify(related)) {
      const rel = $('#related-panel');
      if (rel) rel.innerHTML = relatedPanel(related);
    }
  }
}

function renderReview() {
  main.innerHTML = reviewContent(state);
  const select = $('#review-circle');
  if (select) {
    select.onchange = (event) => {
      state.review.circle = event.target.value;
      state.review.revealed = false;
      state.review.sessionDone = 0;
      refreshReview().catch((error) => notice(error.message));
    };
  }
}

async function refreshReview() {
  if (!state.review.active) return;
  const version = ++state.version;
  const params = new URLSearchParams({ scope: state.review.scope });
  if (state.review.circle) params.set('circle', state.review.circle);
  const data = await api(`/review/cards?${params}`);
  if (version !== state.version || !state.review.active) return;
  const prevTop = state.review.cards[0]?.id;
  state.review.cards = data.cards;
  state.review.stats = data.stats;
  if (data.cards[0]?.id !== prevTop) state.review.revealed = false;
  renderReview();
}

function resetAskConversation(threadId = null) {
  state.version++;
  state.ask = { ...state.ask, threadId, messages: [], followUps: [], canvas: null, quizAnswers: {},
    loading: false, historyOpen: false, scopeTitle: '', draft: '' };
}

async function sendAskQuestion(question) {
  const ask = state.ask;
  const clean = question.trim();
  if (!clean || ask.loading) return;
  state.version++;
  ask.draft = '';
  ask.loading = true;
  ask.followUps = [];
  const optimistic = { id: `tmp-${Date.now()}`, role: 'user', content: clean, citations_json: [] };
  ask.messages = [...ask.messages, optimistic];
  renderAsk();
  try {
    const payload = {
      question: clean,
      mode: ask.mode || 'chat',
      web_search: Boolean(ask.webSearch),
      ...(ask.threadId ? { thread_id: ask.threadId } : { scope_type: ask.scopeType, scope_id: ask.scopeId || null }),
    };
    const res = await api('/ai/ask', { method: 'POST', body: payload });
    if (state.ask !== ask) return;
    if (res.web_warning) notice(`联网检索暂不可用（${res.web_warning}），已基于本地资料作答`);
    ask.threadId = res.thread.id;
    ask.messages = [...ask.messages.filter((m) => m.id !== optimistic.id), res.user_message, res.assistant_message];
    ask.followUps = res.follow_ups ?? [];
    if (res.assistant_message?.widget_json?.kind === 'canvas') {
      const w = res.assistant_message.widget_json;
      ask.canvas = { msgId: res.assistant_message.id, title: w.title, description: w.description, html: w.html, view: 'split', persisted: true };
    }
    ask.threads = await api('/ai/threads').catch(() => ask.threads);
  } catch (error) {
    if (state.ask !== ask) return;
    ask.draft = clean;
    ask.messages = [
      ...ask.messages,
      { id: `err-${Date.now()}`, role: 'assistant', content: `**请求失败**：${error.message}`, citations_json: [], model_used: '错误提示' },
    ];
    notice(error.message);
  } finally {
    ask.loading = false;
    if (ask === state.ask && ask.active) renderAsk();
  }
}

function renderAsk() {
  const focused = document.activeElement;
  const selection = focused?.id === 'ask-input' ? [focused.selectionStart, focused.selectionEnd] : null;
  main.innerHTML = askContent(state);
  const scrollBox = $('.ask-scroll', main);
  if (scrollBox && (state.ask.messages.length || state.ask.loading)) scrollBox.scrollTop = scrollBox.scrollHeight;
  const scopeSelect = $('#ask-scope');
  if (scopeSelect) {
    scopeSelect.onchange = (event) => {
      const val = event.target.value;
      if (val === 'all') { state.ask.scopeType = 'all'; state.ask.scopeId = ''; state.ask.scopeTitle = ''; }
      else if (val.startsWith('circle:')) { state.ask.scopeType = 'circle'; state.ask.scopeId = val.slice(7); state.ask.scopeTitle = ''; }
      renderAsk();
    };
  }
  const form = $('#ask-form');
  const input = $('#ask-input');
  if (form && input) {
    const autoSize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(180, Math.max(44, input.scrollHeight))}px`;
    };
    input.value = state.ask.draft;
    autoSize();
    if (selection && !input.disabled) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(...selection);
    }
    input.oninput = () => { state.ask.draft = input.value; autoSize(); };
    input.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const textValue = input.value;
      input.value = '';
      autoSize();
      sendAskQuestion(textValue);
    };
  }
  const codeEditor = $('#canvas-editor');
  if (codeEditor && state.ask.canvas) {
    codeEditor.oninput = () => { state.ask.canvas.html = codeEditor.value; };
    codeEditor.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        runCanvasPreview();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const start = codeEditor.selectionStart;
        const end = codeEditor.selectionEnd;
        codeEditor.value = `${codeEditor.value.slice(0, start)}  ${codeEditor.value.slice(end)}`;
        codeEditor.selectionStart = codeEditor.selectionEnd = start + 2;
        state.ask.canvas.html = codeEditor.value;
      }
    };
  }
}

function runCanvasPreview() {
  const codeEditor = $('#canvas-editor');
  const frame = $('#canvas-preview');
  if (!state.ask.canvas) return;
  if (codeEditor) state.ask.canvas.html = codeEditor.value;
  if (frame) frame.setAttribute('srcdoc', buildSandboxDoc(state.ask.canvas.html, state.theme));
  const msg = state.ask.messages.find((m) => m.id === state.ask.canvas.msgId);
  if (msg?.widget_json?.kind === 'canvas') msg.widget_json.html = state.ask.canvas.html;
  notice('已更新实时预览');
}

async function refreshAsk(background = false) {
  if (!state.ask.active) return;
  if (state.ask.loading) {
    if (!background) renderAsk();
    return;
  }
  const version = ++state.version;
  const current = () => version === state.version && state.ask.active;
  const threads = await api('/ai/threads');
  if (!current()) return;
  let changed = JSON.stringify(threads) !== JSON.stringify(state.ask.threads);
  state.ask.threads = threads;
  if (state.ask.threadId) {
    const detail = await api(`/ai/threads/${state.ask.threadId}`).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (!current()) return;
    if (!detail) {
      resetAskConversation();
      renderAsk();
      return;
    }
    changed ||= JSON.stringify(detail.messages) !== JSON.stringify(state.ask.messages);
    state.ask.messages = detail.messages;
    state.ask.scopeType = detail.scope_type;
    state.ask.scopeId = detail.scope_id || '';
  }
  if (state.ask.scopeType === 'item' && !state.ask.scopeTitle) {
    const item = await api(`/items/${state.ask.scopeId}`).catch(() => null);
    if (!current()) return;
    if (item) { state.ask.scopeTitle = item.title; changed = true; }
  }
  if (!background || changed || !$('#ask-form')) renderAsk();
}

async function openAiSettingsDialog() {
  const [aiSet, status] = await Promise.all([api('/ai/settings'), api('/system/status')]);
  const presets = [
    ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
    ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
    ['通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
    ['硅基流动', 'https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-72B-Instruct'],
    ['Ollama', 'http://127.0.0.1:11434/v1', 'qwen2.5:7b'],
  ];
  const currentBase = (aiSet.base || '').replace(/\/+$/, '');
  const presetHtml = `<div class="ai-preset-strip" role="group" aria-label="服务商预设">${presets.map(([label, base, model]) => {
    const active = currentBase === base.replace(/\/+$/, '');
    return `<button type="button" class="ai-preset-btn ${active ? 'active' : ''}" data-ai-preset data-base="${safe(base)}" data-model="${safe(model)}">${safe(label)}</button>`;
  }).join('')}</div>`;
  const searchProvider = aiSet.search_provider || 'duckduckgo';
  const needsSearchKey = ['tavily', 'brave', 'serper', 'custom'].includes(searchProvider);
  const needsSearchBase = ['searxng', 'custom'].includes(searchProvider);
  const metaParts = [
    status.storage === 'postgresql' ? 'PostgreSQL' : '本地 PGlite',
    status.auth ? '令牌保护' : '本地免密',
    `${/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl+K'} 搜索`,
    `${/Mac/.test(navigator.platform) ? '⌘.' : 'Ctrl+.'} 伴读`,
  ];
  const body = `
    <div class="ai-set-block">
      <div class="ai-field-head"><span>服务商</span><small class="muted">${aiSet.chat_configured ? '已连接' : '选择或自定义兼容接口'}</small></div>
      ${presetHtml}
    </div>
    <div class="ai-set-grid">
      <label class="field"><span>模型名称</span><input name="model" value="${safe(aiSet.model)}" placeholder="如 gpt-4o-mini" autocomplete="off"></label>
      <label class="field"><div class="ai-field-head"><span>API Key</span>${aiSet.has_key ? `<small class="muted mono">${safe(aiSet.key_preview)}</small>` : ''}</div><input name="key" type="password" autocomplete="off" placeholder="${aiSet.has_key ? '留空保持不变' : 'sk-...'}"></label>
    </div>
    <div class="ai-action-strip">
      <div class="ai-action-links">
        <button type="button" class="text-btn ai-inline-btn" id="test-ai-btn">${icon.refresh}测试连接</button>
        ${aiSet.undistilled > 0 ? `<button type="button" class="text-btn ai-inline-btn" id="batch-distill-btn" ${aiSet.chat_configured ? '' : 'disabled'}>${icon.sparkle}分析 ${aiSet.undistilled} 份资料</button>` : ''}
      </div>
      <span id="ai-test-result" class="ai-test-msg muted"></span>
    </div>
    <details class="ai-advanced">
      <summary><span>高级选项</span><small class="muted">接口地址 · 联网搜索 · 向量检索</small></summary>
      <div class="ai-advanced-body">
        <label class="field"><span>接口地址（Base URL）</span><input name="base" type="url" value="${safe(aiSet.base)}" placeholder="https://api.openai.com/v1" required></label>
        <div class="ai-adv-section">
          <div class="ai-field-head"><span>联网搜索引擎</span><button type="button" class="text-btn ai-inline-btn" id="test-search-btn">${icon.globe}测试联网</button></div>
          <select name="search_provider" id="search-provider-select" class="field-select">
            <option value="duckduckgo" ${searchProvider === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo（免密钥默认）</option>
            <option value="tavily" ${searchProvider === 'tavily' ? 'selected' : ''}>Tavily AI Search</option>
            <option value="brave" ${searchProvider === 'brave' ? 'selected' : ''}>Brave Search</option>
            <option value="serper" ${searchProvider === 'serper' ? 'selected' : ''}>Serper · Google</option>
            <option value="searxng" ${searchProvider === 'searxng' ? 'selected' : ''}>SearXNG 自建</option>
            <option value="custom" ${searchProvider === 'custom' ? 'selected' : ''}>自定义 JSON 接口</option>
          </select>
          <div class="ai-set-grid" id="search-extra-fields" ${needsSearchKey || needsSearchBase ? '' : 'hidden'}>
            <label class="field" id="search-base-wrap" ${needsSearchBase ? '' : 'hidden'}><span>搜索接口地址</span><input name="search_base" type="url" value="${safe(aiSet.search_base)}" placeholder="http://127.0.0.1:8080/search"></label>
            <label class="field" id="search-key-wrap" ${needsSearchKey ? '' : 'hidden'}><div class="ai-field-head"><span>搜索 Key</span>${aiSet.has_search_key ? `<small class="muted mono">${safe(aiSet.search_key_preview)}</small>` : ''}</div><input name="search_key" type="password" autocomplete="off" placeholder="${aiSet.has_search_key ? '留空保持不变' : '填写搜索 Key'}"></label>
          </div>
        </div>
        <div class="ai-adv-section">
          <div class="ai-field-head"><span>语义向量检索（可选）</span>${aiSet.unindexed > 0 ? `<button type="button" class="text-btn ai-inline-btn" id="batch-embed-btn" ${aiSet.semantic_configured ? '' : 'disabled'}>补建 ${aiSet.unindexed} 份索引</button>` : '<small class="muted">留空即用关键词检索</small>'}</div>
          <label class="field"><input name="embedding_model" value="${safe(aiSet.embedding_model)}" placeholder="留空不启用，如 text-embedding-3-small"></label>
          <div class="ai-set-grid">
            <label class="field"><input name="embedding_base" type="url" value="${safe(aiSet.embedding_base)}" placeholder="独立接口（留空复用上方）"></label>
            <label class="field"><input name="embedding_key" type="password" autocomplete="off" placeholder="${aiSet.has_embedding_key ? `独立 Key：${aiSet.embedding_key_preview}` : '独立 Key（留空复用）'}"></label>
          </div>
        </div>
        <p class="ai-sys-footnote">${safe(metaParts.join(' · '))}</p>
      </div>
    </details>`;
  modal('AI 设置', body, async (form) => {
    const payload = {
      base: form.get('base'),
      model: form.get('model'),
      embedding_model: form.get('embedding_model'),
      embedding_base: form.get('embedding_base'),
      search_provider: form.get('search_provider'),
      search_base: form.get('search_base'),
    };
    const keyVal = String(form.get('key') ?? '').trim();
    if (keyVal) payload.key = keyVal;
    const embKeyVal = String(form.get('embedding_key') ?? '').trim();
    if (embKeyVal) payload.embedding_key = embKeyVal;
    const searchKeyVal = String(form.get('search_key') ?? '').trim();
    if (searchKeyVal) payload.search_key = searchKeyVal;
    await api('/ai/settings', { method: 'PATCH', body: payload });
    await refresh();
    notice('AI 设置已保存');
  }, '保存', { compact: true });

  const searchSelect = $('#search-provider-select', editor);
  if (searchSelect) {
    searchSelect.onchange = () => {
      const val = searchSelect.value;
      const showKey = ['tavily', 'brave', 'serper', 'custom'].includes(val);
      const showBase = ['searxng', 'custom'].includes(val);
      const wrap = $('#search-extra-fields', editor);
      const keyWrap = $('#search-key-wrap', editor);
      const baseWrap = $('#search-base-wrap', editor);
      if (wrap) wrap.hidden = !showKey && !showBase;
      if (keyWrap) keyWrap.hidden = !showKey;
      if (baseWrap) baseWrap.hidden = !showBase;
    };
  }

  const testBtn = $('#test-ai-btn');
  const testSearchBtn = $('#test-search-btn');
  const testOut = $('#ai-test-result');
  if (testSearchBtn) {
    testSearchBtn.onclick = async () => {
      const form = new FormData($('form', editor));
      testSearchBtn.disabled = true;
      testOut.textContent = '正在测试联网…';
      testOut.className = 'ai-test-msg muted';
      try {
        const res = await api('/ai/test', {
          method: 'POST',
          body: {
            test_search: true,
            search_provider: form.get('search_provider'),
            search_base: form.get('search_base'),
            search_key: String(form.get('search_key') ?? '').trim() || undefined,
          },
        });
        if (res.search?.ok) {
          testOut.textContent = `✓ 联网正常（${res.search.count} 条 · ${res.search.latencyMs}ms）`;
          testOut.className = 'ai-test-msg text-success';
        } else {
          testOut.textContent = `联网失败：${res.search?.error || '未知错误'}`;
          testOut.className = 'ai-test-msg text-danger';
        }
      } catch (error) {
        testOut.textContent = error.message;
        testOut.className = 'ai-test-msg text-danger';
      } finally { testSearchBtn.disabled = false; }
    };
  }
  if (testBtn) {
    testBtn.onclick = async () => {
      const form = new FormData($('form', editor));
      testBtn.disabled = true;
      testOut.textContent = '正在测试连接…';
      testOut.className = 'ai-test-msg muted';
      try {
        const res = await api('/ai/test', {
          method: 'POST',
          body: {
            base: form.get('base'), model: form.get('model'), key: String(form.get('key') ?? '').trim() || undefined,
            embedding_base: form.get('embedding_base'), embedding_model: form.get('embedding_model'),
            embedding_key: String(form.get('embedding_key') ?? '').trim() || undefined,
          },
        });
        const parts = [];
        let chatOk = false;
        let anyErr = false;
        if (res.chat) {
          if (res.chat.ok) { chatOk = true; parts.push(`✓ ${res.chat.model} 正常 (${res.chat.latencyMs}ms)`); }
          else { anyErr = true; parts.push(`连接失败：${res.chat.error}`); }
        }
        if (res.embedding) {
          if (res.embedding.ok) parts.push(`向量正常`);
          else { anyErr = true; parts.push(`向量不可用（可留空）`); }
        }
        testOut.textContent = parts.join(' · ') || '请先填写模型与密钥';
        testOut.className = `ai-test-msg ${chatOk && !anyErr ? 'text-success' : chatOk ? 'text-warn' : 'text-danger'}`;
      } catch (error) {
        testOut.textContent = error.message;
        testOut.className = 'ai-test-msg text-danger';
      } finally { testBtn.disabled = false; }
    };
  }
  const distillBtn = $('#batch-distill-btn');
  if (distillBtn) {
    distillBtn.onclick = async () => {
      distillBtn.disabled = true;
      try {
        const { queued } = await api('/ai/distill-pending', { method: 'POST', body: {} });
        notice(queued ? `已为 ${queued} 份资料启动后台 AI 分析` : '没有待分析的资料');
        await refresh();
      } catch (error) { notice(error.message); }
    };
  }
  const embedBtn = $('#batch-embed-btn');
  if (embedBtn) {
    embedBtn.onclick = async () => {
      embedBtn.disabled = true;
      try {
        const { queued } = await api('/embeddings/reindex', { method: 'POST' });
        notice(queued ? `已将 ${queued} 份资料加入语义索引队列` : '所有资料均已建立语义索引');
        await refresh();
      } catch (error) { notice(error.message); }
    };
  }
}

async function refresh(background = false) {
  const { ai_configured, semantic_search } = state.counts;
  const circles = state.circles;
  await loadCircles();
  if (state.item) {
    await refreshReader();
    if (state.reader && state.readerAi.open && ai_configured !== state.counts.ai_configured) renderReaderAi();
  } else if (state.review.active) await refreshReview();
  else if (state.ask.active) await refreshAsk(background && ai_configured === state.counts.ai_configured &&
    semantic_search === state.counts.semantic_search && JSON.stringify(circles) === JSON.stringify(state.circles));
  else await refreshList();
}

function route() {
  const isReview = location.pathname === '/review';
  const isAsk = location.pathname === '/ask';
  const next = location.pathname.match(/^\/reader\/([0-9a-f-]+)$/i)?.[1] ?? null;
  if (next === state.item && next && state.reader) return;
  const params = new URLSearchParams(location.search);
  const view = params.get('circle') || params.get('view');
  const known = ['recent', 'starred'].includes(view) || state.circles.some(({ id }) => id === view);
  if (isReview) state.view = 'review';
  else if (isAsk) state.view = 'ask';
  else if (!next || view) state.view = known ? view : 'all';
  state.review.active = isReview;
  state.ask.active = isAsk;
  if (isReview) {
    state.review.revealed = false;
    state.review.sessionDone = 0;
  }
  if (isAsk) {
    const qItem = params.get('item');
    const qCircle = params.get('circle');
    const qMode = params.get('mode');
    if (['chat', 'quiz', 'canvas'].includes(qMode)) state.ask.mode = qMode;
    if (qItem) {
      resetAskConversation();
      state.ask.scopeType = 'item';
      state.ask.scopeId = qItem;
      state.ask.scopeTitle = state.reader?.id === qItem ? state.reader.title : '';
    } else if (qCircle) {
      resetAskConversation();
      state.ask.scopeType = 'circle';
      state.ask.scopeId = qCircle;
      state.ask.scopeTitle = '';
    }
  }
  state.item = next;
  state.reader = null;
  state.related = [];
  state.query = '';
  state.filter = 'all';
  state.stateFilter = '';
  state.batchMode = false;
  state.selectedIds.clear();
  $('#app').classList.remove('menu-open');
  player?.destroy();
  player = undefined;
  window.scrollTo(0, 0);
  renderSidebar();
  if (next || isReview || isAsk) main.innerHTML = `<div class="state-panel">${isAsk ? '正在加载 AI 问答…' : isReview ? '正在准备复习卡片…' : '正在加载资料…'}</div>`;
  else workspace();
  const destination = location.href;
  (next ? refreshReader() : isReview ? refreshReview() : isAsk ? refreshAsk() : refreshList()).catch((error) => {
    if (location.href === destination) main.innerHTML = `<div class="state-panel"><p>${safe(error.message)}</p><a class="btn" href="/" data-nav>返回资料库</a></div>`;
  });
}

function navigate(url) { history.pushState({}, '', url); route(); }
window.onpopstate = route;

function circleMenu() {
  const circle = state.circles.find(({ id }) => id === state.view);
  if (!circle) return;
  modal('圈子设置', `<p>${safe(circle.name)}</p><div class="actions"><button class="btn" type="button" id="edit-circle-dialog">编辑圈子</button>
    <button class="btn danger" type="button" id="delete-circle-dialog">删除圈子</button></div>`, () => {}, '完成');
  $('#edit-circle-dialog').onclick = () => circleDialog(circle);
  $('#delete-circle-dialog').onclick = () => modal('删除圈子', `<p>确定删除「${safe(circle.name)}」？资料仍可从全部资料和其他所属圈子查看。</p>`, async () => {
    await api(`/circles/${circle.id}`, { method: 'DELETE' });
    await loadCircles();
    navigate('/');
    notice('圈子已删除');
  }, '删除圈子');
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('a[data-nav]');
  if (nav && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.button === 0) {
    event.preventDefault();
    navigate(nav.getAttribute('href'));
    return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.hasAttribute('data-menu')) {
      const open = $('#app').classList.toggle('menu-open');
      button.setAttribute('aria-expanded', open);
    }
    if (button.hasAttribute('data-all')) navigate('/');
    if (button.hasAttribute('data-clear')) {
      state.query = '';
      state.filter = 'all';
      state.stateFilter = '';
      $('#search').value = '';
      if ($('#state-filter')) $('#state-filter').value = '';
      $('#search').focus();
      renderViewControls();
      await refreshList();
    }
    for (const key of ['filter', 'layout']) {
      if (button.dataset[key]) {
        state[key] = button.dataset[key];
        renderViewControls();
        renderCards();
      }
    }
    if (button.dataset.open) {
      const id = button.dataset.open;
      if (id === state.item && button.dataset.openAnchor) {
        jump(button.dataset.openAnchor);
      } else {
        state.pendingAnchor = button.dataset.openAnchor || null;
        navigate(`/reader/${id}${new URL(libraryPath(), location.origin).search}`);
        await api(`/items/${id}/preferences`, { method: 'PATCH', body: { visit: true } });
      }
    }
    if (button.dataset.star) {
      button.disabled = true;
      try {
        await api(`/items/${button.dataset.star}/preferences`, { method: 'PATCH', body: { starred: button.getAttribute('aria-pressed') !== 'true' } });
        await refresh();
      } finally { button.disabled = false; }
    }
    if (button.dataset.cycleState) {
      const order = ['inbox', 'learning', 'mastered'];
      const nextState = order[(order.indexOf(button.dataset.currentState) + 1) % order.length];
      button.disabled = true;
      try {
        await api(`/items/${button.dataset.cycleState}`, { method: 'PATCH', body: { learning_state: nextState } });
        await refresh();
        notice(`已标记为「${learningStates[nextState]}」`);
      } finally { button.disabled = false; }
    }
    if (button.hasAttribute('data-reindex-embeddings')) {
      button.disabled = true;
      try {
        const { queued } = await api('/embeddings/reindex', { method: 'POST' });
        await refresh();
        notice(queued ? `已将 ${queued} 份资料加入语义索引队列` : '所有资料均已建立语义索引');
      } finally { button.disabled = false; }
    }
    if (button.dataset.learningState && state.reader) {
      const nextState = button.dataset.learningState;
      if (nextState !== state.reader.learning_state) {
        button.disabled = true;
        try {
          await api(`/items/${state.reader.id}`, { method: 'PATCH', body: { learning_state: nextState } });
          await refresh();
          notice(`已标记为「${learningStates[nextState]}」`);
        } finally { button.disabled = false; }
      }
    }
    if (button.hasAttribute('data-rename-item') && state.reader) {
      const item = state.reader;
      modal('重命名资料', `<label class="field">资料标题<input name="title" maxlength="500" value="${safe(item.title)}" required></label>`, async (form) => {
        await api(`/items/${item.id}`, { method: 'PATCH', body: { title: form.get('title') } });
        await refresh();
        notice('标题已更新');
      }, '保存标题');
    }
    if (button.dataset.deleteItem && state.reader) {
      const item = state.reader;
      modal('删除资料', `<p>确定永久删除「${safe(item.title)}」？相关的笔记、AI 提炼和本地原文件都会一并移除，且无法恢复。</p>`, async () => {
        await api(`/items/${item.id}`, { method: 'DELETE' });
        await loadCircles();
        navigate(libraryPath());
        notice('资料已删除');
      }, '确认删除');
    }
    if (button.dataset.adoptCircle && state.reader) {
      const name = button.dataset.adoptCircle;
      const item = state.reader;
      button.disabled = true;
      try {
        let circle = state.circles.find((c) => c.name === name);
        let created = false;
        if (!circle) {
          circle = await api('/circles', { method: 'POST', body: { name } });
          created = true;
        }
        const ids = [...new Set([...item.circle_ids, circle.id])];
        await api(`/items/${item.id}/circles`, { method: 'PATCH', body: { circle_ids: ids } });
        await refresh();
        notice(created ? `已创建并加入圈子「${name}」` : `已加入圈子「${name}」`);
      } finally { button.disabled = false; }
    }
    if (button.dataset.editNote && state.reader) {
      const note = state.reader.notes.find(({ id }) => id === button.dataset.editNote);
      if (note) {
        modal('编辑笔记', `<label class="field">笔记内容<textarea name="text" maxlength="5000" required>${safe(note.text)}</textarea></label>`, async (form) => {
          await api(`/items/${state.reader.id}/notes/${note.id}`, { method: 'PATCH', body: { text: form.get('text') } });
          await refreshReader();
          notice('笔记已更新');
        }, '保存修改');
      }
    }
    if (button.dataset.deleteNote && state.reader) {
      const noteId = button.dataset.deleteNote;
      modal('删除笔记', '<p>确定删除这条笔记？</p>', async () => {
        await api(`/items/${state.reader.id}/notes/${noteId}`, { method: 'DELETE' });
        await refreshReader();
        notice('笔记已删除');
      }, '删除笔记');
    }
    if (button.hasAttribute('data-theme-toggle')) {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      writeStored('lc-theme', state.theme);
      applyTheme();
      renderSidebar();
      if (state.reader && state.readerAi.open) renderReaderAi();
    }
    if (button.hasAttribute('data-ai-settings') || button.hasAttribute('data-system-status')) {
      await openAiSettingsDialog();
    }
    if (button.hasAttribute('data-ai-preset')) {
      const form = $('form', editor);
      if (form) {
        form.elements.base.value = button.dataset.base || '';
        form.elements.model.value = button.dataset.model || '';
        for (const chip of editor.querySelectorAll('[data-ai-preset]')) {
          chip.classList.toggle('active', chip === button);
        }
        form.elements.key?.focus();
      }
    }
    if (button.hasAttribute('data-toggle-reader-ai') && state.reader) {
      state.readerAi.open = !state.readerAi.open;
      writeStored('lc-reader-ai-open', state.readerAi.open ? '1' : '0');
      renderReaderAi();
      if (state.readerAi.open) {
        await loadReaderAi(state.reader.id);
        $('#reader-ai-input')?.focus();
      }
    }
    if (button.dataset.readerAiLaunch && state.reader) {
      state.readerAi.open = true;
      state.readerAi.mode = button.dataset.readerAiLaunch;
      writeStored('lc-reader-ai-open', '1');
      renderReaderAi();
      await loadReaderAi(state.reader.id);
      $('#reader-ai-input')?.focus();
    }
    if (button.dataset.readerAiMode && state.reader) {
      state.readerAi.mode = button.dataset.readerAiMode;
      renderReaderAi();
      $('#reader-ai-input')?.focus();
    }
    if (button.hasAttribute('data-reader-ai-web') && state.reader) {
      state.readerAi.webSearch = !state.readerAi.webSearch;
      renderReaderAi();
      notice(state.readerAi.webSearch ? '侧栏已开启联网搜索（本篇 + 联网）' : '侧栏已切回仅本篇原文检索');
    }
    if (button.hasAttribute('data-reader-ai-history') && state.reader) {
      state.readerAi.historyOpen = !state.readerAi.historyOpen;
      renderReaderAi();
    }
    if (button.hasAttribute('data-reader-ai-new') && state.reader) {
      resetReaderAi(null, state.reader.id);
      renderReaderAi();
      $('#reader-ai-input')?.focus();
    }
    if (button.dataset.readerAiThread && state.reader) {
      state.readerAi.historyOpen = false;
      await loadReaderAi(state.reader.id, { threadId: button.dataset.readerAiThread });
    }
    if (button.dataset.readerAiDeleteThread && state.reader) {
      const tid = button.dataset.readerAiDeleteThread;
      await api(`/ai/threads/${tid}`, { method: 'DELETE' });
      if (state.readerAi.threadId === tid) resetReaderAi(null, state.reader.id);
      await loadReaderAi(state.reader.id, { threadId: state.readerAi.threadId });
      notice('对话已删除');
    }
    if (button.dataset.readerAiPrompt && state.reader) {
      await sendReaderAiQuestion(button.dataset.readerAiPrompt);
    }
    if (button.dataset.saveReaderNote && state.reader) {
      const msg = state.readerAi.messages.find((m) => m.id === button.dataset.saveReaderNote);
      if (msg?.content) {
        button.disabled = true;
        try {
          const plain = msg.content.trim().slice(0, 5000);
          await api(`/items/${state.reader.id}/notes`, { method: 'POST', body: { text: plain } });
          await refreshReader();
          notice('已记入本篇笔记');
        } finally { button.disabled = false; }
      }
    }
    if (button.dataset.askItem) {
      const modeParam = button.dataset.launchMode ? `&mode=${button.dataset.launchMode}` : '';
      navigate(`/ask?item=${button.dataset.askItem}${modeParam}`);
    }
    if (button.dataset.askMode) {
      state.ask.mode = button.dataset.askMode;
      renderAsk();
      $('#ask-input')?.focus();
    }
    if (button.hasAttribute('data-toggle-web-search')) {
      state.ask.webSearch = !state.ask.webSearch;
      renderAsk();
      notice(state.ask.webSearch ? '已开启 AI 联网搜索' : '已关闭联网搜索，仅检索本地资料库');
    }
    if (button.dataset.saveWebUrl) {
      const url = button.dataset.saveWebUrl;
      const title = button.dataset.saveWebTitle || '';
      if (!state.circles.length) {
        circleDialog(null, () => notice('圈子已创建，请再次点击收藏'));
        return;
      }
      modal('收藏联网网页到学习中心', `<p class="muted small">${safe(title || url)}</p>${circlesForm([state.circles[0].id])}`, async (form) => {
        const ids = form.getAll('circle');
        if (!ids.length) throw new Error('请至少选择一个圈子');
        await api('/items/url', { method: 'POST', body: { url, title, circle_ids: ids } });
        await loadCircles();
        notice('已提交入库，后台正在解析正文');
      }, '收藏入库');
    }
    if (button.dataset.demoWidget) {
      const kind = button.dataset.demoWidget;
      const widget = kind === 'quiz' ? structuredClone(demoQuizWidget) : structuredClone(demoCanvasWidget);
      const demoId = `demo-${kind}-${Date.now()}`;
      const msg = { id: demoId, role: 'assistant', content: widget.intro || widget.description, citations_json: [], widget_json: widget, model_used: '本地交互演示' };
      state.ask.messages = [...state.ask.messages, msg];
      if (kind === 'canvas') {
        state.ask.canvas = { msgId: demoId, title: widget.title, description: widget.description, html: widget.html, view: 'split', persisted: false };
      }
      renderAsk();
    }
    if (button.dataset.quizPick) {
      const msgId = button.dataset.quizPick;
      const qIdx = Number(button.dataset.qIdx);
      const optIdx = Number(button.dataset.optIdx);
      if (button.closest('#reader-ai-dock')) {
        state.readerAi.quizAnswers[`${msgId}:${qIdx}`] = optIdx;
        renderReaderAi();
      } else {
        state.ask.quizAnswers[`${msgId}:${qIdx}`] = optIdx;
        renderAsk();
      }
    }
    if (button.dataset.quizReset) {
      const prefix = `${button.dataset.quizReset}:`;
      const inDock = Boolean(button.closest('#reader-ai-dock'));
      const answers = inDock ? state.readerAi.quizAnswers : state.ask.quizAnswers;
      for (const key of Object.keys(answers)) {
        if (key.startsWith(prefix)) delete answers[key];
      }
      if (inDock) renderReaderAi();
      else renderAsk();
    }
    if (button.dataset.quizToCard) {
      const inDock = Boolean(button.closest('#reader-ai-dock'));
      const msgs = inDock ? state.readerAi.messages : state.ask.messages;
      const msg = msgs.find((m) => m.id === button.dataset.quizToCard);
      const q = msg?.widget_json?.questions?.[Number(button.dataset.qIdx)];
      const targetItemId = q?.item_id || (inDock ? state.reader?.id : null);
      if (q && targetItemId) {
        button.disabled = true;
        try {
          const correctOpt = q.options[q.correct_index];
          await api(`/items/${targetItemId}/cards`, {
            method: 'POST',
            body: {
              front: q.question,
              back: `答案：${correctOpt}\n\n解析：${q.explanation}`,
              anchor_id: q.anchor_id ?? null,
              quote: q.quote ?? null,
              source_kind: 'key_point',
            },
          });
          await loadCircles();
          if (inDock) await refreshReader();
          notice('已加入间隔复习闪卡');
        } finally { button.disabled = false; }
      }
    }
    if (button.dataset.openCanvas) {
      const msgId = button.dataset.openCanvas;
      if (button.closest('#reader-ai-dock') && state.reader) {
        const msg = state.readerAi.messages.find((m) => m.id === msgId);
        const w = msg?.widget_json;
        if (w?.kind === 'canvas') {
          resetAskConversation(state.readerAi.threadId);
          state.ask.scopeType = 'item';
          state.ask.scopeId = state.reader.id;
          state.ask.scopeTitle = state.reader.title;
          state.ask.mode = 'canvas';
          state.ask.canvas = { msgId, title: w.title, description: w.description, html: w.html, view: 'split', persisted: !String(msgId).startsWith('demo-') };
          navigate('/ask');
        }
      } else {
        const msg = state.ask.messages.find((m) => m.id === msgId);
        const w = msg?.widget_json;
        if (w?.kind === 'canvas') {
          state.ask.canvas = { msgId, title: w.title, description: w.description, html: w.html, view: 'split', persisted: !String(msgId).startsWith('demo-') };
          renderAsk();
        }
      }
    }
    if (button.dataset.canvasView && state.ask.canvas) {
      const codeEditor = $('#canvas-editor');
      if (codeEditor) state.ask.canvas.html = codeEditor.value;
      state.ask.canvas.view = button.dataset.canvasView;
      renderAsk();
    }
    if (button.hasAttribute('data-run-canvas')) runCanvasPreview();
    if (button.hasAttribute('data-save-canvas') && state.ask.canvas?.persisted) {
      const codeEditor = $('#canvas-editor');
      if (codeEditor) state.ask.canvas.html = codeEditor.value;
      button.disabled = true;
      try {
        const updated = await api(`/ai/messages/${state.ask.canvas.msgId}/widget`, {
          method: 'PATCH',
          body: { widget: { kind: 'canvas', title: state.ask.canvas.title, description: state.ask.canvas.description, html: state.ask.canvas.html } },
        });
        const idx = state.ask.messages.findIndex((m) => m.id === updated.id);
        if (idx >= 0) state.ask.messages[idx] = updated;
        runCanvasPreview();
        notice('交互组件代码已保存');
      } finally { button.disabled = false; }
    }
    if (button.dataset.copyCanvas) {
      const id = button.dataset.copyCanvas;
      const inDock = Boolean(button.closest('#reader-ai-dock'));
      const html = !inDock && state.ask.canvas?.msgId === id
        ? ($('#canvas-editor')?.value ?? state.ask.canvas.html)
        : (inDock ? state.readerAi.messages : state.ask.messages).find((m) => m.id === id)?.widget_json?.html;
      if (html) {
        if (!navigator.clipboard?.writeText) throw new Error('当前浏览器环境无法访问剪贴板');
        await navigator.clipboard.writeText(html);
        notice('组件代码已复制到剪贴板');
      }
    }
    if (button.hasAttribute('data-close-canvas')) {
      state.ask.canvas = null;
      renderAsk();
    }
    if (button.hasAttribute('data-toggle-history')) {
      state.ask.historyOpen = !state.ask.historyOpen;
      renderAsk();
    }
    if (button.hasAttribute('data-new-ask')) {
      resetAskConversation();
      if (state.ask.scopeType === 'item') { state.ask.scopeType = 'all'; state.ask.scopeId = ''; state.ask.scopeTitle = ''; }
      renderAsk();
      $('#ask-input')?.focus();
    }
    if (button.dataset.selectThread) {
      resetAskConversation(button.dataset.selectThread);
      await refreshAsk();
    }
    if (button.dataset.deleteThread) {
      const tid = button.dataset.deleteThread;
      await api(`/ai/threads/${tid}`, { method: 'DELETE' });
      if (state.ask.threadId === tid) resetAskConversation();
      await refreshAsk();
      notice('对话已删除');
    }
    if (button.dataset.followUp) {
      await sendAskQuestion(button.dataset.followUp);
    }
    if (button.dataset.saveAiNote) {
      const msgId = button.dataset.saveAiNote;
      const tid = button.dataset.threadId;
      if (!state.circles.length) { notice('请先创建一个圈子'); return; }
      modal('将 AI 回答存为笔记', `<label class="field">笔记标题<input name="title" maxlength="500" value="${safe(`AI 问答 · ${state.ask.threads.find((t) => t.id === tid)?.title || ''}`)}" required></label>${circlesForm([state.circles[0].id])}`, async (form) => {
        const ids = form.getAll('circle');
        if (!ids.length) throw new Error('请至少选择一个圈子');
        await api(`/ai/threads/${tid}/save-note`, { method: 'POST', body: { message_id: msgId, title: form.get('title'), circle_ids: ids } });
        await loadCircles();
        notice('已存为 Markdown 笔记');
      }, '保存笔记');
    }
    if (button.hasAttribute('data-generate-ai-cards') && state.reader) {
      button.disabled = true;
      notice('AI 正在基于原文生成复习卡片…');
      try {
        const { created, skipped } = await api(`/items/${state.reader.id}/cards/generate`, { method: 'POST', body: { mode: 'ai' } });
        await refresh();
        notice(created ? `AI 已生成 ${created} 张高质量闪卡${skipped ? `（跳过 ${skipped} 张重复）` : ''}` : 'AI 生成的卡片均已存在');
      } finally { button.disabled = false; }
    }
    if (button.hasAttribute('data-batch-toggle')) {
      state.batchMode = !state.batchMode;
      if (!state.batchMode) state.selectedIds.clear();
      renderCards();
    }
    if (button.dataset.selectItem) {
      const id = button.dataset.selectItem;
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
      renderCards();
    }
    if (button.hasAttribute('data-batch-all')) {
      if (state.visibleIds.length && state.selectedIds.size >= state.visibleIds.length) state.selectedIds.clear();
      else state.selectedIds = new Set(state.visibleIds);
      renderCards();
    }
    if (button.dataset.batchState && state.selectedIds.size) {
      const nextState = button.dataset.batchState;
      const ids = [...state.selectedIds];
      const { affected } = await api('/items/batch', { method: 'POST', body: { ids, action: 'learning_state', learning_state: nextState } });
      state.selectedIds.clear();
      await refresh();
      notice(`已将 ${affected} 份资料标为「${learningStates[nextState]}」`);
    }
    if (button.hasAttribute('data-batch-circles') && state.selectedIds.size) {
      const ids = [...state.selectedIds];
      modal(`将 ${ids.length} 份资料加入圈子`, circlesForm([]), async (form) => {
        const circleIdsList = form.getAll('circle');
        if (!circleIdsList.length) throw new Error('请至少选择一个圈子');
        const { affected } = await api('/items/batch', { method: 'POST', body: { ids, action: 'add_circles', circle_ids: circleIdsList } });
        state.selectedIds.clear();
        await refresh();
        notice(`已更新 ${affected} 份资料的所属圈子`);
      }, '加入圈子');
    }
    if (button.hasAttribute('data-batch-delete') && state.selectedIds.size) {
      const ids = [...state.selectedIds];
      modal('批量删除资料', `<p>确定永久删除已选中的 ${ids.length} 份资料？关联笔记、AI 提炼和本地原文件将一并清除且无法恢复。</p>`, async () => {
        const { affected } = await api('/items/batch', { method: 'POST', body: { ids, action: 'delete' } });
        state.selectedIds.clear();
        state.batchMode = false;
        await refresh();
        notice(`已删除 ${affected} 份资料`);
      }, '确认删除');
    }
    if (button.hasAttribute('data-paste-transcript') && state.reader) {
      const item = state.reader;
      modal('补充视频字幕或文稿', `<p class="muted small">支持直接粘贴 YouTube 字幕、SRT / VTT 文件内容或任意文字稿/摘要。保存后 AI 伴读和要点提炼将自动基于这份内容工作。</p>
        <label class="field">字幕或文稿内容<textarea name="transcript" class="md-editor" maxlength="500000" placeholder="例如：&#10;00:00 开场介绍…&#10;01:25 核心观点…&#10;&#10;或直接粘贴整段文字稿" required></textarea></label>`, async (form) => {
        await api(`/items/${item.id}`, { method: 'PATCH', body: { transcript: form.get('transcript') } });
        await refreshReader();
        notice('字幕/文稿已保存，后台正在进行 AI 提炼');
      }, '保存并提炼', { wide: true });
    }
    if (button.hasAttribute('data-edit-markdown') && state.reader?.type === 'markdown') {
      const item = state.reader;
      modal('编辑 Markdown 正文', `<label class="field">正文内容<textarea name="markdown" class="md-editor" maxlength="500000" required>${safe(item.raw_markdown)}</textarea></label>`, async (form) => {
        await api(`/items/${item.id}`, { method: 'PATCH', body: { markdown: form.get('markdown') } });
        await refreshReader();
        notice('正文已保存，后台将更新提炼');
      }, '保存正文', { wide: true });
    }
    if (button.hasAttribute('data-toggle-comfort') && state.reader) {
      state.relaxed = !state.relaxed;
      writeStored('lc-relaxed', state.relaxed ? '1' : '0');
      const prose = $('#prose-body');
      if (prose) prose.innerHTML = readingContent(state.reader, state.pdfView, state.relaxed);
    }
    if (button.dataset.pdfView && state.reader) {
      state.pdfView = button.dataset.pdfView;
      const prose = $('#prose-body');
      if (prose) prose.innerHTML = readingContent(state.reader, state.pdfView, state.relaxed);
    }
    if (button.dataset.rate) {
      const rate = Number(button.dataset.rate);
      player?.setRate(rate);
      for (const opt of main.querySelectorAll('[data-rate]')) {
        const active = Number(opt.dataset.rate) === rate;
        opt.classList.toggle('active', active);
        opt.setAttribute('aria-pressed', active);
      }
    }
    if (button.dataset.reviewScope) {
      state.review.scope = button.dataset.reviewScope;
      state.review.revealed = false;
      await refreshReview();
    }
    if (button.hasAttribute('data-reveal-card') && state.review.active && state.review.cards.length) {
      state.review.revealed = true;
      renderReview();
    }
    if (button.dataset.gradeCard) {
      const cardId = button.dataset.gradeCard;
      const rating = button.dataset.rating;
      button.disabled = true;
      try {
        const graded = await api(`/review/cards/${cardId}/grade`, { method: 'POST', body: { rating } });
        state.review.sessionDone += 1;
        state.review.revealed = false;
        await refresh();
        notice(`下次复习：${graded.next_label}后`);
      } finally { button.disabled = false; }
    }
    if (button.hasAttribute('data-generate-cards') && state.reader) {
      button.disabled = true;
      try {
        const { created, skipped } = await api(`/items/${state.reader.id}/cards/generate`, { method: 'POST', body: { include_notes: true } });
        await refresh();
        notice(created ? `已生成 ${created} 张复习卡片${skipped ? `（跳过 ${skipped} 张重复）` : ''}` : '所有要点与笔记均已生成卡片');
      } finally { button.disabled = false; }
    }
    if (button.dataset.cardFromPoint !== undefined && state.reader) {
      const point = state.reader.distillation?.key_points_json?.[Number(button.dataset.cardFromPoint)];
      if (point) {
        button.disabled = true;
        try {
          const src = point.sources?.[0];
          await api(`/items/${state.reader.id}/cards`, {
            method: 'POST',
            body: { front: point.title, back: point.explanation, anchor_id: src?.anchor_id ?? null, quote: src?.quote ?? null, source_kind: 'key_point' },
          });
          await refresh();
          notice('已加入复习卡片');
        } finally { button.disabled = false; }
      }
    }
    if (button.hasAttribute('data-new-card') && state.reader) {
      const item = state.reader;
      modal('新建复习卡片', `<label class="field">正面（问题 / 概念）<input name="front" maxlength="500" placeholder="例如：什么是反向传播？" required></label>
        <label class="field">背面（答案 / 要点）<textarea name="back" maxlength="5000" placeholder="写下你希望回忆起的核心解释…" required></textarea></label>`, async (form) => {
        await api(`/items/${item.id}/cards`, { method: 'POST', body: { front: form.get('front'), back: form.get('back'), source_kind: 'manual' } });
        await refresh();
        notice('复习卡片已创建');
      }, '创建卡片');
    }
    if (button.dataset.editCard) {
      const cardId = button.dataset.editCard;
      const card = state.reader?.cards?.find(({ id }) => id === cardId) ?? state.review.cards.find(({ id }) => id === cardId);
      if (card) {
        modal('编辑复习卡片', `<label class="field">正面（问题 / 概念）<input name="front" maxlength="500" value="${safe(card.front)}" required></label>
          <label class="field">背面（答案 / 要点）<textarea name="back" maxlength="5000" required>${safe(card.back)}</textarea></label>`, async (form) => {
          await api(`/review/cards/${card.id}`, { method: 'PATCH', body: { front: form.get('front'), back: form.get('back') } });
          await refresh();
          notice('卡片已更新');
        }, '保存修改');
      }
    }
    if (button.dataset.deleteCard) {
      const cardId = button.dataset.deleteCard;
      modal('删除复习卡片', '<p>确定删除这张复习卡片？不会影响原资料和笔记。</p>', async () => {
        await api(`/review/cards/${cardId}`, { method: 'DELETE' });
        await refresh();
        notice('卡片已删除');
      }, '删除卡片');
    }
    if (button.dataset.readerTab) setReaderTab(button.dataset.readerTab);
    if (button.dataset.add) addDialog(button.dataset.add);
    if (button.hasAttribute('data-new-circle')) circleDialog();
    if (button.hasAttribute('data-smart-classify')) await openSmartClassifyDialog();
    if (button.dataset.pickCat) {
      const input = $('input[name="category"]', editor);
      if (input) { input.value = button.dataset.pickCat; input.focus(); }
    }
    if (button.dataset.applyCircleRules) {
      const cid = button.dataset.applyCircleRules;
      button.disabled = true;
      try {
        const { added } = await api(`/circles/${cid}/apply-rules`, { method: 'POST' });
        await refresh();
        notice(added ? `已智能匹配并归入 ${added} 份资料` : '当前没有新的匹配资料');
      } finally { button.disabled = false; }
    }
    if (button.hasAttribute('data-circle-menu')) circleMenu();
    if (button.hasAttribute('data-extension')) await openExtensionDialog();
    if (button.hasAttribute('data-associate') && state.reader) {
      const item = state.reader;
      modal('管理所属圈子', circlesForm(item.circle_ids), async (form) => {
        await api(`/items/${item.id}/circles`, { method: 'PATCH', body: { circle_ids: form.getAll('circle') } });
        await refresh();
      });
    }
    if (button.dataset.anchor) jump(button.dataset.anchor);
    if (button.dataset.seek) jump(button.id);
    if (button.dataset.retry) {
      button.disabled = true;
      try {
        await api(`/items/${state.item}/retry`, { method: 'POST', body: { kind: button.dataset.retry } });
        await refreshReader();
        if (button.dataset.retry === 'distill') notice('已启动 AI 智能分析，完成后自动更新');
        else if (button.dataset.retry === 'parse') notice('正在重新解析资料与字幕…');
      } finally { button.disabled = false; }
    }
  } catch (error) { notice(error.message); }
});

window.addEventListener('scroll', () => {
  if (!state.item) return;
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    const bar = $('#read-progress');
    if (!bar) return;
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
    bar.style.width = `${(ratio * 100).toFixed(1)}%`;
  });
}, { passive: true });

window.addEventListener('keydown', (event) => {
  const inInput = Boolean(event.target.closest?.('input, textarea, select, [contenteditable]'));
  const shortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
  const slash = event.key === '/' && !inInput;
  if (!editor.open && (event.metaKey || event.ctrlKey) && event.key === '.' && state.reader) {
    event.preventDefault();
    state.readerAi.open = !state.readerAi.open;
    writeStored('lc-reader-ai-open', state.readerAi.open ? '1' : '0');
    renderReaderAi();
    if (state.readerAi.open) {
      loadReaderAi(state.reader.id).then(() => $('#reader-ai-input')?.focus()).catch((error) => notice(error.message));
    }
    return;
  }
  if (!editor.open && (shortcut || slash)) {
    event.preventDefault();
    if (state.item || state.review.active || state.ask.active) navigate('/');
    $('#search')?.focus();
    return;
  }
  if (!editor.open && !inInput && state.review.active && state.review.scope === 'due' && state.review.cards.length) {
    if (!state.review.revealed && (event.code === 'Space' || event.key === 'Enter')) {
      event.preventDefault();
      state.review.revealed = true;
      renderReview();
    } else if (state.review.revealed && ['1', '2', '3', '4'].includes(event.key)) {
      event.preventDefault();
      const map = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
      $(`[data-grade-card][data-rating="${map[event.key]}"]`, main)?.click();
    }
  }
});
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!state.item && event.dataTransfer.types.includes('Files')) {
    event.preventDefault();
    dragDepth++;
    $('#drag-banner').hidden = false;
  }
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drag-banner').hidden = true;
});
window.addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  dragDepth = 0;
  $('#drag-banner').hidden = true;
  const [file] = event.dataTransfer.files;
  if (!file) return;
  event.preventDefault();
  if (!state.item && $('#resources')) addDialog('upload', file);
});

async function openExtensionDialog() {
  const info = await api('/system/extension').catch(() => ({ ready: false, version: '1.2.0', path: 'dist/extension', can_open_folder: false }));
  const origin = location.origin;
  const bookmarklet = `javascript:(function(){window.open('${origin}/?save='+encodeURIComponent(location.href),'_blank');})();`;
  const folderLabel = info.platform === 'darwin' ? '访达 (Finder)' : '文件夹';
  const body = `
    <div class="ext-hero">
      <div class="ext-hero-meta">
        <span class="ext-status-badge"><i class="status-pill-dot ${info.ready ? 'ok' : 'warn'}"></i>v${safe(info.version)} · ${info.ready ? '已就绪' : '需构建'}</span>
        <span class="muted small">快捷键 ${/Mac/.test(navigator.platform) ? '⌘⇧S' : 'Alt+Shift+S'} 一键剪藏</span>
      </div>
      ${info.can_open_folder && info.ready
        ? `<button type="button" class="btn primary ext-primary-btn" id="ext-assist-btn">${icon.sparkle}一键打开 Chrome 扩展页并定位插件</button>`
        : `<a class="btn primary ext-primary-btn" href="/api/system/extension/download" download>${icon.download}下载扩展压缩包（ZIP）</a>`}
      <p id="ext-assist-status" class="ext-assist-status muted" hidden></p>
    </div>
    <p class="ext-oneliner">点击上方按钮将<b>自动打开 Chrome 扩展管理页并弹出插件文件夹</b>：确认右上角已开启「开发者模式」，将弹出的 <code>extension</code> 文件夹<b>直接拖进 Chrome 页面</b>即可完成安装（受 Chrome 安全机制限制，本地未上架扩展需手动拖入确认一次）。</p>
    <div class="ext-util-row">
      <button type="button" class="text-btn ai-inline-btn" id="ext-copy-path">${icon.copy}复制插件路径</button>
      <button type="button" class="text-btn ai-inline-btn" id="ext-copy-url">${icon.link}复制 chrome://extensions</button>
      <a class="text-btn ai-inline-btn" href="/api/system/extension/download" download>${icon.download}下载 ZIP</a>
    </div>
    <div class="ext-bookmarklet-box">
      <div class="ext-bm-copy">
        <strong>免安装方案 · 一键书签</strong>
        <small>把右侧按钮拖到任意浏览器书签栏，无需安装扩展，点击即收藏当前网页</small>
      </div>
      <a class="bookmarklet-pill" href="${safe(bookmarklet)}" draggable="true" onclick="event.preventDefault()">${icon.bookmarkPlus}收藏到学习中心</a>
    </div>`;
  modal('安装浏览器扩展', body, () => {}, '完成', { compact: true, hideCancel: true });

  const statusNode = $('#ext-assist-status', editor);
  const showStatus = (msg, ok = true) => {
    if (!statusNode) return;
    statusNode.textContent = msg;
    statusNode.className = `ext-assist-status ${ok ? 'text-success' : 'text-danger'}`;
    statusNode.hidden = false;
  };
  const assistBtn = $('#ext-assist-btn', editor);
  if (assistBtn) {
    assistBtn.onclick = async () => {
      assistBtn.disabled = true;
      showStatus('正在自动打开 Chrome 扩展页并定位插件文件夹…', true);
      try {
        const res = await api('/system/extension/open', { method: 'POST', body: { action: 'assist' } });
        if (res.chrome_opened) {
          await navigator.clipboard?.writeText(res.path || info.path).catch(() => {});
          showStatus(`✓ 已自动在 ${res.browser_name} 打开扩展页，并在${folderLabel}选中 extension 文件夹（路径也已复制），直接拖入 Chrome 即可！`);
        } else {
          await navigator.clipboard?.writeText('chrome://extensions').catch(() => {});
          showStatus(`✓ 已在${folderLabel}选中 extension 文件夹并复制 chrome://extensions（请在 Chrome 地址栏粘贴打开后拖入；若弹出系统自动化授权请点允许）`);
        }
      } catch (error) {
        showStatus(error.message, false);
      } finally { assistBtn.disabled = false; }
    };
  }
  const copyUrlBtn = $('#ext-copy-url', editor);
  if (copyUrlBtn) {
    copyUrlBtn.onclick = async () => {
      await navigator.clipboard?.writeText('chrome://extensions');
      showStatus('✓ 已复制 chrome://extensions，直接粘贴到 Chrome 地址栏');
    };
  }
  const copyPathBtn = $('#ext-copy-path', editor);
  if (copyPathBtn) {
    copyPathBtn.onclick = async () => {
      await navigator.clipboard?.writeText(info.path);
      showStatus(`✓ 已复制路径：${info.path}`);
    };
  }
}

async function start() {
  try {
    await loadCircles();
    route();
    const saveUrl = new URLSearchParams(location.search).get('save');
    if (saveUrl && /^https?:\/\//i.test(saveUrl)) {
      history.replaceState({}, '', '/');
      addDialog('url', null, undefined, saveUrl);
    }
    if (!stream) {
      stream = new EventSource('/api/events');
      stream.onmessage = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refresh(true).catch((error) => notice(error.message)), 120);
      };
    }
  } catch (error) {
    main.innerHTML = '<div class="state-panel"><h1>学习中心</h1></div>';
    if (error.status === 401) modal('进入学习中心', '<label class="field">访问令牌<input name="token" type="password" required></label>', async (form) => {
      await api('/login', { method: 'POST', body: Object.fromEntries(form) });
      await start();
    }, '登录');
    else notice(error.message);
  } finally { main.removeAttribute('aria-busy'); }
}

start();
