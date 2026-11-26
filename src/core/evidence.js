import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolveSafePath, redactSecrets } from './security.js';
import { estimateTokens, budget, clipText } from './tokenizer.js';
import { transaction } from './db.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const failure = (errorCode, message) => ({ ok: false, errorCode, message });
const fieldValue = (obj, key) => key.split('.').reduce((v, k) => v != null && Object.hasOwn(Object(v), k) ? v[k] : undefined, obj);

const MAX_REGEX_PATTERN_LEN = 128;
const MAX_REGEX_LINE_LEN = 8192;

function isSafeLinearRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LEN) return false;
  let inClass = false;
  let totalQuantifiers = 0;
  let unboundedQuantifiers = 0;
  let prevWasQuantifier = false;
  const stack = [{ hasQuantifier: false, hasAlternation: false }];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (!next) return false;
      // Reject backreferences (\1..\9) which can cause exponential backtracking.
      if (!inClass && next >= '1' && next <= '9') return false;
      prevWasQuantifier = false;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') { inClass = false; prevWasQuantifier = false; }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === '(') {
      if (pattern[i + 1] === '?') {
        // Allow only non-capturing group (?:...); reject lookarounds and other extensions.
        if (pattern[i + 2] !== ':') return false;
        stack.push({ hasQuantifier: false, hasAlternation: false });
        prevWasQuantifier = false;
        i += 2;
        continue;
      }
      stack.push({ hasQuantifier: false, hasAlternation: false });
      prevWasQuantifier = false;
      continue;
    }
    if (ch === ')') {
      if (stack.length <= 1) return false;
      const group = stack.pop();
      const next = pattern[i + 1];
      const quantified = next === '+' || next === '*' || next === '{' || next === '?';
      // Reject any quantified group containing internal quantifiers or alternations: blocks (a+)+, ((a)+)+, (a?a?)+, (a{1,10})+, (a|a)+.
      if (quantified && (group.hasQuantifier || group.hasAlternation)) return false;
      const parent = stack[stack.length - 1];
      if (group.hasQuantifier || quantified) parent.hasQuantifier = true;
      if (group.hasAlternation) parent.hasAlternation = true;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === '|') {
      stack[stack.length - 1].hasAlternation = true;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === '+' || ch === '*' || ch === '{' || ch === '?') {
      if (ch === '?' && prevWasQuantifier) {
        // Lazy modifier (+?, *?, ??, {m,n}?) immediately after a quantifier.
        prevWasQuantifier = false;
        continue;
      }
      let isUnbounded = ch === '+' || ch === '*';
      if (ch === '{') {
        const endBrace = pattern.indexOf('}', i + 1);
        if (endBrace === -1) return false;
        const spec = pattern.slice(i + 1, endBrace);
        if (!/^\d+(?:,\d*)?$/.test(spec)) return false;
        if (spec.endsWith(',')) isUnbounded = true;
        i = endBrace;
      }
      totalQuantifiers++;
      if (isUnbounded) unboundedQuantifiers++;
      // Allow at most 1 unbounded quantifier and 2 total quantifiers to prevent O(N^3) and O(2^N) ReDoS.
      if (unboundedQuantifiers > 1 || totalQuantifiers > 2) return false;
      stack[stack.length - 1].hasQuantifier = true;
      prevWasQuantifier = true;
      continue;
    }
    prevWasQuantifier = false;
  }
  return !inClass && stack.length === 1;
}

