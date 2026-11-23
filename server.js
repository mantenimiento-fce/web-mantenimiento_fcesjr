// Servidor de Mantenimiento para Render: sirve el sitio que genera build.py (_site), el chatbot (/api/chat) y la
// publicación de reportes ANDON (/api/andon). Sin framework: el sitio es estático y las dos rutas caben aquí.
//   GEMINI_API_KEY     chatbot principal, gratis en Google AI Studio (GEMINI_MODELOS="a,b" para cambiar modelos)
//   GROQ_API_KEY       respaldo gratis en Groq (gpt-oss; GROQ_MODELOS="a,b" para cambiar modelos)
//   ANTHROPIC_API_KEY  chatbot con Claude Haiku (si no hay Groq); sin ninguna responde el buscador local (asistente.js / andon.js)
//   DATA_DIR           carpeta donde se guarda andon.json publicado (en Render: disco persistente montado aquí)
//   ANDON_CLAVE        si existe, publicar pide esta clave
//   ADMIN_CLAVE        clave para guardar desde /admin/ (si no existe se usa ANDON_CLAVE)
//   GITHUB_TOKEN + GITHUB_REPO  además guarda andon.json en el repositorio (sobrevive a redeploys sin disco)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk').default;
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
const ANDON = require('./templates/andon.js');
const { crear, valor } = require('./templates/asistente.js');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}  // claves locales (en Render van en el panel); .env no se sube a git

const SITE = path.join(__dirname, '_site');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ANDON_GUARDADO = path.join(DATA_DIR, 'andon.json');
const MODELO = 'claude-haiku-5-5';  // modelo ligero: rápido y barato para un chat de consulta
const leer = f => JSON.parse(fs.readFileSync(path.join(SITE, f), 'utf8'));

// ------------------------------------------------------------------ datos
const hpm = leer('hpm.json');
const lineas = leer('lineas.json');
const responderLocal = crear(hpm);
let D;  // { registros, M, consulta, json, tabla }
const respuestas = new Map();  // caché de respuestas de IA: pregunta (con historial y estación) -> respuesta; se vacía al publicar
function usarRegistros(registros) {
  const M = ANDON.crearModelo(registros, lineas);
  D = { registros, M, consulta: ANDON.crearConsulta(registros, lineas), json: zlib.gzipSync(JSON.stringify(registros)), tabla: tablaKpi(M) };
  respuestas.clear();
}

// KPIs ya calculados en el prompt: el modelo responde lo común sin adivinar filtros de herramientas
function tablaKpi(M) {
  const r = x => x == null ? '—' : Math.round(x * 100) / 100, fila = k => `${k.fallas} | ${r(k.paro)} | ${r(k.bdr)} | ${r(k.mttr)} | ${r(k.mtbf)}`;
  const t = ['# KPIs YA CALCULADOS (exactos; cópialos tal cual). Columnas: fallas | downtime min | BDR % | MTTR min | MTBF h'];
  for (const anio of M.anios.slice(-2)) {
    t.push(`## Planta (sin SMD) ${anio}, por mes`);
    for (const x of M.serie(anio).filter(x => x.conDatos)) t.push(`${ANDON.MESES[x.mes - 1]} ${anio}: ${fila(x)}`);
    t.push(`Año ${anio} completo: ${fila(M.calcular({ anio }))}`);
    t.push(`## Por línea, año ${anio} completo`);
    for (const x of M.grupos({ anio }, 'lin')) t.push(`${x.nombre}: ${fila(x)}`);
  }
  return t.join('\n');
}
{
  // lo publicado en el servidor se combina con lo de la imagen: ninguno de los dos pierde reportes
  let base = leer('andon.json');
  try { base = ANDON.combinar(base, JSON.parse(fs.readFileSync(ANDON_GUARDADO, 'utf8'))).registros; } catch (e) {
    if (e.code !== 'ENOENT') console.error('andon.json guardado ilegible, se usa el de la imagen:', e.message);
  }
  usarRegistros(base);
}

// ------------------------------------------------------------------ archivos estáticos
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const cache = new Map();  // ruta -> { cuerpo, gzip, tipo }: el sitio es inmutable mientras corre el contenedor
function archivo(url) {
  let rel = decodeURIComponent(url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(SITE, path.normalize(rel));
  if (!f.startsWith(SITE + path.sep)) return null;
  if (cache.has(f)) return cache.get(f);
  let cuerpo;
  try { cuerpo = fs.readFileSync(f); } catch { return null; }
  const tipo = TIPOS[path.extname(f)] || 'application/octet-stream';
  const r = { cuerpo, tipo, gzip: /text|json|svg/.test(tipo) ? zlib.gzipSync(cuerpo) : null, f };
  cache.set(f, r);
  return r;
}
function enviar(req, res, estado, tipo, cuerpo, gz, extra = {}) {
  const usaGzip = gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(estado, { 'Content-Type': tipo, 'Vary': 'Accept-Encoding', ...(usaGzip ? { 'Content-Encoding': 'gzip' } : {}), ...extra });
  res.end(usaGzip ? gz : cuerpo);
}
const json = (req, res, estado, obj) => { const b = Buffer.from(JSON.stringify(obj)); enviar(req, res, estado, 'application/json', b, null, { 'Cache-Control': 'no-store' }); };

function cuerpoJson(req, max) {
  return new Promise((ok, mal) => {
    const partes = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { mal(Object.assign(new Error('Demasiado grande'), { estado: 413 })); req.destroy(); } else partes.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { mal(Object.assign(new Error('JSON inválido'), { estado: 400 })); } });
    req.on('error', mal);
  });
}

