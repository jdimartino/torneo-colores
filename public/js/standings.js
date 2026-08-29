// ── Standings Calculation ──
// Single source of truth: always derived from partidos finalizados

export function calculateStandings(equipos, allEnfrentamientos) {
    const stats = {};
    equipos.forEach(eq => {
        stats[eq.id] = {
            id: eq.id,
            nombre: eq.nombre,
            color: eq.color || '#888',
            puntos: 0,
            jornadas_disputadas: 0,
            jornadas_ganadas: 0,
            partidos_ganados: 0,
            juegos_ganados: 0
        };
    });

    const allEnfs = allEnfrentamientos || [];
    let totalEnfs = allEnfs.length;
    let completedEnfs = 0;

    allEnfs.forEach(enf => {
        const localId = enf.equipo_local_id;
        const visId = enf.equipo_visitante_id;
        if (!localId || !visId) return;
        if (!stats[localId] || !stats[visId]) return;

        const partidos = enf.partidos || [];
        const finalizados = partidos.filter(p => p.estado === 'finalizado');
        const allDone = partidos.length === 7 && finalizados.length === 7;

        let localWins = 0, visWins = 0;
        finalizados.forEach(p => {
            const g = p.ganador_equipo_id;
            const pJuegos = parseInt(p.games_local) || 0;
            const pJuegosVis = parseInt(p.games_visitante) || 0;
            if (g === localId) {
                stats[localId].partidos_ganados++;
                stats[localId].juegos_ganados += pJuegos;
                stats[visId].juegos_ganados += pJuegosVis;
                localWins++;
            } else if (g === visId) {
                stats[visId].partidos_ganados++;
                stats[visId].juegos_ganados += pJuegosVis;
                stats[localId].juegos_ganados += pJuegos;
                visWins++;
            } else {
                stats[localId].juegos_ganados += pJuegos;
                stats[visId].juegos_ganados += pJuegosVis;
            }
        });

        if (allDone) {
            completedEnfs++;
            stats[localId].jornadas_disputadas++;
            stats[visId].jornadas_disputadas++;
            stats[localId].puntos += localWins;
            stats[visId].puntos += visWins;
            if (localWins > visWins) {
                stats[localId].jornadas_ganadas++;
                stats[localId].puntos += 5;
            } else if (visWins > localWins) {
                stats[visId].jornadas_ganadas++;
                stats[visId].puntos += 5;
            }
        }
    });

    const standings = Object.values(stats);
    standings.sort((a, b) => {
        if (b.puntos !== a.puntos) return b.puntos - a.puntos;
        if (b.juegos_ganados !== a.juegos_ganados) return b.juegos_ganados - a.juegos_ganados;
        return (a.nombre || '').localeCompare(b.nombre || '');
    });

    standings.forEach((s, i) => { s.posicion = i + 1; });

    const allComplete = totalEnfs > 0 && completedEnfs === totalEnfs;

    return {
        standings,
        roundStatus: allComplete ? 'finalizado' : 'en_curso',
        totalEnfrentamientos: totalEnfs,
        completedEnfrentamientos: completedEnfs
    };
}
