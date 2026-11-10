import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TRACKS_DIR = ROOT / "tracks"
MANIFEST_PATH = TRACKS_DIR / "tracks.json"
COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
DISCIPLINES = {"Windsurf", "Windfoil", "Wingfoil"}
EARTH_RADIUS_METERS = 6_371_000


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


def validate_track_file(track, label, timing, has_timing_metadata, start_time, errors):
    filename = track.get("file")
    if not isinstance(filename, str) or not filename.lower().endswith(".gpx"):
        errors.append(f"{label}: file must be a GPX filename.")
        return
    if Path(filename).name != filename or "/" in filename or "\\" in filename:
        errors.append(f"{label}: file must be a filename inside tracks/, not a path.")
        return

    path = TRACKS_DIR / filename
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
            errors.append(f"{label}: startTime must fall within the GPX timestamp range.")
    elif timed_count == 0:
        if start_time is not None:
            errors.append(f"{label}: top-level startTime requires recorded GPX timestamps; put estimated timing under timing.")
        if not has_timing_metadata:
            errors.append(f"{label}: {filename} has no point timestamps and needs timing.start and timing.durationSeconds.")


def validate():
    errors = []
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"Track-data validation failed: cannot read {MANIFEST_PATH}: {error}")
        return 1

    entries = manifest.get("tracks") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not entries:
        print("Track-data validation failed: tracks/tracks.json must contain a non-empty tracks array.")
        return 1

    sync_line = manifest.get("syncLine")
    if not isinstance(sync_line, dict):
        errors.append("syncLine must define start and end points.")
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
                errors.append(f"syncLine.{endpoint} must be [latitude, longitude] within valid bounds.")
                endpoints.append(None)
            else:
                endpoints.append((value[0], value[1]))
        if all(endpoint is not None for endpoint in endpoints) and distance_meters(*endpoints) < 1:
            errors.append("syncLine endpoints must be at least one meter apart.")

    names = set()
    filenames = set()
    colors = set()
    for index, track in enumerate(entries, start=1):
        if not isinstance(track, dict):
            errors.append(f"Track {index} must be an object.")
            continue

        name = track.get("name")
        if not isinstance(name, str) or not name.strip():
            label = f"Track {index}"
            errors.append(f"{label}: name must be a non-empty string.")
        else:
            label = name.strip()
            name_key = label.casefold()
            if name_key in names:
                errors.append(f"{label}: participant names must be unique.")
            names.add(name_key)

        discipline = track.get("discipline")
        if not isinstance(discipline, str) or discipline not in DISCIPLINES:
            errors.append(f"{label}: discipline is required and must be Windsurf, Windfoil, or Wingfoil.")

        filename = track.get("file")
        if isinstance(filename, str):
            file_key = filename.casefold()
            if file_key in filenames:
                errors.append(f"{label}: GPX filenames must be unique.")
            filenames.add(file_key)

        color = track.get("color")
        if not isinstance(color, str) or not COLOR_PATTERN.fullmatch(color):
            errors.append(f"{label}: color is required and must be a six-digit hex value such as #59d5ff.")
        else:
            color_key = color.lower()
            if color_key in colors:
                errors.append(f"{label}: primary colors must be unique.")
            colors.add(color_key)

        secondary_color = track.get("secondaryColor")
        if secondary_color is not None:
            if not isinstance(secondary_color, str) or not COLOR_PATTERN.fullmatch(secondary_color):
                errors.append(f"{label}: secondaryColor must be a six-digit hex value.")
            elif isinstance(color, str) and secondary_color.lower() == color.lower():
                errors.append(f"{label}: color and secondaryColor must be different.")

        gear = track.get("gear")
        if gear is not None and (not isinstance(gear, str) or not gear.strip()):
            errors.append(f"{label}: gear must be a non-empty string when provided.")

        if track.get("syncTime") is not None:
            errors.append(f"{label}: syncTime is no longer supported; use top-level startTime.")
        if "syncAtStart" in track:
            errors.append(f"{label}: syncAtStart is no longer supported; use top-level startTime.")
        if track.get("durationSeconds") is not None:
            errors.append(f"{label}: durationSeconds must be provided inside timing.")

        start_time = None
        if track.get("startTime") is not None:
            start_time = parse_iso_datetime(track["startTime"])
            if start_time is None:
                errors.append(f"{label}: startTime must be an ISO 8601 date-time with a timezone.")

        timing = track.get("timing")
        has_timing_metadata = False
        if timing is not None:
            if not isinstance(timing, dict):
                errors.append(f"{label}: timing must be an object.")
                timing = None
            else:
                has_timing_start = timing.get("start") is not None
                has_timing_duration = timing.get("durationSeconds") is not None
                if not has_timing_start or not has_timing_duration:
                    errors.append(f"{label}: timing must contain both startTime and durationSeconds.")
                else:
                    has_timing_metadata = True
                if has_timing_start and parse_iso_datetime(timing.get("start")) is None:
                    errors.append(f"{label}: timing.start must be an ISO 8601 date-time with a timezone.")
                if has_timing_duration and (
                    not is_number(timing.get("durationSeconds")) or timing["durationSeconds"] <= 0
                ):
                    errors.append(f"{label}: timing.durationSeconds must be a positive number.")

        validate_track_file(track, label, timing, has_timing_metadata, start_time, errors)

    if errors:
        print("Track-data validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"Validated {len(entries)} participants, manifest fields, sync line, colors, and GPX data.")
    return 0


if __name__ == "__main__":
    sys.exit(validate())
