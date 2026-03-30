# MVP Mail Fullboard

Implementación rápida con 3 piezas:

1. `sql/mail_fullboard.sql`: crea/ajusta objetos SQL (cola, sender, wrappers admin, métricas).
2. `api/`: shim de compatibilidad (la API real unificada vive en `../api/app.js`).
3. `web/index.html`: panel web estático servido por la API unificada.

## Puesta en marcha

### 1) SQL Server
Ejecuta `sql/mail_fullboard.sql` en la base que contiene `dbo.MailQueue`.

### 2) API (Node directo)
```bash
npm install
npm run start:api
```

La API usa `PORT` por variable de entorno y, si no se define, escucha en `80`.

### 3) Panel
El login y panel se sirven de forma nativa desde la API en `http://host/`.

- Login: `GET /`
- Fullboard: `GET /` (render según sesión)
- Healthcheck: `GET /health`

## Cambiar puerto (opcional)

Si necesitás otro puerto por compatibilidad o pruebas:

```bash
PORT=8080 npm run start:api
```

El panel y las vistas internas usan por defecto el mismo `origin` del navegador, por lo que no dependen de `localhost:3000`.
