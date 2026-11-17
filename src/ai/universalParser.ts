// ─────────────────────────────────────────────────────────────────────────────
// "Scribblenauts" fallback interpreter. Runs when nothing more specific matched
// (and when no AI model is available). It NEVER fails: every prompt becomes a
// playable mutation.
//
//   instant action  ("lightning strikes (4,2)", "laser beam from space")  → TRIGGER_EVENT
//   area phenomenon ("heavy fog", "radioactive fallout", "force field")    → CREATE_ZONE
//   abstract event  ("economic collapse", "internet goes down")            → MODIFY_GLOBAL_RULE
//   anything else   ("angry geese", "alien mothership")                    → SPAWN_UNIT
//
// Unit stats are DERIVED from descriptive traits rather than looked up:
// heavy → slow & tough, fast → high movement, laser → long range, giant → big
// HP + splash. The output still goes through validate.ts like everything else.
// ─────────────────────────────────────────────────────────────────────────────
import { nearestFreeHex } from '../engine/engine';
import { hexDistance } from '../engine/hex';
import type { Domain, GameState, HexCoord, IconType, ModifiableStat, StatKey, Team, Terrain, ZoneVisual } from '../engine/types';
import { detectTeam, extractEntityName, findCoords, findNum, titleCase } from './localParser';

export interface UniversalResult {
  mutations: unknown[];
  narrative: string;
  /** What the interpreter decided the prompt was, for the Codex. */
  category: 'event' | 'zone' | 'rule' | 'entity';
}

// ── Targeting / placement ────────────────────────────────────────────────────

const ENEMY_REF = /\b(enemy|enemies|red|hostile|china|chinese|pla|their|opfor|adversary|kestrel)\b/;
const OUR_REF = /\b(our|my|we|us|blue|allied|friendly|halcyon|fleet|task group)\b/;

function center(s: GameState): HexCoord {
  return { col: Math.floor((s.map.cols - 1) / 2), row: Math.floor(s.map.rows / 2) };
}

/** Hex of the unit with the most same-team neighbours (a "cluster"). */
function clusterOf(s: GameState, team: Team): HexCoord | null {
  const us = s.units.filter((u) => u.team === team);
  if (!us.length) return null;
  let best = us[0];
  let bestN = -1;
  for (const u of [...us].sort((a, b) => a.id.localeCompare(b.id))) {
    const n = us.filter((o) => hexDistance(o.pos, u.pos) <= 1).length + (u.isHVT ? 0.5 : 0);
    if (n > bestN) [best, bestN] = [u, n];
  }
  return best.pos;
}

/** Work out WHERE a prompt is aimed: coordinates, a named place/unit, a side, a compass area, or the centre. */
export function resolveTarget(t: string, s: GameState): { hex: HexCoord; how: string } {
  const c = findCoords(t);
  if (c) return { hex: c, how: `(${c.col},${c.row})` };

  for (const tile of s.map.tiles.filter((x) => x.terrain === 'city' && x.name)) {
    const first = tile.name!.toLowerCase().split(' ')[1] ?? tile.name!.toLowerCase();
    if (t.includes(tile.name!.toLowerCase()) || t.includes(first)) return { hex: tile, how: tile.name! };
  }
  if (/\b(their|enemy) (port|city|harbou?r|base)\b/.test(t)) {
    const city = s.map.tiles.find((x) => x.terrain === 'city' && x.owner === 'red');
    if (city) return { hex: city, how: city.name! };
  }
  if (/\b(our) (port|city|harbou?r|base)\b/.test(t)) {
    const city = s.map.tiles.find((x) => x.terrain === 'city' && x.owner === 'blue');
    if (city) return { hex: city, how: city.name! };
  }

  // Named terrain features
  if (/\b(atoll|reef|mid-?sea island|central island)\b/.test(t)) {
    const isles = s.map.tiles.filter((x) => x.terrain !== 'sea' && x.terrain !== 'city' && x.col >= 3 && x.col <= 5);
    if (isles.length) return { hex: isles[0], how: 'the atoll' };
  }
  if (/\b(our|home|blue) island\b/.test(t)) {
    const city = s.map.tiles.find((x) => x.terrain === 'city' && x.owner === 'blue');
    if (city) return { hex: city, how: 'the home island' };
  }
  if (/\b(mainland|coast(?:line)?|shore)\b/.test(t)) {
    const coast = s.map.tiles.filter((x) => x.terrain === 'coast' && x.col >= 6);
    if (coast.length) return { hex: coast[Math.floor(coast.length / 2)], how: 'the enemy coastline' };
  }

  // A unit named in the prompt ("the missile battery", "the destroyer", "AEW")
  let bestUnit: { pos: HexCoord; name: string; score: number } | null = null;
  for (const u of s.units) {
    const words = u.name.toLowerCase().split(/[^a-z&]+/).filter((w) => w.length > 3);
    let score = words.filter((w) => new RegExp(`\\b${w.replace('&', '\\&')}`).test(t)).length;
    if (u.iconType === 'destroyer' && /\b(destroyer|awd|warship)\b/.test(t)) score += 2;
    if (u.iconType === 'aew' && /\b(aew|awacs|radar plane|wedgetail)\b/.test(t)) score += 2;
    if (u.iconType === 'amphib' && /\b(amphib\w*|task group|troop ?ships?)\b/.test(t)) score += 2;
    if (u.iconType === 'missile_battery' && /\b(battery|missile site|launcher)\b/.test(t)) score += 2;
    if (score && ENEMY_REF.test(t) && u.team === 'red') score += 1;
    if (score && OUR_REF.test(t) && u.team === 'blue') score += 1;
    if (score > 1 && (!bestUnit || score > bestUnit.score)) bestUnit = { pos: u.pos, name: u.name, score };
  }
  if (bestUnit) return { hex: bestUnit.pos, how: bestUnit.name };

  if (ENEMY_REF.test(t)) {
    const h = clusterOf(s, 'red');
    if (h) return { hex: h, how: 'the main Red concentration' };
  }
  if (OUR_REF.test(t)) {
    const h = clusterOf(s, 'blue');
    if (h) return { hex: h, how: 'the main Blue concentration' };
  }

  const ctr = center(s);
  let col = ctr.col;
  let row = ctr.row;
  if (/\bnorth/.test(t)) row = 1;
  if (/\bsouth/.test(t)) row = s.map.rows - 2;
  if (/\bwest/.test(t)) col = 1;
  if (/\beast/.test(t)) col = s.map.cols - 2;
  return { hex: { col, row }, how: col === ctr.col && row === ctr.row ? 'the centre of the map' : 'that sector' };
}

