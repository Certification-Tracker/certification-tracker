// =====================================================================
// Editor (admin/project-management.html): everything specific to editing.
// Loaded after tracker.js, projects.js and atd.js. Moved out of the page in 3.2.
// =====================================================================
let ghConfig = null;
let saving = false;
let localVersion = 0;
let addingComment = false;
let pendingConversion = null;   // a v3 file read but not yet converted and saved (see load)

const $ = id => document.getElementById(id);
const val = id => $(id).value.trim();
const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
const today = () => localToday();

function nowTime(){ return new Date().toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}); }

let idCounter = 0;
function newId(prefix){ return prefix + Date.now().toString(36) + (idCounter++).toString(36); }

// Sign-in lives on the view-only page (../index.html); send the user there when there are no saved
// credentials or GitHub rejects them.
function redirectToSignIn(reason){
  location.replace('../index.html?settings=1' + (reason ? '&reason=' + encodeURIComponent(reason) : '') + location.hash);
}

// =====================================================================
// Pop-up forms: open/close, Escape and clicking outside close the top one
// =====================================================================
const modalClosers = {};   // extra tidy-up when a form closes

function openModalEl(id, focusId){
  $(id).classList.add('open');
  if(focusId) setTimeout(() => { const el = $(focusId); if(el) el.focus(); }, 0);
}

function closeModalEl(id){
  $(id).classList.remove('open');
  if(modalClosers[id]) modalClosers[id]();
}

document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', e => { if(e.target === bg && !bg.dataset.sticky) closeModalEl(bg.id); });
  bg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModalEl(bg.id)));
});

document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-bg.open')].filter(m => !m.dataset.sticky);
  if(open.length) closeModalEl(open[open.length - 1].id);
});

// Yes/no question before deleting things.
let confirmOk = null;
function confirmAction(title, html, okLabel, onOk){
  $('confirm-title').textContent = title;
  $('confirm-body').innerHTML = html;
  $('confirm-ok-label').textContent = okLabel;
  confirmOk = onOk;
  openModalEl('confirm-modal-bg', 'confirm-cancel-btn');
}
$('confirm-ok-btn').addEventListener('click', () => { const f = confirmOk; confirmOk = null; closeModalEl('confirm-modal-bg'); if(f) f(); });
modalClosers['confirm-modal-bg'] = () => { confirmOk = null; };

function showErr(id, text){ const el = $(id); el.textContent = text; el.style.display = 'block'; }
function hideErr(id){ $(id).style.display = 'none'; }

// =====================================================================
// GitHub writes
// =====================================================================
function b64EncodeUtf8(str){ return btoa(unescape(encodeURIComponent(str))); }

