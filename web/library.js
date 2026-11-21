import { icon } from './icons.js';

export const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const date = (value) => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
export const types = {
  article: ['文章', 'file'], video: ['视频', 'play'], local_video: ['视频', 'play'],
  pdf: ['PDF', 'file'], markdown: ['笔记', 'file'], image: ['图片', 'image'],
};
export const learningStates = { inbox: '待读', learning: '学习中', mastered: '已掌握' };
const filters = [['all', '全部'], ['article', '文章'], ['video', '视频'], ['pdf', 'PDF'], ['markdown', '笔记'], ['image', '图片']];
export const isVideo = (item) => ['video', 'local_video'].includes(item.type);
export const isSmartCircle = (circle) => Boolean(circle?.smart_rules && (circle.smart_rules.auto_ai || circle.smart_rules.keywords?.length || circle.smart_rules.domains?.length || circle.smart_rules.types?.length));
export const sourceName = (item) => item.source_url ? new URL(item.source_url).hostname : '本地文件';
const viewTitles = { all: '全部资料', recent: '最近阅读', starred: '星标资料', review: '今日复习', ask: 'AI 问答' };

export function viewTitle(state) {
  return viewTitles[state.view] ?? state.circles.find(({ id }) => id === state.view)?.name ?? viewTitles.all;
}

export function sidebarContent(state) {
  const links = [
    ['all', 'grid', state.counts.all], ['recent', 'clock', state.counts.recent], ['starred', 'star', state.counts.starred],
  ];
  const link = (id, label, glyph, count) => {
    const href = id === 'all' ? '/' : `/?${viewTitles[id] ? 'view' : 'circle'}=${id}`;
    const active = state.view === id;
    return `<a class="nav-link ${active ? 'active' : ''}" href="${href}" data-nav ${active ? 'aria-current="page"' : ''}>${glyph}<span class="od-fill">${safe(label)}</span><span class="count">${count}</span></a>`;
  };
  const reviewActive = state.view === 'review';
  const due = state.counts.review_due ?? 0;
  const reviewLink = `<a class="nav-link ${reviewActive ? 'active' : ''}" href="/review" data-nav ${reviewActive ? 'aria-current="page"' : ''}>${icon.layers}<span class="od-fill">今日复习</span><span class="count ${due > 0 ? 'due-badge' : ''}">${due}</span></a>`;
  const askActive = state.view === 'ask';
  const askLink = `<a class="nav-link ${askActive ? 'active' : ''}" href="/ask" data-nav ${askActive ? 'aria-current="page"' : ''}>${icon.messageSquare}<span class="od-fill">AI 问答</span><span class="count">${state.counts.ai_configured ? 'AI' : ''}</span></a>`;
  const renderCircleLink = (circle) => link(
    circle.id,
    circle.name,
    isSmartCircle(circle) ? `<span class="smart-dot" title="智能分类圈子">${icon.sparkle}</span>` : '<span class="circle-dot"></span>',
    circle.count,
  );
  const hasCategories = state.circles.some((circle) => circle.category);
  let circlesMarkup = '';
  if (hasCategories) {
    const groups = new Map();
    for (const circle of state.circles) {
      const group = circle.category || '未分组';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(circle);
    }
    circlesMarkup = [...groups.entries()].map(([group, list]) =>
      `<div class="circle-group"><div class="circle-group-label">${safe(group)}</div>${list.map(renderCircleLink).join('')}</div>`,
    ).join('');
  } else {
    circlesMarkup = state.circles.map(renderCircleLink).join('');
  }
  return `<a href="/" data-nav class="brand" aria-label="学习中心首页"><span class="brand-mark">${icon.library}</span><span class="od-field"><strong>学习中心</strong><small>YOUR LEARNING SPACE</small></span></a>
    <nav aria-label="资料库导航">${links.map(([id, glyph, count]) => link(id, viewTitles[id], icon[glyph], count)).join('')}${reviewLink}${askLink}
      <div class="nav-heading"><span>我的圈子</span><div class="nav-heading-actions"><button class="icon-btn nav-mini-btn" data-smart-classify title="智能分类整理" aria-label="智能分类整理">${icon.sparkle}</button><button class="icon-btn nav-mini-btn" data-new-circle title="创建圈子" aria-label="创建圈子">${icon.plus}</button></div></div>
      ${circlesMarkup}</nav>
    <div class="sidebar-bottom"><div class="extension-card"><div class="od-row">${icon.puzzle}<strong>浏览器扩展</strong></div><p>保存当前网页的正文和链接。</p><button class="text-btn" data-extension>了解浏览器扩展 ${icon.arrow}</button></div>
      <div class="profile"><span class="avatar">L</span><span class="od-field od-fill"><strong class="od-truncate">我的学习空间</strong><small class="od-truncate">本地优先 · 个人资料库</small></span></div>
      <div class="sidebar-tools">
        <button type="button" class="sidebar-tool" data-theme-toggle aria-label="${state.theme === 'dark' ? '切换浅色外观' : '切换深色外观'}">${state.theme === 'dark' ? icon.sun : icon.moon}<span>${state.theme === 'dark' ? '浅色' : '深色'}</span></button>
        <button type="button" class="sidebar-tool" data-ai-settings aria-label="AI 模型与系统设置">${icon.sliders}<span>AI 设置</span></button>
      </div></div>`;
}

