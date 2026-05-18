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

async function autenticar(tokenUrl) {
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
  console.log('[DIAN] Autenticando NIT ' + nit);
  await page.goto(
    'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
    { waitUntil: 'networkidle', timeout: 40000 }
  );
  const currentUrl = page.url();
  console.log('[DIAN] URL tras auth: ' + currentUrl);
  if (currentUrl.includes('Login') || currentUrl.includes('login')) {
    await browser.close();
    throw new Error('Token invalido o expirado');
  }
  return { browser, context, page, nit };
}

async function diagnosticarPortal(tokenUrl) {
  const { browser, page, nit } = await autenticar(tokenUrl);
  try {
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/Document/DownloadListByDate',
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    const info = await page.evaluate(function() {
      return {
        url: window.location.href,
        titulo: document.title,
        inputs: Array.from(document.querySelectorAll('input,select')).map(function(el) {
          return { tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder };
        }),
        botones: Array.from(document.querySelectorAll('button,input[type=submit]')).map(function(el) {
          return { tag: el.tagName, id: el.id, text: el.textContent.trim().substring(0,50), cls: el.className.substring(0,60) };
        }),
        html: document.body.innerHTML.substring(0, 5000),
      };
    });
    return { ok: true, nit: nit, info: info };
  } finally {
    await browser.close();
  }
}

async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo }) {
  const { browser, context, page, nit } = await autenticar(tokenUrl);
  const documentos = [];
  try {
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/Document/DownloadListByDate',
      { waitUntil: 'networkidle', timeout: 30000 }
    );

    // Intentar llenar fechas con multiples selectores
    const selectoresFecha = ['#fechaInicio','input[name="fechaInicio"]','input[type="date"]:first-of-type','input[placeholder*="nicio"]'];
    const selectoresFechaFin = ['#fechaFin','input[name="fechaFin"]','input[type="date"]:last-of-type','input[placeholder*="in"]'];
    for (const sel of selectoresFecha) {
      try { await page.fill(sel, fechaInicio, { timeout: 4000 }); console.log('[OK] fecha inicio con ' + sel); break; } catch(e) {}
    }
    for (const sel of selectoresFechaFin) {
      try { await page.fill(sel, fechaFin, { timeout: 4000 }); console.log('[OK] fecha fin con ' + sel); break; } catch(e) {}
    }
    if (grupo) {
      for (const sel of ['select','#grupo','select[name="grupo"]']) {
        try { await page.selectOption(sel, grupo, { timeout: 3000 }); break; } catch(e) {}
      }
    }
    for (const sel of ['button[type="submit"]','#btnConsultar','button:has-text("Consultar")','button:has-text("Buscar")']) {
      try { await page.click(sel, { timeout: 4000 }); await page.waitForLoadState('networkidle', { timeout: 20000 }); console.log('[OK] click con ' + sel); break; } catch(e) {}
    }
    await page.waitForTimeout(2000);

    // Extraer filas de la tabla
    const filas = await page.evaluate(function() {
      var rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(function(row) {
        var cells = Array.from(row.querySelectorAll('td'));
        var links = Array.from(row.querySelectorAll('a'));
        return {
          cells: cells.map(function(c) { return c.textContent.trim(); }),
          links: links.map(function(a) { return a.href; }),
        };
      }).filter(function(r) { return r.cells.length > 2; });
    });
    console.log('[DIAN] Filas en tabla: ' + filas.length);

    for (const fila of filas) {
      const linkZip = fila.links.find(function(l) { return l.includes('zip') || l.includes('Zip') || l.includes('ZIP') || l.includes('Download') || l.includes('download'); });
      if (!linkZip) continue;
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          page.goto(linkZip),
        ]);
        const pathDl = await download.path();
        const buffer = fs.readFileSync(pathDl);
        const zip = await JSZip.loadAsync(buffer);
        let pdfBuffer = null, xmlBuffer = null, xmlText = '';
        for (const entry of Object.entries(zip.files)) {
          const fname = entry[0]; const file = entry[1];
          if (fname.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
          if (fname.toLowerCase().endsWith('.xml')) { xmlBuffer = await file.async('nodebuffer'); xmlText = await file.async('text'); }
        }
        const folio = fila.cells[2] || fila.cells[1] || 'doc';
        documentos.push({ cufe: fila.cells[1]||'', folio, tipo: fila.cells[0]||'', fecha: fila.cells[7]||fila.cells[3]||'', pdfBuffer, xmlBuffer, xmlText, nombre: folio });
        console.log('  OK ' + folio);
      } catch(err) { console.error('  ERR ' + err.message); }
    }
    return { documentos, nit, total: documentos.length };
  } finally {
    await browser.close();
  }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
