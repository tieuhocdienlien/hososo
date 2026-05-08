# CHANGELOG

## [Filter 5 khối + Trang chủ] — 2026-05-08 (sau HOTFIX)

### ✨ Thay đổi
- **`app.js:1989`** — FE-fallback gán `gradeKey` từ tên lớp (1A → khoi1, "Lớp 4B" → khoi4...). Trước đó backend không gán → filter chỉ có "Tất cả", không có 5 pill khối; mỗi card không có badge khối. Giờ hiển thị đầy đủ 6 pills + badge color-coded theo CSS đã có sẵn (`khoi1` cam, `khoi2` vàng, `khoi3` xanh lá, `khoi4` xanh dương, `khoi5` tím).
- **Đổi 4 nút "Hồ sơ số" → "Trang chủ"**:
  - `qlcl.html:31` (login screen): `← Về trang Hồ sơ số` → `← Về Trang chủ`
  - `qlcl.html:123` (topbar QLCL): `← Hồ sơ số` → `← Trang chủ`
  - `index.html:1004` (view-qlcl trong HSS): `← Hồ sơ số` → `← Trang chủ`
  - `index.html:3699` (KĐCL React app): `<span>Hồ sơ số</span>` → `<span>Trang chủ</span>` + đổi title
- **Bump cache** → `?v=2026.05.08-grade5` ở cả `index.html` (style.css + app.js) và `qlcl.html` (qlcl-style.css + qlcl-app.js)

### 🛡 Đã verify trước push
- Rà soát toàn bộ: parse5 0 errors trên cả index.html + qlcl.html, syntax OK trên app.js + qlcl-app.js
- 470/470 div balanced trong index.html (không kể JSX), 281/281 trong qlcl.html
- Cross-ref handlers: 85/85 (HSS) + 54/54 (QLCL) đều có định nghĩa

---

## [HOTFIX KĐCL trắng tinh] — 2026-05-08 (cuối ngày)

### 🚨 Bug
KĐCL hoàn toàn trống sau khi đăng nhập — DevTools cho thấy `view-kdcl` + `tdgReactSource` không có trong DOM dù file local + file CDN đều chứa.

### 🔍 Root cause
Modal `#qlNXModal` ở `index.html:1337` **thiếu 2 thẻ `</div>` đóng** (`.ql-modal-panel` + `.ql-modal`). HTML5 parser im lặng tự sửa lỗi → `view-qlcl` "nuốt" từ line 1000 đến `</body>` (line 7484) → toàn bộ phần sau biến mất khỏi DOM.

### ✨ Sửa
- `index.html:1354`: thêm 2 dòng `</div>` đóng modal qlNXModal trước comment `<!-- ⭐ Modal: Ghi nhận vi phạm -->`
- Bump cache version: `?v=2026.05.08-bangtong` → `?v=2026.05.08-fixmodal`

### 🛡 Đã verify trước push
- parse5 walk → body children đầy đủ 7 element (authGate, view-hoso, view-qlcl, **view-kdcl**, tdgReactSource, scrollTopBtn, script)
- view-qlcl giờ đóng đúng tại line 1427 (trước line 1430 mở view-kdcl)

### 📌 Bài học (lưu vào memory)
parse5 báo "0 lỗi" KHÔNG đảm bảo HTML balanced — HTML5 spec yêu cầu parser tự sửa unclosed tag, không trả error. Phải dùng stack-scan div thủ công cho các region modal/popup trước khi push.

---

## [Vá Bảng tổng hợp QLCL] — 2026-05-08 (chiều)

### 🎯 Mục tiêu
Phục hồi 2 hàm thiếu khiến tab "🗒 Bảng tổng hợp" của QLCL không hoạt động — phát hiện trong đợt rà soát trước khi deploy.

### ✨ Thay đổi
- **`app.js`**:
  - Thêm `window.qlReloadBangTong` — load song song NL/PC + Xếp loại + Điểm tất cả môn + Mức môn nhận xét; render mega-grid 1 dòng/HS với cột sticky cho cột "Họ và tên"
  - Thêm hàm helper `renderBangTongSkeleton` — tạo grid với 2 hàng header (group-header + sub-header), color-code theo nhóm môn / NL / PC / xếp loại
  - Thêm `window.qlSaveBangTong` — lưu nhanh Xếp loại + Lên lớp + Nhận xét chung qua action `qlclSaveXepLoai` (tận dụng backend hiện có, không thêm endpoint)
  - Wire-up filter `qlbtNamHoc` + `qlbtLop`: thêm vào `fillNamHocSelects` / `fillLopSelects` / `onDataRefresh` + addEventListener `change` → reload
