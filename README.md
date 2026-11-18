# Winduro race playback

[Open the Winduro race viewer](https://jpathome.github.io/WinduroPlayback/).

Explore participant GPX tracks around the island course with synchronized playback, an interactive map, and absolute or relative time.

## Run locally

From the project directory, start Python's static server:

```powershell
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000). Press `Ctrl+C` in the terminal to stop the server.

## Using the viewer

- Choose **Absolute** to follow event clock time or **Relative** to align riders at the sync-line crossing.
- Use **Play**, **Reset**, the race-position slider, and playback-speed control to navigate the race. Pan and zoom the map to inspect the course.
- The map leaderboard starts collapsed. It shows fixed completion-time order in **Absolute** mode and live counterclockwise two-center angle ranking in **Relative** mode, including checked participants; use its top-right button to expand or collapse the list.
- Expand **Advanced settings** to pin names, show full routes, hold position through detected GPS dropouts, or draw and adjust the relative-time sync line.
- Select participants in the list to show or hide their tracks. Use **Show all details** to view gear, start and finish times, and timing information for every participant.

## Track timing

Tracks with timestamps use their recorded times. For tracks without point timestamps, start time and duration are used to estimate positions between recorded points. This timing is approximate and cannot reproduce exact pauses or synchronization.

Completion times are calculated once from the manifest's default sync line: from its synced start to the first later crossing at least 30 minutes afterward. If no qualifying crossing exists, the track end is used. Moving the playback sync line does not change participant times.

Event data lives in `by-date/YYYY-MM-DD/` (`tracks.json` plus one GPX per racer). Cross-event racer views live under `by-racer/<racer_id>/` as generated manifests that reference GPX files in `by-date/` (no duplicate GPX copies).

Use the **Event** dropdown to load one race day (`?date=YYYY-MM-DD` in the URL). Use **Racer** to compare the same person across events (`?racer=Racer_Id`). Only one of those parameters is used at a time; with no parameter, the most recent event loads. Run `python scripts/update_tracks.py` after adding dated folders to refresh `catalog.json` and the `by-racer/` manifests. Generated racer manifests assign unique primary colors from `colors.js`.

Each manifest contains participant details, gear, timing estimates, track colors, and the default sync line. Set `color` and optional `secondaryColor` to six-digit hex values in event manifests; secondary colors appear in participant swatches and marker outlines, while routes stay in the primary color. **Timing for untimed tracks is estimated.**

## Contributing track data

Add or update a dated folder under `by-date/`, then run `python scripts/validate_tracks.py` (and optionally `python scripts/update_tracks.py` to refresh generated files locally). GitHub Actions runs the update check and validation on every PR. When changes merge to `main`, Actions runs `scripts/update_tracks.py`, validates manifests and GPX files, and deploys the site, including the generated `by-racer/` output (which is not committed), to GitHub Pages. Each participant needs a unique primary `color` in event manifests; `secondaryColor` is optional. The check also validates catalog freshness, manifest fields, timing metadata, GPX coordinates, and timestamps.

For a timestamped track that needs a manual crossing at the default sync gate, set top-level `startTime` to the intended ISO 8601 timestamp. The override is ignored for non-default gates, where crossings are recalculated from the GPX route. For tracks without point timestamps, put estimated timing in a `timing` object with `start` and `durationSeconds`.

## Map and data

The map uses [Leaflet 1.9.4](https://leafletjs.com/reference-1.9.4.html) and Esri World Imagery. Imagery attribution is shown on the map; review [Esri's World Imagery terms](https://goto.arcgisonline.com/maps/World_Imagery) and [data attribution guidance](https://www.esri.com/en-us/legal/terms/data-attributions).

This public site includes participant GPX tracks and precise route locations. The participants have approved their publication.

