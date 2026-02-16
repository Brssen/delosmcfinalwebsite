const CART_KEY = "delosmc_cart";
const AUTH_USER_KEY = "delosmc_user";
const AUTH_EMAIL_HINT_KEY = "delosmc_email_hint";
const SHOP_CATEGORY_DELAY_MS = 700;
const PAGE_TRANSITION_DURATION_MS = 420;
const AUTH_MODE_SWITCH_DELAY_MS = 140;
const LOGIN_REDIRECT_DELAY_MS = 700;
const TOAST_EXIT_MS = 240;
let isLogin = true;
let shopCategoryTimer = null;
let authModeInitialized = false;
let authModeTimer = null;
let toastHost = null;
let confirmUi = null;
let activeConfirmResolver = null;

function getToastHost() {
    if (toastHost) {
        return toastHost;
    }

    if (!document.body) {
        return null;
    }

    toastHost = document.createElement("div");
    toastHost.className = "ui-toast-host";
    toastHost.setAttribute("aria-live", "polite");
    toastHost.setAttribute("aria-atomic", "false");
    document.body.appendChild(toastHost);
    return toastHost;
}

function showToast(message, type = "info", options = {}) {
    if (!message) {
        return;
    }

    const host = getToastHost();
    if (!host) {
        return;
    }

    const duration = Number.isFinite(options.duration) ? Math.max(1200, options.duration) : 3800;
    const safeType = ["success", "error", "info"].includes(type) ? type : "info";
    const toast = document.createElement("div");
    toast.className = `ui-toast ui-toast-${safeType}`;
    toast.textContent = String(message);

    host.appendChild(toast);
    window.requestAnimationFrame(() => {
        toast.classList.add("visible");
    });

    window.setTimeout(() => {
        toast.classList.remove("visible");
        toast.classList.add("is-hiding");
        window.setTimeout(() => {
            toast.remove();
        }, TOAST_EXIT_MS);
    }, duration);
}

