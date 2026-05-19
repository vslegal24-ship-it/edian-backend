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
 * Autentica y retorna la pagina con sesion activa.
 */
async function autenticar(context, page, pk, nit, token) {
  console.log('[DIAN] Autenticando NIT ' + nit);
  await page.goto(
    'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
    { waitUntil: 'networkidle', timeout: 40000 }
  );
  if (page.url().includes('login') || page.url().includes('Login')) {
    throw new Error('Token invalido o expirado. Solicita un nuevo token en la DIAN.');
  }
  console.log('[DIAN] Autenticado OK — URL: ' + page.url());
}

/**
 * Obtiene TODOS los CUFEs interceptando la llamada AJAX de DataTables.
 * Cuando el portal hace la busqueda, interceptamos la peticion y la
 * repetimos con length=10000 para traer todos los registros.
 */
async function obtenerCUFEsViaAjax(page, url, startDate, endDate, startISO, endISO) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('[DIAN] Pagina cargada: ' + page.url());

  // Inyectar fechas
  await page.evaluate(function(p) {
    var sEl = document.getElementById('startDate'); if (sEl) sEl.value = p.start;
    var eEl = document.getElementById('endDate');   if (eEl) eEl.value = p.end;
    var rEl = document.getElementById('dashboard-report-range');
    if (rEl) {
      rEl.value = p.startISO + ' - ' + p.endISO;
      rEl.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.$ && $(rEl).data) {
        try { var dr = $(rEl).data('daterangepicker'); if (dr) { dr.setStartDate(p.startISO); dr.setEndDate(p.endISO); } } catch(e) {}
      }
    }
  }, { start: startDate, end: endDate, startISO, endISO });

  // Configurar interceptor ANTES de hacer busqueda
  let ajaxUrl = null;
  let ajaxPayload = null;
  let ajaxHeaders = {};

  page.on('request', function(req) {
    const u = req.url();
    const m = req.method();
    if (m === 'POST' && (u.includes('GetDocuments') || u.includes('datatables') || u.includes('DataTable') || u.includes('ajax'))) {
      ajaxUrl = u;
      ajaxPayload = req.postData();
      ajaxHeaders = req.headers();
      console.log('[AJAX] Interceptado: ' + u);
    }
  });

  // Tambien interceptar respuestas para capturar la URL del DataTable
  const respuestasCapturadas = [];
  page.on('response', async function(resp) {
    try {
      const u = resp.url();
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('json') && u.includes('catalogo-vpfe.dian.gov.co') && resp.status() === 200) {
        const body = await resp.text();
        if (body.includes('"data"') || body.includes('"recordsTotal"') || body.includes('"cufe"') || body.includes('"Cufe"')) {
          respuestasCapturadas.push({ url: u, body: body.substring(0, 2000) });
          console.log('[AJAX RESP] JSON de DIAN: ' + u + ' | ' + body.substring(0, 100));
        }
      }
    } catch(e) {}
  });

  // Hacer busqueda
  await page.evaluate(function() {
    var b = Array.from(document.querySelectorAll('button, input[type=submit]')).find(function(x) {
      return (x.textContent + (x.value||'')).toLowerCase().includes('buscar');
    });
    if (b) b.click();
    else { var f = document.querySelector('form'); if (f) f.submit(); }
  });

  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function(){});

  console.log('[DIAN] AJAX URL interceptada:', ajaxUrl);
  console.log('[DIAN] Respuestas JSON capturadas:', respuestasCapturadas.length);

  // Si capturamos el AJAX, repetirlo con length=10000
  if (ajaxUrl) {
    try {
      // Modificar el payload para traer todos los registros
      let nuevoPayload = ajaxPayload || '';
      nuevoPayload = nuevoPayload.replace(/length=-?\d+/, 'length=10000').replace(/length%3D-?\d+/, 'length%3D10000');
      if (!nuevoPayload.includes('length')) nuevoPayload += '&length=10000&start=0';

      const respAll = await page.evaluate(async function(params) {
        try {
          var resp = await fetch(params.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
            body: params.payload,
            credentials: 'include',
          });
          var text = await resp.text();
          return { ok: resp.ok, status: resp.status, body: text };
        } catch(e) { return { error: e.message }; }
      }, { url: ajaxUrl, payload: nuevoPayload });

      if (respAll && respAll.ok && respAll.body) {
        console.log('[DIAN] Respuesta AJAX completa: ' + respAll.body.length + ' chars');
        const data = JSON.parse(respAll.body);
        const rows = data.data || data.Data || data.rows || data.Rows || [];
        console.log('[DIAN] Registros en AJAX: ' + rows.length);
        if (rows.length > 0) return parsearFilasAjax(rows);
      }
    } catch(e) {
      console.log('[DIAN] Error repitiendo AJAX:', e.message);
    }
  }

  // Fallback: extraer de la UI con DataTables API
  return await extraerViaDataTables(page);
}

