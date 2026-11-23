const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { createServer } = require('node:http');
const { MEDIA_TYPE, framePreset, framePacer, frameRecord, serveFrames } = require('../src/browser/frame-stream');
const { BrowserEngine } = require('../src/browser/browser-engine');

test('frame packets and bitrate reject malformed presets, byte bursts, and queued writes', () => {
  const wire = frameRecord(Buffer.from([1, 2, 3]));
  assert.equal(wire.readUInt32BE(0), 3);
  assert.deepEqual([...wire.subarray(4)], [1, 2, 3]);
  assert.equal(framePreset('__proto__'), framePreset('adaptive'));
  assert.ok(framePreset('sharp').width > framePreset('responsive').width);
  let clock = 0;
  const permit = framePacer(framePreset('responsive'), () => clock);
  assert.equal(permit(760_000), true);
  assert.equal(permit(1), false);
  clock = 40;
  assert.equal(permit(24_000, true), false);
  assert.equal(permit(100_000), false);
  clock = 1000;
  assert.equal(permit(100_000), true);
});

test('stream accepts the first frame during CDP startup and releases a per-session lease', async () => {
  const bytes = Buffer.from([255, 216, 255, 217]);
  const cdp = new EventEmitter();
  const page = new EventEmitter(), res = new EventEmitter();
  const calls = [], writes = [];
  cdp.send = async (command, params) => {
    calls.push([command, params]);
    if (command.endsWith('startScreencast')) cdp.emit('Page.screencastFrame', { sessionId: 23, data: bytes.toString('base64') });
  };
  cdp.detach = async () => calls.push(['detach']);
  page.context = () => ({ newCDPSession: async () => cdp });
  res.set = () => {};
  res.flushHeaders = () => { res.headersSent = true; };
  res.write = buffer => { writes.push(buffer); return true; };
  res.end = () => { res.writableEnded = true; };
  const session = { page };
  const streaming = serveFrames(res, session, framePreset('adaptive'), () => {});
  await assert.rejects(serveFrames(res, session, framePreset('sharp'), () => {}), { code: 'FRAME_STREAM_BUSY' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.frameLease.active, true);
  assert.equal(writes[0].readUInt32BE(), 0);
  assert.deepEqual(writes[1].subarray(4), bytes);
  assert.deepEqual(calls.find(([name]) => name.endsWith('Ack'))[1], { sessionId: 23 });
  res.emit('close');
  await streaming;
  assert.equal(session.frameLease, null);
  assert.equal(cdp.listenerCount('Page.screencastFrame'), 0);
  assert.ok(calls.some(([name]) => name === 'detach'));
});

test('live input returns without a screenshot; metadata and verification are checked independently', async () => {
  const browser = new BrowserEngine({}, async () => {});
  const pressed = [];
  const page = { url: () => 'https://example.org', title: async () => 'New page', keyboard: { press: async key => pressed.push(key) } };
  const session = { id: 'live', page, status: 'NORMAL', frameLease: { active: true } };
  browser.sessions.set('live', session);
  browser.capture = async () => assert.fail('live input must not request a screenshot');
  browser.detectVerification = async () => ({ title: 'Verification' });
  const input = await browser.input('live', { type: 'key', key: 'ArrowLeft' }, { interactive: true });
  assert.equal(input.status, 'NORMAL');
  assert.deepEqual(pressed, ['ArrowLeft']);
  assert.equal(session.checkAfterInput, true);
  await browser.refreshInteractive(session);
  assert.equal(session.status, 'VERIFICATION_REQUIRED');
});

test('real Chromium delivers multiple JPEGs without screenshot polling', { skip: !process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE, timeout: 15000 }, async () => {
  const { chromium } = require('playwright');
  const engine = await chromium.launch({ executablePath: process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
  const context = await engine.newContext({ viewport: { width: 1365, height: 820 } });
  const page = await context.newPage();
  await page.setContent('<style>div{width:400px;height:300px;background:#00f;animation:m .5s infinite alternate linear}@keyframes m{to{transform:translateX(700px);background:#f00}}</style><div></div>');
  const session = { page };
  const server = createServer((_req, res) => {
    res.set = headers => Object.entries(headers).forEach(([name, value]) => res.setHeader(name, value));
    serveFrames(res, session, framePreset('sharp'), () => {}).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const ctl = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: ctl.signal });
    assert.equal(response.headers.get('content-type'), MEDIA_TYPE);
    let stash = Buffer.alloc(0);
    const frames = [];
    const start = performance.now();
    const reader = response.body.getReader();
    for (let waiting = true; waiting;) {
      const { value, done } = await reader.read();
      if (done) break;
      stash = Buffer.concat([stash, Buffer.from(value)]);
      while (stash.length >= 4) {
        const size = stash.readUInt32BE();
        if (stash.length < size + 4) break;
        if (size) {
          assert.equal(stash.readUInt16BE(4), 0xffd8);
          frames.push(performance.now() - start);
        }
        stash = stash.subarray(4 + size);
      }
      waiting = frames.length < 20;
    }
    assert.ok(frames.length >= 20);
    assert.ok(frames.at(-1) < 2500, `20 frames must arrive without the old status polling path (${Math.round(frames.at(-1))} ms)`);
    console.log(`Controlled local Chromium test: ${frames.length} JPEG frames received in ${Math.round(frames.at(-1))} ms.`);
  } finally {
    ctl.abort();
    server.closeAllConnections();
    server.close();
    await engine.close();
  }
});
