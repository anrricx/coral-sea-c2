// ─────────────────────────────────────────────────────────────────────────────
// Live Claude translation: natural-language prompt → strict GameMutation JSON
// via structured outputs (output_config.format = json_schema).
//
// NOTE: This calls the Anthropic API directly from the browser with a key the
// player pastes into the Settings modal (stored only in this browser's
// localStorage). Fine for a local prototype; for anything deployed, proxy the
// call through your own backend so the key never ships to clients.
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import { describeMechanic } from '../engine/mechanics';
import type { GameState } from '../engine/types';
import { CONDITION_KINDS, EFFECT_KINDS, ICON_TYPES, STAT_KEYS, TRIGGER_EVENTS, ZONE_VISUALS } from '../engine/types';

export const CLAUDE_MODEL = 'claude-opus-5-5';

const coord = {
  type: 'object',
  properties: { col: { type: 'integer' }, row: { type: 'integer' } },
  required: ['col', 'row'],
  additionalProperties: false,
};

const SPAWN = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['SPAWN_UNIT'] },
    payload: {
      type: 'object',
      properties: {
        team: { type: 'string', enum: ['blue', 'red', 'neutral'] },
        name: { type: 'string' },
        iconType: { type: 'string', enum: [...ICON_TYPES] },
        hexCoords: coord,
        hp: { type: 'integer' },
        maxHp: { type: 'integer' },
        moveRange: { type: 'integer' },
        acquireRange: { type: 'integer' },
        acquirePower: { type: 'integer' },
        engageRange: { type: 'integer' },
        engagePower: { type: 'integer' },
        splashRadius: { type: 'integer' },
        domain: { type: 'string', enum: ['sea', 'land', 'air'] },
        durationTurns: { type: 'integer' },
      },
      required: [
        'team', 'name', 'iconType', 'hexCoords', 'hp', 'maxHp', 'moveRange', 'acquireRange',
        'acquirePower', 'engageRange', 'engagePower', 'splashRadius', 'domain', 'durationTurns',
      ],
      additionalProperties: false,
    },
  },
  required: ['type', 'payload'],
  additionalProperties: false,
};

const RULE = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['MODIFY_GLOBAL_RULE'] },
    payload: {
      type: 'object',
      properties: {
        ruleId: { type: 'string' },
        description: { type: 'string' },
        targetDomain: { type: 'string', enum: ['sea', 'land', 'air', 'all'] },
        targetTeam: { type: 'string', enum: ['blue', 'red', 'neutral', 'all'] },
        statModified: { type: 'string', enum: ['moveRange', 'engagePower', 'acquirePower'] },
        delta: { type: 'integer' },
        durationTurns: { type: 'integer' },
      },
      required: ['ruleId', 'description', 'targetDomain', 'targetTeam', 'statModified', 'delta', 'durationTurns'],
      additionalProperties: false,
    },
  },
  required: ['type', 'payload'],
  additionalProperties: false,
};

const EVENT = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['TRIGGER_EVENT'] },
    payload: {
      type: 'object',
      properties: {
        eventName: { type: 'string' },
        targetHex: coord,
        radius: { type: 'integer' },
        damage: { type: 'integer' },
        terrainChange: { type: 'string', enum: ['sea', 'coast', 'land', 'none'] },
      },
      required: ['eventName', 'targetHex', 'radius', 'damage', 'terrainChange'],
      additionalProperties: false,
    },
  },
  required: ['type', 'payload'],
  additionalProperties: false,
};