/**
 * Parsea las filas que vienen del AJAX de la DIAN.
 * Los campos pueden venir en diferentes formatos.
 */
function parsearFilasAjax(rows) {
  // Log first row to see all available fields
  if (rows.length > 0) console.log('[AJAX] Campos disponibles:', Object.keys(rows[0]).join(', '));

  const resultado = [];
  rows.forEach(function(r) {
    // El CUFE viene en el campo "Id" segun la DIAN
    const cufe = r.Id || r.id || r.cufe || r.Cufe || r.CUFE || r.documentKey || r.DocumentKey || r.uuid || r.UUID || '';
    if (!cufe || cufe.length < 20) return;

    // Extraer todos los campos disponibles
    // Campos DIAN conocidos del JSON: Id, FechaEmision, FechaRecepcion, Prefijo, NumeroDocumento,
    // TipoDocumento, NitEmisor, NombreEmisor, NitReceptor, NombreReceptor, Total, Estado
    // Campos reales del JSON de la DIAN (confirmados via log)
    const folio   = r.Number   || r.NumeroDocumento || '';
    const prefijo = r.Serie    || r.Prefijo || '';
    const fecha   = r.EmissionDate || r.ReceptionDate || '';
    const tipo    = r.DocumentTypeName || r.TipoDocumento || 'Factura electronica';
    const nitEmi  = r.SenderCode   || '';
    const nomEmi  = r.SenderName   || '';
    const nitRec  = r.ReceiverCode || '';
    const nomRec  = r.ReceiverName || '';
    const total   = r.TotalAmount  || r.Amount || 0;
    const iva     = r.TaxAmountIva || 0;
    const estado  = r.StatusName   || '';
    const nombre  = (prefijo ? prefijo + '-' : '') + folio;

    resultado.push({
      cufe: String(cufe),
      cells: [tipo, String(cufe), folio, prefijo, '', '', '', fecha, '', nitEmi, nomEmi, nitRec, nomRec],
      tipo, fecha, prefijo, folio, nombre,
      nitEmisor: nitEmi, nomEmisor: nomEmi,
      nitReceptor: nitRec, nomReceptor: nomRec,
      total, iva, estado,
    });
  });
  console.log('[AJAX] CUFEs parseados: ' + resultado.length + ' de ' + rows.length);
  return resultado;
}

/**
 * Fallback: usar la API de DataTables para cambiar page length a -1 (todos).
 */
async function extraerViaDataTables(page) {
  const resultado = await page.evaluate(function() {
    var filas = [];

    // Intentar DataTables API
    try {
      if (window.$ && $.fn.DataTable) {
        var tables = $.fn.DataTable.tables({ api: true });
        if (!tables || !tables.rows) {
          // Otra forma de obtener instancias
          var tbl = $('table.dataTable').first();
          if (tbl.length) {
            var dt = tbl.DataTable();
            // Cambiar a mostrar todo
            dt.page.len(-1).draw(false);
            // Esperar el redibujado (no podemos hacer await aqui)
          }
        }
      }
    } catch(e) {}

    // Extraer filas visibles + ocultas (DataTables guarda todo en el DOM)
    var seenCUFEs = {};
    var rows = document.querySelectorAll('table tbody tr');
    rows.forEach(function(tr) {
      if (tr.style.display === 'none' && !tr.className.includes('child')) return;
      var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
        return td.textContent.trim().replace(/\s+/g, ' ');
      });
      var btn = tr.querySelector('button.download-document, button[data-id]');
      var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
      if (cells.length > 2 && cufe && !seenCUFEs[cufe]) {
        seenCUFEs[cufe] = true;
        filas.push({ cells: cells, cufe: cufe });
      }
    });
    return filas;
  });

  // Si solo tenemos la primera pagina, paginar manualmente
  if (resultado.length <= 10) {
    console.log('[DIAN] Solo ' + resultado.length + ' filas visibles, paginando...');
    return await paginarManual(page, resultado);
  }
  return resultado;
}

