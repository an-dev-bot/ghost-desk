# Ghost Desk G1

Juego personal de trading: **dinero falso, precios reales**. Una cartera de $10,000 dólares para operar
memecoins de Solana, cripto (las 30 más grandes), acciones de EE. UU. y divisas. Es una app web que se
instala en el teléfono (PWA). No tiene servidor: todo corre y se guarda en el teléfono.

## Fuentes de precios (todas gratis)

| Mercado | Precios | Gráficas | Clave |
|---|---|---|---|
| Memecoins | DexScreener, cada 10 s | GeckoTerminal | No |
| Cripto | Binance en vivo (Coinbase si Binance no responde); lista de las 30 de CoinGecko | Binance / Coinbase | No |
| Acciones | Finnhub, tiempo real | Twelve Data | **Sí**: Finnhub. Twelve Data es opcional |
| Divisas | Coinbase (tasa media, cambia cada 30–60 s) | Twelve Data | Twelve Data, opcional |

Sin claves funcionan memecoins, cripto y divisas. Acciones pide la clave de Finnhub.
Sin la de Twelve Data, las gráficas de acciones y divisas se dibujan con los precios en vivo desde que abres la app.

## Las claves

- **Finnhub**: crea tu cuenta en https://finnhub.io/register. La clave aparece en tu panel (Dashboard).
- **Twelve Data** (opcional): crea tu cuenta en https://twelvedata.com/register y luego ve a Dashboard → API Keys.

Pégalas en la app, en **Ajustes** (el engrane de arriba a la derecha). Se guardan solo en ese teléfono:
no van en el código, ni en el repo, ni en el archivo de respaldo. En cada equipo donde uses la app
tienes que pegarlas otra vez.

## Publicar en GitHub Pages, paso a paso

1. Entra a https://github.com/new.
   - Repository name: `ghost-desk`
   - Elige **Public** (GitHub Pages gratis necesita repo público).
   - No marques "Add a README" (ya hay uno aquí).
   - Toca **Create repository**.
2. En la terminal, dentro de esta carpeta (`~/Desktop/ghost-desk`), corre esto. Cambia `TU-USUARIO` por tu usuario de GitHub:
   ```
   git init
   git add .
   git commit -m "Ghost Desk G1"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/ghost-desk.git
   git push -u origin main
   ```
   El archivo `.gitignore` deja fuera `ESPEC_G1_GHOST_DESK.md`. Si también quieres dejar fuera la versión 0
   (`ghost-desk.html`), agrégala a `.gitignore` antes del `git add`.
3. En GitHub, abre tu repo → **Settings** → **Pages** (menú de la izquierda).
   - En "Build and deployment", Source: **Deploy from a branch**.
   - Branch: **main**, carpeta **/ (root)** → **Save**.
4. Espera uno o dos minutos y recarga esa página: arriba aparece "Your site is live at
   `https://TU-USUARIO.github.io/ghost-desk/`".

## Abrirla e instalarla en el teléfono

- **Android (Chrome)**: abre `https://TU-USUARIO.github.io/ghost-desk/` → menú ⋮ → **Instalar app**
  (o "Agregar a pantalla de inicio"). También está el botón "Instalar" en Ajustes.
- **iPhone (Safari)**: abre la dirección → botón Compartir ⬆️ → **Agregar a pantalla de inicio**.
  Los avisos en iPhone solo funcionan así, instalada, con iOS 16.4 o más.

Después: Ajustes → pega la clave de Finnhub → **Guardar** (la app la prueba y te dice si funciona) →
**Permitir avisos** y elige cuáles quieres.

## Pasar la cartera de la PC al teléfono

Abre la misma dirección en la PC → Ajustes → **Exportar archivo**. Pasa ese `.json` al teléfono
(correo, Drive, WhatsApp) → en el teléfono, Ajustes → **Importar archivo**.
La versión 0 (`ghost-desk.html`) guardaba en otro lugar del navegador y no se puede importar.

## Actualizar la app más adelante

Cambias archivos, y luego:
```
git add .
git commit -m "Cambios"
git push
```
GitHub Pages publica solo en uno o dos minutos. En el teléfono, cierra y vuelve a abrir la app dos veces para
que tome la versión nueva. Si cambias archivos de la app, sube también el número `VERSION` en `sw.js`.

## Cómo funciona

- **Costos por operación**: memecoins 1% + impacto según la liquidez; cripto 0.1% + 0.02% de deslizamiento;
  acciones $0 de comisión + la mitad del diferencial (lo mayor entre $0.01 y 0.01% del precio);
  divisas $0 + la mitad del diferencial típico de cada par (EURUSD 1 pip, USDMXN 80 pips, etc.).
- **Horarios reales**: acciones de 9:30 a 16:00 de Nueva York (con feriados y cierres temprano de NYSE);
  fuera de horario la orden espera y se llena con el primer precio después de la apertura.
  Divisas de domingo 17:00 a viernes 17:00 de Nueva York. Cripto y memecoins siempre.
- **Órdenes límite, stop loss y take profit**: se llenan cuando el precio en vivo las toca mientras la app
  está abierta; al abrirla se revisan con el precio actual.
- **Avisos**: llegan con la app abierta o recién minimizada. Con la app cerrada del todo haría falta un
  servidor de avisos (Web Push), que esta versión no tiene.
- **Sin conexión**: la cartera y el historial se ven con los últimos precios guardados.
- **Calendario de noticias**: no hay fuente gratis que funcione desde el navegador, así que no se muestra.

## Pruebas

Necesitan Python 3 con el paquete `websockets` y Google Chrome:

```
python tests/serve.py . 8765        (en otra terminal; deja este corriendo)
python tests/run.py "C:/Program Files/Google/Chrome/Application/chrome.exe" http://127.0.0.1:8765 capturas
```

Corre las pruebas de la especificación con precios hechos a mano (cuentas, horario, órdenes, respaldo,
claves) y revisa la app a 375 px de ancho, comprando de verdad con el gesto de deslizar.
Con un cuarto argumento corre contra las fuentes reales: `live`, `badkeys` o `tddemo` (ver `tests/run.py`).
También puedes abrir `http://127.0.0.1:8765/tests/` en el navegador.
