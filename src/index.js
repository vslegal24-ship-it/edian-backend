require('dotenv').config();
const express    = require('express');
const http       = require('http');
const dianRoutes  = require('./routes/dian');
const fase2Routes = require('./routes/fase2');
const authRoutes  = require('./routes/auth');
const boldRoutes  = require('./routes/bold');
const nitRoutes   = require('./routes/nit');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(204);
});

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Health check ────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'EDIAN Backend', version: '1.0.0', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Rutas ───────────────────────────────────────────────────
app.use('/api/dian',  dianRoutes);
app.use('/api/fase2', fase2Routes);
app.use('/api/auth',  authRoutes);
app.use('/api/bold',  boldRoutes);
app.use('/api/nit',   nitRoutes);

// ── Error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

// ── Start con HTTP/1.1 explícito ────────────────────────────
const server = http.createServer(app);

// Forzar HTTP/1.1 — evita ERR_HTTP2_PROTOCOL_ERROR en Railway
server.on('connection', (socket) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
});

server.timeout = 600000;        // 10 minutos
server.keepAliveTimeout = 620000;
server.headersTimeout = 620000;
server.requestTimeout = 600000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ EDIAN Backend corriendo en puerto ${PORT}`);
});

module.exports = app;