async function paginarManual(page, filasIniciales) {
  const todos = [...filasIniciales];
  const seenCUFEs = {};
  todos.forEach(function(f) { seenCUFEs[f.cufe] = true; });
  let pg = 2;

  while (pg <= 30) {
    const clicado = await page.evaluate(function(pgNum) {
      // Intentar por numero de pagina
      var links = document.querySelectorAll('.paginate_button:not(.previous):not(.next):not(.first):not(.last)');
      for (var i = 0; i < links.length; i++) {
        if (links[i].textContent.trim() === String(pgNum) && !links[i].classList.contains('active')) {
          links[i].click(); return 'pg-' + pgNum;
        }
      }
      // Intentar "Siguiente"
      var next = document.querySelector('#tbl-documents_next:not(.disabled), a.next:not(.disabled), li.next:not(.disabled) a');
      if (next) { next.click(); return 'next'; }
      return null;
    }, pg);

    if (!clicado) break;
    await page.waitForTimeout(1500);

    const nuevas = await page.evaluate(function(seen) {
      var filas = [];
      document.querySelectorAll('table tbody tr').forEach(function(tr) {
        var btn = tr.querySelector('button.download-document, button[data-id]');
        var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
        if (!cufe || seen[cufe]) return;
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) { return td.textContent.trim().replace(/\s+/g,' '); });
        if (cells.length > 2) filas.push({ cells: cells, cufe: cufe });
      });
      var isLast = !document.querySelector('#tbl-documents_next:not(.disabled), .paginate_button.next:not(.disabled)');
      return { filas: filas, isLast: isLast };
    }, seenCUFEs);

    console.log('[DIAN] Pag ' + pg + ': ' + nuevas.filas.length + ' nuevas | total: ' + (todos.length + nuevas.filas.length));
    nuevas.filas.forEach(function(f) { seenCUFEs[f.cufe] = true; todos.push(f); });
    if (nuevas.isLast || nuevas.filas.length === 0) break;
    pg++;
  }
  return todos;
}

async function descargarDocumentoClick(page, cufe) {
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25000 }),
      page.evaluate(function(id) {
        var el = document.getElementById(id);
        if (!el) {
          var btns = document.querySelectorAll('button[data-id]');
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].getAttribute('data-id') === id) { el = btns[i]; break; }
          }
        }
        if (el) { el.click(); return true; }
        return false;
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
    console.error('  [ERR DL]', e.message.substring(0,80));
    return null;
  }
}

async function buscarYNavegar(page, url, startDate, endDate, startISO, endISO) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(function(p) {
    var sEl = document.getElementById('startDate'); if (sEl) sEl.value = p.start;
    var eEl = document.getElementById('endDate');   if (eEl) eEl.value = p.end;
    var rEl = document.getElementById('dashboard-report-range');
    if (rEl) {
      rEl.value = p.startISO+' - '+p.endISO;
      rEl.dispatchEvent(new Event('change',{bubbles:true}));
      if (window.$ && $(rEl).data) { try { var dr=$(rEl).data('daterangepicker'); if(dr){dr.setStartDate(p.startISO);dr.setEndDate(p.endISO);} } catch(e){} }
    }
  }, { start: startDate, end: endDate, startISO, endISO });
  await page.evaluate(function() {
    var b = Array.from(document.querySelectorAll('button,input[type=submit]')).find(function(x){ return (x.textContent+(x.value||'')).toLowerCase().includes('buscar'); });
    if (b) b.click(); else { var f=document.querySelector('form'); if(f) f.submit(); }
  });
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle',{timeout:10000}).catch(function(){});
  // Esperar a que el DataTables termine de cargar los resultados
  await page.waitForFunction(function() {
    var btns = document.querySelectorAll('button.download-document, button[data-id]');
    return btns.length > 0;
  }, { timeout: 10000 }).catch(function() {});
  await page.waitForTimeout(500);
}

