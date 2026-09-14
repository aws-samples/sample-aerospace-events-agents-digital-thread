#!/usr/bin/env python3
"""Build the static demo gallery from the demo markdown.

Source of truth: docs/specs/DEMOS.md (the hierarchy/index) + each
docs/specs/<slug>-demo/README.md (a walkthrough with an embedded video,
inline screenshots, and a live-evidence table).

Output: public/  — a static site that mirrors the demo hierarchy:
    public/index.html                 (from DEMOS.md)
    public/<slug>/index.html          (from <slug>/README.md)
    public/<slug>/video/*.mp4         (copied — embedded as <video>)
    public/<slug>/img/*.png           (copied — rendered as <figure>)

The two HTML shells in site/templates/ are produced by the
template design; this script only injects content
into their <!-- ... --> placeholders. No hand-rolled page HTML lives here.

Run: python site/build.py   (needs: pip install markdown)
"""
from __future__ import annotations

import html
import re
import shutil
from pathlib import Path

import markdown  # pip install markdown

ROOT = Path(__file__).resolve().parent.parent          # repo root
SPECS = ROOT / "docs" / "specs"
TPL = Path(__file__).resolve().parent / "templates"
OUT = ROOT / "public"

SITE_TITLE = "Aerospace Events Agents · Digital Thread"
SITE_TITLE_DISPLAY = ("Digital continuity, <em>end to end</em>, "
                      "with agents driving the process")
SITE_TAGLINE = ("Agents prepare, humans decide — <strong>digital continuity</strong> "
                "from design to fleet. Seven focused demos and one continuous hero "
                "take, each recorded against the live deployed pipeline.")
FOOTER_NOTE = ("Each demo is a continuous screen recording against the live deployed "
               "pipeline (eu-west-1); the frontend runs locally, driven with Playwright.")
STATS = [("10", "AI agents"), ("13", "CDK stacks"),
         ("7", "focused demos"), ("~3,080", "graph nodes")]

HERO_SLUG = "hero-demo"

MD_EXT = ["tables", "fenced_code", "sane_lists", "attr_list"]


# ----------------------------------------------------------------------------
# small inline-markdown converter for table cells / short strings.
# HTML-escapes FIRST (so quotes/&/< in the source can't break out of an
# attribute or inject markup), then adds the inline tags.
# ----------------------------------------------------------------------------
def inline_md(s: str) -> str:
    s = html.escape(s.strip(), quote=False)              # escape & < > (keep ' " readable)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)        # [text](url) -> text
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)       # **bold**
    s = re.sub(r"(?<![\w*])\*([^*\n]+?)\*(?![\w*])", r"<i>\1</i>", s)  # *italic*
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)       # `code`
    return s


def attr_text(s: str) -> str:
    """Plain, fully-escaped text for an HTML attribute (meta description) —
    no tags, all quotes escaped so it can never break out of the attribute."""
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)        # [text](url) -> text
    s = re.sub(r"[*`]", "", s)                            # drop md emphasis marks
    return html.escape(" ".join(s.split()), quote=True)   # escapes & < > " '


def plain_text(s: str) -> str:
    """Plain UNescaped text (titles): strip links + md emphasis marks, no HTML.
    Consumers escape it themselves — store titles as text, never pre-built HTML."""
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)        # [text](url) -> text
    s = re.sub(r"[*`]", "", s)                            # drop ** * ` marks
    return " ".join(s.split()).strip(" []")


# ----------------------------------------------------------------------------
# parse DEMOS.md: hero card + the ordered pillar table
# ----------------------------------------------------------------------------
def parse_index() -> tuple[dict, list[dict]]:
    text = (SPECS / "DEMOS.md").read_text(encoding="utf-8")

    # hero: **[Title](hero-demo/README.md)** ... — blurb up to the next blank line
    hero = {"slug": HERO_SLUG, "title": "The whole picture, end to end", "blurb": ""}
    m = re.search(r"\[([^\]]+)\]\(" + HERO_SLUG + r"/README\.md\)", text)
    if m:
        hero["title"] = m.group(1).strip()
        tail = text[m.end():]
        blurb = re.split(r"\n\s*\n", tail.lstrip(" —–-\n"), maxsplit=1)[0]
        hero["blurb"] = inline_md(" ".join(blurb.split()))

    # pillar table rows: | n | [**Title**](slug/README.md) | proves | trigger |
    pillars: list[dict] = []
    for row in re.finditer(r"^\|\s*(\d+)\s*\|(.+?)\|(.+?)\|(.+?)\|\s*$", text, re.M):
        num, cell, proves, trig = row.groups()
        link = re.search(r"\]\(([^)]+?)/README\.md\)", cell)
        if not link:
            continue
        pillars.append({
            "num": num.strip(),
            "slug": link.group(1).strip(),
            "title": plain_text(cell),
            "proves": inline_md(proves),
            "trigger": inline_md(trig),
        })
    pillars.sort(key=lambda p: int(p["num"]))
    return hero, pillars


