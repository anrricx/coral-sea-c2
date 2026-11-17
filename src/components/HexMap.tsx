import { memo } from 'react';
import { HEX_H, HEX_SIZE, hexCorners, hexDistance, hexToPixel, key, mapPixelSize } from '../engine/hex';
import { ZONE_COLOR, ZONE_GLYPH } from './Codex';
import { isConfirmed, needsAcquisition, CONFIRM_THRESHOLD } from '../engine/engine';
import type { Fx, GameState, HexCoord, HexTile, Unit } from '../engine/types';
import { Glyph, TEAM_COLOR, UnitFrame } from './UnitGlyph';
import { resourceDefsFor } from '../engine/mechanics';

export interface FxInstance extends Fx {
  id: number;
}

export interface Highlights {
  move: Set<string>;
  range: Set<string>;
  acquireUnits: Set<string>;
  engageUnits: Set<string>;
  engageCities: Set<string>;
  hazardPreview: Set<string>;
}

interface Props {
  state: GameState;
  selectedId: string | null;
  actorId: string | null;
  highlights: Highlights;
  fx: FxInstance[];
  idleUnitIds: Set<string>;
  onHexClick: (h: HexCoord) => void;
  onHexHover: (h: HexCoord | null) => void;
}

const TERRAIN_FILL: Record<HexTile['terrain'], string> = {
  sea: '#0A1424',
  coast: '#18241C',
  land: '#1A2117',
  city: '#1B2030',
};

function TileView({ t }: { t: HexTile }) {
  const { x, y } = hexToPixel(t);
  return (
    <g>
      <polygon
        points={hexCorners(x, y, HEX_SIZE - 0.5)}
        fill={TERRAIN_FILL[t.terrain]}
        stroke={t.terrain === 'coast' ? '#2C3E2E' : '#1E293B'}
        strokeWidth={1.2}
      />
      {t.terrain === 'sea' && (
        <path
          d={`M${x - 14} ${y + 10} q 4 -3 8 0 t 8 0 M${x - 2} ${y + 16} q 4 -3 8 0 t 8 0`}
          stroke="#13243B"
          strokeWidth={1}
          fill="none"
        />
      )}
      {(t.terrain === 'land' || t.terrain === 'coast') && (
        <path d={`M${x - 10} ${y + 14} l5 -7 l4 5 l3 -3 l6 5`} stroke="#2A3A26" strokeWidth={1.2} fill="none" />
      )}
      <text x={x} y={y - HEX_H / 2 + 11} textAnchor="middle" className="fill-slate-600 font-mono" fontSize={8}>
        {t.col},{t.row}
      </text>
      {t.terrain === 'city' && <CityMarker t={t} x={x} y={y} />}
    </g>
  );
}

function CityMarker({ t, x, y }: { t: HexTile; x: number; y: number }) {
  const c = TEAM_COLOR[t.owner ?? 'neutral'];
  const frac = (t.cityHp ?? 0) / (t.cityMaxHp ?? 1);
  const dead = (t.cityHp ?? 0) <= 0;
  return (
    <g opacity={dead ? 0.4 : 1}>
      <polygon points={hexCorners(x, y, HEX_SIZE - 4)} fill="none" stroke={c} strokeOpacity={0.5} strokeDasharray="3 3" />
      <path
        d={`M${x - 11} ${y + 6} v-8 h5 v-5 h5 v9 h4 v-12 h5 v16 z`}
        fill={c}
        fillOpacity={0.25}
        stroke={c}
        strokeWidth={1}
      />
      <text x={x} y={y + 17} textAnchor="middle" fontSize={7.5} className="font-mono" fill={c}>
        {t.name?.toUpperCase()}
      </text>
      <rect x={x - 14} y={y + 20} width={28} height={3} fill="#0F172A" />
      <rect x={x - 14} y={y + 20} width={28 * frac} height={3} fill={c} />
      <text x={x + 14} y={y - 8} fontSize={7} className="font-mono" fill="#F59E0B">
        ★HVT
      </text>
    </g>
  );
}

