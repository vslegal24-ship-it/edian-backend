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
 * Extrae TODOS los registros usando la API de DataTables.
 * Esto evita tener que paginar manualmente.
 */
async function recolectarTodosCUFEs(page) {
  // Esperar a que DataTables cargue
  await page.waitForTimeout(2000);

  const resultado = await page.evaluate(function() {
    var filas = [];

    // Metodo 1: API de DataTables (mas confiable - obtiene todos los registros)
    try {
      if (window.$ && $.fn.DataTable) {
        var tables = $('table.dataTable, table[id*="tbl"]');
        if (tables.length > 0) {
          var dt = tables.first().DataTable();
          var totalRows = dt.rows().count();
          console.log('[DT] Total registros en DataTable:', totalRows);

          // Cambiar page length a ALL para ver todos
          dt.page.len(-1).draw(false);

          // Esperar redibujado no es posible en sync, usamos rows()
          dt.rows().every(function() {
            var node = this.node();
            var cells = Array.from(node.querySelectorAll('td')).map(function(td) {
              return td.textContent.trim().replace(/\s+/g, ' ');
            });
            var btn = node.querySelector('button.download-document, button[data-id]');
            var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
            if (cells.length > 2 && cufe) filas.push({ cells: cells, cufe: cufe });
          });

          if (filas.length > 0) {
            return { filas: filas, metodo: 'datatable-api', total: totalRows };
          }
        }
      }
    } catch(e) {
      console.log('[DT] Error API:', e.message);
    }

    // Metodo 2: Extraer de TODOS los tr incluyendo los ocultos por paginacion
    try {
      var allRows = document.querySelectorAll('table tbody tr');
      allRows.forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
          return td.textContent.trim().replace(/\s+/g, ' ');
        });
        var btn = tr.querySelector('button.download-document, button[data-id]');
        var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
        if (cells.length > 2 && cufe) filas.push({ cells: cells, cufe: cufe });
      });
      return { filas: filas, metodo: 'querySelectorAll', total: filas.length };
    } catch(e) {
      return { filas: [], metodo: 'error', total: 0, error: e.message };
    }
  });

  console.log('[DIAN] Metodo: ' + resultado.metodo + ' | Filas: ' + resultado.filas.length + ' | Total DT: ' + resultado.total);

  // Si DataTables solo dio la pagina visible, paginar manualmente como fallback
  if (resultado.filas.length <= 10 && resultado.metodo !== 'datatable-api') {
    console.log('[DIAN] Fallback: paginacion manual...');
    return await recolectarPorPaginacion(page, resultado.filas);
  }

  return resultado.filas;
}

/**
 * Fallback: navega pagina por pagina (maximo 25 paginas)
 */
async function recolectarPorPaginacion(page, filasIniciales) {
  const todos = [...filasIniciales];
  let pg = 2; // Ya tenemos pag 1

  while (pg <= 25) {
    // Buscar y hacer clic en el numero de pagina o "Siguiente"
    const clicado = await page.evaluate(function(pgNum) {
      // Intentar clic en numero de pagina especifico
      var pageLinks = document.querySelectorAll('.paginate_button:not(.previous):not(.next):not(.first):not(.last):not(.disabled):not(.active)');
      for (var i = 0; i < pageLinks.length; i++) {
        if (pageLinks[i].textContent.trim() === String(pgNum)) {
          pageLinks[i].click();
          return 'pag-' + pgNum;
        }
      }
      // Intentar "Siguiente"
      var next = document.querySelector(
        '#tbl-documents_next:not(.disabled), ' +
        'a.paginate_button.next:not(.disabled), ' +
        '.paginate_button.next:not(.disabled) a'
      );
      if (next) { next.click(); return 'next'; }
      return null;
    }, pg);

    if (!clicado) break;
    await page.waitForTimeout(1500);

    const filasPag = await page.evaluate(function() {
      var filas = [];
      var rows = document.querySelectorAll('table tbody tr');
      rows.forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
          return td.textContent.trim().replace(/\s+/g, ' ');
        });
        var btn = tr.querySelector('button.download-document, button[data-id]');
        var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
        if (cells.length > 2 && cufe) filas.push({ cells: cells, cufe: cufe });
      });
      var isLast = !document.querySelector(
        '#tbl-documents_next:not(.disabled), .paginate_button.next:not(.disabled) a'
      );
      return { filas: filas, isLast: isLast };
    });

    console.log('[DIAN] Pag ' + pg + ': ' + filasPag.filas.length + ' filas');
    // Deduplicar
    filasPag.filas.forEach(function(f) {
      if (!todos.find(function(x){ return x.cufe === f.cufe; })) todos.push(f);
    });

    if (filasPag.isLast || filasPag.filas.length === 0) break;
    pg++;
  }

  return todos;
}

async function descargarDocumento(page, cufe) {
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25000 }),
      page.evaluate(function(id) {
        var btn = document.getElementById(id);
        if (!btn) {
          var btns = document.querySelectorAll('button[data-id]');
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].getAttribute('data-id') === id) { btn = btns[i]; break; }
          }
        }
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
        if (document.getElementById(cuf)) return true;
        var btns = document.querySelectorAll('button[data-id]');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute('data-id') === cuf) return true;
        }
        return false;
      }, cufe);

      if (!btnVisible) {
        await buscarConFechas(page, paginaUrl, toFechaDIAN(rangoDesde), toFechaDIAN(rangoHasta), rangoDesde, rangoHasta);
        // Navegar hasta la pagina que tiene el boton
        let encontrado = false;
        let pg = 1;
        while (pg <= 25 && !encontrado) {
          encontrado = await page.evaluate(function(cuf) {
            if (document.getElementById(cuf)) return true;
            var btns = document.querySelectorAll('button[data-id]');
            for (var i = 0; i < btns.length; i++) {
              if (btns[i].getAttribute('data-id') === cuf) return true;
            }
            return false;
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
