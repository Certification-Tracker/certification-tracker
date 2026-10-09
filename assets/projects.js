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
        const tasks = [...arr(d.tasks), ...list.flatMap(p => arr(p.tasks))];
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
        <h2 class="detail-title">Projects <span class="title-count">(${projects.length})</span></h2>
        <div class="doc-meta">${countLabel(projects.filter(p => !p.completed).length, 'open project', 'open projects')} · ${countLabel(customers, 'customer', 'customers')} · ${countLabel(devices.length, 'device', 'devices')} · by regulatory authority</div>
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
      `<span class="pill pill-${st.cls}">${st.label}</span>${open ? countLabel(open, 'open task', 'open tasks') + ' · ' : ''}${p.completed ? 'Completed ' + fmtDate(p.dateCompleted) : (p.date ? 'Due ' + fmtDate(p.date) : 'No due date')}`);
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
      <div class="fk">Aircraft Projects</div>
      <div class="row-list dev-projects">${rows || '<div class="muted list-empty">No projects on this device.</div>'}</div>
    </div>
    ${renderDocumentsSection(d)}
    ${renderTasksSection(d)}`;
}

// ---- Project page ----
function renderProjectView(p){
  if(!p) return renderProjectsView();
  const d = p.device;
  const status = projectStatus(p);
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
      <span class="pill pill-${status.cls}">${status.label}</span>
    </div>
    ${EDITOR ? `
    <div class="detail-actions">
      ${p.completed ? actionBtn('reopen', 'Reopen', `reopenProject('${p.id}')`) : actionBtn('check', 'Mark complete', `completeProject('${p.id}')`, {cls: 'ok'})}
      ${actionBtn('trash', 'Delete', `removeProject('${p.id}')`, {cls: 'danger'})}
    </div>` : ''}
    <div class="scope-boxes">${d ? deviceBox(d, p) : ''}${projectBox(p)}</div>
    ${renderProjectAtdLinks(p)}
    ${renderQualification(p)}
    ${renderDocumentsSection(p)}
    ${renderTasksSection(p)}`;
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
      <div class="fk section-head"><span>Qualification ${q.status ? `<span class="pill pill-${qualStatusCls(q.status)}">${escapeHtml(q.status)}</span>` : ''}</span>${EDITOR ? actionBtn('edit', 'Edit', `openProjectModal('${p.id}', '', null, 'qual')`, {compact: false}) : ''}</div>
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
      <div class="fk section-head"><span>Documents</span>${tools}</div>
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

// ---- Tasks ----
// One expandable group per status (Not Started, In Progress, Waiting, Completed), each starting collapsed.
// Open groups sort by due date (entered date when there's none); Completed newest first.
function taskGroups(ctx){
  const entries = scopedList(ctx, 'tasks');
  return TASK_GROUPS.map(status => {
    const items = entries.filter(x => taskGroupOf(x.item) === status);
    if(status === 'Complete'){
      const k = a => (a.dateCompleted || a.dateDue || a.dateCreated || '') + (a.dateCompleted ? to24(a.timeCompleted) : '');
      items.sort((x, y) => k(y.item).localeCompare(k(x.item)));
    }else{
      items.sort((x, y) => (x.item.dateDue || x.item.dateCreated || '').localeCompare(y.item.dateDue || y.item.dateCreated || ''));
    }
    return {status, items};
  }).filter(g => g.items.length);
}

function tasksAnyOpen(ctx){
  return TASK_GROUPS.some(s => openTaskGroups.has(taskGroupKey(ctx.id, s)))
    || scopedList(ctx, 'tasks').some(x => openThreads.has(x.item.id));
}

function toggleTaskGroup(ctxId, status){
  const key = taskGroupKey(ctxId, status);
  if(openTaskGroups.has(key)) openTaskGroups.delete(key); else openTaskGroups.add(key);
  render();
}

// Collapse all closes every group and comment thread on the page; Expand all opens every group.
function toggleAllTasks(ctxId){
  const ctx = ownerById(ctxId);
  if(!ctx) return;
  if(tasksAnyOpen(ctx)){
    TASK_GROUPS.forEach(s => openTaskGroups.delete(taskGroupKey(ctxId, s)));
    scopedList(ctx, 'tasks').forEach(x => openThreads.delete(x.item.id));
  }else{
    taskGroups(ctx).forEach(g => openTaskGroups.add(taskGroupKey(ctxId, g.status)));
  }
  render();
}

function renderTaskEntry(x, ctx){
  const a = x.item, owner = x.owner;
  const status = taskStatusLabel(a.status);
  const over = isTaskOverdue(a);
  return `
    <div class="entry" id="task-${a.id}">
      <div class="entry-top">
        <div>
          <span class="pill pill-${taskStatusClass(status)}">${escapeHtml(status)}</span>${scopeTag(owner, ctx)}
          <span class="entry-text rich-text">${formatText(a.description || '')}</span>
        </div>
        ${EDITOR ? `<div class="cert-actions">
          ${status !== 'Complete'
            ? actionBtn('check', 'Complete', `markTaskComplete('${owner.id}', '${a.id}')`, {cls: 'ok'})
            : actionBtn('reopen', 'Reopen', `reopenTask('${owner.id}', '${a.id}')`)}
          ${actionBtn('edit', 'Edit', `openTaskModal('${ctx.id}', '${owner.id}', '${a.id}')`)}
          ${actionBtn('trash', 'Delete', `deleteTask('${owner.id}', '${a.id}')`, {cls: 'danger'})}
        </div>` : ''}
      </div>
      <div class="entry-meta">
        Entered ${fmtDate(a.dateCreated)}${a.timeCreated ? ', ' + escapeHtml(a.timeCreated) : ''}
        ${a.dateDue ? ` · Due ${fmtDate(a.dateDue)}${over ? ' <span class="pill pill-overdue">Overdue</span>' : ''}` : ''}
        ${a.dateUpdated && a.dateUpdated !== a.dateCreated ? ` · Updated ${fmtDate(a.dateUpdated)}${a.timeUpdated ? ', ' + escapeHtml(a.timeUpdated) : ''}` : ''}
        ${status === 'Waiting' && a.waitingSince ? ` · Waiting since ${fmtDate(a.waitingSince)}` : ''}
        ${a.dateCompleted ? ` · Completed ${fmtDate(a.dateCompleted)}${a.timeCompleted ? ', ' + escapeHtml(a.timeCompleted) : ''}${lateNote(a)}` : ''}
      </div>
      ${renderComments(owner, a)}
    </div>`;
}

