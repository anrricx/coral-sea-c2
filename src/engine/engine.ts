// ─────────────────────────────────────────────────────────────────────────────
// Deterministic rules engine. Every function is pure: it takes a GameState and
// returns a NEW GameState plus visual Fx cues. No randomness, no DOM, no React.
// ─────────────────────────────────────────────────────────────────────────────
import { hexDistance, hexesWithin, inBounds, key, neighbors, sameHex } from './hex';
import { makeUnit } from './scenario';
import { isBlocked, moveRules, runTriggers, statDelta, syncResources } from './mechanics';
import { inZone, zoneBlocksEntry, zoneDelta, zoneTargets } from './zones';
import type {
  ActiveRule,
  Domain,
  EngineResult,
  Fx,
  GameMutation,
  GameState,
  HexCoord,
  HexTile,
  LogEntry,
  Mechanic,
  MechanicDraft,
  ModifiableStat,
  MutationSource,
  Phase,
  StatKey,
  Team,
  Terrain,
  Unit,
  Zone,
} from './types';
import { PHASES } from './types';

export const CONFIRM_THRESHOLD = 3;

// ── Queries ──────────────────────────────────────────────────────────────────

export const clone = (s: GameState): GameState => structuredClone(s);

export function tileAt(s: GameState, h: HexCoord): HexTile | undefined {
  return s.map.tiles.find((t) => t.col === h.col && t.row === h.row);
}

export function unitAt(s: GameState, h: HexCoord): Unit | undefined {
  return s.units.find((u) => sameHex(u.pos, h));
}

export function getUnit(s: GameState, id: string): Unit | undefined {
  return s.units.find((u) => u.id === id);
}

export function canOccupy(domain: Domain, terrain: Terrain): boolean {
  if (domain === 'air') return true;
  if (domain === 'sea') return terrain === 'sea';
  return terrain !== 'sea';
}

export const isHostile = (a: Unit, b: Unit) => a.team !== b.team;
export const needsAcquisition = (u: Unit) => u.domain === 'air' || u.stealth;
export const isConfirmed = (u: Unit) => u.acquirePoints >= CONFIRM_THRESHOLD;

export function rulesAffecting(s: GameState, u: Unit, stat: ModifiableStat): ActiveRule[] {
  return s.activeRules.filter(
    (r) =>
      r.statModified === stat &&
      (r.targetDomain === 'all' || r.targetDomain === u.domain) &&
      (r.targetTeam === 'all' || r.targetTeam === u.team),
  );
}

/** Base stat + active global rules + custom mechanic stat rules, floored at 0. */
export function effective(s: GameState, u: Unit, stat: StatKey): number {
  const base = u[stat];
  const global =
    stat === 'engageRange' || stat === 'acquireRange'
      ? 0
      : rulesAffecting(s, u, stat).reduce((acc, r) => acc + r.delta, 0);
  return Math.max(0, base + global + statDelta(s, u, stat) + zoneDelta(s, u, stat));
}

/**
 * Hexes the unit can move to this phase → path cost. Excludes its own hex.
 * `special: false` ignores mechanic movement powers (used to detect when one was needed).
 */
export function reachableHexes(s: GameState, u: Unit, opts: { special?: boolean } = {}): Map<string, number> {
  const out = new Map<string, number>();
  const rules = moveRules(s, u);
  if (rules.blocked) return out;
  const special = opts.special !== false;
  const range = special && rules.unlimited ? 99 : effective(s, u, 'moveRange');
  const moveDomain: Domain = special && rules.ignoreTerrain ? 'air' : u.domain;
  if (range <= 0) return out;
  const { cols, rows } = s.map;
  const seen = new Map<string, number>([[key(u.pos), 0]]);
  let frontier: HexCoord[] = [u.pos];
  for (let step = 1; step <= range; step++) {
    const next: HexCoord[] = [];
    for (const h of frontier) {
      for (const n of neighbors(h, cols, rows)) {
        const k = key(n);
        if (seen.has(k)) continue;
        const tile = tileAt(s, n);
        if (!tile || !canOccupy(moveDomain, tile.terrain)) continue;
        if (zoneBlocksEntry(s, u, n)) continue;
        const occ = unitAt(s, n);
        // Surface units can't push through hostile units; aircraft overfly.
        if (occ && isHostile(occ, u) && moveDomain !== 'air') continue;
        seen.set(k, step);
        next.push(n);
        if (!occ) out.set(k, step);
      }
    }
    frontier = next;
  }
  return out;
}

