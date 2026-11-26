import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  createMcpServer,
  startStdioServer,
  SUPPORTED_PROTOCOL_VERSIONS
} from '../src/mcp/server.js';
import { runCli, CLI_VERSION } from '../src/cli/index.js';

/**
 * Stub fiel ao CONTRACT.md para testes unitários/protocolo em wt-mcp-cli
 * antes do merge com src/core/index.js.
 */
function createMockNexusContext({
  dbPath = ':memory:',
  projectId = 'mock-project',
  allowedRoots = [process.cwd()]
} = {}) {
  const blobs = new Map();
  const memories = new Map();
  const checkpoints = new Map();
  const calls = [];
  let seq = 0;
  let closed = false;
  let metrics = {
    operationsCount: 0,
    selectCount: 0,
    expandReconsultCount: 0,
    memoryQueryCount: 0,
    resumeCount: 0,
    totalRawBytes: 0,
    totalReturnedBytes: 0,
    totalEstimatedRawTokens: 0,
    totalEstimatedReturnedTokens: 0
  };

  function resolveInsideRoots(targetPath) {
    const resolvedTarget = fs.realpathSync(path.resolve(targetPath));
    const ok = allowedRoots.some((root) => {
      try {
        const realRoot = fs.realpathSync(path.resolve(root));
        const rel = path.relative(realRoot, resolvedTarget);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      } catch {
        return false;
      }
    });
    return { ok, resolvedTarget };
  }

  return {
    projectId,
    dbPath,
    allowedRoots,
    calls,
    isClosed: () => closed,
    evidence: {
      select(input) {
        calls.push({ op: 'evidence.select', input });
        metrics.operationsCount += 1;
        metrics.selectCount += 1;

        let rawText = input.content ?? '';
        let source = { kind: 'inline', sha256: '' };

        if (input.filePath) {
          const check = resolveInsideRoots(input.filePath);
          if (!check.ok) {
            return {
              ok: false,
              errorCode: 'SCOPE_DENIED',
              message: `Caminho fora das raízes autorizadas: ${input.filePath}`
            };
          }
          rawText = fs.readFileSync(check.resolvedTarget, 'utf8');
          source = { kind: 'file', path: check.resolvedTarget, sha256: '' };
        }

        const redacted = rawText.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
        const redactedSecretsCount = redacted === rawText ? 0 : 1;
        source.sha256 = crypto.createHash('sha256').update(redacted).digest('hex');

        const lines = redacted.split(/\r?\n/);
        const matched = input.query
          ? lines.filter((l) => l.includes(input.query))
          : lines.slice(0, 5);
        const excerpt = (matched.length > 0 ? matched : lines.slice(0, 3)).join('\n');

        const rawBytes = Buffer.byteLength(redacted, 'utf8');
        const returnedBytes = Buffer.byteLength(excerpt, 'utf8');
        const estimatedRawTokens = Math.ceil(rawBytes / 4);
        const estimatedReturnedTokens = Math.ceil(returnedBytes / 4);

        metrics.totalRawBytes += rawBytes;
        metrics.totalReturnedBytes += returnedBytes;
        metrics.totalEstimatedRawTokens += estimatedRawTokens;
        metrics.totalEstimatedReturnedTokens += estimatedReturnedTokens;

        let ref = null;
        let expiresAt = null;
        if (input.storeOriginal !== false) {
          seq += 1;
          ref = `ev_${seq.toString(16).padStart(6, '0')}`;
          expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
          blobs.set(ref, {
            projectId,
            content: redacted,
            source,
            expiresAt
          });
        }

        return {
          ok: true,
          dataClassification: 'untrusted_evidence',
          projectId,
          mode: excerpt.length < redacted.length ? 'selected' : 'passthrough',
          format: input.format && input.format !== 'auto' ? input.format : 'text',
          source,
          excerpt,
          preserved: {
            totalLines: lines.length,
            matchedCount: matched.length,
            omittedCount: Math.max(0, lines.length - matched.length)
          },
          omissionsNotice:
            lines.length > matched.length
              ? `${lines.length - matched.length} linhas omitidas; use expand(${ref})`
              : null,
          ref,
          expiresAt,
          redactedSecretsCount,
          metrics: {
            rawBytes,
            returnedBytes,
            estimatedRawTokens,
            estimatedReturnedTokens,
            savedTokensEstimate: Math.max(0, estimatedRawTokens - estimatedReturnedTokens),
            latencyMs: 1,
            providerCostUsd: null,
            telemetryScope: 'local_estimate_only'
          }
        };
      },

      expand(input) {
        calls.push({ op: 'evidence.expand', input });
        metrics.operationsCount += 1;
        metrics.expandReconsultCount += 1;

        const blob = blobs.get(input.ref);
        if (!blob || blob.projectId !== projectId) {
          return {
            ok: false,
            errorCode: 'SCOPE_DENIED',
            message: `Referência "${input.ref}" não encontrada no escopo do projeto.`
          };
        }

        const lines = blob.content.split(/\r?\n/);
        const startLine = input.startLine ?? 1;
        const endLine = input.endLine ?? lines.length;
        const slice = lines.slice(Math.max(0, startLine - 1), endLine).join('\n');

        return {
          ok: true,
          dataClassification: 'untrusted_evidence',
          projectId,
          ref: input.ref,
          startLine,
          endLine: Math.min(endLine, lines.length),
          totalLines: lines.length,
          sourceModified: false,
          excerpt: slice
        };
      }
    },

    memory: {
      recordDecision(input) {
        calls.push({ op: 'memory.recordDecision', input });
        for (const existing of memories.values()) {
          if (input.eventId && existing.eventId === input.eventId) {
            return {
              ok: true,
              id: existing.id,
              revision: existing.revision,
              status: existing.status,
              idempotentReplay: true,
              redactedSecretsCount: 0
            };
          }
        }

        let revision = 1;
        if (input.supersedesId) {
          const prev = memories.get(input.supersedesId);
          if (!prev) {
            return { ok: false, errorCode: 'NOT_FOUND', message: 'supersedesId não encontrado.' };
          }
          if (input.expectedRevision !== undefined && prev.revision !== input.expectedRevision) {
            return {
              ok: false,
              errorCode: 'CONFLICT',
              currentRevision: prev.revision,
              message: 'Conflito de revisão.'
            };
          }
          prev.status = 'superseded';
          revision = prev.revision + 1;
        }

        seq += 1;
        const id = `mem_${seq}`;
        const entry = {
          id,
          projectId,
          kind: input.kind,
          title: input.title,
          content: input.content,
          rationale: input.rationale ?? null,
          sourceRef: input.sourceRef,
          effectiveDate: input.effectiveDate ?? '2026-11-26',
          status: input.status ?? 'candidate',
          revision,
          supersedesId: input.supersedesId ?? null,
          eventId: input.eventId ?? null,
          tags: input.tags ?? []
        };
        memories.set(id, entry);

        return {
          ok: true,
          id,
          revision,
          status: entry.status,
          idempotentReplay: false,
          redactedSecretsCount: 0
        };
      },

      approveDecision({ id }) {
        calls.push({ op: 'memory.approveDecision', input: { id } });
        const item = memories.get(id);
        if (!item) return { ok: false, errorCode: 'NOT_FOUND', message: 'Decisão não encontrada.' };
        item.status = 'active';
        return { ok: true, id, status: 'active' };
      },

      revokeDecision({ id, reason }) {
        calls.push({ op: 'memory.revokeDecision', input: { id, reason } });
        const item = memories.get(id);
        if (!item) return { ok: false, errorCode: 'NOT_FOUND', message: 'Decisão não encontrada.' };
        item.status = 'revoked';
        item.revokeReason = reason;
        return { ok: true, id, status: 'revoked' };
      },

      query(input) {
        calls.push({ op: 'memory.query', input });
        metrics.operationsCount += 1;
        metrics.memoryQueryCount += 1;
        const q = (input.query || '').toLowerCase();

        const items = [...memories.values()].filter((m) => {
          if (input.kind && m.kind !== input.kind) return false;
          if (!input.includeHistory && (m.status === 'superseded' || m.status === 'revoked')) {
            return false;
          }
          if (!input.includeCandidates && m.status === 'candidate') return false;
          if (!input.includeHistory && !input.includeCandidates && m.status !== 'active') return false;
          return (
            m.title.toLowerCase().includes(q) ||
            m.content.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q)
          );
        });

        if (items.length === 0) {
          return {
            ok: true,
            dataClassification: 'untrusted_memory',
            items: [],
            abstentionRecommended: true,
            notice: 'Nenhuma evidência ou decisão vigente encontrada para a consulta no escopo do projeto.'
          };
        }

        return {
          ok: true,
          dataClassification: 'untrusted_memory',
          items,
          abstentionRecommended: false
        };
      },

      list(input = {}) {
        calls.push({ op: 'memory.list', input });
        const items = [...memories.values()].filter((m) => {
          if (input.status && m.status !== input.status) return false;
          if (input.kind && m.kind !== input.kind) return false;
          return true;
        });
        return { ok: true, items: items.slice(0, input.limit ?? 50) };
      },

      saveCheckpoint(input) {
        calls.push({ op: 'memory.saveCheckpoint', input });
        const prev = checkpoints.get(input.taskId);
        if (prev && input.eventId && prev.eventId === input.eventId) {
          return { ok: true, taskId: input.taskId, revision: prev.revision, idempotentReplay: true };
        }
        if (prev && input.expectedRevision !== undefined && prev.revision !== input.expectedRevision) {
          return {
            ok: false,
            errorCode: 'CONFLICT',
            currentRevision: prev.revision,
            message: 'Conflito de revisão no checkpoint.'
          };
        }
        const revision = prev ? prev.revision + 1 : 1;
        const saved = { ...input, revision };
        checkpoints.set(input.taskId, saved);
        return { ok: true, taskId: input.taskId, revision, idempotentReplay: false };
      },

      resume(input) {
        calls.push({ op: 'memory.resume', input });
        metrics.operationsCount += 1;
        metrics.resumeCount += 1;

        const cp = checkpoints.get(input.taskId);
        if (!cp) {
          return {
            ok: true,
            found: false,
            abstentionRecommended: true,
            notice: `Checkpoint não encontrado para a tarefa "${input.taskId}".`
          };
        }

        const staleCodeWarning =
          Boolean(input.currentGitBranch && cp.gitBranch && input.currentGitBranch !== cp.gitBranch) ||
          Boolean(input.currentGitHead && cp.gitHead && input.currentGitHead !== cp.gitHead);

        return {
          ok: true,
          found: true,
          taskId: cp.taskId,
          objective: cp.objective,
          constraints: cp.constraints ?? [],
          completed: cp.completed ?? [],
          pending: cp.pending ?? [],
          activeDecisions: cp.activeDecisions ?? [],
          rejectedApproaches: [],
          affectedFiles: cp.affectedFiles ?? [],
          references: cp.references ?? [],
          revision: cp.revision,
          staleCodeWarning,
          omissionsNotice: null,
          estimatedTokens: 120
        };
      },

      forget({ scope, targetId }) {
        calls.push({ op: 'memory.forget', input: { scope, targetId } });
        let removedEntries = 0;
        let removedCheckpoints = 0;
        let removedBlobs = 0;

        if (scope === 'entry' && targetId) {
          if (memories.delete(targetId)) removedEntries = 1;
        } else if (scope === 'evidence' && targetId) {
          if (blobs.delete(targetId)) removedBlobs = 1;
        } else if (scope === 'task' && targetId) {
          if (checkpoints.delete(targetId)) removedCheckpoints = 1;
        } else if (scope === 'project') {
          removedEntries = memories.size;
          removedCheckpoints = checkpoints.size;
          removedBlobs = blobs.size;
          memories.clear();
          checkpoints.clear();
          blobs.clear();
        }

        return {
          ok: true,
          scope,
          removed: {
            memoryEntries: removedEntries,
            taskCheckpoints: removedCheckpoints,
            evidenceBlobs: removedBlobs
          },
          notice: 'Cópias exportadas externamente (ex.: Markdown/Obsidian) não são removidas automaticamente.'
        };
      },

      exportMarkdown({ taskId, includeHistory } = {}) {
        calls.push({ op: 'memory.exportMarkdown', input: { taskId, includeHistory } });
        const lines = ['---', `project: ${projectId}`, '---', '', '# Memória do Projeto'];
        for (const m of memories.values()) {
          if (!includeHistory && m.status !== 'active') continue;
          lines.push(`- [${m.status}] ${m.title}: ${m.content} (fonte: ${m.sourceRef})`);
        }
        if (taskId && checkpoints.has(taskId)) {
          const cp = checkpoints.get(taskId);
          lines.push('', `## Checkpoint ${taskId}`, `Objetivo: ${cp.objective}`);
        }
        return { ok: true, markdown: lines.join('\n') };
      }
    },

    metrics: {
      report(input = {}) {
        calls.push({ op: 'metrics.report', input });
        const saved = Math.max(
          0,
          metrics.totalEstimatedRawTokens - metrics.totalEstimatedReturnedTokens
        );
        const pct =
          metrics.totalEstimatedRawTokens > 0
            ? Math.round((saved / metrics.totalEstimatedRawTokens) * 1000) / 10
            : 0;
        return {
          ...metrics,
          estimatedSavedTokens: saved,
          estimatedReductionPct: pct,
          latencyMs: { p50: 1, p95: 2, max: 3 },
          providerUsageAvailable: false,
          providerCostUsd: null,
          disclaimer:
            'Estimativa local baseada em tokenização heurística calibrada; consumo real do provedor requer telemetria oficial do cliente.'
        };
      }
    },

    close() {
      closed = true;
    }
  };
}

