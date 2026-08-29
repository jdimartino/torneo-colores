import { getDocs, collection, query, where } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { db } from './firebase.js';
import { loadTournamentConfig, col, getActiveTournamentId, getActiveTournament, getActiveTournamentIds, setSelectedTournament, setActiveTournament, getBracketConfig } from './tournamentRefs.js';
import { calculateStandings } from './standings.js';
import { esc, shortName, formatDate, makeTeamHelpers } from './utils.js';

let allJugadores = [];
let allEquipos = [];
let allPartidos = [];
let allJornadas = [];
let allEnfrentamientos = [];
let allSemifinales = [];
let allFinales = [];

const _teamHelpers = makeTeamHelpers(() => allEquipos);
const getTeamName = _teamHelpers.getTeamName;
const getTeamColor = _teamHelpers.getTeamColor;

const loadingHTML = '<div class="panel-loading"><div class="tennis-ball-spinner"></div><div class="loading-text">Cargando datos del torneo...</div></div>';

function getJugadorNombre(jugId) {
    if (!jugId) return '';
    const j = allJugadores.find(j => j.id === jugId);
    return j ? ((j.nombre || '').split(' ')[0] + ' ' + (j.apellidos || '').split(' ')[0]) : '';
}

let _dataLoaded = false;
async function loadAllData() {
    if (_dataLoaded) return;
    await loadTournamentConfig();
    if (!getActiveTournamentId()) return;
    try {
        const [jugSnap, equipSnap, jornSnap] = await Promise.all([
            getDocs(col('jugadores')),
            getDocs(col('equipos')),
            getDocs(col('jornadas'))
        ]);
        allJugadores = jugSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        allEquipos = equipSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        allJornadas = jornSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Load partidos and enfrentamientos from nested structure
        allPartidos = [];
        allEnfrentamientos = [];
        for (const jornada of allJornadas) {
            const enfSnap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornada.id, 'enfrentamientos'));
            for (const enf of enfSnap.docs) {
                const enfData = { id: enf.id, ...enf.data(), _jornadaId: jornada.id, _jornadaNumero: jornada.numero, partidos: [] };
                const partSnap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'jornadas', jornada.id, 'enfrentamientos', enf.id, 'partidos'));
                for (const part of partSnap.docs) {
                    const partidoData = {
                        id: part.id,
                        _jornadaId: jornada.id,
                        _jornadaNumero: jornada.numero,
                        _jornadaFecha: jornada.fecha,
                        _enfrentamientoId: enf.id,
                        ...part.data()
                    };
                    allPartidos.push(partidoData);
                    enfData.partidos.push(partidoData);
                }
                allEnfrentamientos.push(enfData);
            }
        }
    } catch (e) {
        console.error('Error loading data:', e);
    }
    _dataLoaded = true;
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

    // Standings cards
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

    el.innerHTML = html;
}

