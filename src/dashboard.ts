// Control-plane UI, served by the daemon at GET / (port 7766).
// Zero build step, zero deps, system fonts only. Design notes:
// warm graphite palette (not blue-black), conventional status colors,
// one signature: breathing LED per running app + tiled SLAB wordmark.

export function dashboardHtml(proxyPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>slab</title>
<style>
  :root {
    --bg: #17181c; --surface: #1e2025; --raise: #24262c; --line: #2c2f36;
    --text: #e9e7e2; --dim: #93969e; --faint: #5d6067;
    --amber: #ffb454; --green: #6fd18b; --red: #f07f78; --blue: #7fb5e8;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--bg); color: var(--text);
    padding: clamp(20px, 4vw, 48px); max-width: 1060px; margin: 0 auto;
  }
  /* wordmark: four cut tiles */
  .mark { display: flex; gap: 5px; margin-bottom: 6px; }
  .mark span {
    display: grid; place-items: center; width: 34px; height: 34px;
    background: var(--raise); border: 1px solid var(--line); border-radius: 4px;
    font-weight: 700; font-size: 15px; letter-spacing: 0;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 2px 4px rgba(0,0,0,.35);
  }
  .mark span:first-child { background: var(--amber); color: #221a0c; border-color: var(--amber); }
  .meta { color: var(--faint); font-size: 12px; margin-bottom: 36px; }
  .meta b { color: var(--dim); font-weight: 500; }

  table { border-collapse: collapse; width: 100%; }
  th {
    text-align: left; font-weight: 500; font-size: 10px; text-transform: uppercase;
    letter-spacing: .14em; color: var(--faint); padding: 0 16px 10px 0;
    border-bottom: 1px solid var(--line);
  }
  th.num, td.num { text-align: right; }
  td { padding: 14px 16px 14px 0; border-bottom: 1px solid #202228; vertical-align: middle; }
  tr:hover td { background: linear-gradient(90deg, transparent, rgba(255,180,84,.02)); }

  .app { font-weight: 700; font-size: 14px; }
  .kind { color: var(--faint); font-size: 11px; margin-top: 1px; }

  .led { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
  .running .led { background: var(--green); box-shadow: 0 0 6px var(--green); animation: breathe 2.6s ease-in-out infinite; }
  .sleeping .led { background: var(--blue); opacity: .7; }
  .stopped .led, .created .led { background: var(--faint); }
  .error .led { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .building .led { background: var(--amber); animation: breathe 1s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: .35; box-shadow: none; } }
  @media (prefers-reduced-motion: reduce) { .led { animation: none !important; } }
  .statename { color: var(--dim); font-size: 12px; }
  .errmsg { color: var(--red); font-size: 11px; max-width: 220px; margin-top: 3px; }

  a { color: var(--blue); text-decoration: none; }
  a:hover, a:focus-visible { text-decoration: underline; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
  .public { color: var(--amber); font-size: 12px; display: block; margin-top: 2px; }
  .rpm { color: var(--dim); }
  .rpm.hot { color: var(--text); }
  .rpm small { color: var(--faint); }

  .acts { white-space: nowrap; opacity: .25; transition: opacity .15s; text-align: right; }
  tr:hover .acts, .acts:focus-within { opacity: 1; }
  button {
    background: none; color: var(--dim); border: 1px solid var(--line); border-radius: 4px;
    padding: 4px 10px; font: inherit; font-size: 11px; cursor: pointer; margin-left: 6px;
  }
  button:hover { color: var(--text); border-color: var(--faint); }
  button.warn:hover { color: var(--red); border-color: var(--red); }

  .empty { color: var(--faint); padding: 48px 0; }
  .empty code { color: var(--amber); }

  #drawer {
    position: fixed; left: 0; right: 0; bottom: 0; max-height: 42vh; display: none;
    background: #101114; border-top: 1px solid var(--line); padding: 14px clamp(20px, 4vw, 48px);
    overflow: auto; font-size: 12px; white-space: pre-wrap; box-shadow: 0 -12px 32px rgba(0,0,0,.5);
  }
  #drawer .bar { display: flex; justify-content: space-between; color: var(--faint); font-size: 11px;
    text-transform: uppercase; letter-spacing: .14em; margin-bottom: 10px; position: sticky; top: 0; }
  #drawer .bar button { margin: 0; }
</style>
</head>
<body>
<div class="mark"><span>S</span><span>L</span><span>A</span><span>B</span></div>
<div class="meta">localhost hyperscaler · ingress <b>:${proxyPort}</b> · api <b>:7766</b> · <b id="count">–</b> apps</div>
<table>
  <thead><tr><th>app</th><th>state</th><th>routes</th><th class="num">req/min</th><th>deployed</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<div id="drawer"><div class="bar"><span id="dtitle"></span><button onclick="drawer.style.display='none'">close</button></div><div id="dbody"></div></div>
<script>
const drawer = document.getElementById('drawer')
async function act(name, verb) {
  await fetch('/v1/apps/' + name + '/' + verb, { method: 'POST' })
  load()
}
async function showLogs(name) {
  const r = await fetch('/v1/apps/' + name + '/logs?tail=200')
  const d = await r.json()
  document.getElementById('dtitle').textContent = 'logs — ' + name
  document.getElementById('dbody').textContent = d.logs ?? d.error ?? ''
  drawer.style.display = 'block'
  drawer.scrollTop = drawer.scrollHeight
}
function rel(iso) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') }
async function load() {
  const r = await fetch('/v1/apps')
  const d = await r.json()
  const apps = d.apps ?? []
  document.getElementById('count').textContent = apps.length
  document.getElementById('rows').innerHTML = apps.map(a => {
    const url = 'http://' + a.name + '.localhost:${proxyPort}'
    const rpm = a.reqPerMin ?? 0
    return '<tr class="' + a.state + '">'
      + '<td><div class="app">' + esc(a.name) + '</div><div class="kind">'
      + a.manifest.type + (a.manifest.image ? ' · ' + esc(a.manifest.image) : ' · dockerfile')
      + (a.manifest.postgres ? ' · pg' : '') + '</div></td>'
      + '<td><span class="led"></span><span class="statename">' + a.state + '</span>'
      + (a.error ? '<div class="errmsg">' + esc(a.error.slice(0, 100)) + '</div>' : '') + '</td>'
      + '<td><a href="' + url + '" target="_blank">' + esc(a.name) + '.localhost</a>'
      + (a.publicUrl ? '<a class="public" href="' + esc(a.publicUrl) + '" target="_blank">' + esc(a.publicUrl.replace('https://', '')) + '</a>' : '')
      + '</td>'
      + '<td class="num"><span class="rpm' + (rpm > 0 ? ' hot' : '') + '">' + rpm + '<small>/m</small></span></td>'
      + '<td>' + rel(a.deployedAt) + '</td>'
      + '<td class="acts">'
      + '<button onclick="act(\\'' + a.name + '\\',\\'deploy\\')">deploy</button>'
      + (a.state === 'running'
          ? '<button class="warn" onclick="act(\\'' + a.name + '\\',\\'stop\\')">stop</button>'
          : '<button onclick="act(\\'' + a.name + '\\',\\'start\\')">start</button>')
      + '<button onclick="showLogs(\\'' + a.name + '\\')">logs</button>'
      + (a.exposed
          ? '<button class="warn" onclick="act(\\'' + a.name + '\\',\\'hide\\')">hide</button>'
          : '<button onclick="act(\\'' + a.name + '\\',\\'expose\\')">expose</button>')
      + '</td></tr>'
  }).join('') || '<tr><td colspan="6" class="empty">nothing deployed — <code>slab deploy ./yourapp</code> to add the first tenant</td></tr>'
}
load()
setInterval(load, 5000)
</script>
</body>
</html>`
}
