#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[2]
STATIONS_PATH = ROOT / "data/derived/sveltekit_app_seed/stations.csv"
MEMBERSHIP_PATH = ROOT / "data/derived/sveltekit_app_seed/station_admin_membership.csv"
OUT_PATH = ROOT / "data/review/unresolved_stations_rich.json"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def main() -> None:
    stations = read_csv(STATIONS_PATH)
    membership = read_csv(MEMBERSHIP_PATH)
    membership_by_station = {r.get("station_result_id", ""): r for r in membership}

    unresolved: list[dict[str, str]] = []
    for s in stations:
        if (s.get("has_exact_coordinates") or "").strip() == "1":
            continue
        sid = s.get("station_result_id", "")
        m = membership_by_station.get(sid, {})

        union_hint = (
            (s.get("union_name_bn") or "").strip()
            or (s.get("municipality_name_bn") or "").strip()
            or (s.get("union_ward_name_bn") or "").strip()
            or (s.get("polling_union_bn") or "").strip()
            or (m.get("assigned_admin_name_bn") or "").strip()
            or ""
        )
        search_parts = [
            (s.get("center_name_bn") or "").strip(),
            union_hint,
            (s.get("upazilla_name_bn") or "").strip() or (s.get("polling_upazila_bn") or "").strip(),
            (s.get("district_name_bn") or "").strip(),
            "Bangladesh",
        ]
        search_text = ", ".join([x for x in search_parts if x])

        unresolved.append(
            {
                **s,
                "assigned_admin_unit_id": (m.get("assigned_admin_unit_id") or "").strip(),
                "assigned_admin_level": (m.get("assigned_admin_level") or "").strip(),
                "assigned_admin_name_bn": (m.get("assigned_admin_name_bn") or "").strip(),
                "assigned_parent_name_bn": (m.get("assigned_parent_name_bn") or "").strip(),
                "assignment_method": (m.get("assignment_method") or "").strip(),
                "assignment_confidence": (m.get("assignment_confidence") or "").strip(),
                "assignment_note": (m.get("assignment_note") or "").strip(),
                "search_text": search_text,
                "copy_text": (s.get("center_name_bn") or "").strip(),
                "google_maps_url": f"https://www.google.com/maps/search/{quote(search_text)}",
            }
        )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(unresolved, f, ensure_ascii=False)

    print(f"Wrote {len(unresolved)} rows to {OUT_PATH}")


if __name__ == "__main__":
    main()
