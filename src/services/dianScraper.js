const { chromium } = require('playwright');
const JSZip = require('jszip');
const fs = require('fs');
const https = require('https');
const querystring = require('querystring');

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

/**
 * descargarDIAN
 * 1. Autentica con Playwright para obtener las cookies de sesion
 * 2. Usa esas cookies para hacer el POST directo a /Document/Received
 * 3. Parsea los resultados y descarga cada ZIP
 */
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
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

    const currentUrl = page.url();
    console.log('[DIAN] URL post-auth: ' + currentUrl);
    if (currentUrl.includes('Login') || currentUrl.includes('login')) {
      throw new Error('Token invalido o expirado. Solicita un nuevo token en el portal de la DIAN.');
    }

    // 2. Obtener cookies
    const cookies = await context.cookies();
    const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
    console.log('[DIAN] Cookies obtenidas: ' + cookies.length);

    // 3. Ir a la pagina de documentos recibidos para obtener el token CSRF
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/Document/Received',
      { waitUntil: 'networkidle', timeout: 30000 }
    );

    // Obtener el token antiforgery del HTML
    const csrfToken = await page.evaluate(function() {
      var meta = document.querySelector('input[name="__RequestVerificationToken"]');
      if (meta) return meta.value;
      var metaTag = document.querySelector('meta[name="__RequestVerificationToken"]');
      if (metaTag) return metaTag.getAttribute('content');
      // Buscar en el HTML
      var match = document.documentElement.innerHTML.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
      if (match) return match[1];
      return null;
    });
    console.log('[DIAN] CSRF Token: ' + (csrfToken ? csrfToken.substring(0,20)+'...' : 'NO ENCONTRADO'));

    // 4. Interceptar las respuestas para capturar datos
    const interceptedData = [];
    page.on('response', async function(response) {
      const url = response.url();
      if (url.includes('/Document/') && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('html') || ct.includes('json')) {
            const body = await response.text();
            if (body.length > 100) {
              interceptedData.push({ url: url, body: body.substring(0, 2000) });
            }
          }
        } catch(e) {}
      }
    });

    // 5. Navegar con fechas en la URL (enfoque GET)
    // El portal DIAN acepta parametros en la URL para filtrar
    const fechaInicioFmt = fechaInicio; // yyyy-mm-dd
    const fechaFinFmt = fechaFin;

    // Intentar con query params
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/Document/Received?startDate=' + fechaInicioFmt + '&endDate=' + fechaFinFmt,
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await page.waitForTimeout(2000);

    // 6. Intentar hacer submit del formulario de busqueda via JavaScript
    const formData = await page.evaluate(function(fi, ff, g) {
      // Obtener todos los campos del formulario
      var forms = document.querySelectorAll('form');
      var data = { forms: forms.length, inputs: [] };
      forms.forEach(function(form) {
        var inputs = form.querySelectorAll('input, select');
        inputs.forEach(function(inp) {
          data.inputs.push({ name: inp.name, id: inp.id, type: inp.type, value: inp.value });
        });
      });
      // Intentar setear las fechas encontradas
      var dateInputs = document.querySelectorAll('input[type="text"], input[type="date"]');
      dateInputs.forEach(function(inp, idx) {
        if (idx === 0) inp.value = fi;
        if (idx === 1) inp.value = ff;
      });
      return data;
    }, fechaInicioFmt, fechaFinFmt, grupo || '');
    console.log('[DIAN] Formulario:', JSON.stringify(formData).substring(0, 500));

    // 7. Capturar los documentos de la tabla actual (sin importar el filtro de fechas)
    await page.waitForTimeout(2000);
    const tableData = await page.evaluate(function() {
      var resultado = {
        titulo: document.title,
        url: window.location.href,
        filas: [],
        links: [],
        html_muestra: document.body.innerHTML.substring(0, 3000),
      };
      // Extraer filas de cualquier tabla
      document.querySelectorAll('table tbody tr, .table-responsive tr, [class*="row"] tr').forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td, th')).map(function(td) { return td.textContent.trim(); });
        var links = Array.from(tr.querySelectorAll('a[href]')).map(function(a) { return { href: a.href, text: a.textContent.trim() }; });
        if (cells.length > 1) resultado.filas.push({ cells: cells, links: links });
      });
      // Todos los links de descarga
      document.querySelectorAll('a[href*="Download"], a[href*="download"], a[href*="zip"], a[href*="ZIP"], a[href*="documento"]').forEach(function(a) {
        resultado.links.push({ href: a.href, text: a.textContent.trim() });
      });
      return resultado;
    });

    console.log('[DIAN] Titulo: ' + tableData.titulo);
    console.log('[DIAN] Filas encontradas: ' + tableData.filas.length);
    console.log('[DIAN] Links descarga: ' + tableData.links.length);
    console.log('[DIAN] HTML muestra: ' + tableData.html_muestra.substring(0, 500));

    const documentos = [];

    // 8. Intentar descargar los documentos encontrados
    for (var i = 0; i < tableData.filas.length; i++) {
      var fila = tableData.filas[i];
      var linkZip = fila.links.find(function(l) {
        return l.href && (l.href.includes('zip') || l.href.includes('ZIP') ||
               l.href.includes('Download') || l.href.includes('download') ||
               l.href.includes('documento'));
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
        console.log('  OK ' + folio);
      } catch(err) {
        console.error('  ERR descarga:', err.message);
      }
    }

    // Retornar incluyendo debug info para afinar selectores
    return {
      documentos,
      nit,
      total: documentos.length,
      debug: {
        interceptedData: interceptedData.slice(0, 3),
        tableHtml: tableData.html_muestra,
        filas: tableData.filas.length,
        links: tableData.links.length,
        formData: formData,
      }
    };

  } finally {
    await browser.close();
  }
}

/**
 * diagnosticarPortal - autentica y retorna info completa de la pagina
 * para entender su estructura exacta
 */
async function diagnosticarPortal(tokenUrl) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    const urlPostAuth = page.url();

    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'networkidle', timeout: 30000 });

    const info = await page.evaluate(function() {
      return {
        url: window.location.href,
        titulo: document.title,
        html: document.documentElement.outerHTML.substring(0, 8000),
        inputs: Array.from(document.querySelectorAll('input,select,textarea')).map(function(el) {
          return { tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, value: el.value, cls: el.className.substring(0,80) };
        }),
        botones: Array.from(document.querySelectorAll('button,input[type=submit],[type=button]')).map(function(el) {
          return { tag: el.tagName, id: el.id, type: el.type, text: el.textContent.trim().substring(0,60), cls: el.className.substring(0,80) };
        }),
        forms: Array.from(document.querySelectorAll('form')).map(function(f) {
          return { action: f.action, method: f.method, id: f.id };
        }),
      };
    });

    return { ok: true, nit, urlPostAuth, ...info };
  } finally {
    await browser.close();
  }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
