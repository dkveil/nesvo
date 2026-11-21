import assert from 'node:assert/strict';
import { endianness } from 'node:os';
import { test } from 'node:test';
import {
  parseNetstat,
  parseProcTcp,
  parseTasklist,
} from '../src/running-apps/listeners.ts';
import { selectListenerAncestry } from '../src/running-apps/windows-processes.ts';

test('Windows listener discovery reads both families and excludes non-loopback or connected sockets', () => {
  const netstat = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:4173           0.0.0.0:0              LISTENING       8804',
    '  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       9012',
    '  TCP    [::]:3000              [::]:0                 LISTENING       7008',
    '  TCP    [::1]:8080             [::]:0                 ABHÖREN         7010',
    '  TCP    10.0.0.2:5300          0.0.0.0:0              LISTENING       9012',
    '  TCP    127.0.0.1:54101        127.0.0.1:4173         ESTABLISHED     4500',
    '  TCP    127.0.0.1:77           0.0.0.0:0              LISTENING       0',
    '  UDP    0.0.0.0:4173           *:*                                    8804',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(netstat), [
    { address: '0.0.0.0', port: 4173, pid: 8804 },
    { address: '127.0.0.1', port: 5432, pid: 9012 },
    { address: '::', port: 3000, pid: 7008 },
    { address: '::1', port: 8080, pid: 7010 },
  ]);
  assert.deepEqual(
    parseTasklist(
      '"node.exe","8804","Console","1","8,710 K"\r\n"Database service.exe","9012","Services","0","20,000 K"\r\n',
    ),
    new Map([
      [8804, 'node.exe'],
      [9012, 'Database service.exe'],
    ]),
  );
});

test('Linux TCP tables decode loopback and wildcard listeners with their kernel inodes', () => {
  const le = endianness() === 'LE';
  const loopback = le ? '0100007F' : '7F000001';
  const loopback6 = le
    ? '00000000000000000000000001000000'
    : '00000000000000000000000000000001';
  const line = (address, port, state, inode) =>
    '  0: ' +
    address +
    ':' +
    port +
    ' 00000000:0000 ' +
    state +
    ' 00000000:00000000 00:00000000 00000000 1000 0 ' +
    inode;
  const output = [
    line(loopback, '104D', '0A', '1234'),
    line(loopback6, '1F90', '0A', '1235'),
    line('00000000', '1538', '0A', '1236'),
    line(loopback, 'DE30', '01', '1237'),
    line('01010001', '104D', '0A', '1238'),
  ].join('\n');
  assert.deepEqual(parseProcTcp(output), [
    { address: '127.0.0.1', port: 4173, inode: '1234' },
    { address: '::1', port: 8080, inode: '1235' },
    { address: '0.0.0.0', port: 5432, inode: '1236' },
  ]);
});

test('Windows listener ancestry maps recorded CIM output to the scan contract', () => {
  const recordedSnapshot =
    '[{"pid":0,"parent":0,"name":"System Idle Process","startedAt":null},' +
    '{"pid":4,"parent":0,"name":"System","startedAt":null},' +
    '{"pid":700,"parent":4,"name":"services.exe","startedAt":1763712000123},' +
    '{"pid":4500,"parent":700,"name":"Zażółć app.exe","startedAt":1763712001000},' +
    '{"pid":8804,"parent":4500,"name":"node.exe","startedAt":1763712005500},' +
    '{"pid":9012,"parent":8804,"name":"db.exe","startedAt":null},' +
    '{"pid":9100,"parent":9999,"name":"orphan.exe","startedAt":1763712009000}]';
  const processes = JSON.parse(recordedSnapshot);
  assert.deepEqual(selectListenerAncestry(processes, [9012, 9100, 8804, 12]), [
    { pid: 9012, parent: 8804, name: 'db.exe', startedAt: null },
    {
      pid: 8804,
      parent: 4500,
      name: 'node.exe',
      startedAt: 1763712005500,
    },
    {
      pid: 4500,
      parent: 700,
      name: 'Zażółć app.exe',
      startedAt: 1763712001000,
    },
    {
      pid: 700,
      parent: 4,
      name: 'services.exe',
      startedAt: 1763712000123,
    },
    { pid: 4, parent: 0, name: 'System', startedAt: null },
    { pid: 9100, parent: 9999, name: 'orphan.exe', startedAt: 1763712009000 },
  ]);
});

test('Windows process ancestry stops at the depth limit and on cycles', () => {
  const chain = Array.from({ length: 40 }, (_, index) => ({
    pid: index + 1,
    parent: index + 2,
    name: 'p' + (index + 1),
    startedAt: null,
  }));
  assert.equal(selectListenerAncestry(chain, [1]).length, 32);
  const cycle = [
    { pid: 1, parent: 2, name: 'a', startedAt: null },
    { pid: 2, parent: 1, name: 'b', startedAt: null },
  ];
  assert.deepEqual(
    selectListenerAncestry(cycle, [1]).map(entry => entry.pid),
    [1, 2],
  );
});