- **`index.html`**: bump cache version `?v=2026.05.08-modal` → `?v=2026.05.08-bangtong`

### 🛡 Đảm bảo
- Phần điểm/NL/PC/mức môn: **read-only** trong bảng tổng hợp (sửa ở các tab chuyên biệt để tránh xung đột data)
- Edit inline chỉ áp dụng cho 3 cột cuối: Xếp loại CN · Lên lớp · Nhận xét chung
- Tôn trọng `canEditNXLop(lop)` — chỉ BGH hoặc GVCN của lớp mới sửa được
- KHÔNG sửa backend `Code.gs` (action có sẵn đủ dùng)

---

## [Đợt Cleanup + UI tweaks] — 2026-05-08

### 🎯 Mục tiêu
Dọn cấu trúc thư mục, đổi màu nút "Cuối năm" + logo sidebar QLCL, sửa logic Khóa/Mở kỳ, gộp endpoint MOET vào backend.

### ✨ Thay đổi
- **`qlcl-style.css`**:
  - `--p-cn`: `#f43f5e` (đỏ) → `#0d9488` (teal)
  - `.sb-brand-icon`: gradient `#FBBF24→#F59E0B` (vàng/cam) → `#f1f5f9→#cbd5e1` (trắng/bạc)
- **`qlcl-app.js`**:
  - PERIODS `cn.color`: `#c62828` → `#0d9488` (đồng bộ badge)
  - `_toggleLock`: khi MỞ một kỳ → tự khóa 3 kỳ còn lại + `_switchPeriodSilent` sang kỳ đó
  - `_loadLockConfig`: auto-switch `curPeriod` sang kỳ đang mở khi user vào trang (ưu tiên CN > GHK2 > CHK1 > GHK1)
  - Thêm hàm `_switchPeriodSilent` (chuyển kỳ không hiện toast)
- **`qlcl.html`**: bump cache version `?v=2026.05.08-color`
- **`Code.gs`**: gộp `APPS_SCRIPT_ENDPOINT.gs` vào — thêm dispatch action `getKetQuaMOET` trong `doGet` + section MOET SYNC ở cuối file (function `getKetQuaMOET` + helpers `_moetFindIdx`, `_moetNormVN`)
- **Cấu trúc thư mục**: chuyển vào `Data/`: `BACKUP_2026-05-07_PreSSO.gsheet`, `THDienLien_05.2026.gsheet`, `hss-sync-extension-v2.zip`, `HUONG_DAN_CAI.md`, `ROLLBACK_GUIDE.md`. Xóa `APPS_SCRIPT_ENDPOINT.gs` (đã merge vào `Code.gs`).

### 📌 Tác động lên triển khai Apps Script
Sau đợt này, **CHỈ cần dán `Code.gs`** vào Apps Script. Action `getKetQuaMOET` đã sẵn sàng cho extension HSS Sync gọi qua cả GET trực tiếp lẫn `gaspost`.

---

## [Đợt Guest Mode QLCL] — 2026-05-07 (chiều)

### 🎯 Mục tiêu
Bỏ login chặn đầu trang QLCL — vào thẳng app như HSS, click chức năng cần ghi mới popup login. Đoàn KT/phụ huynh xem DSHS công khai mà không cần tài khoản.

### ✨ Thay đổi
- **`qlcl-app.js`**:
  - Thêm `isGuest()`, `needAuth()`, `showLoginScreen()` (helpers global)
  - `needAdmin` mở rộng: chấp nhận role `Hiệu trưởng` (Q2c); fallback `needAuth` khi guest
  - `window.load` — chưa có `_cu` → set CU=guest, gọi `loginOK(true)` (không persist guest CU)
  - `loginOK(isGuestMode)` — set body class `is-guest`; cập nhật avatar/role/badge cho Khách
  - `syncNow` skip khi guest (tránh gọi action cần auth)
  - `_checkSessionExpired` im lặng bỏ qua khi guest (không alert + reload)
- **`qlcl.html`**:
  - Sidebar: 7 tab cần auth thêm class `lock-guest` + onclick `if(needAuth(...))`
  - Footer: chia 2 nhóm `.guest-hide` (đã login) / `.guest-only` (chưa login → nút "🔐 Đăng nhập" lớn)
- **`qlcl-style.css`**: rule `.is-guest` ẩn/hiện 2 nhóm; visual lock 🔒 trên các tab cần auth

### 🧪 Tab phân loại

