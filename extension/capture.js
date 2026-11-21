import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

globalThis.learningCenterCapture = (() => {
  const turn = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const host = location.hostname;
  const videoPlatform = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(host)
    ? 'youtube'
    : ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && /^\/video\/(BV[\da-z]+|av\d+)/i.test(location.pathname)
      ? 'bilibili'
      : null;

  let selectionText = '';
  let selectionMarkdown = '';
  try {
    const sel = window.getSelection?.();
    selectionText = sel ? sel.toString().trim() : '';
    if (selectionText && sel.rangeCount > 0) {
      const box = document.createElement('div');
      for (let i = 0; i < sel.rangeCount; i++) box.append(sel.getRangeAt(i).cloneContents());
      selectionMarkdown = turn.turndown(box.innerHTML).trim() || selectionText;
    }
  } catch { /* ignore selection errors */ }

  let title = document.title;
  let markdown = '';
  let plainText = '';
  if (!videoPlatform) {
    try {
      const copy = document.cloneNode(true);
      const parsed = new Readability(copy).parse();
      if (parsed?.title) title = parsed.title;
      if (parsed?.content) {
        markdown = turn.turndown(parsed.content).trim();
        plainText = (parsed.textContent || '').replace(/\s+/g, ' ').trim();
      }
    } catch { /* fallback below */ }
    if (!markdown) {
      const fallback = document.querySelector('article, main, [role="main"]');
      if (fallback?.innerHTML) {
        markdown = turn.turndown(fallback.innerHTML).trim();
        plainText = (fallback.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }
  }

  return {
    title: (title || host || '').trim(),
    markdown,
    selectionMarkdown,
    selectionText,
    charCount: markdown.length,
    excerpt: (plainText || markdown).slice(0, 140),
    isVideo: Boolean(videoPlatform),
    videoPlatform,
    url: location.href,
  };
})();
