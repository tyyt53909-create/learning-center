import hljs from 'highlight.js/lib/common';
import { markdown } from '../server/markdown.js';

markdown.set({ highlight(code, lang) {
  if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
  return hljs.highlightAuto(code).value;
} });

for (const name of ['heading_open', 'paragraph_open', 'paragraph_close', 'table_open', 'fence', 'code_block']) {
  const defaultRule = markdown.renderer.rules[name];
  markdown.renderer.rules[name] = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const id = env?.lines?.get(token.map?.[0]);
    if (token.hidden && name === 'paragraph_open') return id ? `<span id="${id}">` : '<span>';
    if (token.hidden && name === 'paragraph_close') return '</span>';
    if (id) token.attrSet('id', id);
    if (name === 'code_block' && id) return `<pre id="${id}"><code>${markdown.utils.escapeHtml(token.content)}</code></pre>\n`;
    return defaultRule ? defaultRule(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
  };
}

let youtubeApi;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubeApi) youtubeApi = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('YouTube 播放器连接超时')), 12_000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { clearTimeout(timer); reject(new Error('YouTube 播放器加载失败')); };
    document.head.append(script);
  }).catch((error) => { youtubeApi = undefined; throw error; });
  return youtubeApi;
}

export function connectPlayer(item, container, notify, onTimeUpdate) {
  const local = container.querySelector('video');
  const iframe = container.querySelector('iframe');
  let player;
  let ready = false;
  let target;
  let rate = 1;
  let disposed = false;
  let poll;
  const emit = () => {
    if (!onTimeUpdate || disposed) return;
    const seconds = local?.currentTime ?? (ready ? player.getCurrentTime?.() : target ?? 0);
    if (Number.isFinite(seconds)) onTimeUpdate(seconds);
  };
  if (local) local.addEventListener('timeupdate', emit);
  if (item.metadata_json.platform === 'youtube' && iframe) {
    loadYouTube().then((YT) => {
      if (disposed) return;
      player = new YT.Player(iframe, { events: {
        onReady: ({ target: controller }) => {
          ready = true;
          if (rate !== 1) controller.setPlaybackRate?.(rate);
          if (target !== undefined) controller.seekTo(target, true);
          if (onTimeUpdate) poll = setInterval(emit, 450);
        },
        onError: () => notify('无法嵌入此视频，可打开原视频观看'),
      } });
    }).catch((error) => { if (!disposed) notify(error.message); });
  }
  return {
    position: () => local?.currentTime ?? (ready ? player.getCurrentTime() : target ?? 0),
    seek(seconds) {
      target = seconds;
      if (local) {
        if (local.readyState) local.currentTime = seconds;
        else local.addEventListener('loadedmetadata', () => { local.currentTime = target; }, { once: true });
      } else if (ready) player.seekTo(seconds, true);
      onTimeUpdate?.(seconds);
    },
    setRate(nextRate) {
      rate = nextRate;
      if (local) local.playbackRate = nextRate;
      else if (ready) player.setPlaybackRate?.(nextRate);
    },
    destroy() {
      disposed = true;
      clearInterval(poll);
      if (local) local.removeEventListener('timeupdate', emit);
      player?.destroy?.();
    },
  };
}

export function renderMarkdown(item) {
  return markdown.render(item.raw_markdown, { lines: new Map(item.anchors.filter((anchor) => Number.isInteger(anchor.anchor_meta.line))
    .map((anchor) => [anchor.anchor_meta.line, anchor.id])) });
}
