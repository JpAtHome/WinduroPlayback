const TRACK_MANIFEST_URL = new URL("./tracks/tracks.json", document.baseURI);
const TRACK_COLORS = ["#59d5ff", "#ffcb5b", "#ff7297", "#9d8aff", "#7ee089", "#ff9864"];

const TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION =
  "Tiles &copy; Esri — Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community";
const EARTH_RADIUS_METERS = 6_371_000;
const GPS_SPIKE_MAX_SPEED_METERS_PER_SECOND = 60;
const GPS_SPIKE_RETURN_DISTANCE_METERS = 100;
const GPS_SPIKE_MIN_EXCURSION_METERS = 500;
const GPS_SPIKE_LOOKAHEAD_POINTS = 60;
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
  gpsSpikeCorrection: document.querySelector("#gps-spike-correction"),
  seek: document.querySelector("#seek"),
  speed: document.querySelector("#speed"),
  speedValue: document.querySelector("#speed-value"),
  speedMax: document.querySelector("#speed-max"),
  advancedSettings: document.querySelector("#advanced-settings"),
  syncLineControls: document.querySelector("#sync-line-controls"),
  syncPositionMarker: document.querySelector("#sync-position-marker"),
  drawSyncLine: document.querySelector("#draw-sync-line"),
  status: document.querySelector("#status"),
  trackCount: document.querySelector("#track-count"),
  toggleTrackDetails: document.querySelector("#toggle-track-details"),
  trackList: document.querySelector("#track-list"),
};

const tracks = [];
let mode = ui.mode.value;
let rangeStart = 0;
let rangeEnd = 0;
let currentTime = 0;
let playing = false;
let frameId = 0;
let lastFrameAt = null;
let lastClockSecond = null;
let lastClockMode = null;
let syncLine = null;
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

    const hasStartTime = entry.startTime !== undefined && entry.startTime !== null;
    const hasDuration = entry.durationSeconds !== undefined && entry.durationSeconds !== null;
    if (hasStartTime !== hasDuration) {
      throw new Error(`${entry.name} must have both startTime and durationSeconds, or neither.`);
    }
    if (hasStartTime) {
      const startHasTimezone =
        typeof entry.startTime === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(entry.startTime);
      if (!startHasTimezone || !Number.isFinite(Date.parse(entry.startTime))) {
        throw new Error(`${entry.name} startTime must be an ISO 8601 date-time with a timezone, such as 2026-11-08T17:00:00Z.`);
      }
      if (typeof entry.durationSeconds !== "number" || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds <= 0) {
        throw new Error(`${entry.name} durationSeconds must be a positive number.`);
      }
    }

    return {
      name: entry.name.trim(),
      file: entry.file,
      gear: hasGear ? entry.gear.trim() : null,
      startTime: hasStartTime ? entry.startTime : null,
      durationSeconds: hasDuration ? entry.durationSeconds : null,
      color: TRACK_COLORS[index % TRACK_COLORS.length],
    };
  });
  return { tracks: definitions, syncLine: parsedSyncLine };
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

function setTrackSyncPoint(track, line) {
  if (!track.timingReady || track.error) return;

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
    track.syncElapsed = first.elapsed + (second.elapsed - first.elapsed) * fraction;
    return;
  }

  const nearestIndex = findNearestPointToSyncLine(track.points, line, origin, latitudeScale);
  track.syncElapsed = track.points[nearestIndex].elapsed;
}

function updateSyncLineLayer(line = syncLine) {
  syncLineLayer.setLatLngs([
    [line.start.lat, line.start.lon],
    [line.end.lat, line.end.lon],
  ]);
}

