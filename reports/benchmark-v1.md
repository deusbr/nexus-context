# Benchmark pareado v1 — NEXUS Contexto

Executado em 2026-11-26T13:19:27.509Z, Node v24.22.1, win32/x64. 40 casos × 3 variantes × 7 repetições medidas; uma rodada de aquecimento descartada.

**Estágio: benchmark executado, aguardando revisão independente.** Sem chamada de modelo/provedor; tokens são estimativas locais e providerCostUsd=null. Preservação é disponibilidade objetiva de evidência, não taxa de resolução por LLM.

## Método e reexecução

```powershell
node benchmarks/run-benchmark.js
```

- A: leitura bruta UTF-8. B: Context Slim local standalone/balanced com orçamento do caso, se disponível; fallback explícito cabeça/cauda. C: núcleo real via handlers MCP e ida/volta JSON; inclui respostas completas, envelopes e argumentos de controle. Todas as variantes recebem os mesmos arquivos sintéticos, com SHA-256 no JSON.
- Sem instalação: reaproveitados node:perf_hooks/global performance, process.resourceUsage, node:sqlite e Context Slim. Pesquisa limitada às interfaces locais e documentação oficial Node/Context7; nenhum pacote novo ou pesquisa de registro npm necessária (restrição zero dependências).
- Latência local inclui leitura/seleção, SQLite, JSON e todas as expansões. Retomada inclui fechar/reabrir sessão no SQLite persistente; preparação é cronometrada separadamente. Exclui geração de fixtures, avaliação do oráculo e estimação pós-resposta. Transporte por pipe/process startup é uma sonda separada, sem misturar com handlers.
- Subprocessos isolados por variante/rodada; ordem das variantes gira a cada rodada e ordem dos casos gira com índice determinístico. Aquecimento sem amostras publicadas. Sem GC forçado, controle de frequência/temperatura ou limpeza do cache de disco; cache de provedor frio/quente é simulado, não confundir com cache do SO.
- RSS em MiB (1024² bytes): pico real do worker inteiro via maxRSS do SO, incluindo runtime, fixtures e estimação. Por caso há apenas RSS amostrado após operação, não um pico isolado. Ambiente compartilhado pode interferir em latência.
- Um catálogo C das 3 ferramentas por sessão fria; nas colunas tarefa ele está separado para amortização. Cenário conservador frio soma o catálogo inteiro a cada tarefa. Baselines não carregam catálogo, favorecendo A/B. C lê arquivo por filePath; se o modelo reenviar conteúdo inline, esse custo adicional não está incluído.
- Escritas iniciais de memória e respostas de registro têm estimativa e latência separadas, mais total de ciclo de vida no JSON. Perguntas de retomada usam registros sintéticos aprovados pelo host (allowDirectActive=true); isto não altera o padrão seguro do produto. Forget é operação administrativa direta, ausente das ferramentas do modelo.
- Memória: os fatos são pré-estruturados manualmente no seed C; A/B recebem os mesmos fatos relevantes inseridos em 500 linhas de narrativa sintética. Nenhum extrator automático transforma narrativa em decisões. Economia de retomada não comprova economia ou precisão dessa extração; o volume de narrativa é uma premissa artificial explícita.
- Oráculos fixos verificam strings/negações e associação exata de campos JSON no mesmo objeto; falhas não são escondidas. Invariantes de estado são verificadas em C; A/B são históricos textuais sem CRUD de memória, portanto não são equivalentes nesse aspecto. Corpus sintético não estima precisão em tarefas humanas.

## Resultados agregados

| Variante | Economia mediana tarefa | Grandes: mediana | Grandes + catálogo frio | Evidência obrigatória | Latência p50/p95/max ms | Pico RSS MiB |
|---|---:|---:|---:|---:|---:|---:|
| A | 0% | 0% | 0% | 100% | 0.693 / 15.023 / 19.936 | 107.797 |
| B | 96.304% | 99.59% | 99.59% | 26.667% | 2.6 / 24.186 / 37.089 | 135.023 |
| C | 98.345% | 98.923% | 97.46% | 100% | 28.814 / 112.588 / 812.801 | 115.648 |

Grandes = casos de evidência com >1000 tokens brutos estimados; memórias não entram nessa mediana. Percentis nearest-rank sobre todas as repetições. Economia mantém valores negativos; não há corte em zero. Casos sem itens obrigatórios não aumentam a taxa de preservação.

| Variante | Bytes originais / retornados (todas repetições) | Tokens brutos / tarefa estimados | Tokens de preparação memória | Reconsultas |
|---|---:|---:|---:|---:|
| A | 61943371 / 61943371 | 20286469 / 20286469 | 0 | 0 |
| B | 61943371 / 374493 | 20286469 / 126938 | 0 | 0 |
| C | 61943371 / 374128 | 20286469 / 171204 | 202405 | 14 |

Catálogo real: **2534 bytes / 973 tokens estimados / 3 ferramentas**. Esse custo existe mesmo quando um trecho curto passa sem alteração.

