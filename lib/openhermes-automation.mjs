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

async function sleep(ms = 0) {
  const duration = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, duration));
}

let playwrightChromiumPromise = null;

async function getPlaywrightChromium() {
  if (!playwrightChromiumPromise) {
    playwrightChromiumPromise = import('playwright')
      .then((mod) => mod.chromium)
      .catch(() => null);
  }
  return playwrightChromiumPromise;
}

function normalizeActionText(value = '') {
  return String(value || '').trim();
}

function normalizeKeyName(key = '') {
  const lower = String(key || '').trim().toLowerCase();
  if (['return', 'enter', '⏎'].includes(lower)) return 'return';
  if (['tab', '⇥'].includes(lower)) return 'tab';
  if (['space', 'spacebar', ' '].includes(lower)) return 'space';
  return lower;
}

async function pressKeyCode(keyName) {
  const normalized = normalizeKeyName(keyName);
  if (normalized === 'return') {
    return runAppleScript('tell application "System Events" to key code 36');
  }
  if (normalized === 'tab') {
    return runAppleScript('tell application "System Events" to key code 48');
  }
  if (normalized === 'space') {
    return runAppleScript('tell application "System Events" to key code 49');
  }
  return runAppleScript(`tell application "System Events" to keystroke "${escapeAppleScriptString(normalized)}"`);
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

export async function ensureAppFrontmost(appName) {
  const target = normalizeAutomationTarget(appName);
  if (!target) {
    return { ok: false, action: 'focus', error: 'missing_app' };
  }
  const launchResult = await launchApp(target);
  if (!launchResult.ok) {
    return launchResult;
  }
  const focusResult = await focusApp(target);
  return {
    ...focusResult,
    action: 'focus',
    app: target,
    fallbackUsed: launchResult.ok ? 'launch' : '',
  };
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
    await ensureAppFrontmost(appName);
  }
  const script = `tell application "System Events" to keystroke "${escapeAppleScriptString(content)}"`;
  const result = await runAppleScript(script);
  return { ...result, action: 'type', app: appName || 'focused-app', text: content };
}

