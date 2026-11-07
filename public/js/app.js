const money = value =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN"
  }).format(Number(value));

const grid = document.querySelector("#product-grid");
const message = document.querySelector("#catalog-message");
const cartPanel = document.querySelector("#cart-panel");
const backdrop = document.querySelector("#cart-backdrop");
const cart = new Map();

const accountPanel = document.querySelector("#account-panel");
const accountStatus = document.querySelector("#account-status");
const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");
const loggedInPanel = document.querySelector("#account-logged-in");
const accountTitle = document.querySelector("#account-title");
const loginTab = document.querySelector("#show-login");
const registerTab = document.querySelector("#show-register");
const accountToggle = document.querySelector("#account-toggle");
const checkoutButton = document.querySelector("#checkout-button");

// ========================================
// VALIDACIÓN VISUAL DE CONTRASEÑA
// ========================================

const registerPassword = document.querySelector(
  '#register-form input[name="password"]'
);

const passwordRules = document.createElement("div");
passwordRules.id = "password-rules";

passwordRules.innerHTML = `
  <p data-rule="length">❌ Entre 8 y 10 caracteres</p>
  <p data-rule="uppercase">❌ Una letra mayúscula</p>
  <p data-rule="lowercase">❌ Una letra minúscula</p>
  <p data-rule="number">❌ Un número</p>
`;

if (registerPassword) {
  registerPassword.insertAdjacentElement("afterend", passwordRules);
}

const passwordStyle = document.createElement("style");

passwordStyle.textContent = `
  #password-rules {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin: 12px 0;
    font-size: 13px;
  }

  #password-rules p {
    margin: 0;
    color: #dc2626;
  }

  #password-rules p.valid {
    color: #16a34a;
    font-weight: bold;
  }
`;

document.head.appendChild(passwordStyle);

function validateRegisterPassword() {
  if (!registerPassword) return false;

  const password = registerPassword.value;

  const rules = {
    length: password.length >= 8 && password.length <= 10,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password)
  };

  const labels = {
    length: "Entre 8 y 10 caracteres",
    uppercase: "Una letra mayúscula",
    lowercase: "Una letra minúscula",
    number: "Un número"
  };

  Object.entries(rules).forEach(([name, valid]) => {
    const element = passwordRules.querySelector(
      `[data-rule="${name}"]`
    );

    element.classList.toggle("valid", valid);
    element.textContent = `${valid ? "✔" : "❌"} ${labels[name]}`;
  });

  return Object.values(rules).every(Boolean);
}

registerPassword?.addEventListener("input", validateRegisterPassword);

// ========================================
// VARIABLES GENERALES
// ========================================

let products = [];
let currentUser = null;
let paypalSdkPromise = null;
let paypalContainer = null;
let paymentInProgress = false;

// ========================================
// SOLICITUDES A LA API
// ========================================

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Ocurrió un error. Inténtalo de nuevo.");
  }

  return data;
}

// ========================================
// CATÁLOGO
// ========================================

