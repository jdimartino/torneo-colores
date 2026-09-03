// ═══════════════════════════════════════════════════════════════
// Módulo "Manejo de información por correo electrónico"
// - La API key de Brevo NUNCA toca el frontend: todo pasa por callables.
// - El contador diario tiene como fuente de verdad al backend.
// - Configuración: config/emailConfig (global) y
//   torneos/{tid}/configuracion/email (por torneo).
// ═══════════════════════════════════════════════════════════════

import { db, functions, auth } from './firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { getActiveTournamentId, getActiveTournament } from './tournamentRefs.js';

const EMAIL_TYPES = [
    { id: 'bienvenida', label: 'Bienvenida al torneo', desc: 'Correo automático al inscribir un jugador. Automatización en Fase 2.' },
    { id: 'estadisticas_diarias', label: 'Estadísticas diarias', desc: 'Resumen del día: partidos, resultados y posiciones. Automatización en Fase 2.' },
    { id: 'resultados_destacados', label: 'Resultados destacados', desc: 'Próximamente.' },
    { id: 'recordatorio_partidos', label: 'Recordatorio de partidos', desc: 'Próximamente.' },
    { id: 'resumen_final', label: 'Resumen final del torneo', desc: 'Próximamente.' }
];

const TIMEZONES = [
    { id: 'America/Caracas', label: 'America/Caracas (Venezuela)' },
    { id: 'America/Bogota', label: 'America/Bogotá' },
    { id: 'America/New_York', label: 'America/New_York' },
    { id: 'Europe/Madrid', label: 'Europe/Madrid' },
    { id: 'UTC', label: 'UTC' }
];

let _globalCfg = null;
let _torneoCfg = null;
let _stats = null;
let _history = null;
let _statsError = null;
let _dailyStatus = null;
let _busy = false;

function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function toast(msg, type) {
    if (typeof window.toast === 'function') window.toast(msg, type);
}

function showLoading(msg) { if (typeof window.showLoading === 'function') window.showLoading(msg); }
function hideLoading() { if (typeof window.hideLoading === 'function') window.hideLoading(); }

async function callFn(name, data) {
    const fn = httpsCallable(functions, name);
    const res = await fn(data || {});
    return res.data;
}

function globalConfigRef() { return doc(db, 'config', 'emailConfig'); }
function torneoConfigRef(tid) { return doc(db, 'torneos', tid, 'configuracion', 'email'); }

function defaultGlobalConfig() {
    return {
        provider: 'brevo',
        enabled: false,
        senderName: 'Torneos Club Tachira',
        senderEmail: 'torneo@tenistac.com',
        timezone: 'America/Caracas',
        tipos: {
            bienvenida: false,
            estadisticas_diarias: false,
            resultados_destacados: false,
            recordatorio_partidos: false,
            resumen_final: false
        },
        horaEstadisticas: '20:00',
        updatedAt: new Date(),
        updatedBy: auth.currentUser ? auth.currentUser.uid : null
    };
}

function tipoEfectivo(tipo) {
    const t = (_torneoCfg && _torneoCfg.tipos) || {};
    const g = (_globalCfg && _globalCfg.tipos) || {};
    if (typeof t[tipo] === 'boolean') return t[tipo];
    return g[tipo] === true;
}

function torneoHabilitado() {
    return !_torneoCfg || _torneoCfg.enabled !== false;
}

function sistemaActivo() {
    return !!(_globalCfg && _globalCfg.enabled === true) && torneoHabilitado();
}

async function loadData(tid) {
    _statsError = null;
    try {
        const gSnap = await getDoc(globalConfigRef());
        _globalCfg = gSnap.exists() ? gSnap.data() : null;
    } catch (e) {
        console.error('[correos] Error leyendo config global:', e);
        _globalCfg = null;
    }
    try {
        const tSnap = await getDoc(torneoConfigRef(tid));
        _torneoCfg = tSnap.exists() ? tSnap.data() : null;
    } catch (e) {
        console.error('[correos] Error leyendo config del torneo:', e);
        _torneoCfg = null;
    }
    const results = await Promise.allSettled([
        callFn('emailGetStats', { torneoId: tid }),
        callFn('emailGetHistory', { torneoId: tid, limit: 50 }),
        callFn('emailGetDailyStatus', { torneoId: tid })
    ]);
    if (results[0].status === 'fulfilled') { _stats = results[0].value; }
    else { _stats = null; _statsError = fnErrorMessage(results[0].reason); }
    _history = results[1].status === 'fulfilled' ? results[1].value : [];
    _dailyStatus = results[2].status === 'fulfilled' ? results[2].value : null;
}

