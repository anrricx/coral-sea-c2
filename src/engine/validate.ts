// ─────────────────────────────────────────────────────────────────────────────
// Validation layer. Anything coming from the prompt bar (Claude or the local
// parser) or from an imported file passes through here before touching state.
// Values are coerced, clamped to sane bounds, and positions are repaired.
// ─────────────────────────────────────────────────────────────────────────────
import { nearestFreeHex, tileAt, canOccupy, unitAt } from './engine';
import { inBounds } from './hex';
import type {
  ActionRule,
  CompareOp,
  Condition,
  Domain,
  DomainFilter,
  Effect,
  EffectTarget,
  GameMutation,
  GameState,
  HexCoord,
  IconType,
  MechanicDraft,
  ModifiableStat,
  Relation,
  ResourceDef,
  Selector,
  StatKey,
  StatRule,
  Team,
  TeamFilter,
  Terrain,
  TriggerEvent,
  TriggerRule,
  Mechanic,
  MutationSource,
  ZoneStatModifier,
  ZoneVisual,
} from './types';
import { CONDITION_KINDS, EFFECT_KINDS, ICON_TYPES, STAT_KEYS, TRIGGER_EVENTS, ZONE_VISUALS } from './types';
import { MAX_UNITS } from './mechanics';
import { MAX_ZONES } from './zones';

export type ValidationResult =
  | { ok: true; mutation: GameMutation; warnings: string[] }
  | { ok: false; error: string };

export const LIMITS = {
  hp: [1, 20],
  moveRange: [0, 8],
  acquireRange: [0, 8],
  acquirePower: [0, 5],
  engageRange: [0, 8],
  engagePower: [0, 10],
  splashRadius: [0, 2],
  durationTurns: [0, 20],
  delta: [-5, 5],
  radius: [0, 3],
  damage: [0, 10],
} as const;

const TEAMS: Team[] = ['blue', 'red', 'neutral'];
const DOMAINS: Domain[] = ['sea', 'land', 'air'];
const STATS: ModifiableStat[] = ['moveRange', 'engagePower', 'acquirePower'];
const TERRAINS: (Terrain | 'none')[] = ['sea', 'coast', 'land', 'city', 'none'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(o: Obj, k: string, lim: readonly [number, number], warnings: string[], fallback: number): number {
  const raw = o[k];
  let v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(v)) v = fallback;
  v = Math.round(v);
  const c = Math.min(lim[1], Math.max(lim[0], v));
  if (c !== v) warnings.push(`${k} clamped ${v} → ${c}`);
  return c;
}

function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[], fallback: T, warnings: string[]): T {
  const raw = typeof o[k] === 'string' ? (o[k] as string).trim() : '';
  const hit = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
  if (!hit) {
    if (raw) warnings.push(`${k} "${raw}" unknown → ${fallback}`);
    return fallback;
  }
  return hit;
}

function str(o: Obj, k: string, fallback: string, max = 40): string {
  const raw = typeof o[k] === 'string' ? (o[k] as string).trim() : '';
  return (raw || fallback).replace(/[<>]/g, '').slice(0, max);
}

function coords(v: unknown): HexCoord | null {
  if (Array.isArray(v) && v.length >= 2) return { col: Number(v[0]), row: Number(v[1]) };
  if (isObj(v)) {
    const col = v.col ?? v.x ?? v.q;
    const row = v.row ?? v.y ?? v.r;
    return { col: Number(col), row: Number(row) };
  }
  return null;
}

