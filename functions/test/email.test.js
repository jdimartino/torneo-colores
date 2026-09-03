'use strict';

// ═══════════════════════════════════════════════════════════════
// Suite de pruebas del sistema de correo (sin emuladores).
// Ejecutar: npm test  (dentro de functions/)
// Usa FakeDb (Firestore en memoria) y FakeBrevo.
// ═══════════════════════════════════════════════════════════════

const assert = require('node:assert');
const core = require('../emailCore');
const { buildEmailService } = require('../emailService');

// ── Fake Firestore ──────────────────────────────────────────────
class FakeDb {
  constructor() {
    this.docs = new Map();
    this._queue = Promise.resolve();
  }

  doc(path) {
    const self = this;
    return {
      path,
      id: path.split('/').pop(),
      get: async () => self._snap(path),
      set: async (data, opts) => self._apply(path, data, !!(opts && opts.merge)),
      update: async (data) => {
        if (!self.docs.has(path)) throw new Error('update: documento inexistente ' + path);
        self._apply(path, data, true);
      }
    };
  }

  collection(path) {
    const self = this;
    const makeQuery = (field, dir, lim) => ({
      orderBy: (f, d) => makeQuery(f, d || 'asc', lim),
      limit: (n) => makeQuery(field, dir, n),
      get: async () => {
        const prefix = path + '/';
        let entries = [...self.docs.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        if (field === '__name__') {
          entries.sort((a, b) => a[0].split('/').pop().localeCompare(b[0].split('/').pop()));
        } else if (field) {
          entries.sort((a, b) => {
            const va = a[1][field]; const vb = b[1][field];
            const ka = va && va.seconds !== undefined ? va.seconds : va;
            const kb = vb && vb.seconds !== undefined ? vb.seconds : vb;
            if (ka === kb) return 0;
            return ka < kb ? -1 : 1;
          });
        }
        if (dir === 'desc') entries.reverse();
        if (lim) entries = entries.slice(0, lim);
        return { docs: entries.map(([p]) => self._snap(p)) };
      }
    });
    return {
      path,
      doc: (id) => self.doc(path + '/' + id),
      orderBy: (f, d) => makeQuery(f, d || 'asc', null),
      limit: (n) => makeQuery(null, null, n),
      get: async () => makeQuery(null, null, null).get()
    };
  }

  _snap(path) {
    const stored = this.docs.get(path);
    const self = this;
    return {
      exists: !!stored,
      id: path.split('/').pop(),
      path,
      ref: self.doc(path),
      data: () => (stored ? { ...stored } : undefined)
    };
  }

  _apply(path, data, merge) {
    const existing = this.docs.get(path) || {};
    const result = merge ? { ...existing } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && v.__inc !== undefined) {
        const base = typeof existing[k] === 'number' ? existing[k] : 0;
        result[k] = base + v.__inc;
      } else {
        result[k] = v;
      }
    }
    this.docs.set(path, result);
  }

  // Transacciones serializadas (emula el comportamiento de Firestore donde
  // dos transacciones concurrentes nunca ven estados inconsistentes).
  async runTransaction(fn) {
    const run = this._queue.then(async () => {
      const writes = [];
      const t = {
        get: async (ref) => ref.get(),
        set: (ref, data, opts) => writes.push({ path: ref.path, data, merge: !!(opts && opts.merge), requireExists: false }),
        update: (ref, data) => writes.push({ path: ref.path, data, merge: true, requireExists: true })
      };
      const result = await fn(t);
      for (const w of writes) {
        if (w.requireExists && !this.docs.has(w.path)) throw new Error('update: documento inexistente ' + w.path);
        this._apply(w.path, w.data, w.merge);
      }
      return result;
    });
    this._queue = run.then(() => {}, () => {});
    return run;
  }
}

const FakeFieldValue = { increment: (n) => ({ __inc: n }) };

