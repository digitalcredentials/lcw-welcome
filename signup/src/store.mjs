// The sign-up service's two DynamoDB tables. Everything that reads or writes
// them is here, so the rules that keep two requests from stepping on each
// other (the condition on each write) are in one place.
//
// Sign-ups table, one row per email address (lowercased):
//   email, name, organization, signedUpAt, status, and once invited:
//   code, link, expiresAt (the code's), invitedAt, lastEmailedAt
// status is "queued" (waiting), "inviting" (an invite is being sent right
// now, since claimedAt) or "invited". An invite still "inviting" after a
// while didn't finish (a timeout, say), so it counts as queued again. A code
// is kept on the row as soon as it's made, so finishing that invite later
// sends the same code. The status-index (status, signedUpAt) lists the
// queue in sign-up order.
//
// A sign-up given one of the first-N places has autoInvite = 1. If its invite
// fails, it keeps the place and stays queued, first in line, until it's tried again.
//
// Each step of an invite after the claim (saveCode, release, markInvited)
// checks claimedAt is still the claim it made, so an invite that was too slow
// and taken over (once stale) can't undo or finish the one that took over.
//
// Counters table, one row per counter: key, n, and removeAt (epoch seconds;
// DynamoDB deletes the row after it) on counters that only matter for a while:
//   auto-invites           how many of the first-N places are taken
//   emails#<YYYY-MM-DD>    emails sent that day (UTC)
//   ip#<hash>#<hour>       sign-ups from one network in one hour, kept 2 hours: an
//                          IPv4 address, or an IPv6 /64, as an unsalted hash (it
//                          hides the address at a glance, but someone who can read
//                          the table could work an IPv4 address out from it)
import {
    DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, QueryCommand,
    ConditionalCheckFailedException
} from "@aws-sdk/client-dynamodb";

const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });

// A DynamoDB item as a plain object (strings and numbers only, which is all these tables hold)
function plain(item) {
    if (!item) return null;
    return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, value.N !== undefined ? Number(value.N) : value.S]));
}

// Runs a conditional write; false when its condition stopped it
async function conditional(client, command) {
    try {
        return await client.send(command);
    } catch (error) {
        if (error instanceof ConditionalCheckFailedException || error?.name === "ConditionalCheckFailedException") return false;
        throw error;
    }
}