function smartRuleStrip(circle) {
  if (!isSmartCircle(circle)) return '';
  const rules = circle.smart_rules;
  const pills = [];
  if (rules.keywords?.length) pills.push(`关键词：${rules.keywords.join('、')}`);
  if (rules.domains?.length) pills.push(`域名：${rules.domains.join('、')}`);
  if (rules.types?.length) {
    const names = [...new Set(rules.types.map((t) => types[t]?.[0] ?? t))];
    pills.push(`类型：${names.join('、')}`);
  }
  if (rules.auto_ai) pills.push('AI 自动归类');
  return `<div class="smart-rule-strip">${icon.sparkle}<div class="smart-rule-pills">${pills.map((text) => `<span>${safe(text)}</span>`).join('')}</div>
    <button type="button" class="text-btn smart-apply-btn" data-apply-circle-rules="${circle.id}">立即匹配存量</button></div>`;
}

export function workspaceContent(state) {
  const circle = state.circles.find(({ id }) => id === state.view);
  const descriptions = { all: '每一次收藏，都是下一次理解的开始。', recent: '继续阅读最近打开的资料。', starred: '回顾已加星标的资料。' };
  const placeholder = state.counts.semantic_search ? '搜索知识库（关键词 + 语义）' : '搜索你的知识库';
  const crumb = circle?.category ? `个人空间 ${icon.chevron} ${safe(circle.category)} ${icon.chevron} <b>${safe(circle.name)}</b>` : `个人空间 ${icon.chevron} <b>${safe(viewTitle(state))}</b>`;
  return `<header class="topbar"><button class="icon-btn mobile-menu" data-menu aria-label="展开或收起导航" aria-expanded="false">${icon.menu}</button>
    <div class="breadcrumb">${crumb}</div>
    <div class="top-right"><label class="search">${icon.search}<input id="search" type="search" aria-label="搜索标题、正文或字幕" placeholder="${placeholder}" value="${safe(state.query)}"><kbd>${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></label></div></header>
    <div class="content page-enter"><section class="heading"><div><div class="heading-title-row"><h1>${safe(viewTitle(state))}</h1>${circle?.category ? `<span class="category-badge">${safe(circle.category)}</span>` : ''}</div><p>${safe(circle?.description || descriptions[state.view] || '浏览这个圈子的资料。')}</p>${circle ? smartRuleStrip(circle) : ''}</div>
      <div class="actions">${circle ? `<button class="icon-btn" data-circle-menu aria-label="圈子设置">${icon.settings}</button>` : ''}
      <button class="btn" data-add="note">${icon.filePlus}新建笔记</button><button class="btn" data-add="upload">${icon.upload}上传文件</button><button class="btn primary" data-add="url">${icon.plus}添加资料</button></div></section>
      <div id="spotlight"></div><section aria-label="资料列表"><div class="library-head"><div class="filters" role="group" aria-label="资料类型">${filters.map(([id, label]) => `<button class="filter" data-filter="${id}">${label}${id === 'all' ? '<span id="base-count"></span>' : ''}</button>`).join('')}</div>
      <div class="tools"><button type="button" class="btn-subtle ${state.batchMode ? 'active' : ''}" data-batch-toggle aria-pressed="${Boolean(state.batchMode)}">${icon.listChecks}<span>${state.batchMode ? '完成' : '批量'}</span></button>
      <select id="state-filter" class="sort" aria-label="学习状态"><option value="">全部状态</option><option value="inbox">待读 ${state.counts.inbox ?? 0}</option><option value="learning">学习中 ${state.counts.learning ?? 0}</option><option value="mastered">已掌握 ${state.counts.mastered ?? 0}</option></select>
      <select id="sort" class="sort" aria-label="排序方式"><option value="new">按收藏时间 ↓</option><option value="old">最早收藏在前</option><option value="title">按标题排序</option></select>
      <div class="view-toggle" role="group" aria-label="显示方式"><button data-layout="grid" aria-label="网格视图">${icon.grid}</button><button data-layout="list" aria-label="列表视图">${icon.list}</button></div></div></div>
      <div id="resources" class="library-grid" aria-busy="true"></div><div id="batch-bar"></div><div class="bottom-note"><span id="result-count" aria-live="polite"></span><span class="drop-strip">${icon.upload}拖入文件，添加到资料库</span></div></section></div>`;
}

