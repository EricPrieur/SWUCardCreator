"""Build frames for aspect combinations no real card has, from the extracted ones.

Two rules cover every combination of up to two colour aspects plus Heroism or Villainy:
  - a doubled colour is that colour's frame (plain, Heroism or Villainy) with a
    second colour icon added;
  - two different colours fade from the first colour's frame on the left into the
    second colour's frame on the right, as real two-colour cards do.

Also writes small thumbnails of every frame for the frame picker, and
src/generatedFrames.ts, the list the site reads.

It also publishes the extracted frames themselves, converting the PNG masters in
frames/ to WebP in public/templates/.

Usage: python tools/compose_frames.py   (after tools/extract_frames.py)
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTERS = ROOT / "frames"  # lossless PNGs written by extract_frames.py
OUT = ROOT / "public" / "templates"  # what the site serves: WebP
COLOURS = ["vigilance", "command", "aggression", "cunning"]
ALLEGIANCES = ["heroism", "villainy"]
# Two-colour pairs in the order real cards print them: first colour on top and on the left
PAIRS = [("vigilance", "command"), ("vigilance", "aggression"), ("command", "aggression"),
         ("command", "cunning"), ("aggression", "cunning"), ("cunning", "vigilance")]
SIZE = (718, 1000)
# The second aspect icon's box; further icons sit one step lower each
SLOT = (30, 184, 116, 266)
SLOT_STEP = 69
# A unit frame where each aspect's icon hangs free in the second slot
ICON_SOURCES = {
    "vigilance": "vigilance-vigilance", "command": "command-command", "aggression": "aggression-aggression",
    "cunning": "cunning-cunning", "heroism": "cunning-heroism", "villainy": "cunning-villainy",
}
NAME_PANEL = (121, 61, 660, 105)
# Unit frames come as a Ground frame, a Space frame and the bar for a unique unit's subtitle
VARIANTS = {"unit": ["", "-space", "-subtitle"], "event": [""], "upgrade": [""], "fortification": [""]}


def load(kind, key):
    """A real frame as float RGBA in the common 718 px geometry, or None if there is none."""
    path = MASTERS / kind / (key + ".png")
    if not path.exists():
        return None
    im = Image.open(path).convert("RGBA")
    if im.size != SIZE:  # a narrower scan: its frame is 0.4% smaller and sits 2 px lower and to the right
        scaled = im.resize((round(im.width * 1.004), round(im.height * 1.004)), Image.LANCZOS)
        im = Image.new("RGBA", SIZE, (0, 0, 0, 0))
        im.paste(scaled, (-2, -2))
    return np.array(im).astype(np.float32)


def icon(aspect):
    x0, y0, x1, y1 = SLOT
    block = load("unit", ICON_SOURCES[aspect])[y0:y1, x0:x1]
    shape = block[..., 3] > 127
    shape[:2] = False  # the top rows are the tip of the icon above
    return block, shape


def add_icon(frame, aspect, slot):
    """Print an aspect icon in the 2nd or 3rd slot, over whatever is there."""
    block, shape = icon(aspect)
    x0, y0, x1, y1 = SLOT
    dy = SLOT_STEP * (slot - 2)
    frame[y0 + dy:y1 + dy, x0:x1][shape] = block[shape]


def fade(left, right):
    """The left frame on the left, the right frame on the right, blended through the middle."""
    t = np.clip((np.arange(SIZE[0]) - 215) / 288.0, 0, 1)
    w = (t * t * (3 - 2 * t))[None, :, None]
    return left * (1 - w) + right * w


def save(frame, kind, name):
    path = OUT / kind / (name + ".webp")
    Image.fromarray(frame.round().clip(0, 255).astype(np.uint8), "RGBA").save(path, "WEBP", quality=92)


def compose(kind):
    made = []

    def real(key):
        return (MASTERS / kind / (key + ".png")).exists()

    def build(key, colours, allegiance, left, right):
        """left / right: keys of the real frames to use (the same one for a doubled colour)."""
        if real(key) or not real(left) or not real(right):
            return
        for variant in VARIANTS[kind]:
            a, b = load(kind, left + variant), load(kind, right + variant)
            frame = a if left == right else fade(a, b)
            if variant != "-subtitle":
                add_icon(frame, colours[1], 2)
                if allegiance:
                    add_icon(frame, allegiance, 3)
            save(frame, kind, key + variant)
        x0, y0, x1, y1 = NAME_PANEL
        frame = load(kind, left) if left == right else fade(load(kind, left), load(kind, right))
        paper = np.median(frame[y0:y1, x0:x1, :3].reshape(-1, 3), 0)
        made.append(dict(type=kind, key=key, aspects=[a.capitalize() for a in colours + ([allegiance] if allegiance else [])],
                         paper="#%02x%02x%02x" % tuple(int(v) for v in paper)))

    def plain(colour):  # a doubled frame stands in for a missing single one: its second icon gets covered
        return colour if real(colour) else colour + "-" + colour

    for colour in COLOURS:
        build(colour + "-" + colour, [colour, colour], None, colour, colour)  # where no real doubled frame exists
        for allegiance in ALLEGIANCES:
            base = colour + "-" + allegiance
            build("%s-%s-%s" % (colour, colour, allegiance), [colour, colour], allegiance, base, base)
    for first, second in PAIRS:
        build(first + "-" + second, [first, second], None, plain(first), plain(second))
        for allegiance in ALLEGIANCES:
            build("%s-%s-%s" % (first, second, allegiance), [first, second], allegiance,
                  first + "-" + allegiance, second + "-" + allegiance)
    return made


def publish():
    """Copy every extracted frame to the site as WebP, a fraction of the PNG's size."""
    count = 0
    for path in sorted(MASTERS.glob("*/*.png")):
        if ".tmp" in path.name:
            continue
        target = OUT / path.parent.name / (path.stem + ".webp")
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.stat().st_mtime < path.stat().st_mtime:
            Image.open(path).convert("RGBA").save(target, "WEBP", quality=92)
        count += 1
    return count


