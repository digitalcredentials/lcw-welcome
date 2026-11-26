# Running sign-up

What to do before launch, day to day, and when something goes wrong. How it works is in [README.md](README.md).

All commands need AWS access to the account the stack is in. Emails are kept lowercase in the table, so look people up in lowercase.

## Before launch

After the first deploy (see README.md):

- [ ] The subscription email AWS sent to `AlertEmail` is confirmed.
- [ ] Alerts arrive. Set one alarm off by hand, check the email arrives, then set it back:
  ```bash
  aws cloudwatch set-alarm-state --alarm-name lcw-welcome-signup-problems --state-value ALARM --state-reason "TEST: checking alerts arrive"
  aws cloudwatch set-alarm-state --alarm-name lcw-welcome-signup-problems --state-value OK --state-reason "TEST done"
  ```
- [ ] The page is built with `SIGNUP_API` set to the stack's `SignupUrl` and is live at `AllowedOrigins`.
- [ ] One real sign-up end to end, with an address you can read, from the live page:
  - the invite arrives from support@lcw.app, and not in spam;
  - its link opens the wallet's register page with the code filled in;
  - an account can be made with that code.
- [ ] Remove that test sign-up from the table (see "Removing someone"), then give its first-100 place back, since removing a row doesn't:
  ```bash
  aws dynamodb update-item --table-name lcw-welcome-counters --key '{"key":{"S":"auto-invites"}}' \
    --update-expression "ADD n :minus" --condition-expression "n > :zero" \
    --expression-attribute-values '{":minus":{"N":"-1"},":zero":{"N":"0"}}'
  ```
- [ ] The rest of the launch list in the top-level README.md is done (the old shared code removed from `pws-coupons`, and so on).

## Day to day

**See who's waiting**: the admin console will show this. Until then:

```bash
aws dynamodb query --table-name lcw-welcome-signups --index-name status-index \
  --key-condition-expression "#s = :q" --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":q":{"S":"queued"}}' --select COUNT
```

**Invite the next group**: check with a dry run first, then invite. People are invited in sign-up order. Each email counts toward the daily cap (300 by default), so keep a group under what's left of today's cap.

```bash
aws lambda invoke --function-name lcw-welcome-invite --cli-binary-format raw-in-base64-out \
  --payload '{"count": 25, "dryRun": true}' /dev/stdout
aws lambda invoke --function-name lcw-welcome-invite --cli-binary-format raw-in-base64-out \
  --payload '{"count": 25}' /dev/stdout
```

The answer lists who was invited and anyone who failed. `capReached` means it stopped at the daily cap; `stoppedOnFailures` means it stopped after 3 failures in a row (see the alerts below).

## When an alert arrives

| Alert | What it means | What to do |
|---|---|---|
| `lcw-welcome-daily-email-cap-reached` | Today's emails (UTC) reached `DailyEmailCap`. No more invites go out until tomorrow (UTC). Nobody is lost: they stay queued, and anyone among the first 100 keeps their place. | Look at today's sign-ups. **If they look real**, raise `DailyEmailCap` (redeploy) or wait for tomorrow, then run "invite the next N". **If they look like junk**, see "A flood of junk sign-ups". |
| `lcw-welcome-signup-problems` | An invite failed, or a sign-up did. The person is back in their place in the queue, unless their invite has now failed 3 times. | Read the log (below). **"(making the code)"** means lcw-back-end's `/registration-codes` is failing: tell James. **"(sending the email)"** means SES is failing: check SES in the console (sending paused, a quota, the domain). **"3 invites failed in a row"** means one of those is down or set up wrong (SES refusing every address, say: check `FromEmail`). Once fixed, run "invite the next N"; the people who failed go first. **"set aside as failed"** means SES refused one address 3 times: see "Failed sign-ups". **"not enough time left"** means a sign-up's request was too slow to start its invite: they keep their place; run "invite the next N" to invite them. Often, DynamoDB or lcw-back-end is slow. |
| `lcw-welcome-signup-function-errors` / `lcw-welcome-invite-function-errors` | A function crashed or timed out. | Read its log. An invite cut off partway can be finished after 15 minutes, by the next "invite the next N" (run it) or by the person signing up again, with the code already made. |

