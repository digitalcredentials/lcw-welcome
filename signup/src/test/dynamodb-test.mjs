// The real store (store.mjs) and service against DynamoDB Local, so the
// conditions on each write are checked by DynamoDB itself, including when
// many requests arrive at once.
//
//   docker run --rm -d -p 8000:8000 --name lcw-welcome-ddb amazon/dynamodb-local
//   cd signup/src && DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:dynamodb
//
// The tables are made here with the same keys and index as template.yaml.
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamoStore } from "../store.mjs";
import { makeService } from "../service.mjs";
import { fakeMinter, fakeMailer, quietLog, manualClock, checker } from "./helpers.mjs";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
const { check, done } = checker();

async function freshTables(suffix) {
    const signupsTable = `signups-${suffix}`, countersTable = `counters-${suffix}`;
    for (const name of [signupsTable, countersTable]) {
        try { await client.send(new DeleteTableCommand({ TableName: name })); } catch { /* not there */ }
    }
    await client.send(new CreateTableCommand({
        TableName: signupsTable,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "email", AttributeType: "S" }, { AttributeName: "status", AttributeType: "S" }, { AttributeName: "signedUpAt", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
        GlobalSecondaryIndexes: [{ IndexName: "status-index", KeySchema: [{ AttributeName: "status", KeyType: "HASH" }, { AttributeName: "signedUpAt", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }]
    }));
    await client.send(new CreateTableCommand({
        TableName: countersTable,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "key", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "key", KeyType: "HASH" }]
    }));
    return { signupsTable, countersTable };
}

async function setup(suffix, overrides = {}) {
    const tables = await freshTables(suffix);
    const store = dynamoStore({ client, ...tables });
    const mintCode = fakeMinter(), sendEmail = fakeMailer(), log = quietLog(), clock = manualClock();
    const config = { autoInviteLimit: 10, dailyEmailCap: 1000, ipHourlyLimit: 1000, resendGapMinutes: 60, resendDailyCap: 1000, maxResends: 100, maxBatch: 100, ...overrides };
    // A small delay in minting, so requests that arrive together really overlap
    const slowMint = async (email) => { await new Promise((r) => setTimeout(r, 5)); return mintCode(email); };
    slowMint.calls = mintCode.calls;
    const service = makeService({ store, mintCode: slowMint, sendEmail, config, log, clock });
    return { ...tables, store, mintCode, sendEmail, log, clock, service };
}
const person = (i) => ({ name: `Person ${i}`, email: `p${i}@example.org` });
const statuses = async (store, n) => Promise.all(Array.from({ length: n }, (_, i) => store.getSignup(`p${i + 1}@example.org`).then((r) => r?.status)));

// --- 30 people sign up at once: exactly the first-N limit are invited
{
    const t = await setup("burst");
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => t.service.signUp(person(i + 1), `10.0.0.${i}`)));
    const all = await statuses(t.store, 30);
    check("30 sign-ups at once all get 202", answers.every((a) => a.status === 202));
    check("exactly 10 are invited and 20 queued", all.filter((s) => s === "invited").length === 10 && all.filter((s) => s === "queued").length === 20, all);
    check("10 emails, to 10 different people", t.sendEmail.sent.length === 10 && new Set(t.sendEmail.sent.map((m) => m.to)).size === 10);
    check("the auto-invite count is exactly 10", (await t.store.count("auto-invites")) === 10);
    check("today's email count is exactly 10", (await t.store.count("emails#2026-12-15")) === 10);

    // Two admins press "invite the next 15" at once. Nobody is invited twice, whatever the order.
    // (Usually both see the same 15 and split them; if one finishes before the other reads the
    // queue, the other rightly invites the 5 left.)
    const [a, b] = await Promise.all([t.service.inviteNext({ count: 15 }), t.service.inviteNext({ count: 15 })]);
    const after = await statuses(t.store, 30);
    const both = a.invited.concat(b.invited), to = t.sendEmail.sent.map((m) => m.to);
    check("two runs at once: nobody invited or emailed twice", new Set(both).size === both.length && new Set(to).size === to.length && to.length === 10 + both.length, { a, b });
    check("...at least the 15 they both saw are invited, and the table agrees", both.length >= 15 && after.filter((s) => s === "invited").length === 10 + both.length && after.filter((s) => s === "queued").length === 20 - both.length);
}