function matcher(input) {
  const predicate = input.predicate?.match(/^([\w.]+)\s*(>=|<=|!=|=|>|<)\s*(.*?)\s*$/);
  if (input.predicate && !predicate) throw new TypeError('Predicado inválido; use campo=valor ou comparação numérica.');
  let regex;
  if (/^\/.*\/[imu]*$/.test(input.query ?? '')) {
    const m = input.query.match(/^\/(.*)\/([imu]*)$/);
    if (!m || !isSafeLinearRegex(m[1])) throw new TypeError('Regex inválida ou complexa.');
    regex = new RegExp(m[1], m[2]);
  }
  const term = String(input.query ?? '').toLocaleLowerCase('pt-BR');
  const numericTermRegex = /^\d+$/.test(term) ? new RegExp(`\\b${term}\\b`) : null;
  const statusRegexes = input.statusCodes?.length ? input.statusCodes.map(code => new RegExp(`\\b${Number(code)}\\b`)) : null;
  return value => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (predicate) {
      const [, key, op, raw] = predicate, actual = fieldValue(value, key);
      const desired = raw.replace(/^['"]|['"]$/g, '');
      if (actual === undefined) return false;
      const cmp = op === '=' ? String(actual).toLowerCase() === desired.toLowerCase()
        : op === '!=' ? String(actual).toLowerCase() !== desired.toLowerCase()
        : Number.isFinite(Number(actual)) && Number.isFinite(Number(desired)) &&
          ({ '>': Number(actual) > Number(desired), '<': Number(actual) < Number(desired),
            '>=': Number(actual) >= Number(desired), '<=': Number(actual) <= Number(desired) })[op];
      if (!cmp) return false;
    }
    if (statusRegexes && !statusRegexes.some(rx => rx.test(text))) return false;
    if (!term) return true;
    if (regex) return regex.test(text.length > MAX_REGEX_LINE_LEN ? text.slice(0, MAX_REGEX_LINE_LEN) : text);
    if (numericTermRegex) return numericTermRegex.test(text);
    return text.toLocaleLowerCase('pt-BR').includes(term);
  };
}

const metadataKey = key => /^(?:pagination|paging|page|pages|total.*|.*count|limit|offset|cursor|next.*|previous.*|hasMore|exitCode)$/i.test(key);
const criticalKey = key => /^(?:.*id|status.*|code|message|mensagem|timestamp|time|level)$/i.test(key) || metadataKey(key);

function selectJson(content, input, max, preParsedRoot) {
  const root = preParsedRoot !== undefined ? preParsedRoot : JSON.parse(content);
  const matches = matcher(input);
  const filtered = Boolean(input.query || input.predicate || input.statusCodes?.length);
  let total = 0, matched = 0;
  const arrays = [];
  const project = obj => !input.keepFields?.length || !obj || typeof obj !== 'object' || Array.isArray(obj) ? obj
    : Object.fromEntries(Object.entries(obj).filter(([key]) => criticalKey(key) || input.keepFields.includes(key)));
  function visit(value) {
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) {
        total++;
        if (!filtered || matches(item)) { result.push(project(item)); matched++; }
        else if (item && typeof item === 'object' && Object.values(item).some(Array.isArray)) {
          const nested = visit(item);
          if (Object.values(nested).some(v => Array.isArray(v) && v.length)) result.push(nested);
        }
      }
      arrays.push(result);
      return result;
    }
    if (value && typeof value === 'object') {
      if (!Object.values(value).some(v => Array.isArray(v) || (v && typeof v === 'object'))) {
        total++; if (!filtered || matches(value)) { matched++; return project(value); } return {};
      }
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (metadataKey(key)) Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
        else if (item && typeof item === 'object') Object.defineProperty(result, key, { value: visit(item), enumerable: true, writable: true, configurable: true });
        else if (!filtered || criticalKey(key) || input.keepFields?.includes(key)) Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    total++; if (!filtered || matches(value)) { matched++; return value; } return null;
  }
  const selected = visit(root);
  let excerpt = JSON.stringify(selected), removedForBudget = 0;
  // O(N log N) binary search trimming on dominant arrays instead of quadratic item-by-item pop.
  if (estimateTokens(excerpt) > max) {
    const nonEmpty = arrays.filter(a => a.length > 0).sort((a, b) => b.length - a.length);
    for (const arr of nonEmpty) {
      if (estimateTokens(excerpt) <= max) break;
      const original = arr.slice();
      const origLen = original.length;
      // Check if emptying this array completely still exceeds budget; if so, empty it in O(1) and move to next.
      arr.length = 0;
      const emptyExcerpt = JSON.stringify(selected);
      if (estimateTokens(emptyExcerpt) > max) {
        removedForBudget += origLen;
        excerpt = emptyExcerpt;
        continue;
      }
      // Binary search for largest prefix k in [0..origLen-1] that fits within max tokens.
      let lo = 0, hi = origLen - 1, bestExcerpt = emptyExcerpt;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        arr.length = 0;
        for (let i = 0; i < mid; i++) arr.push(original[i]);
        const candidate = JSON.stringify(selected);
        if (estimateTokens(candidate) <= max) {
          lo = mid;
          bestExcerpt = candidate;
        } else {
          hi = mid - 1;
        }
      }
      arr.length = 0;
      for (let i = 0; i < lo; i++) arr.push(original[i]);
      removedForBudget += origLen - lo;
      excerpt = bestExcerpt;
    }
  }
  if (estimateTokens(excerpt) > max) {
    // No partial JSON strings: preserve validity and disclose that full values require expansion.
    excerpt = max >= 1 ? '{}' : ''; removedForBudget++;
  }
  return { excerpt, preserved: { matchedCount: matched, omittedCount: Math.max(0, total - matched) + removedForBudget,
    ...(root && !Array.isArray(root) && typeof root === 'object' ? { pagination: Object.fromEntries(Object.entries(root).filter(([key]) => metadataKey(key))) } : {}) },
    partial: removedForBudget > 0 };
}

