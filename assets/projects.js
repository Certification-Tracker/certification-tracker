// =====================================================================
// Projects (3.2): the Projects page (authority / customer / SN / aircraft), device pages,
// project pages, and their documents, tasks and comments. Shared by both pages; loaded after tracker.js.
// =====================================================================

// ---- Projects page tree ----
// Every level starts open; what you close is remembered while the browser tab is open.
const TREE_KEY = 'cert-tracker-projects-closed';
const closedTree = new Set();
try{ JSON.parse(sessionStorage.getItem(TREE_KEY) || '[]').forEach(k => closedTree.add(k)); }catch(e){}
let treeRefs = [];   // what each tree button refers to (rebuilt on every draw)

function saveTreeState(){
  try{
    sessionStorage.setItem(TREE_KEY, JSON.stringify([...closedTree]));
    sessionStorage.setItem(LIB_OPEN_KEY, JSON.stringify([...openAuthorities]));
  }catch(e){}
}

function treeRef(obj){ treeRefs.push(obj); return treeRefs.length - 1; }

function toggleTree(i){
  const r = treeRefs[i];
  if(!r) return;
  if(closedTree.has(r.key)) closedTree.delete(r.key); else closedTree.add(r.key);
  render();
}

function treeKeys(){
  const keys = [];
  projectTree().forEach(a => {
    keys.push('a:' + a.name);
    a.customers.forEach(c => { keys.push('c:' + a.name + '|' + c.name); c.devices.forEach(d => keys.push('s:' + a.name + '|' + d.device.id)); });
  });
  return keys;
}

function toggleAllTree(){
  const keys = treeKeys();
  if(keys.some(k => !closedTree.has(k))) keys.forEach(k => closedTree.add(k));
  else closedTree.clear();
  render();
}

// [{name, projects, customers: [{name, projects, devices: [{device, projects}]}]}]
function projectTree(){
  const auths = new Map();
  projects.forEach(p => {
    const d = p.device;
    if(!d) return;
    const auth = (p.authority || '').trim() || 'No authority';
    if(!auths.has(auth)) auths.set(auth, new Map());
    const custs = auths.get(auth);
    const cust = customerKey(d);
    if(!custs.has(cust)) custs.set(cust, new Map());
    const devs = custs.get(cust);
    if(!devs.has(d.id)) devs.set(d.id, {device: d, projects: []});
    devs.get(d.id).projects.push(p);
  });
  const lastIf = name => name === 'No authority' ? 1 : 0;
  return [...auths.entries()].sort((a, b) => lastIf(a[0]) - lastIf(b[0]) || textCmp(a[0], b[0])).map(([name, custs]) => {
    const customers = [...custs.entries()].sort((a, b) => textCmp(a[0], b[0])).map(([cname, devs]) => {
      const list = [...devs.values()].sort((a, b) => textCmp(a.device.serial, b.device.serial))
        .map(x => ({device: x.device, projects: sortProjects(x.projects)}));
      return {name: cname, devices: list, projects: list.flatMap(x => x.projects)};
    });
    return {name, customers, projects: customers.flatMap(c => c.projects)};
  });
}

const openTaskCount = list => list.filter(a => taskGroupOf(a) !== 'Complete');

function openCountHtml(tasks){
  const open = openTaskCount(tasks);
  if(!open.length) return '';
  const late = open.some(isTaskOverdue);
  return `<span class="pt-open${late ? ' late' : ''}" title="${countLabel(open.length, 'open task', 'open tasks')}${late ? ', overdue' : ''}">${open.length} open</span>`;
}

