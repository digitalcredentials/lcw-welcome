// What happens when a table call fails partway through a sign-up, a re-send or
// "invite the next N". Each scenario is run once for every table call it
// makes, with that one call failing: either before it happens, or after it
// happened but with its answer lost (a timeout, say). Then the person or the
// admin tries again, as the page or the runbook tells them to, and the end
// state is checked: nobody left half-done, everyone where they should be.
// (Two requests at once are tested in service-test.mjs and dynamodb-test.mjs.)
//   cd signup/src && npm test
import { makeService } from "../service.mjs";
import { memoryStore, fakeMinter, fakeMailer, quietLog, manualClock, checker } from "./helpers.mjs";

const { check, done } = checker();
const MINUTE = 60_000, HOUR = 60 * MINUTE;
const person = (i) => ({ name: `Person ${i}`, email: `p${i}@example.org` });

// The store, with call number `at` failing (mode "before" or "after") until off() is called
function faulty(store, at, mode) {
    let n = 0;
    const wrapped = { signups: store.signups, counters: store.counters, calls: [] };
    for (const [name, fn] of Object.entries(store)) {
        if (typeof fn !== "function") continue;
        wrapped[name] = async (...args) => {
            const failNow = ++n === at;
            if (failNow) wrapped.failed = name;
            wrapped.calls.push(name);
            if (failNow && mode === "before") throw new Error(`injected: ${name} failed`);
            const result = await fn(...args);
            if (failNow && mode === "after") throw new Error(`injected: ${name}'s answer was lost`);
            return result;
        };
    }
    wrapped.off = () => { at = -1; };
    wrapped.made = () => n;
    return wrapped;
}

const scenarios = [
    {
        name: "a new sign-up among the first N",
        config: { autoInviteLimit: 3 },
        act: (t) => t.service.signUp(person(1), "10.0.0.1"),
        // The page says "try again"; they do, a little later
        recover: async (t) => { t.clock.advance(16 * MINUTE); await t.service.signUp(person(1), "10.0.0.1"); },
        expect: { "p1@example.org": { status: "invited", autoInvite: 1 } }
    },
    {
        name: "a new sign-up once the first N are taken",
        config: { autoInviteLimit: 1 },
        prepare: (t) => t.service.signUp(person(0), "10.0.0.9"),
        act: (t) => t.service.signUp(person(1), "10.0.0.1"),
        recover: async (t) => { t.clock.advance(16 * MINUTE); await t.service.signUp(person(1), "10.0.0.1"); },
        expect: { "p0@example.org": { status: "invited", autoInvite: 1 }, "p1@example.org": { status: "queued", autoInvite: 0 } }
    },
    {
        name: "a re-send",
        config: { autoInviteLimit: 1 },
        prepare: async (t) => { await t.service.signUp(person(1), "10.0.0.1"); t.clock.advance(2 * HOUR); },
        act: (t) => t.service.signUp(person(1), "10.0.0.1"),
        recover: async (t) => { t.clock.advance(2 * HOUR); await t.service.signUp(person(1), "10.0.0.1"); },
        expect: { "p1@example.org": { status: "invited", autoInvite: 1 } },
        resends: true
    },
    {
        name: "\"invite the next 3\"",
        config: { autoInviteLimit: 0 },
        prepare: async (t) => { for (let i = 1; i <= 3; i++) await t.service.signUp(person(i), `10.0.0.${i}`); },
        act: (t) => t.service.inviteNext({ count: 3 }),
        // The admin runs it again; anyone stuck is picked up once 15 minutes have passed
        recover: async (t) => { t.clock.advance(16 * MINUTE); await t.service.inviteNext({ count: 3 }); },
        expect: Object.fromEntries([1, 2, 3].map((i) => [`p${i}@example.org`, { status: "invited", autoInvite: 0 }])),
        // Only reading the queue may make the whole run fail; after that, it reports who failed instead
        mayThrow: (failed) => failed === "listQueued"
    }
];

