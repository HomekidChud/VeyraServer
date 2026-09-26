# Veyra Browse — Render crawler v6

This repository contains ONLY the Node.js server. GitHub Pages hosts the Veyra
Browse frontend.

### What v6 does

- Displays pages through `/api/view` while the crawl runs independently.
- 24 parallel HTML workers + 36 CSS/JS workers.
- Recursive same-origin crawl until the frontier is exhausted.
- Reads robots.txt and recursively discovers sitemap files.
- De-duplicates URLs and removes common tracking query parameters.
- Scans up to **2 GiB per crawl job** by default.
- Supports up to **100,000 HTML pages** and **125,000 crawled text resources** per job.
- Indexes up to **750,000 discovered links** per job.
- Stores HTML/CSS/JS source on disk instead of keeping all source bodies in RAM.
- Binary assets are indexed but fetched on-demand by the browser proxy, which saves
  crawler bandwidth and memory.
- `/api/crawl/:id/links` supports offset/limit pagination.
- `/api/crawl/:id/source/:resourceId` loads source from disk.
- Includes SSRF protection against private/local network destinations.
- Keeps the frontend configuration-free.

### Render

Use a **Web Service**.

Build command:
`npm install`

Start command:
`npm start`

The current free Render service has 512 MB RAM and 0.1 CPU and uses an ephemeral
filesystem; local files disappear when the service restarts or spins down.
For truly large/long-running crawls and persistent multi-GB source storage, use a
paid compute plan and persistent disk or an external object store. Render documents
that persistent disks are available to paid services and that free services cannot
attach them. See the Render docs.
