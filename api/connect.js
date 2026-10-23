// Vercel Function: Braidata Connect on Neon. The protocol lives in lib/connect-core.js (shared with the local server).
import { neon } from '@neondatabase/serverless';
import { createConnectHandler } from '../lib/connect-core.js';

export default createConnectHandler({ sql: () => neon(process.env.DATABASE_URL), env: process.env });
