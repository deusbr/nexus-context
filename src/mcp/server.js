/**
 * Servidor MCP local sobre stdio (JSON-RPC 2.0 newline-delimited).
 * Compatível com as versões MCP: 2025-11-25, 2025-06-18, 2025-03-26 e 2024-11-05.
 *
 * Restrição crítica: NUNCA usar console.log ou escrever texto fora do protocolo
 * JSON-RPC em process.stdout. Diagnósticos opcionais vão apenas para stderr
 * quando NEXUS_CONTEXT_DEBUG=1.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
]);

export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

const JSON_RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
});

const RESERVED_HOST_FIELDS = new Set(['projectId', 'allowedRoots', 'dbPath']);

/**
 * Catálogo enxuto com exatamente 3 ferramentas para minimizar overhead de schema.
 */
const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'nexus_evidence',
    description: 'Select filtered log/json/code evidence or expand a saved ev_ ref.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['select', 'expand'] },
        content: { type: 'string' },
        filePath: { type: 'string' },
        format: { type: 'string', enum: ['auto', 'json', 'log', 'code', 'text'] },
        ref: { type: 'string' },
        query: { type: 'string' },
        predicate: { type: 'string' },
        statusCodes: { type: 'array', items: { type: 'integer' } },
        contextLines: { type: 'integer' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
        maxTokens: { type: 'integer' },
        keepFields: { type: 'array', items: { type: 'string' } },
        taskId: { type: 'string' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'nexus_memory',
    description: 'Query active project memory, query history, or resume a task checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'resume', 'history'] },
        query: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['decision', 'constraint', 'fact', 'rejected_approach', 'preference']
        },
        taskId: { type: 'string' },
        maxTokens: { type: 'integer' },
        limit: { type: 'integer' },
        includeCandidates: { type: 'boolean' },
        currentGitBranch: { type: 'string' },
        currentGitHead: { type: 'string' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'nexus_record',
    description: 'Record a task checkpoint or candidate/active project decision.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['checkpoint', 'decision'] },
        taskId: { type: 'string' },
        objective: { type: 'string' },
        constraints: { type: 'array', items: { type: 'string' } },
        completed: { type: 'array', items: { type: 'string' } },
        pending: { type: 'array', items: { type: 'string' } },
        activeDecisions: { type: 'array', items: { type: 'string' } },
        affectedFiles: { type: 'array', items: { type: 'string' } },
        references: { type: 'array', items: { type: 'string' } },
        gitBranch: { type: 'string' },
        gitHead: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['decision', 'constraint', 'fact', 'rejected_approach', 'preference']
        },
        title: { type: 'string' },
        content: { type: 'string' },
        rationale: { type: 'string' },
        sourceRef: { type: 'string' },
        effectiveDate: { type: 'string' },
        status: { type: 'string', enum: ['active', 'candidate'] },
        supersedesId: { type: 'string' },
        expectedRevision: { type: 'integer' },
        eventId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        confirmedByUser: { type: 'boolean' }
      },
      required: ['action'],
      additionalProperties: false
    }
  }
]);

const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeErrorResponse(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) {
    err.data = data;
  }
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: err
  };
}

function makeSuccessResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

function formatToolResult(payload) {
  const isError = isPlainObject(payload) && payload.ok === false;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
      }
    ],
    isError
  };
}

function assertNoReservedHostFields(args) {
  for (const key of RESERVED_HOST_FIELDS) {
    if (Object.hasOwn(args, key)) {
      throw new InvalidParamsError(
        `Parâmetro reservado "${key}" não pode ser definido ou sobrescrito por chamadas MCP.`
      );
    }
  }
}

function validateAllowedKeys(args, schema) {
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new InvalidParamsError(`Parâmetro não suportado: "${key}".`);
    }
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidParamsError(`Parâmetro obrigatório "${fieldName}" deve ser uma string não vazia.`);
  }
}

function assertOptionalString(value, fieldName) {
  if (value !== undefined && typeof value !== 'string') {
    throw new InvalidParamsError(`Parâmetro "${fieldName}" deve ser string.`);
  }
}

