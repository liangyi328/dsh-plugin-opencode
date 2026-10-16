/**
 * OpenCode Zen catalog.
 *
 * The free models served through the local OpenCode background service. The
 * source of truth is `GET /api/model`; this static snapshot is only a fallback
 * for when the service is unreachable at boot, so the plugin still registers a
 * usable list. It must never be treated as authoritative: OpenCode adds and
 * retires models without notice, and a retired id is accepted by the service at
 * set-model time and then never answers — which reads to the user as "the model
 * replied once and then stopped". Hence refreshCatalog() runs at startup, on an
 * interval, and on demand (see index.js).
 *
 * Field shape verified against the service on 2026-10-16.
 *
 * Free-tier access is anonymous: the CLI sends `apiKey: "public"` and OpenCode's
 * server accepts it only from OpenCode clients, so all traffic is tunneled
 * through the locally running background service (see adapter.js).
 */

/** The exact shape `GET /api/model` returned on 2026-10-16 (evening refresh). */
export const STATIC_MODELS = [
  {
    id: 'll-alpha-free',
    name: 'LL Alpha Free',
    tools: true,
    image: false,
    context: 262144,
    output: 65536,
    variants: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'nemotron-3.5-super-vl-free',
    name: 'Nemotron 3.5 Super VL Free',
    tools: true,
    image: true,
    context: 1048576,
    output: 131072,
    variants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'cat-jam-free',
    name: 'Cat Jam Free',
    tools: true,
    image: false,
    context: 1048576,
    output: 131072,
    variants: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'longcat-2.5-preview-free',
    name: 'LongCat 2.5 Preview Free',
    tools: true,
    image: true,
    context: 1000000,
    output: 131072,
    variants: [],
  },
  {
    id: 'space-bunny-free',
    name: 'Space Bunny Free',
    tools: true,
    image: true,
    context: 1048576,
    output: 524288,
    variants: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'mimo-v2.6-flash-free',
    name: 'MiMo-V2.6-Flash Free',
    tools: true,
    image: true,
    context: 200000,
    output: 32000,
    variants: [],
  },
  {
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    tools: true,
    image: true,
    context: 200000,
    output: 32000,
    variants: ['low', 'high', 'max'],
  },
  {
    id: 'muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Free',
    tools: true,
    image: true,
    context: 1048576,
    output: 131072,
    variants: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'glm-5.3-flash-free',
    name: 'GLM-5.3-Flash Free',
    tools: true,
    image: true,
    context: 200000,
    output: 32000,
    variants: ['low', 'high', 'max'],
  },
  {
    id: 'nemotron-3.5-lightning-free',
    name: 'Nemotron 3.5 Lightning Free',
    tools: true,
    image: false,
    context: 262144,
    output: 262144,
    variants: [],
  },
  {
    id: 'nemotron-3-ultra-free',
    name: 'Nemotron 3 Ultra Free',
    tools: true,
    image: false,
    context: 1000000,
    output: 128000,
    variants: [],
  },
  {
    id: 'big-pickle',
    name: 'Big Pickle',
    tools: true,
    image: false,
    context: 200000,
    output: 32000,
    variants: [],
  },
];

export const CATALOG_STAMP = 'opencode-free-v2';

/**
 * Replace the static snapshot with a live `GET /api/model` response when the
 * background service answers. Returns the catalog actually in force afterwards.
 *
 * The live list wins whenever it is non-empty, even if it is smaller than the
 * snapshot: a missing model has genuinely been retired, and keeping it would
 * produce requests that are accepted and then never answered.
 *
 * @param service - { fetchJson } bridge to the background service.
 */
export async function refreshCatalog(service) {
  try {
    const live = await service.fetchJson('/api/model');
    const rows = Array.isArray(live?.data) ? live.data : [];
    const models = rows
      .filter((row) => row?.id && row?.providerID === 'opencode')
      .map((row) => ({
        id: row.id,
        name: row.name ?? row.id,
        tools: row?.capabilities?.tools === true,
        image: Array.isArray(row?.capabilities?.input) && row.capabilities.input.includes('image'),
        context: row?.limit?.context,
        output: row?.limit?.output,
        variants: Array.isArray(row?.variants) ? row.variants.map((v) => v?.id).filter(Boolean) : [],
      }));
    if (models.length > 0) return { models, source: 'live /api/model' };
  } catch {
    /* fall through to the static snapshot */
  }
  return { models: STATIC_MODELS, source: 'static snapshot' };
}
