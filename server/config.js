// Loads .env (no dependency) and exposes typed config. Secrets never leave the server.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// fileURLToPath handles Windows drive letters (C:\...); URL.pathname does not.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(root, '.env'));

const env = process.env;
export const config = {
  root,
  dataDir: env.ORBIT_DATA_DIR || path.join(root, 'data'),
  port: Number(env.ORBIT_PORT || 7777),
  host: env.ORBIT_HOST || '127.0.0.1',
  ai: {
    provider: env.ORBIT_AI_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'offline'),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    fastModel: env.ORBIT_FAST_MODEL || 'claude-haiku-5-5',
    reasoningModel: env.ORBIT_REASONING_MODEL || 'claude-opus-5-5',
  },
  homeAssistant: { url: env.HOME_ASSISTANT_URL || '', token: env.HOME_ASSISTANT_TOKEN || '' },
  hue: { ip: env.HUE_BRIDGE_IP || '', username: env.HUE_USERNAME || '' },
  deviceAckTimeoutMs: Number(env.ORBIT_DEVICE_TIMEOUT_MS || 8000),
};

fs.mkdirSync(config.dataDir, { recursive: true });

// Admin token for the dashboard: from env, else persisted in data/admin-token.
const tokenFile = path.join(config.dataDir, 'admin-token');
if (env.ORBIT_ADMIN_TOKEN) config.adminToken = env.ORBIT_ADMIN_TOKEN;
else if (fs.existsSync(tokenFile)) config.adminToken = fs.readFileSync(tokenFile, 'utf8').trim();
else {
  config.adminToken = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(tokenFile, config.adminToken, { mode: 0o600 });
}