function assertOptionalInt(value, fieldName) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new InvalidParamsError(`Parâmetro "${fieldName}" deve ser um inteiro >= 0.`);
  }
}

function assertOptionalStringArray(value, fieldName) {
  if (value !== undefined) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new InvalidParamsError(`Parâmetro "${fieldName}" deve ser um array de strings.`);
    }
  }
}

function assertOptionalIntArray(value, fieldName) {
  if (value !== undefined) {
    if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
      throw new InvalidParamsError(`Parâmetro "${fieldName}" deve ser um array de inteiros.`);
    }
  }
}

class InvalidParamsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidParamsError';
  }
}

function debugLog(stderr, message) {
  if (process.env.NEXUS_CONTEXT_DEBUG === '1' && stderr && typeof stderr.write === 'function') {
    stderr.write(`[nexus-context-mcp] ${message}\n`);
  }
}

/**
 * Cria instância do servidor MCP local com tratamento de mensagens JSON-RPC 2.0.
 *
 * @param {object} options
 * @param {object} options.ctx Instância retornada por createNexusContext()
 * @param {boolean} [options.allowDirectActive=false] Se false, decisões via MCP são gravadas sempre como 'candidate'
 * @param {string} [options.serverVersion='1.0.0'] Versão reportada em serverInfo
 * @param {string} [options.serverName='nexus-context'] Nome reportado em serverInfo
 * @param {NodeJS.WritableStream} [options.stderr=process.stderr] Stream opcional de diagnóstico
 */
