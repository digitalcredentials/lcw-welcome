// Builds the site into dist/: everything in src/, plus a copy of the page at feedback/index.html.
// The copy is marked with data-feedback-page, which makes it show the feedback page, so there is only
// one page to edit. Paths are relative, so the site works at the root of a host or in a folder (as on
// GitHub Pages); the copy is one folder down, so its paths to img/, fonts/ and feedback/ get a "../".
// No dependencies, so it runs anywhere Node does.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const page = await readFile('src/index.html', 'utf8');
const marked = page.replace('<html lang="en">', '<html lang="en" data-feedback-page>');
const feedback = marked
  .replace(/(src|href)="(img|feedback)\//g, '$1="../$2/')
  .replace(/url\(fonts\//g, 'url(../fonts/');
if (marked === page || !feedback.includes('"../img/') || !feedback.includes('url(../fonts/')) throw new Error('build: could not make the /feedback copy');

await rm('dist', { recursive: true, force: true });
await cp('src', 'dist', { recursive: true });
await mkdir('dist/feedback', { recursive: true });
await writeFile('dist/feedback/index.html', feedback);
console.log('Built dist/ (/ and /feedback)');
