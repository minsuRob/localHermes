#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
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
  createQueuedRequest,
  getQueuedRequest,
  getRequestStorePath,
  listQueuedRequests,
  updateQueuedRequest,
} from '../lib/openhermes-requests.mjs';
import {
  executeAutomationAction,
  inspectPermissions,
  probeAutomation,
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
const approvalMode = getArg('--approval-mode', process.env.OPENHERMES_APPROVAL_MODE || 'direct');
const localFastPathEnabled = String(process.env.OPENHERMES_LOCAL_FASTPATH || 'true').toLowerCase() !== 'false';
const apiToken = getArg('--token', process.env.OPENHERMES_API_TOKEN || '');
const apiSecret = getArg('--secret', process.env.OPENHERMES_API_SECRET || '');
const auditLogPath = getAuditLogPath(rootDir, getArg('--audit-log', process.env.OPENHERMES_AUDIT_LOG || ''));
const requestStorePath = getRequestStorePath(rootDir, getArg('--request-store', process.env.OPENHERMES_REQUEST_STORE || ''));
const slackWebhookSecret = process.env.OPENHERMES_SLACK_WEBHOOK_SECRET || '';
const discordWebhookSecret = process.env.OPENHERMES_DISCORD_WEBHOOK_SECRET || '';
const githubWebhookSecret = process.env.OPENHERMES_GITHUB_WEBHOOK_SECRET || '';

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
  return request?.headers?.['x-forwarded-for'] || request?.socket?.remoteAddress || 'boot';
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

function containsAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function getPromptSignals(promptText = '', contextText = '') {
  const combined = `${String(promptText || '').trim()}\n${String(contextText || '').trim()}`.trim();
  const lower = combined.toLowerCase();
  return {
    wantsObservation: containsAny(lower, [
      /화면/i,
      /screen/i,
      /screenshot/i,
      /image/i,
      /이미지/i,
      /캡처/i,
      /ocr/i,
      /보이는/i,
      /보여/i,
      /확인/i,
      /검증/i,
      /분석/i,
      /analysis/i,
      /what do you see/i,
      /현재 화면/i,
      /지금 화면/i,
    ]),
    wantsVisibleVerification: containsAny(lower, [
      /화면/i,
      /screen/i,
      /screenshot/i,
      /image/i,
      /이미지/i,
      /캡처/i,
      /ocr/i,
      /보이는/i,
      /보여/i,
      /확인/i,
      /검증/i,
      /결과/i,
      /result/i,
      /됐는지/i,
      /됐는가/i,
      /visible/i,
    ]),
  };
}

function inferPreferredBrowserUrl(prompt, lower) {
  const urlMatch = prompt.match(/https?:\/\/[^\s]+/i);
  if (urlMatch?.[0]) return urlMatch[0];

  const domainMatch = prompt.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co\.kr|kr|dev)\b/i);
  if (domainMatch?.[0]) return `https://${domainMatch[0]}`;

  if (/(?:네이버|naver)/i.test(lower)) return 'https://www.naver.com';
  if (/(?:다음|daum)/i.test(lower)) return 'https://www.daum.net';
  if (/(?:구글|google)/i.test(lower)) return 'https://www.google.com';
  if (/(?:유튜브|youtube)/i.test(lower)) return 'https://www.youtube.com';
  return '';
}

function inferControlActionsFromPrompt(promptText = '', contextText = '') {
  const prompt = String(promptText || '').trim();
  const context = String(contextText || '').trim();
  const combined = `${prompt}\n${context}`.trim();
  const lower = combined.toLowerCase();
  const promptSignals = getPromptSignals(prompt, context);
  const actions = [];

  const wantsChrome = containsAny(lower, [
    /chrome/i,
    /크롬/i,
    /브라우저/i,
    /browser/i,
    /네이버/i,
    /naver/i,
    /다음/i,
    /daum/i,
    /google/i,
    /youtube/i,
    /url/i,
  ]);
  const wantsZed = containsAny(lower, [/zed/i, /제드/i]);
  const wantsCursor = /cursor/i.test(lower);
  const wantsCodex = /codex/i.test(lower);
  const wantsSystemPane = containsAny(lower, [/권한/i, /permission/i, /privacy/i, /설정/i, /system settings/i, /automation/i, /accessibility/i]);
  const wantsClick = containsAny(lower, [/클릭/i, /눌러/i, /press/i, /click/i, /tap/i, /마우스/i, /버튼/i]);
  const wantsTyping = containsAny(lower, [/입력/i, /type/i, /검색/i, /search/i, /write/i, /타이핑/i, /엔터/i, /enter/i]);
  const wantsShell = containsAny(lower, [/cmd/i, /terminal/i, /터미널/i, /shell/i, /zsh/i, /bash/i, /명령/i, /실행/i, /조회/i, /리스트/i, /목록/i]);
  const wantsFolderListing = containsAny(lower, [/현재\s*폴더/i, /폴더\s*리스트/i, /디렉토리/i, /목록/i, /리스트/i, /ls\b/i]);
  const wantsPlusButton = containsAny(lower, [/\+\s*버튼/i, /plus\s*button/i, /new\s*terminal/i, /새\s*터미널/i, /prompt/i, /cmd\s*창/i, /cmd창/i]);
  const wantsBlogClick = containsAny(lower, [/블로그/i, /blog/i]);
  const browserUrl = inferPreferredBrowserUrl(prompt, lower);

  if (wantsChrome) {
    actions.push({ action: 'launch', app: 'Google Chrome' });
    if (browserUrl) {
      actions.push({ action: 'openUrl', app: 'Google Chrome', url: browserUrl });
    }
    if (wantsClick && wantsBlogClick) {
      actions.push({
        action: 'waitFor',
        timeoutMs: 1200,
        sleepMs: 1200,
        condition: { type: 'screenTextContains', text: '블로그' },
      });
      actions.push({
        action: 'clickText',
        app: 'Google Chrome',
        text: '블로그',
        strategy: 'hybrid',
        timeoutMs: 7000,
      });
    } else if (wantsTyping) {
      const typedTextMatch = prompt.match(/["“](.+?)["”]/);
      const typedText = typedTextMatch?.[1] || '';
      if (typedText) {
        actions.push({ action: 'waitFor', timeoutMs: 600, sleepMs: 600 });
        actions.push({ action: 'type', app: 'Google Chrome', text: typedText });
      }
    }
  }

  if (wantsZed) {
    actions.push({ action: 'launch', app: 'Zed' });
    actions.push({ action: 'focus', app: 'Zed' });
    actions.push({
      action: 'waitFor',
      timeoutMs: 2500,
      sleepMs: 250,
      condition: { type: 'frontmostApp', app: 'Zed' },
    });
    if (wantsPlusButton || wantsShell) {
      actions.push({
        action: 'clickUi',
        app: 'Zed',
        target: {
          text: '+',
          role: 'button',
          strategy: 'ax',
        },
      });
      actions.push({
        action: 'waitFor',
        timeoutMs: 2000,
        sleepMs: 250,
        condition: { type: 'screenTextContains', text: 'zsh' },
      });
      actions.push({
        action: 'clickUi',
        app: 'Zed',
        target: {
          text: 'zsh',
          role: 'button',
          strategy: 'ax',
        },
      });
    }
    if (wantsShell && wantsFolderListing) {
      const command = containsAny(lower, [/pwd/i]) ? 'pwd && ls -la' : 'ls -la';
      actions.push({
        action: 'runShell',
        app: 'Zed',
        command,
        inFocusedTerminal: true,
      });
      actions.push({
        action: 'verify',
        type: promptSignals.wantsVisibleVerification ? 'terminalOutputVisible' : 'shell',
        command,
      });
    }
  }

  if (wantsCursor) {
    actions.push({ action: 'launch', app: 'Cursor' });
  }

  if (wantsCodex) {
    actions.push({ action: 'launch', app: 'Codex' });
  }

  if (wantsSystemPane) {
    const pane = /accessibility/i.test(lower) ? 'accessibility' : /screen/i.test(lower) ? 'screenrecording' : /files/i.test(lower) ? 'filesandfolders' : 'automation';
    actions.push({ action: 'openSystemPane', pane });
  }

  return actions;
}