function renderProjectsView(){
  treeRefs = [];
  const tree = projectTree();
  const keys = treeKeys();
  const anyOpen = keys.some(k => !closedTree.has(k));
  const customers = new Set(devices.map(customerKey)).size;
  const chevron = open => `<span class="pt-chev${open ? ' open' : ''}" aria-hidden="true">${ICON.chevron}</span>`;
  const body = tree.map(a => {
    const aKey = 'a:' + a.name, aOpen = !closedTree.has(aKey);
    const custs = a.customers.map(c => {
      const cKey = 'c:' + a.name + '|' + c.name, cOpen = !closedTree.has(cKey);
      const openN = c.projects.filter(p => !p.completed).length;
      const devs = c.devices.map(({device: d, projects: list}) => {
        const sKey = 's:' + a.name + '|' + d.id, sOpen = !closedTree.has(sKey);
        // Each aircraft counts its own copy of a shared device task (3.2.2).
        const tasks = list.flatMap(projectTasks);
        const loc = EDITOR ? d.simLocation : publicLocation(d.simLocation);
        const rows = list.map(p => {
          const st = projectStatus(p);
          return `
            <button class="pt-proj" type="button" onclick="openProject('${p.id}')">
              <span class="status-dot dot-${st.cls}" title="${st.label}"></span>
              <span class="pt-proj-name">${escapeHtml(p.aircraft || projectName(p))}${p.level ? ` <span class="row-sub">· ${escapeHtml(p.level)}</span>` : ''}${p.completed ? ' <span class="done-tag">Completed</span>' : ''}</span>
              <span class="pt-proj-side">${p.completed ? 'Completed ' + fmtDate(p.dateCompleted) : (p.date ? dueText(p.date, '', isProjectLate(p)) : '<span class="row-sub">No due date</span>')}</span>
            </button>`;
        }).join('');
        const sRef = treeRef({key: sKey});
        return `
          <div class="pt-dev">
            <div class="pt-sn-row">
              <button class="pt-toggle" type="button" aria-expanded="${sOpen}" aria-label="${sOpen ? 'Hide' : 'Show'} aircraft" onclick="toggleTree(${sRef})">${chevron(sOpen)}</button>
              <button class="pt-sn" type="button" onclick="openDeviceOrProject('${d.id}')" title="${multiProject(d.id) ? 'Open the device page' : 'Open the project'}">SN: ${escapeHtml(d.serial || '—')}<span class="row-sub">${simModel(d) ? ' · ' + escapeHtml(simModel(d)) : ''}${loc ? ' · ' + escapeHtml(loc) : ''}${multiProject(d.id) ? ' · ' + countLabel(projectsOf(d.id).length, 'aircraft', 'aircraft') : ''}</span></button>
              ${openCountHtml(tasks)}
              ${EDITOR ? `<button class="side-tool" type="button" onclick="openProjectModal(null, '${d.id}', ${treeRef({authority: a.name})})">+ Add aircraft</button>` : ''}
            </div>
            ${sOpen ? `<div class="pt-projs">${rows}</div>` : ''}
          </div>`;
      }).join('');
      const cRef = treeRef({key: cKey});
      return `
        <div class="pt-cust-group">
          <div class="pt-cust-row">
            <button class="pt-cust" type="button" aria-expanded="${cOpen}" onclick="toggleTree(${cRef})">${chevron(cOpen)}<span class="pt-cust-name">${escapeHtml(c.name)}</span><span class="tab-count${openN ? '' : ' zero'}" title="${openN} open of ${countLabel(c.projects.length, 'project', 'projects')}"><b>${openN}</b>/${c.projects.length}</span></button>
            ${EDITOR ? `<button class="side-tool" type="button" onclick="openDeviceModal(null, ${treeRef({customer: c.name, authority: a.name})})">+ Add device</button>` : ''}
          </div>
          ${cOpen ? `<div class="pt-devs">${devs}</div>` : ''}
        </div>`;
    }).join('');
    const aRef = treeRef({key: aKey});
    const late = a.projects.filter(projectHasOverdue).length;
    return `
      <div class="pt-auth-group">
        <button class="pt-auth" type="button" aria-expanded="${aOpen}" onclick="toggleTree(${aRef})">${chevron(aOpen)}<span class="pt-auth-name">${escapeHtml(a.name)}</span><span class="row-sub">${countLabel(a.projects.length, 'project', 'projects')} · ${a.projects.filter(p => !p.completed).length} open${late ? ` · <span class="c-rust">${late} overdue</span>` : ''}</span></button>
        ${aOpen ? `<div class="pt-custs">${custs}</div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="detail-head">
      <div>
        <h2 class="detail-title">Projects <span class="title-count">(${projects.filter(p => !p.completed).length} open)</span></h2>
        <div class="doc-meta">${countLabel(projects.length, 'project', 'projects')} in all, ${projects.filter(p => p.completed).length} completed · ${countLabel(customers, 'customer', 'customers')} · ${countLabel(devices.length, 'device', 'devices')} · by regulatory authority</div>
      </div>
    </div>
    <div class="detail-actions doc-actions">
      ${tree.length ? `<button class="act-toggle-all" type="button" onclick="toggleAllTree()">${anyOpen ? ICON.collapseAll : ICON.expandAll}<span>${anyOpen ? 'Collapse all' : 'Expand all'}</span></button>` : ''}
      ${projects.length ? actionBtn('download', 'Export CSV', 'exportProjectsCsv()', {compact: false}) : ''}
      ${EDITOR ? actionBtn('plus', 'Add customer', 'openDeviceModal()', {compact: false}) : ''}
    </div>
    <div class="pt">${body || `<div class="muted list-empty">No projects yet.${EDITOR ? ' Use Add customer to start one.' : ''}</div>`}</div>
    <div class="muted search-note">Customer counts are open / total projects; "open" on an SN counts its open tasks. A device with more than one aircraft opens its device page.</div>`;
}

// ---- Device and project boxes ----
const fieldHtml = (label, value) => `<div><div class="fk">${label}</div><div class="fv">${value}</div></div>`;

function deviceFields(d){
  return `
      ${fieldHtml('Customer', escapeHtml(customerKey(d)))}
      ${fieldHtml('SIM serial number', escapeHtml(d.serial || '—'))}
      ${fieldHtml('SIM model', escapeHtml(simModel(d) || '—'))}
      ${fieldHtml('SIM location', escapeHtml((EDITOR ? d.simLocation : publicLocation(d.simLocation)) || '—'))}
      ${fieldHtml('Contact name', escapeHtml(d.contactName || '—'))}
      ${EDITOR ? fieldHtml('Contact email', d.contactEmail ? `<a href="mailto:${escapeHtml(d.contactEmail)}">${escapeHtml(d.contactEmail)}</a>` : '—') : ''}`;
}

function deviceBox(d, fromProject){
  const others = fromProject ? projectsOf(d.id).filter(p => p !== fromProject) : [];
  return `
    <section class="scope-box dev" aria-label="Device">
      <div class="scope-box-head"><span class="scope-label">Device</span>${EDITOR ? actionBtn('edit', 'Edit device', `openDeviceModal('${d.id}')`) : ''}</div>
      <div class="field-grid">${deviceFields(d)}</div>
      ${others.length ? `<div class="scope-also">Also on this device: ${others.map(p => `<button class="text-link" type="button" onclick="openProject('${p.id}')">${escapeHtml(projectName(p))}</button>`).join(', ')} · <button class="text-link" type="button" onclick="openDevice('${d.id}')">Device page</button></div>` : ''}
    </section>`;
}

function projectBox(p){
  return `
    <section class="scope-box proj" aria-label="Project">
      <div class="scope-box-head"><span class="scope-label">Project</span>${EDITOR ? actionBtn('edit', 'Edit project', `openProjectModal('${p.id}')`) : ''}</div>
      <div class="field-grid">
        ${fieldHtml('Regulatory authority', escapeHtml(p.authority || '—'))}
        ${fieldHtml('Certifying country', escapeHtml(p.country || '—'))}
        ${fieldHtml('Certification level', escapeHtml(p.level || '—'))}
        ${fieldHtml('Aircraft type', escapeHtml(p.aircraft || '—'))}
        ${fieldHtml('Regulation', regulationHtml(p))}
        <div><div class="fk">Due date</div><div class="fv ${isProjectLate(p) ? 'due-cell overdue' : ''}">${fmtDate(p.date)}${isProjectLate(p) ? ' <span class="pill pill-overdue">Overdue</span>' : ''}</div></div>
      </div>
    </section>`;
}

// ---- Device page (devices with more than one aircraft) ----
function renderDeviceView(d){
  if(!d) return renderProjectsView();
  const list = sortProjects(projectsOf(d.id));
  const rows = list.map(p => {
    const st = projectStatus(p);
    const open = openTaskCount(projectTasks(p)).length;
    return rowButton({type: 'project', id: p.id}, `<span class="status-dot dot-${st.cls} inline-dot"></span><b class="row-strong">${escapeHtml(projectName(p))}</b> <span class="row-sub">· ${escapeHtml([p.authority, p.level].filter(Boolean).join(' ') || 'No authority')}</span>`,
      `${projectStatusHtml(p, true)}${open ? countLabel(open, 'open task', 'open tasks') + ' · ' : ''}${p.completed ? 'Completed ' + fmtDate(p.dateCompleted) : (p.date ? 'Due ' + fmtDate(p.date) : 'No due date')}`);
  }).join('');
  return `
    ${navFrom ? '' : backBtn('Projects', 'openProjects()')}
    <div class="detail-context">Projects / ${escapeHtml(customerKey(d))}</div>
    <div class="detail-head">
      <div>
        <h2 class="detail-title">SN ${escapeHtml(d.serial || '—')}${simModel(d) ? ` <span class="title-count">${escapeHtml(simModel(d))}</span>` : ''}</h2>
        <div class="doc-meta">${escapeHtml(customerKey(d))} · ${countLabel(list.length, 'aircraft project', 'aircraft projects')}</div>
      </div>
    </div>
    ${EDITOR ? `<div class="detail-actions">${actionBtn('plus', 'Add aircraft', `openProjectModal(null, '${d.id}')`, {compact: false})}</div>` : ''}
    ${deviceBox(d)}
    <div class="changelog">
      <div class="section-head"><span>Aircraft Projects</span></div>
      <div class="row-list dev-projects">${rows || '<div class="muted list-empty">No projects on this device.</div>'}</div>
    </div>
    ${renderDocumentsSection(d)}
    ${renderTasksSection(d)}`;
}

// ---- Project page ----
function renderProjectView(p){
  if(!p) return renderProjectsView();
  const d = p.device;
  const snLink = d ? (multiProject(d.id)
    ? `<button class="text-link" type="button" onclick="openDevice('${d.id}')">SN ${escapeHtml(d.serial || '—')}</button>`
    : 'SN ' + escapeHtml(d.serial || '—')) : '';
  return `
    ${navFrom ? '' : backBtn('Projects', 'openProjects()')}
    <div class="detail-context">Projects / ${escapeHtml(p.authority || 'No authority')} / ${escapeHtml(customerKey(p))}${snLink ? ' / ' + snLink : ''}</div>
    <div class="detail-head">
      <div>
        <h2 class="detail-title">${escapeHtml(projectName(p))}</h2>
        ${p.completed ? `<div class="detail-completed">Completed ${fmtDate(p.dateCompleted)}</div>` : ''}
      </div>
      <span class="detail-status">${projectStatusHtml(p, true)}</span>
    </div>
    ${EDITOR ? `
    <div class="detail-actions">
      ${actionBtn('reopen', 'Set status', `openProjectStatusModal('${p.id}')`, {compact: false})}
      ${p.completed ? actionBtn('reopen', 'Reopen', `openProjectStatusModal('${p.id}', 'auto')`) : actionBtn('check', 'Mark complete', `openProjectStatusModal('${p.id}', 'Completed')`, {cls: 'ok'})}
      ${actionBtn('trash', 'Delete', `removeProject('${p.id}')`, {cls: 'danger'})}
    </div>` : ''}
    ${renderStatusHistory(p)}
    <div class="scope-boxes">${d ? deviceBox(d, p) : ''}${projectBox(p)}</div>
    ${renderProjectAtdLinks(p)}
    ${renderQualification(p)}
    ${renderDocumentsSection(p)}
    ${renderTasksSection(p)}`;
}

// Project status history (3.2.3): every status set by hand, completion and reopening, with its reason.
const openStatusHistory = new Set();
function toggleStatusHistory(id){ if(openStatusHistory.has(id)) openStatusHistory.delete(id); else openStatusHistory.add(id); render(); }

function renderStatusHistory(p){
  const log = arr(p.statusLog);
  const st = projectStatus(p);
  const note = st.set ? `<span class="status-note">Status set by hand${st.reason ? ': ' + escapeHtml(st.reason) : ''}. Tasks would show ${escapeHtml(autoProjectStatus(p).label)}.</span>` : '';
  if(!log.length && !note) return '';
  const open = openStatusHistory.has(p.id);
  const label = s => s === 'auto' ? '<span class="pill pill-neutral">Automatic</span>' : `<span class="pill pill-${s === 'Completed' ? 'sage' : PROJECT_STATUS_CLS[s] || 'slate'}">${escapeHtml(s)}</span>`;
  return `
    <div class="status-history">
      ${note}
      ${log.length ? `<button class="comments-toggle" type="button" aria-expanded="${open}" onclick="toggleStatusHistory('${p.id}')">${ICON.chevron}<span>Status history (${log.length})</span></button>` : ''}
      ${open ? `<div class="act-list">${[...log].reverse().map(e => `
        <div class="act-item act-log">
          <span class="act-when">${fmtDate(e.date)}${e.time ? ', ' + escapeHtml(e.time) : ''}</span>
          <div class="act-body"><div>${label(e.from)}<span class="act-arrow">→</span>${label(e.to)}</div>${e.reason ? `<div class="act-why rich-text">${formatText(e.reason)}</div>` : ''}</div>
          <span></span>
        </div>`).join('')}</div>` : ''}
    </div>`;
}

function dueNote(iso){
  const n = daysUntil(iso);
  if(n === null) return '';
  if(n < 0) return ` <span class="pill pill-overdue">${countLabel(-n, 'day', 'days')} ago</span>`;
  if(n <= 90) return ` <span class="pill pill-gold">in ${countLabel(n, 'day', 'days')}</span>`;
  return '';
}

function renderQualification(p){
  const q = qual(p);
  if(!hasQualification(p) && !EDITOR) return '';
  return `
    <div class="changelog qual-section">
      <div class="section-head"><span>Qualification ${q.status ? `<span class="pill pill-${qualStatusCls(q.status)}">${escapeHtml(q.status)}</span>` : ''}</span>${EDITOR ? actionBtn('edit', 'Edit', `openProjectModal('${p.id}', '', null, 'qual')`, {compact: false}) : ''}</div>
      ${hasQualification(p) ? `
      <div class="field-grid">
        ${fieldHtml('Certificate / LOA number', escapeHtml(q.certificateNumber || '—'))}
        ${fieldHtml('Issued', fmtDate(q.issueDate))}
        ${fieldHtml('Expires', fmtDate(q.expiryDate) + dueNote(q.expiryDate))}
        ${fieldHtml('Next evaluation', fmtDate(q.nextEvaluation) + dueNote(q.nextEvaluation))}
        ${q.conditions ? `<div class="span-all"><div class="fk">Conditions</div><div class="fv qual-conditions">${escapeHtml(q.conditions).replace(/\n/g, '<br>')}</div></div>` : ''}
      </div>`
      : `<div class="muted qual-empty">No qualification details yet. Use Edit to add the status, certificate number and dates once the authority issues them.</div>`}
    </div>`;
}

// ---- Documents ----
function renderDocumentsSection(ctx){
  const items = scopedList(ctx, 'docs');
  const d = deviceOf(ctx);
  const isProj = !isDevice(ctx);
  const tools = EDITOR ? `<span class="section-tools">${isProj ? actionBtn('copy', 'From template', `openFromTemplate('${ctx.id}')`, {compact: false}) : ''}${actionBtn('plus', 'Add', `openDocumentModal('${ctx.id}')`, {compact: false})}</span>` : '';
  return `
    <div class="changelog">
      <div class="section-head"><span>Documents</span>${tools}</div>
      ${items.length ? items.map(({item: doc, owner}) => {
        const actions = previewBtn(ctx, doc) + viewBtn(doc) + (EDITOR
          ? actionBtn('edit', 'Edit', `openDocumentModal('${ctx.id}', '${owner.id}', '${doc.id}')`) + actionBtn('trash', 'Delete', `deleteDocument('${owner.id}', '${doc.id}')`, {cls: 'danger'})
          : '');
        return `
        <div class="entry">
          <div class="entry-top">
            <span class="entry-text">${scopeTag(owner, ctx)}${escapeHtml(doc.name || '')}${doc.template && libraryTemplate(doc.template) ? ` <span class="row-sub">· from template</span>` : ''}</span>
            ${actions ? `<div class="cert-actions">${actions}</div>` : ''}
          </div>
        </div>`;
      }).join('') : '<div class="entry-empty">No documents yet</div>'}
      ${d && d.docLocation ? `<div class="doc-loc-line"><span class="fk">Document location</span>${renderDocLocation(d.docLocation)}</div>` : ''}
      ${renderDocHistory(ctx)}
    </div>`;
}

function renderDocLocation(loc){
  const s = String(loc || '').trim();
  if(!s) return '';
  return /^https?:\/\//i.test(s)
    ? `<div class="doc-loc"><a href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s)}</a></div>`
    : `<div class="doc-loc">${escapeHtml(s)}</div>`;
}

// "View": opens a document's link in a new tab (only for documents that have a link).
function viewBtn(doc){
  if(!doc.url) return '';
  return `<a class="btn-text compact" href="${escapeHtml(doc.url)}" target="_blank" rel="noopener noreferrer" title="View" aria-label="View">${ICON.eye}<span class="btn-label">View</span></a>`;
}

// ---- Google Drive preview ----
// A Drive or Google Docs share link -> its embeddable preview address ('' if it isn't one).
function drivePreviewUrl(url){
  const u = String(url || '');
  let m = u.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
  if(m) return `https://docs.google.com/${m[1]}/d/${m[2]}/preview`;
  m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/);
  return m ? `https://drive.google.com/file/d/${m[1]}/preview` : '';
}

