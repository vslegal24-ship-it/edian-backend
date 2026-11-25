const express = require('express');
const router = express.Router();
const { descargarDIAN, diagnosticarPortal, parseTokenUrl } = require('../services/dianScraper');
const { procesarLote } = require('../services/xmlParser');
const { generarExcelItems, generarExcelResumen } = require('../utils/excelGenerator');
const JSZip = require('jszip');

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

async function ejecutarDescarga(body, onJobProgreso) {
  const { tokenUrl, fechaInicio, fechaFin, grupo = '', empresa = 'EDIAN', modulos = ['soportes', 'terceros', 'items'] } = body;
  const soloXML = !modulos.includes('soportes');
  const avisar = p => { emitProgreso(p); if (onJobProgreso) onJobProgreso(p); };

  try {
    console.log(`[API] Iniciando descarga: ${fechaInicio} a ${fechaFin} | grupo: ${grupo || 'todos'} | módulos: ${modulos.join(',')}`);
    avisar({ fase: 'conectando', n: 0, total: 0 });

    const { documentos, nit, filasEncontradas, sinArchivo } = await descargarDIAN({
      tokenUrl, fechaInicio, fechaFin, grupo, soloXML, onProgreso: avisar,
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
