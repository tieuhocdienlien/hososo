/**
 * =====================================================================================
 *  BACKEND CHUNG - HỆ THỐNG HỒ SƠ SỐ TRƯỜNG TIỂU HỌC
 *  Mặc định: Trường Tiểu học Diễn Liên (đổi qua Admin → Thông tin trường)
 *  1 FILE DUY NHẤT gộp Router + HSS (Hồ sơ số) + TDG (KĐCL-TĐG) + QLCL
 *
 *  • Router   — doGet/doPost dispatch + setupAll tạo 7 tab
 *  • HSS      — backend Hồ sơ số (đã đổi doGet → _hssDoGet, doPost → _hssDoPost)
 *  • TDG      — backend KĐCL-TĐG + AI Gemini/Claude
 *
 *  ✅ HƯỚNG DẪN 4 BƯỚC (xem backend/HUONG_DAN_CAI_DAT.md cho bản đầy đủ 12 bước):
 *
 *  ① Tạo Google Sheet mới → Tiện ích mở rộng → Apps Script
 *     → Đổi tên project: TH_Backend
 *
 *  ② Xoá Code.gs mặc định → Tạo 1 file mới tên 'Code' → Dán TOÀN BỘ file này → Lưu
 *
 *  ③ Chọn hàm 'setupAll' → ▶ Chạy → cấp quyền.
 *     Quay lại Sheet, F5 → 7 tab tự xuất hiện.
 *
 *  ④ Script Properties (⚙ Cài đặt dự án): thêm AI_PROVIDER=gemini + GEMINI_API_KEY=...
 *     → Triển khai → Web app → Anyone → Deploy → Copy URL /exec
 *     → Dán URL vào index.html (2 chỗ: API_URL_EARLY + API_URL)
 *
 *  File sinh tự động bằng gộp 3 file backend/Router.gs + HSS.gs + TDG.gs.
 *  Nếu cần sửa: khuyến khích sửa từng file gốc rồi chạy lại build_gs.js.
 * =====================================================================================
 */

// ============================================================================
// SECTION 1/3: ROUTER.gs — doGet / doPost / setupAll
// ============================================================================

/**
 * ============================================================================
 * ROUTER.gs — Dispatch trung tâm cho Hồ sơ số MN + Hệ thống KĐCL-TĐG
 * ============================================================================
 *
 * Một Apps Script project duy nhất, một URL deploy, một Google Sheet.
 * File này CHỈ có doGet + doPost — nhận request rồi dispatch sang:
 *   - HSS.gs  (Hồ sơ số: danh mục, DSGV, DS trẻ, minh chứng, config, ảnh)
 *   - TDG.gs  (KĐCL-TĐG: saveReport/loadReport, gọi AI Gemini/Claude)
 *
 * HSS actions (GET chủ yếu, JSONP):
 *   all (default) · hss · teachers · students · classes · images
 *   · minhchung · config · stats
 * HSS POST actions:
 *   updateHSS · updateMinhChung · resetMinhChungSeed · importTeachers · importStudents
 *
 * TDG actions (POST JSON):
 *   ping · saveReport · loadReport · listReports · deleteReport
 *   · ai · claude · readDriveFolder
 *
 * ============================================================================
 */

const _HSS_GET_ACTIONS  = ['all','hss','teachers','students','classes','images','minhchung','config','stats'];
// 2026-05-07: thêm 5 action CRUD HS đơn lẻ (Phase 2 Quản lý HS)
//   • addStudent: tiếp nhận HS mới
//   • updateStudent: sửa thông tin
//   • transferStudent: chuyển đi (soft delete - HS chuyển trường THẬT)
//   • restoreStudent: khôi phục HS đã chuyển
//   • deleteStudentPermanent: XOÁ VĨNH VIỄN (chỉ cho trường hợp NHẬP NHẦM/SAI)
//   • listStudentsAdmin: list với filter trạng thái
const _HSS_POST_ACTIONS = ['updateHSS','updateMinhChung','resetMinhChungSeed','importTeachers','importStudents','updateConfig','studentsAuthed',
  'addStudent','updateStudent','transferStudent','restoreStudent','deleteStudentPermanent','listStudentsAdmin'];
const _TDG_POST_ACTIONS  = ['ping','saveReport','loadReport','listReports','deleteReport','ai','claude','readDriveFolder'];
const _QLCL_POST_ACTIONS = ['qlclConfig','qlclGetDiem','qlclSaveDiem','qlclGetNhanXet','qlclSaveNhanXet','qlclGetNLPC','qlclSaveNLPC','qlclGetXepLoai','qlclSaveXepLoai','qlclGetPhanCong','qlclSavePhanCong','qlclDashboard','qlclAudit',
  // Sổ chủ nhiệm — workspace #10
  'qlclGetDiemDanh','qlclSaveDiemDanh',
  'qlclGetViPham','qlclSaveViPham','qlclDeleteViPham',
  'qlclGetHoatDong','qlclSaveHoatDong','qlclDeleteHoatDong',
  'qlclChuNhiemSummary'];
// QLCL Template (wide format) — adopted từ project QLCL_V3.0 của Chung Trần (May 2026)
// Backend chạy trên cùng Sheet HSS (data đã migrate từ Sheet THDienLien_05.2026 → 9 tab gốc).
// Action name giữ nguyên template (không xung đột với QLCL v1 vì khác hẳn).
// 2026-05-06 REFACTOR: QLCL không còn quản lý HS (CRUD HS chuyển hẳn sang HSS).
//   → Bỏ 'saveStudentsBatch', 'deleteStudent' khỏi danh sách action.
//   → DSHS chính là tab "DS HocSinh" của HSS (single source of truth).
const _QLCL_TPL_ACTIONS = [
  'getGrades','saveGrade','saveGrades','autoSave','deleteGrade',
  'getNhanXet','saveNhanXet','saveNhanXetBatch',
  'getLop','saveLop',
  'getUsers','saveUser','deleteUser','changePassword',
  'syncUsersFromDSGV',
  'getConfig','saveConfig','createTemplate','fixDiemSheet'
];
// Hồ sơ số — trạng thái Đã có/Chưa có (đặt riêng vì chia sẻ phong cách HSS, không phải QLCL)
const _HSS_STATUS_ACTIONS = ['getHssStatus','saveHssStatus','rescanHssDrive','checkFolderBatch'];

/**
 * doGet — nhận request từ frontend (thường dạng JSONP từ MNDienXuan.html)
 *  • Không có action hoặc action thuộc HSS → gọi _hssDoGet(e)
 *  • action=status → trả HTML giới thiệu (cả HSS + TDG)
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'all';

  // Trang status tổng hợp
  if (action === 'status') {
    return _renderStatusPage_();
  }

  // ⭐ FIX 2026-05-06: qlcl-app.js gọi BACKEND qua GET (gasCall), nên doGet
  //    PHẢI dispatch các action QLCL Template (getGrades, getNhanXet, login,
  //    getConfig, getUsers, getLop, ...). Trước đây các action này rơi vào
  //    fallback _hssDoGet → trả về HSS data → FE thấy "(6 HS)".
  if (action === 'login') {
    const username = (e && e.parameter && e.parameter.username) || '';
    const password = (e && e.parameter && e.parameter.password) || '';
    return _jsonOut_(_qtDoLogin(username, password));
  }
  if (_QLCL_TPL_ACTIONS.indexOf(action) >= 0) {
    // Build body từ query string (tương tự như doPost dùng JSON body)
    const body = (e && e.parameter) ? Object.assign({}, e.parameter) : {};
    const result = _qlclTplHandle(action, body);
    return _jsonOut_(result);
  }
  // Hỗ trợ "gaspost" — gửi POST giả qua GET (FE fallback khi POST bị block CORS)
  if (action === 'gaspost' || (e && e.parameter && e.parameter.gaspost)) {
    try {
      const body = JSON.parse((e.parameter.d) || '{}');
      const a = body.action || '';
      if (a === 'login') return _jsonOut_(_qtDoLogin(body.username, body.password));
      if (_QLCL_TPL_ACTIONS.indexOf(a) >= 0) return _jsonOut_(_qlclTplHandle(a, body));
      if (a === 'getKetQuaMOET') return _jsonOut_(getKetQuaMOET(body.khoi, body.ky, body.lop));
    } catch (err) {
      return _jsonOut_({ ok: false, error: 'gaspost parse error: ' + err.message });
    }
  }

  // MOET sync — extension HSS Sync gọi để lấy dữ liệu xuất Excel CSDL ngành
  if (action === 'getKetQuaMOET') {
    const params = (e && e.parameter) || {};
    return _jsonOut_(getKetQuaMOET(params.khoi, params.ky, params.lop));
  }

  // HSS GET (mặc định — MNDienXuan.html đang gọi)
  if (_HSS_GET_ACTIONS.indexOf(action) >= 0) {
    return _hssDoGet(e);
  }
  // Action lạ → vẫn thử HSS (backwards compatibility)
  return _hssDoGet(e);
}

/**
 * doPost — nhận JSON body, dispatch theo action
 *  • action thuộc TDG → _tdgHandleAction(body)
 *  • action thuộc HSS → _hssDoPost(e)
 */
function doPost(e) {
  let body = {};
  try {
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return _jsonOut_({ ok: false, error: 'JSON body không hợp lệ: ' + err.message });
  }

  const action = body.action || '';

  // ⭐ BẢO MẬT: kiểm token cho mọi action ghi (xem _WRITE_ACTIONS_).
  // Action read-only POST không cần token (vào xem được). Action ghi cần ít nhất
  // mã GV; action thuộc _ADMIN_ACTIONS_ chỉ chấp nhận mã Admin.
  let _authRole = null;
  if (_WRITE_ACTIONS_.indexOf(action) >= 0) {
    const needLevel = (_ADMIN_ACTIONS_.indexOf(action) >= 0) ? 'admin' : 'gv';
    const authRes = _authCheck_(body, needLevel);
    if (!authRes.ok) return _jsonOut_(authRes);
    _authRole = authRes.role;
  }

  // Action 'pingAuth' — frontend gọi để verify mã trong modal đăng nhập.
  // Trả role để FE biết mã thuộc cấp 'gv' hay 'admin' (so với khu vực đang vào).
  if (action === 'pingAuth') {
    return _jsonOut_({ ok: true, data: { authenticated: true, role: _authRole || 'gv' }});
  }

  // ⭐ FIX 2026-05-06: action 'login' của QLCL Template — route đến _qtDoLogin
  if (action === 'login') {
    return _jsonOut_(_qtDoLogin(body.username, body.password));
  }

  // Action 'updateAuthTokens' — HT đổi 2 mã trường qua UI Admin.
  // Đã pass _authCheck_ với requiredLevel='admin' ở trên → an toàn để lưu.
  if (action === 'updateAuthTokens') {
    return _jsonOut_(_updateAuthTokens(body));
  }

  // TDG actions — trả thẳng kết quả dưới dạng JSON (TDG-Backend dùng jsonResponse)
  if (_TDG_POST_ACTIONS.indexOf(action) >= 0) {
    const result = _tdgHandleAction(body);
    return _jsonOut_(result);
  }
  // HSS POST actions — _hssDoPost đã tự wrap ContentService
  if (_HSS_POST_ACTIONS.indexOf(action) >= 0) {
    return _hssDoPost(e);
  }

  // QLCL POST actions — trả JSON
  if (_QLCL_POST_ACTIONS.indexOf(action) >= 0) {
    const result = _qlclHandle(action, body);
    return _jsonOut_(result);
  }

  // QLCL Template (wide format) — route TRƯỚC _WRITE_ACTIONS_ check vì template
  // tự dùng bảng Users để xác thực, không qua AUTH_TOKEN.
  if (_QLCL_TPL_ACTIONS.indexOf(action) >= 0) {
    const result = _qlclTplHandle(action, body);
    return _jsonOut_(result);
  }

  // HSS Status (Hồ sơ số trạng thái Đã có/Chưa có) — trả JSON
  if (_HSS_STATUS_ACTIONS.indexOf(action) >= 0) {
    const result = _hssStatusHandle(action, body);
    return _jsonOut_(result);
  }

  return _jsonOut_({ ok: false, error: 'Unknown action: ' + action });
}

// ============================================================================
// SETUP TỔNG — Refactor 2026-05-06 (Phương án D-3 Final)
// ============================================================================
// Triết lý:
//   ✅ Tạo các tab cần thiết (KHÔNG ghi đè data nếu đã tồn tại)
//   ⚠️ PHÁT HIỆN tab dư thừa nhưng KHÔNG tự xoá (an toàn)
//   🗑 Việc xoá → chạy hàm `cleanupObsoleteSheets()` riêng (có confirm)
//
// Cấu trúc Sheet chuẩn:
//   • HSS module (8 tab): Danh muc HSS, DSGV, DS HocSinh, Hinh Anh, CauHinh,
//     MinhChung, HSS_Status, HSS_FileCheck
//   • TĐG/KĐCL module (1 tab): _Index_BaoCao
//   • QLCL Template module (8 tab): Config, Lop, Users, NhanXet,
//     GK1, CK1, GK2, CN
//   → Tổng: 17 tab cần thiết
//
// Tab dư thừa (sẽ phát hiện + đề xuất xoá):
//   • HocSinh (duplicate DS HocSinh — đã refactor 2026-05-06)
//   • 10 tab QLCL_* (QLCL v1 long format — dead code sau D-3)
// ============================================================================

// 17 tab cần thiết — cấu trúc chuẩn của hệ thống
const _NEEDED_SHEETS = [
  // ── HSS module (8 tab) ──
  { name: 'Danh muc HSS', module: 'HSS', desc: '109 hồ sơ số (file/folder Drive)' },
  { name: 'DSGV',         module: 'HSS', desc: 'Danh sách giáo viên & CBNV' },
  { name: 'DS HocSinh',   module: 'HSS', desc: '⭐ DSHS — TRÁI TIM hệ thống (single source of truth)' },
  { name: 'Hinh Anh',     module: 'HSS', desc: 'Quản lý hình ảnh' },
  { name: 'CauHinh',      module: 'HSS', desc: 'Cấu hình trường' },
  { name: 'MinhChung',    module: 'HSS', desc: 'Minh chứng KĐCL' },
  { name: 'HSS_Status',   module: 'HSS', desc: 'Trạng thái Đã có/Chưa có hồ sơ' },
  { name: 'HSS_FileCheck',module: 'HSS', desc: 'Kiểm tra file Drive' },
  // ── TĐG/KĐCL module (1 tab) ──
  { name: '_Index_BaoCao',module: 'TĐG', desc: 'Index báo cáo TĐG/KĐCL' },
  // ── QLCL Template module (8 tab) ──
  { name: 'Config',       module: 'QLCL', desc: 'Cấu hình QLCL (lockedPeriods, ...)' },
  { name: 'Lop',          module: 'QLCL', desc: 'Danh sách lớp + GVCN' },
  { name: 'Users',        module: 'QLCL', desc: 'Tài khoản user QLCL' },
  { name: 'NhanXet',      module: 'QLCL', desc: 'Nhận xét học bạ' },
  { name: 'GK1',          module: 'QLCL', desc: 'Điểm Giữa HK1' },
  { name: 'CK1',          module: 'QLCL', desc: 'Điểm Cuối HK1' },
  { name: 'GK2',          module: 'QLCL', desc: 'Điểm Giữa HK2' },
  { name: 'CN',           module: 'QLCL', desc: 'Điểm Cuối năm' }
];

// 11 tab dư thừa — phát hiện trong rà soát 2026-05-06
const _OBSOLETE_SHEETS = [
  // QLCL Template duplicate (refactor 2026-05-06)
  'HocSinh',
  // QLCL v1 long format (dead code sau D-3)
  'QLCL_CauHinh', 'QLCL_PhanCong', 'QLCL_DiemDK', 'QLCL_NhanXet',
  'QLCL_NangLuc', 'QLCL_XepLoai', 'QLCL_AuditLog',
  'QLCL_DiemDanh', 'QLCL_ViPham', 'QLCL_HoatDongLop'
];

/**
 * setupAll — Tạo cấu trúc Sheet chuẩn + phát hiện tab dư thừa.
 *
 *   • Tab CẦN THIẾT đã có data → GIỮ NGUYÊN (không ghi đè).
 *   • Tab CẦN THIẾT chưa có → tạo mới (đầy đủ header nếu là HSS).
 *   • Tab DƯ THỪA → liệt kê + đề xuất xoá (KHÔNG tự xoá).
 *
 * Cách dùng:
 *   1. Apps Script editor → dropdown chọn `setupAll` → ▶ Run
 *   2. Xem View → Logs để biết kết quả
 *   3. Để xoá tab dư thừa: chạy `cleanupObsoleteSheets()` (có confirm)
 */
function setupAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('════════════════════════════════════════════════════════════════');
  Logger.log('🚀 SETUP ALL — Refactor 2026-05-06 (D-3 Final)');
  Logger.log('════════════════════════════════════════════════════════════════');
  Logger.log('Sheet: ' + ss.getName() + '  (ID: ' + ss.getId() + ')');
  Logger.log('');

  // ── PHASE 1: KIỂM TRA HIỆN TRẠNG ──
  const allCurrent = ss.getSheets().map(s => s.getName());
  Logger.log('📋 Hiện trạng: Sheet có ' + allCurrent.length + ' tab');
  Logger.log('   ' + allCurrent.join(', '));
  Logger.log('');

  // ── PHASE 2: HSS — gọi hàm setup() gốc (tạo 6 tab HSS chính + nạp DATA_HS) ──
  Logger.log('═══ PHASE 2: HSS (6 tab + dữ liệu) ═══');
  try {
    setup();  // hàm trong HSS.gs — tạo Danh muc HSS, DSGV, DS HocSinh, Hinh Anh, CauHinh, MinhChung
    Logger.log('  ✅ Đã setup 6 tab HSS với data mặc định');
  } catch (err) {
    Logger.log('  ❌ Lỗi setup HSS: ' + err.message);
  }
  Logger.log('');

  // ── PHASE 3: TĐG/KĐCL — _Index_BaoCao + Drive folder ──
  Logger.log('═══ PHASE 3: TĐG/KĐCL ═══');
  try {
    const sheet = getIndexSheet_();
    Logger.log('  ✅ Tab _Index_BaoCao: "' + sheet.getName() + '"');
  } catch (err) {
    Logger.log('  ⚠ _Index_BaoCao: ' + err.message + ' (sẽ tự tạo khi cần)');
  }
  try {
    const folder = getOrCreateFolder_(ROOT_FOLDER_NAME);
    Logger.log('  ✅ Drive folder: "' + folder.getName() + '"');
    Logger.log('     ' + folder.getUrl());
  } catch (err) {
    Logger.log('  ⚠ Drive folder: ' + err.message);
  }
  Logger.log('');

  // ── PHASE 4: HSS_Status + HSS_FileCheck ──
  Logger.log('═══ PHASE 4: HSS phụ trợ ═══');
  ['HSS_Status', 'HSS_FileCheck'].forEach(name => {
    if (!ss.getSheetByName(name)) {
      ss.insertSheet(name);
      Logger.log('  ✅ Tạo: "' + name + '"');
    } else {
      Logger.log('  💾 Giữ: "' + name + '" (' + ss.getSheetByName(name).getLastRow() + ' dòng)');
    }
  });
  Logger.log('');

  // ── PHASE 5: QLCL Template (8 tab wide format) ──
  Logger.log('═══ PHASE 5: QLCL Template (8 tab) ═══');
  const qlclTabs = ['Config','Lop','Users','NhanXet','GK1','CK1','GK2','CN'];
  qlclTabs.forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      // Tạo header tối thiểu cho mỗi tab QLCL (để FE đọc/ghi không lỗi)
      const headers = {
        'Config':  ['key', 'value'],
        'Lop':     ['ma_lop', 'ten_lop', 'gvcn'],
        'Users':   ['username', 'password', 'hoten', 'role', 'lop_phu_trach', 'phan_cong_giang_day'],
        'NhanXet': ['ma', 'nhan_xet', '_user', '_timestamp'],
        'GK1':     ['ma', '_user', '_timestamp'],
        'CK1':     ['ma', '_user', '_timestamp'],
        'GK2':     ['ma', '_user', '_timestamp'],
        'CN':      ['ma', '_user', '_timestamp']
      }[name];
      if (headers) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      Logger.log('  ✅ Tạo: "' + name + '" (header: ' + (headers || []).join(', ') + ')');
    } else {
      const rows = Math.max(0, sh.getLastRow() - 1);
      Logger.log('  💾 Giữ: "' + name + '" (' + rows + ' dòng data)');
    }
  });
  Logger.log('');

  // ── PHASE 6: PHÁT HIỆN TAB DƯ THỪA ──
  Logger.log('═══ PHASE 6: PHÁT HIỆN TAB DƯ THỪA ═══');
  const obsoleteFound = [];
  _OBSOLETE_SHEETS.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) {
      const rows = Math.max(0, sh.getLastRow() - 1);
      obsoleteFound.push({ name: name, rows: rows });
      Logger.log('  🗑 ' + name + ' — ' + rows + ' dòng data');
    }
  });
  if (obsoleteFound.length === 0) {
    Logger.log('  ✨ Sheet đã sạch — không có tab dư thừa');
  } else {
    Logger.log('');
    Logger.log('  ⚠️ Phát hiện ' + obsoleteFound.length + ' tab dư thừa.');
    Logger.log('  ⚠️ KHÔNG tự xoá. Để xoá → chạy hàm: cleanupObsoleteSheets()');
  }
  Logger.log('');

  // ── KẾT LUẬN ──
  Logger.log('════════════════════════════════════════════════════════════════');
  Logger.log('🎉 SETUP ALL HOÀN TẤT');
  Logger.log('════════════════════════════════════════════════════════════════');
  Logger.log('  ✅ ' + _NEEDED_SHEETS.length + ' tab cần thiết: đã có/đã tạo');
  if (obsoleteFound.length > 0) {
    Logger.log('  ⚠ ' + obsoleteFound.length + ' tab dư thừa: cần dọn (chạy cleanupObsoleteSheets)');
  }
  Logger.log('  📌 Bước tiếp: Triển khai → Phiên bản mới (URL /exec không đổi)');
  Logger.log('════════════════════════════════════════════════════════════════');

  return {
    ok: true,
    needed: _NEEDED_SHEETS.length,
    obsolete: obsoleteFound
  };
}

/**
 * cleanupObsoleteSheets — Xoá các tab dư thừa (có CONFIRM).
 *
 *   • Phát hiện 11 tab dư thừa (HocSinh + 10 tab QLCL_*)
 *   • Hỏi xác nhận qua UI prompt trước khi xoá
 *   • KHÔNG xoá tab có data trừ khi user explicit confirm
 *   • An toàn: chạy bao nhiêu lần cũng không hại
 *
 * Cách dùng:
 *   1. BACKUP Sheet trước (Tệp → Tạo bản sao)
 *   2. Apps Script editor → chọn `cleanupObsoleteSheets` → ▶ Run
 *   3. Xác nhận hộp thoại
 *   4. Xem View → Logs để biết kết quả
 */
function cleanupObsoleteSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('════════════════════════════════════════════════════════════════');
  Logger.log('🗑 CLEANUP OBSOLETE SHEETS');
  Logger.log('════════════════════════════════════════════════════════════════');

  // Phát hiện tab dư thừa
  const found = [];
  _OBSOLETE_SHEETS.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) {
      const rows = Math.max(0, sh.getLastRow() - 1);
      found.push({ name: name, rows: rows, sheet: sh });
    }
  });

  if (found.length === 0) {
    Logger.log('✨ Không có tab dư thừa — Sheet đã sạch sẽ!');
    return { ok: true, deleted: 0, message: 'Sheet đã sạch' };
  }

  Logger.log('Phát hiện ' + found.length + ' tab dư thừa:');
  found.forEach(t => Logger.log('  • "' + t.name + '" — ' + t.rows + ' dòng data'));
  Logger.log('');

  // Hỏi xác nhận qua UI
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    Logger.log('⚠ Không có UI context (chạy headless?). Chế độ AUTO-SAFE:');
    Logger.log('  → Chỉ xoá tab RỖNG (0 dòng). Tab có data: SKIP.');
    return _cleanupAutoSafe(ss, found);
  }

  // Tổng số dòng data
  const totalRows = found.reduce((s, t) => s + t.rows, 0);
  const list = found.map(t => '  • ' + t.name + ' (' + t.rows + ' dòng)').join('\n');
  const msg = '🗑 Xác nhận xoá ' + found.length + ' tab dư thừa?\n\n' +
              list + '\n\n' +
              'Tổng: ' + totalRows + ' dòng data sẽ MẤT VĨNH VIỄN.\n\n' +
              '⚠ KHÔNG THỂ HOÀN TÁC sau khi xoá.\n' +
              '⚠ Khuyến nghị: BACKUP Sheet trước (Tệp → Tạo bản sao).\n\n' +
              'Tiếp tục xoá?';

  const resp = ui.alert('Xác nhận dọn tab dư thừa', msg, ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) {
    Logger.log('❌ User huỷ — không xoá tab nào.');
    return { ok: false, cancelled: true };
  }

  // Tiến hành xoá
  let deleted = 0, errors = [];
  found.forEach(t => {
    try {
      ss.deleteSheet(t.sheet);
      Logger.log('  ✅ Đã xoá: "' + t.name + '" (' + t.rows + ' dòng)');
      deleted++;
    } catch (err) {
      Logger.log('  ❌ Lỗi xoá "' + t.name + '": ' + err.message);
      errors.push(t.name + ': ' + err.message);
    }
  });

  Logger.log('');
  Logger.log('════════════════════════════════════════════════════════════════');
  Logger.log('🎉 CLEANUP HOÀN TẤT — Đã xoá ' + deleted + '/' + found.length + ' tab.');
  if (errors.length) Logger.log('⚠ Lỗi: ' + errors.join(', '));
  Logger.log('════════════════════════════════════════════════════════════════');

  return { ok: true, deleted: deleted, errors: errors };
}

// Helper: cleanup mode AUTO-SAFE (khi chạy không có UI — chỉ xoá tab rỗng)
function _cleanupAutoSafe(ss, found) {
  let deleted = 0, skipped = 0;
  found.forEach(t => {
    if (t.rows > 0) {
      Logger.log('  ⏭ SKIP "' + t.name + '" — có ' + t.rows + ' dòng (cần xoá thủ công qua UI)');
      skipped++;
    } else {
      try {
        ss.deleteSheet(t.sheet);
        Logger.log('  ✅ Xoá: "' + t.name + '" (rỗng)');
        deleted++;
      } catch (err) {
        Logger.log('  ❌ Lỗi: ' + err.message);
      }
    }
  });
  return { ok: true, deleted: deleted, skipped: skipped };
}

// ============================================================================
// Helpers
// ============================================================================

function _jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _renderStatusPage_() {
  const provider = (typeof getProp_ === 'function') ? (getProp_('AI_PROVIDER') || 'gemini') : 'gemini';
  const hasKey = (typeof getProp_ === 'function') ? !!getProp_(provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY') : false;
  const ss = (typeof _getSS === 'function') ? _getSS() : SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss ? ss.getSheets().map(function(s){ return s.getName(); }).join(', ') : '(không truy cập được)';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui;padding:2em;max-width:720px;line-height:1.6">' +
    '<h2>✅ Backend chung (HSS + KĐCL) đang hoạt động</h2>' +
    '<p><b>Thời gian:</b> ' + new Date().toLocaleString('vi-VN') + '</p>' +
    '<h3>🗂️ Hồ sơ số (HSS)</h3>' +
    '<p><b>Spreadsheet:</b> ' + (ss ? ss.getName() : '(chưa có)') + '</p>' +
    '<p><b>Sheets:</b> ' + sheets + '</p>' +
    '<h3>🤖 KĐCL-TĐG (AI)</h3>' +
    '<p><b>AI Provider:</b> ' + provider + '</p>' +
    '<p><b>API Key:</b> ' + (hasKey ? '✅ Đã cấu hình' : '❌ CHƯA cấu hình — vào ⚙ Project Settings → Script Properties') + '</p>' +
    '<hr><p style="color:#666;font-size:12px">Endpoint này nhận GET (HSS) + POST JSON (HSS/TDG). Thêm <code>?action=status</code> để xem trang này.</p>' +
    '</div>'
  );
}

// ============================================================================
// SECTION 1.5: SECURITY HELPERS — token auth, role lookup, score validation, lock
// ============================================================================
//
// 🔒 MÃ TRƯỜNG (2 cấp — thầy chỉ cần đổi 2 dòng dưới đây)
// ----------------------------------------------------------------------------
// Trang web chia thành 2 vùng:
//   • PUBLIC — Trang chủ, Hồ sơ số, danh sách HS/GV (chế độ xem), QLCL (xem)
//             → ai cũng vào được, KHÔNG hỏi mã.
//   • LOCKED — sửa điểm/nhận xét/NLPC/xếp loại/vi phạm/hoạt động (cần mã GV);
//             Admin panel + KĐCL-TĐG (chỉ mã Admin).
//
// 👉 Đặt 2 mã KHÁC NHAU, dễ đọc qua điện thoại.
//    Phổ biến qua Zalo nhóm trường:
//      "Cô/thầy GV: nhập mã <AUTH_TOKEN_GV> khi sửa điểm"
//      "Riêng Ban giám hiệu: mã Admin là <AUTH_TOKEN_ADMIN>"
//    Mã Admin tự động có toàn bộ quyền GV (không phải nhập 2 lần).
const AUTH_TOKEN_GV    = 'DienLien-2026';   // Mã GV — sửa điểm/nhận xét
const AUTH_TOKEN_ADMIN = 'AdminDL-2026';    // Mã Admin — Admin panel + KĐCL + cả mã GV
// ----------------------------------------------------------------------------
//
// 4 helper an toàn được gọi từ doPost và các hàm save:
//   _authCheck_(body, level) — kiểm token, trả {ok, role} ('gv' | 'admin')
//   _resolveRole_(emailUser) — tra role thật từ sheet DSGV (không tin client)
//   _qlclValidScore_(v)      — kiểm điểm 0..10 hoặc rỗng
//   _withLock_(fn)           — bao bọc thao tác ghi bằng LockService
//
// Quy tắc xác thực:
//   • Cả 2 mã trống → chế độ MỞ (chỉ dùng giai đoạn dev/setup, có log cảnh báo).
//   • Token khớp AUTH_TOKEN_ADMIN → role = 'admin' (đủ cho mọi action).
//   • Token khớp AUTH_TOKEN_GV    → role = 'gv'    (đủ cho action GV, KHÔNG đủ Admin).
//   • Action thuộc _ADMIN_ACTIONS_ chỉ chấp nhận role = 'admin'.

const _WRITE_ACTIONS_ = [
  // Auth ping — dùng để verify mã trường khi GV/Admin đăng nhập modal
  'pingAuth',
  // Đổi mã trường (chỉ Admin, lưu vào Script Properties)
  'updateAuthTokens',
  // HSS
  'updateHSS','updateMinhChung','resetMinhChungSeed','importTeachers','importStudents','updateConfig',
  // 2026-05-07: HSS — Quản lý HS đơn lẻ (Phase 2)
  'addStudent','updateStudent','transferStudent','restoreStudent','deleteStudentPermanent',
  // QLCL — mọi action save/delete
  'qlclSaveDiem','qlclSaveNhanXet','qlclSaveNLPC','qlclSaveXepLoai','qlclSavePhanCong',
  'qlclSaveDiemDanh','qlclSaveViPham','qlclDeleteViPham','qlclSaveHoatDong','qlclDeleteHoatDong',
  // HSS Status
  'saveHssStatus','rescanHssDrive',
  // TDG
  'saveReport','deleteReport'
];

// Action CHỈ ADMIN mới được gọi (mã GV không đủ quyền).
// Mọi action ghi khác trong _WRITE_ACTIONS_ → cần ít nhất mã GV.
const _ADMIN_ACTIONS_ = [
  // Đổi mã trường — chỉ HT/PHT
  'updateAuthTokens',
  // HSS — cấu hình trường, import dữ liệu, danh mục minh chứng
  'updateHSS','updateMinhChung','resetMinhChungSeed',
  'importTeachers','importStudents','updateConfig',
  // 2026-05-07: Quản lý HS đơn lẻ — chỉ admin (HT/PHT)
  'addStudent','updateStudent','transferStudent','restoreStudent','deleteStudentPermanent',
  'saveHssStatus','rescanHssDrive',
  // QLCL — phân công GVCN/GVBM cho lớp (chỉ BGH)
  'qlclSavePhanCong',
  // TDG/KĐCL — toàn bộ
  'saveReport','deleteReport'
];

const _ROLE_HT_     = 'HT';      // Hiệu trưởng / Phó hiệu trưởng — toàn quyền
const _ROLE_GVCN_   = 'GVCN';    // Giáo viên chủ nhiệm — quyền theo lớp
const _ROLE_GVBM_   = 'GVBM';    // Giáo viên bộ môn — quyền theo lớp+môn
const _ROLE_GV_     = 'GV';      // Giáo viên (chưa biết chủ nhiệm hay bộ môn)
const _ROLE_KHAC_   = 'KHAC';    // Vai trò khác (NV, kế toán...) — chỉ đọc

const _KHEN_THUONG_VALID_ = ['', 'Xuất sắc', 'Tiêu biểu hoàn thành tốt'];