// Writes a file to the repo and returns its new SHA. sha = the version being replaced (null for a new file).
async function ghWriteFile(path, text, sha, message){
  const body = {message, content: b64EncodeUtf8(text), branch: ghConfig.branch};
  if(sha) body.sha = sha;
  const res = await fetch(ghApiUrl(path), {method: 'PUT', headers: {...ghHeaders(), 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if(!res.ok){
    const errBody = await res.text();
    if(res.status === 401 || res.status === 403) throw new Error('GitHub rejected the saved token. <a href="../index.html?settings=1&reason=rejected">Reconnect from the view-only page</a>, then try again.');
    if(res.status === 409) throw new Error('Conflict: the file changed on GitHub since last load. Refresh the page to get the latest version before saving again.');
    throw new Error(`GitHub write failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  return (await res.json()).content.sha;
}

// SHA of a file in the repo, or null if it doesn't exist (works for large files too).
async function ghFileSha(path){
  const res = await fetch(ghApiUrl(path) + `?ref=${encodeURIComponent(ghConfig.branch)}`, {headers: {...ghHeaders(), 'Accept': 'application/vnd.github.object+json'}, cache: 'no-cache'});
  if(res.status === 404) return null;
  if(!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  return (await res.json()).sha;
}

const saveErrorText = e => e.message.startsWith('GitHub rejected the saved token.') ? e.message : escapeHtml(e.message);

async function writeData(message){
  currentSha = await ghWriteFile(ghConfig.path, JSON.stringify(wrapData(), null, 2) + '\n', currentSha, message || 'Update tracker data');
}

// Saves the projects file; returns true when saved.
async function persist(message){
  if(!ghConfig){ showBanner('error', 'Not connected to GitHub. <a href="../index.html?settings=1">Connect from the view-only page</a>.'); return false; }
  if(pendingConversion){ openConversion(); return false; }
  saving = true;
  localVersion++;
  try{
    showBanner('info', 'Saving to GitHub&hellip;');
    await writeData(message);
    // A search tally waiting to be saved goes along with this save.
    if(libraryLoaded && Object.keys(pendingTally().terms).length){ try{ await writeLibrary('Library: search tally'); }catch(e){} }
    broadcastSaved();
    showBanner('success', 'Saved to GitHub.');
    setTimeout(hideBanner, 2000);
    return true;
  }catch(e){
    showBanner('error', 'Save failed: ' + saveErrorText(e));
    return false;
  }finally{
    saving = false;
  }
}

async function writeLibrary(message){
  library.searchTally = mergedTally();
  librarySha = await ghWriteFile(libraryPath(), JSON.stringify(library, null, 2) + '\n', librarySha, message);
  clearPendingTally();
}

async function persistLibrary(message, successText){
  saving = true;
  try{
    showBanner('info', 'Saving to GitHub&hellip;');
    await writeLibrary(message);
    broadcastSaved();
    showBanner('success', successText || 'Saved to GitHub.');
    setTimeout(hideBanner, 2000);
    return true;
  }catch(e){
    showBanner('error', 'Save failed: ' + saveErrorText(e));
    return false;
  }finally{
    saving = false;
  }
}

// =====================================================================
// Loading, and the one-time conversion to devices and projects (3.2)
// =====================================================================
async function load(){
  const saved = loadSettings();
  if(!saved || !saved.token){ redirectToSignIn(); return; }
  ghConfig = {...DATA_REPO, token: saved.token};
  try{
    showBanner('info', 'Loading from GitHub&hellip;');
    // The library comes first so a conversion can record the regulation issue of completed projects.
    const [raw] = await Promise.all([fetchFromGitHub(), loadLibrary()]);
    if(raw === null){
      setData({devices: [], projects: []});
      currentSha = null;
      showBanner('info', 'No data file found yet — creating one&hellip;');
      await writeData('Initialize tracker data');
      showBanner('success', 'Created the data file.');
      setTimeout(hideBanner, 2500);
    }else{
      const r = readData(raw);
      setData(r.data);
      if(r.converted){ pendingConversion = {raw, report: r.report}; hideBanner(); openConversion(); }
      else hideBanner();
    }
  }catch(e){
    if(e.status === 401 || e.status === 403){ redirectToSignIn('rejected'); return; }
    showBanner('error', 'Could not load from GitHub: ' + escapeHtml(e.message));
    setData({devices: [], projects: []});
  }
  render();
}

function openConversion(){
  const r = pendingConversion.report;
  const shared = r.devices.filter(d => d.projects > 1);
  const fieldNames = {customer: 'Customer', serial: 'SN', simModel: 'SIM model', simLocation: 'SIM location', contactName: 'Contact name', contactEmail: 'Contact email', docLocation: 'Document location'};
  $('cv-body').innerHTML = `
    <p>Each simulator (customer and SN) becomes a <b>device</b>, with one <b>project</b> per aircraft certification on it. Authority, country and level stay with each project, since one device can be certified under different authorities.</p>
    <ul class="cv-list">
      <li>${countLabel(r.projects, 'project', 'projects')} on ${countLabel(r.devices.length, 'device', 'devices')}${shared.length ? `; ${countLabel(shared.length, 'device has', 'devices have')} more than one aircraft:` : '.'}
        ${shared.length ? `<ul>${shared.map(d => `<li>${escapeHtml(d.customer)} / SN ${escapeHtml(d.serial || '—')}: ${d.projects} projects</li>`).join('')}</ul>` : ''}</li>
      ${r.merged.tasks + r.merged.docs + r.merged.history ? `<li>Moved to the device because they were identical on every aircraft: ${[countLabel(r.merged.tasks, 'task', 'tasks'), countLabel(r.merged.docs, 'document', 'documents'), countLabel(r.merged.history, 'history entry', 'history entries')].join(', ')}.</li>` : ''}
      ${r.conflicts.length ? `<li>Device details that differed between aircraft (the first value is kept; check these after converting):<ul>${r.conflicts.map(c => `<li>${escapeHtml(c.device)}: ${fieldNames[c.field] || c.field} kept “${escapeHtml(c.kept)}”, not ${c.other.map(o => '“' + escapeHtml(o) + '”').join(', ')}</li>`).join('')}</ul></li>` : ''}
      ${r.fixes ? `<li>${countLabel(r.fixes, 'older entry', 'older entries')} tidied into the current format.</li>` : ''}
    </ul>
    <p class="muted">A copy of the current file is saved first, to ${escapeHtml(backupPath())}. Older versions also stay in Version history.</p>`;
  hideErr('cv-err');
  $('cv-save').disabled = false;
  openModalEl('convert-modal-bg', 'cv-save');
}

function backupPath(){
  return ghConfig.path.replace(/[^/]*$/, '') + `backups/certifications-v3-${today()}.json`;
}

async function confirmConversion(){
  if(!pendingConversion) return;
  $('cv-save').disabled = true;
  hideErr('cv-err');
  saving = true;
  try{
    const path = backupPath();
    await ghWriteFile(path, JSON.stringify(pendingConversion.raw, null, 2) + '\n', await ghFileSha(path), 'Backup before converting to devices and projects');
    projects.filter(p => p.completed && !qual(p).basisDocId && !qual(p).basisRevision).forEach(lockRegulation);
    await writeData('Convert tracker data to devices and projects (v3.2.0)');
    pendingConversion = null;
    closeModalEl('convert-modal-bg');
    broadcastSaved();
    showBanner('success', `Converted: ${countLabel(projects.length, 'project', 'projects')} on ${countLabel(devices.length, 'device', 'devices')}. Backup saved to ${escapeHtml(path)}.`);
    setTimeout(hideBanner, 6000);
    render();
  }catch(e){
    showErr('cv-err', e.message.replace(/<[^>]+>/g, ''));
    $('cv-save').disabled = false;
  }finally{
    saving = false;
  }
}
$('cv-save').addEventListener('click', confirmConversion);
$('cv-cancel').addEventListener('click', () => { location.href = '../index.html' + location.hash; });

// =====================================================================
// Devices and projects
// =====================================================================
let deviceForm = {id: null, authority: ''};
let pendingNewDevice = null;   // a new device waiting for its first aircraft (saved together)

function refreshDeviceModel(){
  const detected = detectModel(val('dv-serial'));
  $('dv-model').placeholder = detected || 'e.g. MCX';
  const tag = $('dv-model-mode');
  tag.textContent = val('dv-model') ? 'Custom' : (detected ? 'From serial' : '');
  tag.style.display = tag.textContent ? '' : 'none';
}
['dv-serial', 'dv-model'].forEach(id => $(id).addEventListener('input', refreshDeviceModel));

// id: edit that device. Otherwise a new device: refIdx (from the Projects page) can prefill its customer.
function openDeviceModal(id, refIdx){
  const d = id ? deviceById(id) : null;
  const ref = refIdx != null ? treeRefs[refIdx] || {} : {};
  deviceForm = {id: d ? d.id : null, authority: ref.authority && ref.authority !== 'No authority' ? ref.authority : ''};
  $('dv-title').textContent = d ? 'Edit device' : (ref.customer ? 'Add device' : 'Add customer');
  const set = (fid, v) => { $(fid).value = v || ''; };
  set('dv-customer', d ? d.customer : ref.customer);
  set('dv-serial', d && d.serial);
  set('dv-model', d && d.simModel);
  set('dv-location', d && d.simLocation);
  set('dv-contact-name', d && d.contactName);
  set('dv-contact-email', d && d.contactEmail);
  set('dv-docloc', d && d.docLocation);
  $('dv-save').textContent = d ? 'Save' : 'Save and add aircraft';
  $('dv-hint').hidden = !!d;
  hideErr('dv-err');
  refreshDeviceModel();
  openModalEl('device-modal-bg', d || !ref.customer ? 'dv-customer' : 'dv-serial');
}

async function saveDevice(){
  const f = {customer: val('dv-customer'), serial: val('dv-serial'), simModel: val('dv-model'), simLocation: val('dv-location'),
    contactName: val('dv-contact-name'), contactEmail: val('dv-contact-email'), docLocation: val('dv-docloc')};
  if(!f.customer) return showErr('dv-err', 'Enter the customer.');
  if(!f.serial) return showErr('dv-err', 'Enter the SIM serial number.');
  const same = devices.find(d => d.id !== deviceForm.id && customerKey(d).toLowerCase() === f.customer.toLowerCase() && String(d.serial || '').trim().toLowerCase() === f.serial.toLowerCase());
  if(same) return showErr('dv-err', `SN ${f.serial} is already in the tracker for ${customerKey(same)}. Use Add aircraft on it instead.`);
  if(deviceForm.id){
    const d = deviceById(deviceForm.id);
    if(!d) return closeModalEl('device-modal-bg');
    if(f.docLocation !== (d.docLocation || '')) addHistory(d, 'Document location updated: ' + (f.docLocation || '(cleared)'));
    Object.assign(d, f);
    closeModalEl('device-modal-bg');
    await persist(`Update device ${f.customer} / ${f.serial}`);
    render();
    return;
  }
  let id = deviceIdFor(f.customer, f.serial), n = 2;
  while(deviceById(id)) id = deviceIdFor(f.customer, f.serial) + '-' + (n++);
  pendingNewDevice = {id, ...f, docs: [], tasks: [], docChangeLog: []};
  const authority = deviceForm.authority;
  closeModalEl('device-modal-bg');
  openProjectModal(null, '', null, null, {device: pendingNewDevice, authority});
}
$('dv-save').addEventListener('click', saveDevice);

// Project form: Add aircraft (to an existing device, or the device just entered) and Edit project.
let projectForm = {id: null, device: null};

function readAutoFormFields(){
  const d = projectForm.device || {};
  return {authority: $('f-authority').value, level: $('f-level').value, aircraft: $('f-aircraft').value, serial: d.serial, simModel: d.simModel};
}

// Keeps the Name box showing its automatic value while it is left empty.
function refreshAutoFields(){
  const auto = autoName(readAutoFormFields());
  $('f-name').placeholder = auto || 'Fill in authority, level and aircraft, or type a name';
  $('name-mode').textContent = val('f-name') ? 'Custom' : 'Automatic';
}
['f-name', 'f-authority', 'f-level', 'f-aircraft'].forEach(id => $(id).addEventListener('input', refreshAutoFields));

// Authority list: the fixed names, plus any other value already in use (so nothing is lost).
function fillAuthorityOptions(select, current){
  const extra = [...new Set([...projects.map(p => (p.authority || '').trim()), ...library.templates.map(t => t.authority || '')].filter(a => a && !AUTHORITIES.includes(a)))];
  if(current && !AUTHORITIES.includes(current) && !extra.includes(current)) extra.push(current);
  select.innerHTML = '<option value="">Select…</option>' + AUTHORITIES.map(a => `<option>${escapeHtml(a)}</option>`).join('')
    + (extra.length ? `<optgroup label="Other names in use">${extra.sort().map(a => `<option>${escapeHtml(a)}</option>`).join('')}</optgroup>` : '');
  select.value = current || '';
}

function fillLevelList(){
  const levels = [...new Set([...LEVEL_SUGGESTIONS, ...projects.map(p => (p.level || '').trim()).filter(Boolean)])].sort(textCmp);
  $('level-list').innerHTML = levels.map(l => `<option value="${escapeHtml(l)}">`).join('');
}

function fillQualification(q){
  q = q || {};
  $('q-status').innerHTML = '<option value="">Not set</option>' + QUAL_STATUSES.map(s => `<option>${s}</option>`).join('');
  $('q-basis').innerHTML = '<option value="">Automatic (from authority and level)</option>'
    + library.documents.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(docTitle(d))}${d.revision ? ' – ' + escapeHtml(d.revision) : ''}</option>`).join('');
  $('q-status').value = q.status || '';
  $('q-number').value = q.certificateNumber || '';
  $('q-issue').value = q.issueDate || '';
  $('q-expiry').value = q.expiryDate || '';
  $('q-eval').value = q.nextEvaluation || '';
  $('q-basis').value = q.basis || '';
  $('q-conditions').value = q.conditions || '';
}

function readQualification(){
  return {status: val('q-status'), certificateNumber: val('q-number'), issueDate: isoDate(val('q-issue')), expiryDate: isoDate(val('q-expiry')),
    nextEvaluation: isoDate(val('q-eval')), basis: val('q-basis'), conditions: val('q-conditions')};
}

function deviceBadgeHtml(d, isNew){
  return `${ICON.device}<span><span class="device-badge-label">Device</span><b>${escapeHtml(customerKey(d))}</b> · SN ${escapeHtml(d.serial || '—')}${simModel(d) ? ' (' + escapeHtml(simModel(d)) + ')' : ''}</span>${isNew ? '<span class="device-badge-new">New</span>' : ''}`;
}

// id: edit that project. deviceId: add an aircraft to that device. extra.device: the new device from Add device.
function openProjectModal(id, deviceId, refIdx, focus, extra){
  const p = id ? projectById(id) : null;
  const ref = refIdx != null ? treeRefs[refIdx] || {} : {};
  const isNewDevice = !!(extra && extra.device);
  const d = p ? p.device : (isNewDevice ? extra.device : deviceById(deviceId));
  if(!d) return;
  projectForm = {id: p ? p.id : null, device: d};
  $('p-title').textContent = p ? 'Edit project' : 'Add aircraft';
  $('p-device-badge').innerHTML = deviceBadgeHtml(d, isNewDevice);
  const authority = p ? p.authority : ((extra && extra.authority) || (ref.authority && ref.authority !== 'No authority' ? ref.authority : ''));
  $('f-name').value = p && !p.nameAuto ? (p.name || '') : '';
  fillAuthorityOptions($('f-authority'), authority || '');
  fillLevelList();
  $('f-country').value = p ? (p.country || '') : '';
  $('f-level').value = p ? (p.level || '') : '';
  $('f-aircraft').value = p ? (p.aircraft || '') : '';
  $('f-date').value = p ? (p.date || '') : '';
  fillQualification(p ? p.qualification : null);
  hideErr('err-name');
  refreshAutoFields();
  openModalEl('project-modal-bg');
  if(focus === 'qual'){
    $('qual-head').scrollIntoView({block: 'start'});
    $('q-status').focus();
  }else{
    $(p ? 'f-name' : (authority ? 'f-level' : 'f-authority')).focus();
  }
}
modalClosers['project-modal-bg'] = () => { pendingNewDevice = null; };

async function saveProject(){
  const typedName = val('f-name');
  const data = {authority: val('f-authority'), country: val('f-country'), level: val('f-level'), aircraft: val('f-aircraft'),
    date: isoDate($('f-date').value), qualification: readQualification()};
  const generated = autoName({...data, serial: projectForm.device.serial, simModel: projectForm.device.simModel});
  if(!typedName && !generated) return showErr('err-name', 'Enter a name, or fill in the authority, level or aircraft.');
  // An empty Name box means "automatic"; the generated name is also stored so the data file stays readable.
  data.nameAuto = !typedName;
  data.name = typedName || generated;
  let message;
  if(projectForm.id){
    const p = projectById(projectForm.id);
    if(!p) return closeModalEl('project-modal-bg');
    const pq = {...qual(p)};
    Object.assign(p, data);
    // A completed project keeps the issue it was qualified under, unless its regulation was changed.
    if(p.completed){
      if((pq.basis || '') === (data.qualification.basis || '') && (pq.basisRevision || pq.basisDocId)){
        p.qualification.basisRevision = pq.basisRevision; p.qualification.basisDocId = pq.basisDocId;
      }else lockRegulation(p);
    }
    message = `Update project ${customerKey(p)} / ${data.name}`;
  }else{
    const d = projectForm.device;
    if(pendingNewDevice && pendingNewDevice === d){ devices.push(d); pendingNewDevice = null; }
    const id = 'c' + Date.now();
    projects.push({id, deviceId: d.id, ...data, docs: [], tasks: [], docChangeLog: []});
    view = {type: 'project', id};
    navFrom = null;
    message = `Add project ${customerKey(d)} / ${data.name}`;
  }
  closeModalEl('project-modal-bg');
  reindex();
  await persist(message);
  render();
}
$('p-save').addEventListener('click', saveProject);

async function completeProject(id){
  const p = projectById(id);
  if(!p) return;
  p.completed = true;
  p.dateCompleted = today();
  lockRegulation(p);
  await persist(`Complete project ${customerKey(p)} / ${projectName(p)}`);
  render();
}

async function reopenProject(id){
  const p = projectById(id);
  if(!p) return;
  p.completed = false;
  delete p.dateCompleted;
  unlockRegulation(p);
  await persist(`Reopen project ${customerKey(p)} / ${projectName(p)}`);
  render();
}

function listParts(parts){ return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]; }

function itemCounts(o){
  return [[arr(o.docs).length, 'document', 'documents'], [arr(o.docChangeLog).length, 'history entry', 'history entries'], [arr(o.tasks).length, 'task', 'tasks']]
    .filter(([n]) => n).map(([n, a, b]) => countLabel(n, a, b));
}

// Deleting a project asks first. Deleting a device's last project removes the device too.
function removeProject(id){
  const p = projectById(id);
  if(!p) return;
  const d = p.device;
  const last = d && projectsOf(d.id).length === 1;
  const own = itemCounts(p), dev = last ? itemCounts(d) : [];
  const label = `${customerKey(p)} / ${projectName(p)}`;
  confirmAction('Delete this project?', `
    <p class="confirm-name"><strong>${escapeHtml(projectName(p))}</strong><br><span class="confirm-context">${escapeHtml(customerKey(p))} / SN ${escapeHtml(p.serial || '—')}</span></p>
    ${own.length ? `<p>This also deletes its ${listParts(own)}.</p>` : ''}
    ${last ? `<p>It is the only aircraft on this device, so the device record goes too${dev.length ? `, with its ${listParts(dev)}` : ''}.</p>` : ''}
    <p>It can't be undone here, but Version history can restore an earlier copy.</p>`, 'Delete project', async () => {
    projects = projects.filter(x => x.id !== id);
    if(last) devices = devices.filter(x => x !== d);
    atd.devices.forEach(a => { if(arr(a.certIds).includes(id)) a.certIds = a.certIds.filter(x => x !== id); });
    reindex();
    view = last || !d ? {type: 'projects'} : {type: 'device', id: d.id};
    await persist('Delete project ' + label);
    render();
  });
}

// =====================================================================
// Scope: where a new task or document goes (shown when the device has more than one aircraft)
// =====================================================================
function fillScope(prefix, ctx, owner){
  const d = deviceOf(ctx);
  const list = d ? sortProjects(projectsOf(d.id)) : [];
  const select = $(prefix + '-scope');
  const multi = d && list.length > 1;
  $(prefix + '-scope-field').hidden = !multi;
  const opts = multi ? [[d.id, `All aircraft on SN ${d.serial || '—'} (device)`], ...list.map(p => [p.id, projectName(p)])] : [[owner.id, '']];
  select.innerHTML = opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  select.value = owner.id;
}

// Moves an item between owners when its scope changed; returns the owner it now belongs to.
function placeItem(key, item, oldOwner, newOwner){
  if(oldOwner && oldOwner !== newOwner) oldOwner[key] = arr(oldOwner[key]).filter(x => x !== item);
  if(!Array.isArray(newOwner[key])) newOwner[key] = [];
  if(!newOwner[key].includes(item)) newOwner[key].push(item);
  return newOwner;
}

function addHistory(owner, text){
  if(!Array.isArray(owner.docChangeLog)) owner.docChangeLog = [];
  owner.docChangeLog.push({id: newId('l'), date: today(), time: nowTime(), ts: Date.now(), text});
}

const findIn = (owner, key, id) => owner ? arr(owner[key]).find(x => x.id === id) || null : null;

// =====================================================================
// Tasks and comments
// =====================================================================
let taskForm = {ctxId: '', ownerId: '', taskId: ''};

function openTaskModal(ctxId, ownerId, taskId){
  const ctx = ownerById(ctxId);
  if(!ctx) return;
  const owner = ownerId ? ownerById(ownerId) : ctx;
  const a = taskId ? findIn(owner, 'tasks', taskId) : null;
  taskForm = {ctxId, ownerId: owner.id, taskId: a ? a.id : ''};
  $('task-modal-title').textContent = a ? 'Edit Task' : 'Add Task';
  $('a-description').value = a ? a.description || '' : '';
  $('a-status').value = a ? taskGroupOf(a) : 'Not Started';
  $('a-due').value = a ? a.dateDue || '' : '';
  fillScope('a', ctx, owner);
  hideErr('task-err');
  openModalEl('task-modal-bg', 'a-description');
}

async function saveTask(){
  const description = val('a-description');
  if(!description) return showErr('task-err', 'Enter a description.');
  const oldOwner = ownerById(taskForm.ownerId);
  const newOwner = ownerById($('a-scope').value) || oldOwner;
  const status = $('a-status').value || 'Not Started';
  const dateDue = isoDate($('a-due').value);
  const d = today(), t = nowTime();
  let a = taskForm.taskId ? findIn(oldOwner, 'tasks', taskForm.taskId) : null;
  if(a){
    let dateCompleted = a.dateCompleted || '', timeCompleted = a.timeCompleted || '';
    if(status === 'Complete' && !dateCompleted){ dateCompleted = d; timeCompleted = t; }
    if(status !== 'Complete'){ dateCompleted = ''; timeCompleted = ''; }
    const comments = arr(a.comments).slice();
    if(a.status === 'Complete' && status !== 'Complete'){ const note = reopenNote(a); if(note) comments.push(note); }
    // Waiting since: the day a task was set to Waiting (kept while it stays Waiting).
    const waitingSince = status === 'Waiting' ? (a.status === 'Waiting' && a.waitingSince ? a.waitingSince : d) : '';
    Object.assign(a, {description, status, dateDue, waitingSince, dateUpdated: d, timeUpdated: t, dateCompleted, timeCompleted, comments});
  }else{
    a = {id: newId('a'), description, status, dateDue, waitingSince: status === 'Waiting' ? d : '', dateCreated: d, timeCreated: t, dateUpdated: d, timeUpdated: t,
      dateCompleted: status === 'Complete' ? d : '', timeCompleted: status === 'Complete' ? t : ''};
  }
  placeItem('tasks', a, oldOwner, newOwner);
  // Open the group the task is now in (except Completed, which stays folded away).
  if(status !== 'Complete') openTaskGroups.add(taskGroupKey(taskForm.ctxId, taskStatusLabel(status)));
  closeModalEl('task-modal-bg');
  await persist('Task: ' + plainSnippet(description, 60));
  render();
}
$('task-save-btn').addEventListener('click', saveTask);

// Reopening a completed task adds an automatic comment so the earlier completion isn't lost.
function reopenNote(a){
  if(!a.dateCompleted) return null;
  return {id: newId('k'), text: `Reopened (was completed ${fmtDate(a.dateCompleted)})`, date: today(), time: nowTime()};
}

async function reopenTask(ownerId, taskId){
  const a = findIn(ownerById(ownerId), 'tasks', taskId);
  if(!a) return;
  const note = reopenNote(a);
  if(note) a.comments = [...arr(a.comments), note];
  Object.assign(a, {status: 'In Progress', waitingSince: '', dateUpdated: today(), timeUpdated: nowTime(), dateCompleted: '', timeCompleted: ''});
  const ctxId = view.type === 'device' || view.type === 'project' ? view.id : ownerId;
  openTaskGroups.add(taskGroupKey(ctxId, 'In Progress'));
  await persist('Task reopened: ' + plainSnippet(a.description, 60));
  render();
}

async function markTaskComplete(ownerId, taskId){
  const a = findIn(ownerById(ownerId), 'tasks', taskId);
  if(!a) return;
  const d = today(), t = nowTime();
  Object.assign(a, {status: 'Complete', waitingSince: '', dateUpdated: d, timeUpdated: t, dateCompleted: d, timeCompleted: t});
  await persist('Task complete: ' + plainSnippet(a.description, 60));
  render();
}

function deleteTask(ownerId, taskId){
  const owner = ownerById(ownerId);
  const a = findIn(owner, 'tasks', taskId);
  if(!a) return;
  confirmAction('Delete this task?', `<p class="confirm-name">${escapeHtml(plainSnippet(a.description, 200))}</p>${arr(a.comments).length ? `<p>This also deletes its ${countLabel(a.comments.length, 'comment', 'comments')}.</p>` : ''}`, 'Delete task', async () => {
    owner.tasks = owner.tasks.filter(x => x !== a);
    await persist('Delete task: ' + plainSnippet(a.description, 60));
    render();
  });
}

async function addComment(ownerId, taskId){
  if(addingComment) return;
  const box = $('cmt-' + taskId);
  const text = box ? box.value.trim() : '';
  if(!text){ const err = $('cmt-err-' + taskId); if(err) err.style.display = 'block'; return; }
  const a = findIn(ownerById(ownerId), 'tasks', taskId);
  if(!a) return;
  a.comments = [...arr(a.comments), {id: newId('k'), text, date: today(), time: nowTime()}];
  delete commentDrafts[ownerId + '|' + taskId];
  openThreads.add(taskId);
  addingComment = true;
  try{ await persist('Comment on task: ' + plainSnippet(a.description, 60)); }finally{ addingComment = false; }
  render();
}

async function deleteComment(ownerId, taskId, commentId){
  if(!confirm('Delete this comment? This can\'t be undone.')) return;
  const a = findIn(ownerById(ownerId), 'tasks', taskId);
  if(!a) return;
  a.comments = arr(a.comments).filter(cm => cm.id !== commentId);
  await persist('Delete comment');
  render();
}

// =====================================================================
// Documents and document history
// =====================================================================
let docForm = {ctxId: '', ownerId: '', docId: ''};

function openDocumentModal(ctxId, ownerId, docId){
  const ctx = ownerById(ctxId);
  if(!ctx) return;
  const owner = ownerId ? ownerById(ownerId) : ctx;
  const doc = docId ? findIn(owner, 'docs', docId) : null;
  docForm = {ctxId, ownerId: owner.id, docId: doc ? doc.id : ''};
  $('document-modal-title').textContent = doc ? 'Edit document' : 'Add document';
  $('d-name').value = doc ? doc.name || '' : '';
  $('d-url').value = doc ? doc.url || '' : '';
  const d = deviceOf(ctx);
  $('d-location').value = d ? d.docLocation || '' : '';
  fillScope('d', ctx, owner);
  hideErr('document-err');
  openModalEl('document-modal-bg', 'd-name');
}

async function saveDocument(){
  const name = val('d-name');
  if(!name) return showErr('document-err', 'Enter a document name.');
  const ctx = ownerById(docForm.ctxId);
  const oldOwner = ownerById(docForm.ownerId);
  const newOwner = ownerById($('d-scope').value) || oldOwner;
  const url = val('d-url');
  let doc = docForm.docId ? findIn(oldOwner, 'docs', docForm.docId) : null;
  if(doc){
    Object.assign(doc, {name, url});
    placeItem('docs', doc, oldOwner, newOwner);
    addHistory(newOwner, 'Document updated: ' + name);
  }else{
    doc = {id: newId('d'), name, url};
    placeItem('docs', doc, null, newOwner);
    addHistory(newOwner, 'Document added: ' + name);
  }
  const d = deviceOf(ctx);
  const location = val('d-location');
  if(d && location !== (d.docLocation || '')){
    addHistory(d, 'Document location updated: ' + (location || '(cleared)'));
    d.docLocation = location;
  }
  closeModalEl('document-modal-bg');
  await persist('Document: ' + name);
  render();
}
$('document-save-btn').addEventListener('click', saveDocument);

function deleteDocument(ownerId, docId){
  const owner = ownerById(ownerId);
  const doc = findIn(owner, 'docs', docId);
  if(!doc) return;
  confirmAction('Remove this document?', `<p class="confirm-name"><strong>${escapeHtml(doc.name)}</strong></p><p>Only the tracker's link is removed; the file itself stays where it is.</p>`, 'Remove document', async () => {
    owner.docs = owner.docs.filter(x => x !== doc);
    addHistory(owner, 'Document removed: ' + doc.name);
    await persist('Remove document: ' + doc.name);
    render();
  });
}

let logForm = {ownerId: '', entryId: ''};

// New entries go to the page you are on (the project, or the device).
function openChangeLogModal(ctxId, ownerId, entryId){
  const owner = ownerById(ownerId || ctxId);
  const e = entryId ? findIn(owner, 'docChangeLog', entryId) : null;
  logForm = {ownerId: owner.id, entryId: e ? e.id : ''};
  $('changelog-modal-title').textContent = e ? 'Edit history entry' : 'Add history entry';
  $('l-date').value = e ? e.date || '' : today();
  $('l-text').value = e ? e.text || '' : '';
  hideErr('changelog-err');
  openModalEl('changelog-modal-bg', 'l-text');
}

async function saveChangeLogEntry(){
  const text = val('l-text'), date = isoDate($('l-date').value);
  if(!date) return showErr('changelog-err', 'Enter a date.');
  if(!text) return showErr('changelog-err', 'Enter the entry text.');
  const owner = ownerById(logForm.ownerId);
  if(!owner) return;
  const e = logForm.entryId ? findIn(owner, 'docChangeLog', logForm.entryId) : null;
  if(e){
    if(e.date !== date) delete e.time;   // a recorded time only makes sense for the original date
    Object.assign(e, {date, text});
  }else{
    owner.docChangeLog = [...arr(owner.docChangeLog), {id: newId('l'), date, ts: Date.now(), text}];
  }
  closeModalEl('changelog-modal-bg');
  await persist('Document history: ' + plainSnippet(text, 60));
  render();
}
$('changelog-save-btn').addEventListener('click', saveChangeLogEntry);

async function deleteChangeLogEntry(ownerId, entryId){
  const owner = ownerById(ownerId);
  if(!findIn(owner, 'docChangeLog', entryId) || !confirm('Delete this history entry?')) return;
  owner.docChangeLog = owner.docChangeLog.filter(x => x.id !== entryId);
  await persist('Delete document history entry');
  render();
}

// =====================================================================
// Certification templates (3.2): add one from the library, link a copy on a project
// =====================================================================
let tplEditId = '';

function openTemplateModal(id){
  const t = id ? libraryTemplate(id) : null;
  tplEditId = t ? t.id : '';
  $('tpl-title-h').textContent = t ? 'Edit template' : 'Add template';
  fillAuthorityOptions($('t-authority'), t ? t.authority : '');
  fillLevelList();
  $('t-title').value = t ? t.title || '' : '';
  $('t-levels').value = t ? t.levels || '' : '';
  $('t-url').value = t ? t.url || '' : '';
  $('t-notes').value = t ? t.notes || '' : '';
  hideErr('tpl-err');
  openModalEl('template-modal-bg', t ? 't-title' : 't-authority');
}

async function saveTemplate(){
  const entry = {authority: val('t-authority'), title: val('t-title'), levels: val('t-levels').split(',').map(s => s.trim()).filter(Boolean).join(', '),
    url: val('t-url'), notes: val('t-notes')};
  if(!entry.authority || !entry.title || !entry.url) return showErr('tpl-err', 'Authority, title and Drive link are required.');
  if(!/^https?:\/\//i.test(entry.url)) entry.url = 'https://' + entry.url;
  let t = tplEditId ? libraryTemplate(tplEditId) : null;
  if(t) Object.assign(t, entry);
  else{
    let id = 'tpl-' + slug(entry.authority + ' ' + entry.title), n = 2;
    while(libraryTemplate(id)) id = 'tpl-' + slug(entry.authority + ' ' + entry.title) + '-' + (n++);
    t = {id, ...entry};
    library.templates.push(t);
  }
  closeModalEl('template-modal-bg');
  openAuthorities.add(t.authority);
  await persistLibrary(`Library: ${tplEditId ? 'update' : 'add'} template ${t.authority} ${t.title}`);
  render();
}
$('tpl-save').addEventListener('click', saveTemplate);

function deleteTemplate(id){
  const t = libraryTemplate(id);
  if(!t) return;
  confirmAction('Remove this template?', `<p class="confirm-name"><strong>${escapeHtml(t.authority + ' ' + t.title)}</strong></p><p>The file in Google Drive and any copies already linked on projects stay.</p>`, 'Remove template', async () => {
    library.templates = library.templates.filter(x => x !== t);
    await persistLibrary(`Library: remove template ${t.authority} ${t.title}`);
    render();
  });
}

// From template: 1. make a copy in Drive, 2. save it in the customer's project folder, 3. link the copy here.
let fromTpl = {projectId: '', templateId: '', nameTouched: false};

function openFromTemplate(projectId){
  const p = projectById(projectId);
  if(!p) return;
  const temps = templatesFor(p);
  fromTpl = {projectId, templateId: temps.length ? temps[0].id : '', nameTouched: false};
  const what = [p.authority, p.level].filter(Boolean).join(' ') || 'this project';
  $('ft-list').innerHTML = temps.length
    ? temps.map(t => `<label class="ft-item"><input type="radio" name="ft-pick" value="${escapeHtml(t.id)}" ${t.id === fromTpl.templateId ? 'checked' : ''} onchange="pickTemplate(this.value)"><span><b>${escapeHtml(t.title)}</b><span class="atd-cert-sub">${escapeHtml(t.authority)} · ${templateLevels(t).length ? escapeHtml(templateLevels(t).join(', ')) : 'All levels'}${t.notes ? ' · ' + escapeHtml(t.notes) : ''}</span></span></label>`).join('')
    : `<div class="muted ft-empty">No templates for ${escapeHtml(what)} yet. Add one in the Regulatory Library (Add template).</div>`;
  const loc = (p.docLocation || '').trim();
  $('ft-folder').innerHTML = loc
    ? (/^https?:\/\//i.test(loc) ? `<a href="${escapeHtml(loc)}" target="_blank" rel="noopener noreferrer">Open the project folder ${ICON.external}</a>` : `Project folder: <span class="doc-loc">${escapeHtml(loc)}</span>`)
    : 'No document location set for this device yet (add it under Edit device or a document).';
  $('ft-steps').hidden = !temps.length;
  $('ft-save').disabled = !temps.length;
  $('ft-url').value = '';
  hideErr('ft-err');
  pickTemplate(fromTpl.templateId);
  openModalEl('fromtpl-modal-bg');
}

function pickTemplate(id){
  fromTpl.templateId = id;
  const t = libraryTemplate(id);
  const p = projectById(fromTpl.projectId);
  if(!t || !p) return;
  const copy = driveCopyUrl(t.url);
  $('ft-copy').href = copy || t.url;
  $('ft-copy-label').textContent = copy ? 'Make a copy in Drive' : 'Open the template';
  $('ft-copy-hint').textContent = copy ? 'Drive asks where to save the copy and what to call it.' : 'This link has no "make a copy" page: download it or use File > Make a copy in Drive.';
  if(!fromTpl.nameTouched) $('ft-name').value = `${t.title} - ${p.serial || customerKey(p)}`;
}
$('ft-name').addEventListener('input', () => { fromTpl.nameTouched = true; });

async function saveFromTemplate(){
  const p = projectById(fromTpl.projectId);
  const t = libraryTemplate(fromTpl.templateId);
  const name = val('ft-name');
  let url = val('ft-url');
  if(!p || !t) return;
  if(!name) return showErr('ft-err', 'Enter a name for the document.');
  if(!url) return showErr('ft-err', 'Paste the link to your copy (step 3).');
  if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if(url.split('?')[0] === t.url.split('?')[0]) return showErr('ft-err', 'That is the template itself. Paste the link to your copy.');
  p.docs = [...arr(p.docs), {id: newId('d'), name, url, template: t.id}];
  addHistory(p, `Document added from template ${t.title}: ${name}`);
  closeModalEl('fromtpl-modal-bg');
  await persist('Document from template: ' + name);
  render();
}
$('ft-save').addEventListener('click', saveFromTemplate);

// =====================================================================
// Regulatory Library: add, edit, delete, and build each document's search index
// =====================================================================
function openLibraryModal(docId){
  const d = docId ? libraryDoc(docId) : null;
  $('lib-modal-title').textContent = d ? 'Edit regulation' : 'Add regulation';
  $('lib-edit-id').value = d ? d.id : '';
  const set = (id, v) => { $(id).value = v || ''; };
  set('lib-authority', d && d.authority);
  set('lib-title', d && d.title);
  set('lib-full', d && d.fullTitle);
  set('lib-revision', d && d.revision);
  set('lib-asof', d && d.asOf);
  set('lib-file', d && d.file);
  set('lib-url', d && d.officialUrl);
  $('lib-authorities').innerHTML = libraryAuthorities().map(a => `<option value="${escapeHtml(a)}">`).join('');
  hideErr('lib-err');
  openModalEl('lib-modal-bg', d ? 'lib-title' : 'lib-authority');
}

async function saveLibraryDoc(){
  const entry = {authority: val('lib-authority'), title: val('lib-title'), fullTitle: val('lib-full'), revision: val('lib-revision'),
    asOf: isoDate(val('lib-asof')), file: val('lib-file').replace(/^.*\//, ''), officialUrl: val('lib-url')};
  if(!entry.authority || !entry.title || !entry.file) return showErr('lib-err', 'Authority, title and PDF file name are required.');
  if(entry.officialUrl && !/^https?:\/\//i.test(entry.officialUrl)) entry.officialUrl = 'https://' + entry.officialUrl;
  const editId = $('lib-edit-id').value;
  let doc;
  if(editId){
    doc = libraryDoc(editId);
    const fileChanged = doc.file !== entry.file;
    Object.assign(doc, entry);
    if(fileChanged){ doc.indexed = false; doc.pages = 0; }
  }else{
    let id = slug(entry.authority + ' ' + entry.title + ' ' + entry.revision) || 'doc', n = 2;
    while(libraryDoc(id)) id = slug(entry.authority + ' ' + entry.title + ' ' + entry.revision) + '-' + (n++);
    doc = {id, ...entry, indexed: false, pages: 0};
    library.documents.push(doc);
  }
  closeModalEl('lib-modal-bg');
  openAuthorities.add(doc.authority);
  if(!await persistLibrary(`Library: ${editId ? 'update' : 'add'} ${docTitle(doc)}`)) return;
  navigate({type: 'reg', id: doc.id, page: 1});
  if(!doc.indexed) rebuildIndex(doc.id);
}
$('lib-save-btn').addEventListener('click', saveLibraryDoc);

function deleteLibraryDoc(id){
  const d = libraryDoc(id);
  if(!d) return;
  confirmAction('Remove this regulation?', `<p class="confirm-name"><strong>${escapeHtml(docTitle(d))}</strong></p><p>The PDF itself stays in the data repo's regs/ folder; delete it there if you no longer need it.</p>`, 'Remove regulation', async () => {
    library.documents = library.documents.filter(x => x.id !== id);
    const path = regIndexPath(d);
    delete pageIndexes[path];
    if(!await persistLibrary(`Library: remove ${docTitle(d)}`, 'Removed from the library.')) return;
    // Tidy up its search index (best effort).
    try{
      const sha = await ghFileSha(path);
      if(sha) await fetch(ghApiUrl(path), {method: 'DELETE', headers: {...ghHeaders(), 'Content-Type': 'application/json'},
        body: JSON.stringify({message: `Library: remove search index for ${docTitle(d)}`, sha, branch: ghConfig.branch})});
    }catch(e){}
    openLibrary();
  });
}

// Loads a library from the CDN once and resolves with its global (PDF.js, SheetJS).
const scriptLoads = {};
function loadScript(url, globalName, failText){
  if(window[globalName]) return Promise.resolve(window[globalName]);
  if(!scriptLoads[url]){
    scriptLoads[url] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = url;
      el.onload = () => resolve(window[globalName]);
      el.onerror = () => { delete scriptLoads[url]; el.remove(); reject(new Error(failText)); };
      document.head.appendChild(el);
    });
  }
  return scriptLoads[url];
}

// Reads the PDF's text page by page with PDF.js and saves it as regs/index/<id>.json, which the search uses.
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';

function loadPdfJs(){
  return loadScript(PDFJS_URL, 'pdfjsLib', 'Could not load the PDF reader. Check your connection and try again.').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_URL.replace('pdf.min.js', 'pdf.worker.min.js');
    return lib;
  });
}

async function rebuildIndex(id){
  const d = libraryDoc(id);
  if(!d) return;
  saving = true;
  try{
    showBanner('info', `Building the search index for ${escapeHtml(docTitle(d))}&hellip;`);
    const pdfjs = await loadPdfJs();
    let res;
    try{ res = await ghRaw('regs/' + d.file); }
    catch(err){ throw new Error(err.status === 404 ? `regs/${d.file} isn't in the data repo yet. Upload the PDF to tracker-data's regs/ folder, then click Rebuild search index.` : err.message); }
    const pdf = await pdfjs.getDocument({data: new Uint8Array(await res.arrayBuffer())}).promise;
    const pages = [];
    for(let p = 1; p <= pdf.numPages; p++){
      const content = await (await pdf.getPage(p)).getTextContent();
      pages.push(content.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim());
      if(p % 10 === 0) showBanner('info', `Building the search index for ${escapeHtml(docTitle(d))}: page ${p} of ${pdf.numPages}&hellip;`);
    }
    const path = regIndexPath(d);
    await ghWriteFile(path, JSON.stringify({id: d.id, pages}), await ghFileSha(path), `Library: search index for ${docTitle(d)}`);
    d.pages = pdf.numPages;
    d.indexed = true;
    delete pageIndexes[path];
    await writeLibrary(`Library: ${docTitle(d)} indexed`);
    broadcastSaved();
    showBanner('success', `Search index built: ${countLabel(pdf.numPages, 'page', 'pages')}.`);
    setTimeout(hideBanner, 5000);
  }catch(e){
    showBanner('error', 'Search index not built: ' + saveErrorText(e));
  }finally{
    saving = false;
    lastDetailHtml = null;
    render();
  }
}

// =====================================================================
// ATD Approvals (3.1): spreadsheet import and device details
// =====================================================================
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
let pendingImport = null;

async function persistAtd(message, successText){
  saving = true;
  try{
    showBanner('info', 'Saving to GitHub&hellip;');
    atdSha = await ghWriteFile(atdPath(), JSON.stringify(atd, null, 2) + '\n', atdSha, message);
    broadcastSaved();
    showBanner('success', successText || 'Saved to GitHub.');
    setTimeout(hideBanner, 2500);
    return true;
  }catch(e){
    showBanner('error', 'Save failed: ' + saveErrorText(e));
    return false;
  }finally{
    saving = false;
  }
}

function openAtdImport(){
  pendingImport = null;
  $('atd-file').value = '';
  $('atd-drop-label').textContent = 'Drop FAA_Approval_Tracker.xlsx here';
  $('atd-import-preview').innerHTML = '';
  hideErr('atd-import-err');
  $('atd-import-save').disabled = true;
  openModalEl('atd-import-bg');
}
modalClosers['atd-import-bg'] = () => { pendingImport = null; };

const showDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : (v || 'blank');

async function readAtdFile(dropped){
  const preview = $('atd-import-preview');
  hideErr('atd-import-err');
  preview.innerHTML = '';
  $('atd-import-save').disabled = true;
  pendingImport = null;
  const input = $('atd-file');
  const file = dropped instanceof File ? dropped : (input.files && input.files[0]);
  if(!file) return;
  if(!/\.(xlsx|xlsm|xls)$/i.test(file.name)) return showErr('atd-import-err', `${file.name} isn't an Excel file. Drop FAA_Approval_Tracker.xlsx.`);
  $('atd-drop-label').textContent = file.name;
  try{
    preview.innerHTML = '<div class="muted">Reading the spreadsheet&hellip;</div>';
    const XLSX = await loadScript(XLSX_URL, 'XLSX', 'Could not load the spreadsheet reader. Check your connection and try again.');
    const wb = XLSX.read(await file.arrayBuffer(), {type: 'array'});
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, raw: true, defval: null});
    const parsed = parseAtdRows(rows);
    const diff = diffAtdImport(atd.devices, parsed.devices);
    pendingImport = {file: file.name, ...parsed};
    const item = (tag, d, extra) => `<div class="atd-import-item"><span class="atd-import-tag ${tag}">${tag === 'new' ? 'New' : tag === 'changed' ? 'Changed' : 'Removed'}</span><b>${escapeHtml(d.name)}</b>${extra || ''}</div>`;
    const changes = diff.changed.map(c => item('changed', c.device, c.fields.map(([label, a, b]) =>
      `<div class="atd-import-change">${escapeHtml(label)}: <s>${escapeHtml(showDate(a))}</s> → ${escapeHtml(showDate(b))}</div>`).join('')));
    const any = diff.added.length + diff.changed.length + diff.removed.length;
    preview.innerHTML = `
      <div class="atd-import-summary">${countLabel(parsed.devices.length, 'device', 'devices')} in the sheet${parsed.asOf ? ` (as of ${fmtDate(parsed.asOf)})` : ''}: <b>${diff.added.length} new, ${diff.changed.length} changed, ${diff.removed.length} removed</b>, ${diff.unchanged} unchanged.</div>
      ${any ? `<div class="atd-import-list">
        ${diff.added.map(d => item('new', d, `<div class="atd-import-change">QAG ${escapeHtml(vLabel(d.version))} · expires ${escapeHtml(d.expiration ? fmtDate(d.expiration) : (d.expirationText || 'TBA'))}</div>`)).join('')}
        ${changes.join('')}
        ${diff.removed.map(d => item('removed', d, '<div class="atd-import-change">Not in this spreadsheet; it will be removed from the tracker.</div>')).join('')}
      </div>` : '<div class="muted">Nothing has changed since the last import.</div>'}`;
    $('atd-import-save').disabled = false;
  }catch(e){
    preview.innerHTML = '';
    showErr('atd-import-err', e.message);
  }
}

async function saveAtdImport(){
  if(!pendingImport) return;
  const imp = pendingImport;
  atd = {schemaVersion: 1, source: {file: imp.file, asOf: imp.asOf, importedAt: today()}, devices: mergeAtdImport(atd.devices, imp.devices)};
  closeModalEl('atd-import-bg');
  await persistAtd(`ATD: import ${imp.file}${imp.asOf ? ' (as of ' + imp.asOf + ')' : ''}`, `Imported ${countLabel(imp.devices.length, 'device', 'devices')}.`);
  lastDetailHtml = null;
  render();
}

// Linked projects: linked ones first, then grouped by customer; the filter narrows the list.
let atdLinked = new Set();

function openAtdDeviceModal(id){
  const d = atdDevice(id);
  if(!d) return;
  $('atd-dev-title').textContent = 'Edit ' + d.name;
  $('atd-dev-id').value = d.id;
  $('atd-kb-url').value = d.kbUrl || '';
  $('atd-kb-exclude').checked = !!d.kbExclude;
  atdLinked = new Set(d.certIds || []);
  $('atd-cert-filter').value = '';
  renderAtdCertList();
  openModalEl('atd-dev-bg', 'atd-kb-url');
}

function renderAtdCertList(){
  const t = val('atd-cert-filter').toLowerCase();
  const match = p => !t || [customerKey(p), p.serial, projectName(p)].some(v => String(v || '').toLowerCase().includes(t));
  const item = p => `
    <label class="atd-cert-item ${atdLinked.has(p.id) ? 'on' : ''}">
      <input type="checkbox" value="${p.id}" ${atdLinked.has(p.id) ? 'checked' : ''} onchange="toggleAtdLink(this)">
      <span><b>${escapeHtml(projectName(p))}</b><span class="atd-cert-sub">${escapeHtml(customerKey(p))}${p.serial ? ' · SN ' + escapeHtml(p.serial) : ''}${p.completed ? ' · Completed' : ''}</span></span>
    </label>`;
  const linked = sortProjects(projects.filter(p => atdLinked.has(p.id) && match(p)));
  const groups = {};
  sortProjects(projects.filter(p => !atdLinked.has(p.id) && match(p))).forEach(p => (groups[customerKey(p)] = groups[customerKey(p)] || []).push(p));
  const html = (linked.length ? `<div class="atd-cert-group">Linked</div>${linked.map(item).join('')}` : '')
    + Object.keys(groups).sort(textCmp).map(g => `<div class="atd-cert-group">${escapeHtml(g)}</div>${groups[g].map(item).join('')}`).join('');
  $('atd-cert-list').innerHTML = html || `<div class="muted atd-cert-empty">${projects.length ? 'No projects match.' : 'No projects yet.'}</div>`;
  $('atd-cert-count').textContent = atdLinked.size ? `· ${atdLinked.size} linked` : '';
}

function toggleAtdLink(box){
  if(box.checked) atdLinked.add(box.value); else atdLinked.delete(box.value);
  renderAtdCertList();
}

async function saveAtdDevice(){
  const d = atdDevice($('atd-dev-id').value);
  if(!d) return closeModalEl('atd-dev-bg');
  let url = val('atd-kb-url');
  if(url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  d.kbUrl = url;
  d.kbExclude = $('atd-kb-exclude').checked;
  d.certIds = [...atdLinked].filter(projectById);
  closeModalEl('atd-dev-bg');
  await persistAtd(`ATD: update ${d.name}`);
  lastDetailHtml = null;
  render();
}

$('atd-file').addEventListener('change', () => readAtdFile());
$('atd-cert-filter').addEventListener('input', renderAtdCertList);
$('atd-import-save').addEventListener('click', saveAtdImport);
$('atd-dev-save').addEventListener('click', saveAtdDevice);

// Drag and drop: onto the import window's drop area, or anywhere on the ATD Approvals page.
const isFileDrag = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
const atdDropArea = $('atd-drop');
['dragenter', 'dragover'].forEach(ev => atdDropArea.addEventListener(ev, e => { if(isFileDrag(e)){ e.preventDefault(); atdDropArea.classList.add('over'); } }));
['dragleave', 'drop'].forEach(ev => atdDropArea.addEventListener(ev, () => atdDropArea.classList.remove('over')));
atdDropArea.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if(f) readAtdFile(f);
});
const onAtdPage = () => view.type === 'atd' && !document.querySelector('.modal-bg.open');
document.addEventListener('dragover', e => {
  if(!isFileDrag(e)) return;
  e.preventDefault();   // stops the browser opening the file instead
  document.body.classList.toggle('atd-drop-page', onAtdPage());
});
document.addEventListener('dragleave', e => { if(!e.relatedTarget) document.body.classList.remove('atd-drop-page'); });
document.addEventListener('drop', e => {
  if(!isFileDrag(e)) return;
  e.preventDefault();
  document.body.classList.remove('atd-drop-page');
  if(!onAtdPage()) return;
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if(!f) return;
  openAtdImport();
  readAtdFile(f);
});

// =====================================================================
// Version history (3.2): earlier copies of data/certifications.json from GitHub, and restore
// =====================================================================
const hist = {commits: null, loading: false, error: '', selected: '', preview: null, previewing: false};

async function loadHistory(force){
  if(hist.loading || (hist.commits && !force)) return;
  hist.loading = true;
  try{
    const res = await fetch(ghRepoUrl(`commits?path=${encodeURIComponent(ghConfig.path)}&sha=${encodeURIComponent(ghConfig.branch)}&per_page=50`), {headers: ghHeaders(), cache: 'no-cache'});
    if(!res.ok) throw new Error(`GitHub couldn't list the versions (${res.status}).`);
    hist.commits = (await res.json()).map(c => ({sha: c.sha, message: (c.commit.message || '').split('\n')[0], date: (c.commit.committer || c.commit.author || {}).date || '',
      author: (c.author && c.author.login) || (c.commit.author || {}).name || ''}));
    hist.error = '';
  }catch(e){
    hist.commits = [];
    hist.error = e.message;
  }finally{
    hist.loading = false;
    lastDetailHtml = null;
    render();
  }
}

function openHistory(){
  closeModalEl('admin-modal-bg');
  hist.commits = null;
  navigate({type: 'history'});
}

const fmtStamp = iso => iso ? new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';

// What restoring a version would change, by project.
function compareVersions(old){
  const now = new Map(projects.map(p => [p.id, p]));
  const then = new Map(old.projects.map(p => [p.id, p]));
  const devThen = new Map(old.devices.map(d => [d.id, d]));
  const label = (p, devs) => { const d = devs.get(p.deviceId) || {}; return `${(d.customer || 'Unassigned')} / SN ${d.serial || '—'} / ${p.aircraft || p.level || p.name || p.id}`; };
  const sig = (p, devs) => JSON.stringify({p, d: devs.get(p.deviceId) || null});
  const added = old.projects.filter(p => !now.has(p.id)).map(p => label(p, devThen));
  const removed = projects.filter(p => !then.has(p.id)).map(p => label(p, deviceIndex));
  const changed = old.projects.filter(p => now.has(p.id) && sig(p, devThen) !== sig(JSON.parse(JSON.stringify(now.get(p.id))), deviceIndex)).map(p => label(p, devThen));
  const taskCount = data => [...data.devices, ...data.projects].reduce((n, o) => n + arr(o.tasks).length, 0);
  return {added, removed, changed, tasksThen: taskCount(old), tasksNow: taskCount({devices, projects})};
}

async function previewVersion(sha){
  hist.selected = sha;
  hist.preview = null;
  hist.previewing = true;
  render();
  try{
    const res = await ghReadJson(ghConfig.path, sha);
    if(!res) throw new Error('That version has no data file.');
    const r = readData(res.data);
    hist.preview = {sha, data: r.data, converted: r.converted, diff: compareVersions(r.data)};
  }catch(e){
    hist.preview = {sha, error: e.message};
  }finally{
    hist.previewing = false;
    lastDetailHtml = null;
    render();
  }
}

function restoreVersion(){
  const pv = hist.preview;
  const c = hist.commits && hist.commits.find(x => x.sha === pv.sha);
  if(!pv || !pv.data || !c) return;
  confirmAction('Restore this version?', `<p>The projects data goes back to how it was on <strong>${escapeHtml(fmtStamp(c.date))}</strong> (${escapeHtml(c.message)}).</p><p>The current copy stays in Version history, so this can be undone by restoring it.</p>`, 'Restore version', async () => {
    const keep = {devices, projects};
    setData(JSON.parse(JSON.stringify(pv.data)));
    if(await persist(`Restore data from ${c.date.slice(0, 10)} (${c.sha.slice(0, 7)})`)){
      hist.commits = null; hist.preview = null; hist.selected = '';
      showBanner('success', `Restored the version from ${escapeHtml(fmtStamp(c.date))}.`);
      setTimeout(hideBanner, 4000);
    }else setData(keep);
    render();
  });
}

function renderHistoryView(){
  const list = hist.commits;
  const pv = hist.preview;
  const diffList = (title, items) => items.length ? `<div class="hist-diff"><b>${title} (${items.length})</b><ul>${items.slice(0, 12).map(x => `<li>${escapeHtml(x)}</li>`).join('')}${items.length > 12 ? `<li class="muted">and ${items.length - 12} more</li>` : ''}</ul></div>` : '';
  let panel = '';
  if(hist.previewing) panel = '<div class="muted list-empty">Reading that version…</div>';
  else if(pv && pv.error) panel = `<div class="reg-note error">${escapeHtml(pv.error)}</div>`;
  else if(pv){
    const d = pv.diff;
    const same = !d.added.length && !d.removed.length && !d.changed.length;
    panel = `
      <div class="hist-preview">
        <div class="hist-preview-head">Restoring this version would:</div>
        ${same ? '<div class="muted">Change nothing: it matches the current data.</div>' : diffList('Bring back', d.added) + diffList('Remove', d.removed) + diffList('Change', d.changed)}
        <div class="muted hist-tasks">Tasks: ${d.tasksThen} then, ${d.tasksNow} now.${pv.converted ? ' This copy is from before 3.2, so it is converted to devices and projects when restored.' : ''}</div>
        ${same ? '' : `<button class="btn-primary hist-restore" type="button" onclick="restoreVersion()">Restore this version</button>`}
      </div>`;
  }
  const rows = list === null ? '<div class="muted list-empty">Loading versions…</div>'
    : hist.error ? `<div class="reg-note error">${escapeHtml(hist.error)} The editor key needs Contents: read access, which also covers commit history.</div>`
    : list.map((c, i) => `
      <div class="hist-row ${hist.selected === c.sha ? 'on' : ''}">
        <button class="hist-pick" type="button" onclick="previewVersion('${c.sha}')" ${i === 0 ? 'disabled' : ''}>
          <span class="hist-date">${escapeHtml(fmtStamp(c.date))}${i === 0 ? ' <span class="pill pill-sage">Current</span>' : ''}</span>
          <span class="hist-msg">${escapeHtml(c.message)}</span>
          <span class="row-sub">${escapeHtml(c.author)} · ${c.sha.slice(0, 7)}</span>
        </button>
        ${hist.selected === c.sha ? panel : ''}
      </div>`).join('');
  return `
    <div class="detail-context">Editor</div>
    <div class="detail-head"><div>
      <h2 class="detail-title">Version History</h2>
      <div class="doc-meta">Every save of the projects data (${escapeHtml(ghConfig.path)}) is kept by GitHub. Choose a version to see what restoring it would change. The library and ATD data aren't affected.</div>
    </div></div>
    <div class="detail-actions doc-actions">${actionBtn('reopen', 'Refresh', 'loadHistory(true)', {compact: false})}</div>
    <div class="hist-list">${rows}</div>`;
}

// =====================================================================
// Search tally: your searches are counted in data/library.json, to build a shared
// suggested-searches list in a future update. Saved with your next save, or at most once an hour.
// =====================================================================
const TALLY_KEY = 'cert-tracker-search-tally-pending';
const TALLY_FLUSH_MS = 60 * 60 * 1000;

function pendingTally(){
  try{ return JSON.parse(localStorage.getItem(TALLY_KEY) || 'null') || {terms: {}, since: Date.now()}; }catch(e){ return {terms: {}, since: Date.now()}; }
}

function tallySearch(term){
  const p = pendingTally();
  if(!Object.keys(p.terms).length) p.since = Date.now();
  p.terms[term] = (p.terms[term] || 0) + 1;
  try{ localStorage.setItem(TALLY_KEY, JSON.stringify(p)); }catch(e){}
}

function mergedTally(){
  const merged = {...(library.searchTally || {})};
  Object.entries(pendingTally().terms).forEach(([k, n]) => { merged[k] = (merged[k] || 0) + n; });
  return merged;
}

function clearPendingTally(){ try{ localStorage.removeItem(TALLY_KEY); }catch(e){} }

async function flushTallyIfDue(){
  const p = pendingTally();
  if(!Object.keys(p.terms).length || saving || !libraryLoaded) return;
  if(Date.now() - (p.since || 0) < TALLY_FLUSH_MS) return;
  try{ await writeLibrary('Library: search tally'); }catch(e){ /* try again later */ }
}
setInterval(flushTallyIfDue, 5 * 60 * 1000);

// ---- Admin panel (gear in the header) ----
function openAdmin(){
  const top = Object.entries(mergedTally()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  $('admin-tally').innerHTML = top.length
    ? `<ol class="tally-list">${top.map(([t, n]) => `<li>${escapeHtml(t)} <span class="muted">(${n})</span></li>`).join('')}</ol>`
    : '<p class="muted">No searches counted yet.</p>';
  $('admin-reset-date').textContent = library.searchResetAt ? 'Last cleared ' + new Date(library.searchResetAt).toLocaleString() : '';
  openModalEl('admin-modal-bg');
}

function clearAllSearchHistory(){
  confirmAction("Clear everyone's search history?", "<p>Each person's suggested searches start fresh the next time they open the tracker. The search tally used for future shared suggestions is kept.</p>", 'Clear history', async () => {
    library.searchResetAt = new Date().toISOString();
    try{ localStorage.removeItem(SEARCH_HISTORY_KEY); }catch(e){}
    closeModalEl('admin-modal-bg');
    await persistLibrary('Library: clear search history', "Everyone's search history has been cleared.");
  });
}

$('admin-btn').addEventListener('click', openAdmin);
$('admin-clear-btn').addEventListener('click', clearAllSearchHistory);
$('admin-history-btn').addEventListener('click', openHistory);

// =====================================================================
// Keeping tabs up to date
// =====================================================================
function syncKey(){
  return ghConfig ? `${ghConfig.owner}/${ghConfig.repo}@${ghConfig.branch}:${ghConfig.path}`.toLowerCase() : '';
}

// Check GitHub again when this tab is selected, unless a form is open or a save is running.
async function refreshFromGitHub(){
  if(!ghConfig || saving || pendingConversion || document.querySelector('.modal-bg.open')) return;
  if(Date.now() - lastFetchAt < 5000) return;
  const prevSha = currentSha;
  const versionAtStart = localVersion;
  try{
    const raw = await fetchFromGitHub();
    // A save started meanwhile: keep the local data and its SHA.
    if(saving || localVersion !== versionAtStart){ currentSha = prevSha; return; }
    if(isV4(raw) && currentSha !== prevSha && !document.querySelector('.modal-bg.open')){
      setData(normalizeV4(raw));
      render();
    }
  }catch(e){ /* keep showing what's already loaded */ }
}

document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') refreshFromGitHub(); });
window.addEventListener('focus', refreshFromGitHub);

// Tabs in the same browser: share saves straight away, and note when the editor is open twice.
const TAB_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const otherEditors = new Set();
const syncChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('cert-tracker-sync') : null;

function broadcastSaved(){
  if(!syncChannel) return;
  try{ syncChannel.postMessage({type: 'saved', from: TAB_ID, key: syncKey(), sha: currentSha, data: JSON.parse(JSON.stringify(wrapData())), library, atd}); }catch(e){}
}

function updateTabNote(){ $('tab-note').style.display = otherEditors.size ? 'block' : 'none'; }

if(syncChannel){
  syncChannel.onmessage = ev => {
    const m = ev.data || {};
    if(m.from === TAB_ID) return;
    if(m.type === 'saved'){
      if(saving || m.key !== syncKey() || !isV4(m.data)) return;
      setData(normalizeV4(m.data));
      if(m.library) library = normalizeLibrary(m.library);
      if(m.atd) atd = normalizeAtd(m.atd);
      currentSha = m.sha || currentSha;
      localVersion++;
      render();
    }else if(m.type === 'editor-hello'){
      syncChannel.postMessage({type: 'editor-here', from: TAB_ID});   // tell a newly opened editor this one is open
    }else if(m.type === 'editor-here'){
      otherEditors.add(m.from);
      updateTabNote();
    }else if(m.type === 'editor-bye'){
      otherEditors.delete(m.from);
      updateTabNote();
    }
  };
  syncChannel.postMessage({type: 'editor-hello', from: TAB_ID});
  window.addEventListener('pagehide', () => { try{ syncChannel.postMessage({type: 'editor-bye', from: TAB_ID}); }catch(e){} });
  window.addEventListener('pageshow', ev => {
    if(!ev.persisted) return;
    otherEditors.clear();
    updateTabNote();
    syncChannel.postMessage({type: 'editor-hello', from: TAB_ID});
    refreshFromGitHub();
  });
}

initHeader();
load();
