const { chromium } = require('playwright');
const JSZip = require('jszip');
const fs = require('fs');

// Helper: ejecuta page.evaluate con retry si el contexto se destruye
async function safeEval(page, fn, args, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await page.evaluate(fn, args);
    } catch(e) {
      if (e.message && e.message.includes('Execution context was destroyed')) {
        console.log('[safeEval] Contexto destruido, esperando... intento ' + (i+1));
        await page.waitForTimeout(1500);
        await page.waitForLoadState('domcontentloaded').catch(function(){});
      } else {
        throw e;
      }
    }
  }
  return null;
}

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

async function autenticar(context, page, pk, nit, token) {
  console.log('[DIAN] Autenticando NIT ' + nit);
  await page.goto(
    'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
    { waitUntil: 'domcontentloaded', timeout: 40000 }
  );

  // Esperar redirección post-auth (la DIAN procesa el token y redirige)
  await page.waitForTimeout(3000);

  // Si sigue en AuthToken, esperar la redirección
  if (page.url().includes('AuthToken')) {
    try {
      await page.waitForURL(function(url) {
        return !url.includes('AuthToken');
      }, { timeout: 10000 });
      await page.waitForTimeout(1000);
    } catch(e) {}
  }

  const finalUrl = page.url();
  console.log('[DIAN] Autenticado — URL final: ' + finalUrl);

  if (finalUrl.includes('/User/Login') || finalUrl.includes('/Login')) {
    throw new Error('Token invalido o expirado. Solicita un nuevo token en la DIAN.');
  }
}

