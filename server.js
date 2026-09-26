const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);

/*
  Veyra Browse v6:
  - The browser view is served by /api/view.
  - Crawling happens asynchronously in this server.
  - Text sources are stored on the local filesystem so large crawls do not
    keep HTML/CSS/JS bodies in RAM.
  - Binary assets are discovered but not downloaded by the crawler; /api/resource
    fetches them only when the browser page actually requests them.
  - Fixed limits keep the service bounded without exposing configuration UI.
*/
const CFG = Object.freeze({
  htmlWorkers: 24,
  assetWorkers: 36,
  maxPages: 100000,
  maxResources: 125000,
  maxLinks: 750000,
  maxScanBytes: 2 * 1024 * 1024 * 1024,       // 2 GiB scanned per job
  maxTextBytesPerResource: 4 * 1024 * 1024,   // source kept for viewing
  requestTimeoutMs: 12000,
  robotsTimeoutMs: 8000,
  sitemapTimeoutMs: 12000,
  maxRedirects: 5,
  maxSitemapFiles: 100,
  maxSitemapUrls: 250000,
  maxJobAgeMs: 60 * 60 * 1000,
  proxyCacheMs: 15000,
  maxProxyCacheEntries: 300,
  maxSourceFiles: 100000,
  userAgent: "VeyraBrowseCrawler/6.0"
});

const jobs = new Map();
const activeByRoot = new Map();
const proxyCache = new Map();
const ROOT = path.join("/tmp", "veyra-browse-jobs");
fs.mkdirSync(ROOT, { recursive: true });

function now() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function bytesLabel(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n/1024/1024).toFixed(2)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}
function log(job, level, message) {
  const entry = { id: ++job.logSeq, time: now(), level, message: String(message) };
  job.logs.push(entry);
  if (job.logs.length > 400) job.logs.shift();
}
function normalizeUrl(value, base) {
  try {
    const u = new URL(value, base);
    if (!["http:","https:"].includes(u.protocol)) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|msclkid$|yclid$|dclid$)/i.test(k)) u.searchParams.delete(k);
    }
    const pairs = [...u.searchParams.entries()].sort(([a],[b]) => a.localeCompare(b));
    u.search = "";
    for (const [k,v] of pairs) u.searchParams.append(k,v);
    if ((u.protocol==="https:"&&u.port==="443") || (u.protocol==="http:"&&u.port==="80")) u.port="";
    return u.href;
  } catch { return null; }
}
function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  const [a,b] = p;
  return a===10 || a===127 || a===0 || (a===169&&b===254) ||
         (a===172&&b>=16&&b<=31) || (a===192&&b===168) ||
         (a===100&&b>=64&&b<=127);
}
function isPrivateIPv6(ip) {
  const x = ip.toLowerCase();
  return x==="::1" || x==="::" || x.startsWith("fc") || x.startsWith("fd") ||
         x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb");
}
async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!["http:","https:"].includes(u.protocol)) throw new Error("Only HTTP(S) URLs are allowed.");
  const h = u.hostname.toLowerCase();
  if (h==="localhost" || h.endsWith(".localhost") || h==="metadata.google.internal" || h==="169.254.169.254") {
    throw new Error("Private/local destinations are blocked.");
  }
  const records = await dns.lookup(h, { all: true });
  for (const item of records) {
    if (net.isIP(item.address)===4 && isPrivateIPv4(item.address)) throw new Error("Private/local destinations are blocked.");
    if (net.isIP(item.address)===6 && isPrivateIPv6(item.address)) throw new Error("Private/local destinations are blocked.");
  }
}
function typeFor(url, hint="") {
  const p = url.toLowerCase().split("?")[0].split("#")[0];
  if (hint==="css" || /\.css$/i.test(p)) return "css";
  if (hint==="js" || /\.(?:js|mjs|cjs)$/i.test(p)) return "js";
  if (/\.(?:png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|7z|rar|webmanifest)$/i.test(p)) return "asset";
  return "html";
}
function sameOrigin(a,b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
function linkKey(type,url) { return `${type}|${url}`; }

async function fetchBuffer(url, opts={}) {
  let current = normalizeUrl(url);
  const timeout = opts.timeout || CFG.requestTimeoutMs;
  const userAgent = opts.userAgent || CFG.userAgent;
  for (let redirects=0; redirects<=CFG.maxRedirects; redirects++) {
    await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          "accept": opts.accept || "text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript,*/*;q=0.05"
        }
      });
      clearTimeout(timer);

      if (res.status>=300 && res.status<400) {
        const loc=res.headers.get("location");
        if(!loc) throw new Error(`HTTP ${res.status} redirect without Location`);
        const next=normalizeUrl(loc,current);
        if(!next) throw new Error("Invalid redirect");
        current=next;
        continue;
      }

      const chunks=[]; let total=0;
      const limit=opts.limit || CFG.maxSourceBytes;
      const reader=res.body?.getReader();
      if(reader){
        while(true){
          const {done,value}=await reader.read();
          if(done)break;
          total += value.byteLength;
          const remaining=limit-total+value.byteLength;
          if(remaining>0) chunks.push(Buffer.from(value.subarray(0,remaining)));
          if(total>limit){try{await reader.cancel()}catch{}break;}
        }
      } else {
        const b=Buffer.from(await res.arrayBuffer());
        total=b.length;chunks.push(b.subarray(0,limit));
      }
      return {
        ok:res.ok,status:res.status,finalUrl:res.url||current,
        contentType:res.headers.get("content-type")||"",
        bytes:total,truncated:total>limit,body:Buffer.concat(chunks)
      };
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }
  throw new Error("Too many redirects");
}

