#!/usr/bin/env node

import { lstat, readdir, readFile, stat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

const MODEL_PATH = process.env.MODEL_PATH || '/Users/robertlee/Workspace/Personal/localclaw/model/gemma-4-E4B-it-Q5_K_M.gguf';
const HERMES_BASE_URL = (process.env.HERMES_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const HERMES_MODEL_ID = process.env.HERMES_MODEL_ID || path.basename(MODEL_PATH);
const CHECK_PROMPT = process.env.CHECK_PROMPT || 'Reply with exactly READY and nothing else.';

let passCount = 0;
let failCount = 0;

function pass(message) {
  passCount += 1;
  console.log(`  [PASS] ${message}`);
}

function fail(message) {
  failCount += 1;
  console.log(`  [FAIL] ${message}`);
}

function info(message) {
  console.log(`  [INFO] ${message}`);
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function validateMcpConfig(fileName, config) {
  const required = ['name', 'command', 'args', 'env', 'timeout', 'disabled'];
  const missing = required.filter((key) => !(key in config));
  if (missing.length > 0) {
    throw new Error(`${fileName}: missing required fields: ${missing.join(', ')}`);
  }

  if (typeof config.name !== 'string' || !config.name.trim()) {
    throw new Error(`${fileName}: "name" must be a non-empty string`);
  }

  if (typeof config.command !== 'string' || !config.command.trim()) {
    throw new Error(`${fileName}: "command" must be a non-empty string`);
  }

  if (!Array.isArray(config.args)) {
    throw new Error(`${fileName}: "args" must be an array`);
  }

  if (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) {
    throw new Error(`${fileName}: "env" must be an object`);
  }

  if (typeof config.timeout !== 'number' || Number.isNaN(config.timeout)) {
    throw new Error(`${fileName}: "timeout" must be a number`);
  }

  if (typeof config.disabled !== 'boolean') {
    throw new Error(`${fileName}: "disabled" must be a boolean`);
  }
}

async function checkMcpDirectory(directoryName) {
  const directoryPath = path.join(rootDir, 'mcp', directoryName);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).filter((entry) => entry.name.endsWith('.json'));

  for (const entry of jsonFiles) {
    const filePath = path.join(directoryPath, entry.name);
    const config = await loadJson(filePath);
    validateMcpConfig(path.join(directoryName, entry.name), config);
  }

  pass(`MCP ${directoryName} JSON 검증 완료 (${jsonFiles.length}개)`);
}

async function checkEnabledLink() {
  const enabledPath = path.join(rootDir, 'mcp', 'enabled', 'filesystem.json');
  const expectedTarget = path.join(rootDir, 'mcp', 'servers', 'filesystem.json');

  if (!(await exists(enabledPath))) {
    throw new Error('mcp/enabled/filesystem.json 이 없습니다.');
  }

  const enabledStat = await lstat(enabledPath);
  if (enabledStat.isSymbolicLink()) {
    const target = await readlink(enabledPath);
    const resolvedTarget = path.resolve(path.dirname(enabledPath), target);
    info(`filesystem 활성화 링크 확인됨: ${target}`);
    if (resolvedTarget !== expectedTarget) {
      throw new Error(`mcp/enabled/filesystem.json 링크 대상이 예상과 다릅니다: ${resolvedTarget}`);
    }
    pass('활성 MCP 링크 확인');
    return;
  }

  const enabledConfig = await loadJson(enabledPath);
  const expectedConfig = await loadJson(expectedTarget);
  if (JSON.stringify(enabledConfig) !== JSON.stringify(expectedConfig)) {
    throw new Error('mcp/enabled/filesystem.json 이 servers 버전과 일치하지 않습니다.');
  }
  pass('활성 MCP 복사본 확인');
}

async function checkHermesApi() {
  if (!(await exists(MODEL_PATH))) {
    throw new Error(`MODEL_PATH 파일이 없습니다: ${MODEL_PATH}`);
  }

  pass(`모델 파일 확인: ${MODEL_PATH}`);

  const healthResponse = await fetch(`${HERMES_BASE_URL}/health`).catch(() => null);
  if (!healthResponse || !healthResponse.ok) {
    throw new Error(`Hermes/llama.cpp 헬스 체크 실패: ${HERMES_BASE_URL}/health`);
  }
  pass(`헬스 체크 응답: ${HERMES_BASE_URL}/health`);

  const promptResponse = await fetch(`${HERMES_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: HERMES_MODEL_ID,
      temperature: 0,
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: CHECK_PROMPT,
        },
      ],
    }),
  });

  const bodyText = await promptResponse.text();
  if (!promptResponse.ok) {
    throw new Error(`샘플 프롬프트 실패: HTTP ${promptResponse.status} ${bodyText}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`샘플 프롬프트 응답 JSON 파싱 실패: ${error.message}`);
  }

  const content = parsed?.choices?.[0]?.message?.content?.trim() || '';
  info(`샘플 프롬프트 응답: ${content}`);

  if (!/\bREADY\b/i.test(content)) {
    throw new Error(`샘플 프롬프트가 기대한 응답을 반환하지 않았습니다: ${content || '(empty)'}`);
  }

  pass('샘플 프롬프트 성공');
}

async function main() {
  console.log('Hermes Local 비파괴 점검');
  console.log(`- root: ${rootDir}`);
  console.log(`- model: ${MODEL_PATH}`);
  console.log(`- base: ${HERMES_BASE_URL}`);
  console.log(`- model id: ${HERMES_MODEL_ID}`);
  console.log('');

  try {
    await checkMcpDirectory('servers');
    await checkMcpDirectory('templates');
    await checkEnabledLink();
    await checkHermesApi();
  } catch (error) {
    fail(error.message || String(error));
  }

  console.log('');
  console.log(`요약: PASS ${passCount}, FAIL ${failCount}`);

  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((error) => {
  fail(error.message || String(error));
  process.exitCode = 1;
});