// --- One person presses Send ten times at once
{
    const t = await setup("double");
    await Promise.all(Array.from({ length: 10 }, () => t.service.signUp(person(1), "10.0.0.1")));
    check("ten sign-ups at once with one email: one invite, one code", t.sendEmail.sent.length === 1 && t.mintCode.calls.length === 1);
    check("...and one first-N place taken", (await t.store.count("auto-invites")) === 1);
    check("...and one row, invited", (await t.store.getSignup("p1@example.org")).status === "invited");
    t.clock.advance(2 * 3_600_000);
    await Promise.all(Array.from({ length: 5 }, () => t.service.signUp(person(1), "10.0.0.1")));
    check("signing up again five times at once, later, re-sends the code once", t.sendEmail.sent.length === 2 && t.mintCode.calls.length === 1 && t.sendEmail.sent[1].text.includes((await t.store.getSignup("p1@example.org")).code));
}

// --- The limit per IP address, with requests at once
{
    const t = await setup("ip", { ipHourlyLimit: 10 });
    const answers = await Promise.all(Array.from({ length: 15 }, (_, i) => t.service.signUp(person(i + 1), "203.0.113.9")));
    check("15 at once from one address: exactly 10 accepted, 5 refused", answers.filter((a) => a.status === 202).length === 10 && answers.filter((a) => a.status === 429).length === 5);
    const ipRow = (await client.send(new GetItemCommand({ TableName: t.countersTable, Key: { key: { S: `ip#${(await import("node:crypto")).createHash("sha256").update("203.0.113.9").digest("hex").slice(0, 32)}#2026-12-15T15` } } }))).Item;
    check("the IP counter is removed later (removeAt about two hours ahead)", ipRow && Number(ipRow.removeAt.N) - Date.parse("2026-12-15T15:00:00Z") / 1000 >= 7000, ipRow);
}

// --- The daily cap, with requests at once
{
    const t = await setup("cap", { dailyEmailCap: 5, autoInviteLimit: 100 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => t.service.signUp(person(i + 1), `10.0.1.${i}`)));
    const all = await statuses(t.store, 12);
    check("12 at once with a cap of 5: exactly 5 emails", t.sendEmail.sent.length === 5 && all.filter((s) => s === "invited").length === 5);
    check("...the other 7 are queued and keep their first-N places", all.filter((s) => s === "queued").length === 7 && (await t.store.count("auto-invites")) === 12 && (await t.store.getSignup("p12@example.org")).autoInvite === 1);
    check("...and the alert line is logged", t.log.lines.some((l) => l.startsWith("error DAILY_EMAIL_CAP_REACHED")));
}

// --- The queue's order, and failures put people back in it
{
    const t = await setup("order", { autoInviteLimit: 0 });
    for (let i = 1; i <= 4; i++) { t.clock.advance(1000); await t.service.signUp(person(i), `10.0.2.${i}`); }
    const dry = await t.service.inviteNext({ count: 3, dryRun: true });
    check("the queue lists in sign-up order", dry.wouldInvite.map((p) => p.email).join() === "p1@example.org,p2@example.org,p3@example.org");
    t.mintCode.fail = true;
    const failed = await t.service.inviteNext({ count: 1 });
    t.mintCode.fail = false;
    check("an invite that fails puts the person back at the front", failed.failed.join() === "p1@example.org" && (await t.service.inviteNext({ count: 1, dryRun: true })).wouldInvite[0].email === "p1@example.org");
    check("...and gives back today's email", (await t.store.count("emails#2026-12-15")) === 0);
    await t.store.giveBack("emails#2026-12-15");
    check("giving back never goes below zero", (await t.store.count("emails#2026-12-15")) === 0);
    const row = await t.store.getSignup("p1@example.org");
    check("the row keeps its sign-up details", row.name === "Person 1" && row.status === "queued" && !row.code);
}

