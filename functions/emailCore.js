'use strict';

// ═══════════════════════════════════════════════════════════════
// emailCore.js — Lógica pura del sistema de correo (sin dependencias)
// Diseñado como estándar reutilizable para todos los torneos.
// ═══════════════════════════════════════════════════════════════

// Remitente estándar del sistema de torneos.
// IMPORTANTE: torneo@tenistac.com debe estar autorizado/verificado en la
// cuenta Brevo antes de enviar. NO usar notificaciones@tenistac.com.
const SENDER_DEFAULT = {
  name: 'Torneos Club Tachira',
  email: 'torneo@tenistac.com'
};

// Tipos de comunicación. Agregar tipos nuevos aquí NO requiere rehacer el módulo.
const EMAIL_TYPES = {
  prueba: { label: 'Correo de prueba', automatic: false },
  bienvenida: { label: 'Bienvenida al torneo', automatic: true },
  estadisticas_diarias: { label: 'Estadísticas diarias', automatic: true },
  resultados_destacados: { label: 'Resultados destacados', automatic: true },
  recordatorio_partidos: { label: 'Recordatorio de partidos', automatic: true },
  resumen_final: { label: 'Resumen final del torneo', automatic: true }
};

const AUTOMATIC_TYPES = Object.keys(EMAIL_TYPES).filter(t => EMAIL_TYPES[t].automatic);

// Estados posibles de un envío
const ESTADOS = ['pending', 'sending', 'sent', 'error', 'omitted'];

// Configuración global por defecto (config/emailConfig).
// enabled=false por defecto: el sistema arranca pausado hasta que un admin lo active.
const DEFAULT_EMAIL_CONFIG = {
  provider: 'brevo',
  enabled: false,
  dailyLimit: 300,
  senderName: SENDER_DEFAULT.name,
  senderEmail: SENDER_DEFAULT.email,
  timezone: 'America/Caracas',
  tipos: AUTOMATIC_TYPES.reduce((acc, t) => { acc[t] = false; return acc; }, {}),
  horaEstadisticas: '20:00',
  updatedAt: null,
  updatedBy: null
};

// Umbrales visuales de consumo (centralizados, no repetir en frontend)
const QUOTA_LEVELS = { warn: 70, alert: 85, critical: 95 };

function usageLevel(percent) {
  if (percent >= QUOTA_LEVELS.critical) return 'critical';
  if (percent >= QUOTA_LEVELS.alert) return 'alert';
  if (percent >= QUOTA_LEVELS.warn) return 'warn';
  return 'normal';
}

// "Hoy" según la zona horaria configurada (nunca hora del servidor)
function fechaLocal(date, timezone) {
  const tz = timezone || 'America/Caracas';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sanitizeIdPart(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'x';
}

// ID determinístico anti-duplicados: torneoId_tipo_fecha_jugadorId[_sufijo]
function buildEnvioId(torneoId, tipo, fecha, jugadorId, suffix) {
  const parts = [torneoId, tipo, fecha, jugadorId];
  if (suffix) parts.push(suffix);
  return sanitizeIdPart(parts.join('_'));
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Un envío fallido puede reintentarse; uno enviado o en proceso, no.
function canRetry(estado) {
  return estado === 'error' || estado === 'pending';
}

// ¿El estado actual bloquea un nuevo reclamo (anti-duplicado)?
function isClaimBlocked(estado) {
  return estado === 'sent' || estado === 'sending';
}

// Evaluación de cuota. El límite es de la CUENTA Brevo (compartido con otros
// proyectos); este sistema solo conoce su propio consumo registrado.
function computeQuota({ dailyLimit, sentToday = 0, reservedToday = 0, requested = 0 }) {
  const limit = Number(dailyLimit) > 0 ? Number(dailyLimit) : DEFAULT_EMAIL_CONFIG.dailyLimit;
  const available = Math.max(0, limit - sentToday - reservedToday);
  const allowed = requested <= available;
  let message = null;
  if (!allowed) {
    message = `Envío detenido. El límite diario configurado es de ${limit} emails, ` +
      `quedan ${available} disponibles y este envío requiere ${requested}.`;
  }
  return { limit, sentToday, reservedToday, available, requested, allowed, message };
}

// Roles autorizados a administrar el módulo de correo
function canManageEmail(rol) {
  return rol === 'MASTER' || rol === 'FULL';
}

// Decisión pura de acceso (usada por las callables y testeable sin Firebase)
function decideEmailAccess({ userData, legacyAdminUids, uid }) {
  if (userData) {
    if (userData.activo === false) return { ok: false, reason: 'cuenta_desactivada' };
    if (!canManageEmail(userData.rol)) return { ok: false, reason: 'rol_no_autorizado' };
    return { ok: true, rol: userData.rol, email: userData.email || '', nombre: userData.nombre || '' };
  }
  if (Array.isArray(legacyAdminUids) && legacyAdminUids.includes(uid)) {
    return { ok: true, rol: 'FULL', email: '', nombre: '' };
  }
  return { ok: false, reason: 'sin_permisos' };
}

// Mezcla config global + overrides por torneo. El interruptor global tiene
// prioridad absoluta: si global.enabled=false nada se envía.
function mergeEmailConfig(globalCfg, torneoCfg) {
  const g = { ...DEFAULT_EMAIL_CONFIG, ...(globalCfg || {}) };
  const t = torneoCfg || {};
  const tipos = { ...g.tipos };
  if (t.tipos && typeof t.tipos === 'object') {
    for (const k of Object.keys(tipos)) {
      if (typeof t.tipos[k] === 'boolean') tipos[k] = t.tipos[k];
    }
  }
  return {
    enabled: g.enabled === true && t.enabled !== false,
    globalEnabled: g.enabled === true,
    torneoEnabled: t.enabled !== false,
    dailyLimit: Number(t.dailyLimit) > 0 ? Number(t.dailyLimit) : Number(g.dailyLimit),
    senderName: t.senderName || g.senderName || SENDER_DEFAULT.name,
    senderEmail: t.senderEmail || g.senderEmail || SENDER_DEFAULT.email,
    timezone: t.timezone || g.timezone || 'America/Caracas',
    tipos,
    horaEstadisticas: t.horaEstadisticas || g.horaEstadisticas || '20:00',
    provider: 'brevo'
  };
}

// ¿Está activo un tipo de correo según la configuración efectiva?
function isTypeEnabled(effectiveCfg, tipo) {
  if (!effectiveCfg) return false;
  if (tipo === 'prueba') return effectiveCfg.enabled;
  return effectiveCfg.enabled === true && effectiveCfg.tipos[tipo] === true;
}

module.exports = {
  SENDER_DEFAULT,
  EMAIL_TYPES,
  AUTOMATIC_TYPES,
  ESTADOS,
  DEFAULT_EMAIL_CONFIG,
  QUOTA_LEVELS,
  usageLevel,
  fechaLocal,
  sanitizeIdPart,
  buildEnvioId,
  isValidEmail,
  normalizeEmail,
  canRetry,
  isClaimBlocked,
  computeQuota,
  canManageEmail,
  decideEmailAccess,
  mergeEmailConfig,
  isTypeEnabled
};
