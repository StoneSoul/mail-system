# MVP Mail Fullboard

Implementación rápida con 3 piezas:

1. `sql/mail_fullboard.sql`: crea/ajusta objetos SQL (cola, sender, wrappers admin, métricas).
2. `api/`: shim de compatibilidad (la API real unificada vive en `../api/app.js`).
3. `web/index.html`: panel web estático.

## Puesta en marcha

### 1) SQL Server
Ejecuta `sql/mail_fullboard.sql` en la base que contiene `dbo.MailQueue`.

### 2) API
```bash
npm install
npm run start:api
```

### 3) Panel
Abrí `mvp/web/index.html` en el navegador (o sírvelo con cualquier servidor estático).

Por defecto consume `http://localhost:3000/api`.
