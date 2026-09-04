export const ROLES = {
  MASTER: 'MASTER',
  FULL: 'FULL',
  MARCADORES: 'MARCADORES'
};

export const ROL_LABELS = {
  MASTER: { name: 'Administrador Maestro', short: 'MASTER', description: 'Control total del sistema' },
  FULL: { name: 'Administrador', short: 'FULL', description: 'Administración completa del torneo' },
  MARCADORES: { name: 'Marcadores', short: 'MARCADORES', description: 'Solo resultados y marcadores' }
};

const MODULOS = {
  usuarios: {
    label: 'Usuarios',
    icon: 'manage_accounts',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  jugadores: {
    label: 'Jugadores',
    icon: 'groups',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  equipos: {
    label: 'Equipos',
    icon: 'palette',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  draw: {
    label: 'DRAW',
    icon: 'sports_tennis',
    read: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  resultados: {
    label: 'Resultados',
    icon: 'sports_score',
    read: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES],
    write: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES]
  },
  posiciones: {
    label: 'Posiciones',
    icon: 'leaderboard',
    read: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES],
    write: []
  },
  jornadas: {
    label: 'Jornadas',
    icon: 'event',
    read: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  semifinales: {
    label: 'Semifinales',
    icon: 'emoji_events',
    read: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES],
    write: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES]
  },
  final: {
    label: 'Final',
    icon: 'workspace_premium',
    read: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES],
    write: [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES]
  },
  torneos: {
    label: 'Torneos',
    icon: 'settings',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  administracion: {
    label: 'Administración',
    icon: 'account_balance_wallet',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  categorias: {
    label: 'Categorías',
    icon: 'sell',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  correos: {
    label: 'Correo Electrónico',
    icon: 'email',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  },
  reportes: {
    label: 'Reportes',
    icon: 'monitoring',
    read: [ROLES.MASTER, ROLES.FULL],
    write: [ROLES.MASTER, ROLES.FULL]
  }
};

let _currentUser = null;

export function setCurrentUser(user) {
  _currentUser = user;
}

export function getCurrentUser() {
  return _currentUser;
}

export function getCurrentUserRole() {
  return _currentUser?.rol || null;
}

export function isMaster() {
  return getCurrentUserRole() === ROLES.MASTER;
}

export function isFull() {
  return getCurrentUserRole() === ROLES.FULL;
}

export function isMarcadores() {
  return getCurrentUserRole() === ROLES.MARCADORES;
}

export function canRead(modulo) {
  if (!_currentUser) return false;
  const config = MODULOS[modulo];
  if (!config) return false;
  return config.read.includes(_currentUser.rol);
}

export function canWrite(modulo) {
  if (!_currentUser) return false;
  const config = MODULOS[modulo];
  if (!config) return false;
  return config.write.includes(_currentUser.rol);
}

export function getVisibleModules() {
  if (!_currentUser) return [];
  return Object.entries(MODULOS)
    .filter(([key, config]) => config.read.includes(_currentUser.rol))
    .map(([key, config]) => ({ id: key, ...config }));
}

