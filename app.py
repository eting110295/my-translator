import os
import logging
from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_socketio import SocketIO
from dotenv import load_dotenv
import requests

# 載入環境變數
load_dotenv()

# 初始化 Flask 與 SocketIO (支援即時串流)
app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# 設定日誌
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 從環境變數讀取金鑰，如果不存在，則後續會拋出錯誤或要求前端提供
API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")

# 引入核心的 Gemini Translation Provider
import providers

# 定義翻譯與語音模型名稱（可依需求調整）
TRANSLATE_MODEL = "gemini-3.1-flash-lite"
TTS_MODEL = "gemini-3.1-flash-tts-preview"

# 載入額外環境變數 (天氣 API，供即時對話測試用，免金鑰)
OPENWEATHER_API_KEY = os.getenv('OPENWEATHER_API_KEY')


# ===== 1. 主畫面路由 =====
@app.route('/')
def index():
    return render_template('index.html')


# ===== 2. 系統健康檢查 API =====
@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"ok": True, "model": TRANSLATE_MODEL, "tts_model": TTS_MODEL})


# ===== 3. 單向翻譯 API =====
@app.route('/api/translate', methods=['POST'])
def api_translate():
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({"ok": False, "error": "no text"}), 400

    # 封裝傳遞給 providers 的參數
    data['api_key'] = (data.get('api_key') or '').strip() or API_KEY
    data['model'] = TRANSLATE_MODEL

    result = providers.translate(data)
    return jsonify(result), (200 if result.get('ok') else 400)


# ===== TTS API =====
@app.route('/api/tts', methods=['POST'])
def api_tts():
    from flask import Response
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get('text') or '').strip()
    if not text:
        return ('', 204)
    key = (data.get('gemini_key') or '').strip() or API_KEY   # 選填覆蓋，留空用伺服器內建
    if not key:
        return jsonify({'error': 'no gemini key'}), 400

    from google.genai import types
    client = genai.Client(api_key=key)
    cfg = types.GenerateContentConfig(
        response_modalities=['AUDIO'],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name='Kore')
            )
        ),
    )
    # 預覽版 TTS 模型偶爾會「吐文字而非音訊」導致 400 → 重試最多 3 次
    last_err = 'unknown'
    for _attempt in range(3):
        try:
            resp = client.models.generate_content(model=TTS_MODEL, contents=text, config=cfg)
            for part in resp.candidates[0].content.parts:
                inline = getattr(part, 'inline_data', None)
                if inline is not None and inline.data:
                    return Response(inline.data, mimetype='application/octet-stream')  # 24kHz 16-bit PCM
                last_err = 'model returned text instead of audio'
        except Exception as e:
            last_err = str(e)
    app.logger.error(f"TTS failed after retries: {last_err}")
    return jsonify({'error': last_err}), 400


# =========================================================
# Gemini Live 即時雙向對話 (Websocket 伺服器代理端)
# =========================================================
import json
from google import genai
from google.genai import types