// What must hold after recovering, whatever failed; answers the problems found
function problems(t, scenario, emailsBefore, threw) {
    const found = [];
    const rows = [...t.store.signups.values()];
    for (const [email, want] of Object.entries(scenario.expect)) {
        const row = t.store.signups.get(email);
        if (row?.status !== want.status || row?.autoInvite !== want.autoInvite) found.push(`${email} ended ${row?.status} with autoInvite ${row?.autoInvite}`);
    }
    if (rows.some((r) => r.status === "inviting" || r.status === "failed")) found.push("a row was left inviting or failed");
    for (const row of rows.filter((r) => r.status === "invited")) {
        const last = t.sendEmail.sent.filter((m) => m.to === row.email).at(-1);
        if (!last?.text.includes(row.code)) found.push(`${row.email}'s last email doesn't carry the code on its row`);
    }
    const placed = rows.filter((r) => r.autoInvite === 1).length;
    if ((t.store.counters.get("auto-invites") ?? 0) < placed) found.push("more people hold a first-N place than the count says");
    const day = "2026-12-15";
    // In the re-send scenario, every email after the first invite is a re-send
    const resends = scenario.resends ? t.sendEmail.sent.length - emailsBefore : 0;
    if ((t.store.counters.get(`emails#${day}`) ?? 0) < t.sendEmail.sent.length - resends) found.push("more invite emails went than today's count says");
    if (scenario.resends) {
        const row = t.store.signups.get("p1@example.org");
        if ((row.resends ?? 0) !== resends) found.push(`resends on the row is ${row.resends ?? 0}, but ${resends} re-sends went`);
        if (resends < 1) found.push("no re-send went, even after trying again");
        if ((t.store.counters.get(`resends#${day}`) ?? 0) < resends) found.push("more re-sends went than today's re-send count says");
    }
    if (threw && !(scenario.mayThrow?.(t.store.failed) ?? true)) found.push(`it threw (${threw}) instead of carrying on`);
    return found;
}

for (const scenario of scenarios) {
    for (const mode of ["before", "after"]) {
        const failures = [];
        let cases = 0;
        for (let at = 1; ; at++) {
            const base = memoryStore(), mintCode = fakeMinter(), sendEmail = fakeMailer(), log = quietLog(), clock = manualClock();
            const config = { dailyEmailCap: 100, ipHourlyLimit: 100, resendGapMinutes: 60, resendDailyCap: 100, maxResends: 100, maxFailures: 3, maxBatch: 100, ...scenario.config };
            const make = (store) => ({ store, mintCode, sendEmail, log, clock, service: makeService({ store, mintCode, sendEmail, config, log, clock }) });
            // Set up with nothing failing, then fail call number `at` of what's being tested
            if (scenario.prepare) await scenario.prepare(make(base));
            const store = faulty(base, at, mode);
            const t = make(store);
            const emailsBefore = sendEmail.sent.length;
            let threw = null;
            try { await scenario.act(t); } catch (error) { threw = error.message; }
            if (store.made() < at) break;   // fewer calls than `at`: every call has had its turn
            cases++;
            store.off();
            // Straight after the error, nobody is left "inviting" (and so stuck for 15 minutes), except
            // where that can't be helped: the claim was made but its answer lost, the invite went but
            // recording it failed, or putting the row back failed
            const leftInviting = [...base.signups.values()].some((r) => r.status === "inviting");
            const cantHelp = (mode === "after" && store.failed === "claim") || ["markInvited", "release"].includes(store.failed);
            if (leftInviting && !cantHelp) failures.push(`${store.failed} (call ${at}): a row was left "inviting" straight after the error`);
            await scenario.recover(t);
            const found = problems(t, scenario, emailsBefore, threw);
            if (found.length) failures.push(`${store.failed} (call ${at}): ${found.join("; ")}`);
        }
        check(`${scenario.name}: any one table call failing ${mode === "before" ? "before it's made" : "with its answer lost"} is recovered from (${cases} cases)`, failures.length === 0, failures);
    }
}

done();
