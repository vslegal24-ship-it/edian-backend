const XLSX = require('xlsx');

/**
 * generarExcelItems - genera Excel con 1 fila por ítem
 * Incluye pestaña Items + pestaña Terceros SIIGO
 */
function generarExcelItems(filas, facturas, { empresa = 'EDIAN', fechaIni, fechaFin }) {
  const wb = XLSX.utils.book_new();

  // ── Pestaña 1: Items por factura ────────────────────────
  const H = [
    'Folio', 'Fecha', 'Tipo documento',
    'NIT Emisor', 'Nombre Emisor', 'NIT Receptor', 'Nombre Receptor',
    'Ítem #', 'Código', 'Descripción', 'Cantidad', 'Unidad', 'Precio unitario',
    'Subtotal línea', 'Base IVA', '% IVA', 'Valor IVA',
    '% INC', 'Valor INC', 'ICA', 'Otros imp.',
    'Total línea', 'Total factura', 'CUFE', 'Ver factura',
  ];

  const rows = filas.map(r => [
    r.folio, r.fecha, r.tipo,
    r.nitEmisor, r.nomEmisor, r.nitReceptor, r.nomReceptor,
    r.item, r.codigo, r.descripcion, r.qty, r.um, r.precioUnit,
    r.subtotal, r.baseIva, r.ivaPct, r.iva,
    r.incPct, r.inc, r.ica, r.otros,
    r.totalLinea, r.totalFac, r.cufe, r.cufeUrl,
  ]);

  const ws1 = XLSX.utils.aoa_to_sheet([H, ...rows]);
  ws1['!cols'] = [
    {wch:14},{wch:12},{wch:20},
    {wch:12},{wch:32},{wch:12},{wch:28},
    {wch:6},{wch:10},{wch:38},{wch:8},{wch:7},{wch:13},
    {wch:14},{wch:12},{wch:6},{wch:12},
    {wch:6},{wch:10},{wch:10},{wch:10},
    {wch:14},{wch:14},{wch:16},{wch:50},
  ];
  ws1['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws1, 'Items por factura');

  // ── Pestaña 2: Terceros (plantilla sistema contable) ──────
  const tercerosMap = {};
  facturas.forEach(function(fac) {
    const addTercero = function(p, tipo) {
      if (!p) return;
      const nitRaw = String(p.nit || '').replace(/[^0-9]/g,'');
      if (!nitRaw || tercerosMap[nitRaw]) return;
      tercerosMap[nitRaw] = {
        tipoId: p.tipoId || (nitRaw.length===9?'31':'13'),
        nit: nitRaw, dv: calcDV(nitRaw),
        nombre: p.nombre||'', actEco: p.actEco||'',
        tipo: tipo, regimen: p.regimen||'',
        dir: p.dir||'', ciudad: p.ciudad||'',
        codMun: p.codMun||'', depto: p.depto||'',
        codDepto: p.codDepto||'', pais: p.pais||'CO',
        tel: p.tel||'', email: p.email||'',
      };
    };
    addTercero(fac.emisor, 'Proveedor');
    addTercero(fac.receptor, 'Cliente');
  });

  const TIPO_ID = {'13':'CC','22':'CE','31':'NIT','11':'RC','12':'TI','21':'TE','41':'PA','42':'DE','50':'NE'};
  const H2 = ['Tipo ID','Código','Número ID','DV','Razón Social / Nombre','Actividad Económica',
    'Tipo Tercero','Régimen IVA','Dirección','Ciudad','Código Municipio',
    'Departamento','Código Departamento','País','Teléfono','Email'];

  const rows2 = Object.values(tercerosMap).map(function(t) {
    return [
      (TIPO_ID[t.tipoId]||t.tipoId) + ' (' + t.tipoId + ')',
      t.tipoId, t.nit, t.dv, t.nombre, t.actEco, t.tipo, t.regimen,
      t.dir, t.ciudad, t.codMun, t.depto, t.codDepto, t.pais, t.tel, t.email,
    ];
  });

  const ws2 = XLSX.utils.aoa_to_sheet([H2, ...rows2]);
  ws2['!cols'] = [{wch:12},{wch:4},{wch:14},{wch:4},{wch:40},{wch:8},{wch:10},
    {wch:14},{wch:35},{wch:20},{wch:8},{wch:20},{wch:6},{wch:5},{wch:14},{wch:30}];
  ws2['!autofilter'] = { ref: 'A1:P1' };
  XLSX.utils.book_append_sheet(wb, ws2, 'Terceros');  // ── Pestaña 3: Resumen por factura (igual al listado DIAN opcion 3) ─
  const H3 = [
    'Tipo de documento','CUFE/CUDE','Folio','Prefijo','Divisa',
    'Forma de Pago','Medio de Pago','Fecha Emisión','Fecha Recepción',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'IVA','ICA','INC','Total','Estado','Grupo','Ver en línea',
  ];
  // Agrupar filas por folio para obtener una fila por factura
  const resumenMap = {};
  filas.forEach(function(r) {
    const k = r.folio || r.cufe;
    if (!resumenMap[k]) {
      resumenMap[k] = {
        tipo: r.tipo||'', cufe: r.cufe||'', folio: r.folio||'',
        prefijo: r.prefijo||'', fecha: r.fecha||'',
        nitEmi: r.nitEmisor||r.nitEmi||'', nomEmi: r.nomEmisor||r.nomEmi||'',
        nitRec: r.nitReceptor||r.nitRec||'', nomRec: r.nomReceptor||r.nomRec||'',
        iva: 0, ica: 0, inc: 0, total: r.totFac||r.totalFac||0,
        grupo: r.grupo||'', cufeUrl: r.cufeUrl||'',
      };
    }
    resumenMap[k].iva += (r.iva||0);
    resumenMap[k].ica += (r.ica||0);
    resumenMap[k].inc += (r.inc||0);
  });
  // También incluir facturas que vienen de facturas_data
  if (Array.isArray(facturas)) {
    facturas.forEach(function(f) {
      const k = f.folio || f.cufe;
      if (!resumenMap[k]) {
        const e = f.emisor||{};const rec = f.receptor||{};
        resumenMap[k] = {
          tipo: f.tipo||'', cufe: f.cufe||'', folio: f.folio||f.numero||'',
          prefijo: f.prefijo||'', fecha: f.fecha||'',
          nitEmi: e.nit||f.nitEmisor||'', nomEmi: e.nombre||f.nomEmisor||'',
          nitRec: rec.nit||f.nitReceptor||'', nomRec: rec.nombre||f.nomReceptor||'',
          iva: f.iva||0, ica: f.ica||0, inc: f.inc||0, total: f.total||0,
          grupo: f.grupo||'', cufeUrl: f.cufeUrl||'',
        };
      }
    });
  }
  const rows3 = Object.values(resumenMap).map(function(r) {
    return [
      r.tipo, r.cufe, r.folio, r.prefijo, 'COP', 1, 10,
      r.fecha, '',
      r.nitEmi, r.nomEmi, r.nitRec, r.nomRec,
      r.iva, r.ica, r.inc, r.total,
      'Aprobado con notificación', r.grupo, r.cufeUrl,
    ];
  });
  const ws3 = XLSX.utils.aoa_to_sheet([H3, ...rows3]);
  ws3['!cols'] = [{wch:22},{wch:16},{wch:10},{wch:8},{wch:6},{wch:8},{wch:8},{wch:12},{wch:12},
    {wch:12},{wch:32},{wch:12},{wch:32},{wch:12},{wch:10},{wch:10},{wch:14},{wch:24},{wch:10},{wch:50}];
  ws3['!autofilter'] = { ref: 'A1:T1' };
  XLSX.utils.book_append_sheet(wb, ws3, 'Resumen por factura');

  // Nombre del archivo
  const s = (fechaIni || '').replace(/-/g, '');
  const e2 = (fechaFin || fechaIni || '').replace(/-/g, '');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 22);
  const filename = `${emp}_${s}_${e2}_Items.xlsx`;

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, filename };
}

