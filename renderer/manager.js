// ── macOS-style zoom open/close ──
// The window stays hidden until the first data render finishes (main waits for
// our 'manager-ready'), then 'zoom-open' starts the animation over a static,
// fully-built DOM — no mid-animation layout, no dropped frames. Closing plays
// a short zoom-out before the window actually closes.
const managerRoot = document.getElementById('manager');

managerRoot.addEventListener('animationend', (e) => {
  if (e.target !== managerRoot) return;
  if (e.animationName === 'zoomIn') {
    // Drop the transform/compositor layer once open. Electron cached "no
    // draggable region" while the panel was transformed and only recomputes on
    // a layout change, so toggle the header's app-region to force a fresh
    // DraggableRegionsChanged — otherwise the window can't be moved until a
    // manual resize.
    managerRoot.classList.remove('zoom-in');
    managerRoot.classList.add('zoom-done');
    const header = document.getElementById('manager-header');
    if (header) {
      header.style.webkitAppRegion = 'no-drag';
      void header.offsetWidth; // flush layout
      requestAnimationFrame(() => {
        header.style.webkitAppRegion = 'drag';
      });
    }
  } else if (e.animationName === 'zoomOut') {
    window.heatmapAPI.closeManager();
  }
});

window.heatmapAPI.onZoomOpen(() => {
  managerRoot.classList.add('zoom-in');
});

// Never stay invisible if the open handshake fails for any reason.
setTimeout(() => {
  if (!managerRoot.classList.contains('zoom-in') && !managerRoot.classList.contains('zoom-done')) {
    managerRoot.classList.add('zoom-done');
  }
}, 2000);

let isClosing = false;
function closeManagerAnimated() {
  if (isClosing) return;
  isClosing = true;
  flushPendingAutosave(); // the save IPC lands in main before the window closes
  managerRoot.classList.remove('zoom-in', 'zoom-done');
  managerRoot.classList.add('zoom-out');
  setTimeout(() => window.heatmapAPI.closeManager(), 350); // animationend fallback
}

const FIELDS = [
  'job_title', 'company', 'location', 'applying_date', 'job_type',
  'status', 'resume_version', 'contact', 'description', 'notes',
];

// Application journey stages, in order. Stored as a comma-separated list to
// match the sheet's free-form status column.
const STATUS_OPTIONS = [
  'Applied', 'Pre-selected', 'HR Call', 'HR Screen', 'Online Logic test',
  'Online coding Test', 'Tech Interview', 'Manager Interview', 'Final Interview',
  'Offer', 'Rejected',
];

const tbody = document.getElementById('apps-tbody');
const editor = document.getElementById('editor');
const emptyState = document.getElementById('empty-state');
const searchInput = document.getElementById('search');
const countBadge = document.getElementById('count-badge');
const syncStatus = document.getElementById('sync-status');
const deleteBtn = document.getElementById('btn-delete');

let applications = [];
let allInterviews = []; // every interview, for list pills and the agenda
let upcomingByApp = new Map(); // application_id → next relevant interview
let selectedId = null;
let currentFilter = 'all';
let currentSort = 'newest';

const STALE_DAYS = 14;
const AUTO_REJECT_DAYS = 100;

function el(id) {
  return document.getElementById(id);
}

async function loadApplications() {
  [applications, allInterviews] = await Promise.all([
    window.heatmapAPI.listApplications(),
    window.heatmapAPI.listAllInterviews(),
  ]);
  rebuildUpcomingByApp();
  buildFilters();
  renderStats();
  renderAgenda();
  renderAutoRejectBanner();
  render();
}

// For each application, the interview that matters in the list: the next
// scheduled one still marked upcoming (overdue ones stay visible — they need
// an outcome logged).
function rebuildUpcomingByApp() {
  upcomingByApp = new Map();
  for (const iv of allInterviews) {
    if (iv.outcome !== 'upcoming' || !iv.scheduled_at) continue;
    const cur = upcomingByApp.get(iv.application_id);
    if (!cur || iv.scheduled_at < cur.scheduled_at) upcomingByApp.set(iv.application_id, iv);
  }
}

// The list as currently displayed: filter + search + sort applied.
function visibleList() {
  const query = searchInput.value.trim().toLowerCase();
  let list = applications.slice();

  if (currentFilter === 'followup') {
    list = list.filter(needsFollowup);
  } else if (currentFilter !== 'all') {
    list = list.filter((a) => outcomeOf(a) === currentFilter);
  }

  if (query) {
    list = list.filter((a) =>
      FIELDS.some((f) => String(a[f] || '').toLowerCase().includes(query))
    );
  }

  return sortList(list);
}

