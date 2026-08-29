import { auth, db } from './firebase.js';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { collection, getDocs, addDoc, updateDoc, doc, deleteDoc, query, orderBy, writeBatch, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { loadTournamentConfig, col, docRef, docRefAuto, getActiveTournamentId, getActiveTournament, getActiveTournamentIds, setSelectedTournament } from './tournamentRefs.js';
import { renderTournamentPanel, loadTournaments, getTournaments } from './tournament.js';
import { calculateStandings } from './standings.js';
import { CATEGORIAS_JUGADOR } from './categorias.js';

let allJugadores = [];
let jugadorSearchTerm = '';
let allEquipos = [];
let allPartidos = [];
let allJornadas = [];
let dataLoaded = false;

function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function shortName(j) {
    if (!j) return '';
    const firstName = (j.nombre || '').split(' ')[0];
    const firstLast = (j.apellidos || '').split(' ')[0];
    const cat = j.categoria ? ' (' + j.categoria + ')' : '';
    return firstName + ' ' + firstLast + cat;
}

function formatDate(fecha) {
    if (!fecha) return '';
    try {
        const d = fecha.toDate ? fecha.toDate() : new Date(fecha);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR');
    } catch (e) { return ''; }
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

// ── Tab Scroll Indicator ──
function setupTabScroll() {
    document.querySelectorAll('.tab-nav-wrap').forEach(wrap => {
        const nav = wrap.querySelector('.tab-nav');
        const btn = wrap.querySelector('.tab-scroll-btn');
        if (!nav || !btn) return;
        const update = () => {
            const overflow = nav.scrollWidth > nav.clientWidth + nav.scrollLeft + 4;
            btn.classList.toggle('hidden', !overflow);
        };
        btn.addEventListener('click', () => nav.scrollBy({ left: 150, behavior: 'smooth' }));
        nav.addEventListener('scroll', update);
        window.addEventListener('resize', update);
        update();
    });
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
}

function isCurrentUserAdmin(user) {
    return user && currentAdminUids.includes(user.uid);
}

async function initializeAdminPanel(user) {
    if (!isCurrentUserAdmin(user)) {
        toast('No tenés permisos de administrador', 'error');
        await signOut(auth);
        return false;
    }
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('login-container-wrapper').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
    setupTabScroll();
    initTournamentSelector();
    await loadTournamentConfig();
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
    await loadTournaments();
    updateTournamentSelector();
    const initialPanel = location.hash.replace('#', '') || 'jugadores';
    _switchPanel(initialPanel);
    panelLoading(document.getElementById('panel-' + initialPanel), 'Cargando...');
    await loadData();
    dataLoaded = true;
    history.replaceState({ panel: initialPanel }, '', '#' + initialPanel);
    _switchPanel(initialPanel);
    return true;
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

window.addEventListener('popstate', () => {
    const panel = (history.state && history.state.panel) || location.hash.replace('#', '') || 'jugadores';
    _switchPanel(panel);
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
        allJugadores = j.docs.map(d => ({ id: d.id, ...d.data() }));
        allEquipos = e.docs.map(d => ({ id: d.id, ...d.data() }));
        allJornadas = n.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log('[admin] loadData:', allJugadores.length, 'jugadores,', allEquipos.length, 'equipos,', allJornadas.length, 'jornadas');
    } catch (e) { console.error('[admin] loadData error:', e); }
}

async function refreshData() {
    await loadData();
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
        const name = t ? t.name : id;
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
    if (panelId !== 'torneos' && !getActiveTournamentId()) {
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
        '<div class="form-group"><label>Método de Pago *</label><select id="j-metodo-pago"><option value="">— Seleccionar —</option><option>Efectivo</option><option>Pago Móvil</option><option>Punto de Venta</option><option>Otro</option></select></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group"><label>Fecha Operación</label><input type="text" id="j-fecha-pago" placeholder="Ej: 27/8"></div>' +
        '<div class="form-group"><label>Nro Operación</label><input type="text" id="j-numero-operacion" placeholder="Nro de referencia"></div>' +
        '</div>' +
        '<div class="checkbox-group"><input type="checkbox" id="j-pago"><label for="j-pago"><span class="material-symbols-outlined" style="font-size:1rem;color:var(--primary);">payments</span> Pago Recibido</label></div>' +
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
        renderJugadoresList();
    });
    document.getElementById('btn-import-csv').addEventListener('click', () => {
        document.getElementById('csv-file-input').click();
    });
    document.getElementById('csv-file-input').addEventListener('change', handleCSVFile);
    renderJugadoresList();
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
        title.innerHTML = '<span class="material-symbols-outlined" style="font-size:0.9rem;">groups</span> Jugadores Inscritos (' + filtered.length + (term ? ' de ' + allJugadores.length : '') + ')';
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
            if (j.pago_recibido) {
                const metodo = j.metodo_pago || 'Pago';
                let detail = '';
                if (metodo === 'Otro' && (j.numero_operacion || j.fecha_pago)) {
                    detail = ' · Op: ' + esc(j.numero_operacion || '') + (j.fecha_pago ? ' ' + esc(j.fecha_pago) : '');
                }
                pagoBadge = '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">check</span> ' + esc(metodo) + detail + '</span>';
            } else {
                pagoBadge = '<span class="badge badge-danger"><span class="material-symbols-outlined" style="font-size:0.6rem;">close</span> Sin pago</span>';
            }
            return '<div class="player-card">' +
            '<div class="player-main">' +
            '<div class="player-name">' + esc(shortName(j)) + '</div>' +
            '<div class="player-meta">' +
            (j.telefono ? '<span class="material-symbols-outlined" style="font-size:0.75rem;">phone</span> ' + esc(j.telefono) + ' · ' : '') +
            (j.email ? '<span class="material-symbols-outlined" style="font-size:0.75rem;">email</span> ' + esc(j.email) : '') +
            '</div>' +
            '<div style="margin-top:0.25rem;display:flex;flex-wrap:wrap;gap:0.3rem;">' +
            catBadge + statusBadge + teamBadge + pagoBadge +
            '</div>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:0.4rem;">' +
            '<button class="btn btn-sm btn-outline" data-edit-jugador="' + j.id + '"><span class="material-symbols-outlined" style="font-size:0.8rem;">edit</span></button>' +
            '<button class="btn btn-sm btn-danger" data-del-jugador="' + j.id + '"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' +
            '</div>' +
            '</div>';
        }).join('');

    listEl.querySelectorAll('[data-edit-jugador]').forEach(b => b.addEventListener('click', () => editJugador(b.dataset.editJugador)));
    listEl.querySelectorAll('[data-del-jugador]').forEach(b => b.addEventListener('click', () => safeAction(() => deleteJugador(b.dataset.delJugador))));
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
        equipo_id: document.getElementById('j-equipo').value || null,
        numero_socio: document.getElementById('j-numero-socio').value.trim(),
        status_socio: document.getElementById('j-status-socio').value,
        metodo_pago: document.getElementById('j-metodo-pago').value,
        fecha_pago: document.getElementById('j-fecha-pago').value.trim(),
        numero_operacion: document.getElementById('j-numero-operacion').value.trim()
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
        await addDoc(col('jugadores'), data);
        toast('Jugador agregado', 'success');
        await refreshData();
    } catch (e) {
        toast('Error al agregar jugador', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
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
    document.getElementById('j-numero-socio').value = j.numero_socio || '';
    document.getElementById('j-status-socio').value = j.status_socio || '';
    document.getElementById('j-metodo-pago').value = j.metodo_pago || '';
    document.getElementById('j-fecha-pago').value = j.fecha_pago || '';
    document.getElementById('j-numero-operacion').value = j.numero_operacion || '';
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
                equipo_id: document.getElementById('j-equipo').value || null,
                numero_socio: document.getElementById('j-numero-socio').value.trim(),
                status_socio: document.getElementById('j-status-socio').value,
                metodo_pago: document.getElementById('j-metodo-pago').value,
                fecha_pago: document.getElementById('j-fecha-pago').value.trim(),
                numero_operacion: document.getElementById('j-numero-operacion').value.trim()
            };
            await updateDoc(docRef('jugadores', id), update);
            toast('Jugador actualizado', 'success');
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

function handleCSVFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const nameEl = document.getElementById('csv-file-name');
    if (nameEl) nameEl.textContent = file.name;
    const reader = new FileReader();
    reader.onload = (evt) => {
        const text = evt.target.result;
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
            pago: headers.findIndex(h => h.includes('pago') && !h.includes('metodo') && !h.includes('método') && !h.includes('📱') && !h.includes('comprobante')),
            status_socio: headers.findIndex(h => h.includes('status')),
            numero_socio: headers.findIndex(h => h.includes('socio')),
            metodo_pago: headers.findIndex(h => h.includes('metodo') || h.includes('método')),
            numero_operacion: headers.findIndex(h => h.includes('operación') || h.includes('operacion') || h.includes('referencia')),
            fecha_pago: headers.findIndex(h => h.includes('fecha'))
        };
        if (colMap.nombre === -1 || colMap.email === -1) {
            toast('El CSV no tiene las columnas esperadas (Nombre, Correo)', 'error'); return;
        }
        const existingEmails = new Set(allJugadores.map(j => (j.email || '').toLowerCase().trim()));
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i]);
            const email = (cols[colMap.email] || '').toLowerCase().trim();
            if (!email) continue;
            const rawPago = colMap.pago !== -1 ? (cols[colMap.pago] || '').trim().toLowerCase() : '';
            const rawMetodo = colMap.metodo_pago !== -1 ? (cols[colMap.metodo_pago] || '').trim() : '';
            let metodoPago = rawMetodo;
            if (rawMetodo.includes('Pago Móvil') || rawMetodo.includes('pago móvil') || rawMetodo.includes('pago movil')) metodoPago = 'Pago Móvil';
            rows.push({
                nombre: (cols[colMap.nombre] || '').trim(),
                apellidos: (colMap.apellidos !== -1 ? (cols[colMap.apellidos] || '') : '').trim(),
                genero: (colMap.genero !== -1 ? (cols[colMap.genero] || '') : '').trim(),
                categoria: (colMap.categoria !== -1 ? (cols[colMap.categoria] || '') : '').trim(),
                telefono: (colMap.telefono !== -1 ? (cols[colMap.telefono] || '') : '').trim(),
                email: email,
                pago_recibido: rawPago === 'x',
                status_socio: (colMap.status_socio !== -1 ? (cols[colMap.status_socio] || '') : '').trim(),
                numero_socio: (colMap.numero_socio !== -1 ? (cols[colMap.numero_socio] || '') : '').trim(),
                metodo_pago: metodoPago,
                numero_operacion: (colMap.numero_operacion !== -1 ? (cols[colMap.numero_operacion] || '') : '').trim(),
                fecha_pago: (colMap.fecha_pago !== -1 ? (cols[colMap.fecha_pago] || '') : '').trim(),
                _exists: existingEmails.has(email)
            });
        }
        const nuevos = rows.filter(r => !r._exists);
        const existentes = rows.filter(r => r._exists);
        showCSVPreview(rows, nuevos, existentes);
    };
    reader.readAsText(file);
    e.target.value = '';
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
                esc(shortName(j)) + ' — <span style="color:var(--on-surface-variant-30);">' + esc(j.email) + '</span>' +
                '</div>'
            ).join('') + '</div>' : '') +
        '<div class="btn-group-spaced">' +
        (nuevos.length ? '<button class="btn btn-primary" id="btn-confirm-import"><span class="material-symbols-outlined" style="font-size:1rem;">file_upload</span> Importar ' + nuevos.length + ' nuevos</button>' : '') +
        '<button class="btn btn-outline" id="btn-cancel-import"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div>' +
        '</div>';

    if (nuevos.length) {
        document.getElementById('btn-confirm-import').addEventListener('click', () => safeAction(() => confirmCSVImport(nuevos)));
    }
    document.getElementById('btn-cancel-import').addEventListener('click', () => { el.style.display = 'none'; el.innerHTML = ''; });
}

