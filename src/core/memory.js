import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { redactSecrets } from './security.js';
import { estimateTokens, budget, clipText } from './tokenizer.js';

const NOTICE = 'Nenhuma evidência ou decisão vigente encontrada para a consulta no escopo do projeto.';
const KINDS = ['decision', 'constraint', 'fact', 'rejected_approach', 'preference'];
const fail = (errorCode, message, rest = {}) => ({ ok: false, errorCode, message, ...rest });
const normalize = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
const item = r => ({ id: r.id, kind: r.kind, title: r.title, content: r.content,
  rationale: r.rationale, sourceRef: r.source_ref, effectiveDate: r.effective_date,
  status: r.status, revision: r.revision, supersedesId: r.supersedes_id,
  supersededBy: r.superseded_by, tags: JSON.parse(r.tags), revokedReason: r.revoked_reason });
const required = (value, field) => { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} obrigatório.`); };
function clean(value, stats) {
  if (typeof value === 'string') { const r = redactSecrets(value); stats.count += r.count; return r.text; }
  if (Array.isArray(value)) return value.map(v => clean(v, stats));
  return value;
}
function stringArray(value, field) {
  if (value !== undefined && (!Array.isArray(value) || value.some(x => typeof x !== 'string'))) throw new TypeError(`${field} deve ser uma lista de textos.`);
  return value ?? [];
}

export function createMemory(db, projectId, metrics) {
  const get = id => db.prepare('SELECT * FROM memory_entries WHERE project_id=? AND id=?').get(projectId, id);
  const all = () => db.prepare('SELECT * FROM memory_entries WHERE project_id=? ORDER BY rowid DESC').all(projectId);
  const latest = taskId => db.prepare('SELECT * FROM task_checkpoints WHERE project_id=? AND task_id=? ORDER BY revision DESC LIMIT 1').get(projectId, taskId);
  const decisionResult = (row, replay = false) => ({ ok: true, id: row.id, revision: row.revision,
    status: row.status, idempotentReplay: replay, redactedSecretsCount: row.redacted_count });

  function recordDecision(input = {}) {
    return transaction(db, () => {
      if (input.eventId) {
        const existing = db.prepare('SELECT * FROM memory_entries WHERE project_id=? AND event_id=?').get(projectId, input.eventId);
        if (existing) return decisionResult(existing, true);
      }
      if (!KINDS.includes(input.kind)) throw new TypeError('kind inválido.');
      for (const key of ['title', 'content', 'sourceRef']) required(input[key], key);
      const status = input.status ?? 'active';
      if (!['active', 'candidate'].includes(status)) throw new TypeError('status inválido.');
      let old;
      if (input.supersedesId) {
        old = get(input.supersedesId);
        if (!old) return fail('NOT_FOUND', 'Decisão anterior indisponível neste projeto.');
        if ((input.expectedRevision !== undefined && input.expectedRevision !== old.revision) || old.superseded_by || ['revoked', 'superseded'].includes(old.status))
          return fail('CONFLICT', 'A decisão anterior foi alterada.', { currentRevision: old.revision });
      } else if (input.expectedRevision !== undefined && input.expectedRevision !== 0) return fail('CONFLICT', 'Nova decisão exige revisão inicial zero.', { currentRevision: 0 });
      const stats = { count: 0 }, id = `mem_${randomUUID()}`;
      const safe = {};
      for (const key of ['title', 'content', 'rationale', 'sourceRef', 'effectiveDate']) safe[key] = clean(input[key] ?? '', stats);
      const tags = clean(stringArray(input.tags, 'tags'), stats);
      db.prepare(`INSERT INTO memory_entries(project_id,id,kind,title,content,rationale,source_ref,effective_date,status,
        revision,supersedes_id,superseded_by,event_id,tags,revoked_reason,redacted_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        projectId, id, input.kind, safe.title, safe.content, safe.rationale, safe.sourceRef,
        safe.effectiveDate || new Date().toISOString(), status, old ? old.revision + 1 : 1,
        old?.id ?? null, null, input.eventId ?? null, JSON.stringify(tags), null, stats.count);
      if (old && status === 'active') {
        db.prepare("UPDATE memory_entries SET status='superseded',superseded_by=? WHERE project_id=? AND id=?").run(id, projectId, old.id);
      }
      return decisionResult(get(id));
    });
  }
  function approveDecision({ id } = {}) {
    return transaction(db, () => {
      const row = get(id ?? ''); if (!row) return fail('NOT_FOUND', 'Decisão indisponível.');
      if (row.status !== 'candidate') return fail('CONFLICT', 'Somente candidatos podem ser aprovados.', { currentRevision: row.revision });
      if (row.supersedes_id) {
        const old = get(row.supersedes_id);
        if (!old || old.status !== 'active' || old.superseded_by) {
          return fail('CONFLICT', 'A decisão anterior já foi alterada ou encerrada antes da aprovação.', { currentRevision: old?.revision ?? 0 });
        }
        db.prepare("UPDATE memory_entries SET status='superseded',superseded_by=? WHERE project_id=? AND id=?").run(row.id, projectId, old.id);
      }
      db.prepare("UPDATE memory_entries SET status='active',revision=revision+1 WHERE project_id=? AND id=?").run(projectId, id);
      return decisionResult(get(id));
    });
  }
  function revokeDecision({ id, reason } = {}) {
    required(reason, 'reason');
    return transaction(db, () => {
      const row = get(id ?? ''); if (!row) return fail('NOT_FOUND', 'Decisão indisponível.');
      if (row.status === 'superseded' || row.status === 'revoked') return fail('CONFLICT', 'Decisão já encerrada.', { currentRevision: row.revision });
      db.prepare("UPDATE memory_entries SET status='revoked',revoked_reason=?,revision=revision+1 WHERE project_id=? AND id=?").run(redactSecrets(reason).text, projectId, id);
      return decisionResult(get(id));
    });
  }
  function query(input = {}) {
    const started = performance.now(), max = budget(input.maxTokens, 600);
    required(input.query, 'query');
    const limit = budget(input.limit, 20);
    const words = input.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const expression = words.map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
    const ids = new Set(expression ? db.prepare('SELECT id FROM memory_fts WHERE memory_fts MATCH ? AND project_id=?').all(expression, projectId).map(r => r.id) : []);
    const needle = normalize(input.query);
    const rows = all().filter(r => (input.includeHistory ? (r.status !== 'candidate' || input.includeCandidates)
      : r.status === 'active' || input.includeCandidates && r.status === 'candidate') && (!input.kind || r.kind === input.kind));
    const matches = rows.filter(r => ids.has(r.id) || [r.id, r.title, r.content, r.rationale, r.source_ref, r.tags].some(v => normalize(v).includes(needle)));
    const items = [];
    for (const row of matches.slice(0, limit)) {
      const entry = item(row);
      if (estimateTokens(JSON.stringify([...items, entry])) > max) break;
      items.push(entry);
    }
    const result = { ok: true, projectId, dataClassification: 'untrusted_memory', items,
      abstentionRecommended: items.length === 0, notice: items.length ? null : NOTICE,
      omissionsNotice: items.length < matches.length ? 'Resultados omitidos pelo orçamento ou limite; refine a consulta.' : null };
    result.metrics = metrics.record('query', JSON.stringify(matches.map(item)), JSON.stringify(items), started);
    return result;
  }
  function saveCheckpoint(input = {}) {
    required(input.taskId, 'taskId');
    return transaction(db, () => {
      if (input.eventId) {
        const oldEvent = db.prepare('SELECT * FROM task_checkpoints WHERE project_id=? AND event_id=?').get(projectId, input.eventId);
        if (oldEvent) return { ok: true, taskId: oldEvent.task_id, revision: oldEvent.revision, idempotentReplay: true };
      }
      required(input.objective, 'objective');
      const previous = latest(input.taskId), currentRevision = previous?.revision ?? 0;
      if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) return fail('CONFLICT', 'Checkpoint alterado.', { currentRevision });
      const stats = { count: 0 }, payload = { objective: clean(input.objective, stats) };
      for (const key of ['constraints', 'completed', 'pending', 'activeDecisions', 'affectedFiles', 'references']) payload[key] = clean(stringArray(input[key], key), stats);
      for (const key of ['gitBranch', 'gitHead']) payload[key] = clean(input[key] ?? '', stats);
      const revision = currentRevision + 1;
      db.prepare('INSERT INTO task_checkpoints VALUES(?,?,?,?,?)').run(projectId, input.taskId, revision, input.eventId ?? null, JSON.stringify(payload));
      return { ok: true, taskId: input.taskId, revision, idempotentReplay: false, redactedSecretsCount: stats.count };
    });
  }
  function resume(input = {}) {
    const started = performance.now(), max = budget(input.maxTokens, 500), checkpoint = latest(input.taskId ?? '');
    if (!checkpoint) {
      const result = { ok: true, found: false, abstentionRecommended: true, notice: NOTICE };
      metrics.record('resume', '', JSON.stringify(result), started, input.taskId); return result;
    }
    const saved = JSON.parse(checkpoint.payload), entries = all(), live = entries.filter(r => r.status === 'active');
    const pinned = new Set(saved.activeDecisions);
    const byId = new Map(entries.map(r => [r.id, r]));
    for (const id of saved.activeDecisions) {
      let row = byId.get(id);
      const visited = new Set();
      while (row?.superseded_by && !visited.has(row.id)) {
        visited.add(row.id); pinned.add(row.superseded_by); row = byId.get(row.superseded_by);
      }
    }
    const result = { ok: true, found: true, projectId, dataClassification: 'untrusted_memory',
      objective: saved.objective, constraints: saved.constraints, completed: saved.completed, pending: saved.pending,
      activeDecisions: live.filter(r => r.kind === 'decision' && (!pinned.size || pinned.has(r.id) || pinned.has(r.source_ref)))
        .map(r => ({ id: r.id, title: r.title, content: r.content, sourceRef: r.source_ref })),
      rejectedApproaches: live.filter(r => r.kind === 'rejected_approach').map(r => ({ id: r.id, title: r.title, rationale: r.rationale })),
      affectedFiles: saved.affectedFiles, references: saved.references,
      revision: checkpoint.revision, staleCodeWarning: Boolean(
        input.currentGitBranch !== undefined && input.currentGitBranch !== saved.gitBranch ||
        input.currentGitHead !== undefined && input.currentGitHead !== saved.gitHead),
      omissionsNotice: null, estimatedTokens: 0 };
    const raw = JSON.stringify({ saved, live: live.map(item) });
    const size = () => { result.estimatedTokens = estimateTokens(JSON.stringify(result)); return estimateTokens(JSON.stringify(result)); };
    // Drop complete low-priority entries, never synthesize a decision from truncated text.
    for (const key of ['rejectedApproaches', 'completed', 'affectedFiles', 'references', 'activeDecisions', 'constraints', 'pending']) {
      while (size() > max && result[key].length) { result[key].pop(); result.omissionsNotice = 'Cartão parcial; consulte a memória e o checkpoint completo.'; }
    }
    if (size() > max) {
      result.omissionsNotice = 'Cartão parcial; consulte a memória e o checkpoint completo.';
      while (size() > max && result.objective.length) result.objective = clipText(result.objective, Math.max(0, estimateTokens(result.objective) - Math.max(1, size() - max)));
    }
    if (size() > max) return fail('INVALID_INPUT', 'Orçamento insuficiente para os campos obrigatórios do cartão.');
    while (result.estimatedTokens !== estimateTokens(JSON.stringify(result))) result.estimatedTokens = estimateTokens(JSON.stringify(result));
    metrics.record('resume', raw, JSON.stringify(result), started, input.taskId);
    return result;
  }
  function list(input = {}) {
    const limit = budget(input.limit, 100);
    return { ok: true, projectId, dataClassification: 'untrusted_memory', items: all().filter(r => (!input.status || r.status === input.status) && (!input.kind || r.kind === input.kind)).slice(0, limit).map(item) };
  }
  function forget({ scope, targetId } = {}) {
    if (!['entry', 'task', 'evidence', 'project'].includes(scope)) throw new TypeError('scope inválido.');
    if (scope !== 'project') required(targetId, 'targetId');
    return transaction(db, () => {
      const entries = all(), blobs = db.prepare('SELECT * FROM evidence_blobs WHERE project_id=?').all(projectId);
      const checkpoints = db.prepare('SELECT * FROM task_checkpoints WHERE project_id=?').all(projectId);
      const entryIds = new Set(), refs = new Set(), tasks = new Set();
      if (scope === 'project') { entries.forEach(r => entryIds.add(r.id)); blobs.forEach(r => refs.add(r.ref)); checkpoints.forEach(r => tasks.add(r.task_id)); }
      if (scope === 'entry') entryIds.add(targetId);
      if (scope === 'evidence') refs.add(targetId);
      if (scope === 'task') tasks.add(targetId);
      // Exact reference cascade, scoped by project for every read and mutation.
      let changed;
      do {
        const before = entryIds.size + refs.size + tasks.size;
        for (const r of entries) {
          if (refs.has(r.source_ref)) entryIds.add(r.id);
          if (entryIds.has(r.id) && blobs.some(b => b.ref === r.source_ref)) refs.add(r.source_ref);
        }
        for (const b of blobs) if (tasks.has(b.task_id)) refs.add(b.ref);
        for (const cp of checkpoints) {
          const payload = JSON.parse(cp.payload);
          if ([...payload.activeDecisions, ...payload.references].some(x => entryIds.has(x) || refs.has(x))) tasks.add(cp.task_id);
          if (tasks.has(cp.task_id)) for (const id of payload.activeDecisions) if (entries.some(e => e.id === id)) entryIds.add(id);
        }
        changed = before !== entryIds.size + refs.size + tasks.size;
      } while (changed);
      const counts = { memory_entries: 0, memory_fts: 0, evidence_blobs: 0, task_checkpoints: 0, metrics_events: 0 };
      for (const id of entryIds) {
        counts.memory_fts += db.prepare('SELECT count(*) AS n FROM memory_fts WHERE project_id=? AND id=?').get(projectId, id).n;
        counts.memory_entries += Number(db.prepare('DELETE FROM memory_entries WHERE project_id=? AND id=?').run(projectId, id).changes);
      }
      for (const ref of refs) counts.evidence_blobs += Number(db.prepare('DELETE FROM evidence_blobs WHERE project_id=? AND ref=?').run(projectId, ref).changes);
      for (const task of tasks) {
        counts.task_checkpoints += Number(db.prepare('DELETE FROM task_checkpoints WHERE project_id=? AND task_id=?').run(projectId, task).changes);
        counts.metrics_events += Number(db.prepare('DELETE FROM metrics_events WHERE project_id=? AND task_id=?').run(projectId, task).changes);
      }
      if (scope === 'project') counts.metrics_events += Number(db.prepare('DELETE FROM metrics_events WHERE project_id=?').run(projectId).changes);
      return { ok: true, projectId, removed: counts, notice: 'Cópias exportadas externamente (Markdown/Obsidian, backups) não são removidas automaticamente.' };
    });
  }
  function exportMarkdown({ taskId, includeHistory = false } = {}) {
    const escape = text => String(text).replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#])/g, '\\$1');
    const lines = ['---', `project: ${JSON.stringify(projectId)}`, 'classification: untrusted_memory', '---', '', '# NEXUS Contexto', '', '## Decisões e memória'];
    for (const row of all().filter(r => includeHistory ? r.status !== 'candidate' : r.status === 'active')) {
      lines.push('', `### ${escape(row.title)}`, '', `- ID: ${escape(row.id)}`, `- Tipo: ${row.kind}; estado: ${row.status}; revisão: ${row.revision}`, `- Data: ${escape(row.effective_date)}`, '', escape(row.content), '', `Motivo: ${escape(row.rationale)}`, '', `Fonte: ${escape(row.source_ref)}`);
      if (row.revoked_reason) lines.push('', `Revogação: ${escape(row.revoked_reason)}`);
    }
    if (taskId) {
      const checkpoint = latest(taskId);
      if (checkpoint) {
        const saved = JSON.parse(checkpoint.payload);
        lines.push('', '## Checkpoint', '', `Tarefa: ${escape(taskId)}; revisão: ${checkpoint.revision}`, '', escape(saved.objective));
        for (const key of ['constraints', 'completed', 'pending', 'activeDecisions', 'affectedFiles', 'references']) lines.push('', `### ${key}`, ...saved[key].map(v => `- ${escape(v)}`));
      }
    }
    return { ok: true, projectId, markdown: lines.join('\n') + '\n' };
  }
  return { recordDecision, approveDecision, revokeDecision, query, saveCheckpoint, resume, forget, list, exportMarkdown };
}
