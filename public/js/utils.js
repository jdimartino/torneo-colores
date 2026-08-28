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
