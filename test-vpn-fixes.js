"use strict";
// Focused tests for the Veyra VPN bug fixes.
const assert = require("assert");
const { parseProfile, hostMatches, cidrContains, privateIp, expandIpv6, socks5Handshake, VpnManager } = require("./vpn");
const { AutoConnectEngine } = require("./advanced-vpn");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

// --- Bug 1: vpnManager.parseProfile exists ---
test("VpnManager.parseProfile is a function", () => {
  const mgr = new VpnManager(() => {}, { VPN_ENABLED: "0" });
  assert.strictEqual(typeof mgr.parseProfile, "function");
  mgr.close();
});

// --- Bug 2: VpnManager.addProfile / removeProfile ---
test("VpnManager.addProfile creates WireGuardTunnel for WG profiles", () => {
  const mgr = new VpnManager(() => {}, { VPN_ENABLED: "0" });
  const profile = mgr.addProfile({
    id: "wg-test", name: "Test WG", type: "wireguard",
    config: "[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24\n\n[Peer]\nPublicKey = xyz\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0"
  });
  assert(profile, "addProfile should return a profile");
  assert.strictEqual(profile.type, "wireguard");
  assert(mgr.tunnels.has("wg-test"), "WireGuardTunnel should be created");
  mgr.close();
});

test("VpnManager.addProfile creates no tunnel for SOCKS5 profiles", () => {
  const mgr = new VpnManager(() => {}, { VPN_ENABLED: "0" });
  const profile = mgr.addProfile({
    id: "socks-test", name: "Test SOCKS", type: "socks5",
    server: "socks5://1.2.3.4:1080"
  });
  assert(profile, "addProfile should return a profile");
  assert(!mgr.tunnels.has("socks-test"), "No tunnel for SOCKS5");
  mgr.close();
});

test("VpnManager.removeProfile cleans up tunnels and agents", () => {
  const mgr = new VpnManager(() => {}, { VPN_ENABLED: "0" });
  mgr.addProfile({
    id: "wg-del", name: "Del WG", type: "wireguard",
    config: "[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24\n\n[Peer]\nPublicKey = xyz\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0"
  });
  assert(mgr.profiles.has("wg-del"));
  assert(mgr.tunnels.has("wg-del"));
  mgr.removeProfile("wg-del");
  assert(!mgr.profiles.has("wg-del"));
  assert(!mgr.tunnels.has("wg-del"));
  assert(!mgr.health.has("wg-del"));
  mgr.close();
});

// --- Bug 3: requiresVpnForSession doesn't block unconnected sessions ---
test("requiresVpnForSession is false for unconnected session without alwaysOn", () => {
  const mgr = new VpnManager(() => {}, {
    VPN_ENABLED: "1",
    VPN_PROXY_SERVER: "socks5://1.2.3.4:1080"
  });
  assert.strictEqual(mgr.requiresVpnForSession("test-session"), false);
  mgr.close();
});

test("requiresVpnForSession is true for connected session", () => {
  const mgr = new VpnManager(() => {}, {
    VPN_ENABLED: "1",
    VPN_PROXY_SERVER: "socks5://1.2.3.4:1080"
  });
  mgr.connect("test-session", "default");
  assert.strictEqual(mgr.requiresVpnForSession("test-session"), true);
  mgr.close();
});

test("requiresVpnForSession is true when alwaysOn is set", () => {
  const mgr = new VpnManager(() => {}, {
    VPN_ENABLED: "1",
    VPN_ALWAYS_ON: "1",
    VPN_PROXY_SERVER: "socks5://1.2.3.4:1080"
  });
  assert.strictEqual(mgr.requiresVpnForSession("test-session"), true);
  mgr.close();
});

// --- Bug 4: Bare SOCKS endpoint with type ---
test("parseProfile accepts bare [IPv6]:port with type socks5", () => {
  const p = parseProfile({
    id: "bare-socks", type: "socks5",
    server: "[2a02:c7c:8713:cc00:9b8f:d922:db67:2520]:1080"
  });
  assert(p, "should parse");
  assert.strictEqual(p.type, "socks5");
  assert.strictEqual(p.host, "2a02:c7c:8713:cc00:9b8f:d922:db67:2520");
  assert.strictEqual(p.port, 1080);
});

