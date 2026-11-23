# Offline crawler training

This trainer learns which public HTML URLs to prioritize from URL and discovery context features. It does not learn from post bodies, images, audio or video, and it does not train the AI answer generator or the separate vertical search ranker.

## Prepare permissioned examples

Use public URL metadata from sites you own or whose terms or written permission allow your use for training. Keep a private rights ledger and reference it by ID. Public visibility, API access and permission to index are not substitutes for training rights. The importer checks that you recorded a rights basis, not whether it is valid. Do not provide credentials, private pages, browsing logs, query strings or raw media.

Put the examples in a local JSON file outside the repository. Label each pair with a useful crawl destination and a manually validated dead end. `internal` records whether the link was discovered within the same site. Assign a stable publisher and topic identifier to each pair. Keep all domains and subdomains owned by the same publisher under a single publisher identifier. Group near-duplicate topics before splitting; the tool checks repeated identifiers and hosts, not semantic similarity.

```json
{
  "schemaVersion": 1,
  "datasetId": "publisher-review-v1",
  "pairs": [
    {
      "split": "train",
      "publisher": "publisher-a",
      "topic": "transit",
      "rights": "owned",
      "rightsReference": "ledger-001",
      "useful": {"url": "https://library.example.org/docs/transit-guide", "internal": true},
      "deadEnd": {"url": "https://library.example.org/archive/removed", "internal": true}
    },
    {
      "split": "holdout",
      "publisher": "publisher-b",
      "topic": "weather",
      "rights": "explicit-permission",
      "rightsReference": "ledger-002",
      "useful": {"url": "https://weather.example.net/reference/readings", "internal": false},
      "deadEnd": {"url": "https://weather.example.net/legacy/missing", "internal": false}
    }
  ]
}
```

This is a format example, not a useful training set. Allowed rights values are `owned`, `licensed` and `explicit-permission`. Real holdouts need enough independent publishers, topics and examples to catch overfitting and shortcuts.

## Train and evaluate

```sh
npm run evaluate:neural -- --dataset /private/veyra-labelled-v1.json
npm run evaluate:neural -- --dataset /private/veyra-labelled-v1.json \
  --candidate-out /private/crawler-v1.candidate.json
```

The command reads the file locally, starts from fresh weights, runs five passes over the training split, and reports held-out pair accuracy and log loss before and after. It never fetches the listed URLs. The optional output is a version-2 crawler checkpoint with aggregate evaluation metrics, not URLs or rights records. It only creates a new `.candidate.json` file and does not install it.

A win over untrained weights does not establish better production search. Before promoting a candidate, compare it with current weights and heuristic ranking on an untouched labelled set, verify crawl coverage by publisher and topic, and keep a staging rollback checkpoint. Do not reuse the final holdout to tune weights or label rules.