| Tab | Khách | Đã login |
|---|---|---|
| 👥 Học sinh | ✅ Xem DS, lọc, tìm kiếm | ✅ |
| ✏️ Nhập kết quả | 🔒 popup login | ✅ |
| 📊 Trạng thái | 🔒 popup login | ✅ |
| 📈 Thống kê | 🔒 popup login | ✅ |
| 📋 Quản lý học bạ | 🔒 popup login | ✅ |
| 📤 Xuất báo cáo | 🔒 popup login | ✅ |
| 👥 Phân quyền CBGV | 🔒 popup login | Admin/HT |
| ⚙️ Cài đặt | 🔒 popup login | Admin/HT |

### 📁 File deploy
- Frontend: `qlcl.html`, `qlcl-app.js`, `qlcl-style.css` (push GitHub Pages)
- KHÔNG cần đụng backend (không thay đổi API)

---

## [Đợt SSO — 1 login HSS + QLCL] — 2026-05-07

### 🎯 Mục tiêu
Bỏ login 2 lần (HSS dùng AUTH_TOKEN, QLCL dùng tab Users) → hợp nhất thành **1 lần đăng nhập** qua tab `Users` của Sheet HSS. Trang HSS công khai cho mọi người xem; chỉ khoá khi vào Admin / sửa dữ liệu.

### ✨ Thay đổi
- **Backend `Code.gs`** (~+60 dòng): rewrite `_authCheck_` ưu tiên `body.sessionToken`; map role `admin` + `Hiệu trưởng` → level 'admin' (Q2c); fallback AUTH_TOKEN cũ + audit `legacy_token_used` để theo dõi gỡ dần
- **Frontend `app.js`** (~+90 dòng): `getCU/setCU/_cuLevel` mới dùng key `_cu` (cùng với QLCL); `_hasLevel` ưu tiên CU; popup login đổi thành 2 ô tên+mật khẩu; `callGAS`/`admPostToGAS`/`_postNoCorsToGAS` đính kèm `sessionToken`; `submitAuthForm` gọi action `login` của BE
- **`index.html`**: thêm input `#authPassword` + label `#authLabelPwd` vào modal đăng nhập
- **`qlcl-app.js`**: `_checkSessionExpired` catch cả `needLogin`; `doLogout` redirect về `index.html`
- **`qlcl.html`**: login screen có nút "← Về trang Hồ sơ số"
- Cache version bump `?v=2026.05.07-sso` (cả HTML)

### 🛡 Bảo mật
- 1 username cá nhân cho từng GV → audit log chính xác (KHÔNG còn `AdminDL-2026` chung chung)
- Hash password lazy migration (đã có từ vá A) tiếp tục dùng
- Backwards-compat AUTH_TOKEN cũ giữ 1 tuần → sau đó gỡ

### 🧪 Quyết định kiến trúc đã chốt
- Q1(a): HSS công khai cho xem, click chức năng cần auth thì popup
- Q2(c): `Hiệu trưởng` = full quyền như admin
- Q3(a): Lazy hash — GV tự login lần đầu → password tự upgrade plain → hash
- Q4(a): Giữ AUTH_TOKEN cũ song song 1 tuần
- Q5(a): SSO trước, scope chi tiết server-side để đợt sau

### 📁 File deploy
- Backend: `Code.gs` (paste vào Apps Script editor → triển khai phiên bản mới)
- Frontend: `app.js`, `index.html`, `qlcl.html`, `qlcl-app.js` (push GitHub Pages)
- Hướng dẫn chi tiết: `Data/HUONG_DAN_TRIEN_KHAI_SSO_2026-05-07.md`

---

## [Phương án D-3 — Final] — 2026-05-05

### 🎯 Tóm tắt
Gộp QLCL (template QLCL_V3.0) vào hệ thống Hồ sơ số TH Diễn Liên thành **1 Sheet + 1 Apps Script + 1 URL** duy nhất, theo yêu cầu kiến trúc của anh.

### ✨ Thay đổi
- **`Code.gs` HSS** (+637 dòng): thêm backend QLCL template (action `getGrades`, `saveGrade`, ...) + hàm migration `migrateQlclFromExternal()` copy 9 tab từ Sheet ngoài
- **`qlcl.html`**: API_URL trỏ về URL HSS (cùng URL với index.html)
- **`qlcl-app.js`**: `DEFAULT_GAS` trỏ về URL HSS

### 🏗 Kiến trúc cuối