class GeminiSession:
    """維護單一 WebSocket 連線的 Gemini Live 雙向音訊會話"""
    def __init__(self, sid, instructions, api_key=None):
        self.sid = sid
        # 初始化 Gemini API 使用者代理客戶端 (使用 2.0 原生 Live WebSocket 協定，指定 v1alpha 版本)
        self.client = genai.Client(api_key=(api_key or API_KEY), http_options={'api_version': 'v1alpha'})
        self.instructions = instructions
        self.live_session = None
        self.active = False
        
    def start(self):
        self.active = True
        # 啟動背景執行緒，與 Gemini 伺服器建立 WebSocket 連線
        socketio.start_background_task(self._run)
        
    def _run(self):
        # 語音模型：主用 gemini-2.0-flash-exp (原生 Live API)
        model_id = "gemini-2.0-flash-exp"
        
        # 設定為同時產出「文字與語音」的雙向模態
        config = types.LiveConnectConfig(
            response_modalities=[types.LiveModality.TEXT, types.LiveModality.AUDIO],
            system_instruction=types.Content(parts=[types.Part.from_text(text=self.instructions)]),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
                )
            )
        )
        
        logger.info(f"[{self.sid}] Connecting to Gemini Live API...")
        try:
            # 建立 Live 會話
            with self.client.aio.live_connect(model=model_id, config=config) as session:
                self.live_session = session
                logger.info(f"[{self.sid}] Connected to Gemini Live API.")
                
                # 啟動背景接收執行緒
                socketio.start_background_task(self._recv_loop)
                
                # 保持主連線執行緒運行，直至 session 被關閉
                while self.active and not session.closed:
                    socketio.sleep(0.5)
        except Exception as e:
            logger.error(f"[{self.sid}] Gemini Live error: {e}")
            socketio.emit('error', {'msg': f"Gemini 連線錯誤: {str(e)}"}, to=self.sid)
        finally:
            self.close()

    def _recv_loop(self):
        """背景迴圈：持續接收來自 Gemini 伺服器的串流回覆，並轉發給前端"""
        logger.info(f"[{self.sid}] Starting Gemini Live receive loop.")
        try:
            # 當 session 存在且活躍時持續接收
            while self.active and self.live_session and not self.live_session.closed:
                # 接收下一包 Gemini 的回應
                response = self.live_session.receive()
                if not response:
                    socketio.sleep(0.01)
                    continue
                
                # 1. 處理文字回覆
                if response.text:
                    socketio.emit('text_response', {'text': response.text}, to=self.sid)
                
                # 2. 處理原生 24kHz PCM 音訊回覆
                if response.audio:
                    socketio.emit('audio_response', response.audio, to=self.sid)
                    
                # 3. 處理 Gemini 回話完成標記 (Turn Complete)
                if response.turn_complete:
                    socketio.emit('turn_complete', {}, to=self.sid)
                    
        except Exception as e:
            logger.error(f"[{self.sid}] Receive loop error: {e}")
        finally:
            logger.info(f"[{self.sid}] Gemini Live receive loop ended.")
            self.close()

    def send_audio(self, pcm_bytes):
        """接收來自前端傳入的瀏覽器麥克風音訊片段 (16kHz PCM)，轉發給 Gemini 伺服器"""
        if self.active and self.live_session and not self.live_session.closed:
            try:
                # 將 16kHz PCM 音訊打包送給 Gemini (模型會自動進行下採樣/上採樣處理)
                self.live_session.send(
                    input={"data": pcm_bytes, "mime_type": "audio/pcm;rate=16000"},
                    end_of_turn=False
                )
            except Exception as e:
                logger.error(f"[{self.sid}] Send audio failed: {e}")
                self.close()

    def close(self):
        """安全關閉會話，通知前端並釋放資源"""
        if not self.active:
            return
        self.active = False
        logger.info(f"[{self.sid}] Closing session...")
        if self.live_session:
            try:
                self.live_session.close()
            except Exception:
                pass
            self.live_session = None
        socketio.emit('session_ended', {}, to=self.sid)
        if self.sid in active_sessions:
            del active_sessions[self.sid]


# 保存全域活動會話清單
active_sessions = {}

@socketio.on('connect')
def handle_connect():
    logger.info(f"Socket connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Socket disconnected: {request.sid}")
    # 斷線時自動釋放會話資源
    if request.sid in active_sessions:
        active_sessions[request.sid].close()

@socketio.on('start_session')
def handle_start_session(data):
    """前端點擊「開始說話」並開啟即時對話時觸發"""
    sid = request.sid
    lang_a = data.get('langA', 'Traditional Chinese')
    lang_b = data.get('langB', 'English')
    user_key = (data.get('gemini_key') or '').strip()
    
    # 產生引導 Gemini Live 語音模型的系統指令，使其扮演精準的雙向翻譯官
    instruction = (
        f"You are a real-time face-to-face interpreter between {lang_a} and {lang_b}.\n"
        f"The user speaking to you might speak either {lang_a} or {lang_b}.\n"
        f"Your task:\n"
        f"1. If the speaker speaks {lang_a}, translate it to {lang_b} immediately.\n"
        f"2. If the speaker speaks {lang_b}, translate it to {lang_a} immediately.\n"
        f"3. Respond with ONLY the translated text and its audio. Do NOT add any preamble, explanation, or chat.\n"
        f"4. Be concise and natural, optimized for spoken conversation.\n"
        f"5. Keep the translation faithful and grammatically correct."
    )
    
    # 如果已存在舊會話，先將其關閉
    if sid in active_sessions:
        active_sessions[sid].close()
        
    # 建立並啟動新會話
    session = GeminiSession(sid, instruction, api_key=user_key)
    active_sessions[sid] = session
    session.start()
    logger.info(f"[{sid}] Live session started.")

