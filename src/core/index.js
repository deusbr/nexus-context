import fs from 'node:fs';
import { openDatabase } from './db.js';
import { createMetrics } from './metrics.js';
import { createEvidence } from './evidence.js';
import { createMemory } from './memory.js';
export { estimateTokens } from './tokenizer.js';
export { redactSecrets, resolveSafePath } from './security.js';

export function createNexusContext(options = {}) {
  if (typeof options.projectId !== 'string' || !options.projectId.trim() || /[\x00-\x1f\x7f]/.test(options.projectId)) {
    throw new TypeError('projectId autenticado obrigatório e sem caracteres de controle.');
  }
  const config = Object.freeze({
    projectId: options.projectId,
    allowedRoots: Object.freeze((options.allowedRoots ?? []).map(root => fs.realpathSync(root))),
    defaultEvidenceTtlSeconds: options.defaultEvidenceTtlSeconds ?? 86400,
    maxEvidenceBytesPerProject: options.maxEvidenceBytesPerProject ?? 20 * 1024 * 1024,
    maxFileBytes: options.maxFileBytes ?? 20 * 1024 * 1024
  });
  if (!Number.isFinite(config.defaultEvidenceTtlSeconds) || config.defaultEvidenceTtlSeconds < 0 ||
      !Number.isSafeInteger(config.maxEvidenceBytesPerProject) || config.maxEvidenceBytesPerProject < 0 ||
      !Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1) throw new TypeError('TTL/cota inválidos.');
  const db = openDatabase(options.dbPath ?? process.env.NEXUS_CONTEXT_DB);
  const metrics = createMetrics(db, config.projectId);
  // Expected validation and filesystem failures become JSON errors; SQL/programming
  // faults propagate rather than masquerading as a successful empty result.
  const wrap = api => Object.freeze(Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args) => {
    try { return fn(...args); }
    catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(error.code))
        return { ok: false, errorCode: 'INVALID_INPUT', message: error instanceof TypeError ? error.message : 'Entrada inválida ou fonte indisponível.' };
      throw error;
    }
  }])));
  return Object.freeze({ projectId: config.projectId,
    evidence: wrap(createEvidence(db, config, metrics)), memory: wrap(createMemory(db, config.projectId, metrics)),
    metrics: Object.freeze({ report: metrics.report }), close: () => db.close() });
}
