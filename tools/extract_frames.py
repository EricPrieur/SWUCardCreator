"""Extract blank, art-free card frames from Star Wars Unlimited card scans.

With several cards sharing a frame, pixels identical across the cards are frame
and pixels that differ are art. With a single card the frame is cut out by shape.

Usage: python tools/extract_frames.py [frame name ...]
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source-cards"
# Lossless masters; tools/compose_frames.py publishes them to the site as WebP
OUT = ROOT / "frames"
# The unit template has empty cost / power / HP icons to paste over printed numbers.
BLANK_ICONS = SRC / "unit-command-villainy" / "template.png"

T1, T2 = 28.0, 80.0  # card-to-card difference: below T1 is frame, above T2 is art
MIN_PIECE = 300  # smallest free-standing frame piece (a sparkle) is ~340 px


def gold(a):
    return (a[..., 0] > 150) & (a[..., 2] < 140) & (a[..., 0] > a[..., 2] + 60)


def red(a):
    return (a[..., 0] > 120) & (a[..., 1] < 110) & (a[..., 2] < 110) & (a[..., 0] > a[..., 1] + 50)


def blue(a):
    return (a[..., 2] > 150) & (a[..., 0] < 140) & (a[..., 2] > a[..., 0] + 50)


# icon: (colour test, where it is on the card, where the empty one is on the unit template)
COST = (gold, (5, 5, 150, 150), (35, 80, 185, 225))
POWER = (red, (5, 805, 155, 965), (25, 870, 200, 1050))
HP = (blue, (565, 805, 715, 965), (835, 870, 1005, 1050))
# On full unit cards the power and HP icons sit above the text box
POWER_MID = (red, (5, 560, 155, 720), (25, 870, 200, 1050))
HP_MID = (blue, (565, 560, 715, 720), (835, 870, 1005, 1050))

# Frame-only strips of a full unit card, used to line cards up with each other
UNIT_PROBES = [(40, 688, 680, 698), (40, 912, 680, 926), (120, 50, 670, 58), (120, 630, 590, 636)]
# The plain bar under the name; unique units have the taller subtitle bar instead
UNDER_NAME = (100, 100, 678, 118)

# Boxes are (x0, y0, x1, y1). The first card is the reference the pixels come from.
FRAMES = {
    "event/villainy": dict(
        cards=["event-villainy/Iamfourfather.png", "event-villainy/Galactic Ambition.png",
               "event-villainy/Maximum Firepower.png", "event-villainy/Merciless Contest.png"],
        # frame-only areas used to line the cards up
        align=[(40, 170, 680, 200), (40, 480, 680, 520), (40, 170, 90, 480),
               (630, 170, 690, 480), (20, 905, 700, 945)],
        # Only natively aligned cards decide edges; the rescaled 4th would blur them.
        compare=[0, 1, 2],
        # bottom bar: "Galactic Ambition" has an overlay on it
        compare_in=[((0, 912, 718, 946), [0, 2])],
        cut_below=946,  # artist / copyright strip
        # text panels, inset from their borders, and the cards that have that panel
        panels=[((121, 61, 660, 106), [0, 1, 2, 3]), ((126, 119, 658, 156), [0, 1, 2, 3]),
                ((92, 190, 623, 485), [0, 1, 2, 3])],
        icons=[COST],
    ),
    "unit/command-heroism": dict(
        # "Battlefield Marine" is first: it has an empty text box and is not unique
        cards=["unit-command-heroism/Battlefield Marine.png", "unit-command-heroism/Admiral Ackbar.png",
               "unit-command-heroism/Mon Mothma.png", "unit-command-heroism/Scarif Lieutenant.png"],
        align=UNIT_PROBES,
        compare=[0, 1, 2],
        compare_in=[
            ((300, 924, 420, 944), [0, 2]),  # "Admiral Ackbar" has an overlay on the bottom border
            (UNDER_NAME, [0, 3]),  # only the cards that are not unique have the plain bar here
        ],
        cut_below=944,
        # The thin white line under the green band is too close to the art to be
        # found by comparing cards: give it the band's extent, and drop what is below
        extend_rows=[(114, (115, 117), (117, 122), (117, 655))],
        panels=[((121, 58, 660, 106), [0, 1, 2]), ((120, 636, 588, 675), [0, 1, 2])],
        icons=[COST, POWER_MID, HP_MID],
    ),
    "unit/command-villainy": dict(
        # 0 and 2 are not unique; 0 and 3 are ground units, the rest space
        cards=["unit-command-villainy/Superlaser Technician.png", "numbers/Devastator.png",
               "unit-command-villainy/TIE Ambush Squadron.png", "unit-command-villainy/Admiral Trench.png",
               "unit-command-villainy/Executor.png", "numbers/Finalizer.png"],
        align=UNIT_PROBES,
        compare=[0, 1, 2, 3, 4, 5],
        compare_in=[
            (UNDER_NAME, [0, 2]),
            ((286, 26, 682, 56), [0, 3]),  # the "GROUND" half of the top bar
            ((300, 924, 420, 944), [0, 2, 3]),  # the other cards have an overlay on the bottom border
        ],
        cut_below=944,
        panels=[((121, 58, 660, 106), [0, 1, 2, 3, 4, 5]), ((120, 636, 588, 675), [0, 1, 2, 3, 4, 5]),
                ((44, 694, 670, 914), [0, 1, 2, 3, 4, 5])],
        icons=[COST, POWER_MID, HP_MID],
    ),
    # The reference card here is a 716 px wide scan, where the top of the frame
    # sits 2 px lower than on the 718 px wide ones the other unit frames use
    "unit/command-command": dict(
        # 0-1 are not unique, 2-3 are unique; 1 is a space unit, the rest ground
        cards=["unit-command-command/Enterprising Lackeys.png", "unit-command-command/Acclamator Assault Ship.png",
               "unit-command-command/General Krell.png", "unit-command-command/Mace Windu.png"],
        align=[(40, 688, 678, 698), (40, 912, 678, 926), (120, 52, 668, 60), (120, 630, 590, 636)],
        compare=[0, 1, 2, 3],
        compare_in=[
            ((100, 102, 676, 120), [0, 1]),  # the plain bar under the name
            ((286, 26, 680, 58), [0, 2, 3]),  # the "GROUND" half of the top bar
            ((0, 918, 716, 944), [0, 1]),  # the bottom border, where the rescaled card drifts
        ],
        cut_below=944,
        # Every ground card has an overlay on the bottom border: repeat the border beside it
        clone=[((290, 926, 430, 944), -150)],
        panels=[((122, 63, 660, 107), [0, 1, 2, 3]), ((121, 637, 588, 674), [0, 1, 2, 3]),
                ((44, 694, 670, 914), [0, 1, 2, 3])],
        icons=[COST, POWER_MID, HP_MID],
    ),
    "event/command-command": dict(
        cards=["event-command-command/Attack Pattern Delta.png", "event-command-command/Command.png",
               "event-command-command/Manufactured Soldiers.png"],
        align=[(40, 170, 680, 186), (40, 488, 680, 520), (20, 905, 700, 945)],
        compare=[0, 1, 2],
        compare_in=[
            ((0, 912, 718, 946), [0, 2]),  # "Command" has an overlay on the bottom bar
        ],
        cut_below=946,
        erase=[(120, 0, 718, 27), (0, 520, 718, 905)],  # bits of art the three cards happen to share
        # The text panel starts right of the second aspect icon, which sits over the box
        panels=[((121, 61, 660, 106), [0, 1, 2]), ((126, 119, 658, 156), [0, 1, 2]),
                ((114, 190, 623, 485), [0, 1, 2])],
        icons=[COST],
    ),
    "unit/token": dict(
        cards=["token-unit/Beast.png", "token-unit/Beast2.png", "token-unit/Beast3.png"],
        compare=[0, 1, 2],
        cut_below=943,
        # every card reads "Beast" / "Creature", so this text is cloned over
        panels=[((122, 63, 660, 109), [0, 1, 2]), ((124, 877, 588, 915), [0, 1, 2])],
        icons=[COST, POWER, HP],
    ),
    "token/upgrade": dict(
        cards=["token-upgrade/Shield.png", "token-upgrade/Advantage.png", "token-upgrade/Weakness.png"],
        compare=[0, 1, 2],
        compare_in=[((32, 639, 684, 806), [0, 1])],  # "Weakness" has no text box
        cut_below=942,
        panels=[((46, 650, 670, 798), [0, 1]), ((122, 843, 590, 880), [0, 1, 2]),
                ((122, 894, 590, 932), [0, 1, 2])],
        icons=[COST, POWER, HP],
    ),
    "token/credit": dict(
        cards=["token-credit/Credit.webp"],
        # single card: the frame is these rounded boxes (box, corner radius)
        shapes=[((28, 22, 473, 43), 1), ((22, 447, 478, 578), 0), ((23, 582, 477, 659), 14)],
        panels=[((30, 456, 470, 558), [0]), ((78, 591, 422, 616), [0]), ((78, 626, 422, 652), [0])],
        icons=[],
    ),
}
# Spice Token: the Credit Token frame with its type label wiped, so the site can
# print "SPICE TOKEN" there. (label box, x range of clean bar to clone from)
# Space units: the same frame with the "SPACE" half of the top bar from a space unit
for _name in ("unit/command-heroism", "unit/command-villainy"):
    FRAMES[_name + "-space"] = dict(FRAMES[_name], splice=[("numbers/Devastator.png", (292, 30, 677, 52))])
FRAMES["unit/command-command-space"] = dict(
    FRAMES["unit/command-command"],
    splice=[("unit-command-command/Acclamator Assault Ship.png", (290, 32, 676, 54))])


def unit_cfg(cards, plain, same_arena, **extra):
    """A full unit frame from 718 px wide cards; the first card is the reference and is not unique.

    plain: the cards that are not unique. same_arena: the cards in the reference's arena.
    """
    everyone = list(range(len(cards)))
    return dict(
        cards=cards, align=UNIT_PROBES, compare=everyone,
        compare_in=[(UNDER_NAME, plain), ((286, 26, 682, 56), same_arena)],
        cut_below=944,
        clone=[((290, 926, 430, 944), -150)],  # where some cards have a foil stamp on the border
        panels=[((121, 58, 660, 106), everyone), ((120, 636, 588, 675), everyone), ((44, 694, 670, 914), everyone)],
        # Cunning frames are yellow and orange all around the icons, so they cannot be
        # found by colour: the empty ones come from a frame that lines up with this one
        icons=[], icons_from=("unit/command-villainy", [POWER_MID, HP_MID]),
        **extra)


def event_cfg(cards, **extra):
    everyone = list(range(len(cards)))
    return dict(
        cards=cards, align=[(40, 170, 680, 186), (40, 488, 680, 520), (20, 905, 700, 945)], compare=everyone,
        cut_below=946,
        erase=[(120, 0, 718, 27), (0, 520, 718, 905)],
        clone=[((290, 912, 430, 946), -150)],
        panels=[((121, 61, 660, 106), everyone), ((126, 119, 658, 156), everyone), ((114, 190, 623, 485), everyone)],
        icons=[], icons_from=("unit/command-villainy", []),
        **extra)


_C = "cunning/%s.png"
SECOND_ICON = (30, 184, 116, 266)  # the lower aspect icon and what it overlaps
_SPACE_BAR = (292, 30, 677, 52)
# Cunning / Villainy: the cards that are not unique are both space units
_cv = unit_cfg([_C % n for n in ("Cartel Spacer", "Seventh Fleet Defender", "Bib Fortuna", "Boba Fett", "Bossk",
                                 "Jabba the Hutt")], plain=[0, 1], same_arena=[0, 1])
FRAMES["unit/cunning-villainy-space"] = _cv
FRAMES["unit/cunning-villainy"] = dict(_cv, splice=[(_C % "Bib Fortuna", _SPACE_BAR)])
_ground_units = {
    "unit/cunning-heroism": unit_cfg(
        [_C % n for n in ("Lothal Insurgent", "Vanguard Ace", "Chopper", "Leia Organa")], plain=[0, 1],
        same_arena=[0, 2, 3], extend_rows=[(114, (115, 117), (117, 122), (117, 655))],
        # The reference card's art is yellow right beside the cost hexagon, which
        # eats into its edge: the hexagon's outline comes from a sibling frame
        alpha_from=[("unit/cunning-villainy", (15, 20, 118, 126))]),
    "unit/cunning": unit_cfg(
        [_C % n for n in ("Jawa Scavenger", "Mining Guild TIE Fighter", "Outer Rim Headhunter", "Greedo")],
        plain=[0, 1, 2], same_arena=[0, 3]),
    # Two cards are too few to compare: the shape is the single Cunning frame's,
    # plus the second icon from a frame that has one
    "unit/cunning-cunning": unit_cfg(
        [_C % n for n in ("Cantina Bouncer", "Bodhi Rook")], plain=[0], same_arena=[0, 1],
        borrow=["unit/cunning"], alpha_from=[("unit/cunning-villainy", SECOND_ICON)]),
}
for _name, _cfg in _ground_units.items():
    FRAMES[_name] = _cfg
    FRAMES[_name + "-space"] = dict(_cfg, splice=[(_C % "Cartel Spacer", _SPACE_BAR)])
FRAMES["event/cunning-villainy"] = event_cfg([_C % "I Had No Choice", _C % "No Good to Me Dead"])
# Two cards leave bits of matching art: keep only what is also frame on the sibling
FRAMES["event/cunning-heroism"] = event_cfg([_C % "Bamboozle", _C % "Spark of Rebellion"], within="event/cunning-villainy")
# One card each: the shape is borrowed from frames with the same layout
FRAMES["event/cunning"] = event_cfg([_C % "Disarm"], borrow=["event/cunning-villainy", "event/villainy"])
FRAMES["event/cunning-cunning"] = event_cfg(
    [_C % "Cunning"], borrow=["event/cunning"], alpha_from=[("event/cunning-villainy", SECOND_ICON)])
_V = "vigilance/%s.png"
_vigilance = unit_cfg([_V % n for n in ("2-1B Surgical Droid", "Regional Governor", "Distant Patroller")],
                      plain=[0, 1, 2], same_arena=[0, 1],
                      within="unit/cunning")  # drops specks of art the three cards share
_ground_units = {
    "unit/vigilance": _vigilance,
    "unit/vigilance-villainy": unit_cfg(
        [_V % n for n in ("Scout Bike Pursuer", "Academy Defense Walker", "Del Meeko", "Inferno Four")],
        plain=[0, 1], same_arena=[0, 1, 2]),
    "unit/vigilance-heroism": unit_cfg(
        [_V % n for n in ("Consular Security Force", "Restored ARC-170", "Kanan Jarrus", "Yoda", "Redemption",
                          "The Ghost")], plain=[0, 1], same_arena=[0, 2, 3]),
    # The only double Vigilance unit is unique: the frame is the single Vigilance
    # one with that card's second icon added
    "unit/vigilance-vigilance": dict(
        _vigilance, splice=[(_V % "Bendu", SECOND_ICON)], borrow=["unit/vigilance"],
        alpha_from=[("unit/vigilance-villainy", SECOND_ICON)]),
}
for _name, _cfg in _ground_units.items():
    FRAMES[_name] = _cfg
    FRAMES[_name + "-space"] = dict(
        _cfg, splice=_cfg.get("splice", []) + [(_V % "Distant Patroller", _SPACE_BAR)],
        **({"borrow": [_cfg["borrow"][0] + "-space"]} if "borrow" in _cfg else {}))
FRAMES["event/vigilance-villainy"] = event_cfg(
    [_V % "Search Your Feelings", _V % "Power of the Dark Side", _V % "Superlaser Blast"],
    within="event/cunning-villainy")
FRAMES["event/vigilance-vigilance"] = event_cfg([_V % "Vigilance"], borrow=["event/cunning-cunning"])
_A = "aggression/%s.png"
_aggression = unit_cfg(
    [_A % n for n in ("Cantina Braggart", "Star Wing Scout", "Benthic Two Tubes", "Stolen Landspeeder",
                      "Rhokai Gunship")], plain=[0, 1, 3, 4], same_arena=[0, 2, 3], within="unit/cunning")
_ground_units = {
    "unit/aggression": _aggression,
    "unit/aggression-villainy": unit_cfg(
        [_A % n for n in ("Death Star Stormtrooper", "First Legion Snowtrooper", "Imperial Interceptor",
                          "Ruthless Raider", "Admiral Ozzel", "Fifth Brother")],
        plain=[0, 1, 2, 3], same_arena=[0, 1, 4, 5]),
    "unit/aggression-heroism": unit_cfg(
        [_A % n for n in ("SpecForce Soldier", "Green Squadron A-Wing", "K-2SO", "Sabine Wren", "Black One",
                          "Red Three")], plain=[0, 1], same_arena=[0, 2, 3]),
    # The only double Aggression unit is unique: the frame is the single Aggression
    # one with that card's second icon added
    "unit/aggression-aggression": dict(
        _aggression, splice=[(_A % "Saw Gerrera", SECOND_ICON)], borrow=["unit/aggression"],
        alpha_from=[("unit/aggression-villainy", SECOND_ICON)]),
}
for _name, _cfg in _ground_units.items():
    FRAMES[_name] = _cfg
    FRAMES[_name + "-space"] = dict(
        _cfg, splice=_cfg.get("splice", []) + [(_A % "Star Wing Scout", _SPACE_BAR)],
        **({"borrow": [_cfg["borrow"][0] + "-space"]} if "borrow" in _cfg else {}))
FRAMES["event/aggression-villainy"] = event_cfg(
    [_A % "Force Choke", _A % "Force Lightning"], within="event/cunning-villainy")
FRAMES["event/aggression-heroism"] = event_cfg(
    [_A % "Karabast", _A % "Heroic Sacrifice", _A % "For A Cause I Believe In"], within="event/cunning-villainy")
FRAMES["event/aggression"] = event_cfg([_A % "Force Throw"], borrow=["event/cunning"])
FRAMES["event/aggression-aggression"] = event_cfg([_A % "Rallying Cry"], borrow=["event/cunning-cunning"])
# ---- Token units without a text box, in Villainy and Heroism: one ground and one
# space card each, the same size as the neutral token unit frame they borrow from
_T = "tokens/%s.png"
_TOKEN_ARENA = (378, 30, 640, 54)  # the half of a token unit's bar that says GROUND or SPACE


def token_cfg(cards):
    return dict(
        cards=[_T % c for c in cards], compare=[0, 1], cut_below=943,
        panels=[((122, 63, 660, 109), [0, 1]), ((124, 877, 588, 915), [0, 1])],
        icons=[], icons_from=("unit/token", [POWER, HP]),
        # The two cards differ along the bar, so its outline is the neutral frame's.
        # Elsewhere the frame is what the two share, close to the neutral outline or in the icon's slot
        alpha_from=[("unit/token", (286, 22, 690, 60))],
        within=("unit/token", 5, [(30, 112, 120, 200)]))


FRAMES["unit/token-villainy"] = token_cfg(["Battle Droid", "TIE Fighter"])
FRAMES["unit/token-villainy-space"] = token_cfg(["TIE Fighter", "Battle Droid"])
FRAMES["unit/token-heroism"] = token_cfg(["Clone Trooper", "X-Wing"])
FRAMES["unit/token-heroism-space"] = token_cfg(["X-Wing", "Clone Trooper"])
FRAMES["unit/token-space"] = dict(FRAMES["unit/token"], splice=[(_T % "TIE Fighter", _TOKEN_ARENA)])

# ---- Single-aspect, Heroism-only, Villainy-only and neutral frames. Each has one
# or two cards, too few to compare, so the outline comes from the Cunning frame
# with the same decoration and the pixels from the card itself.
_S = "singles/%s.png"
_ONE_ICON = dict(alpha_from=[("unit/cunning", SECOND_ICON)], erase=[(30, 200, 116, 266)])
_GROUND = [(_C % "Bib Fortuna", _SPACE_BAR)]  # the bar's right half says GROUND or SPACE in every colour
_SPACE = [(_C % "Cartel Spacer", _SPACE_BAR)]
_single_units = {
    # (cards with the one that is not unique first, outline to borrow, extra settings)
    "unit/villainy": (["TIE ln Fighter", "Admiral Motti"], "unit/cunning-villainy", _ONE_ICON),
    "unit/heroism": (["Wing Leader", "C-3PO"], "unit/cunning-heroism", _ONE_ICON),
    "unit/command": (["Vanguard Infantry", "Frontline Shuttle"], "unit/cunning", {}),
    "unit/neutral": (["Frontier AT-RT", "Mercenary Gunship"], "unit/cunning", dict(no_icons="unit")),
}
for _name, (_cards, _outline, _extra) in _single_units.items():
    _cfg = unit_cfg([_S % c for c in _cards], plain=[0], same_arena=[0], borrow=[_outline], **_extra)
    FRAMES[_name] = dict(_cfg, splice=_GROUND)
    FRAMES[_name + "-space"] = dict(_cfg, splice=_SPACE)
FRAMES["event/command-villainy"] = event_cfg(
    [_S % "Overwhelming Barrage", _S % "The Emperor's Legion"], within="event/cunning-villainy")
FRAMES["event/command-heroism"] = event_cfg(
    [_S % "Rebel Assault", _S % "U-Wing Reinforcement"], within="event/cunning-heroism")
FRAMES["event/vigilance-heroism"] = event_cfg(
    [_S % "The Force Is With Me", _S % "Mystic Reflection"], within="event/cunning-heroism")
FRAMES["event/heroism"] = event_cfg(
    [_S % "Medal Ceremony"], borrow=["event/cunning-heroism"], alpha_from=[("event/cunning", SECOND_ICON)])
FRAMES["event/vigilance"] = event_cfg([_S % "Moment of Peace"], borrow=["event/cunning"])
FRAMES["event/command"] = event_cfg([_S % "Recruit"], borrow=["event/cunning"])
FRAMES["event/neutral"] = event_cfg([_S % "Restock"], borrow=["event/cunning"], no_icons="event")
# The tabs left of the double Command event's text box come out ragged from its own
# three cards; the Cunning event has the same tabs, cleanly. It must be extracted first.
FRAMES["event/command-command"] = dict(
    FRAMES.pop("event/command-command"), alpha_from=[("event/cunning-cunning", (30, 266, 79, 500))])
FRAMES["token/spice"] = dict(FRAMES["token/credit"], wipe=[((98, 23, 225, 42), (62, 92))])



def load(cfg):
    """The cards lined up with the first one, and which of them had to be rescaled to fit.

    Scans come in two sizes (716 and 718 px wide) whose frames differ by about
    half a percent, so a card of the other size is resized as well as shifted.
    """
    src = [Image.open(SRC / n).convert("RGBA") for n in cfg["cards"]]
    ref = np.array(src[0]).astype(np.float32)
    h, w = ref.shape[:2]
    probes = cfg.get("align")

    def score(a):
        return sum(np.abs(a[y0:y1, x0:x1, :3] - ref[y0:y1, x0:x1, :3]).mean()
                   for x0, y0, x1, y1 in probes)

    out, rescaled = [ref], [False]
    for im in src[1:]:
        if not probes:
            out.append(np.array(im).astype(np.float32))
            rescaled.append(False)
            continue
        sizes = {im.size, (w, h), (w, h + 2), (w, h - 2)}
        sizes |= {(round(im.width * k), round(im.height * k)) for k in (0.994, 0.995, 0.996, 1.004, 1.005, 1.006)}
        best = None
        for size in sizes:
            r = im if size == im.size else im.resize(size, Image.LANCZOS)
            for dx in range(-5, 6):
                for dy in range(-5, 6):
                    c = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                    c.paste(r, (dx, dy))
                    a = np.array(c).astype(np.float32)
                    s = score(a)
                    if best is None or s < best[0]:
                        best = (s, a, size != im.size)
        out.append(best[1])
        rescaled.append(best[2])
    return np.stack(out), rescaled


def difference(st, rescaled, cards):
    """How much the listed cards differ at each pixel: low on the frame, high on the art.

    A rescaled card is slightly blurred and can sit a pixel or two off, so it is
    allowed to match up to two pixels away;
    that still catches art while leaving the frame's sharp edges alone.
    """
    exact = [c for c in cards if not rescaled[c]]
    px = st[exact][..., :3]
    d = (px.max(0) - px.min(0)).max(-1)
    ref = st[exact[0], ..., :3]
    for c in cards:
        if rescaled[c]:
            near = [np.abs(ref - np.roll(st[c, ..., :3], (dy, dx), (0, 1))).max(-1)
                    for dy in range(-2, 3) for dx in range(-2, 3)]
            d = np.maximum(d, np.min(near, axis=0))
    return d


def components(mask):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    sizes = [0]
    for y0, x0 in zip(*np.nonzero(mask)):
        if lab[y0, x0]:
            continue
        n = len(sizes)
        lab[y0, x0] = n
        q = deque([(y0, x0)])
        s = 0
        while q:
            y, x = q.popleft()
            s += 1
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = n
                    q.append((ny, nx))
        sizes.append(s)
    return lab, np.array(sizes)


def dilate(mask, n=1):
    for _ in range(n):
        m = mask.copy()
        m[1:] |= mask[:-1]; m[:-1] |= mask[1:]
        m[:, 1:] |= mask[:, :-1]; m[:, :-1] |= mask[:, 1:]
        mask = m
    return mask


def alpha_from_difference(st, rescaled, cfg):
    card = st[0, ..., 3] > 128
    d = difference(st, rescaled, cfg["compare"])
    for (x0, y0, x1, y1), cards in cfg.get("compare_in", []):
        d[y0:y1, x0:x1] = difference(st, rescaled, cards)[y0:y1, x0:x1]
    lab, sizes = components((d >= T1) & card)
    art = lab == sizes.argmax()  # text glyphs are small islands, not part of this
    lab, sizes = components(card & ~art)
    solid = np.isin(lab, np.nonzero(sizes >= MIN_PIECE)[0])
    soft = np.clip((T2 - d) / (T2 - T1), 0, 1) * (dilate(solid) & ~solid)
    alpha = np.where(solid, 1.0, soft)
    alpha[cfg["cut_below"]:] = 0
    for row, (y0, y1), (c0, c1), (x0, x1) in cfg.get("extend_rows", []):
        alpha[y0:y1, x0:x1] = alpha[row, x0:x1] > 0.5
        alpha[c0:c1, x0:x1] = 0
    return alpha


def alpha_from_shapes(st, cfg):
    h, w = st.shape[1:3]
    k = 4  # supersample for smooth corners
    im = Image.new("L", (w * k, h * k), 0)
    draw = ImageDraw.Draw(im)
    for (x0, y0, x1, y1), r in cfg["shapes"]:
        x0, y0, x1, y1, r = x0 * k, y0 * k, x1 * k, y1 * k, r * k
        draw.rectangle((x0 + r, y0, x1 - r, y1), fill=255)
        draw.rectangle((x0, y0 + r, x1, y1 - r), fill=255)
        for cx, cy in ((x0, y0), (x1 - 2 * r, y0), (x0, y1 - 2 * r), (x1 - 2 * r, y1 - 2 * r)):
            draw.ellipse((cx, cy, cx + 2 * r, cy + 2 * r), fill=255)
    return np.array(im.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255


def clear_panel_text(st, rgb, cfg):
    for (x0, y0, x1, y1), cards in cfg["panels"]:
        region = st[cards][:, y0:y1, x0:x1, :3]
        lum = region.mean(-1)
        paper = np.median(lum[0])
        text = np.stack([dilate(np.abs(l - paper) > 15, 3) for l in lum])
        out = rgb[y0:y1, x0:x1]
        todo = text[0].copy()
        for i in range(1, len(region)):  # same pixel from a card with no text there
            use = todo & ~text[i]
            out[use] = region[i][use]
            todo &= text[i]
        ph, pw = todo.shape
        for y, x in zip(*np.nonzero(todo)):  # still text everywhere: clone nearby paper
            for step in range(1, 12):
                for dx, dy in ((37 * step, 0), (-37 * step, 0), (0, 23 * step), (0, -23 * step)):
                    sx, sy = x + dx, y + dy
                    if 0 <= sx < pw and 0 <= sy < ph and not text[0][sy, sx]:
                        out[y, x] = region[0][sy, sx]
                        break
                else:
                    continue
                break


def wipe_labels(rgb, cfg):
    """Cover a printed label on a horizontal bar by repeating a clean stretch of it."""
    for (x0, y0, x1, y1), (cx0, cx1) in cfg.get("wipe", []):
        for x in range(x0, x1):
            rgb[y0:y1, x] = rgb[y0:y1, cx0 + (x - x0) % (cx1 - cx0)]


def splice_pieces(rgb, cfg):
    """Copy a piece of frame from another card that lines up with this one."""
    for source, (x0, y0, x1, y1) in cfg.get("splice", []):
        piece = np.array(Image.open(SRC / source).convert("RGB")).astype(np.float32)
        rgb[y0:y1, x0:x1] = piece[y0:y1, x0:x1]


def blank_icon(rgb, icon, scale, frame):
    """Paste the empty icon from the unit template over one with a printed number."""
    colour, (bx0, by0, bx1, by1), tbox = icon
    crop = Image.open(BLANK_ICONS).convert("RGB").crop(tbox)
    dest = colour(rgb[by0:by1, bx0:bx1]) & frame[by0:by1, bx0:bx1]  # art can share the colour
    dys, dxs = np.nonzero(dest)
    stretch = np.arange(0.84, 1.08, 0.02)  # the icons are not the same size on every frame
    best = None
    for sx in stretch:
        for sy in stretch:
            size = (int(round(crop.width * scale * sx)), int(round(crop.height * scale * sy)))
            patch = np.array(crop.resize(size, Image.LANCZOS)).astype(np.float32)
            pm = colour(patch)
            ph, pw = pm.shape
            pys, pxs = np.nonzero(pm)
            for oy in range(dys.min() - pys.min() - 4, dys.min() - pys.min() + 5):
                for ox in range(dxs.min() - pxs.min() - 4, dxs.min() - pxs.min() + 5):
                    if ox < 0 or oy < 0 or oy + ph > dest.shape[0] or ox + pw > dest.shape[1]:
                        continue
                    dm = dest[oy:oy + ph, ox:ox + pw]
                    score = (pm & dm).sum() / float((pm | dm).sum() + 1)
                    if best is None or score > best[0]:
                        best = (score, patch, pm & dm, ox, oy)
    _, patch, both, ox, oy = best
    # Fill each row between the icon's edges: that covers the number, and the
    # template's own highlights, which fail the colour test.
    mask = np.zeros_like(both)
    for y in range(both.shape[0]):
        xs = np.nonzero(both[y])[0]
        if len(xs):
            mask[y, xs.min():xs.max() + 1] = True
    target = rgb[by0 + oy:by0 + oy + patch.shape[0], bx0 + ox:bx0 + ox + patch.shape[1]]
    target[mask] = patch[mask]


def copy_empty_icons(rgb, frame, icons, cost):
    """Copy the faces of another frame's empty icons, covering the numbers printed here."""
    other = np.array(Image.open(OUT / (frame + ".png"))).astype(np.float32)
    opaque = other[..., 3] > 127
    copy = cost_hexagon(other[..., :3]) & opaque if cost else np.zeros_like(opaque)
    for colour, (x0, y0, x1, y1), _ in icons:
        area = np.zeros_like(opaque)
        area[y0:y1, x0:x1] = colour(other[y0:y1, x0:x1, :3]) & opaque[y0:y1, x0:x1]
        lab, sizes = components(area)
        face = lab == sizes.argmax()
        for y in np.nonzero(face.any(1))[0]:
            xs = np.nonzero(face[y])[0]
            copy[y, xs.min():xs.max() + 1] = True
    rgb[copy] = other[..., :3][copy]


