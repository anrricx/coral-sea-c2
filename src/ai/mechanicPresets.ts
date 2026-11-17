// ─────────────────────────────────────────────────────────────────────────────
// Offline mechanic templates for the local parser. With a Claude key, ANY
// mechanic the building blocks can express is possible; without one, these
// keyword-matched presets cover the common requests.
// ─────────────────────────────────────────────────────────────────────────────
import type { Condition, Domain, Effect, MechanicDraft, Selector, Team } from '../engine/types';

const sel = (team: Team | 'all' = 'all', domain: Domain | 'all' = 'all'): Selector => ({ team, domain, iconType: 'any' });
const res = (key: string, op: '<' | '<=' | '>=' | '>' | '==', value: number, negate = false): Condition => ({ kind: 'resource', key, op, value, negate });
const self = { target: 'self' as const, range: 0 };

interface Ctx {
  team: Team | 'all';
  domain: Domain | 'all';
  n?: number;
}

type Preset = { match: RegExp; build: (c: Ctx) => MechanicDraft };

const domainWord = (d: Domain | 'all') => (d === 'all' ? 'units' : d === 'air' ? 'aircraft' : d === 'sea' ? 'ships' : 'ground units');
const sideWord = (t: Team | 'all') => (t === 'all' ? '' : `${t === 'blue' ? 'Blue' : t === 'red' ? 'Red' : 'Neutral'} `);

