import type { McpRepositoryLaunch } from '@nesvo/contracts';
import type { ConfigTable } from './scoped-config';

const mask = '••••';
const secretKey = /key|token|secret|password|auth|credential/i;
const keyValue = /^(-{1,2})?([\w.-]+)(\s*[:=]\s*)(.*)$/s;
const shellWord =
  /(?:[^\s'";&|<>\\]+|\\[\s\S]|'[^']*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$))+/gu;
const remoteUrl = /[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;

const table = (value: unknown): ConfigTable =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ConfigTable)
    : {};

export const reviewText = (value: string) =>
  value.replace(
    /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname) return url.protocol + '//' + url.host + url.pathname;
  } catch {
    return 'Unparseable URL';
  }
  return 'Unparseable URL';
}

function highEntropy(value: string) {
  const counts = new Map<string, number>();
  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.8;
}

const hideOpaqueStrings = (value: string) =>
  value.replace(/[a-z\d_+-]{24,}/gi, part => (highEntropy(part) ? mask : part));

function redactedArguments(
  args: string[],
  shellEnvironment?: Set<string>,
  depth = 0,
): string[] {
  let maskNext = false;
  let scriptNext = false;
  let needsCommand = Boolean(shellEnvironment);
  return args.map(argument => {
    const quoted = /^(['"])([\s\S]*)\1$/.exec(argument);
    const value = (quoted?.[2] ?? argument).trim();
    const [, prefix = '', key = '', separator = '', payload = ''] =
      keyValue.exec(value) ?? [];
    const shellVariable =
      shellEnvironment && !prefix && /^[a-z_]\w*=$/i.test(key + separator);
    if (shellVariable) shellEnvironment?.add(key);
    const sensitive = secretKey.test(key) || shellVariable;
    const flag = /^--?[\w.-]+$/.test(value);
    const isCommand = needsCommand && !sensitive && !flag;
    if (isCommand) needsCommand = false;
    const script = scriptNext;
    scriptNext = /^(-c|-command|\/c)$/i.test(value);
    const hide = maskNext;
    maskNext =
      Boolean(sensitive && !payload && !shellVariable) ||
      (flag && secretKey.test(value));
    if (hide) return mask;
    const quote = quoted?.[1] ?? '';
    if (sensitive && payload)
      return quote + prefix + key + separator + mask + quote;
    if (script)
      return depth < 4
        ? quote +
            hookCommand(
              quoted?.[2] ?? argument,
              shellEnvironment ?? new Set(),
              depth + 1,
            ) +
            quote
        : mask;
    const safe = argument.replace(remoteUrl, safeUrl);
    return flag || isCommand ? safe : hideOpaqueStrings(safe);
  });
}

function hookCommand(
  command: string,
  environment: Set<string>,
  depth = 0,
): string {
  const words = [...command.matchAll(shellWord)];
  const safe = redactedArguments(
    words.map(word => word[0]),
    environment,
    depth,
  );
  let end = 0;
  const rendered = words.map((word, index) => {
    const before = command.slice(end, word.index);
    end = word.index + word[0].length;
    return before + safe[index];
  });
  return rendered.join('') + command.slice(end);
}

function launchDetails(value: unknown, directory: string, shell: boolean) {
  const config = table(value);
  const fields: McpRepositoryLaunch['fields'] = [];
  const add = (label: (typeof fields)[number]['label'], value: string) =>
    fields.push({ label, value: reviewText(value) });
  const environment = new Set([
    ...Object.keys(table(config.env)),
    ...Object.values(table(config.env_http_headers)).filter(
      (value): value is string => typeof value === 'string',
    ),
    ...(Array.isArray(config.env_vars)
      ? config.env_vars.filter(
          (value): value is string => typeof value === 'string',
        )
      : []),
    ...(typeof config.bearer_token_env_var === 'string'
      ? [config.bearer_token_env_var]
      : []),
  ]);
  if (typeof config.command === 'string')
    add(
      'Command',
      shell ? hookCommand(config.command, environment) : config.command,
    );
  if (Array.isArray(config.args))
    for (const arg of redactedArguments(
      config.args.filter((value): value is string => typeof value === 'string'),
    ))
      add('Argument', arg);
  if (typeof config.cwd === 'string' || typeof config.command === 'string')
    add(
      'Working directory',
      typeof config.cwd === 'string' ? config.cwd : directory,
    );
  if (typeof config.url === 'string') add('URL', safeUrl(config.url));
  for (const name of [...environment].sort()) add('Environment variable', name);
  return fields;
}

export function serverLaunch(
  config: unknown,
  directory: string,
): McpRepositoryLaunch[] {
  return [{ fields: launchDetails(config, directory, false) }];
}

export function hookLaunches(
  groups: unknown,
  directory: string,
): McpRepositoryLaunch[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap(value => {
    const group = table(value);
    if (!Array.isArray(group.hooks)) return [];
    return group.hooks.map(value => {
      const handler = table(value);
      const fields = launchDetails(handler, directory, true);
      if (typeof group.matcher === 'string')
        fields.unshift({ label: 'Matcher', value: reviewText(group.matcher) });
      return {
        kind:
          typeof handler.type === 'string'
            ? reviewText(handler.type) + ' hook'
            : 'Hook',
        fields,
      };
    });
  });
}