function render() {
  const list = visibleList();

  countBadge.textContent = `${applications.length}`;
  updateActiveFilterUI();

  tbody.innerHTML = '';
  const isEmpty = list.length === 0;
  emptyState.classList.toggle('hidden', !isEmpty);
  if (isEmpty) {
    emptyState.innerHTML = applications.length === 0
      ? 'No applications yet. Click <b>+ New</b> to add one.'
      : 'No applications match this view.';
  }

  for (const app of list) {
    const tr = document.createElement('tr');
    if (app.id === selectedId) tr.classList.add('selected');
    tr.dataset.id = app.id;

    const followup = needsFollowup(app)
      ? '<span class="followup-badge">Follow up</span>'
      : '';

    tr.innerHTML = `
      <td class="title-cell">${escapeHtml(app.job_title) || '—'}</td>
      <td>${escapeHtml(app.company) || '—'}</td>
      <td>${escapeHtml(formatDisplayDate(app.applying_date)) || '—'}${followup}${ivPillHtml(app)}</td>
      <td>${renderStatusPills(app)}</td>
    `;
    tr.addEventListener('click', () => openEditor(app));
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dates are stored as ISO (YYYY-MM-DD) but shown as e.g. "1-Jun-2026". Anything
// that isn't a clean ISO date is left untouched.
function formatDisplayDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return iso || '';
  return `${parseInt(m[3], 10)}-${MONTHS_ABBR[parseInt(m[2], 10) - 1]}-${m[1]}`;
}

function splitStatus(status) {
  return String(status || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Show the final/outcome stage as the main pill, with a count of the rest.
// Silent applications past the threshold render as a derived "Rejected" pill.
function renderStatusPills(app) {
  const parts = splitStatus(app.status);

  if (isAutoRejected(app)) {
    const extra = parts.length ? `<span class="pill-extra">+${parts.length}</span>` : '';
    return `<span class="status-pill pill-auto" title="No response for ${AUTO_REJECT_DAYS}+ days — auto-rejected">Rejected</span>${extra}`;
  }

  if (parts.length === 0) return '\u2014';

  const last = parts[parts.length - 1];
  let cls = 'status-pill';
  if (/reject/i.test(last)) cls += ' pill-rejected';
  else if (/offer/i.test(last)) cls += ' pill-offer';

  const extra = parts.length > 1 ? `<span class="pill-extra">+${parts.length - 1}</span>` : '';
  return `<span class="${cls}">${escapeHtml(last)}</span>${extra}`;
}

// ── Outcome derivation ──
// Stage groups (lowercased) used to classify where an application got to.
const SCREEN_STAGES = ['hr call', 'hr screen'];
const INTERVIEW_STAGES = [
  'online logic test', 'coding test', 'tech interview',
  'manager interview', 'final interview',
];

function statusParts(app) {
  return splitStatus(app.status).map((s) => s.toLowerCase());
}

function hasAny(parts, list) {
  return parts.some((p) => list.some((s) => p.includes(s)));
}

const hasOffer = (parts) => parts.some((p) => p.includes('offer'));
const hasReject = (parts) => parts.some((p) => p.includes('reject'));
const reachedInterview = (parts) => hasOffer(parts) || hasAny(parts, INTERVIEW_STAGES);
const reachedScreen = (parts) => reachedInterview(parts) || hasAny(parts, SCREEN_STAGES);
const responded = (parts) => reachedScreen(parts) || hasReject(parts);

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// A would-be active application gone silent past the threshold is treated as
// rejected. This is derived only — the stored status and sheet are untouched.
function isAutoRejected(app) {
  const parts = statusParts(app);
  if (hasOffer(parts) || hasReject(parts) || reachedScreen(parts)) return false;
  const days = daysSince(app.applying_date);
  return days != null && days >= AUTO_REJECT_DAYS;
}

// Final outcome bucket, in priority order.
function outcomeOf(app) {
  const parts = statusParts(app);
  if (hasOffer(parts)) return 'offer';
  if (hasReject(parts)) return 'rejected';
  if (reachedScreen(parts)) return 'interviewing';
  if (isAutoRejected(app)) return 'rejected';
  return 'active';
}

// Stale = still just "applied", no response, old enough to chase, but not yet
// past the auto-reject threshold. Only nudge when there's actually a contact to
// reach out to — a follow-up with no one to follow up with is just noise.
function needsFollowup(app) {
  if (outcomeOf(app) !== 'active') return false;
  if (!app.contact || !String(app.contact).trim()) return false;
  const days = daysSince(app.applying_date);
  return days != null && days >= STALE_DAYS;
}

// ── Auto-reject banner ──
// Surfaces how many applications were treated as rejected purely from silence
// past the threshold (derived only — stored status and the sheet are untouched).
// Only nags when there's something new: the acknowledged count is persisted, so
// dismissing sticks across window opens and the banner reappears only once a
// meaningful number of additional applications have gone silent.
const AUTO_REJECT_NOTIFY_STEP = 3; // new auto-rejections needed to re-show after dismiss
let autoRejectCount = 0;

function renderAutoRejectBanner() {
  const banner = el('autoreject-banner');
  autoRejectCount = applications.filter(isAutoRejected).length;

  const ackRaw = localStorage.getItem('autoRejectAck');
  let ack = ackRaw == null ? null : Number(ackRaw);

  // If some were resolved (count dropped below what was acknowledged), lower the
  // baseline so a later rise re-triggers correctly.
  if (ack != null && autoRejectCount < ack) {
    ack = autoRejectCount;
    localStorage.setItem('autoRejectAck', String(ack));
  }

  // First time: show for any auto-rejection. After a dismissal at N: only show
  // again once the count reaches N + step.
  const threshold = ack == null ? 1 : ack + AUTO_REJECT_NOTIFY_STEP;
  if (autoRejectCount < threshold) {
    banner.classList.add('hidden');
    return;
  }

  el('autoreject-text').textContent =
    `${autoRejectCount} application${autoRejectCount === 1 ? '' : 's'} auto-marked rejected after ${AUTO_REJECT_DAYS} days of no response.`;
  banner.classList.remove('hidden');
}

el('autoreject-view').addEventListener('click', () => {
  currentFilter = 'rejected';
  render();
});

el('autoreject-dismiss').addEventListener('click', () => {
  localStorage.setItem('autoRejectAck', String(autoRejectCount));
  el('autoreject-banner').classList.add('hidden');
});

// Per-application flag at the top of the editor. Distinct from an actual
// "Rejected" status — isAutoRejected already excludes apps whose status contains
// "reject", so this only marks the derived, silence-based case.
function updateAutoRejectFlag(app) {
  const flag = el('autoreject-flag');
  if (!app || !isAutoRejected(app)) {
    flag.classList.add('hidden');
    return;
  }
  const days = daysSince(app.applying_date);
  const dayText = days != null ? `${days} days` : `${AUTO_REJECT_DAYS}+ days`;
  el('autoreject-flag-text').textContent = `Auto-rejected · ${dayText} with no response`;
  flag.title =
    `Derived automatically: the status never progressed for ${AUTO_REJECT_DAYS}+ days since you applied. ` +
    `Your saved status and the Google Sheet are untouched — set a status to override.`;
  flag.classList.remove('hidden');
}

// ── Insights ──
function computeStats() {
  const total = applications.length;
  let active = 0, interviewing = 0, offers = 0, respondedCount = 0;
  let screenReach = 0, interviewReach = 0, offerReach = 0;

  for (const a of applications) {
    const parts = statusParts(a);
    switch (outcomeOf(a)) {
      case 'active': active++; break;
      case 'interviewing': interviewing++; break;
      case 'offer': offers++; break;
    }
    if (responded(parts)) respondedCount++;
    if (reachedScreen(parts)) screenReach++;
    if (reachedInterview(parts)) interviewReach++;
    if (hasOffer(parts)) offerReach++;
  }

  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return {
    total, active, interviewing, offers,
    responseRate: pct(respondedCount),
    interviewRate: pct(interviewReach),
    funnel: [
      ['Applied', total],
      ['Screen', screenReach],
      ['Interview', interviewReach],
      ['Offer', offerReach],
    ],
  };
}

function metricHtml(value, label, cls = '') {
  return `<div class="metric"><div class="metric-value ${cls}">${value}</div><div class="metric-label">${label}</div></div>`;
}

function renderStats() {
  const s = computeStats();
  el('metrics').innerHTML = [
    metricHtml(s.total, 'Total'),
    metricHtml(s.active, 'Active'),
    metricHtml(s.interviewing, 'Interviewing', 'accent-blue'),
    metricHtml(s.offers, 'Offers', 'accent-green'),
    metricHtml(`${s.responseRate}%`, 'Response'),
    metricHtml(`${s.interviewRate}%`, 'Interview'),
  ].join('');

  const max = s.funnel[0][1] || 1;
  el('funnel').innerHTML = s.funnel
    .map(([name, count]) => {
      const w = `${Math.round((count / max) * 100)}%`;
      const share = s.total ? Math.round((count / s.total) * 100) : 0;
      return `
        <div class="funnel-row">
          <span class="funnel-name">${name}</span>
          <div class="funnel-track"><div class="funnel-fill" style="width:0" data-w="${w}"></div></div>
          <span class="funnel-count">${count} · ${share}%</span>
        </div>`;
    })
    .join('');

  applyFunnelWidths();
}

function applyFunnelWidths() {
  if (el('stats-panel').classList.contains('collapsed')) return;
  requestAnimationFrame(() => {
    el('funnel').querySelectorAll('.funnel-fill').forEach((f) => {
      f.style.width = f.dataset.w;
    });
  });
}

// ── Filters + sort ──
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'interviewing', label: 'Interviewing' },
  { key: 'offer', label: 'Offers' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'followup', label: 'Follow-up' },
];

function buildFilters() {
  const counts = { all: applications.length, active: 0, interviewing: 0, offer: 0, rejected: 0, followup: 0 };
  for (const a of applications) {
    counts[outcomeOf(a)]++;
    if (needsFollowup(a)) counts.followup++;
  }

  el('filters').innerHTML = FILTERS.map((f) => `
    <button class="filter-chip${f.key === currentFilter ? ' active' : ''}" data-filter="${f.key}">
      ${f.label}<span class="chip-count">${counts[f.key]}</span>
    </button>`).join('');

  el('filters').querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      render();
    });
  });
}

