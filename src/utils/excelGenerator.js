const XLSX = require('xlsx');

// Calcula dígito de verificación NIT colombiano
function calcDV(nit) {
  var s = String(nit).replace(/[^0-9]/g,'');
  var p = [3,7,13,17,19,23,29,37,41,43,47,53,59,67,71];
  var sum = 0;
  for (var i=0;i<s.length;i++) sum += parseInt(s[s.length-1-i]) * p[i];
  var rem = sum % 11;
  return rem > 1 ? String(11-rem) : String(rem);
}

const TIPO_ID_NOMBRE = {
  '13':'Cédula ciudadanía (13)','22':'Cédula extranjería (22)',
  '31':'NIT (31)','11':'Registro civil (11)','12':'Tarjeta identidad (12)',
  '21':'Tarjeta extranjería (21)','41':'Pasaporte (41)',
  '42':'Doc. extranjero (42)','50':'NIT otro país (50)',
};

// ── Estilos comunes ────────────────────────────────────────
const S_HDR = {
  font: { bold: true, color: { rgb: 'FFFFFF' }, name: 'Arial', sz: 10 },
  fill: { fgColor: { rgb: '1E3A5F' }, patternType: 'solid' },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: {
    top:    { style: 'thin', color: { rgb: 'D0DBE8' } },
    bottom: { style: 'thin', color: { rgb: 'D0DBE8' } },
    left:   { style: 'thin', color: { rgb: 'D0DBE8' } },
    right:  { style: 'thin', color: { rgb: 'D0DBE8' } },
  },
};

const S_CELL = {
  font: { name: 'Arial', sz: 9 },
  alignment: { vertical: 'center' },
  border: {
    top:    { style: 'thin', color: { rgb: 'E2E8F0' } },
    bottom: { style: 'thin', color: { rgb: 'E2E8F0' } },
    left:   { style: 'thin', color: { rgb: 'E2E8F0' } },
    right:  { style: 'thin', color: { rgb: 'E2E8F0' } },
  },
};

const S_NUM = {
  ...S_CELL,
  alignment: { ...S_CELL.alignment, horizontal: 'right' },
  numFmt: '#,##0',
};

const S_PCT = {
  ...S_CELL,
  alignment: { ...S_CELL.alignment, horizontal: 'right' },
  numFmt: '0.00%',
};

function applyHeaderStyle(ws, rowIdx, numCols) {
  for (let c = 0; c < numCols; c++) {
    const ref = XLSX.utils.encode_cell({ r: rowIdx, c });
    if (ws[ref]) ws[ref].s = JSON.parse(JSON.stringify(S_HDR));
  }
}

function applyRowStyles(ws, rowIdx, numCols, numericCols, pctCols) {
  for (let c = 0; c < numCols; c++) {
    const ref = XLSX.utils.encode_cell({ r: rowIdx, c });
    if (!ws[ref]) continue;
    if (pctCols && pctCols.includes(c)) {
      ws[ref].s = JSON.parse(JSON.stringify(S_PCT));
    } else if (numericCols && numericCols.includes(c)) {
      ws[ref].s = JSON.parse(JSON.stringify(S_NUM));
    } else {
      ws[ref].s = JSON.parse(JSON.stringify(S_CELL));
    }
    // Filas alternas suave
    if (rowIdx % 2 === 0) {
      ws[ref].s.fill = { fgColor: { rgb: 'F8FAFF' }, patternType: 'solid' };
    }
  }
}

/**
 * generarExcelItems — 3 pestañas: Ítems, Terceros, Resumen
 */
