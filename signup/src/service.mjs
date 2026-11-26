// What sign-up does, apart from where it stores things and how it sends.
// The handlers (signup.mjs, invite.mjs) give it the real store, code minter
// and mailer; the tests give it fakes, or the real store on DynamoDB Local.
//
// Agreed in digitalcredentials/lcw-welcome#3 and #4:
// - The first AUTO_INVITE_LIMIT sign-ups (100) are invited straight away.
//   The 100 counts people, not accounts made. If one of their invites fails
//   (lcw-back-end or SES down, or the daily cap), they keep their place among
//   the 100, stay first in the queue, and are tried again when they sign up
//   again or by the next "invite the next N".
// - Everyone after that waits. "Invite the next N" (invite.mjs, run from the
//   admin console) invites the next N in sign-up order.
// - A code is made when a person is invited, by lcw-back-end's
//   POST /registration-codes. Signing up again with the same email re-sends
//   the same code (at most once per RESEND_GAP_MINUTES, MAX_RESENDS times in
//   all), never a new one.
// - An invite SES refuses MAX_FAILURES times in "invite the next N" runs is
//   set aside as "failed", out of the queue, so one bad address can't sit at
//   the front of it for ever. Outages don't count, and a run stops after 3
//   failures in a row, so a setup mistake sets aside 3 people a run at most.
//   RUNBOOK.md says how to put it back.
// - Misuse protection: a honeypot field, a limit per network per hour, one
//   code per email, a daily cap on invite emails that alerts the team (the
//   DAILY_EMAIL_CAP_REACHED log line, which the stack alarms on), and a
//   separate daily cap on re-sends, so re-sends can't use up the invites' emails.
import { createHash, randomUUID } from "node:crypto";
import { inviteEmail } from "./email.mjs";

