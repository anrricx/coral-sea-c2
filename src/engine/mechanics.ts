// ─────────────────────────────────────────────────────────────────────────────
// Mechanics runtime. A Mechanic is pure data (see types.ts) assembled from the
// building blocks below. The engine calls in here at fixed hook points:
//   effective()        → statDelta()        continuous stat bonuses/penalties
//   reachableHexes()   → moveRules()        block / unlimited range / ignore terrain
//   acquire/engage     → isBlocked()
//   move/acquire/engage/destroyed/turn start/turn end → runTriggers()
// Nothing here executes user- or AI-supplied code; it only interprets data.
// ─────────────────────────────────────────────────────────────────────────────
import { damageUnit, getUnit, log, nearestFreeHex, tileAt } from './engine';
import { hexDistance } from './hex';
import { makeUnit } from './scenario';
import type {
  ActionRule,
  CompareOp,
  Condition,
  Effect,
  EffectTarget,
  Fx,
  GameState,
  Mechanic,
  Relation,
  Selector,
  StatKey,
  TriggerEvent,
  Unit,
} from './types';

export const MAX_UNITS = 40;
const MAX_TRIGGER_DEPTH = 3;

export const activeMechanics = (s: GameState): Mechanic[] => (s.mechanics ?? []).filter((m) => m.enabled);

export function matchesSelector(u: Unit, sel: Selector): boolean {
  return (
    (sel.team === 'all' || sel.team === u.team) &&
    (sel.domain === 'all' || sel.domain === u.domain) &&
    (sel.iconType === 'any' || sel.iconType === u.iconType)
  );
}

function related(a: Unit, b: Unit, rel: Relation): boolean {
  if (rel === 'any') return true;
  return rel === 'friendly' ? a.team === b.team : a.team !== b.team;
}

function compare(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '==': return a === b;
    case '>=': return a >= b;
    case '>': return a > b;
  }
}

export function evalCondition(s: GameState, u: Unit, c: Condition): boolean {
  let ok: boolean;
  switch (c.kind) {
    case 'resource':
      ok = compare(u.resources?.[c.key] ?? 0, c.op, c.value);
      break;
    case 'hp':
      ok = compare(u.hp, c.op, c.value);
      break;
    case 'terrain':
      ok = tileAt(s, u.pos)?.terrain === c.terrain;
      break;
    case 'turn':
      ok = compare(s.turn, c.op, c.value);
      break;
    case 'everyNTurns':
      ok = c.value > 0 && s.turn % c.value === 0;
      break;
    case 'nearUnit':
      ok = s.units.some(
        (o) =>
          o.id !== u.id &&
          related(u, o, c.relation) &&
          (c.domain === 'all' || o.domain === c.domain) &&
          hexDistance(u.pos, o.pos) <= c.range,
      );
      break;
    case 'nearCity':
      ok = s.map.tiles.some(
        (t) =>
          t.terrain === 'city' &&
          (t.cityHp ?? 0) > 0 &&
          (c.relation === 'any' || (c.relation === 'friendly' ? t.owner === u.team : t.owner !== u.team)) &&
          hexDistance(u.pos, t) <= c.range,
      );
      break;
  }
  return c.negate ? !ok : ok;
}

export const conditionsHold = (s: GameState, u: Unit, cs: Condition[]) => cs.every((c) => evalCondition(s, u, c));

// ── Continuous rules ─────────────────────────────────────────────────────────

export function statDelta(s: GameState, u: Unit, stat: StatKey): number {
  let d = 0;
  for (const m of activeMechanics(s)) {
    for (const r of m.statRules) {
      if (r.stat === stat && matchesSelector(u, r.subject) && conditionsHold(s, u, r.conditions)) d += r.delta;
    }
  }
  return d;
}

export function actionRules(s: GameState, u: Unit, action: ActionRule['action']): ActionRule[] {
  const out: ActionRule[] = [];
  for (const m of activeMechanics(s)) {
    for (const r of m.actionRules) {
      if (r.action === action && matchesSelector(u, r.subject) && conditionsHold(s, u, r.conditions)) out.push(r);
    }
  }
  return out;
}

export const isBlocked = (s: GameState, u: Unit, action: ActionRule['action']) =>
  actionRules(s, u, action).some((r) => r.mode === 'block');

export function moveRules(s: GameState, u: Unit) {
  const rules = actionRules(s, u, 'move');
  return {
    blocked: rules.some((r) => r.mode === 'block'),
    unlimited: rules.find((r) => r.mode === 'unlimitedRange'),
    ignoreTerrain: rules.find((r) => r.mode === 'ignoreTerrain'),
  };
}

// ── Resources ────────────────────────────────────────────────────────────────

