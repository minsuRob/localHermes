import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
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

async function findExecutable(name) {
  const result = await runCommand('sh', ['-lc', `command -v ${name}`]);
  return result.ok && result.stdout ? result.stdout : '';
}

async function sleep(ms = 0) {
  const duration = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, duration));
}

async function captureScreenshot(label = 'openhermes-screen') {
  const filePath = path.join(os.tmpdir(), `${label}-${Date.now()}.png`);
  const result = await runCommand('screencapture', ['-x', filePath]);
  return {
    ...result,
    path: filePath,
    action: 'screenshot',
  };
}

async function screenshotToDataUrl(imagePath) {
  try {
    const image = await readFile(imagePath);
    return `data:image/png;base64,${image.toString('base64')}`;
  } catch {
    return '';
  }
}

async function readImageDimensions(imagePath) {
  const result = await runCommand('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath]);
  if (!result.ok) {
    return { ok: false, width: 0, height: 0, raw: result.stderr };
  }
  const widthMatch = result.stdout.match(/pixelWidth:\s*(\d+)/i);
  const heightMatch = result.stdout.match(/pixelHeight:\s*(\d+)/i);
  return {
    ok: Boolean(widthMatch && heightMatch),
    width: Number(widthMatch?.[1] || 0),
    height: Number(heightMatch?.[1] || 0),
    raw: result.stdout,
  };
}

async function ocrScreenshot(imagePath) {
  const tesseract = await findExecutable('tesseract');
  if (!tesseract) {
    return {
      ok: false,
      action: 'ocr',
      error: 'tesseract_not_installed',
      text: '',
    };
  }

  const result = await runCommand(tesseract, [imagePath, 'stdout', '--psm', '6']);
  return {
    ...result,
    action: 'ocr',
    text: result.stdout || '',
  };
}

async function captureObservedScreen(label = 'openhermes-screen') {
  const screenshot = await captureScreenshot(label);
  if (screenshot.ok) {
    screenshot.dataUrl = await screenshotToDataUrl(screenshot.path);
  }
  const ocr = screenshot.ok ? await ocrScreenshot(screenshot.path) : { ok: false, text: '', error: 'screenshot_failed' };
  return {
    screenshot,
    ocr,
    text: ocr.text || '',
  };
}

async function getFrontmostProcessState() {
  const result = await runAppleScript(`
    tell application "System Events"
      set frontAppName to name of first application process whose frontmost is true
      return frontAppName
    end tell
  `);
  return {
    ...result,
    action: 'frontmost',
    app: result.ok ? result.stdout : '',
  };
}

async function getWindowTitleForApp(appName = '') {
  const target = normalizeAutomationTarget(appName);
  if (!target) {
    return { ok: false, action: 'windowTitle', error: 'missing_app' };
  }

  const script = `
    tell application "System Events"
      tell process "${escapeAppleScriptString(target)}"
        if (count of windows) is 0 then return ""
        return name of front window
      end tell
    end tell
  `;
  const result = await runAppleScript(script);
  return {
    ...result,
    action: 'windowTitle',
    app: target,
    title: result.ok ? result.stdout : '',
  };
}

async function getWindowBoundsForApp(appName = '') {
  const target = normalizeAutomationTarget(appName);
  if (!target) {
    return { ok: false, action: 'windowBounds', error: 'missing_app' };
  }

  const script = `
    tell application "System Events"
      tell process "${escapeAppleScriptString(target)}"
        if (count of windows) is 0 then return ""
        set b to bounds of front window
        return (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b)
      end tell
    end tell
  `;
  const result = await runAppleScript(script);
  const parts = String(result.ok ? result.stdout : '').split(',').map((value) => Number(value.trim()));
  const [left, top, right, bottom] = parts;
  const valid = parts.length === 4 && parts.every((value) => Number.isFinite(value));
  return {
    ...result,
    action: 'windowBounds',
    app: target,
    bounds: valid ? { left, top, right, bottom } : null,
  };
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


function normalizeVerificationType(value = '') {
  return String(value || '').trim().toLowerCase();
}

function extractTerminalVerificationTokens(stdout = '', command = '') {
  const output = String(stdout || '').trim();
  if (!output) return [];

  const tokens = new Set();
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const normalizedCommand = String(command || '').trim().toLowerCase();

  for (const line of lines) {
    if (/^total\s+\d+/i.test(line)) {
      continue;
    }

    const parts = line.split(/\s+/).filter(Boolean);
    const candidate = parts.at(-1) || '';
    if (candidate && /[A-Za-z0-9._/-]/.test(candidate) && candidate.length <= 80) {
      tokens.add(candidate);
    }

    if (/^[A-Za-z0-9._/-]+$/.test(line) && line.length <= 80) {
      tokens.add(line);
    }
  }

  if (/^pwd(\s|$)/i.test(normalizedCommand)) {
    tokens.add(output);
    const lastLine = lines.at(-1) || '';
    if (lastLine) tokens.add(lastLine);
  }

  return [...tokens].filter(Boolean).slice(0, 8);
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
  if (result.ok) {
    return { ...result, action: 'type', app: appName || 'focused-app', text: content, mode: 'osascript' };
  }
  const fallbackScript = String.raw`import ctypes

framework = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')

CGEventCreateKeyboardEvent = framework.CGEventCreateKeyboardEvent
CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]

CGEventKeyboardSetUnicodeString = framework.CGEventKeyboardSetUnicodeString
CGEventKeyboardSetUnicodeString.restype = None
CGEventKeyboardSetUnicodeString.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_uint16)]

CGEventPost = framework.CGEventPost
CGEventPost.restype = None
CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

kCGHIDEventTap = 0
text = ${JSON.stringify(content)}
for ch in text:
    buf = (ctypes.c_uint16 * 1)(ord(ch))
    down = CGEventCreateKeyboardEvent(None, 0, True)
    CGEventKeyboardSetUnicodeString(down, 1, buf)
    CGEventPost(kCGHIDEventTap, down)
    up = CGEventCreateKeyboardEvent(None, 0, False)
    CGEventKeyboardSetUnicodeString(up, 1, buf)
    CGEventPost(kCGHIDEventTap, up)
`;
  const fallback = await runCommand('python3', ['-c', fallbackScript]);
  return {
    ...(fallback.ok ? fallback : result),
    action: 'type',
    app: appName || 'focused-app',
    text: content,
    mode: fallback.ok ? 'coregraphics' : 'osascript',
    fallback: fallback.ok ? null : fallback,
  };
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
  if (result.ok) {
    return { ...result, action: 'shortcut', app: appName || 'focused-app', shortcut, mode: 'osascript' };
  }
  const keyName = String(key || '').toLowerCase();
  const keyCodeByName = { return: 36, enter: 36, tab: 48, space: 49, escape: 53, esc: 53, delete: 51, backspace: 51, left: 123, right: 124, down: 125, up: 126 };
  const keyCode = Object.prototype.hasOwnProperty.call(keyCodeByName, keyName) ? keyCodeByName[keyName] : 0;
  const flagLines = [];
  for (const modifier of modifiers || []) {
    const normalized = String(modifier || '').toLowerCase();
    if (normalized === 'cmd' || normalized === 'command') flagLines.push('flags |= kCGEventFlagMaskCommand');
    else if (normalized === 'shift') flagLines.push('flags |= kCGEventFlagMaskShift');
    else if (normalized === 'alt' || normalized === 'option') flagLines.push('flags |= kCGEventFlagMaskAlternate');
    else if (normalized === 'ctrl' || normalized === 'control') flagLines.push('flags |= kCGEventFlagMaskControl');
  }
  const fallbackScript = String.raw`import ctypes

framework = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')

CGEventCreateKeyboardEvent = framework.CGEventCreateKeyboardEvent
CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]

CGEventSetFlags = framework.CGEventSetFlags
CGEventSetFlags.restype = None
CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]

CGEventPost = framework.CGEventPost
CGEventPost.restype = None
CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

kCGEventFlagMaskCommand = 1 << 20
kCGEventFlagMaskShift = 1 << 17
kCGEventFlagMaskAlternate = 1 << 19
kCGEventFlagMaskControl = 1 << 18
kCGHIDEventTap = 0
flags = 0
${flagLines.join('\n')}
key_code = ${keyCode}
for is_down in (True, False):
    event = CGEventCreateKeyboardEvent(None, key_code, is_down)
    if flags:
        CGEventSetFlags(event, flags)
    CGEventPost(kCGHIDEventTap, event)
`;
  const fallback = await runCommand('python3', ['-c', fallbackScript]);
  return {
    ...(fallback.ok ? fallback : result),
    action: 'shortcut',
    app: appName || 'focused-app',
    shortcut,
    mode: fallback.ok ? 'coregraphics' : 'osascript',
    fallback: fallback.ok ? null : fallback,
  };
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

  if (!coordResult.ok && /zed/i.test(appName) && /^\+$/.test(clickTarget.text || '')) {
    const screenshot = await captureScreenshot('openhermes-zed-click-fallback');
    attempts.push(screenshot);
    const dimensions = screenshot.ok ? await readImageDimensions(screenshot.path) : { ok: false, width: 0, height: 0 };
    attempts.push(dimensions);
    if (dimensions.ok && dimensions.width > 0 && dimensions.height > 0) {
      const fallbackPoint = {
        x: Math.round(dimensions.width * 0.77),
        y: Math.round(dimensions.height * 0.57),
      };
      const zedFallback = await clickCoordinates(fallbackPoint);
      attempts.push(zedFallback);
      if (zedFallback.ok) {
        return {
          ...zedFallback,
          action: 'clickUi',
          app: appName,
          target: clickTarget,
          attempts,
          strategyUsed: 'coords-fallback',
          fallbackUsed: 'zed-screen-ratio',
        };
      }
    }
  }

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
  const observed = await captureObservedScreen('openhermes-runShell-terminal').catch(() => null);
  return {
    ...enterResult,
    action: 'runShell',
    mode: 'terminal',
    command: shellCommand,
    typed: typeResult.ok,
    app: targetApp || typeResult.app || 'focused-app',
    screenshot: observed?.screenshot || null,
    ocr: observed?.ocr || null,
    observedText: observed?.text || '',
  };
}

export async function waitFor(condition = {}) {
  const timeoutMs = Math.max(0, Number(condition.timeoutMs || condition.timeout || 1000));
  const sleepMs = Math.max(25, Number(condition.sleepMs || condition.delayMs || 250));
  const normalizedCondition = { ...condition };
  if (!normalizedCondition.type) {
    if (normalizedCondition.command || normalizedCondition.script || normalizedCondition.value) {
      normalizedCondition.type = 'shell';
    } else if (normalizedCondition.text || normalizedCondition.contains || normalizedCondition.title) {
      normalizedCondition.type = 'screenTextContains';
    } else if (normalizedCondition.app) {
      normalizedCondition.type = 'frontmostApp';
    }
  }
  const hasMeaningfulCondition = Boolean(
    normalizedCondition.type ||
    normalizedCondition.app ||
    normalizedCondition.text ||
    normalizedCondition.command ||
    normalizedCondition.title,
  );

  if (!hasMeaningfulCondition) {
    await sleep(Math.min(timeoutMs, sleepMs));
    return {
      ok: true,
      action: 'waitFor',
      waitedMs: Math.min(timeoutMs, sleepMs),
      condition,
    };
  }

  const deadline = Date.now() + timeoutMs;
  let lastCheck = null;

  while (Date.now() <= deadline) {
    lastCheck = await verifyAction(normalizedCondition);
    if (lastCheck?.ok !== false) {
      return {
        ok: true,
        action: 'waitFor',
        waitedMs: Math.max(0, timeoutMs - Math.max(0, deadline - Date.now())),
        condition: normalizedCondition,
        check: lastCheck,
      };
    }
    await sleep(sleepMs);
  }

  return {
    ok: false,
    action: 'waitFor',
    waitedMs: timeoutMs,
    condition: normalizedCondition,
    check: lastCheck,
    error: 'condition_timeout',
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

  if (type === 'frontmostapp' || type === 'frontmost') {
    const appName = normalizeAutomationTarget(criteria.app || criteria.target || '');
    if (!appName) {
      return { ok: false, action: 'verify', error: 'missing_app' };
    }
    const result = await getFrontmostProcessState();
    const frontmost = result.ok && result.stdout.toLowerCase().includes(appName.toLowerCase());
    return {
      ...result,
      action: 'verify',
      ok: frontmost,
      criteria,
      state: frontmost ? 'verified' : 'not_verified',
    };
  }

  if (type === 'windowtitle' || type === 'windowtitlecontains') {
    const appName = normalizeAutomationTarget(criteria.app || criteria.target || '');
    const needle = normalizeActionText(criteria.text || criteria.contains || criteria.title || criteria.value || '');
    if (!appName || !needle) {
      return { ok: false, action: 'verify', error: 'missing_target' };
    }
    const result = await getWindowTitleForApp(appName);
    const matched = result.ok && String(result.stdout || result.title || '').toLowerCase().includes(needle.toLowerCase());
    return {
      ...result,
      action: 'verify',
      ok: matched,
      criteria,
      state: matched ? 'verified' : 'not_verified',
    };
  }

  if (type === 'screentextcontains' || type === 'ocrcontains' || type === 'screencontains') {
    const needle = normalizeActionText(criteria.text || criteria.contains || criteria.value || '');
    if (!needle) {
      return { ok: false, action: 'verify', error: 'missing_text' };
    }
    const observed = await captureObservedScreen('openhermes-verify');
    if (observed?.screenshot?.ok && !observed.screenshot.dataUrl) {
      observed.screenshot.dataUrl = await screenshotToDataUrl(observed.screenshot.path);
    }
    const matched = String(observed.text || '').toLowerCase().includes(needle.toLowerCase());
    return {
      ok: matched,
      action: 'verify',
      criteria,
      state: matched ? 'verified' : 'not_verified',
      screenshot: observed.screenshot,
      ocr: observed.ocr,
      observedText: observed.text,
    };
  }

  if (type === 'shell' || type === 'terminaloutputvisible' || type === 'terminalvisible' || type === 'shellvisible') {
    const command = criteria.command || criteria.script || criteria.value || '';
    const shellResult = await runShell(command, {
      direct: true,
      cwd: criteria.cwd,
      shell: criteria.shell,
    });

    if (!shellResult.ok) {
      return {
        ...shellResult,
        action: 'verify',
        criteria,
        state: 'not_verified',
      };
    }

    if (type === 'shell') {
      return {
        ...shellResult,
        action: 'verify',
        criteria,
        state: 'verified',
      };
    }

    const observed = await captureObservedScreen('openhermes-terminal-verify');
    if (observed?.screenshot?.ok && !observed.screenshot.dataUrl) {
      observed.screenshot.dataUrl = await screenshotToDataUrl(observed.screenshot.path);
    }
    const observedText = String(observed.text || '').trim();
    const tokens = extractTerminalVerificationTokens(shellResult.stdout || shellResult.stderr || '', command);
    const observedLower = observedText.toLowerCase();
    const matchedToken = tokens.find((token) => observedLower.includes(String(token).toLowerCase()));
    const verified = tokens.length === 0 || Boolean(matchedToken);

    return {
      ...(verified ? shellResult : { ...shellResult, ok: false }),
      action: 'verify',
      criteria,
      state: verified ? 'verified' : 'not_verified',
      verifyMode: 'terminal-output-visible',
      tokens,
      matchedToken: matchedToken || '',
      observedText,
      screenshot: observed.screenshot,
      ocr: observed.ocr,
      error: verified ? shellResult.error || '' : 'terminal_output_not_visible',
    };
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
  const coreGraphicsScript = `
import ctypes
import ctypes.util
import sys

class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]

framework = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
framework.CGEventCreateMouseEvent.restype = ctypes.c_void_p
framework.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
framework.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
framework.CGEventPost.restype = None

point = CGPoint(float(sys.argv[1]), float(sys.argv[2]))
left_down = 1
left_up = 2
hid_event_tap = 0
mouse_button_left = 0

down = framework.CGEventCreateMouseEvent(None, left_down, point, mouse_button_left)
framework.CGEventPost(hid_event_tap, down)
up = framework.CGEventCreateMouseEvent(None, left_up, point, mouse_button_left)
framework.CGEventPost(hid_event_tap, up)
print('clicked')
`;
  const coreGraphicsResult = await runCommand('python3', ['-c', coreGraphicsScript, `${Math.round(x)}`, `${Math.round(y)}`]);
  if (coreGraphicsResult.ok) {
    return {
      ...coreGraphicsResult,
      action: 'click',
      point: { x: Math.round(x), y: Math.round(y) },
      strategy: 'coregraphics',
    };
  }
  return {
    ok: false,
    action: 'click',
    error: 'click_backend_unavailable',
    point: { x: Math.round(x), y: Math.round(y) },
  };
}

export async function probeAutomation() {
  const results = {};
  results.frontmost = await getFrontmostProcessState();
  results.accessibility = await runAppleScript('tell application "System Events" to get name of first application process');
  const observed = await captureObservedScreen('openhermes-probe');
  results.screenRecording = {
    ...observed.screenshot,
    text: observed.text,
    ocr: observed.ocr,
  };
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