function selectLines(content, input, max, sourcePath, expanded = false) {
  const lines = content.split(/\r?\n/), matches = matcher(input);
  const range = input.query?.match(/^(?:lines?:)?(\d+)-(\d+)$/i);
  const start = input.startLine ?? (range ? Number(range[1]) : 1);
  const end = input.endLine ?? (range ? Number(range[2]) : lines.length);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new TypeError('Faixa de linhas inválida.');
  const context = input.contextLines ?? 3;
  if (!Number.isSafeInteger(context) || context < 0) throw new TypeError('contextLines inválido.');
  const explicit = Boolean(input.query && !range || input.predicate || input.statusCodes?.length);
  const hit = [];
  const sliceEnd = Math.min(end, lines.length);
  for (let i = start - 1; i < sliceEnd; i++) if (!explicit || matches(lines[i])) hit.push(i);
  const priority = new Map();
  for (const index of hit) {
    priority.set(index, 0);
    if (explicit) {
      const ctxStart = Math.max(0, index - context);
      const ctxEnd = Math.min(lines.length - 1, index + context);
      for (let i = ctxStart; i <= ctxEnd; i++) {
        if (!priority.has(i)) priority.set(i, 1);
      }
    }
  }
  const label = sourcePath || 'inline';
  const renderSet = (indicesSet) => {
    const sorted = [...indicesSet].sort((a, b) => a - b), out = [];
    for (let j = 0; j < sorted.length; j++) {
      const first = sorted[j]; let last = first;
      while (j + 1 < sorted.length && sorted[j + 1] === last + 1 && lines[sorted[j + 1]] === lines[first]) last = sorted[++j];
      out.push(first === last ? `L${first + 1}: ${lines[first]}` : `L${first + 1}-L${last + 1} (x${last - first + 1}): ${lines[first]}`);
    }
    return (sorted.length ? `${label}:${sorted[0] + 1}-${sorted.at(-1) + 1}\n` : '') + out.join('\n');
  };

  // Order candidates by priority (0=hits, 1=context) then line number.
  const ordered = [...priority.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const chosen = new Set();
  const headerOverhead = estimateTokens(`${label}:${sliceEnd}-${sliceEnd}\n`);
  let approxTokens = headerOverhead;
  let consecutiveRejects = 0;

  for (const [i] of ordered) {
    const lineText = lines[i];
    // Consecutive identical lines fold into a single range line, adding ~0 extra tokens.
    const foldsWithPrev = chosen.has(i - 1) && lines[i - 1] === lineText;
    const foldsWithNext = chosen.has(i + 1) && lines[i + 1] === lineText;
    if (foldsWithPrev || foldsWithNext) {
      chosen.add(i);
      continue;
    }
    const lineCost = estimateTokens(`L${i + 1}: ${lineText}\n`);
    if (approxTokens + lineCost <= max) {
      chosen.add(i);
      approxTokens += lineCost;
      consecutiveRejects = 0;
    } else {
      // Check exact rendered tokens once near the boundary in case grouping saved space.
      chosen.add(i);
      const exact = estimateTokens(renderSet(chosen));
      if (exact <= max) {
        approxTokens = exact;
        consecutiveRejects = 0;
      } else {
        chosen.delete(i);
        consecutiveRejects++;
        // Early stop once budget is saturated to keep selectLines O(budget) instead of O(N^2).
        if (consecutiveRejects >= 3 && approxTokens >= max * 0.85) break;
      }
    }
  }

  let excerpt = renderSet(chosen);
  // Final safety trim if heuristic sum slightly underestimated rendered token count.
  if (chosen.size > 0 && estimateTokens(excerpt) > max) {
    const reverseOrdered = [...chosen].sort((a, b) => (priority.get(b) - priority.get(a)) || (b - a));
    for (const idx of reverseOrdered) {
      if (estimateTokens(excerpt) <= max) break;
      chosen.delete(idx);
      excerpt = renderSet(chosen);
    }
  }
  // A single long line is explicitly partial, with recoverable original.
  if (!excerpt && hit.length) { chosen.add(hit[0]); excerpt = clipText(renderSet(chosen), max); }
  const sorted = [...chosen].sort((a, b) => a - b);
  return { excerpt, startLine: sorted.length ? sorted[0] + 1 : 0, endLine: sorted.length ? sorted.at(-1) + 1 : 0,
    totalLines: lines.length, preserved: { totalLines: lines.length, matchedCount: hit.length, omittedCount: lines.length - chosen.size },
    partial: chosen.size < priority.size || (hit.length > 0 && estimateTokens(renderSet(chosen)) > max), expanded };
}

export function createEvidence(db, config, metrics) {
  const { projectId, allowedRoots, defaultEvidenceTtlSeconds, maxEvidenceBytesPerProject, maxFileBytes } = config;
  // Pin canonical roots at construction. Replacing an authorized directory with
  // a junction must not silently authorize the junction's new destination.
  function safePath(filePath) {
    const stableRoots = allowedRoots.filter(root => { try { return fs.realpathSync(root) === root; } catch { return false; } });
    return resolveSafePath(filePath, stableRoots);
  }
  function tick() { return Math.max(Date.now(), (db.prepare('SELECT max(accessed_at) AS n FROM evidence_blobs WHERE project_id=?').get(projectId).n ?? 0) + 1); }
  function select(input = {}) {
    const started = performance.now(), max = budget(input.maxTokens, 600);
    let path, content = input.content ?? '', mtime = null;
    if (input.filePath) {
      const safe = safePath(input.filePath); if (!safe.ok) return safe;
      path = safe.path;
      const stat = fs.statSync(path);
      if (stat.size > maxFileBytes) {
        return failure('PAYLOAD_TOO_LARGE', `Arquivo excede o limite configurado de ${maxFileBytes} bytes.`);
      }
      content = fs.readFileSync(path, 'utf8'); mtime = stat.mtimeMs;
    }
    if (typeof content !== 'string') throw new TypeError('content deve ser texto.');
    if (Buffer.byteLength(content) > maxFileBytes) {
      return failure('PAYLOAD_TOO_LARGE', `Conteúdo excede o limite configurado de ${maxFileBytes} bytes.`);
    }
    const sourceHash = sha256(content), redacted = redactSecrets(content);
    content = redacted.text;
    let format = input.format ?? 'auto';
    let parsedJson;
    if (format === 'auto') {
      const trimmedStart = content.trimStart();
      if (trimmedStart.startsWith('{') || trimmedStart.startsWith('[')) {
        try { parsedJson = JSON.parse(content); format = 'json'; } catch { parsedJson = undefined; }
      }
      if (format === 'auto') {
        const sample = content.length > 4096 ? content.slice(0, 4096) : content;
        format = /\b(?:INFO|WARN|ERROR|DEBUG|HTTP)\b|^\d{4}-\d\d-/m.test(sample) ? 'log' : 'text';
      }
    }
    if (!['json', 'log', 'code', 'text'].includes(format)) throw new TypeError('Formato inválido.');
    if (format === 'json' && parsedJson === undefined) parsedJson = JSON.parse(content);
    let selection;
    const hasFilter = input.query || input.predicate || input.statusCodes?.length;
    const maybeFits = !hasFilter && content.length <= max * 12;
    let passthrough = false;
    if (maybeFits && estimateTokens(content) <= max) {
      const compact = format === 'json' ? JSON.stringify(parsedJson) : content;
      passthrough = Buffer.byteLength(compact) >= Buffer.byteLength(content) * 0.9;
    }
    if (passthrough) selection = { excerpt: content, preserved: { totalLines: content.split(/\r?\n/).length, omittedCount: 0 }, partial: false };
    else selection = format === 'json' ? selectJson(content, input, max, parsedJson) : selectLines(content, input, max, path);
    const omitted = selection.excerpt !== content;
    let ref = null, expiresAt = null;
    if (omitted && input.storeOriginal !== false) {
      const ttl = input.ttlSeconds ?? defaultEvidenceTtlSeconds;
      if (!Number.isFinite(ttl) || ttl < 0) throw new TypeError('ttlSeconds inválido.');
      const bytes = Buffer.byteLength(content);
      if (bytes <= maxEvidenceBytesPerProject) transaction(db, () => {
        ref = `ev_${randomBytes(16).toString('hex')}`;
        const expires = Math.floor(Date.now() + ttl * 1000); expiresAt = new Date(expires).toISOString();
        db.prepare('INSERT INTO evidence_blobs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(projectId, ref, content, format, path ?? null, sourceHash, mtime, expires, tick(), bytes, input.taskId ?? null);
        let size = db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM evidence_blobs WHERE project_id=?').get(projectId).n;
        while (size > maxEvidenceBytesPerProject) {
          const oldest = db.prepare('SELECT ref,bytes FROM evidence_blobs WHERE project_id=? ORDER BY accessed_at,ref LIMIT 1').get(projectId);
          db.prepare('DELETE FROM evidence_blobs WHERE project_id=? AND ref=?').run(projectId, oldest.ref); size -= oldest.bytes;
        }
      });
    }
    const result = { ok: true, dataClassification: 'untrusted_evidence', projectId,
      mode: passthrough ? 'passthrough' : selection.partial ? 'partial_sample' : 'selected', format,
      source: { kind: path ? 'file' : 'inline', ...(path ? { path } : {}), sha256: sourceHash },
      excerpt: selection.excerpt, preserved: selection.preserved,
      omissionsNotice: omitted ? `Seleção parcial/transformada; consulte ${ref ?? 'a fonte (original não armazenado ou acima da cota)'}.` : null,
      ref, expiresAt, redactedSecretsCount: redacted.count };
    result.metrics = metrics.record('select', content, result.excerpt, started, input.taskId);
    return result;
  }
  function expand(input = {}) {
    const started = performance.now(), max = budget(input.maxTokens, 1200);
    const blob = db.prepare('SELECT * FROM evidence_blobs WHERE project_id=? AND ref=?').get(projectId, input.ref ?? '');
    if (!blob) return failure('NOT_FOUND', 'Referência indisponível neste projeto.');
    if (blob.expires_at <= Date.now()) return failure('EXPIRED', 'A referência expirou.');
    let sourceModified = false;
    if (blob.source_path) {
      const safe = safePath(blob.source_path);
      try {
        if (!safe.ok) sourceModified = true;
        else {
          const stat = fs.statSync(safe.path);
          sourceModified = stat.mtimeMs !== blob.source_mtime_ms || stat.size > maxFileBytes || sha256(fs.readFileSync(safe.path, 'utf8')) !== blob.source_sha256;
        }
      } catch { sourceModified = true; }
    }
    const selected = blob.format === 'json' && input.query && input.startLine === undefined && input.endLine === undefined
      ? { ...selectJson(blob.content, input, max), startLine: 1, endLine: blob.content.split(/\r?\n/).length, totalLines: blob.content.split(/\r?\n/).length }
      : selectLines(blob.content, input, max, blob.source_path, true);
    db.prepare('UPDATE evidence_blobs SET accessed_at=? WHERE project_id=? AND ref=?').run(tick(), projectId, blob.ref);
    const result = { ok: true, projectId, ref: blob.ref, dataClassification: 'untrusted_evidence',
      excerpt: selected.excerpt, startLine: selected.startLine, endLine: selected.endLine, totalLines: selected.totalLines,
      sourceModified, warning: sourceModified ? 'A fonte mudou ou ficou indisponível; este trecho é o snapshot redatado original.' : null,
      omissionsNotice: selected.partial || selected.preserved.omittedCount ? 'Existem linhas omitidas; solicite outra faixa.' : null };
    result.metrics = metrics.record('expand', blob.content, result.excerpt, started, input.taskId ?? blob.task_id);
    return result;
  }
  return { select, expand };
}
