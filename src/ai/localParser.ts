// ─────────────────────────────────────────────────────────────────────────────
// Built-in "smart" local parser. Turns a natural-language prompt into raw
// GameMutation candidates with keyword heuristics, so the injector works with
// no API key. Output still goes through validate.ts like Claude's output.
// ─────────────────────────────────────────────────────────────────────────────
import type { Domain, IconType, ModifiableStat, Team, Terrain } from '../engine/types';
import { MECHANIC_INTENT, PRESETS, matchPreset } from './mechanicPresets';

type Template = {
  match: RegExp;
  name: string;
  iconType: IconType;
  domain: Domain;
  hp: number;
  moveRange: number;
  acquireRange: number;
  acquirePower: number;
  engageRange: number;
  engagePower: number;
  splashRadius: number;
};

// Ordered: first match wins.
const TEMPLATES: Template[] = [
  { match: /\bbats?\b|bat[- ]?bombs?/, name: 'Bat Bombs', iconType: 'swarm', domain: 'air', hp: 2, moveRange: 4, acquireRange: 0, acquirePower: 0, engageRange: 1, engagePower: 2, splashRadius: 1 },
  { match: /swarm|locust|birds?|hornets?|bees/, name: 'Drone Swarm', iconType: 'swarm', domain: 'air', hp: 3, moveRange: 4, acquireRange: 1, acquirePower: 1, engageRange: 1, engagePower: 2, splashRadius: 1 },
  { match: /kraken|sea monster|leviathan|whale/, name: 'Leviathan', iconType: 'hazard', domain: 'sea', hp: 8, moveRange: 2, acquireRange: 0, acquirePower: 0, engageRange: 1, engagePower: 3, splashRadius: 0 },
  { match: /typhoon|cyclone|hurricane|tornado|waterspout|storm cell/, name: 'Typhoon Cell', iconType: 'hazard', domain: 'air', hp: 10, moveRange: 1, acquireRange: 0, acquirePower: 0, engageRange: 1, engagePower: 1, splashRadius: 0 },
  { match: /\b(aew|awacs|wedgetail|early warning|radar plane|e-7|e-2)\b/, name: 'AEW&C Aircraft', iconType: 'aew', domain: 'air', hp: 3, moveRange: 4, acquireRange: 4, acquirePower: 2, engageRange: 0, engagePower: 0, splashRadius: 0 },
  { match: /radar|sensor station|listening post/, name: 'Radar Site', iconType: 'radar', domain: 'land', hp: 4, moveRange: 0, acquireRange: 4, acquirePower: 2, engageRange: 0, engagePower: 0, splashRadius: 0 },
  { match: /bombers?|b-21|h-6/, name: 'Bomber Wing', iconType: 'bomber', domain: 'air', hp: 4, moveRange: 4, acquireRange: 1, acquirePower: 1, engageRange: 3, engagePower: 3, splashRadius: 1 },
  { match: /drones?|uav|ucav|loyal wingm[ae]n|ghost bat/, name: 'UCAV Flight', iconType: 'drone', domain: 'air', hp: 2, moveRange: 5, acquireRange: 2, acquirePower: 1, engageRange: 1, engagePower: 2, splashRadius: 0 },
  { match: /helicopters?|helos?|choppers?/, name: 'Helo Det', iconType: 'helicopter', domain: 'air', hp: 3, moveRange: 3, acquireRange: 2, acquirePower: 1, engageRange: 1, engagePower: 2, splashRadius: 0 },
  { match: /fighters?|jets?|squadron|f-35|j-20|su-\d+|strike (?:fighters?|jets?|aircraft)/, name: 'Fighter Sqn', iconType: 'fighter', domain: 'air', hp: 4, moveRange: 4, acquireRange: 2, acquirePower: 1, engageRange: 2, engagePower: 2, splashRadius: 0 },
  { match: /submarines?|\bsubs?\b|ssn|ssk/, name: 'Attack Submarine', iconType: 'submarine', domain: 'sea', hp: 5, moveRange: 2, acquireRange: 1, acquirePower: 1, engageRange: 2, engagePower: 4, splashRadius: 0 },
  { match: /carriers?|cvn|flattop/, name: 'Carrier Group', iconType: 'carrier', domain: 'sea', hp: 12, moveRange: 2, acquireRange: 3, acquirePower: 2, engageRange: 3, engagePower: 2, splashRadius: 0 },
  { match: /amphib|landing ship|lhd|marines? ship/, name: 'Amphibious Group', iconType: 'amphib', domain: 'sea', hp: 8, moveRange: 2, acquireRange: 1, acquirePower: 1, engageRange: 1, engagePower: 1, splashRadius: 0 },
  { match: /destroyers?|frigates?|cruisers?|warships?|corvettes?|ships?|awd|ddg/, name: 'Surface Combatant', iconType: 'destroyer', domain: 'sea', hp: 6, moveRange: 2, acquireRange: 3, acquirePower: 2, engageRange: 3, engagePower: 3, splashRadius: 0 },
  { match: /missile|sam\b|battery|launchers?|artillery|himars|rocket/, name: 'Missile Battery', iconType: 'missile_battery', domain: 'land', hp: 5, moveRange: 1, acquireRange: 2, acquirePower: 1, engageRange: 4, engagePower: 3, splashRadius: 0 },
  { match: /tanks?|armou?r|mechani[sz]ed/, name: 'Armored Coy', iconType: 'armor', domain: 'land', hp: 6, moveRange: 2, acquireRange: 1, acquirePower: 1, engageRange: 1, engagePower: 3, splashRadius: 0 },
  { match: /infantry|troops|marines|soldiers|commandos|special forces|militia/, name: 'Infantry Coy', iconType: 'infantry', domain: 'land', hp: 5, moveRange: 1, acquireRange: 1, acquirePower: 1, engageRange: 1, engagePower: 2, splashRadius: 0 },
];

