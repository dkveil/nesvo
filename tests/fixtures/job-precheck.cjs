// Owned deterministic command fixture. Never calls a provider or edits source.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const [requestedMode, directory, role, literal] = process.argv.slice(2);
let mode = requestedMode;
if (Object.keys(process.env).some(key => /^(NESVO_|POCKET_)/i.test(key))) {
  throw new Error('Ambient Nesvo context leaked into a precheck');
}
if (literal !== 'literal $(x); & łódź "quoted"' || process.env.CHECK_LITERAL !== literal) {
  throw new Error('Literal arguments/environment changed');
}
fs.mkdirSync(directory, { recursive: true });
if (role === 'root') fs.appendFileSync(path.join(directory, 'effects.log'), `${mode}\n`);
if (role === 'root' && mode.startsWith('generation-')) {
  const counter = path.join(directory, 'counter.json');
  const count = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, 'utf8')).count + 1 : 1;
  fs.writeFileSync(counter, JSON.stringify({ count }));
  // The approved command is immutable; owned state selects only the second outcome.
  mode = count === 1 ? 'pass' : mode.slice('generation-'.length);
  if (mode.startsWith('tree')) mode = 'tree-cancel';
}
if (mode.startsWith('tree-')) {
  const address = `127.0.0.1:${process.env.TREE_PORT}`;
  const observer = net.connect(Number(process.env.TREE_PORT), '127.0.0.1', () => {
    observer.write(`${role}\n`);
    cp.spawn(process.env.TREE_PROGRAM, ['tree', address, 'child', 'grandchild'], {
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
  });
  observer.on('data', () => {
    if (mode === 'tree-pass') process.exit(0);
  });
  observer.on('error', () => process.exit(1));
  observer.on('close', () => process.exit(0));
} else if (mode === 'hold') {
  setInterval(() => {
    if (fs.existsSync(path.join(directory, 'release'))) {
      console.log('Gate released');
      process.exit(0);
    }
  }, 20);
} else if (mode === 'flood') {
  process.stdout.write('x'.repeat(64 * 1024));
  setInterval(() => {}, 1000);
} else {
  console.log(`\u001b[32m${literal}\n${mode}`);
  process.exit(mode === 'skip' ? 10 : mode === 'fail' ? 7 : 0);
}
