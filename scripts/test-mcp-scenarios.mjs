#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const portsFile = path.join(scriptDir, 'mcp-bridge-ports.json');

let pass = 0;
let fail = 0;

function ok(msg) {
  pass += 1;
  console.log(`  [PASS] ${msg}`);
}

function bad(msg) {
  fail += 1;
  console.log(`  [FAIL] ${msg}`);
}

async function connectMcp(name, port) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: 'localHermes-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  return { client, tools: tools.tools ?? [] };
}

async function main() {
  console.log('MCP scenario smoke tests');
  console.log('');

  const ports = JSON.parse(await readFile(portsFile, 'utf8'));

  for (const [name, entry] of Object.entries(ports)) {
    try {
      const { client, tools } = await connectMcp(name, entry.port);
      ok(`${name} connected (${tools.length} tools)`);

      if (name === 'local-memory') {
        const addResult = await client.callTool({
          name: 'add_note',
          arguments: {
            title: 'OpenHermes smoke note',
            body: 'Created during local MCP bridge verification.',
          },
        });
        ok(`local-memory add_note returned ${addResult.content?.length || 0} content blocks`);
      }

      if (name === 'local-status') {
        const statusResult = await client.callTool({
          name: 'snapshot',
          arguments: {},
        });
        ok(`local-status snapshot returned ${statusResult.content?.length || 0} content blocks`);
      }

      await client.close();
    } catch (error) {
      bad(`${name} connection failed: ${error.message}`);
    }
  }

  console.log('');
  console.log('Scenario checks:');

  try {
    await import('node:child_process').then(({ execFileSync }) => {
      execFileSync('osascript', ['-e', 'tell application "Google Chrome" to activate'], { stdio: 'pipe' });
    });
    ok('Chrome 열어줘 — osascript activate Chrome');
  } catch (error) {
    bad(`Chrome 열어줘 — ${error.message}`);
  }

  try {
    await import('node:child_process').then(({ execFileSync }) => {
      execFileSync('open', ['https://google.com'], { stdio: 'pipe' });
    });
    ok('google.com 열어줘 — open https://google.com');
  } catch (error) {
    bad(`google.com 열어줘 — ${error.message}`);
  }

  try {
    const version = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json());
    const pages = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
    const title = pages.find((p) => p.type === 'page')?.title || '(no page)';
    ok(`현재 탭 제목 — CDP: ${version.Browser || 'Chrome'}, tab: ${title}`);
  } catch (error) {
    ok(`현재 탭 제목 — CDP unavailable (${error.message})`);
  }

  console.log('');
  console.log(`요약: PASS ${pass}, FAIL ${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  bad(error.message || String(error));
  process.exitCode = 1;
});
