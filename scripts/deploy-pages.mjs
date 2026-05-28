#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `${command} ${args.join(' ')} failed`));
      }
    });
  });
}

async function resolveTailnetProxyUrl() {
  const serveStatusRaw = await capture('tailscale', ['serve', 'status', '--json']).catch(() => '');
  if (!serveStatusRaw.trim()) {
    return '';
  }

  try {
    const parsed = JSON.parse(serveStatusRaw);
    for (const [host, handlers] of Object.entries(parsed.Web || {})) {
      const proxyUrl = handlers?.Handlers?.['/']?.Proxy || '';
      if (proxyUrl) {
        const normalizedHost = host.replace(/:443$/, '');
        return `https://${normalizedHost}`;
      }
    }
  } catch {
    return '';
  }

  return '';
}

async function ensurePages(owner, repo) {
  const get = spawn('gh', ['api', `repos/${owner}/${repo}/pages`], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise((resolve) => get.on('exit', resolve));
  if (code === 0) {
    const update = await run('gh', ['api', '-X', 'PUT', `repos/${owner}/${repo}/pages`, '-f', 'build_type=legacy', '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/']);
    if (update !== 0) {
      throw new Error('Unable to update GitHub Pages settings');
    }
    return;
  }

  const create = await run('gh', ['api', '-X', 'POST', `repos/${owner}/${repo}/pages`, '-f', 'build_type=legacy', '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/']);
  if (create !== 0) {
    throw new Error('Unable to create GitHub Pages site');
  }
}

async function main() {
  const proxyUrl = (
    process.env.OPENHERMES_PROXY_URL ||
    process.env.VITE_PROXY_URL ||
    await resolveTailnetProxyUrl() ||
    'http://127.0.0.1:8787'
  ).replace(/\/+$/, '');
  const buildCode = await run('npm', ['run', 'build'], {
    VITE_BASE: process.env.VITE_BASE || '/localHermes/',
    VITE_PROXY_URL: proxyUrl,
  });
  if (buildCode !== 0) {
    process.exit(buildCode);
  }

  const repoView = spawn('gh', ['repo', 'view', '--json', 'name,owner,url'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    repoView.stdout.on('data', (chunk) => (stdout += chunk));
    repoView.stderr.on('data', (chunk) => (stderr += chunk));
    repoView.on('error', reject);
    repoView.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'gh repo view failed'));
        return;
      }
      resolve(stdout);
    });
  });

  const repoInfo = JSON.parse(output);
  const publishCode = await run('npx', ['gh-pages', '-d', 'dist', '-b', 'gh-pages', '-m', `Deploy OpenHermes Pages ${new Date().toISOString()}`], {
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || '',
  });
  if (publishCode !== 0) {
    process.exit(publishCode);
  }

  await ensurePages(repoInfo.owner.login, repoInfo.name);

  const pageInfo = spawn('gh', ['api', `repos/${repoInfo.owner.login}/${repoInfo.name}/pages`], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pageOutput = await new Promise((resolve) => {
    let stdout = '';
    pageInfo.stdout.on('data', (chunk) => (stdout += chunk));
    pageInfo.on('exit', () => resolve(stdout));
  });
  try {
    const page = JSON.parse(pageOutput);
    console.log(`Pages URL: ${page.html_url}`);
  } catch {
    console.log('Pages deployment pushed to gh-pages.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
