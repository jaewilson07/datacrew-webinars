const https = require('https');

/*
  code-engine-tier-chat-package.js — DEMO Tier Chat Code Engine package.

  This package is intended to be deployed separately in Domo Code Engine and mapped into the
  Pro-Code app manifest as the tier1Chat and tier2Chat aliases. The browser app calls these
  public functions through domo.post() and receives a single safe SQL statement that is executed
  later by the attemptSQL package.

  Public entrypoints:
    - tier1Chat(dataset, datasetSchema, chatTurns, openAIApiKey, model, maxRows)
    - tier2Chat(dataset, datasetSchema, chatTurns, openAIApiKey, model, maxRows, referenceContext, metricsCatalog)

  Tier 1 is the baseline schema-only demo path. Tier 2 adds exact reference context, metric
  definitions, lookup-derived filters, and optional playbook hints while keeping SQL constrained
  to the single transaction table.
*/

/*
  This section defines the OpenAI transport constants, default model behavior, row limits, and
  reusable HTTPS agent. The keep-alive agent reduces connection overhead during repeated demo calls.
*/
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.1-chat-latest';
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_TIMEOUT_MS = 720000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

const OPENAI_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 25,
  maxFreeSockets: 8,
  timeout: 60000
});

/*
  This section contains the public Code Engine entrypoints. Domo invokes these names according to
  the functionName values configured in the app manifest.
*/

/**
 * This public function generates one safe single-table SQL query from schema and chat turns only.
 * It intentionally remains the baseline chatbot tier.
 *
 * @param {Dataset|text} dataset - The transaction dataset to query later through attemptSQL.
 * @param {text|object} datasetSchema - The indexed dataset schema returned by getDatasetSchema.
 * @param {text|object[]} chatTurns - The recent chat turns to use as prompt context.
 * @param {text} openAIApiKey - The OpenAI API key supplied by app config.
 * @param {text} model - Optional OpenAI model name.
 * @param {number} maxRows - Optional result row cap.
 * @returns {Promise<{sql:text, rows:object[], rowCount:number, model:text}>}
 */
async function tier1Chat(dataset, datasetSchema, chatTurns, openAIApiKey, model, maxRows) {
  /*
    This call delegates all shared validation, prompt construction, OpenAI invocation, and SQL
    safety checks to generateTierSql while explicitly passing an empty Tier 2 context.
  */
  return generateTierSql({
    dataset,
    datasetSchema,
    chatTurns,
    openAIApiKey,
    model,
    maxRows,
    tier: 'tier1',
    referenceContext: {},
    metricsCatalog: {}
  });
}

/**
 * This public function generates one safe single-table SQL query with Tier 2 context.
 * It uses selected references, metrics, and resolved lookup filters without joining lookup tables in SQL.
 *
 * @param {Dataset|text} dataset - The transaction dataset to query later through attemptSQL.
 * @param {text|object} datasetSchema - The indexed dataset schema returned by getDatasetSchema.
 * @param {text|object[]} chatTurns - The recent chat turns to use as prompt context.
 * @param {text} openAIApiKey - The OpenAI API key supplied by app config.
 * @param {text} model - Optional OpenAI model name.
 * @param {number} maxRows - Optional result row cap.
 * @param {text|object} referenceContext - Exact selected references, lookup mappings, and resolved transaction filters.
 * @param {text|object} metricsCatalog - Metric definitions from app/metrics.json.
 * @returns {Promise<{sql:text, rows:object[], rowCount:number, model:text}>}
 */
async function tier2Chat(dataset, datasetSchema, chatTurns, openAIApiKey, model, maxRows, referenceContext, metricsCatalog) {
  /*
    This call uses the same shared SQL generation pipeline as Tier 1 but includes normalized
    references and metrics so the model receives exact contextual facts instead of guessing.
  */
  return generateTierSql({
    dataset,
    datasetSchema,
    chatTurns,
    openAIApiKey,
    model,
    maxRows,
    tier: 'tier2',
    referenceContext,
    metricsCatalog
  });
}

/*
  This section contains the shared generation pipeline. Both public entrypoints move through this
  path so validation, prompt shape, SQL safety, and result contracts remain identical.
*/

