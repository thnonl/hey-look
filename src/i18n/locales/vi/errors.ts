import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
  "errors.pgp.locked": "Khóa mã hóa của bạn đang bị khóa. Hãy mở khóa rồi thử lại.",
  "errors.pgp.missingKeys": "Không có khóa công khai cho {list}.",
  "errors.signIn": "Đăng nhập không thành công. Hãy kiểm tra mật khẩu (Gmail, iCloud và Yahoo cần mật khẩu ứng dụng) hoặc đăng nhập lại.",
  "errors.noCredentials": "Không tìm thấy thông tin đăng nhập đã lưu của tài khoản này. Hãy gỡ bỏ tài khoản rồi thêm lại.",
  "errors.timeout": "Máy chủ thư không phản hồi. Hãy kiểm tra kết nối rồi thử lại.",
  "errors.sendRefused": "Máy chủ thư không nhận thư. Hãy thử lại sau giây lát; nếu vẫn lỗi, hãy kiểm tra mục Thư đi (SMTP) của máy chủ trong Cài đặt. (Chi tiết: {detail})",
  "errors.unreachable": "Không thể kết nối tới máy chủ thư. Hãy kiểm tra tên máy chủ và kết nối của bạn.",
  "errors.certificate": "Chứng chỉ bảo mật của máy chủ bị từ chối. Với máy chủ dùng chứng chỉ tự ký hoặc CA riêng, hãy gỡ bỏ tài khoản rồi thêm lại và bật “Tin cậy chứng chỉ của máy chủ này”.",

  "errors.toast.failed": "Không thành công: {error}",
  "errors.toast.accountFallback": "Tài khoản",
  "errors.toast.withAccount": "{account}: {error}",
  "errors.toast.accountAdded": "Đã thêm tài khoản {email}",
  "errors.toast.accountAddedCal": "Đã thêm tài khoản {email} kèm đồng bộ lịch",
  "errors.toast.loadedOlder": { one: "Đã tải {n} thư cũ hơn", other: "Đã tải {n} thư cũ hơn" },
  "errors.toast.noOlder": "Không còn thư cũ hơn trong thư mục này",
  "errors.limit": "Đã đạt giới hạn tải xuống ({n} thư mỗi hộp thư). Hãy tăng giới hạn trong Cài đặt > Hộp thư > Đọc thư & đồng bộ.",

  "errors.ask.unsentTitle": "Bạn có một thư chưa gửi",
  "errors.ask.unsentBody": "Mở thư khác sẽ đóng thư bạn đang soạn.",
  "errors.ask.keepWriting": "Tiếp tục soạn",
  "errors.ask.saveContinue": "Lưu thư nháp và tiếp tục",
  "errors.ask.discard": "Loại bỏ",

  "errors.provider.gmail.hint": "Cần mật khẩu ứng dụng Google (đã bật Xác minh 2 bước).",
  "errors.provider.outlook.hint": "Nên dùng tab Microsoft (OAuth). Đăng nhập bằng mật khẩu chỉ hoạt động khi bật xác thực cơ bản; tài khoản cá nhân khi đó cần mật khẩu ứng dụng.",
  "errors.provider.icloud.hint": "Apple không có OAuth cho ứng dụng thư. Hãy tạo mật khẩu riêng cho ứng dụng tại account.apple.com (Đăng nhập và Bảo mật) rồi dùng ở đây, với địa chỉ iCloud đầy đủ làm email.",
  "errors.provider.yahoo.hint": "Hãy dùng mật khẩu ứng dụng Yahoo.",
  "errors.provider.bridge.hint": "Hãy chạy Proton Mail Bridge, rồi dùng tên người dùng và mật khẩu của Bridge (không phải mật khẩu Proton). Bridge dùng chứng chỉ tự ký trên máy tính này nên chứng chỉ được tin cậy.",
  "errors.provider.custom.label": "Khác (IMAP/SMTP)",

  "errors.os.credStore.macos": "Chuỗi khóa macOS của bạn",
  "errors.os.credStore.linux": "kho khóa hệ thống của bạn",
  "errors.os.credStore.windows": "Trình quản lý thông tin xác thực của Windows",
  "errors.os.risky.macos": ".app, .pkg, .command, .sh, .scpt, tệp Office có macro (.docm, .xlsm) và các loại tương tự",
  "errors.os.risky.linux": ".sh, .desktop, .AppImage, .run, .deb, tệp Office có macro (.docm, .xlsm) và các loại tương tự",
  "errors.os.risky.windows": ".exe, .bat, .cmd, .ps1, .js, .vbs, .msi, tệp Office có macro (.docm, .xlsm) và các loại tương tự",
});