function createBufferWritable() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
    text() {
      return chunks.join('');
    }
  };
}

// ============================================================================
// TESTES DO SERVIDOR MCP
// ============================================================================

test('MCP: handshake initialize suporta todas as versões oficiais e fallback', async () => {
  const ctx = createMockNexusContext({ projectId: 'proj-alpha' });
  const server = createMcpServer({ ctx, serverVersion: '1.2.3' });

  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: `init-${version}`,
      method: 'initialize',
      params: { protocolVersion: version, clientInfo: { name: 'test', version: '1.0' } }
    });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, `init-${version}`);
    assert.equal(res.result.protocolVersion, version);
    assert.equal(res.result.serverInfo.name, 'nexus-context');
    assert.equal(res.result.serverInfo.version, '1.2.3');
    assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  }

  const fallbackRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 99,
    method: 'initialize',
    params: { protocolVersion: '2020-01-01' }
  });
  assert.equal(fallbackRes.result.protocolVersion, '2025-11-25');

  const notif = await server.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  });
  assert.equal(notif, null);
  assert.equal(server.getState().initialized, true);

  const pingRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 100,
    method: 'ping'
  });
  assert.deepEqual(pingRes.result, {});
});

test('MCP: tools/list retorna exatamente 3 ferramentas com schema compacto', async () => {
  const ctx = createMockNexusContext();
  const server = createMcpServer({ ctx });

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });

  const tools = res.result.tools;
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['nexus_evidence', 'nexus_memory', 'nexus_record']
  );

  const serializedBytes = Buffer.byteLength(JSON.stringify(res.result), 'utf8');
  assert.ok(serializedBytes < 3200, `Catálogo muito grande: ${serializedBytes} bytes`);
});

