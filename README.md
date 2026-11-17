# Mantenimiento – sitio del departamento

Sitio web (Render, Docker) generado con `build.py` y servido por `server.js`:

- **Estaciones** (`/estacion/<estacion>/`): hoja HPM desde los Excel de `HPM/`, con menú de SECCIÓN / PARTE, todos los
  pasos tal cual el Excel y sus imágenes con los números de paso. Se abre escaneando el QR pegado en la estación.
- **Troubleshooting** (`/estacion/<estacion>/troubleshooting/`): efectos de falla agrupados en EQUIPO / PROCESO /
  MATERIAL y sus posibles causas, de las matrices causa-efecto de `troubleshooting/` (una marca ꙩ en el cruce = esa
  causa aplica). Si una hoja nueva no aparece, agregar su nombre a `TS_ESTACION` en `build.py`.
- **Indicadores** (`/kpi/`): dashboard de BDR, MTTR y MTBF por año, mes y línea.

## Asistente (chatbot)

Cada página tiene un chat (`templates/_consulta.html` + `templates/asistente.js`) que pregunta a `/api/chat` de `server.js`.
El modelo se elige por la variable que esté definida (en este orden):

1. **`GROQ_API_KEY` → Groq (gratis)**. Usa `openai/gpt-oss-120b` y, si llega a su límite (8 000 tokens/min en el plan gratis)
   o falla, `openai/gpt-oss-20b` (cambiar con `GROQ_MODELOS="a,b"`; los Llama ya no existen). Como el plan gratis limita tokens por minuto y por día, el HPM y el
   troubleshooting no van en el prompt: el modelo los consulta con las herramientas `buscar_hpm` y `troubleshooting`.
2. **`ANTHROPIC_API_KEY` → Claude Haiku 5.5 (de pago, centavos)**, con todas las hojas en el prompt (en caché).
3. **Ninguna (o fallan) → el buscador local** de siempre (`crear` en `asistente.js`); para que entienda palabras
   nuevas, agregarlas a `SINONIMOS`; los casos están en `casos_consulta.json`.

Los indicadores siempre se calculan con herramientas sobre `andon.js` (nunca de memoria): resumen de un periodo o rango
de meses, rankings (líneas, máquinas, fallas, turnos) y **gráficas** (`graficar_kpi`) que el chat dibuja con Chart.js.
Ej.: «gráfica del MTTR de marzo a junio en Honda 25SA», «BDR por línea en octubre», «máquinas con más fallas».
Tope de 40 preguntas por IP cada 10 min.

**Clave de Groq**: en https://console.groq.com crear cuenta → *API Keys* → *Create API Key*; copiarla en Render como
`GROQ_API_KEY`. Los límites del plan gratis están en *Settings → Limits* de la consola. Revisar los términos de Groq
antes de enviar datos de planta.

## Matrices de troubleshooting

`py limpiar_matrices.py` normaliza las 4 matrices DXD a lo que aplica en todas las máquinas (quita reset azul, UA4700,
fdoor, switch del nido, TPX, antena WiFi, CAN, MES/iTAC, Mediator, K-Line, sensor de bracket…; une pines, DB9, flex,
radio defectuoso y modelos). Respaldo de los originales en `_respaldo_matrices/` (no se sube). Reglas en `CAUSAS`.

## Indicadores (BDR, MTTR, MTBF)

Implementados en `templates/andon.js`. **Solo cuentan los reportes con *Genero interrupcion?* = Si, con *Linea* y *Maquina*
distintas de "N/A" y cuyo *Usuario solicitante* no es ADMINISTRADOR DEL SISTEMA** (en todos los KPIs, gráficas, tablas,
filtros y consultas); cada uno es una falla. La fecha es *Inicio de la falla* (día/mes/año).