/**
 * Đọc 2 mã trường hiện hành. Ưu tiên Script Properties (do HT đổi qua UI),
 * fallback về hằng hardcode trong code (mã mặc định khi cài đặt template).
 * @return {tokGV, tokAdmin}
 */
function _getAuthTokens_() {
  let propGV = '', propAdmin = '';
  try {
    const props = PropertiesService.getScriptProperties();
    propGV    = props.getProperty('AUTH_TOKEN_GV')    || '';
    propAdmin = props.getProperty('AUTH_TOKEN_ADMIN') || '';
  } catch (e) { /* ignore */ }
  const tokGV    = propGV    || ((typeof AUTH_TOKEN_GV    === 'string') ? AUTH_TOKEN_GV    : '');
  const tokAdmin = propAdmin || ((typeof AUTH_TOKEN_ADMIN === 'string') ? AUTH_TOKEN_ADMIN : '');
  return { tokGV: tokGV, tokAdmin: tokAdmin };
}

/**
 * Xác thực request — SSO 1 lần qua tab Users (refactor 2026-05-07).
 *
 * Thứ tự ưu tiên:
 *   1) body.sessionToken hợp lệ → đọc role từ session (tab Users).
 *      • role 'admin' hoặc 'Hiệu trưởng'   → level 'admin' (Q2c: HT = full quyền).
 *      • role 'GVCN' / 'teacher' / 'GV …'  → level 'gv'.
 *      • role khác (NV, kế toán…)          → từ chối ghi.
 *   2) Fallback (deprecated, sẽ xoá sau 1 tuần): AUTH_TOKEN_GV/ADMIN cũ.
 *      Mỗi lần fallback chạy → ghi audit log 'legacy_token_used' để theo dõi
 *      ai còn dùng popup mã cũ → nhắc đổi sang đăng nhập username/password.
 *
 * @param body — request body (có thể chứa sessionToken HOẶC token cũ).
 * @param requiredLevel — 'gv' | 'admin'. Mặc định 'gv'.
 * @return {ok, role, user?, hoten?, lop?, phan_cong?} nếu pass; {ok:false, error, needLogin?} nếu fail.
 */
function _authCheck_(body, requiredLevel) {
  requiredLevel = requiredLevel || 'gv';

  // ── 1) Ưu tiên sessionToken (SSO mới) ───────────────────────────────────
  if (body && body.sessionToken) {
    const session = _qtVerifySession(body.sessionToken);
    if (session) {
      const rawRole = String(session.role || '').trim();
      const lower   = rawRole.toLowerCase();
      // Q2c: admin + Hiệu trưởng đều full quyền
      const isAdmin = (lower === 'admin')
                   || (rawRole === 'Hiệu trưởng')
                   || (lower === 'hieu truong');
      // GV (mọi biến thể: GVCN, teacher, "GV Tiếng Anh", "GV Mỹ thuật"…)
      const isGv = isAdmin
                || (lower === 'gvcn')
                || (lower === 'teacher')
                || (lower === 'gv')
                || (lower.indexOf('gv ') === 0);

      if (requiredLevel === 'admin' && !isAdmin) {
        Logger.log('[AUTH] User ' + session.username + ' (role=' + rawRole + ') cố vào action Admin: ' + (body.action || '?'));
        return { ok: false, error: '⛔ Chức năng này chỉ Hiệu trưởng/Phó HT được dùng.' };
      }
      if (!isGv) {
        Logger.log('[AUTH] Role không có quyền ghi: ' + rawRole);
        return { ok: false, error: '⛔ Tài khoản không có quyền ghi dữ liệu.' };
      }

      const ex = session.extra || {};
      return {
        ok: true,
        role: isAdmin ? 'admin' : 'gv',
        user: session.username,
        hoten: ex.hoten || session.username,
        lop: ex.lop || '',
        phan_cong: ex.phan_cong || ''
      };
    }
    // sessionToken hết hạn / không hợp lệ → tiếp tục thử fallback bên dưới
    Logger.log('[AUTH] sessionToken hết hạn/không hợp lệ. action=' + (body.action || '?'));
  }

  // ── 2) Fallback AUTH_TOKEN cũ (deprecated, gỡ sau 1 tuần) ───────────────
  const t = _getAuthTokens_();
  const tokAdmin = t.tokAdmin;
  const tokGV    = t.tokGV;

  // Cả 2 mã trống → chế độ MỞ (dev/setup, có log cảnh báo). Không nên kéo dài.
  if (!tokAdmin && !tokGV) {
    Logger.log('[AUTH] Cả AUTH_TOKEN_GV và AUTH_TOKEN_ADMIN đều trống — backend đang chạy chế độ MỞ.');
    return { ok: true, role: 'admin' };
  }

  const got = body && body.token ? String(body.token) : '';
  let role = null;
  if (got && tokAdmin && got === tokAdmin)      role = 'admin';
  else if (got && tokGV && got === tokGV)       role = 'gv';

  if (!role) {
    Logger.log('[AUTH] Chưa đăng nhập / mã không khớp. user=' + (body && body.user || '?') + ', action=' + (body && body.action || '?'));
    return {
      ok: false,
      needLogin: true,
      error: '⛔ Vui lòng đăng nhập để sử dụng chức năng này.'
    };
  }

  if (requiredLevel === 'admin' && role !== 'admin') {
    Logger.log('[AUTH] GV cố vào action Admin (legacy token): ' + (body && body.action || '?'));
    return { ok: false, error: '⛔ Chức năng này chỉ Hiệu trưởng/Phó HT được dùng.' };
  }

  // Cảnh báo: vẫn còn ai đó dùng mã token cũ → log để gỡ dần
  try {
    _auditLog('_AuditLog_QLCL', {
      action: 'legacy_token_used',
      username: (body && body.user) || '?',
      role: role,
      note: 'Action: ' + ((body && body.action) || '?') + ' — đề nghị chuyển sang đăng nhập username/password'
    });
  } catch (e) { /* ignore audit failures */ }

  return { ok: true, role: role };
}

/**
 * Đổi 2 mã trường — lưu vào Script Properties. Chỉ Admin gọi được (đã check ở doPost).
 * Body: { newGvToken, newAdminToken }
 * Validate: cả 2 không trống, độ dài 4-30 ký tự, không trùng nhau.
 */
function _updateAuthTokens(body) {
  const newGV    = body && body.newGvToken    ? String(body.newGvToken).trim()    : '';
  const newAdmin = body && body.newAdminToken ? String(body.newAdminToken).trim() : '';

  if (!newGV || !newAdmin) {
    return { ok: false, error: 'Thiếu mã GV hoặc mã Admin mới.' };
  }
  if (newGV.length < 4 || newGV.length > 30 || newAdmin.length < 4 || newAdmin.length > 30) {
    return { ok: false, error: 'Mã phải dài 4–30 ký tự.' };
  }
  if (newGV === newAdmin) {
    return { ok: false, error: 'Mã GV và mã Admin phải KHÁC NHAU.' };
  }
  // Tránh ký tự khoảng trắng/tab/newline ở giữa (làm dễ nhầm)
  if (/\s/.test(newGV) || /\s/.test(newAdmin)) {
    return { ok: false, error: 'Mã không được chứa khoảng trắng.' };
  }

  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('AUTH_TOKEN_GV',    newGV);
    props.setProperty('AUTH_TOKEN_ADMIN', newAdmin);
    Logger.log('[AUTH] Đã đổi mã trường (cả GV + Admin) qua UI. Người đổi: ' + (body && body.user || '?'));
    return { ok: true, data: { message: 'Đã đổi mã trường thành công.' }};
  } catch (e) {
    return { ok: false, error: 'Không lưu được Script Properties: ' + e.message };
  }
}

/**
 * Tra role thật từ DSGV theo email (Gmail). KHÔNG tin role do client gửi.
 * @return một trong: 'HT' | 'GVCN' | 'GVBM' | 'GV' | 'KHAC' | null (không tìm thấy)
 */
function _resolveRole_(emailOrUser) {
  if (!emailOrUser) return null;
  const key = String(emailOrUser).toLowerCase().trim();
  let sh;
  try { sh = _getSS().getSheetByName(SHEET_DSGV); } catch (e) { return null; }
  if (!sh) return null;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  // Cột: TT(0) HoTen(1) NgaySinh(2) ChucVu(3) TrinhDo(4) SDT(5) Gmail(6) Link(7)
  const data = sh.getRange(2, 1, lastRow - 1, 8).getValues();
  for (let i = 0; i < data.length; i++) {
    const email = String(data[i][6] || '').toLowerCase().trim();
    const name  = String(data[i][1] || '').toLowerCase().trim();
    if (email === key || name === key) {
      const cv = String(data[i][3] || '').toLowerCase();
      if (cv.indexOf('hiệu trưởng') >= 0) return _ROLE_HT_;
      if (cv.indexOf('chủ nhiệm') >= 0)   return _ROLE_GVCN_;
      if (cv.indexOf('giáo viên') >= 0 || cv.indexOf('gv') >= 0) return _ROLE_GV_;
      return _ROLE_KHAC_;
    }
  }
  return null;
}

/**
 * Kiểm điểm hợp lệ: rỗng, hoặc số 0..10 (cho phép thập phân 0.1 bước).
 * @return null nếu OK, hoặc string mô tả lỗi.
 */
function _qlclValidScore_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (isNaN(n)) return 'không phải số';
  if (n < 0 || n > 10) return 'phải nằm trong khoảng 0–10';
  return null;
}

/**
 * Bao bọc thao tác ghi bằng LockService để chống race condition.
 * Nếu không lấy được lock trong 8 giây → trả lỗi friendly.
 */
function _withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(8000)) {
      return { ok: false, error: '⏳ Hệ thống đang bận xử lý yêu cầu khác. Vui lòng thử lại sau vài giây.' };
    }
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ============================================================================
// SECURITY HELPERS — 2026-05-07 (Phương án A: vá bảo mật trước khi 15 GV dùng)
// ============================================================================
//   _qtRandomToken(n)              — sinh chuỗi hex ngẫu nhiên
//   _qtHashPassword(plain[,salt])  — SHA-256(salt+plain) → "salt$hash"
//   _qtVerifyPassword(stored,plain)— verify + báo có cần upgrade plain→hash
//   _qtCreateSession(user,role,..) — sinh session token, lưu CacheService 8h
//   _qtVerifySession(token)        — đọc session, refresh TTL nếu còn hạn
//   _qlclValidGrade_(key,v)        — whitelist T/H/C/Đ/CCG, 0..10, rỗng
//   _auditLog(tab,entry)           — append vào tab audit (tự tạo + ẩn)
// ----------------------------------------------------------------------------

function _qtRandomToken(n) {
  n = n || 32;
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * 16));
  return s;
}

function _qtHashPassword(plain, salt) {
  salt = salt || _qtRandomToken(16);
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + String(plain),
    Utilities.Charset.UTF_8
  );
  let hex = '';
  for (let i = 0; i < raw.length; i++) {
    let h = (raw[i] & 0xff).toString(16);
    if (h.length === 1) h = '0' + h;
    hex += h;
  }
  return salt + '$' + hex;
}

function _qtVerifyPassword(stored, plain) {
  if (!stored || plain === undefined || plain === null) return { ok: false, needUpgrade: false };
  const s = String(stored);
  const idx = s.indexOf('$');
  // Format hash: "salt$hex" — salt là hex 16 ký tự (ta sinh), idx == 16
  if (idx < 8 || idx > 64) {
    // Không có '$' (hoặc bất thường) → coi là plain-text legacy
    return { ok: s === String(plain), needUpgrade: true };
  }
  const salt = s.substring(0, idx);
  const expected = s.substring(idx + 1);
  // Hex trong expected phải toàn hex digit, độ dài 64 (SHA-256 hex)
  if (expected.length !== 64 || !/^[0-9a-f]+$/i.test(expected)) {
    return { ok: s === String(plain), needUpgrade: true };
  }
  const calc = _qtHashPassword(plain, salt).split('$')[1];
  return { ok: calc === expected, needUpgrade: false };
}

// 2026-05-07 (Phase 4): TTL 30 ngày + lưu PropertiesService (CacheService chỉ
//   cho phép tối đa 6 giờ). Mục tiêu SSO: GV login 1 lần, dùng tới 30 ngày
//   không phải đăng nhập lại; reload trang qlcl.html → tự khôi phục từ _cu.
const _QT_SESSION_TTL_MS  = 30 * 24 * 3600 * 1000;  // 30 ngày
const _QT_SESSION_PREFIX  = 'qlcl_session_';

function _qtCreateSession(username, role, extra) {
  var token = _qtRandomToken(32);
  var props = PropertiesService.getScriptProperties();
  var payload = JSON.stringify({
    username: String(username),
    role: String(role || 'gv'),
    extra: extra || {},
    ts: Date.now(),
    expiry: Date.now() + _QT_SESSION_TTL_MS
  });
  props.setProperty(_QT_SESSION_PREFIX + token, payload);
  // Cleanup cơ hội: thỉnh thoảng xoá session quá hạn để tránh PropertiesService
  // đầy 500KB. Trigger ngẫu nhiên (~1/20 lần login).
  if (Math.random() < 0.05) {
    try { _qtCleanupExpiredSessions(); } catch (e) {}
  }
  return token;
}

function _qtVerifySession(token) {
  if (!token) return null;
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_QT_SESSION_PREFIX + String(token));
  if (!raw) return null;
  try {
    var obj = JSON.parse(raw);
    if (obj.expiry && obj.expiry < Date.now()) {
      props.deleteProperty(_QT_SESSION_PREFIX + String(token));
      return null;
    }
    // Sliding expiry: nếu user còn hoạt động trong 7 ngày cuối → gia hạn 30 ngày
    if (obj.expiry && (obj.expiry - Date.now()) < 7 * 24 * 3600 * 1000) {
      obj.expiry = Date.now() + _QT_SESSION_TTL_MS;
      props.setProperty(_QT_SESSION_PREFIX + String(token), JSON.stringify(obj));
    }
    return obj;
  } catch (e) {
    return null;
  }
}

function _qtDestroySession(token) {
  if (!token) return;
  try {
    PropertiesService.getScriptProperties().deleteProperty(_QT_SESSION_PREFIX + String(token));
  } catch (e) {}
}

/**
 * Xoá tất cả session đã hết hạn. Có thể gọi tay từ Apps Script editor
 * hoặc tự gọi ngẫu nhiên trong _qtCreateSession (giữ PropertiesService gọn).
 */
function _qtCleanupExpiredSessions() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var now = Date.now();
  var removed = 0;
  Object.keys(all).forEach(function(k){
    if (k.indexOf(_QT_SESSION_PREFIX) !== 0) return;
    try {
      var obj = JSON.parse(all[k]);
      if (obj && obj.expiry && obj.expiry < now) {
        props.deleteProperty(k);
        removed++;
      }
    } catch (e) {
      props.deleteProperty(k);  // payload hỏng → xoá luôn
      removed++;
    }
  });
  if (removed > 0) Logger.log('[QLCL] Cleaned ' + removed + ' expired sessions');
  return removed;
}

/**
 * Whitelist giá trị điểm/mức theo TT 27/2020 + CT GDPT 2018.
 * @return null nếu hợp lệ, hoặc string mô tả lỗi.
 *
 * Chấp nhận:
 *   • Rỗng / null / undefined
 *   • Mức môn học:    T, H, C, HTT, HT, CHT
 *   • Mức NL/PC:      T, Đ, C, CCG
 *   • Khen thưởng:    HTXS, HTKK, HTHQ, XS, TB, TBKK, "Xuất sắc",
 *                     "Tiêu biểu hoàn thành tốt", "Tiêu biểu"
 *   • Cờ:             0/1/true/false
 *   • Điểm số:        0..10 (cho phép thập phân, dấu phẩy)
 *   • Cột hệ thống _user/_timestamp/_session: chuỗi <= 200 ký tự
 *   • Nhận xét tự do: <= 500 ký tự, không chứa < hay >
 */
function _qlclValidGrade_(key, v) {
  if (v === '' || v === null || v === undefined) return null;
  const sv = String(v).trim();
  if (sv === '') return null;

  // Cột hệ thống
  if (key === '_user' || key === '_timestamp' || key === '_session') {
    if (sv.length > 200) return 'quá dài (>200 ký tự)';
    return null;
  }

  // Cờ 0/1, true/false (key có dạng _khen, _tieubieu, _xs, _hoan_thanh, ...)
  if (/^(0|1|true|false)$/i.test(sv)) return null;

  // Mức letter — TT27 + khen thưởng
  const VALID_LETTERS = ['T','H','C','Đ','CCG','HTT','HT','CHT','HTXS','HTKK','HTHQ','XS','TB','TBKK'];
  if (VALID_LETTERS.indexOf(sv) >= 0) return null;
  if (sv === 'Xuất sắc' || sv === 'Tiêu biểu hoàn thành tốt' || sv === 'Tiêu biểu') return null;

  // Số (chấp nhận dấu phẩy thập phân)
  const n = Number(sv.replace(',', '.'));
  if (!isNaN(n) && n >= 0 && n <= 10) return null;

  // Nhận xét / ghi chú tự do
  if (sv.length <= 500 && !/[<>]/.test(sv)) return null;

  return 'giá trị không hợp lệ: "' + sv.substring(0, 50) + '"';
}

/**
 * Slugify tiếng Việt: bỏ dấu, chuyển đ→d, lowercase, giữ a-z 0-9.
 *   "Nguyễn Văn A" → "nguyenvana"
 */
function _slugifyVN_(s){
  s = String(s || '').toLowerCase().trim();
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');  // bỏ diacritics Unicode
  s = s.replace(/đ/g, 'd');
  s = s.replace(/[^a-z0-9]+/g, '');
  return s;
}

/**
 * Sinh username từ thông tin GV — ưu tiên email prefix, fallback slug tên.
 *   { name:'Nguyễn Văn A', email:'nva.gv@th.edu.vn' } → 'nva.gv'
 *   { name:'Nguyễn Văn A', email:'' } → 'nguyenvana'
 */
function _genUsername_(teacher){
  if (teacher.email) {
    var pref = String(teacher.email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (pref.length >= 3) return pref;
  }
  return _slugifyVN_(teacher.name);
}

/**
 * Parse "Chức vụ" → suy ra role + lớp phụ trách (cho QLCL Users).
 *   "Hiệu trưởng" → {role:'admin', lop:''}
 *   "Phó Hiệu trưởng" → {role:'admin', lop:''}
 *   "GVCN lớp 3A" → {role:'gv', lop:'3A'}
 *   "GV bộ môn Toán" → {role:'gv', lop:''}
 *   "GVTD" / "Tổng phụ trách Đội" → {role:'gv', lop:''}
 */
function _parseGVRole_(chucVu){
  var s = String(chucVu || '').trim();
  var lc = s.toLowerCase();
  if (/hiệu\s*trưởng|p\.\s*ht|phó\s*ht|phó\s*hiệu|bgh|ban\s*giám\s*hiệu/i.test(lc)) {
    return { role: 'admin', lop: '' };
  }
  // Parse "lớp 1A", "lớp 2B", ... cho GVCN
  var m = lc.match(/lớp\s*(\d+\s*[a-eA-E])/i);
  if (m) {
    return { role: 'gv', lop: m[1].replace(/\s+/g,'').toUpperCase() };
  }
  return { role: 'gv', lop: '' };
}

/**
 * Append entry vào tab audit log. Tự tạo tab + header nếu chưa có. Tab tự ẩn.
 *
 * @param {string} tab — tên tab ('_AuditLog_HS' hoặc '_AuditLog_QLCL')
 * @param {object} entry — { action, username, role, target, before, after, note }
 */
function _auditLog(tab, entry) {
  try {
    const ss = _getSS();
    let sh = ss.getSheetByName(tab);
    if (!sh) {
      sh = ss.insertSheet(tab);
      sh.getRange(1, 1, 1, 8).setValues([[
        'timestamp', 'action', 'username', 'role', 'target', 'before', 'after', 'note'
      ]]);
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 160);
      sh.setColumnWidth(6, 300);
      sh.setColumnWidth(7, 300);
      try { sh.hideSheet(); } catch (e) {}
    }
    const ts = Utilities.formatDate(new Date(),
      Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh',
      'yyyy-MM-dd HH:mm:ss');
    const row = [
      ts,
      String(entry.action || ''),
      String(entry.username || '?'),
      String(entry.role || ''),
      String(entry.target || ''),
      typeof entry.before === 'object' ? JSON.stringify(entry.before).substring(0, 1000) : String(entry.before || ''),
      typeof entry.after  === 'object' ? JSON.stringify(entry.after).substring(0, 1000)  : String(entry.after  || ''),
      String(entry.note || '')
    ];
    sh.appendRow(row);
  } catch (e) {
    Logger.log('[AuditLog] ' + tab + ' lỗi: ' + e.message);
  }
}


// ============================================================================
// SECTION 2/3: HSS.gs — backend Hồ sơ số (Danh mục, DSGV, DS HS, Ảnh, MC, Config)
// ============================================================================

/**
 * =====================================================================================
 *  HỒ SƠ SỐ - TRƯỜNG TIỂU HỌC (Mặc định: Trường Tiểu học Diễn Liên)
 *  Địa chỉ mẫu: Xã Quảng Châu, Tỉnh Nghệ An
 *  Backend API: Google Apps Script (Container-bound)
 *
 *  💡 TEMPLATE NOTE: File này là template DÙNG CHUNG cho mọi trường tiểu học.
 *     Sau khi setup, vào website → Admin → Thông tin trường để đổi tên/địa chỉ
 *     /Hiệu trưởng/Phó HT/... — không cần sửa code.
 * =====================================================================================
 *
 *  ⭐ DỮ LIỆU MẪU (placeholder):
 *     • ~100 dòng Hồ sơ số (hồ sơ lá - chưa có link Drive)
 *     • 5 cán bộ, giáo viên, nhân viên (mẫu)
 *     • 8 học sinh (mẫu) thuộc 5 lớp
 *     • 8 ảnh hoạt động mẫu
 *
 *  ✅ HƯỚNG DẪN 4 BƯỚC:
 *
 *  ① Tạo Google Sheet mới: vào https://sheets.new
 *
 *  ② Trong Sheet: Tiện ích mở rộng → Apps Script.
 *     Xóa code mẫu, dán TOÀN BỘ file này → Lưu (Ctrl+S).
 *
 *  ③ Chọn hàm "setup" → ▶ Chạy → cấp quyền.
 *     Quay lại Sheet, F5 → 4 tab tự xuất hiện với đầy đủ dữ liệu.
 *
 *  ④ Triển khai → New deployment → ⚙ → Web app
 *     Execute as: Me | Who has access: Anyone → Deploy → Copy URL /exec.
 *
 * =====================================================================================
 */

// ========== ĐỔI THÔNG TIN TRƯỜNG Ở ĐÂY (chỉ dùng làm fallback) ==========
// 💡 LƯU Ý: Dữ liệu thực tế nên nhập qua website → Admin → Thông tin trường.
// Các giá trị dưới đây CHỈ dùng khi sheet CauHinh chưa được điền.
const SCHOOL_CONFIG = {
  name:           'Trường Tiểu học Diễn Liên',
  address:        'Xã Quảng Châu, Tỉnh Nghệ An',
  phone:          '',
  email:          '',
  schoolYear:     '2025 - 2026',
  principal:      '',  // Tên Hiệu trưởng — Admin nhập qua Web
  vicePrincipal:  ''   // Tên Phó Hiệu trưởng — Admin nhập qua Web
};
// ========== HẾT PHẦN CẦN ĐỔI ==========

const SHEET_HSS    = 'Danh muc HSS';
const SHEET_DSGV   = 'DSGV';
const SHEET_HS     = 'DS HocSinh';
const SHEET_IMG    = 'Hinh Anh';
const SHEET_CFG    = 'CauHinh';
const SHEET_MC     = 'MinhChung';

