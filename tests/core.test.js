import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createNexusContext, estimateTokens, redactSecrets, resolveSafePath } from '../src/core/index.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-core-'));
  const dbPath = path.join(root, 'context.sqlite');
  const contexts = [];
  const open = (projectId = 'app-v1', config = {}) => {
    const ctx = createNexusContext({ dbPath, projectId, allowedRoots: [root], ...options, ...config });
    contexts.push(ctx); return ctx;
  };
  t.after(() => { contexts.reverse().forEach(ctx => ctx.close()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dbPath, open, ctx: open(), inspect: action => { const db = new DatabaseSync(dbPath); try { return action(db); } finally { db.close(); } } };
}
const decision = (ctx, extra = {}) => ctx.memory.recordDecision({ kind: 'decision', title: 'Persistência SQLite', content: 'Usar SQLite com WAL para operação local.', rationale: 'Sem serviço remoto.', sourceRef: 'ADR-004', ...extra });
const blob = (ctx, extra = {}) => ctx.evidence.select({ content: 'linha comum\n'.repeat(80) + 'HTTP 503 raro\n', query: '503', contextLines: 1, ...extra });

test('token estimator handles UTF-8/PT-BR/JSON/code deterministically', () => {
  assert.equal(estimateTokens(''), 0);
  for (const value of ['ação em português', '{"status":503,"message":"falha"}', 'const f = x => x + 1;', '😀東京']) {
    assert.ok(Number.isInteger(estimateTokens(value)) && estimateTokens(value) > 0);
    assert.equal(estimateTokens(value), estimateTokens(value));
    assert.ok(estimateTokens(value) <= Buffer.byteLength(value));
  }
  assert.ok(estimateTokens('é'.repeat(100)) > estimateTokens('a'.repeat(100)));
  assert.ok(estimateTokens('{}'.repeat(100)) > estimateTokens('ab'.repeat(100)));
});

test('redacts secret families including JSON/env/URL without destroying JSON', () => {
  const secrets = ['sk-proj-' + 'A'.repeat(30), 'Bearer abc.def.ghi', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'AKIA' + 'A'.repeat(16), 'ghp_' + 'A'.repeat(30), 'github_pat_' + 'a'.repeat(30),
    '-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----',
    'https://alice:superpassword@example.com', 'PASSWORD=superpassword', 'AWS_SECRET_ACCESS_KEY=superpassword'];
  for (const secret of secrets) { const r = redactSecrets(secret); assert.ok(r.count >= 1, secret.slice(0, 10)); assert.ok(r.text.includes('[REDACTED]')); }
  const json = redactSecrets('{"password":"abc123","message":"PASSWORD=abc123","status":503}');
  assert.equal(JSON.parse(json.text).status, 503);
  assert.ok(!json.text.includes('abc123'));
});

test('native schema WAL and FTS5 use dedicated database', t => {
  const { inspect } = fixture(t);
  inspect(db => {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    for (const name of ['evidence_blobs', 'memory_entries', 'memory_fts', 'task_checkpoints', 'metrics_events'])
      assert.ok(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name));
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_fts'").get().sql, /USING fts5/);
  });
});

test('rare numeric 503 without ERROR is preserved with exact context lines', t => {
  const { ctx } = fixture(t);
  const lines = Array.from({ length: 14000 }, (_, i) => i === 12345 ? 'HTTP response 503 retry' : `request id${i} status 200`);
  const r = ctx.evidence.select({ content: lines.join('\n'), format: 'log', query: '503', contextLines: 1, maxTokens: 140 });
  assert.equal(r.ok, true); assert.match(r.excerpt, /L12346: HTTP response 503 retry/);
  assert.match(r.excerpt, /L12345:/); assert.match(r.excerpt, /L12347:/);
  assert.equal(r.preserved.matchedCount, 1); assert.equal(r.preserved.totalLines, 14000);
  assert.equal(r.preserved.omittedCount, 13997); assert.ok(estimateTokens(r.excerpt) <= 140);
});

