# Facebook groups

## Sử dụng

1. Đăng nhập account Facebook trong **Profiles**, xác nhận `READY`, kiểm tra proxy nếu có và đóng browser.
2. **Facebook → Đồng bộ nhóm**: chọn **Tất cả profile Facebook sẵn sàng** hoặc **Chọn profile cụ thể** (một/nhiều profile). Khi chọn cụ thể phải chọn ít nhất một profile; danh sách rỗng không tự chuyển thành tất cả. Đồng bộ được tạo dưới dạng bản nháp chiến dịch: duyệt để chạy, hoặc dùng các thao tác dừng, tiếp tục, chạy lại và hủy ngay trong danh sách **Chiến dịch**.
3. **Tham gia nhóm**: đặt tên chiến dịch, dán mỗi link nhóm một dòng, chọn account và khoảng cách giữa các tác vụ.
4. **Tập hợp nhóm**: gom các nhóm đã đồng bộ theo chủ đề như Hải sản, Quần áo, Phong thủy. Một nhóm có thể thuộc nhiều tập hợp; tập hợp dùng chung trong workspace và không nhân bản theo profile. OPERATOR tạo/sửa, ADMIN xóa. Xóa tập hợp không xóa inventory nhóm hoặc chiến dịch cũ.
5. **Soạn bài nhóm**: nhập nội dung chữ, chọn tất cả nhóm đã tham gia, **Chọn theo tập hợp nhóm**, hoặc **Tự chọn từng nhóm đã đồng bộ**. Có thể chọn nhiều tập hợp; URL trùng giữa các tập hợp chỉ được đăng một lần. Tối đa N nhóm cho mỗi account là giới hạn riêng, không phải số nhóm cần chọn. Các nhóm được phân phối tuần tự theo vòng tròn. Với nhóm chỉ định, tìm theo tên/link/profile và chọn tối đa 100 nhóm từ danh sách của các profile READY được chọn, kể cả nhóm chờ duyệt/chưa xác nhận trạng thái. Nhóm trùng giữa nhiều profile chỉ hiện một lựa chọn. Khi đổi profile, nhóm không còn phù hợp sẽ được bỏ chọn. Chỉ tạo tác vụ cho cặp profile/nhóm có trong inventory của workspace; không suy diễn quyền đăng từ membership. Worker mở khung soạn bài và chỉ gửi khi editor/nút đăng sẵn sàng; không tự tham gia nhóm.
6. Với đồng bộ/tham gia/nhắn tin: lưu bản nháp → **Duyệt** → kiểm tra account/nhóm và nội dung → **Duyệt & chạy**. Đăng bài nhóm được lên lịch ngay sau khi tạo, không chờ bước duyệt riêng; vẫn kiểm tra account/nhóm, editor và nút đăng trước khi gửi. Chỉ OWNER/ADMIN được duyệt hoặc hủy các chiến dịch còn cần duyệt.
7. Mở rộng hàng chiến dịch để xem từng kết quả. Hủy chỉ áp dụng tác vụ chưa chạy, không ngắt thao tác Facebook đang chạy.

## Quét số điện thoại trong bình luận bài viết

Chọn **Quét SĐT bình luận**, chọn một hoặc nhiều profile READY và dán URL bài viết Facebook (ví dụ `/groups/<id>/posts/<post-id>` hoặc `/permalink/<post-id>`). Hệ thống tạo một chiến dịch `SCAN_COMMENTS`; sau khi ADMIN duyệt, mỗi profile mở cùng bài viết, chọn **Tất cả bình luận**, tải thêm các bình luận còn lại khi có nút tương ứng, rồi trích xuất số điện thoại Việt Nam, chuẩn hóa về dạng `0xxxxxxxxx` và loại số trùng. Đây là thao tác đọc dữ liệu, không đăng bài hoặc gửi tin nhắn.

Kết quả mỗi profile hiển thị số bình luận đã quét, số điện thoại tìm thấy và danh sách số (nếu có). Nếu bài viết không tải được, profile mất phiên, gặp CAPTCHA hoặc không có vùng nội dung bài viết, tác vụ dừng ở **Cần thao tác** và không tự thử lại.

## Rep bình luận trong bài viết

