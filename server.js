const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const app = express();
app.use(cors({origin:"*",methods:["GET","POST","OPTIONS"],allowedHeaders:["Content-Type"]}));
app.use(express.json({limit:"32kb"}));

const PORT=Number(process.env.PORT||10000);
const CFG=Object.freeze({
  htmlWorkers:24,
  assetWorkers:40,
  maxUrls:5000,
  maxSourceBytes:900_000,
  timeoutMs:12000,
  maxRedirects:5,
  maxJobAgeMs:45*60*1000,
  proxyCacheMs:15_000,
  maxCacheEntries:250,
  userAgent:"VeyraBrowseCrawler/5.0"
});

const jobs=new Map();
const activeByRoot=new Map();
const cache=new Map();

function now(){return new Date().toISOString()}
function log(job,level,message){
  const entry={id:++job.logSeq,time:now(),level,message:String(message)};
  job.logs.push(entry);if(job.logs.length>300)job.logs.shift();
}
function normalizeUrl(value,base){
  try{
    const u=new URL(value,base);
    if(!["http:","https:"].includes(u.protocol))return null;
    u.hash="";
    for(const k of [...u.searchParams.keys()]){
      if(/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|msclkid$|yclid$|dclid$)/i.test(k))u.searchParams.delete(k);
    }
    const pairs=[...u.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b));
    u.search="";for(const [k,v] of pairs)u.searchParams.append(k,v);
    if((u.protocol==="https:"&&u.port==="443")||(u.protocol==="http:"&&u.port==="80"))u.port="";
    return u.href;
  }catch{return null}
}
function isPrivateIPv4(ip){
  const p=ip.split(".").map(Number);if(p.length!==4||p.some(Number.isNaN))return false;
  const [a,b]=p;
  return a===10||a===127||a===0||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127);
}
function isPrivateIPv6(ip){
  const x=ip.toLowerCase();
  return x==="::1"||x==="::"||x.startsWith("fc")||x.startsWith("fd")||x.startsWith("fe8")||x.startsWith("fe9")||x.startsWith("fea")||x.startsWith("feb");
}
async function assertPublicUrl(url){
  const u=new URL(url);
  if(!["http:","https:"].includes(u.protocol))throw new Error("Only HTTP(S) URLs are allowed.");
  const h=u.hostname.toLowerCase();
  if(h==="localhost"||h.endsWith(".localhost")||h==="metadata.google.internal"||h==="169.254.169.254")throw new Error("Private/local destinations are blocked.");
  const ips=await dns.lookup(h,{all:true});
  for(const item of ips){
    if(net.isIP(item.address)===4&&isPrivateIPv4(item.address))throw new Error("Private/local destinations are blocked.");
    if(net.isIP(item.address)===6&&isPrivateIPv6(item.address))throw new Error("Private/local destinations are blocked.");
  }
}
async function fetchBuffer(url){
  let current=normalizeUrl(url);
  for(let redirects=0;redirects<=CFG.maxRedirects;redirects++){
    await assertPublicUrl(current);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),CFG.timeoutMs);
    try{
      const res=await fetch(current,{redirect:"manual",signal:controller.signal,headers:{
        "user-agent":CFG.userAgent,
        "accept":"text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript,image/*,font/*,*/*;q=0.05"
      }});
      clearTimeout(timer);
      if(res.status>=300&&res.status<400){
        const loc=res.headers.get("location");if(!loc)throw new Error(`HTTP ${res.status} redirect without Location`);
        const next=normalizeUrl(loc,current);if(!next)throw new Error("Invalid redirect");
        current=next;continue;
      }
      const chunks=[];let total=0;const reader=res.body?.getReader();
      if(reader){
        while(true){
          const {done,value}=await reader.read();if(done)break;
          total+=value.byteLength;
          if(total<=CFG.maxSourceBytes)chunks.push(Buffer.from(value));
          if(total>CFG.maxSourceBytes){try{await reader.cancel()}catch{}break}
        }
      }else{
        const b=Buffer.from(await res.arrayBuffer());total=b.length;chunks.push(b.subarray(0,CFG.maxSourceBytes));
      }
      return {ok:res.ok,status:res.status,finalUrl:res.url||current,contentType:res.headers.get("content-type")||"",bytes:total,truncated:total>CFG.maxSourceBytes,body:Buffer.concat(chunks)};
    }catch(e){
      clearTimeout(timer);throw e;
    }
  }
  throw new Error("Too many redirects");
}
function bytesLabel(n){if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(2)} MB`}
function typeFor(url,hint=""){
  const p=url.toLowerCase().split("?")[0].split("#")[0];
  if(hint==="css"||/\.css$/i.test(p))return "css";
  if(hint==="js"||/\.(?:js|mjs|cjs)$/i.test(p))return "js";
  if(/\.(?:png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|webmanifest)$/i.test(p))return "asset";
  return "html";
}
function sameOrigin(a,b){try{return new URL(a).origin===new URL(b).origin}catch{return false}}
function publicLink(job,url,type,source){
  const u=normalizeUrl(url,source||job.root);if(!u)return null;
  const t=typeFor(u,type);
  if(t==="html"&&!sameOrigin(u,job.root))return null;
  return u;
}
function addLink(job,url,type,source){
  const u=publicLink(job,url,type,source);if(!u)return;
  const key=t=>`${t}|${u}`;
  const k=key(typeFor(u,type));if(job.discovered.has(k))return;
  job.discovered.add(k);job.counts.links++;
  job.links.push({url:u,path:new URL(u).pathname+(new URL(u).search||""),type:typeFor(u,type),source:source||job.root,internal:sameOrigin(u,job.root),captured:false});
  if(typeFor(u,type)==="html")job.pageQueue.push({url:u,type:"html",source:source||null});
  else if(["css","js"].includes(typeFor(u,type)))job.assetQueue.push({url:u,type:typeFor(u,type),source:source||null});
}
function parseRobots(text){
  const groups=[];let current=null;
  for(const raw of text.split(/\r?\n/)){
    const line=raw.replace(/#.*/,"").trim();if(!line)continue;
    const i=line.indexOf(":");if(i<0)continue;
    const key=line.slice(0,i).trim().toLowerCase(),value=line.slice(i+1).trim();
    if(key==="user-agent"){current={agents:[value.toLowerCase()],disallow:[],sitemaps:[]};groups.push(current)}
    else if(current&&key==="disallow"&&value)current.disallow.push(value);
    else if(current&&key==="sitemap"&&value)current.sitemaps.push(value);
  }
  return {groups};
}
function robotsAllowed(url,robots){
  if(!robots)return true;
  try{
    const p=new URL(url).pathname+(new URL(url).search||"");
    const g=robots.groups.find(x=>x.agents.includes("*"));return !g||!g.disallow.some(x=>p.startsWith(x));
  }catch{return true}
}
async function loadRobots(job){
  try{
    const u=new URL("/robots.txt",job.root).href;const r=await fetchBuffer(u);const text=r.body.toString("utf8");
    job.robots=parseRobots(text);for(const m of text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)){const u=normalizeUrl(m[1],job.root);if(u)job.sitemaps.push(u)}
    log(job,"debug","robots.txt loaded");
  }catch{log(job,"debug","robots.txt unavailable")}
}
function discoverHtml(job,text,base){
  const $=cheerio.load(text,{decodeEntities:false});
  const add=(raw,type)=>{if(raw)addLink(job,raw,type,base)};
  $("a[href],area[href]").each((_,e)=>add($(e).attr("href"),"html"));
  $("link[href]").each((_,e)=>add($(e).attr("href"),String($(e).attr("rel")||"").toLowerCase().includes("stylesheet")?"css":"asset"));
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
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g
  ]){
    let m;while((m=re.exec(text)))add(m[1],typeFor(m[1]));
  }
}
function discoverCss(job,text,base){
  let m;const r=/url\(\s*["']?([^"')]+)["']?\s*\)/gi;while((m=r.exec(text))){if(m[1])addLink(job,m[1],"asset",base)}
  const i=/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi;while((m=i.exec(text))){if(m[1])addLink(job,m[1],"css",base)}
}
function discoverJs(job,text,base){
  for(const re of [
    /(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g
  ]){let m;while((m=re.exec(text))){if(m[1])addLink(job,m[1],typeFor(m[1]),base)}}
}
function rewriteProxyUrl(url,base,mode){
  const u=normalizeUrl(url,base);if(!u)return url;
  return mode==="view"?`/api/view?url=${encodeURIComponent(u)}`:`/api/resource?url=${encodeURIComponent(u)}`;
}
function injectRuntime(html,original){
  const code=`<script>
