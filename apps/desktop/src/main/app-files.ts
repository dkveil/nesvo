import { existsSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import {
  aboutInfoSchema,
  saveTextFileSchema,
  type AboutInfo,
  type SavedTextFile,
} from '@nesvo/contracts';
import { logsDirectory } from './logging';

const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';
const BACKUP_FILE = /^nesvo\.sqlite\.backup-[0-9TZ-]+\.bak$/;

export const aboutInfo = (hostDirectory: string): AboutInfo =>
  aboutInfoSchema.parse({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    chrome: process.versions.chrome ?? '',
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    packaged: app.isPackaged,
    dataDirectory: app.getPath('userData'),
    hostDirectory,
    logsDirectory: logsDirectory(),
  });

const licenseCandidates = () =>
  app.isPackaged
    ? [
        join(dirname(process.execPath), NOTICES_FILE),
        join(dirname(process.execPath), '..', NOTICES_FILE),
      ]
    : [join(app.getAppPath(), '..', '..', NOTICES_FILE)];

export const openLicenses = async () => {
  const notices = licenseCandidates().find(file => existsSync(file));
  if (!notices) throw new Error('The license notices could not be found.');
  const failure = await shell.openPath(notices);
  if (failure) shell.showItemInFolder(notices);
};

export const showBackup = (hostDirectory: string, path: unknown) => {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('Invalid backup path');
  const target = resolve(path);
  if (
    dirname(target) !== resolve(hostDirectory) ||
    !BACKUP_FILE.test(basename(target)) ||
    !existsSync(target)
  )
    throw new Error('Invalid backup path');
  shell.showItemInFolder(target);
};

export const saveTextFile = async (
  window: BrowserWindow | null,
  input: unknown,
): Promise<SavedTextFile> => {
  const { defaultName, content } = saveTextFileSchema.parse(input);
  const options = {
    defaultPath: join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  const path = extname(result.filePath)
    ? result.filePath
    : `${result.filePath}.md`;
  writeFileSync(path, content, 'utf8');
  return { saved: true, path };
};
