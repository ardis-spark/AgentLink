/**
 * Reads the text a person would see in a part of the page. It is written by
 * hand (rather than using `innerText`) so the result is the same in every
 * engine and so page chrome can be skipped while walking.
 */

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL',
]);
/** Page furniture that is never part of a reply. */
const CHROME_SELECTOR = 'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="tooltip"], [role="menu"]';
/** Buttons with short labels are controls ("Copy", "Retry"); longer ones are usually collapsible content headers. */
const CONTROL_LABEL_MAX = 24;

export function isHidden(el: Element, win: Window): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const style = win.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
}

export function isVisible(el: Element, win: Window): boolean {
  for (let node: Element | null = el; node && node !== el.ownerDocument.documentElement; node = node.parentElement) {
    if (isHidden(node, win)) return false;
  }
  return true;
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface ExtractOptions {
  win: Window;
  /** Subtrees to leave out entirely (for example the composer). */
  exclude?: (el: Element) => boolean;
  /** Only text that comes after this element in document order is returned. */
  after?: Element | null;
  /** Leave out navigation, sidebars and short control labels. */
  skipChrome?: boolean;
}

export function extractText(root: Element, options: ExtractOptions): string {
  const { win, exclude, after = null, skipChrome = false } = options;
  const out: string[] = [];
  let collecting = after === null;

  const breakLine = (): void => {
    if (out.length > 0 && out[out.length - 1] !== '\n') out.push('\n');
  };

  const walk = (node: Node, preformatted: boolean): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      if (!collecting) return;
      const value = node.nodeValue ?? '';
      if (preformatted) {
        out.push(value);
      } else {
        const text = value.replace(/\s+/g, ' ');
        if (text.trim() || (out.length > 0 && out[out.length - 1] !== '\n' && !/\s$/.test(out[out.length - 1] ?? ''))) out.push(text);
      }
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    if (el === after) {
      // Everything after this element counts; its own content does not.
      collecting = true;
      return;
    }
    const tag = el.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) return;
    if (isHidden(el, win)) return;
    if (exclude?.(el)) return;
    if (skipChrome) {
      if (el.matches(CHROME_SELECTOR)) return;
      if ((tag === 'BUTTON' || el.getAttribute('role') === 'button') && collapse(el.textContent ?? '').length <= CONTROL_LABEL_MAX) return;
    }
    if (tag === 'BR') {
      if (collecting) out.push('\n');
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block && collecting) breakLine();
    const pre = preformatted || tag === 'PRE';
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child, pre);
    if (block && collecting) breakLine();
  };

  walk(root, false);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
