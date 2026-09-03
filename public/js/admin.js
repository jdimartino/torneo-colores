import { auth, db, functions } from './firebase.js';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { collection, getDocs, addDoc, updateDoc, doc, deleteDoc, query, orderBy, where, writeBatch, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { loadTournamentConfig, col, docRef, docRefAuto, getActiveTournamentId, getActiveTournament, getActiveTournamentIds, setSelectedTournament, finanzasCol } from './tournamentRefs.js';
import { renderTournamentPanel, getTournaments, getTournamentName, loadActiveTournamentNames } from './tournament.js?v=2';
import { calculateStandings } from './standings.js';
import { CATEGORIAS_JUGADOR, ensureCategorias, getDrawCategoriasActivas, getDrawCategoriasTodas, invalidateCategorias, crearCategoria, editarCategoria, setCategoriaActiva, existeCategoriaDuplicada, seedCategoriasDefault, normalizeCatName } from './categorias.js?v=1';
import { ROLES, ROL_LABELS, setCurrentUser, getCurrentUserRole, isMaster, isFull, isMarcadores, canRead, canWrite } from './permissions.js?v=2';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { renderCorreos } from './email.js?v=3';

let allJugadores = [];
let jugadorSearchTerm = '';
let jugadorAbiertoId = null;
let allEquipos = [];
let allPartidos = [];
let allJornadas = [];
let dataLoaded = false;
let _currentPanel = null;
let _partidosCacheKey = null;
let _partidosCache = [];
let _debounceTimers = new Map();
let currentUserData = null;
let allUsuarios = [];
let _userModalMode = null;
let _userEditId = null;
let _syncData = { missingFromFirestore: [], missingFromAuth: [] };
let _syncPageToken = null;
let _syncLoading = false;

function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function shortName(j, asHTML = false) {
    if (!j) return '';
    const firstName = (j.nombre || '').split(' ')[0];
    const firstLast = (j.apellidos || '').split(' ')[0];
    const cat = j.categoria ? ' (' + j.categoria + ')' : '';
    const sinPago = !j.pago_recibido && !j.exonerado 
        ? (asHTML 
            ? '<span style="color:var(--secondary);font-size:1.2rem;vertical-align:super;margin-left:0.2rem;">•</span>'
            : ' •') 
        : '';
    return firstName + ' ' + firstLast + cat + sinPago;
}

function formatDate(fecha) {
    if (!fecha) return '';
    try {
        const d = fecha.toDate ? fecha.toDate() : new Date(fecha);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR');
    } catch (e) { return ''; }
}

// 'Masculino Suma 9' → 'SUMA 9 MASCULINO'; 'Masculino 6ta Master' → '6TA MASTER MASCULINO'
function formatCategoria(cat) {
    if (!cat) return '';
    const s = String(cat).trim();
    const generar = (inicio, resto) => {
        const r = resto.trim();
        const mat = r.match(/^Suma\s+(\d+)\s*$/i);
        if (mat) return 'SUMA ' + mat[1] + ' ' + inicio.toUpperCase();
        if (r) return r.toUpperCase() + ' ' + inicio.toUpperCase();
        return inicio.toUpperCase();
    };
    if (/^Masculino\s+/i.test(s)) return generar('Masculino', s.replace(/^Masculino/i, ''));
    if (/^Femenino\s+/i.test(s)) return generar('Femenino', s.replace(/^Femenino/i, ''));
    if (/^Mixto\s+/i.test(s)) return generar('Mixto', s.replace(/^Mixto/i, ''));
    return s.toUpperCase();
}

function toast(msg, type) {
    const container = document.querySelector('.toast-container') || (() => {
        const el = document.createElement('div');
        el.className = 'toast-container';
        document.body.appendChild(el);
        return el;
    })();
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => t.remove(), 2800);
}

function showLoading(msg) {
    let overlay = document.getElementById('global-loading');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'global-loading';
        overlay.className = 'loading-overlay';
        overlay.innerHTML = '<div class="loading-content"><div class="tennis-ball-spinner"></div><div class="loading-text"></div></div>';
        document.body.appendChild(overlay);
    }
    overlay.querySelector('.loading-text').textContent = msg || 'Procesando...';
    overlay.style.display = 'flex';
}

function hideLoading() {
    const overlay = document.getElementById('global-loading');
    if (overlay) overlay.style.display = 'none';
}

// ── Backward compatibility: normalize old local/visitante fields to a/b ──
function normalizeFields(data) {
    if (!data) return data;
    const d = { ...data };
    const map = {
        equipo_local_id: 'equipo_a_id',
        equipo_visitante_id: 'equipo_b_id',
        equipo_local_nombre: 'equipo_a_nombre',
        equipo_visitante_nombre: 'equipo_b_nombre',
        jugador_local_1_id: 'jugador_a_1_id',
        jugador_local_2_id: 'jugador_a_2_id',
        jugador_visitante_1_id: 'jugador_b_1_id',
        jugador_visitante_2_id: 'jugador_b_2_id',
        jugador_local_1_nombre: 'jugador_a_1_nombre',
        jugador_local_2_nombre: 'jugador_a_2_nombre',
        jugador_visitante_1_nombre: 'jugador_b_1_nombre',
        jugador_visitante_2_nombre: 'jugador_b_2_nombre',
        set1_local: 'set1_a',
        set1_visitante: 'set1_b',
        set2_local: 'set2_a',
        set2_visitante: 'set2_b',
        tiebreak1_local: 'tiebreak1_a',
        tiebreak1_visitante: 'tiebreak1_b',
        tiebreak2_local: 'tiebreak2_a',
        tiebreak2_visitante: 'tiebreak2_b',
        supertiebreak_local: 'supertiebreak_a',
        supertiebreak_visitante: 'supertiebreak_b',
        games_local: 'games_a',
        games_visitante: 'games_b'
    };
    for (const [oldKey, newKey] of Object.entries(map)) {
        if (oldKey in d && !(newKey in d)) {
            d[newKey] = d[oldKey];
        }
    }
    return d;
}

function panelLoading(panel, msg) {
    panel.innerHTML = '<div class="panel-loading"><div class="tennis-ball-spinner"></div><div class="loading-text">' + (msg || 'Cargando...') + '</div></div>';
}

// shortName is imported from utils.js

function formatMatchDate(fecha) {
    if (!fecha) return '';
    try {
        const d = fecha.toDate ? fecha.toDate() : new Date(fecha);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR');
    } catch (e) { return ''; }
}

function getTeamName(equipoId) {
    if (!equipoId) return '';
    const eq = allEquipos.find(e => e.id === equipoId);
    return eq ? eq.nombre : '';
}

function getTeamColor(equipoId) {
    if (!equipoId) return '';
    const eq = allEquipos.find(e => e.id === equipoId);
    return eq ? eq.color : '#888';
}

function getPlayersInTeam(equipoId) {
    return allJugadores.filter(j => j.equipo_id === equipoId);
}

// ── Tab Dropdown Logic (Admin) ──
function setupTabDropdownAdmin() {
    const moreBtn = document.getElementById('tab-more-btn-admin');
    const dropdown = document.getElementById('tab-dropdown-admin');
    if (!moreBtn || !dropdown) return;

    const wrap = moreBtn.closest('.tab-nav-wrap');
    let isOpen = false;
    let backdrop = null;

    function positionDropdown() {
        const wrapRect = wrap.getBoundingClientRect();
        const btnRect = moreBtn.getBoundingClientRect();
        const ddWidth = dropdown.offsetWidth || 160;

        dropdown.classList.remove('align-left', 'align-right');
        const rightOffset = wrapRect.right - btnRect.right;
        const ddLeft = btnRect.right - ddWidth;

        if (ddLeft >= wrapRect.left) {
            dropdown.style.right = rightOffset + 'px';
            dropdown.style.left = 'auto';
            dropdown.classList.add('align-right');
        } else {
            dropdown.style.left = '0';
            dropdown.style.right = 'auto';
            dropdown.classList.add('align-left');
        }
    }

    function createBackdrop() {
        if (backdrop) return;
        backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:99;background:transparent;';
        backdrop.addEventListener('click', closeDropdown);
        backdrop.addEventListener('touchend', (e) => { e.preventDefault(); closeDropdown(); });
        document.body.appendChild(backdrop);
    }

    function removeBackdrop() {
        if (backdrop) { backdrop.remove(); backdrop = null; }
    }

    function closeDropdown() {
        if (!isOpen) return;
        isOpen = false;
        moreBtn.classList.remove('open');
        dropdown.classList.remove('show');
        removeBackdrop();
    }

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen) {
            closeDropdown();
        } else {
            isOpen = true;
            moreBtn.classList.add('open');
            positionDropdown();
            dropdown.classList.add('show');
            createBackdrop();
        }
    });

    // Actualizar estado active en dropdown
    document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('[data-panel]');
        if (tabBtn) {
            setTimeout(() => {
                const panelId = tabBtn.dataset.panel;
                dropdown.querySelectorAll('button').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.panel === panelId);
                });
                document.querySelectorAll('.tab-nav > button[data-panel]').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.panel === panelId);
                });
                closeDropdown();
            }, 0);
        }
    });
}

// Inicializar dropdown cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    setupTabDropdownAdmin();
});

// ── Financial Module: Administración ──
const MONEDAS_MANUAL = ['EUR', 'USD', 'Bs'];
const MONTO_SOCIO = 20;
const MONTO_INVITADO = 25;
const BCV_API_URL = 'https://bcv.today/api/v1/rate.json';
const TASAS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let _financeFiltro = 'todos';
let _financeModalMode = null;
let _financeEditId = null;
let _financeMovimientosCache = [];
let _financeDirty = true;
let _tasas = { eur_ves: 0, usd_ves: 0, fechaActualizacion: null, fuente: '', actualizadoEn: null };
let _tasasLoading = false;
let _tasasLoaded = false;
let _tasasUpdating = false;

async function getMovimientosFinancieros() {
    const snap = await getDocs(query(finanzasCol(), orderBy('fecha', 'desc')));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function existeIngresoInscripcion(jugadorId) {
    const q = query(
        finanzasCol(),
        where('tipo', '==', 'ingreso_inscripcion'),
        where('jugadorId', '==', jugadorId)
    );
    const snap = await getDocs(q);
    return snap.size > 0;
}

async function crearIngresoInscripcion(jugador) {
    const isSocio = (jugador.status_socio || '').trim() === 'Socio';
    const monto = isSocio ? MONTO_SOCIO : MONTO_INVITADO;
    const nombre = (jugador.nombre || '') + ' ' + (jugador.apellidos || '');
    const ahora = new Date();
    const mov = {
        tipo: 'ingreso_inscripcion',
        fecha: ahora,
        concepto: 'Inscripción - ' + nombre.trim(),
        monto: monto,
        moneda: 'EUR',
        observacion: '',
        jugadorId: jugador.id,
        jugadorNombre: nombre.trim(),
        origen: 'jugador',
        creado: ahora
    };
    await addDoc(finanzasCol(), mov);
    _financeDirty = true;
}

async function syncInscripcionIngreso(jugadorId) {
    const jug = allJugadores.find(j => j.id === jugadorId);
    if (!jug) return;
    if (!jug.pago_recibido) return;
    const yaExiste = await existeIngresoInscripcion(jugadorId);
    if (yaExiste) return;
    await crearIngresoInscripcion(jug);
}

async function sincronizarInscripciones() {
    showLoading('Sincronizando ingresos de inscripciones...');
    try {
        const snap = await getDocs(query(finanzasCol(), where('tipo', '==', 'ingreso_inscripcion')));
        const existentes = new Set(snap.docs.map(d => d.data().jugadorId).filter(Boolean));
        const pagados = allJugadores.filter(j => j.pago_recibido);
        let creados = 0;
        for (const j of pagados) {
            if (!existentes.has(j.id)) {
                await crearIngresoInscripcion(j);
                creados++;
            }
        }
        toast(creados > 0 ? (creados + ' ingresos creados') : 'No hay ingresos nuevos', 'success');
    } catch (e) {
        toast('Error al sincronizar', 'error');
        console.error(e);
    } finally {
        hideLoading();
        renderAdministracion();
    }
}

function formatMonto(monto, moneda) {
    return (moneda === 'EUR' ? '€' : moneda === 'USD' ? '$' : 'Bs ') + monto.toFixed(2);
}

// ── BCV Rates ──
function formatBs(monto) {
    return 'Bs. ' + monto.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Date format conversion functions
function formatDateToDDMM(dateStr) {
    if (!dateStr) return '';
    const [year, month, day] = dateStr.split('-');
    return `${day.padStart(2, '0')}/${month.padStart(2, '0')}`;
}

function formatDateToYYYYMMDD(dateStr) {
    if (!dateStr) return '';
    const [day, month, year] = dateStr.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function getEquivalenteBs(monto, moneda) {
    if (moneda === 'Bs' || !monto || monto <= 0) return null;
    const tasa = moneda === 'EUR' ? _tasas.eur_ves : _tasas.usd_ves;
    if (!tasa || tasa <= 0) return null;
    return formatBs(monto * tasa);
}

function getTasasDocRef() {
    const tid = getActiveTournamentId();
    if (!tid) return null;
    return doc(db, 'torneos', tid, 'configuracion', 'tasas');
}

async function fetchTasasBCV() {
    try {
        const resp = await fetch(BCV_API_URL + '?t=' + Date.now());
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!data.USD || !data.EUR) throw new Error('Incomplete data');
        return {
            eur_ves: data.EUR,
            usd_ves: data.USD,
            fechaActualizacion: new Date(data.updated_at || Date.now()),
            fuente: 'BCV vía bcv.today'
        };
    } catch (e) {
        console.error('[tasas] Error fetching BCV:', e);
        return null;
    }
}

async function guardarTasas(tasas) {
    const ref = getTasasDocRef();
    if (!ref) return;
    try {
        await setDoc(ref, {
            eur_ves: tasas.eur_ves,
            usd_ves: tasas.usd_ves,
            fechaActualizacion: tasas.fechaActualizacion,
            fuente: tasas.fuente,
            actualizadoEn: new Date()
        });
    } catch (e) {
        console.error('[tasas] Error guardando tasas:', e);
    }
}

async function cargarTasas() {
    if (_tasasLoading || _tasasLoaded) return;
    _tasasLoading = true;
    try {
        const ref = getTasasDocRef();
        if (!ref) return;
        const snap = await getDoc(ref);
        const now = Date.now();
        if (snap.exists()) {
            const data = snap.data();
            const fecha = data.fechaActualizacion?.toDate ? data.fechaActualizacion.toDate() : (data.fechaActualizacion ? new Date(data.fechaActualizacion) : null);
            const actualizadoEn = data.actualizadoEn?.toDate ? data.actualizadoEn.toDate() : (data.actualizadoEn ? new Date(data.actualizadoEn) : null);
            const age = fecha ? (now - fecha.getTime()) : Infinity;
            _tasas = {
                eur_ves: data.eur_ves || 0,
                usd_ves: data.usd_ves || 0,
                fechaActualizacion: fecha,
                fuente: data.fuente || '',
                actualizadoEn: actualizadoEn
            };
            if (age > TASAS_MAX_AGE_MS || !data.eur_ves) {
                const fresh = await fetchTasasBCV();
                if (fresh) {
                    _tasas = fresh;
                    await guardarTasas(fresh);
                }
            }
        } else {
            const fresh = await fetchTasasBCV();
            if (fresh) {
                _tasas = fresh;
                await guardarTasas(fresh);
            }
        }
        _tasasLoaded = true;
    } catch (e) {
        console.error('[tasas] Error cargando tasas:', e);
    } finally {
        _tasasLoading = false;
    }
}

async function actualizarTasasManual() {
    if (_tasasUpdating) return;
    _tasasUpdating = true;
    const btn = document.getElementById('btn-actualizar-tasas');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:0.7rem;animation:spin 1s linear infinite;">refresh</span> Actualizando…';
    }
    toast('Consultando tasas BCV (bcv.today)...', 'info');
    try {
        const prevEur = _tasas.eur_ves;
        const prevUsd = _tasas.usd_ves;
        const fresh = await fetchTasasBCV();
        if (fresh) {
            _tasas = fresh;
            _tasas.actualizadoEn = new Date();
            await guardarTasas(fresh);
            const cambioEur = prevEur > 0 && Math.abs(fresh.eur_ves - prevEur) > 0.0001;
            const cambioUsd = prevUsd > 0 && Math.abs(fresh.usd_ves - prevUsd) > 0.0001;
            if (cambioEur || cambioUsd) {
                toast('Tasas actualizadas: EUR ' + prevEur.toFixed(2) + ' → ' + fresh.eur_ves.toFixed(2) +
                    ' · USD ' + prevUsd.toFixed(2) + ' → ' + fresh.usd_ves.toFixed(2) + '. Actualizada en la app ahora.', 'success');
            } else {
                toast('Tasas consultadas. Sin cambios: EUR ' + fresh.eur_ves.toFixed(2) + ' · USD ' + fresh.usd_ves.toFixed(2) + '. Ya estaban al día.', 'info');
            }
        } else {
            toast('No se pudo conectar con bcv.today. Se conservan las tasas anteriores.', 'error');
        }
    } catch (e) {
        console.error('[tasas] Error manual:', e);
        toast('No se pudo conectar con bcv.today. Se conservan las tasas anteriores.', 'error');
    } finally {
        _tasasUpdating = false;
        renderAdministracion();
    }
}

function fmtFechaHora(fecha) {
    if (!fecha) return '—';
    return fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
        ' ' + fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function fmtHaceMs(ms) {
    if (!ms || ms < 0) return '';
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'hace menos de 1 min';
    if (min < 60) return 'hace ' + min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return 'hace ' + h + ' h';
    const d = Math.floor(h / 24);
    return 'hace ' + d + ' d';
}

function renderTasasReferencia() {
    const hasTasas = _tasas.eur_ves > 0 || _tasas.usd_ves > 0;
    const fecha = _tasas.fechaActualizacion;
    const fechaStr = fmtFechaHora(fecha);
    const updatedEn = _tasas.actualizadoEn;
    const updatedEnStr = fmtFechaHora(updatedEn);
    const isStale = fecha ? (Date.now() - fecha.getTime()) > TASAS_MAX_AGE_MS : true;
    const bcvAgeStr = fecha ? fmtHaceMs(Date.now() - fecha.getTime()) : '';
    const appAgeStr = updatedEn ? fmtHaceMs(Date.now() - updatedEn.getTime()) : '';

    let html = '<div class="finance-rates-card">';
    html += '<div class="frc-header">';
    html += '<span class="material-symbols-outlined" style="font-size:1rem;color:var(--secondary);">paid</span>';
    html += '<span class="frc-title">Tasas de referencia</span>';
    html += '<button class="btn btn-sm btn-outline" id="btn-actualizar-tasas" onclick="actualizarTasasManual()" style="margin-left:auto;font-size:0.6rem;padding:0.15rem 0.3rem;"' + (_tasasUpdating ? ' disabled' : '') + '><span class="material-symbols-outlined" style="font-size:0.7rem;' + (_tasasUpdating ? 'animation:spin 1s linear infinite;' : '') + '">refresh</span> ' + (_tasasUpdating ? 'Actualizando…' : 'Actualizar') + '</button>';
    html += '</div>';

    if (hasTasas) {
        html += '<div class="frc-rates">';
        html += '<div class="frc-rate-row">';
        html += '<span class="frc-cur">EUR</span>';
        html += '<span class="frc-val">1 EUR = ' + formatBs(_tasas.eur_ves) + '</span>';
        html += '</div>';
        html += '<div class="frc-rate-row">';
        html += '<span class="frc-cur">USD</span>';
        html += '<span class="frc-val">1 USD = ' + formatBs(_tasas.usd_ves) + '</span>';
        html += '</div>';
        html += '</div>';
        html += '<div class="frc-updated">Publicada por BCV: ' + fechaStr + (bcvAgeStr ? ' (' + bcvAgeStr + ')' : '') + ' · ' + esc(_tasas.fuente) + '</div>';
        if (updatedEn) {
            html += '<div class="frc-updated">Actualizada en la app: ' + updatedEnStr + (appAgeStr ? ' (' + appAgeStr + ')' : '') + '</div>';
        }
        if (isStale) {
            html += '<div class="frc-warning"><span class="material-symbols-outlined" style="font-size:0.75rem;">warning</span> Tasa BCV publicada hace más de 24h. Presioná Actualizar para consultar.</div>';
        }
    } else {
        html += '<div class="frc-warning"><span class="material-symbols-outlined" style="font-size:0.75rem;">error</span> No se pudieron cargar las tasas. Presioná Actualizar para consultar bcv.today.</div>';
    }
    html += '</div>';
    return html;
}

function updateEquivalenteModal() {
    const el = document.getElementById('fm-equivalente');
    if (!el) return;
    const monto = parseFloat(document.getElementById('fm-monto').value);
    const moneda = document.getElementById('fm-moneda').value;
    if ((moneda === 'EUR' || moneda === 'USD') && monto > 0) {
        const eq = getEquivalenteBs(monto, moneda);
        if (eq) {
            el.textContent = '≈ ' + eq;
            el.style.display = 'block';
            return;
        }
    }
    el.style.display = 'none';
}

function openFinanceModal(mode, editId) {
    _financeModalMode = mode;
    _financeEditId = editId || null;
    const overlay = document.getElementById('finance-modal-overlay');
    if (!overlay) return;
    const title = overlay.querySelector('.modal h3');
    const fechaEl = document.getElementById('fm-fecha');
    const conceptoEl = document.getElementById('fm-concepto');
    const montoEl = document.getElementById('fm-monto');
    const monedaEl = document.getElementById('fm-moneda');
    const obsEl = document.getElementById('fm-observacion');
    const btnEl = document.getElementById('fm-btn-save');
    const eqEl = document.getElementById('fm-equivalente');

    if (mode === 'editar' && editId) {
        title.textContent = 'Editar Movimiento';
        btnEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;">save</span> Actualizar';
        const fill = (m) => {
            if (!m) return;
            fechaEl.value = m.fecha ? new Date(m.fecha.toDate ? m.fecha.toDate() : m.fecha).toISOString().slice(0, 10) : '';
            conceptoEl.value = m.concepto || '';
            montoEl.value = m.monto || '';
            monedaEl.value = m.moneda || 'USD';
            obsEl.value = m.observacion || '';
            updateEquivalenteModal();
        };
        const cached = _financeMovimientosCache.find(x => x.id === editId);
        if (cached) {
            fill(cached);
        } else {
            getMovimientosFinancieros().then(movs => {
                _financeMovimientosCache = movs;
                _financeDirty = false;
                fill(movs.find(x => x.id === editId));
            });
        }
    } else {
        title.textContent = mode === 'ingreso' ? 'Nuevo Otro Ingreso' : 'Registrar Egreso';
        btnEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;">add</span> Guardar';
        fechaEl.value = new Date().toISOString().slice(0, 10);
        conceptoEl.value = '';
        montoEl.value = '';
        monedaEl.value = 'EUR';
        obsEl.value = '';
        if (eqEl) eqEl.style.display = 'none';
    }

    montoEl.oninput = updateEquivalenteModal;
    monedaEl.onchange = updateEquivalenteModal;

    overlay.classList.add('active');
    overlay.style.display = 'flex';
}

function closeFinanceModal() {
    const overlay = document.getElementById('finance-modal-overlay');
    if (overlay) {
        overlay.classList.remove('active');
        overlay.style.display = 'none';
    }
    _financeModalMode = null;
    _financeEditId = null;
}

async function saveFinanceModal() {
    const fecha = document.getElementById('fm-fecha').value;
    const concepto = document.getElementById('fm-concepto').value.trim();
    const monto = parseFloat(document.getElementById('fm-monto').value);
    const moneda = document.getElementById('fm-moneda').value;
    const observacion = document.getElementById('fm-observacion').value.trim();

    if (!fecha || !concepto || isNaN(monto) || monto <= 0) {
        toast('Completá fecha, concepto y monto válido', 'error');
        return;
    }

    if (_financeModalMode === 'editar' && _financeEditId) {
        try {
            await updateDoc(doc(finanzasCol(), _financeEditId), {
                fecha: new Date(fecha),
                concepto: concepto,
                monto: monto,
                moneda: moneda,
                observacion: observacion
            });
            toast('Movimiento actualizado', 'success');
        } catch (e) {
            toast('Error al actualizar', 'error');
            console.error(e);
        }
    } else {
        const tipo = _financeModalMode === 'ingreso' ? 'otro_ingreso' : 'egreso';
        const mov = {
            tipo: tipo,
            fecha: new Date(fecha),
            concepto: concepto,
            monto: monto,
            moneda: moneda,
            observacion: observacion,
            origen: 'manual',
            creado: new Date()
        };
        try {
            await addDoc(finanzasCol(), mov);
            toast(tipo === 'otro_ingreso' ? 'Otro ingreso agregado' : 'Egreso registrado', 'success');
        } catch (e) {
            toast('Error al guardar', 'error');
            console.error(e);
        }
    }
    closeFinanceModal();
    _financeDirty = true;
    renderAdministracion();
}

async function deleteMovimiento(id, tipo) {
    if (tipo === 'ingreso_inscripcion') {
        toast('Los ingresos de inscripción no se pueden eliminar', 'error');
        return;
    }
    if (!confirm('¿Eliminar este movimiento financiero?')) return;
    try {
        await deleteDoc(doc(finanzasCol(), id));
        toast('Movimiento eliminado', 'success');
        _financeDirty = true;
        renderAdministracion();
    } catch (e) {
        toast('Error al eliminar', 'error');
        console.error(e);
    }
}

function setFinanceFiltro(filtro) {
    _financeFiltro = filtro;
    const panel = document.getElementById('panel-administracion');
    if (!panel) return;
    const filtersEl = panel.querySelector('.finance-filters');
    if (filtersEl) filtersEl.outerHTML = renderFinanceFiltros();
    const movementsEl = panel.querySelector('.finance-movements');
    if (movementsEl) movementsEl.outerHTML = renderFinanceMovimientos(_financeMovimientosCache);
}

function fmtMontoMov(m) {
    if (m.moneda === 'EUR') return '€ ' + (+m.monto).toFixed(2);
    if (m.moneda === 'USD') return '$ ' + (+m.monto).toFixed(2);
    return formatBs(+m.monto);
}

function toUSD(m) {
    const mon = m.moneda || 'USD';
    if (mon === 'USD') return +m.monto || 0;
    if (mon === 'EUR') return (_tasas.eur_ves && _tasas.usd_ves) ? (+m.monto * _tasas.eur_ves) / _tasas.usd_ves : 0;
    if (mon === 'Bs') return (_tasas.usd_ves) ? (+m.monto / _tasas.usd_ves) : 0;
    return 0;
}

function renderFinanceResumen(movimientos) {
    const hasData = movimientos.length > 0;

    if (!hasData) {
        return '<div class="finance-summary-new"><div class="finance-section"><div class="fsc-empty">Sin movimientos</div></div></div>';
    }

    // Calculate inscription income (always in EUR)
    const inscEur = movimientos
        .filter(m => m.tipo === 'ingreso_inscripcion' && m.moneda === 'EUR')
        .reduce((sum, m) => sum + m.monto, 0);

    const inscBse = inscEur * (_tasas.eur_ves || 0);

    // Calculate other income items
    const otrosMov = movimientos.filter(m => m.tipo === 'otro_ingreso');
    const otrosItems = otrosMov.map(m => ({
        label: m.concepto || m.metodo || 'Otro',
        valor: fmtMontoMov(m),
        usd: toUSD(m)
    }));

    const totalOtrosUsd = otrosItems.reduce((s, x) => s + (x.usd || 0), 0);

    // Calculate expenses by currency
    const gastoEur = movimientos
        .filter(m => m.tipo === 'egreso' && m.moneda === 'EUR')
        .reduce((sum, m) => sum + m.monto, 0);

    const gastoUsd = movimientos
        .filter(m => m.tipo === 'egreso' && m.moneda === 'USD')
        .reduce((sum, m) => sum + m.monto, 0);

    const gastoBs = movimientos
        .filter(m => m.tipo === 'egreso' && m.moneda === 'Bs')
        .reduce((sum, m) => sum + m.monto, 0);

    // Build HTML
    let html = '<div class="finance-summary-new">';

    // Inscription section
    html += '<div class="finance-section">';
    html += '<div class="fs-header"><span class="fs-icon material-symbols-outlined">how_to_reg</span><span class="fs-title">Ingresos por Inscripción</span></div>';
    html += `<div class="fs-row"><span class="fs-label">Total (EUR)</span><span class="fs-value ingreso">${formatMonto(inscEur, 'EUR')}</span></div>`;
    html += `<div class="fs-row"><span class="fs-label">Equivalente Bs</span><span class="fs-value equiv">${formatBs(inscBse)}</span></div>`;
    html += '</div>';

    // Other income section
    html += '<div class="finance-section">';
    html += '<div class="fs-header"><span class="fs-icon material-symbols-outlined">paid</span><span class="fs-title">Otros Ingresos</span></div>';
    if (otrosItems.length > 0) {
        otrosItems.forEach(x => {
            html += `<div class="fs-row"><span class="fs-label">${esc(x.label)}</span><span class="fs-value ingreso">${x.valor}</span></div>`;
        });
        html += '<div class="fs-divider"></div>';
        html += `<div class="fs-row"><span class="fs-label">Total Otros</span><span class="fs-value total">≈ $${totalOtrosUsd.toFixed(2)} USD</span></div>`;
    } else {
        html += '<div class="fs-row"><span class="fs-label fs-muted">Sin otros ingresos</span><span class="fs-value fs-muted">—</span></div>';
    }
    html += '</div>';

    // Expenses section
    html += '<div class="finance-section">';
    html += '<div class="fs-header"><span class="fs-icon material-symbols-outlined">receipt_long</span><span class="fs-title">Gastos</span></div>';
    html += `<div class="fs-row"><span class="fs-label">EUR</span><span class="fs-value egreso">${formatMonto(gastoEur, 'EUR')}</span></div>`;
    html += `<div class="fs-row"><span class="fs-label">USD</span><span class="fs-value egreso">${formatMonto(gastoUsd, 'USD')}</span></div>`;
    html += `<div class="fs-row"><span class="fs-label">Bs</span><span class="fs-value egreso">${formatBs(gastoBs)}</span></div>`;
    html += '</div>';

    html += '</div>';

    return html;
}

function renderBalanceSection(balances) {
    const monedas = ['EUR', 'USD', 'Bs'];
    let html = '<div class="finance-balance-section">';
    monedas.forEach(mon => {
        const b = balances[mon] || { total: 0, hasData: false };
        const sym = mon === 'EUR' ? '€' : mon === 'USD' ? '$' : 'Bs';
        const cls = b.total > 0 ? ' balance-positive' : b.total < 0 ? ' balance-negative' : ' balance-zero';
        html += '<div class="balance-item">';
        html += '<span class="balance-label">Balance ' + mon + '</span>';
        html += '<span class="balance-value' + cls + '">' + formatMonto(b.total, mon) + '</span>';
        html += '</div>';
    });
    html += '</div>';
    return html;
}

function renderFinanceFiltros() {
    const filtros = [
        { key: 'todos', label: 'Todos' },
        { key: 'ingresos', label: 'Ingresos' },
        { key: 'egresos', label: 'Egresos' },
        { key: 'ingreso_inscripcion', label: 'Inscripciones' },
        { key: 'otro_ingreso', label: 'Otros Ingresos' }
    ];
    let html = '<div class="finance-filters">';
    filtros.forEach(f => {
        html += '<button class="finance-filter-pill' + (_financeFiltro === f.key ? ' active' : '') + '" onclick="setFinanceFiltro(\'' + f.key + '\')">' + f.label + '</button>';
    });
    html += '</div>';
    return html;
}

function renderFinanceMovimientos(movimientos) {
    let filtered = movimientos;
    if (_financeFiltro === 'ingresos') {
        filtered = movimientos.filter(m => m.tipo === 'ingreso_inscripcion' || m.tipo === 'otro_ingreso');
    } else if (_financeFiltro === 'egresos') {
        filtered = movimientos.filter(m => m.tipo === 'egreso');
    } else if (_financeFiltro !== 'todos') {
        filtered = movimientos.filter(m => m.tipo === _financeFiltro);
    }

    let html = '<div class="finance-movements">';
    if (filtered.length === 0) {
        html += '<div class="finance-empty"><span class="material-symbols-outlined">receipt_long</span><p>No hay movimientos para mostrar</p></div>';
    } else {
    filtered.forEach(m => {
        const fecha = m.fecha ? (m.fecha.toDate ? m.fecha.toDate() : new Date(m.fecha)) : null;
        const fechaStr = fecha ? fecha.toLocaleDateString('es-AR') : '—';
        const tipoLabel = m.tipo === 'ingreso_inscripcion' ? 'Inscripción' : m.tipo === 'otro_ingreso' ? 'Otro Ingreso' : 'Egreso';
        const tipoClass = m.tipo === 'egreso' ? 'egreso' : 'ingreso';
        const isManual = m.tipo !== 'ingreso_inscripcion';

        html += '<div class="finance-movement-row">';
        html += '<div class="fmr-left">';
        html += '<div class="fmr-concepto">' + esc(m.concepto) + '</div>';
        html += '<div class="fmr-meta">';
        html += '<span class="fmr-fecha">' + fechaStr + '</span>';
        html += '<span class="fmr-badge ' + tipoClass + '">' + tipoLabel + '</span>';
        html += '<span class="fmr-moneda">' + m.moneda + '</span>';
        if (m.observacion) html += '<span class="fmr-obs">' + esc(m.observacion) + '</span>';
        if (m.jugadorNombre) html += '<span class="fmr-jugador">' + esc(m.jugadorNombre) + '</span>';
        html += '</div>';
        html += '</div>';
        html += '<div class="fmr-right">';
        html += '<span class="fmr-monto ' + tipoClass + '">' + formatMonto(m.monto, m.moneda) + '</span>';
        if (m.moneda !== 'Bs') {
            const eq = getEquivalenteBs(m.monto, m.moneda);
            if (eq) html += '<div class="fmr-equivalente">≈ ' + eq + '</div>';
        }
        if (isManual) {
            html += '<div class="fmr-actions">';
            html += '<button class="btn-icon" onclick="openFinanceModal(\'editar\',\'' + m.id + '\')" title="Editar"><span class="material-symbols-outlined" style="font-size:1rem;">edit</span></button>';
            html += '<button class="btn-icon" onclick="deleteMovimiento(\'' + m.id + '\',\'' + m.tipo + '\')" title="Eliminar"><span class="material-symbols-outlined" style="font-size:1rem;">delete</span></button>';
            html += '</div>';
        }
        html += '</div>';
        html += '</div>';
    });
    }
    html += '</div>';
    return html;
}

async function renderAdministracion() {
    const panel = document.getElementById('panel-administracion');
    if (!panel) return;
    if (!getActiveTournamentId()) {
        panel.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;">' +
            '<span class="material-symbols-outlined" style="font-size:2rem;color:var(--primary);">info</span>' +
            '<p style="margin-top:0.5rem;">No hay torneo activo. Creá uno desde la pestaña <strong>Torneos</strong>.</p></div>';
        return;
    }

    await cargarTasas();

    let movimientos = _financeMovimientosCache;
    if (_financeDirty) {
        try {
            movimientos = await getMovimientosFinancieros();
            _financeMovimientosCache = movimientos;
            _financeDirty = false;
        } catch (e) {
            console.error(e);
        }
    }

    let html = '';

    html += renderTasasReferencia();
    html += renderFinanceResumen(movimientos);

    html += '<div class="finance-actions">';
    html += '<button class="btn btn-primary" onclick="openFinanceModal(\'ingreso\')"><span class="material-symbols-outlined" style="font-size:1rem;">add</span> Otro Ingreso</button>';
    html += '<button class="btn btn-danger" onclick="openFinanceModal(\'egreso\')"><span class="material-symbols-outlined" style="font-size:1rem;">add</span> Registrar Egreso</button>';
    html += '<button class="btn btn-outline" onclick="sincronizarInscripciones()"><span class="material-symbols-outlined" style="font-size:1rem;">sync</span> Sincronizar Inscripciones</button>';
    html += '</div>';

    html += renderFinanceFiltros();
    html += renderFinanceMovimientos(movimientos);

    panel.innerHTML = html;
}

// ── Auth ──
let currentAdminUids = [];

async function loadAdminConfig() {
    try {
        const adminDoc = await getDoc(doc(db, 'config', 'admin'));
        if (adminDoc.exists()) {
            currentAdminUids = adminDoc.data().adminUids || [];
            console.log('[admin] config/admin found, adminUids:', currentAdminUids);
        } else {
            console.warn('[admin] config/admin document DOES NOT EXIST in Firestore');
            currentAdminUids = [];
        }
    } catch (e) {
        console.error('[admin] Error loading admin config:', e);
        currentAdminUids = [];
    }

    if (auth.currentUser) {
        try {
            const userDoc = await getDoc(doc(db, 'usuarios', auth.currentUser.uid));
            if (userDoc.exists()) {
                currentUserData = { uid: auth.currentUser.uid, ...userDoc.data() };
                setCurrentUser(currentUserData);
                console.log('[admin] user data loaded:', currentUserData);

                await updateDoc(doc(db, 'usuarios', auth.currentUser.uid), {
                    lastLogin: new Date()
                });
            } else {
                if (currentAdminUids.includes(auth.currentUser.uid)) {
                    currentUserData = {
                        uid: auth.currentUser.uid,
                        email: auth.currentUser.email,
                        nombre: auth.currentUser.displayName || auth.currentUser.email,
                        rol: ROLES.FULL,
                        activo: true
                    };
                    setCurrentUser(currentUserData);
                    console.log('[admin] legacy admin user, treating as FULL');
                } else {
                    // Nuevo usuario de Auth sin documento en Firestore: crear cuenta automática (PENDIENTE de asignación de rol)
                    try {
                        const today = new Date();
                        await setDoc(doc(db, 'usuarios', auth.currentUser.uid), {
                            email: auth.currentUser.email,
                            nombre: auth.currentUser.displayName || auth.currentUser.email,
                            rol: 'PENDIENTE',
                            activo: true,
                            createdAt: today,
                            lastLogin: today
                        }, { merge: true });
                        currentUserData = {
                            uid: auth.currentUser.uid,
                            email: auth.currentUser.email,
                            nombre: auth.currentUser.displayName || auth.currentUser.email,
                            rol: 'PENDIENTE',
                            activo: true
                        };
                        setCurrentUser(currentUserData);
                        toast('Cuenta creada automáticamente. Rol PENDIENTE de asignación por el administrador.', 'info');
                    } catch (e) {
                        console.error('[admin] Error creando doc de usuario:', e);
                        currentUserData = null;
                        setCurrentUser(null);
                    }
                }
            }
        } catch (e) {
            console.error('[admin] Error loading user data:', e);
        }
    }
}

function isCurrentUserAdmin(user) {
    const validRols = [ROLES.MASTER, ROLES.FULL, ROLES.MARCADORES, 'PENDIENTE'];
    return user && (currentAdminUids.includes(user.uid) || (currentUserData && validRols.includes(currentUserData.rol)));
}

async function initializeAdminPanel(user) {
    if (!isCurrentUserAdmin(user)) {
        toast('No tenés permisos de administrador', 'error');
        await signOut(auth);
        return false;
    }
    if (currentUserData && currentUserData.activo === false) {
        toast('Tu cuenta está desactivada. Contactá al administrador.', 'error');
        await signOut(auth);
        return false;
    }
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('login-container-wrapper').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
    initTournamentSelector();
    await loadTournamentConfig();
    applyUIPermissions();
    const tid = getActiveTournamentId();
    console.log('[admin] initializeAdminPanel: tournamentId =', tid);
    if (!tid) {
        console.warn('[admin] No active tournament found. Showing torneos panel to create one.');
        toast('No hay torneo activo. Creá uno desde la pestaña Torneos.', 'error');
        _switchPanel('torneos');
        dataLoaded = true;
        renderPanel('torneos');
        return true;
    }
    if (getActiveTournamentIds().length > 1) await loadActiveTournamentNames(getActiveTournamentIds());
    updateTournamentSelector();
    const initialPanel = location.hash.replace('#', '') || 'jugadores';
    _switchPanel(initialPanel);
    panelLoading(document.getElementById('panel-' + initialPanel), 'Cargando...');
    await loadData();
    dataLoaded = true;
    history.replaceState({ panel: initialPanel }, '', '#' + initialPanel);
    _currentPanel = null;
    _switchPanel(initialPanel);
    return true;
}

function applyUIPermissions() {
    const rol = getCurrentUserRole();
    console.log('[admin] applyUIPermissions, rol:', rol);

    const tabsPorRol = {
        usuarios: [ROLES.MARCADORES],
        jugadores: [ROLES.MARCADORES],
        equipos: [ROLES.MARCADORES],
        torneos: [ROLES.MARCADORES],
        administracion: [ROLES.MARCADORES],
        categorias: [ROLES.MARCADORES],
        correos: [ROLES.MARCADORES]
    };

    Object.entries(tabsPorRol).forEach(([panel, rolesExcluidos]) => {
        const tab = document.querySelector('[data-panel="' + panel + '"]');
        if (tab) {
            tab.style.display = rolesExcluidos.includes(rol) ? 'none' : '';
        }
    });
}

// ── Auth ──
onAuthStateChanged(auth, async (user) => {
    console.log('[admin] onAuthStateChanged:', user ? user.email : 'logged out');
    if (user) {
        await loadAdminConfig();
        console.log('[admin] adminUids:', currentAdminUids);
        console.log('[admin] isUserAdmin:', isCurrentUserAdmin(user));
        await initializeAdminPanel(user);
    } else {
        document.getElementById('login-section').style.display = 'block';
        document.getElementById('login-container-wrapper').style.display = 'block';
        document.getElementById('admin-panel').style.display = 'none';
    }
});

document.getElementById('login-btn').addEventListener('click', async () => {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errDiv = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');
    if (!email || !password) { errDiv.textContent = 'Ingresá email y contraseña'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.1rem;animation:spin 1s linear infinite;">progress_activity</span> Ingresando...';
    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
        console.error('Login error:', e.code, e.message);
        const msgs = {
            'auth/invalid-credential': 'Email o contraseña incorrectos',
            'auth/user-not-found': 'No existe una cuenta con ese email',
            'auth/wrong-password': 'Contraseña incorrecta',
            'auth/too-many-requests': 'Demasiados intentos. Esperá unos minutos',
            'auth/network-request-failed': 'Error de conexión',
            'auth/invalid-email': 'Email inválido'
        };
        errDiv.textContent = msgs[e.code] || e.message;
        errDiv.style.display = 'block';
        toast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.1rem;">login</span> Ingresar';
    }
});

document.getElementById('logout-btn').addEventListener('click', async () => { await signOut(auth); });

// ── Tab Navigation ──
function _switchPanel(panelId) {
    if (_currentPanel === panelId) return;
    _currentPanel = panelId;
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-panel').forEach(el => el.classList.remove('active'));
    const btn = document.querySelector('[data-panel="' + panelId + '"]');
    if (btn) btn.classList.add('active');
    const content = document.getElementById('panel-' + panelId);
    if (content) content.classList.add('active');
    if (!dataLoaded) return;
    renderPanel(panelId);
}

window.showPanel = function(panelId) {
    history.pushState({ panel: panelId }, '', '#' + panelId);
    _switchPanel(panelId);
};

window.toast = toast;
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.refreshData = refreshData;
window.renderAdministracion = renderAdministracion;
window.sincronizarInscripciones = sincronizarInscripciones;
window.openFinanceModal = openFinanceModal;
window.closeFinanceModal = closeFinanceModal;
window.saveFinanceModal = saveFinanceModal;
window.deleteMovimiento = deleteMovimiento;
window.setFinanceFiltro = setFinanceFiltro;
window.actualizarTasasManual = actualizarTasasManual;

window.addEventListener('popstate', () => {
    const panel = (history.state && history.state.panel) || location.hash.replace('#', '') || 'jugadores';
    _switchPanel(panel);
});

document.getElementById('finance-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'finance-modal-overlay') closeFinanceModal();
});

document.getElementById('user-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'user-modal-overlay') closeUserModal();
});