// ------------------------------------------------------------------ publicar ANDON
const igual = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const esRegistro = r => r && Number.isInteger(r.id) && r.id > 0 && typeof r.ini === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.ini);

async function guardarEnGithub(pendientes) {
  const { GITHUB_TOKEN: token, GITHUB_REPO: repo, GITHUB_RUTA: ruta = 'Maintenance 2026/andon.json' } = process.env;
  if (!token || !repo) return false;
  const url = `https://api.github.com/repos/${repo}/contents/${ruta.split('/').map(encodeURIComponent).join('/')}`;
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mantenimiento-web' };
  for (let intento = 1; ; intento++) {
    // se parte de lo que hay en el repositorio en este momento: lo que otros publicaron se conserva
    const meta = await fetch(url + '?ref=main', { headers: h });
    if (!meta.ok && meta.status !== 404) throw new Error(`GitHub ${meta.status}`);
    const sha = meta.ok ? (await meta.json()).sha : undefined;
    const remotos = sha ? await (await fetch(url + '?ref=main', { headers: { ...h, Accept: 'application/vnd.github.raw+json' } })).json() : [];
    const todo = ANDON.combinar(remotos, pendientes).registros;
    const r = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({
      message: `ANDON: ${pendientes.length} reportes nuevos o actualizados desde el dashboard`,
      content: Buffer.from(JSON.stringify(todo)).toString('base64'), branch: 'main', sha }) });
    if (r.ok) return true;
    if ((r.status === 409 || r.status === 422) && intento < 3) continue;  // alguien publicó al mismo tiempo
    throw new Error(`GitHub ${r.status}`);
  }
}

async function publicar(req, res) {
  if (process.env.ANDON_CLAVE && !igual(req.headers['x-clave'], process.env.ANDON_CLAVE)) return json(req, res, 401, { error: 'Clave de publicación incorrecta.' });
  const pendientes = await cuerpoJson(req, 30e6);
  if (!Array.isArray(pendientes) || !pendientes.length || !pendientes.every(esRegistro)) return json(req, res, 400, { error: 'Los datos no son reportes de ANDON válidos.' });
  const registros = ANDON.combinar(D.registros, pendientes).registros;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ANDON_GUARDADO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registros));
  fs.renameSync(tmp, ANDON_GUARDADO);  // atómico: un corte a la mitad no deja el archivo roto
  usarRegistros(registros);
  let github = false, aviso = null;
  try { github = await guardarEnGithub(pendientes); } catch (e) { aviso = `Guardado en el servidor, pero no en GitHub (${e.message}).`; }
  json(req, res, 200, { ok: true, total: registros.length, github, aviso });
}

// ------------------------------------------------------------------ administrador (/admin/): estaciones, HPM y troubleshooting
// Lo editado se guarda en DATA_DIR y en estaciones_admin.json del repositorio (GitHub): ese commit hace que Render
// reconstruya el sitio (páginas, chat y QR) con build.py, que aplica las ediciones encima de los Excel.
const ADMIN_GUARDADO = path.join(DATA_DIR, 'estaciones_admin.json');
const CAMPOS_PASO = ['n', 'punto', 'metodo', 'norma', 'contramedida', 'hta', 'material', 'tiempo', 'frec', 'hora'];
const leerAdmin = () => { try { return JSON.parse(fs.readFileSync(ADMIN_GUARDADO, 'utf8')); } catch { return {}; } };
const texto = (v, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const arreglo = v => Array.isArray(v) ? v : [];
const ids = (v, re) => arreglo(v).filter(x => typeof x === 'string' && re.test(x)).slice(0, 50);
const FIG = /^[0-9a-f]{10}$/, FOTO = /^[0-9a-f]{16}\.jpg$/;  // imagen del Excel (build.py fig_id) / foto subida
const FOTOS_ADMIN = path.join(DATA_DIR, 'fotos_admin');
function limpiarEstacion(e) {  // solo los campos que usa build.py, todo como texto
  if (!e || typeof e !== 'object' || !texto(e.nombre, 120)) return null;
  return { nombre: texto(e.nombre, 120),
    secciones: arreglo(e.secciones).map(s => ({ nombre: texto(s?.nombre, 300),
      pasos: arreglo(s?.pasos).map(p => ({ ...Object.fromEntries(CAMPOS_PASO.map(k => [k, texto(p?.[k])])),
        fig_ids: ids(p?.fig_ids, FIG), fotos: ids(p?.fotos, FOTO) })) })),
    efectos: arreglo(e.efectos).map(x => ({ efecto: texto(x?.efecto, 500), categoria: texto(x?.categoria, 100),
      causas: arreglo(x?.causas).map(c => texto(c, 500)).filter(Boolean), fotos: ids(x?.fotos, FOTO) })).filter(x => x.efecto) };
}

// foto ya reducida en el navegador (JPG): se guarda en DATA_DIR y en fotos_admin/ del repositorio sin disparar un deploy;
// el commit de "Guardar cambios" es el que reconstruye el sitio con ella
async function subirFoto(req, res) {
  const clave = process.env.ADMIN_CLAVE || process.env.ANDON_CLAVE;
  if (clave && !igual(req.headers['x-clave'], clave)) return json(req, res, 401, { error: 'Clave incorrecta.' });
  const { jpg } = await cuerpoJson(req, 6e6) || {};
  const datos = typeof jpg === 'string' ? Buffer.from(jpg, 'base64') : Buffer.alloc(0);
  if (datos.length < 100 || datos[0] !== 0xff || datos[1] !== 0xd8 || datos[2] !== 0xff) return json(req, res, 400, { error: 'La foto no es un JPG válido.' });
  const nombre = crypto.createHash('sha1').update(datos).digest('hex').slice(0, 16) + '.jpg';
  fs.mkdirSync(FOTOS_ADMIN, { recursive: true });
  fs.writeFileSync(path.join(FOTOS_ADMIN, nombre), datos);
  const { GITHUB_TOKEN: token, GITHUB_REPO: repo } = process.env;
  let aviso = null;
  if (token && repo) try {
    const url = `https://api.github.com/repos/${repo}/contents/fotos_admin/${nombre}`;
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mantenimiento-web' };
    if ((await fetch(url + '?ref=main', { headers: h })).status === 404) {  // mismo nombre = misma foto: ya está
      const r = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({
        message: `Admin: foto ${nombre} [skip render] [skip ci]`, content: datos.toString('base64'), branch: 'main' }) });
      if (!r.ok && r.status !== 422) throw new Error(`GitHub ${r.status}`);
    }
  } catch (e) { aviso = `Foto guardada en el servidor, pero no en GitHub (${e.message}).`; }
  json(req, res, 200, { ok: true, nombre, aviso });
}

