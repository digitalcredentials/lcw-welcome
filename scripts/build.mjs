// Builds the site into dist/: everything in src/, plus a copy of the page at feedback/index.html.
// The page shows the full-page feedback form when it is opened at /feedback, so there is only one
// page (and one form) to edit. No dependencies, so it runs anywhere Node does.
import { cp, copyFile, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await cp('src', 'dist', { recursive: true });
await mkdir('dist/feedback', { recursive: true });
await copyFile('src/index.html', 'dist/feedback/index.html');
console.log('Built dist/ (/ and /feedback)');