// --- A sign-up stuck halfway is picked up again, once, with its code kept
{
    const t = await setup("stuck", { autoInviteLimit: 0 });
    for (let i = 1; i <= 3; i++) { t.clock.advance(1000); await t.service.signUp(person(i), `10.0.3.${i}`); }
    const at = t.clock().toISOString();
    const claimed = await t.store.claim("p1@example.org", at, "");
    await t.store.saveCode("p1@example.org", { code: "LCW-KEPT", link: "https://w.example/#/register?code=LCW-KEPT", expiresAt: "2027-03-01T00:00:00.000Z" }, at);
    check("a claim moves a queued sign-up to \"inviting\"", claimed?.status === "inviting" && claimed.claimedAt === at);
    check("a second claim right away is refused", (await t.store.claim("p1@example.org", at, new Date(Date.parse(at) - 15 * 60_000).toISOString())) === null);
    const soon = await t.service.inviteNext({ count: 3, dryRun: true });
    check("right away, the queue leaves it out", soon.wouldInvite.map((p) => p.email).join() === "p2@example.org,p3@example.org");
    t.clock.advance(16 * 60_000);
    const later = await t.service.inviteNext({ count: 3, dryRun: true });
    check("15 minutes later, the queue lists it first, in its place", later.wouldInvite.map((p) => p.email).join() === "p1@example.org,p2@example.org,p3@example.org");
    const [a, b] = await Promise.all([t.service.inviteNext({ count: 1 }), t.service.inviteNext({ count: 1 })]);
    // Whichever order the two runs happen in, the stuck one is finished once, with its code.
    // (If one run finishes before the other reads the queue, the other rightly invites the next person.)
    const toP1 = t.sendEmail.sent.filter((m) => m.to === "p1@example.org");
    const to = t.sendEmail.sent.map((m) => m.to);
    check("two runs at once finish it once, with the code it already had",
        toP1.length === 1 && toP1[0].text.includes("LCW-KEPT") && !t.mintCode.calls.includes("p1@example.org") &&
        new Set(to).size === to.length && a.invited.length + b.invited.length === to.length && a.invited.concat(b.invited).includes("p1@example.org"),
        { to, minted: t.mintCode.calls, a, b });
    const row = await t.store.getSignup("p1@example.org");
    check("...and it ends invited, with no claim left", row.status === "invited" && row.code === "LCW-KEPT" && row.claimedAt === undefined);
}

// --- An invite taken over once stale: the slow one can't undo or finish it
{
    const t = await setup("owner", { autoInviteLimit: 0 });
    await t.service.signUp(person(1), "10.0.4.1");
    const first = "2026-12-15T15:00:00.000Z", second = "2026-12-15T15:16:00.000Z";
    await t.store.claim("p1@example.org", first, "");
    check("a stale claim is taken over", (await t.store.claim("p1@example.org", second, "2026-12-15T15:01:00.000Z"))?.claimedAt === second);
    await t.store.release("p1@example.org", first);
    let row = await t.store.getSignup("p1@example.org");
    check("the slow one's release does nothing", row.status === "inviting" && row.claimedAt === second);
    let refused = 0;
    try { await t.store.saveCode("p1@example.org", { code: "X", link: "L" }, first); } catch (e) { if (e.name === "ConditionalCheckFailedException") refused++; }
    try { await t.store.markInvited("p1@example.org", first, first); } catch (e) { if (e.name === "ConditionalCheckFailedException") refused++; }
    check("...its saveCode and markInvited are refused", refused === 2);
    await t.store.saveCode("p1@example.org", { code: "Y", link: "L" }, second);
    await t.store.markInvited("p1@example.org", second, second);
    row = await t.store.getSignup("p1@example.org");
    check("...and the one that took over finishes it", row.status === "invited" && row.code === "Y" && row.claimedAt === undefined);
    await t.store.release("p1@example.org", second);
    check("releasing an invited row does nothing", (await t.store.getSignup("p1@example.org")).status === "invited");
}

