# Desktop fingerprint: thiết bị giả được lưu theo profile

Cập nhật 2026-10-30. Tài liệu này thay thế thiết kế auto dùng toàn bộ nhận dạng native trước đó.

## Kết quả

Desktop bundle bật (`mode: auto`) sinh thiết bị giả bằng Apify Fingerprint Suite 2.1.89, lưu trong `fingerprint-emulation.json`, tái sử dụng khi mở lại. Không đồng nghĩa với tắt giả lập.

Hai mẫu Google qua BrowserRuntime trả HTTP 200, 8 tiêu đề kết quả hiển thị, `fingerprintApplied: true` sau khi đọc thuộc tính trong page world của Google:

| Mẫu | Cấu hình | Thiết bị website nhìn thấy | Báo cáo |
|---|---|---|---|
| 2026-10-29T14:45:06Z | Headed, locale native | CPU 8 luồng, RAM khai báo 16 GB, 1920×1080, RTX 3060 | `.local/google-search-smoke/run-RNyMts/report.json` |
| 2026-10-30T00:52:18Z | Headless, vi-VN | CPU 8 luồng, RAM khai báo 4 GB, 1280×720, Intel Iris Xe | `.local/google-search-smoke/run-cqfOgA/report.json` |
| 2026-11-02T13:39:57Z | Headless, vi-VN, safety adapter schema 2 | CPU 6 luồng, RAM khai báo 32 GB, 1920×1080, RTX 3070 Laptop | `.local/google-search-smoke/run-yijSAl/report.json` |

Mỗi mẫu dùng profile riêng, mạng trực tiếp, một truy vấn `playwright documentation`, không retry. Chưa thử proxy/profile đang bị chặn của người dùng. Thành công ở hai mẫu không chứng minh Google luôn coi browser là thiết bị bình thường hoặc không bao giờ challenge.

## Nghiên cứu và lựa chọn