/** Pick a legal free hex for a unit near where the prompt points (or its side's area). */
function placeUnit(t: string, s: GameState, team: Team, domain: Domain): HexCoord {
  const explicit = findCoords(t);
  let anchor: HexCoord;
  if (explicit || ENEMY_REF.test(t) || OUR_REF.test(t) || /\b(north|south|east|west|near|over|at|around)\b/.test(t)) {
    anchor = resolveTarget(t, s).hex;
  } else if (team === 'blue') {
    anchor = clusterOf(s, 'blue') ?? center(s);
  } else if (team === 'red') {
    anchor = s.map.tiles.find((x) => x.terrain === 'city' && x.owner === 'red') ?? center(s);
  } else {
    anchor = center(s);
  }
  return nearestFreeHex(s, anchor, domain, 5) ?? anchor;
}

// ── Lexicons ─────────────────────────────────────────────────────────────────

const EVENT_NOUN =
  /\b(lightning|thunderbolt|meteor\w*|asteroid|comet|orbital|beam|death ray|nuke|nuclear strike|explosion|earthquake|quake|tsunami|eruption|airstrike|air strike|bombardment|barrage|emp blast|smite|landslide|avalanche|sinkhole|firestorm|shockwave|tidal wave|space laser|kinetic strike|rods from god)\b/;
const EVENT_VERB = /\b(strikes?|hits?|smash(?:es)?|zaps?|obliterates?|vapori[sz]es?|bombards?|blasts?|crash(?:es)? into|rains? down|falls? on|detonates?|explodes?|nukes?|incinerates?|levels?)\b/;