@socketio.on('stop_session')
def handle_stop_session():
    """前端點擊「停止說話」關閉串流時觸發"""
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].close()
        logger.info(f"[{sid}] Live session stopped by client request.")

@socketio.on('audio_in')
def handle_audio_in(data):
    """持續接收前端傳入的二進位麥克風 PCM 串流分片"""
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].send_audio(data)


# ===== 5. 拍照 / 檔案輔助函式 =====
def _provider_cfg(data):
    """從前端請求中抽取 API 供應商、Model、金鑰設定"""
    src = data.get('provider_config') or {}
    return {
        'provider': src.get('provider') or 'gemini',
        'api_key': src.get('api_key') or '',
        'model': src.get('model') or '',
        'base_url': src.get('base_url') or ''
    }

def _run_analyze(pc, target, file_bytes=None, mime_type=None):
    """執行 providers.analyze 邏輯。"""
    try:
        note = None
        if pc['provider'] == 'openai':
            if not pc['api_key']:
                return {"ok": False, "error": "OpenAI API key not provided"}, 400
            result = providers.analyze('openai', pc['api_key'], pc['model'], target,
                                       file_bytes=file_bytes, mime_type=mime_type)
        else:
            # 預設使用 Gemini 供應商
            key = (pc['api_key'] if pc['provider'] == 'gemini' else '') or API_KEY
            if not key:
                return {"ok": False, "error": "Gemini API key not configured on server"}, 400
            model = pc['model'] or TRANSLATE_MODEL
            if model != TRANSLATE_MODEL:
                note = f"正在使用自訂模型 {model}"
            result = providers.analyze('gemini', key, model, target,
                                       file_bytes=file_bytes, mime_type=mime_type)
    except Exception as e:
        logger.error(f"analyze error: {e}")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}, 400

    out = {"ok": True, **result}
    if note:
        out["note"] = note
    return out, 200


@app.route('/api/vision', methods=['POST'])
def api_vision():
    """相機拍照 → 摘要 + 翻譯。前端傳 base64 影像（可含 dataURL 前綴）+ 供應商設定。"""
    import base64 as _b64
    data = request.get_json(force=True, silent=True) or {}
    image_b64 = data.get('image') or ''
    target = data.get('target') or 'Traditional Chinese (Taiwan)'
    if not image_b64:
        return jsonify({"ok": False, "error": "no image"}), 400

    mime = 'image/jpeg'
    if image_b64.startswith('data:'):
        try:
            header, image_b64 = image_b64.split(',', 1)
            mime = header.split(':', 1)[1].split(';', 1)[0] or mime
        except Exception:
            pass
    try:
        raw = _b64.b64decode(image_b64)
    except Exception:
        return jsonify({"ok": False, "error": "影像解碼失敗"}), 400

    pc = _provider_cfg(data)
    result, status = _run_analyze(pc, target, file_bytes=raw, mime_type=mime)
    return jsonify(result), status


# ===== 6. 匯率 API =====
# 匯率換算：免金鑰。主用 open.er-api.com（含 TWD 等多幣別），備援 frankfurter.app（歐洲央行）
@app.route('/api/currency', methods=['POST'])
def api_currency():
    data = request.get_json(force=True, silent=True) or {}
    base = (data.get('base') or 'USD').upper()
    target = (data.get('target') or 'TWD').upper()
    try:
        amount = float(data.get('amount', 1) or 1)
    except (TypeError, ValueError):
        amount = 1.0

    if base == target:
        return jsonify({"ok": True, "base": base, "target": target, "amount": amount,
                        "rate": 1.0, "result": amount, "date": "", "source": "same"})

    # 主：open.er-api.com（免金鑰，幣別多，含 TWD）
    try:
        r = requests.get(f"https://open.er-api.com/v6/latest/{base}", timeout=8)
        r.raise_for_status()
        d = r.json()
        rate = (d.get("rates") or {}).get(target)
        if rate:
            return jsonify({"ok": True, "base": base, "target": target, "amount": amount,
                            "rate": rate, "result": amount * rate,
                            "date": d.get("time_last_update_utc", ""), "source": "er-api"})
    except Exception as e:
        logger.warning(f"currency er-api failed: {e}")

    # 備援：frankfurter.app（歐洲央行，無 TWD 等部分亞幣）
    try:
        r = requests.get("https://api.frankfurter.app/latest",
                         params={"from": base, "to": target}, timeout=8)
        r.raise_for_status()
        d = r.json()
        rate = (d.get("rates") or {}).get(target)
        if rate:
            return jsonify({"ok": True, "base": base, "target": target, "amount": amount,
                            "rate": rate, "result": amount * rate,
                            "date": d.get("date", ""), "source": "frankfurter"})
    except Exception as e:
        logger.warning(f"currency frankfurter failed: {e}")

    return jsonify({"ok": False, "error": f"查不到 {base}→{target} 匯率（請確認幣別代碼）"}), 400