function updateActiveFilterUI() {
  el('filters').querySelectorAll('.filter-chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === currentFilter);
  });
}

function outcomeRank(app) {
  return { offer: 0, interviewing: 1, active: 2, rejected: 3 }[outcomeOf(app)];
}

function sortList(list) {
  const cmp = {
    newest: (a, b) => (b.applying_date || '').localeCompare(a.applying_date || ''),
    oldest: (a, b) => (a.applying_date || '').localeCompare(b.applying_date || ''),
    company: (a, b) => (a.company || '').localeCompare(b.company || ''),
    status: (a, b) => outcomeRank(a) - outcomeRank(b),
  }[currentSort] || (() => 0);
  return list.sort(cmp);
}

// ── Toast ──
let toastTimer;
function toast(message, isError = false) {
  const t = el('toast');
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  void t.offsetWidth; // reflow so the transition replays
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openEditor(app) {
  flushPendingAutosave(); // don't lose pending edits when switching rows
  editSession++;
  selectedId = app ? app.id : null;
  el('f-id').value = app ? app.id : '';

  for (const f of FIELDS) {
    el(`f-${f}`).value = app && app[f] != null ? app[f] : '';
  }
  setStatus(app && app.status != null ? app.status : '');
  closeStatusPanel();
  setJobType(app && app.job_type != null ? app.job_type : '');
  closeJobTypePanel();

  deleteBtn.classList.toggle('hidden', !app);
  el('btn-export-one').classList.toggle('hidden', !app);
  syncStatus.textContent = '';
  syncStatus.className = 'field-hint';
  editor.classList.remove('hidden');
  el('editor-resizer').classList.remove('hidden');
  updateAutoRejectFlag(app);
  lastSavedSnapshot = formSnapshot();
  loadEditorInterviews(app ? app.id : null);
  render();
  el('f-job_title').focus();
}

function closeEditor() {
  flushPendingAutosave(); // closing never discards edits
  selectedId = null;
  editor.classList.add('hidden');
  el('editor-resizer').classList.add('hidden');
  render();
}

document.getElementById('btn-new').addEventListener('click', () => openEditor(null));
document.getElementById('btn-cancel').addEventListener('click', closeEditor);
searchInput.addEventListener('input', render);

document.getElementById('btn-close-manager').addEventListener('click', closeManagerAnimated);

document.getElementById('btn-stats').addEventListener('click', () => {
  const collapsed = el('stats-panel').classList.toggle('collapsed');
  el('btn-stats').classList.toggle('active', !collapsed);
  if (!collapsed) {
    applyFunnelWidths();
    el('agenda-panel').classList.add('collapsed');
    el('btn-agenda').classList.remove('active');
  }
});

// ── Sort dropdown ──
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'company', label: 'Company' },
  { value: 'status', label: 'Status' },
];

const sortDd = el('sort-dd');
const sortControl = el('sort-control');
const sortPanel = el('sort-panel');

function buildSortPanel() {
  sortPanel.innerHTML = '';
  for (const opt of SORT_OPTIONS) {
    const row = document.createElement('div');
    row.className = 'dd-option' + (opt.value === currentSort ? ' selected' : '');
    row.textContent = opt.label;
    row.addEventListener('click', () => {
      currentSort = opt.value;
      el('sort-value').textContent = opt.label;
      closeSortPanel();
      buildSortPanel();
      render();
    });
    sortPanel.appendChild(row);
  }
}

function closeSortPanel() {
  sortPanel.classList.add('hidden');
  sortDd.classList.remove('open');
}

sortControl.addEventListener('click', () => {
  const isOpen = !sortPanel.classList.contains('hidden');
  sortPanel.classList.toggle('hidden', isOpen);
  sortDd.classList.toggle('open', !isOpen);
});

sortControl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    sortControl.click();
  } else if (e.key === 'Escape') {
    closeSortPanel();
  }
});

document.addEventListener('click', (e) => {
  if (!sortDd.contains(e.target)) closeSortPanel();
});

buildSortPanel();

