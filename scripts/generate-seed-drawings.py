#!/usr/bin/env python3
"""Batch-generate the deterministic PLM drawing PNGs for the seed baseline.

Run ONCE (and re-run only if src/generators/generators/drawing.py changes) to
materialize the 5 part drawings under config/drawings/. Those PNGs are committed to
git so the demo is fully reproducible: `seed-baseline` uploads these exact bytes to
S3 and writes DRAWING# records pointing at them — reset → seed reproduces the same
images every time, no live generation needed.

    python3 scripts/generate-seed-drawings.py

The renderer is byte-deterministic (no wall-clock in the PNG), so re-running
produces identical files (idempotent commit).
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'src' / 'generators'))
from generators.drawing import render_drawing  # noqa: E402

OUT = REPO / 'config' / 'drawings'
OUT.mkdir(parents=True, exist_ok=True)

# Each entry is one rendered revision PNG. The defect part 44821-003 has THREE
# revisions that tell the demo's story: the bore tolerance is tightened over revs
# (A/B: +0.05 → C: +0.02 H7), which is exactly what turns a Ø25.04 measurement into a
# flight-critical BORE_DIAMETER_OOT. Other parts have a single released revision.
PARTS = [
    # (partNumber, drawingNumber, rev, title, boreNominal, tolUp, tolLo, fitClass, boltCircle, revDate)
    # --- 44821-003: three revisions of the same part (the demo's story) ---
    ('44821-003', 'DWG-44821-003-001', 'A', 'WING BOX BORE FITTING', 25.00, 0.05, 0.00, '',   30.0, '2025-11-02'),
    ('44821-003', 'DWG-44821-003-001', 'B', 'WING BOX BORE FITTING', 25.00, 0.05, 0.00, '',   32.0, '2026-02-10'),
    ('44821-003', 'DWG-44821-003-001', 'C', 'WING BOX BORE FITTING', 25.00, 0.02, 0.00, 'H7', 32.0, '2026-04-18'),
    # --- other released parts (single rev each) ---
    ('44821-007', 'DWG-44821-007-001', 'B', 'SPAR CAP BRACKET',      16.00, 0.03, 0.00, 'H8', 24.0, '2026-02-10'),
    ('44821-012', 'DWG-44821-012-001', 'C', 'RIB ATTACHMENT LUG',    12.00, 0.02, 0.00, 'H7', 20.0, '2026-04-18'),
    ('55192-001', 'DWG-55192-001-001', 'A', 'STRUCTURAL BRACKET ASSY', 20.00, 0.05, 0.00, '', 28.0, '2025-11-02'),
    ('55192-004', 'DWG-55192-004-001', 'B', 'SHEAR TIE CLIP',        10.00, 0.03, 0.00, 'H8', 18.0, '2026-02-10'),
]


def main():
    for pn, dwg, rev, title, nom, up, lo, fit, bc, date in PARTS:
        png = render_drawing(pn, dwg, rev, title=title, bore_nominal=nom, tol_up=up, tol_lo=lo,
                             fit_class=fit, bolt_circle=bc, rev_date=date)
        # Per-part subdir matches the S3 key scheme drawings/{partNumber}/{dwg}-{rev}.png
        part_dir = OUT / pn
        part_dir.mkdir(parents=True, exist_ok=True)
        path = part_dir / f'{dwg}-{rev}.png'
        path.write_bytes(png)
        print(f'  wrote {path.relative_to(REPO)} ({len(png)} bytes)')
    print(f'\n{len(PARTS)} drawings → {OUT.relative_to(REPO)} (commit these)')


if __name__ == '__main__':
    main()
