# Veyra Browser backend v8.4.2

This release keeps the existing Express + crawler/proxy architecture and splits work into three cooperating layers: the crawler robot mesh, the interactive browser request scheduler, and the proxy warm-resource pool.

## Cooperative crawler robot mesh
- `CRAWLER_ROBOTS` is a logical fleet, up to 1,000 robots.
- `ROBOT_TASK_CAPACITY` gives every robot a small local queue.
- `ROBOT_ACTIVE_TASKS` allows each robot to multitask without bypassing the real network ceiling.
- After a robot finishes and becomes idle, it inspects the mesh and requests help.
- A busy robot explicitly decides whether to accept or decline the request.
- Accepted work is transferred as a task, marked as helped, and tracked in the robot telemetry.
- Load buckets and O(1)-style receiver selection avoid repeatedly scanning/copying a 1,000-robot array.
- `/api/crawl/:id/robots` exposes robot states, help requests, decisions, task sharing, and recent mesh events.

## Interactive browser engine
The browser is no longer treated as just another crawler consumer.

- Foreground page/resource requests use a dedicated priority scheduler.
- Document requests have the highest priority, followed by CSS/JS/SVG/fonts, images, and lower-priority resources.
- Identical in-flight browser requests are deduplicated.
- Browser per-host concurrency is independent from crawler concurrency.
- Browser requests cannot consume the crawler's network semaphore.
- The page keeps its Veyra session/cookie context while the browser lane handles navigation and resource requests.
- Proxy warm resources remain a separate low-priority pool so warming cannot replace foreground work.
- The injected runtime also handles fetch, XHR, EventSource, sendBeacon, programmatic form submission, history, navigation, popups, page console, and page errors where technically safe.

## Why 1,000 robots is not 1,000 sockets
`CRAWLER_ROBOTS=1000` means 1,000 scheduling agents, not 1,000 simultaneous upstream connections. `MAX_ACTIVE_FETCHES` is the actual crawler network ceiling and `CRAWLER_PER_HOST_CONCURRENCY` limits load on any one host. This is intentional for CPU/RAM/network efficiency and responsible crawling.

## Speed controls
Recommended Render starting values for the existing Free Web Service:

```text
CRAWLER_ROBOTS=1000
ROBOT_TASK_CAPACITY=4
ROBOT_ACTIVE_TASKS=2
ROBOT_HELP_ENABLED=true
ROBOT_HELP_THRESHOLD=2
ROBOT_HELP_COOLDOWN_MS=250
ROBOT_HELP_SCAN_LIMIT=24

MAX_ACTIVE_FETCHES=128
CRAWLER_PER_HOST_CONCURRENCY=8

BROWSER_MAX_ACTIVE_FETCHES=24
BROWSER_PER_HOST_CONCURRENCY=8
```

Increase real network slots only after checking Render CPU/RAM and `/dev` telemetry. More logical robots primarily improve scheduling and work sharing; they do not override remote-server limits, robots.txt or challenge responses.

## Diagnostics
- `/status` — effective environment configuration and warnings
- `/console` — standalone server/browser diagnostic log
- `/api/debug/system` — memory, jobs, crawler lane, browser lane and cache metrics
- `/api/crawl/:id/robots` — cooperative robot mesh telemetry

Run:

```text
npm install
npm test
npm start
```


## v8.5 cooperative mesh
`CRAWLER_ROBOTS` is the logical fleet size. `ROBOT_WORKSET_SIZE` limits the active scheduling workset so a 1,000-robot fleet remains cheap to manage. Idle robots may request spare queued work; target robots explicitly accept or decline before task transfer. Actual upstream concurrency remains controlled by `MAX_ACTIVE_FETCHES` and the per-host limit.

The proxy/browser lane is separate from background crawl work. Foreground document/resource requests are prioritized so browser interaction does not wait behind indexing.

## v8.5 browser subsystem and robot mesh refinement
The 1,000-robot logical fleet can run up to four active tasks per robot (bounded by shared network slots), and idle or lightly-loaded robots can request spare work from another robot. A target robot evaluates backlog/health/cooldown and explicitly accepts or declines the request before queued tasks are transferred. The frontier is host-aware so a large blocked queue on one origin does not force repeated scans of every queued item.

The proxy endpoint `/api/download` now marks the response as an attachment and enforces `MAX_DOWNLOAD_BYTES`. The browser UI includes custom downloads (Ctrl+J), local history (Ctrl+H), inspect mode (Ctrl+Shift+I), find-in-page (Ctrl+F), print (Ctrl+P), a tools dropdown, an extension store/developer mode and a loading Stop button.

### Browser/API compatibility (v8.6)

The proxy forwards a bounded allow-list of public web-app compatibility headers used by modern JavaScript APIs (including YouTube/Google-style `x-youtube-*` / `x-goog-*` client headers and browser client hints). Cookies and Authorization headers remain separately controlled and are never blindly forwarded. API-like browser requests receive higher priority and a larger bounded request-body allowance.
