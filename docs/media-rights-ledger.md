# Offline media rights ledger

Use this preflight before decoding an image or video for the offline visual trainer. It verifies that each selected file matches an approved record; it does not establish legal permission by itself. A reviewer must verify the underlying permissions and any third-party rights before marking a record approved.

## Create a restricted inventory

Keep the ledger, evidence, asset manifest, media and checkpoint outside the checkout and away from production systems. Start with own work, commissioned work with written rights, verified CC0, or verified public-domain material. Do not bring in visitor uploads or logs, scraped social media, login-restricted files, private material, or imagery of minors. Exclude identifiable people, logos, third-party audio and footage unless a reviewer confirms and records independent clearance and the pilot's source restrictions still allow the asset. Audio is not decoded by this trainer.

Use a JSON file in this form. Placeholder values, especially the hash and evidence references, must be replaced with actual reviewed records.

```json
{
  "schemaVersion": 1,
  "ledgerId": "pilot-v1",
  "assets": [
    {
      "assetId": "clip-017",
      "group": "shoot-17",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "creator": "Internal production team",
      "sourceType": "self-produced",
      "origin": "internal:productions/shoot-17",
      "license": { "identifier": "signed-production-agreement", "version": "1" },
      "review": {
        "status": "approved",
        "reviewer": "internal-reviewer-01",
        "reviewedOn": "2026-11-22",
        "evidenceRefs": ["internal:permissions/shoot-17"],
        "thirdPartyRights": "none"
      },
      "allowedUses": ["training", "evaluation"],
      "territories": ["worldwide"],
      "expiresOn": null,
      "attribution": { "required": false, "text": "" }
    }
  ],
  "denylist": []
}
```

- **Identity:** Hash the exact staged bytes with `sha256sum`. Assign an opaque asset ID. Use the same source/production group for originals and derivatives; each distinct file still needs its own SHA-256 and record. The trainer rejects duplicate bytes and groups that cross the train/holdout boundary. A reviewer must group near-duplicates the hash cannot detect.
- **Provenance:** `sourceType` accepts `self-produced`, `commissioned`, `cc0` or `public-domain` for this pilot. `origin` is an HTTPS source address or an `internal:` reference. Evidence references are IDs in a restricted register, never paths the trainer reads. If `thirdPartyRights` is `cleared`, `thirdPartyEvidenceRefs` is required alongside the main evidence. `unresolved` blocks use.
- **Scope:** The `train` split needs `training`; `holdout` needs `evaluation`. `expiresOn` is `null` for no recorded expiry or the last permitted UTC date. Territory-limited permissions cannot pass this pilot, which does not verify compute jurisdiction. Record attribution text where required and retain it with the data. Neither allowed use grants permission to release assets or weights.
- **Removals:** Use `pending`, `denied` or `revoked` when approval is not valid. Also include the affected `assetId`, `sha256`, or both in `denylist` with an `internal:` `reasonRef`, and assign a new ledger ID. Quarantine the affected media, derived artifacts and dependent checkpoints. Rebuild only after cross-checking all related asset IDs and snapshots against the current denylist.

## Preflight and train

```sh
npm run check:visual-rights -- /private/corpus/manifest.json /private/corpus/rights-ledger.json
node scripts/train-visual-ranker.js /private/corpus/manifest.json /private/corpus/rights-ledger.json /private/run/visual-model.json
```

The preflight reads file bytes to check their hashes but does not call FFmpeg. Training requires the same preflight and rechecks the exact bytes it gives the decoder. Use network-isolated compute and protected scratch storage (`TMPDIR`); seekable copies are removed after decoding, but a forced process kill may require operator cleanup. Archive the frozen manifest and ledger by digest in the restricted register. The checkpoint records the ledger digest and asset IDs, not the approval evidence; share aggregate metrics only unless a separate review permits release.

This gate is the first stage of the evaluation. It adds no live intake or ranking changes, and it does not run the planned metadata-versus-visual relevance benchmark.
