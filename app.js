const TRACK_MANIFEST_URL = new URL("./tracks/tracks.json", document.baseURI);
const TRACK_COLORS = [
  "#59d5ff",
  "#ffcb5b",
  "#ff7297",
  "#9d8aff",
  "#7ee089",
  "#ff9864",
  "#f500f5",
  "#00f500",
  "#f53100",
  "#b4da1b",
  "#f500a3",
  "#1bdac7",
  "#009bf5",
  "#ff2954",
  "#ed6eed",
  "#00f572",
  "#9d5cff",
  "#f58b00",
  "#f5d400",
  "#6eda1b",
];
const DISCIPLINES = ["Windsurf", "Windfoil", "Wingfoil"];

const TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION =
  "Tiles &copy; Esri — Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community";
const EARTH_RADIUS_METERS = 6_371_000;
const GPS_SPIKE_MAX_SPEED_METERS_PER_SECOND = 30;
const GPS_SPIKE_RETURN_DISTANCE_METERS = 100;
const GPS_SPIKE_MIN_EXCURSION_METERS = 500;
const GPS_SPIKE_LOOKAHEAD_POINTS = 60;
const MIN_FINISH_AFTER_SYNC_SECONDS = 30 * 60;
const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "America/Los_Angeles",
  timeZoneName: "short",
});

const map = L.map("map", { preferCanvas: true }).setView([47.57, -122.2], 12);
L.tileLayer(TILE_URL, {
  attribution: TILE_ATTRIBUTION,
  maxZoom: 19,
}).addTo(map);
const markerRenderer = L.svg({ pane: "markerPane" });

const ui = {
  clock: document.querySelector("#clock"),
  elapsed: document.querySelector("#elapsed"),
  mode: document.querySelector("#time-mode"),
  play: document.querySelector("#play-toggle"),
  reset: document.querySelector("#reset"),
  showFullTrack: document.querySelector("#show-full-track"),
  pinNames: document.querySelector("#pin-names"),
  leaderboard: document.querySelector("#leaderboard"),
  leaderboardCollapse: document.querySelector("#leaderboard-collapse"),
  leaderboardContent: document.querySelector("#leaderboard-content"),
  leaderboardList: document.querySelector("#leaderboard-list"),
  leaderboardEmpty: document.querySelector("#leaderboard-empty"),
  gpsSpikeCorrection: document.querySelector("#gps-spike-correction"),
  seek: document.querySelector("#seek"),
  speed: document.querySelector("#speed"),
  speedValue: document.querySelector("#speed-value"),
  speedMax: document.querySelector("#speed-max"),
  advancedSettings: document.querySelector("#advanced-settings"),
  syncLineControls: document.querySelector("#sync-line-controls"),
  syncPositionMarker: document.querySelector("#sync-position-marker"),
  drawSyncLine: document.querySelector("#draw-sync-line"),
  resetSyncLine: document.querySelector("#reset-sync-line"),
  status: document.querySelector("#status"),
  trackCount: document.querySelector("#track-count"),
  toggleTrackDetails: document.querySelector("#toggle-track-details"),
  disciplineFilters: document.querySelector("#discipline-filters"),
  trackList: document.querySelector("#track-list"),
};

const tracks = [];
const DEFAULT_MODE = "relative";
let mode = DEFAULT_MODE;
let rangeStart = 0;
let rangeEnd = 0;
let currentTime = 0;
let playing = false;
let frameId = 0;
let lastFrameAt = null;
let lastClockSecond = null;
let lastClockMode = null;
let lastLeaderboardSignature = null;
let triangulationContext = null;
let syncLine = null;
let defaultSyncLine = null;
let shareStateReady = false;
let syncLineLayer = null;
const syncLineHandles = [];
let drawingSyncLine = false;
let pendingSyncLinePoints = [];
let syncLineStartMarker = null;
let syncLinePreviewMarker = null;
let pendingSyncLinePreviewPoint = null;

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatRelativeTime(seconds) {
  const total = Math.floor(Math.abs(seconds));
  const sign = seconds < 0 && total > 0 ? "-" : "";
  return `${sign}${formatDuration(total)}`;
}

function formatClock(epochSeconds) {
  return clockFormatter.format(new Date(epochSeconds * 1000));
}

function participantDotBackground(track) {
  return track.secondaryColor
    ? `linear-gradient(135deg, ${track.color} 50%, ${track.secondaryColor} 50%)`
    : track.color;
}

function participantDotBorderColor(track) {
  return track.color === "#ffffff" ? "#26383c" : "#ffffff";
}

function participantMarkerIcon(track) {
  const dot = document.createElement("span");
  dot.className = "participant-map-dot";
  dot.style.background = participantDotBackground(track);
  dot.style.borderColor = participantDotBorderColor(track);
  return L.divIcon({
    className: "participant-marker-icon",
    html: dot,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function distanceMeters(first, second) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lon - first.lon);
  const latitude1 = radians(first.lat);
  const latitude2 = radians(second.lat);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function detectGpsDropouts(points, nominalSampleSeconds) {
  const holds = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const intervalSeconds =
      previous.timestamp !== null && point.timestamp !== null
        ? point.timestamp - previous.timestamp
        : nominalSampleSeconds;
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) continue;
    if (distanceMeters(previous, point) / intervalSeconds <= GPS_SPIKE_MAX_SPEED_METERS_PER_SECOND) {
      continue;
    }

    const startIndex = index - 1;
    let maximumDeviation = 0;
    let endIndex = -1;
    const lookaheadEnd = Math.min(points.length - 1, index + GPS_SPIKE_LOOKAHEAD_POINTS);
    for (let candidate = index; candidate <= lookaheadEnd; candidate += 1) {
      const deviation = distanceMeters(points[startIndex], points[candidate]);
      maximumDeviation = Math.max(maximumDeviation, deviation);
      if (
        candidate > index &&
        maximumDeviation >= GPS_SPIKE_MIN_EXCURSION_METERS &&
        deviation <= GPS_SPIKE_RETURN_DISTANCE_METERS
      ) {
        endIndex = candidate;
        break;
      }
    }
    if (endIndex < 0) continue;

    const anchor = points[startIndex];
    for (let corrected = startIndex + 1; corrected < endIndex; corrected += 1) {
      points[corrected].lat = anchor.lat;
      points[corrected].lon = anchor.lon;
    }
    const durationSeconds =
      previous.timestamp !== null && points[endIndex].timestamp !== null
        ? points[endIndex].timestamp - anchor.timestamp
        : (endIndex - startIndex) * nominalSampleSeconds;
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      holds.push({ startIndex, endIndex, durationSeconds });
    }
    index = endIndex;
  }
  return holds;
}

function parseGpx(xmlText) {
  const documentXml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (documentXml.querySelector("parsererror")) {
    throw new Error("The file is not valid XML.");
  }

  const pointElements = [...documentXml.getElementsByTagNameNS("*", "trkpt")];
  if (pointElements.length < 2) {
    throw new Error("The GPX file must contain at least two track points.");
  }

  const points = pointElements.map((element) => {
    const lat = Number(element.getAttribute("lat"));
    const lon = Number(element.getAttribute("lon"));
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error("The GPX file contains an invalid latitude or longitude.");
    }

    const timeElement = [...element.children].find((child) => child.localName === "time");
    const timestamp = timeElement ? Date.parse(timeElement.textContent) / 1000 : null;
    if (timeElement && !Number.isFinite(timestamp)) {
      throw new Error("The GPX file contains an invalid timestamp.");
    }

    return { lat, lon, timestamp };
  });

  const timestampCount = points.filter((point) => point.timestamp !== null).length;
  if (timestampCount > 0 && timestampCount !== points.length) {
    throw new Error("Only some track points have timestamps. Export a complete timed GPX or use a file with no timestamps.");
  }

  if (timestampCount === points.length) {
    for (let index = 1; index < points.length; index += 1) {
      if (points[index].timestamp < points[index - 1].timestamp) {
        throw new Error("Track timestamps must be in chronological order.");
      }
    }
    if (points[points.length - 1].timestamp <= points[0].timestamp) {
      throw new Error("Track timestamps must span a positive duration.");
    }
  }

  return { points, hasTimestamps: timestampCount === points.length };
}

