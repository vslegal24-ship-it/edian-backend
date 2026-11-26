// ── Ruta Empresas ── memoria por empresa (credenciales Siigo cifradas + config)
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SIIGO = 'https://api.siigo.com';

// ── Cifrado AES-256-GCM de la Access Key ──
function keyBuf() {
  const raw = (process.env.SIIGO_ENC_KEY || '').trim();
  if (!raw) throw new Error('Falta configurar SIIGO_ENC_KEY en el servidor.');
  // Deriva una clave de 32 bytes de cualquier valor (robusto ante formato/espacios)
  return crypto.createHash('sha256').update(raw).digest();
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf(), iv);
  const enc = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function descifrar(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// Verifica credenciales contra Siigo (devuelve true/throw)
async function verificarSiigo(usuario, accessKey, partnerId) {
  const r = await fetch(`${SIIGO}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Partner-Id': partnerId || 'EDIAN' },
    body: JSON.stringify({ username: usuario, access_key: accessKey }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    const e = new Error(data.message || 'Credenciales Siigo inválidas'); e.httpStatus = r.status; throw e;
  }
  return true;
}

// Helper exportado: credenciales descifradas de una empresa (para siigo.js)
async function getCredenciales(empresaId) {
  const { data, error } = await supabase.from('edian_empresas')
    .select('siigo_usuario, siigo_access_key_enc, siigo_partner_id')
    .eq('id', empresaId).single();
  if (error || !data) throw new Error('Empresa no encontrada');
  return {
    usuario: data.siigo_usuario,
    accessKey: descifrar(data.siigo_access_key_enc),
    partnerId: data.siigo_partner_id,
  };
}

// ── POST /api/empresas/guardar ──
// body: { usuario, accessKey, partnerId, nombre?, nit?, dv?, usuario_id?, medio_pago_id?, comprobante_fc_id?, crear_terceros?, sugerir_retenciones? }
router.post('/guardar', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.usuario || !b.accessKey) return res.status(400).json({ ok: false, message: 'Faltan usuario (correo) y Access Key.' });

    // 1) Validar contra Siigo antes de guardar
    try { await verificarSiigo(b.usuario, b.accessKey, b.partnerId); }
    catch (e) { return res.status(200).json({ ok: false, step: 'auth', message: 'No autenticó en Siigo: ' + e.message }); }

    // 2) Armar fila (cifrando la access key)
    const fila = {
      usuario_id: b.usuario_id || null,
      nit: b.nit || null,
      dv: b.dv || null,
      nombre: b.nombre || b.usuario,
      siigo_usuario: b.usuario,
      siigo_access_key_enc: cifrar(b.accessKey),
      siigo_partner_id: (b.partnerId || '').replace(/\s+/g, ''),
      comprobante_fc_id: b.comprobante_fc_id || 41509,
      medio_pago_id: b.medio_pago_id || null,
      crear_terceros: b.crear_terceros !== false,
      sugerir_retenciones: b.sugerir_retenciones !== false,
    };

    // 3) Upsert manual por siigo_usuario
    const { data: existe } = await supabase.from('edian_empresas')
      .select('id').eq('siigo_usuario', b.usuario).maybeSingle();

    let row;
    if (existe && existe.id) {
      const { data, error } = await supabase.from('edian_empresas')
        .update(fila).eq('id', existe.id).select('id, nit, nombre').single();
      if (error) throw error; row = data;
    } else {
      const { data, error } = await supabase.from('edian_empresas')
        .insert(fila).select('id, nit, nombre').single();
      if (error) throw error; row = data;
    }

    res.json({ ok: true, mensaje: '✅ Empresa guardada. La credencial quedó cifrada.', empresa: row });
  } catch (e) {
    console.error('[EMPRESAS] guardar:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/empresas ── lista (SIN exponer la access key) ──
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('edian_empresas')
      .select('id, nit, nombre, siigo_usuario, siigo_partner_id, comprobante_fc_id, medio_pago_id, crear_terceros, sugerir_retenciones, last_puc_sync, last_aux_sync, activo, created_at')
      .eq('activo', true).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, empresas: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── DELETE /api/empresas/:id ── (desactiva) ──
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('edian_empresas').update({ activo: false }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── GET /api/empresas/diag ── diagnóstico (no expone valores) ──
router.get('/diag', (req, res) => {
  const v = process.env.SIIGO_ENC_KEY || '';
  res.json({
    ok: true,
    enc_present: !!v.trim(),
    enc_len: v.length,
    claves_relacionadas: Object.keys(process.env).filter(k => /siigo|enc/i.test(k)),
    supabase_url: !!process.env.SUPABASE_URL,
    supabase_key: !!process.env.SUPABASE_SERVICE_KEY,
  });
});

module.exports = router;
module.exports.getCredenciales = getCredenciales;
module.exports.cifrar = cifrar;
module.exports.descifrar = descifrar;