test('MCP: tools/call executa todas as ações de nexus_evidence, nexus_memory e nexus_record', async () => {
  const ctx = createMockNexusContext({ projectId: 'proj-tools' });
  const server = createMcpServer({ ctx, allowDirectActive: true });

  // 1. nexus_evidence -> select
  const selRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'nexus_evidence',
      arguments: {
        action: 'select',
        content: '2026-11-26 INFO ok\n2026-11-26 503 upstream timeout\n2026-11-26 INFO end',
        format: 'log',
        query: '503'
      }
    }
  });
  assert.equal(selRes.result.isError, false);
  const selData = JSON.parse(selRes.result.content[0].text);
  assert.equal(selData.ok, true);
  assert.match(selData.excerpt, /503 upstream timeout/);
  assert.ok(selData.ref?.startsWith('ev_'));

  // 2. nexus_evidence -> expand
  const expRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'nexus_evidence',
      arguments: {
        action: 'expand',
        ref: selData.ref,
        startLine: 1,
        endLine: 3
      }
    }
  });
  assert.equal(expRes.result.isError, false);
  const expData = JSON.parse(expRes.result.content[0].text);
  assert.equal(expData.ok, true);
  assert.match(expData.excerpt, /INFO ok/);

  // 3. nexus_record -> decision (allowDirectActive=true + confirmedByUser=true -> active)
  const recDecRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'nexus_record',
      arguments: {
        action: 'decision',
        kind: 'decision',
        title: 'Usar SQLite FTS5 local',
        content: 'Indexação lexical nativa sem banco vetorial externo.',
        sourceRef: 'ADR-004',
        status: 'active',
        confirmedByUser: true
      }
    }
  });
  const recDecData = JSON.parse(recDecRes.result.content[0].text);
  assert.equal(recDecData.ok, true);
  assert.equal(recDecData.status, 'active');

  // 4. nexus_memory -> query
  const queryRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'nexus_memory',
      arguments: {
        action: 'query',
        query: 'SQLite'
      }
    }
  });
  const queryData = JSON.parse(queryRes.result.content[0].text);
  assert.equal(queryData.items.length, 1);
  assert.equal(queryData.items[0].title, 'Usar SQLite FTS5 local');

  // Revogar decisão para testar action=history
  ctx.memory.revokeDecision({ id: recDecData.id, reason: 'Teste de histórico' });

  const activeAfterRevoke = await server.handleMessage({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: {
      name: 'nexus_memory',
      arguments: { action: 'query', query: 'SQLite' }
    }
  });
  assert.equal(JSON.parse(activeAfterRevoke.result.content[0].text).abstentionRecommended, true);

  // 5. nexus_memory -> history
  const histRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: {
      name: 'nexus_memory',
      arguments: { action: 'history', query: 'SQLite' }
    }
  });
  const histData = JSON.parse(histRes.result.content[0].text);
  assert.equal(histData.items.length, 1);
  assert.equal(histData.items[0].status, 'revoked');

  // 6. nexus_record -> checkpoint
  const cpSaveRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: {
      name: 'nexus_record',
      arguments: {
        action: 'checkpoint',
        taskId: 'TASK-01',
        objective: 'Implementar servidor MCP local',
        constraints: ['Zero deps'],
        completed: ['Handshake'],
        pending: ['Testes E2E'],
        gitBranch: 'feat/mcp-cli-adapters',
        gitHead: 'abc1234'
      }
    }
  });
  assert.equal(JSON.parse(cpSaveRes.result.content[0].text).revision, 1);

  // 7. nexus_memory -> resume (detectando branch divergente)
  const resumeRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: {
      name: 'nexus_memory',
      arguments: {
        action: 'resume',
        taskId: 'TASK-01',
        currentGitBranch: 'main'
      }
    }
  });
  const resumeData = JSON.parse(resumeRes.result.content[0].text);
  assert.equal(resumeData.found, true);
  assert.equal(resumeData.staleCodeWarning, true);
  assert.equal(resumeData.objective, 'Implementar servidor MCP local');
});

