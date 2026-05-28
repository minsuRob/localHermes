#!/usr/bin/env node

import { chromium } from 'playwright';

const WEBUI_URL = process.env.WEBUI_URL || 'http://127.0.0.1:8080';
const CONFIG_KEY = 'LlamaCppWebui.config';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(WEBUI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

const servers = await page.evaluate((key) => {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const config = JSON.parse(raw);
  const parsed = typeof config.mcpServers === 'string' ? JSON.parse(config.mcpServers) : config.mcpServers;
  return Array.isArray(parsed) ? parsed : [];
}, CONFIG_KEY);

console.log(`Web UI localStorage MCP servers: ${servers.length}`);
for (const server of servers) {
  console.log(`  [OK] ${server.name || server.id} → ${server.url} (enabled=${server.enabled})`);
}

await browser.close();
process.exit(servers.length >= 5 ? 0 : 1);