def extract(name):
    cfg = FRAMES[name]
    st, rescaled = load(cfg)
    rgb = st[0, ..., :3].copy()
    clear_panel_text(st, rgb, cfg)
    wipe_labels(rgb, cfg)
    splice_pieces(rgb, cfg)
    scale = st.shape[2] / 1045 * 1.03  # unit template is 1045 px wide, with a wider border
    def other_alpha(frame):
        return np.array(Image.open(OUT / (frame + ".png")))[..., 3].astype(np.float32) / 255

    if "borrow" in cfg:  # too few cards to compare: the frame is where every listed frame is
        alpha = np.min([other_alpha(frame) for frame in cfg["borrow"]], axis=0)
    elif "shapes" in cfg:
        alpha = alpha_from_shapes(st, cfg)
    else:
        alpha = alpha_from_difference(st, rescaled, cfg)
    if "within" in cfg:  # a frame's name, or (name, how far outside it, boxes that also count)
        frame, reach, boxes = cfg["within"] if isinstance(cfg["within"], tuple) else (cfg["within"], 2, [])
        allowed = dilate(other_alpha(frame) > 0.5, reach)
        for x0, y0, x1, y1 in boxes:
            allowed[y0:y1, x0:x1] = True
        alpha = alpha * allowed
    for frame, (x0, y0, x1, y1) in cfg.get("alpha_from", []):
        alpha[y0:y1, x0:x1] = other_alpha(frame)[y0:y1, x0:x1]
    if "no_icons" in cfg:  # a neutral card: under the cost hexagon, the token unit's outline (2 px off)
        bottom = 266 if cfg["no_icons"] == "unit" else 186  # an event's text box starts below
        alpha[112:bottom, 30:118] = other_alpha("unit/token")[114:bottom + 2, 32:120]
        if cfg["no_icons"] == "event":  # the trait bar runs on to the left where the icon would be
            area = rgb[118:186, 30:120]
            grey = (area.max(-1) - area.min(-1) < 28) & (area.mean(-1) > 90)
            lab, sizes = components(grey)
            alpha[118:186, 30:120] = np.maximum(alpha[118:186, 30:120], dilate(lab == sizes.argmax(), 2))
    if "icons_from" in cfg:  # empty icons copied from a frame that lines up with this one
        frame, icons = cfg["icons_from"]
        copy_empty_icons(rgb, frame, icons, cost=True)
    for x0, y0, x1, y1 in cfg.get("erase", []):
        alpha[y0:y1, x0:x1] = 0
    for (x0, y0, x1, y1), dx in cfg.get("clone", []):  # a stretch of frame copied from beside it
        rgb[y0:y1, x0:x1] = rgb[y0:y1, x0 + dx:x1 + dx]
        alpha[y0:y1, x0:x1] = alpha[y0:y1, x0 + dx:x1 + dx]
    for icon in cfg["icons"]:
        blank_icon(rgb, icon, scale, alpha > 0.5)
    out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
    path = OUT / (name + ".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.png")  # an open viewer can block overwriting in place
    Image.fromarray(out, "RGBA").save(tmp)
    tmp.replace(path)
    x0, y0, x1, y1 = cfg["panels"][0][0]
    paper = np.median(rgb[y0:y1, x0:x1].reshape(-1, 3), 0)
    print("wrote", path, "paper #%02x%02x%02x" % tuple(int(v) for v in paper))


