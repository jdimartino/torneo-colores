import { getDocs, getDoc, doc, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { db } from './firebasePublic.js';
import { loadTournamentConfig, col, getActiveTournamentId, getActiveTournament, getActiveTournamentIds, setSelectedTournament, setActiveTournament, getBracketConfig } from './tournamentRefs.js';
import { calculateStandings } from './standings.js';
import { esc, shortName, formatDate, formatCategoria, makeTeamHelpers, deriveGanadorId } from './utils.js';

let allJugadores = [];
let allEquipos = [];
let allPartidosEliminatoria = [];
let allJornadas = [];
let allEnfrentamientos = [];
let allSemifinales = [];
let allFinales = [];

const _teamHelpers = makeTeamHelpers(() => allEquipos);
const getTeamName = _teamHelpers.getTeamName;
const getTeamColor = _teamHelpers.getTeamColor;

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

const loadingHTML = '<div class="panel-loading"><div class="tennis-ball-spinner"></div><div class="loading-text">Cargando datos del torneo...</div></div>';

function getJugadorNombre(jugId) {
    if (!jugId) return '';
    const j = allJugadores.find(j => j.id === jugId);
    return j ? ((j.nombre || '').split(' ')[0] + ' ' + (j.apellidos || '').split(' ')[0]) : '';
}

// ── Scoreboard helpers (tenis real) ──
// Devuelve un token por unidad: { text, win, tie } donde win=true fue ganador de ESA unidad.
function setUnitTokens(setA, setB, tbA, tbB) {
    if (setA === 4 && setB === 4 && tbA != null && tbB != null) {
        const tieWinner = tbA > tbB ? 'a' : 'b';
        return {
            a: { text: String(tieWinner === 'a' ? 6 : 5) + '(' + tbA + ')', win: tbA > tbB, tie: tbA === tbB },
            b: { text: String(tieWinner === 'b' ? 6 : 5) + '(' + tbB + ')', win: tbB > tbA, tie: tbA === tbB }
        };
    }
    return {
        a: { text: String(setA), win: setA > setB, tie: setA === setB },
        b: { text: String(setB), win: setB > setA, tie: setA === setB }
    };
}

function formatPlayerScore(rs) {
    const s1 = setUnitTokens(rs.set1_a, rs.set1_b, rs.tb1_a, rs.tb1_b);
    const s2 = setUnitTokens(rs.set2_a, rs.set2_b, rs.tb2_a, rs.tb2_b);
    const tokens = { a: [s1.a, s2.a], b: [s1.b, s2.b] };
    if (rs.stb_a != null && rs.stb_b != null) {
        tokens.a.push({ text: String(rs.stb_a), win: rs.stb_a > rs.stb_b, tie: rs.stb_a === rs.stb_b });
        tokens.b.push({ text: String(rs.stb_b), win: rs.stb_b > rs.stb_a, tie: rs.stb_a === rs.stb_b });
    }
    return tokens;
}

function renderScoreTokens(tokens) {
    return tokens.map(t =>
        '<span class="res-set' + (t.tie ? ' res-set-tie' : (t.win ? ' res-set-win' : ' res-set-lose')) + '">' + esc(t.text) + '</span>'
    ).join('');
}

// Objeto rs según el estado: finalizado lee campos directos; pendiente lee borrador.
function getPublicRs(p) {
    if (p.estado === 'finalizado') {
        return {
            set1_a: p.set1_a != null ? p.set1_a : 0,
            set1_b: p.set1_b != null ? p.set1_b : 0,
            set2_a: p.set2_a != null ? p.set2_a : 0,
            set2_b: p.set2_b != null ? p.set2_b : 0,
            tb1_a: p.tiebreak1_a != null ? p.tiebreak1_a : null,
            tb1_b: p.tiebreak1_b != null ? p.tiebreak1_b : null,
            tb2_a: p.tiebreak2_a != null ? p.tiebreak2_a : null,
            tb2_b: p.tiebreak2_b != null ? p.tiebreak2_b : null,
            stb_a: p.supertiebreak_a != null ? p.supertiebreak_a : null,
            stb_b: p.supertiebreak_b != null ? p.supertiebreak_b : null
        };
    }
    const d = p.borrador || {};
    return {
        set1_a: d.set1_a != null ? d.set1_a : 0,
        set1_b: d.set1_b != null ? d.set1_b : 0,
        set2_a: d.set2_a != null ? d.set2_a : 0,
        set2_b: d.set2_b != null ? d.set2_b : 0,
        tb1_a: d.tb1_a != null ? d.tb1_a : null,
        tb1_b: d.tb1_b != null ? d.tb1_b : null,
        tb2_a: d.tb2_a != null ? d.tb2_a : null,
        tb2_b: d.tb2_b != null ? d.tb2_b : null,
        stb_a: d.stb_a != null ? d.stb_a : null,
        stb_b: d.stb_b != null ? d.stb_b : null
    };
}

// ═══════════════════════════════════════════
// CAPA DE DATOS: dataset canónico + carga perezosa por pestaña
// Firestore → memoria (compartida) → vistas. Nunca al revés.
// ═══════════════════════════════════════════
const _jornadaPartidos = {};
const _loaded = { base: false, jugadores: false, partidos: false, semis: false, fins: false };
const _pending = {};
let _dataLoaded = false;
let _currentTab = null;
let _gen = 0;

if (typeof window !== 'undefined') {
    window._dbg = {
        jugadores: () => allJugadores,
        equipos: () => allEquipos,
        jornadas: () => allJornadas,
        loadAllData: reloadAllData,
        reloadPosiciones: () => renderPosiciones(),
        get tournamentId() { return getActiveTournamentId(); },
        get dataLoaded() { return _dataLoaded; }
    };
}

function _ensure(key, loader) {
    if (_loaded[key]) return Promise.resolve(true);
    if (_pending[key]) return _pending[key];
    const p = Promise.resolve().then(loader).then((ok) => { if (ok) _loaded[key] = true; return ok; });
    _pending[key] = p;
    p.finally(() => { if (_pending[key] === p) _pending[key] = null; });
    return p;
}

function _annotatePartido(p, j) {
    p._jornadaId = j.id;
    p._jornadaNumero = j.numero;
    p._jornadaFecha = j.fecha;
    return p;
}

// Deriva allEnfrentamientos y allPartidosEliminatoria desde el dataset canónico
function _rebuildRoundRobinDerived() {
    allEnfrentamientos = [];
    allPartidosEliminatoria = [];
    allJornadas.forEach(j => {
        const partidos = _jornadaPartidos[j.id] || [];
        for (const p of partidos) allPartidosEliminatoria.push(p);
        allEnfrentamientos.push({
            id: j.id,
            equipo_a_id: j.equipo_a_id,
            equipo_b_id: j.equipo_b_id,
            _jornadaId: j.id,
            _jornadaNumero: j.numero,
            cerrada: j.cerrada === true,
            partidos
        });
    });
}

async function ensureBase() {
    return _ensure('base', async () => {
        const g = _gen;
        await loadTournamentConfig();
        if (!getActiveTournamentId() || g !== _gen) return false;
        const [eq, jo] = await Promise.all([
            getDocs(col('equipos')),
            getDocs(col('jornadas'))
        ]);
        if (g !== _gen) return false;
        allEquipos = eq.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        allJornadas = jo.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        _dataLoaded = true;
        window.dispatchEvent(new CustomEvent('appDataLoaded'));
        return true;
    });
}

async function ensureJugadores() {
    return _ensure('jugadores', async () => {
        const g = _gen;
        await ensureBase();
        if (g !== _gen) return false;
        if (!getActiveTournamentId()) return true;
        const snap = await getDocs(col('jugadores'));
        if (g !== _gen) return false;
        allJugadores = snap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        return true;
    });
}

async function ensurePartidos() {
    return _ensure('partidos', async () => {
        const g = _gen;
        await ensureBase();
        if (g !== _gen) return false;
        const tid = getActiveTournamentId();
        if (!tid) return true;
        const results = await Promise.all(allJornadas.map(async j => {
            const snap = await getDocs(collection(db, 'torneos', tid, 'jornadas', j.id, 'partidos'));
            return { id: j.id, partidos: snap.docs.map(d => _annotatePartido({ id: d.id, ...normalizeFields(d.data()) }, j)) };
        }));
        if (g !== _gen) return false;
        results.forEach(r => { _jornadaPartidos[r.id] = r.partidos; });
        _rebuildRoundRobinDerived();
        return true;
    });
}

async function ensureSemis() {
    return _ensure('semis', async () => {
        const g = _gen;
        await ensureBase();
        if (g !== _gen) return false;
        const tid = getActiveTournamentId();
        if (!tid) return true;
        const snap = await getDocs(collection(db, 'torneos', tid, 'semifinales'));
        const semis = snap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()), partidos: [] }));
        const partSnaps = await Promise.all(semis.map(s =>
            getDocs(collection(db, 'torneos', tid, 'semifinales', s.id, 'partidos'))
        ));
        if (g !== _gen) return false;
        semis.forEach((s, i) => {
            s.partidos = partSnaps[i].docs.map(p => ({ id: p.id, ...normalizeFields(p.data()) }));
        });
        allSemifinales = semis;
        return true;
    });
}