// ── Data ──
async function loadData() {
    const tid = getActiveTournamentId();
    console.log('[admin] loadData() tournamentId:', tid);
    if (!tid) { console.warn('[admin] loadData: no active tournament ID'); return; }
    try {
        const [j, e, n] = await Promise.all([
            getDocs(query(col('jugadores'), orderBy('nombre'))),
            getDocs(query(col('equipos'), orderBy('nombre'))),
            getDocs(query(col('jornadas'), orderBy('numero')))
        ]);
        allJugadores = j.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        allEquipos = e.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        allJornadas = n.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        console.log('[admin] loadData:', allJugadores.length, 'jugadores,', allEquipos.length, 'equipos,', allJornadas.length, 'jornadas');
    } catch (e) { console.error('[admin] loadData error:', e); }
}

async function refreshData() {
    invalidatePartidosCache();
    _financeDirty = true;
    _tasasLoaded = false;
    await loadData();
    _currentPanel = null;
    if (drawSelectedJornadaId) {
        await loadDrawPartidos(drawSelectedJornadaId);
    }
    updateTournamentSelector();
    const active = document.querySelector('.admin-panel.active');
    if (active) renderPanel(active.id.replace('panel-', ''));
}

function updateTournamentSelector() {
    const wrap = document.getElementById('tournament-selector-wrap');
    const sel = document.getElementById('tournament-selector');
    if (!wrap || !sel) return;
    const ids = getActiveTournamentIds();
    if (ids.length <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const currentId = getActiveTournamentId();
    const tournaments = getTournaments();
    sel.innerHTML = ids.map(id => {
        const t = tournaments.find(x => x.id === id);
        const name = t ? (t.name || t.nombre) : (getTournamentName(id) || id);
        return '<option value="' + id + '"' + (id === currentId ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');
}

function initTournamentSelector() {
    const sel = document.getElementById('tournament-selector');
    if (!sel) return;
    sel.addEventListener('change', async () => {
        const newId = sel.value;
        if (newId === getActiveTournamentId()) return;
        showLoading('Cambiando torneo...');
        try {
            await setSelectedTournament(newId);
            const tournaments = getTournaments();
            const t = tournaments.find(x => x.id === newId);
            if (t) {
                const { setActiveTournament: setT } = await import('./tournamentRefs.js');
                setT(newId, { id: newId, ...t });
            }
            _financeDirty = true;
            _financeMovimientosCache = [];
            _tasasLoaded = false;
            await loadData();
            updateTournamentSelector();
            const active = document.querySelector('.admin-panel.active');
            if (active) renderPanel(active.id.replace('panel-', ''));
            toast('Torneo cambiado', 'success');
        } catch (e) {
            toast('Error al cambiar torneo', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    });
}

function renderPanel(panelId) {
    if (!canRead(panelId)) {
        const panel = document.getElementById('panel-' + panelId);
        if (panel) {
            panel.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;">' +
                '<span class="material-symbols-outlined" style="font-size:2rem;color:var(--error);">block</span>' +
                '<p style="margin-top:0.5rem;">No tenés acceso a este módulo.</p></div>';
        }
        return;
    }
    if (panelId !== 'torneos' && panelId !== 'usuarios' && !getActiveTournamentId()) {
        const panel = document.getElementById('panel-' + panelId);
        if (panel) {
            panel.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;">' +
                '<span class="material-symbols-outlined" style="font-size:2rem;color:var(--primary);">info</span>' +
                '<p style="margin-top:0.5rem;">No hay torneo activo. Creá uno desde la pestaña <strong>Torneos</strong>.</p></div>';
        }
        return;
    }
    switch (panelId) {
        case 'jugadores': renderJugadores(); break;
        case 'equipos': renderEquipos(); break;
        case 'draw': renderDraw(); break;
        case 'resultados': renderResultados(); break;
        case 'posiciones': renderPosiciones(); break;
        case 'jornadas': renderJornadas(); break;
        case 'semifinales': renderSemifinales(); break;
        case 'final': renderFinal(); break;
        case 'torneos': renderTournamentPanel(); break;
        case 'administracion': renderAdministracion(); break;
        case 'usuarios': renderUsuarios(); break;
        case 'categorias': renderCategorias(); break;
        case 'correos': renderCorreos(); break;
    }
}

// ═══════════════════════════════════════════
// JUGADORES
// ═══════════════════════════════════════════
function renderJugadores() {
    const panel = document.getElementById('panel-jugadores');
    const equipoOpts = allEquipos.map(e =>
        '<option value="' + e.id + '">' + esc(e.nombre) + '</option>'
    ).join('');
    const catOpts = CATEGORIAS_JUGADOR.map(c => '<option>' + c + '</option>').join('');

    panel.innerHTML =
        '<div class="card">' +
        '<button class="collapse-toggle" id="j-toggle-form" type="button" aria-expanded="false">' +
        '<span class="collapse-toggle-left"><span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">person_add</span> Nuevo Jugador</span>' +
        '<span class="material-symbols-outlined chevron">expand_more</span>' +
        '</button>' +
        '<div id="j-form-body" style="display:none;">' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Nombres *</label><input type="text" id="j-nombre" placeholder="Nombres"></div>' +
        '<div class="form-group"><label>Apellidos *</label><input type="text" id="j-apellidos" placeholder="Apellidos"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Género *</label><select id="j-genero"><option value="">— Seleccionar —</option><option>Masculino</option><option>Femenino</option></select></div>' +
        '<div class="form-group"><label>Categoría *</label><select id="j-categoria"><option value="">— Seleccionar —</option>' + catOpts + '</select></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Equipo</label><select id="j-equipo"><option value="">— Sin equipo —</option>' + equipoOpts + '</select></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Teléfono *</label><input type="tel" id="j-telefono" placeholder="Teléfono"></div>' +
        '<div class="form-group"><label>Email *</label><input type="email" id="j-email" placeholder="Email"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Nro Socio</label><input type="text" id="j-numero-socio" placeholder="Número de Socio"></div>' +
        '<div class="form-group"><label>Status Socio *</label><select id="j-status-socio"><option value="">— Seleccionar —</option><option>Socio</option><option>Invitado Deportivo</option></select></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Método de Pago *</label><select id="j-metodo-pago"><option value="">— Seleccionar —</option><option>Efectivo Dólares</option><option>Pago Móvil</option><option>Otro</option></select></div>' +
        '</div>' +
        '<div id="j-pago-movil-fields" style="display:none;">' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Monto (Bs)</label><input type="number" step="0.01" id="j-monto" placeholder="Ej: 350,00"></div>' +
        '<div class="form-group"><label>Teléfono Pago Móvil</label><input type="tel" id="j-telefono-movil" placeholder="Tel desde donde pagó"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Comprobante (URL)</label><input type="text" id="j-comprobante" placeholder="https://..."></div>' +
        '</div>' +
        '</div>' +
        '<div id="j-monto-usd-fields" style="display:none;">' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Monto (USD)</label><input type="number" step="0.01" id="j-monto-usd" placeholder="Ej: 25,00"></div>' +
        '</div>' +
        '</div>' +
        '<div id="j-descripcion-fields" style="display:none;">' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Descripción Método</label><input type="text" id="j-descripcion-metodo" placeholder="Ej: Binance, Zelle..."></div>' +
        '</div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Fecha Operación</label><input type="date" id="j-fecha-pago"></div>' +
        '<div class="form-group" id="j-numero-operacion-field"><label>Nro Operación</label><input type="text" id="j-numero-operacion" placeholder="Nro de referencia"></div>' +
        '</div>' +
        '<div class="checkbox-group"><input type="checkbox" id="j-pago"><label for="j-pago"><span class="material-symbols-outlined" style="font-size:1rem;color:var(--primary);">payments</span> Pago Recibido</label></div>' +
        '<div class="checkbox-group"><input type="checkbox" id="j-exonerado"><label for="j-exonerado"><span class="material-symbols-outlined" style="font-size:1rem;color:var(--secondary);">sell</span> Exonerado de pago</label></div>' +
        '<button class="btn btn-primary btn-block" id="btn-add-jugador"><span class="material-symbols-outlined" style="font-size:1rem;">person_add</span> Agregar Jugador</button>' +
        '</div>' +
        '</div>' +
        '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">groups</span> Jugadores Inscritos</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem;">' +
        '<input type="file" id="csv-file-input" accept=".csv" style="display:none;">' +
        '<button class="btn btn-outline" id="btn-import-csv"><span class="material-symbols-outlined" style="font-size:1rem;">upload_file</span> Importar CSV</button>' +
        '<span id="csv-file-name" style="font-size:0.75rem;color:var(--on-surface-variant-30);"></span>' +
        '</div>' +
        '<div id="csv-preview" style="display:none;"></div>' +
        '<div class="search-bar"><span class="material-symbols-outlined search-icon">search</span><input type="text" id="jugador-search" placeholder="Buscar por nombre, categoría, email..." value="' + esc(jugadorSearchTerm) + '"></div>' +
        '<div id="jugadores-list"></div>';

    document.getElementById('j-toggle-form').addEventListener('click', () => {
        const open = document.getElementById('j-form-body').style.display !== 'none';
        toggleJugadorForm(!open);
    });
    document.getElementById('btn-add-jugador').onclick = () => safeAction(addJugador);
    document.getElementById('jugador-search').addEventListener('input', (e) => {
        jugadorSearchTerm = e.target.value;
        clearTimeout(_debounceTimers.get('jugador'));
        _debounceTimers.set('jugador', setTimeout(() => renderJugadoresList(), 150));
    });
    document.getElementById('btn-import-csv').addEventListener('click', () => {
        document.getElementById('csv-file-input').click();
    });
    document.getElementById('csv-file-input').addEventListener('change', handleCSVFile);
    const metodoSelect = document.getElementById('j-metodo-pago');
    metodoSelect.addEventListener('change', () => toggleJugadorMetodoPago());
    toggleJugadorMetodoPago();
    const pagoCheckbox = document.getElementById('j-pago');
    if (pagoCheckbox) {
        pagoCheckbox.addEventListener('change', function(e) {
            if (this.checked) { // trying to check
                const metodo = document.getElementById('j-metodo-pago').value;
                if (!metodo) {
                    toast('Seleccioná el método de pago', 'error');
                    this.checked = false;
                }
            } else { // trying to uncheck
                const metodo = document.getElementById('j-metodo-pago').value;
                const montoUsd = parseFloat(document.getElementById('j-monto-usd').value) || 0;
                const montoBs = parseFloat(document.getElementById('j-monto').value) || 0;
                const descripcion = document.getElementById('j-descripcion-metodo').value.trim();
                const telefono = document.getElementById('j-telefono-movil').value.trim();
                const comprobante = document.getElementById('j-comprobante').value.trim();
                const hasPaymentData = metodo || montoUsd > 0 || montoBs > 0 || descripcion || telefono || comprobante;
                if (hasPaymentData) {
                    toast('Al desmarcar Pago Recibido, se perderán los datos de método de pago y monto.', 'warning');
                }
            }
        });
    }
    renderJugadoresList();
}

function toggleJugadorMetodoPago() {
    const metodo = document.getElementById('j-metodo-pago');
    const pm = document.getElementById('j-pago-movil-fields');
    const usd = document.getElementById('j-monto-usd-fields');
    const desc = document.getElementById('j-descripcion-fields');
    const opField = document.getElementById('j-numero-operacion-field');
    if (!metodo) return;
    const v = metodo.value;
    if (pm) pm.style.display = v === 'Pago Móvil' ? 'block' : 'none';
    if (usd) usd.style.display = (v === 'Efectivo Dólares' || v === 'Otro') ? 'block' : 'none';
    if (desc) desc.style.display = v === 'Otro' ? 'block' : 'none';
    if (opField) opField.style.display = v === 'Pago Móvil' ? 'block' : 'none';
}

function toggleJugadorForm(open) {
    const body = document.getElementById('j-form-body');
    const btn = document.getElementById('j-toggle-form');
    if (!body || !btn) return;
    body.style.display = open ? 'block' : 'none';
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function renderJugadoresList() {
    const listEl = document.getElementById('jugadores-list');
    if (!listEl) return;
    const sorted = [...allJugadores].sort((a, b) => {
        const nA = (a.nombre || '').toLowerCase();
        const nB = (b.nombre || '').toLowerCase();
        if (nA !== nB) return nA.localeCompare(nB);
        return (a.apellidos || '').toLowerCase().localeCompare((b.apellidos || '').toLowerCase());
    });
    const term = jugadorSearchTerm.toLowerCase();
    const filtered = term ? sorted.filter(j => {
        const haystack = [j.nombre, j.apellidos, j.categoria, j.telefono, j.email].join(' ').toLowerCase();
        return haystack.includes(term);
    }) : sorted;

    const title = document.querySelector('#panel-jugadores .admin-section-title');
    if (title) {
        const countBadge = filtered.length !== allJugadores.length
            ? ' de ' + allJugadores.length : '';
        title.innerHTML =
            '<div style="display:flex;align-items:center;gap:0.5rem;width:100%;">' +
                '<span><span class="material-symbols-outlined" style="font-size:0.9rem;">groups</span> Jugadores Inscritos (' + filtered.length + countBadge + ')</span>' +
                '<button class="btn btn-outline btn-collapse-all" id="btn-collapse-details" type="button">' +
                    '<span class="material-symbols-outlined">unfold_less</span> Esconder detalles' +
                '</button>' +
            '</div>';
    }

    listEl.innerHTML =
        (!filtered.length ? '<div class="empty-state" style="padding:1.5rem;"><span class="material-symbols-outlined">' + (term ? 'search_off' : 'group_off') + '</span><p>' + (term ? 'No se encontraron resultados' : 'No hay jugadores inscritos') + '</p></div>' : '') +
        filtered.map(j => {
            const teamName = getTeamName(j.equipo_id);
            const teamColor = getTeamColor(j.equipo_id);
            const teamBadge = j.equipo_id
                ? '<span class="badge" style="background:' + teamColor + '22;color:' + teamColor + ';border:1px solid ' + teamColor + '44;"><span class="material-symbols-outlined" style="font-size:0.55rem;">palette</span> ' + esc(teamName) + '</span>'
                : '';
            const statusBadge = j.status_socio
                ? '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);">' + esc(j.status_socio) + '</span>'
                : '';
            const catBadge = j.categoria
                ? '<span class="badge" style="background:var(--primary-12);color:var(--primary);">' + esc(j.categoria) + '</span>'
                : '';
            let pagoBadge;
            if (j.exonerado) {
                pagoBadge = '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant);"><span class="material-symbols-outlined" style="font-size:0.6rem;">sell</span> Exonerado</span>';
            } else if (j.pago_recibido) {
                const metodo = j.metodo_pago || 'Pago';
                let detail = '';
                if (metodo === 'Pago Móvil') {
                    const montoStr = j.monto ? formatBs(j.monto) : '';
                    if (montoStr) detail += ' · ' + montoStr;
                    if (j.telefono_movil) detail += ' · Tel ' + esc(j.telefono_movil);
                    if (j.numero_operacion) detail += ' · Op: ' + esc(j.numero_operacion);
                    if (j.comprobante) detail += ' · <a href="' + esc(j.comprobante) + '" target="_blank" rel="noopener" style="color:var(--primary);">🧾</a>';
                } else if (metodo === 'Efectivo Dólares') {
                    if (j.monto_usd) detail += ' · $' + (+j.monto_usd).toFixed(2);
                } else if (metodo === 'Otro') {
                    if (j.descripcion_metodo) detail += ' · ' + esc(j.descripcion_metodo);
                    if (j.monto_usd) detail += ' · $' + (+j.monto_usd).toFixed(2);
                    if (j.numero_operacion) detail += ' · Op: ' + esc(j.numero_operacion);
                } else if (j.numero_operacion || j.fecha_pago) {
                    detail = ' · Op: ' + esc(j.numero_operacion || '') + (j.fecha_pago ? ' ' + esc(j.fecha_pago) : '');
                }
                pagoBadge = '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">check</span> ' + esc(metodo) + detail + '</span>';
            } else {
                pagoBadge = '<span class="badge badge-danger"><span class="material-symbols-outlined" style="font-size:0.6rem;">close</span> Sin pago</span>';
            }

            const detailRow = (label, value, opts) => {
                if (value === undefined || value === null || value === '') return '';
                const cls = 'detail-value' + (opts?.mono ? ' mono' : '') + (opts?.muted ? ' muted' : '');
                const isUrl = /^https?:\/\//i.test(String(value));
                const valHtml = isUrl
                    ? '<a href="' + esc(value) + '" target="_blank" rel="noopener">' + esc(value) + '</a>'
                    : esc(String(value));
                return '<div class="detail-item"><span class="detail-label">' + esc(label) + '</span><span class="' + cls + '">' + valHtml + '</span></div>';
            };
            const details = '<div class="details-grid">' +
                detailRow('ID', j.id, { mono: true }) +
                detailRow('Nombre', j.nombre) +
                detailRow('Apellidos', j.apellidos) +
                detailRow('Email', j.email) +
                detailRow('Teléfono', j.telefono) +
                detailRow('Género', j.genero) +
                detailRow('Categoría', j.categoria) +
                detailRow('Status socio', j.status_socio) +
                detailRow('N° socio', j.numero_socio) +
                detailRow('Equipo', teamName) +
                detailRow('Pago recibido', j.pago_recibido ? 'Sí' : 'No') +
                detailRow('Exonerado', j.exonerado ? 'Sí' : 'No') +
                detailRow('Método de pago', j.metodo_pago) +
                detailRow('Fecha pago', j.fecha_pago) +
                detailRow('Monto (Bs)', j.monto ? formatBs(j.monto) : '') +
                detailRow('Monto (USD)', j.monto_usd ? '$' + (+j.monto_usd).toFixed(2) : '') +
                detailRow('Teléfono móvil', j.telefono_movil) +
                detailRow('N° operación', j.numero_operacion) +
                detailRow('Descripción método', j.descripcion_metodo) +
                detailRow('Comprobante', j.comprobante) +
                detailRow('Payment protected', j.payment_protected ? 'Sí' : 'No', { muted: true }) +
                '</div>';

            const isOpen = jugadorAbiertoId === j.id;
            return '<div class="player-card' + (isOpen ? ' open' : '') + '" data-jugador-id="' + j.id + '">' +
            '<div class="player-header">' +
                '<div class="player-main">' +
                    '<div class="player-name">' + shortName(j, true) + '</div>' +
                    '<div class="player-meta">' +
                    (j.telefono ? '<span class="material-symbols-outlined" style="font-size:0.75rem;">phone</span> ' + esc(j.telefono) + ' · ' : '') +
                    (j.email ? '<span class="material-symbols-outlined" style="font-size:0.75rem;">email</span> ' + esc(j.email) : '') +
                    '</div>' +
                    '<div style="margin-top:0.25rem;display:flex;flex-wrap:wrap;gap:0.3rem;">' +
                    catBadge + statusBadge + teamBadge + pagoBadge +
                    '</div>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:0.4rem;">' +
                    '<span class="material-symbols-outlined player-chev">expand_more</span>' +
                    '<button type="button" class="btn btn-sm btn-outline" data-edit-jugador="' + j.id + '" title="Editar"><span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span></button>' +
                    '<button type="button" class="btn btn-sm btn-danger" data-del-jugador="' + j.id + '" title="Eliminar"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' +
                '</div>' +
            '</div>' +
            '<div class="player-details">' + details + '</div>' +
            '</div>';
        }).join('');

    listEl.querySelectorAll('[data-edit-jugador]').forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation();
        editJugador(b.dataset.editJugador);
    }));
    listEl.querySelectorAll('[data-del-jugador]').forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation();
        safeAction(() => deleteJugador(b.dataset.delJugador));
    }));

    listEl.querySelectorAll('.player-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-edit-jugador]') || e.target.closest('[data-del-jugador]')) return;
            const id = card.dataset.jugadorId;
            const wasOpen = card.classList.contains('open');
            listEl.querySelectorAll('.player-card.open').forEach(c => c.classList.remove('open'));
            if (!wasOpen) {
                card.classList.add('open');
                jugadorAbiertoId = id;
                requestAnimationFrame(() => {
                    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
            } else {
                jugadorAbiertoId = null;
            }
            updateCollapseAllButton();
        });
    });

    const collapseBtn = document.getElementById('btn-collapse-details');
    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            listEl.querySelectorAll('.player-card.open').forEach(c => c.classList.remove('open'));
            jugadorAbiertoId = null;
            updateCollapseAllButton();
        });
    }
    updateCollapseAllButton();
}

function updateCollapseAllButton() {
    const btn = document.getElementById('btn-collapse-details');
    if (!btn) return;
    const listEl = document.getElementById('jugadores-list');
    const hasOpen = listEl ? listEl.querySelectorAll('.player-card.open').length > 0 : false;
    btn.classList.toggle('visible', hasOpen);
}

