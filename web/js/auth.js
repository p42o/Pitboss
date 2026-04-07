import { auth } from './firebase-init.js';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

export function requireAuth(redirectTo = 'index.html') {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      if (!user) {
        window.location.href = redirectTo;
      } else {
        resolve(user);
      }
    });
  });
}

export async function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function logout() {
  await signOut(auth);
  window.location.href = 'index.html';
}

export function getCurrentUser() {
  return auth.currentUser;
}

export { onAuthStateChanged, auth };
