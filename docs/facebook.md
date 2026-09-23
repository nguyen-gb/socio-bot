# Facebook groups

## Sử dụng

1. Đăng nhập account Facebook trong **Profiles**, xác nhận `READY`, kiểm tra proxy nếu có và đóng browser.
2. **Facebook → Đồng bộ nhóm**: để trống account để chọn toàn bộ Facebook READY, hoặc chọn một số account. Theo dõi tác vụ đồng bộ trong **Tác vụ**.
3. **Tham gia nhóm**: đặt tên chiến dịch, dán mỗi link nhóm một dòng, chọn account và khoảng cách giữa các tác vụ.
4. **Soạn bài nhóm**: nhập nội dung chữ, chọn tất cả nhóm đã tham gia, tối đa N nhóm cho mỗi account, hoặc **Chọn nhóm đã đồng bộ**. N nhóm được chọn theo thứ tự link từ inventory. Với nhóm chỉ định, tìm theo tên/link/profile và chọn tối đa 100 nhóm từ danh sách của các profile READY được chọn, kể cả nhóm chờ duyệt/chưa xác nhận trạng thái. Nhóm trùng giữa nhiều profile chỉ hiện một lựa chọn. Khi đổi profile, nhóm không còn phù hợp sẽ được bỏ chọn. Chỉ tạo tác vụ cho cặp profile/nhóm có trong inventory của workspace; không suy diễn quyền đăng từ membership. Worker mở khung soạn bài và chỉ gửi khi editor/nút đăng sẵn sàng; không tự tham gia nhóm.
5. Lưu bản nháp → **Duyệt** → kiểm tra account/nhóm và nội dung → **Duyệt & chạy**. Chỉ OWNER/ADMIN được duyệt hoặc hủy.
6. Mở rộng hàng chiến dịch để xem từng kết quả. Hủy chỉ áp dụng tác vụ chưa chạy, không ngắt thao tác Facebook đang chạy.

“Tất cả nhóm” là tất cả nhóm JOINED trong inventory tại thời điểm tạo bản nháp. Đồng bộ trước khi tạo chiến dịch. Đồng bộ đọc tối đa 1.000 nhóm/account, cuộn tối đa 40 lần; `result.complete=false` nghĩa là chưa đọc hết. Facebook tải động hoặc đổi giao diện có thể khiến inventory chưa đầy đủ. Worker kiểm tra quyền soạn bài khi mở nhóm, không suy diễn quyền đăng từ membership.

Không tự đánh dấu rời nhóm chỉ vì một lượt đồng bộ không quan sát thấy nhóm đó. Khi đăng, không cần nút “Joined/Đã tham gia”: có khung soạn bài và nút gửi khả dụng mới là điều kiện thao tác. “Tất cả/N nhóm đã tham gia” vẫn dùng trạng thái inventory để chọn danh sách đích, không phải kiểm tra quyền lúc thực thi.

## Các nhánh tham gia và đăng bài

