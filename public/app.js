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
  completionShown: false,
};

// ── Initialise ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initializeApiKey();

  // Resume job from localStorage if page was refreshed mid-run
  const savedJob = localStorage.getItem('lv_job_id');
  if (savedJob && state.apiKey) {
    state.jobId = savedJob;
    showDashboard();
    startPolling();
  }
});

// ── API Key (from environment/server) ─────────────────────────────────────────
async function initializeApiKey() {
  // Try to fetch API key from a secure backend endpoint
  // For now, read from localStorage for backward compatibility
  if (!state.apiKey && localStorage.getItem('lv_api_key')) {
    state.apiKey = localStorage.getItem('lv_api_key');
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

// ── Single submit — instant inline API (result in <10s) ─────────────────────
async function submitSingle() {
  const email = document.getElementById('single-email-input').value.trim();
  if (!email) return showToast('Enter an email address', 'error');
  if (!email.includes('@')) return showToast('Invalid email format', 'error');
  if (!state.apiKey) return showToast('API key not configured', 'error');

  const btn = document.getElementById('verify-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="inline-flex items-center gap-2"><svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>Searching</span>'; }

  showInstantLoading(email);
  const start = Date.now();

  try {
    const res = await apiFetch('/api/verify-instant', { method: 'POST', body: JSON.stringify({ email }) });
    renderInstantResult(await res.json(), Date.now() - start);
  } catch (err) {
    renderInstantResult({ status: 'error', email, reason: err.message, candidates: [] }, Date.now() - start);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Verify'; }
  }
}

function getOrCreatePanel() {
  let p = document.getElementById('instant-result-panel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'instant-result-panel';
    const ref = document.getElementById('ingest-section');
    if (ref?.parentNode) ref.parentNode.insertBefore(p, ref.nextSibling);
    else document.querySelector('main')?.appendChild(p) || document.body.appendChild(p);
  }
  p.classList.remove('hidden');
  return p;
}

function showInstantLoading(email) {
  const p = getOrCreatePanel();
  p.className = 'mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/70 backdrop-blur-sm overflow-hidden';
  p.innerHTML = `
    <div class="p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="relative w-8 h-8">
          <div class="absolute inset-0 rounded-full border-2 border-indigo-500/20"></div>
          <div class="absolute inset-0 rounded-full border-2 border-transparent border-t-indigo-500 animate-spin"></div>
        </div>
        <div>
          <p class="text-sm font-medium text-zinc-200">Searching for LinkedIn profile</p>
          <p class="text-xs text-zinc-500">${escapeHtml(email)}</p>
        </div>
      </div>
      <div class="space-y-2.5">
        <div class="flex items-center gap-3"><div class="h-3 bg-zinc-800 rounded-full animate-pulse w-2/3"></div><div class="h-3 bg-zinc-800 rounded-full animate-pulse w-16"></div></div>
        <div class="flex items-center gap-3"><div class="h-3 bg-zinc-800 rounded-full animate-pulse w-1/2"></div><div class="h-3 bg-zinc-800 rounded-full animate-pulse w-20"></div></div>
        <div class="flex items-center gap-3"><div class="h-3 bg-zinc-800 rounded-full animate-pulse w-3/5"></div><div class="h-3 bg-zinc-800 rounded-full animate-pulse w-14"></div></div>
      </div>
      <p class="text-[11px] text-zinc-600 mt-4">Querying Google, Serper, Apollo, and 7 other sources...</p>
    </div>`;
}

function renderInstantResult(data, elapsedMs) {
  const p = getOrCreatePanel();
  const sec = (elapsedMs / 1000).toFixed(1);
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
  const candidates = data.candidates || [];
  const best = candidates.find(c => c.verified) || null;
  const others = candidates.filter(c => c !== best);

  // Hide the old job dashboard if it's showing from a previous queue-based submit
  const dash = document.getElementById('dashboard-section');
  if (dash) dash.classList.add('hidden');
  const results = document.getElementById('results-section');
  if (results) results.classList.add('hidden');

  // Status header
  const isVerified = data.status === 'verified' && best;
  const hasCandidates = candidates.length > 0;

  const headerBg = isVerified ? 'from-emerald-950/40 to-zinc-900/0' : hasCandidates ? 'from-blue-950/30 to-zinc-900/0' : 'from-zinc-800/30 to-zinc-900/0';
  const headerIcon = isVerified
    ? '<svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>'
    : hasCandidates
      ? '<svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>'
      : '<svg class="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';

  const statusLabel = isVerified ? 'Match Found' : hasCandidates ? `${candidates.length} Profile${candidates.length > 1 ? 's' : ''} Found` : 'No Profiles Found';
  const statusColor = isVerified ? 'text-emerald-400' : hasCandidates ? 'text-blue-400' : 'text-zinc-500';

  // Build verified result card
  const bestCard = best ? buildCandidateCard(best, true) : '';

  // Build other candidates list
  const otherCards = others.slice(0, 9).map((c, i) => buildCandidateCard(c, false, i + 1)).join('');

  p.className = 'mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/70 backdrop-blur-sm overflow-hidden';
  p.innerHTML = `
    <!-- Header -->
    <div class="bg-gradient-to-r ${headerBg} px-6 py-4 border-b border-zinc-800/80">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          ${headerIcon}
          <div>
            <p class="text-sm font-semibold ${statusColor}">${statusLabel}</p>
            <p class="text-xs text-zinc-500">${name ? escapeHtml(name) : escapeHtml(data.email)}${data.company ? ' at ' + escapeHtml(data.company) : ''}</p>
          </div>
        </div>
        <span class="text-[11px] text-zinc-600 font-mono tabular-nums">${sec}s</span>
      </div>
    </div>

    <div class="p-5 space-y-3">
      ${bestCard}
      ${others.length > 0 ? `
        <div class="pt-2">
          <button onclick="toggleOtherCandidates()" id="toggle-others-btn" class="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            <svg id="toggle-others-icon" class="w-3.5 h-3.5 transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
            <span id="toggle-others-text">${isVerified ? 'Other possible matches' : 'All candidates'} (${others.length})</span>
          </button>
          <div id="other-candidates" class="${isVerified ? 'hidden' : ''} mt-3 space-y-2">
            ${otherCards}
          </div>
        </div>` : ''}

      ${!hasCandidates && data.reason ? `
        <div class="rounded-xl bg-zinc-800/40 border border-zinc-800 px-4 py-3">
          <p class="text-xs text-zinc-500">${escapeHtml(data.reason)}</p>
        </div>` : ''}
    </div>

    <!-- Footer -->
    <div class="px-6 py-3 border-t border-zinc-800/60 flex items-center justify-between">
      <div class="flex items-center gap-2">
        ${!isVerified ? `
          <button onclick="retryInstant('${escapeHtml(data.email)}')"
            class="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-indigo-400 border border-zinc-700 hover:border-indigo-600 rounded-lg px-3 py-1.5 transition-all">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>
            Retry
          </button>` : ''}
      </div>
      <button onclick="document.getElementById('instant-result-panel').classList.add('hidden');document.getElementById('single-email-input').value='';document.getElementById('single-email-input').focus();"
        class="text-xs text-zinc-600 hover:text-zinc-300 transition-colors">
        Search another email
      </button>
    </div>`;
}

function buildCandidateCard(c, isBest, rank) {
  const slug = c.url.replace('https://www.linkedin.com/in/', '').replace(/\/$/, '');
  const confColors = {
    high:   { bg: 'bg-emerald-950/50', border: 'border-emerald-800/50', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-700', label: 'Best Match' },
    medium: { bg: 'bg-blue-950/30',    border: 'border-blue-900/30',    badge: 'bg-blue-500/15 text-blue-400 border-blue-700',       label: 'Possible' },
    low:    { bg: 'bg-zinc-800/30',     border: 'border-zinc-800',       badge: 'bg-zinc-700/40 text-zinc-500 border-zinc-700',       label: 'Unlikely' },
  };
  const conf = confColors[c.confidence] || confColors.low;

  // Extract readable name from title (e.g. "Amin Shaikh - Passionbits | LinkedIn" → "Amin Shaikh")
  const titleName = (c.title || '').split(/\s*[-|–]\s*/)[0].trim();
  const titleCompany = (c.title || '').match(/[-|–]\s*(.+?)(?:\s*[|]\s*LinkedIn)?$/i)?.[1]?.trim() || '';

  return `
    <div class="rounded-xl ${conf.bg} border ${conf.border} p-4 transition-all hover:border-zinc-600 group">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-start gap-3 min-w-0 flex-1">
          <!-- LinkedIn icon -->
          <div class="w-9 h-9 rounded-lg bg-[#0A66C2]/15 flex items-center justify-center shrink-0 mt-0.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="text-[#0A66C2]">
              <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
            </svg>
          </div>
          <div class="min-w-0 flex-1">
            ${titleName ? `<p class="text-sm font-medium text-zinc-200 truncate">${escapeHtml(titleName)}</p>` : ''}
            ${titleCompany ? `<p class="text-xs text-zinc-500 truncate">${escapeHtml(titleCompany)}</p>` : ''}
            <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener"
               class="inline-flex items-center gap-1 text-xs text-indigo-400/80 hover:text-indigo-300 mt-1 transition-colors">
              linkedin.com/in/${escapeHtml(slug)}
              <svg class="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-[10px] font-medium px-2 py-0.5 rounded-full border ${conf.badge}">${conf.label}</span>
          <button onclick="copyToClipboard('${escapeHtml(c.url)}')" title="Copy URL"
            class="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-all">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>
      </div>
      ${c.reason && isBest ? `<p class="text-[11px] text-zinc-600 mt-2 pl-12">${escapeHtml(c.reason)}</p>` : ''}
    </div>`;
}

function toggleOtherCandidates() {
  const el = document.getElementById('other-candidates');
  const icon = document.getElementById('toggle-others-icon');
  if (!el) return;
  el.classList.toggle('hidden');
  if (icon) icon.style.transform = el.classList.contains('hidden') ? '' : 'rotate(180deg)';
}

async function retryInstant(email) {
  document.getElementById('single-email-input').value = email;
  await submitSingle();
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
    showToast('API key not configured', 'error');
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
    state.completionShown = false;
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
      if (!state.completionShown) {
        state.completionShown = true;
        markJobComplete(data);
      }
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
