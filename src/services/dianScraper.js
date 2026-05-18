const { chromium } = require('playwright');
const JSZip = require('jszip');
const fs = require('fs');
const XLSX = require('xlsx');

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
 * PASO 1: Descarga el Excel de listados (Opcion 3 del portal DIAN)
 * Retorna buffer del Excel con TODOS los documentos del periodo.
 * Sin paginacion, sin problemas — la DIAN exporta hasta 100.000 docs.
 */
async function descargarExcelListados(page, startDate, endDate, startISO, endISO) {
  await page.goto('https://catalogo-vpfe.dian.gov.co/Document/DownloadListByDate', { waitUntil: 'networkidle', timeout: 30000 });
  console.log('[DIAN] Pagina listados cargada');

  // Inyectar fechas
  await page.evaluate(function(p) {
    var sEl = document.getElementById('startDate');
    var eEl = document.getElementById('endDate');
    if (sEl) sEl.value = p.start;
    if (eEl) eEl.value = p.end;
    var rEl = document.getElementById('dashboard-report-range');
    if (rEl) {
      rEl.value = p.startISO + ' - ' + p.endISO;
      rEl.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.$ && $(rEl).data && $(rEl).data('daterangepicker')) {
        try { var dr = $(rEl).data('daterangepicker'); dr.setStartDate(p.startISO); dr.setEndDate(p.endISO); } catch(e) {}
      }
    }
  }, { start: startDate, end: endDate, startISO, endISO });

  // Hacer click en "Exportar Excel"
  console.log('[DIAN] Descargando Excel de listados...');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.evaluate(function() {
      var btns = Array.from(document.querySelectorAll('button, a'));
      var b = btns.find(function(x) {
        return (x.textContent || '').toLowerCase().includes('exportar') ||
               (x.textContent || '').toLowerCase().includes('excel') ||
               (x.id || '').toLowerCase().includes('excel');
      });
      if (b) { b.click(); return b.textContent; }
      return null;
    }),
  ]);

  const pathDl = await download.path();
  const buffer = fs.readFileSync(pathDl);
  const nombre = download.suggestedFilename();
  console.log('[DIAN] Excel listados descargado: ' + nombre + ' (' + buffer.length + ' bytes)');
  return buffer;
}

/**
 * Parsea el Excel de listados y extrae los CUFEs con metadatos.
 * Columnas: Tipo(0), CUFE(1), Folio(2), Prefijo(3), Divisa(4),
 *   FormaPago(5), MedioPago(6), FechaEmision(7), FechaRecepcion(8),
 *   NITEmisor(9), NombreEmisor(10), NITReceptor(11), NombreReceptor(12),
 *   IVA(13), ..., Total(29), Estado(30), Grupo(31)
 */
function parsearExcelCUFEs(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const documentos = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cufe = String(r[1] || '').trim();
    if (!cufe || cufe.length < 20) continue;
    documentos.push({
      tipo:          String(r[0]  || ''),
      cufe,
      folio:         String(r[2]  || ''),
      prefijo:       String(r[3]  || ''),
      fecha:         String(r[7]  || r[8] || ''),
      nitEmisor:     String(r[9]  || ''),
      nomEmisor:     String(r[10] || ''),
      nitReceptor:   String(r[11] || ''),
      nomReceptor:   String(r[12] || ''),
      iva:           Number(r[13] || 0),
      inc:           Number(r[16] || 0),
      total:         Number(r[29] || 0),
      estado:        String(r[30] || ''),
      grupo:         String(r[31] || ''),
      nombre:        (r[3] ? r[3] + '-' : '') + String(r[2] || ''),
      cufeUrl:       'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=' + String(r[1] || ''),
    });
  }
  return documentos;
}

/**
 * PASO 2: Para cada CUFE, navega a la pagina del documento y descarga el ZIP.
 * Usa la pagina de recibidos o enviados segun el grupo del documento.
 */
