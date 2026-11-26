# NEXUS-CTX-01 — Fase 2: núcleo

Estado: implementação local validada pelo autor, **pendente de revisão independente** por SENTINEL/AEGIS. Nenhum push ou publicação externa.

## Escopo

- `src/core/tokenizer.js`, `security.js`, `db.js`, `evidence.js`, `memory.js`, `metrics.js`, `index.js`.
- `tests/core.test.js`: 40 testes com `node:test` e `node:assert/strict`, sem dependências externas.
- Node.js 24.22.1 via wrapper autorizado `NEXUS-Engineering/tools/bin/nexus-node.cmd`, Windows.
- Banco SQLite próprio identificado por application_id NCTX, WAL, tabelas STRICT e FTS5 nativo. Banco preexistente de outra aplicação é recusado antes de alterar schema/journal.
- Escopo autenticado fechado na instância; leituras e mutações usam igualdade de project_id, inclusive FTS, blobs, checkpoints e métricas.

## Evidências verificadas

Resultado bruto: [core-test-output.txt](core-test-output.txt). Sintaxe: [core-check-output.txt](core-check-output.txt). Integridade: [core-sha256.txt](core-sha256.txt).

1. Erro 503 raro sem ERROR em 14.000 linhas; números exatos e contexto preservados.
2. JSON sintético acima de 40.000 tokens heurísticos filtrado com valores, IDs, status, mensagem, timestamp, contagens e paginação.
3. Pass-through; JSON parcial válido; regex/termo e repetição de logs; faixa exata de código/texto.
4. Segredos redatados antes de persistir ou medir; expansão usa snapshot redatado. Contagens de tokens não são tratadas como credenciais.
5. Traversal, raízes com prefixos semelhantes, junction externa e substituição de raiz por junction negados no Windows real; caminho PT-BR aceito.
6. sourceModified por hash/mtime, inclusive arquivo excluído; TTL EXPIRED; quota e LRU com acesso; expansão JSON recupera valor no final de linha minificada.
7. app-v1 versus app-v10 em evidência, busca, mutação, eventos, checkpoint, limpeza e métricas.
8. Versionamento, supersedesId, CONFLICT, evento idempotente, rollback SQLite com falha injetada e FTS consistente.
9. Candidate → approve; revoke invisível na busca vigente e visível em histórico; busca FTS com acentos e fallback por ID/código/caminho.
10. Retomada com cartão serializado em até 500 tokens heurísticos; aviso de branch/head divergentes; resolução da versão vigente de decisão referenciada pelo checkpoint.
11. Abstenção explícita, forget transacional com contagens por tabela e aviso sobre exportações externas; Markdown Obsidian com frontmatter e fontes.
12. Métricas de select, expand/reconsulta, query e resume; bytes, estimativas, percentis de latência (fixture exata), custo null e disclaimer.
13. Nenhum console.log/process.stdout em src/core; subprocesso de importação e operações com stdout efetivamente vazio.

## Estimador e fontes

Comparação reproduzível: [tokenizer-calibration.md](tokenizer-calibration.md), gerada por [calibrate-tokenizer.mjs](calibrate-tokenizer.mjs) usando **somente para calibração** a instalação local existente de Python/tiktoken, sem instalar dependências no projeto. Os cinco corpora sintéticos ajustaram coeficientes separados para PT-BR, inglês, JSON, logs e código; o maior erro absoluto relativo observado nessa amostra foi aproximadamente 6%. Isso é calibração na amostra, não garantia em textos novos. Orçamentos usam estimateTokens e não representam limites de um tokenizador oficial específico.

Pesquisa prévia: repositório inspecionado com Repomix --compress (somente contrato/base presentes), catálogo local e Context7 consultados. Reutilizado node:sqlite/FTS5 nativo em vez de adicionar bibliotecas, conforme contrato zero-dependência.

- [Documentação Node 24 DatabaseSync](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), consultada via Context7.
- [Documentação oficial SQLite FTS5](https://www.sqlite.org/fts5.html), consultada diretamente.

## Limites e integração

- MCP, CLI, benchmark pareado e integração OpenBot são fases de outros responsáveis e não estão presentes neste worktree.
- Sem teste em Linux/macOS, sem carga concorrente multiprocesso ou fatura real de provedor.
- Redação de segredos é determinística por padrões conhecidos; o snapshot recuperável é redatado, não uma cópia secreta dos bytes originais. Hash/mtime correspondem à fonte original para detectar alterações.
- Campos obrigatórios de um cartão exigem orçamento mínimo: resume retorna INVALID_INPUT se nem os metadados cabem. Trechos grandes são sinalizados como parciais; refine/expanda a consulta.
- FTS inclui histórico para permitir includeHistory; consultas vigentes filtram status active por igualdade no registro principal.
- Checkpoints preservam revisões anteriores para idempotência de eventos antigos. Forget remove todas as revisões e referências afetadas no mesmo projeto; não remove arquivos Markdown já exportados nem backups externos.
- Nenhuma instalação, chamada a provedor de IA ou alteração em outro worktree. Testes criaram bancos/fixtures temporários em diretórios próprios e os removeram ao terminar.

## Reprodução

No wt-core, executar o wrapper `nexus-node.cmd --test tests/core.test.js` e `nexus-node.cmd --check` para cada arquivo em src/core e tests/core.test.js. Para calibração opcional: `nexus-node.cmd reports/calibrate-tokenizer.mjs <python-existente-com-tiktoken>`.
