# Mail System (SQL Queue + Dispatcher + Worker)

Sistema para reemplazar `msdb.dbo.sp_send_dbmail` por persistencia en SQL y envío externo.

## Arquitectura objetivo
1. SQL Server llama `msdb.dbo.sp_send_dbmail` (interceptado).
2. El interceptor inserta en `MailDB.dbo.MailQueue`.
3. Inserta adjuntos en `MailDB.dbo.MailQueueAttachments` (modelo principal SQL-first).
4. `dispatcher` reclama mails pendientes en SQL con lock.
5. Publica jobs idempotentes en BullMQ (`jobId=mail-{id}`).
6. `worker` envía por SMTP/API, registra estado y errores.
7. Se actualizan reintentos, categorías de error, trazabilidad y recuperación de locks expirados.

## Requisitos
- Node.js 20+
- SQL Server
- Redis/Memurai

## Configuración
1. Copiar `.env.example` a `.env` y completar valores.
2. Variables críticas obligatorias:
   - `DB_SERVER`, `DB_NAME`
   - `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST` (o `SMTP_ACCOUNTS_JSON`)
   - `PANEL_USER`, `PANEL_PASS` (si se inicia API)

El sistema falla en startup si faltan secretos críticos de SMTP o panel.

## SQL de instalación
Ejecutar en orden:
1. `sql/001_mailqueue_schema.sql`
2. `sql/002_intercept_sp_send_dbmail.sql`
3. `sql/003_attachment_loader_example.sql` (referencia)

## Inicio
- API: `npm run start:api`
- Dispatcher: `node dispatcher/dispatcher.js`
- Worker: `npm run start:worker`

## Manejo de errores
Categorías:
- `RATE_LIMIT_HOURLY`
- `TEMPORARY`
- `MAILBOX_NOT_FOUND`
- `MAILBOX_FULL`
- `AUTH`
- `DNS`
- `CONNECTION`
- `HARD`
- `UNKNOWN`

Se persisten en `MailQueue.error_category` y `MailQueue.last_error`.

## Pruebas
`npm test`

Cubre clasificación de errores, perfiles SMTP, política de reintentos y estructura SQL del flujo de cola.
