// Test-only validation of real CLI/MCP envelopes against the published contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Ajv = require('ajv');

const SCHEMAS = [
  'docs/harness-cli.schema.json',
  'tests/fixtures/harness-cli-handwritten.schema.json',
];
const validators = SCHEMAS.map(path => [
  path,
  new Ajv().compile(JSON.parse(fs.readFileSync(path, 'utf8'))),
]);
const envelopes = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.ok(Array.isArray(envelopes) && envelopes.length > 0);
for (const [path, validate] of validators) {
  for (const [index, envelope] of envelopes.entries()) {
    assert.equal(
      validate(envelope),
      true,
      `Envelope ${index} (${path}): ${JSON.stringify(validate.errors)}`,
    );
  }
}
console.log(
  `Validated ${envelopes.length} real harness envelopes against ${validators.length} schemas`,
);
