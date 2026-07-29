/**
 * A ~100-line Markdown renderer. LEARN owns this file.
 *
 * Deliberately hand-rolled rather than a dependency: the academy's whole thesis
 * is that Markup is one of the three pillars, so the machinery that turns the
 * lesson scrolls into HTML should be small enough to read in one sitting — it
 * is itself teaching material. Covers exactly what the lessons use: headings,
 * paragraphs, emphasis, inline code, fenced code, lists, blockquotes, links,
 * horizontal rules. Nothing else, on purpose.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline spans: code first (its contents are literal), then links, bold, italic. */
function inline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`);
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, text: string, href: string) => `<a href="${href}" rel="noopener">${text}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) html.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (code !== null) {
      if (/^```/.test(line)) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line)) {
      flushAll();
      html.push('<hr />');
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      flushQuote();
      (list ??= []).push(item[1]);
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    if (line === '') {
      flushAll();
      continue;
    }
    // A plain line while a list or quote is open is a soft-wrapped
    // continuation of the previous item, not a new paragraph.
    if (list && list.length) {
      list[list.length - 1] += ' ' + line.trim();
      continue;
    }
    if (quote.length) {
      quote.push(line.trim());
      continue;
    }
    paragraph.push(line);
  }
  flushAll();
  return html.join('\n');
}
