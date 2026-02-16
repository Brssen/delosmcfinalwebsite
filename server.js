const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_TOKEN_MINUTES = Number(process.env.EMAIL_VERIFY_TTL_MINUTES || 60);

function normalizeEnvValue(rawValue) {
    if (typeof rawValue !== "string") {
        return "";
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
        return "";
    }

    const hasSingleQuotes = trimmed.startsWith("'") && trimmed.endsWith("'");
    const hasDoubleQuotes = trimmed.startsWith("\"") && trimmed.endsWith("\"");
    if ((hasSingleQuotes || hasDoubleQuotes) && trimmed.length >= 2) {
        return trimmed.slice(1, -1).trim();
    }

    return trimmed;
}

function getEnvString(keys, fallback = "") {
    for (const key of keys) {
        const value = normalizeEnvValue(process.env[key]);
        if (value) {
            return value;
        }
    }

    return fallback;
}

function getEnvNumber(keys, fallback) {
    const value = getEnvString(keys, "");
    if (!value) {
        return fallback;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getEnvBoolean(keys, fallback) {
    const value = getEnvString(keys, "").toLowerCase();
    if (!value) {
        return fallback;
    }

    if (["1", "true", "yes", "on"].includes(value)) {
        return true;
    }

    if (["0", "false", "no", "off"].includes(value)) {
        return false;
    }

    return fallback;
}

const DATABASE_URL = getEnvString(["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "DB_URL"]);
const DB_SSL = getEnvBoolean(["DB_SSL"], true);
const DB_ENABLE_CHANNEL_BINDING = getEnvBoolean(["DB_ENABLE_CHANNEL_BINDING"], true);
const EMAIL_VERIFICATION_ENABLED = getEnvBoolean(["EMAIL_VERIFICATION_ENABLED"], false);
const DB_HOST = getEnvString(["DB_HOST", "PGHOST"]);
const DB_PORT = getEnvNumber(["DB_PORT", "PGPORT"], 5432);
const DB_USER = getEnvString(["DB_USER", "PGUSER"], "postgres");
const DB_PASSWORD = getEnvString(["DB_PASSWORD", "DB_PASS", "PGPASSWORD"]);
const DB_NAME = getEnvString(["DB_NAME", "PGDATABASE"], "delosmc");
const IS_SERVERLESS_RUNTIME = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DB_FALLBACK_CONFIG = {
    host: DB_HOST || "localhost",
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME
};

const SMTP_PORT = getEnvNumber(["SMTP_PORT", "MAIL_PORT"], 587);
const hasExplicitSmtpSecureValue = Boolean(getEnvString(["SMTP_SECURE", "MAIL_SECURE"]));
const smtpSecureDefault = SMTP_PORT === 465;
const SMTP_SECURE = hasExplicitSmtpSecureValue
    ? getEnvBoolean(["SMTP_SECURE", "MAIL_SECURE"], smtpSecureDefault)
    : smtpSecureDefault;
const SMTP_USER = getEnvString(["SMTP_USER", "SMTP_USERNAME", "MAIL_USER"]);
const SMTP_PASS = getEnvString(["SMTP_PASS", "SMTP_PASSWORD", "MAIL_PASS"]);
const SMTP_FROM = getEnvString(["SMTP_FROM", "MAIL_FROM"], SMTP_USER);

const smtpConfig = {
    host: getEnvString(["SMTP_HOST", "MAIL_HOST"]),
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: SMTP_FROM
};

const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const PUBLIC_ROOT = path.join(process.cwd(), "public");
const STATIC_ROOT = fs.existsSync(PUBLIC_ROOT) ? PUBLIC_ROOT : process.cwd();
const smtpEnabled = Boolean(smtpConfig.host && smtpConfig.user && smtpConfig.pass);
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

function getDbTarget() {
    if (DATABASE_URL) {
        try {
            const parsedUrl = new URL(DATABASE_URL);
            return `${parsedUrl.hostname}:${parsedUrl.port || 5432}${parsedUrl.pathname || ""}`;
        } catch (error) {
            return "DATABASE_URL";
        }
    }

    return `${DB_FALLBACK_CONFIG.host}:${DB_FALLBACK_CONFIG.port}/${DB_FALLBACK_CONFIG.database}`;
}

function getStartupErrorMessage(error) {
    const code = error && typeof error === "object" ? error.code : "";

    if (code === "MISSING_DB_CONFIG") {
        return "Veritabani ayari bulunamadi. Vercel Environment Variables bolumune DATABASE_URL (veya POSTGRES_URL) ekle.";
    }

    if (code === "INVALID_DB_URL") {
        return "DATABASE_URL formati gecersiz. URL'nin postgresql:// ile basladigini kontrol et.";
    }

    if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
        return `Veritabani baglantisi kurulamadi (${getDbTarget()}). DATABASE_URL/POSTGRES_URL veya DB_HOST/DB_PORT ayarlarini kontrol et.`;
    }

    if (code === "28P01") {
        return "Veritabani kullanici bilgileri hatali. DATABASE_URL icindeki kullanici/sifre bilgisini kontrol et.";
    }

    if (code === "3D000") {
        return "Veritabani bulunamadi. DATABASE_URL icindeki veritabani adini kontrol et.";
    }

    if (code === "SELF_SIGNED_CERT_IN_CHAIN") {
        return "SSL hatasi alindi. Neon icin DB_SSL=true olarak ayarla.";
    }

    return "Sunucu baslatma hatasi.";
}

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

    if (!DATABASE_URL && !DB_HOST && IS_SERVERLESS_RUNTIME) {
        const missingConfigError = new Error("Missing database config in serverless runtime.");
        missingConfigError.code = "MISSING_DB_CONFIG";
        throw missingConfigError;
    }

    if (DATABASE_URL) {
        try {
            new URL(DATABASE_URL);
        } catch (error) {
            const invalidUrlError = new Error("Invalid DATABASE_URL.");
            invalidUrlError.code = "INVALID_DB_URL";
            throw invalidUrlError;
        }
    }

    const baseConfig = DATABASE_URL
        ? { connectionString: DATABASE_URL }
        : DB_FALLBACK_CONFIG;

    const shouldUseSsl = DB_SSL || /sslmode=require/i.test(DATABASE_URL);
    pool = new Pool({
        ...baseConfig,
        max: Number(process.env.DB_POOL_MAX || 10),
        idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
        connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
        ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
        enableChannelBinding: DB_ENABLE_CHANNEL_BINDING
    });

    pool.on("error", (error) => {
        console.error("PostgreSQL pool error:", error);
    });
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
    const verificationLink = `${requestBaseUrl}/api/verify?token=${token}`;

    if (!smtpEnabled || !mailTransporter) {
        console.log(`[EMAIL VERIFY LINK] ${to} -> ${verificationLink}`);
        return {
            delivered: false,
            verificationLink,
            reason: "smtp_disabled"
        };
    }

    await mailTransporter.sendMail({
        from: smtpConfig.from || smtpConfig.user,
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
        verificationLink,
        reason: "smtp_sent"
    };
}

async function ensureUsersSchema() {
    await getPool().query(`
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(32) NOT NULL UNIQUE,
            email VARCHAR(255),
            password_hash VARCHAR(255) NOT NULL,
            is_verified BOOLEAN NOT NULL DEFAULT TRUE,
            verification_token_hash CHAR(64),
            verification_expires_at TIMESTAMPTZ,
            email_verified_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await getPool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)");
    await getPool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT TRUE");
    await getPool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_hash CHAR(64)");
    await getPool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ");
    await getPool().query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ");
    await getPool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email)");
}

async function sendNewVerificationLink(userId, username, email, requestBaseUrl) {
    const token = createVerificationToken();

    await getPool().query(
        "UPDATE users SET verification_token_hash = $1, verification_expires_at = $2, is_verified = FALSE, email_verified_at = NULL WHERE id = $3",
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
            createDatabasePool();
            await ensureUsersSchema();

            if (!smtpChecked) {
                smtpChecked = true;
                if (!EMAIL_VERIFICATION_ENABLED) {
                    console.log("E-posta dogrulama gecici olarak devre disi.");
                } else if (smtpEnabled && mailTransporter) {
                    try {
                        await mailTransporter.verify();
                        console.log("SMTP baglantisi hazir.");
                    } catch (smtpError) {
                        console.warn("SMTP baglantisi dogrulanamadi. Mail gonderimi calismayabilir.");
                        console.warn(`SMTP verify error: ${smtpError.code || "UNKNOWN"} ${smtpError.message}`);
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
        res.status(500).json({ message: getStartupErrorMessage(error) });
    }
});

app.post(["/api/auth/register", "/auth/register", "/api/register"], async (req, res) => {
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
        const existingResult = await getPool().query(
            "SELECT id, username, email FROM users WHERE username = $1 OR email = $2 LIMIT 1",
            [cleanUsername, cleanEmail]
        );

        if (existingResult.rows.length > 0) {
            const [conflict] = existingResult.rows;
            if (conflict.username === cleanUsername) {
                return res.status(409).json({ message: "Bu kullanici adi zaten var." });
            }

            if (conflict.email === cleanEmail) {
                return res.status(409).json({ message: "Bu e-posta zaten kullaniliyor." });
            }
        }

        const passwordHash = await bcrypt.hash(password, 10);

        if (!EMAIL_VERIFICATION_ENABLED) {
            await getPool().query(
                `
                    INSERT INTO users (username, email, password_hash, is_verified, verification_token_hash, verification_expires_at, email_verified_at)
                    VALUES ($1, $2, $3, TRUE, NULL, NULL, NOW())
                `,
                [cleanUsername, cleanEmail, passwordHash]
            );

            return res.status(201).json({
                message: "Kayit basarili.",
                requiresEmailVerification: false,
                emailDelivery: "verification_disabled"
            });
        }

        const token = createVerificationToken();

        await getPool().query(
            `
                INSERT INTO users (username, email, password_hash, is_verified, verification_token_hash, verification_expires_at)
                VALUES ($1, $2, $3, FALSE, $4, $5)
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
                verificationLink: `${requestBaseUrl}/api/verify?token=${token.rawToken}`,
                reason: "smtp_error"
            };
        }

        const responseMessage = emailResult.delivered
            ? "Kayit basarili. E-posta dogrulama linki gonderildi."
            : (emailResult.reason === "smtp_error"
                ? "Kayit basarili fakat dogrulama e-postasi gonderilemedi. SMTP ayarlarini kontrol et."
                : "Kayit basarili. SMTP ayarlari tanimli degil, dogrulama linki gecici olarak API cevabina eklendi.");

        const response = {
            message: responseMessage,
            requiresEmailVerification: true,
            emailDelivery: emailResult.reason || "unknown"
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

app.post(["/api/auth/login", "/auth/login", "/api/login"], async (req, res) => {
    const { username, password } = req.body || {};
    const validationError = validateCredentials(username, password);

    if (validationError) {
        return res.status(400).json({ message: validationError });
    }

    const cleanUsername = username.trim();

    try {
        const userResult = await getPool().query(
            "SELECT id, username, email, password_hash, is_verified FROM users WHERE username = $1 LIMIT 1",
            [cleanUsername]
        );

        const user = userResult.rows[0];
        if (!user) {
            return res.status(401).json({ message: "Bilgiler yanlis." });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ message: "Bilgiler yanlis." });
        }

        if (EMAIL_VERIFICATION_ENABLED && !user.is_verified) {
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

app.post(["/api/auth/resend-verification", "/auth/resend-verification", "/api/resend-verification"], async (req, res) => {
    if (!EMAIL_VERIFICATION_ENABLED) {
        return res.status(400).json({ message: "E-posta dogrulama su an devre disi." });
    }

    const { username } = req.body || {};
    if (typeof username !== "string" || username.trim().length < 3 || username.trim().length > 32) {
        return res.status(400).json({ message: "Gecerli bir kullanici adi gir." });
    }

    const cleanUsername = username.trim();

    try {
        const userResult = await getPool().query(
            "SELECT id, username, email, is_verified FROM users WHERE username = $1 LIMIT 1",
            [cleanUsername]
        );

        const user = userResult.rows[0];
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

app.get(["/api/auth/verify", "/auth/verify", "/api/verify"], async (req, res) => {
    if (!EMAIL_VERIFICATION_ENABLED) {
        return res.redirect("/auth.html?mode=login&verified=success");
    }

    const rawToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!rawToken || rawToken.length < 20) {
        return res.redirect("/auth.html?mode=login&verified=invalid");
    }

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    try {
        const verifyResult = await getPool().query(
            `
                SELECT id
                FROM users
                WHERE verification_token_hash = $1
                  AND is_verified = FALSE
                  AND verification_expires_at IS NOT NULL
                  AND verification_expires_at > NOW()
                LIMIT 1
            `,
            [tokenHash]
        );

        const user = verifyResult.rows[0];
        if (!user) {
            return res.redirect("/auth.html?mode=login&verified=expired");
        }

        await getPool().query(
            `
                UPDATE users
                SET is_verified = TRUE,
                    verification_token_hash = NULL,
                    verification_expires_at = NULL,
                    email_verified_at = NOW()
                WHERE id = $1
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
        res.json({
            ok: true,
            smtpConfigured: smtpEnabled,
            emailVerificationEnabled: EMAIL_VERIFICATION_ENABLED
        });
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
