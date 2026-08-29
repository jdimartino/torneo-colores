import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDXFRqwIvL2GYRC24abE-ovTxepCsX8p1o",
  authDomain: "tucanapp-pos.firebaseapp.com",
  projectId: "tucanapp-pos",
  storageBucket: "tucanapp-pos.firebasestorage.app",
  messagingSenderId: "833846886165",
  appId: "1:833846886165:web:28746819de42fbddd1331c"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const UID = "PDi4YCBPk0NTOqLJf4QwUp8OWYf2";

await setDoc(doc(db, 'config', 'admin'), { adminUids: [UID] });
console.log("✅ config/admin creado con UID:", UID);
