import {
  compareGroupOrder,
  scheduledJobDefinitionSchema,
  saveScheduledJobSchema,
  type ConfigurationTarget,
  type ConfigurationValue,
  type SessionGroup,
  type CreateCostBudgetInput,
} from '@nesvo/contracts';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CostStore } from './cost-store';
import type { ScheduledJobService } from './scheduled-jobs/service';
import type { ScheduledJobStore } from './scheduled-jobs/store';
import type { SessionHousekeeping } from './sessions/housekeeping';
import type { SessionService } from './sessions/service';
import type { ConfigurationSnapshot } from './workflows/assistant-change-store';
import {
  absentConfigurationVersion,
  configurationHash,
  ConfigurationRefusal,
  type ConfigurationWriter,
} from './workflows/configuration-changes';

function invalid(message: string): never {
  throw new ConfigurationRefusal('invalid-request', message);
}
const revisionOf = (revision: number) => ({
  type: 'revision' as const,
  revision,
});
const budgetTerm = (input: CreateCostBudgetInput): CreateCostBudgetInput => {
  if (input.scope !== 'directory') return input;
  try {
    if (!isAbsolute(input.target)) throw new Error('Relative folder');
    return { ...input, target: realpathSync(input.target) };
  } catch {
    return invalid('Choose an available absolute budget folder.');
  }
};

export function budgetConfiguration(
  costs: CostStore,
  sessions: SessionService,
  groups: SessionHousekeeping,
): ConfigurationWriter {
  return {
    kind: 'database',
    open: target => {
      if (target.area !== 'budgets' || !('id' in target))
        return invalid('Choose a budget.');
      const id = target.id;
      const read = (): ConfigurationSnapshot => {
        const budget = costs.budgets().find(item => item.id === id);
        const value: ConfigurationValue | null = budget
          ? {
              kind: 'budgets',
              value: {
                scope: budget.scope,
                period: budget.period,
                limitUsd: budget.limitUsd,
                action: budget.action,
                ...('target' in budget ? { target: budget.target } : {}),
              } as CreateCostBudgetInput,
            }
          : null;
        return {
          value,
          version: budget
            ? revisionOf(costs.budgetRevision(id))
            : absentConfigurationVersion,
          identity: id,
          dependencies: '',
        };
      };
      return {
        read,
        prepare: ({ draft }, before) => {
          if (draft && draft.kind !== 'budgets')
            return invalid('Choose budget terms.');
          const budget = draft && budgetTerm(draft.value);
          if (
            budget?.scope === 'group' &&
            !groups.list().groups.some(group => group.id === budget.target)
          )
            return invalid('Choose an existing session group.');
          if (budget?.scope === 'session' && !sessions.snapshot(budget.target))
            return invalid('Choose an existing session.');
          if (budget && before.value === null && costs.budgets().length >= 100)
            return invalid('This computer reached its budget limit.');
          return {
            classification:
              budget?.action === 'refuse-new-turns' ? 'authority' : 'review',
            after: {
              ...before,
              value: budget ? { kind: 'budgets', value: budget } : null,
              version: budget
                ? revisionOf(costs.budgetRevision(id) + 1)
                : absentConfigurationVersion,
            },
          };
        },
        write: ({ from, to }) => {
          if (to.value?.kind === 'budgets') {
            if (from.value === null) {
              if (!costs.create(to.value.value, id))
                invalid('This computer reached its budget limit.');
            } else if (!costs.update({ ...to.value.value, id }))
              invalid('The budget is unavailable.');
          } else if (!costs.delete(id)) invalid('The budget is unavailable.');
        },
      };
    },
  };
}

type Membership = { id: string; groupId: string | null; order: number };
type GroupState = { groups: SessionGroup[]; members: Membership[] };
type GroupPlan = Parameters<SessionHousekeeping['applyGroupPlan']>[0];
const ordered = (groups: SessionGroup[], parent: string | null) =>
  groups.filter(group => group.parentId === parent).sort(compareGroupOrder);

function groupValue(
  group: SessionGroup | undefined,
  state: GroupState,
): ConfigurationValue | null {
  if (!group) return null;
  return {
    kind: 'session-groups',
    value: {
      name: group.name,
      defaults: group.defaults,
      parentId: group.parentId,
      position: ordered(state.groups, group.parentId).findIndex(
        item => item.id === group.id,
      ),
    },
  };
}

