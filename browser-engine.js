const crypto = require('crypto');

function id(prefix='b') { return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; }
function sanitizeUrl(value) {
  try { const u=new URL(String(value)); for (const k of [...u.searchParams.keys()]) if (/token|secret|auth|key|session|captcha|challenge/i.test(k)) u.searchParams.set(k,'[redacted]'); return u.href; } catch { return ''; }
}
function safeUrl(value) { try { const u = new URL(String(value)); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } }
function now() { return new Date().toISOString(); }
function sanitizeHeaderMap(headers = {}) {
  const blocked = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|.*token.*|.*secret.*)$/i;
  const out = {};
  for (const [k,v] of Object.entries(headers || {})) if (!blocked.test(k)) out[k] = String(v).slice(0, 1000);
  return out;
}

class BrowserEngine {
  constructor(cfg, assertPublicUrl, logger = () => {}) {
    this.cfg = cfg;
    this.assertPublicUrl = assertPublicUrl;
    this.log = logger;
    this.browser = null;
    this.playwright = null;
    this.sessions = new Map();
    this.startPromise = null;
  }

  async ensureBrowser() {
    if (this.browser) return this.browser;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        this.playwright = require('playwright');
        this.browser = await this.playwright.chromium.launch({
          headless: this.cfg.browserHeadless !== false,
          args: ['--disable-dev-shm-usage']
        });
        this.log('info', 'BROWSER', 'Chromium browser engine started.');
        return this.browser;
      } catch (e) {
        this.log('warn', 'BROWSER', `Chromium unavailable: ${e.message}`);
        this.browser = null;
        throw Object.assign(new Error(`Browser engine unavailable: ${e.message}`), { code: 'BROWSER_ENGINE_UNAVAILABLE' });
      } finally { this.startPromise = null; }
    })();
    return this.startPromise;
  }

  capacity() {
    return { sessions: this.sessions.size, maxSessions: this.cfg.maxBrowserSessions, maxPages: this.cfg.maxBrowserPages, maxContexts: this.cfg.maxBrowserContexts };
  }

  async create(tabId, target) {
    const url = safeUrl(target);
    if (!url) throw Object.assign(new Error('Invalid HTTP(S) browser URL.'), { code: 'INVALID_URL' });
    await this.assertPublicUrl(url);
    if (this.sessions.size >= this.cfg.maxBrowserSessions) throw Object.assign(new Error('Browser session capacity is full.'), { code: 'BROWSER_CAPACITY' });
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1365, height: 820 },
      serviceWorkers: 'allow'
    });
    await context.route('**/*', async route => {
      const target = route.request().url();
      try {
        const u = new URL(target);
        if (/^(https?|wss?):$/i.test(u.protocol)) {
          const check = u.protocol === 'wss:' ? `https://${u.host}${u.pathname}${u.search}` : target;
          await this.assertPublicUrl(check);
        }
      } catch (e) {
        if (/^(https?|wss?):/i.test(target)) return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const page = await context.newPage();
    const sid = id('bs');
    const session = {
      id: sid, tabId: String(tabId || ''), context, page, createdAt: Date.now(), lastUsed: Date.now(),
      canonicalUrl: url, title: '', status: 'LOADING', error: '', verification: null,
      console: [], network: [], downloads: [], pages: new Set([page]), requestSeq: 0,
      screenshot: null, screenshotAt: 0
    };
    this.sessions.set(sid, session);
    this.attachPage(session, page);
    try {
      await this.navigateSession(session, url);
      return this.public(session);
    } catch (e) {
      session.status = 'ERROR'; session.error = e.message;
      return this.public(session);
    }
  }

  attachPage(session, page) {
    page.on('console', msg => this.pushConsole(session, msg.type(), msg.text()));
    page.on('pageerror', err => this.pushConsole(session, 'error', err?.message || String(err)));
    page.on('requestfailed', req => this.pushNetwork(session, {
      type: 'requestfailed', method: req.method(), url: sanitizeUrl(req.url)(), error: req.failure()?.errorText || 'request failed', resourceType: req.resourceType()
    }));
    page.on('response', response => {
      const req = response.request();
      this.pushNetwork(session, { type: 'response', method: req.method(), url: sanitizeUrl(response.url()), status: response.status(), resourceType: req.resourceType(), headers: sanitizeHeaderMap(response.headers()) });
    });
    page.on('request', req => {
      this.pushNetwork(session, { type: 'request', method: req.method(), url: sanitizeUrl(req.url)(), resourceType: req.resourceType() });
    });
    page.on('download', download => {
      const item = { id: id('dl'), filename: download.suggestedFilename(), url: sanitizeUrl(download.url()), state: 'started', startedAt: now(), path: null };
      session.downloads.unshift(item);
      download.path().then(p => { item.path = p; item.state = 'complete'; item.completedAt = now(); }).catch(e => { item.state = 'error'; item.error = e.message; });
    });
    page.on('popup', popup => {
      session.pages.add(popup); this.attachPage(session, popup);
      this.pushConsole(session, 'info', `Popup opened: ${popup.url()}`);
    });
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

  async navigateSession(session, target) {
    const url = safeUrl(target);
    if (!url) throw new Error('Invalid browser URL.');
    await this.assertPublicUrl(url);
    session.status = 'LOADING'; session.error = ''; session.verification = null; session.lastUsed = Date.now();
    const response = await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.cfg.browserNavigationTimeoutMs });
    await session.page.waitForLoadState('load', { timeout: Math.min(10000, this.cfg.browserPageTimeoutMs) }).catch(() => {});
    session.canonicalUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    const challenge = await this.detectVerification(session.page);
    if (challenge) { session.status = 'VERIFICATION_REQUIRED'; session.verification = challenge; }
    else session.status = 'NORMAL';
    if (response && response.status() >= 400 && !challenge) session.error = `HTTP ${response.status()}`;
    await this.capture(session, true);
    return this.public(session);
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
    } catch (e) { session.error = e.message; return null; }
  }

  get(sid) {
    const s = this.sessions.get(String(sid)); if (!s) throw Object.assign(new Error('Browser session not found.'), { code: 'BROWSER_SESSION_NOT_FOUND' });
    s.lastUsed = Date.now(); return s;
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
    s.canonicalUrl = p.url();
    s.title = await p.title().catch(() => s.title || '');
    const challenge = await this.detectVerification(p);
    s.status = challenge ? 'VERIFICATION_REQUIRED' : 'NORMAL'; s.verification = challenge;
    await this.capture(s, true);
    return this.public(s);
  }

  async inspect(sid, x, y) {
    const s = this.get(sid);
    return s.page.evaluate(({x,y}) => {
      const el = document.elementFromPoint(x,y);
      if (!el) return null;
      const attrs = Object.fromEntries([...el.attributes].slice(0, 80).map(a => [a.name, a.value]));
      const cs = getComputedStyle(el), styles = {};
      for (const k of ['display','position','color','backgroundColor','fontSize','fontFamily','fontWeight','margin','padding','width','height','overflow','zIndex']) styles[k] = cs[k];
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), id: el.id || '', classes: el.className && typeof el.className === 'string' ? el.className : '', attrs, outerHTML: el.outerHTML.slice(0, 30000), text: (el.textContent || '').slice(0, 5000), styles, computed: styles, rect: {x:r.x,y:r.y,width:r.width,height:r.height}, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, pageUrl: location.href };
    }, {x:Number(x)||0,y:Number(y)||0});
  }

  async history(sid, direction) {
    const s=this.get(sid), p=s.page;
    if(direction==='back') await p.goBack({waitUntil:'domcontentloaded',timeout:this.cfg.browserNavigationTimeoutMs}).catch(()=>{});
    else if(direction==='forward') await p.goForward({waitUntil:'domcontentloaded',timeout:this.cfg.browserNavigationTimeoutMs}).catch(()=>{});
    else await p.reload({waitUntil:'domcontentloaded',timeout:this.cfg.browserNavigationTimeoutMs}).catch(()=>{});
    s.canonicalUrl=p.url(); s.title=await p.title().catch(()=>s.title||''); const c=await this.detectVerification(p); s.status=c?'VERIFICATION_REQUIRED':'NORMAL'; s.verification=c; await this.capture(s,true); return this.public(s);
  }

  async stop(sid) {
    const s = this.get(sid); s.status = 'CLOSED';
    await s.context.close().catch(() => {});
    this.sessions.delete(String(sid));
    if (!this.sessions.size && this.browser) { /* keep browser warm; contexts are isolated */ }
    return { ok: true };
  }

  async stopNavigation(sid) { const s=this.get(sid); await s.page.evaluate(() => window.stop()).catch(() => {}); return this.public(s); }

  async expireIdle() {
    const cutoff = Date.now() - this.cfg.browserIdleTimeoutMs;
    for (const [sid,s] of this.sessions) if (s.lastUsed < cutoff) await this.stop(sid).catch(() => {});
  }

  async screenshot(sid) { const s=this.get(sid); await this.capture(s,true); return s.screenshot; }

  public(s) {
    return { id:s.id, tabId:s.tabId, canonicalUrl:s.page?.url() || s.canonicalUrl, title: s.title || '', status:s.status, error:s.error, verification:s.verification, createdAt:new Date(s.createdAt).toISOString(), lastUsed:new Date(s.lastUsed).toISOString(), console:s.console.slice(-80), network:s.network.slice(-120), downloads:s.downloads.slice(0,50), capacity:this.capacity() };
  }

  status() {
    return { enabled: !!this.cfg.browserEnabled, available: !!this.browser, sessions: this.sessions.size, maxSessions:this.cfg.maxBrowserSessions, pages:[...this.sessions.values()].reduce((n,s)=>n+s.pages.size,0), maxPages:this.cfg.maxBrowserPages, contexts:this.sessions.size, maxContexts:this.cfg.maxBrowserContexts, sessionList:[...this.sessions.values()].map(s=>({id:s.id,tabId:s.tabId,url:s.page?.url()||s.canonicalUrl,status:s.status,lastUsed:s.lastUsed})) };
  }
}

module.exports = { BrowserEngine };
