# Coordinate Review Deployment

## What to deploy

Minimum files needed:

- `review_site/index.html`
- `review_site/app.js`
- `review_site/styles.css`
- `data/review/unresolved_stations.json`
- `data/review/coordinate_manual_overrides.csv`
- `scripts/review/run_coordinate_review_server.py`
- `Procfile` (for Railway/Heroku-style startup)

Optional:

- `render.yaml` for Render blueprint deployment

## Server behavior

The server supports two data modes:

1. **Feed mode (recommended for hosting)**
- Reads unresolved station queue from `REVIEW_UNRESOLVED_FEED_PATH` (JSON list).
- Writes manual saves to `REVIEW_OVERRIDES_PATH` (CSV).

2. **CSV mode**
- Reads from `REVIEW_STATIONS_PATH` and `REVIEW_MEMBERSHIP_PATH`.
- Still writes saves only to `REVIEW_OVERRIDES_PATH`.

## Required environment variables (public deployment)

- `REVIEW_UNRESOLVED_FEED_PATH=data/review/unresolved_stations.json`
- `REVIEW_OVERRIDES_PATH=data/review/coordinate_manual_overrides.csv`
- `REVIEW_STATIC_DIR=review_site`
- `REVIEW_AUTH_USER=<username>`
- `REVIEW_AUTH_PASSWORD=<strong-password>`

Optional:

- `REVIEW_WITH_EXACT_HINT=40028`

## Run locally

```bash
python3 scripts/review/run_coordinate_review_server.py --host 127.0.0.1 --port 8011
```

## Render

If using `render.yaml`, set `REVIEW_AUTH_USER` and `REVIEW_AUTH_PASSWORD` in the Render dashboard as secret env vars.

## Railway

Set start command:

```bash
python3 scripts/review/run_coordinate_review_server.py --host 0.0.0.0
```

Railway provides `PORT` automatically.