test('MCP: política allowDirectActive=false força status candidate e bloqueia sobrescrita de host', async () => {
  const ctx = createMockNexusContext({ projectId: 'proj-seguro' });
  const server = createMcpServer({ ctx }); // allowDirectActive=false por padrão

  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'nexus_record',
      arguments: {
        action: 'decision',
        kind: 'decision',
        title: 'Sugestão automática do modelo',
        content: 'Trocar porta padrão.',
        sourceRef: 'chat-turn-4',
        status: 'active',
        confirmedByUser: true
      }
    }
  });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'candidate');

  // Tentativa de sobrescrever projectId ou allowedRoots é rejeitada com -32602
  for (const field of ['projectId', 'allowedRoots', 'dbPath']) {
    const errRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: `bad-${field}`,
      method: 'tools/call',
      params: {
        name: 'nexus_evidence',
        arguments: {
          action: 'select',
          content: 'abc',
          [field]: 'hijack'
        }
      }
    });
    assert.equal(errRes.error.code, -32602);
  }
});

test('MCP: retorna códigos JSON-RPC -32600, -32601 e -32602 limpos para entradas inválidas', async () => {
  const ctx = createMockNexusContext();
  const server = createMcpServer({ ctx });

  const badReq = await server.handleMessage({ id: 1, method: 'ping' });
  assert.equal(badReq.error.code, -32600);

  const badMethod = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'resources/list'
  });
  assert.equal(badMethod.error.code, -32601);

  const badTool = await server.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'inexistente', arguments: {} }
  });
  assert.equal(badTool.error.code, -32602);

  const badArgs = await server.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nexus_evidence', arguments: { action: 'expand' } }
  });
  assert.equal(badArgs.error.code, -32602);

  const extraProp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'nexus_memory', arguments: { action: 'query', query: 'x', unknownField: 1 } }
  });
  assert.equal(extraProp.error.code, -32602);
});

