import type { Domain, IconType, Team } from '../engine/types';

export const TEAM_COLOR: Record<Team, string> = {
  blue: '#38BDF8',
  red: '#F43F5E',
  neutral: '#F59E0B',
};

/**
 * NATO-inspired frame by domain (air = dome, sea = circle, land = rectangle)
 * with a silhouette glyph inside. Drawn in a 40×40 box centred on (0,0).
 */
export function UnitFrame({ domain, team, filled = 0.14 }: { domain: Domain; team: Team; filled?: number }) {
  const c = TEAM_COLOR[team];
  const common = { fill: c, fillOpacity: filled, stroke: c, strokeWidth: 2 };
  if (domain === 'air') return <path d="M -17 12 L -17 2 A 17 17 0 0 1 17 2 L 17 12 Z" {...common} />;
  if (domain === 'sea') return <circle r={16} {...common} />;
  return <rect x={-18} y={-12} width={36} height={24} rx={2} {...common} />;
}

export function Glyph({ icon, color }: { icon: IconType; color: string }) {
  const s = { stroke: color, strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const f = { fill: color };
  switch (icon) {
    case 'fighter':
      return <path d="M0 -10 L2 -3 L10 2 L10 4 L2 2 L1.5 7 L4 9 L4 10 L0 9 L-4 10 L-4 9 L-1.5 7 L-2 2 L-10 4 L-10 2 L-2 -3 Z" {...f} />;
    case 'bomber':
      return <path d="M0 -9 L1.5 -3 L12 3 L12 5 L1.5 2 L1 7 L4 9 L-4 9 L-1 7 L-1.5 2 L-12 5 L-12 3 L-1.5 -3 Z" {...f} />;
    case 'aew':
      return (
        <g>
          <path d="M0 -10 L1.5 -3 L10 1 L10 3 L1.5 1 L1 7 L3.5 9 L-3.5 9 L-1 7 L-1.5 1 L-10 3 L-10 1 L-1.5 -3 Z" {...f} />
          <ellipse cx={0} cy={2} rx={6} ry={2.2} {...s} fill="#090D16" />
        </g>
      );
    case 'drone':
      return <path d="M0 -6 L9 4 L4 3 L0 7 L-4 3 L-9 4 Z" {...f} />;
    case 'helicopter':
      return (
        <g>
          <line x1={-11} y1={-5} x2={11} y2={-5} {...s} />
          <ellipse cx={-1} cy={1} rx={5} ry={3.5} {...f} />
          <line x1={3} y1={1} x2={11} y2={0} {...s} />
        </g>
      );
    case 'destroyer':
      return <path d="M-12 2 L12 2 L9 6 L-10 6 Z M-6 2 L-6 -2 L-1 -2 L-1 -6 L2 -6 L2 -2 L6 -2 L6 2" {...f} />;
    case 'carrier':
      return <path d="M-13 1 L13 -1 L11 5 L-11 5 Z M4 -1 L4 -6 L8 -6 L8 -1" {...f} />;
    case 'amphib':
      return (
        <g>
          <path d="M-12 1 L12 1 L10 6 L-10 6 Z M-8 1 L-8 -4 L4 -4 L4 1" {...f} />
          <path d="M-4 -7 L0 -10 L4 -7" {...s} />
        </g>
      );
    case 'submarine':
      return <path d="M-12 3 Q-12 -1 -6 -1 L8 -1 Q12 -1 12 3 Q12 6 8 6 L-6 6 Q-12 6 -12 3 Z M-1 -1 L-1 -6 L3 -6 L3 -1" {...f} />;
    case 'missile_battery':
      return (
        <g>
          <path d="M-9 6 L9 6 L9 2 L-9 2 Z" {...f} />
          <path d="M-6 2 L4 -8 M-2 2 L8 -8" {...s} strokeWidth={2.4} />
        </g>
      );
    case 'radar':
      return (
        <g>
          <path d="M-7 -4 A 9 9 0 0 0 7 -4" {...s} />
          <line x1={0} y1={0} x2={0} y2={7} {...s} />
          <line x1={-5} y1={7} x2={5} y2={7} {...s} />
        </g>
      );
    case 'infantry':
      return <path d="M-14 -8 L14 8 M14 -8 L-14 8" {...s} />;
    case 'armor':
      return <rect x={-10} y={-5} width={20} height={10} rx={5} {...s} />;
    case 'swarm':
      return (
        <g {...f}>
          {[
            [-7, -3], [0, -6], [7, -3], [-4, 4], [4, 4],
          ].map(([x, y], i) => (
            <path key={i} d={`M${x} ${y} l3 -2 l0 3 l-3 -1 l-3 1 l0 -3 z`} />
          ))}
        </g>
      );
    case 'hazard':
      return (
        <g>
          <path d="M0 -9 L9 7 L-9 7 Z" {...s} />
          <line x1={0} y1={-3} x2={0} y2={2} {...s} />
          <circle cx={0} cy={4.6} r={0.9} {...f} />
        </g>
      );
    default:
      return <text textAnchor="middle" dy={5} fontSize={14} fontFamily="monospace" fill={color}>?</text>;
  }
}

/** Small standalone badge used in panels/lists. */
export function UnitBadge({ icon, domain, team, size = 28 }: { icon: IconType; domain: Domain; team: Team; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-20 -20 40 40" className="shrink-0">
      <UnitFrame domain={domain} team={team} />
      <g transform="scale(0.75)">
        <Glyph icon={icon} color={TEAM_COLOR[team]} />
      </g>
    </svg>
  );
}