// ── DEFINE_MECHANIC: building blocks, flattened so every field is always present.
// Unused fields get neutral values ("" / 0 / "any") and the validator ignores them.
const SELECTOR = {
  type: 'object',
  properties: {
    team: { type: 'string', enum: ['blue', 'red', 'neutral', 'all'] },
    domain: { type: 'string', enum: ['sea', 'land', 'air', 'all'] },
    iconType: { type: 'string', enum: [...ICON_TYPES, 'any'] },
  },
  required: ['team', 'domain', 'iconType'],
  additionalProperties: false,
};
const CONDITION = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...CONDITION_KINDS] },
    negate: { type: 'boolean' },
    key: { type: 'string' },
    op: { type: 'string', enum: ['<', '<=', '==', '>=', '>'] },
    value: { type: 'integer' },
    terrain: { type: 'string', enum: ['sea', 'coast', 'land', 'city'] },
    relation: { type: 'string', enum: ['friendly', 'enemy', 'any'] },
    domain: { type: 'string', enum: ['sea', 'land', 'air', 'all'] },
    range: { type: 'integer' },
  },
  required: ['kind', 'negate', 'key', 'op', 'value', 'terrain', 'relation', 'domain', 'range'],
  additionalProperties: false,
};
const EFFECT = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...EFFECT_KINDS] },
    target: { type: 'string', enum: ['self', 'friendlyInRange', 'enemiesInRange', 'allInRange'] },
    range: { type: 'integer' },
    amount: { type: 'integer' },
    key: { type: 'string' },
    stat: { type: 'string', enum: [...STAT_KEYS] },
    text: { type: 'string' },
    to: { type: 'string', enum: ['nearestFriendlyCity', 'nearestFreeHex'] },
    spawnTeam: { type: 'string', enum: ['same', 'enemy', 'neutral'] },
    spawnName: { type: 'string' },
    spawnIcon: { type: 'string', enum: [...ICON_TYPES] },
    spawnDomain: { type: 'string', enum: ['sea', 'land', 'air'] },
    spawnHp: { type: 'integer' },
    spawnMoveRange: { type: 'integer' },
    spawnEngageRange: { type: 'integer' },
    spawnEngagePower: { type: 'integer' },
  },
  required: [
    'kind', 'target', 'range', 'amount', 'key', 'stat', 'text', 'to', 'spawnTeam', 'spawnName',
    'spawnIcon', 'spawnDomain', 'spawnHp', 'spawnMoveRange', 'spawnEngageRange', 'spawnEngagePower',
  ],
  additionalProperties: false,
};
const listOf = (items: object) => ({ type: 'array', items });
const ZONE = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['CREATE_ZONE'] },
    payload: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        targetHex: coord,
        radius: { type: 'integer' },
        durationTurns: { type: 'integer' },
        targetDomain: { type: 'string', enum: ['sea', 'land', 'air', 'all'] },
        targetTeam: { type: 'string', enum: ['blue', 'red', 'neutral', 'all'] },
        statModifiers: listOf({
          type: 'object',
          properties: { stat: { type: 'string', enum: [...STAT_KEYS] }, delta: { type: 'integer' } },
          required: ['stat', 'delta'],
          additionalProperties: false,
        }),
        damagePerTurn: { type: 'integer' },
        blocksMovement: { type: 'boolean' },
        visual: { type: 'string', enum: [...ZONE_VISUALS] },
      },
      required: ['name', 'targetHex', 'radius', 'durationTurns', 'targetDomain', 'targetTeam', 'statModifiers', 'damagePerTurn', 'blocksMovement', 'visual'],
      additionalProperties: false,
    },
  },
  required: ['type', 'payload'],
  additionalProperties: false,
};

const MECHANIC = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['DEFINE_MECHANIC'] },
    payload: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        resources: listOf({
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            appliesTo: SELECTOR,
            initial: { type: 'integer' },
            max: { type: 'integer' },
          },
          required: ['key', 'label', 'appliesTo', 'initial', 'max'],
          additionalProperties: false,
        }),
        triggers: listOf({
          type: 'object',
          properties: {
            on: { type: 'string', enum: [...TRIGGER_EVENTS] },
            subject: SELECTOR,
            conditions: listOf(CONDITION),
            effects: listOf(EFFECT),
          },
          required: ['on', 'subject', 'conditions', 'effects'],
          additionalProperties: false,
        }),
        statRules: listOf({
          type: 'object',
          properties: {
            subject: SELECTOR,
            conditions: listOf(CONDITION),
            stat: { type: 'string', enum: [...STAT_KEYS] },
            delta: { type: 'integer' },
          },
          required: ['subject', 'conditions', 'stat', 'delta'],
          additionalProperties: false,
        }),
        actionRules: listOf({
          type: 'object',
          properties: {
            subject: SELECTOR,
            conditions: listOf(CONDITION),
            action: { type: 'string', enum: ['move', 'acquire', 'engage'] },
            mode: { type: 'string', enum: ['block', 'unlimitedRange', 'ignoreTerrain'] },
            costResource: { type: 'string' },
            costAmount: { type: 'integer' },
          },
          required: ['subject', 'conditions', 'action', 'mode', 'costResource', 'costAmount'],
          additionalProperties: false,
        }),
      },
      required: ['name', 'description', 'resources', 'triggers', 'statRules', 'actionRules'],
      additionalProperties: false,
    },
  },
  required: ['type', 'payload'],
  additionalProperties: false,
};

