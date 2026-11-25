import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BY_DATE_DIR = ROOT / "by-date"
BY_RACER_DIR = ROOT / "by-racer"
CATALOG_PATH = ROOT / "catalog.json"
COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
DISCIPLINES = {"Windsurf", "Windfoil", "Wingfoil", "Parawing", "Formula"}
EARTH_RADIUS_METERS = 6_371_000
DATE_FOLDER_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BY_RACER_GPX_PATTERN = re.compile(
    r"^\.\./\.\./by-date/(\d{4}-\d{2}-\d{2})/([^/\\]+\.gpx)$",
    re.IGNORECASE,
)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_iso_datetime(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None and parsed.utcoffset() is not None else None


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def point_coordinate(point, key):
    try:
        value = float(point.attrib[key])
    except (KeyError, TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def distance_meters(first, second):
    radians = math.pi / 180
    latitude_delta = (second[0] - first[0]) * radians
    longitude_delta = (second[1] - first[1]) * radians
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(first[0] * radians)
        * math.cos(second[0] * radians)
        * math.sin(longitude_delta / 2) ** 2
    )
    return EARTH_RADIUS_METERS * 2 * math.atan2(math.sqrt(haversine), math.sqrt(1 - haversine))


def resolve_track_gpx_path(filename, manifest_path):
    if not isinstance(filename, str) or not filename.lower().endswith(".gpx"):
        return None
    if "\\" in filename or filename.startswith("/"):
        return None
    normalized = filename.replace("\\", "/")
    if ".." in normalized and not normalized.startswith("../../by-date/"):
        return None
    if "/" not in normalized:
        path = (manifest_path.parent / normalized).resolve()
        if path.parent != manifest_path.parent.resolve():
            return None
        return path

    if not BY_RACER_GPX_PATTERN.fullmatch(normalized):
        return None
    path = (manifest_path.parent / normalized).resolve()
    try:
        path.relative_to(BY_DATE_DIR.resolve())
    except ValueError:
        return None
    return path


def validate_track_file(track, label, timing, has_timing_metadata, start_time, manifest_path, errors):
    filename = track.get("file")
    path = resolve_track_gpx_path(filename, manifest_path)
    if path is None:
        errors.append(
            f"{label}: file must be a GPX filename in the manifest folder or ../../by-date/YYYY-MM-DD/name.gpx.",
        )
        return
    if not path.is_file():
        errors.append(f"{label}: {filename} does not exist.")
        return

    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
        errors.append(f"{label}: {filename} is not valid XML ({error}).")
        return

    if local_name(root.tag) != "gpx":
        errors.append(f"{label}: {filename} must have a GPX root element.")
        return

    points = [element for element in root.iter() if local_name(element.tag) == "trkpt"]
    if len(points) < 2:
        errors.append(f"{label}: {filename} must contain at least two track points.")
        return

    timestamps = []
    for index, point in enumerate(points, start=1):
        latitude = point_coordinate(point, "lat")
        longitude = point_coordinate(point, "lon")
        if latitude is None or not -90 <= latitude <= 90:
            errors.append(f"{label}: {filename} point {index} has an invalid latitude.")
        if longitude is None or not -180 <= longitude <= 180:
            errors.append(f"{label}: {filename} point {index} has an invalid longitude.")

        time_element = next((child for child in point if local_name(child.tag) == "time"), None)
        if time_element is None:
            timestamps.append(None)
            continue
        timestamp = parse_iso_datetime(time_element.text)
        if timestamp is None:
            errors.append(f"{label}: {filename} point {index} has an invalid or timezone-free timestamp.")
            timestamps.append(None)
        else:
            timestamps.append(timestamp)

    timed_count = sum(timestamp is not None for timestamp in timestamps)
    if timed_count not in (0, len(points)):
        errors.append(f"{label}: {filename} must have timestamps on every point or none.")
    elif timed_count == len(points):
        if timing is not None:
            errors.append(f"{label}: timing is only for tracks without point timestamps.")
        if any(later < earlier for earlier, later in zip(timestamps, timestamps[1:])):
            errors.append(f"{label}: {filename} timestamps must be chronological.")
        if timestamps[-1] <= timestamps[0]:
            errors.append(f"{label}: {filename} timestamps must span a positive duration.")
        if start_time is not None and not timestamps[0] <= start_time <= timestamps[-1]:
            errors.append(
                f"{label}: startTime must fall within the GPX timestamp range: {timestamps[0]} to {timestamps[-1]}.",
            )
    elif timed_count == 0:
        recording_start_time = parse_iso_datetime(timing.get("start"))
        if start_time is not None:
            if start_time < recording_start_time:
                errors.append(f"{label}: startTime override given is before the recording timing.start.")
            if start_time >= recording_start_time + timedelta(seconds=timing.get("durationSeconds")):
                errors.append(f"{label}: startTime override given is not within the timing.duration.")
        if not has_timing_metadata:
            errors.append(f"{label}: {filename} has no point timestamps and needs timing.start and timing.durationSeconds.")


def validate_manifest(manifest_path):
    errors = []
    label_prefix = str(manifest_path.relative_to(ROOT))
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"{label_prefix}: cannot read manifest ({error})."]

    entries = manifest.get("tracks") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not entries:
        errors.append(f"{label_prefix}: manifest must contain a non-empty tracks array.")
        return errors

    sync_line = manifest.get("syncLine")
    if not isinstance(sync_line, dict):
        errors.append(f"{label_prefix}: syncLine must define start and end points.")
    else:
        endpoints = []
        for endpoint in ("start", "end"):
            value = sync_line.get(endpoint)
            if (
                not isinstance(value, list)
                or len(value) != 2
                or not all(is_number(coordinate) for coordinate in value)
                or not -90 <= value[0] <= 90
                or not -180 <= value[1] <= 180
            ):
                errors.append(f"{label_prefix}: syncLine.{endpoint} must be [latitude, longitude] within valid bounds.")
                endpoints.append(None)
            else:
                endpoints.append((value[0], value[1]))
        if all(endpoint is not None for endpoint in endpoints) and distance_meters(*endpoints) < 1:
            errors.append(f"{label_prefix}: syncLine endpoints must be at least one meter apart.")

    names = set()
    filenames = set()
    colors = set()
    for index, track in enumerate(entries, start=1):
        if not isinstance(track, dict):
            errors.append(f"{label_prefix}: track {index} must be an object.")
            continue

        name = track.get("name")
        if not isinstance(name, str) or not name.strip():
            track_label = f"{label_prefix} track {index}"
            errors.append(f"{track_label}: name must be a non-empty string.")
        else:
            track_label = f"{label_prefix} {name.strip()}"
            name_key = track_label.casefold()
            if name_key in names:
                errors.append(f"{track_label}: participant names must be unique.")
            names.add(name_key)

        discipline = track.get("discipline")
        if not isinstance(discipline, str) or discipline not in DISCIPLINES:
            errors.append(
                f"{track_label}: discipline is required and must be Windsurf, Windfoil, Wingfoil, Parawing, or Formula if you are super special.",
            )

        filename = track.get("file")
        if isinstance(filename, str):
            file_key = filename.casefold()
            if file_key in filenames:
                errors.append(f"{track_label}: GPX filenames must be unique.")
            filenames.add(file_key)

        color = track.get("color")
        if not isinstance(color, str) or not COLOR_PATTERN.fullmatch(color):
            errors.append(f"{track_label}: color is required and must be a six-digit hex value such as #59d5ff.")
        else:
            color_key = color.lower()
            if color_key in colors:
                errors.append(f"{track_label}: primary colors must be unique.")
            colors.add(color_key)

        secondary_color = track.get("secondaryColor")
        if secondary_color is not None:
            if not isinstance(secondary_color, str) or not COLOR_PATTERN.fullmatch(secondary_color):
                errors.append(f"{track_label}: secondaryColor must be a six-digit hex value.")
            elif isinstance(color, str) and secondary_color.lower() == color.lower():
                errors.append(f"{track_label}: color and secondaryColor must be different.")

        gear = track.get("gear")
        if gear is not None and (not isinstance(gear, str) or not gear.strip()):
            errors.append(f"{track_label}: gear must be a non-empty string when provided.")

        if "finished" in track and not isinstance(track["finished"], bool):
            errors.append(f"{track_label}: finished must be a boolean when provided.")

        if track.get("syncTime") is not None:
            errors.append(f"{track_label}: syncTime is no longer supported; use top-level startTime.")
        if "syncAtStart" in track:
            errors.append(f"{track_label}: syncAtStart is no longer supported; use top-level startTime.")
        if track.get("durationSeconds") is not None:
            errors.append(f"{track_label}: durationSeconds must be provided inside timing.")

        start_time = None
        if track.get("startTime") is not None:
            start_time = parse_iso_datetime(track["startTime"])
            if start_time is None:
                errors.append(f"{track_label}: startTime must be an ISO 8601 date-time with a timezone.")

        timing = track.get("timing")
        has_timing_metadata = False
        if timing is not None:
            if not isinstance(timing, dict):
                errors.append(f"{track_label}: timing must be an object.")
                timing = None
            else:
                has_timing_start = timing.get("start") is not None
                has_timing_duration = timing.get("durationSeconds") is not None
                if not has_timing_start or not has_timing_duration:
                    errors.append(f"{track_label}: timing must contain both startTime and durationSeconds.")
                else:
                    has_timing_metadata = True
                if has_timing_start and parse_iso_datetime(timing.get("start")) is None:
                    errors.append(f"{track_label}: timing.start must be an ISO 8601 date-time with a timezone.")
                if has_timing_duration and (
                    not is_number(timing.get("durationSeconds")) or timing["durationSeconds"] <= 0
                ):
                    errors.append(f"{track_label}: timing.durationSeconds must be a positive number.")

        if not errors:
            validate_track_file(track, track_label, timing, has_timing_metadata, start_time, manifest_path, errors)

    return errors


