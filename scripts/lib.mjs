// Shared helpers for the Playwright login script (adapted from familysearch-mcp).
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

export const configDir = process.env.LINKEDIN_JOBS_MCP_DIR || join(homedir(), '.linkedin-jobs-mcp');
export const configPath = join(configDir, 'config.json');

const BROWSER_PATHS = {
  darwin: [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/snap/bin/brave',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  win32: [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Google/Chrome/Application/chrome.exe'),
  ],
};

export function findBrowserExecutable() {
  const configuredPath = process.env.LINKEDIN_BROWSER_PATH || process.env.BRAVE_PATH;
  if (configuredPath && existsSync(configuredPath)) return configuredPath;
  return (BROWSER_PATHS[platform()] || []).find((path) => existsSync(path)) || null;
}

export const BROWSER_LAUNCH_OPTIONS = {
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
};

