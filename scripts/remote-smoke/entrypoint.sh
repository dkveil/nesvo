#!/bin/bash
set -euo pipefail

mkdir -p /run/sshd /run/nesvo-host /run/ssh-host /var/lib/nesvo /home/node/.ssh
chmod 700 /run/nesvo-host /var/lib/nesvo /home/node/.ssh
cp /smoke-authorized-key.pub /home/node/.ssh/authorized_keys
chmod 600 /home/node/.ssh/authorized_keys
chown -R node:node /run/nesvo-host /var/lib/nesvo /home/node/.ssh
ssh-keygen -q -t ed25519 -N '' -f /run/ssh-host/host_ed25519

cat > /run/sshd_config <<'EOF'
Port 22
ListenAddress 0.0.0.0
HostKey /run/ssh-host/host_ed25519
AuthorizedKeysFile /home/node/.ssh/authorized_keys
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
UsePAM no
AllowUsers node
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PrintMotd no
PrintLastLog no
LogLevel ERROR
EOF

export HOME=/home/node
export NESVO_DATA_DIR=/var/lib/nesvo
export NESVO_RUNTIME_DIR=/run/nesvo-host
export NESVO_CLAUDE_EXECUTABLE=/workspace/apps/host/tests/claude-fixture.mjs
export NESVO_CODEX_EXECUTABLE=/workspace/apps/host/tests/codex-fixture.mjs
export NESVO_FIXTURE_PID_FILE=/var/lib/nesvo/claude-pids.json
export NESVO_CODEX_FIXTURE_PID_FILE=/var/lib/nesvo/codex-pids.json
export NESVO_CODEX_FIXTURE_PID_DIR=/var/lib/nesvo/worker-pids
export NESVO_CODEX_FIXTURE_STATE_DIR=/var/lib/nesvo/codex-state
export NESVO_CODEX_FIXTURE_RUN_LOG=/var/lib/nesvo/turns.jsonl
export CLAUDE_CONFIG_DIR=/var/lib/nesvo/claude-config
export CODEX_HOME=/var/lib/nesvo/codex-config
export NESVO_TEST_SKILLS_HOME=/var/lib/nesvo/skills-home

mkdir -p "$CLAUDE_CONFIG_DIR/skills/remote-smoke" "$CODEX_HOME" "$NESVO_TEST_SKILLS_HOME" /var/lib/nesvo/.git
printf '%s\n' '---' 'name: Remote smoke instructions' 'description: Metadata from the isolated SSH fixture host.' '---' 'REMOTE_SMOKE_INSTRUCTIONS' > "$CLAUDE_CONFIG_DIR/skills/remote-smoke/SKILL.md"
chown -R node:node /var/lib/nesvo

daemon_pid=''
ssh_pid=''
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$daemon_pid" ]]; then kill -TERM "$daemon_pid" 2>/dev/null || true; fi
  if [[ -n "$ssh_pid" ]]; then kill -TERM "$ssh_pid" 2>/dev/null || true; fi
  if [[ -n "$daemon_pid" ]]; then wait "$daemon_pid" 2>/dev/null || true; fi
  if [[ -n "$ssh_pid" ]]; then wait "$ssh_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

setpriv --reuid=node --regid=node --init-groups node /workspace/apps/host/dist/main.js daemon &
daemon_pid=$!
printf '%s\n' "$daemon_pid" > /run/nesvo-daemon.pid
/usr/sbin/sshd -D -e -f /run/sshd_config &
ssh_pid=$!
wait -n "$daemon_pid" "$ssh_pid"
