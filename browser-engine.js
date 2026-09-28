const crypto = require('crypto');
const fs = require('fs');

function id(prefix = 'b') { return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; }
function sanitizeUrl(value) {
  try {
    const u = new URL(String(value));
    for (const k of [...u.searchParams.keys()]) if (/token|secret|auth|key|session|captcha|challenge/i.test(k)) u.searchParams.set(k, '[redacted]');
    return u.href;
  } catch { return ''; }
}
function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
}
function now() { return new Date().toISOString(); }
function sanitizeHeaderMap(headers = {}) {
  const blocked = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|.*token.*|.*secret.*)$/i;
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) if (!blocked.test(k)) out[k] = String(v).slice(0, 1000);
  return out;
}
function sanitizeRequestWarmHeaders(headers = {}) {
  const out = {};
  const allow = /^(accept|accept-language|cache-control|pragma|dnt|origin|referer|priority|content-type|x-goog-|x-youtube-|x-yt-|x-requested-with|sec-fetch-)/i;
  const blocked = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|.*token.*|.*secret.*)$/i;
  for (const [k, v] of Object.entries(headers || {})) {
    if (!allow.test(k) || blocked.test(k)) continue;
    out[k] = String(v).slice(0, 2000);
  }
  return out;
}

class BrowserEngine {
  constructor(cfg, assertPublicUrl, logger = () => {}, discover = () => {}, vpnManager = null) {
    this.cfg = cfg;
    this.assertPublicUrl = assertPublicUrl;
    this.log = logger;
    this.discover = typeof discover === 'function' ? discover : () => {};
    this.vpnManager = vpnManager;
    this.browser = null;
    this.playwright = null;
    this.sessions = new Map();
    this.startPromise = null;
    this.creatingSessions = 0;
  }