| Nguồn | Quyết định |
|---|---|
| [Apify Fingerprint Suite](https://github.com/apify/fingerprint-suite) | Generator sinh các thuộc tính có tương quan; chọn làm nền cho runtime TypeScript |
| [Injector source](https://github.com/apify/fingerprint-suite/blob/master/packages/fingerprint-injector/src/fingerprint-injector.ts) | Dùng `getInjectableScript()`, tránh helper tự đặt dark theme; không chồng bộ patch Canvas/GPU cũ lên injector |
| [Playwright emulation](https://playwright.dev/docs/emulation) | UA, viewport, screen, DPR, locale được đặt ở context từ cùng bundle để CSS/layout khớp JS |
| [Patchright Node](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) | Tài liệu khuyến nghị native làm baseline. Yêu cầu thiết bị giả cần adapter/test riêng, không chuyển thành tắt giả lập |
| [BrowserForge](https://github.com/daijro/browserforge#injecting-fingerprints) | Injector cũ deprecated; không chọn làm dependency mới |
| [Camoufox](https://github.com/daijro/camoufox#how-it-fits-together) | Sửa Firefox ở C++; không phải thư viện cắm vào Chrome. Đổi engine cần đánh giá lại CDP/screencast/session |

Không coi tuyên bố tránh phát hiện của các dự án là bảo đảm. [Google](https://support.google.com/websearch/answer/86640) nêu unusual traffic cũng có thể liên quan mạng dùng chung hoặc VPN.

## Cơ chế mới

`packages/browser-runtime/src/desktop-fingerprint.ts`:

1. Sinh Chrome desktop cùng OS worker, `strict: true`, screen trong khoảng 1280–2560 × 720–1600. Dataset Chrome từ 120 là nguồn mẫu phần cứng, không phải phiên bản engine đang chạy.
2. Lưu toàn bộ bundle dưới `desktop`, kèm `schema: 2`, `provider: apify-2.1.89` và coverage manifest. Không resample phần cứng mỗi lần mở. Schema 1 được nâng tại chỗ, giữ CPU/RAM/screen/GPU cũ. Truyền bản sao languages vì generator có thể đổi thứ tự mảng đầu vào.
3. Chuẩn hóa UA/appVersion/Client Hints theo Chrome cài đặt. Windows đọc `VersionInfo.ProductVersion`; `chrome.exe --version` trước đây có thể rơi vào fallback 155 dù máy đang cài 156. So sánh major với `Browser.getVersion` khi mở; lệch thì báo lỗi.
4. Chuẩn hóa screen/viewport/DPR/window/document từ cùng mẫu. Chỉ gửi header nhận dạng, không phát lại các header phụ thuộc request như Accept và Sec-Fetch của dataset.
5. Headers có từ lúc launch; CDP cài UA metadata. Locale configured theo lựa chọn; native đọc ngôn ngữ browser trước injection và lưu effective bundle.
6. Script được đăng ký ở context trước script website. Patchright 1.64.1 public `addInitScript` cài route injection, nên adapter dùng `_channel.addInitScript` bên dưới để đăng ký document-start script, giữ HTML/CSP. Đây là API nội bộ: dependency được pin; nâng Patchright phải chạy lại test browser.
7. Safety adapter giữ các override Apify hỗ trợ thực sự, nhưng bỏ hai hành vi khác Chrome: `history.length` ngẫu nhiên mỗi lần dựng script và việc luôn ẩn `SharedArrayBuffer`. History do browser quản lý; trang cross-origin isolated tiếp tục thấy `SharedArrayBuffer` như Chrome gốc.
8. Giữ registration trong lifetime context. Auto không cài `route.fetch/fulfill`, không bật bypassCSP. Tab mới có CDP setup riêng; lỗi setup đóng tab. Không chặn request để đợi CDP vì có thể deadlock navigation tab mới.

`fingerprint-emulation.ts` chịu trách nhiệm load/merge/migration và chọn auto/custom/native. UI đã sửa mô tả Desktop bundle.

## Phạm vi và giới hạn

| Bề mặt | Auto hiện tại |
|---|---|
| CPU/RAM navigator, screen/window, DPR, touch | Thiết bị sinh; kiểm tra trên Chrome |
| UA/appVersion/UA-CH/header nhận dạng | Bundle đồng bộ phiên bản Chrome thực; metadata CDP |
| WebGL vendor/renderer | Theo thiết bị sinh và injector |
| Locale/languages/timezone | Theo mode; header và navigator cùng ngôn ngữ |
| Cookie/storage | Giữ profile và trạng thái riêng |
| Canvas, WebGPU capabilities, shader output, fonts vật lý | Chưa mô phỏng toàn bộ; không thêm noise Canvas hoặc adapter WebGPU giả chắp vá |
| Worker/SharedWorker/ServiceWorker/OffscreenCanvas | Chưa kiểm chứng đồng nhất toàn bộ với page |

Renderer WebGL giả không biến GPU thật thành GPU đó: limits/extensions/rendering/WebGPU vẫn có thể khác. Injector không cài font vật lý từ danh sách font trong bundle. Không dùng kết quả Google để che các giới hạn này. Mô phỏng đầy đủ cần kiểm soát browser/engine/VM, không chỉ JS.

Low-entropy headers có từ lúc launch; high-entropy CDP metadata ở tab mới được cài bất đồng bộ. Chưa chứng minh mọi popup/OOPIF/worker request đầu đều không có race. Test iframe xác minh JS ở script đầu, không chứng nhận mọi header của mọi target.

## Migration và vận hành

- Sidecar cũ thiếu mode đọc như auto; thiếu desktop thì sinh/lưu một lần. Desktop schema 1 nâng lên schema 2 mà không đổi thiết bị. Giữ seed, cookies và profile directory.
- Nâng Chrome cập nhật version, không tự đổi phần cứng. Schema/provider không hỗ trợ hoặc OS không khớp worker bị từ chối thay vì âm thầm đổi thiết bị.
- Native chỉ dùng khi người dùng tắt Desktop bundle. Custom giữ đường cũ để tương thích, không phải đường auto mới.
- Bảng locale/timezone cũ vẫn còn; tách timezone độc lập trên UI là cải tiến tiếp theo, vì ngôn ngữ không xác định duy nhất vị trí.
- Đóng browser rồi restart worker theo cách triển khai hiện có để nhận code mới. Lần làm việc này không restart dịch vụ đang chạy.

```ts
await runtime.openProfile({
  profileId: 'search-device', channel: 'chrome', headless: false,
  emulateFingerprint: true,
  fingerprint: {
    mode: 'auto', localeMode: 'configured',
    locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh',
  },
});
```

## Kiểm chứng

- Build browser-runtime qua; suite runtime/slot-pool 23/23 qua, gồm test schema và safety surfaces.
- Kiểm tra page-world, HTTP headers, CSS width, script đầu website, tab mới, iframe khác origin, đóng/mở profile, CSP, redirect, codecs, battery, UA high-entropy hints, history native và SharedArrayBuffer cross-origin-isolated qua.
- Sau chỉnh locale native và validation cuối, nhóm fingerprint liên quan chạy lại 8/8 qua.
- Typecheck web/browser-worker qua. Chưa chạy toàn bộ monorepo.
- `node scripts/google-search-smoke.cjs`: headed/native locale.
- `node scripts/google-search-smoke.cjs --headless --configured-locale`: headless/vi-VN.
- Script lưu report/ảnh trong `.local/google-search-smoke/`, trả exit code lỗi nếu không có kết quả hoặc không áp đúng fingerprint.
- Cài dependency gặp tsc.exe bị dev watcher khóa. Đã khôi phục thư viện từ đúng package 7.0.2 và liên kết package fingerprint đã tải, cập nhật manifest/lockfile; giữ nguyên watcher. Build/typecheck sau đó qua.

Không có CAPTCHA solver, retry vô hạn, quay vòng proxy hoặc thay identity sau challenge. Chưa xác minh độ ổn định dài hạn hoặc profile/proxy hiện hữu.
