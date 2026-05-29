const FIELDS = [
  'job_title', 'company', 'location', 'applying_date', 'job_type',
  'status', 'resume_version', 'contact', 'description', 'notes',
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
      <td>${app.status ? `<span class="status-pill">${escapeHtml(app.status)}</span>` : '—'}</td>
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

function openEditor(app) {
  selectedId = app ? app.id : null;
  el('f-id').value = app ? app.id : '';

  for (const f of FIELDS) {
    el(`f-${f}`).value = app && app[f] != null ? app[f] : '';
  }

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

loadApplications();
