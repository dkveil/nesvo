import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkLaptopPolicy } from '@nesvo/contracts';

export function workLaptopPolicy(directory: string) {
  const preference = join(directory, 'work-laptop-mode');
  const enforced =
    process.env.NESVO_WORK_LAPTOP_MODE === '1' ||
    !!lstatSync(join(directory, 'work-laptop-policy'), {
      throwIfNoEntry: false,
    });
  let requested =
    enforced || !!lstatSync(preference, { throwIfNoEntry: false });
  const enabled = requested;
  const status = (): WorkLaptopPolicy => ({ enabled, requested, enforced });
  return {
    enabled,
    status,
    set(value: boolean) {
      if (enforced) throw new Error('Work laptop mode is enforced by policy.');
      if (value) writeFileSync(preference, '', { flag: 'a', mode: 0o600 });
      else rmSync(preference, { force: true });
      requested = value;
      return status();
    },
  };
}
