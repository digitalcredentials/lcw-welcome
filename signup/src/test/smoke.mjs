// A smoke test you can click through: the welcome page and the real sign-up
// service (the same signup.mjs and invite.mjs Lambda handlers that deploy),
// running on this computer, with nothing sent anywhere.
//
//   cd signup/src && npm install && npm run smoke     (needs Docker running)
//
// Then open http://localhost:4600 (the page) and http://localhost:4600/_smoke
// (the control panel: the queue, the emails "sent", the log, and buttons for
// "invite the next N" and for making things fail). Ctrl+C stops everything.
//
// What's real: the handlers, the rules, the table writes (on DynamoDB Local,
// in Docker), and the HTTP calls the service makes. What's stood in for, on
// http://127.0.0.1:4601: Parameter Store (it answers a made-up API key, not
// the real one), lcw-back-end's POST /registration-codes (it checks that key
// and answers a made-up code), and SES (it keeps each email for the control
// panel instead of sending it). The AWS credentials are made up too, so
// nothing here can reach real AWS.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, ListTablesCommand, ScanCommand } from "@aws-sdk/client-dynamodb";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PAGE_PORT = 4600, FAKES_PORT = 4601, API_PORT = 4602, DDB_PORT = 8765;
const PAGE = `http://localhost:${PAGE_PORT}`, FAKES = `http://127.0.0.1:${FAKES_PORT}`, API = `http://localhost:${API_PORT}/signup`;
const CONTAINER = "lcw-welcome-smoke";
const FAKE_KEY = "smoke-test-key-not-a-real-one";

// Small numbers, so each rule shows up within a few sign-ups. Each can be changed: AUTO_INVITE_LIMIT=5 npm run smoke
const settings = {
    AUTO_INVITE_LIMIT: process.env.AUTO_INVITE_LIMIT ?? "2",
    DAILY_EMAIL_CAP: process.env.DAILY_EMAIL_CAP ?? "6",
    IP_HOURLY_LIMIT: process.env.IP_HOURLY_LIMIT ?? "8",
    RESEND_GAP_MINUTES: process.env.RESEND_GAP_MINUTES ?? "1",
    RESEND_DAILY_CAP: process.env.RESEND_DAILY_CAP ?? "4",
    MAX_RESENDS: process.env.MAX_RESENDS ?? "2"
};

// --- Everything the handlers read, pointed at this computer. Set before they're imported.
for (const name of Object.keys(process.env)) if (name.startsWith("AWS_")) delete process.env[name];
Object.assign(process.env, settings, {
    AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "smoke", AWS_SECRET_ACCESS_KEY: "smoke",
    AWS_ENDPOINT_URL_SSM: FAKES, AWS_ENDPOINT_URL_SESV2: FAKES,
    DYNAMODB_ENDPOINT: `http://localhost:${DDB_PORT}`,
    SIGNUPS_TABLE_NAME: "lcw-welcome-signups", COUNTERS_TABLE_NAME: "lcw-welcome-counters",
    REGISTRATION_CODES_URL: `${FAKES}/registration-codes`,
    API_KEY_PARAMETER: "/lcw/registration-codes/api-key",
    FROM_EMAIL: "support@lcw.app"
});

// --- What the control panel shows and changes
const state = { outbox: [], log: [], codesMade: 0, keyReads: 0, mintFails: false, apiDown: false, lastInvite: null };
for (const level of ["log", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...parts) => {
        original(...parts);
        const line = parts.map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ");
        state.log.push({ at: new Date().toISOString(), level, line });
    };
}