interface ZoneType {
  re: RegExp;
  name: string;
  visual: ZoneVisual;
  mods: { stat: StatKey; delta: number }[];
  damage: number;
  blocks?: boolean;
  domain?: Domain | 'all';
}
const ZONE_TYPES: ZoneType[] = [
  { re: /\b(force ?field|shield dome|energy shield|energy barrier|barrier|great wall|wall of \w+)\b/, name: 'Force Field', visual: 'energy', mods: [], damage: 0, blocks: true },
  { re: /\b(radiation|radioactive|fallout|nuclear waste)\b/, name: 'Radiation Zone', visual: 'radiation', mods: [{ stat: 'acquirePower', delta: -1 }], damage: 1 },
  { re: /\b(toxic|poison\w*|gas|chemical|acid|spores|oil spill|pollution|smog)\b/, name: 'Toxic Cloud', visual: 'toxic', mods: [{ stat: 'engagePower', delta: -1 }], damage: 1 },
  { re: /\b(minefield|mines|naval mines|sea mines)\b/, name: 'Minefield', visual: 'generic', mods: [{ stat: 'moveRange', delta: -1 }], damage: 2, domain: 'sea' },
  { re: /\b(wildfire|fire|blaze|inferno|lava|magma|burning)\b/, name: 'Wildfire', visual: 'fire', mods: [], damage: 1, blocks: true, domain: 'land' },
  { re: /\b(jamming|jammer|electronic warfare|emp field|magnetic|interference|static|signal noise)\b/, name: 'Jamming Field', visual: 'energy', mods: [{ stat: 'acquirePower', delta: -3 }, { stat: 'acquireRange', delta: -1 }], damage: 0 },
  { re: /\b(fog|mist|smoke|haze|darkness|dust|sandstorm|ash cloud|volcanic ash|cloud cover|night)\b/, name: 'Fog Bank', visual: 'fog', mods: [{ stat: 'acquirePower', delta: -2 }, { stat: 'acquireRange', delta: -1 }], damage: 0 },
  { re: /\b(blizzard|snow\w*|ice|icy|frozen|freez\w*|hail|frost)\b/, name: 'Blizzard', visual: 'ice', mods: [{ stat: 'moveRange', delta: -1 }, { stat: 'engagePower', delta: -1 }], damage: 0 },
  { re: /\b(whirlpool|maelstrom|rough seas|riptide|rogue waves?|current)\b/, name: 'Maelstrom', visual: 'storm', mods: [{ stat: 'moveRange', delta: -2 }], damage: 1, domain: 'sea' },
  { re: /\b(swamp|mud|quicksand|bog|marsh|flooded fields)\b/, name: 'Quagmire', visual: 'toxic', mods: [{ stat: 'moveRange', delta: -2 }], damage: 0, domain: 'land' },
  { re: /\b(storm|rain\w*|thunderstorm|squall|gale|hurricane|cyclone|monsoon|tornado|weather)\b/, name: 'Storm Front', visual: 'storm', mods: [{ stat: 'moveRange', delta: -1 }, { stat: 'acquirePower', delta: -1 }], damage: 0 },
  { re: /\b(aurora|sunshine|clear skies|holy light|blessing|sanctuary|high ground|observation post|beacon)\b/, name: 'Clear Skies', visual: 'generic', mods: [{ stat: 'acquirePower', delta: 1 }, { stat: 'acquireRange', delta: 1 }], damage: 0 },
];

interface AbstractType {
  re: RegExp;
  label: string;
  stat: ModifiableStat;
  positive?: boolean;
}
const ABSTRACT_TYPES: AbstractType[] = [
  { re: /\b(innovation|breakthrough|upgrade\w*|new tech\w*|research|invention|firmware|software update)\b/, label: 'Tech Breakthrough', stat: 'acquirePower', positive: true },
  { re: /\b(internet|cyber\w*|hack\w*|network|comms|communications|gps|satellites?|solar flare|outage|blackout|power grid|wi-?fi|data|servers?|computer|ransomware|ai uprising|signals?)\b/, label: 'Comms Disruption', stat: 'acquirePower' },
  { re: /\b(econom\w*|market|inflation|recession|depression|budget|sanctions?|bankrupt\w*|stocks?|currency|debt|financ\w*|tariffs?|trade war|prices?|money|crypto)\b/, label: 'Economic Shock', stat: 'moveRange' },
  { re: /\b(supply|supplies|logistic\w*|shortage|rationing|labou?r strike|union|fuel|oil|shipping)\b/, label: 'Supply Crisis', stat: 'moveRange' },
  { re: /\b(pandemic|plague|flu|virus|disease|illness|food poisoning|fatigue|exhaustion|hangover|sleep\w*|famine)\b/, label: 'Readiness Crisis', stat: 'engagePower' },
  { re: /\b(morale|propaganda|election|protests?|riots?|holiday|celebrat\w*|festival|party|music|sing\w*|songs?|speech|news|scandal|mutiny|desertion|pep talk|memes?|viral|religio\w*|prayer|hope|fear|panic|terror|courage|rage|fury|motivation|pizza|coffee|snacks?)\b/, label: 'Morale Shift', stat: 'engagePower' },
];
const POSITIVE = /\b(boom\w*|surge\w*|soar\w*|rall(y|ies)|boost\w*|improv\w*|upgrade\w*|breakthrough|victor\w*|inspir\w*|hope|pep talk|bonus|stimulus|wins?|prosper\w*|thriv\w*|record high|courage|motivat\w*|pizza|coffee|snacks?|celebrat\w*|festival|party|music|sing\w*)\b/;
const SEVERE = /\b(collapse\w*|crash\w*|catastroph\w*|total|massive|meltdown|apocalyp\w*|complete|devastat\w*|global|worldwide|huge)\b/;
const MAP_WIDE = /\b(everywhere|whole map|entire map|across the (?:map|board|region)|all hexes|worldwide|global(?:ly)?|the whole sea)\b/;

