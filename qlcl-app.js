/*
============================================================================
 qlcl-app.js — Logic Quản lý Chất lượng Giáo dục Tiểu học
============================================================================
 Tách từ template QLCL của Chung Trần (May 2026) → 3 file FE riêng để host
 cùng repo với hệ thống Hồ sơ số TH Diễn Liên (Phương án D-2: 2 backend
 song song).

 BACKEND độc lập:
   • Apps Script project: QLCL_V3.0
   • Bound với Sheet: THDienLien_05.2026
   • API_URL: được khai báo inline trong qlcl.html

 KHÔNG dùng chung backend với index.html (HSS + KĐCL). Lý do: data 3 tháng
 đã sẵn ở Sheet THDienLien_05.2026 với schema wide format, không cần migrate.

 Auth bridge: đọc localStorage 'th_auth_v1' do index.html set khi user click
 nút "QL Chất lượng" — cho phép qlcl.html biết user là HT/GV để filter
 quyền lớp. KHÔNG bypass doLogin của template — vẫn cần GV nhập user/pass
 (theo bảng Users của Sheet QLCL).
============================================================================
*/

// ═══ AUTH BRIDGE từ index.html ═══
// Khi user click "QL Chất lượng" ở index.html, app.js set localStorage.th_auth_v1
// Ở đây em đọc lại để hiển thị thông tin user trong sidebar QLCL (KHÔNG thay
// thế login template — login vẫn dùng bảng Users của Sheet QLCL).
(function() {
  try {
    var bridge = JSON.parse(localStorage.getItem('th_auth_v1') || 'null');
    if (bridge && bridge.user) {
      window._authBridgeFromHSS = bridge;
      // Có thể dùng để hiển thị "Đến từ Hồ sơ số: <user>" trong sidebar QLCL
    }
  } catch(e) {}
})();


// ┌──────────────────────────────────────────────────────────┐
// │  CẤU HÌNH — V2.0                                        │
// └──────────────────────────────────────────────────────────┘
var APP_VERSION='3.2';
// ★★★ URL Web App HSS (dùng chung với index.html — 1 Sheet, 1 Apps Script) ★★★
var DEFAULT_GAS = 'https://script.google.com/macros/s/AKfycbxS-M_WE3zkT7gR5kIuyka1DOOpGfgPCJInnpplpsik_RRfBQ6ULUDA9l8xlTVNgU_y/exec';

// 2026-05-07: DSHS không còn inline — fetch real-time từ HSS qua action 'students'.
//   Single source of truth = Sheet "DS HocSinh" (HSS module).
//   Cache localStorage 5 phút để giảm load. Xem loadDSHSFromHSS() bên dưới.
var SB = [];
// Backwards-compat: nếu phiên bản qlcl.html chưa được cập nhật và còn block _d_sb,
// dùng làm fallback ban đầu (sau đó sẽ bị API ghi đè khi load xong).
try {
  var _legacy = document.getElementById('_d_sb');
  if (_legacy && _legacy.textContent) {
    SB = JSON.parse(_legacy.textContent);
  }
} catch (e) { SB = []; }

// ═══ PHÂN QUYỀN DỮ LIỆU ═══
// mySB() = danh sách HS user được phép truy cập
// Admin: toàn bộ. GV: chỉ lớp được phân công
function mySB(){
  if(!CU) return SB;
  if(CU.role==='admin') return SB;
  // GV: lọc theo lớp phụ trách + lớp trong phân công
  var myClasses=_myClasses();
  if(!myClasses.length) return SB; // Fallback nếu chưa có phân công
  return SB.filter(function(s){return myClasses.indexOf(s.lop)>=0;});
}
// Danh sách lớp user được truy cập
function _myClasses(){
  if(!CU||CU.role==='admin') return null; // null = tất cả
  var cls=[];
  // Lớp phụ trách (GVCN)
  if(CU.lop&&CU.lop.trim()) cls.push(CU.lop.trim());
  // Lớp trong phân công giảng dạy
  if(userPerm){
    Object.keys(userPerm).forEach(function(lop){if(cls.indexOf(lop)<0)cls.push(lop);});
  }
  return cls;
}
// Kiểm tra quyền truy cập 1 HS
function canAccessStudent(s){
  if(!CU||CU.role==='admin') return true;
  var cls=_myClasses();
  if(!cls||!cls.length) return true;
  return cls.indexOf(s.lop)>=0;
}
// Dropdown chỉ hiện lớp được phân công
function myBldLop(id,khoi){
  var el=T(id);if(!el)return;
  var cls=_myClasses();
  var o='<option value="">Tất cả lớp</option>';
  var ks=khoi?[parseInt(khoi)]:[1,2,3,4,5];
  ks.forEach(function(k){['A','B','C','D','E'].forEach(function(c){
    var lop=k+c;
    if(cls&&cls.indexOf(lop)<0) return; // Bỏ qua lớp không phân công
    o+='<option value="'+lop+'">Lớp '+lop+'</option>';
  });});
  el.innerHTML=o;
  // Nếu GV chỉ có 1 lớp, tự chọn luôn
  if(cls&&cls.length===1){el.value=cls[0];}
}
var SUBJ = JSON.parse(document.getElementById('_d_subj').textContent);
var NL   = JSON.parse(document.getElementById('_d_nl').textContent);
var PC   = JSON.parse(document.getElementById('_d_pc').textContent);

// STATE
var GAS='',CU=null,grades={},allS=[],hsF=[],dF=[];
var hsP=1,dP=1,curK=1,tkKF=0,eIdx=null,ch1=null,ch2=null;
var userPerm=null,importData=[],allUsers=[];
var _dt={},PZ=30;
// V2.0 state
var nhanXet={},hbIdx=null,hbFiltered=[];

// ═══ AUTO-SAVE STATE ═══
var _dirtyGrades={};    // {ma: gradeObj} — các HS đã thay đổi chưa lưu lên Sheets
var _autoSaveTimer=null;
var _autoSaveInterval=45000; // 45 giây
var _autoSaving=false;
// PHASE 2: Period support
var PERIODS=[
  {id:'gk1',name:'Giữa HK1',short:'GHK1',color:'#1565c0'},
  {id:'ck1',name:'Cuối HK1',short:'CHK1',color:'#00695c'},
  {id:'gk2',name:'Giữa HK2',short:'GHK2',color:'#e65100'},
  {id:'cn',name:'Cuối năm',short:'CN',color:'#0d9488'}
];
var curPeriod='gk2'; // Default = Giữa HK2
var allGrades={}; // {period: {ma: gradeObj}}
var lockedPeriods={}; // {gk1:true, ck1:true, ...} — Admin khóa kỳ

var NL_CHUNG_IDX=3; // 3 NL đầu là NL chung, còn lại là NL đặc thù

// ═══ NL ĐẶC THÙ THEO KHỐI (TT27 + CT GDPT 2018 - TT 32/2018) ═══
// K1-2: 5 NL đặc thù (Ngôn ngữ, Tính toán, Khoa học, Thẩm mĩ, Thể chất)
// K3-5: 7 NL đặc thù (+Công nghệ, +Tin học) — môn Tin học là môn BẮT BUỘC từ lớp 3
//       theo CT GDPT 2018 → NL đặc thù Tin học áp dụng từ K3.
function _getNLDacThu(khoi){
  var base=NL.slice(NL_CHUNG_IDX).map(function(x){return[x[0],x[1]];});
  // base = [Ngôn ngữ, Tính toán, Khoa học, Thẩm mĩ, Thể chất]
  if(khoi>=3){
    // K3-5: thêm Công nghệ + Tin học (sau Khoa học, trước Thẩm mĩ)
    base.splice(3,0,['Công nghệ','nl_Công_nghệ'],['Tin học','nl_Tin_học']);
  }
  return base;
}
// Trả về toàn bộ NL (chung + đặc thù) cho 1 khối
function _getAllNL(khoi){
  return NL.slice(0,NL_CHUNG_IDX).concat(_getNLDacThu(khoi));
}

// UTILS
function debounce(fn,ms){clearTimeout(_dt[fn.name]);_dt[fn.name]=setTimeout(fn,ms);}
function T(id){return document.getElementById(id);}
function toast(m,t){var el=T('toast');el.textContent=m;el.className='toast on'+(t?' '+t:'');setTimeout(function(){el.className='toast';},3500);}
function loader(t){if(t){T('ldr').className='ldr on';T('ldr-t').textContent=t;}else T('ldr').className='ldr';}
function sUI(s,lb){var d=T('sdot');if(d)d.className='sync-dot'+(s?' '+s:'');var dirty=Object.keys(_dirtyGrades).length;var extra=dirty?' · '+dirty+' chờ lưu':'';T('slbl').textContent=(lb||({ok:'Đã đồng bộ',err:'Lỗi kết nối',ld:'Đang đồng bộ...'}[s]||'Chưa kết nối'))+extra;}
function isDone(s){var g=grades[s.ma]||{};return !!(g.mon_Toán||g['mon_Tiếng_việt']||g.hoan_thanh);}

function blH(v,c){return v?'<span class="bl '+(c||mC(v))+'">'+v+'</span>':'<span style="color:#ccc">—</span>';}
function mC(v){return{HTT:'bl-htt',HT:'bl-ht',CHT:'bl-cht',T:'bl-t','Đ':'bl-d',CCG:'bl-ccg'}[v]||'';}
function kqL(kq){return{HTXS:'<span class="bl bl-htxs">⭐ HT Xuất sắc</span>',HTT:'<span class="bl bl-htt">✨ HT Tốt</span>',HT:'<span class="bl bl-ht">✓ Hoàn thành</span>',CHT:'<span class="bl bl-cht">✗ Chưa HT</span>'}[kq]||'<span style="color:#ccc">—</span>';}
function khenL(g,kq){if(kq==='HTXS')return'<span class="bl bl-xs">⭐ Xuất sắc</span>';if(kq==='HTT'&&g._tieubieu==='1')return'<span class="bl bl-tb">🌟 Tiêu biểu</span>';return'<span style="color:#ccc">—</span>';}
function kqText(kq){return{HTXS:'Hoàn thành Xuất sắc',HTT:'Hoàn thành Tốt',HT:'Hoàn thành',CHT:'Chưa hoàn thành'}[kq]||'';}

// ═══ DSHS LOADER — Single Source of Truth từ HSS ═══════════════════════════
// 2026-05-07 (Phase 3): bỏ _d_sb inline, fetch real-time từ Sheet "DS HocSinh".
//   • Cache localStorage 5 phút (qlcl_sb_v2) — giảm load, nhanh khi chuyển trang.
//   • Khi mạng lỗi: fallback cache cũ (có thông báo độ trễ).
//   • Map schema HSS → QLCL: classCode→lop, studentCode→ma, name→ten, dob→ns, gender→gt
const _DSHS_CACHE_KEY = 'qlcl_sb_v7'; // 2026-05-09: bump v6→v7 force refresh sau khi backend redeploy lần 2 — cache cũ vẫn rỗng cha/mẹ/SĐT
const _DSHS_CACHE_TTL = 60*1000;  // 2026-05-08: giảm 5 phút → 1 phút (safety net cho cross-machine sync)
const _DSHS_DIRTY_KEY = '_dshs_dirty';  // 2026-05-08: flag set bởi Hồ sơ số khi admin import/save HS → QLCL force refresh

// ═══ SKELETON LOADING STATE (2026-05-10) ═══
// _dshsLoading=true: chưa có cache + đang gọi API → renderHS/updS hiện skeleton
// _dshsFromCache=true: đã hiển thị bằng cache cũ, đang refresh ngầm → hiện badge nhỏ
var _dshsLoading = false;
var _dshsFromCache = false;

// Đọc cache trực tiếp, KHÔNG kiểm TTL (dùng cho stale-while-revalidate)
function _readDSHSCacheStale(){
  try{
    var c = JSON.parse(localStorage.getItem(_DSHS_CACHE_KEY)||'null');
    if(c && Array.isArray(c.data) && c.data.length){
      return {data: c.data, ts: c.ts || 0, fresh: (Date.now() - (c.ts||0)) < _DSHS_CACHE_TTL};
    }
  }catch(e){}
  return null;
}

function _showSkeletonStats(){
  ['c-tot','c-nam','c-nu','c-nhap','c-chua'].forEach(function(id){
    var el = T(id); if(el) el.innerHTML = '<span class="skel">000</span>';
  });
}

function _showSkeletonHS(){
  var tb = T('hs-tb'); if(!tb) return;
  var widths = [[20],[44],[160],[72],[34],[120]];
  var rows = '';
  for(var i=0;i<6;i++){
    rows += '<tr class="skel-row">';
    widths.forEach(function(w){
      rows += '<td><span class="skel" style="width:'+w[0]+'px"></span></td>';
    });
    rows += '</tr>';
  }
  tb.innerHTML = rows;
  if(T('hs-rc')) T('hs-rc').textContent = '';
}

function _showRefreshBadge(){
  var b = T('dshs-refresh-badge'); if(b) b.style.display = 'inline-flex';
}
function _hideRefreshBadge(){
  var b = T('dshs-refresh-badge'); if(b) b.style.display = 'none';
}

// Refresh DSHS ngầm sau khi đã render bằng cache cũ
function _refreshDSHSBackground(){
  _showRefreshBadge();
  loadDSHSFromHSS(true).then(function(data){
    if(data && data.length){
      SB = data;
      _dshsFromCache = false;
      if(typeof updateAll === 'function') updateAll();
    }
  }).catch(function(){
    // Im lặng — vẫn dùng cache cũ
  }).then(function(){
    _hideRefreshBadge();
  });
}

function _mapHSSStudent(s, idx){
  // 2026-05-08 fix: API có thể trả "Lớp 1A" hoặc "1A". Chuẩn hoá về "1A" (no prefix) để
  // khớp với value dropdown bldLop/myBldLop (= "1A"). Render UI tự thêm "Lớp " prefix.
  var classCode = String(s.classCode || s.lop || '').trim().replace(/^Lớp\s+/i, '');
  var khoi = parseInt(classCode) || 1;
  return {
    stt: String(s.stt || (idx+1)),
    lop: classCode,
    ma:  String(s.studentCode || s.ma || '').trim(),
    ten: String(s.name || s.ten || '').trim(),
    ns:  String(s.dob || s.ns || '').trim(),
    khoi: khoi,
    gt:  String(s.gender || s.gt || '').trim(),
    // 2026-05-08: thêm các field từ Lý lịch HSS (cho học bạ Word)
    // Code.gs getStudents trả: ethnic, religion, province, ward (public)
    //   + hamlet, birthplace, phone, father, mother (authed)
    dan_toc:    String(s.ethnic || s.dan_toc || '').trim(),
    ton_giao:   String(s.religion || s.ton_giao || '').trim(),
    quoc_tich:  String(s.nationality || s.quoc_tich || 'Việt Nam').trim(),
    province:   String(s.province || '').trim(),
    ward:       String(s.ward || '').trim(),
    hamlet:     String(s.hamlet || '').trim(),
    noi_sinh:   String(s.birthplace || s.noi_sinh || '').trim(),
    cho_o:      String(s.hamlet ? (s.hamlet + (s.ward ? ', ' + s.ward : '') + (s.province ? ', ' + s.province : '')) : (s.address || s.cho_o || '')).trim(),
    que_quan:   String(s.hometown || s.que_quan || (s.ward ? s.ward + (s.province ? ', ' + s.province : '') : '')).trim(),
    cha:        String(s.father || s.cha || '').trim(),
    me:         String(s.mother || s.me || '').trim(),
    sdt:        String(s.phone || s.sdt || '').trim()
  };
}

async function loadDSHSFromHSS(force){
  var now = Date.now();
  // 2026-05-08: dirty flag set khi admin save/import HS bên Hồ sơ số → coi như force
  var dirty = false;
  try{ dirty = !!localStorage.getItem(_DSHS_DIRTY_KEY); }catch(e){}
  // Đọc cache trước (trừ khi force refresh hoặc dirty)
  if(!force && !dirty){
    try{
      var c = JSON.parse(localStorage.getItem(_DSHS_CACHE_KEY)||'null');
      if(c && c.ts && (now - c.ts) < _DSHS_CACHE_TTL && Array.isArray(c.data) && c.data.length){
        return c.data;
      }
    }catch(e){}
  }
  // 2026-05-08: fallback nếu GAS chưa set (mode Khách bypass login) — gán từ DEFAULT_GAS
  if(!GAS && typeof DEFAULT_GAS !== 'undefined' && DEFAULT_GAS) GAS = DEFAULT_GAS;
  if(!GAS) throw new Error('GAS chưa cấu hình');

  try{
    // 2026-05-08: Nếu user đã login (HT/GVCN) → gọi studentsAuthed qua POST
    // để có thêm field nhạy cảm (cha, mẹ, nơi sinh, xóm, SĐT) cho học bạ
    // Khách/chưa login → fallback action 'students' public (chỉ 10 fields cơ bản)
    var r;
    var hasSession = !!(CU && CU.sessionToken);
    console.log('[loadDSHS] CU=', CU ? CU.username : 'null', 'sessionToken=', hasSession ? 'có' : 'KHÔNG');
    if (hasSession) {
      try {
        r = await gasPost({action:'studentsAuthed', user: CU.username || ''});
        console.log('[loadDSHS] studentsAuthed response:', r && r.ok, 'count=', r && r.data ? r.data.length : 0);
        // Verify lấy được field nhạy cảm — kiểm random 1 HS có cha/mẹ
        if (r && r.ok && Array.isArray(r.data) && r.data.length) {
          var sample = r.data.find(function(x){return x.father || x.mother || x.birthplace;});
          if (!sample) {
            console.warn('[loadDSHS] studentsAuthed trả về NHƯNG không có field nhạy cảm — auth có thể không pass full');
          } else {
            console.log('[loadDSHS] OK có data nhạy cảm — sample HS:', sample.name, 'cha=', sample.father || '(trống)');
          }
        }
      } catch(authErr) {
        console.warn('[loadDSHS] studentsAuthed lỗi, fallback public:', authErr.message);
        r = await gasCall({action:'students'});
      }
    } else {
      console.log('[loadDSHS] Khách/chưa login → dùng public students API');
      r = await gasCall({action:'students'});
    }
    if(!r || r.ok===false || !Array.isArray(r.data)){
      throw new Error((r && r.error) || 'API trả không hợp lệ');
    }
    var sb = r.data.map(_mapHSSStudent).filter(function(s){ return s.ma && s.ten; });
    try{ localStorage.setItem(_DSHS_CACHE_KEY, JSON.stringify({ts: now, data: sb})); }catch(e){}
    // 2026-05-08: load thành công → clear dirty flag
    try{ localStorage.removeItem(_DSHS_DIRTY_KEY); }catch(e){}
    return sb;
  }catch(e){
    // Mạng lỗi → fallback cache cũ (kể cả quá TTL)
    try{
      var c2 = JSON.parse(localStorage.getItem(_DSHS_CACHE_KEY)||'null');
      if(c2 && Array.isArray(c2.data) && c2.data.length){
        var ageMin = Math.round((now - c2.ts)/60000);
        try{ toast('⚠️ Dùng DSHS cache '+ageMin+' phút trước (lỗi mạng)','warn'); }catch(_){}
        return c2.data;
      }
    }catch(e2){}
    throw e;
  }
}

// GAS API — async/await với xử lý lỗi chi tiết
// ⭐ 2026-05-07: tự inject sessionToken (lưu trong CU) cho mọi request.
//   Nếu backend trả {sessionExpired:true} → tự logout + show login.
function _injectSession(p){
  if(CU&&CU.sessionToken&&!p.sessionToken) p.sessionToken=CU.sessionToken;
  return p;
}
function _checkSessionExpired(r){
  if(r && (r.sessionExpired || r.needLogin)){
    // Khách (chưa login) — không cảnh báo "phiên hết hạn"; im lặng bỏ qua
    if (typeof isGuest === 'function' && isGuest()) return true;
    // Clear local state + force re-login (tránh loop bằng flag)
    if(!window._sessionExpiredAlerted){
      window._sessionExpiredAlerted=true;
      try{localStorage.removeItem('_cu');}catch(e){}
      try{toast('⏳ Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.','warn');}catch(e){}
      setTimeout(function(){location.reload();},1500);
    }
    return true;
  }
  return false;
}
async function gasCall(p){
  if(!GAS) throw new Error('GAS chưa cấu hình');
  p=_injectSession(Object.assign({},p));
  try{
    var url=GAS+'?'+new URLSearchParams(p).toString();
    var r=await fetch(url,{method:'GET',redirect:'follow'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    var j=await r.json();
    _checkSessionExpired(j);
    return j;
  }catch(e){
    if(!navigator.onLine) throw new Error('Mất kết nối mạng — kiểm tra WiFi/3G');
    if(e.message.indexOf('Failed to fetch')>=0) throw new Error('Không thể kết nối server — kiểm tra URL hoặc quyền truy cập');
    throw e;
  }
}
async function gasPost(d){
  if(!GAS) throw new Error('GAS chưa cấu hình');
  d=_injectSession(Object.assign({},d));
  var body=JSON.stringify(d);
  try{
    // Thử POST trước
    var r=await fetch(GAS,{
      method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:body, redirect:'follow'
    });
    if(!r.ok) throw new Error('HTTP '+r.status);
    var txt=(await r.text()||'').trim();
    if(!txt) throw new Error('Empty response');
    if(txt.indexOf('<!DOCTYPE')>=0) throw new Error('GAS trả về HTML — cần deploy lại Web App');
    var j=JSON.parse(txt);
    _checkSessionExpired(j);
    return j;
  }catch(postErr){
    // Fallback: chuyển POST thành GET nếu dữ liệu nhỏ
    var enc=encodeURIComponent(body);
    if(enc.length>6000) throw new Error('Dữ liệu quá lớn. Chi tiết: '+postErr.message);
    try{
      var r2=await fetch(GAS+'?gaspost=1&d='+enc,{method:'GET',redirect:'follow'});
      if(!r2.ok) throw new Error('HTTP '+r2.status);
      var j2=await r2.json();
      _checkSessionExpired(j2);
      return j2;
    }catch(fallbackErr){
      if(!navigator.onLine) throw new Error('Mất kết nối mạng — kiểm tra WiFi/3G');
      throw new Error('Lỗi kết nối: '+fallbackErr.message);
    }
  }
}

// ═══ GIÁM SÁT KẾT NỐI MẠNG ═══
window.addEventListener('offline',function(){
  toast('📡 Mất kết nối mạng — dữ liệu chỉ lưu tạm','warn');
  sUI('err','Mất kết nối');
});
window.addEventListener('online',function(){
  toast('📡 Đã có kết nối — đang đồng bộ...','ok');
  if(GAS) syncNow(false);
  // Lưu những thay đổi chưa gửi
  if(Object.keys(_dirtyGrades).length) _flushAutoSave();
});

// ═══ AUTO-SAVE ENGINE ═══
// Đánh dấu HS đã thay đổi — sẽ được lưu tự động sau 45s
function _markDirty(ma){
  if(!ma||!grades[ma]) return;
  _dirtyGrades[ma]=grades[ma];
  _scheduleAutoSave();
}
// Lên lịch auto-save (reset timer mỗi khi có thay đổi mới)
function _scheduleAutoSave(){
  if(_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer=setTimeout(_flushAutoSave,_autoSaveInterval);
}
// Gửi tất cả thay đổi lên Sheets
async function _flushAutoSave(){
  _autoSaveTimer=null;
  if(!GAS||_autoSaving||!navigator.onLine) return;
  if(lockedPeriods[curPeriod]&&CU&&CU.role!=='admin') return;
  var keys=Object.keys(_dirtyGrades);
  if(!keys.length) return;

  _autoSaving=true;
  var batch=keys.map(function(ma){return{ma:ma,grades:_dirtyGrades[ma]};});
  // Xóa dirty trước khi gửi (nếu lỗi sẽ đánh dấu lại)
  var savedBatch=JSON.parse(JSON.stringify(_dirtyGrades));
  _dirtyGrades={};

  try{
    var r=await gasPost({
      action:'autoSave',
      period:curPeriod,
      changes:batch,
      user:CU?CU.username:'?'
    });
    _autoSaving=false;
    if(r.ok&&r.saved>0){
      sUI('ok');
      var ts=new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
      T('slbl').textContent='Tự động lưu '+ts+' ('+r.saved+' HS)';
    }
    if(r.errors&&r.errors.length){
      // ⭐ 2026-05-07: Errors do server-side validation (whitelist T/H/C/Đ/CCG/0..10)
      //   → đã bị loại ở backend, KHÔNG retry để tránh loop vô hạn.
      //   Chỉ thông báo cho GV biết các giá trị bị bỏ qua.
      var sample=r.errors.slice(0,3).join(' | ');
      toast('⚠ Bỏ qua '+r.errors.length+' giá trị sai: '+sample,'warn');
    }
  }catch(e){
    _autoSaving=false;
    // ⭐ Race-condition safe: chỉ restore HS chưa có thay đổi mới hơn
    Object.keys(savedBatch).forEach(function(ma){
      if(!_dirtyGrades[ma]) _dirtyGrades[ma]=savedBatch[ma];
    });
    _scheduleAutoSave(); // thử lại sau
  }
}
// Lưu trước khi đóng trang
window.addEventListener('beforeunload',function(e){
  _saveGradesToStorage();
  if(Object.keys(_dirtyGrades).length&&GAS&&navigator.onLine){
    // Cố gửi sync bằng sendBeacon — KÈM sessionToken để backend chấp nhận
    var payload=JSON.stringify({
      action:'autoSave',period:curPeriod,
      changes:Object.keys(_dirtyGrades).map(function(ma){return{ma:ma,grades:_dirtyGrades[ma]};}),
      user:CU?CU.username:'?',
      sessionToken:CU?CU.sessionToken:''
    });
    navigator.sendBeacon(GAS+'?gaspost=1&d='+encodeURIComponent(payload));
  }
});

// LOGIN
async function doLogin(){
  var u=T('lu').value.trim().toLowerCase(),p=T('lp').value.trim(),err=T('lerr');
  err.style.display='none';
  if(!u||!p){err.textContent='Vui lòng nhập đủ';err.style.display='block';return;}
  var btn=T('lbtn');btn.disabled=true;btn.textContent='⏳ Đang đăng nhập...';
  // ★ DEFAULT_GAS hardcoded LUÔN ưu tiên — đổi URL trong code → push → tự sync mọi browser.
  //   localStorage chỉ là fallback nếu build code thiếu DEFAULT_GAS (hiếm).
  //   Nếu localStorage cache URL cũ → tự ghi đè bằng DEFAULT_GAS mới.
  GAS=DEFAULT_GAS||localStorage.getItem('gas_url')||'';
  if(GAS&&localStorage.getItem('gas_url')!==GAS)localStorage.setItem('gas_url',GAS);
  if(!GAS){
    btn.disabled=false;btn.textContent='🔐 Đăng nhập';
    if(u==='admin'){CU={username:'admin',hoten:'Quản trị viên',role:'admin',lop:'',phan_cong:''};T('lmode').textContent='⚠️ Offline';loginOK();}
    else{err.textContent='Chưa cấu hình. Liên hệ admin.';err.style.display='block';}
    return;
  }
  try{
    var r=await gasCall({action:'login',username:u,password:p});
    btn.disabled=false;btn.textContent='🔐 Đăng nhập';
    if(r.ok){
      CU=r.user;
      // ⭐ 2026-05-07: lưu sessionToken vào CU để mọi request kèm theo
      if(r.sessionToken) CU.sessionToken=r.sessionToken;
      loginOK();
    }
    else if(u==='admin'){CU={username:'admin',hoten:'Quản trị viên',role:'admin',lop:'',phan_cong:''};T('lmode').textContent='⚠️ Offline';loginOK();}
    else{err.textContent=r.error||'Sai thông tin';err.style.display='block';}
  }catch(e){
    btn.disabled=false;btn.textContent='🔐 Đăng nhập';
    if(u==='admin'){CU={username:'admin',hoten:'Quản trị viên',role:'admin',lop:'',phan_cong:''};T('lmode').textContent='⚠️ Lỗi: '+e.message;loginOK();}
    else{err.textContent=e.message||'Không kết nối được server';err.style.display='block';}
  }
}
T('lp').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
T('lu').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});

function loginOK(isGuestMode){
  if(GAS)localStorage.setItem('gas_url',GAS);
  T('login-screen').style.display='none';T('app-screen').style.display='block';
  var isGuestNow = !!isGuestMode || (CU && CU.role==='guest');
  // ⭐ Q2c: 'Hiệu trưởng' = full quyền như admin
  var isA = !isGuestNow && (CU.role==='admin' || CU.role==='Hiệu trưởng');
  userPerm = isGuestNow ? {} : (isA ? null : (CU.phan_cong?parsePC(CU.phan_cong):{}));
  // KHÔNG persist guest CU vào localStorage (mỗi lần load lại đều là guest)
  if(!isGuestNow) localStorage.setItem('_cu',JSON.stringify(CU));
  document.body.classList.toggle('is-admin',isA);
  document.body.classList.toggle('is-guest',isGuestNow);
  // GV bộ môn: hiện toolbar nhập theo phân công
  var isGV=!isA && !isGuestNow && userPerm && Object.keys(userPerm).length>0;
  document.body.classList.toggle('is-gvbm',isGV);
  // Sidebar user info
  if(T('sb-uname')) T('sb-uname').textContent = CU.hoten || CU.username;
  if(T('sb-urole')) T('sb-urole').textContent = isGuestNow?'Đoàn KT/Phụ huynh':isA?'Quản trị viên':'Giáo viên';
  if(T('sb-avatar')) T('sb-avatar').textContent = (CU.hoten||CU.username||'K').charAt(0).toUpperCase();
  if(T('user-pill')){
    var roleBadge = isGuestNow
      ? ' <span class="bl" style="background:#e0e7ff;color:#3730a3;font-size:10px">Khách</span>'
      : isA ? ' <span class="bl" style="background:var(--rl);color:var(--r);font-size:10px">Admin</span>'
            : ' <span class="bl" style="background:var(--gl);color:var(--gd);font-size:10px">GV</span>';
    T('user-pill').innerHTML='👤 '+(CU.hoten||CU.username)+roleBadge;
  }
  // ⭐ 2026-05-08: đồng bộ mọi nơi hiển thị kỳ ngay khi loginOK (init + sau login)
  if(typeof _updatePeriodUI==='function') _updatePeriodUI();
  // 2026-05-10 stale-while-revalidate:
  //   1) Có cache (kể cả expired) → dùng ngay → render UI tức thì → refresh ngầm nếu cũ
  //   2) Không có cache → bật skeleton → initApp → gọi API → khi xong updateAll
  var cached = _readDSHSCacheStale();
  if(cached){
    SB = cached.data;
    _dshsFromCache = !cached.fresh;
    _dshsLoading = false;
    initApp();
    if(!cached.fresh){
      _refreshDSHSBackground();
    }
  } else {
    _dshsLoading = true;
    initApp(); // SB rỗng → renderHS/updS sẽ hiện skeleton vì _dshsLoading=true
    loadDSHSFromHSS(false).then(function(data){
      _dshsLoading = false;
      if(data && data.length) SB = data;
      if(typeof updateAll === 'function') updateAll();
    }).catch(function(e){
      _dshsLoading = false;
      try{ toast('⚠️ Không tải được DSHS từ Hồ sơ số: '+e.message,'warn'); }catch(_){}
      if(typeof updateAll === 'function') updateAll();
    });
  }
}

// 2026-05-07 Phase 3: nút bấm để admin force refresh DSHS từ HSS
async function reloadDSHS(){
  if(!GAS){ toast('⚠️ Chưa kết nối server','warn'); return; }
  loader('Đang cập nhật DSHS...');
  try{
    var data = await loadDSHSFromHSS(true);  // force = true bỏ qua cache
    if(!data || !data.length){ loader(); toast('⚠️ DSHS trống','warn'); return; }
    SB = data;
    merge();
    // Render lại các trang đang mở
    if(typeof hsFil==='function') hsFil();
    if(typeof dFil==='function') dFil();
    if(typeof updS==='function') updS();
    if(typeof updP==='function') updP();
    loader();
    toast('✅ Đã cập nhật DSHS — '+data.length+' học sinh','ok');
  }catch(e){
    loader();
    toast('❌ Không tải được DSHS: '+e.message,'err');
  }
}

function doLogout(){
  if(!confirm('Đăng xuất?'))return;
  try{localStorage.removeItem('_cu');}catch(e){}
  try{localStorage.removeItem('AUTH_TOKEN');localStorage.removeItem('AUTH_LEVEL');}catch(e){} // clear cả legacy HSS
  // Về Hồ sơ số (trang công khai) thay vì reload màn login QLCL
  location.href='index.html';
}

function parsePC(str){
  if(!str||!str.trim())return null;
  var MM={'toán':'mon_Toán','tiếng việt':'mon_Tiếng_việt','đạo đức':'mon_Đạo_đức','tự nhiên và xã hội':'mon_Tự_nhiên_và_xã_hội','tnxh':'mon_Tự_nhiên_và_xã_hội','ngoại ngữ':'mon_Ngoại_ngữ','tiếng anh':'mon_Ngoại_ngữ','tin học':'mon_TH-CN_Tin_học','âm nhạc':'mon_Nghệ_thuật_Âm_nhạc','mĩ thuật':'mon_Nghệ_thuật_Mĩ_thuật','mỹ thuật':'mon_Nghệ_thuật_Mĩ_thuật','hđtn':'mon_Hoạt_động_trải_nghiệm','hdtn':'mon_Hoạt_động_trải_nghiệm','gdtc':'mon_Giáo_dục_thể_chất','thể chất':'mon_Giáo_dục_thể_chất','khoa học':'mon_Khoa_học','lịch sử và địa lí':'mon_Lịch_sử_và_Địa_lí','lịch sử - địa lí':'mon_Lịch_sử_và_Địa_lí','lịch sử và địa lý':'mon_Lịch_sử_và_Địa_lí','lịch sử - địa lý':'mon_Lịch_sử_và_Địa_lí','ls&đl':'mon_Lịch_sử_và_Địa_lí','ls-đl':'mon_Lịch_sử_và_Địa_lí','ls&dl':'mon_Lịch_sử_và_Địa_lí','lsđl':'mon_Lịch_sử_và_Địa_lí','công nghệ':'mon_TH-CN_Công_nghệ','cn':'mon_TH-CN_Công_nghệ'};
  var res={};
  str.split(/\s*\+\s*/).forEach(function(part){
    var m=part.match(/^(.+?)\s*\(([^)]+)\)/);if(!m)return;
    var key=MM[m[1].trim().toLowerCase()];if(!key)return;
    m[2].split(/[,\s]+/).map(function(c){return c.trim();}).filter(function(c){return/^\d[A-E]$/i.test(c);}).forEach(function(lop){
      if(!res[lop])res[lop]=[];if(res[lop].indexOf(key)<0)res[lop].push(key);
    });
  });
  return res;
}
function canE(lop){if(!CU)return false;if(CU.role==='admin'||userPerm===null)return true;return!!userPerm[lop];}
function editSubs(lop){if(!CU)return[];if(CU.role==='admin'||userPerm===null)return null;return userPerm[lop]||[];}

// PERIOD PROGRESS CHECK
function checkPeriodReady(pid){
  var order=['gk1','ck1','gk2','cn'];
  var idx=order.indexOf(pid);
  if(idx<=0)return;
  var prevId=order[idx-1];
  var prevData=allGrades[prevId]||{};
  if(!Object.keys(prevData).length){
    var prevName=PERIODS.find(function(p){return p.id===prevId;}).name;
    toast('⚠️ Kỳ "'+prevName+'" chưa có dữ liệu','warn');
  }
}

// ═══ AUTH GUARDS (Guest mode 2026-05-07) ═══
// Trang QLCL vào thẳng được như HSS — Khách xem được DSHS công khai.
// Click chức năng cần đăng nhập → popup login.
function isGuest(){ return !CU || CU.role === 'guest'; }

// needAuth: bất kỳ chức năng cần đăng nhập (GV hoặc Admin) — popup modal trên giao diện
window.needAuth = function(msg){
  if(!isGuest()) return true;
  showLoginScreen(msg);
  return false;
};

// needAdmin: action chỉ Hiệu trưởng/Phó HT (Q2c: 'Hiệu trưởng' = admin)
function needAdmin(msg){
  if(isGuest()) return needAuth(msg);
  if(CU.role==='admin' || CU.role==='Hiệu trưởng') return true;
  toast('🔒 '+(msg||'Chức năng dành cho Quản trị viên'),'warn');
  return false;
}

// ⭐ 2026-05-08: hiện MODAL LOGIN nhỏ trên giao diện chính (không chuyển trang).
//   actionName: tên chức năng cần auth (vd "Nhập kết quả") — hiển thị trong cảnh báo.
window.showLoginScreen = function(actionName){
  // Cập nhật cảnh báo trong modal
  var lbl = T('lm-action');
  if(lbl) lbl.textContent = actionName ? ('"'+actionName+'"') : 'chức năng này';
  // Reset form + show modal
  if(T('lu2')) T('lu2').value='';
  if(T('lp2')) T('lp2').value='';
  if(T('lerr2')){T('lerr2').textContent='';T('lerr2').style.display='none';}
  var bg = T('loginBg');
  if(bg){
    bg.classList.add('on');
    setTimeout(function(){var e=T('lu2'); if(e) e.focus();}, 80);
  }else{
    // Fallback nếu chưa có modal (tránh crash) — về màn login full
    T('app-screen').style.display='none';
    T('login-screen').style.display='';
  }
};

// Submit từ modal — tương tự doLogin nhưng đọc từ inputs trong modal (#lu2/#lp2)
async function doLoginModal(){
  var u=T('lu2').value.trim().toLowerCase(),p=T('lp2').value.trim(),err=T('lerr2');
  err.style.display='none';
  if(!u||!p){err.textContent='Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.';err.style.display='block';return;}
  GAS=DEFAULT_GAS||localStorage.getItem('gas_url')||'';
  if(GAS&&localStorage.getItem('gas_url')!==GAS)localStorage.setItem('gas_url',GAS);
  if(!GAS){err.textContent='Chưa cấu hình backend. Liên hệ Admin.';err.style.display='block';return;}
  var btn=T('lbtn2');btn.disabled=true;btn.textContent='⏳ Đang đăng nhập...';
  try{
    var r=await gasCall({action:'login',username:u,password:p});
    btn.disabled=false;btn.textContent='🔓 Đăng nhập';
    if(r && r.ok && r.user){
      CU=r.user;
      if(r.sessionToken)CU.sessionToken=r.sessionToken;
      cm('loginBg');
      loginOK();
      toast('✅ Xin chào '+(CU.hoten||CU.username)+'!','ok');
    }else{
      err.textContent=(r && r.error)||'Sai tên đăng nhập hoặc mật khẩu.';
      err.style.display='block';
      try{T('lp2').value='';T('lp2').focus();}catch(e){}
    }
  }catch(e){
    btn.disabled=false;btn.textContent='🔓 Đăng nhập';
    err.textContent=e.message||'Không kết nối được server';err.style.display='block';
  }
}
window.doLoginModal = doLoginModal;