# Cards whose printed cost number is cut out, to print on a frame's empty cost
# hexagon. The hexagon is always in the same place on 716 px wide cards; the
# 718 px wide one is listed with how far its hexagon is shifted.
NUMBER_SOURCES = {
    0: "token-unit/Beast2.png",
    1: "numbers/Familiar Strategem.png",
    2: "numbers/Logray.png",
    3: "numbers/Bestial Bond.png",
    4: "numbers/Kelnacca.png",
    5: "numbers/Eravana.png",
    6: "numbers/Vernestra Rwoh.png",
    7: "numbers/Imperial Venator.png",
    8: "numbers/Neebray Manta.png",
    9: "numbers/Greater Sarlacc.png",
    10: ("numbers/Devastator.png", (-2, -2)),
    11: "numbers/Finalizer.png",
    12: "numbers/Gor.png",
    14: "numbers/Endless Legions.png",
    15: "numbers/The Invasion of Christophsis.png",
}
NUMBER_ROWS = (47, 104)  # every number sits in these rows of the card
# Power and HP use the same numbers in other colours: (outline, fill, fill at the bottom)
NUMBER_COLOURS = {
    "power": ((102, 12, 11), (255, 255, 255), (248, 240, 222)),
    "hp": ((10, 82, 131), (255, 255, 255), (226, 238, 250)),
}