async function obtenerCUFEsViaAjax(page, url, startDate, endDate, startISO, endISO) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Esperar a que la página esté estable (evita context destroyed)
  await page.waitForTimeout(1500);
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(function(){});

  const currentUrl = page.url();
  console.log('[DIAN] Pagina cargada: ' + currentUrl);

  // Si redirigió a login, la sesión expiró
  if (currentUrl.includes('/Login') || currentUrl.includes('/login')) {
    console.log('[DIAN] Sesión expirada en ' + url + ' — retornando 0 CUFEs');
    return [];
  }

  await safeEval(page, function(p) {
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
  }, { start: startDate, end: endDate, startISO, endISO }).catch(function(e){ console.log('[DIAN] Eval fechas error:', e.message.substring(0,60)); });

  let ajaxUrl = null, ajaxPayload = null, ajaxHeaders = {};
  page.on('request', function(req) {
    const u = req.url(), m = req.method();
    if (m === 'POST' && (u.includes('GetDocuments') || u.includes('datatables') || u.includes('DataTable') || u.includes('ajax'))) {
      ajaxUrl = u; ajaxPayload = req.postData(); ajaxHeaders = req.headers();
      console.log('[AJAX] Interceptado: ' + u);
    }
  });

  const respuestasCapturadas = [];
  page.on('response', async function(resp) {
    try {
      const u = resp.url(), ct = resp.headers()['content-type'] || '';
      if (ct.includes('json') && u.includes('catalogo-vpfe.dian.gov.co') && resp.status() === 200) {
        const body = await resp.text();
        if (body.includes('"data"') || body.includes('"recordsTotal"') || body.includes('"cufe"') || body.includes('"Cufe"')) {
          respuestasCapturadas.push({ url: u, body: body.substring(0, 2000) });
          console.log('[AJAX RESP] JSON de DIAN: ' + u + ' | ' + body.substring(0, 100));
        }
      }
    } catch(e) {}
  });

  await page.evaluate(function() {
    var b = Array.from(document.querySelectorAll('button, input[type=submit]')).find(function(x) {
      return (x.textContent + (x.value||'')).toLowerCase().includes('buscar');
    });
    if (b) b.click(); else { var f = document.querySelector('form'); if (f) f.submit(); }
  });

  await page.waitForTimeout(200);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function(){});

  console.log('[DIAN] AJAX URL interceptada:', ajaxUrl);

  if (ajaxUrl) {
    try {
      let nuevoPayload = ajaxPayload || '';
      nuevoPayload = nuevoPayload.replace(/length=-?\d+/, 'length=10000').replace(/length%3D-?\d+/, 'length%3D10000');
      if (!nuevoPayload.includes('length')) nuevoPayload += '&length=10000&start=0';

      const respAll = await safeEval(page, async function(params) {
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
  return await extraerViaDataTables(page);
}

function parsearFilasAjax(rows) {
  if (rows.length > 0) console.log('[AJAX] Campos disponibles:', Object.keys(rows[0]).join(', '));
  const resultado = [];
  rows.forEach(function(r) {
    const cufe = r.Id || r.id || r.cufe || r.Cufe || r.CUFE || r.documentKey || r.DocumentKey || r.uuid || r.UUID || '';
    if (!cufe || cufe.length < 20) return;
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
      cufe: String(cufe), cells: [tipo, String(cufe), folio, prefijo, '', '', '', fecha, '', nitEmi, nomEmi, nitRec, nomRec],
      tipo, fecha, prefijo, folio, nombre,
      nitEmisor: nitEmi, nomEmisor: nomEmi, nitReceptor: nitRec, nomReceptor: nomRec,
      total, iva, estado,
    });
  });
  console.log('[AJAX] CUFEs parseados: ' + resultado.length + ' de ' + rows.length);
  return resultado;
}

async function extraerViaDataTables(page) {
  const resultado = await page.evaluate(function() {
    var filas = [];
    try {
      if (window.$ && $.fn.DataTable) {
        var tbl = $('table.dataTable').first();
        if (tbl.length) { var dt = tbl.DataTable(); dt.page.len(-1).draw(false); }
      }
    } catch(e) {}
    var seenCUFEs = {};
    var rows = document.querySelectorAll('table tbody tr');
    rows.forEach(function(tr) {
      if (tr.style.display === 'none' && !tr.className.includes('child')) return;
      var cells = Array.from(tr.querySelectorAll('td')).map(function(td) { return td.textContent.trim().replace(/\s+/g, ' '); });
      var btn = tr.querySelector('button.download-document, button[data-id]');
      var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
      if (cells.length > 2 && cufe && !seenCUFEs[cufe]) { seenCUFEs[cufe] = true; filas.push({ cells: cells, cufe: cufe }); }
    });
    return filas;
  });
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
      var links = document.querySelectorAll('.paginate_button:not(.previous):not(.next):not(.first):not(.last)');
      for (var i = 0; i < links.length; i++) {
        if (links[i].textContent.trim() === String(pgNum) && !links[i].classList.contains('active')) { links[i].click(); return 'pg-' + pgNum; }
      }
      var next = document.querySelector('#tbl-documents_next:not(.disabled), a.next:not(.disabled), li.next:not(.disabled) a');
      if (next) { next.click(); return 'next'; }
      return null;
    }, pg);
    if (!clicado) break;
    await page.waitForTimeout(300);
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

async function encontrarUrlDescarga(page, primerCufe) {
  let downloadUrl = null, downloadMethod = null, downloadBody = null;
  const handler = function(req) {
    const u = req.url(), m = req.method();
    if (u.includes('Download') || u.includes('download') || u.includes('GetFile') || u.includes('getfile') || u.includes('Zip') || u.includes('zip')) {
      if (u.includes('dian.gov.co') || u.includes('catalogo')) {
        downloadUrl = u; downloadMethod = m; downloadBody = req.postData();
        console.log('[INTERCEPT DL] ' + m + ' ' + u + (downloadBody ? ' body:'+downloadBody.substring(0,100) : ''));
      }
    }
  };
  page.on('request', handler);
  try {
    const context2 = page.context();
    // Intentar capturar nueva pestaña primero
    const newPagePromise = context2.waitForEvent('page', { timeout: 12000 }).catch(function(){return null;});
    await page.evaluate(function(id) {
      var el = document.getElementById(id);
      if (!el) { var btns = document.querySelectorAll('button[data-id]'); for (var i = 0; i < btns.length; i++) { if (btns[i].getAttribute('data-id') === id) { el = btns[i]; break; } } }
      if (el) el.click();
    }, primerCufe);
    // Esperar hasta 8s
    for (let i = 0; i < 16 && !downloadUrl; i++) {
      await page.waitForTimeout(500);
    }
    const newP = await newPagePromise;
    if (newP) {
      await newP.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(function(){});
      downloadUrl = newP.url();
      downloadMethod = 'GET';
      console.log('[INTERCEPT DL] Nueva pestaña URL: ' + downloadUrl.substring(0,100));
      await newP.close().catch(function(){});
    }
  } catch(e) { console.log('[INTERCEPT DL] Error en primer click:', e.message.substring(0,80)); }
  page.off('request', handler);
  if (downloadUrl) {
    console.log('[DIAN] URL de descarga encontrada: ' + downloadMethod + ' ' + downloadUrl);
    return { url: downloadUrl, method: downloadMethod, bodyTemplate: downloadBody };
  }
  return null;
}

