import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseItem } from './parse.js';
import { distill, embedTexts, isChatConfigured, isEmbeddingConfigured, vectorLiteral } from './ai.js';
import { autoAssignItemCircles } from './classify.js';
import { runWebSearch } from './search.js';

const itemTypeNames = { article: '文章', video: '在线视频', local_video: '本地视频', pdf: 'PDF', markdown: 'Markdown 笔记', image: '图片' };

export function startWorker({ db, originals, ai, publish }) {
  const getAi = () => (typeof ai === 'function' ? ai() : ai);
  let stopped = false;
  const active = new Map();
  function tick() {
    if (stopped) return;
    for (const kind of ['parse', 'distill', 'embed']) {
      if (active.has(kind)) continue;
      const task = processJob(kind).catch((error) => console.error('后台任务队列错误', error)).finally(() => active.delete(kind));
      active.set(kind, task);
    }
  }
  const timer = setInterval(tick, 350);
  tick();

  async function processJob(kind) {
    const token = randomUUID();
    const job = await db.transaction(async (tx) => {
      const { rows: [claimed] } = await tx.query(`UPDATE jobs SET lease_token=$2, lease_until=now()+interval '15 seconds'
        WHERE (item_id, kind) = (SELECT jobs.item_id, jobs.kind FROM jobs JOIN learning_items ON learning_items.id=jobs.item_id
        WHERE kind=$1 AND (lease_until IS NULL OR lease_until < now())
        ORDER BY lease_until NULLS FIRST, jobs.item_id LIMIT 1 FOR UPDATE OF learning_items SKIP LOCKED) RETURNING item_id`, [kind, token]);
      if (claimed && kind === 'parse') await tx.query("UPDATE learning_items SET ingest_state='parsing' WHERE id=$1", [claimed.item_id]);
      return claimed;
    });
    if (!job) return;
    const id = job.item_id;
    if (kind === 'parse') publish(id);
    const heartbeat = setInterval(() => {
      db.query("UPDATE jobs SET lease_until=now()+interval '15 seconds' WHERE item_id=$1 AND kind=$2 AND lease_token=$3", [id, kind, token])
        .catch((error) => console.error('续租失败', error));
    }, 5_000);
    try {
      let result;
      let failure;
      try {
        if (kind === 'parse') {
          const { rows: [item] } = await db.query('SELECT * FROM learning_items WHERE id=$1', [id]);
          result = await parseItem(item, item.file_key && join(originals, item.file_key));
        } else if (kind === 'distill') {
          const currentAi = getAi();
          const [{ rows: [item] }, { rows: anchors }, { rows: notes }, { rows: circles }] = await Promise.all([
            db.query('SELECT id, type, title, source_url, file_key, mime_type, metadata_json FROM learning_items WHERE id=$1', [id]),
            db.query('SELECT id, text FROM content_anchors WHERE item_id=$1 ORDER BY chunk_index', [id]),
            db.query('SELECT text FROM item_notes WHERE item_id=$1 ORDER BY created_at LIMIT 12', [id]),
            db.query('SELECT name FROM circles ORDER BY name'),
          ]);
          const meta = item?.metadata_json ?? {};
          const context = item ? {
            title: item.title,
            type: item.type,
            type_label: itemTypeNames[item.type] ?? item.type,
            source_url: item.source_url || null,
            author: meta.author || null,
            description: meta.description || '',
            notes: notes.map((n) => n.text),
          } : null;
          if (!anchors.length && item && isChatConfigured(currentAi)) {
            if (item.type === 'image' && item.file_key) {
              try {
                const buf = await readFile(join(originals, item.file_key));
                if (buf.length <= 8 * 1024 * 1024) {
                  context.imageDataUrl = `data:${item.mime_type || 'image/jpeg'};base64,${buf.toString('base64')}`;
                }
              } catch { /* fall back to title metadata */ }
            } else if (item.title) {
              const searchQuery = [item.title, meta.author].filter(Boolean).join(' ').slice(0, 120);
              context.webResults = await runWebSearch(searchQuery, currentAi, { limit: 4, enrich: false }).catch(() => []);
            }
          }
          result = await distill(anchors, circles.map(({ name }) => name), currentAi, context);
        } else {
          const { rows: anchors } = await db.query('SELECT id, text FROM content_anchors WHERE item_id=$1 ORDER BY chunk_index', [id]);
          const currentAi = getAi();
          if (anchors.length && isEmbeddingConfigured(currentAi)) {
            const vectors = await embedTexts(anchors.map(({ text }) => text), currentAi);
            result = { pairs: anchors.map((anchor, index) => ({ id: anchor.id, embedding: vectorLiteral(vectors[index]) })) };
          } else {
            result = { pairs: [] };
          }
        }
      } catch (error) {
        failure = typeof error.message === 'string' ? error.message.slice(0, 300) : '任务执行失败';
        if (kind === 'embed') console.error('向量生成失败', id, failure);
      }
      const updated = await db.transaction(async (tx) => {
        const lock = await tx.query('SELECT id FROM learning_items WHERE id=$1 FOR UPDATE', [id]);
        if (!lock.rows.length) return false;
        const claim = await tx.query('DELETE FROM jobs WHERE item_id=$1 AND kind=$2 AND lease_token=$3 RETURNING item_id', [id, kind, token]);
        if (!claim.rows.length) return false;
        if (kind === 'parse') {
          if (failure) {
            await tx.query("UPDATE learning_items SET ingest_state='failed', ingest_error=$2 WHERE id=$1", [id, failure]);
          } else {
            await tx.query("UPDATE learning_items SET title=coalesce($2,title), raw_markdown=$3, metadata_json=metadata_json || $4::jsonb, ingest_state='ready', ingest_error=null, ai_state='pending' WHERE id=$1",
              [id, result.title?.slice(0, 500) || null, result.markdown, JSON.stringify(result.metadata ?? {})]);
            await tx.query('DELETE FROM content_anchors WHERE item_id=$1', [id]);
            for (let start = 0; start < result.anchors.length; start += 500) {
              const batch = result.anchors.slice(start, start + 500).map((anchor, index) => ({ ...anchor, chunk_index: start + index }));
              await tx.query(`INSERT INTO content_anchors (id,item_id,chunk_index,text,anchor_meta)
                SELECT id,$1,chunk_index,text,anchor_meta FROM jsonb_to_recordset($2::jsonb) AS a(id text,chunk_index integer,text text,anchor_meta jsonb)`, [id, JSON.stringify(batch)]);
            }
            await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'distill')
              ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [id]);
            if (result.anchors.length && isEmbeddingConfigured(getAi())) {
              await tx.query(`INSERT INTO jobs (item_id,kind) VALUES ($1,'embed')
                ON CONFLICT (item_id,kind) DO UPDATE SET lease_until=null,lease_token=null`, [id]);
            }
            await autoAssignItemCircles(tx, id);
          }
        } else if (kind === 'distill') {
          if (result?.output) {
            const { summary, recommended_tags, recommended_circles, key_points } = result.output;
            await tx.query(`INSERT INTO ai_distillations VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (item_id) DO UPDATE SET summary=excluded.summary, recommended_tags=excluded.recommended_tags,
              recommended_circles=excluded.recommended_circles, key_points_json=excluded.key_points_json, model_used=excluded.model_used`,
            [id, ...[summary, recommended_tags, recommended_circles, key_points].map((value) => JSON.stringify(value)), result.model]);
          }
          await tx.query('UPDATE learning_items SET ai_state=$2, ai_error=$3 WHERE id=$1', [id, failure ? 'failed' : result.state, failure ?? null]);
          if (result?.output) await autoAssignItemCircles(tx, id);
        } else if (result?.pairs?.length) {
          for (let start = 0; start < result.pairs.length; start += 200) {
            const batch = result.pairs.slice(start, start + 200);
            await tx.query(`UPDATE content_anchors AS a SET embedding = v.embedding::vector
              FROM jsonb_to_recordset($2::jsonb) AS v(id text, embedding text)
              WHERE a.id = v.id AND a.item_id = $1`, [id, JSON.stringify(batch)]);
          }
        }
        return true;
      });
      if (updated) publish(id);
    } finally {
      clearInterval(heartbeat);
    }
  }
  return async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.allSettled(active.values());
  };
}