async function ensureFins() {
    return _ensure('fins', async () => {
        const g = _gen;
        await ensureBase();
        if (g !== _gen) return false;
        const tid = getActiveTournamentId();
        if (!tid) return true;
        const snap = await getDocs(collection(db, 'torneos', tid, 'finales'));
        const fins = snap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()), partidos: [] }));
        const partSnaps = await Promise.all(fins.map(f =>
            getDocs(collection(db, 'torneos', tid, 'finales', f.id, 'partidos'))
        ));
        if (g !== _gen) return false;
        fins.forEach((f, i) => {
            f.partidos = partSnaps[i].docs.map(p => ({ id: p.id, ...normalizeFields(p.data()) }));
        });
        allFinales = fins;
        return true;
    });
}

// ── Listeners realtime: solo para el módulo visible ──
const _live = { rr: [], semis: [], fins: [] };

function _detachLive(kind) {
    _live[kind].forEach(u => { try { u(); } catch (e) {} });
    _live[kind] = [];
}

function _detachAllLive() {
    ['rr', 'semis', 'fins'].forEach(_detachLive);
}

function _attachRRLive() {
    if (_live.rr.length) return;
    const tid = getActiveTournamentId();
    if (!tid) return;
    allJornadas.forEach(j => {
        const unsub = onSnapshot(collection(db, 'torneos', tid, 'jornadas', j.id, 'partidos'), (snap) => {
            _jornadaPartidos[j.id] = snap.docs.map(d => _annotatePartido({ id: d.id, ...normalizeFields(d.data()) }, j));
            _rebuildRoundRobinDerived();
            schedulePublicRender();
        }, (err) => {
            console.error('Error en listener de resultados:', err);
        });
        _live.rr.push(unsub);
    });
}

function _attachSemisLive() {
    if (_live.semis.length) return;
    const tid = getActiveTournamentId();
    if (!tid) return;
    const subscribedIds = new Set();
    const unsub = onSnapshot(collection(db, 'torneos', tid, 'semifinales'), (snap) => {
        snap.docs.forEach(docSnap => {
            const data = { id: docSnap.id, ...normalizeFields(docSnap.data()) };
            const existing = allSemifinales.find(s => s.id === docSnap.id);
            if (existing) {
                Object.assign(existing, data);
            } else {
                allSemifinales.push({ ...data, partidos: [] });
            }
            if (!subscribedIds.has(docSnap.id)) {
                subscribedIds.add(docSnap.id);
                const pUnsub = onSnapshot(
                    collection(db, 'torneos', tid, 'semifinales', docSnap.id, 'partidos'),
                    (pSnap) => {
                        const s = allSemifinales.find(x => x.id === docSnap.id);
                        if (s) s.partidos = pSnap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
                        schedulePublicRender();
                    },
                    (err) => console.error('Error en listener partidos semifinal:', err)
                );
                _live.semis.push(pUnsub);
            }
        });
        schedulePublicRender();
    }, (err) => console.error('Error en listener semifinales:', err));
    _live.semis.push(unsub);
}