// --- DynamoDB Local, in Docker, fresh each run
function docker(...args) {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.error) throw new Error("Docker isn't installed or isn't on the PATH. Start Docker Desktop, then try again.");
    return result;
}
docker("rm", "-f", CONTAINER);
const started = docker("run", "--rm", "-d", "-p", `${DDB_PORT}:8000`, "--name", CONTAINER, "amazon/dynamodb-local");
if (started.status !== 0) throw new Error(`Couldn't start DynamoDB Local. Is Docker Desktop running?\n${started.stderr}`);
const stop = () => { docker("rm", "-f", CONTAINER); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const ddb = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
for (let tries = 0; ; tries++) {
    try { await ddb.send(new ListTablesCommand({})); break; } catch (error) {
        if (tries > 60) throw new Error(`DynamoDB Local didn't start: ${error.message}`);
        await new Promise((r) => setTimeout(r, 500));
    }
}

// The same keys, index and TTL attribute as template.yaml
async function freshTables() {
    for (const TableName of [process.env.SIGNUPS_TABLE_NAME, process.env.COUNTERS_TABLE_NAME]) {
        try { await ddb.send(new DeleteTableCommand({ TableName })); } catch { /* not there yet */ }
    }
    await ddb.send(new CreateTableCommand({
        TableName: process.env.SIGNUPS_TABLE_NAME, BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "email", AttributeType: "S" }, { AttributeName: "status", AttributeType: "S" }, { AttributeName: "signedUpAt", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
        GlobalSecondaryIndexes: [{ IndexName: "status-index", KeySchema: [{ AttributeName: "status", KeyType: "HASH" }, { AttributeName: "signedUpAt", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }]
    }));
    await ddb.send(new CreateTableCommand({
        TableName: process.env.COUNTERS_TABLE_NAME, BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "key", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "key", KeyType: "HASH" }]
    }));
}
await freshTables();

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))).on("error", reject);
});
const send = (res, status, body, type = "application/json") =>
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }).end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));

// --- Stand-ins for Parameter Store, POST /registration-codes and SES
createServer(async (req, res) => {
    const body = await readBody(req);
    const target = req.headers["x-amz-target"];
    if (target === "AmazonSSM.GetParameter") {
        state.keyReads++;
        const { Name } = JSON.parse(body);
        if (Name !== process.env.API_KEY_PARAMETER) return send(res, 400, { __type: "ParameterNotFound" }, "application/x-amz-json-1.1");
        return send(res, 200, { Parameter: { Name, Type: "SecureString", Value: FAKE_KEY } }, "application/x-amz-json-1.1");
    }
    if (req.method === "POST" && req.url === "/registration-codes") {
        if (req.headers["x-api-key"] !== FAKE_KEY) return send(res, 401, { message: "Unauthorized" });
        if (state.mintFails) return send(res, 500, { message: "Internal server error" });
        const { issuedTo } = JSON.parse(body);
        if (typeof issuedTo !== "string" || !issuedTo) return send(res, 400, { message: "issuedTo is required" });
        const code = `LCW-SMOKE-${String(++state.codesMade).padStart(4, "0")}`;
        return send(res, 201, { code, link: `${PAGE}/_wallet/#/register?code=${code}`, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    }
    if (req.method === "POST" && req.url === "/v2/email/outbound-emails") {
        const message = JSON.parse(body);
        // An address starting "refused" is refused, as SES refuses an address it won't take
        if (message.Destination?.ToAddresses?.[0]?.startsWith("refused")) {
            return res.writeHead(400, { "Content-Type": "application/json", "x-amzn-ErrorType": "BadRequestException" }).end(JSON.stringify({ message: "Illegal address" }));
        }
        const simple = message.Content?.Simple;
        state.outbox.push({
            at: new Date().toISOString(), from: message.FromEmailAddress, to: message.Destination?.ToAddresses?.join(", "),
            subject: simple?.Subject?.Data, text: simple?.Body?.Text?.Data, html: simple?.Body?.Html?.Data
        });
        return send(res, 200, { MessageId: `smoke-${state.outbox.length}` });
    }
    send(res, 404, { message: `The smoke test has no stand-in for ${req.method} ${req.url}` });
}).listen(FAKES_PORT, "127.0.0.1");

// --- The real handlers, imported only now that everything above points here
const { handler: signupHandler } = await import("../signup.mjs");
const { handler: inviteHandler } = await import("../invite.mjs");

// --- The sign-up API, standing in for API Gateway: the same CORS rule (only the page's own address), and the event shape it sends
createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin === PAGE ? { "Access-Control-Allow-Origin": PAGE } : {};
    if (req.method === "OPTIONS") {
        return res.writeHead(204, origin === PAGE ? { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type" } : {}).end();
    }
    if (req.method !== "POST" || req.url !== "/signup") return res.writeHead(404, cors).end();
    if (state.apiDown) return res.writeHead(503, { ...cors, "Content-Type": "application/json" }).end('{"message":"Service Unavailable"}');
    const body = await readBody(req);
    const result = await signupHandler({
        version: "2.0", routeKey: "POST /signup", rawPath: "/signup", body, isBase64Encoded: false,
        headers: req.headers, requestContext: { http: { method: "POST", path: "/signup", sourceIp: req.socket.remoteAddress } }
    });
    res.writeHead(result.statusCode, { ...cors, ...result.headers }).end(result.body);
}).listen(API_PORT);

// --- The page, built as usual, with the form pointed at the API above
// SIGNUP_API emptied, so an address left in the shell (after a deploy, say) can't point this page at a real service
const built = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: REPO, encoding: "utf8", env: { ...process.env, SIGNUP_API: "" } });
if (built.status !== 0) throw new Error(`The page didn't build:\n${built.stderr}`);
const DIST = join(REPO, "dist");
const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

