#!/usr/bin/env python3
"""
Generates MacroTrack's app icon set.

The mark is the app's own hero element: the goal ring. `theme.ts` picks iris
(#5B5BD6) deliberately as the unclaimed lane next to MyFitnessPal blue,
MacroFactor coral and Cronometer gold, so the icon leans on it hard — an icon
that is instantly "the iris ring" is worth more than one that illustrates food.

Drawn with PIL because the box has no SVG rasterizer. Everything renders at 4x
and downsamples with LANCZOS, which is what keeps the arc edges clean; PIL's
arc() has butt caps, so round caps are drawn as explicit circles at each end.

  python3 tools/design/make-icon.py --variants   # candidate previews
  python3 tools/design/make-icon.py --emit A     # write the real asset set

Asset rules (Expo SDK 57 docs):
  icon.png                  1024x1024, fills the square, NO transparency
  android-icon-foreground   1024x1024, art inside the center safe zone — the
                            launcher masks to a circle and can shift the layer,
                            so anything outside ~66% can be clipped
  android-icon-background   1024x1024 solid
  android-icon-monochrome   1024x1024 silhouette in the alpha channel, for
                            Android 13+ themed icons
  favicon.png               48x48
"""

import argparse
import math
import os
from PIL import Image, ImageDraw

# ---- brand (mirrors mobile/src/constants/theme.ts) ----
IRIS = (0x5B, 0x5B, 0xD6)
IRIS_SURFACE = (0xEE, 0xEE, 0xFB)
WHITE = (0xFF, 0xFF, 0xFF)
PROTEIN = (0xE4, 0x64, 0x5C)
CARBS = (0xE8, 0xA3, 0x3D)
FAT = (0x3F, 0xA9, 0x8E)

SS = 4  # supersample factor


def _ring(draw, cx, cy, r_out, width, color, start_deg, sweep_deg, round_caps=True):
    """
    One arc with round caps, band spanning [r_out - width, r_out].

    PIL's arc() grows its width INWARD from the bounding box, so the band's
    centreline sits at r_out - width/2 — putting the caps at r_out instead makes
    them bulge past the ring as knobs.
    """
    box = (round(cx - r_out), round(cy - r_out), round(cx + r_out), round(cy + r_out))
    draw.arc(box, start_deg, start_deg + sweep_deg, fill=color, width=round(width))
    if not round_caps:
        return
    r_mid = r_out - width / 2
    for a in (start_deg, start_deg + sweep_deg):
        rad = math.radians(a)
        px, py = cx + r_mid * math.cos(rad), cy + r_mid * math.sin(rad)
        draw.ellipse((px - width / 2, py - width / 2, px + width / 2, py + width / 2), fill=color)


def render(variant: str, size: int, *, transparent=False, safe=False, mono=False) -> Image.Image:
    """
    safe=True shrinks the mark into Android's adaptive-icon safe zone.
    mono=True renders a white-on-transparent silhouette for themed icons.
    """
    s = size * SS
    bg_map = {
        'A': WHITE, 'B': IRIS, 'C': WHITE, 'D': WHITE,
    }
    bg = bg_map[variant]
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0) if (transparent or mono) else bg + (255,))
    d = ImageDraw.Draw(img)
    c = s / 2

    # The mark occupies 68% of the canvas normally; inside the adaptive-icon
    # safe zone it drops to 46% so the launcher's circular mask cannot clip it.
    span = 0.62 if safe else 0.80
    r = s * span / 2          # OUTER radius of the ring band
    stroke = r * 0.30         # heavy enough to hold up at 48px, still a ring

    # A gap at the top right reads as a ring in progress rather than a closed
    # circle, and the asymmetry is what survives at launcher size.
    gap = 68
    start = -45 + gap / 2
    sweep = 360 - gap

    if mono:
        _ring(d, c, c, r, stroke, WHITE + (255,), start, sweep)
    elif variant == 'A':
        _ring(d, c, c, r, stroke, IRIS + (255,), start, sweep)
    elif variant == 'B':
        _ring(d, c, c, r, stroke, WHITE + (255,), start, sweep)
    elif variant == 'C':
        # Three macro arcs, in the order the app lists them (P/C/F), separated by
        # small gaps. Colourful enough to read as "nutrition" at a glance.
        seg_gap = 16
        seg = (sweep - seg_gap * 2) / 3
        for i, col in enumerate((PROTEIN, CARBS, FAT)):
            _ring(d, c, c, r, stroke, col + (255,), start + i * (seg + seg_gap), seg)
    elif variant == 'D':
        # The literal goal-rings mark: iris kcal ring outside, macro ring inside.
        _ring(d, c, c, r, stroke * 0.62, IRIS + (255,), start, sweep)
        r_in = r - stroke * 1.15
        st_in = stroke * 0.52
        seg_gap = 18
        seg = (sweep - seg_gap * 2) / 3
        for i, col in enumerate((PROTEIN, CARBS, FAT)):
            _ring(d, c, c, r_in, st_in, col + (255,), start + i * (seg + seg_gap), seg)

    out = img.resize((size, size), Image.LANCZOS)
    if transparent or mono:
        return out
    flat = Image.new('RGB', (size, size), bg)
    flat.paste(out, (0, 0), out)
    return flat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variants', action='store_true', help='write candidate previews')
    ap.add_argument('--emit', metavar='VARIANT', help='write the real asset set for a variant')
    ap.add_argument('--outdir', default='tools/design/out')
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    if args.variants:
        for v in 'ABCD':
            for px in (512, 180, 48):
                render(v, px).save(f'{args.outdir}/variant-{v}-{px}.png')
        print(f'wrote candidate previews to {args.outdir}/')

    if args.emit:
        v = args.emit.upper()
        assets = 'mobile/assets/images'
        # Main icon: fills the square, no transparency (iOS masks it itself).
        render(v, 1024).save(f'{assets}/icon.png')
        # Android adaptive: foreground art inside the safe zone, flat background.
        render(v, 1024, transparent=True, safe=True).save(f'{assets}/android-icon-foreground.png')
        bg = IRIS if v == 'B' else WHITE
        Image.new('RGB', (1024, 1024), bg).save(f'{assets}/android-icon-background.png')
        render(v, 1024, mono=True, safe=True).save(f'{assets}/android-icon-monochrome.png')
        render(v, 48).save(f'{assets}/favicon.png')
        print(f'wrote variant {v} to {assets}/: icon, adaptive fg/bg/mono, favicon')


if __name__ == '__main__':
    main()
