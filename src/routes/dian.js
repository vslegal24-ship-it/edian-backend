const express = require('express');
const router = express.Router();
const { descargarDIAN, diagnosticarPortal, parseTokenUrl } = require('../services/dianScraper');
const { procesarLote } = require('../services/xmlParser');
const { generarExcelItems, generarExcelResumen } = require('../utils/excelGenerator');
const JSZip = require('jszip');

// Cache temporal de ZIPs generados (se limpian despues de 30 min)
const zipCache = new Map();
function limpiarCacheVieja() {
  const ahora = Date.now();
  for (const [key, val] of zipCache.entries()) {
    if (ahora - val.timestamp > 30 * 60 * 1000) zipCache.delete(key);
  }
}
setInterval(limpiarCacheVieja, 5 * 60 * 1000);

/**
 * POST /api/dian/validar-token
 * Valida el formato del token URL antes de lanzar el proceso
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

/**
 * POST /api/dian/descargar
 * Descarga documentos del portal DIAN, parsea XMLs y devuelve
 * las filas (1 por ítem) + las facturas completas.
 *
 * Body: { tokenUrl, fechaInicio, fechaFin, grupo?, empresa? }
 */
router.post('/descargar', async (req, res) => {
  const { tokenUrl, fechaInicio, fechaFin, grupo = '', empresa = 'EDIAN' } = req.body;

  if (!tokenUrl || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: 'tokenUrl, fechaInicio y fechaFin son requeridos' });
  }

  try {
    console.log(`[API] Iniciando descarga: ${fechaInicio} a ${fechaFin}`);

    // 1. Descargar PDFs + XMLs de la DIAN
    global._edianDescargados = 0;
    global._edianTotal = 0;
    emitProgreso({ fase: 'conectando', n: 0, total: 0 });
    const _progressInterval = setInterval(() => {
      const n = global._edianDescargados || 0;
      const t = global._edianTotal || 0;
      if (t > 0) emitProgreso({ fase: 'descargando', n, total: t });
    }, 1000);
    let documentos, nit, total;
    try {
      ({ documentos, nit, total } = await descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo }));
    } finally {
      clearInterval(_progressInterval);
    }

    if (documentos.length === 0) {
      return res.json({
        ok: true, total: 0, filas: [], facturas: [],
        mensaje: 'No se encontraron documentos en el período indicado',
      });
    }

    // 2. Parsear todos los XMLs
    const xmlTexts = documentos.map(d => ({ xmlText: d.xmlText, nombre: d.nombre || d.folio || '', grupo: d.grupo || '' }));
    const { facturas, filas, errores } = await procesarLote(xmlTexts);

    console.log(`[API] Procesados: ${facturas.length} facturas, ${filas.length} ítems`);

    // Generar ZIP inmediatamente y cachearlo (los buffers solo existen aqui)
    let zipKey = null;
    try {
      const zipObj = new JSZip();
      const folder = zipObj.folder('facturas');

      // Excel detallado adentro del ZIP
      const { buffer: xlsBuf, filename: xlsName } = generarExcelItems(filas, facturas, {
        empresa, fechaIni: fechaInicio, fechaFin,
      });
      folder.file(xlsName, xlsBuf);

      // PDF y XML de cada documento renombrados
      for (const doc of documentos) {
        const nitEmi  = (doc.emisor && doc.emisor.nit)    || doc.nitEmisor || '';
        const nomEmi  = (doc.emisor && doc.emisor.nombre) || doc.nomEmisor || '';
        const folio   = (doc.folio || doc.numero || 'sin-folio').replace(/[^a-zA-Z0-9\-]/g, '_');
        const fecha   = (doc.fecha || '').replace(/[^0-9]/g, '').substring(0, 8);
        const nomL    = nomEmi.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 20);
        const base    = [nitEmi, nomL, folio, fecha].filter(Boolean).join('_');
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
      });
      console.log('[ZIP] Cacheado:', zipKey, '(' + zipBuffer.length + ' bytes)');
    } catch (zipErr) {
      console.error('[ZIP] Error generando cache:', zipErr.message);
    }

    res.json({
      ok: true,
      nit,
      total: documentos.length,
      facturas: facturas.length,
      items: filas.length,
      filas,
      facturas_data: facturas,
      errores,
      zipKey,
      periodo: { desde: fechaInicio, hasta: fechaFin },
      empresa,
    });

  } catch (err) {
    console.error('[API] Error en descarga:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/dian/excel-items
 * Genera y descarga el Excel detallado (1 fila por ítem)
 * a partir de los datos ya procesados.
 *
 * Body: { filas, facturas_data, empresa, fechaInicio, fechaFin }
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
 * Genera el Excel igual al export de la DIAN (1 fila por factura)
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
 * Autentica y retorna la estructura HTML del portal para debug
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
 * GET /api/dian/zip/:key
 * Sirve el ZIP cacheado generado durante la descarga
 */
// ── GET /api/dian/progreso — Server-Sent Events para progreso en tiempo real ──
const _progresoClients = new Set();

router.get('/progreso', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res, id: Date.now() };
  _progresoClients.add(client);

  // Send current state immediately
  const state = global._edianProgreso || { n: 0, total: 0, fase: 'idle' };
  res.write('data: ' + JSON.stringify(state) + '\n\n');

  req.on('close', () => _progresoClients.delete(client));
});