function ensureConfirmUi() {
    if (confirmUi) {
        return confirmUi;
    }

    if (!document.body) {
        return null;
    }

    const overlay = document.createElement("div");
    overlay.className = "ui-confirm-overlay";
    overlay.innerHTML = `
        <div class="ui-confirm-card" role="dialog" aria-modal="true" aria-labelledby="uiConfirmTitle">
            <p class="ui-confirm-kicker">DELOSMC</p>
            <h3 id="uiConfirmTitle">Onay Gerekli</h3>
            <p id="uiConfirmMessage"></p>
            <div class="ui-confirm-actions">
                <button type="button" class="ui-confirm-btn ui-confirm-cancel" data-action="cancel">Vazgeç</button>
                <button type="button" class="ui-confirm-btn ui-confirm-approve" data-action="approve">Tekrar Gönder</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const title = overlay.querySelector("#uiConfirmTitle");
    const message = overlay.querySelector("#uiConfirmMessage");
    const cancelBtn = overlay.querySelector("[data-action=\"cancel\"]");
    const approveBtn = overlay.querySelector("[data-action=\"approve\"]");

    const close = (result) => {
        overlay.classList.remove("visible");
        document.body.classList.remove("popup-open");
        const resolver = activeConfirmResolver;
        activeConfirmResolver = null;
        if (resolver) {
            resolver(result);
        }
    };

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            close(false);
        }
    });

    if (cancelBtn) {
        cancelBtn.addEventListener("click", () => close(false));
    }

    if (approveBtn) {
        approveBtn.addEventListener("click", () => close(true));
    }

    document.addEventListener("keydown", (event) => {
        if (!overlay.classList.contains("visible")) {
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            close(false);
        } else if (event.key === "Enter") {
            event.preventDefault();
            close(true);
        }
    });

    confirmUi = {
        overlay,
        title,
        message,
        cancelBtn,
        approveBtn
    };

    return confirmUi;
}

function showConfirm(message, options = {}) {
    const ui = ensureConfirmUi();
    if (!ui) {
        return Promise.resolve(false);
    }

    if (activeConfirmResolver) {
        activeConfirmResolver(false);
        activeConfirmResolver = null;
    }

    ui.title.textContent = options.title || "Onay Gerekli";
    ui.message.textContent = String(message || "Devam etmek istiyor musun?");
    ui.cancelBtn.textContent = options.cancelText || "Vazgeç";
    ui.approveBtn.textContent = options.approveText || "Onayla";

    ui.overlay.classList.add("visible");
    document.body.classList.add("popup-open");

    return new Promise((resolve) => {
        activeConfirmResolver = resolve;
    });
}

function normalizeStoredUser(rawValue) {
    if (typeof rawValue !== "string") {
        return "";
    }

    const cleanValue = rawValue.trim();
    if (!cleanValue) {
        return "";
    }

    return cleanValue.slice(0, 32);
}

function normalizeEmailHint(rawValue) {
    if (typeof rawValue !== "string") {
        return "";
    }

    const cleanValue = rawValue.trim();
    if (!cleanValue) {
        return "";
    }

    return cleanValue.slice(0, 128);
}

function getStoredValue(storage, key) {
    try {
        return storage.getItem(key);
    } catch (error) {
        return "";
    }
}

function setStoredValue(storage, key, value) {
    try {
        storage.setItem(key, value);
    } catch (error) {
        // Ignore storage write errors (private mode, quota, disabled storage).
    }
}

function removeStoredValue(storage, key) {
    try {
        storage.removeItem(key);
    } catch (error) {
        // Ignore storage cleanup errors.
    }
}

function getLoggedInUser() {
    const sessionUser = normalizeStoredUser(getStoredValue(window.sessionStorage, "logged_user"));
    if (sessionUser) {
        setStoredValue(window.localStorage, AUTH_USER_KEY, sessionUser);
        return sessionUser;
    }

    const localUser = normalizeStoredUser(getStoredValue(window.localStorage, AUTH_USER_KEY));
    if (localUser) {
        setStoredValue(window.sessionStorage, "logged_user", localUser);
        return localUser;
    }

    return "";
}

function getStoredEmailHint() {
    return normalizeEmailHint(getStoredValue(window.localStorage, AUTH_EMAIL_HINT_KEY));
}

function setStoredEmailHint(emailHint) {
    const cleanEmailHint = normalizeEmailHint(emailHint);
    if (!cleanEmailHint) {
        removeStoredValue(window.localStorage, AUTH_EMAIL_HINT_KEY);
        return;
    }

    setStoredValue(window.localStorage, AUTH_EMAIL_HINT_KEY, cleanEmailHint);
}

function setLoggedInUser(username, emailHint = "") {
    const cleanUsername = normalizeStoredUser(username);
    if (!cleanUsername) {
        return;
    }

    setStoredValue(window.sessionStorage, "logged_user", cleanUsername);
    setStoredValue(window.localStorage, AUTH_USER_KEY, cleanUsername);
    if (emailHint) {
        setStoredEmailHint(emailHint);
    }
}

function clearLoggedInUser() {
    removeStoredValue(window.sessionStorage, "logged_user");
    removeStoredValue(window.localStorage, AUTH_USER_KEY);
    removeStoredValue(window.localStorage, AUTH_EMAIL_HINT_KEY);
}

function createMinecraftHeadUrl(username) {
    const cleanUsername = normalizeStoredUser(username);
    if (!cleanUsername) {
        return "";
    }

    return `https://mc-heads.net/avatar/${encodeURIComponent(cleanUsername)}/32`;
}