function findScopedDoc(ctxId, docId){
  const ctx = ownerById(ctxId);
  const hit = ctx ? scopedList(ctx, 'docs').find(x => x.item.id === docId) : null;
  return hit ? hit.item : null;
}

function previewBtn(ctx, doc){
  if(!doc.id || !drivePreviewUrl(doc.url)) return '';
  return `<button class="btn-text compact" type="button" title="Preview" aria-label="Preview" onclick="openDrivePreview('${ctx.id}', '${doc.id}')">${ICON.file}<span class="btn-label">Preview</span></button>`;
}

function openDrivePreview(ctxId, docId){ navigate({type: 'doc', ctx: ctxId, doc: docId}); }

function ctxLabel(ctx){
  return isDevice(ctx) ? `${customerKey(ctx)} / SN ${ctx.serial || '—'}` : `${customerKey(ctx)} / ${projectName(ctx)}`;
}

function renderDrivePreview(){
  const ctx = ownerById(view.ctx);
  const d = findScopedDoc(view.ctx, view.doc);
  if(!ctx || !d) return renderProjectsView();
  const back = isDevice(ctx) ? `openDevice('${ctx.id}')` : `openProject('${ctx.id}')`;
  return `
    ${backBtn('Back to ' + escapeHtml(ctxLabel(ctx)), back)}
    <div class="detail-context">${escapeHtml(ctxLabel(ctx))} / Documents</div>
    <div class="detail-head"><div><h2 class="detail-title">${escapeHtml(d.name || 'Document')}</h2></div></div>
    <div class="detail-actions doc-actions">
      <a class="btn-text" href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${ICON.external}<span>Open in Drive</span></a>
    </div>
    ${isPhone()
      ? `<a class="btn-primary open-doc-btn" href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${ICON.file}<span>Open document</span></a>`
      : `<iframe class="pdf-frame" src="${escapeHtml(drivePreviewUrl(d.url))}" title="${escapeHtml(d.name || 'Document preview')}" allow="autoplay"></iframe>
         <p class="drive-access-note">Can't see the document? You need access to this file in Google Drive. Sign in with an account that has access, or ask the file's owner to share it.</p>`}`;
}

