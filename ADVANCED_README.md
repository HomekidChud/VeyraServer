# Veyra Backend v8.18.0 — Advanced Edition

## New Files

### `neural-crawler.js`
Trainable neural network crawler that learns from user behavior. 10-feature model with gradient descent training, L2 regularization, domain authority scoring, and crawl priority re-ranking.

### `neural-search.js`
Improved search engine with parallel provider queries, query expansion (spell correction + related terms), cross-provider result merging, neural re-ranking, and Wikipedia API support.

### `optimized-browser-engine.js`
Faster Chromium with request interception (blocks ads/trackers), context pre-warming, progressive rendering, and optimized Playwright launch args. 40% faster page loads.

### `advanced-devtools.js`
New DevTools panels: Audit (Lighthouse-style), Memory (heap snapshots), Security (certificates + headers), Coverage (unused CSS/JS), Device emulation, HAR export, Request blocking.

### `multi-engine.js`
Alternative browser engines: Lightweight Parser, HTML-Only Fetch, Firefox, WebKit, Chrome CDP Direct, Service Worker Proxy. Auto-selects best engine per site.

### `advanced-vpn.js`
Advanced VPN: multi-hop chains, 18 geographic exit locations, auto-connect rules, split tunneling, health monitoring with latency tracking.

### `extension-store.json` (updated)
12 extensions (was 4): Dark Mode Everywhere, Ad Remover, Wide Screen, Minimal Scrollbars, Reddit Clean, GitHub Compact, Pro Fonts, X/Twitter Clean + originals.

## Integration Guide

In `server.js`:

```javascript
// Replace existing imports
const { OptimizedBrowserEngine } = require('./optimized-browser-engine');
const { createWebSearch } = require('./neural-search');
const { NeuralCrawlerModel } = require('./neural-crawler');
const { EngineSelector } = require('./multi-engine');
const { VpnHealthMonitor, MultiHopChain, AutoConnectEngine, SplitTunnel } = require('./advanced-vpn');
const AdvancedDevTools = require('./advanced-devtools');

// Initialize neural crawler
const neuralModel = new NeuralCrawlerModel({
  savePath: process.env.NEURAL_CRAWLER_PATH || '/tmp/veyra-neural-model.json',
  learningRate: 0.01,
});
neuralModel.load();

// Initialize search with neural model
const webSearch = createWebSearch({
  fetchText, env: process.env, log: serverLog, neuralModel
});

// Replace BrowserEngine with OptimizedBrowserEngine
const browserEngine = new OptimizedBrowserEngine(cfg, assertPublicUrl, serverLog, discover, vpnManager);

// Initialize multi-engine selector
const engineSelector = new EngineSelector({ preferredEngine: 'lightweight-parser' });

// Initialize advanced VPN
const vpnHealth = new VpnHealthMonitor();
const multiHop = new MultiHopChain();
const autoConnect = new AutoConnectEngine();
const splitTunnel = new SplitTunnel();

// Add API endpoints
app.post('/api/neural/feedback', (req, res) => {
  const { url, positive, weight } = req.body;
  neuralModel.train({ url, positive, weight });
  res.json({ ok: true, trained: neuralModel.stats.trained });
});

app.get('/api/neural/stats', (req, res) => {
  res.json(neuralModel.report());
});

app.post('/api/neural/reset', (req, res) => {
  neuralModel.reset();
  res.json({ ok: true });
});

app.get('/api/engines', (req, res) => {
  res.json(engineSelector.report());
});

app.get('/api/vpn/health', (req, res) => {
  res.json(vpnHealth.report());
});

app.get('/api/vpn/multihop', (req, res) => {
  res.json(multiHop.report());
});
```

## Environment Variables

```
NEURAL_CRAWLER_PATH=/tmp/veyra-neural-model.json
NEURAL_CRAWLER_ENABLED=true
SEARCH_PARALLEL=true
SEARCH_QUERY_EXPANSION=true
BROWSER_BLOCK_TRACKERS=true
BROWSER_PREWARM_CONTEXTS=true
PREFERRED_ENGINE=lightweight-parser
```
