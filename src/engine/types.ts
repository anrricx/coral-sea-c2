// ─────────────────────────────────────────────────────────────────────────────
// Core data model. Everything the game needs lives in one serializable
// GameState object so it can be exported, imported, and replayed.
// ─────────────────────────────────────────────────────────────────────────────

export type Team = 'blue' | 'red' | 'neutral';
export type Domain = 'sea' | 'land' | 'air';
export type Terrain = 'sea' | 'coast' | 'land' | 'city';
export type Phase = 'MOVE' | 'ACQUIRE' | 'ENGAGE' | 'END_TURN';
export type ModifiableStat = 'moveRange' | 'engagePower' | 'acquirePower';
/** Every stat a mechanic's continuous rule may modify. */
export type StatKey = ModifiableStat | 'engageRange' | 'acquireRange';
export const STAT_KEYS: StatKey[] = ['moveRange', 'engagePower', 'acquirePower', 'engageRange', 'acquireRange'];

export const PHASES: Phase[] = ['MOVE', 'ACQUIRE', 'ENGAGE', 'END_TURN'];

export const ICON_TYPES = [
  'amphib',
  'destroyer',
  'carrier',
  'submarine',
  'aew',
  'fighter',
  'bomber',
  'drone',
  'helicopter',
  'missile_battery',
  'radar',
  'infantry',
  'armor',
  'swarm',
  'hazard',
  'generic',
] as const;
export type IconType = (typeof ICON_TYPES)[number];

export interface HexCoord {
  col: number;
  row: number;
}

export interface HexTile extends HexCoord {
  terrain: Terrain;
  /** Display name for cities / ports. */
  name?: string;
  /** Owning team for city tiles. */
  owner?: Team;
  /** High-value city target integrity. Reaching 0 = city lost. */
  cityHp?: number;
  cityMaxHp?: number;
}

export interface Unit {
  id: string;
  team: Team;
  name: string;
  iconType: IconType;
  domain: Domain;
  pos: HexCoord;
  hp: number;
  maxHp: number;
  moveRange: number;
  acquireRange: number;
  acquirePower: number;
  engageRange: number;
  engagePower: number;
  splashRadius: number;
  /** Which target domains this unit's weapons can reach. */
  engageDomains: Domain[];
  /** Stealthy surface units must be acquired like air units. */
  stealth: boolean;
  /** Losing this unit loses the game. */
  isHVT: boolean;
  /** Turns remaining before the unit expires. null = permanent. */
  durationTurns: number | null;
  /** Acquisition points accumulated against this unit by its enemies this round. */
  acquirePoints: number;
  hasMoved: boolean;
  hasAcquired: boolean;
  hasEngaged: boolean;
  /** Set when the unit came from a scenario injection. */
  spawnedBy?: string;
  /** Custom per-unit counters created by mechanics (fuel, ammo, charges…). */
  resources: Record<string, number>;
}

// ── Mechanics: player-defined game rules built from engine building blocks ──

export type TeamFilter = Team | 'all';
export type DomainFilter = Domain | 'all';
export type Relation = 'friendly' | 'enemy' | 'any';
export type CompareOp = '<' | '<=' | '==' | '>=' | '>';

/** Which units a rule applies to. */
export interface Selector {
  team: TeamFilter;
  domain: DomainFilter;
  iconType: IconType | 'any';
}

export type TriggerEvent = 'TURN_START' | 'TURN_END' | 'AFTER_MOVE' | 'AFTER_ACQUIRE' | 'AFTER_ENGAGE' | 'UNIT_DESTROYED';
export const TRIGGER_EVENTS: TriggerEvent[] = ['TURN_START', 'TURN_END', 'AFTER_MOVE', 'AFTER_ACQUIRE', 'AFTER_ENGAGE', 'UNIT_DESTROYED'];

