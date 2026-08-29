// ── Round Robin Generator — Circle Method ──
// Pure functions, no side effects

// Generate Round Robin schedule using Circle Method
// teams: array of team objects { id, nombre, color, activo }
// Returns { jornadas, enfrentamientos, stats }
export function generateRoundRobin(teams) {
    const active = teams.filter(t => t.activo !== false);
    const n = active.length;

    if (n < 2) {
        return { jornadas: [], enfrentamientos: [], stats: { error: 'Se necesitan al menos 2 equipos activos' } };
    }

    const isOdd = n % 2 !== 0;
    const numTeams = isOdd ? n + 1 : n;
    const numRounds = isOdd ? n : n - 1;

    // Build circular array with indices
    const circle = [];
    for (let i = 0; i < numTeams; i++) {
        circle.push(i < n ? i : -1); // -1 means BYE
    }

    const rounds = [];
    for (let r = 0; r < numRounds; r++) {
        const round = [];
        for (let i = 0; i < numTeams / 2; i++) {
            const a = circle[i];
            const b = circle[numTeams - 1 - i];
            if (a === -1 || b === -1) continue; // skip BYE matches
            round.push({
                equipo_local_id: active[a].id,
                equipo_visitante_id: active[b].id,
                equipo_local_nombre: active[a].nombre,
                equipo_visitante_nombre: active[b].nombre
            });
        }
        rounds.push(round);
        // Rotate: fix first element, rotate rest clockwise
        const last = circle.pop();
        circle.splice(1, 0, last);
    }

    // Flatten to enfrentamientos with metadata
    const enfrentamientos = [];
    let enfId = 0;
    rounds.forEach((round, roundIdx) => {
        round.forEach(m => {
            enfrentamientos.push({
                id: 'enf_' + m.equipo_local_id + '_' + m.equipo_visitante_id + '_' + roundIdx + '_' + enfId++,
                equipo_local_id: m.equipo_local_id,
                equipo_visitante_id: m.equipo_visitante_id,
                equipo_local_nombre: m.equipo_local_nombre,
                equipo_visitante_nombre: m.equipo_visitante_nombre,
                jornada_numero: roundIdx + 1,
                estado: 'pendiente'
            });
        });
    });

    // Group by jornada
    const jornadas = [];
    for (let r = 0; r < rounds.length; r++) {
        jornadas.push({
            numero: r + 1,
            fecha: null,
            estado: 'pendiente'
        });
    }

    // Validation
    const validation = validateSchedule(active, rounds, enfrentamientos);

    return {
        jornadas,
        enfrentamientos,
        stats: {
            equiposActivos: n,
            numJornadas: rounds.length,
            numEnfrentamientos: enfrentamientos.length,
            isOdd,
            byesPerJornada: isOdd ? 1 : 0,
            validation
        }
    };
}

