import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkLaptopPolicy } from '@nesvo/contracts';

const windowsJoin =
  /^[ \t]*(?:AzureAdJoined|DomainJoined)[ \t]*:[ \t]*YES[ \t]*\r?$/im;
const macEnrollment =
  /^[ \t]*MDM enrollment[ \t]*:[ \t]*Yes(?:[ \t]*\([^\r\n]*\))?[ \t]*\r?$/im;

export function isManagedDevice(platform: NodeJS.Platform, status: string) {
  if (platform === 'win32') return windowsJoin.test(status);
  if (platform === 'darwin') return macEnrollment.test(status);
  return false;
}

function detectManagedDevice(): Promise<boolean> {
  if (
    process.env.NESVO_TEST_MODE === '1' ||
    process.env.NESVO_SMOKE_TEST === '1'
  )
    return Promise.resolve(process.env.NESVO_TEST_WORK_LAPTOP_MANAGED === '1');
  const platform = process.platform;
  const root = process.env.SystemRoot;
  const command =
    platform === 'win32' && root
      ? { file: join(root, 'System32', 'dsregcmd.exe'), args: ['/status'] }
      : platform === 'darwin'
        ? { file: '/usr/bin/profiles', args: ['status', '-type', 'enrollment'] }
        : null;
  if (!command) return Promise.resolve(false);
  return new Promise(resolve => {
    execFile(
      command.file,
      command.args,
      {
        timeout: 3000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout) => resolve(!error && isManagedDevice(platform, stdout)),
    );
  });
}

export async function workLaptopPolicy(
  directory: string,
  detect = detectManagedDevice,
) {
  const preference = join(directory, 'work-laptop-mode');
  const enforced =
    process.env.NESVO_WORK_LAPTOP_MODE === '1' ||
    !!lstatSync(join(directory, 'work-laptop-policy'), {
      throwIfNoEntry: false,
    });
  const savedFile = lstatSync(preference, { throwIfNoEntry: false });
  const saved = savedFile
    ? !savedFile.isFile() || readFileSync(preference, 'utf8').trim() !== 'off'
    : undefined;
  let automaticallyEnabled =
    !enforced && saved === undefined && (await detect());
  let requested = enforced || (saved ?? automaticallyEnabled);
  const enabled = requested;
  const status = (): WorkLaptopPolicy => ({
    enabled,
    requested,
    enforced,
    automaticallyEnabled,
  });
  return {
    enabled,
    status,
    set(value: boolean) {
      if (enforced) throw new Error('Work laptop mode is enforced by policy.');
      const temporary = preference + '.tmp';
      writeFileSync(temporary, value ? 'on' : 'off', { mode: 0o600 });
      renameSync(temporary, preference);
      automaticallyEnabled = false;
      requested = value;
      return status();
    },
  };
}