test('MCP stdio: processa chunks fragmentados, CRLF, UTF-8 e mantém stdout sem lixo', async () => {
  const ctx = createMockNexusContext();
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = createBufferWritable();

  const outChunks = [];
  output.on('data', (chunk) => outChunks.push(chunk.toString('utf8')));

  const runner = startStdioServer({
    ctx,
    input,
    output,
    stderr,
    closeCtxOnEnd: true
  });

  const msg1 = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' }
  });
  // Chunk fragmentado + CRLF + notificação + JSON inválido + linha final sem \n
  input.write(msg1.slice(0, 20));
  input.write(msg1.slice(20) + '\r\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\r\n');
  input.write('{invalid json\n');
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'nexus_evidence',
        arguments: { action: 'select', content: 'Atenção: erro 503 em produção!' }
      }
    })
  );
  input.end();

  await runner.done;
  assert.equal(ctx.isClosed(), true);

  const rawOut = outChunks.join('');
  const lines = rawOut.trim().split('\n');
  assert.equal(lines.length, 3);
  const parsedLines = lines.map((line) => JSON.parse(line));
  assert.equal(parsedLines[0].id, 1);
  assert.equal(parsedLines[0].result.protocolVersion, '2025-11-25');
  assert.equal(parsedLines[1].error.code, -32700);
  assert.equal(parsedLines[2].id, 2);
  assert.match(parsedLines[2].result.content[0].text, /Atenção: erro 503 em produção!/);

  // Verificação estática: zero console.log em código executável de src/mcp/server.js
  const mcpSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/mcp/server.js'),
    'utf8'
  );
  const mcpCodeOnly = mcpSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(/\bconsole\.(log|info|warn|error)\b/.test(mcpCodeOnly), false);
  assert.equal(/\bprocess\.stdout\b/.test(mcpCodeOnly.replace(/output\s*=\s*process\.stdout/, '')), false);
});

