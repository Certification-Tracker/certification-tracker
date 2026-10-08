// =====================================================================
// FAA ATD approvals (3.1): Redbird ATD devices' QAG and LOA status.
// data/atd.json comes from FAA_Approval_Tracker.xlsx (imported in the editor); data/kb-status.json
// and the atd/ folder are written weekly by scripts/check_kb.py, which finds each device's QAG and
// LOA in the Redbird knowledge base and compares them with the spreadsheet.
// Shared by both pages; loaded after tracker.js.
// =====================================================================
let atd = {devices: [], source: {}};
let atdSha = null;
let atdLoaded = false;
let kbStatus = null;

const ATD_YELLOW_DAYS = 365;     // 180-365 days to expiry
const ATD_RED_DAYS = 180;        // under 180 days
const ATD_RESUBMIT_DAYS = 180;   // resubmittals projected 180 days out

function dataDir(){ return libraryPath().replace(/library\.json$/, ''); }
function atdPath(){ return dataDir() + 'atd.json'; }
function kbStatusPath(){ return dataDir() + 'kb-status.json'; }

function normalizeAtd(raw){
  const a = raw && typeof raw === 'object' ? raw : {};
  return {
    schemaVersion: 1,
    source: a.source && typeof a.source === 'object' ? a.source : {},
    devices: Array.isArray(a.devices) ? a.devices.filter(d => d && d.id).map(d => ({certIds: [], kbUrl: '', ...d})) : []
  };
}

async function loadAtd(){
  try{
    const res = await ghReadJson(atdPath());
    if(res){ atd = normalizeAtd(res.data); atdSha = res.sha; }
  }catch(e){ /* optional: the tracker works without ATD data */ }
  try{
    const st = await ghReadJson(kbStatusPath());
    if(st && st.data && typeof st.data === 'object') kbStatus = st.data;
  }catch(e){ /* written weekly by the knowledge base check */ }
  atdLoaded = true;
  render();
}

const atdDevices = () => atd.devices;
const atdDevice = id => atd.devices.find(d => d.id === id);

// ---- Versions: number first, then letter, so 2.1 < 2.1A < 2.1B < 2.2 and 4.12A < 4.13 ----
function versionKey(v){
  const m = String(v || '').trim().match(/^v?\.?\s*(\d+(?:\.\d+)*)([a-z]?)/i);
  if(!m) return null;
  const nums = m[1].split('.').map(Number);
  while(nums.length > 1 && nums[nums.length - 1] === 0) nums.pop();
  return {nums, letter: (m[2] || '').toUpperCase()};
}

function cmpVersion(a, b){
  const ka = versionKey(a), kb = versionKey(b);
  if(!ka || !kb) return null;
  const n = Math.max(ka.nums.length, kb.nums.length);
  for(let i = 0; i < n; i++){
    const x = ka.nums[i] || 0, y = kb.nums[i] || 0;
    if(x !== y) return x < y ? -1 : 1;
  }
  return ka.letter === kb.letter ? 0 : (ka.letter < kb.letter ? -1 : 1);
}

// "v4.13 submitted Aug 18, 2026 · FAA #20261006-83327"
function submittedText(d){
  return `${vLabel(d.submittedVersion)} submitted${d.submittedDate ? ' ' + fmtDate(d.submittedDate) : ''}${d.faaTracking ? ' \u00b7 FAA #' + escapeHtml(d.faaTracking) : ''}`;
}

const vLabel = v => v ? 'v' + String(v).replace(/^v\.?\s*/i, '') : '—';

// ---- Status ----
function atdIncomplete(d){ return d.status === 'Incomplete' || !d.expiration; }
function atdDays(d){ return atdIncomplete(d) ? null : daysUntil(d.expiration); }
function atdResubmitBy(d){ return atdIncomplete(d) ? '' : isoAddDays(d.expiration, -ATD_RESUBMIT_DAYS); }
function atdPending(d){ return !!d.submittedVersion && (!d.version || cmpVersion(d.submittedVersion, d.version) > 0); }
function atdResubmitDue(d){ return !atdIncomplete(d) && !atdPending(d) && localToday() >= atdResubmitBy(d); }

function atdBand(d){
  if(atdIncomplete(d)) return 'incomplete';
  const n = atdDays(d);
  if(n < 0) return 'expired';
  if(n < ATD_RED_DAYS) return 'red';
  if(n <= ATD_YELLOW_DAYS) return 'yellow';
  return 'green';
}

const ATD_BANDS = {
  green:      {label: 'Green', cls: 'sage', hint: 'More than 365 days to expiry'},
  yellow:     {label: 'Yellow', cls: 'gold', hint: '180 to 365 days to expiry'},
  red:        {label: 'Red', cls: 'overdue', hint: 'Under 180 days to expiry'},
  expired:    {label: 'Expired', cls: 'overdue', hint: 'Past its expiration date'},
  incomplete: {label: 'Incomplete', cls: 'neutral', hint: 'Not yet approved'}
};

