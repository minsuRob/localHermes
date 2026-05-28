import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const execFileAsync = promisify(execFile);

function trimOutput(value = '') {
  return String(value || '').trim();
}

function escapeAppleScriptString(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
    return {
      ok: true,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr),
      code: 0,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: trimOutput(error.stdout),
      stderr: trimOutput(error.stderr || error.message),
      code: Number.isFinite(error.code) ? error.code : 1,
    };
  }
}

async function runAppleScript(source) {
  return runCommand('osascript', ['-e', source]);
}

export function normalizeAutomationTarget(target = '') {
  return String(target).trim();
}

export async function launchApp(appName) {
  const target = normalizeAutomationTarget(appName);
  if (!target) {
    return { ok: false, action: 'launch', error: 'missing_app' };
  }
  const result = await runCommand('open', ['-a', target]);
  return { ...result, action: 'launch', app: target };
}

export async function focusApp(appName) {
  const target = normalizeAutomationTarget(appName);
  if (!target) {
    return { ok: false, action: 'focus', error: 'missing_app' };
  }
  const script = `tell application "${escapeAppleScriptString(target)}" to activate`;
  const result = await runAppleScript(script);
  return { ...result, action: 'focus', app: target };
}

export async function openUrl(url, appName = '') {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) {
    return { ok: false, action: 'openUrl', error: 'missing_url' };
  }
  const targetApp = normalizeAutomationTarget(appName);
  if (/chrome/i.test(targetApp)) {
    const script = `
      tell application "Google Chrome"
        activate
        if not (exists window 1) then
          make new window
        end if
        set URL of active tab of front window to "${escapeAppleScriptString(targetUrl)}"
      end tell
    `;
    const result = await runAppleScript(script);
    return { ...result, action: 'openUrl', app: targetApp || 'Google Chrome', url: targetUrl };
  }
  const result = targetApp
    ? await runCommand('open', ['-a', targetApp, targetUrl])
    : await runCommand('open', [targetUrl]);
  return { ...result, action: 'openUrl', app: targetApp || 'default-browser', url: targetUrl };
}

export async function openSystemPane(pane) {
  const target = normalizeAutomationTarget(pane);
  const schemeByName = {
    automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    screenrecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    screencapture: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    filesandfolders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
    'files-and-folders': 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
    'privacy-automation': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    'privacy-accessibility': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'privacy-screenrecording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  };
  const url = schemeByName[target.toLowerCase()] || target;
  const result = await runCommand('open', [url]);
  return { ...result, action: 'openSystemPane', pane: target, url };
}

export async function typeText(text, targetApp = '') {
  const content = String(text ?? '');
  if (!content) {
    return { ok: false, action: 'type', error: 'missing_text' };
  }
  const appName = normalizeAutomationTarget(targetApp);
  if (appName) {
    await focusApp(appName);
  }
  const script = `tell application "System Events" to keystroke "${escapeAppleScriptString(content)}"`;
  const result = await runAppleScript(script);
  return { ...result, action: 'type', app: appName || 'focused-app', text: content };
}

export async function pressShortcut(shortcut = {}, targetApp = '') {
  const appName = normalizeAutomationTarget(targetApp);
  if (appName) {
    await focusApp(appName);
  }
  const modifiers = Array.isArray(shortcut.modifiers) ? shortcut.modifiers.filter(Boolean) : [];
  const key = String(shortcut.key || shortcut.text || '').trim();
  if (!key) {
    return { ok: false, action: 'shortcut', error: 'missing_key' };
  }
  const modifierMap = {
    command: 'command down',
    cmd: 'command down',
    control: 'control down',
    ctrl: 'control down',
    option: 'option down',
    alt: 'option down',
    shift: 'shift down',
    fn: 'fn down',
  };
  const modifierList = modifiers.length
    ? ` using {${modifiers.map((item) => modifierMap[String(item).toLowerCase()] || `${String(item).toLowerCase()} down`).join(', ')}}`
    : '';
  const script = `tell application "System Events" to keystroke "${escapeAppleScriptString(key)}"${modifierList}`;
  const result = await runAppleScript(script);
  return { ...result, action: 'shortcut', app: appName || 'focused-app', shortcut };
}

export async function clickMenuItem(menuPath = {}, targetApp = '') {
  const appName = normalizeAutomationTarget(targetApp || menuPath.app);
  const menuBar = menuPath.menuBar || 'menu bar 1';
  const menu = menuPath.menu || '';
  const item = menuPath.item || '';
  const subItem = menuPath.subItem || '';
  if (!appName || !menu || !item) {
    return { ok: false, action: 'clickMenuItem', error: 'missing_menu_path' };
  }

  const appScript = `
    tell application "System Events"
      tell process "${escapeAppleScriptString(appName)}"
        set frontmost to true
        click menu item "${escapeAppleScriptString(item)}" of menu "${escapeAppleScriptString(menu)}" of ${menuBar}
      end tell
    end tell
  `;
  const result = await runAppleScript(appScript);

  if (!result.ok || !subItem) {
    return { ...result, action: 'clickMenuItem', app: appName, menuPath };
  }

  const subScript = `
    tell application "System Events"
      tell process "${escapeAppleScriptString(appName)}"
        click menu item "${escapeAppleScriptString(subItem)}" of menu "${escapeAppleScriptString(item)}" of menu "${escapeAppleScriptString(menu)}" of ${menuBar}
      end tell
    end tell
  `;
  const subResult = await runAppleScript(subScript);
  return { ...subResult, action: 'clickMenuItem', app: appName, menuPath };
}

export async function clickCoordinates(point = {}) {
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, action: 'click', error: 'missing_coordinates' };
  }
  const cliclickCheck = await runCommand('sh', ['-lc', 'command -v cliclick']);
  if (cliclickCheck.ok && cliclickCheck.stdout) {
    const result = await runCommand(cliclickCheck.stdout, [`c:${Math.round(x)},${Math.round(y)}`]);
    return { ...result, action: 'click', point: { x: Math.round(x), y: Math.round(y) } };
  }
  return {
    ok: false,
    action: 'click',
    error: 'cliclick_not_installed',
    point: { x: Math.round(x), y: Math.round(y) },
  };
}

