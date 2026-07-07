// Minimal control-plane UI, served by the daemon at GET / (port 7766).
// Zero build step, zero deps: one static page that drives the JSON API.

export function dashboardHtml(proxyPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>slab</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0f14; color: #d7dde4; padding: 32px; }
  h1 { font-size: 18px; letter-spacing: 2px; margin-bottom: 4px; }
  .sub { color: #5b6672; font-size: 12px; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; color: #5b6672; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding: 6px 14px 6px 0; border-bottom: 1px solid #1c2530; }
  td { padding: 10px 14px 10px 0; border-bottom: 1px solid #141b23; vertical-align: top; }
  a { color: #6cb6ff; text-decoration: none; }
  .state { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; }
  .running { background: #0c2b1c; color: #4ade80; }
  .sleeping { background: #1e2433; color: #93a4c8; }
  .stopped, .created { background: #252a31; color: #8b96a1; }
  .error, .building { background: #331b1b; color: #f87171; }
  .building { background: #33301b; color: #facc15; }
  button { background: #141b23; color: #d7dde4; border: 1px solid #263140; border-radius: 5px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; margin-right: 6px; }
  button:hover { border-color: #6cb6ff; }
  pre { background: #05070a; border: 1px solid #141b23; border-radius: 6px; padding: 12px; margin-top: 16px; max-height: 320px; overflow: auto; font-size: 12px; white-space: pre-wrap; display: none; }
  .type { color: #5b6672; font-size: 12px; }
  .err { color: #f87171; font-size: 12px; }
</style>
</head>
<body>
<h1>SLAB</h1>
<div class="sub">localhost hyperscaler — proxy :${proxyPort}</div>
<table>
  <thead><tr><th>app</th><th>type</th><th>state</th><th>url</th><th>deployed</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<pre id="logs"></pre>
<script>
const logsEl = document.getElementById('logs')
async function act(name, verb) {
  await fetch('/v1/apps/' + name + '/' + verb, { method: 'POST' })
  load()
}
async function showLogs(name) {
  const r = await fetch('/v1/apps/' + name + '/logs?tail=200')
  const d = await r.json()
  logsEl.textContent = '── logs: ' + name + ' ──\\n' + (d.logs ?? d.error ?? '')
  logsEl.style.display = 'block'
}
function rel(iso) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}
async function load() {
  const r = await fetch('/v1/apps')
  const d = await r.json()
  document.getElementById('rows').innerHTML = (d.apps ?? []).map(a => {
    const url = 'http://' + a.name + '.localhost:${proxyPort}'
    return '<tr><td>' + a.name + '</td>'
      + '<td class="type">' + a.manifest.type + (a.manifest.image ? ' · ' + a.manifest.image : '') + '</td>'
      + '<td><span class="state ' + a.state + '">' + a.state + '</span>'
      + (a.error ? '<div class="err">' + a.error.slice(0, 120) + '</div>' : '') + '</td>'
      + '<td><a href="' + url + '" target="_blank">' + a.name + '.localhost</a>'
      + (a.publicUrl ? '<br><a href="' + a.publicUrl + '" target="_blank">' + a.publicUrl.replace('https://','') + '</a>' : '') + '</td>'
      + '<td>' + rel(a.deployedAt) + '</td>'
      + '<td>'
      + '<button onclick="act(\\'' + a.name + '\\',\\'deploy\\')">deploy</button>'
      + (a.state === 'running'
          ? '<button onclick="act(\\'' + a.name + '\\',\\'stop\\')">stop</button>'
          : '<button onclick="act(\\'' + a.name + '\\',\\'start\\')">start</button>')
      + '<button onclick="showLogs(\\'' + a.name + '\\')">logs</button>'
      + (a.exposed
          ? '<button onclick="act(\\'' + a.name + '\\',\\'hide\\')">hide</button>'
          : '<button onclick="act(\\'' + a.name + '\\',\\'expose\\')">expose</button>')
      + '</td></tr>'
  }).join('') || '<tr><td colspan="6" style="color:#5b6672">no apps — slab deploy ./yourapp</td></tr>'
}
load()
setInterval(load, 5000)
</script>
</body>
</html>`
}