# ---- Pilots: a unit that can also be played as an upgrade. The top is the unit
# frame of its aspects, the rest the upgrade frame's text box, name and trait bars
# and modifier icons, and the unit's power and HP icons sit at the top of the text box.
PILOT_SPLIT = 460  # rows above come from the unit frame, rows below from the upgrade frame
PILOT_RAISE = 118  # how much higher the power and HP icons sit than on a unit
PILOT_ICONS = [(20, 580, 117, 690), (592, 580, 700, 690)]  # power, HP on the unit frame


def published(kind, key):
    """A frame the site serves, as float RGBA in the common 718 px geometry."""
    master = load(kind, key)
    if master is not None:
        return master
    path = OUT / kind / (key + ".webp")
    if not path.exists():
        return None
    return np.array(Image.open(path).convert("RGBA")).astype(np.float32)


def compose_pilots():
    (OUT / "pilot").mkdir(parents=True, exist_ok=True)
    count = 0
    for path in sorted((OUT / "unit").glob("*.webp")):
        key = path.stem
        if key.startswith("token") or key.endswith("-subtitle"):
            continue
        base = key[:-len("-space")] if key.endswith("-space") else key
        unit, upgrade = published("unit", key), published("upgrade", base)
        if unit is None or upgrade is None:
            continue
        frame = upgrade.copy()
        frame[:PILOT_SPLIT] = unit[:PILOT_SPLIT]
        for x0, y0, x1, y1 in PILOT_ICONS:
            icon = unit[y0:y1, x0:x1]
            shape = icon[..., 3] > 0
            target = frame[y0 - PILOT_RAISE:y1 - PILOT_RAISE, x0:x1]
            a = icon[..., 3:4] / 255
            target[..., :3] = np.where(shape[..., None], icon[..., :3] * a + target[..., :3] * (1 - a), target[..., :3])
            target[..., 3] = np.maximum(target[..., 3], icon[..., 3])
        save(frame, "pilot", key)
        count += 1
    return count


