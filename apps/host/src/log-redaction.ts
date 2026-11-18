const REDACTED = '[redacted]';
const SECRET_NAME =
  /(?:token|secret|password|passphrase|credential|(?:api|access|private|signing)[_-]?key|authorization|cookie)/i;

export function redactLogMessage(message: string, env = process.env): string {
  const values = new Set(
    Object.entries(env)
      .filter(([key, value]) => value && SECRET_NAME.test(key))
      .flatMap(([, value]) => [value!, JSON.stringify(value).slice(1, -1)]),
  );
  for (const value of [...values].sort(
    (left, right) => right.length - left.length,
  ))
    message = message.replaceAll(value, REDACTED);
  return message
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      REDACTED,
    )
    .replace(/\b(?:proxy-)?authorization["']?\s*[:=][^\r\n]*/gi, REDACTED)
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, REDACTED)
    .replace(
      /\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|sk-[a-z0-9_-]+|xox[baprs]-[a-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)\b/gi,
      REDACTED,
    )
    .replace(
      /\b([\w-]*(?:token|secret|password|passphrase|credential|(?:api|access|private|signing)[_-]?key|cookie)[\w-]*)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
      REDACTED,
    );
}

export function hostDiagnostic(message: string): void {
  process.stderr.write(redactLogMessage(message) + '\n');
}
