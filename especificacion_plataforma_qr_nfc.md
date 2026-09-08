# Especificación funcional y técnica
## Plataforma de gestión de QR y NFC dinámicos (redirección web + activación de WiFi)

---

## 1. Resumen del proyecto

Necesito una **aplicación web (landing page avanzada + panel de administración)** que me permita gestionar de forma centralizada códigos **QR** y etiquetas **NFC** físicas que **aún no tienen destino asignado**. Cada QR/NFC apuntará siempre a una URL fija de mi plataforma (no a la web final), y desde el panel de administración yo podré decidir, en cualquier momento, hacia dónde redirige cada uno o si en vez de redirigir a una web debe **conectar al dispositivo a una red WiFi** con el SSID y contraseña que yo configure.

La idea central es que el destino de cada QR/NFC sea **dinámico**: puedo cambiarlo después de haber impreso el QR o programado el NFC, sin tener que reimprimir ni reprogramar nada físicamente.

---

## 2. Objetivo principal

- Cada QR impreso y cada etiqueta NFC programada debe apuntar a una **URL única e inmutable** de mi dominio (ej: `midominio.com/t/{id}` o `midominio.com/t/{slug}`).
- Esa URL, al ser escaneada, debe comportarse según lo que yo haya configurado en el panel para ese `{id}` concreto:
  - **Modo Redirección Web:** reenvía automáticamente al visitante a la URL externa que yo haya definido (ej. mi web, un perfil, un catálogo, etc.).
  - **Modo WiFi:** en lugar de redirigir a una web, muestra una página que permite conectarse a la red WiFi configurada (SSID + contraseña + tipo de seguridad).
- Debo poder cambiar el modo y el destino de cada `{id}` cuantas veces quiera desde el panel, y el cambio debe aplicarse de inmediato sin tocar el QR ni el NFC físico.

---

## 3. Funcionalidades clave

### 3.1 Gestión de "Tags" (unidad = un QR o un NFC)
Cada elemento gestionable (lo llamaremos "Tag") debe tener:
- **ID único / slug** (generado automáticamente o personalizable).
- **Nombre descriptivo** (para identificarlo yo en el panel, ej: "Mesa 3 - Restaurante", "Cartel entrada oficina").
- **Tipo de soporte**: QR, NFC, o ambos (mismo ID compartido entre un QR y un NFC físico si quiero que apunten al mismo destino).
- **Modo de destino** (seleccionable y editable en cualquier momento):
  - `URL` → redirección a una web externa.
  - `WIFI` → activación/conexión a una red WiFi.
  - `DESACTIVADO` → página neutra tipo "Este código aún no está configurado" (útil para cuando imprimo QR en stock antes de asignarles uso).
- **Fecha de creación** y **fecha de última modificación**.
- **Estado** (activo / pausado).

### 3.2 Modo Redirección Web
- Campo para introducir la URL de destino (validación de formato URL).
- Redirección tipo 301/302 automática al escanear, sin pasos intermedios para el usuario final (salvo que yo decida activar una pantalla intermedia opcional tipo "Continuar a la web").
- Opción de programar redirecciones con fecha de caducidad o cambio automático (opcional, fase 2).

### 3.3 Modo WiFi
- Campos: **SSID (nombre red)**, **contraseña**, **tipo de seguridad** (WPA/WPA2/WPA3, WEP, sin contraseña).
- Al escanear el QR o acercar el NFC, debe:
  - En **Android**: permitir conexión automática a la red (los QR con formato estándar `WIFI:T:WPA;S:SSID;P:password;;` son reconocidos de forma nativa por la cámara de Android).
  - En **iOS**: dado que Apple no permite conexión automática vía navegador, la página debe mostrar el SSID y la contraseña de forma clara con un botón "Copiar contraseña", además de instrucciones cortas ("Ve a Ajustes > WiFi > selecciona esta red y pega la contraseña").
- Generar internamente el string estándar de configuración WiFi (formato `WIFI:` normalizado) para que el QR generado sea compatible con lectores nativos de cámara, no solo con nuestra web.
- Para NFC: programar la etiqueta con un registro NDEF que, si el sistema operativo lo soporta, dispare la conexión directa; si no, redirigir a la landing con la información de conexión.

### 3.4 Panel de administración (dashboard)
- Login con usuario y contraseña (autenticación segura).
- Listado de todos los Tags creados, con: nombre, tipo de soporte, modo actual, destino actual, número de escaneos, fecha de última modificación.
- Botón para **crear nuevo Tag** (genera automáticamente la URL única y el QR descargable en PNG/SVG).
- Botón para **editar** cualquier Tag: cambiar entre modo URL / WIFI / DESACTIVADO, y modificar los valores correspondientes en cualquier momento.
- Botón para **descargar el QR** en alta resolución, listo para imprimir.
- Botón para **generar el payload NFC** (el string exacto que se debe escribir en la etiqueta con una app de escritura NFC, o integración con Web NFC API si el navegador lo permite).
- Estadísticas básicas por Tag: número total de escaneos, fecha del último escaneo (fase 2: gráfico de escaneos por fecha, geolocalización aproximada, tipo de dispositivo).
- Buscador/filtro de Tags por nombre, tipo o estado.