function generarExcelItems(filas, facturas, { empresa = 'EDIAN', fechaIni, fechaFin }) {
  const wb = XLSX.utils.book_new();

  // ── Pestaña 1: Ítems por factura ─────────────────────────
  const H1 = [
    'Folio','Fecha','Tipo Documento',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'Ítem #','Código','Descripción','Cantidad','Unidad','Precio Unitario',
    'Subtotal Línea','Base IVA','% IVA','Valor IVA',
    '% INC','Valor INC','ICA','Otros Imp.',
    'Total Línea','Total Factura','CUFE','Ver Factura',
  ];
  const NUMS1 = [12,13,14,16,18,19,20,21,22]; // columnas numéricas (0-indexed)
  const PCTS1 = [15,17]; // columnas %

  const rows1 = filas.map(r => [
    r.folio||'', r.fecha||'', r.tipo||'',
    r.nitEmisor||r.nitEmi||'', r.nomEmisor||r.nomEmi||'',
    r.nitReceptor||r.nitRec||'', r.nomReceptor||r.nomRec||'',
    r.item||'', r.codigo||'', r.descripcion||r.desc||'',
    r.qty||'', r.um||'', r.precioUnit||r.punit||0,
    r.subtotal||r.subt||0, r.baseIva||0, (r.ivaPct||0)/100, r.iva||0,
    (r.incPct||0)/100, r.inc||0, r.ica||0, r.otros||0,
    r.totalLinea||0, r.totalFac||0,
    r.cufe||'', r.cufeUrl||'',
  ]);

  const ws1 = XLSX.utils.aoa_to_sheet([H1, ...rows1]);
  ws1['!cols'] = [
    {wch:14},{wch:12},{wch:22},{wch:12},{wch:30},{wch:12},{wch:30},
    {wch:6},{wch:12},{wch:35},{wch:8},{wch:6},{wch:14},
    {wch:14},{wch:12},{wch:6},{wch:12},
    {wch:6},{wch:12},{wch:10},{wch:10},
    {wch:14},{wch:14},{wch:16},{wch:50},
  ];
  ws1['!autofilter'] = { ref: 'A1:Y1' };
  ws1['!freeze'] = { xSplit: 0, ySplit: 1 };

  applyHeaderStyle(ws1, 0, H1.length);
  for (let i = 1; i <= rows1.length; i++) {
    applyRowStyles(ws1, i, H1.length, NUMS1, PCTS1);
  }
  XLSX.utils.book_append_sheet(wb, ws1, 'Ítems por factura');

  // ── Pestaña 2: Terceros (23 columnas) ────────────────────
  const tercerosMap = {};
  facturas.forEach(function(fac) {
    const addT = function(p, tipoTercero, fuente) {
      if (!p) return;
      const nitRaw = String(p.nit||'').replace(/[^0-9]/g,'');
      if (!nitRaw || tercerosMap[nitRaw]) return;
      const tipoId = p.tipoId || (nitRaw.length===9?'31':'13');
      const esEmpresa = tipoId === '31';
      const nom = (p.nombre||'').toUpperCase();
      const partes = nom.split(' ').filter(Boolean);
      tercerosMap[nitRaw] = {
        tipoId,
        nit:        nitRaw,
        dv:         calcDV(nitRaw),
        razon:      esEmpresa ? nom : '',
        ap1:        !esEmpresa && partes[0] ? partes[0] : '',
        ap2:        !esEmpresa && partes[1] ? partes[1] : '',
        nom1:       !esEmpresa && partes[2] ? partes[2] : '',
        nom2:       !esEmpresa && partes[3] ? partes[3] : '',
        dir:        (p.dir||'').toUpperCase(),
        codDepto:   p.codDepto||'',
        codMun:     p.codMun||'',
        pais:       (p.pais||'CO').toUpperCase(),
        actEco:     p.actEco||'',
        regimen:    (p.regimen||'').toUpperCase(),
        depto:      (p.depto||'').toUpperCase(),
        ciudad:     (p.ciudad||'').toUpperCase(),
        tel:        p.tel||'',
        email:      (p.email||'').toLowerCase(),
        respTrib:   esEmpresa ? 'RESPONSABLE' : 'NO RESPONSABLE',
        fuente:     fuente.toUpperCase(),
        tipoContrib:esEmpresa ? 'PERSONA JURIDICA' : 'PERSONA NATURAL',
        tipoTercero:tipoTercero.toUpperCase(),
        paisReside: (p.pais||'COLOMBIA').toUpperCase(),
      };
    };
    addT(fac.emisor,   'PROVEEDOR', fac.folio||'');
    addT(fac.receptor, 'CLIENTE',   fac.folio||'');
  });

  const H2 = [
    'TIPO ID','NUMERO ID','DV','RAZON SOCIAL',
    'PRIMER APELLIDO','SEGUNDO APELLIDO','PRIMER NOMBRE','SEGUNDO NOMBRE',
    'DIRECCION','CODIGO DEPARTAMENTO','CODIGO MUNICIPIO','PAIS RESIDENCIA',
    'ACTIVIDAD ECONOMICA','REGIMEN IVA','DEPARTAMENTO','CIUDAD',
    'TELEFONO','EMAIL','RESP TRIBUTARIA','FUENTE',
    'TIPO CONTRIBUYENTE','TIPO TERCERO','PAIS',
  ];

  const rows2 = Object.values(tercerosMap).map(function(t) {
    return [
      t.tipoId, t.nit, t.dv, t.razon,
      t.ap1, t.ap2, t.nom1, t.nom2,
      t.dir, t.codDepto, t.codMun, t.pais,
      t.actEco, t.regimen, t.depto, t.ciudad,
      t.tel, t.email, t.respTrib, t.fuente,
      t.tipoContrib, t.tipoTercero, t.paisReside,
    ];
  });

  const ws2 = XLSX.utils.aoa_to_sheet([H2, ...rows2]);
  ws2['!cols'] = [
    {wch:6},{wch:14},{wch:4},{wch:40},
    {wch:18},{wch:18},{wch:16},{wch:16},
    {wch:35},{wch:8},{wch:8},{wch:12},
    {wch:8},{wch:14},{wch:20},{wch:20},
    {wch:14},{wch:30},{wch:14},{wch:20},
    {wch:16},{wch:12},{wch:12},
  ];
  ws2['!autofilter'] = { ref: 'A1:W1' };
  ws2['!freeze'] = { xSplit: 0, ySplit: 1 };

  applyHeaderStyle(ws2, 0, H2.length);
  for (let i = 1; i <= rows2.length; i++) {
    applyRowStyles(ws2, i, H2.length, [], []);
  }
  XLSX.utils.book_append_sheet(wb, ws2, 'Terceros');

  // ── Pestaña 3: Resumen por factura ───────────────────────
  const resumenMap = {};
  filas.forEach(function(r) {
    const k = r.cufe || r.folio;
    if (!resumenMap[k]) {
      resumenMap[k] = {
        tipo: r.tipo||'', cufe: r.cufe||'', folio: r.folio||'',
        fecha: r.fecha||'',
        nitEmi: r.nitEmisor||r.nitEmi||'', nomEmi: r.nomEmisor||r.nomEmi||'',
        nitRec: r.nitReceptor||r.nitRec||'', nomRec: r.nomReceptor||r.nomRec||'',
        subtotal:0, iva:0, inc:0, ica:0, total: r.totalFac||0,
        grupo: r.grupo||'', cufeUrl: r.cufeUrl||'',
      };
    }
    resumenMap[k].subtotal += (r.subtotal||r.subt||0);
    resumenMap[k].iva      += (r.iva||0);
    resumenMap[k].inc      += (r.inc||0);
    resumenMap[k].ica      += (r.ica||0);
  });

  const H3 = [
    'Tipo Documento','CUFE','Folio','Fecha',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'Subtotal','IVA','INC','ICA','Total Factura','Grupo','Ver en Línea',
  ];
  const NUMS3 = [8,9,10,11,12];

  const rows3 = Object.values(resumenMap).map(function(r) {
    return [
      r.tipo, r.cufe, r.folio, r.fecha,
      r.nitEmi, r.nomEmi, r.nitRec, r.nomRec,
      r.subtotal, r.iva, r.inc, r.ica, r.total,
      r.grupo, r.cufeUrl,
    ];
  });

  const ws3 = XLSX.utils.aoa_to_sheet([H3, ...rows3]);
  ws3['!cols'] = [
    {wch:22},{wch:16},{wch:12},{wch:12},
    {wch:12},{wch:30},{wch:12},{wch:30},
    {wch:14},{wch:14},{wch:10},{wch:10},{wch:14},{wch:10},{wch:50},
  ];
  ws3['!autofilter'] = { ref: 'A1:O1' };
  ws3['!freeze'] = { xSplit: 0, ySplit: 1 };

  applyHeaderStyle(ws3, 0, H3.length);
  for (let i = 1; i <= rows3.length; i++) {
    applyRowStyles(ws3, i, H3.length, NUMS3, []);
  }
  XLSX.utils.book_append_sheet(wb, ws3, 'Resumen por factura');

  const s   = (fechaIni||'').replace(/-/g,'');
  const e2  = (fechaFin||fechaIni||'').replace(/-/g,'');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g,'_').replace(/_+/g,'_').substring(0,22);
  const filename = `${emp}_${s}_${e2}_Items.xlsx`;
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
  return { buffer, filename };
}