async function scan(TableName) {
    const { Items = [] } = await ddb.send(new ScanCommand({ TableName }));
    return Items.map((item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v.N ?? v.S])));
}

async function control(req, res, path) {
    if (path === "/_smoke/state") {
        const signups = (await scan(process.env.SIGNUPS_TABLE_NAME)).sort((a, b) => a.signedUpAt.localeCompare(b.signedUpAt));
        const counters = await scan(process.env.COUNTERS_TABLE_NAME);
        const today = new Date().toISOString().slice(0, 10), hour = new Date().toISOString().slice(0, 13);
        const n = (key) => Number(counters.find((c) => c.key === key)?.n ?? 0);
        return send(res, 200, {
            settings, signups, mintFails: state.mintFails, apiDown: state.apiDown, lastInvite: state.lastInvite,
            codesMade: state.codesMade, keyReads: state.keyReads,
            counts: {
                autoInvites: n("auto-invites"), emailsToday: n(`emails#${today}`), resendsToday: n(`resends#${today}`),
                ipThisHour: counters.filter((c) => c.key.startsWith("ip#") && c.key.endsWith(`#${hour}`)).reduce((sum, c) => sum + Number(c.n), 0)
            },
            outbox: state.outbox.map(({ html, ...rest }, i) => ({ ...rest, i })),
            log: state.log.slice(-60)
        });
    }
    const email = path.match(/^\/_smoke\/email\/(\d+)$/);
    if (email && state.outbox[email[1]]) return send(res, 200, state.outbox[email[1]].html, "text/html; charset=utf-8");
    if (req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        if (path === "/_smoke/invite") {
            const event = { count: Number(form.get("count")), ...(form.get("dryRun") === "1" && { dryRun: true }) };
            try {
                state.lastInvite = { event, result: await inviteHandler(event, { getRemainingTimeInMillis: () => 900_000 }) };
            } catch (error) {
                state.lastInvite = { event, threw: error.message };
            }
        }
        if (path === "/_smoke/mint") state.mintFails = !state.mintFails;
        if (path === "/_smoke/api") state.apiDown = !state.apiDown;
        if (path === "/_smoke/reset") {
            await freshTables();
            Object.assign(state, { outbox: [], log: [], codesMade: 0, mintFails: false, apiDown: false, lastInvite: null });
        }
        return res.writeHead(303, { Location: "/_smoke" }).end();
    }
    if (path === "/_smoke") return send(res, 200, CONTROL_PANEL, "text/html; charset=utf-8");
    send(res, 404, "Not found", "text/plain");
}