export function acquireTargets(s: GameState, sensor: Unit): Unit[] {
  const range = effective(s, sensor, 'acquireRange');
  if (range <= 0 || effective(s, sensor, 'acquirePower') <= 0 || isBlocked(s, sensor, 'acquire')) return [];
  return s.units.filter(
    (t) => isHostile(sensor, t) && needsAcquisition(t) && !isConfirmed(t) && hexDistance(sensor.pos, t.pos) <= range,
  );
}

export function engageTargets(s: GameState, atk: Unit): { units: Unit[]; cities: HexTile[] } {
  const range = effective(s, atk, 'engageRange');
  if (range <= 0 || effective(s, atk, 'engagePower') <= 0 || isBlocked(s, atk, 'engage')) return { units: [], cities: [] };
  const units = s.units.filter(
    (t) =>
      isHostile(atk, t) &&
      atk.engageDomains.includes(t.domain) &&
      (!needsAcquisition(t) || isConfirmed(t)) &&
      hexDistance(atk.pos, t.pos) <= range,
  );
  const cities = atk.engageDomains.includes('land')
    ? s.map.tiles.filter(
        (t) =>
          t.terrain === 'city' &&
          t.owner !== atk.team &&
          t.owner !== 'neutral' &&
          (t.cityHp ?? 0) > 0 &&
          !unitAt(s, t) &&
          hexDistance(atk.pos, t) <= range,
      )
    : [];
  return { units, cities };
}