function groupVersion(id: string, revision: number, state: GroupState) {
  const group = state.groups.find(item => item.id === id);
  const groupOrder = state.groups
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(item => [item.id, item.parentId, item.order]);
  return {
    version: group ? revisionOf(revision) : absentConfigurationVersion,
    dependencies: configurationHash(
      JSON.stringify([revision, groupOrder, state.members]),
    ),
  };
}

const groupEffect = (id: string, state: GroupState) =>
  JSON.stringify(
    {
      group: groupValue(
        state.groups.find(item => item.id === id),
        state,
      ),
      subgroups: state.groups
        .filter(group => group.parentId === id)
        .map(group => [group.id, group.name]),
      sessions: state.members.filter(member => member.groupId === id).length,
    },
    null,
    2,
  );

function groupDelta(state: GroupState, prior: GroupState): GroupPlan {
  const groups = state.groups.filter(
    group =>
      !isDeepStrictEqual(
        group,
        prior.groups.find(item => item.id === group.id),
      ),
  );
  const restoredDepth = (group: SessionGroup) => {
    let depth = 0;
    let parent = group.parentId;
    while (parent && depth <= 3) {
      depth++;
      parent = state.groups.find(item => item.id === parent)?.parentId ?? null;
    }
    return depth;
  };
  return {
    groups: groups.sort((a, b) => restoredDepth(a) - restoredDepth(b)),
    removed: prior.groups
      .filter(group => !state.groups.some(item => item.id === group.id))
      .map(group => group.id),
    memberships: state.members.filter(
      member =>
        prior.members.find(item => item.id === member.id)?.groupId !==
        member.groupId,
    ),
  };
}

