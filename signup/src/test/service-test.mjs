// The sign-up rules, run against an in-memory store and fake minter and mailer.
//   cd signup/src && npm test
import { makeService, describeError } from "../service.mjs";
import { inviteEmail } from "../email.mjs";
import { memoryStore, fakeMinter, fakeMailer, quietLog, manualClock, checker } from "./helpers.mjs";

const { check, done } = checker();
const HOUR = 3_600_000;

function setup(overrides = {}) {
    const store = memoryStore(), mintCode = fakeMinter(), sendEmail = fakeMailer(), log = quietLog(), clock = manualClock();
    const config = { autoInviteLimit: 3, dailyEmailCap: 100, ipHourlyLimit: 100, resendGapMinutes: 60, resendDailyCap: 100, maxResends: 100, maxFailures: 3, maxBatch: 100, ...overrides };
    const service = makeService({ store, mintCode, sendEmail, config, log, clock });
    let n = 0;
    // Signs someone up a millisecond after the last, from their own IP address unless told otherwise
    const signUp = (input, ip = `10.0.0.${++n}`) => { clock.advance(1); return service.signUp(input, ip); };
    return { store, mintCode, sendEmail, log, clock, service, signUp };
}
const person = (i, extra = {}) => ({ name: `Person ${i}`, email: `p${i}@example.org`, ...extra });

// --- The first N are invited straight away; the rest wait
{
    const t = setup();
    const answers = [];
    for (let i = 1; i <= 5; i++) answers.push(await t.signUp(person(i, i === 1 ? { organization: "  DCC  " } : {})));
    check("every sign-up gets 202 { ok: true }", answers.every((a) => a.status === 202 && a.body.ok === true));
    check("the first 3 are invited", [1, 2, 3].every((i) => t.store.signups.get(`p${i}@example.org`).status === "invited"));
    check("the 4th and 5th are queued", [4, 5].every((i) => t.store.signups.get(`p${i}@example.org`).status === "queued"));
    check("3 codes made, one for each invited person", t.mintCode.calls.join() === "p1@example.org,p2@example.org,p3@example.org", t.mintCode.calls);
    check("3 invites emailed, to the right people", t.sendEmail.sent.map((m) => m.to).join() === "p1@example.org,p2@example.org,p3@example.org");
    const row = t.store.signups.get("p1@example.org");
    check("the invited row keeps the code, link and expiry", row.code === "LCW-TEST000000000001" && row.link.endsWith(row.code) && row.expiresAt === "2027-03-01T00:00:00.000Z" && Boolean(row.invitedAt));
    check("the email carries that person's link and code", t.sendEmail.sent[0].text.includes(row.link) && t.sendEmail.sent[0].html.includes(row.code));
    check("the organization is kept, trimmed", row.organization === "DCC");
    check("no organization, no organization field", !("organization" in t.store.signups.get("p2@example.org")));
    check("the auto-invite count is 3", t.store.counters.get("auto-invites") === 3);
    check("the first 3 rows record their first-N place; the others don't", [1, 2, 3].every((i) => t.store.signups.get(`p${i}@example.org`).autoInvite === 1) && [4, 5].every((i) => !t.store.signups.get(`p${i}@example.org`).autoInvite));
    check("today's email count is 3", t.store.counters.get("emails#2026-12-15") === 3);
}

// --- What the form sends is checked
{
    const t = setup();
    const answers = {
        notObject: await t.service.signUp("hello", "1.1.1.1"),
        noName: await t.signUp({ email: "a@example.org" }),
        blankName: await t.signUp({ name: "   ", email: "a@example.org" }),
        longName: await t.signUp({ name: "x".repeat(201), email: "a@example.org" }),
        badEmail: await t.signUp({ name: "A", email: "not-an-email" }),
        longEmail: await t.signUp({ name: "A", email: `${"x".repeat(250)}@example.org` }),
        longOrg: await t.signUp({ name: "A", email: "a@example.org", organization: "x".repeat(201) }),
        numberEmail: await t.signUp({ name: "A", email: 42 })
    };
    check("a body that isn't an object -> 400", answers.notObject.status === 400);
    check("no name, or a blank one -> 400 \"Enter your name.\"", [answers.noName, answers.blankName].every((a) => a.status === 400 && a.body.error === "Enter your name."));
    check("a name over 200 characters -> 400", answers.longName.status === 400);
    check("a bad or over-long email, or one that isn't text -> 400", [answers.badEmail, answers.longEmail, answers.numberEmail].every((a) => a.status === 400 && a.body.error === "Check your email address."));
    check("an organization over 200 characters -> 400", answers.longOrg.status === 400);
    check("nothing refused was stored or sent", t.store.signups.size === 0 && t.sendEmail.sent.length === 0);
}

// --- The honeypot
{
    const t = setup();
    const answer = await t.signUp({ ...person(1), website: "http://spam.example" });
    check("a filled-in honeypot gets the usual 202", answer.status === 202 && answer.body.ok === true);
    check("...but nothing is stored, made or sent", t.store.signups.size === 0 && t.mintCode.calls.length === 0 && t.sendEmail.sent.length === 0);
    const blank = await t.signUp({ ...person(2), website: "  " });
    check("a blank honeypot is a normal sign-up", blank.status === 202 && t.store.signups.has("p2@example.org"));
}

