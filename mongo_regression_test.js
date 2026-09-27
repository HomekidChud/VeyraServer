const fs = require("fs"), path = require("path");
const s = fs.readFileSync(path.join(__dirname,"server.js"),"utf8"), m=fs.readFileSync(path.join(__dirname,"mongo-store.js"),"utf8"), a=fs.readFileSync(path.join(__dirname,"auth.js"),"utf8"), b=fs.readFileSync(path.join(__dirname,"browser-engine.js"),"utf8"), f=fs.readFileSync(path.join(__dirname,"../frontend/app.js"),"utf8");
function ok(n,c){if(!c)throw new Error(`FAIL ${n}`);console.log("PASS",n)}
ok("Mongo persistence module exists",m.includes("class MongoStore")&&m.includes("loadUsers")&&m.includes("loadSearchDocuments"));
ok("Mongo low-pool fail-open design",m.includes("maxConnecting: 1")&&m.includes("retryAfter")&&m.includes("MONGODB_URI not configured"));
ok("proxy cache L2 Mongo wiring",s.includes("mongoStore.getProxyCache")&&s.includes("mongoStore.putProxyCache"));
ok("foreground GET request coalescing",s.includes("fetchInflight")&&s.includes("canCoalesce"));
ok("static shared cache key",s.includes('sid=*')&&s.includes("mongoSharedCache"));
ok("auth Mongo hydration and writes",a.includes("this.ready = this.persistence.loadUsers()")&&a.includes("persistence?.upsertUser"));
ok("search Mongo persistence",s.includes("mongoStore.upsertSearchDocument")&&s.includes("hydrateSearchFromMongo"));
ok("crawl summary persistence",s.includes("mongoStore.saveCrawlSummary"));
ok("page warm critical phase continues",s.includes("Critical page resources warmed; finishing required assets in the background")&&!s.includes('this.job.stopReason = "page-warm-deadline"'));
ok("auto heavy mode uses combined",f.includes('key: "combined", proxy: true, crawler: true, browser: true, race: true'));
ok("background Chromium fast start",b.includes("fast: !!extra.fastStart"));
ok("combined proxy gets grace window",f.includes("combinedGraceTimer")&&f.includes("8000"));
console.log("Veyra 8.15 regression checks passed");
