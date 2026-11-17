// Zones: area-of-effect hazards anchored to hexes. Pure helpers (no engine imports).
import { hexDistance } from './hex';
import type { GameState, HexCoord, StatKey, Unit, Zone } from './types';

export const MAX_ZONES = 12;

export const inZone = (z: Zone, h: HexCoord) => hexDistance(h, z.center) <= z.radius;

/** Does this zone affect this kind of unit (ignoring position)? */
export const zoneTargets = (z: Zone, u: Unit) =>
  (z.targetDomain === 'all' || z.targetDomain === u.domain) && (z.targetTeam === 'all' || z.targetTeam === u.team);

export const zonesAffecting = (s: GameState, u: Unit): Zone[] =>
  (s.zones ?? []).filter((z) => zoneTargets(z, u) && inZone(z, u.pos));

export function zoneDelta(s: GameState, u: Unit, stat: StatKey): number {
  let d = 0;
  for (const z of zonesAffecting(s, u)) for (const m of z.statModifiers) if (m.stat === stat) d += m.delta;
  return d;
}

/** A blocking zone stops units it targets from entering; units already inside may move out. */
export function zoneBlocksEntry(s: GameState, u: Unit, h: HexCoord): boolean {
  return (s.zones ?? []).some((z) => z.blocksMovement && zoneTargets(z, u) && inZone(z, h) && !inZone(z, u.pos));
}

/** Damage a unit would take at end of turn from zones at hex `h`. */
export function zoneDamageAt(s: GameState, u: Unit, h: HexCoord): number {
  return (s.zones ?? []).filter((z) => zoneTargets(z, u) && inZone(z, h)).reduce((a, z) => a + z.damagePerTurn, 0);
}
