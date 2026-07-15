# 我的翻譯器

一個簡單的翻譯網頁應用，使用本地 Flask 後端代理 LibreTranslate 的翻譯請求。

## 安裝

1. 在此資料夾中開啟終端機。
2. 安裝相依套件：

```bash
python -m pip install -r requirements.txt
```

## 啟動

```bash
python app.py
```

應用程式將在 `http://127.0.0.1:5000` 啟動。

## 檔案

- `index.html` — 前端介面
- `styles.css` — 頁面樣式
- `app.js` — 瀏覽器翻譯邏輯
- `app.py` — Flask 後端
- `requirements.txt` — Python 套件清單

## 注意

- 後端會將翻譯請求轉發至 `https://libretranslate.de`。
- 若外部 API 無法使用，程式會退回內建的語言列表。
- 若要啟用天氣功能，請在 `.env` 中加入 `OPENWEATHER_API_KEY`。

## 天氣功能

後端新增了 `GET /weather?city={city}`，可以查詢指定城市的當前天氣。

例如：

```bash
http://127.0.0.1:5000/weather?city=Taipei
```

目前前端也已新增「天氣查詢」表單，輸入城市名稱後可顯示溫度、體感、濕度與風速。