export type Condition = { negate: boolean } & (
  | { kind: 'resource'; key: string; op: CompareOp; value: number }
  | { kind: 'hp'; op: CompareOp; value: number }
  | { kind: 'terrain'; terrain: Terrain }
  | { kind: 'turn'; op: CompareOp; value: number }
  | { kind: 'everyNTurns'; value: number }
  | { kind: 'nearUnit'; relation: Relation; domain: DomainFilter; range: number }
  | { kind: 'nearCity'; relation: Relation; range: number }
);
export const CONDITION_KINDS = ['resource', 'hp', 'terrain', 'turn', 'everyNTurns', 'nearUnit', 'nearCity'] as const;

/** Who an effect hits, relative to the triggering unit. */
export type EffectTarget = 'self' | 'friendlyInRange' | 'enemiesInRange' | 'allInRange';

export type Effect =
  | { kind: 'damage'; target: EffectTarget; range: number; amount: number }
  | { kind: 'heal'; target: EffectTarget; range: number; amount: number }
  | { kind: 'changeResource'; target: EffectTarget; range: number; key: string; amount: number }
  | { kind: 'setResource'; target: EffectTarget; range: number; key: string; amount: number }
  | { kind: 'changeStat'; target: EffectTarget; range: number; stat: StatKey; amount: number }
  | { kind: 'destroy'; target: EffectTarget; range: number; text: string }
  | { kind: 'relocate'; target: EffectTarget; range: number; to: 'nearestFriendlyCity' | 'nearestFreeHex' }
  | { kind: 'resetActions'; target: EffectTarget; range: number }
  | {
      kind: 'spawn';
      spawnTeam: 'same' | 'enemy' | 'neutral';
      spawnName: string;
      spawnIcon: IconType;
      spawnDomain: Domain;
      spawnHp: number;
      spawnMoveRange: number;
      spawnEngageRange: number;
      spawnEngagePower: number;
    }
  | { kind: 'log'; text: string };
export const EFFECT_KINDS = ['damage', 'heal', 'changeResource', 'setResource', 'changeStat', 'destroy', 'relocate', 'resetActions', 'spawn', 'log'] as const;

export interface ResourceDef {
  key: string;
  label: string;
  appliesTo: Selector;
  initial: number;
  max: number;
}

/** Fires effects when an event happens to a matching unit and conditions hold. */
export interface TriggerRule {
  on: TriggerEvent;
  subject: Selector;
  conditions: Condition[];
  effects: Effect[];
}

/** Continuous stat bonus/penalty while conditions hold (auras, terrain bonuses…). */
export interface StatRule {
  subject: Selector;
  conditions: Condition[];
  stat: StatKey;
  delta: number;
}

/** Changes what a unit is allowed to do while conditions hold. */
export interface ActionRule {
  subject: Selector;
  conditions: Condition[];
  action: 'move' | 'acquire' | 'engage';
  /** block = can't act; unlimitedRange = move anywhere legal; ignoreTerrain = move over any terrain. */
  mode: 'block' | 'unlimitedRange' | 'ignoreTerrain';
  /** Resource spent when a move only this rule made possible is used. */
  costResource: string;
  costAmount: number;
}

export interface Mechanic {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  resources: ResourceDef[];
  triggers: TriggerRule[];
  statRules: StatRule[];
  actionRules: ActionRule[];
  source: MutationSource;
  prompt?: string;
  createdAt: string;
}

export type MechanicDraft = Omit<Mechanic, 'id' | 'enabled' | 'source' | 'prompt' | 'createdAt'>;

export interface ActiveRule {
  id: string;
  ruleId: string;
  description: string;
  targetDomain: Domain | 'all';
  targetTeam: Team | 'all';
  statModified: ModifiableStat;
  delta: number;
  /** Turns remaining. null = permanent. */
  turnsRemaining: number | null;
}

// ── Mutations (the strict schema the Scenario Injector produces) ────────────

