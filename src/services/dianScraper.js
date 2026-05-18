const { chromium } = require('playwright');
const JSZip = require('jszip');
const fs = require('fs');

function parseTokenUrl(url) {
  try {
    const u = new URL(url.trim());
    const rk = u.searchParams.get('rk');
    const token = u.searchParams.get('token');
    const pk = u.searchParams.get('pk') || '';
    if (!rk || !token) throw new Error('Faltan parametros rk o token');
    return { nit: rk, token, pk };
  } catch (e) {
    throw new Error('URL del token invalida: ' + e.message);
  }
}

function toFechaDIAN(iso) {
  const [y, m, d] = iso.split('-');
  return parseInt(m) + '/' + parseInt(d) + '/' + y + ' 12:00:00 AM';
}

/**
 * Consulta documentos en una pagina del portal (recibidos o enviados)
 * e inyecta las fechas usando el daterangepicker de la DIAN.
 */
async function consultarPagina(page, url, startDate, endDate, startISO, endISO) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('[DIAN] Pagina: ' + page.url());

  // Inyectar fechas correctamente: primero el daterangepicker, luego los hidden fields
  await page.evaluate(function(p) {
    // 1. Hidden fields directos
    var sEl = document.getElementById('startDate');
    var eEl = document.getElementById('endDate');
    if (sEl) sEl.value = p.start;
    if (eEl) eEl.value = p.end;

    // 2. Input visible del daterangepicker - formato yyyy/mm/dd - yyyy/mm/dd
    var rEl = document.getElementById('dashboard-report-range');
    if (rEl) {
      rEl.value = p.startISO + ' - ' + p.endISO;
      // Disparar eventos para que el daterangepicker registre el cambio
      rEl.dispatchEvent(new Event('change', { bubbles: true }));
      rEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 3. Intentar via jQuery daterangepicker si esta disponible
    if (window.$ && rEl) {
      try {
        var dr = $(rEl).data('daterangepicker');
        if (dr && dr.setStartDate && dr.setEndDate) {
          dr.setStartDate(p.startISO);
          dr.setEndDate(p.endISO);
          console.log('daterangepicker actualizado via jQuery');
        }
      } catch(e) { console.log('daterangepicker error:', e.message); }
    }
  }, { start: startDate, end: endDate, startISO, endISO });

  // Hacer clic en Buscar
  await page.evaluate(function() {
    var btns = Array.from(document.querySelectorAll('button, input[type=submit]'));
    var b = btns.find(function(x) {
      return (x.textContent + (x.value || '')).toLowerCase().includes('buscar');
    });
    if (b) { b.click(); return 'click: ' + b.textContent; }
    var f = document.querySelector('form');
    if (f) { f.submit(); return 'form.submit'; }
    return 'no button found';
  });

  // Esperar resultados AJAX
  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function() {});

  // Verificar que las fechas se aplicaron correctamente
  const fechasAplicadas = await page.evaluate(function() {
    var s = document.getElementById('startDate');
    var e = document.getElementById('endDate');
    return {
      startDate: s ? s.value : 'NO',
      endDate: e ? e.value : 'NO',
    };
  });
  console.log('[DIAN] Fechas aplicadas:', JSON.stringify(fechasAplicadas));

  // Extraer filas con CUFE del boton download-document
  const filas = await page.evaluate(function() {
    var resultado = [];
    var rows = document.querySelectorAll('table tbody tr, tbody tr');
    rows.forEach(function(tr) {
      var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
        return td.textContent.trim().replace(/\s+/g, ' ');
      });
      var btn = tr.querySelector('button.download-document, button[data-id]');
      var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
      if (cells.length > 2 && cufe) {
        resultado.push({ cells: cells, cufe: cufe });
      }
    });
    return resultado;
  });

  console.log('[DIAN] Filas encontradas en ' + url + ': ' + filas.length);
  return filas;
}

/**
 * Descarga el ZIP de un documento haciendo clic en su boton.
 * Retorna { pdfBuffer, xmlBuffer, xmlText } o null si falla.
 */
async function descargarDocumento(page, cufe) {
  try {
    // Hacer clic en el boton de descarga (sin navegar)
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25000 }),
      page.evaluate(function(id) {
        var btn = document.getElementById(id) ||
                  document.querySelector('button[data-id="' + id + '"]');
        if (btn) { btn.click(); return true; }
        return false;
      }, cufe),
    ]);

    const pathDl = await download.path();
    const suggestedName = download.suggestedFilename();
    const buffer = fs.readFileSync(pathDl);
    console.log('  [DL] ' + suggestedName + ' (' + buffer.length + ' bytes)');

    let pdfBuffer = null, xmlBuffer = null, xmlText = '';

    try {
      const zip = await JSZip.loadAsync(buffer);
      for (const [fname, file] of Object.entries(zip.files)) {
        if (fname.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
        if (fname.toLowerCase().endsWith('.xml')) {
          xmlBuffer = await file.async('nodebuffer');
          xmlText = await file.async('text');
        }
      }
    } catch (zipErr) {
      const ext = (suggestedName || '').toLowerCase();
      if (ext.endsWith('.xml')) { xmlBuffer = buffer; xmlText = buffer.toString('utf8'); }
      else if (ext.endsWith('.pdf')) pdfBuffer = buffer;
    }

    return { pdfBuffer, xmlBuffer, xmlText };
  } catch (err) {
    console.error('  [ERR DL]', err.message);
    return null;
  }
}