/**
 * generarExcelResumen - idéntico al export de la DIAN (1 fila por factura)
 */
function generarExcelResumen(facturas, { empresa = 'EDIAN', fechaIni, fechaFin }) {
  const H = [
    'Tipo de documento','CUFE/CUDE','Folio','Prefijo','Divisa',
    'Forma de Pago','Medio de Pago','Fecha Emisión','Fecha Recepción',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'IVA','ICA','IC','INC','Timbre','INC Bolsas','IN Carbono','IN Combustibles',
    'IC Datos','ICL','INPP','IBUA','ICUI','Rete IVA','Rete Renta','Rete ICA',
    'Total','Estado','Grupo','Ver factura en línea',
  ];

  const rows = facturas.map(f => [
    f.tipo, f.cufe, f.numero, f.prefijo, f.moneda, 1, 10,
    f.fecha, '',
    f.emisor.nit, f.emisor.nombre, f.receptor.nit, f.receptor.nombre,
    f.iva, f.ica, 0, f.inc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    f.total, 'Aprobado con notificación', '',
    f.cufeUrl,
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([H, ...rows]);
  const sn = `Rp_Doc_${(fechaIni||'').replace(/-/g,'').substring(2)}`.substring(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sn);

  const s = (fechaIni || '').replace(/-/g, '');
  const e2 = (fechaFin || fechaIni || '').replace(/-/g, '');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 22);
  const filename = `${emp}_${s}_${e2}_Resumen.xlsx`;

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, filename };
}

