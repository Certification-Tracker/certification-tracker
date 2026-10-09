// =====================================================================
// Certification Tracker — shared code for the view-only page and the editor.
// Load order: tracker.js (this file: data, layout, home, lists, search, Regulatory Library),
// projects.js (Projects pages), atd.js (ATD Approvals), then editor.js on the editor page.
// Each page sets window.TRACKER_EDITOR (editor only) and its own GitHub connection, then calls load().
// =====================================================================
const EDITOR = !!window.TRACKER_EDITOR;
const VERSION = 'v3.2.0';

// v3: all data (projects, library, regulatory PDFs and search indexes) lives in a private repo.
// Every reader needs a key: viewers a read-only key, the editor a read-and-write key.
const SETTINGS_KEY = 'gh_cert_tracker_settings';
const VIEW_KEY = 'cert-tracker-view-key';
const FILE_PATH_DEFAULT = 'data/certifications.json';
const DATA_REPO = {owner: 'Certification-Tracker', repo: 'tracker-data', branch: 'main', path: FILE_PATH_DEFAULT};
const V2_ARCHIVE_URL = 'https://github.com/wjen5116/Certification-Projects/commits/main';

// Fixed lists keep names consistent (3.0). A value already in the data stays selectable.
const AUTHORITIES = ['EASA', 'FAA', 'Transport Canada', 'UK CAA', 'CAA-HU', 'HCAA'];
const LEVEL_SUGGESTIONS = ['FNPT I', 'FNPT II', 'FNPT II MCC', 'FTD Level 1', 'FTD Level 2', 'FTD Level 4', 'FTD Level 5',
  'FTD Level 6', 'FFS Level A', 'FFS Level B', 'FFS Level C', 'FFS Level D', 'BITD', 'BATD', 'AATD', 'Level 2 FTD - MCC'];
const QUAL_STATUSES = ['Pending', 'Conditional', 'Qualified', 'Expired', 'Withdrawn'];

// =====================================================================
// Data (3.2): devices and projects
// data/certifications.json = {schemaVersion: 4, devices: [...], projects: [...]}
//   device:  one simulator (customer + SN): simModel, simLocation, contactName, contactEmail, docLocation,
//            and the documents, tasks and document history that apply to every aircraft on it.
//   project: one aircraft certification on a device: deviceId, authority, country, level, aircraft, date,
//            qualification, completed, and its own documents, tasks and document history.
// A project also answers for its device's fields (p.customer, p.serial ...) through read-only getters
// that are never saved with the project.
// =====================================================================
const SCHEMA_VERSION = 4;
const DEVICE_FIELDS = ['customer', 'serial', 'simModel', 'simLocation', 'contactName', 'contactEmail', 'docLocation'];

let devices = [];
let projects = [];
let deviceIndex = new Map();
let projectIndex = new Map();
let deviceProjects = new Map();
let currentSha = null;
let lastFetchAt = 0;

function reindex(){
  deviceIndex = new Map(devices.map(d => [d.id, d]));
  projectIndex = new Map(projects.map(p => [p.id, p]));
  deviceProjects = new Map();
  projects.forEach(p => {
    linkProject(p);
    if(!deviceProjects.has(p.deviceId)) deviceProjects.set(p.deviceId, []);
    deviceProjects.get(p.deviceId).push(p);
  });
}

const deviceById = id => deviceIndex.get(id) || null;
const projectById = id => projectIndex.get(id) || null;
const ownerById = id => projectById(id) || deviceById(id);
const isDevice = o => !!o && deviceIndex.get(o.id) === o;
const projectsOf = deviceId => deviceProjects.get(deviceId) || [];
const multiProject = deviceId => projectsOf(deviceId).length > 1;
const deviceOf = o => isDevice(o) ? o : (o ? deviceById(o.deviceId) : null);

function linkProject(p){
  if(Object.getOwnPropertyDescriptor(p, 'device')) return p;
  Object.defineProperty(p, 'device', {get(){ return deviceById(p.deviceId); }, enumerable: false, configurable: true});
  DEVICE_FIELDS.forEach(k => Object.defineProperty(p, k, {
    get(){ const d = deviceById(p.deviceId); return d ? (d[k] || '') : ''; },
    set(){ /* device fields are edited on the device */ },
    enumerable: false, configurable: true
  }));
  return p;
}

function setData(data){
  devices = data.devices;
  projects = data.projects;
  reindex();
}

function wrapData(){
  return {schemaVersion: SCHEMA_VERSION, devices, projects};
}

const arr = v => Array.isArray(v) ? v : [];
const isV4 = raw => !!raw && !Array.isArray(raw) && raw.schemaVersion >= 4 && Array.isArray(raw.devices);

function normalizeV4(raw){
  const devs = arr(raw.devices).filter(d => d && d.id).map(d => ({...d, docs: arr(d.docs), tasks: arr(d.tasks), docChangeLog: arr(d.docChangeLog)}));
  const projs = arr(raw.projects).filter(p => p && p.id).map(p => ({...p, docs: arr(p.docs), tasks: arr(p.tasks), docChangeLog: arr(p.docChangeLog),
    qualification: p.qualification && typeof p.qualification === 'object' ? p.qualification : {}}));
  return {devices: devs, projects: projs};
}

// Any saved file -> {data, converted, report}. v3 files (and v2 lists) are converted in memory;
// the editor saves the converted file after showing what changes (editor.js).
function readData(raw){
  if(isV4(raw)) return {data: normalizeV4(raw), converted: false};
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.certifications) ? raw.certifications : []);
  const out = convertToV4(list);
  return {data: out.data, converted: true, report: out.report};
}