function emitProgreso(data) {
  global._edianProgreso = data;
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const client of _progresoClients) {
    try { client.res.write(msg); } catch(e) { _progresoClients.delete(client); }
  }
}

// ── GET /api/dian/ultimo — último proceso completado ─────────
router.get('/ultimo', (req, res) => {
  if (zipCache.size === 0) return res.json({ ok: false, error: 'No hay procesos recientes en caché' });
  // Get most recent entry
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
    expiraEn: Math.max(0, 30 - mins) + ' min',
  });
});

router.get('/zip/:key', (req, res) => {
  const cached = zipCache.get(req.params.key);
  if (!cached) return res.status(404).json({ error: 'ZIP no encontrado o expirado. Descarga de nuevo.' });
  res.setHeader('Content-Disposition', 'attachment; filename="' + cached.filename + '"');
  res.setHeader('Content-Type', 'application/zip');
  res.send(cached.buffer);
});

/**
 * POST /api/dian/zip
 * Genera ZIP con PDFs y XMLs renombrados: NIT_NombreEmisor_Folio_Fecha.pdf/xml
 * + el Excel detallado adentro
 */
router.post('/zip', async (req, res) => {
  const { filas, facturas_data, empresa = 'EDIAN', fechaInicio, fechaFin } = req.body;
  if (!facturas_data || !facturas_data.length) {
    return res.status(400).json({ error: 'Sin datos para generar ZIP' });
  }
  try {
    const zip = new JSZip();
    const folder = zip.folder('facturas');

    // Agregar Excel detallado
    const { buffer: xlsBuffer, filename: xlsFilename } = generarExcelItems(
      filas || [], facturas_data,
      { empresa, fechaIni: fechaInicio, fechaFin }
    );
    folder.file(xlsFilename, xlsBuffer);

    // Agregar PDFs y XMLs con nombre: NIT_Nombre_Folio_Fecha
    for (const fac of facturas_data) {
      const nitEmi  = (fac.emisor && fac.emisor.nit)    || fac.nitEmisor || '';
      const nomEmi  = (fac.emisor && fac.emisor.nombre) || fac.nomEmisor || '';
      const folio   = (fac.folio || fac.numero || 'sin-folio').replace(/[^a-zA-Z0-9-]/g, '_');
      const fecha   = (fac.fecha || '').replace(/[^0-9]/g, '').substring(0, 8);
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
    const zipName = emp + '_' + fi + '_' + ff + '.zip';

    res.setHeader('Content-Disposition', 'attachment; filename="' + zipName + '"');
    res.setHeader('Content-Type', 'application/zip');
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
