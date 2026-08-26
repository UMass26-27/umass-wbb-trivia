// Firebase project config for UMass WBB Away Game Trivia.
// These values are the public web-app config Firebase issues for client apps
// (safe to expose in client code) — access control is enforced by firestore.rules,
// not by hiding this file.
export const firebaseConfig = {
  apiKey: "AIzaSyAyRUnBpd7W9dC03aBNaVK1NcbfieL1lSE",
  authDomain: "umass-wbb-trivia.firebaseapp.com",
  projectId: "umass-wbb-trivia",
  storageBucket: "umass-wbb-trivia.firebasestorage.app",
  messagingSenderId: "1030999104256",
  appId: "1:1030999104256:web:c9ba7efc92df4e8f8e71e5"
};

// Only these accounts may sign in to the admin panel.
export const ADMIN_EMAILS = ["simonemorin@umass.edu", "simonegmorin@gmail.com"];
