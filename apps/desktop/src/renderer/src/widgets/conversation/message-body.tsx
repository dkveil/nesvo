import {
  isValidElement,
  memo,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import Markdown, {
  type Components,
  type ExtraProps,
  type Options,
} from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { Check, Copy, WrapText } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Checkbox } from '@/shared/ui/checkbox';
import { IconButton } from '@/shared/ui/icon-button';

const HIGHLIGHT_LIMIT_CHARACTERS = 20_000;
const COPIED_FEEDBACK_MS = 1_500;

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

const textOf = (node: HastNode): string =>
  node.value ?? (node.children ? node.children.map(textOf).join('') : '');

const markLargeCodeAsPlain = () => (tree: HastNode) => {
  const visit = (node: HastNode, parent?: HastNode) => {
    if (
      node.tagName === 'code' &&
      parent?.tagName === 'pre' &&
      textOf(node).length > HIGHLIGHT_LIMIT_CHARACTERS
    ) {
      const className = node.properties?.className;
      node.properties = {
        ...node.properties,
        className: [
          ...(Array.isArray(className) ? className : []),
          'no-highlight',
        ],
      };
      return;
    }
    node.children?.forEach(child => visit(child, node));
  };
  visit(tree);
};

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm];
const rehypePlugins: Options['rehypePlugins'] = [
  markLargeCodeAsPlain,
  [rehypeHighlight, { detect: false }],
];

const languageOf = (className: unknown) =>
  typeof className === 'string'
    ? (/(?:^|\s)language-(\S+)/.exec(className)?.[1] ?? '')
    : '';

const externalUrl = (href: string | undefined) => {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
};

function CodeBlock({ children, node }: ComponentProps<'pre'> & ExtraProps) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const code = isValidElement<ComponentProps<'code'>>(children)
    ? children.props
    : { className: undefined, children };
  const language = languageOf(code.className);
  const handleCopy = () => {
    const text = node ? textOf(node).replace(/\n$/, '') : '';
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(
          () => setCopied(false),
          COPIED_FEEDBACK_MS,
        );
      },
      () => setCopied(false),
    );
  };
  return (
    <figure
      aria-label={language ? `Code: ${language}` : 'Code'}
      className="overflow-hidden rounded-surface border bg-code-background"
    >
      <figcaption className="flex h-8 items-center justify-between gap-2 pr-1 pl-3 text-2xs text-muted-foreground">
        <span className="truncate font-mono">{language || 'text'}</span>
        <span className="flex items-center gap-0.5">
          <IconButton
            label={copied ? 'Copied' : 'Copy code'}
            size={24}
            onClick={handleCopy}
          >
            {copied ? <Check className="text-success-foreground" /> : <Copy />}
          </IconButton>
          <IconButton
            label="Wrap code lines"
            size={24}
            pressed={wrap}
            onClick={() => setWrap(value => !value)}
          >
            <WrapText />
          </IconButton>
        </span>
      </figcaption>
      <pre
        className={cn(
          'max-h-[28rem] overflow-auto px-3 pb-3 font-mono text-xs leading-5',
          wrap
            ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
            : 'whitespace-pre [overflow-wrap:normal]',
        )}
      >
        <code className={code.className}>{code.children}</code>
      </pre>
    </figure>
  );
}

function MarkdownLink({ href, children }: ComponentProps<'a'> & ExtraProps) {
  const url = externalUrl(href);
  if (!url) return <span>{children}</span>;
  return (
    <a
      href={url}
      title={url}
      rel="noreferrer"
      className="underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground"
      onClick={event => {
        event.preventDefault();
        void window.nesvo?.openExternal(url)?.catch(() => undefined);
      }}
    >
      {children}
    </a>
  );
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 text-xl leading-7 font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 text-lg leading-7 font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 text-base leading-6 font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 leading-6 font-semibold first:mt-0">{children}</h4>
  ),
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  ul: ({ children, className }) => (
    <ul
      className={cn(
        'space-y-1',
        className?.includes('contains-task-list')
          ? 'list-none [li_&]:ml-5'
          : 'ml-5 list-disc',
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="ml-5 list-decimal space-y-1">
      {children}
    </ol>
  ),
  li: ({ children, className }) => (
    <li
      className={cn(
        'pl-0.5 [&>ol]:mt-1 [&>p+p]:mt-2 [&>ul]:mt-1',
        className?.includes('task-list-item') && 'list-none pl-0',
      )}
    >
      {children}
    </li>
  ),
  input: ({ type, checked }) =>
    type === 'checkbox' ? (
      <Checkbox
        checked={!!checked}
        aria-readonly
        tabIndex={-1}
        className="pointer-events-none mr-2 inline-grid translate-y-0.5"
      />
    ) : null,
  blockquote: ({ children }) => (
    <blockquote className="space-y-3 border-l-2 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border" />,
  code: ({ children, className }) => (
    <code
      className={cn(
        'rounded-md border bg-code-background px-1 py-px font-mono text-[0.85em]',
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: CodeBlock,
  a: MarkdownLink,
  img: ({ src, alt }) => {
    const source = typeof src === 'string' ? src : '';
    if (source.startsWith('data:image/'))
      return (
        <img src={source} alt={alt ?? ''} className="max-w-full rounded-md" />
      );
    return (
      <MarkdownLink href={source}>
        {alt || externalUrl(source) || 'image'}
      </MarkdownLink>
    );
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-left [overflow-wrap:normal]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
  tbody: ({ children }) => (
    <tbody className="[&>tr:last-child>td]:border-b-0">{children}</tbody>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b px-3 py-1.5 font-semibold text-foreground"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b px-3 py-1.5 align-top">
      {children}
    </td>
  ),
};

export const MessageBody = memo(function MessageBody({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  const deferredBody = useDeferredValue(body);
  return (
    <div
      className={cn('min-w-0 space-y-3 [overflow-wrap:anywhere]', className)}
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {deferredBody}
      </Markdown>
    </div>
  );
});
