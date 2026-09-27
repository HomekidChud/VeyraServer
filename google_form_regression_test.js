const fs=require("fs");
const s=fs.readFileSync(__dirname+"/server.js","utf8");
function must(x,m){if(!x)throw new Error(m)}
must(s.includes('app.get("/api/form-get/:target/:sid"'), 'GET form route missing');
must(s.includes('makeGetFormProxyAction'), 'GET form proxy action helper missing');
must(s.includes('$(el).attr("action", makeGetFormProxyAction(u, sid))'), 'GET forms are not rewritten to proxy route');
must(s.includes('$(el).attr("formaction", submitMethod === "POST" ? makeViewUrl(u, sid) : makeGetFormProxyAction(u, sid))'), 'formaction is not protected');
must(s.includes('req.query.url = u.href'), 'form route does not reconstruct final URL');
console.log('PASS Google GET-form navigation stays inside Veyra proxy');