module.exports = { generarExcelItems, generarExcelResumen };  // ── Pestaña 2: Terceros (plantilla sistema contable) ──────
  const tercerosMap = {};
  facturas.forEach(function(fac) {
    // Emisor
    const e = fac.emisor || {};
    const nitE = String(e.nit || '').replace(/[^0-9]/g,'');
    if (nitE && !tercerosMap[nitE]) {
      tercerosMap[nitE] = {
        tipoId:   e.tipoId || '31',
        nit:      nitE,
        dv:       calcDV(nitE),
        nombre:   e.nombre || '',
        dir:      e.dir || '',
        ciudad:   e.ciudad || '',
        codMun:   e.codMun || '',
        depto:    e.depto || '',
        codDepto: e.codDepto || '',
        pais:     e.pais || 'CO',
        tel:      e.tel || '',
        email:    e.email || '',
        actEco:   e.actEco || '',
        regimen:  e.regimen || '',
        tipo:     'Proveedor',
      };
    }
    // Receptor
    const r = fac.receptor || {};
    const nitR = String(r.nit || '').replace(/[^0-9]/g,'');
    if (nitR && !tercerosMap[nitR]) {
      tercerosMap[nitR] = {
        tipoId:   r.tipoId || '31',
        nit:      nitR,
        dv:       calcDV(nitR),
        nombre:   r.nombre || '',
        dir:      r.dir || '',
        ciudad:   r.ciudad || '',
        codMun:   r.codMun || '',
        depto:    r.depto || '',
        codDepto: r.codDepto || '',
        pais:     r.pais || 'CO',
        tel:      r.tel || '',
        email:    r.email || '',
        actEco:   r.actEco || '',
        regimen:  '',
        tipo:     'Cliente',
      };
    }
  });

  const H2 = [
    'Tipo ID',           // 13=CC, 22=CE, 31=NIT, 41=Pasaporte
    'Número ID',
    'DV',
    'Razón Social / Nombre',
    'Actividad Económica',
    'Tipo Tercero',      // Proveedor / Cliente
    'Régimen IVA',
    'Dirección',
    'Ciudad',
    'Código Municipio',
    'Departamento',
    'Código Departamento',
    'País',
    'Teléfono',
    'Email',
  ];

  const rows2 = Object.values(tercerosMap).map(function(t) {
    const tipoNombre = {
      '13':'Cédula de ciudadanía',
      '22':'Cédula de extranjería',
      '31':'NIT',
      '11':'Registro civil',
      '12':'Tarjeta de identidad',
      '21':'Tarjeta de extranjería',
      '41':'Pasaporte',
      '42':'Doc. extranjero',
      '50':'NIT otro país',
    }[t.tipoId] || t.tipoId;
    return [
      tipoNombre + ' (' + t.tipoId + ')',
      t.nit,
      t.dv,
      t.nombre,
      t.actEco,
      t.tipo,
      t.regimen,
      t.dir,
      t.ciudad,
      t.codMun,
      t.depto,
      t.codDepto,
      t.pais,
      t.tel,
      t.email,
    ];
  });

  const ws2 = XLSX.utils.aoa_to_sheet([H2, ...rows2]);
  ws2['!cols'] = [
    {wch:22},{wch:14},{wch:4},{wch:40},{wch:8},{wch:12},{wch:14},
    {wch:35},{wch:20},{wch:8},{wch:20},{wch:6},{wch:6},{wch:14},{wch:30},
  ];
  ws2['!autofilter'] = { ref: 'A1:O1' };
  XLSX.utils.book_append_sheet(wb, ws2, 'Terceros SIIGO');;

  // ── Pestaña 3: Resumen por factura (igual al listado DIAN opcion 3) ─
  const H3 = [
    'Tipo de documento','CUFE/CUDE','Folio','Prefijo','Divisa',
    'Forma de Pago','Medio de Pago','Fecha Emisión','Fecha Recepción',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'IVA','ICA','INC','Total','Estado','Grupo','Ver en línea',
  ];
  // Agrupar filas por folio para obtener una fila por factura
  const resumenMap = {};
  filas.forEach(function(r) {
    const k = r.folio || r.cufe;
    if (!resumenMap[k]) {
      resumenMap[k] = {
        tipo: r.tipo||'', cufe: r.cufe||'', folio: r.folio||'',
        prefijo: r.prefijo||'', fecha: r.fecha||'',
        nitEmi: r.nitEmisor||r.nitEmi||'', nomEmi: r.nomEmisor||r.nomEmi||'',
        nitRec: r.nitReceptor||r.nitRec||'', nomRec: r.nomReceptor||r.nomRec||'',
        iva: 0, ica: 0, inc: 0, total: r.totFac||r.totalFac||0,
        grupo: r.grupo||'', cufeUrl: r.cufeUrl||'',
      };
    }
    resumenMap[k].iva += (r.iva||0);
    resumenMap[k].ica += (r.ica||0);
    resumenMap[k].inc += (r.inc||0);
  });
  // También incluir facturas que vienen de facturas_data
  if (Array.isArray(facturas)) {
    facturas.forEach(function(f) {
      const k = f.folio || f.cufe;
      if (!resumenMap[k]) {
        const e = f.emisor||{};const rec = f.receptor||{};
        resumenMap[k] = {
          tipo: f.tipo||'', cufe: f.cufe||'', folio: f.folio||f.numero||'',
          prefijo: f.prefijo||'', fecha: f.fecha||'',
          nitEmi: e.nit||f.nitEmisor||'', nomEmi: e.nombre||f.nomEmisor||'',
          nitRec: rec.nit||f.nitReceptor||'', nomRec: rec.nombre||f.nomReceptor||'',
          iva: f.iva||0, ica: f.ica||0, inc: f.inc||0, total: f.total||0,
          grupo: f.grupo||'', cufeUrl: f.cufeUrl||'',
        };
      }
    });
  }
  const rows3 = Object.values(resumenMap).map(function(r) {
    return [
      r.tipo, r.cufe, r.folio, r.prefijo, 'COP', 1, 10,
      r.fecha, '',
      r.nitEmi, r.nomEmi, r.nitRec, r.nomRec,
      r.iva, r.ica, r.inc, r.total,
      'Aprobado con notificación', r.grupo, r.cufeUrl,
    ];
  });
  const ws3 = XLSX.utils.aoa_to_sheet([H3, ...rows3]);
  ws3['!cols'] = [{wch:22},{wch:16},{wch:10},{wch:8},{wch:6},{wch:8},{wch:8},{wch:12},{wch:12},
    {wch:12},{wch:32},{wch:12},{wch:32},{wch:12},{wch:10},{wch:10},{wch:14},{wch:24},{wch:10},{wch:50}];
  ws3['!autofilter'] = { ref: 'A1:T1' };
  XLSX.utils.book_append_sheet(wb, ws3, 'Resumen por factura');

  // Nombre del archivo
  const s = (fechaIni || '').replace(/-/g, '');
  const e2 = (fechaFin || fechaIni || '').replace(/-/g, '');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 22);
  const filename = `${emp}_${s}_${e2}_Items.xlsx`;

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, filename };
}

