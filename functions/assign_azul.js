// Asigna una lista de jugadores al equipo "Azul" del torneo activo.
// Uso:
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/dimartinoj_gmail_com_application_default_credentials.json node assign_azul.js        # dry-run
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/dimartinoj_gmail_com_application_default_credentials.json node assign_azul.js --aplicar  # aplica
const admin = require('firebase-admin');

const APPLICATION = process.argv.includes('--aplicar');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'torneos-tenis-jdm'
});

const db = admin.firestore();

const LISTA = [
  'Alvaro Arevalo',
  'Antonella Abbate',
  'Caira',
  'Camila Penalver',
  'Caroline Gonzalez',
  'Eva Segovia',
  'German Castro',
  'Guido Lamann',
  'Gustavo Segovia',
  'Magdalena Ramirez',
  'Luis Alberto Leal',
  'Mireya Guerrero',
  'Otto Sarduy',
  'Patricia Gamarra',
  'William Reyes',
  'Warrin Molvinet'
];

// Overrides manuales (id del jugador en Firestore) para nombres que difieren de la lista
const OVERRIDES = {
  'William Reyes': '7yWk5I7V8Vl7UknK43DY',   // guardado como "Wiĺlian Reyes"
  'Warrin Molvinet': 'RErB9hN9qNLDGk0htejP'  // guardado como "Warrin Vargas"
};

function normalize(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Devuelve array de tokens (palabras) normalizadas
function tokens(s) {
  return normalize(s).split(' ').filter(Boolean);
}

function scoreMatch(jugador, target) {
  const full = normalize((jugador.nombre || '') + ' ' + (jugador.apellidos || ''));
  const targetN = normalize(target);

  if (!full || !targetN) return 0;

  // Match exacto del nombre completo
  if (full === targetN) return 100;

  // Un nombre contiene al otro (ej. DB "Camila Penalver" vs lista "Camila Penalver Tenis")
  if (full.includes(targetN) || targetN.includes(full)) return 95;

  // Coincidencia de tokens: primero que exista solapamiento de >= 2 tokens
  const tJ = tokens((jugador.nombre || '') + ' ' + (jugador.apellidos || ''));
  const tT = tokens(target);
  const common = tJ.filter(x => tT.includes(x));
  if (common.length >= 2 && (common.length / Math.min(tJ.length, tT.length)) >= 0.66) {
    return 80;
  }

  // Nombre simple de 1 sola palabra (ej. "Caira")
  if (tT.length === 1) {
    const first = normalize(jugador.nombre || '');
    if (first === targetN) return 90;
    // Puede estar en apellidos
    const ap = normalize(jugador.apellidos || '');
    if (ap === targetN) return 85;
  }

  // Primer palabra (nombre) + alguna coincidencia en apellido
  if (tT.length >= 2) {
    const firstName = normalize((jugador.nombre || '').split(' ')[0]);
    const lastNameFirst = normalize((jugador.apellidos || '').split(' ')[0]);
    if (firstName === tT[0] && lastNameFirst === tT[tT.length - 1]) return 70;
  }

  return 0;
}

async function main() {
  // 1. Torneo activo
  const cfgSnap = await db.doc('config/activeTournament').get();
  if (!cfgSnap.exists) {
    console.log('❌ No existe config/activeTournament');
    return;
  }
  const cfg = cfgSnap.data();
  const tid = cfg.selectedTournamentId || (cfg.activeTournamentIds || [])[0] || cfg.tournamentId;
  if (!tid) {
    console.log('❌ No hay torneo activo en la config');
    return;
  }
  console.log('🗂️  Torneo activo:', tid);

  // 2. Equipo Azul
  const equiposSnap = await db.collection(`torneos/${tid}/equipos`).get();
  const equipos = equiposSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const azul = equipos.find(e => normalize(e.nombre).includes('azul'));
  if (!azul) {
    console.log('❌ No se encontró equipo que contenga "Azul". Equipos:', equipos.map(e => e.nombre).join(', '));
    return;
  }
  console.log('🔵 Equipo Azul:', azul.nombre, '->', azul.id);

  // 3. Jugadores
  const jugSnap = await db.collection(`torneos/${tid}/jugadores`).get();
  const jugadores = jugSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log('👥 Jugadores totales:', jugadores.length);

  // 4. Match por nombre
  console.log(APPLICATION ? '\n━━━ APLICANDO CAMBIOS ━━━' : '\n━━━ DRY-RUN (previsualización) ━━━');
  const yaAzul = [];
  const asignados = [];
  const sinMatch = [];

  for (const target of LISTA) {
    // Override manual por id
    if (OVERRIDES[target]) {
      const over = jugadores.find(x => x.id === OVERRIDES[target]);
      if (over) {
        const ya = over.equipo_id === azul.id;
        if (ya) {
          console.log(`  ✓ "${target}" → ${over.nombre} ${over.apellidos || ''} (override) YA está en Azul`);
          yaAzul.push(target);
        } else {
          console.log(`  ↦  "${target}" → ${over.nombre} ${over.apellidos || ''} (override manual)`);
          asignados.push({ target, jugador: over, score: 100 });
        }
        continue;
      }
      console.log(`  ⚠️  "${target}": OVERRIDE no encontrado en la base`);
      sinMatch.push(target);
      continue;
    }

    const scored = jugadores
      .map(j => ({ j, score: scoreMatch(j, target) }))
      .filter(x => x.score >= 70)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      console.log(`  ⚠️  "${target}": SIN MATCH`);
      sinMatch.push(target);
      continue;
    }

    const cand = scored[0];
    const confianza = cand.score >= 90 ? 'alta' : cand.score >= 80 ? 'media' : 'baja';
    const ya = cand.j.equipo_id === azul.id;
    if (ya) {
      console.log(`  ✓ "${target}" → ${cand.j.nombre} ${cand.j.apellidos || ''} (${confianza}) YA está en Azul`);
      yaAzul.push(target);
      continue;
    }
    if (scored.length > 1 && cand.score < 90) {
      console.log(`  ⚠️  "${target}" → AMBIGUO (${scored.length}) — ${scored.map(x => x.j.nombre + ' ' + (x.j.apellidos || '')).join(' | ')}`);
    } else if (cand.score < 70) {
      console.log(`  ⚠️  "${target}": SIN MATCH (mejor ${cand.j.nombre} ${cand.j.apellidos || ''} score ${cand.score})`);
      sinMatch.push(target);
      continue;
    } else {
      console.log(`  ↦  "${target}" → ${cand.j.nombre} ${cand.j.apellidos || ''} (${confianza})`);
    }
    asignados.push({ target, jugador: cand.j, score: cand.score });
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`Ya en Azul: ${yaAzul.length} | A asignar: ${asignados.length} | Sin match: ${sinMatch.length}`);
  if (sinMatch.length) console.log('Sin match:', sinMatch.join(' | '));

  if (!APPLICATION) {
    console.log('\nRevisá el output. Para aplicar: node assign_azul.js --aplicar');
    return;
  }

  // 5. Aplicar
  let ok = 0, err = 0;
  for (const { target, jugador } of asignados) {
    try {
      await db.collection(`torneos/${tid}/jugadores`).doc(jugador.id).update({ equipo_id: azul.id });
      console.log(`  ✔ ${target} → ${jugador.nombre} ${jugador.apellidos || ''} asignado a ${azul.nombre}`);
      ok++;
    } catch (e) {
      console.log(`  ✘ ${target}: ${e.message}`);
      err++;
    }
  }
  console.log('\n✅ Aplicados:', ok, '| Errores:', err);
}

main().catch(e => { console.error(e); process.exit(1); });