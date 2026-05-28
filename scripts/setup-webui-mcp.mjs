#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const portsFile = path.join(scriptDir, 'mcp-bridge-ports.json');
const WEBUI_URL = process.env.WEBUI_URL || 'http://127.0.0.1:8080';
const CONFIG_KEY = 'LlamaCppWebui.config';

const ports = JSON.parse(await readFile(portsFile, 'utf8'));
const servers = Object.entries(ports).map(([name, entry], index) => ({
  id: `localHermes-${name}`,
  name,
  enabled: true,
  url: `http://127.0.0.1:${entry.port}/mcp`,
  useProxy: false,
  requestTimeoutSeconds: 300,
}));

console.log('MCP Web UI server entries (import via browser console at', WEBUI_URL, '):');
console.log('');
console.log('// Paste in DevTools console on llama.cpp Web UI');
console.log(`(() => {`);
console.log(`  const key = ${JSON.stringify(CONFIG_KEY)};`);
console.log(`  const raw = localStorage.getItem(key);`);
console.log(`  const config = raw ? JSON.parse(raw) : {};`);
console.log(`  config.mcpServers = ${JSON.stringify(servers)};`);
console.log(`  localStorage.setItem(key, JSON.stringify(config));`);
console.log(`  location.reload();`);
console.log(`})();`);
console.log('');

if (process.argv.includes('--apply')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(WEBUI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, serverList }) => {
    const raw = localStorage.getItem(key);
    const config = raw ? JSON.parse(raw) : {};
    config.mcpServers = serverList;
    localStorage.setItem(key, JSON.stringify(config));
  }, { key: CONFIG_KEY, serverList: servers });
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 });

  const count = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const config = JSON.parse(raw);
    const parsed = typeof config.mcpServers === 'string' ? JSON.parse(config.mcpServers) : config.mcpServers;
    return Array.isArray(parsed) ? parsed.length : 0;
  }, CONFIG_KEY);

  await browser.close();
  console.log(`Applied MCP servers to Web UI localStorage (${count} servers).`);
  if (count < 5) process.exit(1);
}
