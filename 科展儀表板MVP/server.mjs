import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

const here = fileURLToPath(new URL('.', import.meta.url));
const staticRoot = resolve(here, 'dist');
const privateRoot = resolve(here, 'data', 'private');
const envPath = join(here, '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const PORT = Number(process.env.PORT || 4173);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TEACHERS = (process.env.TEACHER_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const COURSE_ID = process.env.CLASSROOM_COURSE_ID || '';
const COURSE_NAME = process.env.CLASSROOM_COURSE_NAME || '';
const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT_FOLDER_ID || '';
const REWARD_LEDGER_PATH = process.env.TEACHER_REWARD_LEDGER_PATH || '';
const EXCLUSIONS_CONFIGURED = process.env.EXCLUDED_CLASSROOM_USER_IDS !== undefined && process.env.EXCLUDED_CLASSROOM_USER_IDS.trim() !== '';
const AI_READY = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
const googleAuthClient = new OAuth2Client(CLIENT_ID || undefined);
const sessions = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

mkdirSync(privateRoot, { recursive: true });
const secretPath = join(privateRoot, '.fingerprint-key');
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
const fingerprintKey = readFileSync(secretPath);
const dbPath = join(privateRoot, 'dashboard.json');
function readDb() {
  try { return JSON.parse(readFileSync(dbPath, 'utf8')); }
  catch { return { submissions: [], pending: [], syncRuns: [], drafts: [], published: [] }; }
}
function writeDb(db) {
  const tmp = `${dbPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  renameSync(tmp, dbPath);
}
// Keep the private index local and replace it atomically.

function send(res, status, payload, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(payload));
}
function cookieValue(req, key) {
  return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${key}=`))?.slice(key.length + 1);
}
function sessionFor(req) {
  const raw = cookieValue(req, 'sf_session');
  const session = raw && sessions.get(raw);
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}
function auth(req, res) {
  const session = sessionFor(req);
  if (!session) { send(res, 401, { error: 'unauthorized' }); return null; }
  return session;
}
function sameOrigin(req, res) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const cookieToken = cookieValue(req, 'sf_csrf') || '';
  const headerToken = String(req.headers['x-csrf-token'] || '');
  const sameToken = cookieToken.length === headerToken.length && cookieToken.length >= 32 && timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
  if (!origin || !host || new URL(origin).host !== host || !sameToken) { send(res, 403, { error: 'request_rejected' }); return false; }
  return true;
}
async function bodyJson(req, maxBytes = 2_000_000) {
  let body = ''; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('too_large');
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}
async function verifyGoogleCredential(jwt) {
  const ticket = await googleAuthClient.verifyIdToken({ idToken: String(jwt || ''), audience: CLIENT_ID });
  const claims = ticket.getPayload();
  if (!claims || claims.email_verified !== true) throw new Error('invalid_credential');
  const email = String(claims.email || '').toLowerCase();
  if (!TEACHERS.includes(email)) throw new Error('not_allowed');
  return { email, name: String(claims.name || '教師') };
}
async function apiFetch(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`google_api_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function allPages(url, token, key) {
  const values = [];
  let next;
  do {
    const u = new URL(url);
    if (next) u.searchParams.set('pageToken', next);
    const page = await apiFetch(u, token);
    values.push(...(page[key] || []));
    next = page.nextPageToken;
  } while (next);
  return values;
}
function aliasFromName(name, fallback) {
  const normalized = String(name || '').replace(/\s+/g, '');
  return /^\p{Script=Han}{2,5}$/u.test(normalized) ? `小${[...normalized].at(-1)}` : `待確認_${fallback}`;
}
function safeFolderName(value) {
  return String(value || '未命名作業').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || '未命名作業';
}
function fingerprint(value) { return createHmac('sha256', fingerprintKey).update(value).digest('hex'); }
async function driveFindOrCreateFolder(name, parentId, token, cache) {
  const cacheKey = `${parentId}/${name}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const q = encodeURIComponent(`'${parentId}' in parents and name = '${name.replaceAll("'", "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=100&fields=files(id,name)`, token);
  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await apiFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', token, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    id = created.id;
  }
  cache.set(cacheKey, id);
  return id;
}
async function copyDriveFile(fileId, newName, folderId, token, itemKey) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,webViewLink,parents,appProperties' });
  return apiFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?${params}`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: newName, parents: [folderId], appProperties: { syncFingerprint: itemKey } })
  });
}
async function findArchivedByFingerprint(folderId, itemKey, token) {
  const q = encodeURIComponent(`'${folderId}' in parents and appProperties has { key='syncFingerprint' and value='${itemKey}' } and trashed = false`);
  const result = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=10&fields=files(id,name,mimeType,webViewLink,parents,appProperties)`, token);
  return result.files?.[0] || null;
}
async function createTextFile(name, text, folderId, token, itemKey) {
  const boundary = `sf_${randomBytes(12).toString('hex')}`;
  const metadata = JSON.stringify({ name, mimeType: 'text/plain', parents: [folderId], appProperties: { syncFingerprint: itemKey } });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  return apiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents', token, {
    method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body
  });
}
async function verifyAccessToken(accessToken, expectedEmail) {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error('google_userinfo_failed');
  const user = await r.json();
  if (String(user.email || '').toLowerCase() !== expectedEmail || user.email_verified !== true) throw new Error('account_mismatch');
  return String(user.sub || '');
}
async function createAiDraft() {
  const db = readDb();
  if (!db.lastSyncAt) throw new Error('sync_required');
  const assignments = (db.assignments || []).map((item, index) => {
    const rows = (db.submissions || []).filter(row => row.assignment === item.title);
    return {
      assignment: `課程作業${String(index + 1).padStart(2, '0')}`,
      assigned: rows.length,
      turnedIn: rows.filter(row => ['已繳交', '已退回'].includes(row.status)).length,
      missing: rows.filter(row => ['未繳交', '已撤回'].includes(row.status)).length,
      needsReview: rows.filter(row => row.status.includes('待')).length,
      archivedCopies: rows.reduce((sum, row) => sum + (row.driveFiles?.length || 0), 0)
    };
  });
  const aggregate = {
    course: '67屆科展',
    syncedAt: db.lastSyncAt,
    syncState: db.lastSyncState,
    assignments,
    pendingIssueCount: (db.pending || []).length,
    pendingReasons: [...new Set((db.pending || []).map(item => item.reason))].slice(0, 12)
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL,
      store: false,
      text: { format: { type: 'json_object' } },
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: '你是科展教師的資料整理助理。只依提供的匿名化彙總數據，產生繁體中文的「同步進度摘要」草稿，不能聲稱學生已完成實驗、取得研究結果或發現。說明這只是 Classroom 提交進度，不是研究成果日誌。所有不確定事項列入 reviewNotes，提醒教師補充現場觀察與原始實驗紀錄。輸出 JSON，欄位 title、summary、content、reviewNotes；reviewNotes 為字串陣列。' }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(aggregate) }] }
      ],
      max_output_tokens: 900
    })
  });
  if (!response.ok) throw new Error('ai_provider_failed');
  const result = await response.json();
  const outputText = (result.output || []).flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!outputText) throw new Error('ai_output_empty');
  const generated = JSON.parse(outputText);
  const draft = {
    id: randomUUID(),
    title: String(generated.title || '67 屆科展同步進度摘要').slice(0, 120),
    date: new Date().toISOString().slice(0, 10),
    summary: String(generated.summary || '').slice(0, 1200),
    content: String(generated.content || '').slice(0, 5000),
    reviewNotes: Array.isArray(generated.reviewNotes) ? generated.reviewNotes.map(x => String(x).slice(0, 300)).slice(0, 10) : [],
    status: '待教師確認',
    sourceType: '僅彙整提交狀態',
    createdAt: new Date().toISOString()
  };
  db.drafts.unshift(draft);
  db.drafts = db.drafts.slice(0, 100);
  writeDb(db);
  return draft;
}
async function syncClassroom(session, accessToken) {
  if (!EXCLUSIONS_CONFIGURED) throw new Error('test_account_exclusion_not_confirmed');
  const teacherSubject = await verifyAccessToken(accessToken, session.email);
  const config = await apiFetch(`https://classroom.googleapis.com/v1/courses/${encodeURIComponent(COURSE_ID)}?fields=id,name`, accessToken);
  if (config.name !== COURSE_NAME) throw new Error('classroom_course_name_mismatch');
  const [workItems, students] = await Promise.all([
    allPages(`https://classroom.googleapis.com/v1/courses/${encodeURIComponent(COURSE_ID)}/courseWork?pageSize=100`, accessToken, 'courseWork'),
    allPages(`https://classroom.googleapis.com/v1/courses/${encodeURIComponent(COURSE_ID)}/students?pageSize=100`, accessToken, 'students')
  ]);
  const excluded = new Set((process.env.EXCLUDED_CLASSROOM_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const learnerById = new Map();
  for (const student of students) {
    const id = student.userId;
    const profile = student.profile || {};
    const email = String(profile.emailAddress || '').toLowerCase();
    if (!id || excluded.has(id) || id === teacherSubject || String(profile.id || '') === teacherSubject || email === session.email.toLowerCase()) continue;
    learnerById.set(id, { alias: aliasFromName(profile.name?.fullName, fingerprint(id).slice(0, 6)) });
  }
  const aliasCounts = new Map();
  for (const s of learnerById.values()) aliasCounts.set(s.alias, (aliasCounts.get(s.alias) || 0) + 1);
  const collisions = [...aliasCounts].filter(([alias, count]) => alias.startsWith('小') && count > 1).map(([alias]) => alias);
  const db = readDb();
  const folders = new Map();
  const studentRoot = await driveFindOrCreateFolder('02_學生繳交', ARCHIVE_ROOT, accessToken, folders);
  let copied = 0; let skipped = 0; let failed = 0; let createdRecords = 0;
  const pending = [];
  const assignments = [];
  for (const work of workItems) {
    if (work.state === 'DELETED' || work.state === 'DRAFT') continue;
    assignments.push({ id: work.id, title: work.title || '未命名作業' });
    const submissionFields = 'studentSubmissions(id,userId,state,updateTime,assignmentSubmission(attachments(driveFile(id,title,alternateLink),link(url,title))),shortAnswerSubmission(answer),multipleChoiceSubmission(answer)),nextPageToken';
    const submissionUrl = new URL(`https://classroom.googleapis.com/v1/courses/${encodeURIComponent(COURSE_ID)}/courseWork/${encodeURIComponent(work.id)}/studentSubmissions`);
    submissionUrl.searchParams.set('pageSize', '100');
    submissionUrl.searchParams.set('fields', submissionFields);
    const submissions = await allPages(submissionUrl.toString(), accessToken, 'studentSubmissions');
    const submitByUser = new Map(submissions.map(s => [s.userId, s]));
    const assignedIds = work.assigneeMode === 'INDIVIDUAL_STUDENTS'
      ? (work.individualStudentsOptions?.studentIds || [])
      : [...learnerById.keys()];
    const assignmentFolder = await driveFindOrCreateFolder(safeFolderName(work.title), studentRoot, accessToken, folders);
    for (const userId of assignedIds) {
      const learner = learnerById.get(userId);
      if (!learner) continue;
      const submission = submitByUser.get(userId);
      const state = submission?.state || 'MISSING';
      const status = state === 'TURNED_IN' ? '已繳交' : state === 'RETURNED' ? '已退回' : state === 'RECLAIMED_BY_STUDENT' ? '已撤回' : ['NEW', 'CREATED', 'MISSING'].includes(state) ? '未繳交' : '待確認';
      const rowKey = fingerprint(`${work.id}:${submission?.id || userId}`);
      let row = db.submissions.find(x => x.key === rowKey);
      if (!row) {
        row = { key: rowKey, assignment: safeFolderName(work.title), sourceUrl: `https://classroom.google.com/c/${encodeURIComponent(COURSE_ID)}/a/${encodeURIComponent(work.id)}`, alias: learner.alias, status, updatedAt: submission?.updateTime || null, driveFiles: [] };
        db.submissions.push(row); createdRecords++;
      }
      row.assignment = safeFolderName(work.title);
      row.sourceUrl = `https://classroom.google.com/c/${encodeURIComponent(COURSE_ID)}/a/${encodeURIComponent(work.id)}`;
      row.alias = learner.alias;
      row.status = status;
      row.updatedAt = submission?.updateTime || null;
      if (collisions.includes(learner.alias)) {
        pending.push({ assignment: row.assignment, alias: '匿名代號重複', reason: '同姓末字代號重複，停止歸檔以避免資料混放' });
        continue;
      }
      if (learner.alias.startsWith('待確認_')) {
        pending.push({ assignment: row.assignment, alias: '匿名代號待確認', reason: '無法由名冊確認中文姓名末字，未建立學生資料夾' });
        continue;
      }
      if (!submission || !['TURNED_IN', 'RETURNED', 'RECLAIMED_BY_STUDENT'].includes(state)) continue;
      const aliasFolder = await driveFindOrCreateFolder(learner.alias, assignmentFolder, accessToken, folders);
      const attached = submission.assignmentSubmission?.attachments || [];
      let attachmentNumber = 0;
      for (const attachment of attached) {
        const driveFile = attachment.driveFile;
        if (!driveFile?.id) {
          if (attachment.link?.url) pending.push({ assignment: row.assignment, alias: learner.alias, reason: '含外部連結附件，待教師檢查來源與權限' });
          continue;
        }
        attachmentNumber++;
        const rawTitle = String(driveFile.title || '提交檔案');
        const extension = extname(rawTitle).slice(0, 16);
        const baseName = `${learner.alias}_${safeFolderName(work.title)}_提交`;
        const filename = attached.filter(a => a.driveFile?.id).length > 1 ? `${baseName}_附件${String(attachmentNumber).padStart(2, '0')}${extension}` : `${baseName}${extension}`;
        const itemKey = fingerprint(`${rowKey}:${driveFile.id}:${submission.updateTime || ''}`);
        if (db.submissions.some(r => r.driveFiles?.some(f => f.key === itemKey))) { skipped++; continue; }
        try {
          const existingCopy = await findArchivedByFingerprint(aliasFolder, itemKey, accessToken);
          const copy = existingCopy || await copyDriveFile(driveFile.id, filename, aliasFolder, accessToken, itemKey);
          row.driveFiles.push({ key: itemKey, name: filename, url: copy.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(copy.id)}`, mimeType: copy.mimeType || 'application/octet-stream' });
          if (existingCopy) skipped++; else copied++;
        } catch {
          failed++;
          pending.push({ assignment: row.assignment, alias: learner.alias, reason: '附件副本建立失敗，請檢查來源權限或檔案狀態' });
        }
      }
      const answer = submission.shortAnswerSubmission?.answer ?? (submission.multipleChoiceSubmission?.answer ? `選項：${submission.multipleChoiceSubmission.answer}` : '');
      if (answer) {
        const itemKey = fingerprint(`${rowKey}:short-answer:${submission.updateTime || ''}`);
        if (!db.submissions.some(r => r.driveFiles?.some(f => f.key === itemKey))) {
          try {
            const filename = `${learner.alias}_${safeFolderName(work.title)}_提交.txt`;
            const existingCopy = await findArchivedByFingerprint(aliasFolder, itemKey, accessToken);
            const copy = existingCopy || await createTextFile(filename, answer, aliasFolder, accessToken, itemKey);
            row.driveFiles.push({ key: itemKey, name: filename, url: copy.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(copy.id)}`, mimeType: 'text/plain' });
            if (existingCopy) skipped++; else copied++;
          } catch {
            failed++;
            pending.push({ assignment: row.assignment, alias: learner.alias, reason: '文字副本建立失敗，請檢查目的資料夾權限' });
          }
        }
      }
    }
  }
  db.pending = pending;
  db.assignments = assignments.map(a => ({ title: safeFolderName(a.title) }));
  const run = { at: new Date().toISOString(), course: config.name || '67屆科展', state: failed || pending.length ? '部分完成' : '完成', copied, skipped, failed, pending: pending.length, assignments: assignments.length };
  db.syncRuns.unshift(run); db.syncRuns = db.syncRuns.slice(0, 100);
  db.lastSyncAt = run.at; db.lastAttemptAt = run.at; db.lastSyncState = run.state;
  writeDb(db);
  return { run, submissions: db.submissions, pending: db.pending, assignments: assignments.map(a => a.title), aiReady: AI_READY, createdRecords };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const csrf = randomBytes(32).toString('base64url');
      return send(res, 200, { googleClientId: CLIENT_ID, authReady: Boolean(CLIENT_ID && TEACHERS.length), classroomReady: Boolean(COURSE_ID && COURSE_NAME && ARCHIVE_ROOT && EXCLUSIONS_CONFIGURED), aiReady: AI_READY, diaryUrl: 'https://science-exhibition-production.up.railway.app/' }, { 'set-cookie': `sf_csrf=${csrf}; SameSite=Strict; Path=/; Max-Age=3600` });
    }
    if (req.method === 'GET' && url.pathname === '/api/public/journal') {
      const db = readDb();
      const entries = (db.published || []).filter(item => item.public === true).map(({ title, date, summary, content }) => ({ title, date, summary, content }));
      return send(res, 200, { entries });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/google') {
      if (!sameOrigin(req, res)) return;
      if (!CLIENT_ID || !TEACHERS.length) return send(res, 503, { error: 'auth_not_configured' });
      const body = await bodyJson(req, 20_000);
      try {
        const teacher = await verifyGoogleCredential(body.credential);
        const id = randomBytes(32).toString('base64url');
        sessions.set(id, { ...teacher, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        return send(res, 200, { ok: true, teacher: { email: teacher.email, name: teacher.name } }, { 'set-cookie': `sf_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      } catch (error) {
        return send(res, error.message === 'not_allowed' ? 403 : 401, { error: error.message === 'not_allowed' ? 'account_not_allowed' : 'invalid_google_login' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const session = sessionFor(req);
      return session ? send(res, 200, { signedIn: true, teacher: { email: session.email, name: session.name } }) : send(res, 200, { signedIn: false });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      if (!sameOrigin(req, res)) return;
      const id = cookieValue(req, 'sf_session'); if (id) sessions.delete(id);
      return send(res, 200, { ok: true }, { 'set-cookie': 'sf_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (url.pathname.startsWith('/api/teacher/')) {
      const session = auth(req, res); if (!session) return;
      if (req.method === 'GET' && url.pathname === '/api/teacher/dashboard') {
        const db = readDb();
        return send(res, 200, { teacher: { email: session.email, name: session.name }, dataConfigured: Boolean(db.lastSyncAt), lastSyncAt: db.lastSyncAt || null, lastSyncState: db.lastSyncState || '尚未同步', assignments: db.assignments || [], submissions: db.submissions || [], pending: db.pending || [], syncRuns: db.syncRuns || [], drafts: db.drafts || [], published: db.published || [], classroomReady: Boolean(COURSE_ID && COURSE_NAME && ARCHIVE_ROOT && EXCLUSIONS_CONFIGURED), aiReady: AI_READY, rewardLedgerReady: Boolean(REWARD_LEDGER_PATH && existsSync(REWARD_LEDGER_PATH)) });
      }
      if (req.method === 'GET' && url.pathname === '/api/teacher/reward-ledger') {
        if (!REWARD_LEDGER_PATH || !existsSync(REWARD_LEDGER_PATH)) return send(res, 404, { error: 'reward_ledger_not_configured', message: '教師專用貢獻記錄表尚未設定或目前裝置無法讀取。' });
        const file = statSync(REWARD_LEDGER_PATH);
        if (!file.isFile()) return send(res, 404, { error: 'reward_ledger_unavailable' });
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-length': file.size,
          'content-disposition': "attachment; filename*=UTF-8''%E7%AC%AC67%E5%B1%86%E7%A7%91%E5%B1%95%E5%AD%B8%E7%94%9F%E8%B2%A2%E7%8D%BB%E6%AA%A2%E6%A0%B8%E8%88%87%E7%8D%8E%E5%8B%B5%E8%A8%98%E9%8C%84%E8%A1%A8.xlsx",
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY'
        });
        return createReadStream(REWARD_LEDGER_PATH).pipe(res);
      }
      if (req.method === 'POST' && url.pathname === '/api/teacher/sync') {
        if (!sameOrigin(req, res)) return;
        if (!COURSE_ID || !COURSE_NAME || !ARCHIVE_ROOT || !EXCLUSIONS_CONFIGURED) return send(res, 409, { error: 'classroom_not_configured', message: '尚未設定課程 ID、課程名稱、Drive 歸檔資料夾 ID，或尚未確認教師測試帳號排除清單。' });
        const body = await bodyJson(req, 20_000);
        if (typeof body.accessToken !== 'string' || body.accessToken.length < 40) return send(res, 400, { error: 'google_authorization_required' });
        try { return send(res, 200, await syncClassroom(session, body.accessToken)); }
        catch (error) {
          const status = error.status === 401 || error.status === 403 ? 403 : 502;
          const db = readDb();
          db.syncRuns.unshift({ at: new Date().toISOString(), course: COURSE_NAME || '67屆科展', state: '未完成', copied: '未知', skipped: '未知', failed: '未知', pending: 1, assignments: '未知', reason: 'Google 服務呼叫失敗或授權不足' });
          db.syncRuns = db.syncRuns.slice(0, 100); db.lastAttemptAt = db.syncRuns[0].at; db.lastSyncState = '未完成';
          writeDb(db);
          return send(res, status, { error: 'sync_failed', message: status === 403 ? 'Google 權限不足，請確認帳號及授權範圍。' : '同步未完成，請稍後重試並檢查服務設定。' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/teacher/drafts') {
        if (!sameOrigin(req, res)) return;
        if (!AI_READY) return send(res, 409, { error: 'ai_not_configured', message: '尚未設定 AI 服務；目前不會產生或發布摘要。' });
        try { return send(res, 200, { draft: await createAiDraft() }); }
        catch (error) {
          if (error.message === 'sync_required') return send(res, 409, { error: 'sync_required', message: '請先完成一次成功的 Classroom 同步，再產生資料摘要草稿。' });
          return send(res, 502, { error: 'ai_generation_failed', message: 'AI 草稿未產生；請檢查服務設定後重試。' });
        }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/teacher/drafts/') && url.pathname.endsWith('/approve')) {
        if (!sameOrigin(req, res)) return;
        const id = decodeURIComponent(url.pathname.split('/')[4] || '');
        const body = await bodyJson(req, 20_000);
        const db = readDb(); const draft = db.drafts.find(d => d.id === id);
        if (!draft) return send(res, 404, { error: 'draft_not_found' });
        if (draft.status !== '待教師確認') return send(res, 409, { error: 'draft_not_reviewable' });
        if (typeof body.summary === 'string') draft.summary = body.summary.slice(0, 1200);
        if (typeof body.content === 'string') draft.content = body.content.slice(0, 5000);
        if (!draft.title.trim() || !draft.summary.trim() || !draft.content.trim()) return send(res, 409, { error: 'draft_incomplete' });
        draft.status = '已確認待發布'; draft.reviewedAt = new Date().toISOString(); writeDb(db);
        return send(res, 200, { ok: true, draft });
      }
      if (req.method === 'PUT' && /^\/api\/teacher\/drafts\/[^/]+$/.test(url.pathname)) {
        if (!sameOrigin(req, res)) return;
        const id = decodeURIComponent(url.pathname.split('/')[4] || '');
        const body = await bodyJson(req, 20_000);
        const db = readDb(); const draft = db.drafts.find(d => d.id === id);
        if (!draft || draft.status !== '待教師確認') return send(res, 404, { error: 'draft_not_editable' });
        draft.summary = String(body.summary || '').slice(0, 1200);
        draft.content = String(body.content || '').slice(0, 5000);
        draft.reviewNotes = Array.isArray(body.reviewNotes) ? body.reviewNotes.map(x => String(x).slice(0, 300)).slice(0, 10) : draft.reviewNotes;
        draft.editedAt = new Date().toISOString(); writeDb(db);
        return send(res, 200, { ok: true, draft });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/teacher/drafts/') && url.pathname.endsWith('/publish')) {
        if (!sameOrigin(req, res)) return;
        const id = decodeURIComponent(url.pathname.split('/')[4] || '');
        const db = readDb(); const draft = db.drafts.find(d => d.id === id);
        if (!draft || draft.status !== '已確認待發布') return send(res, 409, { error: 'teacher_review_required' });
        const entry = { id: draft.id, title: draft.title, date: draft.date, summary: draft.summary, content: draft.content, public: true, publishedAt: new Date().toISOString() };
        db.published.push(entry); draft.status = '已發布'; writeDb(db);
        return send(res, 200, { ok: true, entry: { title: entry.title, date: entry.date } });
      }
      return send(res, 404, { error: 'not_found' });
    }
    let path = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
    path = normalize(path).replace(/^[/\\]+/, '');
    const target = resolve(staticRoot, path);
    if ((target !== staticRoot && !target.startsWith(`${staticRoot}${sep}`)) || !existsSync(target)) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream', 'cache-control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://accounts.google.com/gsi/ https://oauth2.googleapis.com https://www.googleapis.com; frame-src https://accounts.google.com/gsi/; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" });
    createReadStream(target).pipe(res);
  } catch {
    if (!res.headersSent) send(res, 400, { error: 'bad_request' }); else res.end();
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`科展儀表板已啟動：http://127.0.0.1:${PORT}`));
