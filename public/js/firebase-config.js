// firebase-config.js
// Fill this in with your project's config (Firebase Console → Project settings
// → General → "Your apps" → SDK setup and configuration → Config).
// This is safe to keep client-side — Firebase web config is not a secret,
// access is controlled by Security Rules (firestore.rules / storage.rules).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
// No Cloud Storage, no Cloud Functions in this build — both need the paid
// Blaze plan. Everything here runs on Auth + Firestore, which stay on the
// free Spark plan.

const firebaseConfig = {
  apiKey: "AIzaSyDVFHlqTI08moK8aq2KClL0KV72_FWWgK0",
  authDomain: "reporting-ai-assistant.firebaseapp.com",
  projectId: "reporting-ai-assistant",
  storageBucket: "reporting-ai-assistant.firebasestorage.app",
  messagingSenderId: "4726691306",
  appId: "1:4726691306:web:6169fe78614d12cacfce93",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// experimentalForceLongPolling: forces Firestore to use plain HTTP long
// polling instead of its default streaming transport. Corporate proxies/VPNs
// (like the one on this network) often break or badly throttle the
// streaming connection, which is what caused the very slow, erratic upload
// times (some requests taking 30+ seconds). Long polling is slightly less
// efficient on unrestricted networks, but far more reliable behind
// inspecting proxies.
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false,
});