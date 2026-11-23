// The calls outside the service's tables: the API key, POST /registration-codes and SES.
//   cd signup/src && npm test
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { apiKeyReader, codeMinter, sesMailer } from "../clients.mjs";
import { checker } from "./helpers.mjs";

const { check, done } = checker();

// --- The API key
{
    const ssm = mockClient(SSMClient);
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: "the-key" } });
    const read = apiKeyReader({ name: "/test/api-key", ssm: new SSMClient({ region: "us-east-1" }) });
    const first = await read(), second = await read();
    const calls = ssm.commandCalls(GetParameterCommand);
    check("the key comes from the named parameter, decrypted", first === "the-key" && calls[0].args[0].input.Name === "/test/api-key" && calls[0].args[0].input.WithDecryption === true);
    check("it's read once and kept", second === "the-key" && calls.length === 1);
    ssm.reset();
    ssm.on(GetParameterCommand).resolves({ Parameter: {} });
    const empty = apiKeyReader({ name: "/x", ssm: new SSMClient({ region: "us-east-1" }) });
    let threw = false;
    try { await empty(); } catch { threw = true; }
    check("an empty parameter is an error, not an empty key", threw);
    ssm.restore();
}

// --- POST /registration-codes
{
    const requests = [];
    const answer = { status: 201, body: { code: "LCW-ABC", link: "https://w.example/#/register?code=LCW-ABC", expiresAt: "2027-03-01T00:00:00.000Z" } };
    const fetchImpl = async (url, init) => {
        requests.push({ url, init });
        return { status: answer.status, json: async () => answer.body };
    };
    const mint = codeMinter({ url: "https://api.example/registration-codes", apiKey: async () => "the-key", fetchImpl });
    const minted = await mint("ann@example.org");
    const { url, init } = requests[0];
    check("it posts to the endpoint", url === "https://api.example/registration-codes" && init.method === "POST");
    check("with the key in x-api-key, as JSON", init.headers["x-api-key"] === "the-key" && init.headers["Content-Type"] === "application/json");
    check("with the person's email as issuedTo", JSON.parse(init.body).issuedTo === "ann@example.org");
    check("with a time limit", init.signal instanceof AbortSignal);
    check("and answers the code, link and expiry", minted.code === "LCW-ABC" && minted.link.endsWith("LCW-ABC") && minted.expiresAt === "2027-03-01T00:00:00.000Z");
    for (const [status, body, label] of [[401, { error: "Missing or wrong API key." }, "a 401"], [500, {}, "a 500"], [201, { code: "X" }, "a 201 with no link"], [500, { code: "LCW-X", link: "https://w.example/#/register?code=LCW-X" }, "a 500 with a body that looks right"], [200, { code: "LCW-X", link: "https://w.example/#/register?code=LCW-X" }, "a 200 (not 201)"]]) {
        answer.status = status; answer.body = body;
        let threw = false;
        try { await mint("ann@example.org"); } catch { threw = true; }
        check(`${label} is an error`, threw);
    }
}

// --- SES
{
    const ses = mockClient(SESv2Client);
    ses.on(SendEmailCommand).resolves({ MessageId: "1" });
    const send = sesMailer({ from: "support@lcw.app", ses: new SESv2Client({ region: "us-east-1" }) });
    await send({ to: "ann@example.org", subject: "S", text: "T", html: "<p>H</p>" });
    const input = ses.commandCalls(SendEmailCommand)[0].args[0].input;
    check("it sends from support@lcw.app to the person", input.FromEmailAddress === "support@lcw.app" && input.Destination.ToAddresses.join() === "ann@example.org");
    check("with the subject, text and HTML", input.Content.Simple.Subject.Data === "S" && input.Content.Simple.Body.Text.Data === "T" && input.Content.Simple.Body.Html.Data === "<p>H</p>");
    ses.restore();
}

done();