(function(){
  window.__VEYRA_PAGE_URL__=${JSON.stringify(original)};
  window.__VEYRA_PROXY_ORIGIN__=location.origin;
  function resolve(v){try{return new URL(typeof v==="string"?v:v&&v.url||"",window.__VEYRA_PAGE_URL__).href}catch{return String(v)}}
  function isOriginalSame(u){try{return new URL(u).origin===new URL(window.__VEYRA_PAGE_URL__).origin}catch{return false}}
  const ofetch=window.fetch;
  if(ofetch)window.fetch=function(input,init){
    const u=resolve(input);
    if(isOriginalSame(u))return ofetch("/api/resource?url="+encodeURIComponent(u),init);
    return ofetch(input,init);
  };
  const XO=XMLHttpRequest.prototype.open, XS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url){this.__veyraURL=resolve(url);this.__veyraMethod=method;return XO.apply(this,[method,isOriginalSame(this.__veyraURL)?"/api/resource?url="+encodeURIComponent(this.__veyraURL):url,...Array.prototype.slice.call(arguments,2)])};
  const hp=history.pushState,hr=history.replaceState;
  history.pushState=function(){const r=hp.apply(this,arguments);try{parent.postMessage({type:"veyra:navigate",url:new URL(location.href).href},"*")}catch{}return r};
  history.replaceState=function(){const r=hr.apply(this,arguments);try{parent.postMessage({type:"veyra:navigate",url:new URL(location.href).href},"*")}catch{}return r};
  addEventListener("load",function(){try{parent.postMessage({type:"veyra:navigate",url:window.__VEYRA_PAGE_URL__},"*")}catch{}});
})();
<\/script>`;
  return html.replace(/<head[^>]*>/i,m=>m+code).replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi,"");
}
function rewriteHtml(html,base){
  const $=cheerio.load(html,{decodeEntities:false});
  $("base").remove();
  $("meta[http-equiv]").filter((_,e)=>String($(e).attr("http-equiv")).toLowerCase()==="content-security-policy").remove();
  $("a[href],area[href]").each((_,e)=>{const u=$(e).attr("href");if(u)$(e).attr("href",rewriteProxyUrl(u,base,"view"))});
  $("form[action]").each((_,e)=>{const u=$(e).attr("action");if(u)$(e).attr("action",rewriteProxyUrl(u,base,"view"))});
  $("link[href]").each((_,e)=>{const u=$(e).attr("href");if(u)$(e).attr("href",rewriteProxyUrl(u,base,String($(e).attr("rel")||"").toLowerCase().includes("stylesheet")?"resource":"resource"))});
  $("script[src]").each((_,e)=>{const u=$(e).attr("src");if(u)$(e).attr("src",rewriteProxyUrl(u,base,"resource"))});
  ["img","source","iframe","audio","input"].forEach(tag=>$(tag+"[src]").each((_,e)=>{const u=$(e).attr("src");if(u)$(e).attr("src",rewriteProxyUrl(u,base,"resource"))}));
  $("video[poster]").each((_,e)=>{const u=$(e).attr("poster");if(u)$(e).attr("poster",rewriteProxyUrl(u,base,"resource"))});
  $("object[data]").each((_,e)=>{const u=$(e).attr("data");if(u)$(e).attr("data",rewriteProxyUrl(u,base,"resource"))});
  $("[srcset]").each((_,e)=>{const raw=$(e).attr("srcset")||"";const out=raw.split(",").map(x=>{const p=x.trim().split(/\s+/);p[0]=rewriteProxyUrl(p[0],base,"resource");return p.join(" ")}).join(", ");$(e).attr("srcset",out)});
  $("style").each((_,e)=>$(e).html(rewriteCss($(e).html()||"",base)));
  $("[style]").each((_,e)=>$(e).attr("style",rewriteCss($(e).attr("style")||"",base)));
  const out=$.html();return injectRuntime(out,base);
}
function rewriteCss(text,base){
  return text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi,(m,u)=>`url("${rewriteProxyUrl(u.trim(),base,"resource")}")`)
             .replace(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi,(m,u)=>`@import "${rewriteProxyUrl(u.trim(),base,"resource")}"`);
}
async function cacheGet(url){
  const x=cache.get(url);
  if(!x)return null;
  if(Date.now()-x.time>CFG.proxyCacheMs){cache.delete(url);return null}
  return x.value;
}
function cacheSet(url,value){
  cache.set(url,{time:Date.now(),value});
  while(cache.size>CFG.maxCacheEntries){cache.delete(cache.keys().next().value)}
}
async function fetchCached(url){
  const c=await cacheGet(url);if(c)return c;
  const v=await fetchBuffer(url);cacheSet(url,v);return v;
}
async function processItem(job,item){
  const key=item.type+"|"+item.url;if(job.visited.has(key))return;
  job.visited.add(key);
  if(item.type==="html"&&(!sameOrigin(item.url,job.root)||!robotsAllowed(item.url,job.robots)))return;
  try{
    const r=await fetchCached(item.url);
    const text=r.body.toString("utf8");
    const res={id:job.resources.length,url:r.finalUrl||item.url,requestedUrl:item.url,type:typeFor(r.finalUrl||item.url,item.type),status:r.status,contentType:r.contentType,bytes:r.bytes,bytesLabel:bytesLabel(r.bytes),truncated:r.truncated,sourceId:item.source||null,text};
    job.resources.push(res);job.resourceByUrl.set(item.url,res);
    const l=job.links.find(x=>x.url===res.url||x.url===item.url);if(l)l.captured=true;
    if(res.type==="html")discoverHtml(job,text,res.url);
    else if(res.type==="css")discoverCss(job,text,res.url);
    else if(res.type==="js")discoverJs(job,text,res.url);
    if(res.type==="html")job.counts.htmlPages++;else if(res.type==="css")job.counts.css++;else if(res.type==="js")job.counts.js++;
    log(job,"debug",`Captured ${res.type.toUpperCase()} ${item.url}`);
  }catch(e){log(job,"error",`Fetch failed ${item.url} — ${e.message}`)}
  job.processed++;
}
async function worker(job,type){
  while(!job.stop&&job.processed<CFG.maxUrls){
    const item=type==="html"?job.pageQueue.shift():job.assetQueue.shift();
    if(!item){if(job.pageQueue.length||job.assetQueue.length||job.activeWorkers){await new Promise(r=>setTimeout(r,15));continue}break}
    job.activeWorkers++;try{await processItem(job,item)}finally{job.activeWorkers--}
  }
}
async function runCrawl(job){
  await loadRobots(job);
  for(const s of job.sitemaps.slice(0,10)){try{const r=await fetchCached(s);for(const m of r.body.toString("utf8").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)){addLink(job,m[1],"html",s)}}catch{}}
  addLink(job,job.root,"html",null);
  await new Promise(r=>setTimeout(r,0));
  const workers=[...Array(CFG.htmlWorkers)].map(()=>worker(job,"html")).concat([...Array(CFG.assetWorkers)].map(()=>worker(job,"asset")));
  while(!job.stop&&(job.pageQueue.length||job.assetQueue.length||job.activeWorkers)&&job.processed<CFG.maxUrls)await new Promise(r=>setTimeout(r,40));
  await Promise.allSettled(workers);
  job.done=true;job.finishedAt=now();
  if(job.stop){job.status="stopped";job.statusText="Stopped by user.";log(job,"warn","Crawler stopped.")}
  else if(job.processed>=CFG.maxUrls){job.status="done";job.statusText=`Finished at the ${CFG.maxUrls.toLocaleString()} URL safety limit.`;log(job,"warn","URL safety limit reached.")}
  else{job.status="done";job.statusText=`Crawler finished — ${job.processed.toLocaleString()} resources processed.`;log(job,"info","Queue exhausted.")}
}
function createJob(root){
  const id=crypto.randomUUID();
  return {id,url:root,root,createdAt:now(),finishedAt:null,done:false,stop:false,status:"running",statusText:"Crawling…",
    pageQueue:[],assetQueue:[],visited:new Set(),discovered:new Set(),resources:[],resourceByUrl:new Map(),links:[],robots:null,sitemaps:[],
    logs:[],logSeq:0,activeWorkers:0,processed:0,counts:{htmlPages:0,css:0,js:0,links:0}};
}
function getOrCreateJob(root){
  const oldId=activeByRoot.get(root);const old=oldId&&jobs.get(oldId);
  if(old&&!old.done&&!old.stop)return old;
  if([...jobs.values()].filter(j=>!j.done&&!j.stop).length>=3)throw new Error("Crawler capacity is busy; wait for a crawl to finish.");
  const job=createJob(root);jobs.set(job.id,job);activeByRoot.set(root,job.id);
  runCrawl(job).catch(e=>{job.done=true;job.status="error";job.statusText=e.message;job.finishedAt=now();log(job,"error",e.stack||e.message)});
  return job;
}
function publicJob(job){return {id:job.id,url:job.url,createdAt:job.createdAt,finishedAt:job.finishedAt,done:job.done,status:job.status,statusText:job.statusText,maxUrls:CFG.maxUrls,counts:{...job.counts,processed:job.processed,queued:job.pageQueue.length+job.assetQueue.length,active:job.activeWorkers},logs:job.logs.slice(-120)}}

app.get("/health",(req,res)=>res.json({ok:true,service:"veyra-browse-crawler",time:now()}));

app.post("/api/open",async(req,res)=>{
  try{
    const root=normalizeUrl(String(req.body?.url||""));
    if(!root)throw new Error("Please provide a valid public HTTP(S) URL.");
    await assertPublicUrl(root);
    const job=getOrCreateJob(root);
    res.status(202).json({jobId:job.id,url:root,viewUrl:"/api/view?url="+encodeURIComponent(root)});
  }catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/view",async(req,res)=>{
  try{
    const url=normalizeUrl(String(req.query.url||""));
    if(!url)throw new Error("Missing URL.");
    await assertPublicUrl(url);
    const r=await fetchCached(url);
    const type=r.contentType.toLowerCase();
    if(type.includes("text/html")||type.includes("application/xhtml+xml")||type===""||type.includes("text/plain")){
      const html=rewriteHtml(r.body.toString("utf8"),r.finalUrl||url);
      res.setHeader("content-type","text/html; charset=utf-8");
      res.setHeader("cache-control","no-store");
      return res.status(r.status||200).send(html);
    }
    res.setHeader("content-type",r.contentType||"application/octet-stream");
    res.setHeader("cache-control","no-store");
    return res.status(r.status||200).send(r.body);
  }catch(e){res.status(502).type("text/plain").send("Veyra Browse could not load this page.\n\n"+e.message)}
});

app.get("/api/resource",async(req,res)=>{
  try{
    const url=normalizeUrl(String(req.query.url||""));
    if(!url)throw new Error("Missing URL.");
    await assertPublicUrl(url);
    const r=await fetchCached(url);
    res.setHeader("content-type",r.contentType||"application/octet-stream");
    res.setHeader("cache-control","public,max-age=15");
    return res.status(r.status||200).send(r.body);
  }catch(e){res.status(502).type("text/plain").send("Veyra resource error: "+e.message)}
});

app.get("/api/crawl/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json(publicJob(j))});
app.post("/api/crawl/:id/stop",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});j.stop=true;j.status="stopping";j.statusText="Stopping…";log(j,"warn","Stop requested.");res.json({ok:true})});
app.get("/api/crawl/:id/resources",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json({resources:j.resources.map(r=>({id:r.id,url:r.url,type:r.type,status:r.status,bytes:r.bytes,bytesLabel:r.bytesLabel,truncated:r.truncated,sourceId:r.sourceId}))})});
app.get("/api/crawl/:id/source/:resourceId",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});const r=j.resources[Number(req.params.resourceId)];if(!r)return res.status(404).json({error:"Resource not found"});res.json({id:r.id,url:r.url,type:r.type,source:r.text})});
app.get("/api/crawl/:id/links",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json({links:j.links})});
app.get("/api/crawl/:id/export",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("content-disposition",`attachment; filename="veyra-${j.id}.json"`);res.send(JSON.stringify({id:j.id,root:j.root,createdAt:j.createdAt,finishedAt:j.finishedAt,status:j.status,counts:j.counts,links:j.links,resources:j.resources.map(r=>({id:r.id,url:r.url,type:r.type,status:r.status,contentType:r.contentType,bytes:r.bytes,truncated:r.truncated,source:r.text}))},null,2))});

setInterval(()=>{
  const cutoff=Date.now()-CFG.maxJobAgeMs;
  for(const [id,j] of jobs)if(j.done&&new Date(j.finishedAt||j.createdAt).getTime()<cutoff){jobs.delete(id);if(activeByRoot.get(j.root)===id)activeByRoot.delete(j.root)}
},60_000).unref();

app.listen(PORT,"0.0.0.0",()=>console.log(`Veyra Browse API listening on ${PORT}`));