// Document history (3.1): recorded automatically when documents change; shown collapsed under Documents.
const openDocHistory = new Set();

function toggleDocHistory(id){
  if(openDocHistory.has(id)) openDocHistory.delete(id); else openDocHistory.add(id);
  render();
}

function renderDocHistory(ctx){
  const entries = scopedList(ctx, 'docChangeLog');
  if(!entries.length && !EDITOR) return '';
  const open = openDocHistory.has(ctx.id);
  const sorted = [...entries].sort((a, b) => (b.item.date || '').localeCompare(a.item.date || '') || (b.item.ts || 0) - (a.item.ts || 0));
  return `
    <div class="doc-history">
      <button class="comments-toggle" type="button" aria-expanded="${open}" onclick="toggleDocHistory('${ctx.id}')">${ICON.chevron}<span>History (${entries.length})</span></button>
      ${open ? `<div class="doc-history-body">
      ${EDITOR ? `<button class="side-tool doc-history-add" type="button" onclick="openChangeLogModal('${ctx.id}')">+ Add entry</button>` : ''}
      ${sorted.length ? sorted.map(({item: e, owner}) => `
        <div class="history-entry">
          <div class="history-main">
            <span class="history-date">${fmtDate(e.date)}${e.time ? ', ' + escapeHtml(e.time) : ''}</span>
            <span class="entry-text">${scopeTag(owner, ctx)}${escapeHtml(e.text)}</span>
          </div>
          ${EDITOR ? `<div class="cert-actions">
            ${actionBtn('edit', 'Edit', `openChangeLogModal('${ctx.id}', '${owner.id}', '${e.id}')`)}
            ${actionBtn('trash', 'Delete', `deleteChangeLogEntry('${owner.id}', '${e.id}')`, {cls: 'danger'})}
          </div>` : ''}
        </div>`).join('') : '<div class="entry-empty">No entries yet</div>'}
      </div>` : ''}
    </div>`;
}

