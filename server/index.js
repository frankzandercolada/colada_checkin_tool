require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
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

// Like loadProjectBadgeConfig but always returns non-null arrays —
// falls back to DEFAULT_TEMPLATES / DEFAULT_RULES when the file has nulls.
function loadProjectBadgeConfigWithDefaults(id) {
  const cfg = loadProjectBadgeConfig(id);
  return {
    templates:   cfg.templates   || DEFAULT_TEMPLATES,
    eventGroups: cfg.eventGroups || [],
    rules:       cfg.rules       || DEFAULT_RULES,
    fallback:    cfg.fallback    || DEFAULT_FALLBACK,
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
      const res = await fetch(creds.tokenUrl, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params });
      if (!res.ok) throw new Error(`Token fetch failed (${res.status}): ${await res.text()}`);
      const data = await res.json();
      cache.token = data.access_token;
      cache.expires = Date.now() + (data.expires_in||300)*1000;
      return cache.token;
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
  if (!id) return res.json({ templates: DEFAULT_TEMPLATES, rules: DEFAULT_RULES, fallback: DEFAULT_FALLBACK });
  res.json(loadProjectBadgeConfigWithDefaults(id));
});

app.post('/api/badge-config', (req, res) => {
  try {
    const id = req.query.projectId || getActiveProjectId();
    if (!id) return res.status(400).json({ error:'no active project' });
    const existing = loadProjectBadgeConfig(id);
    saveProjectBadgeConfig(id, {
      templates:   req.body.templates   !== undefined ? req.body.templates   : existing.templates,
      eventGroups: req.body.eventGroups !== undefined ? req.body.eventGroups : (existing.eventGroups || []),
      rules:       req.body.rules       !== undefined ? req.body.rules       : existing.rules,
      fallback:    req.body.fallback    !== undefined ? req.body.fallback    : existing.fallback,
    });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── Routing debug — read-only, shows exactly what the kiosk scan would use ──
// GET /api/kiosk/routing-debug
// Returns the resolved badge config (with defaults) plus the raw file content,
// so you can confirm rules are populated without performing an actual scan.
app.get('/api/kiosk/routing-debug', (req, res) => {
  const id = getActiveProjectId();
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
    const id = getActiveProjectId();
    if (id && tokenCaches[id]) tokenCaches[id] = { token:null, expires:0 };
    await getToken(id);
    const cache = tokenCaches[id||'global'] || { expires: Date.now()+300000 };
    res.json({ ok:true, expiresIn:Math.round((cache.expires-Date.now())/1000)+'s' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── Events & Guests ──────────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const id = getActiveProjectId();
    const token = await getToken(id);
    const { apiBase } = getEffectiveCredentials(id);
    const r = await fetch(`${apiBase}/_gw/s-events/external-api/events`,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok) throw new Error(`API error ${r.status}`); res.json(await r.json());
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get('/api/event/:id', async (req, res) => {
  try {
    const pid = getActiveProjectId();
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
    const pid = getActiveProjectId();
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

// Schema endpoint — scans all guests and infers field types + unique values
app.get('/api/guests/:eventId/schema', async (req, res) => {
  try {
    const pid = getActiveProjectId();
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
    const pid = getActiveProjectId();
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
    const pid = getActiveProjectId();
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
    const pid = getActiveProjectId();
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const today = new Date().toISOString().split('T')[0];
    const guest = req.body;
    const existingAttrs = guest.attributes||guest.properties||{};
    const patchAttrs = { ...existingAttrs, guest_x_checkedin:true };
    const ea = existingAttrs.guest_x_checkedinat;
    if (!ea||ea===false||ea==='false'||ea==='') patchAttrs.guest_x_checkedinat = today;
    const headers = { Authorization:`Bearer ${token}`, 'Content-Type':'application/json', Accept:'application/json', 'Cache-Control':'no-cache' };
    const rev = guest.revision||(guest.attributes||{}).revision;
    if (rev) headers['If-Match'] = rev;
    const r = await fetch(`${apiBase}/_gw/s-events-guests/external-api/events/${req.params.eventId}/guests/${req.params.guestId}`,{method:'PATCH',headers,body:JSON.stringify({attributes:patchAttrs})});
    const text = await r.text();
    if (!r.ok) throw new Error(`API error ${r.status}: ${text.slice(0,200)}`);
    try { res.json(JSON.parse(text)); } catch(e) { res.json({ ok:true }); }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/guests/:eventId/:guestId/undo-checkin', async (req, res) => {
  try {
    const pid = getActiveProjectId();
    const token = await getToken(pid);
    const { apiBase } = getEffectiveCredentials(pid);
    const guest = req.body;
    const existingAttrs = guest.attributes || guest.properties || {};
    const patchAttrs = { ...existingAttrs, guest_x_checkedin: false, guest_x_checkedinat: false };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-cache' };
    const rev = guest.revision || (guest.attributes || {}).revision;
    if (rev) headers['If-Match'] = rev;
    const r = await fetch(`${apiBase}/_gw/s-events-guests/external-api/events/${req.params.eventId}/guests/${req.params.guestId}`, { method: 'PATCH', headers, body: JSON.stringify({ attributes: patchAttrs }) });
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
  const id = getActiveProjectId();
  if (!id) return res.json([]);
  res.json(loadKioskStations(id));
});

app.post('/api/kiosk/stations', (req, res) => {
  const id = getActiveProjectId();
  if (!id) return res.status(400).json({ error: 'no active project' });
  const { name, welcome, success, notFound, alreadyCheckedIn, accentColor, bgColor, logoText, printEndpoint, cameraMode } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const stations = loadKioskStations(id);
  const stationId = req.body.id || uuidv4();
  const existing = stations.findIndex(s => s.id === stationId);

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
    accentColor:   accentColor  || '#d3222a',
    bgColor:       bgColor      || '#0a0a0a',
    logoText:      logoText     || '',
    printEndpoint: printEndpoint || null,
    cameraMode:    cameraMode   || false,
    lightMode:     lightMode    || false,
  };
  if (existing >= 0) stations[existing] = station; else stations.push(station);
  saveKioskStations(id, stations);
  res.json({ ok: true, station });
});

app.delete('/api/kiosk/stations/:stationId', (req, res) => {
  const id = getActiveProjectId();
  if (!id) return res.status(400).json({ error: 'no active project' });
  const stations = loadKioskStations(id).filter(s => s.id !== req.params.stationId);
  saveKioskStations(id, stations);
  res.json({ ok: true });
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

    if (!guest) return res.json({ result: 'not_found' });

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

    const status = guest.status || attrs.status || '';
    const isEligible = status === 'REGISTERED' || status === 'PENDING';

    if (!isEligible) return res.json({ result: 'invalid_status', status, guest: { firstName: attrs.contact_firstName || '', lastName: attrs.contact_lastName || '', company: attrs.contact_x_companyName || '' } });

    const alreadyIn = attrs.guest_x_checkedin === true || (attrs.guest_x_checkedinat && attrs.guest_x_checkedinat !== false && attrs.guest_x_checkedinat !== 'false' && attrs.guest_x_checkedinat !== '');
    if (alreadyIn) return res.json({ result: 'already_checked_in', guest: { firstName: attrs.contact_firstName || '', lastName: attrs.contact_lastName || '', company: attrs.contact_x_companyName || '', checkedInAt: attrs.guest_x_checkedinat } });

    const today = new Date().toISOString().split('T')[0];
    // Build patch — exclude the synthetic _matchedEventId so it is never sent to Colada365
    const { _matchedEventId: _omit, ...cleanAttrs } = attrs;
    const patchAttrs = { ...cleanAttrs, guest_x_checkedin: true, guest_x_checkedinat: today };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    const rev = guest.revision || attrs.revision;
    if (rev) headers['If-Match'] = rev;
    // Check in against the event where the guest was found
    const checkinBase = `${apiBase}/_gw/s-events-guests/external-api/events/${matchedEventId}/guests`;
    const pr = await fetch(`${checkinBase}/${guest.id}`, { method: 'PATCH', headers, body: JSON.stringify({ attributes: patchAttrs }) });
    if (!pr.ok) throw new Error(`Check-in failed: ${pr.status}`);

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

app.get('/kiosk/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/kiosk.html'));
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const projects = loadProjects();
  console.log(`\n✅ Colada365 Check-in running on http://localhost:${PORT}`);
  console.log(`   Projects: ${projects.length} | Active: ${config.activeProjectId||'none'}\n`);
});
