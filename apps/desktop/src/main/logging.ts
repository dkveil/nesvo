import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { redactLogMessage } from '@nesvo/host';

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FILES = 5;
const MAX_LOG_ENTRY_CHARACTERS = 16 * 1024;

type LogLevel = 'info' | 'warn' | 'error';
type LogName = 'main' | 'host';

type RotatingLog = { write: (text: string) => void };

const attempt = (operation: () => void) => {
  try {
    operation();
  } catch {
    return;
  }
};

const createRotatingLog = (directory: string, name: LogName): RotatingLog => {
  const path = (index: number) =>
    join(directory, index === 0 ? `${name}.log` : `${name}.${index}.log`);
  let size = -1;
  const rotate = () => {
    attempt(() => unlinkSync(path(MAX_LOG_FILES - 1)));
    for (let index = MAX_LOG_FILES - 2; index >= 0; index -= 1)
      attempt(() => renameSync(path(index), path(index + 1)));
    size = 0;
  };
  return {
    write: text => {
      try {
        if (size < 0) {
          mkdirSync(directory, { recursive: true });
          try {
            size = statSync(path(0)).size;
          } catch {
            size = 0;
          }
        }
        const bytes = Buffer.byteLength(text);
        if (size > 0 && size + bytes > MAX_LOG_FILE_BYTES) rotate();
        appendFileSync(path(0), text);
        size += bytes;
      } catch {
        size = -1;
      }
    },
  };
};

let logDirectory = '';
let mirrorToConsole = true;
const logs = new Map<LogName, RotatingLog>();

export const initializeLogging = (directory: string, mirror: boolean) => {
  logDirectory = directory;
  mirrorToConsole = mirror;
  logs.set('main', createRotatingLog(directory, 'main'));
  logs.set('host', createRotatingLog(directory, 'host'));
};

export const logsDirectory = () => logDirectory;

export const stopLogging = () => {
  logs.clear();
  mirrorToConsole = false;
};

const formatEntry = (level: LogLevel, message: string) =>
  `${new Date().toISOString()} ${level.toUpperCase()} ${redactLogMessage(message).slice(0, MAX_LOG_ENTRY_CHARACTERS)}\n`;

const writeMain = (level: LogLevel, message: string) => {
  const entry = formatEntry(level, message);
  logs.get('main')?.write(entry);
  if (mirrorToConsole)
    (level === 'info' ? process.stdout : process.stderr).write(entry);
};

export const log = {
  info: (message: string) => writeMain('info', message),
  warn: (message: string) => writeMain('warn', message),
  error: (message: string) => writeMain('error', message),
};

export const writeHostOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
  if (!data.length) return;
  const entry = formatEntry(
    stream === 'stderr' ? 'warn' : 'info',
    `Local host produced ${stream} diagnostics.`,
  );
  logs.get('host')?.write(entry);
  if (mirrorToConsole) process.stderr.write(entry);
};
