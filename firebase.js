import { firebaseConfig } from "./config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, getDocs, onSnapshot, serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

function ensureConfig(cfg){
  const bad = Object.values(cfg || {}).some(v => (typeof v !== "string") || v.includes("PASTE_HERE"));
  if(bad){
    throw new Error("Firebase config missing. Open assets/config.js and paste firebaseConfig from Firebase Console.");
  }
}

ensureConfig(firebaseConfig);

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Auth helpers
export const Auth = {
  onChange: (cb) => onAuthStateChanged(auth, cb),
  login: (email, pass) => signInWithEmailAndPassword(auth, email, pass),
  register: (email, pass) => createUserWithEmailAndPassword(auth, email, pass),
  logout: () => signOut(auth)
};

// Firestore helpers (exports used by app.js)
export const FS = {
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, getDocs, onSnapshot, serverTimestamp,
  runTransaction
};
