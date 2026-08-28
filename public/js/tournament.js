import { db } from './firebase.js';
import {
    getDocs, addDoc, updateDoc, deleteDoc, doc, collection,
    query, orderBy, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import {
    torneosCol, torneoRef, getActiveTournamentId, getActiveTournament,
    getActiveTournamentIds, setActiveTournament, setActiveTournamentConfig,
    setSelectedTournament, addActiveTournament, removeActiveTournament, col,
    getBracketConfig, updateBracketConfig
} from './tournamentRefs.js';

let allTournaments = [];

export async function loadTournaments() {
    try {
        const snap = await getDocs(query(torneosCol(), orderBy('fechaCreacion', 'desc')));
        allTournaments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Error loading tournaments:', e);
        allTournaments = [];
    }
    return allTournaments;
}

export function getTournaments() {
    return allTournaments;
}

export async function createTournament(name, bracketConfig) {
    const data = {
        name,
        status: 'active',
        fechaCreacion: new Date(),
        bracketConfig: bracketConfig || {
            clasificados: 4,
            rondas: 2
        }
    };
    const ref = await addDoc(torneosCol(), data);
    await addActiveTournament(ref.id);
    setActiveTournament(ref.id, { id: ref.id, ...data });
    return { id: ref.id, ...data };
}

export async function switchTournament(id) {
    const snap = await getDocs(torneosCol());
    for (const d of snap.docs) {
        if (d.id === id) {
            const data = d.data();
            await setSelectedTournament(id);
            setActiveTournament(id, { id, ...data });
            return { id, ...data };
        }
    }
    return null;
}

export async function closeTournament(id) {
    await updateDoc(torneoRef(id), { status: 'closed' });
    await removeActiveTournament(id);
    if (getActiveTournamentId() === id) {
        const remaining = getActiveTournamentIds();
        if (remaining.length > 0) {
            await switchTournament(remaining[0]);
        } else {
            setActiveTournament(null, null);
        }
    }
}

export async function deleteTournament(id) {
    const batch = writeBatch(db);
    const subcols = ['jugadores', 'equipos', 'jornadas', 'partidos', 'posiciones', 'finanzas'];
    for (const sub of subcols) {
        const snap = await getDocs(collection(db, 'torneos', id, sub));
        snap.docs.forEach(d => batch.delete(doc(db, 'torneos', id, sub, d.id)));
    }
    batch.delete(torneoRef(id));
    await batch.commit();

    await removeActiveTournament(id);

    if (getActiveTournamentId() === id) {
        const remaining = getActiveTournamentIds();
        if (remaining.length > 0) {
            await switchTournament(remaining[0]);
        } else {
            setActiveTournament(null, null);
            await setActiveTournamentConfig(null);
        }
    }
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
}

export async function renderTournamentPanel() {
    const panel = document.getElementById('panel-torneos');
    if (!panel) return;
    await loadTournaments();
    const active = getActiveTournament();
    const activeId = getActiveTournamentId();
    const activeIds = getActiveTournamentIds();

    let html = `
    <div class="card">
        <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.75rem;">
            <span class="material-symbols-outlined" style="font-size:1.1rem;color:var(--primary);">add_circle</span>
            <span style="font-family:Lexend;font-weight:600;font-size:0.9rem;color:var(--on-surface);">Crear Torneo Nuevo</span>
        </div>
        <div class="form-group">
            <label>Nombre del torneo</label>
            <input type="text" id="t-name" placeholder="Ej: Torneo de Colores Septiembre 2026">
        </div>
        <button class="btn btn-primary" id="btn-create-tournament" style="margin-top:0.75rem;">
            <span class="material-symbols-outlined" style="font-size:1rem;">add</span> Crear Torneo
        </button>
    </div>`;

    if (active && activeId) {
        html += `
        <div class="admin-section-title">
            <span class="material-symbols-outlined" style="font-size:0.9rem;">settings</span> Configuración del Torneo
        </div>
        <div class="card">
            <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.75rem;">
                <span class="material-symbols-outlined" style="font-size:0.9rem;color:var(--primary);">tune</span>
                <span style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--on-surface);">${esc(active.name)}</span>
            </div>
        </div>`;
    }

    const activeTournaments = allTournaments.filter(t => activeIds.includes(t.id));
    const closedTournaments = allTournaments.filter(t => !activeIds.includes(t.id));

    if (activeTournaments.length > 0) {
        html += `
        <div class="admin-section-title">
            <span class="material-symbols-outlined" style="font-size:0.9rem;">emoji_events</span> Torneos Activos (${activeTournaments.length})
        </div>`;
        activeTournaments.forEach(t => {
            const isCurrent = t.id === activeId;
            html += `
            <div class="card" style="${isCurrent ? 'border-left:3px solid var(--primary);' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--on-surface);">
                            ${esc(t.name)} ${isCurrent ? '← viendo' : ''}
                        </div>
                        <div style="font-size:0.65rem;color:var(--on-surface-variant-40);margin-top:0.15rem;">
                            <span class="badge badge-success">Activo</span>
                            · Creado: ${t.fechaCreacion ? new Date(t.fechaCreacion.seconds ? t.fechaCreacion.seconds * 1000 : t.fechaCreacion).toLocaleDateString('es-AR') : '—'}
                        </div>
                    </div>
                    <div style="display:flex;gap:0.3rem;">
                        ${!isCurrent ? `<button class="btn btn-sm btn-primary" data-switch-tournament="${t.id}"><span class="material-symbols-outlined" style="font-size:0.8rem;">swap_horiz</span></button>` : ''}
                        <button class="btn btn-sm btn-outline" data-close-tournament="${t.id}" title="Archivar este torneo"><span class="material-symbols-outlined" style="font-size:0.8rem;">lock</span></button>
                        <button class="btn btn-sm btn-danger" data-delete-tournament="${t.id}"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>
                    </div>
                </div>
            </div>`;
        });
    }

    if (closedTournaments.length > 0) {
        html += `
        <div class="admin-section-title">
            <span class="material-symbols-outlined" style="font-size:0.9rem;">archive</span> Torneos Archivados (${closedTournaments.length})
        </div>`;
        closedTournaments.forEach(t => {
            html += `
            <div class="card" style="opacity:0.6;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <div style="font-family:Lexend;font-weight:600;font-size:0.85rem;color:var(--on-surface);">${esc(t.name)}</div>
                        <div style="font-size:0.65rem;color:var(--on-surface-variant-40);margin-top:0.15rem;">
                            <span class="badge">Cerrado</span>
                        </div>
                    </div>
                    <div style="display:flex;gap:0.3rem;">
                        <button class="btn btn-sm btn-danger" data-delete-tournament="${t.id}"><span class="material-symbols-outlined" style="font-size:0.8rem;">delete</span></button>
                    </div>
                </div>
            </div>`;
        });
    }

    panel.innerHTML = html;

    document.getElementById('btn-create-tournament')?.addEventListener('click', async () => {
        const name = document.getElementById('t-name').value.trim();
        if (!name) { toast('Ingresá un nombre', 'error'); return; }
        showLoading('Creando torneo...');
        try {
            await createTournament(name);
            toast('Torneo creado', 'success');
            await refreshData();
        } catch (e) {
            toast('Error al crear torneo', 'error');
            console.error(e);
        } finally {
            hideLoading();
        }
    });

    panel.querySelectorAll('[data-switch-tournament]').forEach(b => {
        b.addEventListener('click', async () => {
            showLoading('Cambiando torneo...');
            try {
                await switchTournament(b.dataset.switchTournament);
                toast('Torneo cambiado', 'success');
                await refreshData();
            } catch (e) {
                toast('Error al cambiar torneo', 'error');
            } finally {
                hideLoading();
            }
        });
    });

    panel.querySelectorAll('[data-close-tournament]').forEach(b => {
        b.addEventListener('click', async () => {
            if (!confirm('¿Archivar este torneo? Quedará guardado pero no estará activo.')) return;
            try {
                await closeTournament(b.dataset.closeTournament);
                toast('Torneo archivado', 'success');
                await refreshData();
            } catch (e) {
                toast('Error al archivar', 'error');
            }
        });
    });

    panel.querySelectorAll('[data-delete-tournament]').forEach(b => {
        b.addEventListener('click', async () => {
            if (!confirm('¿Eliminar este torneo y TODOS sus datos? Esta acción no se puede deshacer.')) return;
            showLoading('Eliminando torneo...');
            try {
                await deleteTournament(b.dataset.deleteTournament);
                toast('Torneo eliminado', 'success');
                await refreshData();
            } catch (e) {
                toast('Error al eliminar', 'error');
            } finally {
                hideLoading();
            }
        });
    });
}
