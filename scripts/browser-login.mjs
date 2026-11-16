#!/usr/bin/env node
/**
 * Opens your installed Brave/Chrome with a separate profile so you log in to
 * LinkedIn by hand. Only the linkedin.com cookies are saved, to
 * ~/.linkedin-jobs-mcp/config.json (mode 0600). Your password never passes
 * through this script or through the AI conversation.
 *
 * Usage: npm run login
 */
import { chromium } from 'playwright';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BROWSER_LAUNCH_OPTIONS, configDir, configPath, findBrowserExecutable } from './lib.mjs';

const browserProfileDir = join(configDir, 'browser-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saveConfig(config) {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, configPath);
  chmodSync(configPath, 0o600);
}

// The li_at cookie alone is not proof: it can exist on a half-finished login
// (2FA, checkpoint). Ask LinkedIn who we are; it only answers once you are in.
async function whoAmI(context, cookies) {
  const jsession = cookies.find((c) => c.name === 'JSESSIONID')?.value?.replace(/"/g, '');
  if (!jsession) return null;
  try {
    const res = await context.request.get('https://www.linkedin.com/voyager/api/me', {
      headers: { 'csrf-token': jsession, 'x-restli-protocol-version': '2.0.0', accept: 'application/json' },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    if (!res.ok()) return null;
    const data = await res.json();
    const mini = data?.miniProfile ?? data?.included?.find((i) => i.firstName) ?? {};
    return { name: [mini.firstName, mini.lastName].filter(Boolean).join(' ') || 'LinkedIn user' };
  } catch {
    return null;
  }
}

async function waitForLogin(context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let announced = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies(['https://www.linkedin.com']).catch(() => []);
    if (cookies.some((c) => c.name === 'li_at')) {
      const user = await whoAmI(context, cookies);
      if (user) return { user, cookies };
      if (!announced) {
        console.error('Session cookie found; waiting for LinkedIn to finish the login (2FA / checkpoint)...');
        announced = true;
      }
    }
    await sleep(POLL_MS);
  }
  return null;
}

async function main() {
  const browserPath = findBrowserExecutable();
  if (!browserPath) {
    console.error('No supported Brave, Chrome, or Chromium browser found. Set LINKEDIN_BROWSER_PATH to your browser executable.');
    process.exit(1);
  }
  if (!existsSync(browserProfileDir)) mkdirSync(browserProfileDir, { recursive: true, mode: 0o700 });

  console.error(`Opening browser for LinkedIn login (${browserPath})...`);
  console.error('Sign in at linkedin.com. This window waits up to 10 minutes.');

  const context = await chromium.launchPersistentContext(browserProfileDir, {
    executablePath: browserPath,
    viewport: null,
    ...BROWSER_LAUNCH_OPTIONS,
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.linkedin.com/login');

  const login = await waitForLogin(context);
  if (!login) {
    console.error('Timed out waiting for login. Run login-with-browser again.');
    await context.close();
    process.exit(1);
  }

  const cookies = login.cookies.filter((c) => c.domain.endsWith('linkedin.com'));
  saveConfig({
    cookies: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    userName: login.user.name,
    savedAt: new Date().toISOString(),
  });
  console.error(`Signed in as ${login.user.name}. Session saved to ${configPath}`);
  await context.close();
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