const SPAWN_VERBS = /\b(deploy|deploys|deployed|spawn|spawns|launch|launches|send|sends|add|adds|reinforce|reinforces|arrive|arrives|appear|appears|create|creates|summon|summons|place|places|position|positions|scramble|scrambles|insert|inserts|release|releases)\b/;
const EVENT_WORDS = /\b(earthquake|tsunami|volcan\w*|eruption|nuke|nuclear|explosion|explodes|blast|meteor|asteroid|bombardment|barrage|airstrike|strike package|emp|flood\w*|landslide|sinkhole|detonat\w*|firestorm)\b/;
const STAT_WORDS: [RegExp, ModifiableStat][] = [
  [/\b(move|movement|moves|speed|mobility|maneuver|manoeuvre|transit)\b/, 'moveRange'],
  [/\b(radar|sensor|sensors|detection|acquire|acquisition|visibility|tracking|jamming|jammed|ew)\b/, 'acquirePower'],
  [/\b(attack|damage|firepower|engage|engagement|weapons?|strike power|lethality|missiles?)\b/, 'engagePower'],
];

const RED_WORDS = /\b(red|enemy|enemies|hostile|opfor|china|chinese|prc|pla|adversary|opponent|russia|russian)\b/;
const BLUE_WORDS = /\b(blue|friendly|allied|allies|our|we|us|usa|u\.s\.|american|australia|australian|raaf|ran|navy reinforcements|player|my)\b/;
const NEUTRAL_WORDS = /\b(neutral|natural|environment(al)?|wild|hazard)\b/;