function inferControlPlan(promptText, contextText = '') {
  const prompt = String(promptText || '').trim();
  const lower = prompt.toLowerCase();
  const actions = inferControlActionsFromPrompt(prompt, contextText);

  if (!actions.length) {
    const inferredUrl = inferPreferredBrowserUrl(prompt, lower);
    if (inferredUrl) {
      actions.push({ action: 'launch', app: 'Google Chrome' });
      actions.push({ action: 'openUrl', app: 'Google Chrome', url: inferredUrl });
    }
  }

  if (!actions.length) {
    actions.push({ action: 'probe' });
  }

  return {
    summary: prompt || 'computer use task',
    actions,
  };
}

function describePlannerAction(action = {}) {
  const label = String(action.action || 'action').trim();
  const app = action.app ? ` @ ${action.app}` : '';
  if (label === 'openUrl') return `${label}${app} ${action.url || ''}`.trim();
  if (label === 'clickText') return `${label}${app} "${action.text || ''}"`.trim();
  if (label === 'clickUi') return `${label}${app} "${action.target?.text || action.text || ''}"`.trim();
  if (label === 'runShell') return `${label}${app} ${action.command || ''}`.trim();
  if (label === 'waitFor') return `${label} ${action.condition?.type || action.condition?.app || ''}`.trim();
  if (label === 'verify') return `${label} ${action.type || action.verify || ''}`.trim();
  return `${label}${app}`.trim();
}

function serializeTraceForPlanner(executionTrace = []) {
  return executionTrace.slice(-8).map((entry) => ({
    step: entry.step,
    action: describePlannerAction(entry.action),
    ok: entry.ok,
    elapsedMs: entry.elapsedMs,
    result: {
      action: entry.result?.action || '',
      error: entry.result?.error || '',
      stdout: String(entry.result?.stdout || '').slice(0, 200),
      stderr: String(entry.result?.stderr || '').slice(0, 200),
      strategyUsed: entry.strategyUsed || '',
      fallbackUsed: entry.fallbackUsed || '',
    },
  }));
}

function buildControlEvidence({
  plan = {},
  requestRecord = null,
  executionResults = null,
  executionTrace = [],
  finalStatus = '',
  failedStep = null,
  repairRounds = 0,
  queued = false,
} = {}) {
  const trace = Array.isArray(executionTrace) && executionTrace.length
    ? executionTrace
    : Array.isArray(executionResults?.executionTrace)
      ? executionResults.executionTrace
      : [];

  const captures = trace.flatMap((entry) => {
    const screenshot = entry?.result?.screenshot;
    if (!screenshot) return [];
    return [{
      step: entry.step,
      round: entry.round,
      ok: entry.ok,
      action: entry.action ? { ...entry.action } : entry.action,
      elapsedMs: entry.elapsedMs,
      strategyUsed: entry.strategyUsed || '',
      fallbackUsed: entry.fallbackUsed || '',
      observedText: entry.result?.observedText || '',
      screenshot: { ...screenshot },
      ocr: entry.result?.ocr ? { ...entry.result.ocr } : null,
    }];
  });

  const terminalTrace = [...trace].reverse().find((entry) => {
    const actionName = String(entry?.action?.action || '').toLowerCase();
    const verifyType = String(entry?.action?.type || entry?.action?.verify || '').toLowerCase();
    return actionName === 'runshell' || (actionName === 'verify' && ['terminaloutputvisible', 'terminalvisible', 'shellvisible'].includes(verifyType));
  }) || [...trace].reverse().find((entry) => {
    const stdout = String(entry?.result?.stdout || '').trim();
    const stderr = String(entry?.result?.stderr || '').trim();
    const observedText = String(entry?.result?.observedText || '').trim();
    return Boolean(stdout || stderr || observedText);
  }) || null;

  const verifyTrace = [...trace].reverse().find((entry) => String(entry?.action?.action || '').toLowerCase() === 'verify') || terminalTrace;

  return {
    summary: plan?.summary || requestRecord?.summary || '',
    finalStatus: finalStatus || executionResults?.finalStatus || (queued ? 'queued' : 'completed'),
    repairRounds: Number(repairRounds || executionResults?.repairRounds || 0),
    failedStep: failedStep || executionResults?.failedStep || null,
    requestId: requestRecord?.id || requestRecord?.requestId || '',
    queued: Boolean(queued),
    executionTrace: trace,
    captures,
    terminal: terminalTrace ? {
      step: terminalTrace.step,
      round: terminalTrace.round,
      ok: terminalTrace.ok,
      action: terminalTrace.action ? { ...terminalTrace.action } : terminalTrace.action,
      elapsedMs: terminalTrace.elapsedMs,
      strategyUsed: terminalTrace.strategyUsed || '',
      fallbackUsed: terminalTrace.fallbackUsed || '',
      command: terminalTrace.action?.command || terminalTrace.result?.command || '',
      output: terminalTrace.result?.stdout || terminalTrace.result?.observedText || terminalTrace.result?.stderr || '',
      observedText: terminalTrace.result?.observedText || '',
      screenshot: terminalTrace.result?.screenshot ? { ...terminalTrace.result.screenshot } : null,
      ocr: terminalTrace.result?.ocr ? { ...terminalTrace.result.ocr } : null,
    } : null,
    verify: verifyTrace ? {
      step: verifyTrace.step,
      round: verifyTrace.round,
      ok: verifyTrace.ok,
      action: verifyTrace.action ? { ...verifyTrace.action } : verifyTrace.action,
      elapsedMs: verifyTrace.elapsedMs,
      strategyUsed: verifyTrace.strategyUsed || '',
      fallbackUsed: verifyTrace.fallbackUsed || '',
      type: verifyTrace.action?.type || verifyTrace.action?.verify || '',
      state: verifyTrace.result?.state || '',
      command: verifyTrace.action?.command || '',
      observedText: verifyTrace.result?.observedText || '',
      matchedToken: verifyTrace.result?.matchedToken || '',
      screenshot: verifyTrace.result?.screenshot ? { ...verifyTrace.result.screenshot } : null,
      ocr: verifyTrace.result?.ocr ? { ...verifyTrace.result.ocr } : null,
      tokens: Array.isArray(verifyTrace.result?.tokens) ? [...verifyTrace.result.tokens] : [],
    } : null,
  };
}

