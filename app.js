// ---------- 供應商設定（拍照/檔案與文字翻譯共用邏輯）----------
// Gemini 一律用伺服器內建金鑰；OpenAI 相容才送使用者金鑰/網址
function providerBody() {
    const isOpenai = cfg.provider === 'openai';
    let model = cfg.model || '';
    if (!isOpenai && model && !model.startsWith('gemini')) model = '';   // 避免模型名跨供應商誤送
    return {
        provider: cfg.provider,
        base_url: isOpenai ? cfg.baseurl : '',
        // OpenAI 用 OpenAI 金鑰；Gemini 用「選填的 Gemini 覆蓋金鑰」（留空後端自動用伺服器內建）
        api_key: isOpenai ? cfg.apikey : (cfg.geminikey || ''),
        model,
    };
}


// ---------- 翻譯 API ----------
async function translate(text, sourceLangId, targetLangId) {
    const src = byId(sourceLangId), tgt = byId(targetLangId);
    // 只在 OpenAI 相容時送使用者金鑰/網址；Gemini 一律用伺服器內建金鑰
    const isOpenai = cfg.provider === 'openai';
    let model = cfg.model || '';
    // 避免把 OpenAI 模型名誤送給 Gemini（反之亦然）
    if (!isOpenai && model && !model.startsWith('gemini')) model = '';
    const body = {
        provider: cfg.provider,
        text,
        source: src.name,
        target: tgt.name,
        base_url: isOpenai ? cfg.baseurl : '',
        api_key: isOpenai ? cfg.apikey : '',
        model: model,
    };
    const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '翻譯失敗');
    return data.translation;
}


// 文字翻譯
$('s_text').addEventListener('input', (e) => { $('s_count').textContent = `${e.target.value.length}/200`; });
$('s_send').addEventListener('click', async () => {
    const text = $('s_text').value.trim();
    if (!text) return;
    const a = $('s_langA').value, b = $('s_langB').value;
    try {
        setResult(sResult, '翻譯中…', true);
        const out = await translate(text, a, b);
        setResult(sResult, out);
        speak(out, byId(b).bcp);
        pushHistory(text, out);
    } catch (e) { toast(e.message); setResult(sResult, '（翻譯失敗）'); }
});

// 對調語言
$('s_swap').addEventListener('click', () => {
    const a = $('s_langA').value; $('s_langA').value = $('s_langB').value; $('s_langB').value = a;
    cfg.s_langA = $('s_langA').value; cfg.s_langB = $('s_langB').value; saveCfg(cfg);
});
$('s_langA').addEventListener('change', () => { cfg.s_langA = $('s_langA').value; saveCfg(cfg); });
$('s_langB').addEventListener('change', () => { cfg.s_langB = $('s_langB').value; saveCfg(cfg); });