async function fetchProfileSummary(username) {
    const cleanUsername = normalizeStoredUser(username);
    if (!cleanUsername) {
        return "";
    }

    try {
        const response = await fetch("/api/profile", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ username: cleanUsername })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            return "";
        }

        const emailHint = normalizeEmailHint(payload.emailHint);
        if (emailHint) {
            setStoredEmailHint(emailHint);
        }

        return emailHint;
    } catch (error) {
        return "";
    }
}

async function changePasswordFlow(username) {
    const cleanUsername = normalizeStoredUser(username);
    if (!cleanUsername) {
        showToast("Kullanici bilgisi bulunamadi.", "error");
        return;
    }

    const currentPassword = window.prompt("Mevcut sifreni gir:");
    if (currentPassword === null) {
        return;
    }

    if (!currentPassword) {
        showToast("Mevcut sifre bos olamaz.", "error");
        return;
    }

    const newPassword = window.prompt("Yeni sifreni gir (6-72 karakter):");
    if (newPassword === null) {
        return;
    }

    if (newPassword.length < 6 || newPassword.length > 72) {
        showToast("Yeni sifre 6-72 karakter olmali.", "error");
        return;
    }

    if (newPassword === currentPassword) {
        showToast("Yeni sifre mevcut sifreden farkli olmali.", "error");
        return;
    }

    const repeatPassword = window.prompt("Yeni sifreni tekrar gir:");
    if (repeatPassword === null) {
        return;
    }

    if (repeatPassword !== newPassword) {
        showToast("Yeni sifre tekrarinda eslesme hatasi.", "error");
        return;
    }

    try {
        const response = await fetch("/api/change-password", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username: cleanUsername,
                currentPassword,
                newPassword
            })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            showToast(payload.message || "Sifre degistirilemedi.", "error");
            return;
        }

        showToast(payload.message || "Sifre degistirildi.", "success");
    } catch (error) {
        showToast("Sunucuya baglanilamadi.", "error");
    }
}

function renderHeaderAuthButtons(container, username, emailHint) {
    if (!(container instanceof HTMLElement)) {
        return null;
    }

    if (!container.dataset.defaultAuthMarkup) {
        container.dataset.defaultAuthMarkup = container.innerHTML;
    }

    if (!username) {
        container.innerHTML = container.dataset.defaultAuthMarkup || "";
        return null;
    }

    container.innerHTML = "";

    const menuRoot = document.createElement("div");
    menuRoot.className = "profile-menu";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "profile-trigger";
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-haspopup", "true");

    const avatar = document.createElement("img");
    avatar.className = "profile-head";
    avatar.src = createMinecraftHeadUrl(username);
    avatar.alt = `${username} skin`;
    avatar.loading = "lazy";
    avatar.decoding = "async";
    avatar.referrerPolicy = "no-referrer";
    avatar.addEventListener("error", () => {
        avatar.style.opacity = "0.45";
    });

    const triggerMeta = document.createElement("span");
    triggerMeta.className = "profile-trigger-meta";

    const triggerLabel = document.createElement("span");
    triggerLabel.className = "profile-trigger-label";
    triggerLabel.textContent = "Nick";

    const triggerNick = document.createElement("span");
    triggerNick.className = "profile-trigger-nick";
    triggerNick.textContent = username;
    triggerNick.title = username;

    triggerMeta.append(triggerLabel, triggerNick);
    trigger.append(avatar, triggerMeta);

    const panel = document.createElement("div");
    panel.className = "profile-panel";
    panel.setAttribute("role", "menu");

    const nickRow = document.createElement("div");
    nickRow.className = "profile-row";
    const nickLabel = document.createElement("span");
    nickLabel.className = "profile-label";
    nickLabel.textContent = "Nick";
    const nickValue = document.createElement("span");
    nickValue.className = "profile-value";
    nickValue.textContent = username;
    nickRow.append(nickLabel, nickValue);

    const emailRow = document.createElement("div");
    emailRow.className = "profile-row";
    const emailLabel = document.createElement("span");
    emailLabel.className = "profile-label";
    emailLabel.textContent = "E-posta";

    const emailValue = document.createElement("span");
    emailValue.className = "profile-value profile-email-value";
    emailValue.textContent = emailHint || "Yukleniyor...";
    emailRow.append(emailLabel, emailValue);

    const divider = document.createElement("div");
    divider.className = "profile-divider";

    const changePasswordBtn = document.createElement("button");
    changePasswordBtn.type = "button";
    changePasswordBtn.className = "profile-action-btn";
    changePasswordBtn.textContent = "Sifre Degistir";
    changePasswordBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await changePasswordFlow(username);
        menuRoot.classList.remove("open");
        trigger.setAttribute("aria-expanded", "false");
    });

    const logoutBtn = document.createElement("button");
    logoutBtn.type = "button";
    logoutBtn.className = "profile-action-btn profile-logout-btn";
    logoutBtn.textContent = "Cikis Yap";
    logoutBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearLoggedInUser();
        showToast("Cikis yapildi.", "success", { duration: 1400 });
        window.setTimeout(() => {
            window.location.href = "/auth.html?mode=login";
        }, 220);
    });

    panel.append(nickRow, emailRow, divider, changePasswordBtn, logoutBtn);
    menuRoot.append(trigger, panel);
    container.append(menuRoot);

    const closeMenu = () => {
        menuRoot.classList.remove("open");
        trigger.setAttribute("aria-expanded", "false");
    };

    trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !menuRoot.classList.contains("open");
        if (shouldOpen) {
            menuRoot.classList.add("open");
            trigger.setAttribute("aria-expanded", "true");
        } else {
            closeMenu();
        }
    });

    document.addEventListener("click", (event) => {
        if (menuRoot.contains(event.target)) {
            return;
        }

        closeMenu();
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeMenu();
        }
    });

    return emailValue;
}

