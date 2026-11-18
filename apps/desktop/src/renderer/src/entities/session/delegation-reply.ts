const prefix = 'Codex delegation results:';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const delegationTool = (name: unknown) =>
  name === 'session_delegate' ||
  name === 'nesvo_delegate' ||
  name === 'session_create';

export function isDelegationReply(body: string, streaming = false): boolean {
  const value = body.trim();
  if (!value) return false;
  if (streaming && (prefix.startsWith(value) || value.startsWith(prefix)))
    return true;
  const prefixed = value.startsWith(prefix);
  const candidate = prefixed ? value.slice(prefix.length).trim() : value;
  const json =
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate)?.[1] ?? candidate;
  if (!json.startsWith('{') && !json.startsWith('[')) return false;
  if (streaming) return true;
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed))
      return (
        parsed.some(
          item =>
            isRecord(item) && delegationTool(item.tool) && 'result' in item,
        ) &&
        parsed.every(
          item =>
            isRecord(item) && typeof item.tool === 'string' && 'result' in item,
        )
      );
    if (!isRecord(parsed)) return false;
    if (delegationTool(parsed.tool) && 'result' in parsed) return true;
    if (
      typeof parsed.sessionId === 'string' &&
      typeof parsed.messageId === 'string' &&
      typeof parsed.actionId === 'string' &&
      /^[0-9a-f]{64}$/.test(parsed.actionId) &&
      typeof parsed.planFirst === 'boolean'
    )
      return true;
    if (Array.isArray(parsed.results) && parsed.results.length)
      return parsed.results.every(
        item =>
          isRecord(item) &&
          typeof item.delegationId === 'string' &&
          'childSessionId' in item,
      );
    return (
      prefixed && (typeof parsed.error === 'string' || parsed.ok === false)
    );
  } catch {
    return false;
  }
}
