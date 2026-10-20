// Isolated Git smudge filter: no models, owner credentials or production flags.
// Git feeds one small tracked blob on stdin. A required filter's exit 1 makes
// checkout fail; the marker/release pair orders that failure after timer claim.
const fs = require('node:fs');
const path = require('node:path');
const marker = path.join(__dirname, 'job-launch-filter-started.json');
const release = path.join(__dirname, 'job-launch-filter-release');
const completed = path.join(__dirname, 'job-launch-filter-finished.json');
const startedAt = Date.now();
const input = fs.readFileSync(0);
if (input.length > 65536) throw new Error('Owned filter blob exceeds fixture limit');
fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt, bytes: input.length }));
function inspect() {
  const released = fs.existsSync(release);
  if (released || Date.now() - startedAt >= 5000) {
    fs.writeFileSync(completed, JSON.stringify({ released, finishedAt: Date.now() }));
    // Deliberate required-filter failure, rather than a simulated host receipt.
    process.exit(1);
  }
  setTimeout(inspect, 20);
}
inspect();
