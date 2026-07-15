from flask import Flask, jsonify, request, render_template
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv
import os
import requests
import providers
import mimetypes
from google import genai
import queue
import threading
import asyncio
import logging

# 強制映射 MIME 類型，修復 Windows 註冊表關聯造成的 CSS/JS 無法加載問題
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')

load_dotenv()
app = Flask(__name__, 
            template_folder='templates',
            static_folder='static',
            static_url_path='/static')

# 初始化 SocketIO 與 Gemini Live 設定
socketio = SocketIO(app, cors_allowed_origins="*")
active_sessions = {}
LIVE_MODEL = "gemini-2.0-flash-exp"

# 設定日誌
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

LIBRETRANSLATE_API = os.getenv('LIBRETRANSLATE_API', 'https://libretranslate.de')
OPENWEATHER_API_KEY = os.getenv('OPENWEATHER_API_KEY')
API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
TTS_MODEL = "gemini-3.1-flash-tts-preview"

fallback_languages = [
    {'code': 'en', 'name': 'English'},
    {'code': 'zh', 'name': 'Chinese'},
    {'code': 'ja', 'name': 'Japanese'},
    {'code': 'es', 'name': 'Spanish'},
    {'code': 'fr', 'name': 'French'},
    {'code': 'de', 'name': 'German'},
    {'code': 'ko', 'name': 'Korean'},
    {'code': 'pt', 'name': 'Portuguese'},
]


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/languages')
def languages():
    try:
        response = requests.get(f'{LIBRETRANSLATE_API}/languages', timeout=10)
        response.raise_for_status()
        return jsonify(response.json())
    except requests.RequestException:
        return jsonify(fallback_languages)


@app.route('/api/health')
def health():
    return jsonify({'ok': True})


# ===== 翻譯 API =====
@app.route('/api/translate', methods=['POST'])
def api_translate():
    data = request.get_json(force=True, silent=True) or {}
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


