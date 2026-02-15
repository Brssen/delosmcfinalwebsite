const express = require("express");
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_NAME = process.env.DB_NAME || "delosmc";
const DB_IDENTIFIER_PATTERN = /^[a-zA-Z0-9_]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_TOKEN_MINUTES = Number(process.env.EMAIL_VERIFY_TTL_MINUTES || 60);
const IS_VERCEL = process.env.VERCEL === "1";
const SHOULD_BOOTSTRAP_DB = !IS_VERCEL && String(process.env.DB_BOOTSTRAP || "true").toLowerCase() === "true";

if (!DB_IDENTIFIER_PATTERN.test(DB_NAME)) {
    throw new Error("DB_NAME yalnizca harf, sayi ve alt cizgi icerebilir.");
}

const dbConfig = {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    charset: "utf8mb4"
};

const smtpConfig = {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || ""
};

const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const PUBLIC_ROOT = path.join(process.cwd(), "public");
const STATIC_ROOT = fs.existsSync(PUBLIC_ROOT) ? PUBLIC_ROOT : process.cwd();
const smtpEnabled = Boolean(smtpConfig.host && smtpConfig.user && smtpConfig.pass && smtpConfig.from);
const mailTransporter = smtpEnabled
    ? nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: {
            user: smtpConfig.user,
            pass: smtpConfig.pass
        }
    })
    : null;

let pool;
let appInitPromise = null;
let smtpChecked = false;

function getPool() {
    if (!pool) {
        throw new Error("DB pool henuz hazir degil.");
    }

    return pool;
}

function createDatabasePool() {
    if (pool) {
        return;
    }

    pool = mysql.createPool({
        ...dbConfig,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
}

async function ensureDatabaseExists() {
    const bootstrapConnection = await mysql.createConnection(dbConfig);
    await bootstrapConnection.query(
        `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrapConnection.end();
}

function getRequestBaseUrl(req) {
    if (APP_BASE_URL) {
        return APP_BASE_URL;
    }

    if (req) {
        const forwardedProto = req.headers["x-forwarded-proto"];
        const forwardedHost = req.headers["x-forwarded-host"];
        const protocol = typeof forwardedProto === "string"
            ? forwardedProto.split(",")[0]
            : (req.protocol || "https");
        const host = typeof forwardedHost === "string"
            ? forwardedHost.split(",")[0]
            : req.get("host");

        if (host) {
            return `${protocol}://${host}`;
        }
    }

    return `http://localhost:${PORT}`;
}

function validateCredentials(username, password) {
    if (typeof username !== "string" || typeof password !== "string") {
        return "Gecersiz istek govdesi.";
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 32) {
        return "Kullanici adi 3-32 karakter olmali.";
    }

    if (password.length < 6 || password.length > 72) {
        return "Sifre 6-72 karakter olmali.";
    }

    return null;
}

function validateEmail(email) {
    if (typeof email !== "string") {
        return "E-posta zorunlu.";
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
        return "E-posta zorunlu.";
    }

    if (cleanEmail.length > 255 || !EMAIL_PATTERN.test(cleanEmail)) {
        return "Gecerli bir e-posta gir.";
    }

    return null;
}

function maskEmail(email) {
    if (typeof email !== "string" || !email.includes("@")) {
        return "";
    }

    const [localPart, domain] = email.split("@");
    if (!localPart || !domain) {
        return "";
    }

    if (localPart.length <= 2) {
        return `${localPart[0] || "*"}*@${domain}`;
    }

    return `${localPart.slice(0, 2)}${"*".repeat(Math.max(1, localPart.length - 2))}@${domain}`;
}

function createVerificationToken() {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_MINUTES * 60 * 1000);

    return {
        rawToken,
        tokenHash,
        expiresAt
    };
}

async function sendVerificationEmail({ to, username, token, requestBaseUrl }) {
    const verificationLink = `${requestBaseUrl}/api/auth/verify?token=${token}`;

    if (!smtpEnabled || !mailTransporter) {
        console.log(`[EMAIL VERIFY LINK] ${to} -> ${verificationLink}`);
        return {
            delivered: false,
            verificationLink
        };
    }

    await mailTransporter.sendMail({
        from: smtpConfig.from,
        to,
        subject: "DelosMC E-posta Dogrulama",
        text: `Merhaba ${username}, hesabini dogrulamak icin bu linki ac: ${verificationLink}`,
        html: `
            <p>Merhaba <strong>${username}</strong>,</p>
            <p>Hesabini dogrulamak icin asagidaki linke tikla:</p>
            <p><a href="${verificationLink}">${verificationLink}</a></p>
            <p>Link ${VERIFICATION_TOKEN_MINUTES} dakika icinde gecerliligini kaybeder.</p>
        `
    });

    return {
        delivered: true,
        verificationLink
    };
}

