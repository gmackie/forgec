import React from "react";
import { createRoot } from "react-dom/client";
import "@cloudflare/kumo/styles/standalone";
import "./style.css";
import { Console } from "./console.js";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Console />
  </React.StrictMode>,
);