/** Can this unit still do something in the current phase? */
export function canActNow(s: GameState, u: Unit): boolean {
  if (u.team !== s.activeTeam || s.winner) return false;
  switch (s.phase) {
    case 'MOVE':
      return !u.hasMoved && reachableHexes(s, u).size > 0;
    case 'ACQUIRE':
      return !u.hasAcquired && acquireTargets(s, u).length > 0;
    case 'ENGAGE': {
      if (u.hasEngaged) return false;
      const t = engageTargets(s, u);
      return t.units.length + t.cities.length > 0;
    }
    default:
      return false;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function nextId(s: GameState, prefix: string): string {
  const id = `${prefix}${s.nextId}`;
  s.nextId += 1;
  return id;
}

export function log(s: GameState, e: Omit<LogEntry, 'id' | 'turn' | 'phase'>): void {
  s.eventLog.push({ id: nextId(s, 'l'), turn: s.turn, phase: s.phase, ...e });
  if (s.eventLog.length > 400) s.eventLog.splice(0, s.eventLog.length - 400);
}

const fail = (msg: string): never => {
  throw new EngineError(msg);
};

export class EngineError extends Error {}

/** Applies damage to a unit in-place; removes it if destroyed (and fires UNIT_DESTROYED). */
export function damageUnit(s: GameState, u: Unit, amount: number, fx: Fx[], cause: string, depth = 0): void {
  if (amount <= 0) return;
  u.hp = Math.max(0, u.hp - amount);
  fx.push({ kind: 'damage', at: { ...u.pos }, amount, team: u.team });
  if (u.hp <= 0) {
    s.units = s.units.filter((x) => x.id !== u.id);
    fx.push({ kind: 'destroyed', at: { ...u.pos }, team: u.team });
    log(s, { team: u.team, kind: 'destroyed', text: `${u.name} DESTROYED (${cause}).` });
    runTriggers(s, 'UNIT_DESTROYED', u, fx, depth);
  }
}

function damageCity(s: GameState, t: HexTile, amount: number, fx: Fx[]): void {
  if (t.terrain !== 'city' || t.cityHp === undefined || amount <= 0) return;
  t.cityHp = Math.max(0, t.cityHp - amount);
  fx.push({ kind: 'damage', at: { col: t.col, row: t.row }, amount, team: t.owner });
  if (t.cityHp === 0) {
    fx.push({ kind: 'destroyed', at: { col: t.col, row: t.row }, team: t.owner });
    log(s, { team: t.owner ?? 'system', kind: 'destroyed', text: `${t.name} has FALLEN.` });
  }
}

export function checkVictory(s: GameState): void {
  if (s.winner) return;
  const blueHvtAlive = s.units.some((u) => u.team === 'blue' && u.isHVT);
  const blueCity = s.map.tiles.find((t) => t.terrain === 'city' && t.owner === 'blue');
  const redCity = s.map.tiles.find((t) => t.terrain === 'city' && t.owner === 'red');
  const redAlive = s.units.some((u) => u.team === 'red');
  let w: Team | null = null;
  let why = '';
  if (!blueHvtAlive) [w, why] = ['red', 'The Amphibious Task Group was destroyed.'];
  else if (blueCity && blueCity.cityHp === 0) [w, why] = ['red', `${blueCity.name} has fallen.`];
  else if (redCity && redCity.cityHp === 0) [w, why] = ['blue', `${redCity.name} neutralised.`];
  else if (!redAlive) [w, why] = ['blue', 'Red Force eliminated.'];
  else if (s.turn > s.maxTurns) [w, why] = ['blue', `Blue held the line for ${s.maxTurns} turns.`];
  if (w) {
    s.winner = w;
    s.winReason = why;
    log(s, { team: 'system', kind: 'system', text: `MATCH OVER — ${w.toUpperCase()} FORCE VICTORY. ${why}` });
  }
}

function assertCanAct(s: GameState, u: Unit | undefined, phase: Phase): Unit {
  if (s.winner) fail('The match is over.');
  if (!u) return fail('Unit not found.');
  if (s.phase !== phase) fail(`Not in ${phase} phase.`);
  if (u.team !== s.activeTeam) fail(`${u.name} is not under your command this turn.`);
  return u;
}

// ── Player / AI actions ──────────────────────────────────────────────────────

export function moveUnit(state: GameState, unitId: string, to: HexCoord): EngineResult {
  const s = clone(state);
  const u = assertCanAct(s, getUnit(s, unitId), 'MOVE');
  if (u.hasMoved) fail(`${u.name} has already moved.`);
  if (!reachableHexes(s, u).has(key(to))) fail('Hex is out of range or impassable.');
  // Was a mechanic power (teleport, terrain-ignoring...) needed for this move? Pay its cost.
  const fx: Fx[] = [];
  if (!reachableHexes(s, u, { special: false }).has(key(to))) {
    const r = moveRules(s, u);
    const used = r.unlimited ?? r.ignoreTerrain;
    if (used?.costResource) u.resources[used.costResource] = Math.max(0, (u.resources[used.costResource] ?? 0) - used.costAmount);
    fx.push({ kind: 'spawn', at: { ...to }, team: u.team });
  }
  const from = u.pos;
  u.pos = { ...to };
  u.hasMoved = true;
  log(s, { team: u.team, kind: 'move', text: `${u.name} (${from.col},${from.row}) → (${to.col},${to.row})` });
  runTriggers(s, 'AFTER_MOVE', u, fx);
  checkVictory(s);
  return { state: s, fx };
}

export function acquire(state: GameState, sensorId: string, targetId: string): EngineResult {
  const s = clone(state);
  const sensor = assertCanAct(s, getUnit(s, sensorId), 'ACQUIRE');
  if (sensor.hasAcquired) fail(`${sensor.name} has already used its sensors.`);
  const target = getUnit(s, targetId);
  if (!target || !acquireTargets(s, sensor).some((t) => t.id === targetId)) fail('No valid track on that target.');
  const pts = effective(s, sensor, 'acquirePower');
  target!.acquirePoints = Math.min(9, target!.acquirePoints + pts);
  sensor.hasAcquired = true;
  const confirmed = isConfirmed(target!);
  log(s, {
    team: sensor.team,
    kind: 'acquire',
    text: `${sensor.name} tracks ${target!.name}: +${pts} → ${target!.acquirePoints}/${CONFIRM_THRESHOLD}${confirmed ? ' — CONFIRMED' : ''}`,
  });
  const fx: Fx[] = [{ kind: 'ping', at: { ...target!.pos }, team: sensor.team, amount: confirmed ? 1 : 0 }];
  runTriggers(s, 'AFTER_ACQUIRE', sensor, fx);
  checkVictory(s);
  return { state: s, fx };
}

export function engage(state: GameState, attackerId: string, target: { unitId?: string; hex?: HexCoord }): EngineResult {
  const s = clone(state);
  const atk = assertCanAct(s, getUnit(s, attackerId), 'ENGAGE');
  if (atk.hasEngaged) fail(`${atk.name} has already engaged.`);
  const valid = engageTargets(s, atk);
  const fx: Fx[] = [];
  const dmg = effective(s, atk, 'engagePower');
  let impact: HexCoord;

  if (target.unitId) {
    const t = valid.units.find((u) => u.id === target.unitId);
    if (!t) return fail('Target not engageable (out of range, wrong domain, or not CONFIRMED).');
    impact = { ...t.pos };
    log(s, { team: atk.team, kind: 'engage', text: `${atk.name} engages ${t.name} for ${dmg}.` });
    fx.push({ kind: 'explosion', at: impact, team: atk.team, radius: atk.splashRadius });
    damageUnit(s, t, dmg, fx, `engaged by ${atk.name}`);
  } else if (target.hex) {
    const c = valid.cities.find((t) => sameHex(t, target.hex!));
    if (!c) return fail('City not in range.');
    impact = { col: c.col, row: c.row };
    log(s, { team: atk.team, kind: 'engage', text: `${atk.name} strikes ${c.name} for ${dmg}.` });
    fx.push({ kind: 'explosion', at: impact, team: atk.team, radius: atk.splashRadius });
    damageCity(s, c, dmg, fx);
  } else {
    return fail('No target.');
  }

  if (atk.splashRadius > 0) {
    const splashed = s.units.filter(
      (u) => isHostile(atk, u) && !sameHex(u.pos, impact) && hexDistance(u.pos, impact) <= atk.splashRadius,
    );
    for (const u of splashed) damageUnit(s, u, dmg, fx, `splash from ${atk.name}`);
  }

  // The attacker may have been removed by nothing here, but guard anyway.
  const stillThere = getUnit(s, atk.id);
  if (stillThere) {
    stillThere.hasEngaged = true;
    runTriggers(s, 'AFTER_ENGAGE', stillThere, fx);
  }
  checkVictory(s);
  return { state: s, fx };
}

export function setPhase(state: GameState, team: Team, phase: Phase): GameState {
  const s = clone(state);
  s.activeTeam = team;
  s.phase = phase;
  return s;
}

/** Blue-side phase advance. END_TURN is where the app hands control to the AI. */
export function advancePhase(state: GameState): GameState {
  const s = clone(state);
  const i = PHASES.indexOf(s.phase);
  s.phase = PHASES[Math.min(i + 1, PHASES.length - 1)];
  return s;
}

/** Environmental hazards act, durations tick, acquisition decays, turn advances. */
export function endRound(state: GameState): EngineResult {
  const s = clone(state);
  const fx: Fx[] = [];
  s.phase = 'END_TURN';
  s.activeTeam = 'neutral';

  // 1. Environmental hazards (amber) strike everything near them, then drift.
  for (const hz of s.units.filter((u) => u.team === 'neutral')) {
    if (!getUnit(s, hz.id)) continue;
    const power = effective(s, hz, 'engagePower');
    if (power > 0 && hz.engageRange > 0) {
      const victims = s.units.filter((u) => u.team !== 'neutral' && hexDistance(u.pos, hz.pos) <= hz.engageRange);
      if (victims.length) {
        log(s, { team: 'neutral', kind: 'hazard', text: `${hz.name} batters ${victims.length} unit(s) for ${power}.` });
        fx.push({ kind: 'hazard', at: { ...hz.pos }, radius: hz.engageRange });
        for (const v of victims) damageUnit(s, v, power, fx, hz.name);
      }
    }
    const reach = reachableHexes(s, hz);
    const prey = s.units.filter((u) => u.team !== 'neutral');
    if (reach.size && prey.length) {
      const nearest = (h: HexCoord) => Math.min(...prey.map((p) => hexDistance(h, p.pos)));
      let best: HexCoord | null = null;
      let bestScore = nearest(hz.pos);
      for (const k of [...reach.keys()].sort()) {
        const [c, r] = k.split(',').map(Number);
        const d = nearest({ col: c, row: r });
        if (d < bestScore) [best, bestScore] = [{ col: c, row: r }, d];
      }
      if (best) hz.pos = best;
    }
  }

  // 1a. Zones: damage what's inside, then tick down.
  for (const z of s.zones ?? []) {
    if (z.damagePerTurn <= 0) continue;
    const victims = s.units.filter((u) => zoneTargets(z, u) && inZone(z, u.pos));
    if (victims.length) {
      log(s, { team: 'neutral', kind: 'hazard', text: `${z.name} hits ${victims.length} unit(s) for ${z.damagePerTurn}.` });
      fx.push({ kind: 'hazard', at: { ...z.center }, radius: z.radius });
      for (const v of victims) damageUnit(s, v, z.damagePerTurn, fx, z.name);
    }
  }
  s.zones = (s.zones ?? []).filter((z) => {
    if (z.turnsRemaining === null) return true;
    z.turnsRemaining -= 1;
    if (z.turnsRemaining <= 0) log(s, { team: 'system', kind: 'system', text: `${z.name} dissipates.` });
    return z.turnsRemaining > 0;
  });

  // 1b. Custom mechanics: end-of-turn triggers (fuel burn, attrition, repairs...).
  runTriggers(s, 'TURN_END', null, fx);

  // 2. Tick unit durations.
  for (const u of [...s.units]) {
    if (u.durationTurns === null) continue;
    u.durationTurns -= 1;
    if (u.durationTurns <= 0) {
      s.units = s.units.filter((x) => x.id !== u.id);
      fx.push({ kind: 'spawn', at: { ...u.pos }, team: u.team });
      log(s, { team: u.team, kind: 'system', text: `${u.name} expired.` });
    }
  }

  // 3. Tick global rules.
  const expired: ActiveRule[] = [];
  s.activeRules = s.activeRules.filter((r) => {
    if (r.turnsRemaining === null) return true;
    r.turnsRemaining -= 1;
    if (r.turnsRemaining <= 0) expired.push(r);
    return r.turnsRemaining > 0;
  });
  for (const r of expired) log(s, { team: 'system', kind: 'system', text: `Modifier lapsed: ${r.description}` });

  // 4. Acquisition decays; action flags reset.
  for (const u of s.units) {
    u.acquirePoints = 0;
    u.hasMoved = u.hasAcquired = u.hasEngaged = false;
  }

  s.turn += 1;
  checkVictory(s);
  s.phase = 'MOVE';
  s.activeTeam = 'blue';
  if (!s.winner) {
    log(s, { team: 'system', kind: 'system', text: `── TURN ${s.turn} ── Blue Force has the initiative.` });
    runTriggers(s, 'TURN_START', null, fx);
    checkVictory(s);
  }
  return { state: s, fx };
}

// ── Scenario mutations ───────────────────────────────────────────────────────

/** Applies an ALREADY-VALIDATED mutation (see validate.ts). */
export function applyMutation(
  state: GameState,
  m: GameMutation,
  meta: { source: MutationSource; prompt?: string },
): EngineResult {
  const s = clone(state);
  const fx: Fx[] = [];
  const base = { kind: 'mutation' as const, mutation: m, source: meta.source, prompt: meta.prompt };

  switch (m.type) {
    case 'SPAWN_UNIT': {
      const p = m.payload;
      const u = makeUnit(nextId(s, 'u'), {
        team: p.team,
        name: p.name,
        iconType: p.iconType,
        domain: p.domain,
        col: p.hexCoords.col,
        row: p.hexCoords.row,
        hp: p.maxHp,
        moveRange: p.moveRange,
        acquireRange: p.acquireRange,
        acquirePower: p.acquirePower,
        engageRange: p.engageRange,
        engagePower: p.engagePower,
        splashRadius: p.splashRadius,
        engageDomains: p.iconType === 'missile_battery' ? ['sea', 'land'] : ['sea', 'land', 'air'],
        stealth: p.iconType === 'submarine',
      });
      u.hp = p.hp;
      u.durationTurns = p.durationTurns > 0 ? p.durationTurns : null;
      u.spawnedBy = meta.source;
      // Freshly-spawned units for the active side may still act this turn.
      s.units.push(u);
      syncResources(s);
      fx.push({ kind: 'spawn', at: { ...u.pos }, team: u.team });
      log(s, {
        ...base,
        team: u.team,
        text: `INJECT ▸ ${u.team.toUpperCase()} ${u.name} deployed at (${u.pos.col},${u.pos.row})${u.durationTurns ? ` for ${u.durationTurns} turns` : ''}.`,
      });
      break;
    }
    case 'MODIFY_GLOBAL_RULE': {
      const p = m.payload;
      const rule: ActiveRule = {
        id: nextId(s, 'r'),
        ruleId: p.ruleId,
        description: p.description,
        targetDomain: p.targetDomain,
        targetTeam: p.targetTeam,
        statModified: p.statModified,
        delta: p.delta,
        turnsRemaining: p.durationTurns > 0 ? p.durationTurns : null,
      };
      s.activeRules = s.activeRules.filter((r) => r.ruleId !== p.ruleId);
      s.activeRules.push(rule);
      log(s, { ...base, team: 'system', text: `INJECT ▸ Global modifier: ${p.description} (${p.statModified} ${p.delta > 0 ? '+' : ''}${p.delta}).` });
      break;
    }
    case 'TRIGGER_EVENT': {
      const p = m.payload;
      const area = hexesWithin(p.targetHex, p.radius, s.map.cols, s.map.rows);
      log(s, { ...base, team: 'neutral', text: `INJECT ▸ ${p.eventName} at (${p.targetHex.col},${p.targetHex.row}), radius ${p.radius}, ${p.damage} dmg.` });
      fx.push({ kind: 'hazard', at: { ...p.targetHex }, radius: p.radius });
      for (const h of area) {
        const tile = tileAt(s, h)!;
        if (p.terrainChange !== 'none' && tile.terrain !== 'city' && p.terrainChange !== 'city') {
          tile.terrain = p.terrainChange;
        }
        const u = unitAt(s, h);
        if (u) damageUnit(s, u, p.damage, fx, p.eventName);
        if (tile.terrain === 'city') damageCity(s, tile, p.damage, fx);
      }
      checkVictory(s);
      break;
    }
    case 'CREATE_ZONE': {
      const p = m.payload;
      const zone: Zone = {
        id: nextId(s, 'z'),
        name: p.name,
        center: { ...p.targetHex },
        radius: p.radius,
        turnsRemaining: p.durationTurns > 0 ? p.durationTurns : null,
        targetDomain: p.targetDomain,
        targetTeam: p.targetTeam,
        statModifiers: p.statModifiers.map((x) => ({ ...x })),
        damagePerTurn: p.damagePerTurn,
        blocksMovement: p.blocksMovement,
        visual: p.visual,
        source: meta.source,
        prompt: meta.prompt,
      };
      s.zones = [...(s.zones ?? []).filter((z) => z.name !== zone.name), zone];
      const effects = [
        ...zone.statModifiers.map((x) => `${x.stat} ${x.delta > 0 ? '+' : ''}${x.delta}`),
        zone.damagePerTurn ? `${zone.damagePerTurn} dmg/turn` : '',
        zone.blocksMovement ? 'impassable' : '',
      ].filter(Boolean);
      log(s, {
        ...base,
        team: 'neutral',
        text: `INJECT ▸ ${zone.name} covers (${zone.center.col},${zone.center.row}) r${zone.radius}: ${effects.join(', ') || 'cosmetic'}.`,
      });
      fx.push({ kind: 'hazard', at: { ...zone.center }, radius: zone.radius });
      break;
    }
    case 'DEFINE_MECHANIC': {
      const mech = draftToMechanic(m.payload, meta);
      s.mechanics = [...(s.mechanics ?? []).filter((x) => x.id !== mech.id), mech];
      syncResources(s);
      log(s, { ...base, team: 'system', text: `NEW MECHANIC ▸ ${mech.name}: ${mech.description}` });
      break;
    }
  }

  s.scenarioDeck.push({ turn: s.turn, prompt: meta.prompt, source: meta.source, mutation: m });
  return { state: s, fx };
}

/** Nearest free hex legal for a domain, searching outward from `h`. */
export function nearestFreeHex(s: GameState, h: HexCoord, domain: Domain, maxRadius = 3): HexCoord | null {
  for (let r = 0; r <= maxRadius; r++) {
    const ring = hexesWithin(h, r, s.map.cols, s.map.rows).filter((x) => hexDistance(x, h) === r);
    ring.sort((a, b) => a.col - b.col || a.row - b.row);
    for (const c of ring) {
      const t = tileAt(s, c);
      if (t && inBounds(c, s.map.cols, s.map.rows) && canOccupy(domain, t.terrain) && !unitAt(s, c)) return c;
    }
  }
  return null;
}

export const mechanicId = (name: string) =>
  `m_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}`;

export function draftToMechanic(d: MechanicDraft, meta: { source: MutationSource; prompt?: string }): Mechanic {
  return {
    ...structuredClone(d),
    id: mechanicId(d.name),
    enabled: true,
    source: meta.source,
    prompt: meta.prompt,
    createdAt: new Date().toISOString(),
  };
}
