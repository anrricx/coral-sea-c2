// ─────────────────────────────────────────────────────────────────────────────
// Red Force AI. Deterministic heuristic planner: it pre-computes the whole Red
// turn as a list of intermediate states that the UI plays back with animation.
// ─────────────────────────────────────────────────────────────────────────────
import {
  acquire,
  acquireTargets,
  effective,
  endRound,
  engage,
  engageTargets,
  EngineError,
  getUnit,
  isConfirmed,
  moveUnit,
  needsAcquisition,
  reachableHexes,
  setPhase,
} from './engine';
import { hexDistance, key } from './hex';
import { zoneDamageAt } from './zones';
import type { EngineResult, Fx, GameState, HexCoord, Phase, Unit } from './types';

export interface AiStep {
  state: GameState;
  fx: Fx[];
  phase: Phase;
  /** Unit that acted, for camera/highlight purposes. */
  actorId?: string;
}

function attempt(fn: () => EngineResult): EngineResult | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof EngineError) return null;
    throw e;
  }
}

function priorityObjective(s: GameState, u: Unit): HexCoord | null {
  const hvts = s.units.filter((b) => b.team === 'blue' && b.isHVT);
  const city = s.map.tiles.find((t) => t.terrain === 'city' && t.owner === 'blue' && (t.cityHp ?? 0) > 0);
  const pool: HexCoord[] = [...hvts.map((h) => h.pos)];
  if (city && u.engageDomains.includes('land')) pool.push(city);
  if (!pool.length) pool.push(...s.units.filter((b) => b.team === 'blue').map((b) => b.pos));
  if (!pool.length) return null;
  return pool.reduce((best, p) => (hexDistance(u.pos, p) < hexDistance(u.pos, best) ? p : best));
}

function scoreHex(s: GameState, u: Unit, h: HexCoord, objective: HexCoord | null): number {
  let score = 0;
  if (objective) score -= hexDistance(h, objective) * 2;

  const blues = s.units.filter((b) => b.team !== 'red');
  // Attack opportunities from this hex (surface targets need no acquisition).
  for (const b of blues) {
    const d = hexDistance(h, b.pos);
    if (d > effective(s, u, 'engageRange') || !u.engageDomains.includes(b.domain)) continue;
    if (needsAcquisition(b)) score += 1.5; // possible if our sensors confirm it
    else score += b.isHVT ? 10 : 6;
  }
  const blueCity = s.map.tiles.find((t) => t.terrain === 'city' && t.owner === 'blue' && (t.cityHp ?? 0) > 0);
  if (blueCity && u.engageDomains.includes('land') && hexDistance(h, blueCity) <= effective(s, u, 'engageRange')) score += 5;

  // Threat: who could hit us next Blue turn? Air units are harder to hit (must be confirmed).
  let danger = 0;
  for (const b of blues) {
    if (b.team === 'neutral') continue;
    const reach = effective(s, b, 'engageRange') + effective(s, b, 'moveRange');
    if (hexDistance(h, b.pos) <= reach && b.engageDomains.includes(u.domain)) danger += effective(s, b, 'engagePower');
  }
  score -= zoneDamageAt(s, u, h) * 4; // stay out of radiation, fires, minefields
  const caution = u.hp <= Math.ceil(u.maxHp / 2) ? 1.2 : 0.35;
  score -= danger * caution * (u.domain === 'air' ? 0.6 : 1);
  return score;
}

export function planRedTurn(start: GameState): AiStep[] {
  const steps: AiStep[] = [];
  let s = setPhase(start, 'red', 'MOVE');
  steps.push({ state: s, fx: [], phase: 'MOVE' });

  // ── MOVE ──
  const redIds = s.units.filter((u) => u.team === 'red').map((u) => u.id).sort();
  for (const id of redIds) {
    const u = getUnit(s, id);
    if (!u || s.winner) continue;
    const reach = reachableHexes(s, u);
    const objective = priorityObjective(s, u);
    let best: HexCoord = u.pos;
    let bestScore = scoreHex(s, u, u.pos, objective);
    for (const k of [...reach.keys()].sort()) {
      const [col, row] = k.split(',').map(Number);
      const sc = scoreHex(s, u, { col, row }, objective);
      if (sc > bestScore + 0.01) [best, bestScore] = [{ col, row }, sc];
    }
    if (key(best) !== key(u.pos)) {
      const r = attempt(() => moveUnit(s, id, best));
      if (r) {
        s = r.state;
        steps.push({ state: s, fx: r.fx, phase: 'MOVE', actorId: id });
      }
    }
  }

  // ── ACQUIRE ──
  s = setPhase(s, 'red', 'ACQUIRE');
  steps.push({ state: s, fx: [], phase: 'ACQUIRE' });
  const sensors = s.units
    .filter((u) => u.team === 'red' && effective(s, u, 'acquirePower') > 0)
    .sort((a, b) => effective(s, b, 'acquirePower') - effective(s, a, 'acquirePower') || a.id.localeCompare(b.id));
  for (const sensor of sensors) {
    if (s.winner) break;
    const live = getUnit(s, sensor.id);
    if (!live) continue;
    const targets = acquireTargets(s, live);
    if (!targets.length) continue;
    const shooters = s.units.filter((r) => r.team === 'red' && effective(s, r, 'engageRange') > 0);
    const rank = (t: Unit) =>
      t.acquirePoints * 10 +
      shooters.filter((r) => r.engageDomains.includes(t.domain) && hexDistance(r.pos, t.pos) <= effective(s, r, 'engageRange')).length * 4 -
      t.hp +
      (t.iconType === 'aew' ? 3 : 0);
    const target = [...targets].sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))[0];
    const r = attempt(() => acquire(s, live.id, target.id));
    if (r) {
      s = r.state;
      steps.push({ state: s, fx: r.fx, phase: 'ACQUIRE', actorId: live.id });
    }
  }

  // ── ENGAGE ──
  s = setPhase(s, 'red', 'ENGAGE');
  steps.push({ state: s, fx: [], phase: 'ENGAGE' });
  for (const id of s.units.filter((u) => u.team === 'red').map((u) => u.id).sort()) {
    if (s.winner) break;
    const u = getUnit(s, id);
    if (!u) continue;
    const { units, cities } = engageTargets(s, u);
    const dmg = effective(s, u, 'engagePower');
    type Opt = { score: number; target: { unitId?: string; hex?: HexCoord } };
    const opts: Opt[] = [
      ...units.map((t) => ({
        score: dmg + (dmg >= t.hp ? 8 : 0) + (t.isHVT ? 6 : 0) + (t.team === 'neutral' ? -20 : 0) + (isConfirmed(t) ? 1 : 0),
        target: { unitId: t.id },
      })),
      ...cities.map((c) => ({ score: dmg + 4, target: { hex: { col: c.col, row: c.row } } })),
    ].filter((o) => o.score > 0);
    if (!opts.length) continue;
    opts.sort((a, b) => b.score - a.score);
    const r = attempt(() => engage(s, id, opts[0].target));
    if (r) {
      s = r.state;
      steps.push({ state: s, fx: r.fx, phase: 'ENGAGE', actorId: id });
    }
  }

  // ── END TURN (hazards, durations, decay) ──
  if (!s.winner) {
    const r = endRound(s);
    steps.push({ state: r.state, fx: r.fx, phase: 'END_TURN' });
  }
  return steps;
}