// =====================================================================================
// ==========                  DỮ LIỆU NHÚNG SẴN (DO NOT EDIT)               ===========
// =====================================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 109 hồ sơ leaf — schema 5 cột: [STT, Tên hồ sơ, Link Drive, Phân công, Mã KĐCL]
// • Cột 4 (Phân công): mặc định theo chức danh — trường tự sửa trong Admin nếu cần.
// • Cột 5 (Mã KĐCL): CSV mã tiêu chí TT 17/2018 cấp tiểu học (28 tiêu chí). Bỏ
//   prefix "TC*-" cho gọn (mã 1.1 chỉ thuộc TC1, 5.6 chỉ thuộc TC5 → unique).
//   Giá trị đặc biệt: "TĐG" (cụm Tự đánh giá), "ĐGN" (Đánh giá ngoài), "ĐBCL".
// 1 hồ sơ có thể là minh chứng cho NHIỀU tiêu chí — phân tách bằng dấu phẩy.
// ─────────────────────────────────────────────────────────────────────────────
const DATA_HSS = [
  ["", "1. HIỆU TRƯỞNG", "", "", ""],
  ["", "1.1. Kế hoạch", "", "", ""],
  ["1", "1.1.1. Chiến lược phát triển giáo dục", "https://drive.google.com/drive/folders/1QiLsV0QD8KhevrxCTZqL7gJosz3GpGjb", "Hiệu trưởng", "1.1, 1.10"],
  ["2", "1.1.2. Kế hoạch giáo dục nhà trường", "https://drive.google.com/drive/folders/1klnZ_4cLaP3uI09MrbkL6iycdbldDgKI", "Hiệu trưởng", "1.1, 1.8, 5.1"],
  ["3", "1.1.3. Kế hoạch Phát triển giáo dục", "", "Hiệu trưởng", "1.1"],
  ["4", "1.1.4. Kế hoạch Tháng - Tuần & các kế hoạch khác", "https://drive.google.com/drive/folders/1erdRBTNX6iM7CqL6YwEkeurFwX1PDy74", "Hiệu trưởng", "1.8"],
  ["", "1.2. Nghị quyết", "", "", ""],
  ["5", "1.2.1. NQ về Kế hoạch phát triển nhà trường", "https://drive.google.com/drive/folders/1I_4OJ4z6VSSe7TnHGpeav7R-TkZ5Rbl5", "Hiệu trưởng", "1.1, 1.2"],
  ["6", "1.2.2. NQ về Quy chế tổ chức và hoạt động", "https://drive.google.com/drive/folders/1GSW0ojA5T8fnwd_b_7DQx2j-O6jUpyAI", "Hiệu trưởng", "1.2"],
  ["7", "1.2.3. NQ về Tài chính và Tài sản", "https://drive.google.com/drive/folders/1lYld5GChxRPMZCHqJqC9SlL1xS8uFjrZ", "Hiệu trưởng", "1.2, 1.6"],
  ["8", "1.2.4. NQ về Giám sát", "https://drive.google.com/drive/folders/1xZcuicYnXINk4L_tru1ylG3HPgJqSgB-", "Hiệu trưởng", "1.2"],
  ["", "1.3. Quy chế", "", "", ""],
  ["9", "1.3.1. QC thực hiện dân chủ & QC chi tiêu nội bộ", "https://drive.google.com/drive/folders/1aahXyQedo296_q-mflnkyoC4abIdzYNM", "Hiệu trưởng", "1.6, 1.9"],
  ["10", "1.3.2. QC chuyên môn, TĐ-KT & QL tài sản", "https://drive.google.com/drive/folders/1SHybRzxPshzODFIeEnQYw0jKjzOyP1gy", "Hiệu trưởng", "1.6, 1.8"],
  ["11", "1.3.3. QC tổ chức và hoạt động nhà trường", "", "Hiệu trưởng", "1.4"],
  ["", "1.4. Quyết định", "", "", ""],
  ["12", "1.4.1. QĐ về Tổ chức Nhân sự", "https://drive.google.com/drive/folders/1JxyHjIGxA92DhvqzQ57-OfymsGoT9YGC", "Hiệu trưởng", "1.4, 1.7"],
  ["13", "1.4.2. QĐ thành lập các Hội đồng", "https://drive.google.com/drive/folders/1f9T6w8C_sxD40M4USDB_WsCAK6uPq670", "Hiệu trưởng", "1.4"],
  ["14", "1.4.3. QĐ về Học sinh", "https://drive.google.com/drive/folders/17-XGFXAAPO_d8AjOihZmHkmCb-JpsgbG", "Hiệu trưởng", "1.5, 2.4"],
  ["", "1.5. Tài chính", "", "", ""],
  ["15", "1.5.1. VB chỉ đạo, hướng dẫn Thu-Chi & QĐ Tài chính", "https://drive.google.com/drive/folders/1ylHxBh6W4F2SEapd2nbrGlom1-zTWBCk", "Hiệu trưởng", "1.6"],
  ["16", "1.5.2. Công khai tài chính (TC, khoản thu, tài trợ, hỗ trợ)", "https://drive.google.com/drive/folders/1ydmNeCNwIlKJpEU1llBwJ2Uan0LRCnNg", "Hiệu trưởng", "1.6, 1.9"],
  ["17", "1.5.3. Kế hoạch mua sắm, sửa chữa lớn trong năm", "https://drive.google.com/drive/folders/1rPo1sbNtfYL9V9O6Dj-Av_nT9X1raNGC", "Hiệu trưởng", "1.6, 3.5"],
  ["", "1.6. Tài sản", "", "", ""],
  ["18", "1.6.1. Hồ sơ TS đầu vào: đất đai XDCB, mua sắm, biếu tặng", "https://drive.google.com/drive/folders/1x6zJ6_hxmnp-SFapXDX7kUOSfGSDBAw_", "Hiệu trưởng", "1.6, 3.1, 3.5"],
  ["19", "1.6.2. Sổ sách theo dõi QL TS: Sổ TSCĐ, Sổ CC-DC", "https://drive.google.com/drive/folders/1fLRpGQGzPT4MdV96BXPBpKAPg8OmT2u2", "Hiệu trưởng", "1.6"],
  ["20", "1.6.3. Hồ sơ cấp phát, sử dụng và bảo dưỡng tài sản", "https://drive.google.com/drive/folders/1piRgidXw8IZ3FxidkIsS7uLfvrfDbK_i", "Hiệu trưởng", "1.6, 3.5"],
  ["21", "1.6.4. Hồ sơ kiểm kê, thanh lý và tiêu hủy tài sản", "https://drive.google.com/drive/folders/1LX-yaH4WODXY9eJl6zsmbJwgl4PF7Vt1", "Hiệu trưởng", "1.6"],
  ["", "1.7. Tổ chức", "", "", ""],
  ["22", "1.7.1. Sơ đồ tổ chức, QĐ thành lập Tổ & Phân công NV", "https://drive.google.com/drive/folders/1eivpSuH18d3kPeftvdgigOIOovvLs0lw", "Hiệu trưởng", "1.4, 1.7"],
  ["23", "1.7.2. Hồ sơ viên chức & Hợp đồng lao động", "https://drive.google.com/drive/folders/1ZhRMo1BfYT2WljkliZaDagGy3Huh0tlh", "Hiệu trưởng", "1.7, 2.1, 2.2, 2.3"],
  ["24", "1.7.3. Hồ sơ các Hội đồng (TĐKT, Tuyển sinh, TVCM, KL)", "https://drive.google.com/drive/folders/1MNe2Y_PYbjhAs3_h7ByUp8ZSIruiao-x", "Hiệu trưởng", "1.4, 1.7"],
  ["", "1.8. Thi đua - Khen thưởng - Kỷ luật", "", "", ""],
  ["25", "1.8.1. Hồ sơ phát động, đăng ký & giao ước thi đua", "https://drive.google.com/drive/folders/1FLbXvWdHJNKEEIeFFj1xy26ScvEpCprK", "Hiệu trưởng", "1.7, 2.2"],
  ["26", "1.8.2. Hồ sơ xét khen thưởng GV, NV & Học sinh", "https://drive.google.com/drive/folders/1yBEFUIZZ6RItdmx0VAIExREvqbt2OzFq", "Hiệu trưởng", "1.7, 2.2, 2.4"],
  ["27", "1.8.3. Hồ sơ Kỷ luật GV, NV & Học sinh", "https://drive.google.com/drive/folders/1tJE2wPRZDlbWmEd9vbm7_OO46A5OVjCG", "Hiệu trưởng", "1.7, 2.2, 2.4"],
  ["28", "1.8.4. Hồ sơ Sáng kiến kinh nghiệm (SKKN)", "https://drive.google.com/drive/folders/1rZqL3uMZfOtBW9Lzp0E3mesnis7L3Hkf", "Hiệu trưởng", "2.2"],
  ["", "1.9. Phối hợp", "", "", ""],
  ["29", "1.9.1. Phối hợp An ninh trật tự & An toàn trường học", "https://drive.google.com/drive/folders/1B3bIPQZNkLHSrk4dZI6vY8XnvBfKxE90", "Hiệu trưởng", "1.10, 4.2"],
  ["30", "1.9.2. Phối hợp Y tế & Chăm sóc sức khỏe", "https://drive.google.com/drive/folders/1zhtqHRJzvtHJt_7bjtuzcTFbaCPFyNi0", "Hiệu trưởng", "1.10, 4.2"],
  ["31", "1.9.3. Phối hợp GD truyền thống & Khuyến học", "https://drive.google.com/drive/folders/111qkIO37UqJdZgi8GP7IYgaU7h7v-9XC", "Hiệu trưởng", "4.2, 5.4"],
  ["", "1.10. Báo cáo", "", "", ""],
  ["32", "1.10.1. BC định kỳ: Sơ kết HKI & Tổng kết năm học", "https://drive.google.com/drive/folders/1zs9nO0DRCAPgsrZAV9cbHREKkIYqE_8u", "Hiệu trưởng", "1.1, 1.8, 5.6"],
  ["33", "1.10.2. BC Thống kê định kỳ (đầu, giữa, cuối năm)", "https://drive.google.com/drive/folders/1BLOsabOIxX61fZYfEuoKhayUKZMGTlNH", "Hiệu trưởng", "1.1, 5.6"],
  ["34", "1.10.3. BC chuyên đề (QCDC, ANTH-ATGT, TV-TB)", "https://drive.google.com/drive/folders/1XIYnqPDpHcN8a3rcmcFoDzCfx499mW1v", "Hiệu trưởng", "1.9, 1.10, 3.6"],
  ["35", "1.10.4. BC Đột xuất & Giải trình", "https://drive.google.com/drive/folders/1T7hbCIYLG86T0E2f8ZHSsOyCWmnMZ3hP", "Hiệu trưởng", "1.1"],
  ["", "2. PHÓ HIỆU TRƯỞNG", "", "", ""],
  ["", "2.1. Hồ sơ Quản lý Học sinh", "", "", ""],
  ["36", "2.1.1. Sổ đăng bộ & Học bạ học sinh", "", "Phó Hiệu trưởng", "2.4, 5.6"],
  ["37", "2.1.2. Sổ theo dõi và đánh giá học sinh", "", "Phó Hiệu trưởng", "2.4, 5.6"],
  ["38", "2.1.3. Hồ sơ chuyển trường & tiếp nhận HS", "", "Phó Hiệu trưởng", "1.5, 2.4"],
  ["39", "2.1.4. Hồ sơ theo dõi Học sinh khuyết tật", "", "Phó Hiệu trưởng", "2.4, 5.2"],
  ["", "2.2. Kế hoạch chuyên môn", "", "", ""],
  ["40", "2.2.1. KH dạy học theo CTGDPT 2018", "", "Phó Hiệu trưởng", "1.8, 5.1"],
  ["41", "2.2.2. KH bồi dưỡng thường xuyên", "https://drive.google.com/drive/folders/1aSi1t6bmhQ1U17cTTES_7IqitcHSH62G", "Phó Hiệu trưởng", "2.2"],
  ["42", "2.2.3. KH Hội thi, Trải nghiệm, STEM, hướng nghiệp", "https://drive.google.com/drive/folders/1sDLEA9b0nCX8ys6e0t6hB6JdTs2ynRmp", "Phó Hiệu trưởng", "5.4, 5.5"],
  ["43", "2.2.4. KH Phụ đạo HS chưa đạt & BD HS năng khiếu", "https://drive.google.com/drive/folders/1U9Y7e7PWSwWU8SZqSGHeD39BQBmofmAS", "Phó Hiệu trưởng", "5.2, 5.6"],
  ["44", "2.2.5. KH Giáo dục địa phương", "", "Phó Hiệu trưởng", "5.3"],
  ["", "2.3. Thời khóa biểu & Phân công", "", "", ""],
  ["45", "2.3.1. Thời khóa biểu & Phân công chuyên môn", "https://drive.google.com/drive/folders/1P0fhWkWMtd5-yZcV9-kOH_ysZt8sdHTa", "Phó Hiệu trưởng", "1.4, 1.8, 5.1"],
  ["46", "2.3.2. Phân công dạy thay", "https://drive.google.com/drive/folders/1aHG3GYS7plVttoqb4VcDHXJxuvrmT4YV", "Phó Hiệu trưởng", "1.7, 5.1"],
  ["", "2.4. Theo dõi chất lượng", "", "", ""],
  ["47", "2.4.1. Ma trận & Đề kiểm tra định kỳ", "https://drive.google.com/drive/folders/15vJpV3mov--KZn5xlfkWA6UR-xiWhstu", "Phó Hiệu trưởng", "5.1, 5.6"],
  ["48", "2.4.2. Tổng hợp Kết quả Chất lượng giáo dục", "https://drive.google.com/drive/folders/1Xkbmz7IPvFEoFrYEyAZ5fzAN1GuoigHD", "Phó Hiệu trưởng", "5.6"],
  ["49", "2.4.3. Danh sách Khen thưởng học sinh", "https://drive.google.com/drive/folders/139Nu6io_NdvpZkz2AcomHP5Hna0QOU_a", "Phó Hiệu trưởng", "2.4, 5.6"],
  ["", "2.5. Phổ cập giáo dục Tiểu học", "", "", ""],
  ["50", "2.5.1. Các văn bản chỉ đạo về công tác PCGD Tiểu học", "https://drive.google.com/drive/folders/1nLv1CknIqsA0u7Hwpv6HYE5rtTRwCepp", "Phó Hiệu trưởng", "1.5"],
  ["51", "2.5.2. Hồ sơ PCGD Tiểu học (KH, BC, Tờ trình và các Biểu mẫu)", "https://drive.google.com/drive/folders/1Z6aR6r7TgcIwbFGgOdQV0G25APuHc0ig", "Phó Hiệu trưởng", "1.5"],
  ["", "2.6. Hồ sơ khác", "", "", ""],
  ["52", "2.6.1. Hồ sơ Tuyển sinh vào lớp 1", "https://drive.google.com/drive/folders/1HErPYh7_9EXIGRzdbouMrg1nZKh5aJrz", "Phó Hiệu trưởng", "1.5, 2.4"],
  ["53", "2.6.2. Hồ sơ SHCM trường & Kiểm tra nội bộ CM", "https://drive.google.com/drive/folders/1wtITeXXXkMSxh_u-RXbkfLQQkZUmJVr5", "Phó Hiệu trưởng", "1.8, 2.2"],
  ["", "3. TỔ CHUYÊN MÔN", "", "", ""],
  ["", "3.1. Kế hoạch môn học", "", "", ""],
  ["54", "3.1.1. Kế hoạch môn học Lớp 1", "https://drive.google.com/drive/folders/16QR-h63G4qgoyJmQtM0j2c-ExVdt5bPf", "Tổ trưởng Tổ 1-2-3", "5.1"],
  ["55", "3.1.2. Kế hoạch môn học Lớp 2", "https://drive.google.com/drive/folders/1BDnO73jo957_yfF29am6IvTYaQoITXrj", "Tổ trưởng Tổ 1-2-3", "5.1"],
  ["56", "3.1.3. Kế hoạch môn học Lớp 3", "https://drive.google.com/drive/folders/1hmAFtJhv5r25s5d-epXXpKIdNDZJABMb", "Tổ trưởng Tổ 1-2-3", "5.1"],
  ["57", "3.1.4. Kế hoạch môn học Lớp 4", "https://drive.google.com/drive/folders/1tMHbIT_9ZZL4tjzymTcUkK-kzpCTDpyR", "Tổ trưởng Tổ 4-5", "5.1"],
  ["58", "3.1.5. Kế hoạch môn học Lớp 5", "https://drive.google.com/drive/folders/1f3gvHWJmwG8473l1SPguXWH_OGGQ2bep", "Tổ trưởng Tổ 4-5", "5.1"],
  ["", "3.2. Sinh hoạt chuyên môn", "", "", ""],
  ["59", "3.2.1. KH & Biên bản SHCM Tổ 1-2-3", "https://drive.google.com/drive/folders/1ilUWofemjvuG0sDgJSinTMnmFx--XBuI", "Tổ trưởng Tổ 1-2-3", "1.4, 2.2"],
  ["60", "3.2.2. KH & Biên bản SHCM Tổ 4-5", "https://drive.google.com/drive/folders/1ZkjYgB8LynWVGlBiK1FqUE8OmyNDct-b", "Tổ trưởng Tổ 4-5", "1.4, 2.2"],
  ["61", "3.2.3. Sổ ghi chép hoạt động các Tổ Chuyên môn", "", "Tổ trưởng CM", "1.4, 2.2"],
  ["", "3.3. Đổi mới & Tài nguyên số", "", "", ""],
  ["62", "3.3.1. Ngân hàng Đề kiểm tra & Thư viện Giáo án", "https://drive.google.com/drive/folders/1pU6zop_-eannRL111a3XPJ-PnugokAgZ", "Tổ trưởng CM", "5.1, 5.6"],
  ["63", "3.3.2. Kho tranh ảnh, video & Tài liệu chuyên đề CM", "https://drive.google.com/drive/folders/1e7ucwZB1EiMd1oGhqsOjWqa434aJyJB7", "Tổ trưởng CM", "3.5, 5.1"],
  ["64", "3.3.3. Hồ sơ đổi mới PP dạy học & ứng dụng CNTT", "", "Tổ trưởng CM", "2.2, 5.1"],
  ["", "4. NHÓM HỒ SƠ HÀNH CHÍNH", "", "", ""],
  ["", "4.1. Văn thư", "", "", ""],
  ["65", "4.1.1. Văn bản đến", "https://drive.google.com/drive/folders/1DDXAURPr86g51qPCmDL0gleF4n2nphOr", "Văn thư", "1.6"],
  ["66", "4.1.2. Văn bản đi & Quản lý VB điện tử", "https://drive.google.com/drive/folders/1jks4LYbOiuK7kyPRndhNTUk98mEel2eh", "Văn thư", "1.6"],
  ["67", "4.1.3. QĐ - Tờ trình (nội bộ) & Hồ sơ học vụ", "https://drive.google.com/drive/folders/1Cx_UjMfy_qJN27CFJ8cmYdICMqNOC9Uc", "Văn thư", "1.5, 1.6"],
  ["68", "4.1.4. Biểu mẫu, quy trình & Lưu trữ thống kê", "https://drive.google.com/drive/folders/13AJerQQr98U6nKs41mdE_3ibEHzgCLmY", "Văn thư", "1.6"],
  ["", "4.2. Thư viện", "", "", ""],
  ["69", "4.2.1. Hồ sơ PL-KH, sổ sách nghiệp vụ & kiểm kê TV", "https://drive.google.com/drive/folders/1ItNAlfWijIv9VhLnXjXLQzEZk5Vp89Wg", "Thủ thư", "3.6"],
  ["70", "4.2.2. Hồ sơ xây dựng và phát triển văn hóa đọc", "", "Thủ thư", "3.6, 5.5"],
  ["", "4.3. Thiết bị", "", "", ""],
  ["71", "4.3.1. Danh mục-Kho TB, đăng ký Mượn-Trả & Báo hỏng", "https://drive.google.com/drive/folders/1RaEiWNiX5WmLxt75TOPuQEsiQAlfV-xk", "Cán bộ Thiết bị", "3.5"],
  ["72", "4.3.2. KH mua sắm & kiểm kê thiết bị", "https://drive.google.com/drive/folders/11uRnjH9ydIQM1vstrrtQhN7kghg9IKuD", "Cán bộ Thiết bị", "1.6, 3.5"],
  ["", "4.4. Y tế", "", "", ""],
  ["73", "4.4.1. KH-VB Y tế, theo dõi SK HS & Nhật ký phòng YT", "https://drive.google.com/drive/folders/1OznMM1wNlZ0zbbrck56OK2c__9fQBJzp", "Y tế học đường", "1.10, 3.4"],
  ["74", "4.4.2. BHYT & Truyền thông phòng dịch bệnh", "https://drive.google.com/drive/folders/1YtXeLWOqjVyvhSTUFcR7IhySYzPghQLo", "Y tế học đường", "1.10, 4.2"],
  ["", "5. KẾ TOÁN", "", "", ""],
  ["75", "5.1. Bảng thanh toán lương", "https://drive.google.com/drive/folders/1ruIxwE70Ki9bLnB4H0NPvTLfZpBkwozT", "Kế toán", "1.6, 1.7"],
  ["76", "5.2. Hợp đồng lao động", "https://drive.google.com/drive/folders/1Kaq23nj07Zww1aErwAQemN-DIZ-bGE_G", "Kế toán", "1.7, 2.2, 2.3"],
  ["77", "5.3. Biên bản", "https://drive.google.com/drive/folders/18rni_FRvqQDb4x3h6rLRfhfsRXzFNn6s", "Kế toán", "1.6"],
  ["78", "5.4. Quyết định", "https://drive.google.com/drive/folders/1ewInItmA-YhK8yuW5Vddy41SwgqyH0m7", "Kế toán", "1.6"],
  ["79", "5.5. Báo cáo tài chính", "https://drive.google.com/drive/folders/12xyMhG0pYIk8l-8LwsXSAeLYc3HqcRRK", "Kế toán", "1.6"],
  ["", "6. ĐẢNG", "", "", ""],
  ["80", "6.1. Nghị quyết Chi bộ", "https://drive.google.com/drive/folders/1gU9xSEQtmKEPQufnQb36iGsnZQFfuind", "Bí thư Chi bộ", "1.3"],
  ["81", "6.2. Quyết định", "https://drive.google.com/drive/folders/18anxDLRyznSCJ9_FHLdcDXHiddEPzoOV", "Bí thư Chi bộ", "1.3"],
  ["82", "6.3. Biên bản họp Chi ủy, Chi bộ", "https://drive.google.com/drive/folders/1-ukFUU_sw9GEMxnrP79a4ncAvEV6boT-", "Bí thư Chi bộ", "1.3"],
  ["83", "6.4. Báo cáo", "https://drive.google.com/drive/folders/1Q9r4YPiGXjuIh_dpTzN9xfm8LzLDOa9M", "Bí thư Chi bộ", "1.3"],
  ["84", "6.5. Xếp loại đảng viên", "https://drive.google.com/drive/folders/1aOJbC66dPI9f9b3kBwrr1bGXOnlk_6pJ", "Bí thư Chi bộ", "1.3"],
  ["", "7. ĐỘI - SAO NHI ĐỒNG", "", "", ""],
  ["85", "7.1. KH hoạt động & QĐ tổ chức Đội, Sao nhi đồng", "https://drive.google.com/drive/folders/1vZ8AU5_9VrDI2YkzQM5HAjj1nQ3YR0yw", "Tổng phụ trách Đội", "1.3, 5.4"],
  ["86", "7.2. Biên bản, báo cáo hoạt động Đội", "https://drive.google.com/drive/folders/1iMx59o_qfk1Qju4QbqbrJs56hih-I3es", "Tổng phụ trách Đội", "1.3, 5.4"],
  ["87", "7.3. Hình ảnh, tư liệu hoạt động ngoài giờ lên lớp", "https://drive.google.com/drive/folders/1Q6HsubKeNC4U3T3MktyL7llYqFQ1L55d", "Tổng phụ trách Đội", "5.4, 5.5"],
  ["", "8. BAN ĐẠI DIỆN CHA MẸ HỌC SINH", "", "", ""],
  ["", "8.1. Hồ sơ tổ chức, hội họp", "", "", ""],
  ["88", "8.1.1. DS Trích ngang; Quy chế hoạt động Ban đại diện", "https://drive.google.com/drive/folders/1NjG6mMpqwHEug-LFtzEeiKj2WarlECkf", "Trưởng Ban ĐDCMHS", "4.1"],
  ["89", "8.1.2. KH hoạt động và các biên bản của Ban đại diện", "https://drive.google.com/drive/folders/1kWH77xwSAK0xPcZqnik4lcVZJhtYQIQa", "Trưởng Ban ĐDCMHS", "4.1, 4.2"],
  ["", "9. HỒ SƠ CÁN BỘ, GIÁO VIÊN, NHÂN VIÊN", "", "", ""],
  ["", "9.1. Hồ sơ Năng lực", "", "", ""],
  ["90", "9.1.1. Hồ sơ Năng lực (công tác TCCB)", "", "Cá nhân CB-GV-NV", "2.1, 2.2, 2.3"],
  ["91", "9.1.2. Đánh giá xếp loại theo NĐ90 và Đánh giá CNN GV", "", "Cá nhân CB-GV-NV", "2.1, 2.2"],
  ["92", "9.1.3. Hồ sơ BDTX theo module hàng năm", "", "Cá nhân CB-GV-NV", "2.2"],
  ["93", "9.1.4. Kế hoạch bài dạy; Sổ dự giờ", "", "Cá nhân CB-GV-NV", "2.2, 5.1"],
  ["", "9.2. Sổ Chủ nhiệm", "", "", ""],
  ["94", "9.2.1. Sổ Chủ nhiệm (kế hoạch, theo dõi, nhận xét HS)", "https://drive.google.com/drive/folders/1_sJC3VBvwibhuaGA-mIMB5kT81OGD4bE", "GVCN", "2.2, 2.4, 5.1"],
  ["", "10. KIỂM ĐỊNH CHẤT LƯỢNG GIÁO DỤC (KĐCL)", "", "", ""],
  ["", "10.1. Hồ sơ Hội đồng tự đánh giá", "", "", ""],
  ["95", "10.1.1. QĐ thành lập Hội đồng tự đánh giá", "", "Hiệu trưởng", "TĐG"],
  ["96", "10.1.2. Kế hoạch tự đánh giá", "https://drive.google.com/drive/folders/1D9lON7c_0KE6Jl7CSSRiZgtiIj88tskK", "Thư ký HĐ TĐG", "TĐG"],
  ["97", "10.1.3. Các biên bản họp Hội đồng TĐG", "", "Thư ký HĐ TĐG", "TĐG"],
  ["", "10.2. Hồ sơ chuyên môn KĐCL", "", "", ""],
  ["98", "10.2.1. Phiếu phân tích tiêu chí & xác định nội hàm", "", "Thư ký HĐ TĐG", "TĐG"],
  ["99", "10.2.2. Phiếu đánh giá tiêu chí (5 tiêu chuẩn, 4 mức)", "", "Thư ký HĐ TĐG", "TĐG"],
  ["100", "10.2.3. Báo cáo tự đánh giá", "", "Thư ký HĐ TĐG", "TĐG"],
  ["", "10.3. Hồ sơ Đánh giá ngoài & Công nhận", "", "", ""],
  ["101", "10.3.1. Hồ sơ đăng ký ĐGN & đón Đoàn ĐGN", "", "Phó HT phụ trách CM", "ĐGN"],
  ["102", "10.3.2. Chứng nhận KĐCL & Bằng CN trường đạt CQG", "", "Phó HT phụ trách CM", "ĐGN"],
  ["103", "10.3.3. Kế hoạch cải tiến chất lượng sau kiểm định", "", "Phó HT phụ trách CM", "ĐGN"],
  ["104", "10.3.4. Quy trình lưu trữ minh chứng điện tử (TT22)", "", "Phó HT phụ trách CM", "ĐGN"],
  ["", "11. ĐẢM BẢO CHẤT LƯỢNG", "", "", ""],
  ["", "11.1. Hệ thống văn bản ĐBCL", "", "", ""],
  ["105", "11.1.1. VB chỉ đạo ĐBCL của Sở GDĐT Nghệ An", "", "Phó HT phụ trách CM", "ĐBCL"],
  ["106", "11.1.2. KH thực hiện ĐBCL của nhà trường", "https://drive.google.com/drive/folders/1GLMOjte1lx04JjtkjHjrJWtcxEmLksoZ", "Phó HT phụ trách CM", "ĐBCL"],
  ["", "11.2. Công cụ đánh giá ĐBCL", "", "", ""],
  ["107", "11.2.1. Phụ lục ĐBCL (biểu mẫu theo HD của Sở)", "", "Phó HT phụ trách CM", "ĐBCL"],
  ["108", "11.2.2. Bảng đối sánh Kết quả giáo dục qua các năm", "", "Phó HT phụ trách CM", "ĐBCL"],
  ["109", "11.2.3. Báo cáo ĐBCL & Kế hoạch cải tiến hàng năm", "", "Phó HT phụ trách CM", "ĐBCL"]
];

const DATA_DSGV = [
  // Mẫu: ["1", "Họ tên", "01/01/1980", "Hiệu trưởng", "Đại học SP", "0987xxxxxx", "email@...", "Link Drive hồ sơ"]
];

const DATA_HS = [
  // Mẫu: ["1", "Lớp 1A", "MaHS", "Họ tên", "01/01/2019", "Nam", "Kinh", "Không", "Tỉnh...", "", "Xã...", "", "Nơi sinh", "SĐT", "Cha", "Năm cha", "Mẹ", "Năm mẹ"]
];

const DATA_HINHANH = [
  // Mẫu: ["1", "Tên slide", "Mô tả", "https://drive.google.com/...", "truong|hoatdong|lehoi|banru"]
];

const DATA_CAUHINH = [
  ['Tên trường',        SCHOOL_CONFIG.name],
  ['Địa chỉ',           SCHOOL_CONFIG.address],
  ['Điện thoại',        SCHOOL_CONFIG.phone],
  ['Email',             SCHOOL_CONFIG.email],
  ['Năm học',           SCHOOL_CONFIG.schoolYear],
  ['Hiệu trưởng',       SCHOOL_CONFIG.principal],
  ['Phó Hiệu trưởng',   SCHOOL_CONFIG.vicePrincipal],
  ['Slogan',            'Vững bước tương lai – Tự tin hội nhập'],
  ['Logo emoji',        '🏫'],
  ['Màu chủ đạo',      '#2d8a6e']
];

const DATA_MINHCHUNG = [
  ["", "TC1", "Tổ chức và quản lý nhà trường", "", "", "", "", "", "", ""],
  ["", "", "1.1", "Phương hướng, chiến lược XD và phát triển NT", "", "", "", "", "", ""],
  ["", "", "1.2", "Hội đồng trường", "", "", "", "", "", ""],
  ["", "", "1.3", "Tổ chức Đảng Cộng sản VN, các đoàn thể và tổ chức khác", "", "", "", "", "", ""],
  ["", "", "1.4", "Hiệu trưởng, phó HT, tổ chuyên môn, tổ VP", "", "", "", "", "", ""],
  ["", "", "1.5", "Khối lớp và quy mô", "", "", "", "", "", ""],
  ["", "", "1.6", "Quản lý hành chính, tài chính, tài sản của NT", "", "", "", "", "", ""],
  ["", "", "1.7", "Quản lý cán bộ, GV và nhân viên", "", "", "", "", "", ""],
  ["", "", "1.8", "Quản lý các hoạt động giáo dục", "", "", "", "", "", ""],
  ["", "", "1.9", "Thực hiện quy chế dân chủ", "", "", "", "", "", ""],
  ["", "", "1.10", "Đảm bảo an ninh trật tự, an toàn trường học", "", "", "", "", "", ""],

  ["", "TC2", "Cán bộ quản lý, giáo viên, nhân viên và học sinh", "", "", "", "", "", "", ""],
  ["", "", "2.1", "Đối với hiệu trưởng, phó HT", "", "", "", "", "", ""],
  ["", "", "2.2", "Đối với giáo viên", "", "", "", "", "", ""],
  ["", "", "2.3", "Đối với nhân viên", "", "", "", "", "", ""],
  ["", "", "2.4", "Đối với học sinh", "", "", "", "", "", ""],

  ["", "TC3", "Cơ sở vật chất và thiết bị dạy học", "", "", "", "", "", "", ""],
  ["", "", "3.1", "Khuôn viên, khu sân chơi, bãi tập", "", "", "", "", "", ""],
  ["", "", "3.2", "Phòng học", "", "", "", "", "", ""],
  ["", "", "3.3", "Khối phòng phục vụ học tập và khối phòng hành chính-quản trị", "", "", "", "", "", ""],
  ["", "", "3.4", "Khu vệ sinh, hệ thống cấp thoát nước", "", "", "", "", "", ""],
  ["", "", "3.5", "Thiết bị dạy học, học liệu", "", "", "", "", "", ""],
  ["", "", "3.6", "Thư viện", "", "", "", "", "", ""],

  ["", "TC4", "Quan hệ giữa nhà trường, gia đình và xã hội", "", "", "", "", "", "", ""],
  ["", "", "4.1", "Ban đại diện CMHS", "", "", "", "", "", ""],
  ["", "", "4.2", "Công tác tham mưu cấp ủy Đảng, chính quyền và phối hợp các tổ chức XH", "", "", "", "", "", ""],

  ["", "TC5", "Hoạt động giáo dục và kết quả giáo dục", "", "", "", "", "", "", ""],
  ["", "", "5.1", "Thực hiện chương trình giáo dục", "", "", "", "", "", ""],
  ["", "", "5.2", "Tổ chức hoạt động giáo dục cho HS có hoàn cảnh khó khăn", "", "", "", "", "", ""],
  ["", "", "5.3", "Thực hiện nội dung giáo dục địa phương", "", "", "", "", "", ""],
  ["", "", "5.4", "Các hoạt động trải nghiệm và hoạt động giáo dục khác", "", "", "", "", "", ""],
  ["", "", "5.5", "Hình thành, phát triển các kỹ năng cho HS", "", "", "", "", "", ""],
  ["", "", "5.6", "Kết quả giáo dục", "", "", "", "", "", ""]
];

// =====================================================================================
// ==========          BƯỚC 3: HÀM SETUP - TẠO TAB NGAY TRONG SHEET             ========
// =====================================================================================
/**
 * ⭐ seedHSSDefault109 — Nạp danh sách 109 Hồ sơ mặc định vào sheet "Danh muc HSS".
 *
 * AN TOÀN: KHÔNG đụng sheet DSGV / DS HocSinh / MinhChung. Chỉ ghi đè đúng tab
 * "Danh muc HSS". Backup link Drive đã dán theo mã code → clear → nạp lại 109 →
 * restore link cho mã code khớp. Trường có thể tùy chỉnh thêm trên Admin web.
 *
 * Cách dùng: Apps Script editor → dropdown chọn "seedHSSDefault109" → ▶ Chạy.
 * Xem Logger để biết kết quả: số leaf, số link đã khôi phục.
 */
function seedHSSDefault109() {
  const ss = _getSS();
  let sh = ss.getSheetByName(SHEET_HSS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_HSS);
    sh.getRange(1, 1, 1, 5)
      .setValues([['TT', 'Danh mục Hồ sơ', 'Link', 'Phân công nhiệm vụ', 'Mã hóa']])
      .setFontWeight('bold').setBackground('#2d8a6e').setFontColor('#ffffff');
    sh.setRowHeight(1, 40);
    [50, 450, 280, 280, 140].forEach(function(w, i){ sh.setColumnWidth(i+1, w); });
    sh.setFrozenRows(1);
  }

  // 1) Backup data cũ theo mã code (vd "1.1.1") → giữ user customization khi seed lại.
  //    Backup CẢ 3 trường: Link, Phân công, Mã hóa (nếu user đã chỉnh, không bị ghi đè bởi default).
  const backup = {};   // { code: { link, assign, kdcl } }
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const oldData = sh.getRange(2, 1, lastRow - 1, 5).getValues();
    oldData.forEach(function(r){
      const name   = String(r[1] || '').trim();
      const link   = String(r[2] || '').trim();
      const assign = String(r[3] || '').trim();
      const kdcl   = String(r[4] || '').trim();
      const m = name.match(/^(\d+(?:\.\d+)*)\.\s*/);
      if (!m) return;
      const code = m[1];
      // Chỉ backup field nào có giá trị — null/empty fallback về default mới
      const b = {};
      if (link)   b.link   = link;
      if (assign) b.assign = assign;
      if (kdcl)   b.kdcl   = kdcl;
      if (Object.keys(b).length) backup[code] = b;
    });
  }
  const backupCount = Object.keys(backup).length;
  Logger.log('📦 Backup ' + backupCount + ' dòng có user data từ sheet cũ (link/phân công/mã hóa)');

  // 2) Clear data cũ (giữ header)
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 5).clearContent();

  // 3) Build rows mới: ưu tiên backup user data, fallback về default trong DATA_HSS
  let leafCount = 0, restoredLink = 0, restoredAssign = 0, restoredKdcl = 0;
  const newRows = DATA_HSS.map(function(row){
    const tt = row[0], name = row[1], defLink = row[2], defAssign = row[3], defKdcl = row[4];
    const m = String(name).match(/^(\d+(?:\.\d+)*)\.\s*/);
    if (!m || !tt) return [tt, name, defLink, defAssign, defKdcl]; // group hoặc dòng lạ
    leafCount++;
    const code = m[1];
    const b = backup[code] || {};
    // Ưu tiên user data, fallback default
    const finalLink   = b.link   || defLink   || '';
    const finalAssign = b.assign || defAssign || '';
    const finalKdcl   = b.kdcl   || defKdcl   || '';
    if (b.link)   restoredLink++;
    if (b.assign) restoredAssign++;
    if (b.kdcl)   restoredKdcl++;
    return [tt, name, finalLink, finalAssign, finalKdcl];
  });

  // 4) Ghi vào sheet
  if (newRows.length) {
    sh.getRange(2, 1, newRows.length, 5).setValues(newRows);
  }

  // 5) Reset cache để frontend đọc data mới
  try { CacheService.getScriptCache().remove('allData'); } catch(e) {}

  Logger.log('✅ HOÀN TẤT — Đã nạp ' + newRows.length + ' dòng vào sheet "' + SHEET_HSS + '"');
  Logger.log('   • ' + leafCount + ' hồ sơ (leaf — có TT)');
  Logger.log('   • Khôi phục từ user data: ' + restoredLink + ' link, ' +
             restoredAssign + ' phân công, ' + restoredKdcl + ' mã hóa');
  Logger.log('   • Bước tiếp: vào Admin web → Hồ sơ số để chỉnh sửa link Drive cho từng hồ sơ');
  Logger.log('   • KHÔNG đụng đến: DSGV, DS HocSinh, MinhChung, các tab QLCL_*');

  return { ok: true, data: {
    totalRows: newRows.length,
    leaves: leafCount,
    restoredLinks: restoredLink,
    restoredAssign: restoredAssign,
    restoredKdcl: restoredKdcl
  }};
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Apps Script phải mở từ trong Google Sheet (Tiện ích mở rộng → Apps Script).');

  _populateSheet(ss);

  _logDivider();
  Logger.log('✅ ĐÃ TẠO 6 TAB VÀ ĐỔ TOÀN BỘ DỮ LIỆU THÀNH CÔNG');
  Logger.log('📋 Sheet: ' + ss.getName() + ' - ' + ss.getUrl());
  Logger.log('');
  Logger.log('📊 Đã nhập:');
  Logger.log('   • ' + DATA_HSS.length     + ' dòng vào "Danh muc HSS"');
  Logger.log('   • ' + DATA_DSGV.length    + ' giáo viên vào "DSGV"');
  Logger.log('   • ' + DATA_HS.length      + ' học sinh vào "DS HocSinh"');
  Logger.log('   • ' + DATA_HINHANH.length + ' ảnh vào "Hinh Anh"');
  Logger.log('   • ' + DATA_CAUHINH.length + ' cấu hình vào "CauHinh"');
  Logger.log('   • ' + DATA_MINHCHUNG.length + ' minh chứng vào "MinhChung"');
  _logDivider();
  Logger.log('BƯỚC TIẾP THEO: Triển khai → New deployment → Web app → Anyone → Deploy.');
  _logDivider();
  return ss.getUrl();
}

