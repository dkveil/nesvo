import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

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

const describeDetail = (detail: unknown): string => {
  if (detail instanceof Error)
    return detail.stack ?? `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
};

const formatEntry = (level: LogLevel, message: string, detail?: unknown) => {
  const body =
    detail === undefined ? message : `${message} ${describeDetail(detail)}`;
  return `${new Date().toISOString()} ${level.toUpperCase()} ${body.slice(
    0,
    MAX_LOG_ENTRY_CHARACTERS,
  )}\n`;
};

const writeMain = (level: LogLevel, message: string, detail?: unknown) => {
  const entry = formatEntry(level, message, detail);
  logs.get('main')?.write(entry);
  if (mirrorToConsole || !logs.has('main'))
    (level === 'info' ? process.stdout : process.stderr).write(entry);
};

export const log = {
  info: (message: string, detail?: unknown) =>
    writeMain('info', message, detail),
  warn: (message: string, detail?: unknown) =>
    writeMain('warn', message, detail),
  error: (message: string, detail?: unknown) =>
    writeMain('error', message, detail),
};

export const writeHostOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
  const text = data.toString('utf8');
  const entry = text
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(line =>
      formatEntry(
        stream === 'stderr' ? 'warn' : 'info',
        line.slice(0, MAX_LOG_ENTRY_CHARACTERS),
      ),
    )
    .join('');
  if (!entry) return;
  logs.get('host')?.write(entry);
  if (mirrorToConsole || !logs.has('host')) process.stderr.write(entry);
};