// --- One code per email address
{
    const t = setup({ autoInviteLimit: 1 });
    await t.signUp({ name: "Ann", email: "  Ann@Example.ORG " });
    check("the address is stored trimmed and lowercased", t.store.signups.has("ann@example.org") && t.store.signups.size === 1);
    t.clock.advance(5 * 60_000);
    await t.signUp({ name: "Someone else", email: "ann@example.org" });
    check("signing up again within the hour sends nothing more", t.sendEmail.sent.length === 1 && t.mintCode.calls.length === 1);
    check("...and doesn't change the name", t.store.signups.get("ann@example.org").name === "Ann");
    t.clock.advance(HOUR);
    await t.signUp({ name: "Ann", email: "ANN@example.org" });
    check("after an hour, signing up again re-sends the same code", t.sendEmail.sent.length === 2 && t.mintCode.calls.length === 1 && t.sendEmail.sent[1].text.includes("LCW-TEST000000000001"));
    await t.signUp({ name: "Ann", email: "ann@example.org" });
    check("...and only once an hour", t.sendEmail.sent.length === 2);

    await t.signUp(person(2));
    await t.signUp(person(2));
    check("a queued person signing up again is still queued once, with nothing sent", t.store.signups.get("p2@example.org").status === "queued" && t.sendEmail.sent.length === 2);
}

// --- One code per email, even after it expires (a new one would allow a second wallet)
{
    const t = setup();
    t.mintCode.expiresAt = "2026-12-20T00:00:00.000Z";
    await t.signUp(person(1));
    t.clock.set("2026-12-21T00:00:00.000Z");
    await t.signUp(person(1));
    check("after the code expires, signing up again sends nothing (the expired code is no use) and makes no new code",
        t.mintCode.calls.length === 1 && t.sendEmail.sent.length === 1 && t.log.lines.some((l) => l.startsWith("warn") && l.includes("has expired")) && t.store.signups.get("p1@example.org").resends === undefined);
}
{
    // A code made on a try that never finished, which expired before the invite went
    const t = setup({ autoInviteLimit: 1 });
    t.mintCode.expiresAt = "2026-12-20T00:00:00.000Z";
    t.sendEmail.fail = true;
    await t.signUp(person(1));
    t.sendEmail.fail = false;
    t.mintCode.expiresAt = "2027-04-01T00:00:00.000Z";
    t.clock.set("2026-12-21T00:00:00.000Z");
    await t.service.inviteNext({ count: 1 });
    const row = t.store.signups.get("p1@example.org");
    check("an invite whose saved code expired before it went makes a new code and sends that", t.mintCode.calls.length === 2 && row.status === "invited" && row.code === "LCW-TEST000000000002" && t.sendEmail.sent[0].text.includes(row.code));
}

// --- The limit per IP address per hour
{
    const t = setup({ ipHourlyLimit: 2 });
    const a = await t.signUp(person(1), "203.0.113.9");
    const b = await t.signUp(person(2), "203.0.113.9");
    const c = await t.signUp(person(3), "203.0.113.9");
    check("2 sign-ups from one address are accepted", a.status === 202 && b.status === 202);
    check("the 3rd in the same hour -> 429, marked as the per-network limit", c.status === 429 && /Too many sign-ups/.test(c.body.error) && c.body.reason === "ip-hourly-limit" && !t.store.signups.has("p3@example.org"));
    const other = await t.signUp(person(4), "198.51.100.7");
    check("another address is still accepted", other.status === 202);
    t.clock.advance(HOUR);
    const later = await t.signUp(person(3), "203.0.113.9");
    check("the next hour, the first address is accepted again", later.status === 202 && t.store.signups.has("p3@example.org"));
    check("the address isn't kept, only a hash of it", [...t.store.counters.keys()].every((k) => !k.includes("203.0.113.9")));
}

// --- The daily email cap
{
    const t = setup({ autoInviteLimit: 10, dailyEmailCap: 2 });
    for (let i = 1; i <= 3; i++) await t.signUp(person(i));
    check("emails stop at the cap", t.sendEmail.sent.length === 2);
    check("the person over the cap is queued, with no code made", t.store.signups.get("p3@example.org").status === "queued" && t.mintCode.calls.length === 2);
    check("...and keeps their place among the first N", t.store.counters.get("auto-invites") === 3 && t.store.signups.get("p3@example.org").autoInvite === 1);
    check("reaching the cap logs the alert line", t.log.lines.some((l) => l.startsWith("error DAILY_EMAIL_CAP_REACHED")));
    t.clock.set("2026-12-16T00:00:01.000Z");
    await t.signUp(person(4));
    check("the next day (UTC), invites go out again", t.store.signups.get("p4@example.org").status === "invited");
    await t.signUp(person(3));
    check("the person who hit the cap, signing up again, gets the invite they were owed", t.store.signups.get("p3@example.org").status === "invited" && t.store.counters.get("auto-invites") === 4);
}

// --- When making the code or sending the email fails
for (const what of ["mintCode", "sendEmail"]) {
    const t = setup();
    t[what].fail = true;
    const answer = await t.signUp(person(1));
    check(`${what} failing: the form still gets 202`, answer.status === 202);
    check(`${what} failing: the person goes back in the queue`, t.store.signups.get("p1@example.org").status === "queued");
    check(`${what} failing: today's email is given back; they keep their first-N place`, t.store.counters.get("auto-invites") === 1 && t.store.counters.get("emails#2026-12-15") === 0 && t.store.signups.get("p1@example.org").autoInvite === 1);
    check(`${what} failing: INVITE_FAILED is logged, for the alarm`, t.log.lines.some((l) => l.startsWith("error INVITE_FAILED")));
    t[what].fail = false;
    const later = await t.service.inviteNext({ count: 5 });
    check(`${what} failing: the next "invite the next N" invites them`, later.invited.join() === "p1@example.org" && t.store.signups.get("p1@example.org").status === "invited");
}

