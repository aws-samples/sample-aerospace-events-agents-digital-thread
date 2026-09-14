"""Render a believable 2D mechanical engineering drawing (PLM-style) to PNG bytes.

Ported from spikes/plm-drawings/gen_drawing.py (matplotlib — chosen in the spike for
raster-first, vision-readable output with no system-library deps; clean amd64/arm64
wheels). Parameterized so the bore callout is data-driven: the defect part
(44821-003, Ø25.00 +0.02/-0.00 H7) is just one set of arguments.

Returns PNG bytes for direct S3 upload — no file written. No vendor/brand names.
"""

import io
import math

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Circle

# Sheet laid out in millimetres of paper (A3 landscape).
SHEET_W, SHEET_H = 420.0, 297.0

THIN = 0.6
MED = 1.0
THICK = 1.6
CENTER = dict(color='black', lw=0.5, dash_capstyle='round', linestyle=(0, (12, 3, 2, 3)))
MONO = 'DejaVu Sans Mono'


def _dim_line(ax, x1, y1, x2, y2, text, *, above=True, ext=4.0, txt_off=2.2):
    ax.plot([x1, x1], [y1, y1 + (ext if above else -ext)], color='black', lw=THIN)
    ax.plot([x2, x2], [y2, y2 + (ext if above else -ext)], color='black', lw=THIN)
    yd = y1 + (ext if above else -ext)
    ax.annotate('', xy=(x1, yd), xytext=(x2, yd),
                arrowprops=dict(arrowstyle='<|-|>', color='black', lw=THIN, mutation_scale=8))
    ax.text((x1 + x2) / 2, yd + (txt_off if above else -txt_off), text,
            ha='center', va='bottom' if above else 'top', fontsize=7.5, family=MONO)


def _vdim_line(ax, x1, y1, x2, y2, text, *, right=True, ext=4.0):
    ax.plot([x1 + (ext if right else -ext), x1], [y1, y1], color='black', lw=THIN)
    ax.plot([x2 + (ext if right else -ext), x2], [y2, y2], color='black', lw=THIN)
    xd = x1 + (ext if right else -ext)
    ax.annotate('', xy=(xd, y1), xytext=(xd, y2),
                arrowprops=dict(arrowstyle='<|-|>', color='black', lw=THIN, mutation_scale=8))
    ax.text(xd + (2.2 if right else -2.2), (y1 + y2) / 2, text, rotation=90,
            ha='left' if right else 'right', va='center', fontsize=7.5, family=MONO)


def _draw_border(ax):
    m = 8.0
    ax.add_patch(Rectangle((m, m), SHEET_W - 2 * m, SHEET_H - 2 * m, fill=False, lw=THICK, ec='black'))
    ax.add_patch(Rectangle((m + 3, m + 3), SHEET_W - 2 * m - 6, SHEET_H - 2 * m - 6, fill=False, lw=THIN, ec='black'))
    for i, c in enumerate('12345678'):
        x = m + 3 + (SHEET_W - 2 * m - 6) * (i + 0.5) / 8
        ax.text(x, m + 1.0, c, ha='center', va='bottom', fontsize=6, family=MONO)
        ax.text(x, SHEET_H - m - 1.0, c, ha='center', va='top', fontsize=6, family=MONO)
    for i, r in enumerate('DCBA'):
        y = m + 3 + (SHEET_H - 2 * m - 6) * (i + 0.5) / 4
        ax.text(m + 1.0, y, r, ha='left', va='center', fontsize=6, family=MONO)
        ax.text(SHEET_W - m - 1.0, y, r, ha='right', va='center', fontsize=6, family=MONO)