Chọn **Rep bình luận**, dán URL bài viết, nhập nội dung và **Số lượt rep / bài viết**. Tổng số lượt được chia đều cho các profile đã chọn; ví dụ 2 profile và 10 lượt sẽ tạo 5 lượt cho mỗi profile. Sau khi duyệt, profile mở bài viết, chọn **Tất cả bình luận**, tải thêm bình luận và trả lời các bình luận đang có nút **Reply/Trả lời**. Mỗi lượt phải xác nhận nội dung rep mới xuất hiện; nếu Facebook không xác nhận, tác vụ dừng để tránh gửi trùng.

## Nhắn tin thành viên ngẫu nhiên

Không cần tạo danh sách người nhận. Chọn **Nhắn thành viên ngẫu nhiên** và đặt **Số thành viên cần nhắn / nhóm**. Mặc định, hệ thống dùng tất cả nhóm đã tham gia của các profile được chọn; chỉ chọn nhóm cụ thể khi muốn giới hạn phạm vi. Tổng số này được chia gần đều nhất giữa các profile có trạng thái `JOINED` trong nhóm. Ví dụ, 2 profile và giá trị 10 tạo 10 lượt nhắn, mỗi profile 5 lượt. Tối đa 50 thành viên/nhóm và 200 lượt/chiến dịch.

Khi chạy một lượt, profile mở trang thành viên của nhóm, cuộn ngắn để lấy các profile đang hiển thị, rồi chọn ngẫu nhiên một profile và nhắn. Danh sách này không được lưu thành danh sách người nhận. Nếu không thấy thành viên công khai hoặc không có nút Nhắn tin, tác vụ dừng ở **Cần thao tác** và không tự thử lại. Tin nhắn cùng một profile gửi cách nhau tối thiểu 60 giây.

Đồng bộ/tham gia/nhắn tin bắt đầu ở bản nháp và cần ADMIN duyệt; đăng bài được lên lịch ngay khi tạo. Không tự vượt CAPTCHA, giới hạn tài khoản hoặc trạng thái không có nút Nhắn tin. Nếu đã bấm gửi nhưng chưa xác nhận được kết quả, tác vụ chuyển **Cần thao tác** và không tự thử lại; kiểm tra hội thoại trước khi xác nhận chạy lại.

“Tất cả nhóm” là tất cả nhóm JOINED trong inventory tại thời điểm tạo bản nháp. Đồng bộ trước khi tạo chiến dịch. Đồng bộ đọc trực tiếp trang **Nhóm đã tham gia** (`/groups/joins/`) của từng profile, bao gồm nhóm tham gia thủ công và nhóm ngoài campaign. Không lấy danh sách đích campaign làm giới hạn đồng bộ; nhóm chờ duyệt trong campaign vẫn được giữ, và được cập nhật JOINED khi xuất hiện trong danh sách đã tham gia.

Worker thu thập từng đợt trước khi cuộn, hỗ trợ danh sách cuộn lồng/ảo hóa và nút tải thêm, bỏ nhóm gợi ý và link trong feed/sidebar. Không cắt ở 40 lần cuộn hoặc 1.000 nhóm. Chỉ hoàn tất khi đã đến cuối, không còn tải thêm/loading và danh sách ổn định 8 giây. Mỗi lượt có giới hạn thời gian 4 phút; nếu hết thời gian hoặc bị gián đoạn thì lưu phần đã đọc, báo **Cần thao tác / Chưa đọc hết danh sách**, không báo hoàn tất. Trang báo rõ chưa tham gia nhóm nào cho kết quả 0; trang trắng/chưa tải không bị hiểu là danh sách rỗng. Nhóm thiếu tên vẫn được lưu và UI hiển thị ID; tên đã biết không bị xóa do lần quét mới không đọc được tên. Facebook có thể đổi giao diện hoặc tải thêm rất chậm nên kết quả phản ánh danh sách quan sát được, không phải đảm bảo mọi nhóm trên tài khoản đều đã được Facebook trả về.

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
- Đồng bộ/tham gia/nhắn tin chỉ chạy sau approval; đăng bài được tự động duyệt và lên lịch ngay khi tạo. Mỗi tác vụ chỉ một lần gửi. Retry Temporal hoặc lần chạy trước không rõ kết quả được giữ để kiểm tra thủ công.
- Idempotency key chống tạo trùng cùng yêu cầu API. Account/nhóm và nội dung lưu cố định trong Task, không đổi khi inventory đổi.
- Mặc định giãn lịch 60 giây/account, tối thiểu 30 giây. Profile lease không cho hai browser dùng chung profile đồng thời. Account có tác vụ chờ/chạy không được duyệt thêm chiến dịch.
- Worker giới hạn số activity đồng thời theo BROWSER_MAX_SLOTS để chọn nhiều account không làm hàng loạt tác vụ hết thời gian chờ browser slot. Tác vụ chờ profile bận tối đa 10 phút, có heartbeat; task vẫn được kiểm tra lại sau khi lấy lease.
- Tối đa 100 account, 100 link và 500 cặp account/nhóm mỗi chiến dịch. Vượt giới hạn bị từ chối, không cắt bớt âm thầm.
- Hỗ trợ bài chữ, bài kèm ảnh hoặc chỉ có ảnh, chọn từng nhóm trong inventory; chưa có video hoặc tự trả lời câu hỏi thành viên.

