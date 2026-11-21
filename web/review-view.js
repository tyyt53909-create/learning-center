import { icon } from './icons.js';
import { safe, types } from './library.js';

const sourceLabels = { key_point: 'AI 要点', note: '个人笔记', manual: '手动制卡' };
const ratings = [
  ['again', '重来', '1'],
  ['hard', '困难', '2'],
  ['good', '良好', '3'],
  ['easy', '简单', '4'],
];

export function dueText(dueAt) {
  const diff = new Date(dueAt).getTime() - Date.now();
  if (diff <= 0) return '今日待复习';
  const hours = Math.ceil(diff / 3_600_000);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.ceil(diff / 86_400_000)} 天后`;
}

function deckStage(review) {
  const card = review.cards[0];
  if (!card) {
    if (review.stats.total > 0) {
      return `<div class="review-empty">
        <div class="review-empty-icon done">${icon.graduationCap}</div>
        <h2>今日复习已完成</h2>
        <p>当前范围内已没有到期卡片${review.stats.reviewed_today ? `，今天已完成 ${review.stats.reviewed_today} 次巩固` : ''}。</p>
        <div class="actions">
          <button type="button" class="btn" data-review-scope="all">浏览全部 ${review.stats.total} 张卡片</button>
          <a class="btn primary" href="/" data-nav>返回资料库</a>
        </div>
      </div>`;
    }
    return `<div class="review-empty">
      <div class="review-empty-icon">${icon.layers}</div>
      <h2>还没有复习卡片</h2>
      <p>打开任意已解析的资料，在阅读器右侧点击「一键生成」即可将 AI 知识要点与笔记转为间隔复习卡片。</p>
      <a class="btn primary" href="/" data-nav>前往资料库挑选资料</a>
    </div>`;
  }
  const [typeLabel] = types[card.item_type] ?? ['资料'];
  const totalInQueue = review.cards.length + review.sessionDone;
  const currentNum = review.sessionDone + 1;
  const pct = totalInQueue > 0 ? Math.round((review.sessionDone / totalInQueue) * 100) : 0;
  return `<div class="deck-progress">
      <div class="deck-progress-head"><span>本次复习进度</span><span>剩余 ${review.cards.length} 张 · 第 ${currentNum} / ${totalInQueue} 张</span></div>
      <div class="deck-track"><div class="deck-fill" style="width:${pct}%"></div></div>
    </div>
    <article class="flashcard ${review.revealed ? 'revealed' : ''}" aria-live="polite">
      <header class="flashcard-head">
        <div class="flashcard-source">
          <span class="pill-soft">${safe(sourceLabels[card.source_kind] ?? '复习卡')}</span>
          <button type="button" class="source-link" data-open="${card.item_id}" ${card.anchor_id ? `data-open-anchor="${safe(card.anchor_id)}"` : ''}>${safe(typeLabel)} · ${safe(card.item_title)} ${icon.arrow}</button>
        </div>
        <div class="flashcard-actions">
          <button type="button" class="icon-btn note-action" data-edit-card="${card.id}" aria-label="编辑卡片">${icon.pencil}</button>
          <button type="button" class="icon-btn note-action danger" data-delete-card="${card.id}" aria-label="删除卡片">${icon.trash}</button>
        </div>
      </header>
      <div class="flashcard-front">
        <span class="eyebrow muted">概念 / 问题</span>
        <h2>${safe(card.front)}</h2>
      </div>
      ${review.revealed ? `<div class="flashcard-back">
        <span class="eyebrow muted">理解与要点</span>
        <p class="answer-text">${safe(card.back)}</p>
        ${card.quote ? `<blockquote class="card-quote"><q>${safe(card.quote)}</q></blockquote>` : ''}
        <div class="card-back-links">
          <button type="button" class="text-btn" data-open="${card.item_id}" ${card.anchor_id ? `data-open-anchor="${safe(card.anchor_id)}"` : ''}>${icon.link}${card.anchor_id ? '跳回原文锚点' : '打开所属资料'} ${icon.arrow}</button>
          <span class="muted small">已复习 ${card.repetitions} 次 · 难度系数 ${Number(card.ease_factor).toFixed(2)}</span>
        </div>
      </div>
      <footer class="grade-grid" role="group" aria-label="记忆熟悉度评分">
        ${ratings.map(([key, label, shortcut]) => `<button type="button" class="grade-btn grade-${key}" data-grade-card="${card.id}" data-rating="${key}">
          <strong>${label}</strong>
          <small>${safe(card.next_intervals?.[key] ?? '')}</small>
          <kbd>${shortcut}</kbd>
        </button>`).join('')}
      </footer>` : `<div class="flashcard-reveal">
        <button type="button" class="btn primary reveal-btn" data-reveal-card>显示答案 <kbd>Space</kbd></button>
      </div>`}
    </article>`;
}

function allCardsList(review) {
  if (!review.cards.length) {
    return `<div class="review-empty">
      <div class="review-empty-icon">${icon.layers}</div>
      <h2>当前范围下没有卡片</h2>
      <p>切换到「全部圈子」，或在阅读器中为资料生成复习卡片。</p>
    </div>`;
  }
  return `<div class="card-manage-list">${review.cards.map((card) => {
    const isDue = new Date(card.due_at).getTime() <= Date.now();
    return `<article class="manage-card">
      <div class="manage-card-head">
        <div class="manage-card-meta">
          <span class="pill-soft ${isDue ? 'due' : ''}">${dueText(card.due_at)}</span>
          <span class="pill-soft">${safe(sourceLabels[card.source_kind] ?? '复习卡')}</span>
          <button type="button" class="source-link" data-open="${card.item_id}" ${card.anchor_id ? `data-open-anchor="${safe(card.anchor_id)}"` : ''}>${safe(card.item_title)} ${icon.arrow}</button>
        </div>
        <div class="flashcard-actions">
          <button type="button" class="icon-btn note-action" data-edit-card="${card.id}" aria-label="编辑卡片">${icon.pencil}</button>
          <button type="button" class="icon-btn note-action danger" data-delete-card="${card.id}" aria-label="删除卡片">${icon.trash}</button>
        </div>
      </div>
      <h3>${safe(card.front)}</h3>
      <p class="od-clamp-3">${safe(card.back)}</p>
      ${card.quote ? `<p class="manage-quote">「${safe(card.quote)}」</p>` : ''}
    </article>`;
  }).join('')}</div>`;
}

export function reviewContent(state) {
  const { review, circles } = state;
  return `<header class="topbar">
      <button class="icon-btn mobile-menu" data-menu aria-label="展开或收起导航" aria-expanded="false">${icon.menu}</button>
      <div class="breadcrumb">个人空间 ${icon.chevron} <b>今日复习</b></div>
      <div class="top-right review-controls">
        <select id="review-circle" class="sort" aria-label="按圈子筛选复习卡片">
          <option value="">全部圈子</option>
          ${circles.map((c) => `<option value="${c.id}" ${review.circle === c.id ? 'selected' : ''}>${safe(c.name)}</option>`).join('')}
        </select>
        <div class="state-switch" role="group" aria-label="复习视图">
          <button type="button" class="state-opt ${review.scope === 'due' ? 'active' : ''}" data-review-scope="due" aria-pressed="${review.scope === 'due'}">待复习 (${review.stats.due})</button>
          <button type="button" class="state-opt ${review.scope === 'all' ? 'active' : ''}" data-review-scope="all" aria-pressed="${review.scope === 'all'}">全部卡片 (${review.stats.total})</button>
        </div>
      </div>
    </header>
    <div class="content review-page page-enter">
      <section class="heading">
        <div>
          <h1>间隔复习</h1>
          <p>按遗忘曲线主动回忆核心观点，随时点击引用回到原文锚点。</p>
        </div>
        <div class="review-stats">
          <div class="review-stat"><strong>${review.stats.due}</strong><small>待复习</small></div>
          <div class="review-stat"><strong>${review.stats.reviewed_today}</strong><small>今日已复习</small></div>
          <div class="review-stat"><strong>${review.stats.total}</strong><small>卡片总数</small></div>
        </div>
      </section>
      <section id="review-stage">${review.scope === 'due' ? deckStage(review) : allCardsList(review)}</section>
    </div>`;
}