export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^(of|the|and|a)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Turn "China releases 3 angry geese near our fleet" into "Angry Geese". */
export function extractEntityName(prompt: string): string {
  let n = prompt
    .toLowerCase()
    .replace(/\(\s*-?\d+\s*,\s*-?\d+\s*\)/g, ' ')
    .replace(/["'`]/g, '');
  // Drop everything after the first location/clause marker.
  n = n.split(/\b(?:at|near|over|in|on|into|onto|from|that|which|who|with|to|towards?|appears?|arrives?|attacks?|invades?|lands?|emerges?|shows up|descends?|is|are|has|have|will|for|around|across|above|beside)\b/)[0];
  // Drop leading actors/verbs/articles/quantities.
  n = n.replace(
    /^\s*(?:(?:the|a|an|some|several|many|lots of|\d+x?|one|two|three|four|five)\s+|(?:herd|pack|flock|swarm|horde|school|fleet|squad|army|legion|colony|bunch|group|wave|murder|gaggle|pod|pride|team) of\s+|(?:china|chinese|the enemy|enemy|red|blue|our|we|they|allies|allied|friendly|hostile|russia|usa|us|australia)\s+(?:\w+s\s+)?|(?:spawn|spawns|deploy|deploys|send|sends|launch|launches|summon|summons|release|releases|create|creates|add|adds|unleash|unleashes|drop|drops|build|builds|bring|brings|there (?:is|are))\s+)+/,
    '',
  );
  n = n.replace(/[^a-z0-9&\- ]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = n.split(' ').filter(Boolean).slice(0, 4);
  const name = titleCase(words.join(' '));
  return name.length >= 2 ? name.slice(0, 30) : 'Unknown Entity';
}

export function findCoords(t: string): { col: number; row: number } | null {
  const m = t.match(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/) ?? t.match(/\b(?:at|to|on|near|hex)\s+(-?\d+)\s*[,/ ]\s*(-?\d+)\b/);
  return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
}

export function findNum(t: string, re: RegExp): number | undefined {
  const m = t.match(re);
  return m ? Number(m[1]) : undefined;
}

export function detectTeam(t: string, fallback: Team): Team {
  if (NEUTRAL_WORDS.test(t)) return 'neutral';
  if (RED_WORDS.test(t)) return 'red';
  if (BLUE_WORDS.test(t)) return 'blue';
  return fallback;
}

function extractName(prompt: string): string | null {
  const m = prompt.match(
    /\b(?:deploys?|spawns?|launch(?:es)?|sends?|adds?|scrambles?|releases?|summons?|places?|inserts?|creates?)\s+(?:a|an|the|some|\d+x?|\d+\s+squadrons?\s+of)?\s*([a-z0-9&\-' ]{3,32}?)\s+(?:at|to|near|in|on|into|over|that|which|who|with)\b/i,
  );
  if (!m) return null;
  return titleCase(m[1].trim().replace(/\s+/g, ' '));
}

export interface LocalParseResult {
  mutations: unknown[];
  narrative: string;
}

export function parseLocally(prompt: string): LocalParseResult {
  const t = prompt.toLowerCase();
  const coords = findCoords(t);
  const duration = findNum(t, /for\s+(\d+)\s+turns?/) ?? (/\bpermanent(ly)?\b/.test(t) ? 0 : undefined);

  // ── DEFINE_MECHANIC (preset templates; Claude handles arbitrary ones) ──
  if (!coords && (MECHANIC_INTENT.test(t) || PRESETS.some((p) => p.match.test(t)))) {
    let domain: Domain | 'all' = 'all';
    if (/\b(air|aircraft|planes?|fighters?|jets?|squadrons?|aviation)\b/.test(t)) domain = 'air';
    else if (/\b(sea|naval|ships?|fleet|vessels?|destroyers?|subs?|submarines?)\b/.test(t)) domain = 'sea';
    else if (/\b(ground|land|army|troops|batter(?:y|ies))\b/.test(t)) domain = 'land';
    const team = detectTeam(t, 'neutral');
    const onceTwice = /\bonce\b/.test(t) ? 1 : /\btwice\b/.test(t) ? 2 : undefined;
    const n = findNum(t, /\b(\d+)\b(?!\s*(?:turns?\s+(?:in|of))\b)/) ?? onceTwice;
    const draft = matchPreset(t, { team: team === 'neutral' ? 'all' : team, domain, n });
    if (draft) {
      return { mutations: [{ type: 'DEFINE_MECHANIC', payload: draft }], narrative: `Local parser: new mechanic "${draft.name}".` };
    }
    if (MECHANIC_INTENT.test(t) && !TEMPLATES.some((x) => x.match.test(t)) && !STAT_WORDS.some(([re]) => re.test(t))) {
      throw new Error(
        'The local parser only knows preset mechanics (fuel, teleport, repairs, ammo, veterancy, reinforcements, attrition). Add a Claude API key to invent any mechanic.',
      );
    }
  }

  // ── TRIGGER_EVENT ──
  if (EVENT_WORDS.test(t) && coords && !SPAWN_VERBS.test(t.replace(/strikes?/, ''))) {
    const word = t.match(EVENT_WORDS)![0];
    let terrainChange: Terrain | 'none' = 'none';
    if (/flood|tsunami|sinks?|submerge|sinkhole/.test(t)) terrainChange = 'sea';
    if (/volcan|eruption|island rises|raise|uplift|landslide/.test(t)) terrainChange = 'land';
    return {
      mutations: [
        {
          type: 'TRIGGER_EVENT',
          payload: {
            eventName: titleCase(word.replace(/s$/, '')),
            targetHex: coords,
            radius: findNum(t, /radius\s+(?:of\s+)?(\d+)/) ?? (/(nuke|nuclear|tsunami|earthquake|meteor|asteroid)/.test(t) ? 2 : 1),
            damage: findNum(t, /(\d+)\s*(?:points? of\s+)?(?:dmg|damage)/) ?? (/(nuke|nuclear|meteor)/.test(t) ? 5 : 2),
            terrainChange,
          },
        },
      ],
      narrative: `Local parser: event "${word}" at (${coords.col},${coords.row}).`,
    };
  }

  // ── SPAWN_UNIT ──
  const tpl = TEMPLATES.find((x) => x.match.test(t));
  // Unknown things fall through to the universal interpreter, which derives stats from traits.
  // Only claim the spawn if the template word is the thing's main noun ("rocket-powered goose" is not a missile battery).
  const headWords = extractEntityName(prompt).toLowerCase().split(' ');
  const lastWord = headWords[headWords.length - 1] ?? '';
  // "Typhoon cell", "fighter squadron": allow a generic trailing word after the real noun.
  const GENERIC_TAIL = /^(cell|unit|units|group|squad|squadron|force|team|flight|wing|battery|detachment|det|coy|company)$/;
  const core = GENERIC_TAIL.test(lastWord) && headWords.length > 1 ? headWords.slice(0, -1) : headWords;
  const endsWithTemplate = (x: string) => !!tpl && new RegExp(`(?:${tpl.match.source})$`).test(x);
  const isHeadNoun = endsWithTemplate(core.slice(-1).join(' ')) || endsWithTemplate(core.slice(-2).join(' '));
  if (tpl && coords && isHeadNoun) {
    const base: Template = tpl ?? {
      match: /./,
      name: 'Unknown Asset',
      iconType: 'generic',
      domain: 'air',
      hp: 3,
      moveRange: 2,
      acquireRange: 1,
      acquirePower: 1,
      engageRange: 1,
      engagePower: 2,
      splashRadius: 0,
    };
    let domain = base.domain;
    if (/\b(fly|flies|flying|airborne|over any terrain|ignores? terrain)\b/.test(t)) domain = 'air';
    else if (/\b(naval|at sea|sails?|swims?|underwater)\b/.test(t)) domain = 'sea';
    else if (/\b(ground|on land|ashore|dug[- ]in)\b/.test(t)) domain = 'land';

    const engagePower = findNum(t, /(\d+)\s*(?:splash\s+)?(?:dmg|damage|attack|firepower)/) ?? base.engagePower;
    const splashRadius = /splash|area|aoe|blast radius/.test(t) ? Math.max(1, findNum(t, /splash radius\s+(\d+)/) ?? 1) : base.splashRadius;
    const hp = findNum(t, /(\d+)\s*(?:hp|health|hit points?)/) ?? base.hp;
    const moveRange = findNum(t, /(?:move|speed|movement)\s+(?:of\s+|range\s+)?(\d+)/) ?? findNum(t, /(\d+)\s+(?:move|movement)/) ?? base.moveRange;
    const engageRange = findNum(t, /(?:range|reach)\s+(?:of\s+)?(\d+)/) ?? base.engageRange;
    // Count only when a number directly precedes the unit noun ("3 fighters", "2x drones").
    const nounAt = tpl ? t.search(tpl.match) : -1;
    const countM = nounAt > 0 ? t.slice(0, nounAt).match(/\b([2-9])\s*x?\s+(?:[a-z-]+\s+)?$/) : null;
    const count = Math.min(4, countM ? Number(countM[1]) : 1);
    const team = detectTeam(t, base.iconType === 'hazard' ? 'neutral' : 'blue');
    const name = extractName(prompt) ?? base.name;

    const muts = Array.from({ length: count }, (_, i) => ({
      type: 'SPAWN_UNIT',
      payload: {
        team,
        name: count > 1 ? `${name} ${i + 1}` : name,
        iconType: base.iconType,
        hexCoords: coords, // validator relocates duplicates to nearest free hex
        hp,
        maxHp: hp,
        moveRange,
        acquireRange: base.acquireRange,
        acquirePower: base.acquirePower,
        engageRange,
        engagePower,
        splashRadius,
        domain,
        durationTurns: duration ?? (base.iconType === 'swarm' || base.iconType === 'hazard' ? 3 : 0),
      },
    }));
    return { mutations: muts, narrative: `Local parser: spawn ${count}× ${name} (${team}).` };
  }

  // ── MODIFY_GLOBAL_RULE ──
  // A stat rule needs a stat word AND an explicit change ("reduces radar by 1"), so
  // "a laser destroys the missile battery" isn't misread as a missile rule.
  const statHit = STAT_WORDS.find(([re]) => re.test(t));
  const changeWord =
    /\b(reduc\w*|increas\w*|boost\w*|lower\w*|rais\w*|cuts?|slow\w*|halv\w*|improv\w*|degrad\w*|jams?|jamm\w*|blind\w*|buff\w*|nerf\w*|penalt\w*|bonus|decreas\w*|by\s+\d)/.test(t) || /[+-]\s*\d/.test(t);
  if (statHit && changeWord) {
    const stat = statHit[1];
    const n = findNum(t, /\bby\s+(\d+)/) ?? findNum(t, /[+-]\s*(\d+)/) ?? findNum(t, /\b(\d+)\b(?!\s*turns?)/) ?? 1;
    const negative = /\b(reduce|reduces|reduced|decrease|decreases|lower|lowers|slow|slows|cut|cuts|halve|minus|degrade|degrades|jam|jams|jammed|penalty|blind|blinds|less)\b|-\s*\d/.test(t);
    const delta = negative ? -n : n;
    let targetDomain: Domain | 'all' = 'all';
    if (/\b(sea|naval|ships?|maritime|surface)\b/.test(t)) targetDomain = 'sea';
    else if (/\b(air|aircraft|planes?|fighters?|aviation|flight)\b/.test(t)) targetDomain = 'air';
    else if (/\b(land|ground|army|coastal)\b/.test(t)) targetDomain = 'land';
    // The affected side is whoever is named AFTER the verb ("Enemy jamming reduces OUR radar").
    const VERB = /\b(?:reduces?|increases?|boosts?|slows?|cuts?|lowers?|degrades?|jams?|halves?|grants?|gives?|blinds?|improves?|raises?|decreases?)\b/i;
    const parts = t.split(VERB);
    const team = parts.length > 1 ? detectTeam(parts[parts.length - 1], detectTeam(t, 'neutral')) : detectTeam(t, 'neutral');
    const causeMatch = prompt.match(new RegExp(`^([A-Za-z][A-Za-z '\\-]{2,30}?)\\s+${VERB.source}`, 'i'));
    const cause = causeMatch ? titleCase(causeMatch[1]) : 'Scenario Modifier';
    return {
      mutations: [
        {
          type: 'MODIFY_GLOBAL_RULE',
          payload: {
            ruleId: `${cause}_${stat}`.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
            description: `${cause}: ${targetDomain === 'all' ? 'all' : targetDomain} ${stat} ${delta > 0 ? '+' : ''}${delta}`,
            targetDomain,
            targetTeam: team === 'neutral' ? 'all' : team,
            statModified: stat,
            delta,
            durationTurns: duration ?? 3,
          },
        },
      ],
      narrative: `Local parser: global rule on ${stat}.`,
    };
  }

  if (!coords && (SPAWN_VERBS.test(t) || EVENT_WORDS.test(t))) {
    throw new Error('Need hex coordinates — e.g. "at (6,4)".');
  }
  throw new Error('Local parser could not interpret that. Try a unit + "at (col,row)", a stat change, or an event. Add a Claude API key for free-form prompts.');
}
