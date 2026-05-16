const express = require('express');
const router = express.Router();
const { descargarDIAN, exportarExcelDIAN, parseTokenUrl } = require('../services/dianScraper');
const { procesarLote } = require('../services/xmlParser');
const { generarExcelItems, generarExcelResumen } = require('../utils/excelGenerator');

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
    const { documentos, nit, total } = await descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo });

    if (documentos.length === 0) {
      return res.json({
        ok: true, total: 0, filas: [], facturas: [],
        mensaje: 'No se encontraron documentos en el período indicado',
      });
    }

    // 2. Parsear todos los XMLs
    const xmlTexts = documentos.map(d => ({ xmlText: d.xmlText, nombre: d.nombre }));
    const { facturas, filas, errores } = await procesarLote(xmlTexts);

    console.log(`[API] Procesados: ${facturas.length} facturas, ${filas.length} ítems`);

    res.json({
      ok: true,
      nit,
      total: documentos.length,
      facturas: facturas.length,
      items: filas.length,
      filas,        // ← array plano 1 fila por ítem para la tabla
      facturas_data: facturas, // ← cabeceras para el resumen
      errores,
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

module.exports = router;
