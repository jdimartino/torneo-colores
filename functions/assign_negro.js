// Asigna una lista de jugadores al equipo "Negro" del torneo activo.
// Uso:
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/dimartinoj_gmail_com_application_default_credentials.json node assign_negro.js        # dry-run
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/dimartinoj_gmail_com_application_default_credentials.json node assign_negro.js --aplicar  # aplica
const admin = require('firebase-admin');

const APPLICATION = process.argv.includes('--aplicar');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'torneos-tenis-jdm'
});

const db = admin.firestore();

const LISTA = [
  { label: 'Meche Luque',      id: 'NZrG2MMvadsjbVStYhv0' },
  { label: 'TACAli Ferrer',     id: 'bnnJJgDP3nNeWxKGFqIT' },
  { label: 'Ángel López',       id: 'AId7NiGnmyTgN7hqhnTq' },
  { label: 'Carlos Morles',     id: 'JvcfA4EzZaP68BepXN8W' },
  { label: 'Carolina Lezama',   id: '9QZt988Nz9JB4WPc9DOc' },
  { label: 'Graciela',          id: 'el58g6DOfroe7lQdvDuT' },
  { label: 'Hilda',             id: '5KZEtzTKYUZJ153jNZZo' },
  { label: 'Javier Montilla',   id: 'u594lCHEAcEYBZrba8rj' },
  { label: 'Linda',             id: 'GPuVYnUINcEEWjwOcYuO' },
  { label: 'Lorena Olivares',   id: '7L25dKcW4o3lrPPSJr1e' },
  { label: 'Marcos Pereira',    id: 'krTbagqdfAosPl66JTBW' },
  { label: 'Rafael Solano',     id: 'hAr0ySSHr3CcxFJiDaEs' },
  { label: 'Raul Carrillo',     id: 'GxcghvzZknqV6EUqx3d6' },
  { label: 'Shantal',           id: 'LmY5fMubU1usYIs34oWt' },
  { label: 'Yosangel',          id: 'p7eWtVJ07NMJ3XJqk5Dh' },
  { label: 'Yudith Hailaneh',   id: 'Jep1hJxCjnvcVwVFI5P7' },
  { label: 'Jorge Arrieta',     id: 'pYcyLeHd1nsGA7lu4LDW' }
];

async function main() {
  const cfgSnap = await db.doc('config/activeTournament').get();
  const cfg = cfgSnap.data();
  const tid = cfg.selectedTournamentId || (cfg.activeTournamentIds || [])[0] || cfg.tournamentId;
  if (!tid) { console.log('❌ No hay torneo activo'); return; }
  console.log('🗂️  Torneo:', tid);

  const equiposSnap = await db.collection(`torneos/${tid}/equipos`).get();
  const negro = equiposSnap.docs.find(d => {
    const n = String(d.data().nombre || '').toLowerCase();
    return n.includes('negro');
  });
  if (!negro) { console.log('❌ Equipo Negro no encontrado'); return; }
  console.log('⚫ Equipo Negro:', negro.id);
  console.log('👥 A asignar:', LISTA.length);

  const ids = LISTA.map(x => x.id);
  const jugSnap = await db.collection(`torneos/${tid}/jugadores`).where(admin.firestore.FieldPath.documentId(), 'in', ids).get();
  const existentes = new Map(jugSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));

  console.log(APPLICATION ? '\n━━━ APLICANDO ━━━' : '\n━━━ DRY-RUN ━━━');
  let ok = 0, err = 0, skip = 0;

  for (const { label, id } of LISTA) {
    const j = existentes.get(id);
    if (!j) { console.log(`  ⚠️  ${label} (${id}): no encontrado`); err++; continue; }
    if (j.equipo_id === negro.id) { console.log(`  ✓ ${label}: ya está en Negro`); skip++; continue; }
    if (j.equipo_id) { console.log(`  ⚠️  ${label} (${j.nombre} ${j.apellidos||''}): ya asignado a otro equipo (${j.equipo_id})`); err++; continue; }
    if (APPLICATION) {
      await db.collection(`torneos/${tid}/jugadores`).doc(id).update({ equipo_id: negro.id });
      console.log(`  ✔ ${label} (${j.nombre} ${j.apellidos||''}) → Negro`);
    } else {
      console.log(`  ↦ ${label} (${j.nombre} ${j.apellidos||''}) → Negro`);
    }
    ok++;
  }

  console.log(`\n✅ Asignados: ${ok} | Ya en Negro: ${skip} | Errores: ${err}`);
  if (!APPLICATION) console.log('Revisá el output. Para aplicar: node assign_negro.js --aplicar');
}

main().catch(e => { console.error(e); process.exit(1); });
