import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App, ErrorBoundary } from './app/App';
import { initializeStore } from './db/store';
import './styles.css';
const root = createRoot(document.getElementById('root')!);
async function start() {
  // Initialize outside liveQuery, whose transaction is deliberately read-only.
  try {
    await initializeStore();
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch {
    root.render(
      <div className="fatal-error">
        <h1>Your ledger could not open</h1>
        <p>Enable browser storage, then reload this page. No existing records have been cleared.</p>
        <button className="button button-primary" onClick={() => window.location.reload()}>
          Reload app
        </button>
      </div>,
    );
  }
}
void start();
