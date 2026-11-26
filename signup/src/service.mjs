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
// - An invite that fails MAX_FAILURES times (making the code or sending the
//   email) is set aside as "failed", out of the queue, so one bad address
//   can't sit at the front of it for ever. RUNBOOK.md says how to put it back.
// - Misuse protection: a honeypot field, a limit per network per hour, one
//   code per email, a daily cap on invite emails that alerts the team (the
//   DAILY_EMAIL_CAP_REACHED log line, which the stack alarms on), and a
//   separate daily cap on re-sends, so re-sends can't use up the invites' emails.
import { createHash } from "node:crypto";
import { inviteEmail } from "./email.mjs";

// The same check as the page's sign-up form. Plain ASCII addresses only: no
// < > " , ; ( ) or spaces, which could turn one address into a display name
// plus another address, and no non-ASCII ones, which SES may refuse. No dot
// at the start or end of the part before the @, or two dots in a row, and no
// hyphen at the start or end of a domain name's parts: SES refuses those.
export const EMAIL = /^[A-Za-z0-9_%+'-]+(?:\.[A-Za-z0-9_%+'-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const MAX = { name: 200, organization: 200, email: 254 };

const hour = (now) => now.toISOString().slice(0, 13);   // 2026-12-15T09
const day = (now) => now.toISOString().slice(0, 10);    // 2026-12-15
const epoch = (date) => Math.floor(date.getTime() / 1000);

// "Invite the next N" stops after this many failures in a row: lcw-back-end or SES is probably down
const FAILURES_IN_A_ROW = 3;
// A new sign-up's first-N place is decided within the request (20 seconds at
// most). One still undecided after this long was cut short by an error.
const UNDECIDED_AFTER_MS = 60_000;

// An error as one line for the logs, with any email address taken out (SES's
// errors can name the recipient). With stack, the stack trace too.
const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
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
            if (emailTaken) await store.giveBack(`emails#${day(now)}`);
        } catch (error) {
            log.error("INVITE_FAILED: couldn't put a sign-up back in the queue; it's tried again in a few minutes:", describeError(error));
        }
    }

    // Invites one sign-up: makes their code (or reuses the one made by an
    // earlier try), emails it, records it. Answers "invited", "skipped" (not
    // waiting for an invite, or someone else is inviting it right now), "cap"
    // (today's emails are used up) or "failed". If the invite doesn't go out,
    // the sign-up goes back in the queue in its old place. Throws only if the
    // claim itself fails, before anything has changed (or, rarely, with the
    // row claimed, which is then tried again once stale).
    async function inviteOne(email) {
        const now = clock();
        const claimedAt = now.toISOString();
        const row = await store.claim(email, claimedAt, staleBefore(now));
        if (!row) return "skipped";
        // From here on, any error puts the sign-up back, so it's never left "inviting"
        let emailTaken = false;
        let step = "counting today's emails";
        try {
            if (!(await takeEmail(now))) {
                await putBack(email, now, claimedAt, { emailTaken: false });
                return "cap";
            }
            emailTaken = true;
            let codes = row.code ? { code: row.code, link: row.link, expiresAt: row.expiresAt } : null;
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
            // Only lcw-back-end or SES failing counts against the person; a table error isn't theirs
            const failed = step === "making the code" || step === "sending the email";
            const giveUp = failed && (row.failures ?? 0) + 1 >= config.maxFailures;
            if (giveUp) log.error(`INVITE_FAILED: a sign-up's invite has failed ${config.maxFailures} times, so it's set aside as "failed" and left out of the queue until it's put back (RUNBOOK.md)`);
            await putBack(email, now, claimedAt, { emailTaken, failed, giveUp });
            return "failed";
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
    async function decidePlace(email) {
        if (!(await store.take("auto-invites", config.autoInviteLimit))) {
            await store.markAutoInvite(email, 0);
            return;
        }
        try {
            await store.markAutoInvite(email, 1);
        } catch (error) {
            // Give the place back only if the row shows it wasn't recorded. If
            // that can't be told, keep it: one place unused beats two people in it.
            const row = await store.getSignup(email).catch(() => null);
            if (row && row.autoInvite === undefined) await store.giveBack("auto-invites").catch(() => {});
            throw error;
        }
        await inviteOne(email);
    }

    // One sign-up from the page. Answers { status, body } for the HTTP response.
    // Every accepted sign-up gets the same answer, so the page can't be used to
    // learn whether an address has signed up before.
    async function signUp(input, ip) {
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
            await decidePlace(email);
            return ok;
        }

        // Signed up before: finish an invite they're owed (one of the first N whose
        // invite failed, or one that got stuck), or re-send their code if they've been invited
        const row = await store.getSignup(email);
        if ((row?.status === "queued" && row.autoInvite) || (row?.status === "inviting" && row.claimedAt < staleBefore(now))) {
            await inviteOne(email);
            return ok;
        }
        // An error cut their first try short before their first-N place was decided: decide it now.
        // (Not straight away, so the same form sent twice at once doesn't take two places.)
        if (row?.status === "queued" && row.autoInvite === undefined && Date.parse(row.signedUpAt) < now.getTime() - UNDECIDED_AFTER_MS) {
            await decidePlace(email);
            return ok;
        }
        if (row?.status !== "invited") return ok;
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
        const queued = await store.listQueued(count, staleBefore(clock()));
        const people = queued.map(({ email, name, organization, signedUpAt }) => ({ email, name, organization, signedUpAt }));
        if (dryRun) return { dryRun: true, wouldInvite: people };
        const results = { invited: [], skipped: [], failed: [], capReached: false, stoppedEarly: false, stoppedOnFailures: false };
        let failedInARow = 0;
        for (const [i, person] of people.entries()) {
            if (timeLeft() < 30_000) { results.stoppedEarly = true; break; }
            let result;
            try {
                result = await inviteOne(person.email);
            } catch (error) {
                // One person's error doesn't stop the rest, and the answer still says who was invited
                log.error("INVITE_FAILED: couldn't start an invite:", describeError(error));
                result = "failed";
            }
            if (result === "cap") { results.capReached = true; break; }
            results[result === "invited" ? "invited" : result === "skipped" ? "skipped" : "failed"].push(person.email);
            failedInARow = result === "failed" ? failedInARow + 1 : 0;
            if (failedInARow >= FAILURES_IN_A_ROW && i < people.length - 1) {
                log.error(`INVITE_FAILED: ${FAILURES_IN_A_ROW} invites failed in a row, so inviting stopped; lcw-back-end or SES is probably down`);
                results.stoppedOnFailures = true;
                break;
            }
        }
        return results;
    }

    return { signUp, inviteNext, inviteOne };
}