# ===== 6b. 股價 API =====
@app.route('/api/stock', methods=['POST'])
def api_stock():
    data = request.get_json(force=True, silent=True) or {}
    symbol = (data.get('symbol') or 'AAPL').strip().upper()
    if not symbol:
        return jsonify({"ok": False, "error": "請輸入股價代號"}), 400
    
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    try:
        r = requests.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        res = r.json()
        result = res.get('chart', {}).get('result')
        if not result:
            return jsonify({"ok": False, "error": f"找不到股價代號 {symbol}（例如：台股 2330.TW，美股 AAPL）"}), 400
            
        meta = result[0].get('meta', {})
        price = meta.get('regularMarketPrice')
        currency = meta.get('currency', 'USD')
        prev_close = meta.get('chartPreviousClose')
        
        if price is None:
            return jsonify({"ok": False, "error": f"無法取得 {symbol} 當前價格"}), 400
            
        if prev_close is None:
            prev_close = price
            
        change = price - prev_close
        pct = (change / prev_close) * 100 if prev_close else 0.0
        
        return jsonify({
            "ok": True,
            "symbol": symbol,
            "price": round(price, 4),
            "currency": currency,
            "change": round(change, 4),
            "percent": round(pct, 2)
        })
    except Exception as e:
        logger.error(f"stock query failed for {symbol}: {e}")
        return jsonify({"ok": False, "error": f"查詢失敗：請檢查代號是否正確（美股如 AAPL，台股如 2330.TW）"}), 400


# ===== 7. 天氣 API =====
WMO_CODES = {
    0: "晴天 ☀️", 1: "大致晴朗 🌤️", 2: "部分多雲 ⛅", 3: "陰天 ☁️",
    45: "有霧 🌫️", 48: "凍霧 🌫️",
    51: "毛毛雨 🌦️", 53: "毛毛雨 🌦️", 55: "毛毛雨 🌦️",
    56: "凍雨 🌧️", 57: "凍雨 🌧️",
    61: "小雨 🌧️", 63: "中雨 🌧️", 65: "大雨 🌧️",
    66: "凍雨 🌧️", 67: "凍雨 🌧️",
    71: "小雪 🌨️", 73: "中雪 🌨️", 75: "大雪 🌨️", 77: "雪珠 🌨️",
    80: "陣雨 🌦️", 81: "陣雨 🌧️", 82: "強陣雨 ⛈️",
    85: "陣雪 🌨️", 86: "強陣雪 🌨️",
    95: "雷陣雨 ⛈️", 96: "雷雨伴冰雹 ⛈️", 99: "強雷雨冰雹 ⛈️",
}

COMMON_PLACES = {
    "台北": (25.033, 121.565, "台北，台灣"), "臺北": (25.033, 121.565, "台北，台灣"),
    "台中": (24.147, 120.673, "台中，台灣"), "台南": (22.999, 120.227, "台南，台灣"),
    "高雄": (22.627, 120.301, "高雄，台灣"), "花蓮": (23.991, 121.601, "花蓮，台灣"),
    "台東": (22.758, 121.144, "台東，台灣"), "墾丁": (21.947, 120.798, "墾丁，台灣"),
    "東京": (35.690, 139.692, "東京，日本"), "大阪": (34.694, 135.502, "大阪，日本"),
    "京都": (35.011, 135.768, "京都，日本"), "名古屋": (35.182, 136.906, "名古屋，日本"),
    "福岡": (33.590, 130.402, "福岡，日本"), "札幌": (43.062, 141.354, "札幌，日本"),
    "北海道": (43.062, 141.354, "北海道，日本"), "沖繩": (26.212, 127.681, "沖繩，日本"),
    "那霸": (26.212, 127.681, "那霸，日本"), "首爾": (37.567, 126.978, "首爾，韓國"),
    "釜山": (35.180, 129.075, "釜山，韓國"), "曼谷": (13.756, 100.502, "曼谷，泰國"),
    "清邁": (18.788, 98.985, "清邁，泰國"), "普吉島": (7.880, 98.392, "普吉島，泰國"),
    "新加坡": (1.352, 103.820, "新加坡"), "香港": (22.320, 114.170, "香港"),
    "澳門": (22.199, 113.544, "澳門"), "吉隆坡": (3.139, 101.687, "吉隆坡，馬來西亞"),
    "峇里島": (-8.409, 115.189, "峇里島，印尼"), "峴港": (16.055, 108.202, "峴港，越南"),
    "胡志明市": (10.823, 106.630, "胡志明市，越南"), "河內": (21.028, 105.834, "河內，越南"),
    "上海": (31.230, 121.474, "上海，中國"), "北京": (39.904, 116.407, "北京，中國"),
}

