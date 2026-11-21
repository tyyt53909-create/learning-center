import { markdown } from '../server/markdown.js';
import { icon } from './icons.js';
import { safe } from './library.js';
import { renderCanvasCard, renderCanvasStudio, renderQuizWidget } from './widget-view.js';

function scopeLabel(ask, circles) {
  if (ask.scopeType === 'item') return ask.scopeTitle || '当前资料';
  if (ask.scopeType === 'circle') {
    const circle = circles.find((c) => c.id === ask.scopeId);
    return circle?.name ? `圈子 · ${circle.name}` : '指定圈子';
  }
  return '全部资料';
}

function starterPrompts(scopeType, mode) {
  if (mode === 'quiz') {
    return scopeType === 'item'
      ? ['根据这篇资料出 4 道核心概念单选题', '针对其中易混淆细节出 3 道测验题']
      : ['针对资料库重点出 4 道随堂测验题', '出一套检验理解深度的交互选择题'];
  }
  if (mode === 'canvas') {
    return scopeType === 'item'
      ? ['把这篇资料的核心原理做成交互可视化组件', '生成一个分步骤交互概念演示面板']
      : ['做一个带滑块的算法收敛可视化演示', '生成一个可交互的概念对比与计算器组件'];
  }
  if (scopeType === 'item') {
    return ['这篇资料最核心的结论是什么？', '提炼最值得记住的 3 个关键概念', '原文有哪些可落地的实践建议？'];
  }
  return ['总结我资料库中最核心的观点脉络', '不同资料间有哪些互补或冲突的观点？', '梳理最值得优先复习的知识点'];
}

export function messageMarkup(msg, threadId, isLatest, followUps, quizAnswers, theme, options = {}) {
  const { compact = false, currentItemId = null } = options;
  if (msg.role === 'user') {
    return `<div class="chat-msg user"><div class="user-pill">${safe(msg.content)}</div></div>`;
  }
  const widget = msg.widget_json;
  const widgetMarkup = widget?.kind === 'quiz'
    ? renderQuizWidget(widget, msg.id, quizAnswers)
    : widget?.kind === 'canvas'
      ? renderCanvasCard(widget, msg.id, theme)
      : '';
  const citations = Array.isArray(msg.citations_json) ? msg.citations_json : [];
  const citesMarkup = citations.length
    ? `<div class="chat-citations">
        <span class="cite-heading">${icon.link}参考依据（${citations.length}）</span>
        <div class="cite-list">${citations.map((c) => {
          if (c.source === 'web' && c.url) {
            return `<div class="cite-card web-cite">
              <div class="web-cite-head">
                <a class="cite-title" href="${safe(c.url)}" target="_blank" rel="noopener noreferrer">${icon.globe}${safe(c.hostname || '网页')} · ${safe(c.item_title)} ${icon.arrow}</a>
                <button type="button" class="text-btn save-web-btn" data-save-web-url="${safe(c.url)}" data-save-web-title="${safe(c.item_title)}">${icon.bookmarkPlus}收藏</button>
              </div>
              <q>${safe(c.quote)}</q>
            </div>`;
          }
          const inCurrent = currentItemId && c.item_id === currentItemId;
          return `<button type="button" class="cite-card" ${inCurrent ? `data-anchor="${safe(c.anchor_id)}"` : `data-open="${safe(c.item_id)}" data-open-anchor="${safe(c.anchor_id)}"`}>
            <span class="cite-title">${inCurrent ? '定位原文段落' : safe(c.item_title)} ${icon.arrow}</span>
            <q>${safe(c.quote)}</q>
          </button>`;
        }).join('')}</div>
      </div>`
    : '';
  const webSources = Array.isArray(msg.web_sources_json) ? msg.web_sources_json : [];
  const webSourcesMarkup = webSources.length
    ? `<details class="web-sources-box">
        <summary>${icon.globe}联网检索网页（${webSources.length} 个来源）</summary>
        <div class="web-sources-list">${webSources.map((s) => `<div class="web-source-row">
          <a class="web-source-link" href="${safe(s.url)}" target="_blank" rel="noopener noreferrer">
            <strong class="od-truncate">${safe(s.title)}</strong>
            <small>${safe(s.hostname)}${s.snippet ? ` · ${safe(s.snippet.slice(0, 90))}` : ''}</small>
          </a>
          <button type="button" class="text-btn save-web-btn" data-save-web-url="${safe(s.url)}" data-save-web-title="${safe(s.title)}">${icon.bookmarkPlus}收藏</button>
        </div>`).join('')}</div>
      </details>`
    : '';
  const followAttr = compact ? 'data-reader-ai-prompt' : 'data-follow-up';
  const followMarkup = isLatest && followUps?.length
    ? `<div class="follow-ups">${followUps.map((q) => `<button type="button" class="follow-chip" ${followAttr}="${safe(q)}">${safe(q)}</button>`).join('')}</div>`
    : '';
  const canSaveNote = Boolean(threadId && !String(msg.id).startsWith('demo-') && !String(msg.id).startsWith('err-'));
  const saveAction = compact && currentItemId && canSaveNote
    ? `<button type="button" class="text-btn save-note-btn" data-save-reader-note="${msg.id}">${icon.filePlus}记入本篇笔记</button>`
    : canSaveNote
      ? `<button type="button" class="text-btn save-note-btn" data-save-ai-note="${msg.id}" data-thread-id="${threadId}">${icon.filePlus}存为笔记</button>`
      : '';
  return `<div class="chat-msg assistant">
    <div class="assistant-row">
      <span class="assistant-mark" aria-hidden="true">${icon.sparkle}</span>
      <div class="assistant-content">
        ${msg.content ? `<div class="markdown-body chat-md">${markdown.render(msg.content)}</div>` : ''}
        ${widgetMarkup}
        ${citesMarkup}
        ${webSourcesMarkup}
        <div class="chat-meta-bar">
          <span>${msg.model_used ? safe(msg.model_used) : '交互组件'}${webSources.length ? ' · 已联网' : ''}</span>
          ${saveAction}
        </div>
        ${followMarkup}
      </div>
    </div>
  </div>`;
}

