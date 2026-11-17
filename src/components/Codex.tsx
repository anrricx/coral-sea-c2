import { useMemo, useState } from 'react';
import { BookOpen, Crosshair, Flame, Puzzle, Search, Trash2, X, Zap } from 'lucide-react';
import type { Domain, GameMutation, GameState, IconType, Mechanic, Team, ZoneVisual } from '../engine/types';
import { TEAM_COLOR, UnitBadge } from './UnitGlyph';

export type CodexKind = 'unit' | 'zone' | 'rule' | 'event' | 'mechanic';

export interface CodexEntry {
  id: number;
  turn: number;
  prompt: string;
  engine: string;
  kind: CodexKind;
  name: string;
  detail: string;
  team?: Team;
  domain?: Domain;
  iconType?: IconType;
  visual?: ZoneVisual;
  unitIds: string[];
  key?: string;
  time: string;
}

export const ZONE_COLOR: Record<ZoneVisual, string> = {
  fog: '#94A3B8',
  storm: '#60A5FA',
  fire: '#F97316',
  radiation: '#A3E635',
  toxic: '#84CC16',
  ice: '#BAE6FD',
  energy: '#C084FC',
  generic: '#F59E0B',
};
export const ZONE_GLYPH: Record<ZoneVisual, string> = {
  fog: '≋',
  storm: 'ϟ',
  fire: '▲',
  radiation: '☢',
  toxic: '☣',
  ice: '❄',
  energy: '◈',
  generic: '⚠',
};

/** Build Codex entries for one applied mutation. `newUnitIds` = units that appeared because of it. */
export function codexEntriesFor(m: GameMutation, newUnitIds: string[], after: GameState): Omit<CodexEntry, 'id' | 'prompt' | 'engine' | 'time'>[] {
  const turn = after.turn;
  switch (m.type) {
    case 'SPAWN_UNIT': {
      const p = m.payload;
      return [
        {
          turn,
          kind: 'unit',
          name: p.name,
          team: p.team,
          domain: p.domain,
          iconType: p.iconType,
          unitIds: newUnitIds,
          detail: `HP ${p.hp} · MOV ${p.moveRange} · ATK ${p.engagePower} (rng ${p.engageRange})${p.splashRadius ? ` · SPLASH ${p.splashRadius}` : ''} · SENSE ${p.acquirePower}/${p.acquireRange} · ${p.domain.toUpperCase()}${p.durationTurns ? ` · ${p.durationTurns}T` : ''}`,
        },
      ];
    }
    case 'CREATE_ZONE': {
      const p = m.payload;
      const fx = [
        ...p.statModifiers.map((x) => `${x.stat} ${x.delta > 0 ? '+' : ''}${x.delta}`),
        p.damagePerTurn ? `${p.damagePerTurn} dmg/turn` : '',
        p.blocksMovement ? `impassable${p.targetTeam !== 'all' ? ` to ${p.targetTeam}` : ''}` : '',
      ].filter(Boolean);
      return [
        {
          turn,
          kind: 'zone',
          name: p.name,
          visual: p.visual,
          unitIds: [],
          key: p.name,
          detail: `(${p.targetHex.col},${p.targetHex.row}) r${p.radius} · ${fx.join(' · ') || 'cosmetic'}${p.targetDomain !== 'all' ? ` · ${p.targetDomain} only` : ''} · ${p.durationTurns || '∞'}T`,
        },
      ];
    }
    case 'MODIFY_GLOBAL_RULE':
      return [
        {
          turn,
          kind: 'rule',
          name: m.payload.description.split(':')[0],
          unitIds: [],
          key: m.payload.ruleId,
          team: m.payload.targetTeam === 'all' ? undefined : m.payload.targetTeam,
          detail: `${m.payload.targetTeam === 'all' ? 'everyone' : m.payload.targetTeam} · ${m.payload.targetDomain} · ${m.payload.statModified} ${m.payload.delta > 0 ? '+' : ''}${m.payload.delta} · ${m.payload.durationTurns || '∞'}T`,
        },
      ];
    case 'TRIGGER_EVENT': {
      const p = m.payload;
      return [
        {
          turn,
          kind: 'event',
          name: p.eventName,
          unitIds: [],
          detail: `${p.damage} dmg at (${p.targetHex.col},${p.targetHex.row})${p.radius ? ` r${p.radius}` : ' (pinpoint)'}${p.terrainChange !== 'none' ? ` · terrain → ${p.terrainChange}` : ''}`,
        },
      ];
    }
    case 'DEFINE_MECHANIC':
      return [{ turn, kind: 'mechanic', name: m.payload.name, unitIds: [], key: m.payload.name, detail: m.payload.description }];
  }
}