def _geocode(place):
    key = place.strip()
    if key in COMMON_PLACES:
        lat, lon, name = COMMON_PLACES[key]
        return lat, lon, name
    try:
        r = requests.get("https://nominatim.openstreetmap.org/search",
                         params={"q": place, "format": "json", "limit": 1, "accept-language": "zh-TW"},
                         headers={"User-Agent": "liang-translator/1.0 (travel weather)"}, timeout=10)
        d = r.json()
        if d:
            item = d[0]
            disp = item.get("display_name", place).split(",")
            name = disp[0].strip() + (("，" + disp[-1].strip()) if len(disp) > 1 else "")
            return float(item["lat"]), float(item["lon"]), name
    except Exception as e:
        logger.warning(f"nominatim failed: {e}")
    try:
        g = requests.get("https://geocoding-api.open-meteo.com/v1/search",
                         params={"name": place, "count": 1, "language": "zh"}, timeout=8).json()
        results = g.get("results") or []
        if results:
            loc = results[0]
            name = loc.get("name", place) + (("，" + loc["country"]) if loc.get("country") else "")
            return loc["latitude"], loc["longitude"], name
    except Exception as e:
        logger.warning(f"open-meteo geocode failed: {e}")
    return None

def _weather_advice(code, temp, pop):
    tips = []
    rainy = code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99) or (pop is not None and pop >= 50)
    if rainy:
        tips.append("☂️ 建議帶傘")
    if temp is not None:
        if temp >= 30:
            tips.append("🧴 高溫，注意防曬補水")
        elif temp <= 12:
            tips.append("🧥 偏冷，記得保暖")
    if not tips:
        tips.append("👍 天氣舒適，玩得開心")
    return "，".join(tips)

@app.route('/api/weather', methods=['POST'])
def api_weather():
    data = request.get_json(force=True, silent=True) or {}
    place = (data.get('place') or '').strip()
    lat = data.get('lat')
    lon = data.get('lon')
    name = place or "目前位置"
    try:
        if place:
            geo = _geocode(place)
            if not geo:
                return jsonify({"ok": False, "error": f"找不到地點「{place}」"}), 400
            lat, lon, name = geo
        if lat is None or lon is None:
            return jsonify({"ok": False, "error": "缺少地點或座標"}), 400

        owm_key = (data.get('owm_key') or '').strip()
        if owm_key:
            o = requests.get("https://api.openweathermap.org/data/2.5/weather", params={
                "lat": lat, "lon": lon, "appid": owm_key, "units": "metric", "lang": "zh_tw",
            }, timeout=8).json()
            if str(o.get("cod")) == "200":
                main = o.get("main") or {}
                wid = ((o.get("weather") or [{}])[0]).get("id", 800)
                desc = ((o.get("weather") or [{}])[0]).get("description", "—")
                raining = wid < 700
                temp = main.get("temp")
                return jsonify({
                    "ok": True, "place": name, "temp": temp,
                    "feels": main.get("feels_like"), "humidity": main.get("humidity"),
                    "desc": desc, "pop": None,
                    "hi": main.get("temp_max"), "lo": main.get("temp_min"),
                    "advice": _weather_advice(61 if raining else 0, temp, None),
                    "source": "owm",
                })

        w = requests.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": lat, "longitude": lon,
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,precipitation",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "timezone": "auto", "forecast_days": 1,
        }, timeout=8).json()
        cur = w.get("current") or {}
        daily = w.get("daily") or {}
        code = cur.get("weather_code")
        temp = cur.get("temperature_2m")
        pop = (daily.get("precipitation_probability_max") or [None])[0]
        hi = (daily.get("temperature_2m_max") or [None])[0]
        lo = (daily.get("temperature_2m_min") or [None])[0]
        return jsonify({
            "ok": True, "place": name,
            "temp": temp, "feels": cur.get("apparent_temperature"),
            "humidity": cur.get("relative_humidity_2m"),
            "desc": WMO_CODES.get(code, "—"),
            "pop": pop, "hi": hi, "lo": lo,
            "advice": _weather_advice(code, temp, pop),
        })
    except Exception as e:
        logger.error(f"weather error: {e}")
        return jsonify({"ok": False, "error": f"天氣查詢失敗：{type(e).__name__}"}), 400


