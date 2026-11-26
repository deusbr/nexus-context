# NEXUS Contexto — Contrato Técnico v1.0

Este documento define as interfaces exatas entre os módulos de `nexus-context` para permitir desenvolvimento paralelo em branches/worktrees sem conflito.

## 1. Requisitos de Runtime e Segurança
- **Runtime:** Node.js `>=24.0.0` (ESM `"type": "module"`), usando `node:sqlite` (com FTS5 nativo), zero dependências externas em produção.
- **Compatibilidade Windows:** Suporte completo a caminhos com espaços, caracteres Unicode/PT-BR, `\` e `/`, e verificação de symlinks/junctions via `fs.realpathSync`.
- **Stdout limpo:** Nenhum módulo em `src/core/*` ou `src/mcp/*` pode usar `console.log` ou escrever em `process.stdout` fora do protocolo JSON-RPC do servidor MCP. Logs de diagnóstico devem ir apenas para `process.stderr` quando explicitamente habilitados (`NEXUS_CONTEXT_DEBUG=1`).
- **Isolamento de banco:** Sempre usar arquivo SQLite próprio (`dbPath` passado na inicialização ou `NEXUS_CONTEXT_DB`), nunca o banco interno do OpenBot.
- **Autorização e dados não confiáveis:** `projectId` e `allowedRoots` são definidos exclusivamente pelo host/configuração na criação da instância (`createNexusContext`), jamais sobrescritos por texto recuperado ou entrada do modelo.

## 2. Exportação Principal (`src/core/index.js`)

```js
export function createNexusContext(options)
// options: {
//   dbPath: string,                // obrigatório (ou ':memory:' em testes)
//   projectId: string,             // escopo autenticado pelo host (ex: 'meu-projeto')
//   allowedRoots?: string[],       // raízes de diretório autorizadas para leitura de arquivos
//   defaultEvidenceTtlSeconds?: number, // padrão 86400 (24h)
//   maxEvidenceBytesPerProject?: number // padrão 20 * 1024 * 1024 (20 MB)
// }
```

Retorna um objeto `ctx` com os métodos abaixo (todos síncronos ou retornando objetos planos serializáveis em JSON; `close()` fecha o `DatabaseSync`):

### 2.1. Evidência (`ctx.evidence`)
- `ctx.evidence.select(input)`:
  - `input`: `{ content?: string, filePath?: string, format?: 'auto'|'json'|'log'|'code'|'text', query?: string, predicate?: string, statusCodes?: number[], contextLines?: number, maxTokens?: number, keepFields?: string[], storeOriginal?: boolean, ttlSeconds?: number, taskId?: string }`
  - Regras obrigatórias:
    1. Se `filePath` for informado, validar que o caminho real (`realpathSync`) está dentro de `allowedRoots` (rejeitar path traversal, `..`, junctions fora da raiz, retornando `{ ok: false, errorCode: 'SCOPE_DENIED', message }`).
    2. Detectar e redatar segredos (chaves API, tokens Bearer/JWT, AWS keys, senhas em URLs/env, blocos PRIVATE KEY) **antes** de persistir o original ou gerar métricas; reportar `redactedSecretsCount`.
    3. Se a saída bruta já couber em `maxTokens` (padrão `600`) e a redução for `< 10%` (e não houver `query`/`predicate`/`statusCodes`), retornar `mode: 'passthrough'` com o conteúdo original (redatado se necessário).
    4. **JSON:** compactar sem perder valores críticos; se houver `query`/`predicate`/`statusCodes` (ex: `status>=500`, `503`, `level=error`), filtrar ocorrências mantendo campos obrigatórios (`keepFields`, IDs, status, mensagem, timestamp, paginação e contagens totais). Nunca devolver só chaves sem valores quando a busca pede valores/falhas.
    5. **Log:** suportar busca por código numérico (ex: `503` sem depender da palavra `ERROR`), regex/termo, janela de linhas vizinhas (`contextLines`, padrão `3`), agrupamento de linhas repetidas com contagem, e preservação de números de linha exatos (`L123`).
    6. **Código/Texto:** recorte por linhas ou busca lexical com indicação `path:start-end`.
    7. Se `storeOriginal !== false` e houve redução/omissão, salvar original na tabela `evidence_blobs` vinculada a `projectId`, com `ref` opaca (`ev_<hex>`), `source_sha256`, `source_mtime_ms`, `expires_at`, respeitando cota por projeto (evicção LRU dos mais antigos do mesmo projeto se exceder cota).
  - Retorno:
    ```js
    {
      ok: true,
      dataClassification: 'untrusted_evidence',
      projectId,
      mode: 'passthrough' | 'selected' | 'partial_sample',
      format: 'json' | 'log' | 'code' | 'text',
      source: { kind: 'file' | 'inline', path?: string, sha256: string },
      excerpt: string,
      preserved: { totalLines?: number, matchedCount?: number, omittedCount: number, exitCode?: number, pagination?: object },
      omissionsNotice: string | null,
      ref: string | null,           // ex: 'ev_9f8a...'
      expiresAt: string | null,     // ISO-8601
      redactedSecretsCount: number,
      metrics: {
        rawBytes: number,
        returnedBytes: number,
        estimatedRawTokens: number,
        estimatedReturnedTokens: number,
        savedTokensEstimate: number,
        latencyMs: number,
        providerCostUsd: null,
        telemetryScope: 'local_estimate_only'
      }
    }
    ```

- `ctx.evidence.expand(input)`:
  - `input`: `{ ref: string, query?: string, startLine?: number, endLine?: number, contextLines?: number, maxTokens?: number, taskId?: string }`
  - Regras obrigatórias:
    1. Validar que `ref` pertence estritamente ao `projectId` autenticado; se pertencer a outro projeto, retornar `{ ok: false, errorCode: 'SCOPE_DENIED' }` (ou `NOT_FOUND` sem vazar metadados do outro projeto).
    2. Verificar expiração (`expires_at <= now`): se expirado, retornar `{ ok: false, errorCode: 'EXPIRED' }`.
    3. Se `source.kind === 'file'`, verificar se o arquivo ainda existe e se o hash/mtime mudou; se mudou, sinalizar `sourceModified: true` (e `warning`) no retorno.
    4. Incrementar contador de reconsultas nas métricas (`reconsult_count`).
    5. Retornar trecho solicitado dentro de `maxTokens` (padrão `1200`), com `startLine`, `endLine`, `totalLines`, `dataClassification: 'untrusted_evidence'`.

### 2.2. Memória Versionada e Retomada (`ctx.memory`)
- `ctx.memory.recordDecision(input)`:
  - `input`: `{ kind: 'decision'|'constraint'|'fact'|'rejected_approach'|'preference', title: string, content: string, rationale?: string, sourceRef: string, effectiveDate?: string, status?: 'active'|'candidate', supersedesId?: string, expectedRevision?: number, eventId?: string, tags?: string[] }`
  - Regras obrigatórias:
    1. Redatar segredos antes de gravar.
    2. Idempotência por `(project_id, event_id)`: se `eventId` já existir no projeto, retornar o registro existente com `idempotentReplay: true`.
    3. Se `supersedesId` for informado:
       - Verificar se existe no mesmo `projectId`.
       - Se `expectedRevision` for informado e divergir da `revision` atual, retornar `{ ok: false, errorCode: 'CONFLICT', currentRevision, message }`.
       - Na **mesma transação SQLite**, marcar registro antigo como `superseded` (e apontar `superseded_by`), inserir o novo com `revision = old.revision + 1` e atualizar o índice FTS5 (`memory_fts`).
    4. Sugestões automáticas ou originadas de conteúdo externo devem usar `status: 'candidate'` até aprovação humana (`approveDecision`).
  - Retorno: `{ ok: true, id, revision, status, idempotentReplay, redactedSecretsCount }`.

- `ctx.memory.approveDecision(input)`: `{ id: string }` → muda `candidate` para `active` transacionalmente e atualiza FTS5.
- `ctx.memory.revokeDecision(input)`: `{ id: string, reason: string }` → muda para `revoked` transacionalmente e atualiza FTS5 (deixa de aparecer em consultas vigentes).
- `ctx.memory.query(input)`:
  - `input`: `{ query: string, kind?: string, includeHistory?: boolean, includeCandidates?: boolean, limit?: number, maxTokens?: number }`
  - Regras obrigatórias:
    1. Filtrar estritamente por `project_id = ctx.projectId`.
    2. Por padrão (`includeHistory: false`, `includeCandidates: false`), retornar **apenas** `status = 'active'`.
    3. Busca lexical via SQLite FTS5 + fallback exato para IDs/códigos/termos com pontuação ou acentos PT-BR.
    4. Respeitar `maxTokens` (padrão `600`). Se nenhum registro casar, retornar `items: []`, `abstentionRecommended: true`, `notice: 'Nenhuma evidência ou decisão vigente encontrada para a consulta no escopo do projeto.'`.
    5. Retornar `dataClassification: 'untrusted_memory'` com `id`, `kind`, `title`, `content`, `rationale`, `sourceRef`, `effectiveDate`, `status`, `revision`, `supersedesId`.

- `ctx.memory.saveCheckpoint(input)`:
  - `input`: `{ taskId: string, objective: string, constraints?: string[], completed?: string[], pending?: string[], activeDecisions?: string[], affectedFiles?: string[], references?: string[], gitBranch?: string, gitHead?: string, expectedRevision?: number, eventId?: string }`
  - Controle de concorrência otimista (`expectedRevision`), idempotência (`eventId`), transacional em `task_checkpoints`.

- `ctx.memory.resume(input)`:
  - `input`: `{ taskId: string, maxTokens?: number, currentGitBranch?: string, currentGitHead?: string }`
  - Padrão `maxTokens = 500`.
  - Retorna cartão compacto com: `objective`, `constraints`, `completed`, `pending`, `activeDecisions` (puxadas da memória vigente + referências), `rejectedApproaches` (resumo curto de abordagens rejeitadas vigentes se couber no orçamento), `affectedFiles`, `references`, `revision`, `staleCodeWarning` (true se `currentGitBranch` ou `currentGitHead` divergir do salvo), `omissionsNotice`, `estimatedTokens`.
  - Se `taskId` não existir, retornar `{ ok: true, found: false, abstentionRecommended: true, notice }`.

- `ctx.memory.forget(input)`:
  - `input`: `{ scope: 'entry' | 'task' | 'evidence' | 'project', targetId?: string }`
  - Remove transacionalmente registros das tabelas principais, índice FTS5 (`memory_fts`), `evidence_blobs` e `task_checkpoints` afetados, estritamente dentro de `ctx.projectId`.
  - Retorna contagem exata removida por tabela e aviso explícito de que cópias exportadas externamente (ex.: Markdown/Obsidian) não são removidas automaticamente.

- `ctx.memory.list(input)`: `{ status?: string, kind?: string, limit?: number }` — listagem administrativa para CLI humano.
- `ctx.memory.exportMarkdown(input)`: `{ taskId?: string, includeHistory?: boolean }` — exportação limpa em Markdown compatível com Obsidian (frontmatter YAML, decisões vigentes, abordagens rejeitadas com motivo, checkpoint e fontes).

### 2.3. Métricas (`ctx.metrics`)
- `ctx.metrics.report(input)`: `{ taskId?: string }`
  - Retorna estatísticas agregadas do projeto (ou tarefa):
    - `operationsCount`, `selectCount`, `expandReconsultCount`, `memoryQueryCount`, `resumeCount`
    - `totalRawBytes`, `totalReturnedBytes`
    - `totalEstimatedRawTokens`, `totalEstimatedReturnedTokens`, `estimatedSavedTokens`, `estimatedReductionPct`
    - `latencyMs`: `{ p50, p95, max }`
    - `providerUsageAvailable: false`, `providerCostUsd: null`, `disclaimer: 'Estimativa local baseada em tokenização heurística calibrada; consumo real do provedor requer telemetria oficial do cliente.'`

### 2.4. Utilitários Exportados (`src/core/tokenizer.js` e `src/core/security.js`)
- `estimateTokens(text)` — estimador determinístico UTF-8 calibrado (retorna inteiro `>= 0`).
- `redactSecrets(text)` — retorna `{ text, count, types }`.
- `resolveSafePath(filePath, allowedRoots)` — valida caminho real contra traversal e junctions Windows.

## 3. Servidor MCP Local (`src/mcp/server.js`)
- Transporte: `stdio` (newline-delimited JSON-RPC 2.0).
- Versões suportadas em `initialize`: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.
- **Exatamente 3 ferramentas no catálogo (`tools/list`)** para mínimo schema overhead:
  1. `nexus_evidence`: `{ action: 'select' | 'expand', ... }`
  2. `nexus_memory`: `{ action: 'query' | 'resume' | 'history', ... }`
  3. `nexus_record`: `{ action: 'checkpoint' | 'decision', ... }` (nota: via MCP, decisões sem `confirmedByUser: true` entram como `candidate` ou `active` conforme política da instância; padrão seguro `allowDirectActive: false` -> grava como `candidate` se originado de texto não confiável, ou permite `active` explícito quando configurado para agente autenticado no projeto).
- Exporta `createMcpServer({ ctx, allowDirectActive })` com método `handleMessage(jsonRpcMsg)` testável diretamente sem subprocesso, além de `startStdioServer(options)`.

## 4. CLI (`src/cli/index.js`)
Comandos:
- `nexus-context mcp --project <id> [--db <path>] [--allowed-root <dir>]...`
- `nexus-context select [--file <path> | stdin] [--format auto|json|log|code|text] [--query <q>] [--predicate <p>] [--status <codes>] [--context-lines <n>] [--max-tokens <n>] [--project <id>] [--db <path>]`
- `nexus-context expand <ref> [--query <q>] [--start-line <n>] [--end-line <n>] [--max-tokens <n>] [--project <id>] [--db <path>]`
- `nexus-context memory list|query|record|approve|revoke|forget|export ...`
- `nexus-context checkpoint save|resume ...`
- `nexus-context metrics report [--project <id>] [--task <id>] [--db <path>]`
- `nexus-context install-config <openbot|codex|claude-code|gemini-cli> [--project <id>] [--db <path>] [--allowed-root <dir>]`
