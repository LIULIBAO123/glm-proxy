/**
 * Request statistics tracker.
 * Tracks request counts, errors, response times by model and time window.
 * Persists data to stats.json so logs survive process restarts.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config, log } from './config.js';

const STATS_FILE = join(config.dataDir, 'stats.json');
const MAX_HISTORY = 10000;
const SAVE_INTERVAL_MS = 5000;

const stats = {
  totalRequests: 0,
  totalSuccess: 0,
  totalErrors: 0,
  startTime: Date.now(),
  requests: [],
};

let _savePending = false;
let _saveTimer = null;

function loadStats() {
  if (!existsSync(STATS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    if (data && typeof data === 'object') {
      stats.totalRequests = data.totalRequests || 0;
      stats.totalSuccess = data.totalSuccess || 0;
      stats.totalErrors = data.totalErrors || 0;
      stats.startTime = data.startTime || Date.now();
      if (Array.isArray(data.requests)) {
        stats.requests = data.requests;
      }
      log.info(`Loaded ${stats.requests.length} log(s) from ${STATS_FILE}`);
    }
  } catch (err) {
    log.error('Failed to load stats:', err.message);
  }
}

function saveStats() {
  try {
    writeFileSync(STATS_FILE, JSON.stringify({
      totalRequests: stats.totalRequests,
      totalSuccess: stats.totalSuccess,
      totalErrors: stats.totalErrors,
      startTime: stats.startTime,
      requests: stats.requests,
    }), 'utf-8');
  } catch (err) {
    log.error('Failed to save stats:', err.message);
  }
  _savePending = false;
}

function scheduleSave() {
  if (_savePending) return;
  _savePending = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveStats, SAVE_INTERVAL_MS);
}

loadStats();

export function recordStats({ model, success, duration, accountId, accountName, tokensUsed, promptTokens, completionTokens }) {
  stats.totalRequests++;
  if (success) stats.totalSuccess++;
  else stats.totalErrors++;

  stats.requests.push({
    time: Date.now(),
    model: model || 'unknown',
    success,
    duration: duration || 0,
    accountId,
    accountName: accountName || '',
    tokensUsed: tokensUsed || 0,
    promptTokens: promptTokens || 0,
    completionTokens: completionTokens || 0,
  });

  if (stats.requests.length > MAX_HISTORY) {
    stats.requests = stats.requests.slice(-MAX_HISTORY / 2);
  }

  scheduleSave();
}

export function getCallLogs(limit = 50, offset = 0) {
  const sorted = [...stats.requests].reverse();
  return {
    total: sorted.length,
    logs: sorted.slice(offset, offset + limit).map(r => ({
      time: new Date(r.time).toISOString(),
      model: r.model,
      accountName: r.accountName,
      accountId: r.accountId,
      success: r.success,
      duration: r.duration,
      tokensUsed: r.tokensUsed,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    })),
  };
}

export function getStatsOverview() {
  const uptime = Date.now() - stats.startTime;
  const successDurations = stats.requests.filter(r => r.success && r.duration > 0).map(r => r.duration);
  const avgDuration = successDurations.length ? Math.round(successDurations.reduce((a, b) => a + b, 0) / successDurations.length) : 0;
  const p95Duration = successDurations.length ? percentile(successDurations, 0.95) : 0;

  return {
    totalRequests: stats.totalRequests,
    totalSuccess: stats.totalSuccess,
    totalErrors: stats.totalErrors,
    errorRate: stats.totalRequests ? ((stats.totalErrors / stats.totalRequests) * 100).toFixed(1) : '0.0',
    avgDuration,
    p95Duration,
    uptime,
  };
}

export function getRequestTimeline(windowMs) {
  const cutoff = windowMs ? Date.now() - windowMs : 0;
  const filtered = stats.requests.filter(r => r.time > cutoff);

  // Group by time buckets
  const bucketCount = 24;
  const range = windowMs || (Date.now() - stats.startTime) || 1;
  const bucketSize = range / bucketCount;
  const buckets = [];

  for (let i = 0; i < bucketCount; i++) {
    const start = cutoff + i * bucketSize;
    const end = start + bucketSize;
    const inBucket = filtered.filter(r => r.time >= start && r.time < end);
    buckets.push({
      time: new Date(start).toISOString(),
      total: inBucket.length,
      success: inBucket.filter(r => r.success).length,
      errors: inBucket.filter(r => !r.success).length,
    });
  }

  return buckets;
}

export function getModelStats(windowMs) {
  const cutoff = windowMs ? Date.now() - windowMs : 0;
  const filtered = stats.requests.filter(r => r.time > cutoff);

  const models = {};
  for (const r of filtered) {
    if (!models[r.model]) {
      models[r.model] = { model: r.model, requests: 0, success: 0, errors: 0, durations: [] };
    }
    const m = models[r.model];
    m.requests++;
    if (r.success) {
      m.success++;
      if (r.duration > 0) m.durations.push(r.duration);
    } else {
      m.errors++;
    }
  }

  return Object.values(models).map(m => ({
    model: m.model,
    requests: m.requests,
    success: m.success,
    errors: m.errors,
    successRate: m.requests ? ((m.success / m.requests) * 100).toFixed(1) : '0.0',
    avgDuration: m.durations.length ? Math.round(m.durations.reduce((a, b) => a + b, 0) / m.durations.length) : 0,
    p50: m.durations.length ? percentile(m.durations, 0.5) : 0,
    p95: m.durations.length ? percentile(m.durations, 0.95) : 0,
  })).sort((a, b) => b.requests - a.requests);
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)] || 0;
}
