import { getAuth } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { app, db } from './firebasePublic.js';

const auth = getAuth(app);
const functions = getFunctions(app);

export { app, db, auth, functions };