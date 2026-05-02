/**
 * GLM Proxy HTTP Server
 *
 *   POST /v1/chat/completions   — OpenAI-compatible chat completions (forwarded to GLM)
 *   GET  /v1/models             — list available models
 *   POST /auth/accounts         — add account (apiKey + baseUrl)
 *   GET  /auth/accounts         — list all accounts
 *   DELETE /auth/accounts/:id   — remove account
 *   PATCH /auth/accounts/:id    — toggle account status
 *   GET  /auth/status           — pool status summary
 *   GET  /health                — health check
 *   GET  /                      — dashboard
 */

import http from 'http';
import { config, log } from './config.js';
import { validateApiKey, addAccount, removeAccount, toggleAccount, getAccountList, getAccountCount } from './auth.js';
import { handleChatCompletions } from './handlers/chat.js';
import { handleModels } from './handlers/models.js';
import { serveDashboard, handleDashboardApi } from './dashboard/api.js';

const MAX_BODY_SIZE = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key');
}

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // Health check (no auth)
  if (path === '/health' && req.method === 'GET') {
    json(res, 200, { status: 'ok', accounts: getAccountCount() });
    return;
  }

  // Dashboard
  if (path === '/' || path.startsWith('/dashboard')) {
    serveDashboard(req, res, path);
    return;
  }

  // Dashboard API
  if (path.startsWith('/api/dashboard')) {
    await handleDashboardApi(req, res, path, url);
    return;
  }

  // Auth check for API endpoints
  if (!validateApiKey(req)) {
    json(res, 401, { error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  // --- OpenAI-compatible endpoints ---

  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    await handleChatCompletions(req, res, body);
    return;
  }

  if (path === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
    return;
  }

  // --- Account management endpoints ---

  if (path === '/auth/accounts' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const account = addAccount(body);
      json(res, 201, { success: true, account: { id: account.id, name: account.name, baseUrl: account.baseUrl } });
    } catch (err) {
      json(res, 400, { error: { message: err.message } });
    }
    return;
  }

  if (path === '/auth/accounts' && req.method === 'GET') {
    json(res, 200, { accounts: getAccountList() });
    return;
  }

  const accountMatch = path.match(/^\/auth\/accounts\/([^/]+)$/);
  if (accountMatch) {
    const id = accountMatch[1];
    if (req.method === 'DELETE') {
      const ok = removeAccount(id);
      json(res, ok ? 200 : 404, ok ? { success: true } : { error: { message: 'Account not found' } });
      return;
    }
    if (req.method === 'PATCH') {
      try {
        const body = JSON.parse(await readBody(req));
        const ok = toggleAccount(id, body.active !== false);
        json(res, ok ? 200 : 404, ok ? { success: true } : { error: { message: 'Account not found' } });
      } catch (err) {
        json(res, 400, { error: { message: err.message } });
      }
      return;
    }
  }

  if (path === '/auth/status' && req.method === 'GET') {
    json(res, 200, getAccountCount());
    return;
  }

  // 404
  json(res, 404, { error: { message: 'Not found', type: 'not_found' } });
});

export function startServer() {
  server.listen(config.port, config.host, () => {
    log.info(`GLM Proxy running on http://${config.host}:${config.port}`);
    log.info(`Dashboard: http://localhost:${config.port}/`);
    log.info(`API: http://localhost:${config.port}/v1/chat/completions`);
    const counts = getAccountCount();
    log.info(`Account pool: ${counts.active} active / ${counts.total} total`);
  });
}
