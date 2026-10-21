# 67 屆科展儀表板 MVP

本機執行的繁體中文科展工作站，包含公開指南、第 67 屆研究與作業規範、研究貢獻與獎勵制度摘要、空白作品書與黑熊老師科展日誌入口，以及受 Google 登入保護的教師提交總覽與貢獻記錄表下載。

## 本機啟動

需要 Node.js 20 或更新版本。首次啟動前在此資料夾執行 `npm install` 安裝 Google 登入驗證函式庫；之後執行 `npm start`。

1. 需要教師登入時，先在此資料夾複製 `.env.example` 為 `.env.local`，設定 `TEACHER_EMAILS=prayer@ms.nnkieh.tn.edu.tw` 和 `GOOGLE_CLIENT_ID`。只瀏覽公開頁可略過設定。
2. 雙擊 `啟動科展儀表板.bat`；第一次會安裝必要套件，再啟動網站。也可在 PowerShell 手動執行：

   ```powershell
   npm start
   ```

3. 開啟 <http://127.0.0.1:4173>。若啟動後才修改 `.env.local`，先停止伺服器再重新啟動。

伺服器只綁定 `127.0.0.1`，不會向區域網路公開。停止時在終端機按 `Ctrl+C`。

## Google 登入與 Classroom／Drive 同步

Google Cloud Console 需先建立 OAuth「網頁應用程式」用戶端，啟用 Google Classroom API 與 Google Drive API，並將下列本機網址加入授權的 JavaScript 來源：

- `http://127.0.0.1:4173`
- `http://localhost:4173`（若以 localhost 開啟）

在 `.env.local` 設定：

```text
GOOGLE_CLIENT_ID=你的 OAuth 用戶端 ID
TEACHER_EMAILS=prayer@ms.nnkieh.tn.edu.tw
CLASSROOM_COURSE_ID=Classroom 課程 ID
CLASSROOM_COURSE_NAME=67屆科展
ARCHIVE_ROOT_FOLDER_ID=既有 Classroom同步歸檔 資料夾 ID
EXCLUDED_CLASSROOM_USER_IDS=none
```

若有以學生身分加入課程的教師測試帳號，請將其 Classroom user ID 填入 `EXCLUDED_CLASSROOM_USER_IDS`，以逗號分隔；只有在確認沒有其他測試帳號時才填 `none`。沒有確認排除清單時，伺服器會停止同步。同步也會核對 Classroom 課程名稱必須完全等於 `67屆科展`。

教師點「立即同步」時，瀏覽器會向 Google 要求 Classroom 唯讀及 Drive 建立副本所需授權。Google Workspace 管理員可能需要核准 Classroom／Drive API 與 OAuth 權限。同步只建立副本，不會移動或修改來源附件。歸檔路徑為：

```text
<既有歸檔資料夾>/02_學生繳交/<作業名稱>/<小＋姓名末字>/
```

相同匿名代號發生衝突時會停止該匿名資料夾的附件歸檔並列入待確認；外部連結附件也會列為待確認。姓名無法確認末字時不會建立學生資料夾。同步會在記憶體中比對已登入教師的 Google 唯一識別碼並略過；其他教師測試帳號由排除清單略過，不把這些識別碼寫入同步資料。

## 私人資料保存

- 登入工作階段存在記憶體，伺服器重啟後需重新登入。
- 同步索引與匿名提交狀態只寫入 `data/private/dashboard.json`；此資料夾列入 `.gitignore`，不提供公開靜態檔案存取。
- Drive 副本連結只經教師驗證後的 API 回傳；瀏覽器不會把 Google access token 寫入磁碟。
- 伺服器不記錄學生姓名、電子郵件、Classroom user ID 或提交內容。每份提交以本機 HMAC 指紋做去重。
- 使用者設定的歸檔雲端資料夾擁有者與授權教師都能存取其內容，依既有確認辦理。
- 學生貢獻檢核與獎勵記錄活頁簿不放入 `dist/`。本機 `.env.local` 以 `TEACHER_REWARD_LEDGER_PATH` 設定來源檔路徑，由伺服器在教師登入後唯讀提供下載；跨裝置時需設定該裝置的 Google Drive 同步路徑。`.env.local` 已列入 `.gitignore`。
- 公開頁只呈現制度摘要，不公開個人檢核資料。兩份制度文件目前對評量配分及獎勵門檻有差異：研究與作業規範列 90 分門檻，獎勵制度說明書列 80 分或單項表現突出；請教師核定後再公告或核算。

## AI 與發布流程

教師工作區包含摘要／日誌草稿區、草稿編修、「教師確認」與再次確認發布的步驟。填入 `OPENAI_API_KEY` 和 `OPENAI_MODEL` 後，AI 只會收到匿名的作業序號、彙總提交數與待處理原因，不會收到學生代號、姓名、作答內容、附件或 Drive 連結。產出草稿需教師核對及修訂；發布後會出現在本儀表板的公開日誌頁。若 AI 尚未設定，按鈕會回報未設定，不會產生假草稿。這些摘要只反映作業提交進度，不能當作實驗觀察或研究結果。留言回覆不在本工具內自動處理。

黑熊老師日誌連至現有網站：<https://science-exhibition-production.up.railway.app/>。本 MVP 不複製或修改既有日誌；教師在本儀表板發布的 AI 草稿只會顯示在本機網站的公開日誌區。

## 目前未包含

- 每日排程或 Classroom 即時推播。
- 影片／圖片辨識、資料分析圖表、作品書進度追蹤與跨年度比較。
- 與既有外部黑熊老師日誌網站自動同步發布。
- 主辦單位正式競賽簡章、校內正式核定版本與評分結果；目前公開頁摘要的是教師提供的團隊內部文件，配分與門檻差異仍待教師核定。

## 既有工作區素材

原始文件與實驗紀錄表保留在此專案上一層。公開頁只採用一般研究方法說明，不公開專題實驗紀錄或任何未核可的學生素材。

## 第 67 屆規範與獎勵文件

- 作業規範 PDF 與研究貢獻／獎勵 DOCX 已複製到 `dist/documents/`，供此本機網站公開閱讀與下載；獎勵 DOCX 另轉成 HTML 全文頁。
- 公開規範頁保留精簡導讀，並提供 PDF 完整閱讀及下載、獎勵辦法 HTML 全文與 DOCX 下載。
- 不同來源對配分和獎勵門檻的寫法有差異，網站會並列提醒教師核定，不自動換算學生評分。
- 含個人資料的 XLSX 不放入 `dist/`；只由教師登入後的受保護伺服器端點唯讀下載。
