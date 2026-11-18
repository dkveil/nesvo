import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = { children: ReactNode };

type State = {
  error: Error | null;
  componentStack: string;
  copy: 'idle' | 'copied' | 'failed';
};

const MAX_DETAIL_CHARACTERS = 16_000;

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: '', copy: 'idle' };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      copy: 'idle',
    };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const componentStack = (info.componentStack ?? '').slice(
      0,
      MAX_DETAIL_CHARACTERS,
    );
    this.setState({ componentStack });
    try {
      window.nesvo?.reportError({
        kind: 'render',
        message: failure.message.slice(0, 2000),
        stack: failure.stack?.slice(0, MAX_DETAIL_CHARACTERS),
        componentStack,
      });
    } catch {
      return;
    }
  }

  private details() {
    const { error, componentStack } = this.state;
    return [
      `Nesvo window error: ${error?.message ?? 'Unknown error'}`,
      error?.stack ?? '',
      componentStack,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private copyDetails = () => {
    void navigator.clipboard.writeText(this.details()).then(
      () => this.setState({ copy: 'copied' }),
      () => this.setState({ copy: 'failed' }),
    );
  };

  override render() {
    if (!this.state.error) return this.props.children;
    const { copy } = this.state;
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-foreground">
        <EmptyState
          role="alert"
          icon={TriangleAlert}
          title="Something went wrong in this window"
          description="Work on your computers keeps running. Reload the window to continue, or copy the details to report the problem."
          action={
            <>
              <Button onClick={() => window.location.reload()}>
                Reload window
              </Button>
              <Button variant="outline" onClick={this.copyDetails}>
                Copy details
              </Button>
            </>
          }
        />
        {copy !== 'idle' && (
          <StatusMessage
            role="status"
            tone={copy === 'copied' ? 'success' : 'error'}
          >
            {copy === 'copied'
              ? 'Details copied.'
              : 'The details could not be copied.'}
          </StatusMessage>
        )}
      </main>
    );
  }
}