function bandPill(d){
  const b = ATD_BANDS[atdBand(d)];
  return `<span class="pill pill-${b.cls}" title="${b.hint}">${b.label}</span>`;
}

function atdSorted(list){
  return [...(list || atd.devices)].sort((a, b) => dateCmp(atdIncomplete(a) ? '' : a.expiration, atdIncomplete(b) ? '' : b.expiration) || textCmp(a.name, b.name));
}

// Display order: BATD first (just TD/TD2), then AATD; FMX/MCX pinned to the top of its group,
// the rest alphabetical.
const ATD_TYPE_ORDER = ['BATD', 'AATD'];
const atdPinned = d => /\bFMX\b/i.test(d.name) && /\bMCX\b/i.test(d.name);
const atdTypeRank = d => { const i = ATD_TYPE_ORDER.indexOf(String(d.type || '').toUpperCase()); return i < 0 ? ATD_TYPE_ORDER.length : i; };
function atdOrdered(list){
  return [...(list || atd.devices)].sort((a, b) => (atdTypeRank(a) - atdTypeRank(b)) || (atdPinned(b) - atdPinned(a)) || textCmp(a.name, b.name));
}
function atdGroups(list){
  const out = [];
  atdOrdered(list).forEach(d => {
    const type = String(d.type || '').toUpperCase() || 'Other';
    if(!out.length || out[out.length - 1].type !== type) out.push({type, devices: []});
    out[out.length - 1].devices.push(d);
  });
  return out;
}

// ---- Knowledge base comparison (scripts/check_kb.py) ----
function kbOf(id){ return kbStatus && kbStatus.devices && kbStatus.devices[id] || null; }
function kbChecked(){ return kbStatus && kbStatus.checkedAt ? fmtDate(String(kbStatus.checkedAt).slice(0, 10)) : ''; }
function kbBehind(){ return atdSorted(atd.devices.filter(d => (kbOf(d.id) || {}).status === 'kb-behind')); }
function sheetBehind(){ return atdSorted(atd.devices.filter(d => (kbOf(d.id) || {}).status === 'sheet-behind')); }
function kbDiffs(d, dir){ return ((kbOf(d.id) || {}).diffs || []).filter(x => !dir || x.dir === dir); }
function kbArticleUrl(d){ const k = kbOf(d.id); return (k && k.article && k.article.url) || d.kbUrl || ''; }
function kbFile(d, kind){ const k = kbOf(d.id); return k && k.files && k.files[kind] || null; }

function kbPill(d){
  const k = kbOf(d.id);
  if(!k) return `<span class="pill pill-neutral">Not yet checked</span>`;
  const map = {
    'match': ['sage', 'Matches'], 'found': ['sage', 'Found'], 'kb-behind': ['overdue', 'KB behind'],
    'sheet-behind': ['gold', 'Spreadsheet behind'], 'not-found': ['neutral', 'Not found'], 'error': ['neutral', 'Check failed']
  };
  const [cls, label] = map[k.status] || ['neutral', k.status];
  return `<span class="pill pill-${cls}">${label}</span>`;
}

function diffLine(x){ return `${escapeHtml(x.label)}: spreadsheet ${escapeHtml(x.sheet)}, knowledge base ${escapeHtml(x.kb)}`; }

// =====================================================================
// Views
// =====================================================================
function openAtd(){ navigate({type: 'atd'}); }
function openAtdDevice(id, doc, page){ navigate({type: 'atd-dev', id, doc: doc || '', page: page || 1}); }

// Sidebar: a section of its own, between Certifications and the Regulatory library.
function renderAtdSidebar(){
  if(!atdLoaded || !atd.devices.length) return '';
  const active = view.type === 'atd' || view.type === 'atd-dev';
  const behind = EDITOR ? kbBehind().length : 0;
  return `
    ${sideSectionHead('FAA ATD approvals', '')}
    <button class="side-cert side-atd ${active ? 'active' : ''}" type="button" ${active ? 'aria-current="true"' : ''} onclick="openAtd()">
      ${ICON.device}
      <span class="side-cert-name">ATD devices</span>
      ${behind ? `<span class="tab-count alert" title="Knowledge base behind the spreadsheet">${behind}</span>` : `<span class="tab-count zero">${atd.devices.length}</span>`}
    </button>`;
}

