import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ChevronRight,
  Crosshair,
  Footprints,
  Hourglass,
  Radar,
  ScrollText,
  Shield,
  Swords,
  X,
  Zap,
} from 'lucide-react';
import { CONFIRM_THRESHOLD, effective, isConfirmed, needsAcquisition, rulesAffecting, tileAt } from '../engine/engine';
import { resourceDefsFor } from '../engine/mechanics';
import type { ActiveRule, GameState, HexCoord, LogEntry, ModifiableStat, Phase, Unit } from '../engine/types';
import { PHASES } from '../engine/types';
import { TEAM_COLOR, UnitBadge } from './UnitGlyph';

const PHASE_META: Record<Phase, { icon: typeof Footprints; label: string; hint: string }> = {
  MOVE: { icon: Footprints, label: 'MOVE', hint: 'Select a unit, then a pulsing hex.' },
  ACQUIRE: { icon: Radar, label: 'ACQUIRE', hint: 'Sensors paint enemy air/stealth. 3 pts = CONFIRMED.' },
  ENGAGE: { icon: Crosshair, label: 'ENGAGE', hint: 'Fire on surface targets or CONFIRMED air.' },
  END_TURN: { icon: Hourglass, label: 'END TURN', hint: 'Red Force acts, durations tick.' },
};

// ── Phase tracker ────────────────────────────────────────────────────────────