export function validateMutation(raw: unknown, s: GameState): ValidationResult {
  if (!isObj(raw)) return { ok: false, error: 'Mutation is not an object.' };
  const type = typeof raw.type === 'string' ? raw.type.toUpperCase() : '';
  const p = isObj(raw.payload) ? raw.payload : raw; // tolerate flattened payloads
  const w: string[] = [];

  if (type === 'SPAWN_UNIT') {
    if (s.units.length >= MAX_UNITS) {
      return { ok: false, error: `The board is full (${MAX_UNITS} units). Destroy something first.` };
    }
    const hex = coords(p.hexCoords ?? p.hex ?? p.position);
    if (!hex || !inBounds(hex, s.map.cols, s.map.rows)) {
      return {
        ok: false,
        error: `Spawn coordinates ${hex ? `(${hex.col},${hex.row})` : '(missing)'} are off-map. Valid: col 0–${s.map.cols - 1}, row 0–${s.map.rows - 1}.`,
      };
    }
    const domain = oneOf(p, 'domain', DOMAINS, 'air', w);
    let pos = hex;
    const tile = tileAt(s, hex)!;
    if (!canOccupy(domain, tile.terrain) || unitAt(s, hex)) {
      const alt = nearestFreeHex(s, hex, domain, 2);
      if (!alt) return { ok: false, error: `No free ${domain}-legal hex near (${hex.col},${hex.row}).` };
      w.push(`(${hex.col},${hex.row}) ${unitAt(s, hex) ? 'occupied' : `is ${tile.terrain}`} → relocated to (${alt.col},${alt.row})`);
      pos = alt;
    }
    const maxHp = num(p, 'maxHp', LIMITS.hp, w, num(p, 'hp', LIMITS.hp, [], 3));
    const hp = Math.min(maxHp, num(p, 'hp', LIMITS.hp, w, maxHp));
    const icon = oneOf<IconType>(p, 'iconType', ICON_TYPES, 'generic', w);
    return {
      ok: true,
      warnings: w,
      mutation: {
        type: 'SPAWN_UNIT',
        payload: {
          team: oneOf(p, 'team', TEAMS, 'red', w),
          name: str(p, 'name', 'Unknown Contact'),
          iconType: icon,
          hexCoords: pos,
          hp,
          maxHp,
          moveRange: num(p, 'moveRange', LIMITS.moveRange, w, 2),
          acquireRange: num(p, 'acquireRange', LIMITS.acquireRange, w, 0),
          acquirePower: num(p, 'acquirePower', LIMITS.acquirePower, w, 0),
          engageRange: num(p, 'engageRange', LIMITS.engageRange, w, 1),
          engagePower: num(p, 'engagePower', LIMITS.engagePower, w, 1),
          splashRadius: num(p, 'splashRadius', LIMITS.splashRadius, w, 0),
          domain,
          durationTurns: num(p, 'durationTurns', LIMITS.durationTurns, w, 0),
        },
      },
    };
  }

  if (type === 'MODIFY_GLOBAL_RULE') {
    const delta = num(p, 'delta', LIMITS.delta, w, 0);
    if (delta === 0) return { ok: false, error: 'Rule has no effect (delta 0).' };
    const stat = oneOf<ModifiableStat>(p, 'statModified', STATS, 'moveRange', w);
    const desc = str(p, 'description', `${stat} ${delta > 0 ? '+' : ''}${delta}`, 80);
    return {
      ok: true,
      warnings: w,
      mutation: {
        type: 'MODIFY_GLOBAL_RULE',
        payload: {
          ruleId: str(p, 'ruleId', desc.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30), 40),
          description: desc,
          targetDomain: oneOf<Domain | 'all'>(p, 'targetDomain', [...DOMAINS, 'all'], 'all', w),
          targetTeam: oneOf<Team | 'all'>(p, 'targetTeam', [...TEAMS, 'all'], 'all', w),
          statModified: stat,
          delta,
          durationTurns: num(p, 'durationTurns', LIMITS.durationTurns, w, 3),
        },
      },
    };
  }

  if (type === 'TRIGGER_EVENT') {
    const hex = coords(p.targetHex ?? p.hexCoords ?? p.hex);
    if (!hex || !inBounds(hex, s.map.cols, s.map.rows)) {
      return { ok: false, error: `Event target ${hex ? `(${hex.col},${hex.row})` : '(missing)'} is off-map.` };
    }
    return {
      ok: true,
      warnings: w,
      mutation: {
        type: 'TRIGGER_EVENT',
        payload: {
          eventName: str(p, 'eventName', 'Unknown Event'),
          targetHex: hex,
          radius: num(p, 'radius', LIMITS.radius, w, 1),
          damage: num(p, 'damage', LIMITS.damage, w, 2),
          terrainChange: oneOf(p, 'terrainChange', TERRAINS, 'none', w),
        },
      },
    };
  }

  if (type === 'CREATE_ZONE') {
    const hex = coords(p.targetHex ?? p.hexCoords ?? p.center ?? p.hex);
    if (!hex || !inBounds(hex, s.map.cols, s.map.rows)) {
      return { ok: false, error: `Zone center ${hex ? `(${hex.col},${hex.row})` : '(missing)'} is off-map.` };
    }
    const name = str(p, 'name', 'Strange Phenomenon');
    if ((s.zones ?? []).length >= MAX_ZONES && !(s.zones ?? []).some((z) => z.name === name)) {
      return { ok: false, error: `Too many zones on the board (max ${MAX_ZONES}). Wait for some to dissipate.` };
    }
    const mods: ZoneStatModifier[] = (Array.isArray(p.statModifiers) ? p.statModifiers : [])
      .filter(isObj)
      .slice(0, 4)
      .map((m) => ({ stat: oneOf<StatKey>(m, 'stat', STAT_KEYS, 'acquirePower', w), delta: num(m, 'delta', LIMITS.delta, w, 0) }))
      .filter((m) => m.delta !== 0);
    const damagePerTurn = num(p, 'damagePerTurn', [0, 5], w, 0);
    const blocksMovement = p.blocksMovement === true;
    if (!mods.length && !damagePerTurn && !blocksMovement) w.push('zone has no gameplay effect (cosmetic only)');
    return {
      ok: true,
      warnings: w,
      mutation: {
        type: 'CREATE_ZONE',
        payload: {
          name,
          targetHex: hex,
          radius: num(p, 'radius', LIMITS.radius, w, 1),
          durationTurns: num(p, 'durationTurns', LIMITS.durationTurns, w, 3),
          targetDomain: oneOf<Domain | 'all'>(p, 'targetDomain', [...DOMAINS, 'all'], 'all', w),
          targetTeam: oneOf<Team | 'all'>(p, 'targetTeam', [...TEAMS, 'all'], 'all', w),
          statModifiers: mods,
          damagePerTurn,
          blocksMovement,
          visual: oneOf<ZoneVisual>(p, 'visual', ZONE_VISUALS, 'generic', w),
        },
      },
    };
  }

  if (type === 'DEFINE_MECHANIC') {
    const v = validateMechanicDraft(p, w);
    return v.ok ? { ok: true, warnings: w, mutation: { type: 'DEFINE_MECHANIC', payload: v.draft } } : v;
  }

  return {
    ok: false,
    error: `Unknown mutation type "${String(raw.type)}". Expected SPAWN_UNIT, MODIFY_GLOBAL_RULE, TRIGGER_EVENT or DEFINE_MECHANIC.`,
  };
}

