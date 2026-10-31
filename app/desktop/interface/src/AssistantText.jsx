import React, { useMemo } from 'react';
import { inlineParts, messageBlocks } from './message-format.mjs';
function Inline({ text }) { return inlineParts(text).map((part, index) => {
  if (part.type === 'text') return <React.Fragment key={index}>{part.text}</React.Fragment>;
  const Tag = part.type; return <Tag key={index}>{part.text}</Tag>;
}); }
export function AssistantText({ text }) {
  const blocks = useMemo(() => messageBlocks(text), [text]);
  return <div className="assistant-text">{blocks.map((block, index) => {
    if (block.type === 'code') return <pre key={index}><code>{block.text}</code></pre>;
    if (block.type === 'list') { const List = block.ordered ? 'ol' : 'ul'; return <List key={index} start={block.ordered ? block.start : undefined}>{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} /></li>)}</List>; }
    if (block.type === 'heading') return <p className="message-heading" key={index}><strong><Inline text={block.text} /></strong></p>;
    if (block.type === 'quote') return <blockquote key={index}><Inline text={block.text} /></blockquote>;
    return <p key={index}><Inline text={block.text} /></p>;
  })}</div>;
}
