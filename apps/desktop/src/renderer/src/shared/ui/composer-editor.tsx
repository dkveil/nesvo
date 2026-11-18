import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/shared/lib/cn';
import {
  TOKEN_ATTRIBUTE,
  offsetOf,
  placeCaret,
  placeCaretAfter,
  readContent,
  renderContent,
  selectionIn,
  tokenIdOf,
  type EditorSelection,
} from './composer-editor-content';

export type ComposerEditorToken = {
  id: string;
  offset: number;
  content: ReactNode;
};

export type ComposerEditorChange = {
  value: string;
  offsets: Record<string, number>;
  removed: string[];
};

export type ComposerEditorHandle = {
  element: HTMLDivElement | null;
  focus: () => void;
  selection: () => EditorSelection;
  offsetAt: (x: number, y: number) => number | null;
};

type ComposerEditorProps = Omit<
  ComponentProps<'div'>,
  'onChange' | 'ref' | 'children' | 'contentEditable' | 'defaultValue'
> & {
  ref?: Ref<ComposerEditorHandle>;
  value: string;
  tokens?: readonly ComposerEditorToken[];
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  onChange: (change: ComposerEditorChange) => void;
};

const modelKey = (
  value: string,
  tokens: readonly Pick<ComposerEditorToken, 'id' | 'offset'>[],
) =>
  `${value}\u0000${tokens
    .map(token => `${token.id}:${Math.min(token.offset, value.length)}`)
    .join()}`;

const hostFor = (
  cache: Map<string, HTMLElement>,
  token: ComposerEditorToken,
) => {
  const existing = cache.get(token.id);
  if (existing) return existing;
  const host = document.createElement('span');
  host.setAttribute(TOKEN_ATTRIBUTE, token.id);
  host.contentEditable = 'false';
  host.className = 'mx-0.5';
  cache.set(token.id, host);
  return host;
};

const insertedText = (event: InputEvent) => {
  if (event.data) return event.data;
  const transferred = event.dataTransfer?.getData('text/plain');
  if (transferred) return transferred;
  return event.inputType === 'insertLineBreak' ||
    event.inputType === 'insertParagraph'
    ? '\n'
    : '';
};