/**
 * generarExcelResumen - idéntico al export de la DIAN (1 fila por factura)
 */
function generarExcelResumen(facturas, { empresa = 'EDIAN', fechaIni, fechaFin }) {
  const H = [
    'Tipo de documento','CUFE/CUDE','Folio','Prefijo','Divisa',
    'Forma de Pago','Medio de Pago','Fecha Emisión','Fecha Recepción',
    'NIT Emisor','Nombre Emisor','NIT Receptor','Nombre Receptor',
    'IVA','ICA','IC','INC','Timbre','INC Bolsas','IN Carbono','IN Combustibles',
    'IC Datos','ICL','INPP','IBUA','ICUI','Rete IVA','Rete Renta','Rete ICA',
    'Total','Estado','Grupo','Ver factura en línea',
  ];

  const rows = facturas.map(f => [
    f.tipo, f.cufe, f.numero, f.prefijo, f.moneda, 1, 10,
    f.fecha, '',
    f.emisor.nit, f.emisor.nombre, f.receptor.nit, f.receptor.nombre,
    f.iva, f.ica, 0, f.inc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    f.total, 'Aprobado con notificación', '',
    f.cufeUrl,
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([H, ...rows]);
  const sn = `Rp_Doc_${(fechaIni||'').replace(/-/g,'').substring(2)}`.substring(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sn);

  const s = (fechaIni || '').replace(/-/g, '');
  const e2 = (fechaFin || fechaIni || '').replace(/-/g, '');
  const emp = empresa.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').substring(0, 22);
  const filename = `${emp}_${s}_${e2}_Resumen.xlsx`;

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, filename };
}

module.exports = { generarExcelItems, generarExcelResumen };
