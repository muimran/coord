# GitHub Coordinate Review Bundle

Copy this folder structure into your GitHub repo root.

It contains:
- `review_site/` static review UI for GitHub Pages
- `data/review/unresolved_stations.json` unresolved coordinate queue
- `data/review/coordinate_manual_overrides.csv` saved overrides log
- `.github/workflows/save-coordinate.yml` workflow to upsert a saved coordinate

The frontend is static. It needs a secure endpoint that triggers the GitHub Action with
`workflow_dispatch` inputs.

After copying:
1. Edit `review_site/config.js`
2. Set your real secure save endpoint URL
3. Enable GitHub Pages
4. Add the workflow file
5. Configure your secure endpoint with a GitHub token