export interface SpawnUnitPayload {
  team: Team;
  name: string;
  iconType: IconType;
  hexCoords: HexCoord;
  hp: number;
  maxHp: number;
  moveRange: number;
  acquireRange: number;
  acquirePower: number;
  engageRange: number;
  engagePower: number;
  splashRadius: number;
  domain: Domain;
  /** 0 = permanent. */
  durationTurns: number;
}

export interface ModifyGlobalRulePayload {
  ruleId: string;
  description: string;
  targetDomain: Domain | 'all';
  targetTeam: Team | 'all';
  statModified: ModifiableStat;
  delta: number;
  /** 0 = permanent. */
  durationTurns: number;
}

export interface TriggerEventPayload {
  eventName: string;
  targetHex: HexCoord;
  radius: number;
  damage: number;
  terrainChange: Terrain | 'none';
}

// ── Zones: area-of-effect hazards that alter stats on specific hexes ─────────

export const ZONE_VISUALS = ['fog', 'storm', 'fire', 'radiation', 'toxic', 'ice', 'energy', 'generic'] as const;
export type ZoneVisual = (typeof ZONE_VISUALS)[number];

export interface ZoneStatModifier {
  stat: StatKey;
  delta: number;
}

export interface CreateZonePayload {
  name: string;
  targetHex: HexCoord;
  radius: number;
  /** 0 = permanent. */
  durationTurns: number;
  targetDomain: Domain | 'all';
  targetTeam: Team | 'all';
  /** Applied to units standing inside the zone. */
  statModifiers: ZoneStatModifier[];
  /** Damage dealt at end of turn to affected units inside. */
  damagePerTurn: number;
  /** Affected units cannot ENTER the zone (they may leave it). */
  blocksMovement: boolean;
  visual: ZoneVisual;
}

export interface Zone extends Omit<CreateZonePayload, 'targetHex' | 'durationTurns'> {
  id: string;
  center: HexCoord;
  turnsRemaining: number | null;
  source: MutationSource;
  prompt?: string;
}

export type GameMutation =
  | { type: 'SPAWN_UNIT'; payload: SpawnUnitPayload }
  | { type: 'MODIFY_GLOBAL_RULE'; payload: ModifyGlobalRulePayload }
  | { type: 'TRIGGER_EVENT'; payload: TriggerEventPayload }
  | { type: 'CREATE_ZONE'; payload: CreateZonePayload }
  | { type: 'DEFINE_MECHANIC'; payload: MechanicDraft };

export type MutationSource = 'claude' | 'ollama' | 'api' | 'local' | 'import';

export interface LogEntry {
  id: string;
  turn: number;
  phase: Phase;
  team: Team | 'system';
  kind: 'move' | 'acquire' | 'engage' | 'destroyed' | 'mutation' | 'system' | 'hazard' | 'mechanic';
  text: string;
  mutation?: GameMutation;
  source?: MutationSource;
  prompt?: string;
}

export interface GameState {
  schemaVersion: 1 | 2;
  /** Custom mechanics active in this match (copied from the library at game start). */
  mechanics: Mechanic[];
  /** Active area hazards (fog banks, radiation, minefields…). */
  zones: Zone[];
  scenarioName: string;
  turn: number;
  maxTurns: number;
  phase: Phase;
  activeTeam: Team;
  map: { cols: number; rows: number; tiles: HexTile[] };
  units: Unit[];
  activeRules: ActiveRule[];
  eventLog: LogEntry[];
  /** Every validated mutation applied this match, in order — the "scenario deck". */
  scenarioDeck: { turn: number; prompt?: string; source: MutationSource; mutation: GameMutation }[];
  nextId: number;
  winner: Team | null;
  winReason?: string;
}

// ── Visual effects emitted by the engine (consumed by the UI, never stored) ──

export type FxKind = 'damage' | 'heal' | 'explosion' | 'ping' | 'spawn' | 'hazard' | 'destroyed';

export interface Fx {
  kind: FxKind;
  at: HexCoord;
  amount?: number;
  team?: Team;
  radius?: number;
}

export interface EngineResult {
  state: GameState;
  fx: Fx[];
}