@app.route('/weather')
def weather():
    city = request.args.get('city', '').strip()
    if not city:
        return jsonify({'error': 'City query is required.'}), 400

    if not OPENWEATHER_API_KEY:
        return jsonify({'error': 'OpenWeather API key is not configured.'}), 500

    try:
        response = requests.get(
            'https://api.openweathermap.org/data/2.5/weather',
            params={
                'q': city,
                'appid': OPENWEATHER_API_KEY,
                'units': 'metric',
                'lang': 'zh_tw',
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()

        result = {
            'city': f"{data.get('name')}, {data.get('sys', {}).get('country')}",
            'description': data.get('weather', [{}])[0].get('description', ''),
            'temperature': data.get('main', {}).get('temp'),
            'feels_like': data.get('main', {}).get('feels_like'),
            'humidity': data.get('main', {}).get('humidity'),
            'wind_speed': data.get('wind', {}).get('speed'),
        }
        return jsonify(result)
    except requests.RequestException:
        return jsonify({'error': 'Unable to fetch weather information.'}), 503


@app.route('/translate', methods=['POST'])
def translate():
    payload = request.get_json() or {}
    text = payload.get('q', '').strip()
    source = payload.get('source', 'en')
    target = payload.get('target', 'zh')

    if not text:
        return jsonify({'error': 'No text provided for translation.'}), 400

    try:
        response = requests.post(
            f'{LIBRETRANSLATE_API}/translate',
            json={
                'q': text,
                'source': source,
                'target': target,
                'format': 'text',
            },
            timeout=15,
        )
        response.raise_for_status()
        result = response.json()
        return jsonify({'translatedText': result.get('translatedText')})
    except requests.RequestException:
        return jsonify({'error': 'Translation service is unavailable.'}), 503


class GeminiSession:
    """Gemini Live 即時語音串流 (招牌『即時模式』)。"""

    def __init__(self, sid, instructions, api_key=None):
        self.sid = sid
        self.instructions = instructions
        self.audio_in_queue = queue.Queue()
        self.stop_event = threading.Event()
        self.thread = None
        self.client = genai.Client(api_key=(api_key or API_KEY), http_options={'api_version': 'v1alpha'})

    def start(self):
        self.thread = threading.Thread(target=self.run_loop)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def add_audio(self, audio_data):
        self.audio_in_queue.put(audio_data)

    def run_loop(self):
        asyncio.run(self.async_process())

    async def async_process(self):
        config = {
            "response_modalities": ["AUDIO"],           # 原生語音模型只支援 AUDIO
            "system_instruction": self.instructions,
            "output_audio_transcription": {},            # 同時取得字幕文字
        }
        try:
            async with self.client.aio.live.connect(model=LIVE_MODEL, config=config) as session:
                logger.info(f"Session {self.sid} connected to Gemini Live.")
                sender_task = asyncio.create_task(self.sender(session))
                receiver_task = asyncio.create_task(self.receiver(session))

                while not self.stop_event.is_set():
                    if receiver_task.done():
                        receiver_task = asyncio.create_task(self.receiver(session))
                    if sender_task.done() and not sender_task.cancelled():
                        exc = sender_task.exception() if not sender_task.cancelled() else None
                        if exc:
                            logger.error(f"Sender task died: {exc}")
                            sender_task = asyncio.create_task(self.sender(session))
                    await asyncio.sleep(0.1)

                sender_task.cancel()
                receiver_task.cancel()
        except Exception as e:
            logger.error(f"Gemini connection error: {e}")
            socketio.emit('error', {'msg': str(e)}, to=self.sid)

    async def sender(self, session):
        while True:
            try:
                if not self.audio_in_queue.empty():
                    chunk = self.audio_in_queue.get()
                    from google.genai.types import Blob
                    audio_blob = Blob(data=chunk, mime_type="audio/pcm")
                    await session.send_realtime_input(audio=audio_blob)
                else:
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Sender Error: {e}")
                await asyncio.sleep(0.1)

    async def receiver(self, session):
        try:
            async for response in session.receive():
                if self.stop_event.is_set():
                    break
                server_content = response.server_content
                if server_content is not None:
                    # 字幕（原生語音的逐字轉錄）
                    ot = getattr(server_content, 'output_transcription', None)
                    if ot is not None and getattr(ot, 'text', None):
                        socketio.emit('text_response', {'text': ot.text}, to=self.sid)
                    model_turn = server_content.model_turn
                    if model_turn is not None:
                        for part in model_turn.parts:
                            inline = getattr(part, 'inline_data', None)
                            if inline is not None and inline.data:
                                socketio.emit('audio_response', inline.data, to=self.sid)   # 24kHz PCM 語音
                            elif getattr(part, 'text', None):
                                socketio.emit('text_response', {'text': part.text}, to=self.sid)
                    if server_content.turn_complete:
                        socketio.emit('turn_complete', to=self.sid)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Receiver Error: {e}")
            socketio.emit('error', {'msg': str(e)}, to=self.sid)


# --- SocketIO Events (Gemini Live 即時模式) ---
@socketio.on('connect')
def handle_connect():
    logger.info(f"Client connected: {request.sid}")


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].stop()
        del active_sessions[sid]
    logger.info(f"Client disconnected: {sid}")


@socketio.on('start_session')
def handle_start(data):
    sid = request.sid
    langA = data.get('langA', 'Chinese')
    langB = data.get('langB', 'English')
    user_key = (data.get('gemini_key') or '').strip() or None   # 選填覆蓋，留空用伺服器內建
    instruction = (
        f"You are a real-time voice translator. Your ONLY job is to translate speech.\n"
        f"- When you hear {langA}, translate it to {langB} and reply in {langB}.\n"
        f"- When you hear {langB}, translate it to {langA} and reply in {langA}.\n"
        f"Rules: Output ONLY the translation. No greeting or explanation. Speak naturally."
    )
    logger.info(f"Starting Live session: {langA} <-> {langB}")
    if sid in active_sessions:
        active_sessions[sid].stop()
    session = GeminiSession(sid, instruction, api_key=user_key)
    active_sessions[sid] = session
    session.start()
    emit('status', {'msg': 'Session Started'})


@socketio.on('stop_session')
def handle_stop():
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].stop()
        del active_sessions[sid]


@socketio.on('audio_in')
def handle_audio(data):
    sid = request.sid
    if sid in active_sessions:
        active_sessions[sid].add_audio(data)


if __name__ == '__main__':
    debug_mode = os.getenv('FLASK_DEBUG', 'True').lower() in ('1', 'true', 'yes')
    socketio.run(
        app,
        host='0.0.0.0',
        port=int(os.getenv('PORT', 5000)),
        debug=debug_mode,
    )
