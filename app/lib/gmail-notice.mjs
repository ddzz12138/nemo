import { Parser } from 'htmlparser2';

const MAX_TEXT = 12000, MAX_BYTES = 96000;
const clean = text => text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function htmlText(html) {
  let text = '', hidden = 0, links = false;
  const stack = [], blocks = new Set(['p','div','li','tr','br','h1','h2','h3','h4','section','article']);
  const parser = new Parser({
    onopentag(name, attrs) {
      const hide = ['script','style','head','iframe','object','svg','template'].includes(name) || attrs.hidden !== undefined || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style || '');
      stack.push({ name, hide }); if (hide) hidden++;
      if (!hidden && blocks.has(name)) text += '\n';
      if (!hidden && name === 'a' && attrs.href) links = true;
    },
    ontext(value) { if (!hidden) text += value; },
    onclosetag(name) { const item = stack.pop(); if (item?.hide) hidden--; if (!hidden && blocks.has(name)) text += '\n'; },
  }, { decodeEntities: true });
  parser.end(html); return { text: clean(text), links };
}

/** Extract text without fetching URLs, images, attachments or linked messages. */
export function projectSelectedNotice(message, expectedId) {
  if (message?.id !== expectedId || !message.payload) throw new Error('Google returned a different or unsupported notice.');
  let visited = 0, attachments = false, unsupported = false;
  function part(node, depth = 0) {
    if (!node || depth > 12 || ++visited > 100) { unsupported = true; return { text: '', links: false }; }
    if (node.filename || node.body?.attachmentId) { attachments = true; return { text: '', links: false }; }
    const mime = String(node.mimeType || '').toLowerCase();
    if (mime.startsWith('multipart/')) {
      const parts = Array.isArray(node.parts) ? node.parts.map(value => part(value, depth + 1)) : [];
      if (mime === 'multipart/alternative') return { ...(parts.find(value => value.text && value.plain) || parts.find(value => value.text) || { text: '' }), links: parts.some(value => value.links) };
      return { text: parts.map(value => value.text).filter(Boolean).join('\n\n'), links: parts.some(value => value.links) };
    }
    if (!['text/plain','text/html'].includes(mime)) { unsupported = true; return { text: '', links: false }; }
    const data = node.body?.data;
    if (typeof data !== 'string' || data.length > MAX_BYTES * 2 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) { unsupported = true; return { text: '', links: false }; }
    const bytes = Buffer.from(data, 'base64url');
    if (bytes.length > MAX_BYTES) { unsupported = true; return { text: '', links: false }; }
    const contentType = node.headers?.find(value => /^content-type$/i.test(value.name || ''))?.value || '';
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] || 'utf-8';
    let decoded; try { decoded = new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { unsupported = true; return { text: '', links: false }; }
    return mime === 'text/html' ? htmlText(decoded) : { text: clean(decoded), links: /https?:\/\/|www\./i.test(decoded), plain: true };
  }
  const selected = part(message.payload), full = clean(selected.text);
  const header = name => String(message.payload.headers?.find(value => value.name?.toLowerCase() === name)?.value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
  return { id: expectedId, subject: header('subject'), from: header('from'), date: header('date'),
    receivedAt: /^\d{1,16}$/.test(message.internalDate || '') ? Number(message.internalDate) : null,
    text: full.slice(0, MAX_TEXT), truncated: full.length > MAX_TEXT, attachments, linkedPages: selected.links,
    bodyComplete: !!full && !unsupported && full.length <= MAX_TEXT, unsupportedParts: unsupported };
}
