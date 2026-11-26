# Placeholders

Wording on the welcome page that isn't final yet. Each item is marked in `src/index.html` with `data-ph="<id>"`, and `npm test` checks that this list and the page match.

**This list must be empty before launch.** When an item is settled, update the wording, remove its `data-ph` marker and delete its row.

## Waiting on Legal

Where Legal's wording comes from is tracked in [#1](https://github.com/digitalcredentials/lcw-welcome/issues/1).

| ID | Where | Says now |
|---|---|---|
| `alpha-status` | Top of the page, the "Alpha" box | Try the wallet with our test badge, not your real credentials. Things may go wrong while it runs, and when the alpha ends, every account and everything in it is deleted. |
| `signup-privacy` | Try it, under the sign-up form | We use your name, email and organization only to run and improve the alpha. See the privacy notice. |
| `notice-offline` | Try it, list of notices | We don't plan to change or reset the alpha while it runs, but we may take it offline if something goes seriously wrong. |
| `notice-deletion` | Try it, list of notices | When the alpha ends, we delete every account and everything in it. We'll email you the date well in advance, so you can download a copy first. |
| `notice-security` | Try it, list of notices | The alpha may have security weaknesses we haven't found yet. |
| `notice-data-use` | Try it, list of notices | How we use your name, email and organization, your choice about being contacted, and what you send with feedback, and how long we keep them. (A description of what goes here, not final wording.) |
| `notice-terms` | Try it, list of notices | By using the alpha, you agree to the alpha terms of use and the privacy notice. Both links go nowhere yet. |
| `faq-private-notice` | FAQ, "Is my data private?" | See the privacy notice. (Not linked yet.) |
| `footer-terms` | Footer | Terms of use (links nowhere yet) |
| `footer-privacy` | Footer | Privacy (links nowhere yet) |
| `feedback-google` | Feedback page (/feedback), above the reference | We collect feedback with Google Forms, which opens in a new tab. Google's terms of service and privacy policy apply there. |
| `feedback-screenshots` | Feedback page (/feedback), under the Add screenshots button | Screenshots can show your name, email or credentials. Only the Digital Credentials Commons team can see them, and we delete them when the alpha ends. |

Not on this page, so not marked: the feedback Google Form's description ends "We use what you send only to run and improve the alpha. See the privacy notice." Link the privacy notice there once it exists.

## Waiting on the team

| ID | Where | Says now | Waiting on |
|---|---|---|---|
| `alpha-end-date` | Top of the page, the "Alpha" box | End date to come. | The date the alpha ends |
| `real-credentials-date` | Top of the page, the "Alpha" box | A version for your real credentials is planned for early 2027. | Confirming the timing |
| `tip-same-browser` | Try it, the tip under "What happens next" | Tip: sign in on the same computer and browser you used to set up your wallet. That's where your badge is offered. | Remove once an empty wallet offers the badge in any browser ([lcw-front-end#223](https://github.com/digitalcredentials/lcw-front-end/issues/223)) |
| `wallet-link` | Try it, "Open the alpha wallet" | Links to https://alpha.lcw.app/#/login | alpha.lcw.app goes live at launch: check the link works then |
| `faq-phone` | FAQ, "I already use the Learner Credential Wallet phone app" | Nothing changes for now. The alpha is a separate test, so keep using the phone app for your real credentials. Schools that send credentials to the phone app keep sending them there. | Confirming the answer |
| `faq-private` | FAQ, "Is my data private?" | The wallet encrypts what you add in your browser, before it's stored in your space, so our storage servers hold only an encrypted copy. A credential you share is the exception: anyone with the link can see it until you take it down. We're still improving how this works. | Confirming the answer |
| `faq-approve` | FAQ, "Why does the wallet ask me to sign in again when I save a credential?" | When a website sends you a credential, the wallet asks you to confirm it's you before saving it, even if you're already signed in. That way, no one else can add credentials to a wallet you've left open. The box says "Sign in to continue," but you haven't been signed out. | James to confirm, including what someone who signs in with only a password sees. If the wallet changes the box to "Approve with your passkey" ([lcw-front-end#249](https://github.com/digitalcredentials/lcw-front-end/issues/249)), update the last sentence. |
| `faq-claimed` | FAQ, "Why doesn't the claim page take me to my wallet afterward?" | The claim page doesn't know which wallet you chose, so it can't send you there. Once it says your badge is claimed, open your wallet to see it. | Before launch: if both Add buttons still stay active after a claim ([aws-lambda-issuer#16](https://github.com/digitalcredentials/aws-lambda-issuer/issues/16)), add "Press Add only once. Each press adds another copy." |
| `faq-json` | FAQ, "What's the 'Credential JSON' box in Add Credential for?" | Don't edit it: a credential is signed, so any change means it won't show as verified. | James to confirm. Changing only spacing or line breaks may not matter, so "Don't change what it says" may be more accurate. |
| `blog-link` | Get involved, "Read the blog post" | Why we're building the wallet this way. (No link.) | The blog post, then its link |
| `vendors-when` | Get involved, "Vendors and issuers" | in spring | Confirming when vendor testing starts |
| `vendors-how` | Get involved, "Vendors and issuers" | How to take part, to come. | How vendors and issuers take part |
| `partners-how` | Get involved, "Schools and community organizations" | How partners can take part, to come. | How partners take part |
| `repo-list` | Go deeper, "The code" | The list of eight repositories, "all public on GitHub and MIT licensed" | James to check the list. Not listed, for him to decide: batch-issuer-ui (moving out of the wallet in [lcw-front-end#193](https://github.com/digitalcredentials/lcw-front-end/issues/193)), lcw-admin-front-end and lcw-admin-back-end. |
| `standards-link` | Go deeper, "Interoperability standards" | Describes a list of standards but doesn't link to one | dccommons.org/standards, then a link to it |
