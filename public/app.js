// public/app.js — LinkVerify frontend state manager
// Handles: API key storage, ingest, polling, results table, CSV export, toasts

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  apiKey: localStorage.getItem('lv_api_key') || '',
  jobId: null,
  pollingTimer: null,
  currentPage: 0,
  totalRecords: 0,
  allRecords: [],
  filteredRecords: [],
  bulkEmails: [],
  activeTab: 'single',
};

// ── Initialise ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (state.apiKey) {
    document.getElementById('api-key-input').value = state.apiKey;
    updateApiKeyIndicator(true);
  }

  // Resume job from localStorage if page was refreshed mid-run
  const savedJob = localStorage.getItem('lv_job_id');
  if (savedJob && state.apiKey) {
    state.jobId = savedJob;
    showDashboard();
    startPolling();
  }
});

// ── API Key ───────────────────────────────────────────────────────────────────
function toggleApiKeyDrawer() {
  const drawer = document.getElementById('api-key-drawer');
  drawer.classList.toggle('hidden');
  if (!drawer.classList.contains('hidden')) {
    document.getElementById('api-key-input').focus();
  }
}

function handleApiKeyInput(value) {
  state.apiKey = value.trim();
  localStorage.setItem('lv_api_key', state.apiKey);
  updateApiKeyIndicator(!!state.apiKey);
}

function clearApiKey() {
  state.apiKey = '';
  localStorage.removeItem('lv_api_key');
  document.getElementById('api-key-input').value = '';
  updateApiKeyIndicator(false);
  showToast('API key cleared', 'info');
}

function updateApiKeyIndicator(isSet) {
  const dot = document.getElementById('api-key-dot');
  const label = document.getElementById('api-key-label');
  if (isSet) {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    label.textContent = 'API Key set';
    label.className = 'text-emerald-400 text-sm';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-zinc-600';
    label.textContent = 'Set API Key';
    label.className = 'text-zinc-500 text-sm';
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  state.activeTab = tab;
  ['single', 'bulk'].forEach(t => {
    const btn = document.getElementById(`tab-${t}`);
    const panel = document.getElementById(`panel-${t}`);
    if (t === tab) {
      btn.classList.add('tab-active', 'text-zinc-100');
      btn.classList.remove('text-zinc-500');
      panel.classList.remove('hidden');
    } else {
      btn.classList.remove('tab-active', 'text-zinc-100');
      btn.classList.add('text-zinc-500');
      panel.classList.add('hidden');
    }
  });
}

// ── Single submit ─────────────────────────────────────────────────────────────
async function submitSingle() {
  const email = document.getElementById('single-email-input').value.trim();
  if (!email) return showToast('Enter an email address', 'error');
  if (!email.includes('@')) return showToast('Invalid email format', 'error');
  if (!state.apiKey) {
    showToast('Set your API key first', 'error');
    document.getElementById('api-key-drawer').classList.remove('hidden');
    return;
  }
  await ingestEmails([email]);
}

// ── Bulk CSV handling ─────────────────────────────────────────────────────────
function parseBulkInput(text) {
  const emails = parseEmailsFromText(text);
  state.bulkEmails = emails;
  updateBulkPreview(emails);
}

function parseEmailsFromText(text) {
  return [...new Set(
    text
      .split(/[\n,;]+/)
      .map(e => e.trim().toLowerCase())
      .filter(e => e.includes('@') && e.includes('.'))
  )];
}

function updateBulkPreview(emails) {
  const preview = document.getElementById('bulk-preview');
  const countEl = document.getElementById('bulk-count');
  const btnCount = document.getElementById('bulk-count-btn');
  if (emails.length > 0) {
    preview.classList.remove('hidden');
    countEl.textContent = `${emails.length} unique email${emails.length === 1 ? '' : 's'} found`;
    btnCount.textContent = emails.length;
  } else {
    preview.classList.add('hidden');
  }
}

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('drop-zone').classList.remove('drop-zone-active');
  const file = event.dataTransfer.files[0];
  if (file) readFile(file);
}

function handleFileInput(event) {
  const file = event.target.files[0];
  if (file) readFile(file);
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    document.getElementById('bulk-textarea').value = text;
    parseBulkInput(text);
    showToast(`Loaded ${file.name}`, 'success');
  };
  reader.readAsText(file);
}

async function submitBulk() {
  if (state.bulkEmails.length === 0) return showToast('No valid emails found', 'error');
  if (!state.apiKey) {
    showToast('Set your API key first', 'error');
    document.getElementById('api-key-drawer').classList.remove('hidden');
    return;
  }
  if (state.bulkEmails.length > 500) {
    return showToast('Maximum 500 emails per job', 'error');
  }
  await ingestEmails(state.bulkEmails);
}

