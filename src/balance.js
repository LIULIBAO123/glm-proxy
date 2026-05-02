/**
 * GLM API balance/quota checker.
 * Queries https://open.bigmodel.cn/api/paas/v4/finance/* and /api/monitor/usage/quota/limit
 */

import https from 'https';
import { log } from './config.js';

const BALANCE_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...headers, 'content-type': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

export async function queryBalance(apiKey) {
  const cached = BALANCE_CACHE.get(apiKey);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = { tokens: null, packages: [], quotaLimits: [], error: null };

  try {
    // Try the quota/limit endpoint (works for Coding Plan and some commercial accounts)
    const quotaRes = await httpsGet(
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      { 'Authorization': apiKey }
    );

    if (quotaRes.status === 200 && quotaRes.data?.success && quotaRes.data?.data?.limits) {
      result.quotaLimits = quotaRes.data.data.limits.map(l => ({
        type: l.type,
        percentage: l.percentage || 0,
        currentValue: l.currentValue || 0,
        usage: l.usage || 0,
        remaining: l.remaining || 0,
        nextResetTime: l.nextResetTime || null,
      }));
    }
  } catch (e) {
    log.debug('quota/limit query failed:', e.message);
  }

  try {
    // Try the finance/balance endpoint (for token package accounts)
    const balanceRes = await httpsGet(
      'https://open.bigmodel.cn/api/paas/v4/finance/balance',
      { 'Authorization': `Bearer ${apiKey}` }
    );

    if (balanceRes.status === 200 && balanceRes.data) {
      const data = balanceRes.data.data || balanceRes.data;
      if (data.packages && Array.isArray(data.packages)) {
        result.packages = data.packages.map(p => ({
          name: p.name || p.packageName || 'Unknown',
          balance: p.balance ?? p.remaining ?? 0,
          total: p.total ?? p.used + p.balance ?? 0,
          unit: p.unit || 'tokens',
        }));
      }
      if (typeof data.balance === 'number') {
        result.tokens = data.balance;
      }
    }
  } catch (e) {
    log.debug('finance/balance query failed:', e.message);
  }

  if (!result.quotaLimits.length && !result.packages.length && result.tokens === null) {
    // Try alternative endpoint
    try {
      const altRes = await httpsGet(
        'https://open.bigmodel.cn/api/paas/v4/dashboard/billing/subscription',
        { 'Authorization': `Bearer ${apiKey}` }
      );
      if (altRes.status === 200 && altRes.data) {
        result.raw = altRes.data;
      }
    } catch (e) {
      result.error = 'Unable to query balance';
    }
  }

  BALANCE_CACHE.set(apiKey, { time: Date.now(), result });
  return result;
}

export function clearBalanceCache(apiKey) {
  if (apiKey) BALANCE_CACHE.delete(apiKey);
  else BALANCE_CACHE.clear();
}
