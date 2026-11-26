// Synthetic, deterministic, non-secret corpus. No network or random fixture data.
const contains = value => ({ type: 'contains', value, label: value });
const record = fields => ({ type: 'jsonRecord', fields, label: JSON.stringify(fields) });
const jsonValue = (key, value) => ({ type: 'jsonValue', key, value, label: `${key}=${value}` });
const log = (n, changes) => Array.from({ length: n }, (_, i) => changes[i] ?? `2026-11-26 INFO request seq=${i} status=200 serviço=catálogo`).join('\n');
const prose = (n, changes) => Array.from({ length: n }, (_, i) => changes[i] ?? `Parágrafo ${i}: descrição auxiliar de uma operação de rotina sem decisão relevante.`).join('\n');

export function buildCases() {
  const cases = [];
  const add = (id, category, raw, input, required, extra = {}) => cases.push({ id, category, raw, input: { maxTokens: 600, contextLines: 1, ...input }, required: required.map(x => typeof x === 'string' ? contains(x) : x), ...extra });
  for (const [i, pos] of [23, 7000, 13980].entries()) {
    const line = `2026-11-26 HTTP 503 serviço=pagamentos incidente=INC-${i} não repetir cobrança`;
    add(`log-rare-${i}`, 'log', log(14000, { [pos]: line }), { format: 'log', statusCodes: [503] }, [line], { description: `503 sem ERROR na linha ${pos + 1}` });
  }
  add('log-repeated', 'log', Array(1200).fill('WARN fila indisponível RETRY-42').join('\n'), { format: 'log', query: 'RETRY-42', maxTokens: 300 }, ['WARN fila indisponível RETRY-42'], { description: 'Agrupamento de repetições; contagem verificada separadamente', repeatCount: 1200 });
  add('log-multiple', 'log', log(4000, { 711: 'HTTP 500 ID-A não confirmar', 2111: 'HTTP 502 ID-B conexão recusada', 3501: 'HTTP 504 ID-C tempo esgotado' }), { format: 'log', statusCodes: [500, 502, 504] }, ['HTTP 500 ID-A não confirmar', 'HTTP 502 ID-B conexão recusada', 'HTTP 504 ID-C tempo esgotado']);
  add('log-neighbors', 'log', log(3000, { 1498: 'ID-ANT inicio de transação', 1499: 'HTTP 503 ID-FALHA indisponível', 1500: 'ID-DEPOIS rollback confirmado' }), { format: 'log', query: 'ID-FALHA', contextLines: 1 }, ['ID-ANT inicio de transação', 'HTTP 503 ID-FALHA indisponível', 'ID-DEPOIS rollback confirmado']);
  add('log-accent-path', 'log', log(2000, { 901: 'HTTP 503 AÇÃO-77 não apagar C:\\Projetos com espaços\\ação\\fila.log' }), { format: 'log', query: 'AÇÃO-77' }, ['AÇÃO-77', 'não apagar', 'C:\\Projetos com espaços\\ação\\fila.log']);
  add('log-numeric-boundary', 'log', log(2500, { 1200: 'HTTP 503 REAL-503', 1201: 'HTTP 200 OTHER-1503' }), { format: 'log', query: '503', contextLines: 0 }, ['HTTP 503 REAL-503'], { forbidden: ['OTHER-1503'] });

  for (let i = 0; i < 8; i++) {
    const rows = Array.from({ length: 1800 }, (_, j) => ({ id: `svc-${j}`, status: 200, message: 'operação concluída com sucesso', timestamp: '2026-11-26T12:00:00Z', amount: j + 0.25, enabled: true, note: 'descrição extensa para gerar um documento acima de quarenta mil tokens estimados' }));
    const index = [911, 1799, 500, 1200, 701, 1555, 888, 1000][i];
    rows[index] = { ...rows[index], status: i === 1 ? 502 : 503, id: `CRIT-${i}`, message: 'não autorizar operação duplicada', amount: -19.75, enabled: false, windowsPath: 'C:\\Projetos com espaços\\ação.json' };
    if (i === 6) rows[1400] = { ...rows[1400], id: 'SECOND-504', status: 504 };
    const data = { totalCount: 1800, pagination: { page: 3, nextCursor: 'página-4', hasMore: true }, results: rows };
    const required = [record({ id: `CRIT-${i}`, status: rows[index].status, message: 'não autorizar operação duplicada', amount: -19.75, enabled: false }), jsonValue('totalCount', 1800), jsonValue('nextCursor', 'página-4')];
    if (i === 6) required.push(record({ id: 'SECOND-504', status: 504 }));
    const input = { format: 'json', predicate: 'status>=500', keepFields: ['amount', 'enabled', 'windowsPath'], maxTokens: i === 7 ? 45 : 600 };
    if (i === 1) { delete input.predicate; input.statusCodes = [502]; }
    if (i === 2) { delete input.predicate; input.query = 'CRIT-2'; }
    add(`json-${i}`, 'json', JSON.stringify(i === 4 ? { ...data, results: undefined, data: { rows } } : data, null, 2), input, required, { description: i === 7 ? 'Orçamento deliberadamente insuficiente; expansão fixa recupera registro crítico' : 'JSON >40k tokens; valores críticos e paginação', expansions: i === 7 ? [{ query: `CRIT-${i}`, maxTokens: 800 }] : [] });
  }

  const bodies = [
    'if (!authorized) return "não autorizar pagamento";',
    'if (status === 503) return "não repetir cobrança";',
    'if (amount < 0) throw new RangeError("VALOR-NEGATIVO");',
    'if (attempts >= 3) return "RETRY-LIMIT-3";'
  ];
  for (let i = 0; i < 4; i++) {
    const source = Array.from({ length: 100 }, (_, j) => `export function handler${j}(authorized, status, amount, attempts) {\n  // implementação funcional ${j}\n  ${j === 73 ? bodies[i] : 'return "ok";'}\n}`).join('\n');
    add(`code-body-${i}`, 'code', source, { format: 'code', query: 'handler73', contextLines: 3 }, [bodies[i]]);
  }
  add('text-negation', 'text', prose(1500, { 733: 'DEC-77: não remover a validação; a aprovação não foi concedida.' }), { format: 'text', query: 'DEC-77' }, ['não remover a validação', 'a aprovação não foi concedida']);
  add('text-windows', 'text', prose(1200, { 611: 'ARQ-82: ler C:\\Área de Trabalho\\Projeto A\\decisão.txt sem renomear.' }), { format: 'text', query: 'ARQ-82' }, ['C:\\Área de Trabalho\\Projeto A\\decisão.txt', 'sem renomear']);
  add('text-range', 'text', prose(1000, { 830: 'RANGE-831: restrição vigente, ação não autorizada.' }), { format: 'text', query: '830-833' }, ['RANGE-831: restrição vigente, ação não autorizada.']);
  add('text-expand', 'text', prose(1800, { 210: 'ENTRY-211: detalhe foi movido para a seção final.', 1590: 'DETAIL-1591: motivo rejeitado = perda de idempotência.' }), { format: 'text', query: 'ENTRY-211', maxTokens: 200 }, ['ENTRY-211', 'DETAIL-1591', 'perda de idempotência'], { expansions: [{ query: 'DETAIL-1591', maxTokens: 300 }] });
  for (const [i, raw] of ['Olá, ação concluída.\n', '{"id":"CURTO-2","enabled":false}', 'const total = 42;\n', 'Não apagar C:\\Projeto A\\ação.txt.'].entries()) {
    add(`short-${i}`, 'short', raw, { format: ['text', 'json', 'code', 'text'][i] }, [raw.trim()], { passthrough: true });
  }

  const memorySpecs = [
    ['resume', ['Retomar cobrança', 'não duplicar', 'validar 503']],
    ['stale-branch', ['Retomar cobrança', 'não duplicar', 'validar 503']],
    ['stale-head', ['Retomar cobrança', 'não duplicar', 'validar 503']],
    ['superseded', ['SQLite vigente', 'concorrência transacional']],
    ['history', ['JSON antigo', 'SQLite vigente', 'concorrência transacional']],
    ['rejected', ['Retomar cobrança', 'perda de idempotência']],
    ['accent', ['Ação não autorizada', 'DEC-Á77', 'C:\\Projeto A\\ação.txt']],
    ['absent', []],
    ['isolation', ['APP-V1-ONLY']],
    ['forget-project', []],
    ['forget-task', []],
    ['candidate', []]
  ];
  for (const [scenario, mandatory] of memorySpecs) {
    const facts = {
      resume: 'Retomar cobrança; não duplicar; validar 503',
      'stale-branch': 'Retomar cobrança; não duplicar; validar 503; branch atual=feature; branch salva=main',
      'stale-head': 'Retomar cobrança; não duplicar; validar 503; head atual=bbbb; head salvo=aaaa',
      superseded: 'revisão 1: JSON antigo; revisão 2: SQLite vigente; motivo: concorrência transacional; revisão 1 substituída',
      history: 'revisão 1: JSON antigo; revisão 2: SQLite vigente; motivo: concorrência transacional; consulta histórica explícita',
      rejected: 'Retomar cobrança; rejeitado: repetir pagamento; motivo: perda de idempotência',
      accent: 'Ação não autorizada; DEC-Á77; C:\\Projeto A\\ação.txt',
      absent: 'Pergunta sem evidência: licença de componente desconhecido. Não inferir resposta.',
      isolation: 'escopo autenticado app-v1: APP-V1-ONLY',
      'forget-project': 'Pedido: esquecer completamente projeto app-v1; evidência e índices devem sumir.',
      'forget-task': 'Pedido: esquecer tarefa task-77, com checkpoint, decisão vinculada e blob.',
      candidate: 'Proposta não aprovada: candidata deve ficar fora da busca vigente.'
    };
    add(`memory-${scenario}`, 'memory', prose(500, { 277: facts[scenario] }), { format: 'text', query: 'consulta', maxTokens: 500 }, mandatory, { scenario, description: 'Baseline mantém histórico bruto; B comprime texto sem implementar estado; invariantes de estado avaliados separadamente apenas em C' });
  }
  return cases;
}
