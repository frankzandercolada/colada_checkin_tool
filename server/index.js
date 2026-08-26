require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const _nodeFetch = require('node-fetch');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── Stats tracker ────────────────────────────────────────────────────────────
// Tracks outbound Colada API calls (/_gw/ endpoints) per minute and per kiosk
// station. In-memory only — resets on restart.
const STATS_WINDOW = 60; // rolling minutes to keep
const _stats = {
  // Rolling per-minute buckets for Colada API calls
  // Each bucket: { ts, calls, bytesIn, bytesOut }
  buckets:  [],
  _cur:     null,
  // Per-station totals: stationId -> { name, scans, checkins, searches, failed, lastSeen }
  stations: {},
  // All-time Colada API totals
  totals: { calls: 0, bytesOut: 0, bytesIn: 0 },
};

function _statsBucket() {
  const ts = Math.floor(Date.now() / 60000) * 60000;
  if (!_stats._cur || _stats._cur.ts !== ts) {
    const b = { ts, calls: 0, bytesOut: 0, bytesIn: 0 };
    _stats.buckets.push(b);
    _stats._cur = b;
    const cutoff = ts - STATS_WINDOW * 60000;
    _stats.buckets = _stats.buckets.filter(x => x.ts >= cutoff);
  }
  return _stats._cur;
}

// Record a completed Colada API call
function _recordApiCall({ bytesOut = 0, bytesIn = 0 } = {}) {
  const b = _statsBucket();
  b.calls++;
  b.bytesOut += bytesOut;
  b.bytesIn  += bytesIn;
  _stats.totals.calls++;
  _stats.totals.bytesOut += bytesOut;
  _stats.totals.bytesIn  += bytesIn;
}

// Record a kiosk event against a station
// event: 'scan_success' | 'scan_failed' | 'scan_already' | 'search' | 'register'
function _recordKiosk(stationId, stationName, event) {
  if (!stationId) return;
  if (!_stats.stations[stationId]) {
    _stats.stations[stationId] = {
      name: stationName || stationId.slice(0, 8),
      scans: 0, checkins: 0, already: 0, failed: 0, searches: 0, registers: 0,
      lastSeen: null,
    };
  }
  const s = _stats.stations[stationId];
  s.name     = stationName || s.name;
  s.lastSeen = new Date().toISOString();
  if (event === 'scan_success') { s.scans++; s.checkins++; }
  else if (event === 'scan_already') { s.scans++; s.already++; }
  else if (event === 'scan_failed')  { s.scans++; s.failed++;  }
  else if (event === 'search')       { s.searches++;           }
  else if (event === 'register')     { s.registers++;          }
}

// Wrap node-fetch to measure outbound Colada API calls.
// Only intercepts /_gw/ URLs — all other fetches pass through unchanged.
global._trackedFetch = async function(url, options = {}) {
  const urlStr = typeof url === 'string' ? url : url.href || String(url);
  if (!urlStr.includes('/_gw/')) return _nodeFetch(url, options);

  const bodyStr  = options.body ? String(options.body) : '';
  const bytesOut = Buffer.byteLength(bodyStr, 'utf8');

  const res = await _nodeFetch(url, options);

  // Clone response to measure size without consuming the original stream
  const text    = await res.text();
  const bytesIn = Buffer.byteLength(text, 'utf8');
  _recordApiCall({ bytesOut, bytesIn });

  // Re-wrap response so callers can still use .json()/.text()
  const { Response } = _nodeFetch;
  return new Response(text, { status: res.status, headers: res.headers });
};

// All route handlers below use this tracked version — /_gw/ calls are
// automatically measured; non-Colada URLs (token endpoint, etc.) pass through.
const fetch = global._trackedFetch; // eslint-disable-line no-shadow