const KIND_META: Record<CodexKind, { label: string; color: string }> = {
  unit: { label: 'ENTITY', color: '#38BDF8' },
  zone: { label: 'ZONE', color: '#F59E0B' },
  rule: { label: 'RULE', color: '#34D399' },
  event: { label: 'EVENT', color: '#FB7185' },
  mechanic: { label: 'MECHANIC', color: '#C084FC' },
};

function status(e: CodexEntry, s: GameState, library: Mechanic[]): { text: string; live: boolean } {
  switch (e.kind) {
    case 'unit': {
      const alive = e.unitIds.filter((id) => s.units.some((u) => u.id === id)).length;
      if (!e.unitIds.length) return { text: 'PREVIOUS GAME', live: false };
      return alive ? { text: e.unitIds.length > 1 ? `${alive}/${e.unitIds.length} ACTIVE` : 'ACTIVE', live: true } : { text: 'GONE', live: false };
    }
    case 'zone': {
      const z = (s.zones ?? []).find((x) => x.name === e.key);
      return z ? { text: z.turnsRemaining === null ? 'ACTIVE ∞' : `ACTIVE ${z.turnsRemaining}T`, live: true } : { text: 'DISSIPATED', live: false };
    }
    case 'rule': {
      const r = s.activeRules.find((x) => x.ruleId === e.key);
      return r ? { text: r.turnsRemaining === null ? 'ACTIVE ∞' : `ACTIVE ${r.turnsRemaining}T`, live: true } : { text: 'EXPIRED', live: false };
    }
    case 'event':
      return { text: 'RESOLVED', live: false };
    case 'mechanic': {
      const m = library.find((x) => x.name === e.key);
      return m ? { text: m.enabled ? 'IN LIBRARY · ON' : 'IN LIBRARY · OFF', live: m.enabled } : { text: 'DELETED', live: false };
    }
  }
}

function KindIcon({ e }: { e: CodexEntry }) {
  if (e.kind === 'unit' && e.iconType && e.domain && e.team) return <UnitBadge icon={e.iconType} domain={e.domain} team={e.team} size={34} />;
  const box = 'w-[34px] h-[34px] shrink-0 rounded flex items-center justify-center border';
  if (e.kind === 'zone') {
    const c = ZONE_COLOR[e.visual ?? 'generic'];
    return (
      <div className={box} style={{ borderColor: `${c}88`, background: `${c}18`, color: c }}>
        <span className="text-lg leading-none">{ZONE_GLYPH[e.visual ?? 'generic']}</span>
      </div>
    );
  }
  const I = e.kind === 'rule' ? Zap : e.kind === 'event' ? Flame : Puzzle;
  const c = KIND_META[e.kind].color;
  return (
    <div className={box} style={{ borderColor: `${c}88`, background: `${c}18`, color: c }}>
      <I size={16} />
    </div>
  );
}

interface Props {
  open: boolean;
  entries: CodexEntry[];
  state: GameState;
  library: Mechanic[];
  onClose: () => void;
  onLocate: (unitId: string) => void;
  onClear: () => void;
}

