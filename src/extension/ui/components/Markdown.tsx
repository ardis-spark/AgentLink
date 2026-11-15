import type { ComponentChildren, VNode } from 'preact';

/**
 * A small, safe renderer for the coordinator's replies. It builds elements
 * directly and never sets HTML, so nothing in a model reply can inject markup.
 * Supported: paragraphs, headings, lists, fenced code, inline code, bold,
 * italics and http(s) links.
 */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    if (token.startsWith('`')) out.push(<code>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) out.push(<strong>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*')) out.push(<em>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      if (link) {
        out.push(
          <a href={link[2]} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>,
        );
      } else out.push(token);
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }): VNode {
  const blocks: VNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push(<p>{inline(paragraph.join(' '))}</p>);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map((item) => <li>{inline(item)}</li>);
      blocks.push(list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>);
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = /^\s*```/.test(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push(
        <pre>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(<h4>{inline(heading[2] ?? '')}</h4>);
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet?.[1] ?? numbered?.[1] ?? '').trim());
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (list && /^\s{2,}\S/.test(line) && list.items.length > 0) {
      // A wrapped continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return <div class="prose">{blocks}</div>;
}