function _attachFinsLive() {
    if (_live.fins.length) return;
    const tid = getActiveTournamentId();
    if (!tid) return;
    const subscribedIds = new Set();
    const unsub = onSnapshot(collection(db, 'torneos', tid, 'finales'), (snap) => {
        snap.docs.forEach(docSnap => {
            const data = { id: docSnap.id, ...normalizeFields(docSnap.data()) };
            const existing = allFinales.find(f => f.id === docSnap.id);
            if (existing) {
                Object.assign(existing, data);
            } else {
                allFinales.push({ ...data, partidos: [] });
            }
            if (!subscribedIds.has(docSnap.id)) {
                subscribedIds.add(docSnap.id);
                const pUnsub = onSnapshot(
                    collection(db, 'torneos', tid, 'finales', docSnap.id, 'partidos'),
                    (pSnap) => {
                        const f = allFinales.find(x => x.id === docSnap.id);
                        if (f) f.partidos = pSnap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
                        schedulePublicRender();
                    },
                    (err) => console.error('Error en listener partidos final:', err)
                );
                _live.fins.push(pUnsub);
            }
        });
        schedulePublicRender();
    }, (err) => console.error('Error en listener finales:', err));
    _live.fins.push(unsub);
}

function _syncLive(tabId) {
    const want = new Set();
    if (tabId === 'posiciones' || tabId === 'resultados') want.add('rr');
    if (tabId === 'posiciones' || tabId === 'semifinales' || tabId === 'final') want.add('semis');
    if (tabId === 'posiciones' || tabId === 'final') want.add('fins');
    ['rr', 'semis', 'fins'].forEach(k => { if (!want.has(k)) _detachLive(k); });
    if (want.has('rr')) _attachRRLive();
    if (want.has('semis')) _attachSemisLive();
    if (want.has('fins')) _attachFinsLive();
}

// ── Render coalescido: los snapshots agrupan actualizaciones en un frame ──
let _renderQueued = false;
function schedulePublicRender() {
    if (_renderQueued) return;
    _renderQueued = true;
    requestAnimationFrame(() => {
        _renderQueued = false;
        const t = _currentTab;
        try {
            if (t === 'posiciones' && _loaded.partidos && _loaded.jugadores) renderPosiciones();
            else if (t === 'resultados' && _loaded.partidos && _loaded.jugadores) renderResultados();
            else if (t === 'semifinales' && _loaded.semis) renderSemifinalesPublic();
            else if (t === 'final' && _loaded.fins) renderFinalPublic();
        } catch (e) {
            console.error('Error en render programado:', e);
        }
    });
}

function _resetAllData() {
    _detachAllLive();
    _gen++;
    allJugadores = [];
    allEquipos = [];
    allJornadas = [];
    allEnfrentamientos = [];
    allPartidosEliminatoria = [];
    allSemifinales = [];
    allFinales = [];
    Object.keys(_jornadaPartidos).forEach(k => delete _jornadaPartidos[k]);
    Object.keys(_loaded).forEach(k => { _loaded[k] = false; });
    Object.keys(_pending).forEach(k => { delete _pending[k]; });
    _dataLoaded = false;
    _currentTab = null;
}

async function reloadAllData() {
    const tab = _currentTab || 'posiciones';
    _resetAllData();
    await _renderTab(tab);
}