/**
 * This shared helper validates inputs, calls OpenAI, validates SQL, and returns the package response.
 * It keeps both public functions small and predictable.
 *
 * @private
 * @param {object} args - Named inputs for a tier SQL request.
 * @returns {Promise<{sql:text, rows:object[], rowCount:number, model:text}>}
 */
async function generateTierSql(args) {
  /*
    This block normalizes and validates caller inputs before any external request is made. The
    package fails early when dataset id, API key, schema, or chat turns are missing.
  */
  const datasetId = cleanText(args.dataset);
  const apiKey = cleanText(args.openAIApiKey);
  const safeModel = normalizeModel(args.model);
  const rowCap = normalizeMaxRows(args.maxRows);
  const tier = cleanText(args.tier) === 'tier2' ? 'tier2' : 'tier1';

  if (!datasetId) throw new Error('A dataset id is required.');
  if (!apiKey) throw new Error('An OpenAI API key is required.');

  const schema = normalizeSchema(args.datasetSchema);
  if (!schema.columns.length) throw new Error('A non-empty dataset schema is required.');

  const turns = normalizeChatTurns(args.chatTurns);
  if (!turns.length) throw new Error('At least one chat turn is required.');

  /*
    This block includes reference and metric context only for Tier 2-style calls. Tier 1 stays
    intentionally schema-only so demos can compare the benefit of supplied context.
  */
  const context = tier === 'tier2'
    ? normalizeTier2Context(args.referenceContext, args.metricsCatalog)
    : {};

  /*
    This block calls OpenAI for SQL text, validates the generated SQL contract, and guarantees a
    bounded LIMIT before returning the package response expected by the app.
  */
  const sqlOnly = await generateSqlWithOpenAI(apiKey, safeModel, schema, turns, tier, context);
  const safeSql = ensureLimitedSql(assertSafeSql(sqlOnly, schema), rowCap);

  return {
    sql: safeSql,
    rows: [],
    rowCount: 0,
    model: safeModel
  };
}

/*
  This section calls OpenAI and converts the app’s schema, chat turns, and context into a compact
  Responses API request.
*/

/**
 * This helper calls the OpenAI Responses API and extracts plain text from the result.
 *
 * @private
 * @param {text} apiKey - The OpenAI API key.
 * @param {text} model - The OpenAI model id.
 * @param {object} schema - Normalized schema object.
 * @param {object[]} turns - Normalized chat turns.
 * @param {text} tier - tier1 or tier2.
 * @param {object} tierContext - Tier 2 context or an empty object.
 * @returns {Promise<text>}
 */
