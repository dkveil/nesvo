import { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const automaticPersistence =
  /\b(?:setLoginItemSettings|openAtLogin|SMAppService|LaunchAgents|LaunchDaemons|launchctl|schtasks|Register-ScheduledTask|New-ScheduledTask|osascript|AppleScript|JXA|xdotool|ydotool|AutoHotkey|wscript|cscript)\b|systemd[\\/]+user|systemctl\b.*\b(?:enable|link|preset|reenable)\b|CurrentVersion[\\/]+Run(?:Once)?\b|\bSoftware[\\/]+Microsoft[\\/]+Windows[\\/]+CurrentVersion[\\/]+Run(?:Once)?\b|\.config[\\/]+autostart|shell:startup|\bcrontab\b/i;

export function installTestCommandAudit() {
  const log = process.env.NESVO_TEST_COMMAND_LOG;
  if (process.env.NESVO_TEST_MODE !== '1' || !log) return;
  const prototype = ChildProcess.prototype as unknown as {
    spawn(options: { file: string; args: string[] }): number;
  };
  const spawn = prototype.spawn;
  prototype.spawn = function (options) {
    const forbidden = automaticPersistence.test(
      [options.file, ...options.args].join(' '),
    );
    const executable = options.file.split(/[\\/]/).at(-1);
    appendFileSync(log, JSON.stringify({ executable, forbidden }) + '\n');
    if (forbidden)
      throw new Error(
        'The test detected an automatic persistence or app automation command.',
      );
    return spawn.call(this, options);
  };
}