export function createMcpServer({
  ctx,
  allowDirectActive = false,
  serverVersion = '1.0.0',
  serverName = 'nexus-context',
  stderr = process.stderr
} = {}) {
  if (!ctx || !ctx.evidence || !ctx.memory) {
    throw new TypeError('createMcpServer exige uma instância válida de ctx com evidence e memory.');
  }

  let negotiatedProtocolVersion = DEFAULT_PROTOCOL_VERSION;
  let initialized = false;

  function handleInitialize(id, params) {
    if (params !== undefined && !isPlainObject(params)) {
      return makeErrorResponse(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params de initialize deve ser um objeto.');
    }

    const requestedVersion = params?.protocolVersion;
    if (requestedVersion !== undefined && typeof requestedVersion !== 'string') {
      return makeErrorResponse(
        id,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'protocolVersion deve ser uma string.'
      );
    }

    negotiatedProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : DEFAULT_PROTOCOL_VERSION;

    return makeSuccessResponse(id, {
      protocolVersion: negotiatedProtocolVersion,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: serverName,
        version: serverVersion
      }
    });
  }

  function handleToolsList(id, params) {
    if (params !== undefined && !isPlainObject(params)) {
      return makeErrorResponse(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params de tools/list deve ser um objeto.');
    }
    return makeSuccessResponse(id, {
      tools: TOOL_DEFINITIONS
    });
  }

  function executeEvidenceTool(args) {
    if (args.action === 'select') {
      if (args.content === undefined && args.filePath === undefined) {
        throw new InvalidParamsError(
          'nexus_evidence(action="select") exige "content" ou "filePath".'
        );
      }
      assertOptionalString(args.content, 'content');
      assertOptionalString(args.filePath, 'filePath');
      assertOptionalString(args.format, 'format');
      assertOptionalString(args.query, 'query');
      assertOptionalString(args.predicate, 'predicate');
      assertOptionalIntArray(args.statusCodes, 'statusCodes');
      assertOptionalInt(args.contextLines, 'contextLines');
      assertOptionalInt(args.maxTokens, 'maxTokens');
      assertOptionalStringArray(args.keepFields, 'keepFields');
      assertOptionalString(args.taskId, 'taskId');

      return ctx.evidence.select({
        content: args.content,
        filePath: args.filePath,
        format: args.format,
        query: args.query,
        predicate: args.predicate,
        statusCodes: args.statusCodes,
        contextLines: args.contextLines,
        maxTokens: args.maxTokens,
        keepFields: args.keepFields,
        taskId: args.taskId
      });
    }

    if (args.action === 'expand') {
      assertNonEmptyString(args.ref, 'ref');
      assertOptionalString(args.query, 'query');
      assertOptionalInt(args.startLine, 'startLine');
      assertOptionalInt(args.endLine, 'endLine');
      assertOptionalInt(args.contextLines, 'contextLines');
      assertOptionalInt(args.maxTokens, 'maxTokens');
      assertOptionalString(args.taskId, 'taskId');

      return ctx.evidence.expand({
        ref: args.ref,
        query: args.query,
        startLine: args.startLine,
        endLine: args.endLine,
        contextLines: args.contextLines,
        maxTokens: args.maxTokens,
        taskId: args.taskId
      });
    }

    throw new InvalidParamsError(`Ação inválida para nexus_evidence: "${String(args.action)}".`);
  }

  function executeMemoryTool(args) {
    if (args.action === 'query' || args.action === 'history') {
      assertNonEmptyString(args.query, 'query');
      assertOptionalString(args.kind, 'kind');
      assertOptionalInt(args.limit, 'limit');
      assertOptionalInt(args.maxTokens, 'maxTokens');
      if (args.includeCandidates !== undefined && typeof args.includeCandidates !== 'boolean') {
        throw new InvalidParamsError('Parâmetro "includeCandidates" deve ser booleano.');
      }

      return ctx.memory.query({
        query: args.query,
        kind: args.kind,
        limit: args.limit,
        maxTokens: args.maxTokens,
        includeHistory: args.action === 'history',
        includeCandidates: args.action === 'history' ? Boolean(args.includeCandidates) : false
      });
    }

    if (args.action === 'resume') {
      assertNonEmptyString(args.taskId, 'taskId');
      assertOptionalInt(args.maxTokens, 'maxTokens');
      assertOptionalString(args.currentGitBranch, 'currentGitBranch');
      assertOptionalString(args.currentGitHead, 'currentGitHead');

      return ctx.memory.resume({
        taskId: args.taskId,
        maxTokens: args.maxTokens,
        currentGitBranch: args.currentGitBranch,
        currentGitHead: args.currentGitHead
      });
    }

    throw new InvalidParamsError(`Ação inválida para nexus_memory: "${String(args.action)}".`);
  }

  function executeRecordTool(args) {
    if (args.action === 'checkpoint') {
      assertNonEmptyString(args.taskId, 'taskId');
      assertNonEmptyString(args.objective, 'objective');
      assertOptionalStringArray(args.constraints, 'constraints');
      assertOptionalStringArray(args.completed, 'completed');
      assertOptionalStringArray(args.pending, 'pending');
      assertOptionalStringArray(args.activeDecisions, 'activeDecisions');
      assertOptionalStringArray(args.affectedFiles, 'affectedFiles');
      assertOptionalStringArray(args.references, 'references');
      assertOptionalString(args.gitBranch, 'gitBranch');
      assertOptionalString(args.gitHead, 'gitHead');
      assertOptionalInt(args.expectedRevision, 'expectedRevision');
      assertOptionalString(args.eventId, 'eventId');

      return ctx.memory.saveCheckpoint({
        taskId: args.taskId,
        objective: args.objective,
        constraints: args.constraints,
        completed: args.completed,
        pending: args.pending,
        activeDecisions: args.activeDecisions,
        affectedFiles: args.affectedFiles,
        references: args.references,
        gitBranch: args.gitBranch,
        gitHead: args.gitHead,
        expectedRevision: args.expectedRevision,
        eventId: args.eventId
      });
    }

    if (args.action === 'decision') {
      assertNonEmptyString(args.kind, 'kind');
      assertNonEmptyString(args.title, 'title');
      assertNonEmptyString(args.content, 'content');
      assertNonEmptyString(args.sourceRef, 'sourceRef');
      assertOptionalString(args.rationale, 'rationale');
      assertOptionalString(args.effectiveDate, 'effectiveDate');
      assertOptionalString(args.supersedesId, 'supersedesId');
      assertOptionalInt(args.expectedRevision, 'expectedRevision');
      assertOptionalString(args.eventId, 'eventId');
      assertOptionalStringArray(args.tags, 'tags');

      // Política segura: por padrão allowDirectActive=false força status 'candidate'.
      let resolvedStatus = 'candidate';
      if (allowDirectActive === true) {
        if (args.status === 'active' || args.confirmedByUser === true) {
          resolvedStatus = 'active';
        }
      }

      return ctx.memory.recordDecision({
        kind: args.kind,
        title: args.title,
        content: args.content,
        rationale: args.rationale,
        sourceRef: args.sourceRef,
        effectiveDate: args.effectiveDate,
        status: resolvedStatus,
        supersedesId: args.supersedesId,
        expectedRevision: args.expectedRevision,
        eventId: args.eventId,
        tags: args.tags
      });
    }

    throw new InvalidParamsError(`Ação inválida para nexus_record: "${String(args.action)}".`);
  }

  function handleToolsCall(id, params) {
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      return makeErrorResponse(
        id,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'params de tools/call exige { name: string, arguments?: object }.'
      );
    }

    const tool = TOOL_MAP.get(params.name);
    if (!tool) {
      return makeErrorResponse(
        id,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `Ferramenta desconhecida: "${params.name}".`
      );
    }

    const rawArgs = params.arguments === undefined ? {} : params.arguments;
    if (!isPlainObject(rawArgs)) {
      return makeErrorResponse(
        id,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'arguments em tools/call deve ser um objeto JSON.'
      );
    }

    try {
      assertNoReservedHostFields(rawArgs);
      validateAllowedKeys(rawArgs, tool.inputSchema);

      let result;
      if (params.name === 'nexus_evidence') {
        result = executeEvidenceTool(rawArgs);
      } else if (params.name === 'nexus_memory') {
        result = executeMemoryTool(rawArgs);
      } else if (params.name === 'nexus_record') {
        result = executeRecordTool(rawArgs);
      }

      return makeSuccessResponse(id, formatToolResult(result));
    } catch (err) {
      if (err instanceof InvalidParamsError) {
        return makeErrorResponse(id, JSON_RPC_ERRORS.INVALID_PARAMS, err.message);
      }
      debugLog(stderr, `Erro interno em tools/call(${params.name}): ${err?.message ?? err}`);
      return makeErrorResponse(
        id,
        JSON_RPC_ERRORS.INTERNAL_ERROR,
        err?.message || 'Erro interno ao executar ferramenta.'
      );
    }
  }

  /**
   * Processa uma mensagem JSON-RPC 2.0 (ou lote).
   * Retorna objeto resposta JSON-RPC ou `null` para notificações sem `id`.
   */
  async function handleMessage(msg) {
    if (Array.isArray(msg)) {
      if (msg.length === 0) {
        return makeErrorResponse(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Lote JSON-RPC vazio.');
      }
      const responses = [];
      for (const item of msg) {
        const res = await handleMessage(item);
        if (res !== null) {
          responses.push(res);
        }
      }
      return responses.length > 0 ? responses : null;
    }

    if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      const hasValidId = isPlainObject(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number');
      return makeErrorResponse(
        hasValidId ? msg.id : null,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        'Mensagem JSON-RPC 2.0 inválida.'
      );
    }

    const isNotification = !Object.hasOwn(msg, 'id') || msg.id === undefined;

    if (msg.method === 'notifications/initialized') {
      initialized = true;
      return isNotification ? null : makeSuccessResponse(msg.id, {});
    }

    if (msg.method === 'notifications/cancelled') {
      return isNotification ? null : makeSuccessResponse(msg.id, {});
    }

    if (isNotification && msg.method.startsWith('notifications/')) {
      return null;
    }

    if (isNotification) {
      return null;
    }

    const { id, method, params } = msg;

    switch (method) {
      case 'initialize':
        return handleInitialize(id, params);
      case 'ping':
        return makeSuccessResponse(id, {});
      case 'tools/list':
        return handleToolsList(id, params);
      case 'tools/call':
        return handleToolsCall(id, params);
      default:
        return makeErrorResponse(
          id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Método não encontrado: "${method}".`
        );
    }
  }

  function getTools() {
    return TOOL_DEFINITIONS;
  }

  function getState() {
    return {
      initialized,
      protocolVersion: negotiatedProtocolVersion,
      allowDirectActive: Boolean(allowDirectActive)
    };
  }

  return {
    handleMessage,
    getTools,
    getState
  };
}

/**
 * Inicia o transporte stdio newline-delimited JSON-RPC 2.0.
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {boolean} [options.allowDirectActive=false]
 * @param {string} [options.serverVersion='1.0.0']
 * @param {string} [options.serverName='nexus-context']
 * @param {NodeJS.ReadableStream} [options.input=process.stdin]
 * @param {NodeJS.WritableStream} [options.output=process.stdout]
 * @param {NodeJS.WritableStream} [options.stderr=process.stderr]
 * @param {boolean} [options.closeCtxOnEnd=true]
 */
export function startStdioServer({
  ctx,
  allowDirectActive = false,
  serverVersion = '1.0.0',
  serverName = 'nexus-context',
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
  closeCtxOnEnd = true,
  maxLineBytes = 10 * 1024 * 1024
} = {}) {
  const server = createMcpServer({
    ctx,
    allowDirectActive,
    serverVersion,
    serverName,
    stderr
  });

  let buffer = '';
  let droppingOversizeLine = false;
  let closed = false;
  let finishing = false;
  let queue = Promise.resolve();

  function writeLine(payload) {
    if (!closed && payload !== null) {
      output.write(`${JSON.stringify(payload)}\n`);
    }
  }

  async function processLine(rawLine) {
    const trimmed = rawLine.replace(/\r$/, '').trim();
    if (!trimmed) {
      return;
    }
    if (Buffer.byteLength(trimmed, 'utf8') > maxLineBytes) {
      writeLine(
        makeErrorResponse(
          null,
          JSON_RPC_ERRORS.INVALID_REQUEST,
          `Mensagem excede o limite máximo de ${maxLineBytes} bytes.`
        )
      );
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      debugLog(stderr, `JSON inválido recebido: ${err.message}`);
      writeLine(makeErrorResponse(null, JSON_RPC_ERRORS.PARSE_ERROR, 'JSON inválido na entrada stdio.'));
      return;
    }
    const response = await server.handleMessage(parsed);
    writeLine(response);
  }

  function enqueueLine(line) {
    queue = queue.then(() => processLine(line)).catch((err) => {
      debugLog(stderr, `Falha não tratada no processamento stdio: ${err?.message ?? err}`);
    });
  }

  function onData(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (droppingOversizeLine) {
      const nl = text.indexOf('\n');
      if (nl === -1) return;
      droppingOversizeLine = false;
      buffer = text.slice(nl + 1);
    } else {
      buffer += text;
    }
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      enqueueLine(line);
    }
    if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
      buffer = '';
      droppingOversizeLine = true;
      writeLine(
        makeErrorResponse(
          null,
          JSON_RPC_ERRORS.INVALID_REQUEST,
          `Mensagem excede o limite máximo de ${maxLineBytes} bytes.`
        )
      );
    }
  }

  const done = new Promise((resolve) => {
    function finish() {
      if (finishing || closed) return;
      finishing = true;
      if (buffer.trim().length > 0) {
        const trailing = buffer;
        buffer = '';
        enqueueLine(trailing);
      }
      queue.finally(() => {
        closed = true;
        input.off('data', onData);
        input.off('end', finish);
        input.off('close', finish);
        if (closeCtxOnEnd && typeof ctx.close === 'function') {
          try {
            ctx.close();
          } catch (err) {
            debugLog(stderr, `Erro ao fechar ctx: ${err?.message ?? err}`);
          }
        }
        resolve();
      });
    }

    if (typeof input.setEncoding === 'function') {
      input.setEncoding('utf8');
    }
    input.on('data', onData);
    input.on('end', finish);
    input.on('close', finish);
  });

  return {
    server,
    done,
    stop() {
      if (!closed) {
        closed = true;
        input.off('data', onData);
        if (closeCtxOnEnd && typeof ctx.close === 'function') {
          ctx.close();
        }
      }
    }
  };
}
