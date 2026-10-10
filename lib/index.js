/**
 * OpenCode Zen provider for DeepSeek Harness.
 *
 * Registers one LLM provider route (`opencode` by default) exposing the ten
 * free OpenCode Zen models. The backend is the locally running OpenCode
 * background service: the free tier admits only OpenCode clients, so the
 * plugin tunnels every request through that service's session API instead of
 * calling opencode.ai directly — no API key required.
 *
 * The service connection is resolved per call:
 *   1. an explicit Config override (serviceUrl + servicePasswordEnv)
 *   2. `~/.config/opencode/service.json`, which the CLI writes when the
 *      background service is up
 *
 * This module imports only its own vendored schema library: a plugin loaded by
 * absolute path has no node_modules of the installation available, so it must
 * not depend on the host's packages. Host services arrive through `ctx`.
 */
import fs from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { OpenCodeAdapter, OpenCodeError } from './adapter.js';
import { OpenCodeService, readServiceConfig, serviceConfigPath } from './service.js';
import { CATALOG_STAMP, STATIC_MODELS, refreshCatalog } from './catalog.js';

const name = 'llm-opencode';
const inject = ['llm', 'clientModules'];
// NOT "opencode": that id is the harness's built-in OpenCode Zen provider
// (keyed, paid tier via OPENCODE_API_KEY). This plugin bridges the FREE tier
// through the local background service, so it owns a separate route id.
const DEFAULT_PROVIDER = 'opencode-free';
const DEFAULT_SERVICE_URL = 'http://127.0.0.1:49374';
const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  displayName: z.string().default('OpenCode Zen'),
  // The background service endpoint. Empty uses the CLI's fixed default.
  serviceUrl: z.string().default(DEFAULT_SERVICE_URL),
  // Credential ref holding the service.json password. Empty reads the file.
  servicePasswordEnv: z.string().role('credential-ref').default('').volatile(),
  // The opencode project directory sessions run in; empty omits the parameter
  // so the service uses its own default project.
  directory: z.string().default(''),
  // opencode agent the bridge sessions run as: 'plan' is read-only and only
  // advises, 'build' runs opencode-side tools. 'build' is the default because
  // the read-only agent turns "install this for me" into a description of the
  // steps rather than an action — the harness's own tools are what actually
  // execute, but the opencode agent must not be the one refusing to act.
  agent: z.string().default('build'),
  pollIntervalMs: z.number().default(1000),
  pollTimeoutMs: z.number().default(300000),
  requestTimeoutMs: z.number().default(60000),
  defaultContextWindow: z.number().default(262144),
  defaultMaxTokens: z.number().default(32768),
  debugLogPath: z.string().default(''),
});

/** Read every field once per operation, so a settings edit applies to the next call. */
function plainOptions(config) {
  return {
    provider: config.provider,
    displayName: config.displayName,
    serviceUrl: config.serviceUrl,
    servicePasswordEnv: config.servicePasswordEnv.get(),
    directory: config.directory,
    agent: config.agent,
    pollIntervalMs: config.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    debugLogPath: config.debugLogPath,
  };
}

