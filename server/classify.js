const validItemTypes = new Set(['article', 'video', 'local_video', 'pdf', 'markdown', 'image']);

function cleanList(value, maxItems = 30, maxLen = 60, lowercase = false) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，\n]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    let item = entry.trim().slice(0, maxLen);
    if (!item) continue;
    if (lowercase) item = item.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeRules(input) {
  if (!input || typeof input !== 'object') return {};
  const keywords = cleanList(input.keywords, 30, 60, false);
  const domains = cleanList(input.domains, 30, 120, true);
  const types = cleanList(input.types, 10, 30, true).filter((type) => validItemTypes.has(type));
  const auto_ai = Boolean(input.auto_ai);
  const rules = {};
  if (keywords.length) rules.keywords = keywords;
  if (domains.length) rules.domains = domains;
  if (types.length) rules.types = types;
  if (auto_ai) rules.auto_ai = true;
  return rules;
}

export function hasSmartRules(rules) {
  if (!rules || typeof rules !== 'object') return false;
  return Boolean(rules.auto_ai || rules.keywords?.length || rules.domains?.length || rules.types?.length);
}

export function matchItemToCircle(item, circle, distillation = null, { allowDefaultAi = false } = {}) {
  const rules = circle.smart_rules ?? {};
  if (rules.types?.length && rules.types.includes(item.type)) {
    const labels = { article: '文章', video: '视频', local_video: '本地视频', pdf: 'PDF', markdown: '笔记', image: '图片' };
    return { reason: `类型 · ${labels[item.type] ?? item.type}`, source: 'rule' };
  }
  if (rules.domains?.length && item.source_url) {
    try {
      const host = new URL(item.source_url).hostname.toLowerCase().replace(/^www\./, '');
      const hit = rules.domains.find((domain) => host === domain || host.endsWith(`.${domain}`));
      if (hit) return { reason: `域名 · ${hit}`, source: 'rule' };
    } catch { /* ignore invalid url */ }
  }
  if (rules.keywords?.length) {
    const haystack = `${item.title ?? ''}\n${item.raw_markdown ?? ''}\n${item.anchor_text ?? ''}`.toLowerCase();
    const hit = rules.keywords.find((kw) => haystack.includes(kw.toLowerCase()));
    if (hit) return { reason: `关键词 · ${hit}`, source: 'rule' };
  }
  if (distillation && (rules.auto_ai || allowDefaultAi)) {
    const circleLower = circle.name.trim().toLowerCase();
    const recCircles = Array.isArray(distillation.recommended_circles) ? distillation.recommended_circles : [];
    if (recCircles.some((name) => typeof name === 'string' && name.trim().toLowerCase() === circleLower)) {
      return { reason: 'AI 推荐圈子', source: 'ai' };
    }
    const recTags = Array.isArray(distillation.recommended_tags) ? distillation.recommended_tags : [];
    const tagHit = recTags.find((tag) => {
      if (typeof tag !== 'string') return false;
      const lower = tag.trim().toLowerCase();
      return lower === circleLower || (rules.keywords ?? []).some((kw) => lower === kw.toLowerCase());
    });
    if (tagHit) return { reason: `AI 标签 · ${tagHit}`, source: 'ai' };
  }
  return null;
}

export async function autoAssignItemCircles(tx, itemId) {
  const { rows: [item] } = await tx.query(`SELECT id, type, title, source_url, raw_markdown
    FROM learning_items WHERE id=$1`, [itemId]);
  if (!item) return [];
  const { rows: circles } = await tx.query('SELECT id, name, smart_rules FROM circles');
  const activeCircles = circles.filter((circle) => hasSmartRules(circle.smart_rules));
  if (!activeCircles.length) return [];
  const { rows: [distillation] } = await tx.query('SELECT recommended_tags, recommended_circles FROM ai_distillations WHERE item_id=$1', [itemId]);
  const { rows: anchors } = await tx.query('SELECT text FROM content_anchors WHERE item_id=$1 ORDER BY chunk_index LIMIT 40', [itemId]);
  const enriched = { ...item, anchor_text: anchors.map((a) => a.text).join('\n') };
  const matchedIds = [];
  for (const circle of activeCircles) {
    if (matchItemToCircle(enriched, circle, distillation)) matchedIds.push(circle.id);
  }
  if (!matchedIds.length) return [];
  const { rows: added } = await tx.query(`INSERT INTO circle_items (circle_id, item_id)
    SELECT value::uuid, $1 FROM jsonb_array_elements_text($2::jsonb)
    ON CONFLICT DO NOTHING RETURNING circle_id`, [itemId, JSON.stringify(matchedIds)]);
  return added.map((row) => row.circle_id);
}

