import { useEffect, useState } from 'react';
import { Cloud, Cpu, Eye, EyeOff, HardDrive, KeyRound, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { CLAUDE_MODEL } from '../ai/claudeParser';
import { listOllamaModels, OPENAI_PRESETS, type LlmSettings, type ProviderId } from '../ai/providers';

const PROVIDERS: { id: ProviderId; label: string; icon: typeof Cpu; blurb: string }[] = [
  { id: 'local', label: 'Built-in', icon: Cpu, blurb: 'Keyword parser. Offline, instant, handles the example chips and preset mechanics.' },
  { id: 'ollama', label: 'Ollama', icon: HardDrive, blurb: 'Free model running on this PC. No key, no internet, no cost.' },
  { id: 'openai', label: 'Free API', icon: Cloud, blurb: 'Any OpenAI-compatible endpoint: OpenRouter free models, Groq free tier, LM Studio…' },
  { id: 'claude', label: 'Claude', icon: Sparkles, blurb: `Anthropic ${CLAUDE_MODEL}. Paid API key; best at inventing complex mechanics.` },
];

function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input flex-1"
        spellCheck={false}
      />
      <button onClick={() => setShow((s) => !s)} className="btn-ghost" type="button">
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-[10px] font-mono tracking-[0.2em] text-slate-500 mb-1 mt-3">{children}</label>
);

export function SettingsModal({ settings, onSave, onClose }: { settings: LlmSettings; onSave: (s: LlmSettings) => void; onClose: () => void }) {
  const [s, setS] = useState<LlmSettings>(settings);
  const set = <K extends keyof LlmSettings>(k: K, v: LlmSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  // Ollama model discovery
  const [models, setModels] = useState<string[] | null>(null);
  const [ollamaErr, setOllamaErr] = useState('');
  const [checking, setChecking] = useState(false);
  const refreshModels = async () => {
    setChecking(true);
    setOllamaErr('');
    try {
      const m = await listOllamaModels(s.ollamaUrl);
      setModels(m);
      if (m.length && !m.includes(s.ollamaModel)) set('ollamaModel', m.find((x) => x.startsWith('qwen2.5:')) ?? m[0]);
    } catch (e) {
      setModels(null);
      setOllamaErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (s.provider === 'ollama') void refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.provider]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="panel w-full max-w-xl p-5 modal-in max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <KeyRound size={18} className="text-violet-400" />
          <h2 className="font-mono text-sm tracking-[0.2em] text-slate-200">SCENARIO INJECTOR · TRANSLATOR</h2>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-200">
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => set('provider', p.id)}
              className={`flex flex-col items-center gap-1 rounded border px-2 py-2.5 text-xs font-mono transition-all ${
                s.provider === p.id ? 'border-violet-500 bg-violet-500/15 text-violet-200' : 'border-c2-border text-slate-400 hover:text-slate-200'
              }`}
            >
              <p.icon size={16} />
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mb-1">{PROVIDERS.find((p) => p.id === s.provider)!.blurb}</p>

        {s.provider === 'ollama' && (
          <div>
            <Label>OLLAMA SERVER</Label>
            <input value={s.ollamaUrl} onChange={(e) => set('ollamaUrl', e.target.value)} className="input w-full" spellCheck={false} />
            <p className="text-[10px] text-slate-600 mt-1">
              <span className="font-mono">/ollama</span> is forwarded to http://localhost:11434 by the dev server, so no CORS setup is needed.
            </p>
            <Label>MODEL</Label>
            <div className="flex gap-2">
              {models?.length ? (
                <select value={s.ollamaModel} onChange={(e) => set('ollamaModel', e.target.value)} className="input flex-1">
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={s.ollamaModel} onChange={(e) => set('ollamaModel', e.target.value)} className="input flex-1" spellCheck={false} />
              )}
              <button onClick={() => void refreshModels()} className="btn-ghost" title="Detect installed models">
                {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
            {ollamaErr ? (
              <p className="text-[11px] text-rose-300 mt-1">{ollamaErr}</p>
            ) : models ? (
              <p className="text-[11px] text-emerald-400 mt-1">Connected · {models.length} model(s) installed</p>
            ) : null}
            <p className="text-[10px] text-slate-500 mt-2">
              Recommended: <span className="font-mono">qwen2.5:7b</span> (good at JSON). Bigger models invent better mechanics but run slower.
            </p>
          </div>
        )}

        {s.provider === 'openai' && (
          <div>
            <Label>PRESET</Label>
            <div className="flex flex-wrap gap-1.5">
              {OPENAI_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setS((x) => ({ ...x, openaiUrl: p.url, openaiModel: p.model }))}
                  className={`chip ${s.openaiUrl === p.url ? 'border-violet-500 text-violet-200' : ''}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Label>BASE URL</Label>
            <input value={s.openaiUrl} onChange={(e) => set('openaiUrl', e.target.value)} className="input w-full" spellCheck={false} />
            <Label>MODEL</Label>
            <input value={s.openaiModel} onChange={(e) => set('openaiModel', e.target.value)} className="input w-full" spellCheck={false} />
            <Label>API KEY (free account key; blank for local servers)</Label>
            <SecretInput value={s.openaiKey} onChange={(v) => set('openaiKey', v)} placeholder="sk-or-... / gsk_..." />
          </div>
        )}

        {s.provider === 'claude' && (
          <div>
            <Label>ANTHROPIC API KEY</Label>
            <SecretInput value={s.claudeKey} onChange={(v) => set('claudeKey', v)} placeholder="sk-ant-..." />
          </div>
        )}

        {(s.provider === 'openai' || s.provider === 'claude') && (
          <p className="text-[10px] text-slate-500 mt-2">Keys are stored only in this browser's localStorage and sent directly to the provider.</p>
        )}

        <div className="text-[11px] text-slate-400 bg-slate-900/60 border border-c2-border rounded p-3 my-4">
          Whatever you pick, the model only fills in the game's JSON schema. Every reply is validated and clamped before it touches the game. If
          a model call fails, the built-in parser takes over automatically.
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(s);
              onClose();
            }}
            className="btn-primary"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
