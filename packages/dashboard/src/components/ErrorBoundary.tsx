import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{ padding: "3rem", textAlign: "center" }}>
          <div style={{ color: "var(--red)", fontSize: "0.9rem", marginBottom: "0.75rem" }}>Something went wrong in this panel.</div>
          <div className="text-dim" style={{ fontSize: "0.78rem", marginBottom: "1rem", maxWidth: 400, margin: "0 auto 1rem" }}>
            {this.state.error?.message}
          </div>
          <button className="page-btn" onClick={this.handleRetry} style={{ margin: "0 auto" }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
