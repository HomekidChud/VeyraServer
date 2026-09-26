# Veyra Browse — Render backend

This repository contains ONLY the Node server.

Files:
- server.js
- package.json

Render runs this as a public Web Service. GitHub Pages hosts the Veyra Browse UI.

The backend provides:
- `/api/open` to start/reuse a server-side crawl and return a page-view URL
- `/api/view` to proxy/rewrite HTML for the browser view
- `/api/resource` to proxy page assets
- `/api/crawl/...` for crawl status, sources, links, logs, and export
- `/health` for health checks

No frontend HTML/CSS/JS belongs in this repository.
