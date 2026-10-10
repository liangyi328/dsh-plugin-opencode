/**
 * OpenCode LLM adapter: tunnels DSH chat requests through the local OpenCode
 * background service's session API.
 *
 * Why a session bridge (rather than the OpenAI-compatible Zen endpoint): the
 * free tier is gated on client identity server-side, and only OpenCode clients
 * pass the gate. The background service is such a client, so every request is
 * admitted anonymously through it while DSH keeps its normal streaming
 * surface.
 *
 * Protocol mapping:
 *   - the whole DSH message list is flattened into ONE user prompt (the bridge
 *     session is single-turn; system prompt, history, and tool results are all
 *     serialized into the text);
 *   - tool schemas are listed in the prompt as guidance, and any tool call the
 *     model emits as text is passed through untouched — the model answers with
 *     prose, so DSH's tool loop still works via the model describing actions;
 *   - the reply is streamed as text deltas by polling `GET .../message` and
 *     diffing the assistant message's text content.
 *
 * This module imports nothing from the host: a plugin loaded by absolute path
 * resolves its bare specifiers from its own directory, and the runtime couples
 * to adapters by duck typing. Failures are reported as terminal `finish`
 * chunks carrying a stable code, which the runtime accepts in place of a
 * thrown error.
 */
import { OpenCodeServiceError } from './service.js';

/** A failure with a stable, runtime-routable code. */
export class OpenCodeError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'OpenCodeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// The Zen catalogue exposes reasoning levels as model variants (verified
// against the installed CLI: `{"id":"low","settings":{"reasoningEffort":"low"}}`),
// and the session API addresses one as `modelID/variantID`. These zh labels
// mirror the WorkBuddy adapter so both pickers read the same.
const EFFORT_LABELS = {
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

/** The reasoning view of one model's variants, or undefined when it has none. */
export function reasoningOf(model) {
  const variants = Array.isArray(model?.variants) ? model.variants.filter(Boolean) : [];
  if (variants.length === 0) return undefined;
  // OpenCode declares no default variant: picking "提供商默认" sends the bare
  // model id, and the provider's own default effort stands.
  return { efforts: variants.map((id) => ({ id, name: EFFORT_LABELS[id] ?? id })) };
}

/**
 * The session-model id that carries one model with an optional effort.
 *
 * A variant travels on the wire as `modelID/variantID` (verified live:
 * setting `space-bunny-free/high` echoes back in `session.model.id`), so an
 * effort the model offers maps to that spelling and everything else — no
 * effort, an unknown id — falls back to the bare id.
 */
export function modelIdWithEffort(model, effort) {
  const base = typeof model?.id === 'string' && model.id.length > 0 ? model.id : undefined;
  if (base === undefined) return undefined;
  if (typeof effort !== 'string' || effort.length === 0) return base;
  const variants = Array.isArray(model?.variants) ? model.variants : [];
  return variants.includes(effort) ? `${base}/${effort}` : base;
}

/** Join the text blocks of one message. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** Render one message's non-text blocks into a readable prose note. */
function extrasOf(message) {
  const notes = [];
  for (const block of message.content ?? []) {
    if (block?.type === 'file') {
      const label = block.file?.name ?? block.file?.attachmentId ?? 'file';
      notes.push(`[attached file ${label}]`);
    } else if (block?.type === 'image') {
      notes.push('[image attached — not transmitted through the OpenCode bridge]');
    } else if (block?.type === 'tool-call') {
      // A previous turn's call must survive the flattening: without it the
      // model sees a tool result with no matching request and cannot reason
      // about what already happened.
      notes.push(`[called tool ${block.name ?? 'unknown'} with ${block.arguments ?? '{}'}]`);
    }
  }
  return notes;
}

/**
 * Flatten the DSH conversation into one prompt string.
 *
 * A single user turn passes through verbatim; anything richer is labeled so
 * the model can tell the turns apart. The system prompt leads as an
 * instruction block, which is how single-turn bridges preserve behavior.
 */
export function buildPrompt(options) {
  const lines = [];
  const system = typeof options.system === 'string' ? options.system : '';
  const history = Array.isArray(options.messages) ? options.messages : [];

  const userTurns = history.filter((m) => m?.role === 'user');
  const simple = system.length === 0
    && userTurns.length === history.length
    && userTurns.length === 1
    && (userTurns[0].content ?? []).every((b) => b?.type === 'text');
  if (simple) return textOf(userTurns[0].content);

  if (system.length > 0) {
    lines.push('<instructions>', system.trim(), '</instructions>', '');
  }
  for (const message of history) {
    if (message === null || typeof message !== 'object') continue;
    const text = textOf(message.content);
    const extras = extrasOf(message);
    if (message.role === 'user') {
      lines.push('<user>', text.length > 0 ? text : extras.join('\n'), '</user>', '');
    } else if (message.role === 'assistant') {
      const notes = extras.join('\n');
      lines.push('<assistant>', notes.length > 0 ? `${text}\n${notes}` : text, '</assistant>', '');
    } else if (message.role === 'tool') {
      lines.push(`<tool_result${message.isError === true ? ' error="true"' : ''}>`, text, '</tool_result>', '');
    } else if ((message.role === 'system' || message.role === 'developer') && text.length > 0) {
      lines.push('<system>', text, '</system>', '');
    }
  }
  // "next message only" is what a chat model reads as "one turn, then stop",
  // so the closing line instead keeps the tool loop open: act now, or ask for
  // the next tool, rather than describing what will be done later.
  lines.push(
    'Continue the conversation above as the assistant. If any work remains, request the tools',
    'to perform it now using the JSON call format instead of describing what you will do.',
  );
  return lines.join('\n');
}

/**
 * Render the tool catalog into prompt guidance.
 *
 * The bridge has no native tool-call channel: opencode's session API runs its
 * own agent with its own tools and never sees the caller's. So the model is
 * asked to express a call as one line of JSON, which `parseToolCalls` below
 * lifts back out of the reply and re-emits as a real runtime tool-call block.
 * Without this, DSH receives a text-only turn, concludes the model asked for
 * nothing, and ends the turn — the model appears to "just answer" and never
 * acts, even when the user asked it to install something.
 */
export function toolGuidance(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const rows = tools.map((tool) => {
    const params = JSON.stringify(tool.parameters ?? { type: 'object', properties: {} });
    return `- ${tool.name}: ${tool.description ?? ''} (JSON schema: ${params})`;
  });
  return [
    '',
    '<available_tools>',
    'You have real tools. They are executed by the harness when you request them.',
    'To request one, emit a JSON object on its own line and nothing else on that line:',
    '{"tool": "<name>", "arguments": { ... }}',
    '',
    'Rules:',
    '- NEVER write that you will do something. Request it with a JSON call instead.',
    '- Emit the call as soon as you know which tool you need; you may emit one call per line.',
    '- Do not wrap the JSON in prose on the same line; other text is fine on other lines.',
    '- After the harness runs the tool you will get the result as the next user message; then continue.',
    '',
    'Available tools:',
    ...rows,
    '</available_tools>',
    '',
  ].join('\n');
}

/**
 * Every balanced `{...}` span in `text`, outermost first.
 *
 * A hand-rolled scan rather than a regex: tool arguments nest arbitrarily and
 * may contain braces inside strings, which no practical regex handles.
 *
 * Both quote forms are honoured because models emit single-quoted JSON too.
 * An escaped character inside a string is consumed as one unit, so a path like
 * `C:\dir\"x` cannot confuse the quote or brace accounting.
 */
export function scanJsonObjects(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push({ start, end: i + 1, raw: text.slice(start, i + 1) });
        start = -1;
      }
    }
  }
  return spans;
}