def cost_hexagon(rgb):
    """Filled mask of the cost hexagon in the card's top-left corner."""
    area = np.zeros(rgb.shape[:2], bool)
    area[15:140, 15:140] = gold(rgb[15:140, 15:140])
    lab, sizes = components(area)
    face = lab == sizes.argmax()
    mask = np.zeros_like(face)
    for y in np.nonzero(face.any(1))[0]:  # fill across the printed number
        xs = np.nonzero(face[y])[0]
        mask[y, xs.min():xs.max() + 1] = True
    return mask


def recolour(rgb, colours):
    """Repaint a cost number (cream with an olive outline) as a power or HP number."""
    outline, fill, fill_low = (np.array(c, np.float32) for c in colours)
    lum = rgb.mean(-1)
    t = np.clip((lum - 85) / (225 - 85), 0, 1)[..., None]  # 0 on the outline, 1 on the fill
    rows = np.linspace(0, 1, rgb.shape[0])[:, None, None]
    shade = np.clip((rows - 0.55) / 0.35, 0, 1)  # the fill is tinted towards the bottom
    return outline * (1 - t) + (fill * (1 - shade) + fill_low * shade) * t


def cut_number(hexagon, source):
    """A card's cost number as (pixels, mask), cropped to the number's columns."""
    name, (dx, dy) = source if isinstance(source, tuple) else (source, (0, 0))
    im = np.array(Image.open(SRC / name).convert("RGB")).astype(np.float32)
    im = np.roll(im, (-dy, -dx), (0, 1))  # line the hexagon up with the reference card
    im = im[:hexagon.shape[0], :hexagon.shape[1]]
    y0, y1 = NUMBER_ROWS
    # Inside the hexagon, whatever is not yellow is the number and its outline.
    # An aspect icon can overlap the hexagon's bottom edge, below the number's rows.
    lab, sizes = components(hexagon & ~gold(im))
    digit = np.zeros_like(hexagon)
    for n in np.nonzero(sizes >= 150)[0]:
        if np.nonzero((lab == n).any(1))[0].max() < y1 + 4:
            digit |= lab == n
    xs = np.nonzero(digit.any(0))[0]
    x0, x1 = xs.min() - 1, xs.max() + 2
    return im[y0:y1, x0:x1], digit[y0:y1, x0:x1]