// Editor only: the knowledge base lists older documents than the spreadsheet.
function renderKbBehindNotice(){
  if(!EDITOR) return '';
  const list = kbBehind();
  if(!list.length) return '';
  const issue = kbStatus && kbStatus.issue;
  return `
    <div class="kb-alert" role="status">
      <div class="kb-alert-head">${ICON.bell}<span>Knowledge base is behind the spreadsheet on ${countLabel(list.length, 'device', 'devices')}</span></div>
      <div class="kb-alert-sub">The public KB still lists older documents. Post the new LOA and QAG to the KB articles.</div>
      ${list.map(d => `
        <div class="kb-alert-row">
          <button class="text-link" type="button" onclick="openAtdDevice('${d.id}')">${escapeHtml(d.name)}</button>
          <span>${kbDiffs(d, 'kb-behind').map(diffLine).join('<br>')}</span>
          ${kbArticleUrl(d) ? `<a href="${escapeHtml(kbArticleUrl(d))}" target="_blank" rel="noopener noreferrer">Open KB article ${ICON.external}</a>` : '<span></span>'}
        </div>`).join('')}
      <div class="kb-alert-foot">Checked ${kbChecked()}${issue && issue.url ? ` · <a href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">GitHub issue #${issue.number}</a> (emailed)` : ''} · Clears on its own once the KB is updated.</div>
    </div>`;
}

// Home page card (one of the home summary cards; see renderHome in tracker.js).
function renderAtdHome(){
  if(!atdLoaded || !atd.devices.length) return '';
  const counts = {green: 0, yellow: 0, red: 0, expired: 0, incomplete: 0};
  atd.devices.forEach(d => counts[atdBand(d)]++);
  const warn = atdSorted(atd.devices.filter(d => ['yellow', 'red', 'expired'].includes(atdBand(d))));
  const next = atdSorted(atd.devices.filter(d => !atdIncomplete(d) && !atdPending(d)))[0];
  const pending = atdOrdered(atd.devices.filter(atdPending));
  const chip = (n, label, cls) => `<span class="pill pill-${n ? cls : 'neutral'}">${n} ${label}</span>`;
  const act = d => ({type: 'atd', id: d.id});
  const rows = [
    ...warn.map(d => homeRow(ATD_BANDS[atdBand(d)].label, ATD_BANDS[atdBand(d)].cls, escapeHtml(d.name), `expires ${fmtDate(d.expiration)} \u00b7 resubmit by ${fmtDate(atdResubmitBy(d))}`, act(d))),
    ...pending.map(d => homeRow('Pending', 'slate', `${escapeHtml(d.name)} \u00b7 ${vLabel(d.submittedVersion)}${d.faaTracking ? ` <span class="row-sub">FAA #${escapeHtml(d.faaTracking)}</span>` : ''}`, d.submittedDate ? 'submitted ' + fmtDate(d.submittedDate) : 'submitted', act(d))),
    ...(next && !warn.includes(next) ? [homeRow('Next resubmit', 'neutral', escapeHtml(next.name), 'by ' + fmtDate(atdResubmitBy(next)), act(next))] : [])
  ];
  return homeCard('FAA ATD approvals', `<button class="text-link" type="button" onclick="openAtd()">Open ATD devices ${ICON.arrowRight}</button>`,
    `<div class="atd-chips home-chips">${chip(counts.green, 'green', 'sage')}${chip(counts.yellow, 'yellow', 'gold')}${chip(counts.red + counts.expired, 'red', 'overdue')}${counts.incomplete ? chip(counts.incomplete, 'incomplete', 'neutral') : ''}</div>${rows.join('')}`);
}

// The ATD devices page.
function renderAtdView(){
  if(!atdLoaded) return '<div class="muted">Loading…</div>';
  rowActions = [];
  const src = atd.source || {};
  const list = atdOrdered();
  const counts = {};
  list.forEach(d => { const b = atdBand(d); counts[b] = (counts[b] || 0) + 1; });
  const meta = [src.file ? escapeHtml(src.file) : '', src.asOf ? 'as of ' + fmtDate(src.asOf) : '', src.importedAt ? 'imported ' + fmtDate(src.importedAt) : '']
    .filter(Boolean).join(' · ');
  const sb = EDITOR ? sheetBehind() : [];
  const notFound = EDITOR ? list.filter(d => (kbOf(d.id) || {}).status === 'not-found') : [];
  const body = list.length ? `
    <div class="atd-table" role="table" aria-label="ATD devices">
      <div class="atd-tr atd-th" role="row"><span role="columnheader">Device</span><span role="columnheader">Approved QAG</span><span role="columnheader">Expires</span><span role="columnheader">Resubmit by</span><span role="columnheader">Status</span><span role="columnheader">${EDITOR ? 'Knowledge base' : 'Documents'}</span></div>
      ${atdGroups(list).map(g => `<div class="atd-group" role="row"><span role="cell">${escapeHtml(g.type)} <span class="title-count">(${g.devices.length})</span></span></div>` + g.devices.map(d => {
        rowActions.push({type: 'atd', id: d.id});
        const days = atdDays(d);
        const files = ['loa', 'qag'].filter(k => kbFile(d, k)).map(k => k.toUpperCase()).join(', ');
        return `
        <button class="atd-tr" type="button" role="row" onclick="openRow(${rowActions.length - 1})">
          <span role="cell"><b>${escapeHtml(d.name)}</b></span>
          <span role="cell">${vLabel(d.version)}${atdPending(d) ? `<span class="row-sub atd-sub">${submittedText(d)}</span>` : ''}</span>
          <span role="cell">${atdIncomplete(d) ? `<span class="row-sub">${escapeHtml(d.expirationText || 'TBA')}</span>` : `${fmtDate(d.expiration)}<span class="row-sub atd-sub">${days < 0 ? `Expired ${(-days).toLocaleString()} days ago` : `${days.toLocaleString()} ${days === 1 ? 'day' : 'days'}`}</span>`}</span>
          <span role="cell">${atdIncomplete(d) ? '<span class="row-sub">—</span>' : fmtDate(atdResubmitBy(d))}</span>
          <span role="cell">${bandPill(d)}${atdPending(d) ? '<span class="pill pill-slate">Pending</span>' : ''}</span>
          <span role="cell">${EDITOR ? `${kbPill(d)}${kbDiffs(d).length ? `<span class="row-sub atd-sub">${kbDiffs(d).map(x => `KB: ${escapeHtml(x.kb)}`).join(', ')}</span>` : ''}` : (files ? escapeHtml(files) : '<span class="row-sub">—</span>')}</span>
        </button>`;
      }).join('')).join('')}
    </div>` : `<div class="muted list-empty">${EDITOR ? 'No devices yet. Import FAA_Approval_Tracker.xlsx to start.' : 'No devices yet.'}</div>`;
  return `
    <div class="detail-context">FAA ATD approvals</div>
    <div class="detail-head">
      <div>
        <h2 class="detail-title">ATD devices <span class="title-count">(${list.length})</span></h2>
        <div class="doc-meta">${meta ? 'Spreadsheet: ' + meta : 'No spreadsheet imported yet'}${kbChecked() ? ` · Knowledge base checked ${kbChecked()}` : ''}</div>
      </div>
    </div>
    ${EDITOR ? `<div class="detail-actions doc-actions">${actionBtn('upload', 'Import spreadsheet', 'openAtdImport()', {compact: false})}</div>` : ''}
    ${renderKbBehindNotice()}
    ${sb.length ? `<div class="reg-note update"><strong>Spreadsheet behind the knowledge base on ${countLabel(sb.length, 'device', 'devices')}:</strong> ${sb.map(d => `${escapeHtml(d.name)} (${kbDiffs(d, 'sheet-behind').map(x => `${escapeHtml(x.label)} ${escapeHtml(x.kb)} on the KB`).join(', ')})`).join('; ')}. Update FAA_Approval_Tracker.xlsx and import it again.</div>` : ''}
    ${notFound.length ? `<div class="reg-note muted-note">Not found in the knowledge base: ${notFound.map(d => escapeHtml(d.name)).join(', ')}. Open a device and use Edit to add its article link.</div>` : ''}
    <div class="atd-chips">${['green', 'yellow', 'red', 'expired', 'incomplete'].filter(b => counts[b]).map(b => `<span class="pill pill-${ATD_BANDS[b].cls}" title="${ATD_BANDS[b].hint}">${counts[b]} ${ATD_BANDS[b].label.toLowerCase()}</span>`).join('')}${list.filter(atdPending).length ? `<span class="pill pill-slate">${list.filter(atdPending).length} pending</span>` : ''}</div>
    ${body}
    <div class="muted search-note">BATD first, then AATD; FMX/MCX at the top of AATD, the rest alphabetical. Green: over 365 days to expiry; yellow: 180 to 365; red: under 180. Resubmit by is 180 days before expiry.</div>`;
}

// One device: approval details, then its LOA and QAG from the knowledge base in the main panel.
const atdPdfUrls = {};
const atdPdfFailed = {};
const atdPdfLoading = {};

function renderAtdDevice(){
  const d = atdDevice(view.id);
  if(!d) return atdLoaded ? renderAtdView() : '<div class="muted">Loading…</div>';
  const k = kbOf(d.id) || {};
  const kinds = ['loa', 'qag'].filter(x => kbFile(d, x));
  const doc = kinds.includes(view.doc) ? view.doc : kinds[0] || '';
  const file = doc ? kbFile(d, doc) : null;
  const pg = view.page > 1 ? '#page=' + view.page : '';
  const url = file && atdPdfUrls[file.path] ? atdPdfUrls[file.path] + pg : '';
  const days = atdDays(d);
  const field = (label, value) => `<div><div class="fk">${label}</div><div class="fv">${value}</div></div>`;
  const linked = (d.certIds || []).map(id => certs.find(c => c.id === id)).filter(Boolean);
  const article = kbArticleUrl(d);
  const kbVer = k.kb && k.kb.qagVersion;
  let kbNote = '';
  if(EDITOR){
    const when = kbChecked() ? ` <span class="reg-note-when">Checked ${kbChecked()}</span>` : '';
    if(k.status === 'kb-behind') kbNote = `<div class="reg-note kb-behind"><strong>Knowledge base behind the spreadsheet.</strong> ${kbDiffs(d, 'kb-behind').map(diffLine).join('; ')}. Post the new documents to the KB article.${when}</div>`;
    else if(k.status === 'sheet-behind') kbNote = `<div class="reg-note update"><strong>Spreadsheet behind the knowledge base.</strong> ${kbDiffs(d).map(diffLine).join('; ')}. Update FAA_Approval_Tracker.xlsx and import it again.${when}</div>`;
    else if(k.status === 'match') kbNote = `<div class="reg-note current">Knowledge base matches the spreadsheet${kbVer ? ` (QAG ${vLabel(kbVer)}${k.kb.loaDate ? ', LOA ' + fmtDate(k.kb.loaDate) : ''})` : ''}.${when}</div>`;
    else if(k.status === 'not-found') kbNote = `<div class="reg-note muted-note">No QAG/LOA article was found for this device in the knowledge base. Use Edit to add its article link.${when}</div>`;
    else if(k.status === 'error') kbNote = `<div class="reg-note error">The weekly check couldn't read this device's article${k.note ? `: ${escapeHtml(k.note)}` : ''}. It will try again next week.${when}</div>`;
    else if(!k.status) kbNote = `<div class="reg-note muted-note">The weekly knowledge base check hasn't run for this device yet. Run it from the Actions tab in tracker-data, or wait for Monday's run.</div>`;
    if(k.problems && k.problems.length) kbNote += `<div class="reg-note error">${k.problems.map(escapeHtml).join('<br>')}</div>`;
  }
  const back = navFrom ? backLinkHtml() : `<button class="back-link" type="button" onclick="openAtd()">${ICON.arrowLeft}<span>ATD devices</span></button>`;
  return `
    ${back}
    <div class="detail-context">FAA ATD approvals / ATD devices</div>
    <div class="detail-head">
      <div>
        <h2 class="detail-title">${escapeHtml(d.name)} <span class="title-count">${escapeHtml(d.type || '')}</span></h2>
      </div>
      <span>${bandPill(d)}${atdPending(d) ? '<span class="pill pill-slate">Pending</span>' : ''}</span>
    </div>
    ${EDITOR ? `<div class="detail-actions">${actionBtn('edit', 'Edit', `openAtdDeviceModal('${d.id}')`)}</div>` : ''}
    <div class="field-grid">
      ${field('Approved QAG', vLabel(d.version))}
      ${field('Current approval (LOA)', fmtDate(d.currentApproval))}
      ${field('Expires', atdIncomplete(d) ? escapeHtml(d.expirationText || 'TBA') : `${fmtDate(d.expiration)} <span class="row-sub">(${days < 0 ? 'expired' : days.toLocaleString() + ' days'})</span>`)}
      ${field('Resubmit by', atdIncomplete(d) ? '—' : fmtDate(atdResubmitBy(d)))}
      ${field('Original approval', d.originalApproval ? fmtDate(d.originalApproval) : escapeHtml(d.originalApprovalText || '—'))}
      ${field('Submitted', d.submittedVersion ? `${vLabel(d.submittedVersion)}${d.submittedDate ? ', ' + fmtDate(d.submittedDate) : ''}${atdPending(d) ? '' : ' (approved)'}` : '—')}
      ${field('FAA tracking #', d.faaTracking ? escapeHtml(d.faaTracking) : '—')}
      ${d.notes ? `<div class="span-all"><div class="fk">Notes</div><div class="fv">${escapeHtml(d.notes)}</div></div>` : ''}
      <div class="span-all"><div class="fk">Linked certification projects</div><div class="fv">${linked.length ? linked.map(c => `<button class="text-link" type="button" onclick="selectCert('${c.id}')">${escapeHtml(certName(c))}</button>`).join(', ') : 'None'}</div></div>
    </div>
    ${kbNote}
    <div class="atd-docs">
      ${kinds.length ? `<div class="tabs" role="tablist">${kinds.map(x => `<button class="tab ${x === doc ? 'on' : ''}" role="tab" aria-selected="${x === doc}" type="button" onclick="openAtdDevice('${d.id}', '${x}')">${ICON.file} ${x.toUpperCase()}${x === 'qag' && kbVer ? ' ' + vLabel(kbVer) : ''}${x === 'loa' && k.kb && k.kb.loaDate ? ' ' + fmtDate(k.kb.loaDate) : ''}</button>`).join('')}</div>` : ''}
      <div class="detail-actions doc-actions">
        ${file ? `<a class="btn-text atd-open-link ${url ? '' : 'disabled'}" href="${url || '#'}" ${url ? '' : 'aria-disabled="true"'} target="_blank" rel="noopener">${ICON.external}<span>Open in new tab</span></a>` : ''}
        ${article ? `<a class="btn-text" href="${escapeHtml(article)}" target="_blank" rel="noopener noreferrer">${ICON.globe}<span>Open in knowledge base</span></a>` : ''}
      </div>
      ${file ? `
        ${url ? '' : `<div class="reg-loading" id="atd-loading">Loading the document&hellip;</div>`}
        ${isPhone()
          ? `<a class="btn-primary open-doc-btn atd-open-link ${url ? '' : 'disabled'}" href="${url || '#'}" target="_blank" rel="noopener">${ICON.file}<span>Open ${doc.toUpperCase()}</span></a>`
          : `<iframe class="pdf-frame" id="atd-frame" ${url ? `src="${url}" data-src="${url}"` : 'hidden'} title="${escapeHtml(d.name)} ${doc.toUpperCase()}"></iframe>`}
        <div class="muted search-note">Copy from the knowledge base, stored ${fmtDate(file.storedAt)}. Checked weekly.</div>`
      : `<div class="muted list-empty">${article ? 'The LOA and QAG haven’t been stored from the knowledge base yet. They appear after the next weekly check.' : 'No LOA or QAG from the knowledge base for this device.'}</div>`}
    </div>`;
}

function attachAtdPdf(){
  if(view.type !== 'atd-dev') return;
  const d = atdDevice(view.id);
  if(!d) return;
  const kinds = ['loa', 'qag'].filter(x => kbFile(d, x));
  const doc = kinds.includes(view.doc) ? view.doc : kinds[0];
  const file = doc && kbFile(d, doc);
  if(!file) return;
  const apply = () => {
    if(view.type !== 'atd-dev' || view.id !== d.id) return;
    const status = document.getElementById('atd-loading');
    if(atdPdfFailed[file.path]){
      if(status){ status.textContent = `Couldn't load ${file.path} from the data repo.`; status.classList.add('error'); }
      return;
    }
    if(!atdPdfUrls[file.path]) return;
    const url = atdPdfUrls[file.path] + (view.page > 1 ? '#page=' + view.page : '');
    const frame = document.getElementById('atd-frame');
    if(frame && frame.dataset.src !== url){ frame.src = url; frame.dataset.src = url; frame.hidden = false; }
    document.querySelectorAll('.atd-open-link').forEach(a => { a.href = url; a.classList.remove('disabled'); a.removeAttribute('aria-disabled'); });
    if(status) status.remove();
  };
  if(atdPdfUrls[file.path] || atdPdfFailed[file.path]) return apply();
  if(!atdPdfLoading[file.path]){
    atdPdfLoading[file.path] = ghRaw(file.path)
      .then(async res => { atdPdfUrls[file.path] = URL.createObjectURL(new Blob([await res.arrayBuffer()], {type: 'application/pdf'})); })
      .catch(() => { atdPdfFailed[file.path] = true; })
      .finally(() => { delete atdPdfLoading[file.path]; });
  }
  atdPdfLoading[file.path].then(apply);
}