/** Give every unit the starting value of each resource that applies to it. Mutates. */
export function syncResources(s: GameState): void {
  const defs = activeMechanics(s).flatMap((m) => m.resources);
  for (const u of s.units) {
    u.resources ??= {};
    for (const d of defs) {
      if (matchesSelector(u, d.appliesTo) && u.resources[d.key] === undefined) u.resources[d.key] = d.initial;
    }
  }
}

export function resourceDefsFor(s: GameState, u: Unit) {
  return activeMechanics(s)
    .flatMap((m) => m.resources)
    .filter((d) => matchesSelector(u, d.appliesTo));
}

function clampResource(s: GameState, key: string, v: number): number {
  const def = activeMechanics(s).flatMap((m) => m.resources).find((d) => d.key === key);
  return Math.max(0, Math.min(def?.max ?? 99, v));
}

// ── Triggers & effects ───────────────────────────────────────────────────────

function targetsOf(s: GameState, actor: Unit, target: EffectTarget, range: number): Unit[] {
  if (target === 'self') {
    const live = getUnit(s, actor.id);
    return live ? [live] : [];
  }
  return s.units.filter(
    (o) =>
      o.id !== actor.id &&
      hexDistance(o.pos, actor.pos) <= range &&
      (target === 'allInRange' || (target === 'friendlyInRange' ? o.team === actor.team : o.team !== actor.team)),
  );
}

function applyEffect(s: GameState, m: Mechanic, actor: Unit, e: Effect, fx: Fx[], depth: number): void {
  const tag = `[${m.name}]`;
  switch (e.kind) {
    case 'log':
      log(s, { team: actor.team, kind: 'mechanic', text: `${tag} ${e.text.replace('{unit}', actor.name)}` });
      return;
    case 'spawn': {
      if (s.units.length >= MAX_UNITS) return;
      const at = nearestFreeHex(s, actor.pos, e.spawnDomain, 2);
      if (!at) return;
      const team = e.spawnTeam === 'same' ? actor.team : e.spawnTeam === 'neutral' ? 'neutral' : actor.team === 'blue' ? 'red' : 'blue';
      const id = `u${s.nextId++}`;
      const u = makeUnit(id, {
        team,
        name: e.spawnName,
        iconType: e.spawnIcon,
        domain: e.spawnDomain,
        col: at.col,
        row: at.row,
        hp: e.spawnHp,
        moveRange: e.spawnMoveRange,
        acquireRange: 1,
        acquirePower: 1,
        engageRange: e.spawnEngageRange,
        engagePower: e.spawnEngagePower,
      });
      u.spawnedBy = 'mechanic';
      s.units.push(u);
      syncResources(s);
      fx.push({ kind: 'spawn', at, team });
      log(s, { team, kind: 'mechanic', text: `${tag} ${e.spawnName} appears at (${at.col},${at.row}).` });
      return;
    }
  }

  for (const t of targetsOf(s, actor, e.target, e.range)) {
    switch (e.kind) {
      case 'damage':
        log(s, { team: t.team, kind: 'mechanic', text: `${tag} ${t.name} takes ${e.amount}.` });
        damageUnit(s, t, e.amount, fx, m.name, depth + 1);
        break;
      case 'heal': {
        const before = t.hp;
        t.hp = Math.min(t.maxHp, t.hp + e.amount);
        if (t.hp > before) {
          fx.push({ kind: 'heal', at: { ...t.pos }, amount: t.hp - before, team: t.team });
          log(s, { team: t.team, kind: 'mechanic', text: `${tag} ${t.name} +${t.hp - before} HP.` });
        }
        break;
      }
      case 'changeResource':
        t.resources[e.key] = clampResource(s, e.key, (t.resources[e.key] ?? 0) + e.amount);
        break;
      case 'setResource':
        t.resources[e.key] = clampResource(s, e.key, e.amount);
        break;
      case 'changeStat':
        t[e.stat] = Math.max(0, Math.min(10, t[e.stat] + e.amount));
        log(s, { team: t.team, kind: 'mechanic', text: `${tag} ${t.name} ${e.stat} ${e.amount > 0 ? '+' : ''}${e.amount}.` });
        break;
      case 'destroy':
        log(s, { team: t.team, kind: 'mechanic', text: `${tag} ${e.text.replace('{unit}', t.name) || `${t.name} lost.`}` });
        damageUnit(s, t, t.hp, fx, m.name, depth + 1);
        break;
      case 'relocate': {
        let dest = null;
        if (e.to === 'nearestFriendlyCity') {
          const cities = s.map.tiles.filter((c) => c.terrain === 'city' && c.owner === t.team);
          cities.sort((a, b) => hexDistance(a, t.pos) - hexDistance(b, t.pos));
          for (const c of cities) if ((dest = nearestFreeHex(s, c, t.domain, 3))) break;
        } else {
          dest = nearestFreeHex(s, t.pos, t.domain, 3);
        }
        if (dest) {
          log(s, { team: t.team, kind: 'mechanic', text: `${tag} ${t.name} relocates to (${dest.col},${dest.row}).` });
          t.pos = dest;
          fx.push({ kind: 'spawn', at: dest, team: t.team });
        }
        break;
      }
      case 'resetActions':
        t.hasMoved = t.hasAcquired = t.hasEngaged = false;
        break;
    }
  }
}

