const express = require('express');
const router = express.Router();
const multer = require('multer');
const JSZip = require('jszip');
const { procesarLote } = require('../services/xmlParser');
const { generarExcelItems } = require('../utils/excelGenerator');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/**
 * POST /api/fase2/procesar-xml
 * Recibe XMLs o ZIPs, los parsea y devuelve filas 1-por-ítem.
 * Útil para pruebas con archivos ya descargados.
 */
router.post('/procesar-xml', upload.array('archivos', 100), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No se recibieron archivos' });
  }

  try {
    const xmlTexts = [];

    for (const file of req.files) {
      const nombre = file.originalname;
      if (nombre.endsWith('.xml')) {
        xmlTexts.push({ xmlText: file.buffer.toString('utf8'), nombre });
      } else if (nombre.endsWith('.zip')) {
        const zip = await JSZip.loadAsync(file.buffer);
        for (const [fname, entry] of Object.entries(zip.files)) {
          if (fname.endsWith('.xml')) {
            const txt = await entry.async('text');
            xmlTexts.push({ xmlText: txt, nombre: fname });
          }
        }
      }
    }

    if (xmlTexts.length === 0) {
      return res.status(400).json({ error: 'No se encontraron archivos XML en los archivos enviados' });
    }

    const { facturas, filas, errores } = await procesarLote(xmlTexts);

    res.json({
      ok: true,
      totalFacturas: facturas.length,
      totalItems: filas.length,
      filas,
      facturas_data: facturas,
      errores,
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