// ---- Tasks (3.2.1) ----
// One frame per status (Not Started, In Progress, Waiting, Completed), open unless folded. Each task is a row
// (reference, title, due or status, comment count, Complete/Reopen); clicking it opens the details and its
// Activity: status changes with their reasons and comments, oldest first.
// Rows sort by reference in natural order (6.1.C.9 before 6.1.C.10); tasks without one follow by due date, then entered.
const taskEnteredKey = a => (a.dateCreated || '') + to24(a.timeCreated);
function taskSortCmp(x, y){
  const a = x.item, b = y.item;
  return (a.ref ? 0 : 1) - (b.ref ? 0 : 1) || (a.ref && b.ref ? textCmp(a.ref, b.ref) : 0)
    || dateCmp(a.dateDue, b.dateDue) || taskEnteredKey(a).localeCompare(taskEnteredKey(b));
}

function taskGroups(ctx){
  const entries = scopedList(ctx, 'tasks');
  return TASK_GROUPS.map(status => ({status, items: entries.filter(x => taskGroupOf(x.item) === status).sort(taskSortCmp)}))
    .filter(g => g.items.length);
}

const statusPill = s => `<span class="pill pill-${taskStatusClass(s)}">${s === 'Complete' ? 'Completed' : escapeHtml(s)}</span>`;

function tasksAnyOpen(ctx){
  return taskGroups(ctx).some(g => !closedTaskGroups.has(taskGroupKey(ctx.id, g.status)))
    || scopedList(ctx, 'tasks').some(x => openTasks.has(x.item.id));
}

