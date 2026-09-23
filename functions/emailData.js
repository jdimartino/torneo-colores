'use strict';

// ═══════════════════════════════════════════════════════════════
// emailData.js — Extracción de datos reales del torneo para emails.
// Compartido por la scheduled function (estadísticas diarias) y el
// envío de prueba del módulo. NO duplica lógica de cuota/dedup.
// ═══════════════════════════════════════════════════════════════

async function fetchTorneoEmailData(db, torneoId, fechaStr) {
  const torneoSnap = await db.collection('torneosColores').doc(torneoId).get();
  const td = torneoSnap.exists ? torneoSnap.data() : {};
  const torneoNombre = td.name || td.nombre || torneoId;

  const jugadoresSnap = await db.collection(`torneosColores/${torneoId}/jugadores`).get();
  const jugadores = jugadoresSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const jornadasSnap = await db.collection(`torneosColores/${torneoId}/jornadas`).get();
  const partidos = [];
  let jornadaNombre = null;

  for (const jDoc of jornadasSnap.docs) {
    const partidosSnap = await db.collection(`torneosColores/${torneoId}/jornadas/${jDoc.id}/partidos`).get();
    for (const pDoc of partidosSnap.docs) {
      const p = pDoc.data();
      if (p.estado === 'finalizado' || p.fecha === fechaStr) {
        partidos.push({
          ...p,
          id: pDoc.id,
          equipo_a_nombre: p.equipo_a_nombre || p.equipo_a || '',
          equipo_b_nombre: p.equipo_b_nombre || p.equipo_b || ''
        });
        if (!jornadaNombre) jornadaNombre = jDoc.data().nombre || `Jornada ${jDoc.id}`;
      }
    }
  }

  const posSnap = await db.doc(`torneosColores/${torneoId}/posiciones/general`).get();
  const posicionesRaw = posSnap.exists ? (posSnap.data().posiciones || posSnap.data().tabla || []) : [];

  const catsSnap = await db.collection(`torneosColores/${torneoId}/categorias`).get();
  const categorias = catsSnap.docs.map(d => d.data().nombre || d.data().name || d.id).filter(Boolean);

  return {
    torneoNombre,
    fecha: fechaStr,
    jornadaNombre,
    partidos,
    posiciones: Array.isArray(posicionesRaw) ? posicionesRaw : [],
    categorias,
    totalJugadores: jugadores.length,
    totalEquipos: [...new Set(jugadores.map(j => j.equipo_id).filter(Boolean))].length,
    jugadores
  };
}

module.exports = { fetchTorneoEmailData };