// --- The invite went but recording it failed
{
    const t = setup();
    const markInvited = t.store.markInvited;
    t.store.markInvited = async () => { throw new Error("table unavailable"); };
    const answer = await t.signUp(person(1));
    check("recording failing after the email went: still 202, logged, and the row is left \"inviting\"",
        answer.status === 202 && t.sendEmail.sent.length === 1 && t.store.signups.get("p1@example.org").status === "inviting" && t.log.lines.some((l) => l.includes("sent but not recorded")));
    t.store.markInvited = markInvited;
    const soon = await t.service.inviteNext({ count: 5 });
    check("...right after, \"invite the next N\" leaves it alone", soon.invited.length === 0 && t.sendEmail.sent.length === 1);
    t.clock.advance(16 * 60_000);
    const later = await t.service.inviteNext({ count: 5 });
    check("...15 minutes later, it's finished, with the same code (no second one made)",
        later.invited.join() === "p1@example.org" && t.mintCode.calls.length === 1 && t.sendEmail.sent[1].text.includes("LCW-TEST000000000001") && t.store.signups.get("p1@example.org").status === "invited");
}

// --- A sign-up stuck halfway (the function timed out, or putting it back failed) isn't lost
{
    const t = setup();
    t.sendEmail.fail = true;
    t.store.release = async () => { throw new Error("table unavailable"); };
    const answer = await t.signUp(person(1));
    check("putting it back failing: still 202, logged, and left \"inviting\" with its code kept",
        answer.status === 202 && t.store.signups.get("p1@example.org").status === "inviting" && t.store.signups.get("p1@example.org").code === "LCW-TEST000000000001" && t.log.lines.some((l) => l.includes("couldn't put a sign-up back")));
    t.sendEmail.fail = false;
    t.clock.advance(5 * 60_000);
    await t.signUp(person(1));
    check("signing up again within 15 minutes leaves it alone", t.sendEmail.sent.length === 0);
    t.clock.advance(11 * 60_000);
    await t.signUp(person(1));
    check("signing up again after 15 minutes finishes the invite, with the code already made",
        t.sendEmail.sent.length === 1 && t.mintCode.calls.length === 1 && t.sendEmail.sent[0].text.includes("LCW-TEST000000000001") && t.store.signups.get("p1@example.org").status === "invited");
}
{
    const t = setup({ autoInviteLimit: 0 });
    await t.signUp(person(1));
    await t.signUp(person(2));
    await t.store.claim("p1@example.org", new Date(t.clock().getTime() - 20 * 60_000).toISOString(), "");   // stuck since 20 minutes ago
    const dry = await t.service.inviteNext({ count: 5, dryRun: true });
    check("\"invite the next N\" lists a stuck sign-up in its place in the queue", dry.wouldInvite.map((p) => p.email).join() === "p1@example.org,p2@example.org");
}

// --- When sending fails after the code was made, trying again reuses that code
{
    const t = setup();
    t.sendEmail.fail = true;
    await t.signUp(person(1));
    t.sendEmail.fail = false;
    await t.service.inviteNext({ count: 1 });
    check("the retry sends the code made the first time, and makes no second one", t.mintCode.calls.length === 1 && t.sendEmail.sent[0].text.includes("LCW-TEST000000000001"));
}

// --- Invite the next N
{
    const t = setup({ autoInviteLimit: 0, maxBatch: 50 });
    for (let i = 1; i <= 6; i++) await t.signUp(person(i));
    check("with the first-N limit at 0, everyone waits", t.sendEmail.sent.length === 0);
    for (const count of [0, -1, 51, 2.5, "3", undefined]) {
        const answer = await t.service.inviteNext({ count });
        check(`count ${JSON.stringify(count)} is refused`, typeof answer.error === "string" && t.sendEmail.sent.length === 0);
    }
    const dry = await t.service.inviteNext({ count: 2, dryRun: true });
    check("a dry run lists the next 2, oldest first", dry.dryRun === true && dry.wouldInvite.map((p) => p.email).join() === "p1@example.org,p2@example.org");
    check("...with name and sign-up time, and sends nothing", dry.wouldInvite[0].name === "Person 1" && Boolean(dry.wouldInvite[0].signedUpAt) && t.sendEmail.sent.length === 0 && t.store.signups.get("p1@example.org").status === "queued");
    const first = await t.service.inviteNext({ count: 2 });
    check("inviting 2 invites the 2 oldest", first.invited.join() === "p1@example.org,p2@example.org" && t.sendEmail.sent.length === 2);
    const rest = await t.service.inviteNext({ count: 10 });
    check("asking for more than are waiting invites everyone left, in order", rest.invited.join() === "p3@example.org,p4@example.org,p5@example.org,p6@example.org");
    const none = await t.service.inviteNext({ count: 3 });
    check("with nobody waiting, nothing happens", none.invited.length === 0 && t.sendEmail.sent.length === 6);
    check("invites from the admin console don't count toward the first N", (t.store.counters.get("auto-invites") ?? 0) === 0);
}
{
    const t = setup({ autoInviteLimit: 0 });
    for (let i = 1; i <= 3; i++) await t.signUp(person(i));
    let left = 40_000;
    const answer = await t.service.inviteNext({ count: 3, timeLeft: () => (left -= 6_000) });
    check("when time runs short, it stops early, says so, and the rest stay queued",
        answer.stoppedEarly === true && answer.invited.length === 1 && t.store.signups.get("p3@example.org").status === "queued");
}
{
    const t = setup({ autoInviteLimit: 0, dailyEmailCap: 2 });
    for (let i = 1; i <= 4; i++) await t.signUp(person(i));
    const answer = await t.service.inviteNext({ count: 4 });
    check("at the daily cap, inviting stops and says so", answer.capReached === true && answer.invited.length === 2);
    check("...and the rest stay queued, in order", t.store.signups.get("p3@example.org").status === "queued" && t.store.signups.get("p4@example.org").status === "queued");
}
{
    // Two people pressing the button at once: the second finds the rows already claimed
    const t = setup({ autoInviteLimit: 0 });
    for (let i = 1; i <= 2; i++) await t.signUp(person(i));
    const listed = await t.store.listQueued(2);
    t.store.listQueued = async () => listed;   // both runs see the same two rows
    const [a, b] = await Promise.all([t.service.inviteNext({ count: 2 }), t.service.inviteNext({ count: 2 })]);
    check("two runs at once invite each person once", t.sendEmail.sent.length === 2 && a.invited.length + b.invited.length === 2 && a.skipped.length + b.skipped.length === 2);
}