# ----------------------------------------------------------------------------
# parse + convert one demo README.md
# ----------------------------------------------------------------------------
def rewrite_links(htm: str, slugs: set[str]) -> str:
    """Rewrite cross-demo .md links; de-link anything outside the published set."""
    def repl(mobj: re.Match) -> str:
        href = mobj.group(1)
        if href == "../DEMOS.md":
            return 'href="../index.html"'
        m = re.match(r"\.\./([a-z0-9-]+)/README\.md$", href)
        if m and m.group(1) in slugs:
            return f'href="../{m.group(1)}/index.html"'
        if href.endswith(".md"):
            return 'href="#" data-dead="1"'        # outside the site → neutralize
        return mobj.group(0)
    htm = re.sub(r'href="([^"]+)"', repl, htm)
    # drop the neutralized anchors back to plain text
    htm = re.sub(r'<a href="#" data-dead="1">(.*?)</a>', r"\1", htm)
    return htm


def build_demo(slug: str, slugs: set[str], prev: dict | None, nxt: dict | None) -> dict:
    src = SPECS / slug / "README.md"
    raw = src.read_text(encoding="utf-8")
    lines = raw.splitlines()

    # title = first H1
    title = slug
    for i, ln in enumerate(lines):
        if ln.startswith("# "):
            title = ln[2:].strip()
            lines = lines[i + 1:]
            break

    # video: the 🎬 line (or any ](path.mp4) link). capture path + trailing caption.
    video_src, caption = None, ""
    for i, ln in enumerate(lines):
        vm = re.search(r"\]\((video/[^)]+\.mp4)\)", ln)
        if vm:
            video_src = vm.group(1)
            after = ln[vm.end():].lstrip(" —–-")
            caption = re.sub(r"[`*]", "", after).strip() or "Continuous screen recording"
            del lines[i]
            break

    body_md = "\n".join(lines).strip()

    # tagline = first non-empty paragraph; remove it from the body to avoid dupes
    tagline = ""
    parts = re.split(r"\n\s*\n", body_md, maxsplit=1)
    if parts and not parts[0].lstrip().startswith(("#", ">", "|", "![")):
        tagline = inline_md(" ".join(parts[0].split()))
        body_md = parts[1] if len(parts) > 1 else ""

    htm = markdown.markdown(body_md, extensions=MD_EXT)

    # standalone images -> <figure> + <figcaption> (alt text)
    htm = re.sub(
        r"<p>\s*<img alt=\"([^\"]*)\" src=\"(img/[^\"]+)\"\s*/?>\s*</p>",
        lambda m: f'<figure><img src="{m.group(2)}" alt="{m.group(1)}">'
                  + (f"<figcaption>{m.group(1)}</figcaption>" if m.group(1) else "")
                  + "</figure>",
        htm)
    # markdown lib may emit src before alt — handle both orders
    htm = re.sub(
        r"<p>\s*<img src=\"(img/[^\"]+)\" alt=\"([^\"]*)\"\s*/?>\s*</p>",
        lambda m: f'<figure><img src="{m.group(1)}" alt="{m.group(2)}">'
                  + (f"<figcaption>{m.group(2)}</figcaption>" if m.group(2) else "")
                  + "</figure>",
        htm)

    htm = rewrite_links(htm, slugs)

    # fill template
    tpl = (TPL / "demo.html").read_text(encoding="utf-8")
    poster = ""  # could point at img/01-*.png; left empty (preload=metadata shows frame)
    pager = ""
    if prev:
        pager += (f'<a class="prev" href="../{prev["slug"]}/index.html">'
                  f'<span class="dir">← Previous</span>'
                  f'<span class="ttl">{html.escape(prev["title"])}</span></a>')
    else:
        pager += '<span class="empty"></span>'
    if nxt:
        pager += (f'<a class="next" href="../{nxt["slug"]}/index.html">'
                  f'<span class="dir">Next →</span>'
                  f'<span class="ttl">{html.escape(nxt["title"])}</span></a>')
    else:
        pager += '<span class="empty"></span>'

    page = (tpl
            # attribute-safe head fields FIRST (they are substrings of the body ones)
            .replace("<!-- TITLE_ATTR -->", attr_text(title))
            .replace("<!-- TAGLINE_ATTR -->", attr_text(tagline))
            # visible body
            .replace("<!-- TITLE -->", html.escape(title))
            .replace("<!-- TAGLINE -->", tagline)
            .replace("<!-- CRUMB -->", html.escape(title.split("—")[0].strip()))
            .replace("<!-- KICKER -->", "Demo walkthrough")
            .replace("<!-- VIDEO_SRC -->", video_src or "")
            .replace("<!-- VIDEO_POSTER -->", poster)
            .replace("<!-- VIDEO_CAPTION -->", html.escape(caption))
            .replace("<!-- CONTENT -->", htm)
            .replace("<!-- PAGER -->", pager))

    dst = OUT / slug
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "index.html").write_text(page, encoding="utf-8")

    # copy media
    for sub in ("video", "img"):
        s = SPECS / slug / sub
        if s.is_dir():
            shutil.copytree(s, dst / sub, dirs_exist_ok=True)

    return {"slug": slug, "title": title}


