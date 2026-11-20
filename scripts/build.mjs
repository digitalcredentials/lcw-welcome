// Builds the site into dist/: everything in src/, plus a copy of the page at feedback/index.html.
// The copy is marked with data-feedback-page, which makes it show the full-page feedback form, so there
// is only one page (and one form) to edit. Paths are relative, so the site works at the root of a host
// or in a folder (as on GitHub Pages). No dependencies, so it runs anywhere Node does.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const page = await readFile('src/index.html', 'utf8');
const marked = page.replace('<html lang="en">', '<html lang="en" data-feedback-page>');
const feedback = marked.replace(/(src|href)="img\//g, '$1="../img/');
if (marked === page || !feedback.includes('"../img/')) throw new Error('build: could not make the /feedback copy');

await rm('dist', { recursive: true, force: true });
await cp('src', 'dist', { recursive: true });
await mkdir('dist/feedback', { recursive: true });
await writeFile('dist/feedback/index.html', feedback);
console.log('Built dist/ (/ and /feedback)');
