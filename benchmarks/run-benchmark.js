#!/usr/bin/env node
// Node 24 ESM; zero external dependencies. Run from the worktree root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { estimateTokens } from '../src/core/tokenizer.js';
import { buildCases } from './fixtures/cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const scriptPath = fileURLToPath(import.meta.url);
const slimRoot = process.env.NEXUS_BENCH_SLIM ?? path.resolve(root, '..', 'context-slim');
const repetitions = Number(process.env.NEXUS_BENCH_REPETITIONS ?? 7);
const hash = text => createHash('sha256').update(text).digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');
const serialize = value => JSON.stringify(value);
const sum = list => list.reduce((a, b) => a + b, 0);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
const stats = values => ({ p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(0, ...values) });
const mb = value => value / 1024 / 1024;
const round = value => Number(value.toFixed(3));
const requiredOk = result => { assert.equal(result.ok, true, serialize(result)); return result; };

function walk(value, fn) {
  if (value && typeof value === 'object') { fn(value); for (const child of Object.values(value)) walk(child, fn); }
}

function score(spec, texts) {
  // Compare content, not MCP escaping. JSON oracles require key/value association
  // in the same record, not merely separate appearances of an ID and a status.
  const parsed = texts.flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } });
  const search = texts.join('\n');
  return spec.required.map(rule => {
    let passed = false;
    if (rule.type === 'contains') passed = search.includes(rule.value);
    else for (const value of parsed) walk(value, obj => {
      if (rule.type === 'jsonRecord' && Object.entries(rule.fields).every(([k, v]) => obj[k] === v)) passed = true;
      if (rule.type === 'jsonValue' && obj[rule.key] === rule.value) passed = true;
    });
    return { label: rule.label, passed };
  });
}

function boundedHeadTail(text, max = 600) {
  if (estimateTokens(text) <= max) return text;
  const chars = Array.from(text);
  let n = Math.min(chars.length, max * 4), output;
  do { output = chars.slice(0, Math.ceil(n * .75)).join('') + '\n…\n' + chars.slice(-Math.floor(n * .25)).join(''); n = Math.floor(n * .9); }
  while (estimateTokens(output) > max && n > 0);
  return estimateTokens(output) <= max ? output : '';
}

function sourceManifest() {
  const paths = ['src/core/index.js', 'src/core/tokenizer.js', 'src/core/security.js', 'src/core/evidence.js', 'src/core/memory.js', 'src/core/db.js', 'src/core/metrics.js', 'src/mcp/server.js', 'src/cli/index.js', 'CONTRACT.md', 'benchmarks/run-benchmark.js', 'benchmarks/fixtures/cases.js'];
  return Object.fromEntries(paths.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
}

function slimManifest() {
  const files = ['package.json', 'index.cjs', 'lib/compressors.cjs', 'lib/tokenizer.cjs', 'lib/adapters.cjs', 'lib/installers.cjs'];
  return Object.fromEntries(files.filter(file => fs.existsSync(path.join(slimRoot, file))).map(file => [file, hash(fs.readFileSync(path.join(slimRoot, file)))]));
}

async function nexusAdapter(dbPath, projectId, tempRoot) {
  const { createNexusContext } = await import('../src/core/index.js');
  const { createMcpServer } = await import('../src/mcp/server.js');
  const ctx = createNexusContext({ dbPath, projectId, allowedRoots: [tempRoot] });
  // Explicit host policy for synthetic already-approved seed decisions only.
  const server = createMcpServer({ ctx, allowDirectActive: true });
  const handshake = await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(handshake.result.protocolVersion, '2025-11-25');
  await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(listed.result.tools.length, 3);
  const catalogText = serialize(listed.result.tools);
  let nextId = 2;
  async function call(name, args) {
    const request = { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } };
    // Exercise actual MCP argument checks, handlers and JSON serialization. No
    // pipe transport in timed samples; startup/real stdio measured separately.
    const requestText = serialize(request);
    const responseText = serialize(await server.handleMessage(JSON.parse(requestText)));
    const response = JSON.parse(responseText);
    assert.ok(!response.error, responseText);
    const payload = JSON.parse(response.result.content[0].text);
    return { payload, requestText, responseText };
  }
  return { ctx, call, catalogText, close: () => ctx.close() };
}

