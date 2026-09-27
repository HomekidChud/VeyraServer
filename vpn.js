const { ProxyAgent, Socks5ProxyAgent } = require('undici');

function boolEnv(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1','true','yes','on'].includes(raw);
}
function safeProxyProfile(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || fallbackId || '').trim().slice(0, 64);
  const name = String(raw.name || id || 'Veyra VPN').trim().slice(0, 100);
  const server = String(raw.server || raw.proxy || '').trim();
  if (!id || !server) return null;
  let u;
  try { u = new URL(server); } catch { return null; }
  if (!['http:','https:','socks:','socks5:'].includes(u.protocol)) return null;
  const username = String(raw.username || '').slice(0, 256);
  const password = String(raw.password || '').slice(0, 512);
  const bypass = String(raw.bypass || '').slice(0, 2000);
  return { id, name, server: u.href, protocol: u.protocol.replace(':','').toUpperCase(), username, password, bypass, region: String(raw.region || '').slice(0,80), provider: String(raw.provider || 'Configured gateway').slice(0,120) };
}

class VpnManager {
  constructor(logger = () => {}) {
    this.log = logger;
    this.enabled = boolEnv('VPN_ENABLED', false);
    this.mode = String(process.env.VPN_MODE || 'proxy').trim().toLowerCase() || 'proxy';
    this.defaultProfileId = String(process.env.VPN_DEFAULT_PROFILE || '').trim();
    this.profiles = new Map();
    this.connections = new Map();
    this.agents = new Map();
    this.loadProfiles();
  }
  loadProfiles() {
    let parsed = [];
    const raw = String(process.env.VPN_PROFILES_JSON || '').trim();
    if (raw) {
      try { parsed = JSON.parse(raw); if (!Array.isArray(parsed)) parsed = []; } catch (e) { this.log('warn','VPN',`VPN_PROFILES_JSON invalid: ${e.message}`); }
    }
    for (const item of parsed) {
      const profile = safeProxyProfile(item);
      if (profile) this.profiles.set(profile.id, profile);
    }
    const single = safeProxyProfile({
      id: process.env.VPN_PROFILE_ID || 'default',
      name: process.env.VPN_PROFILE_NAME || 'Veyra VPN',
      server: process.env.VPN_PROXY_SERVER || '',
      username: process.env.VPN_PROXY_USERNAME || '',
      password: process.env.VPN_PROXY_PASSWORD || '',
      bypass: process.env.VPN_PROXY_BYPASS || '',
      region: process.env.VPN_REGION || '',
      provider: process.env.VPN_PROVIDER_NAME || 'Configured gateway'
    });
    if (single && !this.profiles.has(single.id)) this.profiles.set(single.id, single);
    if (!this.defaultProfileId && this.profiles.size) this.defaultProfileId = this.profiles.keys().next().value;
  }
  publicProfile(profile) {
    if (!profile) return null;
    return { id: profile.id, name: profile.name, protocol: profile.protocol, region: profile.region || '', provider: profile.provider || '' };
  }
  list() { return [...this.profiles.values()].map(p => this.publicProfile(p)); }
  get(id='') { return this.profiles.get(String(id || this.defaultProfileId)) || null; }
  enabledForUse() { return this.enabled && this.mode === 'proxy' && this.profiles.size > 0; }
  connect(sessionId, profileId='') {
    const profile = this.get(profileId);
    if (!this.enabled) throw Object.assign(new Error('Veyra VPN is disabled on this server.'), { code:'VPN_DISABLED' });
    if (!profile) throw Object.assign(new Error('No configured Veyra VPN profile is available.'), { code:'VPN_NOT_CONFIGURED' });
    const sid = String(sessionId || '').trim();
    if (!sid) throw Object.assign(new Error('Missing Veyra session id.'), { code:'VPN_SESSION_REQUIRED' });
    this.connections.set(sid, profile.id);
    return { connected:true, sessionId:sid, profile:this.publicProfile(profile) };
  }
  disconnect(sessionId) {
    const sid=String(sessionId || '').trim();
    this.connections.delete(sid);
    return { connected:false, sessionId:sid, profile:null };
  }
  profileForSession(sessionId) {
    const id=this.connections.get(String(sessionId || ''));
    return id ? (this.profiles.get(id) || null) : null;
  }
  playwrightProxy(sessionId) {
    const p=this.profileForSession(sessionId);
    if (!p) return undefined;
    const out={ server:p.server };
    if (p.username) out.username=p.username;
    if (p.password) out.password=p.password;
    if (p.bypass) out.bypass=p.bypass;
    return out;
  }
  dispatcherForSession(sessionId) {
    const p=this.profileForSession(sessionId);
    if (!p) return undefined;
    return this.profileDispatcher(p);
  }

  async test(profileId='') {
    const p=this.get(profileId);
    if (!this.enabled) throw Object.assign(new Error('Veyra VPN is disabled on this server.'), { code:'VPN_DISABLED' });
    if (!p) throw Object.assign(new Error('No configured Veyra VPN profile is available.'), { code:'VPN_NOT_CONFIGURED' });
    const agent = this.profileDispatcher(p);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('https://example.com/', { method:'HEAD', dispatcher:agent, signal:controller.signal, headers:{'user-agent':'VeyraVPNHealth/1.0'} });
      return { ok: response.status >= 200 && response.status < 500, status: response.status, profile:this.publicProfile(p) };
    } catch (e) {
      throw Object.assign(new Error(`VPN gateway test failed: ${e.message}`), { code:'VPN_TEST_FAILED' });
    } finally { clearTimeout(timer); }
  }

  profileDispatcher(profile) {
    const key = profile.id;
    if (this.agents.has(key)) return this.agents.get(key);
    let agent;
    if (profile.protocol === 'SOCKS' || profile.protocol === 'SOCKS5') {
      const options = {};
      if (profile.username) options.username = profile.username;
      if (profile.password) options.password = profile.password;
      agent = new Socks5ProxyAgent(profile.server, options);
    } else {
      const options={ uri:profile.server };
      if (profile.username || profile.password) options.token = `Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString('base64')}`;
      agent = new ProxyAgent(options);
    }
    this.agents.set(key, agent);
    return agent;
  }
  status() {
    return { enabled:this.enabled, mode:this.mode, configured:this.profiles.size>0, profiles:this.list(), connections:this.connections.size, defaultProfile:this.defaultProfileId || null };
  }
  async close() { for (const agent of this.agents.values()) await agent.close().catch(()=>{}); this.agents.clear(); this.connections.clear(); }
}

module.exports = { VpnManager };
