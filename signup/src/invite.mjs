// "Invite the next N": invites the next N people in the queue, in sign-up
// order. Not on the public API. The admin console (lcw-admin-back-end) calls
// it with lambda:InvokeFunction, so only people signed in there can run it.
//   { "count": 25, "dryRun": true }  -> { dryRun, wouldInvite: [{ email, name, organization, signedUpAt }] }
//   { "count": 25 }                  -> { invited: [emails], skipped, failed, capReached, stoppedEarly }
// It stops early if the daily email cap is reached, or the function is about
// to time out; whoever is left stays queued.
import { dynamoStore } from "./store.mjs";
import { apiKeyReader, codeMinter, sesMailer } from "./clients.mjs";
import { configFromEnv, makeService } from "./service.mjs";

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
        console.error("INVITE_FAILED: inviting the next group stopped:", error);
        throw error;
    }
    // Counts only: the answer goes to the admin console, the log keeps no addresses
    const counts = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
    console.log(`Invite the next ${event?.count}${event?.dryRun === true ? " (dry run)" : ""}:`, JSON.stringify(counts));
    return result;
};
