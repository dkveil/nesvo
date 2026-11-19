import { useEffect, useId, useState } from 'react';
import type {
  Computer,
  SetupProfileInput,
  SetupProfileFragment,
  SetupProfileReview,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { PathInput } from '@/shared/ui/path-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import { PanelBody } from '@/shared/ui/panel';
import { Textarea } from '@/shared/ui/textarea';
import {
  SidePanel,
  SidePanelFooter,
  SidePanelHeader,
} from '@/shared/ui/side-panel';

const routeLabels = {
  inbox: 'Inbox',
  parent: 'Parent session',
  both: 'Inbox and parent session',
} as const;
const profileStates: Record<SetupProfileReview['status'], string> = {
  absent: 'No profile found',
  candidate: 'Profile ready to review',
  current: 'Active profile',
  changed: 'Profile file changed',
  invalid: 'Profile contains errors',
  unsupported: 'Unsupported profile version',
};

export function SetupProfileSettings({
  computer,
  openHistory,
  initialEdit = false,
  onboarding = false,
  saveOnly = false,
}: {
  computer?: Computer;
  openHistory?: () => void;
  initialEdit?: boolean;
  onboarding?: boolean;
  saveOnly?: boolean;
}) {
  const hostId = computer?.id;
  const connected = computer?.status === 'connected';
  const supported = computer?.capabilities.includes('setup-profile-v1');
  const [review, setReview] = useState<SetupProfileReview>();
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const [skip, setSkip] = useState(false);
  const [saving, setSaving] = useState(false);
  const [destinationFile, setDestinationFile] = useState('');
  const [editing, setEditing] = useState(false);
  const [fragment, setFragment] = useState<SetupProfileFragment>();
  const [fragmentText, setFragmentText] = useState('');
  const [route, setRoute] = useState<keyof typeof routeLabels>('inbox');
  const [layer, setLayer] = useState<'machine' | 'shared'>('machine');
  const id = useId();

  useEffect(() => {
    if (!hostId || !connected || !supported) return;
    let active = true;
    void window.nesvo.setupProfile({ action: 'inspect' }, hostId).then(
      result => {
        if (!active) return;
        if (!result.ok) return setError(result.message);
        setReview(result.review);
        if (
          initialEdit &&
          result.review.status === 'current' &&
          result.review.routing.managed
        ) {
          setRoute(result.review.routing.effective);
          setEditing(true);
        }
      },
      issue => active && setError(errorDetail(issue)),
    );
    return () => {
      active = false;
    };
  }, [hostId, connected, supported, initialEdit]);

  const request = async (input: SetupProfileInput) => {
    if (!hostId || !connected || !supported || busy) return;
    setError('');
    setBusy(true);
    try {
      const result = await window.nesvo.setupProfile(input, hostId);
      if (!result.ok) throw new Error(result.message);
      setReview(result.review);
      if (result.fragment) {
        setFragment(result.fragment);
        setFragmentText(result.fragment.text);
      }
      if (result.receipt?.status === 'inspection-required')
        throw new Error('Inspect the profile edit in Change history.');
      if (result.receipt?.status === 'conflicted')
        throw new Error('The profile changed. Refresh the preview.');
      if (input.action === 'edit-routing') setEditing(false);
      if (input.action === 'save-as') setSaving(false);
      if (input.action === 'apply') setDetails(false);
      if (input.action === 'edit-fragment') setFragment(undefined);
    } catch (issue) {
      setError(errorDetail(issue));
    } finally {
      setBusy(false);
    }
  };

  if (!connected || !supported)
    return (
      <StatusMessage>
        {connected
          ? `Update the Nesvo host on ${computer.name} to view its setup.`
          : 'Connect to this computer to view its setup.'}
      </StatusMessage>
    );
  if (onboarding && skip)
    return (
      <SettingsSection title="Profile">
        <SettingsRow title="Profile skipped">
          <Button size="sm" variant="ghost" onClick={() => setSkip(false)}>
            Show profile
          </Button>
        </SettingsRow>
      </SettingsSection>
    );
  const ready = review?.status === 'candidate' || review?.status === 'changed';
  const pending =
    review?.declarations.filter(item => item.state === 'pending').length ?? 0;
  const shared = review?.files.find(item => item.layer === 'shared');
  const destination =
    layer === 'shared' ? shared?.path : review?.routing.writesTo;
  const openSave = () => {
    setError('');
    setDestinationFile(review?.status === 'absent' ? review.path : '');
    setSaving(true);
  };
  const openFragment = (layer: NonNullable<typeof fragment>['layer']) => {
    if (!review?.instanceId || !review.revision) return;
    setDetails(false);
    void request({
      action: 'inspect-fragment',
      instanceId: review.instanceId,
      revision: review.revision,
      layer,
    });
  };
  return (
    <div className="relative flex min-w-0 gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        {saveOnly ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!review || busy}
            onClick={openSave}
          >
            Save as profile
          </Button>
        ) : (
          <SettingsSection
            title="Profile"
            action={
              review && !onboarding ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openSave}
                  disabled={busy}
                >
                  Save as profile
                </Button>
              ) : undefined
            }
          >
            {error && !editing && (
              <StatusMessage tone="error">{error}</StatusMessage>
            )}
            {!review && !error && (
              <StatusMessage tone="loading">Checking profile…</StatusMessage>
            )}
            {review && (
              <>
                <SettingsRow
                  title={profileStates[review.status]}
                  description={<MiddleTruncatedText path value={review.path} />}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void request({
                        action: 'inspect',
                        file: file.trim() || undefined,
                      })
                    }
                  >
                    Refresh
                  </Button>
                </SettingsRow>
                {review.issues.map((issue, index) => (
                  <SettingsRow
                    key={issue.file + index}
                    title={issue.field || 'Profile file'}
                    description={issue.reason}
                  />
                ))}
                {(ready || review.routing.managed) && (
                  <SettingsRow
                    title="Default Inbox route"
                    description={
                      ready && review.routing.desired
                        ? `${routeLabels[review.routing.effective]} → ${routeLabels[review.routing.desired]}`
                        : `From profile · ${routeLabels[review.routing.effective]}`
                    }
                  >
                    {review.status === 'current' && review.routing.managed && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRoute(review.routing.effective);
                          setLayer('machine');
                          setEditing(true);
                        }}
                      >
                        Edit profile setting
                      </Button>
                    )}
                  </SettingsRow>
                )}
                {review.files.length > 0 && (
                  <SettingsRow
                    title={
                      pending
                        ? `${pending} awaiting local review`
                        : 'Source files'
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDetails(true)}
                    >
                      Review sources
                    </Button>
                  </SettingsRow>
                )}
                {review.status === 'current' &&
                  computer.capabilities.includes('setup-profile-values-v1') && (
                    <SettingsRow
                      title="Profile settings"
                      description="Change a YAML layer on this computer."
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          openFragment(
                            review.files.some(file => file.layer === 'machine')
                              ? 'machine'
                              : 'entry',
                          )
                        }
                      >
                        Edit profile values
                      </Button>
                    </SettingsRow>
                  )}
                {ready && review.revision && (
                  <div className="flex flex-wrap gap-2 px-3 py-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setDetails(true)}
                    >
                      Load profile
                    </Button>
                    {onboarding && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setSkip(true)}
                      >
                        Skip profile
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
            {!onboarding && (
              <div className="flex items-end gap-2 px-3 pt-2">
                <Field
                  id={id}
                  label="Another profile on this computer"
                  className="min-w-0 flex-1"
                >
                  <PathInput
                    id={id}
                    value={file}
                    onChange={event => setFile(event.target.value)}
                  />
                </Field>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!file.trim() || busy}
                  onClick={() =>
                    void request({ action: 'inspect', file: file.trim() })
                  }
                >
                  Preview
                </Button>
              </div>
            )}
          </SettingsSection>
        )}
        {openHistory && (
          <Button variant="ghost" size="sm" onClick={openHistory}>
            Open Change history
          </Button>
        )}
      </div>
      {details && review && (
        <SidePanel
          kind="details"
          title="Profile sources"
          resizeLabel="Resize profile sources"
          onEscape={() => setDetails(false)}
          focusOnOpen
        >
          <SidePanelHeader
            titleBar={false}
            title={ready ? 'Review profile changes' : 'Profile sources'}
            onClose={() => setDetails(false)}
            closeLabel="Close profile sources"
          />
          <PanelBody className="space-y-3 p-3">
            {ready && (
              <SettingsSection title="Effective settings">
                <SettingsRow
                  title="Default Inbox route"
                  description={
                    <>
                      <p>Current · {routeLabels[review.routing.effective]}</p>
                      <p>
                        Profile ·{' '}
                        {review.routing.desired
                          ? routeLabels[review.routing.desired]
                          : 'Undeclared'}
                      </p>
                      <p>Detected · No suggested route</p>
                    </>
                  }
                />
                {review.changes
                  ?.filter(
                    change =>
                      change.effect !== 'keep' &&
                      change.key !== 'inbox.defaultRoute',
                  )
                  .map(change => (
                    <SettingsRow
                      key={change.key}
                      title={change.label}
                      description={`${change.before ?? 'Undeclared'} → ${change.after ?? 'Removed'}`}
                    />
                  ))}
              </SettingsSection>
            )}
            {review.files.map(item => (
              <SettingsRow
                key={item.layer}
                title={item.layer}
                description={<MiddleTruncatedText path value={item.path} />}
              />
            ))}
            {review.declarations.map(item => (
              <SettingsRow
                key={item.key}
                title={item.label}
                description={
                  item.state === 'pending'
                    ? 'Awaiting review on this computer'
                    : item.state === 'reviewed'
                      ? 'Reviewed on this computer'
                      : item.state === 'masked'
                        ? 'Disabled by profile'
                        : (item.preview ?? item.field)
                }
              />
            ))}
          </PanelBody>
          {ready && review.revision && (
            <SidePanelFooter label="Profile review actions">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (!review.revision) return;
                  void request({
                    action: 'apply',
                    file: review.path,
                    instanceId: review.instanceId,
                    revision: review.revision,
                    effectiveRevision: review.effectiveRevision,
                    actionId: crypto.randomUUID(),
                  });
                }}
              >
                Apply profile
              </Button>
            </SidePanelFooter>
          )}
        </SidePanel>
      )}
      {fragment && review && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open && !busy) setFragment(undefined);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit profile values</DialogTitle>
              <DialogDescription>
                Executable definitions still require separate local approval.
              </DialogDescription>
            </DialogHeader>
            <Field id={id + '-fragment-layer'} label="Profile layer">
              <Select
                value={fragment.layer}
                onValueChange={value => {
                  const requested = review.files.find(
                    file => file.layer === value,
                  );
                  if (requested) openFragment(requested.layer);
                }}
              >
                <SelectTrigger id={id + '-fragment-layer'} disabled={busy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {review.files.map(file => (
                    <SelectItem key={file.layer} value={file.layer}>
                      {file.layer}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <MiddleTruncatedText
              path
              value={fragment.path}
              className="text-xs text-muted-foreground"
            />
            <Field id={id + '-fragment-text'} label="Profile YAML">
              <Textarea
                id={id + '-fragment-text'}
                resize="none"
                rows={10}
                value={fragmentText}
                onChange={event => setFragmentText(event.target.value)}
                disabled={busy}
                className="font-mono"
              />
            </Field>
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
            <DialogFooter>
              <DialogCancel
                disabled={busy}
                onClick={() => setFragment(undefined)}
              >
                Cancel
              </DialogCancel>
              <Button
                disabled={
                  busy || !fragmentText.trim() || fragmentText === fragment.text
                }
                onClick={() => {
                  if (!review.instanceId || !review.revision) return;
                  void request({
                    action: 'edit-fragment',
                    instanceId: review.instanceId,
                    revision: review.revision,
                    effectiveRevision: review.effectiveRevision,
                    layer: fragment.layer,
                    text: fragmentText,
                    actionId: crypto.randomUUID(),
                  });
                }}
              >
                Save profile fragment
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {editing && review && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open && !busy) setEditing(false);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit profile setting</DialogTitle>
              <DialogDescription>
                Default Inbox route on {computer.name}
              </DialogDescription>
            </DialogHeader>
            <Field id={id + '-route'} label="Default Inbox route">
              <Select
                value={route}
                onValueChange={value =>
                  setRoute(value as keyof typeof routeLabels)
                }
              >
                <SelectTrigger id={id + '-route'}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(routeLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {shared && (
              <Field id={id + '-layer'} label="Write to">
                <Select
                  value={layer}
                  onValueChange={value =>
                    setLayer(value as 'machine' | 'shared')
                  }
                >
                  <SelectTrigger id={id + '-layer'}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="machine">
                      This computer’s layer
                    </SelectItem>
                    <SelectItem value="shared">Shared fragment</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {destination && (
              <MiddleTruncatedText
                path
                value={destination}
                className="text-xs text-muted-foreground"
              />
            )}
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
            <DialogFooter>
              <DialogCancel disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </DialogCancel>
              <Button
                disabled={
                  busy || route === review.routing.effective || !destination
                }
                onClick={() => {
                  if (!review.instanceId || !review.revision) return;
                  void request({
                    action: 'edit-routing',
                    instanceId: review.instanceId,
                    file: review.path,
                    revision: review.revision,
                    effectiveRevision: review.effectiveRevision,
                    route,
                    layer,
                    actionId: crypto.randomUUID(),
                  });
                }}
              >
                Save profile setting
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {saving && review && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open && !busy) setSaving(false);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Save as profile</DialogTitle>
              <DialogDescription>
                Save a portable snapshot of the profile settings on{' '}
                {computer.name}.
              </DialogDescription>
            </DialogHeader>
            <SettingsRow
              title="Default Inbox route"
              description={routeLabels[review.routing.effective]}
            />
            <SettingsRow
              title="Local approvals"
              description="Executable definitions stay subject to verification on the computer using this file."
            />
            <Field
              id={id + '-new-profile'}
              label="New YAML file on this computer"
            >
              <PathInput
                id={id + '-new-profile'}
                value={destinationFile}
                onChange={event => setDestinationFile(event.target.value)}
              />
            </Field>
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
            <DialogFooter>
              <DialogCancel disabled={busy} onClick={() => setSaving(false)}>
                Cancel
              </DialogCancel>
              <Button
                disabled={busy || !review.instanceId || !destinationFile.trim()}
                onClick={() => {
                  if (!review.instanceId) return;
                  void request({
                    action: 'save-as',
                    file: destinationFile.trim(),
                    instanceId: review.instanceId,
                    effectiveRevision: review.effectiveRevision,
                    actionId: crypto.randomUUID(),
                  });
                }}
              >
                Create profile
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
