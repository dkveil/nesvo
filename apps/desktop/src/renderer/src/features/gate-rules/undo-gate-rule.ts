import type { AssistantUndoInput } from '@nesvo/contracts';

export async function undoGateRule(hostId: string, input: AssistantUndoInput) {
  const result = await window.nesvo.workflows.assistantUndo(hostId, input);
  if (result.status === 'conflict') throw new Error(result.message);
  if (result.status === 'refused')
    throw new Error(result.issues[0]?.message ?? 'Undo was refused.');
}