// ── Posiciones ──
function renderPosiciones() {
    const el = document.getElementById('posiciones');
    if (!allEquipos.length) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Aún no hay equipos configurados</p></div>';
        return;
    }

    const result = calculateStandings(allEquipos, allEnfrentamientos);
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

    // Header de stats (columnas alineadas con las filas via .pos-table)
    html += '<div class="card pos-table pos-head">' +
        '<div class="pos-row">' +
        '<div class="pos-num"></div>' +
        '<div style="flex:1;min-width:0;"></div>' +
        '<div class="pos-stats">' +
        '<div class="pos-stat"><span class="pos-head-label" style="color:var(--on-surface-variant-40);">JJ</span></div>' +
        '<div class="pos-stat"><span class="pos-head-label" style="color:var(--primary);">JG</span></div>' +
        '<div class="pos-stat"><span class="pos-head-label" style="color:var(--on-surface-variant-40);">PJ</span></div>' +
        '<div class="pos-stat"><span class="pos-head-label" style="color:var(--secondary);">PG</span></div>' +
        '<div class="pos-stat"><span class="pos-head-label" style="color:var(--on-surface-variant-40);">PP</span></div>' +
        '<div class="pos-stat"><span class="pos-head-label" style="color:var(--primary);">PTS</span></div>' +
        '</div>' +
        '<div class="pos-chev-spacer"></div>' +
        '</div>' +
        '</div>';

    // Standings cards (drill-down igual que en Estadísticas)
    standings.forEach((s, i) => {
        const isQualified = i < 4;
        const qualBorder = isQualified ? 'border-left:4px solid ' + s.color + ';' : 'border-left:4px solid var(--white-8);';
        const eq = allEquipos.find(e => e.id === s.id);
        const isOpen = _openEquipoId === s.id;
        const jugadoresHtml = eq ? _renderJugadoresDeEquipoHtml(eq) : '<div class="sin-partidos">Sin jugadores asignados</div>';

        html += '<div class="card-equipos pos-standings pos-table' + (isQualified ? ' q-clas' : '') + (isOpen ? ' open' : '') + '" data-eq-id="' + s.id + '" style="' + qualBorder + '">' +
            '<div class="equipo-header">' +
                '<div class="pos-row">' +
                    '<div class="pos-num">' +
                        '<div style="font-family:Lexend;font-weight:800;font-size:1rem;color:' + (isQualified ? s.color : 'var(--on-surface-variant-40)') + ';">' + s.posicion + 'º</div>' +
                    '</div>' +
                    '<div style="flex:1;display:flex;align-items:center;gap:0.4rem;min-width:0;">' +
                        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + s.color + ';flex-shrink:0;"></span>' +
                        '<span style="font-family:Lexend;font-weight:600;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.nombre) + '</span>' +
                    '</div>' +
                    '<div class="pos-stats">' +
                        '<div class="pos-stat"><div style="font-family:Lexend;font-weight:700;font-size:0.9rem;">' + s.jornadas_disputadas + '</div></div>' +
                        '<div class="pos-stat"><div style="font-family:Lexend;font-weight:700;font-size:0.9rem;color:var(--primary);">' + s.jornadas_ganadas + '</div></div>' +
                        '<div class="pos-stat"><div style="font-family:Lexend;font-weight:700;font-size:0.9rem;">' + s.partidos_jugados + '</div></div>' +
                        '<div class="pos-stat"><div style="font-family:Lexend;font-weight:700;font-size:0.9rem;color:var(--secondary);">' + s.partidos_ganados + '</div></div>' +
                        '<div class="pos-stat"><div style="font-family:Lexend;font-weight:700;font-size:0.9rem;">' + s.partidos_perdidos + '</div></div>' +
                        '<div class="pos-stat"><div style="font-family:Lexend;font-weight:800;font-size:1rem;color:var(--primary);">' + s.puntos + '</div></div>' +
                    '</div>' +
                    '<span class="material-symbols-outlined chev">expand_more</span>' +
                '</div>' +
                (isQualified ? '<div class="pos-clasif"><span class="material-symbols-outlined" style="font-size:0.55rem;vertical-align:middle;">emoji_events</span> CLASIFICADO</div>' : '') +
                '<span class="equipo-hint">Clic para detalles</span>' +
            '</div>' +
            '<div class="equipo-body">' + jugadoresHtml + '</div>' +
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

    el.innerHTML = html;

    // Toggles incrementales para el drill-down de posiciones
    _bindDrilldownToggles(el);
}

// ── renderPartidoCard helper (reutilizado en Resultados, Semifinales y Final) ──
function renderPartidoCard(p, faseLabel, aColorOverride, bColorOverride, fechaStr) {
    const rs = getPublicRs(p);
    const scores = formatPlayerScore(rs);
    const aColor = aColorOverride || getTeamColor(p.equipo_a_id) || 'var(--team)';
    const bColor = bColorOverride || getTeamColor(p.equipo_b_id) || 'var(--secondary)';

    const j1 = getJugadorNombre(p.jugador_a_1_id);
    const j2 = getJugadorNombre(p.jugador_a_2_id);
    const j3 = getJugadorNombre(p.jugador_b_1_id);
    const j4 = getJugadorNombre(p.jugador_b_2_id);
    const aNames = (j1 && j2) ? (j1 + ' / ' + j2) : (p.equipo_a_nombre || '—');
    const bNames = (j3 && j4) ? (j3 + ' / ' + j4) : (p.equipo_b_nombre || '—');

    const catLabel = formatCategoria(p.categoria || 'PARTIDO');
    const live = p.estado !== 'finalizado';
    const liveBadge = live
        ? ' <span class="res-live-badge"><span class="res-live-dot"></span>EN CURSO</span>'
        : ' <span class="res-final-badge"><span class="res-final-dot"></span>FINALIZADO</span>';

    const headerParts = [];
    if (fechaStr) headerParts.push('<span class="res-meta-date">' + esc(fechaStr) + '</span>');
    headerParts.push('<span class="res-meta-jornada">' + esc(faseLabel) + '</span>');
    headerParts.push('<span class="res-meta-category">' + esc(catLabel) + '</span>');

    const ganadorId = deriveGanadorId(p);
    const ganadorNombre = ganadorId === p.equipo_a_id
        ? (p.equipo_a_nombre || getTeamName(p.equipo_a_id))
        : (ganadorId === p.equipo_b_id ? (p.equipo_b_nombre || getTeamName(p.equipo_b_id)) : null);
    const ganadorColor = ganadorId === p.equipo_a_id ? aColor : bColor;

    const teamA = p.equipo_a_nombre || '';
    const teamB = p.equipo_b_nombre || '';

    return '<div class="res-public-card' + (live ? ' res-public-card-live' : '') + '">' +
        '<div class="res-public-header">' + headerParts.join(' · ') + liveBadge + '</div>' +
        '<div class="res-public-player">' +
        '<div class="res-public-dot" style="background:' + aColor + ';"></div>' +
        '<div>' +
        (teamA ? '<div class="res-public-team">' + esc(teamA) + '</div>' : '') +
        '<div class="res-public-name">' + esc(aNames) + '</div>' +
        '</div>' +
        '<div class="res-public-score">' + renderScoreTokens(scores.a) + '</div>' +
        '</div>' +
        '<div class="res-public-player">' +
        '<div class="res-public-dot" style="background:' + bColor + ';"></div>' +
        '<div>' +
        (teamB ? '<div class="res-public-team">' + esc(teamB) + '</div>' : '') +
        '<div class="res-public-name">' + esc(bNames) + '</div>' +
        '</div>' +
        '<div class="res-public-score">' + renderScoreTokens(scores.b) + '</div>' +
        '</div>' +
        (ganadorNombre
            ? '<div class="res-winner-declaration"><span class="res-winner-label">Ganó</span> <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + ganadorColor + ';vertical-align:middle;margin-right:0.3rem;"></span><span class="res-winner-name">' + esc(ganadorNombre) + '</span></div>'
            : '') +
        '</div>';
}

// ── Resultados (scoreboard público) ──
function renderResultados() {
    const el = document.getElementById('resultados');
    const partidos = allPartidosEliminatoria;

    if (!partidos.length) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">sports_tennis</span><p>Aún no hay partidos cargados</p></div>';
        return;
    }

    // Group by jornada
    const jornadasMap = {};
    partidos.forEach(p => {
        const key = p._jornadaId || 'unknown';
        if (!jornadasMap[key]) {
            jornadasMap[key] = {
                numero: p._jornadaNumero || '?',
                fecha: p._jornadaFecha,
                partidos: []
            };
        }
        jornadasMap[key].partidos.push(p);
    });

    const sortedJornadas = Object.entries(jornadasMap).sort((a, b) => {
        return (a[1].numero || 0) - (b[1].numero || 0);
    });

    let html = '<input type="text" id="result-search-public" class="search-input" placeholder="Buscar por nombre de jugador...">';

    sortedJornadas.forEach(([jId, jornada]) => {
        const jornadaName = 'Jornada ' + esc(String(jornada.numero));
        const fechaStr = formatDate(jornada.fecha) || '';

        // En curso primero, finalizados después
        const sorted = jornada.partidos.slice().sort((a, b) => {
            const sa = a.estado === 'finalizado' ? 1 : 0;
            const sb = b.estado === 'finalizado' ? 1 : 0;
            return sa - sb;
        });

        sorted.forEach(p => {
            html += renderPartidoCard(p, jornadaName, null, null, fechaStr);
        });
    });

    el.innerHTML = html;

    const resultSearch = document.getElementById('result-search-public');
    if (resultSearch) {
        resultSearch.addEventListener('input', () => {
            clearTimeout(resultSearch._debounce);
            resultSearch._debounce = setTimeout(() => {
                const term = resultSearch.value.toLowerCase();
                document.querySelectorAll('.res-public-card').forEach(card => {
                    card.style.display = card.textContent.toLowerCase().includes(term) ? '' : 'none';
                });
            }, 150);
        });
    }
}