// --- One of the first N whose invite failed isn't overtaken by later sign-ups
{
    const t = setup({ autoInviteLimit: 2 });
    t.mintCode.fail = true;
    await t.signUp(person(1));
    t.mintCode.fail = false;
    await t.signUp(person(2));
    await t.signUp(person(3));
    check("a failed first-N invite keeps the place: the 2nd is invited, the 3rd queued", t.store.signups.get("p2@example.org").status === "invited" && t.store.signups.get("p3@example.org").status === "queued" && !t.store.signups.get("p3@example.org").autoInvite);
    check("...and the 1st is first in the queue", (await t.service.inviteNext({ count: 1, dryRun: true })).wouldInvite[0].email === "p1@example.org");
    await t.signUp(person(3));
    check("the 3rd signing up again isn't invited (not one of the first N)", t.store.signups.get("p3@example.org").status === "queued");
    await t.signUp(person(1));
    check("the 1st signing up again is invited", t.store.signups.get("p1@example.org").status === "invited" && t.sendEmail.sent.at(-1).to === "p1@example.org");
    check("...and the count stays at 2", t.store.counters.get("auto-invites") === 2);
}
{
    const t = setup({ autoInviteLimit: 2 });
    await t.signUp(person(1));
    await t.signUp(person(1));
    await t.signUp(person(1));
    check("signing up again doesn't take another first-N place", t.store.counters.get("auto-invites") === 1);
}

// --- Only a new sign-up takes a first-N place, so someone signing up again can't take one from a new person
{
    const t = setup({ autoInviteLimit: 2 });
    await t.signUp(person(1));
    const takes = [];
    const take = t.store.take;
    t.store.take = async (counter, ...rest) => { takes.push(counter); return take(counter, ...rest); };
    await t.signUp(person(1));
    t.clock.advance(2 * HOUR);
    await t.signUp(person(1));
    check("signing up again never touches the first-N count", !takes.includes("auto-invites"), takes);
}
{
    const t = setup({ autoInviteLimit: 2 });
    t.store.createSignup = async () => { throw new Error("throttled"); };
    let threw = false;
    try { await t.signUp(person(1)); } catch { threw = true; }
    check("if making the row fails, no first-N place is used", threw && !t.store.counters.has("auto-invites"));
}
{
    const t = setup({ autoInviteLimit: 2 });
    t.store.markAutoInvite = async () => { throw new Error("throttled"); };
    let threw = false;
    try { await t.signUp(person(1)); } catch { threw = true; }
    check("if recording the place fails, the place is given back and nothing is sent", threw && t.store.counters.get("auto-invites") === 0 && t.sendEmail.sent.length === 0);
}
{
    const t = setup();
    const saveCode = t.store.saveCode;
    t.store.saveCode = async () => { throw new Error("ConditionalCheckFailed"); };
    await t.signUp(person(1));
    check("if keeping the code fails, the log names that step, and nothing is sent", t.log.lines.some((l) => l.includes("INVITE_FAILED for a sign-up (keeping the code on the row)")) && t.sendEmail.sent.length === 0);
    t.store.saveCode = saveCode;
}

