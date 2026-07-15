"""
providers.py — 翻譯供應商模組
使用 Google Gemini API 進行文字翻譯
"""

import os
import google.generativeai as genai
from typing import Dict


def safe_print(msg: str):
    try:
        print(msg.encode('cp950', errors='replace').decode('cp950'))
    except Exception:
        try:
            print(msg.encode('ascii', errors='backslashreplace').decode('ascii'))
        except Exception:
            pass


# ============================================
# 1. 初始化 Google Gemini API
# ============================================
def init_gemini():
    """
    初始化 Google Gemini API
    從環境變數取得 API Key（優先順序：GEMINI_API_KEY > GOOGLE_API_KEY）
    """
    # 嘗試多個環境變數名稱
    api_key = os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY')
    
    if not api_key:
        raise ValueError(
            '❌ 未找到 API Key！\n'
            '請設置環境變數：GEMINI_API_KEY 或 GOOGLE_API_KEY\n'
            '如何設置？\n'
            '  Windows: set GEMINI_API_KEY=your_key_here\n'
            '  Mac/Linux: export GEMINI_API_KEY=your_key_here\n'
            '或在 .env 檔案中添加：GEMINI_API_KEY=your_key_here'
        )
    
    genai.configure(api_key=api_key)


# ============================================
# 2. 翻譯函式（核心邏輯）
# ============================================
def translate(data: Dict) -> Dict:
    """
    使用 Google Gemini 翻譯文字
    
    參數：
        data (dict): 包含以下內容
            - text (str): 要翻譯的文字
            - source (str): 源語言代碼 (如 'zh-TW', 'en')
            - target (str): 目標語言代碼 (如 'en', 'ja')
    
    回傳：
        dict: 
            成功: {'ok': True, 'translation': '翻譯結果'}
            失敗: {'ok': False, 'error': '錯誤訊息'}
    """
    
    # -------- 第1步：驗證輸入 --------
    try:
        # 提取數據
        text = data.get('text', '').strip()
        source = data.get('source', '').strip()
        target = data.get('target', '').strip()
        
        # 檢查必填欄位
        if not text:
            return {'ok': False, 'error': '文字不能為空'}
        if not target:
            return {'ok': False, 'error': '目標語言代碼不能為空'}
        
        safe_print(f'[INFO] 翻譯請求：{source or "自動檢測"} -> {target}')
        safe_print(f'   文字：{text[:50]}{"..." if len(text) > 50 else ""}')
    
    except Exception as e:
        return {'ok': False, 'error': f'參數驗證錯誤：{str(e)}'}
    
    # -------- 第2步：構建提示詞 --------
    # 根據源語言決定提示詞
    if source and source != 'auto':
        prompt = f"""翻譯以下文字從{_lang_name(source)}到{_lang_name(target)}：

"{text}"

記住：只輸出翻譯後的文字，不要任何解釋或額外文字。"""
    else:
        # 源語言不明確或自動檢測
        prompt = f"""翻譯以下文字到{_lang_name(target)}：

"{text}"

記住：只輸出翻譯後的文字，不要任何解釋或額外文字。"""
    
    # -------- 第3步：呼叫 Gemini API --------
    try:
        # 初始化 API（如果尚未初始化）
        try:
            init_gemini()
        except ValueError:
            # API Key 已設置，直接使用
            pass
        
        # 建立模型實例
        model = genai.GenerativeModel(
            model_name='gemini-3.1-flash-lite',
            system_instruction='你是一個專業翻譯助手。只輸出翻譯結果，不要任何解釋。'
        )
        
        # 發送請求
        response = model.generate_content(prompt)
        
        # 提取翻譯結果
        translation = response.text.strip()
        
        safe_print(f'[SUCCESS] 翻譯成功：{translation}')
        return {
            'ok': True,
            'translation': translation
        }
    
    except ValueError as e:
        # API Key 未設置
        error_msg = str(e)
        safe_print(f'[ERROR] {error_msg}')
        return {'ok': False, 'error': error_msg}
    
    except Exception as e:
        # 其他未預期的錯誤
        error_msg = f'翻譯過程發生錯誤：{str(e)}'
        safe_print(f'[ERROR] {error_msg}')
        return {'ok': False, 'error': error_msg}


# ============================================
# 3. 輔助函式：語言代碼轉為語言名稱
# ============================================
def _lang_name(code: str) -> str:
    """
    將語言代碼轉為可讀的語言名稱
    
    參數：
        code (str): 語言代碼 (如 'zh-TW', 'en')
    
    回傳：
        str: 語言名稱
    """
    lang_map = {
        'zh-TW': '繁體中文',
        'zh-CN': '簡體中文',
        'zh': '中文',
        'en': '英文',
        'ja': '日文',
        'ko': '韓文',
        'vi': '越南文',
        'de': '德文',
        'fr': '法文',
        'es': '西班牙文',
        'th': '泰文',
        'tr': '土耳其文',
    }
    return lang_map.get(code, code)


# ============================================
# 4. 測試程式（執行此檔案時會運行）
# ============================================
if __name__ == '__main__':
    print('[TEST] 測試 providers.py\n')
    
    # 測試案例 1：中文 → 英文
    print('--- 測試 1：中文 → 英文 ---')
    result = translate({
        'text': '你好，我叫小明',
        'source': 'zh-TW',
        'target': 'en'
    })
    print(f'結果：{result}\n')
    
    # 測試案例 2：英文 → 日文
    print('--- 測試 2：英文 → 日文 ---')
    result = translate({
        'text': 'Hello, my name is John',
        'source': 'en',
        'target': 'ja'
    })
    print(f'結果：{result}\n')
    
    # 測試案例 3：越南文 → 中文
    print('--- 測試 3：越南文 → 中文 ---')
    result = translate({
        'text': 'Xin chào, tôi là người Việt',
        'source': 'vi',
        'target': 'zh-TW'
    })
    print(f'結果：{result}')