function fnErrorMessage(err) {
    const msg = (err && err.message) || 'Error';
    if (msg.includes('emailGetStats is not defined') || msg.includes('NOT_FOUND')) {
        return 'Cloud Functions sin desplegar. Ejecutá: firebase deploy --only functions';
    }
    if (msg.includes('permission-denied')) return 'Sin permisos para este módulo.';
    return msg;
}

async function saveGlobalConfig(patch) {
    const base = _globalCfg || defaultGlobalConfig();
    await setDoc(globalConfigRef(), {
        ...base,
        ...patch,
        updatedAt: new Date(),
        updatedBy: auth.currentUser ? auth.currentUser.uid : null
    }, { merge: true });
    _globalCfg = { ...base, ...patch };
}

async function saveTorneoConfig(patch) {
    const tid = getActiveTournamentId();
    await setDoc(torneoConfigRef(tid), {
        ...patch,
        updatedAt: new Date(),
        updatedBy: auth.currentUser ? auth.currentUser.uid : null
    }, { merge: true });
    _torneoCfg = { ...(_torneoCfg || {}), ...patch };
}

// ── Render ──────────────────────────────────────────────────────
export async function renderCorreos() {
    const panel = document.getElementById('panel-correos');
    if (!panel) return;
    const tid = getActiveTournamentId();
    if (!tid) return;

    panel.innerHTML = '<div class="empty-state" style="padding:2rem;"><p>Cargando módulo de correo...</p></div>';
    await loadData(tid);
    const t = getActiveTournament();
    const torneoNombre = t ? (t.name || t.nombre || tid) : tid;

    const activo = sistemaActivo();
    const globalOn = !!(_globalCfg && _globalCfg.enabled === true);

    let html = '';

    html += '<div class="admin-section-title">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;">email</span> Manejo de información por correo electrónico' +
        '</div>' +
        '<p style="font-size:0.72rem;color:var(--on-surface-variant-40);margin:-0.4rem 0 0.75rem;">' +
        'Torneo activo: <strong>' + esc(torneoNombre) + '</strong></p>';

    // ── Estado global ──
    html += '<div class="card">' +
        '<div class="email-status-row">' +
        '<div>' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;">Estado global del sistema</div>' +
        '<div class="email-status-badge ' + (activo ? 'on' : 'off') + '">' +
        '<span class="dot"></span> ' + (activo ? 'ACTIVO' : 'PAUSADO') + '</div>' +
        '</div>' +
        '<label class="email-switch" title="Interruptor maestro">' +
        '<input type="checkbox" id="email-global-toggle" ' + (globalOn ? 'checked' : '') + '>' +
        '<span class="email-switch-track"></span>' +
        '</label>' +
        '</div>' +
        '<p class="email-note">El interruptor maestro tiene prioridad absoluta: si está en OFF, ningún correo se envía aunque los tipos estén activados.</p>' +
        (!globalOn ? '<div class="email-banner-paused"><span class="material-symbols-outlined" style="font-size:0.95rem;">pause_circle</span> Todos los envíos están pausados.</div>' : '') +
        '</div>';

    // ── Consumo de Brevo ──
    html += renderStatsCard();

    // ── Estado de envíos automáticos ──
    html += renderDailyStatusCard();

    // ── Configuración del torneo ──
    html += '<div class="card">' +
        '<div class="admin-section-title" style="margin-top:0;"><span class="material-symbols-outlined" style="font-size:0.85rem;">tune</span> Configuración de este torneo</div>' +
        '<div class="email-status-row" style="margin-bottom:0.6rem;">' +
        '<div><div style="font-size:0.82rem;font-weight:600;">Envíos en este torneo</div>' +
        '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);">Interruptor del torneo activo</div></div>' +
        '<label class="email-switch"><input type="checkbox" id="email-torneo-toggle" ' + (torneoHabilitado() ? 'checked' : '') + '><span class="email-switch-track"></span></label>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Hora estadísticas diarias</label>' +
        '<input type="time" id="email-hora" value="' + esc(horaEfectiva()) + '"></div>' +
        '<div class="form-group"><label>Zona horaria</label>' +
        '<select id="email-tz">' +
        TIMEZONES.map(z => '<option value="' + z.id + '"' + (tzEfectiva() === z.id ? ' selected' : '') + '>' + z.label + '</option>').join('') +
        '</select></div>' +
        '</div>' +
        '<button class="btn btn-outline btn-sm" id="email-save-torneo"><span class="material-symbols-outlined" style="font-size:0.9rem;">save</span> Guardar configuración del torneo</button>' +
        '</div>';

    // ── Tipos de comunicación ──
    html += '<div class="card">' +
        '<div class="admin-section-title" style="margin-top:0;"><span class="material-symbols-outlined" style="font-size:0.85rem;">campaign</span> Comunicaciones automáticas</div>' +
        '<div class="form-group" style="margin-bottom:0.6rem;"><label>Email destino de pruebas</label>' +
        '<input type="email" id="email-test-destino" placeholder="correo@destino.com" value="' + esc(destinoDefault()) + '">' +
        '<div style="font-size:0.64rem;color:var(--on-surface-variant-40);margin-top:0.2rem;">Todas las pruebas de módulo llegan a este correo. No afecta los envíos reales.</div></div>' +
        EMAIL_TYPES.map(tp => {
            const on = tipoEfectivo(tp.id);
            return '<div class="email-type-row">' +
                '<div class="email-type-info">' +
                '<div style="font-size:0.84rem;font-weight:600;">' + tp.label + '</div>' +
                '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + tp.desc + '</div>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:0.5rem;flex-shrink:0;">' +
                '<button class="btn btn-outline btn-sm email-test-tipo-btn" data-email-test-tipo="' + tp.id + '" title="Enviar prueba de ' + esc(tp.label) + '"><span class="material-symbols-outlined" style="font-size:0.85rem;">send</span></button>' +
                '<label class="email-switch"><input type="checkbox" data-email-tipo="' + tp.id + '" ' + (on ? 'checked' : '') + '><span class="email-switch-track"></span></label>' +
                '</div>' +
                '</div>';
        }).join('') +
        '<p class="email-note">El botón de prueba funciona aunque el tipo esté apagado (requiere interruptor maestro ON). Los cambios aplican al torneo activo.</p>' +
        '</div>';

    // ── Historial ──
    // ── Historial ──
    html += '<div class="card">' +
        '<div class="admin-section-title" style="margin-top:0;"><span class="material-symbols-outlined" style="font-size:0.85rem;">history</span> Historial de envíos</div>' +
        renderHistory() +
        '</div>';

    panel.innerHTML = html;
    bindEvents(tid);
}