function createSyncLineHandle(endpoint) {
  const marker = L.marker([0, 0], {
    draggable: true,
    icon: L.divIcon({
      className: "sync-line-handle",
      html: "",
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
    title: `Drag to move the sync-line ${endpoint} point`,
  }).addTo(map);
  marker.dragging?.disable();
  marker.on("drag", () => {
    const position = marker.getLatLng();
    const point = { lat: position.lat, lon: position.lng };
    updateSyncLineLayer({ ...syncLine, [endpoint]: point });
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
  updateSyncLineVisibility();

  if (resetRelativeTimeline && mode === "relative") {
    pause();
    currentTime = 0;
    refreshTimeline();
  }
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
      <span class="swatch" style="background:${track.color}"></span>
      <span class="track-label"></span>
      <span class="track-completion" title="Completion duration"></span>
    </div>
    <div class="track-detail" hidden>
      <p class="track-gear"></p>
      <p class="track-times"></p>
      <p class="track-metadata"></p>
    </div>
  `;
  card.querySelector(".track-label").textContent = track.name;
  track.cardCompletion = card.querySelector(".track-completion");
  track.cardGear = card.querySelector(".track-gear");
  track.cardTimes = card.querySelector(".track-times");
  track.cardDetail = card.querySelector(".track-metadata");
  const visibility = card.querySelector(".track-visibility");
  visibility.setAttribute("aria-label", `Show ${track.name} on map`);
  visibility.addEventListener("change", () => {
    track.visible = visibility.checked;
    syncTrackVisibility(track);
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
  if (track.hasTimestamps) {
    track.absoluteStart = track.points[0].timestamp;
    track.absoluteEnd = track.points[track.points.length - 1].timestamp;
    track.points.forEach((point) => {
      point.elapsed = point.timestamp - track.absoluteStart;
    });
    track.timingReady = true;
  } else if (track.startTime && track.durationSeconds) {
    const startEpoch = Date.parse(track.startTime) / 1000;
    estimatePointTimes(track, startEpoch, track.durationSeconds);
    track.absoluteStart = startEpoch;
    track.absoluteEnd = startEpoch + track.durationSeconds;
    track.timingReady = true;
  }
  track.cardGear.textContent = track.gear ? `Gear: ${track.gear}` : "Gear: not provided";
  if (track.timingReady) {
    const duration = track.absoluteEnd - track.absoluteStart;
    track.cardCompletion.textContent = `${track.approximate ? "~ " : ""}${formatDuration(duration)}`;
    track.cardCompletion.title = track.approximate
      ? "Estimated completion duration"
      : "Recorded completion duration";
    track.cardTimes.textContent =
      `Start: ${formatClock(track.absoluteStart)} · Finish: ${formatClock(track.absoluteEnd)}`;
    track.cardDetail.textContent =
      `${track.points.length.toLocaleString()} points · ${
        track.approximate ? "Estimated timing" : "Recorded GPX timestamps"
      }${gpsHoldNote(track)}`;
  } else {
    track.cardCompletion.textContent = "Unavailable";
    track.cardCompletion.title = "Completion duration unavailable";
    track.cardTimes.textContent = "Start and finish times unavailable";
    track.cardDetail.textContent =
      `${track.points.length.toLocaleString()} points · missing startTime and durationSeconds in tracks/tracks.json`;
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
  const readyTracks = tracks.filter((track) => track.timingReady && !track.error);
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
  const opacity = visible ? 1 : 0;
  track.marker.setStyle({ opacity, fillOpacity: opacity });
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

function updateMap(force = false) {
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
}

function updateClock(force = false) {
  const second = Math.floor(currentTime);
  if (!force && second === lastClockSecond && mode === lastClockMode) return;
  lastClockSecond = second;
  lastClockMode = mode;
  ui.elapsed.textContent =
    mode === "absolute" ? formatClock(currentTime) : formatDuration(currentTime - rangeStart);
  ui.clock.textContent = mode === "absolute" ? formatClock(currentTime) : formatRelativeTime(currentTime);
  ui.seek.value = String(Math.round(currentTime - rangeStart));
}

function refreshTimeline(resetPosition = false) {
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
    ui.status.textContent = "Add startTime and durationSeconds for untimed tracks in tracks/tracks.json to enable playback.";
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
  ui.status.textContent = tracks.some((track) => track.error)
    ? "One or more tracks could not be loaded. See participant details."
    : tracks.some((track) => !track.timingReady)
      ? "All routes are shown. Add startTime and durationSeconds in tracks/tracks.json to include untimed tracks in playback."
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
    .map((track) => track.absoluteEnd - track.absoluteStart)
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
  track.marker = L.circleMarker([0, 0], {
    pane: "markerPane",
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: track.color,
    fillOpacity: 1,
    opacity: 0,
    renderer: markerRenderer,
  }).addTo(map);
  track.marker.bindTooltip(track.name, {
    direction: "top",
    offset: [0, -8],
    opacity: 0.95,
  });

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
  track.card = trackCard(track);
  if (track.error) setTrackError(track, track.error);
  else setTrackTimes(track);
}

function sortParticipantList() {
  const sortedTracks = [...tracks].sort((first, second) => {
    if (first.timingReady !== second.timingReady) return first.timingReady ? -1 : 1;
    if (first.timingReady) {
      const durationDifference =
        first.absoluteEnd - first.absoluteStart - (second.absoluteEnd - second.absoluteStart);
      if (durationDifference !== 0) return durationDifference;
    }
    return first.order - second.order;
  });
  ui.trackList.replaceChildren(...sortedTracks.map((track) => track.card));
}

function initializeMapBounds() {
  const allPoints = tracks.flatMap((track) => track.points || []);
  if (allPoints.length === 0) return;
  const bounds = L.latLngBounds(allPoints.map((point) => [point.lat, point.lon]));
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.08), { maxZoom: 15 });
}

ui.play.addEventListener("click", startPause);
ui.drawSyncLine.addEventListener("click", toggleSyncLineDrawing);
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
});

setSpeedLabel();
async function initialize() {
  try {
    const manifest = await loadTrackManifest();
    const definitions = manifest.tracks;
    ui.trackCount.textContent = String(definitions.length);
    await Promise.all(definitions.map(loadTrack));
    sortParticipantList();
    ui.toggleTrackDetails.disabled = false;
    syncLineLayer = L.polyline([], {
      color: "#ffffff",
      opacity: 0.95,
      weight: 3,
      dashArray: "8 6",
      renderer: markerRenderer,
    });
    setSyncLine(manifest.syncLine);
    updateSyncLineControls();
    setDefaultPlaybackSpeed();
    initializeMapBounds();
    refreshTimeline(true);
    ui.gpsSpikeCorrection.disabled = false;
  } catch (error) {
    ui.trackCount.textContent = "0";
    ui.status.textContent = error instanceof Error ? error.message : "Could not load the track manifest.";
  }
}

initialize();
