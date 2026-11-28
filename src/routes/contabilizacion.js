// ── Ruta Contabilización automática — cruce DIAN vs contabilidad por empresa ──
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'edian_jwt_secret_2025';

function userFromReq(req) {
  try { const t = (req.headers.authorization || '').replace('Bearer ', ''); return t ? jwt.verify(t, JWT_SECRET) : null; }
  catch (e) { return null; }
}
async function empresaPermitida(user, empresaId) {
  if (!user) return false;
  if (user.rol === 'admin') return true;
  if (!empresaId) return false;
  const { data } = await supabase.from('edian_empresas').select('id').eq('id', empresaId).eq('usuario_id', user.id).maybeSingle();
  return !!data;
}

// GET /api/contabilizacion?empresa=<id>
router.get('/', async (req, res) => {
  try {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ ok: false, message: 'Inicia sesión.' });
    const empresa = req.query.empresa || null;
    if (!(await empresaPermitida(user, empresa))) return res.status(403).json({ ok: false, message: 'Empresa no válida.' });
    const { data, error } = await supabase.from('edian_cont_docs').select('*').eq('empresa_id', empresa).order('total', { ascending: false });
    if (error) throw error;
    const docs = data || [];
    const resumen = { causado: 0, por_causar: 0, revisar: 0 };
    docs.forEach(d => { if (resumen[d.estado] != null) resumen[d.estado]++; });
    res.json({ ok: true, resumen, docs });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// POST /api/contabilizacion/guardar  { empresa_id, docs:[...] }
router.post('/guardar', async (req, res) => {
  try {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ ok: false, message: 'Inicia sesión.' });
    const b = req.body || {};
    if (!(await empresaPermitida(user, b.empresa_id))) return res.status(403).json({ ok: false, message: 'Empresa no válida.' });
    const docs = Array.isArray(b.docs) ? b.docs : [];
    if (!docs.length) return res.status(400).json({ ok: false, message: 'No hay documentos para guardar.' });

    // Reemplaza el cruce anterior de esa empresa
    await supabase.from('edian_cont_docs').delete().eq('empresa_id', b.empresa_id);

    const filas = docs.slice(0, 20000).map(d => ({
      empresa_id: b.empresa_id,
      grupo: d.grupo || null,
      folio: String(d.folio || '').slice(0, 60),
      nit: String(d.nit || '').slice(0, 30),
      nombre: String(d.nombre || '').slice(0, 200),
      subtotal: Number(d.subtotal) || 0,
      iva: Number(d.iva) || 0,
      total: Number(d.total) || 0,
      estado: ['causado', 'por_causar', 'revisar'].includes(d.estado) ? d.estado : 'revisar',
    }));
    for (let i = 0; i < filas.length; i += 500) {
      const { error } = await supabase.from('edian_cont_docs').insert(filas.slice(i, i + 500));
      if (error) throw error;
    }
    const resumen = { causado: 0, por_causar: 0, revisar: 0 };
    filas.forEach(f => resumen[f.estado]++);
    res.json({ ok: true, guardados: filas.length, resumen });
  } catch (e) {
    console.error('[CONTABILIZACION] guardar:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
