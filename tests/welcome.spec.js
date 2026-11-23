import { test, expect } from '@playwright/test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const FORM_POST = /^https:\/\/docs\.google\.com\/forms\/.*\/formResponse/;
const E = { trying: 'entry.413115414', happened: 'entry.667984208', screenshot: 'entry.991851856', email: 'entry.205670620', device: 'entry.1052076762', source: 'entry.566921339' };
const UPLOAD_REF = 'entry.370601510';

// No test may reach a real Google Form, or anything else outside this machine. Posts to the
// feedback form are captured and answered here (or refused, with failSend); every other outside
// request is aborted and recorded, Google Fonts included, so the tests also run offline.
async function guard(context, { failSend = false } = {}) {
  const posts = [], outside = [];
  await context.route('**/*', route => {
    const req = route.request(), url = req.url();
    if (url.startsWith('http://localhost:')) return route.continue();
    if (FORM_POST.test(url) && !failSend) { posts.push(new URLSearchParams(req.postData() || '')); return route.fulfill({ status: 200, body: '' }); }
    outside.push(url);
    return route.abort();
  });
  return { posts, outside };
}
const notFonts = urls => urls.filter(u => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));

// Clicks "Add screenshots" and returns the address the new tab asked for. The guard blocks the
// request itself, so the tab ends on an error page; it is closed straight away.
async function openUpload(context, page) {
  const [tab, req] = await Promise.all([
    context.waitForEvent('page'),
    context.waitForEvent('request', r => r.url().includes('/viewform')),
    page.click('#fb-up'),
  ]);
  await tab.close();
  return req.url();
}

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

test.describe('welcome page', () => {
  test('leaves out the review-only parts and stays out of search engines', async ({ page, context, request }) => {
    await guard(context);
    await page.goto('/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('.review, #palette-btn, #clean-btn, .tbd, .ph, .ph-label')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-palette'))).toBe(false);
    expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
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
        .filter(h => h.length > 1 && h !== '#feedback' && !document.getElementById(h.slice(1))));
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
    const { posts, outside } = await guard(context);
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
    expect(posts).toEqual([]);
    expect(notFonts(outside)).toEqual([]);
  });
});

// Serves the page as if it were built with SIGNUP_API set, and answers the sign-up service's address with
// `answer` (a function of the request, returning { status } or 'abort'). Returns the requests it received.
const SIGNUP_API = 'https://signup.example.test/signup';
async function withSignupApi(page, answer) {
  const sent = [];
  await page.route(/^http:\/\/localhost:\d+\/(index\.html)?(\?.*)?$/, async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('<meta name="lcw-signup-api" content="">', `<meta name="lcw-signup-api" content="${SIGNUP_API}">`);
    await route.fulfill({ response, body });
  });
  await page.route(SIGNUP_API, async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    sent.push({ method: req.method(), type: req.headers()['content-type'], body: JSON.parse(req.postData() || 'null') });
    const result = await answer(req);
    if (result === 'abort') return route.abort();
    return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body ?? {}) });
  });
  return sent;
}
async function fillSignup(page, { name = 'Test Person', org = '', email = 'test@example.org' } = {}) {
  await page.fill('#access-name', name);
  await page.fill('#access-org', org);
  await page.fill('#access-email', email);
}

