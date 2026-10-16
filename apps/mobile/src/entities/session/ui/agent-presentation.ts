import { colors } from '@shared/theme';

import type { Session } from '../model/session';

const AGENT_COLORS: Record<Session['agent'], string> = {
  Terminal: colors.programTerminal,
  Claude: colors.programClaude,
  Gemini: colors.programGemini,
  Codex: colors.programCodex,
};

export function sessionAgentColor(agent: Session['agent']): string {
  return AGENT_COLORS[agent];
}