export function spotlight(state, items) {
  if (state.view !== 'all' || state.query || state.stateFilter) return '';
  const recent = items.filter((item) => item.ingest_state === 'ready').sort((a, b) => new Date(b.visited_at ?? 0) - new Date(a.visited_at ?? 0))[0];
  const label = recent?.visited_at ? '继续阅读' : '开始阅读';
  const action = recent ? `data-open="${recent.id}"` : 'data-add="url"';
  const reindexAction = state.counts.semantic_search && state.counts.unindexed > 0
    ? `<button type="button" class="text-btn reindex-btn" data-reindex-embeddings>${icon.database}补建 ${state.counts.unindexed} 份语义索引</button>`
    : '';
  return `<section class="spotlight" aria-label="学习概览"><button class="continue" ${action}><div class="continue-copy"><span class="eyebrow">${icon.book} ${recent?.visited_at ? 'CONTINUE READING' : 'START WITH AN IDEA'}</span><h2>${recent?.visited_at ? '继续上次的思考。' : '收藏之后，<br>理解才刚刚开始。'}</h2>${recent ? `<p class="od-clamp-2">${safe(recent.title)}</p>` : ''}<span class="continue-link">${recent ? label : '添加第一份资料'} ${icon.arrow}</span></div><div class="concept" aria-hidden="true"><span>收集 Collect</span><i></i><span>连接 Connect</span><i></i><span>理解 Understand</span></div></button>
    <div class="overview"><div class="overview-top"><span>学习概览</span>${icon.library}</div><div class="stats stats-3"><div class="od-stat"><strong>${state.counts.all}</strong><small>已收藏资料</small></div><div class="od-stat"><strong>${state.counts.mastered ?? 0}</strong><small>已掌握</small></div><div class="od-stat"><strong>${state.circles.length}</strong><small>学习圈子</small></div></div><div class="overview-bottom"><span class="overview-status">${icon.shield}${state.counts.semantic_search ? '本地优先 · 语义检索已启用' : '本地优先 · 个人资料库'}</span>${reindexAction}</div></div></section>`;
}

export function starButton(item) {
  const label = item.starred ? '取消星标' : '添加星标';
  return `<button class="icon-btn ${item.starred ? 'starred' : ''}" data-star="${item.id}" aria-label="${label} ${safe(item.title)}" aria-pressed="${Boolean(item.starred)}">${icon.star}</button>`;
}

