import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ root: "workspace", plugins: [react()], build: { outDir: "../dist-workspace", emptyOutDir: true } });