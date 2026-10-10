/**
 * OpenCode Zen catalog.
 *
 * The ten free models served through `https://opencode.ai/zen/v1` with the
 * "public" key. The source of truth is the background service's `GET /api/model`
 * (verified against the installed OpenCode CLI v2.0.20); this static snapshot is
 * baked in so the plugin works even when the service is not reachable at boot,
 * and `refreshCatalog()` can replace it with a live copy.
 *
 * Free-tier access is anonymous: the CLI sends `apiKey: "public"` and OpenCode's
 * server accepts it only from OpenCode clients, so all traffic is tunneled
 * through the locally running background service (see adapter.js).
 */

/** The exact shape `GET /api/model` returned on 2026-10-09 (evening refresh). */
export const STATIC_MODELS = [
  {
    id: 'exo-free',
    name: 'Exo Free',
    tools: true,
    image: true,
    context: 1048576,
    output: 131072,
    variants: ['high'],
  },
  {
    id: 'ling-3.1-flash-free',
    name: 'Ling 3.1 Flash Free',
    tools: true,
    image: false,
    context: 262144,
    output: 32768,
    variants: [],
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
    id: 'muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Free',
    tools: true,
    image: true,
    context: 1048576,
    output: 131072,
    variants: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'ling-3.0-flash-fin-free',
    name: 'Ling 3.0 Flash Fin Free',
    tools: true,
    image: false,
    context: 262144,
    output: 32768,
    variants: [],
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
    id: 'step-5-preview-free',
    name: 'Step 5 Preview Free',
    tools: true,
    image: true,
    context: 1000000,
    output: 65536,
    variants: ['low', 'medium', 'high'],
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

export const CATALOG_STAMP = 'opencode-free-v1';

/**
 * Replace the static snapshot with a live `GET /api/model` response when the
 * background service answers. Returns the catalog actually in force afterwards.
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
        variants: Array.isArray(row?.variants) ? row.variants.map((v) => v.id).filter(Boolean) : [],
      }));
    if (models.length > 0) return { models, source: 'live /api/model' };
  } catch {
    /* fall through to the static snapshot */
  }
  return { models: STATIC_MODELS, source: 'static snapshot' };
}