def _draw_front_view(ax, bore_nominal, tol_up, tol_lo, fit_class='H7', bolt_circle=32.0):
    cx, cy = 120.0, 185.0
    r_out, r_bore, r_bolt = 40.0, 25.0, bolt_circle
    ax.add_patch(Circle((cx, cy), r_out, fill=False, lw=THICK, ec='black'))
    ax.add_patch(Circle((cx, cy), r_bore, fill=False, lw=THICK, ec='black'))
    for a in (45, 135, 225, 315):
        hx = cx + r_bolt * math.cos(math.radians(a))
        hy = cy + r_bolt * math.sin(math.radians(a))
        ax.add_patch(Circle((hx, hy), 3.0, fill=False, lw=MED, ec='black'))
        ax.plot([hx - 5, hx + 5], [hy, hy], **CENTER)
        ax.plot([hx, hx], [hy - 5, hy + 5], **CENTER)
    ax.plot([cx - r_out - 8, cx + r_out + 8], [cy, cy], **CENTER)
    ax.plot([cx, cx], [cy - r_out - 8, cy + r_out + 8], **CENTER)
    ax.add_patch(Circle((cx, cy), r_bolt, fill=False, ec='black', lw=0.5, linestyle=(0, (8, 3))))
    ax.annotate('', xy=(cx + r_bore * 0.71, cy + r_bore * 0.71), xytext=(cx + r_out + 18, cy + 34),
                arrowprops=dict(arrowstyle='-|>', color='black', lw=THIN, mutation_scale=9))
    fit = f', {fit_class}' if fit_class else ''
    ax.text(cx + r_out + 20, cy + 36, f'Ø{bore_nominal:.2f}  +{tol_up:.2f} / -{tol_lo:.2f}',
            ha='left', va='bottom', fontsize=9, family=MONO, fontweight='bold')
    ax.text(cx + r_out + 20, cy + 31, f'BORE  —  FINISH REAM{fit}', ha='left', va='top', fontsize=6.5, family=MONO)
    _vdim_line(ax, cx + r_out, cy + r_out, cx + r_out, cy - r_out, 'Ø80.0', right=True, ext=14)
    ax.text(cx, cy - r_out - 16, 'FRONT VIEW', ha='center', va='top', fontsize=8, family=MONO, fontweight='bold')
    ax.plot([cx - r_out - 14, cx + r_out + 14], [cy, cy], color='black', lw=1.2, linestyle=(0, (14, 3, 3, 3)))
    ax.text(cx - r_out - 16, cy, 'A', ha='right', va='center', fontsize=9, family=MONO, fontweight='bold')
    ax.text(cx + r_out + 16, cy, 'A', ha='left', va='center', fontsize=9, family=MONO, fontweight='bold')


def _draw_section_view(ax, bore_nominal, tol_up, tol_lo):
    cx, cy = 290.0, 185.0
    half_h, half_b, depth = 40.0, 25.0, 34.0
    x0, x1 = cx - depth / 2, cx + depth / 2
    ax.add_patch(Rectangle((x0, cy - half_h), depth, 2 * half_h, fill=False, lw=THICK, ec='black'))
    ax.plot([x0, x1], [cy + half_b, cy + half_b], color='black', lw=THICK)
    ax.plot([x0, x1], [cy - half_b, cy - half_b], color='black', lw=THICK)
    for (yb, yt) in [(cy + half_b, cy + half_h), (cy - half_h, cy - half_b)]:
        ax.add_patch(Rectangle((x0, yb), depth, yt - yb, fill=True, facecolor='none', hatch='////', lw=0, edgecolor='black'))
        ax.add_patch(Rectangle((x0, yb), depth, yt - yb, fill=False, lw=THIN, edgecolor='black'))
    ax.plot([x0 - 8, x1 + 8], [cy, cy], **CENTER)
    _vdim_line(ax, x1, cy + half_b, x1, cy - half_b, f'Ø{bore_nominal:.2f}', right=True, ext=16)
    ax.text(x1 + 18, cy - 11, f'+{tol_up:.2f}\n-{tol_lo:.2f}', rotation=90, ha='left', va='center', fontsize=6.5, family=MONO)
    _dim_line(ax, x0, cy - half_h, x1, cy - half_h, '34.0', above=False, ext=14)
    _vdim_line(ax, x0, cy + half_h, x0, cy - half_h, '80.0', right=False, ext=14)
    ax.text(cx, cy - half_h - 22, 'SECTION A-A', ha='center', va='top', fontsize=8, family=MONO, fontweight='bold')


