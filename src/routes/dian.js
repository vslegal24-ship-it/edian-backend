const express = require('express');
const router = express.Router();
const { descargarDIAN, diagnosticarPortal, parseTokenUrl, docsDesdeArchivo } = require('../services/dianScraper');
const { procesarLote, parseXmlDIAN } = require('../services/xmlParser');
const multer = require('multer');
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1000 } });
const { generarExcelItems, generarExcelResumen } = require('../utils/excelGenerator');
const JSZip = require('jszip');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// ── Seguridad: cada proceso debe tener sesión y el NIT del token debe ser
//    de una empresa contratada por ese usuario (evita usar el token con
//    compañías no contratadas). El rol 'demo' procesa 1 NIT, 1 token y 1 mes. ──
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'edian_jwt_secret_2025';
const soloDigitos = s => String(s || '').replace(/\D/g, '');

async function guardProceso(req, body, opts) {
  opts = opts || {};
  const via = opts.via || 'rango';   // 'rango' = descarga por fechas | 'listado' = Excel subido | 'zips' = ZIP/archivos subidos
  body = body || {};
  const raw = (req.headers.authorization || '').replace('Bearer ', '');
  let payload = null;
  try { payload = raw ? jwt.verify(raw, JWT_SECRET) : null; } catch (e) { payload = null; }
  if (!payload) return { ok: false, status: 401, error: 'Debes iniciar sesión para procesar.' };
  if (payload.rol === 'admin') return { ok: true };

  // Datos frescos del usuario
  let rol = payload.rol, plan = payload.plan, demoUsado = false;
  try {
    const { data: u } = await supabase.from('edian_usuarios')
      .select('rol, plan_id, demo_usado').eq('id', payload.id).single();
    if (u) { rol = u.rol || rol; plan = u.plan_id || plan; demoUsado = !!u.demo_usado; }
  } catch (e) {}

  const esPremium = plan === 'premium';

  // Cruce NIT-token: solo cuando hay token DIAN en juego (rango/listado). Los ZIP ya vienen descargados.
  if (via !== 'zips') {
    let nitToken = '';
    try { nitToken = soloDigitos(parseTokenUrl(body.tokenUrl).nit); } catch (e) {}
    if (!nitToken) return { ok: false, status: 400, error: 'El enlace del token de la DIAN no es válido.' };
    if (!esPremium) {
      let nitsAsignados = [];
      try {
        const { data: emps } = await supabase.from('edian_empresas')
          .select('nit').eq('usuario_id', payload.id).eq('activo', true);
        nitsAsignados = (emps || []).map(e => soloDigitos(e.nit)).filter(Boolean);
      } catch (e) {}
      if (!nitsAsignados.includes(nitToken)) {
        return { ok: false, status: 403,
          error: 'El NIT del token (' + nitToken + ') no coincide con ninguna de tus empresas contratadas. Pide a tu administrador que registre esa empresa.' };
      }
    }
  }

  // Límites del rol de prueba (demo): 1 token, 1 NIT, 1 mes, 1 sola vez, y SOLO por rango de fechas
  if (rol === 'demo') {
    if (demoUsado) return { ok: false, status: 403, error: 'Ya usaste tu prueba gratuita. Contáctanos para activar tu plan.' };
    if (via !== 'rango') {
      return { ok: false, status: 403, error: 'La prueba solo permite la descarga por rango de fechas de un mes. No admite subir listados ni ZIP.' };
    }
    const a = String(body.fechaInicio || '').slice(0, 7), b = String(body.fechaFin || '').slice(0, 7);
    if (!a || !b || a !== b) {
      return { ok: false, status: 403, error: 'La prueba permite procesar un solo mes. Selecciona un rango dentro del mismo mes.' };
    }
    try { await supabase.from('edian_usuarios').update({ demo_usado: true }).eq('id', payload.id); } catch (e) {}
  }
  return { ok: true };
}

// Cache temporal de ZIPs generados (se limpian despues de 120 min)
const zipCache = new Map();
function limpiarCacheVieja() {
  const ahora = Date.now();
  for (const [key, val] of zipCache.entries()) {
    if (ahora - val.timestamp > 120 * 60 * 1000) zipCache.delete(key);
  }
}
setInterval(limpiarCacheVieja, 5 * 60 * 1000);

// ── Progreso via polling (SSE no compatible con Railway HTTP/2) ──
function emitProgreso(data) {
  global._edianProgreso = data;
}

