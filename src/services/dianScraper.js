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
  } catch(e) { throw new Error('URL del token invalida: ' + e.message); }
}

function toFechaDIAN(iso) {
  const [y, m, d] = iso.split('-');
  return parseInt(m) + '/' + parseInt(d) + '/' + y + ' 12:00:00 AM';
}

/** Divide un rango en sub-rangos mensuales */
function dividirEnMeses(fechaInicio, fechaFin) {
  const rangos = [];
  let cur = new Date(fechaInicio + 'T00:00:00');
  const fin = new Date(fechaFin + 'T00:00:00');
  while (cur <= fin) {
    const ini = cur.toISOString().split('T')[0];
    const ultimoDia = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const endMes = ultimoDia <= fin ? ultimoDia.toISOString().split('T')[0] : fechaFin;
    rangos.push({ desde: ini, hasta: endMes });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return rangos;
}

/**
 * Recarga la pagina con fechas y extrae SOLO la primera pagina de filas.
 * Usa form.submit() + URL params para forzar las fechas.
 */
async function buscarConFechas(page, url, startDate, endDate, startISO, endISO) {
  // Navegar a la pagina
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  // Inyectar fechas directamente en el formulario via JS
  const resultado = await page.evaluate(function(p) {
    // 1. Hidden fields
    var sEl = document.getElementById('startDate');
    var eEl = document.getElementById('endDate');
    if (sEl) sEl.value = p.start;
    if (eEl) eEl.value = p.end;

    // 2. DateRangePicker visible
    var rEl = document.getElementById('dashboard-report-range');
    if (rEl) {
      rEl.value = p.startISO + ' - ' + p.endISO;
      // Disparar el Apply del daterangepicker de bootstrap
      if (window.$ && $(rEl).data('daterangepicker')) {
        try {
          var dr = $(rEl).data('daterangepicker');
          dr.setStartDate(p.startISO);
          dr.setEndDate(p.endISO);
          // Simular el evento apply
          $(rEl).trigger('apply.daterangepicker', [dr]);
        } catch(e) {}
      }
      rEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 3. Verificar que se setearon
    return {
      startSet: sEl ? sEl.value : 'NO',
      endSet: eEl ? eEl.value : 'NO',
      rangeSet: rEl ? rEl.value : 'NO',
    };
  }, { start: startDate, end: endDate, startISO, endISO });

  console.log('[DIAN] Fechas seteadas:', JSON.stringify(resultado));

  // Esperar y hacer submit via AJAX si es posible
  await page.waitForTimeout(500);

  // Hacer clic en Buscar
  await page.evaluate(function() {
    var btns = Array.from(document.querySelectorAll('button, input[type=submit]'));
    var b = btns.find(function(x) { return (x.textContent + (x.value||'')).toLowerCase().includes('buscar'); });
    if (b) b.click();
    else { var f = document.querySelector('form'); if (f) f.submit(); }
  });

  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(function(){});
}

/**
 * Extrae filas de la pagina actual del portal
 */
async function extraerFilasPagina(page) {
  return await page.evaluate(function() {
    var filas = [];
    var rows = document.querySelectorAll('table tbody tr, tbody tr');
    rows.forEach(function(tr) {
      var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
        return td.textContent.trim().replace(/\s+/g, ' ');
      });
      var btn = tr.querySelector('button.download-document, button[data-id]');
      var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
      if (cells.length > 2 && cufe) filas.push({ cells: cells, cufe: cufe });
    });

    // Info paginacion
    var nextBtn = document.querySelector(
      '#tbl-documents_next:not(.disabled), ' +
      'li.paginate_button.next:not(.disabled) a, ' +
      '.next:not(.disabled) a'
    );
    var totalInfo = document.querySelector('#tbl-documents_info, [id*="_info"]');
    return {
      filas: filas,
      hasNext: !!nextBtn,
      info: totalInfo ? totalInfo.textContent.trim() : '',
    };
  });
}

/**
 * Recolecta TODOS los CUFEs de todas las paginas del resultado actual.
 * Navega paginacion sin recargar el formulario.
 */
async function recolectarTodosCUFEs(page) {
  const todos = [];
  let pg = 1;
  const MAX_PG = 25;

  while (pg <= MAX_PG) {
    const datos = await extraerFilasPagina(page);
    todos.push(...datos.filas);
    console.log('[DIAN] Pag ' + pg + ': ' + datos.filas.length + ' filas | total: ' + todos.length + ' | ' + datos.info);

    if (!datos.hasNext || datos.filas.length === 0) break;

    // Click siguiente
    const clicado = await page.evaluate(function() {
      var n = document.querySelector(
        '#tbl-documents_next:not(.disabled), ' +
        'li.paginate_button.next:not(.disabled) a, ' +
        '.paginate_button.next:not(.disabled)'
      );
      if (n) { n.click(); return true; }
      return false;
    });
    if (!clicado) break;
    await page.waitForTimeout(1500);
    pg++;
  }
  return todos;
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
    const name = download.suggestedFilename();
    let pdfBuffer = null, xmlBuffer = null, xmlText = '';
    try {
      const zip = await JSZip.loadAsync(buffer);
      for (const [fn, file] of Object.entries(zip.files)) {
        if (fn.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
        if (fn.toLowerCase().endsWith('.xml')) { xmlBuffer = await file.async('nodebuffer'); xmlText = await file.async('text'); }
      }
    } catch(e) {
      if ((name||'').toLowerCase().endsWith('.xml')) { xmlBuffer = buffer; xmlText = buffer.toString('utf8'); }
      else if ((name||'').toLowerCase().endsWith('.pdf')) pdfBuffer = buffer;
    }
    return { pdfBuffer, xmlBuffer, xmlText };
  } catch(e) {
    console.error('  [ERR DL]', e.message);
    return null;
  }
}