async function confirmCSVImport(nuevos) {
    showLoading('Importando ' + nuevos.length + ' jugadores...');
    try {
        const batch = writeBatch(db);
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
                equipo_id: null,
                numero_socio: j.numero_socio || '',
                status_socio: j.status_socio || '',
                metodo_pago: j.metodo_pago || '',
                fecha_pago: j.fecha_pago || '',
                numero_operacion: j.numero_operacion || ''
            });
        });
        await batch.commit();
        toast(nuevos.length + ' jugadores importados', 'success');
        document.getElementById('csv-preview').style.display = 'none';
        document.getElementById('csv-preview').innerHTML = '';
        document.getElementById('csv-file-name').textContent = '';
        await refreshData();
    } catch (e) {
        toast('Error al importar', 'error');
        console.error(e);
    } finally {
        hideLoading();
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
                    unassignedPlayers.map(j => '<option value="' + j.id + '">' + esc(shortName(j)) + '</option>').join('') +
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
                    '<div class="player-name" style="font-size:0.82rem;">' + esc(shortName(j)) + '</div>' +
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
            '<h3 style="font-size:0.95rem;">Cambiar equipo de ' + esc(shortName(player)) + '</h3>' +
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
// DRAW — 7 PARTIDOS POR ENFRENTAMIENTO
// ═══════════════════════════════════════════
const DRAW_CATEGORIAS = [
    'Masculino Suma 9',
    'Masculino Suma 10',
    'Masculino Suma 12',
    'Masculino 6ta Master',
    'Femenino Suma 10',
    'Femenino Suma 12',
    'Mixto Suma 11'
];

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
        drawPartidos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Error loading draw partidos:', e);
    }
}

