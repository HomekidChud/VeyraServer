"use strict";
/**
 * Admin panel + QR deep link + ad-based session renewal regression test — v8.19.0
 * Verifies (source-level + unit-level):
 *  1. QR payloads are HTTPS deep links to the frontend cast page (no veyra:// scheme)
 *  2. Admin debug endpoints exist and are admin-gated
 *  3. The renew flow genuinely extends the session (SessionManager.renew)
 *  4. YouTube ads normalise to a video ID and reject invalid input
 *  5. Session expiry clears renewal state
 *  6. The frontend wires the admin panel, renewal offer and device join
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

function ok(name, cond) { if (!cond) throw new Error(`FAIL ${name}`); console.log("PASS", name); }
const read = f => fs.readFileSync(path.join(__dirname, f), "utf8");
const server = read("server.js"), cast = read("cast-server.js"), renew = read("renewing-system.js"), sm = read("session-manager.js");
const app = read("../frontend/app.js"), adminJs = read("../frontend/admin.js"), renewJs = read("../frontend/renew.js"), castJs = read("../frontend/device-cast.js");

// --- 1. QR deep link -------------------------------------------------------
ok("cast server builds HTTPS QR deep links", cast.includes("buildQrPayload") && cast.includes("cast?session=") && !cast.includes("qrPayload = `veyra://"));
ok("server passes the frontend URL to the cast server", server.includes("{ frontendUrl: CFG.frontendUrl }"));
ok("/api/cast/create uses the shared QR builder", server.includes("qrPayload: castServer.buildQrPayload(session.id, session.pairingCode)"));

// --- 2. admin endpoints ----------------------------------------------------
for (const ep of ["/api/debug/jobs", "/api/debug/requests", "/api/debug/logs"]) {
  ok(`admin endpoint ${ep} exists and is gated`, new RegExp(`app.get\\("${ep.replace(/\?/g, "\\\\?")}"?, requireAdmin`).test(server));
}
ok("admin panel route exists", server.includes('"/api/debug/system", requireAdmin'));

// --- 3. session renewal ----------------------------------------------------
ok("SessionManager has renew()", sm.includes("renew(sid, ms)") && sm.includes("rec.renewedMs"));
ok("renewedMs extends every expiry computation", sm.split("rec.renewedMs || 0)").length >= 4);
ok("renew/complete extends the session", server.includes("sessionManager.renew(sid, result.rewardMs)"));
ok("session expiry clears renewal state", server.includes("renewingManager?.clearSession(sid)"));

// --- 4. ads ----------------------------------------------------------------
ok("youtube ad type supported", renew.includes('"youtube"') && renew.includes("extractYoutubeId"));
{ // unit: extractYoutubeId behaviour via the manager
  const { RenewingManager } = require("./renewing-system");
  const m = new RenewingManager();
  const ad = m.addAd({ title: "YT", type: "youtube", url: "https://youtu.be/dQw4w9WgXcQ?t=1", durationSec: 5, rewardMs: 60000 });
  ok("youtu.be URL normalised to video ID", ad.youtubeId === "dQw4w9WgXcQ");
  assert.throws(() => m.addAd({ title: "Bad", type: "youtube", url: "nope" }), /YouTube ad needs/);
  ok("invalid youtube input rejected", true);
  const watch = m.watchAd(ad.id, "sess1234");
  ok("watch returns the youtube ID to the client", watch.ad.youtubeId === "dQw4w9WgXcQ");
  m.getWatch(watch.watchId);
  ok("getWatch exposes the watch for reward granting", m.getWatch(watch.watchId).sessionId === "sess1234");
}
{ // unit: SessionManager.renew genuinely extends the deadline
  const { SessionManager } = require("./session-manager");
  let now = 0;
  const mgr = new SessionManager({ timeLimitMs: 60000, hardTtlMs: 24 * 3600000, now: () => now });
  const rec = mgr.create("a".repeat(32));
  now = 50000; // 10 s left
  assert.strictEqual(mgr.remainingMs(rec), 10000);
  const r = mgr.renew("a".repeat(32), 120000);
  ok("renew reports the new remaining time", r.renewed === true && r.remainingMs >= 120000);
  ok("renew extends the limit check", mgr.checkLimit("a".repeat(32)) === false);
  now = 170000; // past the original limit, inside the renewed window
  ok("session survives past its original deadline", mgr.checkLimit("a".repeat(32)) === false);
  now = 200000; // past renewed window too
  ok("session still expires eventually", mgr.checkLimit("a".repeat(32)) === true);
}

// --- 5. frontend wiring ----------------------------------------------------
ok("admin panel module exists", fs.existsSync(path.join(__dirname, "../frontend/admin.js")));
ok("admin route registered", app.includes('admin: "admin"') && app.includes('admin: () => renderAdmin'));
ok("admin view section in index.html", read("../frontend/index.html").includes('id="view-admin"'));
ok("admin menu item for admins", read("../frontend/ui.js").includes('"Admin panel"'));
ok("renewal module exists", fs.existsSync(path.join(__dirname, "../frontend/renew.js")));
ok("renewal offer hooks into the session ticker", app.includes("maybeOfferRenew(s, left)"));
ok("session renewed hook updates live expiry", app.includes("hooks.onSessionRenewed"));
ok("session popover has watch-ad button", read("../frontend/ui.js").includes('id="popRenew"'));
ok("device join view for QR deep links", castJs.includes("renderDeviceJoinView") && castJs.includes('joinParams.get("session")'));
ok("device streams frames over the cast socket", castJs.includes('type: "frame"'));
ok("404 fallback handles /admin and /cast deep links", read("../frontend/404.html").includes("admin|console") && read("../frontend/404.html").includes("cast|internet"));

// --- 6. real QR encoder ----------------------------------------------------
ok("self-contained QR encoder exists", fs.existsSync(path.join(__dirname, "../frontend/qr.js")));
{ // unit: the QR matrix structure follows the QR spec
  const qr = require("../frontend/qr.js");
  const m = qr.qrMatrix("https://homekidchud.github.io/VeyraBrowser/cast?session=cast_902e034678dd&code=103008");
  ok("QR matrix is 37x37 (version 5) for a deep link", m.length === 37 && m[0].length === 37);
  const finder = (x, y) => {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      const dark = dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      if (m[y + dy][x + dx] !== (dark ? 1 : 0)) return false;
    }
    return true;
  };
  ok("QR finder patterns present in all three corners", finder(0, 0) && finder(30, 0) && finder(0, 30));
  ok("QR SVG output is a real drawing", qr.qrSvg("test", 100).includes("<svg") && qr.qrSvg("test", 100).includes("<rect"));
  assert.throws(() => qr.qrMatrix("y".repeat(300)), /too long/);
  ok("oversized QR payloads rejected cleanly", true);
}
ok("cast view uses the real QR encoder", castJs.includes("qrSvg(castSession.qrPayload") && !castJs.includes("qrCodeUrl") && !castJs.includes("api.qrserver.com"));
ok("no fake hash-pattern QR left", !castJs.includes("generateQRMatrix"));

console.log("\nAdmin + renewal + QR regression checks passed.");
