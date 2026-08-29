// ── Utilidades compartidas ──

export function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

export function shortName(j) {
    if (!j) return '';
    const firstName = (j.nombre || '').split(' ')[0];
    const firstLast = (j.apellidos || '').split(' ')[0];
    const cat = j.categoria ? ' (' + j.categoria + ')' : '';
    return firstName + ' ' + firstLast + cat;
}

export function makeTeamHelpers(getEquipos) {
    return {
        getTeamName(equipoId) {
            if (!equipoId) return '';
            const eq = getEquipos().find(e => e.id === equipoId);
            return eq ? eq.nombre : '';
        },
        getTeamColor(equipoId) {
            if (!equipoId) return '#888';
            const eq = getEquipos().find(e => e.id === equipoId);
            return eq ? (eq.color || '#888') : '#888';
        }
    };
}

export function formatDate(fecha) {
    if (!fecha) return '';
    try {
        const d = fecha.toDate ? fecha.toDate() : new Date(fecha);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR');
    } catch (e) { return ''; }
}

// Convierte 'Masculino Suma 9' → 'SUMA 9 MASCULINO', 'Femenino Suma 10' → 'SUMA 10 FEMENINO',
// 'Mixto Suma 11' → 'SUMA 11 MIXTO', 'Masculino 6ta Master' → '6TA MASTER MASCULINO'.
// Si no coincide con el patrón de categorías de DRAW, devuelve el texto en mayúsculas.
export function formatCategoria(cat) {
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