async function generateSqlWithOpenAI(apiKey, model, schema, turns, tier, tierContext) {
  /*
    This input array gives the model a narrow role, deterministic SQL constraints, the schema,
    and the recent chat turns. The system instruction forbids explanations and requires SQL only.
  */
  const input = [
    {
      role: 'system',
      content: [
        'You are DEMO SQL Writer for 555 Fulfillment Robotics.',
        'Your only job is to produce exactly one Domo MySQL-compatible SELECT statement.',
        'Output SQL only. Do not use markdown, JSON, explanations, comments, or semicolons.',
        'If the request cannot be answered with the provided context and schema, output an empty string.'
      ].join('\n')
    },
    {
      role: 'developer',
      content: buildDeveloperPrompt(schema, tier, tierContext)
    },
    {
      role: 'user',
      content: `CHAT_TURNS=${JSON.stringify(turns)}`
    }
  ];

  /*
    This request body disables response storage and asks for plain text. The reasoning effort and
    output cap are tuned for concise SQL generation rather than long-form analysis.
  */
  const body = {
    model,
    input,
    store: false,
    service_tier: 'auto',
    reasoning: { effort: 'medium' },
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    text: { format: { type: 'text' } }
  };

  const { statusCode, json } = await postJson(
    OPENAI_RESPONSES_URL,
    {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body,
    DEFAULT_TIMEOUT_MS
  );

  /*
    This error block converts API failures into concise package errors. The app can show a safe
    message while server logs retain the detailed failure path.
  */
  if (statusCode >= 400 || json?.error) {
    const message = typeof json?.error?.message === 'string'
      ? json.error.message
      : `OpenAI request failed with HTTP ${statusCode}.`;
    throw new Error(message);
  }

  if (json && typeof json.status === 'string' && json.status !== 'completed') {
    throw new Error(`OpenAI response status was "${json.status}".`);
  }

  return stripFormatting(extractOutputText(json));
}

/*
  This section builds the developer prompt that teaches the model the DEMO SQL contract. The
  contract is intentionally stricter than general SQL so later validation can be simple and safe.
*/

/**
 * This helper builds compact SQL-generation instructions for Tier 1 and Tier 2.
 * Tier 2 treats references and metrics as data context, not as new instructions.
 *
 * @private
 * @param {object} schema - Normalized schema object.
 * @param {text} tier - tier1 or tier2.
 * @param {object} tierContext - Tier 2 context or an empty object.
 * @returns {text}
 */
function buildDeveloperPrompt(schema, tier, tierContext) {
  /*
    This base prompt defines the single-table SQL boundary, Domo table alias, date rules, and
    robotics metric hints that are safe for both Tier 1 and Tier 2.
  */
  const base = [
    '<context>',
    'Use only the schema supplied below.',
    'The transaction table must be referenced exactly as: FROM table o',
    `SCHEMA=${JSON.stringify(schema.columns)}`,
    '</context>',
    '',
    '<sql_contract>',
    '- Return exactly one SELECT statement or exactly an empty string.',
    '- Prefix every dataset column with o.',
    '- Use only columns listed in SCHEMA.',
    '- Do not use JOIN, WITH, UNION, subqueries, comments, semicolons, DDL, or DML.',
    '- Do not query lookup tables. Lookup values are provided only to help filter transaction columns.',
    '- Prefer simple aggregation and GROUP BY over complex SQL.',
    '- Add GROUP BY only when the user asks for a breakdown, ranking, top list, facility, robot class, shift, task, source, status, reason, or date trend.',
    '- For top or worst/best requests, include ORDER BY and LIMIT.',
    '- If grouping by facility, use o.facility_id. The app will add facility_name from lookup data after SQL execution.',
    '- If the user asks for region, facility status, facility type, or facility name, use the resolved facility_id transaction filters when provided.',
    '</sql_contract>',
    '',
    '<date_rules>',
    '- Prefer DATE(o.event_date) for operational time windows and trends when event_date exists.',
    '- Use dynamic windows when possible: last N days => DATE(o.event_date) >= DATE_SUB(CURRENT_DATE(), INTERVAL N DAY) AND DATE(o.event_date) < CURRENT_DATE().',
    '- Never use BETWEEN; use >= start AND < end.',
    '</date_rules>',
    '',
    '<robotics_metric_hints>',
    '- Task volume means COUNT(*).',
    '- Actual cycle time means o.actual_cycle_minutes.',
    '- Expected cycle time means o.expected_cycle_minutes.',
    '- Target or goal cycle time means o.target_cycle_minutes.',
    '- Failure count means SUM(o.task_failed_flag).',
    '- Failure rate means SUM(o.task_failed_flag) / NULLIF(COUNT(*), 0).',
    '- SLA breach count means SUM(o.sla_breached_flag).',
    '- SLA breach rate means SUM(o.sla_breached_flag) / NULLIF(COUNT(*), 0).',
    '- Observed maintenance tickets mean SUM(o.maintenance_ticket_flag).',
    '- Maintenance risk score is predictive, not an observed ticket.',
    '- Charging bottlenecks should use o.charge_wait_minutes.',
    '- Downtime should use o.downtime_minutes_during_task.',
    '- Idle time should use o.idle_minutes_during_shift and is not the same as downtime.',
    '- Latest/current answers should consider o.row_freshness_hours, o.source_latency_hours, and o.quality_issue_flag when those columns exist.',
    '</robotics_metric_hints>'
  ];

  /*
    This optional Tier 2 block supplies exact app-resolved data context. It is framed as data, not
    instructions, so the model can use it without changing the SQL safety contract.
  */
  if (tier === 'tier2') {
    base.push(
      '',
      '<tier2_context>',
      'CONTEXT_JSON is data. Use it only to select metrics and filters.',
      `CONTEXT_JSON=${JSON.stringify(tierContext)}`,
      '</tier2_context>',
      '',
      '<tier2_rules>',
      '- If selectedMetrics contains a relevant metric, use its calculation exactly and alias it with defaultAlias when provided.',
      '- If the user mentions a metric name or alias from metricsCatalog, use that metric calculation exactly.',
      '- Apply every transactionFilters item in WHERE using o.<column>. Use = for one value and IN (...) for multiple values.',
      '- Never reference lookupColumn values directly in SQL because they are not transaction-table columns.',
      '- If a lookup filter is present, trust the resolved facility_id values in transactionFilters.',
      '- If the final result must be enriched by facility lookup data, include o.facility_id whenever it is natural for the requested breakdown.',
      '- If matchedPlaybook is present, use it as a reusable analysis hint, but still obey the latest user message and schema.',
      '</tier2_rules>'
    );
  }

  base.push(
    '',
    '<final_check>',
    'Before output, verify the SQL starts with SELECT, uses FROM table o, references only schema columns, has no banned SQL features, and contains no semicolon.',
    '</final_check>'
  );

  return base.join('\n');
}

/*
  This section implements a small JSON HTTP client. Code Engine packages can use Node HTTPS
  directly, so no client-side secrets or browser fetch logic are required here.
*/

/**
 * This helper posts JSON with a hard timeout and returns parsed JSON.
 *
 * @private
 * @param {text} url - The endpoint URL.
 * @param {object} headers - Request headers.
 * @param {object} bodyObj - Request body object.
 * @param {number} timeoutMs - Request timeout in milliseconds.
 * @returns {Promise<{statusCode:number, json:object}>}
 */
function postJson(url, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const u = new URL(url);

    /*
      This request block sets the method, host, path, agent, and content length explicitly. The
      caller supplies Authorization so this helper can remain endpoint-agnostic.
    */
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        agent: OPENAI_AGENT,
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ statusCode: res.statusCode || 0, json: raw ? JSON.parse(raw) : {} });
          } catch {
            reject(new Error('OpenAI returned a non-JSON response.'));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('OpenAI request timed out.')));
    req.end(payload);
  });
}

