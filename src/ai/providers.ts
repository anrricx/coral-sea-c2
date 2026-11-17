// ─────────────────────────────────────────────────────────────────────────────
// Pluggable "prompt → GameMutation JSON" translators.
//   local   built-in keyword parser (offline, no model)
//   ollama  free local model via Ollama's /api/chat with JSON-schema `format`
//   openai  any OpenAI-compatible /chat/completions endpoint (OpenRouter free
//           models, Groq, LM Studio, llama.cpp server…)
//   claude  Anthropic API (see claudeParser.ts)
// Every provider returns raw candidates; validate.ts still checks everything.
// ─────────────────────────────────────────────────────────────────────────────
import type { GameState } from '../engine/types';
import { CLAUDE_MODEL, MUTATION_RESPONSE_SCHEMA, SYSTEM_PROMPT, describeState, parseWithClaude } from './claudeParser';
import { interpretOffline } from './interpret';

export type ProviderId = 'local' | 'ollama' | 'openai' | 'claude';

export interface LlmSettings {
  provider: ProviderId;
  ollamaUrl: string;
  ollamaModel: string;
  openaiUrl: string;
  openaiKey: string;
  openaiModel: string;
  claudeKey: string;
}

export const DEFAULT_SETTINGS: LlmSettings = {
  provider: 'local',
  // Proxied by the Vite dev server (vite.config.ts) so no CORS setup is needed.
  // Dev server proxies /ollama (no CORS setup). A static/hosted build talks to Ollama directly.
  ollamaUrl: import.meta.env.DEV ? '/ollama' : 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  openaiUrl: 'https://openrouter.ai/api/v1',
  openaiKey: '',
  openaiModel: 'meta-llama/llama-3.3-70b-instruct:free',
  claudeKey: '',
};