function apply(ctx, config) {
  // Log before anything that can throw: this single line separates "the module
  // was never imported" from "apply() ran and failed here".
  try {
    const target = config?.debugLogPath;
    if (typeof target === 'string' && target.length > 0) {
      fs.appendFileSync(target, `${new Date().toISOString()} apply() entered (code=v9)\n`);
    }
  } catch {
    /* ignore */
  }

  const options = () => plainOptions(config);
  options(); // fail loud on a malformed configuration rather than at first request

  const provider = options().provider;
  let catalog = { models: STATIC_MODELS, source: 'static snapshot' };

  /** Opt-in breadcrumb trail; a silent startup failure is otherwise invisible. */
  const debugLog = (message) => {
    const target = options().debugLogPath;
    if (typeof target !== 'string' || target.length === 0) return;
    try {
      fs.appendFileSync(target, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* diagnostics are best-effort and never fail the plugin */
    }
  };

  // The client half (上下文长度只读药丸) lives in this same package, but
  // `clientModules` only re-reads bundle bytes through `rebuilt()` — the HMR
  // module watch does not cover plugin files on this host, so a reload alone
  // would keep serving the previous client.js. Publishing our own bundle at
  // apply() makes every reload ship the current client half; unchanged files
  // keep the graph as-is (the call is a no-op), so this is safe on restart.
  // Like the WorkBuddy plugin, the entry id is the PACKAGE name (what
  // package.json declares and the boot graph advertises).
  try {
    const registry = ctx.clientModules;
    if (registry !== undefined && typeof registry.rebuilt === 'function') {
      const rev = registry.rebuilt('dsh-plugin-opencode');
      debugLog(`client bundle: rebuilt -> ${rev ?? '<unchanged>'}`);
    }
  } catch (error) {
    debugLog(`client bundle: rebuilt FAILED ${error?.message ?? error}`);
  }

  /**
   * Resolve one authenticated service bridge. Re-read per call so config edits
   * and service restarts apply to the next request without a plugin reload.
   */
  const connect = async () => {
    const current = options();
    let baseUrl = current.serviceUrl.trim();
    let password;

    const refName = current.servicePasswordEnv.trim();
    if (refName.length > 0) {
      if (!CREDENTIAL_REF_PATTERN.test(refName)) {
        throw new OpenCodeError(`opencode: "${refName}" is not a valid credential reference`, 'CONFIG');
      }
      const credentials = ctx.get('credentials');
      const hit = credentials !== undefined
        ? await credentials.resolve(refName).catch(() => undefined)
        : undefined;
      const stored = typeof hit?.value === 'string' && hit.value.length > 0
        ? hit.value
        : process.env[refName];
      if (typeof stored === 'string' && stored.length > 0) {
        password = stored.trim();
      }
    }

    // The CLI-written config fills whatever the explicit settings left blank.
    if (password === undefined) {
      const serviceConfig = readServiceConfig();
      if (serviceConfig !== undefined) {
        password = serviceConfig.password;
        if (typeof serviceConfig.baseUrl === 'string' && serviceConfig.baseUrl.length > 0) {
          baseUrl = serviceConfig.baseUrl;
        }
      }
    }
    if (password === undefined) {
      throw new OpenCodeError(
        `opencode: no background service found. Start the OpenCode CLI once ("opencode") so `
        + `${serviceConfigPath()} is written, or store the password under a credential reference `
        + 'in the plugin settings',
        'MISSING_SERVICE',
      );
    }
    if (baseUrl.length === 0) baseUrl = DEFAULT_SERVICE_URL;

    return new OpenCodeService({
      baseUrl,
      password,
      directory: current.directory.trim(),
      requestTimeoutMs: current.requestTimeoutMs,
      debugLog,
    });
  };

  // Startup self-check: proves the service is reachable and lets the live
  // catalog (when obtainable) replace the baked-in snapshot.
  debugLog(`apply: provider=${provider} stamp=${CATALOG_STAMP}`);
  void (async () => {
    try {
      const service = await connect();
      catalog = await refreshCatalog(service);
      debugLog(`catalog: ${catalog.models.length} models from ${catalog.source}`);
    } catch (error) {
      debugLog(`catalog: kept static snapshot (${error?.message ?? error})`);
    }
  })();

  const adapter = new OpenCodeAdapter({
    provider,
    displayName: options().displayName,
    getCatalog: () => catalog,
    connect,
    agent: () => options().agent,
    pollIntervalMs: () => options().pollIntervalMs,
    pollTimeoutMs: () => options().pollTimeoutMs,
    defaultContextWindow: () => options().defaultContextWindow,
    defaultMaxTokens: () => options().defaultMaxTokens,
    debugLog,
  });

  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  debugLog(`settings: ns=${settingsNs}`);
  try {
    ctx.llm.registerConfigurableProviders([{
      provider,
      displayName: options().displayName,
      settingsNs,
      settingsPath: [],
    }]);
    ctx.llm.registerAdapter([provider], adapter);
    debugLog(`apply: registered provider "${provider}" settingsNs=${settingsNs}`);
  } catch (error) {
    // A thrown registration must be visible: without this line the plugin
    // looks loaded while every model fails with NO_ADAPTER at call time.
    debugLog(`register FAILED: [${error?.code ?? '?'}] ${error?.message ?? error}`);
    throw error;
  }

  /**
   * The context-window view the unified picker renders, in the same shape as
   * the WorkBuddy route so one client can consume both.
   *
   * OpenCode's catalogue exposes exactly ONE context limit per model
   * (`limit.context`) and the session API takes no context parameter, so every
   * model reports `adjustable: false`: the picker displays the fixed window
   * read-only rather than fabricating choices the provider does not offer.
   */
  const contextWindowView = () => ({
    provider,
    providerName: options().displayName,
    models: catalog.models.map((model) => ({
      id: model.id,
      name: model.name,
      displayName: model.name,
      adjustable: false,
      selected: null,
      effective: typeof model.context === 'number' && model.context > 0 ? model.context : null,
    })),
  });

  /** Read a JSON request body, tolerating an empty or malformed one. */
  const readJsonBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        raw = '';
        resolve(undefined);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });

  // Context-window view for the Web picker. GET reports each model's fixed
  // window; POST exists only for API symmetry with the WorkBuddy route and
  // always explains that nothing is selectable here.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/opencode/context-window',
        handler: async (req, res) => {
          const admission = webCtx.connection.admit(req);
          if ('rejection' in admission) {
            res.writeHead(admission.rejection);
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
          const send = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
          };
          try {
            const method = (req.method ?? 'GET').toUpperCase();
            if (method === 'GET') {
              send(200, contextWindowView());
              return;
            }
            if (method !== 'POST') {
              send(405, { error: 'method not allowed' });
              return;
            }
            await readJsonBody(req);
            send(400, {
              error: `provider "${provider}" models have a fixed context window; `
                + 'OpenCode exposes no per-model context lengths to select',
            });
          } catch (error) {
            debugLog(`context: route FAILED ${error?.message ?? error}`);
            send(500, { error: error?.message ?? String(error) });
          }
        },
      });
      debugLog('route: /opencode/context-window registered');
      return () => dispose();
    }, 'llm-opencode: /opencode routes');
  });
}

export { Config, apply, inject, name };
