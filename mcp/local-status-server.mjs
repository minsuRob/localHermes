#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

async function readTailscaleStatus() {
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { maxBuffer: 5_000_000 });
    const parsed = JSON.parse(stdout);
    return {
      backendState: parsed.BackendState || 'unknown',
      tailnet: parsed.CurrentTailnet?.Name || '',
      hostName: parsed.Self?.HostName || '',
      dnsName: parsed.Self?.DNSName || '',
      ips: parsed.Self?.TailscaleIPs || [],
      online: Boolean(parsed.Self?.Online),
    };
  } catch (error) {
    return {
      backendState: 'unavailable',
      error: error.message || String(error),
    };
  }
}

const server = new McpServer({
  name: 'local-status',
  version: '1.0.0',
});

server.registerTool(
  'snapshot',
  {
    description: 'Return a local machine snapshot for smoke tests and diagnostics.',
    inputSchema: z.object({}),
  },
  async () => {
    const tailscale = await readTailscaleStatus();
    const payload = {
      rootDir,
      cwd: process.cwd(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.round(os.uptime()),
      modelPath: process.env.MODEL_PATH || '',
      hermesBaseUrl: process.env.HERMES_BASE_URL || 'http://127.0.0.1:8080',
      tailscale,
      now: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  'check_services',
  {
    description: 'Quickly report local Hermes and proxy reachability.',
    inputSchema: z.object({}),
  },
  async () => {
    const hermesBaseUrl = (process.env.HERMES_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    const proxyUrl = (process.env.OPENHERMES_PROXY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    const [hermesHealth, proxyHealth] = await Promise.allSettled([
      fetch(`${hermesBaseUrl}/health`).then((response) => response.ok),
      fetch(`${proxyUrl}/api/health`).then((response) => response.ok),
    ]);

    const payload = {
      hermesBaseUrl,
      proxyUrl,
      hermes: hermesHealth.status === 'fulfilled' ? hermesHealth.value : false,
      proxy: proxyHealth.status === 'fulfilled' ? proxyHealth.value : false,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
      structuredContent: payload,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
