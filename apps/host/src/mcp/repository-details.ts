import type { McpRepositoryLaunch } from '@nesvo/contracts';
import type { ConfigTable } from './scoped-config';

const mask = '••••';
const secretKey =
  /(?:^|[_.-])(?:api[_-]?key|access[_-]?key|token|secret|password|auth|authorization|credential|key)$/i;
const literal = /^[a-z\d_][a-z\d_.+~-]*={0,2}$/i;
const expansion = /\$\(|`|[;|&<>\r\n]|\$\{(?![a-z_]\w*\})/i;
const option = /^(-{1,2})([\w.-]+)(?:=(.*))?$/s;
const assignment = /^([a-z_][\w.-]*)=(.*)$/is;
const scriptOption = /^-[a-z]*c$/i;
const quotedWord = /^(?:'([^']*)'|"((?:[^"\\]|\\["\\])*)")$/;

const table = (value: unknown): ConfigTable =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ConfigTable)
    : {};

export const reviewText = (value: string) =>
  value.replace(
    /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );

function secretValue(key: string, value: string) {
  return secretKey.test(key) && literal.test(value) ? mask : value;
}

function authorizationValue(key: string, value: string) {
  if (key.toLowerCase() !== 'authorization') return secretValue(key, value);
  const scheme = /^(Bearer |Basic )(.+)$/i.exec(value);
  return scheme
    ? scheme[1] + secretValue(key, scheme[2]!)
    : secretValue(key, value);
}

function reviewUrl(value: string) {
  if (!/^https?:\/\//i.test(value) || expansion.test(value)) return value;
  return value
    .replace(
      /^([a-z][a-z\d+.-]*:\/\/[^:/?#@]+:)([^/?#@]+)(@)/i,
      (_, prefix: string, password: string, suffix: string) =>
        prefix + secretValue('password', password) + suffix,
    )
    .replace(
      /(\?)([\w.-]+)=([^#]*)/,
      (_, prefix: string, key: string, token: string) =>
        prefix + key + '=' + secretValue(key, token),
    );
}

function commandArguments(
  args: string[],
  depth: number,
  shellWords = false,
): string[] | undefined {
  const rendered = [];
  let credential: string | undefined;
  let script = false;
  let options = true;
  let beforeCommand = shellWords;
  const redact = (key: string, value: string) => {
    const quote = shellWords && quotedWord.exec(value);
    if (!quote) return secretValue(key, value);
    const plain = quote[1] ?? quote[2]!;
    const result = secretValue(key, plain);
    return result === plain ? value : value[0] + result + value[0];
  };
  for (const argument of args) {
    if (script) {
      const quote = shellWords && quotedWord.exec(argument);
      if (shellWords && !quote && /['"]/.test(argument)) return undefined;
      const source = quote
        ? (quote[1] ?? quote[2]!.replace(/\\(["\\])/g, '$1'))
        : argument;
      const command = shellCommand(source, depth + 1);
      if (command === undefined) return undefined;
      rendered.push(
        quote
          ? argument[0] +
              (quote[1] !== undefined
                ? command
                : command.replace(/[\\"]/g, '\\$&')) +
              argument[0]
          : command,
      );
      script = false;
      continue;
    }
    const variable = assignment.exec(argument);
    const [, name = '', value = ''] = variable ?? [];
    if (beforeCommand) {
      if (variable && /^\w+$/.test(name)) {
        rendered.push(name + '=' + redact(name, value));
      } else {
        beforeCommand = false;
        rendered.push(argument);
      }
      continue;
    }
    if (options && /^(?:-command|-encodedcommand|\/c)$/i.test(argument))
      return undefined;
    if (options && scriptOption.test(argument)) {
      script = true;
      credential = undefined;
      rendered.push(argument);
      continue;
    }
    if (argument === '--') options = false;
    const flag = options ? option.exec(argument) : null;
    const [, prefix = '', key = '', payload] = flag ?? [];
    const previous = credential;
    credential =
      flag && payload === undefined && secretKey.test(key) ? key : undefined;
    rendered.push(
      payload !== undefined
        ? prefix + key + '=' + redact(key, payload)
        : variable
          ? name + '=' + redact(name, value)
          : previous
            ? redact(previous, argument)
            : reviewUrl(argument),
    );
  }
  return script || beforeCommand ? undefined : rendered;
}

function shellCommand(command: string, depth = 0): string | undefined {
  if (depth > 4 || expansion.test(command) || /[$^%*?()[\]{}#!~]/.test(command))
    return undefined;
  const words = [
    ...command.matchAll(/(?:[^\s'"\\]+|'[^']*'|"(?:[^"\\]|\\["\\])*")+/g),
  ];
  let end = 0;
  const gaps = words.map(word => {
    const gap = command.slice(end, word.index);
    end = word.index + word[0].length;
    return gap;
  });
  const tail = command.slice(end);
  if (
    !/^[ \t]*$/.test(tail) ||
    gaps.some((gap, index) => !(index ? /^[ \t]+$/ : /^[ \t]*$/).test(gap)) ||
    words.some(([word]) => /[^\S \t]/u.test(word))
  )
    return undefined;
  const rendered = commandArguments(
    words.map(word => word[0]),
    depth,
    true,
  );
  return (
    rendered &&
    rendered.map((word, index) => gaps[index] + word).join('') + tail
  );
}

function hasExpansion(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return expansion.test(value);
  if (!value || typeof value !== 'object' || depth >= 32) return false;
  return Object.entries(value).some(
    ([key, item]) => expansion.test(key) || hasExpansion(item, depth + 1),
  );
}

export function reviewLaunch(config: ConfigTable, shell: boolean) {
  const { command, args, url } = config;
  const reviewed = { ...config };
  let requiresRawReview = false;
  if (shell && typeof command === 'string') {
    const rendered = shellCommand(command);
    reviewed.command = rendered ?? command;
    requiresRawReview = rendered === undefined;
  }
  if (Array.isArray(args)) {
    const rendered = args.every(arg => typeof arg === 'string')
      ? commandArguments(args, 0)
      : undefined;
    reviewed.args = rendered ?? args;
    requiresRawReview ||= rendered === undefined;
  }
  if (typeof url === 'string') reviewed.url = reviewUrl(url);
  for (const key of ['env', 'headers', 'http_headers']) {
    if (!(key in config)) continue;
    reviewed[key] = Object.fromEntries(
      Object.entries(table(config[key])).map(([name, value]) => [
        name,
        typeof value === 'string'
          ? key === 'env'
            ? secretValue(name, value)
            : authorizationValue(name, value)
          : value,
      ]),
    );
  }
  return {
    reviewed,
    requiresRawReview,
    containsShellExpansion: hasExpansion(config),
  };
}

function launchDetails(
  value: unknown,
  directory: string,
  shell: boolean,
): McpRepositoryLaunch {
  const {
    reviewed: config,
    requiresRawReview,
    containsShellExpansion,
  } = reviewLaunch(table(value), shell);
  const fields: McpRepositoryLaunch['fields'] = [];
  const add = (label: (typeof fields)[number]['label'], value: string) =>
    fields.push({ label, value: reviewText(value) });
  if (typeof config.command === 'string') add('Command', config.command);
  if (Array.isArray(config.args))
    for (const arg of config.args)
      if (typeof arg === 'string') add('Argument', arg);
  if (typeof config.cwd === 'string' || typeof config.command === 'string')
    add(
      'Working directory',
      typeof config.cwd === 'string' ? config.cwd : directory,
    );
  if (typeof config.url === 'string') add('URL', config.url);
  for (const [name, value] of Object.entries(table(config.env)))
    if (typeof value === 'string')
      add('Environment variable', name + '=' + value);
  for (const key of ['headers', 'http_headers'])
    for (const [name, value] of Object.entries(table(config[key])))
      if (typeof value === 'string') add('Header', name + ': ' + value);
  for (const name of [
    ...Object.values(table(config.env_http_headers)),
    ...(Array.isArray(config.env_vars) ? config.env_vars : []),
    config.bearer_token_env_var,
  ])
    if (typeof name === 'string') add('Environment variable', name);
  return {
    fields,
    ...(requiresRawReview ? { requiresRawReview } : {}),
    ...(containsShellExpansion ? { containsShellExpansion } : {}),
  };
}

export function serverLaunch(
  config: unknown,
  directory: string,
): McpRepositoryLaunch[] {
  return [launchDetails(config, directory, false)];
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
      const launch = launchDetails(handler, directory, true);
      if (typeof group.matcher === 'string') {
        launch.fields.unshift({
          label: 'Matcher',
          value: reviewText(group.matcher),
        });
        if (expansion.test(group.matcher)) launch.containsShellExpansion = true;
      }
      return {
        ...launch,
        kind:
          typeof handler.type === 'string'
            ? reviewText(handler.type) + ' hook'
            : 'Hook',
      };
    });
  });
}
