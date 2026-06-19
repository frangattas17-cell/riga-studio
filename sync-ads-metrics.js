// =============================================================================
// sync-ads-metrics.js — Riga Studio
// Sincroniza métricas de Meta Ads y Google Ads en Firestore
// =============================================================================
//
// ─── REQUISITOS ──────────────────────────────────────────────────────────────
//
//   1. Node.js 18+ instalado
//   2. Instalar dependencias:
//        npm install firebase-admin
//   3. Crear una Service Account en Firebase:
//        - Ir a https://console.firebase.google.com → Proyecto "riga-studio"
//        - Configuración del proyecto → Cuentas de servicio
//        - Clic en "Generar nueva clave privada"
//        - Guardar el archivo JSON descargado como "serviceAccountKey.json"
//          en la misma carpeta que este script
//        - ⚠️  NUNCA subas ese archivo a GitHub (agrega al .gitignore)
//
// ─── EJECUTAR MANUALMENTE ────────────────────────────────────────────────────
//
//   node sync-ads-metrics.js
//
//   El script toma el array SAMPLE_DATA definido al final del archivo,
//   lo procesa y lo sube a Firestore. Reemplazá ese array con datos reales
//   o llamá a syncAdsMetrics() desde un webhook.
//
// ─── AUTOMATIZAR CON MAKE (ex Integromat) ────────────────────────────────────
//
//   Make es la forma más sencilla de conectar Meta/Google Ads con este script.
//
//   PASO 1 — Crear el escenario en Make
//     - Nueva cuenta en https://make.com (plan gratuito funciona)
//     - Crear un "Scenario" nuevo
//
//   PASO 2 — Trigger: Meta Ads o Google Ads
//     - Buscar el módulo "Meta Ads" → "Watch Insights"
//       o "Google Ads" → "List Campaigns Performance"
//     - Conectar tu cuenta de anunciante
//     - Configurar el período: "Yesterday" para runs diarios
//     - Campos a extraer: campaign name, spend, impressions, clicks
//
//   PASO 3 — Acción: HTTP Webhook hacia este script
//     - Agregar módulo "HTTP" → "Make a request"
//     - URL: la URL pública donde corra este script (ej: Railway, Render, etc.)
//     - Método: POST
//     - Headers: { "Content-Type": "application/json" }
//     - Body (JSON):
//       {
//         "metrics": [
//           {
//             "platform": "Meta",
//             "campaign": "{{campaign.name}}",
//             "date": "{{formatDate(now; YYYY-MM-DD)}}",
//             "spend": {{campaign.spend}},
//             "impressions": {{campaign.impressions}},
//             "clicks": {{campaign.clicks}}
//           }
//         ]
//       }
//     - Repetir para cada campaña usando el módulo "Iterator"
//
//   PASO 4 — Programar
//     - En la esquina superior del escenario → "Scheduling"
//     - Frecuencia: Every day at 08:00
//
// ─── AUTOMATIZAR CON N8N ─────────────────────────────────────────────────────
//
//   n8n es open-source y se puede hostear gratis en Railway o en local.
//
//   PASO 1 — Crear el workflow en n8n
//     - Nueva instancia en https://n8n.io o en tu servidor
//     - Crear "New Workflow"
//
//   PASO 2 — Nodo trigger: Schedule
//     - Buscar nodo "Schedule Trigger"
//     - Rule: "Every Day" a las 08:00
//
//   PASO 3 — Nodo: Meta Ads (o HTTP Request hacia la API de Meta)
//     - Buscar nodo "Facebook Lead Ads" o usar "HTTP Request"
//     - URL de la API de Meta Ads Insights:
//       GET https://graph.facebook.com/v20.0/act_{AD_ACCOUNT_ID}/insights
//       Params: fields=campaign_name,spend,impressions,clicks
//               date_preset=yesterday
//               access_token={TU_TOKEN}
//
//   PASO 4 — Nodo: Google Ads (HTTP Request)
//     - URL: https://googleads.googleapis.com/v17/customers/{CUSTOMER_ID}/googleAds:search
//     - Body GAQL:
//       SELECT campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks
//       FROM campaign
//       WHERE segments.date DURING YESTERDAY
//     - Headers: Authorization: Bearer {OAUTH_TOKEN}
//
//   PASO 5 — Nodo: Code (transformar datos al formato esperado)
//     const items = $input.all();
//     return items.map(item => ({
//       json: {
//         platform: "Meta",  // o "Google"
//         campaign: item.json.campaign_name,
//         date: new Date().toISOString().slice(0, 10),
//         spend: parseFloat(item.json.spend),
//         impressions: parseInt(item.json.impressions),
//         clicks: parseInt(item.json.clicks)
//       }
//     }));
//
//   PASO 6 — Nodo: HTTP Request → este script
//     - Método: POST
//     - URL: tu URL pública + /sync
//     - Body: { "metrics": {{ $json.all() }} }
//
// ─── HOSTEAR ESTE SCRIPT COMO SERVIDOR HTTP ──────────────────────────────────
//
//   Para recibir webhooks, este script necesita una URL pública.
//   La opción más simple y gratuita es Railway:
//
//   1. Crear cuenta en https://railway.app
//   2. "New Project" → "Deploy from GitHub repo"
//   3. Apuntar a la carpeta de este script (o crear un repo separado)
//   4. Railway detecta el package.json y despliega automáticamente
//   5. En "Settings" → "Domains" → generar una URL pública
//   6. Usar esa URL en Make/n8n como destino del webhook
//
//   Variables de entorno necesarias en Railway (Settings → Variables):
//     FIREBASE_PROJECT_ID   = "riga-studio"
//     FIREBASE_CLIENT_EMAIL = "firebase-adminsdk-xxx@riga-studio.iam.gserviceaccount.com"
//     FIREBASE_PRIVATE_KEY  = "-----BEGIN PRIVATE KEY-----\n..."
//   (Copiar esos valores desde el archivo serviceAccountKey.json)
//
// =============================================================================

