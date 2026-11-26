# lcw-welcome

> [!IMPORTANT]
> **Alpha.** This is part of the Learner Credential Wallet alpha, an early test
> version. It may change without notice. We read issues, but may not answer or
> fix them during the alpha.

Welcome page and sign-up for Learner Credential Wallet (welcome.alpha.lcw.app)

The page has two addresses:

- `/`: the welcome page. A link ending in `#faq-<question>` (for example `#faq-passkey`) opens that answer, and one ending in `#feedback` goes to the feedback page.
- `/feedback`: the feedback page. It links out to the Google Forms where feedback and screenshots are sent. The wallet's feedback button links to `/feedback?from=wallet`.

Add `?from=<place>` to `/feedback`, or to a `#feedback` link, to record where it came from. A `#feedback` link without one records `link`. The welcome page's own Share feedback links use `?from=try-it` and `?from=get-involved`.

**Try it:** every change merged to main is published to https://digitalcredentials.github.io/lcw-welcome/ (feedback page: https://digitalcredentials.github.io/lcw-welcome/feedback?from=wallet). It's a preview for the team, kept out of search engines. Its links open the real Google Forms, so start what you type there with "TEST".

## Run it

```bash
npm install
npm start        # builds, then serves dist/ at http://localhost:4317
```

## Test

```bash
npx playwright install chromium   # first time only
npm test
```

The tests block every request that leaves this machine, so they never open the real Google Forms.

## What's here

- `src/index.html`: the whole page, with its styles and scripts. It's one file so wording changes can be compared line by line.
- `src/img/`, `src/robots.txt`: images, and the robots file that keeps the site out of search engines until launch.
- `src/fonts/`: the Figtree font, served from this site so the page makes no requests to Google, with its license (`OFL.txt`, SIL Open Font License).
- `scripts/build.mjs`: builds `dist/`, including a copy of the page at `feedback/index.html`. The page shows the feedback page when it's opened there, so there's only one page to edit.
- `scripts/serve.mjs`: a small local server for `npm start` and the tests.
- `PLACEHOLDERS.md`: wording that isn't final yet.

## Deploy

Run `npm run build` and upload `dist/` to a static host, at the root or in a folder (all paths are relative). The host must serve `/feedback` (no trailing slash, since that's what the wallet links to) from `feedback/index.html`, either directly or by redirecting to `/feedback/` with the query string kept. In a folder, it must redirect: served directly at `/folder/feedback`, the page's relative paths point outside the folder. Without the query string, feedback from the wallet isn't marked as coming from the wallet. Most static hosts do this already. CloudFront with an S3 origin doesn't: it needs a small function that rewrites `/feedback` and `/feedback/` to `/feedback/index.html`. The host should also serve the `.woff2` files in `fonts/` as `font/woff2` (an S3 upload may need the type set).

The GitHub Pages preview is published by `.github/workflows/pages.yml`, which runs the tests first. GitHub Pages redirects `/feedback` to `/feedback/` and keeps the query string.

## Feedback forms

At Legal's request, feedback is sent on Google Forms itself, in a new tab, so it's clear Google collects it. The feedback page only makes the links: one to the feedback form (`FEEDBACK_FORM` in `src/index.html`), one to a separate screenshot form (`UPLOAD_FORM`), because a form with an upload question makes everyone sign in to Google.

Each visit to the page makes a reference like `FB-7KQ2MX`, filled in on both forms so screenshots can be matched to their feedback. It is kept in the page's address (`?ref=`), so a reload or Back shows the same one. One visit has one reference, so two reports sent from the same visit share it. The feedback form also opens with the browser and device details and where the tester came from (`Feedback page`, plus `?from=`, e.g. `Feedback page: wallet`). These use each form's pre-filled link, so the tester sees them and can change them. If a question on a form is renamed, its entry id stays the same; if one is deleted and added again, update its id here.

## Before launch

- [ ] `PLACEHOLDERS.md` is empty, and no `data-ph` markers are left in `src/index.html`.
- [ ] Remove the `noindex` meta tag from `src/index.html`, and remove `src/robots.txt`.
- [ ] Take down the GitHub Pages preview once the page is live at its real address (#9).
- [ ] Sign-up sends for real. For now it's a mock-up that sends nothing (#3, #4).
- [ ] From the live address, open the feedback page and both forms: the reference, device and "Sent from" are filled in. Send one test feedback and screenshot, check they arrive with the same reference (then delete them).
- [ ] Link the privacy notice from the feedback Google Form's description.

## License

MIT. See [LICENSE](LICENSE).
