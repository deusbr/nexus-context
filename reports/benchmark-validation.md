# Validação da entrega de benchmark

- Branch: `feat/benchmark-suite`; base integrada: `682d8e0`.
- Execução real: Node `v24.22.1`, via `nexus-node.cmd`.
- `benchmarks/run-benchmark.js`: 40 casos, 3 variantes, 7 repetições medidas (840 amostras), mais aquecimento descartado; término com código 0.
- `benchmarks/validate-report.js`: contabilidade, pareamento, fontes SHA-256, catálogo e sondas conferidos com código 0.
- Regressão do produto: `nexus-node.cmd --test tests/*.test.js`, **53/53 testes aprovados**, 0 falhas/ignorados. Saída real em [benchmark-regression.txt](benchmark-regression.txt).
- `--check benchmarks/run-benchmark.js`: aprovado. `git diff --check`: sem erros.
- Nenhuma alteração em `src/core/*`, `src/mcp/*` ou `src/cli/*`; nenhum push externo.

Os limites e perdas estão no [relatório](benchmark-v1.md): p95 local acima da meta ADR, aumento do custo de trechos curtos e simulação sem telemetria do provedor. As 525 verificações de evidência e 266 de invariantes passaram em C; isso não comprova qualidade de respostas de um modelo. Revisão independente pendente no momento deste registro.

Reexecução da conferência, sem repetir tempos:

```powershell
node benchmarks/validate-report.js
```
