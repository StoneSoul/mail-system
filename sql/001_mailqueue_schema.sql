/* Canonical schema para MailDB */
IF DB_ID(N'MailDB') IS NULL
BEGIN
  RAISERROR('Database MailDB no existe.', 16, 1);
  RETURN;
END
GO
USE MailDB;
GO

IF OBJECT_ID(N'dbo.MailQueue', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MailQueue (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    source_mailitem_id INT NULL,
    sender_profile NVARCHAR(100) NOT NULL CONSTRAINT DF_MailQueue_sender_profile DEFAULT ('default'),
    recipients NVARCHAR(MAX) NOT NULL,
    copy_recipients NVARCHAR(MAX) NULL,
    blind_copy_recipients NVARCHAR(MAX) NULL,
    reply_to NVARCHAR(MAX) NULL,
    subject NVARCHAR(998) NOT NULL,
    body NVARCHAR(MAX) NOT NULL,
    body_format NVARCHAR(20) NOT NULL CONSTRAINT DF_MailQueue_body_format DEFAULT ('HTML'),
    file_attachments NVARCHAR(MAX) NULL,
    status NVARCHAR(20) NOT NULL CONSTRAINT DF_MailQueue_status DEFAULT ('PENDING'),
    retries INT NOT NULL CONSTRAINT DF_MailQueue_retries DEFAULT (0),
    max_retries INT NOT NULL CONSTRAINT DF_MailQueue_max_retries DEFAULT (5),
    next_retry_at DATETIME2 NULL,
    claimed_by NVARCHAR(200) NULL,
    claimed_at DATETIME2 NULL,
    lock_token UNIQUEIDENTIFIER NULL,
    lock_expires_at DATETIME2 NULL,
    sent_at DATETIME2 NULL,
    last_attempt_at DATETIME2 NULL,
    last_error NVARCHAR(MAX) NULL,
    error_category NVARCHAR(40) NULL,
    processed_account NVARCHAR(100) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_MailQueue_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_MailQueue_updated_at DEFAULT (SYSUTCDATETIME())
  );
END
GO

IF OBJECT_ID(N'dbo.MailQueueAttachments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MailQueueAttachments (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    mail_queue_id BIGINT NOT NULL,
    file_name NVARCHAR(260) NOT NULL,
    content_type NVARCHAR(200) NULL,
    file_content VARBINARY(MAX) NULL,
    file_path NVARCHAR(1024) NULL,
    file_size_bytes BIGINT NULL,
    checksum_sha256 NVARCHAR(64) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_MailQueueAttachments_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_MailQueueAttachments_MailQueue FOREIGN KEY(mail_queue_id) REFERENCES dbo.MailQueue(id) ON DELETE CASCADE,
    CONSTRAINT CK_MailQueueAttachments_Content CHECK (file_content IS NOT NULL OR file_path IS NOT NULL)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MailQueue_StatusNextRetry' AND object_id = OBJECT_ID('dbo.MailQueue'))
  CREATE INDEX IX_MailQueue_StatusNextRetry ON dbo.MailQueue(status, next_retry_at, id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MailQueue_Lock' AND object_id = OBJECT_ID('dbo.MailQueue'))
  CREATE INDEX IX_MailQueue_Lock ON dbo.MailQueue(status, lock_expires_at);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MailQueueAttachments_MailId' AND object_id = OBJECT_ID('dbo.MailQueueAttachments'))
  CREATE INDEX IX_MailQueueAttachments_MailId ON dbo.MailQueueAttachments(mail_queue_id, id);
GO
