#!/usr/bin/env python3
"""Generate a believable 2D mechanical engineering drawing (PLM-style).

Recommended approach from the spike: matplotlib. Full control over geometry,
dimension lines with arrowheads, section hatching, and an ISO-style title block;
direct high-DPI PNG output that a vision model can read.

Sample part: P/N 44821-003 "WING BOX BORE FITTING" rev C. The bore feature
carries the defect-relevant dimension: Ø 25.00 +0.02 / -0.00 (H7-style fit).
No vendor/brand names appear anywhere on the sheet.
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Circle, FancyArrowPatch

# ---------------------------------------------------------------- part data ---
PART = {
    "number": "44821-003",
    "title": "WING BOX BORE FITTING",
    "rev": "C",
    "scale": "2:1",
    "material": "Ti-6Al-4V ANNEALED",
    "drawn_by": "M. ANDERSEN",
    "checked_by": "R. KOVAC",
    "approved_by": "L. FONTAINE",
    "date": "2026-04-18",
    "sheet": "1 OF 1",
    "size": "A3",
    "units": "mm",
    "program": "ARES-1",
    "finish": "Ra 0.8",
}
BORE_NOMINAL = 25.00
BORE_TOL_UP = 0.02
BORE_TOL_LO = 0.00

# Sheet is laid out in millimetres of paper (A3 landscape: 420 x 297).
SHEET_W, SHEET_H = 420.0, 297.0

# Drawing-line styling tuned to look like CAD pen weights.
THIN = 0.6
MED = 1.0
THICK = 1.6
CENTER = dict(color="black", lw=0.5, dash_capstyle="round",
              linestyle=(0, (12, 3, 2, 3)))
MONO = "DejaVu Sans Mono"


def dim_line(ax, x1, y1, x2, y2, text, *, above=True, ext=4.0, txt_off=2.2):
    """Horizontal dimension line with double arrowheads + extension lines."""
    ax.plot([x1, x1], [y1, y1 + (ext if above else -ext)], color="black", lw=THIN)
    ax.plot([x2, x2], [y2, y2 + (ext if above else -ext)], color="black", lw=THIN)
    yd = y1 + (ext if above else -ext)
    ax.annotate("", xy=(x1, yd), xytext=(x2, yd),
                arrowprops=dict(arrowstyle="<|-|>", color="black", lw=THIN,
                                mutation_scale=8))
    ax.text((x1 + x2) / 2, yd + (txt_off if above else -txt_off), text,
            ha="center", va="bottom" if above else "top",
            fontsize=7.5, family=MONO)


def vdim_line(ax, x1, y1, x2, y2, text, *, right=True, ext=4.0):
    """Vertical dimension line with double arrowheads + extension lines."""
    ax.plot([x1 + (ext if right else -ext), x1], [y1, y1], color="black", lw=THIN)
    ax.plot([x2 + (ext if right else -ext), x2], [y2, y2], color="black", lw=THIN)
    xd = x1 + (ext if right else -ext)
    ax.annotate("", xy=(xd, y1), xytext=(xd, y2),
                arrowprops=dict(arrowstyle="<|-|>", color="black", lw=THIN,
                                mutation_scale=8))
    ax.text(xd + (2.2 if right else -2.2), (y1 + y2) / 2, text, rotation=90,
            ha="left" if right else "right", va="center",
            fontsize=7.5, family=MONO)


def draw_border(ax):
    """Outer frame + zone tick marks, like a real sheet border."""
    m = 8.0
    ax.add_patch(Rectangle((m, m), SHEET_W - 2 * m, SHEET_H - 2 * m,
                           fill=False, lw=THICK, ec="black"))
    ax.add_patch(Rectangle((m + 3, m + 3), SHEET_W - 2 * m - 6,
                           SHEET_H - 2 * m - 6, fill=False, lw=THIN, ec="black"))
    cols = "12345678"
    for i, c in enumerate(cols):
        x = m + 3 + (SHEET_W - 2 * m - 6) * (i + 0.5) / len(cols)
        ax.text(x, m + 1.0, c, ha="center", va="bottom", fontsize=6, family=MONO)
        ax.text(x, SHEET_H - m - 1.0, c, ha="center", va="top", fontsize=6, family=MONO)
    rows = "DCBA"
    for i, r in enumerate(rows):
        y = m + 3 + (SHEET_H - 2 * m - 6) * (i + 0.5) / len(rows)
        ax.text(m + 1.0, y, r, ha="left", va="center", fontsize=6, family=MONO)
        ax.text(SHEET_W - m - 1.0, y, r, ha="right", va="center", fontsize=6, family=MONO)


def draw_front_view(ax):
    """FRONT VIEW: round flange face showing the bore (concentric circles)."""
    cx, cy = 120.0, 185.0
    r_out = 40.0           # flange outer radius (paper mm, ~scaled)
    r_bore = 25.0          # bore radius on paper (Ø25 part @ 2:1 -> 25mm radius)
    r_bolt = 32.0          # bolt-circle radius
    # outline + bore
    ax.add_patch(Circle((cx, cy), r_out, fill=False, lw=THICK, ec="black"))
    ax.add_patch(Circle((cx, cy), r_bore, fill=False, lw=THICK, ec="black"))
    # four mounting holes on bolt circle
    import math
    for a in (45, 135, 225, 315):
        hx = cx + r_bolt * math.cos(math.radians(a))
        hy = cy + r_bolt * math.sin(math.radians(a))
        ax.add_patch(Circle((hx, hy), 3.0, fill=False, lw=MED, ec="black"))
        ax.plot([hx - 5, hx + 5], [hy, hy], **CENTER)
        ax.plot([hx, hx], [hy - 5, hy + 5], **CENTER)
    # centrelines
    ax.plot([cx - r_out - 8, cx + r_out + 8], [cy, cy], **CENTER)
    ax.plot([cx, cx], [cy - r_out - 8, cy + r_out + 8], **CENTER)
    # bolt-circle centreline (dashed circle)
    ax.add_patch(Circle((cx, cy), r_bolt, fill=False, ec="black", lw=0.5,
                        linestyle=(0, (8, 3))))
    # bore diameter callout (the defect-relevant dimension), leader to bore edge
    ax.annotate("", xy=(cx + r_bore * 0.71, cy + r_bore * 0.71),
                xytext=(cx + r_out + 18, cy + 34),
                arrowprops=dict(arrowstyle="-|>", color="black", lw=THIN,
                                mutation_scale=9))
    ax.text(cx + r_out + 20, cy + 36,
            f"Ø{BORE_NOMINAL:.2f}  +{BORE_TOL_UP:.2f} / -{BORE_TOL_LO:.2f}",
            ha="left", va="bottom", fontsize=9, family=MONO, fontweight="bold")
    ax.text(cx + r_out + 20, cy + 31, "BORE  —  FINISH REAM, H7",
            ha="left", va="top", fontsize=6.5, family=MONO)
    # outer-diameter dimension
    vdim_line(ax, cx + r_out, cy + r_out, cx + r_out, cy - r_out,
              f"Ø{2 * r_out / 2:.1f}".replace(f"{r_out:.1f}", "80.0"),
              right=True, ext=14)
    ax.text(cx, cy - r_out - 16, "FRONT VIEW", ha="center", va="top",
            fontsize=8, family=MONO, fontweight="bold")
    # section cut line A-A through the centre
    ax.plot([cx - r_out - 14, cx + r_out + 14], [cy, cy], color="black",
            lw=1.2, linestyle=(0, (14, 3, 3, 3)))
    ax.text(cx - r_out - 16, cy, "A", ha="right", va="center", fontsize=9,
            family=MONO, fontweight="bold")
    ax.text(cx + r_out + 16, cy, "A", ha="left", va="center", fontsize=9,
            family=MONO, fontweight="bold")
    return cx, cy, r_out, r_bore


def draw_section_view(ax):
    """SECTION A-A: cut through the fitting showing the through-bore + hatch."""
    cx, cy = 290.0, 185.0
    half_h = 40.0          # half outer height (matches front r_out)
    half_b = 25.0          # half bore height (matches front r_bore)
    depth = 34.0           # axial length of the fitting
    x0 = cx - depth / 2
    x1 = cx + depth / 2
    # body outline (rectangle profile)
    ax.add_patch(Rectangle((x0, cy - half_h), depth, 2 * half_h,
                           fill=False, lw=THICK, ec="black"))
    # bore through the middle (two horizontal lines = bore walls)
    ax.plot([x0, x1], [cy + half_b, cy + half_b], color="black", lw=THICK)
    ax.plot([x0, x1], [cy - half_b, cy - half_b], color="black", lw=THICK)
    # section hatching on the two solid material bands (top + bottom)
    for (yb, yt) in [(cy + half_b, cy + half_h), (cy - half_h, cy - half_b)]:
        ax.add_patch(Rectangle((x0, yb), depth, yt - yb, fill=True,
                               facecolor="none", hatch="////", lw=0,
                               edgecolor="black"))
        ax.add_patch(Rectangle((x0, yb), depth, yt - yb, fill=False, lw=THIN,
                               edgecolor="black"))
    # centreline of the bore
    ax.plot([x0 - 8, x1 + 8], [cy, cy], **CENTER)
    # bore Ø dimension (vertical, between bore walls) — defect-relevant
    vdim_line(ax, x1, cy + half_b, x1, cy - half_b,
              f"Ø{BORE_NOMINAL:.2f}", right=True, ext=16)
    ax.text(x1 + 18, cy - 11,
            f"+{BORE_TOL_UP:.2f}\n-{BORE_TOL_LO:.2f}", rotation=90,
            ha="left", va="center", fontsize=6.5, family=MONO)
    # axial length dimension
    dim_line(ax, x0, cy - half_h, x1, cy - half_h, "34.0", above=False, ext=14)
    # outer height dimension (left)
    vdim_line(ax, x0, cy + half_h, x0, cy - half_h, "80.0", right=False, ext=14)
    ax.text(cx, cy - half_h - 22, "SECTION A-A", ha="center", va="top",
            fontsize=8, family=MONO, fontweight="bold")


def draw_title_block(ax):
    """ISO-style title block anchored bottom-right."""
    bw, bh = 180.0, 56.0
    bx, by = SHEET_W - 11 - bw, 11.0
    ax.add_patch(Rectangle((bx, by), bw, bh, fill=False, lw=MED, ec="black"))
    # column guides: full-height only in the lower data rows, so the title
    # band (top 28%) stays clear for the centred part title.
    for fx in (0.34, 0.55, 0.78):
        ax.plot([bx + bw * fx, bx + bw * fx], [by, by + bh * 0.72],
                color="black", lw=THIN)
    ax.plot([bx + bw * 0.78, bx + bw * 0.78], [by, by + bh], color="black", lw=THIN)
    # row guides
    for fy in (0.28, 0.5, 0.72):
        ax.plot([bx, bx + bw], [by + bh * fy] * 2, color="black", lw=THIN)

    def cell(fx, fy, label, value, vsize=8, lsize=5):
        ax.text(bx + bw * fx + 2, by + bh * fy + bh * 0.205, label,
                ha="left", va="top", fontsize=lsize, family=MONO, color="black")
        ax.text(bx + bw * fx + 2, by + bh * fy + bh * 0.105, value,
                ha="left", va="top", fontsize=vsize, family=MONO,
                fontweight="bold")

    # big title cell (top span)
    ax.text(bx + 3, by + bh - 3, "TITLE", ha="left", va="top", fontsize=5,
            family=MONO)
    ax.text(bx + bw * 0.39, by + bh * 0.88, PART["title"], ha="center", va="top",
            fontsize=10, family=MONO, fontweight="bold")
    # second row
    cell(0.0, 0.5, "DRAWN", f'{PART["drawn_by"]}  {PART["date"]}', vsize=6)
    cell(0.34, 0.5, "CHECKED", PART["checked_by"], vsize=6)
    cell(0.55, 0.5, "MATERIAL", PART["material"], vsize=5.5)
    # bottom row
    cell(0.0, 0.28, "APPROVED", PART["approved_by"], vsize=6)
    cell(0.34, 0.28, "PROGRAM", PART["program"], vsize=6)
    cell(0.55, 0.28, "FINISH", PART["finish"], vsize=6)
    # part-number / rev / scale block (right column)
    cell(0.78, 0.5, "PART NO.", PART["number"], vsize=9)
    cell(0.78, 0.28, "SCALE", PART["scale"], vsize=7)
    cell(0.78, 0.06, "SHEET", PART["sheet"], vsize=6)
    cell(0.0, 0.06, "SIZE", PART["size"], vsize=6)
    cell(0.13, 0.06, "UNITS", PART["units"], vsize=6)
    # REV in its own emphasised corner
    ax.add_patch(Rectangle((bx + bw - 22, by + bh - 14), 22, 14, fill=False,
                           lw=MED, ec="black"))
    ax.text(bx + bw - 11, by + bh - 11.5, "REV", ha="center", va="top",
            fontsize=5, family=MONO)
    ax.text(bx + bw - 11, by + bh - 5.5, PART["rev"], ha="center", va="center",
            fontsize=12, family=MONO, fontweight="bold")


def draw_revision_block(ax):
    """Small revision history table, top-right inside the border."""
    bw, bh = 150.0, 30.0
    bx, by = SHEET_W - 11 - bw, SHEET_H - 11 - bh
    ax.add_patch(Rectangle((bx, by), bw, bh, fill=False, lw=THIN, ec="black"))
    ax.plot([bx, bx + bw], [by + bh * 0.66] * 2, color="black", lw=THIN)
    cols = [0.0, 0.12, 0.62, 0.84]
    for fx in cols[1:]:
        ax.plot([bx + bw * fx] * 2, [by, by + bh], color="black", lw=THIN)
    heads = ["REV", "DESCRIPTION", "DATE", "BY"]
    for fx, h in zip(cols, heads):
        ax.text(bx + bw * fx + 2, by + bh - 2, h, ha="left", va="top",
                fontsize=5, family=MONO)
    rows = [
        ("A", "INITIAL RELEASE", "2025-11-02", "MA"),
        ("B", "REVISED BOLT CIRCLE", "2026-02-10", "MA"),
        ("C", "BORE TOL TIGHTENED H7", "2026-04-18", "MA"),
    ]
    for i, row in enumerate(rows):
        y = by + bh * 0.66 - (i + 1) * (bh * 0.66 / len(rows)) + 1
        for fx, val in zip(cols, row):
            ax.text(bx + bw * fx + 2, y + (bh * 0.66 / len(rows)) - 1.2, val,
                    ha="left", va="top", fontsize=5.5, family=MONO)


def draw_notes(ax):
    notes = [
        "NOTES:",
        "1. INTERPRET DRAWING PER GENERAL DIMENSIONING & TOLERANCING STD.",
        "2. ALL DIMENSIONS IN MILLIMETRES.  UNTOLERANCED ± 0.1.",
        "3. BORE Ø25.00 +0.02/-0.00 — FINISH REAM. INSPECT 100%.",
        "4. BREAK ALL SHARP EDGES 0.3 MAX.  SURFACE FINISH Ra 0.8.",
        "5. MATERIAL: Ti-6Al-4V, ANNEALED PER APPLICABLE SPEC.",
    ]
    x, y = 18.0, 92.0
    for i, n in enumerate(notes):
        ax.text(x, y - i * 5.2, n, ha="left", va="top", fontsize=6,
                family=MONO, fontweight="bold" if i == 0 else "normal")


def main(out_png="sample-44821-003-revC.png", out_pdf="sample-44821-003-revC.pdf"):
    fig = plt.figure(figsize=(SHEET_W / 25.4, SHEET_H / 25.4))  # mm -> inches
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, SHEET_W)
    ax.set_ylim(0, SHEET_H)
    ax.set_aspect("equal")
    ax.axis("off")
    fig.patch.set_facecolor("white")

    draw_border(ax)
    draw_front_view(ax)
    draw_section_view(ax)
    draw_notes(ax)
    draw_revision_block(ax)
    draw_title_block(ax)

    fig.savefig(out_png, dpi=200, facecolor="white")
    fig.savefig(out_pdf, facecolor="white")
    plt.close(fig)
    print(f"wrote {out_png} and {out_pdf}")


if __name__ == "__main__":
    main()