def validate_catalog():
    errors = []
    if not CATALOG_PATH.is_file():
        return ["catalog.json is missing; run scripts/update_tracks.py."]
    try:
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"catalog.json cannot be read ({error})."]

    dates = catalog.get("dates")
    racers = catalog.get("racers")
    if not isinstance(dates, list) or not dates:
        errors.append("catalog.json must contain a non-empty dates array.")
    if not isinstance(racers, list):
        errors.append("catalog.json must contain a racers array.")

    expected_dates = sorted(
        [
            path.name
            for path in BY_DATE_DIR.iterdir()
            if path.is_dir() and DATE_FOLDER_PATTERN.fullmatch(path.name) and (path / "tracks.json").is_file()
        ],
        reverse=True,
    )
    catalog_dates = [entry.get("id") for entry in dates if isinstance(entry, dict)] if isinstance(dates, list) else []
    if catalog_dates != expected_dates:
        errors.append("catalog.json dates are stale; run scripts/update_tracks.py.")

    return errors


def validate(by_date_only=False):
    errors = []
    errors.extend(validate_catalog())

    for event_dir in sorted(BY_DATE_DIR.iterdir()):
        if not event_dir.is_dir() or not DATE_FOLDER_PATTERN.fullmatch(event_dir.name):
            continue
        manifest_path = event_dir / "tracks.json"
        if manifest_path.is_file():
            errors.extend(validate_manifest(manifest_path))

    if not by_date_only and BY_RACER_DIR.is_dir():
        for racer_dir in sorted(BY_RACER_DIR.iterdir()):
            if not racer_dir.is_dir():
                continue
            manifest_path = racer_dir / "tracks.json"
            if manifest_path.is_file():
                errors.extend(validate_manifest(manifest_path))

    if errors:
        print("Track-data validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    manifest_count = sum(1 for _ in BY_DATE_DIR.glob("*/tracks.json"))
    racer_count = 0 if by_date_only else sum(1 for _ in BY_RACER_DIR.glob("*/tracks.json")) if BY_RACER_DIR.is_dir() else 0
    if by_date_only:
        print(
            f"Validated catalog, {manifest_count} event manifests, sync lines, colors, and GPX data.",
        )
    else:
        print(
            f"Validated catalog, {manifest_count} event manifests, {racer_count} racer manifests, "
            "sync lines, colors, and GPX data.",
        )
    return 0


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Validate track manifests and GPX files.")
    parser.add_argument(
        "--by-date-only",
        action="store_true",
        help="Validate only by-date event folders (skip by-racer manifests).",
    )
    args = parser.parse_args()
    sys.exit(validate(by_date_only=args.by_date_only))