const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BOLD_SECRET = process.env.BOLD_WEBHOOK_SECRET || '';

// Planes que Bold activa automáticamente
const PLANES_DURACION = {
  'empresa_ppu':  null,      // por consulta, no vence
  'empresa_med':  30,
  'empresa_pro':  30,
  'cont_basico':  30,
  'cont_std':     30,
  'cont_pro':     30,
};

const PLANES_CONSULTAS = {
  'pack_3':  3,
  'pack_6':  6,
  'pack_10': 10,
};

function verificarFirmaBold(payload, signature) {
  if (!BOLD_SECRET) return true; // sin secreto en dev
  const hash = crypto.createHmac('sha256', BOLD_SECRET)
    .update(JSON.stringify(payload)).digest('hex');
  return hash === signature;
}

// ── POST /api/bold/webhook ───────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['x-bold-signature'] || '';
    const body = JSON.parse(req.body.toString());
    console.log('[BOLD] Webhook recibido:', JSON.stringify(body).substring(0, 200));

    if (!verificarFirmaBold(body, sig)) {
      console.error('[BOLD] Firma inválida');
      return res.status(400).json({ error: 'Firma inválida' });
    }

    const { status, order_id, amount, metadata = {} } = body;
    if (status !== 'APPROVED') {
      console.log('[BOLD] Pago no aprobado:', status);
      return res.json({ ok: true, mensaje: 'Registrado' });
    }

    // Datos del comprador desde metadata de Bold
    const { email, nombre, plan_id, telefono, nit_empresa } = metadata;
    if (!email || !plan_id) {
      console.error('[BOLD] Faltan email o plan_id en metadata');
      return res.status(400).json({ error: 'Metadata incompleta' });
    }

    // ¿Usuario existe?
    let { data: usuario } = await supabase
      .from('edian_usuarios')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (!usuario) {
      // Crear usuario automáticamente
      const password_temp = Math.random().toString(36).slice(-8);
      const hash = await bcrypt.hash(password_temp, 10);
      const rol = plan_id.startsWith('cont') ? 'contador' : 'empresa';

      const { data: nuevo, error } = await supabase.from('edian_usuarios').insert({
        email: email.toLowerCase(),
        password_hash: hash,
        nombre: nombre || email,
        telefono: telefono || '',
        rol,
        plan_id,
        activo: true,
        nits_asignados: nit_empresa ? [nit_empresa] : [],
        consultas_regalo: PLANES_CONSULTAS[plan_id] || 0,
      }).select().single();

      if (error) throw new Error('Error creando usuario: ' + error.message);
      usuario = nuevo;

      // TODO: enviar email con credenciales
      console.log(`[BOLD] Usuario creado: ${email} | clave temporal: ${password_temp}`);
    }

    // Calcular vencimiento
    const dias = PLANES_DURACION[plan_id];
    const fechaVence = dias ? new Date(Date.now() + dias * 86400000).toISOString() : null;

    // Actualizar plan y vencimiento
    const consultasExtra = PLANES_CONSULTAS[plan_id] || 0;
    await supabase.from('edian_usuarios').update({
      plan_id,
      activo: true,
      fecha_vence: fechaVence,
      updated_at: new Date().toISOString(),
      ...(consultasExtra > 0 ? { consultas_regalo: supabase.rpc('increment', { x: consultasExtra }) } : {}),
    }).eq('id', usuario.id);

    // Registrar pago
    await supabase.from('edian_pagos').upsert({
      bold_order_id: order_id,
      bold_tx_id: body.transaction_id || '',
      usuario_id: usuario.id,
      monto: amount || 0,
      plan_id,
      estado: 'aprobado',
      tipo: consultasExtra > 0 ? 'pack_regalo' : plan_id === 'empresa_ppu' ? 'consulta' : 'suscripcion',
      consultas_compradas: consultasExtra,
      bold_payload: body,
    }, { onConflict: 'bold_order_id' });

    console.log(`[BOLD] ✓ Pago aprobado: ${email} → plan ${plan_id}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[BOLD] Error webhook:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bold/crear-link ─────────────────────────────────
// Genera el link de pago de Bold con la metadata necesaria
router.post('/crear-link', async (req, res) => {
  try {
    const { plan_id, email, nombre, telefono, nit_empresa } = req.body;
    const { data: plan } = await supabase.from('edian_planes').select('*').eq('id', plan_id).single();
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });

    const monto = plan.precio_mes || plan.precio_uso || 0;
    if (monto === 0) return res.status(400).json({ error: 'Plan sin costo' });

    // Bold link de cobro (usando API de Bold)
    const boldPayload = {
      amount: { currency: 'COP', total_amount: monto },
      description: `EDIAN - ${plan.nombre}`,
      metadata: { email, nombre, plan_id, telefono, nit_empresa: nit_empresa || '' },
      redirect_url: 'https://milkomercios.in/EDIAN/app.html?pago=ok',
    };

    const boldResp = await fetch('https://integrations.bold.co/v2/payment-links', {
      method: 'POST',
      headers: {
        'Authorization': 'x-api-key ' + process.env.BOLD_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(boldPayload),
    });

    if (!boldResp.ok) {
      const err = await boldResp.text();
      throw new Error('Bold API error: ' + err);
    }

    const boldData = await boldResp.json();
    res.json({ ok: true, url: boldData.url || boldData.payment_link, order_id: boldData.id });
  } catch(e) {
    console.error('[BOLD] crear-link error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