async function cacheGet(url) {
  const x=proxyCache.get(url); if(!x)return null;
  if(Date.now()-x.time>CFG.proxyCacheMs){proxyCache.delete(url);return null;}
  return x.value;
}
function cacheSet(url,value) {
  proxyCache.set(url,{time:Date.now(),value});
  while(proxyCache.size>CFG.maxProxyCacheEntries) proxyCache.delete(proxyCache.keys().next().value);
}
async function fetchCached(url,opts={}) {
  const c=await cacheGet(url);
  if(c && !opts.noCache)return c;
  const v=await fetchBuffer(url,opts);
  if(!opts.noCache)cacheSet(url,v);
  return v;
}

async function ensureJobDir(job) {
  await fsp.mkdir(job.sourceDir, { recursive:true });
}
async function writeSource(job,resourceId,text) {
  if(job.sourceFiles>=CFG.maxSourceFiles)return null;
  if(job.textBytesStored>=CFG.maxScanBytes)return null;
  const safe=text.slice(0,CFG.maxTextBytesPerResource);
  const file=path.join(job.sourceDir,`${resourceId}.txt`);
  await fsp.writeFile(file,safe,"utf8");
  job.sourceFiles++;
  job.textBytesStored+=Buffer.byteLength(safe);
  return file;
}
async function readSource(job,resource) {
  if(!resource.sourceFile)return resource.inlinePreview||"";
  try{return await fsp.readFile(resource.sourceFile,"utf8")}catch{return resource.inlinePreview||""}
}

function addLink(job,url,type,source) {
  const u=normalizeUrl(url,source||job.root); if(!u)return false;
  const t=typeFor(u,type);
  // HTML recursion is same-origin. External CSS/JS are allowed so framework assets
  // from CDNs can be discovered, but they do not create HTML crawl branches.
  if(t==="html"&&!sameOrigin(u,job.root))return false;
  const key=linkKey(t,u);
  if(job.discovered.has(key) || job.links.length>=CFG.maxLinks)return false;
  job.discovered.add(key);
  const record={url:u,path:new URL(u).pathname+(new URL(u).search||""),type:t,source:source||job.root,internal:sameOrigin(u,job.root),captured:false};
  job.links.push(record);
  if(t==="html"){
    if(job.pageQueue.length+job.activeWorkers+job.processed<CFG.maxPages)job.pageQueue.push({url:u,type:"html",source:source||null});
  } else if(t==="css" || t==="js") {
    if(job.assetQueue.length+job.activeWorkers+job.processed<CFG.maxResources)job.assetQueue.push({url:u,type:t,source:source||null});
  }
  job.counts.links++;
  return true;
}