// ── Entities: domain, look, and stats from traits ───────────────────────────

const AIR_WORDS =
  /\b(fl(y|ies|ying)|wings?|winged|birds?|geese|goose|ducks?|seagulls?|gulls?|pigeons?|eagles?|hawks?|crows?|ravens?|owls?|bats?|bees?|wasps?|hornets?|locusts?|mosquito\w*|butterfl\w*|dragons?|ufos?|saucers?|motherships?|airships?|zeppelins?|blimps?|balloons?|planes?|jets?|helicopters?|choppers?|drones?|space\w*|satellites?|angels?|phoenix|griffins?|pterodactyls?|kites?|rockets?|fairies|witch\w*|superman|airborne|sky|skies|cloud)\b/;
const SEA_WORDS =
  /\b(ships?|boats?|subs?|submarines?|sharks?|whales?|kraken|octop\w*|squids?|fish\w*|dolphins?|pirates?|navy|naval|swims?|swimming|underwater|serpents?|mermaids?|jellyfish|crabs?|lobsters?|seals?|penguins?|icebergs?|rafts?|yachts?|ferr(y|ies)|canoes?|battleships?|frigates?|cruisers?|leviathans?|turtles?|sea monster)\b/;
const LAND_WORDS =
  /\b(tanks?|soldiers?|troops|army|armies|infantry|robots?|mechs?|dinosaurs?|t-?rex|elephants?|bears?|wolf|wolves|zombies?|knights?|cavalry|horses?|trucks?|cars?|bulldozers?|golems?|towers?|fortress\w*|castles?|walls?|cannons?|artillery|ninjas?|cowboys?|bigfoot|yetis?|giants?|trolls?|orcs?|goblins?|rhinos?|gorillas?|lions?|tigers?|marines|commandos?|militia|tractors?|trains?|godzilla|kaiju|goats?|cows?|cattle|bulls?|sheep|pigs?|boars?|chickens?|cats?|dogs?|hamsters?|llamas?|alpacas?|camels?|moose|deer|kangaroos?|koalas?|emus?|ostrich\w*|capybaras?|raccoons?|squirrels?|frogs?|toads?|snakes?|lizards?|crocodiles?|alligators?|hippos?|giraffes?|monkeys?|apes?|pandas?|badgers?|beavers?|wombats?|mice|rats?|ants?|spiders?|scorpions?|beetles?|snails?|slugs?|mammoths?|unicorns?|minotaurs?|centaurs?|vampires?|werewolf|werewolves|skeletons?|mummies|mummy|clowns?|grandmas?|farmers?|scientists?|robot|cheese)\b/;
const PEOPLE_WORDS = /\b(soldiers?|troops|army|armies|infantry|zombies?|knights?|ninjas?|cowboys?|marines|commandos?|militia|pirates?|orcs?|goblins?|people|crowd|mob|protesters?|tourists?|monks?)\b/;
const SWARM_WORDS =
  /\b(swarm|flock|horde|pack|army|legion|wave|school|colony|herd|murder|geese|bees|bats|locusts|wasps|hornets|mosquito\w*|birds|pigeons|seagulls|gulls|crows|ravens|zombies|rats|ants|spiders|drones)\b/;

