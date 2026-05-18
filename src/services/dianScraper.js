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

function toFechaDIAN(iso) {
  // 2026-05-01 → 5/1/2026 12:00:00 AM
  const [y, m, d] = iso.split('-');
  return parseInt(m) + '/' + parseInt(d) + '/' + y + ' 12:00:00 AM';
}

async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa }) {
  const { nit, token, pk } = parseTokenUrl(tokenUrl);

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
    // 1. Autenticar
    console.log('[DIAN] Autenticando NIT ' + nit);
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk='+pk+'&rk='+nit+'&token='+token,
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    if (page.url().includes('login') || page.url().includes('Login')) {
      throw new Error('Token invalido o expirado.');
    }

    // 2. Navegar a documentos recibidos
    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'networkidle', timeout: 30000 });
    console.log('[DIAN] Pagina cargada: ' + page.url());

    // 3. Inyectar las fechas directamente en los campos ocultos del formulario
    //    y disparar la busqueda via JavaScript (sin page.fill, sin interaccion UI)
    const startDate = toFechaDIAN(fechaInicio);
    const endDate   = toFechaDIAN(fechaFin);
    console.log('[DIAN] Fechas: ' + startDate + ' → ' + endDate);

    await page.evaluate(function(params) {
      // Setear los campos ocultos que usa el formulario DIAN
      var startEl = document.getElementById('startDate');
      var endEl   = document.getElementById('endDate');
      var rangeEl = document.getElementById('dashboard-report-range');

      if (startEl) startEl.value = params.start;
      if (endEl)   endEl.value   = params.end;
      if (rangeEl) rangeEl.value = params.startISO + ' - ' + params.endISO;

      console.log('Campos seteados:', startEl ? startEl.value : 'NO ENCONTRADO');
    }, {
      start: startDate,
      end: endDate,
      startISO: fechaInicio,
      endISO: fechaFin,
    });

    // 4. Hacer clic en el boton Buscar y esperar resultados AJAX
    console.log('[DIAN] Haciendo clic en Buscar...');
    await Promise.all([
      page.waitForResponse(function(resp) {
        return resp.url().includes('/Document/') && resp.status() === 200;
      }, { timeout: 20000 }).catch(function() { return null; }),
      page.evaluate(function() {
        // Buscar el boton de busqueda por texto o tipo
        var btns = Array.from(document.querySelectorAll('button, input[type=submit]'));
        var buscar = btns.find(function(b) {
          var t = (b.textContent || b.value || '').toLowerCase();
          return t.includes('buscar') || t.includes('search') || t.includes('consultar');
        });
        if (buscar) {
          buscar.click();
          return 'click en: ' + (buscar.textContent || buscar.value);
        }
        // Si no hay boton, submit del formulario
        var form = document.querySelector('form');
        if (form) { form.submit(); return 'form.submit()'; }
        return 'no encontrado';
      }),
    ]);

    // Esperar a que carguen los resultados
    await page.waitForTimeout(4000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function() {});

    // 5. Extraer todos los documentos de la tabla
    const resultado = await page.evaluate(function() {
      var filas = [];
      // Intentar con diferentes selectores de tabla
      var selectores = [
        'table#tbl-documents tbody tr',
        'table.table tbody tr',
        '.results-container tr',
        'table tbody tr',
        'tbody tr',
      ];
      var rows = [];
      for (var i = 0; i < selectores.length; i++) {
        rows = document.querySelectorAll(selectores[i]);
        if (rows.length > 0) {
          console.log('Tabla encontrada con: ' + selectores[i] + ' (' + rows.length + ' filas)');
          break;
        }
      }
      rows.forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
          return td.textContent.trim().replace(/\s+/g, ' ');
        });
        var links = Array.from(tr.querySelectorAll('a')).map(function(a) {
          return { href: a.href, text: a.textContent.trim(), title: a.getAttribute('title') || '' };
        });
        if (cells.length > 2) filas.push({ cells: cells, links: links });
      });

      // Capturar HTML para debug si no hay resultados
      var htmlDebug = '';
      if (filas.length === 0) {
        htmlDebug = document.body.innerHTML.substring(0, 3000);
      }

      return { filas: filas, htmlDebug: htmlDebug };
    });

    console.log('[DIAN] Filas encontradas: ' + resultado.filas.length);
    if (resultado.filas.length === 0) {
      console.log('[DIAN] HTML debug:', resultado.htmlDebug.substring(0, 800));
    }

    // 6. Descargar ZIP de cada documento
    const documentos = [];
    for (var i = 0; i < resultado.filas.length; i++) {
      var fila = resultado.filas[i];
      var linkZip = fila.links.find(function(l) {
        var h = (l.href || '').toLowerCase();
        return h.includes('download') || h.includes('zip') || h.includes('getfile') || h.includes('documento');
      });
      if (!linkZip) {
        console.log('[DIAN] Fila ' + i + ' sin link de descarga. Links:', JSON.stringify(fila.links));
        continue;
      }
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
        documentos.push({
          cufe: fila.cells[1]||'', folio, tipo: fila.cells[0]||'',
          fecha: fila.cells[7]||fila.cells[3]||'',
          pdfBuffer, xmlBuffer, xmlText, nombre: folio,
        });
        console.log('  [OK] ' + folio);
        // Volver a la pagina de resultados para continuar
        await page.goto('https://catalogo-vpfe.dian.gov.co/Document/Received', { waitUntil: 'networkidle', timeout: 20000 });
      } catch(err) {
        console.error('  [ERR] Fila ' + i + ':', err.message);
      }
    }

    console.log('[DIAN] Total descargados: ' + documentos.length);
    return { documentos, nit, total: documentos.length, filasEncontradas: resultado.filas.length };

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
          return { id: el.id, name: el.name, type: el.type, value: el.value.substring(0,80), placeholder: el.placeholder };
        }),
        botones: Array.from(document.querySelectorAll('button,input[type=submit]')).map(function(el) {
          return { id: el.id, text: (el.textContent||el.value||'').trim().substring(0,60), cls: el.className.substring(0,60) };
        }),
        html: document.body.innerHTML.substring(0, 6000),
      };
    });
    return { ok: true, nit, ...info };
  } finally {
    await browser.close();
  }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
