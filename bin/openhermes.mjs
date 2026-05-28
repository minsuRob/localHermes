#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createClientAuthHeaders } from '../lib/openhermes-auth.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const runDir = path.join(rootDir, '.run');
const args = process.argv.slice(2);
const command = args[0] || 'help';

function scriptPath(relativePath) {
  return path.join(rootDir, relativePath);
}

function envBaseUrl() {
  return (process.env.OPENHERMES_HERMES_BASE_URL || process.env.HERMES_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

function envProxyUrl() {
  return (process.env.OPENHERMES_PROXY_URL || process.env.VITE_PROXY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

function envToken() {
  return process.env.OPENHERMES_API_TOKEN || process.env.OPENHERMES_TOKEN || '';
}

function envSecret() {
  return process.env.OPENHERMES_API_SECRET || process.env.OPENHERMES_SECRET || '';
}

function getArg(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = args.find((value) => value.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(name);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return fallback;
}

function runNode(file, extraEnv = {}, extraArgs = []) {
  const child = spawn(process.execPath, [file, ...extraArgs], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  return child;
}

function runScript(commandPath, extraEnv = {}) {
  const child = spawn(commandPath, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  return child;
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readPid(pidFile) {
  if (!(await exists(pidFile))) return null;
  const raw = await readFile(pidFile, 'utf8');
  const pid = Number(raw.trim());
  return Number.isFinite(pid) ? pid : null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function printHelp() {
  console.log(`openhermes <command>

Commands:
  start         Start local Hermes backend and MCP bridges
  stop          Stop known local OpenHermes processes
  status        Show Hermes / proxy / MCP status
  web           Start the React web UI and proxy
  proxy         Start only the API proxy
  chat          Send a chat message to the proxy / Hermes
  control       Send a macOS control task to Hermes
  permissions   Inspect or request macOS permissions
  automate      Run an app automation action
  verify        Run local Hermes + MCP smoke checks
  deploy-pages  Build and publish the GitHub Pages site
  connect       Show Slack / Discord webhook wiring

Examples:
  openhermes start
  openhermes web
  openhermes chat --message "안녕"
  openhermes control --task "Chrome 열고 google.com 열어줘"
  openhermes permissions status
  openhermes permissions request --target accessibility --auto
  openhermes automate --app "Google Chrome" --action openUrl --url "https://example.com"
  openhermes deploy-pages --proxy-url https://proxy.example.com
`);
}

function apiHeaders({ method, pathname, body = '' } = {}) {
  return {
    'content-type': 'application/json',
    ...createClientAuthHeaders({
      token: envToken(),
      secret: envSecret(),
      method,
      pathname,
      body,
    }),
  };
}

async function apiJson(pathname, body = {}, method = 'POST') {
  const bodyForAuth = method === 'GET' ? '' : body;
  const response = await fetch(`${envProxyUrl()}${pathname}`, {
    method,
    headers: apiHeaders({ method, pathname, body: bodyForAuth }),
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  return text ? JSON.parse(text) : {};
}

async function startWeb(extraArgs = []) {
  const proxyUrl = envProxyUrl();
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', ...extraArgs], {
    cwd: rootDir,
    env: {
      ...process.env,
      VITE_PROXY_URL: process.env.VITE_PROXY_URL || proxyUrl,
      VITE_BASE: process.env.VITE_BASE || '/',
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  return child;
}

async function startProxy(extraArgs = []) {
  const child = spawn(process.execPath, [scriptPath('proxy/server.mjs'), ...extraArgs], {
    cwd: rootDir,
    env: {
      ...process.env,
      OPENHERMES_HERMES_BASE_URL: envBaseUrl(),
      OPENHERMES_MODEL_ID: process.env.OPENHERMES_MODEL_ID || process.env.HERMES_MODEL_ID || '',
      OPENHERMES_PROXY_PORT: process.env.OPENHERMES_PROXY_PORT || '8787',
      OPENHERMES_PROXY_URL: envProxyUrl(),
      OPENHERMES_API_TOKEN: envToken(),
      OPENHERMES_API_SECRET: envSecret(),
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  return child;
}

async function doStatus() {
  const pidFiles = [
    ['llama-server', path.join(rootDir, '.run', 'llama-server.pid')],
    ['mcp-bridges', path.join(rootDir, '.run', 'mcp-bridges')],
  ];
  console.log('OpenHermes status');
  console.log(`- root: ${rootDir}`);
  console.log(`- hermes: ${envBaseUrl()}`);
  console.log(`- proxy: ${envProxyUrl()}`);
  console.log('');

  for (const [label, file] of pidFiles) {
    if (label === 'mcp-bridges') {
      const items = await loadBridgeStatus(file);
      for (const line of items) console.log(line);
      continue;
    }
    const pid = await readPid(file);
    console.log(`- ${label}: ${pid && isAlive(pid) ? `running (${pid})` : 'stopped'}`);
  }

  try {
    const upstream = await fetch(`${envBaseUrl()}/health`).then((r) => r.ok).catch(() => false);
    console.log(`- upstream health: ${upstream ? 'ready' : 'down'}`);
  } catch {
    console.log('- upstream health: down');
  }

  try {
    const proxy = await fetch(`${envProxyUrl()}/api/health`).then((r) => r.ok).catch(() => false);
    console.log(`- proxy health: ${proxy ? 'ready' : 'down'}`);
  } catch {
    console.log('- proxy health: down');
  }

  try {
    const permissions = await fetch(`${envProxyUrl()}/api/permissions/status`, {
      headers: apiHeaders({ method: 'GET', pathname: '/api/permissions/status' }),
    })
      .then((r) => r.ok)
      .catch(() => false);
    console.log(`- permissions api: ${permissions ? 'ready' : 'down'}`);
  } catch {
    console.log('- permissions api: down');
  }
}

async function loadBridgeStatus(pidDir) {
  const lines = [];
  if (!(await exists(pidDir))) {
    return ['- mcp bridges: stopped'];
  }
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(pidDir));
  for (const fileName of entries.filter((name) => name.endsWith('.pid')).sort()) {
    const pid = await readPid(path.join(pidDir, fileName));
    lines.push(`- mcp:${fileName.replace(/\.pid$/, '')}: ${pid && isAlive(pid) ? `running (${pid})` : 'stopped'}`);
  }
  return lines.length ? lines : ['- mcp bridges: stopped'];
}

async function doChat() {
  const message = getArg('--message') || args.slice(1).join(' ');
  if (!message) {
    console.error('Missing --message');
    process.exit(1);
  }
  const response = await fetch(`${envProxyUrl()}/api/chat`, {
    method: 'POST',
    headers: apiHeaders({
      method: 'POST',
      pathname: '/api/chat',
      body: {
        messages: [{ role: 'user', content: message }],
        stream: false,
      },
    }),
    body: JSON.stringify({
      messages: [{ role: 'user', content: message }],
      stream: false,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(text);
    process.exit(1);
  }
  const payload = JSON.parse(text);
  console.log(payload?.choices?.[0]?.message?.content || '');
}

async function doControl() {
  const task = getArg('--task') || args.slice(1).join(' ');
  if (!task) {
    console.error('Missing --task');
    process.exit(1);
  }
  const payload = await apiJson('/api/control', { task });
  console.log(JSON.stringify(payload, null, 2));
}

async function doPermissions() {
  const subcommand = args[1] || 'status';
  if (subcommand === 'status') {
    const payload = await apiJson('/api/permissions/status', {}, 'GET');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (subcommand === 'request') {
    const targetPermission = getArg('--target', 'automation');
    const autoAttempt = args.includes('--auto');
    const openPanels = !args.includes('--no-panels');
    const payload = await apiJson('/api/permissions/request', {
      targetPermission,
      autoAttempt,
      openPanels,
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('Usage: openhermes permissions status|request --target accessibility --auto');
}

async function doAutomate() {
  const app = getArg('--app', '');
  const action = getArg('--action', 'focus');
  const url = getArg('--url', '');
  const text = getArg('--text', '');
  const key = getArg('--key', '');
  const modifiers = getArg('--modifiers', '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const pane = getArg('--pane', '');
  const coordinates = getArg('--coordinates', '');
  const payload = {
    app,
    action,
    url,
    text,
    pane,
    shortcut: key ? { key, modifiers } : undefined,
  };
  if (coordinates) {
    const [x, y] = coordinates.split(',').map((value) => Number(value.trim()));
    if (Number.isFinite(x) && Number.isFinite(y)) {
      payload.selectorOrCoords = { x, y };
    }
  }
  const result = await apiJson('/api/automation/execute', payload);
  console.log(JSON.stringify(result, null, 2));
}

async function doStop() {
  const pidFiles = [
    path.join(rootDir, '.run', 'llama-server.pid'),
  ];
  for (const pidFile of pidFiles) {
    const pid = await readPid(pidFile);
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }
  await runScript(scriptPath('scripts/stop-mcp-bridges.sh'));
  const extra = [
    'pkill -f "proxy/server.mjs" 2>/dev/null || true',
    'pkill -f "vite --host 127.0.0.1 --port 5173" 2>/dev/null || true',
  ];
  if (process.platform !== 'win32') {
    spawnSync('sh', ['-lc', extra.join('\n')], { cwd: rootDir, stdio: 'inherit' });
  }
  console.log('OpenHermes processes stopped.');
}

async function doVerify() {
  const child = spawn(process.execPath, [scriptPath('scripts/check-hermes-local.mjs')], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

async function doDeployPages() {
  const proxyUrl = getArg('--proxy-url') || envProxyUrl();
  const build = spawn('npm', ['run', 'build'], {
    cwd: rootDir,
    env: {
      ...process.env,
      VITE_BASE: process.env.VITE_BASE || '/localHermes/',
      VITE_PROXY_URL: proxyUrl,
    },
    stdio: 'inherit',
  });
  const buildCode = await new Promise((resolve) => build.on('exit', resolve));
  if (buildCode !== 0) {
    process.exit(buildCode || 1);
  }

  const repoInfo = JSON.parse(
    spawnSync('gh', ['repo', 'view', '--json', 'name,owner,url'], {
      cwd: rootDir,
      encoding: 'utf8',
    }).stdout,
  );
  const owner = repoInfo.owner.login;
  const repo = repoInfo.name;
  const { default: ghPages } = await import('gh-pages');
  await new Promise((resolve, reject) => {
    ghPages.publish(
      path.join(rootDir, 'dist'),
      {
        branch: 'gh-pages',
        repo: repoInfo.url,
        message: `Deploy OpenHermes Pages from ${new Date().toISOString()}`,
        dotfiles: true,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });

  const pagesInfo = spawnSync('gh', ['api', `repos/${owner}/${repo}/pages`], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  const pagesPayload = {
    build_type: 'legacy',
    source: {
      branch: 'gh-pages',
      path: '/',
    },
  };

  if (pagesInfo.status !== 0) {
    const created = spawnSync(
      'gh',
      ['api', '-X', 'POST', `repos/${owner}/${repo}/pages`, '-f', `build_type=${pagesPayload.build_type}`, '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'],
      { cwd: rootDir, encoding: 'utf8' },
    );
    if (created.status !== 0) {
      console.error(created.stdout || created.stderr);
      process.exit(created.status || 1);
    }
  } else {
    const updated = spawnSync(
      'gh',
      ['api', '-X', 'PUT', `repos/${owner}/${repo}/pages`, '-f', `build_type=${pagesPayload.build_type}`, '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'],
      { cwd: rootDir, encoding: 'utf8' },
    );
    if (updated.status !== 0) {
      console.error(updated.stdout || updated.stderr);
      process.exit(updated.status || 1);
    }
  }

  const published = spawnSync('gh', ['api', `repos/${owner}/${repo}/pages`], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (published.status === 0) {
    const page = JSON.parse(published.stdout);
    console.log(`Pages URL: ${page.html_url}`);
  } else {
    console.log('Pages deployment pushed. Check the repository Pages URL after GitHub finishes the build.');
  }
}

async function doConnect() {
  const target = args[1];
  const proxyUrl = envProxyUrl();
  if (target === 'slack') {
    console.log(`Slack webhook endpoint: ${proxyUrl}/webhooks/slack`);
    console.log('Send inbound Slack payloads here or wire this into an Events API handler.');
    return;
  }
  if (target === 'discord') {
    console.log(`Discord webhook endpoint: ${proxyUrl}/webhooks/discord`);
    console.log('Send inbound Discord webhook payloads here or wire this into a bot/bridge.');
    return;
  }
  console.log('Specify `slack` or `discord`.');
}

async function main() {
  switch (command) {
    case 'start':
      runScript(scriptPath('scripts/bootstrap-hermes-local.sh'));
      break;
    case 'stop':
      await doStop();
      break;
    case 'status':
      await doStatus();
      break;
    case 'web':
      startProxy(args.includes('--serve') ? ['--serve'] : args.includes('--funnel') ? ['--funnel'] : []);
      startWeb();
      break;
    case 'proxy':
      startProxy(args.includes('--serve') ? ['--serve'] : args.includes('--funnel') ? ['--funnel'] : []);
      break;
    case 'chat':
      await doChat();
      break;
    case 'control':
      await doControl();
      break;
    case 'permissions':
      await doPermissions();
      break;
    case 'automate':
      await doAutomate();
      break;
    case 'verify':
      await doVerify();
      break;
    case 'deploy-pages':
      await doDeployPages();
      break;
    case 'connect':
      await doConnect();
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
