# Sign-up service

The back end for the welcome page's early-access form (#3, #4). It keeps the sign-ups and the queue, invites the first 100 straight away, and emails each invite with a registration code from lcw-back-end. It's a small AWS SAM stack, deployed to the same AWS account as lcw-back-end.

## How it works

- **The form** posts `{ name, email, organization, website }` to `POST /signup`. `website` is the honeypot: a field people never see, so only a bot fills it in.
- **The first 100 sign-ups** (`AutoInviteLimit`) are invited straight away. The 100 counts people, not accounts made. If one of their invites fails, they keep their place among the 100 and stay first in the queue. They're invited when they sign up again, or by the next "invite the next N", whichever comes first, so later sign-ups can't overtake them.
- **Everyone after that is queued.** "Invite the next N" (`lcw-welcome-invite`) invites the next N in sign-up order. The admin console runs it; there's no public route to it.
- **Each invite** asks lcw-back-end's `POST /registration-codes` for a code, then emails the link it answers from `support@lcw.app`. The link opens the wallet's register page with the code filled in. A code is used up when an account made with it is confirmed, and works for 90 days (lcw-back-end's settings).
- **Signing up again with the same email** re-sends the same code, at most once an hour. A new code is never made, even after the old one expires: that would let one address set up a second wallet. Someone whose code has expired emails support for a new one, as the wallet's register page already says.
- **The invite email holds nothing typed into the form**, not even the name. Anyone can sign up any address, so anything typed there would let a stranger send their own words from support@lcw.app.
- **Every accepted sign-up gets the same answer** (`202 { ok: true }`), so the form can't be used to find out who has signed up.
- **If an invite fails** (making the code or sending the email), the person goes back to their place in the queue and the team is alerted. A code is kept as soon as it's made, so trying again sends that same code. If a re-send fails, or hits the daily cap, its time is undone, so signing up again later isn't blocked for an hour.
- **An invite that never finished** (the function timed out partway, say) counts as queued again after 15 minutes. The next "invite the next N", or the person signing up again, finishes it with the code already made. Each step of an invite checks it still holds the claim it made, so a slow invite that was taken over can't undo or repeat the one that took over.

## Misuse protection

| What | Setting | Default |
|---|---|---|
| A honeypot field | | |
| Sign-ups per network per hour: one IPv4 address, or one IPv6 /64, since an IPv6 user can switch between addresses in their /64. The page says "too many from your network" only for this limit. | `IpHourlyLimit` | 10 |
| One code per email address | | |
| Emails per day (UTC). Reaching it stops invites until the next day and emails `AlertEmail`. People stay queued. | `DailyEmailCap` | 300 |
| Requests to the whole API (API Gateway answers 429 past it, and the page shows its "try again" message) | `DefaultRouteSettings` in `template.yaml` | 10 a second, bursts of 20 |

No CAPTCHA unless misuse shows up.

Two limits to know about:

- **The whole-API limit is shared.** A script sending more than 10 requests a second slows sign-up for everyone while it runs. AWS WAF can't be attached to an HTTP API, so the fix, if it happens, is a REST API with WAF rate rules, or a CAPTCHA.
- **A code can be made but never sent.** If lcw-back-end makes a code but its answer is lost (a timeout, say), the next try makes another. The first is never sent to anyone and is 16 random characters, so it can't be used in practice; it just sits unused in the coupons table. lcw-back-end could stop this by answering the same code for the same `issuedTo`.
- **The per-network count is kept as an unsalted hash, for 2 hours** (DynamoDB deletes it after that). The hash hides the address at a glance, but someone who can read the table could work an IPv4 address out from it.

## What's where

- `template.yaml`: the API, the two functions, the two tables, and the alarms. `AlertEmail` hears about the daily cap, a failed invite, and any error or timeout in either function.
- `src/service.mjs`: the rules above.
- `src/store.mjs`: everything that reads or writes the tables, with the condition on each write that keeps two requests at once from inviting someone twice.
- `src/clients.mjs`: the API key, `POST /registration-codes`, and SES.
- `src/email.mjs`: the invite email. Its wording is a draft (see `PLACEHOLDERS.md`).
- `src/signup.mjs`, `src/invite.mjs`: the two Lambda handlers.

Tables: `lcw-welcome-signups` (one row per email; `status` is `queued`, `inviting` or `invited`; the code is kept on the row; `autoInvite` marks one of the first 100) and `lcw-welcome-counters` (the first-100 count, each day's emails, and each network's sign-ups this hour).

## Test

```bash
cd signup/src
npm install
npm test                        # the rules, and the calls to lcw-back-end, SES and Parameter Store, all faked

# The tables' write conditions, against DynamoDB Local, with many requests at once
docker run --rm -d -p 8000:8000 --name lcw-welcome-ddb amazon/dynamodb-local
DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:dynamodb
docker stop lcw-welcome-ddb
```

The page's side is tested with the rest of the page (`npm test` at the top of the repo).

### Smoke test: click through it

`npm run smoke` (in `signup/src`, with Docker running) runs the page and the real `signup.mjs` and `invite.mjs` handlers on your computer, with DynamoDB Local in Docker. Parameter Store, `POST /registration-codes` and SES are stood in for on `127.0.0.1:4601`, with made-up credentials, so nothing can reach real AWS and no email is sent.

- **The page:** http://localhost:4600. Sign up as you would.
- **The control panel:** http://localhost:4600/_smoke. It shows the table, every email SES was asked to send (open one to see it as it would arrive), and the log, with the lines that alert the team in red. Its buttons run "invite the next N" (and its dry run), make code-making fail, take the sign-up API down, and reset everything.

Its settings are small, so each rule shows up within a few sign-ups: 2 invited straight away, 6 emails a day, 8 sign-ups an hour from one network, and a re-send after 1 minute. Each can be changed, for example `AUTO_INVITE_LIMIT=5 npm run smoke`. Ctrl+C stops it and removes its Docker container.

## Deploy

Before the first deploy:

- **The API key** for `POST /registration-codes` must be in Parameter Store in this account, at `RegistrationCodeApiKeyParameter`. It's the same parameter lcw-back-end checks the key against. Never put the key in the page, the repo or a chat.
- **SES** must be able to send as `FromEmail` (`support@lcw.app`, so the `lcw.app` domain verified) and be out of sandbox mode, or it only sends to verified addresses.

```bash
cd signup
sam build
sam deploy --guided   # once; it asks for each parameter and saves the answers to samconfig.toml
```

Parameters to check: `AllowedOrigins` (the welcome page's real address), `RegistrationCodesUrl` (lcw-back-end's `RegistrationCodesUrl` output for that environment), and `AlertEmail`. After the first deploy, confirm the subscription email AWS sends to `AlertEmail`.

Then build the page with the stack's `SignupUrl` output:

```bash
SIGNUP_API=<SignupUrl> npm run build
```

## Inviting the next group

The admin console's button will call `lcw-welcome-invite` (not built yet). Until then, someone with AWS access can run it:

```bash
aws lambda invoke --function-name lcw-welcome-invite --cli-binary-format raw-in-base64-out \
  --payload '{"count": 25, "dryRun": true}' /dev/stdout   # who would be invited; sends nothing
aws lambda invoke --function-name lcw-welcome-invite --cli-binary-format raw-in-base64-out \
  --payload '{"count": 25}' /dev/stdout                   # invites them
```