// --- A re-send that doesn't go out doesn't block trying again
{
    const t = setup({ autoInviteLimit: 5, resendDailyCap: 1 });
    await t.signUp(person(1));
    await t.signUp(person(2));
    t.clock.set("2026-12-15T23:00:00.000Z");
    await t.signUp(person(1));                            // uses up today's re-sends (1)
    check("a re-send goes, and counts toward today's re-sends", t.sendEmail.sent.length === 3 && t.store.counters.get("resends#2026-12-15") === 1);
    check("...but not toward the invites' daily cap", t.store.counters.get("emails#2026-12-15") === 2);
    t.clock.set("2026-12-15T23:59:30.000Z");
    await t.signUp(person(2));
    check("a re-send past today's re-send cap sends nothing", t.sendEmail.sent.length === 3);
    check("...and puts the last-emailed time and re-send count back", t.store.signups.get("p2@example.org").lastEmailedAt === "2026-12-15T15:00:00.002Z" && t.store.signups.get("p2@example.org").resends === 0, t.store.signups.get("p2@example.org"));
    check("...and is logged, but doesn't alert the team", t.log.lines.some((l) => l.includes("re-sends are used up")) && !t.log.lines.some((l) => l.includes("DAILY_EMAIL_CAP_REACHED")));
    t.clock.set("2026-12-16T00:00:30.000Z");             // a minute later, a new day
    await t.signUp(person(2));
    check("a minute later, on a new day, the re-send goes", t.sendEmail.sent.length === 4 && t.sendEmail.sent[3].to === "p2@example.org");
    t.sendEmail.fail = true;
    t.clock.set("2026-12-16T02:00:00.000Z");
    t.store.counters.set("resends#2026-12-16", 0);
    await t.signUp(person(1));
    check("a re-send SES refuses: logged, today's re-send given back, last-emailed time and count put back",
        t.log.lines.some((l) => l.includes("INVITE_FAILED re-sending")) && t.store.counters.get("resends#2026-12-16") === 0 && t.store.signups.get("p1@example.org").lastEmailedAt === "2026-12-15T23:00:00.001Z" && t.store.signups.get("p1@example.org").resends === 1);
    t.sendEmail.fail = false;
    t.clock.advance(60_000);
    await t.signUp(person(1));
    check("...a minute later, trying again sends it", t.sendEmail.sent.at(-1).to === "p1@example.org" && t.sendEmail.sent.length === 5);
}

// --- Re-sends can't use up the invites' emails, and one address is re-sent at most maxResends times
{
    const t = setup({ autoInviteLimit: 1, dailyEmailCap: 2, maxResends: 3 });
    await t.signUp(person(1));
    for (let i = 0; i < 6; i++) { t.clock.advance(2 * HOUR); await t.signUp(person(1)); }
    check("one address is re-sent 3 times, then no more", t.sendEmail.sent.length === 4 && t.store.signups.get("p1@example.org").resends === 3);
    await t.signUp(person(2));
    const invited = await t.service.inviteNext({ count: 1 });
    check("...and the invites' daily cap still has room for the next invite", invited.invited.join() === "p2@example.org" && !invited.capReached);
}

// --- The email check: plain ASCII addresses only
{
    const t = setup();
    const bad = ["x<victim@example.org>", "a@b.c>", "\"a b\"@example.org", "a,b@example.org", "a;b@example.org", "(a)b@example.org", "jos\u00e9@example.org", "a@ex\u00e4mple.org", "a@example", "a@example.c",
        ".a@example.org", "a.@example.org", "a..b@example.org", "a@.example.org", "a@example..org", "a@-example.org", "a@example-.org"];
    const answers = [];
    for (const email of bad) answers.push(await t.signUp(person(1, { email })));
    check("addresses with < > \" , ; ( ), non-ASCII, no proper domain, or dots and hyphens where SES refuses them, are refused with 400", answers.every((a) => a.status === 400), bad.filter((_, i) => answers[i].status !== 400));
    check("...and nothing is stored or sent", t.store.signups.size === 0 && t.sendEmail.sent.length === 0);
    const good = ["a.b+tag@example.org", "o'brien@mail.example.co.uk", "A_B-C%d@Example-Mail.ORG", "o&neill@example.org", "user@example.xn--p1ai"];
    for (const email of good) await t.signUp(person(2, { email }));
    check("ordinary addresses, with + . ' _ - % &, and international domains in xn-- form, are accepted (and kept lowercase)", t.store.signups.size === good.length && t.store.signups.has("a_b-c%d@example-mail.org"));
}
{
    const t = setup({ autoInviteLimit: 1 });
    await t.signUp(person(1));
    t.sendEmail.fail = true;
    t.store.giveBack = async () => { throw new Error("throttled"); };
    t.clock.advance(2 * HOUR);
    const answer = await t.signUp(person(1));
    check("a failed re-send is undone even if giving back today's email fails, and the form still gets 202",
        answer.status === 202 && t.store.signups.get("p1@example.org").lastEmailedAt === "2026-12-15T15:00:00.001Z" && t.log.lines.some((l) => l.includes("Couldn't give back")));
}

// --- The same form sent several times at once takes one first-N place
{
    const t = setup({ autoInviteLimit: 3 });
    const answers = await Promise.allSettled([1, 2, 3].map(() => t.service.signUp(person(1), "10.0.0.1")));
    check("the same sign-up sent 3 times at once: one place, one code, one email; the others are asked to try again in a minute",
        answers[0].value?.status === 202 && answers.every((a) => [202, 503].includes(a.value?.status)) && t.store.counters.get("auto-invites") === 1 && t.mintCode.calls.length === 1 && t.sendEmail.sent.length === 1, answers.map((a) => a.value?.status ?? a.reason?.message));
}

