import { z } from 'zod';
import { decisionRouteSchema } from './decision-route';
import {
  isProviderSessionMode,
  providerSchema,
  sessionModeSchema,
  sessionWorkflowSchema,
  type Session,
} from './sessions';

export const SESSION_GROUP_MAX_DEPTH = 3;
export const SESSION_GROUP_LIMIT = 200;

export const sessionGroupNameSchema = z.string().trim().min(1).max(80);
export const sessionTitleSchema = z.string().trim().min(1).max(100);

export const sessionGroupDefaultsSchema = z
  .strictObject({
    directory: z.string().trim().min(1).max(4096).optional(),
    provider: providerSchema.optional(),
    profileId: z.uuid().nullable().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    mode: sessionModeSchema.optional(),
    workflow: sessionWorkflowSchema.optional(),
    decisionRoute: decisionRouteSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.provider &&
      value.mode &&
      !isProviderSessionMode(value.provider, value.mode)
    )
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: `${value.provider} does not support the ${value.mode} permission mode`,
      });
    if ((value.model || value.mode || value.profileId) && !value.provider)
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Choose a provider for the default account, model or mode',
      });
  });

export const sessionGroupSchema = z.strictObject({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  name: sessionGroupNameSchema,
  order: z.number().int(),
  defaults: sessionGroupDefaultsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const sessionGroupListSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  groups: z.array(sessionGroupSchema).max(SESSION_GROUP_LIMIT),
});

export const createSessionGroupSchema = z.strictObject({
  groupId: z.uuid(),
  parentId: z.uuid().nullable().default(null),
  name: sessionGroupNameSchema,
  defaults: sessionGroupDefaultsSchema.default({}),
});

export const updateSessionGroupSchema = z
  .strictObject({
    groupId: z.uuid(),
    name: sessionGroupNameSchema.optional(),
    defaults: sessionGroupDefaultsSchema.optional(),
  })
  .refine(value => !!value.name || !!value.defaults, {
    message: 'Change the name or the defaults',
  });

export const moveSessionGroupSchema = z.strictObject({
  groupId: z.uuid(),
  parentId: z.uuid().nullable(),
  position: z.number().int().nonnegative().max(SESSION_GROUP_LIMIT),
});

export const deleteSessionGroupSchema = z.strictObject({
  groupId: z.uuid(),
});

export const moveSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  groupId: z.uuid().nullable(),
  position: z.number().int().nonnegative().max(10_000),
});

export const renameSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  title: sessionTitleSchema,
});

export const setSessionPinnedSchema = z.strictObject({
  sessionId: z.uuid(),
  pinned: z.boolean(),
});

export const setSessionArchivedSchema = z.strictObject({
  sessionId: z.uuid(),
  archived: z.boolean(),
});

type OrderedSession = Pick<Session, 'id' | 'order' | 'updatedAt'>;
type OrderedGroup = Pick<SessionGroup, 'id' | 'order' | 'createdAt'>;

export const compareSessionOrder = (
  left: OrderedSession,
  right: OrderedSession,
): number =>
  left.order - right.order ||
  right.updatedAt.localeCompare(left.updatedAt) ||
  left.id.localeCompare(right.id);

export const compareGroupOrder = (
  left: OrderedGroup,
  right: OrderedGroup,
): number =>
  left.order - right.order ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.id.localeCompare(right.id);

export const isGroupableSession = (
  session: Pick<Session, 'parentId' | 'workflowStepId' | 'scheduledJobId'>,
): boolean =>
  !session.parentId && !session.workflowStepId && !session.scheduledJobId;

export type SessionGroupDefaults = z.infer<typeof sessionGroupDefaultsSchema>;
export type SessionGroup = z.infer<typeof sessionGroupSchema>;
export type SessionGroupList = z.infer<typeof sessionGroupListSchema>;
export type CreateSessionGroupInput = z.infer<typeof createSessionGroupSchema>;
export type UpdateSessionGroupInput = z.infer<typeof updateSessionGroupSchema>;
export type MoveSessionGroupInput = z.infer<typeof moveSessionGroupSchema>;
export type DeleteSessionGroupInput = z.infer<typeof deleteSessionGroupSchema>;
export type MoveSessionInput = z.infer<typeof moveSessionSchema>;
export type RenameSessionInput = z.infer<typeof renameSessionSchema>;
export type SetSessionPinnedInput = z.infer<typeof setSessionPinnedSchema>;
export type SetSessionArchivedInput = z.infer<typeof setSessionArchivedSchema>;
