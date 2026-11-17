import { useRef, useState } from 'react';
import { Braces, Cpu, KeyRound, Loader2, Sparkles, Terminal } from 'lucide-react';

export const EXAMPLE_PROMPTS = [
  'Add a fuel system: aircraft carry 3 fuel and crash when they run out',
  'New mechanic: ships next to a friendly port repair 2 HP each turn',
  'Our ships can teleport once per game',
  'Add limited ammo: each unit has 2 missiles',
  'China deploys bat bombs at (6,4) that fly over any terrain and deal 3 splash damage',
  'Monsoon storm reduces all sea movement by 2',
  'Allied submarine at (4,4)',
  'Enemy jamming reduces our radar acquisition by 1 for 2 turns',
  'Tsunami at (3,5) radius 1 with 3 damage floods the coast',
  'Deploy 2 UCAV drones at (3,1) for 4 turns',
  'Typhoon cell at (5,1)',
];

export interface InjectionPreview {
  /** Who translated it, e.g. "OLLAMA · qwen2.5:7b" or "LOCAL". */
  source: string;
  ai: boolean;
  narrative: string;
  json: unknown[];
  warnings: string[];
}

interface Props {
  busy: boolean;
  providerLabel: string;
  aiProvider: boolean;
  onSubmit: (prompt: string) => void;
  onOpenSettings: () => void;
  preview: InjectionPreview | null;
}

export function CommandBar({ busy, providerLabel, aiProvider, onSubmit, onOpenSettings, preview }: Props) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [showJson, setShowJson] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const submit = (p = value) => {
    const prompt = p.trim();
    if (!prompt || busy) return;
    onSubmit(prompt);
    setHistory((h) => [prompt, ...h.filter((x) => x !== prompt)].slice(0, 30));
    setHIdx(-1);
    setValue('');
  };

  return (
    <div className="panel px-3 pt-2 pb-3 border-t-2 border-t-cyan-500/30 shadow-[0_-8px_30px_-12px_rgba(56,189,248,0.35)]">
      {preview && (
        <div className="mb-2 flex items-start gap-2 text-[11px] font-mono">
          <span className={`shrink-0 px-1.5 rounded ${preview.ai ? 'bg-violet-500/20 text-violet-300' : 'bg-slate-700/60 text-slate-300'}`}>
            {preview.source}
          </span>
          <span className="text-slate-400 flex-1 truncate" title={preview.narrative}>
            {preview.narrative}
            {preview.warnings.length > 0 && <span className="text-amber-400"> · ⚠ {preview.warnings.join('; ')}</span>}
          </span>
          <button onClick={() => setShowJson((s) => !s)} className="shrink-0 flex items-center gap-1 text-cyan-400 hover:text-cyan-300">
            <Braces size={12} /> {showJson ? 'hide' : 'JSON'}
          </button>
        </div>
      )}
      {preview && showJson && (
        <pre className="mb-2 max-h-40 overflow-auto text-[10px] bg-black/50 border border-c2-border rounded p-2 text-cyan-300">
          {JSON.stringify(preview.json, null, 2)}
        </pre>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={`flex items-center gap-2 rounded-md border bg-black/50 px-3 py-2 transition-all ${
          busy ? 'border-violet-500/60 shadow-[0_0_20px_-4px_rgba(139,92,246,0.6)]' : 'border-cyan-500/40 focus-within:border-cyan-400 focus-within:shadow-[0_0_20px_-6px_rgba(56,189,248,0.8)]'
        }`}
      >
        <Terminal size={16} className="text-cyan-400 shrink-0" />
        <span className="font-mono text-cyan-400 text-sm shrink-0">&gt;_</span>
        <input
          ref={input}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = Math.min(history.length - 1, hIdx + 1);
              setHIdx(i);
              setValue(history[i]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const i = hIdx - 1;
              setHIdx(Math.max(-1, i));
              setValue(i >= 0 ? history[i] : '');
            }
          }}
          placeholder={busy ? 'TRANSLATING ORDER… (local models can take 10–30 s)' : 'INJECT SCENARIO / SPAWN ENTITY...'}
          className="flex-1 bg-transparent outline-none font-mono text-sm text-slate-100 placeholder:text-slate-600 tracking-wide"
          spellCheck={false}
          id="command-input"
        />
        <button
          type="button"
          onClick={onOpenSettings}
          className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono border transition-colors ${
            aiProvider ? 'border-violet-500/50 text-violet-300 bg-violet-500/10' : 'border-c2-border text-slate-400 hover:text-slate-200'
          }`}
          title="Parser settings / Claude API key"
        >
          {aiProvider ? <Sparkles size={12} /> : <Cpu size={12} />}
          <span className="max-w-[180px] truncate">{providerLabel}</span>
          <KeyRound size={11} className="opacity-60" />
        </button>
        <button type="submit" disabled={busy || !value.trim()} className="btn-primary shrink-0">
          {busy ? <Loader2 size={14} className="animate-spin" /> : 'EXECUTE'}
        </button>
      </form>

      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-thin">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            disabled={busy}
            onClick={() => {
              setValue(p);
              input.current?.focus();
            }}
            className="chip shrink-0"
            title="Click to load, then Enter"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
