import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";

// Firebase web config (Project settings → General → Your apps).
// These values are not secret — they are shipped to the client.
const firebaseConfig = {
  apiKey: "AIzaSyD9XTIVvRjrresORrMmHVE6phZLCPq28RU",
  authDomain: "catalyst-de16d.firebaseapp.com",
  projectId: "catalyst-de16d",
  storageBucket: "catalyst-de16d.firebasestorage.app",
  messagingSenderId: "1067471750",
  appId: "1:1067471750:web:e25d84a7c5c732dcb09207",
  measurementId: "G-48RP6KKFVY",
};

export const app = initializeApp(firebaseConfig);

// Analytics only works in supported environments (browser, https/localhost).
// isSupported() guards against errors during SSR/tests/unsupported browsers.
export let analytics: Analytics | null = null;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});