// --- A sign-up cut short before its first-N place was decided gets it decided when they try again
{
    const t = setup({ autoInviteLimit: 3 });
    const markAutoInvite = t.store.markAutoInvite;
    t.store.markAutoInvite = async () => { throw new Error("throttled"); };
    let threw = false;
    try { await t.signUp(person(1)); } catch { threw = true; }
    t.store.markAutoInvite = markAutoInvite;
    check("cut short: the request fails, the row is there with no answer, and the place is given back", threw && t.store.signups.get("p1@example.org").autoInvite === undefined && t.store.counters.get("auto-invites") === 0);
    t.clock.advance(10_000);
    const soon = await t.signUp(person(1));
    check("trying again within 30 seconds is asked to try again in a minute (its first request could still be running)", soon.status === 503 && t.store.signups.get("p1@example.org").autoInvite === undefined && t.sendEmail.sent.length === 0);
    const dry = await t.service.inviteNext({ count: 5, dryRun: true });
    check("...and \"invite the next N\" leaves it to that request for now", dry.wouldInvite.length === 0);
    t.clock.advance(30_000);
    await t.signUp(person(1));
    check("trying again after that gives them their first-N place and invites them", t.store.signups.get("p1@example.org").autoInvite === 1 && t.store.signups.get("p1@example.org").status === "invited" && t.store.counters.get("auto-invites") === 1);
}
{
    const t = setup({ autoInviteLimit: 1 });
    await t.signUp(person(1));
    await t.signUp(person(2));
    check("someone after the first N has autoInvite 0 on their row", t.store.signups.get("p2@example.org").autoInvite === 0);
    t.clock.advance(2 * HOUR);
    await t.signUp(person(2));
    check("...and signing up again later doesn't decide it again", t.store.counters.get("auto-invites") === 1 && t.store.signups.get("p2@example.org").status === "queued");
}

// --- An invite that keeps failing is set aside, so it can't sit at the front of the queue
{
    const t = setup({ autoInviteLimit: 0 });
    for (let i = 1; i <= 3; i++) await t.signUp(person(i));
    t.sendEmail.fail = (m) => m.to === "p1@example.org";
    t.sendEmail.errorName = "BadRequestException";   // SES refusing the address
    await t.service.inviteNext({ count: 1 });
    await t.service.inviteNext({ count: 1 });
    check("after 2 failures, it's still queued, first, with 2 failures counted", t.store.signups.get("p1@example.org").status === "queued" && t.store.signups.get("p1@example.org").failures === 2);
    const third = await t.service.inviteNext({ count: 1 });
    check("the 3rd failure sets it aside as \"failed\", and says so in the log", third.failed.join() === "p1@example.org" && t.store.signups.get("p1@example.org").status === "failed" && t.log.lines.some((l) => l.includes("set aside as \"failed\"")));
    check("...and gives back today's emails each time", (t.store.counters.get("emails#2026-12-15") ?? 0) === 0);
    const dry = await t.service.inviteNext({ count: 3, dryRun: true });
    check("the queue no longer lists it", dry.wouldInvite.map((p) => p.email).join() === "p2@example.org,p3@example.org");
    await t.signUp(person(1));
    check("signing up again doesn't try it again", t.store.signups.get("p1@example.org").status === "failed");
    const rest = await t.service.inviteNext({ count: 3 });
    check("the others are invited", rest.invited.join() === "p2@example.org,p3@example.org");
}
{
    const t = setup({ autoInviteLimit: 0, dailyEmailCap: 0 });
    await t.signUp(person(1));
    for (let i = 0; i < 4; i++) await t.service.inviteNext({ count: 1 });
    check("the daily cap stopping an invite doesn't count as a failure", t.store.signups.get("p1@example.org").status === "queued" && t.store.signups.get("p1@example.org").failures === undefined);
}
{
    const t = setup({ autoInviteLimit: 0 });
    await t.signUp(person(1));
    const saveCode = t.store.saveCode;
    t.store.saveCode = async () => { throw new Error("throttled"); };
    for (let i = 0; i < 4; i++) await t.service.inviteNext({ count: 1 });
    t.store.saveCode = saveCode;
    check("a table error doesn't count against the person either", t.store.signups.get("p1@example.org").status === "queued" && t.store.signups.get("p1@example.org").failures === undefined);
}
{
    const t = setup({ autoInviteLimit: 0 });
    for (let i = 1; i <= 5; i++) await t.signUp(person(i));
    t.mintCode.fail = true;
    const answer = await t.service.inviteNext({ count: 5 });
    check("3 failures in a row stop the run (lcw-back-end or SES is probably down), and it says so",
        answer.failed.length === 3 && answer.stoppedOnFailures === true && t.mintCode.calls.length === 3 && t.log.lines.some((l) => l.includes("3 invites failed in a row")));
    check("...and the rest aren't tried, so nothing is counted against them", [4, 5].every((i) => t.store.signups.get(`p${i}@example.org`).status === "queued" && t.store.signups.get(`p${i}@example.org`).failures === undefined));
    const three = await (async () => { const u = setup({ autoInviteLimit: 0 }); for (let i = 1; i <= 3; i++) await u.signUp(person(i)); u.mintCode.fail = true; return u.service.inviteNext({ count: 3 }); })();
    check("failing the last one isn't called stopping", three.failed.length === 3 && three.stoppedOnFailures === false);
}

