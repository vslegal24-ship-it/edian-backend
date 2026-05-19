const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role key (no RLS)
);
const JWT_SECRET = process.env.JWT_SECRET || 'edian_jwt_secret_2025';

// ── Helpers ─────────────────────────────────────────────────
async function getUsuario(email) {
  const { data, error } = await supabase
    .from('edian_usuarios')
    .select('*, plan:edian_planes(*)')
    .eq('email', email.toLowerCase())
    .single();
  return error ? null : data;
}

async function contarConsultasHoy(userId) {
  const hoy = new Date().toISOString().split('T')[0];
  const { count } = await supabase
    .from('edian_consultas')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', userId)
    .eq('fecha_utc', hoy);
  return count || 0;
}

// ── GET /api/auth/ping (diagnóstico) ────────────────────────
router.get('/ping', (req, res) => {
  res.json({ ok: true, msg: 'auth router funcionando', env: {
    supabase: !!process.env.SUPABASE_URL,
    jwt: !!process.env.JWT_SECRET,
    serviceKey: !!process.env.SUPABASE_SERVICE_KEY,
  }});
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const usuario = await getUsuario(email);
    if (!usuario) {
      console.log('[AUTH] Usuario no encontrado:', email);
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    if (!usuario.activo) {
      console.log('[AUTH] Usuario inactivo:', email);
      return res.status(403).json({ error: 'Cuenta inactiva' });
    }

    // Verificar contraseña
    console.log('[AUTH] Comparando password para:', email, '| hash:', usuario.password_hash.substring(0,10));
    const ok = await bcrypt.compare(password, usuario.password_hash);
    console.log('[AUTH] Password match:', ok);
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

    // Verificar vencimiento
    if (usuario.fecha_vence && new Date(usuario.fecha_vence) < new Date()) {
      return res.status(403).json({ error: 'Plan vencido. Renueva tu suscripción para continuar.' });
    }

    // Consultas hoy
    const consultasHoy = await contarConsultasHoy(usuario.id);

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, rol: usuario.rol, plan: usuario.plan_id },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      ok: true,
      token,
      usuario: {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: usuario.rol,
        plan: usuario.plan,
        nitsAsignados: usuario.nits_asignados || [],
        consultasRegalo: usuario.consultas_regalo || 0,
        consultasHoy,
        fechaVence: usuario.fecha_vence,
      }
    });
  } catch(e) {
    console.error('[AUTH] login error:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/auth/verificar ─────────────────────────────────
router.post('/verificar', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Sin token' });
    const payload = jwt.verify(token, JWT_SECRET);
    const usuario = await getUsuario(payload.email);
    if (!usuario || !usuario.activo) return res.status(401).json({ error: 'Sesión inválida' });
    const consultasHoy = await contarConsultasHoy(usuario.id);
    res.json({ ok: true, usuario: { ...usuario, consultasHoy } });
  } catch(e) {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

// ── POST /api/auth/registro ──────────────────────────────────
router.post('/registro', async (req, res) => {
  try {
    const { email, password, nombre, telefono, rol = 'empresa' } = req.body;
    if (!email || !password || !nombre) return res.status(400).json({ error: 'Datos incompletos' });

    const existe = await getUsuario(email);
    if (existe) return res.status(409).json({ error: 'El email ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('edian_usuarios').insert({
      email: email.toLowerCase(),
      password_hash: hash,
      nombre, telefono, rol,
      plan_id: 'free',
      activo: true,  // prueba gratis activa inmediatamente
      consultas_regalo: 1, // 1 consulta gratis
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, mensaje: 'Cuenta creada. Tienes 1 consulta gratuita disponible.' });
  } catch(e) {
    res.status(500).json({ error: 'Error creando cuenta' });
  }
});

// ── GET /api/auth/usuarios (solo admin) ─────────────────────
router.get('/usuarios', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('edian_usuarios')
    .select('*, plan:edian_planes(nombre,tipo,precio_mes), consultas_count:edian_consultas(count)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, usuarios: data });
});

// ── PUT /api/auth/usuarios/:id (solo admin) ──────────────────
router.put('/usuarios/:id', requireAdmin, async (req, res) => {
  const { activo, plan_id, fecha_vence, nits_asignados, consultas_regalo, password } = req.body;
  const updates = {};
  if (activo !== undefined) updates.activo = activo;
  if (plan_id) updates.plan_id = plan_id;
  if (fecha_vence) updates.fecha_vence = fecha_vence;
  if (nits_asignados) updates.nits_asignados = nits_asignados;
  if (consultas_regalo !== undefined) updates.consultas_regalo = consultas_regalo;
  if (password) updates.password_hash = await bcrypt.hash(password, 10);
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase.from('edian_usuarios').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── DELETE /api/auth/usuarios/:id (solo admin) ───────────────
router.delete('/usuarios/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('edian_usuarios')
    .update({ activo: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── GET /api/auth/stats (admin) ──────────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  const [usuarios, pagos, consultasHoy] = await Promise.all([
    supabase.from('edian_usuarios').select('id,rol,plan_id,activo', { count: 'exact' }),
    supabase.from('edian_pagos').select('monto,estado,created_at').eq('estado','aprobado'),
    supabase.from('edian_consultas').select('id', { count: 'exact', head: true })
      .eq('fecha_utc', new Date().toISOString().split('T')[0]),
  ]);
  const totalPagos = (pagos.data||[]).reduce((s,p) => s + (p.monto||0), 0);
  res.json({
    ok: true,
    totalUsuarios: usuarios.count || 0,
    usuariosActivos: (usuarios.data||[]).filter(u => u.activo).length,
    totalRecaudado: totalPagos,
    consultasHoy: consultasHoy.count || 0,
  });
});

// ── GET /api/auth/planes ─────────────────────────────────────
router.get('/planes', async (req, res) => {
  const { data } = await supabase.from('edian_planes').select('*').eq('activo', true).order('precio_mes');
  res.json({ ok: true, planes: data || [] });
});

// ── Middleware ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.rol !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    req.usuario = payload;
    next();
  } catch(e) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

module.exports = router;
module.exports.requireToken = function(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Sin autenticación' });
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Token inválido' });
  }
};
