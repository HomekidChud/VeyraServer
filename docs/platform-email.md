# Veyra platform waitlist and email setup

The Developer Platform now supports:

- A persistent local waitlist file at `platform-waitlist.json` under the auth data directory.
- Free-beta and `$2.99/month` early-access queue choices.
- Owner-only queue management from `/dev/platform`.
- Acceptance emails with the platform link.
- Resend-compatible email delivery.
- Optional early-access checkout links.

## Gate waitlist emails

The invite gate uses the same Resend sender. Once the environment variables below
are set on Render:

- Joining the gate waitlist (`/api/gate/waitlist`) sends a confirmation email.
- Accepting a gate waitlist entry or reissuing a key emails the access key to
  the user automatically; the key is still shown once to the owner as a
  fallback.
- Gate waitlist entries record `emailStatus` (`sent` / `failed` /
  `not_configured`), visible in the admin waitlist listing.

Without the variables the gate works exactly as before and delivery is marked
`not_configured` — no fake email provider is used.

## 1. Create a Resend account

1. Create an account at [Resend](https://resend.com/).
2. Add and verify the domain you want to send from.
3. Create an API key with permission to send email.
4. Use an address on the verified domain for `PLATFORM_EMAIL_FROM`, for example:

```text
Veyra <platform@example.com>
```

## 2. Configure Render

In the Veyra Server Render service, add these environment variables:

```text
RESEND_API_KEY=re_...
PLATFORM_EMAIL_FROM=Veyra <platform@example.com>
PLATFORM_URL=https://homekidchud.github.io/VeyraBrowser/dev/platform
```

The server intentionally does not fall back to a fake email provider. If these values are missing, the queue still works and the owner dashboard marks email delivery as `not_configured`.

## 3. Configure the $2.99 early-access checkout

Create a recurring subscription product in your payment provider:

- Product: `Veyra Early Access`
- Price: `$2.99 USD`
- Billing: monthly recurring

Create a hosted checkout/payment link and set:

```text
PLATFORM_EARLY_ACCESS_URL=https://your-payment-provider.example/checkout/...
```

Veyra will include that link only in acceptance emails for people who selected early access. Veyra does not collect card details in the application.

## 4. Accept users

1. Open `/dev/platform` as the owner/admin account.
2. Scroll to **Platform queue**.
3. Review the email, queue choice, and email status.
4. Click **Accept**.
5. The user receives an email containing the platform link. Early-access entries also receive the configured checkout link.

## 5. Persistence on Render Free

The local JSON file is suitable for development. Render Free filesystems are ephemeral, so configure `MONGODB_URI` for durable production waitlist storage before promoting the queue to real users. Do not put API keys or Resend secrets in Git.