async function guardarAdminEnGithub(cambios) {
  const { GITHUB_TOKEN: token, GITHUB_REPO: repo } = process.env;
  if (!token || !repo) return false;
  const url = `https://api.github.com/repos/${repo}/contents/estaciones_admin.json`;
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mantenimiento-web' };
  for (let intento = 1; ; intento++) {
    const meta = await fetch(url + '?ref=main', { headers: h });
    if (!meta.ok && meta.status !== 404) throw new Error(`GitHub ${meta.status}`);
    const sha = meta.ok ? (await meta.json()).sha : undefined;
    const remoto = sha ? await (await fetch(url + '?ref=main', { headers: { ...h, Accept: 'application/vnd.github.raw+json' } })).json() : {};
    const r = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({
      message: `Admin: ${Object.values(cambios).map(e => e.nombre).join(', ')} actualizado desde /admin/`,
      content: Buffer.from(JSON.stringify({ ...remoto, ...cambios }, null, 1)).toString('base64'), branch: 'main', sha }) });
    if (r.ok) return true;
    if ((r.status === 409 || r.status === 422) && intento < 3) continue;
    throw new Error(`GitHub ${r.status}`);
  }
}

async function guardarAdmin(req, res) {
  const clave = process.env.ADMIN_CLAVE || process.env.ANDON_CLAVE;
  if (clave && !igual(req.headers['x-clave'], clave)) return json(req, res, 401, { error: 'Clave incorrecta.' });
  const cuerpo = await cuerpoJson(req, 10e6);
  const cambios = {};
  for (const [slug, e] of Object.entries(cuerpo && typeof cuerpo === 'object' ? cuerpo : {})) {
    const limpia = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && limpiarEstacion(e);
    if (!limpia) return json(req, res, 400, { error: `Datos inválidos en la estación "${slug}" (falta el nombre).` });
    cambios[slug] = limpia;
  }
  if (!Object.keys(cambios).length) return json(req, res, 400, { error: 'No hay cambios.' });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_GUARDADO + '.tmp', JSON.stringify({ ...leerAdmin(), ...cambios }));
  fs.renameSync(ADMIN_GUARDADO + '.tmp', ADMIN_GUARDADO);
  let github = false, aviso = null;
  try { github = await guardarAdminEnGithub(cambios); } catch (e) { aviso = `Guardado en el servidor, pero no en GitHub (${e.message}).`; }
  json(req, res, 200, { ok: true, github, aviso });
}

// ------------------------------------------------------------------ chatbot
const r1 = x => x == null ? null : Math.round(x * 100) / 100;

// HPM + troubleshooting completos en texto compacto: el modelo responde cualquier pregunta sobre las máquinas sin buscar
const CONOCIMIENTO = (() => {
  const t = [`LEYENDA HPM: ${hpm.leyenda}`, 'FRECUENCIA está en semanas (13 = cada 13 semanas).'];
  for (const e of hpm.estaciones) {
    t.push(`\n## ESTACIÓN: ${e.nombre} (id: ${e.slug})\n### Hoja HPM (mantenimiento preventivo)`);
    let sec = '';
    for (const p of hpm.pasos.filter(p => p.e === e.slug)) {
      if (p.sec !== sec) t.push(`[${sec = p.sec}]`);
      t.push(`Paso ${p.n}. ${p.punto} | Método: ${valor(p, 'metodo')} | Norma: ${valor(p, 'norma')} | Contramedida: ${valor(p, 'contramedida')} | ` +
             `Herramienta: ${valor(p, 'hta')} | Material: ${valor(p, 'material')} | Tiempo: ${valor(p, 'tiempo')} | Frecuencia: ${valor(p, 'frec')} | ${valor(p, 'hora')}`);
    }
    t.push('### Troubleshooting (efecto de falla -> posibles causas, de la matriz causa-efecto)');
    for (const f of hpm.fallas.filter(f => f.e === e.slug)) t.push(`Efecto ${f.n} [${f.categoria}] ${f.efecto} -> ${f.causas.join('; ') || 'sin causas'}`);
  }
  return t.join('\n');
})();