function buildHeuristicRepairPlan({ task = '', plan = {}, failedStep = null, observations = '' } = {}) {
  const failedAction = failedStep?.action || {};
  const failedType = String(failedAction.action || '').toLowerCase();
  const app = String(failedAction.app || failedAction.target?.app || '').trim();
  const targetText = String(failedAction.target?.text || failedAction.text || '').trim();
  const command = String(failedAction.command || failedAction.script || '').trim();
  const repairActions = [];

  if (app) {
    repairActions.push({ action: 'focus', app });
    repairActions.push({
      action: 'waitFor',
      timeoutMs: 2000,
      sleepMs: 250,
      condition: { type: 'frontmostApp', app },
    });
  }

  if (failedType === 'clickui' || failedType === 'clicktext') {
    repairActions.push({
      action: 'clickUi',
      app: app || failedAction.app || '',
      target: {
        text: targetText || failedAction.text || '',
        role: failedAction.target?.role || '',
        strategy: 'hybrid',
      },
    });
  } else if (failedType === 'runshell' && command) {
    repairActions.push({
      action: 'runShell',
      app: app || failedAction.app || '',
      command,
      inFocusedTerminal: true,
    });
  } else if (failedType === 'verify') {
    const verifyType = String(failedAction.type || failedAction.verify || '').toLowerCase();
    if ((verifyType === 'shell' || verifyType === 'terminaloutputvisible' || verifyType === 'terminalvisible' || verifyType === 'shellvisible') && command) {
      repairActions.push({
        action: 'runShell',
        app: app || failedAction.app || '',
        command,
        inFocusedTerminal: true,
      });
      repairActions.push({
        action: 'verify',
        type: verifyType === 'shell' ? 'shell' : 'terminalOutputVisible',
        command,
      });
    } else if (verifyType === 'screentextcontains' && targetText) {
      repairActions.push({
        action: 'waitFor',
        timeoutMs: 2000,
        sleepMs: 250,
        condition: { type: 'screenTextContains', text: targetText },
      });
    }
  }

  if (!repairActions.length) {
    repairActions.push({ action: 'probe' });
  }

  return {
    summary: `${plan?.summary || task || 'computer use task'} - repair`,
    actions: repairActions,
    observations,
  };
}

async function buildRepairPlan({ task = '', contextText = '', plan = {}, failedStep = null, executionTrace = [] } = {}) {
  const probe = await probeAutomation().catch(() => null);
  const screenText = String(probe?.screenRecording?.text || '').trim();
  const observations = [
    `Task: ${task || plan?.summary || 'computer use task'}`,
    `Failed step: ${describePlannerAction(failedStep?.action || {})}`,
    `Failure: ${failedStep?.result?.error || failedStep?.result?.stderr || failedStep?.result?.stdout || 'unknown'}`,
    probe?.frontmost?.ok ? `Frontmost: ${probe.frontmost.stdout || probe.frontmost.app || ''}` : '',
    probe?.screenRecording?.path ? `Screenshot: ${probe.screenRecording.path}` : '',
    screenText ? `Screen OCR: ${screenText.slice(0, 1500)}` : '',
    contextText ? `Context: ${contextText}` : '',
  ].filter(Boolean).join('\n');

  const heuristicPlan = buildHeuristicRepairPlan({ task, plan, failedStep, observations });
  const systemPrompt = [
    'You are OpenHermes computer-use repair planner.',
    'Return a compact JSON object only.',
    'No markdown, no prose, no code fences.',
    'Use the provided observations to produce the smallest corrective action sequence that can recover from the failure.',
    'Prefer frontmost app checks, UI re-focus, or alternative click strategies before retrying a command.',
    'Always end with a verification action when it helps confirm success.',
    'Schema: {"summary":"...", "actions":[{"action":"launch|focus|openUrl|waitFor|clickUi|clickText|clickCoordinates|type|press|shortcut|runShell|verify|clickMenuItem|openSystemPane|probe|activateWindow","app":"...","url":"...","text":"...","pane":"...","command":"...","inFocusedTerminal":true,"timeoutMs":1000,"sleepMs":1000,"target":{"text":"...","role":"...","selector":"...","coords":{"x":0,"y":0}},"shortcut":{"key":"...","modifiers":["command","shift"]},"menuPath":{"menu":"...","item":"...","subItem":"..."},"selectorOrCoords":{"x":0,"y":0},"condition":{"type":"frontmostApp|windowTitleContains|screenTextContains|appRunning|shell","app":"...","text":"...","command":"..."}}]}\nUse verify type \"terminalOutputVisible\" when the command output must be confirmed on screen.',
  ].join(' ');

  const response = await forwardChat({
    stream: false,
    temperature: 0,
    max_tokens: 512,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          `Task: ${task || plan?.summary || 'computer use task'}`,
          `Original plan: ${JSON.stringify(plan, null, 2)}`,
          `Failed step: ${JSON.stringify(failedStep || {}, null, 2)}`,
          `Trace: ${JSON.stringify(serializeTraceForPlanner(executionTrace), null, 2)}`,
          `Observations:\n${observations}`,
        ].join('\n\n'),
      },
    ],
  });

  const bodyText = await response.text();
  if (!response.ok) {
    return heuristicPlan;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(extractJsonBlock(bodyText) || bodyText);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.actions) || !parsed.actions.length) {
    return heuristicPlan;
  }

  if (!parsed.summary) {
    parsed.summary = heuristicPlan.summary;
  }

  parsed.observations = observations;
  return parsed;
}

