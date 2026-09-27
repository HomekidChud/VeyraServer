const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
const frontend = fs.readFileSync(path.join(root, '..', 'frontend', 'app.js'), 'utf8');
const core = fs.readFileSync(path.join(root, '..', 'frontend', 'core.js'), 'utf8');

assert(server.includes('frontendUrl: process.env.VEYRA_FRONTEND_URL || "https://homekidchud.github.io/VeyraBrowser/"'), 'server must define configurable frontend URL');
assert(server.includes('target.searchParams.set("veyra_route", "/dev")'), 'status handoff must target frontend /dev');
assert(server.includes('return res.redirect(302, target.toString());'), 'status handoff must redirect');
assert(server.includes('if (!CFG.adminGate || isAdminRequest(req)) return next();'), 'valid admin/header requests must retain direct status page access');
assert(render.includes('key: VEYRA_FRONTEND_URL'), 'Render config must define frontend URL');
assert(render.includes('value: https://homekidchud.github.io/VeyraBrowser/'), 'Render config must point to current frontend');
assert(frontend.includes('dev: { title: "Veyra dev"'), 'frontend must expose the admin dev view');
assert(frontend.includes('dev: "dev"') || frontend.includes('dev: "dev"'), 'frontend must support the dev view');
assert(core.includes('if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);'), 'frontend API must attach auth token to API requests');
console.log('Status handoff regression tests passed.');
