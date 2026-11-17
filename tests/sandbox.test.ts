import { describe, expect, it } from 'vitest';
import { interpretOffline } from '../src/ai/interpret';
import { interpretAnything } from '../src/ai/universalParser';
import { planRedTurn } from '../src/engine/ai';
import * as E from '../src/engine/engine';
import { createInitialState } from '../src/engine/scenario';
import type { GameState } from '../src/engine/types';
import { checkInvariants, validateMutation } from '../src/engine/validate';

/** The same safe pipeline the command bar uses: interpret → validate → apply → invariant check. */
function inject(s: GameState, prompt: string): { state: GameState; types: string[]; payloads: any[] } {
  const types: string[] = [];
  const payloads: any[] = [];
  for (const raw of interpretOffline(prompt, s).mutations) {
    const v = validateMutation(raw, s);
    if (!v.ok) continue;
    const next = E.applyMutation(s, v.mutation, { source: 'local', prompt }).state;
    if (checkInvariants(next)) continue;
    s = next;
    types.push(v.mutation.type);
    payloads.push(v.mutation.payload);
  }
  return { state: s, types, payloads };
}

describe('the brief\'s examples all become something playable', () => {
  const s = createInitialState();
  const cases: [string, string, (p: any) => void][] = [
    ['a giant laser bean from space', 'TRIGGER_EVENT', (p) => expect(p.damage).toBeGreaterThanOrEqual(4)],
    ['angry geese', 'SPAWN_UNIT', (p) => expect(p).toMatchObject({ team: 'neutral', domain: 'air', iconType: 'swarm' })],
    ['economic collapse', 'MODIFY_GLOBAL_RULE', (p) => expect(p).toMatchObject({ statModified: 'moveRange', delta: -2 })],
    ['alien mothership', 'SPAWN_UNIT', (p) => expect(p.hp).toBeGreaterThanOrEqual(8)],
    ['internet goes down', 'MODIFY_GLOBAL_RULE', (p) => expect(p).toMatchObject({ statModified: 'acquirePower' })],
    ['heavy fog', 'CREATE_ZONE', (p) => expect(p.statModifiers.some((m: any) => m.stat === 'acquirePower' && m.delta < 0)).toBe(true)],
    ['lightning strikes coordinates (4,2)', 'TRIGGER_EVENT', (p) => expect(p).toMatchObject({ targetHex: { col: 4, row: 2 }, radius: 0 })],
  ];
  for (const [prompt, type, check] of cases) {
    it(`"${prompt}" → ${type}`, () => {
      const r = inject(s, prompt);
      expect(r.types[0]).toBe(type);
      check(r.payloads[0]);
    });
  }
});

describe('stats are derived from the description', () => {
  const s = createInitialState();
  const unit = (p: string) => interpretAnything(p, s).mutations[0] as any;
  it('heavy things are tougher and slower than fast things', () => {
    const heavy = unit('a heavy armored tortoise tank').payload;
    const fast = unit('a fast nimble scout jet').payload;
    expect(heavy.hp).toBeGreaterThan(fast.hp);
    expect(fast.moveRange).toBeGreaterThan(heavy.moveRange);
  });
  it('lasers reach further; cute things barely hurt', () => {
    expect(unit('a laser turret robot').payload.engageRange).toBeGreaterThanOrEqual(3);
    expect(unit('a cute fluffy bunny').payload.engagePower).toBeLessThanOrEqual(1);
  });
  it('sea creatures swim, birds fly, soldiers walk', () => {
    expect(unit('a hungry shark').payload.domain).toBe('sea');
    expect(unit('a confused pigeon').payload.domain).toBe('air');
    expect(unit('our zombie soldiers').payload).toMatchObject({ domain: 'land', team: 'blue' });
  });
  it('the side comes from the subject, not the target', () => {
    expect(unit('a herd of elephants near the enemy battery').payload.team).toBe('neutral');
    expect(unit('China unleashes robot dragons').payload.team).toBe('red');
  });
  it('a laser from space finds the named target', () => {
    const ev = interpretAnything('a laser beam from space destroys the enemy missile battery', s).mutations[0] as any;
    expect(ev.payload.targetHex).toEqual(E.getUnit(s, 'u8')!.pos);
  });
});

