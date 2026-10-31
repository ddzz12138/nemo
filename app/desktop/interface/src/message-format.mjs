// Produce text-only formatting tokens. Model output never becomes HTML.
export function inlineParts(text) {
  const source = String(text || ''), parts = [];
  if (source.length > 64_000) return [{ type: 'text', text: source }];
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*)/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset) parts.push({ type: 'text', text: source.slice(offset, match.index) });
    const token = match[0], type = token.startsWith('`') ? 'code' : token.startsWith('**') || token.startsWith('__') ? 'strong' : 'em';
    const trim = type === 'strong' ? 2 : 1;
    parts.push({ type, text: token.slice(trim, -trim) }); offset = match.index + token.length;
  }
  if (offset < source.length) parts.push({ type: 'text', text: source.slice(offset) });
  return parts;
}
export function messageBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), blocks = [];
  const listItem = line => /^(?:[-*+]\s+|\d{1,9}[.)]\s+)/.exec(line);
  const startsBlock = line => /^```|^#{1,6}\s|^>\s?/.test(line) || listItem(line);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^```/.test(line)) {
      const content = []; index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push({ type: 'code', text: content.join('\n') }); continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', text: heading[1] }); index++; continue; }
    const bullet = listItem(line);
    if (bullet) {
      const ordered = /^\d/.test(line), start = ordered ? Number.parseInt(line, 10) : undefined, items = [];
      while (index < lines.length) {
        const next = listItem(lines[index]); if (!next || /^\d/.test(lines[index]) !== ordered) break;
        items.push(lines[index].slice(next[0].length)); index++;
      }
      blocks.push({ type: 'list', ordered, ...(ordered ? { start } : {}), items }); continue;
    }
    if (/^>\s?/.test(line)) {
      const content = []; while (index < lines.length && /^>\s?/.test(lines[index])) content.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', text: content.join('\n') }); continue;
    }
    const content = [line]; index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) content.push(lines[index++]);
    blocks.push({ type: 'paragraph', text: content.join('\n') });
  }
  return blocks;
}
