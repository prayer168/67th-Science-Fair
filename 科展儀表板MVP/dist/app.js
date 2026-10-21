const $ = (selector, root = document) => root.querySelector(selector);
const state = { config: null, teacher: null, dashboard: null, oauthClient: null, toastTimer: null };
const allRoutes = ['home', 'guide', 'rules', 'workbook', 'diary', 'teacher'];
function csrfHeaders() {
  const token = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('sf_csrf='))?.slice('sf_csrf='.length) || '';
  return { 'content-type': 'application/json', 'x-csrf-token': token };
}

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function route() {
  const name = location.hash.slice(1) || 'home';
  const active = allRoutes.includes(name) ? name : 'home';
  for (const routeName of allRoutes) {
    $(`#page-${routeName}`).classList.toggle('active', routeName === active);
    const nav = $(`[data-route="${routeName}"]`);
    if (nav) nav.classList.toggle('active', routeName === active);
  }
  $('.main-nav').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (active === 'teacher') refreshAuth();
}
function setLoginMessage(message, kind = '') {
  const el = $('#login-message'); el.textContent = message; el.className = `inline-message ${kind}`;
}
function showTeacher(signedIn) {
  $('#teacher-login').hidden = signedIn;
  $('#teacher-dashboard').hidden = !signedIn;
  $('.teacher-disclaimer').hidden = signedIn;
}
async function refreshAuth() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    state.teacher = data.signedIn ? data.teacher : null;
    showTeacher(Boolean(state.teacher));
    if (state.teacher) await loadDashboard();
    else initializeGoogleLogin();
  } catch {
    setLoginMessage('無法連線到本機伺服器，請確認網站仍在執行。', 'error');
  }
}
async function initializeGoogleLogin() {
  const config = state.config;
  const slot = $('#google-login-button');
  if (!config?.authReady || !config.googleClientId) {
    setLoginMessage('登入尚未設定：請先完成 .env.local 的 Google OAuth Client ID 與教師帳號名單。');
    return;
  }
  let attempts = 0;
  const render = () => {
    if (!window.google?.accounts?.id) {
      if (++attempts < 50) return setTimeout(render, 120);
      setLoginMessage('Google 登入元件載入失敗，請檢查網路連線或 OAuth 網域設定。', 'error');
      return;
    }
    window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: handleGoogleLogin, ux_mode: 'popup' });
    slot.replaceChildren();
    window.google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', logo_alignment: 'left', width: 250 });
    setLoginMessage('僅允許設定名單中的教師帳號登入。');
  };
  render();
}
async function handleGoogleLogin(response) {
  setLoginMessage('正在向本機伺服器驗證教師帳號…');
  try {
    const result = await fetch('/api/auth/google', { method: 'POST', credentials: 'same-origin', headers: csrfHeaders(), body: JSON.stringify({ credential: response.credential }) });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error === 'account_not_allowed' ? '此 Google 帳號不在教師授權名單中。' : '登入驗證失敗，請重新登入。');
    state.teacher = data.teacher; showTeacher(true); await loadDashboard(); toast('教師登入成功');
  } catch (error) { setLoginMessage(error.message || '登入失敗。', 'error'); }
}
function apiStatus(config) {
  const items = [
    ['Google 教師登入', config.authReady, config.authReady ? '已設定' : '尚未設定'],
    ['Classroom／Drive 同步', config.classroomReady, config.classroomReady ? '已設定' : '尚未設定'],
    ['AI 草稿服務', config.aiReady, config.aiReady ? '已設定' : '尚未設定']
  ];
  $('#provider-status').innerHTML = items.map(([name, ok, value]) => `<span class="provider-item"><i class="${ok ? 'ok' : ''}"></i><strong>${escapeHtml(name)}</strong><small>${escapeHtml(value)}</small></span>`).join('');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function localDate(date) {
  if (!date) return '—';
  const parsed = new Date(date);
  return Number.isNaN(parsed.valueOf()) ? '—' : new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'short' }).format(parsed);
}
function statusClass(status) {
  if (status === '未繳交' || status === '已撤回') return 'missing';
  if (status === '已退回') return 'returned';
  if (status.includes('待')) return 'pending';
  return '';
}
function renderSubmissions(rows) {
  const wrap = $('#submission-table-wrap');
  if (!rows?.length) {
    wrap.innerHTML = `<div class="empty-state"><span class="empty-icon">▤</span><strong>${state.dashboard?.dataConfigured ? '目前沒有可顯示的提交' : '尚未取得作業資料'}</strong><p>${state.dashboard?.dataConfigured ? '請確認課程內有已發布作業，或查看待確認清單。' : '完成 Google 連線設定後，按「立即同步」讀取 Classroom。'}</p></div>`;
    return;
  }
  const search = ($('#submission-search').value || '').trim().toLowerCase();
  const filtered = rows.filter(row => `${row.assignment} ${row.alias} ${row.status}`.toLowerCase().includes(search));
  if (!filtered.length) { wrap.innerHTML = '<div class="empty-state"><strong>找不到符合的項目</strong><p>請調整搜尋文字。</p></div>'; return; }
  wrap.innerHTML = `<table class="submission-table"><thead><tr><th>作業</th><th>匿名代號</th><th>狀態</th><th>更新時間</th><th>Drive 副本</th></tr></thead><tbody>${filtered.map(row => {
    const links = (row.driveFiles || []).map(file => `<a class="file-link" href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.name)}</a>`).join('<br>') || '—';
    const source = row.sourceUrl && /^https:\/\/classroom\.google\.com\//.test(row.sourceUrl) ? `<a class="file-link" href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.assignment)}</a>` : escapeHtml(row.assignment);
    return `<tr><td>${source}</td><td>${escapeHtml(row.alias)}</td><td><span class="status-chip ${statusClass(row.status)}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(localDate(row.updatedAt))}</td><td>${links}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function renderPending(items) {
  $('#pending-count').textContent = String(items?.length || 0);
  $('#stat-pending').textContent = String(items?.length || 0);
  $('#pending-list').innerHTML = items?.length ? items.map(item => `<article class="pending-item"><strong>${escapeHtml(item.alias || '待確認')} · ${escapeHtml(item.assignment || '')}</strong><p>${escapeHtml(item.reason || '需要教師確認')}</p></article>`).join('') : '<div class="small-empty">目前沒有待確認項目</div>';
}
function renderHistory(runs) {
  $('#sync-history').innerHTML = runs?.length ? runs.slice(0, 5).map(run => `<div class="history-item"><span>${escapeHtml(localDate(run.at))}<br><small>${escapeHtml(run.course || '67 屆科展')}${run.reason ? ` · ${escapeHtml(run.reason)}` : ''}</small></span><span><strong>${escapeHtml(run.copied)} 份副本</strong><br><small>${escapeHtml(run.pending)} 項待確認</small></span><span class="history-state">${escapeHtml(run.state)}</span></div>`).join('') : '<div class="small-empty">尚無同步紀錄</div>';
  $('#last-sync').textContent = runs?.length ? `最近同步：${localDate(runs[0].at)} · ${runs[0].state}` : '尚未同步';
}
function renderDrafts(drafts) {
  $('#ai-status-pill').textContent = state.dashboard?.aiReady ? 'AI 已設定' : '尚未設定 AI';
  $('#draft-list').innerHTML = drafts?.length ? drafts.map(draft => `<article class="draft-item"><strong>${escapeHtml(draft.title || '未命名草稿')}</strong><p>${escapeHtml(draft.status || '待教師確認')} · ${escapeHtml(draft.summary || '')}</p>${draft.status === '待教師確認' ? `<label class="draft-label">摘要<textarea data-summary="${escapeHtml(draft.id)}">${escapeHtml(draft.summary || '')}</textarea></label><label class="draft-label">日誌草稿<textarea data-content="${escapeHtml(draft.id)}">${escapeHtml(draft.content || '')}</textarea></label><div class="draft-review-notes"><strong>待核事項</strong><ul>${(draft.reviewNotes || []).map(note => `<li>${escapeHtml(note)}</li>`).join('') || '<li>請對照原始實驗紀錄補足日期、地點與觀察。</li>'}</ul></div><div class="draft-actions"><button class="button button-outline" data-save="${escapeHtml(draft.id)}">儲存修訂</button><button class="button button-dark" data-approve="${escapeHtml(draft.id)}">確認草稿</button></div>` : draft.status === '已確認待發布' ? `<details class="draft-preview"><summary>檢視已確認內容</summary><p>${escapeHtml(draft.content || '')}</p></details><div class="draft-actions"><button class="button button-dark" data-publish="${escapeHtml(draft.id)}">確認發布</button></div>` : `<details class="draft-preview"><summary>檢視已發布內容</summary><p>${escapeHtml(draft.content || '')}</p></details>`}</article>`).join('') : '<div class="small-empty">尚無草稿；AI 未連線時不會產生假草稿。</div>';
}
function renderDashboard(data) {
  state.dashboard = data;
  $('#signed-in-as').textContent = `已登入：${data.teacher?.email || ''}`;
  apiStatus({ authReady: true, classroomReady: data.classroomReady, aiReady: data.aiReady });
  const rows = data.submissions || [];
  const assignments = data.assignments?.length || new Set(rows.map(r => r.assignment)).size;
  $('#stat-assignments').textContent = String(assignments || 0);
  $('#stat-submitted').textContent = String(rows.filter(r => ['已繳交', '已退回'].includes(r.status)).length);
  $('#stat-missing').textContent = String(rows.filter(r => ['未繳交', '已撤回'].includes(r.status)).length);
  renderSubmissions(rows); renderPending(data.pending || []); renderHistory(data.syncRuns || []); renderDrafts(data.drafts || []);
  const ledgerLink = $('#reward-ledger-link');
  ledgerLink.hidden = !data.rewardLedgerReady;
  $('#ledger-status-pill').textContent = data.rewardLedgerReady ? '已連結教師專用檔案' : '尚未設定／找不到檔案';
  $('#ledger-message').textContent = data.rewardLedgerReady
    ? '檔案由登入後的伺服器唯讀提供；重新啟動或切換裝置前，請確認本機路徑設定。'
    : '請設定本機 .env.local 的 TEACHER_REWARD_LEDGER_PATH；目前不會提供任何活頁簿資料。';
  $('#sync-button').disabled = !data.classroomReady;
  if (!data.classroomReady) showSyncMessage('尚未連線：請設定 Classroom 課程 ID、Drive 歸檔資料夾 ID，並確認教師測試帳號排除清單。', true);
}
async function loadDashboard() {
  const response = await fetch('/api/teacher/dashboard', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) { state.teacher = null; showTeacher(false); return; }
  if (!response.ok) throw new Error('dashboard_unavailable');
  renderDashboard(await response.json());
}
function showSyncMessage(message, isError = false) {
  const el = $('#sync-message'); el.hidden = false; el.textContent = message; el.classList.toggle('error', isError);
}
function googleScope() {
  return [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.students.readonly',
    'https://www.googleapis.com/auth/classroom.rosters.readonly',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email'
  ].join(' ');
}
function getClassroomAccessToken() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2 || !state.config?.googleClientId) return reject(new Error('Google API 授權尚未設定。'));
    state.oauthClient ||= window.google.accounts.oauth2.initTokenClient({
      client_id: state.config.googleClientId,
      scope: googleScope(),
      prompt: 'select_account consent',
      callback: result => result.error ? reject(new Error('Google API 授權未完成。')) : resolve(result.access_token)
    });
    state.oauthClient.requestAccessToken();
  });
}
async function synchronize() {
  const button = $('#sync-button'); button.disabled = true; button.innerHTML = '<span class="sync-icon spin">↻</span>正在同步';
  showSyncMessage('正在向 Google 申請必要授權…');
  try {
    const accessToken = await getClassroomAccessToken();
    showSyncMessage('正在讀取 Classroom 提交並建立 Drive 副本；原始附件不會被移動或修改。');
    const response = await fetch('/api/teacher/sync', { method: 'POST', credentials: 'same-origin', headers: csrfHeaders(), body: JSON.stringify({ accessToken }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '同步未完成，請檢查設定與權限。');
    renderDashboard({ ...state.dashboard, submissions: data.submissions, pending: data.pending, syncRuns: [data.run, ...(state.dashboard.syncRuns || [])], assignments: data.assignments.map(title => ({ title })), dataConfigured: true });
    showSyncMessage(`同步${data.run.state}：建立 ${data.run.copied} 份副本，略過 ${data.run.skipped} 份既有副本，${data.run.pending} 項待確認。`);
  } catch (error) {
    showSyncMessage(error.message || '同步未完成；尚未確認成功的項目不會標為完成。', true);
    try { await loadDashboard(); } catch { /* Keep the visible sync error if the session expired. */ }
  } finally {
    button.disabled = !state.dashboard?.classroomReady;
    button.innerHTML = '<span class="sync-icon">↻</span>立即同步';
  }
}
async function generateDraft() {
  const el = $('#ai-message'); el.textContent = '正在檢查 AI 服務設定…';
  try {
    const response = await fetch('/api/teacher/drafts', { method: 'POST', credentials: 'same-origin', headers: csrfHeaders(), body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'AI 服務尚未就緒。');
    el.textContent = '草稿已建立，狀態為待教師確認。'; await loadDashboard();
  } catch (error) { el.textContent = error.message; }
}
async function draftAction(id, action) {
  if (action === 'publish' && !window.confirm('確認將這份草稿發布到本儀表板的公開科展日誌？')) return;
  const summary = action === 'approve' ? $(`[data-summary="${CSS.escape(id)}"]`)?.value || '' : undefined;
  const content = action === 'approve' ? $(`[data-content="${CSS.escape(id)}"]`)?.value || '' : undefined;
  const payload = action === 'approve' ? JSON.stringify({ summary, content }) : '{}';
  const response = await fetch(`/api/teacher/drafts/${encodeURIComponent(id)}/${action}`, { method: 'POST', credentials: 'same-origin', headers: csrfHeaders(), body: payload });
  const result = await response.json();
  if (!response.ok) return toast('此草稿無法執行該操作。');
  toast(action === 'approve' ? '已標記確認；發布仍需再次確認。' : '已發布。');
  await loadDashboard();
}
async function saveDraft(id) {
  const summary = $(`[data-summary="${CSS.escape(id)}"]`)?.value || '';
  const content = $(`[data-content="${CSS.escape(id)}"]`)?.value || '';
  const response = await fetch(`/api/teacher/drafts/${encodeURIComponent(id)}`, { method: 'PUT', credentials: 'same-origin', headers: csrfHeaders(), body: JSON.stringify({ summary, content }) });
  const result = await response.json();
  if (!response.ok) return toast('草稿修訂未儲存，請重試。');
  toast('修訂已儲存。'); await loadDashboard();
}
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: csrfHeaders(), body: '{}' });
  state.teacher = null; state.dashboard = null; showTeacher(false); setLoginMessage('已登出。'); initializeGoogleLogin();
}
async function loadPublicJournal() {
  const response = await fetch('/api/public/journal', { cache: 'no-store' });
  if (!response.ok) return;
  const data = await response.json();
  const link = $('#diary-link');
  if (state.config?.diaryUrl) link.href = state.config.diaryUrl;
  const container = $('#published-journal');
  container.innerHTML = data.entries?.length ? `<div class="eyebrow">TEACHER REVIEWED · LOCAL JOURNAL</div>${data.entries.map(entry => `<article class="public-entry"><div class="public-entry-date">${escapeHtml(entry.date || '')}</div><h3>${escapeHtml(entry.title || '')}</h3><p class="public-entry-summary">${escapeHtml(entry.summary || '')}</p><details><summary>閱讀日誌內容</summary><p>${escapeHtml(entry.content || '')}</p></details></article>`).join('')}` : '';
  return data.entries;
}

$('#menu-toggle').addEventListener('click', () => {
  const nav = $('.main-nav'); const open = nav.classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open));
});
window.addEventListener('hashchange', route);
$('#sync-button').addEventListener('click', synchronize);
$('#logout-button').addEventListener('click', logout);
$('#generate-draft-button').addEventListener('click', generateDraft);
$('#submission-search').addEventListener('input', () => renderSubmissions(state.dashboard?.submissions || []));
$('#draft-list').addEventListener('click', event => {
  const button = event.target.closest('[data-save], [data-approve], [data-publish]');
  if (button?.dataset.save) saveDraft(button.dataset.save);
  if (button?.dataset.approve) draftAction(button.dataset.approve, 'approve');
  if (button?.dataset.publish) draftAction(button.dataset.publish, 'publish');
});
fetch('/api/config', { cache: 'no-store' }).then(r => r.json()).then(async config => {
  state.config = config;
  await loadPublicJournal();
  if (location.hash.slice(1) === 'teacher') await refreshAuth();
  route();
}).catch(() => {
  route();
  if (location.hash === '#teacher') setLoginMessage('本機伺服器無回應，請確認網站已啟動。', 'error');
});