// ── Keyboard shortcuts ──
document.addEventListener('keydown', (e) => {
  if (!confirmOverlay.classList.contains('hidden')) return; // dialog has its own keys

  if (e.key === 'Escape') {
    if (!sortPanel.classList.contains('hidden')) closeSortPanel();
    else if (!statusPanel.classList.contains('hidden')) closeStatusPanel();
    else if (!jobtypePanel.classList.contains('hidden')) closeJobTypePanel();
    else if (!editor.classList.contains('hidden')) closeEditor();
    else closeManagerAnimated();
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openEditor(null);
  } else if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// Themed confirmation dialog, returns a promise resolving true/false.
const confirmOverlay = el('confirm-overlay');
function confirmDialog() {
  return new Promise((resolve) => {
    confirmOverlay.classList.remove('hidden');

    const cleanup = (result) => {
      confirmOverlay.classList.add('hidden');
      el('confirm-ok').removeEventListener('click', onOk);
      el('confirm-cancel').removeEventListener('click', onCancel);
      confirmOverlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => {
      if (e.target === confirmOverlay) cleanup(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    };

    el('confirm-ok').addEventListener('click', onOk);
    el('confirm-cancel').addEventListener('click', onCancel);
    confirmOverlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    el('confirm-ok').focus();
  });
}

let isSaving = false;
const saveBtn = el('btn-save-app');

// ── Autosave ──
// Saves shortly after the last edit so forgetting to click Save can't lose
// work. 2.5s is long enough not to fire mid-thought on brief typing pauses
// (each save also syncs to the sheet), short enough that closing right after
// typing still catches it — and closing/switching flushes pending edits anyway.
const AUTOSAVE_DELAY = 2500;
let autosaveTimer = null;
let lastSavedSnapshot = '';
let editSession = 0; // invalidates in-flight saves once the form is repopulated

function formSnapshot() {
  return FIELDS.map((f) => el(`f-${f}`).value.trim()).join('');
}

function formIsDirty() {
  return formSnapshot() !== lastSavedSnapshot;
}

// Don't create a record for a new application until it has something to
// identify it by — avoids ghost rows from an opened-then-abandoned form.
function formIsSaveable() {
  return !!(el('f-id').value || el('f-job_title').value.trim() || el('f-company').value.trim());
}

function scheduleAutosave() {
  if (editor.classList.contains('hidden')) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (isSaving) { scheduleAutosave(); return; } // retry once in-flight save ends
    if (editor.classList.contains('hidden') || !formIsDirty() || !formIsSaveable()) return;
    persistForm({ auto: true });
  }, AUTOSAVE_DELAY);
}

// Save immediately if edits are pending; called right before the form is
// closed or repopulated with another application. Reads the form
// synchronously, so the values are captured before they're replaced.
function flushPendingAutosave() {
  clearTimeout(autosaveTimer);
  if (editor.classList.contains('hidden') || isSaving) return;
  if (formIsDirty() && formIsSaveable()) persistForm({ auto: true });
}

async function persistForm({ auto = false } = {}) {
  if (isSaving) return;
  isSaving = true;
  saveBtn.disabled = true;
  clearTimeout(autosaveTimer);

  const session = editSession;
  const appData = { id: el('f-id').value || undefined };
  for (const f of FIELDS) appData[f] = el(`f-${f}`).value.trim() || null;
  const snapshot = formSnapshot();

  syncStatus.textContent = auto ? 'Auto-saving…' : 'Saving…';
  syncStatus.className = 'field-hint';

  try {
    const { id, syncError } = await window.heatmapAPI.saveApplication(appData);
    // Skip form updates if the editor moved on to another application (or
    // closed) while the save was in flight.
    const formStillCurrent = session === editSession && !editor.classList.contains('hidden');

    if (formStillCurrent) {
      lastSavedSnapshot = snapshot;
      selectedId = id;
      el('f-id').value = id;
      deleteBtn.classList.remove('hidden');
      el('btn-export-one').classList.remove('hidden');
    }
    await loadApplications();

    if (!auto) {
      syncStatus.textContent = '';
      toast(syncError ? 'Saved locally · sheet sync failed' : 'Application saved', !!syncError);
    } else if (formStillCurrent) {
      syncStatus.textContent = syncError ? 'Auto-saved locally · sheet sync failed' : 'Auto-saved ✓';
      syncStatus.className = syncError ? 'field-hint' : 'field-hint success';
    } else {
      toast(syncError ? 'Auto-saved locally · sheet sync failed' : 'Changes auto-saved', !!syncError);
    }
  } finally {
    isSaving = false;
    saveBtn.disabled = false;
  }
}

editor.addEventListener('submit', (e) => {
  e.preventDefault();
  persistForm();
});

// Typed fields and the status checkboxes all bubble input events; the
// programmatic pickers (chips, job type, autocomplete) call scheduleAutosave
// from their own handlers.
editor.addEventListener('input', scheduleAutosave);

deleteBtn.addEventListener('click', async () => {
  const id = el('f-id').value;
  if (!id) return;
  if (!(await confirmDialog())) return;

  const { syncError } = await window.heatmapAPI.deleteApplication(id);
  await loadApplications();
  // Neutralize autosave so closing doesn't re-save (resurrect) the deleted app.
  clearTimeout(autosaveTimer);
  lastSavedSnapshot = formSnapshot();
  editSession++;
  closeEditor();
  toast(syncError ? 'Deleted locally · sheet sync failed' : 'Application deleted', !!syncError);
});

// ── Status multi-select ──
const statusMs = el('status-ms');
const statusControl = el('status-control');
const statusPanel = el('status-panel');
const statusChips = el('status-chips');
const statusHidden = el('f-status');

let statusSelected = new Set();
let statusExtras = []; // values not in STATUS_OPTIONS, preserved so nothing is lost

function allStatusOptions() {
  return [...STATUS_OPTIONS, ...statusExtras];
}

function orderedSelected() {
  return allStatusOptions().filter((o) => statusSelected.has(o));
}

function setStatus(value) {
  statusSelected = new Set();
  statusExtras = [];
  for (const token of splitStatus(value)) {
    const match = STATUS_OPTIONS.find((o) => o.toLowerCase() === token.toLowerCase());
    const label = match || token;
    if (!match && !statusExtras.includes(label)) statusExtras.push(label);
    statusSelected.add(label);
  }
  buildStatusPanel();
  updateStatusUI();
}

function buildStatusPanel() {
  statusPanel.innerHTML = '';
  for (const opt of allStatusOptions()) {
    const row = document.createElement('label');
    row.className = 'ms-option';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = statusSelected.has(opt);
    cb.addEventListener('change', () => {
      if (cb.checked) statusSelected.add(opt);
      else statusSelected.delete(opt);
      updateStatusUI();
      // Reaching an interview stage usually means one just got scheduled —
      // offer to log it right here.
      if (cb.checked && IV_STAGES.includes(opt)) showInlineScheduler(row, opt);
      // An offer is worth a moment. Fires only on a genuine click (building the
      // panel sets .checked directly, which doesn't dispatch 'change').
      if (cb.checked && opt.toLowerCase().includes('offer')) celebrateOffer();
    });

    const span = document.createElement('span');
    span.textContent = opt;

    row.appendChild(cb);
    row.appendChild(span);
    statusPanel.appendChild(row);
  }
}

function updateStatusUI() {
  const ordered = orderedSelected();
  statusHidden.value = ordered.join(', ');
  statusChips.innerHTML = '';

  if (ordered.length === 0) {
    const ph = document.createElement('span');
    ph.className = 'ms-placeholder';
    ph.textContent = 'Select…';
    statusChips.appendChild(ph);
    return;
  }

  for (const label of ordered) {
    const chip = document.createElement('span');
    chip.className = 'ms-chip';
    chip.textContent = label;

    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      statusSelected.delete(label);
      buildStatusPanel();
      updateStatusUI();
      scheduleAutosave();
    });

    chip.appendChild(x);
    statusChips.appendChild(chip);
  }
}

