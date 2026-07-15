from flask import Flask, jsonify, request, render_template
from dotenv import load_dotenv
import os
import requests
import providers
import mimetypes
from google import genai

# 強制映射 MIME 類型，修復 Windows 註冊表關聯造成的 CSS/JS 無法加載問題
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')

load_dotenv()
app = Flask(__name__, 
            template_folder='templates',
            static_folder='static',
            static_url_path='/static')
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


if __name__ == '__main__':
    debug_mode = os.getenv('FLASK_DEBUG', 'True').lower() in ('1', 'true', 'yes')
    app.run(
        host='0.0.0.0',
        port=int(os.getenv('PORT', 5000)),
        debug=debug_mode,
    )
