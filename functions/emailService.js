'use strict';

// ═══════════════════════════════════════════════════════════════
// emailService.js — Orquestador del sistema de correo (backend)
//
// Pipeline de cualquier envío:
//   1. verificar configuración (global + torneo)
//   2. verificar cuota diaria
//   3. reclamar envío (transacción + ID determinístico anti-duplicado)
//   4. llamar a Brevo
//   5. confirmar aceptación
//   6. registrar sent/error (nunca marcar sent un envío fallido)
//   7. actualizar estadísticas de consumo
//
// Reutilizable por cualquier torneo: todo se identifica por torneoId.
// ═══════════════════════════════════════════════════════════════

const core = require('./emailCore');

const PATH_GLOBAL_CONFIG = 'config/emailConfig';
const COLLECTION_STATS = 'emailStats';
const HISTORICO_ID = 'historico';

function buildEmailService(deps) {
  const { db, FieldValue, Timestamp, createBrevo, getApiKey } = deps;
  const now = deps.now || (() => Date.now());

  // ── Referencias ──
  const globalConfigRef = () => db.doc(PATH_GLOBAL_CONFIG);
  const torneoConfigRef = (torneoId) => db.doc(`torneosColores/${torneoId}/configuracion/email`);
  const enviosCol = (torneoId) => db.collection(`torneosColores/${torneoId}/enviosEmail`);
  const envioRef = (torneoId, envioId) => db.doc(`torneosColores/${torneoId}/enviosEmail/${envioId}`);
  const statsRef = (fecha) => db.collection(COLLECTION_STATS).doc(fecha);
  const historicoRef = () => db.collection(COLLECTION_STATS).doc(HISTORICO_ID);

  // ── Configuración ──
  async function getGlobalConfig() {
    const snap = await globalConfigRef().get();
    return snap.exists ? snap.data() : null;
  }

  async function getTorneoConfig(torneoId) {
    const snap = await torneoConfigRef(torneoId).get();
    return snap.exists ? snap.data() : null;
  }

  async function getEffectiveConfig(torneoId) {
    const [g, t] = await Promise.all([
      getGlobalConfig(),
      torneoId ? getTorneoConfig(torneoId) : Promise.resolve(null)
    ]);
    return core.mergeEmailConfig(g || core.DEFAULT_EMAIL_CONFIG, t);
  }

  function fechaDeHoy(cfg) {
    return core.fechaLocal(new Date(now()), cfg && cfg.timezone);
  }

  function buildBrevoClient() {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('BREVO_API_KEY no está disponible. Configurar con: firebase functions:secrets:set BREVO_API_KEY');
    }
    return createBrevo(apiKey);
  }

  // ── Estadísticas de consumo (fuente de verdad: backend) ──
  async function readStatsDoc(fecha) {
    const snap = await statsRef(fecha).get();
    const d = snap.exists ? snap.data() : {};
    return {
      fecha,
      sent: d.sent || 0,
      error: d.error || 0,
      omitted: d.omitted || 0,
      pending: d.pending || 0,
      reserved: d.reserved || 0
    };
  }

  async function incrementStats(fecha, deltas) {
    const update = { fecha, updatedAt: Timestamp.now() };
    for (const [k, v] of Object.entries(deltas)) {
      if (v !== 0) update[k] = FieldValue.increment(v);
    }
    await statsRef(fecha).set(update, { merge: true });
  }

  async function incrementHistorico(deltas) {
    const update = { updatedAt: Timestamp.now() };
    for (const [k, v] of Object.entries(deltas)) {
      if (v !== 0) update[k] = FieldValue.increment(v);
    }
    await historicoRef().set(update, { merge: true });
  }

  async function getStats(torneoId) {
    const cfg = await getEffectiveConfig(torneoId || null);
    const hoy = fechaDeHoy(cfg);
    const snap = await db.collection(COLLECTION_STATS).get();

    const fechaRe = /^\d{4}-\d{2}-\d{2}$/;
    const rows = snap.docs
      .filter(d => fechaRe.test(d.id))
      .map(d => ({ id: d.id, ...d.data() }));

    const mesPrefix = hoy.slice(0, 7);
    const haceNDias = (n) => {
      const d = new Date(now() - n * 86400000);
      return core.fechaLocal(d, cfg.timezone);
    };
    const ayer = haceNDias(1);
    const inicio7 = haceNDias(6);

    const agg = (lista) => lista.reduce((acc, r) => {
      acc.sent += r.sent || 0;
      acc.error += r.error || 0;
      acc.omitted += r.omitted || 0;
      acc.pending += r.pending || 0;
      return acc;
    }, { sent: 0, error: 0, omitted: 0, pending: 0 });

    const rowHoy = rows.find(r => r.id === hoy);
    const statsHoy = rowHoy ? agg([rowHoy]) : agg([]);
    const rowAyer = rows.find(r => r.id === ayer);
    const stats7 = agg(rows.filter(r => r.id >= inicio7 && r.id <= hoy));
    const statsMes = agg(rows.filter(r => r.id.startsWith(mesPrefix)));

    const histSnap = await historicoRef().get();
    const hist = histSnap.exists ? histSnap.data() : {};

    const pct = cfg.dailyLimit > 0 ? Math.round((statsHoy.sent / cfg.dailyLimit) * 100) : 0;

    return {
      fecha: hoy,
      timezone: cfg.timezone,
      dailyLimit: cfg.dailyLimit,
      disponibles: Math.max(0, cfg.dailyLimit - statsHoy.sent - (statsHoy.reserved || 0)),
      porcentaje: pct,
      nivel: core.usageLevel(pct),
      hoy: statsHoy,
      ayer: rowAyer ? agg([rowAyer]) : agg([]),
      ultimos7dias: stats7,
      mes: statsMes,
      historico: {
        totalSent: hist.totalSent || 0,
        totalError: hist.totalError || 0,
        totalOmitted: hist.totalOmitted || 0
      },
      senderName: cfg.senderName,
      senderEmail: cfg.senderEmail,
      nota: 'Consumo registrado por este sistema. El límite diario corresponde a la cuenta Brevo, que puede ser compartida con otros proyectos.'
    };
  }

  // ── Historial ──
  async function getHistory({ torneoId, limit = 50 }) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const snap = await enviosCol(torneoId).orderBy('timestamp', 'desc').limit(n).get();
    return snap.docs.map(d => {
      const data = d.data();
      const ts = data.timestamp;
      return {
        id: d.id,
        ...data,
        timestampISO: ts && ts.toDate ? ts.toDate().toISOString() : (ts || null)
      };
    });
  }

  // ── Claim (transaccional + anti-duplicados) ──
  // esPrueba: se salta el check de dedup; el ID único se garantiza con
  // un suffix de timestamp + random (no se bloquea por envíos previos).
  async function claimBatch({ torneoId, tipo, recipients, cfg, fecha, subject, creadoPor, esPrueba }) {
    return db.runTransaction(async (t) => {
      const sSnap = await t.get(statsRef(fecha));
      const sData = sSnap.exists ? sSnap.data() : {};
      const sentToday = sData.sent || 0;
      const reservedToday = Math.max(0, sData.reserved || 0);

      const toClaim = [];
      const toOmit = [];
      const skipped = [];

      for (const r of recipients) {
        const email = core.normalizeEmail(r.email);
        const jugadorId = String(r.jugadorId || email || 'sindato');
        const id = r.envioId || core.buildEnvioId(torneoId, tipo, fecha, jugadorId, r.idSuffix);
        const ref = envioRef(torneoId, id);
        const snap = await t.get(ref);

        if (snap.exists && !esPrueba) {
          const estado = snap.data().estado;
          if (core.isClaimBlocked(estado)) {
            skipped.push({ id, email, razon: estado === 'sent' ? 'ya_enviado' : 'en_proceso' });
          } else {
            skipped.push({ id, email, razon: `existente_${estado}` });
          }
          continue;
        }

        const base = {
          torneoId,
          tipo,
          jugadorId,
          nombre: r.nombre || null,
          email,
          fecha,
          timestamp: Timestamp.now(),
          updatedAt: Timestamp.now(),
          intentos: 1,
          brevoMessageId: null,
          error: null,
          nota: esPrueba ? 'Email de prueba' : null,
          creadoPor: creadoPor || 'sistema',
          ultimoIntentoPor: creadoPor || 'sistema',
          metadata: { subject: subject || null, prueba: !!esPrueba }
        };

        if (!core.isValidEmail(email)) {
          toOmit.push({ ref, base });
        } else {
          toClaim.push({ ref, base });
        }
      }

      const quota = core.computeQuota({
        dailyLimit: cfg.dailyLimit,
        sentToday,
        reservedToday,
        requested: toClaim.length
      });

      if (!quota.allowed) {
        for (const c of toClaim) {
          t.set(c.ref, { ...c.base, estado: 'pending', nota: quota.message });
        }
        for (const o of toOmit) {
          t.set(o.ref, { ...o.base, estado: 'omitted', nota: 'Email inválido o ausente' });
        }
        if (toClaim.length > 0) {
          t.set(statsRef(fecha), { fecha, pending: FieldValue.increment(toClaim.length), updatedAt: Timestamp.now() }, { merge: true });
        }
        if (toOmit.length > 0) {
          t.set(statsRef(fecha), { fecha, omitted: FieldValue.increment(toOmit.length), updatedAt: Timestamp.now() }, { merge: true });
        }
        return { outcome: 'quota_blocked', quota, skipped, pending: toClaim.length, omitted: toOmit.length };
      }

      for (const o of toOmit) {
        t.set(o.ref, { ...o.base, estado: 'omitted', nota: 'Email inválido o ausente' });
      }
      for (const c of toClaim) {
        t.set(c.ref, { ...c.base, estado: 'sending' });
      }
      const deltas = { reserved: toClaim.length };
      if (toOmit.length > 0) deltas.omitted = toOmit.length;
      if (Object.keys(deltas).some(k => deltas[k] !== 0)) {
        const upd = { fecha, updatedAt: Timestamp.now() };
        for (const [k, v] of Object.entries(deltas)) if (v !== 0) upd[k] = FieldValue.increment(v);
        t.set(statsRef(fecha), upd, { merge: true });
      }
      return {
        outcome: 'claimed',
        quota,
        skipped,
        omitted: toOmit.length,
        claimed: toClaim.map(c => ({ ref: c.ref, email: c.base.email, jugadorId: c.base.jugadorId, nombre: c.base.nombre }))
      };
    });
  }

  // Reclamo para reintento de un envío existente (error o pending)
  async function claimRetry({ torneoId, envioId, cfg, fecha, actorUid }) {
    return db.runTransaction(async (t) => {
      const ref = envioRef(torneoId, envioId);
      const snap = await t.get(ref);
      if (!snap.exists) return { outcome: 'not_found' };
      const data = snap.data();
      if (core.isClaimBlocked(data.estado)) {
        return { outcome: 'duplicate', estado: data.estado };
      }
      if (!core.canRetry(data.estado)) {
        return { outcome: 'not_retryable', estado: data.estado };
      }

      const sSnap = await t.get(statsRef(fecha));
      const sData = sSnap.exists ? sSnap.data() : {};
      const quota = core.computeQuota({
        dailyLimit: cfg.dailyLimit,
        sentToday: sData.sent || 0,
        reservedToday: Math.max(0, sData.reserved || 0),
        requested: 1
      });
      if (!quota.allowed) return { outcome: 'quota_blocked', quota };

      const wasPending = data.estado === 'pending';
      t.update(ref, {
        estado: 'sending',
        intentos: (data.intentos || 0) + 1,
        updatedAt: Timestamp.now(),
        ultimoIntentoPor: actorUid || 'sistema',
        nota: null
      });
      const deltas = { reserved: 1 };
      if (wasPending) deltas.pending = -1;
      const upd = { fecha, updatedAt: Timestamp.now() };
      for (const [k, v] of Object.entries(deltas)) if (v !== 0) upd[k] = FieldValue.increment(v);
      t.set(statsRef(fecha), upd, { merge: true });

      return { outcome: 'claimed', quota, data };
    });
  }

  // Envío real a Brevo + registro final. Un error NUNCA queda como sent.
  async function dispatchToBrevo({ cfg, to, subject, htmlContent, tags }) {
    const client = buildBrevoClient();
    const res = await client.transactionalEmails.sendTransacEmail({
      sender: { name: cfg.senderName, email: cfg.senderEmail },
      to: [{ email: to.email, name: to.nombre || undefined }],
      subject,
      htmlContent,
      tags: tags || []
    });
    const messageId = (res && (res.messageId || (res.body && res.body.messageId))) || null;
    return { messageId };
  }

  async function finalizeSent({ torneoId, envioId, fecha, messageId }) {
    await envioRef(torneoId, envioId).update({
      estado: 'sent',
      brevoMessageId: messageId || null,
      error: null,
      updatedAt: Timestamp.now()
    });
    await incrementStats(fecha, { sent: 1, reserved: -1 });
    await incrementHistorico({ totalSent: 1 });
  }

  async function finalizeError({ torneoId, envioId, fecha, errorMessage }) {
    await envioRef(torneoId, envioId).update({
      estado: 'error',
      error: String(errorMessage || 'Error desconocido').slice(0, 500),
      updatedAt: Timestamp.now()
    });
    await incrementStats(fecha, { error: 1, reserved: -1 });
    await incrementHistorico({ totalError: 1 });
  }

  // ── Envío por lotes (usado por pruebas y futuras automatizaciones) ──
  async function sendBatch({ torneoId, tipo, recipients, subject, htmlFor, idSuffix, creadoPor, esPrueba }) {
    if (!torneoId) return { status: 'error', message: 'torneoId es obligatorio.' };
    if (!core.EMAIL_TYPES[tipo]) return { status: 'error', message: `Tipo de correo desconocido: ${tipo}` };
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return { status: 'error', message: 'No hay destinatarios.' };
    }

    const cfg = await getEffectiveConfig(torneoId);
    if (!cfg.globalEnabled) {
      return { status: 'paused', message: 'Sistema de correo pausado (interruptor global en OFF). Ningún correo fue enviado.' };
    }
    if (!esPrueba && !core.isTypeEnabled(cfg, tipo)) {
      return { status: 'tipo_disabled', message: `El tipo de correo "${tipo}" está desactivado en la configuración.` };
    }

    const fecha = fechaDeHoy(cfg);
    const recip = recipients.map(r => ({ ...r, idSuffix: r.idSuffix || idSuffix || '' }));

    const claim = await claimBatch({ torneoId, tipo, recipients: recip, cfg, fecha, subject, creadoPor, esPrueba });

    if (claim.outcome === 'quota_blocked') {
      return {
        status: 'quota_blocked',
        message: claim.quota.message,
        pending: claim.pending,
        omitted: claim.omitted,
        skipped: claim.skipped,
        quota: claim.quota
      };
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const c of claim.claimed) {
      const envioId = c.ref.id || c.ref.path.split('/').pop();
      try {
        const htmlContent = typeof htmlFor === 'function' ? htmlFor(c) : defaultHtml(cfg, subject);
        const { messageId } = await dispatchToBrevo({
          cfg,
          to: c,
          subject,
          htmlContent,
          tags: [tipo, `tid:${torneoId}`]
        });
        await finalizeSent({ torneoId, envioId, fecha, messageId });
        sent++;
      } catch (err) {
        await finalizeError({ torneoId, envioId, fecha, errorMessage: err && err.message });
        failed++;
        errors.push({ email: c.email, error: String(err && err.message).slice(0, 200) });
        console.error(`[email] Error enviando a ${c.email}:`, err && err.message);
      }
    }

    return {
      status: 'processed',
      message: `Procesados: ${claim.claimed.length}. Enviados: ${sent}. Fallidos: ${failed}. Omitidos: ${claim.omitted}. Duplicados/previos: ${claim.skipped.length}.`,
      sent,
      failed,
      omitted: claim.omitted,
      skipped: claim.skipped,
      errors,
      fecha,
      quota: claim.quota
    };
  }

  // ── Reintento seguro de un envío fallido/pendiente ──
  async function retryEnvio({ torneoId, envioId, actorUid, htmlFor }) {
    if (!torneoId || !envioId) return { status: 'error', message: 'torneoId y envioId son obligatorios.' };

    const cfg = await getEffectiveConfig(torneoId);
    if (!cfg.globalEnabled) {
      return { status: 'paused', message: 'Sistema de correo pausado (interruptor global en OFF).' };
    }

    const snap = await envioRef(torneoId, envioId).get();
    if (!snap.exists) return { status: 'error', message: 'El envío no existe.' };
    const data = snap.data();
    if (!core.isTypeEnabled(cfg, data.tipo)) {
      return { status: 'tipo_disabled', message: `El tipo "${data.tipo}" está desactivado.` };
    }
    if (!core.isValidEmail(data.email)) {
      return { status: 'error', message: 'El destinatario no tiene un email válido.' };
    }

    const fecha = fechaDeHoy(cfg);
    const claim = await claimRetry({ torneoId, envioId, cfg, fecha, actorUid });

    if (claim.outcome === 'not_found') return { status: 'error', message: 'El envío no existe.' };
    if (claim.outcome === 'duplicate') return { status: 'duplicate', message: 'Este envío ya fue enviado o está en proceso.' };
    if (claim.outcome === 'not_retryable') return { status: 'error', message: `Estado "${claim.estado}" no es reintentable.` };
    if (claim.outcome === 'quota_blocked') return { status: 'quota_blocked', message: claim.quota.message };

    try {
      const subject = (data.metadata && data.metadata.subject) || 'Torneos Club Tachira';
      const htmlContent = typeof htmlFor === 'function'
        ? htmlFor({ email: data.email, nombre: data.nombre, jugadorId: data.jugadorId })
        : defaultHtml(cfg, subject);
      const { messageId } = await dispatchToBrevo({
        cfg,
        to: { email: data.email, nombre: data.nombre },
        subject,
        htmlContent,
        tags: [data.tipo, `tid:${torneoId}`]
      });
      await finalizeSent({ torneoId, envioId, fecha, messageId });
      return { status: 'sent', message: 'Correo reenviado correctamente.', messageId };
    } catch (err) {
      await finalizeError({ torneoId, envioId, fecha, errorMessage: err && err.message });
      return { status: 'error', message: 'El reintento falló: ' + String(err && err.message).slice(0, 200) };
    }
  }

  // ── Email de prueba (pasa por el mismo pipeline, con esPrueba=true) ──
  // tipo: cualquiera de EMAIL_TYPES. Genera el contenido real del módulo
  // aunque el tipo esté desactivado (para probar antes de activar).
  async function sendTestEmail({ torneoId, toEmail, toNombre, callerUid, tipo, datos }) {
    const t = core.EMAIL_TYPES[tipo] ? tipo : 'prueba';
    const templates = require('./emailTemplates');
    const suffix = String(now()) + '-' + Math.random().toString(36).slice(2, 7);
    const torneoNombre = (datos && datos.torneoNombre) || torneoId;
    let subject;
    let htmlFn;
    if (t === 'bienvenida') {
      subject = `¡Bienvenido a ${torneoNombre}! (prueba)`;
      htmlFn = (r) => templates.welcomeHtml({ nombre: r.nombre, torneoNombre });
    } else if (t === 'estadisticas_diarias') {
      subject = `${torneoNombre} — Resumen del día (prueba)`;
      htmlFn = () => templates.dailyStatsHtml(Object.assign({ torneoNombre }, datos || {}));
    } else if (t !== 'prueba') {
      subject = `Prueba — ${core.EMAIL_TYPES[t].label}`;
      htmlFn = () => templates.previewHtml(core.EMAIL_TYPES[t].label, torneoNombre);
    } else {
      subject = 'Torneos Club Tachira — Email de prueba';
      htmlFn = (r) => testHtml(r.nombre || 'Jugador de prueba');
    }
    return sendBatch({
      torneoId,
      tipo: t,
      recipients: [{ jugadorId: `admin-${callerUid || 'test'}`, email: toEmail, nombre: toNombre, idSuffix: suffix }],
      subject,
      htmlFor: htmlFn,
      creadoPor: callerUid || 'sistema',
      esPrueba: true
    });
  }

  // ── Plantillas ──
  function baseWrapper(cfg, title, bodyHtml) {
    return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:16px;">
      <div style="text-align:center;padding:12px 0;">
        <h1 style="color:#04132b;font-size:1.3rem;margin:0;">${title}</h1>
      </div>
      <div style="background:#f9fafb;border-radius:12px;padding:20px;">${bodyHtml}</div>
      <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:20px;">
        ${cfg.senderName} · Sistema de torneos<br>
        Este es un correo automático, no responder.
      </p>
    </div>`;
  }

  function defaultHtml(cfg, subject) {
    return baseWrapper(cfg, cfg.senderName, `<p>${subject || 'Notificación del torneo'}</p>`);
  }

  function testHtml(nombre) {
    return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:16px;">
      <h2 style="color:#04132b;">Email de prueba</h2>
      <p>Hola ${nombre || 'Administrador'},</p>
      <p>El sistema de correo del torneo está configurado correctamente. Este es un envío de prueba.</p>
      <p style="color:#9ca3af;font-size:12px;">${core.SENDER_DEFAULT.name} · Sistema de torneos</p>
    </div>`;
  }

  // ── Email de bienvenida ──
  async function sendBienvenida({ torneoId, toEmail, toNombre, jugadorId, torneoNombre }) {
    const templates = require('./emailTemplates');
    const suffix = String(now());
    return sendBatch({
      torneoId,
      tipo: 'bienvenida',
      recipients: [{ jugadorId: jugadorId || 'sindato', email: toEmail, nombre: toNombre, idSuffix: suffix }],
      subject: `¡Bienvenido a ${torneoNombre || 'el torneo'}!`,
      htmlFor: (r) => templates.welcomeHtml({ nombre: r.nombre, torneoNombre, jugadorId: r.jugadorId }),
      creadoPor: 'sistema-bienvenida'
    });
  }

  // ── Estadísticas diarias ──
  async function sendDailyStats({ torneoId, torneoNombre, fecha, jugadores, partidos, posiciones, categorias, jornadaNombre }) {
    const templates = require('./emailTemplates');
    const cfg = await getEffectiveConfig(torneoId);

    if (!cfg.globalEnabled) {
      return { status: 'paused', message: 'Sistema pausado.', sent: 0 };
    }
    if (!core.isTypeEnabled(cfg, 'estadisticas_diarias')) {
      return { status: 'tipo_disabled', message: 'Tipo desactivado.', sent: 0 };
    }

    const recip = (jugadores || [])
      .filter(j => core.isValidEmail(j.email))
      .map(j => ({
        jugadorId: j.id || j.jugadorId || String(j.email),
        email: j.email,
        nombre: j.nombre || j.apellidos || '',
        idSuffix: String(now()) + '-' + (j.id || j.email)
      }));

    if (recip.length === 0) {
      return { status: 'no_recipients', message: 'No hay jugadores con email válido.', sent: 0 };
    }

    const fechaStr = fecha || fechaDeHoy(cfg);
    const html = templates.dailyStatsHtml({
      torneoNombre: torneoNombre || torneoId,
      fecha: fechaStr,
      jornadaNombre: jornadaNombre || null,
      partidos: partidos || [],
      posiciones: posiciones || [],
      categorias: categorias || [],
      totalJugadores: (jugadores || []).length,
      totalEquipos: [...new Set((jugadores || []).map(j => j.equipo_id).filter(Boolean))].length
    });

    return sendBatch({
      torneoId,
      tipo: 'estadisticas_diarias',
      recipients: recip,
      subject: `${torneoNombre || 'Torneo'} — Resumen del ${fechaStr}`,
      htmlFor: () => html,
      creadoPor: 'sistema-diario'
    });
  }

  return {
    getGlobalConfig,
    getTorneoConfig,
    getEffectiveConfig,
    getStats,
    getHistory,
    sendBatch,
    retryEnvio,
    sendTestEmail,
    sendBienvenida,
    sendDailyStats,
    fechaDeHoy,
    _internal: { claimBatch, claimRetry, readStatsDoc, incrementStats }
  };
}

module.exports = { buildEmailService, PATH_GLOBAL_CONFIG, COLLECTION_STATS, HISTORICO_ID };
