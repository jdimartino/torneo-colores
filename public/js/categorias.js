// ── Categorías de Jugador (inscripción) — fija, no se modifica ──
export const CATEGORIAS_JUGADOR = ['3ra', '4ta', '5ta', '6ta Libre', '6ta Master', '7ma'];

// ── Categorías del Draw — servicio dinámico por torneo ──
import { db } from './firebase.js';
import { collection, getDocs, addDoc, updateDoc, writeBatch, doc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getActiveTournamentId } from './tournamentRefs.js';

// ── Categorías por defecto para el seed ──
const DEFAULT_DRAW_CATEGORIAS = [
    'Masculino Suma 9',
    'Masculino Suma 10',
    'Masculino Suma 12',
    'Masculino 6ta Master',
    'Femenino Suma 10',
    'Femenino Suma 12',
    'Mixto Suma 11'
];

// ── Caché en memoria por torneo ──
let _catCache = { key: null, todas: [], activas: [] };

function colCategorias() {
    return collection(db, 'torneos', getActiveTournamentId(), 'categorias');
}

function docCategoria(id) {
    return doc(db, 'torneos', getActiveTournamentId(), 'categorias', id);
}

function docCategoriaAuto() {
    return doc(collection(db, 'torneos', getActiveTournamentId(), 'categorias'));
}

// ── Normalización para comparación de duplicados (trim + lowercase) ──
export function normalizeCatName(name) {
    return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Cargar categorías del torneo activo ──
export async function ensureCategorias() {
    const tid = getActiveTournamentId();
    if (!tid) { _catCache = { key: null, todas: [], activas: [] }; return; }
    if (_catCache.key === tid && _catCache.todas.length > 0) return;
    try {
        const snap = await getDocs(colCategorias());
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        all.sort((a, b) => (a.orden ?? 999) - (b.orden ?? 999) || normalizeCatName(a.nombre).localeCompare(normalizeCatName(b.nombre)));
        _catCache = {
            key: tid,
            todas: all,
            activas: all.filter(c => c.activa !== false)
        };
    } catch (e) {
        console.error('[categorias] Error loading categorias:', e);
        _catCache = { key: tid, todas: [], activas: [] };
    }
}

// ── Getters síncronos (leer de caché) ──
export function getDrawCategoriasTodas() { return _catCache.todas; }
export function getDrawCategoriasActivas() { return _catCache.activas; }

// ── Invalidar caché (llamar tras crear/editar/activar/desactivar) ──
export function invalidateCategorias() {
    _catCache = { key: null, todas: [], activas: [] };
}

// ── Crear categoría ──
export async function crearCategoria(nombre, orden) {
    const now = new Date();
    const data = {
        nombre: nombre.trim(),
        activa: true,
        orden: orden,
        createdAt: now,
        updatedAt: now
    };
    await addDoc(colCategorias(), data);
    invalidateCategorias();
}

// ── Editar categoría (nombre, orden o ambos) ──
export async function editarCategoria(categoriaId, updates) {
    await updateDoc(docCategoria(categoriaId), {
        ...updates,
        updatedAt: new Date()
    });
    invalidateCategorias();
}

// ── Activar / desactivar ──
export async function setCategoriaActiva(categoriaId, activa) {
    await updateDoc(docCategoria(categoriaId), {
        activa: activa,
        updatedAt: new Date()
    });
    invalidateCategorias();
}

// ── Verificar si existe duplicado (excluyendo un ID) ──
export function existeCategoriaDuplicada(nombre, excludeId) {
    const norm = normalizeCatName(nombre);
    return _catCache.todas.some(c =>
        normalizeCatName(c.nombre) === norm && c.id !== excludeId
    );
}

// ── Seed: crear las 7 categorías por defecto ──
export async function seedCategoriasDefault() {
    const now = new Date();
    const batch = writeBatch(db);
    DEFAULT_DRAW_CATEGORIAS.forEach((nombre, idx) => {
        const ref = docCategoriaAuto();
        batch.set(ref, {
            nombre,
            activa: true,
            orden: idx + 1,
            createdAt: now,
            updatedAt: now
        });
    });
    await batch.commit();
    invalidateCategorias();
}
