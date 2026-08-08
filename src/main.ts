/**
 * Server entry point. Run with: npm run serve
 * Persists data to backend/data/store.json (gitignored).
 */

import 'dotenv/config';
import { Store, JsonFilePersistence } from './store.js';
import { startServer } from './server.js';
import { ensureSupabaseStartupCheck } from './db/health.js';

const PORT = Number(process.env.PORT ?? 8787);
const DATA_PATH = process.env.STORE_PATH ?? 'data/store.json';

// Verify the database before binding a port, so a broken connection is visible
// at startup rather than on the first request that needs it.
await ensureSupabaseStartupCheck();

const store = await Store.open(new JsonFilePersistence(DATA_PATH));
await startServer(store, PORT);
console.log(`RetailCompare API on http://localhost:${PORT}  (data: ${DATA_PATH})`);
console.log('Try:  curl http://localhost:' + PORT + '/api/health');