async function loadTrackManifest() {
  const response = await fetch(TRACK_MANIFEST_URL);
  if (!response.ok) throw new Error(`Could not load track manifest (${response.status} ${response.statusText}).`);

  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.tracks) || manifest.tracks.length === 0) {
    throw new Error("tracks/tracks.json must contain a non-empty tracks array.");
  }
  if (!manifest.syncLine) {
    throw new Error("tracks/tracks.json must define a two-point syncLine.");
  }

  const parseLinePoint = (value, label) => {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "number" ||
      typeof value[1] !== "number" ||
      !Number.isFinite(value[0]) ||
      !Number.isFinite(value[1]) ||
      value[0] < -90 ||
      value[0] > 90 ||
      value[1] < -180 ||
      value[1] > 180
    ) {
      throw new Error(`syncLine.${label} must be [latitude, longitude] in tracks/tracks.json.`);
    }
    return { lat: value[0], lon: value[1] };
  };
  const parsedSyncLine = {
    start: parseLinePoint(manifest.syncLine.start, "start"),
    end: parseLinePoint(manifest.syncLine.end, "end"),
  };
  if (distanceMeters(parsedSyncLine.start, parsedSyncLine.end) < 1) {
    throw new Error("The syncLine endpoints in tracks/tracks.json must be at least one meter apart.");
  }

  const files = new Set();
  const names = new Set();
  const colors = new Set();
  const definitions = manifest.tracks.map((entry, index) => {
    if (!entry || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`Track ${index + 1} needs a non-empty name in tracks/tracks.json.`);
    }
    if (
      typeof entry.file !== "string" ||
      !entry.file.toLowerCase().endsWith(".gpx") ||
      entry.file.includes("/") ||
      entry.file.includes("\\")
    ) {
      throw new Error(`Track ${entry.name} needs a GPX filename (not a path) in tracks/tracks.json.`);
    }
    const fileKey = entry.file.toLowerCase();
    const nameKey = entry.name.trim().toLowerCase();
    if (files.has(fileKey) || names.has(nameKey)) {
      throw new Error(`Track names and GPX filenames must be unique; check ${entry.name} in tracks/tracks.json.`);
    }
    files.add(fileKey);
    names.add(nameKey);

    const hasGear = entry.gear !== undefined && entry.gear !== null;
    if (hasGear && (typeof entry.gear !== "string" || !entry.gear.trim())) {
      throw new Error(`${entry.name} gear must be a non-empty string in tracks/tracks.json.`);
    }
    if (!DISCIPLINES.includes(entry.discipline)) {
      throw new Error(
        `${entry.name} discipline must be Windsurf, Windfoil, or Wingfoil in tracks/tracks.json.`,
      );
    }

    // Keep rendering resilient; CI separately requires explicit colors in the manifest.
    const hasColor = entry.color !== undefined && entry.color !== null;
    if (hasColor && (typeof entry.color !== "string" || !/^#[\da-f]{6}$/i.test(entry.color))) {
      throw new Error(`${entry.name} color must be a six-digit hex color in tracks/tracks.json.`);
    }
    const color = (hasColor ? entry.color : TRACK_COLORS[index])?.toLowerCase();
    if (!color) {
      throw new Error(`Add a unique color to ${entry.name} or extend the track color palette in app.js.`);
    }
    if (colors.has(color)) {
      throw new Error(`Track colors must be unique; check ${entry.name} in tracks/tracks.json.`);
    }
    colors.add(color);
    const hasSecondaryColor = entry.secondaryColor !== undefined && entry.secondaryColor !== null;
    if (
      hasSecondaryColor &&
      (typeof entry.secondaryColor !== "string" || !/^#[\da-f]{6}$/i.test(entry.secondaryColor))
    ) {
      throw new Error(`${entry.name} secondaryColor must be a six-digit hex color in tracks/tracks.json.`);
    }
    const secondaryColor = hasSecondaryColor ? entry.secondaryColor.toLowerCase() : null;
    if (secondaryColor === color) {
      throw new Error(`${entry.name} color and secondaryColor must be different.`);
    }

    const hasStartTime = entry.startTime !== undefined && entry.startTime !== null;
    if (hasStartTime) {
      const startHasTimezone =
        typeof entry.startTime === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(entry.startTime);
      if (!startHasTimezone || !Number.isFinite(Date.parse(entry.startTime))) {
        throw new Error(`${entry.name} startTime must be an ISO 8601 date-time with a timezone.`);
      }
    }
    if (entry.durationSeconds !== undefined && entry.durationSeconds !== null) {
      throw new Error(`${entry.name} durationSeconds must be provided inside timing.`);
    }
    const hasTiming = entry.timing !== undefined && entry.timing !== null;
    if (hasTiming && (typeof entry.timing !== "object" || Array.isArray(entry.timing))) {
      throw new Error(`${entry.name} timing must be an object.`);
    }
    let timing = null;
    if (hasTiming) {
      const hasTimingStart = entry.timing.start !== undefined && entry.timing.start !== null;
      const hasTimingDuration =
        entry.timing.durationSeconds !== undefined && entry.timing.durationSeconds !== null;
      if (!hasTimingStart || !hasTimingDuration) {
        throw new Error(`${entry.name} timing must contain both startTime and durationSeconds.`);
      }
      const timingStartHasTimezone =
        typeof entry.timing.start === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          entry.timing.start,
        );
      if (!timingStartHasTimezone || !Number.isFinite(Date.parse(entry.timing.start))) {
        throw new Error(`${entry.name} timing.start must be an ISO 8601 date-time with a timezone.`);
      }
      if (
        typeof entry.timing.durationSeconds !== "number" ||
        !Number.isFinite(entry.timing.durationSeconds) ||
        entry.timing.durationSeconds <= 0
      ) {
        throw new Error(`${entry.name} timing.durationSeconds must be a positive number.`);
      }
      timing = {
        start: entry.timing.start,
        durationSeconds: entry.timing.durationSeconds,
      };
    }
    if (entry.syncTime !== undefined && entry.syncTime !== null) {
      throw new Error(`${entry.name} syncTime is no longer supported; use startTime.`);
    }
    if (entry.syncAtStart !== undefined) {
      throw new Error(`${entry.name} syncAtStart is no longer supported; use startTime.`);
    }

    return {
      name: entry.name.trim(),
      file: entry.file,
      discipline: entry.discipline,
      gear: hasGear ? entry.gear.trim() : null,
      startTime: hasStartTime ? entry.startTime : null,
      timing,
      color,
      secondaryColor,
    };
  });
  return { tracks: definitions, syncLine: parsedSyncLine };
}

function createTwoCenterContext(points, line) {
  let latitudeTotal = 0;
  let longitudeTotal = 0;
  for (const point of points) {
    latitudeTotal += point.lat;
    longitudeTotal += point.lon;
  }
  const origin = {
    lat: latitudeTotal / points.length,
    lon: longitudeTotal / points.length,
  };
  const metersPerLongitude = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  let centerX = 0;
  let centerY = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const x = (point.lon - origin.lon) * metersPerLongitude;
    const y = (point.lat - origin.lat) * 111_132;
    centerX += x;
    centerY += y;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  centerX /= points.length;
  centerY /= points.length;
  const quarterSpan = (maxY - minY) / 4;
  const centers = [
    { x: centerX, y: centerY - quarterSpan },
    { x: centerX, y: centerY + quarterSpan },
  ];
  const gateCenter = {
    x: ((line.start.lon + line.end.lon) / 2 - origin.lon) * metersPerLongitude,
    y: ((line.start.lat + line.end.lat) / 2 - origin.lat) * 111_132,
  };
  return {
    origin,
    metersPerLongitude,
    centers: centers.map((point) => ({
      ...point,
      startAngle: Math.atan2(gateCenter.y - point.y, gateCenter.x - point.x),
    })),
  };
}