async function initHeaderAuthState() {
    const authButtonAreas = document.querySelectorAll(".auth-buttons");
    if (authButtonAreas.length === 0) {
        return;
    }

    const username = getLoggedInUser();
    const storedEmailHint = getStoredEmailHint();
    const emailFields = [];

    authButtonAreas.forEach((container) => {
        const emailValueElement = renderHeaderAuthButtons(container, username, storedEmailHint);
        if (emailValueElement) {
            emailFields.push(emailValueElement);
        }
    });

    if (!username || storedEmailHint) {
        return;
    }

    const latestEmailHint = await fetchProfileSummary(username);
    if (!latestEmailHint) {
        return;
    }

    emailFields.forEach((field) => {
        field.textContent = latestEmailHint;
    });
}

function getAuthElements() {
    return {
        authCard: document.querySelector(".auth-card"),
        title: document.getElementById("modalTitle"),
        subtitle: document.getElementById("authSubtitle"),
        submitBtn: document.getElementById("submitBtn"),
        switchText: document.getElementById("switchText"),
        username: document.getElementById("username"),
        email: document.getElementById("email"),
        emailField: document.getElementById("emailField"),
        password: document.getElementById("password"),
        loginTab: document.getElementById("loginTab"),
        registerTab: document.getElementById("registerTab")
    };
}

function applyAuthMode(el, loginMode) {
    isLogin = loginMode;
    el.title.innerText = isLogin ? "Giriş Yap" : "Kayıt Ol";
    el.submitBtn.innerText = isLogin ? "Giriş Yap" : "Kayıt Ol";

    if (el.subtitle) {
        el.subtitle.innerText = isLogin ? "Hesabınla devam et." : "Yeni hesap oluştur.";
    }

    if (isLogin) {
        el.switchText.innerHTML = "Hesabın yok mu? <a href=\"#\" onclick=\"openRegister(); return false;\">Kayıt Ol</a>";
    } else {
        el.switchText.innerHTML = "Zaten hesabın var mı? <a href=\"#\" onclick=\"openLogin(); return false;\">Giriş Yap</a>";
    }

    if (el.loginTab && el.registerTab) {
        el.loginTab.classList.toggle("active", isLogin);
        el.registerTab.classList.toggle("active", !isLogin);
    }

    if (el.emailField && el.email) {
        el.emailField.classList.toggle("hidden", isLogin);
        el.email.required = !isLogin;
        el.email.disabled = isLogin;
        if (isLogin) {
            el.email.value = "";
        }
    }

    if (el.password) {
        el.password.setAttribute("autocomplete", isLogin ? "current-password" : "new-password");
    }
}

