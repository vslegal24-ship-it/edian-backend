const { chromium } = require('playwright');
const JSZip = require('jszip');
const fs = require('fs');

/*
 * Scraper del portal DIAN (catalogo-vpfe.dian.gov.co) — v2
 *  1. Autentica con el enlace del token.
 *  2. Por cada grupo abre la página UNA vez y captura la petición AJAX del portal.
 *  3. Repite esa petición cambiando las fechas del payload (rango por rango) y
 *     sigue la paginación por continuationToken.
 *  4. Descarga cada documento con /Document/DownloadZipFiles?trackId=... y, si
 *     falla, intenta con el clic del botón (registrando qué hace la página).
 */

const BASE = 'https://catalogo-vpfe.dian.gov.co';
const PAGINAS = {
  Recibido:       BASE + '/Document/Received',
  Emitido:        BASE + '/Document/Sent',
  NominaEmitida:  BASE + '/NominaDocument/Emitted',
  NominaRecibida: BASE + '/NominaDocument/Received',
};
const DESCARGAS_PARALELAS = 4;

async function safeEval(page, fn, args, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await page.evaluate(fn, args);
    } catch (e) {
      if (e.message && e.message.includes('Execution context was destroyed')) {
        await page.waitForTimeout(1500);
        await page.waitForLoadState('domcontentloaded').catch(function () {});
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
  } catch (e) { throw new Error('URL del token invalida: ' + e.message); }
}

function toFechaDIAN(iso) {
  const [y, m, d] = iso.split('-');
  return parseInt(m) + '/' + parseInt(d) + '/' + y + ' 12:00:00 AM';
}

