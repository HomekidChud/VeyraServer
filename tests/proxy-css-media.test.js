"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");

process.env.GATE_ENABLED = "false";
process.env.PROXY_PASSTHROUGH_BINARY = "true";
process.env.VEYRA_CHROMIUM_ENABLED = "false";
const { app, fetchBuffer, rewriteCssText, makeResourceUrl } = require("../src/server");
const origin = "https://93.184.216.34";
const sid = "cssmediafixturetest12345";

test("CSS imports and assets are rewritten once, preserving conditional imports", () => {
  const css = `@import url("./tablet.css") layer(layout) (width > 600px);
@import './phone.css' (width <= 600px);
.hero{background:url(../img/poster.png)} .icon{filter:url(#blur)}`;
  const base = origin + "/styles/main.css";
  const expected = path => makeResourceUrl(origin + path, base, sid);
  const output = rewriteCssText(css, base, sid);
  assert.ok(output.includes(`"${expected("/styles/tablet.css")}"`), output);
  assert.match(output, /layer\(layout\) \(width > 600px\)/);
  assert.ok(output.includes(`"${expected("/styles/phone.css")}" (width <= 600px)`));
  assert.ok(output.includes(`url("${expected("/img/poster.png")}")`));
  assert.match(output, /url\(#blur\)/);
  assert.doesNotMatch(output, /%2Fapi%2Fresource/);
});

test("Fast Proxy rewrites complete HLS playlists but passes byte ranges through unchanged", async () => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const urlFor = path => `http://127.0.0.1:${server.address().port}${makeResourceUrl(origin + path, "", sid)}`;
  const playlist = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,NAME="Main, stereo",URI="alt/audio.m3u8"',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="16@0"',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin?name=a,b"',
    '#EXT-X-SESSION-DATA:DATA-ID="example",VALUE="note,URI=https://keep.example/"',
    '# Private comment,URI="keep.mp4"',
    "#EXTINF:4,",
    "chunks/one.mp4",
    "#EXT-X-ENDLIST",
    ""
  ].join("\r\n");
  const observed = [];
  app.locals.veyraProxyFetchBuffer = (url, opts) => fetchBuffer(url, { ...opts, upstreamFetch: async (target, request) => {
    const path = new URL(target).pathname;
    observed.push({ path, range: request.headers.get("Range") });
    if (path === "/old/playlist") {
      return new Response(null, { status: 302, headers: { location: "/live/playlist" } });
    }
    if (path === "/live/playlist" || path === "/live/playlist.audio") {
      return new Response(playlist, { headers: { "content-type": path.endsWith(".audio") ? "audio/x-mpegurl" : "application/mpegurl; charset=utf-8" } });
    }
    assert.equal(path, "/live/chunks/one.mp4");
    assert.equal(request.headers.get("Range"), "bytes=2-5");
    return new Response(Buffer.from([2, 3, 4, 5]), { status: 206, headers: {
      "content-type": "video/mp4", "content-range": "bytes 2-5/8", "content-length": "4", "accept-ranges": "bytes"
    } });
  } });
  try {
    for (const [path, finalPath] of [["/old/playlist", "/live/playlist"], ["/live/playlist.audio", "/live/playlist.audio"]]) {
      const response = await fetch(urlFor(path));
      const result = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(result));
      const expected = suffix => makeResourceUrl(origin + suffix, origin + finalPath, sid);
      for (const leaf of ["alt/audio.m3u8", "init.mp4", "keys/key.bin?name=a,b"]) {
        assert.ok(result.includes(`URI="${expected("/live/" + leaf)}"`), result);
      }
      assert.ok(result.includes('#EXT-X-SESSION-DATA:DATA-ID="example",VALUE="note,URI=https://keep.example/"'));
      assert.ok(result.includes('# Private comment,URI="keep.mp4"'));
      assert.ok(result.split(/\r?\n/).includes(expected("/live/chunks/one.mp4")));
    }
    const segment = await fetch(urlFor("/live/chunks/one.mp4"), { headers: { range: "bytes=2-5" } });
    assert.equal(segment.status, 206);
    assert.equal(segment.headers.get("content-range"), "bytes 2-5/8");
    assert.equal(segment.headers.get("accept-ranges"), "bytes");
    assert.equal(segment.headers.get("cache-control"), "no-store");
    assert.deepEqual([...new Uint8Array(await segment.arrayBuffer())], [2, 3, 4, 5]);
    assert.ok(observed.some(req => req.path === "/old/playlist"));
  } finally {
    delete app.locals.veyraProxyFetchBuffer;
    await new Promise(resolve => server.close(resolve));
  }
});
