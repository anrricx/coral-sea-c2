import { useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Puzzle, Sparkles, Trash2 } from 'lucide-react';
import { describeMechanic } from '../engine/mechanics';
import type { Mechanic } from '../engine/types';
import { PanelTitle } from './Panels';

interface Props {
  library: Mechanic[];
  inMatch: Set<string>;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

export function MechanicsPanel({ library, inMatch, onToggle, onDelete }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <div className="panel p-3 max-h-[45%] min-h-0 flex flex-col">
      <PanelTitle icon={Puzzle} title="MECHANICS LIBRARY" right={<span className="text-violet-300">{library.filter((m) => m.enabled).length} ON</span>} />
      {library.length === 0 ? (
        <p className="text-[11px] text-slate-500 leading-relaxed">
          No custom mechanics yet. Describe a lasting rule in the command bar, e.g.{' '}
          <span className="font-mono text-violet-300">"add a fuel system for aircraft"</span>. It's saved here and loads in every new game.
        </p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1">
          {library.map((m) => {
            const expanded = open === m.id;
            return (
              <div key={m.id} className={`badge-in rounded border ${m.enabled ? 'border-violet-500/40 bg-violet-500/5' : 'border-c2-border opacity-60'}`}>
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <button onClick={() => setOpen(expanded ? null : m.id)} className="text-slate-500 hover:text-slate-200" title="Show rules">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  {m.source !== 'local' && m.source !== 'import' ? <Sparkles size={11} className="text-violet-400 shrink-0" /> : <Cpu size={11} className="text-slate-500 shrink-0" />}
                  <span className="text-xs text-slate-200 font-semibold truncate flex-1" title={m.description}>
                    {m.name}
                  </span>
                  {m.enabled && inMatch.has(m.id) && <span className="text-[9px] font-mono text-emerald-400">LIVE</span>}
                  <label className="relative inline-flex items-center cursor-pointer" title={m.enabled ? 'Disable' : 'Enable'}>
                    <input type="checkbox" className="sr-only peer" checked={m.enabled} onChange={(e) => onToggle(m.id, e.target.checked)} />
                    <span className="w-7 h-4 rounded-full bg-slate-700 peer-checked:bg-violet-500/70 transition-colors" />
                    <span className="absolute left-0.5 top-0.5 w-3 h-3 rounded-full bg-slate-200 transition-transform peer-checked:translate-x-3" />
                  </label>
                  {confirmDelete === m.id ? (
                    <span className="flex items-center gap-1 text-[10px] font-mono">
                      <button onClick={() => (onDelete(m.id), setConfirmDelete(null))} className="text-rose-400 hover:text-rose-300">
                        delete
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="text-slate-500 hover:text-slate-300">
                        keep
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmDelete(m.id)} className="text-slate-600 hover:text-rose-400" title="Delete from library">
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="px-2 pb-2 text-[10.5px] leading-relaxed">
                    <p className="text-slate-400 mb-1">{m.description}</p>
                    <ul className="font-mono text-violet-200/90 space-y-0.5">
                      {describeMechanic(m).map((l, i) => (
                        <li key={i} className="break-words">
                          ▸ {l}
                        </li>
                      ))}
                    </ul>
                    {m.prompt && <p className="text-slate-600 mt-1 italic truncate">"{m.prompt}"</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