```
┌─────────────────────────────────────────────────────────────┐
│  GitHub Pages: hososotruonghoc.github.io/tieuhocdienlien/   │
│  • index.html / app.js / style.css      (HSS + KĐCL)         │
│  • qlcl.html / qlcl-app.js / qlcl-style.css   (QLCL)        │
└─────────────────────────────────────────────────────────────┘
                ↓ DÙNG CHUNG ↓
┌─────────────────────────────────────────────────────────────┐
│  1 URL Apps Script HSS (URL hiện tại không đổi)              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  1 Google Sheet HSS — chứa tất cả:                           │
│  • Tab HSS:  Danh muc HSS, DSGV, DS HocSinh, MinhChung, ...  │
│  • Tab KĐCL: _Index_BaoCao                                   │
│  • Tab QLCL: Config, Lop, CN, GK2, CK1, GK1, NhanXet,        │
│              Users, HocSinh   ← migrate từ THDienLien_05.2026│
└─────────────────────────────────────────────────────────────┘
```

### 📋 Action backend mới (trong Code.gs HSS)

20 action template QLCL:
- Điểm: `getGrades`, `saveGrade`, `saveGrades`, `autoSave`, `deleteGrade`
- Nhận xét: `getNhanXet`, `saveNhanXet`, `saveNhanXetBatch`
- Lớp: `getLop`, `saveLop`
- Users: `getUsers`, `saveUser`, `deleteUser`, `changePassword`
- Học sinh: `saveStudentsBatch`, `deleteStudent`
- Hệ thống: `getConfig`, `saveConfig`, `createTemplate`, `fixDiemSheet`

Routing: nằm sau `_QLCL_POST_ACTIONS` check, KHÔNG đi qua `_WRITE_ACTIONS_` (vì template QLCL dùng bảng Users riêng để xác thực, không qua AUTH_TOKEN của TH).

### 🔧 Migration script: `migrateQlclFromExternal()`

- Prompt user nhập Sheet ID của Sheet `THDienLien_05.2026`
- Copy 9 tab QLCL sang Sheet HSS qua API `Sheet.copyTo()`
- Idempotent: nếu tab đã tồn tại ở đích → skip (không ghi đè)
- KHÔNG đụng Sheet nguồn → an toàn (data 3 tháng vẫn còn 2 nơi)

### 🚫 KHÔNG đụng (preserved)
- HSS, KĐCL/TĐG: nguyên vẹn
- AUTH_TOKEN HSS (`AdminDL-2026`, `DienLien-2026`): nguyên vẹn
- Sheet `THDienLien_05.2026` cũ: nguyên vẹn (sau migration vẫn còn data — backup tự nhiên)
- Project Apps Script `QLCL_V3.0` cũ: không đụng (sau khi chuyển sang D-3, có thể xoá hoặc giữ làm backup)

### ⚠ Lưu ý quan trọng
- **2 hệ thống auth riêng**: HSS dùng AUTH_TOKEN, QLCL dùng bảng Users → user login 2 lần khi qua lại
- **18 tab thừa trong Sheet HSS** (do anh chạy nhầm `setupAll` ở project QLCL_V3.0 — em đã hướng dẫn xoá thủ công). Hiện tại các tab này KHÔNG ảnh hưởng gì, anh có thể giữ hoặc xoá tuỳ ý.

### 📊 Số liệu
- Code.gs HSS: 3.339 → **3.976 dòng** (+637)
- qlcl.html: 571 dòng / 134KB
- qlcl-app.js: 3.143 dòng / 180KB
- qlcl-style.css: 482 dòng / 34KB

---

## [Phương án D-2 → D-3 transition] — 2026-05-05 sáng

### Đã thử (revert)
- ❌ D (ban đầu): migration long → wide trong Sheet HSS — REVERTED vì data đã wide ở Sheet riêng
- ❌ D-2: 2 Sheet + 2 backend song song — REVERTED vì anh muốn 1 Sheet duy nhất
- ✅ D-3 (hiện tại): 1 Sheet + 1 backend — gộp QLCL backend vào Code.gs HSS

### Lessons learned
1. **Phải xác nhận kiến trúc trước khi code**: em đã giả định data ở 1 Sheet, thực tế anh có 2 Sheet riêng → phải redo
2. **Anh paste Code.gs HSS vào project QLCL_V3.0** (sai project) → tạo 18 tab thừa trong Sheet `THDienLien_05.2026`. KHÔNG ảnh hưởng plan cuối nhưng cần dọn

---

## [HSS Refactor + Multi-file split] — 2026-05-05 (sáng)

- Tách index.html → index.html + app.js + style.css (giảm HTML 932KB → 478KB)
- Fix bug `getHSS()` field mapping (cột 4 vs 5)
- DATA_HSS rewrite: 109 hồ sơ với phân công + mã KĐCL CSV
- Đổi tên 1.1.1 "Chiến lược phát triển giáo dục"
- Performance fix: prefetch HSS_Status sớm + bỏ blocking trong openCat

Xem chi tiết ở memory `project_th_dienlien_data_hss.md`.