// ── Inicio ──
function renderInicio() {
    const el = document.getElementById('inicio');
    if (!getActiveTournament()) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">info</span><p>No hay torneo activo configurado</p></div>';
        return;
    }
    el.innerHTML = `
        <div class="card info-card">
            <div class="info-title">
                <span class="material-symbols-outlined">home</span> Información del Torneo
            </div>
            <div class="info-hero">
                <div class="info-ball">&#127934;</div>
                <h2 class="info-name">Torneo de Colores</h2>
                <p class="info-desc">Encuentro deportivo para compartir, competir y disfrutar del tenis.</p>
            </div>
            <div class="info-divider"></div>
            <div class="info-section">
                <span class="material-symbols-outlined info-section-icon">groups</span>
                <div class="info-section-content">
                    <div class="info-section-title">Colaboradores</div>
                    <div class="info-section-label">Socios</div>
                    <div class="info-section-body">Andrés &middot; Jonathan &middot; Luis &middot; Sergio &middot; Daniel</div>
                </div>
            </div>
            <div class="info-divider"></div>
            <div class="info-section">
                <span class="info-section-icon">&#128187;</span>
                <div class="info-section-content">
                    <div class="info-section-title">Desarrollado por</div>
                    <div class="info-section-body">JDM Group Tech.</div>
                </div>
            </div>
            <div class="info-footer">
                <span class="info-footer-icon">&#128154;</span> Hecho con pasión por el tenis
            </div>
        </div>
        <div class="card" style="border-top:4px solid var(--secondary);margin-top:1rem;">
            <div style="font-family:Lexend;font-weight:600;font-size:0.95rem;color:var(--secondary);margin-bottom:0.75rem;">
                <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">groups</span> Acceso Rápido
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;">
                <button class="btn btn-outline" onclick="showTab('posiciones')">
                    <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">leaderboard</span> Posiciones
                </button>
                <button class="btn btn-outline" onclick="showTab('resultados')">
                    <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">history</span> Resultados
                </button>
                <button class="btn btn-outline" onclick="showTab('jornadas')">
                    <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">event</span> Jornadas
                </button>
            </div>
        </div>
    `;
}

// ── Equipos (drill-down) ──
let _openEquipoId = null;
let _openJugadorId = null;

function _jugadorNombre(jugId) {
    if (!jugId) return '';
    const j = allJugadores.find(x => x.id === jugId);
    return j ? esc(shortName(j)) : '';
}

function _partidosDelJugador(jugId) {
    const partidos = [];
    const add = (p, fuente, jornadaId, jornadaNum, jornadaFecha) => {
        const ids = [
            p.jugador_a_1_id, p.jugador_a_2_id, p.jugador_b_1_id, p.jugador_b_2_id
        ].filter(Boolean);
        if (ids.includes(jugId)) {
            partidos.push({ p, fuente, jornadaId, jornadaNum, jornadaFecha });
        }
    };

    allEnfrentamientos.forEach(f => {
        (f.partidos || []).forEach(p => {
            add(p, 'roundRobin', f._jornadaId, f._jornadaNumero, f._jornadaFecha);
        });
    });
    allSemifinales.forEach(s => {
        const ids = [s.jugador_a_1_id, s.jugador_a_2_id, s.jugador_b_1_id, s.jugador_b_2_id].filter(Boolean);
        if (ids.includes(jugId)) partidos.push({ p: s, fuente: 'semifinal', jornadaId: null, jornadaNum: null, jornadaFecha: null });
    });
    allFinales.forEach(f => {
        const ids = [f.jugador_a_1_id, f.jugador_a_2_id, f.jugador_b_1_id, f.jugador_b_2_id].filter(Boolean);
        if (ids.includes(jugId)) partidos.push({ p: f, fuente: 'final', jornadaId: null, jornadaNum: null, jornadaFecha: null });
    });

    return partidos.sort((a, b) => {
        if (a.jornadaNum !== b.jornadaNum) return (a.jornadaNum || 0) - (b.jornadaNum || 0);
        return a.fuente.localeCompare(b.fuente);
    });
}

