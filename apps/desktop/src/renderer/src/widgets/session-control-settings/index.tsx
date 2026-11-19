import { useEffect, useState } from 'react';
import type {
  Computer,
  CoordinatorPolicy,
  DesktopApi,
  Provider,
  SessionMode,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Checkbox } from '@/shared/ui/checkbox';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

type SessionControlSettingsProps = {
  computer: Computer | undefined;
  api: Pick<
    DesktopApi,
    'readSessionControlPolicy' | 'saveSessionControlPolicy'
  >;
};

const PROVIDERS: Provider[] = ['Claude Code', 'Codex'];
const CHILD_MODES: { mode: SessionMode; label: string }[] = [
  { mode: 'read-only', label: 'Plan / Read-only' },
  { mode: 'accept-edits', label: 'Accept edits' },
  { mode: 'supervised', label: 'Workspace edits' },
  { mode: 'auto', label: 'Auto' },
];

const unavailableReason = (computer: Computer | undefined) => {
  if (!computer) return 'Choose a computer.';
  if (computer.status !== 'connected')
    return `${computer.name} is offline. Connect it to change session control.`;
  if (!computer.capabilities.includes('session-control'))
    return 'Update this computer’s Nesvo host and reconnect to let sessions coordinate other sessions.';
  return '';
};

const toggled = <T,>(values: T[], value: T, on: boolean) =>
  on ? [...new Set([...values, value])] : values.filter(item => item !== value);

const parseModels = (text: string) =>
  text
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);

export function SessionControlSettings({
  computer,
  api,
}: SessionControlSettingsProps) {
  const unavailable = unavailableReason(computer);
  const hostId = computer?.id ?? 'local';
  const [policy, setPolicy] = useState<CoordinatorPolicy | null>(null);
  const [models, setModels] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (unavailable) return;
    let current = true;
    api.readSessionControlPolicy(hostId).then(
      loaded => {
        if (!current) return;
        setPolicy(loaded);
        setModels(loaded.models.join(', '));
      },
      failure => {
        if (current) setError(errorDetail(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [api, hostId, unavailable]);
  if (unavailable) return <InlineNotice>{unavailable}</InlineNotice>;
  if (!policy)
    return error ? (
      <StatusMessage tone="error">{error}</StatusMessage>
    ) : (
      <SkeletonList label="Loading session control" rows={3} />
    );
  const save = async (next: CoordinatorPolicy) => {
    const previous = policy;
    setPolicy(next);
    setPending(true);
    setError('');
    try {
      const saved = await api.saveSessionControlPolicy(next, hostId);
      setPolicy(saved);
      setModels(saved.models.join(', '));
    } catch (failure) {
      setPolicy(previous);
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  const locked = pending || !policy.enabled;
  const workersAvailable = computer?.capabilities.includes(
    'coordinator-workers',
  );
  return (
    <div className="space-y-6">
      <p className="text-xs leading-5 text-muted-foreground">
        A top-level session on {computer?.name ?? 'this computer'} can create,
        message, wait for and stop its own child sessions through Nesvo tools.
        Merging, budgets, operation approvals and worker approvals always stay
        with you.
      </p>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      <SettingsSection title="Coordinating sessions">
        <SettingsRow
          title={
            <label htmlFor="session-control-enabled">
              Let sessions coordinate sessions
            </label>
          }
          description="New Codex sessions get the tools when they start. Claude Code sessions get them on every turn."
        >
          <Switch
            id="session-control-enabled"
            checked={policy.enabled}
            disabled={pending}
            onCheckedChange={enabled => void save({ ...policy, enabled })}
          />
        </SettingsRow>
        {workersAvailable && (
          <>
            <SettingsRow
              title={
                <label htmlFor="coordinator-group-size">
                  Maximum group size
                </label>
              }
              description="Includes the coordinator and its active workers."
            >
              <Input
                key={policy.groupSize}
                id="coordinator-group-size"
                type="number"
                min={2}
                max={8}
                step={1}
                className="w-20"
                defaultValue={policy.groupSize}
                disabled={pending}
                onBlur={event => {
                  const size = event.target.valueAsNumber;
                  if (!Number.isInteger(size) || size < 2 || size > 8) {
                    event.target.value = String(policy.groupSize);
                  } else if (size !== policy.groupSize) {
                    void save({ ...policy, groupSize: size });
                  }
                }}
              />
            </SettingsRow>
            <SettingsRow
              title={
                <label htmlFor="coordinator-nested">
                  One level of subdelegation
                </label>
              }
              description="Allow a direct child to coordinate workers within the same group limit."
            >
              <Switch
                id="coordinator-nested"
                checked={policy.nested}
                disabled={locked}
                onCheckedChange={nested => void save({ ...policy, nested })}
              />
            </SettingsRow>
          </>
        )}
        <SettingsRow
          title="Providers"
          description="Child sessions can use these providers."
        >
          <div className="flex flex-wrap justify-end gap-3">
            {PROVIDERS.map(provider => (
              <Label key={provider} className="flex items-center gap-2">
                <Checkbox
                  checked={policy.providers.includes(provider)}
                  disabled={locked}
                  onCheckedChange={value =>
                    void save({
                      ...policy,
                      providers: toggled(
                        policy.providers,
                        provider,
                        value === true,
                      ),
                    })
                  }
                />
                {provider}
              </Label>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="session-control-models">Models</label>}
          description="Comma-separated model IDs. Leave empty to allow every model."
        >
          <Input
            id="session-control-models"
            className="w-56"
            value={models}
            disabled={locked}
            placeholder="Any model"
            onChange={event => setModels(event.target.value)}
            onBlur={() => {
              const next = parseModels(models);
              if (next.join(',') !== policy.models.join(','))
                void save({ ...policy, models: next });
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="Child permission modes"
          description="The most a coordinating session can give a child. It can never turn on permission bypass."
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {CHILD_MODES.map(({ mode, label }) => (
              <Label key={mode} className="flex items-center gap-2">
                <Checkbox
                  checked={policy.childModes.includes(mode)}
                  disabled={locked}
                  onCheckedChange={value =>
                    void save({
                      ...policy,
                      childModes: toggled(
                        policy.childModes,
                        mode,
                        value === true,
                      ),
                    })
                  }
                />
                {label}
              </Label>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          title={
            <label htmlFor="session-control-worktrees">Create worktrees</label>
          }
          description="Let a coordinating session start children in new Git worktrees."
        >
          <Switch
            id="session-control-worktrees"
            checked={policy.worktrees}
            disabled={locked}
            onCheckedChange={worktrees => void save({ ...policy, worktrees })}
          />
        </SettingsRow>
        <SettingsRow
          title={
            <label htmlFor="session-control-browser">Browser access</label>
          }
          description="Let a coordinating session start children that can open pages in your browser."
        >
          <Switch
            id="session-control-browser"
            checked={policy.browser}
            disabled={locked}
            onCheckedChange={browser => void save({ ...policy, browser })}
          />
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="session-control-plans">Decide plans</label>}
          description="Let a coordinating session accept, correct or decline the plans of its plan-first children."
        >
          <Switch
            id="session-control-plans"
            checked={policy.acceptPlans}
            disabled={locked}
            onCheckedChange={acceptPlans =>
              void save({ ...policy, acceptPlans })
            }
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
