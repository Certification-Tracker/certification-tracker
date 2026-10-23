// =====================================================================
// Certification Tracker Editor app: install and task reminders (3.3.0). Editor page only.
// Loaded after editor.js. Everything here is kept per computer (this browser's storage):
//   cert-tracker-reminders = {enabled, time, days, lookAhead, noDueLine, notify, badge, lockScreen,
//                              prompt: 'ask' | 'snoozed' | 'never', snoozeUntil, lastFired}
// Reminders fire only in the installed app window. The startup prompt also only shows there.
// =====================================================================
const REMINDER_KEY = 'cert-tracker-reminders';
const REMINDER_DEFAULTS = {enabled: false, time: '08:00', days: [1, 2, 3, 4, 5], lookAhead: 3, noDueLine: true,
  notify: true, badge: true, lockScreen: false, prompt: 'ask', snoozeUntil: '', lastFired: ''};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SNOOZE_DAYS = 7;

function loadReminderSettings(){
  let s = {};
  try{ s = JSON.parse(localStorage.getItem(REMINDER_KEY) || '{}') || {}; }catch(e){}
  return {...REMINDER_DEFAULTS, ...s};
}

function saveReminderSettings(s){
  try{ localStorage.setItem(REMINDER_KEY, JSON.stringify(s)); }catch(e){}
  reminders = s;
}

let reminders = loadReminderSettings();

const isApp = () => ['standalone', 'window-controls-overlay', 'minimal-ui']
  .some(m => window.matchMedia(`(display-mode: ${m})`).matches);
const notifySupported = () => 'Notification' in window;
const idleSupported = () => 'IdleDetector' in window;

// ---- Install (the app's service worker lives in admin/, so the app covers the editor only) ----
let installPrompt = null;
let swReg = null;

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', ev => {
    if(ev.data && ev.data.type === 'open-reminder') showReminderPopup(true);
  });
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  renderAppSection();
});
window.addEventListener('appinstalled', () => { installPrompt = null; renderAppSection(); });

async function installApp(){
  if(!installPrompt) return;
  installPrompt.prompt();
  try{ await installPrompt.userChoice; }catch(e){}
  installPrompt = null;
  renderAppSection();
}

// ---- What's due ----
// Open tasks due within the look-ahead (overdue ones included), soonest first; plus open tasks with no due date.
function reminderItems(){
  const last = isoAddDays(localToday(), reminders.lookAhead);
  const open = allTasks().filter(x => taskGroupOf(x.a) !== 'Complete');
  const due = open.filter(x => x.a.dateDue && x.a.dateDue <= last)
    .sort((x, y) => x.a.dateDue.localeCompare(y.a.dateDue) || textCmp(customerKey(x.c), customerKey(y.c)) || textCmp(x.c.serial, y.c.serial));
  return {due, overdue: due.filter(x => isTaskOverdue(x.a)).length, noDue: open.filter(x => !x.a.dateDue).length};
}

MEASURES['task-nodue'] = {label: 'Open Tasks with no due date', kind: 'task',
  items: () => tasksWhere(a => taskGroupOf(a) !== 'Complete' && !a.dateDue)};

function dueWhen(iso){
  const n = daysUntil(iso);
  if(n < 0) return `<span class="pill pill-overdue">Overdue</span> ${escapeHtml(fmtDate(iso))}`;
  if(n === 0) return '<span class="rem-today">Today</span>';
  if(n === 1) return 'Tomorrow';
  return escapeHtml(new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'}));
}

const dayWord = n => n === 1 ? 'day' : 'days';
const aheadText = () => `the next ${reminders.lookAhead} ${dayWord(reminders.lookAhead)}`;

// "Customer · SN 1234 · aircraft" (aircraft only when the device has more than one).
function reminderWhere(c){
  return [customerKey(c), 'SN ' + (c.serial || '—'), !isDevice(c) && multiProject(c.deviceId) ? shortProjectLabel(c) : ''].filter(Boolean).join(' · ');
}

// ---- The reminder pop-up ----
let reminderActions = [];

function showReminderPopup(fromClick){
  if(!dataLoaded) return;
  const {due, noDue} = reminderItems();
  reminderActions = [];
  const row = (act, left, right) => {
    reminderActions.push(act);
    return `<button class="rem-row" type="button" onclick="openReminderRow(${reminderActions.length - 1})"><span class="rem-main">${left}</span><span class="rem-side">${right}</span></button>`;
  };
  const rows = due.map(x => row({type: 'task', ownerId: x.owner.id, taskId: x.a.id, aircraftId: airId(x)},
    `<span class="rem-task">${escapeHtml(taskLabel(x.a))}</span><span class="rem-where">${escapeHtml(reminderWhere(x.c))}</span>`, dueWhen(x.a.dateDue)));
  if(reminders.noDueLine && noDue) rows.push(row({type: 'list', key: 'task-nodue'}, '<span class="rem-task rem-muted">No due date</span>', `${noDue} open ${noDue === 1 ? 'task' : 'tasks'}`));
  $('rem-title').textContent = `Due in ${aheadText()}`;
  $('rem-when').textContent = new Date().toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})
    + ' · ' + new Date().toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
  $('rem-list').innerHTML = due.length || rows.length
    ? (due.length ? '' : `<p class="rem-empty">Nothing due in ${aheadText()}.</p>`) + rows.join('')
    : `<p class="rem-empty">Nothing due in ${aheadText()}.</p>`;
  openModalEl('reminder-modal-bg', fromClick ? 'rem-dismiss' : null);
}