### 3.5 Página pública que ve el usuario final (la que se abre al escanear)
- Debe cargar muy rápido (sin diseño pesado).
- Si el Tag está en modo `URL`: redirección inmediata, o pantalla mínima de transición ("Redirigiendo...") si se prefiere.
- Si el Tag está en modo `WIFI`: pantalla clara con el nombre de la red, botón de copiar contraseña, e instrucciones adaptadas al sistema operativo detectado (Android/iOS).
- Si el Tag está `DESACTIVADO` o no existe: página neutra informando que el código no está configurado todavía.

---

## 4. Flujo de uso resumido

1. Compro/genero QR y etiquetas NFC en blanco (sin destino).
2. En el panel, creo un nuevo Tag → el sistema genera un `{id}` único y su URL fija (`midominio.com/t/{id}`).
3. Genero el QR con esa URL y lo imprimo / escribo esa misma URL en la etiqueta NFC.
4. Coloco el QR/NFC donde lo necesite (físicamente no volveré a tocarlo).
5. Desde el panel, en cualquier momento, entro al Tag correspondiente y decido si en ese momento debe redirigir a una web o activar un WiFi concreto.
6. Cualquier persona que escanee ese QR o acerque el móvil al NFC verá el comportamiento que yo haya configurado en ese instante.
7. Si más adelante quiero cambiar el destino (otra web, otro WiFi, o desactivarlo), lo hago desde el panel sin tocar el QR/NFC físico.

---

## 5. Requisitos técnicos sugeridos

- **Backend:** base de datos con una tabla `tags` con al menos los campos: `id`, `slug`, `nombre`, `modo` (url/wifi/desactivado), `url_destino`, `wifi_ssid`, `wifi_password`, `wifi_seguridad`, `escaneos`, `fecha_creacion`, `fecha_actualizacion`, `estado`.
- **Endpoint público:** `GET /t/{slug}` que consulta el Tag, registra el escaneo (contador + timestamp) y devuelve la vista o redirección correspondiente según el modo.
- **Panel privado:** rutas protegidas por autenticación para crear, editar, listar y eliminar Tags.
- **Generación de QR:** librería estándar de generación de QR (ej. `qrcode` en Node/Python) que codifique la URL fija del Tag.
- **Formato WiFi estándar:** al generar el QR en modo WiFi, usar el formato reconocido nativamente por cámaras: `WIFI:T:{seguridad};S:{ssid};P:{password};;`
- **NFC:** dado que la escritura de NFC requiere contacto físico con un lector/móvil, la plataforma debe generar el texto/URL exacto a programar; si el navegador del usuario lo soporta, integrar **Web NFC API** para escribir la etiqueta directamente desde el panel (solo compatible con Chrome en Android).
- **Seguridad:** HTTPS obligatorio, contraseñas WiFi almacenadas cifradas en la base de datos, autenticación robusta en el panel de administración.
- **Responsive:** tanto el panel como la página pública deben funcionar bien en móvil, ya que la mayoría de escaneos se harán desde el teléfono.

---

## 6. Consideraciones importantes a tener en cuenta

- La conexión automática a WiFi mediante QR/NFC solo funciona de forma nativa en **Android**; en **iOS no existe una API pública que permita conectar automáticamente a una red WiFi desde una web o NFC**, por lo que en iPhone el usuario deberá copiar la contraseña y conectarse manualmente. Es importante detectar el sistema operativo (user-agent) para mostrar las instrucciones adecuadas.
- Un mismo `{id}`/Tag puede compartirse entre un QR impreso y una etiqueta NFC si ambos deben apuntar siempre al mismo destino; o pueden crearse Tags independientes si quiero controlar cada soporte por separado.
- Pensar la arquitectura para poder escalar en el futuro a: múltiples usuarios/roles, estadísticas avanzadas de escaneo, dominios personalizados, caducidad automática de destinos, y plantillas de diseño para las páginas públicas.

---

## 7. Resumen para el desarrollador

> Quiero una landing page dinámica con panel de administración. Cada QR/NFC que genere apunta siempre a una URL fija de mi propio dominio. Desde el panel puedo configurar, cambiar y desactivar en cualquier momento si esa URL debe: (a) redirigir a una página web externa, o (b) mostrar/activar los datos de conexión a una red WiFi (SSID + contraseña). El sistema debe permitir crear, editar y eliminar estos "Tags" de forma ilimitada, descargar el QR correspondiente a cada uno, generar el payload para programar la etiqueta NFC, y llevar un conteo básico de escaneos por Tag.

---