const INSTRUCCIONES = `Eres el asistente del departamento de Mantenimiento (planta FORVIA). Hablas español de México, claro y breve: lo leen técnicos en el celular frente a la máquina.
Responde SOLO con la información de abajo (hojas HPM y troubleshooting de las estaciones DXD) o con lo que devuelvan las herramientas de indicadores. Si algo no está en los datos, dilo; no inventes valores, pasos ni causas.
- Al citar un punto del HPM di la estación y el número de paso. Para fallas, lista las posibles causas en orden.
- Indicadores (BDR, MTTR, MTBF, fallas, downtime, espera del técnico) salen de reportes ANDON: usa siempre las herramientas, nunca calcules de memoria. BDR = downtime ÷ loading × 100 (%); MTTR = downtime ÷ fallas (min); MTBF = (loading − downtime) ÷ fallas ÷ 60 (h).
- Si piden graficar, una gráfica, tendencia o comparación visual, SIEMPRE llama a graficar_kpi (una vez por gráfica); solo hace barras, igual que el dashboard. La gráfica se muestra sola debajo de tu respuesta: coméntala en 1–2 líneas. Nunca dibujes gráficas con texto, símbolos ni tablas, ni ofrezcas otro tipo (dispersión, pastel, líneas).
- Cifras: copia los valores EXACTAMENTE como los devuelve la herramienta. No redondees, no uses "aprox.", "~" ni "≈", no calcules promedios, porcentajes ni totales propios, y no completes meses o líneas sin datos. Un mes con 0 fallas es "sin registros".
- Si no dicen periodo, usa el mes más reciente con datos. Si no dicen año, el año de los datos más recientes. Para nombres de línea o máquina que no conozcas exactamente, usa buscar_maquinas.
- Si la sección KPIS YA CALCULADOS tiene el dato exacto (planta por mes o año, línea por año), úsalo sin llamar herramientas. Para otro filtro (línea en un mes, máquina, ranking, rango) usa las herramientas.
- La sección INTERPRETACIÓN dice qué periodo y línea detectó el sistema en la pregunta: úsala para los argumentos salvo que el usuario diga otra cosa.
- Números con punto decimal (15.42), nunca coma decimal.
- Formato: texto plano, **negritas** y listas con "- ". Sin tablas, encabezados, cursivas, JSON ni bloques de código.

# EJEMPLOS (pregunta -> qué hacer)
- "grafica el mttr de honda este año" -> graficar_kpi {kpi:"mttr", por:"mes", anio:<año>, linea:"Honda 25SA"}
- "qué línea tuvo más fallas en octubre" -> kpi_ranking {por:"linea", anio:<año>, mes_desde:10, mes_hasta:10, orden:"fallas"}
- "bdr de la planta en enero" -> si está en KPIS YA CALCULADOS, cítalo; si no, kpi_resumen {anio:<año>, mes_desde:1, mes_hasta:1}
- "compara las líneas por downtime" -> graficar_kpi {kpi:"downtime", por:"linea", anio:<año>}

# DATOS DE LAS ESTACIONES
${CONOCIMIENTO}`;

const PERIODO = {
  anio: { type: 'integer', description: 'Año, ej. 2026' },
  mes_desde: { type: 'integer', minimum: 1, maximum: 12, description: 'Primer mes del periodo (1-12). Omitir = desde enero' },
  mes_hasta: { type: 'integer', minimum: 1, maximum: 12, description: 'Último mes del periodo (1-12). Para un solo mes, igual a mes_desde' },
  linea: { type: 'string', description: 'Línea exacta de ANDON (ver lista). Omitir = toda la planta' },
  maquina: { type: 'string', description: 'Máquina exacta de ANDON (usar buscar_maquinas)' },
};
const filtro = i => {
  const num = v => v == null || v === '' ? null : +v || null;
  const desde = num(i.mes_desde), hasta = num(i.mes_hasta);
  return { anio: num(i.anio) || +D.M.ultima.slice(0, 4), mes: desde && desde === hasta ? desde : null, desde, hasta, linea: i.linea || null, maq: i.maquina || null };
};
const describir = f => `${f.mes ? ANDON.MESES[f.mes - 1] : f.desde || f.hasta ? `${ANDON.MESES[(f.desde || 1) - 1]}–${ANDON.MESES[(f.hasta || 12) - 1]}` : 'Año'} ${f.anio}` +
  (f.linea ? ` · ${f.linea}` : '') + (f.maq ? ` · ${f.maq}` : '');
const resumen = k => ({ fallas: k.fallas, downtime_min: r1(k.paro), espera_tecnico_min: r1(k.loc), loading_min: r1(k.loading),
  bdr_pct: r1(k.bdr), mttr_min: r1(k.mttr), mtbf_h: r1(k.mtbf) });
