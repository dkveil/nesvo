import { randomUUID } from 'node:crypto';
import type {
  AdoptConversationInput,
  ConversationImportCatalog,
  CreateSessionInput,
  ListConversationsInput,
  Provider,
  Session,
} from '@nesvo/contracts';
import type { ProviderProfiles } from '../providers/profiles';
import { resolveFolder } from '../workspace/folder';
import { scanConversations, type Transcript } from './conversation-transcripts';
import { SessionError, type SessionService } from './service';
import type { SessionOrigin, SessionStore } from './store';

export class ConversationImport {
  constructor(
    private readonly store: SessionStore,
    private readonly sessions: SessionService,
    private readonly signal: AbortSignal,
    private readonly profiles: ProviderProfiles,
  ) {}

  async list(
    input?: ListConversationsInput,
  ): Promise<ConversationImportCatalog> {
    const profileId = input?.profileId;
    const configDirectory =
      input?.provider &&
      (await this.profiles.directory(input.provider, profileId, this.signal));
    const providers: Provider[] = input?.provider
      ? [input.provider]
      : ['Claude Code', 'Codex'];
    const scans = await Promise.all(
      providers.map(provider =>
        scanConversations(provider, this.signal, undefined, configDirectory),
      ),
    );
    const include = input?.include;
    if (
      include &&
      !scans.some(scan =>
        scan.transcripts.some(
          ({ conversation }) =>
            conversation.provider === include.provider &&
            conversation.providerSessionId === include.providerSessionId,
        ),
      )
    ) {
      const target = await scanConversations(
        include.provider,
        this.signal,
        include.providerSessionId,
        configDirectory,
      );
      scans.push({
        ...target,
        transcripts: target.transcripts.map(transcript => ({
          ...transcript,
          messages: [],
        })),
        skippedFiles: 0,
      });
    }
    const recorded = new Map(
      this.store
        .providerConversations()
        .filter(row => row.profileId === (profileId ?? null))
        .map(row => [this.key(row.provider, row.providerSessionId), row]),
    );
    const conversations = scans
      .flatMap(scan => scan.transcripts)
      .flatMap(({ conversation }) => {
        const known = recorded.get(
          this.key(conversation.provider, conversation.providerSessionId),
        );
        if (known && !known.adopted) return [];
        return [{ ...conversation, adopted: known?.adopted ?? false }];
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const unique = new Map<
      string,
      ConversationImportCatalog['conversations'][number]
    >();
    for (const conversation of conversations) {
      const key = this.key(
        conversation.provider,
        conversation.providerSessionId,
      );
      if (!unique.has(key)) unique.set(key, conversation);
    }
    return {
      conversations: [...unique.values()],
      skippedFiles: scans.reduce((count, scan) => count + scan.skippedFiles, 0),
      truncated: scans.some(scan => scan.truncated),
    };
  }

  async adopt(input: AdoptConversationInput): Promise<Session> {
    const existing = this.previousAdoption(input);
    if (existing) return existing;
    const configDirectory = await this.profiles.directory(
      input.provider,
      input.profileId,
      this.signal,
    );
    const { transcripts } = await scanConversations(
      input.provider,
      this.signal,
      input.providerSessionId,
      configDirectory,
    );
    const transcript = transcripts[0];
    if (!transcript)
      throw new SessionError(
        'not-found',
        'The conversation is missing or could not be read. Refresh the conversation list and try again.',
      );
    const { conversation } = transcript;
    const directory = await resolveFolder(conversation.directory, this.signal);
    this.signal.throwIfAborted();
    const concurrent = this.previousAdoption(input);
    if (concurrent) return concurrent;
    return this.adoptTranscript(transcript, directory, {
      sessionId: input.requestId,
      profileId: input.profileId,
    });
  }

  adoptTranscript(
    { conversation, messages }: Transcript,
    directory: string,
    input: Pick<CreateSessionInput, 'profileId' | 'groupId'> &
      Partial<Pick<CreateSessionInput, 'title'>> &
      Pick<
        Extract<SessionOrigin, { kind: 'import' }>,
        'sessionId' | 'presentation' | 'writeRelated'
      >,
  ): Session {
    let runId = randomUUID();
    return this.sessions.adoptConversation(
      {
        provider: conversation.provider,
        profileId: input.profileId,
        groupId: input.groupId,
        title: input.title ?? conversation.title,
        model: 'default',
        mode: 'read-only',
        directory,
      },
      directory,
      {
        kind: 'import',
        sessionId: input.sessionId,
        providerSessionId: conversation.providerSessionId,
        presentation: input.presentation,
        writeRelated: input.writeRelated,
        messages: messages.map(message => {
          if (message.author === 'operator') runId = randomUUID();
          return {
            id: randomUUID(),
            runId,
            author: message.author,
            body: message.body,
            state: 'completed',
            origin: 'imported',
            createdAt: message.at,
            completedAt: message.at,
            model: null,
            effort: null,
            mode: null,
            usage: null,
            mcp: null,
          };
        }),
      },
    );
  }

  private previousAdoption(input: AdoptConversationInput): Session | undefined {
    const previous = this.store.get(input.requestId);
    if (previous) {
      if (
        previous.provider === input.provider &&
        (previous.profileId ?? null) === (input.profileId ?? null) &&
        previous.providerSessionId === input.providerSessionId &&
        previous.messages[0]?.origin === 'imported'
      )
        return previous;
      throw new SessionError(
        'invalid-request',
        'The import request ID is already in use.',
      );
    }
    const recorded = this.store
      .providerConversations()
      .find(
        row =>
          row.provider === input.provider &&
          row.profileId === (input.profileId ?? null) &&
          row.providerSessionId === input.providerSessionId,
      );
    if (recorded)
      throw new SessionError(
        'invalid-request',
        recorded.adopted
          ? 'This conversation has already been adopted into Nesvo.'
          : 'This conversation already belongs to a Nesvo session.',
      );
  }

  private key(provider: Provider, id: string) {
    return provider + ':' + id;
  }
}
