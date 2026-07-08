# skins — restyle the dashboard

The dashboard is one self-contained HTML page whose entire look is driven by
CSS custom properties plus a `data-skin` attribute on `<html>`. A skin is
just a CSS file.

## built-ins

- **stereo** (default) — the hi-fi rack: machined units, VU meters, LED
  ladders, wood cheeks, the audio monitor deck.
- **hyperscaler** — flat ops console: the hardware decoration is stripped
  (no vents, meters, glow, or audio deck), dense rows, cool blue accent.

Both compose with the light/dark toggle (◐ in the header). Switch skins in
**settings** (footer) — the choice is saved per browser (`localStorage`).

## custom skins

Drop a CSS file in `~/.slab/skins/<name>.css` (lowercase letters, digits,
hyphens). It appears in settings immediately; selecting it loads it **over
the stereo baseline** — start from the rack and restyle from there. Try the
example: `cp examples/skins/phosphor.css ~/.slab/skins/`.

While designing, keep the file open and re-select the skin (or reload) to
see changes; the daemon serves the file fresh on every request.

## the contract

### palette variables (set these first)

| var | role |
|---|---|
| `--bg` / `--rail` | page background / rack rail behind units |
| `--text` / `--dim` / `--faint` | three text intensities |
| `--accent` | the brand color: nameplates, needles, hot buttons (user-overridable in settings) |
| `--green` `--red` `--blue` `--amber` | status colors (running / error / sleeping; amber defaults to accent) |
| `--unit1..4` | faceplate gradient stops (use one value for a flat look) |
| `--cab-hi` / `--cab-lo` / `--cheek` | cabinet body gradient + side rails |
| `--edge` `--edge2` `--edge3` `--line` | borders, strong → hairline |
| `--groove` `--od` `--node` | inset shadows/screws · idle status dot · diagram node fill |
| `--drawer-bg` `--scrim` `--btn-bg` | logs/settings drawer · overlay backdrop · button fill |
| `--board` `--trace` | PCB back-face (dark glass by default) |

### structural hooks

Your skin's name is stamped on the root: `html[data-skin="<name>"]`, so you
can scope rules or just override globally (your file loads last and wins
ties). Useful targets, all stable class names:

`.cabinet` `.rack` `.vents` `.cabmark` — cabinet chrome ·
`.unit` `.plate` `.pwr` `.sled` `.vu` `.lcd` `.thumb` — rack units ·
`.deck` `#viz` — audio monitor · `.jobdeck` `.jobrow` — job bench ·
`.otile` — overview tiles · `.board` `.chip` — flipped boards ·
`#drawer` `#newbay` `#bench-panel` — drawer, empty bay, workbench.

Hiding hardware is legitimate skinning: `hyperscaler` is mostly
`display: none` on `.vents`, `.vu`, `.sled`, `.deck` plus a flat palette.

### light/dark

The theme toggle stamps `html[data-theme="light"|"dark"]` independently of
the skin. Support both with
`:root[data-skin="<name>"][data-theme="light"] { ... }` overrides, or pin
one look by setting your variables on both selectors.
