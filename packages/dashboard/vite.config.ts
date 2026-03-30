import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget =
    env.LOCAL_API_PROXY_TARGET || env.VITE_LOCAL_API_PROXY_TARGET || "http://localhost:3001";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": apiProxyTarget,
      },
    },
  };
});
