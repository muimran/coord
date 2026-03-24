# GitHub Coordinate Review Bundle

Copy this folder structure into your GitHub repo root.

It contains:
- `review_site/` static review UI for GitHub Pages
- `data/review/unresolved_stations.json` unresolved coordinate queue
- `data/review/coordinate_manual_overrides.csv` saved overrides log
- `.github/workflows/save-coordinate.yml` workflow to upsert a saved coordinate

The frontend is static. It needs a secure endpoint that triggers the GitHub Action with
`workflow_dispatch` inputs.

If you are willing to accept the security risk, you can skip the secure endpoint and call the
GitHub Actions workflow directly from the browser by putting a fine-grained GitHub token into
`review_site/config.js`.

After copying:
1. Edit `review_site/config.js`
2. Paste a fine-grained GitHub token into `githubToken`
3. Keep `githubDispatchUrl` pointing at your repo workflow
4. Enable GitHub Pages
5. Accept that anyone who inspects the frontend can reuse that token