function horaEfectiva() {
    return (_torneoCfg && _torneoCfg.horaEstadisticas) || (_globalCfg && _globalCfg.horaEstadisticas) || '20:00';
}

function tzEfectiva() {
    return (_torneoCfg && _torneoCfg.timezone) || (_globalCfg && _globalCfg.timezone) || 'America/Caracas';
}

function destinoDefault() {
    return 'dimartinoj@gmail.com';
}

function destinoDePrueba() {
    const el = document.getElementById('email-test-destino');
    const val = ((el && el.value) || '').trim();
    return val || destinoDefault();
}

function senderLabel() {
    const name = (_stats && _stats.senderName) || (_globalCfg && _globalCfg.senderName) || 'Torneos Club Tachira';
    const email = (_stats && _stats.senderEmail) || (_globalCfg && _globalCfg.senderEmail) || 'torneo@tenistac.com';
    return name + ' <' + email + '>';
}

function renderDailyStatusCard() {
    const diarioOn = tipoEfectivo('estadisticas_diarias');
    const schedOn = sistemaActivo() && diarioOn;
    const tz = tzEfectiva();
    const hora = horaEfectiva();
    let lastSentTxt = '—';
    let lastStatusTxt = '';
    if (_dailyStatus && _dailyStatus.lastSent) {
        try {
            const d = _dailyStatus.lastSent.toDate ? _dailyStatus.lastSent.toDate() : new Date(_dailyStatus.lastSent);
            lastSentTxt = d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' +
                d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        } catch (e) { lastSentTxt = '—'; }
        lastStatusTxt = _dailyStatus.lastStatus === 'sent' ? ' ✓ enviado' : '';
    }

    return '<div class="card">' +
        '<div class="admin-section-title" style="margin-top:0;">' +
        '<span class="material-symbols-outlined" style="font-size:0.85rem;">schedule</span> Envío automático diario</div>' +
        '<div class="email-status-row">' +
        '<div>' +
        '<div style="font-size:0.82rem;font-weight:600;">Estadísticas diarias</div>' +
        '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);">' +
        (schedOn ? 'Se envía todos los días a las <strong>' + esc(hora) + '</strong> (' + esc(tz) + ')' : 'Desactivado o sistema pausado') + '</div>' +
        '</div>' +
        '<span class="badge ' + (schedOn ? 'badge-success' : 'badge-muted') + '">' + (schedOn ? 'Activo' : 'Inactivo') + '</span>' +
        '</div>' +
        '<div style="font-size:0.72rem;color:var(--on-surface-variant-60);margin-top:0.5rem;">' +
        'Último envío: <strong>' + lastSentTxt + '</strong>' + lastStatusTxt + '</div>' +
        '<p class="email-note">Cloud Function programada ejecuta cada hora. Verifica la hora configurada por torneo y el tipo "estadísticas diarias". ' +
        'Incluye partidos jugados, posiciones y categorías activas del torneo.</p>' +
        '</div>';
}