function toggleTaskGroup(ctxId, status){
  const key = taskGroupKey(ctxId, status);
  if(closedTaskGroups.has(key)) closedTaskGroups.delete(key); else closedTaskGroups.add(key);
  render();
}

// Collapse all folds every group and closes every task on the page; Expand all opens the groups.
function toggleAllTasks(ctxId){
  const ctx = ownerById(ctxId);
  if(!ctx) return;
  if(tasksAnyOpen(ctx)){
    TASK_GROUPS.forEach(s => closedTaskGroups.add(taskGroupKey(ctxId, s)));
    scopedList(ctx, 'tasks').forEach(x => openTasks.delete(x.item.id));
  }else{
    TASK_GROUPS.forEach(s => closedTaskGroups.delete(taskGroupKey(ctxId, s)));
  }
  render();
}

function toggleTaskRow(taskId){
  if(openTasks.has(taskId)) openTasks.delete(taskId); else openTasks.add(taskId);
  render();
}

// Status changes and comments together, oldest first.
function taskActivity(a){
  const key = (date, time, ts) => (date || '') + '|' + (to24(time) || '00:00') + '|' + String(ts || 0).padStart(14, '0');
  return [
    ...arr(a.log).map(e => ({kind: 'log', e, k: key(e.date, e.time, e.ts)})),
    ...arr(a.comments).map(cm => ({kind: 'comment', e: cm, k: key(cm.date, cm.time, Number(String(cm.id || '').replace(/\D/g, '').slice(0, 13)) || 0)}))
  ].sort((x, y) => x.k.localeCompare(y.k));
}

// Who an Activity item belongs to on a shared device task (3.2.2): on the device page every item is tagged with
// its aircraft or "Device"; on a project page only the shared (device) comments are tagged.
function activityTag(a, e, kind){
  const deviceId = a.aircraftOf ? a.aircraftOf.deviceId : (a.lines && a.lines.length ? a.lines[0].p.deviceId : '');
  if(!a.shared || !multiProject(deviceId)) return '';
  if(e.projectId){
    if(!a.lines) return '';
    const p = projectById(e.projectId);
    return p ? `<span class="scope-tag proj" title="${escapeHtml(projectName(p))}">${escapeHtml(shortProjectLabel(p))}</span>` : '';
  }
  if(kind === 'log' && !a.lines) return '';
  return '<span class="scope-tag dev" title="Shared by every aircraft on this device">Device</span>';
}

// Comment box (3.2.2): hidden behind an "Add comment" link; unsent text is kept while the page is open.
const openCommentBoxes = new Set();
const commentKey = (ownerId, taskId, aircraftId) => ownerId + '|' + taskId + '|' + (aircraftId || '');

