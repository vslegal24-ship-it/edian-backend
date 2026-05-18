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
    console.log('[DIAN] Pagina cargada');

    // 3. Inyectar fechas y hacer clic en Buscar
    const startDate = toFechaDIAN(fechaInicio);
    const endDate   = toFechaDIAN(fechaFin);
    console.log('[DIAN] Fechas: ' + startDate + ' -> ' + endDate);

    await page.evaluate(function(p) {
      var s = document.getElementById('startDate');
      var e = document.getElementById('endDate');
      var r = document.getElementById('dashboard-report-range');
      if (s) s.value = p.start;
      if (e) e.value = p.end;
      if (r) r.value = p.startISO + ' - ' + p.endISO;
    }, { start: startDate, end: endDate, startISO: fechaInicio, endISO: fechaFin });

    await page.evaluate(function() {
      var btns = Array.from(document.querySelectorAll('button, input[type=submit]'));
      var b = btns.find(function(x) {
        return (x.textContent + (x.value||'')).toLowerCase().includes('buscar');
      });
      if (b) b.click();
      else { var f = document.querySelector('form'); if (f) f.submit(); }
    });

    await page.waitForTimeout(5000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function(){});

    // 4. Extraer filas con el data-id del boton de descarga
    const filas = await page.evaluate(function() {
      var resultado = [];
      var rows = document.querySelectorAll('table tbody tr, tbody tr');
      rows.forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) {
          return td.textContent.trim().replace(/\s+/g, ' ');
        });
        // Buscar el boton con data-id (CUFE)
        var btn = tr.querySelector('button.download-document, button[data-id]');
        var cufe = btn ? (btn.getAttribute('data-id') || btn.id || '') : '';

        if (cells.length > 2 && cufe) {
          resultado.push({ cells: cells, cufe: cufe });
        }
      });
      return resultado;
    });

    console.log('[DIAN] Documentos con CUFE: ' + filas.length);

    // 5. Descargar cada documento usando el endpoint de descarga de la DIAN
    // El boton download-document usa el CUFE para descargar via POST o GET
    const documentos = [];

    for (var i = 0; i < filas.length; i++) {
      var fila = filas[i];
      var cufe = fila.cufe;
      var cells = fila.cells;

      // Extraer datos de las celdas
      // Estructura: [boton, fecha_recep, fecha_emis, prefijo, folio, tipo, nit_emisor, nom_emisor, nit_receptor, nom_receptor, total, estado, grupo, acciones]
      var fecha   = cells[2] || cells[1] || '';
      var prefijo = cells[3] || '';
      var folio   = cells[4] || '';
      var tipo    = cells[5] || 'Factura electronica';
      var nitEmi  = cells[6] || '';
      var nomEmi  = cells[7] || '';
      var nitRec  = cells[8] || nit;
      var nomRec  = cells[9] || '';
      var nombre  = (prefijo ? prefijo + '-' : '') + folio;

      console.log('[DIAN] Descargando: ' + nombre + ' (' + cufe.substring(0,16) + '...)');

      try {
        // Hacer clic en el boton de descarga via JavaScript
        var dl = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          page.evaluate(function(cuf) {
            var btn = document.getElementById(cuf) ||
                      document.querySelector('button[data-id="'+cuf+'"]');
            if (btn) { btn.click(); return true; }
            return false;
          }, cufe),
        ]);

        var pathDl = await dl[0].path();
        var buffer = fs.readFileSync(pathDl);
        var suggestedName = dl[0].suggestedFilename();
        console.log('[DIAN] Archivo: ' + suggestedName + ' (' + buffer.length + ' bytes)');

        var pdfBuffer = null, xmlBuffer = null, xmlText = '';

        // Intentar leer como ZIP
        try {
          var zip = await JSZip.loadAsync(buffer);
          for (var entry of Object.entries(zip.files)) {
            var fname = entry[0]; var file = entry[1];
            if (fname.toLowerCase().endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
            if (fname.toLowerCase().endsWith('.xml')) {
              xmlBuffer = await file.async('nodebuffer');
              xmlText = await file.async('text');
            }
          }
        } catch(zipErr) {
          // Si no es ZIP, puede ser directamente XML o PDF
          var ext = (suggestedName || '').toLowerCase();
          if (ext.endsWith('.xml')) { xmlBuffer = buffer; xmlText = buffer.toString('utf8'); }
          if (ext.endsWith('.pdf')) pdfBuffer = buffer;
        }

        documentos.push({ cufe, cufeUrl: 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey='+cufe, folio: nombre, nombre, tipo, fecha, nitEmisor: nitEmi, nomEmisor: nomEmi, nitReceptor: nitRec, nomReceptor: nomRec, pdfBuffer, xmlBuffer, xmlText });
        console.log('  [OK] ' + nombre);

      } catch(err) {
        console.error('  [ERR] ' + nombre + ':', err.message);
      }
    }

    console.log('[DIAN] Total descargados: ' + documentos.length + ' de ' + filas.length);
    return { documentos, nit, total: documentos.length, filasEncontradas: filas.length };

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
      return {
        url: window.location.href, titulo: document.title,
        inputs: Array.from(document.querySelectorAll('input,select')).map(function(el) {
          return { id: el.id, name: el.name, type: el.type, value: el.value.substring(0,80) };
        }),
        html: document.body.innerHTML.substring(0, 5000),
      };
    });
    return { ok: true, nit, ...info };
  } finally { await browser.close(); }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