/** Sanity-check an imported save file before trusting it. */
export function validateImportedState(raw: unknown): { ok: true; state: GameState } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'File is not a JSON object.' };
  const st = isObj(raw.state) ? raw.state : raw;
  if (st.schemaVersion !== 1 && st.schemaVersion !== 2) return { ok: false, error: 'Unsupported or missing schemaVersion.' };
  if (!isObj(st.map) || !Array.isArray((st.map as Obj).tiles)) return { ok: false, error: 'Missing map.' };
  if (!Array.isArray(st.units) || !Array.isArray(st.eventLog) || !Array.isArray(st.activeRules)) {
    return { ok: false, error: 'Missing units / rules / log arrays.' };
  }
  for (const u of st.units as unknown[]) {
    if (!isObj(u) || typeof u.id !== 'string' || !isObj(u.pos) || typeof u.hp !== 'number') {
      return { ok: false, error: 'Corrupt unit record.' };
    }
  }
  if (!Array.isArray(st.scenarioDeck)) st.scenarioDeck = [];
  // Older saves predate mechanics; re-validate any mechanics the file carries.
  st.mechanics = validateMechanicList(st.mechanics, 'import');
  if (!Array.isArray(st.zones)) st.zones = [];
  for (const u of st.units as Obj[]) if (!isObj(u.resources)) u.resources = {};
  st.schemaVersion = 2;
  return { ok: true, state: st as unknown as GameState };
}