interface Trait {
  re: RegExp;
  tag: string;
  hp?: number;
  move?: number;
  acqR?: number;
  acqP?: number;
  engR?: number;
  engP?: number;
  splash?: number;
}
const TRAITS: Trait[] = [
  { re: /\b(giant|huge|colossal|massive|enormous|titanic|mega|kaiju|motherships?|leviathans?|godzilla|titans?|behemoths?|gargantuan|immense|monstrous|fortress|battleships?)\b/, tag: 'colossal', hp: 7, move: -1, engP: 2, splash: 1 },
  { re: /\b(tiny|small|mini|micro|little|baby|pocket|pixie|miniature)\b/, tag: 'tiny', hp: -2, move: 1, engP: -1 },
  { re: /\b(fast|swift|rapid|speedy|supersonic|hypersonic|turbo|racing|nimble|zippy|quick|rocket-?powered|lightning-?fast|agile)\b/, tag: 'fast', move: 2 },
  { re: /\b(slow|lumbering|sluggish|heavy|ponderous|armou?red|tanky|bulky|fat|chonky|lazy)\b/, tag: 'heavy', move: -1, hp: 3 },
  { re: /\b(angry|furious|rabid|berserk\w*|killer|vicious|feral|enraged|deadly|murderous|evil|fierce|savage|bloodthirsty|mad|crazed|hangry|aggressive)\b/, tag: 'aggressive', engP: 1 },
  { re: /\b(lasers?|beams?|cannons?|railguns?|snipers?|artillery|missiles?|rockets?|long-?range|plasma guns?|ray guns?|catapults?|longbows?|archers?)\b/, tag: 'ranged', engR: 2 },
  { re: /\b(explosive|exploding|bombs?|nuclear|incendiary|fire|flaming|fiery|plasma|acid\w*|napalm|kamikaze|volatile|fire-?breathing)\b/, tag: 'explosive', engP: 1, splash: 1 },
  { re: /\b(radars?|eyes?|all-?seeing|spy|spies|scouts?|watchers?|sensors?|psychic|oracles?|telescopes?|recon\w*|seeing)\b/, tag: 'sensor', acqR: 3, acqP: 2 },
  { re: /\b(shield\w*|invulnerable|indestructible|steel|iron|diamond|titanium|robot\w*|mechs?|cyborgs?|armou?r(ed)?|stone|rock|golems?)\b/, tag: 'armored', hp: 4 },
  { re: /\b(ghosts?|stealth\w*|invisible|cloaked|ninjas?|shadows?|phantoms?|spectral|silent)\b/, tag: 'elusive', move: 1, hp: -1 },
  { re: /\b(radioactive|toxic|poisonous|venomous|mutant|mutated|irradiated|zombie|plague)\b/, tag: 'toxic', engP: 1, hp: 1 },
  { re: /\b(alien|ufos?|space|cosmic|extraterrestrial|sci-?fi|cyber\w*|quantum|futuristic|magic\w*|wizard\w*|mystic\w*|dragons?)\b/, tag: 'exotic', acqP: 1, engP: 1 },
  { re: /\b(cute|fluffy|harmless|peaceful|sleepy|friendly|gentle|tiny kittens|puppies|kittens?|bunn(y|ies)|confused|lost)\b/, tag: 'harmless', engP: -2 },
];
const TRANSIENT = /\b(swarm|flock|ghosts?|phantoms?|spirits?|wave|storm|cloud|balloons?|bubbles?|hologram\w*|illusion|kamikaze|fireworks?)\b/;

const BASE: Record<Domain, { hp: number; move: number; acqR: number; acqP: number; engR: number; engP: number }> = {
  air: { hp: 3, move: 3, acqR: 1, acqP: 1, engR: 1, engP: 2 },
  sea: { hp: 5, move: 2, acqR: 2, acqP: 1, engR: 2, engP: 2 },
  land: { hp: 5, move: 1, acqR: 1, acqP: 1, engR: 1, engP: 2 },
};

function pickDomain(t: string, tags: Set<string>): Domain {
  // Score each domain by cue words; ties prefer air (it can stand anywhere).
  const score = (re: RegExp) => (t.match(new RegExp(re.source, 'g')) ?? []).length;
  const a = score(AIR_WORDS);
  const sea = score(SEA_WORDS);
  const land = score(LAND_WORDS);
  if (sea > a && sea >= land) return 'sea';
  if (land > a && land > sea) return 'land';
  if (a > 0) return 'air';
  return tags.has('heavy') || tags.has('armored') ? 'land' : 'air';
}

function pickIcon(t: string, domain: Domain, tags: Set<string>): IconType {
  if (SWARM_WORDS.test(t)) return 'swarm';
  if (tags.has('sensor') && !tags.has('ranged')) return domain === 'air' ? 'aew' : 'radar';
  if (domain === 'air') {
    if (/\bhelicopters?|choppers?\b/.test(t)) return 'helicopter';
    if (tags.has('colossal') || /\b(ufo|saucer|mothership|dragon|airship|zeppelin|blimp)\b/.test(t)) return 'bomber';
    if (/\b(jets?|planes?|fighters?)\b/.test(t) || tags.has('fast')) return 'fighter';
    return 'drone';
  }
  if (domain === 'sea') {
    if (tags.has('colossal')) return 'carrier';
    if (/\b(subs?|submarines?|sharks?|whales?|kraken|octop\w*|squids?|serpents?|underwater|leviathans?)\b/.test(t)) return 'submarine';
    return 'destroyer';
  }
  if (tags.has('ranged') && !PEOPLE_WORDS.test(t)) return 'missile_battery';
  if (PEOPLE_WORDS.test(t)) return 'infantry';
  return 'armor';
}

