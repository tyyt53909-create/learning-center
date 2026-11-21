import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { extractText } from 'unpdf';
import { fetchPage, videoSource } from './source.js';
import { markdownAnchors } from './markdown.js';

const run = promisify(execFile);
const transcriber = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
const hasProxyEnv = () => Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy);
let ytProxyAgent;
function ytFetch(url, options = {}) {
  if (!hasProxyEnv()) return fetch(url, options);
  if (!ytProxyAgent) ytProxyAgent = new EnvHttpProxyAgent();
  return undiciFetch(url, { ...options, dispatcher: ytProxyAgent });
}

export function timedAnchors(id, cues) {
  return cues.flatMap(({ start, end, text }, index) => {
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start || !text?.trim()) return [];
    return [{ id: `${id}-cue-${index}`, text: text.trim(), anchor_meta: { start, end } }];
  });
}

function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const preferred = ['zh-hans', 'zh-cn', 'zh-hant', 'zh-tw', 'zh', 'en', 'en-us'];
  for (const lang of preferred) {
    const manual = tracks.find((t) => t.languageCode?.toLowerCase() === lang && t.kind !== 'asr');
    if (manual) return manual;
    const any = tracks.find((t) => t.languageCode?.toLowerCase() === lang);
    if (any) return any;
  }
  const zhPrefix = tracks.find((t) => t.languageCode?.toLowerCase().startsWith('zh'));
  return zhPrefix ?? tracks[0];
}

async function fetchYouTubeDirect(videoId) {
  const watchRes = await ytFetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!watchRes.ok) throw new Error(`YouTube HTTP ${watchRes.status}`);
  const html = await watchRes.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  if (!apiKey) throw new Error('未获取到 YouTube 页面元数据');
  const playerRes = await ytFetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
    },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'zh-CN', gl: 'US', androidSdkVersion: 34 } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!playerRes.ok) throw new Error(`YouTube Player HTTP ${playerRes.status}`);
  const data = await playerRes.json();
  const details = data?.videoDetails ?? {};
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const chosen = pickCaptionTrack(tracks);
  let cues = [];
  if (chosen?.baseUrl) {
    const capUrl = new URL(chosen.baseUrl);
    capUrl.searchParams.set('fmt', 'json3');
    const capRes = await ytFetch(capUrl.toString(), { signal: AbortSignal.timeout(15_000) });
    if (capRes.ok) {
      const capText = await capRes.text();
      if (capText.trim()) cues = parseSubtitle('caption.json3', capText);
    }
  }
  const duration = Number(details.lengthSeconds);
  return {
    title: typeof details.title === 'string' && details.title.trim() ? details.title.trim() : null,
    author: typeof details.author === 'string' && details.author.trim() ? details.author.trim() : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    description: typeof details.shortDescription === 'string' ? details.shortDescription.trim().slice(0, 3000) : '',
    cues,
    noTracks: data?.playabilityStatus?.status === 'OK' && tracks.length === 0,
  };
}

export function parseTranscriptInput(id, rawText) {
  const clean = String(rawText ?? '').replaceAll('\0', '\uFFFD').trim();
  if (!clean) return [];
  if (/[\t ]+-->[\t ]+/.test(clean)) {
    const cues = parseSubtitle('manual.srt', clean);
    const timed = timedAnchors(id, cues);
    if (timed.length) return timed;
  }
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tsOnly = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?$/;
  const tsInline = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?[\s\-–—:：]+(.+)$/;
  const timedCues = [];
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(tsInline);
    if (inline) {
      const start = subtitleSeconds(inline[1]);
      timedCues.push({ start, end: start + 5, text: inline[2].trim() });
    } else if (tsOnly.test(lines[i]) && i + 1 < lines.length && !tsOnly.test(lines[i + 1])) {
      const start = subtitleSeconds(lines[i].match(tsOnly)[1]);
      timedCues.push({ start, end: start + 5, text: lines[++i] });
    }
  }
  if (timedCues.length >= 2) {
    for (let i = 0; i < timedCues.length - 1; i++) {
      timedCues[i].end = Math.max(timedCues[i].start, timedCues[i + 1].start);
    }
    return timedAnchors(id, timedCues);
  }
  const blocks = clean.split(/\r?\n\s*\r?\n/).map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const chunks = blocks.length >= 2 ? blocks : lines;
  return chunks.flatMap((part, index) => {
    const slice = part.slice(0, 1200).trim();
    if (!slice) return [];
    return [{ id: `${id}-cue-${index}`, text: slice, anchor_meta: { start: index * 10, end: (index + 1) * 10, untimed: true } }];
  });
}