createServer(async (req, res) => {
    try {
        const url = new URL(req.url, PAGE);
        if (url.pathname.startsWith("/_smoke")) return await control(req, res, url.pathname);
        if (url.pathname.startsWith("/_wallet")) return send(res, 200, WALLET_STUB, "text/html; charset=utf-8");
        let path = normalize("/" + decodeURIComponent(url.pathname));
        if (path === "/feedback") return res.writeHead(301, { Location: "/feedback/" }).end();
        let file = join(DIST, path);
        if (!file.startsWith(DIST)) return res.writeHead(403).end();
        if ((await stat(file)).isDirectory()) file = join(file, "index.html");
        let body = await readFile(file);
        if (file.endsWith(".html")) {
            const html = body.toString("utf8");
            if (!html.includes('<meta name="lcw-signup-api" content="">')) throw new Error("The built page has no empty lcw-signup-api meta tag, so it can't be pointed at the smoke test");
            body = html.replace('<meta name="lcw-signup-api" content="">', `<meta name="lcw-signup-api" content="${API}">`);
        }
        send(res, 200, body, types[extname(file)] || "application/octet-stream");
    } catch (error) {
        if (error.code === "ENOENT") return send(res, 404, "Not found", "text/plain");
        console.error("smoke server:", error);
        send(res, 500, "Smoke server error", "text/plain");
    }
}).listen(PAGE_PORT, () => {
    console.log(`\nSmoke test running. Nothing is sent anywhere.\n  The page:          ${PAGE}\n  The control panel: ${PAGE}/_smoke\n` +
        `  Settings: first ${settings.AUTO_INVITE_LIMIT} invited straight away, ${settings.DAILY_EMAIL_CAP} emails a day, ` +
        `${settings.IP_HOURLY_LIMIT} sign-ups an hour from one network, re-send after ${settings.RESEND_GAP_MINUTES} minute(s), ` +
        `${settings.RESEND_DAILY_CAP} re-sends a day, ${settings.MAX_RESENDS} per address\n` +
        `  An address starting "refused" (refused1@example.org, say) is refused by the stand-in SES.\n  Ctrl+C stops it.\n`);
    state.log.length = 0;   // the log panel shows the service's lines, not this one
});

const WALLET_STUB = `<!doctype html><meta charset="utf-8"><title>Wallet (smoke test stand-in)</title>
<body style="font:16px system-ui;max-width:40em;margin:3em auto;padding:0 1em">
<h1>The wallet's register page would open here</h1>
<p>In the real invite, this link opens the wallet's sign-up page with the code filled in.</p>
<p>Code in the link: <strong id="c"></strong></p>
<script>document.getElementById("c").textContent = new URLSearchParams(location.hash.split("?")[1] || "").get("code") || "(none)";</script>`;