// ── Ingest ────────────────────────────────────────────────────────────────────
async function ingestEmails(emails) {
  try {
    const res = await apiFetch('/api/ingest', {
      method: 'POST',
      body: JSON.stringify({ emails }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast(body.error || `Ingest failed (${res.status})`, 'error');
    }

    const data = await res.json();
    state.jobId = data.job_id;
    localStorage.setItem('lv_job_id', data.job_id);

    showToast(`Queued ${data.queued} email${data.queued === 1 ? '' : 's'}`, 'success');
    showDashboard();
    showResults();
    startPolling();
  } catch (err) {
    showToast(`Network error: ${err.message}`, 'error');
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  if (state.pollingTimer) clearInterval(state.pollingTimer);
  pollNow();
  state.pollingTimer = setInterval(pollNow, 3000);
}

function stopPolling() {
  if (state.pollingTimer) {
    clearInterval(state.pollingTimer);
    state.pollingTimer = null;
  }
}

async function pollNow() {
  if (!state.jobId) return;
  try {
    const res = await apiFetch(`/api/status/${state.jobId}`);
    if (!res.ok) return;
    const data = await res.json();
    updateDashboard(data);

    if (data.status === 'completed') {
      stopPolling();
      markJobComplete(data);
      localStorage.removeItem('lv_job_id');
    }

    // Refresh results table
    await fetchRecords(state.currentPage);
  } catch (err) {
    // Silent — network blip during polling is normal
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function showDashboard() {
  document.getElementById('dashboard-section').classList.remove('hidden');
}

function showResults() {
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('table-loading').classList.remove('hidden');
}

function updateDashboard(data) {
  const { total, completed, verified, manual_review, errors, status, created_at } = data;
  const pending = total - completed;

  document.getElementById('stat-pending').textContent = pending >= 0 ? pending : '—';
  document.getElementById('stat-verified').textContent = verified ?? '—';
  document.getElementById('stat-manual').textContent = manual_review ?? '—';
  document.getElementById('stat-errors').textContent = errors ?? '—';

  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-label').textContent = `${completed} / ${total} processed`;
  document.getElementById('progress-pct').textContent = pct + '%';

  // Time
  if (created_at) {
    document.getElementById('job-time').textContent = formatRelativeTime(created_at);
  }
}

function markJobComplete(data) {
  const pill = document.getElementById('job-status-pill');
  pill.className = 'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20';
  pill.innerHTML = `
    <div class="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
    <span>Completed</span>
  `;
  showToast(`Job complete — ${data.verified} verified, ${data.manual_review} for review`, 'success');
}

// ── Records Table ─────────────────────────────────────────────────────────────
async function fetchRecords(page = 0) {
  if (!state.jobId) return;
  try {
    const res = await apiFetch(`/api/records/${state.jobId}?page=${page}`);
    if (!res.ok) return;
    const data = await res.json();

    state.allRecords = data.records;
    state.totalRecords = data.total;
    state.currentPage = page;
    state.filteredRecords = applyFilter(state.allRecords, document.getElementById('table-search').value);

    renderTable(state.filteredRecords);
    updatePagination(data);
    document.getElementById('table-loading').classList.add('hidden');
  } catch (err) {
    // silent
  }
}

function applyFilter(records, query) {
  if (!query) return records;
  const q = query.toLowerCase();
  return records.filter(r =>
    r.email?.toLowerCase().includes(q) ||
    r.linkedin_url?.toLowerCase().includes(q) ||
    r.qa_reason?.toLowerCase().includes(q)
  );
}

function filterTable(query) {
  state.filteredRecords = applyFilter(state.allRecords, query);
  renderTable(state.filteredRecords);
  const empty = document.getElementById('table-empty');
  empty.classList.toggle('hidden', state.filteredRecords.length > 0);
}

function renderTable(records) {
  const tbody = document.getElementById('results-tbody');
  if (records.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('table-empty').classList.remove('hidden');
    return;
  }
  document.getElementById('table-empty').classList.add('hidden');
  tbody.innerHTML = records.map(r => renderRow(r)).join('');
}

function renderRow(r) {
  const statusBadge = getStatusBadge(r.status);
  const linkedinCell = r.linkedin_url
    ? `<a href="${escapeHtml(r.linkedin_url)}" target="_blank" rel="noopener noreferrer"
         class="flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 transition-colors group">
         <span class="truncate max-w-[180px]">${escapeHtml(r.linkedin_url.replace('https://www.linkedin.com/in/', '').replace(/\/$/, ''))}</span>
         <svg class="shrink-0 opacity-60 group-hover:opacity-100" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
           <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
         </svg>
       </a>`
    : '<span class="text-zinc-600">—</span>';

  const reasonText = r.qa_reason || r.meta_title || '—';
  const reasonCell = `<div class="tooltip relative max-w-[200px]">
    <span class="truncate block text-zinc-500 text-xs cursor-default">${escapeHtml(reasonText.slice(0, 40))}${reasonText.length > 40 ? '…' : ''}</span>
    ${reasonText.length > 40 ? `<div class="tooltip-text absolute z-10 left-0 bottom-full mb-1 w-64 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 shadow-xl">${escapeHtml(reasonText)}</div>` : ''}
  </div>`;

  return `<tr class="border-b border-zinc-800/60 hover:bg-zinc-800/30">
    <td class="px-4 py-3 shrink-0">${statusBadge}</td>
    <td class="px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-zinc-300 text-sm">${escapeHtml(r.email)}</span>
        <button onclick="copyToClipboard('${escapeHtml(r.email)}')" title="Copy" class="text-zinc-600 hover:text-zinc-400 transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>
    </td>
    <td class="px-4 py-3">${linkedinCell}</td>
    <td class="px-4 py-3">${reasonCell}</td>
    <td class="px-4 py-3">
      ${['manual_review', 'error'].includes(r.status) ? `
      <button onclick="retryRecord('${r.id}')" title="Retry" class="text-xs text-zinc-500 hover:text-indigo-400 transition-colors flex items-center gap-1">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
        </svg>
        Retry
      </button>` : '<span class="text-zinc-700">—</span>'}
    </td>
  </tr>`;
}

function getStatusBadge(status) {
  const map = {
    pending:       'bg-zinc-800 text-zinc-400 border-zinc-700',
    processing:    'bg-blue-950 text-blue-400 border-blue-800',
    verified:      'bg-emerald-950 text-emerald-400 border-emerald-800',
    manual_review: 'bg-amber-950 text-amber-400 border-amber-800',
    error:         'bg-rose-950 text-rose-400 border-rose-800',
  };
  const label = {
    pending:       'Pending',
    processing:    'Processing',
    verified:      'Verified',
    manual_review: 'Review',
    error:         'Error',
  };
  const cls = map[status] || 'bg-zinc-800 text-zinc-400 border-zinc-700';
  return `<span class="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${cls}">${label[status] || status}</span>`;
}

function updatePagination(data) {
  const pag = document.getElementById('pagination');
  const info = document.getElementById('pagination-info');
  const prev = document.getElementById('prev-page');
  const next = document.getElementById('next-page');

  if (data.total > data.page_size) {
    pag.classList.remove('hidden');
    const from = data.page * data.page_size + 1;
    const to = Math.min(from + data.page_size - 1, data.total);
    info.textContent = `${from}–${to} of ${data.total}`;
    prev.disabled = data.page === 0;
    next.disabled = !data.has_more;
  } else {
    pag.classList.add('hidden');
  }
}

function changePage(delta) {
  const newPage = state.currentPage + delta;
  if (newPage < 0) return;
  fetchRecords(newPage);
}

// ── Retry ─────────────────────────────────────────────────────────────────────
async function retryRecord(recordId) {
  try {
    const res = await apiFetch(`/api/retry/${recordId}`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast(body.error || 'Retry failed', 'error');
    }
    showToast('Record queued for retry', 'success');
    // Refresh table and restart polling if needed
    await fetchRecords(state.currentPage);
    if (!state.pollingTimer) startPolling();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ── Export CSV ────────────────────────────────────────────────────────────────
async function exportCsv() {
  if (!state.jobId) return;
  const url = `/api/export/${state.jobId}`;
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `job-${state.jobId.slice(0, 8)}.csv`);
  // Attach auth header via a fetch + blob trick
  try {
    const res = await apiFetch(url);
    if (!res.ok) return showToast('Export failed', 'error');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    link.href = blobUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
    showToast('CSV downloaded', 'success');
  } catch (err) {
    showToast(`Export error: ${err.message}`, 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': state.apiKey,
      ...(options.headers || {}),
    },
  });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function formatRelativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const colors = {
    success: 'bg-emerald-900/90 border-emerald-700 text-emerald-100',
    error:   'bg-rose-900/90 border-rose-700 text-rose-100',
    info:    'bg-zinc-800/90 border-zinc-700 text-zinc-100',
  };
  const icons = {
    success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };

  const toast = document.createElement('div');
  toast.className = `pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-xl text-sm font-medium max-w-xs toast-enter ${colors[type] || colors.info}`;
  toast.innerHTML = `${icons[type] || icons.info}<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('toast-enter');
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3500);
}

// Expose globals called from HTML onclick attributes
window.toggleApiKeyDrawer = toggleApiKeyDrawer;
window.handleApiKeyInput = handleApiKeyInput;
window.clearApiKey = clearApiKey;
window.switchTab = switchTab;
window.submitSingle = submitSingle;
window.submitBulk = submitBulk;
window.handleDrop = handleDrop;
window.handleFileInput = handleFileInput;
window.parseBulkInput = parseBulkInput;
window.exportCsv = exportCsv;
window.retryRecord = retryRecord;
window.filterTable = filterTable;
window.changePage = changePage;
window.copyToClipboard = copyToClipboard;