export function PhaseTracker({
  state,
  aiRunning,
  onAdvance,
  pendingActions,
}: {
  state: GameState;
  aiRunning: boolean;
  onAdvance: () => void;
  pendingActions: number;
}) {
  const teamColor = TEAM_COLOR[state.activeTeam];
  const label = state.activeTeam === 'blue' ? 'BLUE FORCE' : state.activeTeam === 'red' ? 'RED FORCE' : 'ENVIRONMENT';
  const nextLabel = state.phase === 'ENGAGE' ? 'END TURN' : state.phase === 'END_TURN' ? 'RESOLVING' : 'NEXT PHASE';
  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] tracking-[0.2em] text-slate-500 font-mono">TURN</div>
        <div className="font-mono text-xs" style={{ color: teamColor }}>
          <span className="inline-block w-2 h-2 rounded-full mr-1.5 animate-pulse" style={{ background: teamColor }} />
          {label}
        </div>
      </div>
      <div className="flex items-baseline gap-1 font-mono mb-3">
        <span className="text-3xl font-bold text-slate-100">{String(state.turn).padStart(2, '0')}</span>
        <span className="text-slate-500 text-sm">/ {state.maxTurns}</span>
      </div>
      <div className="grid grid-cols-4 gap-1 mb-3">
        {PHASES.map((p, i) => {
          const M = PHASE_META[p];
          const active = state.phase === p;
          const done = PHASES.indexOf(state.phase) > i;
          return (
            <div
              key={p}
              className={`flex flex-col items-center gap-1 rounded border px-1 py-1.5 transition-all duration-300 ${
                active ? 'border-current bg-current/10 shadow-[0_0_12px_-2px_currentColor]' : 'border-c2-border'
              }`}
              style={{ color: active ? teamColor : done ? '#475569' : '#64748B' }}
            >
              <M.icon size={14} />
              <span className="text-[9px] font-mono tracking-wider">{M.label}</span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-400 mb-3 min-h-[2.2em]">{PHASE_META[state.phase].hint}</p>
      <button
        onClick={onAdvance}
        disabled={aiRunning || state.activeTeam !== 'blue' || !!state.winner}
        className="w-full btn-primary justify-center"
      >
        {aiRunning ? <Activity size={14} className="animate-spin" /> : <ChevronRight size={14} />}
        {aiRunning ? 'RED FORCE OPERATING…' : nextLabel}
        {!aiRunning && pendingActions > 0 && state.activeTeam === 'blue' && (
          <span className="ml-auto text-[10px] text-slate-400">{pendingActions} ready</span>
        )}
      </button>
      <p className="text-[10px] text-slate-600 mt-1.5 font-mono text-center">SPACE = advance · ESC = deselect</p>
    </div>
  );
}

// ── Active modifiers bar ─────────────────────────────────────────────────────

export function ModifierBar({ rules, onRemove }: { rules: ActiveRule[]; onRemove: (id: string) => void }) {
  if (!rules.length) {
    return <div className="text-[11px] font-mono text-slate-600">NO ACTIVE MODIFIERS</div>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {rules.map((r) => {
        const neg = r.delta < 0;
        return (
          <div
            key={r.id}
            className={`badge-in group flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-mono ${
              neg ? 'border-c2-red/40 text-rose-300 bg-c2-red/10' : 'border-c2-green/40 text-emerald-300 bg-c2-green/10'
            }`}
            title={r.description}
          >
            <Zap size={11} />
            <span className="max-w-[220px] truncate">{r.description}</span>
            <span className="text-slate-400">
              [{r.targetTeam !== 'all' ? `${r.targetTeam} ` : ''}
              {r.targetDomain} {statShort(r.statModified)} {neg ? '' : '+'}
              {r.delta}]
            </span>
            <span className="text-amber-400">{r.turnsRemaining === null ? '∞' : `${r.turnsRemaining}T`}</span>
            <button onClick={() => onRemove(r.id)} className="opacity-40 hover:opacity-100" title="Remove modifier">
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const statShort = (s: ModifiableStat) => (s === 'moveRange' ? 'MOV' : s === 'engagePower' ? 'ENG' : 'ACQ');

// ── Unit inspector ───────────────────────────────────────────────────────────

function StatRow({ label, base, eff, mods }: { label: string; base: number; eff?: number; mods?: ActiveRule[] }) {
  const changed = eff !== undefined && eff !== base;
  return (
    <div className="flex items-center justify-between py-0.5 font-mono text-xs" title={mods?.map((m) => m.description).join('\n')}>
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200">
        {changed ? (
          <>
            <span className="line-through text-slate-600 mr-1">{base}</span>
            <span className={eff! > base ? 'text-emerald-400' : 'text-rose-400'}>{eff}</span>
          </>
        ) : (
          base
        )}
      </span>
    </div>
  );
}

export function Inspector({ state, unit, hoverHex }: { state: GameState; unit: Unit | undefined; hoverHex: HexCoord | null }) {
  const tile = hoverHex ? tileAt(state, hoverHex) : undefined;
  if (!unit) {
    return (
      <div className="panel p-3">
        <PanelTitle icon={Shield} title="UNIT INSPECTOR" />
        <p className="text-xs text-slate-500">Select a unit on the map or roster.</p>
        {tile && <TileInfo state={state} hex={hoverHex!} />}
      </div>
    );
  }
  const c = TEAM_COLOR[unit.team];
  const hpFrac = unit.hp / unit.maxHp;
  return (
    <div className="panel p-3">
      <PanelTitle icon={Shield} title="UNIT INSPECTOR" />
      <div className="flex items-center gap-3 mb-2">
        <UnitBadge icon={unit.iconType} domain={unit.domain} team={unit.team} size={40} />
        <div className="min-w-0">
          <div className="font-semibold text-sm text-slate-100 truncate">{unit.name}</div>
          <div className="text-[10px] font-mono tracking-wider" style={{ color: c }}>
            {unit.team.toUpperCase()} · {unit.domain.toUpperCase()} · ({unit.pos.col},{unit.pos.row})
            {unit.isHVT && <span className="text-amber-400"> · ★ HVT</span>}
          </div>
        </div>
      </div>
      <div className="mb-2">
        <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-0.5">
          <span>INTEGRITY</span>
          <span>
            {unit.hp}/{unit.maxHp} HP
          </span>
        </div>
        <div className="h-1.5 bg-slate-900 rounded overflow-hidden">
          <div className="h-full transition-all duration-500" style={{ width: `${hpFrac * 100}%`, background: hpFrac > 0.5 ? c : hpFrac > 0.25 ? '#F59E0B' : '#F43F5E' }} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 border-t border-c2-border pt-1.5">
        <StatRow label="MOVE" base={unit.moveRange} eff={effective(state, unit, 'moveRange')} mods={rulesAffecting(state, unit, 'moveRange')} />
        <StatRow label="SPLASH" base={unit.splashRadius} />
        <StatRow label="ACQ RNG" base={unit.acquireRange} eff={effective(state, unit, 'acquireRange')} />
        <StatRow label="ACQ PWR" base={unit.acquirePower} eff={effective(state, unit, 'acquirePower')} mods={rulesAffecting(state, unit, 'acquirePower')} />
        <StatRow label="ENG RNG" base={unit.engageRange} eff={effective(state, unit, 'engageRange')} />
        <StatRow label="ENG PWR" base={unit.engagePower} eff={effective(state, unit, 'engagePower')} mods={rulesAffecting(state, unit, 'engagePower')} />
      </div>
      {resourceDefsFor(state, unit).map((d) => {
        const v = unit.resources?.[d.key] ?? 0;
        return (
          <div key={d.key} className="mt-1.5">
            <div className="flex justify-between text-[10px] font-mono text-violet-300 mb-0.5">
              <span>{d.label.toUpperCase()}</span>
              <span>
                {v}/{d.max}
              </span>
            </div>
            <div className="flex gap-0.5">
              {Array.from({ length: Math.min(d.max, 12) }, (_, i) => (
                <div key={i} className={`h-1.5 flex-1 rounded-sm ${i < v ? 'bg-violet-400' : 'bg-slate-800'}`} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1 mt-2">
        {needsAcquisition(unit) && (
          <Tag color={isConfirmed(unit) ? '#F59E0B' : '#64748B'}>
            TRACK {unit.acquirePoints}/{CONFIRM_THRESHOLD}
            {isConfirmed(unit) ? ' CONFIRMED' : ''}
          </Tag>
        )}
        {unit.stealth && <Tag color="#A78BFA">STEALTH</Tag>}
        <Tag color="#64748B">HITS: {unit.engageDomains.join('/').toUpperCase()}</Tag>
        {unit.durationTurns !== null && <Tag color="#F59E0B">EXPIRES {unit.durationTurns}T</Tag>}
        {unit.spawnedBy && <Tag color="#22D3EE">INJECTED · {unit.spawnedBy.toUpperCase()}</Tag>}
        {unit.team === state.activeTeam && (
          <>
            <Tag color={unit.hasMoved ? '#334155' : '#34D399'}>MOV</Tag>
            <Tag color={unit.hasAcquired ? '#334155' : '#34D399'}>ACQ</Tag>
            <Tag color={unit.hasEngaged ? '#334155' : '#34D399'}>ENG</Tag>
          </>
        )}
      </div>
    </div>
  );
}

function TileInfo({ state, hex }: { state: GameState; hex: HexCoord }) {
  const t = tileAt(state, hex);
  if (!t) return null;
  return (
    <div className="mt-2 border-t border-c2-border pt-2 font-mono text-[11px] text-slate-400">
      HEX ({t.col},{t.row}) · {t.terrain.toUpperCase()}
      {t.name && (
        <div style={{ color: TEAM_COLOR[t.owner ?? 'neutral'] }}>
          {t.name} — {t.cityHp}/{t.cityMaxHp} integrity
        </div>
      )}
    </div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="text-[9px] font-mono tracking-wider px-1.5 py-0.5 rounded border" style={{ color, borderColor: `${color}55`, background: `${color}12` }}>
      {children}
    </span>
  );
}

export function PanelTitle({ icon: I, title, right }: { icon: typeof Shield; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-[10px] tracking-[0.2em] font-mono text-slate-500">
      <I size={12} />
      {title}
      <div className="ml-auto">{right}</div>
    </div>
  );
}

// ── Roster ───────────────────────────────────────────────────────────────────

export function Roster({ state, selectedId, onSelect }: { state: GameState; selectedId: string | null; onSelect: (id: string) => void }) {
  const groups: [string, Unit[]][] = [
    ['BLUE FORCE', state.units.filter((u) => u.team === 'blue')],
    ['RED FORCE', state.units.filter((u) => u.team === 'red')],
    ['ENVIRONMENT', state.units.filter((u) => u.team === 'neutral')],
  ];
  return (
    <div className="panel p-3 flex-1 min-h-0 overflow-y-auto">
      <PanelTitle icon={Swords} title="ORDER OF BATTLE" />
      {groups
        .filter(([, us]) => us.length)
        .map(([label, us]) => (
          <div key={label} className="mb-2">
            <div className="text-[9px] font-mono tracking-[0.2em] mb-1" style={{ color: TEAM_COLOR[us[0].team] }}>
              {label} · {us.length}
            </div>
            {us.map((u) => (
              <button
                key={u.id}
                onClick={() => onSelect(u.id)}
                className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-left transition-colors ${
                  selectedId === u.id ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
                }`}
              >
                <UnitBadge icon={u.iconType} domain={u.domain} team={u.team} size={22} />
                <span className="text-xs text-slate-300 truncate flex-1">{u.name}</span>
                <span className="text-[10px] font-mono text-slate-500">
                  {u.hp}/{u.maxHp}
                </span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

// ── Event log ────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<LogEntry['kind'], string> = {
  move: '#64748B',
  acquire: '#F59E0B',
  engage: '#FB7185',
  destroyed: '#F43F5E',
  mutation: '#22D3EE',
  system: '#94A3B8',
  hazard: '#F59E0B',
  mechanic: '#C084FC',
};

export function EventLog({ log }: { log: LogEntry[] }) {
  const end = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log.length]);
  return (
    <div className="panel p-3 flex-1 min-h-0 flex flex-col">
      <PanelTitle icon={ScrollText} title="REPLAY LOG" right={<span>{log.length}</span>} />
      <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5 pr-1 font-mono text-[11px]">
        {log.map((e) => (
          <div key={e.id} className="log-in">
            <div
              className={`flex gap-1.5 leading-snug ${e.mutation ? 'cursor-pointer hover:bg-slate-800/40 rounded' : ''}`}
              onClick={() => e.mutation && setOpen(open === e.id ? null : e.id)}
            >
              <span className="text-slate-600 shrink-0">T{String(e.turn).padStart(2, '0')}</span>
              <span
                className="w-1 shrink-0 rounded-sm mt-0.5 mb-0.5"
                style={{ background: e.team === 'system' ? KIND_COLOR[e.kind] : TEAM_COLOR[e.team] }}
              />
              <span style={{ color: e.kind === 'move' ? '#94A3B8' : KIND_COLOR[e.kind] }}>
                {e.text}
                {e.source && <span className="text-slate-600"> [{e.source}]</span>}
              </span>
            </div>
            {open === e.id && e.mutation && (
              <pre className="text-[10px] bg-black/40 border border-c2-border rounded p-2 my-1 text-cyan-300 overflow-x-auto">
                {JSON.stringify(e.mutation, null, 2)}
              </pre>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