{
    // An outage: none of these are the person's doing, so nobody is set aside
    const t = setup({ autoInviteLimit: 0 });
    await t.signUp(person(1));
    t.mintCode.fail = true;
    for (const status of [500, 503, 400, 422, 401, 403, 404, 409, 429, 408]) { t.mintCode.status = status; await t.service.inviteNext({ count: 1 }); }
    t.mintCode.fail = false;
    t.sendEmail.fail = true;
    for (const name of ["MessageRejected", "SendingPausedException", "TooManyRequestsException", "TimeoutError"]) { t.sendEmail.errorName = name; await t.service.inviteNext({ count: 1 }); }
    const row = t.store.signups.get("p1@example.org");
    check("no error from lcw-back-end (it answers 400 only to a broken request), and no outage, throttling or timeout, sets anyone aside", row.status === "queued" && row.failures === undefined, row);
}
{
    const t = setup({ autoInviteLimit: 1 });
    t.sendEmail.fail = true;
    t.sendEmail.errorName = "TimeoutError";
    await t.signUp(person(1));
    check("a send that timed out (SES may have sent it): back in the queue, but today's email stays counted", t.store.signups.get("p1@example.org").status === "queued" && t.store.counters.get("emails#2026-12-15") === 1 && t.log.lines.some((l) => l.includes("may have gone")));
    t.sendEmail.errorName = "MessageRejected";
    await t.service.inviteNext({ count: 1 });
    check("...while a send SES refused gives it back", t.store.counters.get("emails#2026-12-15") === 1);
}
{
    const t = setup({ autoInviteLimit: 2 });
    let left = 22_000;
    await t.service.signUp(person(1), "10.0.0.1", () => left);
    check("with under 23 seconds left, no code is made: back in the queue, no email counted, not counted against them, and the team is alerted to invite them",
        t.mintCode.calls.length === 0 && t.store.signups.get("p1@example.org").status === "queued" && t.store.signups.get("p1@example.org").failures === undefined && (t.store.counters.get("emails#2026-12-15") ?? 0) === 0 &&
        t.log.lines.some((l) => l.startsWith("error INVITE_FAILED") && l.includes("enough time left")));
    left = 24_000;
    await t.service.signUp(person(1), "10.0.0.1", () => left);
    check("...with enough, the first-N person signing up again is invited", t.store.signups.get("p1@example.org").status === "invited");
}

{
    const t = setup({ autoInviteLimit: 0 });
    for (let i = 1; i <= 5; i++) await t.signUp(person(i));
    t.sendEmail.fail = (m) => ["p1@example.org", "p2@example.org", "p3@example.org"].includes(m.to);
    t.sendEmail.errorName = "BadRequestException";
    const answer = await t.service.inviteNext({ count: 5 });
    check("3 refused addresses in a row stop the run too (SES refusing everyone means it's set up wrong)", answer.stoppedOnFailures === true && answer.failed.length === 3 && answer.invited.length === 0 && t.log.lines.some((l) => l.includes("set up wrong")));
    for (let i = 0; i < 2; i++) await t.service.inviteNext({ count: 5 });
    const after = await t.service.inviteNext({ count: 5 });
    check("...and once those are set aside, the run goes on to the others", after.invited.join() === "p4@example.org,p5@example.org");
}
{
    const t = setup({ autoInviteLimit: 1 });
    await t.signUp(person(1));
    t.clock.advance(2 * HOUR);
    t.sendEmail.fail = true;
    t.sendEmail.errorName = "TimeoutError";
    await t.signUp(person(1));
    const row = t.store.signups.get("p1@example.org");
    check("a re-send that timed out (SES may have sent it) stays counted, for the address and the day", row.resends === 1 && row.lastEmailedAt === t.clock().toISOString() && t.store.counters.get("resends#2026-12-15") === 1);
}
{
    // Two requests deciding the same place at once (possible only after an earlier error cut one short)
    const t = setup({ autoInviteLimit: 3 });
    const markAutoInvite = t.store.markAutoInvite;
    t.store.markAutoInvite = async () => { throw new Error("throttled"); };
    try { await t.signUp(person(1)); } catch { /* the first request fails */ }
    t.store.markAutoInvite = markAutoInvite;
    t.clock.advance(60_000);
    const answers = await Promise.allSettled([t.service.signUp(person(1), "10.0.0.1"), t.service.signUp(person(1), "10.0.0.1")]);
    check("two requests deciding one place at once: both 202, one place taken, one invite", answers.every((a) => a.value?.status === 202) && t.store.counters.get("auto-invites") === 1 && t.sendEmail.sent.length === 1, answers.map((a) => a.value?.status ?? a.reason?.message));
}

{
    // Recording the place lands but its answer is lost, and the check that follows fails too: the place is
    // kept, since giving it back could put two people in one place
    const t = setup({ autoInviteLimit: 3 });
    const markAutoInvite = t.store.markAutoInvite, getSignup = t.store.getSignup;
    t.store.markAutoInvite = async (...args) => { await markAutoInvite(...args); throw new Error("timed out"); };
    t.store.getSignup = async () => { throw new Error("throttled"); };
    try { await t.signUp(person(1)); } catch { /* 500 */ }
    t.store.markAutoInvite = markAutoInvite;
    t.store.getSignup = getSignup;
    check("a place whose recording can't be checked is kept, not given back", t.store.counters.get("auto-invites") === 1 && t.store.signups.get("p1@example.org").autoInvite === 1);
}

{
    // On the sign-up path there's no "3 in a row" stop, so a refusal there isn't counted (a setup
    // mistake could otherwise set aside everyone who signs up)
    const t = setup({ autoInviteLimit: 3 });
    t.sendEmail.fail = true;
    t.sendEmail.errorName = "BadRequestException";
    await t.signUp(person(1));
    for (let i = 0; i < 4; i++) { t.clock.advance(HOUR); await t.signUp(person(1)); }
    const row = t.store.signups.get("p1@example.org");
    check("SES refusing a first-N address when they sign up (and again) doesn't count against them", row.status === "queued" && row.failures === undefined && row.autoInvite === 1);
}