async function ensureUsersSchema() {
    await getPool().query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(32) NOT NULL UNIQUE,
            email VARCHAR(255) NULL,
            password_hash VARCHAR(255) NOT NULL,
            is_verified TINYINT(1) NOT NULL DEFAULT 1,
            verification_token_hash CHAR(64) NULL,
            verification_expires_at DATETIME NULL,
            email_verified_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [columns] = await getPool().query("SHOW COLUMNS FROM users");
    const columnNames = new Set(columns.map((column) => column.Field));

    if (!columnNames.has("email")) {
        await getPool().query("ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL AFTER username");
    }

    if (!columnNames.has("is_verified")) {
        await getPool().query("ALTER TABLE users ADD COLUMN is_verified TINYINT(1) NOT NULL DEFAULT 1 AFTER password_hash");
    }

    if (!columnNames.has("verification_token_hash")) {
        await getPool().query("ALTER TABLE users ADD COLUMN verification_token_hash CHAR(64) NULL AFTER is_verified");
    }

    if (!columnNames.has("verification_expires_at")) {
        await getPool().query("ALTER TABLE users ADD COLUMN verification_expires_at DATETIME NULL AFTER verification_token_hash");
    }

    if (!columnNames.has("email_verified_at")) {
        await getPool().query("ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL AFTER verification_expires_at");
    }

    const [emailIndex] = await getPool().query("SHOW INDEX FROM users WHERE Key_name = 'idx_users_email'");
    if (emailIndex.length === 0) {
        await getPool().query("CREATE UNIQUE INDEX idx_users_email ON users (email)");
    }
}

async function sendNewVerificationLink(userId, username, email, requestBaseUrl) {
    const token = createVerificationToken();

    await getPool().query(
        "UPDATE users SET verification_token_hash = ?, verification_expires_at = ?, is_verified = 0, email_verified_at = NULL WHERE id = ?",
        [token.tokenHash, token.expiresAt, userId]
    );

    return sendVerificationEmail({
        to: email,
        username,
        token: token.rawToken,
        requestBaseUrl
    });
}

app.use(express.json());

async function ensureAppInitialized() {
    if (!appInitPromise) {
        appInitPromise = (async () => {
            if (SHOULD_BOOTSTRAP_DB) {
                await ensureDatabaseExists();
            }

            createDatabasePool();
            await ensureUsersSchema();

            if (!smtpChecked) {
                smtpChecked = true;
                if (smtpEnabled && mailTransporter) {
                    try {
                        await mailTransporter.verify();
                        console.log("SMTP baglantisi hazir.");
                    } catch (smtpError) {
                        console.warn("SMTP baglantisi dogrulanamadi. Mail gonderimi calismayabilir.");
                        console.warn(smtpError.message);
                    }
                } else {
                    console.log("SMTP ayarlari tanimli degil. Dogrulama linkleri konsola yazilacak.");
                }
            }
        })().catch((error) => {
            appInitPromise = null;
            throw error;
        });
    }

    return appInitPromise;
}

app.use(["/api", "/auth", "/health"], async (_req, res, next) => {
    try {
        await ensureAppInitialized();
        next();
    } catch (error) {
        console.error("App init error:", error);
        res.status(500).json({ message: "Sunucu baslatma hatasi." });
    }
});