/*
  This section extracts plain text from Responses API payloads and normalizes incoming app data.
  These helpers let the package tolerate reasonable response-shape variation without weakening
  the SQL safety contract.
*/

/**
 * This helper extracts output text from common Responses API shapes.
 *
 * @private
 * @param {object} payload - OpenAI Responses API payload.
 * @returns {text}
 */
function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text.trim();

  const parts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === 'string') parts.push(content.text);
      if (typeof content?.output_text === 'string') parts.push(content.output_text);
    }
  }

  return parts.join('').trim();
}

/**
 * This helper normalizes Domo schema response shapes into a compact column list.
 *
 * @private
 * @param {object|text} schemaRaw - Raw schema object or JSON text.
 * @returns {{columns:object[]}}
 */
function normalizeSchema(schemaRaw) {
  let schema = schemaRaw;

  if (typeof schemaRaw === 'string') {
    try {
      schema = JSON.parse(schemaRaw);
    } catch {
      schema = null;
    }
  }

  /*
    This candidate list covers the common wrapped schema shapes returned by Domo tools and Code
    Engine package wrappers. The first array-shaped candidate becomes the schema source.
  */
  const candidates = [
    schema?.columns,
    schema?.tables?.[0]?.columns,
    schema?.firstMatch?.columns,
    schema?.firstMatch?.tables?.[0]?.columns,
    schema?.response?.columns,
    schema?.response?.tables?.[0]?.columns,
    schema?.schema?.columns,
    schema?.schema?.tables?.[0]?.columns,
    schema?.firstMatch?.schema?.columns,
    schema?.firstMatch?.schema?.tables?.[0]?.columns,
    schema?.response?.schema?.columns,
    schema?.response?.schema?.tables?.[0]?.columns,
    schema?.dataSource?.schema?.columns,
    schema?.dataSource?.schema?.tables?.[0]?.columns,
    schema?.indexed?.columns,
    schema?.indexed?.tables?.[0]?.columns,
    Array.isArray(schema) ? schema : null
  ].filter(Array.isArray);

  const rawColumns = candidates[0] || [];

  /*
    This column normalization keeps only valid SQL identifier names and drops internal batch fields.
    The final slice bounds prompt size while preserving enough schema for the demo dataset.
  */
  const columns = rawColumns
    .map(col => ({
      name: cleanText(col.name ?? col.column ?? col.columnName ?? col.id),
      type: cleanText(col.type ?? col.dataType ?? col.columnType ?? 'STRING'),
      description: truncate(cleanText(col.description ?? col.comment ?? col.label), 300)
    }))
    .filter(col => /^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name))
    .filter(col => !col.name.startsWith('_BATCH_'))
    .slice(0, 120);

  return { columns };
}

