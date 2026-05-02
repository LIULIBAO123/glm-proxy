/**
 * Handler for POST /v1/chat/completions
 * Forwards requests to GLM API with account pool rotation.
 */

import { selectAccount, reportError, reportSuccess } from '../auth.js';
import { config, log } from '../config.js';
import { recordStats } from '../stats.js';
import https from 'https';
import http from 'http';

export async function handleChatCompletions(req, res, body) {
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

  const account = selectAccount();
  if (!account) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'No available accounts in pool. Add accounts via POST /auth/accounts', type: 'server_error' }
    }));
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
        recordStats({ model: payload.model, success: false, duration: Date.now() - startTime, accountId: account.id });
        log.warn(`Account ${account.name} returned ${status}`);

        // Retry with another account on 429 or 5xx
        if ((status === 429 || status >= 500) && accounts_retry(req, res, body, account.id)) {
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

    if (isStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-glm-account': account.name || account.id,
      });
      let streamBuf = '';
      proxyRes.on('data', chunk => {
        res.write(chunk);
        streamBuf += chunk.toString();
      });
      proxyRes.on('end', () => {
        res.end();
        const usage = extractUsageFromStream(streamBuf);
        recordStats({ model: payload.model, success: true, duration: Date.now() - startTime, accountId: account.id, accountName: account.name, ...usage });
      });
      proxyRes.on('error', () => res.end());
    } else {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        const respBuf = Buffer.concat(chunks);
        const headers = { 'content-type': 'application/json', 'x-glm-account': account.name || account.id, 'content-length': respBuf.length };
        res.writeHead(200, headers);
        res.end(respBuf);
        const usage = extractUsageFromBody(respBuf.toString());
        recordStats({ model: payload.model, success: true, duration: Date.now() - startTime, accountId: account.id, accountName: account.name, ...usage });
      });
    }
  });

  proxyReq.on('error', (err) => {
    reportError(account.id, err);
    log.error(`Request to ${account.name} failed:`, err.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}`, type: 'server_error' } }));
  });

  proxyReq.write(requestBody);
  proxyReq.end();
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

// Simple one-retry failover: try a different account on 429/5xx
let _retryDepth = 0;
function accounts_retry(req, res, body, excludeId) {
  if (_retryDepth > 0) return false;
  _retryDepth++;
  try {
    const account = selectAccount();
    if (!account || account.id === excludeId) return false;
    log.info(`Retrying with account ${account.name || account.id}`);
    handleChatCompletions(req, res, body);
    return true;
  } finally {
    _retryDepth--;
  }
}