function interpretEntity(prompt: string, t: string, s: GameState): UniversalResult {
  const tags = new Set<string>();
  const stat = { hp: 0, move: 0, acqR: 0, acqP: 0, engR: 0, engP: 0, splash: 0 };
  for (const tr of TRAITS) {
    if (!tr.re.test(t)) continue;
    tags.add(tr.tag);
    stat.hp += tr.hp ?? 0;
    stat.move += tr.move ?? 0;
    stat.acqR += tr.acqR ?? 0;
    stat.acqP += tr.acqP ?? 0;
    stat.engR += tr.engR ?? 0;
    stat.engP += tr.engP ?? 0;
    stat.splash += tr.splash ?? 0;
  }
  const domain = pickDomain(t, tags);
  const icon = pickIcon(t, domain, tags);
  if (icon === 'swarm') {
    tags.add('swarm');
    stat.splash += 1;
    stat.hp -= 1;
    stat.move += 1;
  }
  const b = BASE[domain];
  const hp = Math.max(1, b.hp + stat.hp);
  // Fixed numbers in the prompt win over derived ones.
  const explicitHp = findNum(t, /(\d+)\s*(?:hp|health|hit points?)/);
  const explicitDmg = findNum(t, /(\d+)\s*(?:splash\s+)?(?:dmg|damage|attack|power)/);
  const explicitMove = findNum(t, /(?:moves?|speed|movement)\s+(?:of\s+)?(\d+)/);

  // Side comes from the SUBJECT ("China's dragons…"), not the target ("…near the enemy battery").
  const subject = t.split(/\b(?:at|near|over|around|towards?|against|beside|next to|behind|in front of|attacks?|attacking|hunts?|chases?|targets?|invades?|toward)\b/)[0];
  const spawnVerb = /\b(deploy|deploys|send|sends|launch|launches|summon|summons|build|builds|spawn|spawns|bring|brings|call in|calls in)\b/.test(subject);
  const wild =
    /\b(wild|feral|random|rogue|mysterious|unknown|stray)\b/.test(subject) ||
    (!spawnVerb && !/\b(our|my|we|enemy|china|chinese|red|blue|allied|hostile|russia|usa)\b/.test(subject));
  const team: Team = detectTeam(subject, wild ? 'neutral' : 'blue');
  // Count = a small number directly before the noun, ignoring turns/radius/damage/hp numbers.
  const tc = t.replace(/for\s+\d+\s+turns?|radius\s+\d+|\d+\s*(?:splash\s+)?(?:hp|dmg|damage|health|attack|power|turns?)/g, ' ');
  const count = Math.min(3, findNum(tc, /\b([2-9])\s+(?:[a-z-]+\s+)?[a-z]+/) ?? 1);
  const duration = findNum(t, /for\s+(\d+)\s+turns?/) ?? (TRANSIENT.test(t) || tags.has('swarm') ? 4 : 0);
  const name = extractEntityName(prompt);

  const muts = [];
  const placed: HexCoord[] = [];
  for (let i = 0; i < count; i++) {
    // Each copy goes on its own legal hex.
    const sim: GameState = { ...s, units: [...s.units, ...placed.map((p, j) => ({ ...s.units[0], id: `tmp${j}`, pos: p }))] };
    const pos = placeUnit(t, sim, team, domain);
    placed.push(pos);
    muts.push({
      type: 'SPAWN_UNIT',
      payload: {
        team,
        name: count > 1 ? `${name} ${i + 1}` : name,
        iconType: icon,
        hexCoords: pos,
        hp: explicitHp ?? hp,
        maxHp: explicitHp ?? hp,
        moveRange: explicitMove ?? Math.max(0, b.move + stat.move),
        acquireRange: Math.max(0, b.acqR + stat.acqR),
        acquirePower: Math.max(0, b.acqP + stat.acqP),
        engageRange: Math.max(tags.has('harmless') ? 0 : 1, b.engR + stat.engR),
        engagePower: explicitDmg ?? Math.max(0, b.engP + stat.engP),
        splashRadius: Math.min(2, stat.splash),
        domain,
        durationTurns: duration,
      },
    });
  }
  const traitText = tags.size ? [...tags].join(', ') : 'ordinary';
  return {
    category: 'entity',
    mutations: muts,
    narrative: `Interpreted "${name}" as a ${team} ${domain} ${icon.replace('_', ' ')} (${traitText}).`,
  };
}

