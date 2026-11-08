import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  hostConnectSchema,
  sshComputerInputSchema,
  type SshComputerInput,
} from '@nesvo/contracts';

function shellArgument(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function configurationArgument(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function spawnSshBridge(
  input: SshComputerInput,
  expectedInstanceId?: string,
): ChildProcessWithoutNullStreams {
  const target = sshComputerInputSchema.parse(input);
  const handshake = hostConnectSchema.parse({
    type: 'connect',
    protocolVersion: 1,
    expectedInstanceId,
  });
  const settings = [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    'UpdateHostKeys=no',
    'VerifyHostKeyDNS=no',
    'NoHostAuthenticationForLocalhost=no',
    'PreferredAuthentications=publickey',
    'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no',
    'ForwardAgent=no',
    'ForwardX11=no',
    'PermitLocalCommand=no',
    'ClearAllForwardings=yes',
    'ControlMaster=no',
    'ControlPath=none',
    'ControlPersist=no',
    'RemoteCommand=none',
    'StdinNull=no',
    'ForkAfterAuthentication=no',
    'EscapeChar=none',
    'ConnectTimeout=10',
    'ConnectionAttempts=1',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=3',
    ...(target.identityFile ? ['IdentitiesOnly=yes'] : []),
    ...(target.knownHostsFile
      ? [`UserKnownHostsFile=${configurationArgument(target.knownHostsFile)}`]
      : []),
  ];
  const environment = [
    `NESVO_RUNTIME_DIR=${target.runtimeDirectory}`,
    ...(handshake.expectedInstanceId
      ? [`NESVO_EXPECTED_INSTANCE_ID=${handshake.expectedInstanceId}`]
      : []),
  ];
  const command = [
    'exec /usr/bin/env',
    ...environment.map(shellArgument),
    'node',
    shellArgument(target.entryPath),
    'connect',
  ].join(' ');
  return spawn(
    process.platform === 'win32' ? 'ssh.exe' : 'ssh',
    [
      '-T',
      ...settings.flatMap(value => ['-o', value]),
      '-p',
      String(target.port),
      ...(target.username ? ['-l', target.username] : []),
      ...(target.identityFile ? ['-i', target.identityFile] : []),
      '--',
      target.hostname,
      command,
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
    },
  );
}
