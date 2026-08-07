import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/**
 * Last-resort catch-all — any uncaught render error anywhere in the tree
 * used to take the whole page down to a blank black screen with no way
 * back. This shows a recoverable screen instead of a dead tab.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[ErrorBoundary] caught:', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="fixed inset-0 z-[999] flex items-center justify-center bg-neutral-950 px-6">
        <div className="max-w-sm w-full text-center">
          <p className="text-white font-semibold text-lg mb-2">Something went wrong</p>
          <p className="text-white/60 text-sm leading-relaxed mb-6">
            Reload to try again — your last saved changes are safe.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-white/90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