function isoLocal(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

function dividirEnMeses(fechaInicio, fechaFin) {
  const rangos = [];
  let cur = new Date(fechaInicio + 'T00:00:00');
  const fin = new Date(fechaFin + 'T00:00:00');
  while (cur <= fin) {
    const ultimoDia = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    rangos.push({ desde: isoLocal(cur), hasta: ultimoDia <= fin ? isoLocal(ultimoDia) : fechaFin });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return rangos;
}

/** Fecha de la DIAN (ISO, /Date(ms)/, d/m/yyyy, m/d/yyyy h:mm AM) -> yyyy-mm-dd */
function fechaAISO(v) {
  if (!v) return '';
  const s = String(v);
  let m = /\/Date\((-?\d+)/.exec(s);
  if (m) return new Date(+m[1]).toISOString().slice(0, 10);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    const mesPrimero = /AM|PM/i.test(s) || b > 12;
    const mes = mesPrimero ? a : b, dia = mesPrimero ? b : a;
    return m[3] + '-' + String(mes).padStart(2, '0') + '-' + String(dia).padStart(2, '0');
  }
  return '';
}

async function autenticar(context, page, pk, nit, token) {
  console.log('[DIAN] Autenticando NIT ' + nit);
  await page.goto(BASE + '/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
    { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('AuthToken')) {
    await page.waitForURL(function (url) { return !String(url).includes('AuthToken'); }, { timeout: 10000 }).catch(function () {});
  }
  const finalUrl = page.url();
  console.log('[DIAN] Autenticado — URL final: ' + finalUrl);
  if (/\/login/i.test(finalUrl)) throw new Error('Token invalido o expirado. Solicita un nuevo token en la DIAN.');
}

// ── Consulta de documentos ────────────────────────────────────
const HEADERS_PROHIBIDOS = /^(host|cookie|content-length|user-agent|accept-encoding|origin|referer|connection|sec-|:)/i;

async function capturarConsulta(page, url) {
  let captura = null;
  const onReq = function (req) {
    if (!captura && req.method() === 'POST' && /GetDocuments|DataTable/i.test(req.url())) {
      const headers = {};
      Object.entries(req.headers()).forEach(function ([k, v]) { if (!HEADERS_PROHIBIDOS.test(k)) headers[k] = v; });
      captura = { url: req.url(), payload: req.postData() || '', headers };
    }
  };
  page.on('request', onReq);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (/\/login/i.test(page.url())) { console.log('[DIAN] Sesión expirada en ' + url); return null; }
    for (let i = 0; i < 10 && !captura; i++) await page.waitForTimeout(500);
    if (!captura) {
      await safeEval(page, function () {
        var b = Array.from(document.querySelectorAll('button, input[type=submit]'))
          .find(function (x) { return (x.textContent + (x.value || '')).toLowerCase().includes('buscar'); });
        if (b) b.click();
      }).catch(function () {});
      for (let i = 0; i < 20 && !captura; i++) await page.waitForTimeout(500);
    }
  } finally {
    page.off('request', onReq);
  }
  if (captura) {
    console.log('[DIAN] Consulta capturada: ' + captura.url);
    console.log('[DIAN] Payload original: ' + captura.payload.substring(0, 800));
  } else {
    console.log('[DIAN] Sin consulta AJAX en ' + url);
  }
  return captura;
}

function normKey(k) { return String(k).toLowerCase().replace(/[^a-z]/g, ''); }
const RX_INICIO = /(startdate|fechainicio|fechaini|fechadesde|datefrom|fromdate|initialdate|begindate|desde)/;
const RX_FIN    = /(enddate|fechafin|fechahasta|dateto|todate|finaldate|hasta)/;
const RX_TOKEN  = /continuationtoken/;
const RX_LARGO  = /^(length|pagesize|take)$/;

/** Escribe la fecha iso con el mismo formato que tenía el valor original. */
function formatearComo(original, iso) {
  const s = String(original == null ? '' : original);
  const [y, m, d] = iso.split('-');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return iso + s.slice(10);
  const mm = /^(\d{1,2})([\/-])(\d{1,2})\2(\d{4})(.*)$/.exec(s);
  if (mm) {
    const a = +mm[1], b = +mm[3], sep = mm[2];
    const mesPrimero = /AM|PM/i.test(s) || (b > 12 && a <= 12);
    const p1 = mesPrimero ? m : d, p2 = mesPrimero ? d : m;
    // Con ceros a la izquierda solo si el original los usa (ej. "01/11/2026")
    const conCeros = mm[1].startsWith('0') || mm[3].startsWith('0');
    const f1 = conCeros ? p1 : String(+p1);
    const f2 = conCeros ? p2 : String(+p2);
    return f1 + sep + f2 + sep + y + mm[5];
  }
  return iso;
}

function formatearRango(original, desde, hasta) {
  const partes = String(original).split(/\s+-\s+/);
  if (partes.length !== 2) return null;
  return formatearComo(partes[0], desde) + ' - ' + formatearComo(partes[1], hasta);
}

/** Nuevo payload (JSON o form-urlencoded) con las fechas del rango y el token de página. */
function ajustarPayload(payload, desde, hasta, continuationToken, inicio) {
  const cambios = { fechas: 0, token: false };
  function nuevoValor(key, val) {
    const k = normKey(key);
    if (typeof val === 'string' && /(range|rango)/.test(k) && /\s-\s/.test(val)) {
      const r = formatearRango(val, desde, hasta);
      if (r) { cambios.fechas++; return r; }
    }
    if (RX_INICIO.test(k)) { cambios.fechas++; return formatearComo(val, desde); }
    if (RX_FIN.test(k))    { cambios.fechas++; return formatearComo(val, hasta); }
    if (RX_TOKEN.test(k))  { cambios.token = true; return continuationToken || (typeof val === 'string' ? '' : null); }
    if (RX_LARGO.test(k))  return typeof val === 'number' ? 1000 : '1000';
    if (k === 'start' && inicio != null) return typeof val === 'number' ? inicio : String(inicio);
    return val;
  }
  const txt = String(payload || '').trim();
  if (txt.startsWith('{')) {
    const obj = JSON.parse(txt);
    (function walk(o) {
      Object.keys(o).forEach(function (key) {
        const v = o[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
        else o[key] = nuevoValor(key, v);
      });
    })(obj);
    if (continuationToken && !cambios.token) obj.continuationToken = continuationToken;
    return { body: JSON.stringify(obj), cambios, json: true };
  }
  const nuevos = new URLSearchParams();
  for (const [key, val] of new URLSearchParams(txt).entries()) nuevos.append(key, nuevoValor(key, val));
  if (continuationToken && !cambios.token) nuevos.set('continuationToken', continuationToken);
  return { body: nuevos.toString(), cambios, json: false };
}

async function postEnPagina(page, captura, body, json) {
  const headers = Object.assign({}, captura.headers);
  if (json) headers['content-type'] = 'application/json; charset=UTF-8';
  else if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  headers['x-requested-with'] = 'XMLHttpRequest';
  return safeEval(page, async function (p) {
    try {
      var r = await fetch(p.url, { method: 'POST', headers: p.headers, body: p.body, credentials: 'include' });
      return { ok: r.ok, status: r.status, body: await r.text() };
    } catch (e) { return { ok: false, error: e.message }; }
  }, { url: captura.url, headers, body });
}

/** Lista un rango repitiendo la petición del portal. null = no se pudo (usar plan B). */
async function consultarRango(page, captura, desde, hasta) {
  const filas = [], vistos = {};
  let token = null, inicio = 0, primera = true;
  for (let vuelta = 0; vuelta < 200; vuelta++) {
    let ajuste;
    try { ajuste = ajustarPayload(captura.payload, desde, hasta, token, inicio); }
    catch (e) { console.log('[DIAN] Payload no modificable: ' + e.message); return null; }
    if (primera && ajuste.cambios.fechas === 0) console.log('[DIAN] AVISO: el payload no tiene campos de fecha reconocibles.');
    const r = await postEnPagina(page, captura, ajuste.body, ajuste.json);
    if (!r || !r.ok) {
      console.log('[DIAN] Consulta falló: ' + (r ? (r.status || r.error) : 'sin respuesta') + ' ' + ((r && r.body) || '').substring(0, 200));
      return primera ? null : filas;
    }
    let data;
    try { data = JSON.parse(r.body); }
    catch (e) { console.log('[DIAN] Respuesta no JSON: ' + r.body.substring(0, 200)); return primera ? null : filas; }
    const rows = data.data || data.Data || data.rows || data.Rows || [];
    let nuevos = 0;
    parsearFilasAjax(rows).forEach(function (f) { if (!vistos[f.id]) { vistos[f.id] = true; filas.push(f); nuevos++; } });
    primera = false;
    const hasMore = data.hasMore === true || data.HasMore === true;
    const sig = data.continuationToken || data.ContinuationToken || null;
    const declarados = data.recordsFiltered || data.recordsTotal || 0;
    if (hasMore && sig && sig !== token) { token = sig; continue; }
    if (!hasMore && !sig && declarados > filas.length && nuevos > 0) { inicio += rows.length; continue; }
    break;
  }
  const fuera = filas.filter(function (f) { return f.fechaISO && (f.fechaISO < desde || f.fechaISO > hasta); }).length;
  if (fuera) console.log('[DIAN] AVISO: ' + fuera + '/' + filas.length + ' docs con fecha fuera de ' + desde + '..' + hasta);
  return filas;
}

function parsearFilasAjax(rows) {
  const out = [];
  (rows || []).forEach(function (r) {
    const id = r.Id || r.id || r.DocumentKey || r.documentKey || r.cufe || r.Cufe || r.CUFE || '';
    if (!id || String(id).length < 20) return;
    const cufe = r.DocumentKey || r.documentKey || r.cufe || r.Cufe || r.CUFE || id;
    const folio = r.Number || r.NumeroDocumento || '';
    const prefijo = r.Serie || r.Prefijo || '';
    const fechaISO = fechaAISO(r.EmissionDate || r.ReceptionDate || '');
    out.push({
      id: String(id), cufe: String(cufe), partitionKey: r.PartitionKey || '',
      tipo: r.DocumentTypeName || r.TipoDocumento || 'Factura electronica',
      fecha: fechaISO, fechaISO, prefijo, folio,
      nombre: r.SerieAndNumber || ((prefijo ? prefijo + '-' : '') + folio),
      nitEmisor: r.SenderCode || '', nomEmisor: r.SenderName || '',
      nitReceptor: r.ReceiverCode || '', nomReceptor: r.ReceiverName || '',
      total: r.TotalAmount || r.Amount || 0, iva: r.TaxAmountIva || 0, estado: r.StatusName || '',
    });
  });
  return out;
}

async function buscarYNavegar(page, url, desde, hasta) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await safeEval(page, function (p) {
    var s = document.getElementById('startDate'); if (s) s.value = p.start;
    var e = document.getElementById('endDate'); if (e) e.value = p.end;
    var r = document.getElementById('dashboard-report-range');
    if (r) {
      r.value = p.desde + ' - ' + p.hasta;
      r.dispatchEvent(new Event('change', { bubbles: true }));
      try { var dr = window.$ && $(r).data('daterangepicker'); if (dr) { dr.setStartDate(p.desde); dr.setEndDate(p.hasta); } } catch (x) {}
    }
    var b = Array.from(document.querySelectorAll('button,input[type=submit]'))
      .find(function (x) { return (x.textContent + (x.value || '')).toLowerCase().includes('buscar'); });
    if (b) b.click();
  }, { start: toFechaDIAN(desde), end: toFechaDIAN(hasta), desde, hasta }).catch(function () {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(function () {});
  await page.waitForFunction(function () {
    return document.querySelectorAll('button.download-document, button[data-id]').length > 0;
  }, { timeout: 10000 }).catch(function () {});
}

/** Plan B de listado: leer la tabla de la página. */
async function consultarRangoViaTabla(page, url, desde, hasta) {
  await buscarYNavegar(page, url, desde, hasta);
  const filas = await safeEval(page, function () {
    var out = [], seen = {};
    document.querySelectorAll('table tbody tr').forEach(function (tr) {
      var btn = tr.querySelector('button.download-document, button[data-id]');
      var id = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';
      var cells = Array.from(tr.querySelectorAll('td')).map(function (td) { return td.textContent.trim().replace(/\s+/g, ' '); });
      if (id.length > 20 && !seen[id] && cells.length > 2) { seen[id] = true; out.push({ id: id, cells: cells }); }
    });
    return out;
  }).catch(function () { return []; }) || [];
  return filas.map(function (f) {
    const c = f.cells;
    return {
      id: f.id, cufe: f.id, partitionKey: '', tipo: c[0] || 'Factura electronica',
      fecha: fechaAISO(c[7]) || c[7] || '', fechaISO: fechaAISO(c[7]),
      prefijo: c[3] || '', folio: c[2] || '', nombre: (c[3] ? c[3] + '-' : '') + (c[2] || ''),
      nitEmisor: c[9] || '', nomEmisor: c[10] || '', nitReceptor: c[11] || '', nomReceptor: c[12] || '',
      total: 0, iva: 0, estado: '',
    };
  });
}

// ── Descarga de documentos ────────────────────────────────────
function urlsCandidatas(doc) {
  const enc = encodeURIComponent;
  const lista = [BASE + '/Document/DownloadZipFiles?trackId=' + enc(doc.id)];
  if (doc.cufe && doc.cufe !== doc.id) lista.push(BASE + '/Document/DownloadZipFiles?trackId=' + enc(doc.cufe));
  if (doc.partitionKey) lista.push(BASE + '/Document/DownloadZipFiles?trackId=' + enc(doc.id) + '&partitionKey=' + enc(doc.partitionKey));
  return lista;
}

async function bajarEnPagina(page, url) {
  return safeEval(page, async function (u) {
    try {
      var r = await fetch(u, { credentials: 'include' });
      var buf = new Uint8Array(await r.arrayBuffer());
      if (r.ok && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B) {
        var s = '';
        for (var i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return { zipB64: btoa(s) };
      }
      var head = '';
      try { head = new TextDecoder().decode(buf.subarray(0, 300)); } catch (e) {}
      return { status: r.status, tipo: r.headers.get('content-type') || '', head: head.replace(/\s+/g, ' ') };
    } catch (e) { return { error: e.message }; }
  }, url);
}

async function extraerZip(buffer) {
  let pdfBuffer = null, xmlBuffer = null, xmlText = '';
  const zip = await JSZip.loadAsync(buffer);
  for (const [fn, file] of Object.entries(zip.files)) {
    const low = fn.toLowerCase();
    if (low.endsWith('.pdf') && !pdfBuffer) pdfBuffer = await file.async('nodebuffer');
    if (low.endsWith('.xml') && !xmlBuffer) { xmlBuffer = await file.async('nodebuffer'); xmlText = xmlBuffer.toString('utf8'); }
  }
  return { pdfBuffer, xmlBuffer, xmlText };
}

const estadoDescarga = { patron: null, diagnosticado: false };

async function descargarDocumento(page, doc) {
  const base = urlsCandidatas(doc);
  const orden = base.slice();
  if (estadoDescarga.patron != null && orden[estadoDescarga.patron]) orden.unshift(orden.splice(estadoDescarga.patron, 1)[0]);
  const fallos = [];
  for (const url of orden) {
    const r = await bajarEnPagina(page, url);
    if (r && r.zipB64) {
      estadoDescarga.patron = base.indexOf(url);
      try { return await extraerZip(Buffer.from(r.zipB64, 'base64')); }
      catch (e) { fallos.push(url.replace(BASE, '') + ' -> ZIP dañado: ' + e.message); }
    } else {
      fallos.push(url.replace(BASE, '') + ' -> ' + JSON.stringify(r).substring(0, 250));
    }
  }
  if (!estadoDescarga.diagnosticado) {
    estadoDescarga.diagnosticado = true;
    console.log('[DL] Descarga directa falló para ' + doc.nombre + ':');
    fallos.forEach(function (f) { console.log('   ' + f); });
  }
  return null;
}

/** Plan B de descarga: clic en el botón (y registrar qué peticiones hace la página). */
async function descargarDocumentoClick(page, id) {
  const vistas = [];
  const onReq = function (req) {
    if (!/\.(js|css|png|jpe?g|gif|svg|woff2?)(\?|$)/i.test(req.url())) vistas.push(req.method() + ' ' + req.url().substring(0, 160));
  };
  page.on('request', onReq);
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      safeEval(page, function (id) {
        var el = document.querySelector('button[data-id="' + id + '"]') || document.getElementById(id);
        if (el) el.click();
      }, id),
    ]);
    return await extraerZip(fs.readFileSync(await download.path()));
  } catch (e) {
    console.log('  [ERR DL click] ' + e.message.substring(0, 80));
    console.log('  [DL click] Peticiones tras el clic: ' + (vistas.length ? vistas.slice(0, 10).join(' | ') : 'ninguna'));
    const captcha = await safeEval(page, function () {
      return !!document.querySelector('iframe[src*="turnstile"], iframe[src*="recaptcha"], .cf-turnstile, .g-recaptcha');
    }).catch(function () { return false; });
    if (captcha) console.log('  [DL click] La página muestra un CAPTCHA al descargar.');
    return null;
  } finally {
    page.off('request', onReq);
  }
}

// ── Función principal ─────────────────────────────────────────
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, soloXML = false, onProgreso }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const dias = Math.round((new Date(fechaFin + 'T00:00:00') - new Date(fechaInicio + 'T00:00:00')) / 86400000);
  const rangos = dias > 31 ? dividirEnMeses(fechaInicio, fechaFin) : [{ desde: fechaInicio, hasta: fechaFin }];
  const grupos = grupo && PAGINAS[grupo] ? [grupo] : Object.keys(PAGINAS);
  console.log('[DIAN] Rangos: ' + rangos.length + ' | Dias: ' + dias + ' | Grupos: ' + grupos.join(',') + ' | soloXML: ' + soloXML);

  const progreso = function (fase, n, total) {
    global._edianTotal = total; global._edianDescargados = n;
    if (onProgreso) onProgreso({ fase, n, total });
  };
  estadoDescarga.patron = null;
  estadoDescarga.diagnosticado = false;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    progreso('conectando', 0, 0);
    await autenticar(context, page, pk, nit, token);

    // FASE 1: listar
    const todos = [], vistos = {};
    for (const g of grupos) {
      const captura = await capturarConsulta(page, PAGINAS[g]);
      for (const rango of rangos) {
        let filas = captura ? await consultarRango(page, captura, rango.desde, rango.hasta) : null;
        if (filas == null) filas = await consultarRangoViaTabla(page, PAGINAS[g], rango.desde, rango.hasta);
        let nuevos = 0;
        filas.forEach(function (f) {
          if (vistos[f.id]) return;
          vistos[f.id] = true; nuevos++;
          todos.push(Object.assign({}, f, {
            grupo: g,
            cufeUrl: BASE + '/document/searchqr?documentkey=' + f.cufe,
            nitReceptor: f.nitReceptor || (g === 'Recibido' ? nit : ''),
            rangoDesde: rango.desde, rangoHasta: rango.hasta,
          }));
        });
        console.log('[DIAN] ' + g + ' ' + rango.desde + '..' + rango.hasta + ': ' + filas.length + ' docs (' + nuevos + ' nuevos)');
      }
    }
    console.log('[DIAN] TOTAL documentos: ' + todos.length);
    progreso('descargando', 0, todos.length);

    // FASE 2: descargar directo, en paralelo
    const documentos = [], pendientes = [];
    let hechos = 0;
    for (let i = 0; i < todos.length; i += DESCARGAS_PARALELAS) {
      const lote = todos.slice(i, i + DESCARGAS_PARALELAS);
      const res = await Promise.all(lote.map(function (doc) { return descargarDocumento(page, doc); }));
      res.forEach(function (a, j) {
        if (a) documentos.push(Object.assign({}, lote[j], { pdfBuffer: soloXML ? null : a.pdfBuffer, xmlBuffer: a.xmlBuffer, xmlText: a.xmlText }));
        else pendientes.push(lote[j]);
      });
      hechos += lote.length;
      progreso('descargando', hechos, todos.length);
      // Si la descarga directa no funciona con los primeros, no insistir.
      if (estadoDescarga.patron == null && pendientes.length >= Math.min(todos.length, DESCARGAS_PARALELAS * 2)) {
        todos.slice(i + DESCARGAS_PARALELAS).forEach(function (d) { pendientes.push(d); });
        break;
      }
    }

    // Plan B: clic en el botón
    if (pendientes.length) {
      console.log('[DIAN] ' + pendientes.length + ' docs sin descarga directa; probando con clic...');
      const porPagina = {};
      pendientes.forEach(function (d) { (porPagina[d.grupo + '|' + d.rangoDesde] = porPagina[d.grupo + '|' + d.rangoDesde] || []).push(d); });
      let fallidos = 0;
      for (const k of Object.keys(porPagina)) {
        const docs = porPagina[k];
        if (fallidos < 2) await buscarYNavegar(page, PAGINAS[docs[0].grupo], docs[0].rangoDesde, docs[0].rangoHasta);
        for (const doc of docs) {
          const a = fallidos >= 2 ? null : await descargarDocumentoClick(page, doc.id);
          if (!a) fallidos++;
          documentos.push(Object.assign({}, doc, {
            pdfBuffer: a && !soloXML ? a.pdfBuffer : null, xmlBuffer: a ? a.xmlBuffer : null, xmlText: a ? a.xmlText : '',
          }));
        }
      }
    }

    const sinArchivo = documentos.filter(function (d) { return !d.xmlText; }).length;
    console.log('[DIAN] Completado: ' + (documentos.length - sinArchivo) + '/' + todos.length + ' con archivos');
    return { documentos, nit, total: documentos.length, filasEncontradas: todos.length, sinArchivo };
  } finally {
    await browser.close();
  }
}

async function diagnosticarPortal(tokenUrl) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/131.0' });
  const page = await context.newPage();
  try {
    await autenticar(context, page, pk, nit, token);
    const captura = await capturarConsulta(page, PAGINAS.Recibido);
    const info = await page.evaluate(function () {
      return {
        url: location.href, titulo: document.title,
        inputs: Array.from(document.querySelectorAll('input,select')).map(function (el) {
          return { id: el.id, name: el.name, type: el.type, value: String(el.value).substring(0, 80) };
        }),
        botonDescarga: (document.querySelector('button.download-document, button[data-id]') || {}).outerHTML || null,
      };
    });
    return { ok: true, nit, consulta: captura ? { url: captura.url, payload: captura.payload.substring(0, 2000) } : null, ...info };
  } finally { await browser.close(); }
}

module.exports = {
  descargarDIAN, diagnosticarPortal, parseTokenUrl,
  // para pruebas
  ajustarPayload, formatearComo, fechaAISO, dividirEnMeses, parsearFilasAjax,
};