const KPI = { bdr: ['bdr', 'BDR', '%'], mttr: ['mttr', 'MTTR', 'min'], mtbf: ['mtbf', 'MTBF', 'h'], fallas: ['fallas', 'Fallas', ''],
              downtime: ['paro', 'Downtime', 'min'], espera: ['loc', 'Espera del técnico', 'min'] };
const POR = { linea: 'lin', maquina: 'maq', falla: 'falla', turno: 'turno' };

// conHpm: para modelos con poco contexto (Groq gratis), el HPM y el troubleshooting se buscan en vez de ir en el prompt
function herramientas(graficas, conHpm) {
  const { M } = D;
  const nombre = s => (hpm.estaciones.find(e => e.slug === s) || {}).nombre || s;
  const ESTACION = { type: 'string', enum: hpm.estaciones.map(e => e.slug), description: 'id de la estación' };
  const lista = [
    {
      name: 'kpi_resumen', description: 'Indicadores (fallas, downtime, espera del técnico, loading, BDR, MTTR, MTBF) de un periodo, opcionalmente de una línea o máquina.',
      inputSchema: { type: 'object', properties: PERIODO, required: ['anio'], additionalProperties: false },
      run: async i => { const f = filtro(i); return JSON.stringify({ periodo: describir(f), ...resumen(M.calcular(f)) }); },
    },
    {
      name: 'kpi_ranking', description: 'Ranking de líneas, máquinas, tipos de falla o turnos en un periodo, ordenado por número de fallas o por downtime.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['anio', 'por'], properties: { ...PERIODO,
        por: { type: 'string', enum: Object.keys(POR) }, orden: { type: 'string', enum: ['fallas', 'downtime'] },
        limite: { type: 'integer', minimum: 1, maximum: 30 } } },
      run: async i => {
        const f = filtro(i), g = M.grupos(f, POR[i.por]).filter(x => x.fallas);
        if (i.orden !== 'downtime') g.sort((a, b) => b.fallas - a.fallas);
        return JSON.stringify({ periodo: describir(f), total: g.length, filas: g.slice(0, i.limite || 10).map(x => ({ nombre: x.nombre, linea: x.lin, ...resumen(x) })) });
      },
    },
    {
      name: 'buscar_maquinas', description: 'Busca nombres exactos de máquinas registradas en ANDON por texto y/o línea.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { texto: { type: 'string' }, linea: { type: 'string' } } },
      run: async i => {
        const n = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(), q = n(i.texto || '');
        const m = M.maquinas(i.linea || null).filter(x => n(x).includes(q));
        return JSON.stringify({ total: m.length, maquinas: m.slice(0, 60) });
      },
    },
    {
      name: 'graficar_kpi', description: 'Genera la gráfica de barras (la misma del dashboard) que se muestra al usuario. por=mes: barras por mes del periodo; por=linea/maquina/falla/turno: barras horizontales del periodo (top 15). Valores reales de ANDON.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['kpi', 'por', 'anio'], properties: { ...PERIODO,
        kpi: { type: 'string', enum: Object.keys(KPI) }, por: { type: 'string', enum: ['mes', ...Object.keys(POR)] } } },
      run: async i => {
        if (graficas.length >= 4) return 'Ya hay 4 gráficas en esta respuesta; no se generan más.';
        const f = filtro(i), [campo, nombre, unidad] = KPI[i.kpi];
        let etiquetas, datos;
        if (i.por === 'mes') {  // solo meses con registros de la selección (un mes con 1 reporte cuenta como sin registros)
          const filas = ANDON.MESES.map((_, k) => ({ m: k + 1, k: M.calcular({ ...f, mes: k + 1, desde: null, hasta: null }) }))
            .filter(x => x.m >= (f.desde || 1) && x.m <= (f.hasta || 12) && x.k.fallas && x.k[campo] != null);
          etiquetas = filas.map(x => ANDON.MESES[x.m - 1].slice(0, 3));
          datos = filas.map(x => r1(x.k[campo]));
        } else {
          const g = M.grupos(f, POR[i.por]).filter(x => x.fallas && x[campo] != null).sort((a, b) => b[campo] - a[campo]).slice(0, 15);
          etiquetas = g.map(x => x.nombre); datos = g.map(x => r1(x[campo]));
        }
        if (!datos.length) return `Sin datos para ${describir(f)}.`;
        const titulo = `${nombre}${unidad ? ` (${unidad})` : ''} por ${i.por} · ${describir(f)}`;
        graficas.push({ titulo, tipo: 'bar', horizontal: i.por !== 'mes', etiquetas, datos, unidad });
        return `Gráfica de barras «${titulo}» lista: el usuario ya la ve. Coméntala en 1–2 líneas; si citas un valor, cópialo exacto de aquí: ${etiquetas.map((e, k) => `${e} ${datos[k]}`).join(", ")}`;
      },
    },
  ];
  if (conHpm) lista.push(
    {
      name: 'buscar_hpm', description: 'Busca en las hojas HPM (mantenimiento preventivo: qué revisar, norma, contramedida, herramienta, material, tiempo, frecuencia) y en troubleshooting (fallas y sus causas). Pasar la pregunta del usuario tal cual.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['pregunta'], properties: { pregunta: { type: 'string' }, estacion: ESTACION } },
      run: async i => {
        const r = responderLocal(String(i.pregunta || ''), i.estacion || undefined);
        if (!r) return 'Sin resultados.';
        return JSON.stringify({ nota: r.texto, valores: r.valores,
          pasos: (r.pasos || []).slice(0, 8).map(p => ({ estacion: nombre(p.e), paso: p.n, seccion: p.sec, punto: p.punto, norma: valor(p, 'norma'),
            contramedida: valor(p, 'contramedida'), herramienta: valor(p, 'hta'), material: valor(p, 'material'), tiempo: valor(p, 'tiempo'),
            frecuencia: valor(p, 'frec'), condicion: valor(p, 'hora') })),
          fallas: (r.fallas || []).map(f => ({ estacion: nombre(f.e), efecto: f.efecto, causas: f.causas })) });
      },
    },
    {
      name: 'troubleshooting', description: 'Sin efecto: lista los efectos de falla de una estación. Con efecto: las posibles causas de los efectos que coinciden.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['estacion'], properties: { estacion: ESTACION, efecto: { type: 'string' } } },
      run: async i => {
        const n = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const deEstacion = hpm.fallas.filter(f => f.e === i.estacion);
        if (!i.efecto) return JSON.stringify(deEstacion.map(f => `${f.n}. [${f.categoria}] ${f.efecto}`));
        const palabras = n(i.efecto).split(/\W+/).filter(w => w.length > 2);
        const hits = deEstacion.filter(f => palabras.some(w => n(f.efecto).includes(w)));
        return JSON.stringify((hits.length ? hits : deEstacion).slice(0, 6).map(f => ({ efecto: f.efecto, causas: f.causas })));
      },
    });
  return lista;
}