// GET /api/dian/progreso — polling simple cada 1s desde el frontend
router.get('/progreso', (req, res) => {
  const state = global._edianProgreso || { n: 0, total: 0, fase: 'idle' };
  res.json(state);
});

/**
 * POST /api/dian/validar-token
 */
router.post('/validar-token', (req, res) => {
  try {
    const { tokenUrl } = req.body;
    if (!tokenUrl) return res.status(400).json({ error: 'tokenUrl requerido' });
    const data = parseTokenUrl(tokenUrl);
    res.json({ ok: true, nit: data.nit, tokenPreview: data.token.substring(0, 8) + '...' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Trabajos en segundo plano ──────────────────────────────────
// Railway corta las peticiones HTTP largas. Por eso /descargar con {async:true}
// responde al instante con un jobId y el navegador consulta /job/:id hasta que termine.
const jobs = new Map();
setInterval(() => {
  const ahora = Date.now();
  for (const [id, j] of jobs.entries()) if (ahora - j.creado > 120 * 60 * 1000) jobs.delete(id);
}, 5 * 60 * 1000);

/**
 * POST /api/dian/descargar
 *   body.async === true  -> { ok, jobId }  (luego GET /api/dian/job/:jobId)
 *   sin async            -> respuesta completa como antes (compatibilidad)
 */
router.post('/descargar', async (req, res) => {
  const { tokenUrl, fechaInicio, fechaFin } = req.body;
  if (!tokenUrl || !fechaInicio || !fechaFin) {
    return res.status(400).json({ ok: false, error: 'tokenUrl, fechaInicio y fechaFin son requeridos' });
  }

  const g = await guardProceso(req, req.body, { via: 'rango' });
  if (!g.ok) return res.status(g.status).json({ ok: false, error: g.error });

  if (req.body.async) {
    const ocupado = [...jobs.values()].some(j => j.estado === 'procesando');
    if (ocupado) {
      return res.status(429).json({ ok: false, error: 'Ya hay una descarga en curso. Espera a que termine e inténtalo de nuevo.' });
    }
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const job = { estado: 'procesando', creado: Date.now(), progreso: { fase: 'conectando', n: 0, total: 0 } };
    jobs.set(jobId, job);
    ejecutarDescarga(req.body, p => { job.progreso = p; })
      .then(resultado => { job.estado = 'listo'; job.resultado = resultado; })
      .catch(err => { job.estado = 'error'; job.error = err.message; console.error('[API] Error en job ' + jobId + ':', err.message); });
    return res.json({ ok: true, jobId });
  }

  try {
    res.json(await ejecutarDescarga(req.body));
  } catch (err) {
    console.error('[API] Error en descarga:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/dian/job/:id -> { estado: 'procesando'|'listo'|'error', progreso, resultado?, error? } */
router.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Proceso no encontrado (pudo expirar o el servidor se reinició).' });
  res.json({ ok: true, estado: job.estado, progreso: job.progreso, resultado: job.resultado, error: job.error });
});

/**
 * POST /api/dian/listar  { tokenUrl, fechaInicio, fechaFin, grupo }
 * Solo busca en la DIAN (sin descargar). Responde { ok, jobId }; el resultado
 * (GET /job/:id) trae { documentos: [{cufe, nombre, fecha, nitEmisor, ...}] }.
 */
router.post('/listar', async (req, res) => {
  const { tokenUrl, fechaInicio, fechaFin, grupo = '' } = req.body;
  if (!tokenUrl || !fechaInicio || !fechaFin) {
    return res.status(400).json({ ok: false, error: 'tokenUrl, fechaInicio y fechaFin son requeridos' });
  }
  const g = await guardProceso(req, req.body, { via: 'rango' });
  if (!g.ok) return res.status(g.status).json({ ok: false, error: g.error });
  if ([...jobs.values()].some(j => j.estado === 'procesando')) {
    return res.status(429).json({ ok: false, error: 'Ya hay un proceso en curso. Espera a que termine.' });
  }
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = { estado: 'procesando', creado: Date.now(), progreso: { fase: 'conectando', n: 0, total: 0 } };
  jobs.set(jobId, job);
  descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, soloListar: true, onProgreso: p => { job.progreso = p; } })
    .then(r => {
      job.estado = 'listo';
      job.resultado = {
        ok: true, nit: r.nit, total: r.total,
        documentos: r.documentos.map(d => ({
          cufe: d.cufe, nombre: d.nombre, tipo: d.tipo, fecha: d.fecha, grupo: d.grupo,
          nitEmisor: d.nitEmisor, nomEmisor: d.nomEmisor, nitReceptor: d.nitReceptor, nomReceptor: d.nomReceptor,
          total: d.total, cufeUrl: d.cufeUrl,
        })),
      };
    })
    .catch(err => { job.estado = 'error'; job.error = err.message; console.error('[API] Error listando:', err.message); });
  res.json({ ok: true, jobId });
});

/**
 * POST /api/dian/descargar-listado  (multipart)
 *   listado: archivo Excel (.xlsx) o ZIP del "Descargar listados" de la DIAN
 *   tokenUrl, empresa: para entrar y nombrar
 * Lee los CUFEs del Excel y descarga XML+PDF desde gratis-vpfe (sin rastrear el catálogo).
 * Responde { ok, jobId }; el resultado se consulta en GET /api/dian/job/:jobId.
 */
router.post('/descargar-listado', subida.single('listado'), async (req, res) => {
  try {
    const { tokenUrl } = req.body;
    if (!tokenUrl) return res.status(400).json({ ok: false, error: 'Falta el token de la DIAN' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo del listado (Excel)' });
    const g = await guardProceso(req, req.body, { via: 'listado' });
    if (!g.ok) return res.status(g.status).json({ ok: false, error: g.error });
    if ([...jobs.values()].some(j => j.estado === 'procesando')) {
      return res.status(429).json({ ok: false, error: 'Ya hay una descarga en curso. Espera a que termine.' });
    }
    let docs;
    try { docs = await docsDesdeArchivo(req.file.buffer); }
    catch (e) { return res.status(400).json({ ok: false, error: 'No pude leer el Excel: ' + e.message }); }
    if (!docs.length) return res.status(400).json({ ok: false, error: 'El Excel no trae documentos con CUFE' });

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const job = { estado: 'procesando', creado: Date.now(), progreso: { fase: 'conectando', n: 0, total: docs.length } };
    jobs.set(jobId, job);
    const body = {
      tokenUrl,
      empresa: req.body.empresa || 'EDIAN',
      fechaInicio: req.body.fechaInicio || '',
      fechaFin: req.body.fechaFin || '',
      modulos: ['soportes', 'terceros', 'items'],
    };
    ejecutarDescarga(body, p => { job.progreso = p; }, docs)
      .then(resultado => { job.estado = 'listo'; job.resultado = resultado; })
      .catch(err => { job.estado = 'error'; job.error = err.message; console.error('[API] Error en job-listado ' + jobId + ':', err.message); });
    res.json({ ok: true, jobId, total: docs.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function nombreArchivo(fac) {
  const limpio = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const partes = [
    limpio(fac.emisor && fac.emisor.nit),
    limpio(fac.emisor && fac.emisor.nombre).substring(0, 30),
    limpio(fac.folio || fac.numero || 'sin-folio'),
    String(fac.fecha || '').replace(/[^0-9]/g, '').substring(0, 8),
  ];
  return partes.filter(Boolean).join('_') || 'documento';
}

/**
 * POST /api/dian/procesar-zips  (multipart)
 *   archivos[]: ZIPs (o XML/PDF sueltos) descargados de la DIAN
 *   listado:    JSON opcional con [{cufe, nombre, ...}] para saber cuáles faltan
 *   empresa, fechaInicio, fechaFin: para nombrar el ZIP final
 * Responde { ok, facturas, items, filas, facturas_data, faltantes, sobrantes, errores, zipKey }
 */
router.post('/procesar-zips', subida.array('archivos', 1000), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ ok: false, error: 'No se recibieron archivos' });
    const g = await guardProceso(req, req.body, { via: 'zips' });
    if (!g.ok) return res.status(g.status).json({ ok: false, error: g.error });
    const empresa = req.body.empresa || 'EDIAN';
    const fechaInicio = req.body.fechaInicio || '';
    const fechaFin = req.body.fechaFin || '';
    let listado = [];
    try { listado = JSON.parse(req.body.listado || '[]'); } catch (e) {}

    // 1. Sacar los pares XML/PDF de cada archivo subido
    const paquetes = []; // { origen, xml, pdf }
    const errores = [];
    for (const f of req.files) {
      const nom = f.originalname || 'archivo';
      const low = nom.toLowerCase();
      try {
        if (low.endsWith('.zip')) {
          const zip = await JSZip.loadAsync(f.buffer);
          const xmls = [], pdfs = [];
          for (const [fn, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            if (fn.toLowerCase().endsWith('.xml')) xmls.push(await entry.async('nodebuffer'));
            if (fn.toLowerCase().endsWith('.pdf')) pdfs.push(await entry.async('nodebuffer'));
          }
          if (!xmls.length) errores.push({ nombre: nom, error: 'El ZIP no trae XML' });
          xmls.forEach((x, i) => paquetes.push({ origen: nom, xml: x, pdf: pdfs[i] || (xmls.length === 1 ? pdfs[0] : null) || null }));
        } else if (low.endsWith('.xml')) {
          paquetes.push({ origen: nom, xml: f.buffer, pdf: null });
        } else {
          errores.push({ nombre: nom, error: 'Tipo de archivo no soportado (solo .zip o .xml)' });
        }
      } catch (e) {
        errores.push({ nombre: nom, error: 'No se pudo abrir: ' + e.message });
      }
    }

    // 2. Leer cada XML y quitar duplicados por CUFE
    const porCufe = new Map();
    for (const p of paquetes) {
      const xmlText = p.xml.toString('utf8');
      try {
        const fac = await parseXmlDIAN(xmlText);
        const key = String(fac.cufe || fac.folio || p.origen);
        if (!porCufe.has(key)) porCufe.set(key, { fac, xmlText, xml: p.xml, pdf: p.pdf, origen: p.origen });
      } catch (e) {
        errores.push({ nombre: p.origen, error: e.message });
      }
    }
    const docs = [...porCufe.values()];
    if (!docs.length) return res.status(400).json({ ok: false, error: 'Ningún archivo tenía una factura válida', errores });

    // 3. Filas para los Excel
    const { facturas, filas } = await procesarLote(docs.map(d => ({ xmlText: d.xmlText, nombre: d.origen })));

    // 4. Cruce con el listado de la DIAN
    const subidos = new Set(docs.map(d => String(d.fac.cufe)));
    const enListado = new Set(listado.map(l => String(l.cufe)));
    const faltantes = listado.filter(l => !subidos.has(String(l.cufe)));
    const sobrantes = listado.length ? docs.filter(d => !enListado.has(String(d.fac.cufe))).map(d => d.fac.folio) : [];

    // 5. ZIP final con archivos renombrados + Excel
    const zipObj = new JSZip();
    const folder = zipObj.folder('facturas');
    const { buffer: xlsBuf, filename: xlsName } = generarExcelItems(filas, facturas, { empresa, fechaIni: fechaInicio, fechaFin });
    folder.file(xlsName, xlsBuf);
    const usados = {};
    for (const d of docs) {
      let base = nombreArchivo(d.fac);
      if (usados[base]) base += '_' + (++usados[base]); else usados[base] = 1;
      folder.file(base + '.xml', d.xml);
      if (d.pdf) folder.file(base + '.pdf', d.pdf);
    }
    if (faltantes.length) {
      const txt = 'Documentos del listado DIAN que no se subieron:\r\n\r\n' +
        faltantes.map(f => [f.nombre, f.fecha, f.nitEmisor, f.nomEmisor, f.cufe].join(' | ')).join('\r\n');
      folder.file('FALTANTES.txt', txt);
    }
    const zipBuffer = await zipObj.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipKey = Date.now() + '_subida';
    const emp = empresa.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
    zipCache.set(zipKey, {
      buffer: zipBuffer,
      filename: emp + '_' + fechaInicio.replace(/-/g, '') + '_' + fechaFin.replace(/-/g, '') + '.zip',
      timestamp: Date.now(), empresa, fechaIni: fechaInicio, fechaFin, nFacturas: facturas.length,
    });
    console.log('[SUBIDA] ' + req.files.length + ' archivos -> ' + docs.length + ' facturas, faltan ' + faltantes.length);

    res.json({
      ok: true, facturas: facturas.length, items: filas.length, filas, facturas_data: facturas,
      faltantes, sobrantes, errores, zipKey,
      sinPdf: docs.filter(d => !d.pdf).length,
    });
  } catch (err) {
    console.error('[SUBIDA] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function ejecutarDescarga(body, onJobProgreso, documentosPrecargados) {
  const { tokenUrl, fechaInicio, fechaFin, grupo = '', empresa = 'EDIAN', modulos = ['soportes', 'terceros', 'items'] } = body;
  const soloXML = !modulos.includes('soportes');
  const avisar = p => { emitProgreso(p); if (onJobProgreso) onJobProgreso(p); };

  try {
    console.log(`[API] Iniciando descarga: ${fechaInicio} a ${fechaFin} | grupo: ${grupo || 'todos'} | módulos: ${modulos.join(',')}${documentosPrecargados ? ' | desde listado subido (' + documentosPrecargados.length + ')' : ''}`);
    avisar({ fase: 'conectando', n: 0, total: 0 });

    const { documentos, nit, filasEncontradas, sinArchivo } = await descargarDIAN({
      tokenUrl, fechaInicio, fechaFin, grupo, soloXML, documentosPrecargados, onProgreso: avisar,
    });

    if (documentos.length === 0) {
      avisar({ fase: 'idle', n: 0, total: 0 });
      return {
        ok: true, nit, total: 0, filas: [], facturas: 0, items: 0, facturas_data: [],
        mensaje: 'No se encontraron documentos en el período indicado',
      };
    }
    if (sinArchivo === documentos.length) {
      throw new Error('Se encontraron ' + documentos.length + ' documentos en la DIAN pero no se pudo descargar ninguno (revisar logs del servidor).');
    }

    avisar({ fase: 'procesando', n: documentos.length, total: documentos.length });

    // 2. Parsear XMLs
    const xmlTexts = documentos.map(d => ({
      xmlText: d.xmlText,
      nombre: d.nombre || d.folio || '',
      grupo: d.grupo || ''
    }));
    const { facturas, filas, errores } = await procesarLote(xmlTexts);
    console.log(`[API] Procesados: ${facturas.length} facturas, ${filas.length} ítems`);

    // 3. Generar ZIP solo si módulo soportes está activo
    let zipKey = null;
    if (modulos.includes('soportes')) {
      try {
        const zipObj = new JSZip();
        const folder = zipObj.folder('facturas');

        const { buffer: xlsBuf, filename: xlsName } = generarExcelItems(filas, facturas, {
          empresa, fechaIni: fechaInicio, fechaFin,
        });
        folder.file(xlsName, xlsBuf);

        for (const doc of documentos) {
          const nitEmi = (doc.emisor && doc.emisor.nit)    || doc.nitEmisor || '';
          const nomEmi = (doc.emisor && doc.emisor.nombre) || doc.nomEmisor || '';
          const folio  = (doc.folio || doc.numero || 'sin-folio').replace(/[^a-zA-Z0-9\-]/g, '_');
          const fecha  = (doc.fecha || '').replace(/[^0-9]/g, '').substring(0, 8);
          const nomL   = nomEmi.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 20);
          const base   = [nitEmi, nomL, folio, fecha].filter(Boolean).join('_');
          if (doc.pdfBuffer) folder.file(base + '.pdf', doc.pdfBuffer);
          if (doc.xmlBuffer) folder.file(base + '.xml', doc.xmlBuffer);
          else if (doc.xmlText) folder.file(base + '.xml', doc.xmlText);
        }

        const zipBuffer = await zipObj.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        zipKey = Date.now() + '_' + nit;
        const emp = empresa.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
        const fi  = (fechaInicio || '').replace(/-/g, '');
        const ff  = (fechaFin    || '').replace(/-/g, '');
        zipCache.set(zipKey, {
          buffer: zipBuffer,
          filename: emp + '_' + fi + '_' + ff + '.zip',
          timestamp: Date.now(),
          empresa, fechaIni: fechaInicio, fechaFin,
          nFacturas: facturas.length,
        });
        console.log('[ZIP] Cacheado:', zipKey, '(' + zipBuffer.length + ' bytes)');
      } catch (zipErr) {
        console.error('[ZIP] Error generando cache:', zipErr.message);
      }
    }

    avisar({ fase: 'listo', n: documentos.length, total: documentos.length, zipKey });

    return {
      ok: true,
      nit,
      total: documentos.length,
      filasEncontradas,
      sinArchivo,
      facturas: facturas.length,
      items: filas.length,
      filas,
      facturas_data: facturas,
      errores,
      zipKey,
      periodo: { desde: fechaInicio, hasta: fechaFin },
      empresa,
    };
  } catch (err) {
    avisar({ fase: 'error', error: err.message });
    throw err;
  }
}

/**
 * POST /api/dian/excel-items
 */
router.post('/excel-items', (req, res) => {
  const { filas, facturas_data, empresa = 'EDIAN', fechaInicio, fechaFin } = req.body;
  if (!filas || !filas.length) return res.status(400).json({ error: 'Sin datos para generar Excel' });
  try {
    const { buffer, filename } = generarExcelItems(filas, facturas_data || [], {
      empresa, fechaIni: fechaInicio, fechaFin,
    });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/dian/excel-resumen
 */
router.post('/excel-resumen', (req, res) => {
  const { facturas_data, empresa = 'EDIAN', fechaInicio, fechaFin } = req.body;
  if (!facturas_data || !facturas_data.length) return res.status(400).json({ error: 'Sin datos' });
  try {
    const { buffer, filename } = generarExcelResumen(facturas_data, {
      empresa, fechaIni: fechaInicio, fechaFin,
    });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/dian/diagnosticar
 */
router.post('/diagnosticar', async (req, res) => {
  const { tokenUrl } = req.body;
  if (!tokenUrl) return res.status(400).json({ error: 'tokenUrl requerido' });
  try {
    const info = await diagnosticarPortal(tokenUrl);
    res.json(info);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/dian/ultimo
 */
router.get('/ultimo', (req, res) => {
  if (zipCache.size === 0) return res.json({ ok: false, error: 'No hay procesos recientes en caché' });
  let latest = null;
  for (const [key, val] of zipCache.entries()) {
    if (!latest || val.timestamp > latest.timestamp) {
      latest = { key, ...val };
    }
  }
  if (!latest) return res.json({ ok: false, error: 'No hay procesos disponibles' });
  const mins = Math.round((Date.now() - latest.timestamp) / 60000);
  res.json({
    ok: true,
    zipKey: latest.key,
    empresa: latest.empresa || '—',
    fechaIni: latest.fechaIni || '—',
    fechaFin: latest.fechaFin || '—',
    nFacturas: latest.nFacturas || 0,
    hace: mins + ' min',
    expiraEn: Math.max(0, 120 - mins) + ' min',
  });
});

/**
 * GET /api/dian/zip/:key
 */
router.get('/zip/:key', (req, res) => {
  const cached = zipCache.get(req.params.key);
  if (!cached) return res.status(404).json({ error: 'ZIP no encontrado o expirado. Descarga de nuevo.' });
  res.setHeader('Content-Disposition', 'attachment; filename="' + cached.filename + '"');
  res.setHeader('Content-Type', 'application/zip');
  res.send(cached.buffer);
});

/**
 * POST /api/dian/zip
 */
router.post('/zip', async (req, res) => {
  const { filas, facturas_data, empresa = 'EDIAN', fechaInicio, fechaFin } = req.body;
  if (!facturas_data || !facturas_data.length) {
    return res.status(400).json({ error: 'Sin datos para generar ZIP' });
  }
  try {
    const zip = new JSZip();
    const folder = zip.folder('facturas');
    const { buffer: xlsBuffer, filename: xlsFilename } = generarExcelItems(
      filas || [], facturas_data, { empresa, fechaIni: fechaInicio, fechaFin }
    );
    folder.file(xlsFilename, xlsBuffer);
    for (const fac of facturas_data) {
      const nitEmi    = (fac.emisor && fac.emisor.nit)    || fac.nitEmisor || '';
      const nomEmi    = (fac.emisor && fac.emisor.nombre) || fac.nomEmisor || '';
      const folio     = (fac.folio || fac.numero || 'sin-folio').replace(/[^a-zA-Z0-9-]/g, '_');
      const fecha     = (fac.fecha || '').replace(/[^0-9]/g, '').substring(0, 8);
      const nomLimpio = nomEmi.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 20);
      const baseName  = [nitEmi, nomLimpio, folio, fecha].filter(Boolean).join('_');
      if (fac.pdfBuffer) folder.file(baseName + '.pdf', fac.pdfBuffer);
      if (fac.xmlBuffer) folder.file(baseName + '.xml', fac.xmlBuffer);
      else if (fac.xmlText) folder.file(baseName + '.xml', fac.xmlText);
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const emp = empresa.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
    const fi  = (fechaInicio || '').replace(/-/g, '');
    const ff  = (fechaFin    || '').replace(/-/g, '');
    res.setHeader('Content-Disposition', 'attachment; filename="' + emp + '_' + fi + '_' + ff + '.zip"');
    res.setHeader('Content-Type', 'application/zip');
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
