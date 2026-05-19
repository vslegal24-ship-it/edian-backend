const xml2js = require('xml2js');

const NS_MAP = {
  'cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  'cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  'sts': 'dian:gov:co:facturaelectronica:Structures-2-1',
};

/**
 * parseXmlDIAN - parsea un XML UBL 2.1 de factura electrónica colombiana
 * Retorna objeto estructurado con cabecera + items[]
 */
async function parseXmlDIAN(xmlText) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    ignoreAttrs: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
    attrNameProcessors: [xml2js.processors.stripPrefix],
  });

  const doc = await parser.parseStringPromise(xmlText);

  // Root puede ser Invoice, CreditNote, DebitNote
  const root = doc.Invoice || doc.CreditNote || doc.DebitNote;
  if (!root) throw new Error('Formato XML no reconocido');

  const isCredit = !!doc.CreditNote;
  const isDebit  = !!doc.DebitNote;

  // ── Helpers ───────────────────────────────────────────────
  const get = (obj, ...keys) => {
    let cur = obj;
    for (const k of keys) {
      if (!cur) return '';
      cur = cur[k];
    }
    if (typeof cur === 'object' && cur !== null) return cur._ || cur['#text'] || '';
    return cur ?? '';
  };

  const getNum = (obj, ...keys) => parseFloat(get(obj, ...keys)) || 0;

  // ── Cabecera ──────────────────────────────────────────────
  const cufe    = get(root, 'UUID') || get(root, 'ID');
  const numero  = get(root, 'ID');
  const fecha   = get(root, 'IssueDate');
  const hora    = get(root, 'IssueTime');
  const moneda  = get(root, 'DocumentCurrencyCode') || 'COP';
  const tipoC   = get(root, 'InvoiceTypeCode') || (isCredit ? '91' : isDebit ? '92' : '01');

  const TIPOS = { '01':'Factura electrónica', '91':'Nota de crédito electrónica', '92':'Nota de débito electrónica', '03':'Factura contingencia' };
  const tipo  = isCredit ? 'Nota de crédito electrónica' : isDebit ? 'Nota de débito electrónica' : (TIPOS[tipoC] || 'Factura electrónica');

  // Prefijo desde autorización DIAN
  const prefijo = (() => {
    try { return get(root, 'UBLExtensions', 'UBLExtension', 'ExtensionContent', 'DianExtensions', 'InvoiceControl', 'AuthorizedInvoices', 'Prefix'); } catch { return ''; }
  })();

  // ── Emisor ────────────────────────────────────────────────
  const sup = root.AccountingSupplierParty?.Party || {};
  const emisor = {
    nit:    get(sup, 'PartyTaxScheme', 'CompanyID') || get(sup, 'PartyIdentification', 'ID'),
    nombre: get(sup, 'PartyTaxScheme', 'RegistrationName') || get(sup, 'PartyName', 'Name'),
    dir:    get(sup, 'PhysicalLocation', 'Address', 'AddressLine', 'Line'),
    ciudad: get(sup, 'PhysicalLocation', 'Address', 'CityName'),
    depto:  get(sup, 'PhysicalLocation', 'Address', 'CountrySubentity'),
    tel:    get(sup, 'Contact', 'Telephone'),
    email:  get(sup, 'Contact', 'ElectronicMail'),
    regimen: get(sup, 'PartyTaxScheme', 'TaxLevelCode'),
    actEco: get(sup, 'IndustryClassificationCode'),
  };

  // ── Receptor ──────────────────────────────────────────────
  const cus = root.AccountingCustomerParty?.Party || {};
  const receptor = {
    nit:    get(cus, 'PartyTaxScheme', 'CompanyID') || get(cus, 'PartyIdentification', 'ID'),
    nombre: get(cus, 'PartyTaxScheme', 'RegistrationName') || get(cus, 'PartyName', 'Name'),
    dir:    get(cus, 'PhysicalLocation', 'Address', 'AddressLine', 'Line'),
    ciudad: get(cus, 'PhysicalLocation', 'Address', 'CityName'),
    depto:  get(cus, 'PhysicalLocation', 'Address', 'CountrySubentity'),
    tel:    get(cus, 'Contact', 'Telephone'),
    email:  get(cus, 'Contact', 'ElectronicMail'),
  };

  // ── Totales ───────────────────────────────────────────────
  const totEl = root.LegalMonetaryTotal || {};
  const subtotal = getNum(totEl, 'LineExtensionAmount');
  const total    = getNum(totEl, 'PayableAmount');

  // Impuestos cabecera
  let iva = 0, ivaPct = 0, inc = 0, incPct = 0, ica = 0;
  const ttArr = Array.isArray(root.TaxTotal) ? root.TaxTotal : root.TaxTotal ? [root.TaxTotal] : [];
  for (const tt of ttArr) {
    const tsArr = Array.isArray(tt.TaxSubtotal) ? tt.TaxSubtotal : tt.TaxSubtotal ? [tt.TaxSubtotal] : [];
    for (const ts of tsArr) {
      const tid  = get(ts, 'TaxCategory', 'TaxScheme', 'ID');
      const tnm  = get(ts, 'TaxCategory', 'TaxScheme', 'Name').toUpperCase();
      const amt  = getNum(ts, 'TaxAmount');
      const pct  = getNum(ts, 'TaxCategory', 'Percent');
      if (tid === '01' || tnm.includes('IVA')) { iva += amt; ivaPct = pct; }
      else if (tid === '04' || tnm.includes('INC')) { inc += amt; incPct = pct; }
      else if (tid === '03' || tnm.includes('ICA')) { ica += amt; }
    }
  }

  // ── Ítems ─────────────────────────────────────────────────
  const lineKey = isCredit ? 'CreditNoteLine' : isDebit ? 'DebitNoteLine' : 'InvoiceLine';
  const linesRaw = root[lineKey];
  const linesArr = Array.isArray(linesRaw) ? linesRaw : linesRaw ? [linesRaw] : [];

  const items = linesArr.map(line => {
    const qtyEl = line.InvoicedQuantity || line.CreditedQuantity || line.DebitedQuantity || {};
    const qty   = parseFloat(typeof qtyEl === 'object' ? qtyEl._ || qtyEl['#text'] || '0' : qtyEl) || 0;
    const um    = typeof qtyEl === 'object' ? qtyEl.$ && (qtyEl.$.unitCode || '') : '';
    const subt  = getNum(line, 'LineExtensionAmount');
    const desc  = get(line, 'Item', 'Description');
    const codigo = get(line, 'Item', 'SellersItemIdentification', 'ID');
    const punit = getNum(line, 'Price', 'PriceAmount');
    const id    = get(line, 'ID');
    const nota  = get(line, 'Note');

    // Impuestos por línea
    let lIva = 0, lIvaPct = 0, lIvaBase = 0, lInc = 0, lIncPct = 0, lIca = 0, lOtros = 0;
    const lttArr = Array.isArray(line.TaxTotal) ? line.TaxTotal : line.TaxTotal ? [line.TaxTotal] : [];
    for (const tt of lttArr) {
      const tsArr = Array.isArray(tt.TaxSubtotal) ? tt.TaxSubtotal : tt.TaxSubtotal ? [tt.TaxSubtotal] : [];
      for (const ts of tsArr) {
        const tid2 = get(ts, 'TaxCategory', 'TaxScheme', 'ID');
        const tnm2 = get(ts, 'TaxCategory', 'TaxScheme', 'Name').toUpperCase();
        const amt2 = getNum(ts, 'TaxAmount');
        const pct2 = getNum(ts, 'TaxCategory', 'Percent');
        const base2 = getNum(ts, 'TaxableAmount');
        if (tid2 === '01' || tnm2.includes('IVA')) { lIva += amt2; lIvaPct = pct2; lIvaBase = base2; }
        else if (tid2 === '04' || tnm2.includes('INC')) { lInc += amt2; lIncPct = pct2; }
        else if (tid2 === '03' || tnm2.includes('ICA')) { lIca += amt2; }
        else { lOtros += amt2; }
      }
    }

    return {
      id, codigo, descripcion: desc, nota, qty, um,
      precioUnit: punit, subtotal: subt,
      baseIva: lIvaBase, ivaPct: lIvaPct, iva: lIva,
      incPct: lIncPct, inc: lInc,
      ica: lIca, otros: lOtros,
      totalLinea: subt + lIva + lInc + lIca + lOtros,
    };
  });

  const cufeUrl = cufe
    ? `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${cufe}`
    : '';

  return {
    cufe, cufeUrl,
    numero, prefijo,
    folio: prefijo ? `${prefijo}-${numero}` : numero,
    fecha, hora, tipo, tipoC, moneda,
    emisor, receptor,
    subtotal, iva, ivaPct, inc, incPct, ica,
    totalImpuestos: iva + inc + ica,
    total,
    items,
  };
}