/**
 * generarExcelResumen — 1 fila por factura (igual al export DIAN)
 */
function generarExcelResumen(facturas, { empresa = 'EDIAN', fechaIni, fechaFin }) {
  const H = [
    'Tipo Documento','CUFE','Folio','Prefijo','Fecha Emisión',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'Subtotal','IVA 5%','IVA 19%','Total IVA','ICA','INC',
    'Total Factura','Estado','Grupo','Ver en Línea',
  ];
  const NUMS = [9,10,11,12,13,14,15];

  const rows = facturas.map(f => {
    const e = f.emisor||{}; const r = f.receptor||{};
    return [
      f.tipo||'', f.cufe||'', f.numero||f.folio||'', f.prefijo||'', f.fecha||'',
      e.nit||'', e.nombre||'', r.nit||'', r.nombre||'',
      f.subtotal||0, 0, f.iva||0, f.iva||0, f.ica||0, f.inc||0,
      f.total||0, '', f.grupo||'', f.cufeUrl||'',
    ];
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([H, ...rows]);
  ws['!cols'] = [
    {wch:22},{wch:16},{wch:12},{wch:10},{wch:14},
    {wch:12},{wch:30},{wch:12},{wch:30},
    {wch:14},{wch:10},{wch:10},{wch:12},{wch:10},{wch:10},
    {wch:14},{wch:10},{wch:10},{wch:50},
  ];
  ws['!autofilter'] = { ref: 'A1:S1' };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  applyHeaderStyle(ws, 0, H.length);
  for (let i = 1; i <= rows.length; i++) {
    applyRowStyles(ws, i, H.length, NUMS, []);
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Resumen');

  const s   = (fechaIni||'').replace(/-/g,'');
  const e2  = (fechaFin||fechaIni||'').replace(/-/g,'');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g,'_').replace(/_+/g,'_').substring(0,22);
  const filename = `${emp}_${s}_${e2}_Resumen.xlsx`;
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
  return { buffer, filename };
}

module.exports = { generarExcelItems, generarExcelResumen };
