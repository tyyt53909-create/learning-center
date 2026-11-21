import { icon } from './icons.js';
import { date, isVideo, learningStates, safe, sourceName, starButton, types, viewTitle } from './library.js';
import { renderMarkdown } from './reader.js';
import { dueText } from './review-view.js';
import { readerAiPanel } from './ask-view.js';

export function clock(value) {
  const whole = Math.max(0, Math.floor(value || 0));
  const seconds = String(whole % 60).padStart(2, '0');
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${seconds}` : `${String(Math.floor(whole / 60)).padStart(2, '0')}:${seconds}`;
}

function sourceButton(item) {
  if (item.source_url) return `<a class="btn" href="${safe(item.source_url)}" target="_blank" rel="noopener noreferrer">打开原${item.type === 'video' ? '视频' : '文'}${icon.arrow}</a>`;
  if (item.has_file) return `<a class="btn" href="/api/items/${item.id}/file" target="_blank" rel="noopener noreferrer">打开原文件${icon.arrow}</a>`;
  return '';
}

function recommendedCirclesMarkup(item, circles = []) {
  const names = item.distillation?.recommended_circles ?? [];
  if (!names.length) return '<p class="muted">暂无推荐</p>';
  return `<div class="circle-chips">${names.map((name) => {
    const existing = circles.find((circle) => circle.name === name);
    if (existing && item.circle_ids.includes(existing.id)) {
      return `<span class="circle-chip adopted">${icon.check}${safe(name)} · 已加入</span>`;
    }
    const label = existing ? `加入「${name}」` : `创建并加入「${name}」`;
    return `<button type="button" class="circle-chip ${existing ? '' : 'create'}" data-adopt-circle="${safe(name)}" aria-label="${safe(label)}">${icon.plus}${safe(label)}</button>`;
  }).join('')}</div>`;
}

export function aiPanel(item, circles = [], aiConfigured = false) {
  const data = item.distillation;
  const canAnalyze = item.ingest_state === 'ready' && ['ready', 'failed', 'unconfigured', 'unavailable'].includes(item.ai_state);
  const retryButton = canAnalyze
    ? `<button type="button" class="${data ? 'text-btn retry-btn' : 'btn primary ai-analyze-btn'}" data-retry="distill" aria-label="${data ? '重新进行 AI 分析' : '开始 AI 分析'}">${data ? icon.refresh : icon.sparkle}${data ? '重新分析' : '开始 AI 分析'}</button>`
    : '';
  const askButton = item.ingest_state === 'ready' ? `<button type="button" class="text-btn retry-btn" data-reader-ai-launch="chat" aria-label="在侧栏针对这篇资料提问">${icon.messageSquare}提问</button>` : '';
  const quizLaunch = item.ingest_state === 'ready' ? `<button type="button" class="text-btn retry-btn" data-reader-ai-launch="quiz" aria-label="在侧栏生成互动测验">${icon.checkCircle}测验</button>` : '';
  const canvasLaunch = item.ingest_state === 'ready' ? `<button type="button" class="text-btn retry-btn" data-reader-ai-launch="canvas" aria-label="在侧栏生成交互演示">${icon.code2}演示</button>` : '';
  const configBtn = !aiConfigured
    ? `<button type="button" class="btn primary ai-config-cta" data-ai-settings>${icon.sliders}配置 AI 模型</button>` : '';
  const statusBanner = item.ai_state === 'pending'
    ? '<p class="ai-banner pending">AI 正在分析主要内容与核心要点，完成后自动更新…</p>'
    : data && item.ai_state === 'failed'
      ? `<p class="ai-banner failed">重新分析失败：${safe(item.ai_error)}</p>` : '';
  const assistedNote = data?.model_used?.includes('辅助分析')
    ? `<p class="ai-banner info">当前为 ${safe(data.model_used.split(' · ').slice(1).join(' · '))}（未包含逐字字幕/正文）；${isVideo(item) ? '补充「粘贴字幕/文稿」后点击「重新分析」可升级为带时间戳引用的精析。' : '补充正文后可重新分析。'}</p>`
    : '';
  const existingCardFronts = new Set((item.cards ?? []).map((card) => card.front.trim().toLowerCase()));
  return `<div class="ai-heading">${icon.sparkle}<div class="od-field od-fill"><h2>AI 智能分析</h2><small>主要内容总结 · 核心要点拆解 · 引用可回原文</small></div><div class="ai-heading-actions">${data ? retryButton : ''}</div></div>
    ${item.ingest_state === 'ready' ? `<div class="ai-quick-bar">${askButton}${quizLaunch}${canvasLaunch}</div>` : ''}${statusBanner}${assistedNote}
    ${data ? `<h3>主要讲了什么 · 核心摘要</h3><ol class="ai-summary-list">${data.summary.map((sentence) => `<li>${safe(sentence)}</li>`).join('')}</ol>
    <h3>核心要点（${data.key_points_json.length} 个重点）</h3>${data.key_points_json.map((point, index) => {
      const made = existingCardFronts.has(point.title.trim().toLowerCase());
      const num = String(index + 1).padStart(2, '0');
      return `<article class="key-point"><div class="key-point-head"><div class="key-point-title"><span class="key-point-num">${num}</span><h3>${safe(point.title)}</h3></div>${made
        ? `<span class="card-made-badge">${icon.check}已制卡</span>`
        : `<button type="button" class="text-btn make-card-btn" data-card-from-point="${index}">${icon.layers}制卡</button>`}</div><p>${safe(point.explanation)}</p>
      ${(point.sources ?? []).map((source) => `<button type="button" class="quote" data-anchor="${safe(source.anchor_id)}">${icon.link}<q>${safe(source.quote)}</q></button>`).join('')}</article>`;
    }).join('')}
    <h3>推荐标签</h3><div class="tag-row">${data.recommended_tags.map((tag) => `<span>${safe(tag)}</span>`).join('') || '暂无推荐'}</div>
    <h3>推荐圈子</h3>${recommendedCirclesMarkup(item, circles)}` :
    `<p class="ai-state">${safe(({ pending: 'AI 正在阅读并提炼这篇资料的核心摘要与重点…', unavailable: '点击下方「开始 AI 分析」，立即总结主要内容与核心要点。', unconfigured: '配置 AI 模型后可一键分析这篇资料的主要内容与核心要点。', failed: item.ai_error || 'AI 分析失败，请点击重试。' })[item.ai_state] ?? '点击下方按钮开始 AI 智能分析。')}</p>
    <div class="ai-state-actions">${aiConfigured ? retryButton : configBtn}</div>`}`;
}

function videoPlayer(item) {
  const { platform, videoId, page } = item.metadata_json;
  const params = new URLSearchParams(platform === 'youtube' ? { enablejsapi: '1', origin: location.origin }
    : { [videoId?.startsWith('av') ? 'aid' : 'bvid']: videoId?.startsWith('av') ? videoId.slice(2) : videoId, page: page || 1, autoplay: '0' });
  const src = platform === 'youtube' ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params}` : `https://player.bilibili.com/player.html?${params}`;
  const player = item.has_file ? `<video controls preload="metadata" src="/api/items/${item.id}/file" aria-label="${safe(item.title)}"></video>` :
    `<iframe title="${safe(item.title)}" src="${safe(src)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  const hasRates = item.has_file || platform === 'youtube';
  const rates = hasRates ? `<div class="rate-bar" role="group" aria-label="播放倍速"><span>倍速</span>${[0.75, 1, 1.25, 1.5, 2].map((r) =>
    `<button type="button" class="rate-btn ${r === 1 ? 'active' : ''}" data-rate="${r}" aria-pressed="${r === 1}">${r}x</button>`).join('')}</div>` : '';
  return `<div class="media-block" id="player">${player}${rates}</div>`;
}

export function cueList(item, filterText = '') {
  const cues = item.anchors.map(({ id, text, anchor_meta }, idx) => ({
    id, text, seconds: anchor_meta.start ?? idx * 10, end: anchor_meta.end ?? anchor_meta.start ?? idx * 10, untimed: Boolean(anchor_meta.untimed), idx,
  }));
  const timedNotes = item.notes.filter(({ seconds }) => seconds !== null).map((note) => ({ ...note, note: true, end: note.seconds }));
  const query = filterText.trim().toLowerCase();
  const entries = [...cues, ...timedNotes]
    .sort((a, b) => a.seconds - b.seconds)
    .filter((cue) => !query || cue.text.toLowerCase().includes(query));
  if (!entries.length) {
    return `<p class="muted">${safe(query ? '没有匹配的字幕或笔记。' : item.metadata_json.captionMessage || '暂无字幕或时间笔记。')}</p>`;
  }
  return entries.map((cue) => {
    const stamp = cue.untimed ? `第 ${cue.idx + 1} 段` : clock(cue.seconds);
    const content = `<time>${stamp}</time><span>${cue.note ? '<small>笔记 · </small>' : ''}${safe(cue.text)}</span>`;
    return item.metadata_json.platform === 'bilibili' || cue.untimed ? `<div class="cue" id="${cue.id}" data-start="${cue.seconds}" data-end="${cue.end}">${content}</div>` :
      `<button class="cue" id="${cue.id}" data-seek="${cue.seconds}" data-start="${cue.seconds}" data-end="${cue.end}">${content}</button>`;
  }).join('');
}

export function noteList(item) {
  return item.notes.map(({ id, seconds, text }) => {
    const body = seconds === null
      ? `<div class="note-body">${safe(text)}</div>`
      : `<button class="note-body" type="button" data-anchor="${id}"><small>${clock(seconds)} · 时间笔记</small>${safe(text)}</button>`;
    return `<div class="note-record">${body}<div class="note-actions">
      <button type="button" class="icon-btn note-action" data-edit-note="${id}" aria-label="编辑笔记">${icon.pencil}</button>
      <button type="button" class="icon-btn note-action danger" data-delete-note="${id}" aria-label="删除笔记">${icon.trash}</button>
    </div></div>`;
  }).join('');
}

export function readingContent(item, pdfView = 'text', relaxed = false) {
  if (item.type === 'image') return `<img class="uploaded-image" src="/api/items/${item.id}/file" alt="${safe(item.title)}">`;
  const isPdfFile = item.type === 'pdf' && item.has_file;
  const switcher = isPdfFile ? `<div class="pdf-switch-group" role="group" aria-label="PDF 阅读模式">
    <button type="button" class="filter ${pdfView === 'text' ? 'active' : ''}" data-pdf-view="text" aria-pressed="${pdfView === 'text'}">${icon.fileCode}提取文本</button>
    <button type="button" class="filter ${pdfView === 'file' ? 'active' : ''}" data-pdf-view="file" aria-pressed="${pdfView === 'file'}">${icon.eye}原件预览</button>
  </div>` : '';
  const editBtn = item.type === 'markdown' ? `<button type="button" class="text-btn" data-edit-markdown>${icon.pencil}编辑正文</button>` : '';
  const comfortBtn = !(isPdfFile && pdfView === 'file')
    ? `<button type="button" class="text-btn comfort-btn" data-toggle-comfort aria-pressed="${relaxed}">${icon.type}${relaxed ? '标准排版' : '宽松排版'}</button>`
    : '';
  const fullExportLink = item.raw_markdown ? `<a class="text-btn" href="/api/items/${item.id}/export?includeSource=1" download>${icon.download}导出全文</a>` : '';
  const toolbar = (switcher || editBtn || comfortBtn || fullExportLink)
    ? `<div class="prose-tools"><div class="prose-tools-left">${switcher}${editBtn}</div><div class="prose-tools-right">${comfortBtn}${fullExportLink}</div></div>`
    : '';
  if (isPdfFile && pdfView === 'file') {
    return `${toolbar}<iframe class="pdf-frame" src="/api/items/${item.id}/file" title="${safe(item.title)}"></iframe>`;
  }
  const headings = item.anchors.filter((anchor) => anchor.anchor_meta.heading);
  const contents = headings.length ? `<details class="contents"><summary>文章目录（${headings.length} 节）</summary>${headings.map(({ id, text }) => `<button data-anchor="${id}">${safe(text)}</button>`).join('')}</details>` : '';
  const body = item.raw_markdown ? renderMarkdown(item) : `<p class="muted">${safe(item.metadata_json.notice || '暂无可展示的文本。')}</p>`;
  return `${toolbar}${contents}<div class="markdown-body ${relaxed ? 'relaxed' : ''}">${body}</div>`;
}

function noteForm(item) {
  const timed = isVideo(item) && item.metadata_json.platform !== 'bilibili';
  return `<form class="note-section field" id="note-form"><div class="note-label-row"><label for="personal-note">${timed ? '时间笔记' : '我的思考'}</label>${timed ? '<span class="note-time" id="note-time">当前 00:00</span>' : ''}</div>
    <textarea id="personal-note" name="note" placeholder="${timed ? '记录当前播放位置的想法…' : '记下你的想法…'}" maxlength="5000" required></textarea>
    <button class="btn">${icon.plus}保存笔记</button><div id="notes">${noteList(item)}</div></form>`;
}

export function learningStateSwitch(current) {
  return `<div class="state-switch" role="group" aria-label="学习状态">${Object.entries(learningStates).map(([key, label]) =>
    `<button type="button" class="state-opt state-${key} ${current === key ? 'active' : ''}" data-learning-state="${key}" aria-pressed="${current === key}">${label}</button>`).join('')}</div>`;
}

export function tabButtons() {
  return `<div class="reader-tabs" role="group" aria-label="阅读内容"><button class="filter active" data-reader-tab="source" aria-pressed="true">原文</button><button class="filter" data-reader-tab="ai" aria-pressed="false">观点与笔记</button></div>`;
}

export function cardsPanel(item, aiConfigured = false) {
  const cards = item.cards ?? [];
  const canGenerate = Boolean(item.distillation?.key_points_json?.length || item.notes?.length);
  const canAiGenerate = Boolean(aiConfigured && item.anchors?.length);
  return `<section class="cards-section" aria-label="复习卡片">
    <div class="cards-head">
      <div class="related-heading">${icon.layers}<div class="od-field"><h3>复习卡片</h3><small>${cards.length} 张 · 间隔重复巩固</small></div></div>
      <div class="cards-head-actions">
        ${canAiGenerate ? `<button type="button" class="text-btn" data-generate-ai-cards title="由 AI 基于原文深度出题">${icon.wand}AI 制卡</button>` : ''}
        ${canGenerate ? '<button type="button" class="text-btn" data-generate-cards>要点制卡</button>' : ''}
        <button type="button" class="text-btn" data-new-card>${icon.plus}新建</button>
      </div>
    </div>
    ${cards.length ? `<div class="item-card-list">${cards.map((card) => `<div class="item-review-card">
      <div class="item-review-copy">
        <strong class="od-clamp-2">${safe(card.front)}</strong>
        <small>${dueText(card.due_at)} · 已复习 ${card.repetitions} 次</small>
      </div>
      <div class="note-actions">
        <button type="button" class="icon-btn note-action" data-edit-card="${card.id}" aria-label="编辑卡片">${icon.pencil}</button>
        <button type="button" class="icon-btn note-action danger" data-delete-card="${card.id}" aria-label="删除卡片">${icon.trash}</button>
      </div>
    </div>`).join('')}</div><a class="text-btn review-jump" href="/review" data-nav>前往今日复习 ${icon.arrow}</a>`
      : '<p class="muted small">点击「一键生成」将 AI 要点与笔记转为闪卡，或手动新建。</p>'}
  </section>`;
}

export function relatedPanel(related = []) {
  return `<section class="related-section" aria-label="相关资料">
    <div class="related-heading">${icon.waypoints}<div class="od-field"><h3>相关资料</h3><small>知识连接 · 语义与圈子关联</small></div></div>
    ${related.length ? `<div class="related-list">${related.map((item) => {
      const [label] = types[item.type] ?? ['资料'];
      return `<button type="button" class="related-card" data-open="${item.id}">
        <div class="related-meta"><span>${label}</span><span class="related-reason ${item.reason === 'semantic' ? 'semantic' : ''}">${safe(item.reason_label)}</span></div>
        <strong class="od-clamp-2">${safe(item.title)}</strong>
        ${item.snippet ? `<p class="od-clamp-2">${safe(item.snippet)}</p>` : ''}
      </button>`;
    }).join('')}</div>` : '<p class="muted small">收藏更多资料后，这里会自动发现相关连接。</p>'}</section>`;
}

export function readerContent(item, state, backTo) {
  const [label, glyph] = types[item.type];
  const tags = state.circles.filter(({ id }) => item.circle_ids.includes(id)).map(({ name }) => `<span>${safe(name)}</span>`).join('');
  const video = isVideo(item);
  const aiReady = Boolean(state.counts?.ai_configured);
  const aside = `<aside class="ai-panel"><div id="ai-panel">${aiPanel(item, state.circles, aiReady)}</div>${noteForm(item)}<div id="cards-panel">${cardsPanel(item, aiReady)}</div><div id="related-panel">${relatedPanel(state.related)}</div></aside>`;
  const cueSearch = item.anchors.length > 0 ? `<input id="cue-filter" class="cue-filter" type="search" aria-label="筛选字幕或笔记" placeholder="在字幕中筛选…" value="${safe(state.cueFilter ?? '')}">` : '';
  const transcriptActions = `<div class="transcript-actions">
    <button type="button" class="text-btn" data-paste-transcript>${icon.filePlus}${item.anchors.length ? '替换字幕/文稿' : '粘贴字幕/文稿'}</button>
    ${item.type === 'video' && !item.anchors.length ? `<button type="button" class="text-btn" data-retry="parse">${icon.refresh}重新抓取字幕</button>` : ''}
  </div>`;
  const videoDesc = item.metadata_json?.description
    ? `<details class="video-desc"><summary>视频简介${item.metadata_json.author ? ` · ${safe(item.metadata_json.author)}` : ''}</summary><p>${safe(item.metadata_json.description)}</p></details>`
    : '';
  const body = video ? `<div class="reading-grid video-grid">${videoPlayer(item)}<section class="prose transcript"><div class="transcript-head"><h2>字幕与笔记</h2><div class="transcript-head-right">${cueSearch}${transcriptActions}</div></div>${videoDesc}<div id="cues">${cueList(item, state.cueFilter)}</div></section></div>${aside}` :
    `${tabButtons()}<div class="reading-grid" data-tab="source"><article class="prose" id="prose-body">${readingContent(item, state.pdfView, state.relaxed)}</article>${aside}</div>`;
  const waiting = `<div class="state-panel">${icon.clock}<h2>${item.ingest_state === 'failed' ? '这份资料暂时无法解析' : '正在解析资料'}</h2>
    <p>${safe(item.ingest_error || '处理完成后会自动更新。')}</p>${item.ingest_state === 'failed' ? '<button class="btn primary" data-retry="parse">重新解析</button>' : ''}</div>`;
  const aiOpen = Boolean(state.readerAi?.open);
  const aiToggleBtn = `<button type="button" class="btn reader-ai-toggle ${aiOpen ? 'active' : ''}" data-toggle-reader-ai aria-pressed="${aiOpen}" title="打开或关闭右侧 AI 伴读侧栏 (⌘.)">${icon.panelRight}<span>AI 伴读</span></button>`;
  return `<div class="reader-shell ${aiOpen ? 'ai-open' : ''}" id="reader-shell">
    <div class="reader-main">
      <header class="topbar reader-topbar"><a href="${backTo}" data-nav class="text-btn breadcrumb">${icon.back}<span>返回${safe(viewTitle(state))}</span></a>
        <div class="actions">${aiToggleBtn}${starButton(item)}<button class="btn" data-associate>${icon.folder}管理圈子</button><a class="btn" href="/api/items/${item.id}/export" download>${icon.download}导出笔记</a>${sourceButton(item)}<button class="icon-btn danger-icon" data-delete-item="${item.id}" aria-label="删除资料">${icon.trash}</button></div><div class="read-progress" id="read-progress" aria-hidden="true"></div></header>
      <div class="reader-content page-enter"><div class="reader-title"><div class="reader-meta">${icon[glyph]} ${label} <span>·</span> ${safe(sourceName(item))} <span>·</span> ${date(item.created_at)}</div>
      <div class="reader-heading-row"><h1 id="reader-heading" tabindex="-1">${safe(item.title)}</h1><button type="button" class="icon-btn" data-rename-item aria-label="重命名资料">${icon.pencil}</button></div>
      <div class="reader-subbar"><div class="tag-row" id="item-circles">${tags}</div><div id="learning-state-switch">${learningStateSwitch(item.learning_state)}</div></div></div>
      ${item.ingest_state === 'ready' ? body : waiting}</div>
    </div>
    ${aiOpen ? '<button type="button" class="reader-ai-backdrop" data-toggle-reader-ai aria-label="关闭 AI 伴读侧栏"></button>' : ''}
    <aside class="reader-ai-dock" id="reader-ai-dock" aria-label="AI 伴读侧栏" ${aiOpen ? '' : 'hidden'}>${aiOpen ? readerAiPanel(item, state) : ''}</aside>
  </div>`;
}