function slug(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Deterministic: the same customer and SN always give the same device id.
function deviceIdFor(customer, serial, fallback){
  return 'v-' + (slug(customer) || 'unassigned') + '--' + (slug(serial) || slug(fallback) || 'no-sn');
}

// ---- v3 -> v4 converter ----
// Also tidies the older formats the editor used to fix on every load (contact text, old task shapes,
// "Next task" text, plain-text documents, missing ids).
function legacyProject(c, ci, fix){
  const p = JSON.parse(JSON.stringify(c));
  const today = localToday();
  if(p.primaryContact !== undefined && p.contactName === undefined && p.contactEmail === undefined){
    const sc = splitContact(p.primaryContact);
    p.contactName = sc.name; p.contactEmail = sc.email; fix();
  }
  delete p.primaryContact;
  p.tasks = arr(p.activityLog).map((a, i) => {
    if(!a || typeof a !== 'object') return null;
    if(a.description === undefined){
      fix();
      return {id: a.id || 'a' + ci + '-' + i, description: a.text || '', status: 'Complete', dateCreated: a.date || today,
        dateDue: '', dateUpdated: a.date || today, dateCompleted: a.date || today};
    }
    const t = {...a};
    if(!t.id){ t.id = 'a' + ci + '-' + i; fix(); }
    if(!t.status){ t.status = 'Complete'; fix(); }
    if(t.status === 'Pending'){ t.status = 'Not Started'; fix(); }
    if(t.status === 'Complete' && !t.dateCompleted){ t.dateCompleted = t.dateUpdated || t.dateCreated || today; fix(); }
    return t;
  }).filter(Boolean);
  if(p.change && String(p.change).trim()){
    p.tasks.push({id: 'a' + ci + '-next', description: String(p.change).trim(), status: 'Not Started', dateCreated: today, dateDue: '', dateUpdated: today});
    fix();
  }
  delete p.activityLog; delete p.change;
  p.docs = arr(p.docs).map((d, i) => {
    const doc = typeof d === 'string' ? (fix(), {name: d, url: ''}) : {...d};
    if(!doc.id){ doc.id = 'd' + ci + '-' + i; fix(); }
    return doc;
  });
  p.docChangeLog = arr(p.docChangeLog).map((e, i) => e.id ? e : (fix(), {...e, id: 'l' + ci + '-' + i}));
  p.qualification = p.qualification && typeof p.qualification === 'object' ? p.qualification : {};
  return p;
}

function convertToV4(list){
  const report = {devices: [], conflicts: [], merged: {tasks: 0, docs: 0, history: 0}, fixes: 0, projects: 0};
  const fix = () => { report.fixes++; };
  const items = arr(list).filter(c => c && typeof c === 'object').map((c, ci) => legacyProject(c, ci, fix));
  report.projects = items.length;
  // Group by customer + SN (a project without an SN is a device of its own).
  const groups = new Map();
  items.forEach(p => {
    const key = (p.customer || '').trim().toLowerCase() + '|' + ((p.serial || '').trim().toLowerCase() || '#' + p.id);
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const outDevices = [], outProjects = [];
  const usedIds = new Set();
  groups.forEach(group => {
    const first = group[0];
    let id = deviceIdFor(first.customer, first.serial, first.id), n = 2;
    while(usedIds.has(id)) id = deviceIdFor(first.customer, first.serial, first.id) + '-' + (n++);
    usedIds.add(id);
    const dev = {id, docs: [], tasks: [], docChangeLog: []};
    DEVICE_FIELDS.forEach(k => {
      const values = group.map(p => String(p[k] || '').trim()).filter(Boolean);
      dev[k] = values[0] || '';
      const other = [...new Set(values)].filter(v => v !== dev[k]);
      if(other.length) report.conflicts.push({device: (first.customer || 'Unassigned') + ' / ' + (first.serial || 'no SN'), field: k, kept: dev[k], other});
    });
    // Identical items on every aircraft of the device move to the device.
    if(group.length > 1){
      const moveCommon = (key, sig, merge) => {
        const sigs = group.map(p => new Map(p[key].map(x => [sig(x), x])));
        const common = [...sigs[0].keys()].filter(s => sigs.every(m => m.has(s)));
        common.forEach(s => {
          const copies = sigs.map(m => m.get(s));
          dev[key].push(merge ? merge(copies) : copies[0]);
          group.forEach((p, i) => { p[key] = p[key].filter(x => x !== copies[i]); });
        });
        return common.length;
      };
      report.merged.tasks += moveCommon('tasks',
        t => [String(t.description || '').trim().toLowerCase(), t.status, t.dateDue || '', t.dateCreated || ''].join('|'),
        copies => {
          const seen = new Set();
          const comments = copies.flatMap(t => arr(t.comments)).filter(cm => { const k = (cm.date || '') + '|' + cm.text; if(seen.has(k)) return false; seen.add(k); return true; })
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
          return {...copies[0], comments};
        });
      report.merged.docs += moveCommon('docs', d => (d.name || '') + '|' + (d.url || ''));
      report.merged.history += moveCommon('docChangeLog', e => (e.date || '') + '|' + (e.text || ''));
    }
    outDevices.push(dev);
    report.devices.push({customer: dev.customer || 'Unassigned', serial: dev.serial, projects: group.length});
    group.forEach(p => {
      const proj = {id: p.id, deviceId: id};
      ['name', 'nameAuto', 'authority', 'country', 'level', 'aircraft', 'date', 'completed', 'dateCompleted'].forEach(k => { if(p[k] !== undefined) proj[k] = p[k]; });
      Object.assign(proj, {qualification: p.qualification, docs: p.docs, tasks: p.tasks, docChangeLog: p.docChangeLog});
      outProjects.push(proj);
    });
  });
  // Task and document ids stay unique across the file (lookups and page anchors use them).
  const seenIds = new Set();
  let k = 0;
  const unique = (x, prefix) => { if(seenIds.has(x.id)){ x.id = prefix + Date.now().toString(36) + '-' + (k++); report.fixes++; } seenIds.add(x.id); };
  [...outDevices, ...outProjects].forEach(o => { o.tasks.forEach(t => unique(t, 'a')); o.docs.forEach(d => unique(d, 'd')); });
  return {data: {devices: outDevices, projects: outProjects}, report};
}

// ---- Scope: the page you are on (a project, or a device) and the records it shows ----
// A project page shows its device's items and its own; a device page shows the device's and every project's.
function scopeOwners(ctx){
  if(!ctx) return [];
  if(isDevice(ctx)) return [ctx, ...sortProjects(projectsOf(ctx.id))];
  const d = ctx.device;
  return d ? [d, ctx] : [ctx];
}

function scopedList(ctx, key){
  return scopeOwners(ctx).flatMap(owner => arr(owner[key]).map(item => ({item, owner})));
}

// Small tags saying where an item belongs, shown when the device has more than one aircraft.
function shortProjectLabel(p){ return p.aircraft || p.level || projectName(p); }

function scopeTag(owner, ctx){
  if(!owner || !multiProject(deviceOf(ctx) ? deviceOf(ctx).id : '')) return '';
  if(isDevice(owner)) return '<span class="scope-tag dev" title="Applies to every aircraft on this device">All aircraft</span>';
  if(isDevice(ctx)) return `<span class="scope-tag proj" title="${escapeHtml(projectName(owner))}">${escapeHtml(shortProjectLabel(owner))}</span>`;
  return '';
}

// =====================================================================
// Where you are
// view is what the main panel shows (kept in the page address, so a refresh keeps your place):
//   home | projects | device {id} | project {id} | doc {ctx, doc} | list {key} | search {q, tab}
//   | library | reg {id, page} | atd | atd-dev {id, doc, page} | v2log (editor) | history (editor)
// =====================================================================
let view = parseHash();
let navFrom = null;        // the list or search a page was opened from (for "Back to …")
let pendingFocus = null;   // task to scroll to after the next render
const openThreads = new Set();     // tasks whose comment thread is open (kept while the page is open)

// Old list names (3.1) still open.
const LIST_ALIASES = {'certs-': 'proj-', 'act-': 'task-'};

function parseHash(){
  let h = '';
  try{ h = decodeURIComponent(location.hash.slice(1)); }catch(e){}
  if(!h) return {type: 'home'};
  if(h === 'projects') return {type: 'projects'};
  if(h === 'library') return {type: 'library'};
  if(h === 'history') return {type: 'history'};
  if(h === 'atd') return {type: 'atd'};
  if(h === 'v2-changelog') return {type: 'v2log'};
  if(h.startsWith('device/')) return {type: 'device', id: h.slice(7)};
  if(h.startsWith('list/')){
    let key = h.slice(5);
    Object.entries(LIST_ALIASES).forEach(([a, b]) => { if(key.startsWith(a)) key = b + key.slice(a.length); });
    return {type: 'list', key};
  }
  if(h.startsWith('atd/')){
    const m = h.slice(4).match(/^([^/]+)(?:\/(loa|qag))?(?:\/p(\d+))?$/);
    return m ? {type: 'atd-dev', id: m[1], doc: m[2] || '', page: Number(m[3]) || 1} : {type: 'atd'};
  }
  if(h.startsWith('search/')) return {type: 'search', q: h.slice(7), tab: 'all'};
  if(h.startsWith('doc/')){
    const parts = h.slice(4).split('/');
    return {type: 'doc', ctx: parts[0], doc: parts[1] || ''};
  }
  if(h.startsWith('reg/')){
    const m = h.slice(4).match(/^(.*?)(?:\/p(\d+))?$/);
    return {type: 'reg', id: m[1], page: Number(m[2]) || 1};
  }
  return {type: 'project', id: h};
}

function viewHash(v){
  switch(v.type){
    case 'project': return v.id;
    case 'device': return 'device/' + v.id;
    case 'projects': case 'library': case 'history': case 'atd': return v.type;
    case 'list': return 'list/' + v.key;
    case 'search': return 'search/' + v.q;
    case 'doc': return 'doc/' + v.ctx + '/' + v.doc;
    case 'reg': return 'reg/' + v.id + (v.page > 1 ? '/p' + v.page : '');
    case 'v2log': return 'v2-changelog';
    case 'atd-dev': return 'atd/' + v.id + (v.doc ? '/' + v.doc : '') + (v.doc && v.page > 1 ? '/p' + v.page : '');
  }
  return '';
}

function rememberPlace(){
  const h = viewHash(view);
  const target = h ? '#' + h.split('/').map(encodeURIComponent).join('/') : '';
  if(location.hash !== target){
    // replaceState: update the address without adding a Back-button step per click.
    try{ history.replaceState(null, '', location.pathname + location.search + target); }catch(e){}
  }
  saveTreeState();
}

// A link pasted into this tab's address bar.
window.addEventListener('hashchange', () => {
  const next = parseHash();
  if(viewHash(next) === viewHash(view)) return;
  navigate(next);
});

function navigate(v, from){
  view = v;
  navFrom = from || null;
  render();
  // Phones: the main panel sits below the sidebar, so bring it into view.
  if(isPhone() && v.type !== 'home'){
    const d = document.getElementById('detail');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(d) d.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'start'});
  }
}

function goHome(){ navigate({type: 'home'}); }
function openProjects(){ navigate({type: 'projects'}); }
function openLibrary(){ navigate({type: 'library'}); }
function openProject(id){ navigate({type: 'project', id}); }
function openDevice(id){ navigate({type: 'device', id}); }
// A device with one aircraft opens straight to its project.
function openDeviceOrProject(id){
  const list = projectsOf(id);
  if(list.length === 1) openProject(list[0].id); else openDevice(id);
}

function goBack(){
  if(!navFrom) return;
  const from = navFrom;
  navigate(from.type === 'list' ? {type: 'list', key: from.key} : {type: 'search', q: from.q, tab: from.tab || 'all'});
}

function backLinkHtml(){
  if(!navFrom) return '';
  let label = '';
  if(navFrom.type === 'list'){
    const m = summaryMeasure(navFrom.key);
    label = m ? `Back to ${escapeHtml(m.label)} (${m.items().length})` : 'Back to list';
  }else{
    label = `Back to results for \u201c${escapeHtml(navFrom.q)}\u201d`;
  }
  return backBtn(label, 'goBack()');
}

function backBtn(label, onclick){
  return `<button class="back-link" type="button" onclick="${onclick}">${ICON.arrowLeft}<span>${label}</span></button>`;
}

// =====================================================================
// Page layout
// The sidebar and main panel are separate containers. The main panel is only redrawn when its
// content actually changes, so an open PDF, scroll position or comment being typed survives
// background refreshes.
// =====================================================================
let lastDetailHtml = null;

function render(){
  regMemo = new Map();
  reindex();
  syncSearchInput();
  const list = document.getElementById('list');
  if(!list || (EDITOR && !ghConfig)) return;

  if(view.type === 'project' && !projectById(view.id)) view = {type: 'projects'};
  if(view.type === 'device' && !deviceById(view.id)) view = {type: 'projects'};
  if(view.type === 'reg' && libraryLoaded && !libraryDoc(view.id)) view = {type: 'library'};
  if(view.type === 'atd-dev' && atdLoaded && !atdDevice(view.id)) view = {type: 'atd'};
  if((view.type === 'v2log' || view.type === 'history') && !EDITOR) view = {type: 'home'};
  if(view.type === 'doc' && !findScopedDoc(view.ctx, view.doc)) view = ownerById(view.ctx) ? ctxView(ownerById(view.ctx)) : {type: 'projects'};
  rememberPlace();

  if(!document.getElementById('detail')){
    list.innerHTML = `
      <div class="layout">
        <nav class="sidebar" id="sidebar" aria-label="Tracker navigation"></nav>
        <section class="detail" id="detail" aria-live="polite"></section>
      </div>`;
    lastDetailHtml = null;
  }
  document.querySelector('.layout').classList.toggle('side-collapsed', sidebarIsCollapsed());
  document.getElementById('sidebar').innerHTML = renderSidebar();

  const html = renderMain();
  if(html !== lastDetailHtml){
    document.getElementById('detail').innerHTML = html;
    lastDetailHtml = html;
  }
  afterRender();
}

const ctxView = o => isDevice(o) ? {type: 'device', id: o.id} : {type: 'project', id: o.id};

function renderMain(){
  rowActions = [];
  switch(view.type){
    case 'projects': return renderProjectsView();
    case 'device': return backLinkHtml() + renderDeviceView(deviceById(view.id));
    case 'project': return backLinkHtml() + renderProjectView(projectById(view.id));
    case 'doc': return renderDrivePreview();
    case 'list': return renderListView(view.key);
    case 'search': return renderSearchView();
    case 'library': return renderLibraryView();
    case 'reg': return renderRegView();
    case 'atd': return renderAtdView();
    case 'atd-dev': return renderAtdDevice();
    case 'v2log': return renderV2Log();
    case 'history': return typeof renderHistoryView === 'function' ? renderHistoryView() : renderHome();
  }
  return renderHome();
}

function afterRender(){
  if(pendingFocus){
    const el = document.getElementById('task-' + pendingFocus);
    pendingFocus = null;
    if(el){
      el.scrollIntoView({block: 'center'});
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
  }
  if(view.type === 'search'){ ensureRegSearch(); ensureAtdSearch(); }
  if(view.type === 'reg') attachRegPdf();
  if(view.type === 'atd-dev') attachAtdPdf();
  if(view.type === 'v2log' && EDITOR) loadV2Log();
  if(view.type === 'history' && EDITOR && typeof loadHistory === 'function') loadHistory();
}

const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

// =====================================================================
// Sidebar (3.2): Home, Projects, ATD Approvals, Regulatory Library. Everything opens in the main panel.
// Collapsible to a 44px icon strip (kept per browser); phones always show it in full.
// =====================================================================
const SIDEBAR_KEY = 'cert-tracker-sidebar-collapsed';
let sidebarCollapsed = false;
try{ sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1'; }catch(e){}

function sidebarIsCollapsed(){ return sidebarCollapsed && !isPhone(); }

function setSidebarCollapsed(on){
  sidebarCollapsed = !!on;
  try{ localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? '1' : '0'); }catch(e){}
  render();
}

function navItems(){
  const open = allTasks().filter(x => taskGroupOf(x.a) !== 'Complete');
  const late = open.filter(x => isTaskOverdue(x.a)).length;
  const ups = regUpdates().length;
  const behind = EDITOR && atdLoaded ? kbBehind().length : 0;
  const t = view.type;
  return [
    {label: 'Home', icon: ICON.home, onclick: 'goHome()', active: t === 'home'},
    {label: 'Projects', icon: ICON.cert, onclick: 'openProjects()', active: ['projects', 'device', 'project', 'doc'].includes(t),
      badge: open.length ? {n: open.length, cls: late ? 'late' : '', title: countLabel(open.length, 'open task', 'open tasks') + (late ? `, ${late} overdue` : '')} : null},
    atdLoaded && atd.devices.length ? {label: 'ATD Approvals', icon: ICON.device, onclick: 'openAtd()', active: t === 'atd' || t === 'atd-dev',
      badge: behind ? {n: behind, cls: 'late', title: 'Knowledge base behind the spreadsheet'} : null} : null,
    {label: 'Regulatory Library', icon: ICON.books, onclick: 'openLibrary()', active: t === 'library' || t === 'reg',
      badge: ups ? {n: ups, cls: 'gold', title: countLabel(ups, 'update available', 'updates available')} : null}
  ].filter(Boolean);
}

function renderSidebar(){
  const items = navItems();
  const badge = b => b ? `<span class="nav-badge ${b.cls}" title="${b.title}">${b.n}</span>` : '';
  if(sidebarIsCollapsed()){
    return `<button class="strip-btn strip-toggle" type="button" onclick="setSidebarCollapsed(false)" title="Expand sidebar" aria-label="Expand sidebar" aria-expanded="false">${ICON.chevronsRight}</button>`
      + items.map(it => `<button class="strip-btn ${it.active ? 'active' : ''}" type="button" onclick="${it.onclick}" title="${it.label}${it.badge ? ' \u00b7 ' + it.badge.title : ''}" aria-label="${it.label}" ${it.active ? 'aria-current="page"' : ''}>${it.icon}${badge(it.badge)}</button>`).join('');
  }
  const btn = it => `<button class="side-nav ${it.active ? 'active' : ''}" type="button" onclick="${it.onclick}" ${it.active ? 'aria-current="page"' : ''}>${it.icon}<span class="side-nav-label">${it.label}</span>${badge(it.badge)}</button>`;
  return `
    <div class="side-top">${btn(items[0])}<button class="side-collapse" type="button" onclick="setSidebarCollapsed(true)" title="Collapse sidebar" aria-label="Collapse sidebar" aria-expanded="true">${ICON.chevronsLeft}</button></div>
    ${items.slice(1).map(btn).join('')}`;
}

// =====================================================================
// Home: what needs attention in each section
// =====================================================================
const HOME_ROWS_MAX = 6;

function renderHome(){
  const customers = new Set(devices.map(customerKey)).size;
  return `
    <div class="home">
      <h2 class="home-title">Certification Tracker <span class="home-version">${VERSION}</span></h2>
      <p class="home-counts">${countLabel(projects.length, 'project', 'projects')} \u00b7 ${countLabel(customers, 'customer', 'customers')} \u00b7 ${countLabel(library.documents.length, 'regulatory document', 'regulatory documents')}${atd.devices.length ? ' \u00b7 ' + countLabel(atd.devices.length, 'ATD device', 'ATD devices') : ''}</p>
      ${renderKbBehindNotice()}
      <div class="home-cards">
        <div class="home-col">${renderProjectsHome()}</div>
        <div class="home-col">${renderAtdHome()}${renderRegHome()}</div>
      </div>
      <p class="home-hint">Choose Projects, ATD Approvals or the Regulatory Library from the sidebar, or search (press <kbd>/</kbd>).</p>
    </div>`;
}

function homeCard(title, headRight, body){
  return `<section class="home-card"><div class="home-card-head"><b>${title}</b>${headRight || ''}</div>${body}</section>`;
}

// tags: why the row is there ([label, cls] pairs); action: what clicking it opens (see openRow).
function homeRow(tags, text, side, action){
  rowActions.push(action);
  return `<button class="home-row" type="button" onclick="openRow(${rowActions.length - 1})"><span class="home-tags">${tags.filter(t => t && t[0]).map(([t, c]) => `<span class="pill pill-${c} home-tag">${escapeHtml(t)}</span>`).join('')}</span><span class="home-row-text">${text}</span><span class="home-row-side">${side || ''}</span></button>`;
}

// "in 4 days" / "tomorrow" / "today" / "2 days overdue", with the date under it (3.1.3).
function countdownHtml(iso, alert){
  const n = daysUntil(iso);
  const label = n < 0 ? `${countLabel(-n, 'day', 'days')} overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
  const cls = n < 0 ? 'cd-late' : (n <= 1 || alert) ? 'cd-soon' : '';
  return `<b class="countdown ${cls}">${label}</b>${fmtDate(iso).replace(/, \d{4}$/, iso.slice(0, 4) === localToday().slice(0, 4) ? '' : '$&')}`;
}

function homeClear(text){ return `<div class="home-clear">${text}</div>`; }

function renderProjectsHome(){
  if(!projects.length) return '';
  const today = localToday(), week = isoAddDays(today, 7);
  const open = allTasks().filter(x => taskGroupOf(x.a) !== 'Complete');
  const projLate = sortProjects(projects.filter(isProjectLate));
  const taskLate = open.filter(x => isTaskOverdue(x.a)).sort((x, y) => dateCmp(x.a.dateDue, y.a.dateDue));
  const taskWeek = open.filter(x => !isTaskOverdue(x.a) && x.a.dateDue && x.a.dateDue >= today && x.a.dateDue <= week);
  const projDue = projectsDueWithin(30);
  const qualExpired = projects.filter(qualExpiredNow);
  const qualExp = projects.filter(p => dateWithin(qual(p).expiryDate, 90));
  const qualCond = projects.filter(p => qual(p).status === 'Conditional');
  // Waiting: oldest first; several on one page share a row.
  const waitingBy = {};
  open.filter(x => taskGroupOf(x.a) === 'Waiting').forEach(x => (waitingBy[x.c.id] = waitingBy[x.c.id] || []).push(x));

  const who = c => escapeHtml(customerKey(c));
  const taskText = x => `${who(x.c)} \u00b7 ${escapeHtml(plainSnippet(x.a.description, 90))}`;
  const taskAction = x => ({type: 'task', ownerId: x.owner.id, taskId: x.a.id});
  const projText = p => `${who(p)} \u00b7 ${escapeHtml(projectName(p))}`;
  const projAction = p => ({type: 'project', id: p.id});
  // One list (3.1.1): soonest date first (overdue items lead), then undated items, oldest Waiting first.
  // An item that meets several rules is one row carrying each reason.
  const items = new Map();
  const add = (key, date, tag, cls, text, action, alert) => {
    const it = items.get(key) || {date: '', tags: [], text, action};
    if(tag && !it.tags.some(t => t[0] === tag)) it.tags.push([tag, cls]);
    if(date && (!it.date || date < it.date)) it.date = date;
    if(alert) it.alert = true;
    items.set(key, it);
  };
  projLate.forEach(p => add('p' + p.id, p.date, 'Overdue', 'alert-overdue', projText(p), projAction(p)));
  taskLate.forEach(x => add('t' + x.a.id, x.a.dateDue, 'Overdue', 'alert-overdue', taskText(x), taskAction(x)));
  qualExpired.forEach(p => add('q' + p.id, qual(p).expiryDate || '', 'Expired', 'alert-overdue', projText(p), projAction(p)));
  taskWeek.forEach(x => add('t' + x.a.id, x.a.dateDue, null, '', taskText(x), taskAction(x)));
  qualExp.forEach(p => add('q' + p.id, qual(p).expiryDate, 'Expiring', 'alert-expiring', projText(p), projAction(p), true));
  projDue.forEach(p => add('p' + p.id, p.date, null, '', projText(p), projAction(p)));
  qualCond.forEach(p => add('q' + p.id, qual(p).expiryDate || '', 'Conditional', 'gold', projText(p), projAction(p)));
  Object.values(waitingBy).forEach(list => {
    const multi = list.length > 1;
    const due = list.map(x => x.a.dateDue).filter(Boolean).sort()[0] || '';
    const key = multi ? 'w' + list[0].c.id : 't' + list[0].a.id;
    add(key, due, 'Waiting', 'plum', multi ? `${who(list[0].c)} \u00b7 ${list.length} tasks` : taskText(list[0]), taskAction(list[0]));
    const it = items.get(key);
    if(!it.since) it.since = list.map(x => x.a.waitingSince).filter(Boolean).sort()[0] || '';
  });
  const sorted = [...items.values()].sort((a, b) => dateCmp(a.date, b.date) || dateCmp(a.since, b.since));
  const rows = sorted.map(it => homeRow(it.tags, it.text,
    it.date ? countdownHtml(it.date, it.alert) : (it.since ? 'since ' + fmtDate(it.since) : 'no date'), it.action));
  const clear = [];
  if(!projLate.length && !taskLate.length) clear.push('Nothing overdue');
  if(!taskWeek.length) clear.push('no tasks due this week');
  if(!projDue.length) clear.push('no projects due in 30 days');
  if(!qualExp.length && !qualExpired.length) clear.push('no qualifications expiring in 90 days');
  if(clear.length) clear[0] = clear[0][0].toUpperCase() + clear[0].slice(1);
  const lists = [['proj-overdue', projLate.length], ['task-overdue', taskLate.length], ['task-week', taskWeek.length], ['proj-due30', projDue.length],
    ['qual-exp90', qualExp.length], ['qual-cond', qualCond.length], ['task-wait', Object.values(waitingBy).reduce((n, l) => n + l.length, 0)]].filter(([, n]) => n);
  const more = rows.length > HOME_ROWS_MAX
    ? `<div class="home-more">Show all: ${lists.map(([k, n]) => `<button class="text-link" type="button" onclick="navigate({type: 'list', key: '${k}'})">${escapeHtml(summaryMeasure(k).label)} (${n})</button>`).join(' \u00b7 ')}</div>` : '';
  return homeCard('Projects and Tasks', `<button class="text-link" type="button" onclick="navigate({type: 'list', key: 'task-open'})">${countLabel(open.length, 'open task', 'open tasks')}</button>`,
    rows.slice(0, HOME_ROWS_MAX).join('') + more + (clear.length ? homeClear(clear.join(' \u00b7 ')) : ''));
}

function renderRegHome(){
  if(!library.documents.length) return '';
  const ups = regUpdates();
  const failed = EDITOR ? library.documents.filter(d => (regCheck(d.id) || {}).status === 'error') : [];
  const when = regStatus && regStatus.checkedAt ? fmtDate(String(regStatus.checkedAt).slice(0, 10)) : '';
  const rows = [
    ...ups.map(d => { const n = projectsUsingDoc(d.id, true).length; return homeRow([['Update', 'gold']], `${escapeHtml(docTitle(d))}${n ? ` <span class="row-sub">\u00b7 ${countLabel(n, 'open project', 'open projects')}</span>` : ''}`, `${escapeHtml(regCheck(d.id).latest || 'newer version')} \u00b7 yours: ${escapeHtml(yourCopy(d))}`, {type: 'reg', id: d.id, page: 1}); }),
    ...failed.map(d => homeRow([['Check failed', 'neutral']], escapeHtml(docTitle(d)), 'will retry next week', {type: 'reg', id: d.id, page: 1}))
  ];
  return homeCard('Regulatory Library', `<button class="text-link" type="button" onclick="openLibrary()">Open Regulatory Library ${ICON.arrowRight}</button>`,
    rows.join('') + (ups.length ? '' : homeClear(when ? `All current \u00b7 ${countLabel(library.documents.length, 'document', 'documents')} \u00b7 checked ${when}` : 'Not checked yet')));
}

// ---- v2 change log (editor only): archived in the private data repo at archive/changelog-v2.html ----
let v2LogHtml = null;
let v2LogLoading = false;

function loadV2Log(){
  if(v2LogHtml !== null || v2LogLoading) return;
  v2LogLoading = true;
  ghRaw('archive/changelog-v2.html')
    .then(res => res.text())
    .then(t => { v2LogHtml = t.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, ''); })
    .catch(() => { v2LogHtml = ''; })
    .finally(() => { v2LogLoading = false; lastDetailHtml = null; render(); });
}

function renderV2Log(){
  return `
    <div class="detail-context">Editor / Archive</div>
    <h2 class="detail-title">v2 Change Log</h2>
    <div class="doc-meta">v2.1.1 to v2.5.0, the tracker before v3. For each version's code, see <a href="${V2_ARCHIVE_URL}" target="_blank" rel="noopener">v2 revision history</a>.</div>
    <div class="v2log">${v2LogHtml === null ? '<div class="muted list-empty">Loading\u2026</div>'
      : v2LogHtml || '<div class="muted list-empty">Couldn\u2019t load archive/changelog-v2.html from the data repo.</div>'}</div>`;
}

// =====================================================================
// Lists (opened from the home page)
// =====================================================================
function allTasks(){
  // c: what the row names (the project, or the device for tasks shared by every aircraft); owner: where the task is stored.
  return [
    ...devices.flatMap(d => arr(d.tasks).map(a => ({a, owner: d, c: projectsOf(d.id).length === 1 ? projectsOf(d.id)[0] : d}))),
    ...projects.flatMap(p => arr(p.tasks).map(a => ({a, owner: p, c: p})))
  ];
}

function projectsDueWithin(days){
  const today = localToday(), last = isoAddDays(today, days);
  return projects.filter(p => !p.completed && p.date && p.date >= today && p.date <= last);
}

const qualExpiredNow = p => { const n = daysUntil(qual(p).expiryDate); return (n !== null && n < 0) || qual(p).status === 'Expired'; };
const tasksWhere = test => allTasks().filter(x => test(x.a));

// Each list: g = group, label, kind (what its rows show), color, items().
const MEASURES = {
  'proj-all':      {label: 'All projects', kind: 'project', items: () => projects},
  'proj-open':     {label: 'Open projects', kind: 'project', items: () => projects.filter(p => !p.completed)},
  'proj-overdue':  {label: 'Overdue projects', kind: 'project', color: 'rust', items: () => projects.filter(isProjectLate)},
  'proj-due30':    {label: 'Projects due in 30 days', kind: 'project', items: () => projectsDueWithin(30)},
  'proj-due90':    {label: 'Projects due in 90 days', kind: 'project', items: () => projectsDueWithin(90)},
  'proj-done':     {label: 'Completed projects', kind: 'project', color: 'sage', items: () => projects.filter(p => p.completed)},
  'qual-exp90':    {label: 'Qualifications expiring in 90 days', kind: 'project', color: 'rust', items: () => projects.filter(p => dateWithin(qual(p).expiryDate, 90))},
  'qual-expired':  {label: 'Expired qualifications', kind: 'project', color: 'rust', items: () => projects.filter(qualExpiredNow)},
  'qual-cond':     {label: 'Conditional qualifications', kind: 'project', color: 'gold', items: () => projects.filter(p => qual(p).status === 'Conditional')},
  'task-open':     {label: 'Open Tasks', kind: 'task', items: () => tasksWhere(a => taskGroupOf(a) !== 'Complete')},
  'task-wait':     {label: 'Waiting', kind: 'task', color: 'plum', items: () => tasksWhere(a => taskGroupOf(a) === 'Waiting')},
  'task-overdue':  {label: 'Overdue Tasks', kind: 'task', color: 'rust', items: () => tasksWhere(isTaskOverdue)},
  'task-week':     {label: 'Tasks due in 7 days', kind: 'task', items: () => {
    const today = localToday(), last = isoAddDays(today, 7);
    return tasksWhere(a => taskGroupOf(a) !== 'Complete' && a.dateDue && a.dateDue >= today && a.dateDue <= last);
  }},
  'atd-resubmit':  {label: 'ATD resubmit due', kind: 'atd', color: 'rust', items: () => atd.devices.filter(atdResubmitDue)},
  'atd-pending':   {label: 'ATD pending', kind: 'atd', color: 'slate', items: () => atd.devices.filter(atdPending)},
  'atd-kb-behind': {label: 'KB behind spreadsheet', kind: 'atd', color: 'rust', items: () => EDITOR ? kbBehind() : []}
};

function summaryMeasure(key){ return MEASURES[key] ? {key, ...MEASURES[key]} : null; }

// Sorted by customer, SN, authority, then due or completion date (no date last).
const textCmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, {sensitivity: 'base', numeric: true});
const dateCmp = (a, b) => (!a && !b) ? 0 : !a ? 1 : !b ? -1 : a.localeCompare(b);
const ownerSortCmp = (a, b) => textCmp(customerKey(a), customerKey(b)) || textCmp(a.serial, b.serial) || textCmp(a.authority, b.authority);
const projDate = p => p.completed ? p.dateCompleted : p.date;
const taskDate = a => taskGroupOf(a) === 'Complete' ? a.dateCompleted : a.dateDue;
let rowActions = [];   // what each clickable row in the main panel opens

function sortListItems(kind, items){
  const list = [...items];
  if(kind === 'project') return list.sort((a, b) => ownerSortCmp(a, b) || dateCmp(projDate(a), projDate(b)));
  if(kind === 'task') return list.sort((x, y) => ownerSortCmp(x.c, y.c) || dateCmp(taskDate(x.a), taskDate(y.a)));
  if(kind === 'atd') return atdOrdered(list);
  return list;
}

function dueText(due, done, overdue){
  if(done) return `Completed ${fmtDate(done)}`;
  if(due) return `${overdue ? '<span class="pill pill-overdue">Overdue</span> ' : ''}Due ${fmtDate(due)}`;
  return 'No due date';
}

// "Customer · SN: … · Authority Level" (a device line has no authority).
function ownerLine(c){
  return `<b class="row-strong">${escapeHtml(customerKey(c))}</b> <span class="row-sub">\u00b7 SN: ${escapeHtml(c.serial || '\u2014')}${(c.authority || c.level) ? ' \u00b7 ' + escapeHtml([c.authority, c.level].filter(Boolean).join(' ')) : (isDevice(c) ? ' \u00b7 all aircraft' : '')}</span>`;
}

function plainSnippet(s, max){
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
}

function rowButton(action, left, right){
  rowActions.push(action);
  return `<button class="list-row" type="button" onclick="openRow(${rowActions.length - 1})"><span class="row-main">${left}</span>${right ? `<span class="row-side">${right}</span>` : ''}</button>`;
}

function listRowHtml(kind, item, from){
  if(kind === 'project') return rowButton({type: 'project', id: item.id, from}, ownerLine(item), dueText(item.date, item.completed ? item.dateCompleted : '', isProjectLate(item)));
  if(kind === 'atd') return rowButton({type: 'atd', id: item.id, from}, atdLine(item), atdRowSide(item));
  const {c, a} = item;
  const status = taskStatusLabel(a.status);
  return rowButton({type: 'task', ownerId: item.owner.id, taskId: a.id, from},
    `${ownerLine(c)}<br><span class="pill pill-${taskStatusClass(status)}">${escapeHtml(status)}</span>${escapeHtml(plainSnippet(a.description, 180))}${status === 'Waiting' && a.waitingSince ? ` <span class="row-sub">\u00b7 Waiting since ${fmtDate(a.waitingSince)}</span>` : ''}`,
    dueText(a.dateDue, status === 'Complete' ? a.dateCompleted : '', isTaskOverdue(a)));
}

function openRow(i){
  const act = rowActions[i];
  if(!act) return;
  if(act.type === 'project') return navigate({type: 'project', id: act.id}, act.from);
  if(act.type === 'device') return navigate({type: 'device', id: act.id}, act.from);
  if(act.type === 'reg') return navigate({type: 'reg', id: act.id, page: act.page}, act.from);
  if(act.type === 'atd') return navigate({type: 'atd-dev', id: act.id, doc: act.doc || '', page: act.page || 1}, act.from);
  if(act.type === 'task') openTask(act.ownerId, act.taskId, act.comment, act.from);
}

// Opens the page a task is shown on, with its group (and comments, if asked) open and the task highlighted.
function openTask(ownerId, taskId, comment, from){
  const owner = ownerById(ownerId);
  const a = owner && arr(owner.tasks).find(x => x.id === taskId);
  if(!a) return;
  let target = owner;
  if(isDevice(owner) && projectsOf(owner.id).length === 1) target = projectsOf(owner.id)[0];
  openTaskGroups.add(taskGroupKey(target.id, taskGroupOf(a)));
  if(comment) openThreads.add(a.id);
  pendingFocus = a.id;
  navigate(ctxView(target), from);
}

function renderListView(key){
  const m = summaryMeasure(key);
  if(!m) return renderHome();
  const items = sortListItems(m.kind, m.items());
  const from = {type: 'list', key};
  return `
    <div class="detail-context">Summary</div>
    <h2 class="detail-title ${m.color ? 'c-' + m.color : ''}">${escapeHtml(m.label)} <span class="title-count">(${items.length})</span></h2>
    <div class="row-list">${items.length ? items.map(it => listRowHtml(m.kind, it, from)).join('') : '<div class="muted list-empty">Nothing to show.</div>'}</div>`;
}

// =====================================================================
// Projects: shared rules (pages are in projects.js)
// =====================================================================
function customerKey(o){ return (o.customer || 'Unassigned').trim() || 'Unassigned'; }

// SIM model is read from the serial: skip a leading "R-" prefix, take the letters before the digits
// (R-MCX-100251 -> MCX, FMX-0297 -> FMX). A typed model overrides it.
function detectModel(serial){
  const m = String(serial || '').trim().toUpperCase().match(/^(?:R-)?([A-Z]+)(?=[-\s]?\d)/);
  return m ? m[1] : '';
}

function simModel(o){ return (o.simModel || '').trim() || detectModel(o.serial); }

// "Authority Level - Aircraft (Model)", e.g. "UK CAA FNPT II - Piper PA-28-181 Archer (MCX)"
function autoName(p){
  let n = [p.authority, p.level].map(x => (x || '').trim()).filter(Boolean).join(' ');
  const aircraft = (p.aircraft || '').trim();
  if(aircraft) n = n ? `${n} - ${aircraft}` : aircraft;
  const model = simModel(p);
  if(model) n = n ? `${n} (${model})` : model;
  return n;
}

// Projects without the nameAuto flag keep their typed names.
function projectName(p){
  if(p.nameAuto) return autoName(p) || p.name || 'Untitled project';
  return p.name || autoName(p) || 'Untitled project';
}

function isProjectLate(p){ return !p.completed && !!p.date && daysUntil(p.date) < 0; }

function projectTasks(p){ return scopedList(p, 'tasks').map(x => x.item); }

function projectHasOverdue(p){
  return !p.completed && (isProjectLate(p) || projectTasks(p).some(isTaskOverdue));
}

function projectStatus(p){
  if(p.completed) return {label: 'Completed', cls: 'sage'};
  if(projectHasOverdue(p)) return {label: 'Overdue', cls: 'overdue'};
  const tasks = projectTasks(p);
  if(!tasks.length) return {label: 'No Tasks', cls: 'slate'};
  if(tasks.some(a => taskGroupOf(a) !== 'Complete')) return {label: 'In Progress', cls: 'gold'};
  return {label: 'On Track', cls: 'sage'};
}

// Open first, overdue first, then by due date.
function sortProjects(items){
  return [...items].sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0)
    || (projectHasOverdue(a) ? 0 : 1) - (projectHasOverdue(b) ? 0 : 1)
    || (a.date || '9999').localeCompare(b.date || '9999'));
}

// ---- Qualification (3.0): what the authority granted, and when it lapses ----
function qual(p){ return p.qualification && typeof p.qualification === 'object' ? p.qualification : {}; }

function hasQualification(p){ return Object.entries(qual(p)).some(([k, v]) => !['basis', 'basisRevision', 'basisDocId'].includes(k) && String(v || '').trim()); }

function qualStatusCls(s){
  return {Qualified: 'sage', Conditional: 'gold', Pending: 'slate', Expired: 'overdue', Withdrawn: 'plum'}[s] || 'slate';
}

// ---- Regulation (3.1): the library document a project is qualified against ----
// Set automatically from the authority and level; Edit can pick another (qualification.basis). A completed
// project keeps the issue it was qualified under (qualification.basisRevision).
// Hungary (CAA-HU) and Greece (HCAA) work to EASA's CS-FSTD(A).
const REG_RULES = [
  {auth: /^(EASA|CAA-HU|HCAA)$/i, docAuth: 'EASA', title: /CS-FSTD/i},
  {auth: /^UK CAA$/i, docAuth: 'UK CAA', title: /CS-FSTD/i},
  {auth: /^FAA$/i, level: /ATD/i, docAuth: 'FAA', title: /61-136/},
  {auth: /^FAA$/i, docAuth: 'FAA', title: /Part 60/i},
  {auth: /^Transport Canada$/i, docAuth: 'Transport Canada', title: /9685/}
];

function regRule(p){
  const auth = (p.authority || '').trim(), level = (p.level || '').trim();
  return REG_RULES.find(r => r.auth.test(auth) && (!r.level || r.level.test(level))) || null;
}

// The library authority a project works to (EASA for CAA-HU and HCAA).
function regAuthority(p){ const r = regRule(p); return r ? r.docAuth : (p.authority || '').trim(); }

function autoRegulation(p){
  const rule = regRule(p);
  if(!rule) return null;
  return library.documents.find(d => (d.authority || '') === rule.docAuth && rule.title.test(d.title || '')) || null;
}

// {doc, auto, revision, locked} or null. Worked out once per screen update (cleared in render()).
let regMemo = new Map();
function projectRegulation(p){
  if(regMemo.has(p)) return regMemo.get(p);
  const q = qual(p);
  const locked = !!(p.completed && (q.basisRevision || q.basisDocId));
  const chosen = q.basis ? libraryDoc(q.basis) : null;
  const doc = (locked && q.basisDocId && libraryDoc(q.basisDocId)) || chosen || autoRegulation(p);
  const r = doc ? {doc, auto: !chosen, locked, revision: locked ? q.basisRevision : (doc.revision || '')} : null;
  regMemo.set(p, r);
  return r;
}

// "EASA CS-FSTD(A) Issue 2" (the revision isn't repeated when the title already has it).
function regLabel(doc, revision){
  return docTitle(doc) + (revision && !String(doc.title || '').includes(revision) ? ' ' + revision : '');
}

function regulationHtml(p){
  const r = projectRegulation(p);
  if(!r) return EDITOR && libraryLoaded && (p.authority || '').trim() ? '<span class="muted">No matching document in the library</span>' : '\u2014';
  const outdated = r.locked && r.doc.revision && r.revision !== r.doc.revision;
  return `<button class="link-inline" type="button" onclick="openDoc('${r.doc.id}')">${escapeHtml(regLabel(r.doc, r.revision))}</button>`
    + (p.completed ? (outdated ? ` <span class="muted reg-note-inline">(qualified under ${escapeHtml(r.revision)}; library has ${escapeHtml(r.doc.revision)})</span>` : '') : regBadge(r.doc.id))
    + (EDITOR && r.auto ? ' <span class="mode-tag">Automatic</span>' : '');
}

// Records the regulation and issue in force when a project is completed (the editor saves it).
function lockRegulation(p){
  regMemo = new Map();
  const q = {...qual(p)};
  delete q.basisRevision; delete q.basisDocId;
  p.qualification = q;
  const r = projectRegulation(p);
  if(r) p.qualification = {...q, basisDocId: r.doc.id, basisRevision: r.doc.revision || ''};
}

function unlockRegulation(p){
  regMemo = new Map();
  if(!p.qualification) return;
  delete p.qualification.basisRevision;
  delete p.qualification.basisDocId;
}

function projectsUsingDoc(id, openOnly){
  return projects.filter(p => (!openOnly || !p.completed) && ((projectRegulation(p) || {}).doc || {}).id === id);
}

// ---- Tasks: statuses and groups ----
// Statuses: Not Started, In Progress, Waiting (on another party), Complete.
const TASK_GROUPS = ['Not Started', 'In Progress', 'Waiting', 'Complete'];
const openTaskGroups = new Set();   // "<page id>|<status>" groups shown open (kept while the page is open)

function taskStatusLabel(status){ return !status || status === 'Pending' ? 'Not Started' : status; }
function taskStatusClass(status){ return {Complete: 'sage', 'In Progress': 'gold', Waiting: 'plum'}[status] || 'slate'; }
function taskGroupKey(ctxId, status){ return ctxId + '|' + status; }
function taskGroupOf(a){ const s = taskStatusLabel(a.status); return TASK_GROUPS.includes(s) ? s : 'Not Started'; }
function isTaskOverdue(a){ return taskGroupOf(a) !== 'Complete' && !!a.dateDue && daysUntil(a.dateDue) < 0; }

// For completed tasks: how many days after the due date they were completed ('' if on time or unknown).
function lateNote(a){
  if(a.status !== 'Complete' || !a.dateDue || !a.dateCompleted) return '';
  const days = Math.round((new Date(a.dateCompleted + 'T00:00:00') - new Date(a.dateDue + 'T00:00:00')) / 86400000);
  return days > 0 ? ` <span class="late-note">(${countLabel(days, 'day', 'days')} late)</span>` : '';
}

// =====================================================================
// Regulatory Library: stored PDFs (regs/ folder) and certification templates, listed in data/library.json
// =====================================================================
let library = {documents: [], templates: [], searchResetAt: '', searchTally: {}};
let librarySha = null;
let libraryLoaded = false;

function libraryPath(){
  const base = (ghConfig && ghConfig.path) || FILE_PATH_DEFAULT;
  return base.replace(/[^/]*$/, '') + 'library.json';
}

function normalizeLibrary(raw){
  const lib = raw && typeof raw === 'object' ? raw : {};
  return {
    documents: arr(lib.documents).filter(d => d && d.id),
    templates: arr(lib.templates).filter(t => t && t.id),
    searchResetAt: lib.searchResetAt || '',
    searchTally: lib.searchTally && typeof lib.searchTally === 'object' ? lib.searchTally : {}
  };
}

async function loadLibrary(){
  loadAtd();
  try{
    const res = await ghReadJson(libraryPath());
    if(res){ library = normalizeLibrary(res.data); librarySha = res.sha; }
  }catch(e){ /* the library is optional; the tracker works without it */ }
  try{
    const st = await ghReadJson(regStatusPath());
    if(st && st.data && typeof st.data === 'object') regStatus = st.data;
  }catch(e){ /* written weekly by the regulatory check; optional */ }
  libraryLoaded = true;
  applySearchReset();
  render();
}

const libraryDoc = id => library.documents.find(d => d.id === id);
const libraryTemplate = id => library.templates.find(t => t.id === id);

// ---- Weekly regulatory check (results written to data/reg-status.json by .github/workflows/reg-check.yml) ----
let regStatus = null;

function regStatusPath(){ return libraryPath().replace(/library\.json$/, 'reg-status.json'); }
function regCheck(id){ return regStatus && regStatus.documents && regStatus.documents[id] || null; }

function yourCopy(d){
  return [d.revision, d.asOf ? 'as of ' + fmtDate(d.asOf) : ''].filter(Boolean).join(', ') || 'unknown';
}

function regUpdates(){
  return library.documents.filter(d => (regCheck(d.id) || {}).status === 'update').sort((a, b) => textCmp(docTitle(a), docTitle(b)));
}

function regBadge(id){
  const r = regCheck(id);
  if(!r) return '';
  if(r.status === 'update') return `<span class="reg-flag update" title="${escapeHtml(r.found || 'A newer version was found')}">Update: ${escapeHtml(r.latest || 'newer version')}</span>`;
  if(EDITOR && r.status === 'error') return `<span class="reg-flag error" title="${escapeHtml(r.found || '')}">Check failed</span>`;
  return '';
}

function regStatusNote(d){
  const r = regCheck(d.id);
  const when = regStatus && regStatus.checkedAt ? fmtDate(String(regStatus.checkedAt).slice(0, 10)) : '';
  if(!r) return '';
  const w = when ? ` <span class="reg-note-when">Checked ${when}</span>` : '';
  if(r.status === 'update') return `<div class="reg-note update"><strong>Update available: ${escapeHtml(r.latest || 'newer version')}</strong> (your copy: ${escapeHtml(yourCopy(d))}). ${escapeHtml(r.found || '')}${w}</div>`;
  if(r.status === 'current') return `<div class="reg-note current">Stored copy matches the latest version found.${w}</div>`;
  if(r.status === 'unmonitored') return EDITOR ? `<div class="reg-note muted-note">Not monitored: no official source page is set for this document. Add one with Edit so the weekly check can watch it.</div>` : '';
  if(r.status === 'error') return EDITOR ? `<div class="reg-note error">The weekly check couldn't read the official source${r.found ? `: ${escapeHtml(r.found)}` : ''}. It will try again next week.</div>` : '';
  return '';
}

function renderRegUsedBy(d){
  const list = sortProjects(projectsUsingDoc(d.id, false));
  if(!list.length) return '';
  const open = list.filter(p => !p.completed), done = list.filter(p => p.completed);
  const link = p => `<button class="link-inline" type="button" onclick="openProject('${p.id}')">${escapeHtml(customerKey(p))} (${escapeHtml([p.serial, p.aircraft].filter(Boolean).join(', ') || projectName(p))})</button>`;
  return `<div class="reg-used-by"><span class="fk">Used by</span> ${open.map(link).join(', ') || '<span class="muted">no open projects</span>'}${done.length ? ` <span class="muted">\u00b7 ${countLabel(done.length, 'completed project', 'completed projects')}</span>` : ''}</div>`;
}

function docTitle(d){ return `${d.authority ? d.authority + ' ' : ''}${d.title}`; }

function libraryAuthorities(){
  return [...new Set([...library.documents, ...library.templates].map(d => d.authority || 'Other'))].sort(textCmp);
}

// ---- Templates (3.2): Word templates in Google Drive, per authority and (optionally) level ----
// A template is copied into the customer's project folder, then the copy is linked on the project.
function templateLevels(t){ return String(t.levels || '').split(',').map(s => s.trim()).filter(Boolean); }

function templatesFor(p){
  const auths = [(p.authority || '').trim(), regAuthority(p)].filter(Boolean).map(a => a.toLowerCase());
  const level = (p.level || '').trim().toLowerCase();
  return library.templates.filter(t => auths.includes(String(t.authority || '').toLowerCase())
    && (!templateLevels(t).length || templateLevels(t).some(l => l.toLowerCase() === level)))
    .sort((a, b) => textCmp(a.title, b.title));
}

// Google Docs, Sheets and Slides links (Word files opened in Drive included) have a "make a copy" page.
function driveCopyUrl(url){
  const m = String(url || '').match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
  return m ? `https://docs.google.com/${m[1]}/d/${m[2]}/copy` : '';
}

// ---- The Regulatory Library page (3.2: in the main panel; authorities start collapsed) ----
const LIB_OPEN_KEY = 'cert-tracker-library-open';
const openAuthorities = new Set();
const regFlagOpened = new Set();
try{ JSON.parse(sessionStorage.getItem(LIB_OPEN_KEY) || '[]').forEach(a => openAuthorities.add(a)); }catch(e){}

function toggleAuthority(a){
  if(openAuthorities.has(a)) openAuthorities.delete(a); else openAuthorities.add(a);
  render();
}

function toggleAllAuthorities(){
  const auths = libraryAuthorities();
  if(auths.some(a => openAuthorities.has(a))) openAuthorities.clear(); else auths.forEach(a => openAuthorities.add(a));
  render();
}

function renderLibraryView(){
  if(!libraryLoaded) return '<div class="muted">Loading\u2026</div>';
  // An authority with an update opens once, so the flag can't hide in a collapsed group.
  library.documents.forEach(d => {
    if((regCheck(d.id) || {}).status === 'update' && !regFlagOpened.has(d.id)){ openAuthorities.add(d.authority || 'Other'); regFlagOpened.add(d.id); }
  });
  const auths = libraryAuthorities();
  const when = regStatus && regStatus.checkedAt ? fmtDate(String(regStatus.checkedAt).slice(0, 10)) : '';
  const anyOpen = auths.some(a => openAuthorities.has(a));
  const groups = auths.map(auth => {
    const docs = library.documents.filter(d => (d.authority || 'Other') === auth).sort((a, b) => textCmp(a.title, b.title));
    const temps = library.templates.filter(t => (t.authority || 'Other') === auth).sort((a, b) => textCmp(a.title, b.title));
    const ups = docs.filter(d => (regCheck(d.id) || {}).status === 'update').length;
    const open = openAuthorities.has(auth);
    const docRows = docs.map(d => {
      const n = projectsUsingDoc(d.id, true).length;
      return rowButton({type: 'reg', id: d.id, page: 1}, `${ICON.file}<b class="row-strong">${escapeHtml(d.title)}</b> <span class="row-sub">${escapeHtml(d.revision || '')}${d.fullTitle ? ' \u00b7 ' + escapeHtml(d.fullTitle) : ''}</span>${regBadge(d.id)}`,
        n ? countLabel(n, 'open project', 'open projects') : '');
    }).join('');
    const tempRows = temps.map(t => `
      <div class="lib-template">
        <span class="lib-template-main">${ICON.copy}<b class="row-strong">${escapeHtml(t.title)}</b> <span class="row-sub">${templateLevels(t).length ? escapeHtml(templateLevels(t).join(', ')) : 'All levels'}${t.notes ? ' \u00b7 ' + escapeHtml(t.notes) : ''}</span></span>
        <span class="cert-actions">
          ${t.url ? `<a class="btn-text compact" href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer" title="Open in Drive">${ICON.external}<span class="btn-label">Open</span></a>` : ''}
          ${EDITOR ? actionBtn('edit', 'Edit', `openTemplateModal('${t.id}')`) + actionBtn('trash', 'Delete', `deleteTemplate('${t.id}')`, {cls: 'danger'}) : ''}
        </span>
      </div>`).join('');
    return `
      <div class="lib-group">
        <button class="lib-auth" type="button" aria-expanded="${open}" onclick="toggleAuthority('${escapeAttr(auth)}')">${ICON.chevron}<span class="lib-auth-name">${escapeHtml(auth)}</span><span class="row-sub">${countLabel(docs.length, 'document', 'documents')}${temps.length ? ' \u00b7 ' + countLabel(temps.length, 'template', 'templates') : ''}</span>${ups ? `<span class="reg-flag update">${countLabel(ups, 'update', 'updates')}</span>` : ''}</button>
        ${open ? `<div class="lib-body">
          ${docs.length ? `<div class="lib-sub">Regulations</div><div class="lib-rows">${docRows}</div>` : ''}
          ${temps.length ? `<div class="lib-sub">Templates</div><div class="lib-rows">${tempRows}</div>` : ''}
        </div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="detail-head">
      <div>
        <h2 class="detail-title">Regulatory Library <span class="title-count">(${library.documents.length})</span></h2>
        <div class="doc-meta">${countLabel(library.documents.length, 'regulation', 'regulations')} \u00b7 ${countLabel(library.templates.length, 'certification template', 'certification templates')}${when ? ` \u00b7 checked for updates ${when}` : ''}</div>
      </div>
    </div>
    <div class="detail-actions doc-actions">
      ${auths.length ? `<button class="act-toggle-all" type="button" onclick="toggleAllAuthorities()">${anyOpen ? ICON.collapseAll : ICON.expandAll}<span>${anyOpen ? 'Collapse all' : 'Expand all'}</span></button>` : ''}
      ${EDITOR ? actionBtn('plus', 'Add regulation', 'openLibraryModal()', {compact: false}) + actionBtn('plus', 'Add template', 'openTemplateModal()', {compact: false}) : ''}
    </div>
    <div class="lib-groups">${groups || `<div class="muted list-empty">No documents yet.</div>`}</div>
    <div class="muted search-note">Regulations are stored copies, checked weekly against their official sources. Templates are Word files in Google Drive: copy one into the customer's project folder, then link the copy on the project (Documents \u2192 From template).</div>`;
}

function openDoc(id, page){ navigate({type: 'reg', id, page: page || 1}); }

function renderRegView(){
  const d = libraryDoc(view.id);
  if(!d) return libraryLoaded ? renderLibraryView() : '<div class="muted">Loading\u2026</div>';
  const page = view.page || 1;
  const url = pdfPageUrl('regs/' + d.file, page);
  const meta = [d.revision, d.asOf ? 'Copy as of ' + fmtDate(d.asOf) : '', d.pages ? countLabel(d.pages, 'page', 'pages') : ''].filter(Boolean).join(' \u00b7 ');
  return `
    ${navFrom ? backLinkHtml() : backBtn('Regulatory Library', 'openLibrary()')}
    <div class="detail-context">Regulatory Library / ${escapeHtml(d.authority || 'Other')}</div>
    <div class="detail-head">
      <div>
        <h2 class="detail-title">${escapeHtml(docTitle(d))}</h2>
        ${d.fullTitle ? `<div class="doc-full-title">${escapeHtml(d.fullTitle)}</div>` : ''}
        ${meta ? `<div class="doc-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
    </div>
    <div class="detail-actions doc-actions">
      <a class="btn-text pdf-open-link ${url ? '' : 'disabled'}" href="${url || '#'}" ${url ? '' : 'aria-disabled="true"'} target="_blank" rel="noopener">${ICON.external}<span>Open in new tab</span></a>
      ${d.officialUrl ? `<a class="btn-text" href="${escapeHtml(d.officialUrl)}" target="_blank" rel="noopener noreferrer">${ICON.globe}<span>Official source</span></a>` : ''}
      ${EDITOR ? `
        ${actionBtn('edit', 'Edit', `openLibraryModal('${d.id}')`)}
        ${actionBtn('search', 'Rebuild search index', `rebuildIndex('${d.id}')`, {compact: false})}
        ${actionBtn('trash', 'Delete', `deleteLibraryDoc('${d.id}')`, {cls: 'danger'})}` : ''}
    </div>
    ${regStatusNote(d)}
    ${renderRegUsedBy(d)}
    ${EDITOR && !d.indexed ? `<div class="doc-note">This document isn't in the search index yet. Once its PDF is in the data repo's regs/ folder, click Rebuild search index.</div>` : ''}
    ${url ? '' : `<div class="reg-loading" id="pdf-loading">Loading the document&hellip;</div>`}
    ${isPhone()
      ? `<a class="btn-primary open-doc-btn pdf-open-link ${url ? '' : 'disabled'}" href="${url || '#'}" target="_blank" rel="noopener">${ICON.file}<span>Open document</span></a>`
      : `<iframe class="pdf-frame" id="pdf-frame" ${url ? `src="${url}" data-src="${url}"` : 'hidden'} title="${escapeHtml(docTitle(d))}"></iframe>`}`;
}

// PDFs are in the private data repo, so they are fetched with the key and shown from a local copy.
// Shared by the Regulatory Library and the ATD documents; kept for the visit, keyed by repo path.
const pdfBlobs = {};       // path -> blob URL, or '' when it couldn't be loaded
const pdfLoading = {};

function loadPdfBlob(path){
  if(path in pdfBlobs) return Promise.resolve(pdfBlobs[path]);
  if(!pdfLoading[path]){
    pdfLoading[path] = ghRaw(path)
      .then(async res => { pdfBlobs[path] = URL.createObjectURL(new Blob([await res.arrayBuffer()], {type: 'application/pdf'})); })
      .catch(() => { pdfBlobs[path] = ''; })
      .finally(() => { delete pdfLoading[path]; })
      .then(() => pdfBlobs[path]);
  }
  return pdfLoading[path];
}

function pdfPageUrl(path, page){
  const base = pdfBlobs[path];
  return base ? base + (page > 1 ? '#page=' + page : '') : '';
}

// Fills in the PDF frame and "Open" links once the document has downloaded.
// stillHere() says whether the same document is still on screen when the download finishes.
function attachPdf(path, page, stillHere, failText){
  const apply = () => {
    if(!stillHere()) return;
    const status = document.getElementById('pdf-loading');
    if(pdfBlobs[path] === ''){
      if(status){ status.textContent = failText; status.classList.add('error'); }
      return;
    }
    const url = pdfPageUrl(path, page);
    if(!url) return;
    const frame = document.getElementById('pdf-frame');
    if(frame && frame.dataset.src !== url){ frame.src = url; frame.dataset.src = url; frame.hidden = false; }
    document.querySelectorAll('.pdf-open-link').forEach(a => { a.href = url; a.classList.remove('disabled'); a.removeAttribute('aria-disabled'); });
    if(status) status.remove();
  };
  if(path in pdfBlobs) apply();
  else loadPdfBlob(path).then(apply);
}

function attachRegPdf(){
  const d = view.type === 'reg' && libraryDoc(view.id);
  if(!d) return;
  attachPdf('regs/' + d.file, view.page || 1, () => view.type === 'reg' && view.id === d.id,
    `Couldn't load ${d.file} from the data repo. Check it is in the regs/ folder.`);
}

// Page-by-page search text (regs/index/*.json, atd/index/*.json), loaded once per visit and shared.
const pageIndexes = {};    // path -> {lower: [], raw: []}

function loadPageIndex(path){
  if(pageIndexes[path]) return Promise.resolve(pageIndexes[path]);
  return ghRaw(path).then(r => r.json()).then(json => {
    const raw = Array.isArray(json.pages) ? json.pages.map(p => String(p || '')) : [];
    return (pageIndexes[path] = {raw, lower: raw.map(p => p.toLowerCase())});
  }).catch(() => (pageIndexes[path] = {raw: [], lower: []}));   // missing index: search skips it
}

// Every page of one document that contains the term: {hits: [{page, n, snippet}], matches}.
function searchPages(index, t){
  const hits = [];
  let matches = 0;
  index.lower.forEach((lower, i) => {
    let at = findWordStart(lower, t);
    if(at < 0) return;
    const first = at;
    let n = 0;
    while(at > -1){ n++; at = findWordStart(lower, t, at + t.length); }
    matches += n;
    hits.push({page: i + 1, n, snippet: excerpt(index.raw[i], first, t.length)});
  });
  return {hits, matches};
}

// =====================================================================
// Search: projects, tasks, comments, the Regulatory Library and ATD documents
// =====================================================================
let regIndexLoading = null;
const expandedRegResults = new Set();

function normalizeQuery(q){ return String(q || '').trim().replace(/\s+/g, ' '); }

// Matches start at the beginning of a word, so "acme" finds "Acme" but not "placement",
// while partial SNs still match ("100251" finds "R-MCX-100251").
const isWordChar = ch => /[a-z0-9]/i.test(ch || '');
function findWordStart(lower, t, from){
  let at = lower.indexOf(t, from || 0);
  while(at > 0 && isWordChar(lower[at - 1])) at = lower.indexOf(t, at + 1);
  return at;
}
const textHas = (v, t) => findWordStart(String(v || '').toLowerCase(), t) > -1;

function runSearch(q){
  const term = normalizeQuery(q);
  hideSuggestions();
  if(!term) return;
  searchSeq++;
  expandedRegResults.clear();
  navigate({type: 'search', q: term, tab: 'all'});
}

function syncSearchInput(){
  const input = document.getElementById('search-input');
  if(input && view.type === 'search' && document.activeElement !== input) input.value = view.q;
}

function searchProjects(t){
  return sortListItems('project', projects.filter(p =>
    [customerKey(p), p.serial, p.authority, p.level, p.aircraft, projectName(p), simModel(p), p.country,
     ...scopedList(p, 'docs').map(x => x.item.name)].some(v => textHas(v, t))));
}

function searchTasks(t){
  const out = [];
  allTasks().forEach(x => {
    if(textHas(x.a.description, t)) out.push({...x, kind: 'task'});
    arr(x.a.comments).forEach(cm => { if(textHas(cm.text, t)) out.push({...x, cm, kind: 'comment'}); });
  });
  return out.sort((x, y) => ownerSortCmp(x.c, y.c) || dateCmp(taskDate(x.a), taskDate(y.a)));
}

// Loads the page texts for every indexed document (regs/index/<id>.json), once per visit.
const regIndexPath = d => 'regs/index/' + d.id + '.json';

function ensureRegSearch(){
  const docs = library.documents.filter(d => d.indexed && !pageIndexes[regIndexPath(d)]);
  if(!libraryLoaded || regIndexLoading || !docs.length) return;
  regIndexLoading = Promise.all(docs.map(d => loadPageIndex(regIndexPath(d))))
    .then(() => { regIndexLoading = null; lastDetailHtml = null; render(); });
}

function regSearchReady(){
  return libraryLoaded && library.documents.filter(d => d.indexed).every(d => pageIndexes[regIndexPath(d)]);
}

function excerpt(text, at, len){
  let start = Math.max(0, at - 80), end = Math.min(text.length, at + len + 110);
  if(start > 0){ const sp = text.indexOf(' ', start); if(sp > -1 && sp < at) start = sp + 1; }
  if(end < text.length){ const sp = text.lastIndexOf(' ', end); if(sp > at + len) end = sp; }
  return (start > 0 ? '\u2026 ' : '') + text.slice(start, end) + (end < text.length ? ' \u2026' : '');
}

function searchRegs(t){
  return library.documents.filter(d => d.indexed && pageIndexes[regIndexPath(d)])
    .map(d => ({doc: d, ...searchPages(pageIndexes[regIndexPath(d)], t)}))
    .filter(r => r.hits.length)
    .sort((a, b) => textCmp(a.doc.authority, b.doc.authority) || textCmp(a.doc.title, b.doc.title));
}

function highlight(text, term){
  const safe = escapeHtml(text);
  const pattern = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return safe.replace(new RegExp('(?<![A-Za-z0-9])(' + pattern + ')', 'gi'), '<mark>$1</mark>');
}

let searchSeq = 0;
let recordedSeq = -1;

function renderSearchView(){
  const q = view.q;
  const t = q.toLowerCase();
  const from = {type: 'search', q, tab: view.tab};
  const projHits = searchProjects(t);
  const taskHits = searchTasks(t);
  const ready = regSearchReady();
  const regHits = ready ? searchRegs(t) : [];
  const regPages = regHits.reduce((n, r) => n + r.hits.length, 0);
  const atdReady = atdSearchReady();
  const atdHits = atdReady ? searchAtd(t) : {devices: [], docs: [], count: 0};
  const total = projHits.length + taskHits.length + regPages + atdHits.count;
  if(ready && atdReady && total > 0 && recordedSeq !== searchSeq){ recordedSeq = searchSeq; recordSearch(q); }

  const tab = view.tab || 'all';
  const all = tab === 'all';
  const tabs = [['all', 'All', ready && atdReady ? total : null], ['projects', 'Projects', projHits.length], ['tasks', 'Tasks', taskHits.length], ['regs', 'Regulations', ready ? regPages : null]];
  if(atd.devices.length) tabs.push(['atd', 'ATD Approvals', atdReady ? atdHits.count : null]);
  const groupHead = (key, label, count) => `<div class="result-group"><b>${label} <span class="title-count">(${count})</span></b>${all && count > 3 ? `<button class="side-tool" type="button" onclick="setSearchTab('${key}')">Show all</button>` : ''}</div>`;

  let body = '';
  if((all || tab === 'projects') && projHits.length){
    body += groupHead('projects', 'Projects', projHits.length) + projHits.slice(0, all ? 3 : undefined).map(p =>
      rowButton({type: 'project', id: p.id, from}, `<b class="row-strong">${highlight(customerKey(p), q)}</b> <span class="row-sub">\u00b7 SN: ${highlight(p.serial || '\u2014', q)} \u00b7 ${highlight([p.authority, p.level].filter(Boolean).join(' '), q)}${p.aircraft ? ' \u00b7 ' + highlight(p.aircraft, q) : ''}</span>`, dueText(p.date, p.completed ? p.dateCompleted : '', isProjectLate(p)))).join('');
  }
  if((all || tab === 'tasks') && taskHits.length){
    body += groupHead('tasks', 'Tasks and comments', taskHits.length) + taskHits.slice(0, all ? 3 : undefined).map(x => {
      const status = taskStatusLabel(x.a.status);
      const text = x.kind === 'comment' ? x.cm.text : x.a.description;
      return rowButton({type: 'task', ownerId: x.owner.id, taskId: x.a.id, comment: x.kind === 'comment', from},
        `<span class="row-sub">${escapeHtml(customerKey(x.c))} \u00b7 SN: ${escapeHtml(x.c.serial || '\u2014')}</span><br><span class="pill pill-${taskStatusClass(status)}">${escapeHtml(status)}</span>${x.kind === 'comment' ? ICON.comment : ''}${highlight(plainSnippet(text, 200), q)}`,
        x.kind === 'comment' ? 'Comment' : 'Task');
    }).join('');
  }
  if(all || tab === 'regs'){
    if(!ready) body += `<div class="result-group"><b>Regulations</b></div><div class="muted list-empty">Searching the Regulatory Library\u2026</div>`;
    else if(regHits.length){
      body += groupHead('regs', 'Regulations', regPages) + regHits.slice(0, all ? 3 : undefined).map(r => {
        const expanded = expandedRegResults.has(r.doc.id);
        const shown = all ? r.hits.slice(0, 1) : (expanded ? r.hits : r.hits.slice(0, 5));
        return `
          <div class="reg-result">
            <div class="reg-result-head"><b>${escapeHtml(docTitle(r.doc))}</b> <span class="row-sub">${escapeHtml(r.doc.revision || '')} \u00b7 ${countLabel(r.hits.length, 'page', 'pages')} \u00b7 ${countLabel(r.matches, 'match', 'matches')}</span></div>
            ${shown.map(h => rowButton({type: 'reg', id: r.doc.id, page: h.page, from}, `<span class="page-tag">Page ${h.page}</span>${highlight(h.snippet, q)}`, h.n > 1 ? `${h.n} matches` : '')).join('')}
            ${!all && r.hits.length > 5 ? `<button class="side-tool reg-more" type="button" onclick="toggleRegResults('${r.doc.id}')">${expanded ? 'Show fewer' : `Show all ${r.hits.length} pages`}</button>` : ''}
          </div>`;
      }).join('');
    }
  }
  if(all || tab === 'atd') body += renderAtdSearch(atdHits, all, from, q);
  if(!body.trim()) body = `<div class="muted list-empty">No matches${all ? '' : ' in this group'}.</div>`;

  return `
    <div class="detail-context">Search</div>
    <h2 class="detail-title">Results for \u201c${escapeHtml(q)}\u201d</h2>
    <div class="tabs" role="tablist">${tabs.map(([k, l, n]) => `<button class="tab ${tab === k ? 'on' : ''}" role="tab" aria-selected="${tab === k}" type="button" onclick="setSearchTab('${k}')">${l} <span class="tab-n">${n === null ? '\u2026' : n}</span></button>`).join('')}</div>
    <div class="row-list">${body}</div>
    ${ready && regPages ? '<div class="muted search-note">Page numbers are the PDF\u2019s own page numbers, which may differ from the printed page labels.</div>' : ''}`;
}

function setSearchTab(tab){ view = {...view, tab}; render(); }

function toggleRegResults(id){
  if(expandedRegResults.has(id)) expandedRegResults.delete(id); else expandedRegResults.add(id);
  render();
}

// ---- Search suggestions: each person's three most frequent searches (kept in this browser) ----
const SEARCH_HISTORY_KEY = 'cert-tracker-search-history';
let suggestIndex = -1;

function loadSearchHistory(){
  try{
    const h = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || 'null');
    if(h && typeof h.terms === 'object') return h;
  }catch(e){}
  return {terms: {}};
}

function saveSearchHistory(h){
  try{ localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(h)); }catch(e){}
}

// The admin can clear everyone's history: browsers drop searches older than the reset date.
function applySearchReset(){
  const reset = Date.parse(library.searchResetAt || '');
  if(!reset) return;
  const h = loadSearchHistory();
  let changed = false;
  Object.keys(h.terms).forEach(k => { if((h.terms[k].last || 0) < reset){ delete h.terms[k]; changed = true; } });
  if(changed) saveSearchHistory(h);
}

function recordSearch(q){
  const key = normalizeQuery(q).toLowerCase();
  if(!key) return;
  const h = loadSearchHistory();
  const prev = h.terms[key] || {n: 0};
  h.terms[key] = {n: prev.n + 1, last: Date.now(), label: normalizeQuery(q)};
  saveSearchHistory(h);
  if(typeof tallySearch === 'function') tallySearch(key);
}

// Frequent searches, with older ones fading (a search counts half as much after 30 days).
function topSearches(){
  const now = Date.now();
  return Object.values(loadSearchHistory().terms)
    .map(t => ({...t, score: t.n * Math.pow(0.5, (now - (t.last || now)) / (30 * 86400000))}))
    .sort((a, b) => b.score - a.score || b.last - a.last)
    .slice(0, 3);
}

function showSuggestions(){
  const box = document.getElementById('search-suggest');
  const input = document.getElementById('search-input');
  if(!box || !input) return;
  const top = input.value.trim() ? [] : topSearches();
  suggestIndex = -1;
  if(!top.length){ hideSuggestions(); return; }
  box.innerHTML = `<div class="suggest-head">Your frequent searches</div>` + top.map((t, i) =>
    `<button class="suggest-item" type="button" role="option" data-i="${i}" onmousedown="event.preventDefault()" onclick="pickSuggestion(${i})">${ICON.history}<span>${escapeHtml(t.label)}</span></button>`).join('');
  box.dataset.terms = JSON.stringify(top.map(t => t.label));
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function hideSuggestions(){
  const box = document.getElementById('search-suggest');
  const input = document.getElementById('search-input');
  if(box) box.hidden = true;
  if(input) input.setAttribute('aria-expanded', 'false');
  suggestIndex = -1;
}

function pickSuggestion(i){
  const terms = JSON.parse(document.getElementById('search-suggest').dataset.terms || '[]');
  if(!terms[i]) return;
  const input = document.getElementById('search-input');
  input.value = terms[i];
  input.blur();
  runSearch(terms[i]);
}

function moveSuggestion(d){
  const box = document.getElementById('search-suggest');
  if(!box || box.hidden) return false;
  const items = box.querySelectorAll('.suggest-item');
  if(!items.length) return false;
  suggestIndex = (suggestIndex + d + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === suggestIndex));
  return true;
}

// Header search box (press / to jump there).
function initHeader(){
  const input = document.getElementById('search-input');
  if(!input) return;
  input.addEventListener('focus', showSuggestions);
  input.addEventListener('click', showSuggestions);
  input.addEventListener('input', () => { if(input.value.trim()) hideSuggestions(); else showSuggestions(); });
  input.addEventListener('blur', () => setTimeout(hideSuggestions, 120));
  input.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown' && moveSuggestion(1)){ e.preventDefault(); return; }
    if(e.key === 'ArrowUp' && moveSuggestion(-1)){ e.preventDefault(); return; }
    if(e.key === 'Enter'){
      e.preventDefault();
      if(suggestIndex > -1){ pickSuggestion(suggestIndex); return; }
      input.blur();
      runSearch(input.value);
    }
    if(e.key === 'Escape'){ hideSuggestions(); input.blur(); }
  });
  // The clear (×) button in the search box: leave the results.
  input.addEventListener('search', () => { if(!input.value && view.type === 'search') goHome(); });
  document.addEventListener('keydown', e => {
    if(e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || document.querySelector('.modal-bg.open')) return;
    e.preventDefault();
    input.focus();
  });
}

// =====================================================================
// GitHub reads
// =====================================================================
function loadSettings(){
  try{ const raw = localStorage.getItem(SETTINGS_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}

function ghHeaders(){
  const headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
  if(ghConfig && ghConfig.token) headers['Authorization'] = 'Bearer ' + ghConfig.token;
  return headers;
}

function ghRepoUrl(rest){ return `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/${rest}`; }
function ghApiUrl(path){ return ghRepoUrl('contents/' + encodeURIComponent(path).replace(/%2F/g, '/')); }

function b64DecodeUtf8(b64){ return decodeURIComponent(escape(atob(b64))); }

// Reads a JSON file from the repo: {data, sha}, or null if the file doesn't exist yet.
// ref: a branch (default) or a commit, for older versions.
async function ghReadJson(path, ref){
  // no-cache: always check GitHub for a newer copy (unchanged files come back as a quick 304).
  const res = await fetch(ghApiUrl(path) + `?ref=${encodeURIComponent(ref || ghConfig.branch)}`, {headers: ghHeaders(), cache: 'no-cache'});
  if(res.status === 404) return null;
  if(!res.ok){
    const err = new Error(`GitHub read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return {data: JSON.parse(b64DecodeUtf8(json.content.replace(/\n/g, ''))), sha: json.sha};
}

// The data file as saved (any format), or null if there isn't one yet.
async function fetchFromGitHub(){
  lastFetchAt = Date.now();
  const res = await ghReadJson(ghConfig.path);
  if(!res) return null;
  currentSha = res.sha;
  return res.data;
}

// Raw file from the data repo (works for files over 1 MB, up to 100 MB).
async function ghRaw(path){
  const res = await fetch(ghApiUrl(path) + `?ref=${encodeURIComponent(ghConfig.branch)}`,
    {headers: {...ghHeaders(), 'Accept': 'application/vnd.github.raw'}, cache: 'no-cache'});
  if(!res.ok){
    const err = new Error(`GitHub read failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function showBanner(kind, html){
  const el = document.getElementById('sync-banner');
  el.className = 'sync-banner ' + kind;
  el.innerHTML = html;
  el.style.display = 'block';
}

function hideBanner(){ document.getElementById('sync-banner').style.display = 'none'; }

// =====================================================================
// Shared helpers
// =====================================================================
function countLabel(n, one, many){ return `${n} ${n === 1 ? one : many}`; }

function localToday(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoAddDays(iso, n){
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysUntil(iso){
  if(!iso) return null;
  return Math.round((new Date(iso + 'T00:00:00') - new Date(localToday() + 'T00:00:00')) / 86400000);
}

function dateWithin(iso, days){ const n = daysUntil(iso); return n !== null && n >= 0 && n <= days; }

function fmtDate(d){
  if(!d) return '\u2014';
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
}

// "9:05 AM" -> "09:05" so times sort correctly; unknown formats sort first.
function to24(t){
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*([AP]M)?$/i);
  if(!m) return '';
  let h = Number(m[1]);
  if(m[3]) h = (h % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return String(h).padStart(2, '0') + ':' + m[2];
}

// ---- Contact details ----
// Older data kept name and email together ("Name - name@example.com"); the converter splits them.
const EMAIL_RE = /[^\s<>(),;:]+@[^\s<>(),;:]+\.[A-Za-z]{2,}/;

function splitContact(text){
  const t = String(text || '').trim();
  const m = t.match(EMAIL_RE);
  if(!m) return {name: t, email: ''};
  const name = t.replace(m[0], ' ').replace(/[<>()]/g, ' ')
    .replace(/\s*[-\u2013\u2014,;:|]\s*$/, '').replace(/^\s*[-\u2013\u2014,;:|]\s*/, '')
    .replace(/\s{2,}/g, ' ').trim();
  return {name, email: m[0]};
}

// View-only page shows SIM location as city, state and country only.
// "2825 Airport Drive, Vero Beach, FL 32960, USA" -> "Vero Beach, FL, USA".
// Entries without a street number ("Greece", "RBHQ") are shown as entered;
// any other full address shows just its country (the last part).
function publicLocation(loc){
  const s = String(loc || '').trim();
  if(!s || !/\d/.test(s)) return s;
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const si = parts.findIndex(x => /^[A-Z]{2}\s+\d{5}(-\d{4})?$/.test(x));
  if(si > 0) return `${parts[si - 1]}, ${parts[si].slice(0, 2)}, ${parts.slice(si + 1).join(', ') || 'USA'}`;
  const last = parts[parts.length - 1];
  return /\d/.test(last) ? '' : last;
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s == null ? '' : s;
  return d.innerHTML;
}

function escapeAttr(s){ return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// Shows typed text as written: line breaks are kept, and lines starting with "- ", "* " or "•"
// become a bulleted list. Text is escaped first, so nothing typed or pasted can change the page.
function formatText(s){
  const out = [];
  let list = null;
  String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n').forEach(line => {
    const m = line.match(/^\s*(?:[-*]\s+|\u2022\s*)(.*)$/);
    if(m){ (list = list || []).push(escapeHtml(m[1])); return; }
    if(list){ out.push({list}); list = null; }
    out.push({line: escapeHtml(line)});
  });
  if(list) out.push({list});
  return out.map((part, i) => part.list
    ? '<ul class="text-list">' + part.list.map(li => `<li>${li}</li>`).join('') + '</ul>'
    : (i > 0 && !out[i - 1].list ? '<br>' : '') + part.line).join('');
}

// Small outlined action button. compact = icon-only on phones (label kept as tooltip).
function actionBtn(kind, label, onclick, opts){
  const o = opts || {};
  const cls = ['btn-text', o.cls || '', o.compact === false ? '' : 'compact'].join(' ').trim();
  return `<button class="${cls}" type="button" onclick="${onclick}" title="${label}" aria-label="${label}">${ICON[kind]}<span class="btn-label">${label}</span></button>`;
}

// ---- Icons ----
const svgIcon = (paths, width) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  chevronsLeft: svgIcon('<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>'),
  chevronsRight: svgIcon('<path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>'),
  cert: svgIcon('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  books: svgIcon('<path d="M4 19V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v14M10 19V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v12M15 19l2.5-12.5a1 1 0 0 1 1.2-.8l1.5.3a1 1 0 0 1 .8 1.2L18.5 19"/><path d="M3 19h18"/>'),
  expandAll: svgIcon('<path d="M7 9l5-5 5 5"/><path d="M7 15l5 5 5-5"/>'),
  collapseAll: svgIcon('<path d="M7 4l5 5 5-5"/><path d="M7 20l5-5 5 5"/>'),
  chevron: svgIcon('<path d="M9 6l6 6-6 6"/>'),
  x: svgIcon('<path d="M18 6L6 18M6 6l12 12"/>'),
  reopen: svgIcon('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
  eye: svgIcon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  plus: svgIcon('<path d="M12 5v14M5 12h14"/>'),
  edit: svgIcon('<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
  trash: svgIcon('<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  check: svgIcon('<path d="M5 12l5 5L20 7"/>', 2.2),
  home: svgIcon('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  arrowLeft: svgIcon('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  arrowRight: svgIcon('<path d="M5 12h14M12 5l7 7-7 7"/>'),
  file: svgIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  copy: svgIcon('<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2"/>'),
  external: svgIcon('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  globe: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  search: svgIcon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  comment: svgIcon('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  history: svgIcon('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 8v4l3 2"/>'),
  device: svgIcon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  bell: svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  upload: svgIcon('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  download: svgIcon('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>')
};

// Collapsed sidebar shows in full on phones; redraw when the window crosses that size.
try{ window.matchMedia('(max-width: 760px)').addEventListener('change', () => { if(sidebarCollapsed) render(); }); }catch(e){}
