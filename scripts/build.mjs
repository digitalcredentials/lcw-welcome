// Builds the site into dist/: everything in src/, plus a copy of the page at feedback/index.html.
// The copy is marked with data-feedback-page, which makes it show the feedback page, so there is only
// one page to edit. Paths are relative, so the site works at the root of a host or in a folder (as on
// GitHub Pages); the copy is one folder down, so its paths to img/, fonts/ and feedback/ get a "../",
// its logo links back up to the welcome page, and its title starts "Share feedback · ".
// No dependencies, so it runs anywhere Node does.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const page = await readFile('src/index.html', 'utf8');
const marked = page.replace('<html lang="en">', '<html lang="en" data-feedback-page>');
const feedback = marked
  .replace('<title>', '<title>Share feedback · ')
  .replace('<a class="brand" href="#top">', '<a class="brand" href="../">')   // the logo goes back to the welcome page
  .replace(/(src|href)="(img|feedback)\//g, '$1="../$2/')
  .replace(/url\(fonts\//g, 'url(../fonts/');
if (marked === page || !feedback.includes('"../img/') || !feedback.includes('url(../fonts/') || !feedback.includes('<a class="brand" href="../">') || !feedback.includes('<title>Share feedback · ')) throw new Error('build: could not make the /feedback copy');

await rm('dist', { recursive: true, force: true });
await cp('src', 'dist', { recursive: true });
await mkdir('dist/feedback', { recursive: true });
await writeFile('dist/feedback/index.html', feedback);
console.log('Built dist/ (/ and /feedback)');