/**
 * Fire every enabled trigger for `event`. For unit events pass the unit that
 * caused it; for TURN_START / TURN_END pass null to evaluate all units.
 */
export function runTriggers(s: GameState, event: TriggerEvent, subject: Unit | null, fx: Fx[], depth = 0): void {
  if (depth > MAX_TRIGGER_DEPTH) return;
  for (const m of activeMechanics(s)) {
    for (const trig of m.triggers) {
      if (trig.on !== event) continue;
      const pool = subject ? [subject] : s.units.map((u) => u.id).map((id) => getUnit(s, id)!).filter(Boolean);
      for (const u0 of pool) {
        // Destroyed units are no longer in s.units but UNIT_DESTROYED still fires for them.
        const u = event === 'UNIT_DESTROYED' ? u0 : getUnit(s, u0.id);
        if (!u || !matchesSelector(u, trig.subject) || !conditionsHold(s, u, trig.conditions)) continue;
        for (const e of trig.effects) applyEffect(s, m, u, e, fx, depth);
      }
    }
  }
}

// ── Human-readable summary (UI + Claude context) ─────────────────────────────

function selText(sel: Selector): string {
  const parts = [sel.team === 'all' ? 'all' : sel.team, sel.domain === 'all' ? '' : sel.domain, sel.iconType === 'any' ? 'units' : sel.iconType];
  return parts.filter(Boolean).join(' ');
}

function condText(c: Condition): string {
  const n = c.negate ? 'NOT ' : '';
  switch (c.kind) {
    case 'resource': return `${n}${c.key} ${c.op} ${c.value}`;
    case 'hp': return `${n}hp ${c.op} ${c.value}`;
    case 'terrain': return `${n}on ${c.terrain}`;
    case 'turn': return `${n}turn ${c.op} ${c.value}`;
    case 'everyNTurns': return `${n}every ${c.value} turns`;
    case 'nearUnit': return `${n}${c.relation} ${c.domain === 'all' ? '' : c.domain + ' '}unit within ${c.range}`;
    case 'nearCity': return `${n}${c.relation} city within ${c.range}`;
  }
}

function effectText(e: Effect): string {
  const who = 'target' in e ? (e.target === 'self' ? 'self' : `${e.target.replace('InRange', '')} within ${e.range}`) : '';
  switch (e.kind) {
    case 'damage': return `damage ${who} ${e.amount}`;
    case 'heal': return `heal ${who} ${e.amount}`;
    case 'changeResource': return `${e.key} ${e.amount >= 0 ? '+' : ''}${e.amount} (${who})`;
    case 'setResource': return `${e.key} = ${e.amount} (${who})`;
    case 'changeStat': return `${e.stat} ${e.amount >= 0 ? '+' : ''}${e.amount} (${who})`;
    case 'destroy': return `destroy ${who}`;
    case 'relocate': return `move ${who} to ${e.to === 'nearestFriendlyCity' ? 'friendly city' : 'free hex'}`;
    case 'resetActions': return `refresh actions (${who})`;
    case 'spawn': return `spawn ${e.spawnName} (${e.spawnTeam})`;
    case 'log': return `log "${e.text}"`;
  }
}

export function describeMechanic(m: Pick<Mechanic, 'resources' | 'triggers' | 'statRules' | 'actionRules'>): string[] {
  const lines: string[] = [];
  for (const r of m.resources) lines.push(`RESOURCE ${r.label} (${r.key}) — ${selText(r.appliesTo)} start ${r.initial}, max ${r.max}`);
  for (const t of m.triggers) {
    const cond = t.conditions.length ? ` IF ${t.conditions.map(condText).join(' AND ')}` : '';
    lines.push(`ON ${t.on} for ${selText(t.subject)}${cond} → ${t.effects.map(effectText).join('; ')}`);
  }
  for (const r of m.statRules) {
    const cond = r.conditions.length ? ` while ${r.conditions.map(condText).join(' AND ')}` : '';
    lines.push(`STAT ${selText(r.subject)} ${r.stat} ${r.delta >= 0 ? '+' : ''}${r.delta}${cond}`);
  }
  for (const r of m.actionRules) {
    const cond = r.conditions.length ? ` while ${r.conditions.map(condText).join(' AND ')}` : '';
    const cost = r.costResource ? ` (costs ${r.costAmount} ${r.costResource})` : '';
    lines.push(`ACTION ${selText(r.subject)} ${r.action}: ${r.mode}${cond}${cost}`);
  }
  return lines;
}