test('JSON 40k+ projection retains requested values, IDs, timestamp, pagination and counts', t => {
  const { ctx } = fixture(t);
  const rows = Array.from({ length: 1800 }, (_, i) => ({ id: `req-${i}`, status: i === 1777 ? 503 : 200,
    message: i === 1777 ? 'upstream indisponível' : 'ok', timestamp: '2026-11-26T10:00:00Z', detail: 'valor importante', noise: 'x'.repeat(30) }));
  const raw = JSON.stringify({ totalCount: 1800, pagination: { page: 2, limit: 1800, nextCursor: 'next-3' }, results: rows }, null, 2);
  assert.ok(estimateTokens(raw) > 40000);
  const r = ctx.evidence.select({ content: raw, format: 'json', predicate: 'status>=500', keepFields: ['detail'], maxTokens: 600 });
  assert.equal(r.ok, true);
  const selected = JSON.parse(r.excerpt);
  assert.equal(selected.results.length, 1); assert.equal(selected.results[0].id, 'req-1777');
  assert.equal(selected.results[0].status, 503); assert.equal(selected.results[0].message, 'upstream indisponível');
  assert.equal(selected.results[0].detail, 'valor importante'); assert.ok(selected.results[0].timestamp);
  assert.equal(selected.totalCount, 1800); assert.equal(selected.pagination.nextCursor, 'next-3');
  assert.equal(r.preserved.matchedCount, 1); assert.ok(r.ref.startsWith('ev_')); assert.ok(estimateTokens(r.excerpt) <= 600);
});

test('JSON query/statusCodes/equality and nested arrays work without executing predicates', t => {
  const { ctx } = fixture(t);
  const content = JSON.stringify({ data: { rows: [{ id: 1, status: 503, level: 'warn' }, { id: 2, status: 200, level: 'error' }] }, total: 2 });
  for (const filter of [{ query: '503' }, { statusCodes: [503] }, { predicate: 'level=warn' }]) {
    const r = ctx.evidence.select({ content, format: 'json', ...filter });
    assert.equal(JSON.parse(r.excerpt).data.rows[0].id, 1); assert.equal(JSON.parse(r.excerpt).data.rows.length, 1);
  }
  assert.equal(ctx.evidence.select({ content, predicate: 'process.exit()' }).errorCode, 'INVALID_INPUT');
});

test('pass-through exact small content and no original blob', t => {
  const { ctx } = fixture(t);
  for (const content of ['Olá, ação concluída.\n', '{"value":42}', 'const x = 1;']) {
    const r = ctx.evidence.select({ content }); assert.equal(r.mode, 'passthrough'); assert.equal(r.excerpt, content); assert.equal(r.ref, null);
  }
});

test('redaction precedes persistence and metrics and original expansion', t => {
  const { ctx, inspect } = fixture(t);
  const secret = 'sk-proj-' + 'A'.repeat(30), r = blob(ctx, { content: `API_KEY=${secret}\nHTTP 503 retry\n${'normal\n'.repeat(50)}` });
  assert.ok(r.redactedSecretsCount > 0);
  const expanded = ctx.evidence.expand({ ref: r.ref }); assert.ok(!expanded.excerpt.includes(secret));
  inspect(db => { const text = db.prepare('SELECT content FROM evidence_blobs').get().content; assert.ok(!text.includes(secret)); assert.ok(text.includes('[REDACTED]')); assert.equal(r.metrics.rawBytes, Buffer.byteLength(text)); });
});

test('regex and status filters plus repetition grouping', t => {
  const { ctx } = fixture(t);
  const r = ctx.evidence.select({ content: 'same\nsame\nsame\nHTTP 503 retry\nend', format: 'log', query: '/HTTP.*retry/i', contextLines: 3 });
  assert.match(r.excerpt, /L1-L3 \(x3\): same/); assert.match(r.excerpt, /L4: HTTP 503 retry/);
  const s = ctx.evidence.select({ content: '1503\n503\n5030', format: 'log', statusCodes: [503], contextLines: 0 });
  assert.equal(s.preserved.matchedCount, 1);
});

test('code/text exact ranges and bounded valid JSON partial samples', t => {
  const { ctx } = fixture(t);
  const r = ctx.evidence.select({ content: 'one\ntwo\nthree\nfour\nfive', format: 'code', query: '2-4', contextLines: 0 });
  assert.match(r.excerpt, /inline:2-4/); assert.match(r.excerpt, /L2: two/); assert.ok(!r.excerpt.includes('L1:'));
  const big = ctx.evidence.select({ content: JSON.stringify(Array.from({ length: 50 }, (_, id) => ({ id, status: 503, message: 'falha' }))), format: 'json', query: '503', maxTokens: 100 });
  JSON.parse(big.excerpt); assert.ok(estimateTokens(big.excerpt) <= 100); assert.equal(big.mode, 'partial_sample'); assert.ok(big.omissionsNotice);
});

