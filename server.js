// Servidor de Mantenimiento para Render: sirve el sitio que genera build.py (_site), el chatbot (/api/chat) y la
// publicación de reportes ANDON (/api/andon). Sin framework: el sitio es estático y las dos rutas caben aquí.
//   GROQ_API_KEY       chatbot gratis con Llama en Groq (GROQ_MODELO para cambiar el modelo)
//   ANTHROPIC_API_KEY  chatbot con Claude Haiku (si no hay Groq); sin ninguna responde el buscador local (asistente.js / andon.js)
//   DATA_DIR           carpeta donde se guarda andon.json publicado (en Render: disco persistente montado aquí)
//   ANDON_CLAVE        si existe, publicar pide esta clave
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

const SITE = path.join(__dirname, '_site');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ANDON_GUARDADO = path.join(DATA_DIR, 'andon.json');
const MODELO = 'claude-haiku-5-5';  // modelo ligero: rápido y barato para un chat de consulta
const leer = f => JSON.parse(fs.readFileSync(path.join(SITE, f), 'utf8'));

// ------------------------------------------------------------------ datos
const hpm = leer('hpm.json');
const lineas = leer('lineas.json');
const responderLocal = crear(hpm);
let D;  // { registros, M, consulta, json }
function usarRegistros(registros) {
  D = { registros, M: ANDON.crearModelo(registros, lineas), consulta: ANDON.crearConsulta(registros, lineas),
        json: zlib.gzipSync(JSON.stringify(registros)) };
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
- Si piden una gráfica, tendencia o comparación visual, llama a graficar_kpi (una vez por gráfica); la gráfica se muestra sola debajo de tu respuesta, así que solo coméntala en 1–2 líneas.
- Si no dicen periodo, usa el mes más reciente con datos. Si no dicen año, el año de los datos más recientes. Para nombres de línea o máquina que no conozcas exactamente, usa buscar_maquinas.
- Formato: texto plano, **negritas** y listas con "- ". Sin tablas ni encabezados.

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
      name: 'graficar_kpi', description: 'Genera una gráfica que se muestra al usuario. por=mes: tendencia mensual del periodo; por=linea/maquina/falla/turno: comparación del periodo (top 15).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['kpi', 'por', 'anio'], properties: { ...PERIODO,
        kpi: { type: 'string', enum: Object.keys(KPI) }, por: { type: 'string', enum: ['mes', ...Object.keys(POR)] },
        tipo: { type: 'string', enum: ['barras', 'linea'], description: 'Por defecto barras' } } },
      run: async i => {
        if (graficas.length >= 4) return 'Ya hay 4 gráficas en esta respuesta; no se generan más.';
        const f = filtro(i), [campo, nombre, unidad] = KPI[i.kpi];
        let etiquetas, datos;
        if (i.por === 'mes') {
          const meses = ANDON.MESES.map((_, k) => k + 1).filter(m => m >= (f.desde || 1) && m <= (f.hasta || 12) && M.hayDatos(f.anio, m));
          etiquetas = meses.map(m => ANDON.MESES[m - 1].slice(0, 3));
          datos = meses.map(m => r1(M.calcular({ ...f, mes: m, desde: null, hasta: null })[campo]));
        } else {
          const g = M.grupos(f, POR[i.por]).filter(x => x.fallas && x[campo] != null).sort((a, b) => b[campo] - a[campo]).slice(0, 15);
          etiquetas = g.map(x => x.nombre); datos = g.map(x => r1(x[campo]));
        }
        if (!datos.length) return `Sin datos para ${describir(f)}.`;
        const titulo = `${nombre}${unidad ? ` (${unidad})` : ''} por ${i.por} · ${describir(f)}`;
        graficas.push({ titulo, tipo: i.tipo === 'linea' ? 'line' : 'bar', horizontal: i.por !== 'mes', etiquetas, datos, unidad });
        return JSON.stringify({ grafica: titulo, etiquetas, datos });
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

const estado = contexto => `Datos ANDON: ${D.registros.length} reportes; años ${D.M.anios.join(', ')}; último reporte ${D.M.ultima}. ` +
  `Líneas de ANDON: ${D.M.lineasConDatos.join(' | ')}. Hoy es ${new Date().toISOString().slice(0, 10)}.` + contexto;

async function chatIA(mensajes, contexto) {
  const graficas = [];
  const final = await cliente.beta.messages.toolRunner({
    model: MODELO, max_tokens: 4096, max_iterations: 8,
    output_config: { effort: 'low' },
    // lo fijo (instrucciones + datos de estaciones) va en caché; lo que cambia, después
    system: [{ type: 'text', text: INSTRUCCIONES, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: estado(contexto) }],
    tools: herramientas(graficas).map(betaTool),
    messages: mensajes,
  });
  if (final.stop_reason === 'refusal') return { texto: 'No puedo responder esa pregunta. Pregunte sobre las estaciones o los indicadores de mantenimiento.', graficas };
  const texto = final.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { texto: texto || (graficas.length ? '' : 'No obtuve respuesta. Intente reformular la pregunta.'), graficas };
}

// ------------------------------------------------------------------ Groq (Llama, plan gratis)
// El plan gratis limita tokens por minuto y por día: el prompt va corto y el HPM se consulta con herramientas.
const GROQ_MODELOS = [process.env.GROQ_MODELO || 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const INSTRUCCIONES_GROQ = INSTRUCCIONES.slice(0, INSTRUCCIONES.indexOf('# DATOS DE LAS ESTACIONES')).replace(
  'Responde SOLO con la información de abajo (hojas HPM y troubleshooting de las estaciones DXD) o con lo que devuelvan las herramientas de indicadores.',
  'Responde SOLO con lo que devuelvan las herramientas: buscar_hpm y troubleshooting para las máquinas, kpi_* y graficar_kpi para indicadores. Llama una herramienta antes de responder.') +
  `\nEstaciones: ${hpm.estaciones.map(e => `${e.nombre} (id ${e.slug})`).join('; ')}.`;

async function chatGroq(mensajes, contexto, modelo) {
  const graficas = [], tools = herramientas(graficas, true);
  const msgs = [{ role: 'system', content: `${INSTRUCCIONES_GROQ}\n${estado(contexto)}` }, ...mensajes];
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelo, messages: msgs, temperature: 0.2, max_tokens: 1024, tool_choice: 'auto',
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }),
    });
    if (!r.ok) throw Object.assign(new Error((await r.text()).slice(0, 300)), { status: r.status });
    const m = (await r.json()).choices[0].message;
    if (!m.tool_calls || !m.tool_calls.length) return { texto: (m.content || '').trim(), graficas };
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
    for (const c of m.tool_calls) {
      const t = tools.find(x => x.name === c.function.name);
      let salida;
      try { salida = t ? await t.run(JSON.parse(c.function.arguments || '{}')) : `No existe la herramienta ${c.function.name}.`; }
      catch (e) { salida = `Error: ${e.message}`; }  // el modelo ve el error y corrige los argumentos
      msgs.push({ role: 'tool', tool_call_id: c.id, content: String(salida).slice(0, 6000) });
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
  // Groq: si el modelo grande llega a su límite gratis (429) o falla, prueba el chico; luego Claude; luego el buscador local
  if (process.env.GROQ_API_KEY) for (const modelo of GROQ_MODELOS) {
    try { return json(req, res, 200, await chatGroq(mensajes, contexto, modelo)); } catch (e) {
      console.error(`chat Groq ${modelo}:`, e.status || '', e.message);
    }
  }
  if (cliente) {
    try { return json(req, res, 200, await chatIA(mensajes, contexto)); } catch (e) {
      console.error('chat IA:', e.status || '', e.message);
    }
  }
  json(req, res, 200, { texto: chatLocal(mensajes.at(-1).content, estacion && estacion.slug), graficas: [], local: true });
}

// ------------------------------------------------------------------ rutas
const servidor = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/api/chat') return await chat(req, res);
    if (req.method === 'POST' && url === '/api/andon') return await publicar(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'Método no permitido' });
    if (url === '/salud') return json(req, res, 200, { ok: true, reportes: D.registros.length, ia: process.env.GROQ_API_KEY ? 'groq' : cliente ? 'claude' : 'local' });
    if (url === '/andon.json') return enviar(req, res, 200, 'application/json', Buffer.from(JSON.stringify(D.registros)), D.json, { 'Cache-Control': 'no-cache' });
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
  console.log(`Mantenimiento en :${process.env.PORT || 10000} · ${D.registros.length} reportes · chatbot ${process.env.GROQ_API_KEY ? 'Groq ' + GROQ_MODELOS[0] : cliente ? MODELO : 'local (sin GROQ_API_KEY ni ANTHROPIC_API_KEY)'}`));
module.exports = { herramientas };  // para test_build.py
