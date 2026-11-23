# Veyra Access Gate (8.21.0)

The whole service is invite-only. Anyone without a valid gate session sees the
waitlist screen (browsers) or a `403 GATE_REQUIRED` JSON error (API callers).
Only `/health`, the gate screen, and the gate's own endpoints stay public.

## How people get in

1. **Rotating invite links** — `https://<server>/gate/<random-token>`.
   The token is a fresh random string that rotates every 10 minutes
   (`GATE_ROTATE_MS`). Previously shared links keep working for a grace
   window (20 min, `GATE_GRACE_MS`) so active invites don't break mid-share.
   After rotation the link is gone — the site cannot be reached from an old
   link. Fetch the current link as the owner:

   ```bash
   curl -H "x-veyra-admin-token: $VEYRA_ADMIN_TOKEN" \
     https://veyraserver-xscy.onrender.com/api/gate/admin/link
   # POST /api/gate/admin/rotate to force a new link immediately
   ```

2. **Waitlist + acceptance** — visitors join from the waitlist screen
   (`POST /api/gate/waitlist`). An admin accepts them:

   ```bash
   curl -H "x-veyra-admin-token: $VEYRA_ADMIN_TOKEN" \
     https://veyraserver-xscy.onrender.com/api/gate/admin/waitlist
   curl -X POST -H "x-veyra-admin-token: $VEYRA_ADMIN_TOKEN" \
     https://veyraserver-xscy.onrender.com/api/gate/admin/waitlist/<id>/accept
   # -> { "accessKey": "VY-..." }  (shown exactly once — share privately)
   ```

   The user enters that key on the waitlist screen and is unlocked for
   30 days (`GATE_SESSION_TTL_MS`). Keys are stored hashed; reissue with
   `/api/gate/admin/waitlist/<id>/reissue-key`.

3. **Owner tokens** — `GATE_OWNER_TOKENS=token1,token2` are personal,
   never-rotating entry links (`/gate/<token>`).

The admin token (`x-veyra-admin-token`) always bypasses the gate.

## Gate sessions

A gate session is a random bearer token. It is set as an httpOnly cookie AND
returned in the JSON body; the static frontend stores it and sends it on every
API request as the `X-Veyra-Gate` header. Sessions expire after the TTL and are
persisted to `data/gate.json` (mirrored to MongoDB when `MONGODB_URI` is set).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GATE_ENABLED` | `true` in production | Master switch |
| `GATE_ROTATE_MS` | `600000` | Invite link rotation interval |
| `GATE_GRACE_MS` | `1200000` | How long old links stay valid |
| `GATE_SESSION_TTL_MS` | `2592000000` | Unlocked-device lifetime (30 d) |
| `GATE_WAITLIST_OPEN` | `true` | Allow new waitlist signups |
| `GATE_OWNER_TOKENS` | — | Comma-separated permanent owner tokens |
| `GATE_MAX_SESSIONS` | `20000` | Session cap |
| `GATE_MAX_WAITLIST` | `100000` | Waitlist cap |

## Tests

`node tests/gate.test.js` covers rotation/grace, waitlist accept/reject,
one-time keys, session verify/revoke, and an end-to-end pass against the live
express app (blocked screen, JSON 403, invite link flow, key unlock).