// ============================================================================
// TESTES DO CLI
// ============================================================================

test('CLI: --help, --version e erro limpo em comando desconhecido', async () => {
  const out = createBufferWritable();
  const err = createBufferWritable();

  const helpCode = await runCli(['--help'], { stdout: out, stderr: err });
  assert.equal(helpCode, 0);
  assert.match(out.text(), /NEXUS Contexto CLI/);
  assert.equal(err.text(), '');

  const verOut = createBufferWritable();
  const verCode = await runCli(['--version', '--json'], { stdout: verOut, stderr: err });
  assert.equal(verCode, 0);
  assert.deepEqual(JSON.parse(verOut.text()), { name: 'nexus-context', version: CLI_VERSION });

  const badOut = createBufferWritable();
  const badErr = createBufferWritable();
  const badCode = await runCli(['comando-invalido'], {
    createNexusContext: createMockNexusContext,
    stdout: badOut,
    stderr: badErr
  });
  assert.equal(badCode, 2);
  assert.match(badErr.text(), /Comando desconhecido/);
});

test('CLI: select (arquivo com espaços + UTF-8 e stdin), expand e metrics report', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus ctx cli '));
  try {
    const spacedDir = path.join(tmpDir, 'pasta com espaços');
    fs.mkdirSync(spacedDir, { recursive: true });
    const logFile = path.join(spacedDir, 'serviço produção.log');
    fs.writeFileSync(
      logFile,
      'linha 1 ok\nlinha 2 HTTP 503 falha crítica\nAuthorization: Bearer segredo123\n',
      'utf8'
    );

    const ctx = createMockNexusContext({
      projectId: 'proj-cli',
      allowedRoots: [tmpDir]
    });
    const factory = () => ctx;

    // select via --file
    const out1 = createBufferWritable();
    const err1 = createBufferWritable();
    const code1 = await runCli(
      ['select', '--file', logFile, '--query', '503', '--allowed-root', tmpDir, '--json'],
      { createNexusContext: factory, stdout: out1, stderr: err1, cwd: tmpDir }
    );
    assert.equal(code1, 0, err1.text());
    const selJson = JSON.parse(out1.text());
    assert.equal(selJson.ok, true);
    assert.match(selJson.excerpt, /HTTP 503/);
    assert.ok(selJson.ref);

    // expand via ref
    const out2 = createBufferWritable();
    const code2 = await runCli(['expand', selJson.ref, '--start-line', '1', '--end-line', '3'], {
      createNexusContext: factory,
      stdout: out2,
      stderr: err1,
      cwd: tmpDir
    });
    assert.equal(code2, 0);
    assert.match(out2.text(), /NEXUS Expansão/);
    assert.match(out2.text(), /\[REDACTED\]/);

    // select via stdin
    const stdin = new PassThrough();
    const out3 = createBufferWritable();
    stdin.end('evento 1\nevento 2 timeout\n');
    const code3 = await runCli(['select', '--query', 'timeout'], {
      createNexusContext: factory,
      stdin,
      stdout: out3,
      stderr: err1,
      cwd: tmpDir
    });
    assert.equal(code3, 0);
    assert.match(out3.text(), /evento 2 timeout/);

    // metrics report
    const out4 = createBufferWritable();
    const code4 = await runCli(['metrics', 'report', '--json'], {
      createNexusContext: factory,
      stdout: out4,
      stderr: err1,
      cwd: tmpDir
    });
    assert.equal(code4, 0);
    const metricsJson = JSON.parse(out4.text());
    assert.equal(metricsJson.selectCount, 2);
    assert.equal(metricsJson.expandReconsultCount, 1);
    assert.equal(metricsJson.providerCostUsd, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: ciclo completo memory (record/list/query/approve/revoke/export/forget) e checkpoint', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus mem cli '));
  try {
    const ctx = createMockNexusContext({ projectId: 'proj-mem', allowedRoots: [tmpDir] });
    const factory = () => ctx;
    const err = createBufferWritable();

    // record candidate
    const recOut = createBufferWritable();
    assert.equal(
      await runCli(
        [
          'memory',
          'record',
          '--kind',
          'decision',
          '--title',
          'Padronizar ESM',
          '--content',
          'Usar Node 24 ESM nativo sem dependências.',
          '--source',
          'CONTRACT.md',
          '--status',
          'candidate',
          '--json'
        ],
        { createNexusContext: factory, stdout: recOut, stderr: err, cwd: tmpDir }
      ),
      0
    );
    const rec = JSON.parse(recOut.text());
    assert.equal(rec.status, 'candidate');

    // list
    const listOut = createBufferWritable();
    assert.equal(
      await runCli(['memory', 'list', '--status', 'candidate', '--json'], {
        createNexusContext: factory,
        stdout: listOut,
        stderr: err,
        cwd: tmpDir
      }),
      0
    );
    assert.equal(JSON.parse(listOut.text()).items.length, 1);

    // approve
    const appOut = createBufferWritable();
    assert.equal(
      await runCli(['memory', 'approve', rec.id, '--json'], {
        createNexusContext: factory,
        stdout: appOut,
        stderr: err,
        cwd: tmpDir
      }),
      0
    );
    assert.equal(JSON.parse(appOut.text()).status, 'active');

    // query
    const qOut = createBufferWritable();
    assert.equal(
      await runCli(['memory', 'query', 'ESM'], {
        createNexusContext: factory,
        stdout: qOut,
        stderr: err,
        cwd: tmpDir
      }),
      0
    );
    assert.match(qOut.text(), /Padronizar ESM/);

    // checkpoint save + resume
    const cpSaveOut = createBufferWritable();
    assert.equal(
      await runCli(
        [
          'checkpoint',
          'save',
          '--task',
          'T-99',
          '--objective',
          'Fechar fase 2 MCP/CLI',
          '--constraint',
          'Zero console.log',
          '--completed',
          'MCP;CLI',
          '--pending',
          'Commit',
          '--branch',
          'feat/mcp-cli-adapters',
          '--json'
        ],
        { createNexusContext: factory, stdout: cpSaveOut, stderr: err, cwd: tmpDir }
      ),
      0
    );
    assert.equal(JSON.parse(cpSaveOut.text()).revision, 1);

    const cpResOut = createBufferWritable();
    assert.equal(
      await runCli(['checkpoint', 'resume', 'T-99', '--branch', 'main'], {
        createNexusContext: factory,
        stdout: cpResOut,
        stderr: err,
        cwd: tmpDir
      }),
      0
    );
    assert.match(cpResOut.text(), /Fechar fase 2 MCP\/CLI/);
    assert.match(cpResOut.text(), /Branch ou HEAD Git divergem/);

    // export para arquivo com espaço
    const exportPath = path.join(tmpDir, 'nota exportada.md');
    const expOut = createBufferWritable();
    assert.equal(
      await runCli(['memory', 'export', '--task', 'T-99', '--out', exportPath], {
        createNexusContext: factory,
        stdout: expOut,
        stderr: err,
        cwd: tmpDir
      }),
      0
    );
    assert.equal(fs.existsSync(exportPath), true);
    assert.match(fs.readFileSync(exportPath, 'utf8'), /Padronizar ESM/);

    // revoke + forget
    const revOut = createBufferWritable();
    assert.equal(
      await runCli(['memory', 'revoke', rec.id, '--reason', 'Substituída', '--json'], {
        createNexusContext: factory,
        stdout: revOut,
        stderr: err,
        cwd: tmpDir
      }),
      0
    );
    assert.equal(JSON.parse(revOut.text()).status, 'revoked');

    const forgetOut = createBufferWritable();
    assert.equal(
      await runCli(['memory', 'forget', '--scope', 'entry', '--target', rec.id, '--json'], {
        createNexusContext: factory,
        stdout: forgetOut,
        stderr: err,
        cwd: tmpDir
      }),
      0
    );
    assert.equal(JSON.parse(forgetOut.text()).removed.memoryEntries, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: install-config gera configurações válidas para os 4 clientes no Windows', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus cfg '));
  try {
    const clients = ['openbot', 'codex', 'claude-code', 'gemini-cli'];
    const err = createBufferWritable();

    for (const client of clients) {
      const out = createBufferWritable();
      const outFile = path.join(tmpDir, 'out with space', `${client}.cfg`);
      const code = await runCli(
        [
          'install-config',
          client,
          '--project',
          'proj-win',
          '--db',
          path.join(tmpDir, 'db dir', 'ctx.sqlite'),
          '--allowed-root',
          path.join(tmpDir, 'root dir'),
          '--out',
          outFile,
          '--json'
        ],
        { stdout: out, stderr: err, cwd: tmpDir }
      );
      assert.equal(code, 0, err.text());
      const res = JSON.parse(out.text());
      assert.equal(res.ok, true);
      assert.equal(res.client, client);
      assert.match(res.content, /nexus-context-mcp\.js/);
      assert.ok(!/nexus-context-mcp\.cmd/.test(res.content), 'install-config não deve invocar wrapper .cmd via cmd.exe');
      assert.equal(fs.existsSync(outFile), true);
      if (client === 'codex') {
        assert.match(res.content, /\[mcp_servers\.nexus_context\]/);
      } else if (client === 'openbot') {
        const parsed = JSON.parse(res.content);
        assert.equal(parsed.transport, 'stdio');
      } else {
        const parsed = JSON.parse(res.content);
        assert.ok(parsed.mcpServers['nexus-context']);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: subcomando mcp inicia servidor stdio limpo sem poluir stdout', async () => {
  const ctx = createMockNexusContext({ projectId: 'proj-mcp-cli' });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = createBufferWritable();
  const chunks = [];
  stdout.on('data', (c) => chunks.push(c.toString('utf8')));

  stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' }
    }) + '\n'
  );
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  stdin.end();

  const exitCode = await runCli(['mcp', '--project', 'proj-mcp-cli'], {
    createNexusContext: () => ctx,
    stdin,
    stdout,
    stderr
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.isClosed(), true);
  assert.equal(stderr.text(), '');
  const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.protocolVersion, '2025-11-25');
  assert.equal(lines[1].result.tools.length, 3);
});