function historyDrawer(ask) {
  if (!ask.historyOpen) return '';
  const list = ask.threads.length
    ? ask.threads.map((t) => `<div class="thread-item ${ask.threadId === t.id ? 'active' : ''}">
        <button type="button" class="thread-select" data-select-thread="${t.id}">
          <strong class="od-truncate">${safe(t.title)}</strong>
          <small>${t.message_count} 条消息</small>
        </button>
        <button type="button" class="icon-btn note-action danger" data-delete-thread="${t.id}" aria-label="删除对话">${icon.trash}</button>
      </div>`).join('')
    : '<p class="muted small thread-empty">还没有历史对话记录</p>';
  return `<button type="button" class="history-backdrop" data-toggle-history aria-label="关闭历史对话"></button>
    <aside class="history-drawer" aria-label="历史对话">
      <header class="history-drawer-head">
        <strong>历史对话</strong>
        <div class="history-drawer-actions">
          <button type="button" class="text-btn" data-new-ask>${icon.plus}新对话</button>
          <button type="button" class="icon-btn note-action" data-toggle-history aria-label="关闭历史">${icon.close}</button>
        </div>
      </header>
      <div class="thread-list">${list}</div>
    </aside>`;
}

export function askContent(state) {
  const { ask, circles, counts, theme } = state;
  const scopeValue = ask.scopeType === 'circle' ? `circle:${ask.scopeId}` : ask.scopeType === 'item' ? `item:${ask.scopeId}` : 'all';
  const configured = Boolean(counts.ai_configured);
  const mode = ask.mode || 'chat';
  const webOn = Boolean(ask.webSearch);
  const hasMessages = ask.messages.length > 0 || ask.loading;
  const hasCanvas = Boolean(ask.canvas);

  const modePlaceholders = {
    chat: webOn ? '输入问题或粘贴公网链接，结合资料库与联网搜索回答…' : `向「${scopeLabel(ask, circles)}」提问…`,
    quiz: '输入想测验的知识点，生成可即时判分的互动选择题…',
    canvas: '描述想做的交互组件（动画演示、计算器、图解），实时运行并编辑代码…',
  };

  const setupRibbon = !configured
    ? `<div class="ask-setup-ribbon">
        <span><i class="status-pill-dot warn"></i>尚未连接 AI 模型 · 支持 OpenAI / DeepSeek / 通义千问 / Ollama</span>
        <button type="button" class="text-btn" data-ai-settings>配置模型 ${icon.arrow}</button>
      </div>`
    : '';

  const emptyHero = `<div class="ask-hero">
      <span class="ask-hero-eyebrow">${icon.sparkle} LEARNING AI STUDIO</span>
      <h1>${mode === 'quiz' ? '把知识变成互动测验' : mode === 'canvas' ? '用代码画布直观理解原理' : '今天想探索什么？'}</h1>
      <p class="ask-hero-sub">在 <b>${safe(scopeLabel(ask, circles))}</b> 中检索原文锚点${counts.semantic_search ? '与语义向量' : ''}，支持实时联网、互动出题与可运行代码组件。</p>
      ${setupRibbon}
      <div class="ask-bento">
        <button type="button" class="bento-card" data-demo-widget="quiz">
          <span class="bento-icon quiz">${icon.checkCircle}</span>
          <strong>互动选择题</strong>
          <small>即时判分与解析，错题一键转入复习闪卡</small>
        </button>
        <button type="button" class="bento-card" data-demo-widget="canvas">
          <span class="bento-icon canvas">${icon.code2}</span>
          <strong>交互代码画布</strong>
          <small>沙箱实时运行 HTML/CSS/JS，支持分屏改代码</small>
        </button>
        <button type="button" class="bento-card" ${configured ? 'data-toggle-web-search' : 'data-ai-settings'}>
          <span class="bento-icon web">${icon.globe}</span>
          <strong>${configured ? (webOn ? '联网搜索已开启' : '开启联网搜索') : '连接 AI 模型'}</strong>
          <small>${configured ? '融合本地资料与实时网页，支持一键收藏来源' : '30 秒填入 API Key 或本地 Ollama 即刻启用'}</small>
        </button>
      </div>
      ${configured ? `<div class="ask-starters">${starterPrompts(ask.scopeType, mode).map((q) => `<button type="button" class="starter-pill" data-follow-up="${safe(q)}">${safe(q)}</button>`).join('')}</div>` : ''}
    </div>`;

  const streamView = `<div class="chat-stream" id="chat-stream">
      ${ask.messages.map((msg, idx) => messageMarkup(msg, ask.threadId, idx === ask.messages.length - 1, ask.followUps, ask.quizAnswers, theme)).join('')}
      ${ask.loading ? `<div class="chat-msg assistant"><div class="assistant-row"><span class="assistant-mark pulse" aria-hidden="true">${icon.sparkle}</span><div class="assistant-content"><p class="chat-thinking">${webOn ? '正在联网检索网页并结合资料库生成结果…' : mode === 'quiz' ? '正在基于资料生成互动选择题…' : mode === 'canvas' ? '正在编写可交互组件代码…' : '正在检索资料库原文并生成带引用的回答…'}</p></div></div></div>` : ''}
    </div>`;

  return `<header class="topbar ask-topbar">
      <div class="ask-topbar-left">
        <button class="icon-btn mobile-menu" data-menu aria-label="展开或收起导航" aria-expanded="false">${icon.menu}</button>
        <div class="breadcrumb">个人空间 ${icon.chevron} <b>AI 问答</b></div>
      </div>
      <div class="top-right ask-topbar-actions">
        <button type="button" class="btn-subtle ${ask.historyOpen ? 'active' : ''}" data-toggle-history aria-expanded="${Boolean(ask.historyOpen)}">${icon.history}<span>历史${ask.threads.length ? ` (${ask.threads.length})` : ''}</span></button>
        ${hasMessages ? `<button type="button" class="btn-subtle" data-new-ask>${icon.plus}<span>新对话</span></button>` : ''}
        <select id="ask-scope" class="sort ask-scope-select" aria-label="问答资料范围" ${ask.threadId ? 'disabled title="当前对话已锁定范围，新建对话可切换范围"' : ''}>
          <option value="all" ${scopeValue === 'all' ? 'selected' : ''}>全部资料</option>
          ${ask.scopeType === 'item' ? `<option value="${safe(scopeValue)}" selected>单篇：${safe(ask.scopeTitle || '当前资料')}</option>` : ''}
          ${circles.map((c) => `<option value="circle:${c.id}" ${scopeValue === `circle:${c.id}` ? 'selected' : ''}>圈子：${safe(c.name)}</option>`).join('')}
        </select>
        <button type="button" class="btn-subtle" data-ai-settings><i class="status-pill-dot ${configured ? 'ok' : 'warn'}"></i><span>AI 设置</span></button>
      </div>
    </header>
    <div class="ask-shell ${hasCanvas ? 'with-canvas' : ''} page-enter">
      ${historyDrawer(ask)}
      <section class="ask-stage" aria-label="AI 对话工作区">
        <div class="ask-scroll ${hasMessages ? '' : 'is-empty'}">
          <div class="ask-column">${hasMessages ? streamView : emptyHero}</div>
        </div>
        <div class="ask-dock">
          <form class="ask-composer-card" id="ask-form">
            <textarea id="ask-input" name="question" rows="1" maxlength="2000" placeholder="${configured ? safe(modePlaceholders[mode]) : '配置 AI 模型后即可提问，或点击上方卡片立即体验互动组件…'}" ${!configured || ask.loading ? 'disabled' : ''} required></textarea>
            <div class="composer-bar">
              <div class="composer-tools" role="group" aria-label="交互模式与工具">
                <button type="button" class="tool-chip ${mode === 'chat' ? 'active' : ''}" data-ask-mode="chat" aria-pressed="${mode === 'chat'}">${icon.messageSquare}<span>问答</span></button>
                <button type="button" class="tool-chip ${mode === 'quiz' ? 'active' : ''}" data-ask-mode="quiz" aria-pressed="${mode === 'quiz'}">${icon.checkCircle}<span>选择题</span></button>
                <button type="button" class="tool-chip ${mode === 'canvas' ? 'active' : ''}" data-ask-mode="canvas" aria-pressed="${mode === 'canvas'}">${icon.code2}<span>代码画布</span></button>
                <span class="tool-divider" aria-hidden="true"></span>
                <button type="button" class="tool-chip web-chip ${webOn ? 'on' : ''}" data-toggle-web-search aria-pressed="${webOn}">${icon.globe}<span>联网${webOn ? ' · 开' : ''}</span></button>
              </div>
              <button type="submit" class="send-circle" aria-label="发送" ${!configured || ask.loading ? 'disabled' : ''}>${icon.arrowUp}</button>
            </div>
          </form>
        </div>
      </section>
      ${hasCanvas ? renderCanvasStudio(ask.canvas, theme) : ''}
    </div>`;
}

