const { chromium } = require('playwright');
const JSZip = require('jszip');
const fs = require('fs');

function parseTokenUrl(url) {
  try {
    const u = new URL(url.trim());
    const rk = u.searchParams.get('rk');
    const token = u.searchParams.get('token');
    const pk = u.searchParams.get('pk') || '';
    if (!rk || !token) throw new Error('Faltan parametros rk o token en el URL');
    return { nit: rk, token, pk };
  } catch (e) {
    throw new Error('URL del token invalida: ' + e.message);
  }
}

function formatearFechaDIAN(fechaISO) {
  // Convierte 2026-01-01 a M/D/YYYY 12:00:00 AM
  const [y, m, d] = fechaISO.split('-');
  return parseInt(m) + '/' + parseInt(d) + '/' + y + ' 12:00:00 AM';
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
    if (page.url().includes('Login') || page.url().includes('login')) {
      throw new Error('Token invalido o expirado.');
    }

    // 2. Cargar pagina de documentos recibidos
    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'networkidle', timeout: 30000 });
    console.log('[DIAN] Pagina cargada');

    // 3. Obtener CSRF y campos ocultos
    const formInfo = await page.evaluate(function() {
      function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      return {
        csrf: val('') || (document.querySelector('input[name="__RequestVerificationToken"]') || {}).value || '',
        page: val('Page') || '0',
        startDate: val('startDate'),
        endDate: val('endDate'),
      };
    });

    const csrf = formInfo.csrf || '';
    const startDate = formatearFechaDIAN(fechaInicio);
    const endDate = formatearFechaDIAN(fechaFin);
    console.log('[DIAN] Fechas: ' + startDate + ' / ' + endDate);
    console.log('[DIAN] CSRF: ' + csrf.substring(0, 15) + '...');

    // 4. Hacer POST con las fechas correctas usando fetch dentro del browser
    const htmlResultado = await page.evaluate(async function(params) {
      var body = new URLSearchParams();
      body.append('__RequestVerificationToken', params.csrf);
      body.append('Page', '0');
      body.append('StartDate', params.startDate);
      body.append('EndDate', params.endDate);
      body.append('DocumentKey', '');
      body.append('SerieAndNumber', '');
      body.append('SenderCode', params.grupo === 'Emitido' ? '' : '');
      body.append('ReceiverCode', '');
      body.append('DocumentTypeId', '');
      body.append('StatusId', '');
      body.append('RadianStatusId', '');
      body.append('ReferenceTypeId', '');

      var resp = await fetch('/Document/Received', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
      });
      return await resp.text();
    }, { csrf, startDate, endDate, grupo: grupo || '' });

    console.log('[DIAN] HTML recibido: ' + htmlResultado.length + ' chars');

    // 5. Parsear el HTML con los resultados
    await page.setContent(htmlResultado);
    await page.waitForTimeout(1000);

    // 6. Extraer filas de la tabla de resultados
    const filas = await page.evaluate(function() {
      var resultado = [];
      var rows = document.querySelectorAll('table tbody tr, #tbl-documents tbody tr, .table tbody tr');
      rows.forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
          return td.textContent.trim().replace(/\s+/g, ' ');
        });
        var links = Array.from(tr.querySelectorAll('a')).map(function(a) {
          return { href: a.href, text: a.textContent.trim(), title: a.title || '' };
        });
        if (cells.length > 2 && cells.some(function(c) { return c.length > 3; })) {
          resultado.push({ cells: cells, links: links });
        }
      });
      // Si no hay tabla, buscar datos en el HTML de otra forma
      if (resultado.length === 0) {
        var html = document.body.innerHTML;
        return { fallback: true, html: html.substring(0, 3000), filas: [] };
      }
      return resultado;
    });

    if (filas.fallback) {
      console.log('[DIAN] No se encontro tabla, HTML:', filas.html.substring(0, 500));
      return { documentos: [], nit, total: 0, debug: { html: filas.html } };
    }

    console.log('[DIAN] Filas encontradas: ' + filas.length);

    // 7. Descargar ZIP de cada documento
    const documentos = [];
    // Volver a cargar la pagina original para tener sesion activa al descargar
    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'networkidle', timeout: 30000 });

    // Re-hacer el POST para tener los resultados con links funcionales
    await page.evaluate(async function(params) {
      var body = new URLSearchParams();
      body.append('__RequestVerificationToken', params.csrf);
      body.append('Page', '0');
      body.append('StartDate', params.startDate);
      body.append('EndDate', params.endDate);
      body.append('DocumentKey', '');
      body.append('SerieAndNumber', '');
      body.append('DocumentTypeId', '');
      body.append('StatusId', '');
      var form = document.createElement('form');
      form.method = 'POST';
      form.action = '/Document/Received';
      for (var pair of body.entries()) {
        var inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = pair[0];
        inp.value = pair[1];
        form.appendChild(inp);
      }
      document.body.appendChild(form);
      form.submit();
    }, { csrf, startDate, endDate });

    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(2000);

    // 8. Extraer links de descarga de la pagina resultante
    const linksDescarga = await page.evaluate(function() {
      var links = [];
      document.querySelectorAll('a').forEach(function(a) {
        var h = a.href || '';
        if (h.includes('Download') || h.includes('download') || h.includes('zip') ||
            h.includes('ZIP') || h.includes('GetFile') || h.includes('documento')) {
          links.push({ href: h, text: a.textContent.trim() });
        }
      });
      var filas = [];
      document.querySelectorAll('table tbody tr').forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) { return td.textContent.trim().replace(/\s+/g,' '); });
        var trLinks = Array.from(tr.querySelectorAll('a')).map(function(a) { return { href: a.href, text: a.textContent.trim() }; });
        if (cells.length > 2) filas.push({ cells: cells, links: trLinks });
      });
      return { links: links, filas: filas, total: filas.length };
    });

    console.log('[DIAN] Links descarga: ' + linksDescarga.links.length);
    console.log('[DIAN] Filas tabla final: ' + linksDescarga.total);

    for (var i = 0; i < linksDescarga.filas.length; i++) {
      var fila = linksDescarga.filas[i];
      var linkZip = fila.links.find(function(l) {
        return l.href && (l.href.includes('Download') || l.href.includes('download') ||
               l.href.includes('zip') || l.href.includes('ZIP') || l.href.includes('GetFile'));
      });
      if (!linkZip) continue;
      try {
        var dl = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          page.goto(linkZip.href),
        ]);
        var pathDl = await dl[0].path();
        var buffer = fs.readFileSync(pathDl);
        var zip = await JSZip.loadAsync(buffer);
        var pdfBuffer = null, xmlBuffer = null, xmlText = '';
        for (var entry of Object.entries(zip.files)) {
          var fname = entry[0]; var file = entry[1];
          if (fname.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
          if (fname.toLowerCase().endsWith('.xml')) {
            xmlBuffer = await file.async('nodebuffer');
            xmlText = await file.async('text');
          }
        }
        var folio = fila.cells[2] || fila.cells[1] || 'doc-' + i;
        documentos.push({ cufe: fila.cells[1]||'', folio, tipo: fila.cells[0]||'', fecha: fila.cells[7]||fila.cells[3]||'', pdfBuffer, xmlBuffer, xmlText, nombre: folio });
        console.log('  [OK] ' + folio);
      } catch(err) {
        console.error('  [ERR]', err.message);
      }
    }

    return { documentos, nit, total: documentos.length, filas: linksDescarga.total };

  } finally {
    await browser.close();
  }
}

async function diagnosticarPortal(tokenUrl) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/120' });
  const page = await context.newPage();
  try {
    await page.goto('https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk='+pk+'&rk='+nit+'&token='+token, { waitUntil: 'networkidle', timeout: 40000 });
    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'networkidle', timeout: 30000 });
    const info = await page.evaluate(function() {
      return {
        url: window.location.href,
        titulo: document.title,
        inputs: Array.from(document.querySelectorAll('input,select')).map(function(el) {
          return { id: el.id, name: el.name, type: el.type, value: el.value.substring(0,60), placeholder: el.placeholder };
        }),
        html: document.body.innerHTML.substring(0, 5000),
      };
    });
    return { ok: true, nit, ...info };
  } finally {
    await browser.close();
  }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