// ── FUNCION PRINCIPAL ──────────────────────────────────────────
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const dias = Math.round((new Date(fechaFin+'T00:00:00') - new Date(fechaInicio+'T00:00:00')) / 86400000);
  const rangos = dias > 31 ? dividirEnMeses(fechaInicio, fechaFin) : [{ desde: fechaInicio, hasta: fechaFin }];
  console.log('[DIAN] Rangos:', rangos.length, '| Dias:', dias);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', acceptDownloads: true });
  const page = await context.newPage();

  try {
    await autenticar(context, page, pk, nit, token);

    // FASE 1: Recolectar todos los CUFEs
    const todosDocumentos = [];
    const seenCUFEs = {};

    for (const rango of rangos) {
      const startDate = toFechaDIAN(rango.desde);
      const endDate   = toFechaDIAN(rango.hasta);
      console.log('[DIAN] === Rango: ' + rango.desde + ' a ' + rango.hasta + ' ===');

      const urls = [];
      if (!grupo || grupo === 'Recibido') urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/Document/Received', grp: 'Recibido' });
      if (!grupo || grupo === 'Emitido')  urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/Document/Sent',     grp: 'Emitido' });

      for (const dest of urls) {
        const filas = await obtenerCUFEsViaAjax(page, dest.url, startDate, endDate, rango.desde, rango.hasta);
        console.log('[DIAN] ' + dest.grp + ' ' + rango.desde + ': ' + filas.length + ' CUFEs');
        filas.forEach(function(f) {
          if (!seenCUFEs[f.cufe]) {
            seenCUFEs[f.cufe] = true;
            const cells = f.cells || [];
            // Usar campos pre-parseados si existen (vienen de parsearFilasAjax)
            todosDocumentos.push({
              cufe: f.cufe,
              cufeUrl: 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=' + f.cufe,
              tipo:        f.tipo        || cells[0] || 'Factura electronica',
              fecha:       f.fecha       || cells[7] || cells[2] || '',
              prefijo:     f.prefijo     || cells[3] || '',
              folio:       f.folio       || cells[4] || cells[2] || '',
              nitEmisor:   f.nitEmisor   || cells[9] || '',
              nomEmisor:   f.nomEmisor   || cells[10] || '',
              nitReceptor: f.nitReceptor || cells[11] || nit,
              nomReceptor: f.nomReceptor || cells[12] || '',
              nombre:      f.nombre      || ((cells[3]||'') ? (cells[3]+'-') : '') + (cells[4]||cells[2]||''),
              total:       f.total       || 0,
              estado:      f.estado      || '',
              grupo: dest.grp,
              rangoDesde: rango.desde, rangoHasta: rango.hasta,
            });
          }
        });
      }
    }

    console.log('[DIAN] TOTAL CUFEs: ' + todosDocumentos.length);

    // FASE 2: Descargar por grupo+rango, recargando la pagina para cada pagina de DataTables
    const documentos = [];
    const descargadosCUFE = {};

    // Agrupar por grupo+rango
    const grupos = {};
    todosDocumentos.forEach(function(doc) {
      const key = doc.grupo + '|' + doc.rangoDesde + '|' + doc.rangoHasta;
      if (!grupos[key]) grupos[key] = { docs: [], grp: doc.grupo, desde: doc.rangoDesde, hasta: doc.rangoHasta };
      grupos[key].docs.push(doc);
    });

    for (const gKey of Object.keys(grupos)) {
      const g = grupos[gKey];
      const pUrl = g.grp === 'Emitido'
        ? 'https://catalogo-vpfe.dian.gov.co/Document/Sent'
        : 'https://catalogo-vpfe.dian.gov.co/Document/Received';
      console.log('[DIAN] Descargando grupo ' + g.grp + ' ' + g.desde + ': ' + g.docs.length + ' docs');

      const cufeMap = {};
      g.docs.forEach(function(d) { cufeMap[d.cufe] = d; });

      const startD = toFechaDIAN(g.desde);
      const endD   = toFechaDIAN(g.hasta);

      // Para cada pagina de DataTables, recargamos la pagina y navegamos a esa pagina
      // Esto evita que el estado se pierda despues de cada descarga
      let paginaActual = 1;
      let totalPaginas = Math.ceil(g.docs.length / 10);
      let totalDescargadosGrupo = 0;

      // Para cada pagina del DataTables:
      // 1. Recargar con fechas (garantiza estado limpio)
      // 2. Navegar a la pagina correcta
      // 3. Descargar todos los botones visibles
      for (let pg = 1; pg <= totalPaginas + 2; pg++) {
        // Siempre recargar con fechas antes de cada pagina
        // Esto evita que los AJAX de las descargas reseteen el filtro
        await buscarYNavegar(page, pUrl, startD, endD, g.desde, g.hasta);

        // Navegar a la pagina correcta del DataTables
        for (let salto = 1; salto < pg; salto++) {
          // Esperar que el boton Next este disponible
          await page.waitForFunction(function() {
            var n = document.querySelector(
              '#tbl-documents_next:not(.disabled), ' +
              'li.paginate_button.next:not(.disabled) a, ' +
              '.paginate_button.next:not(.disabled)'
            );
            return !!n;
          }, { timeout: 8000 }).catch(function(){});

          const ok = await page.evaluate(function() {
            var n = document.querySelector(
              '#tbl-documents_next:not(.disabled), ' +
              'li.paginate_button.next:not(.disabled) a, ' +
              '.paginate_button.next:not(.disabled)'
            );
            if (n) { n.click(); return true; }
            // Debug: show what pagination buttons exist
            var allPag = Array.from(document.querySelectorAll('.paginate_button, [id*="next"]')).map(function(el){
              return el.id + '/' + el.className.substring(0,40);
            });
            console.log('Paginacion disponible:', allPag.join(' | '));
            return false;
          });
          if (!ok) { pg = 9999; break; }
          // Esperar que los nuevos botones carguen
          await page.waitForTimeout(500);
          await page.waitForFunction(function() {
            return document.querySelectorAll('button.download-document, button[data-id]').length > 0;
          }, { timeout: 8000 }).catch(function(){});
          await page.waitForTimeout(500);
        }
        if (pg > totalPaginas + 2) break;

        // Obtener CUFEs visibles
        const cufesVisibles = await page.evaluate(function() {
          var cufes = [];
          document.querySelectorAll('button.download-document, button[data-id]').forEach(function(btn) {
            var cufe = btn.getAttribute('data-id') || btn.id;
            if (cufe && cufe.length > 20) cufes.push(cufe);
          });
          return cufes;
        });

        console.log('[DIAN] Pag ' + pg + '/' + totalPaginas + ': ' + cufesVisibles.length + ' botones');
        if (cufesVisibles.length === 0) break;

        // Descargar todos sin recargar entre ellos
        let descargadosEnPagina = 0;
        for (const cufe of cufesVisibles) {
          if (!cufeMap[cufe] || descargadosCUFE[cufe]) continue;
          const doc = cufeMap[cufe];
          console.log('  [DL] ' + doc.nombre);
          const archivos = await descargarDocumentoClick(page, cufe);
          descargadosCUFE[cufe] = true;
          descargadosEnPagina++;
          totalDescargadosGrupo++;
          documentos.push({
            ...doc,
            pdfBuffer: archivos?.pdfBuffer || null,
            xmlBuffer: archivos?.xmlBuffer || null,
            xmlText:   archivos?.xmlText   || '',
          });
        }
        console.log('[DIAN] Pag ' + pg + ': +' + descargadosEnPagina + ' | total: ' + totalDescargadosGrupo + '/' + g.docs.length);
        if (totalDescargadosGrupo >= g.docs.length) break;
        if (descargadosEnPagina === 0) break;
      }

      console.log('[DIAN] Grupo ' + g.grp + ': ' + totalDescargadosGrupo + '/' + g.docs.length);
    }

    // Incluir los sin descarga
    todosDocumentos.forEach(function(doc) {
      if (!descargadosCUFE[doc.cufe]) {
        console.log('[DIAN] Sin descarga: ' + doc.nombre);
        documentos.push({ ...doc, pdfBuffer: null, xmlBuffer: null, xmlText: '' });
      }
    });

    console.log('[DIAN] Completado: ' + documentos.length + '/' + todosDocumentos.length);
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
    await autenticar(context, page, pk, nit, token);
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