/** Every string literal in `raw`, as [start, end) offsets of its contents. */
function stringSpans(raw) {
  const out = [];
  let quote = null;
  let start = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        start = i + 1;
      }
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) {
      out.push({ start, end: i, quote });
      quote = null;
    }
  }
  return out;
}

/**
 * Repair the escape sequences models actually emit.
 *
 * A Windows path written as `"F:\agentWork\ref"` is not valid JSON: `\a`, `\r`
 * and `\d` are illegal escapes, so `JSON.parse` throws and the call is lost —
 * the user then sees the raw JSON printed back as prose, which is exactly the
 * "it just talks, nothing happens" failure. Legal escapes are preserved;
 * illegal ones degrade to the literal characters the model meant.
 */
export function repairEscapes(raw) {
  const spans = stringSpans(raw);
  if (spans.length === 0) return raw;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const body = raw.slice(span.start, span.end);
    out += raw.slice(cursor, span.start);
    let fixed = '';
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== '\\' || i + 1 >= body.length) {
        fixed += body[i];
        continue;
      }
      const next = body[i + 1];
      const after = body[i + 2];
      // A control escape (`\n`, `\r`, `\t`…) is ambiguous in a path: `F:\ref\new`
      // means the letters n-e-w, not a newline. Heuristic — an escape is a real
      // control character only when it is NOT followed by a word character
      // (i.e. it ends the segment, as in "line1\nline2" or "a\tb"→ rare). A
      // Windows path always continues with a letter or backslash, so this
      // keeps paths intact while preserving genuine newlines in prose.
      const isControl = next === 'n' || next === 'r' || next === 't' || next === 'b' || next === 'f';
      const continues = after !== undefined && /[A-Za-z0-9_\\/.$-]/.test(after);
      if (isControl && continues) {
        fixed += `\\\\${next}`;
      } else if (isControl || next === 'u' || next === '"' || next === '\\' || next === '/') {
        fixed += `\\${next}`;
      } else {
        // Not a JSON escape at all (e.g. the `\a` of `F:\agentWork`): emit a
        // doubled backslash and KEEP the character, so the path survives.
        fixed += `\\\\${next}`;
      }
      i += 1;
    }
    out += fixed;
    cursor = span.end;
  }
  out += raw.slice(cursor);
  return out;
}

