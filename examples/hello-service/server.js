// Minimal always-on service — no npm deps, just Node's http module.
const http = require('http')
const os = require('os')

const PORT = process.env.PORT ?? 3000
const started = Date.now()

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    app: 'hello-service',
    uptime: (Date.now() - started) / 1000,
    hostname: os.hostname(),
    greeting: process.env.GREETING ?? 'hello from slab',
  }))
})

server.listen(PORT, () => console.log(`hello-service listening on ${PORT}`))