function UnitCounter({ u, selected, actor, idle, res }: { u: Unit; selected: boolean; actor: boolean; idle: boolean; res: string }) {
  const { x, y } = hexToPixel(u.pos);
  const c = TEAM_COLOR[u.team];
  const hpFrac = u.hp / u.maxHp;
  const showTrack = needsAcquisition(u) && u.team !== 'blue';
  const showTrackBlue = needsAcquisition(u) && u.team === 'blue' && u.acquirePoints > 0;
  return (
    <g className="unit-move" style={{ transform: `translate(${x}px, ${y}px)` }}>
      <g className="unit-spawn">
        {(selected || actor) && (
          <circle r={27} fill="none" stroke={actor ? '#F43F5E' : c} strokeWidth={1.5} strokeDasharray="4 3" className="spin-slow" />
        )}
        <g style={{ filter: `drop-shadow(0 0 ${selected ? 7 : 4}px ${c})` }} opacity={idle ? 0.5 : 1}>
          <UnitFrame domain={u.domain} team={u.team} filled={selected ? 0.3 : 0.14} />
          <g transform="scale(0.85)">
            <Glyph icon={u.iconType} color={c} />
          </g>
        </g>
        {u.isHVT && (
          <text x={13} y={-14} fontSize={9} fill="#F59E0B">
            ★
          </text>
        )}
        {/* HP bar */}
        <rect x={-15} y={19} width={30} height={3.5} rx={1} fill="#0F172A" stroke="#1E293B" strokeWidth={0.5} />
        <rect
          x={-15}
          y={19}
          width={30 * hpFrac}
          height={3.5}
          rx={1}
          fill={hpFrac > 0.5 ? c : hpFrac > 0.25 ? '#F59E0B' : '#F43F5E'}
          style={{ transition: 'width 400ms ease' }}
        />
        {res && (
          <text y={31} textAnchor="middle" fontSize={7} className="font-mono" fill="#C4B5FD">
            {res}
          </text>
        )}
        {/* Acquisition pips for air/stealth units */}
        {(showTrack || showTrackBlue) && (
          <g transform="translate(-9,-23)">
            {Array.from({ length: CONFIRM_THRESHOLD }, (_, i) => (
              <path
                key={i}
                d={`M${i * 9} 0 l3 -3 l3 3 l-3 3 z`}
                fill={i < u.acquirePoints ? '#F59E0B' : '#0F172A'}
                stroke="#F59E0B"
                strokeWidth={0.8}
              />
            ))}
          </g>
        )}
        {isConfirmed(u) && (
          <text y={-28} textAnchor="middle" fontSize={7} className="font-mono confirm-blink" fill="#F59E0B">
            CONFIRMED
          </text>
        )}
        {u.durationTurns !== null && (
          <g transform="translate(-21,-14)">
            <circle r={6} fill="#090D16" stroke="#F59E0B" strokeWidth={0.8} />
            <text textAnchor="middle" dy={2.6} fontSize={7} className="font-mono" fill="#F59E0B">
              {u.durationTurns}
            </text>
          </g>
        )}
      </g>
    </g>
  );
}