# ---- Leader pilots. The Leader side's Epic Action box is taller, to offer
# deploying as an upgrade too; the Leader Unit side is laid out like a pilot.
LEADER_KEYS = [c + "-" + a for c in COLOURS for a in ALLEGIANCES]
EPIC_COLUMNS = (471, 906)  # the Epic Action box, from its left outline to its right
EPIC_HEADER = (488, 502)  # the gold band along its top
EPIC_RAISE = 110  # how much higher the band is on a pilot leader
EPIC_FILL = (505, 535)  # plain rows of the box, repeated down from the raised band


def compose_leader_pilots():
    count = 0
    for key in LEADER_KEYS:
        # A Leader side is landscape: read as it is, not fitted to the portrait geometry
        front = np.array(Image.open(MASTERS / "leader" / (key + ".png")).convert("RGBA")).astype(np.float32)
        x0, x1 = EPIC_COLUMNS
        h0, h1 = EPIC_HEADER
        top = h0 - EPIC_RAISE
        frame = front.copy()
        frame[top:top + h1 - h0, x0:x1] = front[h0:h1, x0:x1]
        f0, f1 = EPIC_FILL
        for y in range(top + h1 - h0, h1):
            frame[y, x0:x1] = front[f0 + (y - top) % (f1 - f0), x0:x1]
        save(frame, "leader", key + "-pilot")
        upgrade = published("upgrade", key)
        for variant in ("", "-space"):
            unit = load("leader", key + "-unit" + variant)
            back = upgrade.copy()
            back[:PILOT_SPLIT] = unit[:PILOT_SPLIT]
            for ix0, iy0, ix1, iy1 in PILOT_ICONS:
                icon = unit[iy0:iy1, ix0:ix1]
                shape = icon[..., 3] > 0
                target = back[iy0 - PILOT_RAISE:iy1 - PILOT_RAISE, ix0:ix1]
                a = icon[..., 3:4] / 255
                target[..., :3] = np.where(shape[..., None], icon[..., :3] * a + target[..., :3] * (1 - a), target[..., :3])
                target[..., 3] = np.maximum(target[..., 3], icon[..., 3])
            save(back, "leader", key + "-unit-pilot" + variant)
        count += 1
    return count


def thumbnails():
    count = 0
    for kind in ("unit", "event", "upgrade", "fortification", "leader", "pilot", "token", "base"):
        (OUT / "thumb" / kind).mkdir(parents=True, exist_ok=True)
        for path in sorted((OUT / kind).iterdir()):
            if path.suffix != ".webp" or path.stem.endswith("-subtitle"):
                continue
            im = Image.open(path).convert("RGBA")
            im = im.resize((240, round(240 * im.height / im.width)), Image.LANCZOS)
            im.save(OUT / "thumb" / kind / (path.stem + ".webp"), "WEBP", quality=85)
            count += 1
    return count


if __name__ == "__main__":
    print("published:", publish())
    made = []
    for kind in VARIANTS:
        frames = compose(kind)
        print(kind, len(frames), "composed:", " ".join(f["key"] for f in frames))
        made += frames
    lines = ["// Written by tools/compose_frames.py: frames composed for aspect combinations",
             "// that no extracted card has. Do not edit by hand.",
             "export const generatedFrames = ["]
    lines += ["  " + json.dumps(f).replace('"type"', "type").replace('"key"', "key").replace('"aspects"', "aspects")
              .replace('"paper"', "paper").replace('"', "'") + "," for f in made]
    lines += ["] as const", ""]
    (ROOT / "src" / "generatedFrames.ts").write_text("\n".join(lines), encoding="utf-8")
    print("pilots:", compose_pilots(), "leader pilots:", compose_leader_pilots())
    print("thumbnails:", thumbnails())
