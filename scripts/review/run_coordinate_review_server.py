#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import binascii
import csv
import hmac
import json
import os
import random
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[2]
WRITE_LOCK = threading.Lock()
APP_CONFIG: "AppConfig | None" = None


@dataclass
class AppConfig:
    static_dir: Path
    stations_path: Path | None
    membership_path: Path | None
    unresolved_feed_path: Path | None
    overrides_path: Path
    auth_user: str | None
    auth_password: str | None
    with_exact_coordinates_hint: int | None

    @property
    def has_csv_source(self) -> bool:
        return bool(
            self.stations_path
            and self.membership_path
            and self.stations_path.exists()
            and self.membership_path.exists()
        )

    @property
    def has_feed_source(self) -> bool:
        return bool(self.unresolved_feed_path and self.unresolved_feed_path.exists())


def resolve_path(raw: str | None, fallback: Path | None = None) -> Path | None:
    if raw:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = (PROJECT_ROOT / path).resolve()
        return path
    return fallback


def first_existing(paths: list[Path], default: Path | None = None) -> Path | None:
    for path in paths:
        if path.exists():
            return path
    return default


def read_csv_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        return list(reader.fieldnames or []), rows


def write_csv_rows(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    tmp_path.replace(path)


def require_config() -> AppConfig:
    if APP_CONFIG is None:
        raise RuntimeError("Server config not initialized.")
    return APP_CONFIG


def membership_by_station(config: AppConfig) -> dict[str, dict[str, str]]:
    if not config.membership_path:
        return {}
    _, rows = read_csv_rows(config.membership_path)
    return {row["station_result_id"]: row for row in rows}


def unresolved_station_rows(config: AppConfig) -> list[dict[str, str]]:
    if config.has_feed_source and config.unresolved_feed_path:
        with config.unresolved_feed_path.open(encoding="utf-8-sig") as handle:
            data = json.load(handle)
        if not isinstance(data, list):
            raise ValueError("Unresolved feed must be a JSON list.")
        return [{k: str(v) if v is not None else "" for k, v in row.items()} for row in data if isinstance(row, dict)]

    if not config.has_csv_source or not config.stations_path:
        raise FileNotFoundError(
            "No unresolved feed source found. Provide CSV inputs or REVIEW_UNRESOLVED_FEED_PATH."
        )

    station_fields, stations = read_csv_rows(config.stations_path)
    membership = membership_by_station(config)
    unresolved: list[dict[str, str]] = []
    for row in stations:
        if row.get("has_exact_coordinates") == "1":
            continue
        membership_row = membership.get(row["station_result_id"], {})
        unresolved.append(
            {
                **{field: row.get(field, "") for field in station_fields},
                "assigned_admin_unit_id": membership_row.get("assigned_admin_unit_id", ""),
                "assigned_admin_level": membership_row.get("assigned_admin_level", ""),
                "assigned_admin_name_bn": membership_row.get("assigned_admin_name_bn", ""),
                "assigned_parent_name_bn": membership_row.get("assigned_parent_name_bn", ""),
                "assignment_method": membership_row.get("assignment_method", ""),
                "assignment_confidence": membership_row.get("assignment_confidence", ""),
                "assignment_note": membership_row.get("assignment_note", ""),
            }
        )
    return unresolved


def load_override_rows(config: AppConfig) -> tuple[list[str], list[dict[str, str]]]:
    if not config.overrides_path.exists():
        return (
            [
                "saved_at_utc",
                "station_result_id",
                "center_id",
                "center_serial",
                "constituency_no",
                "constituency_name_bn",
                "district_name_bn",
                "upazilla_name_bn",
                "union_name_bn",
                "municipality_name_bn",
                "union_ward_name_bn",
                "center_name_bn",
                "latitude",
                "longitude",
                "source",
            ],
            [],
        )
    return read_csv_rows(config.overrides_path)


def saved_override_ids(config: AppConfig) -> set[str]:
    _, rows = load_override_rows(config)
    return {row["station_result_id"] for row in rows if row.get("station_result_id")}


def stats_payload(config: AppConfig) -> dict[str, int]:
    override_ids = saved_override_ids(config)

    if config.has_csv_source and config.stations_path:
        _, station_rows = read_csv_rows(config.stations_path)
        total = len(station_rows)
        with_exact = sum(1 for row in station_rows if row.get("has_exact_coordinates") == "1")
        base_missing = total - with_exact
        return {
            "totalStations": total,
            "withExactCoordinates": with_exact,
            "remainingMissingCoordinates": max(base_missing - len(override_ids), 0),
            "savedOverrides": len(override_ids),
        }

    unresolved = unresolved_station_rows(config)
    unresolved_total = len(unresolved)
    with_exact = config.with_exact_coordinates_hint or 0
    return {
        "totalStations": with_exact + unresolved_total,
        "withExactCoordinates": with_exact,
        "remainingMissingCoordinates": max(unresolved_total - len(override_ids), 0),
        "savedOverrides": len(override_ids),
    }


def bangladesh_coordinate_bounds(latitude: float, longitude: float) -> bool:
    return 20.0 <= latitude <= 27.5 and 87.0 <= longitude <= 93.5


def station_metadata_for_override(config: AppConfig, station_result_id: str) -> dict[str, str] | None:
    if config.has_csv_source and config.stations_path:
        _, station_rows = read_csv_rows(config.stations_path)
        for row in station_rows:
            if row.get("station_result_id") == station_result_id:
                return row
        return None

    for row in unresolved_station_rows(config):
        if row.get("station_result_id") == station_result_id:
            return row
    return None


def append_override_only(config: AppConfig, payload: dict[str, str | float]) -> dict[str, int]:
    station_result_id = str(payload["station_result_id"])
    latitude = f"{float(payload['latitude']):.8f}"
    longitude = f"{float(payload['longitude']):.8f}"
    with WRITE_LOCK:
        target_station = station_metadata_for_override(config, station_result_id)
        if target_station is None:
            raise KeyError(f"Station not found: {station_result_id}")

        override_fields, override_rows = load_override_rows(config)
        override_index = {
            row["station_result_id"]: idx for idx, row in enumerate(override_rows) if row.get("station_result_id")
        }
        override_row = {
            "saved_at_utc": datetime.now(timezone.utc).isoformat(),
            "station_result_id": station_result_id,
            "center_id": target_station.get("center_id", ""),
            "center_serial": target_station.get("center_serial", ""),
            "constituency_no": target_station.get("constituency_no", ""),
            "constituency_name_bn": target_station.get("constituency_name_bn", ""),
            "district_name_bn": target_station.get("district_name_bn", ""),
            "upazilla_name_bn": target_station.get("upazilla_name_bn", ""),
            "union_name_bn": target_station.get("union_name_bn", ""),
            "municipality_name_bn": target_station.get("municipality_name_bn", ""),
            "union_ward_name_bn": target_station.get("union_ward_name_bn", ""),
            "center_name_bn": target_station.get("center_name_bn", ""),
            "latitude": latitude,
            "longitude": longitude,
            "source": "manual_review_site",
        }
        if station_result_id in override_index:
            override_rows[override_index[station_result_id]] = override_row
        else:
            override_rows.append(override_row)

        config.overrides_path.parent.mkdir(parents=True, exist_ok=True)
        write_csv_rows(config.overrides_path, override_fields, override_rows)

    return stats_payload(config)


def random_station_payload(config: AppConfig, exclude_ids: set[str]) -> dict[str, object] | None:
    already_saved = saved_override_ids(config)
    candidates = [
        row
        for row in unresolved_station_rows(config)
        if row["station_result_id"] not in exclude_ids and row["station_result_id"] not in already_saved
    ]
    if not candidates:
        candidates = unresolved_station_rows(config)
    if not candidates:
        return None

    row = random.choice(candidates)
    search_parts = [
        row.get("center_name_bn", ""),
        row.get("union_name_bn", "") or row.get("municipality_name_bn", "") or row.get("union_ward_name_bn", ""),
        row.get("upazilla_name_bn", ""),
        row.get("district_name_bn", ""),
        "Bangladesh",
    ]
    search_text = ", ".join(part for part in search_parts if part)
    row["google_maps_url"] = f"https://www.google.com/maps/search/{quote(search_text)}"
    row["copy_text"] = row.get("center_name_bn", "")
    row["search_text"] = search_text
    return row


class ReviewHandler(BaseHTTPRequestHandler):
    server_version = "CoordinateReview/0.1"

    def is_authorized(self) -> bool:
        config = require_config()
        if not config.auth_user or not config.auth_password:
            return True

        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return False
        user, sep, password = decoded.partition(":")
        if not sep:
            return False
        return hmac.compare_digest(user, config.auth_user) and hmac.compare_digest(password, config.auth_password)

    def challenge_auth(self) -> None:
        payload = json.dumps({"error": "Unauthorized"}).encode("utf-8")
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="Coordinate Review"')
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self.respond_json({"ok": True})
            return
        if not self.is_authorized():
            self.challenge_auth()
            return
        if parsed.path == "/api/stats":
            self.respond_json(stats_payload(require_config()))
            return
        if parsed.path == "/api/station/random":
            query = parse_qs(parsed.query)
            exclude_ids = set()
            for raw in query.get("exclude", []):
                exclude_ids.update(part.strip() for part in raw.split(",") if part.strip())
            payload = random_station_payload(require_config(), exclude_ids)
            if payload is None:
                self.respond_json({"error": "No unresolved stations remain."}, status=HTTPStatus.NOT_FOUND)
            else:
                self.respond_json(payload)
            return
        static_types = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/index.html": ("index.html", "text/html; charset=utf-8"),
            "/app.js": ("app.js", "application/javascript; charset=utf-8"),
            "/styles.css": ("styles.css", "text/css; charset=utf-8"),
            "/config.js": ("config.js", "application/javascript; charset=utf-8"),
        }
        if parsed.path in static_types:
            filename, content_type = static_types[parsed.path]
            self.respond_static(filename, content_type)
            return
        self.respond_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not self.is_authorized():
            self.challenge_auth()
            return
        if parsed.path != "/api/save-coordinate":
            self.respond_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            station_result_id = str(payload["station_result_id"])
            latitude = float(str(payload["latitude"]).strip())
            longitude = float(str(payload["longitude"]).strip())
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self.respond_json({"error": "Invalid payload."}, status=HTTPStatus.BAD_REQUEST)
            return

        if not bangladesh_coordinate_bounds(latitude, longitude):
            self.respond_json(
                {"error": "Coordinates are outside the expected Bangladesh bounds."},
                status=HTTPStatus.BAD_REQUEST,
            )
            return

        try:
            stats = append_override_only(
                require_config(),
                {
                    "station_result_id": station_result_id,
                    "latitude": latitude,
                    "longitude": longitude,
                }
            )
        except KeyError as exc:
            self.respond_json({"error": str(exc)}, status=HTTPStatus.NOT_FOUND)
            return

        self.respond_json({"ok": True, "stats": stats})

    def respond_static(self, filename: str, content_type: str) -> None:
        path = require_config().static_dir / filename
        if not path.exists():
            self.respond_json({"error": "Missing static asset."}, status=HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def respond_json(self, payload: dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    default_static_dir = first_existing(
        [
            PROJECT_ROOT / "review_site",
            PROJECT_ROOT / "data/derived/github_coordinate_review_bundle/review_site",
        ],
        PROJECT_ROOT / "review_site",
    )
    default_stations_path = first_existing(
        [PROJECT_ROOT / "data/derived/sveltekit_app_seed/stations.csv"],
        None,
    )
    default_membership_path = first_existing(
        [PROJECT_ROOT / "data/derived/sveltekit_app_seed/station_admin_membership.csv"],
        None,
    )
    default_feed_path = first_existing(
        [
            PROJECT_ROOT / "data/review/unresolved_stations.json",
            PROJECT_ROOT / "data/derived/github_coordinate_review_bundle/data/review/unresolved_stations.json",
        ],
        None,
    )
    default_overrides_path = first_existing(
        [
            PROJECT_ROOT / "data/review/coordinate_manual_overrides.csv",
            PROJECT_ROOT / "data/derived/coordinate_review/coordinate_manual_overrides.csv",
            PROJECT_ROOT / "data/derived/github_coordinate_review_bundle/data/review/coordinate_manual_overrides.csv",
        ],
        PROJECT_ROOT / "data/review/coordinate_manual_overrides.csv",
    )

    parser = argparse.ArgumentParser(description="Run the coordinate review website.")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8011")))
    parser.add_argument("--static-dir", default=str(resolve_path(os.getenv("REVIEW_STATIC_DIR"), default_static_dir)))
    parser.add_argument(
        "--stations-path",
        default=str(resolve_path(os.getenv("REVIEW_STATIONS_PATH"), default_stations_path))
        if resolve_path(os.getenv("REVIEW_STATIONS_PATH"), default_stations_path)
        else "",
    )
    parser.add_argument(
        "--membership-path",
        default=str(resolve_path(os.getenv("REVIEW_MEMBERSHIP_PATH"), default_membership_path))
        if resolve_path(os.getenv("REVIEW_MEMBERSHIP_PATH"), default_membership_path)
        else "",
    )
    parser.add_argument(
        "--unresolved-feed-path",
        default=str(resolve_path(os.getenv("REVIEW_UNRESOLVED_FEED_PATH"), default_feed_path))
        if resolve_path(os.getenv("REVIEW_UNRESOLVED_FEED_PATH"), default_feed_path)
        else "",
    )
    parser.add_argument(
        "--overrides-path",
        default=str(resolve_path(os.getenv("REVIEW_OVERRIDES_PATH"), default_overrides_path)),
    )
    parser.add_argument("--auth-user", default=os.getenv("REVIEW_AUTH_USER", ""))
    parser.add_argument("--auth-password", default=os.getenv("REVIEW_AUTH_PASSWORD", ""))
    parser.add_argument(
        "--with-exact-coordinates-hint",
        type=int,
        default=int(os.getenv("REVIEW_WITH_EXACT_HINT", "0")),
    )
    args = parser.parse_args()

    global APP_CONFIG
    APP_CONFIG = AppConfig(
        static_dir=Path(args.static_dir).resolve(),
        stations_path=Path(args.stations_path).resolve() if args.stations_path else None,
        membership_path=Path(args.membership_path).resolve() if args.membership_path else None,
        unresolved_feed_path=Path(args.unresolved_feed_path).resolve() if args.unresolved_feed_path else None,
        overrides_path=Path(args.overrides_path).resolve(),
        auth_user=args.auth_user or None,
        auth_password=args.auth_password or None,
        with_exact_coordinates_hint=args.with_exact_coordinates_hint if args.with_exact_coordinates_hint > 0 else None,
    )

    if not APP_CONFIG.static_dir.exists():
        raise FileNotFoundError(f"Static dir not found: {APP_CONFIG.static_dir}")
    if not APP_CONFIG.has_csv_source and not APP_CONFIG.has_feed_source:
        raise FileNotFoundError(
            "No source data found. Provide REVIEW_UNRESOLVED_FEED_PATH or stations/membership CSV paths."
        )

    server = ThreadingHTTPServer((args.host, args.port), ReviewHandler)
    source_mode = "csv" if APP_CONFIG.has_csv_source else "feed"
    auth_mode = "basic-auth-enabled" if APP_CONFIG.auth_user and APP_CONFIG.auth_password else "no-auth"
    print(f"Coordinate review site running at http://{args.host}:{args.port} [{source_mode}; {auth_mode}]")
    server.serve_forever()


if __name__ == "__main__":
    main()
