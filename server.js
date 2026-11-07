require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const bcrypt = require("bcryptjs");
const pool = require("./src/config/db");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const PAYPAL_BASE_URL =
  process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";

const PAYPAL_CURRENCY = "MXN";

if (!process.env.SESSION_SECRET) {
  console.error("Falta configurar SESSION_SECRET en .env");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(
  session({
    name: "yourmomcaps.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Demasiados intentos. Espera 15 minutos y vuelve a intentar."
  }
});

const ordersLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Demasiadas solicitudes de pedidos. Inténtalo más tarde."
  }
});

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Debes iniciar sesión para continuar."
    });
  }

  next();
}

// Convierte el carrito en cantidades validadas.
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    throw new Error("CARRITO_INVALIDO");
  }

  const quantities = new Map();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new Error("ARTICULO_INVALIDO");
    }

    const productId = Number(item.productId);
    const quantity = Number(item.quantity);

    if (
      !Number.isSafeInteger(productId) ||
      productId < 1 ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 10
    ) {
      throw new Error("ARTICULO_INVALIDO");
    }

    const totalQuantity = (quantities.get(productId) || 0) + quantity;

    if (totalQuantity > 10) {
      throw new Error("CANTIDAD_EXCEDIDA");
    }

    quantities.set(productId, totalQuantity);
  }

  if (quantities.size > 20) {
    throw new Error("CARRITO_INVALIDO");
  }

  return quantities;
}

// Crea el pedido local con precios calculados desde MySQL.
async function createLocalOrder(userId, items) {
  const quantities = validateItems(items);
  const connection = await pool.getConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const productIds = [...quantities.keys()];
    const placeholders = productIds.map(() => "?").join(", ");

    const [products] = await connection.execute(
      `SELECT id, name, price, stock
       FROM products
       WHERE active = 1 AND id IN (${placeholders})
       FOR UPDATE`,
      productIds
    );

    if (products.length !== productIds.length) {
      throw new Error("PRODUCTO_NO_DISPONIBLE");
    }

    let totalCents = 0;
    const orderItems = [];

    for (const product of products) {
      const quantity = quantities.get(Number(product.id));
      const priceCents = Math.round(Number(product.price) * 100);

      if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
        throw new Error("PRECIO_INVALIDO");
      }

      if (Number(product.stock) < quantity) {
        throw new Error("STOCK_INSUFICIENTE");
      }

      totalCents += priceCents * quantity;

      orderItems.push({
        productId: product.id,
        name: product.name,
        price: (priceCents / 100).toFixed(2),
        quantity
      });
    }

    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      throw new Error("TOTAL_INVALIDO");
    }

    const total = (totalCents / 100).toFixed(2);

    const [orderResult] = await connection.execute(
      `INSERT INTO orders (user_id, total, status)
       VALUES (?, ?, 'pending')`,
      [userId, total]
    );

    for (const item of orderItems) {
      await connection.execute(
        `INSERT INTO order_items
         (order_id, product_id, product_name, unit_price, quantity)
         VALUES (?, ?, ?, ?, ?)`,
        [
          orderResult.insertId,
          item.productId,
          item.name,
          item.price,
          item.quantity
        ]
      );
    }

    await connection.commit();
    transactionStarted = false;

    return {
      orderId: orderResult.insertId,
      total,
      orderItems
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback().catch(() => {});
    }

    throw error;
  } finally {
    connection.release();
  }
}

// Solicita un token OAuth a PayPal.
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Falta configurar las credenciales de PayPal en .env");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("PayPal no pudo autenticar la aplicación.");
    throw new Error("No se pudo autenticar con PayPal.");
  }

  return data.access_token;
}

