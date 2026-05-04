/**
 * Handler for POST /v1/chat/completions
 * Forwards requests to GLM API with account pool rotation.
 */

import { selectAccount, reportError, reportSuccess, markLowBalance } from '../auth.js';
import { config, log } from '../config.js';
import { recordStats } from '../stats.js';
import https from 'https';
import http from 'http';

export async function handleChatCompletions(req, res, body, _excludeAccountId) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }));
    return;
  }

  if (!payload.model) {
    payload.model = config.defaultModel;
  }
  if (!payload.max_tokens && !payload.max_completion_tokens) {
    payload.max_tokens = config.maxTokens;
  }

  const account = selectAccount(_excludeAccountId);
  if (!account) {
    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'No available accounts in pool. Add accounts via POST /auth/accounts', type: 'server_error' }
      }));
    }
    return;
  }

  const isStream = payload.stream === true;
  const startTime = Date.now();
  const base = account.baseUrl.replace(/\/$/, '');
  const targetUrl = new URL(base + '/chat/completions');

  log.debug(`Forwarding to ${account.name || account.id} → ${targetUrl.href} (stream=${isStream})`);

  const requestBody = JSON.stringify(payload);
  const transport = targetUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${account.apiKey}`,
      'content-length': Buffer.byteLength(requestBody),
    },
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    const status = proxyRes.statusCode;

    if (status >= 400) {
      let errorBody = '';
      proxyRes.on('data', chunk => { errorBody += chunk; });
      proxyRes.on('end', () => {
        reportError(account.id, new Error(`HTTP ${status}: ${errorBody.slice(0, 200)}`));
        recordStats({ model: payload.model, success: false, duration: Date.now() - startTime, accountId: account.id, accountName: account.name });
        log.warn(`Account ${account.name} returned ${status}: ${errorBody.slice(0, 200)}`);

        if (isLowBalanceError(status, errorBody)) {
          markLowBalance(account.id);
          log.warn(`Account ${account.name} marked as low_balance (auto-detected)`);
        }

        if (res.headersSent) return;

        if ((status === 429 || status >= 500 || isLowBalanceError(status, errorBody)) && !_excludeAccountId) {
          log.info(`Retrying with different account (excluding ${account.name})`);
          handleChatCompletions(req, res, body, account.id);
          return;
        }

        res.writeHead(status, {
          'content-type': proxyRes.headers['content-type'] || 'application/json',
        });
        res.end(errorBody);
      });
      return;
    }

    reportSuccess(account.id);
    const safeAccountLabel = encodeURIComponent(account.name || account.id);

    if (isStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-glm-account': safeAccountLabel,
      });
      let streamBuf = '';
      let streamError = false;
      proxyRes.on('data', chunk => {
        res.write(chunk);
        streamBuf += chunk.toString();
      });
      proxyRes.on('end', () => {
        res.end();
        if (streamError) return;
        const usage = extractUsageFromStream(streamBuf);
        recordStats({ model: payload.model, success: true, duration: Date.now() - startTime, accountId: account.id, accountName: account.name, ...usage });
      });
      proxyRes.on('error', (err) => {
        streamError = true;
        reportError(account.id, err);
        recordStats({ model: payload.model, success: false, duration: Date.now() - startTime, accountId: account.id, accountName: account.name });
        log.warn(`Stream error from ${account.name}: ${err.message}`);
        if (!res.writableEnded) res.end();
      });
      proxyRes.on('aborted', () => {
        if (streamError) return;
        streamError = true;
        reportError(account.id, new Error('upstream aborted'));
        recordStats({ model: payload.model, success: false, duration: Date.now() - startTime, accountId: account.id, accountName: account.name });
        log.warn(`Stream aborted from ${account.name} (unexpected EOF)`);
        if (!res.writableEnded) res.end();
      });
    } else {
      const chunks = [];
      let respError = false;
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        if (respError) return;
        const respBuf = Buffer.concat(chunks);
        const headers = { 'content-type': 'application/json', 'x-glm-account': safeAccountLabel, 'content-length': respBuf.length };
        res.writeHead(200, headers);
        res.end(respBuf);
        const usage = extractUsageFromBody(respBuf.toString());
        recordStats({ model: payload.model, success: true, duration: Date.now() - startTime, accountId: account.id, accountName: account.name, ...usage });
      });
      proxyRes.on('error', (err) => {
        respError = true;
        reportError(account.id, err);
        recordStats({ model: payload.model, success: false, duration: Date.now() - startTime, accountId: account.id, accountName: account.name });
        log.warn(`Response error from ${account.name}: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Upstream connection interrupted', type: 'server_error' } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      proxyRes.on('aborted', () => {
        if (respError) return;
        respError = true;
        reportError(account.id, new Error('upstream aborted'));
        recordStats({ model: payload.model, success: false, duration: Date.now() - startTime, accountId: account.id, accountName: account.name });
        log.warn(`Response aborted from ${account.name} (unexpected EOF)`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Upstream connection aborted (unexpected EOF)', type: 'server_error' } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    }
  });

  proxyReq.on('error', (err) => {
    reportError(account.id, err);
    log.error(`Request to ${account.name} failed:`, err.message);
    if (res.headersSent) return;
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}`, type: 'server_error' } }));
  });

  proxyReq.write(requestBody);
  proxyReq.end();
}

const LOW_BALANCE_PATTERNS = [
  '余额不足', '额度不足', '余额已用完', '配额不足', '资源包余额',
  'insufficient balance', 'insufficient quota', 'quota exceeded',
  'billing hard limit', 'exceeded your current quota',
  '1113', '1301',
];

function isLowBalanceError(status, body) {
  if (!body) return false;
  const lower = body.toLowerCase();
  return LOW_BALANCE_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

function extractUsageFromBody(body) {
  try {
    const data = JSON.parse(body);
    if (data.usage) {
      return {
        tokensUsed: data.usage.total_tokens || 0,
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
      };
    }
  } catch {}
  return { tokensUsed: 0, promptTokens: 0, completionTokens: 0 };
}

function extractUsageFromStream(streamData) {
  const lines = streamData.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^data:\s*/, '').trim();
    if (!line || line === '[DONE]') continue;
    try {
      const data = JSON.parse(line);
      if (data.usage) {
        return {
          tokensUsed: data.usage.total_tokens || 0,
          promptTokens: data.usage.prompt_tokens || 0,
          completionTokens: data.usage.completion_tokens || 0,
        };
      }
    } catch {}
  }
  return { tokensUsed: 0, promptTokens: 0, completionTokens: 0 };
}