function FxView({ f }: { f: FxInstance }) {
  const { x, y } = hexToPixel(f.at);
  const c = f.team ? TEAM_COLOR[f.team] : '#F59E0B';
  switch (f.kind) {
    case 'damage':
      return (
        <text x={x} y={y - 8} textAnchor="middle" className="fx-float font-mono" fontSize={15} fontWeight={700} fill="#FB7185" stroke="#090D16" strokeWidth={3} paintOrder="stroke">
          -{f.amount} HP
        </text>
      );
    case 'heal':
      return (
        <text x={x} y={y - 8} textAnchor="middle" className="fx-float font-mono" fontSize={14} fontWeight={700} fill="#34D399" stroke="#090D16" strokeWidth={3} paintOrder="stroke">
          +{f.amount} HP
        </text>
      );
    case 'explosion': {
      const r = 18 + (f.radius ?? 0) * HEX_H;
      return (
        <g transform={`translate(${x},${y})`}>
          <circle r={r} className="fx-blast" fill="#F97316" />
          <circle r={r * 0.6} className="fx-blast-core" fill="#FDE68A" />
          <circle r={r} className="fx-ring" fill="none" stroke="#FB923C" strokeWidth={2} />
        </g>
      );
    }
    case 'destroyed':
      return (
        <g transform={`translate(${x},${y})`}>
          <circle r={30} className="fx-ring" fill="none" stroke="#F43F5E" strokeWidth={3} />
          <path d="M-14 -14 L14 14 M14 -14 L-14 14" stroke="#F43F5E" strokeWidth={3} className="fx-fade" />
        </g>
      );
    case 'ping':
      return (
        <g transform={`translate(${x},${y})`}>
          <circle r={34} className="fx-ping" fill="none" stroke={c} strokeWidth={2} />
          <circle r={34} className="fx-ping fx-delay" fill="none" stroke={c} strokeWidth={1.5} />
          {f.amount ? (
            <text y={-32} textAnchor="middle" className="fx-float font-mono" fontSize={10} fill="#F59E0B">
              TRACK CONFIRMED
            </text>
          ) : null}
        </g>
      );
    case 'spawn':
      return (
        <g transform={`translate(${x},${y})`}>
          <circle r={30} className="fx-spawn" fill={c} fillOpacity={0.15} stroke={c} strokeWidth={2} />
          <rect x={-2} y={-400} width={4} height={400} fill={c} className="fx-beam" />
        </g>
      );
    case 'hazard': {
      const r = HEX_SIZE + (f.radius ?? 1) * HEX_H;
      return (
        <g transform={`translate(${x},${y})`}>
          <circle r={r} className="fx-blast" fill="#F59E0B" />
          <circle r={r} className="fx-ring" fill="none" stroke="#F59E0B" strokeWidth={3} />
        </g>
      );
    }
  }
}

