# Demo video

Headline-scenario walkthrough: viewport screenshots of the running frontend, stitched into MP4
with ffmpeg (see Reproducing).

## Files

| File | Length | Size | Source rate | Notes |
|---|---|---|---|---|
| `demo.mp4` | 30 s | 676 KB | 0.5 fps (1 frame/2 s) | Default playback rate. Each frame on screen for 2 seconds — good for reading dashboard text. |
| `demo-smooth.mp4` | 34 s | 3.3 MB | 30 fps (interpolated) | Same content, frame-blended for smoother transitions. Larger file. |
| `demo-quick.mp4` | 15 s | 676 KB | 1 fps (1 frame/s) | Faster pace; harder to read but fits attention spans. |

## Storyboard (frame → screen)

| # | Frame | Screen / action |
|---|---|---|
| 1 | `frames/001.png` | Quality dashboard: live NCR feed + 17 agent activity items + 12 pending HITL escalations |
| 2–4 | `frames/002.png`–`004.png` | Quality dashboard with new MINOR NCR landing in feed |
| 5 | `frames/005.png` | Supply Chain dashboard: 20 events, 9 agent items, 8 pending |
| 6 | `frames/006.png` | Digital Thread page (load button) |
| 7–8 | `frames/007.png`–`008.png` | Digital Thread loaded — 752 nodes, 64 gaps; legend shows all 25 ISA-95 node types |
| 9 | `frames/009.png` | Hierarchy domain filter — Enterprise/Site/Area/WorkCenter/WorkUnit highlighted |
| 10 | `frames/010.png` | Personnel domain filter — Person + PersonnelClass nodes |
| 11 | `frames/011.png` | Quality domain filter — OperationsPerformance + ThreadGap + CoherenceVerdict |
| 12 | `frames/012.png` | Demo Control Panel — drama scenario buttons |
| 13–15 | `frames/013.png`–`015.png` | Quality dashboard after clicking "NCR Cluster — Titan Forge": 3 fresh `NCR-DRAMA-1780061965*` CRITICAL NCRs + 19 agent activity (4 new ESCALATED entries) + 14 pending HITL escalations |

## Reproducing

```bash
# 1. Frontend at http://localhost:5173, generators running
./scripts/start-generators.sh && sleep 60

# 2. Drive the browser through the walkthrough URL set:
#    /#/dashboard/quality (8s)
#    /#/dashboard/supply-chain (6s)
#    /#/digital-thread + LOAD THREAD (8s)
#    Hierarchy / Personnel / Quality domain tabs (3s each)
#    /#/demo-control + click NCR Cluster (4s)
#    /#/dashboard/quality (15s — watch cascade)
# Capturing one screenshot at each pause.

# 3. Stitch:
ffmpeg -framerate 0.5 -pattern_type glob -i 'frames/*.png' \
  -vf 'scale=1440:-2,format=yuv420p' \
  -c:v libx264 -preset slow -crf 22 -movflags +faststart demo.mp4
```