test('path traversal and similar-prefix roots blocked; unicode file allowed', t => {
  const { ctx, root } = fixture(t);
  const allowed = path.join(root, 'pasta ação'); fs.mkdirSync(allowed);
  const file = path.join(allowed, 'código.txt'); fs.writeFileSync(file, 'conteúdo');
  assert.equal(resolveSafePath(file, [allowed]).ok, true);
  assert.equal(resolveSafePath(path.join(allowed, '..', 'context.sqlite'), [allowed]).errorCode, 'SCOPE_DENIED');
  const similar = path.join(root, 'pasta ação-extra'); fs.mkdirSync(similar); const outside = path.join(similar, 'x.txt'); fs.writeFileSync(outside, 'fora');
  assert.equal(resolveSafePath(outside, [allowed]).ok, false);
  const scoped = fixture(t).open('file', { allowedRoots: [allowed] });
  assert.equal(scoped.evidence.select({ filePath: outside }).errorCode, 'SCOPE_DENIED');
  assert.equal(ctx.evidence.select({ filePath: file }).excerpt, 'conteúdo');
});

test('Windows junction/symlink outside authorized root denied', t => {
  const { root, open } = fixture(t); const a = path.join(root, 'a'), b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.writeFileSync(path.join(b, 'secret.txt'), 'fora');
  fs.symlinkSync(b, path.join(a, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const ctx = open('junction', { allowedRoots: [a] });
  assert.equal(ctx.evidence.select({ filePath: path.join(a, 'junction', 'secret.txt') }).errorCode, 'SCOPE_DENIED');
});

test('expand preserves source snapshot and detects hash change with restored mtime', t => {
  const { ctx, root } = fixture(t), file = path.join(root, 'source.log');
  fs.writeFileSync(file, 'before\nHTTP 503\nafter\n'); const old = fs.statSync(file);
  const r = ctx.evidence.select({ filePath: file, query: '503', contextLines: 0 });
  assert.equal(ctx.evidence.expand({ ref: r.ref }).sourceModified, false);
  fs.writeFileSync(file, 'before\nHTTP 200\nafter\n'); fs.utimesSync(file, old.atime, old.mtime);
  const x = ctx.evidence.expand({ ref: r.ref, startLine: 2, endLine: 2 });
  assert.equal(x.sourceModified, true); assert.ok(x.warning); assert.match(x.excerpt, /HTTP 503/);
  assert.equal(x.startLine, 2); assert.equal(x.endLine, 2);
  fs.unlinkSync(file); assert.equal(ctx.evidence.expand({ ref: r.ref }).sourceModified, true);
});

test('EXPIRED at TTL zero and no access through a foreign project', t => {
  const { ctx, open } = fixture(t), other = open('app-v10');
  const r = blob(ctx, { ttlSeconds: 0 }); assert.equal(ctx.evidence.expand({ ref: r.ref }).errorCode, 'EXPIRED');
  assert.equal(other.evidence.expand({ ref: r.ref }).errorCode, 'NOT_FOUND');
});

test('LRU eviction uses access order within exact project only', t => {
  const content = 'normal\n'.repeat(30) + '503', bytes = Buffer.byteLength(content);
  const { ctx, open, inspect } = fixture(t, { maxEvidenceBytesPerProject: bytes * 2 });
  const foreign = open('app-v10'), foreignRef = blob(foreign, { content }).ref;
  const a = blob(ctx, { content }), b = blob(ctx, { content });
  assert.equal(ctx.evidence.expand({ ref: a.ref }).ok, true);
  const c = blob(ctx, { content });
  assert.equal(ctx.evidence.expand({ ref: b.ref }).errorCode, 'NOT_FOUND');
  assert.equal(ctx.evidence.expand({ ref: a.ref }).ok, true); assert.equal(ctx.evidence.expand({ ref: c.ref }).ok, true);
  assert.equal(foreign.evidence.expand({ ref: foreignRef }).ok, true);
  inspect(db => assert.equal(db.prepare('SELECT sum(bytes) AS n FROM evidence_blobs WHERE project_id=?').get('app-v1').n, bytes * 2));
});

test('oversize original cannot exceed quota and storeOriginal false honored', t => {
  const { ctx } = fixture(t, { maxEvidenceBytesPerProject: 10 });
  const r = blob(ctx); assert.equal(r.ref, null); assert.ok(r.omissionsNotice);
  assert.equal(blob(ctx, { storeOriginal: false }).ref, null);
});

test('decision versioning optimistic conflict and event idempotence transactional', t => {
  const { ctx, inspect } = fixture(t), first = decision(ctx, { eventId: 'e1' });
  assert.equal(first.revision, 1);
  const conflict = decision(ctx, { supersedesId: first.id, expectedRevision: 99 });
  assert.equal(conflict.errorCode, 'CONFLICT'); assert.equal(conflict.currentRevision, 1);
  assert.equal(ctx.memory.list().items.length, 1);
  const next = decision(ctx, { title: 'PostgreSQL futuro', supersedesId: first.id, expectedRevision: 1, eventId: 'e2' });
  assert.equal(next.revision, 2);
  const replay = decision(ctx, { eventId: 'e2', supersedesId: first.id, expectedRevision: 1 });
  assert.equal(replay.id, next.id); assert.equal(replay.idempotentReplay, true);
  assert.equal(ctx.memory.query({ query: 'SQLite' }).items.length, 1);
  assert.equal(ctx.memory.query({ query: 'SQLite', includeHistory: true }).items.length, 2);
  inspect(db => { assert.equal(db.prepare('SELECT status,superseded_by FROM memory_entries WHERE id=?').get(first.id).status, 'superseded'); assert.equal(db.prepare('SELECT count(*) AS n FROM memory_fts').get().n, 2); });
  assert.equal(decision(ctx, { supersedesId: first.id, expectedRevision: 1 }).errorCode, 'CONFLICT');
});

test('failed insertion rolls back previous version and FTS atomically', t => {
  const { ctx, inspect } = fixture(t); const first = decision(ctx);
  inspect(db => db.exec("CREATE TRIGGER reject_insert BEFORE UPDATE ON memory_entries BEGIN SELECT RAISE(ABORT,'injected'); END"));
  assert.throws(() => decision(ctx, { supersedesId: first.id, expectedRevision: 1 }), /injected/);
  assert.equal(ctx.memory.list().items.length, 1); assert.equal(ctx.memory.list().items[0].status, 'active');
  inspect(db => assert.equal(db.prepare('SELECT count(*) AS n FROM memory_fts').get().n, 1));
});

test('candidate approval and revocation control current/history query', t => {
  const { ctx } = fixture(t); const candidate = decision(ctx, { status: 'candidate' });
  assert.equal(ctx.memory.query({ query: 'SQLite' }).items.length, 0);
  assert.equal(ctx.memory.query({ query: 'SQLite', includeCandidates: true }).items[0].id, candidate.id);
  const approved = ctx.memory.approveDecision({ id: candidate.id }); assert.equal(approved.status, 'active');
  assert.equal(ctx.memory.query({ query: 'SQLite' }).items.length, 1);
  const revoked = ctx.memory.revokeDecision({ id: candidate.id, reason: 'Substituída por política nova' }); assert.equal(revoked.status, 'revoked');
  assert.equal(ctx.memory.query({ query: 'SQLite' }).items.length, 0);
  assert.equal(ctx.memory.query({ query: 'SQLite', includeHistory: true }).items[0].status, 'revoked');
  assert.equal(ctx.memory.approveDecision({ id: candidate.id }).errorCode, 'CONFLICT');
});

test('strict project isolation for all decision mutations and same event IDs', t => {
  const { ctx, open } = fixture(t), other = open('app-v10');
  const a = decision(ctx, { eventId: 'same' }), b = decision(other, { eventId: 'same' });
  assert.notEqual(a.id, b.id); assert.equal(other.memory.approveDecision({ id: a.id }).errorCode, 'NOT_FOUND');
  assert.equal(other.memory.revokeDecision({ id: a.id, reason: 'x' }).errorCode, 'NOT_FOUND');
  assert.equal(decision(other, { supersedesId: a.id }).errorCode, 'NOT_FOUND');
  assert.equal(ctx.memory.query({ query: b.id }).items.length, 0); assert.equal(other.memory.list().items.length, 1);
});

test('FTS5 accent normalization and exact punctuation/IDs fallback', t => {
  const { ctx, inspect } = fixture(t); const a = decision(ctx, { title: 'Decisão de retenção', content: 'Corrigir E_CONN-503 /v1/app-v1 em produção.' });
  for (const query of ['retencao', 'retenção', 'E_CONN-503', '/v1/app-v1', a.id]) assert.equal(ctx.memory.query({ query }).items[0].id, a.id);
  inspect(db => assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'retencao' AND project_id=?").get('app-v1').n, 1));
  assert.equal(ctx.memory.query({ query: '" OR * --' }).ok, true);
});

test('query budgets, kind filter and explicit abstention', t => {
  const { ctx } = fixture(t); decision(ctx); decision(ctx, { kind: 'fact', title: 'Apenas fato' });
  assert.equal(ctx.memory.query({ query: 'SQLite', kind: 'fact' }).items[0].kind, 'fact');
  const r = ctx.memory.query({ query: 'SQLite', maxTokens: 180 }); assert.ok(estimateTokens(JSON.stringify(r.items)) <= 180);
  const empty = ctx.memory.query({ query: 'Kafka inexistente' }); assert.deepEqual(empty.items, []); assert.equal(empty.abstentionRecommended, true);
  assert.equal(empty.notice, 'Nenhuma evidência ou decisão vigente encontrada para a consulta no escopo do projeto.');
});

test('memory sanitizes all persisted fields including checkpoint/revoke', t => {
  const { ctx, inspect } = fixture(t); const secret = 'ghp_' + 'Z'.repeat(30);
  const a = decision(ctx, { title: `Chave ${secret}`, content: 'PASSWORD=topsecret', sourceRef: `https://u:topsecret@host`, tags: [secret] });
  assert.ok(a.redactedSecretsCount >= 3);
  ctx.memory.revokeDecision({ id: a.id, reason: secret });
  ctx.memory.saveCheckpoint({ taskId: 'sanitize', objective: secret, pending: ['PASSWORD=topsecret'] });
  inspect(db => { for (const sql of ['SELECT * FROM memory_entries', 'SELECT * FROM memory_fts', 'SELECT * FROM task_checkpoints']) { const text = JSON.stringify(db.prepare(sql).all()); assert.ok(!text.includes(secret)); assert.ok(!text.includes('topsecret')); } });
});

test('checkpoint optimistic concurrency and idempotence survives later revisions', t => {
  const { ctx } = fixture(t);
  const a = ctx.memory.saveCheckpoint({ taskId: 't1', objective: 'Primeira', expectedRevision: 0, eventId: 'cp1' }); assert.equal(a.revision, 1);
  assert.equal(ctx.memory.saveCheckpoint({ taskId: 't1', objective: 'Conflito', expectedRevision: 0 }).errorCode, 'CONFLICT');
  assert.equal(ctx.memory.saveCheckpoint({ taskId: 't1', objective: 'Segunda', expectedRevision: 1, eventId: 'cp2' }).revision, 2);
  const replay = ctx.memory.saveCheckpoint({ taskId: 't1', eventId: 'cp1' }); assert.equal(replay.revision, 1); assert.equal(replay.idempotentReplay, true);
  assert.equal(ctx.memory.resume({ taskId: 't1' }).objective, 'Segunda');
});

test('resume <=500 tokens with live decisions, rejected rationale and stale branch/head', t => {
  const { ctx } = fixture(t); const active = decision(ctx); const revoked = decision(ctx, { title: 'Antiga', status: 'candidate' });
  decision(ctx, { kind: 'rejected_approach', title: 'Servidor remoto', rationale: 'Operação deve ser offline.' });
  ctx.memory.saveCheckpoint({ taskId: 'resume', objective: 'Concluir núcleo local', constraints: ['zero deps'], pending: ['revisão'],
    activeDecisions: [active.id, revoked.id], references: ['ADR-004'], affectedFiles: ['src/core/index.js'], gitBranch: 'main', gitHead: 'abc' });
  const r = ctx.memory.resume({ taskId: 'resume', currentGitBranch: 'feature', currentGitHead: 'def' });
  assert.equal(r.ok, true); assert.equal(r.staleCodeWarning, true); assert.ok(r.estimatedTokens <= 500);
  assert.ok(estimateTokens(JSON.stringify(r)) <= 500); assert.equal(r.activeDecisions.length, 1); assert.equal(r.activeDecisions[0].id, active.id);
  assert.equal(r.rejectedApproaches[0].rationale, 'Operação deve ser offline.');
  assert.equal(ctx.memory.resume({ taskId: 'resume', currentGitBranch: 'main', currentGitHead: 'abc' }).staleCodeWarning, false);
  assert.equal(ctx.memory.resume({ taskId: 'resume', currentGitHead: 'def' }).staleCodeWarning, true);
});

test('oversized checkpoint card stays within budget and signals omissions', t => {
  const { ctx } = fixture(t);
  ctx.memory.saveCheckpoint({ taskId: 'big', objective: 'ação '.repeat(10000), constraints: ['regra '.repeat(1000)], pending: ['teste '.repeat(1000)], completed: Array(100).fill('feito') });
  const r = ctx.memory.resume({ taskId: 'big' }); assert.equal(r.ok, true); assert.ok(estimateTokens(JSON.stringify(r)) <= 500); assert.ok(r.omissionsNotice);
  assert.equal(ctx.memory.resume({ taskId: 'big', maxTokens: 1 }).errorCode, 'INVALID_INPUT');
});

test('missing/foreign checkpoints abstain; task IDs and events exact by project', t => {
  const { ctx, open } = fixture(t); const other = open('app-v10');
  ctx.memory.saveCheckpoint({ taskId: 'one', objective: 'Privado', eventId: 'cp' });
  assert.equal(other.memory.resume({ taskId: 'one' }).found, false);
  assert.equal(other.memory.resume({ taskId: 'one' }).abstentionRecommended, true);
  assert.equal(other.memory.saveCheckpoint({ taskId: 'one', objective: 'Outro', eventId: 'cp' }).revision, 1);
  assert.equal(ctx.memory.resume({ taskId: 'one' }).objective, 'Privado');
});

test('forget entry transaction removes exact FTS, associated blob and checkpoints', t => {
  const { ctx, inspect } = fixture(t), evidence = blob(ctx), a = decision(ctx, { sourceRef: evidence.ref });
  ctx.memory.saveCheckpoint({ taskId: 'linked', objective: 'Linked', activeDecisions: [a.id], references: [evidence.ref] });
  const r = ctx.memory.forget({ scope: 'entry', targetId: a.id });
  assert.deepEqual(r.removed, { memory_entries: 1, memory_fts: 1, evidence_blobs: 1, task_checkpoints: 1, metrics_events: 0 });
  assert.match(r.notice, /não são removidas automaticamente/);
  inspect(db => { for (const table of ['memory_entries', 'memory_fts', 'evidence_blobs', 'task_checkpoints']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0); });
});

test('forget task/evidence/project cleans all references without app-v10 crossover', t => {
  const { ctx, open, inspect } = fixture(t), other = open('app-v10');
  for (const c of [ctx, other]) {
    const e = blob(c, { taskId: 'task' }); const m = decision(c, { sourceRef: e.ref });
    c.memory.saveCheckpoint({ taskId: 'task', objective: 'Keep exact isolation', activeDecisions: [m.id] });
    c.memory.saveCheckpoint({ taskId: 'task', objective: 'Revision 2', activeDecisions: [m.id] });
  }
  const r = ctx.memory.forget({ scope: 'task', targetId: 'task' }); assert.equal(r.removed.task_checkpoints, 2); assert.equal(r.removed.memory_fts, 1);
  assert.equal(other.memory.list().items.length, 1); assert.equal(other.memory.resume({ taskId: 'task' }).found, true);
  const e2 = blob(ctx); decision(ctx, { sourceRef: e2.ref }); assert.equal(ctx.memory.forget({ scope: 'evidence', targetId: e2.ref }).removed.memory_entries, 1);
  decision(ctx); blob(ctx); ctx.memory.query({ query: 'SQLite' });
  ctx.memory.forget({ scope: 'project' });
  inspect(db => { for (const table of ['memory_entries', 'memory_fts', 'evidence_blobs', 'task_checkpoints', 'metrics_events']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id=?`).get('app-v1').n, 0); });
  assert.equal(other.memory.list().items.length, 1);
});

test('Markdown export includes frontmatter current decisions reasons checkpoint and sources', t => {
  const { ctx } = fixture(t); decision(ctx); decision(ctx, { kind: 'rejected_approach', title: 'Graph remoto', rationale: 'Offline obrigatório.' });
  const old = decision(ctx, { title: 'Revogada antiga' }); ctx.memory.revokeDecision({ id: old.id, reason: 'Mudou' });
  ctx.memory.saveCheckpoint({ taskId: 'export', objective: 'Entregar', pending: ['QA'], references: ['ADR-004'] });
  const md = ctx.memory.exportMarkdown({ taskId: 'export' }).markdown;
  assert.match(md, /^---\nproject: "app-v1"/); assert.match(md, /Offline obrigatório/); assert.match(md, /## Checkpoint/); assert.match(md, /ADR-004/); assert.ok(!md.includes('Revogada antiga'));
  assert.ok(ctx.memory.exportMarkdown({ includeHistory: true }).markdown.includes('Revogada antiga'));
});

test('metrics aggregate all operations honest local-only costs and exact task scope', t => {
  const { ctx, open } = fixture(t), other = open('app-v10');
  const e = blob(ctx, { taskId: 'm' }); ctx.evidence.expand({ ref: e.ref, taskId: 'm' });
  decision(ctx); ctx.memory.query({ query: 'SQLite' }); ctx.memory.saveCheckpoint({ taskId: 'm', objective: 'Metrics' }); ctx.memory.resume({ taskId: 'm' });
  const r = ctx.metrics.report(); assert.equal(r.operationsCount, 4); assert.equal(r.selectCount, 1); assert.equal(r.expandReconsultCount, 1); assert.equal(r.memoryQueryCount, 1); assert.equal(r.resumeCount, 1);
  assert.equal(r.providerUsageAvailable, false); assert.equal(r.providerCostUsd, null); assert.match(r.disclaimer, /telemetria oficial/);
  assert.ok(r.totalRawBytes > 0); assert.ok(r.totalReturnedBytes > 0); assert.ok(r.totalEstimatedRawTokens > r.totalEstimatedReturnedTokens);
  assert.equal(r.estimatedSavedTokens, r.totalEstimatedRawTokens - r.totalEstimatedReturnedTokens);
  assert.ok(r.latencyMs.p50 <= r.latencyMs.p95 && r.latencyMs.p95 <= r.latencyMs.max);
  assert.equal(ctx.metrics.report({ taskId: 'm' }).operationsCount, 3); assert.equal(other.metrics.report().operationsCount, 0);
});

test('latency p50 p95 max use nearest-rank with known fixture', t => {
  const { ctx, inspect } = fixture(t);
  inspect(db => { for (let i = 1; i <= 20; i++) db.prepare('INSERT INTO metrics_events VALUES(?,?,?,?,?,?,?,?,?,?)').run('app-v1', 'select', null, 10, 5, 4, 2, i, 0, 0); });
  assert.deepEqual(ctx.metrics.report().latencyMs, { p50: 10, p95: 19, max: 20 });
});

test('host scope is immutable; untrusted operation input cannot override project/roots', t => {
  const { ctx, open } = fixture(t); const foreign = open('app-v10');
  const a = decision(ctx, { projectId: 'app-v10' });
  assert.equal(foreign.memory.query({ query: a.id }).items.length, 0);
  assert.throws(() => { ctx.projectId = 'app-v10'; }, TypeError);
  assert.equal(ctx.evidence.select({ filePath: 'C:/Windows/win.ini', allowedRoots: ['C:/Windows'] }).errorCode, 'SCOPE_DENIED');
});

test('validation does not leave records; stdout stays clean', t => {
  const { ctx } = fixture(t);
  assert.equal(decision(ctx, { title: '' }).errorCode, 'INVALID_INPUT'); assert.equal(ctx.memory.list().items.length, 0);
  for (const maxTokens of [0, -1, 0.1, NaN, Infinity]) assert.equal(ctx.evidence.select({ content: 'x', maxTokens }).errorCode, 'INVALID_INPUT');
  assert.throws(() => createNexusContext({ dbPath: ':memory:' }), /projectId/);
  const module = new URL('../src/core/index.js', import.meta.url).href;
  const code = `import {createNexusContext} from ${JSON.stringify(module)}; const c=createNexusContext({dbPath:':memory:',projectId:'stdout'}); c.evidence.select({content:'503',query:'503'}); c.memory.query({query:'missing'}); c.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, '');
  for (const name of fs.readdirSync(new URL('../src/core/', import.meta.url))) assert.doesNotMatch(fs.readFileSync(new URL(`../src/core/${name}`, import.meta.url), 'utf8'), /console\.log|process\.stdout/);
});

test('rejects another application database without changing its schema or journal', t => {
  const { root } = fixture(t), filename = path.join(root, 'other.sqlite');
  const db = new DatabaseSync(filename); db.exec('CREATE TABLE private_application_data(value TEXT)');
  const before = db.prepare('PRAGMA journal_mode').get().journal_mode; db.close();
  assert.throws(() => createNexusContext({ dbPath: filename, projectId: 'app-v1' }), /banco exclusivo/);
  const verify = new DatabaseSync(filename);
  try { assert.equal(verify.prepare('PRAGMA journal_mode').get().journal_mode, before); assert.equal(verify.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 1); }
  finally { verify.close(); }
});

test('canonical allowed root cannot be replaced by an outside junction', t => {
  const { root, open } = fixture(t), allowed = path.join(root, 'allowed'), outside = path.join(root, 'outside');
  fs.mkdirSync(allowed); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'x.txt'), 'sensitive');
  const ctx = open('pinned', { allowedRoots: [allowed] });
  fs.rmdirSync(allowed); fs.symlinkSync(outside, allowed, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(ctx.evidence.select({ filePath: path.join(allowed, 'x.txt') }).errorCode, 'SCOPE_DENIED');
});

test('JSON expand query recovers a rare value near the end of a minified line', t => {
  const { ctx } = fixture(t);
  const content = JSON.stringify({ total: 1500, rows: Array.from({ length: 1500 }, (_, id) => ({ id, status: id === 1499 ? 503 : 200, message: id === 1499 ? 'rare end value' : 'normal' })) });
  const r = ctx.evidence.select({ content, format: 'json', query: 'normal', maxTokens: 120 });
  const expanded = ctx.evidence.expand({ ref: r.ref, query: 'rare end value', maxTokens: 150 });
  assert.equal(JSON.parse(expanded.excerpt).rows[0].status, 503); assert.ok(estimateTokens(expanded.excerpt) <= 150);
});

test('slash-prefixed lexical paths remain searchable as text', t => {
  const { ctx } = fixture(t);
  const r = ctx.evidence.select({ content: 'GET /v1/app-v1 503\nGET /v1/app-v10 200', query: '/v1/app-v1', contextLines: 0 });
  assert.equal(r.ok, true); assert.match(r.excerpt, /503/);
});

test('redaction preserves token counts while removing actual token credentials', () => {
  const input = JSON.stringify({ tokenCount: 40000, totalTokens: 50000, tokens: 100, token: 'private-value', apiKey: 'private-api-value' });
  const r = redactSecrets(input), parsed = JSON.parse(r.text);
  assert.equal(parsed.tokenCount, 40000); assert.equal(parsed.totalTokens, 50000); assert.equal(parsed.tokens, 100);
  assert.equal(parsed.token, '[REDACTED]'); assert.equal(parsed.apiKey, '[REDACTED]'); assert.equal(r.count, 2);
});

test('resume follows a checkpoint-pinned decision to its latest active version', t => {
  const { ctx } = fixture(t), a = decision(ctx, { content: 'Versão original' });
  ctx.memory.saveCheckpoint({ taskId: 'lineage', objective: 'Retomar vigente', activeDecisions: [a.id] });
  const b = decision(ctx, { content: 'Versão vigente', supersedesId: a.id, expectedRevision: 1 });
  const r = ctx.memory.resume({ taskId: 'lineage' });
  assert.equal(r.activeDecisions[0].id, b.id); assert.equal(r.activeDecisions[0].content, 'Versão vigente');
});
