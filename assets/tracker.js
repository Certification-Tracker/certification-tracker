// =====================================================================
// Certification Tracker — shared code for the view-only page and the editor.
// Each page sets window.TRACKER_EDITOR (editor only) and its own GitHub
// connection, then calls load(). Everything else lives here.
// =====================================================================
const EDITOR = !!window.TRACKER_EDITOR;
const VERSION = 'v3.1.1';
const SITE_ROOT = EDITOR ? '../' : '';   // the editor lives one folder down (admin/)

// ---- Data and page state ----

let certs = [];
let activeCustomer = null;
let activeCertId = null;
let expandedCustomers = new Set();

// Activities whose comment thread is open, and unsent comment text (both kept only while the page is open).
const openThreads = new Set();

let sidebarInitialised = false;
let currentSha = null;
let lastFetchAt = 0;

const SETTINGS_KEY = 'gh_cert_tracker_settings';

const FILE_PATH_DEFAULT = 'data/certifications.json';

// v3: all data (certifications, library, regulatory PDFs and search indexes) lives in a private repo.
// Every reader needs a key: viewers a read-only key, the editor a read-and-write key.
const DATA_REPO = {owner: 'Certification-Tracker', repo: 'tracker-data', branch: 'main', path: FILE_PATH_DEFAULT};
const VIEW_KEY = 'cert-tracker-view-key';
const SCHEMA_VERSION = 3;
const V2_ARCHIVE_URL = 'https://github.com/wjen5116/Certification-Projects/commits/main';

// Fixed lists keep names consistent (3.0). A value already in the data stays selectable.
const AUTHORITIES = ['EASA', 'FAA', 'Transport Canada', 'UK CAA', 'CAA-HU', 'HCAA'];
const LEVEL_SUGGESTIONS = ['FNPT I', 'FNPT II', 'FNPT II MCC', 'FTD Level 1', 'FTD Level 2', 'FTD Level 4', 'FTD Level 5',
  'FTD Level 6', 'FFS Level A', 'FFS Level B', 'FFS Level C', 'FFS Level D', 'BITD', 'BATD', 'AATD', 'Level 2 FTD - MCC'];
const QUAL_STATUSES = ['Pending', 'Conditional', 'Qualified', 'Expired', 'Withdrawn'];

// ---- Where you are ----
// view is what the main panel shows:
//   {type:'home'} | {type:'cert', id} | {type:'list', key} | {type:'reg', id, page} | {type:'search', q, tab}
//   | {type:'doc', cert, doc}  (a certification's Drive document previewed in the main panel)
//   | {type:'atd'} | {type:'atd-dev', id, doc, page}  (FAA ATD approvals, assets/atd.js)
// It is kept in the page address, so a refresh keeps your place and any view can be bookmarked.
const EXPANDED_KEY = 'cert-tracker-expanded';
const EXPANDED_LIB_KEY = 'cert-tracker-expanded-library';
let view = parseHash();
let navFrom = null;        // the list or search a certification/document was opened from (for "Back to …")
let pendingFocus = null;   // activity to scroll to after the next render
const expandedAuthorities = new Set();
let libraryExpandInit = false;

try{
  const savedExpanded = JSON.parse(sessionStorage.getItem(EXPANDED_KEY) || 'null');
  if(Array.isArray(savedExpanded)) savedExpanded.forEach(n => expandedCustomers.add(n));
  const savedLib = JSON.parse(sessionStorage.getItem(EXPANDED_LIB_KEY) || 'null');
  if(Array.isArray(savedLib)){ savedLib.forEach(n => expandedAuthorities.add(n)); libraryExpandInit = true; }
}catch(e){}

function parseHash(){
  let h = '';
  try{ h = decodeURIComponent(location.hash.slice(1)); }catch(e){}
  if(!h) return {type: 'home'};
  if(h.startsWith('list/')) return {type: 'list', key: h.slice(5)};
  if(h === 'atd') return {type: 'atd'};
  if(h === 'v2-changelog') return {type: 'v2log'};
  if(h.startsWith('atd/')){
    const m = h.slice(4).match(/^([^/]+)(?:\/(loa|qag))?(?:\/p(\d+))?$/);
    return m ? {type: 'atd-dev', id: m[1], doc: m[2] || '', page: Number(m[3]) || 1} : {type: 'atd'};
  }
  if(h.startsWith('search/')) return {type: 'search', q: h.slice(7), tab: 'all'};
  if(h.startsWith('doc/')){
    const parts = h.slice(4).split('/');
    return {type: 'doc', cert: parts[0], doc: parts[1] || ''};
  }
  if(h.startsWith('reg/')){
    const m = h.slice(4).match(/^(.*?)(?:\/p(\d+))?$/);
    return {type: 'reg', id: m[1], page: Number(m[2]) || 1};
  }
  return {type: 'cert', id: h};
}

function viewHash(v){
  if(v.type === 'cert') return v.id;
  if(v.type === 'list') return 'list/' + v.key;
  if(v.type === 'search') return 'search/' + v.q;
  if(v.type === 'doc') return 'doc/' + v.cert + '/' + v.doc;
  if(v.type === 'reg') return 'reg/' + v.id + (v.page > 1 ? '/p' + v.page : '');
  if(v.type === 'atd') return 'atd';
  if(v.type === 'v2log') return 'v2-changelog';
  if(v.type === 'atd-dev') return 'atd/' + v.id + (v.doc ? '/' + v.doc : '') + (v.doc && v.page > 1 ? '/p' + v.page : '');
  return '';
}

function rememberPlace(){
  const h = viewHash(view);
  const target = h ? '#' + h.split('/').map(encodeURIComponent).join('/') : '';
  if(location.hash !== target){
    // replaceState: update the address without adding a Back-button step per click.
    try{ history.replaceState(null, '', location.pathname + location.search + target); }catch(e){}
  }
  try{
    sessionStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedCustomers]));
    if(libraryExpandInit) sessionStorage.setItem(EXPANDED_LIB_KEY, JSON.stringify([...expandedAuthorities]));
  }catch(e){}
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
  if(v.type === 'cert' || v.type === 'doc'){
    const c = certs.find(x => x.id === (v.type === 'doc' ? v.cert : v.id));
    if(c) expandedCustomers.add(customerKey(c));
  }
  if(v.type === 'reg'){
    const d = libraryDoc(v.id);
    if(d) expandedAuthorities.add(d.authority);
  }
  render();
  // Phones: the main panel sits below the sidebar, so bring it into view.
  if(window.matchMedia('(max-width: 760px)').matches && v.type !== 'home'){
    const d = document.getElementById('detail');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(d) d.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'start'});
  }
}

function goHome(){ navigate({type: 'home'}); }
function selectCert(id){ navigate({type: 'cert', id}); }

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
  return `<button class="back-link" type="button" onclick="goBack()">${ICON.arrowLeft}<span>${label}</span></button>`;
}

// ---- Page layout ----
// The sidebar and main panel are separate containers. The main panel is only redrawn when its
// content actually changes, so an open PDF, scroll position or comment being typed survives
// sidebar clicks and background refreshes.
let lastDetailHtml = null;

function render(){
  regMemo = new Map();
  renderSummary();
  syncSearchInput();
  const list = document.getElementById('list');
  if(!list || (EDITOR && !ghConfig)) return;

  if(view.type === 'cert' && !certs.some(c => c.id === view.id)) view = {type: 'home'};
  if(view.type === 'reg' && libraryLoaded && !libraryDoc(view.id)) view = {type: 'home'};
  if(view.type === 'atd-dev' && atdLoaded && !atdDevice(view.id)) view = {type: 'atd'};
  if(view.type === 'v2log' && !EDITOR) view = {type: 'home'};
  if(view.type === 'doc' && !findCertDoc(view.cert, view.doc)) view = certs.some(c => c.id === view.cert) ? {type: 'cert', id: view.cert} : {type: 'home'};
  const activeCert = view.type === 'cert' ? certs.find(c => c.id === view.id)
    : view.type === 'doc' ? certs.find(c => c.id === view.cert) : null;
  activeCertId = activeCert ? activeCert.id : null;
  activeCustomer = activeCert ? customerKey(activeCert) : null;
  if(!sidebarInitialised){
    if(activeCustomer) expandedCustomers.add(activeCustomer);
    sidebarInitialised = true;
  }
  rememberPlace();

  if(!document.getElementById('detail')){
    list.innerHTML = `
      <div class="layout">
        <div class="side-col">
          <nav class="sidebar" id="sidebar" aria-label="Tracker navigation"></nav>
          ${EDITOR ? `<button class="btn-text side-add-customer" onclick="openModal(null, '', 'customer')">${ICON.plus}<span>Add customer</span></button>` : ''}
        </div>
        <section class="detail" id="detail" aria-live="polite"></section>
      </div>`;
    lastDetailHtml = null;
  }
  document.getElementById('sidebar').innerHTML = renderSidebar();

  const html = renderMain(activeCert);
  if(html !== lastDetailHtml){
    document.getElementById('detail').innerHTML = html;
    lastDetailHtml = html;
  }
  afterRender();
}

function renderMain(activeCert){
  if(view.type === 'cert' && activeCert) return backLinkHtml() + renderCertDetail(activeCert);
  if(view.type === 'list') return renderListView(view.key);
  if(view.type === 'search') return renderSearchView();
  if(view.type === 'reg') return renderRegView();
  if(view.type === 'doc' && activeCert) return renderDrivePreview(activeCert);
  if(view.type === 'atd') return renderAtdView();
  if(view.type === 'v2log' && EDITOR) return renderV2Log();
  if(view.type === 'atd-dev') return renderAtdDevice();
  return renderHome();
}