- Đã tham gia/Member/Rời nhóm: ghi JOINED, không bấm nút rời nhóm.
- Admin/moderator có thể không có nút Joined. Sidebar Admin tools với ít nhất hai đường dẫn công cụ quản trị khác nhau của đúng nhóm đích cũng xác nhận JOINED; không dùng badge Admin trong feed, sidebar ẩn hoặc link của nhóm khác.
- Đã gửi yêu cầu/Cancel request/notice chờ duyệt: ghi PENDING, không hủy hoặc gửi lại yêu cầu; PENDING không có nghĩa đã được duyệt.
- Chưa tham gia, có nút Join/Request to join/Tham gia lại, hoặc Accept invitation: ghi marker gửi bền vững, kiểm tra lại trạng thái, bấm đúng một lần; chờ xác nhận JOINED hoặc PENDING.
- Câu hỏi thành viên, quy tắc cần xác nhận, lựa chọn danh tính hoặc hộp thoại không rõ: REQUIRES_ACTION, không tự trả lời/chấp nhận. Welcome đơn thuần có nút Close có thể được đóng; welcome chứa quy tắc không được đóng tự động.
- Membership hạn chế: ghi nhận JOINED nhưng không suy ra quyền tham gia thảo luận/đăng bài.
- Nút bị khóa, nhiều nút tham gia mâu thuẫn, tín hiệu Joined + Pending, nhóm không khả dụng/tạm dừng/lưu trữ, chuyển sang nhóm/trang khác: dừng an toàn, không gửi yêu cầu không rõ đích.
- Thiếu phiên đăng nhập, form đăng nhập với cookie cũ, CAPTCHA/checkpoint hoặc giới hạn tần suất: dừng để xử lý; không vượt xác minh hay giới hạn.
- Phản hồi sau gửi quá chậm/không xác nhận: UNKNOWN và cần kiểm tra thủ công, không bấm lần hai.
- Đăng bài: bỏ kiểm tra thành viên. Chỉ dùng nút soạn bài thuộc trang nhóm, không dùng nút trong article/feed; chờ editor và submit, kiểm tra nội dung/phiên/nhóm đích trước khi gửi một lần.
- Sau khi nhập, popup Mentions suggestions có thể che nút Đăng. Chỉ đóng gợi ý này bằng Escape, không chọn suggestion; kiểm tra lại nguyên văn nội dung và dùng click trial để kiểm tra khả năng bấm trước khi ghi marker gửi. Không force-click xuyên qua popup; nếu vẫn bị che, dừng trước khi gửi để người dùng kiểm tra.
- Gợi ý bất đồng bộ có thể xuất hiện sau trial trong lúc lưu marker. Bước gửi focus chính nút Post rồi dùng Enter để kích hoạt nút qua bàn phím, không Enter trong editor/gợi ý. Kiểm tra focus, nội dung và trạng thái enabled trước kích hoạt; không retry thao tác gửi nếu kết quả chưa rõ.
- Sau đăng: phân biệt PUBLISHED (article mới xác nhận), PENDING_APPROVAL (Facebook báo bài chờ duyệt) và UNKNOWN. Bài cũ trùng nội dung không được coi là xác nhận bài mới.
- Ưu tiên phản hồi tạo bài phát sinh từ nút Đăng: chỉ nhận mutation khớp đúng nhóm, toàn bộ nội dung và actor của account. Phản hồi phải có story của nhóm đích, permalink, ID bài và nội dung feed tương ứng mới xác nhận PUBLISHED; không dựa vào HTTP 200 hoặc popup đóng. Cách này hỗ trợ feed không có role article. Nếu quan sát thấy request tạo bài nhưng phản hồi lỗi/không rõ, không lấy bài hiển thị tạm trên feed làm bằng chứng thành công; không gửi lại.
- Public group có thể giữ bài của participant đang chờ phê duyệt dù đã là thành viên. Nếu phản hồi có pending-participation composer và thẻ Pending admin approval, kết quả là PENDING_APPROVAL ngay cả khi trả permalink/feed edge; không coi bài chỉ tác giả nhìn thấy là đã công khai.

Các nhánh trên được kiểm thử với Chromium trên trang fixture, chặn toàn bộ truy cập mạng thật. Facebook có thể thay đổi giao diện; trạng thái không nhận diện được luôn dừng an toàn thay vì suy đoán.

## Phiên đăng nhập và dữ liệu profile

Mỗi profile dùng lại `PROFILE_ROOT/<profileId>` cho browser thủ công và task. Chromium mở mới cho từng lượt chạy; worker khôi phục snapshot gần nhất trước khi mở và lưu snapshot mới sau khi đóng.

Cookie phiên (không có thời hạn) được lưu trước khi đóng vào `session-cookies.enc`, mã hóa bằng `PROFILE_ENCRYPTION_KEY`, rồi khôi phục khi mở lại. File nằm trong profile nên được đưa vào snapshot mã hóa cùng dữ liệu Chromium. Không tự kéo dài thời hạn cookie; khi xóa cookie/đăng xuất, bản lưu phiên được cập nhật để không khôi phục cookie cũ.

Snapshot cũ thiếu cookie phiên sẽ dùng cookie đã nhập trong profile để khởi tạo lại. Phiên browser còn hợp lệ được ưu tiên hơn cookie nhập cũ; khi phiên không hợp lệ, thử cookie đã nhập, sau đó username/password nếu có. CAPTCHA/checkpoint dừng để xử lý thủ công.

`READY` chỉ được báo sau khi kiểm tra phiên đang mở, không dựa vào trạng thái READY cũ. Với Facebook, cần cookie đăng nhập, giao diện điều hướng đã tải và không có trang/form đăng nhập hoặc CAPTCHA. Worker kiểm tra lại phiên trước khi thao tác nhóm. Đóng browser thủ công và chờ profile `AVAILABLE` trước khi chạy task.

Sau `domcontentloaded`, adapter chờ vùng nội dung nhóm tối đa 30 giây và các nút membership tối đa 15 giây, rồi kiểm tra lại phiên/CAPTCHA trước khi thao tác. Không coi DOM vừa tải là giao diện Facebook đã sẵn sàng, đặc biệt khi dùng proxy chậm.

Task cũ `REQUIRES_ACTION` không tự chạy lại sau khi sửa phiên. Kiểm tra kết quả/lỗi cũ trước khi tạo chiến dịch mới để tránh gửi trùng.

## Kết quả và chống gửi trùng