## API (workspace-scoped)

| Method | Endpoint | Role |
| --- | --- | --- |
| GET | `/api/facebook/groups` | VIEWER |
| GET | `/api/facebook/group-collections` | VIEWER |
| POST | `/api/facebook/group-collections` | OPERATOR |
| PATCH | `/api/facebook/group-collections/:id` | OPERATOR |
| DELETE | `/api/facebook/group-collections/:id` | ADMIN |
| GET | `/api/facebook/campaigns` | VIEWER |
| POST | `/api/facebook/groups/sync` | OPERATOR |
| POST | `/api/facebook/groups/join` | OPERATOR |
| POST | `/api/facebook/groups/post` | OPERATOR |
| POST | `/api/facebook/groups/message` | OPERATOR |
| POST | `/api/facebook/posts/scan-comments` | OPERATOR |
| POST | `/api/facebook/posts/reply-comments` | OPERATOR |
| POST | `/api/facebook/campaigns/:id/approve` | ADMIN |
| POST | `/api/facebook/campaigns/:id/cancel` | ADMIN |
| POST | `/api/facebook/campaigns/:id/pause` | ADMIN |
| POST | `/api/facebook/campaigns/:id/resume` | ADMIN |
| POST | `/api/facebook/campaigns/:id/retry` | ADMIN |

Sync: `{scope: "ALL", accountIds: [], idempotencyKey: "unique-key"}` hoặc `{scope: "SELECTED", accountIds: ["profile-account-uuid"], idempotencyKey: "unique-key"}`. API cũ không truyền `scope` vẫn dùng `accountIds: []` để chọn tất cả profile READY.

Join: `{name, accountIds: [], groupUrls: ["https://www.facebook.com/groups/123/"], intervalSeconds: 60, idempotencyKey}`.

Tập hợp: `{name, description, groupUrls: ["https://www.facebook.com/groups/123/"]}`. Tối đa 1.000 nhóm/tập hợp; chỉ nhận nhóm đã đồng bộ trong workspace.

Post: `{name, accountIds: [], text: "", mediaAssetIds: [], selection: "ALL" | "CUSTOM" | "COLLECTIONS", maxGroupsPerAccount: 5, groupUrls?: ["https://www.facebook.com/groups/123/"], collectionIds?: ["uuid"], intervalSeconds: 60, idempotencyKey}`. Phải có nội dung hoặc ít nhất một ảnh. `CUSTOM` yêu cầu danh sách nhóm đã lưu cho các profile được chọn; `COLLECTIONS` yêu cầu 1–50 tập hợp và chụp cố định danh sách URL tại thời điểm tạo chiến dịch. Hai chế độ không yêu cầu trạng thái inventory là `JOINED`, nhưng từng URL phải tồn tại trong inventory của ít nhất một profile được chọn.

Message: `{name, accountIds: [], text, groupUrls, maxRecipientsPerGroup: 10, intervalSeconds: 120, idempotencyKey}`. Mỗi lượt tạo một tác vụ theo profile/nhóm; worker chọn ngẫu nhiên thành viên đang hiển thị khi chạy.

Scan bình luận: `{name, accountIds: [], postUrl: "https://www.facebook.com/groups/123/posts/456", intervalSeconds: 60, idempotencyKey}`. URL chỉ nhận HTTPS Facebook và phải trỏ đến một bài viết hợp lệ; `accountIds: []` chọn tất cả profile Facebook READY.

