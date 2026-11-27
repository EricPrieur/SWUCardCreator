"""Fetch Standard-frame card scans from swudb.com, the sources of the Standard frames.

For each Hyperspace master in frames/<type>/ (its aspects and variant from its name), several
Standard printings with exactly those aspects, saved to source-cards/standard/<type>/<key>/
(gitignored: official scans stay on this computer).

Usage: python -I tools/fetch_standard.py <catalog.json> [type[/key] ...]

catalog.json: swudb's search results by card (t:unit, t:event, ... with grouping=cards), keyed
SET-NUMBER. Cards come from the main sets only, unique ones for a subtitle frame, plain ones for
the others; the least text first (the cheapest card is used as a proxy), so less is to clean.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASTERS = ROOT / "frames"
OUT = ROOT / "source-cards" / "standard"
MAIN_SETS = {"SOR", "SHD", "TWI", "JTL", "LOF", "SEC", "LAW", "ASH", "HMW"}
ASPECTS = ["", "aggression", "command", "cunning", "vigilance", "heroism", "villainy"]
TYPES = {"leader": 0, "base": 1, "unit": 2, "event": 3, "upgrade": 4, "fortification": 4}
PER_KEY = 6


def wanted(kind, key):
    """A master's name: its aspects (colours, then heroism / villainy) and variant."""
    words = key.split("-")
    variant = [w for w in words if w in ("space", "subtitle", "unit", "text")]
    # A doubled colour (Aggression-Aggression) is a card with that aspect twice
    aspects = sorted(w for w in words if w in ASPECTS)
    if "token" in words:
        variant.append("token")
    return aspects, variant


def fits(p, kind, aspects, variant):
    if p["cardType"] != TYPES[kind] or p["isToken"] != ("token" in variant):
        return False
    # A Fortification (an upgrade with a Fortify block under its text) has frames of its own
    if kind in ("upgrade", "fortification") and ("Fortification" in (p["traits"] or "")) != (kind == "fortification"):
        return False
    if not p["isToken"] and p["expansionAbbreviation"] not in MAIN_SETS:
        return False
    if sorted(ASPECTS[a] for a in p["aspectIds"]) != aspects:
        return False
    if kind == "unit":
        if (p["arena"] == 1) != ("space" in variant):
            return False
        if not p["isToken"] and p["isUnique"] != ("subtitle" in variant):
            return False
    if kind == "leader" and "space" in variant:
        return False  # chosen by hand: few leaders' unit sides fly
    return True


def fetch(path, to):
    """True once the scan is there; a missing one (404) is skipped."""
    if to.exists():
        return True
    request = urllib.request.Request(f"https://swudb.com/images{path.lstrip('~')}", headers={"User-Agent": "Mozilla/5.0"})
    try:
        data = urllib.request.urlopen(request).read()
    except urllib.error.HTTPError:
        return False
    to.write_bytes(data)
    time.sleep(0.5)
    return True


def main():
    catalog = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    only = sys.argv[2:]
    for kind in TYPES:
        for master in sorted((MASTERS / kind).glob("*.png")):
            key = master.stem
            if only and kind not in only and f"{kind}/{key}" not in only:
                continue
            aspects, variant = wanted(kind, key)
            if "subtitle" in variant:
                continue  # a unique unit's subtitle bar is the same on both: the Hyperspace one is used
            found = [p for p in catalog.values() if fits(p, kind, aspects, variant)]
            found.sort(key=lambda p: (p["cost"] or 0, p["expansionAbbreviation"], p["cardNumber"]))
            folder = OUT / kind / key
            folder.mkdir(parents=True, exist_ok=True)
            got = 0
            for p in found:
                image = p["backImagePath"] if kind == "leader" and "unit" in variant else p["frontImagePath"]
                if image and fetch(image, folder / f"{p['expansionAbbreviation']}-{p['cardNumber']}.png"):
                    got += 1
                if got == PER_KEY:
                    break
            print(f"{kind}/{key}: {got} of {len(found)}")


if __name__ == "__main__":
    main()
