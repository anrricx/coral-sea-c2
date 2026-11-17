import { describe, expect, it } from 'vitest';
import { planRedTurn } from '../src/engine/ai';
import * as E from '../src/engine/engine';
import { key } from '../src/engine/hex';
import { createInitialState } from '../src/engine/scenario';
import type { GameState, HexCoord } from '../src/engine/types';
import { validateImportedState, validateMutation } from '../src/engine/validate';
import { parseLocally } from '../src/ai/localParser';

// Starting roster ids: u1 ATG, u2 AWD, u3 AEW&CS, u4 Blue fighter,
// u5–u7 Red strike squadrons, u8 Red coastal missile battery.

/** Test helper: place a unit somewhere and/or set the phase. */
function setup(edit: (s: GameState) => void): GameState {
  const s = E.clone(createInitialState());
  edit(s);
  return s;
}
const put = (s: GameState, id: string, pos: HexCoord) => (E.getUnit(s, id)!.pos = pos);

describe('movement', () => {
  it('keeps ships on the sea', () => {
    const s = createInitialState();
    const reach = E.reachableHexes(s, E.getUnit(s, 'u2')!);
    expect(reach.size).toBeGreaterThan(0);
    for (const k of reach.keys()) {
      const [col, row] = k.split(',').map(Number);
      expect(E.tileAt(s, { col, row })!.terrain).toBe('sea');
    }
  });

  it('lets aircraft fly over land', () => {
    const s = createInitialState();
    const reach = E.reachableHexes(s, E.getUnit(s, 'u4')!); // Blue fighter at (3,3)
    expect(reach.has('4,2')).toBe(true); // atoll
  });

  it('rejects actions outside the current phase', () => {
    const s = setup((x) => (x.phase = 'ACQUIRE'));
    expect(() => E.moveUnit(s, 'u2', { col: 3, row: 4 })).toThrow(E.EngineError);
  });

  it('allows only one move per unit per turn', () => {
    const s1 = E.moveUnit(createInitialState(), 'u2', { col: 3, row: 4 }).state;
    expect(() => E.moveUnit(s1, 'u2', { col: 3, row: 5 })).toThrow(/already moved/);
  });
});

describe('acquire → engage chain', () => {
  it('cannot engage an air target until it is CONFIRMED (3 points)', () => {
    let s = setup((x) => {
      put(x, 'u5', { col: 3, row: 2 }); // Red fighter near the AWD
      x.phase = 'ACQUIRE';
    });
    const awd = () => E.getUnit(s, 'u2')!;

    // Not confirmed yet → not a legal engage target.
    expect(E.engageTargets(s, awd()).units.map((u) => u.id)).not.toContain('u5');

    // AWD radar has 3 acquire power → confirms in one shot.
    s = E.acquire(s, 'u2', 'u5').state;
    expect(E.isConfirmed(E.getUnit(s, 'u5')!)).toBe(true);

    s = E.advancePhase(s); // ENGAGE
    s = E.engage(s, 'u2', { unitId: 'u5' }).state;
    expect(E.getUnit(s, 'u5')!.hp).toBe(4 - 3);
  });

  it('surface targets need no acquisition', () => {
    const s = setup((x) => {
      put(x, 'u2', { col: 6, row: 3 }); // AWD next to the coastal battery at (7,3)
      x.phase = 'ENGAGE';
    });
    expect(E.engageTargets(s, E.getUnit(s, 'u2')!).units.map((u) => u.id)).toContain('u8');
  });

  it('applies splash damage to adjacent enemies', () => {
    let s = setup((x) => {
      put(x, 'u8', { col: 7, row: 3 });
      put(x, 'u6', { col: 7, row: 4 }); // Red fighter adjacent to the battery
      x.phase = 'ENGAGE';
    });
    const v = validateMutation(
      {
        type: 'SPAWN_UNIT',
        payload: {
          team: 'blue', name: 'Test Bomber', iconType: 'bomber', hexCoords: { col: 6, row: 3 },
          hp: 4, maxHp: 4, moveRange: 3, acquireRange: 0, acquirePower: 0,
          engageRange: 1, engagePower: 2, splashRadius: 1, domain: 'air', durationTurns: 0,
        },
      },
      s,
    );
    if (!v.ok) throw new Error(v.error);
    s = E.applyMutation(s, v.mutation, { source: 'local' }).state;
    const bomber = s.units.find((u) => u.name === 'Test Bomber')!;
    s = E.engage(s, bomber.id, { unitId: 'u8' }).state;
    expect(E.getUnit(s, 'u8')!.hp).toBe(5 - 2); // direct hit
    expect(E.getUnit(s, 'u6')!.hp).toBe(4 - 2); // splash
  });
});