async function buildControlPlan(promptText, contextText = '') {
  const heuristicPlan = inferControlPlan(promptText, contextText);
  if (heuristicPlan.actions.some((action) => action.action !== 'probe')) {
    return heuristicPlan;
  }

  const promptSignals = getPromptSignals(promptText, contextText);
  const probe = promptSignals.wantsObservation || promptSignals.wantsVisibleVerification
    ? await probeAutomation().catch(() => null)
    : null;
  const screenText = String(probe?.screenRecording?.text || '').trim();

  const systemPrompt = [
    'You are OpenHermes computer-use planner.',
    'Convert the user request into a compact JSON object only.',
    'No markdown, no prose, no code fences.',
    'Use the current screen observations to decide the next action instead of stopping at app launch.',
    'If the request asks to inspect a screen, image, terminal output, or whether something worked, include screenshot/OCR-based verification.',
    'For Zed or terminal tasks, do not stop at launch: focus the app, open the terminal/pane if needed, run the command, and verify the output is visible.',
    'Schema: {"summary":"...", "actions":[{"action":"launch|focus|openUrl|waitFor|clickUi|clickText|clickCoordinates|type|press|shortcut|runShell|verify|clickMenuItem|openSystemPane|probe|activateWindow", "app":"...", "url":"...", "text":"...", "pane":"...", "command":"...", "inFocusedTerminal":true, "timeoutMs":1000, "sleepMs":1000, "target":{"text":"...","role":"...","selector":"...","coords":{"x":0,"y":0}}, "shortcut":{"key":"...","modifiers":["command","shift"]}, "menuPath":{"menu":"...","item":"...","subItem":"..."}, "selectorOrCoords":{"x":0,"y":0}, "condition":{"type":"frontmostApp|windowTitleContains|screenTextContains|appRunning|shell","app":"...","text":"...","command":"..."}}]}\nUse verify type "terminalOutputVisible" when the command output must be confirmed on screen.',
    'Use Chrome for web requests when a browser is requested.',
    'Use clickText or clickUi for button or link clicks in browser and app UIs.',
    'Use runShell with inFocusedTerminal=true for terminal pane commands in editors such as Zed.',
    'Use verify type "terminalOutputVisible" when you need to confirm that terminal output appears on screen, not just that the command is valid.',
    'Prefer the smallest action sequence that achieves the goal.',
    'If the request cannot be safely executed, return {"summary":"...", "actions":[{"action":"probe"}]}.',
  ].join(' ');

  const heuristicSummary = Array.isArray(heuristicPlan.actions)
    ? heuristicPlan.actions.map((action) => describePlannerAction(action)).join(' -> ')
    : '';
  const observations = [
    `Request: ${promptText}`,
    contextText ? `Context: ${contextText}` : '',
    heuristicSummary ? `Heuristic plan: ${heuristicSummary}` : '',
    probe?.frontmost?.ok ? `Frontmost: ${probe.frontmost.stdout || probe.frontmost.app || ''}` : '',
    probe?.screenRecording?.path ? `Screenshot: ${probe.screenRecording.path}` : '',
    screenText ? `OCR: ${screenText.slice(0, 800)}` : '',
  ].filter(Boolean).join('\n');

  const response = await forwardChat({
    stream: false,
    temperature: 0,
    max_tokens: 256,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: observations,
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

  const scoreAction = (action = {}) => {
    const name = String(action.action || '').toLowerCase();
    return ({
      launch: 1,
      focus: 1,
      openurl: 2,
      waitfor: 1,
      clickui: 3,
      clicktext: 3,
      clickcoordinates: 2,
      type: 3,
      shortcut: 3,
      runshell: 4,
      verify: 4,
      clickmenuitem: 3,
      opensystempane: 2,
      probe: 2,
      activatewindow: 1,
    }[name] || 1);
  };

  const scorePlan = (plan = {}) => Array.isArray(plan.actions)
    ? plan.actions.reduce((total, action) => total + scoreAction(action), 0)
    : 0;
  const selectedPlan = scorePlan(parsed) >= scorePlan(heuristicPlan) ? parsed : heuristicPlan;

  if (promptSignals.wantsVisibleVerification && Array.isArray(selectedPlan.actions)) {
    for (const action of selectedPlan.actions) {
      if (String(action.action || '').toLowerCase() === 'verify') {
        const verifyType = String(action.type || action.verify || '').toLowerCase();
        if (verifyType === 'shell' && String(action.command || '').trim()) {
          action.type = 'terminalOutputVisible';
        }
      }
    }
  }

  selectedPlan.observations = observations;
  return selectedPlan;
}

async function executeControlPlan(plan, options = {}) {
  const results = [];
  const executionTrace = [];
  const task = String(options.task || plan?.summary || '').trim();
  const contextText = String(options.contextText || options.context || '').trim();
  const maxRepairRounds = Math.max(0, Number(options.maxRepairRounds ?? 2));
  const allowRepair = options.allowRepair !== false;
  let currentPlan = plan;
  let finalStatus = 'noop';
  let failedStep = null;
  let repairRounds = 0;

  for (let round = 0; round <= maxRepairRounds; round += 1) {
    const actions = Array.isArray(currentPlan?.actions) ? currentPlan.actions : [];
    if (!actions.length) {
      finalStatus = 'noop';
      break;
    }

    let roundFailed = null;
    for (const action of actions) {
      const startedAt = Date.now();
      const result = await executeAutomationAction(action);
      const traceEntry = {
        step: results.length + 1,
        round,
        action,
        result,
        ok: result?.ok !== false,
        elapsedMs: Date.now() - startedAt,
        strategyUsed: result?.strategyUsed || result?.mode || '',
        fallbackUsed: result?.fallbackUsed || '',
      };
      results.push({ action, result, round });
      executionTrace.push(traceEntry);
      if (result?.ok === false) {
        roundFailed = traceEntry;
        failedStep = traceEntry;
        break;
      }
    }

    if (!roundFailed) {
      finalStatus = results.length ? 'completed' : 'noop';
      break;
    }

    if (!allowRepair || round >= maxRepairRounds) {
      finalStatus = 'failed';
      break;
    }

    repairRounds += 1;
    const repairPlan = await buildRepairPlan({
      task,
      contextText,
      plan: currentPlan,
      failedStep: roundFailed,
      executionTrace,
    });
    executionTrace.push({
      step: `${round + 1}.repair`,
      round,
      action: {
        action: 'repairPlan',
        summary: repairPlan.summary,
      },
      result: {
        ok: true,
        action: 'repairPlan',
        plan: repairPlan,
      },
      ok: true,
      elapsedMs: 0,
      strategyUsed: 'repair',
    });
    currentPlan = repairPlan;
  }

  results.executionTrace = executionTrace;
  results.finalStatus = finalStatus;
  results.failedStep = failedStep;
  results.repairRounds = repairRounds;
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

function readGitHubText(body) {
  const candidates = [
    body.comment?.body,
    body.issue?.title,
    body.issue?.body,
    body.pull_request?.title,
    body.pull_request?.body,
    body.workflow_job?.name,
    body.repository?.full_name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function isApprovalRequired() {
  return ['required', 'queue', 'pending'].includes(String(approvalMode || 'direct').toLowerCase());
}

function isLocalFastPath(auth) {
  return localFastPathEnabled && Boolean(auth?.loopback);
}

async function loadRequestRecord(id) {
  return getQueuedRequest(requestStorePath, id);
}

async function persistRequestRecord(updaterOrPatch, id) {
  return updateQueuedRequest(requestStorePath, id, updaterOrPatch);
}

function makeQueueResponse(requestRecord, plan, extra = {}) {
  return {
    ok: true,
    queued: true,
    executed: false,
    summary: plan?.summary || requestRecord?.summary || 'pending approval',
    plan,
    request: requestRecord,
    evidence: extra.evidence || buildControlEvidence({
      plan,
      requestRecord,
      queued: true,
    }),
    ...extra,
  };
}

function makeExecutionResponse(requestRecord, plan, executionResults = [], extra = {}) {
  return {
    ok: true,
    queued: false,
    executed: true,
    summary: plan?.summary || requestRecord?.summary || 'executed',
    plan,
    request: requestRecord,
    executionResults,
    executionTrace: extra.executionTrace || executionResults.executionTrace || [],
    finalStatus: extra.finalStatus || executionResults.finalStatus || 'completed',
    failedStep: extra.failedStep || executionResults.failedStep || null,
    repairRounds: extra.repairRounds || executionResults.repairRounds || 0,
    executionSummary: summarizeExecutionResults(executionResults),
    evidence: extra.evidence || buildControlEvidence({
      plan,
      requestRecord,
      executionResults,
      executionTrace: extra.executionTrace || executionResults.executionTrace || [],
      finalStatus: extra.finalStatus || executionResults.finalStatus || 'completed',
      failedStep: extra.failedStep || executionResults.failedStep || null,
      repairRounds: extra.repairRounds || executionResults.repairRounds || 0,
    }),
    ...extra,
  };
}

async function queueControlRequest({
  source,
  task,
  body = {},
  auth = null,
  channel = '',
  sourceLabel = '',
  reply = '',
}) {
  const plan = await buildControlPlan(task, body.context || '');
  const requestRecord = await createQueuedRequest(requestStorePath, {
    kind: 'control',
    source,
    sourceLabel: sourceLabel || source,
    channel,
    summary: plan.summary,
    task,
    plan,
    payload: body,
    reply,
    approvalRequired: true,
    executionMode: 'queued',
    evidence: buildControlEvidence({ plan, queued: true }),
    auth: auth ? { required: auth.required, mode: auth.mode, loopback: auth.loopback, remoteAddress: auth.remoteAddress } : null,
  });
  return { plan, requestRecord };
}

async function executeControlRequest({
  source,
  task,
  body = {},
  auth = null,
  channel = '',
  sourceLabel = '',
  reply = '',
}) {
  const plan = await buildControlPlan(task, body.context || '');
  const executionResults = await executeControlPlan(plan, { task, contextText: body.context || '' });
  const now = new Date().toISOString();
  const requestRecord = await createQueuedRequest(requestStorePath, {
    kind: 'control',
    source,
    sourceLabel: sourceLabel || source,
    channel,
    summary: plan.summary,
    task,
    plan,
    payload: body,
    reply,
    approvalRequired: false,
    executionMode: 'direct',
    status: 'executed',
    executedAt: now,
    executionResults,
    executionTrace: executionResults.executionTrace || [],
    finalStatus: executionResults.finalStatus || 'completed',
    failedStep: executionResults.failedStep || null,
    repairRounds: executionResults.repairRounds || 0,
    executionSummary: summarizeExecutionResults(executionResults),
    executionError: '',
    evidence: buildControlEvidence({
      plan,
      executionResults,
      executionTrace: executionResults.executionTrace || [],
      finalStatus: executionResults.finalStatus || 'completed',
      failedStep: executionResults.failedStep || null,
      repairRounds: executionResults.repairRounds || 0,
    }),
    auth: auth ? { required: auth.required, mode: auth.mode, loopback: auth.loopback, remoteAddress: auth.remoteAddress } : null,
  });
  return {
    plan,
    requestRecord,
    executionResults,
    executionTrace: executionResults.executionTrace || [],
    finalStatus: executionResults.finalStatus || 'completed',
    failedStep: executionResults.failedStep || null,
    repairRounds: executionResults.repairRounds || 0,
  };
}

async function autoExecutePendingRequestsOnBoot() {
  if (isApprovalRequired()) {
    return;
  }
  const pendingRequests = await listQueuedRequests(requestStorePath, { status: 'pending', limit: 100 });
  for (const pending of pendingRequests) {
    const executionMode = 'direct';
    await updateQueuedRequest(requestStorePath, pending.id, (record) => ({
      ...record,
      status: 'executing',
      executionMode,
      executionStartedAt: new Date().toISOString(),
      executionError: '',
    })).catch(() => null);

    try {
      const plan = pending.plan || await buildControlPlan(pending.task || pending.summary || '', pending.payload?.context || '');
      const executionResults = await executeControlPlan(plan, { task: pending.task || pending.summary || '', contextText: pending.payload?.context || '' });
      await updateQueuedRequest(requestStorePath, pending.id, (record) => ({
        ...record,
        status: 'executed',
        executionMode,
        executedAt: new Date().toISOString(),
        plan,
        executionResults,
        executionTrace: executionResults.executionTrace || [],
        finalStatus: executionResults.finalStatus || 'completed',
        failedStep: executionResults.failedStep || null,
        repairRounds: executionResults.repairRounds || 0,
        executionSummary: summarizeExecutionResults(executionResults),
        executionError: '',
      })).catch(() => null);
      await audit('requests.autoexecuted', { method: 'BOOT', url: '/boot', headers: {} }, {
        requestId: pending.id,
        source: pending.source,
        channel: pending.channel,
        plan,
        executionResults,
      });
    } catch (error) {
      await updateQueuedRequest(requestStorePath, pending.id, (record) => ({
        ...record,
        status: 'failed',
        executionMode,
        executionError: error.message || String(error),
        failedAt: new Date().toISOString(),
      })).catch(() => null);
      await audit('requests.autoexecute.error', { method: 'BOOT', url: '/boot', headers: {} }, {
        requestId: pending.id,
        error: error.message || String(error),
      });
    }
  }
}

function buildApprovalMeta(auth = null, body = {}) {
  const meta = {
    approvedAt: new Date().toISOString(),
    approvedReason: String(body.reason || body.note || '').trim() || 'approved via api',
  };
  if (auth) {
    meta.approvedBy = {
      required: Boolean(auth.required),
      mode: auth.mode,
      loopback: Boolean(auth.loopback),
      remoteAddress: auth.remoteAddress || '',
    };
  }
  return meta;
}

function summarizeExecutionResults(executionResults = []) {
  if (!Array.isArray(executionResults) || !executionResults.length) {
    return 'no actions executed';
  }
  return executionResults
    .map(({ action, result }) => {
      const label = action?.action || action?.app || action?.pane || 'action';
      const ok = result?.ok === false ? 'failed' : 'ok';
      return `${label}:${ok}`;
    })
    .join(', ');
}

async function approveQueuedRequest(requestId, { request = null, auth = null, body = {} } = {}) {
  const current = await loadRequestRecord(requestId);
  if (!current) {
    return null;
  }

  const approvalMeta = buildApprovalMeta(auth, body);
  const approved = await persistRequestRecord((record) => ({
    ...record,
    status: 'approved',
    approvalRequired: true,
    ...approvalMeta,
  }), requestId);

  const plan = approved.plan || await buildControlPlan(approved.task || approved.summary || '', approved.payload?.context || '');
  const executionResults = await executeControlPlan(plan, { task: approved.task || approved.summary || '', contextText: approved.payload?.context || '' });
  const executed = await persistRequestRecord((record) => ({
    ...record,
    status: 'executed',
    approvalRequired: true,
    executedAt: new Date().toISOString(),
    plan,
    executionResults,
    executionTrace: executionResults.executionTrace || [],
    finalStatus: executionResults.finalStatus || 'completed',
    failedStep: executionResults.failedStep || null,
    repairRounds: executionResults.repairRounds || 0,
    executionSummary: summarizeExecutionResults(executionResults),
    executionError: '',
  }), requestId);

  if (executed.reply) {
    const replyText = [
      `요청이 승인되어 실행되었습니다. requestId=${executed.id}`,
      `summary=${executed.summary || plan.summary || 'control task'}`,
      `results=${executed.executionSummary || summarizeExecutionResults(executionResults)}`,
    ].join('\n');
    await sendWebhookReply(executed.reply, replyText);
  }

  await audit('requests.approved', request || { method: 'POST', url: `/api/requests/${requestId}/approve`, headers: {} }, {
    requestId,
    plan,
    executionResults,
    request: executed,
  });

  return { requestRecord: executed, plan, executionResults };
}

async function rejectQueuedRequest(requestId, { request = null, auth = null, body = {} } = {}) {
  const current = await loadRequestRecord(requestId);
  if (!current) {
    return null;
  }

  const rejected = await persistRequestRecord((record) => ({
    ...record,
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    rejectionReason: String(body.reason || body.note || '').trim() || 'rejected via api',
    rejectedBy: auth ? {
      required: Boolean(auth.required),
      mode: auth.mode,
      loopback: Boolean(auth.loopback),
      remoteAddress: auth.remoteAddress || '',
    } : null,
  }), requestId);

  await audit('requests.rejected', request || { method: 'POST', url: `/api/requests/${requestId}/reject`, headers: {} }, {
    requestId,
    request: rejected,
  });

  return rejected;
}

function normalizeWebhookText(body = {}) {
  if (typeof body.text === 'string' && body.text.trim()) return body.text.trim();
  if (typeof body.command === 'string' && body.command.trim()) return body.command.trim();
  if (typeof body.content === 'string' && body.content.trim()) return body.content.trim();
  if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  if (typeof body.challenge === 'string' && body.challenge.trim()) return body.challenge.trim();
  if (typeof body.event?.text === 'string' && body.event.text.trim()) return body.event.text.trim();
  if (typeof body.comment?.body === 'string' && body.comment.body.trim()) return body.comment.body.trim();
  if (typeof body.issue?.title === 'string' && body.issue.title.trim()) return body.issue.title.trim();
  if (typeof body.issue?.body === 'string' && body.issue.body.trim()) return body.issue.body.trim();
  return '';
}

function looksLikeRemoteControlRequest(text) {
  return /(?:열어|켜|실행|launch|open|focus|visit|방문|시작|클릭|누르|입력|타이핑|검색|엔터|run|chrome|크롬|cursor|codex|zed|github|설정|권한|permission|privacy|daum|naver|google|youtube|blog|블로그|terminal|cmd|zsh|url|https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|io|co\.kr|kr|dev))/i.test(String(text || ''));
}

function hmacSha256(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

function verifyGithubWebhook(request, rawBody) {
  if (!process.env.OPENHERMES_GITHUB_WEBHOOK_SECRET) {
    return { ok: true, required: false };
  }
  const provided = String(request.headers['x-hub-signature-256'] || request.headers['x-hub-signature'] || '').trim();
  if (!provided) {
    return { ok: false, required: true, reason: 'missing_github_signature' };
  }
  const digestShort = hmacSha256(process.env.OPENHERMES_GITHUB_WEBHOOK_SECRET, rawBody);
  const candidate = provided.startsWith('sha256=') ? provided.slice('sha256='.length) : provided;
  const expected = Buffer.from(digestShort, 'hex');
  const actual = Buffer.from(candidate, 'hex');
  if (expected.length === 0 || actual.length === 0) {
    return { ok: false, required: true, reason: 'invalid_github_signature' };
  }
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, required: true, reason: 'invalid_github_signature' };
  }
  return { ok: true, required: true };
}

function verifySharedWebhookSecret(request, body, envSecret, headerName) {
  if (!envSecret) {
    return { ok: true, required: false };
  }
  const provided = String(request.headers[headerName] || body.secret || body.token || '').trim();
  if (!provided) {
    return { ok: false, required: true, reason: 'missing_webhook_secret' };
  }
  if (provided !== envSecret) {
    return { ok: false, required: true, reason: 'invalid_webhook_secret' };
  }
  return { ok: true, required: true };
}

function isGitHubQueueRequest(body) {
  const action = String(body.action || '').toLowerCase();
  const text = normalizeWebhookText(body);
  return Boolean(text && ['created', 'edited', 'opened', 'reopened', 'submitted'].includes(action)) || Boolean(text && looksLikeRemoteControlRequest(text));
}

async function listRequestsFromQuery(url) {
  const limit = Number(url.searchParams.get('limit') || '50');
  const status = String(url.searchParams.get('status') || '').trim();
  const items = await listQueuedRequests(requestStorePath, {
    status: status || '',
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return items;
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
    url.pathname.startsWith('/api/audit') ||
    url.pathname.startsWith('/api/requests');

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

  if (request.method === 'GET' && url.pathname === '/api/requests') {
    try {
      const requests = await listRequestsFromQuery(url);
      await audit('requests.list', request, {
        count: requests.length,
        status: url.searchParams.get('status') || '',
      });
      sendJson(response, 200, {
        ok: true,
        requests,
        storePath: requestStorePath,
      }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('requests.list.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/requests/')) {
    try {
      const id = url.pathname.split('/').filter(Boolean)[2] || '';
      const requestRecord = await loadRequestRecord(id);
      if (!requestRecord) {
        sendJson(response, 404, { ok: false, error: 'request_not_found' }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      sendJson(response, 200, { ok: true, request: requestRecord }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('requests.get.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/requests') {
    try {
      const { body, auth } = await readAuthAndBody(request, url);
      const task = String(body.task || body.prompt || body.message || body.text || '').trim();
      if (!task) {
        sendJson(response, 400, { ok: false, error: 'missing_task' }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }

      const source = String(body.source || 'api.requests').trim() || 'api.requests';
      const channel = String(body.channel || 'api').trim() || 'api';
      const sourceLabel = String(body.sourceLabel || source).trim() || source;
      const { plan, requestRecord, executionResults } = await executeControlRequest({
        source,
        task,
        body,
        auth,
        channel,
        sourceLabel,
        reply: body.reply || body.reply_url || body.response_url || '',
      });
      const payload = makeExecutionResponse(requestRecord, plan, executionResults, {
        auth,
        approvalRequired: false,
        executionMode: 'direct',
      });
      await audit('requests.create', request, {
        requestId: requestRecord.id,
        source,
        channel,
        task,
        plan,
      });
      sendJson(response, 201, payload, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('requests.create.error', request, { error: error.message || String(error) });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/requests/') && url.pathname.endsWith('/approve')) {
    try {
      const { body, auth } = await readAuthAndBody(request, url);
      const id = url.pathname.split('/').filter(Boolean)[2] || '';
      const current = await loadRequestRecord(id);
      if (!current) {
        sendJson(response, 404, { ok: false, error: 'request_not_found' }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      if (current.status === 'executed') {
        sendJson(response, 200, {
          ok: true,
          alreadyExecuted: true,
          request: current,
          plan: current.plan || null,
          executionResults: current.executionResults || [],
        }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }

      const result = await approveQueuedRequest(id, { request, auth, body });
      if (!result) {
        sendJson(response, 404, { ok: false, error: 'request_not_found' }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        request: result.requestRecord,
        plan: result.plan,
        executionResults: result.executionResults,
      }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      const id = url.pathname.split('/').filter(Boolean)[2] || '';
      await persistRequestRecord((record) => ({
        ...record,
        status: 'failed',
        executionError: error.message || String(error),
        failedAt: new Date().toISOString(),
      }), id).catch(() => null);
      await audit('requests.approve.error', request, { error: error.message || String(error), requestId: id });
      sendJson(response, 500, { ok: false, error: error.message || String(error) }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/requests/') && url.pathname.endsWith('/reject')) {
    try {
      const { body, auth } = await readAuthAndBody(request, url);
      const id = url.pathname.split('/').filter(Boolean)[2] || '';
      const rejected = await rejectQueuedRequest(id, { request, auth, body });
      if (!rejected) {
        sendJson(response, 404, { ok: false, error: 'request_not_found' }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        request: rejected,
      }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('requests.reject.error', request, { error: error.message || String(error) });
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
      const approvalRequired = isApprovalRequired() && !isLocalFastPath(auth);
      if (!previewOnly && approvalRequired) {
        const { requestRecord } = await queueControlRequest({
          source: 'api.control',
          task,
          body,
          auth,
          channel: 'api',
          sourceLabel: 'api.control',
          reply: body.reply || body.reply_url || body.response_url || '',
        });
        const payload = makeQueueResponse(requestRecord, plan, {
          auth,
          approvalRequired: true,
          executionMode: 'queued',
        });
        await audit('control.task.queued', request, {
          task,
          plan,
          requestId: requestRecord.id,
          source: 'api.control',
        });
        sendJson(response, 202, payload, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      let executionResults = [];
      let executionTrace = [];
      let finalStatus = previewOnly ? 'preview' : 'completed';
      let failedStep = null;
      let requestRecord = null;
      if (!previewOnly) {
        executionResults = await executeControlPlan(plan, { task, contextText: body.context || '' });
        executionTrace = executionResults.executionTrace || [];
        finalStatus = executionResults.finalStatus || 'completed';
        failedStep = executionResults.failedStep || null;
        requestRecord = await createQueuedRequest(requestStorePath, {
          kind: 'control',
          source: 'api.control',
          sourceLabel: 'api.control',
          channel: 'api',
          summary: plan.summary,
          task,
          plan,
          payload: body,
          reply: body.reply || body.reply_url || body.response_url || '',
          approvalRequired: false,
          executionMode: 'direct',
          status: 'executed',
          executedAt: new Date().toISOString(),
          executionResults,
          executionTrace,
          finalStatus,
          failedStep,
          executionSummary: summarizeExecutionResults(executionResults),
          executionError: '',
          auth: auth ? { required: auth.required, mode: auth.mode, loopback: auth.loopback, remoteAddress: auth.remoteAddress } : null,
        });
      }
      const payload = {
        ok: true,
        summary: plan.summary,
        plan,
        executed: !previewOnly,
        queued: false,
        approvalRequired: false,
        results: executionResults,
        executionTrace,
        finalStatus,
        failedStep,
        repairRounds: executionResults.repairRounds || 0,
        evidence: buildControlEvidence({
          plan,
          requestRecord,
          executionResults,
          executionTrace,
          finalStatus,
          failedStep,
          repairRounds: executionResults.repairRounds || 0,
          queued: false,
        }),
        auth,
        request: requestRecord,
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
      const secretCheck = verifySharedWebhookSecret(request, body, slackWebhookSecret, 'x-openhermes-slack-secret');
      if (!secretCheck.ok) {
        await audit('webhook.slack.denied', request, { reason: secretCheck.reason });
        sendJson(response, 401, { ok: false, error: secretCheck.reason }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      if (body.challenge) {
        sendJson(response, 200, { challenge: body.challenge }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      const text = readSlackText(body);
      if (looksLikeRemoteControlRequest(text)) {
        const { plan, requestRecord, executionResults } = await executeControlRequest({
          source: 'webhook.slack',
          task: text,
          body,
          channel: 'slack',
          sourceLabel: 'slack',
          reply: body.response_url || body.reply_url || '',
        });
        const ack = `요청이 바로 실행되었습니다. requestId=${requestRecord.id}`;
        if (body.response_url || body.reply_url) {
          await sendWebhookReply(body.response_url || body.reply_url, ack);
        }
        await audit('webhook.slack.executed', request, { body, requestId: requestRecord.id, text, plan, executionResults });
        sendJson(response, 200, {
          ok: true,
          queued: false,
          executed: true,
          requestId: requestRecord.id,
          summary: plan.summary,
          request: requestRecord,
          reply: ack,
          executionResults,
        }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      const result = await handleToolMessage(
        {
          ...body,
          messages: [{ role: 'user', content: text }],
        },
        'slack',
      );
      await audit('webhook.slack', request, { body, result: Boolean(result?.reply) });
      sendJson(response, 200, { ok: true, queued: false, ...result }, {
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
      const secretCheck = verifySharedWebhookSecret(request, body, discordWebhookSecret, 'x-openhermes-discord-secret');
      if (!secretCheck.ok) {
        await audit('webhook.discord.denied', request, { reason: secretCheck.reason });
        sendJson(response, 401, { ok: false, error: secretCheck.reason }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      const text = readDiscordText(body);
      if (looksLikeRemoteControlRequest(text)) {
        const { plan, requestRecord, executionResults } = await executeControlRequest({
          source: 'webhook.discord',
          task: text,
          body,
          channel: 'discord',
          sourceLabel: 'discord',
        });
        await audit('webhook.discord.executed', request, { body, requestId: requestRecord.id, text, plan, executionResults });
        sendJson(response, 200, {
          ok: true,
          queued: false,
          executed: true,
          requestId: requestRecord.id,
          summary: plan.summary,
          request: requestRecord,
          reply: `요청이 바로 실행되었습니다. requestId=${requestRecord.id}`,
          executionResults,
        }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }
      const result = await handleToolMessage(
        {
          ...body,
          messages: [{ role: 'user', content: text }],
        },
        'discord',
      );
      await audit('webhook.discord', request, { body, result: Boolean(result?.reply) });
      sendJson(response, 200, { ok: true, queued: false, ...result }, {
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

  if (request.method === 'POST' && url.pathname === '/webhooks/github') {
    try {
      const rawBody = await readBodyText(request);
      const body = parseJsonBody(rawBody);
      const secretCheck = verifyGithubWebhook(request, rawBody);
      if (!secretCheck.ok) {
        await audit('webhook.github.denied', request, { reason: secretCheck.reason });
        sendJson(response, 401, { ok: false, error: secretCheck.reason }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }

      const text = readGitHubText(body);
      if (!text && body.action !== 'ping') {
        sendJson(response, 200, { ok: true, ignored: true, reason: 'no_text' }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }

      if (looksLikeRemoteControlRequest(text)) {
        const { plan, requestRecord, executionResults } = await executeControlRequest({
          source: 'webhook.github',
          task: text,
          body,
          channel: 'github',
          sourceLabel: 'github',
        });
        await audit('webhook.github.executed', request, { body, requestId: requestRecord.id, text, plan, executionResults });
        sendJson(response, 200, {
          ok: true,
          queued: false,
          executed: true,
          requestId: requestRecord.id,
          summary: plan.summary,
          request: requestRecord,
          executionResults,
        }, {
          'access-control-allow-origin': getResponseOrigin(request),
          vary: 'Origin',
        });
        return;
      }

      const result = await handleToolMessage(
        {
          ...body,
          messages: [{ role: 'user', content: text || 'GitHub webhook event received.' }],
        },
        'github',
      );
      await audit('webhook.github', request, { body, result: Boolean(result?.reply) });
      sendJson(response, 200, { ok: true, queued: false, ...result }, {
        'access-control-allow-origin': getResponseOrigin(request),
        vary: 'Origin',
      });
    } catch (error) {
      await audit('webhook.github.error', request, { error: error.message || String(error) });
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
      'GET /api/requests',
      'POST /api/requests',
      'GET /api/requests/:id',
      'POST /api/requests/:id/approve',
      'POST /api/requests/:id/reject',
      'POST /api/chat',
      'POST /api/control',
      'POST /api/automation/execute',
      'POST /api/automation/app',
      'POST /webhooks/slack',
      'POST /webhooks/discord',
      'POST /webhooks/github',
    ],
  }, {
    'access-control-allow-origin': getResponseOrigin(request),
    vary: 'Origin',
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`OpenHermes proxy listening on http://127.0.0.1:${port}`);
  console.log(`Upstream Hermes: ${hermesBaseUrl}`);
  autoExecutePendingRequestsOnBoot().catch((error) => {
    console.error(`Failed to auto-execute pending requests: ${error.message || error}`);
  });
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
