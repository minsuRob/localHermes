#!/usr/bin/env node

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createClientAuthHeaders,
  verifyRequestAuth,
} from '../lib/openhermes-auth.mjs';
import {
  appendAuditRecord,
  getAuditLogPath,
  readRecentAuditRecords,
} from '../lib/openhermes-audit.mjs';
import {
  executeAutomationAction,
  inspectPermissions,
  openSystemPane,
} from '../lib/openhermes-automation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  return hit.slice(prefix.length);
}

function hasFlag(flag) {
  return args.includes(flag);
}

const port = Number(getArg('--port', process.env.OPENHERMES_PROXY_PORT || '8787'));
const hermesBaseUrl = (getArg('--upstream', process.env.OPENHERMES_HERMES_BASE_URL || 'http://127.0.0.1:8080')).replace(/\/+$/, '');
const modelId = getArg('--model', process.env.OPENHERMES_MODEL_ID || process.env.HERMES_MODEL_ID || '');
const rateLimitPerMinute = Number(getArg('--rate-limit', process.env.OPENHERMES_RATE_LIMIT_PER_MINUTE || '180'));
const allowedOrigin = getArg('--allowed-origin', process.env.OPENHERMES_ALLOWED_ORIGIN || '*');
const exposeMode = hasFlag('--serve') ? 'tailnet' : hasFlag('--funnel') ? 'public' : '';
const apiToken = getArg('--token', process.env.OPENHERMES_API_TOKEN || '');
const apiSecret = getArg('--secret', process.env.OPENHERMES_API_SECRET || '');
const auditLogPath = getAuditLogPath(rootDir, getArg('--audit-log', process.env.OPENHERMES_AUDIT_LOG || ''));

const requestCounters = new Map();