async function descargarViaUrl(page, cufe, urlInfo) {
  try {
    let url = urlInfo.url, body = urlInfo.bodyTemplate;
    if (body) {
      body = body.replace(/trackId=[^&]+/, 'trackId=' + encodeURIComponent(cufe));
      body = body.replace(/cufe=[^&]+/, 'cufe=' + encodeURIComponent(cufe));
      body = body.replace(/id=[^&]+/, 'id=' + encodeURIComponent(cufe));
      body = body.replace(/documentKey=[^&]+/, 'documentKey=' + encodeURIComponent(cufe));
      body = body.replace(/[0-9a-f]{64,}/, cufe);
    }
    if (urlInfo.method === 'GET') {
      url = url.replace(/trackId=[^&]+/, 'trackId=' + encodeURIComponent(cufe));
      url = url.replace(/cufe=[^&]+/, 'cufe=' + encodeURIComponent(cufe));
      url = url.replace(/id=[^&]+/, 'id=' + encodeURIComponent(cufe));
      url = url.replace(/[0-9a-f]{64,}/, cufe);
    }
    const resultado = await safeEval(page, async function(params) {
      try {
        var resp;
        if (params.method === 'GET') { resp = await fetch(params.url, { credentials: 'include' }); }
        else { resp = await fetch(params.url, { method: params.method || 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: params.body, credentials: 'include' }); }
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        var arr = await resp.arrayBuffer();
        return { size: arr.byteLength, data: Array.from(new Uint8Array(arr)) };
      } catch(e) { return { error: e.message }; }
    }, { url, method: urlInfo.method, body });
    if (resultado.error || !resultado.size) return null;
    const buffer = Buffer.from(resultado.data);
    let pdfBuffer = null, xmlBuffer = null, xmlText = '';
    try {
      const zip = await JSZip.loadAsync(buffer);
      for (const [fn, file] of Object.entries(zip.files)) {
        if (fn.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
        if (fn.toLowerCase().endsWith('.xml')) { xmlBuffer = await file.async('nodebuffer'); xmlText = await file.async('text'); }
      }
    } catch(e) {}
    return { pdfBuffer, xmlBuffer, xmlText };
  } catch(e) { console.error('[DL URL]', e.message.substring(0,80)); return null; }
}

async function descargarDocumentoClick(page, cufe) {
  try {
    const context = page.context();

    // Estrategia 1: Interceptar nueva pestaña (la DIAN abre el ZIP en nueva pestaña)
    try {
      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 12000 }),
        page.evaluate(function(id) {
          var el = document.getElementById(id);
          if (!el) {
            var btns = document.querySelectorAll('button[data-id]');
            for (var i = 0; i < btns.length; i++) {
              if (btns[i].getAttribute('data-id') === id) { el = btns[i]; break; }
            }
          }
          if (el) el.click();
        }, cufe),
      ]);

      // Esperar que la nueva página cargue
      await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(function(){});
      await newPage.waitForTimeout(1000);

      const newUrl = newPage.url();
      console.log('  [NEW PAGE] URL: ' + newUrl.substring(0, 100));

      // Descargar desde la nueva pestaña usando fetch con cookies
      const resultado = await safeEval(newPage, async function() {
        try {
          const resp = await fetch(window.location.href, { credentials: 'include' });
          if (!resp.ok) return { error: 'HTTP ' + resp.status };
          const arr = await resp.arrayBuffer();
          const bytes = new Uint8Array(arr);
          let binary = '';
          bytes.forEach(function(b){ binary += String.fromCharCode(b); });
          return { ok: true, base64: btoa(binary) };
        } catch(e) { return { error: e.message }; }
      }, null);

      await newPage.close().catch(function(){});

      if (resultado && resultado.ok && resultado.base64) {
        const buffer = Buffer.from(resultado.base64, 'base64');
        let pdfBuffer = null, xmlBuffer = null, xmlText = '';
        try {
          const zip = await JSZip.loadAsync(buffer);
          for (const [fn, file] of Object.entries(zip.files)) {
            if (fn.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
            if (fn.toLowerCase().endsWith('.xml')) { xmlBuffer = await file.async('nodebuffer'); xmlText = await file.async('text'); }
          }
        } catch(e) {
          xmlText = buffer.toString('utf8');
          if (xmlText.includes('<?xml') || xmlText.includes('<Invoice')) xmlBuffer = buffer;
          else pdfBuffer = buffer;
        }
        return { pdfBuffer, xmlBuffer, xmlText };
      }
    } catch(e1) {
      console.log('  [DL] Nueva pestaña no detectada, probando download event...');
    }

    // Estrategia 2: evento download clásico
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.evaluate(function(id) {
          var el = document.getElementById(id);
          if (!el) {
            var btns = document.querySelectorAll('button[data-id]');
            for (var i = 0; i < btns.length; i++) {
              if (btns[i].getAttribute('data-id') === id) { el = btns[i]; break; }
            }
          }
          if (el) el.click();
        }, cufe),
      ]);
      const buffer = fs.readFileSync(await download.path());
      let pdfBuffer = null, xmlBuffer = null, xmlText = '';
      const zip = await JSZip.loadAsync(buffer).catch(function(){return null;});
      if (zip) {
        for (const [fn, file] of Object.entries(zip.files)) {
          if (fn.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
          if (fn.toLowerCase().endsWith('.xml')) { xmlBuffer = await file.async('nodebuffer'); xmlText = await file.async('text'); }
        }
      }
      return { pdfBuffer, xmlBuffer, xmlText };
    } catch(e2) {
      console.error('  [ERR DL]', e2.message.substring(0,60));
      return { pdfBuffer: null, xmlBuffer: null, xmlText: '' };
    }
  } catch(e) {
    console.error('  [ERR DL]', e.message.substring(0,80));
    return { pdfBuffer: null, xmlBuffer: null, xmlText: '' };
  }
}