// ── Resultados ──
function renderResultados() {
    const el = document.getElementById('resultados');
    const partidosFinalizados = allPartidos.filter(p => p.estado === 'finalizado');

    if (!partidosFinalizados.length) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">sports_tennis</span><p>Aún no hay resultados registrados</p></div>';
        return;
    }

    // Group by jornada
    const jornadasMap = {};
    partidosFinalizados.forEach(p => {
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

    // Sort jornadas by numero
    const sortedJornadas = Object.entries(jornadasMap).sort((a, b) => {
        return (a[1].numero || 0) - (b[1].numero || 0);
    });

    let html = '<input type="text" id="result-search-public" class="search-input" placeholder="Buscar por nombre de jugador...">';

    sortedJornadas.forEach(([jId, jornada]) => {
        html += '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;margin:1rem 0 0.5rem;color:var(--primary);">' +
            '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">event</span> Jornada ' + esc(String(jornada.numero)) +
            '<span style="font-size:0.72rem;color:var(--on-surface-variant-40);font-weight:400;margin-left:0.4rem;">' + esc(formatDate(jornada.fecha)) + '</span>' +
            '</div>';

        jornada.partidos.forEach(p => {
            const s1l = p.set1_local != null ? p.set1_local : 0;
            const s1v = p.set1_visitante != null ? p.set1_visitante : 0;
            const s2l = p.set2_local != null ? p.set2_local : 0;
            const s2v = p.set2_visitante != null ? p.set2_visitante : 0;
            const stbl = p.supertiebreak_local != null ? p.supertiebreak_local : null;
            const stbv = p.supertiebreak_visitante != null ? p.supertiebreak_visitante : null;

            const localName = p.equipo_local_nombre || getTeamName(p.equipo_local_id) || '—';
            const visitName = p.equipo_visitante_nombre || getTeamName(p.equipo_visitante_id) || '—';
            const localColor = getTeamColor(p.equipo_local_id);
            const visitColor = getTeamColor(p.equipo_visitante_id);

            const ganadorId = p.ganador_equipo_id;
            const localWins = ganadorId === p.equipo_local_id;
            const visitWins = ganadorId === p.equipo_visitante_id;

            const c1 = localWins ? 'state-win' : (visitWins ? 'state-lose' : 'state-tie');
            const c2 = visitWins ? 'state-win' : (localWins ? 'state-lose' : 'state-tie');

            // Player names
            const j1 = getJugadorNombre(p.jugador_local_1_id);
            const j2 = getJugadorNombre(p.jugador_local_2_id);
            const j3 = getJugadorNombre(p.jugador_visitante_1_id);
            const j4 = getJugadorNombre(p.jugador_visitante_2_id);

            html += '<div class="resultado-card">' +
                '<div style="font-size:0.65rem;color:var(--on-surface-variant-40);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:0.3rem;">' + esc(p.categoria || '') + '</div>' +
                '<div class="match-pair-row">' +
                '<div class="match-pair-name team-blue ' + c1 + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + localColor + ';margin-right:0.3rem;vertical-align:middle;"></span>' + esc(localName) + '</div>' +
                '<div class="match-pair-score team-blue ' + c1 + '">' + s1l + ' · ' + s2l + (stbl != null ? ' · ' + stbl : '') + '</div>' +
                '</div>' +
                '<div class="match-pair-divider"></div>' +
                '<div class="match-pair-row">' +
                '<div class="match-pair-name team-gold ' + c2 + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + visitColor + ';margin-right:0.3rem;vertical-align:middle;"></span>' + esc(visitName) + '</div>' +
                '<div class="match-pair-score team-gold ' + c2 + '">' + s1v + ' · ' + s2v + (stbv != null ? ' · ' + stbv : '') + '</div>' +
                '</div>' +
                '<div class="r-meta">' +
                '<span class="r-fecha">' + esc(j1 && j2 ? j1 + ' / ' + j2 : '') + ' vs ' + esc(j3 && j4 ? j3 + ' / ' + j4 : '') + '</span>' +
                '</div>' +
                '</div>';
        });
    });

    el.innerHTML = html;

    const resultSearch = document.getElementById('result-search-public');
    if (resultSearch) {
        resultSearch.addEventListener('input', () => {
            const term = resultSearch.value.toLowerCase();
            document.querySelectorAll('.resultado-card').forEach(card => {
                card.style.display = card.textContent.toLowerCase().includes(term) ? '' : 'none';
            });
        });
    }
}

// ── Jornadas ──
function renderJornadas() {
    const el = document.getElementById('jornadas');
    if (!allJornadas.length) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">event</span><p>Aún no hay jornadas creadas</p></div>';
        return;
    }
    el.innerHTML = allJornadas.map(j =>
        '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.5rem;">' +
        '<span class="material-symbols-outlined" style="font-size:0.9rem;color:var(--primary);">event</span>' +
        '<span style="font-family:Lexend;font-weight:600;font-size:0.85rem;">Jornada ' + (j.numero || '') + '</span>' +
        '</div>' +
        '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">' + esc(j.fecha || '') + '</div>' +
        '</div>'
    ).join('');
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

// ── Equipos ──
function renderEquipos() {
    const el = document.getElementById('equipos');
    if (!allEquipos.length) {
        el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Aún no hay equipos configurados</p></div>';
        return;
    }
    let html = '';
    allEquipos.forEach(eq => {
        if (!eq.activo) return;
        const jugadoresEq = allJugadores.filter(j => j.equipo_id === eq.id);
        html += `
            <div class="card" style="margin-bottom:0.75rem;border-left:4px solid ${esc(eq.color || '#888')};padding:1rem;">
                <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;">
                    <span style="display:inline-block;width:20px;height:20px;border-radius:50%;background:${esc(eq.color || '#888')};"></span>
                    <span style="font-family:Lexend;font-weight:600;font-size:1.1rem;">${esc(eq.nombre)}</span>
                </div>
                <div style="font-size:0.82rem;color:var(--on-surface-variant-40);margin-bottom:0.5rem;">
                    ${jugadoresEq.length} jugador${jugadoresEq.length !== 1 ? 'es' : ''}
                </div>
                ${jugadoresEq.length ? `
                    <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
                        ${jugadoresEq.map(j => '<span class="badge" style="background:var(--white-8);color:var(--on-surface);">' + esc(shortName(j)) + '</span>').join('')}
                    </div>
                ` : '<div style="font-size:0.75rem;color:var(--on-surface-variant-40);">Sin jugadores asignados</div>'}
            </div>
        `;
    });
    el.innerHTML = html || '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>No hay equipos activos</p></div>';
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
        case 'equipos': renderEquipos(); break;
        case 'posiciones': renderPosiciones(); break;
        case 'resultados': renderResultados(); break;
        case 'jornadas': renderJornadas(); break;
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
        document.getElementById('posiciones').innerHTML = loadingHTML;
        await loadAllData();
        await loadTournamentList();
        initPublicTournamentSelector();
        updatePublicTournamentSelector();
        const initialTab = location.hash.replace('#', '') || 'inicio';
        history.replaceState({ tab: initialTab }, '', '#' + initialTab);
        _renderTab(initialTab);
        setupTabScroll();
    } catch (e) {
        console.error('Error loading initial data:', e);
        document.getElementById('posiciones').innerHTML = '<div class="empty-state"><span class="material-symbols-outlined" style="color:var(--error);">error</span><p>Error al cargar datos. Verifica la conexión.</p></div>';
    }
}

