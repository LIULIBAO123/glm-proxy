/**
 * Dashboard API and static file serving.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { getAccountList, getAccountCount, addAccount, removeAccount, toggleAccount, getAccountApiKey, removeAccountsByStatus, updateAccountWeight, getSelectionConfig, setSelectionConfig } from '../auth.js';
import { queryBalance } from '../balance.js';
import { getStatsOverview, getRequestTimeline, getModelStats, getCallLogs } from '../stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _dashboardHtml = null;
function getDashboardHtml() {
  if (!_dashboardHtml) {
    _dashboardHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  }
  return _dashboardHtml;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function checkDashboardAuth(req) {
  if (!config.dashboardPassword) return true;
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString();
  return decoded === `admin:${config.dashboardPassword}`;
}

export function serveDashboard(req, res, path) {
  if (config.dashboardPassword && !checkDashboardAuth(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="GLM Proxy Dashboard"', 'content-type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }
  const html = getDashboardHtml();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export async function handleDashboardApi(req, res, path, url) {
  if (config.dashboardPassword && !checkDashboardAuth(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (path === '/api/dashboard/status' && req.method === 'GET') {
    json(res, 200, { accounts: getAccountList(), summary: getAccountCount() });
    return;
  }

  if (path === '/api/dashboard/accounts' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const account = addAccount(body);
      json(res, 201, { success: true, account });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  const accountMatch = path.match(/^\/api\/dashboard\/accounts\/([^/]+)$/);
  if (accountMatch) {
    const id = accountMatch[1];
    if (req.method === 'DELETE') {
      json(res, 200, { success: removeAccount(id) });
      return;
    }
    if (req.method === 'PATCH') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.weight !== undefined) {
        json(res, 200, { success: updateAccountWeight(id, body.weight) });
      } else {
        json(res, 200, { success: toggleAccount(id, body.active) });
      }
      return;
    }
  }

  // Bulk remove by status
  if (path === '/api/dashboard/accounts/bulk-remove' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const count = removeAccountsByStatus(body.status);
      json(res, 200, { success: true, removed: count });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return;
  }

  // Stats API
  if (path === '/api/dashboard/stats' && req.method === 'GET') {
    const window = url.searchParams.get('window');
    const windowMs = window ? parseInt(window) : null;
    json(res, 200, {
      overview: getStatsOverview(),
      timeline: getRequestTimeline(windowMs),
      models: getModelStats(windowMs),
    });
    return;
  }

  // Call logs
  if (path === '/api/dashboard/logs' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    json(res, 200, getCallLogs(limit, offset));
    return;
  }

  // Selection mode config
  if (path === '/api/dashboard/selection' && req.method === 'GET') {
    json(res, 200, getSelectionConfig());
    return;
  }
  if (path === '/api/dashboard/selection' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      json(res, 200, setSelectionConfig(body));
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return;
  }

  // Balance query
  const balanceMatch = path.match(/^\/api\/dashboard\/balance\/([^/]+)$/);
  if (balanceMatch && req.method === 'GET') {
    const id = balanceMatch[1];
    const apiKey = getAccountApiKey(id);
    if (!apiKey) { json(res, 404, { error: 'Account not found' }); return; }
    try {
      const balance = await queryBalance(apiKey);
      json(res, 200, balance);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
}
