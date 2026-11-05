"""Cut the gold Legends bar out of scans of Legends cards, as overlays the site lays over a frame.

The bar is the same on every Legends card of a type while the frame and art around it change with
the card's colours, so where the unit scans agree is the bar. Events and a leader's unit side carry
it where a unit does, an upgrade 115 px higher, and a leader's front a longer one along its bottom.
No Legends base has been printed: it takes the long bar on the strip above its trait, a best guess.

Usage: python tools/extract_legends.py source-cards/reference/legends   (see its README)
Writes public/templates/legends/{unit,upgrade,leader,base}.png, and token-unit.png and token-upgrade.png
as cut, for token frames, which are 716 px scans too
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "templates" / "legends"
UNITS = ["Jedi Knight", "Terentatek", "HK-47", "Sith Legionnaire", "Darth Malak", "Jedi Consular",
         "Jedi Guardian", "Darth Revan Back"]
BAR = (36, 919, 682, 940)  # x0, y0, x1, y1 around the bar on a 716 px unit scan
EMBLEM = (306, 906, 412, 946)  # around the emblem in its middle
UPGRADE_RISE = 115
# Long bars on landscape cards: the canvas, the bar's ends and top, the emblem's middle, and
# where the canvas goes on our 1000 x 718 frame. The leader's front is a 716 px high scan;
# the base is measured on our own frame, the strip above its trait
LEADER_BAR = dict(size=(1000, 716), start=33, end=963, top=637, emblem_x=687, paste=(0, 1))
BASE_BAR = dict(size=(1000, 718), start=31, end=967, top=595, emblem_x=500, paste=(0, 0))


def load(folder, name):
    return np.array(Image.open(folder / (name + ".png")).convert("RGBA")).astype(np.float32)


def component(mask, seed):
    """The part of the mask connected to the seed (4-neighbours)."""
    keep = np.zeros_like(mask)
    stack = [seed]
    while stack:
        y, x = stack.pop()
        if not (0 <= y < mask.shape[0] and 0 <= x < mask.shape[1]) or keep[y, x] or not mask[y, x]:
            continue
        keep[y, x] = True
        stack += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
    return keep


def fill_rows(mask):
    """The emblem is convex along each row: fill between a row's first and last pixel."""
    out = mask.copy()
    for y in range(mask.shape[0]):
        xs = np.where(mask[y])[0]
        if len(xs):
            out[y, xs[0]:xs[-1] + 1] = True
    return out


def unit_overlay(folder):
    """The bar and emblem on a 716 x 1000 unit scan: RGBA, transparent elsewhere."""
    stack = np.stack([load(folder, n) for n in UNITS])
    median = np.median(stack, 0)
    spread = np.abs(stack[..., :3] - median[..., :3]).max(0).max(-1)
    agree = spread < 30
    mask = np.zeros(agree.shape, bool)
    # The bar: the rows where nearly all of it agrees, whole from its first pixel to its last
    # (a little looser: its thin lines are antialiased a bit differently from scan to scan)
    x0, y0, x1, y1 = BAR
    bar = component(spread[y0:y1, x0:x1] < 50, ((y1 - y0) // 2, (x1 - x0) // 2))
    band = bar.mean(1) > 0.8
    mask[y0:y1, x0:x1] = fill_rows(bar) & band[:, None]
    # The emblem: what agrees connected to its middle
    x0, y0, x1, y1 = EMBLEM
    mask[y0:y1, x0:x1] |= fill_rows(component(agree[y0:y1, x0:x1], ((y1 - y0) // 2 + 4, (x1 - x0) // 2)))
    out = median.copy()
    out[..., 3] = mask * 255
    return out, mask


def to_frame(overlay):
    """A 716 px scan's frame is 0.4% smaller and sits 2 px lower and to the right of ours."""
    im = Image.fromarray(overlay.round().clip(0, 255).astype(np.uint8), "RGBA")
    scaled = im.resize((round(im.width * 1.004), round(im.height * 1.004)), Image.LANCZOS)
    frame = Image.new("RGBA", (718, 1000), (0, 0, 0, 0))
    frame.paste(scaled, (-2, -2))
    return frame


def long_overlay(unit, mask, size, start, end, top, emblem_x, paste):
    """A longer bar on a landscape card: the unit's ends and emblem, its middle stretched."""
    x0, y0, x1, y1 = BAR
    rows = np.where(mask[y0:y1, x0:x1].mean(1) > 0.8)[0]
    unit_top, bottom = y0 + rows[0], y0 + rows[-1] + 1
    cols = np.where(mask[unit_top:bottom].any(0))[0]
    left, right = cols[0], cols[-1] + 1
    bar = unit[unit_top:bottom, left:right].copy()
    bar[..., 3] = mask[unit_top:bottom, left:right] * 255
    # Without the span under the emblem, its two sides joined
    ex0, _, ex1, _ = EMBLEM
    bar = np.concatenate([bar[:, :ex0 - left], bar[:, ex1 - left:]], 1)
    cap = 24
    height = bottom - unit_top
    middle = Image.fromarray(bar[:, cap:-cap].round().astype(np.uint8), "RGBA").resize(
        (end - start - 2 * cap, height), Image.LANCZOS)
    out = np.zeros((size[1], size[0], 4), np.float32)
    out[top:top + height, start:start + cap] = bar[:, :cap]
    out[top:top + height, start + cap:end - cap] = np.array(middle).astype(np.float32)
    out[top:top + height, end - cap:end] = bar[:, -cap:]
    # The emblem, where it stands over the bar on a unit, moved
    ex0, ey0, ex1, ey1 = EMBLEM
    emblem = mask[ey0:ey1, ex0:ex1]
    centre = (left + right) // 2
    dx = emblem_x - centre
    dy = top - unit_top
    piece = unit[ey0:ey1, ex0:ex1]
    region = out[ey0 + dy:ey1 + dy, ex0 + dx:ex1 + dx]
    region[emblem] = piece[emblem]
    region[emblem, 3] = 255
    im = Image.fromarray(out.round().clip(0, 255).astype(np.uint8), "RGBA")
    frame = Image.new("RGBA", (1000, 718), (0, 0, 0, 0))
    frame.paste(im, paste)
    return frame


def main():
    folder = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    unit, mask = unit_overlay(folder)
    to_frame(unit).save(OUT / "unit.png")
    upgrade = np.zeros_like(unit)
    upgrade[:-UPGRADE_RISE] = unit[UPGRADE_RISE:]
    to_frame(upgrade).save(OUT / "upgrade.png")
    for name, overlay in (("token-unit", unit), ("token-upgrade", upgrade)):
        Image.fromarray(overlay.round().clip(0, 255).astype(np.uint8), "RGBA").save(OUT / (name + ".png"))
    long_overlay(unit, mask, **LEADER_BAR).save(OUT / "leader.png")
    long_overlay(unit, mask, **BASE_BAR).save(OUT / "base.png")
    print("wrote", ", ".join(p.name for p in sorted(OUT.glob("*.png"))))


if __name__ == "__main__":
    main()
