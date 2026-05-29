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

function el(id) {
  return document.getElementById(id);
}

async function loadApplications() {
  applications = await window.heatmapAPI.listApplications();
  render();
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query
    ? applications.filter((a) =>
        FIELDS.some((f) => String(a[f] || '').toLowerCase().includes(query))
      )
    : applications;

  countBadge.textContent = `${applications.length}`;
  tbody.innerHTML = '';

  emptyState.classList.toggle('hidden', applications.length > 0);

  for (const app of filtered) {
    const tr = document.createElement('tr');
    if (app.id === selectedId) tr.classList.add('selected');
    tr.dataset.id = app.id;

    tr.innerHTML = `
      <td class="title-cell">${escapeHtml(app.job_title) || '—'}</td>
      <td>${escapeHtml(app.company) || '—'}</td>
      <td>${escapeHtml(app.applying_date) || '—'}</td>
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
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => {
      if (e.target === confirmOverlay) cleanup(false);
    };

    el('confirm-ok').addEventListener('click', onOk);
    el('confirm-cancel').addEventListener('click', onCancel);
    confirmOverlay.addEventListener('click', onBackdrop);
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

  if (syncError) {
    syncStatus.textContent = `Saved locally · sheet sync failed`;
    syncStatus.className = 'field-hint error';
  } else {
    syncStatus.textContent = 'Saved';
    syncStatus.className = 'field-hint success';
  }
  el('f-id').value = id;
  deleteBtn.classList.remove('hidden');
});

deleteBtn.addEventListener('click', async () => {
  const id = el('f-id').value;
  if (!id) return;
  if (!(await confirmDialog())) return;

  const { syncError } = await window.heatmapAPI.deleteApplication(id);
  await loadApplications();
  closeEditor();

  if (syncError) {
    console.error('Sheet delete sync failed:', syncError);
  }
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