const cliente = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;

// interpretación de la pregunta hecha por el sistema (no se toca el mensaje del usuario)
function interpretar(pregunta) {
  if (!ANDON.esKpi(pregunta) && !GRAFICA_RE.test(ANDON_NORM(pregunta))) return '';
  const f = D.consulta.entender(pregunta);
  return `\n# INTERPRETACIÓN\nPeriodo: ${f.mes ? `${ANDON.MESES[f.mes - 1]} ${f.anio} (mes_desde=mes_hasta=${f.mes})` : `año ${f.anio} completo`}; ` +
    `línea: ${f.linea || 'no nombrada (toda la planta, salvo que el historial diga otra)'}.`;
}
const estado = (contexto, pregunta = '') => `Datos ANDON: ${D.registros.length} reportes; años ${D.M.anios.join(', ')}; último reporte ${D.M.ultima}. ` +
  `Líneas de ANDON: ${D.M.lineasConDatos.join(' | ')}. Hoy es ${new Date().toISOString().slice(0, 10)}.` + contexto +
  `\n${D.tabla}${interpretar(pregunta)}`;

// cifras de la respuesta que no aparecen en ninguna fuente (prompt, herramientas, mensajes). Ignora enteros ≤ 31 (días, pasos, meses).
const numeros = s => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(x => +x.replace(/,/g, '')).filter(Number.isFinite);
function cifrasSinFuente(texto, fuentes) {
  const ok = new Set(numeros(fuentes.join('\n')));
  return [...new Set(numeros(texto).filter(n => !(Number.isInteger(n) && n <= 31) && !ok.has(n)))];
}

async function chatIA(mensajes, contexto) {
  const graficas = [];
  const final = await cliente.beta.messages.toolRunner({
    model: MODELO, max_tokens: 4096, max_iterations: 8,
    output_config: { effort: 'low' },
    // lo fijo (instrucciones + datos de estaciones) va en caché; lo que cambia, después
    system: [{ type: 'text', text: INSTRUCCIONES, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: estado(contexto, mensajes.at(-1).content) }],
    tools: herramientas(graficas).map(betaTool),
    messages: mensajes,
  });
  if (final.stop_reason === 'refusal') return { texto: 'No puedo responder esa pregunta. Pregunte sobre las estaciones o los indicadores de mantenimiento.', graficas };
  const texto = final.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { texto: texto || (graficas.length ? '' : 'No obtuve respuesta. Intente reformular la pregunta.'), graficas };
}

// ------------------------------------------------------------------ Gemini y Groq (planes gratis, API compatible con OpenAI)
// Los planes gratis limitan tokens por minuto y por día: el prompt va corto y el HPM se consulta con herramientas.
// Los modelos se cambian sin tocar código: GEMINI_MODELOS="a,b", GROQ_MODELOS="a,b". Los alias *-latest de Gemini no se retiran.
const lista = (v, def) => (v || def).split(',').map(s => s.trim()).filter(Boolean);
const PROVEEDORES = [
  { nombre: 'Gemini', clave: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelos: lista(process.env.GEMINI_MODELOS, 'gemini-flash-lite-latest,gemini-flash-latest'), extra: { max_tokens: 4096, reasoning_effort: 'low' } },
  { nombre: 'Groq', clave: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions',
    modelos: lista(process.env.GROQ_MODELOS || process.env.GROQ_MODELO, 'openai/gpt-oss-120b,openai/gpt-oss-20b'), extra: { max_tokens: 1024 } },
];
const INSTRUCCIONES_CORTAS = INSTRUCCIONES.slice(0, INSTRUCCIONES.indexOf('# DATOS DE LAS ESTACIONES')).replace(
  'Responde SOLO con la información de abajo (hojas HPM y troubleshooting de las estaciones DXD) o con lo que devuelvan las herramientas de indicadores.',
  'Responde SOLO con lo que devuelvan las herramientas (buscar_hpm y troubleshooting para las máquinas, kpi_* y graficar_kpi para indicadores) o con la sección KPIS YA CALCULADOS. Para máquinas llama una herramienta antes de responder.') +
  `\nEstaciones: ${hpm.estaciones.map(e => `${e.nombre} (id ${e.slug})`).join('; ')}.`;

