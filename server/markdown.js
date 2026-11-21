import MarkdownIt from 'markdown-it';

export const markdown = new MarkdownIt({ linkify: true });
const anchorTypes = new Set(['heading_open', 'paragraph_open', 'fence', 'code_block', 'table_open']);

export function markdownAnchors(itemId, text) {
  const tokens = markdown.parse(text, {});
  const lines = text.split('\n');
  return tokens.flatMap((token, index) => {
    if (!token.map || !anchorTypes.has(token.type)) return [];
    const line = token.map[0];
    const content = (token.content || tokens[index + 1]?.content || lines.slice(line, token.map[1]).join('\n')).trim();
    if (!content) return [];
    return [{ id: `${itemId}-${line}`, text: content, anchor_meta: { line, heading: token.type === 'heading_open' } }];
  });
}
