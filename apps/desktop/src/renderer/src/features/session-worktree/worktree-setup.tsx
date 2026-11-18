import { useEffect, useState } from 'react';
import type { DesktopApi, SessionWorktreeSetup } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  api: Pick<DesktopApi, 'readSessionWorktreeSetup' | 'runSessionWorktreeSetup'>;
  sessionId: string;
  disabled: boolean;
  onRun: () => void;
};

export function WorktreeSetup({ api, sessionId, disabled, onRun }: Props) {
  const [setup, setSetup] = useState<SessionWorktreeSetup>();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let current = true;
    void api.readSessionWorktreeSetup({ sessionId }).then(
      value => {
        if (current) setSetup(value);
      },
      failure => {
        if (current) setError(errorDetail(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [api, refresh, sessionId]);

  const run = async (approve: boolean) => {
    if (!setup?.script || pending || disabled) return;
    setError('');
    setPending(true);
    try {
      const result = await api.runSessionWorktreeSetup({
        sessionId,
        sha256: setup.script.sha256,
        approve,
      });
      setSetup({ script: { sha256: result.sha256, approved: true }, result });
      setShowOutput(false);
      onRun();
    } catch (failure) {
      setError(errorDetail(failure));
      setRefresh(value => value + 1);
    } finally {
      setPending(false);
    }
  };

  if (!setup?.script && !setup?.result && !error) return null;
  const result = setup?.result;
  return (
    <div className="space-y-2 border-t pt-3">
      {setup?.script && (
        <>
          <p className="break-all font-mono text-2xs text-muted-foreground">
            SHA-256 {setup.script.sha256}
          </p>
          <Button
            variant="outline"
            disabled={disabled || pending}
            onClick={() =>
              setup.script?.approved ? void run(false) : setConfirm(true)
            }
          >
            {pending ? 'Running setup script…' : 'Run setup script'}
          </Button>
        </>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {result && (
        <>
          <StatusMessage
            tone={result.status === 'completed' ? 'success' : 'error'}
          >
            {result.status === 'completed'
              ? 'Setup completed.'
              : result.status === 'timed-out'
                ? 'Setup timed out.'
                : `Setup failed${result.exitCode === null ? '' : ` with exit code ${result.exitCode}`}.`}
          </StatusMessage>
          {result.sha256 !== setup?.script?.sha256 && (
            <p className="break-all font-mono text-2xs text-muted-foreground">
              Last run SHA-256 {result.sha256}
            </p>
          )}
          <Button
            variant="ghost"
            aria-expanded={showOutput}
            onClick={() => setShowOutput(value => !value)}
          >
            {showOutput ? 'Hide output' : 'Show output'}
          </Button>
          {showOutput && (
            <CodeBlock
              label={
                result.truncated ? 'Setup output (truncated)' : 'Setup output'
              }
              code={
                [result.stdout, result.stderr].filter(Boolean).join('\n') ||
                'No output.'
              }
              wrap
            />
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Approve setup script?"
        description="This script runs on the session computer with the host’s operating system permissions. Approve the displayed SHA-256 to run this version."
        confirmLabel="Approve and run"
        tone="default"
        onConfirm={() => void run(true)}
      >
        <p className="break-all font-mono text-2xs text-muted-foreground">
          {setup?.script?.sha256}
        </p>
      </ConfirmDialog>
    </div>
  );
}
