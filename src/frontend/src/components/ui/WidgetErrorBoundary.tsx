import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Contains a render failure to the one agent widget that caused it. Agent output is
 * external input — a malformed render_chart / render_table payload must degrade to an
 * inline notice, never unmount the whole app (React blanks the root on an uncaught
 * render error when no boundary is present).
 */
export class WidgetErrorBoundary extends Component<{ label?: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex items-start gap-2 text-[12px] text-status-error-text">
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">{this.props.label ?? 'Widget'} could not be rendered</p>
          <p className="font-mono text-[10px] text-text-muted break-all">{this.state.error.message}</p>
        </div>
      </div>
    );
  }
}