async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);

  // Dividir en rangos mensuales si supera 31 dias
  const ini = new Date(fechaInicio + 'T00:00:00');
  const fin2 = new Date(fechaFin + 'T00:00:00');
  const dias = Math.round((fin2 - ini) / 86400000);
  const rangos = dias > 31 ? dividirEnMeses(fechaInicio, fechaFin) : [{ desde: fechaInicio, hasta: fechaFin }];
  console.log('[DIAN] Rangos a procesar:', rangos.length, '(' + dias + ' dias)');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
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
      'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk='+pk+'&rk='+nit+'&token='+token,
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    if (page.url().includes('login') || page.url().includes('Login')) throw new Error('Token invalido o expirado.');

    // FASE 1: Recolectar TODOS los CUFEs por rango y grupo
    const todosLosCUFEs = []; // { cufe, cells, grupo }

    for (const rango of rangos) {
      console.log('[DIAN] Rango: ' + rango.desde + ' a ' + rango.hasta);
      const startDate = toFechaDIAN(rango.desde);
      const endDate   = toFechaDIAN(rango.hasta);

      const urls = [];
      if (grupo === 'Recibido' || !grupo) urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/Document/Received', grp: 'Recibido' });
      if (grupo === 'Emitido'  || !grupo) urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/Document/Sent', grp: 'Emitido' });

      for (const destino of urls) {
        await buscarConFechas(page, destino.url, startDate, endDate, rango.desde, rango.hasta);
        const filas = await recolectarTodosCUFEs(page);
        filas.forEach(function(f) { f.grupo = destino.grp; f.rango = rango.desde + '/' + rango.hasta; });
        // Deduplicar por CUFE
        filas.forEach(function(f) {
          if (!todosLosCUFEs.find(function(x){ return x.cufe === f.cufe; })) {
            todosLosCUFEs.push(f);
          }
        });
        console.log('[DIAN] ' + destino.grp + ' ' + rango.desde + ': ' + filas.length + ' | Total acum: ' + todosLosCUFEs.length);
      }
    }

    console.log('[DIAN] TOTAL CUFEs recolectados: ' + todosLosCUFEs.length);

    // FASE 2: Descargar documentos
    const documentos = [];
    let lastUrl = '';

    for (let i = 0; i < todosLosCUFEs.length; i++) {
      const fila = todosLosCUFEs[i];
      const cufe  = fila.cufe;
      const cells = fila.cells;
      const grp   = fila.grupo;
      const [desde, hasta] = (fila.rango || fechaInicio + '/' + fechaFin).split('/').slice(0, 2).concat([fechaFin]);

      const fecha   = cells[2] || cells[1] || '';
      const prefijo = cells[3] || '';
      const folio   = cells[4] || '';
      const tipo    = cells[5] || 'Factura electronica';
      const nitEmi  = cells[6] || '';
      const nomEmi  = cells[7] || '';
      const nitRec  = cells[8] || nit;
      const nomRec  = cells[9] || '';
      const nombre  = (prefijo ? prefijo+'-' : '') + folio;

      console.log('[DIAN] DL (' + (i+1) + '/' + todosLosCUFEs.length + ') ' + nombre);

      // Si el boton no esta visible, recargar la pagina con las fechas del rango
      const paginaUrl = grp === 'Emitido'
        ? 'https://catalogo-vpfe.dian.gov.co/Document/Sent'
        : 'https://catalogo-vpfe.dian.gov.co/Document/Received';

      const rangoDesde = fila.rango ? fila.rango.split('/')[0] : fechaInicio;
      const rangoHasta = fila.rango ? fila.rango.split('/')[1] : fechaFin;

      const btnVisible = await page.evaluate(function(cuf) {
        return !!document.querySelector('button[data-id="' + cuf + '"], button#' + cuf);
      }, cufe);

      if (!btnVisible) {
        await buscarConFechas(page, paginaUrl, toFechaDIAN(rangoDesde), toFechaDIAN(rangoHasta), rangoDesde, rangoHasta);
        // Navegar hasta la pagina que tiene el boton
        let encontrado = false;
        let pg = 1;
        while (pg <= 25 && !encontrado) {
          encontrado = await page.evaluate(function(cuf) {
            return !!document.querySelector('button[data-id="' + cuf + '"], button#' + cuf);
          }, cufe);
          if (encontrado) break;
          const ok = await page.evaluate(function() {
            var n = document.querySelector('#tbl-documents_next:not(.disabled), li.paginate_button.next:not(.disabled) a');
            if (n) { n.click(); return true; } return false;
          });
          if (!ok) break;
          await page.waitForTimeout(1000);
          pg++;
        }
      }

      const archivos = await descargarDocumento(page, cufe);
      documentos.push({
        cufe, cufeUrl: 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey='+cufe,
        folio: nombre, nombre, tipo, fecha, grupo: grp,
        nitEmisor: nitEmi, nomEmisor: nomEmi, nitReceptor: nitRec, nomReceptor: nomRec,
        pdfBuffer: archivos?.pdfBuffer || null,
        xmlBuffer: archivos?.xmlBuffer || null,
        xmlText:   archivos?.xmlText   || '',
      });
    }

    console.log('[DIAN] Descargados: ' + documentos.length);
    return { documentos, nit, total: documentos.length, filasEncontradas: todosLosCUFEs.length };

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
