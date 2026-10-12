import { createServer } from './app.mjs';
const server = await createServer({ dbPath: process.env.DB_PATH || '.data/bookings.sqlite' });
server.listen(Number(process.env.PORT || 3000), '127.0.0.1');