export const OPENAI_PRESETS = [
  { label: 'OpenRouter (free models)', url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { label: 'Groq (free tier)', url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'LM Studio (local)', url: 'http://localhost:1234/v1', model: 'local-model' },
];

export interface TranslateResult {
  mutations: unknown[];
  narrative: string;
  /** Short label of who translated it, for the UI badge and log. */
  engine: string;
  /** True when a real language model produced the output (vs the keyword parser). */
  ai: boolean;
}

export function providerLabel(s: LlmSettings): string {
  switch (s.provider) {
    case 'local':
      return 'LOCAL PARSER';
    case 'ollama':
      return `OLLAMA · ${s.ollamaModel}`;
    case 'openai':
      return `API · ${s.openaiModel.split('/').pop()}`;
    case 'claude':
      return `CLAUDE · ${CLAUDE_MODEL}`;
  }
}

/** Is the selected provider configured enough to try? */
export function providerReady(s: LlmSettings): boolean {
  if (s.provider === 'claude') return !!s.claudeKey;
  if (s.provider === 'openai') return !!s.openaiUrl && !!s.openaiModel;
  if (s.provider === 'ollama') return !!s.ollamaUrl && !!s.ollamaModel;
  return true;
}

function parseJsonReply(text: string): { mutations: unknown[]; narrative: string } {
  // Small models sometimes wrap JSON in ``` fences or add chatter; take the outermost object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model reply contained no JSON.');
  const parsed = JSON.parse(text.slice(start, end + 1)) as { mutations?: unknown; narrative?: unknown };
  return {
    mutations: Array.isArray(parsed.mutations) ? parsed.mutations : [],
    narrative: typeof parsed.narrative === 'string' ? parsed.narrative : '',
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Model took longer than ${ms / 1000}s. Try a shorter prompt or a smaller model.`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const userMessage = (prompt: string, state: GameState) => `${describeState(state)}\n\nGAME MASTER PROMPT: ${prompt}`;

// Small local/free models follow worked examples far better than prose rules.
const FEW_SHOT = `
WORKED EXAMPLES (copy this style exactly; names are short Title Case words; never leave attack/move at 0 for a combat unit):

PROMPT: China deploys bat bombs at (6,4) that fly over any terrain and deal 3 splash damage
REPLY: {"mutations":[{"type":"SPAWN_UNIT","payload":{"team":"red","name":"Bat Bombs","iconType":"swarm","hexCoords":{"col":6,"row":4},"hp":2,"maxHp":2,"moveRange":4,"acquireRange":0,"acquirePower":0,"engageRange":1,"engagePower":3,"splashRadius":1,"domain":"air","durationTurns":3}}],"narrative":"A cloud of incendiary bat bombs takes flight over (6,4)."}

PROMPT: Monsoon storm reduces all sea movement by 2
REPLY: {"mutations":[{"type":"MODIFY_GLOBAL_RULE","payload":{"ruleId":"monsoon_sea_move","description":"Monsoon: sea movement -2","targetDomain":"sea","targetTeam":"all","statModified":"moveRange","delta":-2,"durationTurns":3}}],"narrative":"Monsoon swells slow every ship."}

PROMPT: Earthquake at (4,2) radius 1 deals 2 damage
REPLY: {"mutations":[{"type":"TRIGGER_EVENT","payload":{"eventName":"Earthquake","targetHex":{"col":4,"row":2},"radius":1,"damage":2,"terrainChange":"none"}}],"narrative":"The atoll shudders."}

PROMPT: New mechanic: ground units standing on land at the end of a turn take 1 damage from sandstorms
REPLY: {"mutations":[{"type":"DEFINE_MECHANIC","payload":{"name":"Sandstorms","description":"Ground units on land take 1 damage at the end of each turn.","resources":[],"triggers":[{"on":"TURN_END","subject":{"team":"all","domain":"land","iconType":"any"},"conditions":[{"kind":"terrain","negate":false,"key":"","op":">=","value":0,"terrain":"land","relation":"any","domain":"all","range":0}],"effects":[{"kind":"damage","target":"self","range":0,"amount":1,"key":"","stat":"engagePower","text":"","to":"nearestFreeHex","spawnTeam":"same","spawnName":"","spawnIcon":"generic","spawnDomain":"air","spawnHp":1,"spawnMoveRange":0,"spawnEngageRange":0,"spawnEngagePower":0}]}],"statRules":[],"actionRules":[]}}],"narrative":"Sandstorms now grind down exposed ground forces."}

PROMPT: angry geese
REPLY: {"mutations":[{"type":"SPAWN_UNIT","payload":{"team":"neutral","name":"Angry Geese","iconType":"swarm","hexCoords":{"col":4,"row":3},"hp":2,"maxHp":2,"moveRange":4,"acquireRange":1,"acquirePower":1,"engageRange":1,"engagePower":3,"splashRadius":1,"domain":"air","durationTurns":4}}],"narrative":"A honking, furious flock descends on the strait, attacking anything nearby."}

PROMPT: heavy fog rolls over Kestrel Harbor
REPLY: {"mutations":[{"type":"CREATE_ZONE","payload":{"name":"Heavy Fog","targetHex":{"col":7,"row":2},"radius":1,"durationTurns":3,"targetDomain":"all","targetTeam":"all","statModifiers":[{"stat":"acquirePower","delta":-3},{"stat":"acquireRange","delta":-2}],"damagePerTurn":0,"blocksMovement":false,"visual":"fog"}}],"narrative":"A thick fog blinds every sensor around Kestrel Harbor."}

PROMPT: economic collapse in China
REPLY: {"mutations":[{"type":"MODIFY_GLOBAL_RULE","payload":{"ruleId":"china_economic_collapse","description":"Economic collapse: Red logistics -2 move","targetDomain":"all","targetTeam":"red","statModified":"moveRange","delta":-2,"durationTurns":3}}],"narrative":"Fuel and spare parts dry up across Red Force."}

RULES OF THUMB: "lose/take N HP" or "N damage" → effect kind "damage" with amount N. "heal/repair" → "heal". Use iconType "any" in selectors unless the prompt names a specific unit type. Enemy/China/hostile → team "red"; our/allied/friendly → "blue".`;

/** Ask the offline interpreter for a draft the model can confirm, improve or replace. */
function localHint(prompt: string, state: GameState): string {
  try {
    const r = interpretOffline(prompt, state);
    const trust = r.via === 'keyword' ? 'Its numbers/coordinates/teams are usually right' : 'It is a rough trait-based guess; improve it freely';
    return `\n\nAn offline pre-parser drafted this (${trust}; fix anything wrong, add anything missing):\n${JSON.stringify(r.mutations)}`;
  } catch {
    return '';
  }
}

const smallModelSystem = () => `${SYSTEM_PROMPT}\n${FEW_SHOT}`;
const smallModelUser = (prompt: string, state: GameState) => userMessage(prompt, state) + localHint(prompt, state);

// ── Ollama ───────────────────────────────────────────────────────────────────

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/api/tags`, {}, 4000).catch(() => {
    throw new Error('Ollama is not reachable. Open the Ollama app (or run "ollama serve") and try again.');
  });
  if (!res.ok) throw new Error(`Ollama is not reachable (HTTP ${res.status}). Is it running?`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name).sort();
}

export async function parseWithOllama(baseUrl: string, model: string, prompt: string, state: GameState): Promise<TranslateResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${baseUrl.replace(/\/$/, '')}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          // Ollama constrains generation to this JSON schema (structured outputs).
          format: MUTATION_RESPONSE_SCHEMA,
          options: { temperature: 0.1, num_ctx: 12288 },
          messages: [
            { role: 'system', content: smallModelSystem() },
            { role: 'user', content: smallModelUser(prompt, state) },
          ],
        }),
      },
      180_000,
    );
  } catch (e) {
    if ((e as Error).message.startsWith('Model took')) throw e;
    throw new Error('Ollama is not reachable. Open the Ollama app (or run "ollama serve") and try again.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 || /not found/i.test(body)) throw new Error(`Model "${model}" isn't installed. Run: ollama pull ${model}`);
    if (res.status === 502 || res.status === 504) throw new Error('Ollama is not running. Open the Ollama app (or run "ollama serve").');
    throw new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const out = parseJsonReply(data.message?.content ?? '');
  return { ...out, engine: `ollama:${model}`, ai: true };
}

// ── OpenAI-compatible endpoints ─────────────────────────────────────────────

export async function parseWithOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  state: GameState,
): Promise<TranslateResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [
    { role: 'system', content: `${smallModelSystem()}\n\nReply with ONE JSON object: {"mutations": [...], "narrative": "..."} and nothing else.` },
    { role: 'user', content: smallModelUser(prompt, state) },
  ];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const call = (response_format: object) =>
    fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify({ model, messages, temperature: 0.2, response_format }) }, 120_000);

  let res: Response;
  try {
    res = await call({ type: 'json_schema', json_schema: { name: 'game_mutations', schema: MUTATION_RESPONSE_SCHEMA, strict: false } });
    // Not every provider supports json_schema; fall back to plain JSON mode.
    if (res.status === 400 || res.status === 422) res = await call({ type: 'json_object' });
  } catch (e) {
    if ((e as Error).message.startsWith('Model took')) throw e;
    throw new Error(`Could not reach ${baseUrl} (network or CORS).`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('The endpoint rejected the API key.');
  if (res.status === 429) throw new Error('Rate limited by the provider (free tiers are strict). Wait a moment and retry.');
  if (!res.ok) throw new Error(`Endpoint error ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = parseJsonReply(data.choices?.[0]?.message?.content ?? '');
  return { ...out, engine: `api:${model}`, ai: true };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function translatePrompt(settings: LlmSettings, prompt: string, state: GameState): Promise<TranslateResult> {
  switch (settings.provider) {
    case 'ollama':
      return parseWithOllama(settings.ollamaUrl, settings.ollamaModel, prompt, state);
    case 'openai':
      return parseWithOpenAICompatible(settings.openaiUrl, settings.openaiKey, settings.openaiModel, prompt, state);
    case 'claude': {
      const r = await parseWithClaude(settings.claudeKey, prompt, state);
      return { mutations: r.mutations, narrative: r.narrative, engine: `claude:${r.servedBy}`, ai: true };
    }
    case 'local': {
      const r = interpretOffline(prompt, state);
      return { mutations: r.mutations, narrative: r.narrative, engine: 'local', ai: false };
    }
  }
}