async function loadProducts() {
  try {
    const response = await fetch("/api/products", {
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error("No se pudieron cargar los productos.");
    }

    products = await response.json();
    renderProducts();
  } catch (_error) {
    grid.innerHTML =
      '<p class="loading">No se pudo conectar con el catálogo. Comprueba que el servidor esté activo.</p>';
  }
}

function renderProducts() {
  if (!products.length) {
    grid.innerHTML =
      '<p class="loading">Todavía no hay productos. Revisa los productos de la base de datos.</p>';
    return;
  }

  grid.innerHTML = products.map((product, index) => `
    <article class="product-card">
      <div class="product-image">
        <span class="product-tag">${index === 0 ? "FAVORITO" : "COLECCIÓN 2026"}</span>
        <img
          src="${escapeAttribute(product.image_url)}"
          alt="${escapeAttribute(product.name)}"
          loading="lazy"
        >
      </div>

      <div class="product-meta">
        <div>
          <h3>${escapeHtml(product.name)}</h3>
          <p>${escapeHtml(product.description || "")}</p>
        </div>

        <span class="price">${money(product.price)}</span>
      </div>

      <button
        class="add-button"
        type="button"
        data-add="${Number(product.id)}"
        ${Number(product.stock) < 1 ? "disabled" : ""}
      >
        ${Number(product.stock) < 1 ? "AGOTADA" : "AGREGAR A LA BOLSA +"}
      </button>
    </article>
  `).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

// ========================================
// CARRITO
// ========================================

function addToCart(id) {
  const product = products.find(item => Number(item.id) === Number(id));

  if (!product) return;

  const current = cart.get(Number(id))?.quantity || 0;

  if (current >= Number(product.stock)) {
    message.textContent = "No hay más unidades disponibles de este producto.";
    return;
  }

  cart.set(Number(id), {
    product,
    quantity: current + 1
  });

  message.textContent = `${product.name} se agregó a tu bolsa.`;
  renderCart();
  openCart();
}

function changeQuantity(id, amount) {
  const item = cart.get(Number(id));

  if (!item) return;

  const next = item.quantity + amount;

  if (next < 1) {
    cart.delete(Number(id));
  } else if (next <= Number(item.product.stock)) {
    item.quantity = next;
  } else {
    message.textContent = "No hay más unidades disponibles de este producto.";
  }

  renderCart();
}

function renderCart() {
  const items = [...cart.values()];

  const count = items.reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  const total = items.reduce(
    (sum, item) => sum + Number(item.product.price) * item.quantity,
    0
  );

  document.querySelector("#cart-count").textContent = count;
  document.querySelector("#cart-total").textContent = money(total);

  document.querySelector("#cart-items").innerHTML = items.length
    ? items.map(({ product, quantity }) => `
      <div class="cart-row">
        <img
          src="${escapeAttribute(product.image_url)}"
          alt="${escapeAttribute(product.name)}"
        >

        <div>
          <h3>${escapeHtml(product.name)}</h3>
          <p>${money(product.price)}</p>

          <div class="quantity">
            <button
              type="button"
              data-change="${Number(product.id)}"
              data-amount="-1"
              aria-label="Quitar una unidad"
            >−</button>

            <span>${quantity}</span>

            <button
              type="button"
              data-change="${Number(product.id)}"
              data-amount="1"
              aria-label="Añadir una unidad"
            >+</button>
          </div>

          <button
            class="remove-button"
            type="button"
            data-remove="${Number(product.id)}"
          >Eliminar</button>
        </div>
      </div>
    `).join("")
    : "<p>Tu bolsa está vacía.</p>";
}

function openCart() {
  cartPanel.classList.add("open");
  backdrop.classList.add("open");
  cartPanel.setAttribute("aria-hidden", "false");
}

function closeCart() {
  cartPanel.classList.remove("open");
  backdrop.classList.remove("open");
  cartPanel.setAttribute("aria-hidden", "true");
}

// ========================================
// CUENTA E INICIO DE SESIÓN
// ========================================

function openAccount() {
  accountPanel.hidden = false;
  accountStatus.textContent = "";
  document.body.classList.add("account-open");
}

function closeAccount() {
  accountPanel.hidden = true;
  document.body.classList.remove("account-open");
}

function showLogin() {
  loginForm.hidden = false;
  registerForm.hidden = true;
  loggedInPanel.hidden = true;

  loginTab.hidden = false;
  registerTab.hidden = false;

  accountTitle.textContent = "Iniciar sesión";
  accountStatus.textContent = "";
}

function showRegister() {
  loginForm.hidden = true;
  registerForm.hidden = false;
  loggedInPanel.hidden = true;

  loginTab.hidden = false;
  registerTab.hidden = false;

  accountTitle.textContent = "Crear cuenta";
  accountStatus.textContent = "";

  validateRegisterPassword();
}

function showLoggedIn(user) {
  currentUser = user;

  loginForm.hidden = true;
  registerForm.hidden = true;
  loggedInPanel.hidden = false;

  loginTab.hidden = true;
  registerTab.hidden = true;

  accountTitle.textContent = "Mi cuenta";

  document.querySelector("#account-user-name").textContent = user.name;
  accountStatus.textContent = "Has iniciado sesión correctamente.";
  accountToggle.textContent = `Hola, ${user.name}`;
}

function showLoggedOut(messageText = "") {
  currentUser = null;
  showLogin();
  accountToggle.textContent = "Mi cuenta";
  accountStatus.textContent = messageText;
}

// ========================================
// PAYPAL
// ========================================

async function loadPayPalSdk() {
  if (window.paypal) return window.paypal;
  if (paypalSdkPromise) return paypalSdkPromise;

  paypalSdkPromise = (async () => {
    const config = await apiRequest("/api/paypal/config");

    if (config.mode !== "sandbox") {
      throw new Error("La tienda no está configurada en modo Sandbox.");
    }

    const script = document.createElement("script");

    const params = new URLSearchParams({
      "client-id": config.clientId,
      currency: config.currency,
      intent: "capture",
      components: "buttons"
    });

    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    script.async = true;

    await new Promise((resolve, reject) => {
      script.onload = resolve;

      script.onerror = () => reject(
        new Error("No se pudo cargar PayPal. Comprueba tu conexión.")
      );

      document.head.appendChild(script);
    });

    if (!window.paypal?.Buttons) {
      throw new Error("El botón de PayPal no está disponible.");
    }

    return window.paypal;
  })();

  try {
    return await paypalSdkPromise;
  } catch (error) {
    paypalSdkPromise = null;
    throw error;
  }
}

function getCheckoutItems() {
  return [...cart.values()].map(({ product, quantity }) => ({
    productId: Number(product.id),
    quantity
  }));
}

function removePayPalButton() {
  if (paypalContainer) {
    paypalContainer.remove();
    paypalContainer = null;
  }

  checkoutButton.hidden = false;
  checkoutButton.disabled = false;
  checkoutButton.textContent = "FINALIZAR COMPRA";
}

function showPaymentMessage(text) {
  message.textContent = text;
}

async function startPayPalCheckout() {
  if (paymentInProgress) return;

  if (cart.size === 0) {
    showPaymentMessage("Tu bolsa está vacía.");
    return;
  }

  if (!currentUser) {
    closeCart();
    openAccount();
    showLogin();

    accountStatus.textContent =
      "Inicia sesión antes de continuar con el pago.";

    return;
  }

  paymentInProgress = true;
  checkoutButton.disabled = true;
  checkoutButton.textContent = "CARGANDO PAYPAL…";

  try {
    const paypal = await loadPayPalSdk();

    if (!paypalContainer) {
      paypalContainer = document.createElement("div");
      paypalContainer.id = "paypal-button-container";
      paypalContainer.style.marginTop = "16px";

      checkoutButton.insertAdjacentElement("afterend", paypalContainer);
    }

    checkoutButton.hidden = true;
    paypalContainer.innerHTML = "";

    await paypal.Buttons({
      style: {
        layout: "vertical",
        shape: "rect",
        label: "paypal"
      },

      createOrder: async () => {
        if (!currentUser) {
          throw new Error("Inicia sesión para continuar.");
        }

        const data = await apiRequest("/api/paypal/create-order", {
          method: "POST",
          body: JSON.stringify({
            items: getCheckoutItems()
          })
        });

        if (!data.paypalOrderId) {
          throw new Error("PayPal no devolvió el identificador del pedido.");
        }

        return data.paypalOrderId;
      },

      onApprove: async data => {
        checkoutButton.textContent = "CONFIRMANDO PAGO…";

        const result = await apiRequest("/api/paypal/capture-order", {
          method: "POST",
          body: JSON.stringify({
            paypalOrderId: data.orderID
          })
        });

        cart.clear();
        renderCart();
        removePayPalButton();
        closeCart();

        await loadProducts();

        showPaymentMessage(
          `¡Pago de prueba completado! Pedido #${result.orderId}.`
        );

        alert(
          `¡Pago de prueba completado!\n\n` +
          `Pedido: #${result.orderId}\n` +
          `Estado: Pagado en Sandbox\n\n` +
          `Este pago es de prueba; no es un cobro real.`
        );
      },

      onCancel: () => {
        showPaymentMessage(
          "Cancelaste el pago. Tu bolsa sigue disponible para intentarlo de nuevo."
        );

        removePayPalButton();
      },

      onError: error => {
        console.error("Error en el pago PayPal:", error);

        showPaymentMessage(
          "No se pudo completar el pago. Revisa el estado del pedido antes de volver a intentarlo."
        );

        removePayPalButton();
      }
    }).render("#paypal-button-container");

    showPaymentMessage(
      "Elige PayPal para continuar con tu pago de prueba."
    );
  } catch (error) {
    console.error("Error al iniciar PayPal:", error);

    removePayPalButton();
    showPaymentMessage(error.message);
    alert(error.message);
  } finally {
    paymentInProgress = false;
    checkoutButton.disabled = false;

    if (!checkoutButton.hidden) {
      checkoutButton.textContent = "FINALIZAR COMPRA";
    }
  }
}

// ========================================
// EVENTOS DEL CARRITO
// ========================================

document.addEventListener("click", event => {
  const add = event.target.closest("[data-add]");

  if (add) {
    addToCart(Number(add.dataset.add));
  }

  const change = event.target.closest("[data-change]");

  if (change) {
    changeQuantity(
      Number(change.dataset.change),
      Number(change.dataset.amount)
    );
  }

  const remove = event.target.closest("[data-remove]");

  if (remove) {
    cart.delete(Number(remove.dataset.remove));
    renderCart();
  }
});

document.querySelector("#cart-toggle").addEventListener("click", openCart);
document.querySelector("#cart-close").addEventListener("click", closeCart);
backdrop.addEventListener("click", closeCart);

checkoutButton.addEventListener("click", startPayPalCheckout);

// ========================================
// EVENTOS DE CUENTA
// ========================================

accountToggle.addEventListener("click", async () => {
  openAccount();

  try {
    const data = await apiRequest("/api/me");
    showLoggedIn(data.user);
  } catch (_error) {
    showLoggedOut();
  }
});

document.querySelector("#account-close").addEventListener("click", closeAccount);

loginTab.addEventListener("click", showLogin);
registerTab.addEventListener("click", showRegister);

accountPanel.addEventListener("click", event => {
  if (event.target === accountPanel) {
    closeAccount();
  }
});

// ========================================
// REGISTRO DE USUARIO
// ========================================

registerForm.addEventListener("submit", async event => {
  event.preventDefault();

  if (!validateRegisterPassword()) {
    accountStatus.textContent =
      "Completa todos los requisitos de la contraseña.";
    return;
  }

  accountStatus.textContent = "Creando tu cuenta…";

  const formData = new FormData(registerForm);
  const email = formData.get("email");

  try {
    const data = await apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        email,
        password: formData.get("password")
      })
    });

    registerForm.reset();
    validateRegisterPassword();

    showLogin();

    document.querySelector("#login-email").value = email;

    accountStatus.textContent =
      data.message + " Ahora inicia sesión.";
  } catch (error) {
    accountStatus.textContent = error.message;
  }
});

// ========================================
// INICIO DE SESIÓN
// ========================================

loginForm.addEventListener("submit", async event => {
  event.preventDefault();

  accountStatus.textContent = "Iniciando sesión…";

  const formData = new FormData(loginForm);

  try {
    const data = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password")
      })
    });

    loginForm.reset();
    showLoggedIn(data.user);
  } catch (error) {
    accountStatus.textContent = error.message;
  }
});

// ========================================
// CERRAR SESIÓN
// ========================================

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    const data = await apiRequest("/api/logout", {
      method: "POST"
    });

    showLoggedOut(data.message);
  } catch (error) {
    accountStatus.textContent = error.message;
  }
});

// ========================================
// COMPROBAR SESIÓN EXISTENTE
// ========================================

async function checkExistingSession() {
  try {
    const data = await apiRequest("/api/me");
    showLoggedIn(data.user);
  } catch (_error) {
    showLoggedOut();
  }
}

// ========================================
// INICIAR APLICACIÓN
// ========================================

loadProducts();
renderCart();
checkExistingSession();