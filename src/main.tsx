import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled locally (no Google Fonts): the app must work in airplane mode.
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/600.css';
import '@fontsource/schibsted-grotesk/700.css';
import '@fontsource/schibsted-grotesk/800.css';
import '@fontsource/newsreader/400.css';
import '@fontsource/stix-two-text/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/app.css';
import './styles/highlight.css';
import { App } from './app/App';
import { boot } from './app/boot';
import { APP_NAME } from './domain/settings';
import { Capacitor } from '@capacitor/core';

// Offline support for the web app (GitHub Pages / Safari "Aggiungi a Home"). Not needed inside the native app.
if (import.meta.env.PROD && !Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

const root = createRoot(document.getElementById('root') as HTMLElement);

function Splash({ message, error }: { message: string; error?: string }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F2F2EF', padding: 24 }}>
      <div style={{ maxWidth: 460 }}>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.03em' }}>{APP_NAME}</div>
        <p style={{ margin: '10px 0 0', fontSize: 16 }}>{message}</p>
        {error && <pre className="banner" style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 14 }}>{error}</pre>}
        {error && <button className="btn lg" style={{ marginTop: 14 }} onClick={() => window.location.reload()}>Riprova</button>}
      </div>
    </div>
  );
}

root.render(<Splash message="Apro i tuoi dati…" />);
boot().then(
  ({ services }) => root.render(<StrictMode><App services={services} /></StrictMode>),
  (e: unknown) => root.render(<Splash message="Non riesco ad aprire il database locale. I tuoi dati non sono stati modificati." error={e instanceof Error ? e.message : String(e)} />),
);