# ----------------------------------------------------------------------------
# index page
# ----------------------------------------------------------------------------
def build_index(hero: dict, pillars: list[dict]) -> None:
    tpl = (TPL / "index.html").read_text(encoding="utf-8")

    stats = "".join(f"<span><b>{b}</b><i>{i}</i></span>" for b, i in STATS)

    feature = f'''<a class="feature" href="{hero['slug']}/index.html">
  <span class="badge">★ Hero demo</span>
  <div class="ft-body">
    <h3>{html.escape(hero['title'])}</h3>
    <p>{hero['blurb']}</p>
  </div>
  <span class="go">Watch <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4l4 4-4 4"/></svg></span>
</a>'''

    cards = ""
    for p in pillars:
        cards += f'''<a class="card" href="{p['slug']}/index.html">
  <div class="num"><b>{p['num']}</b> DEMO {p['num'].zfill(2)}</div>
  <h3>{html.escape(p['title'])}</h3>
  <p class="proves">{p['proves']}</p>
  <div class="foot"><span class="trigger">trigger · <code>{p['trigger']}</code></span><span class="arrow">→</span></div>
</a>'''

    page = (tpl
            .replace("<!-- SITE_TAGLINE_ATTR -->", attr_text(SITE_TAGLINE))
            .replace("<!-- SITE_TITLE -->", html.escape(SITE_TITLE))
            .replace("<!-- SITE_TAGLINE -->", SITE_TAGLINE)
            .replace("<!-- SITE_TITLE_DISPLAY -->", SITE_TITLE_DISPLAY)
            .replace("<!-- STATS -->", stats)
            .replace("<!-- FEATURE -->", feature)
            .replace("<!-- CARD_COUNT -->", f"01 — {len(pillars):02d}")
            .replace("<!-- CARDS -->", cards)
            .replace("<!-- FOOTER_NOTE -->", FOOTER_NOTE))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.html").write_text(page, encoding="utf-8")


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    hero, pillars = parse_index()
    order = [hero] + pillars                      # hero first, then pillars 1..N
    slugs = {d["slug"] for d in order}
    built = []
    for i, d in enumerate(order):
        prev = order[i - 1] if i > 0 else None
        nxt = order[i + 1] if i + 1 < len(order) else None
        built.append(build_demo(d["slug"], slugs, prev, nxt))
        print(f"  built {d['slug']}/index.html")
    build_index(hero, pillars)
    print(f"  built index.html ({len(pillars)} pillars + hero)")
    print(f"✓ {len(built) + 1} pages → {OUT.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
