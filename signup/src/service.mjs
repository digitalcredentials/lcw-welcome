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
//   the same code (at most once per RESEND_GAP_MINUTES), never a new one.
// - Misuse protection: a honeypot field, a limit per IP address per hour,
//   one code per email, and a daily cap on emails that alerts the team
//   (the DAILY_EMAIL_CAP_REACHED log line, which the stack alarms on).
import { createHash } from "node:crypto";
import { inviteEmail } from "./email.mjs";

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;   // the same check as the page's
const MAX = { name: 200, organization: 200, email: 254 };

const hour = (now) => now.toISOString().slice(0, 13);   // 2026-12-15T09
const day = (now) => now.toISOString().slice(0, 10);    // 2026-12-15
const epoch = (date) => Math.floor(date.getTime() / 1000);

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

    // Undoes a claim after an invite didn't go out. A failure here is only
    // logged: the row is then left "inviting", and is tried again once stale.
    async function putBack(email, now, claimedAt, { emailTaken }) {
        try {
            await store.release(email, claimedAt);
            if (emailTaken) await store.giveBack(`emails#${day(now)}`);
        } catch (error) {
            log.error("INVITE_FAILED: couldn't put a sign-up back in the queue; it's tried again in a few minutes:", error?.message ?? error);
        }
    }

    // Invites one sign-up: makes their code (or reuses the one made by an
    // earlier try), emails it, records it. Answers "invited", "skipped" (not
    // waiting for an invite, or someone else is inviting it right now), "cap"
    // (today's emails are used up) or "failed". If the invite doesn't go out,
    // the sign-up goes back in the queue in its old place.
    async function inviteOne(email) {
        const now = clock();
        const claimedAt = now.toISOString();
        const row = await store.claim(email, claimedAt, staleBefore(now));
        if (!row) return "skipped";
        if (!(await takeEmail(now))) {
            await putBack(email, now, claimedAt, { emailTaken: false });
            return "cap";
        }
        let codes = row.code ? { code: row.code, link: row.link, expiresAt: row.expiresAt } : null;
        try {
            if (!codes) {
                codes = await mintCode(email);
                await store.saveCode(email, codes, claimedAt);
            }
            await sendEmail({ to: email, ...inviteEmail(codes) });
        } catch (error) {
            log.error(`INVITE_FAILED for a sign-up (${codes ? "sending the email" : "making the code"}):`, error?.message ?? error);
            await putBack(email, now, claimedAt, { emailTaken: true });
            return "failed";
        }
        try {
            await store.markInvited(email, claimedAt, claimedAt);
        } catch (error) {
            // The email went; only the record of it failed. Once stale, the row is
            // tried again, which re-sends the same code.
            log.error("INVITE_FAILED: the invite was sent but not recorded:", error?.message ?? error);
        }
        return "invited";
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
        if (!EMAIL.test(email) || email.length > MAX.email) return { status: 400, body: { error: "Check your email address." } };

        const now = clock();
        const ipKey = `ip#${createHash("sha256").update(networkOf(ip)).digest("hex").slice(0, 32)}#${hour(now)}`;
        if (!(await store.take(ipKey, config.ipHourlyLimit, epoch(now) + 2 * 3600))) {
            log.warn("A sign-up was refused: too many from one network this hour");
            // reason tells the page this is the per-network limit, not API Gateway's own 429 (its whole-API throttle)
            return { status: 429, body: { error: "Too many sign-ups from your network. Try again later.", reason: "ip-hourly-limit" } };
        }

        // A first-N place is taken before the row is made, so the row records it
        const autoInvite = await store.take("auto-invites", config.autoInviteLimit);
        if (await store.createSignup({ email, name, organization, signedUpAt: now.toISOString(), autoInvite })) {
            // If this invite fails, they keep the place and stay first in the queue (see the top of this file)
            if (autoInvite) await inviteOne(email);
            return ok;
        }
        if (autoInvite) await store.giveBack("auto-invites");   // signed up before, so not a new place

        // Signed up before: finish an invite they're owed (one of the first N whose
        // invite failed, or one that got stuck), or re-send their code if they've been invited
        const row = await store.getSignup(email);
        if ((row?.status === "queued" && row.autoInvite) || (row?.status === "inviting" && row.claimedAt < staleBefore(now))) {
            await inviteOne(email);
            return ok;
        }
        if (row?.status !== "invited") return ok;
        const at = now.toISOString();
        const before = new Date(now.getTime() - config.resendGapMinutes * 60_000).toISOString();
        if (!(await store.markEmailed(email, at, before))) return ok;   // re-sent within the gap
        // If the re-send doesn't go out, undo markEmailed, so trying again later isn't blocked for the gap
        const undo = async () => {
            try { await store.unmarkEmailed(email, at, row.lastEmailedAt); } catch (error) { log.error("Couldn't undo a re-send's time:", error?.message ?? error); }
        };
        if (!(await takeEmail(now))) { await undo(); return ok; }
        try {
            await sendEmail({ to: email, ...inviteEmail(row) });
        } catch (error) {
            log.error("INVITE_FAILED re-sending an invite:", error?.message ?? error);
            await store.giveBack(`emails#${day(now)}`);
            await undo();
        }
        return ok;
    }

    // Invites the next `count` sign-ups in the queue, oldest first. With
    // dryRun, sends nothing and answers who would be invited. Stops early
    // (stoppedEarly) if the time left, from timeLeft(), runs low.
    async function inviteNext({ count, dryRun = false, timeLeft = () => Infinity } = {}) {
        if (!Number.isInteger(count) || count < 1 || count > config.maxBatch) {
            return { error: `count must be a whole number from 1 to ${config.maxBatch}` };
        }
        const queued = await store.listQueued(count, staleBefore(clock()));
        const people = queued.map(({ email, name, organization, signedUpAt }) => ({ email, name, organization, signedUpAt }));
        if (dryRun) return { dryRun: true, wouldInvite: people };
        const results = { invited: [], skipped: [], failed: [], capReached: false, stoppedEarly: false };
        for (const person of people) {
            if (timeLeft() < 30_000) { results.stoppedEarly = true; break; }
            const result = await inviteOne(person.email);
            if (result === "cap") { results.capReached = true; break; }
            results[result === "invited" ? "invited" : result === "skipped" ? "skipped" : "failed"].push(person.email);
        }
        return results;
    }

    return { signUp, inviteNext, inviteOne };
}