def _draw_title_block(ax, part):
    bw, bh = 180.0, 56.0
    bx, by = SHEET_W - 11 - bw, 11.0
    ax.add_patch(Rectangle((bx, by), bw, bh, fill=False, lw=MED, ec='black'))
    for fx in (0.34, 0.55, 0.78):
        ax.plot([bx + bw * fx, bx + bw * fx], [by, by + bh * 0.72], color='black', lw=THIN)
    ax.plot([bx + bw * 0.78, bx + bw * 0.78], [by, by + bh], color='black', lw=THIN)
    for fy in (0.28, 0.5, 0.72):
        ax.plot([bx, bx + bw], [by + bh * fy] * 2, color='black', lw=THIN)

    def cell(fx, fy, label, value, vsize=8.0, lsize=5.0):
        ax.text(bx + bw * fx + 2, by + bh * fy + bh * 0.205, label, ha='left', va='top', fontsize=lsize, family=MONO)
        ax.text(bx + bw * fx + 2, by + bh * fy + bh * 0.105, value, ha='left', va='top', fontsize=vsize, family=MONO, fontweight='bold')

    ax.text(bx + 3, by + bh - 3, 'TITLE', ha='left', va='top', fontsize=5, family=MONO)
    ax.text(bx + bw * 0.39, by + bh * 0.88, part['title'], ha='center', va='top', fontsize=10, family=MONO, fontweight='bold')
    cell(0.0, 0.5, 'DRAWN', f'{part["drawn_by"]}  {part["date"]}', vsize=6)
    cell(0.34, 0.5, 'CHECKED', part['checked_by'], vsize=6)
    cell(0.55, 0.5, 'MATERIAL', part['material'], vsize=5.5)
    cell(0.0, 0.28, 'APPROVED', part['approved_by'], vsize=6)
    cell(0.34, 0.28, 'PROGRAM', part['program'], vsize=6)
    cell(0.55, 0.28, 'FINISH', part['finish'], vsize=6)
    cell(0.78, 0.5, 'PART NO.', part['number'], vsize=9)
    cell(0.78, 0.28, 'SCALE', part['scale'], vsize=7)
    cell(0.78, 0.06, 'SHEET', part['sheet'], vsize=6)
    cell(0.0, 0.06, 'SIZE', part['size'], vsize=6)
    cell(0.13, 0.06, 'UNITS', part['units'], vsize=6)
    ax.add_patch(Rectangle((bx + bw - 22, by + bh - 14), 22, 14, fill=False, lw=MED, ec='black'))
    ax.text(bx + bw - 11, by + bh - 11.5, 'REV', ha='center', va='top', fontsize=5, family=MONO)
    ax.text(bx + bw - 11, by + bh - 5.5, part['rev'], ha='center', va='center', fontsize=12, family=MONO, fontweight='bold')


def _draw_revision_block(ax, rev_rows):
    bw, bh = 150.0, 30.0
    bx, by = SHEET_W - 11 - bw, SHEET_H - 11 - bh
    ax.add_patch(Rectangle((bx, by), bw, bh, fill=False, lw=THIN, ec='black'))
    ax.plot([bx, bx + bw], [by + bh * 0.66] * 2, color='black', lw=THIN)
    cols = [0.0, 0.12, 0.62, 0.84]
    for fx in cols[1:]:
        ax.plot([bx + bw * fx] * 2, [by, by + bh], color='black', lw=THIN)
    for fx, h in zip(cols, ['REV', 'DESCRIPTION', 'DATE', 'BY']):
        ax.text(bx + bw * fx + 2, by + bh - 2, h, ha='left', va='top', fontsize=5, family=MONO)
    for i, row in enumerate(rev_rows):
        y = by + bh * 0.66 - (i + 1) * (bh * 0.66 / len(rev_rows)) + 1
        for fx, val in zip(cols, row):
            ax.text(bx + bw * fx + 2, y + (bh * 0.66 / len(rev_rows)) - 1.2, val, ha='left', va='top', fontsize=5.5, family=MONO)


