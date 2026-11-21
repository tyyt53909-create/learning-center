import { icon } from './icons.js';
import { safe } from './library.js';

const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

export function buildSandboxDoc(rawHtml, theme = 'light') {
  const darkVars = theme === 'dark'
    ? '--bg:#1c1c1e;--surface:#121214;--fg:#f5f5f7;--fg-2:#d1d1d6;--muted:#98989d;--border:#3a3a3c;--accent:#0a84ff;--success:#22c55e;--danger:#ef4444;color-scheme:dark;'
    : '--bg:#ffffff;--surface:#f5f5f7;--fg:#1d1d1f;--fg-2:#424245;--muted:#6e6e73;--border:#d2d2d7;--accent:#0071e3;--success:#16a34a;--danger:#dc2626;color-scheme:light;';
  const baseStyle = `<style>:root{${darkVars}}*{box-sizing:border-box}html,body{margin:0;padding:14px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}button,input,select{font:inherit}</style>`;
  const src = String(rawHtml ?? '').trim();
  if (/<html[\s>]/i.test(src) || /<!doctype/i.test(src)) {
    return /<head[\s>]/i.test(src) ? src.replace(/<head([^>]*)>/i, `<head$1>${baseStyle}`) : `${baseStyle}${src}`;
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${baseStyle}</head><body>${src}</body></html>`;
}

export function renderQuizWidget(widget, msgId, quizAnswers = {}) {
  const questions = Array.isArray(widget?.questions) ? widget.questions : [];
  let answered = 0;
  let correct = 0;
  questions.forEach((q, qIdx) => {
    const picked = quizAnswers[`${msgId}:${qIdx}`];
    if (picked !== undefined) {
      answered++;
      if (picked === q.correct_index) correct++;
    }
  });
  const done = questions.length > 0 && answered === questions.length;
  const pct = questions.length ? Math.round((correct / questions.length) * 100) : 0;

  return `<div class="widget-card quiz-widget">
    <header class="widget-head">
      <div class="widget-title">${icon.checkCircle}<div><strong>${safe(widget.title || '互动测验')}</strong><small>已完成 ${answered} / ${questions.length} 题${answered ? ` · 答对 ${correct} 题` : ''}</small></div></div>
      ${answered ? `<button type="button" class="text-btn" data-quiz-reset="${safe(msgId)}">${icon.refresh}重做</button>` : ''}
    </header>
    <div class="quiz-list">${questions.map((q, qIdx) => {
      const picked = quizAnswers[`${msgId}:${qIdx}`];
      const hasPicked = picked !== undefined;
      const isRight = hasPicked && picked === q.correct_index;
      return `<article class="quiz-q">
        <div class="quiz-q-title"><span class="quiz-num">${qIdx + 1}</span><h4>${safe(q.question)}</h4></div>
        <div class="quiz-options">${q.options.map((opt, optIdx) => {
          let cls = '';
          if (hasPicked) {
            if (optIdx === q.correct_index) cls = 'correct';
            else if (optIdx === picked) cls = 'wrong';
          }
          return `<button type="button" class="quiz-opt ${cls}" data-quiz-pick="${safe(msgId)}" data-q-idx="${qIdx}" data-opt-idx="${optIdx}" ${hasPicked ? 'disabled' : ''}>
            <span class="quiz-letter">${letters[optIdx] ?? optIdx + 1}</span>
            <span class="quiz-opt-text">${safe(opt)}</span>
          </button>`;
        }).join('')}</div>
        ${hasPicked ? `<div class="quiz-feedback ${isRight ? 'right' : 'wrong'}">
          <p><b>${isRight ? '回答正确' : `回答有误，正确答案是 ${letters[q.correct_index] ?? q.correct_index + 1}`}：</b>${safe(q.explanation)}</p>
          <div class="quiz-feedback-actions">
            ${q.source === 'web' && q.url ? `<a class="text-btn" href="${safe(q.url)}" target="_blank" rel="noopener noreferrer">${icon.globe}查看联网来源 ${icon.arrow}</a>` : ''}
            ${q.source !== 'web' && q.anchor_id && q.item_id ? `<button type="button" class="text-btn" data-open="${safe(q.item_id)}" data-open-anchor="${safe(q.anchor_id)}">${icon.link}查看原文依据 ${icon.arrow}</button>` : ''}
            ${q.item_id ? `<button type="button" class="text-btn" data-quiz-to-card="${safe(msgId)}" data-q-idx="${qIdx}">${icon.layers}加入复习闪卡</button>` : ''}
          </div>
        </div>` : ''}
      </article>`;
    }).join('')}</div>
    ${done ? `<footer class="quiz-summary">
      <span>测验完成 · 正确率 <b>${pct}%</b>（${correct}/${questions.length}）</span>
      <button type="button" class="btn" data-quiz-reset="${safe(msgId)}">重新作答</button>
    </footer>` : ''}
  </div>`;
}

export function renderCanvasCard(widget, msgId, theme) {
  const srcdoc = safe(buildSandboxDoc(widget.html, theme));
  return `<div class="widget-card canvas-widget">
    <header class="widget-head">
      <div class="widget-title">${icon.code2}<div><strong>${safe(widget.title || '交互组件')}</strong><small>可交互沙箱组件 · 支持在线改代码</small></div></div>
      <div class="widget-actions">
        <button type="button" class="text-btn" data-copy-canvas="${safe(msgId)}">${icon.copy}复制</button>
        <button type="button" class="btn-subtle active" data-open-canvas="${safe(msgId)}">${icon.panelRight}<span>展开画布 / 改代码</span></button>
      </div>
    </header>
    <div class="canvas-inline-frame">
      <iframe class="sandbox-frame" sandbox="allow-scripts" title="${safe(widget.title || '交互组件')}" srcdoc="${srcdoc}"></iframe>
    </div>
  </div>`;
}

export function renderCanvasStudio(canvas, theme) {
  const srcdoc = safe(buildSandboxDoc(canvas.html, theme));
  const view = canvas.view || 'split';
  return `<section class="canvas-studio" aria-label="交互代码画布">
    <header class="studio-head">
      <div class="studio-title">${icon.code2}<div class="od-field"><strong class="od-truncate">${safe(canvas.title || '交互画布')}</strong><small>安全沙箱实时运行 · ⌘/Ctrl+Enter 运行</small></div></div>
      <div class="studio-controls">
        <div class="state-switch" role="group" aria-label="画布视图">
          <button type="button" class="state-opt ${view === 'split' ? 'active' : ''}" data-canvas-view="split">分屏</button>
          <button type="button" class="state-opt ${view === 'preview' ? 'active' : ''}" data-canvas-view="preview">预览</button>
          <button type="button" class="state-opt ${view === 'code' ? 'active' : ''}" data-canvas-view="code">代码</button>
        </div>
        <button type="button" class="btn-subtle" data-run-canvas>${icon.play}<span>运行</span></button>
        <button type="button" class="btn-subtle" data-copy-canvas="${safe(canvas.msgId)}">${icon.copy}<span>复制</span></button>
        ${canvas.persisted ? '<button type="button" class="btn-subtle active" data-save-canvas>保存</button>' : ''}
        <button type="button" class="icon-btn note-action" data-close-canvas aria-label="关闭画布">${icon.close}</button>
      </div>
    </header>
    <div class="studio-body view-${view}">
      <div class="studio-code-pane">
        <textarea id="canvas-editor" class="canvas-code-editor" spellcheck="false" aria-label="交互组件 HTML/CSS/JS 代码">${safe(canvas.html)}</textarea>
      </div>
      <div class="studio-preview-pane">
        <iframe id="canvas-preview" class="sandbox-frame studio-frame" sandbox="allow-scripts" title="${safe(canvas.title || '画布预览')}" srcdoc="${srcdoc}"></iframe>
      </div>
    </div>
  </section>`;
}

export const demoQuizWidget = {
  kind: 'quiz',
  title: '高效学习法 · 随堂互动测验（示例）',
  intro: '这是一个无需配置 API Key 即可直接体验的交互式选择题组件；配置 AI 模型后可基于你收藏的任意资料实时出题。',
  questions: [
    {
      question: '间隔重复（Spaced Repetition）相比考前集中突击，核心优势在于什么？',
      options: [
        '减少总阅读字数',
        '在即将遗忘的临界点触发主动回忆，显著强化长期记忆提取强度',
        '完全不需要理解概念本身',
        '让每次复习耗时翻倍',
      ],
      correct_index: 1,
      explanation: '在记忆即将衰退时进行主动提取（Active Recall）能带来最强的巩固增益，SM-2 算法正是动态拉长复习间隔。',
    },
    {
      question: '为什么 AI 知识提炼与问答强调「逐字原文锚点引用」？',
      options: [
        '让回答看起来字数更多',
        '降低大模型推理速度',
        '防止模型幻觉，并支持一键跳回原始段落或视频时间点核验上下文',
        '替代本地数据库存储',
      ],
      correct_index: 2,
      explanation: '逐字校验保证每条引用都真实存在于原资料中，阅读者可随时溯源核对语境，避免被幻觉误导。',
    },
    {
      question: '在个人资料库中，将「收藏」转化为「理解」最有效的一步是？',
      options: [
        '只保存链接从不打开',
        '用自己的话记录笔记、生成复习卡并建立跨资料连接',
        '把所有文件都塞进同一个未命名文件夹',
        '关闭所有检索和标签功能',
      ],
      correct_index: 1,
      explanation: '输出自己的思考、主动回忆与跨主题连接，才能把外部信息内化为可调用的个人知识。',
    },
  ],
};

export const demoCanvasWidget = {
  kind: 'canvas',
  title: '梯度下降步长模拟器（交互代码画布示例）',
  description: '拖动学习率滑块并点击「迭代一步」或「自动演示」，观察参数沿损失曲线收敛或震荡；你可以点击「展开画布 / 改代码」直接修改 HTML/CSS/JS 并实时运行！',
  html: `<style>
  .wrap{display:grid;gap:12px}
  .top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
  .stats{display:flex;gap:12px;font-size:12px;color:var(--muted);font-family:ui-monospace,monospace}
  .stats b{color:var(--fg)}
  svg{width:100%;height:190px;background:var(--surface);border-radius:10px;border:1px solid var(--border)}
  .controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .controls label{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px;flex:1;min-width:180px}
  input[type=range]{flex:1;accent-color:var(--accent)}
  .btn{padding:6px 12px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font-size:12px;cursor:pointer}
  .btn.pri{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
</style>
<div class="wrap">
  <div class="top">
    <strong>损失函数 L(w) = (w - 0.5)² + 0.2</strong>
    <div class="stats">步数 <b id="step">0</b> · w=<b id="wval">-2.20</b> · Loss=<b id="lval">7.49</b></div>
  </div>
  <svg id="plot" viewBox="0 0 420 190"></svg>
  <div class="controls">
    <label>学习率 η=<b id="lrval">0.20</b><input id="lr" type="range" min="0.02" max="1.05" step="0.01" value="0.20"></label>
    <button class="btn pri" id="go">迭代一步</button>
    <button class="btn" id="auto">自动演示</button>
    <button class="btn" id="reset">重置</button>
  </div>
</div>
<script>
  const f = (w) => (w - 0.5) ** 2 + 0.2;
  const df = (w) => 2 * (w - 0.5);
  let w = -2.2, step = 0, trail = [w], timer = null;
  const toX = (x) => 210 + x * 62;
  const toY = (y) => 170 - Math.min(y, 10) * 15;
  function draw() {
    let d = '';
    for (let x = -3; x <= 3.2; x += 0.1) d += (d ? 'L' : 'M') + toX(x).toFixed(1) + ',' + toY(f(x)).toFixed(1);
    const pts = trail.map((v) => toX(v).toFixed(1) + ',' + toY(f(v)).toFixed(1)).join(' ');
    document.getElementById('plot').innerHTML =
      '<path d="' + d + '" fill="none" stroke="var(--muted)" stroke-width="2" opacity="0.55"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"/>' +
      '<circle cx="' + toX(0.5) + '" cy="' + toY(0.2) + '" r="4" fill="var(--success)"/>' +
      '<circle cx="' + toX(w).toFixed(1) + '" cy="' + toY(f(w)).toFixed(1) + '" r="6" fill="var(--accent)"/>';
    document.getElementById('step').textContent = step;
    document.getElementById('wval').textContent = w.toFixed(2);
    document.getElementById('lval').textContent = f(w).toFixed(3);
  }
  function tick() {
    const lr = Number(document.getElementById('lr').value);
    w = Math.max(-3.1, Math.min(3.1, w - lr * df(w)));
    step++; trail.push(w); if (trail.length > 30) trail.shift();
    draw();
  }
  document.getElementById('lr').oninput = (e) => document.getElementById('lrval').textContent = Number(e.target.value).toFixed(2);
  document.getElementById('go').onclick = tick;
  document.getElementById('auto').onclick = () => {
    if (timer) { clearInterval(timer); timer = null; document.getElementById('auto').textContent = '自动演示'; return; }
    document.getElementById('auto').textContent = '暂停';
    timer = setInterval(tick, 320);
  };
  document.getElementById('reset').onclick = () => { clearInterval(timer); timer = null; document.getElementById('auto').textContent = '自动演示'; w = -2.2; step = 0; trail = [w]; draw(); };
  draw();
</script>`,
};