function closeStatusPanel() {
  statusPanel.classList.add('hidden');
  statusMs.classList.remove('open');
}

statusControl.addEventListener('click', () => {
  const isOpen = !statusPanel.classList.contains('hidden');
  statusPanel.classList.toggle('hidden', isOpen);
  statusMs.classList.toggle('open', !isOpen);
});

statusControl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    statusControl.click();
  } else if (e.key === 'Escape') {
    closeStatusPanel();
  }
});

document.addEventListener('click', (e) => {
  if (!statusMs.contains(e.target)) closeStatusPanel();
});

buildStatusPanel();
updateStatusUI();

// ── Job type single-select ──
const JOB_TYPE_OPTIONS = ['Alternance', 'CDI', 'CDI (presta)', 'CDD', 'CIVP', 'Freelance'];

const jobtypeMs = el('jobtype-ms');
const jobtypeControl = el('jobtype-control');
const jobtypePanel = el('jobtype-panel');
const jobtypeValueEl = el('jobtype-value');
const jobtypeHidden = el('f-job_type');

let jobtypeExtra = ''; // a stored value not in the canonical list, preserved

function allJobTypeOptions() {
  return jobtypeExtra ? [...JOB_TYPE_OPTIONS, jobtypeExtra] : JOB_TYPE_OPTIONS;
}

function setJobType(value) {
  const v = String(value || '').trim();
  const match = JOB_TYPE_OPTIONS.find((o) => o.toLowerCase() === v.toLowerCase());
  jobtypeExtra = v && !match ? v : '';
  jobtypeHidden.value = match || v;
  buildJobTypePanel();
  updateJobTypeUI();
}

function updateJobTypeUI() {
  const v = jobtypeHidden.value;
  jobtypeValueEl.textContent = v || 'Select…';
  jobtypeValueEl.classList.toggle('ms-placeholder', !v);
}

function buildJobTypePanel() {
  jobtypePanel.innerHTML = '';
  const addRow = (label, value) => {
    const row = document.createElement('div');
    row.className = 'dd-option' + (jobtypeHidden.value === value ? ' selected' : '');
    row.textContent = label;
    row.addEventListener('click', () => {
      jobtypeHidden.value = value;
      buildJobTypePanel();
      updateJobTypeUI();
      closeJobTypePanel();
      scheduleAutosave();
    });
    jobtypePanel.appendChild(row);
  };
  addRow('—', ''); // clear
  for (const opt of allJobTypeOptions()) addRow(opt, opt);
}

function closeJobTypePanel() {
  jobtypePanel.classList.add('hidden');
  jobtypeMs.classList.remove('open');
}

jobtypeControl.addEventListener('click', () => {
  const isOpen = !jobtypePanel.classList.contains('hidden');
  jobtypePanel.classList.toggle('hidden', isOpen);
  jobtypeMs.classList.toggle('open', !isOpen);
});

jobtypeControl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    jobtypeControl.click();
  } else if (e.key === 'Escape') {
    closeJobTypePanel();
  }
});

document.addEventListener('click', (e) => {
  if (!jobtypeMs.contains(e.target)) closeJobTypePanel();
});

buildJobTypePanel();
updateJobTypeUI();

// ── Autocomplete (company / resume version) ──
// Suggests previously entered values for a free-text input, ranked by how
// often each was used. Reuses the themed .dd-panel/.dd-option styling.
function distinctValues(field) {
  const counts = new Map();
  for (const a of applications) {
    const v = String(a[field] == null ? '' : a[field]).trim();
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => v);
}

function attachAutocomplete(input, field) {
  input.parentElement.classList.add('has-autocomplete');
  input.setAttribute('autocomplete', 'off');

  const panel = document.createElement('div');
  panel.className = 'ac-panel hidden';
  input.insertAdjacentElement('afterend', panel);

  let items = [];
  let active = -1;

  const isOpen = () => !panel.classList.contains('hidden');
  function close() {
    panel.classList.add('hidden');
    active = -1;
  }

  function highlight(i) {
    active = i;
    [...panel.children].forEach((row, idx) =>
      row.classList.toggle('active', idx === active)
    );
  }

  function open() {
    const query = input.value.trim().toLowerCase();
    items = distinctValues(field).filter((v) => {
      const lv = v.toLowerCase();
      return lv !== query && (!query || lv.includes(query));
    }).slice(0, 6);

    if (items.length === 0) { close(); return; }

    panel.innerHTML = '';
    items.forEach((v, idx) => {
      const row = document.createElement('div');
      row.className = 'dd-option';
      row.textContent = v;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus, beat the blur
        input.value = v;
        close();
        scheduleAutosave();
      });
      row.addEventListener('mouseenter', () => highlight(idx));
      panel.appendChild(row);
    });
    active = -1;
    panel.classList.remove('hidden');
  }

  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120));

  input.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight((active - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      if (active >= 0) {
        e.preventDefault();
        input.value = items[active];
        close();
        scheduleAutosave();
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // don't let the global handler close the editor
      close();
    }
  });
}

attachAutocomplete(el('f-company'), 'company');
attachAutocomplete(el('f-location'), 'location');
attachAutocomplete(el('f-resume_version'), 'resume_version');

// ── Interviews ──
const IV_STAGES = [
  'HR Call', 'HR Screen', 'Online Logic test', 'Online coding Test',
  'Tech Interview', 'Manager Interview', 'Final Interview',
];
const IV_FORMATS = ['Video', 'Call', 'On-site', 'Online judge'];
const IV_OUTCOMES = ['upcoming', 'passed', 'failed'];
const IV_STAGE_SHORT = {
  'HR Call': 'HR', 'HR Screen': 'HR', 'Online Logic test': 'Logic',
  'Online coding Test': 'Code', 'Tech Interview': 'Tech',
  'Manager Interview': 'Mgr', 'Final Interview': 'Final',
};

let editorInterviews = [];

