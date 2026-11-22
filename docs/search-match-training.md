# Veyra search match training

## Search result scoring

Veyra scores every candidate in each returned result batch from 1 to 100. This is an estimate of query match, not a calibrated probability, a quality rating, or proof that a video plays. The deployed scorer uses title, snippet, caption, alt text and source URL terms when available. It mixes deterministic matching with a small supervised model. Later pages are scored locally to their batch and appended, without reshuffling earlier pages.

Run `npm run evaluate:search-match` for the reproducible bundled checkpoint evaluation. Run `node scripts/train-search-match.js judgments.json` to evaluate a separately labeled corpus and print its checkpoint, or `node scripts/train-search-match.js --write` to regenerate only the bundled checkpoint. Review external checkpoints separately before deployment. Use a single JSON object with `train` and `holdout` arrays of groups:

```json
{
  "category": "videos",
  "query": "lunar eclipse time lapse",
  "results": [
    { "title": "Lunar eclipse time lapse", "snippet": "Full event replay", "relevant": true },
    { "title": "Solar eclipse time lapse", "relevant": false }
  ]
}
```

Include independently rated positives and negatives for each query. The trainer consumes every rated row. Split overlapping topics and near-duplicate queries by group before running the tool, even where the literal query strings differ. Evaluate result ordering against the metadata baseline before enabling a checkpoint. Being returned, ranked, or unclicked does not determine relevance. This change adds no visitor search collection or automatic learning from live requests, and does not replace Veyra's existing crawler-priority model.

## Image and video training

Use an updated FFmpeg and locally staged files you own or have permission to use for training. The offline trainer reads image pixels and samples up to eight RGB frames from the first 16 seconds of video. It extracts color, layout, edge, and frame-to-frame change features and trains a small supervised classifier, with separate held-out image and video scores. It does not infer semantic similarity between queries and media, scrape media providers, download URLs, or modify live rankings.

First create the restricted [media rights ledger](media-rights-ledger.md) and run preflight. A free-form manifest permission note is no longer accepted. Create a manifest JSON array in the corpus directory, with both training and holdout groups and both splits represented in every class. Each item uses this shape:

```json
{
  "assetId": "clip-017",
  "file": "approved/clip.mp4",
  "kind": "videos",
  "label": "outdoors",
  "split": "train",
  "group": "shoot-17"
}
```

Use `images` for JPG, PNG, WebP, or PPM and `videos` for MP4, MOV, WebM, or MKV. Group all related assets, edits, clips and adjacent shots together; never split one source production across train and holdout. The CLI also rejects exact duplicates. Train in a restricted offline environment with the approved corpus staged separately from private data. Keep licenses and any required attribution with the data, not in published model files.

```sh
npm run check:visual-rights -- /private/corpus/manifest.json /private/corpus/rights-ledger.json
node scripts/train-visual-ranker.js /private/corpus/manifest.json /private/corpus/rights-ledger.json /private/run/visual-model.json
npm run test:visual-ranker
```

The test generates synthetic media locally and checks that real pixels and multiple decoded video frames affect the model. It is a plumbing check, not a generalization benchmark. Before using visual signals in live search, evaluate on a larger rights-cleared corpus with independent query-to-media judgments and test that the combined ranker beats the metadata baseline. A semantic image-text/video-text model would be a separate upgrade.