const CONTROL_PANEL = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-up smoke test</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px 24px;color:#1f2937;background:#f9fafb}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px}
.box{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #e5e7eb;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f3f4f6;font-weight:600}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
form{display:inline-block;margin:0 10px 6px 0}button{font:inherit;padding:5px 10px;cursor:pointer}
.bad{color:#b91c1c;font-weight:600}.warn{color:#92400e}.ok{color:#166534;font-weight:600}
.counts span{display:inline-block;margin-right:22px}input[type=number]{width:4em;font:inherit}
pre{white-space:pre-wrap;margin:0}
</style>
<h1>Sign-up smoke test: control panel</h1>
<div>Nothing here is sent anywhere. The page is at <a href="/" target="_blank">localhost:${PAGE_PORT}</a>. This panel updates by itself.</div>
<h2>Counts</h2><div class="box counts" id="counts"></div>
<h2>Admin and failure buttons</h2><div class="box">
<form method="post" action="/_smoke/invite">Invite the next <input type="number" name="count" value="1" min="1" max="100">
<button name="dryRun" value="1">Dry run (who would be invited)</button> <button>Invite them</button></form><br>
<form method="post" action="/_smoke/mint"><button id="mint"></button></form>
<form method="post" action="/_smoke/api"><button id="api"></button></form>
<form method="post" action="/_smoke/reset" onsubmit="return confirm('Wipe the tables, emails and log, and start again?')"><button>Reset everything</button></form>
<div id="last" class="mono"></div></div>
<h2>Sign-ups (the lcw-welcome-signups table)</h2><table id="signups"></table>
<h2>Emails "sent" (what SES was asked to send)</h2><table id="outbox"></table>
<h2>Log (what CloudWatch would get; red lines are the ones that alert the team)</h2><div class="box mono" id="log"></div>
<script>
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const time = (iso) => iso ? new Date(iso).toLocaleTimeString() : "";
function table(node, head, rows) {
  node.replaceChildren(); const tr = el("tr"); head.forEach((h) => tr.append(el("th", h))); node.append(tr);
  if (!rows.length) { const r = el("tr"); const td = el("td", "None yet"); td.colSpan = head.length; r.append(td); node.append(r); }
  rows.forEach((cells) => { const r = el("tr"); cells.forEach((c) => r.append(c instanceof Node ? (() => { const td = el("td"); td.append(c); return td; })() : el("td", c ?? ""))); node.append(r); });
}
async function refresh() {
  let s; try { s = await (await fetch("/_smoke/state")).json(); } catch { return; }
  const c = document.getElementById("counts"); c.replaceChildren(
    el("span", "Invited straight away: " + s.counts.autoInvites + " of " + s.settings.AUTO_INVITE_LIMIT),
    el("span", "Invite emails today: " + s.counts.emailsToday + " of " + s.settings.DAILY_EMAIL_CAP),
    el("span", "Re-sends today: " + s.counts.resendsToday + " of " + s.settings.RESEND_DAILY_CAP + " (" + s.settings.MAX_RESENDS + " per address)"),
    el("span", "Sign-ups from your network this hour: " + s.counts.ipThisHour + " of " + s.settings.IP_HOURLY_LIMIT),
    el("span", "Codes made: " + s.codesMade),
    el("span", "Re-send gap: " + s.settings.RESEND_GAP_MINUTES + " min"));
  document.getElementById("mint").textContent = s.mintFails ? "Making codes: FAILING (click to fix)" : "Making codes: working (click to make it fail)";
  document.getElementById("mint").className = s.mintFails ? "bad" : "";
  document.getElementById("api").textContent = s.apiDown ? "Sign-up API: DOWN (click to bring back)" : "Sign-up API: up (click to take it down)";
  document.getElementById("api").className = s.apiDown ? "bad" : "";
  document.getElementById("last").textContent = s.lastInvite ? "Last \\"invite the next N\\": " + JSON.stringify(s.lastInvite) : "";
  table(document.getElementById("signups"), ["Signed up", "Email", "Name", "Organization", "Status", "Code", "Invited", "Last emailed"],
    s.signups.map((r) => [time(r.signedUpAt), r.email, r.name, r.organization, el("span", r.status + (r.failures ? " (refused " + r.failures + "x)" : ""), r.status === "invited" ? "ok" : r.status === "inviting" ? "warn" : r.status === "failed" ? "bad" : ""), r.code, time(r.invitedAt), time(r.lastEmailedAt)]));
  table(document.getElementById("outbox"), ["Sent", "From", "To", "Subject", "Open"],
    s.outbox.slice().reverse().map((m) => { const a = el("a", "Open the email"); a.href = "/_smoke/email/" + m.i; a.target = "_blank"; return [time(m.at), m.from, m.to, m.subject, a]; }));
  const log = document.getElementById("log"); log.replaceChildren();
  if (!s.log.length) log.append(el("div", "Nothing yet"));
  s.log.slice().reverse().forEach((l) => log.append(el("pre", time(l.at) + "  " + l.line, /INVITE_FAILED|SIGNUP_FAILED|DAILY_EMAIL_CAP_REACHED/.test(l.line) ? "bad" : l.level !== "log" ? "warn" : "")));
}
refresh(); setInterval(refresh, 1500);
</script></html>`;
