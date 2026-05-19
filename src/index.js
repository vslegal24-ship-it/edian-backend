require('dotenv').config();
const express = require('express');
const cors = require('cors');

const dianRoutes  = require('./routes/dian');
const fase2Routes = require('./routes/fase2');
const authRoutes  = require('./routes/auth');
const boldRoutes  = require('./routes/bold');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────
const allowedOrigins = [
  'https://milkomercios.in',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : []),
];

app.use(cors({
  origin: function(origin, callback) {
    // Permitir sin origin (Postman, curl, same-origin)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // En desarrollo permitir todo
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    callback(new Error('CORS: origen no permitido: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
// Responder preflight OPTIONS
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Health check ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'EDIAN Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Rutas ───────────────────────────────────────────────────
app.use('/api/dian',  dianRoutes);
app.use('/api/fase2', fase2Routes);
app.use('/api/auth',  authRoutes);
app.use('/api/bold',  boldRoutes);

// ── Error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ EDIAN Backend corriendo en puerto ${PORT}`);
});

module.exports = app;
