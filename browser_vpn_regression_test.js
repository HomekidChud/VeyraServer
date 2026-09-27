const fs = require('fs');
const assert = require('assert');
const path = require('path');
const here = __dirname;
const browser = fs.readFileSync(path.join(here,'browser-engine.js'),'utf8');
const appPath = path.join(here,'..','frontend','app.js');
const app = fs.existsSync(appPath) ? fs.readFileSync(appPath,'utf8') : null; // frontend lives in a separate folder
const server = fs.readFileSync(path.join(here,'server.js'),'utf8');
const vpn = fs.readFileSync(path.join(here,'vpn.js'),'utf8');
assert(browser.includes('this.creatingSessions = 0;'));
assert(browser.includes('getByTabId(tabId)'));
assert(browser.includes("code: 'BROWSER_CAPACITY'"));
assert(browser.includes('finally {\n      this.creatingSessions'));
assert(browser.includes('!s.navigationActive &&'));
if (app) assert(app.includes('if (e.code === \'BROWSER_CAPACITY\') addLog'));
if (app) assert(!app.match(/if \(e\.code === 'BROWSER_CAPACITY'\)[\s\S]{0,300}navigateUrl\(/));
if (app) assert(app.includes("/api/vpn/test"));
assert(server.includes("app.post('/api/vpn/test'"));
// v8.12: SOCKS5 is a built-in tunnel (remote DNS, auth) instead of undici's Socks5ProxyAgent.
assert(vpn.includes('async function socks5Handshake'));
assert(vpn.includes('VPN_KILL_SWITCH'));
assert(vpn.includes('async test(profileId'));
console.log('Browser/VPN regression checks: PASS');
