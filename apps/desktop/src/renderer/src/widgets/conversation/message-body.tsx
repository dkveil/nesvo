import {
  createContext,
  isValidElement,
  memo,
  useContext,
  useDeferredValue,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import Markdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type Options,
} from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { InlineFileCode, MessageLink } from './message-links';
import { MessageLinkContext } from './message-link-context';
import { fileTarget } from './message-link-target';
import { Check, Copy, WrapText } from 'lucide-react';
import type { MessageAttachment } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { Checkbox } from '@/shared/ui/checkbox';
import { IconButton } from '@/shared/ui/icon-button';
import {
  attachmentIndexOf,
  hasPlacedAttachments,
  withAttachmentMarkers,
} from './attachment-markers';

const HIGHLIGHT_LIMIT_CHARACTERS = 20_000;

type InlineAttachmentRenderer = (index: number) => ReactNode;

const InlineAttachmentContext = createContext<InlineAttachmentRenderer | null>(
  null,
);
const COPIED_FEEDBACK_MS = 1_500;

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; href?: string };
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
const linkBareUrls = () => (tree: HastNode) => {
  const visit = (node: HastNode) => {
    if (!node.children || ['a', 'pre', 'code'].includes(node.tagName ?? ''))
      return;
    node.children = node.children.flatMap(child => {
      if (child.type !== 'text' || !child.value) {
        visit(child);
        return [child];
      }
      const nodes: HastNode[] = [];
      let start = 0;
      for (const match of child.value.matchAll(
        /(?:https?:\/\/|nesvo:\/\/)[^\s<>"'’]+/gi,
      )) {
        const index = match.index;
        if (index > 0 && /[\w@]/.test(child.value[index - 1]!)) continue;
        let href = match[0].replace(/[.,!?;:]+$/, '');
        while (
          href.endsWith(')') &&
          href.split(')').length > href.split('(').length
        )
          href = href.slice(0, -1);
        if (!URL.canParse(href)) continue;
        nodes.push({ type: 'text', value: child.value.slice(start, index) });
        nodes.push({
          type: 'element',
          tagName: 'a',
          properties: { href },
          children: [{ type: 'text', value: href }],
        });
        start = index + href.length;
      }
      return start
        ? [...nodes, { type: 'text', value: child.value.slice(start) }]
        : [child];
    });
  };
  visit(tree);
};

const tightenInlinePunctuation = (directory: string) => (tree: HastNode) => {
  const visit = (node: HastNode) => {
    if (!node.children || ['a', 'pre', 'code'].includes(node.tagName ?? ''))
      return;
    for (let index = 1; index < node.children.length; index++) {
      const child = node.children[index]!;
      const previous = node.children[index - 1]!;
      if (
        child.type === 'text' &&
        child.value &&
        (previous.tagName === 'a' ||
          (previous.tagName === 'code' &&
            fileTarget(textOf(previous), directory)))
      ) {
        child.value = child.value.replace(/^[ \t\u00a0]+(?=[,.:;!?)\]])/, '');
      }
    }
    node.children.forEach(visit);
  };
  visit(tree);
};

const rehypePlugins: Options['rehypePlugins'] = [
  markLargeCodeAsPlain,
  linkBareUrls,
  [rehypeHighlight, { detect: false }],
];

const githubRehypePlugins: Options['rehypePlugins'] = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      tagNames: defaultSchema.tagNames?.filter(
        tag => tag !== 'picture' && tag !== 'source',
      ),
      protocols: { ...defaultSchema.protocols, href: ['http', 'https'] },
      strip: ['script', 'style', 'iframe'],
    },
  ],
  ...rehypePlugins,
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
  const renderAttachment = useContext(InlineAttachmentContext);
  const attachmentIndex = attachmentIndexOf(href);
  if (renderAttachment && attachmentIndex != null)
    return renderAttachment(attachmentIndex);
  return <MessageLink href={href}>{children}</MessageLink>;
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 text-lg leading-7 font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 text-base leading-6 font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-6 mb-2 text-title font-semibold first:mt-0">
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
    <InlineFileCode candidate={typeof children === 'string' ? children : ''}>
      <code
        className={cn(
          'rounded-control border bg-code-background px-1 py-px font-mono text-[0.85em]',
          className,
        )}
      >
        {children}
      </code>
    </InlineFileCode>
  ),
  pre: CodeBlock,
  a: MarkdownLink,
  img: ({ src, alt }) => {
    const source = typeof src === 'string' ? src : '';
    if (source.startsWith('data:image/'))
      return (
        <img
          src={source}
          alt={alt ?? ''}
          className="max-w-full rounded-control"
        />
      );
    return (
      <MarkdownLink href={source}>
        {alt || externalUrl(source) || 'image'}
      </MarkdownLink>
    );
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto rounded-surface border">
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
  attachments,
  renderAttachment,
  streaming = false,
  githubPullRequestUrl,
}: {
  body: string;
  className?: string;
  attachments?: readonly MessageAttachment[];
  renderAttachment?: (attachment: MessageAttachment) => ReactNode;
  streaming?: boolean;
  githubPullRequestUrl?: string;
}) {
  const linkContext = useContext(MessageLinkContext);
  const directory = githubPullRequestUrl ? undefined : linkContext?.directory;
  const plugins = useMemo<Options['rehypePlugins']>(
    () =>
      githubPullRequestUrl
        ? githubRehypePlugins
        : directory
          ? [...rehypePlugins, [tightenInlinePunctuation, directory]]
          : rehypePlugins,
    [directory, githubPullRequestUrl],
  );
  const readyForMarkdown = useDeferredValue(!streaming);
  const inline = !!renderAttachment && hasPlacedAttachments(attachments);
  const markdown =
    inline && attachments ? withAttachmentMarkers(body, attachments) : body;
  const renderIndex = useMemo<InlineAttachmentRenderer | null>(
    () =>
      inline && attachments && renderAttachment
        ? index => {
            const attachment = attachments[index];
            return attachment ? renderAttachment(attachment) : null;
          }
        : null,
    [inline, attachments, renderAttachment],
  );
  return (
    <div
      className={cn('min-w-0 space-y-3 [overflow-wrap:anywhere]', className)}
    >
      {streaming || !readyForMarkdown ? (
        <p className="whitespace-pre-wrap">{body}</p>
      ) : (
        <InlineAttachmentContext.Provider value={renderIndex}>
          <MessageLinkContext.Provider
            value={githubPullRequestUrl ? null : linkContext}
          >
            <Markdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={plugins}
              components={components}
              urlTransform={(url, key, node) => {
                if (node.tagName !== 'a' || key !== 'href')
                  return defaultUrlTransform(url);
                if (!githubPullRequestUrl) return url;
                if (!url || !URL.canParse(url, githubPullRequestUrl)) return '';
                return (
                  externalUrl(new URL(url, githubPullRequestUrl).href) ?? ''
                );
              }}
            >
              {markdown}
            </Markdown>
          </MessageLinkContext.Provider>
        </InlineAttachmentContext.Provider>
      )}
    </div>
  );
});
