# Adaptación de `SP_ENVIOMAILPERSONAL` para encolar en SQL Express y enviar desde SQL Express

Este enfoque separa **generación** y **envío**:

1. En servidor `IMC` (origen): el SP ya no ejecuta `sp_send_dbmail`; inserta una fila en una cola.
2. En servidor `SQL Express` (relay): otro SP toma pendientes y ejecuta `msdb.dbo.sp_send_dbmail`.

## 1) En SQL Express: tabla de cola

```sql
CREATE TABLE dbo.MailQueue (
    Id BIGINT IDENTITY(1,1) PRIMARY KEY,
    Nombre        NVARCHAR(100) NULL,
    Correo        NVARCHAR(320) NOT NULL,
    SubjectText   NVARCHAR(500) NOT NULL,
    BodyHtml      NVARCHAR(MAX) NOT NULL,
    AttachmentPath NVARCHAR(4000) NULL,
    Status        CHAR(1) NOT NULL DEFAULT 'P', -- P=Pendiente, E=Enviado, X=Error
    Retries       INT NOT NULL DEFAULT 0,
    LastError     NVARCHAR(2000) NULL,
    CreatedAt     DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    SentAt        DATETIME2 NULL,
    sender_profile SYSNAME NULL,
    source_environment NVARCHAR(64) NULL
);
```

## 2) En SQL Express: SP de envío

```sql
CREATE OR ALTER PROCEDURE dbo.SP_MAILQUEUE_SEND
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE
        @Id BIGINT,
        @Correo NVARCHAR(320),
        @Sub NVARCHAR(500),
        @Bod NVARCHAR(MAX),
        @File NVARCHAR(4000),
        @sender_profile SYSNAME;

    WHILE 1 = 1
    BEGIN
        ;WITH cte AS (
            SELECT TOP (1) *
            FROM dbo.MailQueue WITH (UPDLOCK, READPAST, ROWLOCK)
            WHERE Status = 'P' AND Retries < 5
            ORDER BY Id
        )
        UPDATE cte
            SET Status = 'P' -- lock lógico por transacción
        OUTPUT inserted.Id, inserted.Correo, inserted.SubjectText,
               inserted.BodyHtml, inserted.AttachmentPath, inserted.sender_profile
        INTO #pick;

        IF @@ROWCOUNT = 0 BREAK;

        SELECT TOP (1)
            @Id = Id,
            @Correo = Correo,
            @Sub = SubjectText,
            @Bod = BodyHtml,
            @File = AttachmentPath
        FROM #pick;

        BEGIN TRY
            EXEC msdb.dbo.sp_send_dbmail
                @profile_name = ISNULL(NULLIF(@sender_profile, ''), 'prueba'),
                @recipients = @Correo,
                @subject = @Sub,
                @body = @Bod,
                @body_format = 'HTML',
                @importance = 'HIGH',
                @file_attachments = @File;

            UPDATE dbo.MailQueue
               SET Status = 'E', SentAt = SYSDATETIME(), LastError = NULL
             WHERE Id = @Id;
        END TRY
        BEGIN CATCH
            UPDATE dbo.MailQueue
               SET Status = CASE WHEN Retries + 1 >= 5 THEN 'X' ELSE 'P' END,
                   Retries = Retries + 1,
                   LastError = ERROR_MESSAGE()
             WHERE Id = @Id;
        END CATCH;

        DELETE FROM #pick;
        WAITFOR DELAY '00:00:02';
    END
END;
```

> Nota: antes de usar `#pick`, crearla al inicio del SP:
>
> ```sql
> CREATE TABLE #pick (
>   Id BIGINT,
>   Correo NVARCHAR(320),
>   SubjectText NVARCHAR(500),
>   BodyHtml NVARCHAR(MAX),
>   AttachmentPath NVARCHAR(4000),
>   sender_profile SYSNAME
> );
> ```

## 3) En IMC: reemplazar envío directo por inserción en SQL Express

Tienes dos caminos:

- **A. Linked Server** desde `IMC` hacia `SQL Express`.
- **B. Sin linked server**: exponer un SP en `SQL Express` y llamarlo desde app/ETL.

Con Linked Server (ejemplo), dentro de tu cursor, reemplaza `sp_send_dbmail` por:

```sql
INSERT INTO [SQLX].[MailRelayDB].[dbo].[MailQueue]
    (Nombre, Correo, SubjectText, BodyHtml, AttachmentPath, sender_profile, source_environment)
VALUES
    (@NOMBRE, @CORREO, @SUB, @BOD, @FILE, @PROFILE, @AMBIENTE);
```

Donde `SQLX` es el nombre del linked server y `MailRelayDB` la base en SQL Express.

## 4) Ajuste puntual a tu SP actual

En tu SP original tienes una línea de prueba que pisa el destinatario:

```sql
SELECT @CORREO = 'dvr@enviosimc.info'
```

Para producción, esa línea debe comentarse/eliminarse; de lo contrario todos los correos irán a la misma cuenta.

## 5) Requisitos importantes

1. `Database Mail XPs` habilitado en SQL Express (`sp_configure`).
2. Perfil `prueba` creado en SQL Express y con permisos al login que ejecuta el SP.
3. El archivo adjunto (`\\Dttprod\c$\TMP\COMPUTOS_2023.PDF`) debe ser accesible desde **el servidor SQL Express**, no desde tu PC.
4. Si no hay SQL Agent (común en Express), ejecutar `SP_MAILQUEUE_SEND` desde:
   - Task Scheduler + `sqlcmd`, o
   - un servicio/worker de aplicación.

## 6) Variante mínima (sin tabla de cola)

Si solo quieres “reenviar” y no dejar cola persistente, en `IMC` podrías ejecutar un SP remoto en SQL Express que reciba parámetros y llame `sp_send_dbmail`. Funciona, pero pierdes trazabilidad, reintentos y auditoría.

---

Si quieres, en un siguiente paso te paso el `ALTER PROCEDURE [dbo].[SP_ENVIOMAILPERSONAL]` completo ya reescrito para tu esquema real (`Linked Server`, nombre de DB, y política de reintentos).

## 7) Topología recomendada para este proyecto

Para evitar confusiones con bases locales dentro de carpetas del repo:

- El servicio Node **no usa archivos `.mdf/.ldf` en el proyecto**.
- La base de cola local del servicio debe ser `MailDB` en el SQL Express del mismo host del servicio (ej.: `SRV-EnviosMail` / `192.168.14.4`).
- Los objetos `dbo` remotos deben consultarse por catálogo en servidores externos, por ejemplo:
  - Producción (`DTTPROD` / `192.168.16.31`): `IMC`, `IMC_DATOS`.
  - Prueba (`DTTPRUEBA` / `192.168.16.19`): `IMC`, `IMC_DATOS`, `IMC_PRUEBA`, `IMC_PRUEBAIT`.

Variables sugeridas en `.env` para dejarlo explícito:

```env
DB_SERVER=192.168.14.4
DB_NAME=MailDB

PROD_DB_SERVER=192.168.16.31
PROD_DB_NAME=IMC
PROD_DB_CATALOG=IMC,IMC_DATOS

TEST_DB_SERVER=192.168.16.19
TEST_DB_NAME=IMC_PRUEBAIT
TEST_DB_CATALOG=IMC,IMC_DATOS,IMC_PRUEBA,IMC_PRUEBAIT
```