function makeFakeTimestamp(getNow) {
  return {
    now: () => {
      const ms = getNow();
      return { seconds: Math.floor(ms / 1000), nanoseconds: 0, toDate() { return new Date(ms); } };
    }
  };
}

// ── Fake Brevo ──────────────────────────────────────────────────
function makeFakeBrevo(state) {
  return (apiKey) => {
    state.apiKeys.push(apiKey);
    return {
      transactionalEmails: {
        sendTransacEmail: async (params) => {
          state.calls.push(params);
          if (state.failAlways || state.failNext) {
            state.failNext = false;
            throw new Error(state.failMessage || 'Brevo rechazó el envío');
          }
          return { messageId: 'brevo-msg-' + state.calls.length };
        }
      }
    };
  };
}

// ── Harness ─────────────────────────────────────────────────────
const TZ = 'America/Caracas';
const TID = 'torneoDemo';

function setup({ enabled = true, dailyLimit = 300, tipos = {}, nowMs } = {}) {
  const db = new FakeDb();
  const brevoState = { calls: [], apiKeys: [], failNext: false, failAlways: false, failMessage: null };
  let fakeNow = nowMs || Date.parse('2026-09-03T15:00:00Z'); // 11:00 Caracas
  const service = buildEmailService({
    db,
    FieldValue: FakeFieldValue,
    Timestamp: makeFakeTimestamp(() => fakeNow),
    createBrevo: makeFakeBrevo(brevoState),
    getApiKey: () => 'FAKE_BREVO_KEY',
    now: () => fakeNow
  });
  db.docs.set('config/emailConfig', {
    ...core.DEFAULT_EMAIL_CONFIG,
    enabled,
    dailyLimit,
    tipos: { ...core.DEFAULT_EMAIL_CONFIG.tipos, ...tipos },
    timezone: TZ
  });
  return {
    db, service, brevoState,
    setNow: (ms) => { fakeNow = ms; },
    getNow: () => fakeNow
  };
}

const recipients2 = [
  { jugadorId: 'jug1', email: 'Ana@Ejemplo.com', nombre: 'Ana Pérez' },
  { jugadorId: 'jug2', email: 'bruno@ejemplo.com', nombre: 'Bruno Díaz' }
];

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.message));
    if (e && e.stack) console.error('    ' + e.stack.split('\n').slice(1, 3).join('\n    '));
  }
}

