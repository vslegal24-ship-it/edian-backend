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

/**
 * Solo autentica y retorna cookies + HTML de la pagina de documentos.
 * Sin ningun page.fill ni interaccion con formularios.
 */
async function autenticarYObtenerInfo(tokenUrl, pagina) {
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
    // 1. Autenticar con el token
    console.log('[DIAN] Autenticando NIT ' + nit);
    await page.goto(
      'https://catalogo-vpfe.dian.gov.co/User/AuthToken?pk=' + pk + '&rk=' + nit + '&token=' + token,
      { waitUntil: 'networkidle', timeout: 40000 }
    );
    const urlActual = page.url();
    console.log('[DIAN] URL post-auth: ' + urlActual);
    if (urlActual.includes('Login') || urlActual.includes('login') || urlActual.includes('Error')) {
      throw new Error('Token invalido o expirado. Solicita un nuevo token en la DIAN.');
    }

    // 2. Navegar a la pagina solicitada SIN interactuar con nada
    const destino = pagina || 'https://catalogo-vpfe.dian.gov.co/Document/Received';
    await page.goto(destino, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('[DIAN] Pagina cargada: ' + page.url());

    // 3. Obtener cookies actuales
    const cookies = await context.cookies();
    const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

    // 4. Obtener el token CSRF del HTML
    const csrf = await page.evaluate(function() {
      var inp = document.querySelector('input[name="__RequestVerificationToken"]');
      if (inp) return inp.value;
      var meta = document.querySelector('meta[name="RequestVerificationToken"]');
      if (meta) return meta.getAttribute('content');
      var html = document.documentElement.innerHTML;
      var m = html.match(/__RequestVerificationToken[^>]*value="([^"]{20,})"/);
      if (m) return m[1];
      return '';
    });
    console.log('[DIAN] CSRF: ' + (csrf ? csrf.substring(0, 15) + '...' : 'NO ENCONTRADO'));

    // 5. Capturar HTML y estructura de la pagina para diagnostico
    const paginaInfo = await page.evaluate(function() {
      return {
        url: window.location.href,
        titulo: document.title,
        html: document.documentElement.outerHTML.substring(0, 10000),
        inputs: Array.from(document.querySelectorAll('input, select, textarea')).map(function(el) {
          return {
            tag: el.tagName,
            id: el.id,
            name: el.name,
            type: el.type || '',
            placeholder: el.placeholder || '',
            value: el.value ? el.value.substring(0, 50) : '',
            ngModel: el.getAttribute('ng-model') || el.getAttribute('[(ngModel)]') || '',
            cls: el.className.substring(0, 80),
          };
        }),
        botones: Array.from(document.querySelectorAll('button, input[type=submit]')).map(function(el) {
          return { id: el.id, text: el.textContent.trim().substring(0, 60), cls: el.className.substring(0, 80) };
        }),
        links: Array.from(document.querySelectorAll('a[href]')).map(function(a) {
          return { href: a.href, text: a.textContent.trim().substring(0, 40) };
        }).filter(function(l) { return l.href.includes('dian') || l.href.includes('Document'); }),
        tablaFilas: Array.from(document.querySelectorAll('table tr, tbody tr')).length,
      };
    });

    return { browser, page, context, cookies, cookieStr, csrf, nit, paginaInfo };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/**
 * diagnosticarPortal - retorna info completa de la pagina para entender su estructura.
 * Llama esto con tu token para ver exactamente que hay en la pagina.
 */
async function diagnosticarPortal(tokenUrl) {
  const result = await autenticarYObtenerInfo(tokenUrl, 'https://catalogo-vpfe.dian.gov.co/Document/Received');
  await result.browser.close();
  return {
    ok: true,
    nit: result.nit,
    csrf: result.csrf ? result.csrf.substring(0, 20) + '...' : 'NO',
    cookies: result.cookies.length,
    pagina: result.paginaInfo,
  };
}

/**
 * descargarDIAN - autentica, usa fetch() dentro del browser para llamar
 * directamente a los endpoints de la DIAN con las cookies activas.
 * Sin page.fill, sin page.click, sin selectores de UI.
 */
async function descargarDIAN({ tokenUrl, fechaInicio, fechaFin, grupo, empresa }) {
  const result = await autenticarYObtenerInfo(
    tokenUrl,
    'https://catalogo-vpfe.dian.gov.co/Document/Received'
  );
  const { browser, page, context, cookieStr, csrf, nit, paginaInfo } = result;
  const documentos = [];

  try {
    console.log('[DIAN] Pagina info - inputs:', paginaInfo.inputs.length, '| botones:', paginaInfo.botones.length);
    console.log('[DIAN] Primeros inputs:', JSON.stringify(paginaInfo.inputs.slice(0, 8)));

    // Intentar hacer la busqueda usando fetch desde dentro del browser
    // (ya tiene las cookies de sesion activas automaticamente)
    const respuestaBusqueda = await page.evaluate(async function(params) {
      var csrf = params.csrf;
      var fi = params.fechaInicio;
      var ff = params.fechaFin;
      var grupo = params.grupo;

      // Intentar varios formatos de body para la DIAN
      var bodies = [
        // Formato 1: nombres en español
        '__RequestVerificationToken=' + encodeURIComponent(csrf) +
        '&fechaInicio=' + encodeURIComponent(fi) +
        '&fechaFin=' + encodeURIComponent(ff) +
        '&grupo=' + encodeURIComponent(grupo),
        // Formato 2: nombres en inglés
        '__RequestVerificationToken=' + encodeURIComponent(csrf) +
        '&startDate=' + encodeURIComponent(fi) +
        '&endDate=' + encodeURIComponent(ff),
        // Formato 3: formato DIAN yyyy/mm/dd
        '__RequestVerificationToken=' + encodeURIComponent(csrf) +
        '&fechaInicio=' + encodeURIComponent(fi.replace(/-/g, '/')) +
        '&fechaFin=' + encodeURIComponent(ff.replace(/-/g, '/')),
      ];

      var resultados = [];
      for (var i = 0; i < bodies.length; i++) {
        try {
          var resp = await fetch('/Document/Received', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: bodies[i],
            credentials: 'include',
          });
          var text = await resp.text();
          resultados.push({
            formato: i + 1,
            status: resp.status,
            longitud: text.length,
            muestra: text.substring(0, 500),
          });
          if (resp.ok && text.length > 500) break;
        } catch (e) {
          resultados.push({ formato: i + 1, error: e.message });
        }
      }
      return resultados;
    }, { csrf, fechaInicio, fechaFin, grupo: grupo || '' });

    console.log('[DIAN] Respuestas busqueda:', JSON.stringify(respuestaBusqueda));

    // Intentar endpoint AJAX GetDocumentsPageToken
    const respuestaAjax = await page.evaluate(async function(params) {
      var csrf = params.csrf;
      var fi = params.fechaInicio;
      var ff = params.fechaFin;
      try {
        var resp = await fetch('/Document/GetDocumentsPageToken', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: '__RequestVerificationToken=' + encodeURIComponent(csrf) +
                '&fechaInicio=' + encodeURIComponent(fi) +
                '&fechaFin=' + encodeURIComponent(ff) +
                '&page=1&pageSize=100',
          credentials: 'include',
        });
        var text = await resp.text();
        return { status: resp.status, longitud: text.length, body: text.substring(0, 2000) };
      } catch (e) {
        return { error: e.message };
      }
    }, { csrf, fechaInicio, fechaFin });

    console.log('[DIAN] Respuesta AJAX:', JSON.stringify(respuestaAjax));

    // Extraer documentos del HTML actual de la pagina
    const tablaDocumentos = await page.evaluate(function() {
      var filas = [];
      var rows = document.querySelectorAll('table tbody tr, .results tr, [class*="document"] tr');
      rows.forEach(function(tr) {
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td) { return td.textContent.trim(); });
        var links = Array.from(tr.querySelectorAll('a')).map(function(a) { return { href: a.href, text: a.textContent.trim() }; });
        if (cells.length > 1) filas.push({ cells: cells, links: links });
      });
      return { filas: filas, htmlMuestra: document.body.innerHTML.substring(0, 2000) };
    });

    console.log('[DIAN] Documentos en tabla: ' + tablaDocumentos.filas.length);

    return {
      documentos,
      nit,
      total: documentos.length,
      debug: {
        paginaInfo,
        respuestaBusqueda,
        respuestaAjax,
        tablaDocumentos: {
          filas: tablaDocumentos.filas.length,
          htmlMuestra: tablaDocumentos.htmlMuestra.substring(0, 1000),
        },
      }
    };
  } finally {
    await browser.close();
  }
}

module.exports = { descargarDIAN, diagnosticarPortal, parseTokenUrl };