function getTwoCenterProgress(position, context) {
  const x = (position.lon - context.origin.lon) * context.metersPerLongitude;
  const y = (position.lat - context.origin.lat) * 111_132;
  const angularProgress = (center) => {
    const angle = Math.atan2(y - center.y, x - center.x) - center.startAngle;
    return ((angle / (2 * Math.PI)) % 1 + 1) % 1;
  };
  return (angularProgress(context.centers[0]) + angularProgress(context.centers[1])) / 2;
}

function copySyncLine(line) {
  return {
    start: { ...line.start },
    end: { ...line.end },
  };
}

function parseSyncLineParameter(value) {
  const parts = value.split(",");
  if (parts.length !== 4 || parts.some((part) => part.trim() === "")) return null;
  const [startLat, startLon, endLat, endLon] = parts.map(Number);
  const values = [startLat, startLon, endLat, endLon];
  if (
    values.some((coordinate) => !Number.isFinite(coordinate)) ||
    startLat < -90 ||
    startLat > 90 ||
    endLat < -90 ||
    endLat > 90 ||
    startLon < -180 ||
    startLon > 180 ||
    endLon < -180 ||
    endLon > 180
  ) {
    return null;
  }
  const line = {
    start: { lat: startLat, lon: startLon },
    end: { lat: endLat, lon: endLon },
  };
  return distanceMeters(line.start, line.end) >= 1 ? line : null;
}

function readShareState(manifest) {
  const params = new URLSearchParams(window.location.search);
  const warnings = [];
  let sharedMode = DEFAULT_MODE;
  if (params.has("mode")) {
    const requestedMode = params.get("mode");
    if (requestedMode === "absolute" || requestedMode === "relative") sharedMode = requestedMode;
    else warnings.push("Ignored invalid time mode in the URL.");
  }

  let sharedSyncLine = manifest.syncLine;
  if (params.has("sync")) {
    const parsedLine = parseSyncLineParameter(params.get("sync"));
    if (parsedLine) sharedSyncLine = parsedLine;
    else warnings.push("Ignored invalid sync points in the URL.");
  }

  let participantNames = null;
  if (params.has("participants")) {
    const requestedNames = params.get("participants").split(",").filter(Boolean);
    const availableNames = new Set(manifest.tracks.map((track) => track.name));
    const unknownNames = requestedNames.filter((name) => !availableNames.has(name));
    participantNames = new Set(requestedNames.filter((name) => availableNames.has(name)));
    if (unknownNames.length > 0) {
      warnings.push(`Ignored unknown participant${unknownNames.length === 1 ? "" : "s"}: ${unknownNames.join(", ")}.`);
    }
  }

  return {
    mode: sharedMode,
    syncLine: sharedSyncLine,
    participantNames,
    warning: warnings.join(" "),
  };
}

function syncLinesMatch(first, second) {
  return ["start", "end"].every(
    (endpoint) =>
      Math.abs(first[endpoint].lat - second[endpoint].lat) < 1e-10 &&
      Math.abs(first[endpoint].lon - second[endpoint].lon) < 1e-10,
  );
}

function updateShareUrl() {
  if (!shareStateReady) return;
  const url = new URL(window.location.href);
  const params = url.searchParams;

  params.delete("mode");
  if (mode !== DEFAULT_MODE) params.set("mode", mode);

  params.delete("sync");
  if (!syncLinesMatch(syncLine, defaultSyncLine)) {
    params.set(
      "sync",
      [
        syncLine.start.lat,
        syncLine.start.lon,
        syncLine.end.lat,
        syncLine.end.lon,
      ].join(","),
    );
  }

  params.delete("participants");
  if (!tracks.every((track) => track.visible)) {
    params.set(
      "participants",
      tracks.filter((track) => track.visible).map((track) => track.name).join(","),
    );
  }

  window.history.replaceState(window.history.state, "", url.href);
}

function estimatePointTimes(track, startEpoch, durationSeconds) {
  const cumulative = [0];
  for (let index = 1; index < track.points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + distanceMeters(track.points[index - 1], track.points[index]));
  }
  const totalDistance = cumulative[cumulative.length - 1];
  const rawHoldDuration = track.gpsHolds.reduce((total, hold) => total + hold.durationSeconds, 0);
  const heldDuration = Math.min(rawHoldDuration, durationSeconds * 0.25);
  const holdScale = rawHoldDuration > 0 ? heldDuration / rawHoldDuration : 1;
  const holds = track.gpsHolds.map((hold) => ({
    ...hold,
    durationSeconds: hold.durationSeconds * holdScale,
  }));
  let holdIndex = 0;
  let completedHoldDuration = 0;
  const movingDuration = durationSeconds - heldDuration;
  track.points.forEach((point, index) => {
    const fraction = totalDistance > 0 ? cumulative[index] / totalDistance : index / (track.points.length - 1);
    while (holdIndex < holds.length && index > holds[holdIndex].endIndex) {
      completedHoldDuration += holds[holdIndex].durationSeconds;
      holdIndex += 1;
    }
    const activeHold = holds[holdIndex];
    const withinHoldDuration =
      activeHold && index > activeHold.startIndex && index <= activeHold.endIndex
        ? activeHold.durationSeconds *
          ((index - activeHold.startIndex) / (activeHold.endIndex - activeHold.startIndex))
        : 0;
    point.elapsed = movingDuration * fraction + completedHoldDuration + withinHoldDuration;
    point.timestamp = startEpoch + point.elapsed;
  });
  track.approximate = true;
}

function projectToSyncLine(point, origin, latitudeScale) {
  return {
    x: (point.lon - origin.lon) * latitudeScale,
    y: (point.lat - origin.lat) * 111_132,
  };
}

function crossProduct(first, second) {
  return first.x * second.y - first.y * second.x;
}

function findSegmentIntersectionFraction(trackStart, trackEnd, lineStart, lineEnd, origin, latitudeScale) {
  const p = projectToSyncLine(trackStart, origin, latitudeScale);
  const p2 = projectToSyncLine(trackEnd, origin, latitudeScale);
  const q = projectToSyncLine(lineStart, origin, latitudeScale);
  const q2 = projectToSyncLine(lineEnd, origin, latitudeScale);
  const r = { x: p2.x - p.x, y: p2.y - p.y };
  const s = { x: q2.x - q.x, y: q2.y - q.y };
  const qMinusP = { x: q.x - p.x, y: q.y - p.y };
  const denominator = crossProduct(r, s);
  if (Math.abs(denominator) < 1e-8) return null;

  const trackFraction = crossProduct(qMinusP, s) / denominator;
  const lineFraction = crossProduct(qMinusP, r) / denominator;
  if (trackFraction < -1e-8 || trackFraction > 1 + 1e-8 || lineFraction < -1e-8 || lineFraction > 1 + 1e-8) {
    return null;
  }
  return Math.max(0, Math.min(1, trackFraction));
}

