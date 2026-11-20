# lcw-welcome

> [!IMPORTANT]
> **Alpha.** This is part of the Learner Credential Wallet alpha, an early test
> version. It may change without notice. We read issues, but may not answer or
> fix them during the alpha.

Welcome page and sign-up for Learner Credential Wallet (welcome.alpha.lcw.app)

The page has two addresses:

- `/`: the welcome page. A link ending in `#faq-<question>` (for example `#faq-passkey`) opens that answer, and `#feedback` opens the feedback pop-up.
- `/feedback`: the same feedback form on a page of its own. The wallet's feedback button links to `/feedback?from=wallet`.

Add `?from=<place>` to a `#feedback` link, or to `/feedback`, to record where it came from.

**Try it:** every change merged to main is published to https://digitalcredentials.github.io/lcw-welcome/ (full feedback page: https://digitalcredentials.github.io/lcw-welcome/feedback?from=wallet). It's a preview for the team, kept out of search engines. Feedback sent from it goes to the real Google Forms, so start what you type with "TEST".

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

The tests intercept every request to Google Forms, so they never send real feedback.

## What's here

- `src/index.html`: the whole page, with its styles and scripts. It's one file so wording changes can be compared line by line.
- `src/img/`, `src/robots.txt`: images, and the robots file that keeps the site out of search engines until launch.
- `scripts/build.mjs`: builds `dist/`, including a copy of the page at `feedback/index.html`. The page shows the full-page form when it's opened there, so there's only one form to edit.
- `scripts/serve.mjs`: a small local server for `npm start` and the tests.
- `PLACEHOLDERS.md`: wording that isn't final yet.

## Deploy

Run `npm run build` and upload `dist/` to a static host, at the root or in a folder (all paths are relative). The host must serve `/feedback` (no trailing slash, since that's what the wallet links to) from `feedback/index.html`, either directly or by redirecting to `/feedback/` with the query string kept. In a folder, it must redirect: served directly at `/folder/feedback`, the page's relative paths point outside the folder. Without the query string, feedback from the wallet isn't marked as coming from the wallet. Most static hosts do this already. CloudFront with an S3 origin doesn't: it needs a small function that rewrites `/feedback` and `/feedback/` to `/feedback/index.html`.

The GitHub Pages preview is published by `.github/workflows/pages.yml`, which runs the tests first. GitHub Pages redirects `/feedback` to `/feedback/` and keeps the query string.

## Feedback forms

The pop-up and the full page send to the same Google Form, in the background. The form's address and field ids are in `FEEDBACK_FORM` in `src/index.html`.

- The "What were you trying to do?" choices on the page must match the Google Form's options exactly.
- The Google Form must not require any other question or check answers (response validation). Google silently drops a submission that fails either, and the page can't tell.
- If sending fails, the page offers a link to Google's own form with the answers filled in.

Screenshots go on a separate Google Form (`UPLOAD_FORM`), because a form with an upload question makes everyone sign in to Google. Each piece of feedback gets a reference like `FB-7KQ2MX`. The **Add screenshots** button fills it in on the upload form, and the feedback carries it in its screenshot field, so the two can be matched.

## Before launch

- [ ] `PLACEHOLDERS.md` is empty, and no `data-ph` markers are left in `src/index.html`.
- [ ] Remove the `noindex` meta tag from `src/index.html`, and remove `src/robots.txt`.
- [ ] Sign-up sends for real. For now it's a mock-up that sends nothing (#3, #4).
- [ ] One test feedback, sent from the live address, arrives in the form's responses (then delete it).

## License

MIT. See [LICENSE](LICENSE).
