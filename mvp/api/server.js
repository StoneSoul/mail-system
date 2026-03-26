require("dotenv").config();

console.warn("[deprecated] mvp/api/server.js ahora delega en api/app.js (API unificada).");

import("../../api/app.js").catch((err) => {
  console.error("No se pudo iniciar la API unificada:", err);
  process.exit(1);
});
