const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

let firebaseApp = null;
let db = null;
let auth = null;

try {
  if (getApps().length === 0) {
    let serviceAccount = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    }
    if (serviceAccount) {
      firebaseApp = initializeApp({ credential: cert(serviceAccount) });
      db = getFirestore(firebaseApp);
      auth = getAuth(firebaseApp);
      console.log('[Firebase] Initialized for project:', serviceAccount.project_id);
    } else {
      console.log('[Firebase] No service account configured — Firebase routes disabled');
    }
  } else {
    firebaseApp = getApps()[0];
    db = getFirestore(firebaseApp);
    auth = getAuth(firebaseApp);
  }
} catch (err) {
  console.error('[Firebase] Init failed:', err.message);
  firebaseApp = null;
  db = null;
  auth = null;
}

const firebaseConfig = {
  apiKey: "AIzaSyDj1oCJ1U_53nBf8TgguKwueK21KYUGKUI",
  authDomain: "multiverse-backends.firebaseapp.com",
  projectId: "multiverse-backends",
  storageBucket: "multiverse-backends.firebasestorage.app",
  messagingSenderId: "694872791296",
  appId: "1:694872791296:web:8c1cfe19a16b71f5a2bbe5"
};

function isReady() {
  return db !== null && auth !== null;
}

module.exports = { firebaseApp, db, auth, isReady, firebaseConfig, FieldValue };
