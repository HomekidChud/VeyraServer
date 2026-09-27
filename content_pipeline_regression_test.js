const fs=require("fs"),path=require("path");
const root=path.join(__dirname,"..");
const server=fs.readFileSync(path.join(__dirname,"server.js"),"utf8");
const browser=fs.readFileSync(path.join(__dirname,"browser-engine.js"),"utf8");
const app=fs.readFileSync(path.join(root,"frontend","app.js"),"utf8");
function ok(name,cond){if(!cond)throw new Error(`FAIL ${name}`);console.log("PASS",name)}
ok("heavy auto strategy uses combined",app.includes('key: "combined", proxy: true, crawler: true, browser: true, race: true'));
ok("background Chromium starts fast",app.includes('fastStart: !!background'));
ok("combined renderer gets a grace window",app.includes('}, 8000);'));
ok("Chromium exposes rendered DOM snapshot",browser.includes('async renderedContent(sid, timeoutMs = 1800)'));
ok("browser page warms rendered DOM asynchronously",server.includes('warmRenderedBrowserPage') && server.includes('rendered.html'));
ok("browser network requests warm likely required dynamic resources",server.includes('session.network.slice(-160)') && server.includes('fetch|xhr'));
ok("proxy static resources use longer safe cache",server.includes('stale-while-revalidate=300'));
ok("search documents sync to Mongo",server.includes('mongoStore.upsertSearchDocument(doc)') && server.includes('mongoStore.deleteSearchDocument(doc.url)'));
console.log("Veyra content-complete adaptive pipeline regression checks passed");

const srv = server;
const mongo = fs.readFileSync(path.join(__dirname,"mongo-store.js"),"utf8");
ok("cors reflects requested custom headers", !srv.match(/allowedHeaders\s*:/) && srv.includes("Access-Control-Request-Headers"));
ok("binary warm is bounded by HEAD/size guard", srv.includes("proxyWarmMaxBinaryBytes") && srv.includes('method: "HEAD"') && srv.includes("length <= CFG.proxyWarmMaxBinaryBytes"));
ok("crawl summaries use Mongo TTL", mongo.includes('createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })') && mongo.includes("expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)"));

ok("proxy view exposes classified upstream error codes", srv.includes('const publicCode = e.code === "VPN_KILL_SWITCH"') && srv.includes('legacyCode: "PROXY_VIEW_ERROR"'));
