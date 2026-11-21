const $ = (id) => document.getElementById(id);
const settings = $('settings');
const captureForm = $('capture');
const saveButton = $('save');
const titleInput = $('title-input');
const noteInput = $('note-input');
const tabPromise = chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => active);
const initial = { endpoint: 'http://127.0.0.1:3000', token: '', selected: [] };
const stateLabels = { inbox: '待读', learning: '学习中', mastered: '已掌握' };

let config = initial;
let pageData = null;
let existingItem = null;
let savedItemId = null;
let captureMode = 'full';
let learningState = 'inbox';

function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error('请输入本地 HTTP 服务地址，例如 http://127.0.0.1:3000');
  }
  return url.origin;
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(`${config.endpoint}${path}`, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(10_000),
      headers: {
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接学习中心，请确认本地服务已启动');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '无法连接学习中心');
  return result;
}

function setStatus(ok, text) {
  const node = $('conn-status');
  node.textContent = text;
  node.className = `status-dot ${ok ? 'ok' : 'err'}`;
}

function showMessage(text, { error = false, openId = null } = {}) {
  const bar = $('result-bar');
  const msg = $('message');
  const openBtn = $('open-saved');
  if (!text) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  msg.textContent = text;
  msg.classList.toggle('error', error);
  savedItemId = openId;
  openBtn.hidden = !openId;
}

function setLearningState(next) {
  learningState = next;
  for (const btn of document.querySelectorAll('[data-state]')) {
    const active = btn.dataset.state === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active);
  }
}

function updatePreview() {
  const preview = $('capture-preview');
  const typePill = $('page-type');
  if (!pageData) {
    preview.textContent = '保存时将提交当前链接给本地服务解析。';
    return;
  }
  if (pageData.isVideo) {
    typePill.textContent = pageData.videoPlatform === 'youtube' ? 'YouTube 视频' : '哔哩哔哩视频';
    typePill.className = 'pill video';
    preview.textContent = '将保存视频链接并在后台自动获取平台字幕。';
    return;
  }
  typePill.textContent = captureMode === 'selection' ? '选中摘录' : '网页正文';
  typePill.className = 'pill';
  if (captureMode === 'selection' && pageData.selectionText) {
    preview.textContent = `已选 ${pageData.selectionText.length} 字：${pageData.selectionText.slice(0, 120)}`;
  } else if (pageData.charCount > 0) {
    preview.textContent = `已提取正文约 ${pageData.charCount} 字：${pageData.excerpt}`;
  } else {
    preview.textContent = '未在当前页识别到明显正文，将尝试由本地服务抓取。';
  }
}

function renderCircles(circles, preselected) {
  const box = $('circles');
  box.replaceChildren();
  if (!circles.length) {
    const empty = document.createElement('p');
    empty.className = 'preview';
    empty.textContent = '还没有圈子，点击右上角「+ 新建圈子」即可创建。';
    box.append(empty);
    saveButton.disabled = true;
    return;
  }
  for (const { id, name } of circles) {
    const label = document.createElement('label');
    label.className = 'circle-pill';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'circle';
    input.value = id;
    input.checked = preselected.includes(id);
    label.append(input, document.createTextNode(name));
    box.append(label);
  }
  if (!captureForm.querySelector('input[name="circle"]:checked')) {
    captureForm.querySelector('input[name="circle"]').checked = true;
  }
  saveButton.disabled = false;
}

async function inspectActiveTab(active) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: active.id }, files: ['capture.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: active.id },
      func: () => {
        const captured = globalThis.learningCenterCapture;
        delete globalThis.learningCenterCapture;
        return captured;
      },
    });
    return result ?? null;
  } catch {
    return null;
  }
}

async function load() {
  saveButton.disabled = true;
  showMessage('');
  $('existing-banner').hidden = true;
  const active = await tabPromise;
  if (!/^https?:\/\//.test(active?.url ?? '')) {
    setStatus(false, '不支持当前页面');
    throw new Error('请先打开要保存的 HTTP/HTTPS 网页');
  }
  $('page-host').textContent = new URL(active.url).hostname;
  titleInput.value = active.title || new URL(active.url).hostname;

  const [captured, serverInfo] = await Promise.all([
    inspectActiveTab(active),
    api(`/api/items/url?url=${encodeURIComponent(active.url)}`),
  ]);
  setStatus(true, '已连接本地服务');

  pageData = captured;
  if (captured?.title) titleInput.value = captured.title;
  if (captured?.selectionText && !captured.isVideo) {
    $('mode-switch').hidden = false;
    $('mode-selection-btn').textContent = `选中内容 (${captured.selectionText.length} 字)`;
    captureMode = 'selection';
    for (const seg of document.querySelectorAll('[data-mode]')) {
      const activeSeg = seg.dataset.mode === captureMode;
      seg.classList.toggle('active', activeSeg);
      seg.setAttribute('aria-pressed', activeSeg);
    }
  } else {
    $('mode-switch').hidden = true;
    captureMode = 'full';
  }
  updatePreview();

  const circles = Array.isArray(serverInfo) ? serverInfo : (serverInfo.circles ?? []);
  existingItem = Array.isArray(serverInfo) ? null : (serverInfo.existing ?? null);
  if (existingItem) {
    $('existing-banner').hidden = false;
    $('existing-text').textContent = `已在学习中心 · ${stateLabels[existingItem.learning_state] ?? '待读'}`;
    if (existingItem.title) titleInput.value = existingItem.title;
    setLearningState(existingItem.learning_state || 'inbox');
    saveButton.textContent = '更新圈子与笔记';
  } else {
    setLearningState('inbox');
    saveButton.textContent = '保存到学习中心';
  }
  const preferred = existingItem?.circle_ids?.length ? existingItem.circle_ids : config.selected;
  renderCircles(circles, preferred);
}

