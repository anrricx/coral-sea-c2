import { AlertTriangle, CheckCircle2, Info, RotateCcw, Trophy, X } from 'lucide-react';
import type { GameState } from '../engine/types';

// ── Toasts ───────────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  kind: 'error' | 'success' | 'info';
  title: string;
  body?: string;
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 w-[360px] pointer-events-none">
      {toasts.map((t) => {
        const I = t.kind === 'error' ? AlertTriangle : t.kind === 'success' ? CheckCircle2 : Info;
        const color = t.kind === 'error' ? 'border-c2-red/60 text-rose-300' : t.kind === 'success' ? 'border-emerald-500/50 text-emerald-300' : 'border-cyan-500/50 text-cyan-300';
        return (
          <div key={t.id} className={`toast-in pointer-events-auto panel border-l-4 ${color} p-3 shadow-2xl`}>
            <div className="flex items-start gap-2">
              <I size={16} className="shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs font-bold tracking-wide">{t.title}</div>
                {t.body && <div className="text-[11px] text-slate-400 mt-0.5 font-mono break-words">{t.body}</div>}
              </div>
              <button onClick={() => onDismiss(t.id)} className="text-slate-500 hover:text-slate-200">
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Victory ──────────────────────────────────────────────────────────────────

export function VictoryOverlay({ state, onRestart, onDismiss }: { state: GameState; onRestart: () => void; onDismiss: () => void }) {
  if (!state.winner) return null;
  const blue = state.winner === 'blue';
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className={`panel p-6 text-center modal-in border-2 ${blue ? 'border-c2-blue/60' : 'border-c2-red/60'}`}>
        <Trophy size={36} className={`mx-auto mb-2 ${blue ? 'text-c2-blue' : 'text-c2-red'}`} />
        <div className={`font-mono text-2xl font-bold tracking-[0.3em] ${blue ? 'text-c2-blue' : 'text-c2-red'}`}>
          {blue ? 'BLUE VICTORY' : 'RED VICTORY'}
        </div>
        <p className="text-slate-300 mt-2 mb-4">{state.winReason}</p>
        <div className="flex gap-2 justify-center">
          <button onClick={onDismiss} className="btn-ghost">
            Review board
          </button>
          <button onClick={onRestart} className="btn-primary">
            <RotateCcw size={14} /> New engagement
          </button>
        </div>
      </div>
    </div>
  );
}