export function ComposerEditor({
  ref,
  value,
  tokens = [],
  placeholder,
  maxLength,
  disabled = false,
  onChange,
  onPaste,
  onInput,
  onFocus,
  onMouseDown,
  className,
  ...props
}: ComposerEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const [hosts] = useState(() => new Map<string, HTMLElement>());
  const renderedKey = useRef<string | null>(null);
  const renderedIds = useRef(new Set<string>());
  const lastSelection = useRef<EditorSelection | null>(null);
  const pointerFocus = useRef(false);
  const key = modelKey(value, tokens);

  const currentSelection = (element: HTMLElement): EditorSelection => {
    const selection = selectionIn(element) ?? lastSelection.current;
    const length = readContent(element).text.length;
    return selection
      ? {
          start: Math.min(selection.start, length),
          end: Math.min(selection.end, length),
        }
      : { start: length, end: length };
  };

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return root.current;
      },
      focus: () => {
        const element = root.current;
        if (!element) return;
        element.focus();
        if (!selectionIn(element))
          placeCaret(element, readContent(element).text.length);
      },
      selection: () =>
        root.current
          ? currentSelection(root.current)
          : { start: value.length, end: value.length },
      offsetAt: (x, y) => {
        const element = root.current;
        const range = document.caretRangeFromPoint?.(x, y);
        if (!element || !range || !element.contains(range.startContainer))
          return null;
        return offsetOf(element, range.startContainer, range.startOffset);
      },
    }),
    [value],
  );

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || renderedKey.current === key) return;
    const initial = renderedKey.current === null;
    const focused = document.activeElement === element;
    const placed = tokens
      .map((token, index) => ({
        token,
        index,
        offset: Math.min(Math.max(token.offset, 0), value.length),
      }))
      .sort(
        (left, right) => left.offset - right.offset || left.index - right.index,
      )
      .map(({ token, offset }) => ({ host: hostFor(hosts, token), offset }));
    renderContent(element, value, placed);
    const added = initial
      ? undefined
      : tokens.filter(token => !renderedIds.current.has(token.id)).at(-1);
    renderedKey.current = key;
    renderedIds.current = new Set(tokens.map(token => token.id));
    for (const id of hosts.keys())
      if (!renderedIds.current.has(id)) hosts.delete(id);
    if (added && !disabled) {
      element.focus();
      placeCaretAfter(hosts.get(added.id)!);
    } else if (focused) placeCaret(element, value.length);
  });

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const remember = () => {
      const selection = selectionIn(element);
      if (selection) lastSelection.current = selection;
    };
    const limit = (event: InputEvent) => {
      if (maxLength == null || !event.inputType.startsWith('insert')) return;
      const selection = currentSelection(element);
      const length = readContent(element).text.length;
      if (
        length -
          (selection.end - selection.start) +
          insertedText(event).length >
        maxLength
      )
        event.preventDefault();
    };
    document.addEventListener('selectionchange', remember);
    element.addEventListener('beforeinput', limit);
    return () => {
      document.removeEventListener('selectionchange', remember);
      element.removeEventListener('beforeinput', limit);
    };
  });

  const handleInput = () => {
    const element = root.current;
    if (!element) return;
    for (const node of [...element.querySelectorAll(`[${TOKEN_ATTRIBUTE}]`)]) {
      const id = tokenIdOf(node);
      if (!id || !tokens.some(token => token.id === id)) node.remove();
    }
    const content = readContent(element);
    const removed = tokens
      .filter(
        token =>
          renderedIds.current.has(token.id) && !content.offsets.has(token.id),
      )
      .map(token => token.id);
    const remaining = tokens
      .filter(token => !removed.includes(token.id))
      .map(token => ({
        ...token,
        offset: content.offsets.get(token.id) ?? token.offset,
      }));
    renderedKey.current = modelKey(content.text, remaining);
    renderedIds.current = new Set(content.offsets.keys());
    onChange({
      value: content.text,
      offsets: Object.fromEntries(content.offsets),
      removed,
    });
  };

  const empty = !value && !tokens.length;

  return (
    <div className="relative">
      <div
        ref={root}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        contentEditable={disabled ? false : 'plaintext-only'}
        suppressContentEditableWarning
        data-slot="composer-input"
        className={cn(
          'block max-h-48 min-h-11 w-full overflow-y-auto px-1 text-ui leading-6 break-words whitespace-pre-wrap text-foreground outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
          className,
        )}
        onInput={event => {
          handleInput();
          onInput?.(event);
        }}
        onMouseDown={event => {
          pointerFocus.current = true;
          onMouseDown?.(event);
        }}
        onFocus={event => {
          if (!pointerFocus.current && !selectionIn(event.currentTarget))
            placeCaret(
              event.currentTarget,
              readContent(event.currentTarget).text.length,
            );
          pointerFocus.current = false;
          onFocus?.(event);
        }}
        onPaste={event => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const text = event.clipboardData
            .getData('text/plain')
            .replace(/\r\n?/g, '\n');
          if (!text) return;
          const element = event.currentTarget;
          const selection = currentSelection(element);
          const room =
            maxLength == null
              ? text.length
              : maxLength -
                readContent(element).text.length +
                (selection.end - selection.start);
          const allowed = text.slice(0, Math.max(0, room));
          if (allowed) document.execCommand('insertText', false, allowed);
        }}
        {...props}
      />
      {empty && placeholder && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-0 truncate text-ui leading-6 text-muted-foreground/70"
        >
          {placeholder}
        </span>
      )}
      {tokens.map(token =>
        createPortal(token.content, hostFor(hosts, token), token.id),
      )}
    </div>
  );
}