function setAuthMode(loginMode, options = {}) {
    const el = getAuthElements();
    if (!el.title || !el.submitBtn || !el.switchText) {
        return;
    }

    const animate = options.animate !== false;
    const hasModeChanged = isLogin !== loginMode;

    window.clearTimeout(authModeTimer);
    if (el.authCard) {
        el.authCard.classList.remove("is-switching");
    }

    const commitMode = () => {
        applyAuthMode(el, loginMode);
        authModeInitialized = true;
    };

    const shouldAnimate = Boolean(
        animate &&
        authModeInitialized &&
        hasModeChanged &&
        el.authCard
    );

    if (!shouldAnimate) {
        commitMode();
        return;
    }

    el.authCard.classList.add("is-switching");
    authModeTimer = window.setTimeout(() => {
        commitMode();
        window.requestAnimationFrame(() => {
            el.authCard.classList.remove("is-switching");
        });
    }, AUTH_MODE_SWITCH_DELAY_MS);
}

function openLogin() {
    setAuthMode(true);
}

function openRegister() {
    setAuthMode(false);
}

function initPageTransitions() {
    const body = document.body;
    if (!body) {
        return;
    }
    body.classList.add("page-transition-ready");
    window.requestAnimationFrame(() => {
        body.classList.add("page-transition-in");
    });
    document.addEventListener("click", (event) => {
        if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
        ) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const anchor = target.closest("a[href]");
        if (!(anchor instanceof HTMLAnchorElement)) {
            return;
        }
        const rawHref = anchor.getAttribute("href");
        if (!rawHref) {
            return;
        }
        const normalizedHref = rawHref.trim().toLowerCase();
        if (
            rawHref.startsWith("#") ||
            normalizedHref.startsWith("mailto:") ||
            normalizedHref.startsWith("tel:") ||
            normalizedHref.startsWith("javascript:")
        ) {
            return;
        }
        if (anchor.target && anchor.target.toLowerCase() === "_blank") {
            return;
        }
        if (anchor.hasAttribute("download")) {
            return;
        }
        const nextUrl = new URL(anchor.href, window.location.href);
        if (nextUrl.origin !== window.location.origin) {
            return;
        }
        if (
            nextUrl.pathname === window.location.pathname &&
            nextUrl.search === window.location.search
        ) {
            return;
        }
        if (body.classList.contains("page-leaving")) {
            event.preventDefault();
            return;
        }
        event.preventDefault();
        body.classList.add("page-leaving");
        window.setTimeout(() => {
            window.location.href = nextUrl.href;
        }, PAGE_TRANSITION_DURATION_MS);
    });
    window.addEventListener("pageshow", (event) => {
        if (!event.persisted) {
            return;
        }
        body.classList.remove("page-leaving");
        body.classList.add("page-transition-in");
    });
}

