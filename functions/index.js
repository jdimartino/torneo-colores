const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

const ROLES = {
  MASTER: 'MASTER',
  FULL: 'FULL',
  MARCADORES: 'MARCADORES'
};

/**
 * Creates a new user in Firebase Auth and creates their user document in Firestore.
 * Only callable by a MASTER user.
 *
 * @param {Object} data - { email, password, nombre, rol }
 * @param {Object} context - Firebase functions context
 * @returns {Object} - { success: true, uid: string }
 */
exports.createUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes estar autenticado para crear usuarios.'
    );
  }

  const callerUid = context.auth.uid;
  const callerEmail = context.auth.token.email || '';

  const callerDoc = await db.collection('usuarios').doc(callerUid).get();

  if (!callerDoc.exists || (callerDoc.data().rol !== ROLES.MASTER && callerDoc.data().rol !== ROLES.FULL)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un usuario MASTER o FULL puede crear nuevos usuarios.'
    );
  }

  const { email, password, nombre, rol } = data;

  if (!email || !password || !nombre || !rol) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Email, password, nombre y rol son requeridos.'
    );
  }

  if (rol === ROLES.MASTER || rol === 'MASTER') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'No se pueden crear usuarios MASTER desde el panel. Contactá al administrador principal.'
    );
  }

  if (rol !== ROLES.FULL && rol !== ROLES.MARCADORES && rol !== 'FULL' && rol !== 'MARCADORES' && rol !== 'PENDIENTE') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Solo se pueden crear usuarios FULL, MARCADORES o PENDIENTE.'
    );
  }

  if (password.length < 6) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'La contraseña debe tener al menos 6 caracteres.'
    );
  }

  try {
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: nombre
    });

    const now = admin.firestore.Timestamp.now();

    await db.collection('usuarios').doc(userRecord.uid).set({
      email: email,
      nombre: nombre,
      rol: rol,
      activo: true,
      createdAt: now,
      lastLogin: null
    });

    console.log(`User created: ${email} (${rol}) by ${callerEmail}`);

    return {
      success: true,
      uid: userRecord.uid,
      email: email,
      rol: rol
    };
  } catch (error) {
    console.error('Error creating user:', error);

    if (error.code === 'auth/email-already-exists') {
      throw new functions.https.HttpsError(
        'already-exists',
        'Ya existe un usuario con ese email.'
      );
    }

    throw new functions.https.HttpsError(
      'internal',
      'Error al crear el usuario: ' + error.message
    );
  }
});

/**
 * Updates an existing user's data (except password).
 * Only callable by a MASTER user.
 *
 * @param {Object} data - { uid, nombre, rol, activo }
 * @param {Object} context - Firebase functions context
 */
exports.updateUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes estar autenticado.'
    );
  }

  const callerUid = context.auth.uid;
  const callerEmail = context.auth.token.email || '';
  const callerDoc = await db.collection('usuarios').doc(callerUid).get();

  if (!callerDoc.exists || (callerDoc.data().rol !== ROLES.MASTER && callerDoc.data().rol !== ROLES.FULL)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo usuarios MASTER o FULL pueden modificar usuarios.'
    );
  }

  const { uid, nombre, rol, activo } = data;

  if (!uid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'UID es requerido.'
    );
  }

  const userDoc = await db.collection('usuarios').doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'Usuario no encontrado.'
    );
  }

  const userData = userDoc.data();

  if (userData.rol === ROLES.MASTER) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'No se puede modificar el rol o estado del usuario MASTER.'
    );
  }

  const updateData = {};

  if (typeof nombre === 'string' && nombre.trim()) {
    updateData.nombre = nombre.trim();
  }

  if (rol === ROLES.FULL || rol === ROLES.MARCADORES) {
    updateData.rol = rol;
  }

  if (typeof activo === 'boolean') {
    updateData.activo = activo;
  }

  await db.collection('usuarios').doc(uid).update(updateData);

  console.log(`User updated: ${uid} by ${callerEmail}`);

  return { success: true };
});

/**
 * Deletes a user (soft delete - deactivates).
 * Only callable by a MASTER user.
 * Cannot delete MASTER.
 *
 * @param {Object} data - { uid }
 * @param {Object} context - Firebase functions context
 */