// PERIOD SWITCHER
// ⭐ 2026-05-08: helper đồng bộ MỌI nơi hiển thị kỳ đánh giá (topbar + header bảng + export)
function _updatePeriodUI(){
  var pc=PERIODS.find(function(p){return p.id===curPeriod;});
  if(!pc)return;
  // Topbar badge
  if(T('cur-period-label')){
    T('cur-period-label').textContent=pc.name;
    T('cur-period-label').style.background=pc.color+'22';
    T('cur-period-label').style.color=pc.color;
  }
  // Header bảng (chip góc phải khối xanh "Quản lý Hồ sơ Học sinh", v.v.)
  if(T('hky-period'))T('hky-period').textContent=pc.name;
  // Trang xuất báo cáo
  if(T('exp-period'))T('exp-period').textContent=pc.name;
  // Floating "Chuyển sang…" chỉ hiện kỳ KHÁC kỳ hiện tại
  var swBtn=T('quick-switch-btn');
  if(swBtn){
    var nextPid = (curPeriod==='gk2')?'cn':'gk2';
    var nextPc = PERIODS.find(function(p){return p.id===nextPid;});
    swBtn.textContent='📅 Chuyển sang: '+nextPc.name;
    swBtn.dataset.targetPid=nextPid;
  }
}

function switchPeriod(pid){
  if(pid===curPeriod)return;
  // GV bị chặn nếu kỳ bị khóa
  if(lockedPeriods[pid]&&(!CU||CU.role!=='admin')){
    toast('🔒 Kỳ này đã bị khóa','warn');return;
  }
  allGrades[curPeriod]=JSON.parse(JSON.stringify(grades));
  curPeriod=pid;
  var saved=allGrades[curPeriod];
  grades=saved?JSON.parse(JSON.stringify(saved)):{};
  allGrades[curPeriod]=grades;
  _updatePeriodBtns();
  _updatePeriodUI();
  merge();updateAll();
  if(GAS)syncNow(true);
  toast('📅 Chuyển sang: '+PERIODS.find(function(p){return p.id===pid;}).name,'ok');
}
function _updatePeriodBtns(){
  var isAdmin=CU&&CU.role==='admin';
  document.querySelectorAll('.period-btn').forEach(function(b){
    var pid=b.dataset.pid;
    var locked=!!lockedPeriods[pid];
    b.classList.toggle('on',pid===curPeriod);
    var ico=b.querySelector('.lock-ico');
    if(locked){
      if(!ico){ico=document.createElement('span');ico.className='lock-ico';ico.style.cssText='position:absolute;top:1px;right:2px;font-size:7px';b.style.position='relative';b.appendChild(ico);}
      ico.textContent='🔒';
    }else{if(ico)ico.remove();}
    if(locked&&!isAdmin){b.style.opacity='0.35';b.style.pointerEvents='none';}
    else{b.style.opacity='';b.style.pointerEvents='';}
  });
  // Admin lock panel
  var lp=T('admin-lock-panel');
  if(lp) lp.style.display=isAdmin?'block':'none';
  // Style admin lock buttons
  ['gk1','ck1','gk2','cn'].forEach(function(pid){
    var btn=T('lk-'+pid);if(!btn)return;
    var locked=!!lockedPeriods[pid];
    btn.textContent=(locked?'🔒 ':'🔓 ')+{gk1:'GHK1',ck1:'CHK1',gk2:'GHK2',cn:'CN'}[pid];
    btn.style.background=locked?'rgba(239,68,68,.3)':'rgba(34,197,94,.2)';
    btn.style.borderColor=locked?'rgba(239,68,68,.5)':'rgba(34,197,94,.4)';
    btn.style.color=locked?'#fca5a5':'#86efac';
  });
}
function _toggleLock(pid){
  if(!CU||CU.role!=='admin')return;
  if(lockedPeriods[pid]){
    // Mở kỳ này → tự động KHÓA các kỳ còn lại (chỉ 1 kỳ mở tại một thời điểm)
    delete lockedPeriods[pid];
    ['gk1','ck1','gk2','cn'].forEach(function(p){
      if(p!==pid) lockedPeriods[p]=true;
    });
    // Tự chuyển curPeriod sang kỳ vừa mở để admin/GV vào là làm việc luôn
    if(curPeriod!==pid) _switchPeriodSilent(pid);
  }else{
    lockedPeriods[pid]=true;
  }
  _updatePeriodBtns();
  _saveLockConfig();
  var name=PERIODS.find(function(p){return p.id===pid;}).name;
  toast(lockedPeriods[pid]?'🔒 Đã khóa: '+name:'🔓 Đã mở: '+name+' (các kỳ khác đã tự khóa)','ok');
}

// Chuyển kỳ không hiện toast — dùng cho auto-switch khi load config
function _switchPeriodSilent(pid){
  if(pid===curPeriod)return;
  allGrades[curPeriod]=JSON.parse(JSON.stringify(grades));
  curPeriod=pid;
  var saved=allGrades[curPeriod];
  grades=saved?JSON.parse(JSON.stringify(saved)):{};
  allGrades[curPeriod]=grades;
  _updatePeriodUI();
  if(typeof merge==='function')merge();
  if(typeof updateAll==='function')updateAll();
}

// ═══ KHÓA KỲ — LƯU/TẢI CẤU HÌNH ═══
async function _saveLockConfig(){
  try{localStorage.setItem('_lockedPeriods',JSON.stringify(lockedPeriods));}catch(e){}
  if(GAS){gasPost({action:'saveConfig',key:'lockedPeriods',value:JSON.stringify(lockedPeriods)}).catch(function(){});}
}
async function _loadLockConfig(){
  try{var lp=localStorage.getItem('_lockedPeriods');if(lp)lockedPeriods=JSON.parse(lp);}catch(e){}
  if(GAS){
    try{
      var r=await gasCall({action:'getConfig',key:'lockedPeriods'});
      if(r.ok&&r.value){lockedPeriods=JSON.parse(r.value);try{localStorage.setItem('_lockedPeriods',r.value);}catch(e){}}
    }catch(e){}
  }
  // Auto-switch curPeriod sang kỳ đang MỞ (ưu tiên kỳ mới nhất theo thứ tự GHK1→CHK1→GHK2→CN)
  var order=['cn','gk2','ck1','gk1'];
  var openPid=order.find(function(p){return !lockedPeriods[p];});
  if(openPid && openPid!==curPeriod){
    _switchPeriodSilent(openPid);
  }
  _updatePeriodBtns();
}

// SYNC — V3.0 async/await
async function syncNow(silent){
  // ⭐ Guest mode: không sync grades/nhận xét (cần sessionToken). Hiện DSHS public là đủ.
  if(typeof isGuest==='function' && isGuest()){sUI('','Khách - chỉ xem DS');return;}
  if(!GAS){if(!silent)toast('⚠️ Chưa có GAS URL','warn');return;}
  if(!navigator.onLine){sUI('err','Mất kết nối');if(!silent)toast('📡 Mất kết nối mạng','warn');return;}
  sUI('ld');
  var syncPeriod=curPeriod;
  try{
    var [rG,rN]=await Promise.all([
      gasCall({action:'getGrades',period:syncPeriod}),
      gasCall({action:'getNhanXet'}).catch(function(){return{ok:true,data:{}};})
    ]);
    if(rG.ok){
      var remote=rG.data||{};
      if(syncPeriod===curPeriod){
        var newGrades={};
        Object.keys(remote).forEach(function(k){newGrades[k]=remote[k];});
        grades=newGrades;
        allGrades[curPeriod]=newGrades;
        try{localStorage.setItem('_allGrades',JSON.stringify(allGrades));}catch(e){}
      } else {
        allGrades[syncPeriod]=remote;
        try{localStorage.setItem('_allGrades',JSON.stringify(allGrades));}catch(e){}
      }
    }
    if(rN.ok){
      var remoteNX=rN.data||{};
      Object.keys(remoteNX).forEach(function(k){nhanXet[k]=remoteNX[k];});
      try{localStorage.setItem('_nhanxet',JSON.stringify(nhanXet));}catch(e){}
    }
    merge();updateAll();
    sUI('ok');
    var ts=new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
    var cnt=Object.keys(rG.data||{}).length;
    T('slbl').textContent='Đồng bộ '+ts+' ('+cnt+' HS)';
    if(!silent)toast('✅ Tải '+cnt+' bản ghi','ok');
  }catch(e){
    sUI('err');
    if(!silent)toast('❌ '+e.message,'err');
  }
}

// INIT
function initApp(){
  // ★ DEFAULT_GAS hardcoded LUÔN ưu tiên (xem doLogin để biết lý do).
  GAS=DEFAULT_GAS||localStorage.getItem('gas_url')||'';
  if(GAS&&localStorage.getItem('gas_url')!==GAS)localStorage.setItem('gas_url',GAS);
  var savedVer=localStorage.getItem('_appVer')||'';
  if(savedVer!=='3.2'){localStorage.removeItem('_allGrades');localStorage.removeItem('_grades');localStorage.setItem('_appVer','3.2');}
  try{allGrades=JSON.parse(localStorage.getItem('_allGrades')||'{}');}catch(e){allGrades={};}
  // Migrate old V2.0 flat grades to 'cn' period (one-time)
  try{
    var oldG=JSON.parse(localStorage.getItem('_grades')||'{}');
    if(Object.keys(oldG).length&&!Object.keys(allGrades.cn||{}).length){
      allGrades.cn=oldG;
      localStorage.removeItem('_grades'); // clean up old key
    }
  }catch(e){}
  // Load grades for current period (deep copy to isolate)
  grades=allGrades[curPeriod]?JSON.parse(JSON.stringify(allGrades[curPeriod])):{};
  allGrades[curPeriod]=grades;
  try{nhanXet=JSON.parse(localStorage.getItem('_nhanxet')||'{}');}catch(e){nhanXet={};}
  merge();buildSide();myBldLop('hs-lop','');myBldLop('d-lop','1');myBldLop('hb-lop','');
  dK(1,document.querySelectorAll('#diem-kts .kt')[0]);
  hsFil();updS();updP();renderSt();renderTK(0);
  var st=T('sett-status');
  if(st)st.innerHTML=GAS?'<span style="color:var(--gd)">✅ Đã cấu hình</span>':'<span style="color:var(--r)">❌ Chưa có GAS URL</span>';
  if(GAS){sUI('ld','Đang tải...');syncNow(false);setInterval(function(){syncNow(true);},90000);}
  else sUI('','Chưa kết nối');
}

function merge(){allS=mySB().map(function(s){var merged=Object.assign({},s,grades[s.ma]||{});merged.ma=String(s.ma);return merged;});}
function updateAll(){merge();buildSide();hsFil();dFil();updS();updP();renderSt();renderTK(tkKF);}
function _saveGradesToStorage(){try{allGrades[curPeriod]=grades;localStorage.setItem('_allGrades',JSON.stringify(allGrades));}catch(e){}}
function updS(){
  if(_dshsLoading && !allS.length){ _showSkeletonStats(); return; }
  var ms=mySB();var d=allS.filter(isDone).length;T('c-nhap').textContent=d;T('c-chua').textContent=ms.length-d;T('c-tot').textContent=ms.length;T('c-nam').textContent=ms.filter(function(s){return s.gt==='Nam';}).length;T('c-nu').textContent=ms.filter(function(s){return s.gt==='Nữ';}).length;
}
function updP(){var ms=mySB();var d=allS.filter(isDone).length,p=ms.length?Math.round(d/ms.length*100):0;if(T('s-prog'))T('s-prog').textContent=d+'/'+ms.length;if(T('s-pb'))T('s-pb').style.width=p+'%';if(T('s-pct'))T('s-pct').textContent=p+'%';if(T('sb-tot'))T('sb-tot').textContent=ms.length;}

// SIDEBAR + NAV
function buildSide(){
  var el=T('side-lops');if(!el)return;
  var h='';
  [1,2,3,4,5].forEach(function(k){['A','B','C','D','E'].forEach(function(c){
    var lop=k+c,hs=mySB().filter(function(s){return s.lop===lop;}),tot=hs.length,done=hs.filter(isDone).length;
    var cl=done===tot?'ok':done>0?'pt':'no';
    h+='<div class="si" onclick="jumpLop(\''+lop+'\')"><span style="width:15px;text-align:center">📋</span>Lớp '+lop+'<span class="sbdg '+cl+'">'+done+'/'+tot+'</span></div>';
  });});
  el.innerHTML=h;
}
function jumpLop(lop){var k=parseInt(lop);gp('pg-diem');dK(k,document.querySelectorAll('#diem-kts .kt')[k-1]);T('d-lop').value=lop;dFil();}
function gp(id,el){
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('on');});T(id).classList.add('on');
  document.querySelectorAll('.ntab').forEach(function(t){t.classList.remove('on');});if(el)el.classList.add('on');
  if(id==='pg-status')renderSt();if(id==='pg-tk')renderTK(tkKF);if(id==='pg-users')loadUsers();
  if(id==='pg-hocba')hbFil();
  if((id==='pg-diem'||id==='pg-hs')&&GAS)syncNow(true);
}
function bldLop(id,khoi){
  var el=T(id);if(!el)return;var o='<option value="">Tất cả lớp</option>';
  var ks=khoi?[parseInt(khoi)]:[1,2,3,4,5];
  ks.forEach(function(k){['A','B','C','D','E'].forEach(function(c){o+='<option value="'+k+c+'">Lớp '+k+c+'</option>';});});
  el.innerHTML=o;
}

function mkPagi(pbId,piId,cur,arr,fn){
  var tot=arr.length,tp=Math.max(1,Math.ceil(tot/PZ));
  T(piId).textContent=tot?((cur-1)*PZ+1)+'–'+Math.min(cur*PZ,tot)+' / '+tot:'';
  var h='<button class="pb" onclick="'+fn+'('+(cur-1)+')" '+(cur<=1?'disabled':'')+'">‹</button>';
  for(var i=1;i<=tp;i++)h+='<button class="pb '+(i===cur?'on':'')+'" onclick="'+fn+'('+i+')">'+i+'</button>';
  h+='<button class="pb" onclick="'+fn+'('+(cur+1)+')" '+(cur>=tp?'disabled':'')+'">›</button>';
  T(pbId).innerHTML=h;
}

// TT27
function cTT(ma,k){
  var g=grades[ma]||{};
  // Loại Tiếng dân tộc khỏi căn cứ đánh giá (trường không dạy)
  var sj=(SUBJ[String(k)]||SUBJ['1']).filter(function(x){return x[1]!=='mon_Tiếng_dân_tộc';});
  var allNL=_getAllNL(parseInt(k));
  if(sj.filter(function(x){return g[x[1]];}).length<sj.length)return null;
  if(allNL.filter(function(x){return g[x[1]];}).length<allNL.length)return null;
  if(PC.filter(function(x){return g[x[1]];}).length<PC.length)return null;
  var sc=sj.filter(function(x){return x[2]&&x[3];}).map(function(x){var v=g[x[2]];return v!==undefined&&v!==''?parseInt(v):-1;}).filter(function(x){return x>=0;});
  var ms=sc.length>0?Math.min.apply(null,sc):999;
  var aHTT=sj.every(function(x){return g[x[1]]==='HTT';});
  var aT=allNL.concat(PC).every(function(x){return g[x[1]]==='T';});
  var aNoCHT=sj.every(function(x){return g[x[1]]!=='CHT';});
  var aNoCCG=allNL.concat(PC).every(function(x){return g[x[1]]!=='CCG';});
  if(aHTT&&aT&&ms>=9)return'HTXS';if(aHTT&&aT&&ms>=7)return'HTT';
  if(aNoCHT&&aNoCCG&&(sc.length===0||ms>=5))return'HT';return'CHT';
}