function renderStatsCard() {
    if (!_stats) {
        return '<div class="card">' +
            '<div class="admin-section-title" style="margin-top:0;"><span class="material-symbols-outlined" style="font-size:0.85rem;">monitoring</span> Consumo de Brevo</div>' +
            '<div class="empty-state" style="padding:1rem;"><span class="material-symbols-outlined">warning</span>' +
            '<p>' + esc(_statsError || 'No se pudieron cargar las estadísticas.') + '</p></div>' +
            '</div>';
    }
    const s = _stats;
    const pct = Math.min(100, s.porcentaje || 0);
    const nivel = s.nivel || 'normal';
    const barClass = nivel === 'critical' ? 'email-bar-critical' : nivel === 'alert' ? 'email-bar-alert' : nivel === 'warn' ? 'email-bar-warn' : 'email-bar-ok';

    const cell = (label, value) =>
        '<div class="email-counter"><div class="email-counter-value">' + value + '</div><div class="email-counter-label">' + label + '</div></div>';

    return '<div class="card">' +
        '<div class="admin-section-title" style="margin-top:0;"><span class="material-symbols-outlined" style="font-size:0.85rem;">monitoring</span> Consumo de Brevo — Hoy</div>' +
        '<div class="email-quota-head">' +
        '<div class="email-quota-big">' + s.hoy.sent + ' / ' + s.dailyLimit + '</div>' +
        '<div class="email-quota-sub">' + s.disponibles + ' disponibles · ' + pct + '% utilizado</div>' +
        '</div>' +
        '<div class="email-progress"><div class="email-progress-bar ' + barClass + '" style="width:' + pct + '%;"></div></div>' +
        '<div class="email-counters">' +
        cell('Enviados hoy', s.hoy.sent) +
        cell('Exitosos (hist.)', s.historico.totalSent) +
        cell('Fallidos hoy', s.hoy.error) +
        cell('Pendientes', s.hoy.pending) +
        cell('Omitidos hoy', s.hoy.omitted) +
        cell('Ayer', s.ayer.sent) +
        cell('Últimos 7 días', s.ultimos7dias.sent) +
        cell('Este mes', s.mes.sent) +
        '</div>' +
        '<p class="email-note">Consumo registrado por este sistema. El límite diario (' + s.dailyLimit + ') corresponde a la cuenta Brevo, compartida con otros proyectos. Zona horaria: ' + esc(s.timezone) + ' · Fecha: ' + esc(s.fecha) + '.</p>' +
        '</div>';
}

