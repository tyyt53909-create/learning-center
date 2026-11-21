const defaults = { endpoint: 'http://127.0.0.1:3000', token: '', selected: [] };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-page', title: '保存当前页到学习中心', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'save-selection', title: '保存选中内容到学习中心', contexts: ['selection'] });
  });
});

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 3000);
}

async function request(config, path, body) {
  const response = await fetch(`${config.endpoint}${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !/^https?:\/\//.test(tab.url ?? '')) return;
  try {
    const config = await chrome.storage.local.get(defaults);
    let circleIds = Array.isArray(config.selected) ? config.selected : [];
    const circles = await request(config, '/api/items/url');
    const validSet = new Set(circles.map((c) => c.id));
    circleIds = circleIds.filter((id) => validSet.has(id));
    if (!circleIds.length && circles.length) circleIds = [circles[0].id];
    if (!circleIds.length) {
      flashBadge(tab.id, '!', '#dc2626');
      return;
    }

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const captured = globalThis.learningCenterCapture;
        delete globalThis.learningCenterCapture;
        return captured;
      },
    });
    const useSelection = info.menuItemId === 'save-selection' && result?.selectionMarkdown;
    const markdown = useSelection ? result.selectionMarkdown : result?.markdown;
    await request(config, '/api/items/url', {
      url: result?.url || tab.url,
      title: result?.title || tab.title,
      markdown: markdown?.slice(0, 450_000),
      circle_ids: circleIds,
    });
    flashBadge(tab.id, '✓', '#16a34a');
  } catch {
    flashBadge(tab.id, '!', '#dc2626');
  }
});
