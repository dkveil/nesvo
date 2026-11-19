import { memo, useEffect, useRef, useState } from 'react';
import { attachmentKind, type MessageAttachment } from '@nesvo/contracts';
import { BookOpen } from 'lucide-react';
import { statusLabels, type Provider, type Session } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { MessageAttachments } from '@/features/attach-files/attachment-tray';
import { InlineAttachment } from '@/features/attach-files/inline-attachment';
import { CodeCommentCards } from '@/features/code-comments/code-comment-card';
import { Chip } from '@/shared/ui/chip';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Separator } from '@/shared/ui/separator';
import { StatusMessage } from '@/shared/ui/status-message';
import { isShownInText } from './attachment-markers';
import { ClampedPrompt } from './clamped-prompt';
import { CopyMessageButton } from './copy-message-button';
import { interruptionLabels } from './interruption-labels';
import { isLongPrompt } from './long-prompt';
import { MessageBody } from './message-body';
import {
  SessionActivity,
  type SessionActivityProps,
} from '@/widgets/session-activity';

type Message = Session['messages'][number];

const renderInlineAttachment = (attachment: MessageAttachment) => (
  <InlineAttachment attachment={attachment} />
);

const attachmentsKey = (message: Message) =>
  message.attachments?.map(item => `${item.id}@${item.offset ?? ''}`).join();

const codeCommentsKey = (message: Message) =>
  message.codeComments?.map(item => item.id).join();

type MessageArticleProps = {
  message: Message;
  provider: Provider;
  actor?: string;
  displayBody?: string;
  live: boolean;
  deferred: boolean;
  suppressBody: boolean;
  activity: SessionActivityProps | null;
  showInterruption: boolean;
  selectionChange: string | undefined;
  threadStart: boolean;
  compacted: boolean;
};

function sameRenderedMessage(previous: Message, next: Message) {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.author === next.author &&
      previous.origin === next.origin &&
      previous.body === next.body &&
      previous.state === next.state &&
      previous.completedAt === next.completedAt &&
      previous.costWarning === next.costWarning &&
      previous.usageWarning === next.usageWarning &&
      previous.skillId === next.skillId &&
      previous.skillHash === next.skillHash &&
      attachmentsKey(previous) === attachmentsKey(next) &&
      codeCommentsKey(previous) === codeCommentsKey(next) &&
      previous.interruption?.reason === next.interruption?.reason &&
      JSON.stringify(previous.skill) === JSON.stringify(next.skill))
  );
}

function sameActivity(
  left: SessionActivityProps | null,
  right: SessionActivityProps | null,
) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.runId === right.runId &&
      left.startedAt === right.startedAt &&
      left.completedAt === right.completedAt &&
      left.status === right.status &&
      left.live === right.live &&
      left.waiting === right.waiting &&
      left.offline === right.offline &&
      left.truncated === right.truncated &&
      (left.items === right.items ||
        (left.items.length === right.items.length &&
          left.items.every((item, index) => {
            const next = right.items[index]!;
            return (
              item === next ||
              (item.id === next.id &&
                item.status === next.status &&
                item.title === next.title &&
                item.kind === next.kind &&
                item.startedAt === next.startedAt &&
                item.completedAt === next.completedAt &&
                item.detail === next.detail &&
                item.output === next.output &&
                item.truncated === next.truncated &&
                item.paths.length === next.paths.length &&
                item.paths.every(
                  (path, pathIndex) => path === next.paths[pathIndex],
                ))
            );
          }))))
  );
}

function sameArticle(previous: MessageArticleProps, next: MessageArticleProps) {
  return (
    sameActivity(previous.activity, next.activity) &&
    previous.provider === next.provider &&
    previous.actor === next.actor &&
    previous.displayBody === next.displayBody &&
    previous.live === next.live &&
    previous.suppressBody === next.suppressBody &&
    previous.deferred === next.deferred &&
    previous.showInterruption === next.showInterruption &&
    previous.selectionChange === next.selectionChange &&
    previous.threadStart === next.threadStart &&
    previous.compacted === next.compacted &&
    sameRenderedMessage(previous.message, next.message)
  );
}