test.describe('sign-up, sending to the sign-up service', () => {
  test('the page as built has no address, so it stays a mock-up', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    await expect(page.locator('meta[name="lcw-signup-api"]')).toHaveAttribute('content', '');
  });

  test('the build puts SIGNUP_API in both pages, and refuses an address that isn\'t https', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcw-build-'));
    await cp('src', join(dir, 'src'), { recursive: true });
    await cp('scripts', join(dir, 'scripts'), { recursive: true });
    const build = env => new Promise(resolve => {
      const child = spawn(process.execPath, ['scripts/build.mjs'], { cwd: dir, env: { ...process.env, ...env } });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('close', code => resolve({ code, out }));
    });
    expect((await build({ SIGNUP_API: SIGNUP_API })).code).toBe(0);
    for (const file of ['dist/index.html', 'dist/feedback/index.html']) {
      expect(await readFile(join(dir, file), 'utf8')).toContain(`<meta name="lcw-signup-api" content="${SIGNUP_API}">`);
    }
    // A $ or & in the address comes through as written ($& would otherwise be read as a replacement pattern)
    expect((await build({ SIGNUP_API: 'https://x.example/signup?a=$&b=1' })).code).toBe(0);
    expect(await readFile(join(dir, 'dist/index.html'), 'utf8')).toContain('<meta name="lcw-signup-api" content="https://x.example/signup?a=$&amp;b=1">');
    for (const bad of ['http://signup.example.test/signup', 'https://x.example/"><script>', 'javascript:alert(1)']) {
      const result = await build({ SIGNUP_API: bad });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain('SIGNUP_API must be an https:// address');
    }
    await rm(dir, { recursive: true, force: true });
  });

  test('sends the name, email, organization and honeypot, then shows the done state', async ({ page, context }) => {
    const { outside } = await guard(context);
    const errors = trackErrors(page);
    const sent = await withSignupApi(page, () => ({ status: 202, body: { ok: true } }));
    await page.goto('/');
    await fillSignup(page, { org: '  DCC  ', email: ' test@example.org ' });
    await page.click('#access-form button[type=submit]');
    await expect(page.locator('#access-done')).toBeVisible();
    await expect(page.locator('#access-to')).toHaveText('test@example.org');
    await expect(page.locator('#access-done-h')).toBeFocused();
    expect(sent).toEqual([{ method: 'POST', type: 'application/json', body: { name: 'Test Person', email: 'test@example.org', organization: 'DCC', website: '' } }]);
    expect(notFonts(outside)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('limits the fields to the lengths the sign-up service accepts', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    await expect(page.locator('#access-name')).toHaveAttribute('maxlength', '200');
    await expect(page.locator('#access-org')).toHaveAttribute('maxlength', '200');
    await expect(page.locator('#access-email')).toHaveAttribute('maxlength', '254');
    await page.fill('#access-name', 'x'.repeat(250));
    await expect(page.locator('#access-name')).toHaveValue('x'.repeat(200));
  });

  test('checks the fields before sending anything', async ({ page, context }) => {
    await guard(context);
    const sent = await withSignupApi(page, () => ({ status: 202 }));
    await page.goto('/');
    await page.click('#access-form button[type=submit]');
    await expect(page.locator('#access-err')).toHaveText('Enter your name.');
    await fillSignup(page, { email: 'not-an-email' });
    await page.click('#access-form button[type=submit]');
    await expect(page.locator('#access-err')).toContainText('Check your email address.');
    expect(sent).toEqual([]);
  });

  test('while it sends, the button is off, and pressing again sends nothing more', async ({ page, context }) => {
    await guard(context);
    let release;
    const held = new Promise(r => { release = r; });
    const sent = await withSignupApi(page, async () => { await held; return { status: 202 }; });
    await page.goto('/');
    await fillSignup(page);
    const submit = page.locator('#access-form button[type=submit]');
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(page.locator('#access-form')).toHaveAttribute('aria-busy', 'true');
    await page.locator('#access-email').press('Enter');
    await page.evaluate(() => document.getElementById('access-form').requestSubmit());   // a submit the disabled button can't stop
    release();
    await expect(page.locator('#access-done')).toBeVisible();
    expect(sent.length).toBe(1);
  });

  test('too many sign-ups from one network: says so, and keeps what was typed', async ({ page, context }) => {
    await guard(context);
    await withSignupApi(page, () => ({ status: 429, body: { error: 'Too many sign-ups from your network. Try again later.', reason: 'ip-hourly-limit' } }));
    await page.goto('/');
    await fillSignup(page, { org: 'DCC' });
    await page.click('#access-form button[type=submit]');
    const message = await page.locator('#access-msg-limit').textContent();
    await expect(page.locator('#access-err')).toHaveText(message);
    await expect(page.locator('#access-err')).toBeVisible();
    await expect(page.locator('#access-done')).toBeHidden();
    await expect(page.locator('#access-email')).toHaveValue('test@example.org');
    await expect(page.locator('#access-org')).toHaveValue('DCC');
    await expect(page.locator('#access-form button[type=submit]')).toBeEnabled();
    await expect(page.locator('#access-email')).not.toHaveAttribute('aria-invalid', 'true');
  });

  for (const [label, answer] of [['the service fails', () => ({ status: 500 })], ['the request is refused', () => ({ status: 400 })], ['there is no connection', () => 'abort'],
    ["API Gateway's whole-API throttle answers 429", () => ({ status: 429, body: { message: 'Too Many Requests' } })]]) {
    test(`when ${label}, it asks to try again, and trying again works`, async ({ page, context }) => {
      await guard(context);
      let first = true;
      const sent = await withSignupApi(page, () => { if (first) { first = false; return answer(); } return { status: 202 }; });
      await page.goto('/');
      await fillSignup(page);
      await page.click('#access-form button[type=submit]');
      await expect(page.locator('#access-err')).toHaveText(await page.locator('#access-msg-failed').textContent());
      await expect(page.locator('#access-done')).toBeHidden();
      await page.click('#access-form button[type=submit]');
      await expect(page.locator('#access-done')).toBeVisible();
      expect(sent.length).toBe(2);
    });
  }

  test('the honeypot is out of sight, out of the tab order and hidden from screen readers', async ({ page, context }) => {
    await guard(context);
    const sent = await withSignupApi(page, () => ({ status: 202 }));
    await page.goto('/');
    await expect(page.locator('.access-hp')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#access-website')).toHaveAttribute('tabindex', '-1');
    const box = await page.locator('#access-website').boundingBox();
    expect(box === null || box.x + box.width <= 0).toBe(true);
    // Tabbing on from the email field never lands on it (WebKit, like Safari, also skips the button)
    await page.focus('#access-email');
    const reached = [];
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); reached.push(await page.evaluate(() => document.activeElement.id)); }
    expect(reached).not.toContain('access-website');
    // A bot that fills it in: the page sends it as it is, and the service ignores the sign-up
    await fillSignup(page);
    await page.evaluate(() => { document.getElementById('access-website').value = 'http://spam.example'; });
    await page.click('#access-form button[type=submit]');
    await expect(page.locator('#access-done')).toBeVisible();
    expect(sent[0].body.website).toBe('http://spam.example');
  });
});