export async function probeAutomation() {
  const results = {};
  results.accessibility = await runAppleScript('tell application "System Events" to get name of first application process');
  results.screenRecording = await runCommand('screencapture', ['-x', path.join(os.tmpdir(), `openhermes-screen-${Date.now()}.png`)]);
  results.filesAndFolders = {
    ok: true,
    action: 'probeFiles',
    home: process.env.HOME || os.homedir(),
    desktop: path.join(process.env.HOME || os.homedir(), 'Desktop'),
    documents: path.join(process.env.HOME || os.homedir(), 'Documents'),
  };
  return results;
}

export async function executeAutomationAction(action = {}) {
  const normalizedAction = String(action.action || '').trim();
  const app = normalizeAutomationTarget(action.app);
  switch (normalizedAction) {
    case 'launch':
      return launchApp(app);
    case 'focus':
      return focusApp(app);
    case 'openUrl':
      return openUrl(action.url, app);
    case 'type':
      return typeText(action.text, app);
    case 'shortcut':
      return pressShortcut(action.shortcut || { key: action.key, modifiers: action.modifiers }, app);
    case 'clickMenuItem':
      return clickMenuItem(action.menuPath || action.options?.menuPath || action.options || {}, app);
    case 'click':
      return clickCoordinates(action.selectorOrCoords || action.coordinates || action.point || action.options?.coordinates || {});
    case 'openSystemPane':
      return openSystemPane(action.pane || action.target || action.options?.pane || action.options?.target || '');
    case 'probe':
      return probeAutomation();
    case 'activateWindow':
      return focusApp(app);
    default:
      return { ok: false, action: normalizedAction || 'unknown', error: 'unsupported_action' };
  }
}

export async function inspectPermissions() {
  const [automation, accessibility, screenRecording] = await Promise.all([
    runAppleScript('tell application "System Events" to get name of first application process'),
    runAppleScript('tell application "System Events" to get name of every process'),
    runCommand('screencapture', ['-x', path.join(os.tmpdir(), `openhermes-screen-${Date.now()}.png`)]),
  ]);

  return {
    automation: {
      state: automation.ok ? 'likely_granted' : 'likely_denied',
      ok: automation.ok,
      details: automation.ok ? automation.stdout : automation.stderr,
    },
    accessibility: {
      state: accessibility.ok ? 'likely_granted' : 'likely_denied',
      ok: accessibility.ok,
      details: accessibility.ok ? accessibility.stdout : accessibility.stderr,
    },
    screenRecording: {
      state: screenRecording.ok ? 'likely_granted' : 'likely_denied',
      ok: screenRecording.ok,
      details: screenRecording.ok ? screenRecording.stdout : screenRecording.stderr,
    },
    filesAndFolders: {
      state: 'available',
      ok: true,
      details: [
        path.join(os.homedir(), 'Desktop'),
        path.join(os.homedir(), 'Documents'),
        path.join(os.homedir(), 'Downloads'),
      ],
    },
  };
}
