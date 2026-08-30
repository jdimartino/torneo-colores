const functions = require('firebase-functions');
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

  if (!callerDoc.exists || callerDoc.data().rol !== ROLES.MASTER) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un usuario MASTER puede crear nuevos usuarios.'
    );
  }

  const { email, password, nombre, rol } = data;

  if (!email || !password || !nombre || !rol) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Email, password, nombre y rol son requeridos.'
    );
  }

  if (rol !== ROLES.FULL && rol !== ROLES.MARCADORES) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Solo se pueden crear usuarios FULL o MARCADORES.'
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
  const callerDoc = await db.collection('usuarios').doc(callerUid).get();

  if (!callerDoc.exists || callerDoc.data().rol !== ROLES.MASTER) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un usuario MASTER puede modificar usuarios.'
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
  const callerDoc = await db.collection('usuarios').doc(callerUid).get();

  if (!callerDoc.exists || callerDoc.data().rol !== ROLES.MASTER) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un usuario MASTER puede eliminar usuarios.'
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