function findNearestPointToSyncLine(points, line, origin, latitudeScale) {
  const lineStart = projectToSyncLine(line.start, origin, latitudeScale);
  const lineEnd = projectToSyncLine(line.end, origin, latitudeScale);
  const lineVector = { x: lineEnd.x - lineStart.x, y: lineEnd.y - lineStart.y };
  const lineLengthSquared = lineVector.x ** 2 + lineVector.y ** 2;
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  points.forEach((point, index) => {
    const projected = projectToSyncLine(point, origin, latitudeScale);
    const fromStart = { x: projected.x - lineStart.x, y: projected.y - lineStart.y };
    const fraction = Math.max(
      0,
      Math.min(1, (fromStart.x * lineVector.x + fromStart.y * lineVector.y) / lineLengthSquared),
    );
    const closest = {
      x: lineStart.x + fraction * lineVector.x,
      y: lineStart.y + fraction * lineVector.y,
    };
    const distance = Math.hypot(projected.x - closest.x, projected.y - closest.y);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });

  return nearestIndex;
}

function getTrackSyncElapsed(track, line) {
  let syncElapsed = null;
  if (track.startTime && defaultSyncLine && syncLinesMatch(line, defaultSyncLine)) {
    syncElapsed = Date.parse(track.startTime) / 1000 - track.absoluteStart;
  } else {
    const origin = {
      lat: (line.start.lat + line.end.lat) / 2,
      lon: (line.start.lon + line.end.lon) / 2,
    };
    const latitudeScale = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
    for (let index = 0; index < track.points.length - 1; index += 1) {
      const fraction = findSegmentIntersectionFraction(
        track.points[index],
        track.points[index + 1],
        line.start,
        line.end,
        origin,
        latitudeScale,
      );
      if (fraction === null) continue;

      const first = track.points[index];
      const second = track.points[index + 1];
      syncElapsed = first.elapsed + (second.elapsed - first.elapsed) * fraction;
      break;
    }

    if (syncElapsed === null) {
      const nearestIndex = findNearestPointToSyncLine(track.points, line, origin, latitudeScale);
      syncElapsed = track.points[nearestIndex].elapsed;
    }
  }

  return syncElapsed;
}

function setTrackSyncPoint(track, line) {
  if (!track.timingReady || track.error) return;
  track.syncElapsed = getTrackSyncElapsed(track, line);
}

function calculateTrackCompletion(track, line) {
  if (track.completionCalculated || !track.timingReady || track.error) return;
  const startElapsed = getTrackSyncElapsed(track, line);
  const origin = {
    lat: (line.start.lat + line.end.lat) / 2,
    lon: (line.start.lon + line.end.lon) / 2,
  };
  const latitudeScale = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  let finishElapsed = null;
  for (let index = 0; index < track.points.length - 1; index += 1) {
    const fraction = findSegmentIntersectionFraction(
      track.points[index],
      track.points[index + 1],
      line.start,
      line.end,
      origin,
      latitudeScale,
    );
    if (fraction === null) continue;

    const first = track.points[index];
    const second = track.points[index + 1];
    const crossingElapsed = first.elapsed + (second.elapsed - first.elapsed) * fraction;
    if (crossingElapsed - startElapsed < MIN_FINISH_AFTER_SYNC_SECONDS) continue;
    finishElapsed = crossingElapsed;
    break;
  }

  track.completionCalculated = true;
  track.finishElapsed = finishElapsed;
  track.completionStartTime = track.absoluteStart + startElapsed;
  track.completionTime =
    finishElapsed === null ? track.absoluteEnd : track.absoluteStart + finishElapsed;
  track.completionDuration = Math.max(0, track.completionTime - track.completionStartTime);
  if (track.card) setTrackTimes(track);
}

function updateSyncLineLayer(line = syncLine) {
  syncLineLayer.setLatLngs([
    [line.start.lat, line.start.lon],
    [line.end.lat, line.end.lon],
  ]);
}

function isDefaultSyncLine(line) {
  return Boolean(line && defaultSyncLine && syncLinesMatch(line, defaultSyncLine));
}

