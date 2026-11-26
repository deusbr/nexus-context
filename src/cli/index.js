import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStdioServer } from '../mcp/server.js';
import { resolveSafePath } from '../core/security.js';

const __cliDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MCP_ENTRYPOINT = path.resolve(__cliDir, '..', '..', 'bin', 'nexus-context-mcp.js');

export const CLI_VERSION = '1.0.0';

const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'version',
  'v',
  'json',
  'history',
  'candidates',
  'no-store',
  'allow-direct-active',
  'write'
]);

const MULTI_FLAGS = new Set([
  'allowed-root',
  'constraint',
  'completed',
  'pending',
  'decision',
  'affected-file',
  'reference'
]);

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/**
 * Faz o parse determinístico de argv preservando caminhos Windows com espaços e UTF-8.
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        const key = raw.slice(0, eqIdx);
        const value = raw.slice(eqIdx + 1);
        assignFlag(flags, key, value);
        continue;
      }

      if (BOOLEAN_FLAGS.has(raw)) {
        flags[raw] = true;
        continue;
      }

      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next !== '--')) {
        throw new CliUsageError(`A opção "--${raw}" exige um valor.`);
      }
      assignFlag(flags, raw, next);
      i += 1;
      continue;
    }

    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '-v') {
      flags.version = true;
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

function assignFlag(flags, key, value) {
  if (MULTI_FLAGS.has(key)) {
    if (!Array.isArray(flags[key])) {
      flags[key] = [];
    }
    flags[key].push(value);
  } else {
    flags[key] = value;
  }
}

function parseIntFlag(flags, key, min = 0) {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < min || String(parsed) !== String(raw).trim()) {
    throw new CliUsageError(`O parâmetro "--${key}" deve ser um número inteiro >= ${min}.`);
  }
  return parsed;
}

function parseCsvList(value) {
  if (value === undefined) return undefined;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDelimitedList(singleValue, repeatedValues) {
  const result = [];
  const pushParts = (raw) => {
    if (typeof raw !== 'string') return;
    for (const part of raw.split(/[;,]/)) {
      const trimmed = part.trim();
      if (trimmed) result.push(trimmed);
    }
  };
  if (Array.isArray(singleValue)) {
    singleValue.forEach(pushParts);
  } else if (singleValue !== undefined) {
    pushParts(String(singleValue));
  }
  if (Array.isArray(repeatedValues)) {
    repeatedValues.forEach(pushParts);
  }
  return result.length > 0 ? result : undefined;
}

function parseStatusCodes(raw) {
  if (raw === undefined) return undefined;
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new CliUsageError('O parâmetro "--status" não pode estar vazio.');
  }
  return parts.map((part) => {
    const code = Number.parseInt(part, 10);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new CliUsageError(`Código HTTP/status inválido em "--status": "${part}".`);
    }
    return code;
  });
}

async function readStreamText(stream) {
  if (!stream || stream.isTTY) {
    return '';
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveContextOptions(flags, cwd, env) {
  const projectId =
    flags.project ||
    env.NEXUS_CONTEXT_PROJECT ||
    path.basename(path.resolve(cwd)) ||
    'default';

  const dbPath =
    flags.db ||
    env.NEXUS_CONTEXT_DB ||
    path.join(cwd, '.nexus-context', 'context.sqlite');

  const allowedRoots =
    Array.isArray(flags['allowed-root']) && flags['allowed-root'].length > 0
      ? flags['allowed-root'].map((dir) => path.resolve(cwd, dir))
      : [path.resolve(cwd)];

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(cwd, dbPath)), { recursive: true });
  }

  return {
    dbPath: dbPath === ':memory:' ? ':memory:' : path.resolve(cwd, dbPath),
    projectId,
    allowedRoots
  };
}

async function loadCoreFactory(deps) {
  if (typeof deps.createNexusContext === 'function') {
    return deps.createNexusContext;
  }
  const coreMod = await import('../core/index.js');
  if (typeof coreMod.createNexusContext !== 'function') {
    throw new Error('src/core/index.js não exporta createNexusContext.');
  }
  return coreMod.createNexusContext;
}

function writeOut(stream, text) {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

function printJson(stream, payload) {
  writeOut(stream, JSON.stringify(payload, null, 2));
}

function buildHelpText() {
  return [
    'NEXUS Contexto CLI — Economia de tokens, evidência recuperável e memória versionada',
    '',
    'Uso:',
    '  nexus-context <comando> [opções]',
    '',
    'Comandos principais:',
    '  mcp                                 Inicia servidor MCP local (JSON-RPC 2.0 stdio)',
    '  select                              Seleciona e reduz evidência (--file ou stdin)',
    '  expand <ref>                        Expande trecho de referência ev_* armazenada',
    '  memory list|query|record|approve|revoke|forget|export',
    '  checkpoint save|resume              Salva ou retoma cartão de tarefa (<= ~500 tokens)',
    '  metrics report                      Exibe métricas locais e economia estimada',
    '  install-config <cliente>            Gera config para openbot|codex|claude-code|gemini-cli',
    '',
    'Opções globais comuns:',
    '  --project <id>                      Escopo do projeto (padrão: nome da pasta atual)',
    '  --db <path>                         Caminho do SQLite local (padrão: .nexus-context/context.sqlite)',
    '  --allowed-root <dir>                Raiz autorizada para leitura de arquivos (repetível)',
    '  --json                              Saída estruturada em JSON',
    '  -h, --help                          Mostra esta ajuda',
    '  -v, --version                       Mostra a versão'
  ].join('\n');
}

function formatSelectHuman(res) {
  if (!res.ok) {
    return `Erro (${res.errorCode || 'ERRO'}): ${res.message || 'Falha ao selecionar evidência.'}`;
  }
  const lines = [
    `[NEXUS Evidência | modo=${res.mode} | formato=${res.format} | projeto=${res.projectId}]`,
    `Classificação: ${res.dataClassification} | Segredos redatados: ${res.redactedSecretsCount ?? 0}`
  ];
  if (res.ref) {
    lines.push(`Referência recuperável: ${res.ref} (expira em: ${res.expiresAt || 'n/d'})`);
  }
  if (res.metrics) {
    lines.push(
      `Tokens estimados: ${res.metrics.estimatedRawTokens} -> ${res.metrics.estimatedReturnedTokens} (economia est.: ${res.metrics.savedTokensEstimate})`
    );
  }
  if (res.omissionsNotice) {
    lines.push(`Omissões: ${res.omissionsNotice}`);
  }
  lines.push('--- Trecho ---', res.excerpt || '');
  return lines.join('\n');
}

function formatExpandHuman(res) {
  if (!res.ok) {
    return `Erro (${res.errorCode || 'ERRO'}): ${res.message || 'Falha ao expandir referência.'}`;
  }
  const lines = [
    `[NEXUS Expansão | ref=${res.ref || 'n/d'} | linhas=${res.startLine ?? '?'}-${res.endLine ?? '?'} de ${res.totalLines ?? '?'}]`
  ];
  if (res.sourceModified) {
    lines.push(`AVISO: ${res.warning || 'O arquivo de origem foi modificado após o registro.'}`);
  }
  lines.push('--- Conteúdo ---', res.excerpt || res.content || '');
  return lines.join('\n');
}

function formatMemoryQueryHuman(res) {
  if (!res.ok) {
    return `Erro (${res.errorCode || 'ERRO'}): ${res.message || 'Falha na consulta.'}`;
  }
  if (!res.items || res.items.length === 0) {
    return res.notice || 'Nenhuma evidência ou decisão vigente encontrada.';
  }
  const lines = [`Resultados (${res.items.length}) [classificação=${res.dataClassification || 'untrusted_memory'}]:`];
  for (const item of res.items) {
    lines.push(
      `- [${item.status} | rev.${item.revision} | ${item.kind}] ${item.id}: ${item.title}`,
      `  Conteúdo: ${item.content}`,
      `  Fonte: ${item.sourceRef}${item.effectiveDate ? ` | Data: ${item.effectiveDate}` : ''}`
    );
  }
  return lines.join('\n');
}

function formatResumeHuman(res) {
  if (!res.ok) {
    return `Erro (${res.errorCode || 'ERRO'}): ${res.message || 'Falha ao retomar tarefa.'}`;
  }
  if (res.found === false) {
    return res.notice || 'Checkpoint não encontrado.';
  }
  const lines = [
    `[NEXUS Retomada | tarefa=${res.taskId || 'n/d'} | rev.${res.revision ?? '?'} | ~${res.estimatedTokens ?? '?'} tokens]`
  ];
  if (res.staleCodeWarning) {
    lines.push('AVISO: Branch ou HEAD Git divergem do checkpoint salvo.');
  }
  lines.push(`Objetivo: ${res.objective}`);
  if (res.constraints?.length) lines.push(`Restrições: ${res.constraints.join(' | ')}`);
  if (res.completed?.length) lines.push(`Concluído: ${res.completed.join(' | ')}`);
  if (res.pending?.length) lines.push(`Pendências: ${res.pending.join(' | ')}`);
  if (res.activeDecisions?.length) lines.push(`Decisões vigentes: ${res.activeDecisions.join(' | ')}`);
  if (res.rejectedApproaches?.length) {
    lines.push(`Abordagens rejeitadas: ${res.rejectedApproaches.join(' | ')}`);
  }
  if (res.affectedFiles?.length) lines.push(`Arquivos: ${res.affectedFiles.join(', ')}`);
  if (res.omissionsNotice) lines.push(`Nota: ${res.omissionsNotice}`);
  return lines.join('\n');
}

function formatMetricsHuman(res) {
  return [
    '[NEXUS Métricas Locais]',
    `Operações: ${res.operationsCount ?? 0} (select=${res.selectCount ?? 0}, expand=${res.expandReconsultCount ?? 0}, query=${res.memoryQueryCount ?? 0}, resume=${res.resumeCount ?? 0})`,
    `Bytes: brutos=${res.totalRawBytes ?? 0}, retornados=${res.totalReturnedBytes ?? 0}`,
    `Tokens estimados: brutos=${res.totalEstimatedRawTokens ?? 0}, retornados=${res.totalEstimatedReturnedTokens ?? 0}, economia=${res.estimatedSavedTokens ?? 0} (${res.estimatedReductionPct ?? 0}%)`,
    `Latência (ms): p50=${res.latencyMs?.p50 ?? 0}, p95=${res.latencyMs?.p95 ?? 0}, max=${res.latencyMs?.max ?? 0}`,
    `Custo provedor (USD): ${res.providerCostUsd ?? 'indisponível'}`,
    `Aviso: ${res.disclaimer || 'Estimativa local.'}`
  ].join('\n');
}

function toTomlString(value) {
  let out = '"';
  for (const ch of String(value)) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function buildInstallConfig(client, { projectId, dbPath, allowedRoots, allowDirectActive, nodePath, mcpEntrypoint }) {
  if (/[\x00-\x1f\x7f]/.test(String(projectId))) {
    throw new CliUsageError('O parâmetro "--project" não pode conter caracteres de controle ou quebras de linha.');
  }
  // Evita invocação via cmd.exe/.cmd (mitiga CVE-2024-24576, injeção com '&' e expansão '%VAR%').
  const mcpCommand = nodePath || process.execPath;
  const entry = mcpEntrypoint || DEFAULT_MCP_ENTRYPOINT;

  const args = [entry, '--project', projectId, '--db', dbPath];
  for (const root of allowedRoots) {
    args.push('--allowed-root', root);
  }
  if (allowDirectActive) {
    args.push('--allow-direct-active');
  }

  switch (client) {
    case 'openbot': {
      const payload = {
        name: 'nexus-context',
        transport: 'stdio',
        command: mcpCommand,
        args,
        workingDirectory: allowedRoots[0] || process.cwd(),
        enabled: true
      };
      return {
        client: 'openbot',
        format: 'json',
        targetFileHint: 'Configuração MCP do OpenBot (Marketplace -> Apps / openbot.save_mcp_server)',
        content: JSON.stringify(payload, null, 2),
        config: payload
      };
    }
    case 'codex': {
      const tomlArgs = args.map(toTomlString).join(', ');
      const toml = [
        '[mcp_servers.nexus_context]',
        `command = ${toTomlString(mcpCommand)}`,
        `args = [${tomlArgs}]`,
        `cwd = ${toTomlString(allowedRoots[0] || process.cwd())}`
      ].join('\n');
      return {
        client: 'codex',
        format: 'toml',
        targetFileHint: '%USERPROFILE%\\.codex\\config.toml (ou .codex\\config.toml no projeto)',
        content: toml,
        config: { command: mcpCommand, args, cwd: allowedRoots[0] || process.cwd() }
      };
    }
    case 'claude-code': {
      const payload = {
        mcpServers: {
          'nexus-context': {
            command: mcpCommand,
            args
          }
        }
      };
      return {
        client: 'claude-code',
        format: 'json',
        targetFileHint: '.mcp.json (projeto) ou %USERPROFILE%\\.claude.json',
        content: JSON.stringify(payload, null, 2),
        config: payload
      };
    }
    case 'gemini-cli': {
      const payload = {
        mcpServers: {
          'nexus-context': {
            command: mcpCommand,
            args,
            cwd: allowedRoots[0] || process.cwd()
          }
        }
      };
      return {
        client: 'gemini-cli',
        format: 'json',
        targetFileHint: '%USERPROFILE%\\.gemini\\settings.json (ou .gemini\\settings.json)',
        content: JSON.stringify(payload, null, 2),
        config: payload
      };
    }
    default:
      throw new CliUsageError(
        `Cliente desconhecido "${client}". Use: openbot, codex, claude-code ou gemini-cli.`
      );
  }
}

/**
 * Executa o CLI com dependências injetáveis para facilitar testes sem subprocesso.
 */
