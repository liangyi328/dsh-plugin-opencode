/**
 * Bridge to the locally running OpenCode background service.
 *
 * The OpenCode CLI keeps one long-lived server (`opencode serve`) that owns the
 * anonymous free-tier identity; direct HTTPS to opencode.ai from other clients
 * is rejected with a FreeTierError, so tunneling through this service is the
 * only keyless path. Its HTTP API is a superset of what `opencode run` does
 * internally.
 *
 * Wire facts (verified against the installed CLI v2.0.20):
 *   endpoint = http://127.0.0.1:<port>          (port from service.json)
 *   auth     = HTTP Basic "opencode:<password>" (password from service.json)
 *   paths    = /api/session            POST   create a session
 *              /api/session/:id/model  POST   {"model":{"providerID","id"}}
 *              /api/session/:id/prompt POST   {"text": "..."} (also "agent")
 *              /api/session/:id/message GET    messages, newest first
 *   every path accepts ?directory=<encodeURIComponent(dir)>
 *
 * The `directory` parameter selects the project the session runs in. It is
 * passed through so the caller can pin agent tool activity to a workspace.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The config file the CLI writes when the background service is up. */
export function serviceConfigPath(override) {
  if (override && override.length > 0) return override;
  const fromEnv = process.env.OPENCODE_CONFIG_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return path.join(fromEnv.trim(), 'service.json');
  return path.join(os.homedir(), '.config', 'opencode', 'service.json');
}

/**
 * Read the connection from disk. Returns undefined when the file is absent or
 * incomplete — callers treat that as "service not running".
 */
export function readServiceConfig(overridePath) {
  const file = serviceConfigPath(overridePath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const password = json?.password;
  if (typeof password !== 'string' || password.length === 0) return undefined;
  return { file, password };
}

export class OpenCodeServiceError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'OpenCodeServiceError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** One authenticated HTTP bridge to the background service. */
export class OpenCodeService {
  /**
   * @param options.baseUrl - e.g. "http://127.0.0.1:49374".
   * @param options.password - the Basic-auth password from service.json.
   * @param options.directory - the opencode project directory for sessions.
   * @param options.requestTimeoutMs - per-request timeout.
   * @param options.debugLog - optional diagnostics sink.
   */
  constructor(options) {
    this.options = options;
    const auth = Buffer.from(`opencode:${options.password}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${auth}`;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  url(apiPath) {
    const suffix = this.options.directory
      ? `?directory=${encodeURIComponent(this.options.directory)}`
      : '';
    return `${this.baseUrl}${apiPath}${suffix}`;
  }

  /** One JSON request; non-2xx becomes a tagged error with the status. */
  async fetchJson(apiPath, init = {}) {
    const headers = {
      authorization: this.authHeader,
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    const controller = new AbortController();
    const timeoutMs = this.options.requestTimeoutMs;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    let response;
    try {
      response = await fetch(this.url(apiPath), {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new OpenCodeServiceError(`opencode service request ${apiPath} timed out`, 'TIMEOUT');
      }
      throw new OpenCodeServiceError(
        `opencode service at ${this.baseUrl} is unreachable: ${error?.message ?? error}`,
        'SERVICE_UNREACHABLE',
      );
    }
    if (timer !== undefined) clearTimeout(timer);
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const trimmed = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      throw new OpenCodeServiceError(
        `opencode service ${init.method ?? 'GET'} ${apiPath} failed with HTTP ${response.status}: ${trimmed}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVICE',
        { status: response.status },
      );
    }
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new OpenCodeServiceError(
        `opencode service ${apiPath} returned non-JSON body: ${text.slice(0, 200)}`,
        'BAD_RESPONSE',
      );
    }
  }

  /** `GET /api/model` — the live free-model catalog. */
  listModels() {
    return this.fetchJson('/api/model');
  }

  /** Create one session and return its id. */
  async createSession() {
    const json = await this.fetchJson('/api/session', { method: 'POST', body: '{}' });
    const id = json?.data?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new OpenCodeServiceError('opencode service returned no session id', 'BAD_RESPONSE');
    }
    this.options.debugLog?.(`service: session created ${id}`);
    return id;
  }

  /** Pin the session's model: {"providerID":"opencode","id":"<model>"} (id, not modelID). */
  async setSessionModel(sessionId, modelId, providerId = 'opencode') {
    await this.fetchJson(`/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      body: JSON.stringify({ model: { providerID: providerId, id: modelId } }),
    });
  }

  /** Pin the session's agent. "plan" is read-only; "build" runs tools. */
  async setSessionAgent(sessionId, agent) {
    await this.fetchJson(`/api/session/${encodeURIComponent(sessionId)}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
    });
  }

  /** Send one user message. Returns immediately with the user message row. */
  async sendPrompt(sessionId, text) {
    return this.fetchJson(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  /**
   * Snapshot of the session's messages, newest first. Assistant rows carry
   * `content: [{type: "text", text}]`, `finish: "stop" | "error" | ...`,
   * and on failure `error: {message, ...}`.
   */
  listMessages(sessionId) {
    return this.fetchJson(`/api/session/${encodeURIComponent(sessionId)}/message`);
  }
}