function estadoBadge(estado) {
    const map = {
        sent: { txt: '✓ Enviado', cls: 'badge-success' },
        error: { txt: '⚠ Error', cls: 'badge-danger' },
        pending: { txt: '⏳ Pendiente', cls: 'badge-warning' },
        sending: { txt: 'Enviando…', cls: 'badge-warning' },
        omitted: { txt: '— Omitido', cls: 'badge-muted' }
    };
    const m = map[estado] || { txt: estado || '?', cls: 'badge-muted' };
    return '<span class="badge ' + m.cls + '">' + m.txt + '</span>';
}

function fmtFechaHora(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' +
            d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return '—'; }
}

function renderHistory() {
    if (!_history || !_history.length) {
        return '<div class="empty-state" style="padding:1rem;"><span class="material-symbols-outlined">mail_lock</span><p>Todavía no hay envíos registrados.</p></div>';
    }
    return '<div class="email-history">' +
        _history.map(h => {
            const retry = (h.estado === 'error' || h.estado === 'pending')
                ? '<button class="btn btn-sm btn-outline email-retry-btn" data-retry-id="' + esc(h.id) + '" title="Reintentar"><span class="material-symbols-outlined" style="font-size:0.85rem;">restart_alt</span></button>'
                : '';
            return '<div class="email-history-row">' +
                '<div class="email-history-main">' +
                '<div style="font-size:0.78rem;font-weight:600;">' + estadoBadge(h.estado) + ' <span style="color:var(--on-surface-variant-60);font-weight:400;">· ' + esc(h.tipo) + '</span>' +
                ((h.metadata && h.metadata.prueba) ? ' <span class="badge badge-muted">PRUEBA</span>' : '') + '</div>' +
                '<div style="font-size:0.72rem;color:var(--on-surface-variant-60);margin-top:0.15rem;">' +
                esc(h.nombre || h.email || '—') + ' · ' + esc(h.email || '') + '</div>' +
                '<div style="font-size:0.65rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">' + fmtFechaHora(h.timestampISO) +
                (h.error ? ' · <span style="color:var(--error);">' + esc(h.error) + '</span>' : '') + '</div>' +
                '</div>' + retry +
                '</div>';
        }).join('') +
        '</div>';
}

