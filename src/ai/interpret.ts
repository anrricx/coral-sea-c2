// Offline translation entry point: precise keyword parser first, then the
// universal "anything goes" interpreter, which never fails.
import type { GameState } from '../engine/types';
import { parseLocally } from './localParser';
import { interpretAnything } from './universalParser';

export interface OfflineResult {
  mutations: unknown[];
  narrative: string;
  /** 'keyword' = precise template match; 'universal' = trait-based interpretation. */
  via: 'keyword' | 'universal';
}

export function interpretOffline(prompt: string, state: GameState): OfflineResult {
  try {
    const r = parseLocally(prompt);
    if (r.mutations.length) return { ...r, via: 'keyword' };
  } catch {
    /* fall through to the universal interpreter */
  }
  const u = interpretAnything(prompt, state);
  return { mutations: u.mutations, narrative: u.narrative, via: 'universal' };
}
