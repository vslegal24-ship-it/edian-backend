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
 * Extrae TODAS las filas de una pagina de resultados,
 * navegando por todas las paginas de paginacion.
 */
async function extraerTodasLasFilas(page) {
  let todasFilas = [];
  let pagina = 1;

  while (true) {
    await page.waitForTimeout(1500);

    // Extraer filas de la pagina actual
    const filasPagina = await page.evaluate(function() {
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

      // Info de paginacion
      var info = document.querySelector('[class*="dataTables_info"], .pagination-info, #tbl-documents_info');
      var infoText = info ? info.textContent.trim() : '';
      var nextBtn = document.querySelector('[id*="_next"], .next:not(.disabled), li.next:not(.disabled) a');
      var nextDisabled = nextBtn
        ? (nextBtn.classList.contains('disabled') || nextBtn.closest('li.disabled') !== null)
        : true;

      return {
        filas: resultado,
        infoText: infoText,
        hasNext: !nextDisabled && nextBtn !== null,
        nextSelector: nextBtn ? nextBtn.tagName + (nextBtn.id ? '#'+nextBtn.id : '') : '',
      };
    });

    console.log('[DIAN] Pag ' + pagina + ': ' + filasPagina.filas.length + ' filas | ' + filasPagina.infoText);
    todasFilas = todasFilas.concat(filasPagina.filas);

    if (!filasPagina.hasNext) {
      console.log('[DIAN] Ultima pagina alcanzada');
      break;
    }

    // Ir a la siguiente pagina
    console.log('[DIAN] Siguiente pagina...');
    try {
      await Promise.all([
        page.waitForResponse(function(r) {
          return r.url().includes('/Document/') && r.status() === 200;
        }, { timeout: 10000 }).catch(function() {}),
        page.evaluate(function() {
          var next = document.querySelector('[id*="_next"]:not(.disabled), li.next:not(.disabled) a, .paginate_button.next:not(.disabled)');
          if (next) { next.click(); return true; }
          return false;
        }),
      ]);
      pagina++;
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log('[DIAN] Error navegando pagina:', e.message);
      break;
    }

    // Limite de seguridad: max 20 paginas (1000 docs)
    if (pagina > 20) {
      console.log('[DIAN] Limite de paginas alcanzado');
      break;
    }
  }

  return todasFilas;
}

/**
 * Navega a una pagina del portal, inyecta fechas y busca.
 * Retorna todas las filas (paginadas).
 */
async function consultarPagina(page, url, startDate, endDate, startISO, endISO) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('[DIAN] Pagina: ' + page.url());

  // Inyectar fechas en hidden fields y daterangepicker
  await page.evaluate(function(p) {
    var sEl = document.getElementById('startDate');
    var eEl = document.getElementById('endDate');
    if (sEl) sEl.value = p.start;
    if (eEl) eEl.value = p.end;

    var rEl = document.getElementById('dashboard-report-range');
    if (rEl) {
      rEl.value = p.startISO + ' - ' + p.endISO;
      rEl.dispatchEvent(new Event('change', { bubbles: true }));
      rEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (window.$ && rEl) {
      try {
        var dr = $(rEl).data('daterangepicker');
        if (dr) { dr.setStartDate(p.startISO); dr.setEndDate(p.endISO); }
      } catch(e) {}
    }
  }, { start: startDate, end: endDate, startISO, endISO });

  // Hacer clic en Buscar
  await page.evaluate(function() {
    var btns = Array.from(document.querySelectorAll('button, input[type=submit]'));
    var b = btns.find(function(x) {
      return (x.textContent + (x.value||'')).toLowerCase().includes('buscar');
    });
    if (b) b.click();
    else { var f = document.querySelector('form'); if (f) f.submit(); }
  });

  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function() {});

  // Extraer TODAS las filas (todas las paginas)
  return await extraerTodasLasFilas(page);
}