  async ensureBrowser() {
    if (this.browser) return this.browser;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        if (this.cfg.playwrightBrowsersPath != null) process.env.PLAYWRIGHT_BROWSERS_PATH = String(this.cfg.playwrightBrowsersPath);
        this.playwright = require('playwright');
        let executable = '';
        try { executable = this.playwright.chromium.executablePath(); } catch {}
        if (!executable || !fs.existsSync(executable)) {
          throw Object.assign(new Error('Chromium executable is not installed in the deployment image. Run npx playwright install chromium during the Render build.'), { code: 'BROWSER_ENGINE_UNAVAILABLE' });
        }
        this.browser = await this.playwright.chromium.launch({
          headless: this.cfg.browserHeadless !== false,
          args: [
            '--disable-dev-shm-usage',
            // Stop WebRTC from revealing the server's real IP around the VPN.
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            ...(this.cfg.leanMode ? [
              '--disable-gpu',
              '--disable-extensions',
              '--disable-print-preview'
            ] : [])
          ]
        });
        const launchedBrowser = this.browser;
        launchedBrowser.on?.('disconnected', () => {
          if (this.browser !== launchedBrowser) return;
          const lost = [...this.sessions.values()];
          this.browser = null;
          this.playwright = null;
          this.sessions.clear();
          for (const session of lost) {
            session.status = 'ERROR';
            session.error = 'Chromium disconnected unexpectedly.';
            session.screenshot = null;
          }
          if (lost.length) this.log('warn', 'BROWSER', `Chromium disconnected unexpectedly; cleared ${lost.length} browser session(s).`);
        });
        this.log('info', 'BROWSER', 'Chromium browser engine started.');
        return this.browser;
      } catch (e) {
        this.log('warn', 'BROWSER', `Chromium unavailable: ${e.message}`);
        this.browser = null;
        throw Object.assign(new Error(`Browser engine unavailable: ${e.message}`), { code: 'BROWSER_ENGINE_UNAVAILABLE' });
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  capacity() {
    return {
      sessions: this.sessions.size,
      creating: this.creatingSessions,
      maxSessions: this.cfg.maxBrowserSessions,
      pages: [...this.sessions.values()].reduce((n, s) => n + s.pages.size, 0),
      maxPages: this.cfg.maxBrowserPages,
      contexts: this.sessions.size,
      maxContexts: this.cfg.maxBrowserContexts
    };
  }

  get(sid) {
    const s = this.sessions.get(String(sid));
    if (!s) throw Object.assign(new Error('Browser session not found.'), { code: 'BROWSER_SESSION_NOT_FOUND' });
    s.lastUsed = Date.now();
    return s;
  }

  getByTabId(tabId) {
    const needle = String(tabId || '');
    if (!needle) return null;
    for (const session of this.sessions.values()) if (session.tabId === needle) return session;
    return null;
  }

  // vpn: { profileId, proxy, contextHints } from VpnManager (proxy points at the
  // local VPN gateway so Chromium gets failover + kill switch too).
  // proxySessionId links this browser session to a Veyra proxy session so the
  // session manager can close it when that session expires.
  async create(tabId, target, jobId = '', vpnProfile = null, extra = {}) {
    const url = safeUrl(target);
    if (!url) throw Object.assign(new Error('Invalid HTTP(S) browser URL.'), { code: 'INVALID_URL' });
    await this.assertPublicUrl(url);

    const existing = this.getByTabId(tabId);
    if (existing) {
      const existingVpn = existing.vpnProfileId || null;
      const requestedVpn = vpnProfile?.id || vpnProfile?.profileId || null;
      if (existingVpn === requestedVpn) {
        existing.jobId = String(jobId || existing.jobId || '');
        await this.navigateSession(existing, url, { fast: !!extra.fastStart });
        return this.public(existing);
      }
      await this.stop(existing.id).catch(() => {});
    }

    if (this.sessions.size + this.creatingSessions >= this.cfg.maxBrowserSessions) {
      const candidates = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed);
      const reusable = candidates.find(s => !s.navigationActive && Date.now() - s.lastUsed >= this.cfg.browserEvictMinIdleMs);
      if (reusable && this.cfg.browserEvictIdleOnCapacity) await this.stop(reusable.id).catch(() => {});
      if (this.sessions.size + this.creatingSessions >= this.cfg.maxBrowserSessions) {
        throw Object.assign(new Error('Browser session capacity is full; this tab will continue with FAST_PROXY.'), { code: 'BROWSER_CAPACITY' });
      }
    }

    this.creatingSessions += 1;
    try {
      const browser = await this.ensureBrowser();
      const contextOptions = {
        acceptDownloads: true,
        viewport: { width: 1365, height: 820 },
        serviceWorkers: 'allow'
      };
      if (vpnProfile?.proxy) {
        contextOptions.proxy = { ...vpnProfile.proxy };
        const hints = vpnProfile.contextHints || {};
        if (hints.timezoneId) contextOptions.timezoneId = hints.timezoneId;
        if (hints.locale) contextOptions.locale = hints.locale;
      } else if (vpnProfile?.server) {
        contextOptions.proxy = { server: vpnProfile.server };
        if (vpnProfile.username) contextOptions.proxy.username = vpnProfile.username;
        if (vpnProfile.password) contextOptions.proxy.password = vpnProfile.password;
        if (vpnProfile.bypass) contextOptions.proxy.bypass = vpnProfile.bypass;
      }

      // DevTools bridge + console eval must work on sites with strict CSP.
      contextOptions.bypassCSP = true;
      let context = null;
      let page = null;
      try {
        context = await browser.newContext(contextOptions);
        await context.route('**/*', async route => {
          const targetUrl = route.request().url();
          try {
            const u = new URL(targetUrl);
            if (/^(https?|wss?):$/i.test(u.protocol)) {
              const check = u.protocol === 'wss:' ? `https://${u.host}${u.pathname}${u.search}` : targetUrl;
              await this.assertPublicUrl(check);
            }
          } catch (e) {
            if (/^(https?|wss?):/i.test(targetUrl)) return route.abort('blockedbyclient');
          }
          return route.continue();
        });
        page = await context.newPage();
      } catch (e) {
        await context?.close().catch(() => {});
        throw e;
      }
      const sid = id('bs');
      const session = {
        id: sid,
        tabId: String(tabId || ''),
        jobId: String(jobId || ''),
        context,
        page,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        canonicalUrl: url,
        title: '',
        status: 'LOADING',
        error: '',
        verification: null,
        vpnProfileId: vpnProfile?.id || vpnProfile?.profileId || null,
        proxySessionId: String(extra.proxySessionId || ''),
        navigationActive: false,
        console: [],
        network: [],
        downloads: [],
        pages: new Set([page]),
        requestSeq: 0,
        screenshot: null,
        screenshotAt: 0
      };
      this.sessions.set(sid, session);
      this.attachPage(session, page);
      try {
        await this.navigateSession(session, url, { fast: !!extra.fastStart });
        return this.public(session);
      } catch (e) {
        session.navigationActive = false;
        session.status = 'ERROR';
        session.error = e.message;
        return this.public(session);
      }
    } catch (e) {
      throw e;
    } finally {
      this.creatingSessions = Math.max(0, this.creatingSessions - 1);
    }
  }

