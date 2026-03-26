/* =========================================================
   0) Tabla MailQueue (si ya existe, saltear CREATE)
   ========================================================= */
IF OBJECT_ID('dbo.MailQueue', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.MailQueue (
        id INT IDENTITY(1,1) PRIMARY KEY,
        to_email NVARCHAR(320) NOT NULL,
        [subject] NVARCHAR(500) NOT NULL,
        [body] NVARCHAR(MAX) NOT NULL,
        attachments NVARCHAR(4000) NULL,
        [status] NVARCHAR(20) NOT NULL DEFAULT N'Waiting', -- Waiting/Sent/Failed/Processing
        retries INT NOT NULL DEFAULT 0,
        error_message NVARCHAR(4000) NULL,
        error_type NVARCHAR(100) NULL,
        last_attempt DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        MailProfile SYSNAME NULL
    );
END
GO

/* =========================================================
   1) Auditoría de acciones del panel
   ========================================================= */
IF OBJECT_ID('dbo.MailAdminAudit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.MailAdminAudit (
        Id BIGINT IDENTITY(1,1) PRIMARY KEY,
        Action NVARCHAR(100) NOT NULL,
        Params NVARCHAR(MAX) NULL,
        ExecutedBy NVARCHAR(200) NOT NULL,
        ExecutedAt DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        Result NVARCHAR(50) NOT NULL,
        ErrorMessage NVARCHAR(2000) NULL
    );
END
GO

/* =========================================================
   2) Sender con @MaxItems y lock de concurrencia
   ========================================================= */
CREATE OR ALTER PROCEDURE dbo.SP_MAILQUEUE_SEND
    @MaxItems INT = 100
AS
BEGIN
    SET NOCOUNT ON;

    IF OBJECT_ID('tempdb..#tmp_pick') IS NULL
    BEGIN
        CREATE TABLE #tmp_pick(
            id INT,
            to_email NVARCHAR(320),
            [subject] NVARCHAR(500),
            [body] NVARCHAR(MAX),
            attachments NVARCHAR(4000),
            MailProfile SYSNAME
        );
    END

    DECLARE
        @processed INT = 0,
        @id INT,
        @to_email NVARCHAR(320),
        @subject NVARCHAR(500),
        @body NVARCHAR(MAX),
        @attachments NVARCHAR(4000),
        @MailProfile SYSNAME,
        @ProfileToUse SYSNAME;

    WHILE @processed < @MaxItems
    BEGIN
        SELECT
            @id=NULL, @to_email=NULL, @subject=NULL, @body=NULL,
            @attachments=NULL, @MailProfile=NULL, @ProfileToUse=NULL;

        ;WITH cte AS (
            SELECT TOP 1 *
            FROM dbo.MailQueue WITH (UPDLOCK, READPAST, ROWLOCK)
            WHERE [status] IN (N'Waiting', N'P') AND retries < 5
            ORDER BY id
        )
        UPDATE cte
        SET [status] = N'Processing',
            last_attempt = GETDATE()
        OUTPUT inserted.id, inserted.to_email, inserted.[subject], inserted.[body], inserted.attachments, inserted.MailProfile
        INTO #tmp_pick(id, to_email, [subject], [body], attachments, MailProfile);

        SELECT TOP 1
            @id = id,
            @to_email = to_email,
            @subject = [subject],
            @body = [body],
            @attachments = attachments,
            @MailProfile = MailProfile
        FROM #tmp_pick;

        DELETE FROM #tmp_pick;

        IF @id IS NULL BREAK;

        SET @ProfileToUse = ISNULL(NULLIF(LTRIM(RTRIM(@MailProfile)), N''), N'prueba');

        BEGIN TRY
            IF @attachments IS NULL OR LTRIM(RTRIM(@attachments)) = N''
            BEGIN
                EXEC msdb.dbo.sp_send_dbmail
                    @profile_name = @ProfileToUse,
                    @recipients = @to_email,
                    @subject = @subject,
                    @body = @body,
                    @body_format = 'HTML';
            END
            ELSE
            BEGIN
                EXEC msdb.dbo.sp_send_dbmail
                    @profile_name = @ProfileToUse,
                    @recipients = @to_email,
                    @subject = @subject,
                    @body = @body,
                    @body_format = 'HTML',
                    @file_attachments = @attachments;
            END

            UPDATE dbo.MailQueue
            SET [status] = N'Sent',
                error_message = NULL,
                error_type = NULL,
                last_attempt = GETDATE()
            WHERE id = @id;
        END TRY
        BEGIN CATCH
            UPDATE dbo.MailQueue
            SET retries = retries + 1,
                [status] = CASE WHEN retries + 1 >= 5 THEN N'Failed' ELSE N'Waiting' END,
                error_message = ERROR_MESSAGE(),
                error_type = N'DBMAIL',
                last_attempt = GETDATE()
            WHERE id = @id;
        END CATCH;

        SET @processed += 1;
    END
