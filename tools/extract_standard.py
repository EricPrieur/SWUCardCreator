"""Extract blank Standard frames (the regular printing's, not Hyperspace) from swudb scans.

The scans of one frame (tools/fetch_standard.py, in source-cards/standard/<type>/<key>/) are
lined up on the first; pixels the cards agree on are frame, the art window (where they differ) is
see-through. In the text panels (name, trait, game text) each pixel takes its lightest value
across the cards: the printed text is dark on light paper, so it disappears where any card
leaves that pixel blank. The cost / power / HP icons come empty from the Hyperspace master of the
same frame, which has them at the same place.

Usage: python -I tools/extract_standard.py [type/key ...]
Writes frames-standard/<type>/<key>.png, lossless, in the Hyperspace masters' geometry (718 x 1000).
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source-cards" / "standard"
HYPER = ROOT / "frames"
OUT = ROOT / "frames-standard"
SIZE = (718, 1000)
LANDSCAPE = (1000, 718)

AGREE = 30.0  # spread across the cards (per channel, max - min) below which a pixel is frame
CORNER = 48  # the outer corners squared off (px), well past the printed rounding
SHIFT = 4  # how far a scan may sit off the first, in pixels, each way
# Per type: its size, the art window (see-through, whatever the cards agree on in it), and the
# artist / copyright / set number strip cut off below (see-through, as on the Hyperspace masters).
# A leader's Leader side and a base are on their side. Fortifications have no scans of their own
# for most aspects: they borrow the upgrade's (the same art window; the Fortify block comes from
# the master)
KINDS = {
    "unit": dict(size=SIZE, window=(72, 120, 646, 634), cut=944),
    "event": dict(size=SIZE, window=(72, 520, 648, 922), cut=944),
    "upgrade": dict(size=SIZE, window=(72, 122, 648, 570), cut=944),
    "fortification": dict(size=SIZE, window=(72, 122, 648, 570), cut=944, borrow="upgrade"),
    "leader": dict(size=SIZE, window=(72, 152, 646, 634), cut=944),
    "leader-side": dict(size=LANDSCAPE, window=(74, 60, 456, 590), cut=662),
    "base": dict(size=LANDSCAPE, window=(74, 122, 938, 602), cut=662),
    # Tokens (one scan each, from the token sets: TTWI, TJTL, THMW, TSEC, TASH): a token unit's art
    # runs to its bottom bar, or to its trait bar when it has a text box (Spy, Mandalorian); a
    # token upgrade's (Shield, Advantage) to its text box
    "token-unit": dict(size=SIZE, window=(72, 118, 646, 868), cut=944),
    "token-text": dict(size=SIZE, window=(72, 118, 649, 708), cut=944),
    "token": dict(size=SIZE, window=(72, 100, 648, 640), cut=944),
    # The Credit token (LAW T01, swuforge's scan: swudb has none), smaller like its Hyperspace
    # master; the Spice token is the same frame, its label wiped by its own master
    "token-credit": dict(size=(501, 700), window=(50, 44, 452, 446), cut=662),
}
# Lining scans up: the black outer border, the same on every type
def probes(size):
    w, h = size
    return [(2, 100, 20, h - 100), (w - 20, 100, w - 2, h - 100), (100, 2, w - 100, 18)]


def load(path, size=SIZE):
    im = Image.open(path).convert("RGBA")
    if im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.array(im).astype(np.float32)


def shifted(a, dx, dy):
    """The scan moved by dx, dy; the edge it uncovers repeats the edge pixels, not see-through."""
    pad = np.pad(a, ((SHIFT, SHIFT), (SHIFT, SHIFT), (0, 0)), mode="edge")
    h, w = a.shape[:2]
    return pad[SHIFT + dy:SHIFT + dy + h, SHIFT + dx:SHIFT + dx + w]


def align(ref, a, probes):
    best = None
    for dy in range(-SHIFT, SHIFT + 1):
        for dx in range(-SHIFT, SHIFT + 1):
            s = shifted(a, dx, dy)
            err = sum(np.abs(s[y0:y1, x0:x1, :3] - ref[y0:y1, x0:x1, :3]).mean() for x0, y0, x1, y1 in probes)
            if best is None or err < best[0]:
                best = (err, dx, dy)
    return shifted(a, best[1], best[2]), best


def extract(kind, key):
    # The border is set by the colour and Heroism / Villainy: a doubled colour (Command-Command,
    # rarely printed) borrows its single twin's scans, the second icon coming from the master
    words = key.split("-")
    if kind == "token" and key in ("credit", "spice"):
        cfg = KINDS["token-credit"]
    elif kind == "unit" and key.startswith("token"):
        cfg = KINDS["token-text" if "text" in words else "token-unit"]
    else:
        cfg = KINDS["leader-side" if kind == "leader" and "unit" not in words else kind]
    size = cfg["size"]
    # Cut at the Hyperspace master's own size (the token frames are 716 wide, not 718): its bars
    # and icons go on top unstretched, and both versions line up on the card (the user,
    # 2026-11-27: the token's bottom bar moved between Hyperspace and Standard)
    hyper = HYPER / kind / (key + ".png")
    if hyper.exists() and Image.open(hyper).size != size:
        master = Image.open(hyper).size
        sx, sy = master[0] / size[0], master[1] / size[1]
        window = cfg["window"] and tuple(round(v * (sx, sy)[i % 2]) for i, v in enumerate(cfg["window"]))
        cfg = dict(cfg, size=master, window=window, cut=round(cfg["cut"] * sy))
        size = master
    twin = "-".join(w for i, w in enumerate(words) if not (i and w == words[i - 1]))
    files = sorted((SRC / kind / key).glob("*.png")) + (sorted((SRC / kind / twin).glob("*.png")) if twin != key else [])
    if cfg.get("borrow"):
        files += sorted((SRC / cfg["borrow"] / key).glob("*.png"))
    # A space frame with no scans (a leader's unit side that flies): its ground twin's border,
    # the arena bar coming from the master
    if not files and key.endswith("-space"):
        files = sorted((SRC / kind / key[:-len("-space")]).glob("*.png"))
    if not files:
        return print(f"{kind}/{key}: no scans")
    cards = [load(f, size) for f in files]
    ref = next((c for c, f in zip(cards, files) if Image.open(f).size == size), cards[0])
    lined = []
    for c, f in zip(cards, files):
        a, (err, dx, dy) = align(ref, c, probes(size))
        lined.append(a)
        print(f"  {f.stem}: shift {dx},{dy} err {err:.1f}")
    st = np.stack(lined)
    frame = np.median(st, 0)
    # The card's own outline (its rounded corners), from the scans' alpha
    outline = frame[..., 3].copy()
    # Frame where most cards agree with the median: one card's foil stamp or older printing
    # doesn't punch a hole
    near = (np.abs(st[..., :3] - frame[None, ..., :3]).max(-1) < AGREE).sum(0)
    # (with one or two scans, all of them; one scan is taken as it is, its art window cleared)
    n = len(lined)
    alpha = np.where(near >= (n - 2 if n >= 4 else n), 255.0, 0.0)
    if not cfg["window"]:
        return measure(kind, key, alpha)
    x0, y0, x1, y1 = cfg["window"]
    alpha[y0:y1, x0:x1] = 0
    # See-through only where the art shows: a hole the art window doesn't reach (inside a border
    # pill, where an older set's highlight differs) is frame; thin gaps and specks don't count as
    # a way through
    clear = alpha == 0
    wide = ndimage.binary_opening(clear, iterations=2)
    labels, _ = ndimage.label(wide)
    art = np.unique(labels[y0:y1, x0:x1])
    reached = np.isin(labels, art[art > 0])
    alpha = np.where(clear & ndimage.binary_dilation(reached, iterations=2), 0.0, 255.0)
    alpha[:, :][~clear] = 255
    frame[..., 3] = np.minimum(np.maximum(frame[..., 3], 0), alpha)
    # The Hyperspace master on top: its name, trait and text panels, icons and bars are the
    # Standard frame's too, clean; only the border around the art comes from the scans
    if hyper.exists():
        h = load(hyper, size)
        a = h[..., 3:] / 255.0
        out_a = a + frame[..., 3:] / 255.0 * (1 - a)
        frame[..., :3] = (h[..., :3] * a + frame[..., :3] * (frame[..., 3:] / 255.0) * (1 - a)) / np.maximum(out_a, 1e-6)
        frame[..., 3:] = out_a * 255
    # The strip under the frame (artist, copyright, set number on a real card) is the Standard
    # frame's black border, solid to the card's rounded corners: the card line is printed on it.
    # (Hyperspace leaves it see-through, the art running to the edge.)
    cut = cfg["cut"]
    # the scans' own artist and copyright line wiped, in the black of the frame's own side border
    black = np.median(frame[cut - 40:cut, 3:12, :3].reshape(-1, 3), 0)
    frame[cut:, :, :3] = black
    frame[cut:, :, 3] = 255
    # The outer corners square and black: the printed card's corners are rounder than the site's
    # card, whose own rounding cuts them; left see-through, the card's backdrop showed through
    # them (a yellow sliver at the top corners; the user, 2026-11-27)
    h, w = frame.shape[:2]
    for ys in (slice(0, CORNER), slice(h - CORNER, h)):
        for xs in (slice(0, CORNER), slice(w - CORNER, w)):
            corner = frame[ys, xs]
            thin = corner[..., 3] < 255
            corner[..., :3][thin] = black
            corner[..., 3][thin] = 255
    to = OUT / kind / (key + ".png")
    to.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(frame.round().clip(0, 255).astype(np.uint8), "RGBA").save(to)
    print(f"{kind}/{key}: {len(files)} scans -> {to.relative_to(ROOT)}")


def measure(kind, key, alpha):
    """No art window set yet: where the cards agree, by column and by row, to find it."""
    h, w = alpha.shape
    rows = (alpha[:, w // 4:3 * w // 4] > 0).mean(1)
    cols = (alpha[h // 5:4 * h // 5] > 0).mean(0)
    print(f"{kind}/{key} rows: " + " ".join(f"{y}:{rows[y]:.2f}" for y in range(0, h, 16)))
    print(f"{kind}/{key} cols: " + " ".join(f"{x}:{cols[x]:.2f}" for x in range(0, w, 16)))


def main():
    wanted = sys.argv[1:]
    for folder in sorted(SRC.glob("*/*")):
        name = f"{folder.parent.name}/{folder.name}"
        if not wanted or name in wanted or folder.parent.name in wanted:
            extract(folder.parent.name, folder.name)


if __name__ == "__main__":
    main()
