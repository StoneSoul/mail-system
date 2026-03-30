/*
  Instalar en msdb para interceptar dbmail y persistir en MailDB.
  Requiere: MailDB.dbo.MailQueue y MailDB.dbo.MailQueueAttachments.
*/
USE msdb;
GO

CREATE OR ALTER PROCEDURE dbo.sp_send_dbmail
  @profile_name sysname = NULL,
  @recipients VARCHAR(MAX) = NULL,
  @copy_recipients VARCHAR(MAX) = NULL,
  @blind_copy_recipients VARCHAR(MAX) = NULL,
  @from_address VARCHAR(MAX) = NULL,
  @reply_to VARCHAR(MAX) = NULL,
  @subject NVARCHAR(255) = NULL,
  @body NVARCHAR(MAX) = NULL,
  @body_format VARCHAR(20) = 'HTML',
  @file_attachments NVARCHAR(MAX) = NULL,
  @mailitem_id INT = NULL OUTPUT
AS
BEGIN
  SET NOCOUNT ON;

  IF NULLIF(LTRIM(RTRIM(@recipients)), '') IS NULL
    THROW 50001, 'sp_send_dbmail interceptado: recipients es obligatorio.', 1;

  IF NULLIF(LTRIM(RTRIM(@subject)), '') IS NULL
    THROW 50002, 'sp_send_dbmail interceptado: subject es obligatorio.', 1;

  DECLARE @mailQueueId BIGINT;

  INSERT INTO MailDB.dbo.MailQueue (
    source_mailitem_id,
    sender_profile,
    recipients,
    copy_recipients,
    blind_copy_recipients,
    reply_to,
    subject,
    body,
    body_format,
    file_attachments,
    status
  )
  VALUES (
    NULL,
    ISNULL(NULLIF(@profile_name, ''), 'default'),
    @recipients,
    @copy_recipients,
    @blind_copy_recipients,
    @reply_to,
    @subject,
    ISNULL(@body, N''),
    UPPER(ISNULL(NULLIF(@body_format, ''), 'HTML')),
    @file_attachments,
    'PENDING'
  );

  SET @mailQueueId = SCOPE_IDENTITY();
  SET @mailitem_id = CONVERT(INT, @mailQueueId);

  SELECT @mailitem_id AS mailitem_id;
END
GO