function _populateSheet(ss) {
  const HEADER_BG = '#2d8a6e';
  const HEADER_FG = '#ffffff';

  // -------- Sheet 1: Danh muc HSS --------
  let s1 = ss.getSheetByName(SHEET_HSS);
  if (!s1) s1 = ss.insertSheet(SHEET_HSS);
  s1.clear();
  s1.getRange(1, 1, 1, 5)
    .setValues([['TT', 'Danh mục Hồ sơ', 'Link', 'Phân công nhiệm vụ', 'Mã hóa']])
    .setFontWeight('bold').setBackground(HEADER_BG).setFontColor(HEADER_FG);
  s1.setRowHeight(1, 40);
  [50, 450, 280, 280, 140].forEach(function(w, i){ s1.setColumnWidth(i+1, w); });
  s1.setFrozenRows(1);
  if (DATA_HSS.length) s1.getRange(2, 1, DATA_HSS.length, 5).setValues(DATA_HSS);

  // -------- Sheet 2: DSGV --------
  let s2 = ss.getSheetByName(SHEET_DSGV);
  if (!s2) s2 = ss.insertSheet(SHEET_DSGV);
  s2.clear();
  s2.getRange(1, 1, 1, 8)
    .setValues([['TT', 'Họ và tên', 'Ngày sinh', 'Chức vụ', 'Trình độ', 'SĐT', 'Gmail', 'Link']])
    .setFontWeight('bold').setBackground(HEADER_BG).setFontColor(HEADER_FG);
  s2.setRowHeight(1, 40);
  [50, 200, 110, 170, 110, 130, 220, 280].forEach(function(w, i){ s2.setColumnWidth(i+1, w); });
  s2.setFrozenRows(1);
  if (DATA_DSGV.length) s2.getRange(2, 1, DATA_DSGV.length, 8).setValues(DATA_DSGV);

  // -------- Sheet 3: DS HocSinh --------
  // 2026-05-07 REFACTOR: mở rộng schema 18 → 24 cột để hỗ trợ Quản lý HS
  //   Cột 1-18: thông tin gốc (như cũ)
  //   Cột 19-24: tracking biến động (HS mới)
  let s3 = ss.getSheetByName(SHEET_HS);
  if (!s3) s3 = ss.insertSheet(SHEET_HS);
  s3.clear();
  const hdr3 = [
    // ── 18 cột gốc (KHÔNG ĐỔI THỨ TỰ — DATA_HS phụ thuộc) ──
    'STT', 'Mã lớp', 'Mã học sinh', 'Họ tên', 'Ngày sinh',
    'Giới tính', 'Dân tộc', 'Tôn giáo',
    'Tỉnh/Thành phố', '', 'Xã/Phường', 'Tổ/Thôn/Xóm',
    'Nơi sinh', 'Số điện thoại',
    'Họ tên cha', 'Năm sinh cha', 'Họ tên mẹ', 'Năm sinh mẹ',
    // ── 6 cột tracking biến động (mở rộng) ──
    'IsDeleted',     // bool — true = đã chuyển đi (soft delete)
    'ReceivedDate',  // ngày tiếp nhận (nếu HS chuyển đến)
    'ReceivedFrom',  // trường cũ (nếu có)
    'TransferDate',  // ngày chuyển đi
    'TransferTo',    // trường chuyển đến
    'TransferReason' // lý do
  ];
  s3.getRange(1, 1, 1, hdr3.length)
    .setValues([hdr3])
    .setFontWeight('bold').setBackground(HEADER_BG).setFontColor(HEADER_FG)
    .setWrap(true);
  s3.setRowHeight(1, 56);
  [50,160,130,200,110,80,90,90,150,40,150,200,220,130,180,120,180,120,
   80,110,180,110,180,200].forEach(function(w, i){ s3.setColumnWidth(i+1, w); });
  s3.setFrozenRows(1);
  if (DATA_HS.length) s3.getRange(2, 1, DATA_HS.length, 18).setValues(DATA_HS);

  // -------- Sheet 4: Hinh Anh --------
  let s4 = ss.getSheetByName(SHEET_IMG);
  if (!s4) s4 = ss.insertSheet(SHEET_IMG);
  s4.clear();
  s4.getRange(1, 1, 1, 5)
    .setValues([['STT', 'Tiêu đề', 'Mô tả', 'Link ảnh', 'Loại']])
    .setFontWeight('bold').setBackground(HEADER_BG).setFontColor(HEADER_FG);
  s4.setRowHeight(1, 40);
  [50, 220, 260, 400, 100].forEach(function(w, i){ s4.setColumnWidth(i+1, w); });
  s4.setFrozenRows(1);
  if (DATA_HINHANH.length) s4.getRange(2, 1, DATA_HINHANH.length, 5).setValues(DATA_HINHANH);

  const noteRow = DATA_HINHANH.length + 3;
  s4.getRange(noteRow, 1, 1, 5).merge();
  s4.getRange(noteRow, 1).setValue('💡 GỢI Ý: Cột "Loại" có thể là: truong (toàn cảnh), hoatdong (hoạt động HS), banru (bữa ăn), lehoi (lễ hội). Link ảnh dùng URL công khai (Drive đã share Anyone, hoặc Imgur, Postimages...).')
    .setFontStyle('italic').setFontColor('#6b7a72').setWrap(true);

  // -------- Sheet 5: CauHinh --------
  let s5 = ss.getSheetByName(SHEET_CFG);
  if (!s5) s5 = ss.insertSheet(SHEET_CFG);
  s5.clear();
  s5.getRange(1, 1, 1, 2)
    .setValues([['Tên mục', 'Giá trị']])
    .setFontWeight('bold').setBackground(HEADER_BG).setFontColor(HEADER_FG);
  s5.setRowHeight(1, 40);
  [200, 500].forEach(function(w, i){ s5.setColumnWidth(i+1, w); });
  s5.setFrozenRows(1);
  if (DATA_CAUHINH.length) s5.getRange(2, 1, DATA_CAUHINH.length, 2).setValues(DATA_CAUHINH);

  const cfgNote = DATA_CAUHINH.length + 3;
  s5.getRange(cfgNote, 1, 1, 2).merge();
  s5.getRange(cfgNote, 1).setValue('💡 GỢI Ý: Chỉ sửa cột "Giá trị". Không thêm/xóa dòng. Sau khi sửa, vào trang web nhấn Admin → Làm mới dữ liệu.')
    .setFontStyle('italic').setFontColor('#6b7a72').setWrap(true);


  // -------- Sheet 6: MinhChung --------
  let s6 = ss.getSheetByName(SHEET_MC);
  if (!s6) s6 = ss.insertSheet(SHEET_MC);
  // Xóa sạch giá trị + định dạng cũ (tránh cache dưới dạng Date)
  s6.clearContents();
  s6.clearFormats();
  // ⭐ ÉP ĐỊNH DẠNG TEXT cho TOÀN BỘ VÙNG trước khi ghi (rộng hơn data để chống leak).
  const mcSafeRows = Math.max(DATA_MINHCHUNG.length + 20, 500);
  s6.getRange(1, 1, mcSafeRows, 10).setNumberFormat('@');

  const hdrMC = ['STT','Tiêu chuẩn','Tiêu chí','Mã MC','Tên minh chứng','Số/ngày ban hành','Nơi ban hành','Mã HSS liên kết','Link Drive','Ghi chú'];
  s6.getRange(1, 1, 1, hdrMC.length)
    .setValues([hdrMC])
    .setFontWeight('bold').setBackground(HEADER_BG).setFontColor(HEADER_FG)
    .setWrap(true);
  s6.setRowHeight(1, 44);
  [50,80,70,90,300,180,150,100,280,180].forEach(function(w, i){ s6.setColumnWidth(i+1, w); });
  s6.setFrozenRows(1);

  if (DATA_MINHCHUNG.length) {
    // Tra cứu link Drive từ tab "Danh muc HSS" theo số hồ sơ (vd "1.1.2").
    const hssLinkMap = _buildHssLinkMap();
    const rowsWithLinks = DATA_MINHCHUNG.map(function(r){
      const copy = r.slice();
      // Chuẩn hóa: ép mọi ô thành string để không bị auto-parse
      for (let i = 0; i < 10; i++) copy[i] = (copy[i] == null) ? '' : String(copy[i]);
      const hss = copy[7] || '';
      if (!copy[8] && hss && hssLinkMap[hss]) copy[8] = hssLinkMap[hss];
      return copy;
    });
    s6.getRange(2, 1, rowsWithLinks.length, 10).setValues(rowsWithLinks);
  }

  s6.getRange(DATA_MINHCHUNG.length + 3, 1, 1, 10).merge();
  s6.getRange(DATA_MINHCHUNG.length + 3, 1).setValue('💡 Mã MC theo CV 5932/BGDĐT-QLCL. Cột "Mã HSS liên kết" = mã hồ sơ trong tab "Danh muc HSS". Link Drive tự động lấy từ tab "Danh muc HSS" khi chạy setup().')
    .setFontStyle('italic').setFontColor('#6b7a72').setWrap(true);

  // Xóa Sheet1 trống mặc định
  const trash = ss.getSheetByName('Sheet1') || ss.getSheetByName('Trang tính1');
  if (trash && ss.getSheets().length > 1) {
    try { ss.deleteSheet(trash); } catch(e) {}
  }
}

/**
 * Trả về object { "1.1.1": "https://drive...", "1.1.2": "https://...", ... }
 * Dùng DATA_HSS (tên hồ sơ có dạng "1.1.2. Kế hoạch...") → lấy số đầu làm key.
 */
function _buildHssLinkMap() {
  const map = {};
  DATA_HSS.forEach(function(r){
    const name = String(r[1] || '').trim();
    const link = String(r[2] || '').trim();
    if (!name || !link) return;
    const m = name.match(/^(\d+(?:\.\d+)+)\s*[\.\)]/);
    if (m) map[m[1]] = link;
  });
  return map;
}

function _logDivider() { Logger.log('================================================================'); }

// =====================================================================================
// ==========              ENTRY POINT - SERVE JSON API                        =========
// =====================================================================================
// NOTE: Khi chạy chung với Router.gs, entry thật là Router.doGet + Router.doPost;
// hai hàm bên dưới đổi tên thành _hssDoGet / _hssDoPost để Router dispatch đúng.
function _hssDoGet(e) {
  let payload;
  try {
    const action = (e && e.parameter && e.parameter.action) || 'all';
    const noCache = e && e.parameter && e.parameter.nocache;
    if (noCache) {
      try { CacheService.getScriptCache().remove('allData'); } catch(x){}
    }
    let data;
    switch (action) {
      case 'hss':      data = getHSS(); break;
      case 'teachers': data = getTeachers(); break;
      case 'students': data = getStudents(); break;
      case 'classes':  data = getClasses(); break;
      case 'images':   data = getImages(); break;
      case 'config':   data = getConfig(); break;
      case 'minhchung': data = getMinhChung(); break;
      case 'stats':    data = getStats(); break;
      default:         data = getAllData();
    }
    payload = { ok: true, data: data };
  } catch (err) {
    payload = { ok: false, error: err.message || String(err) };
  }

  const cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(payload) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================================
// ==========          doPost — GHI DỮ LIỆU TỪ ADMIN PANEL                   =========
// =====================================================================================
function _hssDoPost(e) {
  let payload;
  try {
    let body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    const action = body.action || '';
    let result;

    switch (action) {
      case 'updateHSS':
        result = _writeHSS(body.rows || []);
        break;
      case 'importTeachers':
        result = _writeTeachers(body.rows || []);
        break;
      case 'importStudents':
        result = _writeStudents(body.rows || []);
        break;
      // ⭐ 2026-05-07: Phase 2 — Quản lý HS đơn lẻ (CRUD)
      //   Truyền body làm _ctx để audit log biết ai thao tác (body.user do FE gửi).
      case 'addStudent':
        result = _hssAddStudent(body.student || {}, body);
        break;
      case 'updateStudent':
        result = _hssUpdateStudent(body.ma, body.student || {}, body);
        break;
      case 'transferStudent':
        result = _hssTransferStudent(body.ma, body.transfer || {}, body);
        break;
      case 'restoreStudent':
        result = _hssRestoreStudent(body.ma, body);
        break;
      case 'deleteStudentPermanent':
        // Xoá vật lý — chỉ dùng khi NHẬP NHẦM. FE đã có 2 lớp confirm.
        result = _hssDeleteStudentPermanent(body.ma, body);
        break;
      case 'listStudentsAdmin':
        result = _hssListStudentsAdmin(body.filter || 'active');
        break;
      case 'updateMinhChung':
        result = _writeMinhChung(body.rows || []);
        break;
      case 'updateConfig':
        result = _writeConfig(body.config || {});
        break;
      case 'studentsAuthed': {
        // Đọc HS có lộ field nhạy cảm — bắt buộc xác thực ít nhất mã GV
        const authRes = _authCheck_(body, 'gv');
        if (!authRes.ok) {
          return ContentService
            .createTextOutput(JSON.stringify(authRes))
            .setMimeType(ContentService.MimeType.JSON);
        }
        // Trả thẳng để bỏ qua đoạn invalidate cache 'allData' (đây là action đọc)
        const students = _getStudentsAuthed(body);
        return ContentService
          .createTextOutput(JSON.stringify({ ok: true, data: students }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      default:
        throw new Error('Unknown action: ' + action);
    }

    // Xóa cache sau khi ghi
    try { CacheService.getScriptCache().remove('allData'); } catch(x){}
    payload = { ok: true, data: result };
  } catch (err) {
    payload = { ok: false, error: err.message || String(err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function _writeHSS(rows) {
  const ss = _getSS();
  const sh = ss.getSheetByName(SHEET_HSS);
  if (!sh) throw new Error('Không tìm thấy sheet "' + SHEET_HSS + '"');
  if (!rows.length) return { updated: 0 };
  sh.getRange(2, 1, sh.getLastRow() - 1 || 1, 5).clearContent();
  sh.getRange(2, 1, rows.length, 5).setValues(rows);
  return { updated: rows.length };
}

function _writeTeachers(rows) {
  const ss = _getSS();
  const sh = ss.getSheetByName(SHEET_DSGV);
  if (!sh) throw new Error('Không tìm thấy sheet "' + SHEET_DSGV + '"');
  if (!rows.length) return { imported: 0 };
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 8).clearContent();
  sh.getRange(2, 1, rows.length, 8).setValues(rows);
  return { imported: rows.length };
}

function _writeStudents(rows) {
  const ss = _getSS();
  if (!rows.length) return { imported: 0 };

  // 2026-05-07: Đảm bảo schema 24 cột ở DB (auto-add 6 cột tracking nếu thiếu)
  const sh = _hssEnsureFullHeaders();

  // Detect schema từ file Excel admin upload:
  //   • 18 cột: file cũ — giữ NGUYÊN cả 6 cột tracking ở DB
  //   • 19 cột: file mới (18 cột gốc + cột "Trạng thái") — chỉ map IsDeleted, GIỮ 5 cột tracking khác
  //   • 24 cột: file full export — ghi đè cả 24 cột (rare, chỉ dùng khi backup-restore)
  const numCols = (rows[0] || []).length;
  const lastRow = sh.getLastRow();

  if (numCols >= 24) {
    // Schema FULL 24 cột — ghi đè toàn bộ
    rows = rows.map(function(r){
      var status = String(r[18] || '').trim().toLowerCase();
      r[18] = (status === 'chuyển đi' || status === 'chuyen di' || status === 'transferred' || status === 'true' || r[18] === true);
      while (r.length < 24) r.push('');
      return r.slice(0, 24);
    });
    if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 24).clearContent();
    sh.getRange(2, 1, rows.length, 24).setValues(rows);
    sh.getRange(2, 3, rows.length, 1).setNumberFormat('@');
    try { CacheService.getScriptCache().remove('allData'); } catch(e){}
    return { imported: rows.length, schema: 'full24', message: 'Đã import ' + rows.length + ' HS (full 24 cột)' };
  }

  if (numCols === 19) {
    // Schema 18 cột gốc + cột "Trạng thái" (cột 19) — map text → IsDeleted, GIỮ 5 cột tracking khác
    // Đọc DB hiện tại để giữ TransferDate/TransferTo/TransferReason/ReceivedDate/ReceivedFrom
    var existingTracking = {};  // {ma: [received_date, received_from, transfer_date, transfer_to, transfer_reason]}
    if (lastRow > 1) {
      var oldData = sh.getRange(2, 3, lastRow - 1, 22).getValues(); // cột 3=ma, đọc đến cột 24
      oldData.forEach(function(r){
        var ma = String(r[0] || '').trim();
        if (ma) existingTracking[ma] = [r[17] || '', r[18] || '', r[19] || '', r[20] || '', r[21] || '']; // tương đối: r[17]=cột 20, ...
      });
    }
    var newRows = rows.map(function(r){
      while (r.length < 19) r.push('');
      var ma = String(r[2] || '').trim();
      var status = String(r[18] || '').trim().toLowerCase();
      var isDeleted = (status === 'chuyển đi' || status === 'chuyen di' || status === 'transferred' || status === 'true');
      var tracking = existingTracking[ma] || ['', '', '', '', ''];
      // Build full 24 cột: 18 cột gốc + IsDeleted + 5 cột tracking giữ nguyên
      return r.slice(0, 18).concat([isDeleted], tracking);
    });
    if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 24).clearContent();
    sh.getRange(2, 1, newRows.length, 24).setValues(newRows);
    sh.getRange(2, 3, newRows.length, 1).setNumberFormat('@');
    try { CacheService.getScriptCache().remove('allData'); } catch(e){}
    return { imported: newRows.length, schema: '19_cols', message: 'Đã import ' + newRows.length + ' HS (giữ nguyên lịch sử Chuyển đi/Tiếp nhận)' };
  }

  // Schema cũ 18 cột — KHÔNG đụng 6 cột tracking ở DB
  rows = rows.map(function(r){
    while (r.length < 18) r.push('');
    return r.slice(0, 18);
  });
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 18).clearContent();
  sh.getRange(2, 1, rows.length, 18).setValues(rows);
  sh.getRange(2, 3, rows.length, 1).setNumberFormat('@');
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}
  return { imported: rows.length, schema: 'legacy18', message: 'Đã import ' + rows.length + ' HS (giữ nguyên trạng thái — file không có cột Trạng thái)' };
}

// ============================================================================
// 2026-05-07: Phase 2 — QUẢN LÝ HỌC SINH ĐƠN LẺ (CRUD)
// ============================================================================
// Schema mở rộng (24 cột):
//   1-18: thông tin gốc (STT, Mã lớp, Mã HS, Họ tên, NS, GT, Dân tộc, ...)
//   19: IsDeleted (true = đã chuyển đi)
//   20: ReceivedDate (HS chuyển đến giữa năm)
//   21: ReceivedFrom (trường cũ)
//   22: TransferDate
//   23: TransferTo
//   24: TransferReason
// ============================================================================

const _HS_HEADER_FULL = [
  'STT','Mã lớp','Mã học sinh','Họ tên','Ngày sinh',
  'Giới tính','Dân tộc','Tôn giáo',
  'Tỉnh/Thành phố','','Xã/Phường','Tổ/Thôn/Xóm',
  'Nơi sinh','Số điện thoại',
  'Họ tên cha','Năm sinh cha','Họ tên mẹ','Năm sinh mẹ',
  'IsDeleted','ReceivedDate','ReceivedFrom','TransferDate','TransferTo','TransferReason'
];

// Đảm bảo sheet DS HocSinh có đủ 24 cột header (auto-extend nếu thiếu)
function _hssEnsureFullHeaders() {
  const ss = _getSS();
  const sh = ss.getSheetByName(SHEET_HS);
  if (!sh) throw new Error('Không tìm thấy sheet "' + SHEET_HS + '"');
  const lastCol = sh.getLastColumn();
  if (lastCol < _HS_HEADER_FULL.length) {
    // Bổ sung cột thiếu
    const missing = _HS_HEADER_FULL.slice(lastCol);
    sh.getRange(1, lastCol + 1, 1, missing.length)
      .setValues([missing])
      .setFontWeight('bold').setBackground('#2d8a6e').setFontColor('#ffffff')
      .setWrap(true);
    Logger.log('[HSS] Auto-added ' + missing.length + ' cột mới: ' + missing.join(', '));
  }
  return sh;
}

// Tìm row của HS theo mã HS (cột C, index 2). Trả về row number (1-based) hoặc -1.
function _hssFindStudentRow(sh, ma) {
  if (!ma) return -1;
  const data = sh.getRange(2, 3, Math.max(0, sh.getLastRow() - 1), 1).getValues();
  const target = String(ma).trim();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === target) return i + 2;
  }
  return -1;
}

// Map object HS → array 24 phần tử để setValues
function _hssStudentToRow(s) {
  return [
    s.stt || '', s.lop || '', s.ma || '', s.ten || '', s.ns || '',
    s.gt || '', s.dan_toc || '', s.ton_giao || '',
    s.tinh || '', '', s.xa || '', s.to || '',
    s.noi_sinh || '', s.sdt || '',
    s.cha || '', s.namsinh_cha || '', s.me || '', s.namsinh_me || '',
    s.is_deleted === true || s.is_deleted === 'true', // bool
    s.received_date || '', s.received_from || '',
    s.transfer_date || '', s.transfer_to || '', s.transfer_reason || ''
  ];
}

/**
 * Tiếp nhận HS mới (HS chuyển đến hoặc thêm mới đầu năm).
 * @param {object} s — thông tin HS (lop, ma, ten, ns, gt, ...)
 * @return {object} { ok, message, ma }
 */
function _hssAddStudent(s, _ctx) {
  if (!s || !s.ten || !s.lop || !s.ma) {
    return { ok: false, error: 'Thiếu thông tin bắt buộc: họ tên, lớp, mã HS' };
  }
  const sh = _hssEnsureFullHeaders();
  // Check duplicate
  const exist = _hssFindStudentRow(sh, s.ma);
  if (exist > 0) {
    return { ok: false, error: 'Mã HS đã tồn tại: ' + s.ma };
  }
  // Auto-set ReceivedDate nếu chưa có
  if (!s.received_date) s.received_date = Utilities.formatDate(new Date(),
    Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy');
  // Append row
  const row = _hssStudentToRow(s);
  sh.appendRow(row);
  // Format mã HS thành text (giữ leading zero)
  sh.getRange(sh.getLastRow(), 3).setNumberFormat('@');
  // Reset cache HSS
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}
  _auditLog('_AuditLog_HS', {
    action: 'addStudent',
    username: (_ctx && _ctx.user) || '?',
    role: 'admin',
    target: 'ma=' + s.ma + ' lop=' + s.lop,
    after: { ma: s.ma, ten: s.ten, lop: s.lop, ns: s.ns, gt: s.gt }
  });
  return { ok: true, message: 'Đã tiếp nhận HS: ' + s.ten, ma: s.ma };
}

/**
 * Cập nhật thông tin HS.
 * @param {string} ma — mã HS (dùng để tìm row)
 * @param {object} fields — các trường cần update
 */
function _hssUpdateStudent(ma, fields, _ctx) {
  if (!ma) return { ok: false, error: 'Thiếu mã HS' };
  const sh = _hssEnsureFullHeaders();
  const row = _hssFindStudentRow(sh, ma);
  if (row < 0) return { ok: false, error: 'Không tìm thấy HS: ' + ma };
  // Đọc row hiện tại
  const current = sh.getRange(row, 1, 1, _HS_HEADER_FULL.length).getValues()[0];
  const before = current.slice(0, 18);  // snapshot 18 cột HS chính
  // Map column index theo header
  const colMap = {
    stt: 0, lop: 1, ma: 2, ten: 3, ns: 4, gt: 5,
    dan_toc: 6, ton_giao: 7, tinh: 8, xa: 10, to: 11,
    noi_sinh: 12, sdt: 13,
    cha: 14, namsinh_cha: 15, me: 16, namsinh_me: 17,
    received_date: 19, received_from: 20
  };
  const changed = [];
  // Cập nhật từng field (KHÔNG cho đổi mã HS — định danh)
  Object.keys(fields).forEach(k => {
    if (k === 'ma') return; // không cho đổi mã HS
    if (colMap[k] !== undefined && String(current[colMap[k]]) !== String(fields[k])) {
      changed.push(k);
      current[colMap[k]] = fields[k];
    }
  });
  sh.getRange(row, 1, 1, _HS_HEADER_FULL.length).setValues([current]);
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}
  _auditLog('_AuditLog_HS', {
    action: 'updateStudent',
    username: (_ctx && _ctx.user) || '?',
    role: 'admin',
    target: 'ma=' + ma,
    before: before, after: fields,
    note: changed.length + ' field thay đổi: ' + changed.join(',')
  });
  return { ok: true, message: 'Đã cập nhật HS: ' + ma };
}

/**
 * Chuyển đi (soft delete): set IsDeleted=true + lưu thông tin chuyển trường.
 * @param {string} ma
 * @param {object} info — { transfer_date, transfer_to, transfer_reason }
 */
function _hssTransferStudent(ma, info, _ctx) {
  if (!ma) return { ok: false, error: 'Thiếu mã HS' };
  if (!info || !info.transfer_to) return { ok: false, error: 'Thiếu trường chuyển đến' };
  const sh = _hssEnsureFullHeaders();
  const row = _hssFindStudentRow(sh, ma);
  if (row < 0) return { ok: false, error: 'Không tìm thấy HS: ' + ma };
  const today = Utilities.formatDate(new Date(),
    Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy');
  // Cột 19=IsDeleted, 22=TransferDate, 23=TransferTo, 24=TransferReason
  sh.getRange(row, 19).setValue(true);
  sh.getRange(row, 22).setValue(info.transfer_date || today);
  sh.getRange(row, 23).setValue(info.transfer_to);
  sh.getRange(row, 24).setValue(info.transfer_reason || '');
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}
  _auditLog('_AuditLog_HS', {
    action: 'transferStudent',
    username: (_ctx && _ctx.user) || '?',
    role: 'admin',
    target: 'ma=' + ma,
    after: { transfer_date: info.transfer_date || today, transfer_to: info.transfer_to, transfer_reason: info.transfer_reason || '' }
  });
  return { ok: true, message: 'Đã chuyển HS ' + ma + ' đi ' + info.transfer_to };
}

/**
 * Khôi phục HS đã chuyển đi (set IsDeleted=false, xoá thông tin chuyển).
 */
function _hssRestoreStudent(ma, _ctx) {
  if (!ma) return { ok: false, error: 'Thiếu mã HS' };
  const sh = _hssEnsureFullHeaders();
  const row = _hssFindStudentRow(sh, ma);
  if (row < 0) return { ok: false, error: 'Không tìm thấy HS: ' + ma };
  sh.getRange(row, 19).setValue(false);  // IsDeleted = false
  sh.getRange(row, 22, 1, 3).clearContent();  // xoá TransferDate/To/Reason
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}
  _auditLog('_AuditLog_HS', {
    action: 'restoreStudent',
    username: (_ctx && _ctx.user) || '?',
    role: 'admin',
    target: 'ma=' + ma
  });
  return { ok: true, message: 'Đã khôi phục HS: ' + ma };
}

/**
 * XOÁ VĨNH VIỄN HS khỏi DSHS — chỉ cho trường hợp NHẬP NHẦM/SAI.
 *
 * Khác với "transferStudent" (HS chuyển trường thật, soft delete để truy vết),
 * hàm này dùng khi admin lỡ tay nhập sai → muốn xoá hẳn khỏi danh sách.
 *
 * FE đã có 2 lớp confirm trước khi gọi (gõ "XOA" + alert chuẩn).
 *
 * @param {string} ma — mã HS
 */
function _hssDeleteStudentPermanent(ma, _ctx) {
  if (!ma) return { ok: false, error: 'Thiếu mã HS' };
  const sh = _hssEnsureFullHeaders();
  const row = _hssFindStudentRow(sh, ma);
  if (row < 0) return { ok: false, error: 'Không tìm thấy HS: ' + ma };
  // Đọc thông tin TOÀN BỘ trước khi xoá (để log + có thể restore từ audit)
  const info = sh.getRange(row, 1, 1, _HS_HEADER_FULL.length).getValues()[0];
  const tenHS = String(info[3] || '');
  const lopHS = String(info[1] || '');
  // Xoá vật lý hàng
  sh.deleteRow(row);
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}
  Logger.log('[HSS] Đã XOÁ VĨNH VIỄN HS: ' + ma + ' - ' + tenHS + ' (lớp ' + lopHS + ')');
  _auditLog('_AuditLog_HS', {
    action: 'deleteStudentPermanent',
    username: (_ctx && _ctx.user) || '?',
    role: 'admin',
    target: 'ma=' + ma + ' ten=' + tenHS + ' lop=' + lopHS,
    before: info,  // Lưu toàn bộ row để có thể recover thủ công
    note: '⚠ XOÁ VĨNH VIỄN — không thể undo qua app'
  });
  return { ok: true, message: 'Đã xoá vĩnh viễn HS: ' + tenHS + ' (lớp ' + lopHS + ')' };
}

/**
 * List HS cho admin với filter trạng thái.
 * @param {string} filter — 'active' | 'transferred' | 'all'
 */
function _hssListStudentsAdmin(filter) {
  const sh = _hssEnsureFullHeaders();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, data: [] };
  const data = sh.getRange(2, 1, lastRow - 1, _HS_HEADER_FULL.length).getValues();
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';

  const fmt = function(v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'dd/MM/yyyy');
    return String(v == null ? '' : v);
  };

  const result = data.filter(r => r[3]).map(r => {
    return {
      stt: fmt(r[0]), lop: fmt(r[1]), ma: fmt(r[2]), ten: fmt(r[3]),
      ns: fmt(r[4]), gt: fmt(r[5]),
      dan_toc: fmt(r[6]), ton_giao: fmt(r[7]),
      tinh: fmt(r[8]), xa: fmt(r[10]), to: fmt(r[11]),
      noi_sinh: fmt(r[12]), sdt: fmt(r[13]),
      cha: fmt(r[14]), namsinh_cha: fmt(r[15]),
      me: fmt(r[16]), namsinh_me: fmt(r[17]),
      is_deleted: r[18] === true,
      received_date: fmt(r[19]), received_from: fmt(r[20]),
      transfer_date: fmt(r[21]), transfer_to: fmt(r[22]), transfer_reason: fmt(r[23])
    };
  }).filter(s => {
    if (filter === 'transferred') return s.is_deleted;
    if (filter === 'all') return true;
    return !s.is_deleted; // default 'active'
  });

  return { ok: true, data: result, count: result.length, filter: filter };
}

// Ghi cấu hình trường vào sheet CauHinh
function _writeConfig(config) {
  const ss = _getSS();
  const sh = ss.getSheetByName(SHEET_CFG);
  if (!sh) throw new Error('Không tìm thấy sheet "' + SHEET_CFG + '"');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) throw new Error('Sheet CauHinh trống — chạy setup() trước.');
  const data = sh.getRange(2, 1, lastRow - 1, 2).getValues();
  const map = {
    'Tên trường':       config.name || '',
    'Địa chỉ':          config.address || '',
    'Điện thoại':       config.phone || '',
    'Email':            config.email || '',
    'Năm học':          config.schoolYear || '',
    'Hiệu trưởng':      config.principal || '',
    'Phó Hiệu trưởng':  config.vicePrincipal || '',
    'Slogan':           config.slogan || '',
    'Logo emoji':       config.logoEmoji || '',
    'Màu chủ đạo':     config.themeColor || ''
  };
  // Tìm các key đã có sẵn → cập nhật giá trị
  var updated = 0;
  var existingKeys = {};
  data.forEach(function(row, i) {
    var key = String(row[0] || '').trim();
    existingKeys[key] = i + 2;
    if (map.hasOwnProperty(key) && map[key] !== '') {
      sh.getRange(i + 2, 2).setValue(map[key]);
      updated++;
    }
  });
  // ⭐ Tự động thêm các key MỚI nếu chưa có trong sheet (phòng trường hợp setup cũ thiếu Hiệu trưởng)
  var newRows = [];
  ['Hiệu trưởng', 'Phó Hiệu trưởng'].forEach(function(k){
    if (!existingKeys[k] && map.hasOwnProperty(k)) {
      newRows.push([k, map[k] || '']);
    }
  });
  if (newRows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, 2).setValues(newRows);
    updated += newRows.length;
  }
  return { updated: updated };
}


// Ghi lại danh sách minh chứng
function _writeMinhChung(rows) {
  var ss = _getSS();
  var sh = ss.getSheetByName(SHEET_MC);
  if (!sh) throw new Error('Không tìm thấy sheet "' + SHEET_MC + '"');
  if (!rows.length) return { imported: 0 };
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 10).clearContent();
  sh.getRange(2, 1, rows.length, 10).setValues(rows);
  return { imported: rows.length };
}

function _getSS() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Apps Script chưa gắn vào Sheet (phải mở qua Tiện ích mở rộng → Apps Script).');
  return ss;
}

// =====================================================================================
// ==========                       CÁC HÀM ĐỌC DATA                           =========
// =====================================================================================

function getHSS() {
  const sh = _getSS().getSheetByName(SHEET_HSS);
  if (!sh) throw new Error('Không tìm thấy sheet "' + SHEET_HSS + '" - chạy setup() trước.');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const data = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  const tree = []; const stack = [null, null, null, null, null];
  data.forEach(function (row) {
    const tt = row[0], name = row[1], link = row[2], assign = row[3], kdcl = row[4];
    if (!name) return;
    const m = String(name).trim().match(/^(\d+(?:\.\d+)*)\.\s*(.+)/);
    if (!m) return;
    const num = m[1], label = m[2];
    const level = (num.match(/\./g) || []).length + 1;
    // ⭐ FIX BUG: trả về 2 field riêng — assign (cột 4: Người phụ trách) + kdcl (cột 5: Mã hóa KĐCL).
    // Trước đây node.assign vô tình lấy giá trị cột 5 (kdcl) → FE render sai badge.
    const node = {
      code: num, name: label,
      link:   link   ? String(link)   : '',
      assign: assign ? String(assign) : '',
      kdcl:   kdcl   ? String(kdcl)   : ''
    };
    if (tt) { node.leaf = true; node.has = !!link; } else { node.children = []; }
    if (level === 1) tree.push(node);
    else for (let p = level - 1; p >= 1; p--) {
      if (stack[p] && stack[p].children) { stack[p].children.push(node); break; }
    }
    stack[level] = node;
    for (let k = level + 1; k < stack.length; k++) stack[k] = null;
  });
  return tree;
}

function getTeachers() {
  const sh = _getSS().getSheetByName(SHEET_DSGV);
  if (!sh) throw new Error('Không tìm thấy sheet "' + SHEET_DSGV + '" - chạy setup() trước.');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const data = sh.getRange(2, 1, lastRow - 1, 8).getValues();
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  return data.filter(function (r) { return r[1]; }).map(function (r) {
    let dob = r[2];
    if (dob instanceof Date) dob = Utilities.formatDate(dob, tz, 'dd/MM/yyyy');
    else dob = String(dob || '');
    return {
      tt: r[0], name: String(r[1]).trim(), dob: dob,
      role: String(r[3] || '').trim(), degree: String(r[4] || '').trim(),
      phone: String(r[5] || '').trim(), email: String(r[6] || '').trim(),
      link: String(r[7] || '').trim()
    };
  });
}

/**
 * Đọc danh sách học sinh.
 * @param {object} [opts]
 *   - role: 'HT' | 'GVCN' | 'GV' | 'KHAC' | null  (null = public, mặc định)
 *   - lopChuNhiem: ['Lớp 1A', 'Lớp 2B', ...] — danh sách lớp user làm GVCN
 * Quy tắc lộ field nhạy cảm (Nghị định 13/2023):
 *   - HT: thấy mọi field của mọi HS
 *   - GVCN: thấy đầy đủ với HS thuộc lớp mình chủ nhiệm; lớp khác chỉ thấy public
 *   - GV/KHAC/null: chỉ thấy public (không SĐT, không thông tin cha/mẹ, không địa chỉ chi tiết)
 * Lưu ý: gọi getStudents() không tham số = chế độ public (an toàn cho doGet).
 */
