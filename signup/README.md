# Sign-up service

The back end for the welcome page's early-access form (#3, #4). It keeps the sign-ups and the queue, invites the first 100 straight away, and emails each invite with a registration code from lcw-back-end. It's a small AWS SAM stack, deployed to the same AWS account as lcw-back-end.

## How it works

- **The form** posts `{ name, email, organization, website }` to `POST /signup`. `website` is the honeypot: a field people never see, so only a bot fills it in.
- **The first 100 sign-ups** (`AutoInviteLimit`) are invited straight away. The 100 counts invites sent, not accounts made.
- **Everyone after that is queued.** "Invite the next N" (`lcw-welcome-invite`) invites the next N in sign-up order. The admin console runs it; there's no public route to it.
- **Each invite** asks lcw-back-end's `POST /registration-codes` for a code, then emails the link it answers from `support@lcw.app`. The link opens the wallet's register page with the code filled in. A code is used up when an account made with it is confirmed, and works for 90 days (lcw-back-end's settings).
- **Signing up again with the same email** re-sends the same code, at most once an hour. A new code is never made, even after the old one expires: that would let one address set up a second wallet. Someone whose code has expired emails support for a new one, as the wallet's register page already says.
- **The invite email holds nothing typed into the form**, not even the name. Anyone can sign up any address, so anything typed there would let a stranger send their own words from support@lcw.app.
- **Every accepted sign-up gets the same answer** (`202 { ok: true }`), so the form can't be used to find out who has signed up.
- **If an invite fails** (making the code or sending the email), the person goes back to their place in the queue and the team is alerted. A code is kept as soon as it's made, so trying again sends that same code.
- **An invite that never finished** (the function timed out partway, say) counts as queued again after 15 minutes. The next "invite the next N", or the person signing up again, finishes it with the code already made.

## Misuse protection

| What | Setting | Default |
|---|---|---|
| A honeypot field | | |
| Sign-ups per IP address per hour (the address is hashed, not kept) | `IpHourlyLimit` | 10 |
| One code per email address | | |
| Emails per day (UTC). Reaching it stops invites until the next day and emails `AlertEmail`. People stay queued. | `DailyEmailCap` | 300 |
| Requests to the whole API | `DefaultRouteSettings` in `template.yaml` | 10 a second, bursts of 20 |

No CAPTCHA unless misuse shows up.

## What's where

- `template.yaml`: the API, the two functions, the two tables, and the alarms. `AlertEmail` hears about the daily cap, a failed invite, and any error or timeout in either function.
- `src/service.mjs`: the rules above.
- `src/store.mjs`: everything that reads or writes the tables, with the condition on each write that keeps two requests at once from inviting someone twice.
- `src/clients.mjs`: the API key, `POST /registration-codes`, and SES.
- `src/email.mjs`: the invite email. Its wording is a draft (see `PLACEHOLDERS.md`).
- `src/signup.mjs`, `src/invite.mjs`: the two Lambda handlers.

Tables: `lcw-welcome-signups` (one row per email; `status` is `queued`, `inviting` or `invited`; the code is kept on the row) and `lcw-welcome-counters` (the first-100 count, each day's emails, and each IP address's sign-ups this hour).

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
