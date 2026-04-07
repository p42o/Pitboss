import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyA1l2XHoYRK49j-zKnxhDRJ8RFelaJ6B4c",
  authDomain: "pitboss-92bba.firebaseapp.com",
  projectId: "pitboss-92bba",
  storageBucket: "pitboss-92bba.firebasestorage.app",
  messagingSenderId: "444663765414",
  appId: "1:444663765414:web:8595f71c7417850138d767",
  measurementId: "G-0WV7YSLCVM"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// experimentalAutoDetectLongPolling: automatically falls back from WebChannel
// to long-polling when the WebChannel XHR stream is blocked (CORS access control
// errors). This eliminates the "Fetch API cannot load ...Listen/channel" error.
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true
});
export default app;