export function CodexDrawer({ open, entries, state, library, onClose, onLocate, onClear }: Props) {
  const [filter, setFilter] = useState<CodexKind | 'all'>('all');
  const [q, setQ] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entries]);
  const shown = entries
    .filter((e) => filter === 'all' || e.kind === filter)
    .filter((e) => !q || `${e.name} ${e.prompt} ${e.detail}`.toLowerCase().includes(q.toLowerCase()))
    .slice()
    .reverse();

  return (
    <>
      <div className={`fixed inset-0 z-[65] bg-black/50 transition-opacity ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={onClose} />
      <aside
        className={`fixed top-0 right-0 z-[70] h-full w-[440px] max-w-[95vw] bg-c2-panel border-l border-c2-border shadow-2xl flex flex-col transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        aria-hidden={!open}
      >
        <div className="p-4 border-b border-c2-border">
          <div className="flex items-center gap-2">
            <BookOpen size={18} className="text-amber-400" />
            <h2 className="font-mono text-sm tracking-[0.25em] text-slate-100">SANDBOX CODEX</h2>
            <span className="text-[10px] font-mono text-slate-500">{entries.length} DISCOVERIES</span>
            <button onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-200">
              <X size={16} />
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">Every weird and wonderful thing you've conjured this session, and what became of it.</p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {(['all', 'unit', 'zone', 'rule', 'event', 'mechanic'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`text-[10px] font-mono tracking-wider px-2 py-0.5 rounded border transition-colors ${
                  filter === k ? 'border-amber-400 text-amber-300 bg-amber-400/10' : 'border-c2-border text-slate-400 hover:text-slate-200'
                }`}
              >
                {k === 'all' ? 'ALL' : KIND_META[k].label} {counts[k] ?? 0}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 bg-black/40 border border-c2-border rounded px-2 py-1">
            <Search size={12} className="text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search codex…" className="flex-1 bg-transparent outline-none text-xs font-mono text-slate-200" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {shown.length === 0 && (
            <div className="text-center text-slate-500 text-xs mt-10 px-6 leading-relaxed">
              Nothing here yet. Type <span className="font-mono text-amber-300">angry geese</span>,{' '}
              <span className="font-mono text-amber-300">heavy fog</span> or{' '}
              <span className="font-mono text-amber-300">a laser beam from space</span> into the command bar.
            </div>
          )}
          {shown.map((e) => {
            const st = status(e, state, library);
            const meta = KIND_META[e.kind];
            const liveUnit = e.kind === 'unit' ? e.unitIds.find((id) => state.units.some((u) => u.id === id)) : undefined;
            return (
              <div key={e.id} className={`badge-in rounded border p-2.5 ${st.live ? 'border-c2-border bg-slate-900/40' : 'border-c2-border/60 bg-transparent opacity-70'}`}>
                <div className="flex items-start gap-2.5">
                  <KindIcon e={e} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-slate-100 truncate">{e.name}</span>
                      {e.team && e.kind === 'unit' && (
                        <span className="text-[9px] font-mono" style={{ color: TEAM_COLOR[e.team] }}>
                          {e.team.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[9px] font-mono px-1 rounded" style={{ color: meta.color, background: `${meta.color}1a` }}>
                        {meta.label}
                      </span>
                      <span className={`text-[9px] font-mono ${st.live ? 'text-emerald-400' : 'text-slate-500'}`}>● {st.text}</span>
                    </div>
                    <p className="text-[11px] font-mono text-slate-300 mt-1 leading-snug break-words">{e.detail}</p>
                    <p className="text-[11px] text-slate-500 italic mt-1 line-clamp-2">"{e.prompt}"</p>
                    <div className="flex items-center gap-2 mt-1 text-[9.5px] font-mono text-slate-600">
                      <span>T{String(e.turn).padStart(2, '0')}</span>
                      <span>·</span>
                      <span className="truncate">{e.engine}</span>
                      <span>·</span>
                      <span>{e.time}</span>
                      {liveUnit && (
                        <button onClick={() => onLocate(liveUnit)} className="ml-auto flex items-center gap-1 text-cyan-400 hover:text-cyan-300">
                          <Crosshair size={11} /> locate
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-3 border-t border-c2-border flex items-center">
          <span className="text-[10px] font-mono text-slate-600">Session log · clears when you close the tab</span>
          {entries.length > 0 &&
            (confirmClear ? (
              <span className="ml-auto flex items-center gap-2 text-[11px] font-mono">
                <button onClick={() => (onClear(), setConfirmClear(false))} className="text-rose-400 hover:text-rose-300">
                  clear all
                </button>
                <button onClick={() => setConfirmClear(false)} className="text-slate-400 hover:text-slate-200">
                  keep
                </button>
              </span>
            ) : (
              <button onClick={() => setConfirmClear(true)} className="ml-auto btn-ghost">
                <Trash2 size={12} /> Clear
              </button>
            ))}
        </div>
      </aside>
    </>
  );
}
