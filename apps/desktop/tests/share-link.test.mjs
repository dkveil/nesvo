import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findImportLink,
  normalizeShareOrigin,
  parseImportLink,
} from '../src/main/share-link.ts';

const allowed = ['https://nesvo.dev', 'http://127.0.0.1:4555'];
const link = (query, base = 'nesvo://import-workflow') => `${base}?${query}`;
const origin = encodeURIComponent('https://nesvo.dev');

test('import links accept a well-formed share from an allowed origin', () => {
  assert.deepEqual(
    parseImportLink(link(`share=Ab3_x-9Q&origin=${origin}`), allowed),
    { ok: true, shareId: 'Ab3_x-9Q', origin: 'https://nesvo.dev' },
  );
  assert.deepEqual(
    parseImportLink(
      link(
        'origin=https://nesvo.dev/&share=abcdef',
        'NESVO://Import-Workflow/',
      ),
      allowed,
    ),
    { ok: true, shareId: 'abcdef', origin: 'https://nesvo.dev' },
  );
  assert.deepEqual(
    parseImportLink(
      link(
        `share=abcdef&origin=${encodeURIComponent('http://127.0.0.1:4555')}`,
      ),
      allowed,
    ),
    { ok: true, shareId: 'abcdef', origin: 'http://127.0.0.1:4555' },
  );
});

test('import links refuse other actions, malformed IDs and foreign origins', () => {
  const refused = [
    link(`share=abcdef&origin=${origin}`, 'nesvo://open-session'),
    link(`share=abcdef&origin=${origin}`, 'nesvo://import-workflow/extra'),
    link(`share=abcdef&origin=${origin}`, 'https://import-workflow'),
    link(`share=abc&origin=${origin}`),
    link(`share=abc/def/ghi&origin=${origin}`),
    link(`share=${'a'.repeat(65)}&origin=${origin}`),
    link(`share=abcdef&origin=${encodeURIComponent('https://evil.example')}`),
    link(`share=abcdef&origin=${encodeURIComponent('http://nesvo.dev')}`),
    link(`share=abcdef&origin=${encodeURIComponent('https://nesvo.dev/path')}`),
    link(`share=abcdef&origin=${encodeURIComponent('https://user@nesvo.dev')}`),
    link(`share=abcdef&share=ghijkl&origin=${origin}`),
    link(`share=abcdef&origin=${origin}&run=1`),
    link('share=abcdef'),
    `nesvo://import-workflow?share=abcdef&origin=${origin}#fragment`,
    `nesvo://user:secret@import-workflow?share=abcdef&origin=${origin}`,
    `nesvo://import-workflow:8080?share=abcdef&origin=${origin}`,
    'nesvo:',
    'not a link',
    link(`share=abcdef&origin=${origin}&pad=${'x'.repeat(2100)}`),
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