function afterRender(){
  if(pendingFocus){
    const el = document.getElementById('act-' + pendingFocus);
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
}

function renderHome(){
  rowActions = [];
  const customers = new Set(certs.map(customerKey)).size;
  const docs = library.documents.length;
  return `
    <div class="home">
      <h2 class="home-title">Certification Tracker <span class="home-version">${VERSION}</span></h2>
      <p class="home-counts">${countLabel(certs.length, 'certification', 'certifications')} \u00b7 ${countLabel(customers, 'customer', 'customers')} \u00b7 ${countLabel(docs, 'regulatory document', 'regulatory documents')}${atd.devices.length ? ' \u00b7 ' + countLabel(atd.devices.length, 'ATD device', 'ATD devices') : ''}</p>
      ${renderKbBehindNotice()}
      <div class="home-cards">
        ${renderCertsHome()}
        ${renderAtdHome()}
        ${renderRegHome()}
      </div>
      <p class="home-hint">Choose a certification, the ATD devices or a regulatory document from the sidebar, click a box above to list what it counts, or search (press <kbd>/</kbd>).</p>
    </div>`;
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
    <h2 class="detail-title">v2 change log</h2>
    <div class="doc-meta">v2.1.1 to v2.5.0, the tracker before v3. For each version's code, see <a href="${V2_ARCHIVE_URL}" target="_blank" rel="noopener">v2 revision history</a>.</div>
    <div class="v2log">${v2LogHtml === null ? '<div class="muted list-empty">Loading\u2026</div>'
      : v2LogHtml || '<div class="muted list-empty">Couldn\u2019t load archive/changelog-v2.html from the data repo.</div>'}</div>`;
}

// ---- Home summary cards: what needs attention in each sidebar section ----
const HOME_ROWS_MAX = 6;

function homeCard(title, headRight, body){
  return `<section class="home-card"><div class="home-card-head"><b>${title}</b>${headRight || ''}</div>${body}</section>`;
}

// tag: why the row is there; action: what clicking it opens (see openRow).
// tag may be a list of [label, cls] pairs when a row has several reasons.
function homeRow(tag, cls, text, side, action){
  rowActions.push(action);
  const tags = Array.isArray(tag) ? tag : [[tag, cls]];
  return `<button class="home-row" type="button" onclick="openRow(${rowActions.length - 1})"><span class="home-tags">${tags.map(([t, c]) => `<span class="pill pill-${c} home-tag">${escapeHtml(t)}</span>`).join('')}</span><span class="home-row-text">${text}</span><span class="home-row-side">${side || ''}</span></button>`;
}

function homeClear(text){ return `<div class="home-clear">${text}</div>`; }

function renderCertsHome(){
  if(!certs.length) return '';
  const today = localToday(), week = isoAddDays(today, 7);
  const acts = allActivities().filter(x => activityGroupOf(x.a) !== 'Complete');
  const certOverdue = sortCerts(certs.filter(isOverdue));
  const actOverdue = acts.filter(x => isActivityOverdue(x.a)).sort((x, y) => dateCmp(x.a.dateDue, y.a.dateDue));
  const actWeek = acts.filter(x => !isActivityOverdue(x.a) && x.a.dateDue && x.a.dateDue >= today && x.a.dateDue <= week).sort((x, y) => dateCmp(x.a.dateDue, y.a.dateDue));
  const certDue = certsDueWithin(30).sort((a, b) => dateCmp(a.date, b.date));
  const qualExpired = certs.filter(c => { const n = daysUntil(qual(c).expiryDate); return (n !== null && n < 0) || qual(c).status === 'Expired'; });
  const qualExp = certs.filter(c => dateWithin(qual(c).expiryDate, 90)).sort((a, b) => dateCmp(qual(a).expiryDate, qual(b).expiryDate));
  const qualCond = certs.filter(c => qual(c).status === 'Conditional');
  // Waiting: oldest first; several from one certification share a row.
  const waitingByCert = {};
  acts.filter(x => activityGroupOf(x.a) === 'Waiting').forEach(x => (waitingByCert[x.c.id] = waitingByCert[x.c.id] || []).push(x));
  const waiting = Object.values(waitingByCert).map(list => {
    const dated = list.map(x => x.a.waitingSince).filter(Boolean).sort();
    return {list, since: dated[0] || ''};
  }).sort((a, b) => dateCmp(a.since, b.since) || textCmp(customerKey(a.list[0].c), customerKey(b.list[0].c)));

  const who = c => escapeHtml(customerKey(c));
  const actText = x => `${who(x.c)} \u00b7 ${escapeHtml(plainSnippet(x.a.description || x.a.text, 90))}`;
  const actAction = x => ({type: 'act', certId: x.c.id, activityId: x.a.id});
  const certText = c => `${who(c)} \u00b7 ${escapeHtml(certName(c))}`;
  const certAction = c => ({type: 'cert', id: c.id});
  // One list (3.1.1): soonest date first (overdue items lead), then undated items, oldest Waiting first.
  // An item that meets several rules is one row carrying each reason.
  const items = new Map();
  const add = (key, date, tag, cls, text, side, action) => {
    const it = items.get(key) || {date, tags: [], text, side, action};
    if(!it.tags.some(t => t[0] === tag)) it.tags.push([tag, cls]);
    if(date && (!it.date || date < it.date)){ it.date = date; it.side = side; }
    items.set(key, it);
  };
  certOverdue.forEach(c => add('c' + c.id, c.date, 'Overdue', 'overdue', certText(c), 'due ' + fmtDate(c.date), certAction(c)));
  actOverdue.forEach(x => add('a' + x.a.id, x.a.dateDue, 'Overdue', 'overdue', actText(x), 'due ' + fmtDate(x.a.dateDue), actAction(x)));
  qualExpired.forEach(c => add('q' + c.id, qual(c).expiryDate || '', 'Expired', 'overdue', certText(c), qual(c).expiryDate ? 'expired ' + fmtDate(qual(c).expiryDate) : 'qualification', certAction(c)));
  actWeek.forEach(x => add('a' + x.a.id, x.a.dateDue, 'Due this week', 'slate', actText(x), 'due ' + fmtDate(x.a.dateDue), actAction(x)));
  qualExp.forEach(c => add('q' + c.id, qual(c).expiryDate, 'Expiring', 'gold', certText(c), 'expires ' + fmtDate(qual(c).expiryDate), certAction(c)));
  certDue.forEach(c => add('c' + c.id, c.date, 'Due in 30 days', 'slate', certText(c), 'due ' + fmtDate(c.date), certAction(c)));
  qualCond.forEach(c => add('q' + c.id, qual(c).expiryDate || '', 'Conditional', 'gold', certText(c), qual(c).expiryDate ? 'expires ' + fmtDate(qual(c).expiryDate) : 'qualification', certAction(c)));
  waiting.forEach(w => {
    if(w.list.length > 1){
      const due = w.list.map(x => x.a.dateDue).filter(Boolean).sort()[0] || '';
      add('w' + w.list[0].c.id, due, 'Waiting', 'plum', `${who(w.list[0].c)} \u00b7 ${w.list.length} activities`, due ? 'due ' + fmtDate(due) : (w.since ? 'since ' + fmtDate(w.since) : 'no date'), actAction(w.list[0]));
    }else{
      const x = w.list[0];
      add('a' + x.a.id, x.a.dateDue || '', 'Waiting', 'plum', actText(x), x.a.dateDue ? 'due ' + fmtDate(x.a.dateDue) : (w.since ? 'since ' + fmtDate(w.since) : 'no date'), actAction(x));
      const it = items.get('a' + x.a.id); if(!it.since) it.since = w.since;
    }
    if(w.list.length > 1){ const it = items.get('w' + w.list[0].c.id); it.since = w.since; }
  });
  const sorted = [...items.values()].sort((a, b) => dateCmp(a.date, b.date) || dateCmp(a.since, b.since));
  const rows = sorted.map(it => homeRow(it.tags, null, it.text, it.side, it.action));
  const clear = [];
  if(!certOverdue.length && !actOverdue.length) clear.push('Nothing overdue');
  if(!actWeek.length) clear.push('no activities due this week');
  if(!certDue.length) clear.push('no certifications due in 30 days');
  if(!qualExp.length && !qualExpired.length) clear.push('no qualifications expiring in 90 days');
  if(clear.length) clear[0] = clear[0][0].toUpperCase() + clear[0].slice(1);
  const lists = [['certs-overdue', certOverdue.length], ['act-overdue', actOverdue.length], ['act-week', actWeek.length], ['certs-due30', certDue.length],
    ['qual-exp90', qualExp.length], ['qual-cond', qualCond.length], ['act-wait', waiting.reduce((n, w) => n + w.list.length, 0)]].filter(([, n]) => n);
  const more = rows.length > HOME_ROWS_MAX
    ? `<div class="home-more">Show all: ${lists.map(([k, n]) => `<button class="text-link" type="button" onclick="navigate({type: 'list', key: '${k}'})">${escapeHtml(summaryMeasure(k).label)} (${n})</button>`).join(' \u00b7 ')}</div>` : '';
  return homeCard('Certifications and activities', `<button class="text-link" type="button" onclick="navigate({type: 'list', key: 'act-open'})">${countLabel(acts.length, 'open activity', 'open activities')}</button>`,
    rows.slice(0, HOME_ROWS_MAX).join('') + more + (clear.length ? homeClear(clear.join(' \u00b7 ')) : ''));
}

function renderRegHome(){
  if(!library.documents.length) return '';
  const ups = regUpdates();
  const failed = EDITOR ? library.documents.filter(d => (regCheck(d.id) || {}).status === 'error') : [];
  const when = regStatus && regStatus.checkedAt ? fmtDate(String(regStatus.checkedAt).slice(0, 10)) : '';
  const rows = [
    ...ups.map(d => { const n = certsUsingDoc(d.id, true).length; return homeRow('Update', 'gold', `${escapeHtml(docTitle(d))}${n ? ` <span class="row-sub">\u00b7 ${countLabel(n, 'open certification', 'open certifications')}</span>` : ''}`, `${escapeHtml(regCheck(d.id).latest || 'newer version')} \u00b7 yours: ${escapeHtml(yourCopy(d))}`, {type: 'reg', id: d.id, page: 1}); }),
    ...failed.map(d => homeRow('Check failed', 'neutral', escapeHtml(docTitle(d)), 'will retry next week', {type: 'reg', id: d.id, page: 1}))
  ];
  return homeCard('Regulatory library', `<span class="home-card-note">${countLabel(library.documents.length, 'document', 'documents')}</span>`,
    rows.join('') + (ups.length ? '' : homeClear(when ? `All current \u00b7 checked ${when}` : 'Not checked yet')));
}

function countLabel(n, one, many){
  return `${n} ${n === 1 ? one : many}`;
}

// ---- Sidebar ----
function renderSidebar(){
  prepareLibraryExpansion();   // before the header, so Expand all / Collapse all matches what's open
  return `
    <div class="side-home-wrap"><button class="side-home ${view.type === 'home' ? 'active' : ''}" type="button" onclick="goHome()" ${view.type === 'home' ? 'aria-current="page"' : ''}>${ICON.home}<span>Home</span></button></div>
    ${sideSectionHead('Certifications', allCustomerKeys().length ? toggleAllBtn(allCustomerKeys().some(k => expandedCustomers.has(k)), 'toggleAllCustomers()') : '')}
    ${renderCustomerList()}
    ${renderAtdSidebar()}
    ${sideSectionHead('Regulatory library', `${EDITOR ? `<button class="side-tool" type="button" onclick="openLibraryModal()">+ Add</button>` : ''}${libraryAuthorities().length ? toggleAllBtn(libraryAuthorities().some(a => expandedAuthorities.has(a)), 'toggleAllAuthorities()') : ''}`)}
    ${renderLibraryList()}`;
}

function sideSectionHead(title, tools){
  return `<div class="side-section"><span class="side-section-title">${title}</span><span class="side-section-tools">${tools}</span></div>`;
}

function toggleAllBtn(anyOpen, onclick){
  return `<button class="side-tool" type="button" onclick="${onclick}">${anyOpen ? 'Collapse all' : 'Expand all'}</button>`;
}

function renderCustomerList(){
  if(!certs.length) return `<div class="side-empty">No certifications yet</div>`;
  const groups = {};
  certs.forEach(c => {
    const key = customerKey(c);
    (groups[key] = groups[key] || []).push(c);
  });
  const order = Object.keys(groups).sort((a,b) => a.localeCompare(b, undefined, {sensitivity: 'base', numeric: true}));
  return order.map(customer => {
    const items = sortCerts(groups[customer]);
    const anyOverdue = items.some(isCertOverdue);
    const open = expandedCustomers.has(customer);
    // Customer line: total projects, completed included (3.1.1).
    const total = items.length;
    const doneCount = items.filter(x => x.completed).length;
    // Active certifications first (grouped by serial), completed ones last.
    const bySerial = arr => { const g = groupBySerial(arr); return g.order.flatMap(k => g.groups[k]); };
    const ordered = [...bySerial(items.filter(x => !x.completed)), ...bySerial(items.filter(x => x.completed))];
    return `
      <div class="side-customer ${customer === activeCustomer ? 'has-active' : ''}">
        <button class="side-customer-btn" aria-expanded="${open}" onclick="toggleCustomer('${escapeAttr(customer)}')">
          <span class="chevron ${open ? 'open' : ''}" aria-hidden="true">&#9656;</span>
          <span class="side-customer-name">${escapeHtml(customer)}</span>
          ${anyOverdue ? '<span class="tab-overdue-dot" title="Has overdue items"></span>' : ''}
          <span class="tab-count" title="${countLabel(total, 'project', 'projects')}${doneCount ? `, ${doneCount} completed` : ''}">${total}</span>
        </button>
        ${open ? `
        <div class="side-certs">
          ${ordered.map(x => {
              const st = computeCertStatus(x);
              const isActive = x.id === activeCertId;
              return `
              <button class="side-cert ${isActive ? 'active' : ''}" ${isActive ? 'aria-current="true"' : ''} title="${escapeHtml(certName(x))}" onclick="selectCert('${x.id}')">
                ${x.completed ? '<span class="status-dot status-spacer" aria-hidden="true"></span>' : `<span class="status-dot dot-${st.cls}" title="${st.label}"></span>`}
                <span class="side-cert-name"><span class="side-sn-line"><span>SN: ${escapeHtml(x.serial || '\u2014')}${x.completed ? ' <span class="side-done-tag">Completed</span>' : ''}</span>${sideActCount(x)}</span>${(x.authority || x.level) ? `<span class="side-cert-auth">${escapeHtml([x.authority, x.level].filter(Boolean).join(' - '))}</span>` : ''}${x.aircraft ? `<span class="side-cert-auth">${escapeHtml(x.aircraft)}</span>` : ''}</span>
              </button>`;
            }).join('')}
          ${EDITOR ? actionBtn('plus', 'Add project', `openModal(null, '${escapeAttr(customer)}')`, {cls: 'side-add', compact: false}) : ''}
        </div>` : ''}
      </div>`;
  }).join('');
}

// SIM SN line (3.1.1): the project's activities, open / total; red when one is overdue.
function sideActCount(c){
  const acts = Array.isArray(c.activityLog) ? c.activityLog : [];
  if(!acts.length) return '';
  const open = acts.filter(a => activityGroupOf(a) !== 'Complete');
  const late = open.some(isActivityOverdue);
  return `<span class="side-act-count${late ? ' late' : open.length ? '' : ' none'}" title="${open.length} open of ${countLabel(acts.length, 'activity', 'activities')}${late ? ', overdue' : ''}"><b>${open.length}</b>/${acts.length}</span>`;
}

function allCustomerKeys(){
  return [...new Set(certs.map(customerKey))];
}

function toggleAllCustomers(){
  const keys = allCustomerKeys();
  if(keys.some(k => expandedCustomers.has(k))) expandedCustomers.clear();
  else keys.forEach(k => expandedCustomers.add(k));
  render();
}

// ---- Certification details ----
function renderCertDetail(c){
  const over = isOverdue(c);
  const status = computeCertStatus(c);
  const field = (label, value) => `<div><div class="fk">${label}</div><div class="fv">${value}</div></div>`;
  return `
    <div class="detail-head">
      <div>
        <div class="detail-context">${escapeHtml(customerKey(c))}${c.serial ? ' / ' + escapeHtml(c.serial) : ''}</div>
        <h2 class="detail-title">${escapeHtml(certName(c))}</h2>
        ${c.completed ? `<div class="detail-completed">Completed ${fmtDate(c.dateCompleted)}</div>` : ''}
      </div>
      <span class="pill pill-${status.cls}">${status.label}</span>
    </div>
    ${EDITOR ? `
    <div class="detail-actions">
      ${c.completed
        ? actionBtn('reopen', 'Reopen', `reopenCert('${c.id}')`)
        : actionBtn('check', 'Mark complete', `completeCert('${c.id}')`, {cls: 'ok'})}
      ${actionBtn('edit', 'Edit', `openModal('${c.id}')`)}
      ${actionBtn('trash', 'Delete', `removeCert('${c.id}')`, {cls: 'danger'})}
    </div>` : ''}
    <div class="field-grid">
      ${field('SIM location', escapeHtml((EDITOR ? c.simLocation : publicLocation(c.simLocation)) || '\u2014'))}
      ${field('Certifying country', escapeHtml(c.country || '\u2014'))}
      ${field('Regulatory authority', escapeHtml(c.authority || '\u2014'))}
      ${field('SIM serial number', escapeHtml(c.serial || '\u2014'))}
      ${field('SIM model', escapeHtml(certModel(c) || '\u2014'))}
      ${field('Aircraft type', escapeHtml(c.aircraft || '\u2014'))}
      ${field('Certification level', escapeHtml(c.level || '\u2014'))}
      ${field('Regulation', regulationHtml(c))}
      <div><div class="fk">Due date</div><div class="fv ${over ? 'due-cell overdue' : ''}">${fmtDate(c.date)}${over ? ' <span class="pill pill-overdue">Overdue</span>' : ''}</div></div>
      ${field('Contact name', escapeHtml(contactName(c) || '\u2014'))}
      ${EDITOR ? field('Contact email', contactEmail(c) ? `<a href="mailto:${escapeHtml(contactEmail(c))}">${escapeHtml(contactEmail(c))}</a>` : '\u2014') : ''}
    </div>
    ${renderCertAtdLinks(c)}
    ${renderQualification(c)}
    ${renderDocumentsSection(c)}
    ${renderActivityLog(c)}`;
}

// ---- Qualification (3.0): what the authority granted, and when it lapses ----
function qual(c){ return c.qualification && typeof c.qualification === 'object' ? c.qualification : {}; }

function hasQualification(c){ return Object.entries(qual(c)).some(([k, v]) => !['basis', 'basisRevision', 'basisDocId'].includes(k) && String(v || '').trim()); }

function daysUntil(iso){
  if(!iso) return null;
  return Math.round((new Date(iso + 'T00:00:00') - new Date(localToday() + 'T00:00:00')) / 86400000);
}

function dateWithin(iso, days){ const n = daysUntil(iso); return n !== null && n >= 0 && n <= days; }

function qualStatusCls(s){
  return {Qualified: 'sage', Conditional: 'gold', Pending: 'slate', Expired: 'overdue', Withdrawn: 'plum'}[s] || 'slate';
}

function dueNote(iso){
  const n = daysUntil(iso);
  if(n === null) return '';
  if(n < 0) return ` <span class="pill pill-overdue">${countLabel(-n, 'day', 'days')} ago</span>`;
  if(n <= 90) return ` <span class="pill pill-gold">in ${countLabel(n, 'day', 'days')}</span>`;
  return '';
}

// ---- Regulation (3.1): the library document a certification is qualified against ----
// Set automatically from the authority and level; Edit can pick another (qualification.basis). A completed
// certification keeps the issue it was qualified under (qualification.basisRevision).
// Hungary (CAA-HU) and Greece (HCAA) work to EASA's CS-FSTD(A).
const REG_RULES = [
  {auth: /^(EASA|CAA-HU|HCAA)$/i, docAuth: 'EASA', title: /CS-FSTD/i},
  {auth: /^UK CAA$/i, docAuth: 'UK CAA', title: /CS-FSTD/i},
  {auth: /^FAA$/i, level: /ATD/i, docAuth: 'FAA', title: /61-136/},
  {auth: /^FAA$/i, docAuth: 'FAA', title: /Part 60/i},
  {auth: /^Transport Canada$/i, docAuth: 'Transport Canada', title: /9685/}
];

function autoRegulation(c){
  const auth = (c.authority || '').trim(), level = (c.level || '').trim();
  const rule = REG_RULES.find(r => r.auth.test(auth) && (!r.level || r.level.test(level)));
  if(!rule) return null;
  return library.documents.find(d => (d.authority || '') === rule.docAuth && rule.title.test(d.title || '')) || null;
}

// {doc, auto, revision, locked} or null. Worked out once per screen update (cleared in render()).
let regMemo = new Map();
function certRegulation(c){
  if(regMemo.has(c)) return regMemo.get(c);
  const r = findRegulation(c);
  regMemo.set(c, r);
  return r;
}

function findRegulation(c){
  const q = qual(c);
  const locked = !!(c.completed && (q.basisRevision || q.basisDocId));
  const chosen = q.basis ? libraryDoc(q.basis) : null;
  const doc = (locked && q.basisDocId && libraryDoc(q.basisDocId)) || chosen || autoRegulation(c);
  if(!doc) return null;
  return {doc, auto: !chosen, locked, revision: locked ? q.basisRevision : (doc.revision || '')};
}

function regulationHtml(c){
  const r = certRegulation(c);
  if(!r) return EDITOR && libraryLoaded && (c.authority || '').trim() ? '<span class="muted">No matching document in the library</span>' : '\u2014';
  const outdated = r.locked && r.doc.revision && r.revision !== r.doc.revision;
  return `<button class="link-inline" type="button" onclick="openDoc('${r.doc.id}')">${escapeHtml(docTitle(r.doc))}${r.revision ? ' ' + escapeHtml(r.revision) : ''}</button>`
    + (c.completed ? (outdated ? ` <span class="muted reg-note-inline">(qualified under ${escapeHtml(r.revision)}; library has ${escapeHtml(r.doc.revision)})</span>` : '') : regBadge(r.doc.id))
    + (EDITOR && r.auto ? ' <span class="mode-tag">Automatic</span>' : '');
}

// Records the regulation and issue in force when a certification is completed (editor saves it).
function lockRegulation(c){
  regMemo = new Map();
  const q = {...qual(c)};
  delete q.basisRevision; delete q.basisDocId;
  c.qualification = q;
  const r = certRegulation(c);
  if(r) c.qualification = {...q, basisDocId: r.doc.id, basisRevision: r.doc.revision || ''};
}

function unlockRegulation(c){
  regMemo = new Map();
  if(!c.qualification) return;
  delete c.qualification.basisRevision;
  delete c.qualification.basisDocId;
}

// Open certifications that use a library document (for update flags).
function certsUsingDoc(id, openOnly){
  return certs.filter(c => (!openOnly || !c.completed) && ((certRegulation(c) || {}).doc || {}).id === id);
}

function renderQualification(c){
  const q = qual(c);
  if(!hasQualification(c) && !EDITOR) return '';
  const field = (label, value) => `<div><div class="fk">${label}</div><div class="fv">${value}</div></div>`;
  return `
    <div class="changelog qual-section">
      <div class="fk section-head"><span>Qualification ${q.status ? `<span class="pill pill-${qualStatusCls(q.status)}">${escapeHtml(q.status)}</span>` : ''}</span>${EDITOR ? actionBtn('edit', 'Edit', `openModal('${c.id}', '', '', 'qual')`, {compact: false}) : ''}</div>
      ${hasQualification(c) ? `
      <div class="field-grid">
        ${field('Certificate / LOA number', escapeHtml(q.certificateNumber || '\u2014'))}
        ${field('Issued', fmtDate(q.issueDate))}
        ${field('Expires', fmtDate(q.expiryDate) + dueNote(q.expiryDate))}
        ${field('Next evaluation', fmtDate(q.nextEvaluation) + dueNote(q.nextEvaluation))}
      </div>
      ${q.conditions ? `<div class="field-grid qual-conditions"><div class="span-all">${''}<div class="fk">Conditions</div><div class="fv">${escapeHtml(q.conditions).replace(/\n/g, '<br>')}</div></div></div>` : ''}`
      : `<div class="muted qual-empty">No qualification details yet. Use Edit to add the status, certificate number and dates once the authority issues them.</div>`}
    </div>`;
}

function sectionHead(title, addOnclick){
  return EDITOR
    ? `<div class="fk section-head"><span>${title}</span>${actionBtn('plus', 'Add', addOnclick, {compact: false})}</div>`
    : `<div class="fk">${title}</div>`;
}

function renderDocumentsSection(c){
  const docs = Array.isArray(c.docs) ? c.docs : [];
  return `
    <div class="changelog">
      ${sectionHead('Documents', `openDocumentModal('${c.id}')`)}
      ${docs.length ? docs.map(d => {
        const actions = previewBtn(c, d) + viewBtn(d) + (EDITOR
          ? actionBtn('edit', 'Edit', `openDocumentModal('${c.id}', '${d.id}')`) + actionBtn('trash', 'Delete', `deleteDocument('${c.id}', '${d.id}')`, {cls: 'danger'})
          : '');
        return `
        <div class="activity-entry">
          <div class="activity-entry-top">
            <span class="changelog-text">${renderDocItem(d)}</span>
            ${actions ? `<div class="cert-actions">${actions}</div>` : ''}
          </div>
        </div>`;
      }).join('') : '<div class="changelog-entry"><span class="changelog-text muted">No documents yet</span></div>'}
      ${c.docLocation ? `<div style="margin-top:6px;">${renderDocLocation(c.docLocation)}</div>` : ''}
      ${renderDocHistory(c)}
    </div>`;
}

// Document history (3.1): recorded automatically when documents change; shown collapsed under Documents.
const openDocHistory = new Set();

function toggleDocHistory(id){
  if(openDocHistory.has(id)) openDocHistory.delete(id); else openDocHistory.add(id);
  render();
}

function renderDocHistory(c){
  const entries = Array.isArray(c.docChangeLog) ? c.docChangeLog : [];
  if(!entries.length && !EDITOR) return '';
  const open = openDocHistory.has(c.id);
  const sorted = [...entries].sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.ts || 0) - (a.ts || 0));
  return `
    <div class="doc-history">
      <button class="comments-toggle" type="button" aria-expanded="${open}" onclick="toggleDocHistory('${c.id}')">${ICON.chevron}<span>History (${entries.length})</span></button>
      ${open ? `<div class="doc-history-body">
      ${EDITOR ? `<button class="side-tool doc-history-add" type="button" onclick="openChangeLogModal('${c.id}')">+ Add entry</button>` : ''}
      ${sorted.length ? sorted.map(entry => `
        <div class="changelog-entry ${EDITOR ? 'changelog-editable' : ''}">
          <div class="changelog-main">
            <span class="changelog-date">${fmtDate(entry.date)}${entry.time ? ', ' + entry.time : ''}</span>
            <span class="changelog-text">${escapeHtml(entry.text)}</span>
          </div>
          ${EDITOR ? `<div class="cert-actions">
            ${actionBtn('edit', 'Edit', `openChangeLogModal('${c.id}', '${entry.id}')`)}
            ${actionBtn('trash', 'Delete', `deleteChangeLogEntry('${c.id}', '${entry.id}')`, {cls: 'danger'})}
          </div>` : ''}
        </div>`).join('') : '<div class="changelog-entry"><span class="changelog-text muted">No entries yet</span></div>'}
      </div>` : ''}
    </div>`;
}

function renderActivityLog(c){
  const entry = a => {
    const over = isActivityOverdue(a);
    const status = activityStatusLabel(a.status);
    const cls = activityStatusClass(status);
    return `
        <div class="activity-entry" id="act-${a.id}">
          <div class="activity-entry-top">
            <div>
              <span class="pill pill-${cls}">${escapeHtml(status)}</span>
              <span class="changelog-text rich-text">${formatText(a.description || a.text || '')}</span>
            </div>
            ${EDITOR ? `<div class="cert-actions">
              ${status !== 'Complete'
                ? actionBtn('check', 'Complete', `markActivityComplete('${c.id}', '${a.id}')`, {cls: 'ok'})
                : actionBtn('reopen', 'Reopen', `reopenActivity('${c.id}', '${a.id}')`)}
              ${actionBtn('edit', 'Edit', `openActivityModal('${c.id}', '${a.id}')`)}
              ${actionBtn('trash', 'Delete', `deleteActivity('${c.id}', '${a.id}')`, {cls: 'danger'})}
            </div>` : ''}
          </div>
          <div class="activity-meta">
            Entered ${fmtDate(a.dateCreated)}${a.timeCreated ? ', ' + a.timeCreated : ''}
            ${a.dateDue ? ` \u00b7 Due ${fmtDate(a.dateDue)}${over ? ' <span class="pill pill-overdue">Overdue</span>' : ''}` : ''}
            ${a.dateUpdated && a.dateUpdated !== a.dateCreated ? ` \u00b7 Updated ${fmtDate(a.dateUpdated)}${a.timeUpdated ? ', ' + a.timeUpdated : ''}` : ''}
            ${status === 'Waiting' && a.waitingSince ? ` \u00b7 Waiting since ${fmtDate(a.waitingSince)}` : ''}
            ${a.dateCompleted ? ` \u00b7 Completed ${fmtDate(a.dateCompleted)}${a.timeCompleted ? ', ' + a.timeCompleted : ''}${lateNote(a)}` : ''}
          </div>
          ${renderComments(c, a)}
        </div>`;
  };
  return `
    <div class="changelog">
      <div class="fk act-head">
        <span>Activities</span>
        <div class="act-head-tools">
          ${activityToggleAllBtn(c)}
          ${EDITOR ? actionBtn('plus', 'Add', `openActivityModal('${c.id}')`, {compact: false}) : ''}
        </div>
      </div>
      ${renderActivityGroups(c, entry)}
    </div>`;
}

// ---- Activity comments ----
// Each activity keeps a running thread: comments: [{id, text, date, time}], oldest first.
// The editor can add and delete comments; the view-only page shows them.
const commentDrafts = {};

function renderComments(c, a){
  const list = Array.isArray(a.comments) ? a.comments : [];
  const n = list.length;
  const open = openThreads.has(a.id);
  const key = c.id + '|' + a.id;
  let thread = '';
  if(open){
    const items = n ? list.map(cm => `
        <div class="comment">
          <div style="min-width:0;">
            <div class="comment-text rich-text">${formatText(cm.text)}</div>
            <div class="comment-stamp">${fmtDate(cm.date)}${cm.time ? ', ' + escapeHtml(cm.time) : ''}</div>
          </div>
          ${EDITOR ? `<button class="comment-del" type="button" title="Delete comment" aria-label="Delete comment" onclick="deleteComment('${c.id}', '${a.id}', '${cm.id}')">${ICON.x}</button>` : ''}
        </div>`).join('') : '<div class="comment-empty">No comments yet</div>';
    const form = EDITOR ? `
        <div class="comment-add">
          <textarea id="cmt-${a.id}" aria-label="Add a comment" placeholder="Add a comment" oninput="commentDrafts['${key}'] = this.value; document.getElementById('cmt-err-${a.id}').style.display = 'none';" onkeydown="if(event.key === 'Enter' && (event.ctrlKey || event.metaKey)){ event.preventDefault(); addComment('${c.id}', '${a.id}'); }">${escapeHtml(commentDrafts[key] || '')}</textarea>
          <button class="btn-primary" type="button" onclick="addComment('${c.id}', '${a.id}')">Add</button>
        </div>
        <div class="comment-err" id="cmt-err-${a.id}" style="display:none;">Enter a comment first.</div>` : '';
    thread = `<div class="comment-thread" id="thread-${a.id}"><div class="comment-list">${items}</div>${form}</div>`;
  }
  return `
          <button class="comments-toggle" type="button" aria-expanded="${open}" aria-controls="thread-${a.id}" onclick="toggleComments('${a.id}')">${ICON.chevron}Comments <span class="${n ? '' : 'cc-zero'}">(${n})</span></button>
          ${thread}`;
}

function toggleComments(activityId){
  if(openThreads.has(activityId)) openThreads.delete(activityId);
  else openThreads.add(activityId);
  render();
  if(openThreads.has(activityId)){
    const box = document.getElementById('cmt-' + activityId);
    if(box) box.focus({preventScroll: true});
  }
}

// =====================================================================
// Summary bar: each person picks the boxes shown (saved in this browser)
// =====================================================================
const SUMMARY_KEY = 'cert-tracker-summary';
const SUMMARY_DEFAULT = ['certs-all', 'certs-overdue', 'certs-due30', 'certs-nodue', 'certs-done'];
const SUMMARY_MAX = 8;
let summaryBoxes = null;   // loaded on first use (see renderSummary)
let summaryEditing = false;
let summaryDragFrom = null;

function isoAddDays(iso, n){
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function allActivities(){
  return certs.flatMap(c => (Array.isArray(c.activityLog) ? c.activityLog : []).map(a => ({c, a})));
}

function certsDueWithin(days){
  const today = localToday(), last = isoAddDays(today, days);
  return certs.filter(c => !c.completed && c.date && c.date >= today && c.date <= last);
}

// Each measure: g = dropdown group, label, kind (what its list shows), color, items().
const MEASURES = {
  'certs-all':      {g: 'Certifications', label: 'All certifications', kind: 'cert', items: () => certs},
  'certs-open':     {g: 'Certifications', label: 'Open certifications', kind: 'cert', items: () => certs.filter(c => !c.completed)},
  'certs-overdue':  {g: 'Certifications', label: 'Overdue', kind: 'cert', color: 'rust', items: () => certs.filter(isOverdue)},
  'certs-due7':     {g: 'Certifications', label: 'Due in 7 days', kind: 'cert', items: () => certsDueWithin(7)},
  'certs-due30':    {g: 'Certifications', label: 'Due in 30 days', kind: 'cert', items: () => certsDueWithin(30)},
  'certs-due60':    {g: 'Certifications', label: 'Due in 60 days', kind: 'cert', items: () => certsDueWithin(60)},
  'certs-due90':    {g: 'Certifications', label: 'Due in 90 days', kind: 'cert', items: () => certsDueWithin(90)},
  'certs-nodue':    {g: 'Certifications', label: 'No due date', kind: 'cert', items: () => certs.filter(c => !c.completed && !c.date)},
  'certs-done':     {g: 'Certifications', label: 'Completed', kind: 'cert', color: 'sage', items: () => certs.filter(c => c.completed)},
  'certs-done-year':{g: 'Certifications', label: 'Completed this year', kind: 'cert', color: 'sage', items: () => certs.filter(c => c.completed && (c.dateCompleted || '').slice(0, 4) === localToday().slice(0, 4))},
  'certs-done-30':  {g: 'Certifications', label: 'Completed in last 30 days', kind: 'cert', color: 'sage', items: () => certs.filter(c => c.completed && (c.dateCompleted || '') >= isoAddDays(localToday(), -29))},
  'certs-noact':    {g: 'Certifications', label: 'No activity logged', kind: 'cert', items: () => certs.filter(c => !c.completed && !(c.activityLog || []).length)},
  'qual-exp90':     {g: 'Qualifications', label: 'Expiring in 90 days', kind: 'cert', color: 'rust', items: () => certs.filter(c => dateWithin(qual(c).expiryDate, 90))},
  'qual-exp180':    {g: 'Qualifications', label: 'Expiring in 180 days', kind: 'cert', items: () => certs.filter(c => dateWithin(qual(c).expiryDate, 180))},
  'qual-expired':   {g: 'Qualifications', label: 'Expired', kind: 'cert', color: 'rust', items: () => certs.filter(c => { const n = daysUntil(qual(c).expiryDate); return (n !== null && n < 0) || qual(c).status === 'Expired'; })},
  'qual-eval90':    {g: 'Qualifications', label: 'Evaluation due in 90 days', kind: 'cert', items: () => certs.filter(c => dateWithin(qual(c).nextEvaluation, 90))},
  'qual-cond':      {g: 'Qualifications', label: 'Conditional', kind: 'cert', color: 'gold', items: () => certs.filter(c => qual(c).status === 'Conditional')},
  'qual-none':      {g: 'Qualifications', label: 'Completed, no qualification details', kind: 'cert', items: () => certs.filter(c => c.completed && !hasQualification(c))},
  'customers-open': {g: 'Certifications', label: 'Customers with open work', kind: 'customer', items: () => {
    const byCustomer = {};
    certs.filter(c => !c.completed).forEach(c => (byCustomer[customerKey(c)] = byCustomer[customerKey(c)] || []).push(c));
    return Object.keys(byCustomer).map(name => ({name, certs: byCustomer[name]}));
  }},
  'act-open':       {g: 'Activities', label: 'Open activities', kind: 'act', items: () => allActivities().filter(x => activityGroupOf(x.a) !== 'Complete')},
  'act-ns':         {g: 'Activities', label: 'Not Started', kind: 'act', color: 'slate', items: () => allActivities().filter(x => activityGroupOf(x.a) === 'Not Started')},
  'act-ip':         {g: 'Activities', label: 'In Progress', kind: 'act', color: 'gold', items: () => allActivities().filter(x => activityGroupOf(x.a) === 'In Progress')},
  'act-wait':       {g: 'Activities', label: 'Waiting', kind: 'act', color: 'plum', items: () => allActivities().filter(x => activityGroupOf(x.a) === 'Waiting')},
  'act-overdue':    {g: 'Activities', label: 'Overdue activities', kind: 'act', color: 'rust', items: () => allActivities().filter(x => isActivityOverdue(x.a))},
  'act-week':       {g: 'Activities', label: 'Activities due this week', kind: 'act', items: () => {
    const today = localToday(), last = isoAddDays(today, 7);
    return allActivities().filter(x => activityGroupOf(x.a) !== 'Complete' && x.a.dateDue && x.a.dateDue >= today && x.a.dateDue <= last);
  }},
  'act-wait14':     {g: 'Activities', label: 'Waiting over 14 days', kind: 'act', color: 'plum', items: () => {
    const cutoff = isoAddDays(localToday(), -14);
    return allActivities().filter(x => activityGroupOf(x.a) === 'Waiting' && x.a.waitingSince && x.a.waitingSince <= cutoff);
  }},
  'act-done-7':     {g: 'Activities', label: 'Completed in last 7 days', kind: 'act', color: 'sage', items: () => allActivities().filter(x => activityGroupOf(x.a) === 'Complete' && (x.a.dateCompleted || '') >= isoAddDays(localToday(), -6))},
  'act-done-month': {g: 'Activities', label: 'Completed this month', kind: 'act', color: 'sage', items: () => allActivities().filter(x => activityGroupOf(x.a) === 'Complete' && (x.a.dateCompleted || '').slice(0, 7) === localToday().slice(0, 7))},
  'act-late':       {g: 'Activities', label: 'Completed late', kind: 'act', items: () => allActivities().filter(x => activityGroupOf(x.a) === 'Complete' && x.a.dateDue && x.a.dateCompleted && x.a.dateCompleted > x.a.dateDue)},
  'atd-resubmit':   {g: 'FAA ATD', label: 'ATD resubmit due', kind: 'atd', color: 'rust', items: () => atdDevices().filter(atdResubmitDue)},
  'atd-pending':    {g: 'FAA ATD', label: 'ATD pending', kind: 'atd', color: 'slate', items: () => atdDevices().filter(atdPending)},
  'atd-expiring':   {g: 'FAA ATD', label: 'ATD under 365 days', kind: 'atd', color: 'gold', items: () => atdDevices().filter(d => ['yellow', 'red', 'expired'].includes(atdBand(d)))},
  'atd-kb-behind':  {g: 'FAA ATD', label: 'KB behind spreadsheet', kind: 'atd', color: 'rust', editorOnly: true, items: () => EDITOR ? kbBehind() : []},
  'cm-7':           {g: 'Recent', label: 'Comments in last 7 days', kind: 'comment', items: () => {
    const since = isoAddDays(localToday(), -6);
    return allActivities().flatMap(x => (x.a.comments || []).filter(cm => (cm.date || '') >= since).map(cm => ({...x, cm})));
  }}
};

// Measures by authority or level are keyed "auth:FAA", "level:AATD" and built from the data.
function summaryMeasure(key){
  if(MEASURES[key]) return {key, ...MEASURES[key]};
  const m = String(key).match(/^(auth|level):(.+)$/);
  if(!m) return null;
  const fieldName = m[1] === 'auth' ? 'authority' : 'level';
  return {key, g: m[1] === 'auth' ? 'By authority' : 'By level', label: 'Open \u2013 ' + m[2], kind: 'cert',
    items: () => certs.filter(c => !c.completed && (c[fieldName] || '').trim() === m[2])};
}

function loadSummaryBoxes(){
  try{
    const saved = JSON.parse(localStorage.getItem(SUMMARY_KEY) || 'null');
    if(Array.isArray(saved)){
      const valid = saved.filter(k => typeof k === 'string' && (MEASURES[k] || /^(auth|level):./.test(k))).slice(0, SUMMARY_MAX);
      if(valid.length) return valid;
    }
  }catch(e){}
  return [...SUMMARY_DEFAULT];
}

function saveSummaryBoxes(){
  try{ localStorage.setItem(SUMMARY_KEY, JSON.stringify(summaryBoxes)); }catch(e){}
}

function measureOptionsHtml(selected){
  const groups = {};
  Object.keys(MEASURES).filter(k => EDITOR || !MEASURES[k].editorOnly).forEach(k => (groups[MEASURES[k].g] = groups[MEASURES[k].g] || []).push([k, MEASURES[k].label]));
  const values = f => [...new Set(certs.map(c => (c[f] || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b));
  groups['By authority'] = values('authority').map(v => ['auth:' + v, 'Open \u2013 ' + v]);
  groups['By level'] = values('level').map(v => ['level:' + v, 'Open \u2013 ' + v]);
  // Keep a saved choice selectable even if no certification uses that value any more.
  const sm = summaryMeasure(selected);
  if(sm && !Object.values(groups).some(list => list.some(([k]) => k === selected))) (groups[sm.g] = groups[sm.g] || []).push([selected, sm.label]);
  return ['Certifications', 'By authority', 'By level', 'Activities', 'FAA ATD', 'Recent']
    .filter(g => groups[g] && groups[g].length)
    .map(g => `<optgroup label="${g}">${groups[g].map(([k, l]) => `<option value="${escapeHtml(k)}" ${k === selected ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</optgroup>`)
    .join('');
}

function renderSummary(){
  const el = document.getElementById('summary');
  if(!el) return;
  if(!summaryBoxes) summaryBoxes = loadSummaryBoxes();
  const current = view.type === 'list' ? view.key : null;
  const tools = document.getElementById('summary-tools');
  if(tools){
    tools.innerHTML = summaryEditing
      ? `<button class="link-btn" type="button" onclick="resetSummary()">Reset to default</button><button class="link-btn strong" type="button" onclick="toggleSummaryEdit()">Done</button>`
      : `<button class="link-btn" type="button" onclick="toggleSummaryEdit()">Customize</button>`;
  }
  el.classList.toggle('editing', summaryEditing);
  const boxes = summaryBoxes.map((key, i) => {
    const m = summaryMeasure(key);
    const n = m.items().length;
    const num = `<span class="sbox-n ${m.color ? 'c-' + m.color : ''}">${n}</span>`;
    if(summaryEditing){
      return `
        <div class="sbox-edit" draggable="true" data-i="${i}">
          <div class="sbox-tools">
            <span class="sbox-arrows">
              <button class="mini-btn" type="button" aria-label="Move left" ${i === 0 ? 'disabled' : ''} onclick="moveSummaryBox(${i}, -1)">${ICON.arrowLeft}</button>
              <button class="mini-btn" type="button" aria-label="Move right" ${i === summaryBoxes.length - 1 ? 'disabled' : ''} onclick="moveSummaryBox(${i}, 1)">${ICON.arrowRight}</button>
            </span>
            <span class="sbox-grip" title="Drag to move" aria-hidden="true">${ICON.grip}</span>
            ${summaryBoxes.length > 1 ? `<button class="mini-btn danger" type="button" aria-label="Remove box" title="Remove" onclick="removeSummaryBox(${i})">${ICON.x}</button>` : '<span></span>'}
          </div>
          <div class="sbox-line">${num}<span class="sbox-l">${escapeHtml(m.label)}</span></div>
          <select aria-label="What this box shows" onchange="setSummaryBox(${i}, this.value)">${measureOptionsHtml(key)}</select>
        </div>`;
    }
    return `<button class="sbox ${current === key ? 'sel' : ''}" type="button" aria-pressed="${current === key}" title="${escapeHtml(m.label)}" onclick="openSummaryList(${i})">${num}<span class="sbox-l">${escapeHtml(m.label)}</span></button>`;
  }).join('');
  el.innerHTML = boxes + (summaryEditing && summaryBoxes.length < SUMMARY_MAX
    ? `<button class="sbox-add" type="button" onclick="addSummaryBox()">${ICON.plus}<span>Add box</span></button>` : '');
  const note = document.getElementById('summary-note');
  if(note) note.textContent = summaryEditing ? `${summaryBoxes.length} of ${SUMMARY_MAX} boxes \u00b7 Use the arrows or drag to reorder \u00b7 Saved in this browser only` : '';
  if(summaryEditing) wireSummaryDrag(el);
}

function wireSummaryDrag(el){
  el.querySelectorAll('.sbox-edit').forEach(box => {
    box.addEventListener('dragstart', e => { summaryDragFrom = Number(box.dataset.i); box.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try{ e.dataTransfer.setData('text/plain', box.dataset.i); }catch(err){} });
    box.addEventListener('dragend', () => { box.classList.remove('dragging'); el.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target')); });
    box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drop-target'); });
    box.addEventListener('dragleave', () => box.classList.remove('drop-target'));
    box.addEventListener('drop', e => {
      e.preventDefault();
      const to = Number(box.dataset.i);
      if(summaryDragFrom !== null && summaryDragFrom !== to){
        const [moved] = summaryBoxes.splice(summaryDragFrom, 1);
        summaryBoxes.splice(to, 0, moved);
        saveSummaryBoxes();
      }
      summaryDragFrom = null;
      renderSummary();
    });
  });
}

function toggleSummaryEdit(){ summaryEditing = !summaryEditing; renderSummary(); }
function resetSummary(){ summaryBoxes = [...SUMMARY_DEFAULT]; saveSummaryBoxes(); renderSummary(); }
function setSummaryBox(i, key){ summaryBoxes[i] = key; saveSummaryBoxes(); renderSummary(); }
function removeSummaryBox(i){ if(summaryBoxes.length > 1){ summaryBoxes.splice(i, 1); saveSummaryBoxes(); renderSummary(); } }
function moveSummaryBox(i, d){
  const j = i + d;
  if(j < 0 || j >= summaryBoxes.length) return;
  [summaryBoxes[i], summaryBoxes[j]] = [summaryBoxes[j], summaryBoxes[i]];
  saveSummaryBoxes();
  renderSummary();
}
function addSummaryBox(){
  if(summaryBoxes.length >= SUMMARY_MAX) return;
  summaryBoxes.push(Object.keys(MEASURES).find(k => !summaryBoxes.includes(k)) || 'certs-open');
  saveSummaryBoxes();
  renderSummary();
}
function openSummaryList(i){ navigate({type: 'list', key: summaryBoxes[i]}); }

// ---- Lists opened from the summary bar ----
// Sorted by customer, SN, authority, then due or completion date (no date last).
const textCmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, {sensitivity: 'base', numeric: true});
const dateCmp = (a, b) => (!a && !b) ? 0 : !a ? 1 : !b ? -1 : a.localeCompare(b);
const certSortCmp = (a, b) => textCmp(customerKey(a), customerKey(b)) || textCmp(a.serial, b.serial) || textCmp(a.authority, b.authority);
const certDate = c => c.completed ? c.dateCompleted : c.date;
const actDate = a => activityGroupOf(a) === 'Complete' ? a.dateCompleted : a.dateDue;
let rowActions = [];   // what each clickable row in the main panel opens

function sortListItems(kind, items){
  const list = [...items];
  if(kind === 'cert') return list.sort((a, b) => certSortCmp(a, b) || dateCmp(certDate(a), certDate(b)));
  if(kind === 'act') return list.sort((x, y) => certSortCmp(x.c, y.c) || dateCmp(actDate(x.a), actDate(y.a)));
  if(kind === 'comment') return list.sort((x, y) => certSortCmp(x.c, y.c) || dateCmp(y.cm.date, x.cm.date));
  if(kind === 'atd') return atdOrdered(list);
  return list.sort((a, b) => textCmp(a.name, b.name));
}

function dueText(due, done, overdue){
  if(done) return `Completed ${fmtDate(done)}`;
  if(due) return `${overdue ? '<span class="pill pill-overdue">Overdue</span> ' : ''}Due ${fmtDate(due)}`;
  return 'No due date';
}

function certLine(c){
  return `<b class="row-strong">${escapeHtml(customerKey(c))}</b> <span class="row-sub">\u00b7 SN: ${escapeHtml(c.serial || '\u2014')}${(c.authority || c.level) ? ' \u00b7 ' + escapeHtml([c.authority, c.level].filter(Boolean).join(' ')) : ''}</span>`;
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
  if(kind === 'cert'){
    return rowButton({type: 'cert', id: item.id, from}, certLine(item), dueText(item.date, item.completed ? item.dateCompleted : '', isOverdue(item)));
  }
  if(kind === 'atd') return rowButton({type: 'atd', id: item.id, from}, atdLine(item), atdRowSide(item));
  if(kind === 'customer'){
    const first = sortCerts(item.certs)[0];
    return rowButton({type: 'cert', id: first.id, from}, `<b class="row-strong">${escapeHtml(item.name)}</b>`, countLabel(item.certs.length, 'open certification', 'open certifications'));
  }
  const {c, a} = item;
  const status = activityStatusLabel(a.status);
  const pill = `<span class="pill pill-${activityStatusClass(status)}">${escapeHtml(status)}</span>`;
  if(kind === 'comment'){
    return rowButton({type: 'act', certId: c.id, activityId: a.id, comment: true, from},
      `${certLine(c)}<br>${ICON.comment}<span>${escapeHtml(plainSnippet(item.cm.text, 160))}</span><br><span class="row-sub">On: ${escapeHtml(plainSnippet(a.description, 90))}</span>`,
      fmtDate(item.cm.date));
  }
  return rowButton({type: 'act', certId: c.id, activityId: a.id, from},
    `${certLine(c)}<br>${pill}${escapeHtml(plainSnippet(a.description || a.text, 180))}${status === 'Waiting' && a.waitingSince ? ` <span class="row-sub">\u00b7 Waiting since ${fmtDate(a.waitingSince)}</span>` : ''}`,
    dueText(a.dateDue, status === 'Complete' ? a.dateCompleted : '', isActivityOverdue(a)));
}

function openRow(i){
  const act = rowActions[i];
  if(!act) return;
  if(act.type === 'cert') return navigate({type: 'cert', id: act.id}, act.from);
  if(act.type === 'reg') return navigate({type: 'reg', id: act.id, page: act.page}, act.from);
  if(act.type === 'atd') return navigate({type: 'atd-dev', id: act.id, doc: act.doc || '', page: act.page || 1}, act.from);
  if(act.type === 'act'){
    const c = certs.find(x => x.id === act.certId);
    const a = c && (c.activityLog || []).find(x => x.id === act.activityId);
    if(!a) return;
    openActivityGroups.add(activityGroupKey(c.id, activityGroupOf(a)));
    if(act.comment) openThreads.add(a.id);
    pendingFocus = a.id;
    navigate({type: 'cert', id: c.id}, act.from);
  }
}

function renderListView(key){
  const m = summaryMeasure(key);
  if(!m) return renderHome();
  rowActions = [];
  const items = sortListItems(m.kind, m.items());
  const from = {type: 'list', key};
  return `
    <div class="detail-context">Summary</div>
    <h2 class="detail-title ${m.color ? 'c-' + m.color : ''}">${escapeHtml(m.label)} <span class="title-count">(${items.length})</span></h2>
    <div class="row-list">${items.length ? items.map(it => listRowHtml(m.kind, it, from)).join('') : '<div class="muted list-empty">Nothing to show.</div>'}</div>`;
}

// =====================================================================
// Regulatory library: stored PDFs (regs/ folder) listed in data/library.json
// =====================================================================
let library = {documents: [], searchResetAt: '', searchTally: {}};
let librarySha = null;
let libraryLoaded = false;

function libraryPath(){
  const base = (ghConfig && ghConfig.path) || FILE_PATH_DEFAULT;
  return base.replace(/[^/]*$/, '') + 'library.json';
}

function normalizeLibrary(raw){
  const lib = raw && typeof raw === 'object' ? raw : {};
  return {
    documents: Array.isArray(lib.documents) ? lib.documents.filter(d => d && d.id) : [],
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

function libraryDoc(id){ return library.documents.find(d => d.id === id); }

// ---- Weekly regulatory check (results written to data/reg-status.json by .github/workflows/reg-check.yml) ----
let regStatus = null;
const regFlagOpened = new Set();   // {checkedAt, documents: {id: {status, found, checkedAt}}}

function regStatusPath(){ return libraryPath().replace(/library\.json$/, 'reg-status.json'); }

function regCheck(id){
  return regStatus && regStatus.documents && regStatus.documents[id] || null;
}

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
  if(r.status === 'update') return `<div class="reg-note update"><strong>Update available: ${escapeHtml(r.latest || 'newer version')}</strong> (your copy: ${escapeHtml(yourCopy(d))}). ${escapeHtml(r.found || '')}${when ? ` <span class="reg-note-when">Checked ${when}</span>` : ''}</div>`;
  if(r.status === 'current') return `<div class="reg-note current">Stored copy matches the latest version found.${when ? ` <span class="reg-note-when">Checked ${when}</span>` : ''}</div>`;
  if(r.status === 'unmonitored') return EDITOR ? `<div class="reg-note muted-note">Not monitored: no official source page is set for this document. Add one with Edit so the weekly check can watch it.</div>` : '';
  if(r.status === 'error') return EDITOR ? `<div class="reg-note error">The weekly check couldn't read the official source${r.found ? `: ${escapeHtml(r.found)}` : ''}. It will try again next week.</div>` : '';
  return '';
}

function renderRegUsedBy(d){
  const list = sortCerts(certsUsingDoc(d.id, false));
  if(!list.length) return '';
  const open = list.filter(c => !c.completed), done = list.filter(c => c.completed);
  const link = c => `<button class="link-inline" type="button" onclick="selectCert('${c.id}')">${escapeHtml(customerKey(c))} (${escapeHtml([c.serial, c.aircraft].filter(Boolean).join(', ') || certName(c))})</button>`;
  return `<div class="reg-used-by"><span class="fk">Used by</span> ${open.map(link).join(', ') || '<span class="muted">no open certifications</span>'}${done.length ? ` <span class="muted">\u00b7 ${countLabel(done.length, 'completed certification', 'completed certifications')}</span>` : ''}</div>`;
}

function libraryAuthorities(){
  return [...new Set(library.documents.map(d => d.authority || 'Other'))].sort(textCmp);
}

function docTitle(d){ return `${d.authority ? d.authority + ' ' : ''}${d.title}`; }

// PDFs are in the private data repo, so they are fetched with the key and shown from a local copy.
// Shared by the regulatory library and the ATD documents (3.1.1); kept for the visit, keyed by repo path.
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

// The library starts collapsed. An authority with an update opens once, so the flag can't hide
// in a collapsed group.
function prepareLibraryExpansion(){
  if(!library.documents.length) return;
  libraryExpandInit = true;
  library.documents.forEach(d => {
    if((regCheck(d.id) || {}).status === 'update' && !regFlagOpened.has(d.id)){ expandedAuthorities.add(d.authority || 'Other'); regFlagOpened.add(d.id); }
  });
}

function renderLibraryList(){
  if(!library.documents.length){
    return `<div class="side-empty">${libraryLoaded ? 'No documents yet' : 'Loading\u2026'}</div>`;
  }
  const auths = libraryAuthorities();
  return auths.map(auth => {
    const open = expandedAuthorities.has(auth);
    const docs = library.documents.filter(d => (d.authority || 'Other') === auth).sort((a, b) => textCmp(a.title, b.title));
    return `
      <div class="side-customer">
        <button class="side-customer-btn" aria-expanded="${open}" onclick="toggleAuthority('${escapeAttr(auth)}')">
          <span class="chevron ${open ? 'open' : ''}" aria-hidden="true">&#9656;</span>
          <span class="side-customer-name">${escapeHtml(auth)}</span>
          <span class="tab-count zero">${docs.length}</span>
        </button>
        ${open ? `<div class="side-certs">${docs.map(d => {
          const active = view.type === 'reg' && view.id === d.id;
          return `
          <button class="side-cert side-doc ${active ? 'active' : ''}" ${active ? 'aria-current="true"' : ''} onclick="openDoc('${d.id}')">
            ${ICON.file}
            <span class="side-cert-name">${escapeHtml(d.title)}${d.revision ? `<span class="side-cert-auth">${escapeHtml(d.revision)}</span>` : ''}${regBadge(d.id)}</span>
          </button>`;
        }).join('')}</div>` : ''}
      </div>`;
  }).join('');
}

function toggleAuthority(a){
  if(expandedAuthorities.has(a)) expandedAuthorities.delete(a);
  else expandedAuthorities.add(a);
  render();
}

function toggleAllAuthorities(){
  const auths = libraryAuthorities();
  if(auths.some(a => expandedAuthorities.has(a))) expandedAuthorities.clear();
  else auths.forEach(a => expandedAuthorities.add(a));
  render();
}

function openDoc(id, page){ navigate({type: 'reg', id, page: page || 1}); }

const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

function renderRegView(){
  const d = libraryDoc(view.id);
  if(!d) return libraryLoaded ? renderHome() : '<div class="muted">Loading\u2026</div>';
  const page = view.page || 1;
  const url = pdfPageUrl('regs/' + d.file, page);
  const meta = [d.revision, d.asOf ? 'Copy as of ' + fmtDate(d.asOf) : '', d.pages ? countLabel(d.pages, 'page', 'pages') : ''].filter(Boolean).join(' \u00b7 ');
  return `
    ${backLinkHtml()}
    <div class="detail-context">Regulatory library / ${escapeHtml(d.authority || 'Other')}</div>
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

// =====================================================================
// Search: certifications, activities, comments and the regulatory library
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

function searchCerts(t){
  return sortListItems('cert', certs.filter(c =>
    [customerKey(c), c.serial, c.authority, c.level, c.aircraft, certName(c), certModel(c), c.country,
     ...(Array.isArray(c.docs) ? c.docs.map(d => d.name) : [])]
      .some(v => textHas(v, t))));
}

function searchActivities(t){
  const out = [];
  allActivities().forEach(x => {
    if(textHas(x.a.description, t)) out.push({...x, kind: 'act'});
    (x.a.comments || []).forEach(cm => { if(textHas(cm.text, t)) out.push({...x, cm, kind: 'comment'}); });
  });
  return out.sort((x, y) => certSortCmp(x.c, y.c) || dateCmp(actDate(x.a), actDate(y.a)));
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
  rowActions = [];
  const q = view.q;
  const t = q.toLowerCase();
  const from = {type: 'search', q, tab: view.tab};
  const certHits = searchCerts(t);
  const actHits = searchActivities(t);
  const ready = regSearchReady();
  const regHits = ready ? searchRegs(t) : [];
  const regPages = regHits.reduce((n, r) => n + r.hits.length, 0);
  const atdReady = atdSearchReady();
  const atdHits = atdReady ? searchAtd(t) : {devices: [], docs: [], count: 0};
  const total = certHits.length + actHits.length + regPages + atdHits.count;
  if(ready && atdReady && total > 0 && recordedSeq !== searchSeq){ recordedSeq = searchSeq; recordSearch(q); }

  const tab = view.tab || 'all';
  const all = tab === 'all';
  const tabs = [['all', 'All', ready ? total : null], ['certs', 'Certifications', certHits.length], ['acts', 'Activities', actHits.length], ['regs', 'Regulations', ready ? regPages : null]];
  if(atd.devices.length) tabs.push(['atd', 'ATD devices', atdReady ? atdHits.count : null]);
  if(!atdReady) tabs[0][2] = null;
  const groupHead = (key, label, count) => `<div class="result-group"><b>${label} <span class="title-count">(${count})</span></b>${all && count > 3 ? `<button class="side-tool" type="button" onclick="setSearchTab('${key}')">Show all</button>` : ''}</div>`;

  let body = '';
  if(all || tab === 'certs'){
    if(certHits.length) body += groupHead('certs', 'Certifications', certHits.length) + certHits.slice(0, all ? 3 : undefined).map(c =>
      rowButton({type: 'cert', id: c.id, from}, `<b class="row-strong">${highlight(customerKey(c), q)}</b> <span class="row-sub">\u00b7 SN: ${highlight(c.serial || '\u2014', q)} \u00b7 ${highlight([c.authority, c.level].filter(Boolean).join(' '), q)}${c.aircraft ? ' \u00b7 ' + highlight(c.aircraft, q) : ''}</span>`, dueText(c.date, c.completed ? c.dateCompleted : '', isOverdue(c)))).join('');
  }
  if(all || tab === 'acts'){
    if(actHits.length) body += groupHead('acts', 'Activities and comments', actHits.length) + actHits.slice(0, all ? 3 : undefined).map(x => {
      const status = activityStatusLabel(x.a.status);
      const text = x.kind === 'comment' ? x.cm.text : x.a.description;
      return rowButton({type: 'act', certId: x.c.id, activityId: x.a.id, comment: x.kind === 'comment', from},
        `<span class="row-sub">${escapeHtml(customerKey(x.c))} \u00b7 SN: ${escapeHtml(x.c.serial || '\u2014')}</span><br><span class="pill pill-${activityStatusClass(status)}">${escapeHtml(status)}</span>${x.kind === 'comment' ? ICON.comment : ''}${highlight(plainSnippet(text, 200), q)}`,
        x.kind === 'comment' ? 'Comment' : 'Activity');
    }).join('');
  }
  if(all || tab === 'regs'){
    if(!ready) body += `<div class="result-group"><b>Regulations</b></div><div class="muted list-empty">Searching the regulatory library\u2026</div>`;
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
  if(expandedRegResults.has(id)) expandedRegResults.delete(id);
  else expandedRegResults.add(id);
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
  const h = loadSearchHistory();
  const now = Date.now();
  return Object.values(h.terms)
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
  const box = document.getElementById('search-suggest');
  const terms = JSON.parse(box.dataset.terms || '[]');
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

// Header controls shared by both pages: search box (press / to jump there) and the summary bar.
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
// Shared helpers
// =====================================================================

function loadSettings(){
  try{
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){
    return null;
  }
}

function showBanner(kind, html){
  const el = document.getElementById('sync-banner');
  el.className = 'sync-banner ' + kind;
  el.innerHTML = html;
  el.style.display = 'block';
}

function hideBanner(){
  document.getElementById('sync-banner').style.display = 'none';
}

function b64DecodeUtf8(b64){
  return decodeURIComponent(escape(atob(b64)));
}

// ---- Icons ----
const svgIcon = (paths, width) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
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
  grip: svgIcon('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'),
  sliders: svgIcon('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  file: svgIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  external: svgIcon('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  globe: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  search: svgIcon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  comment: svgIcon('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  history: svgIcon('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 8v4l3 2"/>'),
  device: svgIcon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  bell: svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  upload: svgIcon('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>')
};

// ---- GitHub ----
// The view-only page reads without a token; the editor reads and writes with the saved token.
function ghHeaders(){
  const headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
  if(ghConfig && ghConfig.token) headers['Authorization'] = 'Bearer ' + ghConfig.token;
  return headers;
}

function ghApiUrl(path){
  return `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
}

// Reads a JSON file from the repo: {data, sha}, or null if the file doesn't exist yet.
async function ghReadJson(path){
  // no-cache: always check GitHub for a newer copy (unchanged files come back as a quick 304).
  const res = await fetch(ghApiUrl(path) + `?ref=${encodeURIComponent(ghConfig.branch)}`, {headers: ghHeaders(), cache: 'no-cache'});
  if(res.status === 404) return null;
  if(!res.ok){
    const body = await res.text();
    const err = new Error(`GitHub read failed (${res.status}): ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return {data: JSON.parse(b64DecodeUtf8(json.content.replace(/\n/g, ''))), sha: json.sha};
}

async function fetchFromGitHub(){
  lastFetchAt = Date.now();
  const res = await ghReadJson(ghConfig.path);
  if(!res) return null;
  currentSha = res.sha;
  return unwrapCerts(res.data);
}

// v3 files are {schemaVersion, certifications}; a v2 file (a bare list) still reads.
function unwrapCerts(data){
  if(Array.isArray(data)) return data;
  return data && Array.isArray(data.certifications) ? data.certifications : [];
}

function wrapCerts(list){
  return {schemaVersion: SCHEMA_VERSION, certifications: list};
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

function isOverdue(c){
  if(c.completed || !c.date) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(c.date + 'T00:00:00');
  return d < today;
}

function fmtDate(d){
  if(!d) return '\u2014';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
}

function isCertOverdue(c){
  if(c.completed) return false;
  if(isOverdue(c)) return true;
  const acts = Array.isArray(c.activityLog) ? c.activityLog : [];
  return acts.some(isActivityOverdue);
}

function computeCertStatus(c){
  if(c.completed) return {label: 'Completed', cls: 'sage'};
  if(isCertOverdue(c)) return {label: 'Overdue', cls: 'overdue'};
  const acts = Array.isArray(c.activityLog) ? c.activityLog : [];
  if(acts.length === 0) return {label: 'No Activity', cls: 'slate'};
  const anyOpen = acts.some(a => a.status !== 'Complete');
  if(anyOpen) return {label: 'In Progress', cls: 'gold'};
  return {label: 'On Track', cls: 'sage'};
}

function sortCerts(items){
  return [...items].sort((a,b) => {
    const aDone = a.completed ? 1 : 0;
    const bDone = b.completed ? 1 : 0;
    if(aDone !== bDone) return aDone - bDone;
    const aOver = isCertOverdue(a) ? 0 : 1;
    const bOver = isCertOverdue(b) ? 0 : 1;
    if(aOver !== bOver) return aOver - bOver;
    const ad = a.date || '9999-99-99';
    const bd = b.date || '9999-99-99';
    return ad.localeCompare(bd);
  });
}

function groupBySerial(items){
  const groups = {};
  const order = [];
  items.forEach(c => {
    const key = c.serial || 'No serial number';
    if(!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(c);
  });
  return { groups, order };
}

// Small outlined action button. compact = icon-only on phones (label kept as tooltip).
function actionBtn(kind, label, onclick, opts){
  const o = opts || {};
  const cls = ['btn-text', o.cls || '', o.compact === false ? '' : 'compact'].join(' ').trim();
  return `<button class="${cls}" onclick="${onclick}" title="${label}" aria-label="${label}">${ICON[kind]}<span class="btn-label" data-label="${label}">${label}</span></button>`;
}

// "View" button: opens a document's link in a new tab (only for documents that have a link).
function viewBtn(doc){
  const url = typeof doc === 'string' ? '' : (doc.url || '');
  if(!url) return '';
  return `<a class="btn-text compact" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="View" aria-label="View">${ICON.eye}<span class="btn-label">View</span></a>`;
}

// ---- Google Drive preview ----
// Turns a Drive or Google Docs share link into its embeddable preview address ('' if it isn't one).
function drivePreviewUrl(url){
  const u = String(url || '');
  let m = u.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
  if(m) return `https://docs.google.com/${m[1]}/d/${m[2]}/preview`;
  m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/);
  if(m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  return '';
}

function findCertDoc(certId, docId){
  const c = certs.find(x => x.id === certId);
  return c && Array.isArray(c.docs) ? c.docs.find(d => d && d.id === docId) || null : null;
}

function previewBtn(c, doc){
  if(typeof doc === 'string' || !doc.id || !drivePreviewUrl(doc.url)) return '';
  return `<button class="btn-text compact" type="button" title="Preview" aria-label="Preview" onclick="openDrivePreview('${c.id}', '${doc.id}')">${ICON.file}<span class="btn-label">Preview</span></button>`;
}

function openDrivePreview(certId, docId){ navigate({type: 'doc', cert: certId, doc: docId}); }

function renderDrivePreview(c){
  const d = findCertDoc(c.id, view.doc);
  if(!d) return renderCertDetail(c);
  const src = drivePreviewUrl(d.url);
  return `
    <button class="back-link" type="button" onclick="selectCert('${c.id}')">${ICON.arrowLeft}<span>Back to ${escapeHtml(customerKey(c))}${c.serial ? ' / SN ' + escapeHtml(c.serial) : ''}</span></button>
    <div class="detail-context">${escapeHtml(customerKey(c))}${c.serial ? ' / ' + escapeHtml(c.serial) : ''} / Documents</div>
    <div class="detail-head"><div><h2 class="detail-title">${escapeHtml(d.name || 'Document')}</h2></div></div>
    <div class="detail-actions doc-actions">
      <a class="btn-text" href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${ICON.external}<span>Open in Drive</span></a>
    </div>
    ${isPhone()
      ? `<a class="btn-primary open-doc-btn" href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${ICON.file}<span>Open document</span></a>`
      : `<iframe class="pdf-frame" src="${escapeHtml(src)}" title="${escapeHtml(d.name || 'Document preview')}" allow="autoplay"></iframe>
         <p class="drive-access-note">Can't see the document? You need access to this file in Google Drive. Sign in with an account that has access, or ask the file's owner to share it.</p>`}`;
}

// ---- Automatic certification name and SIM model ----
// SIM model is read from the serial: skip a leading "R-" prefix, take the letters before the digits
// (R-MCX-100251 -> MCX, FMX-0297 -> FMX). A typed model overrides it.
function detectModel(serial){
  const m = String(serial || '').trim().toUpperCase().match(/^(?:R-)?([A-Z]+)(?=[-\s]?\d)/);
  return m ? m[1] : '';
}

function certModel(c){
  return (c.simModel || '').trim() || detectModel(c.serial);
}

// "Authority Level - Aircraft (Model)", e.g. "UKCAA FNPT II - Piper PA-28-181 Archer (MCX)"
function autoName(c){
  let n = [c.authority, c.level].map(x => (x || '').trim()).filter(Boolean).join(' ');
  const aircraft = (c.aircraft || '').trim();
  if(aircraft) n = n ? `${n} - ${aircraft}` : aircraft;
  const model = certModel(c);
  if(model) n = n ? `${n} (${model})` : model;
  return n;
}

// Existing certifications (no nameAuto flag) keep their typed names as overrides.
function certName(c){
  if(c.nameAuto) return autoName(c) || c.name || 'Untitled certification';
  return c.name || autoName(c) || 'Untitled certification';
}

// ---- Completed certifications ----
function localToday(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- Contact details ----
// Older data keeps name and email together in primaryContact ("Name - name@example.com").
const EMAIL_RE = /[^\s<>(),;:]+@[^\s<>(),;:]+\.[A-Za-z]{2,}/;

function splitContact(text){
  const t = String(text || '').trim();
  const m = t.match(EMAIL_RE);
  if(!m) return {name: t, email: ''};
  const name = t.replace(m[0], ' ')
    .replace(/[<>()]/g, ' ')
    .replace(/\s*[-\u2013\u2014,;:|]\s*$/, '')
    .replace(/^\s*[-\u2013\u2014,;:|]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return {name, email: m[0]};
}

function contactName(c){
  if(c.contactName !== undefined || c.contactEmail !== undefined) return c.contactName || '';
  return splitContact(c.primaryContact).name;
}

function contactEmail(c){
  if(c.contactName !== undefined || c.contactEmail !== undefined) return c.contactEmail || '';
  return splitContact(c.primaryContact).email;
}

// View-only page shows SIM location as city, state and country only.
// "2825 Airport Drive, Vero Beach, FL 32960, USA" -> "Vero Beach, FL, USA".
// Entries without a street number ("Greece", "RBHQ") are shown as entered;
// any other full address shows just its country (the last part).
function publicLocation(loc){
  const s = String(loc || '').trim();
  if(!s) return '';
  if(!/\d/.test(s)) return s;
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const si = parts.findIndex(x => /^[A-Z]{2}\s+\d{5}(-\d{4})?$/.test(x));
  if(si > 0){
    const state = parts[si].slice(0, 2);
    const country = parts.slice(si + 1).join(', ') || 'USA';
    return `${parts[si - 1]}, ${state}, ${country}`;
  }
  const last = parts[parts.length - 1];
  return /\d/.test(last) ? '' : last;
}

function customerKey(c){
  return (c.customer || 'Unassigned').trim() || 'Unassigned';
}

function toggleCustomer(name){
  if(expandedCustomers.has(name)) expandedCustomers.delete(name);
  else expandedCustomers.add(name);
  render();
}

function escapeAttr(s){
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// For completed activities: how many days after the due date they were completed ('' if on time or unknown).
function lateNote(a){
  if(a.status !== 'Complete' || !a.dateDue || !a.dateCompleted) return '';
  const days = Math.round((new Date(a.dateCompleted + 'T00:00:00') - new Date(a.dateDue + 'T00:00:00')) / 86400000);
  if(days <= 0) return '';
  return ` <span class="late-note">(${days} day${days === 1 ? '' : 's'} late)</span>`;
}

function isActivityOverdue(a){
  if(a.status === 'Complete') return false;
  if(!a.dateDue) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  return new Date(a.dateDue + 'T00:00:00') < today;
}

// Activity statuses: Not Started, In Progress, Waiting (on another party), Complete.
// "Pending" is the old name for Not Started and is shown as Not Started.
function activityStatusLabel(status){
  if(!status || status === 'Pending') return 'Not Started';
  return status;
}

function activityStatusClass(status){
  if(status === 'Complete') return 'sage';
  if(status === 'In Progress') return 'gold';
  if(status === 'Waiting') return 'plum';
  return 'slate';
}

// ---- Activity comments ----
// Each activity keeps a running thread: comments: [{id, text, date, time}], oldest first.
// ---- Text with line breaks and bullets ----
// Shows typed text as written: line breaks are kept, and lines starting with "- ", "* " or "•"
// become a bulleted list. Text is escaped first, so nothing typed or pasted can change the page.
function formatText(s){
  const lines = String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null;
  lines.forEach(line => {
    const m = line.match(/^\s*(?:[-*]\s+|\u2022\s*)(.*)$/);
    if(m){
      if(!list){ list = []; }
      list.push(escapeHtml(m[1]));
      return;
    }
    if(list){ out.push({list}); list = null; }
    out.push({line: escapeHtml(line)});
  });
  if(list) out.push({list});
  let html = '';
  out.forEach((part, i) => {
    if(part.list){
      html += '<ul class="text-list">' + part.list.map(li => `<li>${li}</li>`).join('') + '</ul>';
    }else{
      const prevIsLine = i > 0 && !out[i-1].list;
      html += (prevIsLine ? '<br>' : '') + part.line;
    }
  });
  return html;
}

// ---- Activity status groups ----
// Activities are shown in one expandable group per status, in this order. Groups start collapsed;
// which groups are open is remembered (per certification) while the page is open.
const ACTIVITY_GROUPS = ['Not Started', 'In Progress', 'Waiting', 'Complete'];

const openActivityGroups = new Set();

function activityGroupKey(certId, status){ return certId + '|' + status; }

function activityGroupOf(a){
  const s = activityStatusLabel(a.status);
  return ACTIVITY_GROUPS.includes(s) ? s : 'Not Started';
}

// Non-empty groups for a certification, each with its activities sorted:
// open groups by due date (entered date when there's no due date), Completed newest first.
function activityGroups(c){
  const entries = Array.isArray(c.activityLog) ? c.activityLog : [];
  return ACTIVITY_GROUPS.map(status => {
    const items = entries.filter(a => activityGroupOf(a) === status);
    if(status === 'Complete'){
      items.sort((a,b) => {
        const ad = (a.dateCompleted || a.dateDue || a.dateCreated || '') + (a.dateCompleted ? to24(a.timeCompleted) : '');
        const bd = (b.dateCompleted || b.dateDue || b.dateCreated || '') + (b.dateCompleted ? to24(b.timeCompleted) : '');
        return bd.localeCompare(ad);
      });
    }else{
      items.sort((a,b) => (a.dateDue || a.dateCreated || '').localeCompare(b.dateDue || b.dateCreated || ''));
    }
    return {status, items};
  }).filter(g => g.items.length);
}

// "9:05 AM" -> "09:05" so times sort correctly; unknown formats sort first.
function to24(t){
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*([AP]M)?$/i);
  if(!m) return '';
  let h = Number(m[1]) % 12;
  if(m[3] && m[3].toUpperCase() === 'PM') h += 12;
  if(!m[3]) h = Number(m[1]);
  return String(h).padStart(2, '0') + ':' + m[2];
}

function activitiesAnyOpen(c){
  const entries = Array.isArray(c.activityLog) ? c.activityLog : [];
  return ACTIVITY_GROUPS.some(s => openActivityGroups.has(activityGroupKey(c.id, s)))
    || entries.some(a => openThreads.has(a.id));
}

function toggleActivityGroup(certId, status){
  const key = activityGroupKey(certId, status);
  if(openActivityGroups.has(key)) openActivityGroups.delete(key);
  else openActivityGroups.add(key);
  render();
}

// Collapse all closes every group and comment thread for this certification;
// Expand all opens every group and leaves comment threads closed.
function toggleAllActivities(certId){
  const c = certs.find(x => x.id === certId);
  if(!c) return;
  const entries = Array.isArray(c.activityLog) ? c.activityLog : [];
  if(activitiesAnyOpen(c)){
    ACTIVITY_GROUPS.forEach(s => openActivityGroups.delete(activityGroupKey(certId, s)));
    entries.forEach(a => openThreads.delete(a.id));
  }else{
    activityGroups(c).forEach(g => openActivityGroups.add(activityGroupKey(certId, g.status)));
  }
  render();
}

function activityToggleAllBtn(c){
  if(!(Array.isArray(c.activityLog) && c.activityLog.length)) return '';
  const any = activitiesAnyOpen(c);
  const label = any ? 'Collapse all' : 'Expand all';
  return `<button class="act-toggle-all" type="button" onclick="toggleAllActivities('${c.id}')" title="${label} activities">${any ? ICON.collapseAll : ICON.expandAll}<span>${label}</span></button>`;
}

function renderActivityGroups(c, renderEntry){
  const groups = activityGroups(c);
  if(!groups.length) return '<div class="changelog-entry"><span class="changelog-text" style="color:var(--ink-faint)">No activities yet</span></div>';
  return '<div class="act-groups">' + groups.map((g, gi) => {
    const done = g.status === 'Complete';
    const n = g.items.length;
    const overdue = done ? 0 : g.items.filter(isActivityOverdue).length;
    let dateNote;
    if(done){
      dateNote = g.items[0].dateCompleted ? `Latest ${fmtDate(g.items[0].dateCompleted)}` : '';
    }else{
      const nextDue = g.items.map(a => a.dateDue).filter(Boolean).sort()[0];
      dateNote = nextDue ? `Next due ${fmtDate(nextDue)}` : 'No due dates';
    }
    const open = openActivityGroups.has(activityGroupKey(c.id, g.status));
    const bodyId = `grp-${c.id}-${gi}`;
    return `
      <button class="act-group" type="button" aria-expanded="${open}" aria-controls="${bodyId}" onclick="toggleActivityGroup('${c.id}', '${g.status}')">${ICON.chevron}<span class="pill pill-${activityStatusClass(g.status)}">${done ? 'Completed' : escapeHtml(g.status)}</span><span class="act-group-count">${n} ${n === 1 ? 'activity' : 'activities'}</span>${overdue ? `<span class="pill pill-overdue">${overdue} overdue</span>` : ''}<span class="act-group-date">${dateNote}</span></button>
      ${open ? `<div class="act-group-body" id="${bodyId}">${g.items.map(a => renderEntry(a)).join('')}</div>` : ''}`;
  }).join('') + '</div>';
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s == null ? '' : s;
  return d.innerHTML;
}

function renderDocLocation(loc){
  if(!loc) return '';
  const isUrl = /^https?:\/\//i.test(loc.trim());
  if(isUrl){
    return `<div class="doc-loc"><a href="${escapeHtml(loc.trim())}" target="_blank" rel="noopener noreferrer">${escapeHtml(loc.trim())}</a></div>`;
  }
  return `<div class="doc-loc">${escapeHtml(loc)}</div>`;
}

function renderDocItem(doc){
  const name = typeof doc === 'string' ? doc : (doc.name || '');
  return escapeHtml(name);
}
