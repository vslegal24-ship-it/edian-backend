// ============================================================
// src/routes/nit.js — Consulta NIT / RUT para EDIAN
// ============================================================

const express = require('express');
const router = express.Router();

// ── Función para limpiar el email que viene con ';null' ──
function limpiarEmail(email) {
  if (!email) return null;
  return email.replace(/;null/gi, '').replace(/null;/gi, '').trim() || null;
}

// ── Función para calcular el dígito verificador de un NIT ──
// Algoritmo oficial DIAN
function calcularDV(nit) {
  const nitStr = String(nit).replace(/\D/g, ''); // Solo números
  const primos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let suma = 0;
  let j = 0;

  for (let i = nitStr.length - 1; i >= 0; i--) {
    suma += parseInt(nitStr[i]) * primos[j++];
  }

  const residuo = suma % 11;

  if (residuo === 0 || residuo === 1) return residuo;
  return 11 - residuo;
}

// ══════════════════════════════════════════════════════════════
// GET /api/nit/:nit
// Consulta individual — para el landing público y el módulo
// Ejemplo: GET /api/nit/900373076
// ══════════════════════════════════════════════════════════════
router.get('/:nit', async (req, res) => {
  try {
    const nit = req.params.nit.replace(/\D/g, ''); // Limpia todo menos números

    // Validación básica
    if (!nit || nit.length < 6 || nit.length > 12) {
      return res.status(400).json({
        success: false,
        message: 'NIT inválido. Debe tener entre 6 y 12 dígitos sin puntos ni guiones.'
      });
    }

    // Llama al servicio de sipos (que consume la DIAN internamente)
    // Enviamos el Referer correcto para que no bloquee la petición
    const response = await fetch(`https://sipos.com.co/api_rut.php?nit=${nit}`, {
      headers: {
        'Referer': 'https://sipos.com.co/consultarut.html',
        'Origin': 'https://sipos.com.co',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      // Timeout de 10 segundos
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: 'Error al consultar la DIAN. Intente nuevamente.'
      });
    }

    const data = await response.json();

    if (!data.success) {
      return res.status(404).json({
        success: false,
        message: `No se encontró información para el NIT ${nit} en la DIAN.`
      });
    }

    // Calcula el DV localmente para verificar contra el que devuelve la DIAN
    const dvCalculado = calcularDV(nit);
    const dvDian = parseInt(data.dv);
    const dvCorrecto = dvCalculado === dvDian;

    // Construye respuesta enriquecida
    res.json({
      success: true,
      nit: nit,
      dv: dvDian,
      dv_calculado: dvCalculado,
      dv_correcto: dvCorrecto, // true si el DV que escribió el usuario coincide con la DIAN
      razon_social: data.razon_social || null,
      email: limpiarEmail(data.email),
      direccion: data.direccion || null,
      ciudad: data.ciudad || null,
      // Formato completo para mostrar en facturas
      nit_completo: `${nit}-${dvDian}`
    });

  } catch (error) {
    // Timeout
    if (error.name === 'TimeoutError') {
      return res.status(504).json({
        success: false,
        message: 'La consulta tardó demasiado. La DIAN puede estar en mantenimiento.'
      });
    }

    console.error('[NIT] Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor.'
    });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/nit/lote
// Consulta masiva — para el módulo interno de EDIAN
// Body: { nits: ["900373076", "901500560", ...] }
// Máximo 50 NITs por petición
// ══════════════════════════════════════════════════════════════
router.post('/lote', async (req, res) => {
  try {
    const { nits } = req.body;

    if (!Array.isArray(nits) || nits.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Envía un array de NITs. Ej: { "nits": ["900373076", "901500560"] }'
      });
    }

    if (nits.length > 50) {
      return res.status(400).json({
        success: false,
        message: 'Máximo 50 NITs por petición.'
      });
    }

    // Procesa en paralelo con límite de 5 simultáneos
    // para no saturar el servicio de la DIAN
    const resultados = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < nits.length; i += BATCH_SIZE) {
      const lote = nits.slice(i, i + BATCH_SIZE);

      // Consulta 5 NITs en paralelo
      const promesas = lote.map(async (nitRaw) => {
        const nit = String(nitRaw).replace(/\D/g, '');

        if (!nit || nit.length < 6) {
          return { nit: nitRaw, success: false, message: 'NIT inválido' };
        }

        try {
          const response = await fetch(`https://sipos.com.co/api_rut.php?nit=${nit}`, {
            headers: {
              'Referer': 'https://sipos.com.co/consultarut.html',
              'Origin': 'https://sipos.com.co'
            },
            signal: AbortSignal.timeout(10000)
          });

          const data = await response.json();

          if (!data.success) {
            return { nit, success: false, message: 'No encontrado en la DIAN' };
          }

          const dvCalculado = calcularDV(nit);
          const dvDian = parseInt(data.dv);

          return {
            nit,
            success: true,
            dv: dvDian,
            dv_calculado: dvCalculado,
            dv_correcto: dvCalculado === dvDian,
            nit_completo: `${nit}-${dvDian}`,
            razon_social: data.razon_social || null,
            email: limpiarEmail(data.email),
            direccion: data.direccion || null,
            ciudad: data.ciudad || null
          };

        } catch (e) {
          return { nit, success: false, message: 'Error de conexión' };
        }
      });

      const loteResultados = await Promise.all(promesas);
      resultados.push(...loteResultados);

      // Pausa de 500ms entre lotes para no saturar
      if (i + BATCH_SIZE < nits.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Resumen del lote
    const exitosos = resultados.filter(r => r.success).length;
    const fallidos = resultados.filter(r => !r.success).length;
    const conEmailValido = resultados.filter(r => r.success && r.email).length;
    const dvIncorrectos = resultados.filter(r => r.success && !r.dv_correcto).length;

    res.json({
      success: true,
      resumen: {
        total: nits.length,
        exitosos,
        fallidos,
        con_email: conEmailValido,
        dv_incorrectos: dvIncorrectos
      },
      resultados
    });

  } catch (error) {
    console.error('[NIT-LOTE] Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor.'
    });
  }
});

module.exports = router;
