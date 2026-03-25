# Coordinate Review Bundle (Backend Save)

Use this bundle for a simple hosted review tool with direct API save.

## Included

- `review_site/` web UI
- `data/review/unresolved_stations.json` unresolved queue
- `data/review/coordinate_manual_overrides.csv` saved overrides
- `scripts/review/run_coordinate_review_server.py` backend API + static host
- `Procfile` startup command for Railway/Heroku-style hosts
- `render.yaml` optional Render blueprint
- `scripts/review/DEPLOY.md` deployment guide

## Why this version

- No GitHub token in browser code.
- One-click save from UI (`/api/save-coordinate`).
- Optional HTTP basic auth for reviewer access.

## Quick start

```bash
REVIEW_UNRESOLVED_FEED_PATH=data/review/unresolved_stations.json \
REVIEW_OVERRIDES_PATH=data/review/coordinate_manual_overrides.csv \
REVIEW_STATIC_DIR=review_site \
REVIEW_AUTH_USER=reviewer \
REVIEW_AUTH_PASSWORD=strong-password \
python3 scripts/review/run_coordinate_review_server.py --host 0.0.0.0
```

Then open:

- `http://127.0.0.1:8011`
