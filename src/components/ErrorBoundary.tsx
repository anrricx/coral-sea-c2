import { Component, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';

interface Props {
  children: ReactNode;
  onUndo: () => void;
  onReset: () => void;
}

/** Last line of defence: if anything still manages to break rendering, contain it and offer recovery. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Sandbox glitch contained:', error);
  }

  private recover(fn: () => void) {
    fn();
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="panel p-5 max-w-md text-center border-amber-500/50">
          <ShieldAlert className="mx-auto text-amber-400 mb-2" size={30} />
          <h3 className="font-mono tracking-[0.2em] text-amber-300 text-sm">SANDBOX GLITCH CONTAINED</h3>
          <p className="text-xs text-slate-400 mt-2">
            Something reality-bending broke the display. The game state is safe. Undo the last injection, or start a fresh engagement.
          </p>
          <p className="text-[10px] font-mono text-slate-600 mt-2 break-words">{this.state.error.message}</p>
          <div className="flex gap-2 justify-center mt-4">
            <button className="btn-ghost" onClick={() => this.recover(this.props.onUndo)}>
              Undo last injection
            </button>
            <button className="btn-primary" onClick={() => this.recover(this.props.onReset)}>
              New engagement
            </button>
          </div>
        </div>
      </div>
    );
  }
}