// PAGE: HỌC SINH
function hsKhoi(){myBldLop('hs-lop',T('hs-kh').value);hsFil();}
function hsRst(){T('hs-q').value='';T('hs-kh').value='';T('hs-gt').value='';T('hs-nt').value='';myBldLop('hs-lop','');hsFil();}
function hsFil(){
  var q=T('hs-q').value.toLowerCase(),kh=T('hs-kh').value,lop=T('hs-lop').value,gt=T('hs-gt').value,nt=T('hs-nt').value;
  hsF=allS.filter(function(s){
    if(kh&&s.lop.indexOf(kh)!==0)return false;if(lop&&s.lop!==lop)return false;
    if(gt&&s.gt!==gt)return false;if(nt==='done'&&!isDone(s))return false;if(nt==='todo'&&isDone(s))return false;
    if(q&&(s.ten+s.ma).toLowerCase().indexOf(q)<0)return false;return true;
  });hsP=1;renderHS();
}
function renderHS(){
  // Skeleton: chưa có data + đang load lần đầu → hiện shimmer thay vì "Không tìm thấy"
  if(_dshsLoading && !allS.length){ _showSkeletonHS(); return; }
  var tot=hsF.length,rows=hsF.slice((hsP-1)*PZ,hsP*PZ),tb=T('hs-tb');
  if(!tot){tb.innerHTML='<tr><td colspan="8"><div class="empty"><div class="ei">🔍</div><p>Không tìm thấy</p></div></td></tr>';T('hs-rc').textContent='';return;}
  // 2026-05-06: BỎ nút Sửa/Xoá HS — QLCL chỉ READ-ONLY DSHS.
  // Quản lý HS chuyển sang HSS Admin Panel.
  tb.innerHTML=rows.map(function(s,i){
    if(!canAccessStudent(s)){return '';}
    var choO=s.cho_o||'';
    var choOHtml=choO?'<span title="'+choO.replace(/"/g,'&quot;')+'" style="max-width:140px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">'+choO+'</span>':'<span style="color:#ccc">—</span>';
    return'<tr><td style="color:var(--tx3);font-size:11px">'+((hsP-1)*PZ+i+1)+'</td><td><span class="bl bl-lop">Lớp '+s.lop+'</span></td><td class="tdn">'+s.ten+'<small>'+s.ma+'</small></td><td style="font-size:11px">'+s.ns+'</td><td><span class="bl '+(s.gt==='Nam'?'bl-nam':'bl-nu')+'">'+s.gt+'</span></td><td>'+choOHtml+'</td></tr>';
  }).join('');T('hs-rc').textContent=tot+' HS';mkPagi('hs-pb','hs-pi',hsP,hsF,'hsPg');
}
function hsPg(p){hsP=Math.max(1,Math.min(p,Math.ceil(hsF.length/PZ)));renderHS();}

// PAGE: NHẬP ĐIỂM — DYNAMIC TABLE
var HIDDEN_SUBJ=['mon_Tiếng_dân_tộc']; // Ẩn các môn trường không dạy
function _visibleSubj(k){return(SUBJ[String(k)]||SUBJ['1']).filter(function(mn){return HIDDEN_SUBJ.indexOf(mn[1])<0;});}
// Kiểm tra môn có điểm KTĐK theo kỳ + khối (TT27)
function _hasDiem(mn,k){
  if(!mn[2]||!mn[3])return false; // Môn không có cấu trúc điểm
  if(curPeriod==='cn'||curPeriod==='ck1') return true; // Cuối năm + Cuối HK1: có KTĐK
  // Giữa HK (gk1, gk2): TT27 Đ7
  if(k<=3) return false; // K1-3: KHÔNG có điểm KTĐK
  // K4-5: CHỈ Toán + Tiếng Việt có điểm
  return mn[1]==='mon_Toán'||mn[1]==='mon_Tiếng_việt';
}
function _shortName(n){return{
  'Toán':'Toán','Tiếng Việt':'T.Việt','Đạo đức':'Đ.đức',
  'Tự nhiên & XH':'TNXH','Ngoại ngữ':'NN','Tin học':'TH',
  'Âm nhạc':'ÂN','Mĩ thuật':'MT','HĐTN':'HĐTN','Thể chất':'GDTC',
  'Công nghệ':'CN','Khoa học':'KH','Lịch sử - Địa lí':'LS-ĐL',
  'Tiếng dân tộc':'TDT'
}[n]||n.substring(0,6);}

function dK(k,el){curK=k;document.querySelectorAll('#diem-kts .kt').forEach(function(t){t.classList.remove('on');});if(el)el.classList.add('on');myBldLop('d-lop',String(k));dFil();}
function dFil(){
  var lop=T('d-lop').value,q=T('d-q').value.toLowerCase(),nt=T('d-nt').value;
  dF=allS.filter(function(s){if(s.khoi!==curK)return false;if(lop&&s.lop!==lop)return false;if(nt==='done'&&!isDone(s))return false;if(nt==='todo'&&isDone(s))return false;if(q&&s.ten.toLowerCase().indexOf(q)<0)return false;return true;});
  dP=1;renderD();
}
function renderD(){
  var sj=_visibleSubj(curK);
  var isMid=curPeriod!=='cn'; // Giữa HK = không có Lên lớp/KQGD
  // Build header
  var th='<tr><th style="position:sticky;left:0;z-index:2;background:#1e40af;min-width:38px">Lớp</th>';
  th+='<th style="position:sticky;left:38px;z-index:2;background:#1e40af;min-width:120px">Họ tên</th>';
  sj.forEach(function(mn){
    var sn=_shortName(mn[0]),hasDiem=_hasDiem(mn,curK);
    if(hasDiem) th+='<th class="c" style="min-width:55px;font-size:9px;line-height:1.2">'+sn+'<br><span style="font-weight:400;font-size:8px">ĐG/Điểm</span></th>';
    else th+='<th class="c" style="min-width:36px;font-size:9px">'+sn+'</th>';
  });
  NL.slice(0,NL_CHUNG_IDX).forEach(function(nl){
    th+='<th class="c" style="min-width:32px;font-size:8px;line-height:1.2;background:#1565c0">'+nl[0].split(' ')[0].substring(0,4)+'</th>';
  });
  _getNLDacThu(curK).forEach(function(nl){
    th+='<th class="c" style="min-width:32px;font-size:8px;line-height:1.2;background:#e65100">'+nl[0].substring(0,4)+'</th>';
  });
  PC.forEach(function(pc){
    th+='<th class="c" style="min-width:32px;font-size:8px;line-height:1.2;background:#1b5e20">'+pc[0].substring(0,4)+'</th>';
  });
  if(!isMid){
    th+='<th class="c" style="min-width:50px;font-size:9px">KQGD</th>';
    th+='<th class="c" style="min-width:34px;font-size:9px">Lên<br>lớp</th>';
  }
  th+='<th class="c" style="min-width:30px"></th></tr>';
  T('d-thead').innerHTML=th;

  var tot=dF.length,rows=dF.slice((dP-1)*PZ,dP*PZ),tb=T('d-tb');
  var allNLForK=_getAllNL(curK);
  var colSpan=2+sj.length+allNLForK.length+PC.length+(isMid?1:3);
  if(!tot){tb.innerHTML='<tr><td colspan="'+colSpan+'"><div class="empty"><div class="ei">📋</div><p>Không có HS</p></div></td></tr>';T('d-rc').textContent='';return;}
  tb.innerHTML=rows.map(function(s){
    var gi=SB.findIndex(function(b){return b.ma===s.ma;}),g=grades[s.ma]||{},kq=cTT(s.ma,s.khoi);
    var abtn=canE(s.lop)?'<button class="abtn ae" onclick="openM('+gi+')" style="padding:0 5px">✏️</button>':'<button class="abtn alck" style="padding:0 5px">🔒</button>';
    var r='<tr>';
    r+='<td style="position:sticky;left:0;z-index:1;background:#fff"><span class="bl bl-lop" style="font-size:9px">Lớp '+s.lop+'</span></td>';
    r+='<td style="position:sticky;left:38px;z-index:1;background:#fff" class="tdn"><span style="font-size:11.5px">'+s.ten+'</span></td>';
    sj.forEach(function(mn){
      var mv=g[mn[1]]||'',hasDiem=_hasDiem(mn,s.khoi);
      var dv=hasDiem?(g[mn[2]]!==undefined&&g[mn[2]]!==''?g[mn[2]]:''):'';
      if(hasDiem){
        var mBl=mv?'<span style="font-size:9px;font-weight:600;'+({HTT:'color:#00695c',HT:'color:var(--p)',CHT:'color:var(--r)'}[mv]||'color:#999')+'">'+({HTT:'T',HT:'H',CHT:'C'}[mv]||mv)+'</span>':'<span style="color:#ddd;font-size:9px">—</span>';
        var dBl=dv!==''?'<b style="font-size:11px">'+dv+'</b>':'';
        r+='<td class="c" style="padding:3px 2px;line-height:1.1;white-space:nowrap">'+mBl+(dv!==''?'<br>':'')+ dBl+'</td>';
      } else {
        r+='<td class="c" style="padding:3px 2px">'+( mv?'<span style="font-size:9px;font-weight:600;'+({HTT:'color:#00695c',HT:'color:var(--p)',CHT:'color:var(--r)'}[mv]||'')+'">'+({HTT:'T',HT:'H',CHT:'C'}[mv]||mv)+'</span>':'<span style="color:#ddd;font-size:9px">—</span>')+'</td>';
      }
    });
    // NL (dynamic theo khối)
    allNLForK.forEach(function(nl){
      var v=g[nl[1]]||'';
      r+='<td class="c" style="padding:2px 1px;font-size:9px;'+(v==='T'?'color:#00695c;font-weight:700':v==='Đ'?'color:var(--p)':v==='CCG'?'color:var(--r)':'color:#ddd')+'">'+(v||'—')+'</td>';
    });
    // PC
    PC.forEach(function(pc){
      var v=g[pc[1]]||'';
      r+='<td class="c" style="padding:2px 1px;font-size:9px;'+(v==='T'?'color:#1b5e20;font-weight:700':v==='Đ'?'color:var(--p)':v==='CCG'?'color:var(--r)':'color:#ddd')+'">'+(v||'—')+'</td>';
    });
    if(!isMid){
      // KQGD + Lên lớp chỉ hiện ở Cuối năm
      r+='<td class="c" style="padding:2px">'+kqL(kq)+'</td>';
      var ll=g.len_lop;
      r+='<td class="c" style="padding:2px">'+(ll==='Có'?'<span style="color:var(--g);font-weight:700;font-size:10px">✓</span>':ll==='Không'?'<span style="color:var(--r);font-size:10px">✗</span>':'<span style="color:#ddd;font-size:9px">—</span>')+'</td>';
    }
    r+='<td class="c" style="padding:2px">'+abtn+'</td>';
    r+='</tr>';
    return r;
  }).join('');T('d-rc').textContent=tot+' HS';mkPagi('d-pb','d-pi',dP,dF,'dPg');
}
function dPg(p){dP=Math.max(1,Math.min(p,Math.ceil(dF.length/PZ)));renderD();}

// ┌──────────────────────────────────────────────────────────┐
// │  NHẬP ĐIỂM TỪ EXCEL — MẪU + IMPORT                     │
// └──────────────────────────────────────────────────────────┘

function _mauCols(k){
  var sj=_visibleSubj(k);
  var cols=[
    {h:'STT',key:'_stt',w:5},
    {h:'Mã HS',key:'_ma',w:14},
    {h:'Họ và tên',key:'_ten',w:25}
  ];
  sj.forEach(function(mn){
    cols.push({h:mn[0]+' (ĐG)',key:mn[1],w:10,note:'T / H / C',type:'mon'});
    if(_hasDiem(mn,k)) cols.push({h:mn[0]+' (Điểm)',key:mn[2],w:10,note:'0-10',type:'diem'});
  });
  // 3 NL chung (cố định, không phụ thuộc khối)
  NL.slice(0,NL_CHUNG_IDX).forEach(function(nl){cols.push({h:'NL: '+nl[0],key:nl[1],w:12,note:'T / Đ / C',type:'nlpc'});});
  // NL đặc thù — theo khối: K1-2 có 5, K3-5 có 7 (thêm Công nghệ + Tin học)
  // Thứ tự chuẩn TT27/CT GDPT 2018: Ngôn ngữ → Tính toán → Khoa học → Công nghệ → Tin học → Thẩm mĩ → Thể chất
  _getNLDacThu(k).forEach(function(nl){cols.push({h:'NL: '+nl[0],key:nl[1],w:12,note:'T / Đ / C',type:'nlpc'});});
  PC.forEach(function(pc){cols.push({h:'PC: '+pc[0],key:pc[1],w:12,note:'T / Đ / C',type:'nlpc'});});
  cols.push({h:'Lên lớp',key:'len_lop',w:10,note:'Có / Không'});
  return cols;
}
// Chuyển đổi mã nhập ↔ mã lưu
function _inputToStore(val,type){
  if(type==='mon'){return{T:'HTT',H:'HT',C:'CHT'}[val.toUpperCase()]||val;}
  if(type==='nlpc'){return{T:'T','Đ':'Đ','D':'Đ',C:'CCG'}[val.toUpperCase()]||val;}
  return val;
}
function _storeToDisplay(val,type){
  if(type==='mon'){return{HTT:'T',HT:'H',CHT:'C'}[val]||val;}
  if(type==='nlpc'){return{T:'T','Đ':'Đ',CCG:'C'}[val]||val;}
  return val;
}

// ═══ TẠO MẪU CHUẨN BỘ GD — TẢI TRỰC TIẾP VỀ MÁY ═══
// ═══════════════════════════════════════════════════════════════
// XUẤT FILE MẪU — 20 MẪU ĐỘNG THEO KHỐI × KỲ (TT27/2020)
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// XLSX STYLED HELPERS (xlsx-js-style)
// ═══════════════════════════════════════════════════════════════
var _XS={
  bdr:{top:{style:'thin',color:{rgb:'AAAAAA'}},bottom:{style:'thin',color:{rgb:'AAAAAA'}},left:{style:'thin',color:{rgb:'AAAAAA'}},right:{style:'thin',color:{rgb:'AAAAAA'}}},
  green:{font:{bold:true,sz:10,name:'Arial'},fill:{fgColor:{rgb:'C6EFCE'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  greenDk:{font:{bold:true,sz:10,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'92D050'}},alignment:{horizontal:'center',vertical:'center'}},
  blue:{font:{bold:true,sz:9,name:'Arial'},fill:{fgColor:{rgb:'D6E4F0'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  orangeDk:{font:{bold:true,sz:10,name:'Arial'},fill:{fgColor:{rgb:'F4B084'}},alignment:{horizontal:'center',vertical:'center'}},
  orange:{font:{bold:true,sz:9,name:'Arial'},fill:{fgColor:{rgb:'FCE4D6'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  purpleDk:{font:{bold:true,sz:10,name:'Arial'},fill:{fgColor:{rgb:'9BC2E6'}},alignment:{horizontal:'center',vertical:'center'}},
  purple:{font:{bold:true,sz:9,name:'Arial'},fill:{fgColor:{rgb:'E2D9F3'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  yellow:{font:{bold:true,sz:9,name:'Arial'},fill:{fgColor:{rgb:'FFF2CC'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  infoDk:{font:{bold:true,sz:10,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'2E7D32'}},alignment:{horizontal:'left',vertical:'center'}},
  monDk:{font:{bold:true,sz:10,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'1565C0'}},alignment:{horizontal:'center',vertical:'center'}},
  nlDk:{font:{bold:true,sz:10,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'E65100'}},alignment:{horizontal:'center',vertical:'center'}},
  pcDk:{font:{bold:true,sz:10,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'6A1B9A'}},alignment:{horizontal:'center',vertical:'center'}},
  data:{font:{sz:11,name:'Arial'},alignment:{horizontal:'center',vertical:'center'}},
  name:{font:{sz:11,name:'Arial'},alignment:{horizontal:'left',vertical:'center'}},
  hide:{font:{sz:1,name:'Arial',color:{rgb:'FFFFFF'}},alignment:{horizontal:'left'}}
};
function _xs(base){return{font:Object.assign({},base.font),fill:base.fill?{fgColor:Object.assign({},base.fill.fgColor)}:undefined,border:_XS.bdr,alignment:Object.assign({},base.alignment)};}
function _xsSet(ws,r,c,val,style){
  var addr=XLSX.utils.encode_cell({r:r,c:c});
  if(!ws[addr])ws[addr]={v:val||'',t:'s'};
  ws[addr].v=val||'';ws[addr].t='s';
  ws[addr].s=style;
}
function _xsSetRange(ws,ref){if(!ws['!merges'])ws['!merges']=[];ws['!merges'].push(ref);}

// ═══════════════════════════════════════════════════════════════
// SHEET HƯỚNG DẪN NHẬP — dùng chung cho mọi file mẫu (theo TT27)
// Format giống mẫu CSDL ngành: 4 cột STT/Tên cột/Hướng dẫn/Ghi chú
// ═══════════════════════════════════════════════════════════════
function _buildHuongDanSheet(){
  var rows=[
    ['STT','Tên cột','Hướng dẫn nhập','Ghi chú'],
    [1,'Môn học và hoạt động giáo dục','',''],
    [2,'Mức đạt được','Nhập 1 trong các giá trị T, H, C','T = Hoàn thành Tốt; H = Hoàn thành; C = Chưa hoàn thành'],
    [3,'Điểm KTĐK','Nhập điểm từ 1 đến 10, không nhập điểm thập phân','Bài kiểm tra định kỳ — chỉ nhập số nguyên'],
    [4,'Năng lực','Nhập 1 trong các giá trị T, Đ, C','T = Tốt; Đ = Đạt; C = Cần cố gắng'],
    [5,'Phẩm chất','Nhập 1 trong các giá trị T, Đ, C','T = Tốt; Đ = Đạt; C = Cần cố gắng'],
    [6,'Khen thưởng','Nếu có thông tin nhập "x", nếu không bỏ trống',''],
    [7,'Hoàn thành chương trình lớp','Nếu có thông tin nhập "x", nếu không bỏ trống',''],
    [8,'Lên lớp','Nếu có thông tin nhập "x", nếu không bỏ trống',''],
    [9,'Xếp loại','Nhập 1 trong các giá trị HTXS, HTT, HT, CHT','HTXS = Hoàn thành Xuất sắc; HTT = Hoàn thành Tốt; HT = Hoàn thành; CHT = Chưa Hoàn thành']
  ];
  var ws=XLSX.utils.aoa_to_sheet(rows);
  // Style header xanh lá nhạt
  var headerStyle={
    font:{bold:true,sz:11,name:'Arial'},
    fill:{fgColor:{rgb:'C6EFCE'}},
    alignment:{horizontal:'center',vertical:'center',wrapText:true},
    border:_XS.bdr
  };
  // Style body căn trái + wrap
  var bodyStyleC={font:{sz:11,name:'Arial'},alignment:{horizontal:'center',vertical:'center'},border:_XS.bdr};
  var bodyStyleL={font:{sz:11,name:'Arial'},alignment:{horizontal:'left',vertical:'center',wrapText:true},border:_XS.bdr};
  for(var r=0;r<rows.length;r++){
    for(var c=0;c<4;c++){
      var addr=XLSX.utils.encode_cell({r:r,c:c});
      if(!ws[addr]) ws[addr]={v:rows[r][c]||'',t:typeof rows[r][c]==='number'?'n':'s'};
      ws[addr].s = (r===0)?headerStyle:(c===0?bodyStyleC:bodyStyleL);
    }
  }
  ws['!cols']=[{wch:5},{wch:34},{wch:56},{wch:48}];
  // Row heights — header cao hơn, body 22pt
  var rh=[{hpt:24}];
  for(var i=1;i<rows.length;i++) rh.push({hpt:22});
  ws['!rows']=rh;
  ws['!ref']='A1:D'+rows.length;
  return ws;
}

// ═══════════════════════════════════════════════════════════════
// ADMIN: XUẤT FILE MẪU
// ═══════════════════════════════════════════════════════════════
function createMauChuan(){
  var lop=T('d-lop').value;
  if(!lop){toast('⚠️ Chọn lớp trước','warn');return;}
  var k=parseInt(lop);
  var periodName=PERIODS.find(function(p){return p.id===curPeriod;}).name;
  var periodCode={gk1:'GK1',ck1:'CK1',gk2:'GK2',cn:'CN'}[curPeriod]||'GK2';
  var isCN=(curPeriod==='cn');
  var hsLop=mySB().filter(function(s){return s.lop===lop;});
  if(!hsLop.length){toast('⚠️ Không có HS lớp '+lop,'warn');return;}
  var sj=_visibleSubj(k);

  // Chuẩn bị cột
  var monH=[],monK=[];
  sj.forEach(function(mn){
    var hd=_hasDiem(mn,k);
    monH.push({n:mn[0],k:mn[1],dk:hd?mn[2]:null,hd:hd});
    monK.push(mn[1]);if(hd)monK.push(mn[2]);
  });
  var totalMon=monH.reduce(function(s,m){return s+(m.hd?2:1);},0);
  var nlC=NL.slice(0,NL_CHUNG_IDX),nlD=_getNLDacThu(k);
  var tailH=isCN?['Hoàn thành CT','Lên lớp','Khen thưởng']:[];
  var tailK=isCN?['hoan_thanh','len_lop','khen_thuong']:[];

  var ws={};
  // ═══ ROW LAYOUT ═══
  // Row 0: TITLE — tên trường, năm học, lớp, kỳ
  // Row 1-3: 3-row composite header (group / sub / detail name)
  // Row 4: KEY ROW (hidden)
  // Row 5+: DATA
  // (Hướng dẫn nhập đã chuyển sang sheet "Huong_Dan" riêng — giống mẫu CSDL ngành)
  var R_HDR=1, R_KEY=4, R_DATA=5;
  var schoolName=localStorage.getItem('school_name_full')||'TRƯỜNG TIỂU HỌC DIỄN LIÊN';
  var namHoc='2025-2026'; // TODO: đọc từ Config sheet

  // ── ROW 0-2: Headers ──
  var ci=5; // after STT,Lớp,Mã,Tên,NS
  // Info cols (merge 3 rows)
  ['STT','Mã lớp','Mã học sinh','Họ tên','Ngày sinh'].forEach(function(h,i){
    _xsSet(ws,R_HDR,i,h,_xs(_XS.green));_xsSet(ws,R_HDR+1,i,'',_xs(_XS.green));_xsSet(ws,R_HDR+2,i,'',_xs(_XS.green));
    _xsSetRange(ws,{s:{r:R_HDR,c:i},e:{r:R_HDR+2,c:i}});
  });

  // Môn group
  _xsSet(ws,R_HDR,ci,'Môn học và hoạt động giáo dục',_xs(_XS.greenDk));
  for(var fi=ci+1;fi<ci+totalMon;fi++)_xsSet(ws,R_HDR,fi,'',_xs(_XS.greenDk));
  _xsSetRange(ws,{s:{r:R_HDR,c:ci},e:{r:R_HDR,c:ci+totalMon-1}});

  // Môn names (row HDR+1, HDR+2)
  var ci2=ci;
  monH.forEach(function(m){
    if(m.hd){
      _xsSet(ws,R_HDR+1,ci2,m.n,_xs(_XS.blue));_xsSet(ws,R_HDR+1,ci2+1,'',_xs(_XS.blue));
      _xsSetRange(ws,{s:{r:R_HDR+1,c:ci2},e:{r:R_HDR+1,c:ci2+1}});
      _xsSet(ws,R_HDR+2,ci2,'Mức đạt được',_xs(_XS.blue));
      _xsSet(ws,R_HDR+2,ci2+1,'Điểm KTĐK',_xs(_XS.blue));
      ci2+=2;
    }else{
      _xsSet(ws,R_HDR+1,ci2,m.n,_xs(_XS.blue));_xsSet(ws,R_HDR+2,ci2,'',_xs(_XS.blue));
      _xsSetRange(ws,{s:{r:R_HDR+1,c:ci2},e:{r:R_HDR+2,c:ci2}});
      ci2++;
    }
  });

  // NL group
  var nlStart=ci2;
  _xsSet(ws,R_HDR,nlStart,'Năng lực cốt lõi',_xs(_XS.orangeDk));
  for(var fi=nlStart+1;fi<nlStart+nlC.length+nlD.length;fi++)_xsSet(ws,R_HDR,fi,'',_xs(_XS.orangeDk));
  _xsSetRange(ws,{s:{r:R_HDR,c:nlStart},e:{r:R_HDR,c:nlStart+nlC.length+nlD.length-1}});
  // NL chung sub
  _xsSet(ws,R_HDR+1,nlStart,'Năng lực chung',_xs(_XS.orange));
  for(var fi=nlStart+1;fi<nlStart+nlC.length;fi++)_xsSet(ws,R_HDR+1,fi,'',_xs(_XS.orange));
  _xsSetRange(ws,{s:{r:R_HDR+1,c:nlStart},e:{r:R_HDR+1,c:nlStart+nlC.length-1}});
  nlC.forEach(function(nl,i){_xsSet(ws,R_HDR+2,nlStart+i,nl[0],_xs(_XS.orange));});
  // NL đặc thù sub
  var nldS=nlStart+nlC.length;
  _xsSet(ws,R_HDR+1,nldS,'Năng lực đặc thù',_xs(_XS.orange));
  for(var fi=nldS+1;fi<nldS+nlD.length;fi++)_xsSet(ws,R_HDR+1,fi,'',_xs(_XS.orange));
  _xsSetRange(ws,{s:{r:R_HDR+1,c:nldS},e:{r:R_HDR+1,c:nldS+nlD.length-1}});
  nlD.forEach(function(nl,i){_xsSet(ws,R_HDR+2,nldS+i,nl[0],_xs(_XS.orange));});

  // PC group
  var pcStart=nldS+nlD.length;
  _xsSet(ws,R_HDR,pcStart,'Phẩm chất chủ yếu',_xs(_XS.purpleDk));
  for(var fi=pcStart+1;fi<pcStart+PC.length;fi++)_xsSet(ws,R_HDR,fi,'',_xs(_XS.purpleDk));
  _xsSetRange(ws,{s:{r:R_HDR,c:pcStart},e:{r:R_HDR,c:pcStart+PC.length-1}});
  PC.forEach(function(pc,i){
    _xsSet(ws,R_HDR+1,pcStart+i,pc[0],_xs(_XS.purple));_xsSet(ws,R_HDR+2,pcStart+i,'',_xs(_XS.purple));
    _xsSetRange(ws,{s:{r:R_HDR+1,c:pcStart+i},e:{r:R_HDR+2,c:pcStart+i}});
  });

  // Tail
  var tlStart=pcStart+PC.length;
  tailH.forEach(function(t,i){
    _xsSet(ws,R_HDR,tlStart+i,t,_xs(_XS.yellow));_xsSet(ws,R_HDR+1,tlStart+i,'',_xs(_XS.yellow));_xsSet(ws,R_HDR+2,tlStart+i,'',_xs(_XS.yellow));
    _xsSetRange(ws,{s:{r:R_HDR,c:tlStart+i},e:{r:R_HDR+2,c:tlStart+i}});
  });

  var totalCols=tlStart+tailH.length;

  // ── ROW 0: TITLE (xem sheet "Huong_Dan" để biết quy tắc nhập) ──
  _xsSet(ws,0,0,schoolName+' — NĂM HỌC '+namHoc+' — LỚP '+lop+' — KỲ: '+periodName.toUpperCase()+'  (Xem sheet "Huong_Dan" để biết quy tắc nhập)',_xs(_XS.infoDk));
  for(var i=1;i<totalCols;i++) _xsSet(ws,0,i,'',_xs(_XS.infoDk));
  _xsSetRange(ws,{s:{r:0,c:0},e:{r:0,c:totalCols-1}});

  // ── ROW 4: KEY ROW (hidden) ──
  var allKeys=['__KEYS__','_lop_','_ma_','_ten_','_ns_'].concat(monK);
  nlC.forEach(function(nl){allKeys.push(nl[1]);});
  nlD.forEach(function(nl){allKeys.push(nl[1]);});
  PC.forEach(function(pc){allKeys.push(pc[1]);});
  tailK.forEach(function(k){allKeys.push(k);});
  allKeys.forEach(function(k,i){_xsSet(ws,R_KEY,i,k,_xs(_XS.hide));});

  // ── ROW 6+: DATA ──
  hsLop.forEach(function(s,idx){
    var r=idx+R_DATA,g=grades[s.ma]||{},ci3=0;
    _xsSet(ws,r,ci3++,String(idx+1),_xs(_XS.data));
    _xsSet(ws,r,ci3++,s.lop,_xs(_XS.data));
    _xsSet(ws,r,ci3++,String(s.ma),_xs(_XS.data));
    _xsSet(ws,r,ci3++,s.ten,_xs(_XS.name));
    _xsSet(ws,r,ci3++,s.ns||'',_xs(_XS.data));
    monH.forEach(function(m){
      var mv=g[m.k]||'';_xsSet(ws,r,ci3++,mv?_storeToDisplay(mv,'mon'):'',_xs(_XS.data));
      if(m.hd){var dv=g[m.dk]||'';_xsSet(ws,r,ci3++,dv?String(dv):'',_xs(_XS.data));}
    });
    nlC.forEach(function(nl){var v=g[nl[1]]||'';_xsSet(ws,r,ci3++,v?_storeToDisplay(v,'nlpc'):'',_xs(_XS.data));});
    nlD.forEach(function(nl){var v=g[nl[1]]||'';_xsSet(ws,r,ci3++,v?_storeToDisplay(v,'nlpc'):'',_xs(_XS.data));});
    PC.forEach(function(pc){var v=g[pc[1]]||'';_xsSet(ws,r,ci3++,v?_storeToDisplay(v,'nlpc'):'',_xs(_XS.data));});
    tailK.forEach(function(k){_xsSet(ws,r,ci3++,g[k]||'',_xs(_XS.data));});
  });

  // Range & cols
  // !ref: 1 row title + 3 row header + 1 row key + N row data
  ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:hsLop.length+R_DATA-1,c:totalCols-1}});
  // Width: STT/Mã lớp/Mã HS/Họ tên/Ngày sinh — giữ rộng. Cột nhập điểm/mức đạt → wch:5 cho gọn A4 ngang
  var cols=[{wch:5},{wch:6},{wch:14},{wch:22},{wch:11}];
  for(var i=5;i<totalCols;i++)cols.push({wch:5});
  ws['!cols']=cols;
  // Row heights: [title 28, HDR group 25, HDR sub 22, HDR name 38 (wrap "Mức đạt"+"Điểm KTĐK"), KEY 3px hidden]
  ws['!rows']=[{hpt:28},{hpt:25},{hpt:22},{hpt:38},{hpt:3}];

  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,periodCode+'_Lop'+lop);
  XLSX.utils.book_append_sheet(wb,_buildHuongDanSheet(),'Huong_Dan');
  XLSX.writeFile(wb,'Mau_'+periodCode+'_Khoi'+k+'_Lop'+lop+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('📥 Mẫu '+periodName+' — Lớp '+lop+' ('+hsLop.length+' HS)','ok');
}

// ═══════════════════════════════════════════════════════════════
// GV: TẢI MẪU THEO PHÂN CÔNG
// ═══════════════════════════════════════════════════════════════
function dlMauGV(){
  var subjMap=_getGVSubjects();
  if(!subjMap){toast('⚠️ Không có phân công giảng dạy','warn');return;}
  var allLops=[];
  Object.keys(subjMap).forEach(function(key){subjMap[key].forEach(function(lop){if(allLops.indexOf(lop)<0)allLops.push(lop);});});
  allLops.sort();
  if(!allLops.length){toast('⚠️ Không có lớp nào','warn');return;}
  var allHS=[];
  allLops.forEach(function(lop){mySB().filter(function(s){return s.lop===lop;}).forEach(function(s){allHS.push(s);});});
  if(!allHS.length){toast('⚠️ Không có HS','warn');return;}

  var periodName=PERIODS.find(function(p){return p.id===curPeriod;}).name;
  var isGVCN=!!(CU&&CU.lop&&CU.lop.trim());
  var isCN=(curPeriod==='cn');
  var maxKhoi=Math.max.apply(null,allLops.map(function(l){return parseInt(l)||1;}));

  var subjKeys=Object.keys(subjMap).filter(function(k){return k.indexOf('mon_')===0;});
  var monCols=[],monKeyList=[];
  subjKeys.forEach(function(skey){
    var name=_subjKeyToName(skey);
    var anyDiem=allLops.some(function(lop){return _subjHasDiem(skey,parseInt(lop));});
    if(anyDiem){monCols.push({n:name,k:skey,dk:'diem_'+skey.replace('mon_',''),hd:true});monKeyList.push(skey);monKeyList.push('diem_'+skey.replace('mon_',''));}
    else{monCols.push({n:name,k:skey,dk:null,hd:false});monKeyList.push(skey);}
  });
  var totalMon=monCols.reduce(function(s,m){return s+(m.hd?2:1);},0);

  var nlKeys=[],pcKeys=[];
  if(isGVCN){_getAllNL(maxKhoi).forEach(function(nl){nlKeys.push(nl[1]);});PC.forEach(function(pc){pcKeys.push(pc[1]);});}
  Object.keys(subjMap).forEach(function(k){
    if(k.indexOf('nl_')===0&&nlKeys.indexOf(k)<0)nlKeys.push(k);
    if(k.indexOf('pc_')===0&&pcKeys.indexOf(k)<0)pcKeys.push(k);
  });
  var tailKeys=isCN&&isGVCN?['len_lop']:[];
  var totalCols=4+totalMon+nlKeys.length+pcKeys.length+tailKeys.length;

  var ws={};
  // ═══ ROW LAYOUT ═══
  // Row 0: TITLE (tên trường, năm học, GV, kỳ)
  // Row 1: Group headers (Môn học | Năng lực | Phẩm chất | Tail)
  // Row 2: Detail names (Toán (Mức đạt), NL: Tự chủ..., PC: Yêu nước, ...)
  // Row 3: KEY ROW (hidden 3pt)
  // Row 4+: DATA
  // (Hướng dẫn nhập đã chuyển sang sheet "Huong_Dan" riêng)
  var R_HDR_GROUP=1, R_HDR_NAME=2, R_KEY=3, R_DATA=4;
  var schoolName=localStorage.getItem('school_name_full')||'TRƯỜNG TIỂU HỌC DIỄN LIÊN';
  var namHoc='2025-2026';

  // ROW 0: Title (xem sheet "Huong_Dan" để biết quy tắc nhập)
  _xsSet(ws,0,0,schoolName+' — NĂM HỌC '+namHoc+' — KỲ: '+periodName.toUpperCase()+' — Giáo viên: '+(CU.hoten||CU.username)+'  (Xem sheet "Huong_Dan" để biết quy tắc nhập)',_xs(_XS.infoDk));
  for(var i=1;i<totalCols;i++)_xsSet(ws,0,i,'',_xs(_XS.infoDk));
  _xsSetRange(ws,{s:{r:0,c:0},e:{r:0,c:totalCols-1}});

  // ROW 1-2: Group headers + detail names
  ['STT','Lớp','Mã học sinh','Họ tên'].forEach(function(h,i){
    _xsSet(ws,R_HDR_GROUP,i,h,_xs(_XS.green));_xsSet(ws,R_HDR_NAME,i,'',_xs(_XS.green));
    _xsSetRange(ws,{s:{r:R_HDR_GROUP,c:i},e:{r:R_HDR_NAME,c:i}});
  });

  var ci=4;
  if(totalMon>0){
    _xsSet(ws,R_HDR_GROUP,ci,'Môn học và hoạt động giáo dục',_xs(_XS.monDk));
    for(var fi=ci+1;fi<ci+totalMon;fi++)_xsSet(ws,R_HDR_GROUP,fi,'',_xs(_XS.monDk));
    _xsSetRange(ws,{s:{r:R_HDR_GROUP,c:ci},e:{r:R_HDR_GROUP,c:ci+totalMon-1}});
  }
  // Mon names (row HDR_NAME)
  var ci2=ci;
  monCols.forEach(function(m){
    if(m.hd){_xsSet(ws,R_HDR_NAME,ci2,m.n+' (Mức đạt)',_xs(_XS.blue));_xsSet(ws,R_HDR_NAME,ci2+1,m.n+' (Điểm KTĐK)',_xs(_XS.blue));ci2+=2;}
    else{_xsSet(ws,R_HDR_NAME,ci2,m.n,_xs(_XS.blue));ci2++;}
  });

  if(nlKeys.length>0){
    _xsSet(ws,R_HDR_GROUP,ci2,'Năng lực',_xs(_XS.nlDk));
    for(var fi=ci2+1;fi<ci2+nlKeys.length;fi++)_xsSet(ws,R_HDR_GROUP,fi,'',_xs(_XS.nlDk));
    _xsSetRange(ws,{s:{r:R_HDR_GROUP,c:ci2},e:{r:R_HDR_GROUP,c:ci2+nlKeys.length-1}});
    nlKeys.forEach(function(k,i){_xsSet(ws,R_HDR_NAME,ci2+i,_subjKeyToName(k),_xs(_XS.orange));});
    ci2+=nlKeys.length;
  }
  if(pcKeys.length>0){
    _xsSet(ws,R_HDR_GROUP,ci2,'Phẩm chất',_xs(_XS.pcDk));
    for(var fi=ci2+1;fi<ci2+pcKeys.length;fi++)_xsSet(ws,R_HDR_GROUP,fi,'',_xs(_XS.pcDk));
    _xsSetRange(ws,{s:{r:R_HDR_GROUP,c:ci2},e:{r:R_HDR_GROUP,c:ci2+pcKeys.length-1}});
    pcKeys.forEach(function(k,i){_xsSet(ws,R_HDR_NAME,ci2+i,_subjKeyToName(k),_xs(_XS.purple));});
    ci2+=pcKeys.length;
  }
  tailKeys.forEach(function(k,i){
    _xsSet(ws,R_HDR_GROUP,ci2+i,'Lên lớp',_xs(_XS.yellow));_xsSet(ws,R_HDR_NAME,ci2+i,'',_xs(_XS.yellow));
    _xsSetRange(ws,{s:{r:R_HDR_GROUP,c:ci2+i},e:{r:R_HDR_NAME,c:ci2+i}});
  });

  // ROW 4: KEY ROW (hidden)
  var allK=['__KEYS__','_lop_','_ma_','_ten_'].concat(monKeyList,nlKeys,pcKeys,tailKeys);
  allK.forEach(function(k,i){_xsSet(ws,R_KEY,i,k,_xs(_XS.hide));});

  // ROW 5+: DATA
  allHS.forEach(function(s,idx){
    var r=idx+R_DATA,g=grades[s.ma]||{},ci3=0;
    _xsSet(ws,r,ci3++,String(idx+1),_xs(_XS.data));
    _xsSet(ws,r,ci3++,s.lop,_xs(_XS.data));
    _xsSet(ws,r,ci3++,String(s.ma),_xs(_XS.data));
    _xsSet(ws,r,ci3++,s.ten,_xs(_XS.name));
    monCols.forEach(function(m){
      var mv=g[m.k]||'';_xsSet(ws,r,ci3++,mv?_storeToDisplay(mv,'mon'):'',_xs(_XS.data));
      if(m.hd){var dk=_subjDiemKey(m.k,s.khoi);_xsSet(ws,r,ci3++,dk&&g[dk]!==undefined?String(g[dk]):'',_xs(_XS.data));}
    });
    nlKeys.forEach(function(k){var v=g[k]||'';_xsSet(ws,r,ci3++,v?_storeToDisplay(v,'nlpc'):'',_xs(_XS.data));});
    pcKeys.forEach(function(k){var v=g[k]||'';_xsSet(ws,r,ci3++,v?_storeToDisplay(v,'nlpc'):'',_xs(_XS.data));});
    tailKeys.forEach(function(k){_xsSet(ws,r,ci3++,g[k]||'',_xs(_XS.data));});
  });

  ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:allHS.length+R_DATA-1,c:totalCols-1}});
  // Width: STT/Lớp/Mã/Tên — giữ rộng. Cột nhập điểm/mức đạt → wch:5 cho gọn A4 ngang
  var cols=[{wch:5},{wch:6},{wch:14},{wch:22}];
  for(var i=4;i<totalCols;i++)cols.push({wch:5});
  ws['!cols']=cols;
  // Row heights: [title 28, HDR group 24, HDR name 38 (wrap "Mức đạt"+"Điểm KTĐK"), KEY 3px hidden]
  ws['!rows']=[{hpt:28},{hpt:24},{hpt:38},{hpt:3}];

  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'KetQua');
  XLSX.utils.book_append_sheet(wb,_buildHuongDanSheet(),'Huong_Dan');
  XLSX.writeFile(wb,'NhapDiem_'+(CU.hoten||CU.username).replace(/\s/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('📥 Mẫu '+periodName+': '+allHS.length+' HS ('+allLops.join(', ')+')','ok');
}

function onDiemFile(inp){
  if(!inp.files.length)return;
  var lop=T('d-lop').value||null; // null = tất cả lớp
  var file=inp.files[0];
  if(file.size>5*1024*1024){toast('❌ File quá lớn (>5MB)','err');inp.value='';return;}
  loader('Đọc file Excel...');
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      loader();
      var wb=XLSX.read(e.target.result,{type:'array'});
      var ws=wb.Sheets[wb.SheetNames[0]];
      var raw=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      _parseDiemExcel(raw,lop);
    }catch(err){
      loader();toast('❌ Lỗi đọc file: '+err.message,'err');
    }
  };
  reader.readAsArrayBuffer(file);
  inp.value='';
}

function _parseDiemExcel(raw,lop){
  var k=lop?parseInt(lop):0;

  // ═══ TÌM KEY ROW (ưu tiên) HOẶC HEADER ROW ═══
  var keyRow=-1, headerRow=-1, dataStart=-1;
  for(var ri=0;ri<Math.min(raw.length,15);ri++){
    var rowCells=(raw[ri]||[]);
    for(var ci=0;ci<rowCells.length;ci++){
      var cv=String(rowCells[ci]||'').trim();
      if(cv==='__KEYS__'){keyRow=ri;dataStart=ri+1;break;}
    }
    if(keyRow>=0) break;
    // Tìm header row: dòng có STT hoặc Mã HS hoặc Họ tên
    if(headerRow<0){
      var cellsA=rowCells.map(function(c){return String(c||'').trim().toLowerCase();});
      var hasStt=cellsA.some(function(c){return c==='stt';});
      var hasMa=cellsA.some(function(c){return c==='mã học sinh'||c==='ma hoc sinh'||c==='mã hs';});
      var hasHoTen=cellsA.some(function(c){return c==='họ tên'||c==='ho ten'||c==='họ và tên';});
      if(hasStt||(hasMa&&hasHoTen)) headerRow=ri;
    }
  }

  // ═══ PHƯƠNG PHÁP 1: KEY ROW (chính xác 100%) ═══
  if(keyRow>=0){
    var keys=raw[keyRow];
    var colMap={};
    var iMa=-1;
    keys.forEach(function(v,ci){
      var key=String(v||'').trim();
      if(!key) return;
      if(key==='_ma_'){iMa=ci;return;}
      if(key.indexOf('mon_')===0||key.indexOf('diem_')===0||key.indexOf('nl_')===0||key.indexOf('pc_')===0||
         key==='len_lop'||key==='hoan_thanh'||key==='khen_thuong'){
        var type=key.indexOf('mon_')===0?'mon':key.indexOf('diem_')===0?'diem':(key==='len_lop'?'ll':'nlpc');
        colMap[key]={ci:ci,key:key,type:type};
      }
    });
    if(iMa<0){
      for(var di=dataStart;di<Math.min(raw.length,dataStart+3);di++){
        for(var fi=0;fi<(raw[di]||[]).length;fi++){
          if(/^\d{8,}$/.test(String((raw[di]||[])[fi]||'').trim())){iMa=fi;break;}
        }
        if(iMa>=0)break;
      }
    }
    if(iMa<0){toast('❌ Không tìm thấy cột Mã HS','err');return;}
    console.log('KEY ROW: '+Object.keys(colMap).length+' cols, iMa='+iMa);
    return _applyParsedData(raw,dataStart,iMa,colMap,lop,k);
  }

  // ═══ PHƯƠNG PHÁP 2: FUZZY (fallback) ═══
  function _a(s){return String(s||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[\u0111\u0110]/g,'d').toLowerCase().replace(/\s+/g,' ');}
  if(headerRow<0){
    for(var ri=0;ri<10;ri++){
      var nxt=raw[ri+1]||[];
      if(nxt.some(function(c){return/^\d{8,}$/.test(String(c).trim());})){headerRow=ri;break;}
    }
  }
  if(headerRow<0){toast('❌ Không tìm thấy tiêu đề','err');return;}

  var maxCols=0;
  for(var ri=0;ri<=headerRow+1;ri++) maxCols=Math.max(maxCols,(raw[ri]||[]).length);
  dataStart=headerRow+1;
  var extraRow=raw[headerRow+1]||[];
  if(extraRow.length>0&&!extraRow.some(function(c){return/^\d{8,}$/.test(String(c||'').trim());})){dataStart=headerRow+2;}

  var composites=[];
  for(var ci=0;ci<maxCols;ci++){
    var parts=[];
    for(var ri=0;ri<=Math.min(headerRow+1,dataStart-1);ri++){
      var v=_a((raw[ri]||[])[ci]);
      if(v&&v.length>0) parts.push(v);
    }
    composites.push(parts.join(' '));
  }

  var iMa=-1;
  composites.forEach(function(c,i){if((c.indexOf('ma hoc sinh')>=0||(c.indexOf('ma')>=0&&c.indexOf('hoc')>=0))&&iMa<0) iMa=i;});
  if(iMa<0){for(var di=dataStart;di<Math.min(raw.length,dataStart+3);di++){for(var fi=0;fi<(raw[di]||[]).length;fi++){if(/^\d{8,}$/.test(String((raw[di]||[])[fi]||'').trim())){iMa=fi;break;}}if(iMa>=0)break;}}
  if(iMa<0){toast('❌ Không tìm thấy cột Mã HS','err');return;}

  var P=[
    {p:['toan'],k:'mon_Toán',t:'mon'},{p:['tieng viet'],k:'mon_Tiếng_việt',t:'mon'},
    {p:['dao duc'],k:'mon_Đạo_đức',t:'mon'},{p:['tu nhien','xa hoi'],k:'mon_Tự_nhiên_và_xã_hội',t:'mon'},
    {p:['ngoai ngu','tieng anh'],k:'mon_Ngoại_ngữ',t:'mon'},{p:['tieng dan toc'],k:'mon_Tiếng_dân_tộc',t:'mon'},
    {p:['tin hoc','th-cn'],k:'mon_TH-CN_Tin_học',t:'mon'},
    {p:['am nhac'],k:'mon_Nghệ_thuật_Âm_nhạc',t:'mon'},{p:['mi thuat','my thuat'],k:'mon_Nghệ_thuật_Mĩ_thuật',t:'mon'},
    {p:['trai nghiem','hdtn'],k:'mon_Hoạt_động_trải_nghiệm',t:'mon'},
    {p:['the chat','gdtc'],k:'mon_Giáo_dục_thể_chất',t:'mon'},
    {p:['tu chu'],k:'nl_Tự_chủ_và_tự_học',t:'nlpc'},{p:['giao tiep'],k:'nl_Giao_tiếp_và_hợp_tác',t:'nlpc'},
    {p:['giai quyet','sang tao'],k:'nl_Giải_quyết_vấn_đề_và_sáng_tạo',t:'nlpc'},
    {p:['ngon ngu'],k:'nl_Ngôn_ngữ',t:'nlpc'},{p:['tinh toan'],k:'nl_Tính_toán',t:'nlpc'},
    {p:['khoa hoc'],k:'nl_Khoa_học',t:'nlpc'},{p:['cong nghe'],k:'nl_Công_nghệ',t:'nlpc'},{p:['tin hoc'],k:'nl_Tin_học',t:'nlpc'},{p:['tham mi','tham my'],k:'nl_Thẩm_mĩ',t:'nlpc'},
    {p:['yeu nuoc'],k:'pc_Yêu_nước',t:'nlpc'},{p:['nhan ai'],k:'pc_Nhân_ái',t:'nlpc'},
    {p:['cham chi'],k:'pc_Chăm_chỉ',t:'nlpc'},{p:['trung thuc'],k:'pc_Trung_thực',t:'nlpc'},
    {p:['trach nhiem'],k:'pc_Trách_nhiệm',t:'nlpc'},{p:['len lop'],k:'len_lop',t:'ll'}
  ];
  var colMap={};
  composites.forEach(function(comp,ci){
    if(ci===iMa)return;
    P.forEach(function(pat){
      if(colMap[pat.k])return;
      if(pat.p.some(function(pp){return comp.indexOf(pp)>=0;})){
        colMap[pat.k]={ci:ci,key:pat.k,type:pat.t};
      }
    });
  });
  console.log('FUZZY: '+Object.keys(colMap).length+' cols, iMa='+iMa);
  return _applyParsedData(raw,dataStart,iMa,colMap,lop,k);
}

function _applyParsedData(raw,dataStart,iMa,colMap,lop,k){
  var dataRows=raw.slice(dataStart);
  var updated=0,skipped=0,errors=[];
  dataRows.forEach(function(row,ri){
    var ma=String(row[iMa]||'').trim();
    if(!ma||!/^\d{4,}$/.test(ma))return;
    var hs=mySB().find(function(s){return String(s.ma)===ma;});
    if(!hs){skipped++;return;}
    if(lop&&hs.lop!==lop){skipped++;return;}
    var g=Object.assign({},grades[ma]||{});
    var hasData=false;
    Object.keys(colMap).forEach(function(ck){
      var col=colMap[ck];
      var val=String(row[col.ci]||'').trim();
      if(!val)return;
      if(col.type==='mon'){
        var m={T:'HTT',H:'HT',C:'CHT',HTT:'HTT',HT:'HT',CHT:'CHT'}[val.toUpperCase()];
        if(m){g[col.key]=m;hasData=true;}
      }else if(col.type==='diem'){
        var num=parseInt(val);
        if(!isNaN(num)&&num>=0&&num<=10){g[col.key]=String(num);hasData=true;}
      }else if(col.type==='nlpc'){
        var m2={'T':'T','Đ':'Đ','D':'Đ','C':'CCG','CCG':'CCG'}[val.toUpperCase()]||{'T':'T','Đ':'Đ','C':'CCG'}[val];
        if(m2){g[col.key]=m2;hasData=true;}
      }else if(col.type==='ll'){
        if(val.toLowerCase()==='x'||val==='Có'){g[col.key]='Có';hasData=true;}
      }
    });
    if(hasData){
      if(curPeriod==='cn'){var kq=cTT(ma,hs.khoi);if(kq){g.hoan_thanh=kq==='CHT'?'CHT':'HT';g.kqgd=kq;}}
      g.updated_at=new Date().toLocaleString('vi-VN');
      g.updated_by=CU?CU.username:'excel';
      grades[ma]=g;_markDirty(ma);updated++;
    }
  });
  _saveGradesToStorage();merge();updateAll();
  var msg='✅ Nhập: '+updated+' HS';
  if(skipped)msg+=', '+skipped+' bỏ qua';
  toast(msg,'ok');
  T('d-import-info').innerHTML='<span style="color:var(--g)">'+updated+' HS đã nhập</span>'+(skipped?' · <span style="color:var(--o)">'+skipped+' bỏ qua</span>':'');
  if(T('d-gv-info'))T('d-gv-info').innerHTML='<span style="color:var(--g)">'+updated+' HS đã nhập</span>'+(skipped?' · <span style="color:var(--o)">'+skipped+' bỏ qua</span>':'');
  if(updated>0&&GAS){T('d-import-info').innerHTML+=' — <span style="color:var(--o)">Đang lưu...</span>';setTimeout(function(){saveAllLop();},500);}
}

// ┌──────────────────────────────────────────────────────────┐
// │  GV BỘ MÔN — TẢI MẪU & NHẬP THEO PHÂN CÔNG            │
// └──────────────────────────────────────────────────────────┘

function _getGVSubjects(){
  // Lấy danh sách môn + lớp GV được phân công
  if(!userPerm||!Object.keys(userPerm).length)return null;
  // Gom: {subjectKey: [lop1, lop2,...]}
  var subjMap={};
  Object.keys(userPerm).forEach(function(lop){
    userPerm[lop].forEach(function(key){
      if(!subjMap[key])subjMap[key]=[];
      if(subjMap[key].indexOf(lop)<0)subjMap[key].push(lop);
    });
  });
  return subjMap;
}

function _subjKeyToName(key){
  // Tên đầy đủ theo TT27 + CT GDPT 2018 (TT 32/2018) — dùng cho tiêu đề cột Excel mẫu
  var map={
    // ── 11 môn học và HĐGD ──
    'mon_Toán':'Toán','mon_Tiếng_việt':'Tiếng Việt','mon_Đạo_đức':'Đạo đức',
    'mon_Tự_nhiên_và_xã_hội':'Tự nhiên và Xã hội','mon_Ngoại_ngữ':'Ngoại ngữ',
    'mon_Tiếng_dân_tộc':'Tiếng dân tộc',
    'mon_TH-CN_Tin_học':'Tin học','mon_TH-CN_Công_nghệ':'Công nghệ',
    'mon_Khoa_học':'Khoa học','mon_Lịch_sử_và_Địa_lí':'Lịch sử và Địa lí',
    'mon_Nghệ_thuật_Âm_nhạc':'Âm nhạc','mon_Nghệ_thuật_Mĩ_thuật':'Mĩ thuật',
    'mon_Hoạt_động_trải_nghiệm':'Hoạt động trải nghiệm','mon_Giáo_dục_thể_chất':'Giáo dục thể chất',
    // ── 3 NL chung ──
    'nl_Tự_chủ_và_tự_học':'NL: Tự chủ và tự học',
    'nl_Giao_tiếp_và_hợp_tác':'NL: Giao tiếp và hợp tác',
    'nl_Giải_quyết_vấn_đề_và_sáng_tạo':'NL: Giải quyết vấn đề và sáng tạo',
    // ── 7 NL đặc thù (K3-5: đủ 7; K1-2: chỉ 5 đầu tiên) ──
    'nl_Ngôn_ngữ':'NL: Ngôn ngữ','nl_Tính_toán':'NL: Tính toán','nl_Khoa_học':'NL: Khoa học',
    'nl_Công_nghệ':'NL: Công nghệ','nl_Tin_học':'NL: Tin học',
    'nl_Thẩm_mĩ':'NL: Thẩm mĩ','nl_Thể_chất':'NL: Thể chất',
    // ── 5 PC chủ yếu ──
    'pc_Yêu_nước':'PC: Yêu nước','pc_Nhân_ái':'PC: Nhân ái',
    'pc_Chăm_chỉ':'PC: Chăm chỉ','pc_Trung_thực':'PC: Trung thực','pc_Trách_nhiệm':'PC: Trách nhiệm'
  };
  return map[key]||key;
}

function _subjHasDiem(key,khoi){
  // TT27 Đ7 — Bài kiểm tra định kỳ:
  //  • Cuối HK1 (ck1) + Cuối năm (cn): mọi môn bắt buộc CÓ điểm KTĐK
  //    (K1-2: T+TV; K3: T+TV+NN; K4-5: T+TV+NN+KH+LS-ĐL+Tin học+Công nghệ)
  //  • Giữa HK1 (gk1) + Giữa HK2 (gk2): CHỈ K4-5 có điểm KTĐK,
  //    và CHỈ 2 môn Toán + Tiếng Việt
  var sj=SUBJ[String(khoi)]||SUBJ['1'];
  for(var i=0;i<sj.length;i++){
    if(sj[i][1]===key){
      if(!sj[i][2]||!sj[i][3])return false;     // Môn không có cấu trúc điểm
      if(curPeriod==='cn'||curPeriod==='ck1') return true;  // CK1 + CN: đủ điểm
      // Giữa kỳ (gk1, gk2): chỉ K4-5, chỉ Toán + TV
      if(khoi<=3) return false;
      return key==='mon_Toán'||key==='mon_Tiếng_việt';
    }
  }
  return false;
}

function _subjDiemKey(monKey,khoi){
  var sj=SUBJ[String(khoi)]||SUBJ['1'];
  for(var i=0;i<sj.length;i++){
    if(sj[i][1]===monKey&&sj[i][2]&&sj[i][3])return sj[i][2];
  }
  return null;
}


function onDiemFileGV(inp){
  if(!inp.files.length)return;
  var file=inp.files[0];
  if(file.size>5*1024*1024){toast('❌ File quá lớn','err');inp.value='';return;}
  loader('Đọc file...');
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      loader();
      var wb=XLSX.read(e.target.result,{type:'array'});
      var ws=wb.Sheets[wb.SheetNames[0]];
      var raw=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      // Dùng parser chung (hỗ trợ key row) — lop=null = không lọc theo lớp
      _parseDiemExcel(raw,null);
    }catch(err){loader();toast('❌ '+err.message,'err');}
  };
  reader.readAsArrayBuffer(file);
  inp.value='';
}

function _parseDiemGV(raw,subjMap){
  // Strip diacritics for robust matching
  function _ascii(s){return String(s||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[\u0111\u0110]/g,'d').toLowerCase();}

  // Tìm header row: dòng có CÁC Ô RIÊNG LẺ match "STT", "Ma HS", "Ho va ten" (không phải 1 câu dài)
  var headerRow=-1;
  for(var ri=0;ri<Math.min(raw.length,10);ri++){
    var cells=raw[ri].map(function(c){return _ascii(c);});
    // Header row = dòng có ô riêng "stt" VÀ ô riêng chứa "ma" hoặc "ho"
    var hasStt=cells.some(function(c){return c==='stt';});
    var hasMa=cells.some(function(c){return c==='ma hs'||c==='ma';});
    var hasHo=cells.some(function(c){return c.indexOf('ho va ten')>=0||c.indexOf('ho ten')>=0||c==='ho va ten';});
    // Mỗi ô phải ngắn (< 30 ký tự) → loại dòng hướng dẫn dài
    var shortCells=cells.filter(function(c){return c.length>0&&c.length<35;}).length;
    if(hasStt&&(hasMa||hasHo)&&shortCells>=4){headerRow=ri;break;}
  }
  if(headerRow<0){
    // Fallback: tìm dòng có nhiều ô text ngắn (>=6) + dòng sau có số dài
    for(var ri=0;ri<Math.min(raw.length,8);ri++){
      var shortText=raw[ri].filter(function(c){var s=String(c).trim();return s.length>0&&s.length<35&&isNaN(s);}).length;
      var hasNum=false;
      for(var di=ri+1;di<Math.min(raw.length,ri+4);di++){if(raw[di]&&raw[di].some(function(c){return/^\d{5,}$/.test(String(c).trim());})){hasNum=true;break;}}
      if(shortText>=6&&hasNum){headerRow=ri;break;}
    }
  }
  if(headerRow<0){toast('\u274c Khong tim thay dong tieu de','err');return;}

  var headers=raw[headerRow].map(function(h){return String(h||'').trim();});
  var headersA=headers.map(function(h){return _ascii(h);});

  // Tìm cột bằng ASCII match
  var iMa=-1,iLop=-1,iTen=-1;
  headersA.forEach(function(h,i){
    if(iMa<0&&(h==='ma hs'||h.indexOf('ma')>=0&&h.indexOf('hs')>=0))iMa=i;
    if(iLop<0&&h==='lop')iLop=i;
    if(iTen<0&&(h.indexOf('ho va ten')>=0||h.indexOf('ho ten')>=0))iTen=i;
  });
  // Fallback: tìm cột chứa số dài trong data rows
  if(iMa<0){
    for(var di=headerRow+1;di<Math.min(raw.length,headerRow+5);di++){
      if(!raw[di])continue;
      for(var fi=0;fi<raw[di].length;fi++){
        if(/^\d{8,}$/.test(String(raw[di][fi]||'').trim())){iMa=fi;break;}
      }
      if(iMa>=0)break;
    }
  }
  if(iMa<0){toast('\u274c Khong tim thay cot Ma HS','err');return;}

  // Map header -> subject key bằng ASCII
  var subjKeys=Object.keys(subjMap);
  var isGVCN=!!(CU&&CU.lop&&CU.lop.trim());
  var colMapping={};
  headers.forEach(function(h,ci){
    if(ci===iMa||ci===iLop||ci===iTen||headersA[ci]==='stt')return;
    var ha=_ascii(h);
    // Match subject columns — hỗ trợ cả tên cũ "(ĐG)/(Điểm)" và tên mới "(Mức đạt)/(Điểm KTĐK)"
    subjKeys.forEach(function(skey){
      var nameA=_ascii(_subjKeyToName(skey));
      if(skey.indexOf('mon_')===0){
        // Cột "Mức đạt được": match "(dg)", "(muc dat)", "(muc dat duoc)" hoặc chứa "muc dat"
        if(ha.indexOf(nameA)===0 && (ha.indexOf('(dg)')>0||ha.indexOf('muc dat')>0)){
          colMapping[ci]={key:skey,type:'mon'};
        }
        // Cột "Điểm KTĐK": match "(diem)", "(diem ktdk)" hoặc chứa "ktdk"
        else if(ha.indexOf(nameA)===0 && (ha.indexOf('(diem)')>0||ha.indexOf('ktdk')>0)){
          colMapping[ci]={key:skey,type:'diem'};
        }
      }else{
        if(ha===nameA||ha.indexOf(nameA)===0&&ha.length-nameA.length<5)colMapping[ci]={key:skey,type:'nlpc'};
      }
    });
    // GVCN: match NL + PC + Lên lớp columns
    if(isGVCN){
      // ★ Duyệt đủ NL theo khối CỦA GVCN: K1-2 có 5 NL đặc thù, K3-5 có 7
      //   (Trước đây chỉ duyệt mảng NL gốc → mất cột Công nghệ/Tin học cho K3-5)
      var khoiCN=parseInt(CU.lop)||1;
      var allNLForCN=_getAllNL(khoiCN);
      allNLForCN.forEach(function(nl){
        var nlA=_ascii('NL: '+nl[0]);
        if(ha===nlA||ha===_ascii(nl[0]))colMapping[ci]={key:nl[1],type:'nlpc'};
      });
      PC.forEach(function(pc){
        var pcA=_ascii('PC: '+pc[0]);
        if(ha===pcA||ha===_ascii(pc[0]))colMapping[ci]={key:pc[1],type:'nlpc'};
      });
      if(ha==='len lop'||ha.indexOf('len lop')>=0)colMapping[ci]={key:'len_lop',type:'ll'};
    }
  });
  console.log('GV Parse - headerRow:'+headerRow+' iMa:'+iMa+' cols:'+Object.keys(colMapping).length+' GVCN:'+isGVCN);

  // Skip notes rows
  var dataRows=raw.slice(headerRow+1);
  while(dataRows.length>0){
    var testMa=String(dataRows[0][iMa]||'').trim();
    if(/^\d{5,}$/.test(testMa))break;
    dataRows=dataRows.slice(1);
  }

  var updated=0,skipped=0,errors=[];

  dataRows.forEach(function(row,ri){
    var ma=String(row[iMa]||'').trim();
    if(!ma)return;
    var hs=mySB().find(function(s){return s.ma===ma;});
    if(!hs){skipped++;return;}

    // Kiểm tra quyền: GV bộ môn cần có phân công cho lớp, GVCN được nhập lớp mình
    var canWrite=!!(userPerm&&userPerm[hs.lop])||(isGVCN&&CU.lop===hs.lop);
    if(!canWrite){skipped++;return;}

    var g=Object.assign({},grades[ma]||{});
    var hasData=false;

    Object.keys(colMapping).forEach(function(ci){
      var col=colMapping[ci];
      var val=String(row[parseInt(ci)]||'').trim();
      if(!val)return;

      if(col.type==='mon'){
        var upper=val.toUpperCase();
        var mapped={T:'HTT',H:'HT',C:'CHT',HTT:'HTT',HT:'HT',CHT:'CHT'}[upper];
        if(mapped){g[col.key]=mapped;hasData=true;}
        else errors.push('Dòng '+(ri+1)+': "'+val+'" ≠ T/H/C');
      }else if(col.type==='diem'){
        var dk=_subjDiemKey(col.key,hs.khoi);
        if(dk){
          var num=parseInt(val);
          if(!isNaN(num)&&num>=0&&num<=10){g[dk]=String(num);hasData=true;}
          else errors.push('Dòng '+(ri+1)+': Điểm "'+val+'" ≠ 0-10');
        }
      }else if(col.type==='nlpc'){
        var mappedNL={T:'T','Đ':'Đ',D:'Đ',C:'CCG',CCG:'CCG'}[val.toUpperCase()]||{T:'T','Đ':'Đ',C:'CCG'}[val];
        if(mappedNL){g[col.key]=mappedNL;hasData=true;}
        else errors.push('Dòng '+(ri+1)+': "'+val+'" ≠ T/Đ/C');
      }else if(col.type==='ll'){
        if(val.toLowerCase()==='x'||val==='Có'){g[col.key]='Có';hasData=true;}
        else if(val==='Không'||val==='-'){g[col.key]='Không';hasData=true;}
      }
    });

    if(hasData){
      // GVCN: tự tính KQGD
      if(isGVCN){var kq=cTT(ma,hs.khoi);if(kq){g.hoan_thanh=kq==='CHT'?'CHT':'HT';g.kqgd=kq;}}
      g.updated_at=new Date().toLocaleString('vi-VN');
      g.updated_by=CU?CU.username:'gv';
      grades[ma]=g;
      updated++;
    }
  });

  _saveGradesToStorage()
  merge();updateAll();

  var msg='✅ Nhập xong: '+updated+' HS cập nhật';
  if(skipped)msg+=', '+skipped+' bỏ qua';
  toast(msg,errors.length?'warn':'ok');

  T('d-gv-info').innerHTML='<span style="color:var(--g)">'+updated+' HS đã nhập</span>'
    +(skipped?' · <span style="color:var(--o)">'+skipped+' bỏ qua</span>':'')
    +(errors.length?' · <span style="color:var(--r)">'+errors.length+' lỗi</span>':'');

  // Auto-save to Sheets
  if(updated>0&&GAS){
    T('d-gv-info').innerHTML+=' — <span style="color:var(--o)">Đang lưu lên Sheets...</span>';
    setTimeout(function(){saveAllLop();},500);
  }

  if(errors.length>0&&errors.length<=15){
    console.warn('Lỗi nhập Excel GV:');
    errors.forEach(function(e){console.warn('  '+e);});
  }
}


// ┌──────────────────────────────────────────────────────────┐
// │  ĐỒNG BỘ CSDL NGÀNH — XUẤT 5 FILE THEO KHỐI            │
// └──────────────────────────────────────────────────────────┘

function _csdlSubjects(k){
  // TẤT CẢ môn (bao gồm Tiếng dân tộc) theo đúng thứ tự mẫu CSDL ngành
  var sj=SUBJ[String(k)]||SUBJ['1'];
  return sj; // Không ẩn Tiếng dân tộc cho CSDL
}

function _csdlNLDacThu(k){
  var base=NL.slice(NL_CHUNG_IDX).map(function(x){return{name:x[0],key:x[1]};});
  if(k>=3){
    // K3-5: thêm Công nghệ + Tin học (chuẩn TT27 + CT GDPT 2018)
    // Thứ tự: Ngôn ngữ → Tính toán → Khoa học → Công nghệ → Tin học → Thẩm mĩ → Thể chất
    // Key PHẢI khớp với storage (có dấu) để lookup data đúng
    var insertAt=3;
    base.splice(insertAt,0,
      {name:'Công nghệ',key:'nl_Công_nghệ'},
      {name:'Tin học',  key:'nl_Tin_học'}
    );
  }
  return base;
}

// ════════════════════════════════════════════════════════════════════
// HSS Extension ID — lưu trong localStorage, không hardcode trong code
// Người dùng dán ID qua modal "Đồng bộ CSDL ngành" trong website
// ════════════════════════════════════════════════════════════════════
function _hssGetExtId(){return (localStorage.getItem('hss_ext_id')||'').trim();}
function _hssSetExtId(id){
  if(id&&id.length>=20)localStorage.setItem('hss_ext_id',id.trim());
  else localStorage.removeItem('hss_ext_id');
}

// ════════════════════════════════════════════════════════════════════
// showCSDLPicker — Modal đồng bộ CSDL ngành (v2: tự động + thủ công)
// ════════════════════════════════════════════════════════════════════
function showCSDLPicker(){
  if(!needAdmin('Đồng bộ CSDL ngành'))return;

  // Nếu chưa cấu hình extension → mở wizard cài đặt thay vì modal đồng bộ
  if(!_hssCheckExtension()){
    _hssShowWizard();
    return;
  }

  var extOk=_hssCheckExtension();
  var curKy=curPeriod||'cn';

  var curExtId=_hssGetExtId();

  var html=''+
  '<div style="padding:4px 0">'+
    // Trạng thái Extension
    '<div id="ext-badge" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;margin-bottom:'+(extOk?'16px':'10px')+';background:'+(extOk?'#f0fdf4':'#fef2f2')+';border:1.5px solid '+(extOk?'#86efac':'#fca5a5')+'">'+
      '<span style="font-size:20px">'+(extOk?'✅':'❌')+'</span>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-weight:700;font-size:13px;color:'+(extOk?'#166534':'#991b1b')+'">'+(extOk?'Extension đã kết nối':'Chưa cấu hình Extension')+'</div>'+
        '<div style="font-size:11px;color:var(--slate3);word-break:break-all">'+(extOk?'ID: <code style="font-size:10.5px">'+curExtId.substring(0,12)+'…</code>':'Cần dán Extension ID hoặc dùng nút xuất thủ công')+'</div>'+
      '</div>'+
      (extOk?'<button onclick="_hssClearExtId()" style="padding:5px 10px;border:1px solid #86efac;background:white;color:#166534;border-radius:6px;font-size:11px;cursor:pointer">Đổi</button>':'')+
    '</div>'+

    // Form nhập ID (chỉ hiện khi chưa cấu hình)
    (extOk?'':_hssExtConfigHTML())+

    // Chọn Khối + Kỳ
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">'+
      '<div>'+
        '<label style="font-size:12px;font-weight:600;color:var(--slate2);display:block;margin-bottom:5px">Khối lớp</label>'+
        '<select id="csdl-khoi" style="width:100%;padding:8px 10px;border:1.5px solid var(--slate6);border-radius:8px;font-size:13px">'+
          '<option value="1">Khối 1</option><option value="2">Khối 2</option><option value="3">Khối 3</option><option value="4">Khối 4</option><option value="5">Khối 5</option>'+
          '<option value="all">🏫 Tất cả (5 khối)</option>'+
        '</select>'+
      '</div>'+
      '<div>'+
        '<label style="font-size:12px;font-weight:600;color:var(--slate2);display:block;margin-bottom:5px">Kỳ đánh giá</label>'+
        '<select id="csdl-ky" style="width:100%;padding:8px 10px;border:1.5px solid var(--slate6);border-radius:8px;font-size:13px">'+
          '<option value="gk1"'+(curKy==='gk1'?' selected':'')+'>Giữa HK1</option>'+
          '<option value="ck1"'+(curKy==='ck1'?' selected':'')+'>Cuối HK1</option>'+
          '<option value="gk2"'+(curKy==='gk2'?' selected':'')+'>Giữa HK2</option>'+
          '<option value="cn"'+(curKy==='cn'?' selected':'')+'>Cuối năm học</option>'+
        '</select>'+
      '</div>'+
    '</div>'+

    // Thanh tiến trình
    '<div id="csdl-progress" style="display:none;margin-bottom:14px">'+
      '<div style="height:8px;background:var(--slate6);border-radius:4px;overflow:hidden;margin-bottom:6px">'+
        '<div id="csdl-pbar" style="height:100%;background:var(--blue,#3b82f6);width:0%;transition:width .5s;border-radius:4px"></div>'+
      '</div>'+
      '<div id="csdl-plog" style="font-size:11px;font-family:monospace;color:var(--slate2);background:var(--slate7,#f1f5f9);border-radius:6px;padding:8px 10px;max-height:120px;overflow-y:auto;line-height:1.8">Đang khởi động...</div>'+
    '</div>'+

    // Nút hành động
    '<div style="display:flex;flex-direction:column;gap:8px">'+
      '<button onclick="startCSDLSync()" id="btn-csdl-sync"'+(extOk?'':' disabled')+' style="width:100%;padding:12px;border:none;border-radius:10px;background:'+(extOk?'linear-gradient(135deg,#1e40af,#3b82f6)':'#e5e7eb')+';color:'+(extOk?'#fff':'#9ca3af')+';font-size:14px;font-weight:700;cursor:'+(extOk?'pointer':'not-allowed')+';display:flex;align-items:center;justify-content:center;gap:8px">🚀 Đồng bộ tự động lên CSDL ngành</button>'+
      '<button onclick="_hssExportManual()" style="width:100%;padding:10px;border:1.5px solid var(--slate5,#cbd5e1);border-radius:10px;background:white;color:var(--slate2);font-size:13px;cursor:pointer">📥 Chỉ xuất Excel (upload thủ công)</button>'+
    '</div>'+

    // Hướng dẫn
    '<div style="margin-top:14px;padding:10px 12px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:6px;font-size:11.5px;color:#78350f;line-height:1.8">'+
      '<strong>⚠️ Điều kiện trước khi đồng bộ tự động:</strong><br>'+
      '1. Mở CSDL ngành (truong.csdl.moet.gov.vn) trên Chrome<br>'+
      '2. Đăng nhập + nhập CAPTCHA thủ công (1 lần)<br>'+
      '3. Quay lại đây → nhấn nút trên → Extension tự làm phần còn lại'+
    '</div>'+
  '</div>';

  T('csdlBd').innerHTML=html;
  T('csdlBg').classList.add('on');
}

// Kiểm tra extension đã được cấu hình (đã có ID + Chrome có sẵn)
function _hssCheckExtension(){
  if(typeof chrome==='undefined'||!chrome.runtime||!chrome.runtime.sendMessage)return false;
  return _hssGetExtId().length>=20;
}

// Ping extension để xác minh ID đúng + extension đang chạy
// callback(ok, message)
function _hssVerifyExtension(id,callback){
  if(typeof chrome==='undefined'||!chrome.runtime||!chrome.runtime.sendMessage){
    callback(false,'Trình duyệt không phải Chrome / không hỗ trợ extension');
    return;
  }
  try{
    chrome.runtime.sendMessage(id,{action:'ping'},function(resp){
      if(chrome.runtime.lastError){
        callback(false,'Không kết nối được extension. Kiểm tra: 1) Đã cài extension chưa? 2) Đã bật chế độ nhà phát triển? 3) ID có đúng không?');
        return;
      }
      if(resp&&resp.ok){
        callback(true,'Extension OK (v'+(resp.version||'?')+')');
      }else{
        callback(false,'Extension phản hồi không hợp lệ');
      }
    });
  }catch(e){
    callback(false,'Lỗi: '+e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// LISTENER: Bắt postMessage từ extension (qlcl-bridge.js)
// Khi extension cài rồi & user vào QLCL, ID tự động được lưu
// ════════════════════════════════════════════════════════════════════
window.addEventListener('message',function(e){
  if(e.source!==window)return;
  var d=e.data;
  if(!d||d.source!=='hss-sync-extension'||d.type!=='HSS_EXT_ANNOUNCE'||!d.id)return;
  var cur=_hssGetExtId();
  if(cur!==d.id){
    _hssSetExtId(d.id);
    try{toast('🔌 Đã kết nối extension HSS Sync v'+(d.version||'?'),'ok');}catch(_){}
  }
  _hssOnExtConnected();
});

// Yêu cầu extension phát lại ID (gọi khi mở wizard step 4)
function _hssRequestExtId(){
  try{
    window.postMessage({source:'hss-sync-qlcl',type:'HSS_EXT_REQUEST'},'*');
  }catch(_){}
}

// Được gọi khi extension đã kết nối (qua listener trên)
function _hssOnExtConnected(){
  // Update live status box trong wizard step 4
  var statusBox=T('hss-wizard-status');
  if(statusBox){
    statusBox.innerHTML='<div style="font-size:18px;margin-bottom:6px">✅</div><div style="font-weight:700">Đã kết nối extension!</div><div style="font-size:11px;margin-top:4px">ID: <code style="font-size:10.5px">'+_hssGetExtId().substring(0,16)+'…</code></div>';
    statusBox.style.background='#dcfce7';
    statusBox.style.color='#166534';
    statusBox.style.borderColor='#86efac';
    var doneBtn=T('hss-wizard-done');
    if(doneBtn){doneBtn.disabled=false;doneBtn.style.opacity='1';doneBtn.style.cursor='pointer';}
  }
  // Nếu modal đồng bộ chính đang mở, refresh để hiển thị "đã kết nối"
  var syncBtn=T('btn-csdl-sync');
  if(syncBtn){showCSDLPicker();}
}

// ════════════════════════════════════════════════════════════════════
// WIZARD 4 BƯỚC — hướng dẫn cài extension trực quan
// ════════════════════════════════════════════════════════════════════
var _hssWizardStep=1;

function _hssShowWizard(){
  _hssWizardStep=1;
  _hssRenderWizard();
  T('csdlBg').classList.add('on');
}

function _hssWizardNext(){if(_hssWizardStep<4){_hssWizardStep++;_hssRenderWizard();}}
function _hssWizardBack(){if(_hssWizardStep>1){_hssWizardStep--;_hssRenderWizard();}}

function _hssWizardClose(){
  cm('csdlBg');
  // Nếu đã kết nối → mở lại modal đồng bộ chính
  if(_hssCheckExtension())setTimeout(showCSDLPicker,200);
}

function _hssCopyText(text,btnId){
  try{
    navigator.clipboard.writeText(text);
    var b=T(btnId);if(b){var old=b.innerHTML;b.innerHTML='✅ Đã sao chép';setTimeout(function(){b.innerHTML=old;},1500);}
  }catch(_){
    toast('Không sao chép được. Hãy chọn thủ công và Ctrl+C','warn');
  }
}

function _hssRenderWizard(){
  var step=_hssWizardStep;
  var html=''+
  '<div style="padding:4px 0">'+
    // Header với progress
    '<div style="text-align:center;margin-bottom:18px">'+
      '<div style="font-size:30px;margin-bottom:6px">🪄</div>'+
      '<div style="font-size:15px;font-weight:700;color:var(--navy)">Trình cài đặt HSS Sync</div>'+
      '<div style="font-size:11px;color:var(--slate3);margin-top:2px">Bước '+step+' / 4</div>'+
    '</div>'+
    // Progress bar
    '<div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;margin-bottom:18px">'+
      '<div style="height:100%;background:linear-gradient(90deg,#1e40af,#3b82f6);width:'+(step*25)+'%;transition:width .3s;border-radius:3px"></div>'+
    '</div>'+
    // Nội dung step
    '<div style="min-height:240px">'+_hssWizardStepHTML(step)+'</div>'+
    // Nút điều hướng
    '<div style="display:flex;gap:8px;margin-top:18px">'+
      (step>1?'<button onclick="_hssWizardBack()" style="flex:1;padding:10px;border:1.5px solid #cbd5e1;background:white;border-radius:8px;font-size:13px;cursor:pointer">← Quay lại</button>':'')+
      (step<4?'<button onclick="_hssWizardNext()" style="flex:2;padding:10px;border:none;background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Tiếp theo →</button>':'<button id="hss-wizard-done" onclick="_hssWizardClose()" '+(_hssCheckExtension()?'':'disabled')+' style="flex:2;padding:10px;border:none;background:'+(_hssCheckExtension()?'linear-gradient(135deg,#16a34a,#22c55e)':'#e5e7eb')+';color:'+(_hssCheckExtension()?'#fff':'#9ca3af')+';border-radius:8px;font-size:13px;font-weight:700;cursor:'+(_hssCheckExtension()?'pointer':'not-allowed')+';opacity:'+(_hssCheckExtension()?'1':'.7')+'">✓ Hoàn tất</button>')+
    '</div>'+
    // Fallback: nhập tay hoặc bỏ qua
    '<div style="text-align:center;margin-top:14px;line-height:1.9">'+
      '<a href="#" onclick="event.preventDefault();_hssShowManualInput()" style="font-size:11px;color:var(--slate3);text-decoration:underline">🔧 Nhập Extension ID thủ công</a>'+
      '<span style="color:var(--slate5);margin:0 6px">·</span>'+
      '<a href="#" onclick="event.preventDefault();cm(\'csdlBg\');expCSDLAll()" style="font-size:11px;color:var(--slate3);text-decoration:underline">📥 Chỉ xuất Excel (bỏ qua extension)</a>'+
    '</div>'+
  '</div>';
  T('csdlBd').innerHTML=html;

  // Step 4: yêu cầu extension phát lại ID + auto-poll mỗi 1s trong 10s
  if(step===4){
    _hssRequestExtId();
    var tries=0;
    var poll=setInterval(function(){
      tries++;
      if(_hssCheckExtension()||tries>10||_hssWizardStep!==4){clearInterval(poll);return;}
      _hssRequestExtId();
    },1000);
  }
}

function _hssWizardStepHTML(step){
  if(step===1){
    return ''+
    '<div style="font-size:13px;color:var(--slate2);line-height:1.7">'+
      '<div style="font-weight:700;font-size:14px;color:var(--navy);margin-bottom:10px">📦 Bước 1: Chuẩn bị thư mục extension</div>'+
      '<p>Trên máy của thầy/cô đã có sẵn thư mục extension. Đường dẫn:</p>'+
      '<div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;padding:10px;font-family:monospace;font-size:11.5px;color:#1e40af;margin:10px 0;word-break:break-all">…\\THDienLien\\hss-sync-extension</div>'+
      '<p>Nếu chưa có, nhờ Nhà trường gửi file <strong>hss-sync-extension-v2.zip</strong> rồi giải nén ra một thư mục cố định (vd: Documents, Desktop).</p>'+
      '<div style="margin-top:14px;padding:10px 12px;background:#eff6ff;border-left:3px solid #3b82f6;border-radius:6px;font-size:11.5px;color:#1e3a8a">'+
        '💡 <strong>Lưu ý:</strong> KHÔNG xoá thư mục này sau khi cài. Chrome cần đường dẫn thật để chạy extension.'+
      '</div>'+
    '</div>';
  }
  if(step===2){
    return ''+
    '<div style="font-size:13px;color:var(--slate2);line-height:1.7">'+
      '<div style="font-weight:700;font-size:14px;color:var(--navy);margin-bottom:10px">🌐 Bước 2: Mở trang Extensions của Chrome</div>'+
      '<p>Mở 1 tab Chrome mới, gõ địa chỉ này vào thanh URL:</p>'+
      '<div style="display:flex;gap:6px;align-items:center;margin:10px 0">'+
        '<code style="flex:1;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;padding:9px 12px;font-size:13px;color:#1e40af">chrome://extensions/</code>'+
        '<button id="hss-copy-url" onclick="_hssCopyText(\'chrome://extensions/\',\'hss-copy-url\')" style="padding:9px 12px;border:none;background:#1e40af;color:#fff;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600">📋 Sao chép</button>'+
      '</div>'+
      '<p>Trong trang Extensions, bật <strong>Chế độ nhà phát triển</strong> (góc trên bên phải):</p>'+
      '<div style="background:white;border:1.5px dashed #cbd5e1;border-radius:8px;padding:14px;margin:8px 0;display:flex;justify-content:space-between;align-items:center">'+
        '<span style="font-size:12px;color:#64748b">Chế độ nhà phát triển</span>'+
        '<div style="width:40px;height:22px;background:#3b82f6;border-radius:11px;position:relative"><div style="width:18px;height:18px;background:white;border-radius:50%;position:absolute;top:2px;right:2px;box-shadow:0 1px 3px rgba(0,0,0,.2)"></div></div>'+
      '</div>'+
      '<div style="font-size:11px;color:var(--slate3)">↑ Công tắc đổi sang màu xanh là đã bật</div>'+
    '</div>';
  }
  if(step===3){
    return ''+
    '<div style="font-size:13px;color:var(--slate2);line-height:1.7">'+
      '<div style="font-weight:700;font-size:14px;color:var(--navy);margin-bottom:10px">📂 Bước 3: Cài extension</div>'+
      '<p>Trong trang Extensions vừa mở, bấm nút <strong>"Tải tiện ích chưa đóng gói"</strong> (xuất hiện khi đã bật Dev mode):</p>'+
      '<div style="background:white;border:1.5px solid #1e40af;border-radius:8px;padding:8px 14px;margin:10px 0;display:inline-block;color:#1e40af;font-weight:600;font-size:12px">📁 Tải tiện ích chưa đóng gói</div>'+
      '<p>Hộp thoại chọn thư mục hiện ra → tìm và chọn thư mục <strong>hss-sync-extension</strong> đã chuẩn bị ở Bước 1 → bấm <strong>"Chọn thư mục"</strong>.</p>'+
      '<div style="margin-top:14px;padding:10px 12px;background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;font-size:11.5px;color:#14532d;line-height:1.7">'+
        '✅ Sau khi cài, extension <strong>"HSS Sync — Đồng bộ CSDL Ngành"</strong> xuất hiện trong danh sách.<br>'+
        '💡 <em>Mẹo:</em> Bấm icon 🧩 trên thanh Chrome → 📌 ghim HSS Sync để dễ thấy.'+
      '</div>'+
    '</div>';
  }
  // Step 4
  var ok=_hssCheckExtension();
  return ''+
  '<div style="font-size:13px;color:var(--slate2);line-height:1.7">'+
    '<div style="font-weight:700;font-size:14px;color:var(--navy);margin-bottom:10px">🎯 Bước 4: Kết nối với QLCL</div>'+
    '<p>Khi extension cài thành công, nó sẽ <strong>tự động</strong> gửi mã kết nối sang QLCL. Thầy/cô <strong>không cần copy/paste gì cả</strong>.</p>'+
    '<div id="hss-wizard-status" style="text-align:center;padding:24px 16px;border-radius:10px;margin:14px 0;border:1.5px solid '+(ok?'#86efac':'#fcd34d')+';background:'+(ok?'#dcfce7':'#fef3c7')+';color:'+(ok?'#166534':'#92400e')+'">'+
      (ok?
        '<div style="font-size:18px;margin-bottom:6px">✅</div><div style="font-weight:700">Đã kết nối extension!</div><div style="font-size:11px;margin-top:4px">ID: <code style="font-size:10.5px">'+_hssGetExtId().substring(0,16)+'…</code></div>':
        '<div style="font-size:18px;margin-bottom:6px">⏳</div><div style="font-weight:700">Đang chờ extension...</div><div style="font-size:11.5px;margin-top:6px;line-height:1.6">Nếu đã cài xong, hãy <strong>F5 (tải lại)</strong> trang QLCL này.<br>Sau vài giây, ô này sẽ chuyển sang ✅</div>'
      )+
    '</div>'+
    '<p style="font-size:11.5px;color:var(--slate3);text-align:center">Vẫn không kết nối được? Bấm <em>"Nhập Extension ID thủ công"</em> bên dưới để dán mã ID bằng tay.</p>'+
  '</div>';
}

// Form nhập Extension ID thủ công (fallback nếu auto-detect không hoạt động)
function _hssShowManualInput(){
  var curId=_hssGetExtId();
  T('csdlBd').innerHTML=''+
    '<div style="text-align:center;margin-bottom:14px">'+
      '<div style="font-size:30px;margin-bottom:6px">🔧</div>'+
      '<div style="font-size:15px;font-weight:700;color:var(--navy)">Nhập Extension ID thủ công</div>'+
    '</div>'+
    '<div style="background:#fef3c7;border:1.5px solid #f59e0b;border-radius:10px;padding:14px;margin-bottom:14px">'+
      '<div style="font-size:11.5px;color:#78350f;line-height:1.7;margin-bottom:10px">'+
        '<strong>1.</strong> Vào <code>chrome://extensions/</code> → tìm extension <strong>HSS Sync</strong><br>'+
        '<strong>2.</strong> Copy chuỗi <em>ID</em> (dài ~32 ký tự, ngay dưới tên extension)<br>'+
        '<strong>3.</strong> Dán vào ô dưới → bấm <strong>"Kiểm tra & Lưu"</strong>'+
      '</div>'+
      '<input id="hss-ext-input" type="text" value="'+(curId||'')+'" placeholder="vd: abcdefghijklmnopqrstuvwxyzabcdef" style="width:100%;padding:9px 10px;border:1.5px solid #cbd5e1;border-radius:8px;font-family:monospace;font-size:12px;box-sizing:border-box;margin-bottom:8px">'+
      '<button onclick="_hssSaveExtIdFromInput()" style="width:100%;padding:10px;border:none;border-radius:8px;background:#1e40af;color:#fff;font-size:13px;font-weight:700;cursor:pointer">✅ Kiểm tra &amp; Lưu</button>'+
    '</div>'+
    '<div style="text-align:center">'+
      '<a href="#" onclick="event.preventDefault();_hssShowWizard()" style="font-size:11px;color:var(--slate3);text-decoration:underline">← Quay lại trình cài đặt</a>'+
    '</div>';
  T('csdlBg').classList.add('on');
}

// Xử lý nút "Kiểm tra & Lưu" — verify + lưu localStorage + render lại modal
function _hssSaveExtIdFromInput(){
  var id=(T('hss-ext-input').value||'').trim();
  if(id.length<20){
    toast('⚠️ Extension ID không hợp lệ (phải dài 20+ ký tự)','warn');
    return;
  }
  loader('Kiểm tra extension...');
  _hssVerifyExtension(id,function(ok,msg){
    loader();
    if(ok){
      _hssSetExtId(id);
      toast('✅ '+msg+' — Đã lưu','ok');
      showCSDLPicker(); // render lại modal với trạng thái đã cấu hình
    }else{
      toast('❌ '+msg,'err');
    }
  });
}

// Đổi / xoá Extension ID
function _hssClearExtId(){
  if(!confirm('Xoá Extension ID đã lưu? Bạn sẽ phải nhập lại để đồng bộ tự động.'))return;
  _hssSetExtId('');
  toast('🗑 Đã xoá Extension ID','ok');
  showCSDLPicker();
}

// Bắt đầu đồng bộ tự động qua extension
function startCSDLSync(){
  var khoi=T('csdl-khoi').value;
  var ky=T('csdl-ky').value;

  var prog=T('csdl-progress');
  var pbar=T('csdl-pbar');
  var plog=T('csdl-plog');
  prog.style.display='block';
  plog.innerHTML='';

  function plogLine(msg,pct){
    var div=document.createElement('div');
    div.textContent=new Date().toLocaleTimeString()+' — '+msg;
    plog.appendChild(div);
    plog.scrollTop=plog.scrollHeight;
    if(pct!=null)pbar.style.width=pct+'%';
  }

  T('btn-csdl-sync').disabled=true;

  var khoiList=khoi==='all'?['1','2','3','4','5']:[khoi];
  var i=0;

  function nextKhoi(){
    if(i>=khoiList.length){
      pbar.style.width='100%';
      plogLine('🎉 Hoàn tất đồng bộ!',100);
      toast('✅ Đã đồng bộ lên CSDL ngành thành công!','ok');
      T('btn-csdl-sync').disabled=false;
      return;
    }

    var k=khoiList[i];
    var pct=Math.round((i/khoiList.length)*90);
    plogLine('🚀 Đồng bộ Khối '+k+'...',pct);

    chrome.runtime.sendMessage(
      _hssGetExtId(),
      {action:'uploadToMOET',apiUrl:API_URL,khoi:k,ky:ky},
      function(response){
        if(chrome.runtime.lastError){
          plogLine('❌ Khối '+k+' lỗi: '+chrome.runtime.lastError.message);
        }else if(response&&response.step==='error'){
          plogLine('❌ Khối '+k+' lỗi: '+(response.msg||'Không rõ'));
        }else{
          plogLine('✅ Khối '+k+': '+((response&&response.msg)||'Xong'),pct+18);
        }

        i++;
        if(i<khoiList.length){
          plogLine('⏳ Chờ 3 giây trước khối tiếp theo...');
          setTimeout(nextKhoi,3000);
        }else{
          nextKhoi();
        }
      }
    );
  }

  nextKhoi();
}

// Xuất Excel thủ công — tôn trọng khối user chọn trong dropdown
function _hssExportManual(){
  var khoi=T('csdl-khoi')?T('csdl-khoi').value:'all';
  cm('csdlBg');
  if(khoi==='all'){
    expCSDLAll();
  }else{
    loader('Xuất Excel Khối '+khoi+'...');
    setTimeout(function(){
      _expCSDLKhoi(parseInt(khoi,10));
      loader();
      toast('🏛️ Đã xuất file Excel Khối '+khoi,'ok');
    },300);
  }
}

/*  ──────────────────────────────────────────────────────────────────
    BACKUP: showCSDLPicker (v1) — chỉ xuất Excel theo khối, không đồng bộ
    Đã thay bằng phiên bản v2 ở trên.
    ──────────────────────────────────────────────────────────────────
function _showCSDLPickerOld(){
  var period=PERIODS.find(function(p){return p.id===curPeriod;});
  var h='<div style="text-align:center;margin-bottom:20px"><div style="font-size:36px;margin-bottom:8px">🏛️</div>';
  h+='<h3 style="font-size:16px;font-weight:700;color:var(--navy);margin-bottom:4px">Đồng bộ CSDL ngành</h3>';
  h+='<p style="font-size:12px;color:var(--slate3)">Kỳ: <strong style="color:'+period.color+'">'+period.name+'</strong> — Chọn khối lớp để xuất</p></div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:400px;margin:0 auto">';
  [1,2,3,4,5].forEach(function(k){
    var count=mySB().filter(function(s){return s.khoi===k;}).length;
    var colors=['','#2563eb','#059669','#d97706','#7c3aed','#e11d48'];
    h+='<div onclick="_expCSDLKhoi('+k+');cm(&quot;csdlBg&quot;)" style="cursor:pointer;padding:16px;border-radius:12px;border:2px solid #e2e8f0;text-align:center;transition:all .2s;background:white" onmouseover="this.style.borderColor=&quot;'+colors[k]+'&quot;;this.style.background=&quot;#f8fafc&quot;" onmouseout="this.style.borderColor=&quot;#e2e8f0&quot;;this.style.background=&quot;white&quot;">';
    h+='<div style="font-size:24px;font-weight:800;color:'+colors[k]+'">Lớp '+k+'</div>';
    h+='<div style="font-size:11px;color:var(--slate3);margin-top:4px">'+count+' học sinh</div></div>';
  });
  h+='</div>';
  h+='<div style="text-align:center;margin-top:16px"><button class="btn bout" onclick="expCSDLAll()" style="font-size:12px">📦 Xuất tất cả 5 khối</button></div>';
  T('csdlBd').innerHTML=h;
  T('csdlBg').classList.add('on');
}
*/

function expCSDLAll(){
  cm('csdlBg');
  loader('Đang xuất 5 file...');
  var i=0;
  function next(){
    if(i>=5){loader();toast('🏛️ Đã xuất 5 file!','ok');return;}
    i++;T('ldr-t').textContent='Xuất Lớp '+i+'...';
    _expCSDLKhoi(i);
    setTimeout(next,500);
  }next();
}

function expCSDL(){
  if(curPeriod!=='cn'){
    if(!confirm('Mẫu CSDL ngành thường dùng cho kỳ Cuối năm. Bạn đang ở kỳ "'+PERIODS.find(function(p){return p.id===curPeriod;}).name+'". Tiếp tục?'))return;
  }
  loader('Đang xuất 5 file CSDL ngành...');
  var delay=0;
  [1,2,3,4,5].forEach(function(khoi){
    setTimeout(function(){
      T('ldr-t').textContent='Xuất Lớp '+khoi+'...';
      _expCSDLKhoi(khoi);
      if(khoi===5){loader();toast('🏛️ Đã xuất 5 file CSDL ngành!','ok');}
    },delay);
    delay+=600;
  });
}

function _expCSDLKhoi(khoi){
  var sj=_csdlSubjects(khoi);
  var nlDT=_csdlNLDacThu(khoi);
  var hsKhoi=mySB().filter(function(s){return s.khoi===khoi;});
  if(!hsKhoi.length)return;

  var r1=[],r2=[],r3=[];
  var merges=[];
  var ci=0;

  // Fixed cols
  var maLabel=khoi>=3?'Mã định danh\nBộ GD&ĐT':'Mã học sinh';
  ['STT','Mã lớp',maLabel,'Họ tên','Ngày sinh'].forEach(function(h){
    r1.push(h);r2.push('');r3.push('');
    merges.push({s:{r:0,c:ci},e:{r:2,c:ci}});
    ci++;
  });

  // Môn học
  var monStart=ci;
  sj.forEach(function(mn){
    var hd=mn[2]&&mn[3]; // Cuối năm luôn có điểm theo SUBJ
    if(hd){
      r1.push('');r1.push('');
      r2.push(mn[0]);r2.push('');
      merges.push({s:{r:1,c:ci},e:{r:1,c:ci+1}});
      r3.push('Mức đạt được');r3.push('Điểm KTĐK');
      ci+=2;
    }else{
      r1.push('');
      r2.push(mn[0]);
      merges.push({s:{r:1,c:ci},e:{r:2,c:ci}});
      r3.push('Mức đạt được');
      ci++;
    }
  });
  var monEnd=ci-1;
  r1[monStart]='Môn học và hoạt động giáo dục';
  merges.push({s:{r:0,c:monStart},e:{r:0,c:monEnd}});

  // NL
  var nlStart=ci;
  var nlcStart=ci;
  NL.slice(0,NL_CHUNG_IDX).forEach(function(nl){
    r1.push('');r2.push('');r3.push(nl[0]);ci++;
  });
  var nlcEnd=ci-1;
  r2[nlcStart]='Năng lực chung';
  merges.push({s:{r:1,c:nlcStart},e:{r:1,c:nlcEnd}});

  var nldStart=ci;
  nlDT.forEach(function(nl){
    r1.push('');r2.push('');r3.push(nl.name);ci++;
  });
  var nldEnd=ci-1;
  r2[nldStart]='Năng lực đặc thù';
  merges.push({s:{r:1,c:nldStart},e:{r:1,c:nldEnd}});
  r1[nlStart]='Năng lực cốt lõi';
  merges.push({s:{r:0,c:nlStart},e:{r:0,c:nldEnd}});

  // PC
  var pcStart=ci;
  PC.forEach(function(pc){
    r1.push('');r2.push(pc[0]);r3.push('');
    merges.push({s:{r:1,c:ci},e:{r:2,c:ci}});
    ci++;
  });
  var pcEnd=ci-1;
  r1[pcStart]='Phẩm chất chủ yếu';
  merges.push({s:{r:0,c:pcStart},e:{r:0,c:pcEnd}});

  // Tail
  [{h:'Hoàn thành\nchương trình lớp học'},{h:'Lên lớp'},{h:'Xếp loại'}].forEach(function(c){
    r1.push(c.h);r2.push('');r3.push('');
    merges.push({s:{r:0,c:ci},e:{r:2,c:ci}});
    ci++;
  });

  // Data
  var stt=0;
  var dataRows=hsKhoi.map(function(s){
    stt++;
    var g=grades[s.ma]||{};
    var row=[stt,s.lop,s.ma,s.ten,s.ns];
    sj.forEach(function(mn){
      var mv=g[mn[1]]||'';
      row.push(mv?_storeToDisplay(mv,'mon'):'');
      if(mn[2]&&mn[3]) row.push(g[mn[2]]||'');
    });
    NL.slice(0,NL_CHUNG_IDX).forEach(function(nl){
      var v=g[nl[1]]||'';row.push(v?_storeToDisplay(v,'nlpc'):'');
    });
    nlDT.forEach(function(nl){
      var v=g[nl.key]||'';row.push(v?_storeToDisplay(v,'nlpc'):'');
    });
    PC.forEach(function(pc){
      var v=g[pc[1]]||'';row.push(v?_storeToDisplay(v,'nlpc'):'');
    });
    var kq=cTT(s.ma,s.khoi);
    row.push(kq?kqText(kq):'');
    row.push(g.len_lop==='Có'?'x':'');
    row.push(kq||'');
    return row;
  });

  var aoa=[r1,r2,r3].concat(dataRows);
  var ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges']=merges;
  var cw=[];for(var w=0;w<ci;w++)cw.push({wch:w<2?5:w===2?16:w===3?22:w===4?12:8});
  ws['!cols']=cw;

  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Lop_'+khoi);
  XLSX.writeFile(wb,'CSDL_Nganh_Lop'+khoi+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}

// MODAL: NHẬP ĐIỂM
function openM(idx){
  eIdx=idx;var s=SB[idx];if(!s||!canAccessStudent(s)){toast('🔒 Không có quyền truy cập HS này','err');return;}var k=String(s.khoi),sj=SUBJ[k]||SUBJ['1'],g=grades[s.ma]||{};
  if(!canE(s.lop)){toast('🔒 Không có quyền','err');return;}
  T('mTitle').textContent='✏️ '+s.ten;T('mSub').textContent='Lớp '+s.lop+' · '+s.ns;
  T('mStat').textContent=isDone(s)?'✅ Đã có':'⏳ Chưa nhập';
  if(_dirtyGrades[s.ma]) T('mStat').textContent+=' · 🔄 Chờ auto-save';
  var kq=cTT(s.ma,s.khoi),es=editSubs(s.lop);
  var isMM=curPeriod!=='cn';
  var h='';
  if(!isMM){
    h+='<div class="tt27"><h4>🤖 Kết quả tự động</h4><div class="tt27g">';
    h+='<div class="tt27i"><div class="tl">KQGD</div><div class="tv" id="t-kq">'+kqL(kq)+'</div></div>';
    h+='<div class="tt27i"><div class="tl">Lên lớp</div><div class="tv" id="t-ll">'+(g.len_lop?blH(g.len_lop,g.len_lop==='Có'?'bl-ht':'bl-cht'):'—')+'</div></div>';
    h+='<div class="tt27i"><div class="tl">Khen thưởng</div><div class="tv" id="t-kh">'+khenL(g,kq)+'</div></div>';
    h+='</div></div>';
  }
  h+='<div class="fsect"><div class="fsect-h"><h3>📚 Môn học</h3></div><div class="fgrid">';
  sj.forEach(function(mn){
    var name=mn[0],mk=mn[1],dk=mn[2],hD=mn[3],mv=g[mk]||'',dv=dk?(g[dk]!==undefined?g[dk]:''):'';
    var ce=(es===null)||es.indexOf(mk)>=0;
    var isTDT=(mk==='mon_Tiếng_dân_tộc');
    var dimStyle=isTDT?' style="opacity:0.35;pointer-events:none"':'';
    var dimNote=isTDT?'<span style="font-size:9px;color:var(--slate4);margin-left:4px">(Không đánh giá)</span>':'';
    h+='<div class="frow'+(ce?'':' rdonly')+'"'+dimStyle+'><div class="flbl">'+name+dimNote+'</div>';
    h+='<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><div class="rg" onchange="onGC('+idx+')">';
    h+='<label class="o-htt"><input type="radio" name="m_'+mk+'" value="HTT"'+(mv==='HTT'?' checked':'')+(ce?'':' disabled')+'><span>HTT</span></label>';
    h+='<label class="o-ht"><input type="radio" name="m_'+mk+'" value="HT"'+(mv==='HT'?' checked':'')+(ce?'':' disabled')+'><span>HT</span></label>';
    h+='<label class="o-cht"><input type="radio" name="m_'+mk+'" value="CHT"'+(mv==='CHT'?' checked':'')+(ce?'':' disabled')+'><span>CHT</span></label>';
    h+='</div>';
    if(_hasDiem(mn,parseInt(k))&&dk)h+='<div class="diemw"><label>Điểm:</label><input type="number" id="fd_'+dk+'" min="0" max="10" value="'+dv+'" placeholder="0-10" oninput="vD(this);onGC('+idx+')"'+(ce?'':' disabled')+'></div>';
    h+='</div></div>';
  });
  h+='</div></div>';
  // NL + PC + Lên lớp: CHỈ hiện cho Admin hoặc GVCN (có lop_phu_trach)
  var canNLPC=!CU||CU.role==='admin'||!!(CU.lop&&CU.lop.trim());
  if(canNLPC){
  var allNL=_getAllNL(parseInt(k));
  h+='<div class="fsect"><div class="fsect-h"><h3>🧠 Năng lực</h3></div><div class="fgrid fg2">';
  allNL.forEach(function(nl){var v=g[nl[1]]||'';
    h+='<div class="frow"><div class="flbl" style="font-size:12px">'+nl[0]+'</div><div class="rg" onchange="onGC('+idx+')">';
    h+='<label class="o-t"><input type="radio" name="nl_'+nl[1]+'" value="T"'+(v==='T'?' checked':'')+'><span>Tốt</span></label>';
    h+='<label class="o-d"><input type="radio" name="nl_'+nl[1]+'" value="Đ"'+(v==='Đ'?' checked':'')+'><span>Đạt</span></label>';
    h+='<label class="o-ccg"><input type="radio" name="nl_'+nl[1]+'" value="CCG"'+(v==='CCG'?' checked':'')+'><span>CCG</span></label></div></div>';
  });
  h+='</div></div><div class="fsect"><div class="fsect-h"><h3>💎 Phẩm chất</h3></div><div class="fgrid fg2">';
  PC.forEach(function(pc){var v=g[pc[1]]||'';
    h+='<div class="frow"><div class="flbl" style="font-size:12px">'+pc[0]+'</div><div class="rg" onchange="onGC('+idx+')">';
    h+='<label class="o-t"><input type="radio" name="pc_'+pc[1]+'" value="T"'+(v==='T'?' checked':'')+'><span>Tốt</span></label>';
    h+='<label class="o-d"><input type="radio" name="pc_'+pc[1]+'" value="Đ"'+(v==='Đ'?' checked':'')+'><span>Đạt</span></label>';
    h+='<label class="o-ccg"><input type="radio" name="pc_'+pc[1]+'" value="CCG"'+(v==='CCG'?' checked':'')+'><span>CCG</span></label></div></div>';
  });
  h+='</div></div>';
  var ll=g.len_lop||'',tb2=g._tieubieu||'';
  if(!isMM){
  h+='<div class="fsect"><div class="fsect-h"><h3>🎓 Lên lớp & Khen</h3></div><div class="fgrid fg2">';
  h+='<div class="frow"><div class="flbl">Lên lớp</div><div class="rg" onchange="onGC('+idx+')">';
  h+='<label class="o-y"><input type="radio" name="r_ll" value="Có"'+(ll==='Có'?' checked':'')+'><span>✓ Có</span></label>';
  h+='<label class="o-n"><input type="radio" name="r_ll" value="Không"'+(ll==='Không'?' checked':'')+'><span>✗ Không</span></label></div></div>';
  h+='<div class="frow"><div class="flbl">HS Tiêu biểu</div><div class="rg" onchange="onGC('+idx+')">';
  h+='<label class="o-xs"><input type="radio" name="r_tb" value="1"'+(tb2==='1'?' checked':'')+'><span>✓ Có</span></label>';
  h+='<label class="o-none"><input type="radio" name="r_tb" value=""'+(!tb2?' checked':'')+'><span>Không</span></label></div></div></div></div>';
  }// end !isMM
  }// end canNLPC
  T('mBd').innerHTML=h;T('mBg').classList.add('on');
}
function vD(inp){var v=inp.value;if(v===''){inp.classList.remove('inv');return;}var n=parseInt(v);if(isNaN(n)||n<0||n>10)inp.classList.add('inv');else{inp.classList.remove('inv');inp.value=String(n);}}
function onGC(idx){var s=SB[idx];if(!s)return;var tmp=colG();grades[s.ma]=tmp;_saveGradesToStorage();_markDirty(s.ma);var kq=cTT(s.ma,s.khoi),g=grades[s.ma];if(T('t-kq'))T('t-kq').innerHTML=kqL(kq);if(T('t-kh'))T('t-kh').innerHTML=khenL(g,kq);if(T('t-ll')){var ll=g.len_lop||'';T('t-ll').innerHTML=ll?blH(ll,ll==='Có'?'bl-ht':'bl-cht'):'—';}}
function colG(){
  var s=SB[eIdx];if(!s)return{};var k=String(s.khoi),sj=SUBJ[k]||SUBJ['1'],g=Object.assign({},grades[s.ma]||{});
  sj.forEach(function(mn){
    var mk=mn[1],dk=mn[2];
    var r=document.querySelector('input[name="m_'+mk+'"]:checked:not(:disabled)');
    if(r) g[mk]=r.value;
    else {
      // Radio bị bỏ chọn (toggle-off) → xóa giá trị cũ
      var anyExists=document.querySelector('input[name="m_'+mk+'"]');
      if(anyExists&&!anyExists.disabled) delete g[mk];
    }
    if(dk){var d=T('fd_'+dk);if(d&&!d.disabled){if(d.value.trim()!=='')g[dk]=String(parseInt(d.value)||0);else delete g[dk];}}
  });
  var canNLPC=!CU||CU.role==='admin'||!!(CU.lop&&CU.lop.trim());
  if(canNLPC){
    var allNL=_getAllNL(parseInt(k));
    allNL.forEach(function(nl){
      var r=document.querySelector('input[name="nl_'+nl[1]+'"]:checked');
      if(r) g[nl[1]]=r.value;
      else { var e2=document.querySelector('input[name="nl_'+nl[1]+'"]');if(e2) delete g[nl[1]]; }
    });
    PC.forEach(function(pc){
      var r=document.querySelector('input[name="pc_'+pc[1]+'"]:checked');
      if(r) g[pc[1]]=r.value;
      else { var e3=document.querySelector('input[name="pc_'+pc[1]+'"]');if(e3) delete g[pc[1]]; }
    });
    if(curPeriod==='cn'){
      var ll=document.querySelector('input[name="r_ll"]:checked');if(ll)g.len_lop=ll.value;else delete g.len_lop;
      var tb=document.querySelector('input[name="r_tb"]:checked');if(tb)g._tieubieu=tb.value;else delete g._tieubieu;
      var kq=cTT(s.ma,s.khoi);if(kq){g.hoan_thanh=kq==='CHT'?'CHT':'HT';g.kqgd=kq;}
    }
  }
  return g;
}
function cm(id){var el=T(id);if(el)el.classList.remove('on');if(id==='mBg')eIdx=null;if(id==='hbBg')hbIdx=null;if(id==='editHSBg')_editHSIdx=null;}
// ⭐ 2026-05-07: wrap addEventListener với null-check (D-3 refactor đã xoá addHSBg/editHSBg khỏi HTML)
function _safeOn(id,ev,fn){var el=T(id);if(el)el.addEventListener(ev,fn);}
_safeOn('mBg','click',function(e){if(e.target.id==='mBg')cm('mBg');});
_safeOn('uBg','click',function(e){if(e.target.id==='uBg')cm('uBg');});
_safeOn('hbBg','click',function(e){if(e.target.id==='hbBg')cm('hbBg');});
_safeOn('csdlBg','click',function(e){if(e.target.id==='csdlBg')cm('csdlBg');});
_safeOn('addHSBg','click',function(e){if(e.target.id==='addHSBg')cm('addHSBg');});
_safeOn('loginBg','click',function(e){if(e.target.id==='loginBg')cm('loginBg');});
// Radio toggle-off: click checked radio again to uncheck
document.addEventListener('click',function(e){
  var label=e.target.closest('.rg label');if(!label)return;
  var radio=label.querySelector('input[type=radio]');if(!radio)return;
  if(radio._wasChecked){e.preventDefault();radio.checked=false;radio._wasChecked=false;
    radio.dispatchEvent(new Event('change',{bubbles:true}));}
});
document.addEventListener('mousedown',function(e){
  var label=e.target.closest('.rg label');if(!label)return;
  var radio=label.querySelector('input[type=radio]');if(radio)radio._wasChecked=radio.checked;
});

// XÓA KẾT QUẢ ĐÁNH GIÁ CỦA 1 HS TRONG KỲ HIỆN TẠI
async function clearGrades(){
  if(eIdx===null)return;
  var s=SB[eIdx];if(!s)return;
  var periodName=PERIODS.find(function(p){return p.id===curPeriod;}).name;
  if(!confirm('⚠️ Xóa toàn bộ kết quả đánh giá của:\n\n👤 '+s.ten+' ('+s.lop+')\n📅 Kỳ: '+periodName+'\n\nThao tác này không thể hoàn tác!'))return;

  // Xóa local
  delete grades[s.ma];
  delete _dirtyGrades[s.ma];
  _saveGradesToStorage();

  // Xóa trên Sheets
  if(GAS){
    loader('Đang xóa...');
    try{
      var r=await gasPost({action:'deleteGrade',ma:s.ma,period:curPeriod});
      loader();
      if(r.ok) toast('🗑 Đã xóa KQ: '+s.ten+' ('+periodName+')','ok');
      else toast('⚠️ Xóa local OK, Sheets: '+(r.error||'lỗi'),'warn');
    }catch(e){
      loader();
      toast('⚠️ Xóa local OK, Sheets lỗi: '+e.message,'warn');
    }
  }else{
    toast('🗑 Đã xóa KQ local: '+s.ten,'ok');
  }

  cm('mBg');
  merge();updateAll();
}

// ═══ XÓA KQ CẢ LỚP ═══
async function clearGradesLop(){
  var lop=T('d-lop').value;
  if(!lop){toast('⚠️ Chọn lớp trước','warn');return;}
  if(lockedPeriods[curPeriod]&&CU&&CU.role!=='admin'){toast('🔒 Kỳ đang bị khóa','warn');return;}
  var periodName=PERIODS.find(function(p){return p.id===curPeriod;}).name;
  var hsLop=mySB().filter(function(s){return s.lop===lop;});
  if(!hsLop.length){toast('⚠️ Không có HS','warn');return;}

  // Kiểm tra quyền: admin hoặc GV được phân công lớp này
  var isAdmin=CU&&CU.role==='admin';
  var isGVCN=CU&&CU.lop&&CU.lop.trim()===lop;
  var hasPermLop=userPerm&&userPerm[lop];
  if(!isAdmin&&!isGVCN&&!hasPermLop){toast('⚠️ Bạn không có quyền xóa lớp này','warn');return;}

  var count=hsLop.filter(function(s){return grades[s.ma]&&Object.keys(grades[s.ma]).length>0;}).length;
  if(!count){toast('ℹ️ Lớp '+lop+' chưa có dữ liệu','ok');return;}

  if(!confirm('⚠️ XÓA TOÀN BỘ KẾT QUẢ\n\n📋 Lớp: '+lop+' ('+count+'/'+hsLop.length+' HS có dữ liệu)\n📅 Kỳ: '+periodName+'\n\n❌ Thao tác này KHÔNG THỂ hoàn tác!\n\nBạn chắc chắn?'))return;
  if(!confirm('🔴 XÁC NHẬN LẦN 2:\n\nXóa '+count+' HS lớp '+lop+' kỳ '+periodName+'?'))return;

  // Xóa local
  var deleted=0;
  hsLop.forEach(function(s){
    if(grades[s.ma]){
      delete grades[s.ma];
      delete _dirtyGrades[s.ma];
      deleted++;
    }
  });
  _saveGradesToStorage();

  // Xóa trên Sheets
  if(GAS){
    loader('🗑 Đang xóa '+deleted+' HS trên Sheets...');
    var ok=0,fail=0;
    for(var i=0;i<hsLop.length;i++){
      var s=hsLop[i];
      try{
        var r=await gasPost({action:'deleteGrade',ma:s.ma,period:curPeriod});
        if(r.ok) ok++; else fail++;
      }catch(e){fail++;}
      if(i%5===0) T('ldr-t').textContent='🗑 '+(i+1)+'/'+hsLop.length;
    }
    loader();
    if(fail===0) toast('🗑 Đã xóa '+ok+' HS lớp '+lop+' ('+periodName+')','ok');
    else toast('⚠️ Xóa: '+ok+' OK, '+fail+' lỗi','warn');
  }else{
    toast('🗑 Đã xóa local: '+deleted+' HS lớp '+lop,'ok');
  }

  merge();updateAll();
}
function saveCld(){
  if(lockedPeriods[curPeriod]&&CU&&CU.role!=='admin'){toast('🔒 Kỳ đang bị khóa, không thể lưu','warn');return;}
  if(eIdx===null)return;if(document.querySelectorAll('.diemw input.inv').length){toast('❌ Điểm không hợp lệ','err');return;}
  var s=SB[eIdx],g=colG();g.updated_at=new Date().toLocaleString('vi-VN');g.updated_by=CU?CU.username:'?';
  grades[s.ma]=g;_saveGradesToStorage();
  delete _dirtyGrades[s.ma]; // Xóa khỏi auto-save queue vì sẽ lưu thủ công
  cm('mBg');updateAll();
  if(!GAS){toast('⚠️ Chỉ lưu tạm trên máy','warn');return;}
  loader('Đang lưu lên Sheets...');
  function doSave(retry){
    gasPost({action:'saveGrade',ma:s.ma,grades:g,user:CU?CU.username:'?',period:curPeriod}).then(function(r){
      loader();if(r.ok)toast('☁️ Đã lưu: '+s.ten+' → '+PERIODS.find(function(p){return p.id===curPeriod;}).name,'ok');else toast('❌ '+r.error,'err');
    }).catch(function(e){
      if(retry<2){setTimeout(function(){doSave(retry+1);},1500);}
      else{loader();toast('⚠️ Lưu local OK, chưa lên Sheets','warn');_markDirty(s.ma);}
    });
  }doSave(0);
}
function saveAllLop(){
  if(lockedPeriods[curPeriod]&&CU&&CU.role!=='admin'){toast('🔒 Kỳ đang bị khóa, không thể lưu','warn');return;}
  if(!GAS){toast('⚠️ Chưa có GAS','warn');return;}
  var lop=T('d-lop').value;
  var batch;
  if(lop){
    // Lưu theo lớp đã chọn
    batch=dF.filter(function(s){return grades[s.ma]&&canE(s.lop);}).map(function(s){return{ma:s.ma,grades:grades[s.ma]};});
  }else{
    // GV: lưu tất cả HS có quyền (sau khi nhập Excel)
    batch=allS.filter(function(s){return grades[s.ma]&&canE(s.lop);}).map(function(s){return{ma:s.ma,grades:grades[s.ma]};});
  }
  if(!batch.length){toast('ℹ️ Không có điểm để lưu','warn');return;}
  if(batch.length>50&&!confirm('Lưu '+batch.length+' HS lên Sheets?'))return;
  var CHUNK=50,i=0,ok=0,fail=0;loader('Đang lưu '+batch.length+' HS...');
  function next(){
    if(i>=batch.length){loader();toast(fail?'⚠️ '+ok+'/'+(ok+fail)+' HS':'☁️ Lưu '+ok+' HS!',fail?'warn':'ok');return;}
    T('ldr-t').textContent='Lưu '+Math.min(i+CHUNK,batch.length)+'/'+batch.length+'...';
    gasPost({action:'saveGrades',grades_batch:batch.slice(i,i+CHUNK),user:CU?CU.username:'?',period:curPeriod}).then(function(r){if(r.ok)ok+=Math.min(CHUNK,batch.length-i);else fail+=Math.min(CHUNK,batch.length-i);i+=CHUNK;next();}).catch(function(){fail+=Math.min(CHUNK,batch.length-i);i+=CHUNK;next();});
  }next();
}

// STATUS
function renderSt(){
  var SK={Toán:'mon_Toán','T.Việt':'mon_Tiếng_việt','Đ.đức':'mon_Đạo_đức',TNXH:'mon_Tự_nhiên_và_xã_hội',NN:'mon_Ngoại_ngữ',TH:'mon_TH-CN_Tin_học',AN:'mon_Nghệ_thuật_Âm_nhạc',MT:'mon_Nghệ_thuật_Mĩ_thuật',HĐTN:'mon_Hoạt_động_trải_nghiệm',GDTC:'mon_Giáo_dục_thể_chất'};
  var html='';
  [1,2,3,4,5].forEach(function(k){
    var sj=Object.keys(SK);
    html+='<div style="margin-bottom:15px"><div style="font-size:13px;font-weight:700;color:var(--p);background:var(--pl);padding:5px 11px;border-radius:var(--r8);display:inline-block;margin-bottom:6px">Khối '+k+'</div><div class="sgw"><table class="sgt"><thead><tr><th>Lớp</th>';
    sj.forEach(function(s){html+='<th>'+s+'</th>';});html+='<th>Tiến độ</th></tr></thead><tbody>';
    ['A','B','C','D','E'].forEach(function(c){
      var lop=k+c,hs=mySB().filter(function(s){return s.lop===lop;}),tot=hs.length;
      html+='<tr><td style="text-align:left;font-weight:600;background:#fafbfd">'+lop+' ('+tot+')</td>';
      sj.forEach(function(subj){var key=SK[subj];var f=hs.filter(function(s){return(grades[s.ma]||{})[key];}).length;html+=!f?'<td class="sg-no">0</td>':f===tot?'<td class="sg-ok">✓</td>':'<td class="sg-pt">'+f+'/'+tot+'</td>';});
      var d=hs.filter(isDone).length,p=tot?Math.round(d/tot*100):0;
      html+='<td><div style="font-size:10.5px;font-weight:600;color:'+(p===100?'var(--g)':p>0?'var(--o)':'var(--r)')+'">'+p+'%</div><div class="pb2"><div class="pb2f" style="width:'+p+'%;background:'+(p===100?'var(--g)':p>0?'var(--o)':'var(--r)')+'"></div></div></td></tr>';
    });html+='</tbody></table></div></div>';
  });T('st-ct').innerHTML=html;
}

// THỐNG KÊ
function tkK(k,el){tkKF=k;document.querySelectorAll('#tk-kts .kt').forEach(function(t){t.classList.remove('on');});if(el)el.classList.add('on');renderTK(k);}
function cLop(arr){var htxs=0,htt=0,ht=0,cht=0,xs=0,tb2=0,ll=0;arr.forEach(function(s){var g=grades[s.ma]||{},kq=cTT(s.ma,s.khoi);if(kq==='HTXS')htxs++;else if(kq==='HTT')htt++;else if(kq==='HT')ht++;else if(kq==='CHT')cht++;if(kq==='HTXS')xs++;else if(kq==='HTT'&&g._tieubieu==='1')tb2++;if(g.len_lop==='Có')ll++;});return{tot:arr.length,nhap:arr.filter(isDone).length,htxs:htxs,htt:htt,ht:ht,cht:cht,xs:xs,tb:tb2,ll:ll};}
function renderTK(k){
  var fl=k===0?allS:allS.filter(function(s){return s.khoi===k;});
  var lopSet={};fl.forEach(function(s){lopSet[s.lop]=1;});var lops=Object.keys(lopSet).sort();var tot=cLop(fl);
  T('tk-cards').innerHTML='<div class="ccard"><div class="cc-ico" style="background:linear-gradient(135deg,#e8f5e9,#fff9c4)">⭐</div><div><div class="cc-val">'+tot.htxs+'</div><div class="cc-lbl">HT Xuất sắc</div></div></div><div class="ccard"><div class="cc-ico" style="background:var(--gl)">✨</div><div><div class="cc-val">'+tot.htt+'</div><div class="cc-lbl">HT Tốt</div></div></div><div class="ccard"><div class="cc-ico" style="background:var(--pl)">✓</div><div><div class="cc-val">'+tot.ht+'</div><div class="cc-lbl">Hoàn thành</div></div></div><div class="ccard"><div class="cc-ico" style="background:var(--rl)">📖</div><div><div class="cc-val">'+tot.cht+'</div><div class="cc-lbl">Chưa HT</div></div></div>';
  var tb='',totR={tot:0,nhap:0,htxs:0,htt:0,ht:0,cht:0,xs:0,tb:0,ll:0};
  lops.forEach(function(lop){var hs=allS.filter(function(s){return s.lop===lop;}),d=cLop(hs);Object.keys(totR).forEach(function(k){totR[k]+=d[k]||0;});var hp=d.nhap?Math.round((d.htxs+d.htt+d.ht)/d.nhap*100):0;
    tb+='<tr><td><span class="bl bl-lop">'+lop+'</span></td><td class="c">'+d.tot+'</td><td class="c">'+d.nhap+'</td><td class="c">'+d.htxs+'</td><td class="c">'+d.htt+'</td><td class="c">'+d.ht+'</td><td class="c">'+d.cht+'</td><td class="c">'+hp+'%</td><td class="c">'+d.xs+'</td><td class="c">'+d.tb+'</td><td class="c">'+d.ll+'</td></tr>';});
  var tp=totR.nhap?Math.round((totR.htxs+totR.htt+totR.ht)/totR.nhap*100):0;
  tb+='<tr class="tot"><td>Tổng</td><td class="c">'+totR.tot+'</td><td class="c">'+totR.nhap+'</td><td class="c">'+totR.htxs+'</td><td class="c">'+totR.htt+'</td><td class="c">'+totR.ht+'</td><td class="c">'+totR.cht+'</td><td class="c">'+tp+'%</td><td class="c">'+totR.xs+'</td><td class="c">'+totR.tb+'</td><td class="c">'+totR.ll+'</td></tr>';
  T('tk-tb').innerHTML=tb;
  if(ch1){ch1.destroy();ch1=null;}if(ch2){ch2.destroy();ch2=null;}
  ch1=new Chart(T('ch1'),{type:'doughnut',data:{labels:['HT Xuất sắc','HT Tốt','Hoàn thành','Chưa HT','Chưa nhập'],datasets:[{data:[tot.htxs,tot.htt,tot.ht,tot.cht,Math.max(0,fl.length-fl.filter(isDone).length)],backgroundColor:['#f39c12','#43a047','#1456b0','#ef5350','#bdbdbd'],borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:10}}}}}});
  ch2=new Chart(T('ch2'),{type:'doughnut',data:{labels:['Xuất sắc','Tiêu biểu','Không khen'],datasets:[{data:[tot.xs,tot.tb,Math.max(0,fl.length-tot.xs-tot.tb)],backgroundColor:['#f39c12','#e67e22','#ecf0f1'],borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:10}}}}}});
}

// USERS
function loadUsers(){
  if(!GAS){T('u-load').textContent='⚠️ Chưa kết nối';T('u-load').style.display='block';T('u-tbl').style.display='none';return;}
  T('u-load').textContent='Đang tải...';T('u-load').style.display='block';T('u-tbl').style.display='none';
  gasCall({action:'getUsers'}).then(function(r){if(r.ok){allUsers=r.data||[];renderU();}else T('u-load').textContent='❌ '+r.error;}).catch(function(e){T('u-load').textContent='❌ '+e.message;});
}
function renderU(){T('u-load').style.display='none';T('u-tbl').style.display='block';T('u-tb').innerHTML=allUsers.map(function(u,i){var rb=u.role==='admin'?'<span class="bl" style="background:var(--rl);color:var(--r);font-size:10px">Admin</span>':'<span class="bl" style="background:var(--gl);color:var(--gd);font-size:10px">GV</span>';var del=u.username!=='admin'?'<button class="abtn ad" onclick="delU(\''+u.username+'\')">🗑</button>':'';return'<tr><td>'+(i+1)+'</td><td><strong style="font-family:monospace">'+u.username+'</strong></td><td>'+u.hoten+'</td><td>'+rb+'</td><td>'+(u.lop_phu_trach||'—')+'</td><td style="font-size:11px">'+(u.phan_cong_giang_day||'—').substring(0,55)+'</td><td class="c"><button class="abtn ae" onclick="openUM('+i+')">✏️</button>'+del+'</td></tr>';}).join('');}
function openUM(idx){var u=idx!==null?allUsers[idx]:null;T('uTit').textContent=u?'✏️ '+u.username:'➕ Thêm';T('uf-u').value=u?u.username:'';T('uf-u').disabled=!!u;T('uf-p').value='';T('uf-ht').value=u?u.hoten:'';T('uf-r').value=u?u.role:'teacher';T('uf-lop').value=u?u.lop_phu_trach:'';T('uf-pc').value=u?u.phan_cong_giang_day:'';T('uErr').textContent='';T('uBg').classList.add('on');}
function saveUser(){var un=T('uf-u').value.trim(),ht=T('uf-ht').value.trim();if(!un||!ht){T('uErr').textContent='⚠️ Thiếu thông tin';return;}if(!GAS){T('uErr').textContent='⚠️ Chưa kết nối';return;}loader('Lưu...');gasPost({action:'saveUser',username:un,password:T('uf-p').value.trim(),hoten:ht,role:T('uf-r').value,lop_phu_trach:T('uf-lop').value.trim(),phan_cong_giang_day:T('uf-pc').value.trim()}).then(function(r){loader();if(r.ok){cm('uBg');toast('✅ '+r.message,'ok');loadUsers();}else T('uErr').textContent='❌ '+r.error;}).catch(function(e){loader();T('uErr').textContent='❌ '+e.message;});}
function delU(un){if(!confirm('Xóa "'+un+'"?'))return;loader('Xóa...');gasPost({action:'deleteUser',username:un}).then(function(r){loader();toast(r.ok?'🗑 '+r.message:'❌ '+r.error,r.ok?'ok':'err');loadUsers();}).catch(function(e){loader();toast('❌ '+e.message,'err');});}

// 2026-05-07: Đồng bộ Users từ DSGV (HSS)
//   • Tự sinh tài khoản cho mọi GV trong DSGV (skip nếu username đã tồn tại)
//   • Mật khẩu mặc định: ChangeMe@2026 — admin/GV phải đổi sau lần đăng nhập đầu
//   • Role suy từ "Chức vụ": HT/PHT → admin, còn lại → gv
//   • Lớp phụ trách parse từ "GVCN lớp 3A"
function syncUsersFromDSGV(){
  if(!GAS){toast('⚠️ Chưa kết nối server','warn');return;}
  if(!confirm('📥 Đồng bộ tài khoản từ DSGV (Hồ sơ số)?\n\n'+
    '• Mỗi GV trong DSGV sẽ được tạo 1 tài khoản QLCL.\n'+
    '• GV đã có tài khoản (username trùng) sẽ ĐƯỢC GIỮ NGUYÊN, không bị ghi đè.\n'+
    '• Mật khẩu mặc định cho tài khoản mới: ChangeMe@2026\n'+
    '  → Hãy yêu cầu GV đổi mật khẩu sau lần đăng nhập đầu.\n\n'+
    'Tiếp tục?')) return;
  loader('Đang đồng bộ...');
  gasPost({action:'syncUsersFromDSGV'}).then(function(r){
    loader();
    if(!r.ok){toast('❌ '+(r.error||'Lỗi đồng bộ'),'err');return;}
    var info=T('u-syncinfo');
    var html='<strong>✅ '+r.message+'</strong>';
    if(r.created&&r.created.length){
      html+='<div style="margin-top:6px"><b>'+r.created.length+' tài khoản mới</b> (mật khẩu mặc định: <code style="background:#fff;padding:1px 6px;border-radius:3px;font-weight:700">'+r.defaultPassword+'</code> — yêu cầu GV đổi):</div>';
      html+='<div style="margin-top:4px;font-size:11px;max-height:120px;overflow-y:auto">';
      r.created.slice(0,30).forEach(function(u){
        html+='<div>• <code>'+u.username+'</code> — '+u.hoten+' ('+u.role+(u.lop?', lớp '+u.lop:'')+')</div>';
      });
      if(r.created.length>30) html+='<div style="opacity:.7">... và '+(r.created.length-30)+' tài khoản nữa</div>';
      html+='</div>';
    }
    if(r.skipped&&r.skipped.length){
      html+='<div style="margin-top:6px;color:#7c2d12"><b>'+r.skipped.length+' GV bỏ qua:</b></div>';
      html+='<div style="font-size:11px;max-height:80px;overflow-y:auto">';
      r.skipped.slice(0,10).forEach(function(s){
        html+='<div>• '+s.name+' — '+s.reason+'</div>';
      });
      if(r.skipped.length>10) html+='<div style="opacity:.7">... và '+(r.skipped.length-10)+' GV nữa</div>';
      html+='</div>';
    }
    info.innerHTML=html;
    info.style.display='block';
    toast('✅ '+r.message,'ok');
    loadUsers();  // refresh bảng users
  }).catch(function(e){
    loader();
    toast('❌ '+e.message,'err');
  });
}

// IMPORT
function onDrop(ev){ev.preventDefault();T('drop-zone').classList.remove('drag');if(ev.dataTransfer.files.length)processFile(ev.dataTransfer.files[0]);}
function onFileChange(inp){if(inp.files.length)processFile(inp.files[0]);}
function processFile(file){if(file.size>5*1024*1024){toast('❌ File quá lớn','err');return;}loader('Đọc file...');var r=new FileReader();r.onload=function(e){try{loader();var wb=XLSX.read(e.target.result,{type:'array'});var ws=wb.Sheets[wb.SheetNames[0]];var raw=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});parseImport(raw);}catch(err){loader();toast('❌ '+err.message,'err');}};r.readAsArrayBuffer(file);}
function parseImport(rows){var start=rows[0]&&isNaN(parseInt(rows[0][0]))?1:0;importData=[];rows.slice(start).forEach(function(row){var ten=row[2]?String(row[2]).trim():'';if(!ten)return;importData.push({stt:String(row[0]||''),lop:String(row[1]||'').trim().toUpperCase(),khoi:parseInt(row[1])||1,ma:String(Math.floor(1e9+Math.random()*9e9)),ten:ten,ns:String(row[3]||''),gt:String(row[4]||'')});});if(!importData.length){toast('❌ Không đọc được','err');return;}T('imp-preview').innerHTML='<div class="ib green"><strong>✅ '+importData.length+' HS sẵn sàng</strong><p>Nhấn Upload để lưu lên Sheets</p></div><button class="btn bp" onclick="confirmImport()">✅ Xác nhận</button>';}
// 2026-05-06: confirmImport bỏ vì QLCL không quản lý HS nữa.
function confirmImport(){ toast('ℹ️ Nhập DSHS đã chuyển sang Hồ sơ số (Admin)','info'); }