function renderTasksSection(ctx){
  const groups = taskGroups(ctx);
  const any = tasksAnyOpen(ctx);
  const toggle = groups.length ? `<button class="act-toggle-all" type="button" onclick="toggleAllTasks('${ctx.id}')" title="${any ? 'Collapse' : 'Expand'} all tasks">${any ? ICON.collapseAll : ICON.expandAll}<span>${any ? 'Collapse all' : 'Expand all'}</span></button>` : '';
  const body = groups.length ? '<div class="task-groups">' + groups.map((g, gi) => {
    const done = g.status === 'Complete';
    const n = g.items.length;
    const overdue = done ? 0 : g.items.filter(x => isTaskOverdue(x.item)).length;
    const nextDue = g.items.map(x => x.item.dateDue).filter(Boolean).sort()[0];
    const dateNote = done ? (g.items[0].item.dateCompleted ? `Latest ${fmtDate(g.items[0].item.dateCompleted)}` : '') : (nextDue ? `Next due ${fmtDate(nextDue)}` : 'No due dates');
    const open = openTaskGroups.has(taskGroupKey(ctx.id, g.status));
    const bodyId = `grp-${ctx.id}-${gi}`;
    return `
      <button class="task-group" type="button" aria-expanded="${open}" aria-controls="${bodyId}" onclick="toggleTaskGroup('${ctx.id}', '${g.status}')">${ICON.chevron}<span class="pill pill-${taskStatusClass(g.status)}">${done ? 'Completed' : escapeHtml(g.status)}</span><span class="task-group-count">${countLabel(n, 'task', 'tasks')}</span>${overdue ? `<span class="pill pill-overdue">${overdue} overdue</span>` : ''}<span class="task-group-date">${dateNote}</span></button>
      ${open ? `<div class="task-group-body" id="${bodyId}">${g.items.map(x => renderTaskEntry(x, ctx)).join('')}</div>` : ''}`;
  }).join('') + '</div>' : '<div class="entry-empty">No tasks yet</div>';
  return `
    <div class="changelog">
      <div class="fk section-head"><span>Tasks</span><span class="section-tools">${toggle}${EDITOR ? actionBtn('plus', 'Add', `openTaskModal('${ctx.id}')`, {compact: false}) : ''}</span></div>
      ${body}
    </div>`;
}

// ---- Task comments: a running thread on each task (comments: [{id, text, date, time}], oldest first) ----
const commentDrafts = {};

function renderComments(owner, a){
  const list = arr(a.comments);
  const n = list.length;
  const open = openThreads.has(a.id);
  const key = owner.id + '|' + a.id;
  let thread = '';
  if(open){
    const items = n ? list.map(cm => `
        <div class="comment">
          <div class="comment-body">
            <div class="comment-text rich-text">${formatText(cm.text)}</div>
            <div class="comment-stamp">${fmtDate(cm.date)}${cm.time ? ', ' + escapeHtml(cm.time) : ''}</div>
          </div>
          ${EDITOR ? `<button class="comment-del" type="button" title="Delete comment" aria-label="Delete comment" onclick="deleteComment('${owner.id}', '${a.id}', '${cm.id}')">${ICON.x}</button>` : ''}
        </div>`).join('') : '<div class="comment-empty">No comments yet</div>';
    const form = EDITOR ? `
        <div class="comment-add">
          <textarea id="cmt-${a.id}" aria-label="Add a comment" placeholder="Add a comment" oninput="commentDrafts['${key}'] = this.value; document.getElementById('cmt-err-${a.id}').style.display = 'none';" onkeydown="if(event.key === 'Enter' && (event.ctrlKey || event.metaKey)){ event.preventDefault(); addComment('${owner.id}', '${a.id}'); }">${escapeHtml(commentDrafts[key] || '')}</textarea>
          <button class="btn-primary" type="button" onclick="addComment('${owner.id}', '${a.id}')">Add</button>
        </div>
        <div class="comment-err" id="cmt-err-${a.id}" style="display:none;">Enter a comment first.</div>` : '';
    thread = `<div class="comment-thread" id="thread-${a.id}"><div class="comment-list">${items}</div>${form}</div>`;
  }
  return `
      <button class="comments-toggle" type="button" aria-expanded="${open}" aria-controls="thread-${a.id}" onclick="toggleComments('${a.id}')">${ICON.chevron}Comments <span class="${n ? '' : 'cc-zero'}">(${n})</span></button>
      ${thread}`;
}

function toggleComments(taskId){
  if(openThreads.has(taskId)) openThreads.delete(taskId); else openThreads.add(taskId);
  render();
  if(openThreads.has(taskId)){
    const box = document.getElementById('cmt-' + taskId);
    if(box) box.focus({preventScroll: true});
  }
}

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