async function remoteVideo(item) {
  const { platform, videoId, page } = videoSource(new URL(item.source_url));
  const metadata = { platform, videoId, page };
  let resolvedTitle = item.title;
  let directNoTracks = false;
  if (platform === 'youtube') {
    try {
      const yt = await fetchYouTubeDirect(videoId);
      if (yt.title) resolvedTitle = yt.title;
      if (yt.author) metadata.author = yt.author;
      if (yt.duration) metadata.duration = yt.duration;
      if (yt.description) metadata.description = yt.description;
      directNoTracks = yt.noTracks;
      if (yt.cues.length) {
        return { title: resolvedTitle, metadata, anchors: timedAnchors(item.id, yt.cues) };
      }
    } catch { /* fall through to yt-dlp if available */ }
  }
  const directory = await mkdtemp(join(tmpdir(), 'learning-captions-'));
  try {
    const { stdout } = await run(process.env.YT_DLP || 'yt-dlp', [
      '--ignore-config', '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs',
      '--sub-langs', 'zh-Hans,zh-Hant,zh-CN,zh-TW,zh,en,en-US', '--sub-format', 'json3/vtt/srt',
      '--no-simulate', '--dump-json', '-o', join(directory, 'caption.%(ext)s'), '--', item.source_url,
    ], { timeout: 90_000, maxBuffer: 20_000_000 });
    const info = JSON.parse(stdout.trim());
    const files = await readdir(directory);
    const file = files.find((name) => name.includes('.zh')) ?? files[0];
    const cues = file ? parseSubtitle(file, await readFile(join(directory, file), 'utf8')) : [];
    if (info.uploader && !metadata.author) metadata.author = info.uploader;
    if (info.description && !metadata.description) metadata.description = String(info.description).trim().slice(0, 3000);
    if (!cues.length) metadata.captionMessage = '该视频未提供可提取的字幕（可点击「粘贴字幕/文稿」手动补充）';
    return { title: info.title || resolvedTitle, metadata, anchors: timedAnchors(item.id, cues) };
  } catch (error) {
    metadata.captionMessage = directNoTracks
      ? '该 YouTube 视频未开启或未提供字幕（可点击「粘贴字幕/文稿」手动补充，或记录时间笔记）'
      : error.code === 'ENOENT'
        ? (platform === 'youtube' ? '暂未提取到 YouTube 字幕（可点击「粘贴字幕/文稿」手动补充）' : '服务端尚未安装 yt-dlp（可点击「粘贴字幕/文稿」手动补充）')
        : '暂时无法从平台获取字幕（可点击「粘贴字幕/文稿」手动补充）';
    return { title: resolvedTitle, metadata, anchors: [] };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function subtitleSeconds(value) {
  return value.replace(',', '.').split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

export function parseSubtitle(file, text) {
  if (file.endsWith('.json3')) {
    return (JSON.parse(text).events ?? []).map((event) => ({
      start: event.tStartMs / 1000,
      end: (event.tStartMs + (event.dDurationMs ?? 0)) / 1000,
      text: event.segs?.map((segment) => segment.utf8).join('').replace(/\s+/g, ' '),
    }));
  }
  return text.trim().split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const index = lines.findIndex((line) => /[\t ]+-->[\t ]+/.test(line));
    if (index < 0) return [];
    const [start, end] = lines[index].trim().split(/[\t ]+-->[\t ]+/);
    return [{ start: subtitleSeconds(start), end: subtitleSeconds(end.split(/\s/)[0]), text: lines.slice(index + 1).join(' ').replace(/<[^>]*>/g, '') }];
  });
}

async function article(item) {
  if (item.captured_markdown) return { markdown: item.captured_markdown };
  const page = await fetchPage(item.source_url);
  const dom = new JSDOM(page.html, { url: page.url });
  try {
    const doc = new Readability(dom.window.document).parse();
    if (!doc?.textContent?.trim()) throw new Error('未识别到正文，可使用 Chrome 插件保存当前页面');
    const turn = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    return { title: doc.title, markdown: turn.turndown(doc.content) };
  } finally {
    dom.window.close();
  }
}

export async function parseItem(item, filePath) {
  let parsed;
  switch (item.type) {
    case 'article': parsed = await article(item); break;
    case 'markdown': parsed = { markdown: item.captured_markdown ?? await readFile(filePath, 'utf8') }; break;
    case 'pdf': {
      const { text } = await extractText(new Uint8Array(await readFile(filePath)));
      parsed = { markdown: text.map((content, index) => `## 第 ${index + 1} 页\n\n${content.replace(/[\\`*_[\]<>#]/g, '\\$&')}`).join('\n\n') };
      if (!text.some((page) => page.trim())) parsed = { metadata: { notice: '此 PDF 没有可提取的文本，可打开原件阅读' } };
      break;
    }
    case 'video': parsed = await remoteVideo(item); break;
    case 'local_video': {
      if (!process.env.WHISPER_PYTHON) {
        parsed = { metadata: { captionMessage: '启用 faster-whisper 后可生成本地视频字幕' } };
        break;
      }
      try {
        const { stdout } = await run(process.env.WHISPER_PYTHON, [transcriber, filePath], { timeout: 15 * 60_000, maxBuffer: 20_000_000 });
        parsed = { anchors: timedAnchors(item.id, JSON.parse(stdout)) };
      } catch {
        parsed = { metadata: { captionMessage: '本地视频转录失败，可在播放器中继续添加时间笔记' } };
      }
      break;
    }
    default: parsed = {};
  }
  const text = (parsed.markdown ?? '').replaceAll('\0', '\uFFFD');
  const anchors = parsed.anchors ?? markdownAnchors(item.id, text);
  if (item.type === 'pdf') {
    let page = 0;
    for (const anchor of anchors) {
      if (anchor.anchor_meta.heading) page++;
      anchor.anchor_meta.page = page;
    }
  }
  return { ...parsed, markdown: text, anchors };
}
