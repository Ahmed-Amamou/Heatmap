const FIELDS = [
  'job_title', 'company', 'location', 'applying_date', 'job_type',
  'status', 'resume_version', 'contact', 'description', 'notes',
];

// Application journey stages, in order. Stored as a comma-separated list to
// match the sheet's free-form status column.
const STATUS_OPTIONS = [
  'Applied', 'Pre-selected', 'HR Call', 'HR Screen', 'Online Logic test',
  'Coding test', 'Tech Interview', 'Manager Interview', 'Final Interview',
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
let selectedId = null;
let currentFilter = 'all';
let currentSort = 'newest';

const STALE_DAYS = 14;

function el(id) {
  return document.getElementById(id);
}

async function loadApplications() {
  applications = await window.heatmapAPI.listApplications();
  buildFilters();
  renderStats();
  render();
}

function render() {
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

  list = sortList(list);

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
      <td>${escapeHtml(app.applying_date) || '—'}${followup}</td>
      <td>${renderStatusPills(app.status)}</td>
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

function splitStatus(status) {
  return String(status || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Show the final/outcome stage as the main pill, with a count of the rest.
function renderStatusPills(status) {
  const parts = splitStatus(status);
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

// Final outcome bucket, in priority order.
function outcomeOf(app) {
  const parts = statusParts(app);
  if (hasOffer(parts)) return 'offer';
  if (hasReject(parts)) return 'rejected';
  if (reachedScreen(parts)) return 'interviewing';
  return 'active';
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// Stale = still just "applied", no response, and old enough to chase.
function needsFollowup(app) {
  if (outcomeOf(app) !== 'active') return false;
  const days = daysSince(app.applying_date);
  return days != null && days >= STALE_DAYS;
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
  selectedId = app ? app.id : null;
  el('f-id').value = app ? app.id : '';

  for (const f of FIELDS) {
    el(`f-${f}`).value = app && app[f] != null ? app[f] : '';
  }
  setStatus(app && app.status != null ? app.status : '');
  closeStatusPanel();

  deleteBtn.classList.toggle('hidden', !app);
  syncStatus.textContent = '';
  syncStatus.className = 'field-hint';
  editor.classList.remove('hidden');
  render();
  el('f-job_title').focus();
}

function closeEditor() {
  selectedId = null;
  editor.classList.add('hidden');
  render();
}

document.getElementById('btn-new').addEventListener('click', () => openEditor(null));
document.getElementById('btn-cancel').addEventListener('click', closeEditor);
searchInput.addEventListener('input', render);

document.getElementById('btn-close-manager').addEventListener('click', () => {
  window.heatmapAPI.closeManager();
});

document.getElementById('btn-stats').addEventListener('click', () => {
  const collapsed = el('stats-panel').classList.toggle('collapsed');
  el('btn-stats').classList.toggle('active', !collapsed);
  if (!collapsed) applyFunnelWidths();
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
    else if (!editor.classList.contains('hidden')) closeEditor();
    else window.heatmapAPI.closeManager();
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

editor.addEventListener('submit', async (e) => {
  e.preventDefault();
  const appData = { id: el('f-id').value || undefined };
  for (const f of FIELDS) appData[f] = el(`f-${f}`).value.trim() || null;

  syncStatus.textContent = 'Saving…';
  syncStatus.className = 'field-hint';

  const { id, syncError } = await window.heatmapAPI.saveApplication(appData);
  selectedId = id;
  await loadApplications();

  syncStatus.textContent = '';
  el('f-id').value = id;
  deleteBtn.classList.remove('hidden');
  toast(syncError ? 'Saved locally · sheet sync failed' : 'Application saved', !!syncError);
});

deleteBtn.addEventListener('click', async () => {
  const id = el('f-id').value;
  if (!id) return;
  if (!(await confirmDialog())) return;

  const { syncError } = await window.heatmapAPI.deleteApplication(id);
  await loadApplications();
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

loadApplications();