function syncLineHandleIcon(line) {
  return L.divIcon({
    className: `sync-line-handle${isDefaultSyncLine(line) ? " sync-line-handle-default" : ""}`,
    html: "",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function updateSyncLineHandleAppearance(line = syncLine) {
  const isDefault = isDefaultSyncLine(line);
  for (const handle of syncLineHandles) {
    const element = handle.getElement();
    if (!element) continue;
    element.classList.toggle("sync-line-handle-default", isDefault);
    element.style.backgroundImage = isDefault ? "" : "none";
  }
}

function updateSyncLineHandleIcons(line = syncLine) {
  for (const handle of syncLineHandles) handle.setIcon(syncLineHandleIcon(line));
}

function createSyncLineHandle(endpoint) {
  const marker = L.marker([0, 0], {
    draggable: true,
    icon: syncLineHandleIcon(syncLine),
    title: `Drag to move the sync-line ${endpoint} point`,
  }).addTo(map);
  marker.dragging?.disable();
  marker.on("drag", () => {
    const position = marker.getLatLng();
    const point = { lat: position.lat, lon: position.lng };
    const line = { ...syncLine, [endpoint]: point };
    updateSyncLineLayer(line);
    updateSyncLineHandleAppearance(line);
  });
  marker.on("dragend", () => {
    const position = marker.getLatLng();
    const point = { lat: position.lat, lon: position.lng };
    const line = { ...syncLine, [endpoint]: point };
    if (distanceMeters(line.start, line.end) < 1) {
      marker.setLatLng([syncLine[endpoint].lat, syncLine[endpoint].lon]);
      updateSyncLineLayer();
      ui.status.textContent = "Sync-line endpoints must stay at least one meter apart.";
      return;
    }
    setSyncLine(line, true);
  });
  return marker;
}

function updateSyncLineVisibility() {
  const advancedOpen = ui.advancedSettings.open;
  const showHandles = advancedOpen && !drawingSyncLine;
  for (const handle of syncLineHandles) {
    if (!showHandles) {
      handle.dragging?.disable();
      setLayerVisibility(handle, false);
      continue;
    }

    setLayerVisibility(handle, true);
    if (mode === "relative") handle.dragging?.enable();
    else handle.dragging?.disable();
  }
  updateSyncLineHandleAppearance();
  if (syncLineLayer) setLayerVisibility(syncLineLayer, true);
}

function setSyncLine(line, resetRelativeTimeline = false) {
  syncLine = line;
  updateSyncLineLayer();
  for (const track of tracks) setTrackSyncPoint(track, syncLine);
  if (syncLineHandles.length === 0) {
    syncLineHandles.push(createSyncLineHandle("start"), createSyncLineHandle("end"));
  }
  syncLineHandles[0].setLatLng([syncLine.start.lat, syncLine.start.lon]);
  syncLineHandles[1].setLatLng([syncLine.end.lat, syncLine.end.lon]);
  updateSyncLineHandleIcons();
  updateSyncLineHandleAppearance();
  ui.resetSyncLine.disabled = !syncLineLayer || isDefaultSyncLine(syncLine);
  updateSyncLineVisibility();

  if (resetRelativeTimeline && mode === "relative") {
    pause();
    currentTime = 0;
    refreshTimeline();
  }
  updateShareUrl();
}

function finishSyncLineDrawing() {
  drawingSyncLine = false;
  pendingSyncLinePoints = [];
  pendingSyncLinePreviewPoint = null;
  ui.drawSyncLine.textContent = "Draw sync line";
  map.getContainer().style.cursor = "";
  if (syncLineStartMarker && map.hasLayer(syncLineStartMarker)) map.removeLayer(syncLineStartMarker);
  if (syncLinePreviewMarker && map.hasLayer(syncLinePreviewMarker)) map.removeLayer(syncLinePreviewMarker);
  syncLineStartMarker = null;
  syncLinePreviewMarker = null;
  updateSyncLineVisibility();
}

function cancelSyncLineDrawing() {
  if (!drawingSyncLine) return;
  finishSyncLineDrawing();
  updateSyncLineLayer();
  updateSyncLineVisibility();
}

function updateSyncLineControls() {
  const showControls = mode === "relative";
  ui.syncLineControls.hidden = !showControls;
  ui.drawSyncLine.disabled = !syncLineLayer;
  ui.resetSyncLine.disabled = !syncLineLayer || isDefaultSyncLine(syncLine);
  if (!showControls) cancelSyncLineDrawing();
  updateSyncLineVisibility();
}

function updateSyncLinePreview(point) {
  pendingSyncLinePreviewPoint = point;
  syncLineLayer.setLatLngs([
    [pendingSyncLinePoints[0].lat, pendingSyncLinePoints[0].lon],
    [point.lat, point.lon],
  ]);
  if (syncLinePreviewMarker) syncLinePreviewMarker.setLatLng([point.lat, point.lon]);
}

function handleSyncLineMapMove(event) {
  if (!drawingSyncLine || pendingSyncLinePoints.length === 0) return;
  updateSyncLinePreview({ lat: event.latlng.lat, lon: event.latlng.lng });
}

function handleSyncLineMapClick(event) {
  if (!drawingSyncLine) return;
  const point = { lat: event.latlng.lat, lon: event.latlng.lng };
  if (pendingSyncLinePoints.length === 0) {
    pendingSyncLinePoints.push(point);
    updateSyncLinePreview(point);
    setLayerVisibility(syncLineLayer, true);
    syncLineStartMarker = L.marker([point.lat, point.lon], {
      draggable: true,
      icon: L.divIcon({
        className: "sync-line-handle",
        html: "",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      title: "Drag to move the first sync-line endpoint",
    }).addTo(map);
    syncLineStartMarker.on("drag", (dragEvent) => {
      const start = dragEvent.target.getLatLng();
      pendingSyncLinePoints[0] = { lat: start.lat, lon: start.lng };
      if (pendingSyncLinePreviewPoint) updateSyncLinePreview(pendingSyncLinePreviewPoint);
    });
    syncLinePreviewMarker = L.circleMarker([point.lat, point.lon], {
      pane: "markerPane",
      radius: 4,
      color: "#ffffff",
      weight: 2,
      fillColor: "#73d5b1",
      fillOpacity: 1,
      renderer: markerRenderer,
    }).addTo(map);
    return;
  }

  const line = { start: pendingSyncLinePoints[0], end: point };
  if (distanceMeters(line.start, line.end) < 1) {
    ui.status.textContent = "Choose a sync-line endpoint at least one meter from the first point.";
    return;
  }

  finishSyncLineDrawing();
  setSyncLine(line, true);
}

function toggleSyncLineDrawing() {
  if (drawingSyncLine) {
    cancelSyncLineDrawing();
    return;
  }
  drawingSyncLine = true;
  pendingSyncLinePoints = [];
  updateSyncLineVisibility();
  ui.drawSyncLine.textContent = "Cancel drawing";
  map.getContainer().style.cursor = "crosshair";
}

function trackCard(track) {
  const card = document.createElement("article");
  card.className = "track-card";
  card.innerHTML = `
    <div class="track-name">
      <input class="track-visibility" type="checkbox" checked>
      <span class="swatch participant-color-dot"></span>
      <span class="track-label"></span>
      <span class="track-discipline-badge"></span>
      <span class="track-completion" title="Completion duration"></span>
    </div>
    <div class="track-detail" hidden>
      <p class="track-gear"></p>
      <p class="track-times"></p>
      <p class="track-metadata"></p>
    </div>
  `;
  const swatch = card.querySelector(".swatch");
  swatch.style.background = participantDotBackground(track);
  swatch.style.borderColor = participantDotBorderColor(track);
  card.querySelector(".track-label").textContent = track.name;
  const disciplineBadge = card.querySelector(".track-discipline-badge");
  disciplineBadge.textContent = track.discipline;
  disciplineBadge.dataset.discipline = track.discipline;
  disciplineBadge.setAttribute("aria-label", `Discipline: ${track.discipline}`);
  track.cardCompletion = card.querySelector(".track-completion");
  track.cardGear = card.querySelector(".track-gear");
  track.cardTimes = card.querySelector(".track-times");
  track.cardDetail = card.querySelector(".track-metadata");
  const visibility = card.querySelector(".track-visibility");
  visibility.setAttribute("aria-label", `Show ${track.name} on map`);
  visibility.addEventListener("change", () => {
    track.visible = visibility.checked;
    syncTrackVisibility(track);
    updateDisciplineFilterButtons();
    fitVisibleTracks();
    refreshTimeline();
    updateShareUrl();
  });
  track.card = card;
  return card;
}

function setTrackDetailsExpanded(expanded) {
  ui.toggleTrackDetails.setAttribute("aria-expanded", String(expanded));
  ui.toggleTrackDetails.textContent = expanded ? "Hide all details" : "Show all details";
  for (const track of tracks) {
    const details = track.card.querySelector(".track-detail");
    details.hidden = !expanded;
    track.card.classList.toggle("track-card-expanded", expanded);
  }
}

function setTrackError(track, message) {
  track.error = message;
  if (track.cardDetail) {
    track.cardCompletion.textContent = "Unavailable";
    track.cardCompletion.title = "Completion duration unavailable";
    track.cardGear.textContent = track.gear ? `Gear: ${track.gear}` : "Gear: not provided";
    track.cardTimes.textContent = "Start and finish times unavailable";
    track.cardDetail.textContent = message;
    track.cardDetail.classList.add("track-error");
  }
}

function gpsHoldNote(track) {
  if (track.gpsHolds.length === 0) return "";
  const count = track.gpsHolds.length;
  const rawDuration = track.gpsHolds.reduce((total, hold) => total + hold.durationSeconds, 0);
  const heldDuration = Math.min(rawDuration, (track.durationSeconds || rawDuration) * 0.25);
  const estimatedDuration = track.hasTimestamps
    ? ""
    : ` (~${formatDuration(Math.ceil(heldDuration))})`;
  return ` · ${count} GPS jump${count === 1 ? "" : "s"} held at prior position${estimatedDuration}`;
}

function setTrackTimes(track) {
  if (track.error) return;
  track.card.classList.toggle("track-card-estimated", Boolean(track.approximate));
  if (track.hasTimestamps) {
    if (track.timing) {
      setTrackError(track, `${track.name} timing is only for tracks without GPX timestamps.`);
      return;
    }
    track.absoluteStart = track.points[0].timestamp;
    track.absoluteEnd = track.points[track.points.length - 1].timestamp;
    track.points.forEach((point) => {
      point.elapsed = point.timestamp - track.absoluteStart;
    });
    track.timingReady = true;
  } else if (track.timing) {
    const startEpoch = Date.parse(track.timing.start) / 1000;
    track.durationSeconds = track.timing.durationSeconds;
    estimatePointTimes(track, startEpoch, track.durationSeconds);
    track.absoluteStart = startEpoch;
    track.absoluteEnd = startEpoch + track.durationSeconds;
    track.timingReady = true;
  }
  if (track.startTime) {
    const syncTimestamp = Date.parse(track.startTime) / 1000;
    if (syncTimestamp < track.absoluteStart || syncTimestamp > track.absoluteEnd) {
      setTrackError(
        track,
        `${track.name} startTime must be within its recorded GPX timestamps or supplied timing overrides.`,
      );
      return;
    }
  }
  track.cardGear.textContent = track.gear ? `Gear: ${track.gear}` : "Gear: not provided";
  if (track.timingReady) {
    const completionStartTime = Number.isFinite(track.completionStartTime)
      ? track.completionStartTime
      : track.absoluteStart;
    const completionTime = Number.isFinite(track.completionTime)
      ? track.completionTime
      : track.absoluteEnd;
    const completionDuration = Number.isFinite(track.completionDuration)
      ? track.completionDuration
      : track.absoluteEnd - track.absoluteStart;
    const finishMethod = Number.isFinite(track.finishElapsed)
      ? "finish-line crossing"
      : "end of recorded track";
    track.cardCompletion.textContent = `${track.approximate ? "* " : ""}${formatDuration(completionDuration)}`;
    track.cardCompletion.title = `${track.approximate ? "Estimated " : ""}duration from sync start to ${finishMethod}.`;
    track.cardTimes.textContent =
      `Start: ${formatClock(completionStartTime)} · Finish: ${formatClock(completionTime)}`;
    track.cardDetail.textContent =
      `${track.points.length.toLocaleString()} points · ${
        track.approximate ? "Estimated timing" : "Recorded GPX timestamps"
      }${gpsHoldNote(track)}${track.startTime ? " · Default-gate sync uses startTime" : ""} · ${
        Number.isFinite(track.finishElapsed) ? "Finish-line crossing used" : "Track end used"
      }`;
  } else {
    track.cardCompletion.textContent = "Unavailable";
    track.cardCompletion.title = "Completion duration unavailable";
    track.cardTimes.textContent = "Start and finish times unavailable";
    track.cardDetail.textContent =
      `${track.points.length.toLocaleString()} points · missing timing.start and timing.durationSeconds in tracks/tracks.json`;
  }
}

function configureGpsSpikeCorrection(track, enabled) {
  if (!track.sourcePoints) return;
  track.points = track.sourcePoints.map((point) => ({ ...point }));
  track.hasTimestamps = track.sourceHasTimestamps;
  const nominalSampleSeconds =
    track.hasTimestamps || !track.durationSeconds
      ? null
      : track.durationSeconds / (track.points.length - 1);
  track.gpsHolds = enabled ? detectGpsDropouts(track.points, nominalSampleSeconds) : [];
  track.fullLine.setLatLngs(trackCoordinates(track));
  setLayerVisibility(track.fullLine, track.visible && ui.showFullTrack.checked);
  track.lastIndex = -1;
  if (track.card) setTrackTimes(track);
}

function pointTime(track, index, activeMode) {
  return activeMode === "absolute"
    ? track.points[index].timestamp
    : track.points[index].elapsed - track.syncElapsed;
}

function getTimelineBounds() {
  const readyTracks = tracks.filter((track) => track.visible && track.timingReady && !track.error);
  if (readyTracks.length === 0) return null;
  if (mode === "relative") {
    const start = Math.min(
      ...readyTracks.map((track) => track.points[0].elapsed - track.syncElapsed),
    );
    const end = Math.max(
      ...readyTracks.map(
        (track) => track.points[track.points.length - 1].elapsed - track.syncElapsed,
      ),
    );
    return { start, end };
  }
  return {
    start: Math.min(...readyTracks.map((track) => track.absoluteStart)),
    end: Math.max(...readyTracks.map((track) => track.absoluteEnd)),
  };
}

function rebuildTrackPolyline(track, index, position) {
  const coordinates = track.points.slice(0, index + 1).map((point) => [point.lat, point.lon]);
  if (position && (coordinates.length === 0 || coordinates[coordinates.length - 1][0] !== position.lat || coordinates[coordinates.length - 1][1] !== position.lon)) {
    coordinates.push([position.lat, position.lon]);
  }
  track.progressLine.setLatLngs(coordinates);
}

function setMarkerVisible(track, visible) {
  track.marker.setOpacity(visible ? 1 : 0);
}

function setLayerVisibility(layer, visible) {
  const isVisible = map.hasLayer(layer);
  if (visible && !isVisible) layer.addTo(map);
  else if (!visible && isVisible) map.removeLayer(layer);
}

function syncTrackVisibility(track) {
  setLayerVisibility(track.marker, track.visible);
  setLayerVisibility(track.progressLine, track.visible);
  setLayerVisibility(track.fullLine, track.visible && ui.showFullTrack.checked);
  if (track.visible) updateMap(true);
}

function setTrackNamePinned(track, pinned) {
  track.marker.unbindTooltip();
  track.marker.bindTooltip(track.name, {
    className: "participant-name-tooltip",
    direction: "top",
    offset: [0, -8],
    opacity: 0.95,
    permanent: pinned && !track.error && track.points?.length > 0,
  });
}

function findPosition(track, time) {
  const firstTime = pointTime(track, 0, mode);
  const lastTime = pointTime(track, track.points.length - 1, mode);
  if (time < firstTime) {
    return { index: 0, position: track.points[0], started: false };
  }
  if (time >= lastTime) {
    const last = track.points.length - 1;
    return { index: last, position: track.points[last], started: true };
  }

  let low = 0;
  let high = track.points.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (pointTime(track, middle, mode) <= time) low = middle;
    else high = middle;
  }

  const first = track.points[low];
  const second = track.points[high];
  const firstTimeAt = pointTime(track, low, mode);
  const secondTimeAt = pointTime(track, high, mode);
  const fraction = secondTimeAt > firstTimeAt ? (time - firstTimeAt) / (secondTimeAt - firstTimeAt) : 0;
  return {
    index: low,
    started: true,
    position: {
      lat: first.lat + (second.lat - first.lat) * fraction,
      lon: first.lon + (second.lon - first.lon) * fraction,
    },
  };
}

function createLeaderboardRow(track) {
  const row = document.createElement("li");
  row.className = "leaderboard-row";
  row.dataset.participant = track.name;
  const place = document.createElement("span");
  place.className = "leaderboard-place";
  const name = document.createElement("span");
  name.className = "leaderboard-name";
  name.textContent = track.name;
  const completion = document.createElement("span");
  completion.className = "leaderboard-time";
  const color = document.createElement("span");
  color.className = "participant-color-dot leaderboard-color";
  color.setAttribute("aria-hidden", "true");
  color.style.background = participantDotBackground(track);
  color.style.borderColor = participantDotBorderColor(track);
  row.append(place, name, completion, color);
  return row;
}

function animateLeaderboardRows(rows, previousPositions) {
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  for (const row of rows) {
    const previousTop = previousPositions.get(row);
    if (previousTop === undefined || typeof row.animate !== "function") continue;
    const offset = previousTop - row.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    row.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
      { duration: 220, easing: "ease-out" },
    );
  }
}

function setLeaderboardCollapsed(collapsed) {
  ui.leaderboardContent.hidden = collapsed;
  ui.leaderboardCollapse.setAttribute("aria-expanded", String(!collapsed));
  ui.leaderboardCollapse.setAttribute(
    "aria-label",
    `${collapsed ? "Expand" : "Collapse"} leaderboard`,
  );
  ui.leaderboardCollapse.textContent = collapsed ? "+" : "-";
}

function updateLeaderboard(positionStates) {
  const entries = positionStates
    .map(({ track, state }) => {
      const finishTime =
        mode === "relative"
          ? track.completionTime - track.absoluteStart - track.syncElapsed
          : track.completionTime;
      const raceStartTime = mode === "relative" ? 0 : track.completionStartTime;
      return {
        track,
        progress:
          currentTime < raceStartTime
            ? 0
            : getTwoCenterProgress(state.position, triangulationContext),
        finished: currentTime >= finishTime,
      };
    });

  const compareFinishers = (first, second) =>
    first.track.completionDuration - second.track.completionDuration ||
    first.track.order - second.track.order;
  const compareProgress = (first, second) => {
    if (first.finished !== second.finished) return first.finished ? -1 : 1;
    if (first.finished) return compareFinishers(first, second);
    return second.progress - first.progress || first.track.order - second.track.order;
  };
  const ranking = [...entries].sort(
    mode === "absolute"
      ? compareFinishers
      : compareProgress,
  );

  const wasHidden = ui.leaderboard.hidden;
  ui.leaderboard.hidden = false;
  const signature = JSON.stringify(
    ranking.map(({ track, finished }) => [track.name, finished]),
  );
  if (signature === lastLeaderboardSignature) return;
  lastLeaderboardSignature = signature;

  const existingRows = new Map(
    Array.from(ui.leaderboardList.children, (row) => [row.dataset.participant, row]),
  );
  const previousPositions = new Map();
  if (!wasHidden && !ui.leaderboardContent.hidden) {
    for (const row of existingRows.values()) {
      previousPositions.set(row, row.getBoundingClientRect().top);
    }
  }
  for (const row of existingRows.values()) {
    for (const animation of row.getAnimations?.() ?? []) animation.cancel();
  }

  const rows = ranking.map(({ track, finished }, index) => {
    const row = existingRows.get(track.name) ?? createLeaderboardRow(track);
    const place = row.querySelector(".leaderboard-place");
    place.textContent = String(index + 1);
    place.setAttribute(
      "aria-label",
      `${mode === "absolute" ? "Completion result" : "Two-center angle"} rank ${index + 1}`,
    );
    const completion = row.querySelector(".leaderboard-time");
    completion.textContent = finished
      ? `${track.approximate ? "* " : ""}${formatDuration(track.completionDuration)}`
      : "";
    completion.title = finished
      ? `${track.approximate ? "Estimated " : ""}elapsed time to ${
          Number.isFinite(track.finishElapsed) ? "finish-line crossing" : "end of recorded track"
        }.`
      : "";
    return row;
  });
  ui.leaderboardList.replaceChildren(...rows);
  ui.leaderboardEmpty.hidden = ranking.length > 0;
  animateLeaderboardRows(rows, previousPositions);
}

function updateMap(force = false) {
  const positionStates = [];
  for (const track of tracks) {
    if (!track.visible || !track.timingReady || track.error) {
      setMarkerVisible(track, false);
      track.progressLine.setLatLngs([]);
      continue;
    }
    const state = findPosition(track, currentTime);
    if (!state) {
      setMarkerVisible(track, false);
      track.progressLine.setLatLngs([]);
      continue;
    }
    positionStates.push({ track, state });
    track.marker.setLatLng([state.position.lat, state.position.lon]);
    setMarkerVisible(track, true);
    if (!state.started) {
      track.progressLine.setLatLngs([]);
      track.lastIndex = -1;
      continue;
    }
    if (force || state.index !== track.lastIndex) {
      rebuildTrackPolyline(track, state.index, state.position);
      track.lastIndex = state.index;
    }
  }
  updateLeaderboard(positionStates);
}

function updateClock(force = false) {
  const second = Math.floor(currentTime);
  if (!force && second === lastClockSecond && mode === lastClockMode) return;
  lastClockSecond = second;
  lastClockMode = mode;
  const playbackTime =
    mode === "absolute" ? formatClock(currentTime) : formatRelativeTime(currentTime);
  ui.elapsed.textContent = playbackTime;
  ui.clock.textContent = playbackTime;
  ui.seek.value = String(Math.round(currentTime - rangeStart));
}

function refreshTimeline(resetPosition = false) {
  const visibleTracks = tracks.filter((track) => track.visible);
  const bounds = getTimelineBounds();
  if (!bounds || !Number.isFinite(bounds.end) || bounds.end <= bounds.start) {
    pause();
    ui.syncPositionMarker.hidden = true;
    ui.play.disabled = true;
    ui.reset.disabled = true;
    ui.seek.disabled = true;
    ui.seek.max = "0";
    ui.clock.textContent = "--:--:--";
    ui.elapsed.textContent = "00:00:00";
    ui.status.textContent =
      visibleTracks.length === 0
        ? "Select at least one participant to enable playback."
        : visibleTracks.some((track) => track.error)
          ? "One or more selected tracks could not be loaded. See participant details."
          : "Add timing.start and timing.durationSeconds for untimed tracks in tracks/tracks.json to enable playback.";
    updateMap(true);
    return;
  }

  rangeStart = bounds.start;
  rangeEnd = bounds.end;
  ui.seek.max = String(Math.ceil(rangeEnd - rangeStart));
  ui.syncPositionMarker.hidden = mode !== "relative";
  if (mode === "relative") {
    ui.syncPositionMarker.style.left = `${(-rangeStart / Number(ui.seek.max)) * 100}%`;
  }
  ui.seek.disabled = false;
  ui.play.disabled = false;
  ui.reset.disabled = false;
  if (resetPosition || currentTime < rangeStart || currentTime > rangeEnd) {
    currentTime = mode === "relative" ? 0 : rangeStart;
  }
  ui.status.textContent = visibleTracks.some((track) => track.error)
    ? "One or more tracks could not be loaded. See participant details."
    : visibleTracks.some((track) => !track.timingReady)
      ? "All routes are shown. Add timing.start and timing.durationSeconds in tracks/tracks.json to include untimed tracks in playback."
      : "";
  updateClock(true);
  updateMap(true);
}

function pause() {
  playing = false;
  if (frameId) cancelAnimationFrame(frameId);
  frameId = 0;
  lastFrameAt = null;
  ui.play.textContent = "Play";
}

function animate(now) {
  if (!playing) return;
  const deltaSeconds = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000;
  lastFrameAt = now;
  currentTime = Math.min(rangeEnd, currentTime + deltaSeconds * Number(ui.speed.value));
  updateClock();
  updateMap();
  if (currentTime >= rangeEnd) {
    pause();
    return;
  }
  frameId = requestAnimationFrame(animate);
}

function startPause() {
  if (playing) {
    pause();
    return;
  }
  if (currentTime >= rangeEnd) currentTime = rangeStart;
  playing = true;
  lastFrameAt = null;
  ui.play.textContent = "Pause";
  frameId = requestAnimationFrame(animate);
}

function setSpeedLabel() {
  const speed = Number(ui.speed.value);
  ui.speedValue.textContent = speed === 1 ? "1× · real time" : `${speed}×`;
}

function setDefaultPlaybackSpeed() {
  const durations = tracks
    .filter((track) => track.timingReady && !track.error)
    .map((track) => track.completionDuration)
    .sort((first, second) => first - second);
  if (durations.length === 0) return;

  const middle = Math.floor(durations.length / 2);
  const medianDuration =
    durations.length % 2 === 0 ? (durations[middle - 1] + durations[middle]) / 2 : durations[middle];
  const step = Number(ui.speed.step);
  const minimum = Number(ui.speed.min);
  const defaultSpeed = Math.max(minimum, Math.round((medianDuration / 60) / step) * step);
  const maxSpeed = Math.max(500, Math.ceil((defaultSpeed * 1.5) / step) * step);

  ui.speed.max = String(maxSpeed);
  ui.speed.value = String(defaultSpeed);
  ui.speedMax.textContent = `${maxSpeed}×`;
  setSpeedLabel();
}

function trackCoordinates(track) {
  return track.points.map((point) => [point.lat, point.lon]);
}

async function loadTrack(definition) {
  const track = {
    ...definition,
    durationSeconds: definition.timing?.durationSeconds ?? null,
    order: tracks.length,
    hasTimestamps: true,
    timingReady: false,
    visible: true,
    error: null,
    lastIndex: -1,
    gpsHolds: [],
    sourcePoints: null,
    sourceHasTimestamps: false,
  };
  tracks.push(track);
  track.fullLine = L.polyline([], {
    color: track.color,
    opacity: 0.28,
    weight: 2.5,
    renderer: L.canvas(),
  });
  track.progressLine = L.polyline([], {
    color: track.color,
    opacity: 0.95,
    weight: 3.5,
    renderer: L.canvas(),
  }).addTo(map);
  track.marker = L.marker([0, 0], {
    pane: "markerPane",
    icon: participantMarkerIcon(track),
    opacity: 0,
    keyboard: false,
  }).addTo(map);
  try {
    const response = await fetch(new URL(definition.file, TRACK_MANIFEST_URL));
    if (!response.ok) throw new Error(`Could not load GPX (${response.status} ${response.statusText}).`);
    const parsed = parseGpx(await response.text());
    track.name = definition.name;
    track.sourcePoints = parsed.points;
    track.sourceHasTimestamps = parsed.hasTimestamps;
    configureGpsSpikeCorrection(track, ui.gpsSpikeCorrection.checked);
  } catch (error) {
    track.error = error instanceof Error ? error.message : "Could not load this GPX file.";
    track.points = [];
  }
  setTrackNamePinned(track, ui.pinNames.checked);
  track.card = trackCard(track);
  if (track.error) setTrackError(track, track.error);
  else setTrackTimes(track);
}

function sortParticipantList() {
  const sortedTracks = [...tracks].sort((first, second) => {
    if (first.timingReady !== second.timingReady) return first.timingReady ? -1 : 1;
    if (first.timingReady) {
      const firstDuration = first.completionDuration ?? first.absoluteEnd - first.absoluteStart;
      const secondDuration = second.completionDuration ?? second.absoluteEnd - second.absoluteStart;
      const durationDifference = firstDuration - secondDuration;
      if (durationDifference !== 0) return durationDifference;
    }
    return first.order - second.order;
  });
  ui.trackList.replaceChildren(...sortedTracks.map((track) => track.card));
}

function updateDisciplineFilterButtons() {
  for (const button of ui.disciplineFilters.querySelectorAll("[data-discipline]")) {
    const discipline = button.dataset.discipline;
    const disciplineTracks = tracks.filter((track) => track.discipline === discipline);
    const allVisible =
      disciplineTracks.length > 0 && disciplineTracks.every((track) => track.visible);
    button.disabled = disciplineTracks.length === 0;
    button.setAttribute("aria-pressed", String(allVisible));
    button.title = allVisible
      ? `Hide all ${discipline} participants`
      : `Show all ${discipline} participants`;
  }
}

function toggleDisciplineVisibility(discipline) {
  const disciplineTracks = tracks.filter((track) => track.discipline === discipline);
  if (disciplineTracks.length === 0) return;

  const visible = !disciplineTracks.every((track) => track.visible);
  for (const track of disciplineTracks) {
    track.visible = visible;
    track.card.querySelector(".track-visibility").checked = visible;
    syncTrackVisibility(track);
  }
  updateDisciplineFilterButtons();
  fitVisibleTracks();
  refreshTimeline();
  updateShareUrl();
}

function fitVisibleTracks() {
  const visiblePoints = tracks
    .filter((track) => track.visible && !track.error)
    .flatMap((track) => track.points || []);
  if (visiblePoints.length === 0) return;
  const bounds = L.latLngBounds(visiblePoints.map((point) => [point.lat, point.lon]));
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.08), { maxZoom: 15 });
}

ui.play.addEventListener("click", startPause);
ui.drawSyncLine.addEventListener("click", toggleSyncLineDrawing);
ui.disciplineFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-discipline]");
  const discipline = button?.dataset.discipline;
  if (DISCIPLINES.includes(discipline)) toggleDisciplineVisibility(discipline);
});
ui.resetSyncLine.addEventListener("click", () => {
  if (!defaultSyncLine || isDefaultSyncLine(syncLine)) return;
  setSyncLine(copySyncLine(defaultSyncLine), true);
});
ui.toggleTrackDetails.addEventListener("click", () => {
  const expanded = ui.toggleTrackDetails.getAttribute("aria-expanded") !== "true";
  setTrackDetailsExpanded(expanded);
});
ui.advancedSettings.addEventListener("toggle", updateSyncLineVisibility);
map.on("click", handleSyncLineMapClick);
map.on("mousemove", handleSyncLineMapMove);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelSyncLineDrawing();
});
ui.showFullTrack.addEventListener("change", () => {
  for (const track of tracks) {
    setLayerVisibility(track.fullLine, track.visible && ui.showFullTrack.checked);
  }
});
ui.pinNames.addEventListener("change", () => {
  for (const track of tracks) setTrackNamePinned(track, ui.pinNames.checked);
});
ui.leaderboardCollapse.addEventListener("click", () => {
  setLeaderboardCollapsed(ui.leaderboardCollapse.getAttribute("aria-expanded") === "true");
});
ui.gpsSpikeCorrection.addEventListener("change", () => {
  pause();
  for (const track of tracks) {
    configureGpsSpikeCorrection(track, ui.gpsSpikeCorrection.checked);
    setTrackSyncPoint(track, syncLine);
  }
  refreshTimeline(mode === "relative");
});
ui.reset.addEventListener("click", () => {
  pause();
  currentTime = mode === "relative" ? 0 : rangeStart;
  updateClock(true);
  updateMap(true);
});
ui.seek.addEventListener("input", () => {
  currentTime = rangeStart + Number(ui.seek.value);
  updateClock();
  updateMap(true);
});
ui.speed.addEventListener("input", setSpeedLabel);
ui.mode.addEventListener("change", () => {
  const progress = rangeEnd > rangeStart ? (currentTime - rangeStart) / (rangeEnd - rangeStart) : 0;
  mode = ui.mode.value;
  updateSyncLineControls();
  const bounds = getTimelineBounds();
  if (bounds) currentTime = bounds.start + progress * (bounds.end - bounds.start);
  refreshTimeline();
  updateShareUrl();
});