async function descargarDocumento(page, cufe) {
  try {
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
    const buffer = fs.readFileSync(pathDl);
    const suggestedName = download.suggestedFilename();
    console.log('  [DL] ' + suggestedName + ' (' + buffer.length + 'b)');

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
    // Autenticar
    console.log('[DIAN] Autenticando NIT ' + nit);
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    if (page.url().includes('login') || page.url().includes('Login')) {
      throw new Error('Token invalido o expirado.');
    }

    const startDate = toFechaDIAN(fechaInicio);
    const endDate   = toFechaDIAN(fechaFin);
    console.log('[DIAN] Periodo: ' + fechaInicio + ' a ' + fechaFin);

    // Consultar segun grupo
    let todasFilas = [];

    if (grupo === 'Emitido') {
      const f = await consultarPagina(page, 'https://catalogo-vpfe.dian.gov.co/Document/Sent', startDate, endDate, fechaInicio, fechaFin);
      f.forEach(function(r) { r.grupo = 'Emitido'; });
      todasFilas = f;
    } else if (grupo === 'Recibido') {
      const f = await consultarPagina(page, 'https://catalogo-vpfe.dian.gov.co/Document/Received', startDate, endDate, fechaInicio, fechaFin);
      f.forEach(function(r) { r.grupo = 'Recibido'; });
      todasFilas = f;
    } else {
      // Todos: recibidos + emitidos
      const fRec = await consultarPagina(page, 'https://catalogo-vpfe.dian.gov.co/Document/Received', startDate, endDate, fechaInicio, fechaFin);
      fRec.forEach(function(r) { r.grupo = 'Recibido'; });

      const fEmi = await consultarPagina(page, 'https://catalogo-vpfe.dian.gov.co/Document/Sent', startDate, endDate, fechaInicio, fechaFin);
      fEmi.forEach(function(r) { r.grupo = 'Emitido'; });

      todasFilas = fRec.concat(fEmi);
    }

    console.log('[DIAN] TOTAL filas todas las paginas: ' + todasFilas.length);

    // Descargar documentos
    const documentos = [];
    for (let i = 0; i < todasFilas.length; i++) {
      const fila = todasFilas[i];
      const cufe  = fila.cufe;
      const cells = fila.cells;
      const grp   = fila.grupo;

      const fecha   = cells[2] || cells[1] || '';
      const prefijo = cells[3] || '';
      const folio   = cells[4] || '';
      const tipo    = cells[5] || 'Factura electronica';
      const nitEmi  = cells[6] || '';
      const nomEmi  = cells[7] || '';
      const nitRec  = cells[8] || nit;
      const nomRec  = cells[9] || '';
      const nombre  = (prefijo ? prefijo + '-' : '') + folio;

      console.log('[DIAN] (' + (i+1) + '/' + todasFilas.length + ') ' + nombre);

      // Volver a la pagina correcta si es necesario
      const paginaDestino = grp === 'Emitido'
        ? 'https://catalogo-vpfe.dian.gov.co/Document/Sent'
        : 'https://catalogo-vpfe.dian.gov.co/Document/Received';

      if (!page.url().includes(grp === 'Emitido' ? 'Sent' : 'Received')) {
        await consultarPagina(page, paginaDestino, startDate, endDate, fechaInicio, fechaFin);
      }

      // Buscar el boton en la pagina actual
      const btnEnPagina = await page.evaluate(function(cuf) {
        return !!document.querySelector('button[data-id="' + cuf + '"], #' + cuf);
      }, cufe);

      if (!btnEnPagina) {
        // Necesita navegar a la pagina correcta del resultado
        console.log('  Boton no visible, buscando en paginacion...');
        // Buscar en todas las paginas de resultados
        let found = false;
        let pg = 1;
        while (pg <= 20 && !found) {
          const en = await page.evaluate(function(cuf) {
            return !!document.querySelector('button[data-id="' + cuf + '"], button#' + cuf);
          }, cufe);
          if (en) { found = true; break; }
          // Ir a siguiente pagina
          const hasNext2 = await page.evaluate(function() {
            var n = document.querySelector('[id*="_next"]:not(.disabled), li.next:not(.disabled) a');
            if (n) { n.click(); return true; }
            return false;
          });
          if (!hasNext2) break;
          await page.waitForTimeout(1500);
          pg++;
        }
      }

      const archivos = await descargarDocumento(page, cufe);

      documentos.push({
        cufe,
        cufeUrl: 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=' + cufe,
        folio: nombre, nombre, tipo, fecha, grupo: grp,
        nitEmisor: nitEmi, nomEmisor: nomEmi,
        nitReceptor: nitRec, nomReceptor: nomRec,
        pdfBuffer: archivos ? archivos.pdfBuffer : null,
        xmlBuffer: archivos ? archivos.xmlBuffer : null,
        xmlText:   archivos ? archivos.xmlText   : '',
      });
    }

    console.log('[DIAN] Descargados: ' + documentos.length + ' de ' + todasFilas.length);
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
      return { url: window.location.href, titulo: document.title,
        inputs: Array.from(document.querySelectorAll('input,select')).map(function(el) {
          return { id: el.id, name: el.name, type: el.type, value: el.value.substring(0,80) };
        }), html: document.body.innerHTML.substring(0, 5000) };
    });
    return { ok: true, nit, ...info };
  } finally { await browser.close(); }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
