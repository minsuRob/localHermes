import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export function getAuditLogPath(rootDir, overridePath = '') {
  return path.resolve(overridePath || path.join(rootDir, '.run', 'openhermes-audit.jsonl'));
}

export async function appendAuditRecord(logPath, record) {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readRecentAuditRecords(logPath, limit = 50) {
  try {
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines
      .slice(Math.max(0, lines.length - Math.max(1, limit)))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .reverse();
  } catch {
    return [];
  }
}