// CÀI ĐẶT
function saveSchoolInfo(){var n=T('imp-school').value.trim(),a=T('imp-addr').value.trim();if(n)localStorage.setItem('school_name_full',n);if(a)localStorage.setItem('school_addr',a);toast('✅ Đã lưu','ok');}
function testConn(){if(!GAS){toast('⚠️ Chưa có GAS','warn');return;}loader('Kiểm tra...');gasCall({action:'ping'}).then(function(r){loader();var el=T('conn-res');if(el)el.innerHTML=r.ok?'<div class="ib green"><strong>✅ Kết nối OK</strong><p>Version: '+r.version+' · '+r.time+'</p></div>':'<div class="ib warn"><strong>❌ '+r.error+'</strong></div>';T('sett-status').innerHTML=r.ok?'<span style="color:var(--gd)">✅ OK v'+r.version+'</span>':'<span style="color:var(--r)">❌ Lỗi</span>';sUI(r.ok?'ok':'err');}).catch(function(e){loader();T('sett-status').innerHTML='<span style="color:var(--r)">❌ '+e.message+'</span>';sUI('err');});}
function fixSheetsStructure(){if(!GAS){toast('⚠️ Chưa có GAS','warn');return;}loader('Sửa...');gasPost({action:'fixDiemSheet'}).then(function(r){loader();toast(r.ok?'✅ '+r.message:'❌ '+r.error,r.ok?'ok':'err');}).catch(function(e){loader();toast('❌ '+e.message,'err');});}
// 2026-05-06: bỏ upStudents() — QLCL không upload HS nữa, dùng tab "DS HocSinh" của HSS
function upStudents(){ toast('ℹ️ Upload HS đã chuyển sang Hồ sơ số (Admin)','info'); }
function copyGAS(){var url=GAS||DEFAULT_GAS;if(!url){toast('⚠️ Chưa có URL','warn');return;}navigator.clipboard.writeText(url).then(function(){toast('📋 Đã copy GAS URL','ok');});}
function copyShareLink(){var url=GAS||DEFAULT_GAS;if(!url){toast('⚠️ Chưa có','warn');return;}var link=window.location.href.split('?')[0]+'?gas='+encodeURIComponent(url);navigator.clipboard.writeText(link).then(function(){toast('🔗 Đã copy link GV','ok');});}

