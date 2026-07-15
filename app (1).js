// ---------- STT (Web Speech API) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function sttSupported() { return !!SR; }

// 手機（Android/Chrome）的國語辨識常回傳簡體字，即使 lang 設 zh-TW 也一樣。
// 這裡用 OpenCC 把辨識結果轉回繁體；OpenCC 未載入時原字輸出，不影響其他語言。
let _s2t = null, _s2tReady = false;
function toTraditional(text) {
    if (!text) return text;
    try {
        if (!_s2tReady) { _s2tReady = true; if (window.OpenCC) _s2t = window.OpenCC.Converter({ from: 'cn', to: 'tw' }); }
        return _s2t ? _s2t(text) : text;
    } catch (e) { return text; }
}
// 只有辨識語言為繁體中文時才需要轉換
function convForBcp(bcp, text) {
    return (bcp === 'zh-TW' || bcp === 'zh-HK') ? toTraditional(text) : text;
}


class Recognizer {
    constructor({ bcp, onInterim, onDone, onState }) {
        this.bcp = bcp; this.onInterim = onInterim; this.onDone = onDone; this.onState = onState;
        this.active = false; this.rec = null; this.buffer = '';
    }
    start() {
        if (!SR) { toast('此瀏覽器不支援語音辨識，請改用文字輸入'); return; }
        if (this.active) { this.stop(); return; }   // 再點一下 = 停止並翻譯
        this.buffer = '';                            // 開始新的一段，清空累積
        const rec = new SR();
        rec.lang = this.bcp;
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                // 已確定的句段累積起來，但先不翻譯；只有停止時才整段送出
                // 繁中辨識先轉回繁體，避免手機回傳簡體字
                if (r.isFinal) this.buffer += convForBcp(this.bcp, r[0].transcript);
                else interim += convForBcp(this.bcp, r[0].transcript);
            }
            // 即時顯示逐字稿（已確定 + 正在辨識），讓使用者看到自己講到哪
            const shown = (this.buffer + interim).trim();
            if (shown) this.onInterim?.(shown);
        };
        rec.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') toast('麥克風權限被拒絕，請允許後重試');
            else toast('語音辨識錯誤：' + e.error);
        };
        rec.onend = () => {
            if (this.active) { try { rec.start(); } catch {} }  // 自動續聽
            else this.onState?.(false);
        };
        this.rec = rec;
        this.active = true;
        try { rec.start(); this.onState?.(true); } catch (e) { toast('無法啟動麥克風'); this.active = false; }
    }
    stop() {
        this.active = false;
        if (this.rec) { try { this.rec.stop(); } catch {} }
        this.onState?.(false);
        const text = this.buffer.trim();   // 講完了，整段一次交出去翻譯
        this.buffer = '';
        if (text) this.onDone?.(text);
    }
}


// 單人麥克風：依引擎切換
function currentEngine() { return document.querySelector('input[name=engine]:checked').value; }

const sRecognizer = new Recognizer({
    bcp: byId(cfg.s_langA).bcp,
    onInterim: (t) => setResult(sResult, t, true),
    onDone: async (t) => {
        // 使用者按停後才會進來：麥克風已停，整段一次翻譯（朗讀也不會被辨識佔用）
        const a = $('s_langA').value, b = $('s_langB').value;
        try {
            setResult(sResult, '翻譯中…', true);
            const out = await translate(t, a, b);
            setResult(sResult, out);
            speak(out, byId(b).bcp);
            pushHistory(t, out);
        } catch (e) { toast(e.message); setResult(sResult, '（翻譯失敗）'); }
    },
    onState: (on) => toggleMic($('s_mic'), on),
});

function toggleMic(btn, on) {
    btn.classList.toggle('listening', on);
    const lbl = btn.querySelector('.mic-label');
    if (lbl) lbl.textContent = on ? '🎙️ 說話中…說完再點一下翻譯' : '點一下開始說話';
}

$('s_mic').addEventListener('click', () => {
    if (currentEngine() === 'live') { toggleLive(); return; }
    sRecognizer.bcp = byId($('s_langA').value).bcp;
    sRecognizer.start();
});