END
GO

/* =========================================================
   3) Wrappers admin (botones de panel)
   ========================================================= */
CREATE OR ALTER PROCEDURE dbo.SP_ADMIN_RUN_SENDER
    @MaxItems INT = 100,
    @ExecutedBy NVARCHAR(200) = N'web'
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        EXEC dbo.SP_MAILQUEUE_SEND @MaxItems = @MaxItems;
        INSERT INTO dbo.MailAdminAudit(Action, Params, ExecutedBy, Result)
        VALUES (N'RUN_SENDER', CONCAT(N'MaxItems=', @MaxItems), @ExecutedBy, N'OK');
    END TRY
    BEGIN CATCH
        INSERT INTO dbo.MailAdminAudit(Action, Params, ExecutedBy, Result, ErrorMessage)
        VALUES (N'RUN_SENDER', CONCAT(N'MaxItems=', @MaxItems), @ExecutedBy, N'ERROR', ERROR_MESSAGE());
        THROW;
    END CATCH
END
GO

CREATE OR ALTER PROCEDURE dbo.SP_ADMIN_REQUEUE_FAILED
    @ExecutedBy NVARCHAR(200) = N'web'
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        UPDATE dbo.MailQueue
        SET [status] = N'Waiting',
            retries = 0,
            error_message = NULL,
            error_type = NULL,
            last_attempt = NULL
        WHERE [status] = N'Failed';

        INSERT INTO dbo.MailAdminAudit(Action, Params, ExecutedBy, Result)
        VALUES (N'REQUEUE_FAILED', NULL, @ExecutedBy, N'OK');
    END TRY
    BEGIN CATCH
        INSERT INTO dbo.MailAdminAudit(Action, Params, ExecutedBy, Result, ErrorMessage)
        VALUES (N'REQUEUE_FAILED', NULL, @ExecutedBy, N'ERROR', ERROR_MESSAGE());
        THROW;
    END CATCH
END
GO

CREATE OR ALTER PROCEDURE dbo.SP_ADMIN_RUN_PRODUCER
    @ProcName SYSNAME,
    @ExecutedBy NVARCHAR(200) = N'web'
AS
BEGIN
    SET NOCOUNT ON;

    IF @ProcName NOT IN (N'SP_ENVIO_INFORMEPACIENTE_1', N'SP_ENVIOMAILPERSONAL_PRUEBA')
    BEGIN
        RAISERROR('SP no permitido.',16,1);
        RETURN;
    END

    BEGIN TRY
        DECLARE @sql NVARCHAR(MAX) = N'EXEC dbo.' + QUOTENAME(@ProcName) + N';';
        EXEC sp_executesql @sql;

        INSERT INTO dbo.MailAdminAudit(Action, Params, ExecutedBy, Result)
        VALUES (N'RUN_PRODUCER', @ProcName, @ExecutedBy, N'OK');
    END TRY
    BEGIN CATCH
        INSERT INTO dbo.MailAdminAudit(Action, Params, ExecutedBy, Result, ErrorMessage)
        VALUES (N'RUN_PRODUCER', @ProcName, @ExecutedBy, N'ERROR', ERROR_MESSAGE());
        THROW;
    END CATCH
END
GO

/* =========================================================
   4) Métricas para dashboard
   ========================================================= */
CREATE OR ALTER VIEW dbo.VW_MAILQUEUE_METRICS
AS
SELECT
    SUM(CASE WHEN [status] IN (N'Waiting',N'P',N'Processing') THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN [status] = N'Sent' THEN 1 ELSE 0 END) AS sent,
    SUM(CASE WHEN [status] = N'Failed' THEN 1 ELSE 0 END) AS failed,
    COUNT(*) AS total
FROM dbo.MailQueue;
GO
