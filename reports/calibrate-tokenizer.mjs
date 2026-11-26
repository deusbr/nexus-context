// Optional developer calibration only. Pass an existing Python with tiktoken;
// production src/core never imports it and nothing is installed by this script.
import { spawnSync } from 'node:child_process';
import { estimateTokens } from '../src/core/tokenizer.js';

if (!process.argv[2]) throw new Error('Pass an absolute existing Python executable with tiktoken.');
const corpus = {
  ptBR: 'A decisão vigente mantém a aplicação local. Não repetir abordagens rejeitadas; preservar evidências, restrições, valores e referências.\n'.repeat(30),
  english: 'Keep the original evidence available and preserve current decisions, rejected approaches, constraints and references.\n'.repeat(30),
  json: JSON.stringify({ total: 120, rows: Array.from({ length: 120 }, (_, id) => ({ id, status: id === 119 ? 503 : 200, message: 'operação local', timestamp: '2026-11-26T10:00:00Z' })) }),
  log: Array.from({ length: 120 }, (_, i) => `2026-11-26T10:00:00Z INFO request=id${i} HTTP status=${i === 119 ? 503 : 200} latencyMs=${i}`).join('\n'),
  code: 'export function findDecision(projectId, id) {\n  return db.prepare("SELECT * FROM memory_entries WHERE project_id=? AND id=?").get(projectId, id);\n}\n'.repeat(30)
};
const child = spawnSync(process.argv[2], ['-c', `import sys,json,tiktoken
data=json.load(sys.stdin)
enc=[tiktoken.get_encoding(n) for n in ['cl100k_base','o200k_base']]
print(json.dumps({k:[len(e.encode(v)) for e in enc] for k,v in data.items()}))`],
  { input: JSON.stringify(corpus), encoding: 'utf8' });
if (child.status !== 0) throw new Error(child.stderr);
const counts = JSON.parse(child.stdout);
process.stdout.write('# Calibração local do estimador\n\nCorpus sintético; comparação independente de uso/fatura do provedor.\n\n| Corpus | Heurística | cl100k_base | o200k_base |\n|---|---:|---:|---:|\n');
for (const [name, text] of Object.entries(corpus)) process.stdout.write(`| ${name} | ${estimateTokens(text)} | ${counts[name][0]} | ${counts[name][1]} |\n`);