describe('zones', () => {
  it('fog lowers sensor power only for units inside it', () => {
    let s = createInitialState();
    const before = E.effective(s, E.getUnit(s, 'u2')!, 'acquirePower');
    s = inject(s, 'thick fog at (2,3)').state; // AWD sits at (2,3)
    expect(E.effective(s, E.getUnit(s, 'u2')!, 'acquirePower')).toBeLessThan(before);
    expect(E.effective(s, E.getUnit(s, 'u5')!, 'acquirePower')).toBe(1); // far-away Red fighter unaffected
  });

  it('radiation damages units inside at end of turn, then dissipates', () => {
    let s = createInitialState();
    s = inject(s, 'radioactive fallout at (8,3) for 2 turns').state;
    const hp = E.getUnit(s, 'u6')!.hp;
    s = E.endRound(s).state;
    expect(E.getUnit(s, 'u6')!.hp).toBe(hp - 1);
    s = E.endRound(s).state;
    expect(s.zones).toHaveLength(0);
  });

  it('a force field around our port blocks Red but not Blue', () => {
    let s = createInitialState();
    s = inject(s, 'our force field around Port Halcyon').state;
    const z = s.zones[0];
    expect(z).toMatchObject({ blocksMovement: true, targetTeam: 'red' });
    const red = E.getUnit(s, 'u5')!;
    red.pos = { col: 3, row: 5 }; // two hexes from the port
    const reach = E.reachableHexes(s, red);
    expect([...reach.keys()].some((k) => k === '2,5' || k === '1,4')).toBe(false);
  });

  it('the Red AI steers around damaging zones', () => {
    let s = createInitialState();
    s = inject(s, 'massive radioactive fallout at (5,3) radius 2').state;
    s = E.advancePhase(E.advancePhase(E.advancePhase(s)));
    const end = planRedTurn(s).at(-1)!.state;
    const inside = end.units.filter((u) => u.team === 'red' && Math.abs(u.pos.col - 5) <= 1 && Math.abs(u.pos.row - 3) <= 1);
    expect(inside).toHaveLength(0);
  });
});

describe('safety: nothing can break the game', () => {
  // Deterministic pseudo-random generator so failures are reproducible.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const WORDS = 'giant tiny angry laser fog radiation geese dragon economy internet collapse boom our enemy China tank shark at near (3,3) (99,-4) for 5 turns radius 9 999 damage nuke force field mothership pizza ghost swarm 3 sing lightning strikes the battery'.split(' ');
  const WEIRD = ['', ' ', '🦆🔥💥', 'x'.repeat(5000), '((((', '$$$', 'null', 'undefined', 'NaN', '<script>alert(1)</script>', 'DROP TABLE units;', '\u0000\u0001'];

  it('400 random prompts never throw and always leave a valid state', () => {
    let s = createInitialState();
    for (let i = 0; i < 400; i++) {
      const prompt = i % 10 === 0 ? pick(WEIRD) : Array.from({ length: 1 + Math.floor(rnd() * 9) }, () => pick(WORDS)).join(' ');
      expect(() => (s = inject(s, prompt).state)).not.toThrow();
      expect(checkInvariants(s)).toBeNull();
      if (i % 25 === 0) s = E.endRound(s).state; // let things expire/die so the board keeps changing
    }
  });

  it('hostile raw mutations (as a broken model might send) are rejected or clamped', () => {
    const s = createInitialState();
    const junk: unknown[] = [
      null, 42, 'SPAWN_UNIT', [], {}, { type: 'SPAWN_UNIT' },
      { type: 'SPAWN_UNIT', payload: { hexCoords: { col: 1e9, row: -1 } } },
      { type: 'SPAWN_UNIT', payload: { hexCoords: { col: 5, row: 3 }, hp: Infinity, engagePower: NaN, moveRange: '9999', name: '<b>x</b>'.repeat(50) } },
      { type: 'CREATE_ZONE', payload: { targetHex: [4, 3], radius: 1e6, damagePerTurn: 1e6, statModifiers: [{ stat: 'hp', delta: 1e9 }, 'junk'] } },
      { type: 'TRIGGER_EVENT', payload: { targetHex: { x: 2, y: 2 }, radius: -5, damage: 1e12 } },
      { type: 'MODIFY_GLOBAL_RULE', payload: { statModified: 'moveRange', delta: -1e9 } },
      { type: 'DEFINE_MECHANIC', payload: { name: 'x', triggers: 'not an array' } },
      { type: '__proto__', payload: { polluted: true } },
    ];
    for (const raw of junk) {
      const v = validateMutation(raw, s);
      if (!v.ok) continue;
      const next = E.applyMutation(s, v.mutation, { source: 'local' }).state;
      expect(checkInvariants(next)).toBeNull();
      const p: any = v.mutation.payload;
      if (v.mutation.type === 'SPAWN_UNIT') expect(p.hp).toBeLessThanOrEqual(20);
      if (v.mutation.type === 'CREATE_ZONE') expect([p.radius, p.damagePerTurn]).toEqual([3, 5]);
      if (v.mutation.type === 'TRIGGER_EVENT') expect(p.damage).toBe(10);
    }
    expect(({} as any).polluted).toBeUndefined();
  });

  it('the board cannot be flooded past the unit cap', () => {
    let s = createInitialState();
    for (let i = 0; i < 30; i++) s = inject(s, '3 angry geese').state;
    expect(s.units.length).toBeLessThanOrEqual(40);
    expect(checkInvariants(s)).toBeNull();
  });
});