export async function computeSmartSuggestions(db, { circleId = null } = {}) {
  const [{ rows: circles }, { rows: items }] = await Promise.all([
    db.query('SELECT id, name, category, smart_rules FROM circles ORDER BY category, name'),
    db.query(`SELECT l.id, l.type, l.title, l.source_url, l.raw_markdown,
        ARRAY(SELECT circle_id FROM circle_items WHERE item_id=l.id) AS circle_ids,
        d.recommended_tags, d.recommended_circles,
        (SELECT string_agg(text, E'\n') FROM (SELECT text FROM content_anchors WHERE item_id=l.id ORDER BY chunk_index LIMIT 30) s) AS anchor_text
      FROM learning_items l LEFT JOIN ai_distillations d ON d.item_id=l.id
      ORDER BY l.created_at DESC LIMIT 300`),
  ]);
  const targetCircles = circleId ? circles.filter((c) => c.id === circleId) : circles;
  const circleNameMap = new Map(circles.map((c) => [c.name.trim().toLowerCase(), c]));
  const suggestions = [];
  const seenPairs = new Set();

  for (const item of items) {
    const owned = new Set(item.circle_ids ?? []);
    const distillation = (item.recommended_tags || item.recommended_circles)
      ? { recommended_tags: item.recommended_tags ?? [], recommended_circles: item.recommended_circles ?? [] }
      : null;

    for (const circle of targetCircles) {
      if (owned.has(circle.id)) continue;
      const match = matchItemToCircle(item, circle, distillation, { allowDefaultAi: !circleId });
      if (match) {
        const key = `${item.id}:${circle.id}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          suggestions.push({
            item_id: item.id,
            item_title: item.title,
            item_type: item.type,
            circle_id: circle.id,
            circle_name: circle.name,
            circle_category: circle.category,
            create_circle_name: null,
            reason: match.reason,
            source: match.source,
          });
        }
      }
    }

    // Recommend creating new circles when AI explicitly suggested a non-existent circle (global scan only)
    if (!circleId && distillation?.recommended_circles?.length) {
      for (const rawName of distillation.recommended_circles) {
        const name = typeof rawName === 'string' ? rawName.trim().slice(0, 60) : '';
        if (!name || circleNameMap.has(name.toLowerCase())) continue;
        const key = `${item.id}:new:${name.toLowerCase()}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          suggestions.push({
            item_id: item.id,
            item_title: item.title,
            item_type: item.type,
            circle_id: null,
            circle_name: name,
            circle_category: '',
            create_circle_name: name,
            reason: 'AI 建议新建圈子',
            source: 'ai_new',
          });
        }
      }
    }
  }

  // Semantic centroid matching via pgvector for circles with embedded items
  if (targetCircles.length) {
    const { rows: semanticHits } = await db.query(`WITH circle_centroids AS (
        SELECT ci.circle_id, avg(a.embedding) AS vec, vector_dims(avg(a.embedding)) AS dims
        FROM circle_items ci
        JOIN content_anchors a ON a.item_id = ci.item_id
        WHERE a.embedding IS NOT NULL
          AND ($1::uuid IS NULL OR ci.circle_id = $1)
        GROUP BY ci.circle_id, vector_dims(a.embedding)
      )
      SELECT DISTINCT ON (a.item_id, cc.circle_id)
        a.item_id, l.title AS item_title, l.type AS item_type,
        cc.circle_id, c.name AS circle_name, c.category AS circle_category,
        (1 - (a.embedding <=> cc.vec))::double precision AS similarity
      FROM content_anchors a
      JOIN learning_items l ON l.id = a.item_id
      JOIN circle_centroids cc ON vector_dims(a.embedding) = cc.dims
      JOIN circles c ON c.id = cc.circle_id
      WHERE a.embedding IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM circle_items ci WHERE ci.item_id = a.item_id AND ci.circle_id = cc.circle_id)
        AND (a.embedding <=> cc.vec) <= 0.28
      ORDER BY a.item_id, cc.circle_id, a.embedding <=> cc.vec
      LIMIT 60`, [circleId]);
    for (const hit of semanticHits) {
      const key = `${hit.item_id}:${hit.circle_id}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      suggestions.push({
        item_id: hit.item_id,
        item_title: hit.item_title,
        item_type: hit.item_type,
        circle_id: hit.circle_id,
        circle_name: hit.circle_name,
        circle_category: hit.circle_category,
        create_circle_name: null,
        reason: `语义相似 ${Math.round(hit.similarity * 100)}%`,
        source: 'semantic',
      });
    }
  }

  return suggestions.slice(0, 100);
}
