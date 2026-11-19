import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Provider, TerminalResume } from '@nesvo/contracts';

type TerminalCommand = Omit<TerminalResume, 'provider'>;

export type TerminalLaunch = {
  terminal: string;
  command: string;
  args: string[];
  cwd: string;
  script?: string;
};

type Locate = (name: string) => string | null;

const LINUX_TERMINALS: {
  name: string;
  label: string;
  args: (resume: TerminalCommand) => string[];
}[] = [
  {
    name: 'x-terminal-emulator',
    label: 'Terminal',
    args: resume => ['-e', resume.executable, ...resume.args],
  },
  {
    name: 'gnome-terminal',
    label: 'GNOME Terminal',
    args: resume => [
      `--working-directory=${resume.directory}`,
      '--',
      resume.executable,
      ...resume.args,
    ],
  },
  {
    name: 'konsole',
    label: 'Konsole',
    args: resume => [
      '--workdir',
      resume.directory,
      '-e',
      resume.executable,
      ...resume.args,
    ],
  },
  {
    name: 'xfce4-terminal',
    label: 'Xfce Terminal',
    args: resume => [
      '--working-directory',
      resume.directory,
      '-x',
      resume.executable,
      ...resume.args,
    ],
  },
  {
    name: 'xterm',
    label: 'XTerm',
    args: resume => ['-e', resume.executable, ...resume.args],
  },
];

export const locateExecutable: Locate = name => {
  const folders = [
    ...(process.env.PATH ?? '').split(delimiter),
    ...(process.platform === 'win32' && process.env.LOCALAPPDATA
      ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')]
      : []),
  ].filter(Boolean);
  for (const folder of folders) {
    const candidate = join(folder, name);
    if (lstatSync(candidate, { throwIfNoEntry: false })) return candidate;
  }
  return null;
};

export const planTerminalLaunch = (
  resume: TerminalCommand,
  platform: NodeJS.Platform,
  locate: Locate,
): TerminalLaunch => {
  const cwd = resume.directory;
  if (platform === 'win32') {
    const windowsTerminal = cwd.includes(';') ? null : locate('wt.exe');
    const shell = ['cmd.exe', '/k', resume.executable, ...resume.args];
    if (windowsTerminal)
      return {
        terminal: 'Windows Terminal',
        command: windowsTerminal,
        args: ['-d', cwd, ...shell],
        cwd,
      };
    return {
      terminal: 'Command Prompt',
      command: 'cmd.exe',
      args: shell.slice(1),
      cwd,
    };
  }
  if (platform === 'darwin')
    return {
      terminal: 'Terminal',
      command: 'open',
      args: ['-a', 'Terminal'],
      cwd,
      script: `#!/bin/sh\nrm -f -- "$0"\n${resume.commandLine}\n`,
    };
  for (const candidate of LINUX_TERMINALS) {
    const path = locate(candidate.name);
    if (path)
      return {
        terminal: candidate.label,
        command: path,
        args: candidate.args(resume),
        cwd,
      };
  }
  throw new Error(
    'No terminal application was found. Install a terminal emulator or copy the command instead.',
  );
};

const writeScript = (content: string) => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'nesvo-terminal-')),
    'resume.command',
  );
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
};

export const launchTerminal = async (
  resume: TerminalCommand,
  recordTo?: string,
  environment?: NodeJS.ProcessEnv,
): Promise<string> => {
  if (!statSync(resume.directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(
      'The session folder is missing on this computer. Restore it before opening a terminal.',
    );
  const plan = planTerminalLaunch(
    resume,
    process.platform,
    process.platform === 'win32' && environment ? () => null : locateExecutable,
  );
  if (recordTo) {
    appendFileSync(recordTo, JSON.stringify(plan) + '\n');
    return plan.terminal;
  }
  const args = plan.script
    ? [...plan.args, writeScript(plan.script)]
    : plan.args;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, args, {
      cwd: plan.cwd,
      env: environment ? { ...process.env, ...environment } : undefined,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return plan.terminal;
};

const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";

export function launchMcpTerminal(
  provider: Provider,
  directory: string,
  profileDirectory?: string,
  recordTo?: string,
) {
  const claude = provider === 'Claude Code';
  const executable = claude ? 'claude' : 'codex';
  const variable = claude ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const profile = profileDirectory
    ? variable + '=' + shellQuote(profileDirectory) + ' '
    : '';
  return launchTerminal(
    {
      directory,
      executable,
      args: [],
      commandLine:
        'cd ' + shellQuote(directory) + ' && ' + profile + executable,
    },
    recordTo,
    profileDirectory ? { [variable]: profileDirectory } : undefined,
  );
}