function openReminderRow(i){
  const act = reminderActions[i];
  if(!act) return;
  closeModalEl('reminder-modal-bg');
  if(act.type === 'list') return navigate({type: 'list', key: act.key});
  openTask(act.ownerId, act.taskId, null, null, act.aircraftId);
}

// ---- Windows notification and taskbar badge ----
let idleDetector = null;
let screenLocked = false;
let heldNotification = null;

async function startLockWatch(){
  if(idleDetector || !idleSupported()) return;
  try{
    const st = await navigator.permissions.query({name: 'idle-detection'});
    if(st.state !== 'granted') return;
    const d = new IdleDetector();
    d.addEventListener('change', () => {
      screenLocked = d.screenState === 'locked';
      if(!screenLocked && heldNotification){ const n = heldNotification; heldNotification = null; postNotification(n); }
    });
    await d.start({threshold: 60000});
    idleDetector = d;
    screenLocked = d.screenState === 'locked';
  }catch(e){ /* can't tell when the screen is locked; notifications show as Windows allows */ }
}

async function askLockPermission(){
  if(!idleSupported()) return false;
  try{
    const r = await IdleDetector.requestPermission();
    if(r === 'granted'){ await startLockWatch(); return true; }
  }catch(e){}
  return false;
}

async function lockWatchState(){
  if(!idleSupported()) return 'unsupported';
  try{ return (await navigator.permissions.query({name: 'idle-detection'})).state; }catch(e){ return 'unsupported'; }
}

function notificationFor(){
  const {due, overdue} = reminderItems();
  if(!due.length) return null;
  const soon = due.length - overdue;
  const parts = [];
  if(overdue) parts.push(`${overdue} overdue`);
  if(soon) parts.push(`${soon} due in ${aheadText()}`);
  const title = `${countLabel(due.length, 'task', 'tasks')}: ${parts.join(', ')}`;
  const lines = due.slice(0, 3).map(x => `${taskLabel(x.a)} (${daysUntil(x.a.dateDue) < 0 ? 'overdue' : daysUntil(x.a.dateDue) === 0 ? 'today' : fmtDate(x.a.dateDue)})`);
  if(due.length > 3) lines.push(`and ${due.length - 3} more`);
  return {title, body: lines.join('\n')};
}

