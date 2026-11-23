"use strict";
/**
 * Regression — the fast proxy must load security-verification pages fully
 * instead of replacing them with the interstitial card.
 *
 * Pre-fix, /api/view detected any challenge (Cloudflare-style "Just a
 * moment…", bot-verification splash pages) and swapped the page for the
 * "This site requires its own security verification" card. Sites whose own
 * check passes and redirects (poxel.io-style) never got to run: the user saw
 * the card, the redirect never happened, and network capture for the tab
 * went quiet.
 *
 * Post-fix, only Google's captcha wall (unusual-traffic — which can never be
 * completed through a proxy) keeps the card; every other challenge page is
 * served through the fast proxy as-is, so the site's own check runs, its
 * redirect is followed, and the site loads fully.
 *
 * Also pins the injected runtime's sign-in handoff: a click on a detected
 * sign-in control must post veyra:signin to the app (which opens the real
 * sign-in in the user's browser) — and the listener must be registered
 * before the generic anchor handler so the handoff wins the click.
 */
const assert = require("node:assert/strict");

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";

const { app, injectRuntime } = require("../src/server");

// A Cloudflare-style verification page: title match + 403 + challenge signals.
function securityVerificationHtml() {
  return `<!doctype html><html><head><title>Just a moment...</title></head>
<body><h1>Checking your browser before accessing the site.</h1>
<p>Please stand by, verifying you are human. This process is automatic. captcha check.</p>
<script>setTimeout(function(){location.href='/'},100)</script>
</body></html>`;
}

// Google's captcha wall — the one challenge that keeps the interstitial card.
function unusualTrafficHtml() {
  return `<!doctype html><html><head><title>Sorry...</title></head>
<body><h1>Our systems have detected unusual traffic from your computer network.</h1></body></html>`;
}

(async () => {
  // ---------- injected runtime: the sign-in handoff ----------
  const out = injectRuntime('<html><head></head><body><a href="/login">Sign in</a></body></html>', "https://example.com/page", "sess-signin-test");
  const runtime = out.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(runtime, "the runtime script must be injected");
  // Must parse as valid JavaScript.
  new Function(runtime);
  // Sign-in markers: location.assign/replace still posts veyra:signin
  // (loaded in-tab through the fast proxy), and the auth host/path
  // patterns still feed isSigninRedirect.
  assert.match(runtime, /type:'veyra:signin'/, "a JS sign-in redirect must post veyra:signin to the app");
  assert.match(runtime, /SIGNIN_AUTH_HOST/, "auth-provider hosts must be detected");
  assert.match(runtime, /SIGNIN_AUTH_PATH/, "login/oauth paths must be detected");
  // The CLICK interception must be gone: it used to preventDefault sign-in
  // controls (including form submit buttons like GitHub's "Continue with
  // Google"), killing the natural navigation and reloading the login page.
  // Regression: no capture-phase click listener posts veyra:signin.
  assert.doesNotMatch(runtime, /signinControl/, "the sign-in click interceptor must be removed");
  assert.doesNotMatch(runtime, /document\.addEventListener\('click'[^)]*\),true\)/, "no capture-phase click interceptor may remain");

  // ---------- /api/view: security-verification passes through ----------
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const retired = await fetch(`${base}/api/challenge/solve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    assert.equal(retired.status, 410, "the legacy automatic solver must stay disabled");
    const status = await (await fetch(`${base}/api/challenge/status`)).json();
    assert.equal(status.status, "disabled");
    assert.equal(status.detectionEnabled, true);
    const diagnostic = await (await fetch(`${base}/api/challenge/check?statusCode=403&html=${encodeURIComponent("Checking your browser · Cloudflare")}`)).json();
    assert.deepEqual(diagnostic, { isChallenge: true, type: "cloudflare" });

    app.locals.veyraProxyFetchBuffer = async () => ({
      ok: true, status: 403, contentType: "text/html; charset=utf-8",
      body: Buffer.from(securityVerificationHtml(), "utf8"),
      finalUrl: "https://example.com/", cacheControl: "no-store",
    });
    let r = await fetch(`${base}/api/view?url=${encodeURIComponent("https://example.com/")}&sid=challengetestsid00000000001`);
    let html = await r.text();
    // The pass-through mirrors the upstream status (403 here), exactly like
    // any other upstream error page served through the proxy.
    assert.equal(r.status, 403, "the pass-through must mirror the upstream status");
    assert.ok(!html.includes("This site requires its own security verification"),
      "a security-verification page must NOT be replaced by the interstitial card");
    assert.ok(html.includes("Checking your browser"), "the challenge page's own content must be served");
    assert.ok(html.includes("data-veyra-runtime"), "the passed-through page must still get the Veyra runtime");
    assert.equal(String(r.headers.get("x-veyra-challenge") || ""), "security-verification",
      "the pass-through must still report the detected challenge type");

    // ---------- /api/view: Google's captcha wall keeps the card ----------
    app.locals.veyraProxyFetchBuffer = async () => ({
      ok: true, status: 429, contentType: "text/html; charset=utf-8",
      body: Buffer.from(unusualTrafficHtml(), "utf8"),
      finalUrl: "https://www.google.com/sorry/index?continue=/search%3Fq%3Dtest", cacheControl: "no-store",
    });
    r = await fetch(`${base}/api/view?url=${encodeURIComponent("https://www.google.com/search?q=test")}&sid=challengetestsid00000000001`);
    html = await r.text();
    assert.ok(html.includes("Google is asking for a captcha"),
      "Google's captcha wall must keep the interstitial card (it cannot be completed through a proxy)");
    assert.equal(String(r.headers.get("x-veyra-challenge") || ""), "true",
      "the Google card must still be flagged as a challenge");
    assert.match(html, /Search with Veyra/);
    assert.match(html, /"type":"veyra:google-search-fallback","query":"test","sessionId":"challengetestsid00000000001"/);

    const content = "<!doctype html><title>Google</title><form action='/search'><input name='q'><button>Google Search</button></form>";
    app.locals.veyraProxyFetchBuffer = async url => ({
      ok: true, status: 200, contentType: "text/html; charset=utf-8", finalUrl: url, cacheControl: "no-store",
      body: Buffer.from(url.includes("/search?") ? '<title>Google Search</title><a href="/httpservice/retry/enablejs?sei=fixture">click here</a>' : content),
    });
    const view = url => fetch(`${base}/api/view?url=${encodeURIComponent(url)}&sid=challengetestsid00000000001`);
    r = await view("https://www.google.com/");
    assert.match(await r.text(), /Google Search<\/button>/);
    assert.equal(r.headers.get("x-veyra-challenge"), null);
    r = await view("https://www.google.com/search?q=example");
    assert.equal(r.headers.get("x-veyra-challenge"), "google-search-interstitial");
    assert.match(await r.text(), /Google did not return a results page/);
    r = await view("https://example.com/search?q=example");
    assert.equal(r.headers.get("x-veyra-challenge"), null);
    assert.doesNotMatch(await r.text(), /Search with Veyra/);
  } finally {
    app.locals.veyraProxyFetchBuffer = null;
    await new Promise(resolve => server.close(resolve));
  }
  console.log("Challenge pass-through + sign-in handoff regression tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
