#!/usr/bin/env python3
"""Generate catalog.json and by-racer manifests from by-date event folders."""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BY_DATE_DIR = ROOT / "by-date"
BY_RACER_DIR = ROOT / "by-racer"
CATALOG_PATH = ROOT / "catalog.json"
COLORS_PATH = ROOT / "colors.js"
DATE_FOLDER_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def load_colors():
    if not COLORS_PATH.is_file():
        print(f"update_tracks failed: missing {COLORS_PATH.name}.", file=sys.stderr)
        sys.exit(1)
    try:
        colors = json.loads(COLORS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        print(f"update_tracks failed: {COLORS_PATH.name} must be a JSON array ({error}).", file=sys.stderr)
        sys.exit(1)
    if not isinstance(colors, list) or not colors:
        print(f"update_tracks failed: {COLORS_PATH.name} must be a non-empty JSON array.", file=sys.stderr)
        sys.exit(1)
    return [str(color).lower() for color in colors]


def format_date_label(folder_name):
    year, month, day = (int(part) for part in folder_name.split("-"))
    return f"{month:02d}-{day:02d}-{year}"


def racer_label(racer_id):
    return racer_id.replace("_", " ")


def track_file_stem(track):
    filename = track.get("file")
    if not isinstance(filename, str):
        return None
    return Path(filename).stem


def load_manifest(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"update_tracks failed: cannot read {path}: {error}", file=sys.stderr)
        sys.exit(1)


def collect_events():
    if not BY_DATE_DIR.is_dir():
        print(f"update_tracks failed: missing {BY_DATE_DIR.name}/ directory.", file=sys.stderr)
        sys.exit(1)

    events = []
    for event_dir in BY_DATE_DIR.iterdir():
        if not event_dir.is_dir() or not DATE_FOLDER_PATTERN.fullmatch(event_dir.name):
            continue
        manifest_path = event_dir / "tracks.json"
        if not manifest_path.is_file():
            print(f"update_tracks failed: missing {manifest_path.relative_to(ROOT)}.", file=sys.stderr)
            sys.exit(1)
        manifest = load_manifest(manifest_path)
        tracks = manifest.get("tracks")
        if not isinstance(tracks, list) or not tracks:
            print(
                f"update_tracks failed: {manifest_path.relative_to(ROOT)} must contain a non-empty tracks array.",
                file=sys.stderr,
            )
            sys.exit(1)
        sync_line = manifest.get("syncLine")
        if not isinstance(sync_line, dict):
            print(f"update_tracks failed: {manifest_path.relative_to(ROOT)} must define syncLine.", file=sys.stderr)
            sys.exit(1)
        events.append(
            {
                "id": event_dir.name,
                "label": format_date_label(event_dir.name),
                "dir": event_dir,
                "manifest": manifest,
                "tracks": tracks,
            }
        )

    if not events:
        print(f"update_tracks failed: no dated folders found in {BY_DATE_DIR.name}/.", file=sys.stderr)
        sys.exit(1)

    events.sort(key=lambda event: event["id"], reverse=True)
    return events


def build_catalog(events, racer_ids):
    return {
        "dates": [{"id": event["id"], "label": event["label"]} for event in events],
        "racers": [{"id": racer_id, "label": racer_label(racer_id)} for racer_id in racer_ids],
    }


def build_by_racer_manifests(events, colors):
    racer_entries = {}
    racer_sync_lines = {}

    for event in events:
        for track in event["tracks"]:
            racer_id = track_file_stem(track)
            if not racer_id:
                continue
            source_file = event["dir"] / track.get("file", "")
            if not source_file.is_file():
                print(
                    f"update_tracks failed: {source_file.relative_to(ROOT)} referenced by "
                    f"{event['dir'].name}/tracks.json does not exist.",
                    file=sys.stderr,
                )
                sys.exit(1)

            destination_name = f"{event['id']}.gpx"
            racer_entries.setdefault(racer_id, []).append(
                {
                    "event_id": event["id"],
                    "event_label": event["label"],
                    "source_file": source_file,
                    "destination_name": destination_name,
                    "track": track,
                }
            )
            racer_sync_lines.setdefault(racer_id, event["manifest"]["syncLine"])

    manifests = {}
    for racer_id, entries in racer_entries.items():
        entries.sort(key=lambda entry: entry["event_id"], reverse=True)
        manifest_tracks = []
        used_colors = set()
        color_index = 0

        for entry in entries:
            while color_index < len(colors) and colors[color_index] in used_colors:
                color_index += 1
            if color_index >= len(colors):
                print(
                    f"update_tracks failed: not enough unique colors in colors.js for {racer_id}.",
                    file=sys.stderr,
                )
                sys.exit(1)

            source_track = entry["track"]
            color = colors[color_index].lower()
            used_colors.add(color)
            color_index += 1

            manifest_track = {
                "name": entry["event_label"],
                "discipline": source_track.get("discipline"),
                "file": entry["destination_name"],
                "color": color,
            }
            for optional_key in ("gear", "secondaryColor", "startTime", "timing"):
                if optional_key in source_track:
                    manifest_track[optional_key] = source_track[optional_key]
            manifest_tracks.append(manifest_track)

        manifests[racer_id] = {
            "syncLine": racer_sync_lines[racer_id],
            "tracks": manifest_tracks,
            "entries": entries,
        }

    return manifests


def write_catalog(catalog):
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")


def write_by_racer(manifests):
    if BY_RACER_DIR.exists():
        shutil.rmtree(BY_RACER_DIR)
    BY_RACER_DIR.mkdir(parents=True)

    for racer_id, payload in sorted(manifests.items(), key=lambda item: item[0].casefold()):
        racer_dir = BY_RACER_DIR / racer_id
        racer_dir.mkdir(parents=True)
        for entry in payload["entries"]:
            shutil.copy2(entry["source_file"], racer_dir / entry["destination_name"])
        manifest_path = racer_dir / "tracks.json"
        manifest_path.write_text(
            json.dumps({"syncLine": payload["syncLine"], "tracks": payload["tracks"]}, indent=2) + "\n",
            encoding="utf-8",
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit with status 1 if generated catalog.json or by-racer output is out of date.",
    )
    args = parser.parse_args()

    colors = load_colors()
    events = collect_events()
    racer_ids = sorted(
        {
            track_file_stem(track)
            for event in events
            for track in event["tracks"]
            if track_file_stem(track)
        },
        key=str.casefold,
    )
    catalog = build_catalog(events, racer_ids)
    manifests = build_by_racer_manifests(events, colors)

    if args.check:
        stale = False
        if not CATALOG_PATH.is_file():
            print("update_tracks check failed: catalog.json is missing; run scripts/update_tracks.py.", file=sys.stderr)
            stale = True
        else:
            existing = load_manifest(CATALOG_PATH)
            if existing != catalog:
                print(
                    "update_tracks check failed: catalog.json is stale; run scripts/update_tracks.py.",
                    file=sys.stderr,
                )
                stale = True

        for racer_id, payload in manifests.items():
            racer_dir = BY_RACER_DIR / racer_id
            manifest_path = racer_dir / "tracks.json"
            expected = {"syncLine": payload["syncLine"], "tracks": payload["tracks"]}
            if not manifest_path.is_file():
                print(
                    f"update_tracks check failed: missing {manifest_path.relative_to(ROOT)}; run scripts/update_tracks.py.",
                    file=sys.stderr,
                )
                stale = True
                continue
            if load_manifest(manifest_path) != expected:
                print(
                    f"update_tracks check failed: {manifest_path.relative_to(ROOT)} is stale; run scripts/update_tracks.py.",
                    file=sys.stderr,
                )
                stale = True
            for entry in payload["entries"]:
                gpx_path = racer_dir / entry["destination_name"]
                if not gpx_path.is_file():
                    print(
                        f"update_tracks check failed: missing {gpx_path.relative_to(ROOT)}; run scripts/update_tracks.py.",
                        file=sys.stderr,
                    )
                    stale = True

        if BY_RACER_DIR.is_dir():
            expected_ids = set(manifests)
            on_disk = {path.name for path in BY_RACER_DIR.iterdir() if path.is_dir()}
            extra = on_disk - expected_ids
            if extra:
                print(
                    f"update_tracks check failed: unexpected by-racer folders: {', '.join(sorted(extra))}.",
                    file=sys.stderr,
                )
                stale = True

        if stale:
            sys.exit(1)
        print(
            f"Catalog and by-racer output are up to date for {len(events)} events and {len(racer_ids)} racers.",
        )
        return 0

    write_catalog(catalog)
    write_by_racer(manifests)
    print(
        f"Wrote catalog.json, {len(racer_ids)} by-racer folders, and manifests for "
        f"{len(events)} events.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())