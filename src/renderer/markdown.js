// Small Markdown-to-HTML renderer for the AI notes: headings, bullet and
// checkbox lists, bold, italic, inline code and paragraphs. Everything is
// HTML-escaped first, so model output can't inject markup.

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
}

export function renderMarkdown(md) {
  const out = [];
  let list = null; // 'ul' while inside a list
  let para = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push('</ul>');
    list = null;
  };

  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (!line.trim()) {
      flushPara();
      closeList();
    } else if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (task || bullet || numbered) {
      flushPara();
      if (!list) {
        out.push('<ul>');
        list = 'ul';
      }
      if (task) {
        const done = task[1].toLowerCase() === 'x';
        out.push(`<li class="task${done ? ' done' : ''}"><span class="box" aria-hidden="true"></span>${inline(task[2])}</li>`);
      } else {
        out.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      }
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();
  return out.join('\n');
}