// Certification page: the ATD devices this certification is linked to.
function renderCertAtdLinks(c){
  const devs = atd.devices.filter(d => (d.certIds || []).includes(c.id));
  if(!devs.length) return '';
  return `<div class="cert-atd-links"><div class="fk">ATD device</div><div class="fv">${devs.map(d => `<button class="text-link" type="button" onclick="openAtdDevice('${d.id}')">${escapeHtml(d.name)}</button> ${bandPill(d)}`).join(' ')}</div></div>`;
}

// Summary bar lists.
function atdLine(d){
  return `<b class="row-strong">${escapeHtml(d.name)}</b> <span class="row-sub">· ${escapeHtml(d.type || '')} · QAG ${vLabel(d.version)}</span>`;
}

function atdRowSide(d){
  if(atdIncomplete(d)) return 'Incomplete';
  if(atdPending(d)) return submittedText(d);
  return `Resubmit by ${fmtDate(atdResubmitBy(d))}`;
}

// =====================================================================
// Search: devices, and the text of their stored LOAs and QAGs
// =====================================================================
const atdIndex = {};      // file path -> lower-cased page texts
const atdIndexRaw = {};
let atdIndexLoading = null;

function atdDocsIndexed(){
  return atd.devices.flatMap(d => ['loa', 'qag'].map(kind => ({d, kind, file: kbFile(d, kind)})).filter(x => x.file && x.file.indexed));
}

