# Coordinate Review Bundle (Firebase Frontend)

Current default flow in this repo:

- `review_site/` runs on GitHub Pages
- Firebase Auth controls sign-in
- Firestore stores unresolved stations and saved coordinates

## Files to edit first

1. `review_site/firebase-config.js`
   - paste your Firebase web config
   - optionally add allowed reviewer emails

## Data import helper

- `scripts/firebase/build_unresolved_rich_feed.py`
  - builds `data/review/unresolved_stations_rich.json` from:
    - `data/derived/sveltekit_app_seed/stations.csv`
    - `data/derived/sveltekit_app_seed/station_admin_membership.csv`
- `scripts/firebase/import_unresolved_to_firestore.mjs`
  - safe upsert into Firestore `stations`
  - preserves already reviewed docs (`status=done` or existing coordinates)

## Legacy backend files

The repo still contains backend deployment files from the older Render/Railway path:

- `scripts/review/run_coordinate_review_server.py`
- `Procfile`
- `render.yaml`

You can ignore them if you are using Firebase-only hosting.
