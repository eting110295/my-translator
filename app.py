import os
import logging
from flask import Flask, request, jsonify, render_template
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


# ===== 4. 天氣查詢 API (備用測試，免金鑰) =====
@app.route('/api/weather', methods=['POST'])
def api_weather():
    if not OPENWEATHER_API_KEY:
        return jsonify({"ok": False, "error": "Weather API key not set"}), 500
    
    data = request.get_json(force=True, silent=True) or {}
    lat = data.get('lat')
    lon = data.get('lon')
    if not lat or not lon:
        return jsonify({"ok": False, "error": "Missing coordinates"}), 400
        
    try:
        url = "https://api.openweathermap.org/data/2.5/weather"
        r = requests.get(url, params={
            'lat': lat,
            'lon': lon,
            'appid': OPENWEATHER_API_KEY,
            'units': 'metric',
            'lang': 'zh_tw'
        }, timeout=5)
        r.raise_for_status()
        return jsonify({"ok": True, "data": r.json()})
    except Exception as e:
        logger.error(f"Weather error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


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


if __name__ == '__main__':
    debug_mode = os.getenv('FLASK_DEBUG', 'True').lower() in ('1', 'true', 'yes')
    socketio.run(
        app,
        host='0.0.0.0',
        port=int(os.getenv('PORT', 5000)),
        debug=debug_mode,
    )
