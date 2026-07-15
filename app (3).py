@app.route('/api/translate', methods=['POST'])
def api_translate():
    """通用翻譯端點：支援 OpenAI 相容 / Gemini。前端傳供應商設定，後端代理。"""
    data = request.get_json(force=True, silent=True) or {}
    result = providers.translate(data)
    status = 200 if result.get("ok") else 400
    return jsonify(result), status