function discoverHtml(job,text,base) {
  const $=cheerio.load(text,{decodeEntities:false});
  const add=(raw,type)=>{if(raw)addLink(job,raw,type,base)};
  $("a[href],area[href]").each((_,e)=>add($(e).attr("href"),"html"));
  $("link[href]").each((_,e)=>{
    const rel=String($(e).attr("rel")||"").toLowerCase();
    add($(e).attr("href"),rel.includes("stylesheet")?"css":"asset");
  });
  $("script[src]").each((_,e)=>add($(e).attr("src"),"js"));
  $("img[src],source[src],iframe[src],audio[src],video[poster],object[data],input[src]").each((_,e)=>{
    const a=e.name==="object"?"data":e.name==="video"?"poster":"src";add($(e).attr(a),"asset");
  });
  $("form[action]").each((_,e)=>add($(e).attr("action"),"html"));
  $("[srcset]").each((_,e)=>String($(e).attr("srcset")||"").split(",").forEach(x=>add(x.trim().split(/\s+/)[0],"asset")));
  $("style").each((_,e)=>discoverCss(job,$(e).text(),base));
  $("[style]").each((_,e)=>discoverCss(job,$(e).attr("style")||"",base));

  for(const re of [
    /(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /["'`]([^"'`]+\.(?:js|mjs)(?:\?[^"'`]*)?)["'`]/gi
  ]){
    let m;while((m=re.exec(text))!==null)add(m[1],typeFor(m[1]));
  }
}
function discoverCss(job,text,base) {
  let m;
  const re=/url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while((m=re.exec(text))!==null)if(m[1])addLink(job,m[1],"asset",base);
  const imp=/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi;
  while((m=imp.exec(text))!==null)if(m[1])addLink(job,m[1],"css",base);
}
function discoverJs(job,text,base) {
  for(const re of [
    /(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:location(?:\.href)?|window\.open)\s*=?\s*["'`]([^"'`]+)["'`]/g
  ]){
    let m;while((m=re.exec(text))!==null)if(m[1])addLink(job,m[1],typeFor(m[1]),base);
  }
}

async function loadRobots(job) {
  try {
    const robotsUrl=new URL("/robots.txt",job.root).href;
    const r=await fetchBuffer(robotsUrl,{timeout:CFG.robotsTimeoutMs,limit:512*1024,accept:"text/plain,*/*;q=0.1"});
    const text=r.body.toString("utf8");
    const groups=[];let current=null;
    for(const raw of text.split(/\r?\n/)){
      const line=raw.replace(/#.*/,"").trim();if(!line)continue;
      const i=line.indexOf(":");if(i<0)continue;
      const key=line.slice(0,i).trim().toLowerCase(),value=line.slice(i+1).trim();
      if(key==="user-agent"){current={agents:[value.toLowerCase()],disallow:[],sitemaps:[]};groups.push(current)}
      else if(current&&key==="disallow"&&value)current.disallow.push(value);
      else if(current&&key==="sitemap"&&value)current.sitemaps.push(value);
    }
    job.robots={groups};for(const m of text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)){const u=normalizeUrl(m[1],robotsUrl);if(u)job.sitemaps.push(u)}
    log(job,"debug","robots.txt loaded");
  } catch { log(job,"debug","robots.txt unavailable"); }
}
function robotsAllowed(url,robots){
  if(!robots)return true;
  try{const u=new URL(url),p=u.pathname+(u.search||""),g=robots.groups.find(x=>x.agents.includes("*"));return !g||!g.disallow.some(x=>p.startsWith(x))}
  catch{return true}
}
async function loadSitemaps(job){
  const q=[...new Set([...job.sitemaps,normalizeUrl("/sitemap.xml",job.root),normalizeUrl("/sitemap_index.xml",job.root)].filter(Boolean))];
  const seen=new Set();
  let files=0,urls=0;
  while(q.length&&files<CFG.maxSitemapFiles&&urls<CFG.maxSitemapUrls&&!job.stop){
    const sm=q.shift();if(seen.has(sm))continue;seen.add(sm);files++;
    try{
      const r=await fetchBuffer(sm,{timeout:CFG.sitemapTimeoutMs,limit:8*1024*1024,accept:"application/xml,text/xml,text/plain,*/*;q=0.1"});
      const xml=r.body.toString("utf8");
      for(const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)){
        const u=normalizeUrl(m[1],sm);if(!u)continue;
        if(/sitemap/i.test(u)&&/\.xml(?:$|\?)/i.test(u)){if(!seen.has(u)&&q.length<200)q.push(u);continue}
        if(sameOrigin(u,job.root)){addLink(job,u,"html",sm);urls++}
        if(urls>=CFG.maxSitemapUrls)break;
      }
    }catch(e){log(job,"debug",`Sitemap failed: ${sm} — ${e.message}`)}
  }
  if(files)log(job,"info",`Sitemap pass: ${files} file(s), ${urls} URL(s) discovered.`);
}

async function processItem(job,item){
  if(job.stop)return;
  const key=linkKey(item.type,item.url);if(job.visited.has(key))return;
  job.visited.add(key);

  if(item.type==="html"&&(!sameOrigin(item.url,job.root)||!robotsAllowed(item.url,job.robots)))return;

  try{
    // Each job has a total scan byte budget. We fetch text only for HTML/CSS/JS.
    const accept=item.type==="html"
      ?"text/html,application/xhtml+xml,application/xml,text/plain;q=0.4,*/*;q=0.05"
      :"text/css,application/javascript,text/javascript,*/*;q=0.05";
    const r=await fetchCached(item.url,{accept,limit:CFG.maxTextBytesPerResource});
    job.counts.bytesScanned+=r.bytes;

    if(job.counts.bytesScanned>CFG.maxScanBytes){
      job.stop=true;job.limitReason="scan-byte-limit";return;
    }

    const contentType=r.contentType.toLowerCase();
    let type=item.type;
    if(contentType.includes("text/html")||contentType.includes("application/xhtml+xml"))type="html";
    else if(contentType.includes("text/css"))type="css";
    else if(contentType.includes("javascript")||contentType.includes("ecmascript"))type="js";
    else if(item.type==="html")type="html";

    if(type==="asset"){
      // Binary assets are discovered for link indexing but deliberately not fetched by the crawl engine.
      job.processed++;return;
    }

    if(job.resources.length>=CFG.maxResources){job.stop=true;job.limitReason="resource-limit";return}
    const id=job.resources.length;
    const text=r.body.toString("utf8");
    const sourceFile=await writeSource(job,id,text);
    const resource={
      id,url:r.finalUrl||item.url,requestedUrl:item.url,type,status:r.status,
      contentType:r.contentType,bytes:r.bytes,bytesLabel:bytesLabel(r.bytes),truncated:r.truncated,
      sourceFile,inlinePreview:sourceFile?"" : text.slice(0,8000),sourceId:item.source||null
    };
    job.resources.push(resource);

    const link=job.links.find(x=>x.url===resource.url||x.url===item.url);if(link)link.captured=true;

    if(type==="html")discoverHtml(job,text,resource.url);
    else if(type==="css")discoverCss(job,text,resource.url);
    else if(type==="js")discoverJs(job,text,resource.url);

    if(type==="html")job.counts.htmlPages++;
    else if(type==="css")job.counts.css++;
    else if(type==="js")job.counts.js++;

    if((job.processed%50)===0)log(job,"debug",`Processed ${job.processed.toLocaleString()} resources; ${bytesLabel(job.counts.bytesScanned)} scanned.`);
  }catch(e){
    log(job,"error",`Fetch failed ${item.url} — ${e.name||"Error"}: ${e.message}`);
  }finally{
    job.processed++;
  }
}

async function worker(job,type){
  while(!job.stop){
    if(job.processed>=CFG.maxResources)break;
    const item=type==="html"?job.pageQueue.shift():job.assetQueue.shift();
    if(!item){
      if(job.activeWorkers===0 && job.pageQueue.length===0 && job.assetQueue.length===0)break;
      await sleep(8);continue;
    }
    job.activeWorkers++;
    try{await processItem(job,item)}finally{job.activeWorkers--}
  }
}

async function runCrawl(job){
  await ensureJobDir(job);
  await loadRobots(job);
  await loadSitemaps(job);
  addLink(job,job.root,"html",null);

  const workers=[];
  for(let i=0;i<CFG.htmlWorkers;i++)workers.push(worker(job,"html"));
  for(let i=0;i<CFG.assetWorkers;i++)workers.push(worker(job,"asset"));

  while(!job.stop){
    const queuesEmpty=job.pageQueue.length===0&&job.assetQueue.length===0;
    if(queuesEmpty&&job.activeWorkers===0)break;
    if(job.processed>=CFG.maxResources)break;
    await sleep(50);
  }
  await Promise.allSettled(workers);

  job.done=true;job.finishedAt=now();
  if(job.stop){
    if(job.limitReason==="scan-byte-limit"){job.status="done";job.statusText=`Scan budget reached (${bytesLabel(CFG.maxScanBytes)}).`;}
    else if(job.limitReason==="resource-limit"){job.status="done";job.statusText=`Resource safety limit reached (${CFG.maxResources.toLocaleString()}).`;}
    else {job.status="stopped";job.statusText="Stopped by user.";}
  }else{
    job.status="done";job.statusText=`Complete — ${job.processed.toLocaleString()} resources processed; frontier exhausted.`;
  }
  log(job,"info",job.statusText);
}

function createJob(root){
  const id=crypto.randomUUID();
  return {
    id,url:root,root,createdAt:now(),finishedAt:null,done:false,stop:false,status:"running",
    statusText:"Crawling in background…",pageQueue:[],assetQueue:[],visited:new Set(),
    discovered:new Set(),resources:[],resourceByUrl:new Map(),links:[],robots:null,sitemaps:[],
    logs:[],logSeq:0,activeWorkers:0,processed:0,sourceFiles:0,textBytesStored:0,limitReason:null,
    sourceDir:path.join(ROOT,id),counts:{htmlPages:0,css:0,js:0,links:0,bytesScanned:0}
  };
}
function publicJob(job){
  return {
    id:job.id,url:job.url,createdAt:job.createdAt,finishedAt:job.finishedAt,done:job.done,
    status:job.status,statusText:job.statusText,
    maxUrls:CFG.maxResources,maxScanBytes:CFG.maxScanBytes,
    counts:{...job.counts,processed:job.processed,queued:job.pageQueue.length+job.assetQueue.length,active:job.activeWorkers},
    logs:job.logs.slice(-120)
  };
}
function cleanupJob(job){
  try{fs.rmSync(job.sourceDir,{recursive:true,force:true});}catch{}
}

app.get("/health",(req,res)=>res.json({ok:true,service:"veyra-browse-crawler-v6",time:now()}));

app.post("/api/open",async(req,res)=>{
  try{
    const root=normalizeUrl(String(req.body?.url||""));if(!root)throw new Error("Please provide a valid public HTTP(S) URL.");
    await assertPublicUrl(root);
    const oldId=activeByRoot.get(root),old=oldId&&jobs.get(oldId);
    if(old&&!old.done&&!old.stop)return res.status(202).json({jobId:old.id,url:root,viewUrl:"/api/view?url="+encodeURIComponent(root)});
    if([...jobs.values()].filter(j=>!j.done&&!j.stop).length>=3)throw new Error("Crawler capacity is busy; try again shortly.");
    const job=createJob(root);jobs.set(job.id,job);activeByRoot.set(root,job.id);
    log(job,"info","Background high-throughput crawl started.");
    runCrawl(job).catch(e=>{job.done=true;job.status="error";job.statusText=e.message;job.finishedAt=now();log(job,"error",e.stack||e.message)});
    res.status(202).json({jobId:job.id,url:root,viewUrl:"/api/view?url="+encodeURIComponent(root)});
  }catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/view",async(req,res)=>{
  try{
    const url=normalizeUrl(String(req.query.url||""));if(!url)throw new Error("Missing URL.");
    await assertPublicUrl(url);
    const r=await fetchCached(url,{limit:CFG.maxTextBytesPerResource});
    const type=r.contentType.toLowerCase();
    if(type.includes("text/html")||type.includes("application/xhtml+xml")||type.includes("text/plain")||type===""){
      const html=rewriteHtml(r.body.toString("utf8"),r.finalUrl||url);
      res.setHeader("content-type","text/html; charset=utf-8");res.setHeader("cache-control","no-store");return res.status(r.status||200).send(html);
    }
    res.setHeader("content-type",r.contentType||"application/octet-stream");res.setHeader("cache-control","no-store");return res.status(r.status||200).send(r.body);
  }catch(e){res.status(502).type("text/plain").send("Veyra Browse could not load this page.\n\n"+e.message)}
});

function proxyPath(url,base,mode){
  const u=normalizeUrl(url,base);if(!u)return url;
  return mode==="view"?`/api/view?url=${encodeURIComponent(u)}`:`/api/resource?url=${encodeURIComponent(u)}`;
}
function rewriteCssText(text,base){
  return text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi,(m,u)=>`url("${proxyPath(u.trim(),base,"resource")}")`)
    .replace(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi,(m,u)=>`@import "${proxyPath(u.trim(),base,"resource")}"`);
}
function injectRuntime(html,original){
  const code=`<script>
(function(){
  window.__VEYRA_PAGE_URL__=${JSON.stringify(original)};
  function resolve(v){try{return new URL(typeof v==="string"?v:v&&v.url||"",window.__VEYRA_PAGE_URL__).href}catch{return String(v)}}
  function same(u){try{return new URL(u).origin===new URL(window.__VEYRA_PAGE_URL__).origin}catch{return false}}
  const f=window.fetch;
  if(f)window.fetch=function(input,init){const u=resolve(input);if(same(u))return f("/api/resource?url="+encodeURIComponent(u),init);return f(input,init)};
  const xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){const u=resolve(url);return xo.call(this,method,same(u)?"/api/resource?url="+encodeURIComponent(u):url,...Array.prototype.slice.call(arguments,2))};
  addEventListener("load",()=>{try{parent.postMessage({type:"veyra:navigate",url:location.href},"*")}catch{}});
})();
<\/script>`;
  return html.replace(/<head[^>]*>/i,m=>m+code).replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi,"");
}
function rewriteHtml(html,base){
  const $=cheerio.load(html,{decodeEntities:false});
  $("base").remove();
  $("meta[http-equiv]").filter((_,e)=>String($(e).attr("http-equiv")).toLowerCase()==="content-security-policy").remove();
  $("a[href],area[href]").each((_,e)=>{const u=$(e).attr("href");if(u)$(e).attr("href",proxyPath(u,base,"view"))});
  $("form[action]").each((_,e)=>{const u=$(e).attr("action");if(u)$(e).attr("action",proxyPath(u,base,"view"))});
  $("link[href]").each((_,e)=>{const u=$(e).attr("href");if(u)$(e).attr("href",proxyPath(u,base,"resource"))});
  $("script[src]").each((_,e)=>{const u=$(e).attr("src");if(u)$(e).attr("src",proxyPath(u,base,"resource"))});
  for(const tag of ["img","source","iframe","audio","input"]){$(tag+"[src]").each((_,e)=>{const u=$(e).attr("src");if(u)$(e).attr("src",proxyPath(u,base,"resource"))})}
  $("video[poster]").each((_,e)=>{const u=$(e).attr("poster");if(u)$(e).attr("poster",proxyPath(u,base,"resource"))});
  $("object[data]").each((_,e)=>{const u=$(e).attr("data");if(u)$(e).attr("data",proxyPath(u,base,"resource"))});
  $("[srcset]").each((_,e)=>{const raw=$(e).attr("srcset")||"";$(e).attr("srcset",raw.split(",").map(x=>{const p=x.trim().split(/\s+/);p[0]=proxyPath(p[0],base,"resource");return p.join(" ")}).join(", "))});
  $("style").each((_,e)=>$(e).html(rewriteCssText($(e).html()||"",base)));
  $("[style]").each((_,e)=>$(e).attr("style",rewriteCssText($(e).attr("style")||"",base)));
  return injectRuntime($.html(),base);
}
app.get("/api/resource",async(req,res)=>{
  try{
    const url=normalizeUrl(String(req.query.url||""));if(!url)throw new Error("Missing URL.");
    await assertPublicUrl(url);
    const r=await fetchCached(url,{limit:CFG.maxTextBytesPerResource});
    res.setHeader("content-type",r.contentType||"application/octet-stream");res.setHeader("cache-control","public,max-age=15");
    res.status(r.status||200).send(r.body);
  }catch(e){res.status(502).type("text/plain").send("Veyra resource error: "+e.message)}
});

app.get("/api/crawl/:id",(req,res)=>{
  const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json(publicJob(j));
});
app.post("/api/crawl/:id/stop",(req,res)=>{
  const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});
  j.stop=true;j.status="stopping";j.statusText="Stopping…";log(j,"warn","Stop requested.");res.json({ok:true});
});
app.get("/api/crawl/:id/resources",(req,res)=>{
  const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});
  res.json({resources:j.resources.map(r=>({id:r.id,url:r.url,type:r.type,status:r.status,bytes:r.bytes,bytesLabel:r.bytesLabel,truncated:r.truncated,sourceId:r.sourceId}))});
});
app.get("/api/crawl/:id/source/:resourceId",async(req,res)=>{
  const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});
  const r=j.resources[Number(req.params.resourceId)];if(!r)return res.status(404).json({error:"Resource not found"});
  res.json({id:r.id,url:r.url,type:r.type,source:await readSource(j,r)});
});
app.get("/api/crawl/:id/links",(req,res)=>{
  const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});
  const offset=Math.max(0,Number(req.query.offset||0)),limit=Math.min(10000,Math.max(1,Number(req.query.limit||10000)));
  res.json({total:j.links.length,offset,limit,links:j.links.slice(offset,offset+limit)});
});
app.get("/api/crawl/:id/export",(req,res)=>{
  const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});
  res.setHeader("content-type","application/json; charset=utf-8");
  res.setHeader("content-disposition",`attachment; filename="veyra-${j.id}.json"`);
  res.send(JSON.stringify({id:j.id,root:j.root,createdAt:j.createdAt,finishedAt:j.finishedAt,status:j.status,counts:j.counts,links:j.links,resources:j.resources.map(r=>({id:r.id,url:r.url,type:r.type,status:r.status,contentType:r.contentType,bytes:r.bytes,truncated:r.truncated}))},null,2));
});

setInterval(()=>{
  const cutoff=Date.now()-CFG.maxJobAgeMs;
  for(const [id,j] of jobs){
    if(j.done && new Date(j.finishedAt||j.createdAt).getTime()<cutoff){
      cleanupJob(j);jobs.delete(id);if(activeByRoot.get(j.root)===id)activeByRoot.delete(j.root);
    }
  }
},60_000).unref();

app.listen(PORT,"0.0.0.0",()=>console.log(`Veyra Browse crawler v6 listening on ${PORT}`));