- `JOINED`: xác nhận đã tham gia; `PENDING`: yêu cầu chờ duyệt.
- `PUBLISHED`: quan sát bài mới sau thao tác; `PENDING_APPROVAL`: Facebook thông báo bài chờ duyệt.
- `REQUIRES_ACTION`/`UNKNOWN`: cần mở browser thủ công, không coi là thành công và không tự gửi lại.
- Câu hỏi thành viên, xác nhận quy tắc và CAPTCHA không được tự trả lời hoặc vượt qua.
- Account bị giới hạn đánh dấu CHALLENGED; tác vụ tiếp theo dừng trước khi gửi.
- Tham gia/đăng chỉ chạy sau approval. Mỗi tác vụ chỉ một lần gửi. Retry Temporal hoặc lần chạy trước không rõ kết quả được giữ để kiểm tra thủ công.
- Idempotency key chống tạo trùng cùng yêu cầu API. Account/nhóm và nội dung lưu cố định trong Task, không đổi khi inventory đổi.
- Mặc định giãn lịch 60 giây/account, tối thiểu 30 giây. Profile lease không cho hai browser dùng chung profile đồng thời. Account có tác vụ chờ/chạy không được duyệt thêm chiến dịch.
- Worker giới hạn số activity đồng thời theo BROWSER_MAX_SLOTS để chọn nhiều account không làm hàng loạt tác vụ hết thời gian chờ browser slot. Tác vụ chờ profile bận tối đa 10 phút, có heartbeat; task vẫn được kiểm tra lại sau khi lấy lease.
- Tối đa 100 account, 100 link và 500 cặp account/nhóm mỗi chiến dịch. Vượt giới hạn bị từ chối, không cắt bớt âm thầm.
- Hỗ trợ bài chữ và chọn từng nhóm trong inventory; chưa có ảnh/video hoặc tự trả lời câu hỏi thành viên.

## API (workspace-scoped)

| Method | Endpoint | Role |
| --- | --- | --- |
| GET | `/api/facebook/groups` | VIEWER |
| GET | `/api/facebook/campaigns` | VIEWER |
| POST | `/api/facebook/groups/sync` | OPERATOR |
| POST | `/api/facebook/groups/join` | OPERATOR |
| POST | `/api/facebook/groups/post` | OPERATOR |
| POST | `/api/facebook/campaigns/:id/approve` | ADMIN |
| POST | `/api/facebook/campaigns/:id/cancel` | ADMIN |
| POST | `/api/facebook/campaigns/:id/pause` | ADMIN |
| POST | `/api/facebook/campaigns/:id/resume` | ADMIN |
| POST | `/api/facebook/campaigns/:id/retry` | ADMIN |

Sync: `{accountIds: [], idempotencyKey: "unique-key"}`.

Join: `{name, accountIds: [], groupUrls: ["https://www.facebook.com/groups/123/"], intervalSeconds: 60, idempotencyKey}`.

Post: `{name, accountIds: [], text, selection: "ALL" | "LIMIT" | "CUSTOM", limit?: 5, groupUrls?: ["https://www.facebook.com/groups/123/"], intervalSeconds: 60, idempotencyKey}`. `CUSTOM` yêu cầu danh sách nhóm đã lưu cho các profile được chọn; không yêu cầu trạng thái inventory là `JOINED`.

`accountIds: []` chọn toàn bộ Facebook READY thuộc workspace. Link chỉ nhận HTTPS Facebook group root URL, bỏ query/hash, gộp link trùng. Không nhận link bài viết, host ngoài Facebook hoặc URL có credentials.

## Kiểm thử

Browser của mỗi tác vụ và phiên đăng nhập được ghi nhận trong `BrowserSession`, gồm PID. Runtime lưu thêm PID, thời điểm tạo tiến trình, mã phiên và token Chromium tại `<PROFILE_ROOT>/.processes/<profileId>.json` để phục hồi sau khi worker khởi động lại. Chỉ ép tắt khi xác minh đúng tiến trình sở hữu; hỗ trợ Windows và Linux.

Nút **Đóng browser** chuyển sang **Ép đóng browser** khi phiên đang đóng. Worker đọc yêu cầu độc lập với lệnh Playwright; đóng bình thường quá 8 giây sẽ tự ép tắt cây tiến trình. Browser automation cũng xuất hiện trong danh sách phiên để có thể đóng. Tác vụ đang gửi mà bị ép đóng giữ kết quả chưa chắc chắn và cần kiểm tra trước khi chạy lại. Cookie chưa kịp lưu trong lần ép đóng có thể cần đăng nhập lại.

Tác vụ browser có giới hạn 5 phút; chụp ảnh, lưu trace, kiểm tra đăng nhập và đóng phiên đều có timeout. Sau khi bấm tham gia nhóm, worker chờ tối đa 15 giây để nhận trạng thái đã tham gia/chờ duyệt/câu hỏi; không bấm tham gia lần hai khi kết quả chưa rõ. Lỗi tải trang nhóm sau khi xác minh đăng nhập không tự đổi profile thành lỗi đăng nhập.

