import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  type AllowScope,
  type Approval,
  type RespondApprovalInput,
} from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';

type Decision = Pick<
  RespondApprovalInput,
  'decision' | 'message' | 'allowScope' | 'allowPattern'
>;

function patternBody(approval: Approval) {
  const rule = approval.allowPattern;
  if (!rule) return '';
  const prefix = rule.tool + '(';
  const body =
    rule.pattern.startsWith(prefix) && rule.pattern.endsWith(')')
      ? rule.pattern.slice(prefix.length, -1)
      : rule.pattern;
  return rule.tool === 'WebFetch' ? body.replace(/^domain:/, '') : body;
}

export function ApprovalActions({
  approval,
  sessionId,
  runId,
  hostId,
  enabled,
  onDecide,
}: {
  approval: Approval;
  sessionId: string;
  runId: string;
  hostId: string;
  enabled: boolean;
  onDecide: (decision: Decision) => void;
}) {
  const fieldId = useId();
  const [editor, setEditor] = useState<AllowScope | 'deny' | null>(null);
  const [pattern, setPattern] = useState(() => patternBody(approval));
  const [message, setMessage] = useState('');
  const [checked, setChecked] = useState<{
    pattern: string;
    scope: AllowScope;
    error: string | null;
  }>();
  const scope = editor === 'deny' ? null : editor;
  const fingerprint = approval.fingerprint;
  const validation =
    checked?.scope === scope && checked.pattern === pattern ? checked : null;
  useEffect(() => {
    if (!enabled || !scope || !fingerprint || !pattern.trim()) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void window.nesvo
        .claudeAutonomy(
          {
            action: 'validate-rule',
            sessionId,
            runId,
            requestId: approval.id,
            fingerprint,
            scope,
            pattern,
          },
          hostId,
        )
        .then(
          result => {
            if (current)
              setChecked({
                scope,
                pattern,
                error:
                  result.validation?.error ??
                  (result.validation
                    ? null
                    : 'Could not validate this pattern.'),
              });
          },
          error => {
            if (current)
              setChecked({
                scope,
                pattern,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Could not validate this pattern.',
              });
          },
        );
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [
    approval.id,
    enabled,
    fingerprint,
    hostId,
    pattern,
    runId,
    scope,
    sessionId,
  ]);

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          disabled={!enabled}
          onClick={() => onDecide({ decision: 'accept' })}
        >
          Allow once
        </Button>
        {approval.allowPattern && fingerprint && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" disabled={!enabled}>
                Always allow…
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setEditor('session')}>
                In this session
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditor('project')}>
                In this project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={!enabled}
          aria-expanded={fingerprint ? editor === 'deny' : undefined}
          onClick={() =>
            fingerprint
              ? setEditor(editor === 'deny' ? null : 'deny')
              : onDecide({ decision: 'decline' })
          }
        >
          Deny
        </Button>
      </div>
      {approval.allowRuleReason && (
        <p className="text-2xs text-muted-foreground">
          Always allow unavailable. {approval.allowRuleReason}
        </p>
      )}
      {scope && (
        <form
          className="space-y-1.5"
          onSubmit={event => {
            event.preventDefault();
            if (enabled && validation?.error === null)
              onDecide({
                decision: 'accept',
                allowScope: scope,
                allowPattern: pattern,
              });
          }}
        >
          <Label htmlFor={fieldId}>
            {scope === 'session' ? 'Session pattern' : 'Project pattern'}
          </Label>
          <Input
            id={fieldId}
            value={pattern}
            maxLength={4200}
            spellCheck={false}
            className="font-mono"
            disabled={!enabled}
            aria-invalid={validation?.error ? true : undefined}
            aria-describedby={fieldId + '-validation'}
            onChange={event => {
              setChecked(undefined);
              setPattern(event.target.value);
            }}
          />
          <StatusMessage
            id={fieldId + '-validation'}
            tone={validation?.error ? 'error' : 'info'}
          >
            {validation?.error ??
              (validation
                ? 'Matches this operation.'
                : pattern.trim()
                  ? 'Checking pattern…'
                  : 'Enter a pattern.')}
          </StatusMessage>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              type="submit"
              disabled={!enabled || validation?.error !== null}
            >
              Save rule and allow
            </Button>
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {editor === 'deny' && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={event => {
            event.preventDefault();
            if (enabled)
              onDecide({
                decision: 'decline',
                message: message.trim() || undefined,
              });
          }}
        >
          <Input
            aria-label="Message with the denial"
            placeholder="Message for Claude (optional)"
            maxLength={2000}
            disabled={!enabled}
            value={message}
            className="min-w-32 flex-1"
            onChange={event => setMessage(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={!enabled}>
            Confirm denial
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}