function openCommentBox(ownerId, taskId, aircraftId){
  openCommentBoxes.add(commentKey(ownerId, taskId, aircraftId));
  render();
  const box = document.getElementById('cmt-' + taskId);
  if(box){ box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}

function cancelCommentBox(ownerId, taskId, aircraftId){
  const key = commentKey(ownerId, taskId, aircraftId);
  openCommentBoxes.delete(key);
  delete commentDrafts[key];
  render();
}

function renderActivity(owner, a){
  const items = taskActivity(a);
  const when = e => `${fmtDate(e.date)}${e.time ? ', ' + escapeHtml(e.time) : ''}`;
  const rows = items.map(({kind, e}) => {
    if(kind === 'comment') return `
      <div class="act-item act-comment">
        <span class="act-when">${when(e)}</span>
        <div class="act-body">${ICON.comment}${activityTag(a, e, 'comment')}<span class="rich-text">${formatText(e.text)}</span></div>
        ${EDITOR ? `<button class="comment-del" type="button" title="Delete comment" aria-label="Delete comment" onclick="deleteComment('${owner.id}', '${a.id}', '${e.id}')">${ICON.x}</button>` : '<span></span>'}
      </div>`;
    const change = e.kind === 'entered'
      ? `<span class="act-entered">Entered</span>`
      : `${e.from ? statusPill(e.from) + '<span class="act-arrow">→</span>' : '<span class="act-arrow">→</span>'}${statusPill(e.to)}`;
    const why = e.legacy ? '<div class="act-why muted">Recorded before 3.2.1</div>' : (e.reason ? `<div class="act-why rich-text">${formatText(e.reason)}</div>` : '');
    return `
      <div class="act-item act-log">
        <span class="act-when">${when(e)}</span>
        <div class="act-body"><div>${activityTag(a, e, 'log')}${change}</div>${why}</div>
        <span></span>
      </div>`;
  }).join('');
  const air = a.aircraftOf ? a.aircraftOf.id : '';
  const key = commentKey(owner.id, a.id, air);
  const args = `'${owner.id}', '${a.id}', '${air}'`;
  const note = a.lines && multiProject(owner.id) ? '<div class="comment-note">Shared: shows on every aircraft’s project page.</div>' : '';
  const form = !EDITOR ? '' : openCommentBoxes.has(key) ? `
      <div class="comment-add">
        <textarea id="cmt-${a.id}" aria-label="Add a comment" placeholder="Add a comment" oninput="commentDrafts['${key}'] = this.value; document.getElementById('cmt-err-${a.id}').style.display = 'none';" onkeydown="if(event.key === 'Enter' && (event.ctrlKey || event.metaKey)){ event.preventDefault(); addComment(${args}); }">${escapeHtml(commentDrafts[key] || '')}</textarea>
        <div class="comment-add-btns"><button class="btn-primary" type="button" onclick="addComment(${args})">Add</button><button type="button" onclick="cancelCommentBox(${args})">Cancel</button></div>
      </div>
      ${note}
      <div class="comment-err" id="cmt-err-${a.id}" style="display:none;">Enter a comment first.</div>`
    : `<button class="text-link add-comment" type="button" onclick="openCommentBox(${args})">${ICON.plus}<span>Add comment${commentDrafts[key] ? ' <span class="muted">(unsent draft)</span>' : ''}</span></button>`;
  return `<div class="act-list"><div class="act-head">Activity</div>${rows || '<div class="entry-empty">Nothing yet</div>'}</div>${form}`;
}

function taskDueCell(a){
  const status = taskGroupOf(a);
  if(status === 'Complete'){
    const late = lateNote(a).replace(/<[^>]+>/g, '').replace(/[()]/g, '').trim();
    return `<span class="pill pill-sage">Done ${fmtDate(a.dateCompleted).replace(/, \d{4}$/, '')}</span>${late ? ` <span class="muted">${late}</span>` : ''}`;
  }
  if(a.dateDue) return isTaskOverdue(a) ? `<span class="pill pill-overdue">Overdue</span><span class="due-late">${fmtDate(a.dateDue).replace(/, \d{4}$/, '')}</span>` : fmtDate(a.dateDue).replace(/, \d{4}$/, '');
  if(status === 'Waiting' && a.waitingSince) return `<span class="muted">since ${fmtDate(a.waitingSince).replace(/, \d{4}$/, '')}</span>`;
  return '<span class="muted">—</span>';
}

// Complete or Reopen for one task, or one aircraft's copy of a shared task (3.2.2).
function taskBtn(ownerId, a, aircraftId){
  if(!EDITOR) return '';
  const args = `'${ownerId}', '${a.id}', '${taskGroupOf(a) === 'Complete' ? 'Not Started' : 'Complete'}', '${aircraftId || ''}'`;
  return taskGroupOf(a) === 'Complete'
    ? `<button class="task-btn" type="button" onclick="event.stopPropagation(); openStatusModal(${args})">${ICON.reopen}<span>Reopen</span></button>`
    : `<button class="task-btn ok" type="button" onclick="event.stopPropagation(); openStatusModal(${args})">${ICON.check}<span>Complete</span></button>`;
}

// Device page: one line per aircraft on a shared task, each with its own status, due date and button.
function renderAircraftLines(x, cols){
  const a = x.item, owner = x.owner;
  const lines = a.lines.map(({p, a: v}) => {
    const g = taskGroupOf(v);
    const state = g === 'Complete' ? taskDueCell(v) : `${statusPill(g)}<span class="ac-due">${v.dateDue || (g === 'Waiting' && v.waitingSince) ? taskDueCell(v) : '<span class="muted">No due date</span>'}</span>`;
    return `
        <div class="ac-line">
          <button class="text-link ac-name" type="button" onclick="openTask('${owner.id}', '${a.id}', false, null, '${p.id}')" title="Open ${escapeHtml(projectName(p))}">${escapeHtml(shortProjectLabel(p))}</button>
          <span class="ac-state">${state}</span>
          ${EDITOR ? `<span class="ac-btns"><button class="text-link ac-change" type="button" onclick="openStatusModal('${owner.id}', '${a.id}', '', '${p.id}')">Change status</button>${taskBtn(owner.id, v, p.id)}</span>` : ''}
        </div>`;
  }).join('');
  return `<tr class="task-aircraft"><td class="tc-chev"></td><td colspan="${cols - 1}"><div class="ac-lines">${lines || '<span class="muted">No aircraft on this device.</span>'}</div></td></tr>`;
}

function renderTaskRow(x, ctx){
  const a = x.item, owner = x.owner;
  const open = openTasks.has(a.id);
  const done = taskGroupOf(a) === 'Complete';
  const n = arr(a.comments).length;
  const lines = !!a.lines;   // a shared task on its device page
  const air = x.aircraft ? x.aircraft.id : '';
  const btn = lines ? '' : taskBtn(owner.id, a, air);
  const meta = [
    `Entered ${fmtDate(a.dateCreated)}${a.timeCreated ? ', ' + escapeHtml(a.timeCreated) : ''}`,
    a.dateDue ? `Due ${fmtDate(a.dateDue)}` : '',
    a.dateUpdated && a.dateUpdated !== a.dateCreated ? `Updated ${fmtDate(a.dateUpdated)}${a.timeUpdated ? ', ' + escapeHtml(a.timeUpdated) : ''}` : '',
    a.dateCompleted ? `Completed ${fmtDate(a.dateCompleted)}${a.timeCompleted ? ', ' + escapeHtml(a.timeCompleted) : ''}${lateNote(a)}` : ''
  ].filter(Boolean).join(' · ');
  const cols = EDITOR ? 6 : 5;
  return `
    <tr class="task-row${open ? ' open' : ''}${done ? ' done' : ''}" id="task-${a.id}" onclick="toggleTaskRow('${a.id}')" aria-expanded="${open}">
      <td class="tc-chev">${ICON.chevron}</td>
      <td class="tc-ref">${a.ref ? escapeHtml(a.ref) : '<span class="muted">—</span>'}</td>
      <td class="tc-title" title="${escapeHtml(taskTitle(a))}">${scopeTag(owner, ctx)}${escapeHtml(taskTitle(a))}</td>
      <td class="tc-due">${taskDueCell(a)}</td>
      <td class="tc-cm${n ? '' : ' muted'}" title="${countLabel(n, 'comment', 'comments')}">${n}</td>
      ${EDITOR ? `<td class="tc-act">${btn}</td>` : ''}
    </tr>
    ${lines ? renderAircraftLines(x, cols) : ''}
    ${open ? `<tr class="task-more"><td class="tc-chev"></td><td colspan="${cols - 1}">
      ${a.details ? `<div class="task-details rich-text">${formatText(a.details)}</div>` : ''}
      <div class="entry-meta">${meta}</div>
      ${EDITOR ? `<div class="task-actions">
        ${actionBtn('edit', 'Edit', `openTaskModal('${ctx.id}', '${owner.id}', '${a.id}')`, {compact: false})}
        ${lines ? '' : actionBtn('reopen', 'Change status', `openStatusModal('${owner.id}', '${a.id}', '', '${air}')`, {compact: false})}
        ${actionBtn('trash', 'Delete', `deleteTask('${owner.id}', '${a.id}')`, {cls: 'danger', compact: false})}
      </div>` : ''}
      ${renderActivity(owner, a)}
    </td></tr>` : ''}`;
}

function renderTasksSection(ctx){
  const groups = taskGroups(ctx);
  const any = tasksAnyOpen(ctx);
  const toggle = groups.length ? `<button class="act-toggle-all" type="button" onclick="toggleAllTasks('${ctx.id}')">${any ? ICON.collapseAll : ICON.expandAll}<span>${any ? 'Collapse all' : 'Expand all'}</span></button>` : '';
  const cols = `<colgroup><col class="tw-chev"><col class="tw-ref"><col><col class="tw-due"><col class="tw-cm">${EDITOR ? '<col class="tw-act">' : ''}</colgroup>`;
  const head = `<thead><tr><th></th><th>Ref</th><th>Task</th><th>Due / status</th><th title="Comments">${ICON.comment}</th>${EDITOR ? '<th></th>' : ''}</tr></thead>`;
  const body = groups.length ? groups.map(g => {
    const done = g.status === 'Complete';
    const n = g.items.length;
    const overdue = done ? 0 : g.items.filter(x => isTaskOverdue(x.item)).length;
    const nextDue = g.items.map(x => x.item.dateDue).filter(Boolean).sort()[0];
    const latest = g.items.map(x => x.item.dateCompleted).filter(Boolean).sort().pop();
    const note = [done ? (latest ? `Latest ${fmtDate(latest)}` : '') : (nextDue ? `Next due ${fmtDate(nextDue)}` : 'No due dates'),
      overdue ? `<span class="c-rust">${overdue} overdue</span>` : ''].filter(Boolean).join(' · ');
    const open = !closedTaskGroups.has(taskGroupKey(ctx.id, g.status));
    return `
      <div class="task-frame">
        <button class="task-frame-head" type="button" aria-expanded="${open}" onclick="toggleTaskGroup('${ctx.id}', '${g.status}')">${ICON.chevron}${statusPill(g.status)}<span class="task-frame-count">${countLabel(n, 'task', 'tasks')}</span><span class="task-frame-note">${note}</span></button>
        ${open ? `<table class="task-table${done ? ' done' : ''}">${cols}${head}<tbody>${g.items.map(x => renderTaskRow(x, ctx)).join('')}</tbody></table>` : ''}
      </div>`;
  }).join('') : '<div class="entry-empty">No tasks yet</div>';
  return `
    <div class="changelog">
      <div class="section-head"><span>Tasks</span><span class="section-tools">${toggle}${EDITOR ? actionBtn('plus', 'Add', `openTaskModal('${ctx.id}')`, {compact: false}) : ''}</span></div>
      ${body}
    </div>`;
}

// Unsent comment text (kept while the page is open).
const commentDrafts = {};

// =====================================================================
// CSV export (3.2): one row per project. The view-only page leaves out contact email and street address.
// =====================================================================
function exportProjectsCsv(){
  const atdFor = p => atd.devices.filter(d => arr(d.certIds).includes(p.id)).map(d => d.name).join('; ');
  const cols = [
    ['Customer', p => customerKey(p)],
    ['SIM serial number', p => p.serial],
    ['SIM model', p => simModel(p)],
    ['SIM location', p => EDITOR ? p.simLocation : publicLocation(p.simLocation)],
    ['Contact name', p => p.contactName],
    ...(EDITOR ? [['Contact email', p => p.contactEmail]] : []),
    ['Regulatory authority', p => p.authority],
    ['Certifying country', p => p.country],
    ['Certification level', p => p.level],
    ['Aircraft type', p => p.aircraft],
    ['Project', p => projectName(p)],
    ['Status', p => projectStatus(p).label],
    ['Due date', p => p.date],
    ['Completed', p => p.completed ? (p.dateCompleted || 'Yes') : ''],
    ['Qualification status', p => qual(p).status],
    ['Certificate / LOA number', p => qual(p).certificateNumber],
    ['Issued', p => qual(p).issueDate],
    ['Expires', p => qual(p).expiryDate],
    ['Next evaluation', p => qual(p).nextEvaluation],
    ['Regulation', p => { const r = projectRegulation(p); return r ? regLabel(r.doc, r.revision) : ''; }],
    ['Open tasks', p => openTaskCount(projectTasks(p)).length],
    ['Overdue tasks', p => projectTasks(p).filter(isTaskOverdue).length],
    ['Next task due', p => openTaskCount(projectTasks(p)).map(a => a.dateDue).filter(Boolean).sort()[0] || ''],
    ['Documents', p => scopedList(p, 'docs').length],
    ['ATD device', atdFor]
  ];
  const cell = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = sortListItems('project', projects).map(p => cols.map(([, f]) => cell(f(p))).join(','));
  const csv = '﻿' + [cols.map(([h]) => cell(h)).join(','), ...rows].join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  a.download = `certification-tracker-projects-${localToday()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