| Indicador | Cálculo | Unidad |
|---|---|---|
| Fallas | número de filas (del filtro: periodo, línea, máquina) | — |
| Downtime (breakdown time) | suma de *Tiempo de reparacion (segundos)* ÷ 60 | min |
| Espera del técnico | suma de *Tiempo de localización (segundos)* ÷ 60 | min |
| Loading | fijo por mes, hoja *Datos Maestros Actual* de `Maintenance 2026/KPI*.xlsx`; el año suma los meses con reportes | min |
| BDR | downtime ÷ loading × 100 | % |
| MTTR | downtime ÷ fallas | min |
| MTBF | (loading − downtime) ÷ fallas ÷ 60 | h |

- **Reportes**: `Maintenance 2026/andon.json` (todos los reportes ANDON acumulados).
- La relación entre los nombres de línea de ANDON y los de Datos Maestros está en `LINEAS_ANDON` (`build.py`). Las
  líneas sin loading (SMD, N/A…) cuentan fallas y downtime, pero no BDR ni MTBF.

### Actualizar con un CSV de ANDON

En `/kpi/` → *Actualizar datos*, subir el CSV "Reportes de mantenimiento" exportado de ANDON. Los reportes se combinan por
**Número**: los nuevos se agregan, los que cambiaron se actualizan (gana el de mayor estatus; con el mismo, el de mayor
tiempo) y **los que no vienen en el archivo se conservan**.

Lo subido se ve de inmediato en ese navegador. **Publicar** lo manda al servidor (pide `ANDON_CLAVE` si está definida),
que lo combina con lo que ya tiene y lo guarda en `DATA_DIR/andon.json`; todos lo ven al recargar. Si están
`GITHUB_TOKEN` y `GITHUB_REPO`, también lo guarda en `Maintenance 2026/andon.json` del repositorio (el token ya **no**
queda visible en la página). Después de una publicación así, hacer `git pull` antes de seguir trabajando en local.

## Publicar en Render

El sitio corre como *Web Service* con Docker: `Dockerfile` genera el sitio con Python desde los Excel y lo sirve con
Node (`server.js`, con gzip y caché larga para las fotos). No hace falta Docker Hub: Render construye la imagen del repo.

1. Subir esta carpeta a GitHub (rama `main`).
2. En Render: **New + → Blueprint** y elegir el repositorio (usa `render.yaml`). O **New + → Web Service → Docker**.
3. Capturar las variables: `GROQ_API_KEY` (gratis, console.groq.com) u opcionalmente `ANTHROPIC_API_KEY`, `ANDON_CLAVE`, y opcionalmente
   `GITHUB_TOKEN` (fine-grained, solo este repo, *Contents: Read and write*) + `GITHUB_REPO` (`usuario/repo`).
4. Cada push a `main` (por ejemplo, al actualizar un Excel) reconstruye y publica. Abrir `https://<servicio>.onrender.com/qr/`
   e imprimir los QR (la URL sale de `RENDER_EXTERNAL_URL`; para un dominio propio, definir `BASE_URL`).

**Persistencia de lo publicado**: el disco del plan gratis se borra en cada reinicio o deploy. Usar al menos una de:
`GITHUB_TOKEN` + `GITHUB_REPO` (gratis: cada publicación queda en el repo y el siguiente deploy ya la trae) o un disco
de Render montado en `/app/data` (plan de pago, ver `render.yaml`). El plan gratis además se duerme tras 15 min sin
visitas (la primera carga tarda ~1 min); el plan *Starter* lo evita.

Alternativa con Docker Hub: `docker build -t <usuario>/mantenimiento .`, `docker push`, y en Render *Deploy an existing
image*; pero entonces hay que reconstruir y subir la imagen a mano en cada cambio de Excel.

## Vista previa local

```
py -m pip install -r requirements.txt
npm install
py build.py
set GROQ_API_KEY=...   (opcional)
node server.js
```
Abrir http://localhost:10000. `py test_build.py` verifica el parseo de los 4 HPM, troubleshooting, KPIs, el buscador y el
servidor (requiere Node). GitHub Actions lo corre en cada push (`.github/workflows/pruebas.yml`).

## Agregar o cambiar estaciones

Copiar el Excel (mismo formato HPM) a `HPM/` y hacer push. El nombre de la ruta sale de la celda EQUIPO (K6).