function getStudents(opts) {
  const role  = (opts && opts.role) || null;
  const lopCN = (opts && opts.lopChuNhiem) || [];
  const lopCNSet = {};
  lopCN.forEach(function (l) { lopCNSet[String(l).trim()] = 1; });

  const sh = _getSS().getSheetByName(SHEET_HS);
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  // Đọc tối đa số cột thực tế (sheet có thể đã thêm IsDeleted ở Bước 2 → 21 cột)
  const lastCol = Math.max(18, sh.getLastColumn());
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const data    = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';

  // Index cột IsDeleted (sheet cũ chưa có → -1, bỏ qua bước lọc)
  const colIsDeleted = headers.indexOf('IsDeleted');

  return data
    .filter(function (r) {
      if (!r[3]) return false;                                          // không có Họ tên → bỏ
      if (colIsDeleted >= 0 && r[colIsDeleted] === true) return false;  // soft deleted
      return true;
    })
    .map(function (r) {
      let dob = r[4];
      if (dob instanceof Date) dob = Utilities.formatDate(dob, tz, 'dd/MM/yyyy');
      else dob = String(dob || '');

      const classCode = String(r[1] || '').trim();
      // Quyền xem đầy đủ: HT toàn trường, hoặc GVCN của đúng lớp HS này
      const fullAccess = (role === _ROLE_HT_) ||
                         (role === _ROLE_GVCN_ && lopCNSet[classCode] === 1);

      // Field công khai — luôn trả
      const out = {
        stt:         r[0],
        classCode:   classCode,
        studentCode: String(r[2] || '').trim(),
        name:        String(r[3] || '').trim(),
        dob:         dob,
        gender:      String(r[5] || '').trim(),
        ethnic:      String(r[6] || '').trim(),
        religion:    String(r[7] || '').trim(),
        province:    String(r[8] || '').trim(),
        ward:        String(r[10] || '').trim()
      };

      // Field nhạy cảm — chỉ HT/GVCN của lớp đó được thấy
      if (fullAccess) {
        out.hamlet     = String(r[11] || '').trim();
        out.birthplace = String(r[12] || '').trim();
        out.phone      = String(r[13] || '').trim();
        out.father     = String(r[14] || '').trim();
        out.fatherYear = String(r[15] || '').trim();
        out.mother     = String(r[16] || '').trim();
        out.motherYear = String(r[17] || '').trim();
        // 2026-05-07: 6 cột tracking biến động (chỉ admin/GVCN đầy đủ)
        out.isDeleted     = r[18] === true;
        out.receivedDate  = (r[19] instanceof Date) ? Utilities.formatDate(r[19], tz, 'dd/MM/yyyy') : String(r[19] || '').trim();
        out.receivedFrom  = String(r[20] || '').trim();
        out.transferDate  = (r[21] instanceof Date) ? Utilities.formatDate(r[21], tz, 'dd/MM/yyyy') : String(r[21] || '').trim();
        out.transferTo    = String(r[22] || '').trim();
        out.transferReason= String(r[23] || '').trim();
      }
      return out;
    });
}

/**
 * Wrapper cho getStudents khi gọi qua POST đã xác thực.
 * Resolve role thật từ DSGV và tra QLCL_PhanCong để biết lớp user chủ nhiệm.
 */
function _getStudentsAuthed(body) {
  const userKey = String(body.user || '').toLowerCase().trim();
  if (!userKey) return getStudents(); // fallback public

  const role = _resolveRole_(body.user);

  // GVCN/GV: tra danh sách lớp chủ nhiệm từ QLCL_PhanCong
  let lopChuNhiem = [];
  if (role === _ROLE_GVCN_ || role === _ROLE_GV_) {
    try {
      // 1) Tìm MaGV từ DSGV (so khớp email hoặc tên — giống _resolveRole_)
      const sh = _getSS().getSheetByName(SHEET_DSGV);
      let maGV = '';
      if (sh && sh.getLastRow() > 1) {
        const teachers = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
        for (let i = 0; i < teachers.length; i++) {
          const email = String(teachers[i][6] || '').toLowerCase().trim();
          const name  = String(teachers[i][1] || '').toLowerCase().trim();
          if (email === userKey || name === userKey) {
            maGV = String(teachers[i][0] || '').trim();
            break;
          }
        }
      }
      // 2) Tra QLCL_PhanCong: lấy mọi Lop có MaGV này + Role='GVCN'
      if (maGV) {
        const all = _qlclReadAll(SHEET_QLCL_PHANCONG).rows;
        all.forEach(function (r) {
          if (String(r.MaGV).trim() === maGV &&
              String(r.Role || '').toUpperCase().trim() === 'GVCN') {
            lopChuNhiem.push(String(r.Lop).trim());
          }
        });
      }
    } catch (e) {
      Logger.log('[getStudentsAuthed] ' + e.message);
    }
  }

  return getStudents({ role: role, lopChuNhiem: lopChuNhiem });
}

function getImages() {
  const sh = _getSS().getSheetByName(SHEET_IMG);
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const data = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  return data.filter(function (r) { return r[3]; }).map(function (r) {
    return {
      stt: r[0],
      title: String(r[1] || '').trim(),
      desc: String(r[2] || '').trim(),
      url: _normalizeImageUrl(String(r[3] || '').trim()),
      type: String(r[4] || 'hoatdong').trim().toLowerCase()
    };
  });
}

function _normalizeImageUrl(url) {
  if (!url) return '';
  let m = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (m) return 'https://lh3.googleusercontent.com/d/' + m[1];
  m = url.match(/drive\.google\.com\/open\?id=([\w-]+)/);
  if (m) return 'https://lh3.googleusercontent.com/d/' + m[1];
  m = url.match(/[?&]id=([\w-]+)/);
  if (m && url.indexOf('drive.google') >= 0) return 'https://lh3.googleusercontent.com/d/' + m[1];
  return url;
}

function getClasses() {
  return _buildClasses(getStudents());
}

function _buildClasses(students) {
  const map = {};
  students.forEach(function (s) {
    if (!map[s.classCode]) {
      const grade = _detectGrade(s.classCode);
      map[s.classCode] = {
        name: s.classCode, gradeKey: grade.key, gradeLabel: grade.label, gradeGroup: grade.grade,
        students: [], male: 0, female: 0
      };
    }
    map[s.classCode].students.push(s);
    const g = s.gender.toLowerCase();
    if (g.indexOf('nam') >= 0) map[s.classCode].male++;
    else if (g.indexOf('nữ') >= 0 || g.indexOf('nu') >= 0) map[s.classCode].female++;
  });
  // Sắp xếp theo khối
  const order = { khoi1: 1, khoi2: 2, khoi3: 3, khoi4: 4, khoi5: 5, other: 9 };
  return Object.values(map).sort(function (a, b) {
    const oa = order[a.gradeKey] || 9, ob = order[b.gradeKey] || 9;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name, 'vi');
  });
}

function _detectGrade(name) {
  var n = (name || '').toLowerCase();
  if (n.indexOf('lớp 1') >= 0 || n.indexOf('khối 1') >= 0) return { key: 'khoi1', label: 'Khối 1', grade: 'Lớp 1' };
  if (n.indexOf('lớp 2') >= 0 || n.indexOf('khối 2') >= 0) return { key: 'khoi2', label: 'Khối 2', grade: 'Lớp 2' };
  if (n.indexOf('lớp 3') >= 0 || n.indexOf('khối 3') >= 0) return { key: 'khoi3', label: 'Khối 3', grade: 'Lớp 3' };
  if (n.indexOf('lớp 4') >= 0 || n.indexOf('khối 4') >= 0) return { key: 'khoi4', label: 'Khối 4', grade: 'Lớp 4' };
  if (n.indexOf('lớp 5') >= 0 || n.indexOf('khối 5') >= 0) return { key: 'khoi5', label: 'Khối 5', grade: 'Lớp 5' };
  return { key: 'other', label: '', grade: '' };
}


/**
 * Xây map { "1.1.1": { link, name, assign, hssMa }, ... } từ tab "Danh muc HSS" (LIVE).
 * MC dùng map này để luôn lấy Link/tên mới nhất — đổi HSS là MC đi theo.
 */
function _readHssLiveMap() {
  var sh = _getSS().getSheetByName(SHEET_HSS);
  var map = {};
  if (!sh) return map;
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return map;
  var data = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  data.forEach(function(r){
    var name = String(r[1]||'').trim();
    var link = String(r[2]||'').trim();
    var assign = String(r[3]||'').trim();
    var hssMa = String(r[4]||'').trim();
    if (!name) return;
    var m = name.match(/^(\d+(?:\.\d+)+)\s*[\.\)]\s*(.*)$/);
    if (m) map[m[1]] = { link: link, name: m[2].trim(), assign: assign, hssMa: hssMa };
  });
  return map;
}

function getMinhChung() {
  var sh = _getSS().getSheetByName(SHEET_MC);
  if (!sh) return [];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var data = sh.getRange(2, 1, lastRow - 1, 10).getValues();
  var tz = Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh';
  function fmt(v) {
    if (v === null || v === undefined) return '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      return Utilities.formatDate(v, tz, 'dd/MM/yyyy');
    }
    return String(v).trim();
  }
  var hssMap = _readHssLiveMap();
  return data.filter(function(r) { return r[3]; }).map(function(r) {
    var hss    = fmt(r[7]);
    var linkMC = fmt(r[8]);
    var hssRow = hss && hssMap[hss];
    // Ưu tiên LINK LIVE từ HSS (user đổi link/rename HSS → MC đi theo ngay)
    var link = (hssRow && hssRow.link) ? hssRow.link : linkMC;
    return {
      stt: r[0], tc: fmt(r[1]), tchi: fmt(r[2]),
      code: fmt(r[3]), name: fmt(r[4]),
      issued: fmt(r[5]), issuer: fmt(r[6]),
      hssCode: hss, link: link,
      note: fmt(r[9]),
      hssName: hssRow ? hssRow.name : ''
    };
  });
}

function getConfig() {
  const sh = _getSS().getSheetByName(SHEET_CFG);
  if (!sh) return SCHOOL_CONFIG;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return SCHOOL_CONFIG;
  const data = sh.getRange(2, 1, lastRow - 1, 2).getValues();
  const map = {};
  data.forEach(function(r) {
    if (r[0]) map[String(r[0]).trim()] = String(r[1] || '').trim();
  });
  // Tìm link Google Maps — tha thứ lỗi chính tả: Google Map, Goole Maps, Bản đồ, Map...
  var mapUrl = '';
  Object.keys(map).forEach(function(k){
    if (mapUrl) return;
    var kl = String(k).toLowerCase();
    if (/g[o]+[gl]?le?\s*maps?/i.test(kl) || /b[aả]n\s*đ[ồo]/i.test(kl) || /^map$/i.test(kl)){
      mapUrl = map[k];
    }
  });

  return {
    name:           map['Tên trường']      || SCHOOL_CONFIG.name,
    address:        map['Địa chỉ']         || SCHOOL_CONFIG.address,
    phone:          map['Điện thoại']      || SCHOOL_CONFIG.phone,
    email:          map['Email']           || SCHOOL_CONFIG.email,
    schoolYear:     map['Năm học']         || SCHOOL_CONFIG.schoolYear,
    principal:      map['Hiệu trưởng']     || SCHOOL_CONFIG.principal     || '',
    vicePrincipal:  map['Phó Hiệu trưởng'] || SCHOOL_CONFIG.vicePrincipal || '',
    slogan:         map['Slogan']          || '',
    logoEmoji:      map['Logo emoji']      || '🏫',
    themeColor:     map['Màu chủ đạo']    || '#2d8a6e',
    mapUrl:         mapUrl                  || ''   // ← B10: link Google Maps (embed / share / tọa độ)
  };
}

function getStats() {
  const hss = getHSS();
  const statusMap = _readHssStatusMap_();
  let total = 0, filled = 0;
  (function count(nodes) {
    nodes.forEach(function (n) {
      if (n.leaf) {
        total++;
        const st = statusMap[n.code];
        let effective;
        if (st && (st.trangThai === 'co' || st.trangThai === 'chua')) effective = st.trangThai;
        else effective = n.has ? 'co' : 'chua';
        if (effective === 'co') filled++;
      }
      else if (n.children) count(n.children);
    });
  })(hss);
  const teachers = getTeachers(); const students = getStudents();
  const classSet = {};
  students.forEach(function (s) { if (s.classCode) classSet[s.classCode] = 1; });
  return {
    totalRecords: total, filledRecords: filled,
    totalTeachers: teachers.length, totalChildren: students.length,
    totalClasses: Object.keys(classSet).length,
    config: getConfig(),
    sheetUrl: _getSS().getUrl()
  };
}

// ============================================================================
// ⭐ HSS STATUS — Trạng thái Đã có / Chưa có cho từng hồ sơ (giống MN Diễn Xuân)
// ============================================================================
//
// Logic: Mỗi hồ sơ (mã 1.1.1, 1.1.2,...) có 1 trạng thái:
//   - 'co'   = Đã có (do GVCN/HT đánh dấu thủ công, dù không có link Drive)
//   - 'chua' = Chưa có (do người dùng đánh dấu — file vật lý chưa số hoá)
//   - 'auto' = Tự động theo link Drive (mặc định nếu chưa có record nào)
// Trạng thái 'auto' đồng nghĩa với: nếu link có → 'co', không có → 'chua'.
// Lưu trong sheet HSS_Status để KHÔNG động đến Sheet "Danh muc HSS" gốc.

function _getHssStatusSheet_() {
  const ss = _getSS();
  let sh = ss.getSheetByName(SHEET_HSS_STATUS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_HSS_STATUS);
    sh.getRange(1, 1, 1, 6).setValues([['MaHS','TrangThai','NguoiPhuTrach','GhiChu','CapNhat','User']]);
    sh.getRange(1, 1, 1, 6).setBackground('#0c5da5').setFontColor('#ffffff').setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Đọc tất cả trạng thái thủ công, key = mã HSS
function _readHssStatusMap_() {
  const sh = _getHssStatusSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return {};
  const data = sh.getRange(2, 1, lastRow - 1, 6).getValues();
  const map = {};
  data.forEach(function(r){
    const ma = String(r[0] || '').trim();
    if (!ma) return;
    map[ma] = {
      maHS: ma,
      trangThai: String(r[1] || 'auto').trim(),
      nguoiPhuTrach: String(r[2] || '').trim(),
      ghiChu: String(r[3] || '').trim(),
      capNhat: r[4] || '',
      user: String(r[5] || '').trim()
    };
  });
  return map;
}

// ============================================================================
// ⭐ HSS Drive File Check — kiểm tra THẬT trong folder Drive có file hay không.
// Logic theo MN Diễn Xuân (đã chứng minh đúng): bất kỳ file gì cũng tính,
// short-circuit ngay khi gặp file đầu tiên (~150-300ms/folder), depth 5.
// ============================================================================
const SHEET_HSS_FILECHECK = 'HSS_FileCheck';
const _HSS_FOLDER_MAX_DEPTH = 5;  // tối đa 5 cấp subfolder (vd: HS/Năm/Tháng/Tuần/file.pdf)

/**
 * Trích folder ID từ URL Google Drive.
 * Hỗ trợ:
 *   - https://drive.google.com/drive/folders/<ID>
 *   - https://drive.google.com/drive/u/0/folders/<ID>
 *   - https://drive.google.com/open?id=<ID>
 */
function _extractDriveFolderId_(url) {
  if (!url) return null;
  var s = String(url);
  var m = s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  return null;
}

/**
 * _hasAnyFile_ — short-circuit: folder có ≥ 1 file (ở bất kỳ depth nào) hay không.
 * KHÔNG filter MIME — bất kỳ file gì cũng tính (PDF, Word, ảnh, Google Docs, link...)
 * vì user có thể minh chứng bằng nhiều định dạng. Logic này theo MN Diễn Xuân.
 *
 * Trả TRUE NGAY khi gặp file đầu tiên → tăng tốc 5-10× so với đếm tất cả.
 *
 * @param {Folder} folder  — đối tượng DriveApp folder
 * @param {number} depth   — cấp đệ quy hiện tại (0 = folder gốc)
 * @return {boolean}
 */
function _hasAnyFile_(folder, depth) {
  if (depth > _HSS_FOLDER_MAX_DEPTH) return false;
  // Có file trực tiếp trong folder?
  if (folder.getFiles().hasNext()) return true;
  // Đệ quy vào subfolders — short-circuit ngay khi gặp folder con có file
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    if (_hasAnyFile_(subs.next(), depth + 1)) return true;
  }
  return false;
}

/**
 * _checkFolderStatus_ — kiểm tra 1 link folder Drive trả về status + count.
 *
 * status:
 *   NO_LINK = url rỗng / không có link Drive
 *   ERROR   = url không hợp lệ HOẶC không truy cập được folder
 *   OK      = folder có ≥ 1 file (kể cả file nằm trong subfolder lồng tới depth 5)
 *   EMPTY   = folder tồn tại nhưng KHÔNG có file ở bất kỳ depth nào
 *
 * count: 0 (rỗng) hoặc 1 (có file). Không đếm chính xác — short-circuit cho tốc độ.
 */
function _checkFolderStatus_(folderUrl) {
  var u = String(folderUrl || '').trim();
  if (!u) return { status: 'NO_LINK', count: 0 };
  var id = _extractDriveFolderId_(u);
  if (!id) return { status: 'ERROR', count: 0, error: 'Không nhận diện được folder ID' };
  try {
    var folder = DriveApp.getFolderById(id);
    var has = _hasAnyFile_(folder, 0);
    return { status: has ? 'OK' : 'EMPTY', count: has ? 1 : 0 };
  } catch (e) {
    return { status: 'ERROR', count: 0, error: String(e.message || e).slice(0, 200) };
  }
}

function _getHssFileCheckSheet_() {
  var ss = _getSS();
  var sh = ss.getSheetByName(SHEET_HSS_FILECHECK);
  if (!sh) {
    sh = ss.insertSheet(SHEET_HSS_FILECHECK);
    sh.getRange(1, 1, 1, 5).setValues([['MaHS','URL','Status','Count','LastChecked']]);
    sh.getRange(1, 1, 1, 5)
      .setBackground('#0c5da5').setFontColor('#ffffff').setFontWeight('bold')
      .setHorizontalAlignment('center');
    sh.setFrozenRows(1);
    [80, 360, 100, 70, 200].forEach(function(w, i){ sh.setColumnWidth(i+1, w); });
  }
  // ⚠ Force text format cho cột A (MaHS) — nếu không, Sheet sẽ auto-convert
  // chuỗi "1.2.2" thành Date 2002-02-01 → đọc lại sai mã.
  // (Trick này lấy từ MN Diễn Xuân — đã chứng minh cần thiết.)
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('B:B').setNumberFormat('@');
  sh.getRange('C:C').setNumberFormat('@');
  sh.getRange('E:E').setNumberFormat('@');
  return sh;
}

/**
 * Đọc sheet _FolderStatus → trả map { maHS: {status, count, lastChecked} }
 * Status: 'OK' | 'EMPTY' | 'NO_LINK' | 'ERROR'
 */
function _readHssFileCheckMap_() {
  var sh = _getHssFileCheckSheet_();
  var map = {};
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return map;
  var data = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  data.forEach(function(r){
    // Defensive: cột A có thể bị Sheet auto-convert "1.2.2" → Date object
    var maHS;
    if (r[0] instanceof Date) {
      var d = r[0];
      maHS = d.getDate() + '.' + (d.getMonth() + 1) + '.' + (d.getFullYear() % 10);
    } else {
      maHS = String(r[0] || '').trim();
    }
    if (!maHS) return;
    map[maHS] = {
      url: String(r[1] || '').trim(),
      status: String(r[2] || 'NO_LINK').trim(),
      count: Number(r[3]) || 0,
      lastChecked: r[4] ? String(r[4]) : ''
    };
  });
  return map;
}

/**
 * Quét toàn bộ link Drive trong cây HSS, lưu vào sheet HSS_FileCheck.
 * Logic theo MN Diễn Xuân: dùng _checkFolderStatus_ (short-circuit, depth 5, không filter MIME).
 * Admin only. Tốc độ ~150-300ms/folder → tổng 30s-1 phút cho 100 hồ sơ.
 */
function rescanHssDrive() {
  var startMs = new Date().getTime();
  var tree = getHSS();
  var sh = _getHssFileCheckSheet_();

  // Clear data cũ (giữ header) — clear 5 cột
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 5).clearContent();

  var rows = [];
  var totalLeaf = 0, statOK = 0, statEMPTY = 0, statNOLINK = 0, statERROR = 0;
  var nowIso = new Date().toISOString();

  (function walk(nodes){
    nodes.forEach(function(n){
      if (n.leaf) {
        totalLeaf++;
        var res = _checkFolderStatus_(n.link);
        if (res.status === 'OK')         statOK++;
        else if (res.status === 'EMPTY') statEMPTY++;
        else if (res.status === 'ERROR') statERROR++;
        else                              statNOLINK++;
        // ⚠ Prefix `'` cho mã để Sheet không auto-convert "1.2.2" → Date 2002-02-01
        rows.push(["'" + n.code, n.link || '', res.status, res.count, nowIso]);
      } else if (n.children) walk(n.children);
    });
  })(tree);

  if (rows.length) {
    sh.getRange(2, 1, rows.length, 5).setNumberFormat('@'); // text format
    sh.getRange(2, 4, rows.length, 1).setNumberFormat('0'); // Count là number
    sh.getRange(2, 1, rows.length, 5).setValues(rows);
  }

  var elapsed = (new Date().getTime() - startMs) / 1000;
  Logger.log('[rescanHssDrive] ' + totalLeaf + ' hồ sơ · ' +
             statOK + ' OK · ' + statEMPTY + ' rỗng · ' +
             statNOLINK + ' chưa link · ' + statERROR + ' lỗi · ' +
             elapsed.toFixed(1) + 's');

  // Invalidate cache batch để getAllData() đọc dữ liệu mới
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}

  return { ok: true, data: {
    totalLeaf: totalLeaf,
    withFiles: statOK,        // số folder có file
    folderEmpty: statEMPTY,    // folder tồn tại nhưng rỗng
    noLink: statNOLINK,        // chưa có link Drive
    errors: statERROR,         // không truy cập được
    withLink: statOK + statEMPTY + statERROR, // tổng có link (kể cả lỗi)
    elapsed: Number(elapsed.toFixed(1))
  }};
}

/**
 * _checkFolderBatch_ — Public action: kiểm tra real-time 1-30 mã hồ sơ.
 * Frontend gọi khi user mở chi tiết 1 nhóm → check những mã có cache > 5 phút,
 * cập nhật DOM badge in-place. Cache 30 giây/code chống spam Drive API.
 *
 * Logic này lấy từ MN Diễn Xuân — đã chứng minh hoạt động tốt.
 */
function _checkFolderBatch_(codes) {
  if (!Array.isArray(codes) || !codes.length) {
    return { ok: false, error: 'Thiếu mảng codes' };
  }
  // Giới hạn 30 mã/lần để tránh timeout 6 phút
  if (codes.length > 30) codes = codes.slice(0, 30);

  // Build map { code → link } từ sheet HSS
  var tree = getHSS();
  var linkByCode = {};
  (function walk(nodes){
    nodes.forEach(function(n){
      if (n.leaf) linkByCode[n.code] = n.link || '';
      else if (n.children) walk(n.children);
    });
  })(tree);

  var sh = _getHssFileCheckSheet_();
  var slr = sh.getLastRow();

  // Build map { code → row index } trong sheet để biết đã có dòng chưa
  var rowByCode = {};
  if (slr > 1) {
    var codeCells = sh.getRange(2, 1, slr - 1, 1).getValues();
    codeCells.forEach(function(r, i){
      var cc;
      if (r[0] instanceof Date) {
        var d = r[0];
        cc = d.getDate() + '.' + (d.getMonth() + 1) + '.' + (d.getFullYear() % 10);
      } else {
        cc = String(r[0] || '').trim();
      }
      if (cc) rowByCode[cc] = i + 2;
    });
  }

  var cache = CacheService.getScriptCache();
  var results = [];
  var newRows = [];
  var nowIso = new Date().toISOString();

  codes.forEach(function(code){
    code = String(code || '').trim();
    if (!code) return;

    // Cache hit (30s) → trả ngay không gọi Drive
    var cacheKey = 'fcheck_' + code;
    var cached = cache.get(cacheKey);
    if (cached) {
      try {
        var c = JSON.parse(cached);
        c.cached = true;
        results.push(c);
        return;
      } catch (e) {}
    }

    var link = linkByCode[code];
    if (link === undefined) {
      results.push({ code: code, status: 'ERROR', count: 0, lastChecked: nowIso, error: 'Không tìm thấy mã trong HSS' });
      return;
    }
    var cr = _checkFolderStatus_(link);
    var r = { code: code, status: cr.status, count: cr.count, lastChecked: nowIso };
    if (cr.error) r.error = cr.error;
    results.push(r);

    // Cache 30 giây
    try { cache.put(cacheKey, JSON.stringify(r), 30); } catch (e) {}

    // Ghi/cập nhật dòng trong sheet (prefix `'` để text format)
    var rowVal = ["'" + code, link, cr.status, cr.count, nowIso];
    var existingRow = rowByCode[code];
    if (existingRow) {
      sh.getRange(existingRow, 1, 1, 5).setNumberFormat('@');
      sh.getRange(existingRow, 4).setNumberFormat('0');
      sh.getRange(existingRow, 1, 1, 5).setValues([rowVal]);
    } else {
      newRows.push(rowVal);
    }
  });

  // Append new rows ở cuối nếu có
  if (newRows.length) {
    var startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, newRows.length, 5).setNumberFormat('@');
    sh.getRange(startRow, 4, newRows.length, 1).setNumberFormat('0');
    sh.getRange(startRow, 1, newRows.length, 5).setValues(newRows);
  }

  // Invalidate allData cache để batch fetch tiếp theo có data mới
  try { CacheService.getScriptCache().remove('allData'); } catch (e) {}

  return { ok: true, data: { results: results, lastChecked: nowIso }};
}

// GET — trả về toàn bộ trạng thái + thống kê
function getHssStatus() {
  const tree = getHSS();
  const statusMap    = _readHssStatusMap_();
  const fileCheckMap = _readHssFileCheckMap_();
  const result = []; // flat list để frontend render bảng
  let totalLeaf = 0, daCo = 0, chuaCo = 0;
  // Tìm timestamp scan gần nhất để FE hiển thị "Cập nhật: ..."
  let lastScan = null;

  (function walk(nodes, parentNames) {
    nodes.forEach(function(n){
      if (n.leaf) {
        totalLeaf++;
        const st = statusMap[n.code];
        const fc = fileCheckMap[n.code];
        if (fc && fc.lastChecked) {
          try {
            const d = new Date(fc.lastChecked);
            if (!isNaN(d.getTime()) && (!lastScan || d > lastScan)) lastScan = d;
          } catch(e) {}
        }
        // ⭐ LOGIC THEO MN DIỄN XUÂN (đã chứng minh đúng):
        //   1) Override thủ công từ Admin (st.trangThai = 'co'|'chua') → ưu tiên cao nhất
        //   2) Status từ scan Drive thật:
        //      - 'OK'      → 'co'   (folder có ≥ 1 file)
        //      - 'EMPTY'   → 'chua' (folder rỗng — chưa upload)
        //      - 'ERROR'   → 'chua' (lỗi truy cập — coi như chưa có)
        //      - 'NO_LINK' → 'chua' (chưa dán link Drive)
        //   3) Chưa scan lần nào (fc null): fallback 'chua' — KHÔNG dựa trên link
        //      vì có link KHÔNG có nghĩa folder có file (đó là root cause của bug cũ).
        let effective;
        let source; // 'manual' | 'scanned' | 'unscanned'
        let folderStatus = null; // raw status từ scan
        if (st && (st.trangThai === 'co' || st.trangThai === 'chua')) {
          effective = st.trangThai;
          source = 'manual';
        } else if (fc) {
          folderStatus = fc.status;
          effective = (fc.status === 'OK') ? 'co' : 'chua';
          source = 'scanned';
        } else {
          // Chưa scan → 'chua' (an toàn hơn 'co' theo link)
          effective = 'chua';
          source = 'unscanned';
        }
        if (effective === 'co') daCo++; else chuaCo++;
        result.push({
          maHS: n.code,
          tenHS: n.name,
          parent: parentNames.join(' / '),
          link: n.link || '',
          hasLink: !!n.link,
          trangThai: effective,
          override: !!(st && (st.trangThai === 'co' || st.trangThai === 'chua')),
          nguoiPhuTrach: st ? st.nguoiPhuTrach : '',
          ghiChu: st ? st.ghiChu : '',
          capNhat: st ? st.capNhat : '',
          user: st ? st.user : '',
          // ⭐ Thông tin scan Drive (FE dùng để hiện tooltip chi tiết)
          source: source,                                 // 'manual' | 'scanned' | 'unscanned'
          folderStatus: folderStatus,                      // 'OK' | 'EMPTY' | 'ERROR' | 'NO_LINK' | null
          lastChecked: fc ? fc.lastChecked : null,
          scanned: !!fc
        });
      } else if (n.children) {
        walk(n.children, parentNames.concat([n.name]));
      }
    });
  })(tree, []);

  return { ok: true, data: {
    rows: result,
    stats: {
      total: totalLeaf, daCo: daCo, chuaCo: chuaCo,
      percent: totalLeaf ? Math.round(daCo * 100 / totalLeaf) : 0,
      scanned: Object.keys(fileCheckMap).length,
      lastScan: lastScan ? lastScan.toISOString() : null
    }
  }};
}

// SAVE — body.row = { maHS, trangThai, nguoiPhuTrach, ghiChu }
// Logic: append nếu chưa có, update nếu đã có (key = MaHS)
function saveHssStatus(body) {
  const r = body.row || {};
  if (!r.maHS) return { ok: false, error: 'Thiếu maHS' };
  const tt = String(r.trangThai || 'auto');
  if (['co','chua','auto'].indexOf(tt) < 0) {
    return { ok: false, error: 'trangThai không hợp lệ (phải là co/chua/auto)' };
  }
  const sh = _getHssStatusSheet_();
  const lastRow = sh.getLastRow();
  const data = lastRow < 2 ? [] : sh.getRange(2, 1, lastRow - 1, 6).getValues();
  const user = body.user || 'unknown';
  const now = new Date();
  // Tìm row cũ
  let foundRow = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(r.maHS).trim()) { foundRow = i + 2; break; }
  }
  const newRow = [r.maHS, tt, r.nguoiPhuTrach || '', r.ghiChu || '', now, user];
  if (foundRow > 0) {
    sh.getRange(foundRow, 1, 1, 6).setValues([newRow]);
  } else {
    sh.appendRow(newRow);
  }
  // Ghi audit
  try { _qlclAudit(user, body.role || 'BGH', 'saveHssStatus', r.maHS, null, tt, r.ghiChu || ''); } catch(e){}
  // Invalidate cache trang chủ vì stats thay đổi
  try { CacheService.getScriptCache().remove('allData'); } catch(e){}
  return { ok: true, data: { saved: 1, action: foundRow > 0 ? 'update' : 'add' } };
}

// Dispatcher cho 2 action HSS Status
function _hssStatusHandle(action, body) {
  try {
    if (action === 'getHssStatus')     return getHssStatus();
    if (action === 'saveHssStatus')    return saveHssStatus(body);
    if (action === 'rescanHssDrive')   return rescanHssDrive();
    // ⭐ checkFolderBatch — public action, không yêu cầu auth (xem _HSS_STATUS_ACTIONS)
    if (action === 'checkFolderBatch') return _checkFolderBatch_(body.codes || []);
    return { ok: false, error: 'Unknown HSS Status action: ' + action };
  } catch (err) {
    return { ok: false, error: String(err) + '\n' + (err.stack || '') };
  }
}

function getAllData() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('allData');
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }

  var hss      = getHSS();
  var teachers = getTeachers();
  var students = getStudents();
  var images   = getImages();
  var config   = getConfig();
  var minhchung = getMinhChung();

  var classes = _buildClasses(students);

  var total = 0, filled = 0;
  (function count(nodes) {
    nodes.forEach(function(n) {
      if (n.leaf) { total++; if (n.has) filled++; }
      else if (n.children) count(n.children);
    });
  })(hss);
  var classSet = {};
  students.forEach(function(s) { if (s.classCode) classSet[s.classCode] = 1; });

  var result = {
    hss: hss,
    minhchung: minhchung,
    teachers: teachers,
    classes: classes,
    images: images,
    stats: {
      totalRecords: total, filledRecords: filled,
      totalTeachers: teachers.length, totalChildren: students.length,
      totalClasses: Object.keys(classSet).length,
      config: config,
      sheetUrl: _getSS().getUrl()
    }
  };

  try {
    var json = JSON.stringify(result);
    if (json.length < 100000) {
      cache.put('allData', json, 300);
    }
  } catch(e) {}

  return result;
}

function debug_test() {
  try {
    const d = getAllData();
    _logDivider();
    Logger.log('Hồ sơ: ' + d.stats.totalRecords + '/' + d.hss.length + ' nhóm');
    Logger.log('Giáo viên: ' + d.teachers.length);
    Logger.log('Học sinh: ' + d.stats.totalChildren + ' (' + d.classes.length + ' lớp)');
    Logger.log('Ảnh: ' + d.images.length);
    _logDivider();
  } catch (e) { Logger.log('❌ Lỗi: ' + e.message); }
}