## Casos pareados

| Caso | Tokens brutos | B: tokens tarefa / itens | C: tokens tarefa / itens | C p50/p95 ms | Expansões C |
|---|---:|---:|---:|---:|---:|
| log-rare-0 | 299650 | 639 / 0:1 | 729 / 1:1 | 45.52 / 102.4 | 0 |
| log-rare-1 | 299649 | 639 / 0:1 | 732 / 1:1 | 47.647 / 120.063 | 0 |
| log-rare-2 | 299648 | 636 / 1:1 | 733 / 1:1 | 82.208 / 115.359 | 0 |
| log-repeated | 11040 | 15 / 1:1 | 615 / 1:1 | 18.701 / 21.662 | 0 |
| log-multiple | 84608 | 639 / 0:3 | 911 / 3:3 | 25.742 / 32.377 | 0 |
| log-neighbors | 63306 | 639 / 0:3 | 635 / 3:3 | 26.805 / 30.595 | 0 |
| log-accent-path | 42046 | 639 / 0:3 | 676 / 3:3 | 19.166 / 25.495 | 0 |
| log-numeric-boundary | 52666 | 639 / 0:1 | 634 / 1:1 | 14.819 / 19.469 | 0 |
| json-0 | 168443 | 280 / 2:3 | 769 / 3:3 | 52.945 / 66.336 | 0 |
| json-1 | 168442 | 280 / 2:3 | 854 / 3:3 | 51.889 / 630.538 | 0 |
| json-2 | 168443 | 280 / 2:3 | 765 / 3:3 | 57.026 / 791.539 | 0 |
| json-3 | 168442 | 280 / 2:3 | 770 / 3:3 | 64.377 / 343.588 | 0 |
| json-4 | 176549 | 283 / 2:3 | 777 / 3:3 | 56.113 / 166.149 | 0 |
| json-5 | 168442 | 280 / 2:3 | 770 / 3:3 | 93.938 / 812.801 | 0 |
| json-6 | 168443 | 280 / 2:4 | 857 / 4:4 | 85.243 / 415.643 | 0 |
| json-7 | 168442 | 44 / 0:3 | 1181 / 3:3 | 78.619 / 140.042 | 1 |
| code-body-0 | 2755 | 467 / 0:1 | 690 / 1:1 | 12.825 / 32.578 | 0 |
| code-body-1 | 2756 | 467 / 0:1 | 691 / 1:1 | 11.967 / 37.951 | 0 |
| code-body-2 | 2757 | 467 / 0:1 | 693 / 1:1 | 13.084 / 39.794 | 0 |
| code-body-3 | 2754 | 467 / 0:1 | 689 / 1:1 | 17.596 / 33.791 | 0 |
| text-negation | 49556 | 731 / 0:2 | 678 / 2:2 | 26.487 / 55.294 | 0 |
| text-windows | 39566 | 731 / 0:2 | 684 / 2:2 | 20.731 / 44.214 | 0 |
| text-range | 32900 | 730 / 0:1 | 699 / 1:1 | 16.479 / 38.273 | 0 |
| text-expand | 59526 | 244 / 0:3 | 1214 / 3:3 | 39.37 / 250.592 | 1 |
| short-0 | 11 | 10 / 1:1 | 475 / 1:1 | 4.128 / 10.063 | 0 |
| short-1 | 13 | 13 / 1:1 | 491 / 1:1 | 3.692 / 11.027 | 0 |
| short-2 | 5 | 4 / 1:1 | 472 / 1:1 | 3.335 / 11.587 | 0 |
| short-3 | 15 | 15 / 1:1 | 482 / 1:1 | 3.417 / 18.121 | 0 |
| memory-resume | 16421 | 608 / 0:3 | 266 / 3:3 | 14.961 / 110.962 | 0 |
| memory-stale-branch | 16436 | 608 / 0:3 | 266 / 3:3 | 15.332 / 141.67 | 0 |
| memory-stale-head | 16434 | 608 / 0:3 | 265 / 3:3 | 14.859 / 106.604 | 0 |
| memory-superseded | 16446 | 608 / 0:2 | 396 / 2:2 | 19.53 / 68.167 | 0 |
| memory-history | 16449 | 608 / 0:3 | 544 / 3:3 | 21.431 / 66.089 | 0 |
| memory-rejected | 16433 | 608 / 0:2 | 311 / 2:2 | 15.716 / 64.817 | 0 |
| memory-accent | 16427 | 608 / 0:3 | 390 / 3:3 | 18.33 / 51.528 | 0 |
| memory-absent | 16435 | 608 / 0:0 | 272 / 0:0 | 17.478 / 74.817 | 0 |
| memory-isolation | 16419 | 608 / 0:1 | 376 / 1:1 | 40.794 / 104.419 | 0 |
| memory-forget-project | 16434 | 608 / 0:0 | 371 / 0:0 | 43.183 / 48.003 | 0 |
| memory-forget-task | 16432 | 608 / 0:0 | 370 / 0:0 | 43.479 / 56.439 | 0 |
| memory-candidate | 16428 | 608 / 0:0 | 268 / 0:0 | 16.756 / 18.929 | 0 |

