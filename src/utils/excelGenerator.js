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

// Tipo ID por código
const TIPO_ID_NOMBRE = {
  '13':'Cédula ciudadanía (13)',
  '22':'Cédula extranjería (22)',
  '31':'NIT (31)',
  '11':'Registro civil (11)',
  '12':'Tarjeta identidad (12)',
  '21':'Tarjeta extranjería (21)',
  '41':'Pasaporte (41)',
  '42':'Doc. extranjero (42)',
  '50':'NIT otro país (50)',
};

/**
 * generarExcelItems — 3 pestañas: Ítems, Terceros, Resumen
 */
function generarExcelItems(filas, facturas, { empresa = 'EDIAN', fechaIni, fechaFin }) {
  const wb = XLSX.utils.book_new();

  // ── Pestaña 1: Ítems por factura (1 fila por ítem) ────────
  const H1 = [
    'Folio','Fecha','Tipo documento',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'Ítem #','Código','Descripción','Cantidad','Unidad','Precio unitario',
    'Subtotal línea','Base IVA','% IVA','Valor IVA',
    '% INC','Valor INC','ICA','Otros imp.',
    'Total línea','Total factura','CUFE','Ver factura',
  ];
  const rows1 = filas.map(r => [
    r.folio||'', r.fecha||'', r.tipo||'',
    r.nitEmisor||r.nitEmi||'', r.nomEmisor||r.nomEmi||'',
    r.nitReceptor||r.nitRec||'', r.nomReceptor||r.nomRec||'',
    r.item||'', r.codigo||'', r.descripcion||r.desc||'',
    r.qty||'', r.um||'', r.precioUnit||r.punit||0,
    r.subtotal||r.subt||0, r.baseIva||0, r.ivaPct||0, r.iva||0,
    r.incPct||0, r.inc||0, r.ica||0, r.otros||0,
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
  XLSX.utils.book_append_sheet(wb, ws1, 'Ítems por factura');

  // ── Pestaña 2: Terceros ────────────────────────────────────
  const tercerosMap = {};
  facturas.forEach(function(fac) {
    const addT = function(p, tipo) {
      if (!p) return;
      const nitRaw = String(p.nit||'').replace(/[^0-9]/g,'');
      if (!nitRaw || tercerosMap[nitRaw]) return;
      tercerosMap[nitRaw] = {
        tipoId:   p.tipoId || (nitRaw.length===9?'31':'13'),
        nit:      nitRaw,
        dv:       calcDV(nitRaw),
        nombre:   p.nombre||'',
        actEco:   p.actEco||'',
        tipo:     tipo,
        regimen:  p.regimen||'',
        dir:      p.dir||'',
        ciudad:   p.ciudad||'',
        codMun:   p.codMun||'',
        depto:    p.depto||'',
        codDepto: p.codDepto||'',
        pais:     p.pais||'CO',
        tel:      p.tel||'',
        email:    p.email||'',
      };
    };
    addT(fac.emisor, 'Proveedor');
    addT(fac.receptor, 'Cliente');
  });
  const H2 = [
    'Tipo ID','Código','Número ID','DV','Razón Social / Nombre',
    'Actividad Económica','Tipo Tercero','Régimen IVA',
    'Dirección','Ciudad','Código Municipio','Departamento',
    'Código Departamento','País','Teléfono','Email',
  ];
  const rows2 = Object.values(tercerosMap).map(function(t) {
    return [
      TIPO_ID_NOMBRE[t.tipoId]||t.tipoId, t.tipoId,
      t.nit, t.dv, t.nombre, t.actEco, t.tipo, t.regimen,
      t.dir, t.ciudad, t.codMun, t.depto, t.codDepto, t.pais, t.tel, t.email,
    ];
  });
  const ws2 = XLSX.utils.aoa_to_sheet([H2, ...rows2]);
  ws2['!cols'] = [
    {wch:22},{wch:4},{wch:14},{wch:4},{wch:40},
    {wch:8},{wch:10},{wch:14},
    {wch:35},{wch:20},{wch:8},{wch:20},{wch:6},{wch:5},{wch:14},{wch:30},
  ];
  ws2['!autofilter'] = { ref: 'A1:P1' };
  XLSX.utils.book_append_sheet(wb, ws2, 'Terceros');

  // ── Pestaña 3: Resumen por factura ─────────────────────────
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
    'Subtotal','IVA','INC','ICA','Total Factura','Grupo','Ver en línea',
  ];
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
    {wch:12},{wch:12},{wch:10},{wch:10},{wch:14},{wch:10},{wch:50},
  ];
  ws3['!autofilter'] = { ref: 'A1:O1' };
  XLSX.utils.book_append_sheet(wb, ws3, 'Resumen por factura');

  // Nombre del archivo
  const s   = (fechaIni||'').replace(/-/g,'');
  const e2  = (fechaFin||fechaIni||'').replace(/-/g,'');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g,'_').replace(/_+/g,'_').substring(0,22);
  const filename = `${emp}_${s}_${e2}_Items.xlsx`;

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
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
    'Total Factura','Estado','Grupo','Ver en línea',
  ];
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
  ws['!autofilter'] = { ref: 'A1:S1' };
  XLSX.utils.book_append_sheet(wb, ws, 'Resumen');

  const s   = (fechaIni||'').replace(/-/g,'');
  const e2  = (fechaFin||fechaIni||'').replace(/-/g,'');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g,'_').replace(/_+/g,'_').substring(0,22);
  const filename = `${emp}_${s}_${e2}_Resumen.xlsx`;

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, filename };
}

module.exports = { generarExcelItems, generarExcelResumen };
