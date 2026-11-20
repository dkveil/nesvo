import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

import {
  installCommandFor,
  renderInstallScript,
} from '@/releases/install-script';

const script = renderInstallScript('dkveil/nesvo', 'v0.0.1-alpha.1');

const hasShell = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe('install.sh', () => {
  it('builds the copyable command from the site origin', () => {
    expect(installCommandFor('https://nesvo.dev')).toBe(
      'curl -fsSL https://nesvo.dev/install.sh | sh',
    );
  });

  it('downloads the disk image for the processor from the resolved tag', () => {
    expect(script).toContain(
      'BASE_URL="https://github.com/dkveil/nesvo/releases/download/v0.0.1-alpha.1"',
    );
    expect(script).toContain('arm64) ASSET="Nesvo-macOS-arm64.dmg"');
    expect(script).toContain('ASSET="Nesvo-macOS-x64.dmg"');
    expect(script).toContain('sysctl.proc_translated');
    expect(renderInstallScript('dkveil/nesvo', 'v0.2.0')).toContain(
      'BASE_URL="https://github.com/dkveil/nesvo/releases/download/v0.2.0"',
    );
  });

  it('escapes shell metacharacters in the tag URL', () => {
    expect(renderInstallScript('dkveil/nesvo', 'v0.0.1-$USER')).toContain(
      'BASE_URL="https://github.com/dkveil/nesvo/releases/download/v0.0.1-%24USER"',
    );
  });

  it('verifies the SHA-256 checksum before installing', () => {
    const verify = script.indexOf('shasum -a 256');
    const install = script.indexOf('ditto "$MOUNT_DIR');

    expect(script).toContain('SHA256SUMS.txt');
    expect(script).toContain('checksum mismatch');
    expect(verify).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(verify);
  });

  it('clears quarantine only from the installed app after verifying the download', () => {
    const check = script.indexOf('checksum mismatch for');
    const copy = script.indexOf(
      'ditto "$MOUNT_DIR/$APP_NAME" "$TARGET_DIR/$APP_NAME"',
    );
    const remove = script.indexOf(
      'xattr -drs com.apple.quarantine "$TARGET_DIR/$APP_NAME"',
    );

    expect(check).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(check);
    expect(remove).toBeGreaterThan(copy);
    expect(script).not.toMatch(/xattr\s+-(?:w|c)|spctl|sudo/);
    expect(script).toContain(
      'System Settings > Privacy & Security > Open Anyway',
    );
  });

  it.skipIf(!hasShell)('is valid POSIX shell', () => {
    const result = spawnSync('sh', ['-n'], { input: script });

    expect(result.stderr.toString()).toBe('');
    expect(result.status).toBe(0);
  });
});
