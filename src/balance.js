/**
 * GLM API balance/quota checker.
 * Uses the same endpoint as glm-check.618987.xyz:
 *   https://open.bigmodel.cn/api/biz/tokenAccounts/list/my
 */

import https from 'https';
import { log } from './config.js';

const BALANCE_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

const BALANCE_API = 'https://open.bigmodel.cn/api/biz/tokenAccounts/list/my';

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...headers, 'accept': 'application/json' },
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

export async function queryBalance(apiKey) {
  const cached = BALANCE_CACHE.get(apiKey);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = { packages: [], summary: {}, error: null };

  try {
    const res = await httpsGet(
      `${BALANCE_API}?pageNum=1&pageSize=100&filterEnabled=false`,
      { 'authorization': apiKey }
    );

    log.info(`[Balance] tokenAccounts status=${res.status} rows=${res.data?.rows?.length ?? 'N/A'}`);

    if (res.status === 200 && res.data?.code === 200 && res.data?.rows) {
      const rows = res.data.rows;

      let common = 0, glm46v = 0, glm45air = 0, search = 0, imgvideo = 0;

      for (const row of rows) {
        const balance = Number(row.availableBalance || 0);
        const model = String(row.suitableModel || '').toLowerCase();
        const consumeType = String(row.consumeType || '').toUpperCase();
        const status = row.status || '';

        if (status !== 'EFFECTIVE') continue;

        if (model.includes('glm-4.6v') || model.includes('glm-4v')) {
          glm46v += balance;
        } else if (model.includes('glm-4.5-air') || model.includes('glm-4-air')) {
          glm45air += balance;
        } else if (model.includes('search')) {
          search += balance;
        } else if (consumeType === 'TIMES') {
          imgvideo += balance;
        } else {
          common += balance;
        }

        result.packages.push({
          name: row.resourcePackageName || row.suitableModel || '未知',
          balance,
          model: row.suitableModel || '-',
          status,
          consumeType: row.consumeType || '-',
          expireTime: row.endTime || null,
        });
      }

      result.summary = {
        common: Math.round(common),
        glm46v: Math.round(glm46v),
        glm45air: Math.round(glm45air),
        search: Math.round(search),
        imgvideo: Math.round(imgvideo),
      };
    } else {
      result.error = res.data?.msg || `HTTP ${res.status}`;
    }
  } catch (e) {
    log.info('[Balance] query failed:', e.message);
    result.error = e.message;
  }

  BALANCE_CACHE.set(apiKey, { time: Date.now(), result });
  return result;
}

export function clearBalanceCache(apiKey) {
  if (apiKey) BALANCE_CACHE.delete(apiKey);
  else BALANCE_CACHE.clear();
}