// Stats endpoint
app.get('/api/stats/traffic', (req, res) => {
  const pid      = resolveProjectId(req);
  const stations = pid ? loadKioskStations(pid) : [];
  const enriched = Object.fromEntries(
    Object.entries(_stats.stations).map(([id, s]) => {
      const cfg = stations.find(st => st.id === id);
      return [id, { ...s, name: cfg?.name || s.name }];
    })
  );
  res.json({
    buckets:  _stats.buckets,
    totals:   _stats.totals,
    stations: enriched,
    uptimeMs: process.uptime() * 1000,
    memMb:    Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// Serve root CA cert for iOS device enrollment.
// iOS requires DER format (.cer) with the x509-ca-cert MIME type.
app.get('/caddy-root.cer', (req, res) => {
  const certPath = path.join(__dirname, '../public/caddy-root.cer');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="caddy-root.cer"');
  res.sendFile(certPath, err => {
    if (err) res.status(404).send('Certificate not found. Copy caddy-root.cer to the public folder.');
  });
});
// Also serve PEM for non-iOS devices
app.get('/caddy-root.crt', (req, res) => {
  const certPath = path.join(__dirname, '../public/caddy-root.crt');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="caddy-root.crt"');
  res.sendFile(certPath, err => {
    if (err) res.status(404).send('Certificate not found. Copy caddy-root.crt to the public folder.');
  });
});
app.use(express.static(path.join(__dirname, '../public')));

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── uuid helper (no extra dep) ───────────────────────────────────────────────
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '../config.json');
function loadConfig() {
  try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch(e) {}
  return { clientId:'external_client_s-ge', clientSecret:'aPCcOA7D3jti7t7Q',
    tokenUrl:'https://admin.colada365.com/auth/realms/default/protocol/openid-connect/token',
    apiBase:'https://admin.colada365.com', activeProjectId:null, tokenRefreshInterval:240, qwertyCorrection:true };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
let config = loadConfig();

// ─── Projects ─────────────────────────────────────────────────────────────────
const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');
function loadProjects() {
  try { if (fs.existsSync(PROJECTS_PATH)) return JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8')); } catch(e) {}
  return [];
}
function saveProjects(p) { fs.writeFileSync(PROJECTS_PATH, JSON.stringify(p, null, 2)); }

// Normalise single eventId vs eventIds array — handles legacy records transparently.
// Always returns a non-empty array of UUIDs, or [] if none configured.
function getProjectEventIds(project) {
  if (Array.isArray(project?.eventIds) && project.eventIds.length > 0) return project.eventIds;
  if (project?.eventId) return [project.eventId];
  return [];
}

// Returns 'assistant' or 'classic' (default) for the project's check-in field schema.
// 'assistant' uses: guest_x_assistant_checkedin (ISO datetime), guest_x_assistant_scanner_checkin_id
// 'classic'   uses: guest_x_checkedin (boolean), guest_x_checkedinat (date string)
function getCheckinSchema(project) {
  return project?.checkinSchema === 'assistant' ? 'assistant' : 'classic';
}

// Returns current datetime in the format Colada365 assistant fields expect: YYYY-MM-DDTHH:MM:SS
function assistantNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

function projectDir(id)        { return path.join(DATA_DIR, 'projects', id); }
function projectConfigPath(id) { return path.join(projectDir(id), 'badge-config.json'); }
function projectImagesDir(id)  { return path.join(projectDir(id), 'badge-images'); }
function ensureProjectDirs(id) { fs.mkdirSync(projectImagesDir(id), { recursive: true }); }

function loadProjectBadgeConfig(id) {
  try { const p = projectConfigPath(id); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p,'utf-8')); } catch(e) {}
  return { templates:null, rules:null, fallback:null };
}
function saveProjectBadgeConfig(id, cfg) {
  ensureProjectDirs(id);
  fs.writeFileSync(projectConfigPath(id), JSON.stringify(cfg, null, 2));
}

// ─── Default badge config (mirrors frontend DEFAULT_TEMPLATES / DEFAULT_RULES) ─
const DEFAULT_TEMPLATES = [
  { key:'awf_sb',        name:'AWF + Stimmberechtigt',          width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'awf_standard',  name:'AWF Standard',                   width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'awf_member_sb', name:'AWF + Member + Stimmberechtigt', width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'awf_member',    name:'AWF Member (Standard)',          width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'gv_sb',         name:'GV + Stimmberechtigt',           width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'gv_gast',       name:'GV Gast',                        width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'swissrail',     name:'Swissrail',                      width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'swissrail_mbr', name:'Swissrail + Member',             width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'swissmem',      name:'Swissmem',                       width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
  { key:'swissmem_mbr',  name:'Swissmem + Member',              width:580.83, height:990.24, color:'#d3222a', mirror:true, rows:[{field:'contact_x_companyName',fontSize:32,bold:true,marginTop:190,align:'center'},{field:'contact_firstName contact_lastName',fontSize:36,bold:false,marginTop:10,align:'center'}] },
];
const DEFAULT_RULES = [
  { id:'r1', name:'Swissrail + AWF + Stimmberechtigt', logic:'AND', template:'awf_member_sb', conditions:[{attr:'guest_x_member',op:'eq',value:'21996a6d-1db3-48ab-aeda-9bdcb80c4ac1'},{attr:'guest_x_awf_teilnehmer',op:'eq',value:'true'},{attr:'guest_x_Stimmberechtigt',op:'eq',value:'true'}] },
  { id:'r2', name:'Swissrail + AWF',                   logic:'AND', template:'swissrail_mbr', conditions:[{attr:'guest_x_member',op:'eq',value:'21996a6d-1db3-48ab-aeda-9bdcb80c4ac1'},{attr:'guest_x_awf_teilnehmer',op:'eq',value:'true'}] },
  { id:'r3', name:'Swissrail',                         logic:'AND', template:'swissrail',     conditions:[{attr:'guest_x_member',op:'eq',value:'21996a6d-1db3-48ab-aeda-9bdcb80c4ac1'}] },
  { id:'r4', name:'Swissmem + AWF + Stimmberechtigt',  logic:'AND', template:'awf_member_sb', conditions:[{attr:'guest_x_member',op:'eq',value:'73d58ee3-e715-4b9d-9412-1c33d5ddc563'},{attr:'guest_x_awf_teilnehmer',op:'eq',value:'true'},{attr:'guest_x_Stimmberechtigt',op:'eq',value:'true'}] },
  { id:'r5', name:'Swissmem + AWF',                    logic:'AND', template:'swissmem_mbr',  conditions:[{attr:'guest_x_member',op:'eq',value:'73d58ee3-e715-4b9d-9412-1c33d5ddc563'},{attr:'guest_x_awf_teilnehmer',op:'eq',value:'true'}] },
  { id:'r6', name:'Swissmem',                          logic:'AND', template:'swissmem',      conditions:[{attr:'guest_x_member',op:'eq',value:'73d58ee3-e715-4b9d-9412-1c33d5ddc563'}] },
  { id:'r7', name:'AWF + Stimmberechtigt',             logic:'AND', template:'awf_sb',        conditions:[{attr:'guest_x_awf_teilnehmer',op:'eq',value:'true'},{attr:'guest_x_Stimmberechtigt',op:'eq',value:'true'}] },
  { id:'r8', name:'AWF',                               logic:'AND', template:'awf_standard',  conditions:[{attr:'guest_x_awf_teilnehmer',op:'eq',value:'true'}] },
  { id:'r9', name:'GV + Stimmberechtigt',              logic:'AND', template:'gv_sb',         conditions:[{attr:'guest_x_Stimmberechtigt',op:'eq',value:'true'}] },
];
const DEFAULT_FALLBACK = 'gv_gast';

// ─── Badge-config concurrency meta ───────────────────────────────────────────
// Each section carries its own version counter so two admins editing different
// sections (e.g. templates vs. rules) never conflict, and a stale full-document
// save can be rejected instead of silently overwriting the other admin's work.
const BADGE_SECTIONS = ['templates', 'eventGroups', 'rules', 'fallback', 'selfRegistration'];
function badgeMeta(cfg) {
  const versions = {};
  for (const s of BADGE_SECTIONS) versions[s] = cfg?._meta?.versions?.[s] || 0;
  return { versions, updatedAt: cfg?._meta?.updatedAt || null };
}

// Like loadProjectBadgeConfig but always returns non-null arrays —
// falls back to DEFAULT_TEMPLATES / DEFAULT_RULES when the file has nulls.
function loadProjectBadgeConfigWithDefaults(id) {
  const cfg = loadProjectBadgeConfig(id);
  return {
    templates:       cfg.templates       || DEFAULT_TEMPLATES,
    eventGroups:     cfg.eventGroups     || [],
    rules:           cfg.rules           || DEFAULT_RULES,
    fallback:        cfg.fallback        || DEFAULT_FALLBACK,
    selfRegistration: cfg.selfRegistration || {},
  };
}

// Shared routing engine — used by both /api/kiosk/scan and future endpoints.
// Returns the template key to use for a given attrs object.
function selectTemplateKey(attrs, badgeCfg) {
  function evalCond(c, a) {
    const raw = a[c.attr];
    const sv  = String(raw ?? '').toLowerCase();
    const cv  = String(c.value ?? '').toLowerCase();
    switch(c.op) {
      case 'eq':       return sv === cv;
      case 'neq':      return sv !== cv;
      case 'contains': return sv.includes(cv);
      case 'exists':   return raw !== undefined && raw !== null && raw !== '';
      case 'true':     return raw === true || sv === 'true';
      case 'false':    return raw === false || sv === 'false';
      default:         return false;
    }
  }
  function evalRules(rules, label) {
    for (const rule of (rules || [])) {
      const results = rule.conditions.map(c => {
        const raw  = attrs[c.attr];
        const sv   = String(raw ?? '').toLowerCase();
        const cv   = String(c.value ?? '').toLowerCase();
        const pass = evalCond(c, attrs);
        console.log(`[routing]   ${label} | rule:"${rule.name}" | ${c.attr} ${c.op} "${c.value}" | attrVal=${JSON.stringify(raw)} | ${pass?'✓':'✗'}`);
        return pass;
      });
      const match = rule.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
      if (match) return rule.template;
    }
    return null;
  }

  const matchedEventId = attrs._matchedEventId;

  console.log('[routing] matchedEventId:', matchedEventId);
  console.log('[routing] eventGroups:', JSON.stringify((badgeCfg.eventGroups||[]).map(g => ({
    eventId: g.eventId, rulesCount: g.rules?.length || 0
  }))));
  console.log('[routing] globalRules:', badgeCfg.rules?.length || 0);

  // 1. Try event-scoped group first
  if (matchedEventId && Array.isArray(badgeCfg.eventGroups)) {
    const group = badgeCfg.eventGroups.find(g => g.eventId === matchedEventId);
    if (group) {
      console.log('[routing] found group with', group.rules?.length || 0, 'rules');
      const key = evalRules(group.rules, 'event');
      if (key) { console.log('[routing] matched event rule ->', key); return key; }
    } else {
      console.log('[routing] no group found for event', matchedEventId);
    }
  }

  // 2. Fall through to global rules
  const key = evalRules(badgeCfg.rules, 'global');
  if (key) { console.log('[routing] matched global rule ->', key); return key; }

  console.log('[routing] no match -> fallback:', badgeCfg.fallback || DEFAULT_FALLBACK);
  // 3. Final fallback
  return badgeCfg.fallback || DEFAULT_FALLBACK;
}

// ─── Migrate legacy badge-config.json ────────────────────────────────────────
(function migrateLegacy() {
  const legacyConfig = path.join(__dirname, '../badge-config.json');
  const legacyImages = path.join(__dirname, '../badge-images');
  if (!fs.existsSync(legacyConfig) && !fs.existsSync(legacyImages)) return;
  const projects = loadProjects();
  if (projects.length > 0) return;
  console.log('[migrate] Migrating legacy badge-config to Default Project...');
  const id = uuidv4();
  const project = { id, name: 'Default Project', eventId: config.eventId || '', createdAt: new Date().toISOString() };
  ensureProjectDirs(id);
  if (fs.existsSync(legacyConfig)) {
    try { saveProjectBadgeConfig(id, JSON.parse(fs.readFileSync(legacyConfig,'utf-8'))); fs.renameSync(legacyConfig, legacyConfig+'.migrated'); } catch(e) {}
  }
  if (fs.existsSync(legacyImages)) {
    try { fs.readdirSync(legacyImages).forEach(f => fs.renameSync(path.join(legacyImages,f), path.join(projectImagesDir(id),f))); fs.rmdirSync(legacyImages); } catch(e) {}
  }
  projects.push(project);
  saveProjects(projects);
  config.activeProjectId = id;
  saveConfig(config);
  console.log(`[migrate] Done — project "${project.name}" (${id})`);
})();

// ─── Active project helper ────────────────────────────────────────────────────
function getActiveProjectId() {
  const projects = loadProjects();
  if (config.activeProjectId && projects.find(p => p.id === config.activeProjectId)) return config.activeProjectId;
  if (projects.length > 0) { config.activeProjectId = projects[0].id; saveConfig(config); return config.activeProjectId; }
  return null;
}

// Resolve which project a request targets. Backoffice clients pin the project
// they are editing via ?projectId= so concurrent admins can work on different
// projects; kiosks send nothing and keep following the globally active project.
function resolveProjectId(req) {
  const q = (req.query.projectId || '').trim();
  if (q) return q;
  return getActiveProjectId();
}

// ─── Token cache (per-project) ───────────────────────────────────────────────
const tokenCaches = {}; // keyed by projectId (or 'global')

function getEffectiveCredentials(projectId) {
  const projects = loadProjects();
  const project = projectId ? projects.find(p => p.id === projectId) : null;
  return {
    clientId:     (project?.clientId)     || config.clientId,
    clientSecret: (project?.clientSecret) || config.clientSecret,
    tokenUrl:     (project?.tokenUrl)     || config.tokenUrl,
    apiBase:      (project?.apiBase)      || config.apiBase,
  };
}

async function getToken(projectId) {
  const key = projectId || 'global';
  if (!tokenCaches[key]) tokenCaches[key] = { token:null, expires:0, inflight:null };
  const cache = tokenCaches[key];
  const now = Date.now();
  if (cache.token && cache.expires > now+10000) return cache.token;
  // Deduplicate concurrent refresh requests — if one is already in flight,
  // all callers await the same promise instead of firing N OAuth requests.
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    try {
      const creds = getEffectiveCredentials(projectId);
      const params = new URLSearchParams();
      params.append('grant_type','client_credentials');
      params.append('client_id', creds.clientId);
      params.append('client_secret', creds.clientSecret);
      params.append('scope','email profile');

      // Retry loop — on Raspberry Pi, the system clock may not be synced yet
      // after a cold boot (no hardware RTC), causing TLS cert validation to fail
      // with CERT_DATE_INVALID / unknown issuer. Retry for up to 2 minutes.
      const MAX_ATTEMPTS = 12;
      const RETRY_DELAY_MS = 10000; // 10s between retries
      let lastErr;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(creds.tokenUrl, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params });
          if (!res.ok) throw new Error(`Token fetch failed (${res.status}): ${await res.text()}`);
          const data = await res.json();
          cache.token = data.access_token;
          cache.expires = Date.now() + (data.expires_in||300)*1000;
          if (attempt > 1) console.log(`[token] Succeeded on attempt ${attempt} (clock sync likely completed)`);
          return cache.token;
        } catch(err) {
          lastErr = err;
          const msg = err.message || '';
          // Detect TLS/cert errors that are caused by clock skew — retry those
          const isClockError = /CERT_DATE_INVALID|UNABLE_TO_VERIFY_LEAF|UNKNOWN_ISSUER|SEC_ERROR|certificate|ssl|tls/i.test(msg);
          if (isClockError && attempt < MAX_ATTEMPTS) {
            console.warn(`[token] TLS error on attempt ${attempt}/${MAX_ATTEMPTS} (possible clock skew — retrying in ${RETRY_DELAY_MS/1000}s): ${msg}`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          } else {
            throw err; // non-TLS error or max retries reached — fail immediately
          }
        }
      }
      throw lastErr;
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

function compensateQwerty(input) {
  return input.trim().replace(/z/g,'TEMPz').replace(/Z/g,'TEMPZ').replace(/y/g,'z').replace(/Y/g,'Z')
    .replace(/TEMPz/g,'y').replace(/TEMPZ/g,'Y').replace(/\//g,'-').replace(/&/g,'/');
}
function checkPermissions(attrs) {
  const awfTrue = attrs.guest_x_awf_teilnehmer === true;
  const stimm = attrs.guest_x_Stimmberechtigt === true;
  if (!awfTrue) return { allowed:false, reason:'Not an AWF participant', stimmberechtigt:stimm };
  return { allowed:true, stimmberechtigt:stimm, reason: stimm ? 'AWF participant with voting rights' : 'AWF participant (no voting rights)' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Projects ─────────────────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  res.json({ projects: loadProjects(), activeProjectId: getActiveProjectId() });
});

app.post('/api/projects', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:'name required' });
  // Accept either eventIds[] (new) or eventId string (legacy) from the client
  const eventIds = Array.isArray(req.body.eventIds)
    ? req.body.eventIds.map(s => (s||'').trim()).filter(Boolean)
    : (req.body.eventId ? [req.body.eventId.trim()] : []);
  const eventId = eventIds[0] || '';
  const id = uuidv4();
  const { clientId='', clientSecret='', tokenUrl='', apiBase='' } = req.body;
  const project = { id, name:name.trim(), eventId, eventIds, clientId, clientSecret, tokenUrl, apiBase, createdAt:new Date().toISOString() };
  ensureProjectDirs(id);
  const projects = loadProjects();
  projects.push(project);
  saveProjects(projects);
  res.json({ ok:true, project });
});

app.patch('/api/projects/:id', (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'not found' });
  if (req.body.name !== undefined) projects[idx].name = req.body.name.trim();
  // Accept either eventIds[] (new) or eventId string (legacy); keep both fields in sync
  if (req.body.eventIds !== undefined) {
    const ids = Array.isArray(req.body.eventIds)
      ? req.body.eventIds.map(s => (s||'').trim()).filter(Boolean)
      : [req.body.eventIds].map(s => (s||'').trim()).filter(Boolean);
    projects[idx].eventIds = ids;
    projects[idx].eventId  = ids[0] || '';
  } else if (req.body.eventId !== undefined) {
    const id0 = (req.body.eventId || '').trim();
    projects[idx].eventId  = id0;
    projects[idx].eventIds = id0 ? [id0] : [];
  }
  if (req.body.clientId !== undefined) projects[idx].clientId = req.body.clientId;
  if (req.body.clientSecret !== undefined) projects[idx].clientSecret = req.body.clientSecret;
  if (req.body.tokenUrl !== undefined) projects[idx].tokenUrl = req.body.tokenUrl;
  if (req.body.apiBase !== undefined) projects[idx].apiBase = req.body.apiBase;
  if (req.body.checkinSchema !== undefined) projects[idx].checkinSchema = req.body.checkinSchema;
  saveProjects(projects);
  res.json({ ok:true, project:projects[idx] });
});

