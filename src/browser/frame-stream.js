const { performance } = require('node:perf_hooks');

const MEDIA_TYPE = 'application/vnd.veyra.jpeg-stream';
const MAX_FRAME_BYTES = 768 * 1024;
const PRESETS = Object.freeze({
  adaptive: { width: 1280, height: 768, quality: 74, fps: 30, bytesPerSecond: 650_000 },
  responsive: { width: 960, height: 578, quality: 66, fps: 30, bytesPerSecond: 360_000 },
  sharp: { width: 1365, height: 820, quality: 85, fps: 30, bytesPerSecond: 950_000 }
});

function framePreset(name) { return Object.hasOwn(PRESETS, name) ? PRESETS[name] : PRESETS.adaptive; }

// The wire format is a 4-byte big-endian size followed by a JPEG. A zero
// size is a keepalive so static pages don't have to encode duplicate frames.
function frameRecord(bytes) {
  const record = Buffer.allocUnsafe(4 + bytes.length);
  record.writeUInt32BE(bytes.length, 0);
  bytes.copy(record, 4);
  return record;
}

function framePacer(preset, clock = () => performance.now()) {
  let last = clock(), next = last;
  const burst = MAX_FRAME_BYTES;
  let credit = burst;
  return (size, blocked = false) => {
    const now = clock();
    credit = Math.min(burst, credit + Math.max(0, now - last) * preset.bytesPerSecond / 1000);
    last = now;
    if (blocked || size <= 0 || size > MAX_FRAME_BYTES || now < next || credit < size) return false;
    credit -= size;
    // Small allowance for event-loop jitter; don't queue old images.
    next = now + 1000 / preset.fps - 2;
    return true;
  };
}

async function serveFrames(res, session, preset, checkLive) {
  if (session.frameLease) throw Object.assign(new Error('A frame stream is already attached.'), { status: 409, code: 'FRAME_STREAM_BUSY' });
  const lease = {};
  session.frameLease = lease;
  const page = session.page;
  let cdp, pulse, started = false, subscribed = false, done = false, sentFrame = false, blockedAt = 0, first;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const stop = () => { done = true; lease.active = false; finish(); };
  const permit = framePacer(preset);
  const send = buffer => {
    if (done || res.destroyed || res.writableEnded) return;
    if (!res.write(buffer)) blockedAt ||= performance.now();
  };
  const drain = () => { blockedAt = 0; };
  const writeFrame = data => {
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) return;
    const bytes = Buffer.from(data, 'base64');
    if (!permit(bytes.length, !!blockedAt || res.writableNeedDrain)) return;
    sentFrame = true;
    send(frameRecord(bytes));
  };
  const frame = ({ data, sessionId }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(stop);
    if (done || session.page !== page) return;
    if (!subscribed) { first = data; return; }
    writeFrame(data);
  };
  res.once('close', stop);
  res.on('drain', drain);
  try {
    cdp = await page.context().newCDPSession(page);
    if (done || res.destroyed) return;
    checkLive();
    cdp.on('Page.screencastFrame', frame);
    page.once('close', stop);
    started = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: preset.quality, maxWidth: preset.width, maxHeight: preset.height, everyNthFrame: 1 });
    if (done || res.destroyed) return;
    checkLive();
    res.set({
      'Content-Type': MEDIA_TYPE,
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    res.flushHeaders();
    subscribed = true;
    lease.active = true;
    send(Buffer.alloc(4));
    if (first) writeFrame(first);
    first = null;
    const began = performance.now();
    pulse = setInterval(() => {
      try {
        checkLive();
        if (session.page !== page || (!sentFrame && performance.now() - began > 4500)) return stop();
        if (blockedAt) {
          if (performance.now() - blockedAt > 3000) { res.destroy(); stop(); }
          return;
        }
        send(Buffer.alloc(4));
      } catch { stop(); }
    }, 1500);
    pulse.unref?.();
    await finished;
  } finally {
    stop();
    clearInterval(pulse);
    res.off('close', stop);
    res.off('drain', drain);
    page.off('close', stop);
    if (res.headersSent && !res.destroyed) res.end();
    if (cdp) {
      cdp.off('Page.screencastFrame', frame);
      // Detaching the dedicated CDP session stops capture, including on error.
      if (started) void cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    if (session.frameLease === lease) session.frameLease = null;
  }
}

module.exports = { MEDIA_TYPE, MAX_FRAME_BYTES, framePreset, frameRecord, framePacer, serveFrames };