function renderDraw() {
    const panel = document.getElementById('panel-draw');

    if (drawSelectedJornadaId) {
        renderDrawDetail(panel);
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
            const localName = getTeamName(j.equipo_local_id) || '?';
            const visitName = getTeamName(j.equipo_visitante_id) || '?';
            return '<option value="' + j.id + '">Jornada ' + j.numero + ' — ' + esc(localName) + ' VS ' + esc(visitName) + '</option>';
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
    const jornada = allJornadas.find(j => j.id === drawSelectedJornadaId);
    if (!jornada) { drawSelectedJornadaId = null; renderDraw(); return; }

    const localName = getTeamName(jornada.equipo_local_id) || jornada.equipo_local_nombre || '?';
    const visitName = getTeamName(jornada.equipo_visitante_id) || jornada.equipo_visitante_nombre || '?';
    const localColor = getTeamColor(jornada.equipo_local_id) || '#888';
    const visitColor = getTeamColor(jornada.equipo_visitante_id) || '#888';

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
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + localColor + ';"></span>' + esc(localName) +
        '</span>' +
        '<span style="font-family:Lexend;font-weight:800;font-size:0.85rem;color:var(--on-surface-variant-40);">VS</span>' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.9rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + visitColor + ';"></span>' + esc(visitName) +
        '</span>' +
        '</div>' +
        '</div>' +
        '<button class="btn btn-sm btn-outline" id="btn-back-draw-jornadas"><span class="material-symbols-outlined" style="font-size:0.8rem;">arrow_back</span></button>' +
        '</div>' +
        '</div>';

    const completeCount = DRAW_CATEGORIAS.filter(cat => drawPartidos.some(p => p.categoria === cat)).length;
    const allComplete = completeCount === 7;

    html += '<div class="card" style="border-left:4px solid ' + (allComplete ? 'var(--secondary)' : 'var(--primary)') + ';">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
        '<div>' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">DRAW</div>' +
        '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">' +
        completeCount + ' / 7 categorías configuradas' +
        '</div>' +
        '</div>' +
        (allComplete
            ? '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">check_circle</span> Completo</span>'
            : '<span class="badge" style="background:var(--primary-container);color:var(--primary);">Incompleto</span>') +
        '</div>' +
        '</div>';

    if (!allComplete) {
        const missing = DRAW_CATEGORIAS.filter(cat => !drawPartidos.some(p => p.categoria === cat));
        html += '<div class="card" style="border-left:4px solid var(--secondary);">' +
            '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);margin-bottom:0.3rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.7rem;">info</span> Pendientes:' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;">' +
            missing.map(cat =>
                '<span class="badge" style="background:var(--primary-container);color:var(--primary);">' + esc(cat) + '</span>'
            ).join('') +
            '</div>' +
            '</div>';
    }

    if (editingPartidoId) {
        html += renderPartidoForm(jornada);
    }

    html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_tennis</span> Partidos</div>';

    const localPlayers = getPlayersInTeam(jornada.equipo_local_id);
    const visitPlayers = getPlayersInTeam(jornada.equipo_visitante_id);

    DRAW_CATEGORIAS.forEach((cat, idx) => {
        const partido = drawPartidos.find(p => p.categoria === cat);
        const num = String(idx + 1).padStart(2, '0');

        if (partido) {
            const j1Name = getJugadorNombre(partido.jugador_local_1_id);
            const j2Name = getJugadorNombre(partido.jugador_local_2_id);
            const j3Name = getJugadorNombre(partido.jugador_visitante_1_id);
            const j4Name = getJugadorNombre(partido.jugador_visitante_2_id);
            const isEmpty = !partido.jugador_local_1_id && !partido.jugador_local_2_id && !partido.jugador_visitante_1_id && !partido.jugador_visitante_2_id;

            html += '<div class="card" style="margin-bottom:0.5rem;">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--primary);margin-bottom:0.3rem;">' + num + ' ' + esc(cat) + '</div>';

            if (isEmpty) {
                html += '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">Sin jugadores asignados</div>';
            } else {
                html += '<div style="display:flex;flex-direction:column;gap:0.25rem;">' +
                    '<div style="font-size:0.78rem;display:flex;align-items:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + localColor + ';"></span>' +
                    '<span style="font-weight:500;">' + esc(j1Name || '—') + '</span>' +
                    '<span style="color:var(--on-surface-variant-40);">/</span>' +
                    '<span style="font-weight:500;">' + esc(j2Name || '—') + '</span>' +
                    '</div>' +
                    '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);text-align:center;font-family:Lexend;font-weight:800;">VS</div>' +
                    '<div style="font-size:0.78rem;display:flex;align-items:center;gap:0.3rem;">' +
                    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + visitColor + ';"></span>' +
                    '<span style="font-weight:500;">' + esc(j3Name || '—') + '</span>' +
                    '<span style="color:var(--on-surface-variant-40);">/</span>' +
                    '<span style="font-weight:500;">' + esc(j4Name || '—') + '</span>' +
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
        } else {
            html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid var(--on-surface-variant-40);">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div>' +
                '<div style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--on-surface-variant-40);">' + num + ' ' + esc(cat) + '</div>' +
                '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">No configurado</div>' +
                '</div>' +
                '<button class="btn btn-sm btn-primary" data-add-partido="' + esc(cat) + '" title="Crear partido"><span class="material-symbols-outlined" style="font-size:0.8rem;">add</span></button>' +
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
                localPlayers.filter(p => p.id !== j1Val).map(p =>
                    '<option value="' + p.id + '"' + (p.id === j2Val ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>'
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
                visitPlayers.filter(p => p.id !== j3Val).map(p =>
                    '<option value="' + p.id + '"' + (p.id === j4Val ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>'
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

    const localPlayers = getPlayersInTeam(jornada.equipo_local_id);
    const visitPlayers = getPlayersInTeam(jornada.equipo_visitante_id);

    const makePlayerOpts = (players, selectedId, excludeId) => {
        return '<option value="">— Seleccionar —</option>' +
            players.filter(p => p.id !== excludeId).map(p =>
                '<option value="' + p.id + '"' + (p.id === selectedId ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>'
            ).join('');
    };

    const j1 = existingPartido?.jugador_local_1_id || '';
    const j2 = existingPartido?.jugador_local_2_id || '';
    const j3 = existingPartido?.jugador_visitante_1_id || '';
    const j4 = existingPartido?.jugador_visitante_2_id || '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">edit</span> ' +
        (newCat ? 'Crear' : 'Editar') + ' — ' + esc(categoria) +
        '</div>';

    if (localPlayers.length < 2) {
        html += '<div class="empty-state" style="padding:1rem;"><p style="font-size:0.8rem;color:var(--error);">El equipo local no tiene suficientes jugadores (' + localPlayers.length + '/2 mínimos).</p></div>';
    }
    if (visitPlayers.length < 2) {
        html += '<div class="empty-state" style="padding:1rem;"><p style="font-size:0.8rem;color:var(--error);">El equipo visitante no tiene suficientes jugadores (' + visitPlayers.length + '/2 mínimos).</p></div>';
    }

    html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (getTeamColor(jornada.equipo_local_id) || '#888') + ';"></span> ' +
        esc(getTeamName(jornada.equipo_local_id)) +
        '</div>' +
        '<div class="form-group"><label>Jugador 1</label><select id="dp-j1" data-team="local" data-slot="1">' +
        makePlayerOpts(localPlayers, j1, j2) +
        '</select></div>' +
        '<div class="form-group"><label>Jugador 2</label><select id="dp-j2" data-team="local" data-slot="2">' +
        makePlayerOpts(localPlayers, j2, j1) +
        '</select></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;padding-bottom:1.5rem;font-family:Lexend;font-weight:800;font-size:0.8rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (getTeamColor(jornada.equipo_visitante_id) || '#888') + ';"></span> ' +
        esc(getTeamName(jornada.equipo_visitante_id)) +
        '</div>' +
        '<div class="form-group"><label>Jugador 3</label><select id="dp-j3" data-team="visitante" data-slot="3">' +
        makePlayerOpts(visitPlayers, j3, j4) +
        '</select></div>' +
        '<div class="form-group"><label>Jugador 4</label><select id="dp-j4" data-team="visitante" data-slot="4">' +
        makePlayerOpts(visitPlayers, j4, j3) +
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
    if (!j1) { toast('Seleccioná Jugador 1 del equipo local', 'error'); return; }
    if (!j2) { toast('Seleccioná Jugador 2 del equipo local', 'error'); return; }
    if (!j3) { toast('Seleccioná Jugador 1 del equipo visitante', 'error'); return; }
    if (!j4) { toast('Seleccioná Jugador 2 del equipo visitante', 'error'); return; }
    if (j1 === j2) { toast('Los jugadores del equipo local no pueden ser iguales', 'error'); return; }
    if (j3 === j4) { toast('Los jugadores del equipo visitante no pueden ser iguales', 'error'); return; }

    const j1Data = allJugadores.find(j => j.id === j1);
    const j2Data = allJugadores.find(j => j.id === j2);
    const j3Data = allJugadores.find(j => j.id === j3);
    const j4Data = allJugadores.find(j => j.id === j4);

    if (j1Data && j1Data.equipo_id !== jornada.equipo_local_id) { toast('Jugador 1 local no pertenece al equipo local', 'error'); return; }
    if (j2Data && j2Data.equipo_id !== jornada.equipo_local_id) { toast('Jugador 2 local no pertenece al equipo local', 'error'); return; }
    if (j3Data && j3Data.equipo_id !== jornada.equipo_visitante_id) { toast('Jugador 1 visitante no pertenece al equipo visitante', 'error'); return; }
    if (j4Data && j4Data.equipo_id !== jornada.equipo_visitante_id) { toast('Jugador 2 visitante no pertenece al equipo visitante', 'error'); return; }

    if (newCat) {
        const existing = drawPartidos.find(p => p.categoria === categoria);
        if (existing) { toast('Ya existe un partido para ' + categoria, 'error'); return; }
    }

    const data = {
        categoria,
        equipo_local_id: jornada.equipo_local_id,
        equipo_visitante_id: jornada.equipo_visitante_id,
        equipo_local_nombre: getTeamName(jornada.equipo_local_id),
        equipo_visitante_nombre: getTeamName(jornada.equipo_visitante_id),
        jugador_local_1_id: j1,
        jugador_local_2_id: j2,
        jugador_visitante_1_id: j3,
        jugador_visitante_2_id: j4,
        jugador_local_1_nombre: getJugadorNombre(j1),
        jugador_local_2_nombre: getJugadorNombre(j2),
        jugador_visitante_1_nombre: getJugadorNombre(j3),
        jugador_visitante_2_nombre: getJugadorNombre(j4),
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
    if (!confirm('¿Eliminar el partido "' + partido.categoria + '"?')) return;

    showLoading('Eliminando partido...');
    try {
        await deleteDoc(partidoDocRef(drawSelectedJornadaId, partidoId));
        toast('Partido eliminado', 'success');
        drawPartidos = [];
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
let editingResultadoId = null;


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

function isValidSetScore(local, vis) {
    if (local < 0 || vis < 0) return false;
    const max = Math.max(local, vis);
    const min = Math.min(local, vis);
    // 4-0, 4-1, 4-2
    if (max === 4 && min <= 2) return true;
    // 5-3 or 3-5 (extended from 3-3, win by 2)
    if ((max === 5 && min === 3) || (max === 3 && min === 5)) return true;
    // 4-4 (Tie Break - validated separately)
    if (max === 4 && min === 4) return true;
    return false;
}

function isTiebreakSet(local, vis) {
    return local === 4 && vis === 4;
}

function isValidSupertiebreak(local, vis) {
    if (local < 0 || vis < 0) return false;
    const max = Math.max(local, vis);
    const min = Math.min(local, vis);
    if (max < 10) return false;
    if (max - min < 2) return false;
    return true;
}

function validateMatchScore(s1Local, s1Vis, s2Local, s2Vis, tb1Local, tb1Vis, tb2Local, tb2Vis, stbLocal, stbVis) {
    const e = (msg) => { toast(msg, 'error'); return false; };

    if (s1Local === '' || s1Vis === '' || s2Local === '' || s2Vis === '') {
        return e('Completá ambos sets');
    }
    const s1l = parseInt(s1Local), s1v = parseInt(s1Vis);
    const s2l = parseInt(s2Local), s2v = parseInt(s2Vis);

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
        if (tb1Local === '' || tb1Vis === '' || tb1Local === undefined || tb1Vis === undefined) {
            return e('Set 1 es 4-4: se requiere Tie Break');
        }
        const tb1l = parseInt(tb1Local), tb1v = parseInt(tb1Vis);
        if (isNaN(tb1l) || isNaN(tb1v)) return e('Tie Break 1: valores inválidos');
        if (tb1l < 0 || tb1v < 0) return e('Tie Break 1: valores negativos');
        if (tb1l < 7 && tb1v < 7) return e('Tie Break 1: mínimo 7 puntos');
        if (Math.abs(tb1l - tb1v) < 2) return e('Tie Break 1: diferencia mínima de 2 puntos');
    }

    if (set2TB) {
        if (tb2Local === '' || tb2Vis === '' || tb2Local === undefined || tb2Vis === undefined) {
            return e('Set 2 es 4-4: se requiere Tie Break');
        }
        const tb2l = parseInt(tb2Local), tb2v = parseInt(tb2Vis);
        if (isNaN(tb2l) || isNaN(tb2v)) return e('Tie Break 2: valores inválidos');
        if (tb2l < 0 || tb2v < 0) return e('Tie Break 2: valores negativos');
        if (tb2l < 7 && tb2v < 7) return e('Tie Break 2: mínimo 7 puntos');
        if (Math.abs(tb2l - tb2v) < 2) return e('Tie Break 2: diferencia mínima de 2 puntos');
    }

    const setsLocal = (determineSetWinner(s1l, s1v, parseInt(tb1Local), parseInt(tb1Vis)) === 'local' ? 1 : 0) +
                      (determineSetWinner(s2l, s2v, parseInt(tb2Local), parseInt(tb2Vis)) === 'local' ? 1 : 0);
    const setsVis = (determineSetWinner(s1l, s1v, parseInt(tb1Local), parseInt(tb1Vis)) === 'visitante' ? 1 : 0) +
                    (determineSetWinner(s2l, s2v, parseInt(tb2Local), parseInt(tb2Vis)) === 'visitante' ? 1 : 0);

    if (setsLocal === 2 || setsVis === 2) {
        if (stbLocal !== '' && stbVis !== '' && stbLocal !== undefined && stbVis !== undefined) {
            return e('No debe haber Super Tie Break si un equipo ganó 2-0');
        }
        return true;
    }

    if (setsLocal === 1 && setsVis === 1) {
        if (stbLocal === '' || stbVis === '' || stbLocal === undefined || stbVis === undefined) {
            return e('Se requiere Super Tie Break (sets 1-1)');
        }
        const stbl = parseInt(stbLocal), stbv = parseInt(stbVis);
        if (isNaN(stbl) || isNaN(stbv)) return e('Super Tie Break: valores inválidos');
        if (stbl < 0 || stbv < 0) return e('Super Tie Break: valores negativos');
        if (!isValidSupertiebreak(stbl, stbv)) {
            return e('Super Tie Break inválido. Se necesita ventaja de 2 puntos (mínimo 10-8)');
        }
        return true;
    }

    return true;
}

function determineSetWinner(setLocal, setVis, tbLocal, tbVis) {
    if (isTiebreakSet(setLocal, setVis)) {
        if (!isNaN(tbLocal) && !isNaN(tbVis)) {
            if (tbLocal > tbVis) return 'local';
            if (tbVis > tbLocal) return 'visitante';
        }
        return null;
    }
    if (setLocal > setVis) return 'local';
    if (setVis > setLocal) return 'visitante';
    return null;
}

function determineMatchWinner(s1Local, s1Vis, s2Local, s2Vis, tb1Local, tb1Vis, tb2Local, tb2Vis, stbLocal, stbVis) {
    const s1l = parseInt(s1Local), s1v = parseInt(s1Vis);
    const s2l = parseInt(s2Local), s2v = parseInt(s2Vis);

    const set1Winner = determineSetWinner(s1l, s1v, parseInt(tb1Local), parseInt(tb1Vis));
    const set2Winner = determineSetWinner(s2l, s2v, parseInt(tb2Local), parseInt(tb2Vis));

    let setsLocal = 0, setsVis = 0;
    if (set1Winner === 'local') setsLocal++;
    if (set1Winner === 'visitante') setsVis++;
    if (set2Winner === 'local') setsLocal++;
    if (set2Winner === 'visitante') setsVis++;

    if (setsLocal === 2) return 'local';
    if (setsVis === 2) return 'visitante';

    if (!isNaN(stbLocal) && !isNaN(stbVis)) {
        if (stbLocal > stbVis) return 'local';
        if (stbVis > stbLocal) return 'visitante';
    }
    return null;
}

function calculateGames(s1Local, s1Vis, s2Local, s2Vis, tb1Local, tb1Vis, tb2Local, tb2Vis, stbLocal, stbVis) {
    const s1l = parseInt(s1Local) || 0, s1v = parseInt(s1Vis) || 0;
    const s2l = parseInt(s2Local) || 0, s2v = parseInt(s2Vis) || 0;
    const tb1l = parseInt(tb1Local) || 0, tb1v = parseInt(tb1Vis) || 0;
    const tb2l = parseInt(tb2Local) || 0, tb2v = parseInt(tb2Vis) || 0;
    const stbl = parseInt(stbLocal) || 0, stbv = parseInt(stbVis) || 0;
    return {
        games_local: s1l + s2l + tb1l + tb2l,
        games_visitante: s1v + s2v + tb1v + tb2v,
        stb_local: stbl,
        stb_visitante: stbv
    };
}

// ── Firestore Helpers ──
function resPartidoCol(jornadaId) {
    return collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId, 'partidos');
}

function resPartidoDocRef(jornadaId, partidoId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'jornadas', jornadaId, 'partidos', partidoId);
}

function equipoRef(equipoId) {
    return doc(db, 'torneos', getActiveTournamentId(), 'equipos', equipoId);
}

async function loadResPartidos(jornadaId) {
    resPartidos = [];
    if (!jornadaId) return;
    try {
        const snap = await getDocs(resPartidoCol(jornadaId));
        resPartidos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Error loading res partidos:', e);
    }
}

// ── Points Application ──
// NOTE: calculateStandings() is the single source of truth for all stats
// applyMatchPoints only marks the partido to prevent duplicate processing
async function applyMatchPoints(jornadaId, partidoId) {
    const partido = resPartidos.find(p => p.id === partidoId);
    if (!partido || partido.estado !== 'finalizado') return;
    await updateDoc(resPartidoDocRef(jornadaId, partidoId), { puntos_aplicados: true });
}

// ── Save Resultado ──
async function saveResultado() {
    const jornadaId = resSelectedJornadaId;
    const partidoId = editingResultadoId;
    if (!jornadaId || !partidoId) return;

    const s1Local = document.getElementById('res-s1-local')?.value ?? '';
    const s1Vis = document.getElementById('res-s1-vis')?.value ?? '';
    const s2Local = document.getElementById('res-s2-local')?.value ?? '';
    const s2Vis = document.getElementById('res-s2-vis')?.value ?? '';
    const tb1Local = document.getElementById('res-tb1-local')?.value ?? '';
    const tb1Vis = document.getElementById('res-tb1-vis')?.value ?? '';
    const tb2Local = document.getElementById('res-tb2-local')?.value ?? '';
    const tb2Vis = document.getElementById('res-tb2-vis')?.value ?? '';
    const stbLocal = document.getElementById('res-stb-local')?.value ?? '';
    const stbVis = document.getElementById('res-stb-vis')?.value ?? '';

    if (!validateMatchScore(s1Local, s1Vis, s2Local, s2Vis, tb1Local, tb1Vis, tb2Local, tb2Vis, stbLocal, stbVis)) return;

    const s1l = parseInt(s1Local), s1v = parseInt(s1Vis);
    const s2l = parseInt(s2Local), s2v = parseInt(s2Vis);
    const tb1l = tb1Local !== '' ? parseInt(tb1Local) : null;
    const tb1v = tb1Vis !== '' ? parseInt(tb1Vis) : null;
    const tb2l = tb2Local !== '' ? parseInt(tb2Local) : null;
    const tb2v = tb2Vis !== '' ? parseInt(tb2Vis) : null;
    const stbl = stbLocal !== '' ? parseInt(stbLocal) : null;
    const stbv = stbVis !== '' ? parseInt(stbVis) : null;

    const ganador = determineMatchWinner(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);
    const games = calculateGames(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);

    const partido = resPartidos.find(p => p.id === partidoId);
    const ganadorEquipoId = ganador === 'local' ? partido?.equipo_local_id :
                            ganador === 'visitante' ? partido?.equipo_visitante_id : null;

    showLoading('Guardando resultado...');
    try {
        await updateDoc(resPartidoDocRef(jornadaId, partidoId), {
            set1_local: s1l,
            set1_visitante: s1v,
            set2_local: s2l,
            set2_visitante: s2v,
            tiebreak1_local: tb1l,
            tiebreak1_visitante: tb1v,
            tiebreak2_local: tb2l,
            tiebreak2_visitante: tb2v,
            supertiebreak_local: stbl,
            supertiebreak_visitante: stbv,
            ganador_equipo_id: ganadorEquipoId,
            estado: 'finalizado',
            games_local: games.games_local,
            games_visitante: games.games_visitante,
            fecha_resultado: new Date(),
            puntos_aplicados: false
        });

        toast('Resultado guardado', 'success');
        await loadResPartidos(jornadaId);
        await applyMatchPoints(jornadaId, partidoId);
        editingResultadoId = null;
        renderResultados();
    } catch (e) {
        toast('Error al guardar resultado', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ── Clear Resultado ──
async function clearResultado() {
    const jornadaId = resSelectedJornadaId;
    const partidoId = editingResultadoId;
    if (!jornadaId || !partidoId) return;

    const partido = resPartidos.find(p => p.id === partidoId);
    if (!partido || partido.estado !== 'finalizado') return;

    if (!confirm('¿Limpiar este resultado?')) return;

    showLoading('Limpiando resultado...');
    try {
        await updateDoc(resPartidoDocRef(jornadaId, partidoId), {
            set1_local: null,
            set1_visitante: null,
            set2_local: null,
            set2_visitante: null,
            tiebreak1_local: null,
            tiebreak1_visitante: null,
            tiebreak2_local: null,
            tiebreak2_visitante: null,
            supertiebreak_local: null,
            supertiebreak_visitante: null,
            ganador_equipo_id: null,
            estado: 'pendiente',
            games_local: 0,
            games_visitante: 0,
            fecha_resultado: null,
            puntos_aplicados: false
        });

        toast('Resultado limpiado', 'success');
        editingResultadoId = null;
        await loadResPartidos(jornadaId);
        renderResultados();
    } catch (e) {
        toast('Error al limpiar resultado', 'error');
        console.error(e);
    } finally {
        hideLoading();
    }
}

// ── Render Resultados ──
function renderResultados() {
    const panel = document.getElementById('panel-resultados');

    if (resSelectedJornadaId) {
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
            const localName = getTeamName(j.equipo_local_id) || '?';
            const visitName = getTeamName(j.equipo_visitante_id) || '?';
            return '<option value="' + j.id + '">Jornada ' + j.numero + ' — ' + esc(localName) + ' VS ' + esc(visitName) + '</option>';
        }).join('') +
        '</select></div>' +
        '</div>';

    if (!allJornadas.length) {
        html += '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">calendar_today</span><p>No hay jornadas creadas.<br>Creá jornadas desde el módulo Jornadas.</p></div>';
    }

    panel.innerHTML = html;

    document.getElementById('res-jornada-select')?.addEventListener('change', (e) => {
        resSelectedJornadaId = e.target.value || null;
        editingResultadoId = null;
        if (resSelectedJornadaId) renderResultados();
    });
}

async function renderResDetail(panel) {
    const jornada = allJornadas.find(j => j.id === resSelectedJornadaId);
    if (!jornada) { resSelectedJornadaId = null; renderResultados(); return; }

    const localName = getTeamName(jornada.equipo_local_id) || jornada.equipo_local_nombre || '?';
    const visitName = getTeamName(jornada.equipo_visitante_id) || jornada.equipo_visitante_nombre || '?';
    const localColor = getTeamColor(jornada.equipo_local_id) || '#888';
    const visitColor = getTeamColor(jornada.equipo_visitante_id) || '#888';

    if (!resPartidos.length || resPartidos[0]?._resJornadaId !== resSelectedJornadaId) {
        await loadResPartidos(resSelectedJornadaId);
        resPartidos.forEach(p => p._resJornadaId = resSelectedJornadaId);
    }

    let html = '';

    html += '<div class="card" style="border-top:3px solid var(--primary);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">' +
        '<div>' +
        '<div style="font-family:Lexend;font-weight:600;font-size:1rem;"><span class="material-symbols-outlined" style="font-size:1rem;color:var(--primary);vertical-align:middle;">sports_score</span> RESULTADOS — Jornada ' + esc(String(jornada.numero || '')) + '</div>' +
        '<div style="font-size:0.82rem;color:var(--on-surface-variant-40);margin-top:0.15rem;">' + esc(getJornadaDateFormatted(jornada.fecha)) + '</div>' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.3rem;flex-wrap:wrap;">' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.9rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + localColor + ';"></span>' + esc(localName) +
        '</span>' +
        '<span style="font-family:Lexend;font-weight:800;font-size:0.85rem;color:var(--on-surface-variant-40);">VS</span>' +
        '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.9rem;">' +
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + visitColor + ';"></span>' + esc(visitName) +
        '</span>' +
        '</div>' +
        '</div>' +
        '<button class="btn btn-sm btn-outline" id="btn-back-res-jornadas"><span class="material-symbols-outlined" style="font-size:0.8rem;">arrow_back</span></button>' +
        '</div>' +
        '</div>';

    let localWins = 0, visWins = 0;
    const finalizados = resPartidos.filter(p => p.estado === 'finalizado');
    finalizados.forEach(p => {
        if (p.ganador_equipo_id === jornada.equipo_local_id) localWins++;
        else if (p.ganador_equipo_id === jornada.equipo_visitante_id) visWins++;
    });

    const allDone = resPartidos.length === 7 && resPartidos.every(p => p.estado === 'finalizado');

    html += '<div class="card" style="border-left:4px solid ' + (allDone ? 'var(--secondary)' : 'var(--primary)') + ';">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;">Resumen de la Jornada</div>' +
        (allDone
            ? '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">check_circle</span> Completo</span>'
            : '<span class="badge" style="background:var(--primary-container);color:var(--primary);">' + finalizados.length + '/7 finalizados</span>') +
        '</div>' +
        '<div style="display:flex;gap:1rem;">' +
        '<div style="flex:1;">' +
        '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + localColor + ';"></span> ' + esc(localName) +
        '</div>' +
        '<div style="font-size:0.82rem;">Partidos: <strong>' + localWins + '</strong></div>' +
        '</div>' +
        '<div style="flex:1;">' +
        '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + visitColor + ';"></span> ' + esc(visitName) +
        '</div>' +
        '<div style="font-size:0.82rem;">Partidos: <strong>' + visWins + '</strong></div>' +
        '</div>' +
        '</div>';

    if (allDone) {
        const jornadaGanador = localWins > visWins ? localName : (visWins > localWins ? visitName : 'Empate');
        const ptsLocal = localWins + (localWins > visWins ? 5 : 0);
        const ptsVis = visWins + (visWins > localWins ? 5 : 0);
        html += '<div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--white-5);">' +
            '<div style="font-size:0.78rem;color:var(--secondary);font-weight:600;">' +
            '🏆 Ganador de la jornada: ' + esc(jornadaGanador) +
            '</div>' +
            '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-top:0.2rem;">' +
            esc(localName) + ': ' + localWins + ' + ' + (localWins > visWins ? '5' : '0') + ' = <strong>' + ptsLocal + '</strong> pts · ' +
            esc(visitName) + ': ' + visWins + ' + ' + (visWins > localWins ? '5' : '0') + ' = <strong>' + ptsVis + '</strong> pts' +
            '</div>' +
            '</div>';
    }

    html += '</div>';

    if (editingResultadoId) {
        html += renderResultadoForm(jornada);
    }

    html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_tennis</span> Partidos</div>';

    DRAW_CATEGORIAS.forEach((cat, idx) => {
        const partido = resPartidos.find(p => p.categoria === cat);
        if (!partido) return;

        const num = String(idx + 1).padStart(2, '0');
        const isFinalizado = partido.estado === 'finalizado';

        const j1Name = getJugadorNombre(partido.jugador_local_1_id);
        const j2Name = getJugadorNombre(partido.jugador_local_2_id);
        const j3Name = getJugadorNombre(partido.jugador_visitante_1_id);
        const j4Name = getJugadorNombre(partido.jugador_visitante_2_id);

        const borderColor = isFinalizado ? (partido.ganador_equipo_id === jornada.equipo_local_id ? localColor : visitColor) : 'var(--on-surface-variant-40)';

        html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid ' + borderColor + ';">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
            '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--primary);">' + num + ' ' + esc(cat) + '</span>' +
            (isFinalizado
                ? '<span class="badge badge-success" style="font-size:0.6rem;">✓ FINALIZADO</span>'
                : '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);font-size:0.6rem;">PENDIENTE</span>') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:0.2rem;font-size:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.3rem;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + localColor + ';"></span>' +
            '<span>' + esc(j1Name || '—') + ' / ' + esc(j2Name || '—') + '</span>' +
            '</div>' +
            '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);text-align:center;font-family:Lexend;font-weight:800;">VS</div>' +
            '<div style="display:flex;align-items:center;gap:0.3rem;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + visitColor + ';"></span>' +
            '<span>' + esc(j3Name || '—') + ' / ' + esc(j4Name || '—') + '</span>' +
            '</div>' +
            '</div>';

        if (isFinalizado) {
            const s1 = partido.set1_local + '-' + partido.set1_visitante;
            const s2 = partido.set2_local + '-' + partido.set2_visitante;
            const tb1 = (partido.tiebreak1_local != null && partido.tiebreak1_visitante != null) ? ' · TB1 ' + partido.tiebreak1_local + '-' + partido.tiebreak1_visitante : '';
            const tb2 = (partido.tiebreak2_local != null && partido.tiebreak2_visitante != null) ? ' · TB2 ' + partido.tiebreak2_local + '-' + partido.tiebreak2_visitante : '';
            const hasSTB = partido.supertiebreak_local != null && partido.supertiebreak_visitante != null;
            const stb = hasSTB ? ' · STB ' + partido.supertiebreak_local + '-' + partido.supertiebreak_visitante : '';
            const ganadorName = partido.ganador_equipo_id === jornada.equipo_local_id ? localName : visitName;
            html += '<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--on-surface-variant-40);">' +
                '<span style="font-weight:600;">' + s1 + '</span> · <span style="font-weight:600;">' + s2 + '</span>' + esc(tb1) + esc(tb2) + esc(stb) +
                ' · <span style="color:var(--secondary);">🏆 ' + esc(ganadorName) + '</span>' +
                '</div>';
        }

        html += '</div>' +
            '<div style="display:flex;gap:0.3rem;">' +
            '<button class="btn btn-sm btn-outline" data-res-edit="' + partido.id + '" title="Ingresar/editar resultado"><span class="material-symbols-outlined" style="font-size:0.8rem;">' + (isFinalizado ? 'edit' : 'sports_score') + '</span></button>' +
            (isFinalizado ? '<button class="btn btn-sm btn-danger" data-res-clear="' + partido.id + '" title="Limpiar resultado"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' : '') +
            '</div>' +
            '</div>' +
            '</div>';
    });

    panel.innerHTML = html;

    document.getElementById('btn-back-res-jornadas')?.addEventListener('click', () => {
        resSelectedJornadaId = null;
        resPartidos = [];
        editingResultadoId = null;
        renderResultados();
    });

    panel.querySelectorAll('[data-res-edit]').forEach(b => b.addEventListener('click', () => {
        editingResultadoId = b.dataset.resEdit;
        renderResultados();
    }));

    panel.querySelectorAll('[data-res-clear]').forEach(b => b.addEventListener('click', () => safeAction(() => {
        editingResultadoId = b.dataset.resClear;
        clearResultado();
    })));

    document.getElementById('btn-save-resultado')?.addEventListener('click', () => safeAction(saveResultado));
    document.getElementById('btn-cancel-resultado')?.addEventListener('click', () => { editingResultadoId = null; renderResultados(); });
}

function renderResultadoForm(jornada) {
    const partido = resPartidos.find(p => p.id === editingResultadoId);
    if (!partido) return '';

    const isFinalizado = partido.estado === 'finalizado';
    const s1l = isFinalizado && partido.set1_local != null ? partido.set1_local : '';
    const s1v = isFinalizado && partido.set1_visitante != null ? partido.set1_visitante : '';
    const s2l = isFinalizado && partido.set2_local != null ? partido.set2_local : '';
    const s2v = isFinalizado && partido.set2_visitante != null ? partido.set2_visitante : '';
    const tb1l = isFinalizado && partido.tiebreak1_local != null ? partido.tiebreak1_local : '';
    const tb1v = isFinalizado && partido.tiebreak1_visitante != null ? partido.tiebreak1_visitante : '';
    const tb2l = isFinalizado && partido.tiebreak2_local != null ? partido.tiebreak2_local : '';
    const tb2v = isFinalizado && partido.tiebreak2_visitante != null ? partido.tiebreak2_visitante : '';
    const stbl = isFinalizado && partido.supertiebreak_local != null ? partido.supertiebreak_local : '';
    const stbv = isFinalizado && partido.supertiebreak_visitante != null ? partido.supertiebreak_visitante : '';

    const localName = getTeamName(jornada.equipo_local_id) || '?';
    const visitName = getTeamName(jornada.equipo_visitante_id) || '?';
    const localColor = getTeamColor(jornada.equipo_local_id) || '#888';
    const visitColor = getTeamColor(jornada.equipo_visitante_id) || '#888';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">sports_score</span> ' +
        (isFinalizado ? 'Editar' : 'Ingresar') + ' Resultado — ' + esc(partido.categoria || '') +
        '</div>';

    // Set 1
    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 1</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;">' +
        '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + localColor + ';"></span> ' + esc(localName) + '</div>' +
        '<input type="number" id="res-s1-local" min="0" max="7" value="' + s1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;">' +
        '</div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;">' +
        '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + visitColor + ';"></span> ' + esc(visitName) + '</div>' +
        '<input type="number" id="res-s1-vis" min="0" max="7" value="' + s1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;">' +
        '</div>' +
        '</div>';

    // Tie Break 1 (only if 4-4)
    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 1 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.75rem;">' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-tb1-local" min="0" max="15" value="' + tb1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—">' +
        '</div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-tb1-vis" min="0" max="15" value="' + tb1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—">' +
        '</div>' +
        '</div>';

    // Set 2
    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 2</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-s2-local" min="0" max="7" value="' + s2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;">' +
        '</div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-s2-vis" min="0" max="7" value="' + s2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;">' +
        '</div>' +
        '</div>';

    // Tie Break 2 (only if 4-4)
    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 2 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.75rem;">' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-tb2-local" min="0" max="15" value="' + tb2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—">' +
        '</div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-tb2-vis" min="0" max="15" value="' + tb2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—">' +
        '</div>' +
        '</div>';

    // Super Tie Break (shown always but validated only when sets 1-1)
    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SUPER TIE BREAK <span style="font-weight:400;font-size:0.65rem;">(solo si sets 1-1)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.75rem;">' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-stb-local" min="0" max="20" value="' + stbl + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—">' +
        '</div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;">' +
        '<input type="number" id="res-stb-vis" min="0" max="20" value="' + stbv + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—">' +
        '</div>' +
        '</div>';

    html += '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar Resultado</button>' +
        '<button class="btn btn-outline" id="btn-cancel-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div>' +
        '</div>';

    return html;
}

// ═══════════════════════════════════════════
// POSICIONES
// ═══════════════════════════════════════════
let allEnfrentamientosData = [];

async function loadAllEnfrentamientosAndPartidos() {
    allEnfrentamientosData = [];
    if (!getActiveTournamentId()) return;
    try {
        for (const jornada of allJornadas) {
            const partSnap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornada.id, 'partidos'));
            const partidos = partSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            allEnfrentamientosData.push({
                id: jornada.id,
                equipo_local_id: jornada.equipo_local_id,
                equipo_visitante_id: jornada.equipo_visitante_id,
                _jornadaId: jornada.id,
                _jornadaNumero: jornada.numero,
                partidos
            });
        }
    } catch (e) {
        console.error('Error loading jornadas for standings:', e);
    }
}

function renderPosiciones() {
    const panel = document.getElementById('panel-posiciones');
    panelLoading(panel, 'Calculando posiciones...');

    loadAllEnfrentamientosAndPartidos().then(() => {
        const result = calculateStandings(allEquipos, allEnfrentamientosData);
        const { standings, roundStatus, totalEnfrentamientos, completedEnfrentamientos } = result;
        const allComplete = roundStatus === 'finalizado';

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

        if (!standings.length) {
            html += '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">leaderboard</span><p>No hay equipos configurados.<br>Creá equipos desde el módulo Equipos.</p></div>';
            panel.innerHTML = html;
            return;
        }

        // Standings table (mobile-friendly cards)
        standings.forEach((s, i) => {
            const isQualified = i < 4;
            const qualBorder = isQualified ? 'border-left:4px solid ' + s.color + ';' : 'border-left:4px solid var(--white-8);';
            const qualBg = isQualified ? 'background:rgba(255,255,255,0.03);' : '';

            html += '<div class="card" style="' + qualBorder + qualBg + 'margin-bottom:0.5rem;">' +
                '<div style="display:flex;align-items:flex-start;justify-content:space-between;">' +
                '<div style="display:flex;align-items:center;gap:0.6rem;">' +
                '<div style="min-width:1.8rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:800;font-size:1.1rem;color:' + (isQualified ? s.color : 'var(--on-surface-variant-40)') + ';">' + s.posicion + 'º</div>' +
                '</div>' +
                '<div>' +
                '<div style="display:flex;align-items:center;gap:0.3rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + s.color + ';"></span>' +
                '<span style="font-family:Lexend;font-weight:600;font-size:0.88rem;">' + esc(s.nombre) + '</span>' +
                '</div>' +
                (isQualified ? '<div style="font-size:0.65rem;color:var(--secondary);font-weight:600;margin-top:0.1rem;"><span class="material-symbols-outlined" style="font-size:0.6rem;vertical-align:middle;">emoji_events</span> CLASIFICADO</div>' : '<div style="font-size:0.65rem;color:var(--on-surface-variant-40);margin-top:0.1rem;">Sin clasificación</div>') +
                '</div>' +
                '</div>' +
                '<div style="text-align:right;">' +
                '<div style="font-family:Lexend;font-weight:800;font-size:1.2rem;color:var(--primary);">' + s.puntos + '</div>' +
                '<div style="font-size:0.62rem;color:var(--on-surface-variant-40);text-transform:uppercase;letter-spacing:0.5px;">PUNTOS</div>' +
                '</div>' +
                '</div>' +
                '<div style="display:flex;gap:0.6rem;margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--white-5);flex-wrap:wrap;">' +
                '<div style="flex:1;min-width:3rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.85rem;">' + s.jornadas_disputadas + '</div>' +
                '<div style="font-size:0.6rem;color:var(--on-surface-variant-40);">PJ</div>' +
                '</div>' +
                '<div style="flex:1;min-width:3rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.85rem;">' + s.jornadas_ganadas + '</div>' +
                '<div style="font-size:0.6rem;color:var(--on-surface-variant-40);">PG</div>' +
                '</div>' +
                '<div style="flex:1;min-width:3rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.85rem;">' + s.partidos_ganados + '</div>' +
                '<div style="font-size:0.6rem;color:var(--on-surface-variant-40);">PARTIDOS</div>' +
                '</div>' +
                '<div style="flex:1;min-width:3rem;text-align:center;">' +
                '<div style="font-family:Lexend;font-weight:700;font-size:0.85rem;">' + s.juegos_ganados + '</div>' +
                '<div style="font-size:0.6rem;color:var(--on-surface-variant-40);">JG</div>' +
                '</div>' +
                '</div>' +
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

        html += '<div style="font-size:0.65rem;color:var(--on-surface-variant-40);text-align:center;margin-top:0.75rem;">' +
            'PJ = Jornadas Disputadas · PG = Jornadas Ganadas · PARTIDOS = Partidos Ganados · JG = Juegos Ganados' +
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
        '<button class="collapse-toggle" id="j-toggle-form" type="button" aria-expanded="' + (isEditing ? 'true' : 'false') + '">' +
        '<span class="collapse-toggle-left"><span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">calendar_today</span> ' + (isEditing ? 'Editar Jornada' : 'Nueva Jornada') + '</span>' +
        '<span class="material-symbols-outlined chevron">' + (isEditing ? 'expand_less' : 'expand_more') + '</span>' +
        '</button>' +
        '<div id="j-form-body" style="display:' + (isEditing ? 'block' : 'none') + ';">' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1;"><label>Fecha</label><input type="date" id="j-fecha" value="' + (jEdit && jEdit.fecha ? (jEdit.fecha.toDate ? jEdit.fecha.toDate().toISOString().split('T')[0] : new Date(jEdit.fecha).toISOString().split('T')[0]) : '') + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group" style="flex:1;"><label>Equipo Local</label>' +
        '<select id="j-equipo-local">' +
        '<option value="">— Seleccionar —</option>' +
        activeTeams.map(eq => '<option value="' + eq.id + '"' + (jEdit && jEdit.equipo_local_id === eq.id ? ' selected' : '') + '>' + esc(eq.nombre) + '</option>').join('') +
        '</select></div>' +
        '<div style="display:flex;align-items:end;padding-bottom:0.4rem;font-family:Lexend;font-weight:600;font-size:0.9rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div class="form-group" style="flex:1;"><label>Equipo Visitante</label>' +
        '<select id="j-equipo-visitante">' +
        '<option value="">— Seleccionar —</option>' +
        activeTeams.map(eq => '<option value="' + eq.id + '"' + (jEdit && jEdit.equipo_visitante_id === eq.id ? ' selected' : '') + '>' + esc(eq.nombre) + '</option>').join('') +
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
            const localName = getTeamName(j.equipo_local_id) || j.equipo_local_nombre || '?';
            const visitName = getTeamName(j.equipo_visitante_id) || j.equipo_visitante_nombre || '?';
            const localColor = getTeamColor(j.equipo_local_id) || '#888';
            const visitColor = getTeamColor(j.equipo_visitante_id) || '#888';
            return '<div class="card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;"><span class="material-symbols-outlined" style="font-size:0.9rem;color:var(--primary);vertical-align:middle;">calendar_today</span> Jornada ' + esc(String(j.numero || '')) + '</div>' +
            '<div style="font-size:0.7rem;color:var(--on-surface-variant-40);margin-top:0.15rem;">' +
            '<span class="material-symbols-outlined" style="font-size:0.7rem;">event</span> ' + esc(fechaStr) +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:0.4rem;margin-top:0.25rem;flex-wrap:wrap;">' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.8rem;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + localColor + ';"></span>' + esc(localName) +
            '</span>' +
            '<span style="font-family:Lexend;font-weight:800;font-size:0.7rem;color:var(--on-surface-variant-40);">VS</span>' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.8rem;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + visitColor + ';"></span>' + esc(visitName) +
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
    document.getElementById('j-toggle-form')?.addEventListener('click', () => {
        const body = document.getElementById('j-form-body');
        const btn = document.getElementById('j-toggle-form');
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
    const localId = document.getElementById('j-equipo-local').value;
    const visitanteId = document.getElementById('j-equipo-visitante').value;

    if (!fecha) { toast('Seleccioná una fecha', 'error'); return; }
    if (!localId) { toast('Seleccioná el equipo local', 'error'); return; }
    if (!visitanteId) { toast('Seleccioná el equipo visitante', 'error'); return; }
    if (localId === visitanteId) { toast('Los equipos no pueden ser el mismo', 'error'); return; }

    const localName = getTeamName(localId);
    const visitanteName = getTeamName(visitanteId);
    const fechaDate = new Date(fecha + 'T12:00:00');

    showLoading(editingJornadaId ? 'Actualizando jornada...' : 'Creando jornada...');
    try {
        if (editingJornadaId) {
            await updateDoc(docRef('jornadas', editingJornadaId), {
                fecha: fechaDate,
                equipo_local_id: localId,
                equipo_visitante_id: visitanteId,
                equipo_local_nombre: localName,
                equipo_visitante_nombre: visitanteName
            });
            toast('Jornada actualizada', 'success');
        } else {
            const nextNumero = allJornadas.length ? Math.max(0, ...allJornadas.map(j => j.numero || 0)) + 1 : 1;
            await addDoc(col('jornadas'), {
                numero: nextNumero,
                fecha: fechaDate,
                equipo_local_id: localId,
                equipo_visitante_id: visitanteId,
                equipo_local_nombre: localName,
                equipo_visitante_nombre: visitanteName
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

// ═══════════════════════════════════════════
// SEMIFINALES
// ═══════════════════════════════════════════
let allSemifinales = [];
let selectedSemifinalId = null;
let semiPartidos = [];
let editingSemiPartidoId = null;

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
        for (const docSnap of snap.docs) {
            const semi = { id: docSnap.id, ...docSnap.data(), partidos: [] };
            const partSnap = await getDocs(semiPartidoCol(semi.id));
            for (const p of partSnap.docs) {
                semi.partidos.push({ id: p.id, ...p.data() });
            }
            allSemifinales.push(semi);
        }
    } catch (e) {
        console.error('Error loading semifinales:', e);
    }
}

async function loadSemiPartidos(semiId) {
    semiPartidos = [];
    if (!semiId) return;
    try {
        const snap = await getDocs(semiPartidoCol(semiId));
        semiPartidos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Error loading semi partidos:', e);
    }
}

async function generateSemifinales() {
    showLoading('Generando semifinales...');
    try {
        await loadAllEnfrentamientosAndPartidos();
        const result = calculateStandings(allEquipos, allEnfrentamientosData);
        if (result.roundStatus !== 'finalizado') {
            toast('El Round Robin debe estar finalizado para generar semifinales', 'error');
            return;
        }
        if (result.standings.length < 4) {
            toast('Se necesitan al menos 4 equipos para generar semifinales', 'error');
            return;
        }

        const s = result.standings;
        const semifinal1 = { equipo_a_id: s[0].id, equipo_a_nombre: s[0].nombre, equipo_a_posicion: 1, equipo_a_color: s[0].color, equipo_b_id: s[3].id, equipo_b_nombre: s[3].nombre, equipo_b_posicion: 4, equipo_b_color: s[3].color, ganador_equipo_id: null, estado: 'pendiente', numero: 1 };
        const semifinal2 = { equipo_a_id: s[1].id, equipo_a_nombre: s[1].nombre, equipo_a_posicion: 2, equipo_a_color: s[1].color, equipo_b_id: s[2].id, equipo_b_nombre: s[2].nombre, equipo_b_posicion: 3, equipo_b_color: s[2].color, ganador_equipo_id: null, estado: 'pendiente', numero: 2 };

        const [ref1, ref2] = await Promise.all([addDoc(semiCol(), semifinal1), addDoc(semiCol(), semifinal2)]);

        for (const semiRef of [ref1, ref2]) {
            for (const cat of DRAW_CATEGORIAS) {
                await addDoc(semiPartidoCol(semiRef.id), {
                    categoria: cat,
                    jugador_a_1_id: null, jugador_a_2_id: null,
                    jugador_b_1_id: null, jugador_b_2_id: null,
                    jugador_a_1_nombre: '', jugador_a_2_nombre: '',
                    jugador_b_1_nombre: '', jugador_b_2_nombre: '',
                    set1_local: null, set1_visitante: null,
                    set2_local: null, set2_visitante: null,
                    supertiebreak_local: null, supertiebreak_visitante: null,
                    games_local: 0, games_visitante: 0,
                    ganador_equipo_id: null, estado: 'pendiente'
                });
            }
        }

        toast('Semifinales generadas', 'success');
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
    const partidoId = editingSemiPartidoId;
    if (!semiId || !partidoId) return;

    const semi = allSemifinales.find(s => s.id === semiId);
    if (!semi) return;

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

    showLoading('Guardando...');
    try {
        await updateDoc(semiPartidoDocRef(semiId, partidoId), {
            jugador_a_1_id: j1, jugador_a_2_id: j2,
            jugador_b_1_id: j3, jugador_b_2_id: j4,
            jugador_a_1_nombre: getJugadorNombre(j1),
            jugador_a_2_nombre: getJugadorNombre(j2),
            jugador_b_1_nombre: getJugadorNombre(j3),
            jugador_b_2_nombre: getJugadorNombre(j4)
        });
        toast('Jugadores guardados', 'success');
        editingSemiPartidoId = null;
        await loadSemiPartidos(semiId);
        renderSemifinalDetail();
    } catch (e) {
        toast('Error al guardar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function saveSemiResultado() {
    const semiId = selectedSemifinalId;
    const partidoId = editingSemiPartidoId;
    if (!semiId || !partidoId) return;

    const s1Local = document.getElementById('res-s1-local')?.value ?? '';
    const s1Vis = document.getElementById('res-s1-vis')?.value ?? '';
    const s2Local = document.getElementById('res-s2-local')?.value ?? '';
    const s2Vis = document.getElementById('res-s2-vis')?.value ?? '';
    const tb1Local = document.getElementById('res-tb1-local')?.value ?? '';
    const tb1Vis = document.getElementById('res-tb1-vis')?.value ?? '';
    const tb2Local = document.getElementById('res-tb2-local')?.value ?? '';
    const tb2Vis = document.getElementById('res-tb2-vis')?.value ?? '';
    const stbLocal = document.getElementById('res-stb-local')?.value ?? '';
    const stbVis = document.getElementById('res-stb-vis')?.value ?? '';

    if (!validateMatchScore(s1Local, s1Vis, s2Local, s2Vis, tb1Local, tb1Vis, tb2Local, tb2Vis, stbLocal, stbVis)) return;

    const s1l = parseInt(s1Local), s1v = parseInt(s1Vis);
    const s2l = parseInt(s2Local), s2v = parseInt(s2Vis);
    const tb1l = tb1Local !== '' ? parseInt(tb1Local) : null;
    const tb1v = tb1Vis !== '' ? parseInt(tb1Vis) : null;
    const tb2l = tb2Local !== '' ? parseInt(tb2Local) : null;
    const tb2v = tb2Vis !== '' ? parseInt(tb2Vis) : null;
    const stbl = stbLocal !== '' ? parseInt(stbLocal) : null;
    const stbv = stbVis !== '' ? parseInt(stbVis) : null;

    const ganador = determineMatchWinner(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);
    const games = calculateGames(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);

    const semi = allSemifinales.find(s => s.id === semiId);
    const partido = semiPartidos.find(p => p.id === partidoId);
    if (!partido) return;

    const ganadorEquipoId = ganador === 'local' ? semi.equipo_a_id :
                            ganador === 'visitante' ? semi.equipo_b_id : null;

    showLoading('Guardando resultado...');
    try {
        await updateDoc(semiPartidoDocRef(semiId, partidoId), {
            set1_local: s1l, set1_visitante: s1v,
            set2_local: s2l, set2_visitante: s2v,
            tiebreak1_local: tb1l, tiebreak1_visitante: tb1v,
            tiebreak2_local: tb2l, tiebreak2_visitante: tb2v,
            supertiebreak_local: stbl, supertiebreak_visitante: stbv,
            ganador_equipo_id: ganadorEquipoId,
            estado: 'finalizado',
            games_local: games.games_local,
            games_visitante: games.games_visitante,
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
            set1_local: null, set1_visitante: null,
            set2_local: null, set2_visitante: null,
            tiebreak1_local: null, tiebreak1_visitante: null,
            tiebreak2_local: null, tiebreak2_visitante: null,
            supertiebreak_local: null, supertiebreak_visitante: null,
            ganador_equipo_id: null,
            estado: 'pendiente',
            games_local: 0, games_visitante: 0,
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
    const allDone = semiPartidos.length === 7 && semiPartidos.every(p => p.estado === 'finalizado');
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
            (allComplete ? 'Round Robin finalizado — Semifinales disponibles' : 'Round Robin en curso — Semifinales bloqueadas') +
            '</div></div></div></div>';

        if (!allComplete) {
            html += '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">lock</span><p>Las semifinales se habilitan al finalizar el Round Robin.</p></div>';
            panel.innerHTML = html;
            return;
        }

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

        // Show semifinal cards
        allSemifinales.forEach(semi => {
            const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
            const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
            const allDone = semi.partidos.length === 7 && semi.partidos.every(p => p.estado === 'finalizado');
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
                    : '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + semi.partidos.filter(p => p.estado === 'finalizado').length + '/7 finalizados</span>') +
                '</div>' +
                '</div>';
        });

        panel.innerHTML = html;
        panel.querySelectorAll('[data-semi-id]').forEach(b => b.addEventListener('click', () => {
            selectedSemifinalId = b.dataset.semiId;
            editingSemiPartidoId = null;
            renderSemifinalDetail();
        }));
    });
}

function renderSemifinalDetail() {
    const panel = document.getElementById('panel-semifinales');
    const semi = allSemifinales.find(s => s.id === selectedSemifinalId);
    if (!semi) { selectedSemifinalId = null; renderSemifinales(); return; }

    const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
    const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
    const allDone = semi.partidos.length === 7 && semi.partidos.every(p => p.estado === 'finalizado');
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
            : '<span class="badge" style="background:var(--primary-container);color:var(--primary);">' + semi.partidos.filter(p => p.estado === 'finalizado').length + '/7</span>') +
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

    // Edit form (if editing)
    if (editingSemiPartidoId) {
        const part = semiPartidos.find(p => p.id === editingSemiPartidoId);
        if (part && part.estado !== 'finalizado') {
            html += renderSemiPartidoForm(semi);
        } else if (part && part.estado === 'finalizado') {
            html += renderSemiResultadoForm(semi, part);
        }
    }

    // Partidos list
    html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_tennis</span> Partidos</div>';

    DRAW_CATEGORIAS.forEach((cat, idx) => {
        const partido = semi.partidos.find(p => p.categoria === cat);
        if (!partido) return;
        const num = String(idx + 1).padStart(2, '0');
        const isFinalizado = partido.estado === 'finalizado';

        const j1Name = getJugadorNombre(partido.jugador_a_1_id) || partido.jugador_a_1_nombre || '';
        const j2Name = getJugadorNombre(partido.jugador_a_2_id) || partido.jugador_a_2_nombre || '';
        const j3Name = getJugadorNombre(partido.jugador_b_1_id) || partido.jugador_b_1_nombre || '';
        const j4Name = getJugadorNombre(partido.jugador_b_2_id) || partido.jugador_b_2_nombre || '';

        const borderColor = isFinalizado ? (partido.ganador_equipo_id === semi.equipo_a_id ? aColor : bColor) : 'var(--on-surface-variant-40)';

        html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid ' + borderColor + ';">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
            '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--primary);">' + num + ' ' + esc(cat) + '</span>' +
            (isFinalizado ? '<span class="badge badge-success" style="font-size:0.6rem;">✓ FINALIZADO</span>' : '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);font-size:0.6rem;">PENDIENTE</span>') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:0.2rem;font-size:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.3rem;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span>' +
            '<span>' + esc(j1Name || '—') + ' / ' + esc(j2Name || '—') + '</span></div>' +
            '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);text-align:center;font-family:Lexend;font-weight:800;">VS</div>' +
            '<div style="display:flex;align-items:center;gap:0.3rem;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span>' +
            '<span>' + esc(j3Name || '—') + ' / ' + esc(j4Name || '—') + '</span></div>' +
            '</div>';

        if (isFinalizado) {
            const s1 = partido.set1_local + '-' + partido.set1_visitante;
            const s2 = partido.set2_local + '-' + partido.set2_visitante;
            const tb1 = (partido.tiebreak1_local != null && partido.tiebreak1_visitante != null) ? ' · TB1 ' + partido.tiebreak1_local + '-' + partido.tiebreak1_visitante : '';
            const tb2 = (partido.tiebreak2_local != null && partido.tiebreak2_visitante != null) ? ' · TB2 ' + partido.tiebreak2_local + '-' + partido.tiebreak2_visitante : '';
            const hasSTB = partido.supertiebreak_local != null && partido.supertiebreak_visitante != null;
            const stb = hasSTB ? ' · STB ' + partido.supertiebreak_local + '-' + partido.supertiebreak_visitante : '';
            const ganadorName = partido.ganador_equipo_id === semi.equipo_a_id ? semi.equipo_a_nombre : semi.equipo_b_nombre;
            html += '<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--on-surface-variant-40);">' +
                '<span style="font-weight:600;">' + s1 + '</span> · <span style="font-weight:600;">' + s2 + '</span>' + esc(tb1) + esc(tb2) + esc(stb) +
                ' · <span style="color:var(--secondary);">🏆 ' + esc(ganadorName) + '</span></div>';
        }

        html += '</div>' +
            '<div style="display:flex;gap:0.3rem;">' +
            '<button class="btn btn-sm btn-outline" data-semi-edit="' + partido.id + '" title="Editar"><span class="material-symbols-outlined" style="font-size:0.8rem;">' + (isFinalizado ? 'edit' : 'sports_score') + '</span></button>' +
            (isFinalizado ? '<button class="btn btn-sm btn-danger" data-semi-clear="' + partido.id + '" title="Limpiar"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' : '') +
            '</div></div></div>';
    });

    panel.innerHTML = html;

    // Event listeners
    document.getElementById('btn-back-semis')?.addEventListener('click', () => {
        selectedSemifinalId = null;
        editingSemiPartidoId = null;
        semiPartidos = [];
        renderSemifinales();
    });

    panel.querySelectorAll('[data-semi-edit]').forEach(b => b.addEventListener('click', () => {
        editingSemiPartidoId = b.dataset.semiEdit;
        renderSemifinalDetail();
    }));

    panel.querySelectorAll('[data-semi-clear]').forEach(b => b.addEventListener('click', () => safeAction(() => {
        editingSemiPartidoId = b.dataset.semiClear;
        clearSemiResultado();
    })));

    document.getElementById('btn-save-semi-partido')?.addEventListener('click', () => safeAction(saveSemiPartido));
    document.getElementById('btn-cancel-semi-partido')?.addEventListener('click', () => { editingSemiPartidoId = null; renderSemifinalDetail(); });
    document.getElementById('btn-save-semi-resultado')?.addEventListener('click', () => safeAction(saveSemiResultado));
    document.getElementById('btn-cancel-semi-resultado')?.addEventListener('click', () => { editingSemiPartidoId = null; renderSemifinalDetail(); });

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
                players.filter(p => p.id !== v1).map(p => '<option value="' + p.id + '"' + (p.id === j2Sel.value ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>').join('');
        };
        j1Sel.addEventListener('change', updatePair);
    }
    if (j3Sel && j4Sel) {
        const updatePair = () => {
            const v3 = j3Sel.value;
            const players = getPlayersInTeam(semi.equipo_b_id);
            j4Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                players.filter(p => p.id !== v3).map(p => '<option value="' + p.id + '"' + (p.id === j4Sel.value ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>').join('');
        };
        j3Sel.addEventListener('change', updatePair);
    }
}

function renderSemiPartidoForm(semi) {
    const part = semiPartidos.find(p => p.id === editingSemiPartidoId);
    if (!part) return '';

    const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
    const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
    const aPlayers = getPlayersInTeam(semi.equipo_a_id);
    const bPlayers = getPlayersInTeam(semi.equipo_b_id);
    const makeOpts = (players, sel, excl) => '<option value="">— Seleccionar —</option>' + players.filter(p => p.id !== excl).map(p => '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>').join('');

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">edit</span> Seleccionar Jugadores — ' + esc(part.categoria || '') +
        '</div>';

    html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(semi.equipo_a_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 1</label><select id="dp-j1">' + makeOpts(aPlayers, part.jugador_a_1_id, part.jugador_a_2_id) + '</select></div>' +
        '<div class="form-group"><label>Jugador 2</label><select id="dp-j2">' + makeOpts(aPlayers, part.jugador_a_2_id, part.jugador_a_1_id) + '</select></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;padding-bottom:1.5rem;font-family:Lexend;font-weight:800;font-size:0.8rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(semi.equipo_b_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 3</label><select id="dp-j3">' + makeOpts(bPlayers, part.jugador_b_1_id, part.jugador_b_2_id) + '</select></div>' +
        '<div class="form-group"><label>Jugador 4</label><select id="dp-j4">' + makeOpts(bPlayers, part.jugador_b_2_id, part.jugador_b_1_id) + '</select></div>' +
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
    const s1l = part.set1_local != null ? part.set1_local : '';
    const s1v = part.set1_visitante != null ? part.set1_visitante : '';
    const s2l = part.set2_local != null ? part.set2_local : '';
    const s2v = part.set2_visitante != null ? part.set2_visitante : '';
    const tb1l = part.tiebreak1_local != null ? part.tiebreak1_local : '';
    const tb1v = part.tiebreak1_visitante != null ? part.tiebreak1_visitante : '';
    const tb2l = part.tiebreak2_local != null ? part.tiebreak2_local : '';
    const tb2v = part.tiebreak2_visitante != null ? part.tiebreak2_visitante : '';
    const stbl = part.supertiebreak_local != null ? part.supertiebreak_local : '';
    const stbv = part.supertiebreak_visitante != null ? part.supertiebreak_visitante : '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">sports_score</span> ' +
        (part.estado === 'finalizado' ? 'Editar' : 'Ingresar') + ' Resultado — ' + esc(part.categoria || '') +
        '</div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 1</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(semi.equipo_a_nombre) + '</div>' +
        '<input type="number" id="res-s1-local" min="0" max="7" value="' + s1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(semi.equipo_b_nombre) + '</div>' +
        '<input type="number" id="res-s1-vis" min="0" max="7" value="' + s1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 1 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb1-local" min="0" max="15" value="' + tb1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb1-vis" min="0" max="15" value="' + tb1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 2</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-s2-local" min="0" max="7" value="' + s2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-s2-vis" min="0" max="7" value="' + s2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 2 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb2-local" min="0" max="15" value="' + tb2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb2-vis" min="0" max="15" value="' + tb2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SUPER TIE BREAK <span style="font-weight:400;font-size:0.65rem;">(solo si sets 1-1)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.75rem;">' +
        '<div style="flex:1;"><input type="number" id="res-stb-local" min="0" max="20" value="' + stbl + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-stb-vis" min="0" max="20" value="' + stbv + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

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
        for (const docSnap of snap.docs) {
            const fin = { id: docSnap.id, ...docSnap.data(), partidos: [] };
            const partSnap = await getDocs(finalPartidoCol(fin.id));
            for (const p of partSnap.docs) {
                fin.partidos.push({ id: p.id, ...p.data() });
            }
            allFinales.push(fin);
        }
    } catch (e) {
        console.error('Error loading finales:', e);
    }
}

async function loadFinalPartidos(finalId) {
    finalPartidos = [];
    if (!finalId) return;
    try {
        const snap = await getDocs(finalPartidoCol(finalId));
        finalPartidos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Error loading final partidos:', e);
    }
}

async function generateFinal() {
    showLoading('Generando final...');
    try {
        await loadSemifinales();
        const finishedSemis = allSemifinales.filter(s => s.estado === 'finalizado' && s.ganador_equipo_id);
        if (finishedSemis.length < 2) {
            toast('Se necesitan 2 semifinales finalizadas para generar la final', 'error');
            return;
        }

        const ganador1 = finishedSemis[0].ganador_equipo_id;
        const ganador2 = finishedSemis[1].ganador_equipo_id;
        const eq1 = allEquipos.find(e => e.id === ganador1);
        const eq2 = allEquipos.find(e => e.id === ganador2);

        const finalData = {
            equipo_a_id: ganador1, equipo_a_nombre: eq1?.nombre || '?', equipo_a_color: eq1?.color || '#888',
            equipo_b_id: ganador2, equipo_b_nombre: eq2?.nombre || '?', equipo_b_color: eq2?.color || '#888',
            ganador_equipo_id: null, estado: 'pendiente', numero: 1
        };

        const ref = await addDoc(finalCol(), finalData);

        for (const cat of DRAW_CATEGORIAS) {
            await addDoc(finalPartidoCol(ref.id), {
                categoria: cat,
                jugador_a_1_id: null, jugador_a_2_id: null,
                jugador_b_1_id: null, jugador_b_2_id: null,
                jugador_a_1_nombre: '', jugador_a_2_nombre: '',
                jugador_b_1_nombre: '', jugador_b_2_nombre: '',
                set1_local: null, set1_visitante: null,
                set2_local: null, set2_visitante: null,
                supertiebreak_local: null, supertiebreak_visitante: null,
                games_local: 0, games_visitante: 0,
                ganador_equipo_id: null, estado: 'pendiente'
            });
        }

        toast('Final generada', 'success');
        await loadFinales();
        renderFinal();
    } catch (e) {
        toast('Error al generar final', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function saveFinalPartido() {
    const finalId = selectedFinalId;
    const partidoId = editingFinalPartidoId;
    if (!finalId || !partidoId) return;

    const fin = allFinales.find(f => f.id === finalId);
    if (!fin) return;

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

    showLoading('Guardando...');
    try {
        await updateDoc(finalPartidoDocRef(finalId, partidoId), {
            jugador_a_1_id: j1, jugador_a_2_id: j2,
            jugador_b_1_id: j3, jugador_b_2_id: j4,
            jugador_a_1_nombre: getJugadorNombre(j1),
            jugador_a_2_nombre: getJugadorNombre(j2),
            jugador_b_1_nombre: getJugadorNombre(j3),
            jugador_b_2_nombre: getJugadorNombre(j4)
        });
        toast('Jugadores guardados', 'success');
        editingFinalPartidoId = null;
        await loadFinalPartidos(finalId);
        renderFinalDetail();
    } catch (e) {
        toast('Error al guardar', 'error'); console.error(e);
    } finally {
        hideLoading();
    }
}

async function saveFinalResultado() {
    const finalId = selectedFinalId;
    const partidoId = editingFinalPartidoId;
    if (!finalId || !partidoId) return;

    const s1Local = document.getElementById('res-s1-local')?.value ?? '';
    const s1Vis = document.getElementById('res-s1-vis')?.value ?? '';
    const s2Local = document.getElementById('res-s2-local')?.value ?? '';
    const s2Vis = document.getElementById('res-s2-vis')?.value ?? '';
    const tb1Local = document.getElementById('res-tb1-local')?.value ?? '';
    const tb1Vis = document.getElementById('res-tb1-vis')?.value ?? '';
    const tb2Local = document.getElementById('res-tb2-local')?.value ?? '';
    const tb2Vis = document.getElementById('res-tb2-vis')?.value ?? '';
    const stbLocal = document.getElementById('res-stb-local')?.value ?? '';
    const stbVis = document.getElementById('res-stb-vis')?.value ?? '';

    if (!validateMatchScore(s1Local, s1Vis, s2Local, s2Vis, tb1Local, tb1Vis, tb2Local, tb2Vis, stbLocal, stbVis)) return;

    const s1l = parseInt(s1Local), s1v = parseInt(s1Vis);
    const s2l = parseInt(s2Local), s2v = parseInt(s2Vis);
    const tb1l = tb1Local !== '' ? parseInt(tb1Local) : null;
    const tb1v = tb1Vis !== '' ? parseInt(tb1Vis) : null;
    const tb2l = tb2Local !== '' ? parseInt(tb2Local) : null;
    const tb2v = tb2Vis !== '' ? parseInt(tb2Vis) : null;
    const stbl = stbLocal !== '' ? parseInt(stbLocal) : null;
    const stbv = stbVis !== '' ? parseInt(stbVis) : null;

    const ganador = determineMatchWinner(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);
    const games = calculateGames(s1l, s1v, s2l, s2v, tb1l, tb1v, tb2l, tb2v, stbl, stbv);

    const fin = allFinales.find(f => f.id === finalId);
    const partido = finalPartidos.find(p => p.id === partidoId);
    if (!partido) return;

    const ganadorEquipoId = ganador === 'local' ? fin.equipo_a_id :
                            ganador === 'visitante' ? fin.equipo_b_id : null;

    showLoading('Guardando resultado...');
    try {
        await updateDoc(finalPartidoDocRef(finalId, partidoId), {
            set1_local: s1l, set1_visitante: s1v,
            set2_local: s2l, set2_visitante: s2v,
            tiebreak1_local: tb1l, tiebreak1_visitante: tb1v,
            tiebreak2_local: tb2l, tiebreak2_visitante: tb2v,
            supertiebreak_local: stbl, supertiebreak_visitante: stbv,
            ganador_equipo_id: ganadorEquipoId,
            estado: 'finalizado',
            games_local: games.games_local,
            games_visitante: games.games_visitante,
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
            set1_local: null, set1_visitante: null,
            set2_local: null, set2_visitante: null,
            tiebreak1_local: null, tiebreak1_visitante: null,
            tiebreak2_local: null, tiebreak2_visitante: null,
            supertiebreak_local: null, supertiebreak_visitante: null,
            ganador_equipo_id: null,
            estado: 'pendiente',
            games_local: 0, games_visitante: 0,
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
    const allDone = finalPartidos.length === 7 && finalPartidos.every(p => p.estado === 'finalizado');
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

        if (!allSemisComplete && !hasFinal) {
            html += '<div class="empty-state" style="padding:2rem;"><span class="material-symbols-outlined">lock</span><p>La final se habilita al completar ambas semifinales.</p></div>';
            panel.innerHTML = html;
            return;
        }

        if (!hasFinal) {
            html += '<div class="empty-state" style="padding:2rem;">' +
                '<span class="material-symbols-outlined">workspace_premium</span>' +
                '<p>No hay final generada.</p>' +
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
                    : '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + fin.partidos.filter(p => p.estado === 'finalizado').length + '/7 finalizados</span>') +
                '</div></div>';
        });

        panel.innerHTML = html;
        panel.querySelectorAll('[data-final-id]').forEach(b => b.addEventListener('click', () => {
            selectedFinalId = b.dataset.finalId;
            editingFinalPartidoId = null;
            renderFinalDetail();
        }));
    });
}

function renderFinalDetail() {
    const panel = document.getElementById('panel-final');
    const fin = allFinales.find(f => f.id === selectedFinalId);
    if (!fin) { selectedFinalId = null; renderFinal(); return; }

    const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
    const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';
    const allDone = fin.partidos.length === 7 && fin.partidos.every(p => p.estado === 'finalizado');
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
            : '<span class="badge" style="background:var(--primary-container);color:var(--primary);">' + fin.partidos.filter(p => p.estado === 'finalizado').length + '/7</span>') +
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

    // Edit forms
    if (editingFinalPartidoId) {
        const part = finalPartidos.find(p => p.id === editingFinalPartidoId);
        if (part && part.estado !== 'finalizado') {
            html += renderFinalPartidoForm(fin);
        } else if (part && part.estado === 'finalizado') {
            html += renderFinalResultadoForm(fin, part);
        }
    }

    // Partidos list
    html += '<div class="admin-section-title"><span class="material-symbols-outlined" style="font-size:0.9rem;">sports_tennis</span> Partidos</div>';

    DRAW_CATEGORIAS.forEach((cat, idx) => {
        const partido = fin.partidos.find(p => p.categoria === cat);
        if (!partido) return;
        const num = String(idx + 1).padStart(2, '0');
        const isFinalizado = partido.estado === 'finalizado';

        const j1Name = getJugadorNombre(partido.jugador_a_1_id) || partido.jugador_a_1_nombre || '';
        const j2Name = getJugadorNombre(partido.jugador_a_2_id) || partido.jugador_a_2_nombre || '';
        const j3Name = getJugadorNombre(partido.jugador_b_1_id) || partido.jugador_b_1_nombre || '';
        const j4Name = getJugadorNombre(partido.jugador_b_2_id) || partido.jugador_b_2_nombre || '';

        const borderColor = isFinalizado ? (partido.ganador_equipo_id === fin.equipo_a_id ? aColor : bColor) : 'var(--on-surface-variant-40)';

        html += '<div class="card" style="margin-bottom:0.5rem;border-left:4px solid ' + borderColor + ';">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
            '<span style="font-family:Lexend;font-weight:600;font-size:0.82rem;color:var(--primary);">' + num + ' ' + esc(cat) + '</span>' +
            (isFinalizado ? '<span class="badge badge-success" style="font-size:0.6rem;">✓ FINALIZADO</span>' : '<span class="badge" style="background:var(--white-8);color:var(--on-surface-variant-40);font-size:0.6rem;">PENDIENTE</span>') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:0.2rem;font-size:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.3rem;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span>' +
            '<span>' + esc(j1Name || '—') + ' / ' + esc(j2Name || '—') + '</span></div>' +
            '<div style="font-size:0.68rem;color:var(--on-surface-variant-40);text-align:center;font-family:Lexend;font-weight:800;">VS</div>' +
            '<div style="display:flex;align-items:center;gap:0.3rem;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span>' +
            '<span>' + esc(j3Name || '—') + ' / ' + esc(j4Name || '—') + '</span></div>' +
            '</div>';

        if (isFinalizado) {
            const s1 = partido.set1_local + '-' + partido.set1_visitante;
            const s2 = partido.set2_local + '-' + partido.set2_visitante;
            const tb1 = (partido.tiebreak1_local != null && partido.tiebreak1_visitante != null) ? ' · TB1 ' + partido.tiebreak1_local + '-' + partido.tiebreak1_visitante : '';
            const tb2 = (partido.tiebreak2_local != null && partido.tiebreak2_visitante != null) ? ' · TB2 ' + partido.tiebreak2_local + '-' + partido.tiebreak2_visitante : '';
            const hasSTB = partido.supertiebreak_local != null && partido.supertiebreak_visitante != null;
            const stb = hasSTB ? ' · STB ' + partido.supertiebreak_local + '-' + partido.supertiebreak_visitante : '';
            const ganadorName = partido.ganador_equipo_id === fin.equipo_a_id ? fin.equipo_a_nombre : fin.equipo_b_nombre;
            html += '<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--on-surface-variant-40);">' +
                '<span style="font-weight:600;">' + s1 + '</span> · <span style="font-weight:600;">' + s2 + '</span>' + esc(tb1) + esc(tb2) + esc(stb) +
                ' · <span style="color:var(--secondary);">🏆 ' + esc(ganadorName) + '</span></div>';
        }

        html += '</div>' +
            '<div style="display:flex;gap:0.3rem;">' +
            '<button class="btn btn-sm btn-outline" data-final-edit="' + partido.id + '" title="Editar"><span class="material-symbols-outlined" style="font-size:0.8rem;">' + (isFinalizado ? 'edit' : 'sports_score') + '</span></button>' +
            (isFinalizado ? '<button class="btn btn-sm btn-danger" data-final-clear="' + partido.id + '" title="Limpiar"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>' : '') +
            '</div></div></div>';
    });

    panel.innerHTML = html;

    // Event listeners
    document.getElementById('btn-back-finales')?.addEventListener('click', () => {
        selectedFinalId = null;
        editingFinalPartidoId = null;
        finalPartidos = [];
        renderFinal();
    });

    panel.querySelectorAll('[data-final-edit]').forEach(b => b.addEventListener('click', () => {
        editingFinalPartidoId = b.dataset.finalEdit;
        renderFinalDetail();
    }));

    panel.querySelectorAll('[data-final-clear]').forEach(b => b.addEventListener('click', () => safeAction(() => {
        editingFinalPartidoId = b.dataset.finalClear;
        clearFinalResultado();
    })));

    document.getElementById('btn-save-final-partido')?.addEventListener('click', () => safeAction(saveFinalPartido));
    document.getElementById('btn-cancel-final-partido')?.addEventListener('click', () => { editingFinalPartidoId = null; renderFinalDetail(); });
    document.getElementById('btn-save-final-resultado')?.addEventListener('click', () => safeAction(saveFinalResultado));
    document.getElementById('btn-cancel-final-resultado')?.addEventListener('click', () => { editingFinalPartidoId = null; renderFinalDetail(); });

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
                players.filter(p => p.id !== v1).map(p => '<option value="' + p.id + '"' + (p.id === j2Sel.value ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>').join('');
        };
        j1Sel.addEventListener('change', updatePair);
    }
    if (j3Sel && j4Sel) {
        const updatePair = () => {
            const v3 = j3Sel.value;
            const players = getPlayersInTeam(fin.equipo_b_id);
            j4Sel.innerHTML = '<option value="">— Seleccionar —</option>' +
                players.filter(p => p.id !== v3).map(p => '<option value="' + p.id + '"' + (p.id === j4Sel.value ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>').join('');
        };
        j3Sel.addEventListener('change', updatePair);
    }
}

function renderFinalPartidoForm(fin) {
    const part = finalPartidos.find(p => p.id === editingFinalPartidoId);
    if (!part) return '';

    const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
    const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';
    const aPlayers = getPlayersInTeam(fin.equipo_a_id);
    const bPlayers = getPlayersInTeam(fin.equipo_b_id);
    const makeOpts = (players, sel, excl) => '<option value="">— Seleccionar —</option>' + players.filter(p => p.id !== excl).map(p => '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(shortName(p)) + '</option>').join('');

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">edit</span> Seleccionar Jugadores — ' + esc(part.categoria || '') +
        '</div>';

    html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(fin.equipo_a_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 1</label><select id="dp-j1">' + makeOpts(aPlayers, part.jugador_a_1_id, part.jugador_a_2_id) + '</select></div>' +
        '<div class="form-group"><label>Jugador 2</label><select id="dp-j2">' + makeOpts(aPlayers, part.jugador_a_2_id, part.jugador_a_1_id) + '</select></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;padding-bottom:1.5rem;font-family:Lexend;font-weight:800;font-size:0.8rem;color:var(--on-surface-variant-40);">VS</div>' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(fin.equipo_b_nombre) +
        '</div>' +
        '<div class="form-group"><label>Jugador 3</label><select id="dp-j3">' + makeOpts(bPlayers, part.jugador_b_1_id, part.jugador_b_2_id) + '</select></div>' +
        '<div class="form-group"><label>Jugador 4</label><select id="dp-j4">' + makeOpts(bPlayers, part.jugador_b_2_id, part.jugador_b_1_id) + '</select></div>' +
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
    const s1l = part.set1_local != null ? part.set1_local : '';
    const s1v = part.set1_visitante != null ? part.set1_visitante : '';
    const s2l = part.set2_local != null ? part.set2_local : '';
    const s2v = part.set2_visitante != null ? part.set2_visitante : '';
    const tb1l = part.tiebreak1_local != null ? part.tiebreak1_local : '';
    const tb1v = part.tiebreak1_visitante != null ? part.tiebreak1_visitante : '';
    const tb2l = part.tiebreak2_local != null ? part.tiebreak2_local : '';
    const tb2v = part.tiebreak2_visitante != null ? part.tiebreak2_visitante : '';
    const stbl = part.supertiebreak_local != null ? part.supertiebreak_local : '';
    const stbv = part.supertiebreak_visitante != null ? part.supertiebreak_visitante : '';

    let html = '<div class="card" style="border:2px solid var(--primary);margin-bottom:0.75rem;">' +
        '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--primary);margin-bottom:0.75rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">sports_score</span> ' +
        (part.estado === 'finalizado' ? 'Editar' : 'Ingresar') + ' Resultado — ' + esc(part.categoria || '') +
        '</div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 1</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + aColor + ';"></span> ' + esc(fin.equipo_a_nombre) + '</div>' +
        '<input type="number" id="res-s1-local" min="0" max="7" value="' + s1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><div style="font-size:0.68rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + bColor + ';"></span> ' + esc(fin.equipo_b_nombre) + '</div>' +
        '<input type="number" id="res-s1-vis" min="0" max="7" value="' + s1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 1 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb1-local" min="0" max="15" value="' + tb1l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb1-vis" min="0" max="15" value="' + tb1v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SET 2</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-s2-local" min="0" max="7" value="' + s2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-s2-vis" min="0" max="7" value="' + s2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--primary);margin-bottom:0.4rem;">TIE BREAK SET 2 <span style="font-weight:400;font-size:0.65rem;">(solo si 4-4)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.5rem;">' +
        '<div style="flex:1;"><input type="number" id="res-tb2-local" min="0" max="15" value="' + tb2l + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-tb2-vis" min="0" max="15" value="' + tb2v + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div style="font-size:0.72rem;font-family:Lexend;font-weight:600;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">SUPER TIE BREAK <span style="font-weight:400;font-size:0.65rem;">(solo si sets 1-1)</span></div>' +
        '<div style="display:flex;gap:0.5rem;align-items:end;margin-bottom:0.75rem;">' +
        '<div style="flex:1;"><input type="number" id="res-stb-local" min="0" max="20" value="' + stbl + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div>' +
        '<div style="font-family:Lexend;font-weight:800;color:var(--on-surface-variant-40);padding-bottom:0.5rem;">—</div>' +
        '<div style="flex:1;"><input type="number" id="res-stb-vis" min="0" max="20" value="' + stbv + '" style="width:100%;text-align:center;font-size:1.1rem;font-weight:600;padding:0.5rem;" placeholder="—"></div></div>';

    html += '<div class="btn-group-spaced" style="margin-top:0.75rem;">' +
        '<button class="btn btn-primary" id="btn-save-final-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">save</span> Guardar Resultado</button>' +
        '<button class="btn btn-outline" id="btn-cancel-final-resultado"><span class="material-symbols-outlined" style="font-size:1rem;">close</span> Cancelar</button>' +
        '</div></div>';

    return html;
}