async function submitAuth() {
    const el = getAuthElements();
    if (!el.username || !el.password || !el.submitBtn) {
        return;
    }

    const username = el.username.value.trim();
    const email = el.email ? el.email.value.trim() : "";
    const password = el.password.value;

    if (!username || !password || (!isLogin && !email)) {
        showToast("Alanları boş bırakma.", "error");
        return;
    }

    const endpoint = isLogin ? "/api/login" : "/api/register";
    el.submitBtn.disabled = true;
    el.submitBtn.innerText = isLogin ? "Giriş yapılıyor..." : "Kayıt oluşturuluyor...";

    try {
        const requestBody = isLogin
            ? { username, password }
            : { username, email, password };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (
                isLogin &&
                response.status === 403 &&
                payload &&
                payload.requiresEmailVerification
            ) {
                const hint = payload.emailHint ? ` (${payload.emailHint})` : "";
                const resendConfirm = await showConfirm(
                    `Hesabın doğrulanmamış${hint}. Doğrulama mailini tekrar göndermek ister misin?`,
                    {
                        title: "E-posta Doğrulama",
                        cancelText: "Sonra",
                        approveText: "Tekrar Gönder"
                    }
                );

                if (resendConfirm) {
                    await resendVerification(username);
                }
                return;
            }

            showToast(payload.message || "İşlem başarısız.", "error");
            return;
        }

        if (isLogin) {
            setLoggedInUser(payload.username || username, payload.emailHint);
            showToast("Giriş başarılı.", "success", { duration: 1800 });
            window.setTimeout(() => {
                window.location.href = "/mainpage.html";
            }, LOGIN_REDIRECT_DELAY_MS);
            return;
        }

        const registerMessageRaw = typeof payload.message === "string"
            ? payload.message
            : "Kayıt başarılı. E-posta doğrulama linki gönderildi.";
        const registerMessage = registerMessageRaw.replace(/^Kayit basarili/i, "Kayıt başarılı");
        showToast(registerMessage, "success", { duration: 5000 });

        if (payload.devVerificationLink) {
            showToast(`Geliştirme linki: ${payload.devVerificationLink}`, "info", { duration: 9000 });
        }

        el.password.value = "";
        openLogin();
    } catch (error) {
        showToast("Sunucuya bağlanılamadı.", "error");
    } finally {
        el.submitBtn.disabled = false;
        el.submitBtn.innerText = isLogin ? "Giriş Yap" : "Kayıt Ol";
    }
}

async function resendVerification(username) {
    try {
        const response = await fetch("/api/resend-verification", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ username })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            showToast(payload.message || "Doğrulama maili tekrar gönderilemedi.", "error");
            return;
        }

        showToast(payload.message || "Doğrulama maili tekrar gönderildi.", "success");
        if (payload.devVerificationLink) {
            showToast(`Geliştirme linki: ${payload.devVerificationLink}`, "info", { duration: 9000 });
        }
    } catch (error) {
        showToast("Sunucuya bağlanılamadı.", "error");
    }
}

function normalizeCartItem(item) {
    if (!item || typeof item !== "object") {
        return null;
    }

    const name = typeof item.name === "string" ? item.name.trim() : "";
    const rawPrice = Number(item.price);
    const rawQuantity = Number(item.quantity ?? 1);

    if (!name || !Number.isFinite(rawPrice) || rawPrice <= 0) {
        return null;
    }

    const quantity = Number.isFinite(rawQuantity) ? Math.max(1, Math.floor(rawQuantity)) : 1;

    return {
        name,
        price: Math.round(rawPrice),
        quantity
    };
}

function loadCart() {
    try {
        const raw = localStorage.getItem(CART_KEY);
        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.map(normalizeCartItem).filter(Boolean);
    } catch (error) {
        return [];
    }
}

function saveCart(cart) {
    const safeCart = Array.isArray(cart) ? cart.map(normalizeCartItem).filter(Boolean) : [];
    localStorage.setItem(CART_KEY, JSON.stringify(safeCart));
}

function formatMoney(value) {
    return `${value}₺`;
}

function setCartBadge(count) {
    const badge = document.getElementById("cartCountBadge");
    if (!badge) {
        return;
    }

    badge.innerText = String(count);
    badge.classList.toggle("empty", count === 0);
}

