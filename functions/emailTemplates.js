'use strict';

// ═══════════════════════════════════════════════════════════════
// emailTemplates.js — Plantillas HTML para emails del torneo
// Datos reales de Firestore. Sin datos inventados.
// ═══════════════════════════════════════════════════════════════

function baseWrap(title, bodyHtml) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:16px;">
    <div style="text-align:center;padding:12px 0;">
      <h1 style="color:#04132b;font-size:1.3rem;margin:0;">${title}</h1>
    </div>
    <div style="background:#f9fafb;border-radius:12px;padding:20px;">${bodyHtml}</div>
    <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:20px;">
      Torneos Club Tachira · Sistema de torneos<br>
      Este es un correo automático, no responder.
    </p>
  </div>`;
}

function welcomeHtml({ nombre, torneoNombre, jugadorId }) {
  const safeName = nombre || 'Jugador';
  const safeTorneo = torneoNombre || 'el torneo';
  return baseWrap('¡Bienvenido!', `
    <p style="color:#374151;font-size:15px;">Hola <strong>${safeName}</strong>,</p>
    <p style="color:#374151;font-size:15px;">
      Te has inscrito correctamente en <strong>${safeTorneo}</strong>.
    </p>
    <div style="background:#e8f5e9;border-left:4px solid #4caf50;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;">
      <p style="margin:0;color:#2e7d32;font-size:14px;font-weight:600;">Inscripción confirmada</p>
      <p style="margin:4px 0 0;color:#555;font-size:13px;">Tu participate está registrada. Recibirás notificaciones sobre partidos y resultados.</p>
    </div>
    <p style="color:#6b7280;font-size:13px;">
      Si tenés preguntas, contactá al organizador del torneo.
    </p>
  `);
}

function dailyStatsHtml({ torneoNombre, fecha, jornadaNombre, partidos, posiciones, categorias, totalJugadores, totalEquipos }) {
  let html = '';

  // Encabezado
  html += `<p style="color:#374151;font-size:15px;">Resumen del día <strong>${fecha}</strong></p>`;

  // Jornada
  if (jornadaNombre) {
    html += `<div style="background:#e3f2fd;border-left:4px solid #2196f3;padding:10px 14px;border-radius:0 8px 8px 0;margin:12px 0;">
      <p style="margin:0;color:#1565c0;font-size:13px;font-weight:600;">📋 ${jornadaNombre}</p>
    </div>`;
  }

  // Partidos jugados
  if (partidos && partidos.length > 0) {
    html += `<h3 style="color:#04132b;font-size:1rem;margin:16px 0 8px;">Partidos</h3>`;
    for (const p of partidos) {
      const eqA = p.equipo_a_nombre || p.equipo_a || '—';
      const eqB = p.equipo_b_nombre || p.equipo_b || '—';
      const setsA = [p.set1_a, p.set2_a, p.set3_a].filter(s => s != null && s !== '').join('-');
      const setsB = [p.set1_b, p.set2_b, p.set3_b].filter(s => s != null && s !== '').join('-');
      const marcador = (setsA && setsB) ? `${setsA} / ${setsB}` : 'Pendiente';
      const estado = p.estado || 'pendiente';
      const color = estado === 'finalizado' ? '#2e7d32' : '#f57c00';

      html += `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin:6px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:600;color:#374151;font-size:14px;">${eqA} vs ${eqB}</span>
          <span style="color:${color};font-size:12px;font-weight:600;text-transform:uppercase;">${estado}</span>
        </div>
        ${marcador !== 'Pendiente' ? `<div style="color:#6b7280;font-size:13px;margin-top:4px;">Sets: ${marcador}</div>` : ''}
      </div>`;
    }
  } else {
    html += `<p style="color:#9ca3af;font-size:13px;">No hay partidos registrados para hoy.</p>`;
  }

  // Posiciones
  if (posiciones && posiciones.length > 0) {
    html += `<h3 style="color:#04132b;font-size:1rem;margin:16px 0 8px;">Posiciones</h3>`;
    html += `<table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#f3f4f6;">
        <th style="padding:6px 8px;text-align:left;">#</th>
        <th style="padding:6px 8px;text-align:left;">Equipo</th>
        <th style="padding:6px 8px;text-align:center;">PJ</th>
        <th style="padding:6px 8px;text-align:center;">PG</th>
        <th style="padding:6px 8px;text-align:center;">Pts</th>
      </tr></thead><tbody>`;
    for (let i = 0; i < posiciones.length; i++) {
      const pos = posiciones[i];
      const bg = i % 2 === 0 ? '#fff' : '#f9fafb';
      html += `<tr style="background:${bg};">
        <td style="padding:5px 8px;">${i + 1}</td>
        <td style="padding:5px 8px;font-weight:600;">${pos.nombre || pos.equipo_id || '—'}</td>
        <td style="padding:5px 8px;text-align:center;">${pos.pj || 0}</td>
        <td style="padding:5px 8px;text-align:center;">${pos.pg || 0}</td>
        <td style="padding:5px 8px;text-align:center;font-weight:700;">${pos.puntos || 0}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  // Categorías activas
  if (categorias && categorias.length > 0) {
    html += `<h3 style="color:#04132b;font-size:1rem;margin:16px 0 8px;">Categorías</h3>`;
    html += `<div style="display:flex;flex-wrap:wrap;gap:6px;">`;
    for (const cat of categorias) {
      html += `<span style="background:#e8eaf6;color:#3949ab;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;">${cat}</span>`;
    }
    html += '</div>';
  }

  // Resumen
  html += `<div style="background:#f3f4f6;border-radius:8px;padding:12px;margin:16px 0;font-size:13px;color:#6b7280;">
    <strong>Resumen:</strong> ${totalJugadores || 0} jugadores · ${totalEquipos || 0} equipos
  </div>`;

  return baseWrap(torneoNombre + ' — Resumen del día', html);
}

function previewHtml(tipoLabel, torneoNombre) {
  return baseWrap('Vista previa', `
    <p style="color:#374151;font-size:15px;">Vista previa del módulo <strong>${tipoLabel}</strong>${torneoNombre ? ` de <strong>${torneoNombre}</strong>` : ''}.</p>
    <div style="background:#fff8e1;border-left:4px solid #ffb300;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;">
      <p style="margin:0;color:#8d6e00;font-size:14px;font-weight:600;">Módulo en preparación</p>
      <p style="margin:4px 0 0;color:#555;font-size:13px;">Este correo es una prueba de formato y remitente. El contenido automático de este módulo llegará próximamente.</p>
    </div>
  `);
}

module.exports = { welcomeHtml, dailyStatsHtml, previewHtml };
