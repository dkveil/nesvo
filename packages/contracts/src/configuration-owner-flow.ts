import { z } from 'zod';
import { allowRuleTextSchema, allowScopeSchema } from './claude-autonomy';
import { computerSchema, sshComputerInputSchema } from './computers';
import {
  configurationEnrollmentSchema,
  configurationEnrollSchema,
  configurationOwnerFlowLinkSchema,
} from './configuration';
import { mobileGatewayStatusSchema, mobilePairingSchema } from './mobile';
import { respondApprovalSchema } from './sessions';

export const desktopConfigurationOwnerInputSchema = z.strictObject({
  review: configurationOwnerFlowLinkSchema,
  operation: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('full-access'),
      directory: z.string().min(1).max(4096),
      sessionId: z.uuid(),
    }),
    z.strictObject({
      kind: z.literal('claude-allow-rule'),
      input: respondApprovalSchema.omit({ message: true }).extend({
        decision: z.literal('accept'),
        fingerprint: respondApprovalSchema.shape.fingerprint.unwrap(),
        allowScope: allowScopeSchema,
        allowPattern: allowRuleTextSchema,
      }),
    }),
    z.strictObject({
      kind: z.literal('devices'),
      input: configurationEnrollSchema,
    }),
    z.strictObject({
      kind: z.literal('phone-access'),
      action: z.enum(['enable', 'pair']),
    }),
    z.strictObject({
      kind: z.literal('computers'),
      input: sshComputerInputSchema,
    }),
  ]),
});

export const desktopConfigurationOwnerResultSchema = z.strictObject({
  recorded: z.boolean(),
  result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('full-access') }),
    z.strictObject({ kind: z.literal('claude-allow-rule') }),
    z.strictObject({
      kind: z.literal('devices'),
      value: configurationEnrollmentSchema,
    }),
    z.strictObject({
      kind: z.literal('enable'),
      value: mobileGatewayStatusSchema,
    }),
    z.strictObject({ kind: z.literal('pair'), value: mobilePairingSchema }),
    z.strictObject({ kind: z.literal('computers'), value: computerSchema }),
  ]),
});

export type DesktopConfigurationOwnerInput = z.input<
  typeof desktopConfigurationOwnerInputSchema
>;
export type DesktopConfigurationOwnerResult = z.output<
  typeof desktopConfigurationOwnerResultSchema
>;
