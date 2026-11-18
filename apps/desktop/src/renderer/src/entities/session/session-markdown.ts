import type { DesktopSession } from '@nesvo/contracts';

const MAX_FILE_STEM_LENGTH = 80;

const timeFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTime(value: string) {
  return timeFormat.format(new Date(value));
}

export function sessionMarkdownFileName(session: DesktopSession) {
  const stem = session.title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_FILE_STEM_LENGTH)
    .trim();
  return `${stem || 'Session'}.md`;
}

export function sessionMarkdown(
  session: DesktopSession,
  exportedAt = new Date(),
) {
  const details = [
    `- Provider: ${session.provider}`,
    `- Model: ${session.actualModel ?? session.model}`,
    ...(session.directory ? [`- Folder: \`${session.directory}\``] : []),
    `- Started: ${formatTime(session.createdAt)}`,
    `- Exported: ${formatTime(exportedAt.toISOString())}`,
  ];
  const messages = session.messages.map(message =>
    [
      `## ${message.author === 'operator' ? 'You' : session.provider} · ${formatTime(message.createdAt)}`,
      '',
      message.body.trim() || '_No text._',
    ].join('\n'),
  );
  return `${[`# ${session.title || 'Session'}`, details.join('\n'), ...messages].join('\n\n')}\n`;
}
