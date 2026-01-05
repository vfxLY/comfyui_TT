
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// 为外部环境运行提供基础的安全垫，防止 process 未定义导致的崩溃
if (typeof window !== 'undefined' && !window.process) {
  (window as any).process = { env: {} };
}

console.log("Starting Application...");

interface ErrorBoundaryProps {
  children?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// Fix: Removed redundant constructor and used destructuring in render for standard props access.
// Also corrected the CSS property typo 'justifyCenter' to 'justifyContent'.
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    const { children } = this.props;
    const { hasError, error } = this.state;

    if (hasError) {
      return (
        <div style={{ padding: '40px', color: '#ef4444', fontFamily: 'sans-serif', textAlign: 'center', marginTop: '100px' }}>
          <div style={{ width: '80px', height: '80px', background: '#f8fafc', borderRadius: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 32px' }}>
             <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: '800', color: '#0f172a', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Studio Interface Error</h1>
          <p style={{ color: '#64748b', fontSize: '14px', marginTop: '12px', maxWidth: '400px', margin: '12px auto' }}>
            {error?.message || "An unexpected runtime exception occurred."}
          </p>
          <button 
            onClick={() => window.location.reload()} 
            style={{ marginTop: '32px', padding: '12px 32px', cursor: 'pointer', background: '#0f172a', color: 'white', border: 'none', borderRadius: '14px', fontWeight: '800', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.1em', boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
          >
            Refresh Studio
          </button>
        </div>
      );
    }

    return children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

try {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
  console.log("Application mounted successfully.");
} catch (e) {
  console.error("Failed to mount application:", e);
}
