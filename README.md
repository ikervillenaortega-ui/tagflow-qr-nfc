# TagFlow — Plataforma de QR y NFC dinámicos

Aplicación web autoalojada para gestionar códigos **QR** y etiquetas **NFC** con destino dinámico: cada código apunta siempre a una URL fija de tu dominio (`/t/{slug}`) y desde el panel decides si esa URL **redirige a una web**, muestra los **datos de una red WiFi** o permanece **desactivada**. Cambia el destino cuando quieras sin reimprimir ni reprogramar nada físico.

## Stack

- **Backend:** Node.js (≥18.13) + Express 4 + EJS
- **Base de datos:** SQLite (better-sqlite3, modo WAL) — fichero único, sin dependencias externas
- **QR:** librería `qrcode` (PNG de alta resolución y SVG vectorial)
- **Seguridad:** Helmet (CSP), sesiones firmadas en SQLite, bcrypt, CSRF tokens, limitación de intentos de login, contraseñas WiFi cifradas con AES-256-GCM

## Puesta en marcha

```bash
npm install
npm run create-admin          # usuario y contraseña del panel
npm start                     # http://localhost:3000
```

En desarrollo: `npm run dev` (recarga automática). Tests: `npm test`.

Crea un `.env` copiando `.env.example` y ajusta los valores antes de desplegar.

## Estructura

```
src/
  server.js        # punto de entrada
  app.js           # fábrica de la app Express (middleware, sesiones, rutas)
  config.js        # configuración por variables de entorno
  db.js            # SQLite + migraciones
  models.js        # capa de datos (tags, escaneos, usuarios)
  auth.js          # login, sesiones, CSRF, rate limiting
  routes/
    public.js      # landing, /t/{slug}, healthcheck
    admin.js       # panel: CRUD, QR, NFC
  views/           # EJS (admin/ y public/)
public/            # CSS y JS estáticos
scripts/create-admin.js
test/              # tests con node:test (unitarios + integración)
```

## Endpoints principales

| Ruta | Descripción |
| --- | --- |
| `GET /` | Landing pública |
| `GET /t/{slug}` | Endpoint dinámico: redirige o muestra la página según el modo |
| `GET /healthz` | Healthcheck JSON |
| `GET /admin` | Panel (redirige a login si no hay sesión) |
| `GET /admin/tags` | Listado con búsqueda y filtros |
| `GET·POST /admin/tags/nuevo` · `/admin/tags` | Crear Tag |
| `GET·POST /admin/tags/{id}` · `/editar` | Ver / editar Tag |
| `POST /admin/tags/{id}/eliminar` | Eliminar Tag |
| `POST /admin/tags/{id}/estado` | Activar / pausar |
| `GET /admin/tags/{id}/qr.png?payload=url\|wifi` | Descargar QR PNG |
| `GET /admin/tags/{id}/qr.svg?payload=url\|wifi` | Descargar QR SVG |

## Comportamiento del endpoint público

- **Modo `url`:** redirección 302 al destino configurado (302 y no 301 a propósito: el destino puede cambiar en cualquier momento y no queremos cachés eternas de proxies/navegadores).
- **Modo `wifi`:** página ligera con SSID, contraseña (botón copiar) e instrucciones adaptadas al SO detectado por user-agent. En Android la cámara nativa ya conecta directamente con el QR «WiFi directo» del panel.
- **`desactivado` / pausado / inexistente:** página neutra «aún no configurado».
- Cada escaneo incrementa el contador, guarda fecha, user-agent y un hash de la IP (nunca la IP en claro).

## QR y NFC

- El QR estándar del Tag codifica la **URL fija** (`https://tudominio.com/t/{slug}`): imprímelo una vez y cambia el destino desde el panel.
- En modo WiFi el panel genera además un **QR «WiFi directo»** con el formato estándar `WIFI:T:WPA;S:red;P:clave;;` que las cámaras de Android reconocen de forma nativa (conexión instantánea, sin pasar por la web). En iOS no existe API pública para conexión automática: la página muestra la red y la contraseña.
- **Payload NFC:** el panel muestra la URL exacta a programar (recomendado) y, en modo WiFi, el string `WIFI:` como texto NDEF. Si el navegador soporta **Web NFC API** (Chrome en Android), el botón «Escribir en etiqueta» programa la etiqueta directamente.

## Seguridad

- Contraseñas del panel: bcrypt (coste 10).
- Contraseñas WiFi: AES-256-GCM con clave derivada de `WIFI_SECRET`.
- Sesiones: cookie `httpOnly`, `SameSite=Lax`, `Secure` (con `COOKIE_SECURE=true`), almacenadas en SQLite.
- CSRF: token por sesión en todos los formularios de escritura.
- Login: límite de 5 intentos por IP cada 15 minutos.
- CSP estricta (sin inline scripts en el panel; `upgrade-insecure-requests` en producción).

## Despliegue

Detrás de Nginx/Caddy con HTTPS:

```env
NODE_ENV=production
BASE_URL=https://tudominio.com
SESSION_SECRET=<cadena aleatoria larga>
WIFI_SECRET=<otra cadena aleatoria larga>
COOKIE_SECURE=true
TRUST_PROXY=true
```

Genera secretos con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Respalda el directorio `data/` (contiene `app.db`). Para migrar a PostgreSQL/MySQL en el futuro, la capa `src/models.js` aísla todas las consultas SQL.

## Fase 2 (prevista en la especificación)

- Gráfico de escaneos por fecha, geolocalización aproximada y tipo de dispositivo (la tabla `scans` ya registra los datos necesarios).
- Redirecciones programadas con caducidad.
- Múltiples usuarios/roles, dominios personalizados y plantillas de diseño para las páginas públicas.