async function postNotification(n){
  if(!n || !notifySupported() || Notification.permission !== 'granted') return;
  const opts = {body: n.body, tag: 'cert-tracker-reminder', renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-96.png'};
  try{
    const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
    if(reg){ await reg.showNotification(n.title, opts); return; }
  }catch(e){}
  try{ const x = new Notification(n.title, opts); x.onclick = () => { window.focus(); showReminderPopup(true); x.close(); }; }catch(e){}
}

function updateBadge(){
  if(!('setAppBadge' in navigator)) return;
  const n = reminders.enabled && reminders.badge && dataLoaded && isApp() ? reminderItems().due.length : 0;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ---- When a reminder fires ----
function reminderDueNow(){
  if(!reminders.enabled || !isApp() || !dataLoaded) return false;
  const now = new Date();
  if(!reminders.days.includes(now.getDay())) return false;
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  return hhmm >= reminders.time && reminders.lastFired !== localToday();
}

let firing = false;
async function reminderTick(){
  updateBadge();
  if(firing) return;
  reminders = loadReminderSettings();   // another window may have fired or changed settings
  if(!reminderDueNow()) return;
  firing = true;
  try{
    saveReminderSettings({...reminders, lastFired: localToday()});
    try{ await refreshFromGitHub(); }catch(e){}
    updateBadge();
    showReminderPopup();
    if(reminders.notify){
      const n = notificationFor();
      if(n && !reminders.lockScreen && screenLocked) heldNotification = n;
      else postNotification(n);
    }
  }finally{ firing = false; }
}

// setData runs whenever the projects data loads or changes: keep the badge current.
const setDataBeforeReminders = setData;
setData = function(data){ setDataBeforeReminders(data); setTimeout(updateBadge, 0); };

setInterval(reminderTick, 30 * 1000);
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') reminderTick(); });

// ---- Startup prompt (installed app only) ----
function startupPromptDue(){
  if(!isApp() || reminders.enabled || reminders.prompt === 'never') return false;
  if(reminders.prompt === 'snoozed' && reminders.snoozeUntil && new Date() < new Date(reminders.snoozeUntil)) return false;
  return true;
}

function maybeShowStartupPrompt(){
  if(!startupPromptDue()) return;
  // Wait for the data to load and for any other form (such as a data conversion) to close.
  const tryShow = () => {
    if(!dataLoaded || document.querySelector('.modal-bg.open')) return setTimeout(tryShow, 1000);
    if(!startupPromptDue()) return;
    const r = reminders, days = dayListText(r.days);
    $('sp-question').textContent = `Enable ${days === 'weekdays' ? 'weekday' : days === 'every day' ? 'daily' : days} reminders at ${timeText(r.time)} listing tasks due in ${aheadText()}?`;
    openModalEl('startup-modal-bg', 'sp-enable');
  };
  tryShow();
}

async function enableFromPrompt(){
  // Screen-lock detection is asked first: Edge and Chrome only show these requests right after a click.
  if(!reminders.lockScreen) await askLockPermission();
  let notify = true;
  if(notifySupported() && Notification.permission === 'default'){
    try{ notify = (await Notification.requestPermission()) === 'granted'; }catch(e){ notify = false; }
  }else if(!notifySupported() || Notification.permission === 'denied') notify = false;
  saveReminderSettings({...reminders, enabled: true, notify, prompt: 'ask', snoozeUntil: '',
    // the first reminder waits for the next reminder time, not straight away
    lastFired: localToday()});
  closeModalEl('startup-modal-bg');
  updateBadge();
  showBanner(notify ? 'success' : 'info', notify
    ? `Reminders are on: ${dayListText(reminders.days)} at ${timeText(reminders.time)}. Change them in Admin, Reminder settings.`
    : 'Reminders are on, but Windows notifications were not allowed, so reminders show in the app only. Change this in Admin, Reminder settings.');
  setTimeout(hideBanner, 6000);
}

function snoozeFromPrompt(){
  const until = new Date();
  until.setDate(until.getDate() + SNOOZE_DAYS);
  saveReminderSettings({...reminders, prompt: 'snoozed', snoozeUntil: until.toISOString()});
  closeModalEl('startup-modal-bg');
}

function neverFromPrompt(){
  saveReminderSettings({...reminders, prompt: 'never', snoozeUntil: ''});
  closeModalEl('startup-modal-bg');
}

function timeText(hhmm){
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
}

function dayListText(days){
  const s = [...days].sort((a, b) => a - b).join(',');
  if(s === '1,2,3,4,5') return 'weekdays';
  if(s === '0,1,2,3,4,5,6') return 'every day';
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => DAY_NAMES[d]).join(', ');
}

// ---- Reminder settings ----
async function openReminderSettings(){
  const s = reminders;
  $('rs-enabled').checked = s.enabled;
  $('rs-time').value = s.time;
  document.querySelectorAll('#rs-days input').forEach(cb => { cb.checked = s.days.includes(Number(cb.value)); });
  $('rs-ahead').value = s.lookAhead;
  $('rs-nodue').checked = s.noDueLine;
  $('rs-notify').checked = s.notify;
  $('rs-badge').checked = s.badge;
  $('rs-lock').checked = s.lockScreen;
  $('rs-err').style.display = 'none';
  refreshReminderForm();
  await refreshPermissionNotes();
  if($('admin-modal-bg').classList.contains('open')) closeModalEl('admin-modal-bg');
  if($('reminder-modal-bg').classList.contains('open')) closeModalEl('reminder-modal-bg');
  openModalEl('reminder-settings-bg');
}

function refreshReminderForm(){
  const on = $('rs-enabled').checked;
  $('rs-details').classList.toggle('rs-off', !on);
  $('rs-details').querySelectorAll('input').forEach(i => { i.disabled = !on; });
  $('rs-lock-row').classList.toggle('rs-off', !on || !$('rs-notify').checked);
}

async function refreshPermissionNotes(){
  const notes = [];
  if(!isApp()) notes.push('Reminders show in the Certification Tracker Editor app. Install it from Admin to get them.');
  if(!notifySupported()) notes.push('This browser can’t show Windows notifications.');
  else if(Notification.permission === 'denied') notes.push('Notifications are blocked for the tracker in this browser. Allow them in the app’s menu (…), App info, then Site permissions, or in the browser’s settings for this site.');
  $('rs-perm').innerHTML = notes.map(n => `<p>${escapeHtml(n)}</p>`).join('');
  $('rs-perm').hidden = !notes.length;
  const lock = await lockWatchState();
  $('rs-lock-allow').hidden = !(lock === 'prompt' && !$('rs-lock').checked);
  $('rs-lock-denied').hidden = !(lock === 'denied' && !$('rs-lock').checked);
}

async function saveReminderForm(){
  const days = [...document.querySelectorAll('#rs-days input')].filter(cb => cb.checked).map(cb => Number(cb.value));
  const ahead = Math.round(Number($('rs-ahead').value));
  const time = $('rs-time').value;
  const enabled = $('rs-enabled').checked;
  const err = t => { $('rs-err').textContent = t; $('rs-err').style.display = 'block'; };
  if(enabled && !days.length) return err('Choose at least one day.');
  if(enabled && !/^\d{2}:\d{2}$/.test(time)) return err('Enter a reminder time.');
  if(enabled && !(ahead >= 1 && ahead <= 30)) return err('Look ahead must be between 1 and 30 days.');
  let notify = $('rs-notify').checked;
  if(enabled && notify && notifySupported() && Notification.permission === 'default'){
    try{ notify = (await Notification.requestPermission()) === 'granted'; }catch(e){ notify = false; }
  }
  const wasEnabled = reminders.enabled;
  const next = {...reminders, enabled, days: days.length ? days : reminders.days, time: time || reminders.time,
    lookAhead: ahead >= 1 && ahead <= 30 ? ahead : reminders.lookAhead, noDueLine: $('rs-nodue').checked,
    notify, badge: $('rs-badge').checked, lockScreen: $('rs-lock').checked};
  if(enabled && !wasEnabled){ next.prompt = 'ask'; next.snoozeUntil = ''; next.lastFired = localToday(); }
  // A changed time later today should still fire today.
  if(enabled && wasEnabled && next.time !== reminders.time && next.lastFired === localToday()){
    const now = new Date(), hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if(next.time > hhmm) next.lastFired = '';
  }
  saveReminderSettings(next);
  closeModalEl('reminder-settings-bg');
  updateBadge();
  showBanner('success', enabled ? `Reminder settings saved: ${dayListText(next.days)} at ${timeText(next.time)}.` : 'Reminders are off.');
  setTimeout(hideBanner, 3500);
}

// ---- Admin panel: the app and reminders ----
function renderAppSection(){
  const el = $('admin-app-body');
  if(!el) return;
  const r = reminders;
  const status = r.enabled ? `On: ${dayListText(r.days)} at ${timeText(r.time)}, looking ${r.lookAhead} ${dayWord(r.lookAhead)} ahead.` : 'Off.';
  const install = isApp()
    ? '<p>You’re using the Certification Tracker Editor app. To open it when you sign in to Windows, turn on Start app when you sign in in the app’s settings (in Edge: edge://apps, then the app’s … menu).</p>'
    : installPrompt
      ? '<p>Install the editor as its own app, with its own window and taskbar icon. Your access key carries over.</p><button class="btn-text" id="admin-install-btn" type="button">Install app</button>'
      : '<p>To install the editor as its own app, use Install in the address bar, or the browser menu (…), Apps, Install this site as an app. If it’s already installed, open it from the Start menu.</p>';
  el.innerHTML = `${install}<p class="admin-note">Reminders: ${escapeHtml(status)}</p><button class="btn-text" id="admin-reminders-btn" type="button">Reminder settings</button>`;
  const ib = $('admin-install-btn');
  if(ib) ib.addEventListener('click', installApp);
  $('admin-reminders-btn').addEventListener('click', openReminderSettings);
}

const openAdminBeforeReminders = openAdmin;
$('admin-btn').removeEventListener('click', openAdmin);
openAdmin = function(){ reminders = loadReminderSettings(); renderAppSection(); openAdminBeforeReminders(); };
$('admin-btn').addEventListener('click', openAdmin);

$('sp-enable').addEventListener('click', enableFromPrompt);
$('sp-snooze').addEventListener('click', snoozeFromPrompt);
$('sp-never').addEventListener('click', neverFromPrompt);
$('rem-settings').addEventListener('click', e => { e.preventDefault(); openReminderSettings(); });
$('rs-enabled').addEventListener('change', refreshReminderForm);
$('rs-notify').addEventListener('change', refreshReminderForm);
$('rs-lock').addEventListener('change', refreshPermissionNotes);
$('rs-lock-allow-btn').addEventListener('click', async () => { await askLockPermission(); refreshPermissionNotes(); });
$('rs-save').addEventListener('click', saveReminderForm);

// A notification clicked while the app was closed opens it at #reminder.
if(location.hash === '#reminder'){
  history.replaceState(null, '', location.pathname + location.search);
  const openWhenLoaded = () => dataLoaded ? showReminderPopup(true) : setTimeout(openWhenLoaded, 500);
  openWhenLoaded();
}

startLockWatch();
maybeShowStartupPrompt();
setTimeout(reminderTick, 3000);
