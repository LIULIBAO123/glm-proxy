/**
 * Multi-account pool for GLM API keys.
 *
 * Features:
 *   - Multiple API keys with round-robin load balancing
 *   - Account health tracking (error count, auto-disable, cooldown)
 *   - Per-account RPM rate limiting
 *   - Dynamic add/remove via API
 *   - Persistent storage in accounts.json
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config, log } from './config.js';

const ACCOUNTS_FILE = join(config.dataDir, 'accounts.json');

const accounts = [];
let _roundRobinIndex = 0;

const DEFAULT_RPM = 60;
const RPM_WINDOW_MS = 60 * 1000;
const MAX_ERRORS_BEFORE_DISABLE = 5;
const COOLDOWN_MS = 5 * 60 * 1000;

// --- Persistence ---

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (Array.isArray(data)) {
      accounts.length = 0;
      for (const a of data) {
        accounts.push({
          id: a.id || randomUUID(),
          name: a.name || '',
          apiKey: a.apiKey || '',
          baseUrl: a.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
          status: a.status || 'active',
          rpm: a.rpm || DEFAULT_RPM,
          errorCount: 0,
          lastError: null,
          disabledUntil: null,
          _rpmHistory: [],
          addedAt: a.addedAt || new Date().toISOString(),
          totalRequests: a.totalRequests || 0,
          totalErrors: a.totalErrors || 0,
        });
      }
      log.info(`Loaded ${accounts.length} account(s) from ${ACCOUNTS_FILE}`);
    }
  } catch (err) {
    log.error('Failed to load accounts:', err.message);
  }
}

function saveAccounts() {
  const data = accounts.map(a => ({
    id: a.id,
    name: a.name,
    apiKey: a.apiKey,
    baseUrl: a.baseUrl,
    status: a.status,
    rpm: a.rpm,
    addedAt: a.addedAt,
    totalRequests: a.totalRequests,
    totalErrors: a.totalErrors,
  }));
  try {
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    log.error('Failed to save accounts:', err.message);
  }
}

loadAccounts();

// --- RPM tracking ---

function rpmCount(account) {
  const cutoff = Date.now() - RPM_WINDOW_MS;
  account._rpmHistory = account._rpmHistory.filter(t => t > cutoff);
  return account._rpmHistory.length;
}

function recordRequest(account) {
  account._rpmHistory.push(Date.now());
  account.totalRequests++;
}

// --- Health tracking ---

export function reportError(accountId, error) {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return;
  account.errorCount++;
  account.totalErrors++;
  account.lastError = { message: error?.message || String(error), at: new Date().toISOString() };
  if (account.errorCount >= MAX_ERRORS_BEFORE_DISABLE) {
    account.status = 'cooldown';
    account.disabledUntil = Date.now() + COOLDOWN_MS;
    log.warn(`Account ${account.name || account.id} disabled for ${COOLDOWN_MS / 1000}s after ${account.errorCount} errors`);
    saveAccounts();
  }
}

export function reportSuccess(accountId) {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return;
  account.errorCount = 0;
  account.lastError = null;
}

// --- Account selection (round-robin with health check) ---

export function selectAccount() {
  const now = Date.now();

  // Reactivate cooldown accounts
  for (const a of accounts) {
    if (a.status === 'cooldown' && a.disabledUntil && now > a.disabledUntil) {
      a.status = 'active';
      a.errorCount = 0;
      a.disabledUntil = null;
      log.info(`Account ${a.name || a.id} reactivated after cooldown`);
    }
  }

  const eligible = accounts.filter(a => a.status === 'active' && rpmCount(a) < a.rpm);
  if (eligible.length === 0) {
    // Try accounts even if over RPM (degraded mode)
    const active = accounts.filter(a => a.status === 'active');
    if (active.length === 0) return null;
    const idx = _roundRobinIndex % active.length;
    _roundRobinIndex++;
    const selected = active[idx];
    recordRequest(selected);
    return selected;
  }

  const idx = _roundRobinIndex % eligible.length;
  _roundRobinIndex++;
  const selected = eligible[idx];
  recordRequest(selected);
  return selected;
}

// --- Account CRUD ---

export function addAccount({ name, apiKey, baseUrl, rpm }) {
  if (!apiKey) throw new Error('apiKey is required');
  const existing = accounts.find(a => a.apiKey === apiKey);
  if (existing) throw new Error('Account with this API key already exists');

  const account = {
    id: randomUUID(),
    name: name || `账号${accounts.length + 1}`,
    apiKey,
    baseUrl: baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
    status: 'active',
    rpm: rpm || DEFAULT_RPM,
    errorCount: 0,
    lastError: null,
    disabledUntil: null,
    _rpmHistory: [],
    addedAt: new Date().toISOString(),
    totalRequests: 0,
    totalErrors: 0,
  };
  accounts.push(account);
  saveAccounts();
  log.info(`Added account: ${account.name} (${account.id})`);
  return account;
}

export function removeAccount(id) {
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  const [removed] = accounts.splice(idx, 1);
  saveAccounts();
  log.info(`Removed account: ${removed.name} (${removed.id})`);
  return true;
}

export function toggleAccount(id, active) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.status = active ? 'active' : 'disabled';
  account.errorCount = 0;
  account.disabledUntil = null;
  saveAccounts();
  return true;
}

export function getAccountList() {
  return accounts.map(a => ({
    id: a.id,
    name: a.name,
    baseUrl: a.baseUrl,
    status: a.status,
    rpm: a.rpm,
    rpmUsed: rpmCount(a),
    errorCount: a.errorCount,
    lastError: a.lastError,
    addedAt: a.addedAt,
    totalRequests: a.totalRequests,
    totalErrors: a.totalErrors,
    apiKeyPreview: a.apiKey ? a.apiKey.slice(0, 8) + '...' + a.apiKey.slice(-4) : '',
  }));
}

export function getAccountCount() {
  return {
    total: accounts.length,
    active: accounts.filter(a => a.status === 'active').length,
    disabled: accounts.filter(a => a.status === 'disabled').length,
    cooldown: accounts.filter(a => a.status === 'cooldown').length,
  };
}

export function removeAccountsByStatus(status) {
  const toRemove = accounts.filter(a => a.status === status);
  for (const a of toRemove) {
    const idx = accounts.findIndex(x => x.id === a.id);
    if (idx !== -1) accounts.splice(idx, 1);
  }
  if (toRemove.length) saveAccounts();
  log.info(`Bulk removed ${toRemove.length} accounts with status: ${status}`);
  return toRemove.length;
}

export function markLowBalance(id) {
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  account.status = 'low_balance';
  saveAccounts();
  return true;
}

export function getAccountApiKey(id) {
  const account = accounts.find(a => a.id === id);
  return account ? account.apiKey : null;
}

export function validateApiKey(req) {
  if (!config.apiKey) return true;
  const authHeader = String(req.headers['authorization'] || '').trim();
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : (req.headers['x-api-key'] || '');
  return token === config.apiKey;
}