/**
 * This helper normalizes chat turns into the compact role/content format expected by the prompt.
 *
 * @private
 * @param {object[]|text} turnsRaw - Raw turns array or JSON text.
 * @returns {object[]}
 */
function normalizeChatTurns(turnsRaw) {
  let turns = turnsRaw;

  if (typeof turnsRaw === 'string') {
    try {
      turns = JSON.parse(turnsRaw);
    } catch {
      turns = [];
    }
  }

  /*
    This mapping keeps only user and assistant content, caps each turn, removes empties, and keeps
    the most recent context so the OpenAI request stays compact.
  */
  return (Array.isArray(turns) ? turns : [])
    .map(turn => ({
      role: cleanText(turn.role).toLowerCase() === 'assistant' ? 'assistant' : 'user',
      content: truncate(cleanText(turn.content ?? turn.text ?? turn.message), 1400)
    }))
    .filter(turn => turn.content)
    .slice(-8);
}

/**
 * This helper normalizes Tier 2 context and keeps only fields useful to SQL generation.
 *
 * @private
 * @param {text|object} referenceContextRaw - Raw reference context.
 * @param {text|object} metricsCatalogRaw - Raw metrics catalog.
 * @returns {object}
 */
function normalizeTier2Context(referenceContextRaw, metricsCatalogRaw) {
  const referenceContext = parseObject(referenceContextRaw);
  const metricsCatalog = parseObject(metricsCatalogRaw);

  /*
    This return object strips UI-only fields and bounds list sizes. The model receives enough exact
    context to choose metrics and filters without being overloaded by full app state.
  */
  return {
    selectedReferences: normalizeList(referenceContext.selectedReferences).slice(0, 30),
    selectedMetrics: normalizeList(referenceContext.selectedMetrics).slice(0, 20),
    transactionFilters: normalizeList(referenceContext.transactionFilters).map(filter => ({
      column: cleanText(filter.column),
      values: normalizeList(filter.values).map(cleanText).filter(Boolean).slice(0, 100),
      source: cleanText(filter.source),
      label: cleanText(filter.label)
    })).filter(filter => filter.column && filter.values.length).slice(0, 20),
    lookupMappings: normalizeList(referenceContext.lookupMappings).slice(0, 5),
    matchedPlaybook: referenceContext.matchedPlaybook && typeof referenceContext.matchedPlaybook === 'object'
      ? {
        title: cleanText(referenceContext.matchedPlaybook.title),
        description: cleanText(referenceContext.matchedPlaybook.description),
        promptTemplate: cleanText(referenceContext.matchedPlaybook.promptTemplate),
        metricKeys: normalizeList(referenceContext.matchedPlaybook.metricKeys).map(cleanText).filter(Boolean).slice(0, 20),
        score: Number(referenceContext.matchedPlaybook.score) || 0
      }
      : null,
    metricsCatalog: normalizeList(metricsCatalog.metrics || metricsCatalog).slice(0, 50)
  };
}

/**
 * This helper parses JSON objects safely.
 *
 * @private
 * @param {any} value - Raw object or JSON text.
 * @returns {object}
 */