def join_13(twelve, three):
    """No card costs 13: use the 1 of 12, and the wide 3 squeezed to the width of its 2."""
    (rgb12, mask12), (rgb3, mask3) = twelve, three
    middle = slice(mask12.shape[1] // 3, 2 * mask12.shape[1] // 3)
    split = mask12[:, middle].sum(0).argmin() + middle.start  # the gap between 1 and 2
    size = (mask12.shape[1] - split, mask12.shape[0])
    narrow_rgb = np.array(Image.fromarray(rgb3.astype(np.uint8)).resize(size, Image.LANCZOS)).astype(np.float32)
    narrow_mask = np.array(Image.fromarray((mask3 * 255).astype(np.uint8)).resize(size, Image.LANCZOS)) > 127
    return np.hstack([rgb12[:, :split], narrow_rgb]), np.hstack([mask12[:, :split], narrow_mask])


def extract_numbers():
    # The hexagon's shape comes from a card with nothing yellow around it
    hexagon = cost_hexagon(np.array(Image.open(SRC / NUMBER_SOURCES[0]).convert("RGB")).astype(np.float32))
    numbers = {number: cut_number(hexagon, source) for number, source in NUMBER_SOURCES.items()}
    numbers[13] = join_13(numbers[12], numbers[3])
    for number, (rgb, digit) in sorted(numbers.items()):
        versions = {"cost": (rgb, dilate(digit))}
        for kind, colours in NUMBER_COLOURS.items():
            versions[kind] = (recolour(rgb, colours), digit)
        for kind, (pixels, mask) in versions.items():
            out = np.dstack([pixels, mask * 255]).round().astype(np.uint8)
            path = ROOT / "public" / "icons" / kind / ("%d.png" % number)
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(out, "RGBA").save(path)
    print("wrote numbers", sorted(numbers))


def extract_unique_icon():
    """Cut the star printed before a unique card's name, as a dark shape with soft edges."""
    im = np.array(Image.open(SRC / "numbers" / "Gor.png").convert("RGB")).astype(np.float32)
    paper = np.median(im[62:100, 150:340].mean(-1))  # the title bar, left of the name
    star = im[70:101, 352:379].mean(-1)  # the star sits just before the G
    ink = star.min()
    alpha = np.clip((paper - 8 - star) / (paper - 8 - ink), 0, 1)
    out = np.dstack([np.full(star.shape + (3,), (23, 20, 26)), alpha * 255]).round().astype(np.uint8)
    big = Image.fromarray(out, "RGBA").resize((out.shape[1] * 4, out.shape[0] * 4), Image.LANCZOS)
    path = ROOT / "public" / "icons" / "unique.png"
    big.save(path)
    print("wrote", path, "from a", out.shape[1], "x", out.shape[0], "px star")


# Aspect icons sit in two slots under the cost hexagon. (card, slot, how far the
# card is shifted from the 718 px wide cards the slot boxes were measured on)
ASPECT_SOURCES = {
    "command": ("unit-command-heroism/Battlefield Marine.png", 0, (0, 0)),
    "heroism": ("unit-command-heroism/Battlefield Marine.png", 1, (0, 0)),
    "villainy": ("event-villainy/Iamfourfather.png", 0, (0, 0)),
    "vigilance": ("numbers/The Invasion of Christophsis.png", 0, (2, 2)),
    "aggression": ("numbers/Neebray Manta.png", 0, (2, 2)),
    "cunning": ("numbers/Greater Sarlacc.png", 1, (2, 2)),
}
ASPECT_SLOTS = [(36, 118, 109, 184), (36, 187, 109, 262)]


def extract_aspects():
    # The icons' outline comes from a frame that has both slots filled
    frame = np.array(Image.open(OUT / "unit" / "command-heroism.png"))[..., 3] > 127
    for aspect, (source, slot, (dx, dy)) in ASPECT_SOURCES.items():
        im = np.array(Image.open(SRC / source).convert("RGB"))
        im = np.roll(im, (-dy, -dx), (0, 1))
        x0, y0, x1, y1 = ASPECT_SLOTS[slot]
        out = np.dstack([im[y0:y1, x0:x1], frame[y0:y1, x0:x1] * 255]).astype(np.uint8)
        path = ROOT / "public" / "icons" / "aspect" / (aspect + ".png")
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(out, "RGBA").save(path)
    print("wrote aspects", sorted(ASPECT_SOURCES))


# The + and - printed before an upgrade's power and HP numbers: (card, box)
SIGN_SOURCES = {
    ("power", "plus"): ("token-upgrade/Shield.png", (41, 876, 73, 909)),
    ("power", "minus"): ("token-upgrade/Weakness.png", (41, 876, 73, 909)),
    ("hp", "plus"): ("token-upgrade/Shield.png", (604, 876, 636, 909)),
    ("hp", "minus"): ("token-upgrade/Weakness.png", (604, 876, 636, 909)),
}


def extract_signs():
    for (kind, sign), (source, (x0, y0, x1, y1)) in SIGN_SOURCES.items():
        im = np.array(Image.open(SRC / source).convert("RGB")).astype(np.float32)[y0:y1, x0:x1]
        icon = red(im) if kind == "power" else blue(im)
        lab, sizes = components(~icon)  # the sign is whatever is not the icon's colour
        mask = lab == sizes.argmax()
        out = np.dstack([im, mask * 255]).astype(np.uint8)
        Image.fromarray(out, "RGBA").save(ROOT / "public" / "icons" / kind / (sign + ".png"))
    print("wrote signs", sorted(SIGN_SOURCES))


# The bar under a unique unit's name, as an overlay for the frame of the same
# aspects: (frame, unique cards with that frame, how much lower the bar is on that frame)
SUBTITLES = {
    "unit/command-heroism-subtitle": (
        "unit/command-heroism", ["unit-command-heroism/Admiral Ackbar.png", "unit-command-heroism/Mon Mothma.png"], 0),
    "unit/command-villainy-subtitle": (
        "unit/command-villainy", ["numbers/Devastator.png", "unit-command-villainy/Admiral Trench.png",
                                  "unit-command-villainy/Executor.png", "numbers/Finalizer.png"], 0),
    "unit/command-command-subtitle": (
        "unit/command-command", ["unit-command-command/Mace Windu.png", "unit-command-command/General Krell.png"], 2),
    "unit/cunning-villainy-subtitle": (
        "unit/cunning-villainy", ["cunning/Bib Fortuna.png", "cunning/Boba Fett.png", "cunning/Bossk.png",
                                  "cunning/Jabba the Hutt.png"], 0),
    "unit/cunning-heroism-subtitle": ("unit/cunning-heroism", ["cunning/Chopper.png", "cunning/Leia Organa.png"], 0),
    "unit/cunning-subtitle": ("unit/cunning", ["cunning/Greedo.png", "cunning/Razor Crest.png"], 0),
    # One unique card only: the bar's shape comes from the sibling frame's bar
    "unit/cunning-cunning-subtitle": ("unit/cunning-cunning", ["cunning/Bodhi Rook.png"], 0,
                                      "unit/cunning-villainy-subtitle"),
    "unit/vigilance-villainy-subtitle": (
        "unit/vigilance-villainy", ["vigilance/Del Meeko.png", "vigilance/Inferno Four.png"], 0),
    "unit/vigilance-heroism-subtitle": (
        "unit/vigilance-heroism", ["vigilance/Kanan Jarrus.png", "vigilance/Yoda.png", "vigilance/Redemption.png",
                                   "vigilance/The Ghost.png"], 0),
    # Bendu is the only unique card with a plain Vigilance frame, single or double
    "unit/vigilance-subtitle": ("unit/vigilance", ["vigilance/Bendu.png"], 0, "unit/vigilance-villainy-subtitle"),
    "unit/vigilance-vigilance-subtitle": ("unit/vigilance-vigilance", ["vigilance/Bendu.png"], 0,
                                          "unit/vigilance-villainy-subtitle"),
    "unit/aggression-subtitle": (
        "unit/aggression", ["aggression/Benthic Two Tubes.png", "aggression/Shadow Caster.png"], 0),
    "unit/aggression-villainy-subtitle": (
        "unit/aggression-villainy", ["aggression/Admiral Ozzel.png", "aggression/Fifth Brother.png",
                                     "aggression/Punishing One.png"], 0),
    "unit/aggression-heroism-subtitle": (
        "unit/aggression-heroism", ["aggression/K-2SO.png", "aggression/Sabine Wren.png", "aggression/Black One.png",
                                    "aggression/Red Three.png"], 0),
    "unit/aggression-aggression-subtitle": ("unit/aggression-aggression", ["aggression/Saw Gerrera.png"], 0,
                                            "unit/aggression-villainy-subtitle"),
    "unit/villainy-subtitle": ("unit/villainy", ["singles/Admiral Motti.png"], 0, "unit/cunning-villainy-subtitle"),
    "unit/heroism-subtitle": ("unit/heroism", ["singles/C-3PO.png"], 0, "unit/cunning-heroism-subtitle"),
}


def extract_subtitle(name):
    """Whatever the unique cards share under the name that the plain frame does not have."""
    frame_name, cards, dy, *borrow = SUBTITLES[name]
    st, rescaled = load(dict(cards=cards, align=[(x0, y0 + dy, x1, y1 + dy) for x0, y0, x1, y1 in UNIT_PROBES]))
    plain = np.array(Image.open(OUT / (frame_name + ".png"))).astype(np.float32)
    d = difference(st, rescaled, list(range(len(cards))))
    area = np.zeros(d.shape, bool)
    area[100 + dy:142 + dy, 100:700] = True
    rgb = st[0, ..., :3].copy()
    clear_panel_text(st, rgb, dict(panels=[((150, 113 + dy, 640, 133 + dy), list(range(len(cards))))]))
    # New compared to the plain frame: nothing was there, or something else was
    new = (plain[..., 3] < 128) | (np.abs(plain[..., :3] - rgb).max(-1) > 40)
    lab, sizes = components(area & new & (d < T1))
    solid = np.isin(lab, np.nonzero(sizes >= MIN_PIECE)[0])
    if borrow:
        solid = np.array(Image.open(OUT / (borrow[0] + ".png")))[..., 3] > 127
    for y in range(112 + dy, 141 + dy):  # the bar has no gaps: fill across the erased subtitle
        xs = np.nonzero(solid[y])[0]
        if len(xs):
            solid[y, xs.min():xs.max() + 1] = True
    out = np.dstack([rgb, solid * 255]).round().astype(np.uint8)
    path = OUT / (name + ".png")
    Image.fromarray(out, "RGBA").save(path)
    ys, xs = np.nonzero(solid)
    print("wrote", path, "bar at x", xs.min(), xs.max(), "y", ys.min(), ys.max())


# Bases are landscape cards. Each aspect has one card without game text and one
# with it; the two share everything but the text box. (aspect: plain card, text card)
BASES = {
    "cunning": ("Administrator's Tower", "Jedha City"),
    "vigilance": ("Capital City", "Security Complex"),
    "aggression": ("Catacombs of Cadera", "Tarkintown"),
    "command": ("Command Center", "Energy Conversion Lab"),
}
BASE_TEXT_BOX = (29, 449, 970, 600)  # the text box's outline, down to the bottom bar
BASE_NAME = (180, 64, 825, 106)
BASE_LOCATION = (265, 617, 735, 653)
BASE_TEXT = (44, 464, 956, 588)
BASE_HP = (blue, (10, 5, 160, 150), (835, 870, 1005, 1050))
BASE_CUT_BELOW = 661  # artist / copyright strip


def extract_bases():
    cards = {aspect: np.stack([np.array(Image.open(SRC / "base" / (name + ".png")).convert("RGBA")).astype(np.float32)
                               for name in pair]) for aspect, pair in BASES.items()}
    # The frame has the same shape in every aspect: a pixel is frame when an
    # aspect's two cards agree there, in all aspects but at most one
    diffs = np.stack([np.abs(st[0, ..., :3] - st[1, ..., :3]).max(-1) for st in cards.values()])
    d = np.sort(diffs, 0)[-2]
    card = next(iter(cards.values()))[0, ..., 3] > 128
    lab, sizes = components((d >= T1) & card)
    art = lab == sizes.argmax()
    lab, sizes = components(card & ~art)
    solid = np.isin(lab, np.nonzero(sizes >= MIN_PIECE)[0])
    plain_alpha = np.where(solid, 1.0, np.clip((T2 - d) / (T2 - T1), 0, 1) * (dilate(solid) & ~solid))
    plain_alpha[BASE_CUT_BELOW:] = 0
    text_alpha = plain_alpha.copy()
    x0, y0, x1, y1 = BASE_TEXT_BOX
    text_alpha[y0:y1, x0:x1] = 1
    scale = 718 / 1045 * 1.03  # a base is as big as the other cards, turned on its side

    for aspect, st in cards.items():
        versions = {
            aspect: (st, plain_alpha, [(BASE_NAME, [0, 1]), (BASE_LOCATION, [0, 1])]),
            aspect + "-text": (st[[1, 0]], text_alpha, [(BASE_NAME, [0, 1]), (BASE_LOCATION, [0, 1]), (BASE_TEXT, [0])]),
        }
        for name, (pair, alpha, panels) in versions.items():
            rgb = pair[0, ..., :3].copy()
            clear_panel_text(pair, rgb, dict(panels=panels))
            blank_icon(rgb, BASE_HP, scale, alpha > 0.5)
            out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
            path = OUT / "base" / (name + ".png")
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(out, "RGBA").save(path)
        x0, y0, x1, y1 = BASE_NAME
        print("wrote base", aspect, "paper #%02x%02x%02x" % tuple(int(v) for v in np.median(rgb[y0:y1, x0:x1].reshape(-1, 3), 0)))


# ---- Upgrades
# Every upgrade has the same layout, so one outline serves them all. It is cut
# from the only aspect pair with three cards, and the other frames reuse it with
# their own card's pixels. key: (cards, decoration, number of aspect icons)
_U = "upgrade/%s.png"
UPGRADE_MASTER = "aggression-villainy"
UPGRADES = {
    "aggression-villainy": (["Fallen Lightsaber", "Vader's Lightsaber", "Battle Fury"], "villainy", 2),
    "cunning": (["Smuggling Compartment"], "plain", 1),  # second: its empty icons are copied to the rest
    "vigilance": (["Electrostaff"], "plain", 1),
    "command": (["Academy Training"], "plain", 1),
    "aggression": (["Infiltrator's Skill"], "plain", 1),
    "heroism": (["The Mandalorian's Rifle"], "heroism", 1),
    "villainy": (["Darth Revan's Lightsabers", "Grievous's Wheel Bike"], "villainy", 1),
    "neutral": (["Rich Reward"], "plain", 0),
    "vigilance-vigilance": (["Protector"], "plain", 2),
    "aggression-aggression": (["Twice the Pride"], "plain", 2),
    "vigilance-command": (["Bestial Bond"], "plain", 2),
    "aggression-cunning-villainy": (["Shadow of Stygeon Prime"], "villainy", 3),
    "vigilance-heroism": (["Luke's Lightsaber"], "heroism", 2),
    "command-heroism": (["Inspiring Mentor"], "heroism", 2),
    "aggression-heroism": (["Mace Windu's Lightsaber"], "heroism", 2),
    "cunning-heroism": (["Qui-Gon Jinn's Lightsaber"], "heroism", 2),
    "vigilance-villainy": (["Brutal Traditions"], "villainy", 2),
    "cunning-villainy": (["Frozen in Carbonite"], "villainy", 2),
    "command-villainy": (["Craving Power", "Inquisitor's Lightsaber"], "villainy", 2),
}
UPGRADE_HEROISM = [c for cards, decoration, _ in UPGRADES.values() if decoration == "heroism" for c in cards]
# Panels, inset from their borders: top name, game text, bottom name, trait
UPGRADE_PANELS = [(121, 61, 660, 105), (44, 578, 670, 799), (124, 844, 588, 880), (124, 895, 588, 932)]
UPGRADE_BOX = (30, 562, 685, 828)  # the text box's outline on a frame with no decoration
UPGRADE_PROBES = [(20, 552, 700, 584), (20, 796, 700, 834), (110, 50, 680, 64), (110, 100, 680, 114),
                  (110, 836, 600, 848), (110, 926, 600, 942)]
POWER_LOW = (red, (5, 805, 155, 965), (25, 870, 200, 1050))
HP_LOW = (blue, (565, 805, 715, 965), (835, 870, 1005, 1050))


def edges(rgb):
    lum = rgb.mean(-1)
    g = np.zeros_like(lum)
    g[:, 1:] += np.abs(np.diff(lum, axis=1))
    g[1:] += np.abs(np.diff(lum, axis=0))
    return g


def load_upgrade(name, ref, folder="upgrade", probes=None):
    """An upgrade card in the master's geometry. The scans come in two sizes;
    the other size is resized and shifted until its outlines sit on the master's.
    Outlines are compared rather than colours, since the frames differ in colour."""
    im = Image.open(SRC / folder / (name + ".png")).convert("RGB")
    h, w = ref.shape[:2]
    if im.size == (w, h):
        return np.array(im).astype(np.float32)
    target = edges(ref)
    best = None
    for k in (1.0, 1.002, 1.004, 1.005, 1.006, 1.008):
        r = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        for dx in range(-6, 5):
            for dy in range(-6, 5):
                c = Image.new("RGB", (w, h))
                c.paste(r, (dx, dy))
                a = np.array(c).astype(np.float32)
                g = edges(a)
                score = sum(np.abs(g[y0:y1, x0:x1] - target[y0:y1, x0:x1]).mean()
                            for x0, y0, x1, y1 in probes or UPGRADE_PROBES)
                if best is None or score < best[0]:
                    best = (score, a, (k, dx, dy))
    print("  lined up", name, best[2])
    return best[1]


def upgrade_master():
    cards, _, _ = UPGRADES[UPGRADE_MASTER]
    cfg = dict(cards=[_U % c for c in cards],
               align=[(30, 566, 690, 580), (30, 800, 690, 812), (120, 50, 670, 58), (120, 836, 590, 842)],
               compare=[0, 1, 2], cut_below=946)
    st, rescaled = load(cfg)
    alpha = alpha_from_difference(st, rescaled, cfg)
    alpha[270:540] = 0  # specks of art the three cards share
    return st[..., :3], alpha


def extract_upgrades(only=None):
    master_st, master_alpha = upgrade_master()
    ref = master_st[0]
    x0, y0, x1, y1 = UPGRADE_BOX
    box = np.zeros(master_alpha.shape, bool)
    box[y0:y1, x0:x1] = True
    # No decoration: the text box is a plain rectangle, and above the icons nothing else is frame
    plain = master_alpha.copy()
    plain[540:y1 - 2] = box[540:y1 - 2]
    plain[y1 - 2:y1] = np.maximum(plain[y1 - 2:y1], box[y1 - 2:y1])
    # Heroism: sparkles around the box, wherever most Heroism cards are white
    heroes = np.stack([load_upgrade(c, ref) for c in UPGRADE_HEROISM])
    white = (heroes.min(-1) > 232).sum(0) >= len(heroes) - 1
    near = dilate(box, 16) & ~box
    near[:540] = False
    lab, sizes = components(white & near)
    sparkles = np.isin(lab, np.nonzero(sizes >= 12)[0])
    heroism = np.maximum(plain, dilate(sparkles))
    outlines = {"villainy": master_alpha, "plain": plain, "heroism": heroism}

    def frame_alpha(name):
        return np.array(Image.open(OUT / (name + ".png")))[..., 3].astype(np.float32) / 255

    def icon_face(rgb, icon):
        """An icon's face, filled across whatever is printed on it, and its top-left corner."""
        colour, (bx0, by0, bx1, by1), _ = icon
        lab, sizes = components(colour(rgb[by0:by1, bx0:bx1]))
        face = lab == sizes.argmax()
        ys, xs = np.nonzero(face)
        face = face[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        for row in face:
            on = np.nonzero(row)[0]
            row[on.min():on.max() + 1] = True
        return face, (xs.min() + bx0, ys.min() + by0)

    # The token upgrade frame has the power and HP icons already emptied. They go
    # where the icons sit here, found on a card whose frame is another colour.
    token = np.array(Image.open(OUT / "token" / "upgrade.png").convert("RGB")).astype(np.float32)
    empty_icons = []
    for icon, card in ((POWER_LOW, "Smuggling Compartment"), (HP_LOW, "Infiltrator's Skill")):
        face, (sx, sy) = icon_face(token, icon)
        _, target = icon_face(load_upgrade(card, ref), icon)
        empty_icons.append((face, token[sy:sy + face.shape[0], sx:sx + face.shape[1]], target))

    for key, (cards, decoration, icons) in UPGRADES.items():
        if only and key not in only:
            continue
        st = master_st if key == UPGRADE_MASTER else np.stack([load_upgrade(c, ref) for c in cards])
        rgb = st[0].copy()
        clear_panel_text(st, rgb, dict(panels=[(panel, list(range(len(st)))) for panel in UPGRADE_PANELS]))
        # A second pass on the result alone clones paper over whatever the first left behind
        clear_panel_text(rgb[None].copy(), rgb, dict(panels=[(panel, [0]) for panel in UPGRADE_PANELS]))
        alpha = outlines[decoration].copy()
        # The aspect icons hang under the cost hexagon exactly as on units
        sx0, sy0, sx1, sy1 = SECOND_ICON
        if icons == 1:
            alpha[sy0:sy1, sx0:sx1] = frame_alpha("unit/cunning")[sy0:sy1, sx0:sx1]
            alpha[sy0 + 16:sy1, sx0:sx1] = 0
        elif icons == 3:  # a third icon sits one slot further down
            step = ASPECT_SLOTS[1][1] - ASPECT_SLOTS[0][1]
            alpha[sy0 + step:sy1 + step, sx0:sx1] = alpha[sy0:sy1, sx0:sx1]
        elif icons == 0:  # the token unit is 2 px lower and to the right
            alpha[112:sy1, sx0:sx1] = frame_alpha("unit/token")[114:sy1 + 2, sx0 + 2:sx1 + 2]
        for (cx0, cy0, cx1, cy1), dx in [((290, 926, 430, 946), -150)]:  # a foil stamp on the border
            rgb[cy0:cy1, cx0:cx1] = rgb[cy0:cy1, cx0 + dx:cx1 + dx]
            alpha[cy0:cy1, cx0:cx1] = alpha[cy0:cy1, cx0 + dx:cx1 + dx]
        copy_empty_icons(rgb, "unit/command-villainy", [], cost=True)
        for face, pixels, (tx, ty) in empty_icons:
            ys, xs = np.nonzero(face)
            rgb[ys + ty, xs + tx] = pixels[ys, xs]
        out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
        path = OUT / "upgrade" / (key + ".png")
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(out, "RGBA").save(path)
        px0, py0, px1, py1 = UPGRADE_PANELS[0]
        paper = np.median(rgb[py0:py1, px0:px1].reshape(-1, 3), 0)
        unstreak(path)
        print("wrote upgrade", key, "paper #%02x%02x%02x" % tuple(int(v) for v in paper))


def extract_derived_subtitles():
    """Subtitle bars for the two unit frames no unique card has."""
    # Plain Command: the double Command bar, moved into the wider scans' geometry
    im = Image.open(OUT / "unit" / "command-command-subtitle.png").convert("RGBA")
    scaled = im.resize((round(im.width * 1.004), round(im.height * 1.004)), Image.LANCZOS)
    out = Image.new("RGBA", (718, 1000), (0, 0, 0, 0))
    out.paste(scaled, (-2, -2))
    out.save(OUT / "unit" / "command-subtitle.png")
    # Neutral: the Cunning bar with its colour taken out, at the neutral frame's paper tone
    bar = np.array(Image.open(OUT / "unit" / "cunning-subtitle.png")).astype(np.float32)
    frame = np.array(Image.open(OUT / "unit" / "neutral.png").convert("RGB")).astype(np.float32)
    lum = bar[..., :3].mean(-1)
    paper = np.median(lum[115:130, 200:500])
    target = np.median(frame[70:95, 200:500].mean(-1))
    bar[..., :3] = (lum * target / paper).clip(0, 255)[..., None]
    Image.fromarray(bar.round().astype(np.uint8), "RGBA").save(OUT / "unit" / "neutral-subtitle.png")
    print("wrote derived subtitle bars: command, neutral")


# ---- Fortifications: upgrades that attach to a base. They are laid out like an
# upgrade down to the text box; below it, in place of the power and HP icons, a
# rounded block holds the name and trait. key: (card, decoration)
FORTIFICATIONS = {
    "vigilance": ("Carbonite Chamber", "plain"),
    "vigilance-command": ("Bacta Tank", "plain"),
    "aggression-heroism": ("Heavy Ion Cannon", "heroism"),
    "vigilance-villainy": ("Dark Sanctum", "villainy"),
    "command-villainy": ("Military Academy", "villainy"),
    "aggression-villainy": ("Noxious Refinery", "villainy"),
}
FORT_TOP = 828  # where the block starts, right under the text box
FORT_PANELS = [(121, 61, 660, 105), (44, 578, 670, 799), (114, 845, 600, 880), (114, 896, 600, 932)]


def fortification_block(card):
    """The rounded block's shape, read off a card whose art around it is warm while the block is not."""
    cool = ~(card[..., 0] > card[..., 2] + 30)
    block = np.zeros(cool.shape, bool)
    for y in range(FORT_TOP, 950):
        best, start = (0, 0), None
        for x in range(cool.shape[1] + 1):
            on = x < cool.shape[1] and cool[y, x]
            if on and start is None:
                start = x
            if not on and start is not None:
                best = max(best, (x - start, start))
                start = None
        if best[0] > 500:  # a row of the block, not a stray run in the art
            block[y, best[1]:best[1] + best[0]] = True
    return block


def extract_fortifications():
    ref, _ = upgrade_master()
    ref = ref[0]
    cards = {key: load_upgrade(card, ref, "fortification") for key, (card, _) in FORTIFICATIONS.items()}
    block = fortification_block(cards["vigilance"])  # Carbonite Chamber: a blue block on orange art
    for key, (card, decoration) in FORTIFICATIONS.items():
        rgb = cards[key].copy()
        st = rgb[None].copy()
        clear_panel_text(st, rgb, dict(panels=[(panel, [0]) for panel in FORT_PANELS]))
        upgrade = np.array(Image.open(OUT / "upgrade" / (key + ".png")))[..., 3].astype(np.float32) / 255
        alpha = upgrade.copy()
        alpha[FORT_TOP - 2:] = 0
        alpha = np.maximum(alpha, block)
        rgb[930:946, 290:430] = rgb[930:946, 140:280]  # a foil stamp on the block's lower edge
        copy_empty_icons(rgb, "unit/command-villainy", [], cost=True)
        out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
        path = OUT / "fortification" / (key + ".png")
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(out, "RGBA").save(path)
        px0, py0, px1, py1 = FORT_PANELS[0]
        paper = np.median(rgb[py0:py1, px0:px1].reshape(-1, 3), 0)
        print("wrote fortification", key, "paper #%02x%02x%02x" % tuple(int(v) for v in paper))


# Fortification frames the game has no card for: the upgrade frame of those
# aspects down to the text box, and under it the block of a real fortification
# with the same decoration, recoloured. target: the real fortification to recolour
DERIVED_FORTIFICATIONS = {
    "neutral": "vigilance", "command": "vigilance", "aggression": "vigilance", "cunning": "vigilance",
    "heroism": "aggression-heroism", "vigilance-heroism": "aggression-heroism",
    "command-heroism": "aggression-heroism", "cunning-heroism": "aggression-heroism",
    "villainy": "vigilance-villainy", "cunning-villainy": "vigilance-villainy",
}


def extract_derived_fortifications():
    def frame(kind, key):
        return Image.open(OUT / kind / (key + ".png")).convert("RGBA")

    def tones(key):
        """An upgrade frame's ink colour (its top bar, as HSV) and its paper colour."""
        im = frame("upgrade", key).convert("RGB")
        bar = np.array(im.convert("HSV")).astype(np.float32)[34:48, 330:600].reshape(-1, 3)
        x0, y0, x1, y1 = UPGRADE_PANELS[0]
        paper = np.array(im).astype(np.float32)[y0:y1, x0:x1].reshape(-1, 3)
        return np.median(bar, 0), np.median(paper, 0)

    for target, source in DERIVED_FORTIFICATIONS.items():
        (h0, s0, v0), paper0 = tones(source)
        (h1, s1, v1), paper1 = tones(target)
        block = frame("fortification", source)
        rgb = np.array(block.convert("RGB")).astype(np.float32)
        hsv = np.array(block.convert("RGB").convert("HSV")).astype(np.float32)
        is_paper = np.abs(rgb - paper0).max(-1) < 40
        # Ink: turn the hue to the target's and scale how strong and how bright it is;
        # the greyer a pixel, the less it changes, so outlines and highlights survive
        weight = np.clip(hsv[..., 1] / 90.0, 0, 1)
        hsv[..., 0] = (hsv[..., 0] + (h1 - h0)) % 256
        hsv[..., 1] = np.clip(hsv[..., 1] * s1 / max(s0, 1), 0, 255)
        hsv[..., 2] = np.clip(hsv[..., 2] * (1 + (v1 / max(v0, 1) - 1) * weight), 0, 255)
        ink = np.array(Image.fromarray(hsv.round().astype(np.uint8), "HSV").convert("RGB")).astype(np.float32)
        ink[is_paper] = np.clip(rgb[is_paper] * paper1 / paper0, 0, 255)
        out = np.array(frame("upgrade", target)).astype(np.float32)
        out[FORT_TOP - 2:] = np.dstack([ink, np.array(block)[..., 3]])[FORT_TOP - 2:]
        Image.fromarray(out.round().astype(np.uint8), "RGBA").save(OUT / "fortification" / (target + ".png"))
    print("wrote derived fortifications:", " ".join(DERIVED_FORTIFICATIONS))


# ---- Token units with a text box: a unit frame whose bar reads TOKEN UNIT, with
# the icons and trait bar 80 px lower and a shorter text box. One card each, so
# the outline is the unit frame's, rearranged. key: (card, unit frame)
TOKEN_TEXT_UNITS = {
    "token-text-vigilance": ("Mandalorian", "unit/vigilance"),
    "token-text-neutral": ("Spy", "unit/neutral"),
}
TOKEN_TEXT_DROP = 80


def extract_token_text_units():
    ref = np.array(Image.open(SRC / "vigilance" / "2-1B Surgical Droid.png").convert("RGB")).astype(np.float32)
    top = [(110, 48, 680, 62), (110, 100, 680, 114)]
    space = load_upgrade("TIE Fighter", ref, "tokens", top)  # only its bar is used
    bx0, by0, bx1, by1 = 374, 24, 646, 56
    drop = TOKEN_TEXT_DROP
    # Empty power and HP icons, from a frame that has them, moved down
    other = np.array(Image.open(OUT / "unit" / "command-villainy.png")).astype(np.float32)
    faces = np.zeros(other.shape[:2], bool)
    for colour, (x0, y0, x1, y1), _ in (POWER_MID, HP_MID):
        area = np.zeros_like(faces)
        area[y0:y1, x0:x1] = colour(other[y0:y1, x0:x1, :3]) & (other[y0:y1, x0:x1, 3] > 127)
        lab, sizes = components(area)
        face = lab == sizes.argmax()
        for y in np.nonzero(face.any(1))[0]:
            xs = np.nonzero(face[y])[0]
            faces[y, xs.min():xs.max() + 1] = True
    for key, (card, outline) in TOKEN_TEXT_UNITS.items():
        rgb = load_upgrade(card, ref, "tokens", top + [(30, 905, 690, 944)])
        panels = [(121, 58, 660, 106), (120, 636 + drop, 588, 675 + drop), (44, 694 + drop, 670, 914)]
        clear_panel_text(rgb[None].copy(), rgb, dict(panels=[(panel, [0]) for panel in panels]))
        rgb[926:944, 290:430] = rgb[926:944, 140:280]  # a foil stamp on the bottom border
        copy_empty_icons(rgb, "unit/command-villainy", [], cost=True)
        ys, xs = np.nonzero(faces)
        rgb[ys + drop, xs] = other[ys, xs, :3]
        unit = np.array(Image.open(OUT / (outline + ".png")))[..., 3]
        alpha = unit.copy()
        alpha[560:900] = 0
        alpha[560 + drop:900] = unit[560:900 - drop]  # icons, trait bar and the top of the text box
        out = np.dstack([rgb.round().astype(np.uint8), alpha])
        Image.fromarray(out, "RGBA").save(OUT / "unit" / (key + ".png"))
        out[by0:by1, bx0:bx1, :3] = space[by0:by1, bx0:bx1].round().astype(np.uint8)
        Image.fromarray(out, "RGBA").save(OUT / "unit" / (key + "-space.png"))
        paper = np.median(rgb[70:95, 200:500].reshape(-1, 3), 0)
        print("wrote", key, "paper #%02x%02x%02x" % tuple(int(v) for v in paper))


# ---- Leaders: a landscape Leader side and a portrait Leader Unit side. Every
# aspect pair has two cards, too few to compare on their own, but the frame has
# the same shape in each of Heroism and Villainy. key: the pair's two leaders
LEADERS = {
    "vigilance-heroism": ("Chewbacca", "Chirrut Îmwe"),
    "vigilance-villainy": ("Director Krennic", "Iden Versio"),
    "command-heroism": ("Hera Syndulla", "Leia Organa"),
    "command-villainy": ("Emperor Palpatine", "Grand Moff Tarkin"),
    "aggression-heroism": ("Cassian Andor", "Sabine Wren"),
    "aggression-villainy": ("Grand Inquisitor", "IG-88"),
    "cunning-heroism": ("Han Solo", "Jyn Erso"),
    # Thrawn's long text leaves him a shorter Epic Action box: Boba Fett has the usual one
    "cunning-villainy": ("Boba Fett", "Grand Admiral Thrawn"),
}
# The frame ends at `cut`, but for the sparkles that hang up to `tail` rows below it.
# Panels are inset from their borders: name, subtitle, then the rest.
LEADER_SIDES = {
    # ... game text beside and below the second aspect icon, Epic Action box, trait
    "": dict(card="", cut=662, tail=12,
             panels=[(433, 63, 874, 105), (472, 115, 846, 134), (469, 161, 876, 486), (874, 248, 907, 486), (481, 505, 896, 617),
                     (48, 592, 443, 625)]),
    # ... trait, game text
    "-unit": dict(card=" Back", cut=946, tail=12,
                  panels=[(121, 62, 595, 105), (152, 114, 560, 133), (120, 639, 589, 674), (45, 695, 670, 914)]),
}
# The only Space leader unit, a narrower scan, and the half of its bar that says SPACE
LEADER_SPACE = ("Grand Moff Tarkin (Death Star) Back", (334, 28, 598, 52))
LEADER_STAMP = (468, 656, 532, 700)  # the foil stamp, which covers the lower edge of the Leader side's bottom bar


def fill_leftover_text(rgb, panel):
    """Where a line of text ran the whole width of a panel there was no paper to
    clone from beside it: cover what is left with the nearest paper above or below."""
    x0, y0, x1, y1 = panel
    area = rgb[y0:y1, x0:x1]
    lum = area.mean(-1)
    text = dilate(np.abs(lum - np.median(lum)) > 15, 2)
    for x in np.nonzero(text.any(0))[0]:
        clean = np.nonzero(~text[:, x])[0]
        if len(clean):
            for y in np.nonzero(text[:, x])[0]:
                area[y, x] = area[clean[np.abs(clean - y).argmin()], x]


def extract_leaders():
    space = None
    for suffix, side in LEADER_SIDES.items():
        cards = {key: np.stack([np.array(Image.open(SRC / "leaders" / (name + side["card"] + ".png")).convert("RGBA"))
                                .astype(np.float32) for name in pair]) for key, pair in LEADERS.items()}
        cut, tail = side["cut"], side["tail"]
        outlines = {}
        for allegiance in ("heroism", "villainy"):
            # A pixel is frame when a pair's two cards agree there, in all pairs but at most one
            group = [st for key, st in cards.items() if key.endswith(allegiance)]
            d = np.sort([np.abs(st[0, ..., :3] - st[1, ..., :3]).max(-1) for st in group], 0)[-2]
            card = group[0][0, ..., 3] > 128
            lab, sizes = components((d >= T1) & card)
            art = lab == sizes.argmax()
            lab, sizes = components(card & ~art)
            solid = np.isin(lab, np.nonzero(sizes >= MIN_PIECE)[0])
            outlines[allegiance] = np.where(solid, 1.0, np.clip((T2 - d) / (T2 - T1), 0, 1) * (dilate(solid) & ~solid))
        # Under the frame the cards share their dark footer too. The sparkles are
        # what both allegiances have there; the footer's leftovers differ.
        below = np.minimum(outlines["heroism"], outlines["villainy"])[cut:cut + tail]
        for alpha in outlines.values():
            alpha[cut:cut + tail] = below
            alpha[cut + tail:] = 0
        for key, st in cards.items():
            alpha = outlines[key.split("-")[1]].copy()
            rgb = st[0, ..., :3].copy()
            panels = dict(panels=[(panel, [0, 1]) for panel in side["panels"]])
            clear_panel_text(st, rgb, panels)
            # A second pass on the result alone clones paper over whatever the first left behind
            clear_panel_text(rgb[None].copy(), rgb, dict(panels=[(panel, [0]) for panel in side["panels"]]))
            for panel in side["panels"]:
                fill_leftover_text(rgb, panel)
            if suffix:
                copy_empty_icons(rgb, "unit/command-villainy", [POWER_MID, HP_MID], cost=True)
            else:  # the bar's bottom edge under the stamp is repeated from beside it
                x0, y0, x1, y1 = LEADER_STAMP
                rgb[y0:cut, x0:x1] = rgb[y0:cut, x0 - 70:x1 - 70]
                alpha[cut:y1, x0:x1] = 0
            out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
            path = OUT / "leader" / (key + suffix + ".png")
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(out, "RGBA").save(path)
            x0, y0, x1, y1 = side["panels"][0]
            paper = np.median(rgb[y0:y1, x0:x1].reshape(-1, 3), 0)
            print("wrote leader", key + suffix, "paper #%02x%02x%02x" % tuple(int(v) for v in paper))
            if suffix:  # the same frame for a Space unit: the bar reads the same in every colour
                if space is None:
                    card, _ = LEADER_SPACE
                    space = load_upgrade(card, st[0, ..., :3], "leaders",
                                         [(110, 48, 680, 62), (110, 100, 680, 114), (30, 905, 690, 944)])
                x0, y0, x1, y1 = LEADER_SPACE[1]
                out[y0:y1, x0:x1, :3] = space[y0:y1, x0:x1].round().astype(np.uint8)
                # The bar runs on a little behind the aspect icon, whose colour differs:
                # each row's run of the Ground bar's cream takes the Space bar's last column
                tip = out[y0:y1, x1:x1 + 40, :3]
                cream = np.abs(tip.astype(np.float32) - (235, 225, 176)).max(-1) < 45
                for y, run in enumerate(cream):
                    tip[y, :len(run) if run.all() else run.argmin()] = out[y0 + y, x1 - 2, :3]
                Image.fromarray(out, "RGBA").save(OUT / "leader" / (key + suffix + "-space.png"))


def extract_cost_icon():
    """Cut the inline "pay 1 less" cost icon out of the Credit token's game text."""
    im = np.array(Image.open(SRC / "token-credit" / "Credit.webp").convert("RGB")).astype(np.float32)
    ys, xs = np.nonzero(gold(im[456:558, 30:470]))  # the only gold inside the text box
    x0, x1, y0, y1 = xs.min() + 30 - 3, xs.max() + 30 + 4, ys.min() + 456 - 3, ys.max() + 456 + 4
    icon = im[y0:y1, x0:x1]
    paper = (icon.min(-1) > 170) & (icon.max(-1) - icon.min(-1) < 25)
    lab, _ = components(paper)
    edge = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1])
    outside = np.isin(lab, [n for n in edge if n])  # paper around the icon, not the white 1
    out = np.dstack([icon, np.where(outside, 0, 255)]).astype(np.uint8)
    big = Image.fromarray(out, "RGBA").resize((out.shape[1] * 4, out.shape[0] * 4), Image.LANCZOS)
    path = ROOT / "public" / "icons" / "cost-1.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    big.save(path)
    print("wrote", path)
    # The same icon with its 1 taken out, for the site to print any number on: across
    # each row of the yellow face, what is not yellow is the number, and takes the
    # yellow on either side of it
    face = gold(icon)
    number = np.zeros_like(face)
    for y in range(icon.shape[0]):
        xs = np.nonzero(face[y])[0]
        if len(xs):
            number[y, xs.min():xs.max() + 1] = ~face[y, xs.min():xs.max() + 1]
    number = dilate(number, 2)  # with the soft, paler yellow around the number
    for y in range(icon.shape[0]):
        xs = np.nonzero(face[y] & ~number[y])[0]
        gap = np.nonzero(number[y])[0]
        if len(xs) >= 2 and len(gap):
            for channel in range(3):
                icon[y, gap, channel] = np.interp(gap, xs, icon[y, xs, channel])
    out = np.dstack([icon, np.where(outside, 0, 255)]).round().astype(np.uint8)
    big = Image.fromarray(out, "RGBA").resize((out.shape[1] * 4, out.shape[0] * 4), Image.LANCZOS)
    big.save(ROOT / "public" / "icons" / "cost-blank.png")
    print("wrote the blank cost icon")