Reading the logs:

```bash
aws logs tail /aws/lambda/lcw-welcome-signup --since 2h
aws logs tail /aws/lambda/lcw-welcome-invite --since 2h
```

The logs hold no names or emails, so match a failure to a person by its time in the table.

Warnings that don't alert, worth a look if they're frequent:

- **"that sign-up's code has expired"**: someone invited over 90 days ago signed up again. Nothing was sent; see "My code expired" below.

Re-sends have their own daily cap (`ResendDailyCap`, 50), which doesn't alert. A log line "A re-send was refused: today's re-sends are used up" means people signing up again didn't get their email that day. Many of these in one day is a sign of misuse, not real demand.

## When someone writes in

**"I didn't get my email."** Look them up:

```bash
aws dynamodb get-item --table-name lcw-welcome-signups --key '{"email":{"S":"person@example.org"}}'
```

- **`queued`:** they haven't been invited yet. They're emailed when their group is let in.
- **`invited`:** ask them to check spam. Signing up again on the page re-sends the same code, once an hour, up to 3 times (`resends` on the row counts them). After that, or if re-sends for the day are used up, send them the `link` from their row by hand. It's their own code, so nothing new is made.
- **`inviting`:** an invite is in progress or was cut off. After 15 minutes it can be finished: run "invite the next N", or ask them to sign up again.
- **`failed`:** their invite failed 3 times. See "Failed sign-ups".
- **Not found:** they didn't sign up with that address (or a typo). They can sign up again.

**"My code expired."** Codes last 90 days. Signing up again sends nothing once the code has expired, and this service never makes a second code for the same address, so a new one has to come from lcw-back-end and be sent by hand. *Open question: James to say how support makes a replacement code.*

**"Please delete my details."** See "Removing someone".

## Removing someone

```bash
aws dynamodb delete-item --table-name lcw-welcome-signups --key '{"email":{"S":"person@example.org"}}'
```

If they were among the first 100, their place isn't given back (see "Before launch" to give it back by hand).

If they were invited, ask James to remove the codes issued to their address in lcw-back-end too: all of them, since a request to make a code that timed out can leave an extra one. Otherwise their code keeps working, and if they signed up again they'd get a second one, since this service no longer remembers the first.

## Failed sign-ups

When SES refuses an address 3 times in "invite the next N" runs, its sign-up is set aside as `failed`, so it doesn't hold up the queue. Outages don't count toward this. SES gives the same refusal for a bad sender address, so if several are set aside at once with "3 invites failed in a row", check `FromEmail`, fix it, and put them all back. To list them:

```bash
aws dynamodb query --table-name lcw-welcome-signups --index-name status-index \
  --key-condition-expression "#s = :f" --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":f":{"S":"failed"}}'
```

If the address looks wrong, leave it, or remove it (see "Removing someone"). If SES refused it because of a setup mistake that's now fixed, put it back in the queue, in its old place by sign-up time:

```bash
aws dynamodb update-item --table-name lcw-welcome-signups --key '{"email":{"S":"person@example.org"}}' \
  --update-expression "SET #s = :q REMOVE failures" --condition-expression "#s = :f" \
  --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":q":{"S":"queued"},":f":{"S":"failed"}}'
```

## Turning sign-up off

To stop all sign-ups at once (a flood of junk, or a problem being fixed):

```bash
aws lambda put-function-concurrency --function-name lcw-welcome-signup --reserved-concurrent-executions 0
```

The form then shows "We couldn't sign you up just now. Please try again in a few minutes." Nothing already in the table changes, and "invite the next N" still works. To turn it back on:

```bash
aws lambda delete-function-concurrency --function-name lcw-welcome-signup
```

## A flood of junk sign-ups

Signs: the daily cap reached early, or many sign-ups with made-up addresses.

1. Turn sign-up off (above).
2. Look at the newest rows in the table. Delete the junk ones that are still `queued`. Invited ones have already been emailed.
3. Before turning it back on, lower `IpHourlyLimit` (redeploy). If the junk comes from many networks, add a CAPTCHA. That's a code change to the page and the service.
