# Sistema de Correo — Configuración Manual Requerida

> Fase 1 del módulo "Manejo de información por correo electrónico".
> El código está listo, pero **el sistema NO está listo para producción**
> hasta completar estos pasos manuales.

## 1. Secret BREVO_API_KEY (obligatorio antes de desplegar)

El sistema usa la **misma cuenta Brevo** que `tenistac-amistosos`. La API key
se guarda en el Secret Manager del proyecto `torneos-tenis-jdm` (nunca en código):

```bash
cd functions
firebase functions:secrets:set BREVO_API_KEY
# pegar el valor de la API key de la cuenta Brevo existente
```

Solo las funciones `emailSendTest` y `emailRetry` declaran el secret.

## 2. Sender `torneo@tenistac.com` (obligatorio verificar en Brevo)

Remitente estándar del sistema de torneos:

```
"Torneos Club Tachira" <torneo@tenistac.com>
```

⚠️ **`torneo@tenistac.com` DEBE estar autorizado/verificado en la cuenta
Brevo** (Senders & Domains → dominio `tenistac.com` autenticado con
DKIM/SPF, o sender explícito). Si no está verificado, Brevo rechazará los
envíos. No se debe usar `notificaciones@tenistac.com` en este sistema.

No se modifica ninguna configuración externa de Brevo de forma automática.

## 3. Despliegue

```bash
firebase deploy --only functions
firebase deploy --only hosting
firebase deploy --only firestore:rules
```

## 4. Límite diario (300)

`config/emailConfig.dailyLimit = 300` refleja el límite del plan gratuito de
la cuenta Brevo. Ese límite es **de la cuenta completa** y se comparte con
`tenistac-amistosos` y futuros proyectos: el contador de este sistema
registra únicamente el consumo propio ("Consumo registrado por este
sistema"), no el total real de la cuenta. Si se cambia el plan de Brevo,
actualizar `dailyLimit` desde Firestore (o el panel).

## 5. Puesta en marcha

1. El sistema arranca **pausado** (`enabled=false` por defecto).
2. Entrar al panel Admin → pestaña "Más" → **Correos**.
3. Activar el interruptor maestro y enviar un **email de prueba**.
4. Verificar recepción desde `torneo@tenistac.com`.

## Estructura Firestore del módulo

| Path | Uso |
|---|---|
| `config/emailConfig` | Config global: interruptor maestro, dailyLimit, sender, timezone, tipos |
| `torneos/{tid}/configuracion/email` | Overrides por torneo (tipos activos, hora, timezone) |
| `torneos/{tid}/enviosEmail/{id}` | Historial + anti-duplicados (ID determinístico) |
| `emailStats/{YYYY-MM-DD}` | Contadores diarios reales (fuente backend) |
| `emailStats/historico` | Totales históricos |

Estados de envío: `pending → sending → sent | error | omitted`.
Un envío fallido nunca queda como `sent` y puede reintentarse desde el panel.