// ═══════════════════════════════════════════════════════════════
// EXCEL EXPORT — BÁO CÁO CHUẨN, ĐẸP MẮT (xlsx-js-style)
// ═══════════════════════════════════════════════════════════════

// ── Styles dùng chung cho báo cáo ──
var _RPT={
  bdr:{top:{style:'thin',color:{rgb:'B0B0B0'}},bottom:{style:'thin',color:{rgb:'B0B0B0'}},left:{style:'thin',color:{rgb:'B0B0B0'}},right:{style:'thin',color:{rgb:'B0B0B0'}}},
  bdrThick:{top:{style:'medium',color:{rgb:'333333'}},bottom:{style:'medium',color:{rgb:'333333'}},left:{style:'medium',color:{rgb:'333333'}},right:{style:'medium',color:{rgb:'333333'}}},
  // Title row
  title:{font:{bold:true,sz:16,name:'Times New Roman',color:{rgb:'1A237E'}},alignment:{horizontal:'center',vertical:'center'}},
  subtitle:{font:{bold:false,sz:11,name:'Times New Roman',color:{rgb:'546E7A'}},alignment:{horizontal:'center',vertical:'center'}},
  // Headers
  hdr1:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'1565C0'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  hdr2:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'2E7D32'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  hdr3:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'E65100'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  hdr4:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'6A1B9A'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
  // Data cells
  dataC:{font:{sz:11,name:'Arial'},alignment:{horizontal:'center',vertical:'center'}},
  dataL:{font:{sz:11,name:'Arial'},alignment:{horizontal:'left',vertical:'center'}},
  dataNum:{font:{sz:11,name:'Arial',bold:true},alignment:{horizontal:'center',vertical:'center'}},
  // KQGD badges
  htxs:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'E65100'}},fill:{fgColor:{rgb:'FFF3E0'}},alignment:{horizontal:'center',vertical:'center'}},
  htt:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'2E7D32'}},fill:{fgColor:{rgb:'E8F5E9'}},alignment:{horizontal:'center',vertical:'center'}},
  ht:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'1565C0'}},fill:{fgColor:{rgb:'E3F2FD'}},alignment:{horizontal:'center',vertical:'center'}},
  cht:{font:{bold:true,sz:11,name:'Arial',color:{rgb:'C62828'}},fill:{fgColor:{rgb:'FFEBEE'}},alignment:{horizontal:'center',vertical:'center'}},
  // Total row
  total:{font:{bold:true,sz:12,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'37474F'}},alignment:{horizontal:'center',vertical:'center'}},
  totalL:{font:{bold:true,sz:12,name:'Arial',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'37474F'}},alignment:{horizontal:'left',vertical:'center'}},
  // Alternating row
  alt:{font:{sz:11,name:'Arial'},fill:{fgColor:{rgb:'F5F5F5'}},alignment:{horizontal:'center',vertical:'center'}},
  altL:{font:{sz:11,name:'Arial'},fill:{fgColor:{rgb:'F5F5F5'}},alignment:{horizontal:'left',vertical:'center'}},
  // Percent highlight
  pctGood:{font:{bold:true,sz:12,name:'Arial',color:{rgb:'2E7D32'}},fill:{fgColor:{rgb:'E8F5E9'}},alignment:{horizontal:'center',vertical:'center'}},
  pctWarn:{font:{bold:true,sz:12,name:'Arial',color:{rgb:'E65100'}},fill:{fgColor:{rgb:'FFF3E0'}},alignment:{horizontal:'center',vertical:'center'}},
  pctBad:{font:{bold:true,sz:12,name:'Arial',color:{rgb:'C62828'}},fill:{fgColor:{rgb:'FFEBEE'}},alignment:{horizontal:'center',vertical:'center'}},
  // Footer
  footer:{font:{italic:true,sz:10,name:'Arial',color:{rgb:'78909C'}},alignment:{horizontal:'left',vertical:'center'}},
  sign:{font:{bold:true,sz:11,name:'Times New Roman'},alignment:{horizontal:'center',vertical:'center'}}
};
function _rptS(base){return{font:Object.assign({},base.font),fill:base.fill?{fgColor:Object.assign({},base.fill.fgColor)}:undefined,border:_RPT.bdr,alignment:Object.assign({},base.alignment)};}
function _rptST(base){return{font:Object.assign({},base.font),fill:base.fill?{fgColor:Object.assign({},base.fill.fgColor)}:undefined,border:_RPT.bdrThick,alignment:Object.assign({},base.alignment)};}
function _rptSet(ws,r,c,val,style){
  var addr=XLSX.utils.encode_cell({r:r,c:c});
  ws[addr]={v:val!==undefined&&val!==null?val:'',t:typeof val==='number'?'n':'s',s:style};
}
function _rptMerge(ws,sr,sc,er,ec){if(!ws['!merges'])ws['!merges']=[];ws['!merges'].push({s:{r:sr,c:sc},e:{r:er,c:ec}});}
function _kqStyle(kq){return kq==='HTXS'?_RPT.htxs:kq==='HTT'?_RPT.htt:kq==='HT'?_RPT.ht:kq==='CHT'?_RPT.cht:_RPT.dataC;}
function _pctStyle(pct){return pct>=90?_RPT.pctGood:pct>=70?_RPT.pctWarn:_RPT.pctBad;}
function _rptSchool(){return localStorage.getItem('school_name_full')||'Trường Tiểu học Diễn Liên';}
function _rptPeriodName(){var p=PERIODS.find(function(p){return p.id===curPeriod;});return p?p.name:'Cuối năm';}
function _rptDate(){var d=new Date();return 'Ngày '+d.getDate()+' tháng '+(d.getMonth()+1)+' năm '+d.getFullYear();}

