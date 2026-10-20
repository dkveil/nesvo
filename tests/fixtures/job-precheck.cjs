// Owned deterministic command fixture. Never calls a provider or edits source.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [mode, directory, role, literal] = process.argv.slice(2);
if (mode === 'probe') {
  const running = ['root', 'child', 'grandchild'].map(name => {
    const pid = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8')).pid;
    if (process.platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    if (process.platform === 'darwin') {
      const status = cp.spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      });
      if (status.status === 1 && !status.stdout.trim()) return false;
      if (status.error || status.status !== 0) throw new Error('Owned process observation failed');
      return !status.stdout.trim().startsWith('Z');
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  });
  console.log(JSON.stringify({ running }));
  process.exit(0);
}
if (Object.keys(process.env).some(key => /^(NESVO_|POCKET_)/i.test(key))) {
  throw new Error('Ambient Nesvo context leaked into a precheck');
}
if (literal !== 'literal $(x); & łódź "quoted"' || process.env.CHECK_LITERAL !== literal) {
  throw new Error('Literal arguments/environment changed');
}
fs.mkdirSync(directory, { recursive: true });
if (role === 'root') fs.appendFileSync(path.join(directory, 'effects.log'), `${mode}\n`);
if (mode.startsWith('tree-')) {
  fs.writeFileSync(path.join(directory, `${role}.json`), JSON.stringify({ pid: process.pid }));
  const next = role === 'root' ? 'child' : role === 'child' ? 'grandchild' : null;
  if (next) {
    cp.spawn(process.execPath, [__filename, mode, directory, next, literal], {
      stdio: 'ignore',
      env: process.env,
      detached: false,
    });
  }
  if (mode === 'tree-pass' && role === 'root') {
    setInterval(() => {
      if (fs.existsSync(path.join(directory, 'grandchild.json'))) {
        console.log('Passed with live ordinary descendants');
        process.exit(0);
      }
    }, 20);
  } else setInterval(() => {}, 1000);
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
