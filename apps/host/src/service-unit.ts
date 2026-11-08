import { posix } from 'node:path';

type ServiceUnitInput = {
  nodePath: string;
  entryPath: string;
  directory: string;
  runtimeDirectory: string;
  path: string;
};

function validateValue(value: string, name: string, limit: number) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limit ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new Error(
      `${name} must be nonempty and contain no control characters.`,
    );
}

function unitWord(value: string) {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')}"`;
}

export function renderServiceUnit(input: ServiceUnitInput): string {
  for (const name of [
    'nodePath',
    'entryPath',
    'directory',
    'runtimeDirectory',
  ] as const) {
    validateValue(input[name], name, 4096);
    if (!posix.isAbsolute(input[name]))
      throw new Error(`${name} must be an absolute Linux path.`);
  }
  if (/['"\\]/.test(input.nodePath) || input.nodePath.endsWith('/'))
    throw new Error(
      'The Node executable path must not contain quotes or backslashes or end with a slash. Use a standard absolute Node path supported by systemd.',
    );
  validateValue(input.path, 'PATH', 32768);
  if (posix.resolve(input.directory) === posix.resolve(input.runtimeDirectory))
    throw new Error('Data and runtime directories must be separate.');
  return [
    '[Unit]',
    'Description=Nesvo host',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${unitWord(`:${input.nodePath}`)} ${unitWord(input.entryPath)} daemon`,
    `Environment=${unitWord(`NESVO_DATA_DIR=${input.directory}`)}`,
    `Environment=${unitWord(`NESVO_RUNTIME_DIR=${input.runtimeDirectory}`)}`,
    `Environment=${unitWord(`PATH=${input.path}`)}`,
    'UMask=0077',
    'StandardInput=null',
    'StandardOutput=journal',
    'StandardError=journal',
    'KillMode=mixed',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30s',
    'SendSIGKILL=yes',
    'Restart=on-failure',
    'RestartSec=3s',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
