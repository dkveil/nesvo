import { memo, type ReactNode } from 'react';
import type { MessageAttachment } from '@nesvo/contracts';
import { BookOpen } from 'lucide-react';
import { statusLabels, type Provider, type Session } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { MessageAttachments } from '@/features/attach-images/attachment-tray';
import { InlineAttachment } from '@/features/attach-images/inline-attachment';
import { Chip } from '@/shared/ui/chip';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Separator } from '@/shared/ui/separator';
import { StatusMessage } from '@/shared/ui/status-message';
import { ClampedPrompt } from './clamped-prompt';
import { CopyMessageButton } from './copy-message-button';
import { interruptionLabels } from './interruption-labels';
import { isLongPrompt } from './long-prompt';
import { MessageBody } from './message-body';

type Message = Session['messages'][number];

const renderInlineAttachment = (attachment: MessageAttachment) => (
  <InlineAttachment attachment={attachment} />
);

const attachmentsKey = (message: Message) =>
  message.attachments?.map(item => `${item.id}@${item.offset ?? ''}`).join();

type MessageArticleProps = {
  message: Message;
  provider: Provider;
  live: boolean;
  deferred: boolean;
  showActivity: boolean;
  activity: ReactNode;
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
      previous.skillId === next.skillId &&
      previous.skillHash === next.skillHash &&
      attachmentsKey(previous) === attachmentsKey(next) &&
      previous.interruption?.reason === next.interruption?.reason &&
      JSON.stringify(previous.skill) === JSON.stringify(next.skill))
  );
}

function sameArticle(previous: MessageArticleProps, next: MessageArticleProps) {
  return (
    !previous.showActivity &&
    !next.showActivity &&
    previous.provider === next.provider &&
    previous.live === next.live &&
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
  live,
  deferred,
  showActivity,
  activity,
  showInterruption,
  selectionChange,
  threadStart,
  compacted,
}: MessageArticleProps) {
  return (
    <>
      {compacted && <Separator label="Conversation compacted" />}
      {threadStart && <Separator label="Session restarted" />}
      {selectionChange && <Separator label={selectionChange} />}
      <article
        id={`message-${message.id}`}
        data-message-id={message.id}
        aria-label={message.author === 'operator' ? 'You' : provider}
        data-author={message.author}
        aria-busy={live || undefined}
        className={cn(
          'group space-y-2 rounded-control',
          message.author === 'operator' && 'flex flex-col items-end',
          deferred && 'content-visibility-auto',
        )}
      >
        <div className="flex max-w-full items-center gap-2 text-xs empty:hidden">
          {message.origin === 'imported' && (
            <Chip interactive={false} size="sm">
              Imported
            </Chip>
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
            !showActivity && (
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
        {showActivity && activity}
        {message.author === 'operator' && !!message.attachments?.length && (
          <MessageAttachments attachments={message.attachments} />
        )}
        {(message.body || !live) &&
          (message.author === 'operator' ? (
            isLongPrompt(message.body) ? (
              <ClampedPrompt>
                <MessageBody
                  body={message.body}
                  attachments={message.attachments}
                  renderAttachment={renderInlineAttachment}
                  className="rounded-composer bg-message-surface px-3.5 py-2 text-ui leading-relaxed"
                />
              </ClampedPrompt>
            ) : (
              <MessageBody
                body={message.body || 'No response text.'}
                attachments={message.attachments}
                renderAttachment={renderInlineAttachment}
                className="max-w-[85%] rounded-composer bg-message-surface px-3.5 py-2 text-ui leading-relaxed"
              />
            )
          ) : (
            <MessageBody
              body={message.body || 'No response text.'}
              className="w-full text-ui leading-relaxed"
            />
          ))}
        {message.author === 'agent' && !live && message.body && (
          <div className="flex items-center opacity-0 transition-opacity duration-base ease-out group-hover:opacity-100 focus-within:opacity-100">
            <CopyMessageButton body={message.body} />
          </div>
        )}
        {message.interruption && showInterruption && (
          <StatusMessage tone="warning">
            {interruptionLabels[message.interruption.reason]}
          </StatusMessage>
        )}
      </article>
    </>
  );
}, sameArticle);
