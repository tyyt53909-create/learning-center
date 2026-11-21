import { lookup } from 'node:dns/promises';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';

export function sourceUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('请输入有效的 HTTP 或 HTTPS 链接（使用默认端口）');
  }
  url.hash = '';
  return url;
}

export function videoSource(url) {
  const host = url.hostname;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(host)) {
    const parts = url.pathname.split('/');
    const id = host === 'youtu.be' ? parts[1] : ['embed', 'shorts', 'live'].includes(parts[1]) ? parts[2] : url.searchParams.get('v');
    if (/^[\w-]{11}$/.test(id ?? '')) return { platform: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host)) {
    const id = url.pathname.match(/^\/video\/(BV[\da-z]+|av\d+)(?:\/|$)/i)?.[1];
    if (id) {
      const videoId = id.slice(0, 2).toLowerCase() === 'av' ? id.toLowerCase() : `BV${id.slice(2)}`;
      const page = Math.max(1, Number.parseInt(url.searchParams.get('p'), 10) || 1);
      return { platform: 'bilibili', videoId, page, url: `https://www.bilibili.com/video/${videoId}${page > 1 ? `?p=${page}` : ''}` };
    }
  }
}

export async function fetchPage(start) {
  let url = sourceUrl(start);
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = AbortSignal.any([signal]);
    const resolved = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise((_, reject) => addresses.addEventListener('abort', () => reject(addresses.reason), { once: true })),
    ]);
    const target = resolved[0];
    if (!target || resolved.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
      throw new Error('链接必须指向公网网页');
    }
    const agent = new Agent({ connect: { lookup: (_host, options, callback) => {
      if (options.all) callback(null, [target]);
      else callback(null, target.address, target.family);
    } } });
    try {
      const response = await fetch(url, { dispatcher: agent, signal, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = sourceUrl(new URL(location, url));
        continue;
      }
      if (!response.ok) throw new Error(`原站返回 HTTP ${response.status}，可使用插件保存当前页面`);
      if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '')) {
        throw new Error('此链接未返回可解析的网页');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 5_000_000) throw new Error('网页内容超过解析大小限制');
        chunks.push(chunk);
      }
      return { url: url.href, html: Buffer.concat(chunks) };
    } finally {
      await agent.destroy();
    }
  }
  throw new Error('原站重定向次数过多');
}
