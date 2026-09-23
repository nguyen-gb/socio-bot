# Giao diện Socio Workspace

## Hướng thiết kế

Giao diện quản trị sáng, nền trắng/xám ấm và màu nhấn xanh dịu. Tập trung vào phân cấp, khoảng cách và thao tác thực tế; không thêm biểu đồ hay trạng thái kết nối giả.

Nguồn tham khảo: [Linear UI](https://linear.app/changelog/2024-03-20-new-linear-ui), [Atlassian spacing](https://atlassian.design/foundations/spacing), [Ant Design](https://ant.design/docs/spec/overview/).

- Sidebar chia Quản trị và Tự động hóa; icon SVG cùng nét, action ngắn có tooltip và tên truy cập bằng bàn phím.
- URL hash giữ khu vực đang xem khi reload, Back/Forward và quay về từ browser.
- Profiles có tìm kiếm và lọc trạng thái. Popup hiển thị đồng thời cookie, username và password; sửa dữ liệu đã lưu trực tiếp.
- Proxy hiển thị địa chỉ, trạng thái, xác thực và các profile được gán. Cột dài được giới hạn trong bảng.
- Facebook tách Chiến dịch và Nhóm, có tiến độ thật và hướng dẫn khi cần thao tác. Mọi chiến dịch phải được duyệt trước khi chạy.
- Tạo lịch trong popup, xóa có xác nhận. Lỗi lưu giữ popup mở và không làm mất dữ liệu đã nhập.
- Thư viện vẫn cho tải media; giải thích rõ chiến dịch nhóm hiện hỗ trợ bài chữ, chưa hỗ trợ đăng trực tiếp lên trang cá nhân.
- Trình duyệt kết thúc không hiển thị spinner vô hạn. Các điều khiển bị tắt khi hết phiên.
- Mobile dùng điều hướng gọn, popup có vùng cuộn riêng và footer cố định trong popup. Bảng cuộn ngang nội bộ, không tràn toàn trang.
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
