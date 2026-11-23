// Builds the site into dist/: everything in src/, plus a copy of the page at feedback/index.html.
// The copy is marked with data-feedback-page, which makes it show the full-page feedback form, so there
// is only one page (and one form) to edit. Paths are relative, so the site works at the root of a host
// or in a folder (as on GitHub Pages). No dependencies, so it runs anywhere Node does.
// SIGNUP_API=<address> npm run build fills in where the sign-up form posts.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// SIGNUP_API is where the sign-up form posts (the sign-up service's SignupUrl output). Without it, the
// form is a mock-up that sends nothing, as on the GitHub Pages preview.
const META = '<meta name="lcw-signup-api" content="">';
const api = process.env.SIGNUP_API ?? '';
if (api && !/^https:\/\/[^\s"<>]+$/.test(api)) throw new Error('build: SIGNUP_API must be an https:// address');
const source = await readFile('src/index.html', 'utf8');
if (!source.includes(META)) throw new Error('build: could not find the lcw-signup-api meta tag');
// A function, so a $ in the address isn't read as a replacement pattern; & is escaped for the attribute
const page = source.replace(META, () => `<meta name="lcw-signup-api" content="${api.replace(/&/g, '&amp;')}">`);
const marked = page.replace('<html lang="en">', '<html lang="en" data-feedback-page>');
const feedback = marked.replace(/(src|href)="img\//g, '$1="../img/');
if (marked === page || !feedback.includes('"../img/')) throw new Error('build: could not make the /feedback copy');

await rm('dist', { recursive: true, force: true });
await cp('src', 'dist', { recursive: true });
await mkdir('dist/feedback', { recursive: true });
await writeFile('dist/index.html', page);
await writeFile('dist/feedback/index.html', feedback);
console.log(`Built dist/ (/ and /feedback). Sign-up ${api ? `posts to ${api}` : 'is a mock-up (no SIGNUP_API)'}`);