(async () => {
  console.log('\nemailCore — unidad');

  await test('fechaLocal respeta zona horaria (cambio de día UTC vs Caracas)', () => {
    // 2026-09-04 02:30 UTC = 2026-09-03 22:30 Caracas (UTC-4)
    assert.strictEqual(core.fechaLocal(new Date('2026-09-04T02:30:00Z'), TZ), '2026-09-03');
    // 2026-09-04 05:00 UTC = 2026-09-04 01:00 Caracas
    assert.strictEqual(core.fechaLocal(new Date('2026-09-04T05:00:00Z'), TZ), '2026-09-04');
  });

  await test('buildEnvioId es determinístico y sanitario', () => {
    const a = core.buildEnvioId('Torneo Uno', 'bienvenida', '2026-09-03', 'Jugador #5');
    const b = core.buildEnvioId('Torneo Uno', 'bienvenida', '2026-09-03', 'Jugador #5');
    assert.strictEqual(a, b);
    assert.ok(/^[a-z0-9-]+$/.test(a), 'id debe ser seguro para Firestore: ' + a);
  });

  await test('computeQuota bloquea y genera mensaje claro', () => {
    const q = core.computeQuota({ dailyLimit: 300, sentToday: 248, requested: 74 });
    assert.strictEqual(q.allowed, false);
    assert.ok(q.message.includes('Envío detenido'));
    assert.ok(q.message.includes('300') && q.message.includes('52') && q.message.includes('74'));
    const ok = core.computeQuota({ dailyLimit: 300, sentToday: 10, requested: 20 });
    assert.strictEqual(ok.allowed, true);
    assert.strictEqual(ok.available, 290);
  });

  await test('usageLevel centraliza umbrales', () => {
    assert.strictEqual(core.usageLevel(10), 'normal');
    assert.strictEqual(core.usageLevel(70), 'warn');
    assert.strictEqual(core.usageLevel(85), 'alert');
    assert.strictEqual(core.usageLevel(95), 'critical');
  });

  await test('mergeEmailConfig: pausa global tiene prioridad absoluta', () => {
    const eff = core.mergeEmailConfig({ enabled: false }, { enabled: true, tipos: { bienvenida: true } });
    assert.strictEqual(eff.enabled, false);
    assert.strictEqual(eff.tipos.bienvenida, true);
    const eff2 = core.mergeEmailConfig({ enabled: true, dailyLimit: 300 }, { enabled: false });
    assert.strictEqual(eff2.enabled, false);
  });

  await test('permisos: MASTER/FULL autorizados; MARCADORES y otros no', () => {
    assert.strictEqual(core.canManageEmail('MASTER'), true);
    assert.strictEqual(core.canManageEmail('FULL'), true);
    assert.strictEqual(core.canManageEmail('MARCADORES'), false);
    assert.strictEqual(core.canManageEmail(undefined), false);
    assert.strictEqual(core.decideEmailAccess({ userData: { rol: 'MARCADORES', activo: true }, legacyAdminUids: [], uid: 'u1' }).ok, false);
    assert.strictEqual(core.decideEmailAccess({ userData: { rol: 'FULL', activo: true, email: 'a@b.c' }, legacyAdminUids: [], uid: 'u1' }).ok, true);
    assert.strictEqual(core.decideEmailAccess({ userData: { rol: 'MASTER', activo: false }, legacyAdminUids: [], uid: 'u1' }).ok, false);
    assert.strictEqual(core.decideEmailAccess({ userData: null, legacyAdminUids: ['legacy1'], uid: 'legacy1' }).ok, true);
    assert.strictEqual(core.decideEmailAccess({ userData: null, legacyAdminUids: [], uid: 'x' }).ok, false);
  });

  console.log('\nemailService — integración con fakes');

  await test('1. envío de prueba exitoso usa el sender estándar', async () => {
    const { service, brevoState, db } = setup();
    const res = await service.sendTestEmail({ torneoId: TID, toEmail: 'admin@club.com', toNombre: 'Admin', callerUid: 'uid1' });
    assert.strictEqual(res.status, 'processed');
    assert.strictEqual(res.sent, 1);
    assert.strictEqual(brevoState.calls.length, 1);
    const call = brevoState.calls[0];
    assert.strictEqual(call.sender.name, 'Torneos Club Tachira');
    assert.strictEqual(call.sender.email, 'torneo@tenistac.com');
    assert.strictEqual(call.to[0].email, 'admin@club.com');
    const docs = [...db.docs.entries()].filter(([p]) => p.includes('/enviosEmail/'));
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0][1].estado, 'sent');
    assert.strictEqual(docs[0][1].brevoMessageId, 'brevo-msg-1');
    const hist = db.docs.get('emailStats/historico');
    assert.strictEqual(hist.totalSent, 1);
  });

  await test('2. sistema global pausado: no se envía nada', async () => {
    const { service, brevoState, db } = setup({ enabled: false });
    const res = await service.sendTestEmail({ torneoId: TID, toEmail: 'admin@club.com', callerUid: 'uid1' });
    assert.strictEqual(res.status, 'paused');
    assert.strictEqual(brevoState.calls.length, 0);
    const docs = [...db.docs.keys()].filter(p => p.includes('/enviosEmail/'));
    assert.strictEqual(docs.length, 0);
  });

  await test('3. tipo de correo desactivado: no se envía', async () => {
    const { service, brevoState } = setup({ enabled: true, tipos: { bienvenida: false } });
    const res = await service.sendBatch({
      torneoId: TID, tipo: 'bienvenida',
      recipients: recipients2, subject: 'Bienvenida'
    });
    assert.strictEqual(res.status, 'tipo_disabled');
    assert.strictEqual(brevoState.calls.length, 0);
  });

  await test('4. límite diario alcanzado: bloqueo total, quedan pending', async () => {
    const { service, brevoState, db } = setup({ dailyLimit: 2 });
    db.docs.set('emailStats/2026-09-03', { fecha: '2026-09-03', sent: 2 });
    const res = await service.sendBatch({
      torneoId: TID, tipo: 'prueba',
      recipients: recipients2, subject: 'x'
    });
    assert.strictEqual(res.status, 'quota_blocked');
    assert.ok(res.message.includes('Envío detenido'));
    assert.strictEqual(brevoState.calls.length, 0, 'Brevo no debe ser llamado');
    const pendingDocs = [...db.docs.entries()].filter(([p]) => p.includes('/enviosEmail/') && p.includes('2026-09-03'));
    assert.strictEqual(pendingDocs.length, 2);
    assert.ok(pendingDocs.every(([, d]) => d.estado === 'pending'));
  });

  await test('5. envío fallido queda en error (nunca sent)', async () => {
    const { service, brevoState, db } = setup();
    brevoState.failAlways = true;
    brevoState.failMessage = 'sender no verificado';
    const res = await service.sendBatch({
      torneoId: TID, tipo: 'prueba',
      recipients: [{ jugadorId: 'j1', email: 'a@b.com', nombre: 'A' }], subject: 'x'
    });
    assert.strictEqual(res.status, 'processed');
    assert.strictEqual(res.sent, 0);
    assert.strictEqual(res.failed, 1);
    const doc = [...db.docs.entries()].find(([p]) => p.includes('/enviosEmail/'))[1];
    assert.strictEqual(doc.estado, 'error');
    assert.ok(doc.error.includes('sender no verificado'));
    assert.strictEqual(doc.brevoMessageId, null);
    const stats = db.docs.get('emailStats/2026-09-03');
    assert.strictEqual(stats.error, 1);
    assert.ok(!stats.sent, 'un envío fallido no puede incrementar sent');
  });

  await test('6. retry después de error termina en sent', async () => {
    const { service, brevoState, db } = setup();
    brevoState.failNext = true;
    await service.sendBatch({
      torneoId: TID, tipo: 'prueba',
      recipients: [{ jugadorId: 'j1', email: 'a@b.com', nombre: 'A' }], subject: 'x'
    });
    const envioId = [...db.docs.keys()].find(p => p.includes('/enviosEmail/')).split('/').pop();
    const res = await service.retryEnvio({ torneoId: TID, envioId, actorUid: 'uid1' });
    assert.strictEqual(res.status, 'sent');
    const doc = db.docs.get(`torneos/${TID}/enviosEmail/${envioId}`);
    assert.strictEqual(doc.estado, 'sent');
    assert.strictEqual(doc.intentos, 2);
    const stats = db.docs.get('emailStats/2026-09-03');
    assert.strictEqual(stats.sent, 1);
    assert.strictEqual(stats.reserved, 0);
  });

  await test('7. anti-duplicado: mismo evento dos veces no reenvía', async () => {
    const { service, brevoState } = setup();
    const opts = {
      torneoId: TID, tipo: 'prueba',
      recipients: [{ jugadorId: 'j1', email: 'a@b.com', nombre: 'A' }], subject: 'x'
    };
    const r1 = await service.sendBatch(opts);
    const r2 = await service.sendBatch(opts);
    assert.strictEqual(r1.sent, 1);
    assert.strictEqual(r2.sent, 0);
    assert.strictEqual(r2.skipped.length, 1);
    assert.strictEqual(r2.skipped[0].razon, 'ya_enviado');
    assert.strictEqual(brevoState.calls.length, 1, 'Brevo debe recibir el correo una sola vez');
  });

  await test('8. dos ejecuciones simultáneas del mismo envío: solo una gana', async () => {
    const { service, brevoState } = setup();
    const opts = {
      torneoId: TID, tipo: 'prueba',
      recipients: [{ jugadorId: 'j1', email: 'a@b.com', nombre: 'A' }], subject: 'x'
    };
    const [ra, rb] = await Promise.all([service.sendBatch(opts), service.sendBatch(opts)]);
    const totalSent = ra.sent + rb.sent;
    assert.strictEqual(totalSent, 1, 'exactamente una ejecución debe enviar');
    assert.strictEqual(brevoState.calls.length, 1);
  });

  await test('9. contador diario (fuente backend) tras varios envíos', async () => {
    const { service } = setup({ dailyLimit: 10 });
    await service.sendBatch({
      torneoId: TID, tipo: 'prueba', recipients: recipients2, subject: 'x', idSuffix: 'a'
    });
    const stats = await service.getStats(TID);
    assert.strictEqual(stats.hoy.sent, 2);
    assert.strictEqual(stats.disponibles, 8);
    assert.strictEqual(stats.dailyLimit, 10);
    assert.strictEqual(stats.porcentaje, 20);
    assert.strictEqual(stats.nivel, 'normal');
    assert.ok(stats.nota.includes('Consumo registrado por este sistema'));
  });

  await test('10. cambio de día: contadores y envíos separados por fecha', async () => {
    const { service, db, setNow } = setup();
    await service.sendBatch({
      torneoId: TID, tipo: 'prueba',
      recipients: [{ jugadorId: 'j1', email: 'a@b.com', nombre: 'A' }], subject: 'x'
    });
    // Avanzar al día siguiente en Caracas (2026-09-04 12:00 local)
    setNow(Date.parse('2026-09-04T16:00:00Z'));
    const stats = await service.getStats(TID);
    assert.strictEqual(stats.fecha, '2026-09-04');
    assert.strictEqual(stats.hoy.sent, 0, 'hoy nuevo empieza en cero');
    assert.strictEqual(stats.ayer.sent, 1, 'ayer debe reflejar el envío previo');
    assert.strictEqual(db.docs.get('emailStats/historico').totalSent, 1);
  });

  await test('11/12. permisos (decisión de acceso)', () => {
    assert.strictEqual(core.decideEmailAccess({ userData: { rol: 'MASTER', activo: true }, legacyAdminUids: [], uid: 'm' }).ok, true);
    assert.strictEqual(core.decideEmailAccess({ userData: { rol: 'FULL', activo: true }, legacyAdminUids: [], uid: 'f' }).ok, true);
    const d = core.decideEmailAccess({ userData: { rol: 'MARCADORES', activo: true }, legacyAdminUids: [], uid: 'x' });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.reason, 'rol_no_autorizado');
  });

  await test('email inválido o ausente queda omitted (sin llamar Brevo)', async () => {
    const { service, brevoState, db } = setup();
    const res = await service.sendBatch({
      torneoId: TID, tipo: 'prueba',
      recipients: [
        { jugadorId: 'j1', email: '', nombre: 'Sin Email' },
        { jugadorId: 'j2', email: 'no-es-email', nombre: 'Inválido' }
      ],
      subject: 'x'
    });
    assert.strictEqual(res.status, 'processed');
    assert.strictEqual(res.omitted, 2);
    assert.strictEqual(brevoState.calls.length, 0);
    const omitted = [...db.docs.entries()].filter(([p]) => p.includes('/enviosEmail/'));
    assert.strictEqual(omitted.length, 2);
    assert.ok(omitted.every(([, d]) => d.estado === 'omitted'));
  });

  await test('pausa global bloquea también el reintento', async () => {
    const { service, db } = setup();
    await service.sendBatch({
      torneoId: TID, tipo: 'prueba',
      recipients: [{ jugadorId: 'j1', email: 'a@b.com', nombre: 'A' }], subject: 'x'
    });
    const envioId = [...db.docs.keys()].find(p => p.includes('/enviosEmail/')).split('/').pop();
    db.docs.get(`torneos/${TID}/enviosEmail/${envioId}`).estado = 'error';
    db.docs.set('config/emailConfig', { ...db.docs.get('config/emailConfig'), enabled: false });
    const res = await service.retryEnvio({ torneoId: TID, envioId, actorUid: 'uid1' });
    assert.strictEqual(res.status, 'paused');
  });

  await test('getHistory devuelve últimos envíos ordenados', async () => {
    const { service } = setup();
    await service.sendBatch({
      torneoId: TID, tipo: 'prueba', recipients: recipients2, subject: 'x', idSuffix: 'h'
    });
    const hist = await service.getHistory({ torneoId: TID, limit: 10 });
    assert.strictEqual(hist.length, 2);
    assert.ok(hist.every(h => h.estado === 'sent' && h.email && h.tipo === 'prueba'));
  });

  await test('config por torneo puede desactivar tipos aunque global esté ON', async () => {
    const { service, db, brevoState } = setup({ tipos: { bienvenida: true } });
    db.docs.set(`torneos/${TID}/configuracion/email`, { tipos: { bienvenida: false } });
    const res = await service.sendBatch({
      torneoId: TID, tipo: 'bienvenida', recipients: recipients2, subject: 'x'
    });
    assert.strictEqual(res.status, 'tipo_disabled');
    assert.strictEqual(brevoState.calls.length, 0);
  });

  await test('prueba bienvenida envía torneoNombre real y Jugador de prueba', async () => {
    const { service, brevoState } = setup();
    const res = await service.sendTestEmail({
      torneoId: TID, toEmail: 'destino@custom.com', callerUid: 'u1', tipo: 'bienvenida',
      datos: { torneoNombre: 'Torneo Real 2026' }
    });
    assert.strictEqual(res.status, 'processed');
    assert.strictEqual(res.sent, 1);
    assert.ok(brevoState.calls[0].htmlContent.includes('Torneo Real 2026'));
  });

  await test('esPrueba: prueba de módulo con tipo desactivado se envía', async () => {
    const { service, brevoState, db } = setup({ tipos: { bienvenida: false } });
    const res = await service.sendTestEmail({
      torneoId: TID, toEmail: 'destino@custom.com', toNombre: 'Destino', callerUid: 'u1', tipo: 'bienvenida'
    });
    assert.strictEqual(res.status, 'processed');
    assert.strictEqual(res.sent, 1);
    assert.strictEqual(brevoState.calls.length, 1);
    assert.ok(brevoState.calls[0].htmlContent.includes('Bienvenido'), 'debe usar la plantilla de bienvenida');
    assert.ok(brevoState.calls[0].subject.includes('prueba'));
    const doc = [...db.docs.entries()].find(([p]) => p.includes('/enviosEmail/'))[1];
    assert.strictEqual(doc.tipo, 'bienvenida');
    assert.strictEqual(doc.nota, 'Email de prueba');
    assert.strictEqual(doc.metadata.prueba, true);
  });

  await test('esPrueba con master OFF: paused y Brevo nunca llamado', async () => {
    const { service, brevoState } = setup({ enabled: false });
    const res = await service.sendTestEmail({
      torneoId: TID, toEmail: 'destino@custom.com', callerUid: 'u1', tipo: 'estadisticas_diarias'
    });
    assert.strictEqual(res.status, 'paused');
    assert.strictEqual(brevoState.calls.length, 0);
  });

  await test('sendTestEmail con destino custom llega a ese email', async () => {
    const { service, brevoState } = setup();
    const res = await service.sendTestEmail({
      torneoId: TID, toEmail: 'Otro@Destino.com', callerUid: 'u1', tipo: 'prueba'
    });
    assert.strictEqual(res.status, 'processed');
    assert.strictEqual(brevoState.calls[0].to[0].email, 'otro@destino.com');
  });

  console.log(`\nResultado: ${passed} OK, ${failed} FAIL\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
