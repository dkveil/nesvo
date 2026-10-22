#!/usr/bin/env node
const childProcess = require('node:child_process');
const path = require('node:path');

const spawnSync = childProcess.spawnSync;
const host = process.env.NESVO_SESSION_ID ?? '';
const conversation = host.replace(
  /^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/,
  '$1-$2-$3-$4-$5',
);
const resumeFlag = process.argv.indexOf('--resume');
const resumed = resumeFlag < 0 ? null : process.argv[resumeFlag + 1];

const withConversation = options => {
  if (typeof options?.input !== 'string' || !options.input.startsWith('{')) return options;
  const payload = JSON.parse(options.input);
  if (payload.session_id !== `fixture-${host}`) return options;
  payload.session_id = resumed ?? conversation;
  if (resumed && payload.hook_event_name === 'SessionStart' && payload.source === 'startup')
    payload.source = 'resume';
  return { ...options, input: JSON.stringify(payload) };
};

childProcess.spawnSync = (command, args, options) =>
  spawnSync(command, args, withConversation(options));

require(path.join(__dirname, 'scoped-agent.cjs'));
