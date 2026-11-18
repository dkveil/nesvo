import { useEffect, useState } from 'react';
import {
  deleteLocalDataPhrase,
  retentionDaysSchema,
  type DesktopApi,
  type TranscriptRetention,
  type WorkLaptopPolicy,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

export function DataPrivacySettings({
  api,
  localConnected,
}: {
  api: DesktopApi;
  localConnected: boolean;
}) {
  const { workLaptopPolicy, transcriptRetention } = api;
  const [policy, setPolicy] = useState<WorkLaptopPolicy>();
  const [retention, setRetention] = useState<TranscriptRetention>();
  const [days, setDays] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [dialog, setDialog] = useState<'purge' | 'delete'>();

  useEffect(() => {
    void workLaptopPolicy()
      .then(setPolicy)
      .catch(failure => setError(errorDetail(failure)));
  }, [workLaptopPolicy]);
  useEffect(() => {
    if (!localConnected) return;
    void transcriptRetention()
      .then(state => {
        setRetention(state);
        setDays(state.days?.toString() ?? '');
      })
      .catch(failure => setError(errorDetail(failure)));
  }, [localConnected, transcriptRetention]);

  const action = async (run: () => Promise<void>) => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await run();
    } catch (failure) {
      setError(errorDetail(failure));
      setPending(false);
      return false;
    }
    setPending(false);
    return true;
  };
  const parsedDays = retentionDaysSchema.safeParse(
    days === '' ? null : Number(days),
  );
  const closeDialog = () => {
    setDialog(undefined);
    setConfirmation('');
  };

  return (
    <>
      <SettingsSection title="Privacy">
        <SettingsRow
          title="Work laptop mode"
          description={
            <div className="space-y-1">
              <p>
                Blocks Phone access and remote computers. Desktop notifications
                use generic text.
              </p>
              {policy?.enforced && <p>On · Enforced by policy</p>}
              {policy && !policy.enforced && (
                <p>{policy.enabled ? 'On' : 'Off'}</p>
              )}
              {policy && policy.enabled !== policy.requested && (
                <p>
                  Quit and reopen Nesvo to turn this mode{' '}
                  {policy.requested ? 'on' : 'off'}.
                </p>
              )}
            </div>
          }
        >
          <Switch
            aria-label="Work laptop mode"
            checked={policy?.requested ?? false}
            disabled={pending || !policy || policy.enforced}
            onCheckedChange={value =>
              void action(async () =>
                setPolicy(await api.setWorkLaptopPolicy(value)),
              )
            }
          />
        </SettingsRow>
        <SettingsRow
          title="Transcript retention"
          description="Expires inactive archived sessions and old cached transcript search entries on this computer. Leave the field blank to keep forever."
        >
          <Input
            className="w-28"
            aria-label="Retention days"
            placeholder="Forever"
            type="number"
            min={1}
            max={3650}
            value={days}
            disabled={!localConnected || !retention || pending}
            onChange={event => setDays(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={
              !localConnected ||
              !retention ||
              !parsedDays.success ||
              parsedDays.data === retention.days ||
              pending
            }
            onClick={() => {
              if (parsedDays.success)
                void action(async () =>
                  setRetention(
                    await api.setTranscriptRetention(parsedDays.data),
                  ),
                );
            }}
          >
            Save
          </Button>
        </SettingsRow>
        <SettingsRow
          title="Purge expired transcripts"
          description="Apply the saved retention period now. This permanently removes eligible session history and attachments from Nesvo."
        >
          <Button
            variant="outline"
            disabled={!localConnected || retention?.days == null || pending}
            onClick={() => setDialog('purge')}
          >
            Purge now
          </Button>
        </SettingsRow>
        <SettingsRow
          title="Delete all Nesvo data on this computer"
          description="Permanently removes local sessions, backups, attachments, logs and Nesvo settings, then closes the app."
        >
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => setDialog('delete')}
          >
            Delete all data
          </Button>
        </SettingsRow>
      </SettingsSection>
      {message && <StatusMessage tone="success">{message}</StatusMessage>}
      {error && !dialog && <StatusMessage tone="error">{error}</StatusMessage>}
      <ConfirmDialog
        open={dialog !== undefined}
        onOpenChange={open => {
          if (!open) closeDialog();
        }}
        title={
          dialog === 'delete'
            ? 'Delete all Nesvo data on this computer?'
            : 'Purge expired transcripts?'
        }
        description={
          dialog === 'delete'
            ? `This action is permanent and stops local work. Type ${deleteLocalDataPhrase} to confirm.`
            : 'Eligible archived conversations will be deleted permanently.'
        }
        confirmLabel={
          dialog === 'delete' ? 'Delete all data' : 'Purge transcripts'
        }
        confirmDisabled={
          dialog === 'delete' && confirmation !== deleteLocalDataPhrase
        }
        onConfirm={async () => {
          if (dialog === 'delete') {
            const started = await action(() =>
              api.deleteLocalData(confirmation),
            );
            if (started) {
              setPending(true);
              setMessage('Deleting local data and closing Nesvo…');
            }
            return started;
          }
          return action(async () => {
            const result = await api.purgeTranscripts();
            setMessage(`Sessions purged: ${result.purgedSessions}.`);
          });
        }}
      >
        {dialog === 'delete' && (
          <Field label="Confirmation" id="delete-local-data-confirmation">
            <Input
              id="delete-local-data-confirmation"
              autoComplete="off"
              value={confirmation}
              onChange={event => setConfirmation(event.target.value)}
            />
          </Field>
        )}
        {error && dialog && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
    </>
  );
}