Rep bình luận: `{name, accountIds: [], postUrl: "https://www.facebook.com/groups/123/posts/456", text: "Cảm ơn bạn", maxReplies: 10, intervalSeconds: 120, idempotencyKey}`. `maxReplies` là tổng số lượt rep cho bài viết, tối đa 50 và được chia đều theo profile.

## Ảnh đính kèm

Trong **Soạn bài nhóm → Ảnh đính kèm**, chọn ảnh từ thư viện hoặc tải nhiều ảnh từ máy. Bấm ảnh để xem lớn, bấm dấu × dưới ảnh để bỏ khỏi bài. Ảnh đã tải vẫn nằm trong thư viện để tái sử dụng. Tối đa 10 ảnh/bài, 10 MB/ảnh, định dạng JPG, PNG hoặc WebP; có thể để trống nội dung nếu có ảnh. Khi tải lỗi một file, các ảnh đã tải thành công được giữ lại; tải lại những ảnh còn thiếu.

Ảnh xuất hiện trong phần mở rộng chiến dịch và cửa sổ duyệt. Danh sách ID ảnh được lưu cố định trong từng tác vụ, giữ nguyên khi tạm dừng/tiếp tục/chạy lại. API kiểm tra ảnh thuộc workspace và READY; worker đọc từ object storage dùng chung (S3/MinIO khi deploy), kiểm tra loại file, kích thước và checksum, giữ nguyên thứ tự đã chọn. Không dùng đường dẫn file trên máy người dùng trong Chromium trên VPS.

Worker tải ảnh qua trường chọn file của khung soạn Facebook, chờ đủ ảnh xem trước, hết trạng thái upload và nút Đăng sẵn sàng. Thiếu ảnh hoặc lỗi tải ảnh dừng trước khi gửi. Với bài ảnh, xác nhận kết quả dựa trên yêu cầu tạo bài quan sát được từ thao tác UI, khớp account, nhóm, nội dung và số ảnh. Không dùng bài cùng nội dung trong feed để tự kết luận thành công. Nếu kết quả chưa rõ, giữ trạng thái cần thao tác để tránh đăng trùng.

`GET /api/media/:id/content` phục vụ xem ảnh có xác thực và giới hạn workspace; không công khai URL S3. Không cần migration dữ liệu. Khi cập nhật VPS cần rebuild cả `api`, `browser-worker`, `web`.

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

Kiểm tra UI tạo/sửa/xóa tập hợp và dùng tập hợp khi đăng bài (API/Facebook giả lập): `node scripts/facebook-collections-ui-smoke.mjs`.

Kiểm tra UI nhắn thành viên ngẫu nhiên, giới hạn mỗi nhóm và tạo bản nháp (API/Facebook giả lập): `node scripts/facebook-messages-ui-smoke.mjs`. Adapter Chromium fixture kiểm tra marker bền vững được ghi trước thao tác Gửi và không gửi khi marker lỗi.

`corepack pnpm build`, `corepack pnpm typecheck`, `corepack pnpm test`.

Khi hệ thống local đang chạy: `node scripts/facebook-ui-smoke.mjs` (UI/API giả lập) và `node scripts/facebook-api-smoke.mjs` (API/BFF/database thật, account tạm, chỉ tạo/hủy nháp, tự dọn dữ liệu test). API smoke dùng tài khoản dev `owner@socio.local` và `.env`, không chạy approval chiến dịch.

Kiểm tra allowlist của Next cho CRUD tập hợp nhóm, message draft và `approve/cancel/pause/resume/retry`: `node scripts/facebook-route-smoke.mjs`. Script không đăng nhập, xác nhận action hợp lệ đến auth guard của backend và action lạ vẫn bị chặn. API smoke phía trên cũng kiểm tra năm route với phiên đăng nhập thật và campaign không tồn tại; không khởi chạy workflow.

Adapter test dùng Chromium thật nhưng chặn toàn bộ request, trả fixture HTML, không kết nối Facebook thật. API test dùng database/Temporal mock. Cần chạy thử trên account/nhóm được phép trước khi chạy chiến dịch thật; Facebook đổi giao diện có thể cần cập nhật selector.
