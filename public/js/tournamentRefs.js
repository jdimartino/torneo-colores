import { db } from './firebase.js';
import { collection, doc, getDoc, setDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

let _activeTournamentId = null;
let _activeTournamentData = null;
let _activeTournamentIds = [];

export function getActiveTournamentId() {
    return _activeTournamentId;
}

export function getActiveTournament() {
    return _activeTournamentData;
}

export function getActiveTournamentIds() {
    return _activeTournamentIds;
}

export function setActiveTournament(id, data) {
    _activeTournamentId = id;
    _activeTournamentData = data || null;
}

export function col(name) {
    return collection(db, 'torneos', _activeTournamentId, name);
}

export function docRef(name, id) {
    return doc(db, 'torneos', _activeTournamentId, name, id);
}

export function docRefAuto(name) {
    return doc(collection(db, 'torneos', _activeTournamentId, name));
}

export function torneosCol() {
    return collection(db, 'torneos');
}

export function torneoRef(id) {
    return doc(db, 'torneos', id);
}

export function configDoc() {
    return doc(db, 'config', 'activeTournament');
}

export async function loadTournamentConfig() {
    try {
        const snap = await getDoc(configDoc());
        if (snap.exists()) {
            const data = snap.data();
            console.log('[config] config/activeTournament exists:', data);
            if (data.activeTournamentIds && data.activeTournamentIds.length > 0) {
                _activeTournamentIds = data.activeTournamentIds;
                _activeTournamentId = data.selectedTournamentId || _activeTournamentIds[0];
            } else if (data.tournamentId) {
                _activeTournamentIds = [data.tournamentId];
                _activeTournamentId = data.tournamentId;
            }
            if (_activeTournamentId) {
                const tSnap = await getDoc(torneoRef(_activeTournamentId));
                if (tSnap.exists()) {
                    _activeTournamentData = { id: tSnap.id, ...tSnap.data() };
                    console.log('[config] Tournament found:', _activeTournamentData.nombre || _activeTournamentId);
                } else {
                    console.warn('[config] Tournament', _activeTournamentId, 'NOT FOUND in torneos collection');
                }
            }
        } else {
            console.warn('[config] config/activeTournament document DOES NOT EXIST');
        }
    } catch (e) {
        console.error('[config] Error loading tournament config:', e);
    }
    console.log('[config] Final activeTournamentId:', _activeTournamentId);
    return _activeTournamentId;
}

export async function setActiveTournamentConfig(selectedId) {
    const snap = await getDoc(configDoc());
    let ids = _activeTournamentIds;
    if (snap.exists()) {
        const data = snap.data();
        if (data.activeTournamentIds) ids = data.activeTournamentIds;
        else if (data.tournamentId) ids = [data.tournamentId];
    }
    if (selectedId && !ids.includes(selectedId)) {
        ids.push(selectedId);
    }
    _activeTournamentIds = ids;
    await setDoc(configDoc(), {
        activeTournamentIds: ids,
        selectedTournamentId: selectedId || _activeTournamentId
    });
}

export async function setSelectedTournament(id) {
    _activeTournamentId = id;
    const tSnap = await getDoc(torneoRef(id));
    if (tSnap.exists()) {
        _activeTournamentData = { id: tSnap.id, ...tSnap.data() };
    }
    await updateDoc(configDoc(), { selectedTournamentId: id });
}

export async function addActiveTournament(id) {
    if (!_activeTournamentIds.includes(id)) {
        _activeTournamentIds.push(id);
    }
    await setDoc(configDoc(), {
        activeTournamentIds: _activeTournamentIds,
        selectedTournamentId: id
    });
}

export async function removeActiveTournament(id) {
    _activeTournamentIds = _activeTournamentIds.filter(tid => tid !== id);
    await setDoc(configDoc(), {
        activeTournamentIds: _activeTournamentIds,
        selectedTournamentId: _activeTournamentId
    });
}

export function getBracketConfig() {
    const defaults = { clasificados: 4, rondas: 2 };
    if (!_activeTournamentData) return defaults;
    const bc = _activeTournamentData.bracketConfig;
    if (!bc) return defaults;
    return {
        clasificados: bc.clasificados || 4,
        rondas: bc.rondas || 2
    };
}

export async function updateBracketConfig(updates) {
    if (!_activeTournamentId) return;
    const cfg = getBracketConfig();
    const merged = { ...cfg, ...updates };
    await updateDoc(torneoRef(_activeTournamentId), {
        bracketConfig: merged
    });
    if (_activeTournamentData) {
        _activeTournamentData.bracketConfig = merged;
    }
}