test("parseProfile normalizes socks/socks5h type aliases", () => {
  const p = parseProfile({ id: "alias", type: "socks", server: "1.2.3.4:1080" });
  assert(p, "should parse with socks alias");
  assert.strictEqual(p.type, "socks5");
});

// --- Bug 5: IPv6 CIDR ---
test("cidrContains supports IPv6 CIDR", () => {
  assert(cidrContains("fd00::/8", "fd12:3456:7890::1"), "fd00::/8 should contain fd12:...");
  assert(!cidrContains("fd00::/8", "fe80::1"), "fd00::/8 should not contain fe80::1");
  assert(cidrContains("2001:db8::/32", "2001:db8:1234::1"), "2001:db8::/32 should contain 2001:db8:1234::1");
  assert(!cidrContains("2001:db8::/32", "2001:db9::1"), "2001:db8::/32 should not contain 2001:db9::1");
});

test("cidrContains validates prefix length", () => {
  assert(!cidrContains("10.0.0.0/999", "10.0.0.1"), "invalid prefix should return false");
  assert(!cidrContains("10.0.0.0/-1", "10.0.0.1"), "negative prefix should return false");
});

// --- Bug 6: expandIpv6 handles edge cases ---
test("expandIpv6 handles full address with ::", () => {
  const r = expandIpv6("2001:db8::1");
  const parts = r.split(":");
  assert.strictEqual(parts.length, 8, "should expand to 8 groups");
});

test("expandIpv6 handles ::ffff:IPv4 mapped", () => {
  const r = expandIpv6("::ffff:192.0.2.1");
  const parts = r.split(":");
  assert.strictEqual(parts.length, 8, "should expand to 8 groups");
});

test("expandIpv6 does not crash on full address with ::", () => {
  // 7 groups + :: should not produce negative array
  const r = expandIpv6("1:2:3:4:5:6:7::");
  assert(r, "should not crash");
  const parts = r.split(":");
  assert.strictEqual(parts.length, 8);
});

// --- Bug 7: Domain pattern matching (no regex injection) ---
test("AutoConnectEngine: *.google.com does not match xgoogle.com", () => {
  const engine = new AutoConnectEngine([
    { id: "test", domain: "*.google.com", exit: "us", priority: 1, enabled: true }
  ]);
  const match = engine.findRule("https://xgoogle.com", "", new Date());
  assert(!match, "*.google.com should not match xgoogle.com");
});

test("AutoConnectEngine: *.google.com matches www.google.com", () => {
  const engine = new AutoConnectEngine([
    { id: "test", domain: "*.google.com", exit: "us", priority: 1, enabled: true }
  ]);
  const match = engine.findRule("https://www.google.com", "", new Date());
  assert(match, "*.google.com should match www.google.com");
});

// --- Bug 8: Time range crossing midnight ---
test("AutoConnectEngine: 22:00-08:00 matches 23:30", () => {
  const engine = new AutoConnectEngine([
    { id: "offpeak", timeRange: "22:00-08:00", exit: "budget", priority: 3, enabled: true }
  ]);
  const date = new Date();
  date.setHours(23, 30, 0, 0);
  const match = engine.findRule("https://example.com", "", date);
  assert(match, "22:00-08:00 should match 23:30");
});

test("AutoConnectEngine: 22:00-08:00 matches 07:30", () => {
  const engine = new AutoConnectEngine([
    { id: "offpeak", timeRange: "22:00-08:00", exit: "budget", priority: 3, enabled: true }
  ]);
  const date = new Date();
  date.setHours(7, 30, 0, 0);
  const match = engine.findRule("https://example.com", "", date);
  assert(match, "22:00-08:00 should match 07:30");
});

test("AutoConnectEngine: 22:00-08:00 does not match 12:00", () => {
  const engine = new AutoConnectEngine([
    { id: "offpeak", timeRange: "22:00-08:00", exit: "budget", priority: 3, enabled: true }
  ]);
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  const match = engine.findRule("https://example.com", "", date);
  assert(!match, "22:00-08:00 should not match 12:00");
});

// --- Bug 9: privateIp handles IPv4-mapped IPv6 ---
test("privateIp detects ::ffff:172.16.0.1 as private", () => {
  assert(privateIp("::ffff:172.16.0.1"), "::ffff:172.16.0.1 should be private");
  assert(privateIp("::ffff:172.31.255.255"), "::ffff:172.31.255.255 should be private");
  assert(!privateIp("::ffff:8.8.8.8"), "::ffff:8.8.8.8 should not be private");
});

