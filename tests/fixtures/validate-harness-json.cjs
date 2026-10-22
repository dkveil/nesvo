// Test-only validation of real CLI/MCP envelopes against the published contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Ajv = require('ajv');

const validate = new Ajv().compile(
  JSON.parse(fs.readFileSync('docs/harness-cli.schema.json', 'utf8')),
);
const envelopes = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.ok(Array.isArray(envelopes) && envelopes.length > 0);
for (const [index, envelope] of envelopes.entries()) {
  assert.equal(validate(envelope), true, `Envelope ${index}: ${JSON.stringify(validate.errors)}`);
}
console.log(`Validated ${envelopes.length} real harness envelopes`);