function renderCart() {
    const cartItemsEl = document.getElementById("cartItems");
    const cartTotalEl = document.getElementById("cartTotal");
    const clearBtn = document.getElementById("clearCartBtn");

    if (!cartItemsEl || !cartTotalEl) {
        return;
    }

    const cart = loadCart();
    saveCart(cart);
    cartItemsEl.innerHTML = "";

    if (cart.length === 0) {
        cartItemsEl.innerHTML = "<li class=\"cart-empty\">Sepetin şu an boş.</li>";
        cartTotalEl.innerText = formatMoney(0);
        setCartBadge(0);
        if (clearBtn) {
            clearBtn.disabled = true;
        }
        return;
    }

    let total = 0;
    let quantityCount = 0;

    cart.forEach((item, index) => {
        total += item.price * item.quantity;
        quantityCount += item.quantity;

        const li = document.createElement("li");
        li.className = "cart-item";
        li.innerHTML = `
            <div class="cart-item-info">
                <strong>${item.name}</strong>
                <span>${item.quantity} x ${formatMoney(item.price)}</span>
            </div>
            <div class="cart-item-actions">
                <button type="button" class="qty-btn" data-action="decrease" data-index="${index}">-</button>
                <span class="qty-value">${item.quantity}</span>
                <button type="button" class="qty-btn" data-action="increase" data-index="${index}">+</button>
                <button type="button" class="remove-btn" data-action="remove" data-index="${index}">Sil</button>
            </div>
        `;
        cartItemsEl.appendChild(li);
    });

    cartTotalEl.innerText = formatMoney(total);
    setCartBadge(quantityCount);

    if (clearBtn) {
        clearBtn.disabled = false;
    }
}

function openCart() {
    document.body.classList.add("cart-open");
}

function closeCart() {
    document.body.classList.remove("cart-open");
}

function toggleCart() {
    document.body.classList.toggle("cart-open");
}

function addToCart(name, price) {
    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanPrice = Number(price);

    if (!cleanName || !Number.isFinite(cleanPrice) || cleanPrice <= 0) {
        return;
    }

    const cart = loadCart();
    const roundedPrice = Math.round(cleanPrice);
    const existingItem = cart.find((item) => item.name === cleanName && item.price === roundedPrice);

    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({
            name: cleanName,
            price: roundedPrice,
            quantity: 1
        });
    }

    saveCart(cart);
    renderCart();
    openCart();
}

function changeQuantity(index, delta) {
    const cart = loadCart();
    if (!Number.isInteger(index) || index < 0 || index >= cart.length) {
        return;
    }

    cart[index].quantity += delta;

    if (cart[index].quantity <= 0) {
        cart.splice(index, 1);
    }

    saveCart(cart);
    renderCart();
}

function removeFromCart(index) {
    const cart = loadCart();
    if (!Number.isInteger(index) || index < 0 || index >= cart.length) {
        return;
    }

    cart.splice(index, 1);
    saveCart(cart);
    renderCart();
}

function clearCart() {
    saveCart([]);
    renderCart();
}

function setActiveShopCategoryButton(category) {
    document.querySelectorAll(".shop-category-btn").forEach((button) => {
        const isActive = button.getAttribute("data-category") === category;
        button.classList.toggle("active", isActive);
    });
}

function showShopLoadingState(isLoading) {
    const loadingLayer = document.getElementById("shopLoading");
    const productGrid = document.getElementById("shopProducts");

    if (loadingLayer) {
        loadingLayer.classList.toggle("visible", isLoading);
    }

    if (productGrid) {
        productGrid.classList.toggle("is-loading", isLoading);
    }
}

function applyShopCategory(category) {
    document.querySelectorAll(".shop-card[data-category]").forEach((card) => {
        const shouldShow = card.getAttribute("data-category") === category;
        card.classList.toggle("is-hidden", !shouldShow);

        if (shouldShow) {
            card.classList.remove("pop-in");
            void card.offsetWidth;
            card.classList.add("pop-in");
        }
    });
}

