// The invite email. Its wording is a draft, listed in PLACEHOLDERS.md
// ("Not on the page"), until the team signs it off. The look follows the
// wallet's own emails (lcw-back-end), so testers see one style.
//
// Nothing anyone types into the form goes into it: anyone can sign up any
// address, so a name in the email would let a stranger send their own words
// from support@lcw.app.

const escapeHtml = (text) => String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// "March 3, 2027"; empty if the date can't be read
function day(iso) {
    const date = new Date(iso ?? "");
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function inviteEmail({ code, link, expiresAt }) {
    const until = day(expiresAt);
    const subject = "Your invite to the Learner Credential Wallet alpha";
    const text =
        "Thanks for signing up. Here's your invite to the Learner Credential Wallet alpha.\n\n" +
        `Set up your wallet: ${link}\n\n` +
        "Open the link on a computer. It opens the wallet's sign-up page with your registration code filled in.\n\n" +
        `Your code is ${code}. It's just for you and sets up one wallet.` + (until ? ` It works until ${until}.` : "") + "\n\n" +
        "Questions? Reply to this email.";
    const html =
        "<!doctype html><html><body style='margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;'>" +
        "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='background:#f3f4f6;padding:24px 0;'><tr><td align='center'>" +
        "<table role='presentation' width='560' cellpadding='0' cellspacing='0' style='max-width:560px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;'>" +
        "<tr><td style='padding:24px 32px 8px 32px;font-size:16px;font-weight:600;'>Learner Credential Wallet</td></tr>" +
        "<tr><td style='padding:8px 32px 24px 32px;font-size:16px;line-height:1.5;'>" +
        "<p>Thanks for signing up. Here's your invite to the Learner Credential Wallet alpha.</p>" +
        `<p style='margin:24px 0;'><a href='${escapeHtml(link)}' style='display:inline-block;background:#3730a3;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;'>Set up your wallet</a></p>` +
        "<p>Open the link on a computer. It opens the wallet's sign-up page with your registration code filled in.</p>" +
        `<p>Your code is <span style='font-family:ui-monospace,Menlo,Consolas,monospace;'>${escapeHtml(code)}</span>. It's just for you and sets up one wallet.` + (until ? ` It works until ${escapeHtml(until)}.` : "") + "</p>" +
        "<p style='font-size:14px;color:#6b7280;'>Questions? Reply to this email.</p>" +
        "</td></tr>" +
        "<tr><td style='padding:16px 32px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280;'>Digital Credentials Commons &middot; Learner Credential Wallet</td></tr>" +
        "</table></td></tr></table></body></html>";
    return { subject, text, html };
}
