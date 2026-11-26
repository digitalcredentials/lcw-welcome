// The two things the service reaches outside its own tables for:
// lcw-back-end's POST /registration-codes, and SES.
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// How long a container keeps the API key before reading it again, so a
// replaced key takes effect without a deploy (the same as lcw-back-end)
const KEY_CACHE_MS = 5 * 60 * 1000;

// The API key for POST /registration-codes, from Parameter Store. It lets
// its holder create wallet accounts, so it stays on the server: never in
// the page, the repo or a log.
export function apiKeyReader({ name = process.env.API_KEY_PARAMETER, ssm = new SSMClient() } = {}) {
    let cached, cachedAt = 0;
    return async () => {
        if (!cached || Date.now() - cachedAt > KEY_CACHE_MS) {
            const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
            if (!Parameter?.Value) throw new Error("The API key parameter is empty");
            cached = Parameter.Value;
            cachedAt = Date.now();
        }
        return cached;
    };
}

// Makes one person's code. Answers { code, link, expiresAt }; throws if lcw-back-end didn't make one.
export function codeMinter({ url = process.env.REGISTRATION_CODES_URL, apiKey, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    return async (email) => {
        const response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": await apiKey() },
            body: JSON.stringify({ issuedTo: email }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.status !== 201) throw new Error(`POST /registration-codes answered ${response.status}`);
        const { code, link, expiresAt } = await response.json();
        if (typeof code !== "string" || typeof link !== "string") throw new Error("POST /registration-codes answered without a code and link");
        return { code, link, expiresAt };
    };
}

// Sends one email. Gives up after timeoutMs, so a stalled send fails while
// there's still time to put the sign-up back, well inside the function's timeout.
export function sesMailer({ from = process.env.FROM_EMAIL, ses = new SESv2Client(), timeoutMs = 5000 } = {}) {
    return async ({ to, subject, text, html }) => {
        await ses.send(new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } } } }
        }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    };
}
