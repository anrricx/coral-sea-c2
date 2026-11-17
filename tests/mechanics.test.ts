import { describe, expect, it } from 'vitest';
import { parseLocally } from '../src/ai/localParser';
import { MUTATION_RESPONSE_SCHEMA } from '../src/ai/claudeParser';
import { planRedTurn } from '../src/engine/ai';
import * as E from '../src/engine/engine';
import { createInitialState } from '../src/engine/scenario';
import type { GameState, Mechanic } from '../src/engine/types';
import { validateImportedState, validateMutation } from '../src/engine/validate';

/** Prompt → local parser → validator → engine, exactly like the command bar. */
function inject(s: GameState, prompt: string): GameState {
  for (const raw of parseLocally(prompt).mutations) {
    const v = validateMutation(raw, s);
    if (!v.ok) throw new Error(v.error);
    s = E.applyMutation(s, v.mutation, { source: 'local', prompt }).state;
  }
  return s;
}
const unit = (s: GameState, id: string) => E.getUnit(s, id)!;

describe('DEFINE_MECHANIC via the command bar', () => {
  it('fuel system: aircraft burn fuel each turn and crash at 0', () => {
    let s = inject(createInitialState(), 'Add a fuel system: aircraft carry 2 fuel and crash when they run out');
    expect(s.mechanics.map((m) => m.name)).toContain('Fuel System');
    expect(unit(s, 'u5').resources.fuel).toBe(2); // Red fighter
    expect(unit(s, 'u3').resources.fuel).toBe(2); // Blue AEW&CS too ("they" must not mean Red)
    expect(unit(s, 'u2').resources.fuel).toBeUndefined(); // ship: no fuel

    s = E.endRound(s).state;
    expect(unit(s, 'u5').resources.fuel).toBe(1);
    s = E.endRound(s).state;
    expect(E.getUnit(s, 'u5')).toBeUndefined(); // crashed
    expect(s.eventLog.some((l) => /ran out of fuel/.test(l.text))).toBe(true);
  });

  it('teleport once per game: unlimited move that costs a charge', () => {
    let s = inject(createInitialState(), 'Our ships can teleport once per game');
    const far = { col: 6, row: 5 }; // far beyond the AWD's 2-hex move
    expect(E.reachableHexes(s, unit(s, 'u2')).has('6,5')).toBe(true);
    s = E.moveUnit(s, 'u2', far).state;
    expect(unit(s, 'u2').pos).toEqual(far);
    expect(unit(s, 'u2').resources.teleport).toBe(0);
    s = E.endRound(s).state;
    expect(E.reachableHexes(s, unit(s, 'u2')).has('1,0')).toBe(false); // charge spent → normal range
  });

  it('port repairs heal ships next to a friendly city', () => {
    let s = inject(createInitialState(), 'New mechanic: ships next to a friendly port repair 2 HP each turn');
    const atg = unit(s, 'u1');
    atg.pos = { col: 1, row: 4 }; // adjacent to Port Halcyon (1,5)
    atg.hp = 5;
    s = E.endRound(s).state;
    expect(unit(s, 'u1').hp).toBe(7);
  });

  it('limited ammo blocks engagement once empty', () => {
    let s = inject(createInitialState(), 'Add limited ammo: each unit has 1 missiles');
    s = E.clone(s);
    unit(s, 'u2').pos = { col: 6, row: 3 }; // AWD next to the coastal battery
    s.phase = 'ENGAGE';
    s = E.engage(s, 'u2', { unitId: 'u8' }).state;
    expect(unit(s, 'u2').resources.ammo).toBe(0);
    s = E.endRound(s).state;
    s.phase = 'ENGAGE';
    expect(E.engageTargets(s, unit(s, 'u2')).units).toHaveLength(0);
  });

  it('Red AI obeys mechanics too (fuel kills idle Red fighters)', () => {
    let s = inject(createInitialState(), 'Add a fuel system: aircraft carry 1 fuel');
    s = E.advancePhase(E.advancePhase(E.advancePhase(s)));
    s = planRedTurn(s).at(-1)!.state;
    expect(s.units.filter((u) => u.team === 'red' && u.domain === 'air')).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('a new game started with the library includes the mechanic', () => {
    const lib: Mechanic[] = inject(createInitialState(), 'Add a fuel system for aircraft').mechanics;
    const fresh = createInitialState(lib);
    expect(fresh.mechanics).toHaveLength(1);
    expect(unit(fresh, 'u3').resources.fuel).toBe(4); // AEW&CS gets default fuel
  });

  it('disabled mechanics have no effect', () => {
    const lib = inject(createInitialState(), 'Add a fuel system for aircraft').mechanics.map((m) => ({ ...m, enabled: false }));
    let s = createInitialState(lib);
    for (let i = 0; i < 6; i++) s = E.endRound(s).state;
    expect(E.getUnit(s, 'u5')).toBeDefined();
  });

  it('mechanics survive export → import', () => {
    const s = inject(createInitialState(), 'Our ships can teleport once per game');
    const v = validateImportedState(JSON.parse(JSON.stringify({ state: s })));
    expect(v.ok && v.state.mechanics[0].name).toBe('Teleport');
  });
});

describe('mechanic validation', () => {
  const s = createInitialState();
  it('rejects a mechanic that does nothing', () => {
    const v = validateMutation({ type: 'DEFINE_MECHANIC', payload: { name: 'Empty', triggers: [], statRules: [], actionRules: [] } }, s);
    expect(v.ok).toBe(false);
  });

  it('clamps absurd values from the AI', () => {
    const v = validateMutation(
      {
        type: 'DEFINE_MECHANIC',
        payload: {
          name: 'Overkill',
          triggers: [{ on: 'TURN_END', subject: { team: 'all', domain: 'all', iconType: 'any' }, conditions: [], effects: [{ kind: 'damage', target: 'allInRange', range: 99, amount: 9999 }] }],
        },
      },
      s,
    );
    expect(v.ok).toBe(true);
    if (v.ok && v.mutation.type === 'DEFINE_MECHANIC') {
      const e = v.mutation.payload.triggers[0].effects[0];
      expect(e).toMatchObject({ kind: 'damage', range: 6, amount: 10 });
    }
  });

  it('local parser explains unknown mechanics need Claude', () => {
    expect(() => parseLocally('Add a new mechanic where units sing sea shanties')).toThrow(/Claude/);
  });

  it('Claude schema includes DEFINE_MECHANIC', () => {
    expect(JSON.stringify(MUTATION_RESPONSE_SCHEMA)).toContain('DEFINE_MECHANIC');
  });
});
