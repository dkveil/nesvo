import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type {
  DesktopApi,
  Session,
  SkillCatalog,
  SkillEntry,
} from '@nesvo/contracts';
import { BookOpen, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';

type Props = {
  session: Session;
  api: Pick<DesktopApi, 'discoverSkills'>;
  onClose: () => void;
};

const sourceLabels: Record<SkillEntry['source'], string> = {
  project: 'Project',
  user: 'Personal',
  system: 'Built-in',
  managed: 'Managed',
  plugin: 'Plugin',
  unknown: 'Unknown source',
};

const declaredValue = (value: boolean | null) =>
  value === null ? 'Not reported' : value ? 'Yes' : 'No';

function SkillRow({ skill }: { skill: SkillEntry }) {
  return (
    <details
      data-skill-id={skill.id}
      className="group border-b border-border/60"
    >
      <summary
        aria-label={`Details for ${skill.name}`}
        className="flex cursor-pointer list-none gap-2 px-4 py-3 outline-none hover:bg-white/3 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">
              {skill.name}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {sourceLabels[skill.source]}
            </span>
          </div>
          {skill.description && (
            <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {skill.description}
            </p>
          )}
          {skill.enabled === false && (
            <p className="mt-1 text-[10px] text-muted-foreground">Disabled</p>
          )}
        </div>
      </summary>
      <div className="space-y-3 px-4 pb-4 pl-9 text-[11px] leading-5 text-muted-foreground">
        {skill.description && (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {skill.description}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt>Status</dt>
          <dd>
            {skill.enabled === null
              ? 'Detected on disk'
              : skill.enabled
                ? 'Enabled in provider'
                : 'Disabled'}
          </dd>
          <dt>Format</dt>
          <dd>{skill.kind === 'skill' ? 'Skill' : 'Command'}</dd>
          <dt>User invocation</dt>
          <dd>{declaredValue(skill.userInvocable)}</dd>
          <dt>Model invocation</dt>
          <dd>{declaredValue(skill.modelInvocable)}</dd>
        </dl>
        {skill.path && (
          <div>
            <p className="mb-1">Source file</p>
            <p className="font-mono text-[10px] [overflow-wrap:anywhere]">
              {skill.path}
            </p>
          </div>
        )}
        {skill.detail && (
          <p className="[overflow-wrap:anywhere]">{skill.detail}</p>
        )}
      </div>
    </details>
  );
}

function Catalog({
  session,
  api,
  onClose,
  onRefresh,
}: Props & { onRefresh: () => void }) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{
    catalog?: SkillCatalog;
    error?: string;
  }>({});
  const search = useRef<HTMLInputElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    let current = true;
    void api.discoverSkills({ sessionId: session.id }).then(
      catalog => {
        if (!current) return;
        setState(
          catalog.sessionId === session.id &&
            catalog.provider === session.provider
            ? { catalog }
            : {
                error:
                  'The skill catalog does not match this session. Refresh to try again.',
              },
        );
      },
      error => {
        if (current) setState({ error: errorDetail(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, session.id, session.provider]);
  useEffect(() => {
    search.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(
          event.target instanceof Element &&
          event.target.closest('[role="dialog"]')
        )
      ) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const { catalog, error } = state;
  const loading = !catalog && !error;
  const term = query.trim().toLowerCase();
  const skills =
    catalog?.skills.filter(skill =>
      [
        skill.name,
        skill.description,
        skill.path,
        sourceLabels[skill.source],
      ].some(value => value?.toLowerCase().includes(term)),
    ) ?? [];
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <BookOpen className="size-4 text-muted-foreground" />
        <h2 className="text-xs font-medium">Skills</h2>
        <span className="text-[11px] text-muted-foreground">
          {session.provider}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label="Refresh skills"
          title="Refresh skills"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close skills"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="relative m-3 shrink-0">
        <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
        <Input
          ref={search}
          type="search"
          aria-label="Search skills"
          placeholder="Search skills"
          maxLength={200}
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="h-8 border-transparent pl-7 text-xs shadow-none"
        />
      </div>
      {catalog && (
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-3 text-[10px] text-muted-foreground">
          <span>
            {term
              ? `${skills.length} of ${catalog.skills.length}`
              : catalog.skills.length}{' '}
            skills
          </span>
          <span>
            {catalog.method === 'native'
              ? 'Provider catalog'
              : 'Local skill files'}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <p role="status" className="p-4 text-xs text-muted-foreground">
            Discovering skills…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="p-4 text-xs text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
        {catalog && skills.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">
            {term
              ? 'No matching skills'
              : catalog.status === 'unsupported'
                ? 'Skill discovery is not supported by this provider version.'
                : catalog.status === 'unavailable'
                  ? 'Skill discovery is unavailable.'
                  : 'No skills found in the checked sources.'}
          </p>
        )}
        {skills.map(skill => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
        {catalog && (catalog.issues.length > 0 || catalog.truncated) && (
          <details className="border-t px-4 py-3 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">
              {catalog.status === 'unavailable' ||
              catalog.status === 'unsupported'
                ? 'Discovery details'
                : 'Some sources could not be verified'}
            </summary>
            <ul className="mt-3 space-y-3 leading-5">
              {catalog.issues.map((issue, index) => (
                <li key={index} className="[overflow-wrap:anywhere]">
                  <p>{issue.message}</p>
                  {issue.path && (
                    <p className="mt-1 font-mono text-[10px]">{issue.path}</p>
                  )}
                </li>
              ))}
              {catalog.truncated && (
                <li>
                  The catalog is limited. Some entries or metadata were omitted.
                </li>
              )}
            </ul>
          </details>
        )}
      </div>
      <footer className="shrink-0 border-t px-4 py-3 text-[10px] leading-4 text-muted-foreground">
        {catalog?.method === 'filesystem'
          ? 'File metadata only. Provider availability is not verified. '
          : ''}
        Discovery only. Skill invocation is not connected yet.
      </footer>
    </>
  );
}

export default function SessionSkills(props: Props) {
  const [refresh, setRefresh] = useState(0);
  return (
    <section
      aria-label="Session skills"
      data-session-id={props.session.id}
      className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col border-l bg-[#090909] min-[1200px]:relative min-[1200px]:inset-auto min-[1200px]:w-[380px] min-[1200px]:shrink-0 min-[1600px]:w-[440px]"
    >
      <Catalog
        key={`${props.session.id}:${refresh}`}
        {...props}
        onRefresh={() => setRefresh(value => value + 1)}
      />
    </section>
  );
}
