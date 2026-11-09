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
- Expand **Advanced settings** to show full routes, hold position through detected GPS dropouts, or draw and adjust the relative-time sync line.
- Select participants in the list to show or hide their tracks. Use **Show all details** to view gear, start and finish times, and timing information for every participant.

## Track timing

Tracks with timestamps use their recorded times. For tracks without point timestamps, start time and duration are used to estimate positions between recorded points. This timing is approximate and cannot reproduce exact pauses or synchronization.

The event manifest is `tracks/tracks.json`; it contains participant details, gear, timing estimates, and the default sync line. **Timing for untimed tracks is estimated.**

## Map and data

The map uses [Leaflet 1.9.4](https://leafletjs.com/reference-1.9.4.html) and Esri World Imagery. Imagery attribution is shown on the map; review [Esri's World Imagery terms](https://goto.arcgisonline.com/maps/World_Imagery) and [data attribution guidance](https://www.esri.com/en-us/legal/terms/data-attributions).

This public site includes participant GPX tracks and precise route locations. The participants have approved their publication.