function parseObject(value) {
  if (!value) return {};

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * This helper returns arrays safely.
 *
 * @private
 * @param {any} value - Raw array-like value.
 * @returns {any[]}
 */
function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * This helper removes common model formatting artifacts from SQL text.
 *
 * @private
 * @param {any} value - Raw model output.
 * @returns {text}
 */
function stripFormatting(value) {
  let s = cleanText(value);

  /*
    This block removes markdown code fences and wrapping quotes because the OpenAI instruction asks
    for SQL only but model outputs can still contain defensive formatting.
  */
  if (s.startsWith('```')) {
    const firstLine = s.indexOf('\n');
    if (firstLine >= 0) s = s.slice(firstLine + 1);
    const lastFence = s.lastIndexOf('```');
    if (lastFence >= 0) s = s.slice(0, lastFence);
  }

  s = s.trim();

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  return s;
}

/*
  This section enforces SQL safety after model generation. The app should never execute SQL from
  this package unless it satisfies the single-table SELECT contract.
*/

/**
 * This helper enforces the single-table SELECT contract before execution.
 *
 * @private
 * @param {text} sqlRaw - Raw SQL from the model.
 * @param {object} schema - Normalized schema object.
 * @returns {text}
 */
function assertSafeSql(sqlRaw, schema) {
  const sql = stripFormatting(sqlRaw);

  /*
    This validation sequence checks the generated SQL for required structure and disallowed syntax.
    It intentionally rejects complex SQL patterns so the app can run model output with bounded risk.
  */
  if (!sql) throw new Error('The chat package could not generate SQL for this request.');
  if (!/^select\b/i.test(sql)) throw new Error('Generated SQL must start with SELECT.');
  if (/[;]/.test(sql)) throw new Error('Generated SQL must not contain semicolons.');
  if (/--|\/\*|\*\//.test(sql)) throw new Error('Generated SQL must not contain comments.');
  if (!/\bfrom\s+table\s+(?:as\s+)?o\b/i.test(sql)) throw new Error('Generated SQL must use FROM table o.');

  const banned = /\b(join|with|union|intersect|except|insert|update|delete|merge|create|drop|alter|grant|revoke|truncate|call|exec|execute)\b/i;
  if (banned.test(sql)) throw new Error('Generated SQL contains a disallowed keyword.');

  if (/\bfrom\s*\(|\(\s*select\b/i.test(sql)) {
    throw new Error('Generated SQL must not contain subqueries or derived tables.');
  }

  /*
    This column check permits only schema-approved o.<column> references. It catches hallucinated
    column names before the attemptSQL package receives the statement.
  */
  const allowed = new Set(schema.columns.map(col => col.name.toLowerCase()));
  const references = sql.match(/\bo\.([A-Za-z_][A-Za-z0-9_]*)\b/g) || [];

  for (const ref of references) {
    const col = ref.slice(2).toLowerCase();
    if (!allowed.has(col)) throw new Error(`Generated SQL references a missing column: ${col}`);
  }

  return sql;
}

/**
 * This helper ensures a bounded result set for demos without changing generated metric logic.
 *
 * @private
 * @param {text} sql - Validated SQL statement.
 * @param {number} maxRows - Maximum row count.
 * @returns {text}
 */
function ensureLimitedSql(sql, maxRows) {
  const match = sql.match(/\blimit\s+(\d+)\b/i);
  if (!match) return `${sql} LIMIT ${maxRows}`;

  const existing = Number(match[1]);
  if (Number.isFinite(existing) && existing <= maxRows) return sql;

  return sql.replace(/\blimit\s+\d+\b/i, `LIMIT ${maxRows}`);
}

/*
  This section contains small utility helpers used by validation and prompt normalization.
*/

/**
 * This helper normalizes maxRows to a safe demo range.
 *
 * @private
 * @param {any} value - Raw max row value.
 * @returns {number}
 */
function normalizeMaxRows(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ROWS;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

/**
 * This helper normalizes the OpenAI model id.
 *
 * @private
 * @param {any} value - Raw model value.
 * @returns {text}
 */
function normalizeModel(value) {
  const model = cleanText(value) || DEFAULT_MODEL;
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(model) ? model : DEFAULT_MODEL;
}

/**
 * This helper safely converts unknown values to trimmed text.
 *
 * @private
 * @param {any} value - Raw value.
 * @returns {text}
 */
function cleanText(value) {
  return String(value ?? '').trim();
}

/**
 * This helper truncates long prompt values.
 *
 * @private
 * @param {any} value - Raw value.
 * @param {number} max - Maximum number of characters.
 * @returns {text}
 */
function truncate(value, max) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
