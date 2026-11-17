import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Download, FolderOpen, Layers, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { interpretOffline } from './ai/interpret';
import { CodexDrawer, codexEntriesFor, type CodexEntry } from './components/Codex';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DEFAULT_SETTINGS, providerLabel, providerReady, translatePrompt, type LlmSettings } from './ai/providers';
import { sfx } from './audio/sfx';
import { CommandBar, type InjectionPreview } from './components/CommandBar';
import { HexMap, type FxInstance, type Highlights } from './components/HexMap';
import { Toasts, VictoryOverlay, type Toast } from './components/Overlays';
import { SettingsModal } from './components/SettingsModal';
import { EventLog, Inspector, ModifierBar, PhaseTracker, Roster } from './components/Panels';
import { MechanicsPanel } from './components/MechanicsPanel';
import { syncResources } from './engine/mechanics';
import { planRedTurn } from './engine/ai';
import {
  acquire,
  acquireTargets,
  advancePhase,
  applyMutation,
  canActNow,
  clone,
  effective,
  engage,
  engageTargets,
  EngineError,
  getUnit,
  log,
  mechanicId,
  moveUnit,
  reachableHexes,
  unitAt,
} from './engine/engine';
import { hexesWithin, key } from './engine/hex';
import { createInitialState } from './engine/scenario';
import type { EngineResult, Fx, GameMutation, GameState, HexCoord, Mechanic, MutationSource } from './engine/types';
import { checkInvariants, validateImportedState, validateMechanicList, validateMutation } from './engine/validate';

// ── Small localStorage helpers (may throw in private mode) ──
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

/** Translator settings; migrates the older Claude-only keys. */
function loadLlmSettings(): LlmSettings {
  try {
    const saved = JSON.parse(store.get('c2.llm') ?? 'null') as Partial<LlmSettings> | null;
    if (saved) return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    /* fall through */
  }
  const oldKey = store.get('c2.apiKey') ?? '';
  return { ...DEFAULT_SETTINGS, claudeKey: oldKey, provider: oldKey && store.get('c2.useClaude') === '1' ? 'claude' : 'local' };
}

/** The player's permanent mechanic library, persisted in this browser. */
function loadLibrary(): Mechanic[] {
  try {
    return validateMechanicList(JSON.parse(store.get('c2.mechanics') ?? '[]'), 'local');
  } catch {
    return [];
  }
}

const EMPTY_HL: Highlights = {
  move: new Set(),
  range: new Set(),
  acquireUnits: new Set(),
  engageUnits: new Set(),
  engageCities: new Set(),
  hazardPreview: new Set(),
};

