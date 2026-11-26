# Guia de Integração — NEXUS Contexto (Windows)

Este guia descreve como configurar e operar o **NEXUS Contexto** via servidor MCP local (`stdio`) e CLI em ambiente Windows com **OpenBot**, **Codex CLI**, **Claude Code** e **Gemini CLI**, além dos limites reais de cobertura, cache de prompt e proveniência.

---

## 1. Invocação segura no Windows (mitigação CVE-2024-24576)

Em clientes MCP no Windows, **invoque diretamente o executável `node.exe` assinado passando `bin\nexus-context-mcp.js` como primeiro argumento**, evitando `cmd.exe` e arquivos `.cmd` (que interpretam metacaracteres como `&`, `|` e expandem `%VAR%` em argumentos).

O comando `install-config` já gera automaticamente a configuração segura com `node.exe` direto:

```json
{
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": [
    "C:\\caminho\\para\\nexus-context\\bin\\nexus-context-mcp.js",
    "--project", "meu-projeto",
    "--db", "C:\\caminho\\meu-projeto\\.nexus-context\\context.sqlite",
    "--allowed-root", "C:\\caminho\\meu-projeto"
  ]
}
```

> **Uso de wrappers `.cmd`:** wrappers locais opcionais servem apenas para atalhos interativos. Ao passar conteúdo arbitrário ou potencialmente não confiável no CLI, envie via `stdin` ou execute diretamente `node bin\nexus-context.js`.
> **Importante (`stdio`):** o servidor MCP usa JSON-RPC 2.0 linha a linha em `stdout`. Nunca redirecione logs para `stdout`.

---

## 2. Geração automática de configuração (`install-config`)

Você pode gerar os trechos prontos para cada cliente usando o CLI:

```powershell
node bin/nexus-context.js install-config openbot --project meu-projeto --db "C:\caminho\meu-projeto\.nexus-context\context.sqlite" --allowed-root "C:\caminho\meu-projeto"
node bin/nexus-context.js install-config codex --project meu-projeto --db "C:\caminho\meu-projeto\.nexus-context\context.sqlite" --allowed-root "C:\caminho\meu-projeto"
node bin/nexus-context.js install-config claude-code --project meu-projeto --db "C:\caminho\meu-projeto\.nexus-context\context.sqlite" --allowed-root "C:\caminho\meu-projeto"
node bin/nexus-context.js install-config gemini-cli --project meu-projeto --db "C:\caminho\meu-projeto\.nexus-context\context.sqlite" --allowed-root "C:\caminho\meu-projeto"
```

---

## 3. Configuração por cliente

### 3.1. OpenBot

No OpenBot, servidores MCP `stdio` locais são registrados por nome, comando e argumentos (via `Marketplace -> Apps` ou ferramenta administrativa equivalente):

```json
{
  "name": "nexus-context",
  "transport": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": [
    "C:\\caminho\\para\\nexus-context\\bin\\nexus-context-mcp.js",
    "--project", "meu-projeto",
    "--db", "C:\\caminho\\meu-projeto\\.nexus-context\\context.sqlite",
    "--allowed-root", "C:\\caminho\\meu-projeto"
  ],
  "workingDirectory": "C:\\caminho\\meu-projeto",
  "enabled": true
}
```

**Limites reais no OpenBot:**
- O servidor MCP só reduz e indexa resultados das suas próprias 3 ferramentas (`nexus_evidence`, `nexus_memory`, `nexus_record`).
- Saídas de outras ferramentas nativas ou MCPs externos não são interceptadas automaticamente pelo servidor MCP; para reduzi-las antes da leitura do modelo, filtre via CLI (`node bin/nexus-context.js select`) ou passe o trecho/arquivo para `nexus_evidence(action="select")`.

### 3.2. Codex CLI

Adicione ao arquivo `%USERPROFILE%\.codex\config.toml` (ou `.codex\config.toml` do repositório):

```toml
[mcp_servers.nexus_context]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\caminho\\para\\nexus-context\\bin\\nexus-context-mcp.js", "--project", "meu-projeto", "--db", "C:\\caminho\\meu-projeto\\.nexus-context\\context.sqlite", "--allowed-root", "C:\\caminho\\meu-projeto"]
cwd = "C:\\caminho\\meu-projeto"
```