app.post(["/api/auth/register", "/auth/register"], async (req, res) => {
    const { username, password, email } = req.body || {};
    const credentialsError = validateCredentials(username, password);
    if (credentialsError) {
        return res.status(400).json({ message: credentialsError });
    }

    const emailError = validateEmail(email);
    if (emailError) {
        return res.status(400).json({ message: emailError });
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();
    const requestBaseUrl = getRequestBaseUrl(req);

    try {
        const [existing] = await getPool().query(
            "SELECT id, username, email FROM users WHERE username = ? OR email = ? LIMIT 1",
            [cleanUsername, cleanEmail]
        );

        if (existing.length > 0) {
            const [conflict] = existing;
            if (conflict.username === cleanUsername) {
                return res.status(409).json({ message: "Bu kullanici adi zaten var." });
            }

            if (conflict.email === cleanEmail) {
                return res.status(409).json({ message: "Bu e-posta zaten kullaniliyor." });
            }
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const token = createVerificationToken();

        await getPool().query(
            `
                INSERT INTO users (username, email, password_hash, is_verified, verification_token_hash, verification_expires_at)
                VALUES (?, ?, ?, 0, ?, ?)
            `,
            [cleanUsername, cleanEmail, passwordHash, token.tokenHash, token.expiresAt]
        );

        let emailResult;
        try {
            emailResult = await sendVerificationEmail({
                to: cleanEmail,
                username: cleanUsername,
                token: token.rawToken,
                requestBaseUrl
            });
        } catch (emailErrorInternal) {
            console.error("Verification email send error:", emailErrorInternal);
            emailResult = {
                delivered: false,
                verificationLink: `${requestBaseUrl}/api/auth/verify?token=${token.rawToken}`
            };
        }

        const response = {
            message: emailResult.delivered
                ? "Kayit basarili. E-posta dogrulama linki gonderildi."
                : "Kayit basarili. SMTP ayari yoksa link server konsoluna yazilir.",
            requiresEmailVerification: true
        };

        if (!emailResult.delivered) {
            response.devVerificationLink = emailResult.verificationLink;
        }

        return res.status(201).json(response);
    } catch (error) {
        console.error("Register error:", error);
        return res.status(500).json({ message: "Sunucu hatasi." });
    }
});

app.post(["/api/auth/login", "/auth/login"], async (req, res) => {
    const { username, password } = req.body || {};
    const validationError = validateCredentials(username, password);

    if (validationError) {
        return res.status(400).json({ message: validationError });
    }

    const cleanUsername = username.trim();

    try {
        const [rows] = await getPool().query(
            "SELECT id, username, email, password_hash, is_verified FROM users WHERE username = ? LIMIT 1",
            [cleanUsername]
        );

        const user = rows[0];
        if (!user) {
            return res.status(401).json({ message: "Bilgiler yanlis." });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ message: "Bilgiler yanlis." });
        }

        if (!user.is_verified) {
            return res.status(403).json({
                message: "Hesabini dogrulamak icin e-posta kutunu kontrol et.",
                requiresEmailVerification: true,
                emailHint: maskEmail(user.email)
            });
        }

        return res.json({ message: "Giris basarili.", username: user.username });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ message: "Sunucu hatasi." });
    }
});

app.post(["/api/auth/resend-verification", "/auth/resend-verification"], async (req, res) => {
    const { username } = req.body || {};
    if (typeof username !== "string" || username.trim().length < 3 || username.trim().length > 32) {
        return res.status(400).json({ message: "Gecerli bir kullanici adi gir." });
    }

    const cleanUsername = username.trim();

    try {
        const [rows] = await getPool().query(
            "SELECT id, username, email, is_verified FROM users WHERE username = ? LIMIT 1",
            [cleanUsername]
        );

        const user = rows[0];
        if (!user || !user.email) {
            return res.status(404).json({ message: "Kullanici bulunamadi." });
        }

        if (user.is_verified) {
            return res.status(400).json({ message: "Bu hesap zaten dogrulanmis." });
        }

        const emailResult = await sendNewVerificationLink(user.id, user.username, user.email, getRequestBaseUrl(req));
        const response = {
            message: emailResult.delivered
                ? "Yeni dogrulama linki gonderildi."
                : "SMTP ayari yoksa yeni link server konsoluna yazildi."
        };

        if (!emailResult.delivered) {
            response.devVerificationLink = emailResult.verificationLink;
        }

        return res.json(response);
    } catch (error) {
        console.error("Resend verification error:", error);
        return res.status(500).json({ message: "Sunucu hatasi." });
    }
});

app.get(["/api/auth/verify", "/auth/verify"], async (req, res) => {
    const rawToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!rawToken || rawToken.length < 20) {
        return res.redirect("/auth.html?mode=login&verified=invalid");
    }

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    try {
        const [rows] = await getPool().query(
            `
                SELECT id
                FROM users
                WHERE verification_token_hash = ?
                  AND is_verified = 0
                  AND verification_expires_at IS NOT NULL
                  AND verification_expires_at > NOW()
                LIMIT 1
            `,
            [tokenHash]
        );

        const user = rows[0];
        if (!user) {
            return res.redirect("/auth.html?mode=login&verified=expired");
        }

        await getPool().query(
            `
                UPDATE users
                SET is_verified = 1,
                    verification_token_hash = NULL,
                    verification_expires_at = NULL,
                    email_verified_at = NOW()
                WHERE id = ?
            `,
            [user.id]
        );

        return res.redirect("/auth.html?mode=login&verified=success");
    } catch (error) {
        console.error("Verify email error:", error);
        return res.redirect("/auth.html?mode=login&verified=error");
    }
});

app.get(["/api/health", "/health"], async (_req, res) => {
    try {
        await getPool().query("SELECT 1");
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: "DB baglantisi basarisiz." });
    }
});

app.use(express.static(STATIC_ROOT));

app.get("/", (_req, res) => {
    res.sendFile(path.join(STATIC_ROOT, "mainpage.html"));
});

async function startServer() {
    try {
        await ensureAppInitialized();

        app.listen(PORT, () => {
            console.log(`Server is running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("Server startup error:", error);
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
} else {
    module.exports = app;
}
