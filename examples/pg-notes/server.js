// Tiny notes API — demonstrates postgres = true (DATABASE_URL is injected by
// slab) together with scale-to-zero: the container can sleep between
// requests, but the notes persist because they live in postgres, not here.
const http = require('http')
const { Pool } = require('pg')

const PORT = process.env.PORT ?? 3000
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id serial primary key,
      body text not null,
      created_at timestamptz default now()
    )
  `)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  try {
    if (req.method === 'GET' && req.url === '/') {
      const { rows } = await pool.query(
        'SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 20'
      )
      sendJson(res, 200, { app: 'pg-notes', notes: rows })
      return
    }

    if (req.method === 'POST' && req.url === '/') {
      const body = (await readBody(req)).trim()
      if (!body) {
        sendJson(res, 400, { error: 'request body is empty' })
        return
      }
      const { rows } = await pool.query(
        'INSERT INTO notes (body) VALUES ($1) RETURNING id',
        [body]
      )
      sendJson(res, 201, { id: rows[0].id })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    // Never crash on a DB error — report it and keep serving.
    sendJson(res, 500, { error: err.message })
  }
})

ensureSchema()
  .catch((err) => console.error('schema init failed:', err.message))
  .finally(() => {
    server.listen(PORT, () => console.log(`pg-notes listening on ${PORT}`))
  })
