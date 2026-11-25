const { chromium } = require('playwright');
const JSZip = require('jszip');
const XLSX = require('xlsx');
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
const GRATIS = 'https://gratis-vpfe.dian.gov.co'; // Solución Gratuita: DownloadXml da el XML sin captcha
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

async function autenticar(context, page, pk, nit, token, base) {
  base = base || BASE;
  console.log('[DIAN] Autenticando NIT ' + nit + ' en ' + base);
  await page.goto(base + '/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
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
      if (!r.ok) {
        var h0 = ''; try { h0 = new TextDecoder().decode(buf.subarray(0, 300)); } catch (e) {}
        return { status: r.status, tipo: r.headers.get('content-type') || '', head: h0.replace(/\s+/g, ' ') };
      }
      var b64 = function (b) { var s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
      // ZIP (empieza con "PK")
      if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B) return { zipB64: b64(buf) };
      // PDF (empieza con "%PDF")
      if (buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return { pdfB64: b64(buf) };
      // XML directo (DownloadXml de la Solución Gratuita)
      var txt = ''; try { txt = new TextDecoder().decode(buf); } catch (e) {}
      if (/<\?xml|<AttachedDocument|<Invoice|<CreditNote|<DebitNote/i.test(txt.substring(0, 500))) {
        return { xmlText: txt };
      }
      return { status: r.status, tipo: r.headers.get('content-type') || '', head: txt.substring(0, 300).replace(/\s+/g, ' ') };
    } catch (e) { return { error: e.message }; }
  }, url);
}

const estadoGratis = { diagnosticado: false, type: null };

