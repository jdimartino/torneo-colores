import { getDocs, collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { db } from './firebase.js';
import { loadTournamentConfig, col, getActiveTournamentId, getActiveTournament, getActiveTournamentIds, setSelectedTournament, setActiveTournament, getBracketConfig } from './tournamentRefs.js';
import { calculateStandings } from './standings.js';
import { esc, shortName, formatDate, formatCategoria, makeTeamHelpers } from './utils.js';

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

let _dataLoaded = false;
let _resUnsubscribers = [];
let _semiUnsubscribers = [];
let _finalUnsubscribers = [];

function unsubscribeResultadosLive() {
    _resUnsubscribers.forEach(u => { try { u(); } catch (e) {} });
    _resUnsubscribers = [];
}

// Live listeners sobre jornadas/{id}/partidos (los que carga el admin en Resultados)
function setupResultadosLive() {
    unsubscribeResultadosLive();
    for (const jornada of allJornadas) {
        const col = collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornada.id, 'partidos');
        const unsub = onSnapshot(col, (snap) => {
            // Reconstruir los partidos de esta jornada en allPartidosEliminatoria
            allPartidosEliminatoria = allPartidosEliminatoria.filter(p => p._jornadaId !== jornada.id);
            snap.docs.forEach(d => {
                const p = { id: d.id, ...normalizeFields(d.data()) };
                p._jornadaId = jornada.id;
                p._jornadaNumero = jornada.numero;
                p._jornadaFecha = jornada.fecha;
                allPartidosEliminatoria.push(p);
            });
            // Si el tab Resultados está activo, re-renderizar en vivo
            const activeTab = document.querySelector('.tab-nav button.active')?.dataset.tab;
            if (activeTab === 'resultados') renderResultados();
        }, (err) => {
            console.error('Error en listener de resultados:', err);
        });
        _resUnsubscribers.push(unsub);
    }
}

