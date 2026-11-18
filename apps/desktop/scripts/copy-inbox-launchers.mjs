import { chmod, copyFile } from 'node:fs/promises';

for (const name of ['nesvo', 'nesvo.cmd']) {
  const source = new URL(`../resources/inbox-cli/${name}`, import.meta.url);
  const destination = new URL(`../dist/inbox-cli/${name}`, import.meta.url);
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}