export function groupConfiguration(
  groups: SessionHousekeeping,
  sessions: SessionService,
): ConfigurationWriter {
  return {
    kind: 'database',
    open: target => {
      if (target.area !== 'session-groups' || !('id' in target))
        return invalid('Choose a session group.');
      const id = target.id;
      const list = groups.list();
      const members = sessions
        .list()
        .map(({ id, groupId, order }) => ({ id, groupId, order }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const state = { groups: list.groups, members };
      const current = state.groups.find(item => item.id === id);
      const value = groupValue(current, state);
      return {
        read: () => ({
          ...groupVersion(id, list.revision, state),
          identity: id,
          value,
          state: JSON.stringify(state),
          document: groupEffect(id, state),
        }),
        prepare: ({ draft }, before, restore) => {
          if (draft && draft.kind !== 'session-groups')
            return invalid('Choose group properties.');
          const input = draft?.value;
          if (input?.defaults.mode === 'full-access')
            return invalid('Full access is unavailable as a group default.');
          let next: GroupState;
          if (restore?.state) {
            next = JSON.parse(restore.state) as GroupState;
          } else {
            const plan: GroupPlan = input
              ? current
                ? groups.planUpdateGroup({
                    groupId: id,
                    name: input.name,
                    defaults: input.defaults,
                  })
                : groups.planCreateGroup({
                    groupId: id,
                    name: input.name,
                    parentId: input.parentId,
                    defaults: input.defaults,
                  })
              : groups.planDeleteGroup({ groupId: id });
            const changes = new Map(
              plan.groups.map(group => [group.id, group]),
            );
            for (const group of state.groups)
              if (!changes.has(group.id)) changes.set(group.id, group);
            for (const removed of plan.removed ?? []) changes.delete(removed);
            if (
              input &&
              (!current ||
                value?.kind !== 'session-groups' ||
                input.parentId !== value.value.parentId ||
                input.position !== value.value.position)
            ) {
              const move = groups.planMoveGroup(
                {
                  groupId: id,
                  parentId: input.parentId,
                  position: input.position,
                },
                [...changes.values()],
              );
              for (const group of move.groups) changes.set(group.id, group);
            }
            const placements = new Map(
              plan.memberships?.map(member => [member.id, member.groupId]),
            );
            next = {
              groups: [...changes.values()],
              members: state.members.map(member =>
                placements.has(member.id)
                  ? { ...member, groupId: placements.get(member.id) ?? null }
                  : member,
              ),
            };
          }
          const afterValue = groupValue(
            next.groups.find(group => group.id === id),
            next,
          );
          const rename =
            value?.kind === 'session-groups' &&
            afterValue?.kind === 'session-groups' &&
            value.value.name !== afterValue.value.name &&
            isDeepStrictEqual(
              { ...value.value, name: '' },
              { ...afterValue.value, name: '' },
            );
          const authority =
            afterValue?.kind === 'session-groups' &&
            afterValue.value.defaults.mode &&
            afterValue.value.defaults.mode !== 'read-only' &&
            (value?.kind !== 'session-groups' ||
              value.value.defaults.mode !== afterValue.value.defaults.mode);
          return {
            classification: rename
              ? 'direct'
              : authority
                ? 'authority'
                : 'review',
            after: {
              ...before,
              ...groupVersion(id, list.revision + 1, next),
              value: afterValue,
              document: groupEffect(id, next),
              state: JSON.stringify(next),
            },
          };
        },
        write: ({ to }) =>
          groups.applyGroupPlan(
            groupDelta(JSON.parse(to.state!) as GroupState, state),
          ),
      };
    },
  };
}

export function automationConfiguration(
  service: ScheduledJobService,
  store: ScheduledJobStore,
): ConfigurationWriter {
  return {
    kind: 'database',
    open: (target: ConfigurationTarget) => {
      if (target.area !== 'automations' || !('id' in target))
        return invalid('Choose an automation.');
      const id = target.id;
      const current = store.get(id);
      const revision = store.configurationRevision(id);
      const value: ConfigurationValue | null = current
        ? {
            kind: 'automations',
            value: scheduledJobDefinitionSchema.parse(
              Object.fromEntries(
                Object.keys(scheduledJobDefinitionSchema.shape).map(key => [
                  key,
                  current[key as keyof typeof current],
                ]),
              ),
            ),
          }
        : null;
      const pending = current?.pendingStart?.id ?? null;
      const document = (
        value: ConfigurationValue | null,
        request: string | null,
        reset: boolean,
      ) =>
        JSON.stringify(
          {
            definition: value,
            pendingStart: request,
            checkBaseline: reset ? 'Reset' : 'Kept',
          },
          null,
          2,
        );
      return {
        read: () => ({
          value,
          version: current ? revisionOf(revision) : absentConfigurationVersion,
          identity: id,
          dependencies: pending ?? '',
          document: document(value, pending, false),
        }),
        prepare: ({ draft }, before, restore) => {
          if (draft && draft.kind !== 'automations')
            return invalid('Choose automation settings.');
          if (current && store.hasActiveRun(id))
            throw new ConfigurationRefusal(
              'busy',
              'Wait for the current automation run to finish.',
            );
          if (
            !draft &&
            current &&
            service.listRuns({ scheduledJobId: id, limit: 1 }).runs.length
          )
            return invalid('Pause this automation to retain its run history.');
          if (draft && !current && draft.value.active && !restore)
            return invalid(
              'Create the automation paused and review activation separately.',
            );
          const authority =
            draft &&
            (draft.value.active ||
              draft.value.mode !== 'read-only' ||
              !!draft.value.changeTrigger ||
              !!draft.value.pullRequestReview ||
              !!draft.value.browser ||
              !!draft.value.redCi);
          const reset =
            !!current &&
            !!draft &&
            (current.directory !== draft.value.directory ||
              !!current.redCi !== !!draft.value.redCi ||
              !isDeepStrictEqual(
                current.changeTrigger?.argv,
                draft.value.changeTrigger?.argv,
              ));
          return {
            classification: authority ? 'authority' : 'review',
            after: {
              ...before,
              dependencies: '',
              value: draft,
              document: document(draft, null, reset),
              version: draft
                ? revisionOf(revision + 1)
                : absentConfigurationVersion,
            },
          };
        },
        write: ({ to }) => {
          if (to.value?.kind === 'automations')
            service.save(
              saveScheduledJobSchema.parse({
                ...to.value.value,
                id,
                expectedRevision: current?.revision ?? null,
              }),
            );
          else if (current)
            service.delete({ id, expectedRevision: current.revision });
        },
      };
    },
  };
}