export async function runCli(argv, deps = {}) {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const version = deps.version ?? CLI_VERSION;
  const startServer = deps.startStdioServer ?? startStdioServer;

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    writeOut(stderr, `Erro de argumentos: ${err.message}`);
    return 2;
  }

  const { positionals, flags } = parsed;

  if (flags.version) {
    if (flags.json) {
      printJson(stdout, { name: 'nexus-context', version });
    } else {
      writeOut(stdout, `nexus-context v${version}`);
    }
    return 0;
  }

  if (flags.help || positionals.length === 0 || positionals[0] === 'help') {
    writeOut(stdout, buildHelpText());
    return 0;
  }

  const command = positionals[0];

  if (command === 'install-config') {
    const client = positionals[1];
    if (!client) {
      writeOut(stderr, 'Uso: nexus-context install-config <openbot|codex|claude-code|gemini-cli>');
      return 2;
    }
    try {
      const { projectId, dbPath, allowedRoots } = resolveContextOptions(flags, cwd, env);
      const result = buildInstallConfig(client, {
        projectId,
        dbPath,
        allowedRoots,
        allowDirectActive: Boolean(flags['allow-direct-active']),
        nodePath: flags['node-path'],
        mcpEntrypoint: flags['mcp-entrypoint']
      });

      if (flags.write || flags.out) {
        if (!flags.out) {
          throw new CliUsageError(
            'Por segurança, informe "--out <caminho>" ao usar "--write" para não sobrescrever arquivos globais sem destino explícito.'
          );
        }
        const outPath = path.resolve(cwd, flags.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${result.content}\n`, 'utf8');
        result.writtenTo = outPath;
      }

      if (flags.json) {
        printJson(stdout, { ok: true, ...result });
      } else {
        writeOut(
          stdout,
          [
            `[Configuração MCP — ${result.client}]`,
            `Destino sugerido: ${result.targetFileHint}`,
            result.writtenTo ? `Arquivo gravado em: ${result.writtenTo}` : '',
            '---',
            result.content
          ]
            .filter(Boolean)
            .join('\n')
        );
      }
      return 0;
    } catch (err) {
      writeOut(stderr, `Erro: ${err.message}`);
      return err instanceof CliUsageError ? 2 : 1;
    }
  }

  let ctx;
  try {
    const createNexusContext = await loadCoreFactory(deps);
    const ctxOpts = resolveContextOptions(flags, cwd, env);
    ctx = createNexusContext(ctxOpts);

    if (command === 'mcp') {
      const serverRunner = startServer({
        ctx,
        allowDirectActive: Boolean(flags['allow-direct-active']),
        serverVersion: version,
        input: stdin,
        output: stdout,
        stderr,
        closeCtxOnEnd: true
      });
      await serverRunner.done;
      return 0;
    }

    if (command === 'select') {
      const fileArg = flags.file;
      let content;
      let filePath;
      if (fileArg) {
        filePath = path.resolve(cwd, fileArg);
      } else {
        content = await readStreamText(stdin);
        if (!content) {
          throw new CliUsageError('Informe "--file <caminho>" ou envie conteúdo via stdin.');
        }
      }

      const res = ctx.evidence.select({
        content,
        filePath,
        format: flags.format || 'auto',
        query: flags.query,
        predicate: flags.predicate,
        statusCodes: parseStatusCodes(flags.status),
        contextLines: parseIntFlag(flags, 'context-lines', 0),
        maxTokens: parseIntFlag(flags, 'max-tokens', 1),
        keepFields: parseCsvList(flags['keep-fields']),
        storeOriginal: flags['no-store'] ? false : undefined,
        taskId: flags.task
      });

      if (flags.json) {
        printJson(stdout, res);
      } else {
        writeOut(stdout, formatSelectHuman(res));
      }
      return res.ok ? 0 : 1;
    }

    if (command === 'expand') {
      const ref = positionals[1] || flags.ref;
      if (!ref) {
        throw new CliUsageError('Uso: nexus-context expand <ref> [opções]');
      }
      const res = ctx.evidence.expand({
        ref,
        query: flags.query,
        startLine: parseIntFlag(flags, 'start-line', 1),
        endLine: parseIntFlag(flags, 'end-line', 1),
        contextLines: parseIntFlag(flags, 'context-lines', 0),
        maxTokens: parseIntFlag(flags, 'max-tokens', 1),
        taskId: flags.task
      });

      if (flags.json) {
        printJson(stdout, res);
      } else {
        writeOut(stdout, formatExpandHuman(res));
      }
      return res.ok ? 0 : 1;
    }

    if (command === 'memory') {
      const sub = positionals[1];
      if (!sub) {
        throw new CliUsageError(
          'Uso: nexus-context memory <list|query|record|approve|revoke|forget|export> [opções]'
        );
      }

      if (sub === 'list') {
        const res = ctx.memory.list({
          status: flags.status,
          kind: flags.kind,
          limit: parseIntFlag(flags, 'limit', 1)
        });
        if (flags.json) {
          printJson(stdout, res);
        } else {
          const items = res.items || [];
          writeOut(
            stdout,
            items.length === 0
              ? 'Nenhum registro de memória encontrado.'
              : items
                  .map(
                    (i) =>
                      `- [${i.status} | rev.${i.revision} | ${i.kind}] ${i.id}: ${i.title} (fonte: ${i.sourceRef})`
                  )
                  .join('\n')
          );
        }
        return res.ok === false ? 1 : 0;
      }

      if (sub === 'query') {
        const query = flags.query || positionals.slice(2).join(' ');
        if (!query) {
          throw new CliUsageError('Uso: nexus-context memory query <consulta>');
        }
        const res = ctx.memory.query({
          query,
          kind: flags.kind,
          includeHistory: Boolean(flags.history),
          includeCandidates: Boolean(flags.candidates),
          limit: parseIntFlag(flags, 'limit', 1),
          maxTokens: parseIntFlag(flags, 'max-tokens', 1)
        });
        if (flags.json) {
          printJson(stdout, res);
        } else {
          writeOut(stdout, formatMemoryQueryHuman(res));
        }
        return res.ok === false ? 1 : 0;
      }

      if (sub === 'record') {
        const kind = flags.kind || 'decision';
        const title = flags.title;
        const sourceRef = flags.source;
        let content = flags.content;
        if (!content && flags.file) {
          const targetPath = path.resolve(cwd, flags.file);
          if (ctxOpts.allowedRoots.length > 0) {
            const safe = resolveSafePath(targetPath, ctxOpts.allowedRoots);
            if (!safe.ok) {
              throw new CliUsageError(`Acesso negado ao arquivo "--file": ${safe.message}`);
            }
            content = fs.readFileSync(safe.path, 'utf8');
          } else {
            content = fs.readFileSync(targetPath, 'utf8');
          }
        }
        if (!content) {
          content = (await readStreamText(stdin)).trim();
        }
        if (!title || !content || !sourceRef) {
          throw new CliUsageError(
            'Uso: nexus-context memory record --title <t> --source <ref> (--content <c> | --file <path> | stdin) [--kind <k>]'
          );
        }
        const res = ctx.memory.recordDecision({
          kind,
          title,
          content,
          rationale: flags.rationale,
          sourceRef,
          effectiveDate: flags.date,
          status: flags.status || 'active',
          supersedesId: flags.supersedes,
          expectedRevision: parseIntFlag(flags, 'expected-revision', 1),
          eventId: flags['event-id'],
          tags: parseCsvList(flags.tags)
        });
        if (flags.json) {
          printJson(stdout, res);
        } else if (res.ok) {
          writeOut(
            stdout,
            `Registro salvo: id=${res.id} | revisão=${res.revision} | status=${res.status}${res.idempotentReplay ? ' (replay idempotente)' : ''}`
          );
        } else {
          writeOut(stdout, `Erro (${res.errorCode}): ${res.message}`);
        }
        return res.ok ? 0 : 1;
      }

      if (sub === 'approve') {
        const id = positionals[2] || flags.id;
        if (!id) {
          throw new CliUsageError('Uso: nexus-context memory approve <id>');
        }
        const res = ctx.memory.approveDecision({ id });
        if (flags.json) {
          printJson(stdout, res);
        } else {
          writeOut(
            stdout,
            res.ok ? `Decisão ${id} aprovada (status=active).` : `Erro (${res.errorCode}): ${res.message}`
          );
        }
        return res.ok ? 0 : 1;
      }

      if (sub === 'revoke') {
        const id = positionals[2] || flags.id;
        const reason = flags.reason;
        if (!id || !reason) {
          throw new CliUsageError('Uso: nexus-context memory revoke <id> --reason <motivo>');
        }
        const res = ctx.memory.revokeDecision({ id, reason });
        if (flags.json) {
          printJson(stdout, res);
        } else {
          writeOut(
            stdout,
            res.ok ? `Decisão ${id} revogada.` : `Erro (${res.errorCode}): ${res.message}`
          );
        }
        return res.ok ? 0 : 1;
      }

      if (sub === 'forget') {
        const scope = flags.scope || positionals[2];
        const targetId = flags.target || positionals[3];
        if (!scope) {
          throw new CliUsageError(
            'Uso: nexus-context memory forget --scope <entry|task|evidence|project> [--target <id>]'
          );
        }
        const res = ctx.memory.forget({ scope, targetId });
        if (flags.json) {
          printJson(stdout, res);
        } else if (res.ok) {
          writeOut(
            stdout,
            `Remoção concluída no escopo "${scope}". ${res.notice || 'Cópias exportadas externamente não são removidas automaticamente.'}`
          );
        } else {
          writeOut(stdout, `Erro (${res.errorCode}): ${res.message}`);
        }
        return res.ok ? 0 : 1;
      }

      if (sub === 'export') {
        const res = ctx.memory.exportMarkdown({
          taskId: flags.task,
          includeHistory: Boolean(flags.history)
        });
        const markdown = typeof res === 'string' ? res : res.markdown || '';
        let writtenTo = null;
        if (flags.out) {
          writtenTo = path.resolve(cwd, flags.out);
          fs.mkdirSync(path.dirname(writtenTo), { recursive: true });
          fs.writeFileSync(writtenTo, markdown, 'utf8');
        }
        if (flags.json) {
          printJson(stdout, typeof res === 'string' ? { ok: true, markdown, writtenTo } : { ...res, writtenTo });
        } else if (writtenTo) {
          writeOut(stdout, `Markdown exportado com sucesso em: ${writtenTo}`);
        } else {
          writeOut(stdout, markdown);
        }
        return res?.ok === false ? 1 : 0;
      }

      throw new CliUsageError(`Subcomando memory desconhecido: "${sub}".`);
    }

    if (command === 'checkpoint') {
      const sub = positionals[1];
      if (!sub) {
        throw new CliUsageError('Uso: nexus-context checkpoint <save|resume> [opções]');
      }

      if (sub === 'save') {
        let inputPayload = {};
        if (flags.file) {
          const targetPath = path.resolve(cwd, flags.file);
          if (ctxOpts.allowedRoots.length > 0) {
            const safe = resolveSafePath(targetPath, ctxOpts.allowedRoots);
            if (!safe.ok) {
              throw new CliUsageError(`Acesso negado ao arquivo "--file": ${safe.message}`);
            }
            inputPayload = JSON.parse(fs.readFileSync(safe.path, 'utf8'));
          } else {
            inputPayload = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
          }
        }
        const taskId = flags.task || inputPayload.taskId;
        const objective = flags.objective || inputPayload.objective;
        if (!taskId || !objective) {
          throw new CliUsageError(
            'Uso: nexus-context checkpoint save --task <id> --objective <objetivo> [opções]'
          );
        }

        const res = ctx.memory.saveCheckpoint({
          taskId,
          objective,
          constraints:
            parseDelimitedList(flags.constraints, flags.constraint) ?? inputPayload.constraints,
          completed:
            parseDelimitedList(flags.completed) ?? inputPayload.completed,
          pending: parseDelimitedList(flags.pending) ?? inputPayload.pending,
          activeDecisions:
            parseDelimitedList(flags.decisions, flags.decision) ?? inputPayload.activeDecisions,
          affectedFiles:
            parseDelimitedList(flags.files, flags['affected-file']) ?? inputPayload.affectedFiles,
          references:
            parseDelimitedList(flags.refs, flags.reference) ?? inputPayload.references,
          gitBranch: flags.branch ?? inputPayload.gitBranch,
          gitHead: flags.head ?? inputPayload.gitHead,
          expectedRevision:
            parseIntFlag(flags, 'expected-revision', 1) ?? inputPayload.expectedRevision,
          eventId: flags['event-id'] ?? inputPayload.eventId
        });

        if (flags.json) {
          printJson(stdout, res);
        } else if (res.ok) {
          writeOut(
            stdout,
            `Checkpoint salvo para tarefa "${taskId}" (revisão=${res.revision}${res.idempotentReplay ? ', replay idempotente' : ''}).`
          );
        } else {
          writeOut(stdout, `Erro (${res.errorCode}): ${res.message}`);
        }
        return res.ok ? 0 : 1;
      }

      if (sub === 'resume') {
        const taskId = positionals[2] || flags.task;
        if (!taskId) {
          throw new CliUsageError('Uso: nexus-context checkpoint resume <taskId>');
        }
        const res = ctx.memory.resume({
          taskId,
          maxTokens: parseIntFlag(flags, 'max-tokens', 1),
          currentGitBranch: flags.branch,
          currentGitHead: flags.head
        });
        if (flags.json) {
          printJson(stdout, res);
        } else {
          writeOut(stdout, formatResumeHuman(res));
        }
        return res.ok === false ? 1 : 0;
      }

      throw new CliUsageError(`Subcomando checkpoint desconhecido: "${sub}".`);
    }

    if (command === 'metrics') {
      const sub = positionals[1] || 'report';
      if (sub !== 'report') {
        throw new CliUsageError(`Subcomando metrics desconhecido: "${sub}". Use "metrics report".`);
      }
      const res = ctx.metrics.report({ taskId: flags.task });
      if (flags.json) {
        printJson(stdout, res);
      } else {
        writeOut(stdout, formatMetricsHuman(res));
      }
      return 0;
    }

    throw new CliUsageError(`Comando desconhecido: "${command}". Use "--help" para ajuda.`);
  } catch (err) {
    writeOut(stderr, `Erro: ${err.message}`);
    return err instanceof CliUsageError ? 2 : 1;
  } finally {
    if (command !== 'mcp' && ctx && typeof ctx.close === 'function') {
      try {
        ctx.close();
      } catch {
        // Ignora erro no fechamento após resposta já emitida.
      }
    }
  }
}