async function addJugador() {
    const data = {
        nombre: document.getElementById('j-nombre').value.trim(),
        apellidos: document.getElementById('j-apellidos').value.trim(),
        genero: document.getElementById('j-genero').value,
        categoria: document.getElementById('j-categoria').value,
        telefono: document.getElementById('j-telefono').value.trim(),
        email: document.getElementById('j-email').value.trim(),
        pago_recibido: document.getElementById('j-pago').checked,
        exonerado: document.getElementById('j-exonerado').checked,
        equipo_id: document.getElementById('j-equipo').value || null,
        numero_socio: document.getElementById('j-numero-socio').value.trim(),
        status_socio: document.getElementById('j-status-socio').value,
        metodo_pago: document.getElementById('j-metodo-pago').value,
        fecha_pago: document.getElementById('j-fecha-pago').value.trim(),
        numero_operacion: document.getElementById('j-numero-operacion').value.trim(),
        monto: parseFloat(document.getElementById('j-monto').value) || 0,
        telefono_movil: document.getElementById('j-telefono-movil').value.trim(),
        comprobante: document.getElementById('j-comprobante').value.trim(),
        monto_usd: parseFloat(document.getElementById('j-monto-usd').value) || 0,
        descripcion_metodo: document.getElementById('j-descripcion-metodo').value.trim(),
        payment_protected: true,
        payment_protected: true
    };
    if (!data.nombre || !data.apellidos) { toast('Nombre y apellidos requeridos', 'error'); return; }
    if (!data.genero) { toast('Seleccioná el género', 'error'); return; }
    if (!data.categoria) { toast('Seleccioná la categoría', 'error'); return; }
    if (!data.telefono) { toast('Ingresá el teléfono', 'error'); return; }
    if (!data.email) { toast('Ingresá el email', 'error'); return; }
    if (!data.status_socio) { toast('Seleccioná el status de socio', 'error'); return; }
    if (!data.metodo_pago) { toast('Seleccioná el método de pago', 'error'); return; }
    showLoading('Agregando jugador...');
    try {
        const ref = await addDoc(col('jugadores'), data);
        toast('Jugador agregado', 'success');
        if (data.pago_recibido) {
            await syncInscripcionIngreso(ref.id);
        }
        sendWelcomeEmail(data, ref.id);
        await refreshData();
    } catch (e) {
        toast('Error al agregar jugador', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

function sendWelcomeEmail(jugadorData, jugadorId) {
    const tid = getActiveTournamentId();
    if (!tid || !jugadorData.email) return;
    const fn = httpsCallable(functions, 'emailSendBienvenida');
    fn({
        torneoId: tid,
        toEmail: jugadorData.email,
        toNombre: (jugadorData.nombre || '') + ' ' + (jugadorData.apellidos || ''),
        jugadorId
    }).catch(err => {
        console.warn('[correos] No se pudo enviar bienvenida:', err.message || err);
    });
}

function editJugador(id) {
    const j = allJugadores.find(x => x.id === id);
    if (!j) return;
    const equipoOpts = allEquipos.map(e =>
        '<option value="' + e.id + '">' + esc(e.nombre) + '</option>'
    ).join('');
    const catOpts = CATEGORIAS_JUGADOR.map(c => '<option>' + c + '</option>').join('');
    document.getElementById('j-nombre').value = j.nombre || '';
    document.getElementById('j-apellidos').value = j.apellidos || '';
    document.getElementById('j-genero').value = j.genero || '';
    document.getElementById('j-categoria').value = j.categoria || '';
    document.getElementById('j-telefono').value = j.telefono || '';
    document.getElementById('j-email').value = j.email || '';
    document.getElementById('j-pago').checked = j.pago_recibido || false;
    const exoneradoEl = document.getElementById('j-exonerado');
    if (exoneradoEl) exoneradoEl.checked = j.exonerado || false;
    document.getElementById('j-numero-socio').value = j.numero_socio || '';
    document.getElementById('j-status-socio').value = j.status_socio || '';
    document.getElementById('j-metodo-pago').value = j.metodo_pago || '';
    document.getElementById('j-fecha-pago').value = j.fecha_pago ? formatDateToYYYYMMDD(j.fecha_pago) : '';
    document.getElementById('j-numero-operacion').value = j.numero_operacion || '';
    document.getElementById('j-monto').value = j.monto || '';
    document.getElementById('j-telefono-movil').value = j.telefono_movil || '';
    document.getElementById('j-comprobante').value = j.comprobante || '';
    document.getElementById('j-monto-usd').value = j.monto_usd || '';
    document.getElementById('j-descripcion-metodo').value = j.descripcion_metodo || '';
    toggleJugadorMetodoPago();
    const equipoSelect = document.getElementById('j-equipo');
    if (equipoSelect) {
        equipoSelect.innerHTML = '<option value="">— Sin equipo —</option>' + equipoOpts;
        equipoSelect.value = j.equipo_id || '';
    }
    const catSelect = document.getElementById('j-categoria');
    if (catSelect) {
        catSelect.innerHTML = '<option value="">— Seleccionar —</option>' + catOpts;
        catSelect.value = j.categoria || '';
    }
    const btn = document.getElementById('btn-add-jugador');
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar Cambios';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-warning');
    btn.onclick = async () => {
        showLoading('Guardando cambios...');
        try {
            const update = {
                nombre: document.getElementById('j-nombre').value.trim(),
                apellidos: document.getElementById('j-apellidos').value.trim(),
                genero: document.getElementById('j-genero').value,
                categoria: document.getElementById('j-categoria').value,
                telefono: document.getElementById('j-telefono').value.trim(),
                email: document.getElementById('j-email').value.trim(),
                pago_recibido: document.getElementById('j-pago').checked,
                exonerado: document.getElementById('j-exonerado').checked,
                equipo_id: document.getElementById('j-equipo').value || null,
                numero_socio: document.getElementById('j-numero-socio').value.trim(),
                status_socio: document.getElementById('j-status-socio').value,
                metodo_pago: document.getElementById('j-metodo-pago').value,
fecha_pago: formatDateToDDMM(document.getElementById('j-fecha-pago').value),
                numero_operacion: document.getElementById('j-numero-operacion').value.trim(),
                monto: parseFloat(document.getElementById('j-monto').value) || 0,
                telefono_movil: document.getElementById('j-telefono-movil').value.trim(),
                comprobante: document.getElementById('j-comprobante').value.trim(),
                monto_usd: parseFloat(document.getElementById('j-monto-usd').value) || 0,
                descripcion_metodo: document.getElementById('j-descripcion-metodo').value.trim()
            };
            await updateDoc(docRef('jugadores', id), update);
            toast('Jugador actualizado', 'success');
            if (update.pago_recibido) {
                await syncInscripcionIngreso(id);
            }
            await refreshData();
        } catch (e) {
            toast('Error al actualizar', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    };
    toggleJugadorForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteJugador(id) {
    if (!confirm('¿Eliminar este jugador?')) return;
    showLoading('Eliminando jugador...');
    try {
        await deleteDoc(docRef('jugadores', id));
        toast('Jugador eliminado', 'success');
        await refreshData();
    } catch (e) {
        toast('Error al eliminar', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ═══════════════════════════════════════════
// CSV IMPORT
// ═══════════════════════════════════════════
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
        else { current += ch; }
    }
    result.push(current.trim());
    return result;
}

function parseMontoCSV(raw) {
    if (!raw) return 0;
    let v = String(raw).trim();
    v = v.replace(/[^\d.,\-]/g, '');
    if (!v) return 0;
    const neg = v.startsWith('-');
    v = v.replace(/-/g, '');
    const parts = v.split(',');
    const lastPart = parts[parts.length - 1];
    if (parts.length > 1 && lastPart.length <= 2) {
        v = parts[0].replace(/\./g, '') + '.' + lastPart;
    } else {
        v = v.replace(/,/g, '');
    }
    const n = parseFloat(v);
    if (isNaN(n)) return 0;
    return neg ? -n : n;
}

function handleCSVFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const nameEl = document.getElementById('csv-file-name');
    if (nameEl) nameEl.textContent = file.name;
    const reader = new FileReader();
    reader.onload = (evt) => {
        handleCSVText(evt.target.result, file.name);
    };
    reader.readAsText(file);
    e.target.value = '';
}

function handleCSVText(text, sourceLabel) {
    const nameEl = document.getElementById('csv-file-name');
    if (nameEl) nameEl.textContent = sourceLabel || 'Google Sheets';
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) { toast('El CSV está vacío', 'error'); return; }
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
    const colMap = {
        nombre: headers.findIndex(h => h.includes('nombre')),
        apellidos: headers.findIndex(h => h.includes('apellido')),
        genero: headers.findIndex(h => h.includes('genero') || h.includes('género')),
        categoria: headers.findIndex(h => h.includes('categ')),
        telefono: headers.findIndex(h => h.includes('telefono') || h.includes('teléfono')),
        email: headers.findIndex(h => h.includes('correo') || h.includes('email')),
        pago: headers.findIndex(h => h.includes('pago') && !h.includes('metodo') && !h.includes('método') && !h.includes('📱') && !h.includes('comprobante') && !h.includes('monto')),
        status_socio: headers.findIndex(h => h.includes('status')),
        numero_socio: headers.findIndex(h => h.includes('socio')),
        metodo_pago: headers.findIndex(h => h.includes('metodo') || h.includes('método')),
        numero_operacion: headers.findIndex(h => h.includes('operación') || h.includes('operacion') || h.includes('referencia')),
        fecha_pago: headers.findIndex(h => h.includes('fecha')),
        monto: headers.findIndex(h => h.includes('monto')),
        telefono_movil: headers.findIndex(h => h.includes('pago móvil')),
        comprobante: headers.findIndex(h => h.includes('comprobante'))
    };
    if (colMap.nombre === -1 || colMap.email === -1) {
        toast('El CSV no tiene las columnas esperadas (Nombre, Correo)', 'error'); return;
    }
    const existingEmails = new Set(allJugadores.map(j => (j.email || '').toLowerCase().trim()));
    const playerByEmail = new Map(allJugadores.map(j => [(j.email || '').toLowerCase().trim(), j.id]));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const email = (cols[colMap.email] || '').toLowerCase().trim();
        if (!email) continue;
        const rawPago = colMap.pago !== -1 ? (cols[colMap.pago] || '').trim().toLowerCase() : '';
        const rawMetodo = colMap.metodo_pago !== -1 ? (cols[colMap.metodo_pago] || '').trim() : '';
        let metodoPago = rawMetodo;
        if (rawMetodo.includes('Pago Móvil') || rawMetodo.includes('pago móvil') || rawMetodo.includes('pago movil')) metodoPago = 'Pago Móvil';
        const montoBs = parseMontoCSV(colMap.monto !== -1 ? (cols[colMap.monto] || '') : '');
        rows.push({
            nombre: (cols[colMap.nombre] || '').trim(),
            apellidos: (colMap.apellidos !== -1 ? (cols[colMap.apellidos] || '') : '').trim(),
            genero: (colMap.genero !== -1 ? (cols[colMap.genero] || '') : '').trim(),
            categoria: (colMap.categoria !== -1 ? (cols[colMap.categoria] || '') : '').trim(),
            telefono: (colMap.telefono !== -1 ? (cols[colMap.telefono] || '') : '').trim(),
            email: email,
            pago_recibido: rawPago === 'x',
            exonerado: rawPago === '0',
            status_socio: (colMap.status_socio !== -1 ? (cols[colMap.status_socio] || '') : '').trim(),
            numero_socio: (colMap.numero_socio !== -1 ? (cols[colMap.numero_socio] || '') : '').trim(),
            metodo_pago: metodoPago,
            numero_operacion: (colMap.numero_operacion !== -1 ? (cols[colMap.numero_operacion] || '') : '').trim(),
            fecha_pago: (colMap.fecha_pago !== -1 ? (cols[colMap.fecha_pago] || '') : '').trim(),
            monto: montoBs,
            telefono_movil: (colMap.telefono_movil !== -1 ? (cols[colMap.telefono_movil] || '') : '').trim(),
            comprobante: (colMap.comprobante !== -1 ? (cols[colMap.comprobante] || '') : '').trim(),
            _exists: existingEmails.has(email),
            id: playerByEmail.get(email) || null
        });
    }
    const nuevos = rows.filter(r => !r._exists);
    const existentes = rows.filter(r => r._exists);
    showCSVPreview(rows, nuevos, existentes);
}

function showCSVPreview(all, nuevos, existentes) {
    const el = document.getElementById('csv-preview');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML =
        '<div class="card">' +
        '<h3><span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--secondary);">upload_file</span> Preview Importación CSV</h3>' +
        '<div style="display:flex;gap:1rem;margin-bottom:0.75rem;flex-wrap:wrap;">' +
        '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">add_circle</span> ' + nuevos.length + ' nuevos</span>' +
        '<span class="badge"><span class="material-symbols-outlined" style="font-size:0.6rem;">check_circle</span> ' + existentes.length + ' ya existen</span>' +
        '</div>' +
        (nuevos.length ? '<div style="max-height:200px;overflow-y:auto;margin-bottom:0.75rem;">' +
            nuevos.map(j =>
                '<div style="font-size:0.8rem;padding:0.3rem 0;border-bottom:1px solid var(--white-5);color:var(--on-surface);">' +
                shortName(j) + ' — <span style="color:var(--on-surface-variant-30);">' + esc(j.email) + '</span>' +
                '</div>'
            ).join('') + '</div>' : '') +
        '<div class="btn-group-spaced">' +
        (nuevos.length ? '<button class="btn btn-primary" id="btn-confirm-import"><span class="material-symbols-outlined" style="font-size:1rem;">file_upload</span> Importar ' + nuevos.length + ' nuevos</button>' : '') +
        '<button class="btn btn-outline" id="btn-cancel-import"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div>' +
        '</div>';

    if (nuevos.length || existentes.length) {
        document.getElementById('btn-confirm-import').addEventListener('click', () => safeAction(() => confirmCSVImport(nuevos, existentes)));
    }
    document.getElementById('btn-cancel-import').addEventListener('click', () => { el.style.display = 'none'; el.innerHTML = ''; });
}

async function confirmCSVImport(nuevos, existentes) {
    showLoading('Importando ' + nuevos.length + ' nuevos y ' + existentes.length + ' existentes...');
    try {
        const batch = writeBatch(db);
        
        // Process new players
        nuevos.forEach(j => {
            const ref = docRefAuto('jugadores');
            batch.set(ref, {
                nombre: j.nombre,
                apellidos: j.apellidos,
                genero: j.genero || '',
                categoria: j.categoria || '',
                telefono: j.telefono,
                email: j.email,
                pago_recibido: j.pago_recibido || false,
                exonerado: j.exonerado || false,
                equipo_id: null,
                numero_socio: j.numero_socio || '',
                status_socio: j.status_socio || '',
                metodo_pago: j.metodo_pago || '',
                fecha_pago: j.fecha_pago || '',
                numero_operacion: j.numero_operacion || '',
                monto: j.monto || 0,
                telefono_movil: j.telefono_movil || '',
                comprobante: j.comprobante || '',
                monto_usd: j.monto_usd || 0,
                descripcion_metodo: j.descripcion_metodo || '',
                payment_protected: false  // CSV data comes from player form submissions
            });
        });
        
        // Process existing players - update non-payment fields always, payment fields only if not protected
        existentes.forEach(existing => {
            const ref = docRef('jugadores', existing.id);
            const currentData = allJugadores.find(j => j.id === existing.id);
            const updateData = {
                // Always update non-payment fields from CSV
                nombre: existing.nombre,
                apellidos: existing.apellidos,
                genero: existing.genero || '',
                categoria: existing.categoria || '',
                telefono: existing.telefono,
                email: existing.email,
                equipo_id: currentData?.equipo_id || null,
                numero_socio: existing.numero_socio || '',
                status_socio: existing.status_socio || ''
            };
            
            // Only update payment fields if not protected
            if (!currentData?.payment_protected) {
                updateData.metodo_pago = existing.metodo_pago || '';
                updateData.fecha_pago = existing.fecha_pago || '';
                updateData.numero_operacion = existing.numero_operacion || '';
                updateData.monto = existing.monto || 0;
                updateData.telefono_movil = existing.telefono_movil || '';
                updateData.comprobante = existing.comprobante || '';
                updateData.monto_usd = existing.monto_usd || 0;
                updateData.descripcion_metodo = existing.descripcion_metodo || '';
                updateData.pago_recibido = existing.pago_recibido || false;
                updateData.exonerado = existing.exonerado || false;
                // When updating via CSV, mark as not protected (since it came from form)
                updateData.payment_protected = false
            }
            
            batch.update(ref, updateData);
        });
        
        await batch.commit();
        toast(`${nuevos.length} jugadores nuevos importados, ${existentes.length} existentes actualizados`, 'success');
        await refreshData();
        await sincronizarInscripciones();
    } catch (e) {
        toast('Error al importar', 'error');
        console.error(e);
    } finally {
        hideLoading();
        document.getElementById('csv-preview').style.display = 'none';
        document.getElementById('csv-preview').innerHTML = '';
        document.getElementById('csv-file-name').textContent = '';
    }
}

// ═══════════════════════════════════════════
// EQUIPOS
// ═══════════════════════════════════════════
let editingEquipoId = null;
let viewingEquipoId = null;

async function safeAction(fn) {
    if (window._isBusy) return;
    window._isBusy = true;
    try { await fn(); } finally { window._isBusy = false; }
}

function getTeamQuantityConfig() {
    const t = getActiveTournament();
    if (!t || !t.teamConfig) return 5;
    return t.teamConfig.cantidad || 5;
}

async function saveTeamQuantity(cantidad) {
    const t = getActiveTournament();
    if (!t) return;
    try {
        const { updateDoc: upd, doc: d } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
        await upd(doc(db, 'torneos', t.id), { teamConfig: { cantidad } });
        if (t) t.teamConfig = { cantidad };
    } catch (e) {
        console.error('Error saving team quantity:', e);
    }
}

function renderEquipos() {
    const panel = document.getElementById('panel-equipos');
    const isEditing = !!editingEquipoId;
    const eq = isEditing ? allEquipos.find(x => x.id === editingEquipoId) : null;
    const teamQty = getTeamQuantityConfig();

    let html = '';

    // Team quantity configuration
    html += '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--secondary);">settings</span>' +
        '<span style="font-family:Lexend;font-weight:600;font-size:0.9rem;">Configuración del Torneo</span>' +
        '</div>' +
        '<div class="form-row" style="align-items:end;">' +
        '<div class="form-group" style="flex:1;margin-bottom:0;"><label>Cantidad de equipos</label>' +
        '<select id="team-quantity">' +
        '<option value="2"' + (teamQty === 2 ? ' selected' : '') + '>2</option>' +
        '<option value="3"' + (teamQty === 3 ? ' selected' : '') + '>3</option>' +
        '<option value="4"' + (teamQty === 4 ? ' selected' : '') + '>4</option>' +
        '<option value="5"' + (teamQty === 5 ? ' selected' : '') + '>5</option>' +
        '<option value="6"' + (teamQty === 6 ? ' selected' : '') + '>6</option>' +
        '<option value="7"' + (teamQty === 7 ? ' selected' : '') + '>7</option>' +
        '<option value="8"' + (teamQty === 8 ? ' selected' : '') + '>8</option>' +
        '</select></div>' +
        '<button class="btn btn-sm btn-primary" id="btn-save-qty"><span class="material-symbols-outlined" style="font-size:0.8rem;">save</span> Guardar</button>' +
        '</div>' +
        '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.5rem;">Equipos creados: <strong>' + allEquipos.length + '</strong> · Configurados: <strong>' + teamQty + '</strong></div>' +
        '</div>';

    // Create/Edit team form
    html += '<div class="card">' +
        '<button class="collapse-toggle" id="e-toggle-form" type="button" aria-expanded="' + (isEditing ? 'true' : 'false') + '">' +
        '<span class="collapse-toggle-left"><span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">palette</span> ' + (isEditing ? 'Editar Equipo' : 'Nuevo Equipo') + '</span>' +
        '<span class="material-symbols-outlined chevron">' + (isEditing ? 'expand_less' : 'expand_more') + '</span>' +
        '</button>' +
        '<div id="e-form-body" style="display:' + (isEditing ? 'block' : 'none') + ';">' +
        '<div class="form-group"><label>Nombre del equipo</label><input type="text" id="e-nombre" placeholder="Ej: Equipo Rojo" value="' + esc(eq?.nombre || '') + '"></div>' +
        '<div class="form-group"><label>Color</label><input type="color" id="e-color" value="' + (eq?.color || '#3fff8b') + '" style="height:40px;width:100%;cursor:pointer;"></div>' +
        '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-equipo"><span class="material-symbols-outlined" style="font-size:1rem;">' + (isEditing ? 'save' : 'add') + '</span> ' + (isEditing ? 'Actualizar' : 'Crear Equipo') + '</button>' +
        (isEditing ? '<button class="btn btn-outline" id="btn-cancel-equipo"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' : '') +
        '</div>' +
        '</div>' +
        '</div>';

    // Teams list
    if (allEquipos.length) {
        html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">palette</span> Equipos (' + allEquipos.length + ')</div>';
        html += allEquipos.map(e => {
            const players = getPlayersInTeam(e.id);
            const playerCount = players.length;
            return '<div class="card" style="border-left:4px solid ' + (e.color || '#888') + ';">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + (e.color || '#888') + ';margin-right:0.4rem;vertical-align:middle;"></span>' + esc(e.nombre || '') + '</div>' +
            '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.15rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.7rem;">groups</span> ' + playerCount + ' jugador' + (playerCount !== 1 ? 'es' : '') +
            '</div>' +
            '</div>' +
            '<div style="display:flex;gap:0.3rem;">' +
            '<button class="btn btn-sm btn-outline" data-view-team="' + e.id + '" title="Ver jugadores"><span class="material-symbols-outlined" style="font-size:0.8rem;">visibility</span></button>' +
            '<button class="btn btn-sm btn-outline" data-edit-equipo="' + e.id + '"><span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span></button>' +
            '<button class="btn btn-sm btn-danger" data-del-equipo="' + e.id + '"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' +
            '</div>' +
            '</div>' +
            '</div>';
        }).join('');
    } else {
        html += '<div class="empty-state" style="padding:1.5rem;"><span class="material-symbols-outlined">palette</span><p>No hay equipos creados. Creá el primero arriba.</p></div>';
    }

    // Team players view (if viewing a team)
    if (viewingEquipoId) {
        const viewTeam = allEquipos.find(e => e.id === viewingEquipoId);
        if (viewTeam) {
            const teamPlayers = getPlayersInTeam(viewingEquipoId);
            const unassignedPlayers = allJugadores.filter(j => !j.equipo_id);
            html += '<div class="card" style="border-top:3px solid ' + (viewTeam.color || '#888') + ';">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">' +
                '<div style="display:flex;align-items:center;gap:0.4rem;">' +
                '<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:' + (viewTeam.color || '#888') + ';"></span>' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.95rem;">' + esc(viewTeam.nombre) + '</span>' +
                '</div>' +
                '<button class="btn btn-sm btn-outline" id="btn-close-team-view"><span class="material-symbols-outlined" style="font-size:0.8rem;">close</span></button>' +
                '</div>';

            // Assign player to team
            if (unassignedPlayers.length > 0) {
                html += '<div class="form-row" style="align-items:end;margin-bottom:0.75rem;">' +
                    '<div class="form-group" style="flex:1;margin-bottom:0;"><label>Asignar jugador</label>' +
                    '<select id="assign-player-select">' +
                    '<option value="">— Seleccionar jugador —</option>' +
                    unassignedPlayers.map(j => '<option value="' + j.id + '">' + shortName(j) + '</option>').join('') +
                    '</select></div>' +
                    '<button class="btn btn-sm btn-primary" id="btn-assign-player"><span class="material-symbols-outlined" style="font-size:0.8rem;">person_add</span> Asignar</button>' +
                    '</div>';
            }

            // Current team players
            if (teamPlayers.length) {
                html += '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);margin-bottom:0.5rem;">Jugadores en este equipo (' + teamPlayers.length + ')</div>';
                html += teamPlayers.map(j =>
                    '<div class="player-card" style="margin-bottom:0.4rem;">' +
                    '<div class="player-main">' +
                    '<div class="player-name" style="font-size:0.82rem;">' + shortName(j, true) + '</div>' +
                    '</div>' +
                    '<div style="display:flex;gap:0.3rem;">' +
                    '<button class="btn btn-sm btn-outline" data-transfer-player="' + j.id + '" title="Cambiar de equipo"><span class="material-symbols-outlined" style="font-size:0.75rem;">swap_horiz</span></button>' +
                    '<button class="btn btn-sm btn-danger" data-unassign-player="' + j.id + '" title="Quitar del equipo"><span class="material-symbols-outlined" style="font-size:0.75rem;">person_remove</span></button>' +
                    '</div>' +
                    '</div>'
                ).join('');
            } else {
                html += '<div class="empty-state" style="padding:1rem;"><p style="font-size:0.8rem;">No hay jugadores en este equipo.</p></div>';
            }

            html += '</div>';
        }
    }

    panel.innerHTML = html;

    // Event listeners
    document.getElementById('btn-save-qty')?.addEventListener('click', () => safeAction(async () => {
        const qty = parseInt(document.getElementById('team-quantity').value);
        if (qty < 2 || qty > 8) { toast('Cantidad inválida', 'error'); return; }
        showLoading('Guardando configuración...');
        try {
            await saveTeamQuantity(qty);
            toast('Configuración guardada', 'success');
            await refreshData();
        } catch (e) {
            toast('Error al guardar', 'error');
        } finally {
            hideLoading();
        }
    }));

    document.getElementById('e-toggle-form')?.addEventListener('click', () => {
        const body = document.getElementById('e-form-body');
        const btn = document.getElementById('e-toggle-form');
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        btn.classList.toggle('open', !open);
        btn.querySelector('.chevron').textContent = open ? 'expand_more' : 'expand_less';
    });
    document.getElementById('btn-save-equipo')?.addEventListener('click', () => safeAction(saveEquipo));
    document.getElementById('btn-cancel-equipo')?.addEventListener('click', () => { editingEquipoId = null; renderEquipos(); });
    panel.querySelectorAll('[data-edit-equipo]').forEach(b => b.addEventListener('click', () => { editingEquipoId = b.dataset.editEquipo; viewingEquipoId = null; renderEquipos(); }));
    panel.querySelectorAll('[data-del-equipo]').forEach(b => b.addEventListener('click', () => safeAction(() => deleteEquipo(b.dataset.delEquipo))));
    panel.querySelectorAll('[data-view-team]').forEach(b => b.addEventListener('click', () => { viewingEquipoId = b.dataset.viewTeam; editingEquipoId = null; renderEquipos(); }));
    document.getElementById('btn-close-team-view')?.addEventListener('click', () => { viewingEquipoId = null; renderEquipos(); });

    // Assign player to team
    document.getElementById('btn-assign-player')?.addEventListener('click', () => safeAction(async () => {
        const playerId = document.getElementById('assign-player-select')?.value;
        if (!playerId) { toast('Seleccioná un jugador', 'error'); return; }
        showLoading('Asignando jugador...');
        try {
            await updateDoc(docRef('jugadores', playerId), { equipo_id: viewingEquipoId });
            toast('Jugador asignado', 'success');
            await refreshData();
        } catch (e) {
            toast('Error al asignar', 'error');
        } finally {
            hideLoading();
        }
    }));

    // Unassign player from team
    panel.querySelectorAll('[data-unassign-player]').forEach(b => b.addEventListener('click', () => safeAction(async () => {
        const playerId = b.dataset.unassignPlayer;
        showLoading('Quitando jugador del equipo...');
        try {
            await updateDoc(docRef('jugadores', playerId), { equipo_id: null });
            toast('Jugador quitado del equipo', 'success');
            await refreshData();
        } catch (e) {
            toast('Error al quitar jugador', 'error');
        } finally {
            hideLoading();
        }
    })));

    // Transfer player to another team
    panel.querySelectorAll('[data-transfer-player]').forEach(b => b.addEventListener('click', () => {
        const playerId = b.dataset.transferPlayer;
        const player = allJugadores.find(j => j.id === playerId);
        if (!player) return;
        const otherTeams = allEquipos.filter(e => e.id !== viewingEquipoId);
        if (otherTeams.length === 0) { toast('No hay otros equipos', 'error'); return; }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML =
            '<div class="modal">' +
            '<h3 style="font-size:0.95rem;">Cambiar equipo de ' + shortName(player, true) + '</h3>' +
            '<div class="form-group"><label>Nuevo equipo</label>' +
            '<select id="transfer-team-select">' +
            '<option value="">— Sin equipo —</option>' +
            otherTeams.map(e => '<option value="' + e.id + '">' + esc(e.nombre) + '</option>').join('') +
            '</select></div>' +
            '<div class="btn-group" style="justify-content:flex-end;">' +
            '<button class="btn btn-outline" id="btn-cancel-transfer">Cancelar</button>' +
            '<button class="btn btn-primary" id="btn-confirm-transfer">Transferir</button>' +
            '</div>' +
            '</div>';

        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('btn-cancel-transfer').addEventListener('click', () => overlay.remove());
        document.getElementById('btn-confirm-transfer').addEventListener('click', async () => {
            const newTeamId = document.getElementById('transfer-team-select').value;
            overlay.remove();
            showLoading('Transfiriendo jugador...');
            try {
                await updateDoc(docRef('jugadores', playerId), { equipo_id: newTeamId || null });
                toast('Jugador transferido', 'success');
                await refreshData();
            } catch (e) {
                toast('Error al transferir', 'error');
            } finally {
                hideLoading();
            }
        });
    }));
}

async function saveEquipo() {
    const nombre = document.getElementById('e-nombre').value.trim();
    const color = document.getElementById('e-color').value;
    if (!nombre) { toast('Ingresá un nombre', 'error'); return; }
    if (!color) { toast('Seleccioná un color', 'error'); return; }

    // Check for duplicate name
    const duplicateName = allEquipos.find(e => e.nombre.toLowerCase() === nombre.toLowerCase() && e.id !== editingEquipoId);
    if (duplicateName) { toast('Ya existe un equipo con ese nombre', 'error'); return; }

    showLoading(editingEquipoId ? 'Actualizando equipo...' : 'Creando equipo...');
    try {
        if (editingEquipoId) {
            await updateDoc(docRef('equipos', editingEquipoId), { nombre, color });
            toast('Equipo actualizado', 'success');
        } else {
            await addDoc(col('equipos'), { nombre, color, activo: true });
            toast('Equipo creado', 'success');
        }
        editingEquipoId = null;
        await refreshData();
    } catch (e) {
        toast('Error al guardar equipo', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

async function deleteEquipo(id) {
    const team = allEquipos.find(e => e.id === id);
    if (!team) return;

    // Check if team has players assigned
    const playersInTeam = getPlayersInTeam(id);
    if (playersInTeam.length > 0) {
        toast('No se puede eliminar: hay ' + playersInTeam.length + ' jugador(es) asignado(s). Quitá los jugadores primero.', 'error');
        return;
    }

    if (!confirm('¿Eliminar el equipo "' + team.nombre + '"?')) return;
    showLoading('Eliminando equipo...');
    try {
        await deleteDoc(docRef('equipos', id));
        toast('Equipo eliminado', 'success');
        if (viewingEquipoId === id) viewingEquipoId = null;
        await refreshData();
    } catch (e) {
        toast('Error al eliminar', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ═══════════════════════════════════════════
// DRAW — Categorías dinámicas (desde Firestore)
// ═══════════════════════════════════════════

let drawSelectedJornadaId = null;
let drawPartidos = [];
let editingPartidoId = null;

function partidoCol(jornadaId) {
    return collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId, 'partidos');
}

function partidoDocRef(jornadaId, partidoId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId, 'partidos', partidoId);
}

async function loadDrawPartidos(jornadaId) {
    drawPartidos = [];
    if (!jornadaId) return;
    try {
        const snap = await getDocs(partidoCol(jornadaId));
        drawPartidos = snap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
    } catch (e) {
        console.error('Error loading draw partidos:', e);
    }
}

async function renderDraw() {
    const panel = document.getElementById('panel-draw');

    if (drawSelectedJornadaId) {
        await renderDrawDetail(panel);
        return;
    }

    let html = '';
    html += '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">sports_tennis</span>' +
        '<span style="font-family:Lexend;font-weight:600;font-size:0.9rem;">Seleccionar Jornada</span>' +
        '</div>' +
        '<div class="form-group"><label>Jornada</label>' +
        '<select id="draw-jornada-select">' +
        '<option value="">— Seleccionar jornada —</option>' +
        allJornadas.map(j => {
            const teamAName = getTeamName(j.equipo_a_id) || '?';
            const teamBName = getTeamName(j.equipo_b_id) || '?';
            return '<option value="' + j.id + '">Jornada ' + j.numero + ' — ' + esc(teamAName) + ' VS ' + esc(teamBName) + '</option>';
        }).join('') +
        '</select></div>' +
        '</div>';

    if (allJornadas.length === 0) {
        html += '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">calendar_today</span><p>No hay jornadas creadas.<br>Creá jornadas desde el módulo Jornadas.</p></div>';
    }

    panel.innerHTML = html;

    document.getElementById('draw-jornada-select')?.addEventListener('change', (e) => {
        drawSelectedJornadaId = e.target.value || null;
        editingPartidoId = null;
        if (drawSelectedJornadaId) renderDraw();
    });
}

async function renderDrawDetail(panel) {
    await ensureCategorias();
    const jornada = allJornadas.find(j => j.id === drawSelectedJornadaId);
    if (!jornada) { drawSelectedJornadaId = null; renderDraw(); return; }

    const teamAName = getTeamName(jornada.equipo_a_id) || jornada.equipo_a_nombre || '?';
    const teamBName = getTeamName(jornada.equipo_b_id) || jornada.equipo_b_nombre || '?';
    const teamAColor = getTeamColor(jornada.equipo_a_id) || '#888';
    const teamBColor = getTeamColor(jornada.equipo_b_id) || '#888';

    if (!drawPartidos.length || drawPartidos[0]?._drawJornadaId !== drawSelectedJornadaId) {
        await loadDrawPartidos(drawSelectedJornadaId);
        drawPartidos.forEach(p => p._drawJornadaId = drawSelectedJornadaId);
    }

    let html = '';

    html += '<div class="card" style="border-top:3px solid var(--primary);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">' +
        '<div>' +
        '<div style="font-family:Lexend;font-weight:600;font-size:1rem;"><span class="material-symbols-outlined" style="font-size:1rem;color:var(--primary);vertical-align:middle;">sports_tennis</span> DRAW — Jornada ' + esc(String(jornada.numero || '')) + '</div>' +
        '<div style="font-size:0.82rem;color:var(--on-surface-variant-40);margin-top:0.15rem;">' + esc(getJornadaDateFormatted(jornada.fecha)) + '</div>' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.3rem;flex-wrap:wrap;">' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.9rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + teamAColor + ';"></span>' + esc(teamAName) +
        '</span>' +
        '<span style="font-family:Lexend;font-weight:800;font-size:0.85rem;color:var(--on-surface-variant-40);">VS</span>' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.9rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + teamBColor + ';"></span>' + esc(teamBName) +
        '</span>' +
        '</div>' +
        '</div>' +
        '<button class="btn btn-sm btn-outline" id="btn-back-draw-jornadas"><span class="material-symbols-outlined" style="font-size:0.8rem;">arrow_back</span></button>' +
        '</div>' +
        '</div>';

    const allCats = getDrawCategoriasTodas();
    const completeCount = allCats.filter(cat => drawPartidos.some(p => p.categoria === cat.nombre)).length;
    const allComplete = completeCount === allCats.length;

    html += '<div class="card" style="border-left:4px solid ' + (allComplete ? 'var(--secondary)' : 'var(--primary)') + ';">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
        '<div>' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">DRAW</div>' +
        '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">' +
        completeCount + ' / ' + allCats.length + ' categorías configuradas' +
        '</div>' +
        '</div>' +
        (allComplete
            ? '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">check_circle</span> Completo</span>'
            : '<span class="badge" style="background:var(--primary-container);color:var(--primary);">Incompleto</span>') +
        '</div>' +
        '</div>';

    if (!allComplete) {
        const missing = getDrawCategoriasActivas().filter(cat => !drawPartidos.some(p => p.categoria === cat.nombre));
        html += '<div class="card" style="border-left:4px solid var(--secondary);">' +
            '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);margin-bottom:0.3rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.7rem;">info</span> Pendientes:' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;">' +
            missing.map(cat =>
                '<span class="badge" style="background:var(--primary-container);color:var(--primary);">' + esc(formatCategoria(cat.nombre)) + '</span>'
            ).join('') +
            '</div>' +
            '</div>';
    }

    if (editingPartidoId) {
        html += renderPartidoForm(jornada);
    }

    html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_tennis</span> Partidos</div>';

    const teamAPlayers = getPlayersInTeam(jornada.equipo_a_id);
    const teamBPlayers = getPlayersInTeam(jornada.equipo_b_id);

    getDrawCategoriasTodas().forEach((cat, idx) => {
        const partido = drawPartidos.find(p => p.categoria === cat.nombre);
        const num = String(idx + 1).padStart(2, '0');
        const isInactive = cat.activa === false;

        if (partido) {
            const j1Name = getJugadorNombre(partido.jugador_a_1_id);
            const j2Name = getJugadorNombre(partido.jugador_a_2_id);
            const j3Name = getJugadorNombre(partido.jugador_b_1_id);
            const j4Name = getJugadorNombre(partido.jugador_b_2_id);
            const isEmpty = !partido.jugador_a_1_id && !partido.jugador_a_2_id && !partido.jugador_b_1_id && !partido.jugador_b_2_id;

            html += '<div class="card" style="margin-bottom:0.5rem;' + (isInactive ? 'border-left:4px solid var(--secondary);' : '') + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--primary);margin-bottom:0.3rem;">' + num + ' ' + esc(formatCategoria(cat.nombre)) + (isInactive ? ' <span class="badge" style="background:var(--secondary-container);color:var(--secondary);font-size:0.55rem;">INACTIVA</span>' : '') + '</div>';

            if (isEmpty) {
                html += '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">Sin jugadores asignados</div>';
            } else {
                html += '<div style="display:flex;flex-direction:column;gap:0.25rem;text-align:center;">' +
                    '<div style="font-size:0.78rem;display:flex;align-items:center;justify-content:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamAColor + ';"></span>' +
                    '<span style="font-weight:500;">' + (j1Name || '—') + paymentDotHtml(partido.jugador_a_1_id) + '</span>' +
                    '<span style="color:var(--on-surface-variant-40);">/</span>' +
                    '<span style="font-weight:500;">' + (j2Name || '—') + paymentDotHtml(partido.jugador_a_2_id) + '</span>' +
                    '</div>' +
                    '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);text-align:center;font-family:Lexend;font-weight:800;">VS</div>' +
                    '<div style="font-size:0.78rem;display:flex;align-items:center;justify-content:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamBColor + ';"></span>' +
                    '<span style="font-weight:500;">' + (j3Name || '—') + paymentDotHtml(partido.jugador_b_1_id) + '</span>' +
                    '<span style="color:var(--on-surface-variant-40);">/</span>' +
                    '<span style="font-weight:500;">' + (j4Name || '—') + paymentDotHtml(partido.jugador_b_2_id) + '</span>' +
                    '</div>' +
                    '</div>';
            }

            html += '</div>' +
                '<div style="display:flex;gap:0.3rem;">' +
                '<button class="btn btn-sm btn-outline" data-edit-partido="' + partido.id + '" title="Editar"><span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span></button>' +
                '<button class="btn btn-sm btn-danger" data-del-partido="' + partido.id + '" title="Eliminar"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' +
                '</div>' +
                '</div>' +
                '</div>';
        } else if (!isInactive) {
            html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid var(--on-surface-variant-40);">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div>' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--on-surface-variant-40);">' + num + ' ' + esc(formatCategoria(cat.nombre)) + '</div>' +
                '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">No configurado</div>' +
                '</div>' +
                '<button class="btn btn-sm btn-primary" data-add-partido="' + esc(cat.nombre) + '" title="Crear partido"><span class="material-symbols-outlined" style="font-size:0.8rem;">add</span></button>' +
                '</div>' +
                '</div>';
        }
    });

    panel.innerHTML = html;

    document.getElementById('btn-back-draw-jornadas')?.addEventListener('click', () => {
        drawSelectedJornadaId = null;
        drawPartidos = [];
        editingPartidoId = null;
        renderDraw();
    });

    panel.querySelectorAll('[data-add-partido]').forEach(b => b.addEventListener('click', () => {
        editingPartidoId = '__new__' + b.dataset.addPartido;
        renderDraw();
    }));

    panel.querySelectorAll('[data-edit-partido]').forEach(b => b.addEventListener('click', () => {
        editingPartidoId = b.dataset.editPartido;
        renderDraw();
    }));

    panel.querySelectorAll('[data-del-partido]').forEach(b => b.addEventListener('click', () => safeAction(() => deletePartido(b.dataset.delPartido))));

    document.getElementById('btn-save-partido')?.addEventListener('click', () => safeAction(savePartido));
    document.getElementById('btn-cancel-partido')?.addEventListener('click', () => { editingPartidoId = null; renderDraw(); });

    const j1Sel = document.getElementById('dp-j1');
    const j2Sel = document.getElementById('dp-j2');
    const j3Sel = document.getElementById('dp-j3');
    const j4Sel = document.getElementById('dp-j4');

    if (j1Sel && j2Sel) {
        const updatePairOpts = () => {
            const j1Val = j1Sel.value;
            const j2Val = j2Sel.value;
            j2Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                teamAPlayers.filter(p => p.id !== j1Val).map(p =>
                    '<option value="' + p.id + '"' + (p.id === j2Val ? ' selected' : '') + '>' + shortName(p) + '</option>'
                ).join('');
        };
        j1Sel.addEventListener('change', updatePairOpts);
        j2Sel.addEventListener('change', updatePairOpts);
    }

    if (j3Sel && j4Sel) {
        const updatePairOpts = () => {
            const j3Val = j3Sel.value;
            const j4Val = j4Sel.value;
            j4Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                teamBPlayers.filter(p => p.id !== j3Val).map(p =>
                    '<option value="' + p.id + '"' + (p.id === j4Val ? ' selected' : '') + '>' + shortName(p) + '</option>'
                ).join('');
        };
        j3Sel.addEventListener('change', updatePairOpts);
        j4Sel.addEventListener('change', updatePairOpts);
    }
}

function renderPartidoForm(jornada) {
    const newCat = editingPartidoId.startsWith('__new__') ? editingPartidoId.replace('__new__', '') : null;
    const existingPartido = !newCat ? drawPartidos.find(p => p.id === editingPartidoId) : null;
    const categoria = newCat || existingPartido?.categoria || '';

    const teamAPlayers = getPlayersInTeam(jornada.equipo_a_id);
    const teamBPlayers = getPlayersInTeam(jornada.equipo_b_id);

    const makePlayerOpts = (players, selectedId, excludeId) => {
        return '<option value="">— Seleccionar —</option>' +
            players.filter(p => p.id !== excludeId).map(p =>
                '<option value="' + p.id + '"' + (p.id === selectedId ? ' selected' : '') + '>' + shortName(p) + '</option>'
            ).join('');
    };

    const j1 = existingPartido?.jugador_a_1_id || '';
    const j2 = existingPartido?.jugador_a_2_id || '';
    const j3 = existingPartido?.jugador_b_1_id || '';
    const j4 = existingPartido?.jugador_b_2_id || '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">edit</span> ' +
        (newCat ? 'Crear' : 'Editar') + ' — ' + esc(formatCategoria(categoria)) +
        '</div>';

    if (teamAPlayers.length < 2) {
        html += '<div class="empty-state" style="padding:1rem;"><p style="font-size:0.8rem;color:var(--error);">El equipo A no tiene suficientes jugadores (' + teamAPlayers.length + '/2 mínimos).</p></div>';
    }
    if (teamBPlayers.length < 2) {
        html += '<div class="empty-state" style="padding:1rem;"><p style="font-size:0.8rem;color:var(--error);">El equipo B no tiene suficientes jugadores (' + teamBPlayers.length + '/2 mínimos).</p></div>';
    }

    html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (getTeamColor(jornada.equipo_a_id) || '#888') + ';"></span> ' +
        esc(getTeamName(jornada.equipo_a_id)) +
        '</div>' +
        '<div class="form-group"><label>Jugador 1</label><select id="dp-j1" data-team="a" data-slot="1">' +
        makePlayerOpts(teamAPlayers, j1, j2) +
        '</select></div>' +
        '<div class="form-group"><label>Jugador 2</label><select id="dp-j2" data-team="a" data-slot="2">' +
        makePlayerOpts(teamAPlayers, j2, j1) +
        '</select></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;padding-bottom:1.5rem;font-family:Lexend;font-weight:800;font-size:0.8rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (getTeamColor(jornada.equipo_b_id) || '#888') + ';"></span> ' +
        esc(getTeamName(jornada.equipo_b_id)) +
        '</div>' +
        '<div class="form-group"><label>Jugador 3</label><select id="dp-j3" data-team="b" data-slot="3">' +
        makePlayerOpts(teamBPlayers, j3, j4) +
        '</select></div>' +
        '<div class="form-group"><label>Jugador 4</label><select id="dp-j4" data-team="b" data-slot="4">' +
        makePlayerOpts(teamBPlayers, j4, j3) +
        '</select></div>' +
        '</div>' +
        '</div>';

    html += '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-partido"><span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar</button>' +
        '<button class="btn btn-outline" id="btn-cancel-partido"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div>' +
        '</div>';

    return html;
}

function getJugadorNombre(id) {
    if (!id) return '';
    const j = allJugadores.find(x => x.id === id);
    if (!j) return '?';
    return (j.nombre || '').split(' ')[0] + ' ' + (j.apellidos || '').split(' ')[0];
}

function paymentDotHtml(jugadorId) {
    if (!jugadorId) return '';
    const j = allJugadores.find(x => x.id === jugadorId);
    if (!j || j.pago_recibido || j.exonerado) return '';
    return '<span style="color:var(--secondary);font-size:1.2rem;vertical-align:super;margin-left:0.2rem;">•</span>';
}

async function savePartido() {
    const jornadaId = drawSelectedJornadaId;
    const jornada = allJornadas.find(j => j.id === jornadaId);
    if (!jornada) { toast('Error: jornada no encontrada', 'error'); return; }

    const newCat = editingPartidoId.startsWith('__new__') ? editingPartidoId.replace('__new__', '') : null;
    const existingPartido = !newCat ? drawPartidos.find(p => p.id === editingPartidoId) : null;
    const categoria = newCat || existingPartido?.categoria || '';

    const j1 = document.getElementById('dp-j1')?.value || null;
    const j2 = document.getElementById('dp-j2')?.value || null;
    const j3 = document.getElementById('dp-j3')?.value || null;
    const j4 = document.getElementById('dp-j4')?.value || null;

    if (!categoria) { toast('Categoría requerida', 'error'); return; }
    if (!j1) { toast('Seleccioná Jugador 1 del equipo A', 'error'); return; }
    if (!j2) { toast('Seleccioná Jugador 2 del equipo A', 'error'); return; }
    if (!j3) { toast('Seleccioná Jugador 1 del equipo B', 'error'); return; }
    if (!j4) { toast('Seleccioná Jugador 2 del equipo B', 'error'); return; }
    if (j1 === j2) { toast('Los jugadores del equipo A no pueden ser iguales', 'error'); return; }
    if (j3 === j4) { toast('Los jugadores del equipo B no pueden ser iguales', 'error'); return; }

    const j1Data = allJugadores.find(j => j.id === j1);
    const j2Data = allJugadores.find(j => j.id === j2);
    const j3Data = allJugadores.find(j => j.id === j3);
    const j4Data = allJugadores.find(j => j.id === j4);

    if (j1Data && j1Data.equipo_id !== jornada.equipo_a_id) { toast('Jugador 1 del equipo A no pertenece al equipo A', 'error'); return; }
    if (j2Data && j2Data.equipo_id !== jornada.equipo_a_id) { toast('Jugador 2 del equipo A no pertenece al equipo A', 'error'); return; }
    if (j3Data && j3Data.equipo_id !== jornada.equipo_b_id) { toast('Jugador 1 del equipo B no pertenece al equipo B', 'error'); return; }
    if (j4Data && j4Data.equipo_id !== jornada.equipo_b_id) { toast('Jugador 2 del equipo B no pertenece al equipo B', 'error'); return; }

    if (newCat) {
        const existing = drawPartidos.find(p => p.categoria === categoria);
        if (existing) { toast('Ya existe un partido para ' + categoria, 'error'); return; }
    }

    const data = {
        categoria,
        equipo_a_id: jornada.equipo_a_id,
        equipo_b_id: jornada.equipo_b_id,
        equipo_a_nombre: getTeamName(jornada.equipo_a_id),
        equipo_b_nombre: getTeamName(jornada.equipo_b_id),
        jugador_a_1_id: j1,
        jugador_a_2_id: j2,
        jugador_b_1_id: j3,
        jugador_b_2_id: j4,
        jugador_a_1_nombre: getJugadorNombre(j1),
        jugador_a_2_nombre: getJugadorNombre(j2),
        jugador_b_1_nombre: getJugadorNombre(j3),
        jugador_b_2_nombre: getJugadorNombre(j4),
        estado: 'pendiente'
    };

    showLoading(editingPartidoId && !newCat ? 'Actualizando partido...' : 'Creando partido...');
    try {
        if (editingPartidoId && !newCat) {
            await updateDoc(partidoDocRef(jornadaId, editingPartidoId), data);
            toast('Partido actualizado', 'success');
        } else {
            await addDoc(partidoCol(jornadaId), data);
            toast('Partido creado — ' + categoria, 'success');
        }
        editingPartidoId = null;
        drawPartidos = [];
        invalidatePartidosCache();
        await loadDrawPartidos(jornadaId);
        drawPartidos.forEach(p => p._drawJornadaId = jornadaId);
        renderDraw();
    } catch (e) {
        toast('Error al guardar partido', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

async function deletePartido(partidoId) {
    const partido = drawPartidos.find(p => p.id === partidoId);
    if (!partido) return;
    if (!confirm('¿Eliminar el partido "' + formatCategoria(partido.categoria) + '"?')) return;

    showLoading('Eliminando partido...');
    try {
        await deleteDoc(partidoDocRef(drawSelectedJornadaId, partidoId));
        toast('Partido eliminado', 'success');
        drawPartidos = [];
        invalidatePartidosCache();
        await loadDrawPartidos(drawSelectedJornadaId);
        drawPartidos.forEach(p => p._drawJornadaId = drawSelectedJornadaId);
        renderDraw();
    } catch (e) {
        toast('Error al eliminar', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ═══════════════════════════════════════════
// RESULTADOS — 2 SHORT SETS + SUPERTIEBREAK
// ═══════════════════════════════════════════
let resSelectedJornadaId = null;
let resPartidos = [];
let resultScores = {};
let resView = 'encurso';
let resDataKey = null;
let draftTimers = new Map();
let resEditing = {};

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => flushDrafts());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushDrafts();
    });
}

// ── Score Validation ──
// Short Set rules:
// - Set to 4 games, win by 2
// - 4-0, 4-1, 4-2 are normal wins
// - If 3-3, set extends
// - At 5-3 (or 3-5), set ends (win by 2)
// - At 4-4, Tie Break decides the set
// - NO continuation past 4-4 (5-4, 6-4, 7-5 are NOT valid)
//
// Valid set scores:
//   Normal: 4-0, 4-1, 4-2
//   Extended: 5-3, 3-5 (win by 2 after 3-3)
//   Tie Break: 4-4 + TB

function isValidSetScore(a, b) {
    if (a < 0 || b < 0) return false;
    const max = Math.max(a, b);
    const min = Math.min(a, b);
    // 4-0, 4-1, 4-2
    if (max === 4 && min <= 2) return true;
    // 5-3 or 3-5 (extended from 3-3, win by 2)
    if ((max === 5 && min === 3) || (max === 3 && min === 5)) return true;
    // 4-4 (Tie Break - validated separately)
    if (max === 4 && min === 4) return true;
    return false;
}

function isTiebreakSet(a, b) {
    return a === 4 && b === 4;
}

function isValidSupertiebreak(a, b) {
    if (a < 0 || b < 0) return false;
    const max = Math.max(a, b);
    const min = Math.min(a, b);
    if (max < 10) return false;
    if (max - min < 2) return false;
    return true;
}

// ── Inline Score Helpers ──
function isSetGamesDone(a, b) {
    if (a === 4 && b <= 2) return true;
    if (b === 4 && a <= 2) return true;
    if (a === 5 && b === 3) return true;
    if (b === 5 && a === 3) return true;
    return false;
}

function isTBComplete(tba, tbb) {
    if (tba == null || tbb == null) return false;
    const m = Math.max(tba, tbb);
    const d = Math.abs(tba - tbb);
    return m >= 7 && d >= 2;
}

function canIncrementGames(na, nb) {
    const mx = Math.max(na, nb);
    const mn = Math.min(na, nb);
    if (mx <= 3) return true;
    if (mx === 4 && mn <= 2) return true;
    if (mx === 4 && mn === 3) return true;
    if (mx === 4 && mn === 4) return true;
    if (mx === 5 && mn === 3) return true;
    return false;
}

function canDecrementGames(a, b) {
    return a > 0 && b > 0;
}

function adjustScore(a, b, team, delta) {
    const na = team === 'a' ? a + delta : a;
    const nb = team === 'b' ? b + delta : b;
    if (na < 0 || nb < 0) return { a: a, b: b };
    if (delta > 0 && !canIncrementGames(na, nb)) return { a: a, b: b };
    return { a: na, b: nb };
}

function adjustTB(a, b, team, delta) {
    const na = team === 'a' ? a + delta : a;
    const nb = team === 'b' ? b + delta : b;
    if (na < 0 || nb < 0) return { a: a, b: b };
    return { a: na, b: nb };
}

function adjustSTB(a, b, team, delta) {
    const na = team === 'a' ? a + delta : a;
    const nb = team === 'b' ? b + delta : b;
    if (na < 0 || nb < 0) return { a: a, b: b };
    return { a: na, b: nb };
}

function applyMatchStateInline(id) {
    const rs = resultScores[id];
    if (!rs) return;
    const setsA = (rs.set1_a > rs.set1_b ? 1 : 0) + (rs.set2_a > rs.set2_b ? 1 : 0);
    const setsB = (rs.set1_b > rs.set1_a ? 1 : 0) + (rs.set2_b > rs.set2_a ? 1 : 0);
    const els = ['res-n-a', 'res-s1-a', 'res-s2-a', 'res-n-b', 'res-s1-b', 'res-s2-b'].map(k => document.getElementById(k + '-' + id));
    if (els.some(el => !el)) return;
    els.forEach(el => el.classList.remove('state-win', 'state-lose', 'state-tie'));
    if (setsA > setsB) {
        ['res-n-a', 'res-s1-a', 'res-s2-a'].forEach(k => document.getElementById(k + '-' + id)?.classList.add('state-win'));
        ['res-n-b', 'res-s1-b', 'res-s2-b'].forEach(k => document.getElementById(k + '-' + id)?.classList.add('state-lose'));
    } else if (setsB > setsA) {
        ['res-n-a', 'res-s1-a', 'res-s2-a'].forEach(k => document.getElementById(k + '-' + id)?.classList.add('state-lose'));
        ['res-n-b', 'res-s1-b', 'res-s2-b'].forEach(k => document.getElementById(k + '-' + id)?.classList.add('state-win'));
    } else {
        els.forEach(el => el.classList.add('state-tie'));
    }
}

function validateMatchScore(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB) {
    const e = (msg) => { toast(msg, 'error'); return false; };

    if (s1A === '' || s1B === '' || s2A === '' || s2B === '') {
        return e('Completá ambos sets');
    }
    const s1l = parseInt(s1A), s1v = parseInt(s1B);
    const s2l = parseInt(s2A), s2v = parseInt(s2B);

    if (isNaN(s1l) || isNaN(s1v) || isNaN(s2l) || isNaN(s2v)) {
        return e('Los valores deben ser números');
    }
    if (s1l < 0 || s1v < 0 || s2l < 0 || s2v < 0) {
        return e('Los valores no pueden ser negativos');
    }

    if (!isValidSetScore(s1l, s1v)) {
        return e('Set 1 inválido. Válidos: 4-0, 4-1, 4-2, 5-3, 3-5. Si es 4-4, usar Tie Break.');
    }
    if (!isValidSetScore(s2l, s2v)) {
        return e('Set 2 inválido. Válidos: 4-0, 4-1, 4-2, 5-3, 3-5. Si es 4-4, usar Tie Break.');
    }

    const set1TB = isTiebreakSet(s1l, s1v);
    const set2TB = isTiebreakSet(s2l, s2v);

    if (set1TB) {
        if (tb1A === '' || tb1B === '' || tb1A === undefined || tb1B === undefined) {
            return e('Set 1 es 4-4: se requiere Tie Break');
        }
        const tb1l = parseInt(tb1A), tb1v = parseInt(tb1B);
        if (isNaN(tb1l) || isNaN(tb1v)) return e('Tie Break 1: valores inválidos');
        if (tb1l < 0 || tb1v < 0) return e('Tie Break 1: valores negativos');
        if (tb1l < 7 && tb1v < 7) return e('Tie Break 1: mínimo 7 puntos');
        if (Math.abs(tb1l - tb1v) < 2) return e('Tie Break 1: diferencia mínima de 2 puntos');
    }

    if (set2TB) {
        if (tb2A === '' || tb2B === '' || tb2A === undefined || tb2B === undefined) {
            return e('Set 2 es 4-4: se requiere Tie Break');
        }
        const tb2l = parseInt(tb2A), tb2v = parseInt(tb2B);
        if (isNaN(tb2l) || isNaN(tb2v)) return e('Tie Break 2: valores inválidos');
        if (tb2l < 0 || tb2v < 0) return e('Tie Break 2: valores negativos');
        if (tb2l < 7 && tb2v < 7) return e('Tie Break 2: mínimo 7 puntos');
        if (Math.abs(tb2l - tb2v) < 2) return e('Tie Break 2: diferencia mínima de 2 puntos');
    }

    const setsA = (determineSetWinner(s1l, s1v, parseInt(tb1A), parseInt(tb1B)) === 'a' ? 1 : 0) +
                      (determineSetWinner(s2l, s2v, parseInt(tb2A), parseInt(tb2B)) === 'a' ? 1 : 0);
    const setsB = (determineSetWinner(s1l, s1v, parseInt(tb1A), parseInt(tb1B)) === 'b' ? 1 : 0) +
                    (determineSetWinner(s2l, s2v, parseInt(tb2A), parseInt(tb2B)) === 'b' ? 1 : 0);

    if (setsA === 2 || setsB === 2) {
        if (stbA !== '' && stbB !== '' && stbA !== undefined && stbB !== undefined) {
            return e('No debe haber Super Tie Break si un equipo ganó 2-0');
        }
        return true;
    }

    if (setsA === 1 && setsB === 1) {
        if (stbA === '' || stbB === '' || stbA === undefined || stbB === undefined) {
            return e('Se requiere Super Tie Break (sets 1-1)');
        }
        const stbl = parseInt(stbA), stbv = parseInt(stbB);
        if (isNaN(stbl) || isNaN(stbv)) return e('Super Tie Break: valores inválidos');
        if (stbl < 0 || stbv < 0) return e('Super Tie Break: valores negativos');
        if (!isValidSupertiebreak(stbl, stbv)) {
            return e('Super Tie Break inválido. Se necesita ventaja de 2 puntos (mínimo 10-8)');
        }
        return true;
    }

    return true;
}

function determineSetWinner(setA, setB, tbA, tbB) {
    if (isTiebreakSet(setA, setB)) {
        if (!isNaN(tbA) && !isNaN(tbB)) {
            if (tbA > tbB) return 'a';
            if (tbB > tbA) return 'b';
        }
        return null;
    }
    if (setA > setB) return 'a';
    if (setB > setA) return 'b';
    return null;
}

function determineMatchWinner(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB) {
    const s1l = parseInt(s1A), s1v = parseInt(s1B);
    const s2l = parseInt(s2A), s2v = parseInt(s2B);

    const set1Winner = determineSetWinner(s1l, s1v, parseInt(tb1A), parseInt(tb1B));
    const set2Winner = determineSetWinner(s2l, s2v, parseInt(tb2A), parseInt(tb2B));

    let setsA = 0, setsB = 0;
    if (set1Winner === 'a') setsA++;
    if (set1Winner === 'b') setsB++;
    if (set2Winner === 'a') setsA++;
    if (set2Winner === 'b') setsB++;

    if (setsA === 2) return 'a';
    if (setsB === 2) return 'b';

    if (!isNaN(stbA) && !isNaN(stbB)) {
        if (stbA > stbB) return 'a';
        if (stbB > stbA) return 'b';
    }
    return null;
}

function calculateGames(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB) {
    const s1l = parseInt(s1A) || 0, s1v = parseInt(s1B) || 0;
    const s2l = parseInt(s2A) || 0, s2v = parseInt(s2B) || 0;
    const tb1l = parseInt(tb1A), tb1v = parseInt(tb1B);
    const tb2l = parseInt(tb2A), tb2v = parseInt(tb2B);
    const stbl = parseInt(stbA) || 0, stbv = parseInt(stbB) || 0;

    let set1_a = s1l, set1_b = s1v;
    let set2_a = s2l, set2_b = s2v;

    if (s1l === 4 && s1v === 4 && !isNaN(tb1l) && !isNaN(tb1v)) {
        if (tb1l > tb1v) { set1_a = 5; set1_b = 4; }
        else if (tb1v > tb1l) { set1_a = 4; set1_b = 5; }
    }
    if (s2l === 4 && s2v === 4 && !isNaN(tb2l) && !isNaN(tb2v)) {
        if (tb2l > tb2v) { set2_a = 5; set2_b = 4; }
        else if (tb2v > tb2l) { set2_a = 4; set2_b = 5; }
    }

    return {
        games_a: set1_a + set2_a,
        games_b: set1_b + set2_b,
        stb_a: stbl,
        stb_b: stbv
    };
}

// ── Recalculate Games Migration ──
async function recalculateAllGames() {
    const tid = getActiveTournamentId();
    if (!tid) { toast('No hay torneo activo', 'error'); return; }

    let totalFixed = 0, totalSkipped = 0;

    function recalc(p) {
        const s1l = parseInt(p.set1_a) || 0, s1v = parseInt(p.set1_b) || 0;
        const s2l = parseInt(p.set2_a) || 0, s2v = parseInt(p.set2_b) || 0;
        const tb1l = parseInt(p.tiebreak1_a), tb1v = parseInt(p.tiebreak1_b);
        const tb2l = parseInt(p.tiebreak2_a), tb2v = parseInt(p.tiebreak2_b);
        let set1_a = s1l, set1_b = s1v, set2_a = s2l, set2_b = s2v;
        if (s1l === 4 && s1v === 4 && !isNaN(tb1l) && !isNaN(tb1v)) {
            if (tb1l > tb1v) { set1_a = 5; set1_b = 4; }
            else if (tb1v > tb1l) { set1_a = 4; set1_b = 5; }
        }
        if (s2l === 4 && s2v === 4 && !isNaN(tb2l) && !isNaN(tb2v)) {
            if (tb2l > tb2v) { set2_a = 5; set2_b = 4; }
            else if (tb2v > tb2l) { set2_a = 4; set2_b = 5; }
        }
        return { games_a: set1_a + set2_a, games_b: set1_b + set2_b };
    }

    async function fixCollection(path) {
        const snap = await getDocs(collection(db, path));
        for (const d of snap.docs) {
            if (d.id === 'partidos' || d.id === 'semifinales' || d.id === 'finales') continue;
            const subSnap = await getDocs(collection(db, path, d.id, 'partidos'));
            for (const pDoc of subSnap.docs) {
                const p = pDoc.data();
                if (p.estado !== 'finalizado') { totalSkipped++; continue; }
                const ng = recalc(p);
                if (ng.games_a !== (parseInt(p.games_a) || 0) || ng.games_b !== (parseInt(p.games_b) || 0)) {
                    await updateDoc(doc(db, path, d.id, 'partidos', pDoc.id), { games_a: ng.games_a, games_b: ng.games_b });
                    totalFixed++;
                } else { totalSkipped++; }
            }
        }
    }

    showLoading('Recalculando juegos...');
    try {
        await fixCollection('torneos/' + tid + '/jornadas');
        await fixCollection('torneos/' + tid + '/semifinales');
        await fixCollection('torneos/' + tid + '/finales');
        toast('Juegos recalculados: ' + totalFixed + ' corregidos, ' + totalSkipped + ' sin cambios', 'success');
        invalidatePartidosCache();
    } catch (e) {
        console.error(e);
        toast('Error al recalcular: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}
window.recalculateAllGames = recalculateAllGames;

// ── Firestore Helpers ──
function resPartidoCol(jornadaId) {
    return collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId, 'partidos');
}

function resPartidoDocRef(jornadaId, partidoId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId, 'partidos', partidoId);
}

function getResPartidoDocRef(partido) {
    const id = partido.id;
    const cid = partido._resContainerId || partido._resJornadaId;
    const type = partido._resContainerType || 'jornada';
    if (type === 'semifinal') {
        return doc(db, 'torneos', getActiveTournamentId(), 'semifinales', cid, 'partidos', id);
    }
    if (type === 'final') {
        return doc(db, 'torneos', getActiveTournamentId(), 'finales', cid, 'partidos', id);
    }
    return resPartidoDocRef(cid, id);
}

function equipoRef(equipoId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'equipos', equipoId);
}

// ── Shared Partidos Cache ──
function invalidatePartidosCache() {
    _partidosCacheKey = null;
    _partidosCache = [];
    resDataKey = null;
    resPartidos = [];
}

async function loadAllPartidos() {
    const cacheKey = getActiveTournamentId() + '|' + allJornadas.map(j => j.id).join(',');
    if (_partidosCacheKey === cacheKey && _partidosCache.length) return _partidosCache;
    _partidosCache = [];
    const loaded = [];
    await Promise.all(allJornadas.map(async j => {
        try {
            const snap = await getDocs(resPartidoCol(j.id));
            snap.docs.forEach(d => {
                const p = { id: d.id, ...normalizeFields(d.data()) };
                p._resJornadaId = j.id;
                p._jornadaNumero = j.numero;
                p._jornadaFecha = j.fecha;
                p._teamAColor = getTeamColor(j.equipo_a_id) || '#4da6ff';
                p._teamBColor = getTeamColor(j.equipo_b_id) || '#feb300';
                loaded.push(p);
            });
        } catch (e) {
            console.error('Error loading partidos jornada ' + j.id, e);
        }
    }));
    _partidosCache = loaded;
    _partidosCacheKey = cacheKey;
    return _partidosCache;
}

async function ensureResData() {
    if (!allJornadas.length) return;
    const cacheKey = getActiveTournamentId() + '|' + allJornadas.map(j => j.id).join(',');
    if (_partidosCacheKey === cacheKey && _partidosCache.length) {
        if (!(resDataKey === cacheKey && resPartidos.length)) {
            resDataKey = cacheKey;
            resPartidos = _partidosCache.map(p => ({
                ...p,
                _resJornadaId: p._resJornadaId,
                _jornadaNumero: p._jornadaNumero,
                _jornadaFecha: p._jornadaFecha,
                _teamAColor: p._teamAColor,
                _teamBColor: p._teamBColor
            }));
            buildResultScores();
        }
        return;
    }
    await loadAllPartidos();
    resPartidos = _partidosCache.map(p => ({
        ...p,
        _resJornadaId: p._resJornadaId,
        _jornadaNumero: p._jornadaNumero,
        _jornadaFecha: p._jornadaFecha,
        _teamAColor: p._teamAColor,
        _teamBColor: p._teamBColor
    }));
    resDataKey = cacheKey;
    buildResultScores();
}

function buildResultScores() {
    resPartidos.forEach(p => initResultScore(p));
}

function initResultScore(p) {
    const fin = p.estado === 'finalizado';
    let base;
    if (fin) {
        base = {
            set1_a: p.set1_a != null ? p.set1_a : 0,
            set1_b: p.set1_b != null ? p.set1_b : 0,
            set2_a: p.set2_a != null ? p.set2_a : 0,
            set2_b: p.set2_b != null ? p.set2_b : 0,
            tb1_a: p.tiebreak1_a != null ? p.tiebreak1_a : null,
            tb1_b: p.tiebreak1_b != null ? p.tiebreak1_b : null,
            tb2_a: p.tiebreak2_a != null ? p.tiebreak2_a : null,
            tb2_b: p.tiebreak2_b != null ? p.tiebreak2_b : null,
            stb_a: p.supertiebreak_a != null ? p.supertiebreak_a : null,
            stb_b: p.supertiebreak_b != null ? p.supertiebreak_b : null,
            _closed: { set1: true, set2: true, tb1: true, tb2: true, stb: true }
        };
    } else if (p.borrador) {
        const d = p.borrador;
        base = {
            set1_a: d.set1_a != null ? d.set1_a : 0,
            set1_b: d.set1_b != null ? d.set1_b : 0,
            set2_a: d.set2_a != null ? d.set2_a : 0,
            set2_b: d.set2_b != null ? d.set2_b : 0,
            tb1_a: d.tb1_a != null ? d.tb1_a : null,
            tb1_b: d.tb1_b != null ? d.tb1_b : null,
            tb2_a: d.tb2_a != null ? d.tb2_a : null,
            tb2_b: d.tb2_b != null ? d.tb2_b : null,
            stb_a: d.stb_a != null ? d.stb_a : null,
            stb_b: d.stb_b != null ? d.stb_b : null,
            _closed: d._closed || {}
        };
    } else {
        base = {
            set1_a: 0, set1_b: 0,
            set2_a: 0, set2_b: 0,
            tb1_a: null, tb1_b: null,
            tb2_a: null, tb2_b: null,
            stb_a: null, stb_b: null,
            _closed: {}
        };
    }
    resultScores[p.id] = base;
}

// ── Draft autosave (borrador en la nube) ──
function queueDraftSave(partidoId) {
    const p = resPartidos.find(x => x.id === partidoId);
    if (!p || p.estado === 'finalizado') return;
    if (draftTimers.has(partidoId)) clearTimeout(draftTimers.get(partidoId));
    const t = setTimeout(() => { draftTimers.delete(partidoId); persistDraft(partidoId); }, 300);
    draftTimers.set(partidoId, t);
}

async function persistDraft(partidoId) {
    const p = resPartidos.find(x => x.id === partidoId);
    if (!p || p.estado === 'finalizado') return;
    const rs = resultScores[partidoId];
    if (!rs) return;
    try {
        await updateDoc(getResPartidoDocRef(p), {
            borrador: {
                set1_a: rs.set1_a, set1_b: rs.set1_b,
                set2_a: rs.set2_a, set2_b: rs.set2_b,
                tb1_a: rs.tb1_a, tb1_b: rs.tb1_b,
                tb2_a: rs.tb2_a, tb2_b: rs.tb2_b,
                stb_a: rs.stb_a, stb_b: rs.stb_b,
                _closed: rs._closed || {},
                updatedAt: new Date()
            }
        });
    } catch (e) {
        console.error('Error guardando borrador', e);
    }
}

function flushDrafts() {
    if (!draftTimers.size) return;
    draftTimers.forEach((t, id) => { clearTimeout(t); draftTimers.delete(id); persistDraft(id); });
}

// ── Points Application ──
// NOTE: calculateStandings() is the single source of truth for all stats
// applyMatchPoints only marks the partido to prevent duplicate processing
async function applyMatchPoints(jornadaId, partidoId) {
    const partido = resPartidos.find(p => p.id === partidoId);
    if (!partido || partido.estado !== 'finalizado') return;
    await updateDoc(getResPartidoDocRef(partido), { puntos_aplicados: true });
}

function syncPartidoResult(partidoId, updatedPartido) {
    const sp = semiPartidos.find(p => p.id === partidoId);
    if (sp) {
        Object.assign(sp, updatedPartido);
    }
    const fp = finalPartidos.find(p => p.id === partidoId);
    if (fp) {
        Object.assign(fp, updatedPartido);
    }
}

// ── Save Resultado ──
async function saveResultado(partidoId) {
    const partido = resPartidos.find(x => x.id === partidoId);
    if (!partido) return;
    const docRef = getResPartidoDocRef(partido);
    if (!docRef) return;

    const rs = resultScores[partidoId];
    if (!rs) return;

    const s1A = String(rs.set1_a), s1B = String(rs.set1_b);
    const s2A = String(rs.set2_a), s2B = String(rs.set2_b);
    const tb1A = rs.tb1_a != null ? String(rs.tb1_a) : '';
    const tb1B = rs.tb1_b != null ? String(rs.tb1_b) : '';
    const tb2A = rs.tb2_a != null ? String(rs.tb2_a) : '';
    const tb2B = rs.tb2_b != null ? String(rs.tb2_b) : '';
    const stbA = rs.stb_a != null ? String(rs.stb_a) : '';
    const stbB = rs.stb_b != null ? String(rs.stb_b) : '';

    if (!validateMatchScore(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB)) return;

    const s1l = parseInt(s1A), s1v = parseInt(s1B);
    const s2l = parseInt(s2A), s2v = parseInt(s2B);
    const tb1l = tb1A !== '' ? parseInt(tb1A) : null;
    const tb1v = tb1B !== '' ? parseInt(tb1B) : null;
    const tb2l = tb2A !== '' ? parseInt(tb2A) : null;
    const tb2v = tb2B !== '' ? parseInt(tb2B) : null;
    const stbl = stbA !== '' ? parseInt(stbA) : null;
    const stbv = stbB !== '' ? parseInt(stbB) : null;

    const ganador = determineMatchWinner(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB);
    const games = calculateGames(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB);

    const ganadorEquipoId = ganador === 'a' ? partido?.equipo_a_id :
                            ganador === 'b' ? partido?.equipo_b_id : null;

    showLoading('Guardando resultado...');
    try {
        await updateDoc(getResPartidoDocRef(partido), {
            set1_a: s1l,
            set1_b: s1v,
            set2_a: s2l,
            set2_b: s2v,
            tiebreak1_a: tb1l,
            tiebreak1_b: tb1v,
            tiebreak2_a: tb2l,
            tiebreak2_b: tb2v,
            supertiebreak_a: stbl,
            supertiebreak_b: stbv,
            ganador_equipo_id: ganadorEquipoId,
            estado: 'finalizado',
            borrador: null,
            games_a: games.games_a,
            games_b: games.games_b,
            fecha_resultado: new Date(),
            puntos_aplicados: false
        });

        toast('Resultado guardado', 'success');
        if (draftTimers.has(partidoId)) { clearTimeout(draftTimers.get(partidoId)); draftTimers.delete(partidoId); }
        delete resEditing[partidoId];
        if (partido) {
            partido.estado = 'finalizado';
            partido.set1_a = s1l; partido.set1_b = s1v;
            partido.set2_a = s2l; partido.set2_b = s2v;
            partido.tiebreak1_a = tb1l; partido.tiebreak1_b = tb1v;
            partido.tiebreak2_a = tb2l; partido.tiebreak2_b = tb2v;
            partido.supertiebreak_a = stbl; partido.supertiebreak_b = stbv;
            partido.ganador_equipo_id = ganadorEquipoId;
            partido.games_a = games.games_a; partido.games_b = games.games_b;
            partido.borrador = null;
            // Sync back to semi/final container arrays
            syncPartidoResult(partidoId, partido);
        }
        resultScores[partidoId] = {
            set1_a: s1l, set1_b: s1v,
            set2_a: s2l, set2_b: s2v,
            tb1_a: tb1l, tb1_b: tb1v,
            tb2_a: tb2l, tb2_b: tb2v,
            stb_a: stbl, stb_b: stbv,
            _closed: { set1: true, set2: true, tb1: true, tb2: true, stb: true }
        };
        await applyMatchPoints(partidoId);
        invalidatePartidosCache();
        const fp = resPartidos.find(x => x.id === partidoId);
        if (fp?._resContainerType === 'semifinal') renderSemifinalDetail();
        else if (fp?._resContainerType === 'final') renderFinalDetail();
        else renderResultados();
    } catch (e) {
        toast('Error al guardar resultado', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ── Clear Resultado ──
async function clearResultado(partidoId) {
    const partido = resPartidos.find(p => p.id === partidoId);
    if (!partido) return;
    if (partido.estado !== 'finalizado') return;

    if (!confirm('¿Borrar este resultado?')) return;

    showLoading('Borrando resultado...');
    try {
        await updateDoc(getResPartidoDocRef(partido), {
            set1_a: null,
            set1_b: null,
            set2_a: null,
            set2_b: null,
            tiebreak1_a: null,
            tiebreak1_b: null,
            tiebreak2_a: null,
            tiebreak2_b: null,
            supertiebreak_a: null,
            supertiebreak_b: null,
            ganador_equipo_id: null,
            estado: 'pendiente',
            borrador: null,
            games_a: 0,
            games_b: 0,
            fecha_resultado: null,
            puntos_aplicados: false
        });

        toast('Resultado borrado', 'success');
        if (draftTimers.has(partidoId)) { clearTimeout(draftTimers.get(partidoId)); draftTimers.delete(partidoId); }
        if (partido) {
            partido.estado = 'pendiente';
            partido.set1_a = null; partido.set1_b = null;
            partido.set2_a = null; partido.set2_b = null;
            partido.tiebreak1_a = null; partido.tiebreak1_b = null;
            partido.tiebreak2_a = null; partido.tiebreak2_b = null;
            partido.supertiebreak_a = null; partido.supertiebreak_b = null;
            partido.ganador_equipo_id = null;
            partido.games_a = 0; partido.games_b = 0;
            partido.borrador = null;
            syncPartidoResult(partidoId, partido);
        }
        resultScores[partidoId] = {
            set1_a: 0, set1_b: 0,
            set2_a: 0, set2_b: 0,
            tb1_a: null, tb1_b: null,
            tb2_a: null, tb2_b: null,
            stb_a: null, stb_b: null,
            _closed: {}
        };
        invalidatePartidosCache();
        renderResultados();
    } catch (e) {
        toast('Error al borrar resultado', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ── Render Resultados ──
function renderResultados() {
    const panel = document.getElementById('panel-resultados');
    if (!panel) return;

    if (resView === 'encurso') {
        renderResEnCurso(panel);
        return;
    }

    if (resSelectedJornadaId) {
        renderResDetail(panel);
        return;
    }

    if (resView === 'jornada' && !resSelectedJornadaId && allJornadas.length) {
        let html = '';
        html += resViewSwitchHtml();
        html += '<div class="card">' +
            '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.75rem;">' +
            '<span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">sports_score</span>' +
            '<span style="font-family:Lexend;font-weight:600;font-size:0.9rem;">Seleccionar Jornada</span>' +
            '</div>' +
            '<div class="form-group"><label>Jornada</label>' +
            '<select id="res-jornada-select">' +
            '<option value="">— Seleccionar jornada —</option>' +
            allJornadas.map(j => {
                const teamAName2 = getTeamName(j.equipo_a_id) || '?';
                const teamBName2 = getTeamName(j.equipo_b_id) || '?';
                const cerradaLabel = j.cerrada ? ' [CERRADA]' : '';
                return '<option value="' + j.id + '">Jornada ' + j.numero + ' — ' + esc(teamAName2) + ' VS ' + esc(teamBName2) + cerradaLabel + '</option>';
            }).join('') +
            '</select></div>' +
            '</div>';
        panel.innerHTML = html;
        bindResPanelEvents(panel);
        document.getElementById('res-jornada-select')?.addEventListener('change', (e) => {
            resSelectedJornadaId = e.target.value || null;
            if (resSelectedJornadaId) renderResultados();
        });
        return;
    }

    if (allJornadas.length) {
        resSelectedJornadaId = allJornadas[allJornadas.length - 1].id;
        renderResDetail(panel);
        return;
    }

    let html = '';
    html += '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">sports_score</span>' +
        '<span style="font-family:Lexend;font-weight:600;font-size:0.9rem;">Seleccionar Jornada</span>' +
        '</div>' +
        '<div class="form-group"><label>Jornada</label>' +
        '<select id="res-jornada-select">' +
        '<option value="">— Seleccionar jornada —</option>' +
        allJornadas.map(j => {
            const teamAName2 = getTeamName(j.equipo_a_id) || '?';
            const teamBName2 = getTeamName(j.equipo_b_id) || '?';
            return '<option value="' + j.id + '">Jornada ' + j.numero + ' — ' + esc(teamAName2) + ' VS ' + esc(teamBName2) + '</option>';
        }).join('') +
        '</select></div>' +
        '</div>';

    if (!allJornadas.length) {
        html += '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">calendar_today</span><p>No hay jornadas creadas.<br>Creá jornadas desde el módulo Jornadas.</p></div>';
    }

    panel.innerHTML = html;

    document.getElementById('res-jornada-select')?.addEventListener('change', (e) => {
        resSelectedJornadaId = e.target.value || null;
        if (resSelectedJornadaId) renderResultados();
    });
}

function resViewSwitchHtml(openCount) {
    return '<div class="res-view-bar">' +
        '<div class="res-view-switch">' +
        '<button class="res-view-btn' + (resView === 'encurso' ? ' active' : '') + '" data-res-view="encurso">En curso' + (openCount != null ? ' (' + openCount + ')' : '') + '</button>' +
        '<button class="res-view-btn' + (resView === 'jornada' ? ' active' : '') + '" data-res-view="jornada">Por jornada</button>' +
        '</div>' +
        '</div>';
}

async function renderResEnCurso(panel) {
    panelLoading(panel, 'Cargando resultados en curso...');
    await ensureResData();

    if (!resPartidos.length) {
        panel.innerHTML = '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">sports_score</span><p>No hay partidos cargados.</p></div>';
        return;
    }

    const openCount = resPartidos.filter(p => p.estado !== 'finalizado').length;

    const groups = [];
    allJornadas.forEach(j => {
        const items = resPartidos.filter(p => p._resJornadaId === j.id);
        if (!items.length) return;
        const open = items.filter(p => p.estado !== 'finalizado');
        const done = items.filter(p => p.estado === 'finalizado');
        const sorted = open.concat(done);
        if (!sorted.length) return;
        groups.push({ j, items: sorted });
    });

    let html = '';
    html += resViewSwitchHtml(openCount);
    html += '<input type="text" id="result-search" class="search-input" placeholder="Buscar por nombre de jugador...">';

    groups.forEach(g => {
        const fechaStr = formatDate(g.j.fecha) || '';
        const isCerrada = g.j.cerrada === true;
        const cerradaBadge = isCerrada
            ? '<span style="font-size:0.65rem;background:rgba(0,212,170,0.15);color:var(--primary);padding:2px 8px;border-radius:10px;margin-left:0.4rem;">CERRADA</span>'
            : '';
        const cerrarBtn = isCerrada
            ? '<button class="btn btn-sm btn-outline" onclick="editarJornada(\'' + g.j.id + '\')" title="Reabrir jornada" style="font-size:0.75rem;padding:0.3rem 0.6rem;margin-left:auto;"><span class="material-symbols-outlined" style="font-size:0.85rem;">edit</span> Editar</button>'
            : '<button class="btn btn-sm btn-outline" onclick="cerrarJornada(\'' + g.j.id + '\')" title="Cerrar jornada" style="font-size:0.75rem;padding:0.3rem 0.6rem;margin-left:auto;"><span class="material-symbols-outlined" style="font-size:0.85rem;">lock</span> Cerrar</button>';

        let summaryLine = '';
        if (isCerrada) {
            const teamAName = getTeamName(g.j.equipo_a_id) || '?';
            const teamBName = getTeamName(g.j.equipo_b_id) || '?';
            const teamAColor = getTeamColor(g.j.equipo_a_id) || '#4da6ff';
            const teamBColor = getTeamColor(g.j.equipo_b_id) || '#feb300';
            let aWins = 0, bWins = 0;
            g.items.forEach(p => {
                if (p.ganador_equipo_id === g.j.equipo_a_id) aWins++;
                else if (p.ganador_equipo_id === g.j.equipo_b_id) bWins++;
            });
            let ganadorText = '';
            if (aWins > bWins) {
                ganadorText = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamAColor + ';vertical-align:middle;margin:0 3px;"></span>' + esc(teamAName);
            } else if (bWins > aWins) {
                ganadorText = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamBColor + ';vertical-align:middle;margin:0 3px;"></span>' + esc(teamBName);
            } else {
                ganadorText = 'Empate';
            }
            summaryLine = '<div style="font-size:0.75rem;color:var(--on-surface-variant-30);margin-top:0.3rem;">' +
                '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamAColor + ';vertical-align:middle;margin:0 2px;"></span>' + esc(teamAName) +
                ' vs ' +
                '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamBColor + ';vertical-align:middle;margin:0 2px;"></span>' + esc(teamBName) +
                ' · Ganador: ' + ganadorText +
                '</div>';
        }

        const collapseId = 'jornada-partidos-' + g.j.id;
        const toggleIcon = isCerrada ? 'expand_more' : '';
        const toggleBtn = isCerrada
            ? '<button class="btn btn-sm btn-outline" data-jornada-toggle="' + collapseId + '" style="font-size:0.7rem;padding:0.2rem 0.5rem;margin-top:0.3rem;"><span class="material-symbols-outlined jornada-toggle-icon" style="font-size:0.9rem;">expand_more</span> Ver partidos</button>'
            : '';

        const groupClass = isCerrada ? 'res-jornada-group res-jornada-closed' : 'res-jornada-group';
        html += '<div class="' + groupClass + '">' +
            '<div class="res-jornada-head" style="display:flex;align-items:center;gap:0.3rem;"><span class="material-symbols-outlined" style="font-size:0.8rem;">event</span> Jornada ' + esc(String(g.j.numero)) +
            (fechaStr ? ' · ' + esc(fechaStr) : '') + cerradaBadge + cerrarBtn + '</div>' +
            summaryLine + toggleBtn;

        const hiddenStyle = isCerrada ? ' style="display:none;"' : '';
        html += '<div id="' + collapseId + '"' + hiddenStyle + '>';
        g.items.forEach(p => { html += resCardHtml(p); });
        html += '</div></div>';
    });

    panel.innerHTML = html;
    bindResPanelEvents(panel);
    panel.querySelectorAll('.card').forEach(c => bindResCardEvents(c, panel));
    panel.querySelectorAll('.res-public-card').forEach(c => bindResCardEvents(c, panel));
}

async function renderResDetail(panel) {
    await ensureCategorias();
    const jornada = allJornadas.find(j => j.id === resSelectedJornadaId);
    if (!jornada) { resSelectedJornadaId = null; renderResultados(); return; }

    await ensureResData();
    const partidos = resPartidos.filter(p => p._resJornadaId === resSelectedJornadaId);

    let html = '';
    html += resViewSwitchHtml();

    const isCerrada = jornada.cerrada === true;
    const cerradaBadge = isCerrada
        ? '<span style="font-size:0.65rem;background:rgba(0,212,170,0.15);color:var(--primary);padding:2px 8px;border-radius:10px;margin-left:0.5rem;">CERRADA</span>'
        : '';
    const cerrarBtn = isCerrada
        ? '<button class="btn btn-sm btn-outline" onclick="editarJornada(\'' + jornada.id + '\')" title="Reabrir jornada para editar resultados"><span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span> Editar Jornada</button>'
        : '<button class="btn btn-sm btn-outline" onclick="cerrarJornada(\'' + jornada.id + '\')" title="Cerrar jornada y asignar bono"><span class="material-symbols-outlined" style="font-size:0.8rem;">lock</span> Cerrar Jornada</button>';

    html += '<div class="admin-section-title" style="display:flex;align-items:center;justify-content:space-between;">' +
        '<span><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_score</span> Resultados Jornada ' + esc(String(jornada.numero)) + cerradaBadge + '</span>' +
        '<div style="display:flex;gap:0.4rem;align-items:center;">' +
        cerrarBtn +
        '<button class="btn btn-sm btn-outline" id="btn-back-res-jornadas" title="Cambiar jornada"><span class="material-symbols-outlined" style="font-size:0.8rem;">arrow_back</span></button>' +
        '</div></div>' +
        '<input type="text" id="result-search" class="search-input" placeholder="Buscar por nombre de jugador...">';

    if (!partidos.length) {
        html += '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">sports_score</span><p>No hay partidos en esta jornada.</p></div>';
        panel.innerHTML = html;
        bindResPanelEvents(panel);
        panel.querySelectorAll('.card').forEach(c => bindResCardEvents(c, panel));
        panel.querySelectorAll('.res-public-card').forEach(c => bindResCardEvents(c, panel));
        return;
    }

    let summaryLine = '';
    let toggleBtn = '';
    if (isCerrada) {
        const teamAName = getTeamName(jornada.equipo_a_id) || '?';
        const teamBName = getTeamName(jornada.equipo_b_id) || '?';
        const teamAColor = getTeamColor(jornada.equipo_a_id) || '#4da6ff';
        const teamBColor = getTeamColor(jornada.equipo_b_id) || '#feb300';
        let aWins = 0, bWins = 0;
        partidos.forEach(p => {
            if (p.ganador_equipo_id === jornada.equipo_a_id) aWins++;
            else if (p.ganador_equipo_id === jornada.equipo_b_id) bWins++;
        });
        let ganadorText = '';
        if (aWins > bWins) {
            ganadorText = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamAColor + ';vertical-align:middle;margin:0 3px;"></span>' + esc(teamAName);
        } else if (bWins > aWins) {
            ganadorText = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamBColor + ';vertical-align:middle;margin:0 3px;"></span>' + esc(teamBName);
        } else {
            ganadorText = 'Empate';
        }
        summaryLine = '<div style="font-size:0.75rem;color:var(--on-surface-variant-30);margin:0.5rem 0 0.3rem;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamAColor + ';vertical-align:middle;margin:0 2px;"></span>' + esc(teamAName) +
            ' vs ' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamBColor + ';vertical-align:middle;margin:0 2px;"></span>' + esc(teamBName) +
            ' · Ganador: ' + ganadorText +
            '</div>';

        const collapseId = 'jornada-detail-partidos-' + jornada.id;
        toggleBtn = '<button class="btn btn-sm btn-outline" data-jornada-toggle="' + collapseId + '" style="font-size:0.7rem;padding:0.2rem 0.5rem;margin-bottom:0.5rem;"><span class="material-symbols-outlined jornada-toggle-icon" style="font-size:0.9rem;">expand_more</span> Ver partidos</button>';
        html += '<div class="res-jornada-closed">' + summaryLine + toggleBtn;
        html += '<div id="' + collapseId + '" style="display:none;">';
    }

    const allCats = getDrawCategoriasTodas();
    const renderedIds = new Set();
    allCats.forEach((cat, idx) => {
        const partido = partidos.find(p => p.categoria === cat.nombre);
        if (!partido) return;
        renderedIds.add(partido.id);
        html += resCardHtml(partido);
    });
    partidos.forEach(p => {
        if (!renderedIds.has(p.id)) html += resCardHtml(p);
    });

    if (isCerrada) {
        html += '</div></div>';
    }

    panel.innerHTML = html;
    bindResPanelEvents(panel);
    panel.querySelectorAll('.card').forEach(c => bindResCardEvents(c, panel));
    panel.querySelectorAll('.res-public-card').forEach(c => bindResCardEvents(c, panel));
}

function getJornadaNumero(partido) {
    // Busca el número actualizado de la jornada en allJornadas (fuente de verdad).
    // Evita inconsistencias si _jornadaNumero fue cacheado con un valor viejo.
    const j = allJornadas.find(x => x.id === (partido._resJornadaId || partido._jornadaId));
    return j ? j.numero : (partido._jornadaNumero || '?');
}

function resCardHtml(partido) {
    const isFinalizado = partido.estado === 'finalizado';
    const rs = resultScores[partido.id] || { set1_a: 0, set1_b: 0, set2_a: 0, set2_b: 0, tb1_a: null, tb1_b: null, tb2_a: null, tb2_b: null, stb_a: null, stb_b: null, _closed: {} };

    const j1Name = getJugadorNombre(partido.jugador_a_1_id) || '—';
    const j2Name = getJugadorNombre(partido.jugador_a_2_id) || '—';
    const j3Name = getJugadorNombre(partido.jugador_b_1_id) || '—';
    const j4Name = getJugadorNombre(partido.jugador_b_2_id) || '—';

    const catIdx = getDrawCategoriasTodas().findIndex(c => c.nombre === partido.categoria);
    const num = catIdx >= 0 ? String(catIdx + 1) : '?';

    const teamAColor = partido._teamAColor || getTeamColor(partido.equipo_a_id) || '#4da6ff';
    const teamBColor = partido._teamBColor || getTeamColor(partido.equipo_b_id) || '#feb300';

    const fechaStr = formatDate(partido._jornadaFecha) || '';

    if (isFinalizado && !resEditing[partido.id]) {
        return resCardCompactHtml(partido, rs, j1Name, j2Name, j3Name, j4Name, teamAColor, teamBColor, num, fechaStr);
    }

    const suggestedUnit = getActiveUnit(rs);
    const phaseLabel = suggestedUnit ? unitLabel(suggestedUnit) : (isFinalizado ? 'Finalizado' : 'En disputa');
    const set1Win = setWinner(rs.set1_a, rs.set1_b, rs.tb1_a, rs.tb1_b);
    const set2Win = setWinner(rs.set2_a, rs.set2_b, rs.tb2_a, rs.tb2_b);
    const RES_UNITS = [
        { key: 'set1', label: 'Set 1' },
        { key: 'set2', label: 'Set 2' }
    ];
    if (isTiebreakSet(rs.set1_a, rs.set1_b)) RES_UNITS.push({ key: 'tb1', label: 'Tie Break 1' });
    if (isTiebreakSet(rs.set2_a, rs.set2_b)) RES_UNITS.push({ key: 'tb2', label: 'Tie Break 2' });
    if (!!set1Win && !!set2Win && set1Win !== set2Win) RES_UNITS.push({ key: 'stb', label: 'Super Tie Break' });

    const unitHtml = RES_UNITS.map(u => {
        const score = getUnitScore(rs, u.key);
        const closed = isUnitClosed(u.key, rs);
        const confirmed = !!(rs._closed && rs._closed[u.key]);
        const isActive = suggestedUnit === u.key;
        let ua = '', ub = '';
        if (score.a > score.b) { ua = 'state-win'; ub = 'state-lose'; }
        else if (score.b > score.a) { ua = 'state-lose'; ub = 'state-win'; }
        else { ua = 'state-tie'; ub = 'state-tie'; }
        const badge = closed
            ? (confirmed ? '<span class="res-badge res-badge-ok" title="Cerrado y confirmado">✓</span>' : '<span class="res-badge res-badge-warn" title="Cerrado, falta confirmar">!</span>')
            : '';
        return '<div class="res-unit' + (isActive ? ' res-unit-active' : '') + '" data-unit="' + u.key + '">' +
            '<div class="res-unit-label">' + u.label + badge + '</div>' +
            '<div class="match-pair-row">' +
            '<span class="res-side-tag team-blue">A</span>' +
            '<span class="res-unit-score team-blue ' + ua + '" data-score-a="' + u.key + '">' + score.a + '</span>' +
            '<span class="match-score-ctl">' +
            '<button class="score-btn team-blue" data-res-adj="' + partido.id + '" data-unit="' + u.key + '" data-team="a" data-delta="-1">−</button>' +
            '<button class="score-btn team-blue" data-res-adj="' + partido.id + '" data-unit="' + u.key + '" data-team="a" data-delta="1">+</button>' +
            '</span>' +
            '<span class="res-sep">–</span>' +
            '<span class="match-score-ctl">' +
            '<button class="score-btn team-gold" data-res-adj="' + partido.id + '" data-unit="' + u.key + '" data-team="b" data-delta="-1">−</button>' +
            '<button class="score-btn team-gold" data-res-adj="' + partido.id + '" data-unit="' + u.key + '" data-team="b" data-delta="1">+</button>' +
            '</span>' +
            '<span class="res-unit-score team-gold ' + ub + '" data-score-b="' + u.key + '">' + score.b + '</span>' +
            '<span class="res-side-tag team-gold">B</span>' +
            '</div>' +
            '</div>';
    }).join('');

    return '<div class="card res-card' + (isFinalizado ? ' res-card-dim' : ' res-card-open') + '" data-res-card="' + partido.id + '">' +
        '<div class="match-info">' +
        '<div class="match-category-line" style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--accent-purple);margin-bottom:0.3rem;">' +
            esc(formatCategoria(partido.categoria || '')) +
            (!isFinalizado ? ' <span class="res-live-badge"><span class="res-live-dot"></span>EN CURSO</span>' : ' <span class="res-final-badge"><span class="res-final-dot"></span>FINALIZADO</span>') +
        '</div>' +
        '<div class="match-pair-row res-team-header">' +
        '<div class="match-pair-name" style="flex:1;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamAColor + ';margin-right:0.3rem;vertical-align:middle;"></span>' +
        esc(j1Name) + paymentDotHtml(partido.jugador_a_1_id) + ' / ' + esc(j2Name) + paymentDotHtml(partido.jugador_a_2_id) + '</div>' +
        '<div class="match-pair-name" style="flex:1;text-align:right;">' +
        esc(j3Name) + paymentDotHtml(partido.jugador_b_1_id) + ' / ' + esc(j4Name) + paymentDotHtml(partido.jugador_b_2_id) +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamBColor + ';margin-left:0.3rem;vertical-align:middle;"></span>' +
        '</div>' +
        '</div>' +

        unitHtml +

        '<div class="match-meta">' +
        (fechaStr ? '<span class="res-meta-date">' + esc(fechaStr) + '</span>' : '') +
        ' · <span class="res-meta-jornada">Jornada ' + esc(String(getJornadaNumero(partido))) + '</span>' +
        '</div>' +
        '<div class="btn-group-spaced btn-group-inline">' +
        '<button class="btn btn-primary btn-sm btn-compact" data-res-save="' + partido.id + '"><span class="material-symbols-outlined" style="font-size:0.65rem;">' + (isFinalizado ? 'update' : 'save') + '</span> ' + (isFinalizado ? 'actualizar' : 'registrar') + '</button>' +
        (isFinalizado ? '<button class="btn btn-sm btn-danger btn-compact" data-res-clear="' + partido.id + '"><span class="material-symbols-outlined" style="font-size:0.65rem;">delete</span> borrar</button>' : '') +
        (resEditing[partido.id] ? '<button class="btn btn-sm btn-outline btn-compact" data-res-collapse="' + partido.id + '" title="Cancelar edición" style="gap:0.3rem;"><span class="material-symbols-outlined" style="font-size:0.85rem;">close</span> Cancelar</button>' : '') +
        '</div>' +
        '</div>' +
        '</div>';
}

function resUnitToken(a, b, tbA, tbB) {
    if (a === 4 && b === 4 && tbA != null && tbB != null) {
        const tieWinner = tbA > tbB ? 'a' : 'b';
        return {
            a: { text: String(tieWinner === 'a' ? 6 : 5) + '(' + tbA + ')', win: tbA > tbB },
            b: { text: String(tieWinner === 'b' ? 6 : 5) + '(' + tbB + ')', win: tbB > tbA }
        };
    }
    return {
        a: { text: String(a), win: a > b },
        b: { text: String(b), win: b > a }
    };
}

function buildResScoreTokens(rs) {
    const s1 = resUnitToken(rs.set1_a, rs.set1_b, rs.tb1_a, rs.tb1_b);
    const s2 = resUnitToken(rs.set2_a, rs.set2_b, rs.tb2_a, rs.tb2_b);
    const tokens = { a: [s1.a, s2.a], b: [s1.b, s2.b] };
    if (rs.stb_a != null && rs.stb_b != null) {
        tokens.a.push({ text: String(rs.stb_a), win: rs.stb_a > rs.stb_b });
        tokens.b.push({ text: String(rs.stb_b), win: rs.stb_b > rs.stb_a });
    }
    return tokens;
}

function renderResSetTokens(tokens) {
    return tokens.map(t =>
        '<span class="res-set' + (t.win ? ' res-set-win' : ' res-set-lose') + '">' + esc(t.text) + '</span>'
    ).join('');
}

function resCardCompactHtml(partido, rs, j1Name, j2Name, j3Name, j4Name, teamAColor, teamBColor, num, fechaStr) {
    const ganadorId = partido.ganador_equipo_id;
    const aWins = ganadorId === partido.equipo_a_id;
    const bWins = ganadorId === partido.equipo_b_id;

    const tokens = buildResScoreTokens(rs);
    const scoreA = renderResSetTokens(tokens.a);
    const scoreB = renderResSetTokens(tokens.b);
    const ganadorNombre = aWins ? getTeamName(partido.equipo_a_id) : getTeamName(partido.equipo_b_id);
    const ganadorColor = aWins ? teamAColor : teamBColor;

    const jorLabel = 'Jornada ' + esc(String(getJornadaNumero(partido)));
    const headerParts = [];
    if (fechaStr) headerParts.push('<span class="res-meta-date">' + esc(fechaStr) + '</span>');
    headerParts.push('<span class="res-meta-jornada">' + jorLabel + '</span>');
    headerParts.push('<span class="res-meta-category">' + esc(formatCategoria(partido.categoria || '')) + '</span>');

    return '<div class="res-public-card res-final-admin" data-res-card="' + partido.id + '">' +
        '<div class="res-public-header">' + headerParts.join(' · ') + ' · <span class="res-final-badge"><span class="res-final-dot"></span>FINALIZADO</span>' + '</div>' +
        '<div class="res-public-player">' +
        '<div class="res-public-dot" style="background:' + teamAColor + ';"></div>' +
        '<div>' +
        '<div class="res-public-name">' + esc(j1Name) + paymentDotHtml(partido.jugador_a_1_id) + ' / ' + esc(j2Name) + paymentDotHtml(partido.jugador_a_2_id) + '</div>' +
        '</div>' +
        '<div class="res-public-score">' + scoreA + '</div>' +
        '</div>' +
        '<div class="res-public-player">' +
        '<div class="res-public-dot" style="background:' + teamBColor + ';"></div>' +
        '<div>' +
        '<div class="res-public-name">' + esc(j3Name) + paymentDotHtml(partido.jugador_b_1_id) + ' / ' + esc(j4Name) + paymentDotHtml(partido.jugador_b_2_id) + '</div>' +
        '</div>' +
        '<div class="res-public-score">' + scoreB + '</div>' +
        '</div>' +
        '<div class="res-winner-declaration"><span class="res-winner-label">Ganó</span> <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + ganadorColor + ';vertical-align:middle;margin-right:0.3rem;"></span><span class="res-winner-name">' + esc(ganadorNombre) + '</span></div>' +
        '<div class="btn-group-spaced">' +
        '<button class="btn btn-primary btn-sm btn-compact btn-icon" data-res-edit="' + partido.id + '" title="Editar"><span class="material-symbols-outlined" style="font-size:0.85rem;">edit</span></button>' +
        '<button class="btn btn-sm btn-danger btn-compact btn-icon" data-res-clear="' + partido.id + '" title="Borrar"><span class="material-symbols-outlined" style="font-size:0.85rem;">delete</span></button>' +
        '</div>' +
        '</div>';
}

function bindResPanelEvents(panel) {
    document.getElementById('result-search')?.addEventListener('input', () => {
        clearTimeout(_debounceTimers.get('result'));
        _debounceTimers.set('result', setTimeout(() => {
            const term = document.getElementById('result-search').value.toLowerCase();
            panel.querySelectorAll('.card, .res-public-card').forEach(card => {
                card.style.display = card.textContent.toLowerCase().includes(term) ? '' : 'none';
            });
        }, 150));
    });

    panel.querySelectorAll('[data-res-view]').forEach(b => b.addEventListener('click', () => {
        resView = b.dataset.resView;
        if (resView === 'jornada') resSelectedJornadaId = null;
        flushDrafts();
        renderResultados();
    }));

    document.getElementById('btn-back-res-jornadas')?.addEventListener('click', () => {
        resSelectedJornadaId = null;
        renderResultados();
    });

    panel.querySelectorAll('[data-jornada-toggle]').forEach(btn => btn.addEventListener('click', () => {
        const targetId = btn.dataset.jornadaToggle;
        const container = document.getElementById(targetId);
        if (!container) return;
        const isHidden = container.style.display === 'none';
        container.style.display = isHidden ? '' : 'none';
        const icon = btn.querySelector('.jornada-toggle-icon');
        if (icon) icon.textContent = isHidden ? 'expand_less' : 'expand_more';
        btn.childNodes[btn.childNodes.length - 1].textContent = isHidden ? ' Ocultar partidos' : ' Ver partidos';
    }));
}

function bindResCardEvents(card, panel, onCollapse) {
    card.querySelectorAll('[data-res-adj]').forEach(b => b.addEventListener('click', () => {
        const id = b.dataset.resAdj;
        const team = b.dataset.team;
        const delta = parseInt(b.dataset.delta);
        const unit = b.dataset.unit;
        if (adjustUnit(id, unit, team, delta)) {
            updateResCardInPlace(id, panel, onCollapse);
            queueDraftSave(id);
            maybeConfirmUnit(id, unit, panel);
        }
    }));

    card.querySelectorAll('[data-res-save]').forEach(b => b.addEventListener('click', () => safeAction(() => saveResultado(b.dataset.resSave))));
    card.querySelectorAll('[data-res-clear]').forEach(b => b.addEventListener('click', () => confirmBorrarResultado(b.dataset.resClear)));
    card.querySelectorAll('[data-res-edit]').forEach(b => b.addEventListener('click', () => {
        resEditing[b.dataset.resEdit] = true;
        renderResultados();
    }));
    card.querySelectorAll('[data-res-collapse]').forEach(b => b.addEventListener('click', () => {
        delete resEditing[b.dataset.resCollapse];
        if (onCollapse) onCollapse();
        else renderResultados();
    }));
}

function updateResCardInPlace(id, panel, onCollapse) {
    const oldCard = panel.querySelector('[data-res-card="' + id + '"]');
    const partido = resPartidos.find(p => p.id === id);
    if (!oldCard && !partido) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = resCardHtml(partido);
    const newCard = tmp.firstChild;
    if (oldCard) oldCard.replaceWith(newCard);
    bindResCardEvents(newCard, panel, onCollapse);
}

function setWinner(sa, sb, tba, tbb) {
    if (tba != null && tbb != null) return tba > tbb ? 'a' : (tbb > tba ? 'b' : null);
    if (sa > sb) return 'a';
    if (sb > sa) return 'b';
    return null;
}

function getActiveUnit(rs) {
    if (rs.set1_a === 4 && rs.set1_b === 4) {
        if (!isTBComplete(rs.tb1_a, rs.tb1_b)) return 'tb1';
    } else if (!isSetGamesDone(rs.set1_a, rs.set1_b)) {
        return 'set1';
    }
    if (rs.set2_a === 4 && rs.set2_b === 4) {
        if (!isTBComplete(rs.tb2_a, rs.tb2_b)) return 'tb2';
    } else if (!isSetGamesDone(rs.set2_a, rs.set2_b)) {
        return 'set2';
    }
    const a = (setWinner(rs.set1_a, rs.set1_b, rs.tb1_a, rs.tb1_b) === 'a' ? 1 : 0) +
              (setWinner(rs.set2_a, rs.set2_b, rs.tb2_a, rs.tb2_b) === 'a' ? 1 : 0);
    const b = 2 - a;
    if (a === 1 && b === 1) return 'stb';
    return null;
}

const RES_UNIT_LABELS = {
    set1: 'Set 1',
    set2: 'Set 2',
    tb1: 'Tie Break 1',
    tb2: 'Tie Break 2',
    stb: 'Super Tie Break'
};

function unitLabel(unit) {
    return RES_UNIT_LABELS[unit] || unit;
}

function getUnitScore(rs, unit) {
    switch (unit) {
        case 'set1': return { a: rs.set1_a, b: rs.set1_b };
        case 'set2': return { a: rs.set2_a, b: rs.set2_b };
        case 'tb1': return { a: rs.tb1_a != null ? rs.tb1_a : 0, b: rs.tb1_b != null ? rs.tb1_b : 0 };
        case 'tb2': return { a: rs.tb2_a != null ? rs.tb2_a : 0, b: rs.tb2_b != null ? rs.tb2_b : 0 };
        case 'stb': return { a: rs.stb_a != null ? rs.stb_a : 0, b: rs.stb_b != null ? rs.stb_b : 0 };
        default: return { a: 0, b: 0 };
    }
}

function isUnitClosed(unit, rs) {
    const s = getUnitScore(rs, unit);
    if (unit === 'set1' || unit === 'set2') return isSetGamesDone(s.a, s.b);
    if (unit === 'tb1' || unit === 'tb2') return isTBComplete(s.a, s.b);
    if (unit === 'stb') return isValidSupertiebreak(s.a, s.b);
    return false;
}

function adjustUnit(id, unit, team, delta) {
    const rs = resultScores[id];
    if (!rs) return false;
    rs._closed = rs._closed || {};
    let changed = false;

    if (unit === 'set1' || unit === 'set2') {
        const keyA = unit + '_a', keyB = unit + '_b';
        const a = rs[keyA], b = rs[keyB];
        if (delta > 0 && !canIncrementGames(a + (team === 'a' ? delta : 0), b + (team === 'b' ? delta : 0))) return false;
        const r = adjustScore(a, b, team, delta);
        rs[keyA] = r.a; rs[keyB] = r.b;
        if (!isSetGamesDone(r.a, r.b)) rs._closed[unit] = false;
        changed = (r.a !== a) || (r.b !== b);
    } else if (unit === 'tb1' || unit === 'tb2') {
        const keyA = unit + '_a', keyB = unit + '_b';
        if (rs[keyA] == null) { rs[keyA] = 0; rs[keyB] = 0; }
        const a = rs[keyA], b = rs[keyB];
        const r = adjustTB(a, b, team, delta);
        rs[keyA] = r.a; rs[keyB] = r.b;
        if (!isTBComplete(r.a, r.b)) rs._closed[unit] = false;
        changed = (r.a !== a) || (r.b !== b);
    } else if (unit === 'stb') {
        if (rs.stb_a == null) { rs.stb_a = 0; rs.stb_b = 0; }
        const a = rs.stb_a, b = rs.stb_b;
        const r = adjustSTB(a, b, team, delta);
        rs.stb_a = r.a; rs.stb_b = r.b;
        if (!isValidSupertiebreak(r.a, r.b)) rs._closed[unit] = false;
        changed = (r.a !== a) || (r.b !== b);
    }
    return changed;
}

function maybeConfirmUnit(id, unit, panel) {
    const rs = resultScores[id];
    if (!rs) return;
    rs._closed = rs._closed || {};
    if (rs._closed[unit]) return;
    if (!isUnitClosed(unit, rs)) return;
    const score = getUnitScore(rs, unit);
    showConfirmModal(
        '¿Confirmás que ' + unitLabel(unit) + ' terminó ' + score.a + ' - ' + score.b + '?',
        () => { rs._closed[unit] = true; flushDrafts(); renderResultados(); },
        () => { renderResultados(); }
    );
}

function showConfirmModal(message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal">' +
        '<h3 style="font-size:0.95rem;">Confirmar cierre</h3>' +
        '<p style="font-size:0.85rem;color:var(--on-surface-variant-70);margin-bottom:1rem;">' + esc(message) + '</p>' +
        '<div class="btn-group" style="justify-content:flex-end;">' +
        '<button class="btn btn-outline" id="btn-modal-cancel">Seguir editando</button>' +
        '<button class="btn btn-primary" id="btn-modal-confirm">Confirmar</button>' +
        '</div>' +
        '</div>';
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('btn-modal-cancel').addEventListener('click', () => { close(); if (onCancel) onCancel(); });
    document.getElementById('btn-modal-confirm').addEventListener('click', () => { close(); if (onConfirm) onConfirm(); });
}

function confirmBorrarResultado(partidoId) {
    const partido = resPartidos.find(p => p.id === partidoId);
    if (!partido) return;
    const catTxt = formatCategoria(partido.categoria) || 'este partido';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal">' +
        '<h3 style="font-size:0.95rem;color:var(--error);"><span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">warning</span> Borrar resultado</h3>' +
        '<p style="font-size:0.85rem;color:var(--on-surface-variant-70);margin-bottom:1rem;">Estás por borrar el resultado de <strong>' + esc(catTxt) + '</strong>.<br>Se eliminarán los scores, el ganador y los juegos del partido.<br>Los jugadores y la jornada NO se eliminan.</p>' +
        '<div class="btn-group" style="justify-content:flex-end;">' +
        '<button class="btn btn-outline" id="btn-borrar-cancel">Cancelar</button>' +
        '<button class="btn btn-danger" id="btn-borrar-confirm"><span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">delete</span> Sí, borrar</button>' +
        '</div>' +
        '</div>';
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('btn-borrar-cancel').addEventListener('click', () => close());
    document.getElementById('btn-borrar-confirm').addEventListener('click', () => { close(); safeAction(() => clearResultado(partidoId)); });
}

// ═══════════════════════════════════════════
// POSICIONES
// ═══════════════════════════════════════════
let allEnfrentamientosData = [];

async function loadAllEnfrentamientosAndPartidos() {
    allEnfrentamientosData = [];
    if (!getActiveTournamentId()) return;
    await loadAllPartidos();
    allEnfrentamientosData = allJornadas.map(j => ({
        id: j.id,
        equipo_a_id: j.equipo_a_id,
        equipo_b_id: j.equipo_b_id,
        _jornadaId: j.id,
        _jornadaNumero: j.numero,
        cerrada: j.cerrada === true,
        partidos: _partidosCache.filter(p => p._resJornadaId === j.id)
    }));
}

function renderPosiciones() {
    const panel = document.getElementById('panel-posiciones');
    panelLoading(panel, 'Calculando posiciones...');

    loadAllEnfrentamientosAndPartidos().then(() => {
        const result = calculateStandings(allEquipos, allEnfrentamientosData);
        const { standings, roundStatus, totalEnfrentamientos, completedEnfrentamientos } = result;
        const allComplete = roundStatus === 'finalizado';

        if (!standings.length) {
            panel.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Aún no hay equipos configurados</p></div>';
            return;
        }

        let html = '';

        // Status indicator
        html += '<div class="card" style="border-left:4px solid ' + (allComplete ? 'var(--secondary)' : 'var(--primary)') + ';margin-bottom:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.5rem;">' +
            '<span class="material-symbols-outlined" style="font-size:1rem;color:' + (allComplete ? 'var(--secondary)' : 'var(--primary)') + ';">' + (allComplete ? 'check_circle' : 'hourglass_empty') + '</span>' +
            '<div>' +
            '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">' + (allComplete ? 'ROUND ROBIN FINALIZADO' : 'ROUND ROBIN EN CURSO') + '</div>' +
            '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);">Enfrentamientos: ' + completedEnfrentamientos + '/' + totalEnfrentamientos + ' completados</div>' +
            '</div>' +
            '</div>' +
            '</div>';

        // Header de stats
        html += '<div class="card" style="margin-bottom:0.5rem;padding:0.5rem 0.75rem;">' +
            '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">' +
            '<div style="min-width:1.5rem;"></div>' +
            '<div style="flex:1;"></div>' +
            '<div style="display:flex;gap:0.5rem;">' +
            '<div style="min-width:2.2rem;text-align:center;"><span style="font-size:0.6rem;font-weight:600;color:var(--on-surface-variant-40);">JJ</span></div>' +
            '<div style="min-width:2.2rem;text-align:center;"><span style="font-size:0.6rem;font-weight:600;color:var(--primary);">JG</span></div>' +
            '<div style="min-width:2.2rem;text-align:center;"><span style="font-size:0.6rem;font-weight:600;color:var(--on-surface-variant-40);">PJ</span></div>' +
            '<div style="min-width:2.2rem;text-align:center;"><span style="font-size:0.6rem;font-weight:600;color:var(--on-surface-variant-40);">PG</span></div>' +
            '<div style="min-width:2.2rem;text-align:center;"><span style="font-size:0.6rem;font-weight:600;color:var(--on-surface-variant-40);">PP</span></div>' +
            '<div style="min-width:2.2rem;text-align:center;"><span style="font-size:0.6rem;font-weight:600;color:var(--primary);">PTS</span></div>' +
            '</div>' +
            '</div>' +
            '</div>';

        // Standings cards
        standings.forEach((s, i) => {
            const isQualified = i < 4;
            const qualBorder = isQualified ? 'border-left:4px solid ' + s.color + ';' : 'border-left:4px solid var(--white-8);';
            const qualBg = isQualified ? 'background:rgba(255,255,255,0.03);' : '';

            html += '<div class="card" style="' + qualBorder + qualBg + 'margin-bottom:0.5rem;">' +
                '<div style="display:flex;align-items:center;gap:0.5rem;">' +
                '<div style="min-width:1.5rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:800;font-size:1rem;color:' + (isQualified ? s.color : 'var(--on-surface-variant-40)') + ';">' + s.posicion + 'º</div>' +
                '</div>' +
                '<div style="flex:1;display:flex;align-items:center;gap:0.4rem;min-width:0;">' +
                '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + s.color + ';flex-shrink:0;"></span>' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.nombre) + '</span>' +
                '</div>' +
                '<div style="display:flex;gap:0.5rem;">' +
                '<div style="min-width:2.2rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.9rem;">' + s.jornadas_disputadas + '</div>' +
                '</div>' +
                '<div style="min-width:2.2rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.9rem;color:var(--primary);">' + s.jornadas_ganadas + '</div>' +
                '</div>' +
                '<div style="min-width:2.2rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.9rem;">' + s.partidos_jugados + '</div>' +
                '</div>' +
                '<div style="min-width:2.2rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.9rem;color:var(--secondary);">' + s.partidos_ganados + '</div>' +
                '</div>' +
                '<div style="min-width:2.2rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.9rem;">' + s.partidos_perdidos + '</div>' +
                '</div>' +
                '<div style="min-width:2.2rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:800;font-size:1rem;color:var(--primary);">' + s.puntos + '</div>' +
                '</div>' +
                '</div>' +
                '</div>' +
                (isQualified ? '<div style="font-size:0.6rem;color:var(--secondary);font-weight:600;margin-top:0.2rem;padding-top:0.2rem;border-top:1px solid var(--white-5);"><span class="material-symbols-outlined" style="font-size:0.55rem;vertical-align:middle;">emoji_events</span> CLASIFICADO</div>' : '') +
                '</div>';
        });

        // Semifinal preview
        if (standings.length >= 4) {
            const s1 = standings[0], s4 = standings[3];
            const s2 = standings[1], s3 = standings[2];
            html += '<div class="card" style="border-top:3px solid var(--secondary);margin-top:0.75rem;">' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;margin-bottom:0.6rem;"><span class="material-symbols-outlined" style="font-size:0.9rem;color:var(--secondary);">emoji_events</span> SEMIFINALES</div>' +
                '<div style="display:flex;flex-direction:column;gap:0.6rem;">' +
                '<div style="background:var(--white-5);border-radius:8px;padding:0.6rem;">' +
                '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.3rem;">SEMIFINAL 1</div>' +
                '<div style="display:flex;align-items:center;gap:0.4rem;">' +
                '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s1.color + ';"></span>' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;">1º ' + esc(s1.nombre) + '</span>' +
                '<span style="font-family:Lexend;font-weight:800;font-size:0.72rem;color:var(--on-surface-variant-40);margin:0 0.3rem;">VS</span>' +
                '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s4.color + ';"></span>' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;">4º ' + esc(s4.nombre) + '</span>' +
                '</div></div>' +
                '<div style="background:var(--white-5);border-radius:8px;padding:0.6rem;">' +
                '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.3rem;">SEMIFINAL 2</div>' +
                '<div style="display:flex;align-items:center;gap:0.4rem;">' +
                '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s2.color + ';"></span>' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;">2º ' + esc(s2.nombre) + '</span>' +
                '<span style="font-family:Lexend;font-weight:800;font-size:0.72rem;color:var(--on-surface-variant-40);margin:0 0.3rem;">VS</span>' +
                '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s3.color + ';"></span>' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;">3º ' + esc(s3.nombre) + '</span>' +
                '</div></div>' +
                '</div>' +
                (allComplete ? '<div style="margin-top:0.6rem;text-align:center;font-size:0.72rem;color:var(--secondary);font-weight:600;">¡Los clasificados están definidos!</div>' : '<div style="margin-top:0.6rem;text-align:center;font-size:0.72rem;color:var(--on-surface-variant-40);">Los cruces se definirán al finalizar el Round Robin</div>') +
                '</div>';
        } else if (standings.length > 0) {
            html += '<div class="card" style="border-top:3px solid var(--on-surface-variant-40);margin-top:0.75rem;">' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;margin-bottom:0.4rem;"><span class="material-symbols-outlined" style="font-size:0.9rem;color:var(--on-surface-variant-40);">info</span> SEMIFINALES</div>' +
                '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">Se necesitan al menos 4 equipos para definir semifinales.</div>' +
                '</div>';
        }

        // Leyenda
        html += '<div class="card" style="border-left:4px solid var(--on-surface-variant-40);margin-top:0.75rem;">' +
            '<div style="font-family:Lexend;font-weight:600;font-size:0.8rem;margin-bottom:0.6rem;color:var(--on-surface-variant-40);"><span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">info</span> CÁLCULO DE PUNTOS</div>' +
            '<div style="display:flex;flex-direction:column;gap:0.4rem;font-size:0.72rem;color:var(--on-surface-variant-40);">' +
            '<div><span style="font-weight:600;">JJ (Jornadas Disputadas):</span> Total de jornadas jugadas por el equipo.</div>' +
            '<div><span style="font-weight:600;color:var(--primary);">JG (Jornadas Ganadas):</span> Se gana la jornada con 4+ partidos ganados. +5 puntos bonus.</div>' +
            '<div><span style="font-weight:600;color:var(--secondary);">PG (Partidos Ganados):</span> Cada partido ganado suma +1 punto.</div>' +
            '<div><span style="font-weight:600;">PP (Partidos Perdidos):</span> Los partidos perdidos no suman puntos.</div>' +
            '<div><span style="font-weight:600;">PJ (Partidos Jugados):</span> Total de partidos finalizados/completados.</div>' +
            '</div>' +
            '</div>';

        panel.innerHTML = html;
    });
}

// ═══════════════════════════════════════════
// JORNADAS + ENFRENTAMIENTOS
// ═══════════════════════════════════════════
let editingJornadaId = null;

function getJornadaDateFormatted(fecha) {
    if (!fecha) return 'Sin fecha';
    try {
        const d = fecha.toDate ? fecha.toDate() : new Date(fecha);
        if (isNaN(d.getTime())) return 'Sin fecha';
        const months = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
        return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    } catch (e) { return 'Sin fecha'; }
}

function getJornadaDateShort(fecha) {
    if (!fecha) return '—';
    try {
        const d = fecha.toDate ? fecha.toDate() : new Date(fecha);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('es-AR');
    } catch (e) { return '—'; }
}

function getJornadaEstadoBadge(estado) {
    switch (estado) {
        case 'en_curso': return '<span class="badge" style="background:var(--secondary-container);color:var(--secondary);">En curso</span>';
        case 'finalizado': return '<span class="badge badge-success">Finalizado</span>';
        default: return '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);">Pendiente</span>';
    }
}

function getEnfrentamientoEstadoBadge(estado) {
    switch (estado) {
        case 'finalizado': return '<span class="badge badge-success">Finalizado</span>';
        case 'en_curso': return '<span class="badge" style="background:var(--secondary-container);color:var(--secondary);">En curso</span>';
        default: return '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);">Pendiente</span>';
    }
}

function renderJornadas() {
    const panel = document.getElementById('panel-jornadas');
    const isEditing = !!editingJornadaId;
    const jEdit = isEditing ? allJornadas.find(x => x.id === editingJornadaId) : null;

    const activeTeams = allEquipos.filter(t => t.activo !== false);

    let html = '';

    // Create/Edit jornada form
    html += '<div class="card">' +
        '<button class="collapse-toggle" id="jor-toggle-form" type="button" aria-expanded="' + (isEditing ? 'true' : 'false') + '">' +
        '<span class="collapse-toggle-left"><span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">calendar_today</span> ' + (isEditing ? 'Editar Jornada' : 'Nueva Jornada') + '</span>' +
        '<span class="material-symbols-outlined chevron">' + (isEditing ? 'expand_less' : 'expand_more') + '</span>' +
        '</button>' +
        '<div id="jor-form-body" style="display:' + (isEditing ? 'block' : 'none') + ';">' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1;"><label>Fecha</label><input type="date" id="j-fecha" value="' + (jEdit && jEdit.fecha ? (jEdit.fecha.toDate ? jEdit.fecha.toDate().toISOString().split('T')[0] : new Date(jEdit.fecha).toISOString().split('T')[0]) : '') + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1;"><label>Equipo A</label>' +
        '<select id="j-equipo-a">' +
        '<option value="">— Seleccionar —</option>' +
        activeTeams.map(eq => '<option value="' + eq.id + '"' + (jEdit && jEdit.equipo_a_id === eq.id ? ' selected' : '') + '>' + esc(eq.nombre) + '</option>').join('') +
        '</select></div>' +
        '<div style="display:flex;align-items:end;padding-bottom:0.4rem;font-family:Lexend;font-weight:600;font-size:0.9rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div class="form-group" style="flex:1;"><label>Equipo B</label>' +
        '<select id="j-equipo-b">' +
        '<option value="">— Seleccionar —</option>' +
        activeTeams.map(eq => '<option value="' + eq.id + '"' + (jEdit && jEdit.equipo_b_id === eq.id ? ' selected' : '') + '>' + esc(eq.nombre) + '</option>').join('') +
        '</select></div>' +
        '</div>' +
        '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-jornada"><span class="material-symbols-outlined" style="font-size:1rem;">' + (isEditing ? 'save' : 'add') + '</span> ' + (isEditing ? 'Actualizar' : 'Crear Jornada') + '</button>' +
        (isEditing ? '<button class="btn btn-outline" id="btn-cancel-jornada"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' : '') +
        '</div>' +
        '</div>' +
        '</div>';

    // Jornadas list
    if (allJornadas.length) {
        html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">calendar_today</span> Jornadas (' + allJornadas.length + ')</div>';
        html += allJornadas.map(j => {
            const fechaStr = getJornadaDateShort(j.fecha);
            const teamAName = getTeamName(j.equipo_a_id) || j.equipo_a_nombre || '?';
            const teamBName = getTeamName(j.equipo_b_id) || j.equipo_b_nombre || '?';
            const teamAColor = getTeamColor(j.equipo_a_id) || '#888';
            const teamBColor = getTeamColor(j.equipo_b_id) || '#888';
            return '<div class="card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;"><span class="material-symbols-outlined" style="font-size:0.9rem;color:var(--primary);vertical-align:middle;">calendar_today</span> Jornada ' + esc(String(j.numero || '')) + '</div>' +
            '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.15rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.7rem;">event</span> ' + esc(fechaStr) +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:0.4rem;margin-top:0.25rem;flex-wrap:wrap;">' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.8rem;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + teamAColor + ';"></span>' + esc(teamAName) +
            '</span>' +
            '<span style="font-family:Lexend;font-weight:800;font-size:0.7rem;color:var(--on-surface-variant-40);">VS</span>' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.8rem;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + teamBColor + ';"></span>' + esc(teamBName) +
            '</span>' +
            '</div>' +
            '</div>' +
            '<div style="display:flex;gap:0.3rem;">' +
            '<button class="btn btn-sm btn-outline" data-edit-jornada="' + j.id + '"><span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span></button>' +
            '<button class="btn btn-sm btn-danger" data-del-jornada="' + j.id + '"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' +
            '</div>' +
            '</div>' +
            '</div>';
        }).join('');
    } else {
        html += '<div class="empty-state" style="padding:1.5rem;"><span class="material-symbols-outlined">calendar_today</span><p>No hay jornadas creadas. Creá la primera arriba.</p></div>';
    }

    panel.innerHTML = html;

    // Event listeners — Jornada form
    document.getElementById('jor-toggle-form')?.addEventListener('click', () => {
        const body = document.getElementById('jor-form-body');
        const btn = document.getElementById('jor-toggle-form');
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        btn.classList.toggle('open', !open);
        btn.querySelector('.chevron').textContent = open ? 'expand_more' : 'expand_less';
    });
    document.getElementById('btn-save-jornada')?.addEventListener('click', () => safeAction(saveJornada));
    document.getElementById('btn-cancel-jornada')?.addEventListener('click', () => { editingJornadaId = null; renderJornadas(); });
    panel.querySelectorAll('[data-edit-jornada]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editingJornadaId = b.dataset.editJornada; renderJornadas(); }));
    panel.querySelectorAll('[data-del-jornada]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); safeAction(() => deleteJornada(b.dataset.delJornada)); }));
}

async function saveJornada() {
    const fecha = document.getElementById('j-fecha').value;
    const aId = document.getElementById('j-equipo-a').value;
    const bId = document.getElementById('j-equipo-b').value;

    if (!fecha) { toast('Seleccioná una fecha', 'error'); return; }
    if (!aId) { toast('Seleccioná el equipo A', 'error'); return; }
    if (!bId) { toast('Seleccioná el equipo B', 'error'); return; }
    if (aId === bId) { toast('Los equipos no pueden ser el mismo', 'error'); return; }

    const teamAName = getTeamName(aId);
    const teamBName = getTeamName(bId);
    const fechaDate = new Date(fecha + 'T12:00:00');

    showLoading(editingJornadaId ? 'Actualizando jornada...' : 'Creando jornada...');
    try {
        if (editingJornadaId) {
            await updateDoc(docRef('jornadas', editingJornadaId), {
                fecha: fechaDate,
                equipo_a_id: aId,
                equipo_b_id: bId,
                equipo_a_nombre: teamAName,
                equipo_b_nombre: teamBName
            });
            toast('Jornada actualizada', 'success');
        } else {
            const nextNumero = allJornadas.length ? Math.max(0, ...allJornadas.map(j => j.numero || 0)) + 1 : 1;
            await addDoc(col('jornadas'), {
                numero: nextNumero,
                fecha: fechaDate,
                equipo_a_id: aId,
                equipo_b_id: bId,
                equipo_a_nombre: teamAName,
                equipo_b_nombre: teamBName,
                cerrada: false
            });
            toast('Jornada ' + nextNumero + ' creada', 'success');
        }
        editingJornadaId = null;
        await refreshData();
    } catch (e) {
        toast('Error al guardar jornada', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

async function deleteJornada(id) {
    const j = allJornadas.find(x => x.id === id);
    if (!j) return;

    try {
        const partidosSnap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'jornadas', id, 'partidos'));
        if (!partidosSnap.empty) {
            toast('No se puede eliminar: la jornada tiene ' + partidosSnap.size + ' partido(s). Eliminalos primero desde DRAW.', 'error');
            return;
        }
    } catch (e) {
        console.error('Error checking partidos:', e);
    }

    if (!confirm('¿Eliminar la Jornada ' + j.numero + '?')) return;
    showLoading('Eliminando jornada...');
    try {
        await deleteDoc(docRef('jornadas', id));
        toast('Jornada eliminada', 'success');
        await refreshData();
    } catch (e) {
        toast('Error al eliminar', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ── Cerrar / Reabrir Jornada ──
async function cerrarJornada(jornadaId) {
    const jornada = allJornadas.find(j => j.id === jornadaId);
    if (!jornada) return;

    const partidos = resPartidos.filter(p => p._resJornadaId === jornadaId);
    const finalizados = partidos.filter(p => p.estado === 'finalizado');
    const total = partidos.length || getDrawCategoriasActivas().length;

    let aWins = 0, bWins = 0, empates = 0;
    finalizados.forEach(p => {
        if (p.ganador_equipo_id === jornada.equipo_a_id) aWins++;
        else if (p.ganador_equipo_id === jornada.equipo_b_id) bWins++;
        else empates++;
    });

    const teamAName = getTeamName(jornada.equipo_a_id) || 'Equipo A';
    const teamBName = getTeamName(jornada.equipo_b_id) || 'Equipo B';
    const teamAColor = getTeamColor(jornada.equipo_a_id) || '#4da6ff';
    const teamBColor = getTeamColor(jornada.equipo_b_id) || '#feb300';

    const ptsA = aWins;
    const bonusA = (aWins > bWins) ? 5 : 0;
    const totalA = ptsA + bonusA;
    const ptsB = bWins;
    const bonusB = (bWins > aWins) ? 5 : 0;
    const totalB = ptsB + bonusB;

    let ganadorHtml = '';
    let ganadorId = null;
    if (aWins > bWins) {
        ganadorId = jornada.equipo_a_id;
        ganadorHtml = '<div style="margin-top:0.75rem;padding:0.75rem;background:rgba(0,212,170,0.1);border-radius:8px;border:1px solid rgba(0,212,170,0.3);text-align:center;">' +
            '<span style="color:var(--primary);font-weight:600;">Ganador: <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + teamAColor + ';vertical-align:middle;margin:0 4px;"></span>' + esc(teamAName) + '</span><br>' +
            '<span style="font-size:0.8rem;color:var(--on-surface-variant-30);">+5 puntos de bono</span></div>';
    } else if (bWins > aWins) {
        ganadorId = jornada.equipo_b_id;
        ganadorHtml = '<div style="margin-top:0.75rem;padding:0.75rem;background:rgba(0,212,170,0.1);border-radius:8px;border:1px solid rgba(0,212,170,0.3);text-align:center;">' +
            '<span style="color:var(--primary);font-weight:600;">Ganador: <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + teamBColor + ';vertical-align:middle;margin:0 4px;"></span>' + esc(teamBName) + '</span><br>' +
            '<span style="font-size:0.8rem;color:var(--on-surface-variant-30);">+5 puntos de bono</span></div>';
    } else {
        ganadorHtml = '<div style="margin-top:0.75rem;padding:0.75rem;background:rgba(253,203,110,0.1);border-radius:8px;border:1px solid rgba(253,203,110,0.3);text-align:center;">' +
            '<span style="color:var(--secondary);font-weight:600;">Empate — Nadie recibe bono</span></div>';
    }

    const modalHtml = '<div id="modal-cerrar-jornada" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:var(--surface);border-radius:12px;padding:1.5rem;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);">' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;">' +
        '<span class="material-symbols-outlined" style="color:var(--secondary);font-size:1.2rem;">lock</span>' +
        '<span style="font-family:Lexend;font-weight:600;font-size:0.95rem;">Cerrar Jornada ' + esc(String(jornada.numero)) + '</span></div>' +
        '<div style="font-size:0.85rem;color:var(--on-surface-variant-30);margin-bottom:0.5rem;">' +
        'Se finalizaron <strong>' + finalizados.length + '</strong> de ' + total + ' partidos.</div>' +
        '<div style="margin:0.75rem 0;font-size:0.85rem;">' +
        '<div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.05);">' +
            '<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + teamAColor + ';vertical-align:middle;margin-right:4px;"></span>' + esc(teamAName) + '</div>' +
            '<div>' + aWins + ' PG × 1 = ' + ptsA + ' pts' + (bonusA ? ' + 5 bono = <strong>' + totalA + ' pts</strong>' : ' pts') + '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;padding:0.4rem 0;">' +
            '<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + teamBColor + ';vertical-align:middle;margin-right:4px;"></span>' + esc(teamBName) + '</div>' +
            '<div>' + bWins + ' PG × 1 = ' + ptsB + ' pts' + (bonusB ? ' + 5 bono = <strong>' + totalB + ' pts</strong>' : ' pts') + '</div>' +
        '</div>' +
        '</div>' + ganadorHtml +
        '<div style="display:flex;gap:0.5rem;margin-top:1rem;justify-content:flex-end;">' +
        '<button id="modal-cerrar-cancel" class="btn btn-outline btn-sm">Cancelar</button>' +
        '<button id="modal-cerrar-confirm" class="btn btn-primary btn-sm" style="background:var(--primary);color:#000;">Sí, cerrar</button>' +
        '</div></div></div>';

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('modal-cerrar-cancel').onclick = () => { document.getElementById('modal-cerrar-jornada')?.remove(); };
    document.getElementById('modal-cerrar-confirm').onclick = async () => {
        document.getElementById('modal-cerrar-jornada')?.remove();
        showLoading('Cerrando jornada...');
        try {
            await updateDoc(doc(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId), { cerrada: true });
            toast('Jornada ' + jornada.numero + ' cerrada' + (ganadorId ? '. Ganó ' + (ganadorId === jornada.equipo_a_id ? teamAName : teamBName) : ' — Empate'), 'success');
            await refreshData();
        const fp = resPartidos.find(x => x.id === partidoId);
        if (fp?._resContainerType === 'semifinal') renderSemifinalDetail();
        else if (fp?._resContainerType === 'final') renderFinalDetail();
        else renderResultados();
        } catch (e) {
            toast('Error al cerrar jornada', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    };
}

async function editarJornada(jornadaId) {
    const jornada = allJornadas.find(j => j.id === jornadaId);
    if (!jornada) return;
    showLoading('Reabriendo jornada...');
    try {
        await updateDoc(doc(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId), { cerrada: false });
        toast('Jornada ' + jornada.numero + ' reabierta', 'success');
        await refreshData();
        renderResultados();
    } catch (e) {
        toast('Error al reabrir jornada', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

window.cerrarJornada = cerrarJornada;
window.editarJornada = editarJornada;

// ═══════════════════════════════════════════
// SEMIFINALES
// ═══════════════════════════════════════════
let allSemifinales = [];
let selectedSemifinalId = null;
let semiPartidos = [];
let editingSemiPartidoId = null;
let editingSemiFormMode = null;

function semiCol() {
    return collection(db, 'torneos', getActiveTournamentId(), 'semifinales');
}

function semiDocRef(semiId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'semifinales', semiId);
}

function semiPartidoCol(semiId) {
    return collection(db, 'torneos', getActiveTournamentId(), 'semifinales', semiId, 'partidos');
}

function semiPartidoDocRef(semiId, partidoId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'semifinales', semiId, 'partidos', partidoId);
}

async function loadSemifinales() {
    allSemifinales = [];
    if (!getActiveTournamentId()) return;
    try {
        const snap = await getDocs(semiCol());
        if (!snap.docs.length) return;
        const results = await Promise.all(snap.docs.map(async docSnap => {
            const semi = { id: docSnap.id, ...normalizeFields(docSnap.data()), partidos: [] };
            const partSnap = await getDocs(semiPartidoCol(semi.id));
            semi.partidos = partSnap.docs.map(p => ({ id: p.id, ...normalizeFields(p.data()) }));
            return semi;
        }));
        allSemifinales = results;
    } catch (e) {
        console.error('Error loading semifinales:', e);
    }
}

async function loadSemiPartidos(semiId) {
    semiPartidos = [];
    if (!semiId) return;
    try {
        const snap = await getDocs(semiPartidoCol(semiId));
                semiPartidos = snap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
    } catch (e) {
        console.error('Error loading semi partidos:', e);
    }
}

async function generateSemifinales() {
    showLoading('Calculando clasificación...');
    try {
        await loadAllEnfrentamientosAndPartidos();
        const result = calculateStandings(allEquipos, allEnfrentamientosData);

        if (result.standings.length < 4) {
            toast('Se necesitan al menos 4 equipos para generar semifinales', 'error');
            return;
        }

        const s = result.standings;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML =
            '<div class="modal">' +
            '<h3 style="font-size:0.95rem;margin-bottom:0.8rem;">Confirmar Semifinales</h3>' +
            '<div style="margin-bottom:0.8rem;">' +
            '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.4rem;font-weight:600;">CLASIFICADOS</div>' +
            s.slice(0, 4).map((eq, i) =>
                '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0;">' +
                '<span style="font-weight:600;font-size:0.8rem;width:1.2rem;">' + (i + 1) + '°</span>' +
                '<span style="width:10px;height:10px;border-radius:50%;background:' + eq.color + ';flex-shrink:0;"></span>' +
                '<span style="flex:1;font-size:0.82rem;">' + esc(eq.nombre) + '</span>' +
                '<span style="font-size:0.72rem;color:var(--on-surface-variant-40);">' + eq.puntos + ' pts</span>' +
                '</div>'
            ).join('') +
            '</div>' +
            '<div style="background:var(--white-5);border-radius:8px;padding:0.6rem;margin-bottom:1rem;">' +
            '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.4rem;font-weight:600;">CRUCES</div>' +
            '<div style="display:flex;align-items:center;gap:0.3rem;font-size:0.82rem;margin-bottom:0.3rem;">' +
            '<span style="background:rgba(0,212,170,0.15);color:var(--primary);padding:1px 6px;border-radius:8px;font-size:0.68rem;font-weight:600;">SF1</span>' +
            '<span style="color:' + s[0].color + ';font-weight:600;">' + esc(s[0].nombre) + '</span>' +
            '<span style="font-weight:800;font-size:0.72rem;color:var(--on-surface-variant-40);">VS</span>' +
            '<span style="color:' + s[3].color + ';font-weight:600;">' + esc(s[3].nombre) + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:0.3rem;font-size:0.82rem;">' +
            '<span style="background:rgba(0,212,170,0.15);color:var(--primary);padding:1px 6px;border-radius:8px;font-size:0.68rem;font-weight:600;">SF2</span>' +
            '<span style="color:' + s[1].color + ';font-weight:600;">' + esc(s[1].nombre) + '</span>' +
            '<span style="font-weight:800;font-size:0.72rem;color:var(--on-surface-variant-40);">VS</span>' +
            '<span style="color:' + s[2].color + ';font-weight:600;">' + esc(s[2].nombre) + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="btn-group" style="justify-content:flex-end;">' +
            '<button class="btn btn-outline" id="btn-cancel-semis">Cancelar</button>' +
            '<button class="btn btn-primary" id="btn-confirm-semis"><span class="material-symbols-outlined" style="font-size:0.9rem;">check</span> Confirmar</button>' +
            '</div></div>';

        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('btn-cancel-semis').addEventListener('click', () => overlay.remove());
        document.getElementById('btn-confirm-semis').addEventListener('click', async () => {
            overlay.remove();
            await doGenerateSemifinales(s);
        });
    } catch (e) {
        toast('Error al calcular clasificación', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

async function doGenerateSemifinales(s) {
    showLoading('Generando semifinales...');
    try {
        await ensureCategorias();
        const catCount = getDrawCategoriasActivas().length;
        const semifinal1 = { equipo_a_id: s[0].id, equipo_a_nombre: s[0].nombre, equipo_a_posicion: 1, equipo_a_color: s[0].color, equipo_b_id: s[3].id, equipo_b_nombre: s[3].nombre, equipo_b_posicion: 4, equipo_b_color: s[3].color, ganador_equipo_id: null, estado: 'pendiente', numero: 1, partidos_esperados: catCount };
        const semifinal2 = { equipo_a_id: s[1].id, equipo_a_nombre: s[1].nombre, equipo_a_posicion: 2, equipo_a_color: s[1].color, equipo_b_id: s[2].id, equipo_b_nombre: s[2].nombre, equipo_b_posicion: 3, equipo_b_color: s[2].color, ganador_equipo_id: null, estado: 'pendiente', numero: 2, partidos_esperados: catCount };

        await Promise.all([addDoc(semiCol(), semifinal1), addDoc(semiCol(), semifinal2)]);

        toast('Semifinales generadas — agregá las categorías que desees', 'success');
        await loadSemifinales();
        renderSemifinales();
    } catch (e) {
        toast('Error al generar semifinales', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

async function saveSemiPartido() {
    const semiId = selectedSemifinalId;
    const editingId = editingSemiPartidoId;
    if (!semiId || !editingId) return;

    const semi = allSemifinales.find(s => s.id === semiId);
    if (!semi) return;

    const isNew = editingId.startsWith('__new__');
    const categoria = isNew ? editingId.replace('__new__', '') : '';

    const j1 = document.getElementById('dp-j1')?.value || null;
    const j2 = document.getElementById('dp-j2')?.value || null;
    const j3 = document.getElementById('dp-j3')?.value || null;
    const j4 = document.getElementById('dp-j4')?.value || null;

    if (!j1 || !j2 || !j3 || !j4) {
        toast('Seleccioná los 4 jugadores', 'error'); return;
    }
    if (j1 === j2) { toast('Los jugadores del equipo A no pueden ser iguales', 'error'); return; }
    if (j3 === j4) { toast('Los jugadores del equipo B no pueden ser iguales', 'error'); return; }

    const j1Data = allJugadores.find(j => j.id === j1);
    const j2Data = allJugadores.find(j => j.id === j2);
    const j3Data = allJugadores.find(j => j.id === j3);
    const j4Data = allJugadores.find(j => j.id === j4);

    if (j1Data && j1Data.equipo_id !== semi.equipo_a_id) { toast('Jugador 1 no pertenece al equipo A', 'error'); return; }
    if (j2Data && j2Data.equipo_id !== semi.equipo_a_id) { toast('Jugador 2 no pertenece al equipo A', 'error'); return; }
    if (j3Data && j3Data.equipo_id !== semi.equipo_b_id) { toast('Jugador 3 no pertenece al equipo B', 'error'); return; }
    if (j4Data && j4Data.equipo_id !== semi.equipo_b_id) { toast('Jugador 4 no pertenece al equipo B', 'error'); return; }

    const data = {
        jugador_a_1_id: j1, jugador_a_2_id: j2,
        jugador_b_1_id: j3, jugador_b_2_id: j4,
        jugador_a_1_nombre: getJugadorNombre(j1),
        jugador_a_2_nombre: getJugadorNombre(j2),
        jugador_b_1_nombre: getJugadorNombre(j3),
        jugador_b_2_nombre: getJugadorNombre(j4)
    };

    showLoading('Guardando...');
    try {
        if (isNew) {
            data.categoria = categoria;
            data.equipo_a_id = semi.equipo_a_id;
            data.equipo_b_id = semi.equipo_b_id;
            data.set1_a = null; data.set1_b = null;
            data.set2_a = null; data.set2_b = null;
            data.tiebreak1_a = null; data.tiebreak1_b = null;
            data.tiebreak2_a = null; data.tiebreak2_b = null;
            data.supertiebreak_a = null; data.supertiebreak_b = null;
            data.games_a = 0; data.games_b = 0;
            data.ganador_equipo_id = null;
            data.estado = 'pendiente';
            await addDoc(semiPartidoCol(semiId), data);
            toast('Partido creado — ' + formatCategoria(categoria), 'success');
        } else {
            await updateDoc(semiPartidoDocRef(semiId, editingId), data);
            toast('Jugadores guardados', 'success');
        }
        editingSemiPartidoId = null;
        await loadSemiPartidos(semiId);
        renderSemifinalDetail();
    } catch (e) {
        toast('Error al guardar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function deleteSemiPartido(partidoId) {
    const semiId = selectedSemifinalId;
    if (!semiId || !partidoId) return;

    const semi = allSemifinales.find(s => s.id === semiId);
    if (!semi) return;

    const partido = semiPartidos.find(p => p.id === partidoId);
    if (!partido) return;

    if (!confirm('¿Eliminar el partido "' + formatCategoria(partido.categoria) + '"?')) return;

    showLoading('Eliminando partido...');
    try {
        await deleteDoc(semiPartidoDocRef(semiId, partidoId));
        toast('Partido eliminado', 'success');
        editingSemiPartidoId = null;
        await loadSemiPartidos(semiId);
        renderSemifinalDetail();
    } catch (e) {
        toast('Error al eliminar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function saveSemiResultado() {
    const semiId = selectedSemifinalId;
    const partidoId = editingSemiPartidoId;
    if (!semiId || !partidoId) return;

    const s1A = document.getElementById('res-s1-a')?.value ?? '';
    const s1B = document.getElementById('res-s1-b')?.value ?? '';
    const s2A = document.getElementById('res-s2-a')?.value ?? '';
    const s2B = document.getElementById('res-s2-b')?.value ?? '';
    const tb1A = document.getElementById('res-tb1-a')?.value ?? '';
    const tb1B = document.getElementById('res-tb1-b')?.value ?? '';
    const tb2A = document.getElementById('res-tb2-a')?.value ?? '';
    const tb2B = document.getElementById('res-tb2-b')?.value ?? '';
    const stbA = document.getElementById('res-stb-a')?.value ?? '';
    const stbB = document.getElementById('res-stb-b')?.value ?? '';

    if (!validateMatchScore(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB)) return;

    const s1l = parseInt(s1A), s1v = parseInt(s1B);
    const s2l = parseInt(s2A), s2v = parseInt(s2B);
    const tb1l = tb1A !== '' ? parseInt(tb1A) : null;
    const tb1v = tb1B !== '' ? parseInt(tb1B) : null;
    const tb2l = tb2A !== '' ? parseInt(tb2A) : null;
    const tb2v = tb2B !== '' ? parseInt(tb2B) : null;
    const stbl = stbA !== '' ? parseInt(stbA) : null;
    const stbv = stbB !== '' ? parseInt(stbB) : null;

    const ganador = determineMatchWinner(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);
    const games = calculateGames(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);

    const semi = allSemifinales.find(s => s.id === semiId);
    const partido = semiPartidos.find(p => p.id === partidoId);
    if (!partido) return;

    const ganadorEquipoId = ganador === 'a' ? semi.equipo_a_id :
                            ganador === 'b' ? semi.equipo_b_id : null;

    showLoading('Guardando resultado...');
    try {
        await updateDoc(semiPartidoDocRef(semiId, partidoId), {
            set1_a: s1l, set1_b: s1v,
            set2_a: s2l, set2_b: s2v,
            tiebreak1_a: tb1l, tiebreak1_b: tb1v,
            tiebreak2_a: tb2l, tiebreak2_b: tb2v,
            supertiebreak_a: stbl, supertiebreak_b: stbv,
            ganador_equipo_id: ganadorEquipoId,
            estado: 'finalizado',
            games_a: games.games_a,
            games_b: games.games_b,
            fecha_resultado: new Date()
        });
        toast('Resultado guardado', 'success');
        editingSemiPartidoId = null;
        await loadSemiPartidos(semiId);
        await checkSemiWinner(semiId);
        renderSemifinalDetail();
    } catch (e) {
        toast('Error al guardar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function clearSemiResultado() {
    const semiId = selectedSemifinalId;
    const partidoId = editingSemiPartidoId;
    if (!semiId || !partidoId) return;

    const partido = semiPartidos.find(p => p.id === partidoId);
    if (!partido || partido.estado !== 'finalizado') return;
    if (!confirm('¿Limpiar este resultado?')) return;

    showLoading('Limpiando resultado...');
    try {
        const semi = allSemifinales.find(s => s.id === semiId);
        await updateDoc(semiPartidoDocRef(semiId, partidoId), {
            set1_a: null, set1_b: null,
            set2_a: null, set2_b: null,
            tiebreak1_a: null, tiebreak1_b: null,
            tiebreak2_a: null, tiebreak2_b: null,
            supertiebreak_a: null, supertiebreak_b: null,
            ganador_equipo_id: null,
            estado: 'pendiente',
            games_a: 0, games_b: 0,
            fecha_resultado: null
        });
        if (semi && semi.ganador_equipo_id) {
            await updateDoc(semiDocRef(semiId), { ganador_equipo_id: null, estado: 'pendiente' });
        }
        toast('Resultado limpiado', 'success');
        editingSemiPartidoId = null;
        await loadSemiPartidos(semiId);
        renderSemifinalDetail();
    } catch (e) {
        toast('Error al limpiar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function checkSemiWinner(semiId) {
    const semi = allSemifinales.find(s => s.id === semiId);
    if (!semi) return;
    const allDone = semiPartidos.length === (semi.partidos_esperados || 7) && semiPartidos.every(p => p.estado === 'finalizado');
    if (!allDone) return;

    let aWins = 0, bWins = 0;
    semiPartidos.forEach(p => {
        if (p.ganador_equipo_id === semi.equipo_a_id) aWins++;
        else if (p.ganador_equipo_id === semi.equipo_b_id) bWins++;
    });

    const ganador = aWins > bWins ? semi.equipo_a_id : (bWins > aWins ? semi.equipo_b_id : null);
    if (ganador) {
        await updateDoc(semiDocRef(semiId), { ganador_equipo_id: ganador, estado: 'finalizado' });
        semi.ganador_equipo_id = ganador;
        semi.estado = 'finalizado';
    }
}

function cerrarSemifinal(semiId) {
    const semi = allSemifinales.find(s => s.id === semiId);
    if (!semi) return;

    const finalizados = semiPartidos.filter(p => p.estado === 'finalizado');
    if (finalizados.length === 0) {
        toast('No hay partidos finalizados para cerrar', 'error');
        return;
    }

    let aWins = 0, bWins = 0;
    finalizados.forEach(p => {
        if (p.ganador_equipo_id === semi.equipo_a_id) aWins++;
        else if (p.ganador_equipo_id === semi.equipo_b_id) bWins++;
    });

    if (aWins === bWins) {
        toast('Hay empate (' + aWins + ' - ' + bWins + '). Jugá un desempate o borra un resultado', 'error');
        return;
    }

    const ganadorId = aWins > bWins ? semi.equipo_a_id : semi.equipo_b_id;
    const ganadorName = aWins > bWins ? semi.equipo_a_nombre : semi.equipo_b_nombre;
    const ganadorColor = aWins > bWins ? (semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888') : (semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888');
    const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
    const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal">' +
        '<h3 style="font-size:0.95rem;margin-bottom:0.8rem;">Cerrar Semifinal ' + (semi.numero || '') + '</h3>' +
        '<div style="margin-bottom:0.8rem;">' +
        '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0;font-size:0.82rem;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + aColor + ';flex-shrink:0;"></span>' +
        '<span style="flex:1;font-weight:600;">' + esc(semi.equipo_a_nombre) + '</span>' +
        '<span style="font-weight:800;font-size:0.85rem;">' + aWins + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0;font-size:0.82rem;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + bColor + ';flex-shrink:0;"></span>' +
        '<span style="flex:1;font-weight:600;">' + esc(semi.equipo_b_nombre) + '</span>' +
        '<span style="font-weight:800;font-size:0.85rem;">' + bWins + '</span>' +
        '</div>' +
        '</div>' +
        '<div style="background:rgba(0,212,170,0.1);border:1px solid rgba(0,212,170,0.2);border-radius:8px;padding:0.6rem;margin-bottom:1rem;text-align:center;">' +
        '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">Ganador</div>' +
        '<div style="display:flex;align-items:center;justify-content:center;gap:0.4rem;">' +
        '<span style="width:12px;height:12px;border-radius:50%;background:' + ganadorColor + ';"></span>' +
        '<span style="font-family:Lexend;font-weight:700;font-size:0.9rem;color:var(--secondary);">' + esc(ganadorName) + '</span>' +
        '</div>' +
        '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-top:0.2rem;">avanza a la Final</div>' +
        '</div>' +
        '<div class="btn-group" style="justify-content:flex-end;">' +
        '<button class="btn btn-outline" id="btn-cancel-close-semi">Cancelar</button>' +
        '<button class="btn btn-primary" id="btn-confirm-close-semi"><span class="material-symbols-outlined" style="font-size:0.9rem;">check</span> Cerrar y Definir</button>' +
        '</div></div>';

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('btn-cancel-close-semi').addEventListener('click', () => overlay.remove());
    document.getElementById('btn-confirm-close-semi').addEventListener('click', async () => {
        overlay.remove();
        showLoading('Cerrando semifinal...');
        try {
            await updateDoc(semiDocRef(semiId), { ganador_equipo_id: ganadorId, estado: 'finalizado' });
            semi.ganador_equipo_id = ganadorId;
            semi.estado = 'finalizado';
            toast('Semifinal cerrada — Ganador: ' + ganadorName, 'success');
            await loadSemiPartidos(semiId);
            renderSemifinalDetail();
        } catch (e) {
            toast('Error al cerrar semifinal', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    });
}

async function renderCategorias() {
    const panel = document.getElementById('panel-categorias');
    if (!panel) return;
    panelLoading(panel);

    await ensureCategorias();
    const cats = getDrawCategoriasTodas();
    const tieneCats = cats.length > 0;

    let html = '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sell</span> Categorías del Torneo</div>';

    if (!tieneCats) {
        html += '<div class="card" style="border-left:4px solid var(--secondary);">' +
            '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.5rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.9rem;color:var(--secondary);">info</span>' +
            '<span style="font-family:Lexend;font-weight:600;font-size:0.85rem;">No hay categorías configuradas</span>' +
            '</div>' +
            '<p style="font-size:0.8rem;color:var(--on-surface-variant-40);margin-bottom:0.75rem;">Inicializa con las 7 categorías predeterminadas o crea categorías personalizadas.</p>' +
            '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
            '<button class="btn btn-primary" id="btn-seed-categorias"><span class="material-symbols-outlined" style="font-size:0.8rem;">add_circle</span> Inicializar con las categorías actuales</button>' +
            '<button class="btn btn-outline" id="btn-add-cat-empty"><span class="material-symbols-outlined" style="font-size:0.8rem;">add</span> Crear categoría</button>' +
            '</div>' +
            '</div>';
    } else {
        html += '<div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;">' +
            '<button class="btn btn-primary" id="btn-add-cat"><span class="material-symbols-outlined" style="font-size:0.8rem;">add</span> Nueva categoría</button>' +
            '</div>';

        html += '<div style="display:flex;flex-direction:column;gap:0.5rem;">';
        cats.forEach(cat => {
            const isActive = cat.activa !== false;
            const badgeStyle = isActive
                ? 'background:var(--secondary-container);color:var(--secondary);'
                : 'background:var(--white-8);color:var(--on-surface-variant-40);';
            const badgeText = isActive ? 'ACTIVA' : 'INACTIVA';
            const cardBorder = isActive ? 'border-left:4px solid var(--primary);' : 'border-left:4px solid var(--on-surface-variant-40);opacity:0.7;';

            html += '<div class="card" style="margin:0;padding:0.75rem;' + cardBorder + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div style="display:flex;align-items:center;gap:0.6rem;">' +
                '<span class="material-symbols-outlined" style="font-size:1rem;color:var(--primary);">sell</span>' +
                '<div>' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">' + esc(cat.nombre) + '</div>' +
                '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">' + (cat.creadaEn ? new Date(cat.creadaEn).toLocaleDateString('es-AR') : '') + '</div>' +
                '</div>' +
                '<span class="badge" style="font-size:0.6rem;' + badgeStyle + '">' + badgeText + '</span>' +
                '</div>' +
                '<div style="display:flex;gap:0.3rem;">' +
                '<button class="btn btn-sm btn-outline" data-edit-cat="' + cat.id + '" title="Editar"><span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span></button>' +
                '<button class="btn btn-sm btn-outline" data-toggle-cat="' + cat.id + '" title="' + (isActive ? 'Desactivar' : 'Activar') + '"><span class="material-symbols-outlined" style="font-size:0.8rem;">' + (isActive ? 'visibility_off' : 'visibility') + '</span></button>' +
                '</div>' +
                '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    panel.innerHTML = html;

    // Event listeners
    panel.querySelectorAll('#btn-seed-categorias').forEach(btn => btn.addEventListener('click', async () => {
        showLoading();
        try {
            await seedCategoriasDefault();
            await ensureCategorias();
            toast('Categorías inicializadas');
            renderCategorias();
        } catch (e) {
            toast('Error al inicializar', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    }));

    panel.querySelectorAll('#btn-add-cat, #btn-add-cat-empty').forEach(btn => btn.addEventListener('click', () => {
        renderCategoriaForm(null);
    }));

    panel.querySelectorAll('[data-edit-cat]').forEach(btn => btn.addEventListener('click', () => {
        const catId = btn.dataset.editCat;
        const cat = cats.find(c => c.id === catId);
        if (cat) renderCategoriaForm(cat);
    }));

    panel.querySelectorAll('[data-toggle-cat]').forEach(btn => btn.addEventListener('click', async () => {
        const catId = btn.dataset.toggleCat;
        const cat = cats.find(c => c.id === catId);
        if (!cat) return;
        showLoading();
        try {
            await setCategoriaActiva(catId, cat.activa === false);
            await ensureCategorias();
            toast(cat.activa === false ? 'Categoría activada' : 'Categoría desactivada');
            renderCategorias();
        } catch (e) {
            toast('Error al cambiar estado', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    }));
}

function renderCategoriaForm(existingCat) {
    const panel = document.getElementById('panel-categorias');
    if (!panel) return;

    const isEdit = !!existingCat;
    const title = isEdit ? 'Editar Categoría' : 'Nueva Categoría';
    const nombre = existingCat ? existingCat.nombre : '';

    let html = '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sell</span> ' + title + '</div>';
    html += '<div class="card">';
    html += '<div class="form-group"><label>Nombre de la categoría</label>';
    html += '<input type="text" id="cat-nombre" class="form-input" value="' + esc(nombre) + '" placeholder="Ej: Masculino Suma 9" style="width:100%;max-width:320px;"></div>';
    html += '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;">';
    html += '<button class="btn btn-primary" id="btn-cat-save">' + (isEdit ? 'Guardar cambios' : 'Crear categoría') + '</button>';
    html += '<button class="btn btn-outline" id="btn-cat-cancel">Cancelar</button>';
    if (isEdit) {
        html += '<button class="btn btn-danger" id="btn-cat-delete" style="margin-left:auto;"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span> Eliminar</button>';
    }
    html += '</div></div>';

    panel.innerHTML = html;

    document.getElementById('btn-cat-cancel').addEventListener('click', () => renderCategorias());
    document.getElementById('btn-cat-save').addEventListener('click', async () => {
        const newName = document.getElementById('cat-nombre').value.trim();
        if (!newName) { toast('Ingresá un nombre', 'error'); return; }

        const allCats = getDrawCategoriasTodas();
        if (!isEdit && allCats.some(c => normalizeCatName(c.nombre) === normalizeCatName(newName))) {
            toast('Ya existe una categoría con ese nombre', 'error');
            return;
        }
        if (isEdit && normalizeCatName(newName) !== normalizeCatName(existingCat.nombre) && allCats.some(c => normalizeCatName(c.nombre) === normalizeCatName(newName))) {
            toast('Ya existe otra categoría con ese nombre', 'error');
            return;
        }

        showLoading();
        try {
            if (isEdit) {
                await editarCategoria(existingCat.id, { nombre: newName });
            } else {
                await crearCategoria({ nombre: newName });
            }
            await ensureCategorias();
            toast(isEdit ? 'Categoría actualizada' : 'Categoría creada');
            renderCategorias();
        } catch (e) {
            toast('Error al guardar', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    });

    if (isEdit) {
        document.getElementById('btn-cat-delete').addEventListener('click', async () => {
            if (!confirm('¿Eliminar esta categoría? Los partidos existentes no se borran pero no se mostrarán en el panel.')) return;
            showLoading();
            try {
                await setCategoriaActiva(existingCat.id, false);
                await ensureCategorias();
                toast('Categoría desactivada');
                renderCategorias();
            } catch (e) {
                toast('Error al eliminar', 'error');
                console.error(e);
            } finally {
                hideLoading();
            }
        });
    }

    document.getElementById('cat-nombre').focus();
}

function renderSemifinales() {
    const panel = document.getElementById('panel-semifinales');
    if (selectedSemifinalId) {
        renderSemifinalDetail();
        return;
    }

    panelLoading(panel, 'Cargando semifinales...');
    loadAllEnfrentamientosAndPartidos().then(() => loadSemifinales()).then(() => {
        const result = calculateStandings(allEquipos, allEnfrentamientosData);
        const allComplete = result.roundStatus === 'finalizado';
        const hasSemis = allSemifinales.length > 0;

        let html = '';

        // Status
        html += '<div class="card" style="border-left:4px solid ' + (allComplete ? 'var(--secondary)' : 'var(--primary)') + ';margin-bottom:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.5rem;">' +
            '<span class="material-symbols-outlined" style="font-size:1rem;color:' + (allComplete ? 'var(--secondary)' : 'var(--primary)') + ';">' + (allComplete ? 'check_circle' : 'hourglass_empty') + '</span>' +
            '<div>' +
            '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">SEMIFINALES</div>' +
            '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);">' +
            (allComplete ? 'Round Robin finalizado — Clasificación definida' : 'Round Robin en curso — Clasificación parcial') +
            '</div></div></div></div>';

        if (!hasSemis) {
            html += '<div class="empty-state" style="padding:2rem;">' +
                '<span class="material-symbols-outlined">emoji_events</span>' +
                '<p>No hay semifinales generadas.</p>' +
                '<button class="btn btn-primary" id="btn-gen-semis"><span class="material-symbols-outlined" style="font-size:1rem;">add</span> Generar Semifinales</button>' +
                '</div>';
            panel.innerHTML = html;
            document.getElementById('btn-gen-semis')?.addEventListener('click', () => safeAction(generateSemifinales));
            return;
        }

        // Acciones globales de Semifinales
        html += '<div style="margin-bottom:0.75rem;">' +
            '<button class="btn btn-primary" id="btn-gen-final-semis" style="width:100%;"><span class="material-symbols-outlined" style="font-size:1rem;">workspace_premium</span> Generar Final con estado actual</button>' +
            '</div>';

        // Show semifinal cards
        allSemifinales.forEach(semi => {
            const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
            const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
            const allDone = semi.partidos.length === (semi.partidos_esperados || 7) && semi.partidos.every(p => p.estado === 'finalizado');
            let aWins = 0, bWins = 0;
            semi.partidos.forEach(p => {
                if (p.ganador_equipo_id === semi.equipo_a_id) aWins++;
                else if (p.ganador_equipo_id === semi.equipo_b_id) bWins++;
            });
            const ganadorName = semi.ganador_equipo_id === semi.equipo_a_id ? semi.equipo_a_nombre :
                                semi.ganador_equipo_id === semi.equipo_b_id ? semi.equipo_b_nombre : null;

            html += '<div class="card" style="cursor:pointer;border-left:4px solid ' + (ganadorName ? (semi.ganador_equipo_id === semi.equipo_a_id ? aColor : bColor) : 'var(--primary)') + ';" data-semi-id="' + semi.id + '">' +
                '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.3rem;">SEMIFINAL ' + (semi.numero || '?') + '</div>' +
                '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + aColor + ';"></span>' +
                esc(semi.equipo_a_nombre || '?') +
                (semi.equipo_a_posicion ? ' <span style="font-size:0.65rem;color:var(--on-surface-variant-40);font-weight:400;">(' + semi.equipo_a_posicion + 'º)</span>' : '') +
                '</span>' +
                '<span style="font-family:Lexend;font-weight:800;font-size:0.75rem;color:var(--on-surface-variant-40);">VS</span>' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + bColor + ';"></span>' +
                esc(semi.equipo_b_nombre || '?') +
                (semi.equipo_b_posicion ? ' <span style="font-size:0.65rem;color:var(--on-surface-variant-40);font-weight:400;">(' + semi.equipo_b_posicion + 'º)</span>' : '') +
                '</span>' +
                '</div>' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.4rem;">' +
                '<span style="font-size:0.75rem;">' + aWins + ' - ' + bWins + '</span>' +
                (ganadorName
                    ? '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">emoji_events</span> ' + esc(ganadorName) + '</span>'
                    : '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + semi.partidos.filter(p => p.estado === 'finalizado').length + '/' + (semi.partidos_esperados || 7) + ' finalizados</span>') +
                '</div>' +
                '</div>';
        });

        panel.innerHTML = html;
        document.getElementById('btn-gen-final-semis')?.addEventListener('click', () => safeAction(generateFinal));
        panel.querySelectorAll('[data-semi-id]').forEach(b => b.addEventListener('click', async () => {
            selectedSemifinalId = b.dataset.semiId;
            editingSemiPartidoId = null;
            await loadSemiPartidos(b.dataset.semiId);
            renderSemifinalDetail();
        }));
    });
}

async function renderSemifinalDetail() {
    await ensureCategorias();
    const panel = document.getElementById('panel-semifinales');
    const semi = allSemifinales.find(s => s.id === selectedSemifinalId);
    if (!semi) { selectedSemifinalId = null; renderSemifinales(); return; }

    const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
    const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
    const allDone = semi.partidos.length === (semi.partidos_esperados || 7) && semi.partidos.every(p => p.estado === 'finalizado');
    let aWins = 0, bWins = 0;
    semi.partidos.forEach(p => {
        if (p.ganador_equipo_id === semi.equipo_a_id) aWins++;
        else if (p.ganador_equipo_id === semi.equipo_b_id) bWins++;
    });

    let html = '';

    // Header
    html += '<div class="card" style="border-top:3px solid var(--primary);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">' +
        '<div>' +
        '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-bottom:0.15rem;">SEMIFINAL ' + (semi.numero || '?') + '</div>' +
        '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.95rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + aColor + ';"></span>' +
        esc(semi.equipo_a_nombre || '?') + (semi.equipo_a_posicion ? ' (' + semi.equipo_a_posicion + 'º)' : '') +
        '</span>' +
        '<span style="font-family:Lexend;font-weight:800;font-size:0.85rem;color:var(--on-surface-variant-40);">VS</span>' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.95rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + bColor + ';"></span>' +
        esc(semi.equipo_b_nombre || '?') + (semi.equipo_b_posicion ? ' (' + semi.equipo_b_posicion + 'º)' : '') +
        '</span>' +
        '</div></div>' +
        '<button class="btn btn-sm btn-outline" id="btn-back-semis"><span class="material-symbols-outlined" style="font-size:0.8rem;">arrow_back</span></button>' +
        '</div></div>';

    // Summary
    const ganadorName = semi.ganador_equipo_id === semi.equipo_a_id ? semi.equipo_a_nombre :
                        semi.ganador_equipo_id === semi.equipo_b_id ? semi.equipo_b_nombre : null;

    html += '<div class="card" style="border-left:4px solid ' + (allDone ? 'var(--secondary)' : 'var(--primary)') + ';">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">Resumen</div>' +
        (allDone
            ? '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">check_circle</span> Completo</span>'
            : '<span class="badge" style="background:var(--primary-container);color:var(--primary);">' + semi.partidos.filter(p => p.estado === 'finalizado').length + '/' + (semi.partidos_esperados || 7) + '</span>') +
        '</div>' +
        '<div style="display:flex;gap:1rem;">' +
        '<div style="flex:1;"><div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(semi.equipo_a_nombre) + '</div>' +
        '<div style="font-size:0.82rem;">Partidos: <strong>' + aWins + '</strong></div></div>' +
        '<div style="flex:1;"><div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(semi.equipo_b_nombre) + '</div>' +
        '<div style="font-size:0.82rem;">Partidos: <strong>' + bWins + '</strong></div></div>' +
        '</div>';

    if (ganadorName) {
        html += '<div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--white-5);">' +
            '<div style="font-size:0.78rem;color:var(--secondary);font-weight:600;">🏆 Ganador: ' + esc(ganadorName) + '</div></div>';
    }

    html += '</div>';

    if (semi.estado !== 'finalizado' && aWins + bWins > 0) {
        html += '<div style="margin:0.75rem 0;display:flex;gap:0.5rem;flex-wrap:wrap;">' +
            '<button class="btn btn-primary" id="btn-close-semi" style="flex:1;"><span class="material-symbols-outlined" style="font-size:1rem;">lock</span> Cerrar Semifinal</button>' +
            '<button class="btn btn-outline" id="btn-gen-final-detail" style="flex:1;"><span class="material-symbols-outlined" style="font-size:1rem;">workspace_premium</span> Generar Final</button>' +
            '</div>';
    } else {
        html += '<div style="margin:0.75rem 0;">' +
            '<button class="btn btn-outline" id="btn-gen-final-detail" style="width:100%;"><span class="material-symbols-outlined" style="font-size:1rem;">workspace_premium</span> Generar Final con estado actual</button>' +
            '</div>';
    }

    // Edit form (if editing)
    if (editingSemiPartidoId) {
        if (editingSemiPartidoId.startsWith('__new__')) {
            html += renderSemiPartidoForm(semi);
        } else {
            const part = semiPartidos.find(p => p.id === editingSemiPartidoId);
            if (part) {
                if (editingSemiFormMode === 'score') {
                    const hasPlayers = part.jugador_a_1_id && part.jugador_b_1_id;
                    if (hasPlayers) {
                        part._resContainerType = 'semifinal';
                        part._resContainerId = selectedSemifinalId;
                        part._resJornadaId = selectedSemifinalId;
                        part._jornadaNumero = 'Semifinal';
                        part._teamAColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#4da6ff';
                        part._teamBColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#feb300';
                        if (!resPartidos.find(p => p.id === part.id)) resPartidos.push(part);
                        if (!resultScores[part.id]) {
                            resultScores[part.id] = { set1_a: 0, set1_b: 0, set2_a: 0, set2_b: 0, tb1_a: null, tb1_b: null, tb2_a: null, tb2_b: null, stb_a: null, stb_b: null, _closed: {} };
                        }
                        resEditing[part.id] = true;
                        html += '<div id="res-card-panel-semi">';
                        html += resCardHtml(part);
                        html += '</div>';
                    } else {
                        html += '<div class="card" style="border:2px solid var(--error);margin-bottom:0.5rem;padding:0.75rem;font-size:0.8rem;color:var(--error);">⚠️ Primero asigná los jugadores para poder cargar el resultado.</div>';
                        html += renderSemiPartidoForm(semi, part);
                    }
                } else {
                    html += renderSemiPartidoForm(semi, part);
                }
            }
        }
    }

    // Partidos list
    const allCats = getDrawCategoriasTodas();
    const expectedSemi = semi.partidos_esperados || 7;
    html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_tennis</span> Partidos (' + semi.partidos.length + '/' + expectedSemi + ')</div>';

    allCats.forEach((cat, idx) => {
        const partido = semi.partidos.find(p => p.categoria === cat.nombre);
        const num = String(idx + 1).padStart(2, '0');
        const isInactive = cat.activa === false;

        if (partido) {
            const isFinalizado = partido.estado === 'finalizado';
            const j1Name = getJugadorNombre(partido.jugador_a_1_id) || partido.jugador_a_1_nombre || '';
            const j2Name = getJugadorNombre(partido.jugador_a_2_id) || partido.jugador_a_2_nombre || '';
            const j3Name = getJugadorNombre(partido.jugador_b_1_id) || partido.jugador_b_1_nombre || '';
            const j4Name = getJugadorNombre(partido.jugador_b_2_id) || partido.jugador_b_2_nombre || '';
            const isEmpty = !partido.jugador_a_1_id && !partido.jugador_a_2_id && !partido.jugador_b_1_id && !partido.jugador_b_2_id;

            const borderColor = isFinalizado ? (partido.ganador_equipo_id === semi.equipo_a_id ? aColor : bColor) : 'var(--on-surface-variant-40)';

            html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid ' + borderColor + ';' + (isInactive ? 'opacity:0.7;' : '') + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--primary);">' + num + ' ' + esc(formatCategoria(cat.nombre)) + (isInactive ? ' <span class="badge" style="background:var(--secondary-container);color:var(--secondary);font-size:0.55rem;">INACTIVA</span>' : '') + '</span>' +
                (isFinalizado ? '<span class="badge badge-success" style="font-size:0.6rem;">✓ FINALIZADO</span>' : '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);font-size:0.6rem;">PENDIENTE</span>') +
                '</div>';

            if (isEmpty) {
                html += '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">Sin jugadores asignados</div>';
            } else {
                html += '<div style="display:flex;flex-direction:column;gap:0.2rem;font-size:0.75rem;">' +
                    '<div style="display:flex;align-items:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span>' +
                    '<span>' + esc(j1Name || '—') + ' / ' + esc(j2Name || '—') + '</span></div>' +
                    '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);text-align:center;font-family:Lexend;font-weight:800;">VS</div>' +
                    '<div style="display:flex;align-items:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span>' +
                    '<span>' + esc(j3Name || '—') + ' / ' + esc(j4Name || '—') + '</span></div>' +
                    '</div>';
            }

            if (isFinalizado) {
                const s1 = partido.set1_a + '-' + partido.set1_b;
                const s2 = partido.set2_a + '-' + partido.set2_b;
                const tb1 = (partido.tiebreak1_a != null && partido.tiebreak1_b != null) ? ' · TB1 ' + partido.tiebreak1_a + '-' + partido.tiebreak1_b : '';
                const tb2 = (partido.tiebreak2_a != null && partido.tiebreak2_b != null) ? ' · TB2 ' + partido.tiebreak2_a + '-' + partido.tiebreak2_b : '';
                const hasSTB = partido.supertiebreak_a != null && partido.supertiebreak_b != null;
                const stb = hasSTB ? ' · STB ' + partido.supertiebreak_a + '-' + partido.supertiebreak_b : '';
                const ganadorName = partido.ganador_equipo_id === semi.equipo_a_id ? semi.equipo_a_nombre : semi.equipo_b_nombre;
                html += '<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--on-surface-variant-40);">' +
                    '<span style="font-weight:600;">' + s1 + '</span> · <span style="font-weight:600;">' + s2 + '</span>' + esc(tb1) + esc(tb2) + esc(stb) +
                    ' · <span style="color:var(--secondary);">🏆 ' + esc(ganadorName) + '</span></div>';
            }

            html += '</div>' +
                '<div style="display:flex;gap:0.3rem;">' +
                '<button class="btn btn-sm btn-outline" data-semi-edit-players="' + partido.id + '" title="Editar jugadores"><span class="material-symbols-outlined" style="font-size:0.8rem;">people</span></button>' +
                '<button class="btn btn-sm btn-outline" data-semi-edit="' + partido.id + '" title="Editar score"><span class="material-symbols-outlined" style="font-size:0.8rem;">sports_score</span></button>' +
                '<button class="btn btn-sm btn-danger" data-del-semi-partido="' + partido.id + '" title="Eliminar"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' +
                '</div></div></div>';
        } else if (!isInactive) {
            html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid var(--on-surface-variant-40);">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div>' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--on-surface-variant-40);">' + num + ' ' + esc(formatCategoria(cat.nombre)) + '</div>' +
                '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">No configurado</div>' +
                '</div>' +
                '<button class="btn btn-sm btn-primary" data-add-semi-partido="' + esc(cat.nombre) + '" title="Crear partido"><span class="material-symbols-outlined" style="font-size:0.8rem;">add</span></button>' +
                '</div></div>';
        }
    });

    panel.innerHTML = html;

    // Event listeners
    document.getElementById('btn-back-semis')?.addEventListener('click', () => {
        selectedSemifinalId = null;
        editingSemiPartidoId = null;
        editingSemiFormMode = null;
        semiPartidos = [];
        renderSemifinales();
    });

    document.getElementById('btn-close-semi')?.addEventListener('click', () => safeAction(() => cerrarSemifinal(selectedSemifinalId)));
    document.getElementById('btn-gen-final-detail')?.addEventListener('click', () => safeAction(generateFinal));

    panel.querySelectorAll('[data-add-semi-partido]').forEach(b => b.addEventListener('click', () => {
        editingSemiPartidoId = '__new__' + b.dataset.addSemiPartido;
        renderSemifinalDetail();
    }));

    panel.querySelectorAll('[data-edit-semi-partido]').forEach(b => b.addEventListener('click', () => {
        editingSemiPartidoId = b.dataset.editSemiPartido;
        renderSemifinalDetail();
    }));

    panel.querySelectorAll('[data-semi-edit]').forEach(b => b.addEventListener('click', () => {
        editingSemiPartidoId = b.dataset.semiEdit;
        editingSemiFormMode = 'score';
        renderSemifinalDetail();
    }));

    panel.querySelectorAll('[data-semi-edit-players]').forEach(b => b.addEventListener('click', () => {
        editingSemiPartidoId = b.dataset.semiEditPlayers;
        editingSemiFormMode = 'players';
        renderSemifinalDetail();
    }));

    panel.querySelectorAll('[data-del-semi-partido]').forEach(b => b.addEventListener('click', () => safeAction(() => deleteSemiPartido(b.dataset.delSemiPartido))));

    document.getElementById('btn-save-semi-partido')?.addEventListener('click', () => safeAction(saveSemiPartido));
    document.getElementById('btn-cancel-semi-partido')?.addEventListener('click', () => { editingSemiPartidoId = null; editingSemiFormMode = null; renderSemifinalDetail(); });

    // Bind res card events for score editing
    const resCardPanel = document.getElementById('res-card-panel-semi');
    if (resCardPanel) {
        const card = resCardPanel.querySelector('[data-res-card]');
        if (card) {
            bindResCardEvents(card, resCardPanel, () => { editingSemiFormMode = null; renderSemifinalDetail(); });
        }
    }

    // Player select cross-referencing
    const j1Sel = document.getElementById('dp-j1');
    const j2Sel = document.getElementById('dp-j2');
    const j3Sel = document.getElementById('dp-j3');
    const j4Sel = document.getElementById('dp-j4');

    if (j1Sel && j2Sel) {
        const updatePair = () => {
            const v1 = j1Sel.value;
            const players = getPlayersInTeam(semi.equipo_a_id);
            j2Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                players.filter(p => p.id !== v1).map(p => '<option value="' + p.id + '"' + (p.id === j2Sel.value ? ' selected' : '') + '>' + shortName(p) + '</option>').join('');
        };
        j1Sel.addEventListener('change', updatePair);
    }
    if (j3Sel && j4Sel) {
        const updatePair = () => {
            const v3 = j3Sel.value;
            const players = getPlayersInTeam(semi.equipo_b_id);
            j4Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                players.filter(p => p.id !== v3).map(p => '<option value="' + p.id + '"' + (p.id === j4Sel.value ? ' selected' : '') + '>' + shortName(p) + '</option>').join('');
        };
        j3Sel.addEventListener('change', updatePair);
    }
}

function renderSemiPartidoForm(semi, existingPart) {
    const isNew = editingSemiPartidoId && editingSemiPartidoId.startsWith('__new__');
    const categoria = isNew ? editingSemiPartidoId.replace('__new__', '') : (existingPart?.categoria || '');

    const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
    const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
    const aPlayers = getPlayersInTeam(semi.equipo_a_id);
    const bPlayers = getPlayersInTeam(semi.equipo_b_id);
    const makeOpts = (players, sel, excl) => '<option value="">— Seleccionar —</option>' + players.filter(p => p.id !== excl).map(p => '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + shortName(p) + '</option>').join('');

    const j1 = existingPart?.jugador_a_1_id || '';
    const j2 = existingPart?.jugador_a_2_id || '';
    const j3 = existingPart?.jugador_b_1_id || '';
    const j4 = existingPart?.jugador_b_2_id || '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">' + (isNew ? 'add' : 'edit') + '</span> ' + (isNew ? 'Crear' : 'Editar') + ' — ' + esc(formatCategoria(categoria)) +
        '</div>';

    if (aPlayers.length < 2) {
        html += '<div style="font-size:0.78rem;color:var(--error);margin-bottom:0.5rem;">⚠️ Equipo A necesita al menos 2 jugadores (' + aPlayers.length + '/2)</div>';
    }
    if (bPlayers.length < 2) {
        html += '<div style="font-size:0.78rem;color:var(--error);margin-bottom:0.5rem;">⚠️ Equipo B necesita al menos 2 jugadores (' + bPlayers.length + '/2)</div>';
    }

    html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(semi.equipo_a_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 1</label><select id="dp-j1">' + makeOpts(aPlayers, j1, j2) + '</select></div>' +
        '<div class="form-group"><label>Jugador 2</label><select id="dp-j2">' + makeOpts(aPlayers, j2, j1) + '</select></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;padding-bottom:1.5rem;font-family:Lexend;font-weight:800;font-size:0.8rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(semi.equipo_b_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 3</label><select id="dp-j3">' + makeOpts(bPlayers, j3, j4) + '</select></div>' +
        '<div class="form-group"><label>Jugador 4</label><select id="dp-j4">' + makeOpts(bPlayers, j4, j3) + '</select></div>' +
        '</div></div>';

    html += '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-semi-partido"><span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar</button>' +
        '<button class="btn btn-outline" id="btn-cancel-semi-partido"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div></div>';

    return html;
}

function renderSemiResultadoForm(semi, part) {
    const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
    const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
    const s1l = part.set1_a != null ? part.set1_a : '';
    const s1v = part.set1_b != null ? part.set1_b : '';
    const s2l = part.set2_a != null ? part.set2_a : '';
    const s2v = part.set2_b != null ? part.set2_b : '';
    const tb1l = part.tiebreak1_a != null ? part.tiebreak1_a : '';
    const tb1v = part.tiebreak1_b != null ? part.tiebreak1_b : '';
    const tb2l = part.tiebreak2_a != null ? part.tiebreak2_a : '';
    const tb2v = part.tiebreak2_b != null ? part.tiebreak2_b : '';
    const stbl = part.supertiebreak_a != null ? part.supertiebreak_a : '';
    const stbv = part.supertiebreak_b != null ? part.supertiebreak_b : '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">sports_score</span> ' +
        (part.estado === 'finalizado' ? 'Editar' : 'Ingresar') + ' Resultado — ' + esc(formatCategoria(part.categoria || '')) +
        '</div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 1</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(semi.equipo_a_nombre) + '</div>' +
        '<input type="number" id="res-s1-a" min="0" max="7" value="' + s1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(semi.equipo_b_nombre) + '</div>' +
        '<input type="number" id="res-s1-b" min="0" max="7" value="' + s1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 1 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb1-a" min="0" max="15" value="' + tb1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb1-b" min="0" max="15" value="' + tb1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 2</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-s2-a" min="0" max="7" value="' + s2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-s2-b" min="0" max="7" value="' + s2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 2 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb2-a" min="0" max="15" value="' + tb2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb2-b" min="0" max="15" value="' + tb2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SUPER TIE BREAK <span style="font-weight:400;font-size:0.65rem;">(solo si sets 1-1)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.75rem;">' +
        '<div style="flex:1;"><input type="number" id="res-stb-a" min="0" max="20" value="' + stbl + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-stb-b" min="0" max="20" value="' + stbv + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-semi-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar Resultado</button>' +
        '<button class="btn btn-outline" id="btn-cancel-semi-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div></div>';

    return html;
}

// ═══════════════════════════════════════════
// FINAL
// ═══════════════════════════════════════════
let allFinales = [];
let selectedFinalId = null;
let finalPartidos = [];
let editingFinalPartidoId = null;
let editingFinalFormMode = null;

function finalCol() {
    return collection(db, 'torneos', getActiveTournamentId(), 'finales');
}

function finalDocRef(finalId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'finales', finalId);
}

function finalPartidoCol(finalId) {
    return collection(db, 'torneos', getActiveTournamentId(), 'finales', finalId, 'partidos');
}

function finalPartidoDocRef(finalId, partidoId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'finales', finalId, 'partidos', partidoId);
}

async function loadFinales() {
    allFinales = [];
    if (!getActiveTournamentId()) return;
    try {
        const snap = await getDocs(finalCol());
        if (!snap.docs.length) return;
        const results = await Promise.all(snap.docs.map(async docSnap => {
            const fin = { id: docSnap.id, ...normalizeFields(docSnap.data()), partidos: [] };
            const partSnap = await getDocs(finalPartidoCol(fin.id));
            fin.partidos = partSnap.docs.map(p => ({ id: p.id, ...normalizeFields(p.data()) }));
            return fin;
        }));
        allFinales = results;
    } catch (e) {
        console.error('Error loading finales:', e);
    }
}

async function loadFinalPartidos(finalId) {
    finalPartidos = [];
    if (!finalId) return;
    try {
        const snap = await getDocs(finalPartidoCol(finalId));
                finalPartidos = snap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
    } catch (e) {
        console.error('Error loading final partidos:', e);
    }
}

async function generateFinal() {
    showLoading('Calculando clasificados a la Final...');
    try {
        await loadSemifinales();
        if (allSemifinales.length < 2) {
            toast('Se necesitan al menos 2 semifinales para generar la final', 'error');
            return;
        }

        const sortedSemis = [...allSemifinales].sort((a, b) => (a.numero || 0) - (b.numero || 0));

        // Semifinal 1 winner calculation
        const s1 = sortedSemis[0];
        let partidos1 = s1.partidos || [];
        if (!partidos1.length) {
            try {
                const partSnap = await getDocs(semiPartidoCol(s1.id));
                partidos1 = partSnap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
            } catch (e) {}
        }
        let aWins1 = 0, bWins1 = 0;
        partidos1.forEach(p => {
            if (p.ganador_equipo_id === s1.equipo_a_id) aWins1++;
            else if (p.ganador_equipo_id === s1.equipo_b_id) bWins1++;
        });
        const winnerId1 = s1.ganador_equipo_id || (aWins1 > bWins1 ? s1.equipo_a_id : (bWins1 > aWins1 ? s1.equipo_b_id : s1.equipo_a_id));
        const winnerName1 = winnerId1 === s1.equipo_a_id ? s1.equipo_a_nombre : s1.equipo_b_nombre;
        const winnerColor1 = winnerId1 === s1.equipo_a_id ? (s1.equipo_a_color || getTeamColor(s1.equipo_a_id)) : (s1.equipo_b_color || getTeamColor(s1.equipo_b_id));

        // Semifinal 2 winner calculation
        const s2 = sortedSemis[1];
        let partidos2 = s2.partidos || [];
        if (!partidos2.length) {
            try {
                const partSnap = await getDocs(semiPartidoCol(s2.id));
                partidos2 = partSnap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
            } catch (e) {}
        }
        let aWins2 = 0, bWins2 = 0;
        partidos2.forEach(p => {
            if (p.ganador_equipo_id === s2.equipo_a_id) aWins2++;
            else if (p.ganador_equipo_id === s2.equipo_b_id) bWins2++;
        });
        const winnerId2 = s2.ganador_equipo_id || (aWins2 > bWins2 ? s2.equipo_a_id : (bWins2 > aWins2 ? s2.equipo_b_id : s2.equipo_a_id));
        const winnerName2 = winnerId2 === s2.equipo_a_id ? s2.equipo_a_nombre : s2.equipo_b_nombre;
        const winnerColor2 = winnerId2 === s2.equipo_a_id ? (s2.equipo_a_color || getTeamColor(s2.equipo_a_id)) : (s2.equipo_b_color || getTeamColor(s2.equipo_b_id));

        hideLoading();

        // Modal de confirmación
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML =
            '<div class="modal">' +
            '<h3 style="font-size:0.95rem;margin-bottom:0.8rem;">Confirmar Clasificados a la Final</h3>' +
            '<div style="margin-bottom:0.8rem;">' +
            '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.4rem;font-weight:600;">CLASIFICADOS SEGÚN RESULTADOS ACTUALES</div>' +
            '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.5rem;background:var(--white-5);border-radius:6px;margin-bottom:0.4rem;">' +
            '<span style="font-size:0.75rem;font-weight:600;color:var(--primary);width:3.5rem;">SF 1</span>' +
            '<span style="width:12px;height:12px;border-radius:50%;background:' + winnerColor1 + ';flex-shrink:0;"></span>' +
            '<span style="flex:1;font-weight:600;font-size:0.85rem;">' + esc(winnerName1) + '</span>' +
            '<span style="font-size:0.72rem;color:var(--on-surface-variant-40);">' + aWins1 + ' - ' + bWins1 + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.5rem;background:var(--white-5);border-radius:6px;">' +
            '<span style="font-size:0.75rem;font-weight:600;color:var(--primary);width:3.5rem;">SF 2</span>' +
            '<span style="width:12px;height:12px;border-radius:50%;background:' + winnerColor2 + ';flex-shrink:0;"></span>' +
            '<span style="flex:1;font-weight:600;font-size:0.85rem;">' + esc(winnerName2) + '</span>' +
            '<span style="font-size:0.72rem;color:var(--on-surface-variant-40);">' + aWins2 + ' - ' + bWins2 + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="btn-group" style="justify-content:flex-end;">' +
            '<button class="btn btn-outline" id="btn-cancel-final">Cancelar</button>' +
            '<button class="btn btn-primary" id="btn-confirm-final"><span class="material-symbols-outlined" style="font-size:0.9rem;">workspace_premium</span> Generar Final</button>' +
            '</div></div>';

        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('btn-cancel-final').addEventListener('click', () => overlay.remove());
        document.getElementById('btn-confirm-final').addEventListener('click', async () => {
            overlay.remove();
            await doGenerateFinal(winnerId1, winnerName1, winnerColor1, winnerId2, winnerName2, winnerColor2);
        });
    } catch (e) {
        toast('Error al calcular clasificados a la final', 'error');
        console.error(e);
        hideLoading();
    }
}

async function doGenerateFinal(id1, name1, color1, id2, name2, color2) {
    showLoading('Generando final...');
    try {
        await ensureCategorias();
        const catCount = getDrawCategoriasActivas().length;
        await loadFinales();
        const finalData = {
            equipo_a_id: id1, equipo_a_nombre: name1, equipo_a_color: color1 || '#888',
            equipo_b_id: id2, equipo_b_nombre: name2, equipo_b_color: color2 || '#888',
            ganador_equipo_id: null, estado: 'pendiente', numero: 1, partidos_esperados: catCount
        };

        if (allFinales.length > 0) {
            await updateDoc(finalDocRef(allFinales[0].id), finalData);
        } else {
            await addDoc(finalCol(), finalData);
        }

        toast('¡Gran Final generada con éxito!', 'success');
        await loadFinales();
        renderFinal();
    } catch (e) {
        toast('Error al generar final', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

async function saveFinalPartido() {
    const finalId = selectedFinalId;
    const editingId = editingFinalPartidoId;
    if (!finalId || !editingId) return;

    const fin = allFinales.find(f => f.id === finalId);
    if (!fin) return;

    const isNew = editingId.startsWith('__new__');
    const categoria = isNew ? editingId.replace('__new__', '') : '';

    const j1 = document.getElementById('dp-j1')?.value || null;
    const j2 = document.getElementById('dp-j2')?.value || null;
    const j3 = document.getElementById('dp-j3')?.value || null;
    const j4 = document.getElementById('dp-j4')?.value || null;

    if (!j1 || !j2 || !j3 || !j4) { toast('Seleccioná los 4 jugadores', 'error'); return; }
    if (j1 === j2) { toast('Los jugadores del equipo A no pueden ser iguales', 'error'); return; }
    if (j3 === j4) { toast('Los jugadores del equipo B no pueden ser iguales', 'error'); return; }

    const j1Data = allJugadores.find(j => j.id === j1);
    const j2Data = allJugadores.find(j => j.id === j2);
    const j3Data = allJugadores.find(j => j.id === j3);
    const j4Data = allJugadores.find(j => j.id === j4);

    if (j1Data && j1Data.equipo_id !== fin.equipo_a_id) { toast('Jugador 1 no pertenece al equipo A', 'error'); return; }
    if (j2Data && j2Data.equipo_id !== fin.equipo_a_id) { toast('Jugador 2 no pertenece al equipo A', 'error'); return; }
    if (j3Data && j3Data.equipo_id !== fin.equipo_b_id) { toast('Jugador 3 no pertenece al equipo B', 'error'); return; }
    if (j4Data && j4Data.equipo_id !== fin.equipo_b_id) { toast('Jugador 4 no pertenece al equipo B', 'error'); return; }

    const data = {
        jugador_a_1_id: j1, jugador_a_2_id: j2,
        jugador_b_1_id: j3, jugador_b_2_id: j4,
        jugador_a_1_nombre: getJugadorNombre(j1),
        jugador_a_2_nombre: getJugadorNombre(j2),
        jugador_b_1_nombre: getJugadorNombre(j3),
        jugador_b_2_nombre: getJugadorNombre(j4)
    };

    showLoading('Guardando...');
    try {
        if (isNew) {
            data.categoria = categoria;
            data.equipo_a_id = fin.equipo_a_id;
            data.equipo_b_id = fin.equipo_b_id;
            data.set1_a = null; data.set1_b = null;
            data.set2_a = null; data.set2_b = null;
            data.tiebreak1_a = null; data.tiebreak1_b = null;
            data.tiebreak2_a = null; data.tiebreak2_b = null;
            data.supertiebreak_a = null; data.supertiebreak_b = null;
            data.games_a = 0; data.games_b = 0;
            data.ganador_equipo_id = null;
            data.estado = 'pendiente';
            await addDoc(finalPartidoCol(finalId), data);
            toast('Partido creado — ' + formatCategoria(categoria), 'success');
        } else {
            await updateDoc(finalPartidoDocRef(finalId, editingId), data);
            toast('Jugadores guardados', 'success');
        }
        editingFinalPartidoId = null;
        await loadFinalPartidos(finalId);
        renderFinalDetail();
    } catch (e) {
        toast('Error al guardar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function deleteFinalPartido(partidoId) {
    const finalId = selectedFinalId;
    if (!finalId || !partidoId) return;

    const fin = allFinales.find(f => f.id === finalId);
    if (!fin) return;

    const partido = finalPartidos.find(p => p.id === partidoId);
    if (!partido) return;

    if (!confirm('¿Eliminar el partido "' + formatCategoria(partido.categoria) + '"?')) return;

    showLoading('Eliminando partido...');
    try {
        await deleteDoc(finalPartidoDocRef(finalId, partidoId));
        toast('Partido eliminado', 'success');
        editingFinalPartidoId = null;
        await loadFinalPartidos(finalId);
        renderFinalDetail();
    } catch (e) {
        toast('Error al eliminar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function saveFinalResultado() {
    const finalId = selectedFinalId;
    const partidoId = editingFinalPartidoId;
    if (!finalId || !partidoId) return;

    const s1A = document.getElementById('res-s1-a')?.value ?? '';
    const s1B = document.getElementById('res-s1-b')?.value ?? '';
    const s2A = document.getElementById('res-s2-a')?.value ?? '';
    const s2B = document.getElementById('res-s2-b')?.value ?? '';
    const tb1A = document.getElementById('res-tb1-a')?.value ?? '';
    const tb1B = document.getElementById('res-tb1-b')?.value ?? '';
    const tb2A = document.getElementById('res-tb2-a')?.value ?? '';
    const tb2B = document.getElementById('res-tb2-b')?.value ?? '';
    const stbA = document.getElementById('res-stb-a')?.value ?? '';
    const stbB = document.getElementById('res-stb-b')?.value ?? '';

    if (!validateMatchScore(s1A, s1B, s2A, s2B, tb1A, tb1B, tb2A, tb2B, stbA, stbB)) return;

    const s1l = parseInt(s1A), s1v = parseInt(s1B);
    const s2l = parseInt(s2A), s2v = parseInt(s2B);
    const tb1l = tb1A !== '' ? parseInt(tb1A) : null;
    const tb1v = tb1B !== '' ? parseInt(tb1B) : null;
    const tb2l = tb2A !== '' ? parseInt(tb2A) : null;
    const tb2v = tb2B !== '' ? parseInt(tb2B) : null;
    const stbl = stbA !== '' ? parseInt(stbA) : null;
    const stbv = stbB !== '' ? parseInt(stbB) : null;

    const ganador = determineMatchWinner(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);
    const games = calculateGames(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);

    const fin = allFinales.find(f => f.id === finalId);
    const partido = finalPartidos.find(p => p.id === partidoId);
    if (!partido) return;

    const ganadorEquipoId = ganador === 'a' ? fin.equipo_a_id :
                            ganador === 'b' ? fin.equipo_b_id : null;

    showLoading('Guardando resultado...');
    try {
        await updateDoc(finalPartidoDocRef(finalId, partidoId), {
            set1_a: s1l, set1_b: s1v,
            set2_a: s2l, set2_b: s2v,
            tiebreak1_a: tb1l, tiebreak1_b: tb1v,
            tiebreak2_a: tb2l, tiebreak2_b: tb2v,
            supertiebreak_a: stbl, supertiebreak_b: stbv,
            ganador_equipo_id: ganadorEquipoId,
            estado: 'finalizado',
            games_a: games.games_a,
            games_b: games.games_b,
            fecha_resultado: new Date()
        });
        toast('Resultado guardado', 'success');
        editingFinalPartidoId = null;
        await loadFinalPartidos(finalId);
        await checkFinalWinner(finalId);
        renderFinalDetail();
    } catch (e) {
        toast('Error al guardar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function clearFinalResultado() {
    const finalId = selectedFinalId;
    const partidoId = editingFinalPartidoId;
    if (!finalId || !partidoId) return;

    const partido = finalPartidos.find(p => p.id === partidoId);
    if (!partido || partido.estado !== 'finalizado') return;
    if (!confirm('¿Limpiar este resultado?')) return;

    showLoading('Limpiando resultado...');
    try {
        const fin = allFinales.find(f => f.id === finalId);
        await updateDoc(finalPartidoDocRef(finalId, partidoId), {
            set1_a: null, set1_b: null,
            set2_a: null, set2_b: null,
            tiebreak1_a: null, tiebreak1_b: null,
            tiebreak2_a: null, tiebreak2_b: null,
            supertiebreak_a: null, supertiebreak_b: null,
            ganador_equipo_id: null,
            estado: 'pendiente',
            games_a: 0, games_b: 0,
            fecha_resultado: null
        });
        if (fin && fin.ganador_equipo_id) {
            await updateDoc(finalDocRef(finalId), { ganador_equipo_id: null, estado: 'pendiente' });
        }
        toast('Resultado limpiado', 'success');
        editingFinalPartidoId = null;
        await loadFinalPartidos(finalId);
        renderFinalDetail();
    } catch (e) {
        toast('Error al limpiar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function checkFinalWinner(finalId) {
    const fin = allFinales.find(f => f.id === finalId);
    if (!fin) return;
    const allDone = finalPartidos.length === (fin.partidos_esperados || 7) && finalPartidos.every(p => p.estado === 'finalizado');
    if (!allDone) return;

    let aWins = 0, bWins = 0;
    finalPartidos.forEach(p => {
        if (p.ganador_equipo_id === fin.equipo_a_id) aWins++;
        else if (p.ganador_equipo_id === fin.equipo_b_id) bWins++;
    });

    const ganador = aWins > bWins ? fin.equipo_a_id : (bWins > aWins ? fin.equipo_b_id : null);
    if (ganador) {
        await updateDoc(finalDocRef(finalId), { ganador_equipo_id: ganador, estado: 'finalizado' });
        fin.ganador_equipo_id = ganador;
        fin.estado = 'finalizado';
    }
}

function cerrarFinal(finalId) {
    const fin = allFinales.find(f => f.id === finalId);
    if (!fin) return;

    const finalizados = finalPartidos.filter(p => p.estado === 'finalizado');
    if (finalizados.length === 0) {
        toast('No hay partidos finalizados para cerrar', 'error');
        return;
    }

    let aWins = 0, bWins = 0;
    finalizados.forEach(p => {
        if (p.ganador_equipo_id === fin.equipo_a_id) aWins++;
        else if (p.ganador_equipo_id === fin.equipo_b_id) bWins++;
    });

    if (aWins === bWins) {
        toast('Hay empate (' + aWins + ' - ' + bWins + '). Jugá un desempate o borra un resultado', 'error');
        return;
    }

    const ganadorId = aWins > bWins ? fin.equipo_a_id : fin.equipo_b_id;
    const ganadorName = aWins > bWins ? fin.equipo_a_nombre : fin.equipo_b_nombre;
    const ganadorColor = aWins > bWins ? (fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888') : (fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888');
    const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
    const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal">' +
        '<h3 style="font-size:0.95rem;margin-bottom:0.8rem;">Cerrar Final</h3>' +
        '<div style="margin-bottom:0.8rem;">' +
        '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0;font-size:0.82rem;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + aColor + ';flex-shrink:0;"></span>' +
        '<span style="flex:1;font-weight:600;">' + esc(fin.equipo_a_nombre) + '</span>' +
        '<span style="font-weight:800;font-size:0.85rem;">' + aWins + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0;font-size:0.82rem;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + bColor + ';flex-shrink:0;"></span>' +
        '<span style="flex:1;font-weight:600;">' + esc(fin.equipo_b_nombre) + '</span>' +
        '<span style="font-weight:800;font-size:0.85rem;">' + bWins + '</span>' +
        '</div>' +
        '</div>' +
        '<div style="background:rgba(0,212,170,0.1);border:1px solid rgba(0,212,170,0.2);border-radius:8px;padding:0.6rem;margin-bottom:1rem;text-align:center;">' +
        '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">🏆 CAMPEÓN</div>' +
        '<div style="display:flex;align-items:center;justify-content:center;gap:0.4rem;">' +
        '<span style="width:12px;height:12px;border-radius:50%;background:' + ganadorColor + ';"></span>' +
        '<span style="font-family:Lexend;font-weight:700;font-size:0.9rem;color:var(--secondary);">' + esc(ganadorName) + '</span>' +
        '</div>' +
        '</div>' +
        '<div class="btn-group" style="justify-content:flex-end;">' +
        '<button class="btn btn-outline" id="btn-cancel-close-final">Cancelar</button>' +
        '<button class="btn btn-primary" id="btn-confirm-close-final"><span class="material-symbols-outlined" style="font-size:0.9rem;">check</span> Cerrar y Definir Campeón</button>' +
        '</div></div>';

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('btn-cancel-close-final').addEventListener('click', () => overlay.remove());
    document.getElementById('btn-confirm-close-final').addEventListener('click', async () => {
        overlay.remove();
        showLoading('Cerrando final...');
        try {
            await updateDoc(finalDocRef(finalId), { ganador_equipo_id: ganadorId, estado: 'finalizado' });
            fin.ganador_equipo_id = ganadorId;
            fin.estado = 'finalizado';
            toast('Final cerrada — 🏆 CAMPEÓN: ' + ganadorName, 'success');
            await loadFinalPartidos(finalId);
            renderFinalDetail();
        } catch (e) {
            toast('Error al cerrar final', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    });
}

function renderFinal() {
    const panel = document.getElementById('panel-final');
    if (selectedFinalId) {
        renderFinalDetail();
        return;
    }

    panelLoading(panel, 'Cargando final...');
    Promise.all([loadSemifinales(), loadFinales()]).then(() => {
        const finishedSemis = allSemifinales.filter(s => s.estado === 'finalizado' && s.ganador_equipo_id);
        const allSemisComplete = finishedSemis.length >= 2;
        const hasFinal = allFinales.length > 0;

        let html = '';

        // Status
        html += '<div class="card" style="border-left:4px solid ' + (allSemisComplete ? 'var(--secondary)' : 'var(--primary)') + ';margin-bottom:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.5rem;">' +
            '<span class="material-symbols-outlined" style="font-size:1rem;color:' + (allSemisComplete ? 'var(--secondary)' : 'var(--primary)') + ';">' + (allSemisComplete ? 'check_circle' : 'hourglass_empty') + '</span>' +
            '<div>' +
            '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">FINAL</div>' +
            '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);">' +
            (allSemisComplete ? 'Semifinales completadas — Final disponible' : 'Esperando que se completen las semifinales (' + finishedSemis.length + '/2)') +
            '</div></div></div></div>';

        if (!hasFinal) {
            html += '<div class="empty-state" style="padding:2rem;">' +
                '<span class="material-symbols-outlined">workspace_premium</span>' +
                '<p>No hay final generada.<br>Podés generarla en cualquier momento con los marcadores actuales de las semifinales.</p>' +
                '<button class="btn btn-primary" id="btn-gen-final"><span class="material-symbols-outlined" style="font-size:1rem;">add</span> Generar Final</button>' +
                '</div>';
            panel.innerHTML = html;
            document.getElementById('btn-gen-final')?.addEventListener('click', () => safeAction(generateFinal));
            return;
        }

        // Show final card
        allFinales.forEach(fin => {
            const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
            const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';
            let aWins = 0, bWins = 0;
            fin.partidos.forEach(p => {
                if (p.ganador_equipo_id === fin.equipo_a_id) aWins++;
                else if (p.ganador_equipo_id === fin.equipo_b_id) bWins++;
            });
            const campeon = fin.ganador_equipo_id === fin.equipo_a_id ? fin.equipo_a_nombre :
                            fin.ganador_equipo_id === fin.equipo_b_id ? fin.equipo_b_nombre : null;

            html += '<div class="card" style="cursor:pointer;border-left:4px solid ' + (campeon ? (fin.ganador_equipo_id === fin.equipo_a_id ? aColor : bColor) : 'var(--primary)') + ';" data-final-id="' + fin.id + '">' +
                '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + aColor + ';"></span>' +
                esc(fin.equipo_a_nombre || '?') + '</span>' +
                '<span style="font-family:Lexend;font-weight:800;font-size:0.75rem;color:var(--on-surface-variant-40);">VS</span>' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + bColor + ';"></span>' +
                esc(fin.equipo_b_nombre || '?') + '</span>' +
                '</div>' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.4rem;">' +
                '<span style="font-size:0.75rem;">' + aWins + ' - ' + bWins + '</span>' +
                (campeon
                    ? '<span class="badge badge-success" style="font-size:0.65rem;"><span class="material-symbols-outlined" style="font-size:0.6rem;">workspace_premium</span> 🏆 CAMPEÓN: ' + esc(campeon) + '</span>'
                    : '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + fin.partidos.filter(p => p.estado === 'finalizado').length + '/' + (fin.partidos_esperados || 7) + ' finalizados</span>') +
                '</div></div>';
        });

        panel.innerHTML = html;
        panel.querySelectorAll('[data-final-id]').forEach(b => b.addEventListener('click', async () => {
            selectedFinalId = b.dataset.finalId;
            editingFinalPartidoId = null;
            await loadFinalPartidos(b.dataset.finalId);
            renderFinalDetail();
        }));
    });
}

async function renderFinalDetail() {
    await ensureCategorias();
    const panel = document.getElementById('panel-final');
    const fin = allFinales.find(f => f.id === selectedFinalId);
    if (!fin) { selectedFinalId = null; renderFinal(); return; }

    const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
    const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';
    const allDone = fin.partidos.length === (fin.partidos_esperados || 7) && fin.partidos.every(p => p.estado === 'finalizado');
    let aWins = 0, bWins = 0;
    fin.partidos.forEach(p => {
        if (p.ganador_equipo_id === fin.equipo_a_id) aWins++;
        else if (p.ganador_equipo_id === fin.equipo_b_id) bWins++;
    });

    let html = '';

    // Header
    html += '<div class="card" style="border-top:3px solid var(--secondary);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">' +
        '<div>' +
        '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-bottom:0.15rem;">🏆 FINAL</div>' +
        '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.95rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + aColor + ';"></span>' +
        esc(fin.equipo_a_nombre || '?') +
        '</span>' +
        '<span style="font-family:Lexend;font-weight:800;font-size:0.85rem;color:var(--on-surface-variant-40);">VS</span>' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.95rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + bColor + ';"></span>' +
        esc(fin.equipo_b_nombre || '?') +
        '</span>' +
        '</div></div>' +
        '<button class="btn btn-sm btn-outline" id="btn-back-finales"><span class="material-symbols-outlined" style="font-size:0.8rem;">arrow_back</span></button>' +
        '</div></div>';

    // Summary
    const campeon = fin.ganador_equipo_id === fin.equipo_a_id ? fin.equipo_a_nombre :
                    fin.ganador_equipo_id === fin.equipo_b_id ? fin.equipo_b_nombre : null;

    html += '<div class="card" style="border-left:4px solid ' + (allDone ? 'var(--secondary)' : 'var(--primary)') + ';">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">Resumen</div>' +
        (allDone
            ? '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">check_circle</span> Completo</span>'
            : '<span class="badge" style="background:var(--primary-container);color:var(--primary);">' + fin.partidos.filter(p => p.estado === 'finalizado').length + '/' + (fin.partidos_esperados || 7) + '</span>') +
        '</div>' +
        '<div style="display:flex;gap:1rem;">' +
        '<div style="flex:1;"><div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(fin.equipo_a_nombre) + '</div>' +
        '<div style="font-size:0.82rem;">Partidos: <strong>' + aWins + '</strong></div></div>' +
        '<div style="flex:1;"><div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(fin.equipo_b_nombre) + '</div>' +
        '<div style="font-size:0.82rem;">Partidos: <strong>' + bWins + '</strong></div></div>' +
        '</div>';

    if (campeon) {
        const campColor = fin.ganador_equipo_id === fin.equipo_a_id ? aColor : bColor;
        html += '<div style="margin-top:0.75rem;padding:0.75rem;background:rgba(255,255,255,0.05);border-radius:8px;text-align:center;">' +
            '<div style="font-size:1.5rem;margin-bottom:0.3rem;">🏆</div>' +
            '<div style="font-family:Lexend;font-weight:800;font-size:1.1rem;color:' + campColor + ';">CAMPEÓN</div>' +
            '<div style="display:flex;align-items:center;justify-content:center;gap:0.4rem;margin-top:0.3rem;">' +
            '<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:' + campColor + ';"></span>' +
            '<span style="font-family:Lexend;font-weight:600;font-size:1rem;">' + esc(campeon) + '</span>' +
            '</div></div>';
    }

    html += '</div>';

    if (fin.estado !== 'finalizado') {
        html += '<div style="margin:0.75rem 0;">' +
            '<button class="btn btn-primary" id="btn-close-final" style="width:100%;"><span class="material-symbols-outlined" style="font-size:1rem;">lock</span> Cerrar Final y Proclamar Campeón</button>' +
            '</div>';
    }

    // Edit forms
    if (editingFinalPartidoId) {
        if (editingFinalPartidoId.startsWith('__new__')) {
            html += renderFinalPartidoForm(fin);
        } else {
            const part = finalPartidos.find(p => p.id === editingFinalPartidoId);
            if (part) {
                if (editingFinalFormMode === 'score') {
                    const hasPlayers = part.jugador_a_1_id && part.jugador_b_1_id;
                    if (hasPlayers) {
                        part._resContainerType = 'final';
                        part._resContainerId = selectedFinalId;
                        part._resJornadaId = selectedFinalId;
                        part._jornadaNumero = 'Final';
                        part._teamAColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#4da6ff';
                        part._teamBColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#feb300';
                        if (!resPartidos.find(p => p.id === part.id)) resPartidos.push(part);
                        if (!resultScores[part.id]) {
                            resultScores[part.id] = { set1_a: 0, set1_b: 0, set2_a: 0, set2_b: 0, tb1_a: null, tb1_b: null, tb2_a: null, tb2_b: null, stb_a: null, stb_b: null, _closed: {} };
                        }
                        resEditing[part.id] = true;
                        html += '<div id="res-card-panel-final">';
                        html += resCardHtml(part);
                        html += '</div>';
                    } else {
                        html += '<div class="card" style="border:2px solid var(--error);margin-bottom:0.5rem;padding:0.75rem;font-size:0.8rem;color:var(--error);">⚠️ Primero asigná los jugadores para poder cargar el resultado.</div>';
                        html += renderFinalPartidoForm(fin, part);
                    }
                } else {
                    html += renderFinalPartidoForm(fin, part);
                }
            }
        }
    }

    // Partidos list
    const allCats = getDrawCategoriasTodas();
    const expectedFinal = fin.partidos_esperados || 7;
    html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_tennis</span> Partidos (' + fin.partidos.length + '/' + expectedFinal + ')</div>';

    allCats.forEach((cat, idx) => {
        const partido = fin.partidos.find(p => p.categoria === cat.nombre);
        const num = String(idx + 1).padStart(2, '0');
        const isInactive = cat.activa === false;

        if (partido) {
            const isFinalizado = partido.estado === 'finalizado';
            const j1Name = getJugadorNombre(partido.jugador_a_1_id) || partido.jugador_a_1_nombre || '';
            const j2Name = getJugadorNombre(partido.jugador_a_2_id) || partido.jugador_a_2_nombre || '';
            const j3Name = getJugadorNombre(partido.jugador_b_1_id) || partido.jugador_b_1_nombre || '';
            const j4Name = getJugadorNombre(partido.jugador_b_2_id) || partido.jugador_b_2_nombre || '';
            const isEmpty = !partido.jugador_a_1_id && !partido.jugador_a_2_id && !partido.jugador_b_1_id && !partido.jugador_b_2_id;

            const borderColor = isFinalizado ? (partido.ganador_equipo_id === fin.equipo_a_id ? aColor : bColor) : 'var(--on-surface-variant-40)';

            html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid ' + borderColor + ';' + (isInactive ? 'opacity:0.7;' : '') + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--primary);">' + num + ' ' + esc(formatCategoria(cat.nombre)) + (isInactive ? ' <span class="badge" style="background:var(--secondary-container);color:var(--secondary);font-size:0.55rem;">INACTIVA</span>' : '') + '</span>' +
                (isFinalizado ? '<span class="badge badge-success" style="font-size:0.6rem;">✓ FINALIZADO</span>' : '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);font-size:0.6rem;">PENDIENTE</span>') +
                '</div>';

            if (isEmpty) {
                html += '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">Sin jugadores asignados</div>';
            } else {
                html += '<div style="display:flex;flex-direction:column;gap:0.2rem;font-size:0.75rem;">' +
                    '<div style="display:flex;align-items:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span>' +
                    '<span>' + esc(j1Name || '—') + ' / ' + esc(j2Name || '—') + '</span></div>' +
                    '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);text-align:center;font-family:Lexend;font-weight:800;">VS</div>' +
                    '<div style="display:flex;align-items:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span>' +
                    '<span>' + esc(j3Name || '—') + ' / ' + esc(j4Name || '—') + '</span></div>' +
                    '</div>';
            }

            if (isFinalizado) {
                const s1 = partido.set1_a + '-' + partido.set1_b;
                const s2 = partido.set2_a + '-' + partido.set2_b;
                const tb1 = (partido.tiebreak1_a != null && partido.tiebreak1_b != null) ? ' · TB1 ' + partido.tiebreak1_a + '-' + partido.tiebreak1_b : '';
                const tb2 = (partido.tiebreak2_a != null && partido.tiebreak2_b != null) ? ' · TB2 ' + partido.tiebreak2_a + '-' + partido.tiebreak2_b : '';
                const hasSTB = partido.supertiebreak_a != null && partido.supertiebreak_b != null;
                const stb = hasSTB ? ' · STB ' + partido.supertiebreak_a + '-' + partido.supertiebreak_b : '';
                const ganadorName = partido.ganador_equipo_id === fin.equipo_a_id ? fin.equipo_a_nombre : fin.equipo_b_nombre;
                html += '<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--on-surface-variant-40);">' +
                    '<span style="font-weight:600;">' + s1 + '</span> · <span style="font-weight:600;">' + s2 + '</span>' + esc(tb1) + esc(tb2) + esc(stb) +
                    ' · <span style="color:var(--secondary);">🏆 ' + esc(ganadorName) + '</span></div>';
            }

            html += '</div>' +
                '<div style="display:flex;gap:0.3rem;">' +
                '<button class="btn btn-sm btn-outline" data-edit-final-partido="' + partido.id + '" title="Editar jugadores"><span class="material-symbols-outlined" style="font-size:0.8rem;">people</span></button>' +
                '<button class="btn btn-sm btn-outline" data-final-edit="' + partido.id + '" title="Editar score"><span class="material-symbols-outlined" style="font-size:0.8rem;">sports_score</span></button>' +
                '<button class="btn btn-sm btn-danger" data-del-final-partido="' + partido.id + '" title="Eliminar"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' +
                '</div></div></div>';
        } else if (!isInactive) {
            html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid var(--on-surface-variant-40);">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div>' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--on-surface-variant-40);">' + num + ' ' + esc(formatCategoria(cat.nombre)) + '</div>' +
                '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">No configurado</div>' +
                '</div>' +
                '<button class="btn btn-sm btn-primary" data-add-final-partido="' + esc(cat.nombre) + '" title="Crear partido"><span class="material-symbols-outlined" style="font-size:0.8rem;">add</span></button>' +
                '</div></div>';
        }
    });

    panel.innerHTML = html;

    // Event listeners
    document.getElementById('btn-back-finales')?.addEventListener('click', () => {
        selectedFinalId = null;
        editingFinalPartidoId = null;
        editingFinalFormMode = null;
        finalPartidos = [];
        renderFinal();
    });

    document.getElementById('btn-close-final')?.addEventListener('click', () => safeAction(() => cerrarFinal(selectedFinalId)));

    panel.querySelectorAll('[data-add-final-partido]').forEach(b => b.addEventListener('click', () => {
        editingFinalPartidoId = '__new__' + b.dataset.addFinalPartido;
        renderFinalDetail();
    }));

    panel.querySelectorAll('[data-edit-final-partido]').forEach(b => b.addEventListener('click', () => {
        editingFinalPartidoId = b.dataset.editFinalPartido;
        editingFinalFormMode = 'players';
        renderFinalDetail();
    }));

    panel.querySelectorAll('[data-final-edit]').forEach(b => b.addEventListener('click', () => {
        editingFinalPartidoId = b.dataset.finalEdit;
        editingFinalFormMode = 'score';
        renderFinalDetail();
    }));

    panel.querySelectorAll('[data-del-final-partido]').forEach(b => b.addEventListener('click', () => safeAction(() => deleteFinalPartido(b.dataset.delFinalPartido))));

    document.getElementById('btn-save-final-partido')?.addEventListener('click', () => safeAction(saveFinalPartido));
    document.getElementById('btn-cancel-final-partido')?.addEventListener('click', () => { editingFinalPartidoId = null; editingFinalFormMode = null; renderFinalDetail(); });

    // Bind res card events for score editing
    const resCardPanel = document.getElementById('res-card-panel-final');
    if (resCardPanel) {
        const card = resCardPanel.querySelector('[data-res-card]');
        if (card) {
            bindResCardEvents(card, resCardPanel, () => { editingFinalFormMode = null; renderFinalDetail(); });
        }
    }

    // Player select cross-referencing
    const j1Sel = document.getElementById('dp-j1');
    const j2Sel = document.getElementById('dp-j2');
    const j3Sel = document.getElementById('dp-j3');
    const j4Sel = document.getElementById('dp-j4');

    if (j1Sel && j2Sel) {
        const updatePair = () => {
            const v1 = j1Sel.value;
            const players = getPlayersInTeam(fin.equipo_a_id);
            j2Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                players.filter(p => p.id !== v1).map(p => '<option value="' + p.id + '"' + (p.id === j2Sel.value ? ' selected' : '') + '>' + shortName(p) + '</option>').join('');
        };
        j1Sel.addEventListener('change', updatePair);
    }
    if (j3Sel && j4Sel) {
        const updatePair = () => {
            const v3 = j3Sel.value;
            const players = getPlayersInTeam(fin.equipo_b_id);
            j4Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                players.filter(p => p.id !== v3).map(p => '<option value="' + p.id + '"' + (p.id === j4Sel.value ? ' selected' : '') + '>' + shortName(p) + '</option>').join('');
        };
        j3Sel.addEventListener('change', updatePair);
    }
}

function renderFinalPartidoForm(fin, existingPart) {
    const isNew = editingFinalPartidoId && editingFinalPartidoId.startsWith('__new__');
    const categoria = isNew ? editingFinalPartidoId.replace('__new__', '') : (existingPart?.categoria || '');

    const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
    const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';
    const aPlayers = getPlayersInTeam(fin.equipo_a_id);
    const bPlayers = getPlayersInTeam(fin.equipo_b_id);
    const makeOpts = (players, sel, excl) => '<option value="">— Seleccionar —</option>' + players.filter(p => p.id !== excl).map(p => '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + shortName(p) + '</option>').join('');

    const j1 = existingPart?.jugador_a_1_id || '';
    const j2 = existingPart?.jugador_a_2_id || '';
    const j3 = existingPart?.jugador_b_1_id || '';
    const j4 = existingPart?.jugador_b_2_id || '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">' + (isNew ? 'add' : 'edit') + '</span> ' + (isNew ? 'Crear' : 'Editar') + ' — ' + esc(formatCategoria(categoria)) +
        '</div>';

    if (aPlayers.length < 2) {
        html += '<div style="font-size:0.78rem;color:var(--error);margin-bottom:0.5rem;">⚠️ Equipo A necesita al menos 2 jugadores (' + aPlayers.length + '/2)</div>';
    }
    if (bPlayers.length < 2) {
        html += '<div style="font-size:0.78rem;color:var(--error);margin-bottom:0.5rem;">⚠️ Equipo B necesita al menos 2 jugadores (' + bPlayers.length + '/2)</div>';
    }

    html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(fin.equipo_a_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 1</label><select id="dp-j1">' + makeOpts(aPlayers, j1, j2) + '</select></div>' +
        '<div class="form-group"><label>Jugador 2</label><select id="dp-j2">' + makeOpts(aPlayers, j2, j1) + '</select></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;padding-bottom:1.5rem;font-family:Lexend;font-weight:800;font-size:0.8rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(fin.equipo_b_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 3</label><select id="dp-j3">' + makeOpts(bPlayers, j3, j4) + '</select></div>' +
        '<div class="form-group"><label>Jugador 4</label><select id="dp-j4">' + makeOpts(bPlayers, j4, j3) + '</select></div>' +
        '</div></div>';

    html += '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-final-partido"><span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar</button>' +
        '<button class="btn btn-outline" id="btn-cancel-final-partido"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div></div>';

    return html;
}

function renderFinalResultadoForm(fin, part) {
    const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
    const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';
    const s1l = part.set1_a != null ? part.set1_a : '';
    const s1v = part.set1_b != null ? part.set1_b : '';
    const s2l = part.set2_a != null ? part.set2_a : '';
    const s2v = part.set2_b != null ? part.set2_b : '';
    const tb1l = part.tiebreak1_a != null ? part.tiebreak1_a : '';
    const tb1v = part.tiebreak1_b != null ? part.tiebreak1_b : '';
    const tb2l = part.tiebreak2_a != null ? part.tiebreak2_a : '';
    const tb2v = part.tiebreak2_b != null ? part.tiebreak2_b : '';
    const stbl = part.supertiebreak_a != null ? part.supertiebreak_a : '';
    const stbv = part.supertiebreak_b != null ? part.supertiebreak_b : '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">sports_score</span> ' +
        (part.estado === 'finalizado' ? 'Editar' : 'Ingresar') + ' Resultado — ' + esc(formatCategoria(part.categoria || '')) +
        '</div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 1</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(fin.equipo_a_nombre) + '</div>' +
        '<input type="number" id="res-s1-a" min="0" max="7" value="' + s1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(fin.equipo_b_nombre) + '</div>' +
        '<input type="number" id="res-s1-b" min="0" max="7" value="' + s1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 1 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb1-a" min="0" max="15" value="' + tb1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb1-b" min="0" max="15" value="' + tb1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 2</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-s2-a" min="0" max="7" value="' + s2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-s2-b" min="0" max="7" value="' + s2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 2 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb2-a" min="0" max="15" value="' + tb2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb2-b" min="0" max="15" value="' + tb2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SUPER TIE BREAK <span style="font-weight:400;font-size:0.65rem;">(solo si sets 1-1)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.75rem;">' +
        '<div style="flex:1;"><input type="number" id="res-stb-a" min="0" max="20" value="' + stbl + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-stb-b" min="0" max="20" value="' + stbv + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-final-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar Resultado</button>' +
        '<button class="btn btn-outline" id="btn-cancel-final-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div></div>';

    return html;
}

// ═══════════════════════════════════════════
// USUARIOS
// ═══════════════════════════════════════════

function formatDateFull(fecha) {
    if (!fecha) return '—';
    try {
        const d = fecha?.toDate ? fecha.toDate() : new Date(fecha);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch (e) { return '—'; }
}

async function renderUsuarios() {
    const panel = document.getElementById('panel-usuarios');
    if (!panel) return;

    panelLoading(panel, 'Cargando usuarios...');

    try {
        const snapshot = await getDocs(query(collection(db, 'usuarios'), orderBy('nombre')));
        allUsuarios = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        const rolActual = getCurrentUserRole();
        const masterActual = allUsuarios.find(u => u.rol === ROLES.MASTER);

        let html = '<div class="admin-section-title" style="margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;">' +
            '<span><span class="material-symbols-outlined" style="font-size:0.9rem;">manage_accounts</span> ' +
            'Gestión de Usuarios (' + allUsuarios.length + ')</span>' +
            '<div style="display:flex;gap:0.4rem;">' +
            '<button id="sync-btn" class="btn btn-sm btn-outline" onclick="showSyncPanel()" style="padding:0.35rem 0.7rem;font-size:0.75rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.85rem;">sync_alt</span> Sincronizar</button>' +
            '<button class="btn btn-primary" onclick="openUserModal(\'crear\')" style="padding:0.4rem 0.8rem;font-size:0.8rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.9rem;">person_add</span> Nuevo</button>' +
            '</div></div>';

        if (allUsuarios.length === 0) {
            html += '<div class="empty-state" style="padding:2rem;text-align:center;">' +
                '<span class="material-symbols-outlined" style="font-size:2rem;color:var(--on-surface-variant);">person_off</span>' +
                '<p style="margin-top:0.5rem;">No hay usuarios registrados.</p></div>';
        } else {
            allUsuarios.forEach(u => {
                const rolInfo = ROL_LABELS[u.rol] || { name: u.rol, short: u.rol };
                const isMasterUser = u.rol === ROLES.MASTER;
                const isDisabled = u.activo === false;

                let rolBadgeClass = 'badge';
                if (u.rol === ROLES.MASTER) rolBadgeClass = 'badge-primary';
                else if (u.rol === ROLES.FULL) rolBadgeClass = 'badge-secondary';
                else rolBadgeClass = 'badge-outline';

                let estadoLabel = isDisabled ? 'INACTIVO' : 'ACTIVO';
                let estadoClass = isDisabled ? 'badge-danger' : 'badge-success';

                html += '<div class="card" style="margin-bottom:0.75rem;' + (isDisabled ? 'opacity:0.6;' : '') + '">';
                html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;">';
                html += '<div style="flex:1;min-width:0;">';
                html += '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;margin-bottom:0.2rem;">' + esc(u.nombre || '—') + '</div>';
                html += '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' + esc(u.email || '') + '</div>';
                html += '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center;">';
                html += '<span class="badge ' + rolBadgeClass + '">' + rolInfo.short + '</span>';
                html += '<span class="badge ' + estadoClass + '">' + estadoLabel + '</span>';
                html += '</div>';

                if (u.createdAt) {
                    html += '<div style="font-size:0.68rem;color:var(--on-surface-variant-30);margin-top:0.4rem;">';
                    html += 'Creado: ' + formatDateFull(u.createdAt);
                    if (u.lastLogin) html += ' · Último acceso: ' + formatDateFull(u.lastLogin);
                    html += '</div>';
                }

                html += '</div>';
                html += '<div style="display:flex;gap:0.3rem;flex-shrink:0;">';

                if (!isMasterUser) {
                    html += '<button class="btn btn-sm btn-outline" data-edit-usuario="' + u.id + '">' +
                        '<span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span></button>';
                    html += '<button class="btn btn-sm ' + (isDisabled ? 'btn-primary' : 'btn-danger') + '" data-toggle-usuario="' + u.id + '">' +
                        (isDisabled ? 'Activar' : 'Desactivar') + '</button>';
                } else {
                    html += '<span class="badge" style="background:var(--primary-12);color:var(--primary);">Protegido</span>';
                }

                html += '</div></div></div>';
            });
        }

        panel.innerHTML = html;

        panel.querySelectorAll('[data-edit-usuario]').forEach(b => {
            b.addEventListener('click', () => openUserModal('editar', b.dataset.editUsuario));
        });

        panel.querySelectorAll('[data-toggle-usuario]').forEach(b => {
            b.addEventListener('click', () => toggleUsuario(b.dataset.toggleUsuario));
        });

    } catch (e) {
        console.error('[admin] Error loading usuarios:', e);
        panel.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;">' +
            '<span class="material-symbols-outlined" style="font-size:2rem;color:var(--error);">error</span>' +
            '<p style="margin-top:0.5rem;">Error al cargar usuarios.</p></div>';
    }
}

async function showSyncPanel() {
    const panel = document.getElementById('panel-usuarios');
    if (!panel) return;

    if (_syncLoading || _syncData.missingFromFirestore.length > 0) {
        panel.innerHTML = '';
        renderUsuarios();
        return;
    }

    _syncLoading = true;
    panel.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;">' +
        '<span class="material-symbols-outlined" style="font-size:2rem;">sync_alt</span>' +
        '<p style="margin-top:0.5rem;">Cargando datos de sincronización...</p></div>';

    try {
        const importMissingUsersFn = httpsCallable(functions, 'importMissingUsers');
        const syncListUsersFn = httpsCallable(functions, 'syncListUsers');

        let result = await syncListUsersFn({ limit: 50, pageToken: _syncPageToken || null });
        _syncData = result.data;

        let html = '<div style="margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;">' +
            '<h3 style="margin:0;font-size:1rem;"><span class="material-symbols-outlined">sync_alt</span> Sincronización Firebase Auth ↔ Firestore</h3>' +
            '<button class="btn btn-sm btn-outline" onclick="renderUsuarios()" style="padding:0.35rem 0.7rem;font-size:0.75rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.85rem;">arrow_back</span> Volver</button>' +
            '</div>';

        if (_syncData.missingFromFirestore && _syncData.missingFromFirestore.length > 0) {
            html += '<div style="background:#FFF3E0;border-left:4px solid #FF9800;padding:0.8rem;margin-bottom:1rem;border-radius:4px;">';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">' +
                '<strong style="color:#E65100;">⚠️ En Auth sin Firestore (' + _syncData.missingFromFirestore.length + ')</strong>' +
                '<button id="import-btn" class="btn btn-primary" onclick="importMissingUsers()" style="padding:0.35rem 0.7rem;font-size:0.75rem;">' +
                '<span class="material-symbols-outlined" style="font-size:0.85rem;">download</span> Importar todos</button>' +
                '</div>';
            html += '<p style="font-size:0.8rem;color:#BF360C;margin:0;">Usuarios creados en Firebase Console sin documento en Firestore.</p>';
            html += '</div>';

            html += '<div class="card">';
            _syncData.missingFromFirestore.forEach((u) => {
                html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--outline-variant);">' +
                    '<div>' +
                    '<div style="font-weight:600;font-size:0.85rem;">' + esc(u.displayName || u.email) + '</div>' +
                    '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">' + esc(u.email) + '</div>' +
                    (u.disabled ? '<span class="badge badge-danger" style="font-size:0.65rem;">Desactivado</span>' : '') +
                    '</div>' +
                    '<div style="text-align:right;">' +
                    (u.lastLoginAt ? '<div style="font-size:0.7rem;color:var(--on-surface-variant-30);">Último acceso: ' + formatDateFull(new Date(u.lastLoginAt)) + '</div>' : '') +
                    '</div>' +
                    '</div>';
            });
            html += '</div>';

            if (_syncData.hasMore && _syncData.missingFromFirestore.length < 50) {
                _syncPageToken = _syncData.nextPageToken;
                html += '<button id="load-more-sync" class="btn btn-outline" onclick="loadMoreSync()" style="width:100%;margin-top:1rem;">' +
                    '<span class="material-symbols-outlined">expand_more</span> Cargar más</button>';
            }
        } else {
            html += '<div style="background:#E8F5E9;border-left:4px solid #4CAF50;padding:0.8rem;margin-bottom:1rem;border-radius:4px;">';
            html += '<div style="display:flex;align-items:center;gap:0.5rem;">' +
                '<span class="material-symbols-outlined" style="color:#2E7D32;">check_circle</span>' +
                '<strong style="color:#1B5E20;">Todos sincronizados</strong>' +
                '</div>' +
                '<p style="font-size:0.8rem;color:#388E3C;margin:0.25rem 0 0;">No hay usuarios en Auth que falten en Firestore.</p>' +
                '</div>';
        }

        if (_syncData.missingFromAuth && _syncData.missingFromAuth.length > 0) {
            html += '<div style="background:#FCE4EC;border-left:4px solid #E91E63;padding:0.8rem;margin-bottom:1rem;border-radius:4px;">';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">' +
                '<strong style="color:#AD1457;">🔗 Orphans en Firestore (' + _syncData.missingFromAuth.length + ')</strong>' +
                '</div>';
            html += '<p style="font-size:0.8rem;color:#C2185B;margin:0;">Docs en Firestore sin usuario en Auth.</p>';
            html += '</div>';

            html += '<div class="card">';
            _syncData.missingFromAuth.forEach(u => {
                html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--outline-variant);">' +
                    '<div>' +
                    '<div style="font-weight:600;font-size:0.85rem;">' + esc(u.nombre || '—') + '</div>' +
                    '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">' + esc(u.email) + '</div>' +
                    '<span class="badge badge-outline" style="font-size:0.65rem;">' + esc(u.rol) + '</span>' +
                    '</div>' +
                    '<div style="font-size:0.7rem;color:var(--on-surface-variant-30);word-break:break-all;">UID: ' + esc(u.uid) + '</div>' +
                    '</div>';
            });
            html += '</div>';
        }

        html += '<div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--outline-variant);">';
        html += '<h4 style="margin:0 0 0.5rem;font-size:0.9rem;">Importación manual</h4>';
        html += '<p style="font-size:0.8rem;color:var(--on-surface-variant-40);margin:0 0 0.5rem;">Si un email fue creado diferente en Auth vs Firestore, ingresá aquí:</p>';
        html += '<textarea id="manual-emails" placeholder="email1@example.com&#10;email2@example.com&#10;..." style="width:100%;min-height:80px;padding:0.5rem;font-family:monospace;font-size:0.8rem;border:1px solid var(--outline);border-radius:4px;"></textarea>';
        html += '<button id="manual-import-btn" class="btn btn-primary" onclick="manualImport()" style="margin-top:0.5rem;width:auto;padding:0.35rem 0.7rem;font-size:0.75rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.85rem;">download</span> Importar emails</button>' +
            '</div>';

        panel.innerHTML = html;

        const importBtn = document.getElementById('import-btn');
        if (importBtn) importBtn.addEventListener('click', importMissingUsers);

        const loadMoreBtn = document.getElementById('load-more-sync');
        if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreSync);

    } catch (e) {
        console.error('[admin] Error loading sync data:', e);
        panel.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;">' +
            '<span class="material-symbols-outlined" style="font-size:2rem;color:var(--error);">error</span>' +
            '<p style="margin-top:0.5rem;">Error al cargar datos de sincronización.</p>' +
            '<pre style="font-size:0.7rem;color:var(--error);margin-top:0.5rem;white-space:pre-wrap;">' + esc(e.message) + '</pre></div>';
    } finally {
        _syncLoading = false;
    }
}

async function loadMoreSync() {
    const btn = document.getElementById('load-more-sync');
    if (btn) btn.style.display = 'none';

    try {
        const syncListUsersFn = httpsCallable(functions, 'syncListUsers');
        let result = await syncListUsersFn({ limit: 50, pageToken: _syncPageToken });
        _syncData = result.data;

        const card = document.querySelector('.card');
        if (card) {
            _syncData.missingFromFirestore.forEach((u) => {
                card.innerHTML += '<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--outline-variant);">' +
                    '<div>' +
                    '<div style="font-weight:600;font-size:0.85rem;">' + esc(u.displayName || u.email) + '</div>' +
                    '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">' + esc(u.email) + '</div>' +
                    (u.disabled ? '<span class="badge badge-danger" style="font-size:0.65rem;">Desactivado</span>' : '') +
                    '</div>' +
                    '<div style="text-align:right;">' +
                    (u.lastLoginAt ? '<div style="font-size:0.7rem;color:var(--on-surface-variant-30);">Acceso: ' + formatDateFull(new Date(u.lastLoginAt)) + '</div>' : '') +
                    '</div>' +
                    '</div>';
            });

            if (_syncData.hasMore && _syncData.missingFromFirestore.length >= 50) {
                const newBtn = document.createElement('button');
                newBtn.id = 'load-more-sync';
                newBtn.className = 'btn btn-outline';
                newBtn.style.cssText = 'width:100%;margin-top:1rem;';
                newBtn.innerHTML = '<span class="material-symbols-outlined">expand_more</span> Cargar más';
                newBtn.addEventListener('click', loadMoreSync);
                card.parentElement.appendChild(newBtn);
            }

            if (_syncData.missingFromFirestore.length === 0) {
                card.remove();
            }
        }

        _syncPageToken = _syncData.nextPageToken;
    } catch (e) {
        console.error('[admin] Error loading more sync data:', e);
        toast('Error al cargar más datos', 'error');
    }
}

async function importMissingUsers() {
    const btn = document.getElementById('import-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Importando...';
    }

    try {
        const importMissingUsersFn = httpsCallable(functions, 'importMissingUsers');
        const emails = _syncData.missingFromFirestore.map(u => u.email);

        const result = await importMissingUsersFn({ emails });

        let msg = 'Importación completada:\n';
        msg += '✅ Creados: ' + result.data.imported.length + '\n';
        msg += '⏭️ Saltados: ' + result.data.skipped.length + '\n';
        if (result.data.errors.length > 0) {
            msg += '❌ Errores: ' + result.data.errors.length;
        }

        alert(msg);

        _syncData.missingFromFirestore = [];
        showSyncPanel();
        renderUsuarios();
    } catch (e) {
        console.error('[admin] Error importing users:', e);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:0.85rem;">download</span> Importar todos';
        }
        toast('Error al importar: ' + e.message, 'error');
    }
}

async function manualImport() {
    const textarea = document.getElementById('manual-emails');
    if (!textarea) return;

    const emails = textarea.value.split('\n').map(e => e.trim()).filter(e => e.includes('@'));
    if (emails.length === 0) {
        toast('Ingresá al menos un email válido', 'warning');
        return;
    }

    const btn = document.getElementById('manual-import-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Importando...';
    }

    try {
        const importMissingUsersFn = httpsCallable(functions, 'importMissingUsers');
        const result = await importMissingUsersFn({ emails });

        let msg = 'Importación manual:\n';
        msg += '✅ Creados: ' + result.data.imported.length + '\n';
        msg += '⏭️ Saltados: ' + result.data.skipped.length + '\n';
        if (result.data.errors.length > 0) {
            msg += '❌ Errores:\n';
            result.data.errors.forEach(err => { msg += '  - ' + err.email + ': ' + err.reason + '\n'; });
        }

        alert(msg);

        textarea.value = '';
        renderUsuarios();
    } catch (e) {
        console.error('[admin] Error in manual import:', e);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:0.85rem;">download</span> Importar emails';
        }
        toast('Error: ' + e.message, 'error');
    }
}

function openUserModal(mode, userId = null) {
    _userModalMode = mode;
    _userEditId = userId;

    const overlay = document.getElementById('user-modal-overlay');
    const titulo = document.getElementById('um-titulo');
    const nombreInput = document.getElementById('um-nombre');
    const emailInput = document.getElementById('um-email');
    const passwordInput = document.getElementById('um-password');
    const passwordGroup = document.getElementById('um-password-group');
    const rolSelect = document.getElementById('um-rol');
    const estadoGroup = document.getElementById('um-estado-group');
    const estadoSelect = document.getElementById('um-estado');
    const btnSave = document.getElementById('um-btn-save');
    const errorDiv = document.getElementById('um-error');

    errorDiv.style.display = 'none';

    if (mode === 'editar' && userId) {
        titulo.textContent = 'Editar Usuario';
        btnSave.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar';
        passwordGroup.style.display = 'none';
        estadoGroup.style.display = 'block';

        const user = allUsuarios.find(u => u.id === userId);
        if (user) {
            nombreInput.value = user.nombre || '';
            emailInput.value = user.email || '';
            rolSelect.value = user.rol || 'FULL';
            estadoSelect.value = String(user.activo !== false);
        }
    } else {
        titulo.textContent = 'Nuevo Usuario';
        btnSave.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;">person_add</span> Crear';
        passwordGroup.style.display = 'block';
        estadoGroup.style.display = 'none';
        nombreInput.value = '';
        emailInput.value = '';
        passwordInput.value = '';
        rolSelect.value = 'FULL';
    }

    overlay.classList.add('active');
    overlay.style.display = 'flex';
}

function closeUserModal() {
    const overlay = document.getElementById('user-modal-overlay');
    if (overlay) {
        overlay.classList.remove('active');
        overlay.style.display = 'none';
    }
    _userModalMode = null;
    _userEditId = null;
}

async function saveUserModal() {
    const nombre = document.getElementById('um-nombre').value.trim();
    const email = document.getElementById('um-email').value.trim();
    const password = document.getElementById('um-password').value;
    const rol = document.getElementById('um-rol').value;
    const activo = document.getElementById('um-estado').value === 'true';
    const errorDiv = document.getElementById('um-error');

    errorDiv.style.display = 'none';

    if (!nombre) {
        errorDiv.textContent = 'El nombre es requerido';
        errorDiv.style.display = 'block';
        return;
    }
    if (!email) {
        errorDiv.textContent = 'El email es requerido';
        errorDiv.style.display = 'block';
        return;
    }
    if (_userModalMode === 'crear' && (!password || password.length < 6)) {
        errorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
        errorDiv.style.display = 'block';
        return;
    }

    if (_userModalMode === 'editar' && _userEditId) {
        showLoading('Guardando...');
        try {
            await updateDoc(doc(db, 'usuarios', _userEditId), {
                nombre: nombre,
                rol: rol,
                activo: activo
            });
            toast('Usuario actualizado', 'success');
            closeUserModal();
            renderUsuarios();
        } catch (e) {
            console.error('[admin] Error updating user:', e);
            errorDiv.textContent = e.message || 'Error al actualizar usuario';
            errorDiv.style.display = 'block';
        } finally {
            hideLoading();
        }
    } else {
        showLoading('Creando usuario...');
        try {
            const createUser = httpsCallable(functions, 'createUser');

            const result = await createUser({
                email: email,
                password: password,
                nombre: nombre,
                rol: rol
            });

            if (result.data?.success) {
                toast('Usuario creado exitosamente', 'success');
                closeUserModal();
                renderUsuarios();
            }
        } catch (e) {
            console.error('[admin] Error creating user:', e);
            let msg = 'Error al crear usuario';
            if (e.code === 'auth/email-already-exists') {
                msg = 'Ya existe un usuario con ese email';
            } else if (e.message) {
                msg = e.message;
            }
            errorDiv.textContent = msg;
            errorDiv.style.display = 'block';
        } finally {
            hideLoading();
        }
    }
}

async function toggleUsuario(uid) {
    const user = allUsuarios.find(u => u.id === uid);
    if (!user) return;

    const newState = !user.activo;
    const action = newState ? 'activar' : 'desactivar';

    if (!confirm('¿' + action.charAt(0).toUpperCase() + action.slice(1) + ' este usuario?\n\n' + user.nombre + '\n' + user.email)) return;

    showLoading(action + '...');
    try {
        await updateDoc(doc(db, 'usuarios', uid), {
            activo: newState
        });
        toast('Usuario ' + action + 'do', 'success');
        renderUsuarios();
    } catch (e) {
        console.error('[admin] Error toggling user:', e);
        toast(e.message || 'Error al ' + action, 'error');
    } finally {
        hideLoading();
    }
}

// Exponer funciones al window
window.openUserModal = openUserModal;
window.closeUserModal = closeUserModal;
window.saveUserModal = saveUserModal;
window.renderUsuarios = renderUsuarios;
window.showSyncPanel = showSyncPanel;
window.importMissingUsers = importMissingUsers;
window.loadMoreSync = loadMoreSync;
window.manualImport = manualImport;

// ── Service Worker Registration ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              if (confirm('Una nueva versión del Torneo de Colores está disponible. ¿Querés recargar?')) {
                newWorker.postMessage({ type: 'SKIP_WAITING' });
                window.location.reload();
              }
            }
          });
        }
      });
    }).catch((error) => {
      console.log('[SW] Registration failed:', error);
    });
  });
}