# ===== 8. 旅遊助手 API =====
def _tavily_search(key, query, max_results=5):
    r = requests.post("https://api.tavily.com/search", json={
        "api_key": key, "query": query, "max_results": max_results,
        "include_answer": True, "search_depth": "basic",
    }, timeout=20)
    r.raise_for_status()
    return r.json()


@app.route('/api/ask', methods=['POST'])
def api_ask():
    data = request.get_json(force=True, silent=True) or {}
    question = (data.get('question') or '').strip()
    if not question:
        return jsonify({"ok": False, "error": "請輸入問題"}), 400
    target = data.get('target') or 'Traditional Chinese (Taiwan)'
    pc = _provider_cfg(data)
    tavily_key = (data.get('tavily_key') or os.getenv('TAVILY_API_KEY') or '').strip()

    # 1) 有 Tavily 金鑰才上網查；失敗或額度爆掉就略過，改用 AI 自身知識
    context, sources, searched, search_note = "", [], False, ""
    if tavily_key:
        try:
            d = _tavily_search(tavily_key, question)
            results = d.get("results") or []
            if d.get("answer"):
                context += f"Web summary: {d['answer']}\n"
            for it in results:
                context += f"- {it.get('title','')}: {it.get('content','')}\n"
                sources.append({"title": it.get("title", ""), "url": it.get("url", "")})
            searched = bool(results or d.get("answer"))
        except Exception as e:
            logger.warning(f"tavily failed: {e}")
            search_note = "（即時搜尋暫時無法使用，改用 AI 既有知識回答）"

    # 2) 交給 LLM 回答（走設定 of 供應商）
    system = (
        "You are a helpful, concise travel assistant. "
        f"Answer the user's question in {target}. "
        "If web search context is provided, prefer those up-to-date facts and be specific; "
        "otherwise answer from your own knowledge and flag uncertainty for time-sensitive details. "
        "Use short paragraphs or bullet points when helpful."
    )
    user = question if not context else f"Question: {question}\n\nWeb search context:\n{context}"
    try:
        if pc['provider'] == 'openai':
            if not pc['api_key']:
                return jsonify({"ok": False, "error": "OpenAI 相容供應商需要 API Key（請到設定填入）"}), 400
            answer = providers.generate('openai', pc['api_key'], pc['model'], pc['base_url'], system, user)
        else:
            key = pc['api_key'] or API_KEY
            if not key:
                return jsonify({"ok": False, "error": "找不到 Gemini API Key"}), 400
            answer = providers.generate('gemini', key, pc['model'], '', system, user)
    except requests.HTTPError as e:
        body = ''
        try:
            body = e.response.text[:300]
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"HTTP {e.response.status_code if e.response else '?'}: {body}"}), 400
    except Exception as e:
        logger.error(f"ask error: {e}")
        return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"}), 400

    return jsonify({"ok": True, "answer": (answer or "") + (("\n\n" + search_note) if search_note else ""),
                    "sources": sources, "searched": searched})


# ===== 9. PWA 與路由 =====
@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json', mimetype='application/manifest+json')


@app.route('/sw.js')
def service_worker():
    resp = send_from_directory('static', 'sw.js', mimetype='application/javascript')
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp


if __name__ == '__main__':
    debug_mode = os.getenv('FLASK_DEBUG', 'True').lower() in ('1', 'true', 'yes')
    socketio.run(
        app,
        host='0.0.0.0',
        port=int(os.getenv('PORT', 5000)),
        debug=debug_mode,
    )
