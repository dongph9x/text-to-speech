## Discord TTS Bot

Bot Discord đọc văn bản vào voice channel với slash command `/tts`.

### Yêu cầu
- Node.js 18+
- Quyền tạo ứng dụng Discord và thêm bot vào server

### Cài đặt
1. Cài dependencies:
```bash
npm install
```
2. Tạo file `.env` từ mẫu:
```bash
cp .env.example .env
```
3. Điền các biến môi trường trong `.env`:
- `DISCORD_TOKEN`: Bot token
- `DISCORD_CLIENT_ID`: Application (client) ID
- `GUILD_ID` (tùy chọn): ID server để đăng ký lệnh nhanh khi dev
 - Thiết lập Google Cloud TTS bằng một trong hai cách:
   - `GOOGLE_APPLICATION_CREDENTIALS` = đường dẫn tuyệt đối đến file service account JSON
   - hoặc `GOOGLE_TTS_KEY_JSON` = nội dung JSON key (một dòng)

### Đăng ký slash command
```bash
npm run register
```

Nếu có `GUILD_ID`, lệnh sẽ xuất hiện gần như ngay lập tức. Nếu không, lệnh global có thể mất vài phút.

### Chạy bot
```bash
npm start
```

### Sử dụng
- Vào một voice channel
- Gõ lệnh:
```
/tts text:"Xin chào mọi người" lang:"vi-VN" rate:1 pitch:0 voice:"vi-VN-Wavenet-A"
```
- `lang` mặc định `vi-VN`; có thể chọn voice cụ thể như `vi-VN-Wavenet-A`
- `rate` (0.25-4.0), `pitch` (-20 đến 20) là tùy chọn

### Ghi chú
- Bot tự thoát sau khi đọc xong để giải phóng kết nối.
- Văn bản dài sẽ được chia nhỏ và phát lần lượt.
- Cần quyền Connect/Speak cho bot trong voice channel.