export async function pressShortcut(shortcut = {}, targetApp = '') {
  const appName = normalizeAutomationTarget(targetApp);
  if (appName) {
    await ensureAppFrontmost(appName);
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
  const script = key.toLowerCase() === 'return' || key.toLowerCase() === 'enter'
    ? `tell application "System Events" to key code 36${modifierList ? ` ${modifierList}` : ''}`
    : `tell application "System Events" to keystroke "${escapeAppleScriptString(key)}"${modifierList}`;
  const result = await runAppleScript(script);
  return { ...result, action: 'shortcut', app: appName || 'focused-app', shortcut };
}

async function clickUiByAccessibility(target = {}, targetApp = '') {
  const appName = normalizeAutomationTarget(targetApp || target.app);
  const needle = normalizeActionText(target.text || target.contains || target.label || target.name || target.title || '');
  const roleNeedle = normalizeActionText(target.role || '');
  if (!appName || !needle && !roleNeedle) {
    return { ok: false, action: 'clickUi', error: 'missing_target' };
  }

  const script = `
    on elementText(el)
      set parts to {}
      try
        set end of parts to (name of el as text)
      end try
      try
        set end of parts to (description of el as text)
      end try
      try
        set end of parts to (value of el as text)
      end try
      try
        set end of parts to (role of el as text)
      end try
      try
        set end of parts to (subrole of el as text)
      end try
      set AppleScript's text item delimiters to " "
      set joined to parts as text
      set AppleScript's text item delimiters to ""
      return joined
    end elementText

    tell application "System Events"
      tell process "${escapeAppleScriptString(appName)}"
        set frontmost to true
        repeat with el in (entire contents)
          try
            set haystack to my elementText(el)
            set hit to false
            if "${escapeAppleScriptString(roleNeedle)}" is not "" then
              if haystack contains "${escapeAppleScriptString(roleNeedle)}" then
                set hit to true
              end if
            end if
            if "${escapeAppleScriptString(needle)}" is not "" then
              if haystack contains "${escapeAppleScriptString(needle)}" then
                set hit to true
              end if
            end if
            if hit then
              try
                click el
                return "clicked"
              on error
                try
                  perform action "AXPress" of el
                  return "clicked"
                end try
              end try
            end if
          end try
        end repeat
      end tell
    end tell
    return "not_found"
  `;

  const result = await runAppleScript(script);
  return {
    ...result,
    action: 'clickUi',
    app: appName,
    target,
  };
}

async function clickTextInChromeDom(text, { selector = '', timeoutMs = 4000 } = {}) {
  const needle = normalizeActionText(text);
  if (!needle) {
    return { ok: false, action: 'clickText', error: 'missing_text' };
  }

  const chromium = await getPlaywrightChromium();
  if (!chromium) {
    return { ok: false, action: 'clickText', error: 'playwright_unavailable' };
  }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222').catch(() => null);
  if (!browser) {
    return { ok: false, action: 'clickText', error: 'chrome_cdp_unavailable' };
  }

  const startedAt = Date.now();
  try {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          await page.bringToFront().catch(() => null);
          if (selector) {
            const selectorLocator = page.locator(selector).first();
            if (await selectorLocator.count()) {
              await selectorLocator.click({ timeout: timeoutMs });
              return {
                ok: true,
                action: 'clickText',
                strategy: 'dom',
                selector,
                text: needle,
                elapsedMs: Date.now() - startedAt,
                url: page.url(),
                title: await page.title().catch(() => ''),
              };
            }
          }

          const exactLocator = page.getByText(needle, { exact: false }).first();
          if (await exactLocator.count()) {
            await exactLocator.click({ timeout: timeoutMs });
            return {
              ok: true,
              action: 'clickText',
              strategy: 'dom',
              text: needle,
              elapsedMs: Date.now() - startedAt,
              url: page.url(),
              title: await page.title().catch(() => ''),
            };
          }
        } catch {
          // try next page
        }
      }
    }
  } finally {
    await browser.close().catch(() => null);
  }

  return {
    ok: false,
    action: 'clickText',
    strategy: 'dom',
    error: 'text_not_found',
    text: needle,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function clickUi(target = {}, targetApp = '') {
  const appName = normalizeAutomationTarget(targetApp || target.app);
  const strategy = String(target.strategy || target.preferredStrategy || 'hybrid').toLowerCase();
  const clickTarget = {
    role: target.role || '',
    text: target.text || target.contains || target.label || target.name || '',
    contains: target.contains || '',
    selector: target.selector || '',
    coords: target.coords || target.coordinates || target.point || target.selectorOrCoords || {},
  };

  const attempts = [];
  const shouldTryChromeDom = /chrome/i.test(appName) || /hybrid|dom/.test(strategy);
  if (shouldTryChromeDom && clickTarget.text) {
    const domResult = await clickTextInChromeDom(clickTarget.text, {
      selector: clickTarget.selector,
      timeoutMs: Number(target.timeoutMs || 4000),
    });
    attempts.push(domResult);
    if (domResult.ok) {
      return {
        ...domResult,
        action: 'clickUi',
        app: appName || 'Google Chrome',
        attempts,
        strategyUsed: 'dom',
      };
    }
  }

  const axResult = await clickUiByAccessibility({
    ...clickTarget,
    app: appName,
  }, appName);
  attempts.push(axResult);
  if (axResult.ok) {
    return {
      ...axResult,
      attempts,
      strategyUsed: 'ax',
    };
  }

  const coordResult = await clickCoordinates(clickTarget.coords);
  attempts.push(coordResult);
  return {
    ...coordResult,
    action: 'clickUi',
    app: appName,
    target: clickTarget,
    attempts,
    strategyUsed: 'coords',
    fallbackUsed: attempts.find((attempt) => attempt.ok)?.strategy || attempts.find((attempt) => attempt.ok)?.action || '',
  };
}

export async function clickText(text, targetApp = '', options = {}) {
  const appName = normalizeAutomationTarget(targetApp);
  const strategy = String(options.strategy || 'hybrid').toLowerCase();
  const attempts = [];

  if ((/chrome/i.test(appName) || strategy === 'hybrid' || strategy === 'dom') && text) {
    const domResult = await clickTextInChromeDom(text, options);
    attempts.push(domResult);
    if (domResult.ok) {
      return {
        ...domResult,
        action: 'clickText',
        app: appName || 'Google Chrome',
        attempts,
        strategyUsed: 'dom',
      };
    }
  }

  const axResult = await clickUiByAccessibility({
    app: appName,
    text,
    role: options.role || '',
    contains: options.contains || '',
  }, appName);
  attempts.push(axResult);
  if (axResult.ok) {
    return {
      ...axResult,
      action: 'clickText',
      attempts,
      strategyUsed: 'ax',
    };
  }

  if (options.coordinates || options.point || options.selectorOrCoords) {
    const coordResult = await clickCoordinates(options.coordinates || options.point || options.selectorOrCoords);
    attempts.push(coordResult);
    return {
      ...coordResult,
      action: 'clickText',
      app: appName,
      text,
      attempts,
      strategyUsed: 'coords',
    };
  }

  return {
    ok: false,
    action: 'clickText',
    app: appName,
    text,
    attempts,
    error: 'text_click_failed',
  };
}

export async function runShell(command, options = {}) {
  const shellCommand = normalizeActionText(command);
  if (!shellCommand) {
    return { ok: false, action: 'runShell', error: 'missing_command' };
  }

  const targetApp = normalizeAutomationTarget(options.app || '');
  const direct = options.direct !== false && !options.inFocusedTerminal;
  if (direct) {
    const result = await runCommand(options.shell || 'sh', ['-lc', shellCommand], {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    });
    return {
      ...result,
      action: 'runShell',
      mode: 'direct',
      command: shellCommand,
      cwd: options.cwd || process.cwd(),
    };
  }

  if (targetApp) {
    await ensureAppFrontmost(targetApp);
  }
  const typeResult = await typeText(shellCommand, targetApp);
  if (!typeResult.ok) {
    return {
      ...typeResult,
      action: 'runShell',
      mode: 'terminal',
      command: shellCommand,
    };
  }
  const enterResult = await pressShortcut({ key: 'return' }, targetApp);
  return {
    ...enterResult,
    action: 'runShell',
    mode: 'terminal',
    command: shellCommand,
    typed: typeResult.ok,
    app: targetApp || typeResult.app || 'focused-app',
  };
}

export async function waitFor(condition = {}) {
  const timeoutMs = Math.max(0, Number(condition.timeoutMs || condition.timeout || 1000));
  const sleepMs = Math.max(0, Number(condition.sleepMs || condition.delayMs || timeoutMs));
  await sleep(Math.min(timeoutMs, sleepMs));
  return {
    ok: true,
    action: 'waitFor',
    waitedMs: Math.min(timeoutMs, sleepMs),
    condition,
  };
}

export async function verifyAction(criteria = {}) {
  const type = String(criteria.type || criteria.verify || 'probe').toLowerCase();
  if (type === 'appRunning') {
    const appName = normalizeAutomationTarget(criteria.app || criteria.target || '');
    if (!appName) {
      return { ok: false, action: 'verify', error: 'missing_app' };
    }
    const result = await runAppleScript(`tell application "System Events" to get name of every process`);
    const running = result.ok && result.stdout.toLowerCase().includes(appName.toLowerCase());
    return {
      ...result,
      action: 'verify',
      ok: running,
      criteria,
      state: running ? 'verified' : 'not_verified',
    };
  }

  if (type === 'shell') {
    return runShell(criteria.command || criteria.script || criteria.value || '', {
      direct: true,
      cwd: criteria.cwd,
      shell: criteria.shell,
    });
  }

  return probeAutomation();
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
    case 'clickUi':
      return clickUi(action.target || action, app);
    case 'clickText':
      return clickText(action.text || action.target?.text || action.target || '', app, action);
    case 'type':
      return typeText(action.text, app);
    case 'shortcut':
      return pressShortcut(action.shortcut || { key: action.key, modifiers: action.modifiers }, app);
    case 'clickMenuItem':
      return clickMenuItem(action.menuPath || action.options?.menuPath || action.options || {}, app);
    case 'click':
      return clickCoordinates(action.selectorOrCoords || action.coordinates || action.point || action.options?.coordinates || {});
    case 'runShell':
      return runShell(action.command || action.text || action.script || '', {
        app,
        direct: action.direct,
        inFocusedTerminal: action.inFocusedTerminal,
        cwd: action.cwd,
        shell: action.shell,
        env: action.env,
      });
    case 'waitFor':
      return waitFor(action);
    case 'verify':
      return verifyAction(action);
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
