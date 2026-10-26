import { defineLocale } from "../../types.ts";
import type ns from "../../ns/signin.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who signs in sees Google's warning page, and Google may refuse the sign-in.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.

export default defineLocale<typeof ns.en>({
  "signin.waiting.mail": "Hãy hoàn tất trong trình duyệt của bạn.",
  "signin.google.hint": "Nếu Google hiện cảnh báo “Google hasn’t verified this app”, hãy chọn Advanced (Nâng cao), rồi Go to Hey Look! (unsafe) (Đi tới Hey Look! (không an toàn)). Hey Look! đang chờ Google xem xét.",
  "signin.google.learn": "Điều này nghĩa là gì?",
  "signin.end.timeout": "Đăng nhập {provider} đã hết thời gian chờ.",
  "signin.end.cancelled": "Đã hủy đăng nhập {provider}.",
  "signin.end.denied": "Chưa hoàn tất đăng nhập {provider}.",
  "signin.end.generic": "Đăng nhập {provider} chưa hoàn tất.",
  "signin.end.google.mail": "Có thể Google đã chặn lần đăng nhập này. Bạn có thể thêm tài khoản Gmail bằng mật khẩu ứng dụng.",
  "signin.end.google.calendar": "Có thể Google đã chặn lần đăng nhập này. Thư của bạn không bị ảnh hưởng.",
  "signin.end.microsoft": "Nếu tài khoản này do tổ chức của bạn quản lý, tổ chức có thể cần phê duyệt Hey Look! trước. Hãy liên hệ quản trị viên CNTT.",
  "signin.end.microsoft.blocked": "Tổ chức của bạn có thể cần phê duyệt Hey Look! thì tài khoản này mới đăng nhập được. Hãy liên hệ quản trị viên CNTT rồi thử lại.",
  "signin.end.appPassword": "Thêm Gmail bằng mật khẩu ứng dụng",
  "signin.again.text": "Phiên đăng nhập {provider} cho {email} đã kết thúc. Hãy đăng nhập lại để tiếp tục nhận thư. Thư của bạn vẫn nằm trên máy tính này.",
  "signin.again.blocked": "Tổ chức của bạn có thể cần phê duyệt Hey Look! cho {email}. Hãy liên hệ quản trị viên CNTT rồi thử lại.",
  "signin.again.button": "Đăng nhập lại",
  "signin.again.short": "Phiên đăng nhập {provider} đã kết thúc.",
  "signin.again.blockedShort": "Hey Look! có thể cần được tổ chức của bạn phê duyệt.",
  "signin.again.done": "Đã đăng nhập lại bằng {email}",
});