// ============================================================================
// SECTION 3/3: TDG.gs — backend KĐCL-TĐG (lưu báo cáo Drive + AI Gemini/Claude)
// ============================================================================

/**
 * ==========================================================================
 * TĐG-AI BACKEND v2.0 — Google Apps Script
 * HỖ TRỢ: Google Gemini (mặc định) HOẶC Anthropic Claude
 * ==========================================================================
 *
 * CHỨC NĂNG:
 *  - Lưu/tải/xoá báo cáo vào Google Drive (file JSON) + Sheets (index)
 *  - Proxy gọi Gemini API hoặc Claude API (ẩn key khỏi client)
 *  - Đọc nội dung Google Drive folder chứa minh chứng để AI tham khảo
 *
 * HƯỚNG DẪN CÀI ĐẶT NHANH (10 phút):
 *
 *  BƯỚC 1. Vào https://script.google.com → "Dự án mới" → xoá code mẫu
 *          → DÁN TOÀN BỘ file này vào → Lưu (Ctrl+S)
 *
 *  BƯỚC 2. Cấu hình Script Properties (⚙ Cài đặt dự án → Thuộc tính tập lệnh):
 *
 *    ☆ NẾU DÙNG GEMINI (khuyến nghị cho VN):
 *      - AI_PROVIDER        = gemini
 *      - GEMINI_API_KEY     = <key của bạn>     (lấy tại aistudio.google.com/apikey)
 *      - GEMINI_MODEL       = gemini-2.5-pro    (hoặc gemini-2.5-flash — nhanh hơn, rẻ hơn)
 *
 *    ☆ NẾU DÙNG CLAUDE:
 *      - AI_PROVIDER        = claude
 *      - ANTHROPIC_API_KEY  = sk-ant-api03-...
 *      - (tuỳ chọn) CLAUDE_MODEL = claude-sonnet-4-5-20250929
 *
 *  BƯỚC 3. Bật Drive API (➕ Dịch vụ ở sidebar trái → Drive API → Thêm)
 *
 *  BƯỚC 4. Triển khai → Triển khai mới → Ứng dụng web:
 *          - Thực thi với tư cách: Tôi
 *          - Ai có quyền truy cập: Bất kỳ ai
 *          → Bấm Triển khai → Cấp quyền → COPY "URL ứng dụng web"
 *
 *  BƯỚC 5. Mở TDG-AI.html → ⚙ Cài đặt → dán URL → Kiểm tra kết nối → Lưu
 *
 *  💡 TEST NHANH: Trong Apps Script editor, chọn hàm testAI ở dropdown → ▶ Run
 *     → xem kết quả ở tab "Thực thi". Nếu thấy JSON có "ok": true là đã OK.
 *
 * ==========================================================================
 */

// ===== CẤU HÌNH MẶC ĐỊNH ===========================================
const ROOT_FOLDER_NAME = 'TDG-AI-Reports';
const INDEX_SHEET_NAME = '_Index_BaoCao';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_OUTPUT_TOKENS    = 8192;
const TEMPERATURE          = 0.7;

// ===== ROUTER =====================================================

// Gọi từ Router.gs khi action thuộc nhóm TDG (ping/saveReport/loadReport/ai/...)
// action đã được kiểm tra trước, nên ở đây chỉ việc dispatch
function _tdgHandleAction(data) {
  try {
    const action = data.action;
    let result;
    switch (action) {
      case 'ping':             result = pingResponse_(); break;
      case 'saveReport':       result = saveReport(data.reportId, data.content); break;
      case 'loadReport':       result = loadReport(data.reportId); break;
      case 'listReports':      result = listReports(); break;
      case 'deleteReport':     result = deleteReport(data.reportId); break;
      case 'claude':
      case 'ai':               result = callAI(data.systemPrompt, data.userPrompt, data.driveFolderUrls); break;
      case 'readDriveFolder':  result = readDriveFolder(data.folderUrl); break;
      default: result = { ok: false, error: 'Unknown TDG action: ' + action };
    }
    return result;
  } catch (err) {
    return { ok: false, error: String(err) + '\n' + (err.stack || '') };
  }
}

// Trả trang HTML giới thiệu (được gọi từ Router.gs khi action=tdgStatus)
function _tdgStatusPage() {
  const provider = getProp_('AI_PROVIDER') || 'gemini';
  const modelKey = provider === 'gemini' ? 'GEMINI_MODEL' : 'CLAUDE_MODEL';
  const defaultModel = provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_CLAUDE_MODEL;
  const hasKey = !!getProp_(provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY');
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui;padding:2em">' +
    '<h2>✅ TĐG-AI Backend v2.0 đang hoạt động</h2>' +
    '<p><b>Thời gian:</b> ' + new Date().toLocaleString('vi-VN') + '</p>' +
    '<p><b>AI Provider:</b> ' + provider + '</p>' +
    '<p><b>Model:</b> ' + (getProp_(modelKey) || defaultModel) + '</p>' +
    '<p><b>API Key:</b> ' + (hasKey ? '✅ Đã cấu hình' : '❌ CHƯA cấu hình') + '</p>' +
    '<p style="color:#666;font-size:12px">Endpoint này nhận POST JSON. Đừng gọi GET trực tiếp.</p>' +
    '</div>'
  );
}

function pingResponse_() {
  const provider = getProp_('AI_PROVIDER') || 'gemini';
  const modelKey = provider === 'gemini' ? 'GEMINI_MODEL' : 'CLAUDE_MODEL';
  const defaultModel = provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_CLAUDE_MODEL;
  return {
    ok: true,
    service: 'TDG-AI-Backend',
    version: '2.0',
    aiProvider: provider,
    aiModel: getProp_(modelKey) || defaultModel,
    hasApiKey: !!getProp_(provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'),
    time: new Date().toISOString()
  };
}

// ===== STORAGE: REPORTS =============================================

function saveReport(reportId, content) {
  if (!reportId) throw new Error('Thiếu reportId');
  const folder = getOrCreateFolder_(ROOT_FOLDER_NAME);
  const filename = reportId + '.json';
  const json = JSON.stringify(content);

  const files = folder.getFilesByName(filename);
  let file;
  if (files.hasNext()) {
    file = files.next();
    file.setContent(json);
  } else {
    file = folder.createFile(filename, json, 'application/json');
  }
  updateIndex_(reportId, content);
  return { ok: true, id: file.getId(), url: file.getUrl(), updatedAt: new Date().toISOString() };
}

function loadReport(reportId) {
  if (!reportId) throw new Error('Thiếu reportId');
  const folder = getOrCreateFolder_(ROOT_FOLDER_NAME);
  const files = folder.getFilesByName(reportId + '.json');
  if (!files.hasNext()) return { ok: false, error: 'Không tìm thấy báo cáo: ' + reportId };
  const file = files.next();
  const content = JSON.parse(file.getBlob().getDataAsString());
  return { ok: true, content: content, updatedAt: file.getLastUpdated().toISOString() };
}

function listReports() {
  const sheet = getIndexSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, reports: [] };
  const data = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const headers = data[0];
  const rows = data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { ok: true, reports: rows };
}

function deleteReport(reportId) {
  if (!reportId) throw new Error('Thiếu reportId');
  const folder = getOrCreateFolder_(ROOT_FOLDER_NAME);
  const files = folder.getFilesByName(reportId + '.json');
  if (files.hasNext()) files.next().setTrashed(true);
  removeFromIndex_(reportId);
  return { ok: true };
}

// ===== INDEX SHEET =================================================

function getIndexSheet_() {
  // Ưu tiên dùng sheet chính (bound với project) — tạo tab _Index_BaoCao
  // Fallback: tạo spreadsheet riêng trong Drive folder (cho backend cũ chạy standalone)
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (ss) {
    let sheet = ss.getSheetByName(INDEX_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(INDEX_SHEET_NAME);
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['reportId', 'schoolName', 'schoolType', 'academicYear', 'principal', 'province', 'progress', 'updatedAt']);
      sheet.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#1e6b54').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      // Set column widths
      [260, 220, 110, 110, 160, 140, 80, 140].forEach(function(w, i){ sheet.setColumnWidth(i+1, w); });
    }
    return sheet;
  }
  // Fallback cũ — dùng khi TDG backend chạy độc lập không bound spreadsheet
  const folder = getOrCreateFolder_(ROOT_FOLDER_NAME);
  const files = folder.getFilesByName(INDEX_SHEET_NAME);
  let ssFallback;
  if (files.hasNext()) {
    ssFallback = SpreadsheetApp.open(files.next());
  } else {
    ssFallback = SpreadsheetApp.create(INDEX_SHEET_NAME);
    DriveApp.getFileById(ssFallback.getId()).moveTo(folder);
    try { DriveApp.getRootFolder().removeFile(DriveApp.getFileById(ssFallback.getId())); } catch (e) {}
  }
  const sheet = ssFallback.getSheets()[0];
  sheet.setName('BaoCao');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['reportId', 'schoolName', 'schoolType', 'academicYear', 'principal', 'province', 'progress', 'updatedAt']);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function updateIndex_(reportId, content) {
  const sheet = getIndexSheet_();
  const info = content.schoolInfo || {};
  const generated = content.generated || {};
  const done = Object.values(generated).filter(g => g && g.status === 'done').length;

  const row = [
    reportId,
    info.name || '',
    info.type === 'mamnon' ? 'Mầm non' : 'Tiểu học',
    (info.academicYearFrom || '') + '-' + (info.academicYearTo || ''),
    info.principal || '',
    info.province || '',
    done,
    new Date().toISOString()
  ];

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === reportId) {
        sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return;
      }
    }
  }
  sheet.appendRow(row);
}

function removeFromIndex_(reportId) {
  const sheet = getIndexSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i] === reportId) sheet.deleteRow(i + 2);
  }
}

// ===== AI CALL — CHỌN PROVIDER =====================================

function callAI(systemPrompt, userPrompt, driveFolderUrls) {
  const provider = (getProp_('AI_PROVIDER') || 'gemini').toLowerCase();

  // Đọc tài liệu từ Drive folders và chèn vào prompt
  let enrichedUserPrompt = userPrompt;
  if (Array.isArray(driveFolderUrls) && driveFolderUrls.length) {
    const driveContents = [];
    driveFolderUrls.forEach(url => {
      try {
        const r = readDriveFolder(url);
        if (r.ok && r.content) driveContents.push('---TÀI LIỆU TỪ DRIVE (' + url + ')---\n' + r.content + '\n---HẾT---');
      } catch (e) { /* skip */ }
    });
    if (driveContents.length) {
      enrichedUserPrompt = userPrompt + '\n\n' + driveContents.join('\n\n');
      if (enrichedUserPrompt.length > 80000) enrichedUserPrompt = enrichedUserPrompt.slice(0, 80000) + '\n...(đã cắt bớt)';
    }
  }

  if (provider === 'gemini') return callGemini_(systemPrompt, enrichedUserPrompt);
  if (provider === 'claude') return callClaude_(systemPrompt, enrichedUserPrompt);
  return { ok: false, error: 'AI_PROVIDER không hợp lệ: "' + provider + '". Chỉ nhận "gemini" hoặc "claude".' };
}

// ===== GEMINI API ===================================================

function callGemini_(systemPrompt, userPrompt) {
  const apiKey = getProp_('GEMINI_API_KEY');
  if (!apiKey) {
    return { ok: false, error: 'Chưa cấu hình GEMINI_API_KEY. Vào ⚙ Cài đặt dự án → Thuộc tính tập lệnh → Thêm GEMINI_API_KEY (lấy tại https://aistudio.google.com/apikey).' };
  }

  const model = getProp_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      topP: 0.95
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    return { ok: false, error: 'Gemini API lỗi ' + code + ': ' + body.slice(0, 800) };
  }

  const data = JSON.parse(body);
  if (!data.candidates || data.candidates.length === 0) {
    const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
    if (blockReason) return { ok: false, error: 'Gemini từ chối xử lý: ' + blockReason };
    return { ok: false, error: 'Gemini không trả lời: ' + body.slice(0, 400) };
  }

  const candidate = data.candidates[0];
  if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
    return { ok: false, error: 'Gemini dừng sớm: ' + candidate.finishReason };
  }

  const text = ((candidate.content && candidate.content.parts) || []).map(p => p.text || '').join('\n').trim();
  if (!text) return { ok: false, error: 'Gemini trả về nội dung rỗng. Có thể prompt quá dài hoặc bị filter.' };

  return {
    ok: true,
    content: text,
    provider: 'gemini',
    model: model,
    usage: data.usageMetadata
  };
}

// ===== CLAUDE API ===================================================

function callClaude_(systemPrompt, userPrompt) {
  const apiKey = getProp_('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return { ok: false, error: 'Chưa cấu hình ANTHROPIC_API_KEY.' };
  }
  const model = getProp_('CLAUDE_MODEL') || DEFAULT_CLAUDE_MODEL;

  const payload = {
    model: model,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };

  const options = {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    return { ok: false, error: 'Claude API lỗi ' + code + ': ' + body.slice(0, 800) };
  }

  const data = JSON.parse(body);
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  return { ok: true, content: text, provider: 'claude', model: model, usage: data.usage };
}

// ===== DRIVE FOLDER READER =========================================

function readDriveFolder(folderUrl) {
  const folderId = extractDriveId_(folderUrl);
  if (!folderId) return { ok: false, error: 'Không nhận diện được ID từ URL: ' + folderUrl };

  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    try {
      const file = DriveApp.getFileById(folderId);
      const text = extractTextFromFile_(file);
      return { ok: true, content: '# ' + file.getName() + '\n' + text, files: 1 };
    } catch (e2) {
      return { ok: false, error: 'Không truy cập được: ' + e.message };
    }
  }

  const contents = [];
  let fileCount = 0;
  const iterator = folder.getFiles();
  while (iterator.hasNext() && fileCount < 30) {
    const file = iterator.next();
    try {
      const text = extractTextFromFile_(file);
      if (text) {
        contents.push('## ' + file.getName() + '\n' + text.slice(0, 3000));
        fileCount++;
      }
    } catch (e) { /* skip */ }
  }
  return { ok: true, content: contents.join('\n\n'), files: fileCount, folderName: folder.getName() };
}

function extractDriveId_(url) {
  if (!url) return null;
  let m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(url.trim())) return url.trim();
  return null;
}

function extractTextFromFile_(file) {
  const type = file.getMimeType();
  if (type === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(file.getId()).getBody().getText();
  }
  if (type === MimeType.GOOGLE_SHEETS) {
    const ss = SpreadsheetApp.openById(file.getId());
    return ss.getSheets().map(s => s.getName() + ':\n' + s.getDataRange().getValues().map(r => r.join('\t')).join('\n')).join('\n\n');
  }
  if (type === MimeType.PLAIN_TEXT || type === 'text/markdown' || type === 'text/csv') {
    return file.getBlob().getDataAsString();
  }
  if (type === MimeType.PDF) {
    try {
      const blob = file.getBlob();
      const resource = { title: file.getName() + '_ocr', mimeType: MimeType.GOOGLE_DOCS };
      const doc = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: 'vi' });
      const text = DocumentApp.openById(doc.id).getBody().getText();
      DriveApp.getFileById(doc.id).setTrashed(true);
      return text;
    } catch (e) {
      return '[Không đọc được PDF: ' + file.getName() + ']';
    }
  }
  return '';
}

// ===== UTIL =========================================================

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getOrCreateFolder_(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== TIỆN ÍCH: TEST NHANH NGAY TRONG EDITOR ======================

/**
 * Chạy thử AI call ngay trong Apps Script editor.
 * Chọn hàm `testAI` trong dropdown → bấm ▶ Run → xem kết quả ở "Thực thi".
 * Nếu thấy JSON có "ok": true là đã thành công.
 */
function testAI() {
  const result = callAI(
    'Bạn là trợ lý tiếng Việt chuyên viết văn bản hành chính giáo dục.',
    'Viết 3 câu giới thiệu ngắn về một Trường Tiểu học ở Việt Nam.',
    []
  );
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Test nhanh: Kiểm tra cấu hình có đúng không.
 * Chọn hàm `testConfig` → ▶ Run → xem log.
 */
function testConfig() {
  const provider = getProp_('AI_PROVIDER') || '(chưa đặt, mặc định: gemini)';
  const geminiKey = getProp_('GEMINI_API_KEY');
  const claudeKey = getProp_('ANTHROPIC_API_KEY');
  const geminiModel = getProp_('GEMINI_MODEL') || '(mặc định: ' + DEFAULT_GEMINI_MODEL + ')';
  const claudeModel = getProp_('CLAUDE_MODEL') || '(mặc định: ' + DEFAULT_CLAUDE_MODEL + ')';

  Logger.log('=== Cấu hình TĐG-AI Backend ===');
  Logger.log('AI_PROVIDER: ' + provider);
  Logger.log('GEMINI_API_KEY: ' + (geminiKey ? '✅ đã đặt (' + geminiKey.slice(0, 10) + '...)' : '❌ CHƯA đặt'));
  Logger.log('GEMINI_MODEL: ' + geminiModel);
  Logger.log('ANTHROPIC_API_KEY: ' + (claudeKey ? '✅ đã đặt' : '❌ chưa đặt (OK nếu dùng Gemini)'));
  Logger.log('CLAUDE_MODEL: ' + claudeModel);
}


// ============================================================================
// SECTION 4/4: QLCL.gs — Quản lý Chất lượng (nhập điểm · nhận xét · học bạ)
// Tuân thủ: Thông tư 27/2020/TT-BGDĐT + CTGDPT 2018 + TT 22/2024 (KĐCL)
// ============================================================================

const SHEET_QLCL_CAUHINH  = 'QLCL_CauHinh';
const SHEET_QLCL_PHANCONG = 'QLCL_PhanCong';
const SHEET_QLCL_DIEMDK   = 'QLCL_DiemDK';
const SHEET_QLCL_NHANXET  = 'QLCL_NhanXet';
const SHEET_QLCL_NANGLUC  = 'QLCL_NangLuc';
const SHEET_QLCL_XEPLOAI  = 'QLCL_XepLoai';
const SHEET_QLCL_AUDIT    = 'QLCL_AuditLog';
// ⭐ Sổ chủ nhiệm (workspace #10) — 3 sheet mới
const SHEET_QLCL_DIEMDANH = 'QLCL_DiemDanh';   // Sĩ số + chuyên cần hàng ngày
const SHEET_QLCL_VIPHAM   = 'QLCL_ViPham';     // Theo dõi nề nếp - vi phạm
const SHEET_QLCL_HOATDONG = 'QLCL_HoatDongLop';// Sinh hoạt + hoạt động lớp
// HSS Status — trạng thái Đã có/Chưa có cho từng hồ sơ (giống MN Diễn Xuân)
const SHEET_HSS_STATUS = 'HSS_Status';

// Cấu hình môn — theo TT 27/2020 (bắt buộc)
// Cột: MonHoc · KhoiCoDiem (khối có điểm ĐGĐK CHK1+CN) · KhoiCoGHK (khối có thêm GHK1+GHK2) · SoTietTuan
const QLCL_SUBJECTS_SEED = [
  ['Tiếng Việt',             '1,2,3,4,5', '4,5', 10],
  ['Toán',                    '1,2,3,4,5', '4,5', 7],
  ['Tiếng Anh',               '3,4,5',     '',    4],
  ['Tin học',                 '3,4,5',     '',    2],
  ['Công nghệ',               '3,4,5',     '',    1],
  ['Khoa học',                '4,5',       '',    2],
  ['Lịch sử và Địa lí',       '4,5',       '',    3],
  ['Đạo đức',                 '',          '',    1],
  ['Tự nhiên và Xã hội',      '',          '',    2],
  ['Âm nhạc',                 '',          '',    1],
  ['Mỹ thuật',                '',          '',    1],
  ['Giáo dục thể chất',       '',          '',    2],
  ['Hoạt động trải nghiệm',   '',          '',    3]
];

// Năng lực + Phẩm chất (CTGDPT 2018) — seed vào tab CauHinh khi cần
const QLCL_NLPC_DEF = [
  // Loại, Mã, Tên
  ['NL','TuChuTuHoc',   'Tự chủ và tự học'],
  ['NL','GiaoTiepHopTac','Giao tiếp và hợp tác'],
  ['NL','GiaiQuyetVanDe','Giải quyết vấn đề và sáng tạo'],
  ['PC','YeuNuoc',      'Yêu nước'],
  ['PC','NhanAi',       'Nhân ái'],
  ['PC','ChamChi',      'Chăm chỉ'],
  ['PC','TrungThuc',    'Trung thực'],
  ['PC','TrachNhiem',   'Trách nhiệm']
];

// ============================================================================
// Setup 7 tabs QLCL (gọi từ setupAll)
// ============================================================================
function setupQLCL() {
  const ss = _getSS();
  const tabs = [
    { name: SHEET_QLCL_CAUHINH,  headers: ['MonHoc','KhoiCoDiem','KhoiCoGHK','SoTietTuan'] },
    { name: SHEET_QLCL_PHANCONG, headers: ['NamHoc','MaGV','HoTenGV','Lop','MonHoc','Role','CapNhat'] },
    { name: SHEET_QLCL_DIEMDK,   headers: ['NamHoc','MaHS','HoTen','Lop','MonHoc','GHK1','CHK1','GHK2','CN','NhapBoi','CapNhat'] },
    { name: SHEET_QLCL_NHANXET,  headers: ['NamHoc','MaHS','Lop','MonHoc','HocKy','Muc','NhanXet','GV','CapNhat'] },
    { name: SHEET_QLCL_NANGLUC,  headers: ['NamHoc','MaHS','Lop','HocKy','Loai','Ma','TenLoai','Muc','NhanXet','GV','CapNhat'] },
    { name: SHEET_QLCL_XEPLOAI,  headers: ['NamHoc','MaHS','HoTen','Lop','XepLoai','LenLop','KhenThuong','NhanXetChung','GVCN','HT','CapNhat'] },
    { name: SHEET_QLCL_AUDIT,    headers: ['Time','User','Role','Action','Target','OldValue','NewValue','Note'] },
    // ⭐ Sổ chủ nhiệm — 3 sheet mới
    // DiemDanh: 1 dòng = 1 HS / 1 ngày. TrangThai: P (có mặt), K (nghỉ có phép), KP (nghỉ không phép), M (đi muộn)
    { name: SHEET_QLCL_DIEMDANH, headers: ['NamHoc','Lop','Ngay','MaHS','HoTen','TrangThai','GhiChu','GVCN','CapNhat'] },
    // ViPham: 1 dòng = 1 lần ghi nhận. MucDo: 'Nhe' / 'Nang'. XuLy: hình thức xử lý
    { name: SHEET_QLCL_VIPHAM,   headers: ['NamHoc','Lop','Ngay','MaHS','HoTen','LoaiViPham','MucDo','MoTa','XuLy','GVCN','CapNhat'] },
    // HoatDongLop: nhật ký sinh hoạt + hoạt động ngoại khoá. Loai: 'SinhHoat' / 'NgoaiKhoa' / 'ChaoCo' / 'Khac'
    { name: SHEET_QLCL_HOATDONG, headers: ['NamHoc','Lop','Ngay','Loai','ChuDe','NoiDung','KetLuan','SoHSThamGia','GVCN','CapNhat'] },
    // ⭐ HSS Status: trạng thái Đã có/Chưa có cho từng hồ sơ (giống MN Diễn Xuân)
    // MaHS: mã hồ sơ (vd: '1.1.1', '1.2.3'). TrangThai: 'co' (đã có) | 'chua' (chưa có) | 'auto' (theo link Drive)
    // NguoiPhuTrach: ai chịu trách nhiệm hồ sơ này. GhiChu: lưu ý thêm.
    { name: SHEET_HSS_STATUS,    headers: ['MaHS','TrangThai','NguoiPhuTrach','GhiChu','CapNhat','User'] }
  ];
  let created = 0;
  tabs.forEach(t => {
    let sh = ss.getSheetByName(t.name);
    if (!sh) { sh = ss.insertSheet(t.name); created++; }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, t.headers.length).setValues([t.headers]);
      sh.getRange(1, 1, 1, t.headers.length)
        .setBackground('#0c5da5').setFontColor('#ffffff').setFontWeight('bold')
        .setVerticalAlignment('middle').setHorizontalAlignment('center');
      sh.setFrozenRows(1);
    }
  });
  // Seed cấu hình môn
  const shCH = ss.getSheetByName(SHEET_QLCL_CAUHINH);
  if (shCH.getLastRow() <= 1) {
    shCH.getRange(2, 1, QLCL_SUBJECTS_SEED.length, 4).setValues(QLCL_SUBJECTS_SEED);
  }
  Logger.log('[QLCL] Đã tạo/kiểm tra 11 tab' + (created ? ' (tạo mới ' + created + ')' : ''));
}

// ============================================================================
// Helpers
// ============================================================================
function _qlclSheet(name) {
  const ss = _getSS();
  let sh = ss.getSheetByName(name);
  if (!sh) { setupQLCL(); sh = ss.getSheetByName(name); }
  return sh;
}

function _qlclReadAll(sheetName) {
  const sh = _qlclSheet(sheetName);
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return { headers: data[0] || [], rows: [] };
  const headers = data[0];
  const rows = data.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
  return { headers: headers, rows: rows };
}

/**
 * Lọc rows từ một sheet QLCL theo bộ filter — thay thế 5 hàm Get có logic lặp.
 * @param {string} sheetName  tên sheet QLCL_*
 * @param {object} filters    { ColumnName: value } — bỏ qua key có value rỗng/null/undefined.
 *                            Cho phép value là Array → match bất kỳ phần tử (in-set).
 * @param {object} [options]
 *   - includeDeleted: mặc định false. Bỏ row có IsDeleted === true (cho Bước 2 soft delete).
 * @return {{headers: string[], rows: object[]}}
 */
function _qlclFilterRows(sheetName, filters, options) {
  const all = _qlclReadAll(sheetName);
  const includeDeleted = !!(options && options.includeDeleted === true);
  const f = filters || {};
  // Chỉ giữ những key có giá trị thực sự để match
  const keys = Object.keys(f).filter(function (k) {
    const v = f[k];
    if (v === '' || v === null || v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });

  const rows = all.rows.filter(function (r) {
    // Soft delete: bỏ row đã đánh dấu xoá (sheet cũ chưa có cột → r.IsDeleted = undefined → giữ)
    if (!includeDeleted && r.IsDeleted === true) return false;

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const target = f[k];
      const cell = String(r[k] == null ? '' : r[k]).trim();
      if (Array.isArray(target)) {
        const hit = target.some(function (v) { return String(v).trim() === cell; });
        if (!hit) return false;
      } else {
        if (String(target).trim() !== cell) return false;
      }
    }
    return true;
  });

  return { headers: all.headers, rows: rows };
}

function _qlclAudit(user, role, action, target, oldVal, newVal, note) {
  try {
    const sh = _qlclSheet(SHEET_QLCL_AUDIT);
    sh.appendRow([new Date(), user || 'unknown', role || '', action || '', target || '',
                  JSON.stringify(oldVal == null ? '' : oldVal), JSON.stringify(newVal == null ? '' : newVal),
                  note || '']);
  } catch (e) { Logger.log('[audit] ' + e.message); }
}

// ============================================================================
// Dispatch
// ============================================================================
// Set action ghi của QLCL — dùng để áp role check + lock + audit
const _QLCL_WRITE_SET_ = {
  qlclSaveDiem:1, qlclSaveNhanXet:1, qlclSaveNLPC:1, qlclSaveXepLoai:1, qlclSavePhanCong:1,
  qlclSaveDiemDanh:1, qlclSaveViPham:1, qlclDeleteViPham:1,
  qlclSaveHoatDong:1, qlclDeleteHoatDong:1
};

function _qlclHandle(action, body) {
  try {
    // ⭐ BẢO MẬT: với action ghi, tra role thật từ DSGV — KHÔNG tin role do client gửi
    if (_QLCL_WRITE_SET_[action]) {
      const realRole = _resolveRole_(body.user);
      if (realRole === null) {
        // Trường hợp DSGV trống (lần đầu cài đặt) → cho qua. Có DSGV mà không thấy user → reject.
        let teacherCount = 0;
        try {
          const sh = _getSS().getSheetByName(SHEET_DSGV);
          if (sh) teacherCount = Math.max(0, sh.getLastRow() - 1);
        } catch (e) {}
        if (teacherCount > 0) {
          return { ok: false, error: '⛔ Không tìm thấy "' + (body.user || '?') + '" trong Danh sách giáo viên (DSGV). Liên hệ Hiệu trưởng bổ sung trước khi nhập dữ liệu.' };
        }
        // DSGV trống → fallback role client (chỉ dùng giai đoạn setup)
      } else if (realRole === _ROLE_KHAC_) {
        return { ok: false, error: '⛔ Vai trò của bạn (' + (body.user || '') + ') không có quyền ghi dữ liệu Quản lý chất lượng. Chỉ Hiệu trưởng và Giáo viên được cấp quyền.' };
      } else {
        body.role = realRole; // override role bằng giá trị server tra cứu
      }
    }

    switch (action) {
      case 'qlclConfig':      return _qlclGetConfig();
      case 'qlclGetDiem':     return _qlclGetDiem(body.namHoc, body.lop, body.monHoc);
      case 'qlclSaveDiem':    return _withLock_(function(){ return _qlclSaveDiem(body); });
      case 'qlclGetNhanXet':  return _qlclGetNhanXet(body.namHoc, body.lop, body.monHoc, body.hocKy);
      case 'qlclSaveNhanXet': return _withLock_(function(){ return _qlclSaveNhanXet(body); });
      case 'qlclGetNLPC':     return _qlclGetNLPC(body.namHoc, body.lop, body.hocKy);
      case 'qlclSaveNLPC':    return _withLock_(function(){ return _qlclSaveNLPC(body); });
      case 'qlclGetXepLoai':  return _qlclGetXepLoai(body.namHoc, body.lop);
      case 'qlclSaveXepLoai': return _withLock_(function(){ return _qlclSaveXepLoai(body); });
      case 'qlclGetPhanCong': return _qlclGetPhanCong(body.namHoc);
      case 'qlclSavePhanCong':return _withLock_(function(){ return _qlclSavePhanCong(body); });
      case 'qlclDashboard':   return _qlclDashboard(body.namHoc);
      case 'qlclAudit':       return _qlclGetAudit(body.limit || 50);
      // ⭐ Sổ chủ nhiệm — workspace #10
      case 'qlclGetDiemDanh':    return _qlclGetDiemDanh(body.namHoc, body.lop, body.tuNgay, body.denNgay);
      case 'qlclSaveDiemDanh':   return _withLock_(function(){ return _qlclSaveDiemDanh(body); });
      case 'qlclGetViPham':      return _qlclGetViPham(body.namHoc, body.lop);
      case 'qlclSaveViPham':     return _withLock_(function(){ return _qlclSaveViPham(body); });
      case 'qlclDeleteViPham':   return _withLock_(function(){ return _qlclDeleteViPham(body); });
      case 'qlclGetHoatDong':    return _qlclGetHoatDong(body.namHoc, body.lop);
      case 'qlclSaveHoatDong':   return _withLock_(function(){ return _qlclSaveHoatDong(body); });
      case 'qlclDeleteHoatDong': return _withLock_(function(){ return _qlclDeleteHoatDong(body); });
      case 'qlclChuNhiemSummary':return _qlclChuNhiemSummary(body.namHoc, body.lop);
      default: return { ok: false, error: 'Unknown QLCL action: ' + action };
    }
  } catch (err) {
    return { ok: false, error: String(err) + '\n' + (err.stack || '') };
  }
}

// ============================================================================
// Config
// ============================================================================
function _qlclGetConfig() {
  return { ok: true, data: {
    subjects: _qlclReadAll(SHEET_QLCL_CAUHINH).rows,
    nlpc: QLCL_NLPC_DEF.map(r => ({ Loai: r[0], Ma: r[1], TenLoai: r[2] }))
  }};
}

// ============================================================================
// Điểm định kỳ
// ============================================================================
function _qlclGetDiem(namHoc, lop, monHoc) {
  const r = _qlclFilterRows(SHEET_QLCL_DIEMDK, { NamHoc: namHoc, Lop: lop, MonHoc: monHoc });
  return { ok: true, data: r.rows };
}

