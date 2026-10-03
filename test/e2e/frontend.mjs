import { createServer } from '../../apps/web/node_modules/vite/dist/node/index.js';
import react from '../../apps/web/node_modules/@vitejs/plugin-react/dist/index.js';

const target = `http://127.0.0.1:${process.env.E2E_SERVER_PORT}`;
const sideDeckFixture = {
  name: 'side-deck-component-fixture',
  resolveId(id) { if (id === 'virtual:side-deck-component') return '\0side-deck-component'; },
  load(id) {
    if (id !== '\0side-deck-component') return;
    return `
      import { createRoot } from 'react-dom/client';
      import { createElement, useState } from 'react';
      import { SideDeck } from '/src/duel/SideDeck.tsx';
      import '/src/styles.css';
      const samples = await fetch('/api/decks').then(r => r.json());
      const original = samples.find(d => d.name === 'junk synchro').deck;
      function Fixture() {
        const [error, setError] = useState();
        const [attempts, setAttempts] = useState([]);
        return createElement('main', { style: { height: '100%' } },
          createElement(SideDeck, { deck: original, score: [0, 1], game: 1, error,
            onDone: deck => {
              setAttempts(previous => [...previous, deck]);
              setError(attempts.length === 0 ? 'Side-deck submission rejected: preserve the registered card pool' : undefined);
            }
          }),
          createElement('output', { 'data-testid': 'attempts', hidden: true }, JSON.stringify(attempts))
        );
      }
      createRoot(document.getElementById('root')).render(createElement(Fixture));
    `;
  },
  configureServer(server) {
    server.middlewares.use('/__e2e/side-deck', (_req, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><title>Side-deck component fixture</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:side-deck-component"></script></body></html>');
    });
  },
};
const server = await createServer({
  configFile: false,
  envDir: false,
  envPrefix: 'YGOSIM_E2E_PUBLIC_',
  root: new URL('../../apps/web', import.meta.url).pathname,
  plugins: [react(), ...(process.env.E2E_SCENARIO === 'side-deck-component' ? [sideDeckFixture] : [])],
  define: {
    'import.meta.env.VITE_E2E_LOW_GRAPHICS': JSON.stringify(process.env.E2E_LOW_GRAPHICS ?? '0'),
    'import.meta.env.VITE_WS_URL': JSON.stringify(''),
  },
  server: {
    host: '127.0.0.1', port: 0, strictPort: true, hmr: false,
    proxy: { '/api': target, '/ws': { target, ws: true } },
  },
});
await server.listen();
console.log(`E2E_READY ${server.httpServer.address().port}`);
async function close() { await server.close(); process.exit(0); }
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
