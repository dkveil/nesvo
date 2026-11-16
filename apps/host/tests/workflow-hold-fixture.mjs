import { writeFileSync } from 'node:fs';

const [pidPath, seconds] = process.argv.slice(2);
writeFileSync(pidPath, `${process.pid}\n`);
setTimeout(() => undefined, Number(seconds) * 1_000);