function _renderJugadorPartidos(jugId, equipoId) {
    const partidos = _partidosDelJugador(jugId);
    if (!partidos.length) {
        return '<div class="sin-partidos">Aún no jugó ningún partido.</div>';
    }
    return partidos.map(({ p, fuente, jornadaNum, jornadaFecha }) => {
        const isEquipoA = (p.equipo_a_id || p.equipo_local_id) === equipoId;
        const miEquipoId = isEquipoA ? (p.equipo_a_id || p.equipo_local_id) : (p.equipo_b_id || p.equipo_visitante_id);
        const oEquipoId = isEquipoA ? (p.equipo_b_id || p.equipo_visitante_id) : (p.equipo_a_id || p.equipo_local_id);

        const misJugadores = isEquipoA
            ? [p.jugador_a_1_id, p.jugador_a_2_id]
            : [p.jugador_b_1_id, p.jugador_b_2_id];
        const oJugadores = isEquipoA
            ? [p.jugador_b_1_id, p.jugador_b_2_id]
            : [p.jugador_a_1_id, p.jugador_a_2_id];

        const pareja = misJugadores.filter(id => id && id !== jugId).map(_jugadorNombre).join(' / ') || '—';
        const oponente = oJugadores.map(_jugadorNombre).join(' / ') || '—';

        let resultClass = 'pending';
        let resultText = 'Pendiente';
        const gId = deriveGanadorId(p);
        if (gId) {
            resultClass = gId === miEquipoId ? 'win' : 'lose';
            resultText = gId === miEquipoId ? 'Ganado' : 'Perdido';
        }

        const scoreParts = [];
        if (p.set1_a != null && p.set1_b != null) scoreParts.push(p.set1_a + ' - ' + p.set1_b);
        if (p.set2_a != null && p.set2_b != null) scoreParts.push(p.set2_a + ' - ' + p.set2_b);
        if (p.supertiebreak_a != null && p.supertiebreak_b != null) scoreParts.push('(' + p.supertiebreak_a + ' - ' + p.supertiebreak_b + ')');
        const scoreStr = scoreParts.join('  ');

        const catTxt = formatCategoria(p.categoria || '');
        let headerLine = catTxt;
        if (jornadaNum != null) headerLine += ' · Jornada ' + jornadaNum;
        if (fuente === 'semifinal') headerLine = 'Semifinal ' + headerLine;
        else if (fuente === 'final') headerLine = 'Final ' + headerLine;

        return '<div class="partido-card">' +
            '<div class="partido-header">' +
                '<span>' + esc(headerLine) + '</span>' +
                '<span class="partido-result ' + resultClass + '">' + esc(resultText) + '</span>' +
            '</div>' +
            (scoreStr ? '<div class="partido-score">' + esc(scoreStr) + '</div>' : '') +
            '<div class="partido-meta"><span>Con:</span> ' + esc(pareja) + '</div>' +
            '<div class="partido-meta"><span>vs:</span> ' + esc(oponente) + '</div>' +
            '</div>';
    }).join('');
}

function _jugadorNombreBasico(jugId) {
    if (!jugId) return '';
    const j = allJugadores.find(x => x.id === jugId);
    return j ? esc(shortName(j)) : '';
}

// ── Helpers de drill-down equipo → jugadores → partidos (Posiciones) ──
function _getJugadoresDeEquipo(eq) {
    return allJugadores
        .filter(j => j.equipo_id === eq.id)
        .sort((a, b) => {
            const nA = ((a.nombre || '') + ' ' + (a.apellidos || '')).toLowerCase();
            const nB = ((b.nombre || '') + ' ' + (b.apellidos || '')).toLowerCase();
            return nA.localeCompare(nB);
        });
}

function _renderJugadoresDeEquipoHtml(eq) {
    const jugadoresEq = _getJugadoresDeEquipo(eq);
    if (!jugadoresEq.length) return '<div class="sin-partidos">Sin jugadores asignados</div>';
    return jugadoresEq.map(j => {
        const jOpen = _openJugadorId === j.id;
        const body = jOpen ? _renderJugadorPartidos(j.id, eq.id) : '';
        return '<div class="jugador-card' + (jOpen ? ' open' : '') + '" data-jug-id="' + j.id + '">' +
            '<div class="jugador-header">' +
                '<span class="jugador-name">' + esc(shortName(j)) + '</span>' +
                '<span class="material-symbols-outlined jugador-chev">expand_more</span>' +
            '</div>' +
            '<div class="jugador-meta">' +
                (j.categoria ? '<span class="badge" style="background:var(--primary-12);color:var(--primary);font-size:0.6rem;">' + esc(j.categoria) + '</span>' : '') +
            '</div>' +
            '<div class="jugador-body" data-eq-id="' + eq.id + '"' + (jOpen ? ' data-filled="1"' : '') + '>' + body + '</div>' +
        '</div>';
    }).join('');
}

function _bindDrilldownToggles(scopeEl) {
    scopeEl.querySelectorAll('.card-equipos > .equipo-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.parentElement;
            const id = card.dataset.eqId;
            const opening = !card.classList.contains('open');
            scopeEl.querySelectorAll('.card-equipos.open').forEach(c => {
                if (c !== card) {
                    c.classList.remove('open');
                    c.querySelectorAll('.jugador-card.open').forEach(jc => jc.classList.remove('open'));
                }
            });
            card.querySelectorAll('.jugador-card.open').forEach(jc => jc.classList.remove('open'));
            _openJugadorId = null;
            if (opening) {
                card.classList.add('open');
                _openEquipoId = id;
            } else {
                card.classList.remove('open');
                _openEquipoId = null;
            }
        });
    });

    scopeEl.querySelectorAll('.card-equipos .jugador-card > .jugador-header').forEach(header => {
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = header.parentElement;
            const jugId = card.dataset.jugId;
            const body = card.querySelector('.jugador-body');
            const equipoId = body ? body.dataset.eqId : null;
            const opening = !card.classList.contains('open');
            const list = card.closest('.equipo-body');
            if (list) list.querySelectorAll('.jugador-card.open').forEach(c => { if (c !== card) c.classList.remove('open'); });
            if (opening) {
                card.classList.add('open');
                _openJugadorId = jugId;
                if (body && body.dataset.filled !== '1') {
                    body.innerHTML = _renderJugadorPartidos(jugId, equipoId);
                    body.dataset.filled = '1';
                }
            } else {
                card.classList.remove('open');
                _openJugadorId = null;
            }
        });
    });
}