app.delete('/api/projects/:id', (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'not found' });
  if (projects.length === 1) return res.status(400).json({ error:'Cannot delete the only project' });
  try { fs.rmSync(projectDir(req.params.id), { recursive:true, force:true }); } catch(e) {}
  const deletedId = req.params.id;
  projects.splice(idx, 1);
  saveProjects(projects);
  if (config.activeProjectId === deletedId) { config.activeProjectId = projects[0].id; saveConfig(config); }
  res.json({ ok:true, activeProjectId:config.activeProjectId });
});

app.post('/api/projects/:id/duplicate', (req, res) => {
  const projects = loadProjects();
  const src = projects.find(p => p.id === req.params.id);
  if (!src) return res.status(404).json({ error:'not found' });
  const newId = uuidv4();
  const newProject = { id:newId, name:(req.body.name || src.name+' (copy)').trim(), eventId:src.eventId, clientId:src.clientId||'', clientSecret:src.clientSecret||'', tokenUrl:src.tokenUrl||'', apiBase:src.apiBase||'', createdAt:new Date().toISOString() };
  ensureProjectDirs(newId);
  saveProjectBadgeConfig(newId, loadProjectBadgeConfig(src.id));
  const srcImg = projectImagesDir(src.id);
  if (fs.existsSync(srcImg)) {
    fs.readdirSync(srcImg).forEach(f => fs.copyFileSync(path.join(srcImg,f), path.join(projectImagesDir(newId),f)));
  }
  projects.push(newProject);
  saveProjects(projects);
  res.json({ ok:true, project:newProject });
});

app.post('/api/projects/active', (req, res) => {
  const { projectId } = req.body;
  const projects = loadProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error:'not found' });
  config.activeProjectId = projectId;
  saveConfig(config);
  const eventIds = getProjectEventIds(project);
  res.json({ ok:true, activeProjectId:projectId,
    eventId:  project.eventId,
    eventIds,
    clientId: project.clientId||'', tokenUrl:project.tokenUrl||'', apiBase:project.apiBase||'',
    hasSecret:!!(project.clientSecret) });
});

// ─── Badge Config (project-scoped) ────────────────────────────────────────────
app.get('/api/badge-config', (req, res) => {
  const id = req.query.projectId || getActiveProjectId();
  if (!id) return res.json({ templates: DEFAULT_TEMPLATES, rules: DEFAULT_RULES, fallback: DEFAULT_FALLBACK, _meta: badgeMeta(null) });
  res.json({ ...loadProjectBadgeConfigWithDefaults(id), _meta: badgeMeta(loadProjectBadgeConfig(id)) });
});