export function itemCard(item, circles, pending, batch = { active: false, selected: false }) {
  const [label, glyph] = types[item.type];
  const preview = item.type === 'image' && item.has_file && item.ingest_state === 'ready'
    ? `<img class="image-preview" src="/api/items/${item.id}/file" alt="" loading="lazy">`
    : `<div class="document-preview ${isVideo(item) ? 'dark' : ''}"><span class="preview-kicker">${safe(sourceName(item))}</span>
      <div class="${isVideo(item) ? 'video-preview' : ''}"><strong class="od-clamp-2">${safe(item.title)}</strong>${isVideo(item) ? `<span class="play-circle">${icon.play}</span>` : ''}</div>
      <div class="preview-lines" aria-hidden="true"><i></i><i></i><i></i></div></div>`;
  const matchBadge = item.match_type === 'semantic' ? '<span class="badge semantic">语义匹配</span>'
    : item.match_type === 'hybrid' ? '<span class="badge semantic">语义 + 关键词</span>' : '';
  const statusBadge = item.ingest_state === 'failed' ? '<span class="badge failed">解析失败</span>' : item.ingest_state !== 'ready'
    ? '<span class="badge">解析中</span>' : item.ai_state === 'ready' ? `<span class="badge">${icon.sparkle} AI 摘要</span>` : '';
  const badge = matchBadge || statusBadge;
  const itemCircles = circles.filter(({ id }) => item.circle_ids.includes(id));
  const circleLabel = itemCircles.length > 1 ? `${itemCircles[0].name} +${itemCircles.length - 1}` : (itemCircles[0]?.name || '未分类');
  const circleTitle = itemCircles.map(({ name }) => name).join('、') || '未分类';
  const stateLabel = learningStates[item.learning_state];
  const snippet = item.match_snippet
    ? `<button type="button" class="match-snippet od-clamp-2" data-open="${item.id}" ${item.match_anchor_id ? `data-open-anchor="${safe(item.match_anchor_id)}"` : ''}>${safe(item.match_snippet)}</button>`
    : item.summary?.[0] ? `<p class="resource-description od-clamp-2">${safe(item.summary[0])}</p>` : '';
  const selectButton = !pending && batch.active
    ? `<button type="button" class="select-check ${batch.selected ? 'checked' : ''}" data-select-item="${item.id}" aria-pressed="${batch.selected}" aria-label="${batch.selected ? '取消选择' : '选择'} ${safe(item.title)}">${batch.selected ? icon.check : ''}</button>`
    : '';
  const primaryAttr = pending ? '' : batch.active ? `data-select-item="${item.id}"` : `data-open="${item.id}"`;
  return `<article class="resource ${batch.selected ? 'selected' : ''}">${selectButton}${pending ? `<div class="preview-button">${preview}</div>` : `<button class="preview-button" ${primaryAttr} aria-label="${batch.active ? '选择' : '阅读'} ${safe(item.title)}">${preview}</button>`}
    <div class="resource-body"><div class="resource-type"><span>${icon[glyph]}${label} · ${item.source_url ? '在线资料' : '本地文件'}</span>${badge}</div>
    ${pending ? `<div class="title-button od-clamp-2">${safe(item.title)}</div>` : `<button class="title-button od-clamp-2" ${primaryAttr}>${safe(item.title)}</button>`}
    ${snippet}
    <footer class="resource-footer"><div class="resource-tags"><span class="circle-tag od-truncate" title="${safe(circleTitle)}">${safe(circleLabel)}</span>${!pending && stateLabel ? `<button type="button" class="state-pill state-${safe(item.learning_state)}" data-cycle-state="${item.id}" data-current-state="${safe(item.learning_state)}" title="点击切换学习状态" aria-label="学习状态：${stateLabel}，点击切换">${stateLabel}</button>` : ''}</div><span>${date(item.created_at)}</span>${pending ? '' : starButton(item)}</footer></div></article>`;
}

export function batchBar(state, visibleCount) {
  if (!state.batchMode) return '';
  const count = state.selectedIds.size;
  const allSelected = visibleCount > 0 && count >= visibleCount;
  return `<div class="batch-bar" role="region" aria-label="批量操作">
    <span class="batch-count">已选 <b>${count}</b> 项</span>
    <button type="button" class="batch-btn" data-batch-all>${allSelected ? '取消全选' : '全选当前'}</button>
    <span class="batch-sep" aria-hidden="true"></span>
    <button type="button" class="batch-btn" data-batch-state="learning" ${count ? '' : 'disabled'}>标为学习中</button>
    <button type="button" class="batch-btn" data-batch-state="mastered" ${count ? '' : 'disabled'}>标为已掌握</button>
    <button type="button" class="batch-btn" data-batch-circles ${count ? '' : 'disabled'}>加入圈子</button>
    <button type="button" class="batch-btn danger" data-batch-delete ${count ? '' : 'disabled'}>删除</button>
  </div>`;
}

export function emptyContent(state) {
  const filtered = state.query || state.filter !== 'all' || state.stateFilter;
  const savedView = ['recent', 'starred'].includes(state.view);
  const hint = filtered ? '试试其他关键词，或清除筛选。' : ({ recent: '打开一份资料，就能在这里继续阅读。', starred: '点击资料卡上的星标，留下值得回顾的内容。' })[state.view] || '添加一条链接，或上传第一份学习资料。';
  return `<div class="empty">${filtered ? icon.search : icon.folder}<h2>${filtered ? '没有找到相关资料' : '这里还没有资料'}</h2><p>${hint}</p>
    <button class="btn" ${filtered ? 'data-clear' : savedView ? 'data-all' : 'data-add="url"'}>${filtered ? '清除搜索与筛选' : savedView ? '浏览全部资料' : '添加资料'}</button></div>`;
}
