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
        const aId = enf.equipo_a_id;
        const bId = enf.equipo_b_id;
        if (!aId || !bId) return;
        if (!stats[aId] || !stats[bId]) return;

        const partidos = enf.partidos || [];
        const finalizados = partidos.filter(p => p.estado === 'finalizado');
        const allDone = partidos.length > 0 && finalizados.length === partidos.length;

        let aWins = 0, bWins = 0;
        finalizados.forEach(p => {
            const g = p.ganador_equipo_id;
            const pJuegos = parseInt(p.games_a) || 0;
            const pJuegosVis = parseInt(p.games_b) || 0;
            if (g === aId) {
                stats[aId].partidos_ganados++;
                stats[aId].juegos_ganados += pJuegos;
                stats[bId].juegos_ganados += pJuegosVis;
                stats[aId].puntos += 1;    // 1 punto por partido ganado
                aWins++;
            } else if (g === bId) {
                stats[bId].partidos_ganados++;
                stats[bId].juegos_ganados += pJuegosVis;
                stats[aId].juegos_ganados += pJuegos;
                stats[bId].puntos += 1;    // 1 punto por partido ganado
                bWins++;
            } else {
                stats[aId].juegos_ganados += pJuegos;
                stats[bId].juegos_ganados += pJuegosVis;
            }
        });

        if (allDone) {
            completedEnfs++;
            stats[aId].jornadas_disputadas++;
            stats[bId].jornadas_disputadas++;
            if (aWins > bWins) {
                stats[aId].jornadas_ganadas++;
                stats[aId].puntos += 5;    // bonus al ganador de la jornada completa
            } else if (bWins > aWins) {
                stats[bId].jornadas_ganadas++;
                stats[bId].puntos += 5;    // bonus al ganador de la jornada completa
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
