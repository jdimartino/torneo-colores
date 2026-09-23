// Asigna una lista de jugadores al equipo "Verde" del torneo activo.
// Uso:
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/dimartinoj_gmail_com_application_default_credentials.json node assign_verde.js        # dry-run
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/firebase/dimartinoj_gmail_com_application_default_credentials.json node assign_verde.js --aplicar  # aplica
const admin = require('firebase-admin');

const APPLICATION = process.argv.includes('--aplicar');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'torneos-tenis-jdm'
});

const db = admin.firestore();

// IDs exactos verificados en la base del torneo YqCtjP3ovdOQr2xLHAS7
const LISTA = [
  { label: 'Maikel',            id: 'y34kcVmMqUdTUSFpmI4T' },
  { label: 'Lucrecia',          id: 'lYFC4AuC7cEsKbJq0Uye' },
  { label: 'Valentina',         id: 'BETIVzIhRiiBpsgIuk72' },
  { label: 'José Luis',         id: 'JevIBh3sjcFjdJEJtE6M' },
  { label: 'Juan',              id: '4HLMpwViVR59791Qdvpe' },
  { label: 'Jonathan',          id: 'QMcSFzRdZdAYG3Aq6LeI' },
  { label: 'Yolbert',           id: 'w19WzFLYCRuTtA9ZjnOx' },
  { label: 'Eduardito',         id: '8kq7j4my2YpmCUwCpAv0' },
  { label: 'Carlos Reyes',      id: '8XDsikSdacDd01Q4c0IM' },
  { label: 'Alejandro',         id: 'IpmoGH1RddBYEq8xedBC' },
  { label: 'Cirpriano Padre',   id: 'Qp6SjPkSqLsOXMGk8D8G' },
  { label: 'Milagros',          id: 'PaxC4GWkcCpdFmzzIyjn' },
  { label: 'Adriana',           id: 'OoVXOyu1M2x8bBBQXFP5' },
  { label: 'Janina',            id: 'CJ90xl25K7q9Cssq7gh9' },
  { label: 'Thais',             id: 'K8QZwz6azcv1Y481YsQr' }
];

async function main() {
  const cfgSnap = await db.doc('config/torneosColores_activeTournament').get();
  const cfg = cfgSnap.data();
  const tid = cfg.selectedTournamentId || (cfg.activeTournamentIds || [])[0] || cfg.tournamentId;
  if (!tid) { console.log('❌ No hay torneo activo'); return; }
  console.log('🗂️  Torneo:', tid);

  const equiposSnap = await db.collection(`torneosColores/${tid}/equipos`).get();
  const verde = equiposSnap.docs.find(d => {
    const n = String(d.data().nombre || '').toLowerCase();
    return n.includes('verde');
  });
  if (!verde) { console.log('❌ Equipo Verde no encontrado'); return; }
  console.log('🟢 Equipo Verde:', verde.id);
  console.log('👥 A asignar:', LISTA.length);

  const ids = LISTA.map(x => x.id);
  const jugSnap = await db.collection(`torneosColores/${tid}/jugadores`).where(admin.firestore.FieldPath.documentId(), 'in', ids).get();
  const existentes = new Map(jugSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));

  console.log(APPLICATION ? '\n━━━ APLICANDO ━━━' : '\n━━━ DRY-RUN ━━━');
  let ok = 0, err = 0, skip = 0;

  for (const { label, id } of LISTA) {
    const j = existentes.get(id);
    if (!j) { console.log(`  ⚠️  ${label} (${id}): no encontrado`); err++; continue; }
    if (j.equipo_id === verde.id) { console.log(`  ✓ ${label}: ya está en Verde`); skip++; continue; }
    if (j.equipo_id) { console.log(`  ⚠️  ${label} (${j.nombre} ${j.apellidos||''}): ya asignado a otro equipo (${j.equipo_id})`); err++; continue; }
    if (APPLICATION) {
      await db.collection(`torneosColores/${tid}/jugadores`).doc(id).update({ equipo_id: verde.id });
      console.log(`  ✔ ${label} (${j.nombre} ${j.apellidos||''}) → Verde`);
    } else {
      console.log(`  ↦ ${label} (${j.nombre} ${j.apellidos||''}) → Verde`);
    }
    ok++;
  }

  console.log(`\n✅ Asignados: ${ok} | Ya en Verde: ${skip} | Errores: ${err}`);
  if (!APPLICATION) console.log('Revisá el output. Para aplicar: node assign_verde.js --aplicar');
}

main().catch(e => { console.error(e); process.exit(1); });
