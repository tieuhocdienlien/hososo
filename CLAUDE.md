# Dự án HSS Sync — TH Diễn Liên

## Tổng quan
Hệ thống đồng bộ dữ liệu từ QLCL (schoolrecords.github.io/tieuhocdienlien/qlcl.html)
lên CSDL ngành MOET (truong.csdl.moet.gov.vn) hoàn toàn tự động qua Chrome Extension.

## Cấu trúc thư mục
- qlcl.html / qlcl-app.js / qlcl-style.css  → Hệ thống QLCL (GitHub Pages)
- hss-sync-extension/                        → Chrome Extension (cầu nối)
  - manifest.json    → Khai báo extension
  - background.js    → Service worker: tạo Excel + điều phối upload
  - content.js       → Inject vào CSDL ngành: set form + upload file
  - content.css      → Style panel floating
  - popup.html/js    → Cài đặt (URL Apps Script)
  - lib/xlsx.min.js  → SheetJS (tạo Excel trong extension)
- APPS_SCRIPT_ENDPOINT.gs → Code thêm vào Google Apps Script

## API Apps Script
URL khai báo trong qlcl.html: `var API_URL = 'https://script.google.com/macros/s/...'`
Các action hiện có: getGrades, saveGrade, getHocSinh, ...
Action cần thêm: `getKetQuaMOET` (trả dữ liệu đúng format xuất MOET)

## Luồng Phương án C (TỰ ĐỘNG HOÀN TOÀN)
1. User login CSDL ngành thủ công (1 lần, vì CAPTCHA)
2. User mở QLCL → click "Đồng bộ CSDL ngành" → chọn Khối + Kỳ
3. QLCL gửi message → Extension background
4. Background fetch Apps Script → lấy dữ liệu học sinh + điểm
5. Background tạo file Excel MOET format (SheetJS, không download)
6. Background tìm tab CSDL ngành → gửi file cho content script
7. Content script: set Khối/Kỳ dropdown → inject file → click Tải lên
8. Content script báo kết quả → Background → QLCL hiển thị thành công

## Cấu trúc Excel MOET (35 cột, 3 hàng header)
File mẫu: FlieMau-KQHT-C1-CN-Khoi12-TT27_2020.xls
- Row 1: STT | Mã lớp | Mã HS | Họ tên | Ngày sinh | [Môn học F:R] | [Năng lực S:Z] | [PC AA:AE] | HT CT | Lên lớp | XL
- Row 2: tên môn (Toán span 2, TV span 2, còn lại 1 cột mỗi môn)
- Row 3: Mức đạt được | Điểm KTĐK | Mức đạt được | Điểm KTĐK | [Mức đạt × 9] | [NL chi tiết]

## Mapping QLCL key → Cột Excel MOET
| Cột | Index | Key QLCL | Ghi chú |
|-----|-------|----------|---------|
| F | 5 | mon_Toán | T/H/C (giữ X nếu có) |
| G | 6 | diem_Toán | số 1-10 |
| H | 7 | mon_Tiếng_việt | |
| I | 8 | diem_Tiếng_việt | |
| J | 9 | mon_Đạo_đức | |
| K | 10 | mon_Tự_nhiên_và_xã_hội | |
| L | 11 | mon_Ngoại_ngữ | |
| M | 12 | mon_Tiếng_dân_tộc | |
| N | 13 | mon_TH-CN_Tin_học | |
| O | 14 | mon_Nghệ_thuật_Âm_nhạc | |
| P | 15 | mon_Nghệ_thuật_Mĩ_thuật | |
| Q | 16 | mon_Hoạt_động_trải_nghiệm | |
| R | 17 | mon_Giáo_dục_thể_chất | |
| S | 18 | nl_Tự_chủ_và_tự_học | T/Đ/C (KHÁC môn học: Đ thay H) |
| T | 19 | nl_Giao_tiếp_và_hợp_tác | |
| U | 20 | nl_Giải_quyết_vấn_đề_và_sáng_tạo | |
| V | 21 | nl_Ngôn_ngữ | |
| W | 22 | nl_Tính_toán | |
| X | 23 | nl_Khoa_học | |
| Y | 24 | nl_Thẩm_mĩ | |
| Z | 25 | nl_Thể_chất | |
| AA | 26 | pc_Yêu_nước | |
| AB | 27 | pc_Nhân_ái | |
| AC | 28 | pc_Chăm_chỉ | |
| AD | 29 | pc_Trung_thực | |
| AE | 30 | pc_Trách_nhiệm | |
| AF | 31 | hoanThanh | "x" hoặc "" |
| AG | 32 | lenLop | "x" hoặc "" |
| AH | 33 | xepLoai | HTXS/HTT/HT/CHT |
| AI | 34 | (trống) | |

## Quy tắc quan trọng
- KHÔNG ghi "Phòng GD&ĐT" — Việt Nam đã bỏ cấp huyện (2 cấp: tỉnh-xã)
- Dùng "Sở GD&ĐT Nghệ An" hoặc tên trường trực tiếp
- Môn học: T = Hoàn thành tốt, H = Hoàn thành, C = Chưa hoàn thành
- Năng lực/Phẩm chất: T = Tốt, Đ = Đạt, C = Cần cố gắng
- Xếp loại: HTXS, HTT, HT, CHT
- Mã học sinh MOET (cột C) bắt buộc nếu có; nếu không có để trống

## Extension ID
Sau khi cài: lấy từ chrome://extensions/ → điền vào `HSS_EXT_ID` trong `qlcl-app.js`.