**Limites reais no Codex CLI:**
- O servidor MCP controla apenas chamadas direcionadas às ferramentas `nexus_*`.
- Caso utilize hooks do cliente (`PostToolUse` / início de sessão), verifique na versão instalada do Codex CLI quais eventos aceitam substituição de saída versus apenas feedback adicional.

### 3.3. Claude Code

Adicione em `.mcp.json` (escopo de projeto) ou `%USERPROFILE%\.claude.json`:

```json
{
  "mcpServers": {
    "nexus-context": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\caminho\\para\\nexus-context\\bin\\nexus-context-mcp.js",
        "--project", "meu-projeto",
        "--db", "C:\\caminho\\meu-projeto\\.nexus-context\\context.sqlite",
        "--allowed-root", "C:\\caminho\\meu-projeto"
      ]
    }
  }
}
```

**Limites reais no Claude Code:**
- Para reduzir saídas de ferramentas nativas (como leitura de logs extensos via shell), é necessário integrar explicitamente via hook oficial (`PostToolUse` / `PreCompact`) chamando `node bin/nexus-context.js select` / `checkpoint resume`, respeitando o formato suportado pela versão instalada.

### 3.4. Gemini CLI

Adicione em `%USERPROFILE%\.gemini\settings.json` (ou `.gemini\settings.json` do projeto):

```json
{
  "mcpServers": {
    "nexus-context": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\caminho\\para\\nexus-context\\bin\\nexus-context-mcp.js",
        "--project", "meu-projeto",
        "--db", "C:\\caminho\\meu-projeto\\.nexus-context\\context.sqlite",
        "--allowed-root", "C:\\caminho\\meu-projeto"
      ],
      "cwd": "C:\\caminho\\meu-projeto"
    }
  }
}
```

---

## 4. Preservação de Cache de Prompt

Reescrever o histórico de conversa ou injetar resumos mutáveis no topo do prompt de sistema invalida prefixos em cache nos provedores de LLM, podendo **aumentar** o custo e a latência mesmo com menos tokens brutos.

Para preservar o cache de prompt:
1. **Prefixo de catálogo estável e mínimo:** o servidor MCP expõe sempre exatamente **3 ferramentas** (`nexus_evidence`, `nexus_memory`, `nexus_record`) com schemas compactos e imutáveis entre turnos.
2. **Sem reescrita retroativa do prefixo:** os resultados de `select`, `expand`, `query` e `resume` entram apenas no turno atual (como resultado de ferramenta ou mensagem de retomada no final do contexto).
3. **Orçamento enxuto de retomada:** `nexus_memory(action="resume")` limita o cartão inicial a ~500 tokens estimados, evitando inflar o histórico após compactação.

---

## 5. Proveniência, Segurança e Governança de Memória

1. **Classificação de dados não confiáveis:** todo retorno de evidência carrega `dataClassification: "untrusted_evidence"` e toda consulta de memória carrega `dataClassification: "untrusted_memory"`. Resultados recuperados nunca devem ser tratados como instruções de sistema.
2. **Isolamento controlado pelo host:** `projectId`, `dbPath` e `allowedRoots` são fixados na inicialização do processo pelo host/usuário. Tentativas de sobrescrever esses campos via argumentos MCP são rejeitadas com erro JSON-RPC `-32602`.
3. **Política `allowDirectActive` (padrão `false`):** quando o modelo chama `nexus_record(action="decision")`, o registro é gravado com `status: "candidate"` mesmo que o modelo envie `status: "active"` ou `confirmedByUser: true`. A promoção para `active` exige aprovação humana explícita via CLI (`nexus-context.cmd memory approve <id>`) ou configuração explícita `--allow-direct-active` no host.
4. **Rastreabilidade de origens:** toda decisão registra `sourceRef`, revisão e histórico de substituições (`supersedesId`), enquanto evidências reduzidas preservam referência opaca `ev_<hex>` com hash SHA-256 e detecção de modificação posterior do arquivo (`sourceModified: true`).
5. **Limites de remoção e métricas:**
   - `memory forget` remove transacionalmente registros do SQLite local, índice FTS5 e blobs de evidência do projeto, mas **não apaga** arquivos Markdown exportados manualmente (ex.: cofre Obsidian).
   - `metrics report` informa estimativas locais heurísticas (`providerCostUsd: null`, `telemetryScope: "local_estimate_only"`). Custos reais faturados exigem telemetria oficial do cliente/provedor.