setSpeedLabel();
async function initialize() {
  try {
    const manifest = await loadTrackManifest();
    const shareState = readShareState(manifest);
    mode = shareState.mode;
    ui.mode.value = mode;
    defaultSyncLine = copySyncLine(manifest.syncLine);
    const definitions = manifest.tracks;
    ui.trackCount.textContent = String(definitions.length);
    await Promise.all(definitions.map((definition) => loadTrack(definition)));
    const coursePoints = tracks
      .filter((track) => !track.error && track.points.length > 0)
      .flatMap((track) => track.points);
    if (coursePoints.length > 0) {
      triangulationContext = createTwoCenterContext(coursePoints, defaultSyncLine);
    }
    for (const track of tracks) calculateTrackCompletion(track, defaultSyncLine);
    sortParticipantList();
    ui.toggleTrackDetails.disabled = false;
    if (shareState.participantNames) {
      for (const track of tracks) {
        track.visible = shareState.participantNames.has(track.name);
        track.card.querySelector(".track-visibility").checked = track.visible;
      }
    }
    updateDisciplineFilterButtons();
    syncLineLayer = L.polyline([], {
      color: "#ffffff",
      opacity: 0.95,
      weight: 3,
      dashArray: "8 6",
      renderer: markerRenderer,
    });
    setSyncLine(shareState.syncLine);
    for (const track of tracks) {
      if (!track.visible) syncTrackVisibility(track);
    }
    updateSyncLineControls();
    setDefaultPlaybackSpeed();
    fitVisibleTracks();
    shareStateReady = true;
    refreshTimeline(true);
    updateShareUrl();
    if (shareState.warning) {
      ui.status.textContent = [ui.status.textContent, shareState.warning].filter(Boolean).join(" ");
    }
    ui.gpsSpikeCorrection.disabled = false;
  } catch (error) {
    ui.trackCount.textContent = "0";
    ui.status.textContent = error instanceof Error ? error.message : "Could not load the track manifest.";
  }
}

initialize();
