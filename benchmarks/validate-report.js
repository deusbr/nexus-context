// Independently check report accounting and provenance without rerunning timing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildCases } from './fixtures/cases.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/benchmark-v1.json'), 'utf8'));
const digest = data => createHash('sha256').update(data).digest('hex');
const cases = buildCases();
assert.equal(report.caseCount, cases.length);
assert.ok(cases.length >= 32);
assert.equal(report.samples.length, cases.length * 3 * report.repetitions);
assert.equal(report.providerCostUsd, null);
assert.equal(report.providerUsageAvailable, false);
for (const [file, expected] of Object.entries(report.sourceSha256)) {
  assert.equal(digest(fs.readFileSync(path.join(root, file))), expected, `source changed: ${file}`);
}
assert.deepEqual(report.comparatorSha256Before, report.comparatorSha256After);
assert.equal(report.catalog.tools, 3);
assert.equal(Buffer.byteLength(JSON.stringify(report.catalog.definitions)), report.catalog.bytes);
assert.equal(digest(JSON.stringify(report.catalog.definitions)), report.catalog.sha256);
for (const spec of cases) {
  const samples = report.samples.filter(r => r.id === spec.id);
  assert.equal(samples.length, 3 * report.repetitions);
  assert.ok(samples.every(r => r.fixtureSha256 === digest(spec.raw)));
  assert.ok(samples.every(r => r.rawBytes === Buffer.byteLength(spec.raw)));
  for (const variant of ['A', 'B', 'C']) {
    const rows = samples.filter(r => r.variant === variant);
    assert.equal(new Set(rows.map(r => r.round)).size, report.repetitions);
    for (const r of rows) {
      assert.equal(r.estimatedTaskTokens, r.estimatedResponseTokens + r.estimatedControlTokens);
      assert.equal(r.estimatedColdTaskTokens, r.estimatedTaskTokens + r.catalogTokens);
      assert.equal(r.estimatedLifecycleTokens, r.estimatedColdTaskTokens + r.estimatedSetupTokens);
      assert.equal(r.preservedCount, r.oracle.filter(item => item.passed).length);
      assert.equal(r.requiredCount, spec.required.length);
      assert.equal(r.evidenceComplete, r.preservedCount === r.requiredCount);
      assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
      assert.ok(Number.isFinite(r.sampledRssMB) && r.sampledRssMB > 0);
    }
  }
}
for (const variant of ['A', 'B', 'C']) {
  const rows = report.samples.filter(r => r.variant === variant);
  const aggregate = report.aggregates[variant];
  for (const field of ['rawBytes', 'returnedBytes', 'estimatedRawTokens', 'estimatedTaskTokens', 'estimatedSetupTokens']) {
    assert.equal(rows.reduce((total, row) => total + row[field], 0), aggregate[field], `${variant} ${field}`);
  }
  const latencies = rows.map(r => r.latencyMs).sort((a, b) => a - b);
  assert.equal(aggregate.latencyMs.p50, latencies[Math.ceil(latencies.length * .5) - 1]);
  assert.equal(aggregate.latencyMs.p95, latencies[Math.ceil(latencies.length * .95) - 1]);
  assert.equal(aggregate.latencyMs.max, latencies.at(-1));
}
assert.equal(report.persistence.read.value.ok, true);
assert.equal(report.persistence.read.value.staleCodeWarning, true);
assert.ok(report.persistence.read.value.estimatedTokens <= 500);
assert.equal(report.stdio.responses, 3);
assert.ok(report.cache.scenarios.find(s => s.id === 'large-stable-prefix').savingsWarmPct > 0);
assert.ok(report.cache.scenarios.find(s => s.id === 'naive-rewrite-breaks-prefix').savingsWarmPct < 0);
assert.ok(report.cache.scenarios.find(s => s.id === 'excessive-reconsultation').savingsWarmPct < 0);
assert.ok(report.samples.filter(r => r.variant === 'C' && r.category === 'short').every(r => r.contractChecks.every(c => c.passed)));
process.stdout.write(`Contabilidade, pareamento e proveniência conferidos: ${report.caseCount} casos, ${report.samples.length} amostras.\n`);