/** Validate a stored list of full Mechanic objects (save files, the localStorage library). */
export function validateMechanicList(raw: unknown, source: MutationSource): Mechanic[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m): Mechanic[] => {
    if (!isObj(m)) return [];
    const v = validateMechanicDraft(m, []);
    if (!v.ok) return [];
    return [
      {
        ...v.draft,
        id: typeof m.id === 'string' ? m.id : `m_${v.draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        enabled: m.enabled !== false,
        source: (['claude', 'ollama', 'api', 'local'] as const).find((x) => x === m.source) ?? source,
        prompt: typeof m.prompt === 'string' ? m.prompt : undefined,
        createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString(),
      },
    ];
  });
}

// ── DEFINE_MECHANIC ──────────────────────────────────────────────────────────

const MECH_LIMITS = { list: 8, inner: 6, amount: [-10, 10], range: [0, 6], value: [-50, 50], initial: [0, 20], max: [1, 50] } as const;
const OPS: CompareOp[] = ['<', '<=', '==', '>=', '>'];
const TARGETS: EffectTarget[] = ['self', 'friendlyInRange', 'enemiesInRange', 'allInRange'];
const RELATIONS: Relation[] = ['friendly', 'enemy', 'any'];
const ACTIONS: ActionRule['action'][] = ['move', 'acquire', 'engage'];
const MODES: ActionRule['mode'][] = ['block', 'unlimitedRange', 'ignoreTerrain'];

const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const resKey = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16);

function selector(v: unknown, w: string[]): Selector {
  const o = isObj(v) ? v : {};
  return {
    team: oneOf<TeamFilter>(o, 'team', [...TEAMS, 'all'], 'all', w),
    domain: oneOf<DomainFilter>(o, 'domain', [...DOMAINS, 'all'], 'all', w),
    iconType: oneOf<IconType | 'any'>(o, 'iconType', [...ICON_TYPES, 'any'], 'any', w),
  };
}

function condition(o: Obj, w: string[]): Condition | null {
  const kind = oneOf(o, 'kind', CONDITION_KINDS, 'resource', w);
  const negate = o.negate === true;
  switch (kind) {
    case 'resource': {
      const key = resKey(o.key);
      if (!key) return null;
      return { kind, negate, key, op: oneOf(o, 'op', OPS, '<=', w), value: num(o, 'value', MECH_LIMITS.value, w, 0) };
    }
    case 'hp':
    case 'turn':
      return { kind, negate, op: oneOf(o, 'op', OPS, '<=', w), value: num(o, 'value', MECH_LIMITS.value, w, 0) };
    case 'everyNTurns':
      return { kind, negate, value: num(o, 'value', [1, 12], w, 2) };
    case 'terrain':
      return { kind, negate, terrain: oneOf<Terrain>(o, 'terrain', ['sea', 'coast', 'land', 'city'], 'sea', w) };
    case 'nearUnit':
      return {
        kind,
        negate,
        relation: oneOf(o, 'relation', RELATIONS, 'enemy', w),
        domain: oneOf<DomainFilter>(o, 'domain', [...DOMAINS, 'all'], 'all', w),
        range: num(o, 'range', MECH_LIMITS.range, w, 1),
      };
    case 'nearCity':
      return { kind, negate, relation: oneOf(o, 'relation', RELATIONS, 'friendly', w), range: num(o, 'range', MECH_LIMITS.range, w, 1) };
  }
}

function effect(o: Obj, w: string[]): Effect | null {
  const kind = oneOf(o, 'kind', EFFECT_KINDS, 'log', w);
  const target = oneOf(o, 'target', TARGETS, 'self', w);
  const range = target === 'self' ? 0 : num(o, 'range', MECH_LIMITS.range, w, 1);
  const amount = num(o, 'amount', MECH_LIMITS.amount, w, 1);
  switch (kind) {
    case 'damage':
    case 'heal':
      return { kind, target, range, amount: Math.abs(amount) };
    case 'changeResource':
    case 'setResource': {
      const key = resKey(o.key);
      if (!key) return null;
      return { kind, target, range, key, amount: kind === 'setResource' ? Math.max(0, amount) : amount };
    }
    case 'changeStat':
      return { kind, target, range, stat: oneOf<StatKey>(o, 'stat', STAT_KEYS, 'engagePower', w), amount };
    case 'destroy':
      return { kind, target, range, text: str(o, 'text', '{unit} is lost.', 80) };
    case 'relocate':
      return { kind, target, range, to: oneOf(o, 'to', ['nearestFriendlyCity', 'nearestFreeHex'] as const, 'nearestFriendlyCity', w) };
    case 'resetActions':
      return { kind, target, range };
    case 'log':
      return { kind, text: str(o, 'text', 'Mechanic fired.', 100) };
    case 'spawn':
      return {
        kind,
        spawnTeam: oneOf(o, 'spawnTeam', ['same', 'enemy', 'neutral'] as const, 'same', w),
        spawnName: str(o, 'spawnName', 'Reinforcement', 24),
        spawnIcon: oneOf<IconType>(o, 'spawnIcon', ICON_TYPES, 'generic', w),
        spawnDomain: oneOf<Domain>(o, 'spawnDomain', DOMAINS, 'air', w),
        spawnHp: num(o, 'spawnHp', LIMITS.hp, w, 2),
        spawnMoveRange: num(o, 'spawnMoveRange', LIMITS.moveRange, w, 2),
        spawnEngageRange: num(o, 'spawnEngageRange', LIMITS.engageRange, w, 1),
        spawnEngagePower: num(o, 'spawnEngagePower', LIMITS.engagePower, w, 1),
      };
  }
}

const conds = (v: unknown, w: string[]) =>
  arr(v)
    .slice(0, MECH_LIMITS.inner)
    .map((c) => condition(c, w))
    .filter((c): c is Condition => !!c);

export function validateMechanicDraft(p: Obj, w: string[]): { ok: true; draft: MechanicDraft } | { ok: false; error: string } {
  const name = str(p, 'name', '', 40);
  if (!name) return { ok: false, error: 'Mechanic needs a name.' };
  const resources: ResourceDef[] = arr(p.resources)
    .slice(0, MECH_LIMITS.list)
    .map((r) => {
      const max = num(r, 'max', MECH_LIMITS.max, w, 5);
      return {
        key: resKey(r.key),
        label: str(r, 'label', resKey(r.key), 16),
        appliesTo: selector(r.appliesTo, w),
        initial: Math.min(max, num(r, 'initial', MECH_LIMITS.initial, w, 3)),
        max,
      };
    })
    .filter((r) => r.key);
  const triggers: TriggerRule[] = arr(p.triggers)
    .slice(0, MECH_LIMITS.list)
    .map((t) => ({
      on: oneOf<TriggerEvent>(t, 'on', TRIGGER_EVENTS, 'TURN_END', w),
      subject: selector(t.subject, w),
      conditions: conds(t.conditions, w),
      effects: arr(t.effects)
        .slice(0, MECH_LIMITS.inner)
        .map((e) => effect(e, w))
        .filter((e): e is Effect => !!e),
    }))
    .filter((t) => t.effects.length);
  const statRules: StatRule[] = arr(p.statRules)
    .slice(0, MECH_LIMITS.list)
    .map((r) => ({
      subject: selector(r.subject, w),
      conditions: conds(r.conditions, w),
      stat: oneOf<StatKey>(r, 'stat', STAT_KEYS, 'engagePower', w),
      delta: num(r, 'delta', LIMITS.delta, w, 0),
    }))
    .filter((r) => r.delta !== 0);
  const actionRules: ActionRule[] = arr(p.actionRules)
    .slice(0, MECH_LIMITS.list)
    .map((r) => ({
      subject: selector(r.subject, w),
      conditions: conds(r.conditions, w),
      action: oneOf(r, 'action', ACTIONS, 'move', w),
      mode: oneOf(r, 'mode', MODES, 'block', w),
      costResource: resKey(r.costResource),
      costAmount: num(r, 'costAmount', [0, 10], w, 0),
    }));
  if (!triggers.length && !statRules.length && !actionRules.length) {
    return { ok: false, error: `Mechanic "${name}" has no triggers, stat rules or action rules, so it would do nothing.` };
  }
  return {
    ok: true,
    draft: { name, description: str(p, 'description', name, 160), resources, triggers, statRules, actionRules },
  };
}

/**
 * Post-mutation invariant check. If a mutation (however it was produced) leaves the
 * game in a state the UI or engine can't handle, it is rolled back instead of applied.
 */
export function checkInvariants(s: GameState): string | null {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const seen = new Set<string>();
  for (const u of s.units) {
    if (!inBounds(u.pos, s.map.cols, s.map.rows)) return `${u.name} ended up off the map.`;
    const k = `${u.pos.col},${u.pos.row}`;
    if (seen.has(k)) return `Two units share hex ${k}.`;
    seen.add(k);
    for (const f of ['hp', 'maxHp', 'moveRange', 'acquireRange', 'acquirePower', 'engageRange', 'engagePower', 'splashRadius'] as const) {
      if (!finite(u[f])) return `${u.name} has an invalid ${f}.`;
    }
    if (u.hp > 99 || u.engagePower > 20 || u.moveRange > 20) return `${u.name} has out-of-range stats.`;
  }
  if (s.units.length > MAX_UNITS) return 'Too many units.';
  if ((s.zones ?? []).length > MAX_ZONES) return 'Too many zones.';
  for (const z of s.zones ?? []) if (!inBounds(z.center, s.map.cols, s.map.rows)) return `${z.name} is off the map.`;
  if (s.activeRules.length > 30) return 'Too many active rules.';
  return null;
}