def extract_exhaust_icon():
    """Cut the arrow that stands for exhausting a card out of an Action's cost, as a dark shape with soft edges."""
    im = np.array(Image.open(SRC / "icons" / "Bail Organa.png").convert("RGB")).astype(np.float32)
    x0, y0, x1, y1 = 166, 766, 206, 806  # between the square brackets after "Action"
    lum = im[y0:y1, x0:x1].mean(-1)
    paper, ink = np.median(lum), lum.min()
    alpha = np.clip((paper - 8 - lum) / (paper - 8 - ink), 0, 1)
    ys, xs = np.nonzero(alpha > 0.5)
    alpha = alpha[ys.min() - 1:ys.max() + 2, xs.min() - 1:xs.max() + 2]
    out = np.dstack([np.full(alpha.shape + (3,), (23, 20, 26)), alpha * 255]).round().astype(np.uint8)
    big = Image.fromarray(out, "RGBA").resize((out.shape[1] * 4, out.shape[0] * 4), Image.LANCZOS)
    path = ROOT / "public" / "icons" / "exhaust.png"
    big.save(path)
    print("wrote", path, "from a", out.shape[1], "x", out.shape[0], "px arrow")


def extract_artist_icon():
    """Cut the brush printed before the artist's name on the card's bottom line, as a white shape."""
    im = np.array(Image.open(SRC / "pilots" / "Clone Pilot.png").convert("RGB")).astype(np.float32)
    lum = im[944:972, 40:72].mean(-1)  # the brush, white on the dark line
    alpha = np.clip((lum - 30) / (240 - 30), 0, 1)
    lab, sizes = components(alpha > 0.4)
    keep = dilate(np.isin(lab, np.nonzero(sizes >= 20)[0]), 1)  # the brush, not specks of art
    alpha = alpha * keep
    ys, xs = np.nonzero(alpha > 0.4)
    alpha = alpha[ys.min() - 1:ys.max() + 2, xs.min() - 1:xs.max() + 2]
    out = np.dstack([np.full(alpha.shape + (3,), 255), alpha * 255]).round().astype(np.uint8)
    big = Image.fromarray(out, "RGBA").resize((out.shape[1] * 4, out.shape[0] * 4), Image.LANCZOS)
    path = ROOT / "public" / "icons" / "artist.png"
    big.save(path)
    print("wrote", path, "from a", out.shape[1], "x", out.shape[0], "px brush")


