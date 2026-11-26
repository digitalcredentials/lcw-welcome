// Shared by the tests: a store that keeps everything in memory, with the
// same rules as store.mjs's conditions, and fakes for the code minter and mailer.

export function memoryStore() {
    const signups = new Map(), counters = new Map();
    const copy = (row) => (row ? { ...row } : null);
    return {
        signups, counters,
        async getSignup(email) { return copy(signups.get(email)); },
        async createSignup({ email, name, organization, signedUpAt }) {
            if (signups.has(email)) return false;
            signups.set(email, { email, name, signedUpAt, status: "queued", ...(organization && { organization }) });
            return true;
        },
        async markAutoInvite(email) {
            const row = signups.get(email);
            if (!row) throw new Error("ConditionalCheckFailed");
            row.autoInvite = 1;
        },
        async claim(email, at, staleBefore) {
            const row = signups.get(email);
            if (!(row?.status === "queued" || (row?.status === "inviting" && row.claimedAt < staleBefore))) return null;
            row.status = "inviting";
            row.claimedAt = at;
            return copy(row);
        },
        async saveCode(email, { code, link, expiresAt }, claimedAt) {
            const row = signups.get(email);
            if (row?.status !== "inviting" || row.claimedAt !== claimedAt) throw new Error("ConditionalCheckFailed");
            Object.assign(row, { code, link, expiresAt: expiresAt ?? "" });
        },
        async release(email, claimedAt) { const row = signups.get(email); if (row?.status === "inviting" && row.claimedAt === claimedAt) row.status = "queued"; },
        async markInvited(email, at, claimedAt) {
            const row = signups.get(email);
            if (row?.status !== "inviting" || row.claimedAt !== claimedAt) throw new Error("ConditionalCheckFailed");
            Object.assign(row, { status: "invited", invitedAt: at, lastEmailedAt: at });
            delete row.claimedAt;
        },
        async markEmailed(email, at, before, maxResends) {
            const row = signups.get(email);
            if (row?.status !== "invited" || (row.lastEmailedAt && !(row.lastEmailedAt < before))) return false;
            if ((row.resends ?? 0) >= maxResends) return false;
            row.lastEmailedAt = at;
            row.resends = (row.resends ?? 0) + 1;
            return true;
        },
        async unmarkEmailed(email, at, previous) {
            const row = signups.get(email);
            if (row?.lastEmailedAt !== at) return;
            if (previous) row.lastEmailedAt = previous; else delete row.lastEmailedAt;
            row.resends = (row.resends ?? 0) - 1;
        },
        async listQueued(limit, staleBefore) {
            return [...signups.values()].filter((r) => r.status === "queued" || (r.status === "inviting" && r.claimedAt < staleBefore)).sort((a, b) => a.signedUpAt.localeCompare(b.signedUpAt)).slice(0, limit).map(copy);
        },
        async take(counter, max) {
            const n = counters.get(counter) ?? 0;
            if (n >= max) return false;
            counters.set(counter, n + 1);
            return true;
        },
        async giveBack(counter) { const n = counters.get(counter) ?? 0; if (n > 0) counters.set(counter, n - 1); },
        async count(counter) { return counters.get(counter) ?? 0; }
    };
}

// A code minter that answers like POST /registration-codes, or fails when told to
export function fakeMinter() {
    let n = 0;
    const minter = async (email) => {
        minter.calls.push(email);
        if (minter.fail) throw new Error("POST /registration-codes answered 500");
        n++;
        const code = `LCW-TEST${String(n).padStart(12, "0")}`;
        return { code, link: `https://wallet.example.org/#/register?code=${code}`, expiresAt: minter.expiresAt ?? "2027-03-01T00:00:00.000Z" };
    };
    minter.calls = [];
    return minter;
}

export function fakeMailer() {
    const mailer = async (message) => {
        if (mailer.fail) throw new Error("SES refused");
        mailer.sent.push(message);
    };
    mailer.sent = [];
    return mailer;
}

// Collects log lines instead of printing them
export function quietLog() {
    const lines = [];
    const add = (level) => (...parts) => lines.push(`${level} ${parts.join(" ")}`);
    return { lines, log: add("log"), warn: add("warn"), error: add("error") };
}

// A clock the test moves by hand
export function manualClock(start = "2026-12-15T15:00:00.000Z") {
    let now = new Date(start);
    const clock = () => new Date(now);
    clock.advance = (ms) => { now = new Date(now.getTime() + ms); };
    clock.set = (iso) => { now = new Date(iso); };
    return clock;
}

export function checker() {
    let failures = 0;
    const check = (label, ok, detail) => {
        console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail !== undefined && !ok ? ` (${JSON.stringify(detail)})` : ""}`);
        if (!ok) failures++;
    };
    const done = () => {
        console.log(failures ? `\n${failures} FAILED` : "\nall ok");
        process.exit(failures ? 1 : 0);
    };
    return { check, done };
}
