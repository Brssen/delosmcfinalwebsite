const CART_KEY = "delosmc_cart";
const SHOP_CATEGORY_DELAY_MS = 700;
const PAGE_TRANSITION_DURATION_MS = 420;
const AUTH_MODE_SWITCH_DELAY_MS = 140;
let isLogin = true;
let shopCategoryTimer = null;
let authModeInitialized = false;
let authModeTimer = null;

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
        alert("Alanları boş bırakma.");
        return;
    }

    const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
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
                const resendConfirm = confirm(
                    `Hesabin dogrulanmamis${hint}. Dogrulama mailini tekrar gondermek ister misin?`
                );

                if (resendConfirm) {
                    await resendVerification(username);
                }
                return;
            }

            alert(payload.message || "İşlem başarısız.");
            return;
        }

        if (isLogin) {
            sessionStorage.setItem("logged_user", payload.username || username);
            alert("Giriş başarılı.");
            window.location.href = "/mainpage.html";
            return;
        }

        const registerMessage = payload.message || "Kayit basarili. E-posta dogrulama linki gonderildi.";
        alert(registerMessage);

        if (payload.devVerificationLink) {
            alert(`Gelistirme linki: ${payload.devVerificationLink}`);
        }

        el.password.value = "";
        openLogin();
    } catch (error) {
        alert("Sunucuya bağlanılamadı.");
    } finally {
        el.submitBtn.disabled = false;
        el.submitBtn.innerText = isLogin ? "Giriş Yap" : "Kayıt Ol";
    }
}

async function resendVerification(username) {
    try {
        const response = await fetch("/api/auth/resend-verification", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ username })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            alert(payload.message || "Dogrulama maili tekrar gonderilemedi.");
            return;
        }

        alert(payload.message || "Dogrulama maili tekrar gonderildi.");
        if (payload.devVerificationLink) {
            alert(`Gelistirme linki: ${payload.devVerificationLink}`);
        }
    } catch (error) {
        alert("Sunucuya baglanilamadi.");
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

    const params = new URLSearchParams(window.location.search);
    const verifiedStatus = params.get("verified");
    const mode = params.get("mode");

    if (verifiedStatus === "success") {
        alert("E-posta dogrulandi. Simdi giris yapabilirsin.");
    } else if (verifiedStatus === "expired" || verifiedStatus === "invalid") {
        alert("Dogrulama linki gecersiz veya suresi dolmus.");
    } else if (verifiedStatus === "error") {
        alert("Dogrulama sirasinda bir hata olustu.");
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
    initAuthPage();
    initStorePage();
});

