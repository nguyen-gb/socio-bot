# Giao diện Socio Workspace

## Hướng thiết kế

Giao diện quản trị sáng, nền trắng/xám ấm và màu nhấn xanh dịu. Tập trung vào phân cấp, khoảng cách và thao tác thực tế; không thêm biểu đồ hay trạng thái kết nối giả.

Nguồn tham khảo: [Linear UI](https://linear.app/changelog/2024-03-20-new-linear-ui), [Atlassian spacing](https://atlassian.design/foundations/spacing), [Ant Design](https://ant.design/docs/spec/overview/).

- Sidebar chia Quản trị và Tự động hóa; icon SVG cùng nét, action ngắn có tooltip và tên truy cập bằng bàn phím.
- URL hash giữ khu vực đang xem khi reload, Back/Forward và quay về từ browser.
- Profiles có tìm kiếm và lọc trạng thái. Popup hiển thị đồng thời cookie, username và password; sửa dữ liệu đã lưu trực tiếp.
- Proxy hiển thị địa chỉ, trạng thái, xác thực và các profile được gán. Cột dài được giới hạn trong bảng.
- Facebook tách Chiến dịch và Nhóm, có tiến độ thật và hướng dẫn khi cần thao tác. Đồng bộ/tham gia/nhắn tin cần duyệt trước khi chạy; đăng bài được lên lịch ngay sau khi tạo.
- Tạo lịch trong popup, xóa có xác nhận. Lỗi lưu giữ popup mở và không làm mất dữ liệu đã nhập.
- Media được tải lên và chọn ngay trong luồng soạn chiến dịch; giải thích rõ chiến dịch nhóm hiện hỗ trợ bài chữ, chưa hỗ trợ đăng trực tiếp lên trang cá nhân.
- Trình duyệt kết thúc không hiển thị spinner vô hạn. Các điều khiển bị tắt khi hết phiên.
- Mobile dùng điều hướng gọn, popup có vùng cuộn riêng và footer cố định trong popup. Bảng cuộn ngang nội bộ, không tràn toàn trang.
- Bảng campaign Facebook và TikTok dùng cùng thứ tự cột, nhịp hiển thị và nhóm thao tác; mặc định hiển thị 20 dòng với lựa chọn 10/20/50/100.
- Dashboard ưu tiên chỉ số vận hành; onboarding đã hoàn tất được thu gọn thành một dòng trạng thái. Tác vụ dùng bộ lọc theo trạng thái/loại/profile/thời gian và drawer để xem đầy đủ log, lỗi, campaign và tài khoản.
- Proxy tách trạng thái kết nối khỏi chất lượng đường truyền; độ trễ được hiển thị theo ms/giây và cảnh báo khi chậm. Campaign không có task hiển thị “Chưa có tác vụ”, không giả lập kết quả 0/0.
- StyleRegistry dùng cùng phiên bản `@ant-design/cssinjs` với Ant Design để đưa style đầu tiên vào HTML, theo [hướng dẫn SSR](https://ant.design/docs/react/use-with-next/).

## Kiểm thử

Chạy frontend tại cổng 3000, sau đó:

```powershell
corepack pnpm --filter @socio/web typecheck
corepack pnpm --filter @socio/web build
node scripts/dashboard-ui-smoke.mjs
node scripts/facebook-ui-smoke.mjs
```

Hai bài kiểm thử giao diện chặn toàn bộ `/api/**` và dùng fixture. Không tạo/sửa profile thật, không mở browser Facebook thật, không gửi yêu cầu tham gia nhóm hoặc đăng bài thật. Có thể đổi frontend đích qua `UI_TEST_URL`.

Ảnh kiểm tra nằm trong `.local/screenshots/` (không đưa vào Git). Bài quản trị kiểm tra 7 khu vực ở 768/390/360px, create/edit, credential prefill, xác nhận xóa, bộ lọc, lỗi API, quyền VIEWER, trạng thái browser kết thúc và đăng nhập. Bài Facebook kiểm tra bản nháp, duyệt, account chỉ định và số nhóm/account.