test.describe('feedback pop-up', () => {
  for (const width of [1280, 390]) {
    test(`#feedback opens it, and the reference matches on both forms (${width}px)`, async ({ page, context }) => {
      const { posts } = await guard(context);
      const errors = trackErrors(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/#feedback');
      await expect(page.locator('#fb')).toHaveAttribute('open', '');

      const href = await page.getAttribute('#fb-up', 'href');
      const ref = new URL(href).searchParams.get(UPLOAD_REF);
      expect(ref).toMatch(/^FB-[2-9A-HJ-NP-Z]{6}$/);

      await page.check('input[name=trying][value="Get the test badge"]');
      await page.fill('#fb-happened', 'TEST ONLY: badge email never arrived.');
      await expect(page.locator('#fb-opened')).toBeHidden();
      expect(await openUpload(context, page)).toContain(`${UPLOAD_REF}=${ref}`);
      await expect(page.locator('#fb-opened')).toBeVisible();
      await expect(page.locator('#fb-ref')).toHaveText(ref);   // shown too, in case the upload form drops it
      expect(await page.evaluate(() => { const d = document.getElementById('fb'); return d.scrollWidth - d.clientWidth; })).toBeLessThanOrEqual(0);

      await page.click('#fb-send');
      await expect(page.locator('#fb-done')).toBeVisible();
      await expect(page.locator('#fb-h')).toHaveText('Thanks for telling us');
      await expect(page.locator('#fb-done .fbp-only')).toBeHidden();
      expect(posts).toHaveLength(1);
      expect(posts[0].get(E.trying)).toBe('Get the test badge');
      expect(posts[0].get(E.happened)).toBe('TEST ONLY: badge email never arrived.');
      expect(posts[0].get(E.screenshot)).toBe(`On the upload form, reference ${ref}`);
      expect(posts[0].get(E.source)).toBe('Link');
      expect(posts[0].get(E.device)).toMatch(/^(Chrome|Safari|Firefox|Edge|Opera|another browser) on .+ \| Mozilla\/5\.0 .+ \| \d+x\d+$/);
      expect(posts[0].has(E.email)).toBe(false);
      expect(posts[0].has('entry.1730067921')).toBe(false);   // the old "Sent from" id

      // Send another: a new reference, and no screenshot line if the upload form isn't opened
      await page.click('#fb-again');
      const ref2 = new URL(await page.getAttribute('#fb-up', 'href')).searchParams.get(UPLOAD_REF);
      expect(ref2).not.toBe(ref);
      await expect(page.locator('#fb-ref')).toHaveText(ref2);
      await expect(page.locator('#fb-opened')).toBeHidden();
      await page.check('input[name=trying][value="Share it"]');
      await page.fill('#fb-happened', 'TEST ONLY: no screenshots this time.');
      await page.fill('#fb-email', 'tester@example.org');
      await page.click('#fb-send');
      await expect(page.locator('#fb-done')).toBeVisible();
      expect(posts).toHaveLength(2);
      expect(posts[1].has(E.screenshot)).toBe(false);
      expect(posts[1].get(E.email)).toBe('tester@example.org');
      expect(errors).toEqual([]);
    });
  }

  test('?from=<place> records where a #feedback link came from', async ({ page, context }) => {
    const { posts } = await guard(context);
    await page.goto('/?from=email#feedback');
    await page.check('input[name=trying][value="Share it"]');
    await page.fill('#fb-happened', 'TEST ONLY: from an email.');
    await page.click('#fb-send');
    await expect(page.locator('#fb-done')).toBeVisible();
    expect(posts[0].get(E.source)).toBe('email');
  });

  test('the Get involved button records where it was opened', async ({ page, context }) => {
    const { posts } = await guard(context);
    await page.goto('/');
    await page.click('.fb-open[data-source="Landing page: Get involved"]');
    await expect(page.locator('#fb')).toHaveAttribute('open', '');
    await page.check('input[name=trying][value="Set up my wallet and space"]');
    await page.fill('#fb-happened', 'TEST ONLY: from Get involved.');
    await page.click('#fb-send');
    await expect(page.locator('#fb-done')).toBeVisible();
    expect(posts[0].get(E.source)).toBe('Landing page: Get involved');
    await page.click('#fb-close');
    await expect(page.locator('#fb')).not.toHaveAttribute('open', '');
  });

  test('checks the answers before sending', async ({ page, context }) => {
    const { posts } = await guard(context);
    await page.goto('/#feedback');
    await page.click('#fb-send');
    await expect(page.locator('#fb-trying-err')).toHaveText('Choose what you were trying to do.');
    await expect(page.locator('input[name=trying]').first()).toBeFocused();
    await page.check('#fb-other-r');
    await expect(page.locator('#fb-other')).toBeFocused();
    await page.click('#fb-send');
    await expect(page.locator('#fb-trying-err')).toContainText('Say what you were trying to do');
    await page.fill('#fb-other', 'Print my badge');
    await page.click('#fb-send');
    await expect(page.locator('#fb-happened-err')).toHaveText('Tell us what happened.');
    await page.fill('#fb-happened', 'TEST ONLY: no print button.');
    await page.fill('#fb-email', 'nope');
    await page.click('#fb-send');
    await expect(page.locator('#fb-email-err')).toContainText('Check your email address.');
    expect(posts).toHaveLength(0);
    await page.fill('#fb-email', '');
    await page.click('#fb-send');
    await expect(page.locator('#fb-done')).toBeVisible();
    expect(posts[0].get(E.trying)).toBe('Something else');
    expect(posts[0].get(E.happened)).toBe('Trying to: Print my badge\n\nTEST ONLY: no print button.');
  });

  test("if sending fails, it offers Google's own form with the answers filled in", async ({ page, context }) => {
    await guard(context, { failSend: true });
    await page.goto('/#feedback');
    await page.check('input[name=trying][value="Share it"]');
    await page.fill('#fb-happened', 'TEST ONLY: send fails.');
    await page.click('#fb-send');
    await expect(page.locator('#fb-status')).toContainText("We couldn't send this from here.");
    const link = page.locator('#fb-status a');
    const url = new URL(await link.getAttribute('href'));
    expect(url.pathname).toMatch(/\/viewform$/);
    expect(url.searchParams.get(E.happened)).toBe('TEST ONLY: send fails.');
    expect(url.searchParams.get(E.source)).toBe('Link');
    await expect(page.locator('#fb-form')).toBeVisible();
    await expect(page.locator('#fb-send')).toBeEnabled();
  });
});

test.describe('full feedback page', () => {
  for (const width of [1280, 390]) {
    test(`/feedback?from=wallet shows the form on its own page (${width}px)`, async ({ page, context }) => {
      const { posts } = await guard(context);
      const errors = trackErrors(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/feedback?from=wallet');
      await expect(page).toHaveTitle(/^Share feedback · /);
      await expect(page.locator('body')).toHaveClass(/fbp-on/);
      await expect(page.locator('#fbp-slot #fb-form')).toBeVisible();
      await expect(page.locator('#fb')).not.toHaveAttribute('open', '');
      for (const hidden of ['.hero', '#faq', '.site-nav', '#fb-x', '#fb-cancel']) await expect(page.locator(hidden)).toBeHidden();
      await expect(page.locator('#fb-h')).toHaveAttribute('role', 'heading');
      await expect(page.locator('#fb-h')).toHaveAttribute('aria-level', '1');
      await expect(page.locator('#fb-h')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);

      await page.check('input[name=trying][value="Share it"]');
      await page.fill('#fb-happened', 'TEST ONLY: full page.');
      const ref = new URL(await page.getAttribute('#fb-up', 'href')).searchParams.get(UPLOAD_REF);
      await openUpload(context, page);
      await page.click('#fb-send');
      await expect(page.locator('#fb-done')).toBeVisible();
      await expect(page.locator('#fb-done .fbp-only')).toHaveText('You can close this tab and go back to the wallet.');
      await expect(page.locator('#fb-close')).toBeHidden();
      expect(posts[0].get(E.source)).toBe('Feedback page: wallet');
      expect(posts[0].get(E.screenshot)).toBe(`On the upload form, reference ${ref}`);
      expect(errors).toEqual([]);
    });
  }

  test('/feedback without ?from= records "Feedback page"', async ({ page, context }) => {
    const { posts } = await guard(context);
    await page.goto('/feedback');
    await page.check('input[name=trying][value="Share it"]');
    await page.fill('#fb-happened', 'TEST ONLY: no from.');
    await page.click('#fb-send');
    await expect(page.locator('#fb-done')).toBeVisible();
    expect(posts[0].get(E.source)).toBe('Feedback page');
  });

  test('the logo goes back to the welcome page, where the pop-up still works', async ({ page, context }) => {
    const { posts } = await guard(context);
    await page.goto('/feedback?from=wallet');
    await page.click('.site-header .brand');
    await expect(page).toHaveURL('/');
    await expect(page.locator('body')).not.toHaveClass(/fbp-on/);
    await expect(page.locator('.hero')).toBeVisible();
    await page.click('.fb-open[data-source="Landing page: Get involved"]');
    await expect(page.locator('#fb #fb-form')).toBeVisible();
    await expect(page.locator('#fb-cancel')).toBeVisible();
    await page.check('input[name=trying][value="Get the test badge"]');
    await page.fill('#fb-happened', 'TEST ONLY: pop-up after the page.');
    await page.click('#fb-send');
    await expect(page.locator('#fb-done')).toBeVisible();
    expect(posts[0].get(E.source)).toBe('Landing page: Get involved');
  });

  test('/feedback/index.html is the full page too, and other paths are not', async ({ page, context }) => {
    await guard(context);
    await page.goto('/feedback/index.html?from=wallet');
    await expect(page.locator('#fbp-slot #fb-form')).toBeVisible();
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

  test('#feedback on the full page keeps the form on the page', async ({ page, context }) => {
    await guard(context);
    const errors = trackErrors(page);
    await page.goto('/feedback#feedback');
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
    await expect(page.locator('#fb')).not.toHaveAttribute('open', '');
    await page.evaluate(() => { location.hash = '#feedback'; });
    await expect(page.locator('#fb')).not.toHaveAttribute('open', '');
    await expect(page.locator('#fb-h')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('#feedback added while the welcome page is open opens the pop-up without reloading', async ({ page, context }) => {
    await guard(context);
    const errors = trackErrors(page);
    await page.goto('/');
    const before = await page.evaluate(() => history.length);
    await page.evaluate(() => { window.notReloaded = true; location.hash = '#feedback'; });
    await expect(page.locator('#fb')).toHaveAttribute('open', '');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.notReloaded)).toBe(true);
    await expect(page.locator('#fb')).toHaveAttribute('open', '');
    expect(page.url()).toMatch(/\/$/);   // no "#feedback", and no bare "#" either
    expect(await page.evaluate(() => history.length)).toBe(before + 1);   // the hash change only, so Back works once
    expect(errors).toEqual([]);
  });

  test('Back and Forward move between the welcome page and the full page', async ({ page, context }) => {
    await guard(context);
    await page.goto('/');
    await page.goto('/feedback?from=wallet');
    await page.goBack();
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/fbp-on/);
    await page.goForward();
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
    await expect(page.locator('#fbp-slot #fb-form')).toBeVisible();
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

  test('the welcome page loads its images and icon', async ({ page, context }) => {
    await guard(context);
    const errors = trackErrors(page);
    await page.goto(ROOT + '/lcw-welcome');
    await expect(page).toHaveURL(ROOT + BASE);
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/fbp-on/);
    await page.waitForLoadState('load');
    expect(await imagesLoaded(page)).toBe(true);
    expect(await iconLoads(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('/feedback?from=wallet is the full page, sends from the wallet, and the logo goes back', async ({ page, context }) => {
    const { posts } = await guard(context);
    const errors = trackErrors(page);
    await page.goto(ROOT + BASE + 'feedback?from=wallet');
    await expect(page).toHaveURL(ROOT + BASE + 'feedback/?from=wallet');
    await expect(page.locator('body')).toHaveClass(/fbp-on/);
    await page.waitForLoadState('load');
    expect(await imagesLoaded(page)).toBe(true);
    expect(await iconLoads(page)).toBe(true);
    await page.check('input[name=trying][value="Get the test badge"]');
    await page.fill('#fb-happened', 'TEST ONLY: in a folder.');
    await page.click('#fb-send');
    await expect(page.locator('#fb-done')).toBeVisible();
    expect(posts[0].get(E.source)).toBe('Feedback page: wallet');
    await page.click('.site-header .brand');
    await expect(page).toHaveURL(ROOT + BASE);
    await expect(page.locator('.hero')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
