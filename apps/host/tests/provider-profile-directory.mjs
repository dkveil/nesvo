import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function createProfileDirectory(path) {
  await mkdir(path);
  const directory = await realpath(path);
  if (process.platform === 'win32') {
    await promisify(execFile)(
      join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; $path = $env:NESVO_FIXTURE_PROFILE_DIR; $acl = Get-Acl -LiteralPath $path; $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $user) { $acl.SetOwner($user); Set-Acl -LiteralPath $path -AclObject $acl }",
      ],
      {
        env: { ...process.env, NESVO_FIXTURE_PROFILE_DIR: directory },
        timeout: 5000,
        windowsHide: true,
      },
    );
  }
  return directory;
}