const ANDON_NORM = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const GRAFICA_RE = /\bgrafic|\bchart\b|\bgrafo\b|\bvisualiz|\bbarras?\b/;

async function chatCompatible(p, modelo, mensajes, contexto) {
  const graficas = [], tools = herramientas(graficas, true), pregunta = mensajes.at(-1).content;
  const msgs = [{ role: 'system', content: `${INSTRUCCIONES_CORTAS}\n${estado(contexto, pregunta)}` }, ...mensajes];
  const fuentes = msgs.map(m => m.content);  // todo lo que el modelo puede citar; se suman las salidas de herramientas
  // si piden gráfica, la primera vuelta obliga a graficar_kpi: el modelo a veces solo describe los datos
  const pideGrafica = GRAFICA_RE.test(ANDON_NORM(pregunta));
  let corregido = false;
  for (let vuelta = 0; vuelta < 7; vuelta++) {
    const forzar = pideGrafica && vuelta === 0;
    const r = await fetch(p.url, {
      signal: AbortSignal.timeout(30e3),  // un modelo saturado puede colgarse: se pasa al siguiente
      method: 'POST', headers: { Authorization: `Bearer ${process.env[p.clave]}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelo, messages: msgs, temperature: 0, ...p.extra,
        tool_choice: forzar ? { type: 'function', function: { name: 'graficar_kpi' } } : 'auto',
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }),
    });
    if (!r.ok) throw Object.assign(new Error((await r.text()).slice(0, 300)), { status: r.status });
    const m = (await r.json()).choices[0].message;
    if (!m.tool_calls || !m.tool_calls.length) {
      const texto = (m.content || '').trim(), malas = cifrasSinFuente(texto, fuentes);
      if (!malas.length) return { texto, graficas };
      // una cifra que no sale de los datos: se le pide corregir una vez; si insiste, responde el siguiente proveedor
      if (corregido) throw new Error(`cifras sin fuente: ${malas.join(', ')}`);
      corregido = true;
      msgs.push({ role: 'assistant', content: texto }, { role: 'user', content: `[Sistema, no el usuario] Estas cifras no salen de los datos: ${malas.join(', ')}. ` +
        'Reescribe la respuesta usando solo valores exactos de KPIS YA CALCULADOS o de las herramientas (llama una si hace falta), sin redondear. No menciones esta corrección.' });
      continue;
    }
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });  // tal cual: Gemini exige su thought_signature
    for (const c of m.tool_calls) {
      const t = tools.find(x => x.name === c.function.name);
      let salida;
      try { salida = t ? await t.run(JSON.parse(c.function.arguments || '{}')) : `No existe la herramienta ${c.function.name}.`; }
      catch (e) { salida = `Error: ${e.message}`; }  // el modelo ve el error y corrige los argumentos
      salida = String(salida).slice(0, 6000);
      fuentes.push(salida);
      msgs.push({ role: 'tool', tool_call_id: c.id, content: salida });
    }
  }
  return { texto: 'No terminé la consulta. Intente una pregunta más concreta.', graficas };
}

// sin API key (o si falla): el buscador que ya tenía el sitio, en texto
function chatLocal(pregunta, estacion) {
  if (ANDON.esKpi(pregunta)) {
    const r = D.consulta(pregunta);
    return r ? [r.texto, ...(r.valores || []).map(v => `- ${v[0]}`)].join('\n') : 'Pregunte por BDR, MTTR, MTBF o fallas, con mes y línea.';
  }
  const r = responderLocal(pregunta, estacion);
  if (!r) return 'Escriba una pregunta.';
  const nombre = s => hpm.estaciones.find(e => e.slug === s).nombre;
  const t = [r.texto].filter(Boolean);
  for (const [v, n] of r.valores || []) t.push(`- ${n ? `${v} (${n})` : v}`);
  for (const p of r.pasos || []) t.push(`- **Paso ${p.n}** (${nombre(p.e)}): ${p.punto}. ${r.campos.map(c => `${c}: ${valor(p, c)}`).join(' · ')}`);
  if ((r.fallas || []).length) t.push('**Troubleshooting**');
  for (const f of r.fallas || []) t.push(`- **${f.efecto}** (${nombre(f.e)}): ${f.causas.join('; ')}`);
  return t.join('\n');
}

const visitas = new Map();  // ip -> [marcas de tiempo]: tope de preguntas para que nadie gaste la API sin límite
function permitido(ip) {
  const ahora = Date.now(), v = (visitas.get(ip) || []).filter(t => ahora - t < 600e3);
  v.push(ahora); visitas.set(ip, v);
  if (visitas.size > 5000) visitas.clear();
  return v.length <= 40;
}

async function chat(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!permitido(ip)) return json(req, res, 429, { error: 'Demasiadas preguntas seguidas. Espere unos minutos.' });
  const b = await cuerpoJson(req, 100e3);
  const mensajes = (Array.isArray(b.mensajes) ? b.mensajes : []).slice(-12)
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (mensajes.length && mensajes[0].role !== 'user') mensajes.shift();
  if (!mensajes.length || mensajes.at(-1).role !== 'user') return json(req, res, 400, { error: 'Falta la pregunta.' });
  const estacion = hpm.estaciones.find(e => e.slug === b.estacion);
  const contexto = estacion ? ` El usuario está en la página de la estación ${estacion.nombre}: si no nombra otra, la pregunta es sobre esa.` : '';
  // misma pregunta, mismo historial, misma estación y mismos datos: misma respuesta, sin gastar cuota
  const llave = JSON.stringify([estacion && estacion.slug, mensajes]);
  if (respuestas.has(llave)) return json(req, res, 200, respuestas.get(llave));
  const guardar = r => { if (respuestas.size >= 300) respuestas.delete(respuestas.keys().next().value); respuestas.set(llave, r); return json(req, res, 200, r); };
  // Gemini (principal) -> Groq: si un modelo llega a su límite gratis (429), está saturado (503) o falla, prueba el siguiente;
  // luego Claude; luego el buscador local
  const fallos = [];  // motivo corto (estado + código del proveedor) para verlo en el chat sin abrir los logs
  const fallo = (quien, e) => {
    console.error(`chat ${quien}:`, e.status || '', e.message);
    let codigo = '';
    try { const x = JSON.parse(e.message).error; codigo = x.code || x.type || ''; } catch { codigo = e.status ? '' : e.message.slice(0, 80); }
    fallos.push(`${quien} ${e.status || ''} ${codigo}`.replace(/\s+/g, ' ').trim());
  };
  for (const p of PROVEEDORES.filter(p => process.env[p.clave])) for (const modelo of p.modelos) {
    try { return guardar(await chatCompatible(p, modelo, mensajes, contexto)); } catch (e) { fallo(modelo, e); }
  }
  if (cliente) {
    try { return guardar(await chatIA(mensajes, contexto)); } catch (e) { fallo('Claude', e); }
  }
  json(req, res, 200, { texto: chatLocal(mensajes.at(-1).content, estacion && estacion.slug), graficas: [], local: true, motivo: fallos.join(' · ') });
}

const iaActiva = () => [...PROVEEDORES.filter(p => process.env[p.clave]).map(p => `${p.nombre} ${p.modelos[0]}`), cliente && MODELO, 'local'].filter(Boolean).join(' -> ');

// ------------------------------------------------------------------ rutas
const servidor = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/api/chat') return await chat(req, res);
    if (req.method === 'POST' && url === '/api/andon') return await publicar(req, res);
    if (req.method === 'POST' && url === '/api/admin') return await guardarAdmin(req, res);
    if (req.method === 'POST' && url === '/api/admin/foto') return await subirFoto(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'Método no permitido' });
    if (url === '/salud') return json(req, res, 200, { ok: true, reportes: D.registros.length, ia: iaActiva() });
    if (url === '/andon.json') return enviar(req, res, 200, 'application/json', Buffer.from(JSON.stringify(D.registros)), D.json, { 'Cache-Control': 'no-cache' });
    // lo guardado desde /admin/ antes de que el sitio se reconstruya también se ve al volver a abrir el editor
    if (url === '/admin/datos.json') {
      const d = JSON.parse(archivo(url).cuerpo);
      for (const [slug, e] of Object.entries(leerAdmin())) d[slug] = { ...d[slug], ...e };  // conserva las figuras del Excel para verlas
      return json(req, res, 200, d);
    }
    const subida = url.startsWith('/fotos/') && FOTO.test(url.slice(7)) && path.join(FOTOS_ADMIN, url.slice(7));
    if (subida && !archivo(url) && fs.existsSync(subida)) return enviar(req, res, 200, 'image/jpeg', fs.readFileSync(subida), null, { 'Cache-Control': 'public, max-age=31536000, immutable' });
    const a = archivo(url);
    if (!a && !path.extname(url)) {  // /estacion/x sin diagonal final -> /estacion/x/
      if (archivo(url + '/')) { res.writeHead(301, { Location: url + '/' }); return res.end(); }
    }
    if (!a) return enviar(req, res, 404, 'text/html; charset=utf-8', archivo('/404.html')?.cuerpo || Buffer.from('No encontrado'));
    // fotos con nombre = hash del contenido: inmutables; lo demás se revalida
    const cacheCtl = url.startsWith('/fotos/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
    enviar(req, res, 200, a.tipo, a.cuerpo, a.gzip, { 'Cache-Control': cacheCtl });
  } catch (e) {
    if (!res.headersSent) json(req, res, e.estado || 500, { error: e.estado ? e.message : 'Error del servidor' });
    if (!e.estado) console.error(e);
  }
});
if (require.main === module) servidor.listen(process.env.PORT || 10000, () =>
  console.log(`Mantenimiento en :${process.env.PORT || 10000} · ${D.registros.length} reportes · chatbot ${iaActiva()}`));
module.exports = { herramientas, cifrasSinFuente, estado, chatCompatible, PROVEEDORES };  // para test_build.py