async function descargarDocumentoPorCUFE(page, doc, startDate, endDate, startISO, endISO) {
  const { cufe, grupo } = doc;
  const url = grupo === 'Emitido'
    ? 'https://catalogo-vpfe.dian.gov.co/Document/Sent'
    : 'https://catalogo-vpfe.dian.gov.co/Document/Received';

  // Buscar el boton en la pagina actual
  let btn = await page.evaluate(function(cuf) {
    var el = document.getElementById(cuf);
    if (el) return true;
    var btns = document.querySelectorAll('button[data-id]');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-id') === cuf) return true;
    }
    return false;
  }, cufe);

  // Si no esta en la pagina actual, recargar con fechas y buscar
  if (!btn) {
    await buscarEnPagina(page, url, startDate, endDate, startISO, endISO);
    // Navegar por paginas hasta encontrar el boton
    let pg = 1;
    while (pg <= 30) {
      btn = await page.evaluate(function(cuf) {
        var el = document.getElementById(cuf);
        if (el) return true;
        var btns = document.querySelectorAll('button[data-id]');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute('data-id') === cuf) return true;
        }
        return false;
      }, cufe);
      if (btn) break;
      const next = await page.evaluate(function() {
        var n = document.querySelector('#tbl-documents_next:not(.disabled), .paginate_button.next:not(.disabled)');
        if (n) { n.click(); return true; } return false;
      });
      if (!next) break;
      await page.waitForTimeout(1200);
      pg++;
    }
  }

  if (!btn) {
    console.log('  [SKIP] Boton no encontrado para ' + doc.nombre);
    return null;
  }

  // Hacer clic y capturar descarga
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25000 }),
      page.evaluate(function(cuf) {
        var el = document.getElementById(cuf);
        if (!el) {
          var btns = document.querySelectorAll('button[data-id]');
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].getAttribute('data-id') === cuf) { el = btns[i]; break; }
          }
        }
        if (el) { el.click(); return true; } return false;
      }, cufe),
    ]);
    const buffer = fs.readFileSync(await download.path());
    let pdfBuffer = null, xmlBuffer = null, xmlText = '';
    try {
      const zip = await JSZip.loadAsync(buffer);
      for (const [fn, file] of Object.entries(zip.files)) {
        if (fn.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
        if (fn.toLowerCase().endsWith('.xml')) { xmlBuffer = await file.async('nodebuffer'); xmlText = await file.async('text'); }
      }
    } catch(e) {
      const n = (download.suggestedFilename()||'').toLowerCase();
      if (n.endsWith('.xml')) { xmlBuffer = buffer; xmlText = buffer.toString('utf8'); }
      else if (n.endsWith('.pdf')) pdfBuffer = buffer;
    }
    return { pdfBuffer, xmlBuffer, xmlText };
  } catch(e) {
    console.error('  [ERR]', e.message);
    return null;
  }
}

async function buscarEnPagina(page, url, startDate, endDate, startISO, endISO) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(function(p) {
    var sEl = document.getElementById('startDate'); if (sEl) sEl.value = p.start;
    var eEl = document.getElementById('endDate');   if (eEl) eEl.value = p.end;
    var rEl = document.getElementById('dashboard-report-range');
    if (rEl) { rEl.value = p.startISO+' - '+p.endISO; rEl.dispatchEvent(new Event('change',{bubbles:true})); }
    if (window.$ && rEl) { try { var dr=$(rEl).data('daterangepicker'); if(dr){dr.setStartDate(p.startISO);dr.setEndDate(p.endISO);} } catch(e){} }
  }, { start: startDate, end: endDate, startISO, endISO });
  await page.evaluate(function() {
    var b = Array.from(document.querySelectorAll('button,input[type=submit]')).find(function(x){ return (x.textContent+'').toLowerCase().includes('buscar'); });
    if (b) b.click(); else { var f=document.querySelector('form'); if(f) f.submit(); }
  });
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(function(){});
}