// ═══════════════════════════════════════════════════════════════
// 1. XUẤT KẾT QUẢ HỌC TẬP — EXCEL CHUẨN
// ═══════════════════════════════════════════════════════════════
function expExcel(){
  var KL={HTXS:'HT Xuất sắc',HTT:'HT Tốt',HT:'Hoàn thành',CHT:'Chưa HT'};
  var school=_rptSchool();
  var periodName=_rptPeriodName();
  var ws={};
  var R=0, COLS=8;

  // ── Tiêu đề ──
  _rptSet(ws,R,0,school.toUpperCase(),{font:{bold:true,sz:14,name:'Times New Roman',color:{rgb:'1A237E'}},alignment:{horizontal:'center',vertical:'center'}});
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'BÁO CÁO KẾT QUẢ HỌC TẬP — '+periodName.toUpperCase(),_rptS(_RPT.title));
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',_rptS(_RPT.title));
  _rptMerge(ws,R,0,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'Năm học 2025–2026 · Xuất ngày: '+_rptDate(),_rptS(_RPT.subtitle));
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',_rptS(_RPT.subtitle));
  _rptMerge(ws,R,0,R,COLS-1);
  R++; R++; // blank row

  // ── Headers ──
  var hdrs=['STT','Lớp','Mã HS','Họ và tên','Ngày sinh','Giới tính','Kết quả GD','Lên lớp'];
  hdrs.forEach(function(h,i){_rptSet(ws,R,i,h,_rptST(_RPT.hdr1));});
  R++;

  // ── Data ──
  var stt=0;
  hsF.forEach(function(s,idx){
    stt++;
    var g=grades[s.ma]||{},kq=cTT(s.ma,s.khoi);
    var isAlt=idx%2===1;
    var sc=isAlt?_RPT.alt:_RPT.dataC;
    var sl=isAlt?_RPT.altL:_RPT.dataL;
    _rptSet(ws,R,0,stt,_rptS(sc));
    _rptSet(ws,R,1,s.lop,_rptS(sc));
    _rptSet(ws,R,2,String(s.ma),_rptS(sc));
    _rptSet(ws,R,3,s.ten,_rptS(sl));
    _rptSet(ws,R,4,s.ns||'',_rptS(sc));
    _rptSet(ws,R,5,s.gt||'',_rptS(sc));
    _rptSet(ws,R,6,KL[kq]||'—',_rptS(_kqStyle(kq)));
    _rptSet(ws,R,7,g.len_lop||'—',_rptS(sc));
    R++;
  });

  // ── Footer ──
  R++;
  _rptSet(ws,R,0,'Tổng số: '+stt+' học sinh',_rptS(_RPT.footer));
  for(var i=1;i<4;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,3);
  R++;
  _rptSet(ws,R,0,'Người xuất: '+(CU?CU.hoten||CU.username:''),_rptS(_RPT.footer));
  for(var i=1;i<4;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,3);

  ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R,c:COLS-1}});
  ws['!cols']=[{wch:6},{wch:8},{wch:14},{wch:26},{wch:14},{wch:10},{wch:18},{wch:10}];
  ws['!rows']=[{hpt:28},{hpt:30},{hpt:20},{hpt:10},{hpt:26}];

  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'KQ Học tập');
  XLSX.writeFile(wb,'KQHT_'+curPeriod+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('📊 Xuất báo cáo KQHT thành công!','ok');
}

// ═══════════════════════════════════════════════════════════════
// 2. XUẤT THỐNG KÊ CHẤT LƯỢNG — EXCEL CHUẨN
// ═══════════════════════════════════════════════════════════════
function expTKXL(){
  var school=_rptSchool();
  var periodName=_rptPeriodName();
  var lopSet={};allS.forEach(function(s){lopSet[s.lop]=1;});
  var lops=Object.keys(lopSet).sort();
  var ws={};
  var R=0, COLS=13;

  // ── Tiêu đề ──
  _rptSet(ws,R,0,school.toUpperCase(),{font:{bold:true,sz:14,name:'Times New Roman',color:{rgb:'1A237E'}},alignment:{horizontal:'center',vertical:'center'}});
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'BẢNG THỐNG KÊ CHẤT LƯỢNG GIÁO DỤC',_rptS(_RPT.title));
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',_rptS(_RPT.title));
  _rptMerge(ws,R,0,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'Kỳ: '+periodName+' — Năm học 2025–2026 · '+_rptDate(),_rptS(_RPT.subtitle));
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',_rptS(_RPT.subtitle));
  _rptMerge(ws,R,0,R,COLS-1);
  R++; R++; // blank row

  // ── Header group row 1 ──
  // "Lớp" merge 2 rows
  _rptSet(ws,R,0,'Lớp',_rptST(_RPT.hdr1)); _rptSet(ws,R+1,0,'',_rptST(_RPT.hdr1));
  _rptMerge(ws,R,0,R+1,0);
  // "Sĩ số" merge 2 rows
  _rptSet(ws,R,1,'Sĩ số',_rptST(_RPT.hdr1)); _rptSet(ws,R+1,1,'',_rptST(_RPT.hdr1));
  _rptMerge(ws,R,1,R+1,1);
  // "Đã nhập" merge 2 rows
  _rptSet(ws,R,2,'Đã nhập',_rptST(_RPT.hdr1)); _rptSet(ws,R+1,2,'',_rptST(_RPT.hdr1));
  _rptMerge(ws,R,2,R+1,2);
  // "Kết quả giáo dục" spans 4+1 cols
  _rptSet(ws,R,3,'Kết quả giáo dục',_rptST(_RPT.hdr2));
  for(var i=4;i<=7;i++) _rptSet(ws,R,i,'',_rptST(_RPT.hdr2));
  _rptMerge(ws,R,3,R,7);
  // Sub headers for KQGD
  var kqHdrs=['HT Xuất sắc','HT Tốt','Hoàn thành','Chưa HT','Tỉ lệ HT'];
  kqHdrs.forEach(function(h,i){_rptSet(ws,R+1,3+i,h,_rptST(_RPT.hdr2));});
  // "Khen thưởng" spans 2 cols
  _rptSet(ws,R,8,'Khen thưởng',_rptST(_RPT.hdr3));
  _rptSet(ws,R,9,'',_rptST(_RPT.hdr3));
  _rptMerge(ws,R,8,R,9);
  _rptSet(ws,R+1,8,'Xuất sắc',_rptST(_RPT.hdr3));
  _rptSet(ws,R+1,9,'Tiêu biểu',_rptST(_RPT.hdr3));
  // "Lên lớp" merge 2 rows
  _rptSet(ws,R,10,'Lên lớp',_rptST(_RPT.hdr4)); _rptSet(ws,R+1,10,'',_rptST(_RPT.hdr4));
  _rptMerge(ws,R,10,R+1,10);
  // "Ở lại" merge 2 rows
  _rptSet(ws,R,11,'Ở lại',_rptST(_RPT.hdr4)); _rptSet(ws,R+1,11,'',_rptST(_RPT.hdr4));
  _rptMerge(ws,R,11,R+1,11);
  // "Ghi chú" merge 2 rows
  _rptSet(ws,R,12,'Ghi chú',_rptST(_RPT.hdr4)); _rptSet(ws,R+1,12,'',_rptST(_RPT.hdr4));
  _rptMerge(ws,R,12,R+1,12);
  R+=2;

  // ── Data rows ──
  var totR={tot:0,nhap:0,htxs:0,htt:0,ht:0,cht:0,xs:0,tb:0,ll:0};
  lops.forEach(function(lop,idx){
    var hs=allS.filter(function(s){return s.lop===lop;});
    var d=cLop(hs);
    Object.keys(totR).forEach(function(k){totR[k]+=d[k]||0;});
    var hp=d.nhap?Math.round((d.htxs+d.htt+d.ht)/d.nhap*100):0;
    var oLai=d.tot-d.ll;
    var isAlt=idx%2===1;
    var sc=isAlt?_RPT.alt:_RPT.dataC;
    var sl=isAlt?_RPT.altL:_RPT.dataL;
    _rptSet(ws,R,0,'Lớp '+lop,_rptS(sl));
    _rptSet(ws,R,1,d.tot,_rptS(sc));
    _rptSet(ws,R,2,d.nhap,_rptS(sc));
    _rptSet(ws,R,3,d.htxs,_rptS(d.htxs>0?_RPT.htxs:sc));
    _rptSet(ws,R,4,d.htt,_rptS(d.htt>0?_RPT.htt:sc));
    _rptSet(ws,R,5,d.ht,_rptS(d.ht>0?_RPT.ht:sc));
    _rptSet(ws,R,6,d.cht,_rptS(d.cht>0?_RPT.cht:sc));
    _rptSet(ws,R,7,hp+'%',_rptS(_pctStyle(hp)));
    _rptSet(ws,R,8,d.xs,_rptS(sc));
    _rptSet(ws,R,9,d.tb,_rptS(sc));
    _rptSet(ws,R,10,d.ll,_rptS(sc));
    _rptSet(ws,R,11,oLai>0?oLai:0,_rptS(oLai>0?_RPT.cht:sc));
    _rptSet(ws,R,12,'',_rptS(sc));
    R++;
  });

  // ── Total row ──
  var tHp=totR.nhap?Math.round((totR.htxs+totR.htt+totR.ht)/totR.nhap*100):0;
  var tOlai=totR.tot-totR.ll;
  _rptSet(ws,R,0,'TỔNG CỘNG',_rptST(_RPT.totalL));
  _rptSet(ws,R,1,totR.tot,_rptST(_RPT.total));
  _rptSet(ws,R,2,totR.nhap,_rptST(_RPT.total));
  _rptSet(ws,R,3,totR.htxs,_rptST(_RPT.total));
  _rptSet(ws,R,4,totR.htt,_rptST(_RPT.total));
  _rptSet(ws,R,5,totR.ht,_rptST(_RPT.total));
  _rptSet(ws,R,6,totR.cht,_rptST(_RPT.total));
  _rptSet(ws,R,7,tHp+'%',_rptST(_RPT.total));
  _rptSet(ws,R,8,totR.xs,_rptST(_RPT.total));
  _rptSet(ws,R,9,totR.tb,_rptST(_RPT.total));
  _rptSet(ws,R,10,totR.ll,_rptST(_RPT.total));
  _rptSet(ws,R,11,tOlai>0?tOlai:0,_rptST(_RPT.total));
  _rptSet(ws,R,12,'',_rptST(_RPT.total));
  R++;

  // ── Chữ ký ──
  R++;
  var ht=localStorage.getItem('hieu_truong')||'';
  _rptSet(ws,R,0,'',{}); _rptSet(ws,R,8,'Diễn Liên, '+_rptDate(),_rptS(_RPT.sign));
  for(var i=9;i<COLS;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,8,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'Người lập biểu',_rptS(_RPT.sign));
  for(var i=1;i<3;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,2);
  _rptSet(ws,R,8,'Hiệu trưởng',_rptS(_RPT.sign));
  for(var i=9;i<COLS;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,8,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'(Ký, ghi rõ họ tên)',{font:{italic:true,sz:10,name:'Times New Roman',color:{rgb:'999999'}},alignment:{horizontal:'center'}});
  for(var i=1;i<3;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,2);
  _rptSet(ws,R,8,'(Ký, ghi rõ họ tên và đóng dấu)',{font:{italic:true,sz:10,name:'Times New Roman',color:{rgb:'999999'}},alignment:{horizontal:'center'}});
  for(var i=9;i<COLS;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,8,R,COLS-1);
  R+=3;
  _rptSet(ws,R,0,CU?CU.hoten||CU.username:'',_rptS(_RPT.sign));
  for(var i=1;i<3;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,2);
  _rptSet(ws,R,8,ht,_rptS(_RPT.sign));
  for(var i=9;i<COLS;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,8,R,COLS-1);

  ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R,c:COLS-1}});
  ws['!cols']=[{wch:12},{wch:8},{wch:10},{wch:12},{wch:10},{wch:12},{wch:12},{wch:10},{wch:10},{wch:10},{wch:9},{wch:8},{wch:12}];
  ws['!rows']=[{hpt:28},{hpt:30},{hpt:20},{hpt:10},{hpt:28},{hpt:22}];

  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Thống kê CL');
  XLSX.writeFile(wb,'ThongKeCL_'+curPeriod+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('📈 Xuất thống kê chất lượng thành công!','ok');
}


// ┌──────────────────────────────────────────────────────────┐
// │  V2.0: HỌC BẠ SỐ — THEO MẪU CHÍNH THỨC TT27          │
// └──────────────────────────────────────────────────────────┘
// (NL_CHUNG_IDX đã khai báo ở đầu file, dòng 121 — không khai lại tránh shadow)

function hbFil(){
  var lop=T('hb-lop').value,q=T('hb-q').value.toLowerCase();
  hbFiltered=allS.filter(function(s){
    if(lop&&s.lop!==lop)return false;
    if(q&&(s.ten+s.ma).toLowerCase().indexOf(q)<0)return false;
    return isDone(s);
  });
  var el=T('hb-list');
  if(!lop){el.innerHTML='<div class="empty"><div class="ei">📋</div><p>Chọn lớp để xem học bạ</p></div>';T('hb-rc').textContent='';return;}
  if(!hbFiltered.length){el.innerHTML='<div class="empty"><div class="ei">📋</div><p>Chưa có HS đã nhập điểm trong lớp này</p></div>';T('hb-rc').textContent='0 HS';return;}
  T('hb-rc').textContent=hbFiltered.length+' HS';
  el.innerHTML=hbFiltered.map(function(s){
    var kq=cTT(s.ma,s.khoi),nx=nhanXet[s.ma]||{};
    var hasNX=nx.nx_pham_chat;
    var bgC=s.gt==='Nam'?'#e8f4fd':'#fce4ec';
    var ico=s.gt==='Nam'?'👦':'👧';
    var nxCount=0;var k=String(s.khoi),sj=SUBJ[k]||SUBJ['1'];
    sj.forEach(function(mn){if(nx['nx_'+mn[1]])nxCount++;});
    var nxInfo=hasNX?'<span class="bl bl-ok">✓ Đã nhận xét ('+nxCount+' môn)</span>':'<span class="bl bl-no">Chưa nhận xét</span>';
    return'<div class="hb-card"><div class="hb-info"><div class="hb-avatar" style="background:'+bgC+'">'+ico+'</div><div style="flex:1"><div class="hb-name">'+s.ten+'</div><div class="hb-meta">Lớp '+s.lop+' · '+s.ns+' · '+kqL(kq)+' · '+nxInfo+'</div></div><div style="display:flex;gap:5px"><button class="abtn apur" onclick="openHB('+SB.findIndex(function(b){return b.ma===s.ma;})+')">📋 Học bạ</button></div></div></div>';
  }).join('');
}