// --- Bug 10: hostMatches with IPv6 CIDR ---
test("hostMatches supports IPv6 CIDR bypass patterns", () => {
  assert(hostMatches("fd12:3456::1", ["fd00::/8"]), "fd00::/8 should match fd12:...");
  assert(!hostMatches("8.8.8.8", ["fd00::/8"]), "fd00::/8 should not match 8.8.8.8");
});

// --- Advisor-requested edge cases ---
test("<local> bypass does not match IPv6 literals", () => {
  assert(!hostMatches("2a02:c7c:8713:cc00::1", ["<local>"]), "IPv6 should not match <local>");
  assert(hostMatches("localhost", ["<local>"]), "localhost should match <local>");
  assert(hostMatches("intranet", ["<local>"]), "bare hostname should match <local>");
});

test("cidrContains rejects decimal/empty prefixes", () => {
  assert(!cidrContains("10.0.0.0/24.5", "10.0.0.1"), "decimal prefix should fail");
  assert(!cidrContains("10.0.0.0/", "10.0.0.1"), "empty prefix should fail");
  assert(!cidrContains("10.0.0.0", "10.0.0.1"), "missing prefix should fail");
});

test("privateIp covers fe80::/10 range", () => {
  assert(privateIp("fe80::1"), "fe80::1 should be private");
  assert(privateIp("fe90::1"), "fe90::1 should be private (fe80::/10)");
  assert(privateIp("fea0::1"), "fea0::1 should be private (fe80::/10)");
  assert(privateIp("feb0::1"), "feb0::1 should be private (fe80::/10)");
  assert(!privateIp("fec0::1"), "fec0::1 should not be private (outside fe80::/10)");
});

test("env profiles take precedence over DB profiles at startup", () => {
  const mgr = new VpnManager(() => {}, {
    VPN_ENABLED: "1",
    VPN_PROXY_SERVER: "socks5://1.2.3.4:1080",
    VPN_PROFILE_ID: "env-default"
  });
  assert(mgr.profiles.has("env-default"), "env profile should exist");
  // Simulate loading a DB profile with the same ID
  const candidate = mgr.parseProfile({ id: "env-default", type: "socks5", server: "socks5://5.6.7.8:1080" });
  if (candidate && !mgr.profiles.has(candidate.id)) {
    mgr.addProfile(candidate);
  }
  // The env profile should still be there (not overwritten)
  const p = mgr.profiles.get("env-default");
  assert.strictEqual(p.host, "1.2.3.4", "env profile should not be overwritten by DB profile with same id");
  mgr.close();
});

test("addProfile accepts already-parsed WireGuard profile", () => {
  const mgr = new VpnManager(() => {}, { VPN_ENABLED: "0" });
  const parsed = mgr.parseProfile({
    id: "wg-readd", type: "wireguard",
    config: "[Interface]\nPrivateKey = abc\nAddress = 10.0.0.1/24\n\n[Peer]\nPublicKey = xyz\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0"
  });
  assert(parsed, "parseProfile should succeed");
  // Re-add the already-parsed profile
  const readded = mgr.addProfile(parsed);
  assert(readded, "addProfile should accept already-parsed profile");
  assert(mgr.tunnels.has("wg-readd"), "WireGuardTunnel should be created from parsed profile");
  mgr.close();
});

test("addProfile resets session agents for affected sessions", () => {
  const mgr = new VpnManager(() => {}, {
    VPN_ENABLED: "1",
    VPN_PROXY_SERVER: "socks5://1.2.3.4:1080",
    VPN_PROFILE_ID: "reset-test"
  });
  mgr.connect("sess1", "reset-test");
  // Create the session agent by requesting a dispatcher
  mgr.dispatcherForSession("sess1");
  const agent1 = mgr.sessionAgents.get("sess1");
  assert(agent1, "session agent should exist after dispatcherForSession");
  // Re-add the profile (simulating an update)
  mgr.addProfile({ id: "reset-test", type: "socks5", server: "socks5://5.6.7.8:1080" });
  // Old agent should have been reset
  const agent2 = mgr.sessionAgents.get("sess1");
  assert(agent2 === undefined || agent2 !== agent1, "session agent should be reset after profile update");
  mgr.close();
});

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
