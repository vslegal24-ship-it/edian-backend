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
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
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