def _draw_notes(ax, bore_nominal, tol_up, tol_lo, material, fit_class='H7'):
    fit = f' {fit_class}' if fit_class else ''
    notes = [
        'NOTES:',
        '1. INTERPRET DRAWING PER GENERAL DIMENSIONING & TOLERANCING STD.',
        '2. ALL DIMENSIONS IN MILLIMETRES.  UNTOLERANCED ± 0.1.',
        f'3. BORE Ø{bore_nominal:.2f} +{tol_up:.2f}/-{tol_lo:.2f}{fit} — FINISH REAM. INSPECT 100%.',
        '4. BREAK ALL SHARP EDGES 0.3 MAX.  SURFACE FINISH Ra 0.8.',
        f'5. MATERIAL: {material}.',
    ]
    x, y = 18.0, 92.0
    for i, n in enumerate(notes):
        ax.text(x, y - i * 5.2, n, ha='left', va='top', fontsize=6, family=MONO, fontweight='bold' if i == 0 else 'normal')


# Full revision history of the wing-box bore fitting. A drawing at rev X shows only
# the rows up to X (you can't see future revisions on a released sheet). The rev-C
# tolerance tightening (+0.05 → +0.02 H7) is what makes a Ø25.04 bore out-of-tolerance.
_REV_HISTORY = [
    ('A', 'INITIAL RELEASE', '2025-11-02', 'MA'),
    ('B', 'REVISED BOLT CIRCLE', '2026-02-10', 'MA'),
    ('C', 'BORE TOL TIGHTENED H7', '2026-04-18', 'MA'),
]


def render_drawing(part_number: str, drawing_number: str, rev: str,
                   title: str = 'WING BOX BORE FITTING',
                   bore_nominal: float = 25.00, tol_up: float = 0.02, tol_lo: float = 0.00,
                   material: str = 'Ti-6Al-4V ANNEALED',
                   fit_class: str = 'H7', bolt_circle: float = 32.0,
                   rev_date: str | None = None) -> bytes:
    """Render a 2D engineering drawing for a part and return PNG bytes.

    fit_class/bolt_circle/rev_date let callers render distinct revisions of the same
    part; the revision block is truncated to the rows up to `rev`.
    """
    # Revision rows visible on this sheet = history up to (and including) this rev.
    rev_rows = [r for r in _REV_HISTORY if r[0] <= rev] or [_REV_HISTORY[0]]
    date = rev_date or rev_rows[-1][2]
    part = {
        'number': part_number, 'title': title, 'rev': rev, 'scale': '2:1',
        'material': material, 'drawn_by': 'M. ANDERSEN', 'checked_by': 'R. KOVAC',
        'approved_by': 'L. FONTAINE', 'date': date, 'sheet': '1 OF 1',
        'size': 'A3', 'units': 'mm', 'program': 'ARES-1', 'finish': 'Ra 0.8',
    }

    fig = plt.figure(figsize=(SHEET_W / 25.4, SHEET_H / 25.4))
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_xlim(0, SHEET_W)
    ax.set_ylim(0, SHEET_H)
    ax.set_aspect('equal')
    ax.axis('off')
    fig.patch.set_facecolor('white')

    _draw_border(ax)
    _draw_front_view(ax, bore_nominal, tol_up, tol_lo, fit_class, bolt_circle)
    _draw_section_view(ax, bore_nominal, tol_up, tol_lo)
    _draw_notes(ax, bore_nominal, tol_up, tol_lo, material, fit_class)
    _draw_revision_block(ax, rev_rows)
    _draw_title_block(ax, part)

    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=200, facecolor='white')
    plt.close(fig)
    return buf.getvalue()