// ── Tab Switching (lazy: cada pestaña asegura solo sus datos) ──
async function _renderTab(tabId) {
    if (_currentTab === tabId) return;
    _currentTab = tabId;
    const g = _gen;
    document.querySelectorAll('.tab-nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    const tabBtn = document.querySelector('[data-tab="' + tabId + '"]');
    if (tabBtn) tabBtn.classList.add('active');
    const content = document.getElementById(tabId);
    if (content) content.classList.add('active');

    if (tabId === 'inicio') {
        try { await ensureBase(); } catch (e) { console.error('Error cargando config:', e); }
        if (_currentTab !== tabId || g !== _gen) return;
        _syncLive(tabId);
        renderInicio();
        return;
    }

    let ready;
    if (tabId === 'posiciones') ready = Promise.all([ensureJugadores(), ensurePartidos(), ensureSemis(), ensureFins()]);
    else if (tabId === 'resultados') ready = Promise.all([ensureJugadores(), ensurePartidos()]);
    else if (tabId === 'semifinales') ready = ensureSemis();
    else if (tabId === 'final') ready = Promise.all([ensureSemis(), ensureFins()]);
    else ready = Promise.resolve();

    const dataReady =
        tabId === 'posiciones' ? (_loaded.partidos && _loaded.jugadores) :
        tabId === 'resultados' ? (_loaded.partidos && _loaded.jugadores) :
        tabId === 'semifinales' ? _loaded.semis :
        tabId === 'final' ? (_loaded.fins && _loaded.semis) : true;
    if (!dataReady && content) content.innerHTML = loadingHTML;

    try {
        await ready;
    } catch (e) {
        console.error('Error loading tab data:', e);
        if (_currentTab === tabId && g === _gen && content) {
            content.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined" style="color:var(--error);">error</span><p>Error al cargar datos. Verifica la conexión.</p></div>';
        }
        return;
    }
    if (_currentTab !== tabId || g !== _gen) return;

    if (tabId === 'posiciones') renderPosiciones();
    else if (tabId === 'resultados') renderResultados();
    else if (tabId === 'semifinales') renderSemifinalesPublic();
    else if (tabId === 'final') renderFinalPublic();
    _syncLive(tabId);
}

window.showTab = function(tabId) {
    history.pushState({ tab: tabId }, '', '#' + tabId);
    _renderTab(tabId);
};

const VALID_TABS = ['posiciones', 'resultados', 'semifinales', 'final', 'inicio'];

function _sanitizeTab(tab) {
    if (tab === 'equipos') return 'posiciones';
    return VALID_TABS.includes(tab) ? tab : 'posiciones';
}

window.addEventListener('popstate', () => {
    const tab = (history.state && history.state.tab) || location.hash.replace('#', '') || 'posiciones';
    _renderTab(_sanitizeTab(tab));
});

// ── Public Tournament Selector ──
let _tournamentList = [];

async function loadTournamentList() {
    const ids = getActiveTournamentIds();
    if (!ids.length) { _tournamentList = []; return; }
    if (ids.length <= 1) {
        const t = getActiveTournament();
        _tournamentList = ids.map(id => ({ id, name: (t && t.id === id) ? (t.name || t.nombre || id) : id }));
        return;
    }
    try {
        const snaps = await Promise.all(ids.map(id => getDoc(doc(db, 'torneos', id))));
        _tournamentList = snaps.filter(s => s.exists()).map(s => ({ id: s.id, name: s.data().name || s.data().nombre }));
    } catch (e) {
        _tournamentList = [];
    }
}

function updatePublicTournamentSelector() {
    const wrap = document.getElementById('public-tournament-selector-wrap');
    const sel = document.getElementById('public-tournament-selector');
    if (!wrap || !sel) return;
    const ids = getActiveTournamentIds();
    if (ids.length <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const currentId = getActiveTournamentId();
    sel.innerHTML = ids.map(id => {
        const t = _tournamentList.find(x => x.id === id);
        return '<option value="' + id + '"' + (id === currentId ? ' selected' : '') + '>' + (t ? t.name : id) + '</option>';
    }).join('');
}

function initPublicTournamentSelector() {
    const sel = document.getElementById('public-tournament-selector');
    if (!sel) return;
    sel.addEventListener('change', async () => {
        const newId = sel.value;
        if (newId === getActiveTournamentId()) return;
        try {
            await setSelectedTournament(newId);
            const prevTab = _currentTab;
            _resetAllData();
            updatePublicTournamentSelector();
            await _renderTab(prevTab || 'posiciones');
        } catch (e) {
            console.error('Error switching tournament:', e);
        }
    });
}

// ── Initial Load ──
async function init() {
    try {
        const initialTab = _sanitizeTab(location.hash.replace('#', ''));
        history.replaceState({ tab: initialTab }, '', '#' + initialTab);
        _renderTab(initialTab);
        await ensureBase();
        if (getActiveTournamentIds().length > 1) await loadTournamentList();
        initPublicTournamentSelector();
        updatePublicTournamentSelector();
    } catch (e) {
        console.error('Error loading initial data:', e);
        const el = document.getElementById(_currentTab || 'posiciones');
        if (el) el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined" style="color:var(--error);">error</span><p>Error al cargar datos. Verifica la conexión.</p></div>';
    }
}

function renderSemifinalesPublic() {
    const el = document.getElementById('semifinales');

    if (!allSemifinales.length) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">emoji_events</span><p>Semifinales no disponibles.<br>Las semifinales se generan al finalizar el Round Robin.</p></div>';
        return;
    }

    let html = '';
    const sortedSemis = [...allSemifinales].sort((a, b) => (a.numero || 0) - (b.numero || 0));

    sortedSemis.forEach(semi => {
        const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
        const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';

        let aWins = 0, bWins = 0;
        semi.partidos.forEach(p => {
            const g = deriveGanadorId(p);
            if (g === semi.equipo_a_id) aWins++;
            else if (g === semi.equipo_b_id) bWins++;
        });

        const ganadorId = semi.ganador_equipo_id;
        const ganadorNombre = ganadorId === semi.equipo_a_id ? semi.equipo_a_nombre :
                              ganadorId === semi.equipo_b_id ? semi.equipo_b_nombre : null;
        const ganadorColor = ganadorId === semi.equipo_a_id ? aColor : bColor;
        const borderColor = ganadorNombre ? ganadorColor : 'var(--primary)';

        html += '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;margin:1rem 0 0.5rem;color:var(--primary);">' +
            '<span class="material-symbols-outlined" style="font-size:0.85rem;vertical-align:middle;">emoji_events</span> SEMIFINAL ' + (semi.numero || '?') +
            '</div>';

        html += '<div class="card" style="border-left:4px solid ' + borderColor + ';margin-bottom:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.4rem;">' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
            '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + aColor + ';"></span>' +
            esc(semi.equipo_a_nombre || '?') + (semi.equipo_a_posicion ? ' <span style="font-size:0.65rem;color:var(--on-surface-variant-40);font-weight:400;">(' + semi.equipo_a_posicion + 'º)</span>' : '') +
            '</span>' +
            '<span style="font-family:Lexend;font-weight:800;font-size:0.75rem;color:var(--on-surface-variant-40);">VS</span>' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
            '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + bColor + ';"></span>' +
            esc(semi.equipo_b_nombre || '?') + (semi.equipo_b_posicion ? ' <span style="font-size:0.65rem;color:var(--on-surface-variant-40);font-weight:400;">(' + semi.equipo_b_posicion + 'º)</span>' : '') +
            '</span>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span style="font-size:0.75rem;font-family:Lexend;font-weight:600;">' + aWins + ' - ' + bWins + '</span>' +
            (ganadorNombre
                ? '<span class="badge badge-success"><span class="material-symbols-outlined" style="font-size:0.6rem;">emoji_events</span> ' + esc(ganadorNombre) + '</span>'
                : '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + semi.partidos.filter(p => p.estado === 'finalizado').length + '/' + (semi.partidos_esperados || 7) + ' partidos</span>') +
            '</div>' +
            '</div>';

        const faseLabel = 'Semifinal ' + (semi.numero || '?');
        const sortedPartidos = semi.partidos.slice().sort((a, b) => {
            const sa = a.estado === 'finalizado' ? 1 : 0;
            const sb = b.estado === 'finalizado' ? 1 : 0;
            return sa - sb;
        });
        sortedPartidos.forEach(p => {
            html += renderPartidoCard(p, faseLabel, aColor, bColor);
        });
    });

    el.innerHTML = html;
}

function renderFinalPublic() {
    const el = document.getElementById('final');

    if (!allFinales.length) {
        const finishedSemis = allSemifinales.filter(s => s.estado === 'finalizado');
        if (finishedSemis.length < 2) {
            el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">workspace_premium</span><p>Final pendiente.<br>Se habilitará al completar ambas semifinales.</p></div>';
        } else {
            el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">workspace_premium</span><p>Final pendiente.<br>El administrador aún no la ha generado.</p></div>';
        }
        return;
    }

    let html = '';

    allFinales.forEach(fin => {
        const aColor = fin.equipo_a_color || getTeamColor(fin.equipo_a_id) || '#888';
        const bColor = fin.equipo_b_color || getTeamColor(fin.equipo_b_id) || '#888';

        let aWins = 0, bWins = 0;
        fin.partidos.forEach(p => {
            const g = deriveGanadorId(p);
            if (g === fin.equipo_a_id) aWins++;
            else if (g === fin.equipo_b_id) bWins++;
        });

        const campeon = fin.ganador_equipo_id === fin.equipo_a_id ? fin.equipo_a_nombre :
                       fin.ganador_equipo_id === fin.equipo_b_id ? fin.equipo_b_nombre : null;
        const campeonColor = fin.ganador_equipo_id === fin.equipo_a_id ? aColor : bColor;

        html += '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;margin:1rem 0 0.5rem;color:var(--secondary);">' +
            '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">workspace_premium</span> 🏆 GRAN FINAL' +
            '</div>';

        html += '<div class="card" style="border-left:4px solid ' + (campeon ? campeonColor : 'var(--secondary)') + ';margin-bottom:0.75rem;">' +
            '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.4rem;">' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
            '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + aColor + ';"></span>' +
            esc(fin.equipo_a_nombre || '?') +
            '</span>' +
            '<span style="font-family:Lexend;font-weight:800;font-size:0.75rem;color:var(--on-surface-variant-40);">VS</span>' +
            '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
            '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + bColor + ';"></span>' +
            esc(fin.equipo_b_nombre || '?') +
            '</span>' +
            '</div>' +
            (campeon
                ? '<div style="margin:0.5rem 0;padding:0.5rem;background:rgba(255,255,255,0.05);border-radius:8px;text-align:center;">' +
                  '<div style="font-size:1.2rem;">🏆</div>' +
                  '<div style="font-family:Lexend;font-weight:800;font-size:0.95rem;color:' + campeonColor + ';">CAMPEÓN</div>' +
                  '<div style="display:flex;align-items:center;justify-content:center;gap:0.4rem;margin-top:0.2rem;">' +
                  '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + campeonColor + ';"></span>' +
                  '<span style="font-family:Lexend;font-weight:600;font-size:0.9rem;">' + esc(campeon) + '</span>' +
                  '</div></div>'
                : '') +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.4rem;">' +
            '<span style="font-size:0.75rem;font-family:Lexend;font-weight:600;">' + aWins + ' - ' + bWins + '</span>' +
            '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + fin.partidos.filter(p => p.estado === 'finalizado').length + '/' + (fin.partidos_esperados || 7) + ' partidos</span>' +
            '</div>' +
            '</div>';

        const sortedPartidos = fin.partidos.slice().sort((a, b) => {
            const sa = a.estado === 'finalizado' ? 1 : 0;
            const sb = b.estado === 'finalizado' ? 1 : 0;
            return sa - sb;
        });
        sortedPartidos.forEach(p => {
            html += renderPartidoCard(p, 'Gran Final', aColor, bColor);
        });
    });

    el.innerHTML = html;
}

// ── Tab Dropdown Logic ──
function setupTabDropdown() {
    const moreBtn = document.getElementById('tab-more-btn');
    const dropdown = document.getElementById('tab-dropdown');
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
        const tabBtn = e.target.closest('[data-tab]');
        if (tabBtn) {
            setTimeout(() => {
                const tabId = tabBtn.dataset.tab;
                dropdown.querySelectorAll('button').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tab === tabId);
                });
                document.querySelectorAll('.tab-nav > button[data-tab]').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tab === tabId);
                });
                closeDropdown();
            }, 0);
        }
    });
}

// Inicializar dropdown cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    setupTabDropdown();
});

init();


