// ── Ruta Solicitudes ── "Inicia tu prueba": registro público → aprobación admin
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'edian_jwt_secret_2025';

function soloDigitos(s) { return String(s || '').replace(/\D/g, ''); }

function userFromReq(req) {
  try { const t = (req.headers.authorization || '').replace('Bearer ', ''); return t ? jwt.verify(t, JWT_SECRET) : null; }
  catch (e) { return null; }
}
function requireAdmin(req, res, next) {
  const u = userFromReq(req);
  if (!u || u.rol !== 'admin') return res.status(403).json({ ok: false, message: 'Solo administradores' });
  req.usuario = u; next();
}

// ── POST /api/solicitudes ── (público) crea una solicitud de prueba ──
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = (b.nombre || '').trim();
    const email  = (b.email  || '').trim().toLowerCase();
    const empresa_nombre = (b.empresa_nombre || b.empresa || '').trim();
    const nit = soloDigitos(b.nit);
    if (!nombre || !email || !empresa_nombre || !nit) {
      return res.status(400).json({ ok: false, message: 'Faltan datos: nombre, correo, empresa y NIT son obligatorios.' });
    }

    // Si ya existe un usuario con ese correo, no dejar duplicar cuenta
    const { data: yaExiste } = await supabase.from('edian_usuarios').select('id').eq('email', email).maybeSingle();
    if (yaExiste) return res.status(200).json({ ok: false, message: 'Ese correo ya tiene una cuenta. Inicia sesión.' });

    const { data, error } = await supabase.from('edian_solicitudes').insert({
      nombre, email, telefono: (b.telefono || '').trim(),
      empresa_nombre, nit, mensaje: (b.mensaje || '').trim(), estado: 'pendiente',
    }).select('id').single();
    if (error) throw error;

    res.json({ ok: true, id: data.id, mensaje: 'Solicitud enviada. Un administrador activará tu prueba muy pronto.' });
  } catch (e) {
    console.error('[SOLICITUDES] crear:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/solicitudes ── (admin) lista; ?estado=pendiente por defecto ──
router.get('/', requireAdmin, async (req, res) => {
  try {
    let q = supabase.from('edian_solicitudes').select('*').order('created_at', { ascending: false });
    const estado = req.query.estado;
    if (estado && estado !== 'todas') q = q.eq('estado', estado);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, solicitudes: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/solicitudes/:id/aprobar ── (admin) crea usuario demo + empresa y la asigna ──
router.post('/:id/aprobar', requireAdmin, async (req, res) => {
  try {
    const { data: sol, error: e0 } = await supabase.from('edian_solicitudes').select('*').eq('id', req.params.id).single();
    if (e0 || !sol) return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
    if (sol.estado === 'aprobada') return res.status(200).json({ ok: false, message: 'Esta solicitud ya fue aprobada.' });

    // Contraseña temporal (el admin se la pasa al cliente; el backend solo guarda el hash)
    const passTemp = (req.body && req.body.password) || ('edian' + Math.random().toString(36).slice(2, 8));
    const hash = await bcrypt.hash(passTemp, 10);

    // 1) Usuario demo
    const { data: user, error: e1 } = await supabase.from('edian_usuarios').insert({
      email: sol.email,
      password_hash: hash,
      nombre: sol.nombre,
      telefono: sol.telefono,
      rol: 'demo',
      plan_id: 'free',
      activo: true,
      limite_empresas: 1,
      demo_usado: false,
      modulos: ['proceso'],        // la prueba solo puede procesar
    }).select('id').single();
    if (e1) {
      if (String(e1.message).includes('duplicate')) return res.status(200).json({ ok: false, message: 'Ya existe un usuario con ese correo.' });
      throw e1;
    }

    // 2) Empresa con su NIT, asignada al usuario demo
    const { data: emp, error: e2 } = await supabase.from('edian_empresas').insert({
      usuario_id: user.id,
      nombre: sol.empresa_nombre,
      nit: soloDigitos(sol.nit),
      activo: true,
    }).select('id').single();
    if (e2) console.error('[SOLICITUDES] empresa:', e2.message);

    // 3) Marcar la solicitud
    await supabase.from('edian_solicitudes').update({
      estado: 'aprobada', usuario_creado_id: user.id, empresa_creada_id: emp ? emp.id : null,
      updated_at: new Date().toISOString(),
    }).eq('id', sol.id);

    res.json({
      ok: true,
      mensaje: '✅ Prueba activada.',
      credenciales: { email: sol.email, password: passTemp },  // para que el admin se las entregue
    });
  } catch (e) {
    console.error('[SOLICITUDES] aprobar:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/solicitudes/:id/rechazar ── (admin) ──
router.post('/:id/rechazar', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('edian_solicitudes')
      .update({ estado: 'rechazada', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
