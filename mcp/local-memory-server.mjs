#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const stateDir = path.join(rootDir, '.run');
const stateFile = path.join(stateDir, 'openhermes-memory.json');

async function loadState() {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.notes)) {
      return parsed;
    }
  } catch {
    // fall through
  }

  return {
    notes: [
      {
        id: 'seed-note',
        title: 'OpenHermes',
        body: 'Local MCP memory server is ready.',
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

async function saveState(state) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

function jsonContent(payload) {
  return [
    {
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    },
  ];
}

const server = new McpServer({
  name: 'local-memory',
  version: '1.0.0',
});

server.registerTool(
  'list_notes',
  {
    description: 'List persisted local notes for smoke testing and quick memory storage.',
    inputSchema: z.object({}),
  },
  async () => {
    const state = await loadState();
    return {
      content: jsonContent({ notes: state.notes }),
      structuredContent: { notes: state.notes },
    };
  },
);

server.registerTool(
  'add_note',
  {
    description: 'Add a local note to the JSON state file.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Note title'),
      body: z.string().min(1).describe('Note body'),
    }),
  },
  async ({ title, body }) => {
    const state = await loadState();
    const note = {
      id: `note-${Math.random().toString(36).slice(2, 10)}`,
      title,
      body,
      createdAt: new Date().toISOString(),
    };
    state.notes.unshift(note);
    await saveState(state);
    return {
      content: jsonContent({ ok: true, note, count: state.notes.length }),
      structuredContent: { ok: true, note, count: state.notes.length },
    };
  },
);

server.registerTool(
  'clear_notes',
  {
    description: 'Remove every local note and reset the seed state.',
    inputSchema: z.object({}),
  },
  async () => {
    const state = { notes: [] };
    await saveState(state);
    return {
      content: jsonContent({ ok: true, count: 0 }),
      structuredContent: { ok: true, count: 0 },
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
