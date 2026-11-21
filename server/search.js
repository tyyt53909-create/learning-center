import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { fetchPage, sourceUrl } from './source.js';

const hasProxyEnv = () => Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy);
let searchProxyAgent;
function searchFetch(url, options) {
  if (!hasProxyEnv()) return fetch(url, options);
  if (!searchProxyAgent) searchProxyAgent = new EnvHttpProxyAgent();
  return undiciFetch(url, { ...options, dispatcher: searchProxyAgent });
}

export const searchProviders = new Set(['duckduckgo', 'tavily', 'brave', 'serper', 'searxng', 'custom']);

export function extractUrlsFromText(text) {
  if (typeof text !== 'string') return [];
  const matches = text.match(/https?:\/\/[^\s<>()[\]"'，。！？；：]+/gi) ?? [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    try {
      const url = sourceUrl(raw.replace(/[.,;:!?)]+$/, ''));
      if (!seen.has(url.href)) {
        seen.add(url.href);
        out.push(url.href);
      }
      if (out.length >= 2) break;
    } catch { /* ignore invalid url */ }
  }
  return out;
}

function cleanSnippet(value, max = 320) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeUrl(raw) {
  try {
    const u = sourceUrl(raw);
    return { url: u.href, hostname: u.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

async function readPublicUrl(rawUrl) {
  try {
    const page = await fetchPage(rawUrl);
    const dom = new JSDOM(page.html, { url: page.url });
    try {
      const doc = new Readability(dom.window.document).parse();
      const text = cleanSnippet(doc?.textContent || dom.window.document.body?.textContent || '', 1800);
      const title = cleanSnippet(doc?.title || dom.window.document.title || new URL(page.url).hostname, 160);
      return { url: page.url, title, text };
    } finally {
      dom.window.close();
    }
  } catch {
    return null;
  }
}

function unwrapDuckUrl(href) {
  if (!href) return '';
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg || parsed.href;
  } catch {
    return href;
  }
}

async function searchDuckDuckGo(query, limit) {
  const response = await searchFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(12_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
  });
  if (!response.ok) throw new Error(`DuckDuckGo 返回 HTTP ${response.status}`);
  const html = await response.text();
  const dom = new JSDOM(html);
  try {
    const nodes = [...dom.window.document.querySelectorAll('.result')];
    const items = [];
    for (const node of nodes) {
      const link = node.querySelector('a.result__a');
      if (!link) continue;
      const resolved = normalizeUrl(unwrapDuckUrl(link.getAttribute('href')));
      if (!resolved) continue;
      const title = cleanSnippet(link.textContent, 160) || resolved.hostname;
      const snippet = cleanSnippet(node.querySelector('.result__snippet')?.textContent, 360);
      items.push({ ...resolved, title, snippet, content: snippet });
      if (items.length >= limit) break;
    }
    return items;
  } finally {
    dom.window.close();
  }
}

async function searchTavily(query, config, limit) {
  if (!config.searchKey) throw new Error('使用 Tavily 搜索需要填写搜索 API Key');
  const endpoint = (config.searchBase || 'https://api.tavily.com/search').replace(/\/+$/, '');
  const response = await searchFetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(12_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.searchKey, query, max_results: limit, search_depth: 'basic', include_raw_content: false }),
  });
  if (!response.ok) throw new Error(`Tavily 搜索返回 HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.results ?? []).flatMap((entry) => {
    const resolved = normalizeUrl(entry?.url);
    if (!resolved) return [];
    const content = cleanSnippet(entry?.content || entry?.snippet, 1200);
    return [{ ...resolved, title: cleanSnippet(entry?.title, 160) || resolved.hostname, snippet: content.slice(0, 320), content }];
  }).slice(0, limit);
}

async function searchBrave(query, config, limit) {
  if (!config.searchKey) throw new Error('使用 Brave 搜索需要填写搜索 API Key');
  const base = (config.searchBase || 'https://api.search.brave.com/res/v1/web/search').replace(/\/+$/, '');
  const url = `${base}?q=${encodeURIComponent(query)}&count=${limit}`;
  const response = await searchFetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/json', 'X-Subscription-Token': config.searchKey },
  });
  if (!response.ok) throw new Error(`Brave 搜索返回 HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.web?.results ?? []).flatMap((entry) => {
    const resolved = normalizeUrl(entry?.url);
    if (!resolved) return [];
    const snippet = cleanSnippet(entry?.description, 400);
    return [{ ...resolved, title: cleanSnippet(entry?.title, 160) || resolved.hostname, snippet, content: snippet }];
  }).slice(0, limit);
}