export function readerAiPanel(item, state) {
  const panel = state.readerAi;
  const configured = Boolean(state.counts?.ai_configured);
  const mode = panel.mode || 'chat';
  const webOn = Boolean(panel.webSearch);
  const hasMessages = panel.messages.length > 0 || panel.loading;
  const placeholders = {
    chat: webOn ? '结合本篇资料与联网搜索提问…' : '问 AI 关于这篇资料…',
    quiz: '输入想重点测验的内容，立即生成单选题…',
    canvas: '描述想基于本篇做的交互演示组件…',
  };
  const starters = starterPrompts('item', mode);
  const historyList = panel.historyOpen
    ? `<div class="dock-history">
        <div class="dock-history-head">
          <span>本篇对话记录（${panel.threads.length}）</span>
          <button type="button" class="text-btn" data-reader-ai-new>${icon.plus}新对话</button>
        </div>
        ${panel.threads.length
          ? `<div class="dock-thread-list">${panel.threads.map((t) => `<div class="thread-item ${panel.threadId === t.id ? 'active' : ''}">
              <button type="button" class="thread-select" data-reader-ai-thread="${t.id}">
                <strong class="od-truncate">${safe(t.title)}</strong>
                <small>${t.message_count} 条消息</small>
              </button>
              <button type="button" class="icon-btn note-action danger" data-reader-ai-delete-thread="${t.id}" aria-label="删除对话">${icon.trash}</button>
            </div>`).join('')}</div>`
          : '<p class="muted small dock-history-empty">这篇资料还没有对话记录</p>'}
      </div>`
    : '';
  const emptyBody = `<div class="dock-empty">
      <div class="dock-emblem" aria-hidden="true">${icon.sparkle}</div>
      <div class="dock-context-pill" title="${safe(item.title)}"><i class="status-pill-dot ok"></i><span class="od-truncate">已连接 · ${safe(item.title)}</span></div>
      <p class="dock-empty-sub">${mode === 'quiz' ? '直接围绕本篇核心概念生成可实时判分的随堂测验。' : mode === 'canvas' ? '把这篇资料的抽象概念做成可交互运行的演示组件。' : '提问自动检索本篇原文锚点，点击引用可精准跳回左侧段落。'}</p>
      ${configured
        ? `<div class="dock-starters">${starters.map((q) => `<button type="button" class="dock-starter" data-reader-ai-prompt="${safe(q)}">${safe(q)}</button>`).join('')}</div>`
        : `<button type="button" class="btn primary" data-ai-settings>${icon.sliders}配置 AI 模型</button>`}
    </div>`;
  const streamBody = `<div class="dock-stream" id="reader-ai-stream">
      ${panel.messages.map((msg, idx) => messageMarkup(msg, panel.threadId, idx === panel.messages.length - 1, panel.followUps, panel.quizAnswers, state.theme, { compact: true, currentItemId: item.id })).join('')}
      ${panel.loading ? `<div class="chat-msg assistant"><div class="assistant-row"><span class="assistant-mark pulse" aria-hidden="true">${icon.sparkle}</span><div class="assistant-content"><p class="chat-thinking">${webOn ? '正在结合本篇与联网检索生成回答…' : mode === 'quiz' ? '正在基于本篇生成互动选择题…' : mode === 'canvas' ? '正在编写本篇交互演示组件…' : '正在检索本篇原文并生成带引用的回答…'}</p></div></div></div>` : ''}
    </div>`;
  return `<header class="dock-head">
      <div class="dock-brand">
        <span class="dock-brand-icon">${icon.sparkle}</span>
        <strong>AI 伴读</strong>
        <span class="dock-linked-badge" title="上下文已自动绑定当前资料">已连接本篇</span>
      </div>
      <div class="dock-head-actions">
        ${hasMessages ? `<button type="button" class="icon-btn dock-icon-btn" data-reader-ai-new title="新建对话" aria-label="新建对话">${icon.plus}</button>` : ''}
        <button type="button" class="icon-btn dock-icon-btn" data-ask-item="${item.id}" data-launch-mode="${mode}" title="在完整 AI 工作台打开" aria-label="在完整 AI 工作台打开">${icon.arrow}</button>
        <button type="button" class="icon-btn dock-icon-btn" data-toggle-reader-ai title="关闭侧栏 (⌘.)" aria-label="关闭 AI 伴读侧栏">${icon.close}</button>
      </div>
    </header>
    <div class="dock-segbar">
      <button type="button" class="icon-btn dock-icon-btn ${panel.historyOpen ? 'active' : ''}" data-reader-ai-history title="本篇对话历史" aria-label="本篇对话历史" aria-expanded="${Boolean(panel.historyOpen)}">${icon.history}</button>
      <div class="dock-segmented" role="tablist" aria-label="AI 伴读模式">
        <button type="button" role="tab" class="dock-seg-btn ${mode === 'chat' ? 'active' : ''}" data-reader-ai-mode="chat" aria-selected="${mode === 'chat'}">对话</button>
        <button type="button" role="tab" class="dock-seg-btn ${mode === 'quiz' ? 'active' : ''}" data-reader-ai-mode="quiz" aria-selected="${mode === 'quiz'}">出题</button>
        <button type="button" role="tab" class="dock-seg-btn ${mode === 'canvas' ? 'active' : ''}" data-reader-ai-mode="canvas" aria-selected="${mode === 'canvas'}">画布</button>
      </div>
      <button type="button" class="icon-btn dock-icon-btn ${webOn ? 'web-on' : ''}" data-reader-ai-web title="${webOn ? '联网搜索已开启（点击关闭）' : '开启联网搜索'}" aria-label="切换联网搜索" aria-pressed="${webOn}">${icon.globe}</button>
    </div>
    ${historyList}
    <div class="dock-scroll ${hasMessages ? '' : 'is-empty'}">
      ${hasMessages ? streamBody : emptyBody}
    </div>
    <div class="dock-composer-wrap">
      <form class="dock-composer" id="reader-ai-form">
        <textarea id="reader-ai-input" name="question" rows="1" maxlength="2000" placeholder="${configured ? safe(placeholders[mode]) : '请先点击上方配置 AI 模型…'}" ${!configured || panel.loading ? 'disabled' : ''} required></textarea>
        <div class="dock-composer-bar">
          <div class="dock-composer-meta">
            <span class="dock-scope-tag">${icon.book}<span class="od-truncate">${webOn ? '本篇 + 联网' : '仅本篇原文'}</span></span>
          </div>
          <button type="submit" class="send-circle" aria-label="发送" ${!configured || panel.loading ? 'disabled' : ''}>${icon.arrowUp}</button>
        </div>
      </form>
    </div>`;
}