export const MessageArticle = memo(function MessageArticle({
  message,
  provider,
  actor,
  displayBody,
  live,
  deferred,
  suppressBody,
  activity,
  showInterruption,
  selectionChange,
  threadStart,
  compacted,
}: MessageArticleProps) {
  const article = useRef<HTMLElement>(null);
  const [visited, setVisited] = useState(!deferred);
  useEffect(() => {
    if (!deferred || visited || !article.current) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisited(true);
          observer.disconnect();
        }
      },
      {
        root: article.current.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: '300px 0px',
      },
    );
    observer.observe(article.current);
    return () => observer.disconnect();
  }, [deferred, visited]);
  const visibleContent = !deferred || visited;
  const stripAttachments = (message.attachments ?? []).filter(
    attachment =>
      attachmentKind(attachment.mediaType) === 'image' ||
      !isShownInText(message.body, attachment),
  );
  return (
    <>
      {compacted && <Separator label="Conversation compacted" />}
      {threadStart && <Separator label="Session restarted" />}
      {selectionChange && (
        <Separator
          label={selectionChange}
          className="text-xs font-medium text-foreground"
        />
      )}
      <article
        ref={article}
        id={`message-${message.id}`}
        data-message-id={message.id}
        aria-label={actor ?? (message.author === 'operator' ? 'You' : provider)}
        data-author={message.author}
        aria-busy={live || undefined}
        className={cn(
          'group space-y-2 rounded-control',
          message.author === 'operator' && 'flex flex-col items-end',
          deferred && 'content-visibility-auto',
        )}
      >
        {visibleContent ? (
          <>
            <div className="flex max-w-full items-center gap-2 text-xs empty:hidden">
              {actor && (
                <span className="text-muted-foreground">
                  {actor}
                  {message.steering ? ' · Steered' : ''}
                </span>
              )}
              {message.author === 'operator' &&
                (message.skill || message.skillId) && (
                  <Chip
                    interactive={false}
                    size="sm"
                    icon={<BookOpen aria-hidden="true" />}
                    aria-label={
                      message.skill
                        ? `Requested skill: ${message.skill.name}`
                        : 'Unresolved skill request'
                    }
                    title={
                      message.skill
                        ? [
                            `${message.skill.source} · ${message.skill.path}`,
                            message.skill.origins?.join(', '),
                            message.skill.delivery === 'instructions'
                              ? 'Shared instructions · static snapshot for this message'
                              : message.skill.delivery === 'native'
                                ? 'Native skill'
                                : '',
                            message.skill.contentHash
                              ? `SHA-256: ${message.skill.contentHash}`
                              : message.skillHash
                                ? `SHA-256: ${message.skillHash}`
                                : '',
                          ]
                            .filter(Boolean)
                            .join('\n')
                        : 'A skill was requested, but its source was not resolved.'
                    }
                    className="max-w-[70%] bg-highlight"
                  >
                    <span>{message.skill?.name ?? 'Requested skill'}</span>
                    {message.skill?.delivery === 'instructions' && (
                      <span>Shared instructions</span>
                    )}
                  </Chip>
                )}
              {message.author === 'agent' &&
                message.state !== 'completed' &&
                !activity && (
                  <Chip interactive={false} size="sm">
                    <span>{statusLabels[message.state]}</span>
                  </Chip>
                )}
            </div>
            {message.costWarning && (
              <InlineNotice className="bg-accent">
                {message.costWarning}
              </InlineNotice>
            )}
            {activity && <SessionActivity {...activity} />}
            {message.usageWarning && (
              <InlineNotice tone="warning">{message.usageWarning}</InlineNotice>
            )}
            {message.author === 'operator' && !!stripAttachments.length && (
              <MessageAttachments attachments={stripAttachments} />
            )}
            {!suppressBody &&
              (message.body ||
                (message.author === 'operator' &&
                  stripAttachments.length > 0)) &&
              (message.author === 'operator' ? (
                isLongPrompt(message.body) ? (
                  <ClampedPrompt>
                    <MessageBody
                      body={displayBody ?? message.body}
                      attachments={message.attachments}
                      renderAttachment={renderInlineAttachment}
                      className="rounded-composer bg-message-surface px-3.5 py-2 text-ui leading-relaxed"
                    />
                  </ClampedPrompt>
                ) : (
                  <MessageBody
                    body={displayBody ?? message.body}
                    attachments={message.attachments}
                    renderAttachment={renderInlineAttachment}
                    className="max-w-[85%] rounded-composer bg-message-surface px-3.5 py-2 text-ui leading-relaxed"
                  />
                )
              ) : (
                <MessageBody
                  body={displayBody ?? message.body}
                  streaming={live}
                  className="w-full text-ui leading-relaxed"
                />
              ))}
            {message.author === 'operator' &&
              !!message.codeComments?.length && (
                <CodeCommentCards comments={message.codeComments} />
              )}
            {!suppressBody &&
              message.author === 'agent' &&
              !live &&
              message.body && (
                <div className="flex items-center opacity-0 transition-opacity duration-base ease-out group-hover:opacity-100 focus-within:opacity-100">
                  <CopyMessageButton body={displayBody ?? message.body} />
                </div>
              )}
            {message.interruption && showInterruption && (
              <StatusMessage tone="warning">
                {interruptionLabels[message.interruption.reason]}
              </StatusMessage>
            )}
          </>
        ) : (
          <div aria-hidden="true" className="h-32" />
        )}
      </article>
    </>
  );
}, sameArticle);
