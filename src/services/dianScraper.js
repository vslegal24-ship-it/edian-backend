const { chromium } = require('playwright');
const JSZip = require('jszip');

/**
 * parseTokenUrl - extrae NIT (rk) y token UUID del enlace del correo DIAN
 */
function parseTokenUrl(url) {
  try {
    const u = new URL(url.trim());
    const rk    = u.searchParams.get('rk');    // NIT receptor
    const token = u.searchParams.get('token'); // UUID del token
    const pk    = u.searchParams.get('pk');    // pk = idInterno|NIT
    if (!rk || !token) throw new Error('URL inválida: faltan parámetros rk o token');
    return { nit: rk, token, pk: pk || '' };
  } catch (e) {
    throw new Error('URL del token inválida: ' + e.message);
  }
}

/**
 * descargarDIAN - usa Playwright para autenticarse y descargar
 * los documentos del rango de fechas indicado.
 *
 * Retorna array de { nombre, pdfBuffer, xmlBuffer, xmlText }
 */
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo = '' }) {
  const { nit, token } = parseTokenUrl(tokenUrl);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });

  const page = await context.newPage();
  const documentos = [];

  try {
    console.log(`[DIAN] Autenticando NIT ${nit} con token ${token.substring(0,8)}...`);

    // 1. Ir al portal con el token de autenticación
    await page.goto(
      `https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=${nit}&rk=${nit}&token=${token}`,
      { waitUntil: 'networkidle', timeout: 30000 }
    );

    // 2. Verificar que la autenticación fue exitosa
    const url = page.url();
    if (url.includes('Login') || url.includes('Error')) {
      throw new Error('Token inválido o expirado. Solicita un nuevo token en el portal de la DIAN.');
    }

    console.log(`[DIAN] Sesión iniciada. Navegando a historial...`);

    // 3. Ir a la página de descarga de listados
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/Document/DownloadListByDate',
      { waitUntil: 'networkidle', timeout: 20000 }
    );

    // 4. Configurar rango de fechas
    await page.fill('#fechaInicio', fechaInicio);
    await page.fill('#fechaFin', fechaFin);

    // Filtrar por grupo si aplica
    if (grupo) {
      await page.selectOption('#grupo', grupo);
    }

    // 5. Hacer clic en "Consultar"
    await page.click('button[type="submit"], #btnConsultar, button:has-text("Consultar")');
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // 6. Obtener la lista de documentos de la tabla
    const filas = await page.$$eval('table tbody tr', rows =>
      rows.map(row => {
        const celdas = Array.from(row.querySelectorAll('td'));
        return {
          cufe:    celdas[1]?.textContent?.trim() || '',
          folio:   celdas[2]?.textContent?.trim() || '',
          tipo:    celdas[0]?.textContent?.trim() || '',
          fecha:   celdas[7]?.textContent?.trim() || '',
          total:   celdas[29]?.textContent?.trim() || '',
          // El link de descarga del ZIP
          linkZip: celdas[celdas.length - 1]?.querySelector('a')?.href || '',
        };
      }).filter(r => r.cufe)
    );

    console.log(`[DIAN] Encontrados ${filas.length} documentos`);

    // 7. Descargar cada documento (ZIP con PDF + XML)
    for (const fila of filas) {
      try {
        if (!fila.linkZip) continue;

        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.goto(fila.linkZip),
        ]);

        const buffer = await download.createReadStream().then(stream =>
          new Promise((res, rej) => {
            const chunks = [];
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => res(Buffer.concat(chunks)));
            stream.on('error', rej);
          })
        );

        // Extraer PDF y XML del ZIP
        const zip = await JSZip.loadAsync(buffer);
        let pdfBuffer = null, xmlBuffer = null, xmlText = '';

        for (const [fname, file] of Object.entries(zip.files)) {
          if (fname.endsWith('.pdf')) pdfBuffer = await file.async('nodebuffer');
          if (fname.endsWith('.xml')) {
            xmlBuffer = await file.async('nodebuffer');
            xmlText   = await file.async('text');
          }
        }

        documentos.push({
          cufe:      fila.cufe,
          folio:     fila.folio,
          tipo:      fila.tipo,
          fecha:     fila.fecha,
          pdfBuffer,
          xmlBuffer,
          xmlText,
          nombre:    `${fila.fecha.replace(/\//g,'-')}_${fila.folio}`,
        });

        console.log(`  ✓ ${fila.folio} descargado`);
      } catch (err) {
        console.error(`  ✗ Error descargando ${fila.folio}:`, err.message);
      }
    }

    console.log(`[DIAN] Descarga completa: ${documentos.length} documentos`);
    return { documentos, nit, total: documentos.length };

  } finally {
    await browser.close();
  }
}

/**
 * exportarExcelDIAN - descarga el Excel del listado tal como lo exporta la DIAN
 */
async function exportarExcelDIAN({ tokenUrl, fechaInicio, fechaFin, grupo = '' }) {
  const { nit, token } = parseTokenUrl(tokenUrl);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(`https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=${nit}&rk=${nit}&token=${token}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.goto('https://catalogo-vpfe.dian.gov.co/Document/DownloadListByDate', { waitUntil: 'networkidle', timeout: 20000 });
    await page.fill('#fechaInicio', fechaInicio);
    await page.fill('#fechaFin', fechaFin);
    if (grupo) await page.selectOption('#grupo', grupo);
    await page.click('button[type="submit"], #btnConsultar');
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btnExportarExcel, button:has-text("Exportar Excel")'),
    ]);

    const buffer = await download.createReadStream().then(stream =>
      new Promise((res, rej) => {
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => res(Buffer.concat(chunks)));
        stream.on('error', rej);
      })
    );

    return buffer;
  } finally {
    await browser.close();
  }
}

module.exports = { descargarDIAN, exportarExcelDIAN, parseTokenUrl };