export const PRESETS: Preset[] = [
  {
    match: /\bfuel\b/,
    build: ({ team, domain, n }) => {
      const d = domain === 'all' ? 'air' : domain;
      const fuel = n ?? 4;
      return {
        name: 'Fuel System',
        description: `${sideWord(team)}${domainWord(d)} carry ${fuel} fuel, burn 1 per turn, crash at 0, and refuel next to a friendly city.`,
        resources: [{ key: 'fuel', label: 'Fuel', appliesTo: sel(team, d), initial: fuel, max: fuel }],
        triggers: [
          { on: 'TURN_END', subject: sel(team, d), conditions: [], effects: [{ kind: 'changeResource', ...self, key: 'fuel', amount: -1 }] },
          { on: 'TURN_END', subject: sel(team, d), conditions: [res('fuel', '<=', 0)], effects: [{ kind: 'destroy', ...self, text: '{unit} ran out of fuel and ditched.' }] },
          {
            on: 'TURN_START',
            subject: sel(team, d),
            conditions: [{ kind: 'nearCity', relation: 'friendly', range: 1, negate: false }],
            effects: [{ kind: 'setResource', ...self, key: 'fuel', amount: fuel }],
          },
        ],
        statRules: [{ subject: sel(team, d), conditions: [res('fuel', '<=', 1)], stat: 'moveRange', delta: -1 }],
        actionRules: [],
      };
    },
  },
  {
    match: /teleport|warp|blink|jump drive/,
    build: ({ team, domain, n }) => {
      const charges = n ?? 1;
      return {
        name: 'Teleport',
        description: `${sideWord(team)}${domainWord(domain)} can teleport to any legal hex ${charges === 1 ? 'once' : `${charges} times`} per game (uses their move).`,
        resources: [{ key: 'teleport', label: 'Teleports', appliesTo: sel(team, domain), initial: charges, max: charges }],
        triggers: [],
        statRules: [],
        actionRules: [
          { subject: sel(team, domain), conditions: [res('teleport', '>=', 1)], action: 'move', mode: 'unlimitedRange', costResource: 'teleport', costAmount: 1 },
        ],
      };
    },
  },
  {
    match: /repair|resupply|heal|refit/,
    build: ({ team, domain, n }) => ({
      name: 'Port Repairs',
      description: `${sideWord(team)}${domainWord(domain)} next to a friendly city repair ${n ?? 2} HP at the start of each turn.`,
      resources: [],
      triggers: [
        {
          on: 'TURN_START',
          subject: sel(team, domain),
          conditions: [{ kind: 'nearCity', relation: 'friendly', range: 1, negate: false }],
          effects: [{ kind: 'heal', ...self, amount: n ?? 2 }],
        },
      ],
      statRules: [],
      actionRules: [],
    }),
  },
  {
    match: /\bammo\b|ammunition|magazine|limited (?:missiles|weapons|shots)|missiles each/,
    build: ({ team, domain, n }) => {
      const ammo = n ?? 3;
      return {
        name: 'Limited Ammunition',
        description: `${sideWord(team)}${domainWord(domain)} carry ${ammo} shots; each attack uses one and empty units can't engage. Rearm next to a friendly city.`,
        resources: [{ key: 'ammo', label: 'Ammo', appliesTo: sel(team, domain), initial: ammo, max: ammo }],
        triggers: [
          { on: 'AFTER_ENGAGE', subject: sel(team, domain), conditions: [], effects: [{ kind: 'changeResource', ...self, key: 'ammo', amount: -1 }] },
          {
            on: 'TURN_START',
            subject: sel(team, domain),
            conditions: [{ kind: 'nearCity', relation: 'friendly', range: 1, negate: false }],
            effects: [{ kind: 'setResource', ...self, key: 'ammo', amount: ammo }],
          },
        ],
        statRules: [],
        actionRules: [{ subject: sel(team, domain), conditions: [res('ammo', '<=', 0)], action: 'engage', mode: 'block', costResource: '', costAmount: 0 }],
      };
    },
  },
  {
    match: /veteran|experience|\bxp\b|promotion|level up/,
    build: ({ team, domain }) => ({
      name: 'Veterancy',
      description: `${sideWord(team)}${domainWord(domain)} gain 1 XP per attack; at 2 XP they hit +1 harder, at 4 XP they also move +1.`,
      resources: [{ key: 'xp', label: 'XP', appliesTo: sel(team, domain), initial: 0, max: 9 }],
      triggers: [{ on: 'AFTER_ENGAGE', subject: sel(team, domain), conditions: [], effects: [{ kind: 'changeResource', ...self, key: 'xp', amount: 1 }] }],
      statRules: [
        { subject: sel(team, domain), conditions: [res('xp', '>=', 2)], stat: 'engagePower', delta: 1 },
        { subject: sel(team, domain), conditions: [res('xp', '>=', 4)], stat: 'moveRange', delta: 1 },
      ],
      actionRules: [],
    }),
  },
  {
    match: /reinforce|reinforcements/,
    build: ({ team, n }) => {
      const side: Team = team === 'all' || team === 'neutral' ? 'blue' : team;
      const every = n ?? 3;
      const spawn: Effect = {
        kind: 'spawn',
        spawnTeam: 'same',
        spawnName: side === 'blue' ? 'Relief Fighters' : 'Strike Reserve',
        spawnIcon: 'fighter',
        spawnDomain: 'air',
        spawnHp: 4,
        spawnMoveRange: 3,
        spawnEngageRange: side === 'blue' ? 2 : 1,
        spawnEngagePower: 2,
      };
      return {
        name: `${side === 'blue' ? 'Blue' : 'Red'} Reinforcements`,
        description: `Every ${every} turns a fresh fighter squadron joins ${side === 'blue' ? 'Blue' : 'Red'} Force next to its high-value unit or battery.`,
        resources: [],
        triggers: [
          {
            on: 'TURN_START',
            subject: { team: side, domain: 'all', iconType: side === 'blue' ? 'amphib' : 'missile_battery' },
            conditions: [{ kind: 'everyNTurns', value: every, negate: false }],
            effects: [spawn],
          },
        ],
        statRules: [],
        actionRules: [],
      };
    },
  },
  {
    match: /attrition|scurvy|disease|exhaustion|fatigue/,
    build: ({ team, domain, n }) => ({
      name: 'Attrition',
      description: `${sideWord(team)}${domainWord(domain)} far from any friendly city lose ${n ?? 1} HP at the end of every 2nd turn.`,
      resources: [],
      triggers: [
        {
          on: 'TURN_END',
          subject: sel(team, domain),
          conditions: [
            { kind: 'everyNTurns', value: 2, negate: false },
            { kind: 'nearCity', relation: 'friendly', range: 3, negate: true },
          ],
          effects: [{ kind: 'damage', ...self, amount: n ?? 1 }],
        },
      ],
      statRules: [],
      actionRules: [],
    }),
  },
];

/** Words that signal "this is a lasting rule/system", not a one-off spawn. */
export const MECHANIC_INTENT = /\b(mechanic|system|rule|units? can|can now|each (?:unit|ship|aircraft|plane)|every turn|per turn|once per game|from now on|ability|abilities|add (?:a|an)\b)/;

export function matchPreset(t: string, ctx: Ctx): MechanicDraft | null {
  const p = PRESETS.find((x) => x.match.test(t));
  return p ? p.build(ctx) : null;
}