  attachPage(session, page) {
    page.on('console', msg => this.pushConsole(session, msg.type(), msg.text()));
    page.on('pageerror', err => this.pushConsole(session, 'error', err?.message || String(err)));
    page.on?.('crash', () => {
      session.status = 'ERROR';
      session.error = 'Chromium page crashed.';
      session.screenshot = null;
      this.pushConsole(session, 'error', 'Chromium page crashed; the page will be recovered on the next navigation.');
    });
    page.on('requestfailed', req => this.pushNetwork(session, {
      type: 'requestfailed', method: req.method(), url: sanitizeUrl(req.url()), error: req.failure()?.errorText || 'request failed', resourceType: req.resourceType()
    }));
    page.on('response', response => {
      const req = response.request();
      const safe = sanitizeUrl(response.url());
      this.pushNetwork(session, {
        type: 'response', method: req.method(), url: safe, status: response.status(), resourceType: req.resourceType(), headers: sanitizeHeaderMap(response.headers())
      });
      if (req.method() === 'GET' && response.status() < 400 && safe) {
        try { this.discover(session, { url: new URL(response.url()).href, type: req.resourceType(), status: response.status(), method: req.method() }); } catch {}
      }
    });
    page.on('request', req => {
      const row = { type: 'request', method: req.method(), url: sanitizeUrl(req.url()), resourceType: req.resourceType(), requestHeaders: {} };
      this.pushNetwork(session, row);
      // allHeaders() is async in Playwright; keep only compatibility headers and
      // never persist cookies/authorization/tokens into the diagnostics buffer.
      void req.allHeaders?.().then(h => { row.requestHeaders = sanitizeRequestWarmHeaders(h); }).catch(() => {});
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        session.canonicalUrl = safeUrl(frame.url()) || session.canonicalUrl;
        session.lastUsed = Date.now();
      }
    });
    page.on('download', download => {
      const item = { id: id('dl'), filename: download.suggestedFilename(), url: sanitizeUrl(download.url()), state: 'started', startedAt: now(), path: null };
      session.downloads.unshift(item);
      while (session.downloads.length > 50) session.downloads.pop();
      download.path().then(p => {
        item.path = p; item.state = 'complete'; item.completedAt = now();
      }).catch(e => {
        item.state = 'error'; item.error = e.message;
      });
    });
    page.on('popup', popup => {
      if (session.pages.size >= this.cfg.maxBrowserPages) {
        popup.close().catch(() => {});
        this.pushConsole(session, 'warn', 'Popup blocked: browser page capacity reached.');
        return;
      }
      session.pages.add(popup);
      this.attachPage(session, popup);
      this.pushConsole(session, 'info', `Popup opened: ${sanitizeUrl(popup.url()) || 'new page'}`);
    });
    page.on('close', () => session.pages.delete(page));
  }

  pushConsole(session, level, message) {
    session.lastUsed = Date.now();
    session.console.push({ time: now(), level, message: String(message).slice(0, 4000) });
    if (session.console.length > 300) session.console.splice(0, session.console.length - 300);
  }

  pushNetwork(session, row) {
    session.lastUsed = Date.now();
    session.network.push({ time: now(), ...row });
    if (session.network.length > 600) session.network.splice(0, session.network.length - 600);
  }

  async navigateSession(session, target, options = {}) {
    const url = safeUrl(target);
    if (!url) throw Object.assign(new Error('Invalid browser URL.'), { code: 'INVALID_URL' });
    await this.assertPublicUrl(url);
    session.status = 'LOADING';
    session.navigationActive = true;
    session.error = '';
    session.verification = null;
    session.screenshot = null;
    session.lastUsed = Date.now();
    try {
      // Commit is enough to establish the navigation without waiting for a
      // JavaScript-heavy application to finish every subresource. We then give
      // the page short best-effort paint windows. This avoids 30s dead waits on
      // sites such as YouTube while still capturing a useful interactive page.
      let response;
      try {
        response = await session.page.goto(url, {
          waitUntil: 'commit',
          timeout: this.cfg.browserNavigationTimeoutMs
        });
      } catch (gotoError) {
        // Some React/Next-style sites immediately replace the document while the
        // initial navigation is committing. Playwright may surface that race as
        // net::ERR_ABORTED even though the browser is already on the real page.
        // Treat it as recoverable when a non-blank document is now present.
        const current = safeUrl(session.page.url());
        if (!/ERR_ABORTED/i.test(String(gotoError?.message || '')) || !current || current === 'about:blank') throw gotoError;
        this.pushConsole(session, 'info', `Navigation reported ERR_ABORTED after document handoff; continuing with ${sanitizeUrl(current)}`);
      }
      await session.page.waitForLoadState('domcontentloaded', { timeout: Math.min(8000, this.cfg.browserPageTimeoutMs) }).catch(() => {});
      await session.page.waitForLoadState('load', { timeout: options.fast ? 1800 : Math.min(4000, this.cfg.browserPageTimeoutMs) }).catch(() => {});
      session.canonicalUrl = safeUrl(session.page.url()) || url;
      session.title = await session.page.title().catch(() => '');
      const challenge = await this.detectVerification(session.page);
      if (challenge) {
        session.status = 'VERIFICATION_REQUIRED';
        session.verification = challenge;
      } else {
        session.status = 'NORMAL';
      }
      if (response && response.status() >= 400 && !challenge) session.error = `HTTP ${response.status()}`;
      await this.capture(session, true);
      return this.public(session);
    } catch (e) {
      session.status = 'ERROR';
      session.error = e?.message || 'Chromium navigation failed.';
      session.screenshot = null;
      throw Object.assign(new Error(session.error), { code: e?.code || (/timeout/i.test(session.error) ? 'BROWSER_NAVIGATION_TIMEOUT' : 'BROWSER_NAVIGATION_ERROR'), cause: e });
    } finally {
      session.navigationActive = false;
      session.lastUsed = Date.now();
    }
  }

  async renderedContent(sid, timeoutMs = 1800) {
    const s = this.get(sid);
    if (!s?.page) throw Object.assign(new Error('Browser session is unavailable.'), { code: 'BROWSER_SESSION_NOT_FOUND' });
    s.lastUsed = Date.now();
    const html = await Promise.race([
      s.page.content(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Rendered content snapshot timed out.')), Math.max(500, Number(timeoutMs) || 1800)))
    ]);
    return { html: String(html || ''), url: safeUrl(s.page.url()) || s.canonicalUrl, title: await s.page.title().catch(() => s.title || '') };
  }

  async detectVerification(page) {
    try {
      const url = page.url();
      const title = await page.title().catch(() => '');
      const text = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
      const signal = /captcha|verify you are human|security verification|attention required|just a moment|checking your browser|challenge/i;
      if (signal.test(url) || signal.test(title) || signal.test(text.slice(0, 12000))) return { url, title: String(title).slice(0, 200) };
    } catch {}
    return null;
  }

  async capture(session, force = false) {
    if (!force && session.screenshot && Date.now() - session.screenshotAt < 250) return session.screenshot;
    try {
      session.screenshot = await session.page.screenshot({ type: 'png' });
      session.screenshotAt = Date.now();
      return session.screenshot;
    } catch (e) {
      session.error = e.message;
      return null;
    }
  }

  async input(sid, action) {
    const s = this.get(sid), p = s.page;
    if (s.status === 'CLOSED') throw new Error('Browser session is closed.');
    s.lastUsed = Date.now();
    const kind = String(action?.type || '');
    if (kind === 'click') await p.mouse.click(Number(action.x) || 0, Number(action.y) || 0, { button: action.button || 'left' });
    else if (kind === 'dblclick') await p.mouse.dblclick(Number(action.x) || 0, Number(action.y) || 0);
    else if (kind === 'wheel') await p.mouse.wheel(Number(action.deltaX) || 0, Number(action.deltaY) || 0);
    else if (kind === 'type') await p.keyboard.insertText(String(action.text || '').slice(0, 10000));
    else if (kind === 'key') await p.keyboard.press(String(action.key || '').slice(0, 100));
    else if (kind === 'hover') await p.mouse.move(Number(action.x) || 0, Number(action.y) || 0);
    else throw new Error('Unsupported browser input action.');
    await new Promise(r => setTimeout(r, 40));
    s.canonicalUrl = safeUrl(p.url()) || s.canonicalUrl;
    s.title = await p.title().catch(() => s.title || '');
    const challenge = await this.detectVerification(p);
    s.status = challenge ? 'VERIFICATION_REQUIRED' : 'NORMAL';
    s.verification = challenge;
    await this.capture(s, true);
    return this.public(s);
  }

  async inspect(sid, x, y) {
    const s = this.get(sid);
    return s.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const attrs = Object.fromEntries([...el.attributes].slice(0, 80).map(a => [a.name, a.value]));
      const cs = getComputedStyle(el), styles = {};
      for (const k of ['display','position','color','backgroundColor','fontSize','fontFamily','fontWeight','margin','padding','width','height','overflow','zIndex']) styles[k] = cs[k];
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(), id: el.id || '',
        classes: el.className && typeof el.className === 'string' ? el.className : '', attrs,
        outerHTML: el.outerHTML.slice(0, 30000), text: (el.textContent || '').slice(0, 5000),
        styles, computed: styles, rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, pageUrl: location.href
      };
    }, { x: Number(x) || 0, y: Number(y) || 0 });
  }

  async history(sid, direction) {
    const s = this.get(sid), p = s.page;
    if (direction === 'back') await p.goBack({ waitUntil: 'domcontentloaded', timeout: this.cfg.browserNavigationTimeoutMs }).catch(() => {});
    else if (direction === 'forward') await p.goForward({ waitUntil: 'domcontentloaded', timeout: this.cfg.browserNavigationTimeoutMs }).catch(() => {});
    else await p.reload({ waitUntil: 'domcontentloaded', timeout: this.cfg.browserNavigationTimeoutMs }).catch(() => {});
    s.canonicalUrl = safeUrl(p.url()) || s.canonicalUrl;
    s.title = await p.title().catch(() => s.title || '');
    const c = await this.detectVerification(p);
    s.status = c ? 'VERIFICATION_REQUIRED' : 'NORMAL';
    s.verification = c;
    await this.capture(s, true);
    return this.public(s);
  }

  async stop(sid) {
    const s = this.get(sid);
    s.status = 'CLOSED';
    clearTimeout(s.browserPoll);
    await s.context.close().catch(() => {});
    this.sessions.delete(String(sid));
    if (!this.sessions.size) this.lastSessionClosedAt = Date.now();
    if (!this.sessions.size && this.browser && !this.cfg.browserKeepWarm) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.playwright = null;
      this.log('info', 'BROWSER', 'Chromium browser engine stopped after the last session closed.');
    }
    return { ok: true };
  }

  async stopNavigation(sid) {
    const s = this.get(sid);
    await s.page.evaluate(() => window.stop()).catch(() => {});
    s.navigationActive = false;
    return this.public(s);
  }

  // Close every session tied to a Veyra proxy session (used by the session manager).
  async stopForProxySession(proxySid) {
    let n = 0;
    for (const [sid, s] of this.sessions) if (proxySid && s.proxySessionId === proxySid) { await this.stop(sid).catch(() => {}); n += 1; }
    return n;
  }

  // Close sessions that are not navigating and have been idle for minIdleMs.
  async shedIdle(minIdleMs = 30000) {
    let n = 0;
    const cutoff = Date.now() - minIdleMs;
    for (const [sid, s] of this.sessions) if (!s.navigationActive && s.lastUsed < cutoff) { await this.stop(sid).catch(() => {}); n += 1; }
    return n;
  }

  async expireIdle() {
    const nowMs = Date.now();
    // Even with BROWSER_KEEP_WARM, don't hold ~150MB of Chromium forever when
    // nobody is using it.
    if (!this.sessions.size && this.browser && this.cfg.browserKeepWarm && this.cfg.browserWarmIdleMs > 0 && this.lastSessionClosedAt && nowMs - this.lastSessionClosedAt > this.cfg.browserWarmIdleMs) {
      await this.browser.close().catch(() => {});
      this.browser = null; this.playwright = null;
      this.log('info', 'BROWSER', 'Chromium stopped after staying idle (BROWSER_WARM_IDLE_MS).');
    }
    const idleCutoff = nowMs - this.cfg.browserIdleTimeoutMs;
    const ttlCutoff = nowMs - this.cfg.browserSessionTtlMs;
    for (const [sid, s] of this.sessions) {
      if (!s.navigationActive && (s.lastUsed < idleCutoff || s.createdAt < ttlCutoff)) await this.stop(sid).catch(() => {});
    }
  }

  async screenshot(sid) {
    const s = this.get(sid);
    await this.capture(s, true);
    return s.screenshot;
  }

  public(s) {
    return {
      id: s.id,
      tabId: s.tabId,
      jobId: s.jobId,
      canonicalUrl: safeUrl(s.page?.url()) || s.canonicalUrl,
      title: s.title || '',
      status: s.status,
      error: s.error,
      verification: s.verification,
      createdAt: new Date(s.createdAt).toISOString(),
      lastUsed: new Date(s.lastUsed).toISOString(),
      console: s.console.slice(-80),
      network: s.network.slice(-120),
      downloads: s.downloads.slice(0, 50),
      vpnProfileId: s.vpnProfileId || null,
      capacity: this.capacity()
    };
  }

  status() {
    return {
      enabled: !!this.cfg.browserEnabled,
      available: !!this.browser,
      ...this.capacity(),
      sessionList: [...this.sessions.values()].map(s => ({
        id: s.id, tabId: s.tabId, proxySessionId: s.proxySessionId ? `${s.proxySessionId.slice(0, 6)}…` : null, url: safeUrl(s.page?.url()) || s.canonicalUrl,
        status: s.status, navigationActive: !!s.navigationActive, lastUsed: s.lastUsed
      }))
    };
  }
}

module.exports = { BrowserEngine };
