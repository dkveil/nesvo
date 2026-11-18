import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findImportLink,
  normalizeShareOrigin,
  parseImportLink,
} from '../src/main/share-link.ts';
import { buildWorkflowShareDeepLink } from '../../../packages/contracts/src/workflow-share.ts';

const allowed = ['https://nesvo.dev', 'http://127.0.0.1:4555'];
const link = (query, base = 'nesvo://import-workflow') => `${base}?${query}`;
const origin = encodeURIComponent('https://nesvo.dev');
const id = 'Ab3_x-9Q'.repeat(4);
const other = 'Zy8-w_7P'.repeat(4);

test('import links accept a well-formed share from an allowed origin', () => {
  assert.deepEqual(
    parseImportLink(link(`share=${id}&origin=${origin}`), allowed),
    { ok: true, shareId: id, origin: 'https://nesvo.dev' },
  );
  assert.deepEqual(
    parseImportLink(
      link(`origin=https://Nesvo.dev&share=${id}`, 'NESVO://Import-Workflow/'),
      allowed,
    ),
    { ok: true, shareId: id, origin: 'https://nesvo.dev' },
  );
  assert.deepEqual(
    parseImportLink(
      link(`share=${id}&origin=${encodeURIComponent('http://127.0.0.1:4555')}`),
      allowed,
    ),
    { ok: true, shareId: id, origin: 'http://127.0.0.1:4555' },
  );
  assert.deepEqual(
    parseImportLink(
      buildWorkflowShareDeepLink({ id, origin: 'https://nesvo.dev' }),
      allowed,
    ),
    { ok: true, shareId: id, origin: 'https://nesvo.dev' },
  );
});

test('import links refuse other actions, malformed IDs and foreign origins', () => {
  const refused = [
    link(`share=${id}&origin=${origin}`, 'nesvo://open-session'),
    link(`share=${id}&origin=${origin}`, 'nesvo://import-workflow/extra'),
    link(`share=${id}&origin=${origin}`, 'https://import-workflow'),
    link(`share=abcdef&origin=${origin}`),
    link(`share=${id.slice(1)}&origin=${origin}`),
    link(`share=abc/def/ghi&origin=${origin}`),
    link(`share=${'a'.repeat(33)}&origin=${origin}`),
    link(`share=${id}&origin=${encodeURIComponent('https://evil.example')}`),
    link(`share=${id}&origin=${encodeURIComponent('http://nesvo.dev')}`),
    link(`share=${id}&origin=${encodeURIComponent('https://nesvo.dev/path')}`),
    link(`share=${id}&origin=${encodeURIComponent('https://user@nesvo.dev')}`),
    link(`share=${id}&share=${other}&origin=${origin}`),
    link(`share=${id}&origin=${origin}&run=1`),
    link(`share=${id}`),
    `nesvo://import-workflow?share=${id}&origin=${origin}#fragment`,
    `nesvo://user:secret@import-workflow?share=${id}&origin=${origin}`,
    `nesvo://import-workflow:8080?share=${id}&origin=${origin}`,
    'nesvo:',
    'not a link',
    link(`share=${id}&origin=${origin}&pad=${'x'.repeat(2100)}`),
  ];
  for (const value of refused) {
    const parsed = parseImportLink(value, allowed);
    assert.equal(parsed.ok, false, value.slice(0, 120));
    assert.ok(parsed.message.length > 0);
  }
});

test('share origins accept https and loopback http only', () => {
  assert.equal(normalizeShareOrigin('https://nesvo.dev/'), 'https://nesvo.dev');
  assert.equal(
    normalizeShareOrigin(' https://Share.Example.com:8443 '),
    'https://share.example.com:8443',
  );
  assert.equal(
    normalizeShareOrigin('http://localhost:3000'),
    'http://localhost:3000',
  );
  for (const value of [
    'http://example.com',
    'ftp://nesvo.dev',
    'https://nesvo.dev/api',
    'https://nesvo.dev/?a=1',
    'https://a:b@nesvo.dev',
    'nesvo.dev',
  ])
    assert.equal(normalizeShareOrigin(value), null, value);
});

test('the launch arguments yield the first nesvo link', () => {
  assert.equal(
    findImportLink([
      'nesvo.exe',
      '--flag',
      'NESVO://import-workflow?share=a',
      'nesvo://second',
    ]),
    'NESVO://import-workflow?share=a',
  );
  assert.equal(findImportLink(['nesvo.exe', '--allow-file-access']), null);
});