function parseLocalDt(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// '2026-06-16T14:00' → '16 Jun · 14:00'
function formatEventShort(s) {
  const d = parseLocalDt(s);
  if (!d) return '';
  return `${d.getDate()} ${MONTHS_ABBR[d.getMonth()]} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ivTiming(iv) {
  const d = parseLocalDt(iv.scheduled_at);
  if (!d) return '';
  const delta = d.getTime() - Date.now();
  if (delta < 0) return 'overdue';
  if (delta < 24 * 60 * 60 * 1000) return 'soon';
  return '';
}

function ivPillHtml(app) {
  const iv = upcomingByApp.get(app.id);
  if (!iv) return '';
  const short = IV_STAGE_SHORT[iv.stage] || iv.stage || 'Interview';
  return `<span class="iv-pill ${ivTiming(iv)}" title="${escapeHtml(iv.stage || 'Interview')} — ${escapeHtml(formatEventShort(iv.scheduled_at))}">${escapeHtml(short)} · ${escapeHtml(formatEventShort(iv.scheduled_at))}</span>`;
}

// Fold state for the editor's Interviews section. Defaults to collapsed so the
// editor isn't crowded; the header shows a count and clicking it expands.
function setInterviewsCollapsed(collapsed) {
  el('iv-section-toggle').classList.toggle('collapsed', collapsed);
  el('iv-section-toggle').setAttribute('aria-expanded', String(!collapsed));
  el('iv-section-body').classList.toggle('collapsed', collapsed);
}

el('iv-section-toggle').addEventListener('click', () => {
  setInterviewsCollapsed(!el('iv-section-body').classList.contains('collapsed'));
});

async function loadEditorInterviews(applicationId) {
  editorInterviews = applicationId
    ? await window.heatmapAPI.listInterviews(applicationId)
    : [];
  setInterviewsCollapsed(true); // always start minimized when opening an application
  renderInterviews();
}

// The application id the editor is working on; for a brand-new application,
// autosaves it first so interviews have something to attach to.
async function ensureAppId() {
  if (el('f-id').value) return el('f-id').value;
  if (!formIsSaveable()) {
    toast('Add a job title or company first', true);
    return null;
  }
  await persistForm({ auto: true });
  return el('f-id').value || null;
}

// Serialized per record so a fast second edit can't race the initial insert
// into creating a duplicate. Private fields (_save, _deleted) never cross IPC.
function saveInterviewRecord(iv) {
  iv._save = (iv._save || Promise.resolve()).then(async () => {
    if (iv._deleted) return;
    const payload = {
      id: iv.id,
      application_id: iv.application_id,
      stage: iv.stage,
      scheduled_at: iv.scheduled_at,
      format: iv.format,
      interviewer: iv.interviewer,
      notes: iv.notes,
      outcome: iv.outcome,
    };
    const { id } = await window.heatmapAPI.saveInterview(payload);
    iv.id = id;
    if (iv._deleted) {
      await window.heatmapAPI.deleteInterview(id); // deleted while the insert was in flight
      return;
    }
    rebuildAfterInterviewChange();
  });
  return iv._save;
}

async function rebuildAfterInterviewChange() {
  allInterviews = await window.heatmapAPI.listAllInterviews();
  rebuildUpcomingByApp();
  renderAgenda();
  render();
}

async function addInterview(stage = '', scheduledAt = '') {
  const appId = await ensureAppId();
  if (!appId) return null;
  const iv = {
    application_id: appId,
    stage,
    scheduled_at: scheduledAt,
    format: '',
    interviewer: '',
    notes: '',
    outcome: 'upcoming',
  };
  // Show the card instantly; the insert happens in the background.
  if (el('f-id').value === appId) {
    editorInterviews.push(iv);
    setInterviewsCollapsed(false); // reveal the section so the new card is visible
    renderInterviews();
  }
  saveInterviewRecord(iv);
  return iv;
}

// Small single-select reusing the .dd-* theme, built per interview card.
function miniDropdown(options, value, placeholder, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'dropdown iv-dd';
  const ctrl = document.createElement('div');
  ctrl.className = 'dd-control';
  ctrl.tabIndex = 0;
  const labEl = document.createElement('span');
  labEl.className = 'iv-dd-label';
  labEl.textContent = value || placeholder;
  if (!value) labEl.classList.add('ms-placeholder');
  ctrl.appendChild(labEl);
  ctrl.insertAdjacentHTML(
    'beforeend',
    '<svg class="ms-caret" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"/></svg>'
  );
  const panel = document.createElement('div');
  panel.className = 'dd-panel hidden';

  for (const opt of options) {
    const row = document.createElement('div');
    row.className = 'dd-option' + (opt === value ? ' selected' : '');
    row.textContent = opt;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.add('hidden');
      labEl.textContent = opt;
      labEl.classList.remove('ms-placeholder');
      [...panel.children].forEach((r) => r.classList.toggle('selected', r === row));
      onPick(opt);
    });
    panel.appendChild(row);
  }

  ctrl.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.iv-dd .dd-panel, .iv-inline').forEach((p) => {
      if (p !== panel) p.classList.contains('iv-inline') ? p.remove() : p.classList.add('hidden');
    });
    panel.classList.toggle('hidden');
  });
  ctrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctrl.click(); }
    else if (e.key === 'Escape') panel.classList.add('hidden');
  });

  wrap.appendChild(ctrl);
  wrap.appendChild(panel);
  return wrap;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.iv-dd')) {
    document.querySelectorAll('.iv-dd .dd-panel').forEach((p) => p.classList.add('hidden'));
  }
});

function renderInterviews() {
  const list = el('interview-list');
  list.innerHTML = '';

  const badge = el('iv-count-badge');
  badge.textContent = editorInterviews.length || '';
  badge.classList.toggle('hidden', editorInterviews.length === 0);

  for (const iv of editorInterviews) {
    const card = document.createElement('div');
    card.className = 'iv-card';

    // Debounced save for typed fields; dropdowns/outcome save immediately.
    let saveTimer;
    const queueSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveInterviewRecord(iv), 600);
    };

    const row1 = document.createElement('div');
    row1.className = 'iv-row';
    row1.appendChild(miniDropdown(IV_STAGES, iv.stage, 'Stage…', (v) => {
      iv.stage = v;
      saveInterviewRecord(iv);
    }));

    const dt = document.createElement('input');
    dt.type = 'datetime-local';
    dt.value = iv.scheduled_at || '';
    dt.addEventListener('input', () => { iv.scheduled_at = dt.value; queueSave(); });
    row1.appendChild(dt);

    const cal = document.createElement('button');
    cal.type = 'button';
    cal.className = 'iv-cal';
    cal.title = 'Export to calendar (.ics)';
    cal.textContent = '📅';
    cal.addEventListener('click', () => exportInterviewIcs(iv));
    row1.appendChild(cal);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'iv-del';
    del.title = 'Remove interview';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      clearTimeout(saveTimer);
      iv._deleted = true; // a still-in-flight insert will clean itself up
      if (iv.id) await window.heatmapAPI.deleteInterview(iv.id);
      editorInterviews = editorInterviews.filter((x) => x !== iv);
      renderInterviews();
      rebuildAfterInterviewChange();
      toast('Interview removed');
    });
    row1.appendChild(del);
    card.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'iv-row';
    row2.appendChild(miniDropdown(IV_FORMATS, iv.format, 'Format…', (v) => {
      iv.format = v;
      saveInterviewRecord(iv);
    }));

    const who = document.createElement('input');
    who.type = 'text';
    who.placeholder = 'Interviewer / contact';
    who.spellcheck = false;
    who.value = iv.interviewer || '';
    who.addEventListener('input', () => { iv.interviewer = who.value.trim(); queueSave(); });
    row2.appendChild(who);
    card.appendChild(row2);

    const notes = document.createElement('textarea');
    notes.rows = 1;
    notes.placeholder = 'Notes (prep, questions asked, impressions…)';
    notes.spellcheck = false;
    notes.value = iv.notes || '';
    notes.addEventListener('input', () => { iv.notes = notes.value; queueSave(); });
    card.appendChild(notes);

    const seg = document.createElement('div');
    seg.className = 'iv-seg';
    for (const o of IV_OUTCOMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'iv-seg-btn' + (iv.outcome === o ? ` active ${o}` : '');
      b.textContent = o[0].toUpperCase() + o.slice(1);
      b.addEventListener('click', () => {
        iv.outcome = o;
        saveInterviewRecord(iv);
        renderInterviews();
      });
      seg.appendChild(b);
    }
    card.appendChild(seg);

    list.appendChild(card);
  }
}

document.getElementById('btn-add-interview').addEventListener('click', () => addInterview());

// Inline "When?" — checking an interview-type stage in the status dropdown
// offers to schedule it right there, at the moment you'd naturally record it.
function showInlineScheduler(afterRow, stage) {
  document.querySelectorAll('.iv-inline').forEach((p) => p.remove());

  const box = document.createElement('div');
  box.className = 'iv-inline';

  const dt = document.createElement('input');
  dt.type = 'datetime-local';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'iv-inline-add';
  add.textContent = 'Schedule';
  add.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!dt.value) { dt.focus(); return; }
    box.remove();
    const iv = await addInterview(stage, dt.value);
    if (iv) toast(`${stage} scheduled · ${formatEventShort(dt.value)}`);
  });
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'iv-inline-skip';
  skip.textContent = 'Skip';
  skip.addEventListener('click', (e) => { e.stopPropagation(); box.remove(); });

  box.appendChild(dt);
  box.appendChild(add);
  box.appendChild(skip);
  afterRow.insertAdjacentElement('afterend', box);
  dt.focus();
}

// ── Calendar export (.ics) ──
function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

async function exportInterviewIcs(iv) {
  if (!iv.scheduled_at) {
    toast('Set a date & time first', true);
    return;
  }
  const app = applications.find((a) => a.id === iv.application_id);
  const summary = `${iv.stage || 'Interview'}${app && app.company ? ' — ' + app.company : ''}`;
  const desc = [app && app.job_title, iv.format, iv.interviewer, iv.notes].filter(Boolean).join('\n');
  // Floating local time — calendars interpret it in the user's timezone.
  const dtStart = iv.scheduled_at.replace(/[-:]/g, '') + '00';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  const content = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Heatmap//Interview//EN',
    'BEGIN:VEVENT',
    `UID:${iv.id || Date.now()}@heatmap`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    'DURATION:PT1H',
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');

  const slug = String((app && app.company) || iv.stage || 'event')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'event';
  const result = await window.heatmapAPI.exportFile({
    defaultName: `interview-${slug}.ics`,
    content,
    filters: [{ name: 'Calendar', extensions: ['ics'] }],
  });
  if (!result.canceled) toast('Calendar event exported');
}

// ── Agenda (upcoming interviews across all applications) ──
function agendaEntries() {
  return allInterviews
    .filter((iv) => iv.outcome === 'upcoming' && iv.scheduled_at)
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

function agendaGroup(iv) {
  const d = parseLocalDt(iv.scheduled_at);
  if (!d) return 'Later';
  const now = new Date();
  if (d.getTime() < now.getTime()) return 'Needs outcome';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((d.getTime() - today.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return 'This week';
  return 'Later';
}

function renderAgenda() {
  const entries = agendaEntries();
  const badge = el('agenda-count');
  const dueSoon = entries.filter((iv) => ['Needs outcome', 'Today', 'Tomorrow'].includes(agendaGroup(iv))).length;
  badge.textContent = dueSoon || '';
  badge.classList.toggle('hidden', dueSoon === 0);

  const agenda = el('agenda');
  agenda.innerHTML = '';

  if (entries.length === 0) {
    agenda.innerHTML = '<div class="agenda-empty">No interviews scheduled. Check a stage in an application’s Status to schedule one.</div>';
    return;
  }

  let lastGroup = null;
  for (const iv of entries) {
    const group = agendaGroup(iv);
    if (group !== lastGroup) {
      lastGroup = group;
      const h = document.createElement('div');
      h.className = 'agenda-group' + (group === 'Needs outcome' ? ' overdue' : '');
      h.textContent = group;
      agenda.appendChild(h);
    }

    const app = applications.find((a) => a.id === iv.application_id);
    const row = document.createElement('div');
    row.className = 'agenda-row';
    row.innerHTML = `
      <span class="agenda-when ${ivTiming(iv)}">${escapeHtml(formatEventShort(iv.scheduled_at))}</span>
      <span class="agenda-stage">${escapeHtml(iv.stage || 'Interview')}</span>
      <span class="agenda-app">${escapeHtml([app && app.job_title, app && app.company].filter(Boolean).join(' — ') || 'Unknown application')}</span>
    `;
    if (app) row.addEventListener('click', () => openEditor(app));
    agenda.appendChild(row);
  }
}

document.getElementById('btn-agenda').addEventListener('click', () => {
  const collapsed = el('agenda-panel').classList.toggle('collapsed');
  el('btn-agenda').classList.toggle('active', !collapsed);
  if (!collapsed) {
    el('stats-panel').classList.add('collapsed');
    el('btn-stats').classList.remove('active');
  }
});

// ── Export (Markdown, LLM-friendly) ──
// Markdown keeps the structure readable for both humans and LLMs, so the file
// can be pasted straight into a chat for interview prep or recruiter emails.
function appendAppMarkdown(out, a, heading) {
  const title = [a.job_title, a.company].filter(Boolean).join(' — ') || 'Untitled application';
  out.push(`${heading} ${title}`);
  out.push('');

  const facts = [
    ['Location', a.location],
    ['Applied', formatDisplayDate(a.applying_date)],
    ['Job Type', a.job_type],
    ['Status', a.status],
    ['Resume Version', a.resume_version],
    ['Contact', a.contact],
  ];
  for (const [label, value] of facts) {
    if (value) out.push(`- **${label}:** ${value}`);
  }
  if (a.description) {
    out.push('');
    out.push('**Description:**');
    out.push(String(a.description).trim());
  }
  if (a.notes) {
    out.push('');
    out.push('**Notes:**');
    out.push(String(a.notes).trim());
  }

  const ivs = a.id ? allInterviews.filter((i) => i.application_id === a.id) : [];
  if (ivs.length) {
    out.push('');
    out.push('**Interviews:**');
    for (const iv of ivs) {
      const bits = [
        formatEventShort(iv.scheduled_at), iv.stage, iv.format, iv.interviewer,
        iv.outcome && iv.outcome !== 'upcoming' ? iv.outcome : '',
      ].filter(Boolean).join(' · ');
      out.push(`- ${bits || 'Interview'}`);
      if (iv.notes) out.push(`  - Notes: ${String(iv.notes).trim().replace(/\s*\n\s*/g, ' / ')}`);
    }
  }
}

function buildExportMarkdown(list) {
  const out = [];
  out.push('# Job Applications');
  out.push('');
  out.push(`Exported ${formatDisplayDate(new Date().toISOString().slice(0, 10))} · ${list.length} application${list.length === 1 ? '' : 's'}.`);

  for (const a of list) {
    out.push('');
    appendAppMarkdown(out, a, '##');
  }
  out.push('');
  return out.join('\n');
}

function buildSingleExportMarkdown(a) {
  const out = [];
  appendAppMarkdown(out, a, '#');
  out.push('');
  return out.join('\n');
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const list = visibleList();
  if (list.length === 0) {
    toast('Nothing to export in this view', true);
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await window.heatmapAPI.exportApplications({
    defaultName: `job-applications-${stamp}.md`,
    content: buildExportMarkdown(list),
  });
  if (!result.canceled) {
    toast(`Exported ${list.length} application${list.length === 1 ? '' : 's'}`);
  }
});

// Export just the application open in the editor, using the form's current
// values so unsaved tweaks are included.
document.getElementById('btn-export-one').addEventListener('click', async () => {
  const a = { id: el('f-id').value || null };
  for (const f of FIELDS) a[f] = el(`f-${f}`).value.trim() || null;

  const slug = String(a.company || a.job_title || 'application')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'application';

  const result = await window.heatmapAPI.exportApplications({
    defaultName: `application-${slug}.md`,
    content: buildSingleExportMarkdown(a),
  });
  if (!result.canceled) toast('Application exported');
});

// ── Editor pane resize (drag its left edge) ──
const editorResizer = el('editor-resizer');
const managerBody = el('manager-body');
const EDITOR_MIN_WIDTH = 320;
const LIST_MIN_WIDTH = 260; // keep the list usable while widening the editor

const savedEditorWidth = Number(localStorage.getItem('editorWidth'));
if (savedEditorWidth >= EDITOR_MIN_WIDTH) {
  editor.style.width = `${savedEditorWidth}px`;
}

editorResizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  editorResizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');

  const onMove = (ev) => {
    const rect = managerBody.getBoundingClientRect();
    const max = rect.width - LIST_MIN_WIDTH;
    const width = Math.min(max, Math.max(EDITOR_MIN_WIDTH, rect.right - ev.clientX));
    editor.style.width = `${width}px`;
  };
  const onUp = () => {
    editorResizer.removeEventListener('pointermove', onMove);
    editorResizer.removeEventListener('pointerup', onUp);
    document.body.classList.remove('resizing');
    const width = parseInt(editor.style.width, 10);
    if (width) localStorage.setItem('editorWidth', String(width));
  };
  editorResizer.addEventListener('pointermove', onMove);
  editorResizer.addEventListener('pointerup', onUp);
});

// ── Offer celebration ──
// A low-key fireworks burst, in the app's palette, when an application reaches
// an Offer. Glow + additive blending keep it on-theme with the glassy UI.
const OFFER_COLORS = ['#58a6ff', '#79b8ff', '#39d353', '#e3b341', '#bc8cff', '#ffffff'];
let celebrating = false;

function celebrateOffer() {
  toast('🎉 Offer — nicely done.');

  // Note: deliberately not gated on prefers-reduced-motion — it's a brief,
  // user-triggered one-shot, and Windows with animation effects off would
  // otherwise silently suppress it.
  if (celebrating) return;
  celebrating = true;

  const canvas = document.createElement('canvas');
  canvas.id = 'celebrate-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
  canvas.width = W() * dpr;
  canvas.height = H() * dpr;
  ctx.scale(dpr, dpr);

  const GRAVITY = 0.05;
  const rockets = [];
  const particles = [];
  const BURSTS = 4;
  let pending = BURSTS;

  function explode(x, y, color) {
    const count = 36 + Math.floor(Math.random() * 16);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.25;
      const speed = Math.random() * 3.6 + 1.2;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: Math.random() * 0.012 + 0.008,
        size: Math.random() * 2 + 1.4,
        color: Math.random() < 0.22 ? '#ffffff' : color,
      });
    }
  }

  // Stagger a few rockets across the upper half of the window.
  for (let i = 0; i < BURSTS; i++) {
    setTimeout(() => {
      pending--;
      rockets.push({
        x: W() * (0.18 + Math.random() * 0.64),
        y: H() + 8,
        vy: -(Math.random() * 1.6 + 8.5),
        targetY: H() * (0.18 + Math.random() * 0.28),
        color: OFFER_COLORS[Math.floor(Math.random() * OFFER_COLORS.length)],
      });
    }, i * 300);
  }

  let frame = 0;
  const MAX_FRAMES = 60 * 6; // hard safety cap (~6s)

  function tick() {
    frame++;
    ctx.clearRect(0, 0, W(), H());
    ctx.globalCompositeOperation = 'lighter';

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.y += r.vy;
      r.vy += GRAVITY * 1.5;
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 12;
      ctx.shadowColor = r.color;
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      if (r.y <= r.targetY || r.vy >= 0) {
        explode(r.x, r.y, r.color);
        rockets.splice(i, 1);
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += GRAVITY;
      p.vx *= 0.99;
      p.life -= p.decay;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.shadowBlur = 8;
      ctx.shadowColor = p.color;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';

    if ((pending > 0 || rockets.length || particles.length) && frame < MAX_FRAMES) {
      requestAnimationFrame(tick);
    } else {
      canvas.remove();
      celebrating = false;
    }
  }
  requestAnimationFrame(tick);
}

// First data render, then tell main we're ready to be shown — the zoom-open
// animation starts only after this, over a finished layout.
loadApplications().finally(() => {
  requestAnimationFrame(() => window.heatmapAPI.managerReady());
});
