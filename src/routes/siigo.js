// ── Ruta Siigo API ── probador / integración ──
// Recibe credenciales por request (por ahora no se persisten), autentica contra
// Siigo y consulta recursos para mostrar "qué trae" cada empresa.
const express = require('express');
const router  = express.Router();

const SIIGO = 'https://api.siigo.com';

// Recursos de solo lectura que exponemos en el probador
const RECURSOS = {
  terceros:     { path: '/v1/customers?page_size=5',          label: 'Terceros (clientes/proveedores)' },
  cuentas:      { path: '/v1/account-groups',                 label: 'Plan de cuentas (grupos)' },
  centros:      { path: '/v1/cost-centers',                   label: 'Centros de costo' },
  impuestos:    { path: '/v1/taxes',                          label: 'Impuestos' },
  pagos:        { path: '/v1/payment-types?document_type=FC', label: 'Medios de pago (FC)' },
  comprobantes: { path: '/v1/document-types?type=FC',         label: 'Tipos de comprobante (FC)' },
  productos:    { path: '/v1/products?page_size=5',           label: 'Productos' },
};

// Autentica y devuelve el access_token de Siigo (válido ~24h)
async function autenticarSiigo(usuario, accessKey, partnerId) {
  const r = await fetch(`${SIIGO}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Partner-Id': partnerId || 'EDIAN' },
    body: JSON.stringify({ username: usuario, access_key: accessKey }),
  });
  const texto = await r.text();
  let data = {};
  try { data = JSON.parse(texto); } catch (e) { data = { raw: texto }; }
  if (!r.ok || !data.access_token) {
    const err = new Error(data.Errors ? JSON.stringify(data.Errors) : (data.message || texto || 'Error de autenticación'));
    err.httpStatus = r.status;
    throw err;
  }
  return data; // { access_token, expires_in, token_type, scope }
}

// Consulta un recurso con el token
async function consultarRecurso(token, partnerId, path) {
  const r = await fetch(`${SIIGO}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Partner-Id': partnerId || 'EDIAN',
      'Content-Type': 'application/json',
    },
  });
  const texto = await r.text();
  let data = {};
  try { data = JSON.parse(texto); } catch (e) { data = { raw: texto }; }
  return { status: r.status, ok: r.ok, data };
}

// Normaliza: Siigo a veces devuelve {results:[...]} y otras un array directo
function extraerLista(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return null;
}

// ── POST /api/siigo/probar ──
// body: { usuario, accessKey, partnerId, recurso }
//   recurso: una clave de RECURSOS, o "todo" para probar todas, o "auth" para solo login
router.post('/probar', async (req, res) => {
  const { usuario, accessKey, partnerId, recurso = 'auth' } = req.body || {};
  if (!usuario || !accessKey) {
    return res.status(400).json({ ok: false, step: 'input', message: 'Faltan usuario (correo) o accessKey.' });
  }

  // 1) Autenticar
  let auth;
  try {
    auth = await autenticarSiigo(usuario, accessKey, partnerId);
  } catch (e) {
    return res.status(200).json({
      ok: false, step: 'auth', httpStatus: e.httpStatus || 500,
      message: 'No se pudo autenticar en Siigo. Revisa Usuario API, Access Key y Partner-ID.',
      detalle: e.message,
    });
  }

  const info = { ok: true, step: 'auth', auth: { expira_segundos: auth.expires_in, tipo: auth.token_type, scope: auth.scope } };

  if (recurso === 'auth') {
    return res.json({ ...info, mensaje: '✅ Conexión correcta con Siigo.' });
  }

  // 2) Consultar recurso(s)
  async function uno(key) {
    const def = RECURSOS[key];
    if (!def) return { key, error: 'recurso desconocido' };
    try {
      const r = await consultarRecurso(auth.access_token, partnerId, def.path);
      const lista = extraerLista(r.data);
      return {
        key, label: def.label, status: r.status, ok: r.ok,
        total: lista ? lista.length : null,
        pagination: (r.data && r.data.pagination) || null,
        muestra: lista ? lista.slice(0, 3) : r.data,
      };
    } catch (e) {
      return { key, label: def.label, ok: false, error: e.message };
    }
  }

  try {
    if (recurso === 'todo') {
      const keys = Object.keys(RECURSOS);
      const resultados = {};
      for (const k of keys) { resultados[k] = await uno(k); }
      return res.json({ ...info, recursos: resultados });
    } else {
      const r = await uno(recurso);
      return res.json({ ...info, recurso: r });
    }
  } catch (e) {
    return res.status(200).json({ ...info, ok: false, step: 'recurso', message: e.message });
  }
});

router.get('/ping', (req, res) => res.json({ ok: true, service: 'siigo', recursos: Object.keys(RECURSOS) }));

module.exports = router;
