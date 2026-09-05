// ── Standings Calculation ──
// Single source of truth: always derived from partidos finalizados
import { deriveGanadorId } from './utils.js';

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
            partidos_perdidos: 0,
            partidos_jugados: 0,
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
        const cerrada = enf.cerrada === true;
        const allDone = partidos.length > 0 && cerrada;

        let aWins = 0, bWins = 0;
        finalizados.forEach(p => {
            const g = deriveGanadorId(p);
            const pJuegos = parseInt(p.games_a) || 0;
            const pJuegosVis = parseInt(p.games_b) || 0;
            stats[aId].partidos_jugados++;
            stats[bId].partidos_jugados++;
            if (g === aId) {
                stats[aId].partidos_ganados++;
                stats[bId].partidos_perdidos++;
                stats[aId].juegos_ganados += pJuegos;
                stats[bId].juegos_ganados += pJuegosVis;
                stats[aId].puntos += 1;
                aWins++;
            } else if (g === bId) {
                stats[bId].partidos_ganados++;
                stats[aId].partidos_perdidos++;
                stats[bId].juegos_ganados += pJuegosVis;
                stats[aId].juegos_ganados += pJuegos;
                stats[bId].puntos += 1;
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
                stats[aId].puntos += 5;
            } else if (bWins > aWins) {
                stats[bId].jornadas_ganadas++;
                stats[bId].puntos += 5;
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