exports.deleteUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes estar autenticado.'
    );
  }

  const callerUid = context.auth.uid;
  const callerEmail = context.auth.token.email || '';
  const callerDoc = await db.collection('usuarios').doc(callerUid).get();

  if (!callerDoc.exists || (callerDoc.data().rol !== ROLES.MASTER && callerDoc.data().rol !== ROLES.FULL)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo usuarios MASTER o FULL pueden eliminar usuarios.'
    );
  }

  const { uid } = data;

  if (!uid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'UID es requerido.'
    );
  }

  const userDoc = await db.collection('usuarios').doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'Usuario no encontrado.'
    );
  }

  const userData = userDoc.data();

  if (userData.rol === ROLES.MASTER) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'No se puede eliminar el usuario MASTER.'
    );
  }

  await db.collection('usuarios').doc(uid).update({ activo: false });

  console.log(`User deactivated: ${uid} by ${callerEmail}`);

  return { success: true };
});

/**
 * Lists all Firebase Auth users and compares with Firestore usuarios collection.
 * Returns which Auth users are missing from Firestore (need import) and vice versa.
 * Only callable by MASTER or FULL users.
 *
 * @param {Object} data - { limit, pageToken }
 * @param {Object} context - Firebase functions context
 */
exports.syncListUsers = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes estar autenticado.'
    );
  }

  const callerUid = context.auth.uid;
  const callerDoc = await db.collection('usuarios').doc(callerUid).get();

  if (!callerDoc.exists || (callerDoc.data().rol !== ROLES.MASTER && callerDoc.data().rol !== ROLES.FULL)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo usuarios MASTER o FULL pueden sincronizar.'
    );
  }

  const { limit = 50, pageToken } = data || {};

  let authResult;
  try {
    authResult = await admin.auth().listUsers(limit, pageToken);
  } catch (e) {
    throw new functions.https.HttpsError(
      'internal',
      'Error al leer lista de usuarios de Auth: ' + e.message
    );
  }

  // Fetch all existing Firestore usuarios
  const firestoreSnapshot = await db.collection('usuarios').get();
  const firestoreUids = new Set(firestoreSnapshot.docs.map(d => d.id));
  const firestoreMap = {};
  firestoreSnapshot.forEach(doc => {
    firestoreMap[doc.id] = doc.data();
  });

  const authUids = new Set(authResult.users.map(u => u.uid));

  // Missing from Firestore (in Auth but not in Firestore)
  const missingFromFirestore = [];
  for (const user of authResult.users) {
    if (!firestoreUids.has(user.uid)) {
      missingFromFirestore.push({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || null,
        createdAt: user.metadata.creationTime ? new Date(user.metadata.creationTime).toISOString() : null,
        lastLoginAt: user.metadata.lastSignInTime ? new Date(user.metadata.lastSignInTime).toISOString() : null,
        disabled: user.disabled
      });
    }
  }

  // Missing from Auth (in Firestore but not in Auth) - potential orphan records
  const missingFromAuth = [];
  for (const uid of firestoreUids) {
    if (!authUids.has(uid)) {
      const fd = firestoreMap[uid];
      missingFromAuth.push({
        uid,
        email: fd?.email,
        nombre: fd?.nombre,
        rol: fd?.rol,
        activo: fd?.activo
      });
    }
  }

  console.log(`Sync check: ${missingFromFirestore.length} missing from Firestore, ${missingFromAuth.length} orphans`);

  return {
    missingFromFirestore,
    missingFromAuth,
    nextPageToken: authResult.pageToken || null,
    totalAuthUsers: authResult.users.length,
    hasMore: !authResult.exhausted
  };
});

/**
 * Imports missing Auth users into Firestore with PENDIENTE role.
 * Bulk import - takes an array of { email, displayName }.
 * Only callable by MASTER or FULL users.
 */
exports.importMissingUsers = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes estar autenticado.'
    );
  }

  const callerUid = context.auth.uid;
  const callerDoc = await db.collection('usuarios').doc(callerUid).get();

  if (!callerDoc.exists || (callerDoc.data().rol !== ROLES.MASTER && callerDoc.data().rol !== ROLES.FULL)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo usuarios MASTER o FULL pueden importar usuarios.'
    );
  }

  const { emails } = data || {};
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Se requiere un array de emails para importar.'
    );
  }

  const now = admin.firestore.Timestamp.now();
  const results = { imported: [], skipped: [], errors: [] };

  for (const email of emails) {
    try {
      // Find user in Auth
      let authUser;
      try {
        authUser = await admin.auth().getUserByEmail(email);
      } catch (e) {
        results.errors.push({ email, reason: 'No encontrado en Auth' });
        continue;
      }

      // Check if already exists in Firestore
      const userDoc = await db.collection('usuarios').doc(authUser.uid).get();
      if (userDoc.exists) {
        results.skipped.push({ email, uid: authUser.uid, reason: 'Ya existe en Firestore' });
        continue;
      }

      // Create Firestore document
      await db.collection('usuarios').doc(authUser.uid).set({
        email: authUser.email,
        nombre: authUser.displayName || authUser.email,
        rol: 'PENDIENTE',
        activo: true,
        createdAt: now,
        lastLogin: null,
        importedViaSync: true,
        syncedAt: now
      });

      results.imported.push({ email, uid: authUser.uid, nombre: authUser.displayName || authUser.email });
    } catch (e) {
      console.error(`Import error for ${email}:`, e);
      results.errors.push({ email, reason: e.message });
    }
  }

  console.log(`Import complete: ${results.imported.length} imported, ${results.skipped.length} skipped, ${results.errors.length} errors`);

  return results;
});

