import { segment, parseBlock } from '../../../../packages/markdown/src/index.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = nodes => nodes.map(node => {
  if (node.type === 'strong' || node.type === 'em') return `<${node.type}>${inline(node.children)}</${node.type}>`;
  if (node.type === 'code') return `<code>${escape(node.text)}</code>`;
  if (node.type === 'link' && node.local) return inline(node.children);
  if (node.type === 'link') return `<a href="${escape(node.href)}" rel="noreferrer noopener">${inline(node.children)}</a>`;
  return escape(node.text);
}).join('');

// Only fixed tags are emitted. Raw HTML remains text and the shared parser rejects unsafe links.
export function renderMarkdown(source) {
  return segment(String(source ?? '').replace(/\r\n?/g, '\n')).segments.map(raw => {
    const block = parseBlock(raw);
    switch (block.type) {
      case 'heading': return `<h${block.level}>${inline(block.children)}</h${block.level}>`;
      case 'paragraph': return `<p>${inline(block.children)}</p>`;
      case 'quote': return `<blockquote>${inline(block.children)}</blockquote>`;
      case 'rule': return '<hr>';
      case 'code': return `<pre><code>${escape(block.text)}</code></pre>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        return `<${tag}${block.ordered ? ` start="${block.start}"` : ''}>${block.items.map(item => `<li class="md-depth-${item.depth}${item.checked !== null ? ' md-check' : ''}">${item.checked !== null ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''} aria-label="${item.checked ? 'Completed' : 'Incomplete'}">` : ''}${inline(item.children)}</li>`).join('')}</${tag}>`;
      }
      case 'table': return `<div class="md-table"><table><thead><tr>${block.header.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      default: return `<p>${escape(raw)}</p>`;
    }
  }).join('');
}