/**
 * Parse one candidate call, tolerating the JSON dialects models emit.
 *
 * Strict JSON first; on failure the escape repair runs, then single quotes are
 * rewritten to double quotes (a repair that only applies outside string
 * bodies, so a quoted apostrophe is never mangled).
 */
export function parseLenient(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to the repairs */
  }
  const fixedEscapes = repairEscapes(raw);
  try {
    return JSON.parse(fixedEscapes);
  } catch {
    /* fall through to the quote rewrite */
  }
  if (!fixedEscapes.includes("'")) return undefined;
  const spans = stringSpans(fixedEscapes);
  let rewritten = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.quote !== "'") continue;
    const body = fixedEscapes.slice(span.start, span.end);
    rewritten += fixedEscapes.slice(cursor, span.start - 1);
    rewritten += `"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`;
    cursor = span.end + 1;
  }
  rewritten += fixedEscapes.slice(cursor);
  try {
    return JSON.parse(rewritten);
  } catch {
    return undefined;
  }
}

/** The tool name a parsed call declares, across the spellings models use. */
function toolNameOf(value) {
  for (const candidate of [value?.tool, value?.name, value?.tool_name, value?.function?.name]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** The arguments of a parsed call, normalized to a JSON string. */
function argumentsOf(value) {
  const args = value?.arguments ?? value?.args ?? value?.parameters ?? value?.input;
  if (typeof args === 'string') return args;
  if (args !== undefined && args !== null) {
    try {
      return JSON.stringify(args);
    } catch {
      /* fall through to the empty object */
    }
  }
  return '{}';
}

/**
 * Resolve a declared tool name against the offered catalog.
 *
 * An exact match wins; otherwise a case-insensitive match rewrites it to the
 * real name. Unmatched names are dropped rather than forwarded, so a
 * hallucinated tool never reaches the runtime and fails the turn — the text
 * stays in the reply instead and the model can recover on the next turn.
 */
function resolveToolName(name, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return name;
  const exact = tools.find((tool) => tool?.name === name);
  if (exact !== undefined) return name;
  // Punctuation-insensitive so "read_file"/"readFile"/"read-file" all land on
  // "read_file" instead of being discarded as a hallucination.
  const squash = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = squash(name);
  const loose = tools.find((tool) => typeof tool?.name === 'string' && squash(tool.name) === wanted);
  return loose === undefined ? undefined : loose.name;
}

/**
 * Split a reply into its prose and the tool calls it requested.
 *
 * `prose` is the reply with every call span excised, so the user still reads
 * the model's explanation; `calls` are what the runtime should execute.
 */
export function parseToolCalls(text, tools) {
  const calls = [];
  const taken = [];
  for (const span of scanJsonObjects(text)) {
    const value = parseLenient(span.raw);
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const declared = toolNameOf(value);
    if (declared === undefined) continue;
    const name = resolveToolName(declared, tools);
    if (name === undefined) continue;
    calls.push({ name, arguments: argumentsOf(value) });
    taken.push(span);
  }
  // Excise by offset, not by string match: two identical calls would otherwise
  // both be removed by one `replace`, and a stray copy of the same JSON in the
  // prose would be deleted even though it was never a call.
  let prose = '';
  let cursor = 0;
  for (const span of taken) {
    prose += text.slice(cursor, span.start);
    cursor = span.end;
  }
  prose += text.slice(cursor);
  // Leftover scaffolding from a fenced or comma-separated emission reads as
  // noise once the call itself is gone.
  prose = prose
    .replace(/```(?:json)?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { prose, calls };
}

function mapFailureCode(error) {
  if (error instanceof OpenCodeServiceError) {
    if (error.code === 'TIMEOUT') return 'TIMEOUT';
    if (error.code === 'SERVICE_UNREACHABLE') return 'NO_ADAPTER';
    if (error.code === 'AUTH') return 'AUTH';
    return 'TRANSPORT';
  }
  return 'UNKNOWN';
}

export class OpenCodeAdapter {
  /**
   * @param options.provider - the registered route id.
   * @param options.displayName - picker group heading.
   * @param options.getCatalog - () => {models} catalog snapshot.
   * @param options.connect - async () => OpenCodeService (re-read per call).
   * @param options.agent - the opencode agent sessions run as.
   * @param options.pollIntervalMs - reply polling cadence.
   * @param options.pollTimeoutMs - max wait for a reply.
   * @param options.defaultContextWindow / defaultMaxTokens - fallbacks.
   * @param options.debugLog - diagnostics sink.
   */
  constructor(options) {
    this.options = options;
    this.provider = options.provider;
  }

  providerInfo(provider) {
    return { id: provider, name: this.options.displayName };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  async resolveImage() {
    // Images cannot traverse the bridge; the prompt notes them instead.
    return undefined;
  }

  findModel(modelId) {
    const catalog = this.options.getCatalog();
    return catalog.models.find((model) => model.id === modelId);
  }

  toModelInfo(provider, model) {
    const reasoning = reasoningOf(model);
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text'],
      ...(typeof model.context === 'number' && model.context > 0
        ? { context: { contextWindow: model.context } }
        : {}),
      ...(typeof model.output === 'number' && model.output > 0 ? { defaultMaxTokens: model.output } : {}),
      // Declaring `reasoning` here is what makes the built-in model menu offer
      // its 推理等级 picker for this model, exactly as it does for WorkBuddy.
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  listModels(provider) {
    const catalog = this.options.getCatalog();
    return Promise.resolve(catalog.models.map((model) => this.toModelInfo(provider, model)));
  }

  resolveModel(provider, model) {
    const found = this.findModel(model);
    if (found === undefined) {
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        ...(this.options.defaultContextWindow() > 0
          ? { context: { contextWindow: this.options.defaultContextWindow() } }
          : {}),
        ...(this.options.defaultMaxTokens() > 0 ? { defaultMaxTokens: this.options.defaultMaxTokens() } : {}),
      });
    }
    return Promise.resolve(this.toModelInfo(provider, found));
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  /** Every failure becomes one terminal `finish` chunk with a stable code. */
  async *stream(options) {
    try {
      yield* this.run(options);
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'UNKNOWN';
      const aborted = code === 'ABORTED' || options?.signal?.aborted === true;
      yield {
        type: 'finish',
        reason: {
          kind: aborted ? 'aborted' : 'error',
          failure: {
            message: String(error?.message ?? error),
            code: aborted ? 'ABORTED' : code,
            ...(typeof error?.status === 'number' ? { status: error.status } : {}),
          },
        },
      };
    }
  }

  async *run(options) {
    const service = await this.options.connect();
    const offeredTools = Array.isArray(options.tools) ? options.tools : [];
    // Diagnostics: the recurring "it only answers once" report cannot be
    // diagnosed from the outside, so every turn records the tool catalog the
    // runtime actually handed us and the raw reply we got back.
    this.options.debugLog?.(
      `turn: model=${options.model} tools=${offeredTools.length}`
      + ` [${offeredTools.map((t) => t?.name).join(', ')}]`
      + ` msgs=${Array.isArray(options.messages) ? options.messages.length : 0}`
      + ` lastRole=${options.messages?.[options.messages.length - 1]?.role ?? '-'}`,
    );
    const prompt = buildPrompt(options) + toolGuidance(options.tools);
    if (prompt.trim().length === 0) {
      throw new OpenCodeError('the request contains no translatable content', 'EMPTY_REQUEST');
    }

    // One fresh session per call: single-turn by construction, and a failed
    // turn can never poison the next one.
    const sessionId = await service.createSession();
    try {
      // The reasoning level selected in the model menu reaches `stream` as
      // `options.reasoningEffort` (validated by the runtime against the
      // efforts this model declares); the matching variant rides the wire as
      // `modelID/variantID`. An absent or unoffered effort sends the bare id.
      const found = this.findModel(options.model);
      const target = modelIdWithEffort(found, options.reasoningEffort) ?? options.model;
      if (target !== options.model) {
        this.options.debugLog?.(`effort: ${options.model} -> variant "${options.reasoningEffort}" (${target})`);
      }
      await service.setSessionModel(sessionId, target);
    } catch (error) {
      throw new OpenCodeError(
        `opencode: model "${options.model}" was rejected by the service: ${error?.message ?? error}`,
        mapFailureCode(error),
      );
    }
    const agent = typeof this.options.agent === 'function' ? this.options.agent() : this.options.agent;
    if (agent && agent !== 'build') {
      try {
        await service.setSessionAgent(sessionId, agent);
      } catch (error) {
        this.options.debugLog?.(`agent "${agent}" rejected, continuing as build: ${error?.message ?? error}`);
      }
    }

    const sentAt = Date.now();
    await service.sendPrompt(sessionId, prompt);

    // Poll until the newest assistant message carries a terminal finish, then
    // stream its text out in fixed slices (the API has no incremental stream).
    const pollMs = Math.max(200, typeof this.options.pollIntervalMs === 'function' ? this.options.pollIntervalMs() : this.options.pollIntervalMs);
    const timeout = typeof this.options.pollTimeoutMs === 'function' ? this.options.pollTimeoutMs() : this.options.pollTimeoutMs;
    const deadline = sentAt + Math.max(pollMs * 3, timeout);
    let assistant;
    while (Date.now() < deadline) {
      if (options.signal?.aborted === true) {
        throw new OpenCodeError('request aborted by the caller', 'ABORTED');
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let rows;
      try {
        const json = await service.listMessages(sessionId);
        rows = Array.isArray(json?.data) ? json.data : [];
      } catch (error) {
        throw new OpenCodeError(
          `opencode: polling the session failed: ${error?.message ?? error}`,
          mapFailureCode(error),
        );
      }
      const found = rows.find((row) => row?.type === 'assistant' && typeof row.finish === 'string');
      if (found !== undefined) {
        assistant = found;
        break;
      }
    }

    if (assistant === undefined) {
      // A silent no-reply is usually a queued free-tier request rather than a
      // broken one, so say that instead of a bare timeout.
      throw new OpenCodeError(
        `opencode: no reply from "${options.model}" within ${Math.round(timeout / 1000)}s. `
          + 'The free tier is likely throttled or the request is still queued; '
          + 'retry in a few minutes or choose another free model.',
        'TIMEOUT',
      );
    }
    if (assistant.finish === 'error') {
      const detail = assistant.error?.message ?? 'unknown error';
      // A quota rejection is the common case and reads very differently from a
      // broken request: without this the user sees an opaque "UPSTREAM" error
      // and reasonably concludes the plugin is broken, when in fact the free
      // tier is throttled and waiting (or another model) is the fix.
      const kind = assistant.error?.type ?? '';
      const status = assistant.error?.status;
      const throttled = kind.includes('quota')
        || status === 429
        || /rate limit|usage limit|quota/i.test(detail);
      throw new OpenCodeError(
        throttled
          ? `opencode: the free tier is rate-limited right now (${detail}). `
            + 'Wait a few minutes and retry, or pick another free model.'
          : `opencode "${options.model}" failed: ${detail}`,
        throttled ? 'RATE_LIMIT' : 'UPSTREAM',
        { status },
      );
    }

    const text = (assistant.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    // Lift tool requests back out of the reply. This is what keeps a task
    // running: the runtime only continues past a turn when it is handed a
    // tool-call block, so a reply that merely promises to act must be turned
    // into one or the task ends after the model's first message.
    const { prose, calls } = parseToolCalls(text, options.tools);
    this.options.debugLog?.(
      `reply: len=${text.length} calls=${calls.length}`
      + ` proseLen=${prose.length} finish=${assistant.finish}`
      + ` raw=${JSON.stringify(text.slice(0, 400))}`,
    );
    if (calls.length > 0) {
      this.options.debugLog?.(`tools: ${calls.map((call) => call.name).join(', ')}`);
    }

    let index = 0;
    if (prose.length > 0) {
      yield { type: 'block-start', index, blockType: 'text' };
      const slice = 512;
      for (let offset = 0; offset < prose.length; offset += slice) {
        if (options.signal?.aborted === true) break;
        yield { type: 'text-delta', index, text: prose.slice(offset, offset + slice) };
      }
      yield { type: 'block-end', index, block: { type: 'text', text: prose } };
      index += 1;
    }

    for (const [position, call] of calls.entries()) {
      const callIndex = index + position;
      const id = `oc_${sessionId}_${callIndex}`;
      yield { type: 'block-start', index: callIndex, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: callIndex,
        id,
        name: call.name,
        argumentsDelta: call.arguments,
      };
      yield {
        type: 'block-end',
        index: callIndex,
        block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
      };
    }

    if (typeof assistant.tokens?.output === 'number' && assistant.tokens.output > 0) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: assistant.tokens.input ?? 0,
          outputTokens: assistant.tokens.output,
        },
      };
    }

    if (calls.length > 0) {
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (prose.length === 0) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
