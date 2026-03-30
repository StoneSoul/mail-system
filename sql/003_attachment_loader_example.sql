/* Ejemplo: insertar adjuntos binarios directamente a MailQueueAttachments */
USE MailDB;
GO

DECLARE @mail_id BIGINT;
INSERT INTO dbo.MailQueue (sender_profile, recipients, subject, body, body_format)
VALUES ('default', 'test@example.com', 'Mail con adjunto', N'Adjunto de prueba', 'TEXT');
SET @mail_id = SCOPE_IDENTITY();

-- Reemplazar con OPENROWSET/VARBINARY real según políticas de seguridad
-- INSERT INTO dbo.MailQueueAttachments(mail_queue_id, file_name, content_type, file_content, file_size_bytes)
-- SELECT @mail_id, 'reporte.pdf', 'application/pdf', BulkColumn, DATALENGTH(BulkColumn)
-- FROM OPENROWSET(BULK N'C:\rutas\reporte.pdf', SINGLE_BLOB) AS X;
GO