// ── Eventos ─────────────────────────────────────────────────────
function bindEvents(tid) {
    const panel = document.getElementById('panel-correos');
    if (!panel) return;

    panel.querySelector('#email-global-toggle')?.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        try {
            showLoading(enabled ? 'Activando sistema...' : 'Pausando sistema...');
            await saveGlobalConfig({ enabled });
            toast(enabled ? 'Sistema de correo ACTIVADO' : 'Sistema de correo PAUSADO (no se enviará ningún email)', enabled ? 'success' : 'error');
            await renderCorreos();
        } catch (err) {
            console.error('[correos] Error guardando config global:', err);
            toast('Error al guardar la configuración', 'error');
        } finally { hideLoading(); }
    });

    panel.querySelector('#email-torneo-toggle')?.addEventListener('change', async (e) => {
        try {
            await saveTorneoConfig({ enabled: e.target.checked });
            toast(e.target.checked ? 'Envíos habilitados para este torneo' : 'Envíos pausados para este torneo', 'success');
            await renderCorreos();
        } catch (err) {
            console.error('[correos] Error guardando config torneo:', err);
            toast('Error al guardar', 'error');
        }
    });

    panel.querySelectorAll('[data-email-tipo]').forEach(input => {
        input.addEventListener('change', async (e) => {
            const tipo = e.target.dataset.emailTipo;
            const value = e.target.checked;
            try {
                const tipos = { ...((_torneoCfg && _torneoCfg.tipos) || {}), [tipo]: value };
                await saveTorneoConfig({ tipos });
                toast(value ? 'Tipo "' + tipo + '" activado' : 'Tipo "' + tipo + '" desactivado', 'success');
            } catch (err) {
                console.error('[correos] Error guardando tipo:', err);
                toast('Error al guardar', 'error');
                e.target.checked = !value;
            }
        });
    });

    panel.querySelector('#email-save-torneo')?.addEventListener('click', async () => {
        const hora = panel.querySelector('#email-hora')?.value || '20:00';
        const tz = panel.querySelector('#email-tz')?.value || 'America/Caracas';
        try {
            showLoading('Guardando...');
            await saveTorneoConfig({ horaEstadisticas: hora, timezone: tz });
            toast('Configuración del torneo guardada', 'success');
            await renderCorreos();
        } catch (err) {
            console.error('[correos] Error guardando hora/tz:', err);
            toast('Error al guardar', 'error');
        } finally { hideLoading(); }
    });

    panel.querySelector('#email-test-btn')?.addEventListener('click', async () => {
        if (_busy) return;
        _busy = true;
        const btn = panel.querySelector('#email-test-btn');
        const resultDiv = panel.querySelector('#email-test-result');
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;animation:spin 1s linear infinite;">progress_activity</span> Enviando...';
        try {
            const res = await callFn('emailSendTest', { torneoId: tid, toEmail: destinoDePrueba() });
            const ok = res && res.status === 'processed' && res.sent > 0;
            const msg = (res && res.message) || 'Sin respuesta del servidor.';
            if (resultDiv) {
                resultDiv.innerHTML = '<div class="email-test-result ' + (ok ? 'ok' : 'err') + '">' + esc(msg) + '</div>';
            }
            toast(ok ? 'Email de prueba enviado' : msg, ok ? 'success' : 'error');
            await renderCorreos();
        } catch (err) {
            console.error('[correos] Error en email de prueba:', err);
            toast(fnErrorMessage(err), 'error');
        } finally {
            _busy = false;
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;">mark_email_read</span> Enviar email de prueba';
        }
    });

    panel.querySelectorAll('.email-test-tipo-btn').forEach(btnEl => {
        btnEl.addEventListener('click', async () => {
            const tipo = btnEl.dataset.emailTestTipo;
            if (!tipo || _busy) return;
            const destino = destinoDePrueba();
            if (!destino || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) {
                toast('Ingresá un email de destino válido para las pruebas', 'error');
                return;
            }
            _busy = true;
            const icon = btnEl.querySelector('.material-symbols-outlined');
            const iconPrev = icon ? icon.textContent : 'send';
            if (icon) { icon.textContent = 'progress_activity'; icon.style.animation = 'spin 1s linear infinite'; }
            btnEl.disabled = true;
            try {
                const res = await callFn('emailSendTest', { torneoId: tid, toEmail: destino, tipo });
                const ok = res && res.status === 'processed' && res.sent > 0;
                const msg = (res && res.message) || 'Sin respuesta del servidor.';
                toast(ok ? 'Prueba de "' + tipo + '" enviada a ' + destino : msg, ok ? 'success' : 'error');
            } catch (err) {
                console.error('[correos] Error en prueba de módulo:', err);
                toast(fnErrorMessage(err), 'error');
            } finally {
                _busy = false;
                btnEl.disabled = false;
                if (icon) { icon.textContent = iconPrev; icon.style.animation = ''; }
            }
        });
    });

    panel.querySelectorAll('.email-retry-btn').forEach(btnEl => {
        btnEl.addEventListener('click', async () => {
            const envioId = btnEl.dataset.retryId;
            if (!envioId || _busy) return;
            _busy = true;
            btnEl.disabled = true;
            try {
                showLoading('Reintentando envío...');
                const res = await callFn('emailRetry', { torneoId: tid, envioId });
                toast((res && res.message) || 'Resultado desconocido', res && res.status === 'sent' ? 'success' : 'error');
                await renderCorreos();
            } catch (err) {
                console.error('[correos] Error en reintento:', err);
                toast(fnErrorMessage(err), 'error');
            } finally {
                _busy = false;
                hideLoading();
            }
        });
    });
}
