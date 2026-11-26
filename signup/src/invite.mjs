// "Invite the next N": invites the next N people in the queue, in sign-up
// order. Not on the public API. The admin console (lcw-admin-back-end) calls
// it with lambda:InvokeFunction, so only people signed in there can run it.
//   { "count": 25, "dryRun": true }  -> { dryRun, wouldInvite: [{ email, name, organization, signedUpAt }] }
//   { "count": 25 }                  -> { invited: [emails], skipped, failed, capReached, stoppedEarly, stoppedOnFailures }
//   a count that isn't a whole number from 1 to MAX_BATCH -> { error }, with nothing invited.
//   The caller must check for error: it's an answer, not a failed invocation, so it doesn't alarm.
// "Invite the next N" can invite a few fewer than N, if someone in the queue was
// invited a moment before (the queue's index lags a little); they're counted as
// skipped. It doesn't top up from further down the queue, so pressing the button
// twice by mistake doesn't invite twice as many.
// It stops early if the daily email cap is reached, the function is about to
// time out, or 3 invites fail in a row (lcw-back-end or SES is probably down);
// whoever is left stays queued.
import { dynamoStore } from "./store.mjs";
import { apiKeyReader, codeMinter, sesMailer } from "./clients.mjs";
import { configFromEnv, makeService, describeError } from "./service.mjs";

const service = makeService({
    store: dynamoStore(),
    mintCode: codeMinter({ apiKey: apiKeyReader() }),
    sendEmail: sesMailer(),
    config: configFromEnv()
});

export const handler = async (event, context) => {
    let result;
    try {
        result = await service.inviteNext({
            count: event?.count,
            dryRun: event?.dryRun === true,
            timeLeft: () => context?.getRemainingTimeInMillis?.() ?? Infinity
        });
    } catch (error) {
        console.error("INVITE_FAILED: inviting the next group stopped:", describeError(error, { stack: true }));
        throw error;
    }
    // Counts only: the answer goes to the admin console, the log keeps no addresses
    const counts = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
    console.log(`Invite the next N (count: ${JSON.stringify(event?.count ?? null)}${event?.dryRun === true ? ", dry run" : ""}):`, JSON.stringify(counts));
    return result;
};
