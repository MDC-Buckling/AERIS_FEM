import React from "react";
import ReactDOM from "react-dom/client";

// MDC-Codex spec note: load JetBrains Mono properly via @fontsource so the
// monospace-everywhere look isn't a roll of the dice on each user's system.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/800.css";

import "./theme.css";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