function openHB(idx){
  hbIdx=idx;var s=SB[idx];if(!s||!canAccessStudent(s)){toast('🔒 Không có quyền truy cập HS này','err');return;}var g=grades[s.ma]||{},kq=cTT(s.ma,s.khoi),nx=nhanXet[s.ma]||{};
  T('hbTitle').textContent='📋 Học bạ: '+s.ten;
  T('hbSub').textContent='Lớp '+s.lop+' · '+s.ns+' · '+(s.gt||'');
  T('hbStat').textContent=kqText(kq)||'Chưa xác định';
  var k=String(s.khoi),sj=SUBJ[k]||SUBJ['1'];
  var h='';
  // 2026-05-08: Lý lịch học sinh (cho phép admin override khi HSS sheet thiếu data)
  // Pre-fill từ nx > s (HSS) — đồng bộ với _buildHocBaData
  function _v(a, b){ return (a !== undefined && a !== null && a !== '') ? a : (b || ''); }
  var llNoiSinh = _v(nx.noi_sinh, s.noi_sinh);
  var llQueQuan = _v(nx.que_quan, s.que_quan);
  var llNoiO    = _v(nx.noi_o,    s.cho_o);
  var llCha     = _v(nx.ho_cha,   s.cha);
  var llMe      = _v(nx.ho_me,    s.me);
  var llGiamHo  = nx.giam_ho || '';
  var llSoDB    = nx.so_dang_bo || '';
  var llNNH     = nx.ngay_nhap_hoc || '';
  function _liInp(id, label, val, ph, hssVal){
    // hssVal = giá trị từ sheet HSS (s.field). Hiện ngay dưới input để thầy biết
    // Sheet HSS có data hay không, và panel này có override hay không.
    var hssBadge = '';
    if (hssVal !== undefined) {
      if (hssVal && hssVal.length) {
        hssBadge = '<div style="font-size:10px;color:#16a34a;margin-top:2px">✓ Sheet HSS: '+hssVal.replace(/</g,'&lt;')+'</div>';
      } else {
        hssBadge = '<div style="font-size:10px;color:#dc2626;margin-top:2px">⚠ Sheet HSS trống — nhập tay tại đây</div>';
      }
    }
    return '<div class="frow" style="flex-direction:column;align-items:stretch">'
      +'<div style="font-size:10px;color:var(--tx3)">'+label+'</div>'
      +'<input type="text" id="'+id+'" value="'+(val||'').replace(/"/g,'&quot;')+'" placeholder="'+(ph||'')+'" style="width:100%;height:30px;border:1px solid var(--bd2);border-radius:5px;padding:0 8px;font-size:12px;outline:none">'
      +hssBadge+'</div>';
  }
  h+='<div class="fsect"><div class="fsect-h"><h3>📇 Lý lịch học sinh (in vào học bạ)</h3></div>';
  h+='<div style="font-size:11px;color:var(--tx3);margin:-4px 0 6px 0">Để trống nếu giữ nguyên dữ liệu Hồ sơ số. Nhập để ghi đè khi HSS thiếu/sai. Badge xanh ✓ = HSS có sẵn; đỏ ⚠ = sheet trống cần nhập tay.</div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  h+=_liInp('hb_so_dang_bo',  'Sổ đăng bộ',           llSoDB,    'VD: 671/2024');
  h+=_liInp('hb_ngay_nhap_hoc','Ngày nhập học',       llNNH,     'dd/mm/yyyy');
  h+=_liInp('hb_noi_sinh',    'Nơi sinh',             llNoiSinh, 'VD: BV Hữu nghị Đa khoa Nghệ An', s.noi_sinh || '');
  h+=_liInp('hb_que_quan',    'Quê quán',             llQueQuan, 'VD: Xã Quảng Châu, tỉnh Nghệ An', s.que_quan || '');
  h+=_liInp('hb_noi_o',       'Nơi ở hiện nay',       llNoiO,    'VD: Xóm 6, xã Quảng Châu...',     s.cho_o || '');
  h+=_liInp('hb_giam_ho',     'Người giám hộ (nếu có)', llGiamHo, '');
  h+=_liInp('hb_ho_cha',      'Họ và tên cha',        llCha,     '', s.cha || '');
  h+=_liInp('hb_ho_me',       'Họ và tên mẹ',         llMe,      '', s.me || '');
  h+='</div></div>';
  // Thông tin cá nhân
  h+='<div class="fsect"><div class="fsect-h"><h3>👤 Thông tin học sinh</h3></div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">';
  h+='<div class="frow" style="flex-direction:column;align-items:stretch"><div style="font-size:10px;color:var(--tx3)">Chiều cao (cm)</div><input type="number" id="hb_chieu_cao" value="'+(nx.chieu_cao||'')+'" style="width:100%;height:30px;border:1px solid var(--bd2);border-radius:5px;text-align:center;font-size:13px;font-weight:600;outline:none" placeholder="..."></div>';
  h+='<div class="frow" style="flex-direction:column;align-items:stretch"><div style="font-size:10px;color:var(--tx3)">Cân nặng (kg)</div><input type="number" id="hb_can_nang" value="'+(nx.can_nang||'')+'" style="width:100%;height:30px;border:1px solid var(--bd2);border-radius:5px;text-align:center;font-size:13px;font-weight:600;outline:none" placeholder="..."></div>';
  h+='<div class="frow" style="flex-direction:column;align-items:stretch"><div style="font-size:10px;color:var(--tx3)">Nghỉ có phép</div><input type="number" id="hb_nghi_phep" value="'+(nx.nghi_phep||'0')+'" style="width:100%;height:30px;border:1px solid var(--bd2);border-radius:5px;text-align:center;font-size:13px;outline:none"></div>';
  h+='<div class="frow" style="flex-direction:column;align-items:stretch"><div style="font-size:10px;color:var(--tx3)">Nghỉ không phép</div><input type="number" id="hb_nghi_kphep" value="'+(nx.nghi_kphep||'0')+'" style="width:100%;height:30px;border:1px solid var(--bd2);border-radius:5px;text-align:center;font-size:13px;outline:none"></div>';
  h+='</div></div>';
  // 1. Môn học
  h+='<div class="fsect"><div class="fsect-h"><h3>📚 1. Các môn học và hoạt động giáo dục</h3></div>';
  h+='<table style="width:100%;font-size:12px;border-collapse:collapse;border:1.5px solid var(--bd)">';
  h+='<thead><tr style="background:linear-gradient(135deg,#4a148c,#7b1fa2)"><th style="color:#fff;padding:7px 8px;text-align:left;width:22%">Môn học</th><th style="color:#fff;padding:7px 8px;text-align:center;width:10%">Mức đạt</th><th style="color:#fff;padding:7px 8px;text-align:center;width:10%">Điểm KTĐK</th><th style="color:#fff;padding:7px 8px;text-align:left;width:58%">Nhận xét</th></tr></thead><tbody>';
  sj.forEach(function(mn){
    var mv=g[mn[1]]||'',dv=mn[2]?(g[mn[2]]!==undefined?g[mn[2]]:''):'';
    var nxKey='nx_'+mn[1]; var nxVal=nx[nxKey]||'';
    h+='<tr style="border-bottom:1px solid var(--bd)"><td style="padding:5px 8px;font-weight:500">'+mn[0]+'</td>';
    h+='<td style="padding:5px 8px;text-align:center">'+blH(mv)+'</td>';
    h+='<td style="padding:5px 8px;text-align:center;font-weight:700">'+(dv||'—')+'</td>';
    h+='<td style="padding:3px 4px"><textarea class="nx-ta" id="'+nxKey+'" style="min-height:36px;height:36px;font-size:11.5px;padding:5px 7px;line-height:1.5" placeholder="Nhận xét...">'+nxVal+'</textarea></td></tr>';
  });
  h+='</tbody></table></div>';
  // 2. Phẩm chất
  h+='<div class="fsect"><div class="fsect-h"><h3>💎 2. Những phẩm chất chủ yếu</h3></div>';
  h+='<table style="width:100%;font-size:12px;border-collapse:collapse;border:1.5px solid var(--bd)">';
  h+='<thead><tr style="background:linear-gradient(135deg,#1b5e20,#388e3c)"><th style="color:#fff;padding:7px 8px;text-align:left;width:25%">Phẩm chất</th><th style="color:#fff;padding:7px 8px;text-align:center;width:12%">Mức đạt</th><th style="color:#fff;padding:7px 8px;text-align:left;width:63%">Nhận xét</th></tr></thead><tbody>';
  PC.forEach(function(pc,i){
    var v=g[pc[1]]||'';
    h+='<tr style="border-bottom:1px solid var(--bd)"><td style="padding:5px 8px;font-weight:500">'+pc[0]+'</td>';
    h+='<td style="padding:5px 8px;text-align:center">'+blH(v)+'</td>';
    if(i===0) h+='<td rowspan="'+PC.length+'" style="padding:3px 4px;vertical-align:top"><textarea class="nx-ta" id="hb_nx_pham_chat" style="min-height:'+(PC.length*32)+'px;font-size:11.5px;padding:5px 7px;line-height:1.6" placeholder="Nhận xét chung về phẩm chất...">'+(nx.nx_pham_chat||'')+'</textarea></td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  // 3.1 Năng lực chung
  var nlChung=NL.slice(0,NL_CHUNG_IDX);
  h+='<div class="fsect"><div class="fsect-h"><h3>🧠 3.1. Những năng lực chung</h3></div>';
  h+='<table style="width:100%;font-size:12px;border-collapse:collapse;border:1.5px solid var(--bd)">';
  h+='<thead><tr style="background:linear-gradient(135deg,#0d47a1,#1565c0)"><th style="color:#fff;padding:7px 8px;text-align:left;width:25%">Năng lực</th><th style="color:#fff;padding:7px 8px;text-align:center;width:12%">Mức đạt</th><th style="color:#fff;padding:7px 8px;text-align:left;width:63%">Nhận xét</th></tr></thead><tbody>';
  nlChung.forEach(function(nl,i){
    var v=g[nl[1]]||'';
    h+='<tr style="border-bottom:1px solid var(--bd)"><td style="padding:5px 8px;font-weight:500">'+nl[0]+'</td>';
    h+='<td style="padding:5px 8px;text-align:center">'+blH(v)+'</td>';
    if(i===0) h+='<td rowspan="'+nlChung.length+'" style="padding:3px 4px;vertical-align:top"><textarea class="nx-ta" id="hb_nx_nl_chung" style="min-height:'+(nlChung.length*32)+'px;font-size:11.5px;padding:5px 7px;line-height:1.6" placeholder="Nhận xét năng lực chung...">'+(nx.nx_nl_chung||'')+'</textarea></td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  // 3.2 Năng lực đặc thù — theo khối HS (TT27 + CT GDPT 2018)
  // K1-2: 5 NL (Ngôn ngữ, Tính toán, Khoa học, Thẩm mĩ, Thể chất)
  // K3-5: 7 NL (+Công nghệ, +Tin học) vì các môn này bắt buộc từ lớp 3
  var nlDacThu=_getNLDacThu(parseInt(s.khoi));
  h+='<div class="fsect"><div class="fsect-h"><h3>⚡ 3.2. Những năng lực đặc thù</h3></div>';
  h+='<table style="width:100%;font-size:12px;border-collapse:collapse;border:1.5px solid var(--bd)">';
  h+='<thead><tr style="background:linear-gradient(135deg,#e65100,#ef6c00)"><th style="color:#fff;padding:7px 8px;text-align:left;width:25%">Năng lực</th><th style="color:#fff;padding:7px 8px;text-align:center;width:12%">Mức đạt</th><th style="color:#fff;padding:7px 8px;text-align:left;width:63%">Nhận xét</th></tr></thead><tbody>';
  nlDacThu.forEach(function(nl,i){
    var v=g[nl[1]]||'';
    h+='<tr style="border-bottom:1px solid var(--bd)"><td style="padding:5px 8px;font-weight:500">'+nl[0]+'</td>';
    h+='<td style="padding:5px 8px;text-align:center">'+blH(v)+'</td>';
    if(i===0) h+='<td rowspan="'+nlDacThu.length+'" style="padding:3px 4px;vertical-align:top"><textarea class="nx-ta" id="hb_nx_nl_dacthu" style="min-height:'+(nlDacThu.length*32)+'px;font-size:11.5px;padding:5px 7px;line-height:1.6" placeholder="Nhận xét năng lực đặc thù...">'+(nx.nx_nl_dacthu||'')+'</textarea></td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  // 4-6
  var khenDefault=kq==='HTXS'?'Đạt danh hiệu Học sinh Xuất sắc.':(kq==='HTT'?'Đạt danh hiệu Học sinh Tiêu biểu.':'');
  var htDefault='Hoàn thành chương trình lớp '+s.lop+'.';
  h+='<div class="fsect"><div class="fsect-h"><h3>🎓 4-6. Đánh giá & Khen thưởng</h3></div>';
  h+='<div style="display:grid;gap:8px">';
  h+='<div class="frow" style="flex-direction:column;align-items:stretch"><div style="font-size:11px;font-weight:600;color:var(--pd);margin-bottom:3px">4. Đánh giá KQGD</div><div style="font-size:14px;font-weight:700">'+kqL(kq)+'</div></div>';
  h+='<div class="frow" style="flex-direction:column;align-items:stretch"><div style="font-size:11px;font-weight:600;color:var(--pd);margin-bottom:3px">5. Khen thưởng</div><input type="text" id="hb_khen_text" value="'+(nx.khen_text||khenDefault)+'" style="width:100%;height:32px;border:1px solid var(--bd2);border-radius:5px;padding:0 8px;font-size:12px;outline:none"></div>';
  h+='<div class="frow" style="flex-direction:column;align-items:stretch"><div style="font-size:11px;font-weight:600;color:var(--pd);margin-bottom:3px">6. Hoàn thành chương trình</div><input type="text" id="hb_hoanth_text" value="'+(nx.hoan_thanh_text||htDefault)+'" style="width:100%;height:32px;border:1px solid var(--bd2);border-radius:5px;padding:0 8px;font-size:12px;outline:none"></div>';
  h+='</div></div>';
  T('hbBd').innerHTML=h;T('hbBg').classList.add('on');
}

function _collectHBData(){
  var s=SB[hbIdx],k=String(s.khoi),sj=SUBJ[k]||SUBJ['1'],nx={};
  // 2026-05-08: lý lịch HS (admin override khi HSS thiếu data)
  ['so_dang_bo','ngay_nhap_hoc','noi_sinh','que_quan','noi_o','giam_ho','ho_cha','ho_me'].forEach(function(k){
    var el=T('hb_'+k); if(el){ var v=el.value.trim(); if(v) nx[k]=v; }
  });
  nx.chieu_cao=T('hb_chieu_cao')?T('hb_chieu_cao').value.trim():'';
  nx.can_nang=T('hb_can_nang')?T('hb_can_nang').value.trim():'';
  nx.nghi_phep=T('hb_nghi_phep')?T('hb_nghi_phep').value.trim():'0';
  nx.nghi_kphep=T('hb_nghi_kphep')?T('hb_nghi_kphep').value.trim():'0';
  sj.forEach(function(mn){var el=T('nx_'+mn[1]);if(el)nx['nx_'+mn[1]]=el.value.trim();});
  if(T('hb_nx_pham_chat'))nx.nx_pham_chat=T('hb_nx_pham_chat').value.trim();
  if(T('hb_nx_nl_chung'))nx.nx_nl_chung=T('hb_nx_nl_chung').value.trim();
  if(T('hb_nx_nl_dacthu'))nx.nx_nl_dacthu=T('hb_nx_nl_dacthu').value.trim();
  if(T('hb_khen_text'))nx.khen_text=T('hb_khen_text').value.trim();
  if(T('hb_hoanth_text'))nx.hoan_thanh_text=T('hb_hoanth_text').value.trim();
  nx.updated_at=new Date().toLocaleString('vi-VN');
  nx.updated_by=CU?CU.username:'?';
  return nx;
}

function hbSaveOne(){
  if(hbIdx===null)return;var s=SB[hbIdx];
  var nx=_collectHBData();
  nhanXet[s.ma]=nx;try{localStorage.setItem('_nhanxet',JSON.stringify(nhanXet));}catch(e){}
  if(!GAS){toast('⚠️ Lưu tạm','warn');cm('hbBg');hbFil();return;}
  loader('Lưu học bạ...');
  gasPost({action:'saveNhanXet',ma:s.ma,nhan_xet:nx,user:CU?CU.username:'?'}).then(function(r){
    loader();toast(r.ok?'✅ Đã lưu học bạ':'❌ '+r.error,r.ok?'ok':'err');cm('hbBg');hbFil();
  }).catch(function(e){loader();toast('⚠️ Lưu local OK','warn');cm('hbBg');hbFil();});
}


// ═══════════════════════════════════════════════════════════════
// SINH NHẬN XÉT HỌC BẠ TỰ ĐỘNG — CHẠY TRỰC TIẾP (KHÔNG CẦN AI API)
// Dựa trên kết quả đánh giá + ngân hàng nhận xét chuẩn TT27
// ═══════════════════════════════════════════════════════════════

var _NX_MON = {
  HTT: {
    'mon_Toán': ['Em tính toán nhanh, chính xác, tích cực giơ tay phát biểu xây dựng bài.','Em nắm vững kiến thức toán học, vận dụng tốt vào giải toán.','Em có tư duy logic tốt, giải toán nhanh và chính xác.','Em tích cực trong học tập môn Toán, hoàn thành xuất sắc các bài kiểm tra.'],
    'mon_Tiếng_việt': ['Em đọc lưu loát, viết chữ đẹp, trình bày sạch sẽ.','Em học bài chăm chỉ, tích cực phát biểu ý kiến xây dựng bài.','Em có vốn từ phong phú, diễn đạt mạch lạc, viết văn hay.','Em đọc diễn cảm, hiểu nội dung bài đọc tốt, viết đúng chính tả.'],
    'mon_Đạo_đức': ['Biết áp dụng tốt các hành vi đạo đức đã học vào thực tiễn.','Em có ý thức tốt trong rèn luyện đạo đức, biết yêu thương giúp đỡ bạn bè.','Em thực hiện tốt các chuẩn mực đạo đức, là tấm gương cho các bạn.'],
    'mon_Tự_nhiên_và_xã_hội': ['Em nắm vững kiến thức về tự nhiên và xã hội, biết liên hệ thực tế.','Em tích cực tìm hiểu về thế giới xung quanh, có nhiều câu trả lời hay.','Em hoàn thành tốt các nhiệm vụ học tập môn TN&XH.'],
    'mon_Ngoại_ngữ': ['Hoàn thành tốt kiến thức, kỹ năng môn học. Kỹ năng nói tốt, có vốn từ vựng rộng.','Em phát âm chuẩn, tích cực giao tiếp bằng tiếng Anh.','Em nắm vững từ vựng và ngữ pháp, đọc hiểu tốt.'],
    'mon_TH-CN_Tin_học': ['Thành thạo các kỹ năng thực hành trên máy tính.','Em sử dụng thành thạo phần mềm học tập, hoàn thành tốt bài thực hành.','Em có kỹ năng tin học tốt, tích cực ứng dụng CNTT vào học tập.'],
    'mon_Khoa_học': ['Em học tập tốt, nắm vững kiến thức khoa học.','Em tích cực tìm hiểu, khám phá kiến thức khoa học. Biết vận dụng vào thực tế.','Em nắm chắc kiến thức khoa học, có nhiều câu hỏi hay trong giờ học.'],
    'mon_Lịch_sử_và_Địa_lí': ['Em nắm chắc kiến thức về lịch sử, địa lí.','Em hiểu biết tốt về các sự kiện lịch sử và đặc điểm địa lí.','Em tích cực tìm hiểu lịch sử dân tộc và địa lí Việt Nam.'],
    'mon_TH-CN_Công_nghệ': ['Em thực hiện tốt các yêu cầu cần đạt, có ý thức giữ gìn sản phẩm công nghệ.','Em nắm được kiến thức công nghệ, biết vận dụng vào thực tiễn.'],
    'mon_Nghệ_thuật_Âm_nhạc': ['Thuộc lời, hát đúng giai điệu lời ca, cố gắng hát rõ lời.','Em hát hay, đúng nhạc, tích cực tham gia hoạt động âm nhạc.','Em có năng khiếu âm nhạc, biết biểu diễn tự tin.'],
    'mon_Nghệ_thuật_Mĩ_thuật': ['Em nắm được cách thực hành và biết vận dụng để tạo sản phẩm.','Em vẽ đẹp, sáng tạo, biết phối màu hài hòa.','Em có óc thẩm mĩ tốt, thể hiện nét vẽ sinh động.'],
    'mon_Giáo_dục_thể_chất': ['Hoàn thành tốt các nội dung bài học. Tập các động tác đẹp, rõ ràng.','Em tích cực rèn luyện thể dục thể thao, có sức khỏe tốt.','Em thực hiện tốt các bài tập thể chất, đúng kỹ thuật.'],
    'mon_Hoạt_động_trải_nghiệm': ['Em nắm vững kiến thức, biết chỉ ra được hình ảnh thân thiện, vui vẻ của bản thân.','Em tích cực tham gia các hoạt động trải nghiệm, biết chia sẻ và hợp tác.','Em mạnh dạn, tự tin khi tham gia hoạt động trải nghiệm.']
  },
  HT: {
    'mon_Toán': ['Em hoàn thành kiến thức môn Toán, cần rèn thêm kỹ năng tính toán.','Em nắm được kiến thức cơ bản, cần cố gắng thêm trong giải toán.'],
    'mon_Tiếng_việt': ['Em đọc được bài, cần rèn thêm kỹ năng viết và trình bày.','Em hoàn thành bài tập, cần chú ý hơn về chính tả và diễn đạt.'],
    'mon_Đạo_đức': ['Em thực hiện được các chuẩn mực đạo đức cơ bản.','Em ngoan ngoãn, biết nghe lời thầy cô.'],
    'mon_Tự_nhiên_và_xã_hội': ['Em nắm được kiến thức cơ bản về tự nhiên và xã hội.','Em hoàn thành các bài học về TN&XH.'],
    'mon_Ngoại_ngữ': ['Em hoàn thành kiến thức cơ bản môn tiếng Anh, cần rèn thêm kỹ năng nghe nói.','Em nắm được từ vựng cơ bản, cần cố gắng thêm.'],
    'mon_TH-CN_Tin_học': ['Em thực hiện được các thao tác cơ bản trên máy tính.','Em hoàn thành các bài thực hành tin học.'],
    'mon_Khoa_học': ['Em nắm được kiến thức khoa học cơ bản.','Em hoàn thành bài học môn Khoa học.'],
    'mon_Lịch_sử_và_Địa_lí': ['Em nắm được kiến thức cơ bản về lịch sử, địa lí.','Em hoàn thành các bài học LS&ĐL.'],
    'mon_TH-CN_Công_nghệ': ['Em hoàn thành các yêu cầu cơ bản môn Công nghệ.','Em nắm được kiến thức cơ bản về công nghệ.'],
    'mon_Nghệ_thuật_Âm_nhạc': ['Em hát được bài, cần rèn thêm về giai điệu.','Em hoàn thành các bài học âm nhạc.'],
    'mon_Nghệ_thuật_Mĩ_thuật': ['Em vẽ được theo yêu cầu, cần sáng tạo thêm.','Em hoàn thành bài tập mĩ thuật.'],
    'mon_Giáo_dục_thể_chất': ['Em hoàn thành các bài tập thể chất cơ bản.','Em tham gia đầy đủ các giờ thể dục.'],
    'mon_Hoạt_động_trải_nghiệm': ['Em tham gia các hoạt động trải nghiệm, cần mạnh dạn hơn.','Em hoàn thành các hoạt động trải nghiệm.']
  },
  CHT: {
    _default: ['Em cần cố gắng hơn trong học tập.','Em chưa hoàn thành yêu cầu, cần được hỗ trợ thêm.']
  }
};

var _NX_PC = {
  T: ['Em chăm học, chăm làm, tích cực tham gia hoạt động; Tự tin trao đổi ý kiến trước tập thể; Đi học đều, đúng giờ; Trung thực trong học tập; Tự tin khi phát biểu.',
      'Em ngoan ngoãn, lễ phép với thầy cô; Yêu thương giúp đỡ bạn bè; Chăm chỉ học tập; Trung thực thật thà; Có tinh thần trách nhiệm cao.',
      'Em có phẩm chất tốt; Biết yêu quê hương đất nước; Nhân ái, biết giúp đỡ người khác; Chăm chỉ, siêng năng; Luôn trung thực; Có ý thức trách nhiệm.'],
  'Đ': ['Em ngoan, biết nghe lời thầy cô; Cần tích cực hơn trong học tập và rèn luyện.',
        'Em thực hiện được các phẩm chất cơ bản; Cần phát huy thêm tinh thần tự giác.'],
  CCG: ['Em cần rèn luyện thêm các phẩm chất; Thầy cô và gia đình cần phối hợp hỗ trợ em.']
};

var _NX_NLC = {
  T: ['Em chấp hành tốt nội quy lớp học; Mạnh dạn trong giao tiếp; Khả năng tự thực hiện nhiệm vụ học tập tốt.',
      'Em tự giác trong học tập; Giao tiếp mạnh dạn, tự tin; Biết hợp tác với bạn bè; Có khả năng giải quyết vấn đề tốt.',
      'Em chủ động trong học tập; Biết lắng nghe và chia sẻ; Sáng tạo trong giải quyết vấn đề.'],
  'Đ': ['Em thực hiện được các năng lực chung cơ bản; Cần mạnh dạn hơn trong giao tiếp.',
        'Em tự học được ở mức cơ bản; Cần phát huy thêm khả năng hợp tác.'],
  CCG: ['Em cần rèn luyện thêm các năng lực chung; Cần sự hỗ trợ của thầy cô.']
};

var _NX_NLD = {
  T: ['Em mạnh dạn khi giao tiếp; Vận dụng kiến thức tốt, tính toán nhanh; Thể hiện đẹp nét vẽ trong tranh; Có ý thức bảo vệ và giữ gìn sức khoẻ tự giác tập luyện thể dục, thể thao.',
      'Em có năng lực ngôn ngữ tốt; Tính toán nhanh chính xác; Yêu thích khoa học; Có óc thẩm mĩ; Tích cực rèn luyện thể chất.',
      'Em diễn đạt mạch lạc; Tư duy toán học tốt; Khám phá khoa học tích cực; Sáng tạo trong thẩm mĩ; Sức khỏe tốt.'],
  'Đ': ['Em thực hiện được các năng lực đặc thù ở mức cơ bản; Cần phát huy thêm.',
        'Em có năng lực cơ bản; Cần cố gắng phát triển thêm các kỹ năng.'],
  CCG: ['Em cần được hỗ trợ phát triển các năng lực đặc thù.']
};

function _randomPick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function _genNxMon(monKey, mucDat){
  var level = mucDat==='HTT'?'HTT':mucDat==='HT'?'HT':'CHT';
  var bank = _NX_MON[level];
  if(!bank) bank = _NX_MON.CHT;
  var arr = bank[monKey] || bank._default || ['Em hoàn thành yêu cầu môn học.'];
  return _randomPick(arr);
}

function _genNxPC(pcList, grades){
  // Xác định mức chung: nếu tất cả T → T, có CCG → CCG, còn lại → Đ
  var hasC = pcList.some(function(pc){ return grades[pc[1]]==='CCG'; });
  var allT = pcList.every(function(pc){ return grades[pc[1]]==='T'; });
  var level = hasC?'CCG':allT?'T':'Đ';
  return _randomPick(_NX_PC[level]||_NX_PC['Đ']);
}

function _genNxNLC(nlList, grades){
  var hasC = nlList.some(function(nl){ return grades[nl[1]]==='CCG'; });
  var allT = nlList.every(function(nl){ return grades[nl[1]]==='T'; });
  var level = hasC?'CCG':allT?'T':'Đ';
  return _randomPick(_NX_NLC[level]||_NX_NLC['Đ']);
}

function _genNxNLD(nlList, grades){
  var hasC = nlList.some(function(nl){ return grades[nl[1]]==='CCG'; });
  var allT = nlList.every(function(nl){ return grades[nl[1]]==='T'; });
  var level = hasC?'CCG':allT?'T':'Đ';
  return _randomPick(_NX_NLD[level]||_NX_NLD['Đ']);
}

// ═══ SINH NHẬN XÉT CHO 1 HS ═══
function _generateNhanXet(s){
  var g=grades[s.ma]||{}, k=parseInt(s.khoi);
  var sj=(SUBJ[String(k)]||SUBJ['1']).filter(function(x){return x[1]!=='mon_Tiếng_dân_tộc';});
  var allNL=_getAllNL(k);
  var nlChung=allNL.slice(0,3);
  var nlDacThu=allNL.slice(3);
  var result={};

  // Nhận xét từng môn
  sj.forEach(function(mn){
    var mv=g[mn[1]]||'';
    if(mv) result['nx_'+mn[1]]=_genNxMon(mn[1], mv);
  });

  // Nhận xét phẩm chất
  result.nx_pham_chat=_genNxPC(PC, g);

  // Nhận xét NL chung
  result.nx_nl_chung=_genNxNLC(nlChung, g);

  // Nhận xét NL đặc thù
  result.nx_nl_dacthu=_genNxNLD(nlDacThu, g);

  return result;
}

// ═══ AI NHẬN XÉT — 1 HS (trong modal) ═══
function hbAiOne(){
  if(hbIdx===null)return;
  var s=SB[hbIdx];if(!s)return;
  var g=grades[s.ma]||{};

  // Kiểm tra đã có đánh giá chưa
  var sj=(SUBJ[String(s.khoi)]||SUBJ['1']).filter(function(x){return x[1]!=='mon_Tiếng_dân_tộc';});
  var hasMon=sj.some(function(mn){return g[mn[1]];});
  if(!hasMon){toast('⚠️ Chưa có kết quả đánh giá để tạo nhận xét','warn');return;}

  loader('🤖 Đang tạo nhận xét...');
  setTimeout(function(){
    var data=_generateNhanXet(s);

    // Điền vào form
    sj.forEach(function(mn){
      var el=T('nx_'+mn[1]);
      if(el&&data['nx_'+mn[1]]) el.value=data['nx_'+mn[1]];
    });
    if(data.nx_pham_chat&&T('hb_nx_pham_chat')) T('hb_nx_pham_chat').value=data.nx_pham_chat;
    if(data.nx_nl_chung&&T('hb_nx_nl_chung')) T('hb_nx_nl_chung').value=data.nx_nl_chung;
    if(data.nx_nl_dacthu&&T('hb_nx_nl_dacthu')) T('hb_nx_nl_dacthu').value=data.nx_nl_dacthu;

    loader();
    toast('🤖 Đã tạo nhận xét cho '+s.ten+'!','ok');
  }, 300);
}

// ═══ AI NHẬN XÉT — CẢ LỚP ═══
function hbAiBatch(){
  var lop=T('hb-lop').value;if(!lop){toast('⚠️ Chọn lớp trước','warn');return;}
  var list=hbFiltered.filter(function(s){
    var nx=nhanXet[s.ma]||{};
    var g=grades[s.ma]||{};
    // Chỉ tạo cho HS chưa có nhận xét VÀ đã có đánh giá
    return !nx.nx_pham_chat && Object.keys(g).length>0;
  });
  if(!list.length){toast('ℹ️ Tất cả đã có nhận xét hoặc chưa có đánh giá','ok');return;}
  if(!confirm('Tạo nhận xét tự động cho '+list.length+' HS?\n\nHS đã có nhận xét sẽ được giữ nguyên.'))return;

  loader('🤖 Đang tạo nhận xét...');
  var ok=0;
  setTimeout(function(){
    list.forEach(function(s){
      var data=_generateNhanXet(s);
      var nx=nhanXet[s.ma]||{};
      Object.keys(data).forEach(function(dk){
        if(!nx[dk]) nx[dk]=data[dk]; // Chỉ điền nếu chưa có
      });
      nx.updated_at=new Date().toLocaleString('vi-VN');
      nx.updated_by='AI';
      nhanXet[s.ma]=nx;
      ok++;
    });
    try{localStorage.setItem('_nhanxet',JSON.stringify(nhanXet));}catch(e){}
    loader();
    toast('🤖 Đã tạo nhận xét cho '+ok+' HS!','ok');
    hbFil(); // Refresh danh sách
  }, 500);
}


function hbSaveBatch(){
  var lop=T('hb-lop').value;if(!lop){toast('⚠️ Chọn lớp','warn');return;}
  if(!GAS){toast('⚠️ Chưa có GAS','warn');return;}
  var batch=hbFiltered.filter(function(s){return nhanXet[s.ma];}).map(function(s){return{ma:s.ma,nhan_xet:nhanXet[s.ma]};});
  if(!batch.length){toast('ℹ️ Không có dữ liệu','warn');return;}
  loader('Lưu '+batch.length+' học bạ...');
  gasPost({action:'saveNhanXetBatch',batch:batch,user:CU?CU.username:'?'}).then(function(r){
    loader();toast(r.ok?'☁️ '+r.message:'❌ '+r.error,r.ok?'ok':'err');
    try{localStorage.setItem('_nhanxet',JSON.stringify(nhanXet));}catch(e){}
  }).catch(function(e){loader();toast('❌ '+e.message,'err');});
}

// XUẤT WORD — ĐÚNG MẪU HỌC BẠ TT27
// ═══════════════════════════════════════════════════════════════
// HỌC BẠ SỐ — XUẤT WORD/PDF CHUẨN BỘ GD&ĐT (TT27)
// ═══════════════════════════════════════════════════════════════

function _dl(blob,name){var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();URL.revokeObjectURL(a.href);}

function _hbWordBlob(html){
  var css='@page{size:A4;margin:2cm 1.5cm}'
    +'body{font-family:"Times New Roman",serif;font-size:13pt;line-height:1.6}'
    +'table{border-collapse:collapse;width:100%}'
    +'td,th{border:0.5pt solid #888;padding:5px 8px;font-size:12pt;vertical-align:middle}'
    +'h2,h3{margin:6px 0}'
    +'p{margin:4px 0}'
    +'.nb,.nb td,.nb th{border:none!important}'
    +'.tc{text-align:center}'
    +'.hdr{background:#D9E2F3;font-weight:bold;text-align:center}'
    +'.hdr-pc{background:#FCE4D6;font-weight:bold;text-align:center}'
    +'.hdr-nl{background:#E2EFDA;font-weight:bold;text-align:center}'
    +'.cover-box{border:3pt double #000;padding:40px 50px;min-height:90%;display:flex;flex-direction:column;justify-content:space-between}'
    +'.sign-tbl td{border:none!important;text-align:center;vertical-align:top;width:50%;padding-top:8px}';
  var pre='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    +'<head><meta charset="utf-8"><style>'+css+'</style></head><body>';
  return new Blob([pre+html+'</body></html>'],{type:'application/msword'});
}

// ═══ RENDER 1 HS HỌC BẠ ═══
// ═══════════════════════════════════════════════════════════════
// XUẤT HỌC BẠ WORD — TEMPLATE-BASED (2026-05-08)
// Dùng docxtemplater + PizZip → output .docx CHUẨN theo Phụ lục 1 TT 27/2020
// Template lưu tại: templates-hocba/Mau-HocBa-Lop{1..5}.docx
// ═══════════════════════════════════════════════════════════════

// Build data object để truyền cho docxtemplater
function _buildHocBaData(s){
  var g = grades[s.ma] || {};
  var kq = cTT(s.ma, s.khoi);
  var nx = nhanXet[s.ma] || {};
  var k = parseInt(s.khoi);
  var sj = (SUBJ[String(k)] || SUBJ['1']).filter(function(x){ return x[1] !== 'mon_Tiếng_dân_tộc'; });
  var school = localStorage.getItem('school_name_full') || 'Trường Tiểu học Diễn Liên';
  var xa = 'Xã Quảng Châu';
  var tinh = 'Tỉnh Nghệ An';
  var nam_hoc = '2025-2026';
  // 2026-05-08: Hiệu trưởng — default "Nguyễn Thị Hòa" (đã có ở trang chủ Hồ sơ số)
  var ht = localStorage.getItem('hieu_truong') || 'Nguyễn Thị Hòa';
  // 2026-05-08: GVCN lookup theo lớp HS
  // Ưu tiên: nx.gvcn (admin nhập riêng) → allUsers.find(lop_phu_trach) → ''
  var gvcn = nx.gvcn || '';
  if (!gvcn && typeof allUsers !== 'undefined' && allUsers && allUsers.length) {
    var t = allUsers.find(function(u){ return u && u.lop_phu_trach && u.lop_phu_trach.trim() === (s.lop || '').trim(); });
    if (t) gvcn = t.hoten || '';
  }
  var now = new Date();
  var mucDatMap = {HTT:'T', HT:'Đ', CHT:'C'};
  var allNL = _getAllNL(k);
  var nlChung = allNL.slice(0, 3);
  var nlDacThu = allNL.slice(3);

  // 2026-05-08: Map đúng mức môn học vs PC/NL theo TT27
  // Môn học: HTT→T, HT→H, CHT→C
  // PC/NL stored: T/Đ/C/CCG → display T/Đ/C
  var mucMonMap = {HTT:'T', HT:'H', CHT:'C'};
  var mucPcNlMap = {T:'T', Đ:'Đ', C:'C', CCG:'C'};
  function _mucMon(key){ return mucMonMap[g[key]] || g[key] || ''; }
  function _mucPcNl(key){ return mucPcNlMap[g[key]] || g[key] || ''; }
  function _nxMon(key){ return nx['nx_' + key] || ''; }

  return {
    // Tên HS — 2 dạng: proper + uppercase (template dùng cả 2)
    ten: s.ten || '',
    ten_upper: (s.ten || '').toUpperCase(),
    ten_uppercase: (s.ten || '').toUpperCase(), // alias cho template
    ma_dinh_danh: nx.ma_dinh_danh || s.ma || '',
    lop: s.lop || '',
    // Ngày sinh — 2 alias
    ngay_sinh: s.ns || '',
    ns: s.ns || '',
    // Giới tính — 2 alias
    gioi_tinh: s.gt || '',
    gt: s.gt || '',
    // 2026-05-08: Ưu tiên admin override (nx) > HSS sheet (s) > default
    // Vì admin có thể sửa qua panel openHB cho HS thiếu data trong HSS hoặc sai
    dan_toc: nx.dan_toc || s.dan_toc || 'Kinh',
    quoc_tich: nx.quoc_tich || s.quoc_tich || 'Việt Nam',
    noi_sinh: nx.noi_sinh || s.noi_sinh || '',
    que_quan: nx.que_quan || s.que_quan || '',
    noi_o:    nx.noi_o    || s.cho_o    || '',
    // Cha mẹ — 2 alias, admin override trước
    ho_cha: nx.ho_cha || s.cha || '',
    cha:    nx.ho_cha || s.cha || '',
    ho_me:  nx.ho_me  || s.me  || '',
    me:     nx.ho_me  || s.me  || '',
    giam_ho: nx.giam_ho || '',
    // Sổ đăng bộ + ngày nhập học (cần cho template)
    so_dang_bo: nx.so_dang_bo || '',
    ngay_nhap_hoc: nx.ngay_nhap_hoc || '',
    truong: school,
    xa: xa,
    tinh: tinh,
    nam_hoc: nam_hoc,
    hieu_truong: ht,
    gvcn: gvcn,
    chieu_cao: nx.chieu_cao || '',
    can_nang: nx.can_nang || '',
    nghi_phep: nx.nghi_phep || '0',
    nghi_kphep: nx.nghi_kphep || '0',
    ngay_thang_nam: xa + ', ngày ' + now.getDate() + ' tháng ' + (now.getMonth()+1) + ' năm ' + now.getFullYear(),
    // 2026-05-08: dòng ký đầu trang HỌC BẠ (đầu năm học - 06/9/<năm-học>)
    // Theo TT27: học bạ ký đầu năm khi nhận lớp = 06/9
    xa_ky_dau: xa + ', ngày 06 tháng 9 năm ' + (parseInt(nam_hoc.split('-')[0]) || now.getFullYear()),
    danh_gia_kq: kqText(kq) || '',
    khen_thuong: nx.khen_text || '',
    hoan_thanh_ct: nx.hoan_thanh_text || ('Hoàn thành chương trình lớp ' + s.lop),

    // === Mức đạt + Điểm + Nhận xét theo từng môn (cho template Mau-HocBa-Lop{1..5}.docx) ===
    muc_tieng_viet:    _mucMon('mon_Tiếng_việt'),
    muc_toan:          _mucMon('mon_Toán'),
    muc_ngoai_ngu:     _mucMon('mon_Ngoại_ngữ'),
    muc_dao_duc:       _mucMon('mon_Đạo_đức'),
    muc_tnxh:          _mucMon('mon_Tự_nhiên_và_xã_hội'),
    muc_am_nhac:       _mucMon('mon_Nghệ_thuật_Âm_nhạc'),
    muc_mi_thuat:      _mucMon('mon_Nghệ_thuật_Mĩ_thuật'),
    muc_the_chat:      _mucMon('mon_Giáo_dục_thể_chất'),
    muc_hdtn:          _mucMon('mon_Hoạt_động_trải_nghiệm'),
    // 2026-05-08: thêm cho lớp 3-5
    muc_tin_hoc:       _mucMon('mon_TH-CN_Tin_học'),
    muc_cong_nghe:     _mucMon('mon_TH-CN_Công_nghệ'),
    muc_khoa_hoc:      _mucMon('mon_Khoa_học'),
    muc_lich_su_dia_li:_mucMon('mon_Lịch_sử_và_Địa_lí'),
    diem_tieng_viet:    g.diem_Tiếng_việt || '',
    diem_toan:          g.diem_Toán || '',
    diem_ngoai_ngu:     g['diem_Ngoại_ngữ'] || '',
    diem_tin_hoc:       g['diem_TH-CN_Tin_học'] || '',
    diem_cong_nghe:     g['diem_TH-CN_Công_nghệ'] || '',
    diem_khoa_hoc:      g['diem_Khoa_học'] || '',
    diem_lich_su_dia_li:g['diem_Lịch_sử_và_Địa_lí'] || '',
    nx_tieng_viet:     _nxMon('mon_Tiếng_việt'),
    nx_toan:           _nxMon('mon_Toán'),
    nx_ngoai_ngu:      _nxMon('mon_Ngoại_ngữ'),
    nx_dao_duc:        _nxMon('mon_Đạo_đức'),
    nx_tnxh:           _nxMon('mon_Tự_nhiên_và_xã_hội'),
    nx_am_nhac:        _nxMon('mon_Nghệ_thuật_Âm_nhạc'),
    nx_mi_thuat:       _nxMon('mon_Nghệ_thuật_Mĩ_thuật'),
    nx_the_chat:       _nxMon('mon_Giáo_dục_thể_chất'),
    nx_hdtn:           _nxMon('mon_Hoạt_động_trải_nghiệm'),
    nx_tin_hoc:        _nxMon('mon_TH-CN_Tin_học'),
    nx_cong_nghe:      _nxMon('mon_TH-CN_Công_nghệ'),
    nx_khoa_hoc:       _nxMon('mon_Khoa_học'),
    nx_lich_su_dia_li: _nxMon('mon_Lịch_sử_và_Địa_lí'),
    // Phẩm chất
    pc_yeu_nuoc:     _mucPcNl('pc_Yêu_nước'),
    pc_nhan_ai:      _mucPcNl('pc_Nhân_ái'),
    pc_cham_chi:     _mucPcNl('pc_Chăm_chỉ'),
    pc_trung_thuc:   _mucPcNl('pc_Trung_thực'),
    pc_trach_nhiem:  _mucPcNl('pc_Trách_nhiệm'),
    nx_pham_chat:    nx.nx_pham_chat || '',
    // Năng lực chung
    nl_tu_chu:        _mucPcNl('nl_Tự_chủ_và_tự_học'),
    nl_giao_tiep:     _mucPcNl('nl_Giao_tiếp_và_hợp_tác'),
    nl_giai_quyet_vd: _mucPcNl('nl_Giải_quyết_vấn_đề_và_sáng_tạo'),
    nx_nl_chung:      nx.nx_nl_chung || '',
    // Lớp 2: nx_nl_chung bị chia 2 chunks trong template — pass full vào p1, để p2 trống
    nx_nl_chung_p1:   nx.nx_nl_chung || '',
    nx_nl_chung_p2:   '',
    // Năng lực đặc thù
    nl_ngon_ngu:      _mucPcNl('nl_Ngôn_ngữ'),
    nl_tinh_toan:     _mucPcNl('nl_Tính_toán'),
    nl_khoa_hoc:      _mucPcNl('nl_Khoa_học'),
    nl_cong_nghe:     _mucPcNl('nl_Công_nghệ'),
    nl_tin_hoc:       _mucPcNl('nl_Tin_học'),
    nl_tham_mi:       _mucPcNl('nl_Thẩm_mĩ'),
    nl_the_chat:      _mucPcNl('nl_Thể_chất'),
    nx_nl_dac_thu:    nx.nx_nl_dacthu || '',

    mon_hoc: sj.map(function(mn){
      var mv = g[mn[1]] || '';
      var dv = _hasDiem(mn, k) && mn[2] ? (g[mn[2]] || '') : '';
      var gvMon = nx['gv_' + mn[1]] || ((mn[1] === 'mon_Toán' || mn[1] === 'mon_Tiếng_Việt') ? gvcn : '');
      return {
        ten_mon: mn[0],
        muc_dat: mucDatMap[mv] || mv || '',
        diem: dv ? String(dv) : '',
        nhan_xet: nx['nx_' + mn[1]] || '',
        gv_ky: gvMon
      };
    }),

    pham_chat: PC.map(function(pc, i){
      return {
        ten_pc: pc[0],
        muc_dat: g[pc[1]] || '',
        nhan_xet: i === 0 ? (nx.nx_pham_chat || '') : ''
      };
    }),

    nl_chung: nlChung.map(function(nl, i){
      return {
        ten_nl: nl[0],
        muc_dat: g[nl[1]] || '',
        nhan_xet: i === 0 ? (nx.nx_nl_chung || '') : ''
      };
    }),

    nl_dac_thu: nlDacThu.map(function(nl, i){
      return {
        ten_nl: nl[0],
        muc_dat: g[nl[1]] || '',
        nhan_xet: i === 0 ? (nx.nx_nl_dacthu || '') : ''
      };
    })
  };
}

// 2026-05-08: Lazy-load allUsers nếu chưa có (cần để lookup GVCN khi xuất học bạ)
async function _ensureAllUsers(){
  if (typeof allUsers !== 'undefined' && allUsers && allUsers.length) return;
  if (!GAS) return; // không có GAS thì bỏ qua, GVCN sẽ trống
  try {
    var r = await gasCall({action:'getUsers'});
    if (r && r.ok && Array.isArray(r.data)) {
      allUsers = r.data;
    }
  } catch(e) { /* lỗi mạng — bỏ qua, GVCN sẽ trống */ }
}

// 2026-05-09: cache list chữ ký + cache binary ảnh (ArrayBuffer) — TTL 5 phút.
var _sigList = null, _sigListAt = 0;
var _sigImgCache = {};

async function _ensureSigList(){
  if (_sigList && (Date.now() - _sigListAt) < 5*60*1000) return _sigList;
  try{
    var r = await gasPost({action:'getSignatures'});
    if (r && r.ok) { _sigList = r.data; _sigListAt = Date.now(); return _sigList; }
  }catch(e){ console.warn('[SigList] fetch lỗi:', e.message); }
  _sigList = { ht:{}, dau:{}, gvcn:[] };
  return _sigList;
}

async function _getSigBytes(fileId){
  if (!fileId) return null;
  if (_sigImgCache[fileId]) return _sigImgCache[fileId];
  try{
    var r = await gasPost({action:'getSignatureImage', fileId:fileId});
    if (!r || !r.ok) return null;
    var b64 = r.data.base64;
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    _sigImgCache[fileId] = bytes.buffer;
    return bytes.buffer;
  }catch(e){
    console.warn('[SigImg] fileId='+fileId+' lỗi:', e.message);
    return null;
  }
}

// PNG 1×1 transparent — fallback khi chưa có ảnh thật để render không bị crash
var _EMPTY_PNG = (function(){
  var b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
})();

async function _resolveSigsForHS(s){
  var L = await _ensureSigList();
  var lop = String(s.lop || '').trim();
  var gv = (L.gvcn || []).find(function(g){
    var lops = String(g.lop || '').split(',').map(function(x){return x.trim();});
    return lops.indexOf(lop) >= 0;
  });
  return {
    htFileId:   L.ht  && L.ht.fileId,
    dauFileId:  L.dau && L.dau.fileId,
    gvcnFileId: gv && gv.fileId,
    gvcnHoTen:  (gv && gv.hoTen) || ''
  };
}

// 2026-05-09 v6: GVCN-only approach
// - HT: thầy chèn dấu+chữ ký TRỰC TIẾP vào template Word (1 lần per template)
// - GVCN: code thay bytes render-time (chữ ký khác theo lớp)
// - Template inject 1 placeholder sig_chuky_gvcn.png (rIdSigChukyGvcn)
async function _genHocBaDocx(s){
  if (typeof PizZip === 'undefined') throw new Error('Thiếu thư viện PizZip — kiểm tra CDN');
  if (typeof window.docxtemplater === 'undefined') throw new Error('Thiếu thư viện docxtemplater — kiểm tra CDN');

  await _ensureAllUsers();

  var khoi = parseInt(s.khoi) || 1;
  if (khoi < 1 || khoi > 5) khoi = 1;
  var tplUrl = 'templates-hocba/Mau-HocBa-Lop' + khoi + '.docx?v=2026.05.09-manual-edit';

  var resp = await fetch(tplUrl);
  if (!resp.ok) throw new Error('Không tải được template: ' + tplUrl + ' (HTTP ' + resp.status + ')');
  var arrayBuffer = await resp.arrayBuffer();

  var zip = new PizZip(arrayBuffer);
  var DocxTemplater = window.docxtemplater;
  var doc = new DocxTemplater(zip, {
    paragraphLoop: true,
    linebreaks: true
  });

  var _hbData = _buildHocBaData(s);
  doc.render(_hbData);

  // POST-PROCESS: chỉ thay bytes của ảnh chữ ký GVCN
  // 2026-05-09 fix: Word khi save lại template đã rename `sig_chuky_gvcn.png` → `imageN.png`
  // (và đổi rIdSigChukyGvcn → rIdN). Vì vậy KHÔNG ghi theo tên gốc — scan word/media/*.png
  // tìm file < 1KB (placeholder 1×1 transparent ~68B) và thay bytes file đó.
  var sigs    = await _resolveSigsForHS(s);
  var gvcnBuf = await _getSigBytes(sigs.gvcnFileId);

  var replacedAt = '';
  if (gvcnBuf){
    var zipObj = doc.getZip();
    var mediaFiles = zipObj.file(/^word\/media\/.+\.png$/i) || [];
    for (var i = 0; i < mediaFiles.length; i++){
      var f = mediaFiles[i];
      var origLen = (f.asUint8Array() || []).length;
      if (origLen > 0 && origLen < 1024){
        zipObj.file(f.name, new Uint8Array(gvcnBuf));
        replacedAt = f.name + ' (' + origLen + 'B → ' + gvcnBuf.byteLength + 'B)';
        break; // chỉ có 1 placeholder GVCN; HT do thầy chèn thủ công size lớn
      }
    }
    if (!replacedAt) console.warn('[HỌC BẠ] Không tìm thấy placeholder PNG <1KB trong word/media/ — chữ ký GVCN sẽ không hiện');
  }

  var _nx = nhanXet[s.ma] || {};
  console.log('[HỌC BẠ] HS:', s.ten, '| khối:', khoi);
  console.log('  Sheet HSS (s):', {noi_sinh: s.noi_sinh, cha: s.cha, me: s.me, cho_o: s.cho_o, hamlet: s.hamlet, ward: s.ward, province: s.province});
  console.log('  Override (nx):', {noi_sinh: _nx.noi_sinh, ho_cha: _nx.ho_cha, ho_me: _nx.ho_me, noi_o: _nx.noi_o, giam_ho: _nx.giam_ho});
  console.log('  → Output text:', {noi_sinh: _hbData.noi_sinh, cha: _hbData.cha, me: _hbData.me, noi_o: _hbData.noi_o, giam_ho: _hbData.giam_ho});
  console.log('  → GVCN signature:', {fileId: sigs.gvcnFileId, hoTen: sigs.gvcnHoTen, bytes: gvcnBuf ? gvcnBuf.byteLength+'B' : '(chưa upload)', replaced: replacedAt || '(không thay)'});

  return doc.getZip().generate({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
}

// Generate file zip chứa nhiều .docx (cho hbExportWord cả lớp)
async function _genHocBaZipAll(students){
  var outZip = new PizZip();
  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    try {
      var blob = await _genHocBaDocx(s);
      var ab = await blob.arrayBuffer();
      var safeName = (s.ten || ('HS_' + i)).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
      outZip.file('HocBa_' + safeName + '_' + (s.lop || '') + '.docx', ab);
    } catch (e) {
      console.error('Lỗi xuất HS', s.ten, e);
    }
  }
  return outZip.generate({type: 'blob', mimeType: 'application/zip'});
}

function _renderHocBa1HS(s, showCover){
  var g=grades[s.ma]||{}, kq=cTT(s.ma,s.khoi), nx=nhanXet[s.ma]||{};
  var k=parseInt(s.khoi), sj=(SUBJ[String(k)]||SUBJ['1']).filter(function(x){return x[1]!=='mon_Tiếng_dân_tộc';});
  var school=localStorage.getItem('school_name_full')||'Trường Tiểu học Diễn Liên';
  // 2026-05-07: Cải cách hành chính 2 cấp — bỏ huyện. Chỉ còn xã + tỉnh.
  var xa='Xã Quảng Châu', tinh='Tỉnh Nghệ An';
  var namHoc='2025-2026';
  var ht=localStorage.getItem('hieu_truong')||'';
  var gvcn=nx.gvcn||'';
  var now=new Date();
  var dateStr=xa+', ngày '+now.getDate()+' tháng '+(now.getMonth()+1)+' năm '+now.getFullYear();
  var mucDatMap={HTT:'T',HT:'Đ',CHT:'C'};
  var allNL=_getAllNL(k);
  var nlChung=allNL.slice(0,3);
  var nlDacThu=allNL.slice(3);
  var h='';

  // ═══ TRANG BÌA (chỉ lớp 1) ═══
  // ⭐ Refactor 2026-05-05 (Phase 6): theo bìa chuẩn Phụ lục 1 TT 27/2020/TT-BGDĐT.
  if(showCover){
    h+='<div class="cover-box">';
    h+='<div style="text-align:center"><p style="font-size:14pt;font-weight:bold">BỘ GIÁO DỤC VÀ ĐÀO TẠO</p></div>';
    h+='<div style="text-align:center;padding:60px 0">';
    h+='<p style="font-size:36pt;font-weight:bold;margin:20px 0">HỌC BẠ</p>';
    h+='<p style="font-size:26pt;font-weight:bold">TIỂU HỌC</p>';
    h+='<p style="font-size:14pt;margin-top:30px;font-style:italic">Năm học '+namHoc+'</p>';
    h+='</div>';
    h+='<div>';
    h+='<p style="font-size:14pt"><b>Họ và tên học sinh: '+s.ten.toUpperCase()+'</b></p>';
    h+='<p style="font-size:14pt"><b>Mã định danh học sinh: </b>'+(nx.ma_dinh_danh||s.ma||'')+'</p>';
    h+='<p style="font-size:14pt"><b>Trường: </b>'+school+'</p>';
    h+='<p style="font-size:14pt"><b>Xã (Phường): </b>'+xa+'</p>';
    h+='<p style="font-size:14pt"><b>Tỉnh (Thành phố): </b>'+tinh+'</p>';
    h+='</div></div>';
    h+='<br clear="all" style="page-break-before:always">';

    // ═══ TRANG LÝ LỊCH ═══
    h+='<h2 style="text-align:center;font-size:18pt"><b>HỌC BẠ</b></h2>';
    h+='<p><b>Họ và tên học sinh:</b> <b>'+s.ten.toUpperCase()+'</b> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>Giới tính:</b> '+(s.gt||'')+'</p>';
    h+='<p><b>Ngày, tháng, năm sinh:</b> <b>'+(s.ns||'')+'</b> &nbsp;&nbsp; <b>Dân tộc:</b> '+(nx.dan_toc||'Kinh')+' &nbsp;&nbsp; <b>Quốc tịch:</b> Việt Nam</p>';
    h+='<p><b>Nơi sinh:</b> '+(nx.noi_sinh||'')+'</p>';
    h+='<p><b>Quê quán:</b> '+(nx.que_quan||'')+'</p>';
    h+='<p><b>Nơi ở hiện nay:</b> '+(s.cho_o||nx.noi_o||'')+'</p>';
    h+='<p><b>Họ và tên cha:</b> '+(nx.ho_cha||'')+'</p>';
    h+='<p><b>Họ và tên mẹ:</b> '+(nx.ho_me||'')+'</p>';
    h+='<p><b>Người giám hộ (nếu có):</b> '+(nx.giam_ho||'')+'</p>';
    h+='<br><p style="text-align:center;font-style:italic">'+xa+', ngày ...... tháng ...... năm '+now.getFullYear()+'</p>';
    h+='<p style="text-align:center"><b>Hiệu trưởng</b></p>';
    h+='<p style="text-align:center;font-style:italic">(Ký, ghi rõ họ tên và đóng dấu)</p>';
    h+='<br><br><br><p style="text-align:center"><b>'+ht+'</b></p>';
    h+='<br><h3 style="text-align:center;font-size:14pt"><b>QUÁ TRÌNH HỌC TẬP</b></h3>';
    h+='<table><tr><th>Năm học</th><th>Lớp</th><th>Tên trường</th><th>Sổ đăng bộ</th><th>Ngày nhập học/<br>chuyển đến</th></tr>';
    h+='<tr><td class="tc">'+namHoc+'</td><td class="tc">'+s.lop+'</td><td class="tc">'+school+'</td><td></td><td></td></tr>';
    for(var ei=0;ei<6;ei++) h+='<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>';
    h+='</table>';
    h+='<br clear="all" style="page-break-before:always">';
  }

  // ═══ TRANG MÔN HỌC ═══
  // ⭐ Refactor 2026-05-05 (Phase 6): bố cục theo Phụ lục 1 TT 27/2020/TT-BGDĐT.
  // - Header trang đủ thông tin: HS, lớp, năm học, mã định danh, chiều cao, cân nặng, nghỉ phép
  // - Bảng môn học có cột "Tên giáo viên" + chữ ký (yêu cầu Phụ lục 1)
  h+='<p style="text-align:center;font-size:14pt"><b>HỌC BẠ</b></p>';
  h+='<p><b>Trường:</b> '+school+' &nbsp;&nbsp;&nbsp; <b>Năm học:</b> '+namHoc+'</p>';
  h+='<table class="nb" style="margin-bottom:6px"><tr>';
  h+='<td class="nb" style="width:55%"><b>Họ và tên học sinh:</b> <b>'+s.ten+'</b></td>';
  h+='<td class="nb"><b>Lớp:</b> <b>'+s.lop+'</b></td>';
  h+='<td class="nb"><b>Mã định danh:</b> '+(nx.ma_dinh_danh||s.ma||'')+'</td>';
  h+='</tr></table>';
  h+='<table class="nb"><tr>';
  h+='<td class="nb"><b>Chiều cao:</b> '+(nx.chieu_cao||'...')+' cm</td>';
  h+='<td class="nb"><b>Cân nặng:</b> '+(nx.can_nang||'...')+' kg</td>';
  h+='<td class="nb"><b>Nghỉ có phép:</b> '+(nx.nghi_phep||'0')+' buổi</td>';
  h+='<td class="nb"><b>Nghỉ không phép:</b> '+(nx.nghi_kphep||'0')+' buổi</td>';
  h+='</tr></table>';
  h+='<br><p><b>1. Các môn học và hoạt động giáo dục</b></p>';

  var hasDiem=sj.some(function(mn){return mn[2]&&mn[3]&&_hasDiem(mn,k);});
  h+='<table>';
  h+='<tr>';
  h+='<th class="hdr" style="width:22%">Môn học / Hoạt động giáo dục</th>';
  h+='<th class="hdr" style="width:8%">Mức đạt</th>';
  if(hasDiem) h+='<th class="hdr" style="width:7%">Điểm KTĐK</th>';
  h+='<th class="hdr" style="width:38%">Nhận xét tiến bộ về năng lực, phẩm chất</th>';
  h+='<th class="hdr" style="width:25%">Họ tên, chữ ký giáo viên</th>';
  h+='</tr>';
  sj.forEach(function(mn){
    var mv=g[mn[1]]||'', dv=_hasDiem(mn,k)&&mn[2]?(g[mn[2]]||''):'';
    var gvMon=nx['gv_'+mn[1]]||(mn[1]==='mon_Toán'||mn[1]==='mon_Tiếng_Việt'?gvcn:'');
    h+='<tr>';
    h+='<td><b>'+mn[0]+'</b></td>';
    h+='<td class="tc">'+(mucDatMap[mv]||mv)+'</td>';
    if(hasDiem) h+='<td class="tc">'+dv+'</td>';
    h+='<td>'+(nx['nx_'+mn[1]]||'')+'</td>';
    h+='<td class="tc" style="font-size:10pt">'+gvMon+'</td>';
    h+='</tr>';
  });
  h+='</table>';
  h+='<p style="font-size:10pt;font-style:italic;color:#666">Ghi chú: Mức đạt — T (Hoàn thành tốt), H (Hoàn thành), C (Chưa hoàn thành). Theo Thông tư 27/2020/TT-BGDĐT.</p>';

  h+='<br clear="all" style="page-break-before:always">';

  // ═══ TRANG PHẨM CHẤT + NĂNG LỰC ═══
  h+='<p><b>Trường:</b> <b>'+school+'</b> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>Năm học</b> <b>'+namHoc+'</b></p>';
  h+='<br><p><b>2. Những phẩm chất chủ yếu</b></p>';
  h+='<table><tr><th class="hdr-pc" style="width:22%">Phẩm chất</th><th class="hdr-pc" style="width:12%">Mức đạt được</th><th class="hdr-pc">Nhận xét</th></tr>';
  PC.forEach(function(pc,i){
    var v=g[pc[1]]||'';
    h+='<tr><td>'+pc[0]+'</td><td class="tc">'+v+'</td>';
    if(i===0) h+='<td rowspan="'+PC.length+'">'+(nx.nx_pham_chat||'')+'</td>';
    h+='</tr>';
  });
  h+='</table>';

  h+='<br><p><b>3. Những năng lực cốt lõi</b></p>';
  h+='<p><b><i>3.1 Những năng lực chung</i></b></p>';
  h+='<table><tr><th class="hdr-nl" style="width:22%">Năng lực</th><th class="hdr-nl" style="width:12%">Mức đạt được</th><th class="hdr-nl">Nhận xét</th></tr>';
  nlChung.forEach(function(nl,i){
    var v=g[nl[1]]||'';
    h+='<tr><td>'+nl[0]+'</td><td class="tc">'+v+'</td>';
    if(i===0) h+='<td rowspan="'+nlChung.length+'">'+(nx.nx_nl_chung||'')+'</td>';
    h+='</tr>';
  });
  h+='</table>';

  h+='<br><p><b><i>3.2 Những năng lực đặc thù</i></b></p>';
  h+='<table><tr><th class="hdr-nl" style="width:22%">Năng lực</th><th class="hdr-nl" style="width:12%">Mức đạt được</th><th class="hdr-nl">Nhận xét</th></tr>';
  nlDacThu.forEach(function(nl,i){
    var v=g[nl[1]]||'';
    h+='<tr><td>'+nl[0]+'</td><td class="tc">'+v+'</td>';
    if(i===0) h+='<td rowspan="'+nlDacThu.length+'">'+(nx.nx_nl_dacthu||'')+'</td>';
    h+='</tr>';
  });
  h+='</table>';

  h+='<br clear="all" style="page-break-before:always">';

  // ═══ TRANG KẾT LUẬN ═══
  h+='<p><b>4. Đánh giá kết quả giáo dục:</b> '+kqText(kq)+'.</p>';
  h+='<br><p><b>5. Khen thưởng:</b></p>';
  h+='<p>&nbsp;&nbsp; - '+(nx.khen_text||'...')+'</p>';
  h+='<br><p><b>6. Hoàn thành chương trình lớp học/chương trình tiểu học:</b></p>';
  h+='<p>&nbsp;&nbsp; - '+(nx.hoan_thanh_text||'Hoàn thành chương trình lớp '+s.lop+'.')+'</p>';
  h+='<br><br><p style="text-align:right;font-style:italic">'+dateStr+'</p>';
  h+='<br><table class="nb sign-tbl"><tr>';
  h+='<td><b>Xác nhận của Hiệu trưởng</b><br><i>(Ký, ghi rõ họ tên và đóng dấu)</i><br><br><br><br><br><b>'+ht+'</b></td>';
  h+='<td><b>Giáo viên chủ nhiệm</b><br><i>(Ký và ghi rõ họ tên)</i><br><br><br><br><br><b>'+gvcn+'</b></td>';
  h+='</tr></table>';

  return h;
}

// ═══ XUẤT HỌC BẠ WORD — CẢ LỚP (zip nhiều .docx) ═══
async function hbExportWord(){
  var lop=T('hb-lop').value;if(!lop){toast('⚠️ Chọn lớp','warn');return;}
  var list=hbFiltered;if(!list.length){toast('⚠️ Không có HS','warn');return;}
  loader('Đang tạo '+list.length+' học bạ...');
  try{
    var zipBlob = await _genHocBaZipAll(list);
    _dl(zipBlob, 'HocBa_Lop'+lop+'_'+new Date().toISOString().slice(0,10)+'.zip');
    loader();
    toast('📦 Xuất '+list.length+' học bạ (.zip) — Lớp '+lop,'ok');
  }catch(e){
    loader();
    console.error(e);
    toast('❌ Lỗi xuất học bạ: '+(e.message||e),'err');
  }
}

// ═══ XUẤT HỌC BẠ WORD — 1 HS (gọi từ modal) ═══
async function hbExportWordOne(){
  if(hbIdx===null){toast('⚠️ Chưa chọn HS','warn');return;}
  var s=SB[hbIdx];if(!s)return;
  // Tự động lưu nhận xét từ form trước khi xuất
  var nx=_collectHBData();
  nhanXet[s.ma]=nx;
  try{localStorage.setItem('_nhanxet',JSON.stringify(nhanXet));}catch(e){}
  loader('Đang tạo học bạ...');
  try{
    var blob = await _genHocBaDocx(s);
    _dl(blob, 'HocBa_'+s.ten.replace(/\s+/g,'_')+'_'+s.lop+'.docx');
    loader();
    toast('📄 Xuất học bạ: '+s.ten,'ok');
  }catch(e){
    loader();
    console.error(e);
    toast('❌ Lỗi xuất học bạ: '+(e.message||e),'err');
  }
}

// 2026-05-09 — Phase 1E: render Word + upload Drive + convert PDF + ghi HSS_Status.
// Server xử lý Drive bên backend (action 'exportHocBaSingle'); FE chỉ gửi blob base64.
async function hbExportToDrive(){
  if(hbIdx===null){toast('⚠️ Chưa chọn HS','warn');return;}
  var s=SB[hbIdx]; if(!s) return;
  // Tự lưu nhận xét trước
  var nx=_collectHBData();
  nhanXet[s.ma]=nx;
  try{localStorage.setItem('_nhanxet',JSON.stringify(nhanXet));}catch(e){}
  loader('Đang render Word…');
  try{
    var blob = await _genHocBaDocx(s);
    loader('Đang lưu Drive + convert PDF…');
    var base64 = await _blobToBase64(blob);
    var r = await gasPost({
      action:    'exportHocBaSingle',
      maHS:      s.ma,
      hoTen:     s.ten,
      lop:       s.lop,
      docxBase64: base64
    });
    loader();
    if(!r.ok) throw new Error(r.error || 'Server từ chối lưu');
    var d = r.data;
    var pdfMsg = d.pdfUrl ? '✅ DOCX + PDF đã lưu Drive' : '⚠ DOCX OK, PDF lỗi: '+(d.pdfError||'?');
    toast(pdfMsg, d.pdfUrl ? 'ok' : 'warn');
    _showExportLinks(s, d);
  }catch(e){
    loader();
    console.error(e);
    toast('❌ '+(e.message||e),'err');
  }
}

function _blobToBase64(blob){
  return new Promise(function(res, rej){
    var reader = new FileReader();
    reader.onload = function(){
      var s = String(reader.result);
      var i = s.indexOf(',');
      res(i >= 0 ? s.substring(i+1) : s);
    };
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });
}

// 2026-05-09 — Phase 1F + 1G: xuất cả lớp lên Drive + zip server-side.
// Loop tuần tự từng HS (Phương án a — đơn giản, dễ debug). 30 HS × ~5s = ~2.5 phút.
async function hbExportClassToDrive(){
  var lop = T('hb-lop').value;
  if (!lop) { toast('⚠️ Chọn lớp trước', 'warn'); return; }
  var list = (typeof hbFiltered !== 'undefined' && hbFiltered.length) ? hbFiltered : SB.filter(function(s){return String(s.lop).trim()===String(lop).trim();});
  if (!list.length) { toast('⚠️ Lớp không có HS', 'warn'); return; }
  var est = Math.ceil(list.length * 5 / 60);  // phút ước tính
  if (!confirm('Xuất Word + PDF của ' + list.length + ' HS lớp ' + lop + ' lên Google Drive?\n\nƯớc tính ~' + est + ' phút (tuần tự từng HS).\n\nKhông đóng/làm mới tab trong lúc đang chạy.')) return;

  var ok = 0, fail = 0, errors = [];
  var startTs = Date.now();
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    loader('(' + (i + 1) + '/' + list.length + ') Đang xuất: ' + s.ten + '…');
    try {
      var blob = await _genHocBaDocx(s);
      var b64  = await _blobToBase64(blob);
      var r = await gasPost({
        action:    'exportHocBaSingle',
        maHS:      s.ma,
        hoTen:     s.ten,
        lop:       s.lop,
        docxBase64: b64
      });
      if (!r.ok) throw new Error(r.error || 'server từ chối');
      ok++;
    } catch (e) {
      fail++;
      errors.push(s.ten + ': ' + (e.message || e));
      console.error('[hbExportClassToDrive]', s.ten, e);
    }
  }

  // Sau khi loop xong → server tạo ZIP
  loader('Đang tạo file ZIP cả lớp…');
  var zipR = null;
  try {
    zipR = await gasPost({ action:'zipClassFolder', lop: lop });
  } catch (e) {
    console.error('[hbExportClassToDrive] zip lỗi:', e);
  }
  loader();

  var elapsed = Math.round((Date.now() - startTs) / 1000);
  var msg = '📊 Kết quả xuất học bạ lớp ' + lop + ' (' + elapsed + 's):\n'
    + '  ✅ ' + ok + ' thành công\n'
    + (fail ? '  ❌ ' + fail + ' lỗi:\n    ' + errors.slice(0,5).join('\n    ') + (errors.length>5?'\n    …(và '+(errors.length-5)+' lỗi khác)':'') + '\n' : '');
  if (zipR && zipR.ok && zipR.data) {
    msg += '\n📦 ZIP: ' + zipR.data.zipName + ' (' + zipR.data.fileCount + ' file)';
    if (zipR.data.folderUrl && confirm(msg + '\n\nMở thư mục Drive lớp ' + lop + '?')) {
      window.open(zipR.data.folderUrl, '_blank');
    } else {
      toast(ok + '/' + list.length + ' HS đã lưu Drive', fail ? 'warn' : 'ok');
    }
  } else {
    alert(msg + '\n\n⚠ Tạo ZIP thất bại — file riêng vẫn có trong Drive.');
  }
}

function _showExportLinks(s, d){
  var msg = '<div style="font-size:13px;line-height:1.7">'
    + '<b>✅ Đã lưu học bạ lên Drive</b><br>'
    + 'HS: <b>'+s.ten+'</b> · Lớp '+s.lop+'<br><br>'
    + (d.wordUrl ? '<a href="'+d.wordUrl+'" target="_blank" style="color:#2563eb">📄 Mở file Word</a><br>' : '')
    + (d.pdfUrl  ? '<a href="'+d.pdfUrl +'" target="_blank" style="color:#dc2626">📕 Mở file PDF</a><br>'  : (d.pdfError ? '<span style="color:#dc2626">⚠ PDF lỗi: '+d.pdfError+'</span><br>' : ''))
    + (d.folderUrl ? '<a href="'+d.folderUrl+'" target="_blank" style="color:#0d9488">📁 Mở thư mục Drive</a>' : '')
    + '</div>';
  // Dùng confirm thay vì modal phức tạp — đơn giản, mobile-friendly
  // Browser confirm không hỗ trợ HTML, nên cho ra alert text + auto-open Drive folder
  var txt = '✅ Đã lưu học bạ lên Drive\n\n'
    + 'HS: '+s.ten+' · Lớp '+s.lop+'\n\n'
    + (d.wordUrl ? '📄 Word: '+d.wordUrl+'\n' : '')
    + (d.pdfUrl  ? '📕 PDF: '+d.pdfUrl+'\n'  : (d.pdfError ? '⚠ PDF lỗi: '+d.pdfError+'\n' : ''))
    + (d.folderUrl ? '\n📁 Mở thư mục Drive?' : '');
  if (d.folderUrl && confirm(txt)) window.open(d.folderUrl, '_blank');
}

// ═══════════════════════════════════════════════════════════════
// 4. XUẤT HỌC BẠ EXCEL — CHUẨN, ĐẸP MẮT
// ═══════════════════════════════════════════════════════════════
function hbExportExcel(){
  var lop=T('hb-lop').value;if(!lop){toast('⚠️ Chọn lớp','warn');return;}
  var KL={HTXS:'HT Xuất sắc',HTT:'HT Tốt',HT:'Hoàn thành',CHT:'Chưa HT'};
  var school=_rptSchool();
  var ws={};
  var R=0, COLS=11;

  // ── Tiêu đề ──
  _rptSet(ws,R,0,school.toUpperCase(),{font:{bold:true,sz:14,name:'Times New Roman',color:{rgb:'1A237E'}},alignment:{horizontal:'center',vertical:'center'}});
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'DANH SÁCH HỌC BẠ — LỚP '+lop.toUpperCase(),_rptS(_RPT.title));
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',_rptS(_RPT.title));
  _rptMerge(ws,R,0,R,COLS-1);
  R++;
  _rptSet(ws,R,0,'Năm học 2025–2026 · '+_rptDate(),_rptS(_RPT.subtitle));
  for(var i=1;i<COLS;i++) _rptSet(ws,R,i,'',_rptS(_RPT.subtitle));
  _rptMerge(ws,R,0,R,COLS-1);
  R++; R++;

  // ── Headers ──
  var hdrs=['STT','Họ và tên','Ngày sinh','GT','Cao (cm)','Nặng (kg)','Kết quả GD','Khen thưởng','NX Phẩm chất','Nghỉ CP','Nghỉ KP'];
  var hdrStyles=[_RPT.hdr1,_RPT.hdr4,_RPT.hdr1,_RPT.hdr1,_RPT.hdr2,_RPT.hdr2,_RPT.hdr3,_RPT.hdr3,_RPT.hdr4,_RPT.hdr1,_RPT.hdr1];
  hdrs.forEach(function(h,i){_rptSet(ws,R,i,h,_rptST(hdrStyles[i]));});
  R++;

  // ── Data ──
  var stt=0;
  hbFiltered.forEach(function(s,idx){
    stt++;
    var g=grades[s.ma]||{},kq=cTT(s.ma,s.khoi),nx=nhanXet[s.ma]||{};
    var isAlt=idx%2===1;
    var sc=isAlt?_RPT.alt:_RPT.dataC;
    var sl=isAlt?_RPT.altL:_RPT.dataL;
    _rptSet(ws,R,0,stt,_rptS(sc));
    _rptSet(ws,R,1,s.ten,_rptS(sl));
    _rptSet(ws,R,2,s.ns||'',_rptS(sc));
    _rptSet(ws,R,3,s.gt||'',_rptS(sc));
    _rptSet(ws,R,4,nx.chieu_cao||'',_rptS(sc));
    _rptSet(ws,R,5,nx.can_nang||'',_rptS(sc));
    _rptSet(ws,R,6,KL[kq]||'—',_rptS(_kqStyle(kq)));
    _rptSet(ws,R,7,nx.khen_text||'',_rptS(sl));
    _rptSet(ws,R,8,nx.nx_pham_chat||'',_rptS(sl));
    _rptSet(ws,R,9,nx.nghi_phep||'0',_rptS(sc));
    _rptSet(ws,R,10,nx.nghi_kphep||'0',_rptS(sc));
    R++;
  });

  // ── Footer ──
  R++;
  _rptSet(ws,R,0,'Tổng: '+stt+' học sinh',_rptS(_RPT.footer));
  for(var i=1;i<4;i++) _rptSet(ws,R,i,'',{});
  _rptMerge(ws,R,0,R,3);

  ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R,c:COLS-1}});
  ws['!cols']=[{wch:5},{wch:26},{wch:14},{wch:6},{wch:10},{wch:10},{wch:18},{wch:22},{wch:30},{wch:8},{wch:8}];
  ws['!rows']=[{hpt:28},{hpt:30},{hpt:20},{hpt:10},{hpt:26}];

  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Học bạ '+lop);
  XLSX.writeFile(wb,'HocBa_'+lop+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('📊 Xuất học bạ Excel lớp '+lop+' thành công!','ok');
}



// ═══════════════════════════════════════════════════════════════
// 3. BẢNG TỔNG HỢP CHẤT LƯỢNG — WORD CHUẨN CÔNG VĂN
// ═══════════════════════════════════════════════════════════════
function expBangCLWord(){
  var school=localStorage.getItem('school_name_full')||'Trường Tiểu học Diễn Liên';
  var addr=localStorage.getItem('school_addr')||'Xã Quảng Châu, Tỉnh Nghệ An';
  var periodName=_rptPeriodName();
  var ht=localStorage.getItem('hieu_truong')||'';
  var now=new Date();
  var dateStr='ngày '+now.getDate()+' tháng '+(now.getMonth()+1)+' năm '+now.getFullYear();
  var lopSet={};allS.forEach(function(s){lopSet[s.lop]=1;});var lops=Object.keys(lopSet).sort();

  var css='@page{size:A4 landscape;margin:1.5cm 1.5cm 2cm 2cm}'
    +'body{font-family:"Times New Roman",serif;font-size:13pt;line-height:1.5;color:#222}'
    +'table{border-collapse:collapse;width:100%}'
    +'td,th{border:1pt solid #555;padding:6px 10px;font-size:12pt;vertical-align:middle}'
    +'h2,h3{margin:4px 0}'
    +'.tc{text-align:center}'
    +'.hdr{background:#1565C0;color:#fff;font-weight:bold;text-align:center;font-size:11pt;padding:8px 6px}'
    +'.hdr2{background:#2E7D32;color:#fff;font-weight:bold;text-align:center;font-size:10pt;padding:6px 4px}'
    +'.hdr3{background:#E65100;color:#fff;font-weight:bold;text-align:center;font-size:10pt;padding:6px 4px}'
    +'.hdr4{background:#6A1B9A;color:#fff;font-weight:bold;text-align:center;font-size:10pt;padding:6px 4px}'
    +'.tot{background:#37474F;color:#fff;font-weight:bold;font-size:12pt}'
    +'.alt{background:#F5F5F5}'
    +'.htxs{background:#FFF3E0;color:#E65100;font-weight:bold}'
    +'.htt{background:#E8F5E9;color:#2E7D32;font-weight:bold}'
    +'.ht2{background:#E3F2FD;color:#1565C0;font-weight:bold}'
    +'.cht2{background:#FFEBEE;color:#C62828;font-weight:bold}'
    +'.pctG{color:#2E7D32;font-weight:bold;font-size:13pt}'
    +'.pctW{color:#E65100;font-weight:bold;font-size:13pt}'
    +'.pctB{color:#C62828;font-weight:bold;font-size:13pt}'
    +'.nb,.nb td,.nb th{border:none!important}'
    +'.sign-tbl td{border:none!important;text-align:center;vertical-align:top;width:50%;padding-top:10px}';

  var html='';
  // Header cơ quan
  html+='<table class="nb" style="margin-bottom:8px"><tr>';
  html+='<td style="text-align:center;width:40%;font-size:11pt">PHÒNG GD&ĐT DIỄN CHÂU<br><b>'+school.toUpperCase()+'</b><br><span style="font-size:10pt;color:#666">'+addr+'</span></td>';
  html+='<td style="text-align:center;width:60%;font-size:11pt"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><u>Độc lập — Tự do — Hạnh phúc</u></td>';
  html+='</tr></table>';

  // Tiêu đề
  html+='<h2 style="text-align:center;font-size:16pt;margin:16px 0 4px;color:#1A237E">BẢNG TỔNG HỢP CHẤT LƯỢNG GIÁO DỤC</h2>';
  html+='<h3 style="text-align:center;font-size:13pt;font-weight:normal;color:#546E7A;margin-bottom:14px">Kỳ: '+periodName+' — Năm học 2025–2026</h3>';

  // Bảng chính
  html+='<table>';
  // Header row 1
  html+='<tr>';
  html+='<th class="hdr" rowspan="2" style="width:8%">Lớp</th>';
  html+='<th class="hdr" rowspan="2" style="width:6%">Sĩ số</th>';
  html+='<th class="hdr" rowspan="2" style="width:7%">Đã nhập</th>';
  html+='<th class="hdr2" colspan="5">Kết quả giáo dục</th>';
  html+='<th class="hdr3" colspan="2">Khen thưởng</th>';
  html+='<th class="hdr4" rowspan="2" style="width:6%">Lên lớp</th>';
  html+='<th class="hdr4" rowspan="2" style="width:5%">Ở lại</th>';
  html+='</tr>';
  // Header row 2
  html+='<tr>';
  html+='<th class="hdr2">HT Xuất sắc</th><th class="hdr2">HT Tốt</th><th class="hdr2">Hoàn thành</th><th class="hdr2">Chưa HT</th><th class="hdr2">Tỉ lệ HT</th>';
  html+='<th class="hdr3">Xuất sắc</th><th class="hdr3">Tiêu biểu</th>';
  html+='</tr>';

  // Data rows
  var totR={tot:0,nhap:0,htxs:0,htt:0,ht:0,cht:0,xs:0,tb:0,ll:0};
  lops.forEach(function(lop,idx){
    var d=cLop(allS.filter(function(s){return s.lop===lop;}));
    Object.keys(totR).forEach(function(k){totR[k]+=d[k]||0;});
    var hp=d.nhap?Math.round((d.htxs+d.htt+d.ht)/d.nhap*100):0;
    var oLai=d.tot-d.ll;
    var altC=idx%2===1?' class="alt"':'';
    var pctC=hp>=90?'pctG':hp>=70?'pctW':'pctB';
    html+='<tr'+altC+'>';
    html+='<td class="tc" style="font-weight:600">Lớp '+lop+'</td>';
    html+='<td class="tc">'+d.tot+'</td>';
    html+='<td class="tc">'+d.nhap+'</td>';
    html+='<td class="tc'+(d.htxs>0?' htxs':'')+'">'+d.htxs+'</td>';
    html+='<td class="tc'+(d.htt>0?' htt':'')+'">'+d.htt+'</td>';
    html+='<td class="tc'+(d.ht>0?' ht2':'')+'">'+d.ht+'</td>';
    html+='<td class="tc'+(d.cht>0?' cht2':'')+'">'+d.cht+'</td>';
    html+='<td class="tc '+pctC+'">'+hp+'%</td>';
    html+='<td class="tc">'+d.xs+'</td>';
    html+='<td class="tc">'+d.tb+'</td>';
    html+='<td class="tc">'+d.ll+'</td>';
    html+='<td class="tc">'+(oLai>0?oLai:'0')+'</td>';
    html+='</tr>';
  });

  // Total row
  var tp=totR.nhap?Math.round((totR.htxs+totR.htt+totR.ht)/totR.nhap*100):0;
  var tOlai=totR.tot-totR.ll;
  html+='<tr class="tot">';
  html+='<td class="tc">TỔNG</td>';
  html+='<td class="tc">'+totR.tot+'</td>';
  html+='<td class="tc">'+totR.nhap+'</td>';
  html+='<td class="tc">'+totR.htxs+'</td>';
  html+='<td class="tc">'+totR.htt+'</td>';
  html+='<td class="tc">'+totR.ht+'</td>';
  html+='<td class="tc">'+totR.cht+'</td>';
  html+='<td class="tc">'+tp+'%</td>';
  html+='<td class="tc">'+totR.xs+'</td>';
  html+='<td class="tc">'+totR.tb+'</td>';
  html+='<td class="tc">'+totR.ll+'</td>';
  html+='<td class="tc">'+(tOlai>0?tOlai:'0')+'</td>';
  html+='</tr></table>';

  // Chữ ký
  html+='<br><br><table class="nb sign-tbl"><tr>';
  html+='<td style="width:50%"><br><b>Người lập biểu</b><br><i style="color:#888;font-size:11pt">(Ký, ghi rõ họ tên)</i><br><br><br><br><br><b>'+(CU?CU.hoten||CU.username:'')+'</b></td>';
  html+='<td style="width:50%"><i>Diễn Liên, '+dateStr+'</i><br><b>Hiệu trưởng</b><br><i style="color:#888;font-size:11pt">(Ký, ghi rõ họ tên và đóng dấu)</i><br><br><br><br><br><b>'+ht+'</b></td>';
  html+='</tr></table>';

  var pre='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    +'<head><meta charset="utf-8"><style>'+css+'</style></head><body>';
  var blob=new Blob([pre+html+'</body></html>'],{type:'application/msword'});
  _dl(blob,'BangChatLuong_'+curPeriod+'_'+new Date().toISOString().slice(0,10)+'.doc');
  toast('📄 Xuất bảng chất lượng Word thành công!','ok');
}

// AUTO-LOGIN
window.addEventListener('load',function(){
  // V2.0: Xóa cache URL cũ nếu DEFAULT_GAS đã thay đổi
  var cachedGAS=localStorage.getItem('gas_url');
  if(cachedGAS&&DEFAULT_GAS&&cachedGAS!==DEFAULT_GAS){localStorage.setItem('gas_url',DEFAULT_GAS);GAS=DEFAULT_GAS;}
  // Check GAS URL from query string
  var urlP=new URLSearchParams(window.location.search),gasP=urlP.get('gas');
  if(gasP&&gasP.indexOf('script.google.com')>=0){localStorage.setItem('gas_url',gasP);DEFAULT_GAS=gasP;GAS=gasP;window.history.replaceState({},'',window.location.href.split('?')[0]);setTimeout(function(){toast('✅ Máy đã cấu hình!','ok');},300);}
  // Đã login trước → khôi phục CU
  var cu=localStorage.getItem('_cu');
  if(cu){
    try{
      var p=JSON.parse(cu);
      if(p&&p.username&&p.sessionToken){CU=p;loginOK(false);return;}
    }catch(e){localStorage.removeItem('_cu');}
  }
  // ⭐ 2026-05-07: chưa login → vào chế độ Khách (xem DSHS công khai)
  CU={username:'guest',hoten:'Khách',role:'guest',sessionToken:'',lop:'',phan_cong:''};
  loginOK(true);
});

// Phase 2: Override gp to update sidebar + title
var _origGp=gp;
gp=function(id,el){
  // Update sidebar
  document.querySelectorAll('.sb-item').forEach(function(s){s.classList.remove('on');});
  if(el){
    if(el.classList.contains('sb-item'))el.classList.add('on');
  }else{
    document.querySelectorAll('.sb-item').forEach(function(s){
      if(s.getAttribute('onclick')&&s.getAttribute('onclick').indexOf("'"+id+"'")>=0)s.classList.add('on');
    });
  }
  // Update title
  var titles={
    'pg-hs':'Học sinh','pg-diem':'Nhập kết quả đánh giá','pg-hocba':'Học bạ số',
    'pg-status':'Trạng thái nhập liệu','pg-tk':'Thống kê chất lượng',
    'pg-export':'Trích xuất dữ liệu','pg-users':'Phân quyền CBGV',
    'pg-import':'Nhập danh sách học sinh','pg-settings':'Cài đặt hệ thống'
  };
  if(T('page-title'))T('page-title').textContent=titles[id]||'';
  if(T('exp-period'))T('exp-period').textContent=PERIODS.find(function(p){return p.id===curPeriod;}).name;
  // Update period badge color
  var pc=PERIODS.find(function(p){return p.id===curPeriod;});
  if(pc&&T('cur-period-label')){
    T('cur-period-label').textContent=pc.name;
    T('cur-period-label').style.background=pc.color+'22';
    T('cur-period-label').style.color=pc.color;
  }

  // Update header kỳ đánh giá
  var pc2=PERIODS.find(function(p){return p.id===curPeriod;});
  if(pc2&&T('hky-period'))T('hky-period').textContent=pc2.name;
  if(T('hky-title')){
    var pageNames={'pg-hs':'Quản lý Học sinh','pg-diem':'Nhập kết quả đánh giá','pg-hocba':'Học bạ số','pg-status':'Trạng thái nhập liệu','pg-tk':'Thống kê chất lượng','pg-export':'Trích xuất dữ liệu'};
    T('hky-title').textContent=(pageNames[id]||'Đánh giá học sinh')+' — '+pc2.name;
  }
  // Call pages
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('on');});
  T(id).classList.add('on');
  if(id==='pg-status')renderSt();if(id==='pg-tk')renderTK(tkKF);if(id==='pg-users')loadUsers();
  if(id==='pg-hocba')hbFil();
  if((id==='pg-diem'||id==='pg-hs')&&GAS)syncNow(true);
};

// Phase 2: Override loginOK to update sidebar user
var _origLoginOK=loginOK;
var _newLoginOK=function(){
  _origLoginOK();
  // Update sidebar user
  if(T('sb-uname'))T('sb-uname').textContent=CU.hoten||CU.username;
  if(T('sb-urole'))T('sb-urole').textContent=CU.role==='admin'?'Quản trị viên':'Giáo viên';
  if(T('sb-avatar'))T('sb-avatar').textContent=(CU.hoten||CU.username).charAt(0).toUpperCase();
  if(T('sb-tot'))T('sb-tot').textContent=mySB().length;
  // Tải cấu hình khóa kỳ
  _loadLockConfig();
};
loginOK=_newLoginOK;

// ═══ QUẢN LÝ HỌC SINH: THÊM / XÓA ═══
// ═══════════════════════════════════════════════════════════════
// 2026-05-06 REFACTOR: QLCL không CRUD HS nữa.
//   Lý do: tránh "2 nguồn DSHS song song" (DS HocSinh + HocSinh).
//   Single source of truth: tab "DS HocSinh" của HSS.
//   Việc thêm/sửa/xoá HS chuyển hẳn sang HSS Admin Panel.
//   QLCL chỉ READ-ONLY DSHS để vào điểm + đánh giá.
//
//   Đã bỏ: openAddHS, saveNewHS, deleteHS, openEditHS, saveEditHS, _editHSIdx
//   Stub để code FE cũ không lỗi nếu còn onclick:
function openAddHS(){ toast('ℹ️ Quản lý HS đã chuyển sang Hồ sơ số (Admin)','info'); }
function deleteHS(){ toast('ℹ️ Quản lý HS đã chuyển sang Hồ sơ số (Admin)','info'); }
function openEditHS(){ toast('ℹ️ Quản lý HS đã chuyển sang Hồ sơ số (Admin)','info'); }

// ═══ ĐỔI MẬT KHẨU CÁ NHÂN ═══
function openChangePass(){
  if(!CU){toast('⚠️ Chưa đăng nhập','warn');return;}
  T('chpass-user').textContent=CU.hoten||CU.username;
  T('cp-old').value='';T('cp-new').value='';T('cp-confirm').value='';T('cpErr').textContent='';
  T('chPassBg').classList.add('on');
  setTimeout(function(){T('cp-old').focus();},200);
}
async function doChangePass(){
  var oldPw=T('cp-old').value.trim();
  var newPw=T('cp-new').value.trim();
  var confirm=T('cp-confirm').value.trim();
  T('cpErr').textContent='';
  if(!oldPw){T('cpErr').textContent='⚠️ Vui lòng nhập mật khẩu hiện tại';return;}
  if(!newPw||newPw.length<4){T('cpErr').textContent='⚠️ Mật khẩu mới phải có ít nhất 4 ký tự';return;}
  if(newPw!==confirm){T('cpErr').textContent='⚠️ Mật khẩu mới không khớp';return;}
  if(newPw===oldPw){T('cpErr').textContent='⚠️ Mật khẩu mới phải khác mật khẩu cũ';return;}
  if(!GAS){T('cpErr').textContent='⚠️ Chưa kết nối hệ thống';return;}
  try{
    loader('Đang đổi mật khẩu...');
    var r=await gasPost({action:'changePassword',username:CU.username,oldPassword:oldPw,newPassword:newPw});
    loader();
    if(r.ok){
      cm('chPassBg');
      toast('✅ Đổi mật khẩu thành công!','ok');
    }else{
      T('cpErr').textContent='❌ '+(r.error||'Lỗi không xác định');
    }
  }catch(e){
    loader();
    T('cpErr').textContent='❌ Lỗi kết nối: '+e.message;
  }
}
// Click nền đóng modal
document.addEventListener('DOMContentLoaded',function(){
  var el=T('chPassBg');if(el)el.addEventListener('click',function(e){if(e.target.id==='chPassBg')cm('chPassBg');});
});

// ═══ MOBILE MENU ═══
function toggleMobMenu(){
  var sb=document.querySelector('.sidebar');
  var ov=T('mobOverlay');
  if(sb.classList.contains('mob-open')){closeMobMenu();}
  else{sb.classList.add('mob-open');ov.classList.add('on');document.body.style.overflow='hidden';}
}
function closeMobMenu(){
  var sb=document.querySelector('.sidebar');
  var ov=T('mobOverlay');
  sb.classList.remove('mob-open');ov.classList.remove('on');document.body.style.overflow='';
}
function bnav(pgId,el){
  document.querySelectorAll('.bnav-item').forEach(function(b){b.classList.remove('on');});
  if(el)el.classList.add('on');
  gp(pgId);
}
// Override gp to also close mobile menu and sync bottom nav
var _gpOrig2=gp;
gp=function(id,el){
  closeMobMenu();
  _gpOrig2(id,el);
  // Sync bottom nav
  var map={'pg-hs':0,'pg-diem':1,'pg-tk':2,'pg-hocba':3,'pg-export':4};
  var items=document.querySelectorAll('.bnav-item');
  items.forEach(function(b){b.classList.remove('on');});
  if(map[id]!==undefined&&items[map[id]])items[map[id]].classList.add('on');
};
// Also close sidebar when clicking sidebar items on mobile
document.querySelectorAll('.sb-item').forEach(function(item){
  item.addEventListener('click',function(){if(window.innerWidth<=640)setTimeout(closeMobMenu,100);});
});

// ════════════════════════════════════════════════════════════════════════════
// 2026-05-09 — Phase 1 Hồ sơ số học bạ: Quản lý ảnh chữ ký + dấu trường
// Chỉ HT/PHT/Admin được dùng (sb-item có class "ao", needAdmin gate ở onclick).
// API: getSignatures / getSignatureImage / uploadSignature / deleteSignature.
// ════════════════════════════════════════════════════════════════════════════
async function loadSignatures(){
  var truongEl = document.getElementById('ck-truong');
  var gvcnEl   = document.getElementById('ck-gvcn-list');
  if(!truongEl || !gvcnEl) return;
  var loadingHTML = '<div style="grid-column:1/-1;padding:16px;text-align:center;color:var(--slate3);font-size:13px">⏳ Đang tải…</div>';
  truongEl.innerHTML = loadingHTML;
  gvcnEl.innerHTML   = loadingHTML;
  try{
    var r = await gasPost({action:'getSignatures'});
    if(!r.ok) throw new Error(r.error || 'Tải danh sách chữ ký lỗi');
    _renderSigTruong(r.data);
    _renderSigGVCN(r.data.gvcn || []);
  }catch(e){
    truongEl.innerHTML = '<div style="grid-column:1/-1;padding:14px;text-align:center;color:#dc2626;font-size:13px">⚠ '+e.message+'</div>';
    gvcnEl.innerHTML = '';
  }
}

function _renderSigTruong(data){
  var el = document.getElementById('ck-truong');
  if(!el) return;
  el.innerHTML =
    _sigCardHTML('HT',  '✍️ Chữ ký Hiệu trưởng', data.ht  || {}) +
    _sigCardHTML('DAU', '🔴 Dấu trường',          data.dau || {});
  if(data.ht  && data.ht.fileId)  setTimeout(function(){_loadSigPreview(data.ht.fileId,  'sig-prev-HT');},  50);
  if(data.dau && data.dau.fileId) setTimeout(function(){_loadSigPreview(data.dau.fileId, 'sig-prev-DAU');}, 50);
}

function _sigCardHTML(type, title, info){
  var hasFile = !!info.fileId;
  // HT và DAU: blur mặc định để tránh lộ chữ ký/dấu Hiệu trưởng. Toggle hiện/ẩn bằng nút 👁.
  var btn = hasFile
    ? '<button class="btn bout" onclick="_toggleSigBlur(\''+type+'\')" style="font-size:11px" id="sig-eye-'+type+'" title="Hiện/ẩn ảnh">👁 Hiện</button>'
      +' <button class="btn bout" onclick="pickSignature(\''+type+'\')" style="font-size:11px">🔄 Thay ảnh</button>'
      +' <button class="btn bout" onclick="deleteSignature(\''+type+'\')" style="font-size:11px;color:#dc2626;border-color:#dc2626">🗑 Xoá</button>'
    : '<button class="btn bp" onclick="pickSignature(\''+type+'\')" style="font-size:12px">📤 Tải ảnh lên</button>';
  var preview = hasFile
    ? '<div id="sig-prev-'+type+'" data-blur="1" style="min-height:90px;display:flex;align-items:center;justify-content:center;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:6px;margin-bottom:10px;padding:6px;filter:blur(12px);transition:filter .25s ease"><span style="color:#94a3b8;font-size:11px">⏳ Đang tải ảnh…</span></div>'
    : '<div style="min-height:90px;display:flex;align-items:center;justify-content:center;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:6px;margin-bottom:10px;color:#94a3b8;font-size:12px">Chưa có ảnh</div>';
  return '<div class="ck-card" style="background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.04)">'
    +'<div style="font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:8px">'+title+'</div>'
    +preview
    +'<div style="display:flex;gap:6px;flex-wrap:wrap">'+btn+'</div>'
    +'</div>';
}

function _toggleSigBlur(type){
  var el = document.getElementById('sig-prev-'+type);
  var btn = document.getElementById('sig-eye-'+type);
  if(!el) return;
  var blurred = el.getAttribute('data-blur') === '1';
  if(blurred){
    el.style.filter = 'blur(0)';
    el.setAttribute('data-blur','0');
    if(btn) btn.innerHTML = '🙈 Ẩn';
  } else {
    el.style.filter = 'blur(12px)';
    el.setAttribute('data-blur','1');
    if(btn) btn.innerHTML = '👁 Hiện';
  }
}

function _renderSigGVCN(arr){
  var el = document.getElementById('ck-gvcn-list');
  if(!el) return;
  var gvcn = arr.filter(function(g){return g.lop;});
  if(!gvcn.length){
    el.innerHTML = '<div style="grid-column:1/-1;padding:16px;text-align:center;color:var(--slate3);font-size:13px;background:#f8fafc;border-radius:8px">Chưa có GVCN. Vào <b>Phân quyền CBGV</b> điền cột <b>"Lớp PT"</b> cho từng GV (vd <code>1A</code>) — tài khoản phải có email hoặc họ tên trùng với DSGV.</div>';
    return;
  }
  // Sắp xếp theo lớp 1A, 1B, ... 5C
  gvcn.sort(function(a,b){return String(a.lop).localeCompare(String(b.lop), 'vi');});
  el.innerHTML = gvcn.map(_gvcnCardHTML).join('');
  gvcn.forEach(function(g){
    if(g.fileId) setTimeout(function(){_loadSigPreview(g.fileId, 'sig-prev-gv-'+g.maGV);}, 50);
  });
}

function _gvcnCardHTML(g){
  var hasFile = !!g.fileId;
  var safeNa = (g.hoTen || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  var btn = hasFile
    ? '<button class="btn bout" onclick="pickSignature(\'GVCN\',\''+g.maGV+'\',\''+safeNa+'\')" style="font-size:10.5px;padding:4px 8px">🔄 Thay</button>'
      +' <button class="btn bout" onclick="deleteSignature(\'GVCN\',\''+g.maGV+'\')" style="font-size:10.5px;padding:4px 8px;color:#dc2626;border-color:#dc2626">🗑</button>'
    : '<button class="btn bp" onclick="pickSignature(\'GVCN\',\''+g.maGV+'\',\''+safeNa+'\')" style="font-size:11px;padding:4px 10px">📤 Tải lên</button>';
  var preview = hasFile
    ? '<div id="sig-prev-gv-'+g.maGV+'" style="min-height:60px;display:flex;align-items:center;justify-content:center;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:5px;margin-bottom:8px;padding:4px"><span style="color:#94a3b8;font-size:10px">⏳…</span></div>'
    : '<div style="min-height:60px;display:flex;align-items:center;justify-content:center;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:5px;margin-bottom:8px;color:#94a3b8;font-size:11px">Chưa có ảnh</div>';
  var lopLbl = '<b style="color:var(--blue);font-size:11.5px">Lớp '+g.lop+'</b>';
  return '<div class="ck-card" style="background:#fff;border:1.5px solid #e2e8f0;border-radius:8px;padding:10px 12px">'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">'
      +'<div style="font-size:12.5px;font-weight:700;color:var(--navy);flex:1">'+g.hoTen+'</div>'
      +lopLbl
    +'</div>'
    +'<div style="font-size:10.5px;color:var(--slate3);margin-bottom:8px">MaGV: '+g.maGV+(g.updatedAt?(' · cập nhật: '+g.updatedAt):'')+'</div>'
    +preview
    +'<div style="display:flex;gap:5px;flex-wrap:wrap">'+btn+'</div>'
    +'</div>';
}

async function _loadSigPreview(fileId, slotId){
  var el = document.getElementById(slotId);
  if(!el) return;
  try{
    var r = await gasPost({action:'getSignatureImage', fileId:fileId});
    if(!r.ok) throw new Error(r.error || 'Tải ảnh lỗi');
    var d = r.data;
    el.innerHTML = '<img src="data:'+d.mimeType+';base64,'+d.base64+'" alt="" style="max-width:100%;max-height:120px;object-fit:contain">';
  }catch(e){
    el.innerHTML = '<span style="color:#dc2626;font-size:10.5px">⚠ '+e.message+'</span>';
  }
}

function pickSignature(type, maGV, hoTenGV){
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg';
  inp.onchange = function(){
    var f = inp.files && inp.files[0];
    if(!f) return;
    if(f.size > 300*1024){
      if(!confirm('⚠ File '+(f.size/1024).toFixed(0)+'KB lớn hơn 300KB khuyến nghị.\n\nTiếp tục tải lên?')) return;
    }
    if(f.type !== 'image/png'){
      if(!confirm('⚠ File không phải PNG ('+(f.type||'?')+').\n\nKhuyến nghị PNG nền trong để không tạo hộp trắng đè nội dung học bạ.\n\nVẫn tải lên?')) return;
    }
    _doUploadSig(type, f, maGV, hoTenGV);
  };
  inp.click();
}

async function _doUploadSig(type, file, maGV, hoTenGV){
  loader('Đang tải ảnh chữ ký…');
  try{
    var b64 = await new Promise(function(res, rej){
      var reader = new FileReader();
      reader.onload = function(){
        var s = String(reader.result);
        var i = s.indexOf(',');
        res(i >= 0 ? s.substring(i+1) : s);
      };
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
    var r = await gasPost({
      action:   'uploadSignature',
      type:     type,
      maGV:     maGV || '',
      hoTenGV:  hoTenGV || '',
      base64:   b64,
      mimeType: file.type || 'image/png'
    });
    loader();
    if(!r.ok) throw new Error(r.error || 'Upload lỗi');
    toast('✅ Đã lưu ảnh chữ ký', 'ok');
    loadSignatures();
  }catch(e){
    loader();
    toast('❌ '+e.message, 'err');
  }
}

async function deleteSignature(type, maGV){
  var msg = type === 'GVCN' ? 'Xoá ảnh chữ ký GVCN này?' :
            type === 'HT'   ? 'Xoá ảnh chữ ký Hiệu trưởng?' :
                              'Xoá ảnh dấu trường?';
  if(!confirm(msg + '\n(File trên Drive sẽ vào thùng rác — có thể khôi phục trong 30 ngày)')) return;
  loader('Đang xoá…');
  try{
    var r = await gasPost({action:'deleteSignature', type:type, maGV:maGV || ''});
    loader();
    if(!r.ok) throw new Error(r.error || 'Xoá lỗi');
    toast('✅ Đã xoá', 'ok');
    loadSignatures();
  }catch(e){
    loader();
    toast('❌ '+e.message, 'err');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// END qlcl-app.js — không có adapter remap action vì backend QLCL_V3.0 dùng
// đúng action name template gốc (getGrades, saveGrade, autoSave, ...). Adapter
// đã có ở phiên bản trước nhưng đã removed khi chuyển sang Phương án D-2.
// ════════════════════════════════════════════════════════════════════════════