// ═══════════════════════════════════════════════════════════════
// SISTEMA DE CORREO (Cloud Functions v2)
// Infraestructura estándar reutilizable para todos los torneos.
// Proveedor: Brevo (misma cuenta que tenistac-amistosos).
// La API key vive en Secret Manager (BREVO_API_KEY) y NUNCA llega al frontend.
// ═══════════════════════════════════════════════════════════════

const { onCall, HttpsError: HttpsErrorV2 } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { BrevoClient } = require('@getbrevo/brevo');
const { buildEmailService } = require('./emailService');
const emailCore = require('./emailCore');
const { fetchTorneoEmailData } = require('./emailData');

const BREVO_API_KEY = defineSecret('BREVO_API_KEY');

const emailService = buildEmailService({
  db,
  FieldValue,
  Timestamp,
  createBrevo: (apiKey) => new BrevoClient({ apiKey }),
  getApiKey: () => BREVO_API_KEY.value()
});

async function assertEmailAdmin(request) {
  if (!request.auth) {
    throw new HttpsErrorV2('unauthenticated', 'Debes iniciar sesión.');
  }
  const uid = request.auth.uid;
  const userSnap = await db.collection('usuarios').doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() : null;
  const cfgSnap = await db.doc('config/admin').get();
  const legacyAdminUids = cfgSnap.exists ? (cfgSnap.data().adminUids || []) : [];
  const decision = emailCore.decideEmailAccess({ userData, legacyAdminUids, uid });
  if (!decision.ok) {
    const msg = decision.reason === 'cuenta_desactivada'
      ? 'Tu cuenta está desactivada.'
      : 'Solo usuarios MASTER o FULL pueden administrar el correo.';
    throw new HttpsErrorV2('permission-denied', msg);
  }
  return {
    uid,
    rol: decision.rol,
    email: decision.email || request.auth.token.email || '',
    nombre: decision.nombre || request.auth.token.name || ''
  };
}

exports.emailGetStats = onCall(async (request) => {
  await assertEmailAdmin(request);
  const torneoId = (request.data && request.data.torneoId) || null;
  return emailService.getStats(torneoId);
});

exports.emailGetHistory = onCall(async (request) => {
  await assertEmailAdmin(request);
  const { torneoId, limit } = request.data || {};
  if (!torneoId) throw new HttpsErrorV2('invalid-argument', 'torneoId es obligatorio.');
  return emailService.getHistory({ torneoId, limit });
});

exports.emailSendTest = onCall({ secrets: [BREVO_API_KEY] }, async (request) => {
  const adminUser = await assertEmailAdmin(request);
  const { torneoId, toEmail, tipo } = request.data || {};
  if (!torneoId) throw new HttpsErrorV2('invalid-argument', 'torneoId es obligatorio.');
  const destino = (toEmail || '').trim() || adminUser.email;
  if (!destino) {
    throw new HttpsErrorV2('failed-precondition', 'Tu usuario no tiene email registrado.');
  }
  if (!emailCore.isValidEmail(destino)) {
    throw new HttpsErrorV2('invalid-argument', 'El email de destino no es válido.');
  }
  let datos = null;
  if (tipo === 'estadisticas_diarias' || tipo === 'bienvenida') {
    const cfg = await emailService.getEffectiveConfig(torneoId);
    const fechaStr = emailService.fechaDeHoy(cfg);
    if (tipo === 'bienvenida') {
      const torneoSnap = await db.collection('torneosColores').doc(torneoId).get();
      datos = { torneoNombre: torneoSnap.exists ? (torneoSnap.data().name || torneoSnap.data().nombre || torneoId) : torneoId };
    } else {
      datos = await fetchTorneoEmailData(db, torneoId, fechaStr);
    }
  }
  return emailService.sendTestEmail({
    torneoId,
    toEmail: destino,
    toNombre: adminUser.nombre,
    callerUid: adminUser.uid,
    tipo: tipo || 'prueba',
    datos
  });
});

exports.emailRetry = onCall({ secrets: [BREVO_API_KEY] }, async (request) => {
  const adminUser = await assertEmailAdmin(request);
  const { torneoId, envioId } = request.data || {};
  if (!torneoId || !envioId) {
    throw new HttpsErrorV2('invalid-argument', 'torneoId y envioId son obligatorios.');
  }
  return emailService.retryEnvio({ torneoId, envioId, actorUid: adminUser.uid });
});