export const MUTATION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    mutations: { type: 'array', items: { anyOf: [SPAWN, RULE, EVENT, ZONE, MECHANIC] } },
    narrative: { type: 'string' },
  },
  required: ['mutations', 'narrative'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You are the Scenario Injector for a hex-grid naval/air wargame inspired by analytical tabletop wargames.
Translate the game master's natural-language prompt into one or more GameMutation objects.

SANDBOX PRINCIPLES. This is a creative sandbox: ANY prompt must become something playable. Never refuse, never return an empty list.
- Physical things (real, absurd, sci-fi, mythical: "angry geese", "alien mothership", "a tank made of cheese") → SPAWN_UNIT.
  Derive stats from the description: heavy/armored/giant → high hp, slow move; fast/agile → high move; lasers/artillery/long-range → high engageRange;
  explosive/fire/swarms → splashRadius 1; sensors/eyes/radar → high acquire; cute/harmless → engagePower 0-1. Wild creatures and monsters are team "neutral".
  Pick domain by how it moves (flies → air, swims → sea, walks/rolls → land). Transient things (swarms, ghosts, storms) get durationTurns 2-4.
- Environmental or abstract conditions:
  * localized ("heavy fog over the atoll", "radiation near Kestrel Harbor", "a force field around our port", "minefield in the south") → CREATE_ZONE.
  * map-wide or societal ("economic collapse", "internet goes down", "morale boost", "pandemic") → MODIFY_GLOBAL_RULE
    (economy/logistics → moveRange; comms/cyber/sensors → acquirePower; morale/health → engagePower). Name the affected team when stated.
- Instant actions ("lightning strikes (4,2)", "laser beam from space hits the enemy battery", "meteor") → TRIGGER_EVENT at the target's hex
  (look the target up in CURRENT STATE). Precise strikes have radius 0; big impacts radius 1-2.
- Lasting new RULES or systems ("add a fuel system", "units can teleport") → DEFINE_MECHANIC.
- Several mutations may be combined (e.g. a volcano = TRIGGER_EVENT + CREATE_ZONE of ash).

MUTATION TYPES
- SPAWN_UNIT: place a new unit. team "blue" = player's force (US/Australia/allied/"our"), "red" = AI adversary (enemy/hostile/China/PLA), "neutral" = environmental hazards/creatures that attack everyone.
  domain: "sea" units must be on sea hexes, "land" units on coast/land/city hexes, "air" units ignore terrain.
  Typical stats: fighter hp4 move4 acqRange2 acqPow1 engRange2 engPow2; destroyer hp6 move2 acqRange3 acqPow2 engRange3 engPow3; missile battery hp5 move1 engRange4 engPow3; AEW plane hp3 move4 acqRange4 acqPow2 engRange0 engPow0.
  durationTurns 0 = permanent; use 2-4 for swarms, storms and other transient effects.
  splashRadius 1 means the attack also hits enemy units adjacent to the target.
  For "N units", emit N separate SPAWN_UNIT mutations (max 4), adjacent coordinates are fine.
- MODIFY_GLOBAL_RULE: a modifier to moveRange, engagePower or acquirePower for a domain/team. Negative delta = penalty. Default duration 3 turns unless stated; 0 = permanent.
- TRIGGER_EVENT: instant area event: damages every unit within radius of targetHex, optionally changes terrain ("sea" floods land, "land" raises islands, "none" no change).
- CREATE_ZONE: a lasting area hazard on specific hexes (radius 0-3 around targetHex). Units of targetDomain/targetTeam INSIDE it get statModifiers
  (stat ∈ moveRange, engagePower, acquirePower, engageRange, acquireRange; delta -5..5), take damagePerTurn (0-5) at end of turn, and if
  blocksMovement they cannot enter it. visual ∈ fog | storm | fire | radiation | toxic | ice | energy | generic. durationTurns 0 = permanent (default 3).
  A force field protecting one side blocks the OTHER side (targetTeam = the opposing team).

- DEFINE_MECHANIC: a NEW, PERMANENT game mechanic (it is saved to the player's library and loads in every future game).
  Use it whenever the prompt describes an ongoing rule, system or ability rather than a one-off spawn/event:
  "add a fuel system", "units can teleport", "ships repair in port", "limited ammo", "submarines are invisible near coasts".
  Build it from these blocks (fill unused fields with "" / 0 / neutral enum values — they are ignored):
  * resources: per-unit counters. key (snake_case), label, appliesTo selector, initial, max. Examples: fuel, ammo, teleport_charges.
  * triggers: on TURN_START | TURN_END | AFTER_MOVE | AFTER_ACQUIRE | AFTER_ENGAGE | UNIT_DESTROYED, for units matching subject,
    when ALL conditions hold → run effects in order.
    Conditions (kind): resource {key, op, value} | hp {op, value} | terrain {terrain} (unit's hex) | turn {op, value} |
      everyNTurns {value} | nearUnit {relation, domain, range} | nearCity {relation, range}. negate:true inverts.
    Effects (kind), applied to target = self | friendlyInRange | enemiesInRange | allInRange (with range):
      damage {amount} | heal {amount} | changeResource {key, amount (+/-)} | setResource {key, amount} |
      changeStat {stat, amount} (permanent) | destroy {text, "{unit}" = unit name} | relocate {to} |
      resetActions (lets the unit act again) | spawn {spawnTeam same|enemy|neutral, spawnName, spawnIcon, spawnDomain, spawnHp,
      spawnMoveRange, spawnEngageRange, spawnEngagePower} | log {text}.
  * statRules: continuous stat delta for matching units while conditions hold (auras, terrain bonuses, low-fuel penalties).
    stat ∈ moveRange, engagePower, acquirePower, engageRange, acquireRange.
  * actionRules: while conditions hold, action move|acquire|engage gets mode block (forbidden) | unlimitedRange (move anywhere legal,
    i.e. teleport) | ignoreTerrain (move over any terrain). costResource/costAmount are spent only when the special move is used.
  Example "fuel system": resource fuel (air units, initial 4, max 4); trigger TURN_END for air units → changeResource fuel -1;
  trigger TURN_END for air units IF fuel <= 0 → destroy "{unit} ran out of fuel"; trigger TURN_START for air units IF nearCity friendly range 1 → setResource fuel 4.
  Example "teleport once per game": resource teleport_charges (initial 1, max 1); actionRule move unlimitedRange IF teleport_charges >= 1, costResource teleport_charges, costAmount 1.
  A mechanic must contain at least one trigger, statRule or actionRule. Remember there are two sides: decide if it applies to blue, red or all.

LIMITS (values outside are clamped): hp 1-20, ranges 0-8, acquirePower 0-5, engagePower 0-10, splashRadius 0-2, radius 0-3, damage 0-10, delta -5..5, durationTurns 0-20.
Coordinates are (col,row), 0-indexed: col 0-9 (west→east), row 0-6 (north→south). If the prompt omits a location, choose a sensible one from the current state below.
Keep names short (<= 24 chars). Write a one-sentence in-world "narrative" describing what happened. Never invent mutation types.`;

export function describeState(s: GameState): string {
  const map = Array.from({ length: s.map.rows }, (_, row) =>
    Array.from({ length: s.map.cols }, (_, col) => {
      const t = s.map.tiles.find((x) => x.col === col && x.row === row)!;
      return t.terrain === 'sea' ? '~' : t.terrain === 'city' ? 'C' : t.terrain === 'coast' ? 'c' : 'L';
    }).join(''),
  ).join('\n');
  const units = s.units
    .map((u) => `${u.team} ${u.name} [${u.domain}] at (${u.pos.col},${u.pos.row}) hp ${u.hp}/${u.maxHp}`)
    .join('\n');
  const cities = s.map.tiles
    .filter((t) => t.terrain === 'city')
    .map((t) => `${t.name} (${t.owner}) at (${t.col},${t.row})`)
    .join('; ');
  return `CURRENT STATE — turn ${s.turn}/${s.maxTurns}, phase ${s.phase}
Terrain rows (row 0 first; ~ sea, c coast, L land, C city):
${map}
Cities: ${cities}
Units:
${units}
Active rules: ${s.activeRules.map((r) => r.description).join('; ') || 'none'}
Custom mechanics already in play: ${
    s.mechanics.filter((m) => m.enabled).map((m) => `\n- ${m.name}: ${describeMechanic(m).join(' | ')}`).join('') || 'none'
  }`;
}

export interface ClaudeParseResult {
  mutations: unknown[];
  narrative: string;
  servedBy: string;
}

export async function parseWithClaude(apiKey: string, prompt: string, state: GameState): Promise<ClaudeParseResult> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Translation is a small, latency-sensitive task: low effort keeps the game snappy.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: MUTATION_RESPONSE_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${describeState(state)}\n\nGAME MASTER PROMPT: ${prompt}` }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined to translate that prompt. Try rephrasing it.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Claude response was truncated. Try a shorter prompt.');
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const parsed = JSON.parse(text) as { mutations?: unknown[]; narrative?: string };
    return {
      mutations: Array.isArray(parsed.mutations) ? parsed.mutations : [],
      narrative: typeof parsed.narrative === 'string' ? parsed.narrative : '',
      servedBy: response.model,
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key (401). Check it in Settings.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('API key lacks permission for this model (403).');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit hit (429). Wait a moment and retry.');
    if (err instanceof Anthropic.BadRequestError) throw new Error(`Claude rejected the request (400): ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API (network/CORS).');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }
}