// Validate the generated schedule
function validateSchedule(teams, rounds, enfrentamientos) {
    const n = teams.length;
    const errors = [];
    const warnings = [];

    // A) Correct number of rounds
    const expectedRounds = n % 2 !== 0 ? n : n - 1;
    if (rounds.length !== expectedRounds) {
        errors.push('Jornadas incorrectas: esperadas ' + expectedRounds + ', generadas ' + rounds.length);
    }

    // B) Correct number of enfrentamientos
    const expectedEnfs = n % 2 !== 0 ? (n * (n - 1)) / 2 : (n * (n - 1)) / 2;
    if (enfrentamientos.length !== expectedEnfs) {
        errors.push('Enfrentamientos incorrectos: esperados ' + expectedEnfs + ', generados ' + enfrentamientos.length);
    }

    // Build pairs set and per-team, per-jornada tracking
    const pairs = new Set();
    const teamMatches = {};
    const teamByJornada = {};
    teams.forEach(t => {
        teamMatches[t.id] = 0;
        teamByJornada[t.id] = new Set();
    });

    enfrentamientos.forEach(e => {
        const pair = [e.equipo_local_id, e.equipo_visitante_id].sort().join('-');
        if (pairs.has(pair)) {
            errors.push('Par duplicado: ' + pair);
        }
        pairs.add(pair);

        // Check team plays at most once per jornada
        const jn = e.jornada_numero;
        if (teamByJornada[e.equipo_local_id]?.has(jn)) {
            errors.push(e.equipo_local_id + ' juega dos veces en jornada ' + jn);
        }
        if (teamByJornada[e.equipo_visitante_id]?.has(jn)) {
            errors.push(e.equipo_visitante_id + ' juega dos veces en jornada ' + jn);
        }
        teamByJornada[e.equipo_local_id]?.add(jn);
        teamByJornada[e.equipo_visitante_id]?.add(jn);

        teamMatches[e.equipo_local_id]++;
        teamMatches[e.equipo_visitante_id]++;
    });

    // C) Each pair appears exactly once
    if (pairs.size !== expectedEnfs) {
        errors.push('Parejas unicas: ' + pairs.size + ', esperadas ' + expectedEnfs);
    }

    // D) No team plays itself
    enfrentamientos.forEach(e => {
        if (e.equipo_local_id === e.equipo_visitante_id) {
            errors.push('Equipo juega contra sí mismo: ' + e.equipo_local_id);
        }
    });

    // E) Each team at most once per jornada
    // Already checked above

    // F) For odd, exactly one team BYE per jornada
    // Already handled by algorithm

    // G) Each team faces all others exactly once
    teams.forEach(t => {
        const expected = n % 2 !== 0 ? n - 1 : n - 1;
        if (teamMatches[t.id] !== expected) {
            errors.push(t.nombre + ' tiene ' + teamMatches[t.id] + ' enfrentamientos, esperados ' + expected);
        }
    });

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        pairsCount: pairs.size,
        expectedPairs: expectedEnfs
    };
}

// Check if tournament already has Round Robin generated
// Returns { hasRR: boolean, issue: string|null }
export function detectExistingRoundRobin(allJornadas, allEnfrentamientos) {
    if (!allJornadas || allJornadas.length === 0) {
        return { hasRR: false, issue: null };
    }

    // Count total expected enfrentamientos from jornadas
    const totalEnfs = allEnfrentamientos.length;

    if (totalEnfs === 0 && allJornadas.length > 0) {
        return { hasRR: false, issue: 'Jornadas existen pero sin enfrentamientos' };
    }

    if (totalEnfs > 0) {
        return { hasRR: true, issue: 'Ya existen enfrentamientos generados' };
    }

    return { hasRR: false, issue: null };
}

// Validate before generation
// Returns { ok: boolean, message: string }
export function validateGenerationPreconditions(activeTeams, allJornadas, allEnfrentamientos) {
    if (!activeTeams || activeTeams.length < 2) {
        return { ok: false, message: 'Se necesitan al menos 2 equipos activos.' };
    }

    const activeCount = activeTeams.filter(t => t.activo !== false).length;
    if (activeCount < 2) {
        return { ok: false, message: 'Se necesitan al menos 2 equipos activos.' };
    }

    // Check if already has enfrentamientos (RR already generated)
    const totalEnfs = allEnfrentamientos ? allEnfrentamientos.length : 0;
    if (totalEnfs > 0) {
        return { ok: false, message: 'Ya existe un Round Robin para este torneo. No se puede generar otro.' };
    }

    return { ok: true, message: '' };
}

// Generate dates for jornadas
export function generateDates(startDate, intervalDays, numJornadas) {
    const dates = [];
    const d = new Date(startDate);
    for (let i = 0; i < numJornadas; i++) {
        const date = new Date(d);
        date.setDate(d.getDate() + i * intervalDays);
        dates.push(date.toISOString().split('T')[0]); // YYYY-MM-DD
    }
    return dates;
}

// Helper: format date for display
export function formatDateShort(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return parts[2] + '/' + parts[1] + '/' + parts[0];
    }
    return dateStr;
}