// ── FUNCION PRINCIPAL ──────────────────────────────────────────
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const dias = Math.round((new Date(fechaFin+'T00:00:00') - new Date(fechaInicio+'T00:00:00')) / 86400000);
  const rangos = dias > 31 ? dividirEnMeses(fechaInicio, fechaFin) : [{ desde: fechaInicio, hasta: fechaFin }];
  console.log('[DIAN] Rangos:', rangos.length, '| Dias:', dias);

  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    // Autenticar
    console.log('[DIAN] Autenticando NIT ' + nit);
    await page.goto('https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk='+pk+'&rk='+nit+'&token='+token, { waitUntil: 'networkidle', timeout: 40000 });
    if (page.url().includes('login') || page.url().includes('Login')) throw new Error('Token invalido o expirado.');

    // FASE 1: Obtener todos los CUFEs via Excel de listados
    let todosDocumentos = [];

    for (const rango of rangos) {
      const startDate = toFechaDIAN(rango.desde);
      const endDate   = toFechaDIAN(rango.hasta);
      console.log('[DIAN] Rango: ' + rango.desde + ' a ' + rango.hasta);

      const xlsBuffer = await descargarExcelListados(page, startDate, endDate, rango.desde, rango.hasta);
      const docsRango = parsearExcelCUFEs(xlsBuffer);

      // Filtrar por grupo si aplica
      const docsFiltrados = grupo ? docsRango.filter(function(d){ return d.grupo === grupo; }) : docsRango;
      console.log('[DIAN] Rango ' + rango.desde + ': ' + docsRango.length + ' total | ' + docsFiltrados.length + ' filtrados');

      // Deduplicar por CUFE
      docsFiltrados.forEach(function(d) {
        if (!todosDocumentos.find(function(x){ return x.cufe === d.cufe; })) {
          d.rangoDesde = rango.desde; d.rangoHasta = rango.hasta;
          todosDocumentos.push(d);
        }
      });
    }

    console.log('[DIAN] TOTAL CUFEs del Excel: ' + todosDocumentos.length);

    // FASE 2: Descargar ZIP (PDF+XML) de cada documento
    const documentos = [];
    let lastGrp = '';
    let lastRango = { desde: fechaInicio, hasta: fechaFin };

    for (let i = 0; i < todosDocumentos.length; i++) {
      const doc = todosDocumentos[i];
      console.log('[DIAN] DL (' + (i+1) + '/' + todosDocumentos.length + ') ' + doc.nombre);

      // Si cambia el grupo o rango, recargar la pagina de busqueda
      const rDesde = doc.rangoDesde || fechaInicio;
      const rHasta = doc.rangoHasta || fechaFin;
      const curUrl = page.url();
      const expectedPart = doc.grupo === 'Emitido' ? 'Sent' : 'Received';
      if (!curUrl.includes(expectedPart) || doc.grupo !== lastGrp) {
        const pUrl = doc.grupo === 'Emitido' ? 'https://catalogo-vpfe.dian.gov.co/Document/Sent' : 'https://catalogo-vpfe.dian.gov.co/Document/Received';
        await buscarEnPagina(page, pUrl, toFechaDIAN(rDesde), toFechaDIAN(rHasta), rDesde, rHasta);
        lastGrp = doc.grupo; lastRango = { desde: rDesde, hasta: rHasta };
      }

      const archivos = await descargarDocumentoPorCUFE(page, doc, toFechaDIAN(rDesde), toFechaDIAN(rHasta), rDesde, rHasta);

      documentos.push({
        ...doc,
        pdfBuffer: archivos ? archivos.pdfBuffer : null,
        xmlBuffer: archivos ? archivos.xmlBuffer : null,
        xmlText:   archivos ? archivos.xmlText   : '',
      });
    }

    console.log('[DIAN] Descargados: ' + documentos.length);
    return { documentos, nit, total: documentos.length, filasEncontradas: todosDocumentos.length };

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