function interpretEvent(t: string, s: GameState): UniversalResult {
  const { hex, how } = resolveTarget(t, s);
  const big = /\b(giant|huge|massive|colossal|nuclear|nuke|apocalyp\w*|asteroid|tsunami|earthquake|orbital|space|death ray|rods from god|mega)\b/.test(t);
  const pinpoint = /\b(lightning|thunderbolt|laser|beam|sniper|precision|surgical|smite|zap)\b/.test(t);
  const radius = findNum(t, /radius\s+(?:of\s+)?(\d+)/) ?? (pinpoint && !/\b(asteroid|nuke|nuclear)\b/.test(t) ? 0 : big ? 2 : 1);
  const damage = findNum(t, /(\d+)\s*(?:points? of\s+)?(?:dmg|damage)/) ?? (big ? (pinpoint ? 5 : 4) : pinpoint ? 3 : 2);
  let terrainChange: Terrain | 'none' = 'none';
  if (/\b(flood\w*|tsunami|tidal wave|sinks?|submerge\w*|sinkhole)\b/.test(t)) terrainChange = 'sea';
  if (/\b(volcan\w*|eruption|island rises|raise\w*|uplift|landslide|lava)\b/.test(t)) terrainChange = 'land';
  const noun = t.match(EVENT_NOUN)?.[0] ?? t.match(EVENT_VERB)?.[0] ?? 'strike';
  const name = /\blaser|beam\b/.test(t) && /\bspace|orbit/.test(t) ? 'Orbital Laser' : titleCase(noun.replace(/s$/, ''));
  return {
    category: 'event',
    mutations: [{ type: 'TRIGGER_EVENT', payload: { eventName: name, targetHex: hex, radius, damage, terrainChange } }],
    narrative: `${name} hits ${how.startsWith('(') ? how : `${how} (${hex.col},${hex.row})`} for ${damage}${radius ? `, radius ${radius}` : ''}.`,
  };
}

function interpretZone(prompt: string, t: string, s: GameState, z: ZoneType): UniversalResult {
  const duration = findNum(t, /for\s+(\d+)\s+turns?/) ?? (/\bpermanent\w*\b/.test(t) ? 0 : 3);
  const intense = /\b(heavy|thick|dense|severe|massive|deadly|lethal|extreme|huge|intense)\b/.test(t) ? 1 : 0;
  const mods = z.mods.map((m) => ({ stat: m.stat, delta: m.delta < 0 ? m.delta - intense : m.delta + intense }));
  const damage = z.damage ? z.damage + intense : 0;

  // Map-wide phenomena become global rules instead of a zone.
  if (MAP_WIDE.test(t) && mods.length) {
    return {
      category: 'rule',
      mutations: mods
        .filter((m): m is { stat: ModifiableStat; delta: number } => m.stat === 'moveRange' || m.stat === 'engagePower' || m.stat === 'acquirePower')
        .map((m) => ({
          type: 'MODIFY_GLOBAL_RULE',
          payload: {
            ruleId: `${z.name}_${m.stat}`.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
            description: `${z.name} (map-wide): ${m.stat} ${m.delta}`,
            targetDomain: z.domain ?? 'all',
            targetTeam: 'all',
            statModified: m.stat,
            delta: m.delta,
            durationTurns: duration,
          },
        })),
      narrative: `${z.name} blankets the whole theatre.`,
    };
  }

  const { hex, how } = resolveTarget(t, s);
  const radius = findNum(t, /radius\s+(?:of\s+)?(\d+)/) ?? (/\b(vast|huge|massive|enormous|wide|sprawling|giant)\b/.test(t) ? 2 : /\b(small|patch|pocket|tiny|little)\b/.test(t) ? 0 : 1);
  let targetTeam: Team | 'all' = 'all';
  if (z.blocks && z.visual === 'energy') {
    // A force field protects whoever raised it: it blocks the OTHER side.
    if (OUR_REF.test(t)) targetTeam = 'red';
    else if (ENEMY_REF.test(t)) targetTeam = 'blue';
  }
  const custom = extractEntityName(prompt);
  const name = custom !== 'Unknown Entity' && custom.split(' ').length <= 3 ? custom : z.name;
  return {
    category: 'zone',
    mutations: [
      {
        type: 'CREATE_ZONE',
        payload: {
          name,
          targetHex: hex,
          radius,
          durationTurns: duration,
          targetDomain: z.domain ?? 'all',
          targetTeam,
          statModifiers: mods,
          damagePerTurn: damage,
          blocksMovement: !!z.blocks,
          visual: z.visual,
        },
      },
    ],
    narrative: `${name} settles over ${how.startsWith('(') ? how : `${how} (${hex.col},${hex.row})`}.`,
  };
}

function interpretAbstract(prompt: string, t: string, a: AbstractType): UniversalResult {
  const positive = a.positive ? !/\b(fail\w*|crash\w*|down|collapse\w*|lost|loss)\b/.test(t) : POSITIVE.test(t);
  const magnitude = SEVERE.test(t) ? 2 : 1;
  const delta = positive ? magnitude : -magnitude;
  const team = detectTeam(t, 'neutral');
  const duration = findNum(t, /for\s+(\d+)\s+turns?/) ?? 3;
  const extracted = extractEntityName(prompt);
  const label = extracted !== 'Unknown Entity' ? extracted : a.label;
  return {
    category: 'rule',
    mutations: [
      {
        type: 'MODIFY_GLOBAL_RULE',
        payload: {
          ruleId: `${a.label}_${team}`.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          description: `${label}: ${a.stat} ${delta > 0 ? '+' : ''}${delta}${team === 'neutral' ? '' : ` (${team})`}`,
          targetDomain: 'all',
          targetTeam: team === 'neutral' ? 'all' : team,
          statModified: a.stat,
          delta,
          durationTurns: duration,
        },
      },
    ],
    narrative: `${a.label}: ${team === 'neutral' ? 'everyone' : `${team} force`} ${a.stat} ${delta > 0 ? '+' : ''}${delta} for ${duration} turns.`,
  };
}