async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    // 1. Autenticar
    console.log('[DIAN] Autenticando NIT ' + nit);
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    if (page.url().includes('login') || page.url().includes('Login')) {
      throw new Error('Token invalido o expirado.');
    }
    console.log('[DIAN] Autenticado OK');

    const startDate = toFechaDIAN(fechaInicio);
    const endDate   = toFechaDIAN(fechaFin);

    // 2. Consultar segun el grupo solicitado
    let todasFilas = [];

    if (grupo === 'Emitido') {
      const filasEmitidos = await consultarPagina(page,
        'https://catalogo-vpfe.dian.gov.co/Document/Sent',
        startDate, endDate, fechaInicio, fechaFin
      );
      filasEmitidos.forEach(function(f) { f.grupo = 'Emitido'; });
      todasFilas = filasEmitidos;
    } else if (grupo === 'Recibido') {
      const filasRecibidos = await consultarPagina(page,
        'https://catalogo-vpfe.dian.gov.co/Document/Received',
        startDate, endDate, fechaInicio, fechaFin
      );
      filasRecibidos.forEach(function(f) { f.grupo = 'Recibido'; });
      todasFilas = filasRecibidos;
    } else {
      // Todos: recibidos + emitidos
      const filasRec = await consultarPagina(page,
        'https://catalogo-vpfe.dian.gov.co/Document/Received',
        startDate, endDate, fechaInicio, fechaFin
      );
      filasRec.forEach(function(f) { f.grupo = 'Recibido'; });

      const filasEmi = await consultarPagina(page,
        'https://catalogo-vpfe.dian.gov.co/Document/Sent',
        startDate, endDate, fechaInicio, fechaFin
      );
      filasEmi.forEach(function(f) { f.grupo = 'Emitido'; });

      todasFilas = filasRec.concat(filasEmi);
    }

    console.log('[DIAN] Total filas: ' + todasFilas.length);

    // 3. Descargar ZIP de cada documento
    const documentos = [];

    for (let i = 0; i < todasFilas.length; i++) {
      const fila = todasFilas[i];
      const cufe  = fila.cufe;
      const cells = fila.cells;
      const grp   = fila.grupo;

      // Estructura celdas DIAN: [btn, fecha_recep, fecha_emis, prefijo, folio, tipo, nit_emi, nom_emi, nit_rec, nom_rec, total, estado]
      const fecha   = cells[2] || cells[1] || '';
      const prefijo = cells[3] || '';
      const folio   = cells[4] || '';
      const tipo    = cells[5] || 'Factura electronica';
      const nitEmi  = cells[6] || '';
      const nomEmi  = cells[7] || '';
      const nitRec  = cells[8] || nit;
      const nomRec  = cells[9] || '';
      const nombre  = (prefijo ? prefijo + '-' : '') + folio;

      console.log('[DIAN] Descargando (' + (i+1) + '/' + todasFilas.length + '): ' + nombre);

      // Volver a la pagina correcta si es necesario
      const paginaDestino = grp === 'Emitido'
        ? 'https://catalogo-vpfe.dian.gov.co/Document/Sent'
        : 'https://catalogo-vpfe.dian.gov.co/Document/Received';

      if (!page.url().includes(grp === 'Emitido' ? 'Sent' : 'Received')) {
        await consultarPagina(page, paginaDestino, startDate, endDate, fechaInicio, fechaFin);
      }

      const archivos = await descargarDocumento(page, cufe);

      documentos.push({
        cufe,
        cufeUrl: 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=' + cufe,
        folio: nombre,
        nombre,
        tipo,
        fecha,
        grupo: grp,
        nitEmisor: nitEmi,
        nomEmisor: nomEmi,
        nitReceptor: nitRec,
        nomReceptor: nomRec,
        pdfBuffer: archivos ? archivos.pdfBuffer : null,
        xmlBuffer: archivos ? archivos.xmlBuffer : null,
        xmlText:   archivos ? archivos.xmlText   : '',
      });
    }

    console.log('[DIAN] Descargados: ' + documentos.length);
    return { documentos, nit, total: documentos.length, filasEncontradas: todasFilas.length };

  } finally {
    await browser.close();
  }
}

async function diagnosticarPortal(tokenUrl) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/120' });
  const page = await context.newPage();
  try {
    await page.goto('https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk='+pk+'&rk='+nit+'&token='+token, { waitUntil: 'networkidle', timeout: 40000 });
    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'networkidle', timeout: 30000 });
    const info = await page.evaluate(function() {
      return {
        url: window.location.href, titulo: document.title,
        inputs: Array.from(document.querySelectorAll('input,select')).map(function(el) {
          return { id: el.id, name: el.name, type: el.type, value: el.value.substring(0,80) };
        }),
        html: document.body.innerHTML.substring(0, 5000),
      };
    });
    return { ok: true, nit, ...info };
  } finally { await browser.close(); }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