{
    // A sign-up cut short before its place was decided, invited by "invite the next N" while it signs up again
    const t = setup({ autoInviteLimit: 3 });
    const markAutoInvite = t.store.markAutoInvite;
    t.store.markAutoInvite = async () => { throw new Error("throttled"); };
    try { await t.signUp(person(1)); } catch { /* the first request fails */ }
    t.store.markAutoInvite = markAutoInvite;
    t.clock.advance(60_000);
    const take = t.store.take;
    t.store.take = async (counter, ...rest) => {
        // "invite the next N" takes the row just as this request takes a place
        if (counter === "auto-invites") await t.service.inviteNext({ count: 1 });
        return take(counter, ...rest);
    };
    const answer = await t.service.signUp(person(1), "10.0.0.1").catch((error) => ({ threw: error.message }));
    t.store.take = take;
    check("a place isn't spent on someone \"invite the next N\" is already inviting: given back, and the usual 202",
        answer.status === 202 && t.store.counters.get("auto-invites") === 0 && t.store.signups.get("p1@example.org").status === "invited" && t.sendEmail.sent.length === 1);
}
{
    const t = setup({ autoInviteLimit: 0 });
    await t.signUp(person(1));
    t.mintCode.fail = true;
    t.store.release = async () => { throw new Error("timed out"); };
    await t.service.inviteNext({ count: 1 });
    check("today's email is given back even if putting the sign-up back failed", (t.store.counters.get("emails#2026-12-15") ?? 0) === 0);
}

// --- No email addresses in the logs
{
    const t = setup({ autoInviteLimit: 1 });
    t.sendEmail.fail = true;   // its error names the address, as SES's can
    await t.signUp(person(1));
    check("an SES error naming the address is logged without it", t.log.lines.some((l) => l.includes("INVITE_FAILED") && l.includes("MessageRejected") && l.includes("[an address]")) && !t.log.lines.some((l) => l.includes("p1@example.org")));
    const error = new Error("Email address is not verified: Ann.O'Brien+x@mail.example.co.uk, b@c.org");
    check("describeError takes every address out", describeError(error) === "Error: Email address is not verified: [an address], [an address]");
    const withPath = new Error("x");
    withPath.stack = "Error: x\n    at send (/var/task/node_modules/@aws-sdk/client-sesv2/dist-cjs/index.js:1:2)";
    check("...including from the stack, but keeps file paths with @ in them", !describeError(error, { stack: true }).includes("example") && describeError(withPath, { stack: true }) === withPath.stack);
}

// --- An invite taken over after it went stale can't be undone or finished by the slow one
{
    const t = setup({ autoInviteLimit: 0 });
    await t.signUp(person(1));
    const first = "2026-12-15T15:00:00.000Z", second = "2026-12-15T15:16:00.000Z";
    await t.store.claim("p1@example.org", first, "");
    await t.store.claim("p1@example.org", second, "2026-12-15T15:01:00.000Z");   // stale, so taken over
    await t.store.release("p1@example.org", first);
    check("the slow one's release does nothing", t.store.signups.get("p1@example.org").status === "inviting" && t.store.signups.get("p1@example.org").claimedAt === second);
    let refused = 0;
    try { await t.store.saveCode("p1@example.org", { code: "X", link: "L" }, first); } catch { refused++; }
    try { await t.store.markInvited("p1@example.org", first, first); } catch { refused++; }
    check("...and its saveCode and markInvited are refused", refused === 2 && !t.store.signups.get("p1@example.org").code);
}

// --- The per-network limit counts an IPv6 /64 as one network
{
    const t = setup({ ipHourlyLimit: 2 });
    const a = await t.signUp(person(1), "2001:db8:1:2::1");
    const b = await t.signUp(person(2), "2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const c = await t.signUp(person(3), "2001:0db8:0001:0002::ffff");
    const d = await t.signUp(person(4), "2001:db8:1:3::1");
    check("two addresses in one /64 use up its limit; a third is refused", a.status === 202 && b.status === 202 && c.status === 429);
    check("another /64 is counted on its own", d.status === 202);
    const e = await t.signUp(person(5), "::ffff:203.0.113.9");
    const f = await t.signUp(person(6), "203.0.113.9");
    const g = await t.signUp(person(7), "203.0.113.9");
    check("an IPv4 address written as IPv6 counts as that IPv4 address", e.status === 202 && f.status === 202 && g.status === 429);
}

// --- The email
{
    const t = setup();
    await t.signUp({ name: "Your account is suspended. Verify at evil.example", organization: "evil.example", email: "victim@example.org" });
    const sent = t.sendEmail.sent[0];
    check("nothing typed into the form goes into the email", !/evil|suspended/.test(sent.subject + sent.text + sent.html));
    const message = inviteEmail({ code: "LCW-ABC", link: "https://wallet.example.org/#/register?code=LCW-ABC", expiresAt: "2027-03-01T00:00:00.000Z" });
    check("the subject", message.subject === "Your invite to the Learner Credential Wallet alpha");
    check("the text has the link, code and the date it works until", message.text.includes("https://wallet.example.org/#/register?code=LCW-ABC") && message.text.includes("LCW-ABC") && message.text.includes("March 1, 2027"));
    check("the HTML links the button to the link", message.html.includes("href='https://wallet.example.org/#/register?code=LCW-ABC'"));
    const noDate = inviteEmail({ code: "C", link: "L", expiresAt: undefined });
    check("with no expiry date, the sentence about it is left out", !noDate.text.includes("works until"));
}

done();
