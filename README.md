# YOUR MOM CAPS — etapa 1

Tienda escolar de gorras con Node.js, Express, MySQL, HTML, CSS y JavaScript.

## Requisitos
- Node.js y npm
- MySQL Server en ejecución
- MySQL Workbench

## 1. Configurar la base de datos
1. Abre MySQL Workbench y conéctate a tu servidor local.
2. Abre `database/schema.sql` (File > Open SQL Script).
3. Ejecuta todo el archivo con el botón del rayo.
4. Abre `database/seed.sql` y ejecútalo también.
5. En el panel SCHEMAS, pulsa refrescar. Debe aparecer `your_mom_caps` con tablas `users`, `products`, `orders` y `order_items`.

Los scripts usan `IF NOT EXISTS` para crear la base sin borrar datos existentes.

## 2. Crear tu archivo de configuración
1. En VS Code, copia `.env.example` y crea una copia llamada `.env` en la raíz del proyecto.
2. Abre `.env` y sustituye `CAMBIA_ESTA_POR_TU_CONTRASENA_DE_MYSQL` por la contraseña que elegiste para el usuario `root` de MySQL.
3. Cambia `SESSION_SECRET` por una cadena larga y única.
4. No compartas el archivo `.env` ni publiques su contenido.

## 3. Instalar dependencias
En VS Code abre Terminal > New Terminal. Comprueba que la terminal esté en la carpeta `your-mom-caps`, y ejecuta:

```bash
npm install
```

## 4. Iniciar la tienda
```bash
npm start
```

Abre en el navegador `http://localhost:3000`. Para probar la conexión de base de datos abre `http://localhost:3000/api/health`; debe mostrar `"database":"conectada"`.

## Incluido en esta etapa
- Catálogo de productos desde MySQL
- Diseño adaptable para celular y computadora
- Bolsa/carrito de compras de demostración
- Tablas iniciales de usuarios, productos, pedidos y partidas
- Registro básico con contraseña hasheada y consultas SQL preparadas
- Helmet y límite de intentos para registro

## Aún no incluido
El carrito no crea pedidos en el servidor ni cobra. Inicio de sesión completo, sesiones seguras, administración, seguimiento de pedidos y PayPal Sandbox son etapas posteriores. No uses esta versión como tienda pública ni introduzcas datos reales de clientes. Antes de publicar, se debe implementar autenticación/sesiones completas, autorización administrativa, validación de pedidos en servidor, CSRF y verificación de pagos del lado del servidor.

## Solución de problemas
- `Access denied for user 'root'`: revisa `DB_PASSWORD` en `.env`.
- `ECONNREFUSED`: confirma que el servicio MySQL está iniciado.
- `Unknown database`: ejecuta `database/schema.sql` en Workbench.
- Catálogo vacío: ejecuta `database/seed.sql`.