function _qlclSaveDiem(body) {
  // body: { namHoc, lop, monHoc, rows: [{maHS, hoTen, GHK1, CHK1, GHK2, CN}...], user, role }

  // ⭐ VALIDATE INPUT
  if (!body.namHoc) return { ok: false, error: 'Thiếu năm học' };
  if (!body.lop)    return { ok: false, error: 'Thiếu lớp' };
  if (!body.monHoc) return { ok: false, error: 'Thiếu môn học' };

  // Kiểm môn học có trong cấu hình QLCL_CauHinh
  const subjects = _qlclReadAll(SHEET_QLCL_CAUHINH).rows;
  const subjectExists = subjects.some(s => String(s.MonHoc).trim() === String(body.monHoc).trim());
  if (subjects.length > 0 && !subjectExists) {
    return { ok: false, error: 'Môn học "' + body.monHoc + '" không có trong cấu hình. Vào QLCL_CauHinh kiểm tra.' };
  }

  // Validate từng điểm: rỗng hoặc 0..10
  const errs = [];
  (body.rows || []).forEach((r, idx) => {
    if (!r.maHS) { errs.push('Dòng ' + (idx+1) + ': thiếu mã học sinh'); return; }
    [['GHK1', r.GHK1], ['CHK1', r.CHK1], ['GHK2', r.GHK2], ['CN', r.CN]].forEach(p => {
      const e = _qlclValidScore_(p[1]);
      if (e) errs.push('HS ' + (r.hoTen || r.maHS) + ' · ' + p[0] + ' (' + p[1] + '): ' + e);
    });
  });
  if (errs.length) return { ok: false, error: 'Dữ liệu điểm không hợp lệ:\n• ' + errs.slice(0, 8).join('\n• ') + (errs.length > 8 ? '\n…(còn ' + (errs.length - 8) + ' lỗi)' : '') };

  const sh = _qlclSheet(SHEET_QLCL_DIEMDK);
  const existing = _qlclReadAll(SHEET_QLCL_DIEMDK);
  const idxKey = {};
  existing.rows.forEach((r, i) => {
    const k = [r.NamHoc, r.MaHS, r.Lop, r.MonHoc].join('|');
    idxKey[k] = i + 2; // row number (1-based header + 1)
  });

  const now = new Date();
  const user = body.user || 'unknown';
  const role = body.role || '';
  let updated = 0, inserted = 0;
  (body.rows || []).forEach(r => {
    const k = [body.namHoc, r.maHS, body.lop, body.monHoc].join('|');
    const row = [body.namHoc, r.maHS, r.hoTen || '', body.lop, body.monHoc,
                 r.GHK1 === undefined ? '' : r.GHK1,
                 r.CHK1 === undefined ? '' : r.CHK1,
                 r.GHK2 === undefined ? '' : r.GHK2,
                 r.CN   === undefined ? '' : r.CN,
                 user, now];
    if (idxKey[k]) {
      // Compare old vs new for audit
      const oldRow = sh.getRange(idxKey[k], 1, 1, 11).getValues()[0];
      const oldDiem = { GHK1: oldRow[5], CHK1: oldRow[6], GHK2: oldRow[7], CN: oldRow[8] };
      const newDiem = { GHK1: row[5], CHK1: row[6], GHK2: row[7], CN: row[8] };
      sh.getRange(idxKey[k], 1, 1, 11).setValues([row]);
      updated++;
      if (JSON.stringify(oldDiem) !== JSON.stringify(newDiem)) {
        _qlclAudit(user, role, 'updateDiem', k, oldDiem, newDiem, '');
      }
    } else {
      sh.appendRow(row);
      inserted++;
      _qlclAudit(user, role, 'insertDiem', k, null, row.slice(5, 9), '');
    }
  });
  return { ok: true, data: { updated: updated, inserted: inserted } };
}

// ============================================================================
// Nhận xét thường xuyên
// ============================================================================
function _qlclGetNhanXet(namHoc, lop, monHoc, hocKy) {
  const r = _qlclFilterRows(SHEET_QLCL_NHANXET, {
    NamHoc: namHoc, Lop: lop, MonHoc: monHoc, HocKy: hocKy
  });
  return { ok: true, data: r.rows };
}

function _qlclSaveNhanXet(body) {
  const sh = _qlclSheet(SHEET_QLCL_NHANXET);
  const existing = _qlclReadAll(SHEET_QLCL_NHANXET);
  const idxKey = {};
  existing.rows.forEach((r, i) => {
    const k = [r.NamHoc, r.MaHS, r.Lop, r.MonHoc, r.HocKy].join('|');
    idxKey[k] = i + 2;
  });
  const now = new Date();
  const user = body.user || 'unknown';
  const role = body.role || '';
  let updated = 0, inserted = 0;
  (body.rows || []).forEach(r => {
    const k = [body.namHoc, r.maHS, body.lop, body.monHoc, body.hocKy].join('|');
    const row = [body.namHoc, r.maHS, body.lop, body.monHoc, body.hocKy, r.muc || '', r.nhanXet || '', user, now];
    if (idxKey[k]) {
      const oldRow = sh.getRange(idxKey[k], 1, 1, 9).getValues()[0];
      sh.getRange(idxKey[k], 1, 1, 9).setValues([row]);
      updated++;
      if (oldRow[5] !== row[5] || oldRow[6] !== row[6]) {
        _qlclAudit(user, role, 'updateNhanXet', k, {muc:oldRow[5], nx:oldRow[6]}, {muc:row[5], nx:row[6]}, '');
      }
    } else {
      sh.appendRow(row);
      inserted++;
      _qlclAudit(user, role, 'insertNhanXet', k, null, {muc:row[5], nx:row[6]}, '');
    }
  });
  return { ok: true, data: { updated: updated, inserted: inserted } };
}

// ============================================================================
// Năng lực + Phẩm chất
// ============================================================================
function _qlclGetNLPC(namHoc, lop, hocKy) {
  const r = _qlclFilterRows(SHEET_QLCL_NANGLUC, { NamHoc: namHoc, Lop: lop, HocKy: hocKy });
  return { ok: true, data: r.rows };
}

function _qlclSaveNLPC(body) {
  // Validate mức NLPC theo TT27: T (Tốt) / Đ (Đạt) / C (Cần cố gắng) — có thể rỗng khi chưa đánh giá
  const MUC_HOPLE = ['', 'T', 'Đ', 'C'];
  const errs = [];
  (body.rows || []).forEach((r, idx) => {
    if (!r.maHS) { errs.push('Dòng ' + (idx+1) + ': thiếu mã học sinh'); return; }
    if (r.muc && MUC_HOPLE.indexOf(String(r.muc).trim()) < 0) {
      errs.push('HS ' + (r.maHS) + ' · ' + (r.tenLoai || r.ma) + ': mức "' + r.muc + '" không hợp lệ (phải T/Đ/C theo TT27)');
    }
  });
  if (errs.length) return { ok: false, error: 'Dữ liệu năng lực-phẩm chất không hợp lệ:\n• ' + errs.slice(0, 8).join('\n• ') };

  const sh = _qlclSheet(SHEET_QLCL_NANGLUC);
  const existing = _qlclReadAll(SHEET_QLCL_NANGLUC);
  const idxKey = {};
  existing.rows.forEach((r, i) => {
    const k = [r.NamHoc, r.MaHS, r.Lop, r.HocKy, r.Ma].join('|');
    idxKey[k] = i + 2;
  });
  const now = new Date();
  const user = body.user || 'unknown';
  const role = body.role || '';
  let updated = 0, inserted = 0;
  (body.rows || []).forEach(r => {
    const k = [body.namHoc, r.maHS, body.lop, body.hocKy, r.ma].join('|');
    const row = [body.namHoc, r.maHS, body.lop, body.hocKy, r.loai || '', r.ma || '', r.tenLoai || '',
                 r.muc || '', r.nhanXet || '', user, now];
    if (idxKey[k]) {
      const oldRow = sh.getRange(idxKey[k], 1, 1, 11).getValues()[0];
      sh.getRange(idxKey[k], 1, 1, 11).setValues([row]);
      updated++;
      if (oldRow[7] !== row[7] || oldRow[8] !== row[8]) {
        _qlclAudit(user, role, 'updateNLPC', k, {muc:oldRow[7], nx:oldRow[8]}, {muc:row[7], nx:row[8]}, '');
      }
    } else {
      sh.appendRow(row);
      inserted++;
      _qlclAudit(user, role, 'insertNLPC', k, null, {muc:row[7], nx:row[8]}, '');
    }
  });
  return { ok: true, data: { updated: updated, inserted: inserted } };
}

// ============================================================================
// Xếp loại cuối năm
// ============================================================================
function _qlclGetXepLoai(namHoc, lop) {
  const r = _qlclFilterRows(SHEET_QLCL_XEPLOAI, { NamHoc: namHoc, Lop: lop });
  return { ok: true, data: r.rows };
}

function _qlclSaveXepLoai(body) {
  // Validate khenThuong theo TT27: chỉ 2 danh hiệu hợp lệ
  // (Hoặc rỗng khi học sinh không đạt khen thưởng)
  const errs = [];
  (body.rows || []).forEach((r, idx) => {
    if (!r.maHS) { errs.push('Dòng ' + (idx+1) + ': thiếu mã học sinh'); return; }
    if (r.khenThuong && _KHEN_THUONG_VALID_.indexOf(String(r.khenThuong).trim()) < 0) {
      errs.push('HS ' + (r.hoTen || r.maHS) + ': khen thưởng "' + r.khenThuong +
                '" không hợp lệ (theo TT27 chỉ có "Xuất sắc" hoặc "Tiêu biểu hoàn thành tốt")');
    }
  });
  if (errs.length) return { ok: false, error: 'Dữ liệu xếp loại không hợp lệ:\n• ' + errs.slice(0, 8).join('\n• ') };

  const sh = _qlclSheet(SHEET_QLCL_XEPLOAI);
  const existing = _qlclReadAll(SHEET_QLCL_XEPLOAI);
  const idxKey = {};
  existing.rows.forEach((r, i) => {
    const k = [r.NamHoc, r.MaHS, r.Lop].join('|');
    idxKey[k] = i + 2;
  });
  const now = new Date();
  const user = body.user || 'unknown';
  const role = body.role || '';
  let updated = 0, inserted = 0;
  (body.rows || []).forEach(r => {
    const k = [body.namHoc, r.maHS, body.lop].join('|');
    const row = [body.namHoc, r.maHS, r.hoTen || '', body.lop, r.xepLoai || '',
                 r.lenLop || '', r.khenThuong || '', r.nhanXetChung || '',
                 r.gvcn || '', r.ht || '', now];
    if (idxKey[k]) {
      const oldRow = sh.getRange(idxKey[k], 1, 1, 11).getValues()[0];
      sh.getRange(idxKey[k], 1, 1, 11).setValues([row]);
      updated++;
      const oldXL = { xl: oldRow[4], lenLop: oldRow[5], khen: oldRow[6] };
      const newXL = { xl: row[4],    lenLop: row[5],    khen: row[6]    };
      if (JSON.stringify(oldXL) !== JSON.stringify(newXL)) {
        _qlclAudit(user, role, 'updateXepLoai', k, oldXL, newXL, '');
      }
    } else {
      sh.appendRow(row);
      inserted++;
      _qlclAudit(user, role, 'insertXepLoai', k, null,
        { xl: row[4], lenLop: row[5], khen: row[6] }, '');
    }
  });
  return { ok: true, data: { updated: updated, inserted: inserted } };
}

// ============================================================================
// Phân công dạy học
// ============================================================================
function _qlclGetPhanCong(namHoc) {
  const r = _qlclFilterRows(SHEET_QLCL_PHANCONG, { NamHoc: namHoc });
  return { ok: true, data: r.rows };
}

function _qlclSavePhanCong(body) {
  const sh = _qlclSheet(SHEET_QLCL_PHANCONG);
  // body.rows: [{maGV, hoTenGV, lop, monHoc, role(GVCN|GVBM)}]
  // Strategy: thay toàn bộ dữ liệu cho namHoc
  const namHoc = body.namHoc;
  const all = _qlclReadAll(SHEET_QLCL_PHANCONG).rows;
  const keepOther = all.filter(r => String(r.NamHoc) !== String(namHoc));
  // Clear all + re-append
  sh.clear();
  sh.getRange(1, 1, 1, 7).setValues([['NamHoc','MaGV','HoTenGV','Lop','MonHoc','Role','CapNhat']]);
  sh.getRange(1, 1, 1, 7).setBackground('#0c5da5').setFontColor('#ffffff').setFontWeight('bold');
  const now = new Date();
  const rowsOut = keepOther.map(r => [r.NamHoc, r.MaGV, r.HoTenGV, r.Lop, r.MonHoc, r.Role, r.CapNhat])
    .concat((body.rows || []).map(r => [namHoc, r.maGV, r.hoTenGV, r.lop, r.monHoc, r.role, now]));
  if (rowsOut.length) sh.getRange(2, 1, rowsOut.length, 7).setValues(rowsOut);
  return { ok: true, data: { total: rowsOut.length } };
}

// ============================================================================
// Dashboard thống kê
// ============================================================================
function _qlclDashboard(namHoc) {
  const diem = _qlclReadAll(SHEET_QLCL_DIEMDK).rows.filter(r => String(r.NamHoc) === String(namHoc));
  const xl = _qlclReadAll(SHEET_QLCL_XEPLOAI).rows.filter(r => String(r.NamHoc) === String(namHoc));
  const nx = _qlclReadAll(SHEET_QLCL_NHANXET).rows.filter(r => String(r.NamHoc) === String(namHoc));
  // Xếp loại phân bố
  const xlDist = { 'Hoàn thành xuất sắc':0, 'Hoàn thành tốt':0, 'Hoàn thành':0, 'Chưa hoàn thành':0 };
  xl.forEach(r => { if (xlDist[r.XepLoai] != null) xlDist[r.XepLoai]++; });
  // Môn yếu nhất (TB thấp nhất theo lớp+môn)
  const groupTB = {};
  diem.forEach(r => {
    const g = r.Lop + '|' + r.MonHoc;
    const scores = [r.GHK1, r.CHK1, r.GHK2, r.CN].filter(x => x !== '' && x != null && !isNaN(Number(x)));
    if (!scores.length) return;
    const avg = scores.reduce((a,b) => a + Number(b), 0) / scores.length;
    if (!groupTB[g]) groupTB[g] = { lop: r.Lop, mon: r.MonHoc, sum: 0, n: 0 };
    groupTB[g].sum += avg;
    groupTB[g].n++;
  });
  const bottom = Object.values(groupTB).map(g => ({ lop: g.lop, mon: g.mon, tb: g.n ? (g.sum / g.n) : 0 }))
    .sort((a, b) => a.tb - b.tb).slice(0, 10);
  return { ok: true, data: {
    totalDiem: diem.length,
    totalNX: nx.length,
    totalXL: xl.length,
    xlDist: xlDist,
    bottomMon: bottom
  }};
}

// ============================================================================
// Audit log
// ============================================================================
function _qlclGetAudit(limit) {
  const all = _qlclReadAll(SHEET_QLCL_AUDIT).rows;
  return { ok: true, data: all.slice(-Math.min(limit || 500, 500)).reverse() };
}

// ============================================================================
// ⭐ SỔ CHỦ NHIỆM — Workspace #10 (TT 27/2020 + Điều lệ Trường tiểu học)
// 3 nhóm chức năng: Điểm danh • Vi phạm • Hoạt động lớp
// ============================================================================

// --- Helper: Format date 'YYYY-MM-DD' (chuẩn input <type="date">)
function _qlclFmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.substring(0, 10);
  try {
    return Utilities.formatDate(new Date(d), Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
  } catch (e) { return ''; }
}

// --- 1. ĐIỂM DANH HÀNG NGÀY ---------------------------------------------------
// Lấy điểm danh trong 1 khoảng ngày, mặc định 7 ngày gần nhất nếu không truyền
function _qlclGetDiemDanh(namHoc, lop, tuNgay, denNgay) {
  const all = _qlclReadAll(SHEET_QLCL_DIEMDANH).rows;
  const filtered = all.filter(r => {
    if (String(r.NamHoc) !== String(namHoc)) return false;
    if (lop && String(r.Lop) !== String(lop)) return false;
    const ngay = _qlclFmtDate(r.Ngay);
    if (tuNgay && ngay < tuNgay) return false;
    if (denNgay && ngay > denNgay) return false;
    return true;
  }).map(r => ({
    namHoc: r.NamHoc, lop: r.Lop, ngay: _qlclFmtDate(r.Ngay),
    maHS: r.MaHS, hoTen: r.HoTen, trangThai: r.TrangThai || 'P',
    ghiChu: r.GhiChu || '', gvcn: r.GVCN || ''
  }));
  // Thống kê nhanh: theo trạng thái
  const stats = { P: 0, K: 0, KP: 0, M: 0 };
  filtered.forEach(r => { if (stats[r.trangThai] != null) stats[r.trangThai]++; });
  return { ok: true, data: { rows: filtered, stats: stats } };
}

// Lưu điểm danh: nhận body.rows[] = {ngay, maHS, hoTen, trangThai, ghiChu}
// Logic: xoá toàn bộ điểm danh của (namHoc + lop + ngày) rồi ghi lại
function _qlclSaveDiemDanh(body) {
  const namHoc = body.namHoc, lop = body.lop, ngay = body.ngay;
  const gvcn = body.gvcn || 'unknown';
  if (!namHoc || !lop || !ngay) return { ok: false, error: 'Thiếu namHoc / lop / ngay' };

  const sh = _qlclSheet(SHEET_QLCL_DIEMDANH);
  const all = _qlclReadAll(SHEET_QLCL_DIEMDANH).rows;
  // Giữ lại các dòng KHÔNG thuộc (namHoc+lop+ngay)
  const ngayStr = _qlclFmtDate(ngay);
  const keepOther = all.filter(r => !(
    String(r.NamHoc) === String(namHoc) &&
    String(r.Lop) === String(lop) &&
    _qlclFmtDate(r.Ngay) === ngayStr
  ));
  // Xoá toàn bộ data + ghi lại
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 9).clearContent();
  const now = new Date();
  const rowsOut = keepOther.map(r => [r.NamHoc, r.Lop, r.Ngay, r.MaHS, r.HoTen, r.TrangThai, r.GhiChu, r.GVCN, r.CapNhat])
    .concat((body.rows || []).map(r => [namHoc, lop, ngayStr, r.maHS, r.hoTen, r.trangThai || 'P', r.ghiChu || '', gvcn, now]));
  if (rowsOut.length) sh.getRange(2, 1, rowsOut.length, 9).setValues(rowsOut);
  _qlclAudit(gvcn, 'GVCN', 'saveDiemDanh', namHoc + '|' + lop + '|' + ngayStr, null, '+' + (body.rows || []).length + ' HS', '');
  return { ok: true, data: { saved: (body.rows || []).length, total: rowsOut.length } };
}

// --- 2. VI PHẠM NỀ NẾP --------------------------------------------------------
function _qlclGetViPham(namHoc, lop) {
  const all = _qlclReadAll(SHEET_QLCL_VIPHAM).rows;
  const filtered = all.filter(r => {
    if (String(r.NamHoc) !== String(namHoc)) return false;
    if (lop && String(r.Lop) !== String(lop)) return false;
    return true;
  }).map((r, idx) => ({
    rowIdx: idx,  // index trong filtered, không phải sheet (frontend dùng để xác định dòng cần xoá)
    namHoc: r.NamHoc, lop: r.Lop, ngay: _qlclFmtDate(r.Ngay),
    maHS: r.MaHS, hoTen: r.HoTen, loaiViPham: r.LoaiViPham || '',
    mucDo: r.MucDo || 'Nhe', moTa: r.MoTa || '', xuLy: r.XuLy || '',
    gvcn: r.GVCN || ''
  })).sort((a, b) => (b.ngay || '').localeCompare(a.ngay || ''));
  // Thống kê
  const stats = { Nhe: 0, Nang: 0, total: filtered.length };
  filtered.forEach(r => { if (stats[r.mucDo] != null) stats[r.mucDo]++; });
  return { ok: true, data: { rows: filtered, stats: stats } };
}

// Append 1 vi phạm mới
function _qlclSaveViPham(body) {
  const r = body.row || {};
  if (!body.namHoc || !body.lop || !r.maHS || !r.ngay) {
    return { ok: false, error: 'Thiếu namHoc / lop / maHS / ngay' };
  }
  const sh = _qlclSheet(SHEET_QLCL_VIPHAM);
  const gvcn = body.gvcn || 'unknown';
  sh.appendRow([body.namHoc, body.lop, _qlclFmtDate(r.ngay), r.maHS, r.hoTen || '',
                r.loaiViPham || '', r.mucDo || 'Nhe', r.moTa || '', r.xuLy || '', gvcn, new Date()]);
  _qlclAudit(gvcn, 'GVCN', 'addViPham', body.namHoc + '|' + body.lop + '|' + r.maHS, null, r.loaiViPham + '/' + r.mucDo, r.moTa);
  return { ok: true, data: { added: 1 } };
}

// Xoá theo (namHoc, lop, ngay, maHS, moTa) — match đầy đủ để tránh xoá nhầm
function _qlclDeleteViPham(body) {
  const sh = _qlclSheet(SHEET_QLCL_VIPHAM);
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, data: { deleted: 0 } };
  const r = body.row || {};
  const ngayStr = _qlclFmtDate(r.ngay);
  let deleted = 0;
  // Duyệt từ dưới lên để xoá an toàn
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    if (String(row[0]) === String(body.namHoc) &&
        String(row[1]) === String(body.lop) &&
        _qlclFmtDate(row[2]) === ngayStr &&
        String(row[3]) === String(r.maHS) &&
        String(row[7]) === String(r.moTa || '')) {
      sh.deleteRow(i + 1);
      deleted++;
    }
  }
  _qlclAudit(body.gvcn || 'unknown', 'GVCN', 'deleteViPham', body.namHoc + '|' + body.lop + '|' + r.maHS, r.moTa, null, '');
  return { ok: true, data: { deleted: deleted } };
}

// --- 3. HOẠT ĐỘNG LỚP / SINH HOẠT --------------------------------------------
function _qlclGetHoatDong(namHoc, lop) {
  const all = _qlclReadAll(SHEET_QLCL_HOATDONG).rows;
  const filtered = all.filter(r => {
    if (String(r.NamHoc) !== String(namHoc)) return false;
    if (lop && String(r.Lop) !== String(lop)) return false;
    return true;
  }).map((r, idx) => ({
    rowIdx: idx,
    namHoc: r.NamHoc, lop: r.Lop, ngay: _qlclFmtDate(r.Ngay),
    loai: r.Loai || 'SinhHoat', chuDe: r.ChuDe || '',
    noiDung: r.NoiDung || '', ketLuan: r.KetLuan || '',
    soHSThamGia: r.SoHSThamGia || '', gvcn: r.GVCN || ''
  })).sort((a, b) => (b.ngay || '').localeCompare(a.ngay || ''));
  // Thống kê theo loại
  const stats = { SinhHoat: 0, NgoaiKhoa: 0, ChaoCo: 0, Khac: 0, total: filtered.length };
  filtered.forEach(r => { if (stats[r.loai] != null) stats[r.loai]++; });
  return { ok: true, data: { rows: filtered, stats: stats } };
}

function _qlclSaveHoatDong(body) {
  const r = body.row || {};
  if (!body.namHoc || !body.lop || !r.ngay) {
    return { ok: false, error: 'Thiếu namHoc / lop / ngay' };
  }
  const sh = _qlclSheet(SHEET_QLCL_HOATDONG);
  const gvcn = body.gvcn || 'unknown';
  sh.appendRow([body.namHoc, body.lop, _qlclFmtDate(r.ngay), r.loai || 'SinhHoat',
                r.chuDe || '', r.noiDung || '', r.ketLuan || '', r.soHSThamGia || '', gvcn, new Date()]);
  _qlclAudit(gvcn, 'GVCN', 'addHoatDong', body.namHoc + '|' + body.lop, null, r.loai + ': ' + r.chuDe, r.noiDung);
  return { ok: true, data: { added: 1 } };
}

function _qlclDeleteHoatDong(body) {
  const sh = _qlclSheet(SHEET_QLCL_HOATDONG);
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, data: { deleted: 0 } };
  const r = body.row || {};
  const ngayStr = _qlclFmtDate(r.ngay);
  let deleted = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    if (String(row[0]) === String(body.namHoc) &&
        String(row[1]) === String(body.lop) &&
        _qlclFmtDate(row[2]) === ngayStr &&
        String(row[3]) === String(r.loai) &&
        String(row[4]) === String(r.chuDe || '')) {
      sh.deleteRow(i + 1);
      deleted++;
    }
  }
  _qlclAudit(body.gvcn || 'unknown', 'GVCN', 'deleteHoatDong', body.namHoc + '|' + body.lop, r.chuDe, null, '');
  return { ok: true, data: { deleted: deleted } };
}

// --- 4. TỔNG HỢP SỔ CHỦ NHIỆM (cho dashboard lớp) -----------------------------
// Trả về số liệu nhanh để hiển thị trên đầu Sổ chủ nhiệm
function _qlclChuNhiemSummary(namHoc, lop) {
  if (!namHoc || !lop) return { ok: false, error: 'Thiếu namHoc / lop' };
  // Điểm danh tháng này
  const today = new Date();
  const tuNgay = Utilities.formatDate(new Date(today.getFullYear(), today.getMonth(), 1),
                                      Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
  const denNgay = Utilities.formatDate(today, Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
  const dd = _qlclGetDiemDanh(namHoc, lop, tuNgay, denNgay).data;
  const vp = _qlclGetViPham(namHoc, lop).data;
  const hd = _qlclGetHoatDong(namHoc, lop).data;
  // Đếm HS có vi phạm trong tháng
  const vpThisMonth = vp.rows.filter(r => r.ngay >= tuNgay && r.ngay <= denNgay);
  const hdThisMonth = hd.rows.filter(r => r.ngay >= tuNgay && r.ngay <= denNgay);
  return { ok: true, data: {
    thang: today.getMonth() + 1,
    diemDanh: { ...dd.stats },
    viPham:   { thang: vpThisMonth.length, tongCong: vp.stats.total, nhe: vp.stats.Nhe, nang: vp.stats.Nang },
    hoatDong: { thang: hdThisMonth.length, tongCong: hd.stats.total }
  }};
}



// ============================================================================
// SECTION QLCL TEMPLATE (Wide Format) — adopted từ project QLCL_V3.0
// (May 2026) — backend chạy trên Sheet HSS (cùng Sheet với HSS+KĐCL).
// Data 9 tab Q_* (Config, Lop, CN, GK2, CK1, GK1, NhanXet, Users, HocSinh)
// được migrate từ Sheet THDienLien_05.2026 qua hàm migrateQlclFromExternal.
// ============================================================================

// Constants — namespace QLCL Template
// 2026-05-06: bỏ STUDENTS — QLCL không quản lý HS, dùng tab "DS HocSinh" của HSS
const _QT_SN = {
  USERS: 'Users', LOP: 'Lop', NHANXET: 'NhanXet',
  GK1: 'GK1', CK1: 'CK1', GK2: 'GK2', CN: 'CN'
};
const _QT_PERIOD_MAP = { gk1: 'GK1', ck1: 'CK1', gk2: 'GK2', cn: 'CN' };

// Helpers — prefix _qt để tránh xung đột global
function _qtSheet(name) {
  const ss = _getSS();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}
function _qtDiemSheet(period) {
  const name = _QT_PERIOD_MAP[period] || _QT_SN.CN;
  return _qtSheet(name);
}
function _qtToObjects(sh) {
  const d = sh.getDataRange().getValues();
  if (d.length < 2) return [];
  const h = d[0].map(String);
  const out = [];
  for (let i = 1; i < d.length; i++) {
    const o = {};
    for (let j = 0; j < h.length; j++) o[h[j]] = d[i][j];
    out.push(o);
  }
  return out;
}
function _qtFindRow(sh, key, value) {
  const d = sh.getDataRange().getValues();
  if (d.length < 1) return -1;
  const h = d[0].map(String);
  const col = h.indexOf(key);
  if (col < 0) return -1;
  const sv = String(value).trim();
  const svNum = sv.replace(/^0+/, '');
  for (let i = 1; i < d.length; i++) {
    const cv = String(d[i][col]).trim();
    if (cv === sv) return i + 1;
    if (key === 'ma' && /^d+$/.test(sv) && cv.replace(/^0+/, '') === svNum) return i + 1;
  }
  return -1;
}
function _qtEnsureHeaders(sh, requiredCols) {
  const d = sh.getDataRange().getValues();
  let h = d.length > 0 ? d[0].map(String) : [];
  if (h.length === 0) {
    h = requiredCols.slice();
    sh.getRange(1, 1, 1, h.length).setValues([h]);
    return h;
  }
  requiredCols.forEach(c => {
    if (h.indexOf(c) < 0) {
      h.push(c);
      sh.getRange(1, h.length).setValue(c);
    }
  });
  return h;
}


// ── Dispatcher ─────────────────────────────────────────────────────────────
// ⭐ 2026-05-07: Phân loại action QLCL Template theo yêu cầu auth.
//   • AUTH_REQUIRED: cần sessionToken hợp lệ (mọi action ghi + đọc dữ liệu HS nhạy cảm).
//   • ADMIN_ONLY:   chỉ role='admin' (HT/PHT) gọi được.
//   • Còn lại (getConfig public, createTemplate stub) — không cần session.
const _QLCL_TPL_AUTH_REQUIRED = [
  'saveGrade','saveGrades','autoSave','deleteGrade',
  'saveNhanXet','saveNhanXetBatch','saveLop',
  'saveUser','deleteUser','changePassword','syncUsersFromDSGV',
  'saveConfig','fixDiemSheet',
  // Đọc dữ liệu nhạy cảm cũng yêu cầu session để chống lộ điểm/nhận xét HS
  'getGrades','getNhanXet','getUsers','getLop'
];
const _QLCL_TPL_ADMIN_ONLY = [
  'saveLop','saveUser','deleteUser','syncUsersFromDSGV','saveConfig','fixDiemSheet'
];

function _qlclTplHandle(action, body) {
  try {
    body = body || {};
    // ⭐ BẢO MẬT 2026-05-07: yêu cầu sessionToken cho action nhạy cảm
    if (_QLCL_TPL_AUTH_REQUIRED.indexOf(action) >= 0) {
      const session = _qtVerifySession(body.sessionToken);
      if (!session) {
        return { ok: false, sessionExpired: true,
          error: '⏳ Phiên đăng nhập đã hết hoặc chưa đăng nhập. Vui lòng đăng nhập lại.' };
      }
      // Bind user thật từ session — KHÔNG tin field 'user' do client gửi
      body.user = session.username;
      body._sessionRole = session.role;
      // Action chỉ admin
      if (_QLCL_TPL_ADMIN_ONLY.indexOf(action) >= 0 && session.role !== 'admin') {
        return { ok: false, error: '⛔ Chức năng này chỉ dành cho Hiệu trưởng/Phó HT.' };
      }
    }

    switch (action) {
      case 'getGrades':         return _qtGetGrades(body.period || 'cn');
      case 'saveGrade':         return _withLock_(function(){ return _qtSaveGrade(body); });
      case 'saveGrades':        return _withLock_(function(){ return _qtSaveGrades(body); });
      case 'autoSave':          return _withLock_(function(){ return _qtAutoSave(body); });
      case 'deleteGrade':       return _withLock_(function(){ return _qtDeleteGrade(body); });
      case 'getNhanXet':        return _qtGetNhanXet();
      case 'saveNhanXet':       return _withLock_(function(){ return _qtSaveNhanXet(body); });
      case 'saveNhanXetBatch':  return _withLock_(function(){ return _qtSaveNhanXetBatch(body); });
      case 'getLop':            return _qtGetLop();
      case 'saveLop':           return _withLock_(function(){ return _qtSaveLop(body); });
      case 'getUsers':          return _qtGetUsers();
      case 'saveUser':          return _withLock_(function(){ return _qtSaveUser(body); });
      case 'deleteUser':        return _withLock_(function(){ return _qtDeleteUser(body.username, body); });
      case 'changePassword':    return _withLock_(function(){ return _qtChangePassword(body); });
      case 'syncUsersFromDSGV': return _withLock_(function(){ return _qtSyncUsersFromDSGV(body); });
      // 2026-05-06: action 'saveStudentsBatch' và 'deleteStudent' đã bỏ.
      //   QLCL không quản lý HS — chỉ HSS module mới có quyền CRUD HS.
      case 'getConfig':         return _qtGetConfig(body.key);
      case 'saveConfig':        return _withLock_(function(){ return _qtSaveConfig(body.key, body.value); });
      case 'createTemplate':    return _qtCreateSheetDanhGia(body.period, body.lop);
      case 'fixDiemSheet':      return _qtFixAllSheets();
      default:                  return { ok: false, error: 'Unknown QLCL TPL action: ' + action };
    }
  } catch (err) {
    return { ok: false, error: 'QLCL TPL error: ' + err.message };
  }
}

// ── Login — verify hash + tạo session token (refactor 2026-05-07) ──────────
//   • Backwards-compat: nếu password trong sheet còn plain-text → match plain
//     rồi TỰ ĐỘNG hash lại (lazy migration, không cần can thiệp thủ công).
//   • Trả sessionToken (32 hex chars, TTL 8h) — FE phải gửi kèm mọi request ghi.
function _qtDoLogin(username, password) {
  if (!username || !password) return { ok: false, error: 'Thiếu thông tin' };
  const sh = _qtSheet(_QT_SN.USERS);
  const allData = sh.getDataRange().getValues();
  if (allData.length < 2) return { ok: false, error: 'Tài khoản không tồn tại' };
  const h = allData[0].map(String);
  const uCol = h.indexOf('username');
  const pCol = h.indexOf('password');
  if (uCol < 0 || pCol < 0) return { ok: false, error: 'Cấu trúc Users sheet lỗi' };

  let rowIdx = -1, u = null;
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][uCol]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      rowIdx = i;
      u = {};
      h.forEach(function(col, j){ u[col] = allData[i][j]; });
      break;
    }
  }
  if (!u) {
    _auditLog('_AuditLog_QLCL', { action: 'login_fail', username: username, note: 'tài khoản không tồn tại' });
    return { ok: false, error: 'Tài khoản không tồn tại' };
  }

  const v = _qtVerifyPassword(u.password, password);
  if (!v.ok) {
    _auditLog('_AuditLog_QLCL', { action: 'login_fail', username: username, note: 'sai mật khẩu' });
    return { ok: false, error: 'Sai mật khẩu' };
  }

  // ⭐ Auto-upgrade plain → hash (lazy migration)
  if (v.needUpgrade) {
    try {
      const newHash = _qtHashPassword(password);
      sh.getRange(rowIdx + 1, pCol + 1).setValue(newHash);
      Logger.log('[AUTH] Đã tự động hash password cho: ' + username);
    } catch (e) {
      Logger.log('[AUTH] Lỗi khi upgrade hash: ' + e.message);
    }
  }

  const role = String(u.role || 'gv');
  const sessionToken = _qtCreateSession(username, role, {
    hoten: String(u.hoten || username),
    lop: String(u.lop_phu_trach || ''),
    phan_cong: String(u.phan_cong_giang_day || '')
  });

  _auditLog('_AuditLog_QLCL', {
    action: 'login_ok', username: username, role: role,
    note: v.needUpgrade ? 'đã upgrade password sang hash' : ''
  });

  return { ok: true, sessionToken: sessionToken, user: {
    username: String(u.username),
    hoten: String(u.hoten || u.username),
    role: role,
    lop: String(u.lop_phu_trach || ''),
    phan_cong: String(u.phan_cong_giang_day || '')
  }};
}