function getResponseOrigin(request) {
  return request.headers.origin || allowedOrigin;
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': extraHeaders['access-control-allow-origin'] || allowedOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-oh-timestamp, x-oh-signature',
    'access-control-allow-private-network': 'true',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function getClientKey(request) {
  return request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown';
}

function rateLimited(request) {
  if (!rateLimitPerMinute || rateLimitPerMinute <= 0) return false;
  const key = getClientKey(request);
  const now = Date.now();
  const windowMs = 60_000;
  const bucket = requestCounters.get(key) || [];
  const trimmed = bucket.filter((stamp) => now - stamp < windowMs);
  trimmed.push(now);
  requestCounters.set(key, trimmed);
  return trimmed.length > rateLimitPerMinute;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readBodyText(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonBody(rawText) {
  if (!rawText || !rawText.trim()) return {};
  return JSON.parse(rawText);
}

function requestSummary(request) {
  return {
    method: request.method,
    path: request.url,
    client: getClientKey(request),
  };
}

async function audit(event, request, details = {}) {
  await appendAuditRecord(auditLogPath, {
    ts: new Date().toISOString(),
    event,
    ...requestSummary(request),
    ...details,
  }).catch(() => null);
}

async function readAuthAndBody(request, url) {
  const rawBody = await readBodyText(request);
  const auth = verifyRequestAuth(request, {
    token: apiToken,
    secret: apiSecret,
    bodyText: rawBody,
    method: request.method || 'POST',
    pathname: url.pathname,
  });
  const body = parseJsonBody(rawBody);
  return { rawBody, body, auth };
}

async function checkUpstream() {
  const health = await fetch(`${hermesBaseUrl}/health`).catch(() => null);
  return {
    ok: Boolean(health?.ok),
    status: health?.status || 0,
    baseUrl: hermesBaseUrl,
  };
}

async function forwardChat(payload) {
  const response = await fetch(`${hermesBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: payload.model || modelId,
      temperature: payload.temperature ?? 0.2,
      max_tokens: payload.max_tokens ?? payload.maxTokens ?? 2048,
      stream: payload.stream !== false,
      messages: payload.messages || [],
    }),
  });

  return response;
}

async function sendWebhookReply(replyUrl, text) {
  if (!replyUrl) return;
  await fetch(replyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => null);
}

async function handleToolMessage(requestBody, sourceLabel) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const normalized = messages.map((message) => {
    if (typeof message === 'string') {
      return { role: 'user', content: message };
    }
    return {
      role: message.role || 'user',
      content: message.content ?? '',
    };
  });

  const response = await forwardChat({
    ...requestBody,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          `You are OpenHermes responding to a ${sourceLabel} webhook. Keep answers concise, helpful, and action oriented.`,
      },
      ...normalized,
    ],
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(bodyText || `Upstream HTTP ${response.status}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = { raw: bodyText };
  }

  const reply = parsed?.choices?.[0]?.message?.content || parsed?.raw || bodyText;
  if (requestBody.response_url || requestBody.reply_url) {
    await sendWebhookReply(requestBody.response_url || requestBody.reply_url, reply);
  }

  return {
    reply,
    raw: parsed,
  };
}

function extractJsonBlock(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

function inferControlPlan(promptText) {
  const prompt = String(promptText || '').trim();
  const lower = prompt.toLowerCase();
  const actions = [];

  const browserMatch = lower.includes('chrome') || lower.includes('크롬') || lower.includes('google');
  const cursorMatch = lower.includes('cursor');
  const codexMatch = lower.includes('codex');
  const zedMatch = lower.includes('zed') || lower.includes('제드');

  const urlMatch = prompt.match(/https?:\/\/[^\s]+/i);
  const domainMatch = prompt.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co\.kr|kr|dev)\b/i);
  const inferredUrl = urlMatch?.[0] || (domainMatch ? `https://${domainMatch[0]}` : '');

  if (browserMatch && /(?:열|open|visit|방문|켜|가|가줘|열어줘)/i.test(prompt)) {
    actions.push({ action: 'launch', app: 'Google Chrome' });
    if (inferredUrl) {
      actions.push({ action: 'openUrl', app: 'Google Chrome', url: inferredUrl });
    }
  }

  if (cursorMatch) {
    actions.push({ action: 'launch', app: 'Cursor' });
  }

  if (codexMatch) {
    actions.push({ action: 'launch', app: 'Codex' });
  }

  if (zedMatch) {
    actions.push({ action: 'launch', app: 'Zed' });
  }

  if (/설정|권한|permission|privacy/i.test(prompt)) {
    actions.push({ action: 'openSystemPane', pane: 'automation' });
  }

  if (!actions.length && inferredUrl) {
    actions.push({ action: 'launch', app: 'Google Chrome' });
    actions.push({ action: 'openUrl', app: 'Google Chrome', url: inferredUrl });
  }

  if (!actions.length) {
    actions.push({ action: 'probe' });
  }

  return {
    summary: prompt || 'computer use task',
    actions,
  };
}

async function buildControlPlan(promptText, contextText = '') {
  const heuristicPlan = inferControlPlan(promptText);
  if (heuristicPlan.actions.some((action) => action.action !== 'probe')) {
    return heuristicPlan;
  }

  const systemPrompt = [
    'You are OpenHermes computer-use planner.',
    'Convert the user request into a compact JSON object only.',
    'No markdown, no prose, no code fences.',
    'Schema: {"summary":"...", "actions":[{"action":"launch|focus|openUrl|type|shortcut|clickMenuItem|openSystemPane|probe|activateWindow", "app":"...", "url":"...", "text":"...", "pane":"...", "shortcut":{"key":"...","modifiers":["command","shift"]}, "menuPath":{"menu":"...","item":"...","subItem":"..."}, "selectorOrCoords":{"x":0,"y":0}}]}',
    'Use Chrome for web requests when a browser is requested.',
    'Prefer the smallest action sequence that achieves the goal.',
    'If the request cannot be safely executed, return {"summary":"...", "actions":[{"action":"probe"}]}.',
  ].join(' ');

  const response = await forwardChat({
    stream: false,
    temperature: 0,
    max_tokens: 512,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Request: ${promptText}${contextText ? `\nContext: ${contextText}` : ''}`,
      },
    ],
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(bodyText || `Upstream HTTP ${response.status}`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(extractJsonBlock(bodyText) || bodyText);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.actions)) {
    parsed = heuristicPlan;
  }

  if (!parsed.summary) {
    parsed.summary = String(promptText || '').trim() || 'computer use task';
  }

  return parsed;
}

async function executeControlPlan(plan) {
  const results = [];
  for (const action of Array.isArray(plan.actions) ? plan.actions : []) {
    // Best-effort execution order; each action is logged separately for audit.
    const result = await executeAutomationAction(action);
    results.push({ action, result });
  }
  return results;
}

function readSlackText(body) {
  if (typeof body.text === 'string') return body.text;
  if (typeof body.command === 'string') return body.command;
  if (typeof body.challenge === 'string') return body.challenge;
  if (body.event?.text) return body.event.text;
  return '';
}

function readDiscordText(body) {
  if (typeof body.content === 'string') return body.content;
  if (typeof body.text === 'string') return body.text;
  return '';
}

const server = http.createServer(async (request, response) => {
  if (rateLimited(request)) {
    sendJson(response, 429, { ok: false, error: 'rate_limited' });
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': getResponseOrigin(request),
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-oh-timestamp, x-oh-signature',
      'access-control-allow-private-network': 'true',
      vary: 'Origin',
    });
    response.end();
    return;
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  const needsProtectedAuth =
    url.pathname.startsWith('/api/chat') ||
    url.pathname.startsWith('/api/control') ||
    url.pathname.startsWith('/api/automation') ||
    url.pathname.startsWith('/api/permissions') ||
    url.pathname.startsWith('/api/audit');

  if (needsProtectedAuth && request.method !== 'OPTIONS') {
    const auth = verifyRequestAuth(request, {
      token: apiToken,
      secret: apiSecret,
      method: request.method || 'POST',
      pathname: url.pathname,
    });
    if (!auth.ok) {
      await audit('auth.denied', request, {
        pathname: url.pathname,
        reason: auth.reason,
        remoteAddress: auth.remoteAddress,
      });
      sendJson(response, 401, { ok: false, error: auth.reason || 'unauthorized' }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
      return;
    }
  }

  if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
    const upstream = await checkUpstream();
    sendJson(response, upstream.ok ? 200 : 503, {
      ok: upstream.ok,
      proxy: {
        port,
        cwd: rootDir,
      },
      upstream,
    }, {
      'access-control-allow-origin': getResponseOrigin(request),
      vary: 'Origin',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/audit') {
    const limit = Number(url.searchParams.get('limit') || '50');
    const records = await readRecentAuditRecords(auditLogPath, Number.isFinite(limit) ? limit : 50);
    sendJson(response, 200, {
      ok: true,
      path: auditLogPath,
      records,
    }, {
      'access-control-allow-origin': getResponseOrigin(request),
      vary: 'Origin',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/permissions/status') {
    try {
      const status = await inspectPermissions();
      await audit('permissions.status', request, { status });
      sendJson(response, 200, { ok: true, ...status }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('permissions.status.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/permissions/request') {
    try {
      const { body, auth } = await readAuthAndBody(request, url);
      const targetPermission = String(body.targetPermission || body.target || 'automation').trim();
      const openPanels = body.openPanels !== false;
      const autoAttempt = body.autoAttempt !== false;

      const panelMap = {
        automation: 'automation',
        accessibility: 'accessibility',
        screenrecording: 'screenrecording',
        screencapture: 'screenrecording',
        filesandfolders: 'filesandfolders',
      };
      const openPanelsResult = [];
      if (openPanels) {
        const requested = panelMap[targetPermission.toLowerCase()] || targetPermission.toLowerCase();
        const panels = requested === 'automation'
          ? ['automation', 'accessibility', 'screenrecording', 'filesandfolders']
          : [requested];
        for (const panel of panels) {
          // Best effort: open the relevant pane so the user can click allow buttons.
          const result = await openSystemPane(panel);
          openPanelsResult.push(result);
        }
      }

      const probe = autoAttempt ? await executeAutomationAction({ action: 'probe' }) : null;
      const payload = {
        ok: true,
        targetPermission,
        openPanels: openPanelsResult,
        probe,
        auth,
      };
      await audit('permissions.request', request, payload);
      sendJson(response, 200, payload, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('permissions.request.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/automation/execute') {
    try {
      const { body, auth } = await readAuthAndBody(request, url);
      const result = await executeAutomationAction(body);
      const payload = { ok: true, result, auth };
      await audit('automation.execute', request, { requestBody: body, result });
      sendJson(response, 200, payload, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('automation.execute.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/automation/app') {
    try {
      const { body, auth } = await readAuthAndBody(request, url);
      const action = String(body.action || 'focus').trim();
      const app = String(body.app || body.target || '').trim();
      const result = await executeAutomationAction({
        ...body,
        action,
        app,
      });
      const payload = { ok: true, result, auth };
      await audit('automation.app', request, { requestBody: body, result });
      sendJson(response, 200, payload, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('automation.app.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const body = await readBody(request);
      const upstream = await forwardChat(body);
      await audit('chat.forward', request, { messageCount: Array.isArray(body.messages) ? body.messages.length : 0, upstreamStatus: upstream.status });

      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'access-control-allow-origin': getResponseOrigin(request),
        'access-control-allow-private-network': 'true',
        vary: 'Origin',
      });

      if (!upstream.body) {
        response.end(await upstream.text());
        return;
      }

      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          response.write(Buffer.from(value));
        }
        response.end();
      };
      await pump();
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/control') {
    try {
      const { body, auth } = await readAuthAndBody(request, url);
      const task = body.task || body.prompt || '';
      const previewOnly = body.preview === true || body.execute === false;
      const plan = await buildControlPlan(task, body.context || '');
      let executionResults = [];
      if (!previewOnly) {
        executionResults = await executeControlPlan(plan);
      }
      const payload = {
        ok: true,
        summary: plan.summary,
        plan,
        executed: !previewOnly,
        results: executionResults,
        auth,
      };
      await audit('control.task', request, {
        task,
        previewOnly,
        plan,
        executionResults,
      });
      sendJson(response, 200, payload, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('control.task.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/slack') {
    try {
      const body = await readBody(request);
      if (body.challenge) {
        sendJson(response, 200, { challenge: body.challenge }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      const result = await handleToolMessage(
        {
          ...body,
          messages: [{ role: 'user', content: readSlackText(body) }],
        },
        'slack',
      );
      await audit('webhook.slack', request, { body, result: Boolean(result?.reply) });
      sendJson(response, 200, { ok: true, ...result }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('webhook.slack.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/discord') {
    try {
      const body = await readBody(request);
      const result = await handleToolMessage(
        {
          ...body,
          messages: [{ role: 'user', content: readDiscordText(body) }],
        },
        'discord',
      );
      await audit('webhook.discord', request, { body, result: Boolean(result?.reply) });
      sendJson(response, 200, { ok: true, ...result }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('webhook.discord.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: 'not_found',
    routes: [
      'GET /health',
      'GET /api/audit',
      'GET /api/permissions/status',
      'POST /api/permissions/request',
      'POST /api/chat',
      'POST /api/control',
      'POST /api/automation/execute',
      'POST /api/automation/app',
      'POST /webhooks/slack',
      'POST /webhooks/discord',
    ],
  }, {
    'access-control-allow-origin': getResponseOrigin(request),
    vary: 'Origin',
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`OpenHermes proxy listening on http://127.0.0.1:${port}`);
  console.log(`Upstream Hermes: ${hermesBaseUrl}`);
  if (exposeMode === 'tailnet' || exposeMode === 'public') {
    const command = exposeMode === 'public' ? 'funnel' : 'serve';
    const args = [command, '--bg', '--yes', `http://127.0.0.1:${port}`];
    const child = spawn('tailscale', args, {
      cwd: rootDir,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.log(`tailscale ${command} exited with code ${code}`);
      }
    });
  }
});