// ── FASE 2: Email de bienvenida ──
exports.emailSendBienvenida = onCall({ secrets: [BREVO_API_KEY] }, async (request) => {
  const adminUser = await assertEmailAdmin(request);
  const { torneoId, toEmail, toNombre, jugadorId } = request.data || {};
  if (!torneoId) throw new HttpsErrorV2('invalid-argument', 'torneoId es obligatorio.');
  if (!toEmail) throw new HttpsErrorV2('invalid-argument', 'toEmail es obligatorio.');
  const torneoSnap = await db.collection('torneosColores').doc(torneoId).get();
  const torneoNombre = torneoSnap.exists ? (torneoSnap.data().name || torneoSnap.data().nombre || torneoId) : torneoId;
  return emailService.sendBienvenida({ torneoId, toEmail, toNombre, jugadorId, torneoNombre });
});

// ── FASE 2: Estado de estadísticas diarias ──
exports.emailGetDailyStatus = onCall(async (request) => {
  await assertEmailAdmin(request);
  const torneoId = (request.data && request.data.torneoId) || null;
  if (!torneoId) throw new HttpsErrorV2('invalid-argument', 'torneoId es obligatorio.');
  const cfg = await emailService.getEffectiveConfig(torneoId);
  const fecha = emailService.fechaDeHoy(cfg);
  const docSnap = await db.collection('emailStats').doc(`${torneoId}_${fecha}_diario`).get();
  const data = docSnap.exists ? docSnap.data() : null;
  return {
    lastSent: data ? data.timestamp : null,
    lastStatus: data ? data.estado : null,
    lastSentCount: data ? data.sent : 0,
    fecha
  };
});

// ── FASE 2: Estadísticas diarias programadas ──
const { onSchedule } = require('firebase-functions/v2/scheduler');

exports.emailSendDailyStats = onSchedule({ schedule: 'every 1 hours', secrets: [BREVO_API_KEY] }, async () => {
  const torneosSnap = await db.collection('torneosColores').get();
  const results = [];

  for (const torneoDoc of torneosSnap.docs) {
    const tid = torneoDoc.id;
    const torneoData = torneoDoc.data();
    const torneoNombre = torneoData.name || torneoData.nombre || tid;

    try {
      const gSnap = await db.doc('config/emailConfig').get();
      const tSnap = await db.doc(`torneosColores/${tid}/configuracion/email`).get();
      const gCfg = gSnap.exists ? gSnap.data() : null;
      const tCfg = tSnap.exists ? tSnap.data() : null;
      const core = require('./emailCore');
      const eff = core.mergeEmailConfig(gCfg || core.DEFAULT_EMAIL_CONFIG, tCfg);

      if (!eff.globalEnabled) continue;
      if (!core.isTypeEnabled(eff, 'estadisticas_diarias')) continue;

      const now = new Date();
      const tz = eff.timezone || 'America/Caracas';
      const localHour = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
      const localMinute = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: tz, minute: 'numeric' }).format(now), 10);
      const configuredHour = parseInt((eff.horaEstadisticas || '20:00').split(':')[0], 10);
      const configuredMinute = parseInt((eff.horaEstadisticas || '20:00').split(':')[1] || '0', 10);
      if (localHour !== configuredHour || Math.abs(localMinute - configuredMinute) > 15) continue;

      const fechaStr = emailService.fechaDeHoy(eff);

      const statsDoc = await db.collection('emailStats').doc(`${tid}_${fechaStr}_diario`).get();
      if (statsDoc.exists && statsDoc.data().estado === 'sent') continue;

      const datos = await fetchTorneoEmailData(db, tid, fechaStr);

      const result = await emailService.sendDailyStats({
        torneoId: tid,
        torneoNombre,
        fecha: fechaStr,
        jugadores: datos.jugadores,
        partidos: datos.partidos,
        posiciones: datos.posiciones,
        categorias: datos.categorias,
        jornadaNombre: datos.jornadaNombre
      });

      await db.collection('emailStats').doc(`${tid}_${fechaStr}_diario`).set({
        estado: result.status === 'processed' ? 'sent' : result.status,
        sent: result.sent || 0,
        fecha: fechaStr,
        torneoId: tid,
        timestamp: new Date()
      }, { merge: true });

      results.push({ torneoId: tid, ...result });
    } catch (err) {
      console.error(`[email-daily] Error en torneo ${tid}:`, err.message);
      results.push({ torneoId: tid, status: 'error', message: err.message });
    }
  }

  return { results };
});