async function buscarYNavegar(page, url, startDate, endDate, startISO, endISO) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
  await page.waitForTimeout(600);
  await page.waitForLoadState('networkidle',{timeout:10000}).catch(function(){});
  await page.waitForFunction(function() {
    var btns = document.querySelectorAll('button.download-document, button[data-id]');
    return btns.length > 0;
  }, { timeout: 10000 }).catch(function() {});
  await page.waitForTimeout(150);
}

// ── MODO RÁPIDO: XMLs en paralelo sin PDFs ────────────────────
async function descargarSoloXMLs(page, cufe, urlInfo) {
  try {
    if (urlInfo && urlInfo.url) {
      let url = urlInfo.url, body = urlInfo.bodyTemplate;
      if (body) {
        body = body.replace(/trackId=[^&]+/, 'trackId=' + encodeURIComponent(cufe));
        body = body.replace(/cufe=[^&]+/, 'cufe=' + encodeURIComponent(cufe));
        body = body.replace(/id=[^&]+/, 'id=' + encodeURIComponent(cufe));
        body = body.replace(/[0-9a-f]{64,}/, cufe);
      }
      if (urlInfo.method === 'GET') {
        url = url.replace(/trackId=[^&]+/, 'trackId=' + encodeURIComponent(cufe));
        url = url.replace(/cufe=[^&]+/, 'cufe=' + encodeURIComponent(cufe));
      }

      // Retry hasta 3 veces si el contexto se destruye
      let result = null;
      for (let intento = 0; intento < 3; intento++) {
        try {
          result = await page.evaluate(async function(params) {
            try {
              const resp = await fetch(params.url, {
                method: params.method || 'GET',
                headers: params.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
                body: params.body || undefined,
                credentials: 'include',
              });
              if (!resp.ok) return { error: 'HTTP ' + resp.status };
              const arrayBuf = await resp.arrayBuffer();
              const bytes = new Uint8Array(arrayBuf);
              let binary = '';
              bytes.forEach(function(b) { binary += String.fromCharCode(b); });
              return { ok: true, base64: btoa(binary), contentType: resp.headers.get('content-type') || '' };
            } catch(e) { return { error: e.message }; }
          }, { url, method: urlInfo.method, body: body || null });
          break;
        } catch(evalErr) {
          if (evalErr.message && evalErr.message.includes('Execution context was destroyed')) {
            console.log('[XML FAST] Contexto destruido, reintentando... ' + (intento+1));
            await page.waitForTimeout(1500);
            await page.waitForLoadState('domcontentloaded').catch(function(){});
          } else { throw evalErr; }
        }
      }

      if (result && result.ok && result.base64) {
        const buffer = Buffer.from(result.base64, 'base64');
        let xmlText = '', xmlBuffer = null;
        try {
          const zip = await JSZip.loadAsync(buffer);
          for (const [fn, file] of Object.entries(zip.files)) {
            if (fn.toLowerCase().endsWith('.xml')) {
              xmlBuffer = await file.async('nodebuffer');
              xmlText = xmlBuffer.toString('utf8');
              break;
            }
          }
        } catch(e) {
          xmlText = buffer.toString('utf8');
          if (xmlText.includes('<?xml') || xmlText.includes('<Invoice')) xmlBuffer = buffer;
        }
        return { pdfBuffer: null, xmlBuffer, xmlText };
      }
    }
    return { pdfBuffer: null, xmlBuffer: null, xmlText: '' };
  } catch(e) {
    console.error('[XML FAST]', e.message.substring(0,80));
    return { pdfBuffer: null, xmlBuffer: null, xmlText: '' };
  }
}

