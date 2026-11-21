import { execFile, spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, readFile, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { openDatabase } from './db.js';
import {
  answerQuestion, embedTexts, generateAiFlashcards, generateCanvasWidget, generateQuizWidget,
  isChatConfigured, isEmbeddingConfigured, maskSecret, testAiConnection, vectorLiteral,
} from './ai.js';
import { computeSmartSuggestions, normalizeRules } from './classify.js';
import { markdownAnchors } from './markdown.js';
import { parseTranscriptInput } from './parse.js';
import { previewIntervals, reviewRatings, scheduleReview } from './review.js';
import { runWebSearch, searchProviders, testSearchConnection } from './search.js';
import { sourceUrl, videoSource } from './source.js';
import { startWorker } from './worker.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const messageOrder = "created_at, CASE role WHEN 'user' THEN 0 ELSE 1 END, id";
const learningStates = new Set(['inbox', 'learning', 'mastered']);
const learningStateLabels = { inbox: '待读', learning: '学习中', mastered: '已掌握' };
const itemTypeLabels = { article: '文章', video: '在线视频', local_video: '本地视频', pdf: 'PDF', markdown: 'Markdown 笔记', image: '图片' };
const digest = (value) => createHash('sha256').update(value).digest();

function formatClock(value) {
  const whole = Math.max(0, Math.floor(value || 0));
  const seconds = String(whole % 60).padStart(2, '0');
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${seconds}` : `${String(Math.floor(whole / 60)).padStart(2, '0')}:${seconds}`;
}

function formatExportMarkdown(item, circles, includeSource) {
  const lines = [`# ${item.title}`, ''];
  lines.push(`- **类型**：${itemTypeLabels[item.type] ?? item.type}`);
  lines.push(`- **学习状态**：${learningStateLabels[item.learning_state] ?? item.learning_state}`);
  if (circles.length) lines.push(`- **所属圈子**：${circles.join('、')}`);
  if (item.source_url) lines.push(`- **来源**：${item.source_url}`);
  lines.push(`- **收藏时间**：${new Date(item.created_at).toISOString()}`);
  if (item.distillation) {
    const d = item.distillation;
    lines.push('', '## 核心摘要', '');
    d.summary.forEach((sentence, index) => lines.push(`${index + 1}. ${sentence}`));
    lines.push('', '## 知识要点', '');
    for (const point of d.key_points_json) {
      lines.push(`### ${point.title}`, '', point.explanation, '');
      for (const source of point.sources) lines.push(`> ${source.quote}`, '');
    }
    if (d.recommended_tags?.length) lines.push('## 推荐标签', '', d.recommended_tags.map((tag) => `\`${tag}\``).join(' '), '');
  }
  if (item.notes.length) {
    lines.push('', '## 我的笔记', '');
    for (const note of item.notes) {
      lines.push(note.seconds === null ? `- ${note.text}` : `- **[${formatClock(note.seconds)}]** ${note.text}`);
    }
  }
  if (includeSource) {
    if (item.raw_markdown) {
      lines.push('', '---', '', '## 原文内容', '', item.raw_markdown);
    } else if (item.anchors.length) {
      lines.push('', '---', '', '## 字幕记录', '');
      for (const anchor of item.anchors) {
        const prefix = Number.isFinite(anchor.anchor_meta?.start) ? `[${formatClock(anchor.anchor_meta.start)}] ` : '';
        lines.push(`- ${prefix}${anchor.text}`);
      }
    }
  }
  return `${lines.join('\n').trim()}\n`;
}
const fileMimes = new Map([
  ['application/pdf', 'pdf'], ['video/mp4', 'local_video'], ['video/webm', 'local_video'], ['video/quicktime', 'local_video'],
  ['image/jpeg', 'image'], ['image/png', 'image'], ['image/gif', 'image'], ['image/webp', 'image'], ['image/avif', 'image'],
]);

function httpError(status, message) {
  throw Object.assign(new Error(message), { status });
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function circleIds(values, required = false) {
  if (!Array.isArray(values) || values.length > 50 || (required && !values.length) || values.some((id) => typeof id !== 'string' || !uuid.test(id))) {
    httpError(400, '请选择有效圈子');
  }
  return [...new Set(values.map((id) => id.toLowerCase()))];
}

async function attach(tx, item, ids) {
  if (!ids.length) return;
  const { rows: added } = await tx.query(`INSERT INTO circle_items (circle_id,item_id)
    SELECT id,$1 FROM circles WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb))
    ON CONFLICT DO NOTHING RETURNING circle_id`, [item, JSON.stringify(ids)]);
  if (added.length < ids.length) {
    const { rows: [row] } = await tx.query(`SELECT count(*) AS count FROM circle_items WHERE item_id=$1
      AND circle_id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb))`, [item, JSON.stringify(ids)]);
    if (Number(row.count) !== ids.length) httpError(404, '所选圈子不存在');
  }
}

export async function createApplication({ dataDir, databaseUrl, token, ai = {}, distDir = resolve('dist'), pollEvents = false }) {
  const originals = resolve(dataDir, 'originals');
  const staging = resolve(dataDir, 'staging');
  await Promise.all([mkdir(originals, { recursive: true }), mkdir(staging, { recursive: true })]);
  const db = await openDatabase(resolve(dataDir, 'db'), databaseUrl);
  const envAi = {
    key: ai.key || '',
    model: ai.model || '',
    base: ai.base || 'https://api.openai.com/v1',
    embeddingModel: ai.embeddingModel || '',
    embeddingKey: ai.embeddingKey || '',
    embeddingBase: ai.embeddingBase || '',
    searchProvider: searchProviders.has(ai.searchProvider) ? ai.searchProvider : 'duckduckgo',
    searchKey: ai.searchKey || '',
    searchBase: ai.searchBase || '',
  };
  let aiConfig = { ...envAi };
  async function reloadAiConfig() {
    const { rows: [row] } = await db.query("SELECT value FROM app_settings WHERE key='ai'");
    const stored = row?.value && typeof row.value === 'object' ? row.value : {};
    const next = {
      key: stored.key !== undefined ? stored.key : envAi.key,
      model: stored.model !== undefined ? stored.model : envAi.model,
      base: stored.base || envAi.base || 'https://api.openai.com/v1',
      embeddingModel: stored.embeddingModel !== undefined ? stored.embeddingModel : envAi.embeddingModel,
      embeddingKey: stored.embeddingKey !== undefined ? stored.embeddingKey : envAi.embeddingKey,
      embeddingBase: stored.embeddingBase !== undefined ? stored.embeddingBase : envAi.embeddingBase,
      searchProvider: searchProviders.has(stored.searchProvider) ? stored.searchProvider : envAi.searchProvider,
      searchKey: stored.searchKey !== undefined ? stored.searchKey : envAi.searchKey,
      searchBase: stored.searchBase !== undefined ? stored.searchBase : envAi.searchBase,
    };
    aiConfig = {
      ...next,
      embeddingKey: next.embeddingKey || next.key,
      embeddingBase: next.embeddingBase || next.base,
      rawEmbeddingKey: next.embeddingKey,
      rawEmbeddingBase: next.embeddingBase,
    };
  }
  await reloadAiConfig();
  const app = express();
  app.disable('x-powered-by');
  const streams = new Set();
  const publish = (id = null) => {
    for (const response of streams) response.write(`data: ${JSON.stringify({ id })}\n\n`);
  };
  const stopWorker = startWorker({ db, originals, ai: () => aiConfig, publish });
  const eventsTimer = setInterval(() => {
    if (pollEvents) publish();
    else for (const response of streams) response.write(': heartbeat\n\n');
  }, pollEvents ? 4_000 : 20_000);
  const expected = token && digest(token);
  const session = expected && digest(`learning-session:${token}`).toString('hex');
  const validToken = (candidate) => expected && typeof candidate === 'string' && timingSafeEqual(expected, digest(candidate));
  const upload = multer({ dest: staging, limits: { fileSize: 512 * 1024 * 1024, files: 1, fields: 2, fieldSize: 16_384 } });

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    const chrome = /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? '');
    if (origin && !chrome && origin !== `${req.protocol}://${req.get('host')}` && !['GET', 'HEAD'].includes(req.method)) {
      return res.status(403).json({ error: '请求来源无效' });
    }
    if (chrome) {
      if (req.path !== '/items/url' && req.path !== '/circles') return res.sendStatus(403);
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' });
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use('/api', express.json({ limit: '2mb' }));
  app.post('/api/login', (req, res) => {
    if (expected && !validToken(req.body?.token)) httpError(401, '访问令牌无效');
    if (expected) res.cookie('learning_session', session, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 7 * 86_400_000 });
    res.sendStatus(204);
  });
  app.use('/api', (req, res, next) => {
    if (!expected || validToken(req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1])) return next();
    const candidate = req.get('cookie')?.match(/(?:^|;\s*)learning_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (candidate && timingSafeEqual(Buffer.from(session), Buffer.from(candidate))) return next();
    res.status(401).json({ error: '需要访问令牌' });
  });

  app.get('/api/events', (_req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('data: {}\n\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
  });
  app.get(['/api/circles', '/api/items/url'], async (req, res) => {
    const { rows } = await db.query(`SELECT circles.*, (SELECT count(*)::int FROM circle_items WHERE circle_id=circles.id) AS count
      FROM circles ORDER BY created_at, name`);
    if (req.path === '/api/items/url' && typeof req.query.url === 'string' && req.query.url.trim()) {
      let existing = null;
      try {
        const parsed = sourceUrl(text(req.query.url, 8192));
        const video = videoSource(parsed);
        const canonical = video?.url ?? parsed.href;
        const { rows: [found] } = await db.query(`SELECT id,title,type,ingest_state,learning_state,
          ARRAY(SELECT circle_id FROM circle_items WHERE item_id=l.id) AS circle_ids
          FROM learning_items l WHERE source_url=$1`, [canonical]);
        existing = found ?? null;
      } catch { /* ignore invalid preview url */ }
      return res.json({ circles: rows, existing });
    }
    res.json(rows);
  });
  app.post('/api/circles', async (req, res) => {
    const name = text(req.body?.name, 60);
    if (!name) httpError(400, '请输入圈子名称');
    const description = text(req.body?.description, 500);
    const category = text(req.body?.category, 40);
    const smartRules = normalizeRules(req.body?.smart_rules);
    const { rows: [circle] } = await db.query(
      'INSERT INTO circles (name,description,category,smart_rules) VALUES ($1,$2,$3,$4::jsonb) RETURNING *',
      [name, description, category, JSON.stringify(smartRules)],
    );
    publish();
    res.status(201).json(circle);
  });
  app.patch('/api/circles/:id', async (req, res) => {
    const name = text(req.body?.name, 60);
    if (!name) httpError(400, '请输入圈子名称');
    const description = text(req.body?.description, 500);
    const hasCategory = req.body?.category !== undefined;
    const category = hasCategory ? text(req.body.category, 40) : null;
    const hasRules = req.body?.smart_rules !== undefined;
    const smartRules = hasRules ? JSON.stringify(normalizeRules(req.body.smart_rules)) : null;
    const { rows: [circle] } = await db.query(`UPDATE circles
      SET name=$2, description=$3, category=coalesce($4, category), smart_rules=coalesce($5::jsonb, smart_rules)
      WHERE id=$1 RETURNING *`, [req.params.id, name, description, category, smartRules]);
    if (!circle) httpError(404, '圈子不存在');
    publish();
    res.json(circle);
  });
  app.delete('/api/circles/:id', async (req, res) => {
    await db.query('DELETE FROM circles WHERE id=$1', [req.params.id]);
    publish();
    res.sendStatus(204);
  });
  app.post('/api/circles/:id/apply-rules', async (req, res) => {
    const circleId = req.params.id;
    const { rows: exists } = await db.query('SELECT id FROM circles WHERE id=$1', [circleId]);
    if (!exists.length) httpError(404, '圈子不存在');
    const suggestions = await computeSmartSuggestions(db, { circleId });
    if (req.body?.dry_run) return res.json({ suggestions });
    const added = await db.transaction(async (tx) => {
      let count = 0;
      for (const s of suggestions) {
        const { rows } = await tx.query('INSERT INTO circle_items (circle_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING item_id', [circleId, s.item_id]);
        count += rows.length;
      }
      return count;
    });
    if (added > 0) publish();
    res.json({ added, matched: suggestions.length });
  });
  app.post('/api/circles/smart-classify', async (req, res) => {
    const dryRun = Boolean(req.body?.dry_run);
    if (dryRun) {
      const suggestions = await computeSmartSuggestions(db);
      return res.json({ suggestions });
    }
    const entries = Array.isArray(req.body?.assignments) ? req.body.assignments : await computeSmartSuggestions(db);
    if (entries.length > 200) httpError(400, '单次最多应用 200 条分类建议');
    const result = await db.transaction(async (tx) => {
      let applied = 0;
      const createdCircles = [];
      const createdByName = new Map();
      for (const entry of entries) {
        const itemId = entry?.item_id;
        if (typeof itemId !== 'string' || !uuid.test(itemId)) continue;
        let targetCircleId = typeof entry?.circle_id === 'string' && uuid.test(entry.circle_id) ? entry.circle_id : null;
        if (!targetCircleId && typeof entry?.create_circle_name === 'string') {
          const newName = text(entry.create_circle_name, 60);
          if (!newName) continue;
          const lower = newName.toLowerCase();
          if (createdByName.has(lower)) {
            targetCircleId = createdByName.get(lower);
          } else {
            const { rows: [existing] } = await tx.query('SELECT id FROM circles WHERE lower(name)=lower($1)', [newName]);
            if (existing) {
              targetCircleId = existing.id;
            } else {
              const newCategory = text(entry.category, 40) || '智能分类';
              const { rows: [created] } = await tx.query(
                `INSERT INTO circles (name, description, category, smart_rules)
                 VALUES ($1, '由智能分类自动创建', $2, '{"auto_ai":true}'::jsonb) RETURNING id, name`,
                [newName, newCategory],
              );
              targetCircleId = created.id;
              createdCircles.push(created);
            }
            createdByName.set(lower, targetCircleId);
          }
        }
        if (!targetCircleId) continue;
        const { rows } = await tx.query(`INSERT INTO circle_items (circle_id, item_id)
          SELECT c.id, l.id FROM circles c, learning_items l WHERE c.id=$1 AND l.id=$2
          ON CONFLICT DO NOTHING RETURNING item_id`, [targetCircleId, itemId]);
        applied += rows.length;
      }
      return { applied, created_circles: createdCircles };
    });
    if (result.applied > 0 || result.created_circles.length > 0) publish();
    res.json(result);
  });

  const queryEmbedCache = new Map();
  async function queryEmbedding(query) {
    if (!isEmbeddingConfigured(aiConfig)) return null;
    const key = `${aiConfig.embeddingModel}:${query.toLowerCase()}`;
    const cached = queryEmbedCache.get(key);
    if (cached && cached.expires > Date.now()) {
      queryEmbedCache.delete(key);
      queryEmbedCache.set(key, cached);
      return cached.vector;
    }
    try {
      const vectors = await embedTexts([query], aiConfig);
      const vector = vectors?.[0] ?? null;
      if (vector) {
        queryEmbedCache.set(key, { vector, expires: Date.now() + 5 * 60_000 });
        if (queryEmbedCache.size > 64) queryEmbedCache.delete(queryEmbedCache.keys().next().value);
      }
      return vector;
    } catch (error) {
      console.error('语义搜索向量生成失败，已降级为关键词搜索', error.message);
      return null;
    }
  }

  function extractSearchTerms(question) {
    const cleaned = question.replace(/[？?！!。，,、；;：:“”"'()（）[\]【】\n\r\t]+/g, ' ').trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    const terms = [];
    const seen = new Set();
    const push = (t) => {
      const k = t.toLowerCase();
      if (t.length >= 2 && !seen.has(k)) { seen.add(k); terms.push(t); }
    };
    for (const part of parts) {
      if (/^[a-z0-9._-]+$/i.test(part)) {
        push(part);
      } else if (part.length <= 6) {
        push(part);
      } else {
        for (let i = 0; i <= part.length - 2 && terms.length < 12; i += 2) push(part.slice(i, i + 2));
      }
      if (terms.length >= 12) break;
    }
    return terms.slice(0, 8);
  }

  async function retrieveEvidence(question, scopeType, scopeId) {
    const circleId = scopeType === 'circle' ? scopeId : null;
    const itemId = scopeType === 'item' ? scopeId : null;
    const collected = [];
    const seen = new Set();
    const add = (row) => {
      if (!row?.anchor_id || seen.has(row.anchor_id)) return;
      seen.add(row.anchor_id);
      collected.push(row);
    };

    const vector = await queryEmbedding(question);
    if (vector) {
      const literal = vectorLiteral(vector);
      const { rows } = await db.query(`SELECT a.id AS anchor_id, a.item_id, l.title AS item_title, a.text
        FROM content_anchors a JOIN learning_items l ON l.id=a.item_id
        WHERE a.embedding IS NOT NULL AND vector_dims(a.embedding) = $2
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$3))
          AND ($4::uuid IS NULL OR a.item_id=$4)
          AND (a.embedding <=> $1::vector) <= 0.72
        ORDER BY a.embedding <=> $1::vector LIMIT 12`, [literal, vector.length, circleId, itemId]);
      rows.forEach(add);
    }

    const terms = extractSearchTerms(question);
    if (terms.length && collected.length < 14) {
      const { rows } = await db.query(`SELECT a.id AS anchor_id, a.item_id, l.title AS item_title, a.text,
          (SELECT count(*)::int FROM jsonb_array_elements_text($1::jsonb) AS t(term)
            WHERE position(lower(t.term) in lower(a.text || ' ' || l.title)) > 0) AS hits
        FROM content_anchors a JOIN learning_items l ON l.id=a.item_id
        WHERE ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$2))
          AND ($3::uuid IS NULL OR a.item_id=$3)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text($1::jsonb) AS t(term)
            WHERE position(lower(t.term) in lower(a.text || ' ' || l.title)) > 0)
        ORDER BY hits DESC, l.created_at DESC, a.chunk_index ASC LIMIT 14`, [JSON.stringify(terms), circleId, itemId]);
      rows.forEach(add);
    }

    if (itemId && collected.length < 12) {
      const { rows } = await db.query(`SELECT a.id AS anchor_id, a.item_id, l.title AS item_title, a.text
        FROM content_anchors a JOIN learning_items l ON l.id=a.item_id
        WHERE a.item_id=$1 ORDER BY a.chunk_index ASC`, [itemId]);
      if (rows.length) {
        const take = Math.min(16, rows.length);
        for (let i = 0; i < take; i++) add(rows[Math.floor((i * rows.length) / take)]);
      }
      if (collected.length < 16) {
        const { rows: noteRows } = await db.query(`SELECT n.id AS anchor_id, n.item_id, l.title AS item_title, n.text
          FROM item_notes n JOIN learning_items l ON l.id=n.item_id
          WHERE n.item_id=$1 ORDER BY n.created_at ASC LIMIT 8`, [itemId]);
        noteRows.forEach(add);
      }
    } else if (!collected.length) {
      const { rows } = await db.query(`SELECT a.id AS anchor_id, a.item_id, l.title AS item_title, a.text
        FROM content_anchors a JOIN learning_items l ON l.id=a.item_id
        WHERE l.ingest_state='ready'
          AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$1))
          AND a.chunk_index < 4
        ORDER BY l.created_at DESC, a.chunk_index ASC LIMIT 12`, [circleId]);
      rows.forEach(add);
    }
    return collected.slice(0, 16);
  }

  async function loadItemContext(itemId) {
    if (!itemId) return null;
    const { rows: [row] } = await db.query('SELECT id, title, type, source_url, metadata_json FROM learning_items WHERE id=$1', [itemId]);
    if (!row) return null;
    const meta = row.metadata_json ?? {};
    return {
      id: row.id,
      title: row.title,
      type: row.type,
      type_label: itemTypeLabels[row.type] ?? row.type,
      source_url: row.source_url || null,
      author: meta.author || null,
      duration: meta.duration || null,
      description: typeof meta.description === 'string' ? meta.description.slice(0, 1500) : '',
      caption_message: meta.captionMessage || meta.notice || null,
    };
  }

  app.get('/api/system/status', (_req, res) => {
    res.json({
      storage: databaseUrl ? 'postgresql' : 'pglite',
      auth: Boolean(expected),
      ai_distill: { configured: isChatConfigured(aiConfig), model: aiConfig.model || null },
      semantic_search: { configured: isEmbeddingConfigured(aiConfig), model: aiConfig.embeddingModel || null },
    });
  });
  const execFileAsync = promisify(execFile);
  const extensionDir = resolve(distDir, 'extension');
  const isLoopbackReq = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip || req.socket?.remoteAddress || '');
  app.get('/api/system/extension', async (req, res) => {
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
    } catch { /* not built yet */ }
    res.json({
      ready: Boolean(manifest),
      name: manifest?.name || '学习中心 · 剪藏助手',
      version: manifest?.version || '1.0.0',
      path: extensionDir,
      platform: process.platform,
      can_open_folder: isLoopbackReq(req),
    });
  });
  app.post('/api/system/extension/open', async (req, res) => {
    if (!isLoopbackReq(req)) httpError(403, '仅支持在本机打开安装助手');
    try {
      await readFile(join(extensionDir, 'manifest.json'), 'utf8');
    } catch {
      httpError(404, '插件尚未构建，请先运行 npm run build');
    }
    const action = ['assist', 'chrome', 'folder'].includes(req.body?.action) ? req.body.action : 'assist';
    let chromeOpened = false;
    let folderOpened = false;
    let browserName = 'Google Chrome';

    if (action === 'assist' || action === 'chrome') {
      if (process.platform === 'darwin') {
        const script = `
          set targetUrl to "chrome://extensions/"
          set openedName to ""
          repeat with appName in {"Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Chromium"}
            try
              do shell script "open -Ra " & quoted form of (appName as text)
              set openedName to (appName as text)
              exit repeat
            end try
          end repeat
          if openedName is "" then error "NO_CHROME"
          tell application openedName
            activate
            if (count of windows) is 0 then
              make new window
              set URL of active tab of front window to targetUrl
            else
              set foundTab to false
              repeat with w in windows
                set tabIdx to 0
                repeat with t in tabs of w
                  set tabIdx to tabIdx + 1
                  if URL of t starts with "chrome://extensions" then
                    set active tab index of w to tabIdx
                    set index of w to 1
                    set foundTab to true
                    exit repeat
                  end if
                end repeat
                if foundTab then exit repeat
              end repeat
              if not foundTab then
                make new tab at end of tabs of front window with properties {URL:targetUrl}
              end if
            end if
          end tell
          return openedName
        `;
        try {
          const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
          browserName = stdout.trim() || 'Google Chrome';
          chromeOpened = true;
        } catch {
          // Fall back to bringing Chrome to front if AppleScript automation permission was declined
          try {
            await execFileAsync('open', ['-a', 'Google Chrome']);
            chromeOpened = false;
          } catch { /* no Chrome installed */ }
        }
      }
    }

    if (action === 'assist' || action === 'folder') {
      if (process.platform === 'darwin') {
        await execFileAsync('open', ['-R', extensionDir]);
        folderOpened = true;
      } else if (process.platform === 'win32') {
        await execFileAsync('explorer', [`/select,${extensionDir}`]);
        folderOpened = true;
      } else {
        await execFileAsync('xdg-open', [extensionDir]);
        folderOpened = true;
      }
    }

    res.json({
      opened: action,
      chrome_opened: chromeOpened,
      browser_name: browserName,
      folder_opened: folderOpened,
      path: extensionDir,
    });
  });
  app.get('/api/system/extension/download', async (_req, res) => {
    let version = 'latest';
    try {
      const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
      if (manifest?.version) version = manifest.version;
    } catch {
      httpError(404, '插件尚未构建');
    }
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="learning-center-extension-v${version}.zip"`,
    });
    const child = spawn('zip', ['-qr', '-', '.'], { cwd: extensionDir });
    child.stdout.pipe(res);
    child.on('error', () => { if (!res.headersSent) res.status(500).json({ error: '打包扩展失败' }); });
  });
  app.get('/api/ai/settings', async (_req, res) => {
    const { rows: [stats] } = await db.query(`SELECT
      count(*) FILTER (WHERE ingest_state='ready' AND ai_state IN ('unconfigured','failed'))::int AS undistilled,
      count(*) FILTER (WHERE ingest_state='ready' AND EXISTS (
        SELECT 1 FROM content_anchors WHERE item_id=learning_items.id AND embedding IS NULL
      ))::int AS unindexed FROM learning_items`);
    res.json({
      base: aiConfig.base || 'https://api.openai.com/v1',
      model: aiConfig.model || '',
      has_key: Boolean(aiConfig.key),
      key_preview: maskSecret(aiConfig.key),
      embedding_base: aiConfig.rawEmbeddingBase || '',
      embedding_model: aiConfig.embeddingModel || '',
      has_embedding_key: Boolean(aiConfig.rawEmbeddingKey),
      embedding_key_preview: maskSecret(aiConfig.rawEmbeddingKey),
      search_provider: aiConfig.searchProvider || 'duckduckgo',
      search_base: aiConfig.searchBase || '',
      has_search_key: Boolean(aiConfig.searchKey),
      search_key_preview: maskSecret(aiConfig.searchKey),
      chat_configured: isChatConfigured(aiConfig),
      semantic_configured: isEmbeddingConfigured(aiConfig),
      ...stats,
    });
  });
  app.patch('/api/ai/settings', async (req, res) => {
    const { rows: [row] } = await db.query("SELECT value FROM app_settings WHERE key='ai'");
    const prev = row?.value && typeof row.value === 'object' ? row.value : {};
    const next = { ...prev };
    if (req.body?.base !== undefined) {
      const value = text(req.body.base, 300);
      if (value) {
        let parsed;
        try { parsed = new URL(value); } catch { httpError(400, '模型接口地址格式无效'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) httpError(400, '模型接口地址需使用 HTTP 或 HTTPS');
      }
      next.base = value || 'https://api.openai.com/v1';
    }
    if (req.body?.model !== undefined) next.model = text(req.body.model, 120);
    if (req.body?.key !== undefined) next.key = text(req.body.key, 500);
    if (req.body?.embedding_base !== undefined) {
      const value = text(req.body.embedding_base, 300);
      if (value) {
        let parsed;
        try { parsed = new URL(value); } catch { httpError(400, '向量接口地址格式无效'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) httpError(400, '向量接口地址需使用 HTTP 或 HTTPS');
      }
      next.embeddingBase = value;
    }
    if (req.body?.embedding_model !== undefined) next.embeddingModel = text(req.body.embedding_model, 120);
    if (req.body?.embedding_key !== undefined) next.embeddingKey = text(req.body.embedding_key, 500);
    if (req.body?.search_provider !== undefined) {
      const provider = text(req.body.search_provider, 30).toLowerCase();
      if (!searchProviders.has(provider)) httpError(400, '联网搜索引擎无效');
      next.searchProvider = provider;
    }
    if (req.body?.search_base !== undefined) {
      const value = text(req.body.search_base, 300);
      if (value) {
        let parsed;
        try { parsed = new URL(value); } catch { httpError(400, '搜索接口地址格式无效'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) httpError(400, '搜索接口地址需使用 HTTP 或 HTTPS');
      }
      next.searchBase = value;
    }
    if (req.body?.search_key !== undefined) next.searchKey = text(req.body.search_key, 500);
    await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('ai', $1::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=now()`, [JSON.stringify(next)]);
    await reloadAiConfig();
    queryEmbedCache.clear();
    publish();
    res.json({
      base: aiConfig.base,
      model: aiConfig.model,
      has_key: Boolean(aiConfig.key),
      key_preview: maskSecret(aiConfig.key),
      embedding_base: aiConfig.rawEmbeddingBase || '',
      embedding_model: aiConfig.embeddingModel || '',
      has_embedding_key: Boolean(aiConfig.rawEmbeddingKey),
      embedding_key_preview: maskSecret(aiConfig.rawEmbeddingKey),
      search_provider: aiConfig.searchProvider,
      search_base: aiConfig.searchBase,
      has_search_key: Boolean(aiConfig.searchKey),
      search_key_preview: maskSecret(aiConfig.searchKey),
      chat_configured: isChatConfigured(aiConfig),
      semantic_configured: isEmbeddingConfigured(aiConfig),
    });
  });
  app.post('/api/ai/test', async (req, res) => {
    const candidateBase = text(req.body?.base, 300) || aiConfig.base;
    const candidateKey = req.body?.key ? text(req.body.key, 500) : aiConfig.key;
    const candidateModel = req.body?.model !== undefined ? text(req.body.model, 120) : aiConfig.model;
    const candidateEmbedModel = req.body?.embedding_model !== undefined ? text(req.body.embedding_model, 120) : aiConfig.embeddingModel;
    const candidateEmbedBase = (req.body?.embedding_base !== undefined ? text(req.body.embedding_base, 300) : aiConfig.rawEmbeddingBase) || candidateBase;
    const candidateEmbedKey = req.body?.embedding_key ? text(req.body.embedding_key, 500) : (aiConfig.rawEmbeddingKey || candidateKey);
    const candidateSearchProvider = searchProviders.has(req.body?.search_provider) ? req.body.search_provider : aiConfig.searchProvider;
    const candidateSearchBase = req.body?.search_base !== undefined ? text(req.body.search_base, 300) : aiConfig.searchBase;
    const candidateSearchKey = req.body?.search_key ? text(req.body.search_key, 500) : aiConfig.searchKey;
    const probe = {
      base: candidateBase, key: candidateKey, model: candidateModel,
      embeddingBase: candidateEmbedBase, embeddingKey: candidateEmbedKey, embeddingModel: candidateEmbedModel,
      searchProvider: candidateSearchProvider, searchBase: candidateSearchBase, searchKey: candidateSearchKey,
    };
    const testSearch = Boolean(req.body?.test_search);
    if (testSearch) {
      return res.json({ chat: null, embedding: null, search: await testSearchConnection(probe) });
    }
    if (!isChatConfigured(probe) && !isEmbeddingConfigured(probe)) {
      httpError(400, '请至少填写对话模型或向量模型的密钥和名称后再测试');
    }
    res.json({ ...await testAiConnection(probe), search: null });
  });
  app.post('/api/ai/search', async (req, res) => {
    const query = text(req.body?.query, 500);
    if (!query) httpError(400, '请输入搜索关键词');
    const limit = Math.min(8, Math.max(1, Number.parseInt(req.body?.limit, 10) || 5));
    const results = await runWebSearch(query, aiConfig, { limit, enrich: req.body?.enrich !== false });
    res.json({ provider: aiConfig.searchProvider, results });
  });
  app.post('/api/ai/distill-pending', async (req, res) => {
    if (!isChatConfigured(aiConfig)) httpError(409, '尚未配置 AI 对话模型');
    const forceAll = Boolean(req.body?.all);
    const queued = await db.transaction(async (tx) => {
      const { rows } = await tx.query(`SELECT id FROM learning_items
        WHERE ingest_state='ready'
          AND ($1::boolean OR ai_state IN ('unconfigured', 'failed', 'unavailable'))`, [forceAll]);
      for (const { id } of rows) {
        await tx.query("UPDATE learning_items SET ai_state='pending', ai_error=null WHERE id=$1", [id]);
        await tx.query(`INSERT INTO jobs (item_id, kind) VALUES ($1, 'distill')
          ON CONFLICT (item_id, kind) DO UPDATE SET lease_until=null, lease_token=null`, [id]);
      }
      return rows.length;
    });
    if (queued > 0) publish();
    res.status(202).json({ queued });
  });
  app.get('/api/ai/threads', async (req, res) => {
    const scopeType = ['all', 'circle', 'item'].includes(req.query.scope_type) ? req.query.scope_type : null;
    const scopeId = typeof req.query.scope_id === 'string' && req.query.scope_id.trim() ? req.query.scope_id.trim() : null;
    if (scopeId && !uuid.test(scopeId)) httpError(400, '问答范围无效');
    const { rows } = await db.query(`SELECT t.id, t.title, t.scope_type, t.scope_id, t.created_at, t.updated_at,
      (SELECT count(*)::int FROM ai_messages WHERE thread_id=t.id) AS message_count
      FROM ai_threads t
      WHERE ($1::text IS NULL OR t.scope_type=$1)
        AND ($2::uuid IS NULL OR t.scope_id=$2)
      ORDER BY t.updated_at DESC LIMIT 50`, [scopeType, scopeId]);
    res.json(rows);
  });
  app.get('/api/ai/threads/:id', async (req, res) => {
    const { rows: [thread] } = await db.query('SELECT * FROM ai_threads WHERE id=$1', [req.params.id]);
    if (!thread) httpError(404, '对话不存在');
    const { rows: messages } = await db.query(`SELECT id, role, content, citations_json, widget_json, web_sources_json, model_used, created_at
      FROM ai_messages WHERE thread_id=$1 ORDER BY ${messageOrder}`, [thread.id]);
    res.json({ ...thread, messages });
  });
  app.delete('/api/ai/threads/:id', async (req, res) => {
    await db.query('DELETE FROM ai_threads WHERE id=$1', [req.params.id]);
    publish();
    res.sendStatus(204);
  });
  app.patch('/api/ai/messages/:id/widget', async (req, res) => {
    const widget = req.body?.widget;
    if (!widget || typeof widget !== 'object' || !['canvas', 'quiz'].includes(widget.kind)) {
      httpError(400, '组件数据无效');
    }
    if (widget.kind === 'canvas' && (typeof widget.html !== 'string' || !widget.html.trim() || widget.html.length > 200_000)) {
      httpError(400, '组件代码不能为空且不超过 200 KB');
    }
    const { rows: [saved] } = await db.query(`UPDATE ai_messages SET widget_json=$2::jsonb
      WHERE id=$1 AND role='assistant' RETURNING id, role, content, citations_json, widget_json, web_sources_json, model_used, created_at`,
    [req.params.id, JSON.stringify(widget)]);
    if (!saved) httpError(404, '消息不存在');
    publish();
    res.json(saved);
  });
  app.post('/api/ai/ask', async (req, res) => {
    const question = text(req.body?.question, 2000);
    if (!question) httpError(400, '请输入你的问题');
    if (!isChatConfigured(aiConfig)) httpError(409, '请先在 AI 设置中配置 API Key 与模型');
    const mode = ['chat', 'quiz', 'canvas'].includes(req.body?.mode) ? req.body.mode : 'chat';
    const useWebSearch = Boolean(req.body?.web_search);
    let threadId = req.body?.thread_id || null;
    if (threadId && !uuid.test(threadId)) httpError(400, '对话 ID 无效');
    let scopeType = ['all', 'circle', 'item'].includes(req.body?.scope_type) ? req.body.scope_type : 'all';
    let scopeId = req.body?.scope_id || null;
    if (scopeType !== 'all' && (!scopeId || !uuid.test(scopeId))) httpError(400, '问答范围无效');
    if (scopeType === 'all') scopeId = null;

    let thread;
    let history = [];
    if (threadId) {
      const { rows: [found] } = await db.query('SELECT * FROM ai_threads WHERE id=$1', [threadId]);
      if (!found) httpError(404, '对话不存在');
      thread = found;
      scopeType = found.scope_type;
      scopeId = found.scope_id;
      const { rows: msgs } = await db.query(`SELECT role, content FROM ai_messages WHERE thread_id=$1 ORDER BY ${messageOrder}`, [found.id]);
      history = msgs;
    }

    let webWarning = null;
    const [localEvidence, itemContext, webResults] = await Promise.all([
      retrieveEvidence(question, scopeType, scopeId),
      scopeType === 'item' ? loadItemContext(scopeId) : Promise.resolve(null),
      useWebSearch
        ? runWebSearch(question, aiConfig, { limit: 5 }).catch((error) => {
            webWarning = error.message;
            console.error('联网搜索失败，已降级为仅本地资料库检索', error.message);
            return [];
          })
        : Promise.resolve([]),
    ]);
    const webSources = webResults.map(({ id, url, hostname, title, snippet }) => ({ id, url, hostname, title, snippet }));
    const webEvidence = webResults.map((r) => ({
      source: 'web',
      anchor_id: r.id,
      item_id: null,
      url: r.url,
      hostname: r.hostname,
      item_title: r.title,
      text: r.content,
    }));
    const evidence = [...webEvidence, ...localEvidence.map((e) => ({ ...e, source: 'local' }))];
    const reply = mode === 'quiz'
      ? await generateQuizWidget(question, evidence, aiConfig)
      : mode === 'canvas'
        ? await generateCanvasWidget(question, history, evidence, aiConfig)
        : await answerQuestion(question, history, evidence, aiConfig, itemContext);

    const saved = await db.transaction(async (tx) => {
      if (!thread) {
        const prefix = mode === 'quiz' ? '测验 · ' : mode === 'canvas' ? '组件 · ' : useWebSearch ? '联网 · ' : '';
        const { rows: [created] } = await tx.query(`INSERT INTO ai_threads (title, scope_type, scope_id)
          VALUES ($1, $2, $3) RETURNING *`, [`${prefix}${question}`.slice(0, 60), scopeType, scopeId]);
        thread = created;
      } else {
        await tx.query('UPDATE ai_threads SET updated_at=now() WHERE id=$1', [thread.id]);
      }
      const { rows: [userMsg] } = await tx.query(`INSERT INTO ai_messages (thread_id, role, content, created_at)
        VALUES ($1, 'user', $2, clock_timestamp()) RETURNING id, role, content, citations_json, widget_json, web_sources_json, model_used, created_at`, [thread.id, question]);
      const { rows: [aiMsg] } = await tx.query(`INSERT INTO ai_messages (thread_id, role, content, citations_json, widget_json, web_sources_json, model_used, created_at)
        VALUES ($1, 'assistant', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, clock_timestamp() + interval '1 millisecond') RETURNING id, role, content, citations_json, widget_json, web_sources_json, model_used, created_at`,
      [thread.id, reply.answer, JSON.stringify(reply.citations), reply.widget ? JSON.stringify(reply.widget) : null, JSON.stringify(webSources), reply.model]);
      return { thread, user_message: userMsg, assistant_message: aiMsg, follow_ups: reply.follow_ups, ...(webWarning ? { web_warning: webWarning } : {}) };
    });
    publish();
    res.status(201).json(saved);
  });
  app.post('/api/ai/threads/:id/save-note', async (req, res) => {
    const circleIdsList = circleIds(req.body?.circle_ids, true);
    const messageId = req.body?.message_id || null;
    const { rows: [thread] } = await db.query('SELECT * FROM ai_threads WHERE id=$1', [req.params.id]);
    if (!thread) httpError(404, '对话不存在');
    const { rows: messages } = await db.query(`SELECT id, role, content, citations_json FROM ai_messages
      WHERE thread_id=$1 ORDER BY ${messageOrder}`, [thread.id]);
    if (!messages.length) httpError(400, '对话为空');
    const targetMsgs = messageId ? messages.filter((m) => m.id === messageId) : messages;
    if (!targetMsgs.length) httpError(404, '消息不存在');
    const title = text(req.body?.title, 500) || `AI 问答 · ${thread.title}`;
    const lines = [`# ${title}`, ''];
    for (const msg of targetMsgs) {
      if (targetMsgs.length > 1) lines.push(msg.role === 'user' ? '## 提问' : '## AI 回答', '');
      lines.push(msg.content, '');
      if (msg.citations_json?.length) {
        lines.push('### 参考来源', '');
        for (const c of msg.citations_json) {
          const heading = c.source === 'web' && c.url ? `[${c.item_title}](${c.url})` : `**${c.item_title}**`;
          lines.push(`- ${heading}：> ${c.quote}`);
        }
        lines.push('');
      }
    }
    const markdown = lines.join('\n').trim();
    const itemId = await db.transaction(async (tx) => {
      const { rows: [created] } = await tx.query(`INSERT INTO learning_items (type, title, captured_markdown)
        VALUES ('markdown', $1, $2) RETURNING id`, [title, markdown]);
      await attach(tx, created.id, circleIdsList);
      await tx.query("INSERT INTO jobs (item_id, kind) VALUES ($1, 'parse')", [created.id]);
      return created.id;
    });
    publish(itemId);
    res.status(202).json({ id: itemId });
  });
  app.post('/api/items/note', async (req, res) => {
    const ids = circleIds(req.body?.circle_ids, true);
    const title = text(req.body?.title, 500);
    const content = text(req.body?.markdown, 500_000);
    if (!title) httpError(400, '请输入笔记标题');
    if (!content) httpError(400, '请输入笔记正文');
    const id = await db.transaction(async (tx) => {
      const { rows: [created] } = await tx.query(`INSERT INTO learning_items (type,title,captured_markdown)
        VALUES ('markdown',$1,$2) RETURNING id`, [title, content]);
      await attach(tx, created.id, ids);
      await tx.query("INSERT INTO jobs (item_id,kind) VALUES ($1,'parse')", [created.id]);
      return created.id;
    });
    publish(id);
    res.status(202).json({ id });
  });
  app.post('/api/items/batch', async (req, res) => {
    const rawIds = req.body?.ids;
    if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 100 || rawIds.some((id) => typeof id !== 'string' || !uuid.test(id))) {
      httpError(400, '请选择有效的资料');
    }
    const ids = [...new Set(rawIds.map((id) => id.toLowerCase()))];
    const action = req.body?.action;
    if (action === 'learning_state') {
      const nextState = req.body?.learning_state;
      if (!learningStates.has(nextState)) httpError(400, '学习状态无效');
      const { rows } = await db.query(`UPDATE learning_items SET learning_state=$2
        WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) RETURNING id`, [JSON.stringify(ids), nextState]);
      publish();
      return res.json({ affected: rows.length });
    }
    if (action === 'add_circles') {
      const targetCircles = circleIds(req.body?.circle_ids, true);
      const affected = await db.transaction(async (tx) => {
        const { rows: items } = await tx.query(`SELECT id FROM learning_items
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) FOR UPDATE`, [JSON.stringify(ids)]);
        for (const { id } of items) await attach(tx, id, targetCircles);
        return items.length;
      });
      publish();
      return res.json({ affected });
    }
    if (action === 'delete') {
      const { affected, orphanKeys } = await db.transaction(async (tx) => {
        const { rows: removed } = await tx.query(`DELETE FROM learning_items
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) RETURNING file_key`, [JSON.stringify(ids)]);
        const keys = [...new Set(removed.map((row) => row.file_key).filter(Boolean))];
        const orphans = [];
        for (const key of keys) {
          const { rows: [ref] } = await tx.query('SELECT count(*)::int AS count FROM learning_items WHERE file_key=$1', [key]);
          if (ref.count === 0) orphans.push(key);
        }
        return { affected: removed.length, orphanKeys: orphans };
      });
      for (const key of orphanKeys) await unlink(join(originals, key)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      publish();
      return res.json({ affected });
    }
    httpError(400, '批量操作类型无效');
  });
  app.get('/api/items/counts', async (_req, res) => {
    const { rows: [counts] } = await db.query(`SELECT count(*)::int AS all, count(*) FILTER (WHERE starred)::int AS starred,
      count(*) FILTER (WHERE visited_at IS NOT NULL)::int AS recent,
      count(*) FILTER (WHERE learning_state='inbox')::int AS inbox,
      count(*) FILTER (WHERE learning_state='learning')::int AS learning,
      count(*) FILTER (WHERE learning_state='mastered')::int AS mastered,
      count(*) FILTER (WHERE ingest_state='ready' AND ai_state IN ('unconfigured','failed'))::int AS undistilled,
      count(*) FILTER (WHERE ingest_state='ready' AND EXISTS (
        SELECT 1 FROM content_anchors WHERE item_id=learning_items.id AND embedding IS NULL
      ))::int AS unindexed,
      (SELECT count(*)::int FROM review_cards WHERE due_at <= now()) AS review_due,
      (SELECT count(*)::int FROM review_cards) AS review_total FROM learning_items`);
    res.json({ ...counts, ai_configured: isChatConfigured(aiConfig), semantic_search: isEmbeddingConfigured(aiConfig) });
  });
  app.post('/api/embeddings/reindex', async (_req, res) => {
    if (!isEmbeddingConfigured(aiConfig)) httpError(409, '尚未配置语义检索模型');
    const queued = await db.transaction(async (tx) => {
      const { rows } = await tx.query(`SELECT id FROM learning_items
        WHERE ingest_state='ready' AND EXISTS (SELECT 1 FROM content_anchors WHERE item_id=learning_items.id AND embedding IS NULL)`);
      for (const { id } of rows) {
        await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'embed')
          ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [id]);
      }
      return rows.length;
    });
    if (queued > 0) publish();
    res.status(202).json({ queued });
  });
  app.get('/api/items', async (req, res) => {
    const circle = req.query.circle || null;
    if (circle && !uuid.test(circle)) httpError(400, '圈子无效');
    const state = req.query.state || null;
    if (state && !learningStates.has(state)) httpError(400, '学习状态无效');
    const query = text(req.query.q, 200);
    const selectFields = `SELECT l.id,l.title,l.type,l.source_url,l.ingest_state,l.ingest_error,l.learning_state,l.ai_state,l.created_at,
      l.starred,l.visited_at,l.file_key IS NOT NULL AS has_file,
      ARRAY(SELECT circle_id FROM circle_items WHERE item_id=l.id) AS circle_ids, d.summary`;
    if (!query) {
      const { rows } = await db.query(`${selectFields}
        FROM learning_items l LEFT JOIN ai_distillations d ON d.item_id=l.id
        WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$1))
        AND ($2::text IS NULL OR l.learning_state=$2)
        ORDER BY l.created_at DESC`, [circle, state]);
      return res.json(rows);
    }
    const { rows: keywordRows } = await db.query(`${selectFields},
      position(lower($3) in lower(l.title)) > 0 AS title_match,
      (SELECT id FROM content_anchors WHERE item_id=l.id AND position(lower($3) in lower(text))>0 ORDER BY chunk_index LIMIT 1) AS match_anchor_id,
      (SELECT left(text, 160) FROM content_anchors WHERE item_id=l.id AND position(lower($3) in lower(text))>0 ORDER BY chunk_index LIMIT 1) AS match_snippet
      FROM learning_items l LEFT JOIN ai_distillations d ON d.item_id=l.id
      WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$1))
      AND ($2::text IS NULL OR l.learning_state=$2)
      AND (position(lower($3) in lower(l.title))>0 OR position(lower($3) in lower(l.raw_markdown))>0
        OR position(lower($3) in lower(coalesce(d.summary::text, '')))>0
        OR EXISTS (SELECT 1 FROM content_anchors WHERE item_id=l.id AND position(lower($3) in lower(text))>0))
      ORDER BY l.created_at DESC`, [circle, state, query]);
    const keywordMap = new Map(keywordRows.map((row) => [row.id, row]));
    const vector = await queryEmbedding(query);
    if (!vector) {
      return res.json(keywordRows.map(({ title_match: _tm, ...row }) => ({ ...row, match_type: 'keyword' })));
    }
    const literal = vectorLiteral(vector);
    const { rows: semanticHits } = await db.query(`SELECT item_id, anchor_id, snippet, similarity FROM (
        SELECT DISTINCT ON (a.item_id) a.item_id, a.id AS anchor_id, left(a.text, 160) AS snippet,
          (1 - (a.embedding <=> $1::vector))::double precision AS similarity
        FROM content_anchors a JOIN learning_items l ON l.id=a.item_id
        WHERE a.embedding IS NOT NULL AND vector_dims(a.embedding) = $2
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$3))
          AND ($4::text IS NULL OR l.learning_state=$4)
          AND (a.embedding <=> $1::vector) <= 0.65
        ORDER BY a.item_id, a.embedding <=> $1::vector
      ) ranked ORDER BY similarity DESC LIMIT 30`, [literal, vector.length, circle, state]);
    const semanticMap = new Map(semanticHits.map((hit) => [hit.item_id, hit]));
    const semanticOnlyIds = semanticHits.map((hit) => hit.item_id).filter((id) => !keywordMap.has(id));
    let extraRows = [];
    if (semanticOnlyIds.length) {
      const { rows } = await db.query(`${selectFields}
        FROM learning_items l LEFT JOIN ai_distillations d ON d.item_id=l.id
        WHERE l.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(semanticOnlyIds)]);
      extraRows = rows;
    }
    const combined = [];
    for (const row of keywordRows) {
      const hit = semanticMap.get(row.id);
      const { title_match, ...clean } = row;
      const score = (title_match ? 1.8 : 1.5) + (hit ? hit.similarity : 0);
      combined.push({
        ...clean,
        match_type: hit ? 'hybrid' : 'keyword',
        match_anchor_id: clean.match_anchor_id ?? hit?.anchor_id ?? null,
        match_snippet: clean.match_snippet ?? hit?.snippet ?? null,
        similarity: hit ? Number(hit.similarity.toFixed(3)) : undefined,
        _score: score,
      });
    }
    for (const row of extraRows) {
      const hit = semanticMap.get(row.id);
      combined.push({
        ...row,
        match_type: 'semantic',
        match_anchor_id: hit.anchor_id,
        match_snippet: hit.snippet,
        similarity: Number(hit.similarity.toFixed(3)),
        _score: hit.similarity,
      });
    }
    combined.sort((a, b) => b._score - a._score || new Date(b.created_at) - new Date(a.created_at));
    res.json(combined.map(({ _score, ...row }) => row));
  });
  app.post('/api/items/url', async (req, res) => {
    const ids = circleIds(req.body?.circle_ids, true);
    let url;
    try { url = sourceUrl(text(req.body.url, 8192)); } catch { httpError(400, '请输入有效的 HTTP 或 HTTPS 链接（使用默认端口）'); }
    const nextState = req.body?.learning_state;
    if (nextState !== undefined && !learningStates.has(nextState)) httpError(400, '学习状态无效');
    const initialNote = text(req.body?.note, 5000);
    const video = videoSource(url);
    const type = video ? 'video' : 'article';
    const canonical = video?.url ?? url.href;
    const captured = video ? '' : text(req.body.markdown, 1_000_000);
    const title = text(req.body.title, 500) || (video ? `${video.platform === 'youtube' ? 'YouTube' : '哔哩哔哩'} · ${video.videoId}` : url.hostname);
    const result = await db.transaction(async (tx) => {
      const { rows: [created] } = await tx.query(`INSERT INTO learning_items (type,title,source_url,captured_markdown,learning_state)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_url) DO NOTHING RETURNING id`, [type, title, canonical, captured || null, nextState ?? 'inbox']);
      const { rows: [item] } = await tx.query('SELECT id,ingest_state,captured_markdown FROM learning_items WHERE source_url=$1 FOR UPDATE', [canonical]);
      await attach(tx, item.id, ids);
      if (!created && nextState) {
        await tx.query('UPDATE learning_items SET learning_state=$2 WHERE id=$1', [item.id, nextState]);
      }
      const canCapture = captured && item.ingest_state !== 'ready' && !item.captured_markdown;
      if (!created && canCapture) {
        await tx.query("UPDATE learning_items SET title=$2,captured_markdown=$3,ingest_state='queued',ingest_error=null WHERE id=$1", [item.id, title, captured]);
      }
      if (initialNote) {
        await tx.query('INSERT INTO item_notes (item_id,seconds,text) VALUES ($1,null,$2)', [item.id, initialNote]);
      }
      if (created || canCapture) await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'parse')
        ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [item.id]);
      return { id: item.id, created: Boolean(created) };
    });
    publish(result.id);
    res.status(202).json(result);
  });
  app.post('/api/items/upload', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) httpError(400, '请选择文件');
    try {
      let values;
      try { values = JSON.parse(req.body.circle_ids); } catch { httpError(400, '请选择有效圈子'); }
      const ids = circleIds(values, true);
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const detected = await fileTypeFromFile(file.path).catch((error) => {
        if (error.name === 'EndOfStreamError') return undefined;
        throw error;
      });
      const isMarkdown = !detected && ['.md', '.markdown'].includes(extname(name).toLowerCase()) && file.size <= 5_000_000;
      const mime = isMarkdown ? 'text/plain' : detected?.mime;
      const type = isMarkdown ? 'markdown' : fileMimes.get(mime);
      if (!type) httpError(415, '支持 PDF、Markdown、MP4、WebM、MOV、JPEG、PNG、GIF、WebP 和 AVIF 文件');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file.path)) hash.update(chunk);
      const fileHash = hash.digest('hex');
      const id = await db.transaction(async (tx) => {
        const { rows: [created] } = await tx.query(`INSERT INTO learning_items (type,title,file_key,file_hash,mime_type)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (file_hash) DO NOTHING RETURNING id`, [type, name.slice(0, 500), file.filename, fileHash, mime]);
        const { rows: [item] } = await tx.query('SELECT id,file_key FROM learning_items WHERE file_hash=$1 FOR UPDATE', [fileHash]);
        await attach(tx, item.id, ids);
        if (created) await tx.query("INSERT INTO jobs (item_id,kind) VALUES ($1,'parse')", [item.id]);
        await link(file.path, join(originals, item.file_key)).catch((error) => { if (error.code !== 'EEXIST') throw error; });
        return item.id;
      });
      publish(id);
      res.status(202).json({ id });
    } finally {
      await unlink(file.path);
    }
  });

  app.get('/api/items/:id', async (req, res) => {
    const id = req.params.id;
    const item = await db.transaction(async (tx) => {
      const { rows: [row] } = await tx.query(`SELECT id,type,title,source_url, file_key IS NOT NULL AS has_file, ingest_state,learning_state,ai_state,
        ingest_error,ai_error,raw_markdown,metadata_json,created_at,starred,visited_at,ARRAY(SELECT circle_id FROM circle_items WHERE item_id=l.id) AS circle_ids
        FROM learning_items l WHERE id=$1`, [id]);
      if (!row) httpError(404, '资料不存在');
      const { rows: anchors } = await tx.query('SELECT id,text,anchor_meta FROM content_anchors WHERE item_id=$1 ORDER BY chunk_index', [id]);
      const { rows: [distillation] } = await tx.query('SELECT * FROM ai_distillations WHERE item_id=$1', [id]);
      const { rows: notes } = await tx.query('SELECT id,seconds,text FROM item_notes WHERE item_id=$1 ORDER BY created_at,id', [id]);
      const { rows: cards } = await tx.query(`SELECT id,item_id,anchor_id,front,back,quote,source_kind,ease_factor,interval_days,repetitions,lapses,due_at,last_reviewed_at,created_at
        FROM review_cards WHERE item_id=$1 ORDER BY created_at,id`, [id]);
      return { ...row, anchors, distillation, notes, cards };
    });
    res.json(item);
  });
  app.get('/api/items/:id/related', async (req, res) => {
    const id = req.params.id;
    const { rows: exists } = await db.query('SELECT id FROM learning_items WHERE id=$1', [id]);
    if (!exists.length) httpError(404, '资料不存在');
    const { rows: semantic } = await db.query(`WITH target_dim AS (
        SELECT vector_dims(embedding) AS dims FROM content_anchors
        WHERE item_id=$1 AND embedding IS NOT NULL ORDER BY chunk_index LIMIT 1
      ), target AS (
        SELECT avg(a.embedding) AS vec, d.dims
        FROM content_anchors a JOIN target_dim d ON vector_dims(a.embedding) = d.dims
        WHERE a.item_id=$1 AND a.embedding IS NOT NULL
        GROUP BY d.dims
      )
      SELECT l.id, l.title, l.type, l.source_url, l.learning_state, l.created_at,
        round(r.similarity::numeric, 3)::double precision AS similarity, r.snippet, 'semantic'::text AS reason
      FROM (
        SELECT DISTINCT ON (a.item_id) a.item_id,
          (1 - (a.embedding <=> t.vec))::double precision AS similarity,
          left(a.text, 120) AS snippet
        FROM content_anchors a CROSS JOIN target t
        WHERE a.item_id <> $1 AND a.embedding IS NOT NULL
          AND vector_dims(a.embedding) = t.dims
          AND (a.embedding <=> t.vec) <= 0.65
        ORDER BY a.item_id, a.embedding <=> t.vec
      ) r
      JOIN learning_items l ON l.id = r.item_id
      ORDER BY r.similarity DESC, l.created_at DESC
      LIMIT 6`, [id]);
    const results = semantic.map((row) => ({ ...row, reason_label: `语义相似 ${Math.round(row.similarity * 100)}%` }));
    if (results.length < 6) {
      const exclude = [id, ...results.map((row) => row.id)];
      const { rows: fallback } = await db.query(`WITH target_tags AS (
          SELECT value AS tag FROM ai_distillations, jsonb_array_elements_text(recommended_tags) WHERE item_id=$1
        ), target_circles AS (
          SELECT circle_id FROM circle_items WHERE item_id=$1
        )
        SELECT l.id, l.title, l.type, l.source_url, l.learning_state, l.created_at,
          ARRAY(SELECT t.tag FROM ai_distillations d, jsonb_array_elements_text(d.recommended_tags) AS t(tag)
            WHERE d.item_id=l.id AND t.tag IN (SELECT tag FROM target_tags)) AS shared_tags,
          ARRAY(SELECT c.name FROM circle_items ci JOIN circles c ON c.id=ci.circle_id
            WHERE ci.item_id=l.id AND ci.circle_id IN (SELECT circle_id FROM target_circles)) AS shared_circles
        FROM learning_items l
        WHERE l.id NOT IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb))
        ORDER BY l.created_at DESC`, [id, JSON.stringify(exclude)]);
      const scored = fallback
        .map((row) => ({ ...row, score: row.shared_tags.length * 2 + row.shared_circles.length }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 6 - results.length);
      for (const row of scored) {
        const byTag = row.shared_tags.length > 0;
        results.push({
          id: row.id, title: row.title, type: row.type, source_url: row.source_url,
          learning_state: row.learning_state, created_at: row.created_at,
          reason: byTag ? 'tags' : 'circle',
          reason_label: byTag ? `共同标签 · ${row.shared_tags[0]}` : `同属圈子 · ${row.shared_circles[0]}`,
        });
      }
    }
    res.json(results);
  });
  app.get('/api/items/:id/export', async (req, res) => {
    const id = req.params.id;
    const includeSource = req.query.includeSource === '1' || req.query.includeSource === 'true';
    const data = await db.transaction(async (tx) => {
      const { rows: [row] } = await tx.query('SELECT id,type,title,source_url,learning_state,raw_markdown,created_at FROM learning_items WHERE id=$1', [id]);
      if (!row) httpError(404, '资料不存在');
      const { rows: circles } = await tx.query('SELECT c.name FROM circles c JOIN circle_items ci ON ci.circle_id=c.id WHERE ci.item_id=$1 ORDER BY c.name', [id]);
      const { rows: [distillation] } = await tx.query('SELECT * FROM ai_distillations WHERE item_id=$1', [id]);
      const { rows: notes } = await tx.query('SELECT id,seconds,text FROM item_notes WHERE item_id=$1 ORDER BY created_at,id', [id]);
      const { rows: anchors } = includeSource ? await tx.query('SELECT id,text,anchor_meta FROM content_anchors WHERE item_id=$1 ORDER BY chunk_index', [id]) : { rows: [] };
      return { item: { ...row, distillation, notes, anchors }, circles: circles.map(({ name }) => name) };
    });
    const content = formatExportMarkdown(data.item, data.circles, includeSource);
    const filename = `${data.item.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'learning-note'}.md`;
    res.set({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="learning-note.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    res.send(content);
  });
  app.patch('/api/items/:id', async (req, res) => {
    const hasTitle = req.body?.title !== undefined;
    const hasState = req.body?.learning_state !== undefined;
    const hasMarkdown = req.body?.markdown !== undefined;
    const hasTranscript = req.body?.transcript !== undefined;
    if (!hasTitle && !hasState && !hasMarkdown && !hasTranscript) httpError(400, '请提供需要更新的字段');
    const title = hasTitle ? text(req.body.title, 500) : null;
    if (hasTitle && !title) httpError(400, '资料标题不能为空');
    const learningState = hasState ? req.body.learning_state : null;
    if (hasState && !learningStates.has(learningState)) httpError(400, '学习状态无效');
    const markdownBody = hasMarkdown ? text(req.body.markdown, 500_000).replaceAll('\0', '\uFFFD') : null;
    if (hasMarkdown && !markdownBody) httpError(400, '笔记正文不能为空');
    const transcriptBody = hasTranscript ? text(req.body.transcript, 500_000).replaceAll('\0', '\uFFFD') : null;
    if (hasTranscript && !transcriptBody) httpError(400, '字幕或文稿内容不能为空');
    const item = await db.transaction(async (tx) => {
      const { rows: [existing] } = await tx.query('SELECT id,type,title,learning_state,metadata_json FROM learning_items WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!existing) httpError(404, '资料不存在');
      if (hasMarkdown && existing.type !== 'markdown') httpError(409, '仅支持编辑 Markdown 笔记正文');
      if (hasTranscript) {
        const anchors = parseTranscriptInput(existing.id, transcriptBody);
        if (!anchors.length) httpError(400, '未识别到有效的字幕或文稿内容');
        await tx.query('DELETE FROM jobs WHERE item_id=$1', [existing.id]);
        await tx.query('DELETE FROM ai_distillations WHERE item_id=$1', [existing.id]);
        const nextMeta = { ...(existing.metadata_json ?? {}) };
        delete nextMeta.captionMessage;
        delete nextMeta.notice;
        const { rows: [updated] } = await tx.query(`UPDATE learning_items
          SET title=coalesce($2, title), learning_state=coalesce($3, learning_state),
              metadata_json=$4::jsonb, ingest_state='ready', ingest_error=null, ai_state='pending', ai_error=null
          WHERE id=$1 RETURNING id, title, learning_state`, [existing.id, title, learningState, JSON.stringify(nextMeta)]);
        await tx.query('DELETE FROM content_anchors WHERE item_id=$1', [existing.id]);
        for (let start = 0; start < anchors.length; start += 500) {
          const batch = anchors.slice(start, start + 500).map((anchor, index) => ({ ...anchor, chunk_index: start + index }));
          await tx.query(`INSERT INTO content_anchors (id,item_id,chunk_index,text,anchor_meta)
            SELECT id,$1,chunk_index,text,anchor_meta FROM jsonb_to_recordset($2::jsonb) AS a(id text,chunk_index integer,text text,anchor_meta jsonb)`, [existing.id, JSON.stringify(batch)]);
        }
        await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'distill')
          ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [existing.id]);
        if (isEmbeddingConfigured(aiConfig)) {
          await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'embed')
            ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [existing.id]);
        }
        return updated;
      }
      if (hasMarkdown) {
        await tx.query('DELETE FROM jobs WHERE item_id=$1', [existing.id]);
        await tx.query('DELETE FROM ai_distillations WHERE item_id=$1', [existing.id]);
        const anchors = markdownAnchors(existing.id, markdownBody);
        const { rows: [updated] } = await tx.query(`UPDATE learning_items
          SET title=coalesce($2, title), learning_state=coalesce($3, learning_state),
              captured_markdown=$4, raw_markdown=$4, ingest_state='ready', ingest_error=null, ai_state='pending', ai_error=null
          WHERE id=$1 RETURNING id, title, learning_state`, [existing.id, title, learningState, markdownBody]);
        await tx.query('DELETE FROM content_anchors WHERE item_id=$1', [existing.id]);
        for (let start = 0; start < anchors.length; start += 500) {
          const batch = anchors.slice(start, start + 500).map((anchor, index) => ({ ...anchor, chunk_index: start + index }));
          await tx.query(`INSERT INTO content_anchors (id,item_id,chunk_index,text,anchor_meta)
            SELECT id,$1,chunk_index,text,anchor_meta FROM jsonb_to_recordset($2::jsonb) AS a(id text,chunk_index integer,text text,anchor_meta jsonb)`, [existing.id, JSON.stringify(batch)]);
        }
        await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'distill')
          ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [existing.id]);
        if (anchors.length && isEmbeddingConfigured(aiConfig)) {
          await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'embed')
            ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [existing.id]);
        }
        return updated;
      }
      const { rows: [updated] } = await tx.query(`UPDATE learning_items
        SET title=coalesce($2, title), learning_state=coalesce($3, learning_state)
        WHERE id=$1 RETURNING id, title, learning_state`, [existing.id, title, learningState]);
      return updated;
    });
    publish(req.params.id);
    res.json(item);
  });
  app.delete('/api/items/:id', async (req, res) => {
    const fileKey = await db.transaction(async (tx) => {
      const { rows: [removed] } = await tx.query('DELETE FROM learning_items WHERE id=$1 RETURNING file_key', [req.params.id]);
      if (!removed) httpError(404, '资料不存在');
      if (!removed.file_key) return null;
      const { rows: [ref] } = await tx.query('SELECT count(*)::int AS count FROM learning_items WHERE file_key=$1', [removed.file_key]);
      return ref.count === 0 ? removed.file_key : null;
    });
    if (fileKey) await unlink(join(originals, fileKey)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    publish(req.params.id);
    res.sendStatus(204);
  });
  app.patch('/api/items/:id/preferences', async (req, res) => {
    const { starred, visit } = req.body ?? {};
    if ((starred !== undefined && typeof starred !== 'boolean') || (starred === undefined && visit !== true)) {
      httpError(400, '资料偏好无效');
    }
    const { rows: [item] } = await db.query(`UPDATE learning_items SET starred=coalesce($2,starred),
      visited_at=CASE WHEN $3 THEN now() ELSE visited_at END WHERE id=$1 RETURNING starred,visited_at`,
    [req.params.id, starred ?? null, visit === true]);
    if (!item) httpError(404, '资料不存在');
    publish(req.params.id);
    res.json(item);
  });
  app.patch('/api/items/:id/circles', async (req, res) => {
    const ids = circleIds(req.body?.circle_ids);
    await db.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT id FROM learning_items WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!rows.length) httpError(404, '资料不存在');
      await tx.query('DELETE FROM circle_items WHERE item_id=$1', [req.params.id]);
      await attach(tx, req.params.id, ids);
    });
    publish(req.params.id);
    res.sendStatus(204);
  });
  app.post('/api/items/:id/retry', async (req, res) => {
    const id = req.params.id;
    const kind = req.body?.kind;
    await db.transaction(async (tx) => {
      const { rows: [item] } = await tx.query('SELECT type,ingest_state,ai_state FROM learning_items WHERE id=$1 FOR UPDATE', [id]);
      if (!item) httpError(404, '资料不存在');
      if (kind === 'parse' && (item.ingest_state === 'failed' || (item.type === 'video' && item.ingest_state === 'ready'))) {
        await tx.query("UPDATE learning_items SET ingest_state='queued',ingest_error=null WHERE id=$1", [id]);
      } else if (kind === 'distill' && item.ingest_state === 'ready' && ['ready', 'failed', 'unconfigured', 'unavailable'].includes(item.ai_state)) {
        await tx.query("UPDATE learning_items SET ai_state='pending',ai_error=null WHERE id=$1", [id]);
        if (isEmbeddingConfigured(aiConfig)) {
          const { rows: [missing] } = await tx.query('SELECT EXISTS (SELECT 1 FROM content_anchors WHERE item_id=$1 AND embedding IS NULL) AS need', [id]);
          if (missing.need) {
            await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'embed')
              ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [id]);
          }
        }
      } else if (kind === 'embed' && item.ingest_state === 'ready' && isEmbeddingConfigured(aiConfig)) {
        // Re-index embeddings for this item
      } else httpError(409, '当前状态无法重试');
      await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,$2)
        ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [id, kind]);
    });
    publish(id);
    res.sendStatus(204);
  });
  app.get('/api/items/:id/file', async (req, res) => {
    const { rows: [item] } = await db.query('SELECT file_key,mime_type FROM learning_items WHERE id=$1', [req.params.id]);
    if (!item?.file_key) httpError(404, '原文件不存在');
    res.type(item.mime_type).sendFile(item.file_key, { root: originals });
  });
  app.post('/api/items/:id/notes', async (req, res) => {
    const seconds = req.body?.seconds ?? null;
    const note = text(req.body?.text, 5000);
    if ((seconds !== null && (!Number.isFinite(seconds) || seconds < 0)) || !note) httpError(400, '请输入有效的笔记');
    const { rows: [saved] } = await db.query(`INSERT INTO item_notes (item_id,seconds,text)
      SELECT id,$2,$3 FROM learning_items WHERE id=$1 AND ($2::double precision IS NULL OR type IN ('video','local_video')) RETURNING id,seconds,text`,
    [req.params.id, seconds, note]);
    if (!saved) httpError(404, '资料不存在或无法添加时间笔记');
    publish(req.params.id);
    res.status(201).json(saved);
  });
  app.patch('/api/items/:id/notes/:noteId', async (req, res) => {
    const note = text(req.body?.text, 5000);
    if (!note) httpError(400, '笔记内容不能为空');
    const { rows: [saved] } = await db.query(`UPDATE item_notes SET text=$3
      WHERE id=$2 AND item_id=$1 RETURNING id,seconds,text`, [req.params.id, req.params.noteId, note]);
    if (!saved) httpError(404, '笔记不存在');
    publish(req.params.id);
    res.json(saved);
  });
  app.delete('/api/items/:id/notes/:noteId', async (req, res) => {
    const { rows: [removed] } = await db.query('DELETE FROM item_notes WHERE id=$2 AND item_id=$1 RETURNING id', [req.params.id, req.params.noteId]);
    if (!removed) httpError(404, '笔记不存在');
    publish(req.params.id);
    res.sendStatus(204);
  });

  app.get('/api/review/cards', async (req, res) => {
    const scope = req.query.scope === 'all' ? 'all' : 'due';
    const circle = req.query.circle || null;
    if (circle && !uuid.test(circle)) httpError(400, '圈子无效');
    const item = req.query.item || null;
    if (item && !uuid.test(item)) httpError(400, '资料无效');
    const [{ rows: cards }, { rows: [stats] }] = await Promise.all([
      db.query(`SELECT c.id,c.item_id,c.anchor_id,c.front,c.back,c.quote,c.source_kind,c.ease_factor,c.interval_days,c.repetitions,c.lapses,c.due_at,c.last_reviewed_at,c.created_at,
        l.title AS item_title, l.type AS item_type, l.source_url AS item_source_url
        FROM review_cards c JOIN learning_items l ON l.id=c.item_id
        WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$1))
          AND ($2::uuid IS NULL OR c.item_id=$2)
          AND ($3='all' OR c.due_at <= now())
        ORDER BY c.due_at ASC, c.created_at ASC LIMIT 200`, [circle, item, scope]),
      db.query(`SELECT count(*) FILTER (WHERE c.due_at <= now())::int AS due,
        count(*)::int AS total,
        count(*) FILTER (WHERE c.last_reviewed_at >= date_trunc('day', now()))::int AS reviewed_today
        FROM review_cards c JOIN learning_items l ON l.id=c.item_id
        WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM circle_items WHERE item_id=l.id AND circle_id=$1))
          AND ($2::uuid IS NULL OR c.item_id=$2)`, [circle, item]),
    ]);
    res.json({
      cards: cards.map((card) => ({ ...card, next_intervals: previewIntervals(card) })),
      stats,
    });
  });
  app.post('/api/items/:id/cards', async (req, res) => {
    const front = text(req.body?.front, 500);
    const back = text(req.body?.back, 5000);
    const quote = text(req.body?.quote, 1000) || null;
    const anchorId = text(req.body?.anchor_id, 200) || null;
    const sourceKind = ['manual', 'key_point', 'note'].includes(req.body?.source_kind) ? req.body.source_kind : 'manual';
    if (!front || !back) httpError(400, '请填写卡片正面问题和背面答案');
    const { rows: [saved] } = await db.query(`INSERT INTO review_cards (item_id,anchor_id,front,back,quote,source_kind)
      SELECT id,$2,$3,$4,$5,$6 FROM learning_items WHERE id=$1
      RETURNING id,item_id,anchor_id,front,back,quote,source_kind,ease_factor,interval_days,repetitions,lapses,due_at,last_reviewed_at,created_at`,
    [req.params.id, anchorId, front, back, quote, sourceKind]);
    if (!saved) httpError(404, '资料不存在');
    publish(req.params.id);
    res.status(201).json({ ...saved, next_intervals: previewIntervals(saved) });
  });
  app.post('/api/items/:id/cards/generate', async (req, res) => {
    const id = req.params.id;
    const mode = req.body?.mode === 'ai' ? 'ai' : 'rules';
    const includeNotes = req.body?.include_notes !== false;
    let aiCandidates = null;
    if (mode === 'ai') {
      if (!isChatConfigured(aiConfig)) httpError(409, '请先在 AI 设置中配置对话模型');
      const { rows: [item] } = await db.query('SELECT id,title FROM learning_items WHERE id=$1', [id]);
      if (!item) httpError(404, '资料不存在');
      const { rows: anchors } = await db.query('SELECT id,text FROM content_anchors WHERE item_id=$1 ORDER BY chunk_index', [id]);
      if (!anchors.length) httpError(409, '该资料暂无可用于 AI 制卡的正文或字幕');
      aiCandidates = await generateAiFlashcards(item.title, anchors, aiConfig);
    }
    const result = await db.transaction(async (tx) => {
      const { rows: [item] } = await tx.query('SELECT id,title FROM learning_items WHERE id=$1 FOR UPDATE', [id]);
      if (!item) httpError(404, '资料不存在');
      let candidates = aiCandidates;
      if (!candidates) {
        const { rows: [distillation] } = await tx.query('SELECT key_points_json FROM ai_distillations WHERE item_id=$1', [id]);
        const { rows: notes } = includeNotes ? await tx.query('SELECT id,seconds,text FROM item_notes WHERE item_id=$1 ORDER BY created_at,id', [id]) : { rows: [] };
        candidates = [];
        for (const point of distillation?.key_points_json ?? []) {
          const front = text(point?.title, 500);
          const back = text(point?.explanation, 5000);
          if (!front || !back) continue;
          const src = point.sources?.[0];
          candidates.push({ front, back, anchor_id: src?.anchor_id || null, quote: text(src?.quote, 1000) || null, source_kind: 'key_point' });
        }
        notes.forEach((note, index) => {
          const back = text(note.text, 5000);
          if (!back) return;
          const suffix = note.seconds !== null ? ` (${formatClock(note.seconds)})` : ` #${index + 1}`;
          const front = `${item.title.slice(0, 120)} · 笔记回顾${suffix}`;
          candidates.push({ front, back, anchor_id: note.seconds !== null ? note.id : null, quote: null, source_kind: 'note' });
        });
      }
      if (!candidates.length) httpError(409, '请先完成 AI 提炼或添加笔记后再生成卡片');
      const { rows: existing } = await tx.query('SELECT front FROM review_cards WHERE item_id=$1', [id]);
      const seen = new Set(existing.map((row) => row.front.trim().toLowerCase()));
      const created = [];
      let skipped = 0;
      for (const candidate of candidates) {
        const key = candidate.front.trim().toLowerCase();
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
        const { rows: [row] } = await tx.query(`INSERT INTO review_cards (item_id,anchor_id,front,back,quote,source_kind)
          VALUES ($1,$2,$3,$4,$5,$6)
          RETURNING id,item_id,anchor_id,front,back,quote,source_kind,ease_factor,interval_days,repetitions,lapses,due_at,last_reviewed_at,created_at`,
        [id, candidate.anchor_id, candidate.front, candidate.back, candidate.quote, candidate.source_kind]);
        created.push(row);
      }
      return { created: created.length, skipped, cards: created, mode };
    });
    if (result.created > 0) publish(id);
    res.status(201).json(result);
  });
  app.post('/api/review/cards/:cardId/grade', async (req, res) => {
    const rating = req.body?.rating;
    if (!reviewRatings.has(rating)) httpError(400, '评分选项无效');
    const updated = await db.transaction(async (tx) => {
      const { rows: [card] } = await tx.query('SELECT * FROM review_cards WHERE id=$1 FOR UPDATE', [req.params.cardId]);
      if (!card) httpError(404, '复习卡片不存在');
      const next = scheduleReview(card, rating);
      const { rows: [saved] } = await tx.query(`UPDATE review_cards
        SET ease_factor=$2, interval_days=$3, repetitions=$4, lapses=$5, due_at=$6, last_reviewed_at=now()
        WHERE id=$1
        RETURNING id,item_id,anchor_id,front,back,quote,source_kind,ease_factor,interval_days,repetitions,lapses,due_at,last_reviewed_at,created_at`,
      [card.id, next.ease_factor, next.interval_days, next.repetitions, next.lapses, next.due_at]);
      return { ...saved, next_intervals: previewIntervals(saved), next_label: next.label };
    });
    publish(updated.item_id);
    res.json(updated);
  });
  app.patch('/api/review/cards/:cardId', async (req, res) => {
    const front = text(req.body?.front, 500);
    const back = text(req.body?.back, 5000);
    if (!front || !back) httpError(400, '卡片正面与背面内容均不能为空');
    const { rows: [saved] } = await db.query(`UPDATE review_cards SET front=$2, back=$3
      WHERE id=$1
      RETURNING id,item_id,anchor_id,front,back,quote,source_kind,ease_factor,interval_days,repetitions,lapses,due_at,last_reviewed_at,created_at`,
    [req.params.cardId, front, back]);
    if (!saved) httpError(404, '复习卡片不存在');
    publish(saved.item_id);
    res.json({ ...saved, next_intervals: previewIntervals(saved) });
  });
  app.delete('/api/review/cards/:cardId', async (req, res) => {
    const { rows: [removed] } = await db.query('DELETE FROM review_cards WHERE id=$1 RETURNING item_id', [req.params.cardId]);
    if (!removed) httpError(404, '复习卡片不存在');
    publish(removed.item_id);
    res.sendStatus(204);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(express.static(join(distDir, 'web')));
  app.get(['/reader/:id', '/review', '/ask'], (_req, res) => res.sendFile(join(distDir, 'web', 'index.html')));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === '23505') return res.status(409).json({ error: '圈子名称已存在' });
    if (error.code === '22P02') return res.status(400).json({ error: 'ID 或请求格式无效' });
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过 512 MB' });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: '上传格式无效' });
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.status === 413 ? '内容超过大小限制' : error.message });
    console.error(error);
    res.status(500).json({ error: '服务暂时无法处理此请求' });
  });

  return { app, async close() {
    clearInterval(eventsTimer);
    for (const response of streams) response.end();
    await stopWorker();
    await db.close();
  } };
}