async function loadSemifinalesPublic() {
    allSemifinales = [];
    if (!getActiveTournamentId()) return;
    try {
        const snap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'semifinales'));
        for (const docSnap of snap.docs) {
            const semi = { id: docSnap.id, ...docSnap.data(), partidos: [] };
            const partSnap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'semifinales', semi.id, 'partidos'));
            for (const p of partSnap.docs) {
                semi.partidos.push({ id: p.id, ...p.data() });
            }
            allSemifinales.push(semi);
        }
    } catch (e) {
        console.error('Error loading semifinales:', e);
    }
}

async function loadFinalesPublic() {
    allFinales = [];
    if (!getActiveTournamentId()) return;
    try {
        const snap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'finales'));
        for (const docSnap of snap.docs) {
            const fin = { id: docSnap.id, ...docSnap.data(), partidos: [] };
            const partSnap = await getDocs(collection(db, 'torneos', getActiveTournamentId(), 'finales', fin.id, 'partidos'));
            for (const p of partSnap.docs) {
                fin.partidos.push({ id: p.id, ...p.data() });
            }
            allFinales.push(fin);
        }
    } catch (e) {
        console.error('Error loading finales:', e);
    }
}

function renderSemifinalesPublic() {
    const el = document.getElementById('semifinales');
    el.innerHTML = loadingHTML;

    loadSemifinalesPublic().then(() => {
        if (!allSemifinales.length) {
            el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">emoji_events</span><p>Semifinales no disponibles.<br>Las semifinales se generan al finalizar el Round Robin.</p></div>';
            return;
        }

        let html = '';
        allSemifinales.forEach(semi => {
            const aColor = semi.equipo_a_color || getTeamColor(semi.equipo_a_id) || '#888';
            const bColor = semi.equipo_b_color || getTeamColor(semi.equipo_b_id) || '#888';
            const allDone = semi.partidos.length === 7 && semi.partidos.every(p => p.estado === 'finalizado');
            let aWins = 0, bWins = 0;
            semi.partidos.forEach(p => {
                if (p.ganador_equipo_id === semi.equipo_a_id) aWins++;
                else if (p.ganador_equipo_id === semi.equipo_b_id) bWins++;
            });
            const ganador = semi.ganador_equipo_id === semi.equipo_a_id ? semi.equipo_a_nombre :
                           semi.ganador_equipo_id === semi.equipo_b_id ? semi.equipo_b_nombre : null;

            html += '<div style="font-family:Lexend;font-weight:600;font-size:0.85rem;margin:1rem 0 0.5rem;color:var(--primary);">' +
                '<span class="material-symbols-outlined" style="font-size:0.85rem;vertical-align:middle;">emoji_events</span> SEMIFINAL ' + (semi.numero || '?') +
                '</div>';

            html += '<div class="card" style="border-left:4px solid ' + (ganador ? (semi.ganador_equipo_id === semi.equipo_a_id ? aColor : bColor) : 'var(--primary)') + ';">' +
                '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem;">' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + aColor + ';"></span>' +
                esc(semi.equipo_a_nombre || '?') +
                '</span>' +
                '<span style="font-family:Lexend;font-weight:800;font-size:0.75rem;color:var(--on-surface-variant-40);">VS</span>' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + bColor + ';"></span>' +
                esc(semi.equipo_b_nombre || '?') +
                '</span>' +
                '</div>';

            if (ganador) {
                html += '<div style="font-size:0.78rem;color:var(--secondary);font-weight:600;margin-bottom:0.4rem;">🏆 Clasificado: ' + esc(ganador) + '</div>';
            }

            html += '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' + aWins + ' - ' + bWins + '</div>';

            if (allDone) {
                html += '<span class="badge badge-success">Completo</span>';
            } else {
                html += '<span class="badge">' + semi.partidos.filter(p => p.estado === 'finalizado').length + '/7 partidos</span>';
            }

            // Show match results
            semi.partidos.filter(p => p.estado === 'finalizado').forEach(p => {
                const localIsA = p.ganador_equipo_id === semi.equipo_a_id;
                const winnerColor = localIsA ? aColor : bColor;
                const s1 = (p.set1_local || 0) + '-' + (p.set1_visitante || 0);
                const s2 = (p.set2_local || 0) + '-' + (p.set2_visitante || 0);
                const hasSTB = p.supertiebreak_local != null;
                const stb = hasSTB ? ' · STB ' + (p.supertiebreak_local || 0) + '-' + (p.supertiebreak_visitante || 0) : '';

                html += '<div style="margin-top:0.5rem;padding:0.5rem;background:var(--white-5);border-radius:6px;font-size:0.75rem;">' +
                    '<div style="color:var(--on-surface-variant-40);margin-bottom:0.2rem;">' + esc(p.categoria || '') + '</div>' +
                    '<div><span style="font-weight:600;">' + s1 + '</span> · <span style="font-weight:600;">' + s2 + '</span>' + esc(stb) + '</div>' +
                    '<div style="color:var(--secondary);font-weight:600;">🏆 ' + esc(localIsA ? (semi.equipo_a_nombre || '?') : (semi.equipo_b_nombre || '?')) + '</div></div>';
            });

            html += '</div>';
        });

        el.innerHTML = html;
    });
}