// ── ĐIỂM ─────────────────────────────────────────────────────────────────
function _qtGetGrades(period) {
  const sh = _qtDiemSheet(period);
  const d = sh.getDataRange().getValues();
  if (d.length < 2) return { ok: true, data: {} };
  const h = d[0].map(String);
  const maCol = h.indexOf('ma');
  if (maCol < 0) return { ok: true, data: {} };
  const result = {};
  for (let i = 1; i < d.length; i++) {
    const ma = String(d[i][maCol]);
    if (!ma || ma === '' || ma === 'undefined') continue;
    const obj = {};
    for (let j = 0; j < h.length; j++) {
      if (d[i][j] !== '' && d[i][j] !== null && d[i][j] !== undefined) {
        obj[h[j]] = String(d[i][j]);
      }
    }
    obj.ma = ma;
    result[ma] = obj;
  }
  return { ok: true, data: result };
}

function _qtSaveGrade(data) {
  const ma = String(data.ma || '');
  const gradeObj = data.grades || {};
  const user = data.user || '?';
  const period = data.period || 'cn';
  if (!ma) return { ok: false, error: 'Thiếu mã HS' };

  // ⭐ 2026-05-07: validate whitelist trước khi ghi
  const errs = [];
  Object.keys(gradeObj).forEach(function(k){
    if (k === 'ma') return;
    const e = _qlclValidGrade_(k, gradeObj[k]);
    if (e) errs.push(k + ' ' + e);
  });
  if (errs.length > 0) {
    return { ok: false, error: 'Dữ liệu không hợp lệ: ' + errs.slice(0, 3).join('; ') };
  }

  const sh = _qtDiemSheet(period);
  const h = _qtEnsureHeaders(sh, ['ma', '_user', '_timestamp']);

  Object.keys(gradeObj).forEach(k => {
    if (k !== 'ma' && h.indexOf(k) < 0) {
      h.push(k);
      sh.getRange(1, h.length).setValue(k);
    }
  });

  const maCol = h.indexOf('ma');
  const rowIdx = _qtFindRow(sh, 'ma', ma);

  if (rowIdx < 0) {
    const row = new Array(h.length).fill('');
    row[maCol] = ma;
    Object.keys(gradeObj).forEach(k => {
      const c = h.indexOf(k);
      if (c >= 0) row[c] = String(gradeObj[k]);
    });
    row[h.indexOf('_user')] = user;
    row[h.indexOf('_timestamp')] = new Date().toISOString();
    sh.appendRow(row);
  } else {
    Object.keys(gradeObj).forEach(k => {
      const c = h.indexOf(k);
      if (c >= 0 && k !== 'ma') sh.getRange(rowIdx, c + 1).setValue(String(gradeObj[k]));
    });
    const uc = h.indexOf('_user');
    if (uc >= 0) sh.getRange(rowIdx, uc + 1).setValue(user);
    const tc = h.indexOf('_timestamp');
    if (tc >= 0) sh.getRange(rowIdx, tc + 1).setValue(new Date().toISOString());
  }
  _auditLog('_AuditLog_QLCL', {
    action: 'saveGrade', username: user, role: data._sessionRole || '',
    target: 'ma=' + ma + ', period=' + period,
    note: Object.keys(gradeObj).length + ' field'
  });
  return { ok: true, message: 'Đã lưu: ' + ma + ' → ' + (_QT_PERIOD_MAP[period] || period) };
}

function _qtDeleteGrade(data) {
  const ma = String(data.ma || '');
  const period = data.period || 'cn';
  const user = data.user || '?';
  if (!ma) return { ok: false, error: 'Thiếu mã HS' };

  const sh = _qtDiemSheet(period);
  const allData = sh.getDataRange().getValues();
  if (allData.length <= 1) return { ok: true, message: 'Không có dữ liệu' };
  const h = allData[0].map(String);
  const maCol = h.indexOf('ma');
  if (maCol < 0) return { ok: false, error: 'Không tìm thấy cột ma' };

  for (let i = allData.length - 1; i >= 1; i--) {
    if (String(allData[i][maCol]).trim() === ma) {
      const before = allData[i].slice(0, Math.min(allData[i].length, 20));
      sh.deleteRow(i + 1);
      _auditLog('_AuditLog_QLCL', {
        action: 'deleteGrade', username: user, role: data._sessionRole || '',
        target: 'ma=' + ma + ', period=' + period, before: before
      });
      return { ok: true, message: 'Đã xóa KQ: ' + ma };
    }
  }
  return { ok: true, message: 'Không tìm thấy dữ liệu HS ' + ma };
}

function _qtSaveGrades(data) {
  const batch = data.grades_batch || [];
  const user = data.user || '?';
  const period = data.period || 'cn';
  if (!batch.length) return { ok: true, message: 'Không có dữ liệu', saved: 0 };
  return _qtBatchWrite(batch, user, period);
}

function _qtAutoSave(data) {
  const changes = data.changes || [];
  const user = data.user || '?';
  const period = data.period || 'cn';
  if (!changes.length) return { ok: true, message: 'Không có thay đổi', saved: 0 };
  const r = _qtBatchWrite(changes, user, period);
  return { ok: true, saved: r.saved || 0, total: changes.length, message: r.message };
}

function _qtBatchWrite(batch, user, period) {
  // ⭐ 2026-05-07: validate whitelist trước khi ghi (chống injection + nhập sai mức)
  //   Những bản ghi có cell sai → loại bỏ cell đó (không reject cả batch).
  //   Báo lại danh sách lỗi để FE highlight.
  const fieldErrors = [];
  batch = batch.filter(function(item){
    if (!item) return false;
    const ma = String(item.ma || '').trim();
    if (!ma) return false;
    const g = item.grades || item;
    const cleaned = {};
    Object.keys(g).forEach(function(k){
      if (k === 'ma') return;
      const err = _qlclValidGrade_(k, g[k]);
      if (err) {
        fieldErrors.push(ma + ':' + k + ' ' + err);
      } else {
        cleaned[k] = g[k];
      }
    });
    if (item.grades) item.grades = cleaned; else {
      Object.keys(g).forEach(function(k){ if (k !== 'ma' && !(k in cleaned)) delete item[k]; });
      Object.keys(cleaned).forEach(function(k){ item[k] = cleaned[k]; });
    }
    return true;
  });

  const sh = _qtDiemSheet(period);
  let allData = sh.getDataRange().getValues();
  let h = allData.length > 0 ? allData[0].map(String) : [];
  if (h.indexOf('ma') < 0) {
    h = ['ma'];
    sh.getRange(1, 1).setValue('ma');
    allData = [h];
  }
  if (h.indexOf('_user') < 0) { h.push('_user'); sh.getRange(1, h.length).setValue('_user'); }
  if (h.indexOf('_timestamp') < 0) { h.push('_timestamp'); sh.getRange(1, h.length).setValue('_timestamp'); }

  let needNewCols = false;
  batch.forEach(item => {
    const g = item.grades || item;
    Object.keys(g).forEach(k => {
      if (k !== 'ma' && h.indexOf(k) < 0) { h.push(k); needNewCols = true; }
    });
  });
  if (needNewCols) sh.getRange(1, 1, 1, h.length).setValues([h]);

  const maCol = h.indexOf('ma');
  const rowMap = {};
  for (let i = 1; i < allData.length; i++) {
    const strMa = String(allData[i][maCol]).trim();
    rowMap[strMa] = i;
    if (/^\d+$/.test(strMa)) rowMap[strMa.replace(/^0+/, '')] = i;
  }

  const ts = new Date().toISOString();
  const uc = h.indexOf('_user');
  const tc = h.indexOf('_timestamp');
  const newRows = [];
  let saved = 0;

  batch.forEach(item => {
    const ma = String(item.ma || '').trim();
    if (!ma) return;
    const g = item.grades || item;
    let idx = rowMap[ma];
    if (idx === undefined && /^\d+$/.test(ma)) idx = rowMap[ma.replace(/^0+/, '')];

    if (idx !== undefined) {
      const currentRow = sh.getRange(idx + 1, 1, 1, h.length).getValues()[0];
      while (currentRow.length < h.length) currentRow.push('');
      Object.keys(g).forEach(k => {
        const c = h.indexOf(k);
        if (c >= 0 && k !== 'ma') currentRow[c] = String(g[k]);
      });
      if (uc >= 0) currentRow[uc] = user;
      if (tc >= 0) currentRow[tc] = ts;
      sh.getRange(idx + 1, 1, 1, h.length).setValues([currentRow]);
    } else {
      const row = new Array(h.length).fill('');
      row[maCol] = ma;
      Object.keys(g).forEach(k => {
        const c = h.indexOf(k);
        if (c >= 0) row[c] = String(g[k]);
      });
      if (uc >= 0) row[uc] = user;
      if (tc >= 0) row[tc] = ts;
      newRows.push(row);
    }
    saved++;
  });

  if (newRows.length > 0) {
    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, newRows.length, h.length).setValues(newRows);
    sh.getRange(startRow, maCol + 1, newRows.length, 1).setNumberFormat('@');
  }

  // ⭐ Audit + báo errors lên FE
  _auditLog('_AuditLog_QLCL', {
    action: 'batchWrite', username: user, target: 'period=' + period,
    note: 'saved=' + saved + '/' + batch.length + (fieldErrors.length ? ', invalid=' + fieldErrors.length : '')
  });

  return {
    ok: true, saved: saved,
    errors: fieldErrors.slice(0, 20),
    message: 'Đã lưu ' + saved + '/' + batch.length + (fieldErrors.length ? ' (có ' + fieldErrors.length + ' giá trị sai bị bỏ qua)' : '')
  };
}

// ── HỌC SINH ─────────────────────────────────────────────────────────────
// 2026-05-06 REFACTOR: bỏ _qtSaveStudentsBatch và _qtDeleteStudent.
//   QLCL không CRUD HS nữa — chuyển hết về HSS module (action 'importStudents').
//   DSHS = tab "DS HocSinh" của HSS, là single source of truth.

// ── LỚP ──────────────────────────────────────────────────────────────────
function _qtGetLop() {
  const sh = _qtSheet(_QT_SN.LOP);
  return { ok: true, data: _qtToObjects(sh) };
}

function _qtSaveLop(data) {
  const maLop = data.ma_lop;
  const tenLop = data.ten_lop || '';
  const gvcn = data.gvcn || '';
  if (!maLop) return { ok: false, error: 'Thiếu mã lớp' };
  const sh = _qtSheet(_QT_SN.LOP);
  const h = _qtEnsureHeaders(sh, ['ma_lop','ten_lop','gvcn']);
  const row = _qtFindRow(sh, 'ma_lop', maLop);
  if (row < 0) {
    sh.appendRow([maLop, tenLop, gvcn]);
  } else {
    sh.getRange(row, h.indexOf('ten_lop') + 1).setValue(tenLop);
    sh.getRange(row, h.indexOf('gvcn') + 1).setValue(gvcn);
  }
  return { ok: true, message: 'Đã lưu lớp: ' + maLop };
}

// ── NHẬN XÉT ─────────────────────────────────────────────────────────────
function _qtGetNhanXet() {
  const sh = _qtSheet(_QT_SN.NHANXET);
  const d = sh.getDataRange().getValues();
  if (d.length < 2) return { ok: true, data: {} };
  const h = d[0].map(String);
  const maCol = h.indexOf('ma'), nxCol = h.indexOf('nhan_xet');
  if (maCol < 0 || nxCol < 0) return { ok: true, data: {} };
  const result = {};
  for (let i = 1; i < d.length; i++) {
    const ma = String(d[i][maCol]);
    if (ma) result[ma] = String(d[i][nxCol] || '');
  }
  return { ok: true, data: result };
}

function _qtSaveNhanXet(data) {
  const ma = String(data.ma || '');
  const nx = data.nhan_xet || '';
  const user = data.user || '?';
  if (!ma) return { ok: false, error: 'Thiếu mã HS' };
  const sh = _qtSheet(_QT_SN.NHANXET);
  const h = _qtEnsureHeaders(sh, ['ma','nhan_xet','_user','_timestamp']);
  const row = _qtFindRow(sh, 'ma', ma);
  if (row < 0) {
    sh.appendRow([ma, nx, user, new Date().toISOString()]);
  } else {
    sh.getRange(row, h.indexOf('nhan_xet') + 1).setValue(nx);
    if (h.indexOf('_user') >= 0) sh.getRange(row, h.indexOf('_user') + 1).setValue(user);
    if (h.indexOf('_timestamp') >= 0) sh.getRange(row, h.indexOf('_timestamp') + 1).setValue(new Date().toISOString());
  }
  return { ok: true, message: 'Đã lưu nhận xét' };
}

function _qtSaveNhanXetBatch(data) {
  const batch = data.batch || [], user = data.user || '?';
  let ok = 0;
  batch.forEach(item => {
    if (_qtSaveNhanXet({ ma: item.ma, nhan_xet: item.nhan_xet, user: user }).ok) ok++;
  });
  return { ok: true, message: 'Đã lưu ' + ok + ' nhận xét' };
}

// ── USERS (giữ nguyên template — bảng Users của QLCL với password plain-text) ──
// Lưu ý: bảng Users chỉ dùng cho QLCL workspace, KHÔNG liên quan AUTH_TOKEN
// của HSS/KĐCL. Để tăng an toàn, tương lai có thể hash password.
function _qtGetUsers() {
  const users = _qtToObjects(_qtSheet(_QT_SN.USERS));
  users.forEach(u => { delete u.password; });
  return { ok: true, data: users };
}

function _qtSaveUser(data) {
  const username = data.username;
  if (!username) return { ok: false, error: 'Thiếu username' };
  const sh = _qtSheet(_QT_SN.USERS);
  const h = _qtEnsureHeaders(sh, ['username','password','hoten','role','lop_phu_trach','phan_cong_giang_day']);
  const allData = sh.getDataRange().getValues();
  const uCol = h.indexOf('username');
  let rowIdx = -1;
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][uCol]).toLowerCase() === username.toLowerCase()) { rowIdx = i + 1; break; }
  }

  // ⭐ 2026-05-07: hash password trước khi ghi (nếu chưa có dạng salt$hash)
  const dataToWrite = Object.assign({}, data);
  let hadPasswordChange = false;
  if (data.password) {
    const ps = String(data.password);
    // Nếu admin paste sẵn salt$hash thì giữ; còn lại đều hash
    if (ps.indexOf('$') !== 16 || !/^[0-9a-f]{16}\$[0-9a-f]{64}$/i.test(ps)) {
      dataToWrite.password = _qtHashPassword(ps);
      hadPasswordChange = true;
    }
  }

  const row = new Array(h.length).fill('');
  h.forEach((col, idx) => {
    if (dataToWrite[col] !== undefined && dataToWrite[col] !== '') row[idx] = dataToWrite[col];
    else if (rowIdx > 0) row[idx] = allData[rowIdx - 1][idx];
  });
  const isNew = rowIdx < 0;
  if (isNew) {
    if (!data.password) return { ok: false, error: 'Cần mật khẩu' };
    sh.appendRow(row);
  } else {
    sh.getRange(rowIdx, 1, 1, row.length).setValues([row]);
  }

  _auditLog('_AuditLog_QLCL', {
    action: isNew ? 'createUser' : 'updateUser',
    username: data.user || '?',
    role: data._sessionRole || '?',
    target: username,
    note: hadPasswordChange ? 'có đổi password' : ''
  });

  return { ok: true, message: 'Đã lưu: ' + username };
}

function _qtDeleteUser(username, ctx) {
  if (!username) return { ok: false, error: 'Thiếu username' };
  const sh = _qtSheet(_QT_SN.USERS);
  const row = _qtFindRow(sh, 'username', username);
  if (row < 0) return { ok: false, error: 'Không tìm thấy' };
  sh.deleteRow(row);
  _auditLog('_AuditLog_QLCL', {
    action: 'deleteUser',
    username: (ctx && ctx.user) || '?',
    role: (ctx && ctx._sessionRole) || '?',
    target: username
  });
  return { ok: true, message: 'Đã xóa: ' + username };
}

function _qtChangePassword(data) {
  const username = data.username, oldPw = data.oldPassword, newPw = data.newPassword;
  if (!username || !oldPw || !newPw) return { ok: false, error: 'Thiếu thông tin' };
  if (newPw.length < 4) return { ok: false, error: 'Mật khẩu mới phải có ít nhất 4 ký tự' };

  // Chỉ đổi mật khẩu của chính mình (admin có thể đổi của bất kỳ ai)
  if (data._sessionRole !== 'admin' && data.user && data.user.toLowerCase() !== username.toLowerCase()) {
    return { ok: false, error: '⛔ Không thể đổi mật khẩu của tài khoản khác.' };
  }

  const sh = _qtSheet(_QT_SN.USERS);
  const allData = sh.getDataRange().getValues();
  const h = allData[0].map(String);
  const uCol = h.indexOf('username'), pCol = h.indexOf('password');
  if (uCol < 0 || pCol < 0) return { ok: false, error: 'Cấu trúc sheet Users lỗi' };
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][uCol]).trim().toLowerCase() === username.trim().toLowerCase()) {
      const verify = _qtVerifyPassword(allData[i][pCol], oldPw);
      if (!verify.ok) return { ok: false, error: 'Mật khẩu hiện tại không đúng' };
      const newHash = _qtHashPassword(newPw);
      sh.getRange(i + 1, pCol + 1).setValue(newHash);
      _auditLog('_AuditLog_QLCL', {
        action: 'changePassword',
        username: data.user || username,
        role: data._sessionRole || '?',
        target: username
      });
      return { ok: true, message: 'Đổi mật khẩu thành công' };
    }
  }
  return { ok: false, error: 'Không tìm thấy tài khoản' };
}

// ── ĐỒNG BỘ USERS TỪ DSGV (HSS) ────────────────────────────────────────
// 2026-05-07: cho phép admin tạo nhanh tài khoản QLCL từ DSGV của HSS,
//   tránh phải nhập tay từng GV. Mass deploy trường mới chỉ cần:
//   1. Nhập DSGV vào HSS Admin
//   2. Vào QLCL → Phân quyền CBGV → click "Đồng bộ từ DSGV"
function _qtSyncUsersFromDSGV(ctx){
  try {
    var teachers = getTeachers();  // Hàm đã có sẵn trong HSS
    if (!teachers || !teachers.length) {
      return { ok: false, error: 'DSGV trống. Vui lòng vào Hồ sơ số → Admin → Nhập DSGV trước.' };
    }
    var sh = _qtSheet(_QT_SN.USERS);
    var h = _qtEnsureHeaders(sh, ['username','password','hoten','role','lop_phu_trach','phan_cong_giang_day']);
    var existing = _qtToObjects(sh);
    var existingUsernames = {};
    existing.forEach(function(u){
      if (u.username) existingUsernames[String(u.username).toLowerCase()] = true;
    });

    var defaultPlain = 'ChangeMe@2026';
    var defaultHash = _qtHashPassword(defaultPlain);
    var created = [], skipped = [];

    teachers.forEach(function(t){
      if (!t.name) return;
      var username = _genUsername_(t);
      if (!username || username.length < 3) {
        skipped.push({ name: t.name, reason: 'không tạo được username (thiếu tên + email)' });
        return;
      }
      if (existingUsernames[username.toLowerCase()]) {
        skipped.push({ name: t.name, username: username, reason: 'username đã tồn tại' });
        return;
      }
      var info = _parseGVRole_(t.role);
      sh.appendRow([username, defaultHash, t.name, info.role, info.lop, '']);
      existingUsernames[username.toLowerCase()] = true;
      created.push({
        username: username, hoten: t.name, role: info.role, lop: info.lop, chucVu: t.role || ''
      });
    });

    _auditLog('_AuditLog_QLCL', {
      action: 'syncUsersFromDSGV',
      username: (ctx && ctx.user) || '?',
      role: (ctx && ctx._sessionRole) || '?',
      target: 'DSGV (' + teachers.length + ' GV)',
      note: 'created=' + created.length + ', skipped=' + skipped.length
    });

    return {
      ok: true,
      total: teachers.length,
      created: created,
      skipped: skipped,
      defaultPassword: defaultPlain,
      message: 'Đã tạo ' + created.length + '/' + teachers.length + ' tài khoản'
    };
  } catch (e) {
    return { ok: false, error: 'Lỗi đồng bộ: ' + e.message };
  }
}

// ── CONFIG ─────────────────────────────────────────────────────────────
function _qtConfigSheet() {
  const ss = _getSS();
  let sh = ss.getSheetByName('Config');
  if (!sh) {
    sh = ss.insertSheet('Config');
    sh.getRange(1, 1, 1, 2).setValues([['key','value']]);
  }
  return sh;
}

function _qtSaveConfig(key, value) {
  if (!key) return { ok: false, error: 'Thiếu key' };
  const sh = _qtConfigSheet();
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return { ok: true };
    }
  }
  sh.appendRow([key, value]);
  return { ok: true };
}

function _qtGetConfig(key) {
  if (!key) return { ok: false, error: 'Thiếu key' };
  const sh = _qtConfigSheet();
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) return { ok: true, value: String(data[i][1]) };
  }
  return { ok: true, value: null };
}

function _qtFixAllSheets() {
  const added = [];
  Object.keys(_QT_PERIOD_MAP).forEach(pid => {
    const sh = _qtSheet(_QT_PERIOD_MAP[pid]);
    const data = sh.getDataRange().getValues();
    const h = data.length > 0 ? data[0].map(String) : [];
    ['ma','_user','_timestamp'].forEach(c => {
      if (h.indexOf(c) < 0) {
        h.push(c);
        sh.getRange(1, h.length).setValue(c);
        added.push(_QT_PERIOD_MAP[pid] + ':' + c);
      }
    });
  });
  return { ok: true, message: added.length ? 'Đã thêm: ' + added.join(', ') : 'Tất cả OK' };
}

// ── CREATE TEMPLATE — stub (em đã sửa _renderHocBa1HS trong qlcl-app.js theo TT 27)
function _qtCreateSheetDanhGia(period, lop) {
  return { ok: false, error: 'createSheetDanhGia: dùng FE createMauChuan trong qlcl-app.js (đã có)' };
}

// ============================================================================
// MIGRATION — Copy 9 tab QLCL từ Sheet ngoài (THDienLien_05.2026) sang Sheet
// HSS hiện tại. Chạy 1 lần khi gộp 2 Sheet thành 1.
// ============================================================================
/**
 * Cách chạy: Apps Script editor → chọn migrateQlclFromExternal → ▶ Run.
 * Hệ thống sẽ prompt nhập Sheet ID nguồn (lấy từ URL Sheet THDienLien_05.2026).
 *
 * Sheet ID lấy từ URL: https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
 *
 * Script copy 9 tab: Config, Lop, CN, GK2, CK1, GK1, NhanXet, Users, HocSinh
 * Nếu tab đã tồn tại trên Sheet đích → skip (không ghi đè).
 */
function migrateQlclFromExternal() {
  const ui = SpreadsheetApp.getUi();
  let sourceSheetId = '';
  try {
    const r = ui.prompt(
      'Migrate QLCL từ Sheet ngoài',
      'Paste Sheet ID của Sheet QLCL nguồn (THDienLien_05.2026):\n\nLấy từ URL: docs.google.com/spreadsheets/d/<ID>/edit',
      ui.ButtonSet.OK_CANCEL
    );
    if (r.getSelectedButton() !== ui.Button.OK) {
      Logger.log('User huỷ.');
      return { ok: false, error: 'User cancelled' };
    }
    sourceSheetId = r.getResponseText().trim();
  } catch(e) {
    // Nếu không có UI (chạy headless), dùng PropertiesService
    sourceSheetId = PropertiesService.getScriptProperties().getProperty('QLCL_SOURCE_SHEET_ID') || '';
    if (!sourceSheetId) {
      Logger.log('❌ Không có UI và không có Script Property QLCL_SOURCE_SHEET_ID.');
      return { ok: false, error: 'Cần Sheet ID' };
    }
  }

  if (!sourceSheetId) {
    Logger.log('❌ Sheet ID rỗng.');
    return { ok: false, error: 'Sheet ID rỗng' };
  }

  Logger.log('============================================================');
  Logger.log('🚀 MIGRATE QLCL từ Sheet ngoài: ' + sourceSheetId);
  Logger.log('============================================================');

  let sourceSS;
  try {
    sourceSS = SpreadsheetApp.openById(sourceSheetId);
  } catch(e) {
    Logger.log('❌ Không mở được Sheet nguồn: ' + e.message);
    return { ok: false, error: 'Không mở được Sheet: ' + e.message };
  }

  const targetSS = _getSS();
  // 2026-05-06: bỏ 'HocSinh' khỏi migration — QLCL dùng tab "DS HocSinh" của HSS
  const tabsToCopy = ['Config', 'Lop', 'CN', 'GK2', 'CK1', 'GK1', 'NhanXet', 'Users'];

  const result = { copied: [], skipped: [], errors: [] };
  tabsToCopy.forEach(name => {
    try {
      const sourceSh = sourceSS.getSheetByName(name);
      if (!sourceSh) {
        Logger.log('⚠ Sheet ' + name + ' không tồn tại ở nguồn → skip');
        result.skipped.push(name + ' (no source)');
        return;
      }
      const existing = targetSS.getSheetByName(name);
      if (existing) {
        Logger.log('⚠ Sheet ' + name + ' đã tồn tại ở đích → skip (KHÔNG ghi đè)');
        result.skipped.push(name + ' (target exists)');
        return;
      }
      // Copy sheet sang target
      const copied = sourceSh.copyTo(targetSS);
      copied.setName(name);
      Logger.log('✅ Đã copy ' + name + ' (' + copied.getLastRow() + ' dòng)');
      result.copied.push(name + ' (' + copied.getLastRow() + ' dòng)');
    } catch(e) {
      Logger.log('❌ Lỗi copy ' + name + ': ' + e.message);
      result.errors.push(name + ': ' + e.message);
    }
  });

  Logger.log('');
  Logger.log('============================================================');
  Logger.log('🎉 MIGRATION HOÀN TẤT');
  Logger.log('   Đã copy: ' + result.copied.length + ' tab');
  result.copied.forEach(c => Logger.log('     ✅ ' + c));
  if (result.skipped.length) {
    Logger.log('   Skip: ' + result.skipped.length + ' tab');
    result.skipped.forEach(s => Logger.log('     ⚠ ' + s));
  }
  if (result.errors.length) {
    Logger.log('   Lỗi: ' + result.errors.length);
    result.errors.forEach(e => Logger.log('     ❌ ' + e));
  }
  Logger.log('============================================================');

  return { ok: true, data: result };
}

// ═══════ END SECTION QLCL TEMPLATE ═══════

// ════════════════════════════════════════════════════════════════════
// SECTION: MOET SYNC — đồng bộ kết quả lên CSDL ngành
// (merge từ APPS_SCRIPT_ENDPOINT.gs, 2026-05-08)
// Action: getKetQuaMOET — đã dispatch trong doGet ở trên.
// Dùng bởi: hss-sync-extension (background.js → fetch Apps Script)
// ════════════════════════════════════════════════════════════════════

/**
 * Lấy dữ liệu học sinh + kết quả đánh giá theo format MOET Excel.
 * Trả về mảng đúng thứ tự cột để tạo file import CSDL ngành.
 *
 * @param {string} khoi  '1'..'5' hoặc rỗng (tất cả)
 * @param {string} ky    'gk1' | 'ck1' | 'gk2' | 'cn'
 * @param {string} lop   mã lớp cụ thể hoặc 'all'/rỗng
 */
function getKetQuaMOET(khoi, ky, lop) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ─── 1. Lấy danh sách học sinh ─────────────────────────────────────
  const sheetHS = ss.getSheetByName('HocSinh') || ss.getSheetByName('DSHS');
  if (!sheetHS) {
    return { success: false, message: 'Không tìm thấy sheet HocSinh / DSHS' };
  }

  const hsData = sheetHS.getDataRange().getValues();
  const hsHeaders = hsData[0].map(h => String(h).trim());

  const idx = {
    maHS:     _moetFindIdx(hsHeaders, ['maHS', 'Mã HS', 'MaHS', 'studentId', 'ma_hs']),
    maLop:    _moetFindIdx(hsHeaders, ['maLop', 'Lớp', 'lop', 'class', 'ma_lop']),
    hoTen:    _moetFindIdx(hsHeaders, ['hoTen', 'Họ tên', 'hoten', 'name', 'ho_ten']),
    ngaySinh: _moetFindIdx(hsHeaders, ['ngaySinh', 'Ngày sinh', 'ngaysinh', 'dob']),
    khoi:     _moetFindIdx(hsHeaders, ['khoi', 'Khối', 'grade'])
  };

  // ─── 2. Lấy dữ liệu kết quả theo kỳ ────────────────────────────────
  const kySheetNames = [
    'Grades_' + ky,
    'KetQua_' + ky,
    'KQGD_' + ky,
    String(ky).toUpperCase()
  ];
  let sheetKQ = null;
  for (const name of kySheetNames) {
    sheetKQ = ss.getSheetByName(name);
    if (sheetKQ) break;
  }
  if (!sheetKQ) {
    const allSheets = ss.getSheets().map(s => s.getName());
    return {
      success: false,
      message:
        'Không tìm thấy sheet kết quả kỳ "' + ky +
        '". Các sheet hiện có: ' + allSheets.join(', ')
    };
  }

  const kqData = sheetKQ.getDataRange().getValues();
  const kqHeaders = kqData[0].map(h => String(h).trim());
  const kqIdxMaHS  = _moetFindIdx(kqHeaders, ['maHS', 'studentId', 'ma_hs']);
  const kqIdxHoTen = _moetFindIdx(kqHeaders, ['hoTen', 'hoten', 'name']);

  // ─── 3. Join và xuất dữ liệu ───────────────────────────────────────
  const khoiFilter = khoi ? parseInt(khoi, 10) : null;
  const result = [];
  let stt = 0;

  for (let i = 1; i < hsData.length; i++) {
    const hs = hsData[i];
    const hsKhoi = idx.khoi >= 0 ? parseInt(hs[idx.khoi], 10) : null;
    const hsLop  = idx.maLop >= 0 ? String(hs[idx.maLop]).trim() : '';

    if (khoiFilter && hsKhoi !== khoiFilter) continue;
    if (lop && lop !== 'all' && hsLop !== lop) continue;

    const hsId  = idx.maHS >= 0 ? String(hs[idx.maHS]).trim() : '';
    const hoTen = idx.hoTen >= 0 ? String(hs[idx.hoTen]).trim() : '';

    let ngaySinh = '';
    if (idx.ngaySinh >= 0 && hs[idx.ngaySinh]) {
      const d = new Date(hs[idx.ngaySinh]);
      if (!isNaN(d)) {
        ngaySinh = Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy');
      } else {
        ngaySinh = String(hs[idx.ngaySinh]);
      }
    }

    const kqRow = kqData.find((row, ri) => {
      if (ri === 0) return false;
      const rowId  = String(kqIdxMaHS  >= 0 ? row[kqIdxMaHS]  : '').trim();
      const rowTen = String(kqIdxHoTen >= 0 ? row[kqIdxHoTen] : '').trim();
      return (hsId && rowId === hsId) ||
             (hoTen && _moetNormVN(rowTen) === _moetNormVN(hoTen));
    });

    const grades = {};
    if (kqRow) {
      kqHeaders.forEach((col, ci) => {
        if (col && ci > 0) grades[col] = kqRow[ci] || '';
      });
    }

    stt++;
    result.push({
      stt: stt,
      maLop: hsLop,
      maHS: hsId,
      hoTen: hoTen,
      ngaySinh: ngaySinh,
      grades: grades
    });
  }

  return {
    success: true,
    khoi: khoi,
    ky: ky,
    count: result.length,
    data: result
  };
}

/** Tìm index cột theo nhiều tên có thể (helper riêng cho MOET sync) */
function _moetFindIdx(headers, names) {
  for (const name of names) {
    const i = headers.findIndex(h =>
      String(h).toLowerCase().replace(/\s/g, '') ===
      String(name).toLowerCase().replace(/\s/g, '')
    );
    if (i >= 0) return i;
  }
  return -1;
}

/** Chuẩn hóa tên để so sánh (helper riêng cho MOET sync) */
function _moetNormVN(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ═══════ END SECTION MOET SYNC ═══════
