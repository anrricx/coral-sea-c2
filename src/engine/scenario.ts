import { key, neighbors } from './hex';
import { syncResources } from './mechanics';
import type { Domain, GameState, HexTile, IconType, Mechanic, Team, Unit } from './types';

export const MAP_COLS = 10;
export const MAP_ROWS = 7;

// Land hexes (everything else is open sea). Coast is derived automatically.
const LAND: [number, number][] = [
  // Blue home island (south-west)
  [0, 4], [0, 5], [0, 6], [1, 5], [1, 6], [2, 6],
  // Mid-sea atoll
  [4, 2], [5, 5],
  // Red mainland (east)
  [6, 0],
  [7, 0], [7, 1], [7, 2], [7, 3], [7, 4],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 0], [9, 1], [9, 2], [9, 3], [9, 4], [9, 5], [9, 6],
];

export const BLUE_CITY = { col: 1, row: 5, name: 'Port Halcyon' };
export const RED_CITY = { col: 7, row: 2, name: 'Kestrel Harbor' };

export function buildMap(): HexTile[] {
  const land = new Set(LAND.map(([c, r]) => `${c},${r}`));
  const tiles: HexTile[] = [];
  for (let col = 0; col < MAP_COLS; col++) {
    for (let row = 0; row < MAP_ROWS; row++) {
      const k = `${col},${row}`;
      if (!land.has(k)) {
        tiles.push({ col, row, terrain: 'sea' });
        continue;
      }
      const touchesSea = neighbors({ col, row }, MAP_COLS, MAP_ROWS).some((n) => !land.has(key(n)));
      tiles.push({ col, row, terrain: touchesSea ? 'coast' : 'land' });
    }
  }
  for (const [city, owner] of [
    [BLUE_CITY, 'blue'],
    [RED_CITY, 'red'],
  ] as const) {
    const t = tiles.find((x) => x.col === city.col && x.row === city.row)!;
    t.terrain = 'city';
    t.name = city.name;
    t.owner = owner;
    t.cityHp = 8;
    t.cityMaxHp = 8;
  }
  return tiles;
}

type UnitSeed = {
  team: Team;
  name: string;
  iconType: IconType;
  domain: Domain;
  col: number;
  row: number;
  hp: number;
  moveRange: number;
  acquireRange: number;
  acquirePower: number;
  engageRange: number;
  engagePower: number;
  splashRadius?: number;
  engageDomains?: Domain[];
  isHVT?: boolean;
  stealth?: boolean;
};

export function makeUnit(id: string, s: UnitSeed): Unit {
  return {
    id,
    team: s.team,
    name: s.name,
    iconType: s.iconType,
    domain: s.domain,
    pos: { col: s.col, row: s.row },
    hp: s.hp,
    maxHp: s.hp,
    moveRange: s.moveRange,
    acquireRange: s.acquireRange,
    acquirePower: s.acquirePower,
    engageRange: s.engageRange,
    engagePower: s.engagePower,
    splashRadius: s.splashRadius ?? 0,
    engageDomains: s.engageDomains ?? ['sea', 'land', 'air'],
    stealth: s.stealth ?? false,
    isHVT: s.isHVT ?? false,
    durationTurns: null,
    acquirePoints: 0,
    hasMoved: false,
    hasAcquired: false,
    hasEngaged: false,
    resources: {},
  };
}

const ROSTER: UnitSeed[] = [
  // ── Blue Force (player) ──
  { team: 'blue', name: 'Amphibious Task Group', iconType: 'amphib', domain: 'sea', col: 1, row: 3, hp: 10, moveRange: 2, acquireRange: 1, acquirePower: 1, engageRange: 1, engagePower: 1, isHVT: true },
  { team: 'blue', name: 'Surface Combatant (AWD)', iconType: 'destroyer', domain: 'sea', col: 2, row: 3, hp: 6, moveRange: 2, acquireRange: 3, acquirePower: 3, engageRange: 3, engagePower: 3 },
  { team: 'blue', name: 'AEW&CS Wedgetail', iconType: 'aew', domain: 'air', col: 1, row: 1, hp: 3, moveRange: 4, acquireRange: 4, acquirePower: 2, engageRange: 0, engagePower: 0 },
  { team: 'blue', name: 'Fighter / Strike Sqn', iconType: 'fighter', domain: 'air', col: 3, row: 3, hp: 4, moveRange: 4, acquireRange: 2, acquirePower: 1, engageRange: 2, engagePower: 2 },
  // ── Red Force (AI) ──
  { team: 'red', name: 'Strike Sqn Alpha', iconType: 'fighter', domain: 'air', col: 8, row: 1, hp: 4, moveRange: 3, acquireRange: 2, acquirePower: 1, engageRange: 1, engagePower: 2 },
  { team: 'red', name: 'Strike Sqn Bravo', iconType: 'fighter', domain: 'air', col: 8, row: 3, hp: 4, moveRange: 3, acquireRange: 2, acquirePower: 1, engageRange: 1, engagePower: 2 },
  { team: 'red', name: 'Strike Sqn Charlie', iconType: 'fighter', domain: 'air', col: 8, row: 5, hp: 4, moveRange: 3, acquireRange: 2, acquirePower: 1, engageRange: 1, engagePower: 2 },
  { team: 'red', name: 'Coastal Missile Battery', iconType: 'missile_battery', domain: 'land', col: 7, row: 3, hp: 5, moveRange: 1, acquireRange: 3, acquirePower: 2, engageRange: 4, engagePower: 3, engageDomains: ['sea', 'land'] },
];

/** Fresh match. `mechanics` = the player's saved mechanic library (enabled ones apply). */
export function createInitialState(mechanics: Mechanic[] = []): GameState {
  const units = ROSTER.map((s, i) => makeUnit(`u${i + 1}`, s));
  const state: GameState = {
    schemaVersion: 2,
    mechanics: structuredClone(mechanics),
    zones: [],
    scenarioName: 'Coral Sea 2042 — Littoral Denial',
    turn: 1,
    maxTurns: 12,
    phase: 'MOVE',
    activeTeam: 'blue',
    map: { cols: MAP_COLS, rows: MAP_ROWS, tiles: buildMap() },
    units,
    activeRules: [],
    eventLog: [
      {
        id: 'l0',
        turn: 1,
        phase: 'MOVE',
        team: 'system',
        kind: 'system',
        text: 'C2 link established. Protect the Amphibious Task Group and Port Halcyon. Hold for 12 turns, destroy Red Force, or strike Kestrel Harbor.',
      },
    ],
    scenarioDeck: [],
    nextId: units.length + 1,
    winner: null,
  };
  syncResources(state);
  return state;
}