/** Descarga XML (y PDF, si no es soloXML) desde la Solución Gratuita usando el CUFE. */
async function descargarGratis(page, doc, soloXML) {
  if (!page) return null;
  let xml = null;
  const tipos = estadoGratis.type != null ? [estadoGratis.type, 2, 1, 3] : [2, 1, 3];
  for (const type of tipos) {
    const r = await bajarEnPagina(page, GRATIS + '/Document/DownloadXml?transactionId=' + encodeURIComponent(doc.cufe) + '&type=' + type);
    if (r && r.xmlText && r.xmlText.indexOf('<') >= 0) { xml = { xmlBuffer: Buffer.from(r.xmlText, 'utf8'), xmlText: r.xmlText }; estadoGratis.type = type; break; }
    if (r && r.zipB64) { try { const z = await extraerZip(Buffer.from(r.zipB64, 'base64')); if (z.xmlText) { xml = z; estadoGratis.type = type; break; } } catch (e) {} }
    if (!estadoGratis.diagnosticado) {
      estadoGratis.diagnosticado = true;
      console.log('[GRATIS] DownloadXml type=' + type + ' para ' + doc.nombre + ' -> ' + JSON.stringify(r).substring(0, 220));
    }
  }
  if (!xml) return null;
  let pdfBuffer = xml.pdfBuffer || null;
  if (!soloXML && !pdfBuffer) {
    const rp = await bajarEnPagina(page, GRATIS + '/IoFacturo/Print/PrintStoragePdf?transactionId=' + encodeURIComponent(doc.cufe) + '&viewMode=attachment');
    if (rp && rp.pdfB64) pdfBuffer = Buffer.from(rp.pdfB64, 'base64');
  }
  return { pdfBuffer, xmlBuffer: xml.xmlBuffer, xmlText: xml.xmlText };
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

/** Entra a la Solución Gratuita por el menú de catalogo (clic en "Solución Gratuita → Ingreso").
 *  La sesión queda en las cookies del contexto (compartidas por todas las pestañas). */
async function ssoDesdeMenu(context, pk, nit, token) {
  const p = await context.newPage();
  let ssoUrl = null;
  const vistos = [];
  p.on('request', function (req) { const u = req.url(); if (u.indexOf('gratis-vpfe') >= 0) { if (!ssoUrl) ssoUrl = u; if (vistos.length < 8) vistos.push(req.method() + ' ' + u.substring(0, 110)); } });
  const onPop = async function (pop) { try { await pop.waitForLoadState('domcontentloaded', { timeout: 8000 }); const u = pop.url(); if (u.indexOf('gratis-vpfe') >= 0 && !ssoUrl) ssoUrl = u; } catch (e) {} };
  context.on('page', onPop);
  const clicTxt = async function (re) {
    try {
      const loc = p.getByText(re, { exact: false }).first();
      if (await loc.count()) { await loc.click({ timeout: 4000 }).catch(function () {}); return true; }
    } catch (e) {}
    // respaldo: clic por DOM
    return await p.evaluate(function (src) {
      var re = new RegExp(src, 'i');
      var els = Array.from(document.querySelectorAll('a,button,span,li,div'));
      for (var i = 0; i < els.length; i++) { var t = (els[i].textContent || '').trim(); if (t.length < 40 && re.test(t)) { els[i].click(); return true; } }
      return false;
    }, re.source).catch(function () { return false; });
  };
  try {
    await autenticar(context, p, pk, nit, token, BASE);
    await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(1500);

    // Diagnóstico: qué elementos del menú se relacionan con la Solución Gratuita
    const candidatos = await p.evaluate(function () {
      return Array.from(document.querySelectorAll('a,button,li,span'))
        .map(function (e) { return { t: (e.textContent || '').trim().substring(0, 28), h: e.getAttribute('href'), o: (e.getAttribute('onclick') || '').substring(0, 70) }; })
        .filter(function (x) { return /gratuit|ingreso|usuarios sg|\bsg\b/i.test(x.t) || /gratis|ioFacturo|SolucionGratuita/i.test((x.h || '') + (x.o || '')); });
    }).catch(function () { return []; });
    console.log('[GRATIS] Menú candidatos: ' + JSON.stringify(candidatos).substring(0, 700));

    // Abrir menú hamburguesa (si existe) y desplegar "Solución Gratuita"
    await p.evaluate(function () {
      var m = document.querySelector('[class*="hamburg"],[class*="menu-toggle"],[class*="navbar-toggler"],button[aria-label*="men" i],.fa-bars,[class*="bars"]');
      if (m) (m.closest('a,button') || m).click();
    }).catch(function () {});
    await p.waitForTimeout(700);

    // Hasta 3 intentos de "Solución Gratuita" -> "Ingreso"
    for (let intento = 1; intento <= 3 && !ssoUrl; intento++) {
      await clicTxt(/soluci.n\s+gratuita/);
      await p.waitForTimeout(800);
      const nav = p.waitForNavigation({ timeout: 6000 }).catch(function () { return null; });
      const pop = context.waitForEvent('page', { timeout: 6000 }).catch(function () { return null; });
      await clicTxt(/^ingreso$/);
      const r = await Promise.race([nav, pop]);
      if (r && typeof r.url === 'function') { try { await r.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch (e) {} if (r.url().indexOf('gratis-vpfe') >= 0) ssoUrl = r.url(); }
      for (let i = 0; i < 8 && !ssoUrl; i++) await p.waitForTimeout(500);
      if (!ssoUrl && p.url().indexOf('gratis-vpfe') >= 0) ssoUrl = p.url();
      console.log('[GRATIS] Intento ' + intento + ' -> ' + (ssoUrl ? ssoUrl.substring(0, 90) : 'sin navegación a gratis-vpfe'));
    }
    console.log('[GRATIS] Menú -> peticiones a gratis-vpfe: ' + (vistos.length ? vistos.join(' | ') : 'ninguna'));
  } catch (e) {
    console.log('[GRATIS] ssoDesdeMenu error: ' + e.message);
  } finally {
    context.off('page', onPop);
    await p.close().catch(function () {});
  }
  return ssoUrl;
}

/** Abre una pestaña autenticada en gratis-vpfe. Devuelve la página o null si no se logra. */
async function abrirGratis(context, catalogoPage, pk, nit, token, docPrueba, soloXML) {
  if (!docPrueba) return null;
  let page = null;
  try {
    page = await context.newPage();
    // Estrategia A: el mismo token directamente en gratis-vpfe
    try { await autenticar(context, page, pk, nit, token, GRATIS); } catch (e) { console.log('[GRATIS] AuthToken directo: ' + e.message); }
    if (page.url().indexOf('AuthToken') < 0 && await descargarGratis(page, docPrueba, soloXML)) {
      console.log('[GRATIS] Sesión OK (token directo): XML' + (soloXML ? '' : ' + PDF') + '.');
      return page;
    }
    // Estrategia B: SSO oficial — el botón "Ingreso" apunta a /User/RedirectToBiller
    estadoGratis.diagnosticado = false;
    const onPop = async function (pop) { try { await pop.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch (e) {} };
    context.on('page', onPop);
    try {
      for (let intento = 1; intento <= 3; intento++) {
        try {
          await page.goto(BASE + '/User/RedirectToBiller', { waitUntil: 'domcontentloaded', timeout: 40000 });
        } catch (e) { console.log('[GRATIS] RedirectToBiller intento ' + intento + ': ' + e.message.substring(0, 60)); }
        await page.waitForTimeout(2500);
        const url = page.url();
        // Si quedó en gratis-vpfe, probar la descarga ahí mismo
        if (url.indexOf('gratis-vpfe') < 0) await page.goto(GRATIS + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(function () {});
        await page.waitForTimeout(800);
        if (await descargarGratis(page, docPrueba, soloXML)) {
          console.log('[GRATIS] Sesión OK (RedirectToBiller, intento ' + intento + '): XML' + (soloXML ? '' : ' + PDF') + '.');
          context.off('page', onPop);
          return page;
        }
        console.log('[GRATIS] RedirectToBiller intento ' + intento + ': aún sin acceso (url=' + url.substring(0, 60) + ')');
        estadoGratis.diagnosticado = false;
      }
    } finally {
      context.off('page', onPop);
    }
    console.log('[GRATIS] No se pudo entrar a la Solución Gratuita; se usará el método normal.');
    await page.close().catch(function () {});
    return null;
  } catch (e) {
    console.log('[GRATIS] Error abriendo gratis-vpfe: ' + e.message);
    if (page) await page.close().catch(function () {});
    return null;
  }
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

// ── Listar por la exportación oficial ("Descargar listados") ──
const LISTADOS_URLS = [
  BASE + '/Document/Export',
];
// Tipos que no tienen archivo para descargar (acuses de recibo, etc.)
const TIPOS_OMITIR = /application\s*response|acuse/i;

function normcol(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

/** Lee un archivo subido (xlsx suelto o ZIP que contiene el xlsx) -> lista de documentos. */
async function docsDesdeArchivo(buffer) {
  let xlsxBuf = buffer;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entry = Object.keys(zip.files).find(function (n) { return n.toLowerCase().endsWith('.xlsx'); });
    if (entry) xlsxBuf = await zip.files[entry].async('nodebuffer'); // era un ZIP con el xlsx dentro
  } catch (e) { /* no era zip; se asume xlsx directo */ }
  return docsDesdeXlsxBuffer(xlsxBuf);
}

/** Convierte el ZIP exportado (con el .xlsx dentro) en la lista de documentos. */
async function docsDesdeExportZip(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const nombre = Object.keys(zip.files).find(function (n) { return n.toLowerCase().endsWith('.xlsx'); });
  if (!nombre) throw new Error('El ZIP exportado no trae .xlsx');
  return docsDesdeXlsxBuffer(await zip.files[nombre].async('nodebuffer'));
}

/** Convierte el contenido de un .xlsx (Buffer) en la lista de documentos. */
function docsDesdeXlsxBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
  if (!rows.length) return [];
  const H = rows[0].map(function (x) { return normcol(x); });
  const col = function (re) { return H.findIndex(function (h) { return re.test(h); }); };
  const iCufe = col(/cufe|cude/), iTipo = col(/tipo de documento/), iFolio = col(/folio/), iPref = col(/prefijo/),
    iFecha = col(/fecha emis/), iNitE = col(/nit emisor/), iNomE = col(/nombre emisor/),
    iNitR = col(/nit receptor/), iNomR = col(/nombre receptor/), iTot = col(/^total$/), iGrupo = col(/grupo/);
  if (iCufe < 0) throw new Error('El Excel exportado no tiene columna CUFE/CUDE');
  const docs = [];
  let omitidos = 0;
  for (const r of rows.slice(1)) {
    const cufe = String(r[iCufe] || '').trim();
    if (cufe.length < 40) continue;
    const tipo = iTipo >= 0 ? String(r[iTipo] || '') : '';
    if (TIPOS_OMITIR.test(tipo)) { omitidos++; continue; }
    const folio = iFolio >= 0 ? String(r[iFolio] || '') : '';
    const prefijo = iPref >= 0 ? String(r[iPref] || '') : '';
    docs.push({
      id: cufe, cufe: cufe, partitionKey: '',
      tipo: tipo || 'Factura electronica',
      fecha: fechaAISO(iFecha >= 0 ? r[iFecha] : '') || (iFecha >= 0 ? String(r[iFecha] || '') : ''),
      prefijo: prefijo, folio: folio,
      nombre: (prefijo ? prefijo + '-' : '') + folio,
      nitEmisor: iNitE >= 0 ? String(r[iNitE] || '') : '',
      nomEmisor: iNomE >= 0 ? String(r[iNomE] || '') : '',
      nitReceptor: iNitR >= 0 ? String(r[iNitR] || '') : '',
      nomReceptor: iNomR >= 0 ? String(r[iNomR] || '') : '',
      total: iTot >= 0 ? (parseFloat(String(r[iTot]).replace(/[^0-9.-]/g, '')) || 0) : 0,
      estado: '', grupo: (iGrupo >= 0 && /emit/i.test(String(r[iGrupo]))) ? 'Emitido' : 'Recibido',
    });
  }
  if (omitidos) console.log('[EXPORT] Omitidos ' + omitidos + ' acuses (Application response)');
  return docs;
}

/** Genera la exportación en catalogo, la descarga y la convierte en lista de documentos. null si no se logra. */
async function listarViaExport(page, nit, desde, hasta) {
  // 1) Abrir la página "Descargar listados"
  let enPagina = false;
  for (const u of LISTADOS_URLS) {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!/\/login/i.test(page.url())) {
        const hayBoton = await page.evaluate(function () {
          return Array.from(document.querySelectorAll('button,a,input')).some(function (b) { return /exportar\s*excel/i.test((b.textContent || '') + (b.value || '')); });
        }).catch(function () { return false; });
        if (hayBoton) { enPagina = true; console.log('[EXPORT] Página de listados: ' + u); break; }
      }
    } catch (e) {}
  }
  if (!enPagina) {
    // intentar por el menú
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(function () {});
    await page.evaluate(function () {
      var m = document.querySelector('[class*="hamburg"],[class*="menu-toggle"],.navbar-toggler,[class*="bars"]'); if (m) (m.closest('a,button') || m).click();
    }).catch(function () {});
    await page.waitForTimeout(600);
    const nav = page.waitForNavigation({ timeout: 8000 }).catch(function () { return null; });
    await page.evaluate(function () {
      var els = Array.from(document.querySelectorAll('a,button,span,li,div'));
      for (var i = 0; i < els.length; i++) { var t = (els[i].textContent || '').trim(); if (/descargar\s*listados|^listados$/i.test(t) && t.length < 40) { els[i].click(); return; } }
    }).catch(function () {});
    await nav;
    await page.waitForTimeout(1500);
    enPagina = await page.evaluate(function () {
      return Array.from(document.querySelectorAll('button,a,input')).some(function (b) { return /exportar\s*excel/i.test((b.textContent || '') + (b.value || '')); });
    }).catch(function () { return false; });
    console.log('[EXPORT] Página de listados por menú: ' + (enPagina ? page.url() : 'no encontrada'));
  }
  if (!enPagina) { console.log('[EXPORT] No se encontró la página "Descargar listados".'); return null; }

  // 2) Links de export existentes antes de generar (para detectar el nuevo)
  const previos = await page.evaluate(function () {
    return Array.from(document.querySelectorAll('a[href*="DownloadExportedZipFile"]')).map(function (a) { return a.href; });
  }).catch(function () { return []; });

  // 3) Fijar fechas + Grupos=Todos y pulsar "Exportar Excel"
  await page.evaluate(function (p) {
    function setFecha(el, v) { if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    // daterangepicker: input visible con "desde - hasta"
    var rango = document.querySelector('#dashboard-report-range, input[name*="range" i], input[id*="range" i], input[id*="fecha" i]');
    setFecha(rango, p.desde + ' - ' + p.hasta);
    setFecha(document.getElementById('startDate'), p.desde);
    setFecha(document.getElementById('endDate'), p.hasta);
    try { if (window.$ && $(rango).data) { var dr = $(rango).data('daterangepicker'); if (dr) { dr.setStartDate(p.desde); dr.setEndDate(p.hasta); } } } catch (e) {}
    // Grupos = Todos
    var sel = document.querySelector('select[id*="grupo" i], select[name*="grupo" i]');
    if (sel) { for (var i = 0; i < sel.options.length; i++) { if (/todos/i.test(sel.options[i].textContent)) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); break; } } }
  }, { desde, hasta }).catch(function () {});
  await page.waitForTimeout(500);
  await page.evaluate(function () {
    var b = Array.from(document.querySelectorAll('button,a,input')).find(function (x) { return /exportar\s*excel/i.test((x.textContent || '') + (x.value || '')); });
    if (b) b.click();
  }).catch(function () {});
  console.log('[EXPORT] Exportación solicitada: ' + desde + '..' + hasta);

  // 4) Esperar a que aparezca un link de export NUEVO (hasta ~2 min)
  let nuevo = null;
  for (let i = 0; i < 48 && !nuevo; i++) {
    await page.waitForTimeout(2500);
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (e) {}
    nuevo = await page.evaluate(function (prev) {
      var links = Array.from(document.querySelectorAll('a[href*="DownloadExportedZipFile"]')).map(function (a) { return a.href; });
      return links.find(function (h) { return prev.indexOf(h) < 0; }) || null;
    }, previos).catch(function () { return null; });
  }
  if (!nuevo) { console.log('[EXPORT] La exportación no quedó lista a tiempo.'); return null; }
  console.log('[EXPORT] Exportación lista: ' + nuevo.substring(0, 110));

  // 5) Descargar el ZIP y leer el Excel
  const r = await bajarEnPagina(page, nuevo);
  if (!r || !r.zipB64) { console.log('[EXPORT] No se pudo descargar el ZIP: ' + JSON.stringify(r).substring(0, 200)); return null; }
  const docs = await docsDesdeExportZip(Buffer.from(r.zipB64, 'base64'), nit);
  console.log('[EXPORT] Documentos leídos del Excel: ' + docs.length);
  return docs;
}

// ── Función principal ─────────────────────────────────────────
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, soloXML = false, soloListar = false, documentosPrecargados = null, onProgreso }) {
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

    // FASE 1: listar — primero por la exportación oficial (rápida); si falla, rastreo por grupo
    let todos = [];
    const vistos = {};
    const agregar = function (f, g) {
      if (vistos[f.id]) return;
      vistos[f.id] = true;
      todos.push(Object.assign({}, f, {
        grupo: g || f.grupo,
        cufeUrl: BASE + '/document/searchqr?documentkey=' + f.cufe,
        nitReceptor: f.nitReceptor || ((g || f.grupo) === 'Recibido' ? nit : ''),
        rangoDesde: fechaInicio, rangoHasta: fechaFin,
      }));
    };

    let viaExport = null;
    if (documentosPrecargados && documentosPrecargados.length) {
      viaExport = documentosPrecargados; // lista subida por el usuario (Excel del listado)
      console.log('[LISTADO] Documentos precargados desde archivo: ' + documentosPrecargados.length);
    } else {
      try { viaExport = await listarViaExport(page, nit, fechaInicio, fechaFin); }
      catch (e) { console.log('[EXPORT] Error: ' + e.message); }
    }

    if (viaExport && viaExport.length) {
      viaExport.forEach(function (f) { agregar(f, f.grupo); });
      console.log('[DIAN] TOTAL documentos (lista): ' + todos.length);
    } else {
      console.log('[DIAN] Export no disponible; usando rastreo por grupo.');
      for (const g of grupos) {
        const captura = await capturarConsulta(page, PAGINAS[g]);
        for (const rango of rangos) {
          let filas = captura ? await consultarRango(page, captura, rango.desde, rango.hasta) : null;
          if (filas == null) filas = await consultarRangoViaTabla(page, PAGINAS[g], rango.desde, rango.hasta);
          filas = filas.filter(function (f) { return !TIPOS_OMITIR.test(f.tipo || ''); });
          const antes = todos.length;
          filas.forEach(function (f) { f.rangoDesde = rango.desde; f.rangoHasta = rango.hasta; agregar(f, g); });
          console.log('[DIAN] ' + g + ' ' + rango.desde + '..' + rango.hasta + ': ' + filas.length + ' docs (' + (todos.length - antes) + ' nuevos)');
        }
      }
      console.log('[DIAN] TOTAL documentos: ' + todos.length);
    }
    if (soloListar) {
      progreso('listo', todos.length, todos.length);
      return { documentos: todos, nit, total: todos.length, filasEncontradas: todos.length, sinArchivo: 0 };
    }
    progreso('descargando', 0, todos.length);

    // Intentar abrir sesión en la Solución Gratuita (gratis-vpfe) para bajar XML + PDF.
    const gratisPage = await abrirGratis(context, page, pk, nit, token, todos[0], soloXML);

    // FASE 2: descargar. Primero por gratis-vpfe (XML+PDF sin captcha); si no, por catalogo.
    const documentos = [], pendientes = [];
    let hechos = 0;
    const bajarUno = async function (doc) {
      if (gratisPage) {
        const x = await descargarGratis(gratisPage, doc, soloXML);
        if (x) return x;
      }
      return await descargarDocumento(page, doc);
    };
    for (let i = 0; i < todos.length; i += DESCARGAS_PARALELAS) {
      const lote = todos.slice(i, i + DESCARGAS_PARALELAS);
      const res = await Promise.all(lote.map(bajarUno));
      res.forEach(function (a, j) {
        if (a) documentos.push(Object.assign({}, lote[j], { pdfBuffer: soloXML ? null : a.pdfBuffer, xmlBuffer: a.xmlBuffer, xmlText: a.xmlText }));
        else pendientes.push(lote[j]);
      });
      hechos += lote.length;
      progreso('descargando', hechos, todos.length);
      // Si no hay gratis y la descarga directa tampoco funciona con los primeros, no insistir.
      if (!gratisPage && estadoDescarga.patron == null && pendientes.length >= Math.min(todos.length, DESCARGAS_PARALELAS * 2)) {
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
  ajustarPayload, formatearComo, fechaAISO, dividirEnMeses, parsearFilasAjax, docsDesdeExportZip, docsDesdeArchivo,
};
