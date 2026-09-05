// ── Utilidades compartidas ──

export function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

export function shortName(j, asHTML = false) {
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

// Deriva el ganador de un partido finalizado desde los scores (fuente de verdad).
// Fallback al ganador guardado si faltan scores o el partido no está finalizado.
export function deriveGanadorId(p) {
    if (!p) return null;
    if (p.estado !== 'finalizado') return p.ganador_equipo_id || null;
    if (p.set1_a == null || p.set1_b == null || p.set2_a == null || p.set2_b == null) {
        return p.ganador_equipo_id || null;
    }
    const winner = (a, b) => (a > b ? 'a' : b > a ? 'b' : null);
    const set1 = (p.set1_a === 4 && p.set1_b === 4)
        ? (p.tiebreak1_a != null && p.tiebreak1_b != null ? winner(p.tiebreak1_a, p.tiebreak1_b) : null)
        : winner(p.set1_a, p.set1_b);
    const set2 = (p.set2_a === 4 && p.set2_b === 4)
        ? (p.tiebreak2_a != null && p.tiebreak2_b != null ? winner(p.tiebreak2_a, p.tiebreak2_b) : null)
        : winner(p.set2_a, p.set2_b);
    let setsA = 0, setsB = 0;
    if (set1 === 'a') setsA++; else if (set1 === 'b') setsB++;
    if (set2 === 'a') setsA++; else if (set2 === 'b') setsB++;
    let side = null;
    if (setsA === 2) side = 'a';
    else if (setsB === 2) side = 'b';
    else if (p.supertiebreak_a != null && p.supertiebreak_b != null) {
        if (p.supertiebreak_a > p.supertiebreak_b) side = 'a';
        else if (p.supertiebreak_b > p.supertiebreak_a) side = 'b';
    }
    if (!side) return p.ganador_equipo_id || null;
    const id = side === 'a' ? p.equipo_a_id : p.equipo_b_id;
    return id || p.ganador_equipo_id || null;
}