async function searchSerper(query, config, limit) {
  if (!config.searchKey) throw new Error('使用 Serper 搜索需要填写搜索 API Key');
  const endpoint = (config.searchBase || 'https://google.serper.dev/search').replace(/\/+$/, '');
  const response = await searchFetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(12_000),
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': config.searchKey },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!response.ok) throw new Error(`Serper 搜索返回 HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.organic ?? []).flatMap((entry) => {
    const resolved = normalizeUrl(entry?.link);
    if (!resolved) return [];
    const snippet = cleanSnippet(entry?.snippet, 400);
    return [{ ...resolved, title: cleanSnippet(entry?.title, 160) || resolved.hostname, snippet, content: snippet }];
  }).slice(0, limit);
}

async function searchSearxngOrCustom(query, config, limit, provider) {
  if (!config.searchBase) throw new Error(`请先填写 ${provider === 'searxng' ? 'SearXNG' : '自定义搜索'} 接口地址`);
  const base = config.searchBase.replace(/\/+$/, '');
  const target = new URL(provider === 'searxng' && !base.endsWith('/search') ? `${base}/search` : base);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('搜索接口地址需使用 HTTP 或 HTTPS');
  target.searchParams.set('q', query);
  if (provider === 'searxng') target.searchParams.set('format', 'json');
  const response = await searchFetch(target, {
    signal: AbortSignal.timeout(12_000),
    headers: {
      Accept: 'application/json',
      ...(config.searchKey ? { Authorization: `Bearer ${config.searchKey}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`搜索接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  const list = Array.isArray(payload) ? payload : (payload.results ?? payload.items ?? payload.organic ?? []);
  return list.flatMap((entry) => {
    const resolved = normalizeUrl(entry?.url || entry?.link);
    if (!resolved) return [];
    const content = cleanSnippet(entry?.content || entry?.snippet || entry?.description, 1200);
    return [{ ...resolved, title: cleanSnippet(entry?.title, 160) || resolved.hostname, snippet: content.slice(0, 320), content }];
  }).slice(0, limit);
}

export async function runWebSearch(query, config = {}, { limit = 5, enrich = true } = {}) {
  const provider = searchProviders.has(config.searchProvider) ? config.searchProvider : 'duckduckgo';
  const results = [];
  const seenUrls = new Set();
  const push = (entry) => {
    if (!entry?.url || seenUrls.has(entry.url)) return;
    seenUrls.add(entry.url);
    results.push(entry);
  };

  // 1. Read any explicit public URLs included in the user's question via SSRF-safe fetchPage
  const explicitUrls = extractUrlsFromText(query);
  if (explicitUrls.length) {
    const fetched = await Promise.all(explicitUrls.map((url) => readPublicUrl(url)));
    for (const page of fetched) {
      if (!page?.text) continue;
      const resolved = normalizeUrl(page.url);
      if (resolved) push({ ...resolved, title: page.title, snippet: page.text.slice(0, 260), content: page.text });
    }
  }

  // 2. Run search engine query
  const searchQuery = query.replace(/https?:\/\/\S+/gi, ' ').trim() || query;
  let searchHits = [];
  if (searchQuery) {
    if (provider === 'tavily') searchHits = await searchTavily(searchQuery, config, limit);
    else if (provider === 'brave') searchHits = await searchBrave(searchQuery, config, limit);
    else if (provider === 'serper') searchHits = await searchSerper(searchQuery, config, limit);
    else if (provider === 'searxng' || provider === 'custom') searchHits = await searchSearxngOrCustom(searchQuery, config, limit, provider);
    else searchHits = await searchDuckDuckGo(searchQuery, limit);
  }
  searchHits.forEach(push);

  // 3. Best-effort Readability enrichment on top 2 short-snippet results via SSRF-safe fetchPage
  const trimmed = results.slice(0, limit);
  if (enrich) {
    const needRead = trimmed.filter((item) => item.content.length < 400).slice(0, 2);
    if (needRead.length) {
      await Promise.allSettled(needRead.map(async (item) => {
        const page = await Promise.race([
          readPublicUrl(item.url),
          new Promise((resolve) => setTimeout(() => resolve(null), 6_000)),
        ]);
        if (page?.text && page.text.length > item.content.length) {
          item.content = `${item.snippet ? `${item.snippet}\n` : ''}${page.text}`.slice(0, 1800);
        }
      }));
    }
  }

  return trimmed.map((item, index) => ({
    id: `web-${index + 1}`,
    url: item.url,
    hostname: item.hostname,
    title: item.title,
    snippet: item.snippet || item.content.slice(0, 260),
    content: item.content || item.snippet || item.title,
  }));
}

export async function testSearchConnection(config = {}) {
  const provider = searchProviders.has(config.searchProvider) ? config.searchProvider : 'duckduckgo';
  const start = Date.now();
  try {
    const results = await runWebSearch('OpenAI', config, { limit: 2, enrich: false });
    return { ok: true, provider, count: results.length, latencyMs: Date.now() - start };
  } catch (error) {
    return { ok: false, provider, latencyMs: Date.now() - start, error: error.message };
  }
}
