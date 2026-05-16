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

  // ── Pestaña 2: Terceros SIIGO ───────────────────────────
  const H2 = [
    'NIT', 'Tipo ID', 'Razón social', 'Tipo contribuyente',
    'Régimen fiscal', 'Depto', 'Ciudad', 'Dirección',
    'Teléfono', 'Email', 'Resp. tributaria', 'Fuente',
  ];
  const seen = {};
  for (const fac of facturas) {
    const e = fac.emisor;
    if (e.nit && !seen[e.nit]) {
      seen[e.nit] = [
        e.nit, '31', e.nombre, 'Persona Jurídica',
        e.regimen || 'O-13', e.depto, e.ciudad, e.dir,
        e.tel, e.email, '01 - IVA', fac.folio,
      ];
    }
  }
  const ws2 = XLSX.utils.aoa_to_sheet([H2, ...Object.values(seen)]);
  ws2['!cols'] = [{wch:14},{wch:8},{wch:35},{wch:16},{wch:14},{wch:18},{wch:18},{wch:28},{wch:12},{wch:30},{wch:14},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Terceros SIIGO');

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
