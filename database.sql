CREATE DATABASE IF NOT EXISTS delosmc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE delosmc;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(32) NOT NULL UNIQUE,
    email VARCHAR(255) NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_verified TINYINT(1) NOT NULL DEFAULT 1,
    verification_token_hash CHAR(64) NULL,
    verification_expires_at DATETIME NULL,
    email_verified_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
