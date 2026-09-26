const fs = require("fs");
const path = require("path");
const s = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
function ok(msg, cond){ if(!cond) throw new Error(msg); console.log("PASS", msg); }
ok("proxy compatibility flags exist", s.includes("PROXY_FORWARD_COMPAT_HEADERS") && s.includes("PROXY_FORWARD_CLIENT_HINTS"));
ok("YouTube client headers are forwarded", s.includes("x-youtube-client-name") && s.includes("x-youtube-client-version"));
ok("YouTube visitor header is forwarded", s.includes("x-goog-visitor-id"));
ok("client hints are forwarded", s.includes("sec-ch-ua") && s.includes("sec-ch-ua-platform"));
ok("fetch metadata is translated", s.includes("sec-fetch-site") && s.includes("sec-fetch-mode") && s.includes("sec-fetch-dest"));
ok("API requests receive higher priority", s.includes("looksLikeApiResource(canonical, accept, method)"));
ok("duplicate activeWorkers increment removed", !s.includes("this.job.activeWorkers += 1;\n      this.job.activeWorkers += 1;"));
ok("BrowserTaskScheduler class is defined", /class BrowserTaskScheduler\s*\{/.test(s));
ok("browser scheduler instance is initialized", /const browserScheduler = new BrowserTaskScheduler\(/.test(s));

