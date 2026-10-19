#!/usr/bin/env node
// Controlled original-CLI fixture. It never calls a model or loads user settings.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  console.log('2.1.303-scoped-fixture');
  process.exit(0);
}
const id = process.env.NESVO_SESSION_ID;
if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Missing fixture process identity');
const directory = process.env.NESVO_TEST_CALLERS;
fs.writeFileSync(path.join(directory, `${id}.txt`), process.env.NESVO_AGENT_CONTEXT);
const settings = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]);
function hook(name, extra = {}) {
  const command = settings.hooks[name][0].hooks[0];
  const result = spawnSync(command.command, command.args, {
    windowsHide: true,
    input: JSON.stringify({
      hook_event_name: name,
      session_id: `fixture-${id}`,
      agent_id: '',
      ...extra,
    }),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (result.status !== 0) throw new Error('Fixture lifecycle helper failed');
}
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004hSCOPE_FIXTURE_READY\r\n');
hook('SessionStart', { source: 'startup' });
hook('Stop');
function submit(prompt) {
  hook('UserPromptSubmit', { prompt });
  if (prompt === 'spawn-child') {
    // Inherit only this managed process's scoped context. No owner pairing flag.
    const result = spawnSync(
      process.env.NESVO_TEST_CLIENT_BINARY,
      [
        'session',
        'create',
        'Scoped child',
        '--key',
        'agent-child-once',
        '--program',
        'claude',
        '--json',
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 },
    );
    if (result.status !== 0) throw new Error('Managed CLI child creation failed');
    fs.writeFileSync(path.join(directory, `${id}.child.json`), result.stdout);
  }
  process.stdout.write(`FIXTURE_RESPONSE ${prompt}\r\n`);
  hook('Stop');
}
let pending = '';
let draft = '';
process.stdin.on('data', text => {
  pending += text;
  while (pending.length) {
    if (pending.startsWith('\x1b[200~')) {
      const end = pending.indexOf('\x1b[201~', 6);
      if (end < 0) return;
      draft += pending.slice(6, end);
      pending = pending.slice(end + 6);
    } else if (/^[\r\n]/.test(pending)) {
      pending = pending.slice(1);
      const prompt = draft;
      draft = '';
      if (prompt) submit(prompt);
    } else if (pending[0] === '\x03') {
      pending = pending.slice(1);
      draft = '';
      hook('Stop');
    } else if (pending[0] === '\x1b') {
      const escape = pending.match(/^\x1b\[[0-9;?]*[A-Za-z~]/);
      if (!escape) return;
      pending = pending.slice(escape[0].length);
    } else {
      let end = pending.search(/[\x1b\r\n\x03]/);
      if (end < 0) end = pending.length;
      draft += pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
});
process.stdin.resume();