describe('global rules and end of round', () => {
  it('Monsoon −2 sea movement freezes ships, then expires after 3 turns', () => {
    const mut = parseLocally('Monsoon storm reduces all sea movement by 2').mutations[0];
    let s = createInitialState();
    const v = validateMutation(mut, s);
    if (!v.ok) throw new Error(v.error);
    s = E.applyMutation(s, v.mutation, { source: 'local' }).state;

    expect(E.effective(s, E.getUnit(s, 'u2')!, 'moveRange')).toBe(0);
    expect(E.reachableHexes(s, E.getUnit(s, 'u2')!).size).toBe(0);
    expect(E.effective(s, E.getUnit(s, 'u4')!, 'moveRange')).toBe(4); // air unaffected

    for (let i = 0; i < 3; i++) s = E.endRound(s).state;
    expect(s.activeRules).toHaveLength(0);
    expect(E.effective(s, E.getUnit(s, 'u2')!, 'moveRange')).toBe(2);
  });

  it('decays acquisition points and advances the turn', () => {
    let s = setup((x) => {
      put(x, 'u5', { col: 3, row: 2 });
      x.phase = 'ACQUIRE';
    });
    s = E.acquire(s, 'u2', 'u5').state;
    s = E.endRound(s).state;
    expect(E.getUnit(s, 'u5')!.acquirePoints).toBe(0);
    expect(s.turn).toBe(2);
    expect(s.phase).toBe('MOVE');
    expect(s.activeTeam).toBe('blue');
  });

  it('declares Red the winner when the Amphibious Task Group is lost', () => {
    const s = setup((x) => (x.units = x.units.filter((u) => u.id !== 'u1')));
    E.checkVictory(s);
    expect(s.winner).toBe('red');
  });
});

describe('validation layer', () => {
  const s = createInitialState();
  const spawn = (over: Record<string, unknown>) =>
    validateMutation({ type: 'SPAWN_UNIT', payload: { team: 'red', name: 'X', iconType: 'fighter', domain: 'air', hexCoords: { col: 5, row: 3 }, hp: 4, maxHp: 4, ...over } }, s);

  it('rejects off-map coordinates', () => {
    const v = spawn({ hexCoords: { col: 40, row: 2 } });
    expect(v.ok).toBe(false);
  });

  it('clamps extreme stats', () => {
    const v = spawn({ hp: 999, maxHp: 999, engagePower: 500 });
    expect(v.ok && v.mutation.type === 'SPAWN_UNIT' && v.mutation.payload.maxHp).toBe(20);
    expect(v.ok && v.mutation.type === 'SPAWN_UNIT' && v.mutation.payload.engagePower).toBe(10);
  });

  it('moves a ship spawned on land to the nearest sea hex', () => {
    const v = spawn({ domain: 'sea', iconType: 'destroyer', hexCoords: { col: 4, row: 2 } }); // atoll
    expect(v.ok).toBe(true);
    if (v.ok && v.mutation.type === 'SPAWN_UNIT') {
      expect(E.tileAt(s, v.mutation.payload.hexCoords)!.terrain).toBe('sea');
      expect(v.warnings.join()).toMatch(/relocated/);
    }
  });

  it('rejects unknown mutation types', () => {
    expect(validateMutation({ type: 'DELETE_EVERYTHING' }, s).ok).toBe(false);
  });

  it('round-trips an exported save file', () => {
    const exported = JSON.parse(JSON.stringify({ format: 'coral-sea-c2-scenario', state: s }));
    const v = validateImportedState(exported);
    expect(v.ok).toBe(true);
    expect(validateImportedState({ hello: 'world' }).ok).toBe(false);
  });
});

describe('local prompt parser', () => {
  it('translates the bat-bomb example', () => {
    const m = parseLocally('China deploys bat bombs at (6,4) that fly over any terrain and deal 3 splash damage').mutations;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      type: 'SPAWN_UNIT',
      payload: { team: 'red', domain: 'air', engagePower: 3, splashRadius: 1, hexCoords: { col: 6, row: 4 } },
    });
  });

  it('targets the side named after the verb', () => {
    const m = parseLocally('Enemy jamming reduces our radar acquisition by 1 for 2 turns').mutations[0];
    expect(m).toMatchObject({ payload: { targetTeam: 'blue', statModified: 'acquirePower', delta: -1, durationTurns: 2 } });
  });

  it('spawns multiple units on separate hexes', () => {
    let s = createInitialState();
    for (const raw of parseLocally('Deploy 2 UCAV drones at (3,1) for 4 turns').mutations) {
      const v = validateMutation(raw, s);
      if (!v.ok) throw new Error(v.error);
      s = E.applyMutation(s, v.mutation, { source: 'local' }).state;
    }
    const drones = s.units.filter((u) => u.iconType === 'drone');
    expect(drones).toHaveLength(2);
    expect(key(drones[0].pos)).not.toBe(key(drones[1].pos));
  });

  it('explains what it needs when it cannot parse', () => {
    expect(() => parseLocally('make it more exciting')).toThrow();
  });
});

describe('Red Force AI', () => {
  const blueEndsTurn = (s: GameState) => E.advancePhase(E.advancePhase(E.advancePhase(s)));

  it('is deterministic', () => {
    const a = planRedTurn(blueEndsTurn(createInitialState()));
    const b = planRedTurn(blueEndsTurn(createInitialState()));
    expect(JSON.stringify(a.at(-1)!.state)).toBe(JSON.stringify(b.at(-1)!.state));
  });

  it('hands the turn back to Blue and never stacks units', () => {
    const steps = planRedTurn(blueEndsTurn(createInitialState()));
    const end = steps.at(-1)!.state;
    expect(end.turn).toBe(2);
    expect(end.activeTeam).toBe('blue');
    for (const st of steps) {
      const hexes = st.state.units.map((u) => key(u.pos));
      expect(new Set(hexes).size).toBe(hexes.length);
    }
  });

  it('plays a full match to a result without crashing', () => {
    let s = createInitialState();
    for (let i = 0; i < 20 && !s.winner; i++) {
      s = blueEndsTurn(s);
      s = planRedTurn(s).at(-1)!.state;
    }
    expect(s.winner).not.toBeNull();
  });
});
