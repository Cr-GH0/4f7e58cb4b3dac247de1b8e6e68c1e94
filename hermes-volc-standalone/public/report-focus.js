const normalize = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = text => new Set(normalize(text).split(' ').filter(word => word.length > 3));

// Match the actual report text, so imported reports need no special classes.
export function focusReport(doc, part) {
  if (!part) return;
  if (part.id === 'intro' && !part.anchor) { if (doc.scrollingElement) doc.scrollingElement.scrollTop = 0; return; }
  const candidates = [...doc.querySelectorAll('h1,h2,h3,h4,p,li,td,blockquote,section,article,div')]
    .filter(node => node.getClientRects().length && normalize(node.textContent));
  const anchor = normalize(part.anchor);
  let target = anchor ? candidates.filter(node => normalize(node.textContent).includes(anchor))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0] : null;
  if (!target) {
    const spoken = words(part.text);
    let best = 0;
    for (const node of candidates) {
      const terms = words(node.textContent);
      const overlap = [...spoken].filter(word => terms.has(word)).length;
      const score = overlap / Math.sqrt(Math.max(1, terms.size));
      if (overlap >= 2 && score > best) { best = score; target = node; }
    }
  }
  target?.scrollIntoView({ block: 'center', behavior: 'auto' });
}
