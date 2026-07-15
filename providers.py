"""
翻譯供應商抽象層 (Translation Provider Layer)
-------------------------------------------------
統一介面，讓前端可以自由切換：
  - "openai"：任何「OpenAI 相容」的服務 (OpenAI / Groq / DeepSeek / OpenRouter / Together / 本機 ...)
  - "gemini"：Google Gemini

前端只送 { provider, base_url, api_key, model, text, source, target }，
後端在這裡轉發給對應供應商，金鑰不會留在瀏覽器可被第三方讀取的地方 (由 Flask 代理，順便解 CORS)。
"""

import os
import json
import re
import base64
import requests

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"
# 多模態（圖片 / PDF）分析用模型：gemini-3.5-flash 為 GA 版，原生支援影像與 PDF
DEFAULT_VISION_MODEL = "gemini-3.5-flash"


def build_prompt(source: str, target: str):
    """產生翻譯用的 system 指令與使用者輸入包裝。"""
    if source and source.lower() == "auto":
        system = (
            "You are a professional real-time translation engine for a two-way conversation. "
            f"Detect the language of the input. If it is {target}, translate it into the other party's language; "
            f"otherwise translate it into {target}. "
            "Output ONLY the translated text — no explanations, no language labels, no quotation marks."
        )
    else:
        system = (
            f"You are a professional translation engine. Translate the text from {source} into {target}. "
            "Output ONLY the translated text — no explanations, no language labels, no quotation marks. "
            "Preserve the tone and meaning; make it sound natural to a native speaker."
        )
    return system


def translate_gemini(api_key: str, model: str, system: str, text: str) -> str:
    """呼叫 Google Gemini 的 generate_content。"""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    resp = client.models.generate_content(
        model=model or DEFAULT_GEMINI_MODEL,
        contents=text,
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.3,
        ),
    )
    return (resp.text or "").strip()


def translate_openai(base_url: str, api_key: str, model: str, system: str, text: str, timeout: int = 30) -> str:
    """呼叫 OpenAI 相容的 /chat/completions 端點。"""
    if not base_url:
        base_url = "https://api.openai.com/v1"
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url + "/chat/completions"

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    # 注意：部分新模型（如 gpt-5.x）只支援預設 temperature，故不傳 temperature 參數
    payload = {
        "model": model or "gpt-5.5",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
    }
    r = requests.post(url, headers=headers, json=payload, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return data["choices"][0]["message"]["content"].strip()


def translate(data: dict) -> dict:
    """
    主入口。data 需含：
      provider: "openai" | "gemini"
      text:     要翻譯的文字
      source:   來源語言 (英文名，或 "auto")
      target:   目標語言 (英文名)
      base_url / api_key / model：供應商設定 (openai 必填 key；gemini 可用伺服器 .env 的 key 當後備)
      回傳 { ok, translation } 或 { ok:false, error }
    """
    provider = (data.get("provider") or "gemini").lower()
    text = (data.get("text") or "").strip()
    source = data.get("source") or "auto"
    target = data.get("target") or "English"

    if not text:
        return {"ok": False, "error": "empty text"}

    system = build_prompt(source, target)

    try:
        if provider == "openai":
            api_key = data.get("api_key") or ""
            if not api_key:
                return {"ok": False, "error": "OpenAI 相容供應商需要 API Key"}
            out = translate_openai(
                base_url=data.get("base_url", ""),
                api_key=api_key,
                model=data.get("model", ""),
                system=system,
                text=text,
            )
        else:  # gemini
            api_key = data.get("api_key") or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""
            if not api_key:
                return {"ok": False, "error": "找不到 Gemini API Key（.env 或設定皆無）"}
            out = translate_gemini(
                api_key=api_key,
                model=data.get("model", ""),
                system=system,
                text=text,
            )
        return {"ok": True, "translation": out, "provider": provider}
    except requests.HTTPError as e:
        body = ""
        try:
            body = e.response.text[:300]
        except Exception:
            pass
        return {"ok": False, "error": f"HTTP {e.response.status_code if e.response else '?'}: {body}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