export default function App() {
  const [library, setLibrary] = useState<Mechanic[]>(loadLibrary);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [state, setState] = useState<GameState>(() => createInitialState(libraryRef.current));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverHex, setHoverHex] = useState<HexCoord | null>(null);
  const [fx, setFx] = useState<FxInstance[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aiRunning, setAiRunning] = useState(false);
  const [actorId, setActorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<InjectionPreview | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llm, setLlm] = useState<LlmSettings>(loadLlmSettings);
  const [muted, setMuted] = useState(() => store.get('c2.muted') === '1');
  const [victoryDismissed, setVictoryDismissed] = useState(false);
  const [codex, setCodex] = useState<CodexEntry[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('c2.codex') ?? '[]') as CodexEntry[];
    } catch {
      return [];
    }
  });
  const [codexOpen, setCodexOpen] = useState(false);
  const prevStateRef = useRef<GameState | null>(null);

  const fxId = useRef(1);
  const aiTimers = useRef<number[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    store.set('c2.mechanics', JSON.stringify(library));
  }, [library]);

  useEffect(() => {
    try {
      sessionStorage.setItem('c2.codex', JSON.stringify(codex.slice(-200)));
    } catch {
      /* private mode etc. */
    }
  }, [codex]);

  useEffect(() => {
    sfx.muted = muted;
    store.set('c2.muted', muted ? '1' : '');
  }, [muted]);

  // ── Feedback helpers ──
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = fxId.current++;
    setToasts((ts) => [...ts.slice(-1), { ...t, id }]); // at most 2 on screen
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === 'error' ? 6000 : 3800);
  }, []);

  const playFx = useCallback((list: Fx[]) => {
    if (!list.length) return;
    const stamped = list.map((f) => ({ ...f, id: fxId.current++ }));
    setFx((cur) => [...cur, ...stamped]);
    window.setTimeout(() => setFx((cur) => cur.filter((f) => !stamped.some((s) => s.id === f.id))), 1600);
    const kinds = new Set(list.map((f) => f.kind));
    if (kinds.has('explosion')) sfx.play('boom');
    if (kinds.has('destroyed')) window.setTimeout(() => sfx.play('boom'), 220);
    if (kinds.has('hazard')) sfx.play('hazard');
    if (kinds.has('spawn')) sfx.play('spawn');
    if (kinds.has('ping')) sfx.play(list.some((f) => f.kind === 'ping' && f.amount) ? 'confirm' : 'ping');
  }, []);

  /** Run an engine action; surface rule violations as a terminal toast. */
  const run = useCallback(
    (fn: () => EngineResult): boolean => {
      try {
        const r = fn();
        setState(r.state);
        playFx(r.fx);
        return true;
      } catch (e) {
        if (e instanceof EngineError) {
          sfx.play('error');
          toast({ kind: 'error', title: 'ORDER REJECTED', body: e.message });
          return false;
        }
        throw e;
      }
    },
    [playFx, toast],
  );

  // ── Victory sound ──
  const prevWinner = useRef<string | null>(null);
  useEffect(() => {
    if (state.winner && prevWinner.current !== state.winner) sfx.play(state.winner === 'blue' ? 'victory' : 'defeat');
    prevWinner.current = state.winner;
    if (!state.winner) setVictoryDismissed(false);
  }, [state.winner]);

  // ── Derived UI data ──
  const selected = selectedId ? getUnit(state, selectedId) : undefined;
  const blueTurn = state.activeTeam === 'blue' && !aiRunning && !state.winner;

  const highlights = useMemo<Highlights>(() => {
    if (!selected) return EMPTY_HL;
    const { cols, rows } = state.map;
    const hl: Highlights = {
      move: new Set(),
      range: new Set(),
      acquireUnits: new Set(),
      engageUnits: new Set(),
      engageCities: new Set(),
      hazardPreview: new Set(),
    };
    const mine = blueTurn && selected.team === 'blue';
    if (!mine) {
      // Enemy / hazard selected: show its weapon envelope.
      const r = effective(state, selected, 'engageRange');
      if (r > 0) hexesWithin(selected.pos, r, cols, rows).forEach((h) => hl.range.add(key(h)));
      return hl;
    }
    if (state.phase === 'MOVE' && !selected.hasMoved) {
      hl.move = new Set(reachableHexes(state, selected).keys());
    } else if (state.phase === 'ACQUIRE' && !selected.hasAcquired) {
      hexesWithin(selected.pos, effective(state, selected, 'acquireRange'), cols, rows).forEach((h) => hl.range.add(key(h)));
      acquireTargets(state, selected).forEach((t) => hl.acquireUnits.add(t.id));
    } else if (state.phase === 'ENGAGE' && !selected.hasEngaged) {
      hexesWithin(selected.pos, effective(state, selected, 'engageRange'), cols, rows).forEach((h) => hl.range.add(key(h)));
      const t = engageTargets(state, selected);
      t.units.forEach((u) => hl.engageUnits.add(u.id));
      t.cities.forEach((c) => hl.engageCities.add(key(c)));
    }
    return hl;
  }, [state, selected, blueTurn]);

  const readyIds = useMemo(
    () => new Set(blueTurn ? state.units.filter((u) => canActNow(state, u)).map((u) => u.id) : []),
    [state, blueTurn],
  );
  const idleUnitIds = useMemo(
    () => new Set(blueTurn && state.phase !== 'END_TURN' ? state.units.filter((u) => u.team === 'blue' && !readyIds.has(u.id)).map((u) => u.id) : []),
    [state, blueTurn, readyIds],
  );

  // ── Red AI turn playback ──
  const cancelAi = () => {
    aiTimers.current.forEach((t) => window.clearTimeout(t));
    aiTimers.current = [];
    setAiRunning(false);
    setActorId(null);
  };

  const runRedTurn = useCallback(
    (from: GameState) => {
      const steps = planRedTurn(from);
      setAiRunning(true);
      setSelectedId(null);
      let t = 350;
      steps.forEach((step, i) => {
        const delay = t;
        aiTimers.current.push(
          window.setTimeout(() => {
            setState(step.state);
            setActorId(step.actorId ?? null);
            playFx(step.fx);
            if (step.actorId && step.phase === 'MOVE') sfx.play('move');
            if (!step.actorId) sfx.play('phase');
            if (i === steps.length - 1) {
              setAiRunning(false);
              setActorId(null);
              aiTimers.current = [];
            }
          }, delay),
        );
        t += step.actorId ? (step.phase === 'MOVE' ? 520 : 750) : 420;
      });
    },
    [playFx],
  );

  const advance = useCallback(() => {
    const s = stateRef.current;
    if (aiRunning || s.activeTeam !== 'blue' || s.winner) return;
    sfx.play('phase');
    setSelectedId(null);
    const next = advancePhase(s);
    setState(next);
    if (next.phase === 'END_TURN') runRedTurn(next);
  }, [aiRunning, runRedTurn]);

  // ── Map interaction ──
  const onHexClick = useCallback(
    (h: HexCoord) => {
      const s = stateRef.current;
      if (aiRunning || s.winner) return;
      const clicked = unitAt(s, h);
      const sel = selectedId ? getUnit(s, selectedId) : undefined;
      const k = key(h);

      if (sel && sel.team === 'blue' && s.activeTeam === 'blue') {
        if (s.phase === 'MOVE' && highlights.move.has(k)) {
          if (run(() => moveUnit(s, sel.id, h))) sfx.play('move');
          return;
        }
        if (s.phase === 'ACQUIRE' && clicked && highlights.acquireUnits.has(clicked.id)) {
          run(() => acquire(s, sel.id, clicked.id));
          return;
        }
        if (s.phase === 'ENGAGE') {
          if (clicked && highlights.engageUnits.has(clicked.id)) {
            run(() => engage(s, sel.id, { unitId: clicked.id }));
            return;
          }
          if (highlights.engageCities.has(k)) {
            run(() => engage(s, sel.id, { hex: h }));
            return;
          }
        }
      }
      if (clicked) {
        setSelectedId(clicked.id === selectedId ? null : clicked.id);
        sfx.play('select');
      } else {
        setSelectedId(null);
        sfx.play('click');
      }
    },
    [aiRunning, selectedId, highlights, run],
  );

  // ── Scenario injection ──
  const applyRawMutations = useCallback(
    (base: GameState, raws: unknown[], source: MutationSource, prompt?: string) => {
      let s = base;
      const allFx: Fx[] = [];
      const applied: GameMutation[] = [];
      const warnings: string[] = [];
      const errors: string[] = [];
      const codexParts: Omit<CodexEntry, 'id' | 'prompt' | 'engine' | 'time'>[] = [];
      for (const raw of raws.slice(0, 8)) {
        // Safety wrapper: nothing a model (or a weird prompt) returns may crash the game.
        try {
          const v = validateMutation(raw, s);
          if (!v.ok) {
            errors.push(v.error);
            continue;
          }
          const r = applyMutation(s, v.mutation, { source, prompt });
          const broken = checkInvariants(r.state);
          if (broken) {
            errors.push(`Rolled back: ${broken}`);
            continue;
          }
          warnings.push(...v.warnings);
          const before = new Set(s.units.map((u) => u.id));
          codexParts.push(...codexEntriesFor(v.mutation, r.state.units.filter((u) => !before.has(u.id)).map((u) => u.id), r.state));
          s = r.state;
          allFx.push(...r.fx);
          applied.push(v.mutation);
        } catch (e) {
          console.error('Mutation contained:', e, raw);
          errors.push(`Contained an engine error: ${(e as Error).message}`);
        }
      }
      return { state: s, fx: allFx, applied, warnings, errors, codexParts };
    },
    [],
  );

  const inject = useCallback(
    async (prompt: string) => {
      setBusy(true);
      sfx.play('click');
      let raws: unknown[] = [];
      let narrative = '';
      let source: MutationSource = 'local';
      let engine = 'LOCAL';
      let ai = false;
      try {
        if (llm.provider !== 'local' && providerReady(llm)) {
          try {
            const r = await translatePrompt(llm, prompt, stateRef.current);
            raws = r.mutations;
            narrative = r.narrative;
            source = llm.provider === 'openai' ? 'api' : llm.provider === 'ollama' ? 'ollama' : 'claude';
            engine = providerLabel(llm);
            ai = true;
          } catch (e) {
            toast({ kind: 'error', title: 'MODEL LINK FAILED — LOCAL FALLBACK', body: (e as Error).message });
          }
        }
        if (!ai) {
          const r = interpretOffline(prompt, stateRef.current);
          raws = r.mutations;
          narrative = r.narrative;
          engine = r.via === 'keyword' ? 'LOCAL · KEYWORD' : 'LOCAL · UNIVERSAL';
        }
      } catch (e) {
        sfx.play('error');
        toast({ kind: 'error', title: 'INJECTION REJECTED', body: (e as Error).message });
        setBusy(false);
        return;
      }

      const current = stateRef.current;
      let res = applyRawMutations(current, raws, source, prompt);
      // A model produced nothing usable? The universal interpreter always can.
      if (!res.applied.length && ai) {
        const off = interpretOffline(prompt, current);
        const retry = applyRawMutations(current, off.mutations, 'local', prompt);
        if (retry.applied.length) {
          toast({ kind: 'info', title: 'MODEL OUTPUT UNUSABLE — UNIVERSAL FALLBACK', body: res.errors.join(' ') || 'Empty reply.' });
          res = retry;
          raws = off.mutations;
          narrative = off.narrative;
          engine = 'LOCAL · UNIVERSAL';
          ai = false;
        }
      }
      setPreview({ source: engine, ai, narrative, json: res.applied.length ? res.applied : raws, warnings: res.warnings });
      if (!res.applied.length) {
        sfx.play('error');
        toast({ kind: 'error', title: 'INJECTION REJECTED', body: res.errors.join(' ') || 'No valid mutations produced.' });
      } else {
        prevStateRef.current = current;
        setState(res.state);
        playFx(res.fx);
        const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setCodex((c) => [
          ...c,
          ...res.codexParts.map((part, i) => ({ ...part, id: Date.now() + i, prompt, engine, time: stamp })),
        ]);
        const definedIds = res.applied.flatMap((a) => (a.type === 'DEFINE_MECHANIC' ? [mechanicId(a.payload.name)] : []));
        const defined = res.state.mechanics.filter((m) => definedIds.includes(m.id));
        if (defined.length) {
          setLibrary((lib) => [...lib.filter((x) => !definedIds.includes(x.id)), ...defined]);
          sfx.play('confirm');
        }
        toast({
          kind: 'success',
          title: `INJECTED ${res.applied.length} MUTATION${res.applied.length > 1 ? 'S' : ''}`,
          body: [narrative, ...res.errors.map((e) => `Skipped: ${e}`)].filter(Boolean).join(' '),
        });
        if (res.state.activeRules.length !== current.activeRules.length && !res.fx.length) sfx.play('confirm');
      }
      setBusy(false);
    },
    [llm, toast, applyRawMutations, playFx],
  );

  // ── Save / Load ──
  const exportScenario = () => {
    const s = stateRef.current;
    const payload = {
      format: 'coral-sea-c2-scenario',
      exportedAt: new Date().toISOString(),
      scenarioDeck: s.scenarioDeck,
      state: s,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coral-sea-scenario-T${String(s.turn).padStart(2, '0')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    sfx.play('confirm');
    toast({ kind: 'success', title: 'SCENARIO EXPORTED', body: `${s.scenarioDeck.length} injected mutation(s), ${s.eventLog.length} log entries.` });
  };

  const importScenario = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as Record<string, unknown>;
      cancelAi();
      setSelectedId(null);
      if (data.state) {
        const v = validateImportedState(data);
        if (!v.ok) throw new Error(v.error);
        setState(v.state);
        const imported = v.state.mechanics;
        if (imported.length) setLibrary((lib) => [...lib.filter((x) => !imported.some((m) => m.id === x.id)), ...imported]);
        toast({
          kind: 'success',
          title: 'SCENARIO LOADED',
          body: `Turn ${v.state.turn}, ${v.state.units.length} units${imported.length ? `, ${imported.length} mechanic(s) added to library` : ''}.`,
        });
      } else if (Array.isArray(data.scenarioDeck)) {
        replayDeck(data.scenarioDeck as GameState['scenarioDeck']);
      } else {
        throw new Error('File has neither "state" nor "scenarioDeck".');
      }
      sfx.play('spawn');
    } catch (e) {
      sfx.play('error');
      toast({ kind: 'error', title: 'IMPORT FAILED', body: (e as Error).message });
    }
  };

  const replayDeck = (deck: GameState['scenarioDeck']) => {
    let s = createInitialState(libraryRef.current);
    const fxAll: Fx[] = [];
    let n = 0;
    for (const entry of deck) {
      const r = applyRawMutations(s, [entry.mutation], 'import', entry.prompt);
      s = r.state;
      fxAll.push(...r.fx);
      n += r.applied.length;
    }
    s = clone(s);
    log(s, { team: 'system', kind: 'system', text: `Scenario deck replayed onto a fresh map: ${n}/${deck.length} mutations applied.` });
    setState(s);
    playFx(fxAll);
    toast({ kind: 'success', title: 'DECK REPLAYED', body: `${n} mutation(s) re-injected on a fresh engagement.` });
  };

  const restart = () => {
    cancelAi();
    setSelectedId(null);
    setPreview(null);
    setState(createInitialState(libraryRef.current));
    sfx.play('phase');
  };

  // ── Mechanics library ──
  const toggleMechanic = (id: string, enabled: boolean) => {
    const lib = libraryRef.current.map((m) => (m.id === id ? { ...m, enabled } : m));
    setLibrary(lib);
    const mech = lib.find((m) => m.id === id);
    if (!mech) return;
    const s = clone(stateRef.current);
    const inMatch = s.mechanics.find((m) => m.id === id);
    if (inMatch) inMatch.enabled = enabled;
    else if (enabled) s.mechanics.push(structuredClone(mech));
    syncResources(s);
    log(s, { team: 'system', kind: 'mechanic', text: `Mechanic ${enabled ? 'ENABLED' : 'disabled'}: ${mech.name}` });
    setState(s);
    sfx.play(enabled ? 'confirm' : 'click');
  };

  const deleteMechanic = (id: string) => {
    const mech = libraryRef.current.find((m) => m.id === id);
    setLibrary((lib) => lib.filter((m) => m.id !== id));
    const s = clone(stateRef.current);
    s.mechanics = s.mechanics.filter((m) => m.id !== id);
    if (mech) log(s, { team: 'system', kind: 'mechanic', text: `Mechanic deleted: ${mech.name}` });
    setState(s);
    sfx.play('click');
  };

  // ── Keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === 'Escape') {
        setSelectedId(null);
        (document.activeElement as HTMLElement)?.blur?.();
      }
      if (typing) return;
      if (e.key === ' ') {
        e.preventDefault();
        advance();
      } else if (e.key === '/') {
        e.preventDefault();
        document.getElementById('command-input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance]);

  const hoverUnit = hoverHex ? unitAt(state, hoverHex) : undefined;

  return (
    <div className="h-screen flex flex-col bg-c2-bg text-slate-200 overflow-hidden scanlines">
      {/* ── Header ── */}
      <header className="shrink-0 border-b border-c2-border bg-c2-panel/80 backdrop-blur px-4 py-2">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-c2-blue animate-pulse shadow-[0_0_8px_#38BDF8]" />
            <span className="font-mono font-bold tracking-[0.25em] text-sm text-slate-100">CORAL SEA 2042</span>
            <span className="font-mono text-[10px] tracking-[0.2em] text-slate-500 hidden md:inline">// C2 TERMINAL · {state.scenarioName.toUpperCase()}</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={exportScenario} className="btn-ghost" title="Save / export scenario JSON">
              <Download size={14} /> <span className="hidden lg:inline">EXPORT</span>
            </button>
            <button onClick={() => fileInput.current?.click()} className="btn-ghost" title="Load scenario JSON">
              <FolderOpen size={14} /> <span className="hidden lg:inline">IMPORT</span>
            </button>
            <button
              onClick={() => {
                cancelAi();
                replayDeck(stateRef.current.scenarioDeck);
              }}
              disabled={!state.scenarioDeck.length}
              className="btn-ghost"
              title="Restart with all injected mutations re-applied"
            >
              <Layers size={14} /> <span className="hidden lg:inline">REPLAY DECK ({state.scenarioDeck.length})</span>
            </button>
            <button onClick={() => setCodexOpen(true)} className="btn-ghost text-amber-300" title="Sandbox Codex: everything you've spawned">
              <BookOpen size={14} /> <span className="hidden lg:inline">CODEX ({codex.length})</span>
            </button>
            <button onClick={restart} className="btn-ghost" title="New engagement">
              <RotateCcw size={14} />
            </button>
            <button onClick={() => setMuted((m) => !m)} className="btn-ghost" title={muted ? 'Unmute' : 'Mute'}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importScenario(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-[0.2em] text-slate-500 shrink-0">ACTIVE MODIFIERS</span>
          {state.mechanics
            .filter((m) => m.enabled)
            .map((m) => (
              <span
                key={m.id}
                title={m.description}
                className="badge-in shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] font-mono text-violet-300"
              >
                ⚙ {m.name}
              </span>
            ))}
          <ModifierBar
            rules={state.activeRules}
            onRemove={(id) => {
              const s = clone(stateRef.current);
              const r = s.activeRules.find((x) => x.id === id);
              s.activeRules = s.activeRules.filter((x) => x.id !== id);
              if (r) log(s, { team: 'system', kind: 'system', text: `Modifier revoked: ${r.description}` });
              setState(s);
              sfx.play('click');
            }}
          />
        </div>
      </header>

      {/* ── Main ── */}
      <main className="flex-1 min-h-0 grid grid-cols-[270px_1fr_320px] gap-3 p-3">
        <aside className="flex flex-col gap-3 min-h-0">
          <PhaseTracker state={state} aiRunning={aiRunning} onAdvance={advance} pendingActions={readyIds.size} />
          <Inspector state={state} unit={selected ?? hoverUnit} hoverHex={hoverHex} />
          <Roster
            state={state}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id === selectedId ? null : id);
              sfx.play('select');
            }}
          />
        </aside>

        <section className="relative panel min-h-0 overflow-hidden map-vignette">
          <div className="absolute top-2 left-3 z-10 font-mono text-[10px] tracking-[0.2em] text-slate-500 pointer-events-none">
            TACTICAL PLOT · {state.map.cols}×{state.map.rows} · {hoverHex ? `HEX (${hoverHex.col},${hoverHex.row})` : '—'}
          </div>
          <div className="absolute top-2 right-3 z-10 flex gap-3 font-mono text-[10px] pointer-events-none">
            <span className="text-c2-blue">● BLUE</span>
            <span className="text-c2-red">● RED</span>
            <span className="text-c2-amber">● HAZARD</span>
          </div>
          <div className="absolute inset-0 p-4 pt-7">
            <ErrorBoundary
              onUndo={() => prevStateRef.current && setState(prevStateRef.current)}
              onReset={() => setState(createInitialState(libraryRef.current))}
            >
              <HexMap
                state={state}
                selectedId={selectedId}
                actorId={actorId}
                highlights={highlights}
                fx={fx}
                idleUnitIds={idleUnitIds}
                onHexClick={onHexClick}
                onHexHover={setHoverHex}
              />
            </ErrorBoundary>
          </div>
          {!victoryDismissed && <VictoryOverlay state={state} onRestart={restart} onDismiss={() => setVictoryDismissed(true)} />}
        </section>

        <aside className="flex flex-col gap-3 min-h-0">
          <MechanicsPanel
            library={library}
            inMatch={new Set(state.mechanics.filter((m) => m.enabled).map((m) => m.id))}
            onToggle={toggleMechanic}
            onDelete={deleteMechanic}
          />
          <EventLog log={state.eventLog} />
        </aside>
      </main>

      {/* ── Command prompt bar ── */}
      <footer className="shrink-0 px-3 pb-3">
        <CommandBar
          busy={busy || aiRunning}
          providerLabel={providerLabel(llm)}
          aiProvider={llm.provider !== 'local' && providerReady(llm)}
          onSubmit={(p) => void inject(p)}
          onOpenSettings={() => setSettingsOpen(true)}
          preview={preview}
        />
      </footer>

      {settingsOpen && (
        <SettingsModal
          settings={llm}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            setLlm(next);
            store.set('c2.llm', JSON.stringify(next));
            toast({ kind: 'info', title: 'TRANSLATOR SET', body: providerLabel(next) });
          }}
        />
      )}
      <CodexDrawer
        open={codexOpen}
        entries={codex}
        state={state}
        library={library}
        onClose={() => setCodexOpen(false)}
        onLocate={(id) => {
          setSelectedId(id);
          setCodexOpen(false);
          sfx.play('select');
        }}
        onClear={() => setCodex([])}
      />
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />
    </div>
  );
}