// Common typos and spellings, so "laser bean from space" still means a beam.
const TYPOS: [RegExp, string][] = [
  [/\b(laser|lazer|death|energy|light|plasma|particle|ion|heat|orbital)\s+beans?\b/g, '$1 beam'],
  [/\blazers?\b/g, 'laser'],
  [/\bmiss?les?\b/g, 'missile'],
  [/\bnucul[ae]r\b/g, 'nuclear'],
  [/\blightening\b/g, 'lightning'],
  [/\bmet[eo]{1,2}rs?\b/g, 'meteor'],
  [/\bgeeses\b/g, 'geese'],
  [/\bdragoon\b/g, 'dragon'],
];
// Emoji are prompts too.
const EMOJI: [string, string][] = [
  ['🦆', ' duck '], ['🪿', ' goose '], ['🐉', ' dragon '], ['🐲', ' dragon '], ['👽', ' alien '], ['🛸', ' ufo '], ['🦈', ' shark '],
  ['🐙', ' octopus '], ['🐋', ' whale '], ['🐳', ' whale '], ['🌊', ' tsunami '], ['⚡', ' lightning '], ['☢', ' radiation '],
  ['🌫', ' fog '], ['🐝', ' bees '], ['🦅', ' eagle '], ['🤖', ' robot '], ['💣', ' bomb '], ['🔥', ' fiery '], ['💥', ' explosive '],
  ['☄', ' meteor '], ['🌋', ' volcano eruption '], ['🌪', ' tornado '], ['❄', ' blizzard '], ['🧟', ' zombies '], ['🦖', ' t-rex '],
  ['🐧', ' penguin '], ['🚀', ' rocket '], ['👻', ' ghost '], ['🍕', ' pizza party '], ['📉', ' economic collapse '], ['📡', ' radar '],
];
const normalise = (p: string) => {
  let out = p;
  for (const [e, w] of EMOJI) out = out.split(e).join(w);
  out = out.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ');
  return TYPOS.reduce((acc, [re, to]) => acc.replace(re, to), out.toLowerCase().replace(/\s+/g, ' ').trim());
};

/** Never throws. Always returns at least one mutation candidate. */
export function interpretAnything(rawPrompt: string, s: GameState): UniversalResult {
  const prompt = normalise(rawPrompt.slice(0, 500));
  const t = ` ${prompt} `;
  if (!prompt.trim()) {
    return interpretEntity('mysterious object', ' a mysterious object ', s);
  }
  const zone = ZONE_TYPES.find((z) => z.re.test(t));
  const abstract = ABSTRACT_TYPES.find((a) => a.re.test(t));
  const entityCue = AIR_WORDS.test(t) || SEA_WORDS.test(t) || LAND_WORDS.test(t);

  // The MAIN NOUN decides: "radioactive jellyfish" is a creature, "radioactive fallout" is a zone,
  // "meteor-riding goat" is a goat. Adjectives only flavour the stats.
  const head = ` ${extractEntityName(prompt).toLowerCase().split(' ').pop() ?? ''} `;
  const headIsThing = AIR_WORDS.test(head) || SEA_WORDS.test(head) || LAND_WORDS.test(head) || /\b(made of|creature|monster|elemental|golem)\b/.test(t);

  // 1. Instant action
  if (!headIsThing && (EVENT_NOUN.test(t) || (EVENT_VERB.test(t) && (findCoords(t) || ENEMY_REF.test(t) || OUR_REF.test(t)) && !entityCue))) {
    return interpretEvent(t, s);
  }
  // 2. Area phenomenon
  if (zone && !headIsThing) return interpretZone(prompt, t, s, zone);
  // 3. Abstract / societal event (unless a physical thing is the subject)
  // ("pizza party for our troops": the troops are the beneficiary, the party is the subject)
  if (abstract && (!entityCue || abstract.re.test(` ${extractEntityName(prompt).toLowerCase()} `))) {
    return interpretAbstract(prompt, t, abstract);
  }
  // 4. A thing. Everything else is a thing.
  return interpretEntity(prompt, t, s);
}