async function descargarXMLsParalelo(page, docs, urlInfo, descargadosCUFE, onProgress) {
  const BATCH = 5;
  const resultados = [];
  for (let i = 0; i < docs.length; i += BATCH) {
    const lote = docs.slice(i, i + BATCH);
    const promesas = lote.map(async function(doc) {
      if (descargadosCUFE[doc.cufe]) return null;
      const archivos = await descargarSoloXMLs(page, doc.cufe, urlInfo);
      descargadosCUFE[doc.cufe] = true;
      if (onProgress) onProgress();
      return { ...doc, pdfBuffer: null, xmlBuffer: archivos.xmlBuffer, xmlText: archivos.xmlText };
    });
    const loteRes = await Promise.all(promesas);
    loteRes.forEach(function(r) { if (r) resultados.push(r); });
  }
  return resultados;
}

// ── FUNCION PRINCIPAL ──────────────────────────────────────────
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa, soloXML = false }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const dias = Math.round((new Date(fechaFin+'T00:00:00') - new Date(fechaInicio+'T00:00:00')) / 86400000);
  const rangos = dias > 31 ? dividirEnMeses(fechaInicio, fechaFin) : [{ desde: fechaInicio, hasta: fechaFin }];
  console.log('[DIAN] Rangos:', rangos.length, '| Dias:', dias, '| soloXML:', soloXML);

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
      if (!grupo || grupo === 'Recibido')       urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/Document/Received',       grp: 'Recibido' });
      if (!grupo || grupo === 'Emitido')         urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/Document/Sent',           grp: 'Emitido' });
      if (!grupo || grupo === 'NominaEmitida')   urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/NominaDocument/Emitted',  grp: 'NominaEmitida' });
      if (!grupo || grupo === 'NominaRecibida')  urls.push({ url: 'https://catalogo-vpfe.dian.gov.co/NominaDocument/Received', grp: 'NominaRecibida' });

      for (const dest of urls) {
        const filas = await obtenerCUFEsViaAjax(page, dest.url, startDate, endDate, rango.desde, rango.hasta);
        console.log('[DIAN] ' + dest.grp + ' ' + rango.desde + ': ' + filas.length + ' CUFEs');
        filas.forEach(function(f) {
          if (!seenCUFEs[f.cufe]) {
            seenCUFEs[f.cufe] = true;
            const cells = f.cells || [];
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

    global._edianTotal = todosDocumentos.length;
    global._edianDescargados = 0;
    console.log('[DIAN] TOTAL CUFEs: ' + todosDocumentos.length);

    // FASE 2: Descargar
    const documentos = [];
    const descargadosCUFE = {};

    const grupos = {};
    todosDocumentos.forEach(function(doc) {
      const key = doc.grupo + '|' + doc.rangoDesde + '|' + doc.rangoHasta;
      if (!grupos[key]) grupos[key] = { docs: [], grp: doc.grupo, desde: doc.rangoDesde, hasta: doc.rangoHasta };
      grupos[key].docs.push(doc);
    });

    for (const gKey of Object.keys(grupos)) {
      const g = grupos[gKey];
      const pUrl = g.grp === 'Emitido'        ? 'https://catalogo-vpfe.dian.gov.co/Document/Sent' :
                   g.grp === 'NominaEmitida'  ? 'https://catalogo-vpfe.dian.gov.co/NominaDocument/Emitted' :
                   g.grp === 'NominaRecibida' ? 'https://catalogo-vpfe.dian.gov.co/NominaDocument/Received' :
                   'https://catalogo-vpfe.dian.gov.co/Document/Received';

      console.log('[DIAN] Descargando grupo ' + g.grp + ' ' + g.desde + ': ' + g.docs.length + ' docs');

      const cufeMap = {};
      g.docs.forEach(function(d) { cufeMap[d.cufe] = d; });

      const startD = toFechaDIAN(g.desde);
      const endD   = toFechaDIAN(g.hasta);
      let totalDescargadosGrupo = 0;
      const totalPaginas = Math.ceil(g.docs.length / 10);

      await buscarYNavegar(page, pUrl, startD, endD, g.desde, g.hasta);

      const primerosCUFEs = await page.evaluate(function() {
        var cufes = [];
        document.querySelectorAll('button.download-document, button[data-id]').forEach(function(btn) {
          var c = btn.getAttribute('data-id') || btn.id;
          if (c && c.length > 20) cufes.push(c);
        });
        return cufes;
      });

      let urlDescargaInfo = null;
      console.log('[DIAN] primerosCUFEs visibles: ' + primerosCUFEs.length + ' en pagina ' + pUrl);
      const primerCufeDescargable = primerosCUFEs.find(function(c){ return cufeMap[c] && !descargadosCUFE[c]; });
      console.log('[DIAN] primerCufeDescargable: ' + (primerCufeDescargable ? primerCufeDescargable.substring(0,20) : 'NINGUNO'));

      if (primerCufeDescargable) {
        console.log('[DIAN] Descubriendo URL de descarga con ' + cufeMap[primerCufeDescargable].nombre + '...');
        urlDescargaInfo = await encontrarUrlDescarga(page, primerCufeDescargable);
        const archivos = await descargarDocumentoClick(page, primerCufeDescargable);
        descargadosCUFE[primerCufeDescargable] = true;
        totalDescargadosGrupo++;
        const doc = cufeMap[primerCufeDescargable];
        documentos.push({ ...doc, pdfBuffer: archivos?.pdfBuffer||null, xmlBuffer: archivos?.xmlBuffer||null, xmlText: archivos?.xmlText||'' });
        global._edianDescargados = (global._edianDescargados||0) + 1;
        console.log('[PROGRESS] ' + global._edianDescargados + '/' + (global._edianTotal||'?'));
      }

      if (urlDescargaInfo) {
        const restantes = g.docs.filter(function(d){ return !descargadosCUFE[d.cufe]; });
        console.log('[DIAN] ' + (soloXML ? 'MODO RÁPIDO XML' : 'descarga completa') + ': ' + restantes.length + ' docs restantes');

        if (soloXML) {
          const rapidos = await descargarXMLsParalelo(page, restantes, urlDescargaInfo, descargadosCUFE, function() {
            global._edianDescargados = (global._edianDescargados||0) + 1;
          });
          rapidos.forEach(function(r){ documentos.push(r); });
        } else {
          for (const doc of g.docs) {
            if (descargadosCUFE[doc.cufe]) continue;
            console.log('  [DL URL] ' + doc.nombre);
            const archivos = await descargarViaUrl(page, doc.cufe, urlDescargaInfo);
            descargadosCUFE[doc.cufe] = true;
            totalDescargadosGrupo++;
            documentos.push({ ...doc, pdfBuffer: archivos?.pdfBuffer||null, xmlBuffer: archivos?.xmlBuffer||null, xmlText: archivos?.xmlText||'' });
            global._edianDescargados = (global._edianDescargados||0) + 1;
            console.log('[PROGRESS] ' + global._edianDescargados + '/' + (global._edianTotal||'?'));
          }
        }
        console.log('[DIAN] Grupo ' + g.grp + ' (URL directa): ' + totalDescargadosGrupo + '/' + g.docs.length);
      } else {
        console.log('[DIAN] URL no encontrada, usando paginacion...');
        for (let pg = 1; pg <= totalPaginas + 2; pg++) {
          await buscarYNavegar(page, pUrl, startD, endD, g.desde, g.hasta);
          for (let salto = 1; salto < pg; salto++) {
            await page.waitForFunction(function() {
              var n = document.querySelector('#tbl-documents_next:not(.disabled), li.paginate_button.next:not(.disabled) a, .paginate_button.next:not(.disabled)');
              return !!n;
            }, { timeout: 8000 }).catch(function(){});
            const ok = await page.evaluate(function() {
              var n = document.querySelector('#tbl-documents_next:not(.disabled), li.paginate_button.next:not(.disabled) a, .paginate_button.next:not(.disabled)');
              if (n) { n.click(); return true; }
              return false;
            });
            if (!ok) { pg = 9999; break; }
            await page.waitForTimeout(150);
            await page.waitForFunction(function() { return document.querySelectorAll('button.download-document, button[data-id]').length > 0; }, { timeout: 8000 }).catch(function(){});
            await page.waitForTimeout(150);
          }
          if (pg > totalPaginas + 2) break;
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
          let descargadosEnPagina = 0;
          for (const cufe of cufesVisibles) {
            if (!cufeMap[cufe] || descargadosCUFE[cufe]) continue;
            const doc = cufeMap[cufe];
            console.log('  [DL] ' + doc.nombre);
            const archivos = await descargarDocumentoClick(page, cufe);
            descargadosCUFE[cufe] = true;
            descargadosEnPagina++;
            totalDescargadosGrupo++;
            documentos.push({ ...doc, pdfBuffer: archivos?.pdfBuffer||null, xmlBuffer: archivos?.xmlBuffer||null, xmlText: archivos?.xmlText||'' });
            global._edianDescargados = (global._edianDescargados||0) + 1;
          }
          console.log('[DIAN] Pag ' + pg + ': +' + descargadosEnPagina + ' | total: ' + totalDescargadosGrupo + '/' + g.docs.length);
          if (totalDescargadosGrupo >= g.docs.length) break;
          if (descargadosEnPagina === 0) break;
        }
      }
      console.log('[DIAN] Grupo ' + g.grp + ': ' + totalDescargadosGrupo + '/' + g.docs.length);
    }

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
    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const info = await page.evaluate(function() {
      return { url: window.location.href, titulo: document.title,
        inputs: Array.from(document.querySelectorAll('input,select')).map(function(el) {
          return { id: el.id, name: el.name, type: el.type, value: el.value.substring(0,80) };
        }), html: document.body.innerHTML.substring(0, 5000) };
    });
    return { ok: true, nit, ...info };
  } finally { await browser.close(); }
}

// ── Exports — TODO al final, una sola vez ─────────────────────
module.exports = {
  descargarDIAN,
  diagnosticarPortal,
  parseTokenUrl,
  descargarXMLsParalelo,
};