function HexMapImpl({ state, selectedId, actorId, highlights, fx, idleUnitIds, onHexClick, onHexHover }: Props) {
  const { width, height } = mapPixelSize(state.map.cols, state.map.rows);
  const pad = 16;
  const sel = state.units.find((u) => u.id === selectedId);
  const selColor = sel ? TEAM_COLOR[sel.team] : '#38BDF8';

  return (
    <svg
      viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`}
      className="w-full h-full select-none"
      preserveAspectRatio="xMidYMid meet"
      onMouseLeave={() => onHexHover(null)}
    >
      <defs>
        <pattern id="grid" width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M 12 0 L 0 0 0 12" fill="none" stroke="#111C2E" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect x={-pad} y={-pad} width={width + pad * 2} height={height + pad * 2} fill="url(#grid)" />

      {state.map.tiles.map((t) => (
        <TileView key={key(t)} t={t} />
      ))}

      {/* Zones: area hazards */}
      {(state.zones ?? []).map((z) => {
        const c = ZONE_COLOR[z.visual];
        const { x: cx, y: cy } = hexToPixel(z.center);
        const hexes = state.map.tiles.filter((t) => hexDistance(t, z.center) <= z.radius);
        return (
          <g key={z.id} pointerEvents="none" className="zone-in">
            {hexes.map((t) => {
              const { x, y } = hexToPixel(t);
              return (
                <polygon
                  key={key(t)}
                  points={hexCorners(x, y, HEX_SIZE - 1)}
                  fill={c}
                  fillOpacity={0.16}
                  stroke={c}
                  strokeOpacity={0.55}
                  strokeWidth={z.blocksMovement ? 2.2 : 1.2}
                  strokeDasharray={z.blocksMovement ? undefined : '5 4'}
                  className="zone-pulse"
                />
              );
            })}
            <text x={cx} y={cy - HEX_H / 2 + 22} textAnchor="middle" fontSize={15} fill={c} opacity={0.85}>
              {ZONE_GLYPH[z.visual]}
            </text>
            <text x={cx} y={cy + HEX_H / 2 - 4} textAnchor="middle" fontSize={7.5} className="font-mono" fill={c} stroke="#090D16" strokeWidth={2.5} paintOrder="stroke">
              {z.name.toUpperCase().slice(0, 18)} {z.turnsRemaining === null ? '∞' : `${z.turnsRemaining}T`}
            </text>
          </g>
        );
      })}

      {/* Range shading */}
      {state.map.tiles
        .filter((t) => highlights.range.has(key(t)))
        .map((t) => {
          const { x, y } = hexToPixel(t);
          return <polygon key={`r${key(t)}`} points={hexCorners(x, y, HEX_SIZE - 2)} fill={selColor} fillOpacity={0.06} stroke={selColor} strokeOpacity={0.25} strokeDasharray="2 4" pointerEvents="none" />;
        })}

      {/* Valid move destinations */}
      {state.map.tiles
        .filter((t) => highlights.move.has(key(t)))
        .map((t) => {
          const { x, y } = hexToPixel(t);
          return <polygon key={`m${key(t)}`} points={hexCorners(x, y, HEX_SIZE - 3)} className="hex-pulse" fill={selColor} stroke={selColor} strokeWidth={1.5} pointerEvents="none" />;
        })}

      {/* Engageable cities */}
      {state.map.tiles
        .filter((t) => highlights.engageCities.has(key(t)))
        .map((t) => {
          const { x, y } = hexToPixel(t);
          return <polygon key={`c${key(t)}`} points={hexCorners(x, y, HEX_SIZE - 3)} className="hex-pulse-red" fill="#F43F5E" stroke="#F43F5E" strokeWidth={2} pointerEvents="none" />;
        })}

      {/* Event preview */}
      {state.map.tiles
        .filter((t) => highlights.hazardPreview.has(key(t)))
        .map((t) => {
          const { x, y } = hexToPixel(t);
          return <polygon key={`h${key(t)}`} points={hexCorners(x, y, HEX_SIZE - 3)} fill="#F59E0B" fillOpacity={0.12} stroke="#F59E0B" strokeDasharray="3 3" pointerEvents="none" />;
        })}

      {/* Units */}
      {state.units.map((u) => (
        <UnitCounter
          key={u.id}
          u={u}
          selected={u.id === selectedId}
          actor={u.id === actorId}
          idle={idleUnitIds.has(u.id)}
          res={resourceDefsFor(state, u)
            .slice(0, 2)
            .map((d) => `${d.label.slice(0, 4).toUpperCase()} ${u.resources?.[d.key] ?? 0}`)
            .join(' · ')}
        />
      ))}

      {/* Target reticles */}
      {state.units
        .filter((u) => highlights.engageUnits.has(u.id) || highlights.acquireUnits.has(u.id))
        .map((u) => {
          const { x, y } = hexToPixel(u.pos);
          const engage = highlights.engageUnits.has(u.id);
          const c = engage ? '#F43F5E' : '#F59E0B';
          return (
            <g key={`t${u.id}`} transform={`translate(${x},${y})`} pointerEvents="none">
              <circle r={25} fill="none" stroke={c} strokeWidth={2} className="reticle-pulse" />
              <path d="M0 -31 v8 M0 31 v-8 M-31 0 h8 M31 0 h-8" stroke={c} strokeWidth={2} />
            </g>
          );
        })}

      {/* FX */}
      <g pointerEvents="none">
        {fx.map((f) => (
          <FxView key={f.id} f={f} />
        ))}
      </g>

      {/* Click targets (top layer) */}
      {state.map.tiles.map((t) => {
        const { x, y } = hexToPixel(t);
        return (
          <polygon
            key={`hit${key(t)}`}
            points={hexCorners(x, y, HEX_SIZE)}
            fill="transparent"
            className="cursor-pointer hover:fill-white/5"
            onClick={() => onHexClick(t)}
            onMouseEnter={() => onHexHover(t)}
          />
        );
      })}
    </svg>
  );
}

export const HexMap = memo(HexMapImpl);