## Onde ganha, perde e limitações

- Logs raros e JSON: a seleção lexical/predicado procura a evidência especificada; corte/sumarização de B pode omitir ocorrências no meio ou no fim. Isto compara a política B configurada, não todas as configurações possíveis do Context Slim. A já fornece a evidência inteira.
- Código: assinatura isolada pode omitir condições e negações; os quatro casos exigem lógica do corpo. Faixas e expansões têm custo explícito por tarefa.
- Saídas curtas: excerpt de C deve ser idêntico; envelope, controle e catálogo aumentam tokens. Pass-through do conteúdo não significa economia de custo total.
- Orçamento JSON insuficiente: seleção pode omitir um registro crítico; o caso json-7 inclui uma expansão predefinida e cobra ambas as respostas. O oráculo não decide retroativamente quando expandir.
- Memória: estado vigente/histórico, motivo rejeitado, abstenção, projeto parecido e remoção lógica de FTS5/blobs são verificados. Remoção lógica não prova sanitização forense de páginas, WAL, backups ou exportações externas.
- Latência do bruto é quase só leitura; não há inferência para converter tokens poupados em tempo. Critério de triagem ADR p95 local <=10% acima do baseline: **não atingido** (7.494×). Nenhuma afirmação de ganho de latência ponta a ponta do modelo.

Itens obrigatórios C: **525/525** nas repetições. Invariantes C aprovadas: **266**; com falha: **0**. Falhas de evidência C: **nenhuma**. Falhas B: **log-rare-0, log-rare-1, log-multiple, log-neighbors, log-accent-path, log-numeric-boundary, json-0, json-1, json-2, json-3, json-4, json-5, json-6, json-7, code-body-0, code-body-1, code-body-2, code-body-3, text-negation, text-windows, text-range, text-expand, memory-resume, memory-stale-branch, memory-stale-head, memory-superseded, memory-history, memory-rejected, memory-accent, memory-isolation**.

Economia mediana C no conjunto inteiro: tarefa=98.345%; incluindo catálogo frio=92.462%; incluindo preparação de memória + catálogo=91.384%. Dados pareados do corpus, sem intervalo de confiança populacional: sete repetições do mesmo caso não são sete tarefas independentes.

Retomada entre dois processos reais: passou; aviso de branch divergente=true; 127 tokens estimados. Stdio real: 3 respostas JSON válidas em 174.723 ms (amostra única de startup+3 operações, não p95).

## Cache frio/quente — modelo transparente

Simulação aritmética em unidades hipotéticas, não custo medido nem tabela comercial. Cache não reduz o espaço de contexto. Assume prefixo idêntico e elegível, 100% de hits após a primeira chamada, entradas variáveis não cacheadas; sensibilidade abaixo.

Premissas: prefixo estável=12000, multiplicador cache quente=0.1, 10 turnos, resposta suposta=200 tokens/chamada, entrada/saída não cacheada=1 unidade/token. Catálogo entra no prefixo C. Reconsultas repetem prefixo e resposta; não há garantia de hit, elegibilidade, preço ou latência real.

| Cenário | A frio / quente | C frio / quente | Economia frio / quente |
|---|---:|---:|---:|
| large-stable-prefix | 648660 / 551460 | 138660 / 33578.7 | 78.624% / 93.911% |
| short-stable-prefix | 122110 / 24910 | 136480 / 31398.7 | -11.768% / -26.049% |
| naive-rewrite-breaks-prefix | 182000 / 84800 | 137730 / 137730 | 24.324% / -62.417% |
| excessive-reconsultation | 182000 / 84800 | 1239570 / 200432.7 | -581.082% / -136.359% |

Prefixos preservados amortizam o catálogo. Reescrever o prefixo a cada redução pode destruir a vantagem do cache; reconsultas excessivas repetem entrada e saída, podendo custar mais que o bruto. Os cenários negativos usam entradas assumidas declaradas no JSON; grandes/curtos usam medianas e um caso reais da suíte. Sensibilidade ao desconto de cache 0/0,1/0,25/0,5/1 consta no JSON.

## Proveniência e arquivos

Fixtures geradas determinísticamente por benchmarks/fixtures/cases.js; arquivos temporários SQLite/texto ficam em tmp/nexus-bench-* e são removidos ao final, inclusive em falha. O único repo comparador é lido por import CJS em modo standalone; hashes antes/depois são iguais. Relatórios JSON/Markdown são as únicas escritas duráveis do runner. Hashes dos fontes, corpus e respostas estão no JSON; respostas contêm IDs/tempos variáveis, portanto não são bit a bit determinísticas.

Documentação primária consultada: [process.resourceUsage e RSS](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage) e [performance.now](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#performancenow). Não medidos: tokenizador oficial/provedor, cache real, custo monetário, qualidade de resposta de modelo, outros hosts/sistemas/clientes finais. Nenhum push externo.
