import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_FILENAME = 'openhermes-requests.json';
let writeChain = Promise.resolve();

async function withWriteLock(callback) {
  const previous = writeChain;
  let release;
  writeChain = new Promise((resolve) => {
    release = resolve;
  });

  await previous.catch(() => null);
  try {
    return await callback();
  } finally {
    release?.();
  }
}

export function getRequestStorePath(rootDir, overridePath = '') {
  return path.resolve(overridePath || path.join(rootDir, '.run', DEFAULT_FILENAME));
}

function createId(prefix = 'req') {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readState(storePath) {
  try {
    const raw = await readFile(storePath, 'utf8');
    if (!raw.trim()) {
      return { items: [] };
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { items: parsed };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return parsed;
    }
    return { items: [] };
  } catch {
    return { items: [] };
  }
}

async function writeState(storePath, state) {
  await mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmpPath, storePath);
}

export async function listQueuedRequests(storePath, { status, limit = 50 } = {}) {
  const state = await readState(storePath);
  const items = state.items
    .filter((item) => {
      if (!status) return true;
      return String(item.status || '').toLowerCase() === String(status).toLowerCase();
    })
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));

  return items.slice(0, Math.max(1, Number(limit) || 50));
}

export async function getQueuedRequest(storePath, id) {
  const state = await readState(storePath);
  return state.items.find((item) => item.id === id) || null;
}

export async function createQueuedRequest(storePath, request) {
  return withWriteLock(async () => {
    const state = await readState(storePath);
    const now = new Date().toISOString();
    const item = {
      id: createId('request'),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...request,
    };
    state.items.unshift(item);
    await writeState(storePath, state);
    return item;
  });
}

export async function updateQueuedRequest(storePath, id, updater) {
  return withWriteLock(async () => {
    const state = await readState(storePath);
    const index = state.items.findIndex((item) => item.id === id);
    if (index === -1) return null;

    const current = state.items[index];
    const next = typeof updater === 'function' ? updater({ ...current }) : { ...current, ...updater };
    next.id = current.id;
    next.createdAt = current.createdAt || next.createdAt || new Date().toISOString();
    next.updatedAt = new Date().toISOString();
    state.items[index] = next;
    await writeState(storePath, state);
    return next;
  });
}