function switchShopCategory(category, delayMs) {
    if (!category) {
        return;
    }

    setActiveShopCategoryButton(category);
    showShopLoadingState(true);
    window.clearTimeout(shopCategoryTimer);

    shopCategoryTimer = window.setTimeout(() => {
        applyShopCategory(category);
        showShopLoadingState(false);
    }, delayMs);
}

function initShopCategories() {
    const categoryButtons = document.querySelectorAll(".shop-category-btn");
    if (categoryButtons.length === 0) {
        return;
    }

    const activeButton = document.querySelector(".shop-category-btn.active");
    const initialCategory = (
        activeButton?.getAttribute("data-category") ||
        categoryButtons[0].getAttribute("data-category")
    );

    switchShopCategory(initialCategory, 900);

    categoryButtons.forEach((button) => {
        button.addEventListener("click", () => {
            if (button.classList.contains("active")) {
                return;
            }

            const category = button.getAttribute("data-category");
            switchShopCategory(category, SHOP_CATEGORY_DELAY_MS);
        });
    });
}

function initAuthPage() {
    if (!document.body.classList.contains("auth-page")) {
        return;
    }

    if (getLoggedInUser()) {
        window.location.replace("/mainpage.html");
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const verifiedStatus = params.get("verified");
    const mode = params.get("mode");

    if (verifiedStatus === "success") {
        showToast("E-posta doğrulandı. Şimdi giriş yapabilirsin.", "success", { duration: 4500 });
    } else if (verifiedStatus === "expired" || verifiedStatus === "invalid") {
        showToast("Doğrulama linki geçersiz veya süresi dolmuş.", "error", { duration: 5000 });
    } else if (verifiedStatus === "error") {
        showToast("Doğrulama sırasında bir hata oluştu.", "error");
    }

    setAuthMode(mode !== "register", { animate: false });

    const username = document.getElementById("username");
    const email = document.getElementById("email");
    const password = document.getElementById("password");

    [username, email, password].forEach((input) => {
        if (!input) {
            return;
        }

        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                submitAuth();
            }
        });
    });
}

function initStorePage() {
    if (!document.body.classList.contains("shop-page")) {
        return;
    }

    initShopCategories();

    document.querySelectorAll(".add-to-cart").forEach((button) => {
        button.addEventListener("click", () => {
            const name = button.getAttribute("data-name");
            const price = Number(button.getAttribute("data-price"));
            addToCart(name, price);
        });
    });

    const cartItemsEl = document.getElementById("cartItems");
    if (cartItemsEl) {
        cartItemsEl.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const actionButton = target.closest("button[data-action]");
            if (!actionButton) {
                return;
            }

            const action = actionButton.getAttribute("data-action");
            const index = Number(actionButton.getAttribute("data-index"));

            if (!Number.isInteger(index)) {
                return;
            }

            if (action === "increase") {
                changeQuantity(index, 1);
            } else if (action === "decrease") {
                changeQuantity(index, -1);
            } else if (action === "remove") {
                removeFromCart(index);
            }
        });
    }

    const clearBtn = document.getElementById("clearCartBtn");
    if (clearBtn) {
        clearBtn.addEventListener("click", clearCart);
    }

    const toggleBtn = document.getElementById("cartToggleBtn");
    if (toggleBtn) {
        toggleBtn.addEventListener("click", toggleCart);
    }

    const closeBtn = document.getElementById("closeCartBtn");
    if (closeBtn) {
        closeBtn.addEventListener("click", closeCart);
    }

    const overlay = document.getElementById("cartOverlay");
    if (overlay) {
        overlay.addEventListener("click", closeCart);
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeCart();
        }
    });

    renderCart();
}

document.addEventListener("DOMContentLoaded", () => {
    initPageTransitions();
    initHeaderAuthState();
    initAuthPage();
    initStorePage();
});