async function memoryRun(spec, dbPath, tempRoot) {
  let adapter = await nexusAdapter(dbPath, 'app-v1', tempRoot);
  const setup = [], calls = [], checks = [];
  const check = (label, passed) => checks.push({ label, passed: Boolean(passed) });
  const record = async data => {
    const r = await adapter.call('nexus_record', { action: 'decision', kind: 'decision', status: 'active', title: 'Armazenamento', content: 'SQLite vigente', sourceRef: 'fixture:ADR-004', effectiveDate: '2026-11-26', ...data });
    setup.push(r); return requiredOk(r.payload);
  };
  const query = async (query, extra = {}) => {
    const r = await adapter.call('nexus_memory', { action: 'query', query, maxTokens: 800, ...extra });
    calls.push(r); return requiredOk(r.payload);
  };
  const checkpoint = async extra => {
    const r = await adapter.call('nexus_record', { action: 'checkpoint', taskId: 'task-77', objective: 'Retomar cobrança', constraints: ['não duplicar'], pending: ['validar 503'], gitBranch: 'main', gitHead: 'aaaa', ...extra });
    setup.push(r); return requiredOk(r.payload);
  };
  const reopen = async () => { adapter.close(); adapter = await nexusAdapter(dbPath, 'app-v1', tempRoot); };
  let payload;
  try {
    const setupStarted = performance.now();
    if (['resume', 'stale-branch', 'stale-head', 'rejected'].includes(spec.scenario)) {
      if (spec.scenario === 'rejected') await record({ kind: 'rejected_approach', title: 'Repetir pagamento', content: 'Não repetir', rationale: 'perda de idempotência' });
      await checkpoint({});
    } else if (['superseded', 'history'].includes(spec.scenario)) {
      const old = await record({ content: 'JSON antigo' });
      await record({ content: 'SQLite vigente', rationale: 'concorrência transacional', supersedesId: old.id, expectedRevision: old.revision });
    } else if (spec.scenario === 'accent') {
      await record({ title: 'Ação não autorizada', content: 'DEC-Á77 C:\\Projeto A\\ação.txt' });
    } else if (spec.scenario === 'isolation') {
      await record({ title: 'Isolamento', content: 'APP-V1-ONLY' });
      const other = await nexusAdapter(dbPath, 'app-v10', tempRoot);
      try { requiredOk((await other.call('nexus_record', { action: 'decision', kind: 'fact', title: 'Isolamento', content: 'APP-V10-PRIVATE', sourceRef: 'fixture:outro-projeto', status: 'active' })).payload); }
      finally { other.close(); }
    } else if (spec.scenario.startsWith('forget-')) {
      const r = await adapter.call('nexus_evidence', { action: 'select', content: spec.raw, format: 'text', query: 'Pedido:', taskId: 'task-77' });
      setup.push(r); assert.ok(r.payload.ref);
      const decision = await record({ content: 'FORGET-MARKER-77', sourceRef: r.payload.ref });
      await checkpoint({ activeDecisions: [decision.id], references: [r.payload.ref] });
    } else if (spec.scenario === 'candidate') await record({ title: 'Candidata', content: 'CANDIDATE-HIDDEN', status: 'candidate' });
    const setupLatencyMs = performance.now() - setupStarted;
    const started = performance.now();
    await reopen(); // Persistent SQLite on disk, new core/MCP session.
    if (['resume', 'stale-branch', 'stale-head', 'rejected'].includes(spec.scenario)) {
      const r = await adapter.call('nexus_memory', { action: 'resume', taskId: 'task-77', maxTokens: 500, currentGitBranch: spec.scenario === 'stale-branch' ? 'feature' : 'main', currentGitHead: spec.scenario === 'stale-head' ? 'bbbb' : 'aaaa' });
      calls.push(r); payload = requiredOk(r.payload);
      check('checkpoint <=500 tokens estimados', estimateTokens(serialize(payload)) <= 500);
      check('objetivo/restrição/pendência preservados', payload.objective === 'Retomar cobrança' && payload.constraints.includes('não duplicar') && payload.pending.includes('validar 503'));
      check('staleCodeWarning correto', payload.staleCodeWarning === ['stale-branch', 'stale-head'].includes(spec.scenario));
      if (spec.scenario === 'rejected') check('motivo rejeitado preservado', payload.rejectedApproaches.some(r => r.rationale === 'perda de idempotência'));
    } else if (spec.scenario === 'superseded' || spec.scenario === 'history') {
      payload = await query('Armazenamento', { action: spec.scenario === 'history' ? 'history' : 'query' });
      check('estado e histórico corretos', spec.scenario === 'history' ? payload.items.some(r => r.status === 'superseded') && payload.items.some(r => r.status === 'active') : payload.items.length === 1 && payload.items[0].content === 'SQLite vigente');
    } else if (spec.scenario === 'accent') {
      payload = await query('DEC-Á77'); check('ID e acento exatos', payload.items.length === 1);
    } else if (spec.scenario === 'isolation') {
      payload = await query('Isolamento'); check('app-v1 não expõe app-v10', payload.items.length === 1 && payload.items[0].content === 'APP-V1-ONLY');
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath); try { check('outro projeto existe no mesmo banco', db.prepare('SELECT count(*) AS n FROM memory_entries WHERE project_id=?').get('app-v10').n === 1); } finally { db.close(); }
    } else if (spec.scenario.startsWith('forget-')) {
      // Administrative API: intentionally unavailable to the model's 3 MCP tools.
      const result = requiredOk(adapter.ctx.memory.forget({ scope: spec.scenario === 'forget-project' ? 'project' : 'task', targetId: spec.scenario === 'forget-task' ? 'task-77' : undefined }));
      calls.push({ payload: result, requestText: serialize({ administrativeAction: 'forget', scope: spec.scenario }), responseText: serialize(result) });
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        for (const table of ['memory_entries', 'memory_fts', 'evidence_blobs', 'task_checkpoints']) {
          check(`${table} vazio no escopo`, db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id=?`).get('app-v1').n === 0);
        }
        check('FTS5 MATCH sem vestígio lógico', db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'FORGET' AND project_id=?").get('app-v1').n === 0);
      } finally { db.close(); }
      payload = await query('FORGET-MARKER-77'); check('abstenção depois de esquecer', payload.abstentionRecommended && payload.items.length === 0);
    } else {
      payload = await query(spec.scenario === 'candidate' ? 'CANDIDATE-HIDDEN' : 'licença de componente desconhecido');
      check('abstenção sem evidência vigente', payload.abstentionRecommended && payload.items.length === 0);
    }
    const latencyMs = performance.now() - started;
    return { calls, texts: calls.map(r => r.payload.excerpt ?? memoryText(r.payload)), checks, setup, setupLatencyMs, latencyMs, payload, catalogText: adapter.catalogText };
  } finally { adapter.close(); }
}

function memoryText(payload) {
  const strings = [];
  function visit(value) {
    if (typeof value === 'string') strings.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) visit(v);
  }
  visit(payload); return strings.join('\n');
}

async function worker(variant, directory, roundIndex) {
  const cases = buildCases();
  const shifted = cases.slice(roundIndex % cases.length).concat(cases.slice(0, roundIndex % cases.length));
  let compress, comparator = 'raw', catalogText = '';
  if (variant === 'B') {
    if (fs.existsSync(path.join(slimRoot, 'index.cjs'))) {
      compress = createRequire(import.meta.url)(path.join(slimRoot, 'index.cjs')).compressContent;
      comparator = 'context-slim standalone balanced';
    } else comparator = 'simple bounded head/tail fallback';
  }
  let adapter;
  if (variant === 'C') { adapter = await nexusAdapter(path.join(directory, 'evidence.sqlite'), 'benchmark', directory); catalogText = adapter.catalogText; }
  const results = [];
  try {
    for (const spec of shifted) {
      const filePath = path.join(directory, `${spec.id} ação com espaços.${spec.category === 'json' ? 'json' : 'txt'}`);
      fs.writeFileSync(filePath, spec.raw, 'utf8'); // fixture materialization outside timed scope for all variants
      let calls = [], texts = [], checks = [], setup = [], setupLatencyMs = 0, payload, latencyMs, readBytes = 0;
      let mode, reconsultCount = 0;
      const started = performance.now();
      if (variant === 'C' && spec.category === 'memory') {
        const r = await memoryRun(spec, path.join(directory, `${spec.id}.sqlite`), directory);
        ({ calls, texts, checks, setup, setupLatencyMs, payload, latencyMs } = r);
        catalogText = r.catalogText;
      } else if (variant === 'C') {
        const selected = await adapter.call('nexus_evidence', { action: 'select', filePath, ...spec.input });
        calls.push(selected); payload = requiredOk(selected.payload); mode = payload.mode;
        texts.push(payload.excerpt); readBytes = bytes(spec.raw);
        for (const expansion of spec.expansions ?? []) {
          assert.ok(payload.ref, `${spec.id}: original recuperável`);
          const expanded = await adapter.call('nexus_evidence', { action: 'expand', ref: payload.ref, ...expansion });
          requiredOk(expanded.payload); calls.push(expanded); texts.push(expanded.payload.excerpt); reconsultCount++;
        }
        latencyMs = performance.now() - started;
        if (spec.repeatCount) checks.push({ label: 'contagem exata de repetições', passed: payload.excerpt.includes(`x${spec.repeatCount}`) });
        if (spec.passthrough) checks.push({ label: 'pass-through exato sem inflar excerpt', passed: payload.mode === 'passthrough' && payload.excerpt === spec.raw && estimateTokens(payload.excerpt) === estimateTokens(spec.raw) });
        if (spec.forbidden) checks.push({ label: 'limite numérico exato', passed: spec.forbidden.every(value => !texts.join('\n').includes(value)) });
      } else {
        const raw = fs.readFileSync(filePath, 'utf8'); readBytes = bytes(raw);
        const text = variant === 'A' ? raw : compress ? compress(raw, { format: spec.input.format, mode: 'standalone', level: 'balanced', maxTokens: spec.input.maxTokens }).content : boundedHeadTail(raw, spec.input.maxTokens);
        texts.push(text); calls.push({ requestText: '', responseText: text });
        latencyMs = performance.now() - started;
      }
      const oracle = score(spec, texts);
      // Actual MCP response envelope PLUS control request; source is read locally
      // by filePath, never injected again as model-authored content.
      const returnedText = calls.map(r => r.responseText).join('\n');
      const controlText = calls.map(r => r.requestText).join('\n');
      const setupText = setup.map(r => r.requestText + '\n' + r.responseText).join('\n');
      const payloadText = texts.join('\n');
      const rawTokens = estimateTokens(spec.raw);
      const responseTokens = calls.reduce((n, r) => n + estimateTokens(r.responseText), 0);
      const controlTokens = calls.reduce((n, r) => n + estimateTokens(r.requestText), 0);
      const taskTokens = responseTokens + controlTokens;
      const catalogTokens = variant === 'C' ? estimateTokens(catalogText) : 0;
      results.push({ id: spec.id, category: spec.category, variant, fixtureSha256: hash(spec.raw), rawBytes: bytes(spec.raw), sourceReadBytes: readBytes, returnedBytes: bytes(returnedText), controlBytes: bytes(controlText), payloadBytes: bytes(payloadText), estimatedRawTokens: rawTokens, estimatedPayloadTokens: estimateTokens(payloadText), estimatedResponseTokens: responseTokens, estimatedControlTokens: controlTokens, estimatedTaskTokens: taskTokens, catalogTokens, estimatedColdTaskTokens: taskTokens + catalogTokens, estimatedSetupTokens: estimateTokens(setupText), estimatedLifecycleTokens: taskTokens + catalogTokens + estimateTokens(setupText), setupLatencyMs, latencyMs, reconsultCount, oracle, preservedCount: oracle.filter(r => r.passed).length, requiredCount: oracle.length, evidenceComplete: oracle.every(r => r.passed), contractChecks: checks, mode: mode ?? null, sampledRssMB: mb(process.memoryUsage.rss()), excerptPreview: payloadText.replaceAll(directory, '<bench-tmp>').slice(0, 700), responseSha256: hash(returnedText) });
      fs.unlinkSync(filePath);
    }
    return { variant, roundIndex, comparator, catalogText, results, peakRssMB: process.resourceUsage().maxRSS / 1024, finalRssMB: mb(process.memoryUsage.rss()) };
  } finally { adapter?.close(); }
}

function child(args) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return { value: JSON.parse(result.stdout), processWallMs: performance.now() - started, stderr: result.stderr.trim() };
}

function aggregate(samples, workers) {
  const data = {};
  for (const variant of ['A', 'B', 'C']) {
    const rows = samples.filter(r => r.variant === variant), evidence = rows.filter(r => r.category !== 'memory'), large = evidence.filter(r => r.estimatedRawTokens > 1000);
    const ratio = rows => sum(rows.map(r => r.preservedCount)) / Math.max(1, sum(rows.map(r => r.requiredCount)));
    data[variant] = {
      samples: rows.length, cases: new Set(rows.map(r => r.id)).size,
      rawBytes: sum(rows.map(r => r.rawBytes)), returnedBytes: sum(rows.map(r => r.returnedBytes)),
      estimatedRawTokens: sum(rows.map(r => r.estimatedRawTokens)),
      estimatedTaskTokens: sum(rows.map(r => r.estimatedTaskTokens)),
      estimatedSetupTokens: sum(rows.map(r => r.estimatedSetupTokens)),
      medianSavingsPct: percentile(rows.map(r => (1 - r.estimatedTaskTokens / r.estimatedRawTokens) * 100), .5),
      medianColdSavingsPct: percentile(rows.map(r => (1 - r.estimatedColdTaskTokens / r.estimatedRawTokens) * 100), .5),
      medianLifecycleSavingsPct: percentile(rows.map(r => (1 - r.estimatedLifecycleTokens / r.estimatedRawTokens) * 100), .5),
      medianLargeSavingsPct: percentile(large.map(r => (1 - r.estimatedTaskTokens / r.estimatedRawTokens) * 100), .5),
      medianLargeColdSavingsPct: percentile(large.map(r => (1 - r.estimatedColdTaskTokens / r.estimatedRawTokens) * 100), .5),
      mandatoryItemsPreserved: sum(rows.map(r => r.preservedCount)),
      mandatoryItemsTotal: sum(rows.map(r => r.requiredCount)),
      mandatoryEvidenceRate: ratio(rows), evidenceOnlyRate: ratio(evidence),
      completeCaseRate: rows.filter(r => r.evidenceComplete).length / rows.length,
      latencyMs: stats(rows.map(r => r.latencyMs)), evidenceLatencyMs: stats(evidence.map(r => r.latencyMs)),
      setupLatencyMs: stats(rows.map(r => r.setupLatencyMs)),
      peakWorkerRssMB: Math.max(...workers.filter(w => w.variant === variant).map(w => w.peakRssMB)),
      reconsultCount: sum(rows.map(r => r.reconsultCount)),
      contractChecksPassed: sum(rows.map(r => r.contractChecks.filter(c => c.passed).length)),
      invariantFailures: rows.flatMap(r => r.contractChecks.filter(c => !c.passed).map(c => ({ id: r.id, check: c.label })))
    };
  }
  return data;
}

function modelCache(samples, catalogTokens) {
  // Illustrative units, NOT prices. One uncached input token = 1 cost unit.
  // No inferred provider cache hit rate, cache thresholds, or actual invoices.
  const prefix = 12000, discounted = .1, turns = 10, answerTokens = 200;
  const base = samples.filter(r => r.variant === 'A');
  const nexus = samples.filter(r => r.variant === 'C');
  const raw = percentile(base.filter(r => r.category !== 'memory').map(r => r.estimatedRawTokens), .5);
  const reduced = percentile(nexus.filter(r => r.category !== 'memory').map(r => r.estimatedTaskTokens), .5);
  const shortRaw = base.find(r => r.id === 'short-0').estimatedRawTokens;
  const shortReduced = nexus.find(r => r.id === 'short-0').estimatedTaskTokens;
  function scenario(id, rawTokens, selectedTokens, reconsults, breakPrefix = false) {
    // Catalog is a stable part of C's prefix. Each extra query repeats prefix
    // and input/output; only final answer output is charged for A's one call.
    const aCold = turns * (prefix + rawTokens + answerTokens);
    const aWarm = prefix + (turns - 1) * prefix * discounted + turns * (rawTokens + answerTokens);
    const calls = turns * (1 + reconsults);
    const cCold = calls * (prefix + catalogTokens + selectedTokens + answerTokens);
    const cWarm = breakPrefix ? cCold : (prefix + catalogTokens) + (calls - 1) * (prefix + catalogTokens) * discounted + calls * (selectedTokens + answerTokens);
    return { id, assumptions: { rawTokens, selectedTokens, extraQueriesPerTurn: reconsults, prefixStable: !breakPrefix }, baseline: { coldUnits: aCold, warmUnits: aWarm }, nexus: { coldUnits: cCold, warmUnits: cWarm }, savingsColdPct: 100 * (1 - cCold / aCold), savingsWarmPct: 100 * (1 - cWarm / aWarm) };
  }
  return { disclaimer: 'Simulação aritmética em unidades hipotéticas, não custo medido nem tabela comercial. Cache não reduz o espaço de contexto. Assume prefixo idêntico e elegível, 100% de hits após a primeira chamada, entradas variáveis não cacheadas; sensibilidade abaixo.', parameters: { stablePrefixTokens: prefix, warmInputMultiplier: discounted, turns, outputUnitsPerToken: 1, assumedAnswerTokens: answerTokens, catalogTokens }, scenarios: [scenario('large-stable-prefix', raw, reduced, 0), scenario('short-stable-prefix', shortRaw, shortReduced, 0), scenario('naive-rewrite-breaks-prefix', 6000, 600, 0, true), scenario('excessive-reconsultation', 6000, 600, 8)], sensitivity: [0, .1, .25, .5, 1].map(multiplier => ({ warmInputMultiplier: multiplier, baselineUnits: prefix + (turns - 1) * prefix * multiplier + turns * (raw + answerTokens), nexusUnits: prefix + catalogTokens + (turns - 1) * (prefix + catalogTokens) * multiplier + turns * (reduced + answerTokens) })) };
}

async function crossProcess(directory, mode) {
  const dbPath = path.join(directory, 'cross-process.sqlite');
  const a = await nexusAdapter(dbPath, 'cross-process', directory);
  try {
    if (mode === 'write') {
      requiredOk((await a.call('nexus_record', { action: 'checkpoint', taskId: 'persist', objective: 'Persistir entre processos', constraints: ['não duplicar'], pending: ['validar'], gitBranch: 'main', gitHead: 'aaaa' })).payload);
      return { ok: true };
    }
    const result = requiredOk((await a.call('nexus_memory', { action: 'resume', taskId: 'persist', currentGitBranch: 'feature', maxTokens: 500 })).payload);
    assert.equal(result.objective, 'Persistir entre processos'); assert.equal(result.staleCodeWarning, true); assert.ok(estimateTokens(serialize(result)) <= 500);
    return { ok: true, objective: result.objective, staleCodeWarning: result.staleCodeWarning, estimatedTokens: result.estimatedTokens };
  } finally { a.close(); }
}

function stdioProbe(directory) {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nexus_evidence', arguments: { action: 'select', content: 'Olá, ação concluída.', maxTokens: 600 } } }
  ].map(serialize).join('\n') + '\n';
  const started = performance.now();
  const result = spawnSync(process.execPath, [path.join(root, 'bin/nexus-context-mcp.js'), '--project', 'stdio-bench', '--db', path.join(directory, 'stdio.sqlite'), '--allowed-root', directory], { input, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000, windowsHide: true });
  const wallMs = performance.now() - started;
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(responses.length, 3); assert.equal(responses[1].result.tools.length, 3);
  assert.equal(JSON.parse(responses[2].result.content[0].text).excerpt, 'Olá, ação concluída.');
  return { wallMs, requestBytes: bytes(input), responseBytes: bytes(result.stdout), responses: responses.length, stderr: result.stderr.trim() };
}

function render(report) {
  const pct = n => `${round(n * 100)}%`, n = round;
  const lines = [
    '# Benchmark pareado v1 — NEXUS Contexto', '',
    `Executado em ${report.generatedAt}, Node ${report.environment.node}, ${report.environment.platform}/${report.environment.arch}. ${report.caseCount} casos × 3 variantes × ${report.repetitions} repetições medidas; uma rodada de aquecimento descartada.`, '',
    '**Estágio: benchmark executado, aguardando revisão independente.** Sem chamada de modelo/provedor; tokens são estimativas locais e providerCostUsd=null. Preservação é disponibilidade objetiva de evidência, não taxa de resolução por LLM.', '',
    '## Método e reexecução', '',
    '```powershell',
    'node benchmarks/run-benchmark.js',
    '```', '',
    '- A: leitura bruta UTF-8. B: Context Slim local standalone/balanced com orçamento do caso, se disponível; fallback explícito cabeça/cauda. C: núcleo real via handlers MCP e ida/volta JSON; inclui respostas completas, envelopes e argumentos de controle. Todas as variantes recebem os mesmos arquivos sintéticos, com SHA-256 no JSON.',
    '- Sem instalação: reaproveitados node:perf_hooks/global performance, process.resourceUsage, node:sqlite e Context Slim. Pesquisa limitada às interfaces locais e documentação oficial Node/Context7; nenhum pacote novo ou pesquisa de registro npm necessária (restrição zero dependências).',
    '- Latência local inclui leitura/seleção, SQLite, JSON e todas as expansões. Retomada inclui fechar/reabrir sessão no SQLite persistente; preparação é cronometrada separadamente. Exclui geração de fixtures, avaliação do oráculo e estimação pós-resposta. Transporte por pipe/process startup é uma sonda separada, sem misturar com handlers.',
    '- Subprocessos isolados por variante/rodada; ordem das variantes gira a cada rodada e ordem dos casos gira com índice determinístico. Aquecimento sem amostras publicadas. Sem GC forçado, controle de frequência/temperatura ou limpeza do cache de disco; cache de provedor frio/quente é simulado, não confundir com cache do SO.',
    '- RSS em MiB (1024² bytes): pico real do worker inteiro via maxRSS do SO, incluindo runtime, fixtures e estimação. Por caso há apenas RSS amostrado após operação, não um pico isolado. Ambiente compartilhado pode interferir em latência.',
    '- Um catálogo C das 3 ferramentas por sessão fria; nas colunas tarefa ele está separado para amortização. Cenário conservador frio soma o catálogo inteiro a cada tarefa. Baselines não carregam catálogo, favorecendo A/B. C lê arquivo por filePath; se o modelo reenviar conteúdo inline, esse custo adicional não está incluído.',
    '- Escritas iniciais de memória e respostas de registro têm estimativa e latência separadas, mais total de ciclo de vida no JSON. Perguntas de retomada usam registros sintéticos aprovados pelo host (allowDirectActive=true); isto não altera o padrão seguro do produto. Forget é operação administrativa direta, ausente das ferramentas do modelo.',
    '- Memória: os fatos são pré-estruturados manualmente no seed C; A/B recebem os mesmos fatos relevantes inseridos em 500 linhas de narrativa sintética. Nenhum extrator automático transforma narrativa em decisões. Economia de retomada não comprova economia ou precisão dessa extração; o volume de narrativa é uma premissa artificial explícita.',
    '- Oráculos fixos verificam strings/negações e associação exata de campos JSON no mesmo objeto; falhas não são escondidas. Invariantes de estado são verificadas em C; A/B são históricos textuais sem CRUD de memória, portanto não são equivalentes nesse aspecto. Corpus sintético não estima precisão em tarefas humanas.', '',
    '## Resultados agregados', '',
    '| Variante | Economia mediana tarefa | Grandes: mediana | Grandes + catálogo frio | Evidência obrigatória | Latência p50/p95/max ms | Pico RSS MiB |',
    '|---|---:|---:|---:|---:|---:|---:|'
  ];
  for (const [v, a] of Object.entries(report.aggregates)) lines.push(`| ${v} | ${n(a.medianSavingsPct)}% | ${n(a.medianLargeSavingsPct)}% | ${n(a.medianLargeColdSavingsPct)}% | ${pct(a.mandatoryEvidenceRate)} | ${n(a.latencyMs.p50)} / ${n(a.latencyMs.p95)} / ${n(a.latencyMs.max)} | ${n(a.peakWorkerRssMB)} |`);
  lines.push('', 'Grandes = casos de evidência com >1000 tokens brutos estimados; memórias não entram nessa mediana. Percentis nearest-rank sobre todas as repetições. Economia mantém valores negativos; não há corte em zero. Casos sem itens obrigatórios não aumentam a taxa de preservação.', '',
    '| Variante | Bytes originais / retornados (todas repetições) | Tokens brutos / tarefa estimados | Tokens de preparação memória | Reconsultas |', '|---|---:|---:|---:|---:|');
  for (const [v, a] of Object.entries(report.aggregates)) lines.push(`| ${v} | ${a.rawBytes} / ${a.returnedBytes} | ${a.estimatedRawTokens} / ${a.estimatedTaskTokens} | ${a.estimatedSetupTokens} | ${a.reconsultCount} |`);
  lines.push('', `Catálogo real: **${report.catalog.bytes} bytes / ${report.catalog.estimatedTokens} tokens estimados / 3 ferramentas**. Esse custo existe mesmo quando um trecho curto passa sem alteração.`, '', '## Casos pareados', '', '| Caso | Tokens brutos | B: tokens tarefa / itens | C: tokens tarefa / itens | C p50/p95 ms | Expansões C |', '|---|---:|---:|---:|---:|---:|');
  for (const c of report.cases) {
    const b = c.variants.B, x = c.variants.C;
    lines.push(`| ${c.id} | ${c.estimatedRawTokens} | ${b.estimatedTaskTokens} / ${b.preservedCount}:${b.requiredCount} | ${x.estimatedTaskTokens} / ${x.preservedCount}:${x.requiredCount} | ${n(x.latencyMs.p50)} / ${n(x.latencyMs.p95)} | ${x.reconsultCount} |`);
  }
  lines.push('', '## Onde ganha, perde e limitações', '',
    '- Logs raros e JSON: a seleção lexical/predicado procura a evidência especificada; corte/sumarização de B pode omitir ocorrências no meio ou no fim. Isto compara a política B configurada, não todas as configurações possíveis do Context Slim. A já fornece a evidência inteira.',
    '- Código: assinatura isolada pode omitir condições e negações; os quatro casos exigem lógica do corpo. Faixas e expansões têm custo explícito por tarefa.',
    '- Saídas curtas: excerpt de C deve ser idêntico; envelope, controle e catálogo aumentam tokens. Pass-through do conteúdo não significa economia de custo total.',
    '- Orçamento JSON insuficiente: seleção pode omitir um registro crítico; o caso json-7 inclui uma expansão predefinida e cobra ambas as respostas. O oráculo não decide retroativamente quando expandir.',
    '- Memória: estado vigente/histórico, motivo rejeitado, abstenção, projeto parecido e remoção lógica de FTS5/blobs são verificados. Remoção lógica não prova sanitização forense de páginas, WAL, backups ou exportações externas.',
    `- Latência do bruto é quase só leitura; não há inferência para converter tokens poupados em tempo. Critério de triagem ADR p95 local <=10% acima do baseline: **${report.aggregates.C.latencyMs.p95 <= report.aggregates.A.latencyMs.p95 * 1.1 ? 'atingido' : 'não atingido'}** (${n(report.aggregates.C.latencyMs.p95 / report.aggregates.A.latencyMs.p95)}×). Nenhuma afirmação de ganho de latência ponta a ponta do modelo.`, '',
    `Itens obrigatórios C: **${report.aggregates.C.mandatoryItemsPreserved}/${report.aggregates.C.mandatoryItemsTotal}** nas repetições. Invariantes C aprovadas: **${report.aggregates.C.contractChecksPassed}**; com falha: **${report.aggregates.C.invariantFailures.length}**. Falhas de evidência C: **${report.cases.filter(c => !c.variants.C.evidenceComplete).map(c => c.id).join(', ') || 'nenhuma'}**. Falhas B: **${report.cases.filter(c => !c.variants.B.evidenceComplete).map(c => c.id).join(', ') || 'nenhuma'}**.`, '',
    `Economia mediana C no conjunto inteiro: tarefa=${n(report.aggregates.C.medianSavingsPct)}%; incluindo catálogo frio=${n(report.aggregates.C.medianColdSavingsPct)}%; incluindo preparação de memória + catálogo=${n(report.aggregates.C.medianLifecycleSavingsPct)}%. Dados pareados do corpus, sem intervalo de confiança populacional: sete repetições do mesmo caso não são sete tarefas independentes.`, '',
    `Retomada entre dois processos reais: ${report.persistence.read.value.ok ? 'passou' : 'falhou'}; aviso de branch divergente=${report.persistence.read.value.staleCodeWarning}; ${report.persistence.read.value.estimatedTokens} tokens estimados. Stdio real: ${report.stdio.responses} respostas JSON válidas em ${n(report.stdio.wallMs)} ms (amostra única de startup+3 operações, não p95).`, '',
    '## Cache frio/quente — modelo transparente', '', report.cache.disclaimer, '',
    `Premissas: prefixo estável=${report.cache.parameters.stablePrefixTokens}, multiplicador cache quente=${report.cache.parameters.warmInputMultiplier}, ${report.cache.parameters.turns} turnos, resposta suposta=${report.cache.parameters.assumedAnswerTokens} tokens/chamada, entrada/saída não cacheada=1 unidade/token. Catálogo entra no prefixo C. Reconsultas repetem prefixo e resposta; não há garantia de hit, elegibilidade, preço ou latência real.`, '',
    '| Cenário | A frio / quente | C frio / quente | Economia frio / quente |', '|---|---:|---:|---:|');
  for (const s of report.cache.scenarios) lines.push(`| ${s.id} | ${n(s.baseline.coldUnits)} / ${n(s.baseline.warmUnits)} | ${n(s.nexus.coldUnits)} / ${n(s.nexus.warmUnits)} | ${n(s.savingsColdPct)}% / ${n(s.savingsWarmPct)}% |`);
  lines.push('', 'Prefixos preservados amortizam o catálogo. Reescrever o prefixo a cada redução pode destruir a vantagem do cache; reconsultas excessivas repetem entrada e saída, podendo custar mais que o bruto. Os cenários negativos usam entradas assumidas declaradas no JSON; grandes/curtos usam medianas e um caso reais da suíte. Sensibilidade ao desconto de cache 0/0,1/0,25/0,5/1 consta no JSON.', '',
    '## Proveniência e arquivos', '',
    'Fixtures geradas determinísticamente por benchmarks/fixtures/cases.js; arquivos temporários SQLite/texto ficam em tmp/nexus-bench-* e são removidos ao final, inclusive em falha. O único repo comparador é lido por import CJS em modo standalone; hashes antes/depois são iguais. Relatórios JSON/Markdown são as únicas escritas duráveis do runner. Hashes dos fontes, corpus e respostas estão no JSON; respostas contêm IDs/tempos variáveis, portanto não são bit a bit determinísticas.', '',
    'Documentação primária consultada: [process.resourceUsage e RSS](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage) e [performance.now](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#performancenow). Não medidos: tokenizador oficial/provedor, cache real, custo monetário, qualidade de resposta de modelo, outros hosts/sistemas/clientes finais. Nenhum push externo.', ''
  );
  return lines.join('\n');
}

async function main() {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, `Node.js 24.x required (found ${process.versions.node})`);
  assert.ok(Number.isInteger(repetitions) && repetitions >= 3 && repetitions <= 30);
  const cases = buildCases(); assert.ok(cases.length >= 32);
  for (const spec of cases.filter(c => c.category === 'json')) assert.ok(estimateTokens(spec.raw) > 40000, `${spec.id}: JSON >40k tokens`);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'tmp', 'nexus-bench-'));
  const slimBefore = slimManifest(), sourcesBefore = sourceManifest();
  const samples = [], workers = [];
  try {
    for (let iteration = -1; iteration < repetitions; iteration++) {
      const order = ['A', 'B', 'C'];
      const offset = (iteration + 1) % 3; order.push(...order.splice(0, offset));
      for (const variant of order) {
        const childDir = path.join(directory, `r${iteration}-${variant}`); fs.mkdirSync(childDir);
        const r = child(['--worker', variant, childDir, String(iteration + 1)]);
        if (iteration >= 0) { const { results, catalogText, ...metadata } = r.value; samples.push(...results.map(row => ({ ...row, round: iteration }))); workers.push({ ...metadata, processWallMs: r.processWallMs }); }
        if (iteration >= 0 && variant === 'C') process.stderr.write(`Rodada ${iteration + 1}/${repetitions}: ${cases.length} casos C medidos.\n`);
      }
    }
    const persistence = { write: child(['--persist-write', directory]), read: child(['--persist-read', directory]) };
    const stdio = stdioProbe(directory);
    assert.deepEqual(slimManifest(), slimBefore, 'comparador local permaneceu inalterado');
    assert.deepEqual(sourceManifest(), sourcesBefore, 'fontes estáveis durante benchmark');
    const a = await nexusAdapter(path.join(directory, 'catalog.sqlite'), 'catalog', directory);
    const catalogText = a.catalogText; a.close();
    const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), caseCount: cases.length, repetitions, warmupRoundsDiscarded: 1, providerCostUsd: null, providerUsageAvailable: false, tokenDisclaimer: 'Estimativas locais heurísticas comuns às três variantes. Tokens/custo/cache oficiais do provedor não medidos.', environment: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryMB: mb(os.totalmem()), freeMemoryMBAtReport: mb(os.freemem()), executable: path.basename(process.execPath) }, methodology: { seed: 'deterministic-index-v1', input: 'UTF-8 synthetic files', latency: 'performance.now; MCP handlers+JSON round-trip, no pipe IO in samples; memory reopen included; setup separate', rss: 'resourceUsage.maxRSS /1024 = worker process peak MiB; per-case sampled RSS only', percentile: 'nearest-rank', baseline: 'raw unfiltered read', comparator: workers.find(w => w.variant === 'B').comparator, slimReadOnlyPath: process.env.NEXUS_BENCH_SLIM ? '<NEXUS_BENCH_SLIM>' : path.basename(slimRoot), coldCatalog: 'one complete tools array per task, conservative; session amortization modeled separately', memoryStateOracle: 'C only, A/B raw histories lack state implementation', syntheticAccuracy: 'evidence coverage, not LLM task completion' }, catalog: { tools: 3, bytes: bytes(catalogText), estimatedTokens: estimateTokens(catalogText), sha256: hash(catalogText), definitions: JSON.parse(catalogText) }, sourceSha256: sourcesBefore, comparatorSha256Before: slimBefore, comparatorSha256After: slimManifest(), fixtureManifest: cases.map(c => ({ id: c.id, category: c.category, description: c.description ?? '', sha256: hash(c.raw), rawBytes: bytes(c.raw), estimatedRawTokens: estimateTokens(c.raw), input: c.input, expansions: c.expansions ?? [], required: c.required })), workers, samples, aggregates: aggregate(samples, workers), persistence, stdio, cache: modelCache(samples, estimateTokens(catalogText)) };
    report.cases = cases.map(c => ({ id: c.id, category: c.category, estimatedRawTokens: estimateTokens(c.raw), variants: Object.fromEntries(['A', 'B', 'C'].map(variant => {
      const rows = samples.filter(r => r.id === c.id && r.variant === variant), first = rows[0];
      return [variant, { estimatedTaskTokens: percentile(rows.map(r => r.estimatedTaskTokens), .5), estimatedColdTaskTokens: percentile(rows.map(r => r.estimatedColdTaskTokens), .5), estimatedLifecycleTokens: percentile(rows.map(r => r.estimatedLifecycleTokens), .5), returnedBytes: percentile(rows.map(r => r.returnedBytes), .5), preservedCount: Math.min(...rows.map(r => r.preservedCount)), requiredCount: first.requiredCount, evidenceComplete: rows.every(r => r.evidenceComplete), latencyMs: stats(rows.map(r => r.latencyMs)), reconsultCount: first.reconsultCount, contractChecks: rows.flatMap(r => r.contractChecks) }];
    })) }));
    // Harness integrity asserts; product quality failures remain visible data.
    assert.equal(samples.length, cases.length * 3 * repetitions);
    assert.ok(samples.every(r => Number.isFinite(r.latencyMs) && r.latencyMs >= 0));
    assert.ok(samples.filter(r => r.variant === 'A').every(r => r.evidenceComplete));
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'reports/benchmark-v1.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'reports/benchmark-v1.md'), render(report));
    process.stdout.write(serialize({ cases: report.caseCount, repetitions, aggregates: report.aggregates, catalog: { bytes: report.catalog.bytes, estimatedTokens: report.catalog.estimatedTokens }, report: 'reports/benchmark-v1.md' }) + '\n');
  } finally {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(path.join(root, 'tmp')));
    assert.ok(path.basename(resolved).startsWith('nexus-bench-'));
    fs.rmSync(resolved, { recursive: true, force: true }); // only this runner's own temp directory
  }
}

const [mode, arg1, arg2, arg3] = process.argv.slice(2);
if (mode === '--worker') process.stdout.write(serialize(await worker(arg1, arg2, Number(arg3))));
else if (mode === '--persist-write' || mode === '--persist-read') process.stdout.write(serialize(await crossProcess(arg1, mode === '--persist-write' ? 'write' : 'read')));
else await main();