// --- Recording a first-N place needs the row to be there
{
    const t = await setup("mark", { autoInviteLimit: 0 });
    await t.service.signUp(person(1), "10.0.6.1");
    await t.store.markAutoInvite("p1@example.org");
    check("markAutoInvite records the place", (await t.store.getSignup("p1@example.org")).autoInvite === 1);
    let refused = false;
    try { await t.store.markAutoInvite("nobody@example.org"); } catch (e) { refused = e.name === "ConditionalCheckFailedException"; }
    check("...and is refused for an address that hasn't signed up (no row made)", refused && (await t.store.getSignup("nobody@example.org")) === null);
}

// --- Undoing a re-send's time
{
    const t = await setup("unmark", { autoInviteLimit: 1 });
    await t.service.signUp(person(1), "10.0.5.1");
    const invitedAt = (await t.store.getSignup("p1@example.org")).lastEmailedAt;
    const later = "2026-12-15T18:00:00.000Z";
    check("markEmailed after the gap moves the time on, and counts the re-send", await t.store.markEmailed("p1@example.org", later, "2026-12-15T17:00:00.000Z", 3) && (await t.store.getSignup("p1@example.org")).resends === 1);
    await t.store.unmarkEmailed("p1@example.org", "2026-12-15T19:00:00.000Z", invitedAt);
    check("unmarkEmailed with a different time does nothing", (await t.store.getSignup("p1@example.org")).lastEmailedAt === later);
    await t.store.unmarkEmailed("p1@example.org", later, invitedAt);
    check("unmarkEmailed with its own time puts the old one back, and uncounts the re-send", (await t.store.getSignup("p1@example.org")).lastEmailedAt === invitedAt && (await t.store.getSignup("p1@example.org")).resends === 0);
    await t.store.markEmailed("p1@example.org", later, "2026-12-15T17:00:00.000Z", 3);
    await t.store.unmarkEmailed("p1@example.org", later, undefined);
    check("with no old time, it removes it", (await t.store.getSignup("p1@example.org")).lastEmailedAt === undefined);

    // At most maxResends re-sends, even with many requests at once
    const times = ["2026-12-16T01:00:00.000Z", "2026-12-16T03:00:00.000Z", "2026-12-16T05:00:00.000Z"];
    for (const at of times) await t.store.markEmailed("p1@example.org", at, new Date(Date.parse(at) - 3_600_000).toISOString(), 3);
    check("three re-sends make 3", (await t.store.getSignup("p1@example.org")).resends === 3);
    check("a 4th is refused when maxResends is 3", !(await t.store.markEmailed("p1@example.org", "2026-12-16T09:00:00.000Z", "2026-12-16T08:00:00.000Z", 3)));
    await t.service.signUp(person(2), "10.0.5.2");
    await t.service.inviteNext({ count: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        t.store.markEmailed("p2@example.org", `2026-12-17T0${i}:00:00.000Z`, "2026-12-17T10:00:00.000Z", 2)));
    check("10 re-sends at once with maxResends 2: exactly 2 go", results.filter(Boolean).length === 2 && (await t.store.getSignup("p2@example.org")).resends === 2, results);
}

for (const suffix of ["burst", "double", "ip", "cap", "order", "stuck", "owner", "unmark", "mark"]) {
    for (const name of [`signups-${suffix}`, `counters-${suffix}`]) await client.send(new DeleteTableCommand({ TableName: name }));
}
done();
