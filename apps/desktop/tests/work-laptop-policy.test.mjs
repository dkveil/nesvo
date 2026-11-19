import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isManagedDevice,
  workLaptopPolicy,
} from '../src/main/work-laptop-policy.ts';

test('device management detection reads the OS device fields', () => {
  assert.equal(
    isManagedDevice('win32', 'AzureAdJoined : YES\r\nDomainJoined : NO'),
    true,
  );
  assert.equal(
    isManagedDevice('win32', 'AzureAdJoined : NO\r\nDomainJoined : YES'),
    true,
  );
  assert.equal(
    isManagedDevice('win32', 'AzureAdJoined : NO\r\nWorkplaceJoined : YES'),
    false,
  );
  assert.equal(
    isManagedDevice('darwin', 'MDM enrollment: Yes (User Approved)'),
    true,
  );
  assert.equal(
    isManagedDevice('darwin', 'Enrolled via DEP: Yes\nMDM enrollment: No'),
    false,
  );
  assert.equal(isManagedDevice('linux', 'MDM enrollment: Yes'), false);
});

test('managed devices start restricted and keep an explicit local override', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nesvo-test-work-laptop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = await workLaptopPolicy(directory, async () => true);
  assert.deepEqual(policy.status(), {
    enabled: true,
    requested: true,
    enforced: false,
    automaticallyEnabled: true,
  });
  assert.equal(policy.set(false).requested, false);
  const reopened = await workLaptopPolicy(directory, async () => true);
  assert.equal(reopened.enabled, false);
  assert.equal(reopened.status().automaticallyEnabled, false);

  await writeFile(join(directory, 'work-laptop-mode'), '');
  const previous = await workLaptopPolicy(directory, async () => false);
  assert.equal(previous.enabled, true);
  assert.equal(previous.status().automaticallyEnabled, false);

  await writeFile(join(directory, 'work-laptop-policy'), '');
  const enforced = await workLaptopPolicy(directory, async () => false);
  assert.equal(enforced.status().enforced, true);
  assert.throws(() => enforced.set(false), /enforced by policy/);
});