export function dynamoStore({
    client = new DynamoDBClient(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
    signupsTable = process.env.SIGNUPS_TABLE_NAME,
    countersTable = process.env.COUNTERS_TABLE_NAME
} = {}) {
    const key = (email) => ({ email: S(email) });

    return {
        async getSignup(email) {
            const { Item } = await client.send(new GetItemCommand({ TableName: signupsTable, Key: key(email), ConsistentRead: true }));
            return plain(Item);
        },

        // Adds a queued sign-up; false if the address has already signed up
        async createSignup({ email, name, organization, signedUpAt }) {
            const done = await conditional(client, new PutItemCommand({
                TableName: signupsTable,
                Item: {
                    email: S(email), name: S(name), signedUpAt: S(signedUpAt), status: S("queued"),
                    ...(organization && { organization: S(organization) })
                },
                ConditionExpression: "attribute_not_exists(email)"
            }));
            return done !== false;
        },

        // Records that a sign-up has one of the first-N places
        async markAutoInvite(email) {
            await client.send(new UpdateItemCommand({
                TableName: signupsTable,
                Key: key(email),
                UpdateExpression: "SET autoInvite = :one",
                ConditionExpression: "attribute_exists(email)",
                ExpressionAttributeValues: { ":one": N(1) }
            }));
        },

        // Moves a sign-up that's queued, or stuck "inviting" since before
        // `staleBefore`, to "inviting" and returns it; null if it's neither
        // (someone else is inviting it right now, or it's invited)
        async claim(email, at, staleBefore) {
            const done = await conditional(client, new UpdateItemCommand({
                TableName: signupsTable,
                Key: key(email),
                UpdateExpression: "SET #status = :inviting, claimedAt = :at",
                ConditionExpression: "#status = :queued OR (#status = :inviting AND claimedAt < :stale)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":inviting": S("inviting"), ":queued": S("queued"), ":at": S(at), ":stale": S(staleBefore) },
                ReturnValues: "ALL_NEW"
            }));
            return done ? plain(done.Attributes) : null;
        },

        // Keeps a newly made code on the row, before it's emailed
        async saveCode(email, { code, link, expiresAt }, claimedAt) {
            await client.send(new UpdateItemCommand({
                TableName: signupsTable,
                Key: key(email),
                UpdateExpression: "SET code = :code, link = :link, expiresAt = :expiresAt",
                ConditionExpression: "#status = :inviting AND claimedAt = :claimedAt",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":inviting": S("inviting"), ":claimedAt": S(claimedAt), ":code": S(code), ":link": S(link), ":expiresAt": S(expiresAt ?? "") }
            }));
        },

        // Puts a sign-up whose invite didn't go out back in the queue, in its
        // old place (its signedUpAt is unchanged)
        async release(email, claimedAt) {
            await conditional(client, new UpdateItemCommand({
                TableName: signupsTable,
                Key: key(email),
                UpdateExpression: "SET #status = :queued",
                ConditionExpression: "#status = :inviting AND claimedAt = :claimedAt",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":queued": S("queued"), ":inviting": S("inviting"), ":claimedAt": S(claimedAt) }
            }));
        },

        async markInvited(email, at, claimedAt) {
            await client.send(new UpdateItemCommand({
                TableName: signupsTable,
                Key: key(email),
                UpdateExpression: "SET #status = :invited, invitedAt = :at, lastEmailedAt = :at REMOVE claimedAt",
                ConditionExpression: "#status = :inviting AND claimedAt = :claimedAt",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":invited": S("invited"), ":inviting": S("inviting"), ":at": S(at), ":claimedAt": S(claimedAt) }
            }));
        },

        // Records a re-sent invite, if the last email went before `before` and
        // fewer than `maxResends` have been re-sent; false otherwise. Counts it in
        // `resends`. One request wins when two arrive together.
        async markEmailed(email, at, before, maxResends) {
            const done = await conditional(client, new UpdateItemCommand({
                TableName: signupsTable,
                Key: key(email),
                UpdateExpression: "SET lastEmailedAt = :at ADD resends :one",
                ConditionExpression: "#status = :invited AND (attribute_not_exists(lastEmailedAt) OR lastEmailedAt < :before)" +
                    " AND (attribute_not_exists(resends) OR resends < :max)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":at": S(at), ":before": S(before), ":invited": S("invited"), ":one": N(1), ":max": N(maxResends) }
            }));
            return done !== false;
        },

        // Undoes markEmailed when the re-send didn't go out (a cap, or SES
        // failed), so trying again isn't blocked for the re-send gap and the
        // re-send isn't counted. Only if lastEmailedAt is still the `at` that
        // markEmailed set.
        async unmarkEmailed(email, at, previous) {
            await conditional(client, new UpdateItemCommand({
                TableName: signupsTable,
                Key: key(email),
                UpdateExpression: (previous ? "SET lastEmailedAt = :previous" : "REMOVE lastEmailedAt") + " ADD resends :minus",
                ConditionExpression: "lastEmailedAt = :at",
                ExpressionAttributeValues: { ":at": S(at), ":minus": N(-1), ...(previous && { ":previous": S(previous) }) }
            }));
        },

        // The first `limit` sign-ups waiting for an invite, oldest first: the
        // queued ones, and any stuck "inviting" since before `staleBefore`
        async listQueued(limit, staleBefore) {
            const queued = await client.send(new QueryCommand({
                TableName: signupsTable,
                IndexName: "status-index",
                KeyConditionExpression: "#status = :queued",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":queued": S("queued") },
                ScanIndexForward: true,
                Limit: limit
            }));
            // Stuck ones are rare, so this reads every "inviting" row and keeps the stale ones
            const stuck = [];
            let ExclusiveStartKey;
            do {
                const page = await client.send(new QueryCommand({
                    TableName: signupsTable,
                    IndexName: "status-index",
                    KeyConditionExpression: "#status = :inviting",
                    FilterExpression: "claimedAt < :stale",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: { ":inviting": S("inviting"), ":stale": S(staleBefore) },
                    ScanIndexForward: true,
                    ExclusiveStartKey
                }));
                stuck.push(...(page.Items ?? []));
                ExclusiveStartKey = page.LastEvaluatedKey;
            } while (ExclusiveStartKey);
            return [...(queued.Items ?? []), ...stuck].map(plain)
                .sort((a, b) => a.signedUpAt.localeCompare(b.signedUpAt)).slice(0, limit);
        },

        // Takes one from a counter that allows `max`; false when it's used up.
        // removeAt (epoch seconds), when given, lets DynamoDB delete the row later.
        async take(counter, max, removeAt) {
            // The condition below lets the first one through when the row doesn't exist yet, whatever max is
            if (!(max >= 1)) return false;
            const done = await conditional(client, new UpdateItemCommand({
                TableName: countersTable,
                Key: { key: S(counter) },
                UpdateExpression: removeAt ? "ADD n :one SET removeAt = :removeAt" : "ADD n :one",
                ConditionExpression: "attribute_not_exists(n) OR n < :max",
                ExpressionAttributeValues: { ":one": N(1), ":max": N(max), ...(removeAt && { ":removeAt": N(removeAt) }) }
            }));
            return done !== false;
        },

        // Gives one back to a counter, after what it was taken for didn't happen
        async giveBack(counter) {
            await conditional(client, new UpdateItemCommand({
                TableName: countersTable,
                Key: { key: S(counter) },
                UpdateExpression: "ADD n :minus",
                ConditionExpression: "n > :zero",
                ExpressionAttributeValues: { ":minus": N(-1), ":zero": N(0) }
            }));
        },

        async count(counter) {
            const { Item } = await client.send(new GetItemCommand({ TableName: countersTable, Key: { key: S(counter) }, ConsistentRead: true }));
            return Item?.n ? Number(Item.n.N) : 0;
        }
    };
}
