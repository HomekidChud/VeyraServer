"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { rewriteLocationReads } = require("../src/proxy-location");
const { rewriteJsText, rewriteHtml } = require("../src/server");
process.on("uncaughtException", e => { console.error(e); process.exitCode = 1; });
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const native = { pathname: "/api/view", href: "https://proxy.test/api/view?url=upstream" };
const virtual = { pathname: "/", href: "https://site.test/", location: { value: 3 } };
const window = { location: native };
const context = { location: native, window, self: window, document: { defaultView: window },
  __VEYRA_LOCATION__: virtual,
  __VEYRA_GET_LOCATION__: (object, optional) => optional && object == null ? undefined : object === window ? virtual : object.location };
const run = text => vm.runInNewContext(rewriteLocationReads(text, "https://site.test/app/main.js"), { ...context });
check(run("window.location.pathname"), "/");
check(run("self['location'].pathname"), "/");
check(run("location.pathname"), "/");
check(run("document.defaultView.location.pathname"), "/");
check(run("(()=>{const w=window;return w.location.pathname})()"), "/");
check(run("({location}).location.pathname"), "/");
check(run("(()=>{const location={pathname:'local'};return location.pathname})()"), "local");
check(run("((location)=>location.pathname)({pathname:'parameter'})"), "parameter");
check(run("(()=>{try{throw {pathname:'caught'}}catch(location){return location.pathname}})()"), "caught");
check(run("(()=>{const obj={location:{pathname:'owned'}};return obj.location.pathname})()"), "owned");
check(run("null?.location"), undefined);
check(run("window.location.location.value"), 3);
check(run("(()=>{let count=0;const obj=()=>{count++;return window};obj().location;return count})()"), 1);
check(run("(()=>{const o={value:2,location(){return this.value}};return o.location()})()"), 2);
const writes = ["window.location='/next'", "location='/next'", "object.location=3", "delete object.location"];
for (const text of writes) check(rewriteLocationReads(text, "https://site.test/"), text);
check(rewriteLocationReads('const s="window.location.pathname"; // location.href', "https://site.test/"), 'const s="window.location.pathname"; // location.href');
check(rewriteLocationReads('const loc=import.meta.url;', "https://site.test/app/main.js"), 'const loc="https://site.test/app/main.js";');
check(rewriteJsText('let publicPath="https://cdn.test/chunks/";script.src=publicPath+"entry.js";', "https://cdn.test/chunks/vendor.js", "sid"),
  'let publicPath="https://cdn.test/chunks/";script.src=publicPath+"entry.js";');
const html = rewriteHtml('<html><head><script>window.route=location.pathname</script><script type="application/json" id="state">{"text":"location.pathname"}</script></head></html>', "https://site.test/", "sid");
assert.match(html, /window\.route=\(globalThis\.__VEYRA_LOCATION__\|\|location\)\.pathname/); checks++;
assert.match(html, /id="state">{"text":"location.pathname"}/); checks++;
console.log(`Proxy location: ${checks} scope, write, syntax and loader checks passed.`);
