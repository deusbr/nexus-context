# NEXUS Contexto (`nexus-context`)

Zero-dependency local context & evidence layer in **Node.js 24+ (`node:sqlite` + native FTS5)** for verifiable token reduction, deterministic evidence selection with expandable originals, and project-scoped versioned agent memory via MCP (`stdio`) and CLI.

Camada local zero-dependência em **Node.js 24+ (`node:sqlite` + FTS5 nativo)** para economia verificável de tokens, seleção determinística de evidências com originais recuperáveis e memória versionada por projeto para agentes de IA.

## O que resolve

1. **Redução determinística com proveniência (`select` / `expand`)**: filtra logs volumosos (incluindo códigos numéricos como `503` sem depender da palavra `ERROR`), compacta e projeta JSON preservando valores críticos, contagens e paginação, recorta código por faixa de linhas e guarda o original recuperável (`ev_...`) com TTL, cota LRU por projeto, detecção de alteração de fonte (`sourceModified`) e redação prévia de segredos.
2. **Memória versionada e retomada compacta (`memory` / `checkpoint`)**: isola dados estritamente por `projectId`, mantém decisões vigentes, abordagens rejeitadas com justificativa, controle de concorrência otimista (`expectedRevision`), idempotência (`eventId`), consultas históricas explícitas, esquecimento transacional completo (tabelas + FTS5 + blobs) e cartão de retomada limitado a ~500 tokens com aviso de mudança de branch/head.
3. **Servidor MCP ultra-enxuto (`stdio` JSON-RPC 2.0)**: expõe exatamente **3 ferramentas** (`nexus_evidence`, `nexus_memory`, `nexus_record`) para minimizar overhead de catálogo, protege o cache de prompt com recuperação sob demanda e exige aprovação humana (`candidate` -> `active`) por padrão.
4. **Métricas honestas**: separa bytes filtrados, estimativa local de tokens, reconsultas e latência `p50/p95`, sinalizando explicitamente que custo financeiro real depende da telemetria oficial do provedor.

## Pré-requisitos e uso rápido

Requer **Node.js >= 24.0.0** (para `node:sqlite` e FTS5 nativo).

```powershell
# Filtrar log procurando HTTP 503 com 3 linhas de contexto
node bin/nexus-context.js select --project meu-app --file .\app.log --status 503 --context-lines 3 --max-tokens 300

# Expandir o original de uma evidência retornada
node bin/nexus-context.js expand ev_<id> --project meu-app --start-line 120 --end-line 150

# Registrar decisão e consultar memória vigente
node bin/nexus-context.js memory record --project meu-app --kind decision --title "Usar SQLite FTS5" --content "Busca lexical local sem serviço externo" --source "ADR-004"
node bin/nexus-context.js memory query --project meu-app --query "FTS5"

# Salvar e retomar checkpoint de tarefa (<= 500 tokens estimados)
node bin/nexus-context.js checkpoint save --project meu-app --task t-1 --objective "Corrigir 503" --pending "Validar retry"
node bin/nexus-context.js checkpoint resume --project meu-app --task t-1

# Gerar configuração MCP pronta para o cliente (usa node direto + bin/nexus-context-mcp.js, sem cmd.exe)
node bin/nexus-context.js install-config openbot --project meu-app
node bin/nexus-context.js install-config codex --project meu-app
node bin/nexus-context.js install-config claude-code --project meu-app
node bin/nexus-context.js install-config gemini-cli --project meu-app
```

> **Segurança no Windows:** Os arquivos gerados por `install-config` invocam `node.exe` diretamente com `bin/nexus-context-mcp.js` (sem `cmd.exe` ou `.cmd`), mitigando CVE-2024-24576, injeção de `&` e expansão de `%VAR%`. No CLI, ao passar conteúdo arbitrário/não confiável, prefira `stdin` ou invocação direta via `node bin/nexus-context.js`.

## Documentação e contrato

- Contrato técnico: [CONTRACT.md](./CONTRACT.md)
- Guia de integração (OpenBot, Codex CLI, Claude Code, Gemini CLI): [docs/INTEGRATION.md](./docs/INTEGRATION.md)
- Relatórios verificados: [Benchmark v1](reports/benchmark-v1.md) · [Validação de Núcleo](reports/core-engine-validation.md)

## Testes e Benchmark

```powershell
npm run check
npm test
node benchmarks/validate-report.js
node benchmarks/run-benchmark.js
```

## Licença

[MIT](./LICENSE) — Emerson Almeida (`@deusbr`).