const admin = require('firebase-admin');
const http  = require('http');

// ── INICIALIZAR FIREBASE ADMIN ────────────────────────────────────────────────
// Soporta dos modos:
//   1. Variables de entorno (para producción en Railway/Render)
//   2. Archivo local serviceAccountKey.json (para desarrollo)

let credential;

if (process.env.FIREBASE_CLIENT_EMAIL) {
  // Modo producción: credenciales desde variables de entorno
  credential = admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Railway puede escapar los \n — este replace los normaliza
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
} else {
  // Modo desarrollo: archivo local (nunca subir a git)
  const serviceAccount = require('./serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential });
}

const db = admin.firestore();

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────────
/**
 * syncAdsMetrics — Guarda o actualiza métricas de campañas en Firestore.
 *
 * @param {Array<Object>} metrics - Array de objetos con las métricas a guardar.
 *   Cada objeto debe tener:
 *   {
 *     platform:    {string}  "Meta" | "Google"
 *     campaign:    {string}  Nombre de la campaña (ej: "Verano 2025 - Individuales")
 *     date:        {string}  Fecha en formato YYYY-MM-DD (ej: "2025-07-01")
 *     spend:       {number}  Gasto en la moneda local (ej: 1500.50)
 *     impressions: {number}  Cantidad de impresiones
 *     clicks:      {number}  Cantidad de clicks
 *   }
 *
 * @returns {Promise<{saved: number, errors: number}>}
 */
async function syncAdsMetrics(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    console.log('⚠️  No hay métricas para procesar.');
    return { saved: 0, errors: 0 };
  }

  let saved  = 0;
  let errors = 0;

  // Procesamos cada métrica en paralelo con Promise.allSettled
  // para que un error en una no detenga las demás
  const results = await Promise.allSettled(
    metrics.map(async (m) => {
      // Validar campos obligatorios
      if (!m.platform || !m.campaign || !m.date) {
        throw new Error(`Campos faltantes en: ${JSON.stringify(m)}`);
      }

      // Construir un ID de documento determinístico:
      // Formato: "2025-07-01_meta_verano-2025-individuales"
      // Esto garantiza que dos ejecuciones con los mismos datos
      // no crean documentos duplicados — simplemente actualizan el mismo.
      const docId = buildDocId(m.date, m.platform, m.campaign);

      // Datos a guardar (merge: true actualiza sin borrar campos extra)
      const data = {
        platform:    m.platform,
        campaign:    m.campaign,
        date:        m.date,
        spend:       Number(m.spend)       || 0,
        impressions: Number(m.impressions) || 0,
        clicks:      Number(m.clicks)      || 0,
        ctr:         m.impressions > 0 ? (m.clicks / m.impressions) : 0,
        cpc:         m.clicks > 0 ? (m.spend / m.clicks) : 0,
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection('ads_metrics').doc(docId).set(data, { merge: true });
      console.log(`  ✓ ${docId}`);
    })
  );

  results.forEach(r => {
    if (r.status === 'fulfilled') saved++;
    else { errors++; console.error('  ✗', r.reason?.message); }
  });

  console.log(`\nResultado: ${saved} guardados, ${errors} errores.`);
  return { saved, errors };
}

/**
 * buildDocId — Genera un ID limpio para el documento de Firestore.
 * Ejemplo: "2025-07-01_meta_verano-2025-individuales"
 */
function buildDocId(date, platform, campaign) {
  const cleanPlatform  = platform.toLowerCase().replace(/\s+/g, '-');
  const cleanCampaign  = campaign
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
    .replace(/[^a-z0-9]+/g, '-')                      // reemplazar caracteres especiales
    .replace(/^-+|-+$/g, '');                          // trim guiones
  return `${date}_${cleanPlatform}_${cleanCampaign}`;
}

// ── SERVIDOR HTTP (para recibir webhooks de Make / n8n) ───────────────────────
// Si se ejecuta con PORT definido, levanta un servidor que acepta POST /sync
// Si se ejecuta sin PORT, corre en modo CLI con SAMPLE_DATA

if (process.env.PORT) {
  const PORT = process.env.PORT;

  const server = http.createServer(async (req, res) => {
    // Health check — Make/n8n lo usan para confirmar que el server está vivo
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'riga-ads-sync' }));
      return;
    }

    // Endpoint principal: POST /sync
    if (req.method === 'POST' && req.url === '/sync') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { metrics } = JSON.parse(body);
          console.log(`\n[${new Date().toISOString()}] Recibidas ${metrics?.length || 0} métricas`);
          const result = await syncAdsMetrics(metrics);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          console.error('Error procesando webhook:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`\n🚀 Riga Ads Sync corriendo en puerto ${PORT}`);
    console.log(`   POST /sync    → recibir métricas`);
    console.log(`   GET  /health  → health check\n`);
  });

} else {
  // ── MODO CLI: ejecutar con datos de prueba ──────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);

  const SAMPLE_DATA = [
    {
      platform:    'Meta',
      campaign:    'Individuales - Temporada Invierno',
      date:        today,
      spend:       1200,
      impressions: 15400,
      clicks:      312,
    },
    {
      platform:    'Meta',
      campaign:    'Almohadas - Retargeting',
      date:        today,
      spend:       650,
      impressions: 8200,
      clicks:      178,
    },
    {
      platform:    'Google',
      campaign:    'Riga Studio - Búsqueda General',
      date:        today,
      spend:       890,
      impressions: 4300,
      clicks:      95,
    },
  ];

  console.log(`\nModo CLI — subiendo ${SAMPLE_DATA.length} métricas de prueba a Firestore...\n`);
  syncAdsMetrics(SAMPLE_DATA)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
