import {
  computerSchema,
  configurationEnrollmentSchema,
  configurationResultSchema,
  desktopConfigurationOwnerInputSchema,
  type DesktopConfigurationOwnerResult,
  type HostId,
  workLaptopRestriction,
} from '@nesvo/contracts';
import type { ComputerManager } from './computer-manager';
import type { mobileAccess } from './mobile-access';

export async function completeConfigurationReview(
  input: unknown,
  hostId: HostId,
  computers: ComputerManager,
  mobile: ReturnType<typeof mobileAccess>,
  restricted: boolean,
): Promise<DesktopConfigurationOwnerResult> {
  if (restricted) throw new Error(workLaptopRestriction);
  const { review, operation } =
    desktopConfigurationOwnerInputSchema.parse(input);
  if (
    hostId !== 'local' &&
    (operation.kind === 'phone-access' || operation.kind === 'computers')
  )
    throw new Error('Complete this review on the owning desktop.');
  if (operation.kind === 'phone-access') {
    const status = await mobile.status();
    if (status.enabled === (operation.action === 'enable'))
      throw new Error(
        operation.action === 'enable'
          ? 'Phone access is already enabled.'
          : 'Enable Phone access before creating a pairing link.',
      );
  }
  const effect =
    operation.kind === 'full-access'
      ? { kind: operation.kind, sessionId: operation.sessionId }
      : operation.kind === 'phone-access'
        ? operation
        : operation.kind === 'claude-allow-rule'
          ? {
              kind: operation.kind,
              sessionId: operation.input.sessionId,
              runId: operation.input.runId,
              requestId: operation.input.requestId,
              fingerprint: operation.input.fingerprint,
              scope: operation.input.allowScope,
            }
          : { kind: operation.kind };
  const started = configurationResultSchema.parse(
    await computers.execute(
      'start-config-owner-flow',
      { ...review, effect },
      hostId,
    ),
  );
  if (!started.ok) throw new Error(started.message);
  if (started.kind !== 'owner-flow')
    throw new Error('The review could not be opened.');
  const finish = async (
    outcome: { description: string; resourceId?: string } | null,
  ) =>
    configurationResultSchema.parse(
      await computers.execute(
        'finish-config-owner-flow',
        { claim: started.claim, outcome },
        hostId,
      ),
    );
  let result: DesktopConfigurationOwnerResult['result'];
  let outcome: { description: string; resourceId?: string };
  try {
    switch (operation.kind) {
      case 'full-access': {
        const revision = started.change.sessionMode?.modeRevision;
        if (revision === undefined)
          throw new Error('The session mode review is missing.');
        await computers.execute(
          'claude-autonomy',
          {
            action: 'confirm-full-access',
            sessionId: operation.sessionId,
            directory: operation.directory,
            expectedModeRevision: revision,
          },
          hostId,
        );
        result = { kind: operation.kind };
        outcome = {
          description: 'Full access approved for the next turn.',
          resourceId: operation.sessionId,
        };
        break;
      }
      case 'claude-allow-rule':
        await computers.execute('respond-approval', operation.input, hostId);
        result = { kind: operation.kind };
        outcome = {
          description: 'Claude operation approved and allow rule saved.',
          resourceId: operation.input.sessionId,
        };
        break;
      case 'devices': {
        const value = await computers.execute(
          'enroll-config-device',
          operation.input,
          hostId,
        );
        const parsed = configurationEnrollmentSchema.safeParse(value);
        if (!parsed.success) {
          const failure = configurationResultSchema.parse(value);
          throw new Error(
            failure.ok ? 'The device could not be enrolled.' : failure.message,
          );
        }
        result = { kind: operation.kind, value: parsed.data };
        outcome = {
          description: 'Configuration device enrolled.',
          resourceId: parsed.data.device.id,
        };
        break;
      }
      case 'phone-access':
        if (operation.action === 'enable') {
          const value = await mobile.enable();
          if (!value.enabled)
            throw new Error('Phone access could not be enabled.');
          result = { kind: 'enable', value };
          outcome = { description: 'Phone access enabled.' };
        } else {
          result = { kind: 'pair', value: await mobile.pair() };
          outcome = {
            description: 'A one-time phone pairing link was created.',
          };
        }
        break;
      case 'computers': {
        const added = await computers.addComputer(operation.input);
        const value = computerSchema.parse(
          await computers.connectComputer(added.id),
        );
        if (value.status !== 'connected' || !value.instanceId)
          throw new Error(
            'Inspect the saved connection and verify its SSH identity in Computers.',
          );
        result = { kind: operation.kind, value };
        outcome = {
          description: 'Computer connected with a verified SSH identity.',
          resourceId: value.id,
        };
        break;
      }
    }
  } catch (failure) {
    await finish(null).catch(() => undefined);
    throw failure;
  }
  const settled = await finish(outcome).catch(() => undefined);
  return {
    recorded: Boolean(
      settled?.ok && settled.kind === 'owner-outcome' && settled.receipt,
    ),
    result,
  };
}