Test PID/browser treo: `corepack pnpm --filter @socio/browser-runtime test`. Test PostgreSQL + watchdog + Chromium thật tại trang fixture: `corepack pnpm --filter @socio/browser-worker exec tsx scripts/browser-close-smoke.ts`. Test nút đóng/ép đóng: `node scripts/browser-controls-ui-smoke.mjs`. API smoke kiểm tra cờ force-close đi xuyên qua Next đến backend; các test này không thao tác Facebook thật.

Test xuyên suốt activity với PostgreSQL và Chromium, chặn toàn bộ request ra Facebook: `corepack pnpm --filter @socio/browser-worker exec tsx scripts/facebook-task-smoke.ts`. Bao gồm nhóm phản hồi chậm, lỗi điều hướng nhưng giữ profile READY, ép đóng khi điều hướng bị treo và đăng bài không có nút xác nhận membership (kể cả retry delivery không đăng trùng).

### Dừng, tiếp tục và chạy lại

- **Dừng** chuyển các tác vụ chờ sang `PAUSED`. Tác vụ `RUNNING` được kết thúc an toàn; giao diện báo Đang dừng cho tới khi tác vụ đó kết thúc. Không đóng browser cưỡng bức trong lúc gửi bài/yêu cầu.
- **Tiếp tục** chỉ lên lịch lại phần `PAUSED`, giữ nguyên phần đã hoàn thành và giãn lịch theo account. Chờ tác vụ đang chạy kết thúc trước khi tiếp tục.
- **Chạy lại** mở popup chọn từng account/nhóm có tác vụ `FAILED` hoặc `REQUIRES_ACTION`. Không chọn lại phần `SUCCEEDED`. Profile phải READY, browser đóng, proxy HEALTHY và không có tác vụ khác đang chờ/chạy trên cùng profile.
- Profile READY không xóa kết quả lỗi cũ của tác vụ. Giao diện hiển thị trạng thái profile hiện tại riêng với kết quả lần chạy trước.
- Worker ghi `sideEffectStarted` vào TaskRun **trước** khi bấm tham gia/đăng. Tác vụ dừng trước khi gửi có thể chọn chạy lại; đã gửi hoặc chưa có bằng chứng (lịch sử cũ) cần người dùng kiểm tra trên Facebook và xác nhận chưa gửi thành công. Không tự chọn tác vụ không rõ kết quả.
- Retry payload: `{taskIds: ["uuid"], verifiedUnsentTaskIds: []}`. Chỉ điền `verifiedUnsentTaskIds` sau khi đã kiểm tra các tác vụ tương ứng chưa gửi/đăng thành công.
- Mỗi lần tiếp tục/chạy lại có workflow ID mới. Worker bỏ qua workflow cũ cả trước và sau khi lấy lease, lịch sử TaskRun vẫn được giữ. Transaction khóa chiến dịch và profile để chặn click trùng và chiến dịch chạy chồng nhau.
- **Hủy** là vĩnh viễn, hủy cả phần dừng/cần thao tác. Không thể tiếp tục chiến dịch đã hủy; dùng Dừng để tạm ngưng.

Kiểm thử transaction thật (Temporal stub, không mở browser, workspace fixture tự dọn): `corepack pnpm --filter @socio/api exec tsx scripts/facebook-controls-db-smoke.ts`.
Kiểm tra React/Next sau đăng nhập bằng dữ liệu giả lập: `node scripts/next-ui-diagnostic.mjs`.

`corepack pnpm build`, `corepack pnpm typecheck`, `corepack pnpm test`.

Khi hệ thống local đang chạy: `node scripts/facebook-ui-smoke.mjs` (UI/API giả lập) và `node scripts/facebook-api-smoke.mjs` (API/BFF/database thật, account tạm, chỉ tạo/hủy nháp, tự dọn dữ liệu test). API smoke dùng tài khoản dev `owner@socio.local` và `.env`, không chạy approval chiến dịch.

Kiểm tra allowlist của Next cho cả `approve/cancel/pause/resume/retry`: `node scripts/facebook-route-smoke.mjs`. Script không đăng nhập, xác nhận action hợp lệ đến auth guard của backend và action lạ vẫn bị chặn. API smoke phía trên cũng kiểm tra năm route với phiên đăng nhập thật và campaign không tồn tại; không khởi chạy workflow.

Adapter test dùng Chromium thật nhưng chặn toàn bộ request, trả fixture HTML, không kết nối Facebook thật. API test dùng database/Temporal mock. Cần chạy thử trên account/nhóm được phép trước khi chạy chiến dịch thật; Facebook đổi giao diện có thể cần cập nhật selector.
