import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const MAIN_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSdDSkF4Kzr6SUWyGs7TEgDoIV_HkhxyrIzkMfmYfQjC1qyKsw/viewform';
const UPLOAD_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSe0O-Rez1ZRr4o8SYriZJFqwP7FmRitGjURSz8tb5L4VQhZFw/viewform';
const E = { reference: 'entry.991851856', device: 'entry.1052076762', source: 'entry.566921339' };
const UPLOAD_REF = 'entry.370601510';
const REF = /^FB-[2-9A-HJ-NP-Z]{6}$/;

// No test may reach a real Google Form, or anything else outside this machine. Every outside
// request is aborted and recorded, so the tests run offline and can check the page asks for none.
async function guard(context) {
  const outside = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://localhost:')) return route.continue();
    outside.push(url);
    return route.abort();
  });
  return { outside };
}

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

// How many Figtree faces the browser has loaded, once it's done loading fonts
const figtreeLoaded = page => page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].filter(f => f.family.replace(/["']/g, '') === 'Figtree' && f.status === 'loaded').length;
});

test.describe('welcome page', () => {
  test('leaves out the review-only parts and stays out of search engines', async ({ page, context, request }) => {
    await guard(context);
    await page.goto('/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('.review, #palette-btn, #clean-btn, .tbd, .ph, .ph-label')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-palette'))).toBe(false);
    expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
  });

  test('loads Figtree from this site and asks nothing of Google or anyone else', async ({ page, context }) => {
    const { outside } = await guard(context);
    const fonts = [];
    page.on('response', r => { if (r.url().endsWith('.woff2')) fonts.push([new URL(r.url()).pathname, r.status(), r.headers()['content-type']]); });
    await page.goto('/');
    await page.waitForLoadState('load');
    expect(await figtreeLoaded(page)).toBeGreaterThan(0);
    expect(fonts.length).toBeGreaterThan(0);
    for (const [path, status, type] of fonts) {
      expect(path).toMatch(/^\/fonts\/figtree-[a-z-]+\.woff2$/);
      expect(status).toBe(200);
      expect(type).toBe('font/woff2');
    }
    await expect(page.locator('h1').first()).toHaveCSS('font-family', /^"?Figtree"?,/);
    expect(outside).toEqual([]);
  });

  for (const width of [1280, 390, 320]) {
    test(`lays out at ${width}px with no sideways scroll, broken links or script errors`, async ({ page, context }) => {
      await guard(context);
      const errors = trackErrors(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const missing = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')]
        .map(a => a.getAttribute('href'))
        .filter(h => h.length > 1 && !document.getElementById(h.slice(1))));
      expect(missing).toEqual([]);
      const unloaded = await page.evaluate(() => [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.src));
      expect(unloaded).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('every placeholder on the page is in PLACEHOLDERS.md, and every listed one is on the page', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    const onPage = await page.evaluate(() => [...document.querySelectorAll('[data-ph]')].map(e => e.dataset.ph));
    const listed = [...(await readFile('PLACEHOLDERS.md', 'utf8')).matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(m => m[1]);
    expect(new Set(onPage).size).toBe(onPage.length);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...onPage].sort()).toEqual([...listed].sort());
  });

  test('a #faq-<question> link opens that answer', async ({ page, context }) => {
    await guard(context);
    await page.goto('/#faq-passkey');
    await expect(page.locator('#faq-passkey')).toHaveAttribute('open', '');
    await expect(page.locator('#faq-passkey summary')).toBeFocused();
    await expect(page.locator('#faq-passkey summary')).toBeInViewport();
  });

  test('every FAQ answer has an id a #faq-<question> link can open', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    const ids = await page.locator('#faq details.qa').evaluateAll(ds => ds.map(d => d.id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id, 'only letters after faq-, or the link handler ignores it').toMatch(/^faq-[a-z]+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the comparison steps through and starts over', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    await page.click('#ax-btn');
    await expect(page.locator('#ax-step')).toHaveText('Step 2 of 3');
    await page.click('#ax-btn');
    await expect(page.locator('#ax-step')).toHaveText('Step 3 of 3');
    await expect(page.locator('#ax-btn')).toBeHidden();
    await page.click('#ax-reset');
    await expect(page.locator('#ax-step')).toHaveText('Step 1 of 3');
  });

  test('the phone menu opens and closes on a link', async ({ page, context }) => {
    await guard(context);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/');
    await page.click('#menu-btn');
    await expect(page.locator('#mobile-menu')).toBeVisible();
    await page.click('#mobile-menu a[href="#faq"]');
    await expect(page.locator('#mobile-menu')).toBeHidden();
  });

  test('sign-up is a mock-up: it checks the fields, shows the done state and sends nothing', async ({ page, context }) => {
    const { outside } = await guard(context);
    await page.goto('/');
    const submit = page.locator('#access-form button[type=submit]');
    await submit.click();
    await expect(page.locator('#access-err')).toHaveText('Enter your name.');
    await expect(page.locator('#access-name')).toBeFocused();
    await page.fill('#access-name', 'Test Person');
    await page.fill('#access-email', 'not-an-email');
    await submit.click();
    await expect(page.locator('#access-err')).toContainText('Check your email address.');
    await page.fill('#access-email', 'test@example.org');
    await submit.click();
    await expect(page.locator('#access-done')).toBeVisible();
    await expect(page.locator('#access-to')).toHaveText('test@example.org');
    expect(outside).toEqual([]);
  });

  test('there is no in-page feedback form any more', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    await expect(page.locator('dialog, form#fb-form, #fb')).toHaveCount(0);
    expect(await page.evaluate(() => /formResponse/.test(document.documentElement.innerHTML))).toBe(false);
  });
});

// What the feedback page's two links say, read from the page
async function links(page) {
  const main = new URL(await page.getAttribute('#fb-main', 'href'));
  const up = new URL(await page.getAttribute('#fb-up', 'href'));
  return { main, up, ref: await page.textContent('#fb-ref') };
}

test.describe('feedback page', () => {
  for (const width of [1280, 390]) {
    test(`/feedback?from=wallet links out to both Google Forms, filled in (${width}px)`, async ({ page, context }) => {
      const { outside } = await guard(context);
      const errors = trackErrors(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/feedback?from=wallet');
      await expect(page).toHaveURL(/\/feedback\/\?from=wallet$/);
      await expect(page).toHaveTitle(/^Share feedback · /);
      await expect(page.locator('body')).toHaveClass(/fbp-on/);
      for (const hidden of ['.hero', '#faq', '.site-nav']) await expect(page.locator(hidden)).toBeHidden();
      await expect(page.getByRole('heading', { level: 1, name: 'Share feedback' })).toBeVisible();
      await expect(page.locator('#fbp-h')).toBeFocused();
      await expect(page.locator('#fbp-wallet')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);

      const { main, up, ref } = await links(page);
      expect(ref).toMatch(REF);
      expect(main.origin + main.pathname).toBe(MAIN_FORM);
      expect(main.searchParams.get('usp')).toBe('pp_url');
      expect(main.searchParams.get(E.reference)).toBe(ref);
      expect(main.searchParams.get(E.source)).toBe('Feedback page: wallet');
      expect(main.searchParams.get(E.device)).toMatch(/^(Chrome|Safari|Firefox|Edge|Opera|another browser) on .+ \| Mozilla\/5\.0 .+ \| \d+x\d+$/);
      expect(main.searchParams.get(E.device).startsWith(await page.textContent('#fb-device') + ' | ')).toBe(true);
      expect(up.origin + up.pathname).toBe(UPLOAD_FORM);
      expect(up.searchParams.get('usp')).toBe('pp_url');
      expect(up.searchParams.get(UPLOAD_REF)).toBe(ref);
      expect([...up.searchParams.keys()].sort()).toEqual([UPLOAD_REF, 'usp'].sort());   // the upload form gets only the reference

      // Both open in a new tab, say so to screen readers, and the link the tab asks for is the one on the page
      for (const id of ['#fb-main', '#fb-up']) {
        await expect(page.locator(id)).toHaveAttribute('target', '_blank');
        await expect(page.locator(id)).toHaveAttribute('rel', 'noopener');
        await expect(page.locator(id)).toHaveAccessibleName(/\(opens Google Forms in a new tab\)$/);
      }
      expect(outside).toEqual([]);   // nothing goes to Google until the tester opens a form
      const [tab] = await Promise.all([context.waitForEvent('page'), page.click('#fb-main')]);
      await expect.poll(() => outside.length).toBe(1);
      expect(outside[0]).toBe(main.href);
      await tab.close();
      expect(errors).toEqual([]);
    });
  }

  test('/feedback without ?from= records "Feedback page" and leaves out the wallet line', async ({ page, context }) => {
    await guard(context);
    await page.goto('/feedback');
    const { main } = await links(page);
    expect(main.searchParams.get(E.source)).toBe('Feedback page');
    await expect(page.locator('#fbp-wallet')).toBeHidden();
  });

  test('each visit gets a new reference', async ({ page, context }) => {
    await guard(context);
    await page.goto('/feedback?from=wallet');
    const first = (await links(page)).ref;
    await page.reload();
    const second = await links(page);
    expect(second.ref).toMatch(REF);
    expect(second.ref).not.toBe(first);
    expect(second.main.searchParams.get(E.reference)).toBe(second.ref);
    expect(second.up.searchParams.get(UPLOAD_REF)).toBe(second.ref);
  });

  test('Figtree loads on the feedback page too, one folder down', async ({ page, context }) => {
    const { outside } = await guard(context);
    await page.goto('/feedback?from=wallet');
    await page.waitForLoadState('load');
    expect(await figtreeLoaded(page)).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });

  for (const from of ['try-it', 'get-involved']) {
    test(`the welcome page's Share feedback link (${from}) opens the page and records where`, async ({ page, context }) => {
      await guard(context);
      await page.goto('/');
      await page.click(`a[href="feedback/?from=${from}"]`);
      await expect(page).toHaveURL(`/feedback/?from=${from}`);
      await expect(page.locator('body')).toHaveClass(/fbp-on/);
      expect((await links(page)).main.searchParams.get(E.source)).toBe(`Feedback page: ${from}`);
      await expect(page.locator('#fbp-wallet')).toBeHidden();
    });
  }

  test('both Share feedback links on the welcome page go to the feedback page', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    const hrefs = await page.getByRole('link', { name: 'Share feedback' }).evaluateAll(as => as.map(a => a.getAttribute('href')));
    expect(hrefs.sort()).toEqual(['feedback/?from=get-involved', 'feedback/?from=try-it']);
  });

  test('an old #feedback link goes to the feedback page, keeping ?from=', async ({ page, context }) => {
    await guard(context);
    const errors = trackErrors(page);
    await page.goto('/?from=email#feedback');
    await expect(page).toHaveURL('/feedback/?from=email');
    expect((await links(page)).main.searchParams.get(E.source)).toBe('Feedback page: email');
    await page.goto('/#feedback');
    await expect(page).toHaveURL('/feedback/');
    expect((await links(page)).main.searchParams.get(E.source)).toBe('Feedback page');
    expect(errors).toEqual([]);
  });

  test('#feedback added while the welcome page is open goes to the feedback page', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    await page.evaluate(() => { location.hash = '#feedback'; });
    await expect(page).toHaveURL('/feedback/');
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
  });

  test('#feedback on the feedback page stays there', async ({ page, context }) => {
    await guard(context);
    const errors = trackErrors(page);
    await page.goto('/feedback?from=wallet#feedback');
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
    const ref = (await links(page)).ref;
    await page.evaluate(() => { window.notReloaded = true; location.hash = '#feedback'; });
    await expect(page).toHaveURL('/feedback/?from=wallet');
    await expect(page.locator('#fbp-h')).toBeFocused();
    expect(await page.evaluate(() => window.notReloaded)).toBe(true);
    expect((await links(page)).ref).toBe(ref);
    expect(errors).toEqual([]);
  });

  test('the logo goes back to the welcome page', async ({ page, context }) => {
    await guard(context);
    await page.goto('/feedback?from=wallet');
    await page.click('.site-header .brand');
    await expect(page).toHaveURL('/');
    await expect(page.locator('body')).not.toHaveClass(/fbp-on/);
    await expect(page.locator('.hero')).toBeVisible();
  });

  test('/feedback/index.html is the feedback page too, and other paths are not', async ({ page, context }) => {
    await guard(context);
    await page.goto('/feedback/index.html?from=wallet');
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
    await page.goto('/index.html');
    await expect(page.locator('body')).not.toHaveClass(/fbp-on/);
    await expect(page.locator('.hero')).toBeVisible();
  });

  test('a malformed address gets an error, and the local server keeps running', async ({ request }) => {
    expect((await request.get('/%')).status()).toBe(400);
    // An address that can't be parsed at all, sent raw because browsers won't send it
    const raw = await new Promise((ok, fail) => {
      const port = Number(new URL(test.info().project.use.baseURL).port);
      const s = connect(port, 'localhost', () => s.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let out = ''; s.on('data', d => out += d); s.on('end', () => ok(out)); s.on('error', fail);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    expect((await request.get('/')).status()).toBe(200);
  });

  test('Back and Forward move between the welcome page and the feedback page', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    await page.goto('/feedback?from=wallet');
    await page.goBack();
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/fbp-on/);
    await page.goForward();
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
    await expect(page.locator('#fb-main')).toBeVisible();
  });
});

// GitHub Pages serves this repo's site in a folder (/lcw-welcome/), not at the root of the host.
test.describe('served in a folder, as on GitHub Pages', () => {
  const BASE = '/lcw-welcome/';
  let server, ROOT;
  // PORT=0: the server takes any free port and prints its address, so parallel copies of these tests
  // (as with --repeat-each) each get their own server instead of colliding on one port.
  test.beforeAll(async () => {
    server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: '0', BASE }, stdio: ['ignore', 'pipe', 'inherit'] });
    ROOT = await new Promise((ok, fail) => { server.stdout.once('data', d => ok(String(d).trim())); server.once('exit', fail); });
  });
  test.afterAll(() => server?.kill());

  const imagesLoaded = page => page.evaluate(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
  const iconLoads = page => page.evaluate(async () => (await fetch(document.querySelector('link[rel=icon]').href)).ok);

  test('the welcome page loads its images, icon and font', async ({ page, context }) => {
    const { outside } = await guard(context);
    const errors = trackErrors(page);
    await page.goto(ROOT + '/lcw-welcome');
    await expect(page).toHaveURL(ROOT + BASE);
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/fbp-on/);
    await page.waitForLoadState('load');
    expect(await imagesLoaded(page)).toBe(true);
    expect(await iconLoads(page)).toBe(true);
    expect(await figtreeLoaded(page)).toBeGreaterThan(0);
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('/feedback?from=wallet is the feedback page, with its font, and the logo goes back', async ({ page, context }) => {
    const { outside } = await guard(context);
    const errors = trackErrors(page);
    await page.goto(ROOT + BASE + 'feedback?from=wallet');
    await expect(page).toHaveURL(ROOT + BASE + 'feedback/?from=wallet');
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
    await page.waitForLoadState('load');
    expect(await imagesLoaded(page)).toBe(true);
    expect(await iconLoads(page)).toBe(true);
    expect(await figtreeLoaded(page)).toBeGreaterThan(0);
    expect((await links(page)).main.searchParams.get(E.source)).toBe('Feedback page: wallet');
    expect(outside).toEqual([]);
    await page.click('.site-header .brand');
    await expect(page).toHaveURL(ROOT + BASE);
    await expect(page.locator('.hero')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the Share feedback links and #feedback stay in the folder', async ({ page, context }) => {
    await guard(context);
    await page.goto(ROOT + BASE);
    await page.click('a[href="feedback/?from=get-involved"]');
    await expect(page).toHaveURL(ROOT + BASE + 'feedback/?from=get-involved');
    await page.goto(ROOT + BASE + '?from=email#feedback');
    await expect(page).toHaveURL(ROOT + BASE + 'feedback/?from=email');
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
  });
});
