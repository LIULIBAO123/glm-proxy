import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const dataDir = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : resolve(ROOT, 'data');
try { mkdirSync(dataDir, { recursive: true }); } catch {}

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.API_KEY || '',
  dataDir,
  defaultModel: process.env.DEFAULT_MODEL || 'glm-4-flash',
  maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', new Date().toISOString(), ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', new Date().toISOString(), ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', new Date().toISOString(), ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', new Date().toISOString(), ...args),
};