$('open-app').onclick = () => chrome.tabs.create({ url: config.endpoint });
$('open-existing').onclick = () => { if (existingItem?.id) chrome.tabs.create({ url: `${config.endpoint}/reader/${existingItem.id}` }); };
$('open-saved').onclick = () => { if (savedItemId) chrome.tabs.create({ url: `${config.endpoint}/reader/${savedItemId}` }); };

document.addEventListener('click', (event) => {
  const modeBtn = event.target.closest('[data-mode]');
  if (modeBtn) {
    captureMode = modeBtn.dataset.mode;
    for (const seg of document.querySelectorAll('[data-mode]')) {
      const active = seg.dataset.mode === captureMode;
      seg.classList.toggle('active', active);
      seg.setAttribute('aria-pressed', active);
    }
    updatePreview();
  }
  const stateBtn = event.target.closest('[data-state]');
  if (stateBtn) setLearningState(stateBtn.dataset.state);
});

$('toggle-new-circle').onclick = () => {
  const row = $('new-circle-row');
  row.hidden = !row.hidden;
  if (!row.hidden) $('new-circle-name').focus();
};

$('create-circle-btn').onclick = async () => {
  const input = $('new-circle-name');
  const name = input.value.trim();
  if (!name) return;
  const btn = $('create-circle-btn');
  btn.disabled = true;
  try {
    const created = await api('/api/circles', { name });
    input.value = '';
    $('new-circle-row').hidden = true;
    const currentSelected = [...new FormData(captureForm).getAll('circle'), created.id];
    const circles = await api('/api/circles');
    renderCircles(circles, currentSelected);
    showMessage(`已创建圈子「${created.name}」`);
  } catch (error) {
    showMessage(error.message, { error: true });
  } finally {
    btn.disabled = false;
  }
};

settings.onsubmit = async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(settings);
    config = { ...config, endpoint: normalizeEndpoint(form.get('endpoint')), token: form.get('token').trim() };
    await chrome.storage.local.set(config);
    $('settings-box').open = false;
    await load();
  } catch (error) {
    setStatus(false, '连接失败');
    showMessage(error.message, { error: true });
  }
};

captureForm.onsubmit = async (event) => {
  event.preventDefault();
  const selected = new FormData(captureForm).getAll('circle');
  if (!selected.length) {
    showMessage('请至少选择一个圈子', { error: true });
    return;
  }
  saveButton.disabled = true;
  showMessage('正在保存…');
  try {
    const active = await tabPromise;
    const latest = pageData ?? await inspectActiveTab(active);
    const chosenMarkdown = captureMode === 'selection' && latest?.selectionMarkdown
      ? latest.selectionMarkdown
      : latest?.markdown;
    const payload = {
      url: latest?.url || active.url,
      title: titleInput.value.trim() || latest?.title || active.title,
      markdown: latest?.isVideo ? '' : chosenMarkdown?.slice(0, 450_000),
      circle_ids: selected,
      learning_state: learningState,
      note: noteInput.value.trim(),
    };
    const saved = await api('/api/items/url', payload);
    config.selected = selected;
    await chrome.storage.local.set({ selected });
    noteInput.value = '';
    existingItem = { ...(existingItem ?? {}), id: saved.id, learning_state: learningState, circle_ids: selected };
    $('existing-banner').hidden = false;
    $('existing-text').textContent = `已在学习中心 · ${stateLabels[learningState]}`;
    saveButton.textContent = '更新圈子与笔记';
    showMessage(saved.created === false ? '已更新资料圈子与笔记' : '已保存，后台正在解析提炼', { openId: saved.id });
  } catch (error) {
    showMessage(error.message, { error: true });
  } finally {
    saveButton.disabled = false;
  }
};

chrome.storage.local.get(initial).then((stored) => {
  config = stored;
  settings.elements.endpoint.value = config.endpoint;
  settings.elements.token.value = config.token;
  return load();
}).catch((error) => {
  setStatus(false, '未连接服务');
  showMessage(error.message, { error: true });
});