function indexPathOf(file){ return file.path.replace(/^atd\//, 'atd/index/').replace(/\.pdf$/i, '.json'); }

function ensureAtdSearch(){
  if(!atdLoaded || atdIndexLoading) return;
  const docs = atdDocsIndexed().filter(x => !atdIndex[x.file.path]);
  if(!docs.length) return;
  atdIndexLoading = Promise.all(docs.map(async x => {
    try{
      const json = await (await ghRaw(indexPathOf(x.file))).json();
      const pages = Array.isArray(json.pages) ? json.pages.map(p => String(p || '')) : [];
      atdIndexRaw[x.file.path] = pages;
      atdIndex[x.file.path] = pages.map(p => p.toLowerCase());
    }catch(e){
      atdIndexRaw[x.file.path] = [];
      atdIndex[x.file.path] = [];
    }
  })).then(() => { atdIndexLoading = null; lastDetailHtml = null; render(); });
}

function atdSearchReady(){ return atdLoaded && atdDocsIndexed().every(x => atdIndex[x.file.path]); }

function searchAtd(t){
  const devices = atdOrdered(atd.devices.filter(d => [d.name, d.type, d.version, d.submittedVersion, d.faaTracking, d.notes].some(v => textHas(v, t))));
  const docs = [];
  atdDocsIndexed().forEach(x => {
    const pages = atdIndex[x.file.path];
    if(!pages) return;
    const hits = [];
    let matches = 0;
    pages.forEach((lower, i) => {
      let at = findWordStart(lower, t);
      if(at < 0) return;
      const first = at;
      let n = 0;
      while(at > -1){ n++; at = findWordStart(lower, t, at + t.length); }
      matches += n;
      hits.push({page: i + 1, n, snippet: excerpt(atdIndexRaw[x.file.path][i], first, t.length)});
    });
    if(hits.length) docs.push({...x, hits, matches});
  });
  return {devices, docs, count: devices.length + docs.reduce((n, r) => n + r.hits.length, 0)};
}

function renderAtdSearch(res, all, from, q){
  let out = '';
  const head = (count) => `<div class="result-group"><b>ATD devices <span class="title-count">(${count})</span></b>${all && count > 3 ? `<button class="side-tool" type="button" onclick="setSearchTab('atd')">Show all</button>` : ''}</div>`;
  if(!res.count) return '';
  out += head(res.count);
  out += res.devices.slice(0, all ? 3 : undefined).map(d =>
    rowButton({type: 'atd', id: d.id, from}, `<b class="row-strong">${highlight(d.name, q)}</b> <span class="row-sub">· ${escapeHtml(d.type || '')} · QAG ${highlight(vLabel(d.version), q)}${d.notes ? ' · ' + highlight(plainSnippet(d.notes, 80), q) : ''}</span>`, atdRowSide(d))).join('');
  out += res.docs.slice(0, all ? 2 : undefined).map(r => `
    <div class="reg-result">
      <div class="reg-result-head"><b>${escapeHtml(r.d.name)} ${r.kind.toUpperCase()}</b> <span class="row-sub">${countLabel(r.hits.length, 'page', 'pages')} · ${countLabel(r.matches, 'match', 'matches')}</span></div>
      ${r.hits.slice(0, all ? 1 : 5).map(h => rowButton({type: 'atd', id: r.d.id, doc: r.kind, page: h.page, from}, `<span class="page-tag">Page ${h.page}</span>${highlight(h.snippet, q)}`, h.n > 1 ? `${h.n} matches` : '')).join('')}
    </div>`).join('');
  return out;
}

// =====================================================================
// Spreadsheet import (FAA_Approval_Tracker.xlsx). Pure functions, so they can be checked outside a browser.
// rows: the first sheet as rows of raw cell values (dates as Excel serial numbers).
// =====================================================================
function excelDate(v){
  if(typeof v === 'number' && v > 20000 && v < 80000){
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if(v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
  return '';
}

function cleanVersion(v){
  if(v === null || v === undefined || v === '') return '';
  if(typeof v === 'number'){
    let s = String(Number(v.toPrecision(10)));
    if(!s.includes('.')) s += '.0';
    return s;
  }
  return String(v).trim().replace(/^v\.?\s*/i, '');
}

function cleanDeviceName(raw){
  return String(raw || '')
    .replace(/\((?:A|B)?ATD\)/ig, ' ')
    .replace(/\s+v\.?\s*\d[\w.]*\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

function deviceId(name){
  return String(name).toLowerCase().replace(/\+/g, '-plus').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
}

function parseAtdRows(rows){
  const norm = v => String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const headerAt = rows.findIndex(r => (r || []).some(c => norm(c) === 'device'));
  if(headerAt < 0) throw new Error('Couldn’t find the DEVICE header row. Is this FAA_Approval_Tracker.xlsx?');
  const header = rows[headerAt].map(norm);
  const col = test => header.findIndex(test);
  const cols = {
    device: col(h => h === 'device'),
    version: col(h => h === 'version' || h === 'approvedversion' || h === 'qagversion'),
    submitted: col(h => h.startsWith('submittedversion')),
    type: col(h => h === 'type'),
    original: col(h => h.startsWith('original')),
    current: col(h => h.startsWith('currentapproval')),
    expiration: col(h => h.startsWith('expiration')),
    resubmitted: col(h => h === 'resubmitted' || h === 'submitted' || h === 'submitteddate'),
    status: col(h => /^st\w*us$/.test(h)),
    notes: col(h => h === 'notes'),
    // FAA tracking number for a submission (e.g. 20261006-83327); the sheet's "Submission Tracker" column works too.
    tracking: col(h => h.includes('tracking') || h === 'submissiontracker' || h === 'faatrackingnumber')
  };
  if(cols.version < 0 || cols.expiration < 0) throw new Error('The sheet needs Version and EXPIRATION columns.');
  let asOf = '';
  rows.slice(0, headerAt).forEach(r => {
    if((r || []).some(c => norm(c) === 'asof')) asOf = (r.map(excelDate).find(Boolean)) || asOf;
  });
  const get = (r, k) => cols[k] < 0 ? null : r[cols[k]];
  const text = v => v === null || v === undefined ? '' : String(v).trim();
  const devices = [];
  const seen = new Set();
  rows.slice(headerAt + 1).forEach(r => {
    if(!r) return;
    const name = cleanDeviceName(get(r, 'device'));
    if(!name) return;
    let id = deviceId(name), n = 2;
    while(seen.has(id)) id = deviceId(name) + '-' + (n++);
    seen.add(id);
    const notes = text(get(r, 'notes'));
    let submittedVersion = cleanVersion(get(r, 'submitted'));
    if(!submittedVersion){
      const m = notes.match(/\bv?\.?\s*(\d+(?:\.\d+)+[a-z]?)\s+submitted/i);
      if(m) submittedVersion = m[1];
    }
    const statusText = text(get(r, 'status'));
    const origRaw = get(r, 'original');
    const expRaw = get(r, 'expiration');
    const incomplete = /incomplete/i.test(statusText) || /incomplete/i.test(text(origRaw)) || !excelDate(expRaw);
    devices.push({
      id, name,
      type: text(get(r, 'type')).toUpperCase(),
      version: cleanVersion(get(r, 'version')),
      submittedVersion,
      submittedDate: submittedVersion ? excelDate(get(r, 'resubmitted')) : '',
      originalApproval: excelDate(origRaw),
      originalApprovalText: excelDate(origRaw) ? '' : text(origRaw),
      currentApproval: excelDate(get(r, 'current')),
      expiration: excelDate(expRaw),
      expirationText: excelDate(expRaw) ? '' : text(expRaw),
      notes,
      faaTracking: /\d/.test(text(get(r, 'tracking'))) ? text(get(r, 'tracking')).replace(/^#\s*/, '') : '',
      status: incomplete ? 'Incomplete' : 'Current'
    });
  });
  if(!devices.length) throw new Error('No devices found under the DEVICE header.');
  return {asOf, devices};
}

const ATD_FIELDS = [
  ['type', 'Type'], ['version', 'Approved QAG'], ['submittedVersion', 'Submitted version'], ['submittedDate', 'Submitted'],
  ['originalApproval', 'Original approval'], ['currentApproval', 'Current approval'], ['expiration', 'Expiration'],
  ['expirationText', 'Expiration note'], ['faaTracking', 'FAA tracking #'], ['notes', 'Notes'], ['status', 'Status']
];

// What an import would change: {added, changed: [{device, fields: [[label, old, new]]}], removed, unchanged}.
function diffAtdImport(oldDevices, newDevices){
  const byId = Object.fromEntries(oldDevices.map(d => [d.id, d]));
  const out = {added: [], changed: [], removed: [], unchanged: 0};
  newDevices.forEach(d => {
    const o = byId[d.id];
    if(!o){ out.added.push(d); return; }
    const fields = ATD_FIELDS.filter(([k]) => String(o[k] || '') !== String(d[k] || '')).map(([k, label]) => [label, o[k] || '', d[k] || '']);
    if(fields.length) out.changed.push({device: d, fields});
    else out.unchanged++;
  });
  const newIds = new Set(newDevices.map(d => d.id));
  out.removed = oldDevices.filter(d => !newIds.has(d.id));
  return out;
}

// Keeps what only the tracker knows (KB link, linked certifications) across imports.
function mergeAtdImport(oldDevices, newDevices){
  const byId = Object.fromEntries(oldDevices.map(d => [d.id, d]));
  return newDevices.map(d => ({...d, kbUrl: (byId[d.id] || {}).kbUrl || '', certIds: (byId[d.id] || {}).certIds || []}));
}

if(typeof module !== 'undefined') module.exports = {parseAtdRows, diffAtdImport, mergeAtdImport, cmpVersion, cleanVersion, cleanDeviceName, deviceId, excelDate};
