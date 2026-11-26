import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BIN_CLI = path.join(REPO_ROOT, 'bin', 'nexus-context.js');
const BIN_MCP = path.join(REPO_ROOT, 'bin', 'nexus-context-mcp.js');

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus ctx e2e '));
  return dir;
}

test('E2E CLI real: select 503 -> expand -> memory record/approve/query -> checkpoint resume -> forget -> metrics', () => {
  const dir = makeTempWorkspace();
  const dbPath = path.join(dir, 'store.sqlite');
  const logPath = path.join(dir, 'relatório produção 503.log');
  const lines = [];
  for (let i = 1; i <= 500; i += 1) {
    if (i === 250) {
      lines.push('2026-11-26T09:00:00Z [gateway] req=req-9981 status=503 upstream=pagamentos timeout=1200ms token=sk-proj-SECRET12345678901234567890');
    } else {
      lines.push(`2026-11-26T08:59:59Z [gateway] req=req-${i} status=200 ok latency=12ms`);
    }
  }
  fs.writeFileSync(logPath, lines.join('\n'), 'utf8');

  try {
    // 1. select via CLI real com caminho com espaços e acento
    const sel = spawnSync(process.execPath, [
      BIN_CLI, 'select',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--allowed-root', dir,
      '--file', logPath,
      '--format', 'log',
      '--status', '503',
      '--context-lines', '2',
      '--max-tokens', '300',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(sel.status, 0, `select falhou: ${sel.stderr}`);
    const selJson = JSON.parse(sel.stdout);
    assert.equal(selJson.ok, true);
    assert.match(selJson.excerpt, /503/);
    assert.match(selJson.excerpt, /req-9981/);
    assert.ok(!selJson.excerpt.includes('sk-proj-SECRET12345678901234567890'), 'segredo não pode vazar');
    assert.ok(selJson.redactedSecretsCount >= 1);
    assert.ok(selJson.ref && selJson.ref.startsWith('ev_'));

    // 2. expand via CLI real
    const exp = spawnSync(process.execPath, [
      BIN_CLI, 'expand', selJson.ref,
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--start-line', '248',
      '--end-line', '252',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(exp.status, 0, `expand falhou: ${exp.stderr}`);
    const expJson = JSON.parse(exp.stdout);
    assert.equal(expJson.ok, true);
    assert.match(expJson.excerpt, /req-9981/);
    assert.ok(!expJson.excerpt.includes('sk-proj-SECRET12345678901234567890'));

    // 3. memory record + query
    const rec = spawnSync(process.execPath, [
      BIN_CLI, 'memory', 'record',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--kind', 'rejected_approach',
      '--title', 'Proxy global TLS',
      '--content', 'Não interceptar TLS global no host',
      '--rationale', 'Aumenta superfície de credenciais e risco de quebra de cache',
      '--source', 'ADR-004',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(rec.status, 0, `memory record falhou: ${rec.stderr}`);
    const recJson = JSON.parse(rec.stdout);
    assert.equal(recJson.ok, true);

    const qry = spawnSync(process.execPath, [
      BIN_CLI, 'memory', 'query',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--query', 'TLS',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(qry.status, 0, `memory query falhou: ${qry.stderr}`);
    const qryJson = JSON.parse(qry.stdout);
    assert.equal(qryJson.ok, true);
    assert.equal(qryJson.items.length, 1);
    assert.match(qryJson.items[0].rationale, /cache/);

    // 4. checkpoint save + resume
    const cp = spawnSync(process.execPath, [
      BIN_CLI, 'checkpoint', 'save',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--task', 't-e2e-1',
      '--objective', 'Diagnosticar timeout 503 em pagamentos',
      '--constraint', 'Sem dependências externas',
      '--pending', 'Validar fallback de retry',
      '--branch', 'main',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(cp.status, 0, `checkpoint save falhou: ${cp.stderr}`);

    const res = spawnSync(process.execPath, [
      BIN_CLI, 'checkpoint', 'resume',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--task', 't-e2e-1',
      '--branch', 'feat/nova-branch',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, `checkpoint resume falhou: ${res.stderr}`);
    const resJson = JSON.parse(res.stdout);
    assert.equal(resJson.ok, true);
    assert.equal(resJson.found, true);
    assert.equal(resJson.staleCodeWarning, true);
    assert.ok(resJson.estimatedTokens <= 500);

    // 5. metrics report
    const met = spawnSync(process.execPath, [
      BIN_CLI, 'metrics', 'report',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(met.status, 0, `metrics report falhou: ${met.stderr}`);
    const metJson = JSON.parse(met.stdout);
    assert.equal(metJson.providerUsageAvailable, false);
    assert.equal(metJson.providerCostUsd, null);
    assert.ok(metJson.selectCount >= 1);
    assert.ok(metJson.expandReconsultCount >= 1);

    // 6. forget projeto inteiro e verificar ausência
    const fgt = spawnSync(process.execPath, [
      BIN_CLI, 'memory', 'forget',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--scope', 'project',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(fgt.status, 0, `forget falhou: ${fgt.stderr}`);

    const qryAfter = spawnSync(process.execPath, [
      BIN_CLI, 'memory', 'query',
      '--project', 'proj-e2e',
      '--db', dbPath,
      '--query', 'TLS',
      '--json'
    ], { encoding: 'utf8' });
    assert.equal(qryAfter.status, 0);
    const qryAfterJson = JSON.parse(qryAfter.stdout);
    assert.equal(qryAfterJson.items.length, 0);
    assert.equal(qryAfterJson.abstentionRecommended, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E2E MCP stdio real: initialize -> tools/list (3 tools) -> tools/call com core SQLite real sem lixo em stdout', () => {
  const dir = makeTempWorkspace();
  const dbPath = path.join(dir, 'mcp.sqlite');

  try {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'e2e-test', version: '1.0' }, capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'nexus_record',
          arguments: {
            action: 'decision',
            kind: 'decision',
            title: 'Tentativa forjada',
            content: 'Deve ser rejeitada pelo servidor',
            sourceRef: 'chat-e2e',
            projectId: 'projeto-forjado-pelo-modelo'
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'nexus_record',
          arguments: {
            action: 'decision',
            kind: 'decision',
            title: 'Decisão via MCP',
            content: 'Sugestão vinda do modelo deve virar candidate por padrão',
            sourceRef: 'chat-e2e',
            status: 'active'
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'nexus_evidence',
          arguments: {
            action: 'select',
            format: 'log',
            statusCodes: [503],
            contextLines: 1,
            maxTokens: 200,
            content: Array.from({ length: 120 }, (_, i) => i === 80 ? 'line81 status=503 falha rara' : `line${i + 1} status=200 ok`).join('\n')
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'nexus_memory',
          arguments: {
            action: 'query',
            query: 'Decisão via MCP'
          }
        }
      }
    ];

    const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const proc = spawnSync(process.execPath, [
      BIN_MCP,
      '--project', 'proj-host-real',
      '--db', dbPath,
      '--allowed-root', dir
    ], { input, encoding: 'utf8' });

    assert.equal(proc.status, 0, `MCP stdio falhou: ${proc.stderr}`);
    const outLines = proc.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(outLines.length, 6, `Esperava 6 respostas JSON-RPC, recebeu ${outLines.length}: ${proc.stdout}`);

    const responses = outLines.map((line) => JSON.parse(line));
    // 1. initialize
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.protocolVersion, '2025-11-25');
    // 2. tools/list -> exatamente 3 ferramentas
    assert.equal(responses[1].id, 2);
    assert.equal(responses[1].result.tools.length, 3);
    assert.deepEqual(
      responses[1].result.tools.map((t) => t.name).sort(),
      ['nexus_evidence', 'nexus_memory', 'nexus_record']
    );
    // 3. tentativa de forjar projectId -> erro JSON-RPC -32602 (fail-closed)
    assert.equal(responses[2].id, 3);
    assert.equal(responses[2].error.code, -32602);
    // 4. nexus_record -> deve forçar candidate mesmo se modelo pediu active
    assert.equal(responses[3].id, 4);
    const recPayload = JSON.parse(responses[3].result.content[0].text);
    assert.equal(recPayload.ok, true);
    assert.equal(recPayload.status, 'candidate');
    // 5. nexus_evidence -> deve preservar 503 e usar projectId do host
    assert.equal(responses[4].id, 5);
    const evPayload = JSON.parse(responses[4].result.content[0].text);
    assert.equal(evPayload.ok, true);
    assert.equal(evPayload.projectId, 'proj-host-real');
    assert.match(evPayload.excerpt, /503/);
    assert.ok(evPayload.ref && evPayload.ref.startsWith('ev_'));
    // 6. nexus_memory query vigente -> não deve retornar candidate ainda não aprovado
    assert.equal(responses[5].id, 6);
    const memPayload = JSON.parse(responses[5].result.content[0].text);
    assert.equal(memPayload.ok, true);
    assert.equal(memPayload.items.length, 0);
    assert.equal(memPayload.abstentionRecommended, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
