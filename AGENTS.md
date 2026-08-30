# Torneo de Colores - Guía de Desarrollo

## Regla Principal: Mobile First

**El 99% de los usuarios acceden desde celular.**

- Siempre desarrollar pensando en la vista móvil primero
- Después adaptar/verificar en desktop
- Todos los componentes, formularios y cards deben verse bien en pantallas de 320px a 428px
- Usar `@media (max-width: 640px)` para ajustes móviles
- Evitar layouts de 2+ columnas en mobile

## Stack

- HTML/CSS/JS vanilla (sin framework)
- Firebase Hosting (despliegue estático)
- Firebase Firestore (base de datos)
- Firebase Auth (autenticación)
- Service Worker (PWA + cache)

## Estructura

```
public/
├── index.html        # Vista pública del torneo (principal para usuarios)
├── admin.html        # Panel de administración
├── css/styles.css    # Estilos globales
├── js/
│   ├── app.js        # Lógica de la vista pública
│   ├── admin.js      # Lógica del panel admin
│   ├── firebase.js   # Configuración de Firebase
│   ├── config.js     # Config secreta (no versionada)
│   ├── tournamentRefs.js  # Referencias de torneos
│   ├── tournament.js      # Lógica de torneos
│   ├── standings.js       # Cálculo de posiciones
│   ├── roundRobin.js      # Lógica de round robin
│   ├── categorias.js      # Categorías de jugadores
│   ├── matchStatus.js     # Estado de partidos
│   └── utils.js           # Utilidades compartidas
├── manifest.json     # PWA manifest
├── sw.js             # Service Worker
└── logo.png          # Icono del torneo
```

## Convenciones

### Archivos versionados
- Los archivos `.js` y `.css` usan `?v=N` para cache busting
- Cuando hagas cambios significativos, incrementar el número de versión

### Config secreta
- `config.js` NO se sube a git (está en `.gitignore`)
- Contiene las credenciales de Firebase
- Se genera manualmente en cada entorno

### Firebase
- Proyecto: `torneos-tenis-jdm`
- Hosting: 1 site (`torneos-tenis-jdm`)
- Firestore: estructura `torneos/{id}/jugadores`, `torneos/{id}/equipos`, etc.

### CSS
- Variables de tema en `:root` (colores, spacing, etc.)
- Estilos base primero, mobile después (`@media (max-width: 640px)`)
- Usar clases utility para flex, spacing, etc.

### JavaScript
- Módulos ES6 (`type="module"`)
- Imports desde CDN de Firebase (`https://www.gstatic.com/firebasejs/`)
- Funciones helper en `utils.js`
- No usar bundlers ni transpilers
