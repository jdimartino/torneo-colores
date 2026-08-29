// ── Match Status Helpers ──

// Partido: finalizado | pendiente
export function getPartidoEstado(p) {
    if (!p) return 'pendiente';
    return p.estado === 'finalizado' ? 'finalizado' : 'pendiente';
}

// Enfrentamiento: finalizado (7/7) | en_curso (1-6) | pendiente (0)
export function getEnfrentamientoEstado(enf) {
    const partidos = enf.partidos || [];
    if (partidos.length === 0) return 'pendiente';
    const finalizados = partidos.filter(p => p.estado === 'finalizado').length;
    if (finalizados === 7) return 'finalizado';
    if (finalizados === 0) return 'pendiente';
    return 'en_curso';
}

// Jornada: finalizado (todos los enf completos) | en_curso | pendiente
// Excluye equipos que descansan
export function getJornadaEstado(jornada, enfs) {
    const enfsNoDescanso = (enfs || []).filter(e =>
        e.equipo_a_id && e.equipo_b_id
    );
    if (enfsNoDescanso.length === 0) return 'pendiente';
    const allComplete = enfsNoDescanso.every(e => getEnfrentamientoEstado(e) === 'finalizado');
    if (allComplete) return 'finalizado';
    const anyProgress = enfsNoDescanso.some(e => {
        const p = e.partidos || [];
        return p.some(x => x.estado === 'finalizado');
    });
    return anyProgress ? 'en_curso' : 'pendiente';
}
