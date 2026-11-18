import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const claudeBrowserExtensionId = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const maxProfiles = 64;

export const claudeBrowserServerName = 'claude-in-chrome';

export const unattendedBrowserTools = [
  'tabs_context_mcp',
  'tabs_create_mcp',
  'navigate',
  'read_page',
  'get_page_text',
  'find',
  'read_console_messages',
  'read_network_requests',
].map(tool => `mcp__${claudeBrowserServerName}__${tool}`);

const browserDataDirectories = (): string[] => {
  const override = process.env.NESVO_TEST_BROWSER_DATA_DIRS;
  if (override != null) return override.split(delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const local =
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return [join(local, 'Google', 'Chrome', 'User Data')];
  }
  if (process.platform === 'darwin')
    return [
      join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    ];
  return [
    join(homedir(), '.config', 'google-chrome'),
    join(homedir(), '.config', 'chromium'),
  ];
};

const isDirectory = (path: string) =>
  stat(path).then(
    info => info.isDirectory(),
    () => false,
  );

const profileHasExtension = async (root: string): Promise<boolean> => {
  const profiles = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const profile of profiles.slice(0, maxProfiles))
    if (
      profile.isDirectory() &&
      (await isDirectory(
        join(root, profile.name, 'Extensions', claudeBrowserExtensionId),
      ))
    )
      return true;
  return false;
};

export const claudeBrowserExtensionInstalled = async (): Promise<boolean> => {
  for (const root of browserDataDirectories())
    if (await profileHasExtension(root)) return true;
  return false;
};