// Llama a la API de PayPal desde el servidor.
async function paypalRequest(endpoint, accessToken, options = {}) {
  const response = await fetch(`${PAYPAL_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(
      "Error en PayPal:",
      response.status,
      data.name || "API_ERROR"
    );

    throw new Error("PayPal no pudo completar la solicitud.");
  }

  return data;
}

// Estado del servidor y conexión a MySQL.
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      ok: true,
      database: "conectada",
      store: "YOUR MOM CAPS",
      paymentMode: "PayPal Sandbox"
    });
  } catch (error) {
    console.error("Error de conexión:", error.message);

    return res.status(503).json({
      ok: false,
      database: "sin conexión",
      message: "Revisa la configuración de .env y MySQL."
    });
  }
});

// Configuración pública para mostrar el botón PayPal.
// Nunca se devuelve el Client Secret.
app.get("/api/paypal/config", (_req, res) => {
  if (!process.env.PAYPAL_CLIENT_ID) {
    return res.status(503).json({
      error: "Falta configurar PAYPAL_CLIENT_ID en .env."
    });
  }

  return res.json({
    clientId: process.env.PAYPAL_CLIENT_ID,
    currency: PAYPAL_CURRENCY,
    mode: "sandbox"
  });
});

// Catálogo.
app.get("/api/products", async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, description, price, image_url, stock
       FROM products
       WHERE active = 1
       ORDER BY id DESC`
    );

    return res.json(rows);
  } catch (error) {
    console.error("Error al cargar productos:", error.message);

    return res.status(500).json({
      error: "No se pudieron cargar los productos."
    });
  }
});

// Registro.
app.post("/api/register", authLimiter, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({
      error: "Escribe un nombre de 2 a 80 caracteres."
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) {
    return res.status(400).json({
      error: "Correo electrónico no válido."
    });
  }

  if (password.length < 10 || password.length > 72) {
    return res.status(400).json({
      error: "La contraseña debe tener entre 10 y 72 caracteres."
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    await pool.execute(
      `INSERT INTO users (name, email, password_hash)
       VALUES (?, ?, ?)`,
      [name, email, hash]
    );

    return res.status(201).json({
      message: "Cuenta creada correctamente. Ya puedes iniciar sesión."
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: "Ese correo ya tiene una cuenta."
      });
    }

    console.error("Error al registrar:", error.message);

    return res.status(500).json({
      error: "No se pudo crear la cuenta."
    });
  }
});

// Inicio de sesión.
app.post("/api/login", authLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password || email.length > 190 || password.length > 72) {
    return res.status(400).json({
      error: "Escribe un correo y una contraseña válidos."
    });
  }

  try {
    const [users] = await pool.execute(
      `SELECT id, name, email, password_hash
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({
        error: "Correo o contraseña incorrectos."
      });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: "Correo o contraseña incorrectos."
      });
    }

    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error("Error de sesión:", sessionError.message);

        return res.status(500).json({
          error: "No se pudo iniciar sesión."
        });
      }

      req.session.userId = user.id;

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Error al guardar sesión:", saveError.message);

          return res.status(500).json({
            error: "No se pudo guardar la sesión."
          });
        }

        return res.json({
          message: "Inicio de sesión exitoso.",
          user: {
            id: user.id,
            name: user.name,
            email: user.email
          }
        });
      });
    });
  } catch (error) {
    console.error("Error al iniciar sesión:", error.message);

    return res.status(500).json({
      error: "No se pudo iniciar sesión."
    });
  }
});

// Consultar la sesión.
app.get("/api/me", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "No has iniciado sesión."
    });
  }

  try {
    const [users] = await pool.execute(
      `SELECT id, name, email
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [req.session.userId]
    );

    if (users.length === 0) {
      return req.session.destroy(() => {
        res.clearCookie("yourmomcaps.sid");

        return res.status(401).json({
          error: "La cuenta ya no está disponible."
        });
      });
    }

    return res.json({ user: users[0] });
  } catch (error) {
    console.error("Error al consultar usuario:", error.message);

    return res.status(500).json({
      error: "No se pudo consultar la cuenta."
    });
  }
});

// Crear un pedido local pendiente, sin cobrar.
app.post(
  "/api/orders",
  requireLogin,
  ordersLimiter,
  async (req, res) => {
    try {
      const order = await createLocalOrder(
        req.session.userId,
        req.body?.items
      );

      return res.status(201).json({
        message: "Pedido creado. Está pendiente de pago.",
        orderId: order.orderId,
        total: order.total,
        status: "pending"
      });
    } catch (error) {
      const clientErrors = {
        CARRITO_INVALIDO: "El pedido debe contener entre 1 y 20 productos.",
        ARTICULO_INVALIDO: "Hay un producto o una cantidad no válida.",
        CANTIDAD_EXCEDIDA: "No puedes pedir más de 10 unidades por producto.",
        PRODUCTO_NO_DISPONIBLE: "Uno o más productos ya no están disponibles.",
        STOCK_INSUFICIENTE: "No hay suficiente inventario para ese pedido.",
        PRECIO_INVALIDO: "No se pudo calcular un precio válido.",
        TOTAL_INVALIDO: "No se pudo calcular un total válido."
      };

      if (clientErrors[error.message]) {
        return res.status(400).json({ error: clientErrors[error.message] });
      }

      console.error("Error al registrar pedido:", error.message);

      return res.status(500).json({
        error: "No se pudo registrar el pedido."
      });
    }
  }
);