# The rarity symbol near the right end of a card's bottom line: (card, how far right
# of the 718 px wide cards the symbol sits on that card)
RARITY_SOURCES = {
    "c": ("aggression/Cantina Braggart.png", 0),
    "u": ("aggression/Admiral Ozzel.png", 0),
    "r": ("aggression/Fallen Lightsaber.png", 0),
    "l": ("aggression/Black One.png", 0),
    "s": ("pilots/Bossk.png", 0),
}
RARITY_BOX = (589, 945, 628, 974)


def extract_rarity_icons():
    """Cut the five rarity symbols. They are light shapes on the dark line; the dark
    letter inside some of them is left see-through, so the line shows through it."""
    for rarity, (card, dx) in RARITY_SOURCES.items():
        im = np.array(Image.open(SRC / card).convert("RGB")).astype(np.float32)
        x0, y0, x1, y1 = RARITY_BOX
        reg = im[y0:y1, x0 + dx:x1 + dx]
        light = reg.max(-1)
        lab, sizes = components(light > 100)
        shape = dilate(lab == sizes.argmax(), 2)
        alpha = np.clip((light - 60) / 90, 0, 1) * shape
        ys, xs = np.nonzero(alpha > 0.3)
        alpha = alpha[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        rgb = reg[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
        big = Image.fromarray(out, "RGBA").resize((out.shape[1] * 4, out.shape[0] * 4), Image.LANCZOS)
        path = ROOT / "public" / "icons" / "rarity" / (rarity + ".png")
        path.parent.mkdir(parents=True, exist_ok=True)
        big.save(path)
    print("wrote rarities", sorted(RARITY_SOURCES))


def extract_foil_stamp():
    """Cut the holographic oval printed on the bottom line of rare and legendary cards.
    It is opaque, so its outline is an ellipse; its pixels come from the card."""
    im = Image.open(SRC / "aggression" / "Black One.png").convert("RGB")
    cx, cy, rx, ry = 359, 959.5, 29, 19.5  # its middle and half-sizes, on the card
    box = (int(cx - rx) - 2, int(cy - ry) - 2, int(cx + rx) + 3, int(cy + ry) + 3)
    k = 4  # drawn larger, for a smooth outline
    crop = im.crop(box).resize(((box[2] - box[0]) * k, (box[3] - box[1]) * k), Image.LANCZOS)
    mask = Image.new("L", crop.size, 0)
    ox, oy = (cx - box[0]) * k, (cy - box[1]) * k
    ImageDraw.Draw(mask).ellipse((ox - rx * k, oy - ry * k, ox + rx * k, oy + ry * k), fill=255)
    crop.putalpha(mask)
    path = ROOT / "public" / "icons" / "foil.png"
    crop.save(path)
    print("wrote", path)


# The words in the bar along the top of a card, cut out as masks, so the site can
# keep them solid while the rest of the frame fades: (frame sampled, left word's
# columns, right word's columns and whether it is light or dark on its bar)
LABELS = {
    "unit-ground": ("unit/command-heroism", (115, 280), (310, 625, "dark")),
    "unit-space": ("unit/command-heroism-space", (115, 280), (310, 625, "light")),
    "event": ("event/command", (115, 300), None),
    "upgrade": ("upgrade/command", (115, 300), None),
    "leader-unit-ground": ("leader/command-heroism-unit", (115, 315), (395, 590, "dark")),
    "leader-unit-space": ("leader/command-heroism-unit-space", (115, 315), (395, 590, "light")),
    "leader": ("leader/command-heroism", (105, 330), None),
}
LABEL_ROWS = (31, 52)


def extract_label_masks():
    for name, (frame, left, right) in LABELS.items():
        f = np.array(Image.open(OUT / (frame + ".png")).convert("RGB")).astype(np.float32)
        y0, y1 = LABEL_ROWS
        words = np.zeros(f.shape[:2], bool)
        x0, x1 = left
        words[y0:y1, x0:x1] = f[y0:y1, x0:x1].min(-1) > 185
        if right:
            x0, x1, tone = right
            band = f[y0:y1, x0:x1]
            words[y0:y1, x0:x1] = band.min(-1) > 185 if tone == "light" else band.mean(-1) < 140
        # Letters, not specks, nor the bar's edges and pegs, which are long or tall
        lab, sizes = components(words)
        keep = []
        for n in np.nonzero(sizes >= 6)[0]:
            ys, xs = np.nonzero(lab == n)
            if xs.max() - xs.min() < 40 and ys.max() - ys.min() < 17:
                keep.append(n)
        words = np.isin(lab, keep)
        mask = dilate(words, 2)  # with the letters' dark outline
        out = np.zeros(f.shape[:2] + (4,), np.uint8)
        out[..., :3] = 255
        out[..., 3] = mask * 255
        path = ROOT / "public" / "icons" / "labels" / (name + ".png")
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(out, "RGBA").save(path, optimize=True)
    print("wrote label masks", sorted(LABELS))


def mend_cost_hexagons():
    """On some unit frames the cost hexagon came out with part of its outline missing,
    letting the art show through at its edge. The hexagon is the same on every unit
    frame, so it is copied, outline and all, from one that came out clean."""
    clean = np.array(Image.open(OUT / "unit" / "command.png").convert("RGBA")).astype(np.float32)
    hexagon = dilate(cost_hexagon(clean[..., :3]), 4) & (clean[..., 3] > 0)
    hexagon[118:] = False  # the aspect icons below are each frame's own
    hexagon[:, 120:] = False  # and the name bar to the right
    mended = 0
    for path in sorted((OUT / "unit").glob("*.png")):
        if "subtitle" in path.stem or path.stem.startswith("token"):
            continue
        frame = np.array(Image.open(path).convert("RGBA")).astype(np.float32)
        if frame.shape[:2] != clean.shape[:2]:
            continue  # the narrower double Command scan has its own
        frame[hexagon] = clean[hexagon]
        Image.fromarray(frame.round().astype(np.uint8), "RGBA").save(path)
        mended += 1
    print("mended the cost hexagon on", mended, "unit frames")


def mend_vigilance_icons():
    """The single Vigilance unit frames came out with specks of art in their aspect
    icon and a ragged edge, which show once the frame is faded around a solid icon.
    The icon is the same on every Vigilance unit frame, so it is copied, outline and
    all, from the Heroism one, down to just above where that frame's second icon begins."""
    for arena in ("", "-space"):
        clean = np.array(Image.open(OUT / "unit" / ("vigilance-heroism%s.png" % arena)).convert("RGBA"))
        for name in ("vigilance", "vigilance-vigilance"):
            path = OUT / "unit" / (name + arena + ".png")
            frame = np.array(Image.open(path).convert("RGBA"))
            frame[104:181, 20:124] = clean[104:181, 20:124]
            Image.fromarray(frame, "RGBA").save(path)
            print("mended the Vigilance icon on", path.name)


def unstreak(path):
    """Paint over the thin white dash left near the top of an upgrade's power icon, a
    remnant of the sign printed on the card it came from, with the colours above and below it."""
    im = np.array(Image.open(path).convert("RGBA")).astype(np.float32)
    x0, y0, x1, y1 = 60, 858, 115, 872
    reg = im[y0:y1, x0:x1]
    dash = dilate(reg[..., :3].min(-1) > 225, 1)
    for x in range(reg.shape[1]):
        bad = np.nonzero(dash[:, x])[0]
        good = np.nonzero(~dash[:, x])[0]
        if len(bad) and len(good):
            for c in range(3):
                reg[bad, x, c] = np.interp(bad, good, reg[good, x, c])
    Image.fromarray(im.round().astype(np.uint8), "RGBA").save(path)


def unstreak_upgrades():
    paths = [OUT / "token" / "upgrade.png", *sorted((OUT / "upgrade").glob("*.png"))]
    for path in paths:
        unstreak(path)
    print("cleaned the power icon on", len(paths), "frames")


if __name__ == "__main__":
    extras = {"icons/cost-1": extract_cost_icon, "icons/numbers": extract_numbers, "icons/unique": extract_unique_icon,
              "icons/aspects": extract_aspects, "icons/signs": extract_signs, "base": extract_bases,
              "upgrade": extract_upgrades, "unit/derived-subtitles": extract_derived_subtitles,
              "fortification": extract_fortifications, "unit/token-text": extract_token_text_units,
              "fortification/derived": extract_derived_fortifications,
              "leader": extract_leaders, "icons/exhaust": extract_exhaust_icon,
              "icons/artist": extract_artist_icon, "icons/rarity": extract_rarity_icons,
              "icons/labels": extract_label_masks, "icons/foil": extract_foil_stamp, "upgrade/unstreak": unstreak_upgrades,
              "unit/cost-hexagons": mend_cost_hexagons, "unit/vigilance-icons": mend_vigilance_icons}
    for subtitle in SUBTITLES:
        extras[subtitle] = lambda subtitle=subtitle: extract_subtitle(subtitle)
    for frame in sys.argv[1:] or list(FRAMES) + list(extras):
        extras[frame]() if frame in extras else extract(frame)