async function loadAllData() {
    if (typeof window !== "undefined") { window._dbg = { jugadores: ()=>allJugadores, equipos: ()=>allEquipos, jornadas: ()=>allJornadas, loadAllData, reloadEquipos: ()=>renderEquipos(), get tournamentId(){return getActiveTournamentId();}, get dataLoaded(){return _dataLoaded;} }; }
    if (_dataLoaded) return;
    await loadTournamentConfig();
    if (!getActiveTournamentId()) return;
    try {
        const [jugSnap, equipSnap, jornSnap] = await Promise.all([
            getDocs(col('jugadores')),
            getDocs(col('equipos')),
            getDocs(col('jornadas'))
        ]);
        console.log('[public] jugadores docs:', jugSnap.docs.length, 'equipos docs:', equipSnap.docs.length, 'jornadas docs:', jornSnap.docs.length);
        allJugadores = jugSnap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        allEquipos = equipSnap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));
        allJornadas = jornSnap.docs.map(d => ({ id: d.id, ...normalizeFields(d.data()) }));

        // Exponer para debug
        if (typeof window !== 'undefined') {
            window._dbg = {
                jugadores: () => allJugadores,
                equipos: () => allEquipos,
                jornadas: () => allJornadas,
                loadAllData,
                reloadEquipos: () => renderEquipos(),
                get tournamentId() { return getActiveTournamentId(); },
                get dataLoaded() { return _dataLoaded; }
            };
        }

        // Load partidos by category (the ones the admin writes/scores) and build
        // enfrentamientos por jornada (misma fuente que el admin para posiciones)
        allEnfrentamientos = [];
        allPartidosEliminatoria = [];
        const enfrentamientosResults = await Promise.all(allJornadas.map(async jornada => {
            const directSnap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornada.id, 'partidos'));
            const directPartidos = [];
            directSnap.docs.forEach(d => {
                const p = { id: d.id, ...normalizeFields(d.data()) };
                p._jornadaId = jornada.id;
                p._jornadaNumero = jornada.numero;
                p._jornadaFecha = jornada.fecha;
                directPartidos.push(p);
            });
            return {
                jornada,
                partidos: directPartidos
            };
        }));

        enfrentamientosResults.forEach(({ jornada, partidos }) => {
            allPartidosEliminatoria.push(...partidos);
            allEnfrentamientos.push({
                id: jornada.id,
                equipo_a_id: jornada.equipo_a_id,
                equipo_b_id: jornada.equipo_b_id,
                _jornadaId: jornada.id,
                _jornadaNumero: jornada.numero,
                cerrada: jornada.cerrada === true,
                partidos
            });
        });
    } catch (e) {
        console.error('Error loading data:', e);
    }
    setupResultadosLive();
    setupSemifinalesLive();
    setupFinalesLive();
    _dataLoaded = true;
    window.dispatchEvent(new CustomEvent('appDataLoaded'));
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

    el.innerHTML = html;
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

    const ganadorId = p.ganador_equipo_id;
    const ganadorNombre = ganadorId === p.equipo_a_id
        ? (p.equipo_a_nombre || getTeamName(p.equipo_a_id))
        : (ganadorId === p.equipo_b_id ? (p.equipo_b_nombre || getTeamName(p.equipo_b_id)) : null);
    const ganadorColor = ganadorId === p.equipo_a_id ? aColor : bColor;

    return '<div class="res-public-card' + (live ? ' res-public-card-live' : '') + '">' +
        '<div class="res-public-header">' + headerParts.join(' · ') + liveBadge + '</div>' +
        '<div class="res-public-player">' +
        '<div class="res-public-dot" style="background:' + aColor + ';"></div>' +
        '<div><div class="res-public-name">' + esc(aNames) + '</div></div>' +
        '<div class="res-public-score">' + renderScoreTokens(scores.a) + '</div>' +
        '</div>' +
        '<div class="res-public-player">' +
        '<div class="res-public-dot" style="background:' + bColor + ';"></div>' +
        '<div><div class="res-public-name">' + esc(bNames) + '</div></div>' +
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
            const term = resultSearch.value.toLowerCase();
            document.querySelectorAll('.res-public-card').forEach(card => {
                card.style.display = card.textContent.toLowerCase().includes(term) ? '' : 'none';
            });
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
    const t = getActiveTournament();
    const bracketConfig = getBracketConfig();
    el.innerHTML = `
        <div class="card" style="border-top:4px solid var(--primary);">
            <div style="font-family:Lexend;font-weight:600;font-size:1.1rem;color:var(--primary);margin-bottom:0.75rem;">
                <span class="material-symbols-outlined" style="font-size:1.2rem;vertical-align:middle;">home</span> Información del Torneo
            </div>
            <div style="display:grid;gap:0.75rem;">
                <div class="card" style="padding:1rem;">
                    <div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">NOMBRE</div>
                    <div style="font-family:Lexend;font-weight:600;font-size:1rem;">${esc(t.name || 'Torneo de Colores')}</div>
                </div>
                <div class="card" style="padding:1rem;">
                    <div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">FECHA</div>
                    <div style="font-family:Lexend;font-weight:600;font-size:1rem;">${esc(t.fecha || 'Por definir')}</div>
                </div>
                <div class="card" style="padding:1rem;">
                    <div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">UBICACIÓN</div>
                    <div style="font-family:Lexend;font-weight:600;font-size:1rem;">${esc(t.ubicacion || 'Por definir')}</div>
                </div>
                <div class="card" style="padding:1rem;">
                    <div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">ESTADO</div>
                    <div style="font-family:Lexend;font-weight:600;font-size:1rem;">
                        <span class="badge badge-${t.status === 'active' ? 'success' : 'outline'}">${t.status === 'active' ? 'En curso' : t.status === 'closed' ? 'Finalizado' : 'Pendiente'}</span>
                    </div>
                </div>
                <div class="card" style="padding:1rem;">
                    <div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.2rem;">FORMATO</div>
                    <div style="font-family:Lexend;font-weight:600;font-size:1rem;">
                        Round Robin → ${bracketConfig.clasificados} clasificados → Semifinales → Final
                    </div>
                </div>
            </div>
        </div>
        <div class="card" style="border-top:4px solid var(--secondary);margin-top:1rem;">
            <div style="font-family:Lexend;font-weight:600;font-size:0.95rem;color:var(--secondary);margin-bottom:0.75rem;">
                <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">groups</span> Acceso Rápido
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;">
                <button class="btn btn-outline" onclick="showTab('equipos')">
                    <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">groups</span> Ver Equipos
                </button>
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
    allPartidosEliminatoria.forEach(p => {
        add(p, 'partido', p._jornadaId, p._jornadaNumero, p._jornadaFecha);
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
        if (p.ganador_equipo_id) {
            resultClass = p.ganador_equipo_id === miEquipoId ? 'win' : 'lose';
            resultText = p.ganador_equipo_id === miEquipoId ? 'Ganado' : 'Perdido';
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

function renderEquipos() {
    const el = document.getElementById('equipos');
    if (!allEquipos.length) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Aún no hay equipos configurados</p></div>';
        return;
    }
    let html = '<div class="equipos-list">';
    allEquipos.forEach(eq => {
        if (!eq.activo) return;
        const jugadoresEq = allJugadores.filter(j => j.equipo_id === eq.id);
        const isOpen = _openEquipoId === eq.id;
        const jugadoresHtml = jugadoresEq.length
            ? jugadoresEq.map(j => {
                const jOpen = _openJugadorId === j.id;
                const partidosHtml = _renderJugadorPartidos(j.id, eq.id);
                return '<div class="jugador-card' + (jOpen ? ' open' : '') + '" data-jug-id="' + j.id + '">' +
                    '<div class="jugador-header">' +
                        '<span class="jugador-name">' + esc(shortName(j)) + '</span>' +
                        '<span class="material-symbols-outlined jugador-chev">expand_more</span>' +
                    '</div>' +
                    '<div class="jugador-meta">' +
                        (j.categoria ? '<span class="badge" style="background:var(--primary-12);color:var(--primary);font-size:0.6rem;">' + esc(j.categoria) + '</span>' : '') +
                    '</div>' +
                    '<div class="jugador-body">' + partidosHtml + '</div>' +
                '</div>';
            }).join('')
            : '<div class="sin-partidos">Sin jugadores asignados</div>';

        html += '<div class="card-equipos' + (isOpen ? ' open' : '') + '" data-eq-id="' + eq.id + '">' +
            '<div class="equipo-header">' +
                '<span class="equipo-dot" style="background:' + esc(eq.color || '#888') + ';"></span>' +
                '<span class="equipo-title">' + esc(eq.nombre) + '</span>' +
                '<span class="equipo-count">' + jugadoresEq.length + '</span>' +
                '<span class="material-symbols-outlined chev">expand_more</span>' +
            '</div>' +
            '<div class="equipo-body">' + jugadoresHtml + '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html || '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>No hay equipos activos</p></div>';

    el.querySelectorAll('.card-equipos').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.jugador-card')) return;
            const id = card.dataset.eqId;
            _openEquipoId = (_openEquipoId === id) ? null : id;
            _openJugadorId = null;
            renderEquipos();
        });
    });

    el.querySelectorAll('.jugador-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const id = card.dataset.jugId;
            _openJugadorId = (_openJugadorId === id) ? null : id;
            renderEquipos();
        });
    });
}

// ── Tab Switching ──
function _renderTab(tabId) {
    document.querySelectorAll('.tab-nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    const tabBtn = document.querySelector('[data-tab="' + tabId + '"]');
    if (tabBtn) tabBtn.classList.add('active');
    const content = document.getElementById(tabId);
    if (content) content.classList.add('active');
    switch (tabId) {
        case 'inicio': renderInicio(); break;
        case 'equipos':
            if (_dataLoaded) {
                renderEquipos();
            } else {
                const el = document.getElementById('equipos');
                if (el) el.innerHTML = loadingHTML;
                window.addEventListener('appDataLoaded', () => renderEquipos(), { once: true });
            }
            break;
        case 'posiciones': renderPosiciones(); break;
        case 'resultados': renderResultados(); break;
        case 'semifinales': renderSemifinalesPublic(); break;
        case 'final': renderFinalPublic(); break;
    }
}

window.showTab = function(tabId) {
    history.pushState({ tab: tabId }, '', '#' + tabId);
    _renderTab(tabId);
};

window.addEventListener('popstate', () => {
    const tab = (history.state && history.state.tab) || location.hash.replace('#', '') || 'posiciones';
    _renderTab(tab);
});

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

// ── Public Tournament Selector ──
let _tournamentList = [];

async function loadTournamentList() {
    try {
        const snap = await getDocs(collection(db, 'torneos'));
        _tournamentList = snap.docs.map(d => ({ id: d.id, name: d.data().name }));
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
            _dataLoaded = false;
            await loadAllData();
            _renderTab(document.querySelector('.tab-nav button.active')?.dataset.tab || 'posiciones');
            updatePublicTournamentSelector();
        } catch (e) {
            console.error('Error switching tournament:', e);
        }
    });
}

// ── Initial Load ──
async function init() {
    try {
        const validTabs = ['posiciones', 'equipos', 'resultados', 'semifinales', 'final', 'inicio'];
        let initialTab = location.hash.replace('#', '');
        if (!validTabs.includes(initialTab)) {
            initialTab = 'posiciones';
        }
        history.replaceState({ tab: initialTab }, '', '#' + initialTab);
        _renderTab(initialTab);

        document.getElementById('posiciones').innerHTML = loadingHTML;
        await loadAllData();
        await loadTournamentList();
        initPublicTournamentSelector();
        updatePublicTournamentSelector();
        _renderTab(initialTab);
        setupTabScroll();
    } catch (e) {
        console.error('Error loading initial data:', e);
        document.getElementById('posiciones').innerHTML = '<div class="empty-state"><span class="material-symbols-outlined" style="color:var(--error);">error</span><p>Error al cargar datos. Verifica la conexión.</p></div>';
    }
}

function unsubscribeSemifinalesLive() {
    _semiUnsubscribers.forEach(u => { try { u(); } catch (e) {} });
    _semiUnsubscribers = [];
    allSemifinales = [];
}

function setupSemifinalesLive() {
    unsubscribeSemifinalesLive();
    const tid = getActiveTournamentId();
    if (!tid) return;

    const subscribedIds = new Set();

    const semiUnsub = onSnapshot(collection(db, 'torneos', tid, 'semifinales'), (snap) => {
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
                        const activeTab = document.querySelector('.tab-nav button.active')?.dataset.tab;
                        if (activeTab === 'semifinales') renderSemifinalesPublic();
                        if (activeTab === 'final') renderFinalPublic();
                    },
                    (err) => console.error('Error en listener partidos semifinal:', err)
                );
                _semiUnsubscribers.push(pUnsub);
            }
        });
        const activeTab = document.querySelector('.tab-nav button.active')?.dataset.tab;
        if (activeTab === 'semifinales') renderSemifinalesPublic();
        if (activeTab === 'final') renderFinalPublic();
    }, (err) => console.error('Error en listener semifinales:', err));

    _semiUnsubscribers.push(semiUnsub);
}

function unsubscribeFinalesLive() {
    _finalUnsubscribers.forEach(u => { try { u(); } catch (e) {} });
    _finalUnsubscribers = [];
    allFinales = [];
}

function setupFinalesLive() {
    unsubscribeFinalesLive();
    const tid = getActiveTournamentId();
    if (!tid) return;

    const subscribedIds = new Set();

    const finalUnsub = onSnapshot(collection(db, 'torneos', tid, 'finales'), (snap) => {
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
                        const activeTab = document.querySelector('.tab-nav button.active')?.dataset.tab;
                        if (activeTab === 'final') renderFinalPublic();
                    },
                    (err) => console.error('Error en listener partidos final:', err)
                );
                _finalUnsubscribers.push(pUnsub);
            }
        });
        const activeTab = document.querySelector('.tab-nav button.active')?.dataset.tab;
        if (activeTab === 'final') renderFinalPublic();
    }, (err) => console.error('Error en listener finales:', err));

    _finalUnsubscribers.push(finalUnsub);
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
            if (p.ganador_equipo_id === semi.equipo_a_id) aWins++;
            else if (p.ganador_equipo_id === semi.equipo_b_id) bWins++;
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
                : '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + semi.partidos.filter(p => p.estado === 'finalizado').length + '/7 partidos</span>') +
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
            if (p.ganador_equipo_id === fin.equipo_a_id) aWins++;
            else if (p.ganador_equipo_id === fin.equipo_b_id) bWins++;
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
            '<span style="font-size:0.68rem;color:var(--on-surface-variant-40);">' + fin.partidos.filter(p => p.estado === 'finalizado').length + '/7 partidos</span>' +
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

init();


