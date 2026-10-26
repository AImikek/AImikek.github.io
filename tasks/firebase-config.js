// Firebase config for the Tasks app (its own Firebase project "mikek-tasks", separate from PBT).
// From Firebase Console > mikek-tasks > Project settings > Your apps > Tasks (web).
window.TASKS_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCiuMP0cdDVPf9yTFVOrGRbYMOmPNJAjyk",
  authDomain: "mikek-tasks.firebaseapp.com",
  databaseURL: "https://mikek-tasks-default-rtdb.firebaseio.com",
  projectId: "mikek-tasks",
  storageBucket: "mikek-tasks.firebasestorage.app",
  messagingSenderId: "948487107546",
  appId: "1:948487107546:web:516d85e028c74460b586e3"
};

// Assistant brain (Cloudflare Worker in tasks/worker/). Leave empty to use the built-in rules only.
window.TASKS_AI_ENDPOINT = '';