// The same check as the page's sign-up form. Plain ASCII addresses only: no
// < > " , ; ( ) or spaces, which could turn one address into a display name
// plus another address, and no non-ASCII ones, which SES may refuse
// (international domains in their xn-- form are fine). No dot at the start or
// end of the part before the @, or two dots in a row, and no hyphen at the
// start or end of a domain name's parts: SES refuses those.
export const EMAIL = /^[A-Za-z0-9_%+'!#$&*=?^{|}~-]+(?:\.[A-Za-z0-9_%+'!#$&*=?^{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,}|xn--[A-Za-z0-9-]+)$/;
const MAX = { name: 200, organization: 200, email: 254 };

const hour = (now) => now.toISOString().slice(0, 13);   // 2026-12-15T09
const day = (now) => now.toISOString().slice(0, 10);    // 2026-12-15
const epoch = (date) => Math.floor(date.getTime() / 1000);

// "Invite the next N" stops after this many failures in a row: lcw-back-end or SES is probably down
const FAILURES_IN_A_ROW = 3;
// A new sign-up's first-N place is decided within its request, which the
// function's Timeout (22 seconds, template.yaml) ends. One still undecided
// after this long was cut short by an error.
const UNDECIDED_AFTER_MS = 35_000;
// Time an invite needs, so it isn't cut off by the function's Timeout partway:
// the API key (2 s), making the code (6 s), sending (4 s), and the three table
// writes around them (1.5 s each at most: connecting and answering, store.mjs). If one of those fails,
// putting it back can take a little longer; if the function is cut off then,
// the claim goes stale and the invite can be finished later.
const NEEDS_TO_MINT_MS = 17_000, NEEDS_TO_SEND_MS = 8_000;

// Whether a send's error is about the person's address, so it counts against
// them: SES refusing the request as invalid. lcw-back-end's errors never are
// (it answers 400 only to a broken request), nor are outages, throttling or timeouts.
const aboutTheAddress = (error) => error?.name === "BadRequestException";
// Whether a code's expiry date has passed
const expired = (expiresAt, now) => Boolean(expiresAt) && Date.parse(expiresAt) <= now.getTime();
// A send that gave up waiting: SES may have sent it
const mayHaveGone = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";

// An error as one line for the logs, with any email address taken out (SES's
// errors can name the recipient). With stack, the stack trace too.
const ADDRESS = /[A-Za-z0-9._%+'!#$&*=?^{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
export function describeError(error, { stack = false } = {}) {
    const text = error instanceof Error ? (stack && error.stack) || `${error.name}: ${error.message}` : String(error);
    return text.replace(ADDRESS, "[an address]");
}

// The part of an address one person controls, which the per-IP limit counts:
// a whole IPv4 address, or the first half (the /64) of an IPv6 one, since an
// IPv6 home or server usually has a whole /64 to pick addresses from.
export function networkOf(ip) {
    const text = String(ip ?? "unknown").trim().toLowerCase();
    const v4 = text.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4) return v4[1];
    if (!/^[0-9a-f:]+$/.test(text) || !text.includes(":")) return text;
    const halves = text.split("::");
    if (halves.length > 2) return text;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return text;
    const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
    return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

export function configFromEnv(env = process.env) {
    return {
        autoInviteLimit: Number(env.AUTO_INVITE_LIMIT ?? "100"),
        dailyEmailCap: Number(env.DAILY_EMAIL_CAP ?? "300"),
        ipHourlyLimit: Number(env.IP_HOURLY_LIMIT ?? "10"),
        resendGapMinutes: Number(env.RESEND_GAP_MINUTES ?? "60"),
        resendDailyCap: Number(env.RESEND_DAILY_CAP ?? "50"),
        maxResends: Number(env.MAX_RESENDS ?? "3"),
        maxFailures: Number(env.MAX_FAILURES ?? "3"),
        // An invite still unfinished after this long (a timeout, say) is tried again
        staleMinutes: Number(env.STALE_MINUTES ?? "15"),
        maxBatch: Number(env.MAX_BATCH ?? "100")
    };
}

export function makeService({ store, mintCode, sendEmail, config, log = console, clock = () => new Date() }) {
    // Takes one email from today's cap; false, with the alert line logged, when it's used up
    async function takeEmail(now) {
        const tomorrowPlusOne = new Date(now.getTime() + 2 * 86_400_000);
        if (await store.take(`emails#${day(now)}`, config.dailyEmailCap, epoch(tomorrowPlusOne))) return true;
        log.error(`DAILY_EMAIL_CAP_REACHED: ${config.dailyEmailCap} emails already sent on ${day(now)}; nothing more is sent until tomorrow (UTC)`);
        return false;
    }

    const staleBefore = (now) => new Date(now.getTime() - (config.staleMinutes ?? 15) * 60_000).toISOString();

    // Undoes a claim after an invite didn't go out: back in the queue in its
    // old place, or set aside as "failed" (giveUp). A failure here is only
    // logged: the row is then left "inviting", and is tried again once stale.
    async function putBack(email, now, claimedAt, { emailTaken, failed = false, giveUp = false }) {
        try {
            await store.release(email, claimedAt, { failed, giveUp });
        } catch (error) {
            log.error("INVITE_FAILED: couldn't put a sign-up back in the queue; it's tried again in a few minutes:", describeError(error));
        }
        // Apart from the release, so today's email is given back even if that failed
        if (emailTaken) {
            await store.giveBack(`emails#${day(now)}`).catch((error) => log.error("INVITE_FAILED: couldn't give back today's email:", describeError(error)));
        }
    }

    // Invites one sign-up: makes their code (or reuses the one made by an
    // earlier try), emails it, records it. Answers "invited", "skipped" (not
    // waiting for an invite, or someone else is inviting it right now), "cap"
    // (today's emails are used up), "refused" (SES refused the address),
    // "late" (not enough time left to start it) or "failed". If the
    // invite doesn't go out, the sign-up goes back in the queue in its old place. Throws only if the
    // claim itself fails, before anything has changed (or, rarely, with the
    // row claimed, which is then tried again once stale). timeLeft() is the
    // function's time left; it isn't started without enough for each step.
    // With countRefusals, SES refusing the address counts toward setting it
    // aside ("invite the next N" only, which stops after 3 failures in a row).
    async function inviteOne(email, timeLeft = () => Infinity, { countRefusals = false } = {}) {
        const now = clock();
        const claimedAt = now.toISOString();
        const row = await store.claim(email, claimedAt, staleBefore(now));
        if (!row) return "skipped";
        if (timeLeft() < (row.code && !expired(row.expiresAt, now) ? NEEDS_TO_SEND_MS : NEEDS_TO_MINT_MS)) {
            log.error("INVITE_FAILED: an invite wasn't started, as there wasn't enough time left in this request. The person keeps their place; run \"invite the next N\" to invite them");
            await putBack(email, now, claimedAt, { emailTaken: false });
            return "late";
        }
        // From here on, any error puts the sign-up back, so it's never left "inviting"
        // If taking today's email fails, it isn't given back: the take may have landed or not,
        // and giving back one that didn't would let the cap be passed. Erring high is safe.
        let emailTaken = false;
        let step = "counting today's emails";
        try {
            if (!(await takeEmail(now))) {
                await putBack(email, now, claimedAt, { emailTaken: false });
                return "cap";
            }
            emailTaken = true;
            // A code made on an earlier try that never finished is reused, unless it has expired since
            let codes = row.code && !expired(row.expiresAt, now) ? { code: row.code, link: row.link, expiresAt: row.expiresAt } : null;
            if (!codes) {
                step = "making the code";
                const made = await mintCode(email);
                step = "keeping the code on the row";   // if this fails, that code is never sent to anyone
                await store.saveCode(email, made, claimedAt);
                codes = made;
            }
            step = "sending the email";
            await sendEmail({ to: email, ...inviteEmail(codes) });
        } catch (error) {
            log.error(`INVITE_FAILED for a sign-up (${step}):`, describeError(error));
            // Only SES refusing this address counts against the person
            const refused = step === "sending the email" && aboutTheAddress(error);
            const failed = refused && countRefusals;
            const giveUp = failed && (row.failures ?? 0) + 1 >= config.maxFailures;
            if (giveUp) log.error(`INVITE_FAILED: a sign-up's address has been refused ${config.maxFailures} times, so it's set aside as "failed" and left out of the queue until it's put back (RUNBOOK.md)`);
            // If SES may have sent it, today's email stays counted, so the cap is never passed
            const unsure = step === "sending the email" && mayHaveGone(error);
            if (unsure) log.warn("The invite may have gone anyway; trying again may send it twice");
            await putBack(email, now, claimedAt, { emailTaken: emailTaken && !unsure, failed, giveUp });
            return refused ? "refused" : "failed";
        }
        try {
            await store.markInvited(email, claimedAt, claimedAt);
        } catch (error) {
            // The email went; only the record of it failed. Once stale, the row is
            // tried again, which re-sends the same code.
            log.error("INVITE_FAILED: the invite was sent but not recorded:", describeError(error));
        }
        return "invited";
    }

    // Decides whether a new sign-up gets one of the first-N places, records the
    // answer on the row (autoInvite 1 or 0), and if it's yes, invites them.
    // The answer is recorded once; `token` tells this request's answer from
    // another's, if two decide at once (only possible after an earlier error).
    async function decidePlace(email, timeLeft) {
        const placed = await store.take("auto-invites", config.autoInviteLimit);
        const token = `${clock().toISOString()}#${randomUUID()}`;
        try {
            await store.markAutoInvite(email, placed ? 1 : 0, token);
        } catch (error) {
            // Did it land? (Its answer may have been lost, another request decided first, or
            // "invite the next N" took the row.)
            const row = await store.getSignup(email).catch(() => null);
            if (row?.decidedBy !== token) {
                // Another request decided it, or it's being invited anyway: that stands, and this
                // write can't land now (its condition fails), so any place taken here goes back
                if (row && (row.autoInvite !== undefined || row.status !== "queued")) {
                    if (placed) await store.giveBack("auto-invites").catch((e) => log.error("SIGNUP_FAILED: couldn't give back a first-N place; one is now unused:", describeError(e)));
                    return;
                }
                // Otherwise it can't be told: a write that timed out can still land later. So any
                // place taken stays taken: one place unused beats two people in it.
                throw error;
            }
        }
        if (placed) await inviteOne(email, timeLeft);
    }

    // One sign-up from the page. Answers { status, body } for the HTTP response.
    // Every accepted sign-up gets the same answer, so the page can't be used to
    // learn whether an address has signed up before. (The one exception, a 503
    // while that address's own sign-up is still being handled, lasts about a
    // second, or 30 seconds after an error.) timeLeft() is the function's time left.
    async function signUp(input, ip, timeLeft = () => Infinity) {
        const ok = { status: 202, body: { ok: true } };
        if (typeof input !== "object" || input === null) return { status: 400, body: { error: "Send a JSON object." } };
        // The honeypot: a field people never see, so only a bot fills it in. It gets the usual answer.
        if (typeof input.website === "string" && input.website.trim()) {
            log.warn("A sign-up filled in the honeypot field; ignored");
            return ok;
        }
        const name = typeof input.name === "string" ? input.name.trim() : "";
        const organization = typeof input.organization === "string" ? input.organization.trim() : "";
        const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
        if (!name || name.length > MAX.name) return { status: 400, body: { error: "Enter your name." } };
        if (organization.length > MAX.organization) return { status: 400, body: { error: "Organization is too long." } };
        if (email.length > MAX.email || !EMAIL.test(email)) return { status: 400, body: { error: "Check your email address." } };

        const now = clock();
        const ipKey = `ip#${createHash("sha256").update(networkOf(ip)).digest("hex").slice(0, 32)}#${hour(now)}`;
        if (!(await store.take(ipKey, config.ipHourlyLimit, epoch(now) + 2 * 3600))) {
            log.warn("A sign-up was refused: too many from one network this hour");
            // reason tells the page this is the per-network limit, not API Gateway's own 429 (its whole-API throttle)
            return { status: 429, body: { error: "Too many sign-ups from your network. Try again later.", reason: "ip-hourly-limit" } };
        }

        if (await store.createSignup({ email, name, organization, signedUpAt: now.toISOString() })) {
            // Only a new sign-up takes a first-N place. The row records it before the invite, so if the
            // invite fails they keep the place and stay first in the queue (see the top of this file).
            await decidePlace(email, timeLeft);
            return ok;
        }

        // Signed up before: finish an invite they're owed (one of the first N whose
        // invite failed, or one that got stuck), or re-send their code if they've been invited
        const row = await store.getSignup(email);
        if ((row?.status === "queued" && row.autoInvite) || (row?.status === "inviting" && row.claimedAt < staleBefore(now))) {
            await inviteOne(email, timeLeft);
            return ok;
        }
        // Their first-N place isn't decided yet. Either their first request is still running (the
        // form sent twice at once), so ask them to try again shortly, or an error cut it short, so
        // decide it now. Deciding it straight away would let the same form sent twice take two places.
        if (row?.status === "queued" && row.autoInvite === undefined) {
            if (Date.parse(row.signedUpAt) > now.getTime() - UNDECIDED_AFTER_MS) return { status: 503, body: { error: "Sign-up is busy. Please try again in a minute." } };
            await decidePlace(email, timeLeft);
            return ok;
        }
        if (row?.status !== "invited") return ok;
        // An expired code isn't re-sent. The wallet's register page tells them to email support for a new one.
        if (expired(row.expiresAt, now)) {
            log.warn("A re-send wasn't sent: that sign-up's code has expired");
            return ok;
        }
        const at = now.toISOString();
        const before = new Date(now.getTime() - config.resendGapMinutes * 60_000).toISOString();
        // If the re-send doesn't go out, undo markEmailed, so trying again later isn't blocked for
        // the gap and the re-send isn't counted. Safe to run even if markEmailed didn't happen:
        // it only acts while lastEmailedAt is still `at`.
        const undo = async () => {
            try { await store.unmarkEmailed(email, at, row.lastEmailedAt); } catch (error) { log.error("Couldn't undo a re-send's time:", describeError(error)); }
        };
        // Re-sends have their own daily cap, apart from the invites' one, so
        // re-sending to invited addresses can't stop invites for the day
        const resends = `resends#${day(now)}`;
        let taken = false;
        try {
            // Re-sent within the gap, or re-sent maxResends times already
            if (!(await store.markEmailed(email, at, before, config.maxResends))) return ok;
            if (!(await store.take(resends, config.resendDailyCap, epoch(new Date(now.getTime() + 2 * 86_400_000))))) {
                log.warn(`A re-send was refused: today's ${config.resendDailyCap} re-sends are used up`);
                await undo();
                return ok;
            }
            taken = true;
            await sendEmail({ to: email, ...inviteEmail(row) });
        } catch (error) {
            log.error("INVITE_FAILED re-sending an invite:", describeError(error));
            // If SES may have sent it, it stays counted, so the re-send limits are never passed
            if (taken && mayHaveGone(error)) {
                log.warn("The re-send may have gone anyway, so it stays counted");
                return ok;
            }
            await undo();
            if (taken) await store.giveBack(resends).catch((e) => log.error("Couldn't give back today's re-send:", describeError(e)));
        }
        return ok;
    }

    // Invites the next `count` sign-ups in the queue, oldest first. With
    // dryRun, sends nothing and answers who would be invited. Stops early
    // (stoppedEarly) if the time left, from timeLeft(), runs low, and
    // (stoppedOnFailures) after FAILURES_IN_A_ROW failures in a row.
    async function inviteNext({ count, dryRun = false, timeLeft = () => Infinity } = {}) {
        if (!Number.isInteger(count) || count < 1 || count > config.maxBatch) {
            return { error: `count must be a whole number from 1 to ${config.maxBatch}` };
        }
        const now = clock();
        // Leaves out a brand-new sign-up whose own request is still deciding its first-N place (and may invite it)
        const queued = (await store.listQueued(count, staleBefore(now)))
            .filter((r) => !(r.status === "queued" && r.autoInvite === undefined && Date.parse(r.signedUpAt) > now.getTime() - UNDECIDED_AFTER_MS));
        const people = queued.map(({ email, name, organization, signedUpAt }) => ({ email, name, organization, signedUpAt }));
        if (dryRun) return { dryRun: true, wouldInvite: people };
        const results = { invited: [], skipped: [], failed: [], capReached: false, stoppedEarly: false, stoppedOnFailures: false };
        let failedInARow = 0;
        for (const [i, person] of people.entries()) {
            if (timeLeft() < 30_000) { results.stoppedEarly = true; break; }
            let result;
            try {
                result = await inviteOne(person.email, timeLeft, { countRefusals: true });
            } catch (error) {
                // One person's error doesn't stop the rest, and the answer still says who was invited
                log.error("INVITE_FAILED: couldn't start an invite:", describeError(error));
                result = "failed";
            }
            if (result === "cap") { results.capReached = true; break; }
            if (result === "late") { results.stoppedEarly = true; break; }   // out of time, as above
            results[result === "invited" ? "invited" : result === "skipped" ? "skipped" : "failed"].push(person.email);
            // Refused addresses count too: SES refusing everyone means it's set up wrong
            failedInARow = result === "failed" || result === "refused" ? failedInARow + 1 : 0;
            if (failedInARow >= FAILURES_IN_A_ROW && i < people.length - 1) {
                log.error(`INVITE_FAILED: ${FAILURES_IN_A_ROW} invites failed in a row, so inviting stopped; lcw-back-end or SES may be down or set up wrong`);
                results.stoppedOnFailures = true;
                break;
            }
        }
        return results;
    }

    return { signUp, inviteNext, inviteOne };
}
