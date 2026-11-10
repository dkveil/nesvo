import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

writeFileSync(join(process.argv[2], 'hung-reader.pid'), String(process.pid));
setInterval(() => undefined, 60_000);
