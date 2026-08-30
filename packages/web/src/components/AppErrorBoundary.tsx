import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { failed: boolean; message: string }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      failed: true,
      message: error instanceof Error ? error.message : '알 수 없는 화면 오류가 발생했습니다.',
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the report local. It intentionally excludes chat content, tokens,
    // file paths and connection secrets.
    console.error('Mr.Robot renderer error', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      componentStack: info.componentStack,
    });
  }

  private retry = (): void => this.setState({ failed: false, message: '' });

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="fatal-error" role="alert">
      <div className="fatal-error-card">
        <span className="fatal-error-mark">!</span>
        <p className="eyebrow">SAFE RECOVERY</p>
        <h1>화면을 안전하게 복구할 수 있습니다</h1>
        <p>{this.state.message}</p>
        <div className="fatal-error-actions">
          <button className="btn btn-primary" type="button" onClick={this.retry}>다시 시도</button>
          <button className="btn btn-ghost" type="button" onClick={() => window.location.reload()}>앱 새로고침</button>
        </div>
        <small>실행 중인 로컬 에이전트와 작업 데이터는 종료되지 않습니다.</small>
      </div>
    </main>;
  }
}