// Crear pedido local y orden PayPal.
app.post(
  "/api/paypal/create-order",
  requireLogin,
  ordersLimiter,
  async (req, res) => {
    let localOrder;

    try {
      localOrder = await createLocalOrder(
        req.session.userId,
        req.body?.items
      );

      const accessToken = await getPayPalAccessToken();

      const paypalOrder = await paypalRequest(
        "/v2/checkout/orders",
        accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: String(localOrder.orderId),
                custom_id: String(localOrder.orderId),
                invoice_id: `YMC-${localOrder.orderId}`,
                description: `Pedido YOUR MOM CAPS #${localOrder.orderId}`,
                amount: {
                  currency_code: PAYPAL_CURRENCY,
                  value: localOrder.total
                }
              }
            ]
          })
        }
      );

      if (!paypalOrder.id) {
        throw new Error("PayPal no devolvió un ID de orden.");
      }

      await pool.execute(
        `UPDATE orders
         SET payment_provider = ?, payment_reference = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
        ["paypal", paypalOrder.id, localOrder.orderId, req.session.userId]
      );

      return res.status(201).json({
        orderId: localOrder.orderId,
        paypalOrderId: paypalOrder.id,
        total: localOrder.total,
        currency: PAYPAL_CURRENCY,
        status: "pending"
      });
    } catch (error) {
      console.error("Error al crear orden PayPal:", error.message);

      return res.status(500).json({
        error:
          "No se pudo iniciar el pago de prueba. Revisa la configuración de PayPal."
      });
    }
  }
);

// Capturar el pago después de la aprobación del comprador.
app.post(
  "/api/paypal/capture-order",
  requireLogin,
  ordersLimiter,
  async (req, res) => {
    const paypalOrderId = String(req.body?.paypalOrderId || "").trim();

    if (!/^[A-Z0-9]+$/i.test(paypalOrderId) || paypalOrderId.length > 64) {
      return res.status(400).json({
        error: "El identificador de PayPal no es válido."
      });
    }

    let connection;

    try {
      const [orders] = await pool.execute(
        `SELECT id, total, status, payment_provider, payment_reference
         FROM orders
         WHERE user_id = ? AND payment_provider = ?
           AND payment_reference = ?
         LIMIT 1`,
        [req.session.userId, "paypal", paypalOrderId]
      );

      if (orders.length === 0) {
        return res.status(404).json({
          error: "No se encontró un pedido de PayPal para tu cuenta."
        });
      }

      const order = orders[0];

      if (order.status === "paid") {
        return res.json({
          message: "Este pedido ya está pagado.",
          orderId: order.id,
          status: "paid"
        });
      }

      if (order.status !== "pending") {
        return res.status(409).json({
          error: "El pedido no está pendiente de pago."
        });
      }

      const accessToken = await getPayPalAccessToken();

      const paypalDetails = await paypalRequest(
        `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
        accessToken
      );

      const originalUnit =
        paypalDetails.purchase_units?.find(
          (unit) => unit.custom_id === String(order.id)
        ) ||
        paypalDetails.purchase_units?.find(
          (unit) => unit.reference_id === String(order.id)
        ) ||
        paypalDetails.purchase_units?.[0];

      if (
        !originalUnit ||
        originalUnit.amount?.currency_code !== PAYPAL_CURRENCY ||
        Number(originalUnit.amount?.value).toFixed(2) !==
          Number(order.total).toFixed(2)
      ) {
        return res.status(400).json({
          error: "El importe o el pedido no coincide con la tienda."
        });
      }

      let captureResult = paypalDetails;

      if (paypalDetails.status !== "COMPLETED") {
        if (paypalDetails.status !== "APPROVED") {
          return res.status(409).json({
            error: "El comprador todavía no ha aprobado el pago en PayPal."
          });
        }

        captureResult = await paypalRequest(
          `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
          accessToken,
          {
            method: "POST",
            body: JSON.stringify({})
          }
        );
      }

      const capturedUnit =
        captureResult.purchase_units?.find(
          (unit) => unit.custom_id === String(order.id)
        ) ||
        captureResult.purchase_units?.find(
          (unit) => unit.reference_id === String(order.id)
        ) ||
        captureResult.purchase_units?.[0];

      const captures = capturedUnit?.payments?.captures || [];

      const completedCapture = captures.find(
        (capture) =>
          capture.status === "COMPLETED" &&
          capture.amount?.currency_code === PAYPAL_CURRENCY &&
          Number(capture.amount?.value).toFixed(2) ===
            Number(order.total).toFixed(2)
      );

      if (captureResult.status !== "COMPLETED" || !completedCapture) {
        console.error(
          "La captura de PayPal no coincide con el pedido local.",
          JSON.stringify({
            orderStatus: captureResult.status,
            purchaseUnitFound: Boolean(capturedUnit),
            expectedTotal: Number(order.total).toFixed(2),
            captureStatuses: captures.map((capture) => ({
              status: capture.status,
              currency: capture.amount?.currency_code,
              value: capture.amount?.value
            }))
          })
        );

        return res.status(409).json({
          error:
            "PayPal no confirmó una captura que coincida con el importe del pedido. Verifica el estado en PayPal antes de volver a intentarlo."
        });
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [lockedOrders] = await connection.execute(
        `SELECT id, status
         FROM orders
         WHERE id = ? AND user_id = ?
         FOR UPDATE`,
        [order.id, req.session.userId]
      );

      if (lockedOrders.length === 0) {
        await connection.rollback();

        return res.status(404).json({
          error: "No se encontró el pedido."
        });
      }

      if (lockedOrders[0].status === "paid") {
        await connection.commit();

        return res.json({
          message: "Este pedido ya está pagado.",
          orderId: order.id,
          status: "paid"
        });
      }

      if (lockedOrders[0].status !== "pending") {
        await connection.rollback();

        return res.status(409).json({
          error: "El pedido ya no está pendiente."
        });
      }

      await connection.execute(
        `UPDATE orders
         SET status = 'paid'
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
        [order.id, req.session.userId]
      );

      await connection.commit();

      return res.json({
        message: "Pago de prueba completado correctamente.",
        orderId: order.id,
        captureId: completedCapture.id,
        total: order.total,
        currency: PAYPAL_CURRENCY,
        status: "paid"
      });
    } catch (error) {
      if (connection) {
        await connection.rollback().catch(() => {});
      }

      console.error("Error al capturar pago PayPal:", error.message);

      return res.status(500).json({
        error:
          "No se pudo confirmar el pago. Consulta el estado en PayPal antes de reintentar."
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

// Historial de pedidos.
app.get("/api/orders", requireLogin, async (req, res) => {
  try {
    const [orders] = await pool.execute(
      `SELECT id, total, status, payment_provider,
              payment_reference, created_at
       FROM orders
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.session.userId]
    );

    for (const order of orders) {
      const [items] = await pool.execute(
        `SELECT product_name, unit_price, quantity
         FROM order_items
         WHERE order_id = ?
         ORDER BY id ASC`,
        [order.id]
      );

      order.items = items;
    }

    return res.json({ orders });
  } catch (error) {
    console.error("Error al consultar pedidos:", error.message);

    return res.status(500).json({
      error: "No se pudieron consultar tus pedidos."
    });
  }
});

// Cerrar sesión.
app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        error: "No se pudo cerrar la sesión."
      });
    }

    res.clearCookie("yourmomcaps.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    return res.json({
      message: "Sesión cerrada correctamente."
    });
  });
});

// Manejo general de errores.
app.use((err, _req, res, _next) => {
  console.error("Error interno:", err.message);

  res.status(500).json({
    error: "Ocurrió un error interno."
  });
});

// Página principal.
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`YOUR MOM CAPS está disponible en http://localhost:${PORT}`);
});