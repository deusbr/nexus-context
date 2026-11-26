import { estimateTokens } from './tokenizer.js';

export function createMetrics(db, projectId) {
  function record(operation, raw, returned, started, taskId) {
    const metrics = {
      rawBytes: Buffer.byteLength(raw), returnedBytes: Buffer.byteLength(returned),
      estimatedRawTokens: estimateTokens(raw), estimatedReturnedTokens: estimateTokens(returned),
      savedTokensEstimate: Math.max(0, estimateTokens(raw) - estimateTokens(returned)),
      latencyMs: Math.max(0, performance.now() - started), providerCostUsd: null,
      telemetryScope: 'local_estimate_only'
    };
    db.prepare(`INSERT INTO metrics_events VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      projectId, operation, taskId ?? null, metrics.rawBytes, metrics.returnedBytes,
      metrics.estimatedRawTokens, metrics.estimatedReturnedTokens, metrics.latencyMs,
      operation === 'expand' ? 1 : 0, Date.now());
    return metrics;
  }
  function report({ taskId } = {}) {
    const rows = db.prepare('SELECT * FROM metrics_events WHERE project_id=?' + (taskId ? ' AND task_id=?' : '')).all(...(taskId ? [projectId, taskId] : [projectId]));
    const sum = field => rows.reduce((n, r) => n + r[field], 0);
    const count = op => rows.filter(r => r.operation === op).length;
    const latency = rows.map(r => r.latency_ms).sort((a, b) => a - b);
    const percentile = p => latency.length ? latency[Math.max(0, Math.ceil(latency.length * p) - 1)] : 0;
    const raw = sum('raw_tokens'), returned = sum('returned_tokens');
    return { ok: true, projectId, operationsCount: rows.length, selectCount: count('select'),
      expandReconsultCount: sum('reconsult_count'), memoryQueryCount: count('query'), resumeCount: count('resume'),
      totalRawBytes: sum('raw_bytes'), totalReturnedBytes: sum('returned_bytes'),
      totalEstimatedRawTokens: raw, totalEstimatedReturnedTokens: returned,
      estimatedSavedTokens: Math.max(0, raw - returned), estimatedReductionPct: raw ? (raw - returned) / raw * 100 : 0,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latency.at(-1) ?? 0 },
      providerUsageAvailable: false, providerCostUsd: null,
      disclaimer: 'Estimativa local baseada em tokenização heurística calibrada; consumo real do provedor requer telemetria oficial do cliente.' };
  }
  return { record, report };
}