function renderFinalPublic() {
    const el = document.getElementById('final');
    el.innerHTML = loadingHTML;

    Promise.all([loadSemifinalesPublic(), loadFinalesPublic()]).then(() => {
        const finishedSemis = allSemifinales.filter(s => s.estado === 'finalizado');
        const hasFinal = allFinales.length > 0;

        if (!hasFinal) {
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
            const allDone = fin.partidos.length === 7 && fin.partidos.every(p => p.estado === 'finalizado');
            let aWins = 0, bWins = 0;
            fin.partidos.forEach(p => {
                if (p.ganador_equipo_id === fin.equipo_a_id) aWins++;
                else if (p.ganador_equipo_id === fin.equipo_b_id) bWins++;
            });
            const campeon = fin.ganador_equipo_id === fin.equipo_a_id ? fin.equipo_a_nombre :
                           fin.ganador_equipo_id === fin.equipo_b_id ? fin.equipo_b_nombre : null;

            html += '<div style="font-family:Lexend;font-weight:600;font-size:0.9rem;margin:1rem 0 0.5rem;color:var(--secondary);">' +
                '<span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:middle;">workspace_premium</span> 🏆 GRAN FINAL' +
                '</div>';

            html += '<div class="card" style="border-left:4px solid ' + (campeon ? (fin.ganador_equipo_id === fin.equipo_a_id ? aColor : bColor) : 'var(--secondary)') + ';">' +
                '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem;">' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + aColor + ';"></span>' +
                esc(fin.equipo_a_nombre || '?') +
                '</span>' +
                '<span style="font-family:Lexend;font-weight:800;font-size:0.75rem;color:var(--on-surface-variant-40);">VS</span>' +
                '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-family:Lexend;font-weight:600;font-size:0.88rem;">' +
                '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + bColor + ';"></span>' +
                esc(fin.equipo_b_nombre || '?') +
                '</span>' +
                '</div>';

            if (campeon) {
                const campColor = fin.ganador_equipo_id === fin.equipo_a_id ? aColor : bColor;
                html += '<div style="margin:0.75rem 0;padding:0.75rem;background:rgba(255,255,255,0.05);border-radius:8px;text-align:center;">' +
                    '<div style="font-size:1.5rem;">🏆</div>' +
                    '<div style="font-family:Lexend;font-weight:800;font-size:1.1rem;color:' + campColor + ';">CAMPEÓN</div>' +
                    '<div style="display:flex;align-items:center;justify-content:center;gap:0.4rem;margin-top:0.3rem;">' +
                    '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + campColor + ';"></span>' +
                    '<span style="font-family:Lexend;font-weight:600;font-size:1rem;">' + esc(campeon) + '</span>' +
                    '</div></div>';
            }

            html += '<div style="font-size:0.72rem;color:var(--on-surface-variant-40);margin-bottom:0.4rem;">' + aWins + ' - ' + bWins + '</div>';

            if (allDone) {
                html += '<span class="badge badge-success">Completo</span>';
            } else {
                html += '<span class="badge">' + fin.partidos.filter(p => p.estado === 'finalizado').length + '/7 partidos</span>';
            }

            // Show match results
            fin.partidos.filter(p => p.estado === 'finalizado').forEach(p => {
                const localIsA = p.ganador_equipo_id === fin.equipo_a_id;
                const s1 = (p.set1_local || 0) + '-' + (p.set1_visitante || 0);
                const s2 = (p.set2_local || 0) + '-' + (p.set2_visitante || 0);
                const hasSTB = p.supertiebreak_local != null;
                const stb = hasSTB ? ' · STB ' + (p.supertiebreak_local || 0) + '-' + (p.supertiebreak_visitante || 0) : '';

                html += '<div style="margin-top:0.5rem;padding:0.5rem;background:var(--white-5);border-radius:6px;font-size:0.75rem;">' +
                    '<div style="color:var(--on-surface-variant-40);margin-bottom:0.2rem;">' + esc(p.categoria || '') + '</div>' +
                    '<div><span style="font-weight:600;">' + s1 + '</span> · <span style="font-weight:600;">' + s2 + '</span>' + esc(stb) + '</div>' +
                    '<div style="color:var(--secondary);font-weight:600;">🏆 ' + esc(localIsA ? (fin.equipo_a_nombre || '?') : (fin.equipo_b_nombre || '?')) + '</div></div>';
            });

            html += '</div>';
        });

        el.innerHTML = html;
    });
}

init();
