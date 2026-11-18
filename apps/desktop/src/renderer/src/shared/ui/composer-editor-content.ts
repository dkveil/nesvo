export const TOKEN_ATTRIBUTE = 'data-composer-token';

export type EditorSelection = { start: number; end: number };

export type EditorContent = { text: string; offsets: Map<string, number> };

export type PlacedHost = { host: HTMLElement; offset: number };

const BLOCK_TAGS = new Set(['DIV', 'P']);

export const tokenIdOf = (node: Node | null) =>
  node instanceof HTMLElement ? node.getAttribute(TOKEN_ATTRIBUTE) : null;

const isPlaceholderBreak = (node: Node, root: Node) =>
  node.nodeName === 'BR' && node.parentNode === root && !node.nextSibling;

const lastContentNode = (root: Node) => {
  let node = root.lastChild;
  while (node?.nodeType === Node.TEXT_NODE && !(node as Text).data)
    node = node.previousSibling;
  return node;
};

const endsWithPlaceholderNewline = (root: Node) => {
  const last = lastContentNode(root);
  return (
    last?.nodeType === Node.TEXT_NODE && (last as Text).data.endsWith('\n')
  );
};

export const readContent = (
  root: HTMLElement,
  trailingBreakIsPlaceholder = true,
): EditorContent => {
  let text = '';
  const offsets = new Map<string, number>();
  const visit = (node: Node) => {
    node.childNodes.forEach(child => {
      const id = tokenIdOf(child);
      if (id) {
        if (!offsets.has(id)) offsets.set(id, text.length);
        return;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        text += (child as Text).data;
        return;
      }
      if (child.nodeName === 'BR') {
        if (!trailingBreakIsPlaceholder || !isPlaceholderBreak(child, root))
          text += '\n';
        return;
      }
      if (BLOCK_TAGS.has(child.nodeName) && text && !text.endsWith('\n'))
        text += '\n';
      visit(child);
    });
  };
  visit(root);
  if (!trailingBreakIsPlaceholder) return { text, offsets };
  if (endsWithPlaceholderNewline(root)) text = text.slice(0, -1);
  if (text === '\n' && !offsets.size) text = '';
  return { text, offsets };
};

export const offsetOf = (root: HTMLElement, node: Node, offset: number) => {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  return readContent(holder, false).text.length;
};

export const selectionIn = (root: HTMLElement): EditorSelection | null => {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode))
    return null;
  const range = selection.getRangeAt(0);
  return {
    start: offsetOf(root, range.startContainer, range.startOffset),
    end: offsetOf(root, range.endContainer, range.endOffset),
  };
};

const applyRange = (range: Range) => {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

export const placeCaret = (root: HTMLElement, target: number) => {
  const range = document.createRange();
  let remaining = target;
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const length = (child as Text).data.length;
      if (remaining <= length) {
        range.setStart(child, remaining);
        range.collapse(true);
        applyRange(range);
        return;
      }
      remaining -= length;
    } else if (child.nodeName === 'BR' && !isPlaceholderBreak(child, root)) {
      if (remaining === 0) {
        range.setStartBefore(child);
        range.collapse(true);
        applyRange(range);
        return;
      }
      remaining -= 1;
    }
  }
  range.selectNodeContents(root);
  range.collapse(false);
  applyRange(range);
};

export const placeCaretAfter = (node: Node) => {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  applyRange(range);
};

export const renderContent = (
  root: HTMLElement,
  text: string,
  placed: readonly PlacedHost[],
) => {
  const nodes: Node[] = [];
  let cursor = 0;
  for (const { host, offset } of placed) {
    nodes.push(document.createTextNode(text.slice(cursor, offset)), host);
    cursor = offset;
  }
  const rest = text.slice(cursor);
  nodes.push(document.createTextNode(rest.endsWith('\n') ? `${rest}\n` : rest));
  root.replaceChildren(...nodes);
};
