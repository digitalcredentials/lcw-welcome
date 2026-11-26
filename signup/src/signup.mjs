// POST /signup: the welcome page's sign-up form. Public: anyone can call it.
// CORS only stops other web pages calling it from a browser, not scripts, so
// the limits in service.mjs are what protect it.
// Body: { name, email, organization?, website? }, where website is the honeypot.
// Answers 202 { ok: true } for every accepted sign-up, 400 or 429 with
// { error }, or 500 if something failed (nothing is lost: trying again is safe).
import { dynamoStore } from "./store.mjs";
import { apiKeyReader, codeMinter, sesMailer } from "./clients.mjs";
import { configFromEnv, makeService } from "./service.mjs";

const service = makeService({
    store: dynamoStore(),
    mintCode: codeMinter({ apiKey: apiKeyReader() }),
    sendEmail: sesMailer(),
    config: configFromEnv()
});

const json = (statusCode, body) => ({
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
});

export const handler = async (event) => {
    let input;
    try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body;
        input = JSON.parse(raw ?? "");
    } catch {
        return json(400, { error: "Send a JSON object." });
    }
    try {
        const { status, body } = await service.signUp(input, event.requestContext?.http?.sourceIp);
        return json(status, body);
    } catch (error) {
        console.error("SIGNUP_FAILED:", error);
        return json(500, { error: "Sign-up isn't working right now. Please try again." });
    }
};