/**
 * procesarLote - procesa array de xmlTexts y devuelve
 * array plano de filas (1 fila por ítem) para el Excel
 */
async function procesarLote(xmlTexts) {
  const facturas = [];
  const errores  = [];

  for (const { xmlText, nombre } of xmlTexts) {
    if (!xmlText || xmlText.trim().length < 100) {
      console.log('[Parser] Sin XML: ' + nombre);
      continue;
    }
    try {
      const fac = await parseXmlDIAN(xmlText);
      facturas.push(fac);
    } catch (err) {
      errores.push({ nombre, error: err.message });
      console.error('[Parser] Error en ' + nombre + ':', err.message);
    }
  }

  // Aplanar a 1 fila por ítem
  const filas = [];
  for (const fac of facturas) {
    for (const item of fac.items) {
      filas.push({
        folio: fac.folio, fecha: fac.fecha, tipo: fac.tipo,
        nitEmisor: fac.emisor.nit, nomEmisor: fac.emisor.nombre,
        nitReceptor: fac.receptor.nit, nomReceptor: fac.receptor.nombre,
        item: item.id, codigo: item.codigo, descripcion: item.descripcion,
        qty: item.qty, um: item.um, precioUnit: item.precioUnit,
        subtotal: item.subtotal, baseIva: item.baseIva,
        ivaPct: item.ivaPct, iva: item.iva,
        incPct: item.incPct, inc: item.inc,
        ica: item.ica, otros: item.otros, totalLinea: item.totalLinea,
        totalFac: fac.total,
        cufe: fac.cufe, cufeUrl: fac.cufeUrl,
      });
    }
  }

  return { facturas, filas, errores };
}

module.exports = { parseXmlDIAN, procesarLote };