app.post('/api/badge-config', (req, res) => {
  try {
    const id = req.query.projectId || getActiveProjectId();
    if (!id) return res.status(400).json({ error:'no active project' });
    const existing = loadProjectBadgeConfig(id);
    const meta = badgeMeta(existing);
    const submitted = BADGE_SECTIONS.filter(s => req.body[s] !== undefined);

    // Optimistic locking: clients send the section versions their edit was based
    // on. If another admin saved a submitted section in the meantime, reject
    // with 409 + the current server state so the client can refresh and retry.
    const base = req.body._baseVersions;
    if (base && typeof base === 'object') {
      const conflicts = submitted.filter(s => base[s] !== undefined && base[s] !== meta.versions[s]);
      if (conflicts.length) {
        return res.status(409).json({
          error: 'conflict', conflicts,
          current: loadProjectBadgeConfigWithDefaults(id),
          _meta: meta,
        });
      }
    }

    for (const s of submitted) meta.versions[s]++;
    meta.updatedAt = new Date().toISOString();
    saveProjectBadgeConfig(id, {
      templates:        req.body.templates        !== undefined ? req.body.templates        : existing.templates,
      eventGroups:      req.body.eventGroups      !== undefined ? req.body.eventGroups      : (existing.eventGroups || []),
      rules:            req.body.rules            !== undefined ? req.body.rules            : existing.rules,
      fallback:         req.body.fallback         !== undefined ? req.body.fallback         : existing.fallback,
      selfRegistration: req.body.selfRegistration !== undefined ? req.body.selfRegistration : (existing.selfRegistration || {}),
      _meta: meta,
    });
    res.json({ ok:true, _meta: meta });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── Routing debug — read-only, shows exactly what the kiosk scan would use ──
// GET /api/kiosk/routing-debug
// Returns the resolved badge config (with defaults) plus the raw file content,
// so you can confirm rules are populated without performing an actual scan.
app.get('/api/kiosk/routing-debug', (req, res) => {
  const id = resolveProjectId(req);
  if (!id) return res.status(400).json({ error: 'no active project' });
  const raw  = loadProjectBadgeConfig(id);
  const resolved = loadProjectBadgeConfigWithDefaults(id);
  res.json({
    activeProjectId: id,
    rawFromDisk: {
      templatesCount:   raw.templates?.length    ?? null,
      eventGroupsCount: raw.eventGroups?.length  ?? null,
      rulesCount:       raw.rules?.length        ?? null,
      fallback:         raw.fallback             ?? null,
    },
    resolvedForKiosk: {
      templatesCount:   resolved.templates.length,
      eventGroupsCount: resolved.eventGroups.length,
      rulesCount:       resolved.rules.length,
      fallback:         resolved.fallback,
      eventGroups:      resolved.eventGroups.map(g => ({ eventId: g.eventId, rulesCount: g.rules?.length || 0, rules: g.rules })),
      globalRules:      resolved.rules,
    },
  });
});

// ─── Badge Images (project-scoped) ────────────────────────────────────────────
app.get('/api/badge-images', (req, res) => {
  const id = req.query.projectId || getActiveProjectId();
  if (!id) return res.json({ keys:[] });
  const dir = projectImagesDir(id);
  try { res.json({ keys: (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>f.endsWith('.txt')) : []).map(f=>f.replace(/\.txt$/,'')) }); }
  catch(e) { res.json({ keys:[] }); }
});

app.get('/api/badge-images/:key', (req, res) => {
  const id = req.query.projectId || getActiveProjectId();
  if (!id) return res.status(404).json({ error:'no active project' });
  const file = path.join(projectImagesDir(id), `${req.params.key}.txt`);
  if (!fs.existsSync(file)) return res.status(404).json({ error:'not found' });
  try { res.json({ dataUrl: fs.readFileSync(file,'utf-8') }); } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/badge-images/:key', (req, res) => {
  try {
    const id = req.query.projectId || getActiveProjectId();
    if (!id) return res.status(400).json({ error:'no active project' });
    const { dataUrl } = req.body;
    if (!dataUrl) return res.status(400).json({ error:'dataUrl required' });
    const key = req.params.key.replace(/[^a-z0-9_]/gi,'_');
    ensureProjectDirs(id);
    fs.writeFileSync(path.join(projectImagesDir(id), `${key}.txt`), dataUrl, 'utf-8');
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/badge-images/:key', (req, res) => {
  const id = req.query.projectId || getActiveProjectId();
  if (!id) return res.json({ ok:true });
  const file = path.join(projectImagesDir(id), `${req.params.key}.txt`);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/badge-images/rename', (req, res) => {
  const id = req.query.projectId || getActiveProjectId();
  if (!id) return res.json({ ok:true });
  const { oldKey, newKey } = req.body;
  const dir = projectImagesDir(id);
  try { if (fs.existsSync(path.join(dir,`${oldKey}.txt`))) fs.renameSync(path.join(dir,`${oldKey}.txt`), path.join(dir,`${newKey}.txt`)); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── Project credentials endpoint ────────────────────────────────────────────
app.get('/api/projects/:id/credentials', (req, res) => {
  const projects = loadProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error:'not found' });
  res.json({
    clientId:     project.clientId     || '',
    clientSecret: project.clientSecret ? '••••••••' : '',
    tokenUrl:     project.tokenUrl     || '',
    apiBase:      project.apiBase      || '',
    eventId:      project.eventId      || '',
    // effective (what would actually be used)
    effective: getEffectiveCredentials(req.params.id),
  });
});

// ─── Config API ───────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => { const s={...config}; s.clientSecret=s.clientSecret?'••••••••':''; res.json(s); });
app.get('/api/config/full', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  saveConfig(config);
  // Clear all token caches since global creds changed
  Object.keys(tokenCaches).forEach(k => { tokenCaches[k] = { token:null, expires:0 }; });
  res.json({ ok:true, config:{ ...config, clientSecret:'••••••••' } });
});

app.get('/api/token/test', async (req, res) => {
  try {
    const id = resolveProjectId(req);
    if (id && tokenCaches[id]) tokenCaches[id] = { token:null, expires:0 };
    await getToken(id);
    const cache = tokenCaches[id||'global'] || { expires: Date.now()+300000 };
    res.json({ ok:true, expiresIn:Math.round((cache.expires-Date.now())/1000)+'s' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── Events & Guests ──────────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const id = resolveProjectId(req);
    const token = await getToken(id);
    const { apiBase } = getEffectiveCredentials(id);
    const r = await fetch(`${apiBase}/_gw/s-events/external-api/events`,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok) throw new Error(`API error ${r.status}`); res.json(await r.json());
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get('/api/event/:id', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const r = await fetch(`${apiBase}/_gw/s-events/external-api/events/${req.params.id}`,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok) throw new Error(`API error ${r.status}`); res.json(await r.json());
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Resolve a list of event IDs to their display names in one round-trip.
// GET /api/events/names?ids=uuid1,uuid2,…
// Returns { names: { uuid: "Event Name", … }, errors: { uuid: "message", … } }
app.get('/api/events/names', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ names: {}, errors: {} });

    // Helper: extract display name from the Colada365 event object
    function extractEventName(ev) {
      const props = ev?.properties || ev?.attributes || {};
      return props.title || props.name || props.event_name ||
             ev?.name || ev?.title || null;
    }

    const results = await Promise.allSettled(
      ids.map(id =>
        fetch(`${apiBase}/_gw/s-events/external-api/events/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
      )
    );

    const names = {};
    const errors = {};
    ids.forEach((id, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') {
        const name = extractEventName(r.value);
        names[id] = name || `Event ${id.slice(0, 8)}…`;
      } else {
        errors[id] = r.reason?.message || 'unknown error';
        names[id] = `Event ${id.slice(0, 8)}…`; // graceful fallback
      }
    });

    res.json({ names, errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fetch participant groups for a given event.
// GET /api/events/:eventId/participantgroups
// Returns { groups: [{ id, name }] }
app.get('/api/events/:eventId/participantgroups', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const { eventId } = req.params;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    const url = `${apiBase}/_gw/s-events-participant-groups/external-api/events/${eventId}/participantgroups`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`API error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();

    const arr = Array.isArray(data) ? data
      : (data.participantGroups || data.participantgroups || data.groups || data.items || data.data || []);

    const groups = arr.map(g => {
      const props = g.properties || g.attributes || {};
      const name  = props.name || props.title || props.displayName
                 || g.name || g.title || g.displayName || g.id;
      return { id: g.id || g.uid, name };
    }).filter(g => g.id);

    res.json({ groups });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Schema endpoint — scans all guests and infers field types + unique values
app.get('/api/guests/:eventId/schema', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const base = `${apiBase}/_gw/s-events-guests/external-api/events/${req.params.eventId}/guests`;

    // Fetch all guests (re-use same pagination logic)
    const PAGE = 500;
    const r = await fetch(base, { headers: { Authorization: `Bearer ${token}`, Range: `guests 0-${PAGE-1}` } });
    if (!r.ok) throw new Error(`API error ${r.status}`);
    const first = await r.json(); const arr = Array.isArray(first) ? first : [];
    const total = parseInt((r.headers.get('Content-Range') || '').split('/')[1]) || arr.length;
    if (total > arr.length) {
      const pages = []; for (let f = PAGE; f < total; f += PAGE) pages.push({ from: f, to: Math.min(f + PAGE - 1, total - 1) });
      arr.push(...(await Promise.all(pages.map(({ from, to }) =>
        fetch(base, { headers: { Authorization: `Bearer ${token}`, Range: `guests ${from}-${to}` } }).then(r2 => r2.json()).then(d => Array.isArray(d) ? d : [])
      ))).flat());
    }

    // Build per-field schema
    const fields = {}; // key -> { types: Set, values: Map<value, count> }
    for (const g of arr) {
      const attrs = g.attributes || g.properties || {};
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue;
        if (!fields[k]) fields[k] = { types: new Set(), values: new Map() };
        fields[k].types.add(typeof v);
        const sv = String(v);
        fields[k].values.set(sv, (fields[k].values.get(sv) || 0) + 1);
      }
    }

    // Classify each field
    const schema = {};
    for (const [k, f] of Object.entries(fields)) {
      const types = [...f.types];
      const allValues = [...f.values.entries()].map(([value, count]) => ({ value, count }));
      const nonFalseValues = allValues.filter(e => e.value !== 'false');

      const isBool = types.includes('boolean') ||
        allValues.every(e => e.value === 'true' || e.value === 'false');
      const isUUID = !isBool && nonFalseValues.length > 0 &&
        nonFalseValues.every(e => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.value));

      let fieldType = 'text';
      if (isBool) fieldType = 'boolean';
      else if (isUUID) fieldType = 'choice'; // single/multi-choice stored as UUID

      schema[k] = {
        type: fieldType,
        // for choice fields: sorted by count desc so most common option appears first
        values: (fieldType === 'choice' || fieldType === 'boolean')
          ? allValues.sort((a, b) => b.count - a.count)
          : [],
        totalGuests: arr.length,
      };
    }

    res.json({ totalGuests: arr.length, fields: schema });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Option labels endpoint — fetches the Colada365 application/form schema to resolve
// UUID option values to human-readable labels.
// Tries multiple known Colada365 API endpoint patterns.
app.get('/api/guests/:eventId/optionlabels', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const eventId = req.params.eventId;
    const headers = { Authorization: `Bearer ${token}` };

    // Try candidate endpoints in order — return first one that gives us properties with options
    const candidates = [
      `${apiBase}/_gw/s-events-guests/external-api/events/${eventId}/guestschema`,
      `${apiBase}/_gw/s-events/external-api/events/${eventId}/guestschema`,
      `${apiBase}/_gw/s-events/external-api/events/${eventId}/schema`,
      `${apiBase}/_gw/s-events/external-api/events/${eventId}/applications`,
    ];

    let labelMap = {}; // { uuid -> label }
    let tried = [];

    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers });
        tried.push({ url, status: r.status });
        if (!r.ok) continue;
        const data = await r.json();
        // guestschema returns an array of field objects, each with an options array.
        // Each option has an id (UUID) and label info in l10n or displayNameL10n.
        const extractOptLabel = (opt) =>
          opt.label || opt.name
          || opt.l10n?.en?.label || opt.l10n?.de?.label || opt.l10n?.fr?.label
          || opt.displayNameL10n?.en?.label || opt.displayNameL10n?.de?.label || opt.displayNameL10n?.fr?.label;

        const fields = Array.isArray(data) ? data : (data.properties || data.fields || Object.values(data));
        for (const field of fields) {
          if (!field || typeof field !== 'object') continue;
          const opts = field.options || field.values || [];
          for (const opt of (Array.isArray(opts) ? opts : [])) {
            const id = opt.id || opt.uid || opt.value;
            const label = extractOptLabel(opt);
            if (id && label) labelMap[id] = label;
          }
        }
        if (Object.keys(labelMap).length > 0) break;
      } catch(e) { tried.push({ url, error: e.message }); }
    }

    res.json({ tried, labelCount: Object.keys(labelMap).length, labelMap });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/guests/:eventId', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    let scanInput = req.query.scan || '';
    const searchTerm = (req.query.search||'').trim().toLowerCase();
    if (config.qwertyCorrection && scanInput) scanInput = compensateQwerty(scanInput);
    const base = `${apiBase}/_gw/s-events-guests/external-api/events/${req.params.eventId}/guests`;

    if (scanInput) {
      try {
        const dr = await fetch(`${base}/${encodeURIComponent(scanInput)}`,{headers:{Authorization:`Bearer ${token}`,Range:'guests 0-0'}});
        if (dr.ok) { const g=await dr.json(); const r=Array.isArray(g)?g:(g&&(g.id||g.uid)?[g]:[]); if(r.length>0) return res.json(r); }
      } catch(e) {}
      const fr = await fetch(`${base}?filter[uid]=${encodeURIComponent(scanInput)}`,{headers:{Authorization:`Bearer ${token}`,Range:'guests 0-499'}});
      if (fr.ok) { const gs=await fr.json(); const arr=Array.isArray(gs)?gs:[]; const m=arr.filter(g=>{const u=g.uid||g.id||(g.attributes||g.properties||{}).uid||''; return u===scanInput||u.toLowerCase()===scanInput.toLowerCase();}); return res.json(m); }
      return res.json([]);
    }

    const PAGE=500;
    const r = await fetch(base,{headers:{Authorization:`Bearer ${token}`,Range:`guests 0-${PAGE-1}`}});
    if (!r.ok) throw new Error(`API error ${r.status}`);
    const guests = await r.json(); const arr = Array.isArray(guests)?guests:[];
    const total = parseInt((r.headers.get('Content-Range')||'').split('/')[1])||arr.length;
    if (total > arr.length) {
      const pages=[]; for(let f=PAGE;f<total;f+=PAGE) pages.push({from:f,to:Math.min(f+PAGE-1,total-1)});
      arr.push(...(await Promise.all(pages.map(({from,to})=>fetch(base,{headers:{Authorization:`Bearer ${token}`,Range:`guests ${from}-${to}`}}).then(r2=>r2.json()).then(d=>Array.isArray(d)?d:[])))).flat());
    }
    if (searchTerm) return res.json(arr.filter(g=>{const a=g.attributes||g.properties||{};return [a.contact_firstName||'',a.contact_lastName||'',(a.contact_firstName||'')+' '+(a.contact_lastName||''),a.contact_x_companyName||'',a.contact_email||''].some(f=>f.toLowerCase().includes(searchTerm));}));
    res.json(arr);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/guests/:eventId/:guestId/checkin', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const projects = loadProjects();
    const project = projects.find(p => p.id === pid);
    const checkinSchema = getCheckinSchema(project);
    const now   = assistantNow();
    const today = now.split('T')[0];
    const guest = req.body;
    const stationId = req.body.stationId || null;
    const existingAttrs = guest.attributes || guest.properties || {};
    const { _matchedEventId: _omit, ...cleanAttrs } = existingAttrs;
    let patchAttrs;
    if (checkinSchema === 'assistant') {
      patchAttrs = { ...cleanAttrs,
        guest_x_assistant_checkedin:          now,
        guest_x_assistant_scanner_checkin_id: stationId || '',
      };
    } else {
      patchAttrs = { ...cleanAttrs, guest_x_checkedin: true };
      const ea = existingAttrs.guest_x_checkedinat;
      if (!ea || ea === false || ea === 'false' || ea === '') patchAttrs.guest_x_checkedinat = today;
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-cache' };
    const rev = guest.revision || (guest.attributes || {}).revision;
    if (rev) headers['If-Match'] = rev;
    const r = await fetch(`${apiBase}/_gw/s-events-guests/external-api/events/${req.params.eventId}/guests/${req.params.guestId}`, { method: 'PATCH', headers, body: JSON.stringify({ attributes: patchAttrs }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`API error ${r.status}: ${text.slice(0, 200)}`);
    try { res.json(JSON.parse(text)); } catch(e) { res.json({ ok: true }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/guests/:eventId/:guestId/undo-checkin', async (req, res) => {
  try {
    const pid = resolveProjectId(req);
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const projects = loadProjects();
    const project = projects.find(p => p.id === pid);
    const checkinSchema = getCheckinSchema(project);
    const guest = req.body;
    const existingAttrs = guest.attributes || guest.properties || {};
    const { _matchedEventId: _omit, ...cleanAttrs } = existingAttrs;

    let patchAttrs, unsetFields;
    if (checkinSchema === 'assistant') {
      patchAttrs = { ...cleanAttrs };
      delete patchAttrs.guest_x_assistant_checkedin;
      delete patchAttrs.guest_x_assistant_scanner_checkin_id;
      unsetFields = {
        'attributes.guest_x_assistant_checkedin':         true,
        'attributes.guest_x_assistant_scanner_checkin_id': true,
      };
    } else {
      patchAttrs = { ...cleanAttrs, guest_x_checkedin: false };
      delete patchAttrs.guest_x_checkedinat;
      unsetFields = { 'attributes.guest_x_checkedinat': true };
    }

    const body = { attributes: patchAttrs, $unset: unsetFields };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-cache' };
    const rev = guest.revision || existingAttrs.revision;
    if (rev) headers['If-Match'] = rev;
    const r = await fetch(`${apiBase}/_gw/s-events-guests/external-api/events/${req.params.eventId}/guests/${req.params.guestId}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`API error ${r.status}: ${text.slice(0, 200)}`);
    try { res.json(JSON.parse(text)); } catch(e) { res.json({ ok: true }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/guests/:eventId/:guestId/badge', async (req, res) => {
  try {
    const attrs = req.body.attributes||{};
    const p = checkPermissions(attrs);
    res.json({ ok:true, badge:{ firstName:attrs.contact_firstName||'', lastName:attrs.contact_lastName||'', company:attrs.contact_x_companyName||'', stimmberechtigt:p.stimmberechtigt, permissions:p } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── Self-registration ────────────────────────────────────────────────────────

// Returns the registration config for the active station + option labels for
// any choice fields so the kiosk can render dropdowns without extra API calls.
app.get('/api/kiosk/registration-config', async (req, res) => {
  try {
    const pid = getActiveProjectId();
    const stations = loadKioskStations(pid);
    const stationId = req.query.stationId;
    const station = stationId ? stations.find(s => s.id === stationId) : null;
    if (!station?.selfRegistration?.enabled) return res.json({ enabled: false });

    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);

    // Self-reg config (participant group + fields) lives in badge-config per event
    const badgeCfg = loadProjectBadgeConfigWithDefaults(pid);
    const selfReg  = badgeCfg.selfRegistration || {}; // { [eventId]: { participantGroup, fields } }

    // Resolve event names — fetch each event individually in parallel
    const projects = loadProjects();
    const project  = projects.find(p => p.id === pid);
    const eventIds = getProjectEventIds(project);
    let eventNames = {};
    if (eventIds.length) {
      const settled = await Promise.allSettled(
        eventIds.map(eid =>
          fetch(`${apiBase}/_gw/s-events/external-api/events/${eid}`,
            { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
            .then(r => r.ok ? r.json() : null)
            .then(ev => {
              if (!ev) return;
              const props = ev.properties || ev.attributes || {};
              const name  = props.title || props.name || props.event_name
                         || ev.name || ev.title || null;
              if (name) eventNames[eid] = name;
            })
        )
      );
      settled.forEach((s, i) => {
        if (s.status === 'rejected')
          console.warn(`[reg-config] Could not resolve event name for ${eventIds[i]}:`, s.reason?.message);
      });
    }

    // Build a flat labelMap from all choice field options across all events
    const labelMap = {};
    for (const evCfg of Object.values(selfReg)) {
      for (const f of (evCfg.fields || [])) {
        if (f.type === 'choice') {
          for (const opt of (f.options || [])) {
            if (opt.value && opt.label) labelMap[opt.value] = opt.label;
          }
        }
      }
    }

    res.json({ enabled: true, selfReg, eventIds, eventNames, labelMap });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create a new guest registration and immediately check them in + return badge config.
// Body: { eventId, attributes: { contact_firstName, contact_lastName, contact_email, contact_commLang, … } }
app.post('/api/kiosk/register', async (req, res) => {
  try {
    const pid = getActiveProjectId();
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const projects = loadProjects();
    const project = projects.find(p => p.id === pid);
    const checkinSchema = getCheckinSchema(project);

    const { eventId, attributes: inputAttrs = {}, stationId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId required' });
    if (!inputAttrs.contact_firstName || !inputAttrs.contact_lastName || !inputAttrs.contact_email) {
      return res.status(400).json({ error: 'firstName, lastName and email are required' });
    }

    // Load self-registration config for this event from badge-config (not station)
    const badgeCfg = loadProjectBadgeConfigWithDefaults(pid);
    const evSelfReg = (badgeCfg.selfRegistration || {})[eventId] || {};

    // Build the attributes payload — pre-unset whichever check-in fields apply
    const attrs = { ...inputAttrs };
    if (checkinSchema === 'assistant') {
      attrs.guest_x_assistant_checkedin          = '$unset';
      attrs.guest_x_assistant_scanner_checkin_id = '$unset';
    } else {
      attrs.guest_x_checkedinat = '$unset';
    }

    // Build the Colada365 POST body — participantGroupId is top-level, not in attributes
    const createBody = {
      participantGroupId: evSelfReg.participantGroup || null,
      departmentId:       null,
      attributes:         attrs,
    };

    const base    = `${apiBase}/_gw/s-events-guests/external-api/events/${eventId}/guests`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };

    // 1. Create the guest — Colada365 returns 201 Created
    const createRes = await fetch(base, { method: 'POST', headers, body: JSON.stringify(createBody) });
    const createText = await createRes.text();
    if (createRes.status !== 201 && !createRes.ok) {
      throw new Error(`Registration failed (${createRes.status}): ${createText.slice(0, 300)}`);
    }

    // Parse whatever body came back — on 201 it may be minimal ({ id } or even empty)
    let guest = {};
    try { const parsed = JSON.parse(createText); guest = Array.isArray(parsed) ? parsed[0] : parsed; } catch(e) {}

    // Extract guest ID — may be in body or in Location header
    let guestId = guest.id || guest.uid;
    if (!guestId) {
      const loc = createRes.headers.get('Location') || '';
      const m   = loc.match(/\/guests\/([^/?]+)/);
      if (m) guestId = m[1];
    }
    if (!guestId) throw new Error('No guest ID returned from Colada365 (no id in body or Location header)');

    // 2. Always re-fetch the full guest record after creation to get the current
    //    revision — Colada365 increments it internally after creation (assigning
    //    guest_code, triggering workflows), so the 201 revision is already stale.
    try {
      const fetchRes = await fetch(`${base}/${guestId}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (fetchRes.ok) guest = await fetchRes.json();
    } catch(e) { console.warn('[register] re-fetch error:', e.message); }

    // 3. Check in the newly created guest — schema-aware.
    // Colada365 may still be updating the guest between our re-fetch and PATCH — retry on 409.
    const now   = assistantNow();
    const today = now.split('T')[0];
    let checkedIn = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const guestAttrs = guest.attributes || guest.properties || {};
      const baseAttrs  = Object.keys(guestAttrs).length ? guestAttrs : inputAttrs;
      const { guest_x_checkedinat: _u1, guest_x_assistant_checkedin: _u2, _matchedEventId: _mid, ...cleanBaseAttrs } = baseAttrs;
      let patchAttrs;
      if (checkinSchema === 'assistant') {
        patchAttrs = { ...cleanBaseAttrs,
          guest_x_assistant_checkedin:          now,
          guest_x_assistant_scanner_checkin_id: stationId || '',
        };
      } else {
        patchAttrs = { ...cleanBaseAttrs, guest_x_checkedin: true, guest_x_checkedinat: today };
      }
      const ciHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
      const rev = guest.revision || guestAttrs.revision;
      if (rev) ciHeaders['If-Match'] = rev;
      const ciRes = await fetch(`${base}/${guestId}`, { method: 'PATCH', headers: ciHeaders, body: JSON.stringify({ attributes: patchAttrs }) });
      if (ciRes.ok) { checkedIn = true; break; }
      const ciErr = await ciRes.text();
      if (ciRes.status === 409 && attempt < 5) {
        await new Promise(r => setTimeout(r, 300 * attempt));
        try {
          const refetch = await fetch(`${base}/${guestId}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
          if (refetch.ok) guest = await refetch.json();
        } catch(e) {}
      } else {
        console.warn(`[register] check-in PATCH failed (${ciRes.status}): ${ciErr.slice(0, 200)}`);
        break;
      }
    }
    if (!checkedIn) console.warn('[register] guest created but check-in did not complete');

    // 4. Build response attrs with _matchedEventId for badge routing
    const finalGuestAttrs = guest.attributes || guest.properties || {};
    const responseAttrs = checkinSchema === 'assistant'
      ? { ...inputAttrs, ...finalGuestAttrs,
          guest_x_assistant_checkedin:          now,
          guest_x_assistant_scanner_checkin_id: stationId || '',
          _matchedEventId: eventId,
        }
      : { ...inputAttrs, ...finalGuestAttrs,
          guest_x_checkedin:   true,
          guest_x_checkedinat: today,
          _matchedEventId:     eventId,
        };

    const selectedTemplate = selectTemplateKey(responseAttrs, badgeCfg);

    _recordKiosk(stationId || null, null, 'register');

    res.json({
      ok: true,
      guest: {
        firstName: responseAttrs.contact_firstName || '',
        lastName:  responseAttrs.contact_lastName  || '',
        company:   responseAttrs.contact_x_companyName || '',
        id: guestId,
        attributes: responseAttrs,
      },
      badgeConfig: {
        templates:   badgeCfg.templates,
        eventGroups: badgeCfg.eventGroups,
        rules:       badgeCfg.rules,
        fallback:    badgeCfg.fallback,
        _selectedTemplate: selectedTemplate,
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Kiosk stations ───────────────────────────────────────────────────────────
function kioskStationsPath(projectId) {
  return path.join(projectDir(projectId), 'kiosk-stations.json');
}
function loadKioskStations(projectId) {
  try {
    const p = kioskStationsPath(projectId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch(e) {}
  return [];
}
function saveKioskStations(projectId, stations) {
  ensureProjectDirs(projectId);
  fs.writeFileSync(kioskStationsPath(projectId), JSON.stringify(stations, null, 2));
}


// ─── Kiosk heartbeat (in-memory, resets on server restart) ───────────────────
const kioskHeartbeats = {}; // stationId -> { lastSeen: Date, ip: string }

app.post('/api/kiosk/heartbeat', (req, res) => {
  const { stationId } = req.body;
  if (!stationId) return res.status(400).json({ error: 'stationId required' });
  kioskHeartbeats[stationId] = { lastSeen: new Date(), ip: req.ip };
  res.json({ ok: true });
});

app.get('/api/kiosk/stations/status', (req, res) => {
  const now = Date.now();
  const status = {};
  for (const [id, h] of Object.entries(kioskHeartbeats)) {
    const age = now - new Date(h.lastSeen).getTime();
    status[id] = { lastSeen: h.lastSeen, ip: h.ip, online: age < 30000 }; // online = seen within 30s
  }
  res.json(status);
});

app.get('/api/kiosk/stations', (req, res) => {
  const id = resolveProjectId(req);
  if (!id) return res.json([]);
  res.json(loadKioskStations(id));
});

app.post('/api/kiosk/stations', (req, res) => {
  const id = resolveProjectId(req);
  if (!id) return res.status(400).json({ error: 'no active project' });
  const { name, welcome, success, notFound, alreadyCheckedIn, accentColor, bgColor, logoText, printEndpoint, cameraMode, disableGradient } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const stations = loadKioskStations(id);
  const stationId = req.body.id || uuidv4();
  const existing = stations.findIndex(s => s.id === stationId);

  // Optimistic locking: reject a save based on a stale copy of the station so
  // one admin's edit can't silently overwrite another's. Clients that don't
  // send _version (older kiosk pages) keep the old last-writer-wins behavior.
  if (existing >= 0 && req.body._version !== undefined && req.body._version !== null
      && req.body._version !== (stations[existing]._version || 0)) {
    return res.status(409).json({ error: 'conflict', station: stations[existing] });
  }

  // Extract bgImage data URLs from each screen and save them as separate image files.
  // This keeps kiosk-stations.json small — only a bgImageKey is stored, not the full base64.
  // bgImage === data URL  → save file, store key
  // bgImage === ''        → client explicitly cleared — delete file and key
  // bgImage === null      → unchanged — preserve existing bgImageKey from current station
  const existingStation = stations.find(s => s.id === stationId) || {};
  function extractScreenBg(screenObj, screenKey, existingScreen) {
    if (!screenObj) return {};
    const s = { ...screenObj };
    const imgKey = `kiosk-${stationId}-${screenKey}`;
    const imgPath = path.join(projectImagesDir(id), `${imgKey}.txt`);

    if (s.bgImage && s.bgImage.startsWith('data:')) {
      // New upload — save to disk
      ensureProjectDirs(id);
      fs.writeFileSync(imgPath, s.bgImage, 'utf-8');
      s.bgImageKey = imgKey;
    } else if (s.bgImage === '') {
      // Explicitly cleared — delete file
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
      delete s.bgImageKey;
    } else {
      // null = unchanged — preserve existing key
      const existingKey = existingScreen?.bgImageKey;
      if (existingKey) s.bgImageKey = existingKey;
      else delete s.bgImageKey;
    }
    delete s.bgImage;
    // bgImageTop is a plain number — pass through as-is
    if (s.bgImageTop == null) delete s.bgImageTop;
    return s;
  }

  const { lightMode } = req.body;
  const station = {
    id: stationId,
    name: name.trim(),
    welcome:          extractScreenBg(welcome,          'welcome',  existingStation.welcome),
    success:          extractScreenBg(success,          'success',  existingStation.success),
    notFound:         extractScreenBg(notFound,         'notfound', existingStation.notFound),
    alreadyCheckedIn: extractScreenBg(alreadyCheckedIn, 'already',  existingStation.alreadyCheckedIn),
    accentColor:   accentColor   || '#d3222a',
    bgColor:       bgColor       || '#0a0a0a',
    bgColorLight:  req.body.bgColorLight  || '#f0f0f0',
    logoText:      logoText      || '',
    hideLogoText:  req.body.hideLogoText  || false,
    printEndpoint:  printEndpoint  || null,
    signalEndpoint: req.body.signalEndpoint || null,
    cameraMode:    cameraMode    || false,
    lightMode:     lightMode     || false,
    disableGradient: disableGradient || false,
    selfRegistration: { enabled: !!(req.body.selfRegistration?.enabled) },
    guestSearch:      { enabled: !!(req.body.guestSearch?.enabled) },
    hideIcon:         !!(req.body.hideIcon),
    _version: (existing >= 0 ? (stations[existing]._version || 0) : 0) + 1,
  };
  if (existing >= 0) stations[existing] = station; else stations.push(station);
  saveKioskStations(id, stations);
  res.json({ ok: true, station });
});

app.delete('/api/kiosk/stations/:stationId', (req, res) => {
  const id = resolveProjectId(req);
  if (!id) return res.status(400).json({ error: 'no active project' });
  const stations = loadKioskStations(id).filter(s => s.id !== req.params.stationId);
  saveKioskStations(id, stations);
  res.json({ ok: true });
});

app.post('/api/kiosk/stations/:stationId/duplicate', (req, res) => {
  const pid = resolveProjectId(req);
  if (!pid) return res.status(400).json({ error: 'no active project' });
  const stations = loadKioskStations(pid);
  const src = stations.find(s => s.id === req.params.stationId);
  if (!src) return res.status(404).json({ error: 'station not found' });

  const newId   = uuidv4();
  const newName = (req.body.name || src.name + ' (copy)').trim();
  const imgDir  = projectImagesDir(pid);

  // Deep-clone the source station, assign new id and name
  const copy = JSON.parse(JSON.stringify(src));
  copy.id   = newId;
  copy.name = newName;
  copy._version = 1;

  // For each screen, copy the image file and update the bgImageKey reference
  const SCREENS = [
    { key: 'welcome',          screenKey: 'welcome'  },
    { key: 'success',          screenKey: 'success'  },
    { key: 'notFound',         screenKey: 'notfound' },
    { key: 'alreadyCheckedIn', screenKey: 'already'  },
  ];
  for (const { key, screenKey } of SCREENS) {
    const screen = copy[key];
    if (!screen?.bgImageKey) continue;
    const srcFile = path.join(imgDir, `${screen.bgImageKey}.txt`);
    const newKey  = `kiosk-${newId}-${screenKey}`;
    const dstFile = path.join(imgDir, `${newKey}.txt`);
    try {
      if (fs.existsSync(srcFile)) {
        ensureProjectDirs(pid);
        fs.copyFileSync(srcFile, dstFile);
        screen.bgImageKey = newKey;
      } else {
        delete screen.bgImageKey;
      }
    } catch(e) {
      delete screen.bgImageKey; // non-fatal — skip image if copy fails
    }
  }

  stations.push(copy);
  saveKioskStations(pid, stations);
  res.json({ ok: true, station: copy });
});

// Kiosk name search — searches across all project events in parallel.
// GET /api/kiosk/search?q=name&stationId=...
// Returns up to 10 guests (deduplicated by id) with _matchedEventId injected.
app.get('/api/kiosk/search', async (req, res) => {
  try {
    const pid = getActiveProjectId();
    const q   = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const projects = loadProjects();
    const project  = projects.find(p => p.id === pid);
    const eventIds = getProjectEventIds(project);
    if (!eventIds.length) return res.json([]);

    // Search each event in parallel
    const results = await Promise.allSettled(
      eventIds.map(eid =>
        fetch(`${apiBase}/_gw/s-events-guests/external-api/events/${eid}/guests?filter[name]=${encodeURIComponent(q)}`,
          { headers: { Authorization: `Bearer ${token}`, Range: 'guests 0-9' } })
          .then(r => r.ok ? r.json() : [])
          .then(data => {
            const arr = Array.isArray(data) ? data : [];
            // Inject _matchedEventId and filter by name client-side as fallback
            const term = q.toLowerCase();
            return arr
              .filter(g => {
                const a = g.attributes || g.properties || {};
                const full = [a.contact_firstName, a.contact_lastName,
                  (a.contact_firstName||'')+' '+(a.contact_lastName||''),
                  a.contact_x_companyName, a.contact_email].join(' ').toLowerCase();
                return full.includes(term);
              })
              .map(g => {
                const attrs = g.attributes || g.properties || {};
                attrs._matchedEventId = eid;
                if (g.attributes) g.attributes = attrs;
                else g.properties = attrs;
                return g;
              });
          })
      )
    );

    // Merge, deduplicate by guest id, limit to 10
    const seen = new Set();
    const merged = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const g of r.value) {
        const id = g.id || g.uid;
        if (id && !seen.has(id)) { seen.add(id); merged.push(g); }
        if (merged.length >= 10) break;
      }
      if (merged.length >= 10) break;
    }
    _recordKiosk(req.query.stationId || null, null, 'search');
    res.json(merged);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kiosk/scan', async (req, res) => {
  try {
    const pid = getActiveProjectId();
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const projects = loadProjects();
    const project = projects.find(p => p.id === pid);
    const eventIds = getProjectEventIds(project);
    if (!eventIds.length) return res.status(400).json({ error: 'no event configured' });

    let scanInput = (req.body.scan || '').trim();
    const scanStationId = req.body.stationId || null;
    if (config.qwertyCorrection && scanInput) scanInput = compensateQwerty(scanInput);
    if (!scanInput) return res.status(400).json({ error: 'scan value required' });

    // Try each event ID in order — stop at the first that returns a matching guest.
    // IMPORTANT: only use filter[uid] for the event-matching step — the direct-by-ID
    // endpoint (/guests/{id}) is NOT event-scoped on Colada365 and will return a guest
    // regardless of which event it's queried against, causing the wrong event to be matched.
    // filter[uid] is genuinely scoped to the event's guest list.
    let guest = null;
    let matchedEventId = null;

    if (eventIds.length === 1) {
      // Single-event fast path: try direct lookup first, then filter[uid]
      const eid  = eventIds[0];
      const base = `${apiBase}/_gw/s-events-guests/external-api/events/${eid}/guests`;
      try {
        const dr = await fetch(`${base}/${encodeURIComponent(scanInput)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (dr.ok) {
          const g = await dr.json();
          const found = Array.isArray(g) ? g[0] : (g?.id || g?.uid ? g : null);
          if (found) { guest = found; matchedEventId = eid; }
        }
      } catch(e) {}
      if (!guest) {
        try {
          const fr = await fetch(`${base}?filter[uid]=${encodeURIComponent(scanInput)}`, { headers: { Authorization: `Bearer ${token}`, Range: 'guests 0-0' } });
          if (fr.ok) {
            const gs = await fr.json();
            const arr = Array.isArray(gs) ? gs : [];
            const found = arr.find(g => {
              const u = g.uid || g.id || (g.attributes || g.properties || {}).uid || '';
              return u === scanInput || u.toLowerCase() === scanInput.toLowerCase();
            }) || null;
            if (found) { guest = found; matchedEventId = eid; }
          }
        } catch(e) {}
      }
    } else {
      // Multi-event: use ONLY filter[uid] — it is event-scoped so we know
      // exactly which event the guest belongs to.
      // Run all events in parallel for speed, then pick the first match.
      const results = await Promise.all(eventIds.map(async eid => {
        const base = `${apiBase}/_gw/s-events-guests/external-api/events/${eid}/guests`;
        try {
          const fr = await fetch(`${base}?filter[uid]=${encodeURIComponent(scanInput)}`, {
            headers: { Authorization: `Bearer ${token}`, Range: 'guests 0-0' },
          });
          if (!fr.ok) return null;
          const gs  = await fr.json();
          const arr = Array.isArray(gs) ? gs : [];
          const found = arr.find(g => {
            const u = g.uid || g.id || (g.attributes || g.properties || {}).uid || '';
            return u === scanInput || u.toLowerCase() === scanInput.toLowerCase();
          }) || null;
          return found ? { guest: found, matchedEventId: eid } : null;
        } catch(e) { return null; }
      }));
      // Use the first successful result (preserving eventIds order priority)
      const hit = results.find(r => r !== null);
      if (hit) { guest = hit.guest; matchedEventId = hit.matchedEventId; }
    }

    if (!guest) {
      console.log(`[scan] not_found — scanInput: "${scanInput}" — eventIds: ${JSON.stringify(eventIds)}`);
      _recordKiosk(scanStationId, null, 'scan_failed');
      return res.json({ result: 'not_found' });
    }

    console.log(`[scan] found guest id=${guest.id} uid=${guest.uid} matchedEventId=${matchedEventId} status=${guest.status}`);

    // Normalise attributes — Colada365 may return nested (.attributes/.properties)
    // or flat (all fields at top level). Use whichever has the most keys.
    const nestedAttrs = guest.attributes || guest.properties || {};
    const topLevelAttrs = Object.fromEntries(
      Object.entries(guest).filter(([k]) =>
        !['id','uid','status','revision','attributes','properties'].includes(k)
      )
    );
    const attrs = Object.keys(nestedAttrs).length >= Object.keys(topLevelAttrs).length
      ? nestedAttrs
      : { ...topLevelAttrs, ...nestedAttrs }; // merge, nested takes precedence

    // Inject synthetic attribute so badge routing rules can match on which event was matched
    attrs._matchedEventId = matchedEventId;

    const checkinSchema = getCheckinSchema(project);

    const status = guest.status || attrs.status || '';
    const isEligible = status === 'REGISTERED' || status === 'PENDING';

    if (!isEligible) {
      _recordKiosk(scanStationId, null, 'scan_failed');
      return res.json({ result: 'invalid_status', status, guest: { firstName: attrs.contact_firstName || '', lastName: attrs.contact_lastName || '', company: attrs.contact_x_companyName || '' } });
    }

    // Already-checked-in detection — schema-aware
    const alreadyIn = checkinSchema === 'assistant'
      ? !!(attrs.guest_x_assistant_checkedin && attrs.guest_x_assistant_checkedin !== '' && attrs.guest_x_assistant_checkedin !== false)
      : attrs.guest_x_checkedin === true || (attrs.guest_x_checkedinat && attrs.guest_x_checkedinat !== false && attrs.guest_x_checkedinat !== 'false' && attrs.guest_x_checkedinat !== '');

    if (alreadyIn) {
      _recordKiosk(scanStationId, null, 'scan_already');
      const badgeCfg = loadProjectBadgeConfigWithDefaults(pid);
      const selectedTemplate = selectTemplateKey(attrs, badgeCfg);
      const checkedInAt = checkinSchema === 'assistant' ? attrs.guest_x_assistant_checkedin : attrs.guest_x_checkedinat;
      return res.json({
        result: 'already_checked_in',
        matchedEventId,
        guest: { firstName: attrs.contact_firstName || '', lastName: attrs.contact_lastName || '', company: attrs.contact_x_companyName || '', id: guest.id, attributes: attrs, checkedInAt },
        badgeConfig: { templates: badgeCfg.templates, eventGroups: badgeCfg.eventGroups, rules: badgeCfg.rules, fallback: badgeCfg.fallback, _selectedTemplate: selectedTemplate },
      });
    }

    // Build check-in PATCH attributes — schema-aware
    const now   = assistantNow();
    const today = now.split('T')[0];
    const { _matchedEventId: _omit, ...cleanAttrs } = attrs;
    let patchAttrs;
    if (checkinSchema === 'assistant') {
      patchAttrs = { ...cleanAttrs,
        guest_x_assistant_checkedin:         now,
        guest_x_assistant_scanner_checkin_id: scanStationId || '',
      };
    } else {
      patchAttrs = { ...cleanAttrs, guest_x_checkedin: true, guest_x_checkedinat: today };
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    const rev = guest.revision || attrs.revision;
    if (rev) headers['If-Match'] = rev;
    // Check in against the event where the guest was found
    const checkinBase = `${apiBase}/_gw/s-events-guests/external-api/events/${matchedEventId}/guests`;
    const pr = await fetch(`${checkinBase}/${guest.id}`, { method: 'PATCH', headers, body: JSON.stringify({ attributes: patchAttrs }) });
    if (!pr.ok) throw new Error(`Check-in failed: ${pr.status}`);

    _recordKiosk(scanStationId, null, 'scan_success');
    const badgeCfg = loadProjectBadgeConfigWithDefaults(pid);
    const selectedTemplate = selectTemplateKey(attrs, badgeCfg);

    res.json({
      result: 'success',
      matchedEventId,
      guest: { firstName: attrs.contact_firstName || '', lastName: attrs.contact_lastName || '', company: attrs.contact_x_companyName || '', id: guest.id, attributes: attrs },
      badgeConfig: { templates: badgeCfg.templates, eventGroups: badgeCfg.eventGroups, rules: badgeCfg.rules, fallback: badgeCfg.fallback, _selectedTemplate: selectedTemplate },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kiosk/badge-image/:key', (req, res) => {
  const id = getActiveProjectId();
  if (!id) return res.status(404).end();
  const file = path.join(projectImagesDir(id), `${req.params.key}.txt`);
  if (!fs.existsSync(file)) return res.status(404).end();
  try { res.json({ dataUrl: fs.readFileSync(file, 'utf-8') }); } catch(e) { res.status(500).end(); }
});

app.get('/kiosk', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/kiosk.html'));
});
// ─── Print proxy ──────────────────────────────────────────────────────────────
// Forwards base64-encoded PDF from the kiosk to the configured print endpoint.
// This avoids mixed-content blocking on iOS Safari — the kiosk posts to HTTPS
// here, and this server forwards to the (potentially HTTP) print endpoint.
app.post('/api/kiosk/print', express.text({ limit: '20mb' }), async (req, res) => {
  const { stationId } = req.query;
  const pid = getActiveProjectId();
  if (!pid) return res.status(400).json({ error: 'no active project' });
  const stations = loadKioskStations(pid);
  const station = stations.find(s => s.id === stationId);
  if (!station?.printEndpoint) return res.status(400).json({ error: 'no print endpoint configured' });

  const b64 = req.body;
  if (!b64) return res.status(400).json({ error: 'no body' });

  try {
    const pr = await fetch(station.printEndpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'X-Encoding': 'base64' },
      body: b64,
    });
    if (!pr.ok) throw new Error(`Print endpoint returned ${pr.status}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[print proxy]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Signal proxy ─────────────────────────────────────────────────────────────
// Forwards a status signal (success|failed) to the station's configured endpoint.
// Accepts signalEndpoint directly in the body (kiosk already has the full config in memory)
// to avoid stale disk lookups.
// POST /api/kiosk/signal  body: { status: 'success'|'failed', signalEndpoint: '...' }
app.post('/api/kiosk/signal', async (req, res) => {
  const { status, signalEndpoint } = req.body || {};
  if (!status)         return res.status(400).json({ error: 'status required' });
  if (!signalEndpoint) return res.status(400).json({ error: 'signalEndpoint required' });

  console.log(`[signal proxy] → ${signalEndpoint}  status=${status}`);
  try {
    const sr = await fetch(signalEndpoint, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status }),
    });
    const responseText = await sr.text();
    if (!sr.ok) {
      console.error(`[signal proxy] endpoint returned ${sr.status}: ${responseText.slice(0, 200)}`);
      throw new Error(`Signal endpoint returned ${sr.status}: ${responseText.slice(0, 200)}`);
    }
    console.log(`[signal proxy] ✓ delivered (${sr.status})`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[signal proxy] fetch failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Kiosk event recorder ──────────────────────────────────────────────────────
// Called by the kiosk after search-driven check-ins (which bypass the scan route)
// so those outcomes also appear in the monitor station table.
// POST /api/kiosk/record-event  body: { stationId, event }
// event: 'scan_success' | 'scan_failed' | 'scan_already' | 'search' | 'register'
app.post('/api/kiosk/record-event', express.json(), (req, res) => {
  const { stationId, event } = req.body || {};
  if (stationId && event) _recordKiosk(stationId, null, event);
  res.json({ ok: true });
});

app.get('/kiosk/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/kiosk.html'));
});

// ─── Sync state ───────────────────────────────────────────────────────────────
// Cheap polling endpoint for the backoffice: lets each admin session detect
// changes made by other admins (badge config, stations, projects, live project)
// without re-downloading full configs.
app.get('/api/sync-state', (req, res) => {
  const pid = resolveProjectId(req);
  const out = {
    activeProjectId: getActiveProjectId(),
    projectId: pid,
    badgeVersions: null,
    stationsMtime: null,
    projectsMtime: null,
  };
  try { if (fs.existsSync(PROJECTS_PATH)) out.projectsMtime = fs.statSync(PROJECTS_PATH).mtimeMs; } catch(e) {}
  if (pid) {
    try { out.badgeVersions = badgeMeta(loadProjectBadgeConfig(pid)).versions; } catch(e) {}
    try {
      const p = kioskStationsPath(pid);
      if (fs.existsSync(p)) out.stationsMtime = fs.statSync(p).mtimeMs;
    } catch(e) {}
  }
  res.json(out);
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const projects = loadProjects();
  console.log(`\n✅ Colada365 Check-in running on http://localhost:${PORT}`);
  console.log(`   Projects: ${projects.length} | Active: ${config.activeProjectId||'none'}\n`);
});
